import { useState } from "react";
import {
  ChevronRight,
  ChevronDown,
  Monitor,
  Container,
  Layers,
  Database,
  Network,
  Waypoints,
  Terminal,
  Plus,
  RefreshCw,
  Boxes,
  FolderKanban,
  CircleOff,
} from "lucide-react";
import { useEngines, useHosts, useHostGroups, useTunnels, useContainers } from "@/lib/queries";
import { useWorkspace } from "@/stores/workspace";
import { useLive } from "@/stores/live";
import { cn } from "@/lib/utils";
import { EngineBadge, EnvTag } from "@/components/shared";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuLabel, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import type { NavPanelId } from "./NavRail";

function Section({ label, right, children }: { label: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-col">
      <div className="flex h-6 items-center justify-between px-2">
        <span className="label-caps">{label}</span>
        {right}
      </div>
      {children}
    </div>
  );
}

function TreeNode({
  depth = 0,
  selected,
  onSelect,
  onDoubleClick,
  contextMenu,
  children,
  className,
}: {
  depth?: number;
  selected?: boolean;
  onSelect?: () => void;
  onDoubleClick?: () => void;
  contextMenu?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      onClick={onSelect}
      onDoubleClick={onDoubleClick}
      className={cn(
        "group flex h-6.5 cursor-default items-center gap-1.5 rounded-md px-2 text-[13px] transition-colors",
        selected ? "bg-active-fill text-foreground" : "text-secondary hover:bg-hover-fill hover:text-foreground",
        className
      )}
      style={{ paddingLeft: depth * 12 + 8 }}
    >
      {children}
    </div>
  );
}

/**
 * Resource tree sidebar — local engine, host groups with env color cards,
 * tunnels. Right-click context menus per node type.
 */
