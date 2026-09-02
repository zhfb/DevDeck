import { LayoutDashboard, Boxes, Server, Image as ImageIcon, Waypoints, Activity, ListTodo, Settings, Search, Moon, Sun, Command, FolderTree, Database, Network as NetworkIcon, TerminalSquare, Layers } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useWorkspace } from "@/stores/workspace";
import { useUi } from "@/stores/workspace";
import { cn } from "@/lib/utils";
import iconApp from "@/assets/icon-app.png";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const NAV_ITEM_IDS = [
  "dashboard",
  "hosts",
  "sftp",
  "containers",
  "images",
  "volumes",
  "networks",
  "snippets",
  "tunnels",
  "compose",
  "monitor",
  "tasks",
  "settings",
] as const;

const NAV_ICONS: Record<(typeof NAV_ITEM_IDS)[number], typeof LayoutDashboard> = {
  dashboard: LayoutDashboard,
  hosts: Server,
  sftp: FolderTree,
  containers: Boxes,
  images: ImageIcon,
  volumes: Database,
  networks: NetworkIcon,
  snippets: TerminalSquare,
  tunnels: Waypoints,
  compose: Layers,
  monitor: Activity,
  tasks: ListTodo,
  settings: Settings,
};

export type NavPanelId = (typeof NAV_ITEM_IDS)[number];

/** 44px top nav rail — macOS-style toolbar */
export function NavRail({ current, onNavigate }: { current: NavPanelId; onNavigate: (id: NavPanelId) => void }) {
  const { t } = useTranslation();
  const { theme, toggleTheme, setCommandPaletteOpen } = useUi();
  const bottomPanel = useWorkspace((s) => s.bottomPanel);
  const setBottomPanel = useWorkspace((s) => s.setBottomPanel);

  return (
    <header className="drag-region flex h-11 shrink-0 items-center justify-between border-b border-border-subtle bg-panel pl-[76px] pr-3">
      {/* Brand + primary nav.
          pl-[76px] reserves the macOS traffic-light buttons: the window uses
          titleBarStyle: Overlay, so app content extends under the titlebar. */}
      <div className="no-drag flex items-center gap-4">
        <div className="flex items-center gap-2 pl-0.5">
          <img
            src={iconApp}
            alt="DevDeck"
            className="h-6 w-6 rounded-[6px] shadow-[inset_0_-1px_0_rgba(0,0,0,0.25)]"
            draggable={false}
          />
          <span className="text-[14px] font-semibold tracking-tight">DevDeck</span>
        </div>

        <nav className="no-drag flex items-center gap-1">
          {NAV_ITEM_IDS.map((id) => {
            const Icon = NAV_ICONS[id];
            const label = t(`nav.${id}`);
            const active = current === id;
            return (
              <Tooltip key={id}>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => onNavigate(id)}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-[12.5px] font-medium transition-colors",
                      active
                        ? "bg-active-fill text-foreground"
                        : "text-secondary hover:bg-hover-fill hover:text-foreground"
                    )}
                  >
                    <Icon className="h-3.5 w-3.5 shrink-0" strokeWidth={active ? 2.2 : 1.9} />
                    <span className="leading-none">{label}</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{label}</TooltipContent>
              </Tooltip>
            );
          })}
        </nav>
      </div>

      {/* Right tools */}
      <div className="no-drag flex items-center gap-1">
        <button
          onClick={() => setCommandPaletteOpen(true)}
          className="flex h-7 w-44 items-center gap-2 rounded-md border border-border bg-input px-2.5 text-[12px] text-quaternary transition-colors hover:border-border hover:text-muted"
        >
          <Search className="h-3 w-3" />
          <span>搜索主机 / 容器…</span>
          <span className="ml-auto flex items-center gap-0.5 rounded border border-border-subtle bg-hover-fill px-1 py-px mono-caption">
            <Command className="h-2.5 w-2.5" />K
          </span>
        </button>
        <button
          onClick={() => setBottomPanel({ open: !bottomPanel.open })}
          className={cn(
            "flex h-7 w-7 items-center justify-center rounded-md transition-colors",
            bottomPanel.open ? "bg-accent-tint text-accent" : "text-secondary hover:bg-hover-fill"
          )}
          title={bottomPanel.open ? "收起底部面板" : "展开底部面板"}
        >
          <Activity className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={toggleTheme}
          className="flex h-7 w-7 items-center justify-center rounded-md text-secondary transition-colors hover:bg-hover-fill hover:text-foreground"
          title={theme === "dark" ? "切换到浅色" : "切换到深色"}
        >
          {theme === "dark" ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
        </button>
      </div>
    </header>
  );
}
