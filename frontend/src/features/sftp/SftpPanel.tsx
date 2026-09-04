import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronRight,
  Copy,
  File,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderTree,
  HardDriveDownload,
  HardDriveUpload,
  Pencil,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import type { PanelProps } from "@/features/registry";
import { invoke, onEvent } from "@/lib/api";
import type { SftpEntry } from "@/lib/types";
import { useWorkspace } from "@/stores/workspace";
import { useTaskStore, type NewTask } from "@/features/tasks/taskStore";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { EmptyState } from "@/components/shared";
import { cn, formatBytes } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "@/components/ui/sonner";

type TransferEvent = {
  taskId: string;
  direction: "upload" | "download";
  percent?: number;
  completedBytes?: number;
  totalBytes?: number;
  state?: "running" | "done" | "error";
  error?: string;
};
type BatchTransferEvent = {
  taskId: string;
  state: "done" | "error";
  completed: number;
  total: number;
  failed: number;
};
type Pane = "local" | "remote";
type SortKey = "name" | "size" | "kind" | "modified";
type SortState = { key: SortKey; dir: "asc" | "desc" };

function parentPath(path: string) {
  if (path === "/" || path === ".") return path;
  const clean = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const parent = clean.slice(0, clean.lastIndexOf("/"));
  return parent || (clean.startsWith("/") ? "/" : ".");
}

function joinPath(base: string, name: string) {
  if (base === "/") return `/${name}`;
  return `${base.replace(/\/+$/, "")}/${name}`;
}

function segmentsOf(path: string): { label: string; path: string }[] {
  if (path === "/") return [];
  const clean = path.replace(/\\/g, "/").replace(/^\.\/?/, "").replace(/\/+$/, "");
  if (!clean) return [];
  const parts = clean.split("/");
  let acc = clean.startsWith("/") ? "" : "";
  return parts.map((p, i) => {
    acc = i === 0 ? (clean.startsWith("/") ? `/${p}` : p) : `${acc}/${p}`;
    return { label: p, path: acc };
  });
}

function fileKindLabel(entry: SftpEntry): string {
  if (entry.kind === "directory") return "目录";
  if (entry.kind === "symlink") return "符号链接";
  const dot = entry.name.lastIndexOf(".");
  return dot > 0 && dot < entry.name.length - 1
    ? entry.name.slice(dot + 1).toUpperCase()
    : "文件";
}