export function ResourceTree({
  currentPanel,
  onOpenPanel,
}: {
  currentPanel: NavPanelId;
  onOpenPanel: (p: NavPanelId) => void;
}) {
  const { data: engines } = useEngines();
  const { data: hosts } = useHosts();
  const { data: groups } = useHostGroups();
  const { data: tunnels } = useTunnels();
  const { data: containers } = useContainers();
  const { hostOnline, sessions } = useLive();
  const { openTab, setActiveTab } = useWorkspace();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    "engine-local": true,
    "hosts": true,
    "tunnels": true,
  });

  const toggle = (key: string) => setExpanded((e) => ({ ...e, [key]: !e[key] }));

  const connectHost = (hostId: string, title: string) => {
    openTab({ kind: "ssh", title, hostId, env: "dev" });
  };

  const openHostDetail = (hostId: string, title: string) => {
    openTab({ kind: "host-detail", title, hostId, env: "dev" });
  };

  const openContainerDetail = (id: string, name: string) => {
    openTab({ kind: "container-detail", title: name, containerId: id, env: "none" });
  };

  const openEngineContainers = () => onOpenPanel("containers");

  const runningCount = containers?.filter((c) => c.state === "running").length ?? 0;

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-border-subtle bg-panel">
      <div className="flex items-center gap-1 border-b border-border-subtle p-1.5">
        <button
          onClick={() => onOpenPanel("dashboard")}
          className="flex h-6 flex-1 items-center gap-1.5 rounded-md px-2 text-[12px] text-secondary transition-colors hover:bg-hover-fill hover:text-foreground"
        >
          <Boxes className="h-3 w-3" />
          资源
        </button>
        <button
          onClick={() => setActiveTab("")}
          className="flex h-6 w-6 items-center justify-center rounded-md text-quaternary transition-colors hover:bg-hover-fill hover:text-secondary"
          title="刷新"
        >
          <RefreshCw className="h-3 w-3" />
        </button>
        <button
          onClick={() => onOpenPanel("hosts")}
          className="flex h-6 w-6 items-center justify-center rounded-md text-quaternary transition-colors hover:bg-hover-fill hover:text-secondary"
          title="添加主机"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto py-1.5">
        {/* Local engines */}
        <Section
          label="引擎"
          right={
            <button onClick={() => toggle("engine-local")} className="p-0.5 text-quaternary hover:text-secondary">
              {expanded["engine-local"] ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            </button>
          }
        >
          {!engines?.length && (
            <div className="px-2 py-3 text-center text-[12px] text-quaternary">
              未检测到 Docker 引擎
              <div className="mt-1 text-[11px]">支持 OrbStack · Docker Desktop · Colima · Podman</div>
            </div>
          )}
          {expanded["engine-local"] &&
            engines?.map((eng) => (
              <div key={eng.id}>
                <TreeNode
                  selected={currentPanel === "containers"}
                  onSelect={() => onOpenPanel("containers")}
                  contextMenu={
                    <ContextMenu>
                      <ContextMenuTrigger asChild>
                        <span className="contents" />
                      </ContextMenuTrigger>
                      <ContextMenuContent>
                        <ContextMenuLabel>{eng.name}</ContextMenuLabel>
                        <ContextMenuSeparator />
                        <ContextMenuItem onClick={openEngineContainers}>查看容器</ContextMenuItem>
                        <ContextMenuItem onClick={() => onOpenPanel("images")}>查看镜像</ContextMenuItem>
                        <ContextMenuSeparator />
                        <ContextMenuItem className="text-danger">断开引擎</ContextMenuItem>
                      </ContextMenuContent>
                    </ContextMenu>
                  }
                >
                  <Monitor className="h-3.5 w-3.5 text-accent" />
                  <span className="flex-1 truncate">{eng.name}</span>
                  <EngineBadge kind={eng.kind} />
                </TreeNode>
                {expanded["engine-local"] && eng.reachable && (
                  <div className="mb-1">
                    <TreeNode depth={1} onSelect={openEngineContainers}>
                      <Container className="h-3.5 w-3.5 text-muted" />
                      <span className="flex-1">容器</span>
                      <span className="mono-caption text-quaternary">{runningCount} 运行中</span>
                    </TreeNode>
                    <TreeNode depth={1} onSelect={() => onOpenPanel("images")}>
                      <Layers className="h-3.5 w-3.5 text-muted" />
                      <span className="flex-1">镜像</span>
                    </TreeNode>
                    <TreeNode depth={1} onSelect={() => onOpenPanel("containers")}>
                      <Database className="h-3.5 w-3.5 text-muted" />
                      <span className="flex-1">卷</span>
                    </TreeNode>
                    <TreeNode depth={1} onSelect={() => onOpenPanel("containers")}>
                      <Network className="h-3.5 w-3.5 text-muted" />
                      <span className="flex-1">网络</span>
                    </TreeNode>
                  </div>
                )}
              </div>
            ))}
        </Section>

        {/* Hosts grouped by env */}
        <Section
          label="主机"
          right={
            <button onClick={() => toggle("hosts")} className="p-0.5 text-quaternary hover:text-secondary">
              {expanded["hosts"] ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            </button>
          }
        >
          {expanded["hosts"] &&
            (groups ?? []).map((g) => {
              const gHosts = (hosts ?? []).filter((h) => h.groupId === g.id);
              if (!gHosts.length) return null;
              return (
                <div key={g.id} className="mb-0.5">
                  <div
                    className="flex h-5 items-center gap-1.5 px-2 text-[11px] font-medium"
                    style={{ color: g.color }}
                  >
                    <span className="dot" style={{ background: g.color, boxShadow: "none" }} />
                    {g.name}
                    <span className="mono-caption text-quaternary">{gHosts.length}</span>
                  </div>
                  {gHosts.map((h) => {
                    const online = hostOnline[h.id] ?? true; // default true in mock
                    const activeSession = Object.values(sessions).find((s) => s.hostId === h.id && s.status === "connected");
                    return (
                      <ContextMenu key={h.id}>
                        <ContextMenuTrigger asChild>
                          <TreeNode
                            selected={currentPanel === "hosts"}
                            onSelect={() => openHostDetail(h.id, h.name)}
                            onDoubleClick={() => connectHost(h.id, h.name)}
                          >
                            <span
                              className={cn("dot", online ? "bg-success" : "bg-quaternary")}
                              title={online ? "在线" : "离线"}
                            />
                            <span className="flex-1 truncate">{h.name}</span>
                            {activeSession && <Terminal className="h-3 w-3 text-accent" />}
                            <EnvTag env={h.env} />
                          </TreeNode>
                        </ContextMenuTrigger>
                        <ContextMenuContent>
                          <ContextMenuLabel className="mono">{h.user}@{h.address}:{h.port}</ContextMenuLabel>
                          <ContextMenuSeparator />
                          <ContextMenuItem onSelect={() => connectHost(h.id, h.name)}>
                            <Terminal /> 连接 SSH
                          </ContextMenuItem>
                          <ContextMenuItem onSelect={() => openHostDetail(h.id, h.name)}>主机详情</ContextMenuItem>
                          <ContextMenuItem onSelect={() => onOpenPanel("containers")}>展开容器</ContextMenuItem>
                          <ContextMenuSeparator />
                          <ContextMenuItem>编辑</ContextMenuItem>
                          <ContextMenuItem className="text-danger">删除</ContextMenuItem>
                        </ContextMenuContent>
                      </ContextMenu>
                    );
                  })}
                </div>
              );
            })}
          {expanded["hosts"] && !(hosts ?? []).length && (
            <div className="px-2 py-2 text-[12px] text-quaternary">暂无主机，点击 + 添加</div>
          )}
        </Section>

        {/* Tunnels */}
        <Section
          label="隧道"
          right={
            <button onClick={() => toggle("tunnels")} className="p-0.5 text-quaternary hover:text-secondary">
              {expanded["tunnels"] ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            </button>
          }
        >
          {expanded["tunnels"] && (tunnels ?? []).length === 0 && (
            <div className="px-2 py-2 text-[12px] text-quaternary">暂无隧道</div>
          )}
          {expanded["tunnels"] &&
            (tunnels ?? []).map((t) => (
              <TreeNode key={t.id} onSelect={() => onOpenPanel("tunnels")} depth={0}>
                <span className={cn("dot", t.status === "active" ? "bg-success" : "bg-quaternary")} />
                <Waypoints className="h-3.5 w-3.5 text-muted" />
                <span className="flex-1 truncate">{t.name}</span>
                <span className="mono-caption text-quaternary">
                  {t.status === "active" ? `${t.listenPort}→${t.remotePort}` : "—"}
                </span>
              </TreeNode>
            ))}
        </Section>

        {/* Sessions quick access */}
        {Object.keys(sessions).length > 0 && (
          <Section label="会话">
            {Object.entries(sessions).map(([sid, s]) => (
              <TreeNode key={sid} depth={0}>
                <Terminal className="h-3.5 w-3.5 text-accent" />
                <span className="flex-1 truncate">{s.title}</span>
              </TreeNode>
            ))}
          </Section>
        )}
      </div>

      <div className="flex items-center gap-1.5 border-t border-border-subtle px-2 py-1.5 text-[11px] text-quaternary">
        <CircleOff className="h-3 w-3" />
        未连接 · 本地模式
      </div>
    </aside>
  );
}
