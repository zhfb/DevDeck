import { useState } from "react";
import { X, PanelRight, Columns2, Rows2, Loader2 } from "lucide-react";
import { useWorkspace } from "@/stores/workspace";
import { cn } from "@/lib/utils";
import iconApp from "@/assets/icon-app.png";
import { TerminalView } from "./panels/TerminalView";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { toast } from "sonner";
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
            <SplitButton tab={active} />
          )}
        </div>
      </div>

      {/* Content — 所有标签常驻挂载，非激活的用 display:none 隐藏而非卸载。
          否则切换标签时 TerminalView 被卸载（term.dispose()），SSH 缓冲区全丢，
          切回来时新建的终端是空的、远端 shell 又无新输出 → 纯黑屏。 */}
      <div className="min-h-0 flex-1">
        {tabs.map((t) => (
          <div
            key={t.id}
            className="h-full"
            style={{ display: t.id === active?.id ? "block" : "none" }}
            aria-hidden={t.id !== active?.id}
          >
            <TabContent tab={t} onOpenPanel={onOpenPanel} />
          </div>
        ))}
      </div>
    </main>
  );
}

/**
 * Split button — opens a second SSH session on the same host (Keychain
 * credential) and renders panes in the chosen direction.
 */
function SplitButton({ tab }: { tab: WorkspaceTab }) {
  const splitActive = useWorkspace((s) => s.splitActive);
  const [splitting, setSplitting] = useState(false);

  const doSplit = async (dir: "h" | "v") => {
    if (splitting) return;
    setSplitting(true);
    try {
      const paneId = await splitActive(dir);
      if (paneId) toast.success(`已分屏（${dir === "h" ? "左右" : "上下"}）`);
    } catch (e) {
      const msg = String(e);
      const hint = msg.includes("auth") || msg.includes("password")
        ? "该主机未保存凭据（Keychain），无法自动开新会话。请先重新连接并勾选「保存到 Keychain」。"
        : msg;
      toast.error("分屏失败", { description: hint });
    } finally {
      setSplitting(false);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          disabled={splitting}
          className="flex h-5 items-center gap-0.5 rounded px-1.5 text-[11px] text-secondary hover:bg-hover-fill disabled:opacity-50"
        >
          {splitting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Columns2 className="h-3 w-3" />}
          分屏
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>分屏（同主机新会话）</DropdownMenuLabel>
        <DropdownMenuItem onClick={() => void doSplit("h")}>
          <Columns2 /> 左右分屏
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void doSplit("v")}>
          <Rows2 /> 上下分屏
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled>广播终端 (V1.1)</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
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
  const closePane = useWorkspace((s) => s.closePane);
  const setActivePane = useWorkspace((s) => s.setActivePane);
  // split panes render per splitDir; single pane fills
  const panes = tab.panes.length > 0 ? tab.panes : [{ id: "p0", title: tab.title, sessionId: tab.sessionId }];
  const splitDir = tab.panes.length > 0 ? (tab.splitDir ?? "h") : undefined;
  return (
    <div
      className="flex h-full"
      style={{ display: "flex", flexDirection: splitDir === "v" ? "column" : "row" }}
    >
      {panes.map((p, i) => {
        const active = tab.panes.length === 0 || p.id === tab.activePaneId;
        return (
          <div
            key={p.id}
            onClick={() => setActivePane(tab.id, p.id)}
            className={cn(
              "group/pane relative min-h-0 min-w-0 overflow-hidden",
              splitDir === "v" ? "flex-1" : "flex-1",
              active ? "z-10" : "z-0"
            )}
            style={
              i > 0
                ? splitDir === "v"
                  ? { borderTopWidth: 1, borderTopColor: "var(--border-subtle)" }
                  : { borderLeftWidth: 1, borderLeftColor: "var(--border-subtle)" }
                : undefined
            }
          >
            <TerminalView
              sessionId={p.sessionId}
              hostId={tab.hostId}
              containerId={tab.containerId}
              engineId={tab.engineId}
              kind={tab.kind}
              title={p.title}
              env={tab.env}
            />
            {/* active-pane outline */}
            <div
              className={cn(
                "pointer-events-none absolute inset-0 transition-opacity",
                active ? "opacity-100" : "opacity-0"
              )}
              style={{ boxShadow: "inset 0 0 0 1px var(--accent)" }}
            />
            {/* pane close (only when actually split) */}
            {tab.panes.length > 0 && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  closePane(tab.id, p.id);
                }}
                title="关闭此分屏"
                className="absolute right-1.5 top-1.5 z-20 rounded p-1 text-quaternary opacity-0 transition-opacity hover:bg-active-fill hover:text-secondary group-hover/pane:opacity-100"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        );
      })}
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
  const openLocalTerminal = useWorkspace((s) => s.openLocalTerminal);
  const quick = [
    { id: "hosts", label: "SSH 主机", desc: "管理连接与分组", icon: "🖥" },
    { id: "containers", label: "容器", desc: "本地 + 远程 Docker", icon: "📦" },
    { id: "tunnels", label: "隧道", desc: "端口转发", icon: "🔀" },
    { id: "local-terminal", label: "本地终端", desc: "macOS shell", icon: "⌘" },
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
            onClick={() =>
              q.id === "local-terminal"
                ? void openLocalTerminal().catch((e) =>
                    toast.error("打开本地终端失败", { description: String(e) })
                  )
                : onOpenPanel(q.id)
            }
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
