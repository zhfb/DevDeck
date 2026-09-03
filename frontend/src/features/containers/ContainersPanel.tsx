import { useEffect, useMemo, useState } from "react";
import {
  Boxes,
  Info,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCw,
  ScrollText,
  Square,
  Terminal,
  Trash2,
  Waypoints,
  X,
} from "lucide-react";
import type { PanelProps } from "@/features/registry";
import { useContainerAction, useContainerCreate, useContainers, useEngines, useHosts, useVolumes } from "@/lib/queries";
import { invoke } from "@/lib/api";
import {
  cn,
  containerStatusDot,
  formatBytes,
  formatDateTime,
  formatDuration,
  formatPercent,
  truncateId,
} from "@/lib/utils";
import type { Container, ContainerState, PortMapping } from "@/lib/types";
import { useWorkspace } from "@/stores/workspace";
import { EmptyState, EngineBadge } from "@/components/shared";
import { Switch } from "@/components/ui/switch";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

type ActionVerb = "start" | "stop" | "restart" | "pause" | "remove";

const ACTION_LABEL: Record<ActionVerb, string> = {
  start: "启动",
  stop: "停止",
  restart: "重启",
  pause: "暂停",
  remove: "删除",
};

const STATE_LABEL: Record<ContainerState, string> = {
  running: "运行中",
  paused: "已暂停",
  exited: "已退出",
  created: "已创建",
  restarting: "重启中",
  dead: "已死亡",
  removing: "删除中",
};

type BadgeVariant = "running" | "paused" | "stopped" | "danger" | "neutral";

function statusVariant(state: ContainerState): BadgeVariant {
  switch (state) {
    case "running":
      return "running";
    case "paused":
      return "paused";
    case "exited":
    case "created":
      return "stopped";
    case "dead":
      return "danger";
    default:
      return "neutral";
  }
}

/** 卷挂载行：命名卷（下拉选择）或自定义 bind 路径 */
type RunVolumeRow =
  | { kind: "volume"; key: string; name: string; target: string; ro: boolean }
  | { kind: "bind"; key: string; text: string };

let volKeySeq = 0;
const nextVolKey = () => `vol-${Date.now().toString(36)}-${++volKeySeq}`;

function formatPorts(ports: PortMapping[]): string {
  return ports
    .map((p) =>
      p.publicPort != null ? `${p.publicPort}→${p.privatePort}` : `${p.privatePort}/${p.type}`
    )
    .join(", ");
}

function formatUptime(c: Container): string {
  if (c.startedAt && (c.state === "running" || c.state === "paused" || c.state === "restarting")) {
    return formatDuration((Date.now() - new Date(c.startedAt).getTime()) / 1000);
  }
  return formatDateTime(c.created);
}

