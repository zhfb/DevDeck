import { useMemo, useState, type ReactNode } from "react";
import { Activity, Cpu, HardDrive, MemoryStick, Server } from "lucide-react";
import type { PanelProps } from "@/features/registry";
import { useHosts, useHostStats, useHostStatsHistory } from "@/lib/queries";
import { useLive } from "@/stores/live";
import { cn, formatBytes, formatPercent, timeAgo } from "@/lib/utils";
import type { Host, HostStatsHistoryPoint } from "@/lib/types";
import { EnvTag, EmptyState } from "@/components/shared";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type Range = "1h" | "24h";

const RANGES: { value: Range; label: string }[] = [
  { value: "1h", label: "最近 1 小时" },
  { value: "24h", label: "最近 24 小时" },
];

/** ISO → HH:MM */
function hhmm(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** 手写内联 SVG 双折线大图（CPU + 内存），不依赖图表库 */
function DualLineChart({
  points,
  height = 260,
}: {
  points: HostStatsHistoryPoint[];
  height?: number;
}) {
  const W = 800;
  const H = height;
  const padL = 12;
  const padR = 12;
  const padT = 14;
  const padB = 26;
  const iw = W - padL - padR;
  const ih = H - padT - padB;

  const x = (i: number) => padL + (points.length > 1 ? (i / (points.length - 1)) * iw : iw / 2);
  const y = (v: number) => padT + ih - (Math.max(0, Math.min(100, v)) / 100) * ih;

  const toPath = (get: (p: HostStatsHistoryPoint) => number) =>
    points
      .map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(get(p)).toFixed(1)}`)
      .join(" ");

  const gridLines = [0, 25, 50, 75, 100];
  const labelStep = Math.max(1, Math.floor(points.length / 6));
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
          y={H - 7}
          textAnchor={idx === 0 ? "start" : idx === points.length - 1 ? "end" : "middle"}
          className="mono-caption"
          fontSize={9}
          fill="var(--quaternary)"
        >
          {hhmm(points[idx].t)}
        </text>
      ))}
      <path d={toPath((p) => p.cpu)} fill="none" stroke="var(--accent)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <path d={toPath((p) => p.memPercent)} fill="none" stroke="var(--env-staging)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/** 指标行：label + 值 + 进度条 */
function MetricRow({
  icon,
  label,
  value,
  bar,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  bar: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[11px]">
        <span className="flex items-center gap-1 text-muted [&_svg]:h-3 [&_svg]:w-3">
          {icon}
          {label}
        </span>
        <span className="mono-caption text-secondary">{value}</span>
      </div>
      {bar}
    </div>
  );
}

/** 单主机监控卡（自己的 hook 实例） */
function HostMonitorCard({ host, selected, onSelect }: { host: Host; selected: boolean; onSelect: () => void }) {
  const { data: stats, isLoading } = useHostStats(host.id);
  const online = useLive((s) => s.hostOnline[host.id]) ?? true; // mock 默认在线

  const memPercent = stats && stats.memTotalBytes > 0 ? (stats.memUsedBytes / stats.memTotalBytes) * 100 : 0;
  const diskPercent = stats && stats.diskTotalBytes > 0 ? (stats.diskUsedBytes / stats.diskTotalBytes) * 100 : 0;

  return (
    <Card
      onClick={onSelect}
      className={cn(
        "cursor-default transition-colors",
        selected ? "border-accent/50 ring-1 ring-accent/30" : "hover:border-border"
      )}
    >
      <CardHeader className="pb-2">
        <div className="flex items-center gap-1.5">
          <span className={cn("dot", online ? "bg-success" : "bg-quaternary")} />
          <CardTitle className="truncate">{host.name}</CardTitle>
          <EnvTag env={host.env} />
        </div>
        <CardDescription className="mono-caption truncate">
          {host.user}@{host.address}:{host.port}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2.5">
        {isLoading ? (
          <div className="space-y-2.5">
            <Skeleton className="h-7" />
            <Skeleton className="h-7" />
            <Skeleton className="h-7" />
          </div>
        ) : stats ? (
          <>
            <MetricRow
              icon={<Cpu />}
              label="CPU"
              value={formatPercent(stats.cpuPercent)}
              bar={<Progress value={stats.cpuPercent} indicatorClassName="bg-accent" />}
            />
            <MetricRow
              icon={<MemoryStick />}
              label="内存"
              value={`${formatBytes(stats.memUsedBytes)} / ${formatBytes(stats.memTotalBytes)}`}
              bar={<Progress value={memPercent} indicatorClassName="bg-warning" />}
            />
            <MetricRow
              icon={<HardDrive />}
              label="磁盘"
              value={`${formatBytes(stats.diskUsedBytes)} / ${formatBytes(stats.diskTotalBytes)}`}
              bar={<Progress value={diskPercent} indicatorClassName="bg-success" />}
            />
            <div className="flex items-center justify-between border-t border-border-subtle pt-2 text-[11px]">
              <span className="flex items-center gap-1 text-muted [&_svg]:h-3 [&_svg]:w-3">
                <Activity /> 负载
              </span>
              <span className="mono-caption text-secondary">{stats.loadAvg1.toFixed(2)}</span>
            </div>
          </>
        ) : (
          <div className="py-6 text-center text-[12px] text-quaternary">暂无监控数据</div>
        )}
        <div className="text-right text-[11px] text-quaternary">
          更新于 {timeAgo(stats?.sampledAt)}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * 监控面板 — 多主机指标对比 + 选中主机 CPU/内存趋势大图。
 * 规格：docs/管理面板规划.md §4.5
 */
export default function MonitorPanel(_props: PanelProps) {
  const { data: hosts } = useHosts();
  const [selectedHostId, setSelectedHostId] = useState<string>("");
  const [range, setRange] = useState<Range>("1h");

  const selected = useMemo(
    () => hosts?.find((h) => h.id === selectedHostId) ?? hosts?.[0],
    [hosts, selectedHostId]
  );
  const effectiveId = selected?.id ?? null;

  const { data: history, isLoading: historyLoading } = useHostStatsHistory(effectiveId);
  const { data: stats } = useHostStats(effectiveId);

  /** 按时间范围采样：1h 取最近 60 个点（分钟级），24h 均匀降采样 */
  const sampled = useMemo(() => {
    if (!history || history.length === 0) return [];
    if (range === "1h") return history.slice(-60);
    const max = 60;
    if (history.length <= max) return history;
    const step = Math.ceil(history.length / max);
    return history.filter((_, i) => i % step === 0 || i === history.length - 1);
  }, [history, range]);

  const last = sampled.length > 0 ? sampled[sampled.length - 1] : null;

  return (
    <div className="flex h-full flex-col">
      {/* 工具栏 */}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border-subtle px-4">
        <div className="w-52">
          <Select value={effectiveId ?? undefined} onValueChange={setSelectedHostId}>
            <SelectTrigger>
              <SelectValue placeholder="选择主机" />
            </SelectTrigger>
            <SelectContent>
              {(hosts ?? []).map((h) => (
                <SelectItem key={h.id} value={h.id}>
                  {h.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="w-40">
          <Select value={range} onValueChange={(v) => setRange(v as Range)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RANGES.map((r) => (
                <SelectItem key={r.value} value={r.value}>
                  {r.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {!hosts?.length ? (
          <EmptyState
            icon={Server}
            title="暂无主机"
            description="添加 SSH 主机后即可查看监控指标。"
          />
        ) : (
          <div className="flex flex-col gap-5">
            {/* 多主机对比卡片 */}
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {(hosts ?? []).map((h) => (
                <HostMonitorCard
                  key={h.id}
                  host={h}
                  selected={h.id === effectiveId}
                  onSelect={() => setSelectedHostId(h.id)}
                />
              ))}
            </div>

            {/* 选中主机趋势大图 */}
            {effectiveId && (
              <section>
                <div className="mb-2 flex items-center gap-2">
                  <span className="text-[13px] font-semibold text-foreground">{selected?.name}</span>
                  {selected && <EnvTag env={selected.env} />}
                  <span className="ml-auto text-[11px] text-quaternary">
                    更新于 {timeAgo(stats?.sampledAt)}
                  </span>
                </div>
                <div className="rounded-lg border border-border-subtle bg-surface p-4">
                  {historyLoading ? (
                    <Skeleton className="h-64 w-full" />
                  ) : sampled.length < 2 ? (
                    <div className="flex h-64 items-center justify-center">
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
                        {last && (
                          <span className="ml-auto mono-caption">
                            <span style={{ color: "var(--accent)" }}>CPU {formatPercent(last.cpu)}</span>
                            <span className="mx-1.5 text-quaternary">·</span>
                            <span style={{ color: "var(--env-staging)" }}>
                              内存 {formatPercent(last.memPercent)}
                            </span>
                          </span>
                        )}
                      </div>
                      <DualLineChart points={sampled} />
                    </>
                  )}
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
