import { useMemo, useState, type ReactNode } from "react";
import {
  Activity,
  ArrowLeft,
  Clock,
  Container,
  Cpu,
  HardDrive,
  Loader2,
  MemoryStick,
  RefreshCw,
  Terminal,
  Waypoints,
} from "lucide-react";
import type { PanelProps } from "@/features/registry";
import { useHosts, useHostProcesses, useHostStats, useHostStatsHistory, useTunnels } from "@/lib/queries";
import { useLive } from "@/stores/live";
import { useWorkspace } from "@/stores/workspace";
import { invoke } from "@/lib/api";
import { cn, formatBytes, formatDuration, formatPercent, timeAgo } from "@/lib/utils";
import type { Container as DockerContainer, HostStatsHistoryPoint, Tunnel } from "@/lib/types";
import { EnvTag, EmptyState } from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "@/components/ui/sonner";

/** ISO → HH:MM */
function hhmm(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** 手写内联 SVG 双折线图（CPU + 内存），不依赖图表库 */
function TrendChart({ points, height = 150 }: { points: HostStatsHistoryPoint[]; height?: number }) {
  const W = 640;
  const H = height;
  const padL = 10;
  const padR = 10;
  const padT = 12;
  const padB = 22;
  const iw = W - padL - padR;
  const ih = H - padT - padB;

  const x = (i: number) => padL + (points.length > 1 ? (i / (points.length - 1)) * iw : iw / 2);
  const y = (v: number) => padT + ih - (Math.max(0, Math.min(100, v)) / 100) * ih;

  const toPath = (get: (p: HostStatsHistoryPoint) => number) =>
    points
      .map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(get(p)).toFixed(1)}`)
      .join(" ");

  const cpuPath = toPath((p) => p.cpu);
  const memPath = toPath((p) => p.memPercent);

  const gridLines = [0, 25, 50, 75, 100];
  const labelStep = Math.max(1, Math.floor(points.length / 5));
  const labelIdx: number[] = [];
  for (let i = 0; i < points.length; i += labelStep) labelIdx.push(i);
  if (labelIdx[labelIdx.length - 1] !== points.length - 1) labelIdx.push(points.length - 1);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full">
      {gridLines.map((g) => (
        <line
          key={g}
          x1={padL}
          x2={W - padR}
          y1={y(g)}
          y2={y(g)}
          stroke="rgba(255,255,255,0.06)"
          strokeWidth={1}
        />
      ))}
      {labelIdx.map((idx) => (
        <text
          key={idx}
          x={x(idx)}
          y={H - 6}
          textAnchor={idx === 0 ? "start" : idx === points.length - 1 ? "end" : "middle"}
          className="mono-caption"
          fontSize={9}
          fill="var(--quaternary)"
        >
          {hhmm(points[idx].t)}
        </text>
      ))}
      <path d={cpuPath} fill="none" stroke="var(--accent)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <path d={memPath} fill="none" stroke="var(--env-staging)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

const tunnelTypeLabel = (t: Tunnel) =>
  t.type === "local" ? "本地转发" : t.type === "remote" ? "远程转发" : "SOCKS5 代理";

/** 来源 → 目标（远程转发方向相反） */
const tunnelRoute = (t: Tunnel) => {
  const from = t.type === "remote" ? `${t.remoteHost}:${t.remotePort}` : `${t.listenAddr}:${t.listenPort}`;
  const to = t.type === "remote" ? `${t.listenAddr}:${t.listenPort}` : `${t.remoteHost}:${t.remotePort}`;
  return `${from} → ${to}`;
};

const tunnelStatusMeta: Record<Tunnel["status"], { label: string; dot: string; text: string }> = {
  active: { label: "运行中", dot: "bg-success", text: "text-success" },
  stopped: { label: "已停止", dot: "bg-quaternary", text: "text-muted" },
  error: { label: "异常", dot: "bg-danger", text: "text-danger" },
};

const sessionRows: { time: string; status: "connected" | "closed" | "failed"; duration: string }[] = [
  { time: "2026-08-19 09:42", status: "connected", duration: "38m" },
  { time: "2026-08-18 17:05", status: "closed", duration: "2h 12m" },
  { time: "2026-08-18 11:30", status: "failed", duration: "—" },
];

const sessionMeta = {
  connected: { label: "已连接", dot: "bg-success", text: "text-success" },
  closed: { label: "已断开", dot: "bg-quaternary", text: "text-muted" },
  failed: { label: "连接失败", dot: "bg-danger", text: "text-danger" },
} as const;

/**
 * 主机详情页 — 监控趋势 / 容器 / 隧道 / 系统信息 / 会话历史。
 * 通过 openTab({ kind: "host-detail", hostId }) 打开，hostId 由 TabCanvas 注入。
 */
export default function HostDetail({ onOpenPanel, hostId }: PanelProps & { hostId?: string }) {
  const { data: hosts } = useHosts();
  const { data: stats, isLoading: statsLoading } = useHostStats(hostId ?? null);
  const { data: history, isLoading: historyLoading } = useHostStatsHistory(hostId ?? null);
  const { data: tunnels } = useTunnels();
  const { data: processes, isLoading: processesLoading } = useHostProcesses(hostId ?? null);
  const { hostOnline } = useLive();
  const { openSsh } = useWorkspace();

  // 远程 Docker over SSH：挂载 docker.sock 后列出远端容器
  const [dockerMounted, setDockerMounted] = useState(false);
  const [mounting, setMounting] = useState(false);
  const [remoteContainers, setRemoteContainers] = useState<DockerContainer[] | null>(null);
  const [remoteLoading, setRemoteLoading] = useState(false);

  const loadRemoteDocker = async (mount: boolean) => {
    if (!hostId) return;
    setMounting(true);
    try {
      if (mount) {
        const res = await invoke<{ socketPath: string; connected: boolean }>("remote_docker_mount", {
          hostId,
        });
        setDockerMounted(res.connected);
      } else {
        await invoke("remote_docker_unmount", { hostId });
        setDockerMounted(false);
        setRemoteContainers(null);
      }
      setMounting(false);
      if (mount) void refreshRemoteContainers();
    } catch (e) {
      setMounting(false);
      toast.error(mount ? "挂载远程 Docker 失败" : "卸载远程 Docker 失败", { description: String(e) });
    }
  };

  const refreshRemoteContainers = async () => {
    if (!hostId || !dockerMounted) return;
    setRemoteLoading(true);
    try {
      const list = await invoke<DockerContainer[]>("remote_docker_containers", { hostId });
      setRemoteContainers(list);
    } catch (e) {
      toast.error("获取远端容器列表失败", { description: String(e) });
    } finally {
      setRemoteLoading(false);
    }
  };

  const host = useMemo(() => (hostId ? hosts?.find((h) => h.id === hostId) : undefined), [hosts, hostId]);

  const hostTunnels = useMemo(
    () => (tunnels ?? []).filter((t) => t.hostId === hostId),
    [tunnels, hostId]
  );

  if (!hostId) {
    return (
      <EmptyState
        icon={Terminal}
        title="未选择主机"
        description="请从主机列表中选择一台主机查看详情。"
        action={
          <Button variant="secondary" size="md" onClick={() => onOpenPanel("hosts")}>
            <ArrowLeft /> 返回主机列表
          </Button>
        }
      />
    );
  }

  if (hosts && !host) {
    return (
      <EmptyState
        icon={Terminal}
        title="未找到主机"
        description="该主机可能已被删除。"
        action={
          <Button variant="secondary" size="md" onClick={() => onOpenPanel("hosts")}>
            <ArrowLeft /> 返回主机列表
          </Button>
        }
      />
    );
  }

  const online = host ? (hostOnline[host.id] ?? true) : false; // mock 默认在线
  const last = history && history.length > 0 ? history[history.length - 1] : null;

  const connect = async () => {
    if (!host) return;
    try {
      await openSsh(host.id, { title: host.name, env: host.env });
    } catch (e) {
      const msg = String(e);
      toast.error("SSH 连接失败", {
        description: msg.includes("Keychain") ? msg : `无法建立到 ${host.name} 的会话：${msg}`,
      });
    }
  };

  const sysInfo: { label: string; value: string; icon: ReactNode }[] = stats
    ? [
        { label: "发行版", value: stats.osRelease ?? "—", icon: <Terminal /> },
        { label: "内核", value: stats.kernel ?? "—", icon: <Cpu /> },
        { label: "CPU 负载 (1m)", value: stats.loadAvg1.toFixed(2), icon: <Activity /> },
        {
          label: "内存",
          value: `${formatBytes(stats.memUsedBytes)} / ${formatBytes(stats.memTotalBytes)}`,
          icon: <MemoryStick />,
        },
        {
          label: "磁盘",
          value: `${formatBytes(stats.diskUsedBytes)} / ${formatBytes(stats.diskTotalBytes)}`,
          icon: <HardDrive />,
        },
        { label: "运行时长", value: formatDuration(stats.uptimeSeconds), icon: <Clock /> },
      ]
    : [];

  return (
    <div className="flex h-full flex-col">
      {/* 顶栏 */}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border-subtle px-3">
        <Button variant="ghost" size="icon-sm" title="返回主机列表" onClick={() => onOpenPanel("hosts")}>
          <ArrowLeft />
        </Button>
        <h1 className="text-[14px] font-semibold tracking-tight">{host?.name ?? "主机详情"}</h1>
        {host && <EnvTag env={host.env} />}
        <span
          className={cn(
            "inline-flex items-center gap-1.5 text-[12px]",
            online ? "text-success" : "text-quaternary"
          )}
        >
          <span className={cn("dot", online ? "bg-success" : "bg-quaternary")} />
          {online ? "在线" : "离线"}
        </span>
        {host && (
          <div className="ml-auto">
            <Button variant="primary" size="md" onClick={connect}>
              <Terminal /> 连接
            </Button>
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <Tabs defaultValue="monitor">
          <TabsList>
            <TabsTrigger value="monitor">监控</TabsTrigger>
            <TabsTrigger value="containers">容器</TabsTrigger>
            <TabsTrigger value="tunnels">隧道</TabsTrigger>
            <TabsTrigger value="processes">进程</TabsTrigger>
            <TabsTrigger value="system">系统信息</TabsTrigger>
            <TabsTrigger value="sessions">会话历史</TabsTrigger>
          </TabsList>

          {/* 监控 — CPU / 内存 1h 趋势 */}
          <TabsContent value="monitor" className="mt-3">
            <div className="rounded-lg border border-border-subtle bg-surface p-4">
              {historyLoading ? (
                <Skeleton className="h-44 w-full" />
              ) : !history || history.length < 2 ? (
                <div className="flex h-44 items-center justify-center">
                  <EmptyState icon={Activity} title="暂无监控数据" description="等待采样数据…" />
                </div>
              ) : (
                <>
                  <div className="mb-2 flex items-center gap-4 text-[11px]">
                    <span className="flex items-center gap-1.5 text-secondary">
                      <span className="dot" style={{ background: "var(--accent)", boxShadow: "none" }} />
                      CPU
                    </span>
                    <span className="flex items-center gap-1.5 text-secondary">
                      <span className="dot" style={{ background: "var(--env-staging)", boxShadow: "none" }} />
                      内存
                    </span>
                    <span className="ml-auto text-quaternary">更新于 {timeAgo(stats?.sampledAt)}</span>
                  </div>
                  <div className="relative">
                    <TrendChart points={history} />
                    {last && (
                      <div className="pointer-events-none absolute bottom-7 right-2 flex flex-col items-end gap-0.5 mono-caption text-[11px]">
                        <span style={{ color: "var(--accent)" }}>CPU {formatPercent(last.cpu)}</span>
                        <span style={{ color: "var(--env-staging)" }}>
                          内存 {formatPercent(last.memPercent)}
                        </span>
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          </TabsContent>

          {/* 容器 — P2 远程 Docker over SSH（streamlocal 桥接远端 docker.sock） */}
          <TabsContent value="containers" className="mt-3">
            <div className="mb-2 flex items-center gap-2">
              {dockerMounted ? (
                <>
                  <Badge variant="neutral" className="bg-success-tint text-success">
                    已挂载远端 docker.sock
                  </Badge>
                  <Button variant="ghost" size="sm" onClick={() => void refreshRemoteContainers()} disabled={remoteLoading}>
                    <RefreshCw className={cn(remoteLoading && "animate-spin")} /> 刷新
                  </Button>
                  <Button variant="ghost" size="sm" className="text-quaternary" onClick={() => void loadRemoteDocker(false)} disabled={mounting}>
                    卸载
                  </Button>
                </>
              ) : (
                <Button variant="secondary" size="sm" onClick={() => void loadRemoteDocker(true)} disabled={mounting}>
                  {mounting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  <Container /> 挂载远程 Docker
                </Button>
              )}
              {!dockerMounted && (
                <span className="text-[11px] text-muted">需先建立该主机的 SSH 会话，经隧道桥接 /var/run/docker.sock</span>
              )}
            </div>

            {!dockerMounted ? (
              <div className="rounded-lg border border-border-subtle bg-surface">
                <EmptyState
                  icon={Container}
                  title="未挂载远程 Docker"
                  description="点击「挂载远程 Docker」经 SSH 隧道桥接远端 docker.sock，即可查看该主机的容器列表（P2：远程 Docker over SSH）。"
                />
              </div>
            ) : remoteLoading && !remoteContainers ? (
              <div className="p-2">
                {Array.from({ length: 4 }, (_, i) => (
                  <Skeleton key={i} className="mb-2 h-9 w-full" />
                ))}
              </div>
            ) : !remoteContainers || remoteContainers.length === 0 ? (
              <div className="rounded-lg border border-border-subtle bg-surface">
                <EmptyState icon={Container} title="该主机暂无容器" description="远程 Docker 已挂载，但主机上没有容器。" />
              </div>
            ) : (
              <div className="overflow-hidden rounded-lg border border-border-subtle bg-surface">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[26%]">名称</TableHead>
                      <TableHead className="w-[30%]">镜像</TableHead>
                      <TableHead className="w-[18%]">状态</TableHead>
                      <TableHead>端口</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {remoteContainers.map((c) => (
                      <TableRow key={c.id}>
                        <TableCell>
                          <span className="max-w-[220px] truncate font-medium text-foreground" title={c.name}>
                            {c.name}
                          </span>
                        </TableCell>
                        <TableCell>
                          <span className="mono-caption block max-w-[240px] truncate text-secondary" title={c.image}>
                            {c.image}
                          </span>
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant="neutral"
                            className={c.state === "running" ? "bg-success-tint text-success" : "bg-warning-tint text-warning"}
                          >
                            {c.state}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <span className="mono-caption text-muted">
                            {c.ports?.length
                              ? c.ports.map((p) => `${p.ip ?? "0.0.0.0"}:${p.publicPort ?? "?"}→${p.privatePort}`).join(", ")
                              : "—"}
                          </span>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </TabsContent>

          {/* 隧道 */}
          <TabsContent value="tunnels" className="mt-3">
            {hostTunnels.length === 0 ? (
              <div className="rounded-lg border border-border-subtle bg-surface">
                <EmptyState
                  icon={Waypoints}
                  title="暂无隧道"
                  description="为该主机创建端口转发后，将在此显示。"
                />
              </div>
            ) : (
              <div className="overflow-hidden rounded-lg border border-border-subtle bg-surface">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[24%]">名称</TableHead>
                      <TableHead className="w-[16%]">类型</TableHead>
                      <TableHead className="w-[40%]">来源 → 目标</TableHead>
                      <TableHead className="w-[20%]">状态</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {hostTunnels.map((t) => {
                      const meta = tunnelStatusMeta[t.status];
                      return (
                        <TableRow key={t.id}>
                          <TableCell className="font-medium text-foreground">{t.name}</TableCell>
                          <TableCell>
                            <span className="text-[12px] text-secondary">{tunnelTypeLabel(t)}</span>
                          </TableCell>
                          <TableCell>
                            <span className="mono-caption text-secondary">{tunnelRoute(t)}</span>
                          </TableCell>
                          <TableCell>
                            <span className={cn("inline-flex items-center gap-1.5 text-[12px]", meta.text)}>
                              <span className={cn("dot", meta.dot)} />
                              {meta.label}
                            </span>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </TabsContent>

          {/* 主机进程 — P2: 通过活跃 SSH 会话执行 ps 获取 */}
          <TabsContent value="processes" className="mt-3">
            {processesLoading ? (
              <div className="p-2">
                {Array.from({ length: 5 }, (_, i) => (
                  <Skeleton key={i} className="mb-2 h-9 w-full" />
                ))}
              </div>
            ) : !processes || processes.length === 0 ? (
              <div className="rounded-lg border border-border-subtle bg-surface">
                <EmptyState
                  icon={Activity}
                  title="暂无进程数据"
                  description="需要先建立该主机的 SSH 连接，再查看进程列表。"
                />
              </div>
            ) : (
              <div className="overflow-hidden rounded-lg border border-border-subtle bg-surface">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-16">PID</TableHead>
                      <TableHead className="w-16">PPID</TableHead>
                      <TableHead className="w-24">用户</TableHead>
                      <TableHead className="w-20 text-right">CPU</TableHead>
                      <TableHead className="w-20 text-right">内存</TableHead>
                      <TableHead className="w-24 text-right">RSS</TableHead>
                      <TableHead className="w-24">运行时长</TableHead>
                      <TableHead>命令</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {processes.map((p) => (
                      <TableRow key={`${p.pid}-${p.command}`}>
                        <TableCell className="mono text-secondary">{p.pid}</TableCell>
                        <TableCell className="mono-caption text-quaternary">{p.ppid}</TableCell>
                        <TableCell className="text-secondary">{p.user}</TableCell>
                        <TableCell className="mono text-right text-secondary">{formatPercent(p.cpuPercent)}</TableCell>
                        <TableCell className="mono text-right text-secondary">{formatPercent(p.memPercent)}</TableCell>
                        <TableCell className="mono text-right text-secondary">{formatBytes(p.rssKb * 1024)}</TableCell>
                        <TableCell className="mono-caption text-secondary">{p.etime}</TableCell>
                        <TableCell>
                          <span className="mono-caption block max-w-[36rem] truncate text-secondary" title={p.command}>
                            {p.command}
                          </span>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </TabsContent>

          {/* 系统信息 */}
          <TabsContent value="system" className="mt-3">
            {statsLoading ? (
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
                {Array.from({ length: 6 }, (_, i) => (
                  <Skeleton key={i} className="h-20" />
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
                {sysInfo.map((it) => (
                  <div
                    key={it.label}
                    className="rounded-lg border border-border-subtle bg-surface p-3"
                  >
                    <div className="label-caps mb-1.5 flex items-center gap-1.5 [&_svg]:h-3 [&_svg]:w-3">
                      {it.icon}
                      {it.label}
                    </div>
                    <div className="mono truncate text-[13px] text-foreground" title={it.value}>
                      {it.value}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </TabsContent>

          {/* 会话历史 */}
          <TabsContent value="sessions" className="mt-3">
            <div className="overflow-hidden rounded-lg border border-border-subtle bg-surface">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[40%]">时间</TableHead>
                    <TableHead className="w-[30%]">状态</TableHead>
                    <TableHead className="w-[30%]">时长</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sessionRows.map((s, i) => {
                    const meta = sessionMeta[s.status];
                    return (
                      <TableRow key={i}>
                        <TableCell className="mono-caption text-secondary">{s.time}</TableCell>
                        <TableCell>
                          <span className={cn("inline-flex items-center gap-1.5 text-[12px]", meta.text)}>
                            <span className={cn("dot", meta.dot)} />
                            {meta.label}
                          </span>
                        </TableCell>
                        <TableCell className="mono-caption text-secondary">{s.duration}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
