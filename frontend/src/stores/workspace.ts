import { create } from "zustand";
import { invoke } from "@/lib/api";
import type { TerminalTab } from "@/lib/types";

export type TabKind =
  | "ssh"
  | "docker-exec"
  | "local"
  | "dashboard"
  | "panel"
  | "container-detail"
  | "host-detail";

export interface WorkspaceTab {
  id: string;
  kind: TabKind;
  title: string;
  subtitle?: string;
  env: "dev" | "staging" | "prod" | "none";
  /** payload per kind */
  hostId?: string;
  containerId?: string;
  engineId?: string;
  sessionId?: string;
  /** panel tab: which management panel to render (containers/hosts/images/tunnels/monitor/settings) */
  panel?: string;
  /** split panes (terminal tabs only) */
  panes: { id: string; sessionId?: string; title: string }[];
  /** split direction once split ("h" = left/right, "v" = top/bottom) */
  splitDir?: "h" | "v";
  /** focused pane id (only meaningful when panes.length > 0) */
  activePaneId?: string;
  activity?: boolean;
}

interface WorkspaceState {
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  /** docked bottom panel state */
  bottomPanel: { open: boolean; tab: "logs" | "events" | "tasks"; height: number };
  sidebarCollapsed: boolean;
  openTab: (tab: Omit<WorkspaceTab, "id" | "panes"> & { panes?: WorkspaceTab["panes"] }) => string;
  closeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  setActivity: (id: string, active: boolean) => void;
  toggleSidebar: () => void;
  setBottomPanel: (p: Partial<WorkspaceState["bottomPanel"]>) => void;
  /**
   * Split the active ssh tab into panes. Each pane gets its own SSH session
   * (independent PTY). Resolves when the new pane's session is up; rejects
   * when the host has no Keychain credential (password-only hosts must
   * reconnect first with a saved password).
   */
  splitActive: (dir: "h" | "v") => Promise<string | null>;
  closePane: (tabId: string, paneId: string) => void;
  setActivePane: (tabId: string, paneId: string) => void;
  /** 打开 macOS 本地终端（PTY shell） */
  openLocalTerminal: () => Promise<string>;
}

