import { create } from "zustand";
import type { Host, DockerEngine } from "@/lib/types";

/**
 * Connection + data state shared across panels.
 * Real data flows in via TanStack Query hooks; this store holds
 * live-streamed state (host online/offline, engine reachability)
 * pushed from Rust events.
 */
interface LiveState {
  engineStatus: Record<string, { reachable: boolean; containers?: number; images?: number }>;
  hostOnline: Record<string, boolean>;
  /** sessions registry: sessionId → {hostId, status} */
  sessions: Record<string, { hostId: string; status: string; title: string }>;
  setEngineStatus: (engineId: string, s: { reachable: boolean; containers?: number; images?: number }) => void;
  setHostOnline: (hostId: string, online: boolean) => void;
  upsertSession: (sessionId: string, s: { hostId: string; status: string; title: string }) => void;
}

export const useLive = create<LiveState>((set) => ({
  engineStatus: {},
  hostOnline: {},
  sessions: {},
  setEngineStatus: (engineId, s) =>
    set((st) => ({ engineStatus: { ...st.engineStatus, [engineId]: s } })),
  setHostOnline: (hostId, online) =>
    set((st) => ({ hostOnline: { ...st.hostOnline, [hostId]: online } })),
  upsertSession: (sessionId, s) =>
    set((st) => ({ sessions: { ...st.sessions, [sessionId]: s } })),
}));

// ---------------------------------------------------------------------------
// Command palette item registry — panels register searchable actions
// ---------------------------------------------------------------------------
export interface PaletteAction {
  id: string;
  title: string;
  keywords?: string;
  icon?: string;
  group: string;
  run: () => void;
}

interface PaletteState {
  actions: PaletteAction[];
  registerAction: (a: PaletteAction) => () => void;
}

export const usePalette = create<PaletteState>((set, get) => ({
  actions: [],
  registerAction(a) {
    if (get().actions.some((x) => x.id === a.id)) return () => {};
    set((s) => ({ actions: [...s.actions, a] }));
    return () => set((s) => ({ actions: s.actions.filter((x) => x.id !== a.id) }));
  },
}));
