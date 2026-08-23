import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Folder, FolderOpen, FolderTree, HardDriveDownload, HardDriveUpload, RefreshCw, File } from "lucide-react";
import type { PanelProps } from "@/features/registry";
import { invoke, onEvent } from "@/lib/api";
import type { SftpEntry } from "@/lib/types";
import { useWorkspace } from "@/stores/workspace";
import { useTaskStore } from "@/features/tasks/taskStore";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/shared";
import { formatBytes } from "@/lib/utils";

type TransferEvent = {
  taskId: string;
  direction: "upload" | "download";
  percent?: number;
  completedBytes?: number;
  totalBytes?: number;
  state?: "running" | "done" | "error";
  error?: string;
};

function parentPath(path: string) {
  if (path === "/" || path === ".") return path;
  const clean = path.replace(/\\/g, "/").replace(/\/$/, "");
  const parent = clean.slice(0, clean.lastIndexOf("/"));
  return parent || (clean.startsWith("/") ? "/" : ".");
}

function EntryList({
  entries,
  selected,
  onSelect,
  onOpen,
  onDrop,
}: {
  entries: SftpEntry[];
  selected: SftpEntry | null;
  onSelect: (entry: SftpEntry) => void;
  onOpen: (entry: SftpEntry) => void;
  onDrop: (entry: SftpEntry) => void;
}) {
  const handleDragStart = (event: React.DragEvent, entry: SftpEntry) => {
    if (entry.kind !== "file") return;
    event.dataTransfer.setData("application/x-devdeck-sftp-entry", JSON.stringify(entry));
    event.dataTransfer.effectAllowed = "copy";
  };
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      {entries.length === 0 ? (
        <div className="p-8 text-center text-[12px] text-muted">目录为空</div>
      ) : entries.map((entry) => (
        <button
          key={entry.path}
          draggable={entry.kind === "file"}
          onDragStart={(event) => handleDragStart(event, entry)}
          onDragOver={(event) => { if (entry.kind === "directory") event.preventDefault(); }}
          onDrop={(event) => {
            event.preventDefault();
            try {
              const value = JSON.parse(event.dataTransfer.getData("application/x-devdeck-sftp-entry")) as SftpEntry;
              onDrop(value);
            } catch { /* ignore unrelated drops */ }
          }}
          className={`flex w-full items-center gap-2 border-b border-border-subtle px-3 py-1.5 text-left text-[12px] ${selected?.path === entry.path ? "bg-active-fill" : "hover:bg-hover-fill"}`}
          onClick={() => onSelect(entry)}
          onDoubleClick={() => entry.kind === "directory" && onOpen(entry)}
        >
          {entry.kind === "directory" ? <Folder className="h-3.5 w-3.5 text-warning" /> : <File className="h-3.5 w-3.5 text-quaternary" />}
          <span className="min-w-0 flex-1 truncate text-foreground">{entry.name}</span>
          <span className="mono-caption text-quaternary">{entry.kind === "directory" ? "目录" : formatBytes(entry.size)}</span>
        </button>
      ))}
    </div>
  );
}

