import { useEffect, useRef, useState } from "react";
import { TerminalSquare, Radio, ListTodo, X, Pause, Play } from "lucide-react";
import { useWorkspace } from "@/stores/workspace";
import { onEvent, startMockStreams } from "@/lib/api";
import type { DockerEventItem, LogLine, TaskItem } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Progress } from "@/components/ui/progress";

const mockLogs: LogLine[] = [
  { id: "l1", stream: "system", text: "DevDeck 会话启动 · 本地模式", time: new Date(Date.now() - 86_000).toISOString() },
  { id: "l2", stream: "stdout", text: "course-reminder | INFO: Started server process [1]", time: new Date(Date.now() - 84_000).toISOString() },
  { id: "l3", stream: "stdout", text: "course-reminder | INFO: Uvicorn running on http://0.0.0.0:8000", time: new Date(Date.now() - 84_000).toISOString() },
  { id: "l4", stream: "stderr", text: "postgres-16  | 2026-08-19 04:12:33.112 UTC [42] LOG: checkpoint complete", time: new Date(Date.now() - 60_000).toISOString() },
  { id: "l5", stream: "stdout", text: "nginx-gateway | 103.45.12.8 - - [19/Aug/2026:12:33:01 +0800] \"GET / HTTP/1.1\" 200 615", time: new Date(Date.now() - 30_000).toISOString() },
  { id: "l6", stream: "stdout", text: "nginx-gateway | 103.45.12.8 - - [19/Aug/2026:12:33:02 +0800] \"GET /static/app.js HTTP/1.1\" 200 18920", time: new Date(Date.now() - 29_000).toISOString() },
  { id: "l7", stream: "stdout", text: "course-reminder | INFO: 192.168.1.5:51234 - \"GET /health HTTP/1.1\" 200 OK", time: new Date(Date.now() - 12_000).toISOString() },
];

const mockTasks: TaskItem[] = [
  { id: "t1", kind: "pull", title: "拉取镜像 searxng/searxng:latest", status: "success", progress: 100, detail: "完成 · 180 MB", startedAt: new Date(Date.now() - 3600_000).toISOString(), finishedAt: new Date(Date.now() - 3500_000).toISOString() },
  { id: "t2", kind: "connect", title: "连接 香港 VPS (root@160.202.46.104)", status: "success", progress: 100, detail: "会话已建立", startedAt: new Date(Date.now() - 1800_000).toISOString(), finishedAt: new Date(Date.now() - 1798_000).toISOString() },
  { id: "t3", kind: "pull", title: "拉取镜像 postgres:16-alpine", status: "running", progress: 62, detail: "112 MB / 180 MB · 8.4 MB/s", startedAt: new Date(Date.now() - 45_000).toISOString() },
];

const TABS = [
  { id: "logs" as const, label: "日志流", icon: TerminalSquare },
  { id: "events" as const, label: "事件流", icon: Radio },
  { id: "tasks" as const, label: "任务队列", icon: ListTodo },
];

/** Bottom dockable panel — logs / events / tasks */
export function BottomDock() {
  const { bottomPanel, setBottomPanel } = useWorkspace();
  const [events, setEvents] = useState<DockerEventItem[]>([]);
  const [paused, setPaused] = useState(false);
  const logsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    startMockStreams();
    const un = onEvent<{ events: DockerEventItem[] }>("docker:events", (payload) => {
      if (!paused) setEvents((e) => [...payload.events, ...e].slice(0, 200));
    });
    return () => {
      un.then((fn) => fn());
    };
  }, [paused]);

  useEffect(() => {
    logsRef.current?.scrollTo({ top: logsRef.current.scrollHeight });
  }, []);

  if (!bottomPanel.open) return null;

  const time = (iso: string) => new Date(iso).toLocaleTimeString("zh-CN", { hour12: false });

  return (
    <div
      className="flex shrink-0 flex-col border-t border-border-subtle bg-panel"
      style={{ height: bottomPanel.height }}
    >
      {/* Dock header */}
      <div className="flex h-8 shrink-0 items-center justify-between border-b border-border-subtle px-2">
        <div className="flex items-center gap-0.5">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setBottomPanel({ tab: id })}
              className={cn(
                "flex h-6 items-center gap-1.5 rounded-md px-2 text-[12px] transition-colors",
                bottomPanel.tab === id
                  ? "bg-active-fill text-foreground"
                  : "text-secondary hover:bg-hover-fill"
              )}
            >
              <Icon className="h-3 w-3" />
              {label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-0.5">
          {bottomPanel.tab === "events" && (
            <button
              onClick={() => setPaused((p) => !p)}
              className="flex h-6 w-6 items-center justify-center rounded-md text-secondary hover:bg-hover-fill"
              title={paused ? "继续滚动" : "暂停滚动"}
            >
              {paused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
            </button>
          )}
          <button
            onClick={() => setBottomPanel({ open: false })}
            className="flex h-6 w-6 items-center justify-center rounded-md text-quaternary hover:bg-hover-fill hover:text-secondary"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Dock body */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {bottomPanel.tab === "logs" && (
          <div ref={logsRef} className="select-text-all h-full overflow-y-auto px-3 py-1.5 font-mono text-[12px] leading-[1.6]">
            {mockLogs.map((l) => (
              <div key={l.id} className="flex gap-2">
                <span className="shrink-0 text-quaternary">{time(l.time)}</span>
                <span className={cn("shrink-0", l.stream === "stderr" ? "text-danger" : l.stream === "system" ? "text-accent" : "text-muted")}>
                  {l.stream === "stdout" ? "OUT" : l.stream === "stderr" ? "ERR" : "SYS"}
                </span>
                <span className="whitespace-pre-wrap break-all text-secondary">{l.text}</span>
              </div>
            ))}
          </div>
        )}

        {bottomPanel.tab === "events" && (
          <div className="h-full overflow-y-auto px-3 py-1.5 font-mono text-[12px] leading-[1.6]">
            {events.length === 0 && <div className="pt-4 text-center text-muted">等待事件流…</div>}
            {events.map((e) => (
              <div key={e.id} className="flex gap-2">
                <span className="shrink-0 text-quaternary">{time(e.time)}</span>
                <span className="w-16 shrink-0 text-muted">{e.type}</span>
                <span className={cn("w-16 shrink-0", e.action.includes("die") || e.action.includes("destroy") ? "text-danger" : "text-success")}>
                  {e.action}
                </span>
                <span className="truncate text-secondary">{e.actor}</span>
                <span className="ml-auto shrink-0 text-quaternary">{e.hostName}</span>
              </div>
            ))}
          </div>
        )}

        {bottomPanel.tab === "tasks" && (
          <div className="h-full overflow-y-auto px-3 py-2">
            {mockTasks.map((t) => (
              <div key={t.id} className="mb-2 rounded-lg border border-border-subtle bg-surface px-3 py-2">
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      "dot shrink-0",
                      t.status === "running" && "animate-pulse bg-accent",
                      t.status === "success" && "bg-success",
                      t.status === "error" && "bg-danger"
                    )}
                  />
                  <span className="truncate text-[12.5px] text-foreground">{t.title}</span>
                  <span className={cn("ml-auto shrink-0 text-[11px]", t.status === "running" ? "text-accent" : t.status === "success" ? "text-success" : "text-danger")}>
                    {t.status === "running" ? `${t.progress}%` : t.status === "success" ? "完成" : "失败"}
                  </span>
                </div>
                {t.status === "running" && <Progress value={t.progress} className="mt-1.5" />}
                {t.detail && <div className="mt-1 mono-caption text-quaternary">{t.detail}</div>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