/** Container management panel — §4.1 of docs/管理面板规划.md */
export default function ContainersPanel(_props: PanelProps) {
  const { data: engines } = useEngines();
  const [engineFilter, setEngineFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "running" | "paused" | "exited">("all");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const { data: containers, isLoading, isFetching, refetch } = useContainers(
    engineFilter === "all" ? undefined : engineFilter
  );
  const containerAction = useContainerAction();
  const containerCreate = useContainerCreate();
  const { openTab, setBottomPanel } = useWorkspace();

  const [confirmDelete, setConfirmDelete] = useState<{
    title: string;
    desc: string;
    onConfirm: () => void;
  } | null>(null);
  const [runOpen, setRunOpen] = useState(false);
  const [runName, setRunName] = useState("");
  const [runImage, setRunImage] = useState("");
  const [runPorts, setRunPorts] = useState("");
  const [runCmd, setRunCmd] = useState("");
  const [runEntrypoint, setRunEntrypoint] = useState("");
  const [runEnv, setRunEnv] = useState<{ key: string; value: string }[]>([]);
  const [runVolumes, setRunVolumes] = useState<RunVolumeRow[]>([]);
  const [runNetwork, setRunNetwork] = useState("");
  const [runRestart, setRunRestart] = useState("no");
  const [runMemoryMb, setRunMemoryMb] = useState("");
  const [runCpus, setRunCpus] = useState("");

  const resetRunForm = () => {
    setRunName("");
    setRunImage("");
    setRunPorts("");
    setRunCmd("");
    setRunEntrypoint("");
    setRunEnv([]);
    setRunVolumes([]);
    setRunNetwork("");
    setRunRestart("no");
    setRunMemoryMb("");
    setRunCpus("");
  };

  // ---- 卷面板「用此卷运行容器」预填：打开运行表单并带上命名卷 ----
  const runPrefill = useWorkspace((s) => s.runPrefill);
  const clearRunPrefill = useWorkspace((s) => s.clearRunPrefill);
  useEffect(() => {
    if (runPrefill) {
      setRunVolumes(
        runPrefill.volumes.map((v) => ({
          kind: "volume",
          key: nextVolKey(),
          name: v.name,
          target: v.target ?? "/data",
          ro: false,
        }))
      );
      setRunOpen(true);
      clearRunPrefill();
    }
  }, [runPrefill, clearRunPrefill]);

  const updateRunVolume = (i: number, row: RunVolumeRow) =>
    setRunVolumes((rows) => rows.map((r, j) => (j === i ? row : r)));
  const removeRunVolume = (i: number) =>
    setRunVolumes((rows) => rows.filter((_, j) => j !== i));

  // 事件驱动端口转发（P2）：容器 start/restart 时自动建隧道，停止时拆除
  const { data: hosts } = useHosts();
  const [autoForwardOn, setAutoForwardOn] = useState(false);
  const [autoForwardBusy, setAutoForwardBusy] = useState(false);
  const activeEngineId = engineFilter !== "all" ? engineFilter : engines?.[0]?.id;
  // 运行表单的命名卷下拉数据源（当前目标引擎的已建卷）
  const { data: engineVolumes } = useVolumes(activeEngineId);

  useEffect(() => {
    if (!activeEngineId) return;
    invoke<{ hostId: string | null } | string | null>("auto_forward_get", { engineId: activeEngineId })
      .then((r) => {
        const hostId = typeof r === "string" ? r : r?.hostId ?? null;
        setAutoForwardOn(!!hostId);
      })
      .catch(() => setAutoForwardOn(false));
  }, [activeEngineId]);

  const toggleAutoForward = async (on: boolean) => {
    if (!activeEngineId) return;
    setAutoForwardBusy(true);
    try {
      const targetHost = on ? (hosts?.[0]?.id ?? null) : null;
      await invoke("auto_forward_set", { engineId: activeEngineId, hostId: targetHost });
      setAutoForwardOn(on);
      toast.success(on ? "已开启事件驱动端口转发" : "已关闭事件驱动端口转发");
    } catch (e) {
      toast.error("切换自动转发失败", { description: String(e) });
    } finally {
      setAutoForwardBusy(false);
    }
  };

  const engineById = useMemo(
    () => new Map((engines ?? []).map((e) => [e.id, e])),
    [engines]
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (containers ?? []).filter((c) => {
      if (statusFilter !== "all" && c.state !== statusFilter) return false;
      if (q && !c.name.toLowerCase().includes(q) && !c.id.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [containers, statusFilter, search]);

  const runAction = (c: Container, action: ActionVerb) => {
    containerAction.mutate(
      { action, id: c.id, engineId: c.engineId },
      {
        onSuccess: () => toast.success(`已${ACTION_LABEL[action]} ${c.name}`),
        onError: (e) => toast.error(`${ACTION_LABEL[action]} ${c.name} 失败`, { description: String(e) }),
      }
    );
  };

  const runBatch = (action: ActionVerb) => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    const verb = ACTION_LABEL[action];
    let ok = 0;
    let err = 0;
    const finish = () => {
      if (ok + err < ids.length) return;
      if (err > 0) toast.error(`批量${verb}完成：${ok} 成功，${err} 失败`);
      else toast.success(`已${verb} ${ok} 个容器`);
      setSelected(new Set());
    };
    ids.forEach((id) => {
      const engineId = containers?.find((x) => x.id === id)?.engineId ?? "";
      containerAction.mutate(
        { action, id, engineId },
        {
          onSuccess: () => {
            ok += 1;
            finish();
          },
          onError: () => {
            err += 1;
            finish();
          },
        }
      );
    });
  };

  const openShell = (c: Container) => {
    openTab({ kind: "ssh", title: `${c.name} Shell`, containerId: c.id, engineId: c.engineId, env: "none" });
  };

  const openLogs = () => {
    setBottomPanel({ open: true, tab: "logs" });
  };

  const openDetail = (c: Container) => {
    openTab({ kind: "container-detail", title: c.name, containerId: c.id, env: "none" });
  };

  const askDelete = (c: Container) => {
    setConfirmDelete({
      title: "删除容器",
      desc: `确定删除容器 ${c.name}？此操作不可撤销。`,
      onConfirm: () => runAction(c, "remove"),
    });
  };

  const askBatchDelete = () => {
    const n = selected.size;
    setConfirmDelete({
      title: "批量删除容器",
      desc: `确定删除选中的 ${n} 个容器？此操作不可撤销。`,
      onConfirm: () => runBatch("remove"),
    });
  };

  const toggleAll = (checked: boolean | "indeterminate") => {
    if (checked === true) setSelected(new Set(filtered.map((c) => c.id)));
    else setSelected(new Set());
  };

  const toggleOne = (id: string, checked: boolean | "indeterminate") => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked === true) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const allChecked: boolean | "indeterminate" =
    filtered.length > 0 && selected.size === filtered.length
      ? true
      : selected.size > 0
        ? "indeterminate"
        : false;

  // P0: 运行新容器表单 — create + start a container on the target engine.
  const submitRun = () => {
    const engineId = engineFilter !== "all" ? engineFilter : engines?.[0]?.id;
    if (!engineId) {
      toast.error("没有可用 Docker 引擎", { description: "请先确认本地引擎（OrbStack/Docker/Colima/Podman）已启动" });
      return;
    }
    if (!runImage.trim()) return;

    // 内存/CPU 输入校验：非数字或负数直接拦截，避免静默变成“无限制”（review Important）
    const memoryMb = runMemoryMb.trim() ? Number(runMemoryMb) : undefined;
    const cpus = runCpus.trim() ? Number(runCpus) : undefined;
    if (memoryMb !== undefined && (!Number.isFinite(memoryMb) || memoryMb < 0)) {
      toast.error("内存上限无效", { description: "请输入 ≥0 的数值（单位 MB）" });
      return;
    }
    if (cpus !== undefined && (!Number.isFinite(cpus) || cpus <= 0)) {
      toast.error("CPU 限制无效", { description: "请输入 >0 的核数，例如 1 或 0.5" });
      return;
    }

    // 卷挂载校验：命名卷必须有名称与合法的容器目标路径；自定义路径需含 ":"
    for (const row of runVolumes) {
      if (row.kind === "volume") {
        if (!row.name) {
          toast.error("卷挂载不完整", { description: "请选择要挂载的命名卷" });
          return;
        }
        if (!row.target.trim().startsWith("/")) {
          toast.error("卷挂载目标路径无效", { description: "容器内路径需以 / 开头，例如 /data" });
          return;
        }
      } else if (row.kind === "bind" && row.text.trim() && !row.text.includes(":")) {
        toast.error("卷挂载格式无效", { description: "自定义挂载需为 宿主机路径:容器路径[:ro]，例如 /tmp/a:/app" });
        return;
      }
    }
    const volumes = runVolumes
      .map((row) => {
        if (row.kind === "volume") {
          return `${row.name}:${row.target.trim()}${row.ro ? ":ro" : ""}`;
        }
        return row.text.trim() || null;
      })
      .filter((v): v is string => !!v);

    containerCreate.mutate(
      {
        engineId,
        name: runName.trim() || `devdeck-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        image: runImage.trim(),
        cmd: runCmd.trim() || undefined,
        entrypoint: runEntrypoint.trim() || undefined,
        env: runEnv
          .map((e) => (e.key.trim() ? `${e.key.trim()}=${e.value.trim()}` : null))
          .filter((e): e is string => e !== null),
        ports: runPorts.trim() || undefined,
        volumes: volumes.length ? volumes : undefined,
        network: runNetwork.trim() || undefined,
        restart: runRestart,
        memoryMb,
        cpus,
      },
      {
        onSuccess: (id) => {
          toast.success(`已启动容器 ${runName.trim() || id}`);
          setRunOpen(false);
          resetRunForm();
        },
        onError: (e) => toast.error("运行容器失败", { description: String(e) }),
      }
    );
  };

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-background">
      {/* Toolbar */}
      <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
        <Select value={engineFilter} onValueChange={setEngineFilter}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder="全部引擎" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部引擎</SelectItem>
            {(engines ?? []).map((e) => (
              <SelectItem key={e.id} value={e.id}>
                {e.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as typeof statusFilter)}>
          <SelectTrigger className="w-32">
            <SelectValue placeholder="全部状态" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部状态</SelectItem>
            <SelectItem value="running">运行中</SelectItem>
            <SelectItem value="paused">已暂停</SelectItem>
            <SelectItem value="exited">已退出</SelectItem>
          </SelectContent>
        </Select>
        <Input
          className="w-56"
          placeholder="搜索容器名称或 ID…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="flex-1" />
        <div
          className="flex items-center gap-1.5 rounded-md border border-border-subtle bg-hover-fill px-2 py-1"
          title="容器 start/restart 时自动为端口映射建立本地隧道，停止时拆除"
        >
          <Waypoints className="h-3.5 w-3.5 text-muted" />
          <span className="text-[11px] text-muted">自动转发</span>
          <Switch
            checked={autoForwardOn}
            onCheckedChange={(v) => void toggleAutoForward(v)}
            disabled={autoForwardBusy || !activeEngineId}
          />
        </div>
        <Button variant="secondary" size="sm" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={cn(isFetching && "animate-spin")} />
          刷新
        </Button>
        <Button variant="primary" size="sm" onClick={() => setRunOpen(true)}>
          <Plus />
          运行容器
        </Button>
      </div>

      {/* Table */}
      <div className="min-h-0 flex-1 overflow-auto">
        {isLoading && !containers ? (
          <div className="p-2">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="flex items-center gap-3 border-b border-border-subtle px-2.5 py-2">
                <Skeleton className="h-3.5 w-3.5" />
                <Skeleton className="h-4 w-36" />
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-4 w-16" />
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-4 w-12" />
                <Skeleton className="h-4 w-20" />
                <Skeleton className="h-4 w-16" />
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          engines?.length ? (
            <EmptyState
              icon={Boxes}
              title="暂无容器"
              description="当前引擎没有运行中的容器"
              action={
                <Button variant="secondary" size="sm" onClick={() => refetch()}>
                  <RefreshCw />
                  刷新
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={Boxes}
              title="未检测到 Docker 引擎"
              description="请先启动 OrbStack / Docker Desktop / Colima 或 Podman，再点击刷新重新探测"
              action={
                <Button variant="secondary" size="sm" onClick={() => refetch()}>
                  <RefreshCw />
                  重新检测
                </Button>
              }
            />
          )
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-8">
                  <Checkbox checked={allChecked} onCheckedChange={toggleAll} aria-label="全选" />
                </TableHead>
                <TableHead>名称 / ID</TableHead>
                <TableHead>引擎来源</TableHead>
                <TableHead>镜像</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>端口</TableHead>
                <TableHead className="text-right">CPU</TableHead>
                <TableHead>内存</TableHead>
                <TableHead>运行时长</TableHead>
                <TableHead className="w-24 text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((c) => {
                const eng = engineById.get(c.engineId);
                const running = c.state === "running";
                return (
                  <ContextMenu key={c.id}>
                    <ContextMenuTrigger asChild>
                      <TableRow className="group" data-state={selected.has(c.id) ? "selected" : undefined}>
                        <TableCell>
                          <Checkbox
                            checked={selected.has(c.id)}
                            onCheckedChange={(v) => toggleOne(c.id, v)}
                            aria-label={`选择 ${c.name}`}
                          />
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <span className={cn("dot shrink-0", containerStatusDot(c.state))} />
                            <div className="min-w-0">
                              <div className="max-w-44 truncate text-[13px] text-foreground" title={c.name}>
                                {c.name}
                              </div>
                              <div className="mono-caption text-quaternary">{truncateId(c.id)}</div>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          {eng ? <EngineBadge kind={eng.kind} hostName={eng.name} /> : <span className="text-quaternary">—</span>}
                        </TableCell>
                        <TableCell>
                          <span className="mono-caption block max-w-44 truncate text-secondary" title={c.image}>
                            {c.image}
                          </span>
                        </TableCell>
                        <TableCell>
                          <StatusBadge
                            label={STATE_LABEL[c.state]}
                            variant={statusVariant(c.state)}
                            dotClass={containerStatusDot(c.state)}
                          />
                        </TableCell>
                        <TableCell>
                          <span className="mono-caption text-secondary">{formatPorts(c.ports)}</span>
                        </TableCell>
                        <TableCell className="text-right">
                          <span className="mono text-secondary">{formatPercent(c.cpuPercent)}</span>
                        </TableCell>
                        <TableCell>
                          <span className="mono-caption text-secondary">
                            {c.memLimit ? `${formatBytes(c.memUsage)} / ${formatBytes(c.memLimit)}` : formatBytes(c.memUsage)}
                          </span>
                        </TableCell>
                        <TableCell>
                          <span className="text-secondary">{formatUptime(c)}</span>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center justify-end gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                            <RowAction title="启动" disabled={running} onClick={() => runAction(c, "start")}>
                              <Play />
                            </RowAction>
                            <RowAction title="停止" disabled={!running} onClick={() => runAction(c, "stop")}>
                              <Square />
                            </RowAction>
                            <RowAction title="重启" disabled={!running} onClick={() => runAction(c, "restart")}>
                              <RotateCw />
                            </RowAction>
                            <RowAction title="暂停" disabled={!running} onClick={() => runAction(c, "pause")}>
                              <Pause />
                            </RowAction>
                            <RowAction title="删除" danger onClick={() => askDelete(c)}>
                              <Trash2 />
                            </RowAction>
                          </div>
                        </TableCell>
                      </TableRow>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuLabel className="mono">{c.name}</ContextMenuLabel>
                      <ContextMenuSeparator />
                      <ContextMenuItem disabled={running} onSelect={() => runAction(c, "start")}>
                        <Play />
                        启动
                      </ContextMenuItem>
                      <ContextMenuItem disabled={!running} onSelect={() => runAction(c, "stop")}>
                        <Square />
                        停止
                      </ContextMenuItem>
                      <ContextMenuItem disabled={!running} onSelect={() => runAction(c, "restart")}>
                        <RotateCw />
                        重启
                      </ContextMenuItem>
                      <ContextMenuItem disabled={!running} onSelect={() => runAction(c, "pause")}>
                        <Pause />
                        暂停
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem onSelect={() => openShell(c)}>
                        <Terminal />
                        进入 Shell
                      </ContextMenuItem>
                      <ContextMenuItem onSelect={openLogs}>
                        <ScrollText />
                        查看日志
                      </ContextMenuItem>
                      <ContextMenuItem onSelect={() => openDetail(c)}>
                        <Info />
                        详情
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem className="text-danger" onSelect={() => askDelete(c)}>
                        <Trash2 />
                        删除
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>

      {/* Batch action bar */}
      {selected.size > 0 && (
        <div className="pointer-events-none absolute inset-x-0 bottom-4 z-10 flex justify-center">
          <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-border bg-elevated py-1.5 pl-3.5 pr-1.5 shadow-[0_8px_24px_rgba(0,0,0,0.45)]">
            <span className="text-[12px] text-secondary">已选 {selected.size} 项</span>
            <Button variant="secondary" size="sm" onClick={() => runBatch("start")}>
              <Play />
              启动
            </Button>
            <Button variant="secondary" size="sm" onClick={() => runBatch("stop")}>
              <Square />
              停止
            </Button>
            <Button variant="danger" size="sm" onClick={askBatchDelete}>
              <Trash2 />
              删除
            </Button>
            <button
              onClick={() => setSelected(new Set())}
              className="ml-1 flex h-6 w-6 items-center justify-center rounded-full text-quaternary transition-colors hover:bg-hover-fill hover:text-secondary"
              title="取消选择"
            >
              <span className="text-[12px] leading-none">✕</span>
            </button>
          </div>
        </div>
      )}

      {/* Delete confirmation */}
      <AlertDialog
        open={confirmDelete !== null}
        onOpenChange={(o) => {
          if (!o) setConfirmDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmDelete?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirmDelete?.desc}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                confirmDelete?.onConfirm();
                setConfirmDelete(null);
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Run container dialog */}
      <Dialog open={runOpen} onOpenChange={(open) => { setRunOpen(open); if (!open) resetRunForm(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>运行容器</DialogTitle>
            <DialogDescription>配置镜像、端口、环境变量与资源限制，创建新容器。</DialogDescription>
          </DialogHeader>
          <div className="grid max-h-[68vh] gap-3 overflow-y-auto pr-1">
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label>容器名称</Label>
                <Input placeholder="例如 my-app" value={runName} onChange={(e) => setRunName(e.target.value)} />
              </div>
              <div className="grid gap-1.5">
                <Label>镜像</Label>
                <Input placeholder="例如 nginx:latest" value={runImage} onChange={(e) => setRunImage(e.target.value)} />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label>启动命令（覆盖 CMD）</Label>
                <Input placeholder="例如 nginx -g 'daemon off;'" value={runCmd} onChange={(e) => setRunCmd(e.target.value)} />
              </div>
              <div className="grid gap-1.5">
                <Label>Entrypoint（覆盖）</Label>
                <Input placeholder="例如 /start.sh --prod" value={runEntrypoint} onChange={(e) => setRunEntrypoint(e.target.value)} />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label>网络</Label>
                <Input placeholder="默认 bridge" value={runNetwork} onChange={(e) => setRunNetwork(e.target.value)} />
              </div>
              <div className="grid gap-1.5">
                <Label>重启策略</Label>
                <Select value={runRestart} onValueChange={setRunRestart}>
                  <SelectTrigger>
                    <SelectValue placeholder="重启策略" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="no">不自动重启</SelectItem>
                    <SelectItem value="always">总是重启</SelectItem>
                    <SelectItem value="on-failure">失败时重启</SelectItem>
                    <SelectItem value="unless-stopped">除非手动停止</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid gap-1.5">
              <Label>端口映射</Label>
              <Input
                placeholder="例如 8080:80, 5432:5432（宿主机:容器，逗号分隔）"
                value={runPorts}
                onChange={(e) => setRunPorts(e.target.value)}
              />
            </div>

            <div className="grid gap-1.5">
              <Label>环境变量</Label>
              <div className="grid gap-1.5">
                {runEnv.map((row, i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <Input
                      placeholder="KEY"
                      className="w-40"
                      value={row.key}
                      onChange={(e) => setRunEnv(runEnv.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)))}
                    />
                    <Input
                      placeholder="VALUE"
                      value={row.value}
                      onChange={(e) => setRunEnv(runEnv.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))}
                    />
                    <Button variant="ghost" size="icon-sm" onClick={() => setRunEnv(runEnv.filter((_, j) => j !== i))}>
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
                <Button variant="outline" size="sm" className="justify-start" onClick={() => setRunEnv([...runEnv, { key: "", value: "" }])}>
                  <Plus className="h-3.5 w-3.5" /> 添加环境变量
                </Button>
              </div>
            </div>

            <div className="grid gap-1.5">
              <Label>卷挂载</Label>
              <div className="grid gap-1.5">
                {runVolumes.map((row, i) => (
                  <div key={row.key} className="flex items-center gap-1.5">
                    {row.kind === "volume" ? (
                      <>
                        <Select
                          value={row.name}
                          onValueChange={(v) => updateRunVolume(i, { ...row, name: v })}
                        >
                          <SelectTrigger className="w-44">
                            <SelectValue placeholder="选择命名卷" />
                          </SelectTrigger>
                          <SelectContent>
                            {(engineVolumes ?? []).length === 0 ? (
                              <div className="px-2 py-1.5 text-[12px] text-muted">
                                当前引擎没有命名卷，可到「卷」面板新建
                              </div>
                            ) : (
                              (engineVolumes ?? []).map((vol) => (
                                <SelectItem key={vol.name} value={vol.name}>
                                  {vol.name}
                                </SelectItem>
                              ))
                            )}
                          </SelectContent>
                        </Select>
                        <Input
                          placeholder="/data"
                          className="w-28 font-mono text-[12px]"
                          value={row.target}
                          onChange={(e) => updateRunVolume(i, { ...row, target: e.target.value })}
                        />
                        <label className="flex cursor-pointer items-center gap-1 text-[12px] text-secondary">
                          <Switch
                            className="h-4 w-7"
                            checked={row.ro}
                            onCheckedChange={(v) => updateRunVolume(i, { ...row, ro: !!v })}
                          />
                          ro
                        </label>
                      </>
                    ) : (
                      <Input
                        placeholder="宿主机目录:容器目录[:ro]"
                        value={row.text}
                        onChange={(e) => updateRunVolume(i, { ...row, text: e.target.value })}
                      />
                    )}
                    <Button variant="ghost" size="icon-sm" onClick={() => removeRunVolume(i)}>
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
                <div className="flex items-center gap-1.5">
                  <Button
                    variant="outline"
                    size="sm"
                    className="justify-start"
                    onClick={() =>
                      setRunVolumes((rows) => [
                        ...rows,
                        { kind: "volume", key: nextVolKey(), name: "", target: "/data", ro: false },
                      ])
                    }
                  >
                    <Plus className="h-3.5 w-3.5" /> 挂载命名卷
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="justify-start text-secondary"
                    onClick={() =>
                      setRunVolumes((rows) => [
                        ...rows,
                        { kind: "bind", key: nextVolKey(), text: "" },
                      ])
                    }
                  >
                    <Plus className="h-3.5 w-3.5" /> 自定义路径
                  </Button>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label>内存上限（MB）</Label>
                <Input type="number" min={0} placeholder="例如 512" value={runMemoryMb} onChange={(e) => setRunMemoryMb(e.target.value)} />
              </div>
              <div className="grid gap-1.5">
                <Label>CPU 限制（核数）</Label>
                <Input type="number" min={0} step={0.5} placeholder="例如 2" value={runCpus} onChange={(e) => setRunCpus(e.target.value)} />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="secondary" size="md" onClick={() => setRunOpen(false)}>
              取消
            </Button>
            <Button variant="primary" size="md" disabled={!runImage.trim()} onClick={submitRun}>
              运行
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function RowAction({
  title,
  danger,
  disabled,
  onClick,
  children,
}: {
  title: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          title={title}
          disabled={disabled}
          onClick={onClick}
          className={cn(danger && "text-muted hover:bg-danger-tint hover:text-danger")}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{title}</TooltipContent>
    </Tooltip>
  );
}
