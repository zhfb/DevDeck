import { create } from "zustand";
import { invoke } from "@/lib/api";
import type { IdleLockConfig } from "@/lib/types";

/**
 * 闲置自动锁 store：
 * - 监听全局用户活动（鼠标/键盘/触控），更新 lastActivity
 * - 每 15s 检查一次：enabled 且超时未活动 → locked = true
 * - unlock() 调后端校验 PIN，成功则解锁
 * 由 App 挂载 IdleLockController 负责初始化监听与轮询。
 */
interface IdleLockState {
  config: IdleLockConfig | null;
  locked: boolean;
  lastActivity: number;
  hydrated: boolean;
  init: () => Promise<void>;
  markActivity: () => void;
  check: () => void;
  unlock: (pin: string) => Promise<boolean>;
  forceUnlock: () => void;
}

const CHECK_MS = 15_000;

export const useIdleLock = create<IdleLockState>((set, get) => ({
  config: null,
  locked: false,
  lastActivity: Date.now(),
  hydrated: false,

  init: async () => {
    if (get().hydrated) return;
    set({ hydrated: true });
    const events = ["mousemove", "mousedown", "keydown", "wheel", "touchstart"] as const;
    const onActivity = () => get().markActivity();
    for (const ev of events) {
      window.addEventListener(ev, onActivity, { passive: true });
    }
    window.setInterval(() => get().check(), CHECK_MS);
    // 初次加载配置
    try {
      const cfg = await invoke<IdleLockConfig>("idle_lock_config.get");
      set({ config: cfg, lastActivity: Date.now() });
    } catch {
      /* 浏览器 mock 或后端暂不可用 */
    }
  },

  markActivity: () => set({ lastActivity: Date.now() }),

  check: () => {
    const { config, locked, lastActivity } = get();
    if (!config?.enabled || locked) return;
    const idleMs = Date.now() - lastActivity;
    if (idleMs >= config.timeoutMinutes * 60_000) {
      set({ locked: true });
    }
  },

  unlock: async (pin) => {
    try {
      const ok = await invoke<boolean>("idle_lock.unlock", { pin });
      if (ok) {
        set({ locked: false, lastActivity: Date.now() });
      }
      return ok;
    } catch {
      return false;
    }
  },

  forceUnlock: () => {
    // 未设置 PIN 时的兜底：直接解锁（本机应用，风险可控）
    set({ locked: false, lastActivity: Date.now() });
  },
}));
