import { LayoutDashboard, Boxes, Server, Image as ImageIcon, Waypoints, Activity, Settings, Search, Moon, Sun, Command } from "lucide-react";
import { useWorkspace } from "@/stores/workspace";
import { useUi } from "@/stores/workspace";
import { cn } from "@/lib/utils";
import iconApp from "@/assets/icon-app.png";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const NAV_ITEMS = [
  { id: "dashboard", label: "总览", icon: LayoutDashboard },
  { id: "hosts", label: "主机", icon: Server },
  { id: "containers", label: "容器", icon: Boxes },
  { id: "images", label: "镜像", icon: ImageIcon },
  { id: "tunnels", label: "隧道", icon: Waypoints },
  { id: "monitor", label: "监控", icon: Activity },
  { id: "settings", label: "设置", icon: Settings },
] as const;

export type NavPanelId = (typeof NAV_ITEMS)[number]["id"];

/** 44px top nav rail — macOS-style toolbar */
export function NavRail({ current, onNavigate }: { current: NavPanelId; onNavigate: (id: NavPanelId) => void }) {
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

        <nav className="flex items-center gap-0.5">
          {NAV_ITEMS.map(({ id, label, icon: Icon }) => (
            <Tooltip key={id}>
              <TooltipTrigger asChild>
                <button
                  onClick={() => onNavigate(id)}
                  className={cn(
                    "flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] font-medium transition-colors",
                    current === id
                      ? "bg-active-fill text-foreground"
                      : "text-secondary hover:bg-hover-fill hover:text-foreground"
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {label}
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{label}</TooltipContent>
            </Tooltip>
          ))}
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
