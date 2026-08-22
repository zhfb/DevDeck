/**
 * Panel registry — maps panel tab keys to page components.
 * Panels live in features/* and register here (single source of truth).
 * Each panel receives { onOpenPanel } for cross-navigation.
 */
import { lazy, type ComponentType } from "react";

export interface PanelProps {
  onOpenPanel: (panel: string) => void;
}

export const PANEL_REGISTRY: Record<string, ComponentType<PanelProps>> = {
  dashboard: lazy(() => import("@/features/dashboard/DashboardPage")),
  hosts: lazy(() => import("@/features/hosts/HostsPanel")),
  sftp: lazy(() => import("@/features/sftp/SftpPanel")),
  containers: lazy(() => import("@/features/containers/ContainersPanel")),
  images: lazy(() => import("@/features/images/ImagesPanel")),
  tunnels: lazy(() => import("@/features/tunnels/TunnelsPanel")),
  monitor: lazy(() => import("@/features/monitor/MonitorPanel")),
  tasks: lazy(() => import("@/features/tasks/TasksPanel")),
  settings: lazy(() => import("@/features/settings/SettingsPanel")),
  "container-detail": lazy(() => import("@/features/containers/ContainerDetail")),
  "host-detail": lazy(() => import("@/features/hosts/HostDetail")),
};
