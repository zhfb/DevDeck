import { useEffect } from "react";
import { create } from "zustand";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke, isTauri } from "@/lib/api";

export type PowerMode = "active" | "background" | "idle";

interface PowerState {
  mode: PowerMode;
  setMode: (mode: PowerMode) => void;
}

export const usePower = create<PowerState>((set) => ({
  mode: "active",
  setMode: (mode) => set({ mode }),
}));

const IDLE_AFTER_MS = 5 * 60 * 1000;

/** Bridges window focus and user activity into the shared power policy. */
export function PowerController() {
  const mode = usePower((s) => s.mode);
  const setMode = usePower((s) => s.setMode);

  useEffect(() => {
    let disposed = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let unlistenFocus: (() => void) | undefined;

    const publish = (next: PowerMode) => {
      if (disposed || usePower.getState().mode === next) return;
      setMode(next);
      void invoke("power_state_set", { powerState: next }).catch(() => {
        // Browser preview and older backends may not expose this command yet.
      });
    };

    const scheduleIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => publish("idle"), IDLE_AFTER_MS);
    };

    const activity = () => {
      publish(document.visibilityState === "visible" ? "active" : "background");
      scheduleIdle();
    };

    const visibility = () => {
      publish(document.visibilityState === "visible" ? "active" : "background");
      scheduleIdle();
    };
    const blur = () => {
      publish("background");
      scheduleIdle();
    };

    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("focus", activity);
    window.addEventListener("blur", blur);
    window.addEventListener("keydown", activity, { passive: true });
    window.addEventListener("pointerdown", activity, { passive: true });
    scheduleIdle();

    if (isTauri) {
      void getCurrentWindow()
        .onFocusChanged(({ payload: focused }) => {
          publish(focused ? "active" : "background");
          scheduleIdle();
        })
        .then((cleanup) => {
          if (disposed) cleanup();
          else unlistenFocus = cleanup;
        });
    }

    return () => {
      disposed = true;
      if (idleTimer) clearTimeout(idleTimer);
      unlistenFocus?.();
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("focus", activity);
      window.removeEventListener("blur", blur);
      window.removeEventListener("keydown", activity);
      window.removeEventListener("pointerdown", activity);
    };
  }, [setMode]);

  // Keep `mode` read here so the controller remains subscribed in React even
  // when all behavior is handled by the effect above.
  void mode;
  return null;
}

export function powerInterval(mode: PowerMode, active: number, background: number): number | false {
  if (mode === "active") return active;
  if (mode === "background") return background;
  return false;
}
