/**
 * Lightweight terminal text bridge (P1: Snippets 插入终端).
 *
 * A SnippetsPanel can emit a command targeting a specific sessionId; the
 * TerminalView pane owning that session injects it as if typed. Keyed by
 * session id so only the targeted pane reacts.
 */
type Handler = (text: string) => void;
const handlers = new Map<string, Set<Handler>>();

export function onTerminalInsert(sessionId: string, handler: Handler): () => void {
  let set = handlers.get(sessionId);
  if (!set) {
    set = new Set();
    handlers.set(sessionId, set);
  }
  set.add(handler);
  return () => {
    set.delete(handler);
  };
}

export function emitTerminalInsert(sessionId: string, text: string): void {
  handlers.get(sessionId)?.forEach((h) => h(text));
}

/**
 * 广播终端（P1）：一组会话组成广播组，任一成员的输入会通过后端
 * `ssh_broadcast` 扇出到组内全部会话的 PTY。
 */
const broadcastSessions = new Set<string>();

export function setBroadcast(sessionId: string, on: boolean): void {
  if (on) broadcastSessions.add(sessionId);
  else broadcastSessions.delete(sessionId);
}

export function getBroadcastGroup(): string[] {
  return [...broadcastSessions];
}

export function isBroadcastSession(sessionId: string): boolean {
  return broadcastSessions.has(sessionId);
}

/** Fired when a session joins/leaves the broadcast group (for UI refresh). */
type BroadcastListener = (sessions: string[]) => void;
const broadcastListeners = new Set<BroadcastListener>();

export function onBroadcastChange(listener: BroadcastListener): () => void {
  broadcastListeners.add(listener);
  return () => {
    broadcastListeners.delete(listener);
  };
}

export function notifyBroadcastChange(): void {
  const group = getBroadcastGroup();
  broadcastListeners.forEach((l) => l(group));
}
