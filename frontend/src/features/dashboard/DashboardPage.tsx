import { useEffect, useState } from "react";
import { Container, Monitor, Plus, Radio, Server, Waypoints } from "lucide-react";
import type { PanelProps } from "@/features/registry";
import { useContainers, useEngines, useHosts, useTunnels } from "@/lib/queries";
import { isTauri, onEvent } from "@/lib/api";
import type { DockerEventItem, Host } from "@/lib/types";
import { usePalette, useConnect } from "@/stores/live";
import { useWorkspace } from "@/stores/workspace";
import { cn, timeAgo } from "@/lib/utils";
import { EmptyState, EngineBadge, EnvTag } from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/** 事件类型 → 徽标配色 */
function typeVariant(type: string): "accent" | "neutral" {
  return type === "container" ? "accent" : "neutral";
}

/** 事件动作 → 语义色 */
function actionClass(action: string): string {
  if (action.includes("die") || action.includes("destroy") || action.includes("remove") || action.includes("kill")) {
    return "text-danger";
  }
  if (action.includes("start") || action.includes("create") || action.includes("pull") || action.includes("mount")) {
    return "text-success";
  }
  return "text-muted";
}

/**
 * Dashboard 总览页 — 统计卡片、最近事件、快速连接与引擎状态。
 * 规格：docs/管理面板规划.md §6
 */
