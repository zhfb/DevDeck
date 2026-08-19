import { useState } from "react";
import { NavRail, type NavPanelId } from "./app/NavRail";
import { ResourceTree } from "./app/ResourceTree";
import { TabCanvas } from "./app/TabCanvas";
import { BottomDock } from "./app/BottomDock";
import { CommandPalette } from "./app/CommandPalette";
import { ErrorBoundary } from "./components/error-boundary";
import { useWorkspace } from "./stores/workspace";

const PANEL_TITLES: Record<NavPanelId, string> = {
  dashboard: "总览",
  hosts: "SSH 主机",
  containers: "容器",
  images: "镜像",
  tunnels: "隧道",
  monitor: "监控",
  settings: "设置",
};

/**
 * App shell: 44px nav rail + resource tree sidebar + tab canvas + bottom dock.
 * Layout from docs/管理面板规划.md §3.
 */
export default function App() {
  const [currentPanel, setCurrentPanel] = useState<NavPanelId>("dashboard");
  const openTab = useWorkspace((s) => s.openTab);

  const handleNavigate = (panel: string) => {
    const p = panel as NavPanelId;
    setCurrentPanel(p);
    if (p === "dashboard") {
      openTab({ kind: "dashboard", title: "总览", env: "none" });
    } else if (PANEL_TITLES[p]) {
      openTab({ kind: "panel", title: PANEL_TITLES[p], panel: p, env: "none" });
    }
  };

  return (
    <ErrorBoundary>
      <div className="flex h-full flex-col bg-background text-foreground">
        <NavRail current={currentPanel} onNavigate={handleNavigate} />
        <div className="flex min-h-0 flex-1">
          <ResourceTree currentPanel={currentPanel} onOpenPanel={handleNavigate} />
          <TabCanvas onOpenPanel={handleNavigate} />
        </div>
        <BottomDock />
        <CommandPalette onOpenPanel={handleNavigate} />
      </div>
    </ErrorBoundary>
  );
}
