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
