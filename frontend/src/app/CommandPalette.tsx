import { useEffect, useMemo } from "react";
import { Command } from "cmdk";
import { Search, Terminal, Boxes, Monitor, Waypoints, Sun, Moon, LayoutDashboard, Server, Layers, Activity, Settings } from "lucide-react";
import { useUi } from "@/stores/workspace";
import { usePalette, useConnect } from "@/stores/live";
import { useWorkspace } from "@/stores/workspace";
import { useHosts, useContainers, useEngines } from "@/lib/queries";
import type { Host } from "@/lib/types";
import type { NavPanelId } from "./NavRail";

const PANEL_ICONS: Record<string, React.ElementType> = {
  dashboard: LayoutDashboard,
  hosts: Server,
  containers: Boxes,
  images: Layers,
  tunnels: Waypoints,
  monitor: Activity,
  settings: Settings,
};

/** Cmd+K global command palette — search hosts/containers/actions */
export function CommandPalette({ onOpenPanel }: { onOpenPanel: (p: NavPanelId) => void }) {
  const { commandPaletteOpen, setCommandPaletteOpen, toggleTheme } = useUi();
  const { openTab } = useWorkspace();
  const openConnect = useConnect((s) => s.openConnect);
  const { actions } = usePalette();
  const { data: hosts } = useHosts();
  const { data: containers } = useContainers();
  const { data: engines } = useEngines();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        toggleTheme; // noop guard
        useUi.getState().toggleCommandPalette();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const connectHost = (host: Host) => {
    openConnect({ hostId: host.id, hostName: host.name, address: host.address, user: host.user });
    setCommandPaletteOpen(false);
  };

  const items = useMemo(() => {
    const list: { id: string; group: string; title: string; keywords?: string; icon: React.ReactNode; onSelect: () => void }[] = [
      ...(hosts ?? []).map((h) => ({
        id: `host-${h.id}`,
        group: "主机",
        title: h.name,
        keywords: `${h.user}@${h.address} ssh`,
        icon: <Server className="h-3.5 w-3.5" />,
        onSelect: () => connectHost(h),
      })),
      ...(containers ?? []).map((c) => ({
        id: `container-${c.id}`,
        group: "容器",
        title: c.name,
        keywords: `${c.image} docker exec`,
        icon: <Boxes className="h-3.5 w-3.5" />,
        onSelect: () => {
          openTab({ kind: "container-detail", title: c.name, containerId: c.id, env: "none" });
          setCommandPaletteOpen(false);
        },
      })),
      ...(engines ?? []).map((e) => ({
        id: `engine-${e.id}`,
        group: "引擎",
        title: e.name,
        keywords: `${e.kind} docker socket`,
        icon: <Monitor className="h-3.5 w-3.5" />,
        onSelect: () => {
          onOpenPanel("containers");
          setCommandPaletteOpen(false);
        },
      })),
      ...actions.map((a) => ({
        id: a.id,
        group: a.group,
        title: a.title,
        keywords: a.keywords,
        icon: <Terminal className="h-3.5 w-3.5" />,
        onSelect: () => {
          a.run();
          setCommandPaletteOpen(false);
        },
      })),
    ];
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hosts, containers, engines, actions]);

  if (!commandPaletteOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[15vh] backdrop-blur-[1px]"
      onClick={() => setCommandPaletteOpen(false)}
    >
      <div
        className="w-[560px] overflow-hidden rounded-xl border border-border bg-elevated shadow-[0_24px_64px_rgba(0,0,0,0.5)]"
        onClick={(e) => e.stopPropagation()}
      >
        <Command loop className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.04em] [&_[cmdk-group-heading]]:text-muted">
          <div className="flex items-center gap-2 border-b border-border-subtle px-3">
            <Search className="h-4 w-4 shrink-0 text-muted" />
            <Command.Input
              autoFocus
              placeholder="搜索主机、容器、命令…"
              className="h-10 w-full bg-transparent text-[13.5px] text-foreground placeholder:text-quaternary focus:outline-none"
            />
            <kbd className="shrink-0 rounded border border-border-subtle bg-hover-fill px-1.5 py-0.5 text-[10px] text-muted">ESC</kbd>
          </div>
          <Command.List className="max-h-[320px] overflow-y-auto p-1.5">
            <Command.Empty className="py-8 text-center text-[13px] text-muted">无匹配结果</Command.Empty>
            {["主机", "容器", "引擎", ...Array.from(new Set(items.filter((i) => !["主机", "容器", "引擎"].includes(i.group)).map((i) => i.group)))].map(
              (group) => {
                const groupItems = items.filter((i) => i.group === group);
                if (!groupItems.length) return null;
                return (
                  <Command.Group key={group} heading={group}>
                    {groupItems.map((i) => (
                      <Command.Item
                        key={i.id}
                        value={`${group} ${i.title} ${i.keywords ?? ""}`}
                        onSelect={i.onSelect}
                        className="flex cursor-default items-center gap-2.5 rounded-md px-2 py-2 text-[13px] text-secondary aria-selected:bg-active-fill aria-selected:text-foreground data-[selected=true]:bg-active-fill"
                      >
                        <span className="text-muted">{i.icon}</span>
                        <span className="flex-1 truncate">{i.title}</span>
                        <span className="mono-caption text-quaternary">{i.keywords?.split(" ")[0]}</span>
                      </Command.Item>
                    ))}
                  </Command.Group>
                );
              }
            )}
          </Command.List>
          <div className="flex items-center gap-3 border-t border-border-subtle px-3 py-1.5 text-[10.5px] text-quaternary">
            <span><kbd className="text-muted">↑↓</kbd> 导航</span>
            <span><kbd className="text-muted">↵</kbd> 执行</span>
            <button
              onClick={toggleTheme}
              className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-quaternary hover:bg-hover-fill hover:text-secondary"
            >
              {useUi.getState().theme === "dark" ? <Sun className="h-3 w-3" /> : <Moon className="h-3 w-3" />}
              切换主题
            </button>
          </div>
        </Command>
      </div>
    </div>
  );
}
