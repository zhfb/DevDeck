import { useEffect } from "react";
import { useWorkspace } from "@/stores/workspace";
import { useUi } from "@/stores/workspace";

/**
 * App-wide keyboard shortcuts（macOS 惯例）：
 *  Cmd/Ctrl+T               新建本地终端
 *  Cmd/Ctrl+W               关闭当前标签
 *  Cmd/Ctrl+1..9            切换到第 N 个标签
 *  Cmd/Ctrl+Shift+[ / ]     上一个 / 下一个标签
 *
 * 只拦截 Cmd/Ctrl+T / W / 1-9 / Shift+[ / ] 这几个特定组合，
 * 不影响终端内常规的 Ctrl 快捷键（Ctrl+C/V/L 等由 xterm 自行处理）。
 */
export function useAppShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      const s = useWorkspace.getState();

      // Cmd+T 新建本地终端
      if (k === "t" && !e.shiftKey) {
        e.preventDefault();
        useUi.getState().setCommandPaletteOpen(false);
        void s.openLocalTerminal();
        return;
      }
      // Cmd+W 关闭当前标签
      if (k === "w" && !e.shiftKey) {
        e.preventDefault();
        if (s.activeTabId) s.closeTab(s.activeTabId);
        return;
      }
      // Cmd+Shift+[ / ] 前后切换（用 e.code 避免 Shift 改变 e.key）
      if (e.shiftKey && (e.code === "BracketLeft" || e.code === "BracketRight")) {
        e.preventDefault();
        const n = s.tabs.length;
        if (!n) return;
        const idx = Math.max(0, s.tabs.findIndex((t) => t.id === s.activeTabId));
        const next =
          e.code === "BracketRight" ? (idx + 1) % n : (idx - 1 + n) % n;
        const tab = s.tabs[next];
        if (tab) s.setActiveTab(tab.id);
        return;
      }
      // Cmd+1..9 切换标签
      if (/^[1-9]$/.test(k)) {
        const tab = s.tabs[Number(k) - 1];
        if (tab) {
          e.preventDefault();
          s.setActiveTab(tab.id);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
