import { X, PanelRight, MoreHorizontal, Columns2, Rows2 } from "lucide-react";
import { useWorkspace } from "@/stores/workspace";
import { cn } from "@/lib/utils";
import iconApp from "@/assets/icon-app-fig1.png";
import { TerminalView } from "./panels/TerminalView";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { WorkspaceTab } from "@/stores/workspace";

/**
 * Main workspace canvas: tab strip + content area.
 * Panel/detail tabs render lazily via the tab's `panel` field.
 */
export function TabCanvas({
  onOpenPanel,
}: {
  onOpenPanel: (p: string) => void;
}) {
  const { tabs, activeTabId, closeTab, setActiveTab, splitActive } = useWorkspace();

  if (tabs.length === 0) {
    return <WelcomeScreen onOpenPanel={onOpenPanel} />;
  }

  const active = tabs.find((t) => t.id === activeTabId) ?? tabs[0];

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-background">
      {/* Tab strip */}
      <div className="flex h-8 shrink-0 items-end gap-0 border-b border-border-subtle bg-panel pl-1.5">
        {tabs.map((t) => (
          <div
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            className={cn(
              "group flex h-7 max-w-[200px] cursor-default items-center gap-1.5 rounded-t-md border border-b-0 px-2.5 text-[12px] transition-colors",
              t.id === active?.id
                ? "border-border bg-background text-foreground"
                : "border-transparent text-secondary hover:bg-hover-fill"
            )}
          >
            <span className={cn("truncate", t.activity && "text-accent")}>{t.title}</span>
            {t.subtitle && <span className="mono-caption hidden truncate text-quaternary">{t.subtitle}</span>}
            <button
              onClick={(e) => {
                e.stopPropagation();
                closeTab(t.id);
              }}
              className="ml-0.5 rounded p-0.5 text-quaternary opacity-0 transition-opacity hover:bg-active-fill hover:text-secondary group-hover:opacity-100"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
        <div className="mb-1.5 ml-auto mr-2 flex items-center gap-0.5">
          {active?.kind === "ssh" && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="flex h-5 items-center gap-0.5 rounded px-1.5 text-[11px] text-secondary hover:bg-hover-fill">
                  <Columns2 className="h-3 w-3" /> 分屏
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>分屏</DropdownMenuLabel>
                <DropdownMenuItem onClick={() => splitActive("h")}>
                  <Columns2 /> 左右分屏
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => splitActive("v")}>
                  <Rows2 /> 上下分屏
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem disabled>广播终端 (V1.1)</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="min-h-0 flex-1">
        <TabContent tab={active} onOpenPanel={onOpenPanel} />
      </div>
    </main>
  );
}

function TabContent({ tab, onOpenPanel }: { tab: WorkspaceTab; onOpenPanel: (p: string) => void }) {
  switch (tab.kind) {
    case "ssh":
    case "docker-exec":
    case "local":
      return <TerminalTabContent tab={tab} />;
    case "dashboard":
      return <LazyPanel panel="dashboard" onOpenPanel={onOpenPanel} />;
    case "panel":
      return <LazyPanel panel={tab.panel ?? "containers"} onOpenPanel={onOpenPanel} />;
    case "container-detail":
      return <LazyPanel panel={`container-detail:${tab.containerId}`} onOpenPanel={onOpenPanel} />;
    case "host-detail":
      return <LazyPanel panel={`host-detail:${tab.hostId}`} onOpenPanel={onOpenPanel} />;
    default:
      return null;
  }
}

function TerminalTabContent({ tab }: { tab: WorkspaceTab }) {
  // split panes render side-by-side; single pane fills
  const panes = tab.panes.length > 0 ? tab.panes : [{ id: "p0", title: tab.title, sessionId: tab.sessionId }];
  return (
    <div className="flex h-full" style={{ display: "flex" }}>
      {panes.map((p, i) => (
        <div key={p.id} className="relative flex-1 overflow-hidden border-border-subtle" style={i > 0 ? { borderLeftWidth: 1 } : undefined}>
          <TerminalView sessionId={p.sessionId} hostId={tab.hostId} title={p.title} env={tab.env} />
        </div>
      ))}
    </div>
  );
}

/** Lazy panel loader — panels register via PANEL_REGISTRY (features/*) */
import { PANEL_REGISTRY } from "@/features/registry";
import { Suspense } from "react";

function LazyPanel({ panel, onOpenPanel }: { panel: string; onOpenPanel: (p: string) => void }) {
  // detail tabs: "container-detail:<id>" / "host-detail:<id>"
  let Comp = PANEL_REGISTRY[panel];
  let extra: Record<string, string> = {};
  if (!Comp) {
    if (panel.startsWith("container-detail:")) {
      Comp = PANEL_REGISTRY["container-detail"];
      extra = { containerId: panel.slice("container-detail:".length) };
    } else if (panel.startsWith("host-detail:")) {
      Comp = PANEL_REGISTRY["host-detail"];
      extra = { hostId: panel.slice("host-detail:".length) };
    } else {
      Comp = PANEL_REGISTRY["dashboard"];
    }
  }
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-border border-t-accent" />
        </div>
      }
    >
      <Comp onOpenPanel={onOpenPanel} {...extra} />
    </Suspense>
  );
}

function WelcomeScreen({ onOpenPanel }: { onOpenPanel: (p: string) => void }) {
  const quick = [
    { id: "hosts", label: "SSH 主机", desc: "管理连接与分组", icon: "🖥" },
    { id: "containers", label: "容器", desc: "本地 + 远程 Docker", icon: "📦" },
    { id: "tunnels", label: "隧道", desc: "端口转发", icon: "🔀" },
    { id: "monitor", label: "监控", desc: "无 Agent 指标", icon: "📈" },
  ];
  return (
    <div className="grid h-full w-full place-items-center bg-background">
      <div className="flex flex-col items-center gap-6">
        <div className="flex flex-col items-center gap-3">
        <img
          src={iconApp}
          alt="DevDeck"
          className="h-14 w-14 rounded-2xl shadow-[inset_0_-2px_0_rgba(0,0,0,0.25)]"
          draggable={false}
        />
        <div className="text-[17px] font-semibold tracking-tight">DevDeck</div>
        <div className="text-[12.5px] text-muted">SSH · SFTP · Docker · 隧道 — macOS 原生工作台</div>
      </div>
      <div className="grid grid-cols-2 gap-2.5">
        {quick.map((q) => (
          <button
            key={q.id}
            onClick={() => onOpenPanel(q.id)}
            className="flex w-52 items-center gap-3 rounded-lg border border-border bg-surface p-3 text-left transition-colors hover:border-accent/40 hover:bg-active-fill"
          >
            <span className="text-[16px]">{q.icon}</span>
            <span className="flex flex-col">
              <span className="text-[13px] font-medium text-foreground">{q.label}</span>
              <span className="text-[11.5px] text-muted">{q.desc}</span>
            </span>
          </button>
        ))}
      </div>
      <div className="flex items-center gap-3 text-[11px] text-quaternary">
        <span>Cmd+K 命令面板</span>
        <span>·</span>
        <span>双击主机连接</span>
        <span>·</span>
        <span>右键资源操作</span>
      </div>
      </div>
    </div>
  );
}
