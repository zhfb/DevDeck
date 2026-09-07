import { useEffect, useMemo, useState } from "react";
import { Command } from "cmdk";
import { Search, Terminal, Boxes, Monitor, Waypoints, Sun, Moon, LayoutDashboard, Server, Layers, Activity, Settings, Sparkles, Loader2 } from "lucide-react";
import { useUi } from "@/stores/workspace";
import { usePalette, useConnect, useLive } from "@/stores/live";
import { useWorkspace } from "@/stores/workspace";
import { useHosts, useContainers, useEngines } from "@/lib/queries";
import { invoke } from "@/lib/api";
import { aiChat, extractJson, isAiConfigured } from "@/lib/ai";
import type { Host } from "@/lib/types";
import { cn } from "@/lib/utils";
import { toast } from "@/components/ui/sonner";
import type { NavPanelId } from "./NavRail";

const PANEL_ICONS: Record<string, React.ElementType> = {
  dashboard: LayoutDashboard,
  hosts: Server,
  containers: Boxes,
  images: Layers,
  tunnels: Waypoints,
  monitor: Activity,
  settings: Settings,
};

/** AI 安全动作：只能映射到既有受控操作，AI 永远不能执行任意 shell */
interface AiAction {
  action:
    | "open_panel"
    | "connect_host"
    | "open_container"
    | "restart_container"
    | "stop_container"
    | "start_container"
    | "docker_logs";
  panel?: string;
  name?: string;
  reason?: string;
}

const AI_ACTION_LABEL: Record<string, string> = {
  open_panel: "打开面板",
  connect_host: "连接主机",
  open_container: "打开容器",
  restart_container: "重启容器",
  stop_container: "停止容器",
  start_container: "启动容器",
  docker_logs: "查看容器日志",
};