export default function DashboardPage({ onOpenPanel }: PanelProps) {
  const { openTab, setBottomPanel } = useWorkspace();
  const openConnect = useConnect((s) => s.openConnect);
  const registerAction = usePalette((s) => s.registerAction);
  const { data: engines } = useEngines();
  const { data: hosts } = useHosts();
  const { data: containers } = useContainers();
  const { data: tunnels } = useTunnels();
  const [events, setEvents] = useState<DockerEventItem[]>([]);

  // 订阅 Docker 事件流（倒序，最多 20 条）
  useEffect(() => {
    let cancelled = false;
    const un = onEvent<{ events: DockerEventItem[] }>("docker:events", (payload) => {
      if (!cancelled) setEvents((prev) => [...payload.events, ...prev].slice(0, 20));
    });
    return () => {
      cancelled = true;
      un.then((fn) => fn());
    };
  }, []);

  // 命令面板：打开事件流
  useEffect(() => {
    return registerAction({
      id: "dashboard.events",
      title: "打开事件流",
      keywords: "docker events 事件 日志",
      group: "总览",
      run: () => setBottomPanel({ open: true, tab: "events" }),
    });
  }, [registerAction, setBottomPanel]);

  const reachableEngines = (engines ?? []).filter((e) => e.reachable).length;
  const runningContainers = (containers ?? []).filter((c) => c.state === "running").length;
  const activeTunnels = (tunnels ?? []).filter((t) => t.status === "active").length;

  const connectHost = (h: Host) => {
    openConnect({ hostId: h.id, hostName: h.name, address: h.address, user: h.user });
  };

  const stats = [
    { key: "engines", label: "引擎数", value: reachableEngines, icon: Monitor, iconClass: "text-accent" },
    { key: "containers", label: "运行中容器", value: runningContainers, icon: Container, iconClass: "text-success" },
    { key: "hosts", label: "在线主机", value: hosts?.length ?? 0, icon: Server, iconClass: "text-warning" },
    { key: "tunnels", label: "活跃隧道", value: activeTunnels, icon: Waypoints, iconClass: "text-accent" },
  ];

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-[1080px] flex-col gap-4 px-6 py-5">
        {/* 标题区 */}
        <header>
          <div className="flex items-center gap-2.5">
            <h1 className="text-[17px] font-semibold tracking-tight text-foreground">总览</h1>
            <Badge variant="neutral" className="h-5">
              <span className={cn("dot", "bg-accent")} />
              {isTauri ? "已连接后端" : "本地模式"}
            </Badge>
          </div>
          <p className="mt-1 text-[12px] text-muted">引擎、主机、容器与隧道的实时概览</p>
        </header>

        {/* 统计卡片行 */}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {stats.map((s) => (
            <Card key={s.key} className="p-4">
              <div className="flex items-center justify-between">
                <span className="label-caps text-[11px]">{s.label}</span>
                <s.icon className={cn("h-4 w-4", s.iconClass)} />
              </div>
              <div className="mt-2 text-[22px] font-semibold tracking-tight text-foreground">{s.value}</div>
            </Card>
          ))}
        </div>

        {/* 主体两栏：最近事件 + 快速连接 */}
        <div className="grid grid-cols-3 gap-4">
          <Card className="col-span-2">
            <CardHeader className="px-4 py-3">
              <CardTitle className="text-[13px] font-semibold">最近事件</CardTitle>
              <CardDescription>来自 Docker 引擎的事件流（最近 20 条）</CardDescription>
            </CardHeader>
            <CardContent className="px-3 pb-3">
              <div className="max-h-[300px] overflow-y-auto">
                {events.length === 0 ? (
                  <EmptyState icon={Radio} title="暂无事件" description="Docker 活动事件将实时显示在这里" />
                ) : (
                  events.map((e) => (
                    <div
                      key={e.id}
                      className="flex items-center gap-2.5 border-b border-border-subtle px-2 py-1.5 last:border-0"
                    >
                      <span className="mono-caption w-14 shrink-0 text-quaternary">{timeAgo(e.time)}</span>
                      <Badge variant={typeVariant(e.type)} className="w-16 justify-center">
                        {e.type}
                      </Badge>
                      <span className={cn("mono-caption w-16 shrink-0", actionClass(e.action))}>{e.action}</span>
                      <span className="truncate text-secondary">{e.actor}</span>
                      {e.hostName && <span className="mono-caption ml-auto shrink-0 text-quaternary">{e.hostName}</span>}
                    </div>
                  ))
                )}
              </div>
              <div className="mt-2 border-t border-border-subtle pt-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full"
                  onClick={() => setBottomPanel({ open: true, tab: "events" })}
                >
                  <Radio /> 打开事件流面板
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="px-4 py-3">
              <CardTitle className="text-[13px] font-semibold">快速连接</CardTitle>
              <CardDescription>点击主机直接建立 SSH 会话</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-0.5 px-2 pb-2 pt-0">
              {hosts?.length ? (
                hosts.map((h) => (
                  <button
                    key={h.id}
                    onClick={() => connectHost(h)}
                    className="group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-hover-fill"
                  >
                    <span className={cn("dot shrink-0", "bg-success")} title="在线" />
                    <span className="truncate text-[13px] text-secondary group-hover:text-foreground">{h.name}</span>
                    <EnvTag env={h.env} />
                    <span className="mono-caption ml-auto shrink-0 text-quaternary">
                      {h.address}:{h.port}
                    </span>
                  </button>
                ))
              ) : (
                <div className="px-2 py-6 text-center text-[12px] text-quaternary">暂无主机，点击下方 + 添加</div>
              )}
              <div className="mt-1 border-t border-border-subtle pt-1.5">
                <Button variant="ghost" size="sm" className="w-full" onClick={() => onOpenPanel("hosts")}>
                  <Plus /> 添加主机
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* 第二行：引擎状态 */}
        <Card>
          <CardHeader className="px-4 py-3">
            <CardTitle className="text-[13px] font-semibold">引擎状态</CardTitle>
            <CardDescription>Docker 引擎探测结果</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2 px-4 pb-4 sm:grid-cols-2">
            {engines?.length ? (
              engines.map((e) => (
                <div key={e.id} className="flex items-center gap-2.5 rounded-lg border border-border-subtle bg-surface px-3 py-2">
                  <span
                    className={cn("dot shrink-0", e.reachable ? "bg-success" : "bg-danger")}
                    title={e.reachable ? "可达" : "不可达"}
                  />
                  <span className="truncate text-[13px] font-medium text-foreground">{e.name}</span>
                  <EngineBadge kind={e.kind} />
                  {e.version && <span className="mono-caption shrink-0 text-muted">v{e.version}</span>}
                  <span className="mono-caption ml-auto shrink-0 text-quaternary">
                    {e.containers ?? 0} 容器 · {e.images ?? 0} 镜像
                  </span>
                </div>
              ))
            ) : (
              <div className="col-span-full flex flex-col items-center gap-1 py-4 text-center text-[12px] text-quaternary">
                <span>未检测到 Docker 引擎</span>
                <span className="text-[11px]">请先启动 OrbStack / Docker Desktop / Colima 或 Podman，引擎会自动探测</span>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
