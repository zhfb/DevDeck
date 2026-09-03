import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { NavRail, type NavPanelId } from "./app/NavRail";
import { ResourceTree } from "./app/ResourceTree";
import { TabCanvas } from "./app/TabCanvas";
import { BottomDock } from "./app/BottomDock";
import { CommandPalette } from "./app/CommandPalette";
import TrayEvents from "./app/TrayEvents";
import { ErrorBoundary } from "./components/error-boundary";
import { ConnectionDialog } from "./components/ConnectionDialog";
import { HostKeyDialog } from "./components/HostKeyDialog";
import { useWorkspace } from "./stores/workspace";
import { PowerController } from "./stores/power";
import { useIdleLock } from "./stores/idleLock";
import LockScreen from "./features/lock/LockScreen";

const PANEL_IDS = [
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
] as const satisfies readonly NavPanelId[];

/**
 * App shell: 44px nav rail + resource tree sidebar + tab canvas + bottom dock.
 * Layout from docs/管理面板规划.md §3.
 */
export default function App() {
  const { t } = useTranslation();
  const [currentPanel, setCurrentPanel] = useState<NavPanelId>("dashboard");
  const openTab = useWorkspace((s) => s.openTab);
  const initIdleLock = useIdleLock((s) => s.init);

  useEffect(() => {
    void initIdleLock();
  }, [initIdleLock]);

  const handleNavigate = (panel: string) => {
    const p = panel as NavPanelId;
    setCurrentPanel(p);
    if (p === "dashboard") {
      openTab({ kind: "dashboard", title: t("panel.dashboard"), env: "none" });
    } else if (PANEL_IDS.includes(p)) {
      openTab({ kind: "panel", title: t(`panel.${p}`), panel: p, env: "none" });
    }
  };

  return (
    <ErrorBoundary>
      <div className="flex h-full flex-col bg-background text-foreground">
        <PowerController />
        <NavRail current={currentPanel} onNavigate={handleNavigate} />
        <div className="flex min-h-0 flex-1">
          <ResourceTree currentPanel={currentPanel} onOpenPanel={handleNavigate} />
          <TabCanvas onOpenPanel={handleNavigate} />
        </div>
        <BottomDock />
        <CommandPalette onOpenPanel={handleNavigate} />
        <ConnectionDialog />
        <HostKeyDialog />
        <TrayEvents />
        <LockScreen />
      </div>
    </ErrorBoundary>
  );
}