function formatTime(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function sortEntries(entries: SftpEntry[], sort: SortState): SftpEntry[] {
  const dirRank = (e: SftpEntry) => (e.kind === "directory" ? 0 : 1);
  const cmp = (a: SftpEntry, b: SftpEntry): number => {
    const rd = dirRank(a) - dirRank(b);
    if (rd !== 0) return rd;
    let r = 0;
    switch (sort.key) {
      case "name":
        r = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
        break;
      case "size":
        r = (a.size ?? 0) - (b.size ?? 0);
        break;
      case "kind":
        r = fileKindLabel(a).localeCompare(fileKindLabel(b));
        break;
      case "modified":
        r = (a.modifiedAt ? new Date(a.modifiedAt).getTime() : 0) - (b.modifiedAt ? new Date(b.modifiedAt).getTime() : 0);
        break;
    }
    return sort.dir === "asc" ? r : -r;
  };
  return [...entries].sort(cmp);
}

/** 单个/目录传输，返回 taskId */
async function startTransfer(
  entry: SftpEntry,
  pane: Pane,
  localPath: string,
  remotePath: string,
  sessionId: string,
  addTask: (t: NewTask) => void
): Promise<void> {
  const direction: "upload" | "download" = pane === "local" ? "upload" : "download";
  const local = direction === "upload" ? entry.path : joinPath(localPath, entry.name);
  const remote = direction === "upload" ? joinPath(remotePath, entry.name) : entry.path;
  const command = entry.kind === "directory" ? "sftp_transfer_batch" : "sftp_transfer";
  const taskId = await invoke<string>(
    command,
    entry.kind === "directory"
      ? { input: { sessionId, localPath: local, remotePath: remote, direction, concurrency: 4 } }
      : { sessionId, localPath: local, remotePath: remote, direction, resume: true }
  );
  addTask({
    id: taskId,
    title: `${direction === "upload" ? "上传" : "下载"} ${entry.name}`,
    kind: direction,
    status: "running",
    progress: 0,
    detail: entry.kind === "directory" ? "正在展开目录…" : "等待传输…",
    meta: { command, sessionId, localPath: local, remotePath: remote, direction },
  });
}

// ---------------------------------------------------------------------------
// 单栏文件表格：列头排序、多选、面包屑、右键菜单入口
// ---------------------------------------------------------------------------
function FilePane({
  pane,
  title,
  accent,
  path,
  entries,
  sort,
  onSort,
  selected,
  onToggleSelect,
  onSelectRange,
  onSelectOnly,
  onSelectAll,
  onOpen,
  onNavigate,
  onRefresh,
  onMenu,
  onDropInto,
}: {
  pane: Pane;
  title: string;
  accent: "local" | "remote";
  path: string;
  entries: SftpEntry[];
  sort: SortState;
  onSort: (key: SortKey) => void;
  selected: Set<string>;
  onToggleSelect: (entry: SftpEntry) => void;
  onSelectRange: (entry: SftpEntry) => void;
  onSelectOnly: (entry: SftpEntry) => void;
  onSelectAll: (checked: boolean) => void;
  onOpen: (entry: SftpEntry) => void;
  onNavigate: (path: string) => void;
  onRefresh: () => void;
  onMenu: (e: React.MouseEvent, entry?: SftpEntry) => void;
  onDropInto: (entry: SftpEntry) => void;
}) {
  const sorted = useMemo(() => sortEntries(entries, sort), [entries, sort]);
  const allSelected = sorted.length > 0 && sorted.every((e) => selected.has(e.path));

  const SortHeader = ({ label, k, className }: { label: string; k: SortKey; className?: string }) => (
    <button
      type="button"
      className={cn(
        "flex h-full w-full items-center gap-1 px-3 text-left text-[11px] font-semibold uppercase tracking-[0.04em] text-muted transition-colors hover:text-secondary",
        className
      )}
      onClick={() => onSort(k)}
    >
      {label}
      <span className={cn("mono-caption leading-none", sort.key === k ? "text-accent" : "text-quaternary")}>
        {sort.key === k ? (sort.dir === "asc" ? "↑" : "↓") : ""}
      </span>
    </button>
  );

  return (
    <section className="flex min-h-0 flex-col">
      {/* 面包屑 + 工具栏 */}
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border-subtle px-2">
        {accent === "local" ? (
          <HardDriveUpload className="ml-1 h-3.5 w-3.5 shrink-0 text-accent" />
        ) : (
          <HardDriveDownload className="ml-1 h-3.5 w-3.5 shrink-0 text-accent" />
        )}
        <span className="mr-1 shrink-0 text-[12px] font-medium">{title}</span>
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden text-[12px]">
          {path === "/" || path === "." ? (
            <span className="mono-caption truncate text-quaternary">{path}</span>
          ) : (
            <>
              <button
                type="button"
                className="shrink-0 rounded px-1 py-0.5 text-secondary hover:bg-hover-fill hover:text-foreground"
                onClick={() => onNavigate(path.startsWith("/") ? "/" : ".")}
                title="返回根目录"
              >
                /
              </button>
              {segmentsOf(path).map((seg, i, arr) => (
                <span key={seg.path} className="flex min-w-0 items-center">
                  <ChevronRight className="h-3 w-3 shrink-0 text-quaternary" />
                  <button
                    type="button"
                    className={cn(
                      "truncate rounded px-1 py-0.5 hover:bg-hover-fill hover:text-foreground",
                      i === arr.length - 1 ? "text-foreground" : "text-secondary"
                    )}
                    onClick={() => onNavigate(seg.path)}
                  >
                    {seg.label}
                  </button>
                </span>
              ))}
            </>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={onRefresh} title="刷新">
          <RefreshCw />
        </Button>
      </div>

      {/* 列头 */}
      <div className="grid h-8 shrink-0 grid-cols-[28px_minmax(0,1fr)_90px_70px_150px] items-center border-b border-border-subtle bg-panel">
        <div className="flex justify-center">
          <Checkbox
            checked={allSelected}
            onCheckedChange={(v) => onSelectAll(v === true)}
            aria-label="全选"
          />
        </div>
        <SortHeader label="名称" k="name" />
        <SortHeader label="大小" k="size" />
        <SortHeader label="类型" k="kind" />
        <SortHeader label="修改时间" k="modified" />
      </div>

      {/* 列表 */}
      <div
        className="min-h-0 flex-1 overflow-auto"
        onContextMenu={(e) => onMenu(e)}
      >
        {sorted.length === 0 ? (
          <div className="p-8 text-center text-[12px] text-muted">目录为空</div>
        ) : (
          sorted.map((entry, idx) => {
            const isSel = selected.has(entry.path);
            return (
              <div
                key={entry.path}
                draggable={entry.kind === "file"}
                onDragStart={(e) => {
                  if (entry.kind !== "file") return;
                  e.dataTransfer.setData("application/x-devdeck-sftp-entry", JSON.stringify(entry));
                  e.dataTransfer.effectAllowed = "copy";
                }}
                onDragOver={(e) => {
                  if (entry.kind === "directory") e.preventDefault();
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  try {
                    const v = JSON.parse(
                      e.dataTransfer.getData("application/x-devdeck-sftp-entry")
                    ) as SftpEntry;
                    onDropInto(v);
                  } catch {
                    /* ignore */
                  }
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onMenu(e, entry);
                }}
                onDoubleClick={() => entry.kind === "directory" && onOpen(entry)}
                onMouseDown={(e) => {
                  if (e.shiftKey) {
                    e.preventDefault();
                    onSelectRange(entry);
                  } else if (e.metaKey || e.ctrlKey) {
                    onToggleSelect(entry);
                  } else {
                    // 普通点击：单选替换（复选框点击由 Checkbox 处理，避免重复清空）
                    if ((e.target as HTMLElement).closest('[data-role="checkbox"]')) return;
                    onSelectOnly(entry);
                  }
                }}
                className={cn(
                  "group grid h-8 cursor-default grid-cols-[28px_minmax(0,1fr)_90px_70px_150px] items-center border-b border-border-subtle text-[12px]",
                  isSel ? "bg-active-fill" : "hover:bg-hover-fill"
                )}
              >
                <div className="flex justify-center" data-role="checkbox">
                  <Checkbox
                    checked={isSel}
                    onCheckedChange={() => onToggleSelect(entry)}
                    aria-label={`选择 ${entry.name}`}
                  />
                </div>
                <div className="flex min-w-0 items-center gap-2 px-3">
                  {entry.kind === "directory" ? (
                    <Folder className="h-3.5 w-3.5 shrink-0 text-warning" />
                  ) : entry.kind === "symlink" ? (
                    <File className="h-3.5 w-3.5 shrink-0 text-accent" />
                  ) : (
                    <File className="h-3.5 w-3.5 shrink-0 text-quaternary" />
                  )}
                  <span className={cn("min-w-0 truncate", isSel ? "text-foreground" : "text-secondary")}>
                    {entry.name}
                  </span>
                </div>
                <div className="px-3 text-right">
                  <span className="mono-caption text-quaternary">
                    {entry.kind === "directory" ? "—" : formatBytes(entry.size)}
                  </span>
                </div>
                <div className="px-3">
                  <span className="text-[11px] text-muted">{fileKindLabel(entry)}</span>
                </div>
                <div className="px-3">
                  <span className="mono-caption text-muted">{formatTime(entry.modifiedAt)}</span>
                </div>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 主面板
// ---------------------------------------------------------------------------
export default function SftpPanel(_props: PanelProps) {
  const tabs = useWorkspace((s) => s.tabs);
  const activeTab = useWorkspace((s) => s.tabs.find((t) => t.id === s.activeTabId));
  const sshSessions = useMemo(() => {
    const out: { sessionId: string; label: string }[] = [];
    for (const t of tabs) {
      if (t.kind !== "ssh") continue;
      if (t.sessionId) out.push({ sessionId: t.sessionId, label: t.title });
      for (const p of t.panes ?? []) {
        if (p.sessionId) out.push({ sessionId: p.sessionId, label: `${t.title} · ${p.title}` });
      }
    }
    return out;
  }, [tabs]);

  const [selectedSessionId, setSelectedSessionId] = useState<string | undefined>(undefined);
  const sessionId =
    selectedSessionId ??
    (activeTab?.kind === "ssh" ? activeTab.sessionId : undefined) ??
    sshSessions[0]?.sessionId;

  const addTask = useTaskStore((s) => s.addTask);
  const updateTask = useTaskStore((s) => s.updateTask);

  const [paths, setPaths] = useState<{ local: string; remote: string }>({ local: ".", remote: "/" });
  const [entries, setEntries] = useState<{ local: SftpEntry[]; remote: SftpEntry[] }>({ local: [], remote: [] });
  const [sort, setSort] = useState<Record<Pane, SortState>>({
    local: { key: "name", dir: "asc" },
    remote: { key: "name", dir: "asc" },
  });
  const [sel, setSel] = useState<{ local: Set<string>; remote: Set<string> }>({
    local: new Set(),
    remote: new Set(),
  });
  const [error, setError] = useState<string | null>(null);

  // 右键菜单 / 重命名 / 新建文件夹 / 删除
  const [menu, setMenu] = useState<{ x: number; y: number; pane: Pane; entry?: SftpEntry } | null>(null);
  const [renameTarget, setRenameTarget] = useState<{ entry: SftpEntry; pane: Pane } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [newFolder, setNewFolder] = useState<Pane | null>(null);
  const [newFolderValue, setNewFolderValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<{ entry: SftpEntry; pane: Pane } | null>(null);

  // 传输进度托盘
  interface Xfer {
    taskId: string;
    name: string;
    direction: "upload" | "download";
    percent: number;
    state: "running" | "done" | "error";
    detail?: string;
  }
  const [transfers, setTransfers] = useState<Record<string, Xfer>>({});

  const reloadPane = useCallback(
    async (pane: Pane) => {
      setError(null);
      try {
        if (pane === "local") {
          const list = await invoke<SftpEntry[]>("local_fs_list", { path: paths.local });
          setEntries((e) => ({ ...e, local: list }));
        } else if (sessionId) {
          const list = await invoke<SftpEntry[]>("sftp_list", { sessionId, path: paths.remote });
          setEntries((e) => ({ ...e, remote: list }));
        }
      } catch (e) {
        setError(String(e));
      }
    },
    [paths, sessionId]
  );

  const reload = useCallback(async () => {
    await reloadPane("local");
    await reloadPane("remote");
  }, [reloadPane]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // 事件订阅：单文件 + 批量进度
  useEffect(() => {
    let un: (() => void) | undefined;
    let unBatch: (() => void) | undefined;
    void onEvent<TransferEvent>("sftp:progress", (event) => {
      // 托盘名称优先用 task store 的标题（「上传/下载 文件名」），避免显示裸 taskId
      const task = useTaskStore.getState().tasks.find((t) => t.id === event.taskId);
      setTransfers((prev) => ({
        ...prev,
        [event.taskId]: {
          taskId: event.taskId,
          name: task?.title ?? event.taskId,
          direction: event.direction,
          percent: event.percent ?? prev[event.taskId]?.percent ?? 0,
          state: event.state === "done" ? "done" : event.state === "error" ? "error" : "running",
          detail: event.error ?? (event.completedBytes != null ? `${formatBytes(event.completedBytes)}` : undefined),
        },
      }));
      if (!task) return;
      updateTask(event.taskId, {
        progress: event.percent ?? task.progress,
        status: event.state === "done" ? "done" : event.state === "error" ? "error" : "running",
        detail: event.error ?? `${event.direction === "upload" ? "上传" : "下载"} ${event.completedBytes ?? 0}/${event.totalBytes ?? 0}`,
      });
    }).then((u) => (un = u));
    void onEvent<BatchTransferEvent>("sftp:batch-progress", (event) => {
      const label = `${event.completed}/${event.total} 个文件`;
      setTransfers((prev) => {
        const p = prev[event.taskId];
        return {
          ...prev,
          [event.taskId]: {
            taskId: event.taskId,
            name: p?.name ?? "批量传输",
            direction: p?.direction ?? "download",
            percent: event.total ? Math.round((event.completed / event.total) * 100) : 100,
            state: event.state,
            detail: event.failed ? `完成 ${event.completed}，失败 ${event.failed}` : label,
          },
        };
      });
      const task = useTaskStore.getState().tasks.find((t) => t.id === event.taskId);
      if (!task) return;
      updateTask(event.taskId, {
        progress: event.total ? Math.round((event.completed / event.total) * 100) : 100,
        status: event.state,
        detail: event.failed ? `${event.completed}/${event.total}，失败 ${event.failed} 个` : `${event.completed}/${event.total} 个文件已完成`,
      });
    }).then((u) => (unBatch = u));
    // 完成后自动移除托盘条目
    const timer = window.setInterval(() => {
      setTransfers((prev) => {
        const done = Object.values(prev).filter((t) => t.state !== "running");
        if (!done.length) return prev;
        const next = { ...prev };
        for (const t of done) {
          const created = t as Xfer & { removedAt?: number };
          if (!created.removedAt) created.removedAt = Date.now();
          else if (Date.now() - created.removedAt > 4000) delete next[t.taskId];
        }
        return next;
      });
    }, 1000);
    return () => {
      un?.();
      unBatch?.();
      window.clearInterval(timer);
    };
  }, [updateTask]);

  // 关闭右键菜单 / 弹窗（点击任意处）
  useEffect(() => {
    if (!menu && !renameTarget && !newFolder) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest("[data-ctx-menu]") || target.closest("[data-dialog-content]")) return;
      setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenu(null);
        setRenameTarget(null);
        setNewFolder(null);
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu, renameTarget, newFolder]);

  // ---- 选择逻辑 ----
  const selRef = useRef(sel);
  selRef.current = sel;
  const anchorRef = useRef<{ pane: Pane; index: number } | null>(null);
  const sortedEntries = useMemo(
    () => ({ local: sortEntries(entries.local, sort.local), remote: sortEntries(entries.remote, sort.remote) }),
    [entries, sort]
  );

  const selectOnly = (pane: Pane, entry: SftpEntry) => {
    setSel((prev) => ({ ...prev, [pane]: new Set([entry.path]) }));
    anchorRef.current = { pane, index: sortedEntries[pane].findIndex((e) => e.path === entry.path) };
  };

  const toggleSelect = (pane: Pane, entry: SftpEntry) => {
    setSel((prev) => {
      const next = new Set(prev[pane]);
      if (next.has(entry.path)) next.delete(entry.path);
      else next.add(entry.path);
      return { ...prev, [pane]: next };
    });
    anchorRef.current = { pane, index: sortedEntries[pane].findIndex((e) => e.path === entry.path) };
  };

  const selectRange = (pane: Pane, entry: SftpEntry) => {
    const list = sortedEntries[pane];
    const idx = list.findIndex((e) => e.path === entry.path);
    setSel((prev) => {
      const next = new Set(prev[pane]);
      const anchor = anchorRef.current?.pane === pane ? anchorRef.current.index : idx;
      const [lo, hi] = idx >= anchor ? [anchor, idx] : [idx, anchor];
      for (let i = lo; i <= hi; i++) next.add(list[i]?.path ?? "");
      next.delete("");
      return { ...prev, [pane]: next };
    });
    anchorRef.current = { pane, index: idx };
  };

  const selectAll = (pane: Pane, checked: boolean) => {
    setSel((prev) => ({
      ...prev,
      [pane]: checked ? new Set(sortedEntries[pane].map((e) => e.path)) : new Set(),
    }));
    anchorRef.current = null;
  };

  const clearSelection = (pane: Pane) =>
    setSel((prev) => ({ ...prev, [pane]: new Set() }));

  const openMenu = (pane: Pane, e: React.MouseEvent, entry?: SftpEntry) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, pane, entry });
  };

  // ---- 传输 ----
  const doTransfer = async (pane: Pane, targets: SftpEntry[]) => {
    if (!sessionId) return;
    for (const entry of targets) {
      await startTransfer(entry, pane, paths.local, paths.remote, sessionId, addTask);
    }
  };

  // 拖拽落盘：拖到本地栏=下载，拖到远程栏=上传（被拖文件来自对侧栏）
  const dropInto = (targetPane: Pane, entry: SftpEntry) => {
    if (!sessionId || entry.kind !== "file") return;
    const direction: "upload" | "download" = targetPane === "local" ? "download" : "upload";
    const local =
      direction === "upload" ? entry.path : joinPath(paths.local, entry.name);
    const remote =
      direction === "upload" ? joinPath(paths.remote, entry.name) : entry.path;
    void invoke<string>("sftp_transfer", {
      sessionId,
      localPath: local,
      remotePath: remote,
      direction,
      resume: true,
    }).then((taskId) => {
      addTask({
        id: taskId,
        title: `${direction === "upload" ? "上传" : "下载"} ${entry.name}`,
        kind: direction,
        status: "running",
        progress: 0,
        detail: "等待传输…",
        meta: { command: "sftp_transfer", sessionId, localPath: local, remotePath: remote, direction },
      });
    });
  };

  const startTransferForMenu = (entry: SftpEntry, pane: Pane) => {
    void doTransfer(pane, [entry]);
    setMenu(null);
  };

  const cancelTransfer = (taskId: string) => {
    void invoke("sftp_transfer_cancel", { taskId });
    setTransfers((prev) => {
      const next = { ...prev };
      delete next[taskId];
      return next;
    });
  };

  // ---- 重命名 / 新建 / 删除 ----
  const openRename = (entry: SftpEntry, pane: Pane) => {
    setRenameValue(entry.name);
    setRenameTarget({ entry, pane });
    setMenu(null);
  };

  const saveRename = async () => {
    if (!renameTarget) return;
    const { entry, pane } = renameTarget;
    const name = renameValue.trim();
    if (!name || name === entry.name) {
      setRenameTarget(null);
      return;
    }
    try {
      if (pane === "remote" && sessionId) {
        const newPath = joinPath(parentPath(entry.path), name);
        await invoke("sftp_rename", { sessionId, oldPath: entry.path, newPath });
        toast.success(`已重命名为「${name}」`);
      } else {
        toast.error("本地文件暂不支持重命名");
      }
    } catch (err) {
      toast.error("重命名失败", { description: String(err) });
    }
    setRenameTarget(null);
    await reloadPane(pane);
  };

  const saveMkdir = async () => {
    if (!newFolder) return;
    const name = newFolderValue.trim();
    if (!name) {
      setNewFolder(null);
      return;
    }
    try {
      if (newFolder === "remote" && sessionId) {
        await invoke("sftp_mkdir", { sessionId, path: joinPath(paths.remote, name) });
        toast.success(`已创建目录「${name}」`);
      } else {
        toast.error("本地新建目录请使用访达");
      }
    } catch (err) {
      toast.error("创建目录失败", { description: String(err) });
    }
    setNewFolder(null);
    setNewFolderValue("");
    await reloadPane(newFolder);
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const { entry, pane } = deleteTarget;
    try {
      if (pane === "remote" && sessionId) {
        await invoke("sftp_remove", {
          sessionId,
          path: entry.path,
          directory: entry.kind === "directory",
        });
        toast.success(`已删除「${entry.name}」`);
      } else {
        toast.error("本地文件暂不支持删除");
      }
    } catch (err) {
      toast.error("删除失败", { description: String(err) });
    }
    setDeleteTarget(null);
    clearSelection(pane);
    await reloadPane(pane);
  };

  const copyPath = (entry: SftpEntry) => {
    void navigator.clipboard?.writeText(entry.path).then(
      () => toast.success(`已复制路径：${entry.path}`),
      () => toast.error("复制失败")
    );
    setMenu(null);
  };

  // 菜单项（本地/远程能力差异）
  const menuItems = useMemo(() => {
    if (!menu) return [];
    const { pane, entry } = menu;
    const items: { label: string; icon: React.ReactNode; danger?: boolean; onClick: () => void }[] = [];
    if (entry) {
      if (entry.kind === "directory") {
        items.push({
          label: "进入目录",
          icon: <FolderOpen className="h-3.5 w-3.5" />,
          onClick: () => {
            setMenu(null);
            if (pane === "local") setPaths((p) => ({ ...p, local: entry.path }));
            else setPaths((p) => ({ ...p, remote: entry.path }));
          },
        });
      }
      items.push({
        label: pane === "local" ? "上传到远程" : "下载到本地",
        icon: pane === "local" ? <HardDriveUpload className="h-3.5 w-3.5" /> : <HardDriveDownload className="h-3.5 w-3.5" />,
        onClick: () => startTransferForMenu(entry, pane),
      });
      if (pane === "remote") {
        items.push({
          label: "重命名",
          icon: <Pencil className="h-3.5 w-3.5" />,
          onClick: () => openRename(entry, pane),
        });
        items.push({
          label: "删除",
          icon: <Trash2 className="h-3.5 w-3.5" />,
          danger: true,
          onClick: () => {
            setMenu(null);
            setDeleteTarget({ entry, pane });
          },
        });
      }
      items.push({ label: "复制路径", icon: <Copy className="h-3.5 w-3.5" />, onClick: () => copyPath(entry) });
    } else {
      if (pane === "remote") {
        items.push({
          label: "新建文件夹",
          icon: <FolderPlus className="h-3.5 w-3.5" />,
          onClick: () => {
            setMenu(null);
            setNewFolder(pane);
          },
        });
      }
      items.push({
        label: "全选",
        icon: <Check className="h-3.5 w-3.5" />,
        onClick: () => {
          setMenu(null);
          selectAll(pane, true);
        },
      });
    }
    items.push({
      label: "刷新",
      icon: <RefreshCw className="h-3.5 w-3.5" />,
      onClick: () => {
        setMenu(null);
        void reloadPane(pane);
      },
    });
    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu, paths, sessionId]);

  const canTransfer = Boolean(sessionId);
  if (!sessionId)
    return <EmptyState icon={FolderOpen} title="需要先打开 SSH 终端" description="激活一个 SSH Tab 后即可浏览远程文件。" />;

  const selLocal = sel.local.size;
  const selRemote = sel.remote.size;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {/* 顶部：会话选择 + 标题 */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border-subtle px-3">
        <FolderTree className="h-4 w-4 text-secondary" />
        <span className="text-[13px] font-medium">SFTP 文件管理</span>
        {sshSessions.length > 0 && (
          <Select
            value={selectedSessionId ?? "auto"}
            onValueChange={(v) => {
              setSelectedSessionId(v === "auto" ? undefined : v);
              setSel({ local: new Set(), remote: new Set() });
            }}
          >
            <SelectTrigger className="h-6 w-auto max-w-[240px] px-2 text-[11px]">
              <SelectValue placeholder="选择 SSH 会话" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">自动（跟随激活 SSH）</SelectItem>
              {sshSessions.map((s) => (
                <SelectItem key={s.sessionId} value={s.sessionId}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <div className="flex-1" />
        <Button variant="ghost" size="sm" onClick={() => void reload()} title="全部刷新">
          <RefreshCw />
        </Button>
      </div>

      {error && (
        <div className="border-b border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</div>
      )}

      {/* 批量操作条 */}
      {(selLocal > 0 || selRemote > 0) && (
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border-subtle bg-active-fill/40 px-3 text-[12px]">
          <span className="text-secondary">
            已选 <span className="font-semibold text-accent">{selLocal + selRemote}</span> 项
          </span>
          <div className="flex-1" />
          <Button
            variant="ghost"
            size="sm"
            disabled={!canTransfer || selLocal === 0}
            onClick={() => void doTransfer("local", sortedEntries.local.filter((e) => sel.local.has(e.path)))}
            title="上传选中的本地文件到远程"
          >
            <HardDriveUpload /> 上传
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!canTransfer || selRemote === 0}
            onClick={() => void doTransfer("remote", sortedEntries.remote.filter((e) => sel.remote.has(e.path)))}
            title="下载选中的远程文件到本地"
          >
            <HardDriveDownload /> 下载
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={selRemote === 0}
            onClick={() => {
              const target = sortedEntries.remote.find((e) => sel.remote.has(e.path));
              if (target) setDeleteTarget({ entry: target, pane: "remote" });
            }}
            className="text-danger hover:text-danger"
          >
            <Trash2 /> 删除
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={selLocal + selRemote === 0}
            onClick={() => {
              const pathsToCopy = [
                ...sortedEntries.local.filter((e) => sel.local.has(e.path)).map((e) => e.path),
                ...sortedEntries.remote.filter((e) => sel.remote.has(e.path)).map((e) => e.path),
              ];
              void navigator.clipboard?.writeText(pathsToCopy.join("\n")).then(
                () => toast.success(`已复制 ${pathsToCopy.length} 个路径`),
                () => toast.error("复制失败")
              );
            }}
          >
            <Copy /> 复制路径
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setSel({ local: new Set(), remote: new Set() })}>
            <X /> 清除
          </Button>
        </div>
      )}

      {/* 双栏 */}
      <div className="grid min-h-0 flex-1 grid-cols-2 divide-x divide-border-subtle">
        <FilePane
          pane="local"
          title="本地"
          accent="local"
          path={paths.local}
          entries={entries.local}
          sort={sort.local}
          onSort={(k) =>
            setSort((s) => ({
              ...s,
              local: { key: k, dir: s.local.key === k && s.local.dir === "asc" ? "desc" : "asc" },
            }))
          }
          selected={sel.local}
          onToggleSelect={(e) => toggleSelect("local", e)}
          onSelectRange={(e) => selectRange("local", e)}
          onSelectOnly={(e) => selectOnly("local", e)}
          onSelectAll={(c) => selectAll("local", c)}
          onOpen={(e) => setPaths((p) => ({ ...p, local: e.path }))}
          onNavigate={(p) => setPaths((pp) => ({ ...pp, local: p }))}
          onRefresh={() => void reloadPane("local")}
          onMenu={(e, entry) => openMenu("local", e, entry)}
          onDropInto={(entry) => dropInto("local", entry)}
        />
        <FilePane
          pane="remote"
          title="远程"
          accent="remote"
          path={paths.remote}
          entries={entries.remote}
          sort={sort.remote}
          onSort={(k) =>
            setSort((s) => ({
              ...s,
              remote: { key: k, dir: s.remote.key === k && s.remote.dir === "asc" ? "desc" : "asc" },
            }))
          }
          selected={sel.remote}
          onToggleSelect={(e) => toggleSelect("remote", e)}
          onSelectRange={(e) => selectRange("remote", e)}
          onSelectOnly={(e) => selectOnly("remote", e)}
          onSelectAll={(c) => selectAll("remote", c)}
          onOpen={(e) => setPaths((p) => ({ ...p, remote: e.path }))}
          onNavigate={(p) => setPaths((pp) => ({ ...pp, remote: p }))}
          onRefresh={() => void reloadPane("remote")}
          onMenu={(e, entry) => openMenu("remote", e, entry)}
          onDropInto={(entry) => dropInto("remote", entry)}
        />
      </div>

      {/* 传输进度托盘 */}
      {Object.keys(transfers).length > 0 && (
        <div className="shrink-0 border-t border-border-subtle bg-panel px-3 py-2">
          <div className="mb-1 flex items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-[0.04em] text-muted">传输队列</span>
            <span className="mono-caption text-quaternary">
              {Object.values(transfers).filter((t) => t.state === "running").length} 进行中
            </span>
          </div>
          <div className="flex max-h-32 flex-col gap-1.5 overflow-auto">
            {Object.values(transfers).map((t) => (
              <div key={t.taskId} className="flex items-center gap-2 text-[12px]">
                {t.direction === "upload" ? (
                  <HardDriveUpload className="h-3.5 w-3.5 shrink-0 text-accent" />
                ) : (
                  <HardDriveDownload className="h-3.5 w-3.5 shrink-0 text-accent" />
                )}
                <span className="w-40 shrink-0 truncate text-secondary">{t.name}</span>
                <Progress value={t.percent} className="h-1.5 flex-1" />
                <span className="mono-caption w-10 shrink-0 text-right text-quaternary">{t.percent}%</span>
                <span className={cn("w-16 shrink-0 text-[11px]", t.state === "error" ? "text-danger" : t.state === "done" ? "text-success" : "text-muted")}>
                  {t.state === "error" ? "失败" : t.state === "done" ? "完成" : t.detail ?? "传输中"}
                </span>
                {t.state === "running" && (
                  <Button variant="ghost" size="icon-sm" onClick={() => cancelTransfer(t.taskId)} title="取消">
                    <X />
                  </Button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 右键菜单 */}
      {menu && (
        <div
          data-ctx-menu
          className="fixed z-[100] min-w-[168px] rounded-lg border border-border bg-elevated p-1 shadow-[0_8px_24px_rgba(0,0,0,0.5)]"
          style={{ left: menu.x, top: menu.y }}
        >
          {menuItems.map((item, i) => (
            <button
              key={i}
              type="button"
              onClick={item.onClick}
              className={cn(
                "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] transition-colors",
                item.danger ? "text-danger hover:bg-danger/10" : "text-secondary hover:bg-hover-fill hover:text-foreground"
              )}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      )}

      {/* 重命名 */}
      <Dialog
        open={!!renameTarget}
        onOpenChange={(o) => !o && setRenameTarget(null)}
      >
        <DialogContent className="max-w-sm" data-dialog-content>
          <DialogHeader>
            <DialogTitle>重命名</DialogTitle>
            <DialogDescription>
              {renameTarget?.entry.kind === "directory" ? "目录" : "文件"}：{renameTarget?.entry.name}
            </DialogDescription>
          </DialogHeader>
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void saveRename()}
            autoFocus
            onFocus={(e) => e.target.select()}
          />
          <DialogFooter>
            <Button variant="secondary" size="md" onClick={() => setRenameTarget(null)}>
              取消
            </Button>
            <Button variant="primary" size="md" onClick={() => void saveRename()} disabled={!renameValue.trim()}>
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 新建文件夹 */}
      <Dialog open={!!newFolder} onOpenChange={(o) => !o && setNewFolder(null)}>
        <DialogContent className="max-w-sm" data-dialog-content>
          <DialogHeader>
            <DialogTitle>新建文件夹</DialogTitle>
            <DialogDescription>
              在远程 {paths.remote} 下创建
            </DialogDescription>
          </DialogHeader>
          <Input
            value={newFolderValue}
            onChange={(e) => setNewFolderValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void saveMkdir()}
            placeholder="folder-name"
            autoFocus
          />
          <DialogFooter>
            <Button variant="secondary" size="md" onClick={() => setNewFolder(null)}>
              取消
            </Button>
            <Button variant="primary" size="md" onClick={() => void saveMkdir()} disabled={!newFolderValue.trim()}>
              创建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认 */}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除确认</AlertDialogTitle>
            <AlertDialogDescription>
              确定要删除「{deleteTarget?.entry.name}」吗？
              {deleteTarget?.entry.kind === "directory" ? " 目录会连同其内容一并删除，此操作不可撤销。" : " 此操作不可撤销。"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmDelete()}>删除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