let tabSeq = 0;
const nextId = (p: string) => `${p}-${Date.now().toString(36)}-${++tabSeq}`;

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  bottomPanel: { open: false, tab: "logs", height: 180 },
  sidebarCollapsed: false,

  openTab(tab) {
    const existing = get().tabs.find((t) => {
      if (t.kind !== tab.kind) return false;
      if (tab.kind === "panel") return t.panel === tab.panel;
      if (tab.kind === "dashboard") return true;
      if (tab.kind === "container-detail" || tab.kind === "docker-exec")
        return t.hostId === tab.hostId && t.containerId === tab.containerId;
      if (tab.kind === "host-detail") return t.hostId === tab.hostId;
      return t.hostId === tab.hostId;
    });
    if (existing && tab.kind !== "ssh") {
      set({ activeTabId: existing.id });
      return existing.id;
    }
    const id = nextId("tab");
    const t: WorkspaceTab = { ...tab, id, panes: tab.panes ?? [] };
    set((s) => ({ tabs: [...s.tabs, t], activeTabId: id }));
    return id;
  },

  closeTab(id) {
    const target = get().tabs.find((t) => t.id === id);
    if (!target) return;
    // 关闭本地终端时清理后端 PTY 子进程
    if (target.kind === "local" && target.sessionId) {
      void invoke("local_shell_stop", { sessionId: target.sessionId }).catch(() => {});
    }
    // 关闭 SSH 会话时释放后端连接（避免连接池泄漏）
    if (target.kind === "ssh" && target.sessionId) {
      void invoke("ssh_disconnect", { sessionId: target.sessionId }).catch(() => {});
    }
    // 拆分窗格中的 SSH 会话逐个释放
    for (const pane of target.panes ?? []) {
      if (pane.sessionId) {
        void invoke("ssh_disconnect", { sessionId: pane.sessionId }).catch(() => {});
      }
    }
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id);
      const tabs = s.tabs.filter((t) => t.id !== id);
      let active = s.activeTabId;
      if (active === id) {
        const next = tabs[Math.min(idx, tabs.length - 1)];
        active = next ? next.id : null;
      }
      return { tabs, activeTabId: active };
    });
  },

  setActiveTab(id) {
    set({ activeTabId: id });
  },

  setActivity(id, activity) {
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, activity } : t)),
    }));
  },

  toggleSidebar() {
    set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed }));
  },

  setBottomPanel(p) {
    set((s) => ({ bottomPanel: { ...s.bottomPanel, ...p } }));
  },

  splitActive(dir) {
    const { tabs, activeTabId } = get();
    const tab = tabs.find((t) => t.id === activeTabId);
    if (!tab || tab.kind !== "ssh" || !tab.hostId) return Promise.resolve(null);
    // New pane = new independent SSH session on the same host (Keychain
    // credential only — password-typed connections must be saved first).
    return invoke<{ sessionId: string; title: string }>("ssh_connect", {
      hostId: tab.hostId,
      password: null,
      cols: 100,
      rows: 30,
    })
      .then((session) => {
        const paneId = nextId("pane");
        const pane = { id: paneId, title: tab.title, sessionId: session.sessionId };
        set((s) => ({
          tabs: s.tabs.map((t) =>
            t.id === tab.id
              ? {
                  ...t,
                  splitDir: dir,
                  activePaneId: paneId,
                  // keep the ORIGINAL session as pane "p0" (stable key so the
                  // existing terminal component keeps its history) and append
                  // the new independent session as the second pane
                  panes:
                    t.panes.length > 0
                      ? [...t.panes, pane]
                      : [{ id: "p0", title: t.title, sessionId: t.sessionId }, pane],
                }
              : t
          ),
        }));
        return paneId;
      })
      .catch((e) => {
        // rethrow for the caller to surface the Keychain hint
        throw new Error(
          String(e).includes("SessionNotFound") || String(e).includes("auth")
            ? String(e)
            : `分屏连接失败：${String(e)}`
        );
      });
  },

  closePane(tabId, paneId) {
    const { tabs } = get();
    const tab = tabs.find((t) => t.id === tabId);
    const pane = tab?.panes.find((p) => p.id === paneId);
    // best-effort disconnect of the pane's session (fire and forget)
    if (pane?.sessionId) {
      void invoke("ssh_disconnect", { sessionId: pane.sessionId }).catch(() => {});
    }
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== tabId) return t;
        const panes = t.panes.filter((p) => p.id !== paneId);
        const activePaneId =
          t.activePaneId === paneId ? (panes[panes.length - 1]?.id ?? undefined) : t.activePaneId;
        return { ...t, panes, activePaneId };
      }),
    }));
  },

  setActivePane(tabId, paneId) {
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, activePaneId: paneId } : t)),
    }));
  },

  async openLocalTerminal() {
    // 已打开本地终端时直接激活，避免重复创建 PTY 产生孤儿 shell 进程
    const existing = get().tabs.find((t) => t.kind === "local");
    if (existing) {
      set({ activeTabId: existing.id });
      return existing.id;
    }
    const sessionId = await invoke<string>("local_shell_start", { cols: 100, rows: 30 });
    return get().openTab({
      kind: "local",
      title: "本地终端",
      subtitle: "macOS",
      env: "none",
      sessionId,
    });
  },
}));

// ---------------------------------------------------------------------------
// UI chrome state
// ---------------------------------------------------------------------------
interface UiState {
  theme: "dark" | "light";
  commandPaletteOpen: boolean;
  setTheme: (t: "dark" | "light") => void;
  toggleTheme: () => void;
  setCommandPaletteOpen: (open: boolean) => void;
  toggleCommandPalette: () => void;
}

export const useUi = create<UiState>((set, get) => ({
  theme: "dark",
  commandPaletteOpen: false,
  setTheme(theme) {
    document.documentElement.dataset.theme = theme;
    set({ theme });
  },
  toggleTheme() {
    get().setTheme(get().theme === "dark" ? "light" : "dark");
  },
  setCommandPaletteOpen(open) {
    set({ commandPaletteOpen: open });
  },
  toggleCommandPalette() {
    set((s) => ({ commandPaletteOpen: !s.commandPaletteOpen }));
  },
}));