/** Cmd+K global command palette — search hosts/containers/actions + AI 自然语言操作 */
export function CommandPalette({ onOpenPanel }: { onOpenPanel: (p: NavPanelId) => void }) {
  const { commandPaletteOpen, setCommandPaletteOpen, toggleTheme } = useUi();
  const { openTab, tabs, setActiveTab } = useWorkspace();
  const openConnect = useConnect((s) => s.openConnect);
  const sessions = useLive((s) => s.sessions);
  const { actions } = usePalette();
  const { data: hosts } = useHosts();
  const { data: containers } = useContainers();
  const { data: engines } = useEngines();

  // AI 模式状态
  const [query, setQuery] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiResults, setAiResults] = useState<AiAction[]>([]);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiAsked, setAiAsked] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        useUi.getState().toggleCommandPalette();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 关闭时重置 AI 状态
  useEffect(() => {
    if (!commandPaletteOpen) {
      setQuery("");
      setAiResults([]);
      setAiError(null);
      setAiAsked(false);
      setAiLoading(false);
    }
  }, [commandPaletteOpen]);

  const connectHost = (host: Host) => {
    openConnect({ hostId: host.id, hostName: host.name, address: host.address, user: host.user });
    setCommandPaletteOpen(false);
  };

  const runAi = async (instruction: string) => {
    if (!isAiConfigured()) {
      setAiError("AI 未配置：请到 设置 → AI 助手 填写 Base URL / API Key / 模型");
      setAiAsked(true);
      return;
    }
    setAiLoading(true);
    setAiError(null);
    setAiResults([]);
    setAiAsked(true);
    const hostNames = (hosts ?? []).map((h) => h.name).join("、") || "（无）";
    const containerNames =
      (containers ?? []).map((c) => `${c.name}(${c.state})`).join("、") || "（无）";
    try {
      const reply = await aiChat([
        {
          role: "system",
          content:
            "你是 DevDeck（macOS 原生 SSH/SFTP/Docker 工作台）的操作代理。用户用自然语言提出操作请求，你把它翻译成受支持的动作列表。" +
            `可用的主机：${hostNames}。可用的容器：${containerNames}。` +
            '只允许输出一个 JSON 对象（不要 markdown 围栏、不要解释）：{"actions":[{"action":"open_panel","panel":"containers","reason":"简短说明"}]}。' +
            "支持的 action：open_panel（panel ∈ dashboard|hosts|containers|images|volumes|networks|tunnels|compose|monitor|tasks|settings）；" +
            "connect_host（name=主机名，必须来自可用主机）；open_container / restart_container / stop_container / start_container / docker_logs（name=容器名，必须来自可用容器）。" +
            '若请求无法映射到任何动作，返回 {"actions":[]}。',
        },
        { role: "user", content: instruction },
      ]);
      const parsed = extractJson<{ actions?: AiAction[] }>(reply);
      setAiResults(parsed?.actions ?? []);
      if (!parsed) {
        setAiError("AI 返回格式无法解析，请重试或换模型");
      } else if (parsed.actions?.length === 0) {
        setAiError("没能把这条指令映射为可执行动作，换个说法试试");
      }
    } catch (e) {
      setAiError(String(e));
    } finally {
      setAiLoading(false);
    }
  };

  const findContainer = (name: string) =>
    (containers ?? []).find((c) => c.name.includes(name) || name.includes(c.name));

  const runAiAction = (a: AiAction) => {
    const label = AI_ACTION_LABEL[a.action] ?? a.action;
    const finish = (msg: string) => {
      toast.success(msg);
      setCommandPaletteOpen(false);
    };
    switch (a.action) {
      case "open_panel": {
        const p = a.panel as NavPanelId;
        if (p) {
          onOpenPanel(p);
          finish(`已打开 ${label}：${p}`);
        }
        break;
      }
      case "connect_host": {
        const h = (hosts ?? []).find((x) => x.name.includes(a.name ?? "") || (a.name ?? "").includes(x.name));
        if (h) {
          connectHost(h);
        } else {
          toast.error(`未找到主机：${a.name}`);
        }
        break;
      }
      case "open_container":
      case "docker_logs": {
        const c = findContainer(a.name ?? "");
        if (c) {
          openTab({
            kind: "container-detail",
            title: c.name,
            containerId: c.id,
            engineId: c.engineId,
            env: "none",
          });
          finish(`${label}：${c.name}`);
        } else {
          toast.error(`未找到容器：${a.name}`);
        }
        break;
      }
      case "restart_container":
      case "stop_container":
      case "start_container": {
        const c = findContainer(a.name ?? "");
        if (!c) {
          toast.error(`未找到容器：${a.name}`);
          break;
        }
        const op = a.action.replace("_container", "");
        void invoke(`containers_${op}`, { engineId: c.engineId, id: c.id })
          .then(() => finish(`${label}：${c.name}`))
          .catch((e) => toast.error(`${label}失败`, { description: String(e) }));
        break;
      }
      default:
        break;
    }
  };

  const items = useMemo(() => {
    const list: { id: string; group: string; title: string; keywords?: string; icon: React.ReactNode; onSelect: () => void }[] = [
      ...(hosts ?? []).map((h) => ({
        id: `host-${h.id}`,
        group: "主机",
        title: h.name,
        keywords: `${h.user}@${h.address} ssh`,
        icon: <Server className="h-3.5 w-3.5" />,
        onSelect: () => connectHost(h),
      })),
      ...(containers ?? []).map((c) => ({
        id: `container-${c.id}`,
        group: "容器",
        title: c.name,
        keywords: `${c.image} docker exec`,
        icon: <Boxes className="h-3.5 w-3.5" />,
        onSelect: () => {
          openTab({ kind: "container-detail", title: c.name, containerId: c.id, engineId: c.engineId, env: "none" });
          setCommandPaletteOpen(false);
        },
      })),
      ...(engines ?? []).map((e) => ({
        id: `engine-${e.id}`,
        group: "引擎",
        title: e.name,
        keywords: `${e.kind} docker socket`,
        icon: <Monitor className="h-3.5 w-3.5" />,
        onSelect: () => {
          onOpenPanel("containers");
          setCommandPaletteOpen(false);
        },
      })),
      ...actions.map((a) => ({
        id: a.id,
        group: a.group,
        title: a.title,
        keywords: a.keywords,
        icon: <Terminal className="h-3.5 w-3.5" />,
        onSelect: () => {
          a.run();
          setCommandPaletteOpen(false);
        },
      })),
      // SSH 会话：一键切换到对应终端标签
      ...Object.entries(sessions).map(([sessionId, s]) => {
        const tab = tabs.find(
          (t) => t.sessionId === sessionId || t.panes?.some((p) => p.sessionId === sessionId)
        );
        const statusLabel =
          s.status === "connected" ? "已连接" : s.status === "reconnecting" ? "重连中" : s.status === "connecting" ? "连接中" : s.status;
        return {
          id: `session-${sessionId}`,
          group: "SSH 会话",
          title: tab?.title ?? s.title ?? s.hostId,
          keywords: `ssh 会话 ${statusLabel} ${s.hostId}`,
          icon: (
            <Terminal
              className={cn(
                "h-3.5 w-3.5",
                s.status === "connected" ? "text-success" : s.status === "reconnecting" || s.status === "connecting" ? "text-warning" : "text-muted"
              )}
            />
          ),
          onSelect: () => {
            if (tab) {
              setActiveTab(tab.id);
              toast.success(`已切换到 ${tab.title}`);
            } else {
              toast.info("该会话对应标签已关闭");
            }
            setCommandPaletteOpen(false);
          },
        };
      }),
    ];
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hosts, containers, engines, actions, sessions, tabs]);

  if (!commandPaletteOpen) return null;

  const aiMode = query.trim().startsWith("/");
  const aiInstruction = query.trim().slice(1).trim();

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[15vh] backdrop-blur-[1px]"
      onClick={() => setCommandPaletteOpen(false)}
    >
      <div
        className="w-[560px] overflow-hidden rounded-xl border border-border bg-elevated shadow-[0_24px_64px_rgba(0,0,0,0.5)]"
        onClick={(e) => e.stopPropagation()}
      >
        <Command loop className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.04em] [&_[cmdk-group-heading]]:text-muted">
          <div className="flex items-center gap-2 border-b border-border-subtle px-3">
            {aiMode ? <Sparkles className="h-4 w-4 shrink-0 text-primary" /> : <Search className="h-4 w-4 shrink-0 text-muted" />}
            <Command.Input
              autoFocus
              value={query}
              onValueChange={setQuery}
              onKeyDown={(e) => {
                // AI 结果出现后放行 Enter 给 cmdk 执行选中项；
                // 仅在尚未请求 / 加载中 / 无结果时拦截 Enter 发起新请求
                if (
                  e.key === "Enter" &&
                  aiMode &&
                  aiInstruction &&
                  (!aiAsked || aiLoading || aiResults.length === 0)
                ) {
                  e.preventDefault();
                  void runAi(aiInstruction);
                }
              }}
              placeholder={aiMode ? "输入自然语言指令，如「重启 web 容器」…" : "搜索主机、容器、命令… 或以 / 开头用 AI 操作"}
              className="h-10 w-full bg-transparent text-[13.5px] text-foreground placeholder:text-quaternary focus:outline-none"
            />
            <kbd className="shrink-0 rounded border border-border-subtle bg-hover-fill px-1.5 py-0.5 text-[10px] text-muted">ESC</kbd>
          </div>

          {aiMode ? (
            <Command.List className="max-h-[320px] overflow-y-auto p-1.5">
              {!aiAsked && (
                <Command.Empty className="py-6 text-center text-[12.5px] text-muted">
                  <Sparkles className="mx-auto mb-1.5 h-4 w-4 text-primary" />
                  AI 模式：输入自然语言后按 Enter，例如「重启 web 容器」「连接香港VPS」「打开监控」
                </Command.Empty>
              )}
              {aiAsked && aiLoading && (
                <Command.Empty className="py-8 text-center text-[13px] text-muted">
                  <Loader2 className="mx-auto mb-2 h-4 w-4 animate-spin text-primary" />
                  正在理解指令…
                </Command.Empty>
              )}
              {aiAsked && !aiLoading && aiError && (
                <div className="px-4 py-6 text-center text-[12.5px] text-danger">{aiError}</div>
              )}
              {aiAsked && !aiLoading && !aiError && aiResults.length === 0 && !aiLoading && (
                <Command.Empty className="py-8 text-center text-[13px] text-muted">没有可执行的动作</Command.Empty>
              )}
              {aiAsked && !aiLoading && aiResults.length > 0 && (
                <Command.Group heading="AI 操作">
                  {aiResults.map((a, i) => (
                    <Command.Item
                      key={`${a.action}-${a.name ?? a.panel ?? i}`}
                      value={`AI ${a.action} ${a.name ?? a.panel ?? ""} ${a.reason ?? ""}`}
                      onSelect={() => runAiAction(a)}
                      className="flex cursor-default items-center gap-2.5 rounded-md px-2 py-2 text-[13px] text-secondary aria-selected:bg-active-fill aria-selected:text-foreground data-[selected=true]:bg-active-fill"
                    >
                      <span className="text-primary">
                        <Sparkles className="h-3.5 w-3.5" />
                      </span>
                      <span className="flex-1 truncate">
                        {AI_ACTION_LABEL[a.action] ?? a.action}
                        {a.name ? ` · ${a.name}` : a.panel ? ` · ${a.panel}` : ""}
                      </span>
                      {a.reason && <span className="truncate text-quaternary">{a.reason}</span>}
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
            </Command.List>
          ) : (
            <Command.List className="max-h-[320px] overflow-y-auto p-1.5">
              <Command.Empty className="py-8 text-center text-[13px] text-muted">无匹配结果</Command.Empty>
              {["主机", "SSH 会话", "容器", "引擎", ...Array.from(new Set(items.filter((i) => !["主机", "SSH 会话", "容器", "引擎"].includes(i.group)).map((i) => i.group)))].map(
                (group) => {
                  const groupItems = items.filter((i) => i.group === group);
                  if (!groupItems.length) return null;
                  return (
                    <Command.Group key={group} heading={group}>
                      {groupItems.map((i) => (
                        <Command.Item
                          key={i.id}
                          value={`${group} ${i.title} ${i.keywords ?? ""}`}
                          onSelect={i.onSelect}
                          className="flex cursor-default items-center gap-2.5 rounded-md px-2 py-2 text-[13px] text-secondary aria-selected:bg-active-fill aria-selected:text-foreground data-[selected=true]:bg-active-fill"
                        >
                          <span className="text-muted">{i.icon}</span>
                          <span className="flex-1 truncate">{i.title}</span>
                          <span className="mono-caption text-quaternary">{i.keywords?.split(" ")[0]}</span>
                        </Command.Item>
                      ))}
                    </Command.Group>
                  );
                }
              )}
            </Command.List>
          )}

          <div className="flex items-center gap-3 border-t border-border-subtle px-3 py-1.5 text-[10.5px] text-quaternary">
            <span><kbd className="text-muted">↑↓</kbd> 导航</span>
            <span><kbd className="text-muted">↵</kbd> 执行</span>
            <button
              onClick={toggleTheme}
              className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-quaternary hover:bg-hover-fill hover:text-secondary"
            >
              {useUi.getState().theme === "dark" ? <Sun className="h-3 w-3" /> : <Moon className="h-3 w-3" />}
              切换主题
            </button>
          </div>
        </Command>
      </div>
    </div>
  );
}
