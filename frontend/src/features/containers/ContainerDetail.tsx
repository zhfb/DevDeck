import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowLeft,
  Boxes,
  Cpu,
  Play,
  RotateCw,
  Square,
  Terminal,
  Trash2,
} from "lucide-react";
import type { PanelProps } from "@/features/registry";
import { invoke, isTauri, onEvent } from "@/lib/api";
import { useContainer, useContainerAction, useEngines } from "@/lib/queries";
import {
  cn,
  containerStatusDot,
  formatBytes,
  formatDateTime,
  formatDuration,
  formatPercent,
} from "@/lib/utils";
import { useWorkspace } from "@/stores/workspace";
import { EmptyState, EngineBadge } from "@/components/shared";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { toast } from "@/components/ui/sonner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import { TerminalView } from "@/app/panels/TerminalView";
import type { Container, ContainerState } from "@/lib/types";

const STATE_LABEL: Record<ContainerState, string> = {
  running: "运行中",
  paused: "已暂停",
  exited: "已退出",
  created: "已创建",
  restarting: "重启中",
  dead: "已死亡",
  removing: "删除中",
};

function stateVariant(state: ContainerState): "running" | "paused" | "stopped" | "danger" | "neutral" {
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

/** Container detail page — §4.1 detail spec of docs/管理面板规划.md */
export default function ContainerDetail({
  onOpenPanel,
  containerId,
}: PanelProps & { containerId?: string }) {
  const { data: container, isLoading } = useContainer(containerId ?? null);
  const { data: engines } = useEngines();
  const containerAction = useContainerAction();
  const { openTab } = useWorkspace();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [liveLogs, setLiveLogs] = useState<string[]>([]);
  const logRef = useRef<HTMLDivElement>(null);

  const engine = useMemo(
    () => (container ? (engines ?? []).find((e) => e.id === container.engineId) : undefined),
    [engines, container]
  );

  const runAction = (action: "start" | "stop" | "restart" | "pause" | "remove") => {
    if (!container) return;
    const label = { start: "启动", stop: "停止", restart: "重启", pause: "暂停", remove: "删除" }[action];
    containerAction.mutate(
      { action, id: container.id, engineId: container.engineId },
      {
        onSuccess: () => toast.success(`已${label} ${container.name}`),
        onError: (e) => toast.error(`${label} ${container.name} 失败`, { description: String(e) }),
      }
    );
  };

  const openShell = () => {
    if (!container) return;
    openTab({
      kind: "docker-exec",
      title: `${container.name} Shell`,
      sessionId: `exec-${container.id}-${Date.now().toString(36)}`,
      containerId: container.id,
      engineId: container.engineId,
      env: "none",
    });
  };

  useEffect(() => {
    if (!container || !isTauri) return;
    let cleanup: (() => void) | undefined;
    void onEvent<{ containerId: string; line: string }>("docker:logs", (event) => {
      if (event.containerId !== container.id) return;
      setLiveLogs((lines) => [...lines, event.line].slice(-500));
    }).then((unlisten) => { cleanup = unlisten; });
    void invoke("containers_logs", { engineId: container.engineId, containerId: container.id }).catch((e) => {
      setLiveLogs([`[DevDeck] 日志连接失败：${String(e)}`]);
    });
    return () => cleanup?.();
  }, [container?.id, container?.engineId]);

  // Simulated streaming log — auto scroll to bottom on mount
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [container?.id]);

  if (isLoading && !container) {
    return (
      <div className="flex h-full flex-col gap-3 bg-background p-4">
        <div className="flex items-center gap-3">
          <Skeleton className="h-7 w-7" />
          <Skeleton className="h-5 w-48" />
        </div>
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!container) {
    return (
      <div className="flex h-full flex-col bg-background">
        <EmptyState
          icon={Boxes}
          title="容器不存在"
          description="该容器可能已被删除或引擎不可达"
          action={
            <Button variant="secondary" size="sm" onClick={() => onOpenPanel("containers")}>
              <ArrowLeft />
              返回容器列表
            </Button>
          }
        />
      </div>
    );
  }

  const running = container.state === "running";
  const memPercent =
    container.memLimit && container.memUsage != null
      ? Math.min(100, (container.memUsage / container.memLimit) * 100)
      : 0;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-border-subtle px-4 py-2.5">
        <Button variant="ghost" size="icon" title="返回" onClick={() => onOpenPanel("containers")}>
          <ArrowLeft />
        </Button>
        <span className={cn("dot shrink-0", containerStatusDot(container.state))} />
        <h1 className="mono text-[15px] font-semibold text-foreground">{container.name}</h1>
        <StatusBadge
          label={STATE_LABEL[container.state]}
          variant={stateVariant(container.state)}
          dotClass={containerStatusDot(container.state)}
        />
        {engine && <EngineBadge kind={engine.kind} hostName={engine.name} />}
        <div className="flex-1" />
        <Button variant="secondary" size="sm" disabled={running} onClick={() => runAction("start")}>
          <Play />
          启动
        </Button>
        <Button variant="secondary" size="sm" disabled={!running} onClick={() => runAction("stop")}>
          <Square />
          停止
        </Button>
        <Button variant="secondary" size="sm" disabled={!running} onClick={() => runAction("restart")}>
          <RotateCw />
          重启
        </Button>
        <Button variant="ghost" size="icon-sm" title="进入 Shell" onClick={openShell}>
          <Terminal />
        </Button>
        <Button variant="danger" size="sm" onClick={() => setConfirmDelete(true)}>
          <Trash2 />
          删除
        </Button>
      </div>

      {/* Tabs */}
      <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
        <Tabs defaultValue="overview">
          <TabsList>
            <TabsTrigger value="overview">概览</TabsTrigger>
            <TabsTrigger value="logs">日志</TabsTrigger>
            <TabsTrigger value="terminal">终端</TabsTrigger>
            <TabsTrigger value="resources">资源</TabsTrigger>
          </TabsList>

          {/* Overview */}
          <TabsContent value="overview">
            <div className="grid grid-cols-2 gap-3">
              <section className="rounded-lg border border-border bg-surface">
                <header className="label-caps border-b border-border-subtle px-3 py-2">基本信息</header>
                <dl className="grid grid-cols-[88px_1fr] gap-x-3 gap-y-2 px-3 py-2.5 text-[13px]">
                  <InfoKey>镜像</InfoKey>
                  <dd className="mono break-all text-secondary">{container.image}</dd>
                  <InfoKey>命令</InfoKey>
                  <dd className="mono break-all text-secondary">{container.command || "—"}</dd>
                  <InfoKey>状态</InfoKey>
                  <dd>
                    <StatusBadge
                      label={STATE_LABEL[container.state]}
                      variant={stateVariant(container.state)}
                      dotClass={containerStatusDot(container.state)}
                    />
                  </dd>
                  <InfoKey>创建时间</InfoKey>
                  <dd className="text-secondary">{formatDateTime(container.created)}</dd>
                  <InfoKey>运行时长</InfoKey>
                  <dd className="text-secondary">
                    {container.startedAt
                      ? formatDuration((Date.now() - new Date(container.startedAt).getTime()) / 1000)
                      : "—"}
                  </dd>
                </dl>
              </section>

              <section className="rounded-lg border border-border bg-surface">
                <header className="label-caps border-b border-border-subtle px-3 py-2">端口</header>
                <ul className="px-3 py-2.5">
                  {container.ports.length === 0 ? (
                    <li className="text-[13px] text-quaternary">无端口映射</li>
                  ) : (
                    container.ports.map((p, i) => (
                      <li
                        key={i}
                        className="mono flex items-center justify-between border-b border-border-subtle py-1 text-[13px] last:border-0"
                      >
                        <span className="text-muted">{p.ip || "*"}</span>
                        <span className="text-secondary">
                          {p.publicPort != null ? `${p.publicPort}:${p.privatePort}` : p.privatePort}
                          <span className="text-quaternary">/{p.type}</span>
                        </span>
                      </li>
                    ))
                  )}
                </ul>
              </section>

              <section className="rounded-lg border border-border bg-surface">
                <header className="label-caps border-b border-border-subtle px-3 py-2">环境变量</header>
                <ul className="max-h-44 overflow-auto px-3 py-2.5">
                  {(container.env ?? []).length === 0 ? (
                    <li className="text-[13px] text-quaternary">无环境变量</li>
                  ) : (
                    (container.env ?? []).map((line, i) => {
                      const idx = line.indexOf("=");
                      const key = idx >= 0 ? line.slice(0, idx) : line;
                      const value = idx >= 0 ? line.slice(idx + 1) : "";
                      return (
                        <li key={i} className="mono flex gap-2 border-b border-border-subtle py-1 text-[12px] last:border-0">
                          <span className="shrink-0 text-accent">{key}</span>
                          <span className="min-w-0 break-all text-muted">{value}</span>
                        </li>
                      );
                    })
                  )}
                </ul>
              </section>

              <section className="rounded-lg border border-border bg-surface">
                <header className="label-caps border-b border-border-subtle px-3 py-2">挂载</header>
                <ul className="px-3 py-2.5">
                  {(container.mounts ?? []).length === 0 ? (
                    <li className="text-[13px] text-quaternary">无挂载卷</li>
                  ) : (
                    (container.mounts ?? []).map((m, i) => (
                      <li key={i} className="flex items-center gap-2 border-b border-border-subtle py-1 text-[12px] last:border-0">
                        <span className="mono-caption text-secondary">{m.source}</span>
                        <span className="text-quaternary">→</span>
                        <span className="mono-caption text-muted">{m.destination}</span>
                      </li>
                    ))
                  )}
                </ul>
              </section>
            </div>
          </TabsContent>

          {/* Logs */}
          <TabsContent value="logs">
            <div
              ref={logRef}
              className="select-text-all h-[420px] overflow-auto rounded-lg border border-border bg-[#0b0d0f] p-3 font-mono text-[12px] leading-relaxed"
            >
              {liveLogs.length > 0
                ? liveLogs.map((line, i) => <div key={i} className="whitespace-pre-wrap text-[#e8eaed]">{line}</div>)
                : mockLogLines(container).map((l, i) => (
                    <div key={i} className={cn("whitespace-pre-wrap", l.stream === "stderr" ? "text-danger" : l.stream === "system" ? "text-muted" : "text-[#e8eaed]")}>
                      <span className="mr-2 text-[#7c838d]">{l.time}</span>
                      {l.text}
                    </div>
                  ))}
            </div>
            <p className="mt-2 text-[12px] text-muted">{liveLogs.length > 0 ? "容器实时 stdout/stderr" : "浏览器预览使用模拟日志流"}</p>
          </TabsContent>

          {/* Terminal */}
          <TabsContent value="terminal">
            <div className="h-[420px] overflow-hidden rounded-lg border border-border">
              <TerminalView title={`${container.name} exec`} />
            </div>
          </TabsContent>

          {/* Resources */}
          <TabsContent value="resources">
            <div className="grid max-w-2xl gap-3">
              <section className="rounded-lg border border-border bg-surface p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-[13px] text-secondary">
                    <Cpu className="h-3.5 w-3.5 text-accent" />
                    CPU 使用率
                  </span>
                  <span className="mono text-[13px] text-foreground">{formatPercent(container.cpuPercent)}</span>
                </div>
                <Progress value={container.cpuPercent ?? 0} />
              </section>
              <section className="rounded-lg border border-border bg-surface p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-[13px] text-secondary">
                    <Activity className="h-3.5 w-3.5 text-success" />
                    内存使用
                  </span>
                  <span className="mono text-[13px] text-foreground">
                    {formatBytes(container.memUsage)}
                    {container.memLimit ? ` / ${formatBytes(container.memLimit)}` : ""}
                  </span>
                </div>
                <Progress value={memPercent} indicatorClassName="bg-success" />
              </section>
              <p className="text-[12px] leading-relaxed text-muted">
                资源数据来自 Docker stats，每 5 秒刷新一次。CPU 为相对主机核数的百分比，内存为 RSS 使用量。
              </p>
            </div>
          </TabsContent>
        </Tabs>
      </div>

      {/* Delete confirmation */}
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除容器</AlertDialogTitle>
            <AlertDialogDescription>
              确定删除容器 <span className="mono">{container.name}</span>？此操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                runAction("remove");
                setConfirmDelete(false);
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function InfoKey({ children }: { children: React.ReactNode }) {
  return <dt className="text-muted">{children}</dt>;
}

function mockLogLines(c: Container): { time: string; stream: "stdout" | "stderr" | "system"; text: string }[] {
  const now = Date.now();
  const pad = (n: number) => String(n).padStart(2, "0");
  const ts = (secAgo: number) => {
    const d = new Date(now - secAgo * 1000);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };
  const lines = [
    { s: "system", t: `[DevDeck] 已连接容器 ${c.name}（${c.image}）的日志流` },
    { s: "stdout", t: `${c.command || "container"} started, pid 1` },
    { s: "stdout", t: "listening on 0.0.0.0:80" },
    { s: "stdout", t: "GET /health 200 2ms" },
    { s: "stdout", t: "GET / 200 8ms" },
    { s: "stderr", t: "warn: slow query took 412ms" },
    { s: "stdout", t: "GET /api/v1/items 200 34ms" },
    { s: "stdout", t: "POST /api/v1/items 201 12ms" },
    { s: "stderr", t: "error: retrying connection to upstream after timeout" },
    { s: "stdout", t: "GET /static/app.js 200 3ms" },
    { s: "stdout", t: "GET /health 200 1ms" },
    { s: "stdout", t: "GET / 200 6ms" },
  ];
  return Array.from({ length: 3 }, (_, round) =>
    lines.map((l, i) => ({
      time: ts(lines.length * round + i + 1),
      stream: l.s as "stdout" | "stderr" | "system",
      text: l.t,
    }))
  ).flat();
}
