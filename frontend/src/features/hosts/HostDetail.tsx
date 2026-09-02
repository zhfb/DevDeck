import { useMemo, type ReactNode } from "react";
import {
  Activity,
  ArrowLeft,
  Clock,
  Container,
  Cpu,
  HardDrive,
  MemoryStick,
  Terminal,
  Waypoints,
} from "lucide-react";
import type { PanelProps } from "@/features/registry";
import { useHosts, useHostProcesses, useHostStats, useHostStatsHistory, useTunnels } from "@/lib/queries";
import { useLive } from "@/stores/live";
import { useWorkspace } from "@/stores/workspace";
import { cn, formatBytes, formatDuration, formatPercent, timeAgo } from "@/lib/utils";
import type { HostStatsHistoryPoint, Tunnel } from "@/lib/types";
import { EnvTag, EmptyState } from "@/components/shared";
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
  const { openTab } = useWorkspace();

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

  const connect = () => {
    if (!host) return;
    openTab({ kind: "ssh", title: host.name, hostId: host.id, env: host.env });
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

          {/* 容器 — V1.0 通过 SSH 隧道桥接远程 docker.sock */}
          <TabsContent value="containers" className="mt-3">
            <div className="rounded-lg border border-border-subtle bg-surface">
              <EmptyState
                icon={Container}
                title="暂无容器数据"
                description="通过 SSH 隧道桥接远程 docker.sock 获取容器列表（V1.0 实现）。"
              />
            </div>
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
