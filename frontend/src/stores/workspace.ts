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
  /** 来自卷面板的「用此卷运行容器」预填请求；容器面板消费后清空 */
  runPrefill: { volumes: { name: string; target?: string }[] } | null;
  requestRunWithVolumes: (volumes: { name: string; target?: string }[]) => string;
  clearRunPrefill: () => void;
  openSsh: (hostId: string, opts?: { title?: string; env?: "dev" | "staging" | "prod" | "none" }) => Promise<string>;
  openTab: (tab: Omit<WorkspaceTab, "id" | "panes"> & { panes?: WorkspaceTab["panes"] }) => string;
  closeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  /** 重命名 Tab 标题（仅 UI，不持久化） */
  renameTab: (id: string, title: string) => void;
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
  runPrefill: null,

  /** 卷面板「用此卷运行容器」：打开/激活容器面板并带上预填卷 */
  requestRunWithVolumes(volumes) {
    set({ runPrefill: { volumes } });
    return get().openTab({
      kind: "panel",
      title: "容器",
      panel: "containers",
      env: "none",
    });
  },

  clearRunPrefill() {
    set({ runPrefill: null });
  },

  /** 直接打开 SSH 标签：先建真实会话（Keychain 凭据），再 openTab 带上 sessionId，
   *  避免 TerminalView 因拿不到 sessionId 落到 Mock 演示终端。 */
  async openSsh(hostId, opts) {
    const session = await invoke<{ sessionId: string; title: string }>("ssh_connect", {
      hostId,
      password: null,
      cols: 100,
      rows: 30,
    });
    return get().openTab({
      kind: "ssh",
      title: opts?.title ?? session.title,
      hostId,
      env: opts?.env ?? "none",
      sessionId: session.sessionId,
    });
  },

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

  renameTab(id, title) {
    const clean = title.trim();
    if (!clean) return;
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, title: clean } : t)),
    }));
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
    // 同步 macOS 原生 vibrancy 材质（深色 HudWindow / 浅色 UnderWindowBackground）；
    // 浏览器 mock 模式下无副作用。
    void invoke("window_set_vibrancy", { dark: theme === "dark" }).catch(() => {});
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

// ---------------------------------------------------------------------------
// 会话恢复（workspace persistence）
// ---------------------------------------------------------------------------
// 只持久化标签元数据，绝不落盘 sessionId（进程级句柄，重启即失效）与
// activity 标记。SSH / 本地终端标签在恢复时按 Keychain 凭据重建真实会话。
const WORKSPACE_KEY = "devdeck.workspace.tabs.v1";

export interface PersistedWorkspaceTab {
  kind: TabKind;
  title: string;
  subtitle?: string;
  env: WorkspaceTab["env"];
  hostId?: string;
  containerId?: string;
  engineId?: string;
  panel?: string;
  splitDir?: "h" | "v";
  /** 拆分窗格仅存 id/title；sessionId 恢复时重建 */
  panes: { id: string; title: string }[];
  activePaneId?: string;
}

function serializeTabs(tabs: WorkspaceTab[]): PersistedWorkspaceTab[] {
  return tabs.map((t) => ({
    kind: t.kind,
    title: t.title,
    subtitle: t.subtitle,
    env: t.env,
    hostId: t.hostId,
    containerId: t.containerId,
    engineId: t.engineId,
    panel: t.panel,
    splitDir: t.splitDir,
    panes: (t.panes ?? []).map((p) => ({ id: p.id, title: p.title })),
    activePaneId: t.activePaneId,
  }));
}

/** tabs 变化即持久化（localStorage 足够轻；SQLite 侧不做会话持久化） */
useWorkspace.subscribe((s) => {
  try {
    localStorage.setItem(WORKSPACE_KEY, JSON.stringify(serializeTabs(s.tabs)));
  } catch {
    // 存储满/隐私模式降级：忽略，会话恢复能力暂时失效
  }
});

/**
 * 启动时恢复上次的工作区：
 * - panel / dashboard / host-detail / container-detail：直接恢复（无后端会话）
 * - ssh：按 Keychain 凭据重建会话（失败则跳过该标签并提示，绝不落入 mock 终端）
 * - local：重建本地 PTY shell
 * 由 App 挂载时调用一次。
 */
export async function restoreWorkspace(): Promise<void> {
  let saved: PersistedWorkspaceTab[];
  try {
    saved = JSON.parse(localStorage.getItem(WORKSPACE_KEY) ?? "[]") as PersistedWorkspaceTab[];
  } catch {
    localStorage.removeItem(WORKSPACE_KEY);
    return;
  }
  if (!Array.isArray(saved) || saved.length === 0) return;

  const ws = useWorkspace.getState();
  const skipped: string[] = [];
  for (const t of saved) {
    if (t.kind === "ssh") {
      if (!t.hostId) continue;
      try {
        const session = await invoke<{ sessionId: string; title: string }>("ssh_connect", {
          hostId: t.hostId,
          password: null,
          cols: 100,
          rows: 30,
        });
        // 拆分窗格恢复：每个 pane 都是独立 SSH 会话，逐一重建；连不上的 pane 跳过
        const panes: { id: string; title: string; sessionId: string }[] = [];
        if (t.panes.length > 0) {
          panes.push({ id: t.panes[0].id, title: t.panes[0].title, sessionId: session.sessionId });
          for (const p of t.panes.slice(1)) {
            try {
              const sp = await invoke<{ sessionId: string; title: string }>("ssh_connect", {
                hostId: t.hostId,
                password: null,
                cols: 100,
                rows: 30,
              });
              panes.push({ id: p.id, title: p.title, sessionId: sp.sessionId });
            } catch {
              // 单个 pane 重建失败不阻塞整标签恢复
            }
          }
          if (panes.length === 1) panes.length = 0; // 只剩主会话 → 回到未拆分态
        }
        ws.openTab({
          kind: "ssh",
          title: t.title,
          subtitle: t.subtitle,
          hostId: t.hostId,
          env: t.env,
          sessionId: session.sessionId,
          splitDir: panes.length > 0 ? t.splitDir : undefined,
          panes,
          activePaneId: panes.length > 0 ? t.activePaneId : undefined,
        });
      } catch {
        skipped.push(t.title);
      }
    } else if (t.kind === "local") {
      try {
        const sessionId = await invoke<string>("local_shell_start", { cols: 100, rows: 30 });
        ws.openTab({
          kind: "local",
          title: t.title,
          subtitle: t.subtitle,
          env: t.env,
          sessionId,
        });
      } catch {
        skipped.push(t.title);
      }
    } else {
      ws.openTab({
        kind: t.kind,
        title: t.title,
        subtitle: t.subtitle,
        env: t.env,
        hostId: t.hostId,
        containerId: t.containerId,
        engineId: t.engineId,
        panel: t.panel,
      });
    }
  }
  if (skipped.length > 0) {
    console.info(`[workspace] 会话恢复跳过（无 Keychain 凭据）: ${skipped.join(", ")}`);
  }
}