export default function SftpPanel(_props: PanelProps) {
  const activeTab = useWorkspace((s) => s.tabs.find((t) => t.id === s.activeTabId));
  const sessionId = activeTab?.kind === "ssh" ? activeTab.sessionId : undefined;
  const addTask = useTaskStore((s) => s.addTask);
  const updateTask = useTaskStore((s) => s.updateTask);
  const [localPath, setLocalPath] = useState(".");
  const [remotePath, setRemotePath] = useState("/");
  const [localEntries, setLocalEntries] = useState<SftpEntry[]>([]);
  const [remoteEntries, setRemoteEntries] = useState<SftpEntry[]>([]);
  const [localSelected, setLocalSelected] = useState<SftpEntry | null>(null);
  const [remoteSelected, setRemoteSelected] = useState<SftpEntry | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = async () => {
    setError(null);
    try {
      const local = await invoke<SftpEntry[]>("local_fs_list", { path: localPath });
      setLocalEntries(local);
      if (sessionId) {
        setRemoteEntries(await invoke<SftpEntry[]>("sftp_list", { sessionId, path: remotePath }));
      }
    } catch (e) {
      setError(String(e));
    }
  };

  useEffect(() => { void reload(); }, [localPath, remotePath, sessionId]);

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    void onEvent<TransferEvent>("sftp:progress", (event) => {
      const task = useTaskStore.getState().tasks.find((item) => item.id === event.taskId);
      if (!task) return;
      updateTask(event.taskId, {
        progress: event.percent ?? task.progress,
        status: event.state === "done" ? "done" : event.state === "error" ? "error" : "running",
        detail: event.error ?? `${event.direction === "upload" ? "上传" : "下载"} ${event.completedBytes ?? 0}/${event.totalBytes ?? 0}`,
      });
    }).then((unlisten) => { cleanup = unlisten; });
    return () => cleanup?.();
  }, [updateTask]);

  const startTransfer = async (direction: "upload" | "download") => {
    if (!sessionId) return;
    const source = direction === "upload" ? localSelected : remoteSelected;
    if (!source || source.kind === "directory") return;
    const local = direction === "upload" ? source.path : `${localPath}/${source.name}`;
    const remote = direction === "upload" ? `${remotePath}/${source.name}` : source.path;
    const taskId = await invoke<string>("sftp_transfer", {
      sessionId,
      localPath: local,
      remotePath: remote,
      direction,
      resume: true,
    });
    addTask({ id: taskId, title: `${direction === "upload" ? "上传" : "下载"} ${source.name}`, kind: direction, status: "running", progress: 0, detail: "等待传输…", meta: { command: "sftp_transfer", sessionId, localPath: local, remotePath: remote, direction } });
  };

  const startDroppedTransfer = async (entry: SftpEntry, direction: "upload" | "download") => {
    if (entry.kind !== "file" || !sessionId) return;
    const local = direction === "upload" ? entry.path : `${localPath}/${entry.name}`;
    const remote = direction === "upload" ? `${remotePath}/${entry.name}` : entry.path;
    const taskId = await invoke<string>("sftp_transfer", { sessionId, localPath: local, remotePath: remote, direction, resume: true });
    addTask({ id: taskId, title: `${direction === "upload" ? "上传" : "下载"} ${entry.name}`, kind: direction, status: "running", progress: 0, detail: "等待传输…", meta: { command: "sftp_transfer", sessionId, localPath: local, remotePath: remote, direction } });
  };

  const canTransfer = useMemo(() => Boolean(sessionId), [sessionId]);
  if (!sessionId) return <EmptyState icon={FolderOpen} title="需要先打开 SSH 终端" description="激活一个 SSH Tab 后即可浏览远程文件。" />;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
        <FolderTree className="h-4 w-4 text-secondary" />
        <span className="text-[13px] font-medium">SFTP 双栏</span>
        <span className="text-[11px] text-muted">{activeTab?.title}</span>
        <div className="flex-1" />
        <Button variant="ghost" size="sm" onClick={() => void reload()} title="刷新"><RefreshCw /></Button>
      </div>
      {error && <div className="border-b border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</div>}
      <div className="grid min-h-0 flex-1 grid-cols-2 divide-x divide-border-subtle">
        <section className="flex min-h-0 flex-col">
          <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
            <HardDriveUpload className="h-3.5 w-3.5 text-accent" />
            <span className="text-[12px] font-medium">本地</span>
            <span className="min-w-0 flex-1 truncate mono-caption text-quaternary">{localPath}</span>
            <Button variant="ghost" size="sm" onClick={() => setLocalPath(parentPath(localPath))}><ArrowLeft /></Button>
          </div>
          <EntryList entries={localEntries} selected={localSelected} onSelect={setLocalSelected} onOpen={(e) => setLocalPath(e.path)} onDrop={(e) => void startDroppedTransfer(e, "download")} />
        </section>
        <section className="flex min-h-0 flex-col">
          <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
            <HardDriveDownload className="h-3.5 w-3.5 text-accent" />
            <span className="text-[12px] font-medium">远程</span>
            <span className="min-w-0 flex-1 truncate mono-caption text-quaternary">{remotePath}</span>
            <Button variant="ghost" size="sm" onClick={() => setRemotePath(parentPath(remotePath))}><ArrowLeft /></Button>
          </div>
          <EntryList entries={remoteEntries} selected={remoteSelected} onSelect={setRemoteSelected} onOpen={(e) => setRemotePath(e.path)} onDrop={(e) => void startDroppedTransfer(e, "upload")} />
        </section>
      </div>
      <div className="flex items-center justify-center gap-2 border-t border-border-subtle px-3 py-2">
        <Button variant="secondary" size="sm" disabled={!canTransfer || !localSelected || localSelected.kind === "directory"} onClick={() => void startTransfer("upload")}><HardDriveUpload />上传选中</Button>
        <Button variant="secondary" size="sm" disabled={!canTransfer || !remoteSelected || remoteSelected.kind === "directory"} onClick={() => void startTransfer("download")}><HardDriveDownload />下载选中</Button>
      </div>
    </div>
  );
}
