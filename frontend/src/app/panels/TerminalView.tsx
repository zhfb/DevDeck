import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { isTauri, onEvent, invoke } from "@/lib/api";
import type { SshSession } from "@/lib/types";
interface TerminalViewProps {
  sessionId?: string;
  hostId?: string;
  containerId?: string;
  engineId?: string;
  kind?: string;
  title: string;
  env?: string;
}

/**
 * Terminal pane. In Tauri mode: attaches to the Rust SSH session via events
 * (`term:data:<sessionId>` out, `term:input:<sessionId>` in). In browser mock
 * mode: renders a local demo shell so the UI is explorable.
 */
export function TerminalView({ sessionId, hostId, containerId, engineId, kind = "ssh", title, env }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let term: Terminal | null = null;
    let ro: ResizeObserver | null = null;
    try {
      term = new Terminal({
        fontFamily:
          'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Monaco, "Cascadia Code", monospace',
        fontSize: 12.5,
        lineHeight: 1.35,
        cursorBlink: true,
        cursorStyle: "block",
        scrollback: 10000,
        theme: {
          background: "#0b0d0f",
          foreground: "#e8eaed",
          cursor: "#0a84ff",
          cursorAccent: "#0b0d0f",
          selectionBackground: "rgba(10,132,255,0.25)",
          black: "#1c2126",
          red: "#ff453a",
          green: "#30d158",
          yellow: "#ffd60a",
          blue: "#0a84ff",
          magenta: "#bf5af2",
          cyan: "#5ac8fa",
          white: "#e8eaed",
          brightBlack: "#7c838d",
          brightRed: "#ff6961",
          brightGreen: "#30d158",
          brightYellow: "#ffd60a",
          brightBlue: "#3a9bff",
          brightMagenta: "#da8fff",
          brightCyan: "#5ac8fa",
          brightWhite: "#ffffff",
        },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      try {
        term.loadAddon(new WebglAddon());
      } catch {
        /* WebGL unavailable — fall back to canvas/dom renderer */
      }
      term.open(el);
      termRef.current = term;

      // Fit after the layout settles — a freshly split pane's container can
      // still be 0-sized when the component mounts, which makes fit() throw
      // and leaves a black terminal until the next input. Retry with backoff
      // until the container reports a real size (Tabby does the same guard).
      const doFit = (attempt = 0) => {
        if (disposed) return;
        try {
          if (el.offsetWidth > 0 && el.offsetHeight > 0) {
            fit.fit();
          } else if (attempt < 5) {
            setTimeout(() => doFit(attempt + 1), 80 * (attempt + 1));
          }
        } catch {
          if (attempt < 5) setTimeout(() => doFit(attempt + 1), 120 * (attempt + 1));
        }
      };
      requestAnimationFrame(() => doFit());

      ro = new ResizeObserver(() => {
        try {
          fit.fit();
        } catch {
          /* container hidden — ignore */
        }
      });
      ro.observe(el);
    } catch (e) {
      console.error("[TerminalView] init failed:", e);
      return;
    }

    // Tauri mode: wire real SSH or Docker exec session — Rust emits `term:data:<sid>`,
    // input/resize go back via term_input / term_resize commands.
    let unsub: (() => void) | undefined;
    let unsubStatus: (() => void) | undefined;
    let disposed = false;
    if (isTauri && sessionId) {
      onEvent<string>(`term:data:${sessionId}`, (text) => {
        if (!disposed && term) term.write(text);
      }).then((u) => (unsub = u));
      term.onData((d) => {
        void invoke("term_input", { sessionId, data: d }).catch(() => {});
      });
      term.onResize(({ cols, rows }) => {
        void invoke("term_resize", { sessionId, cols, rows }).catch(() => {});
      });

      if (kind === "docker-exec") {
        if (!engineId || !containerId) {
          term.writeln("\r\n\x1b[31m--- 容器 exec 缺少引擎或容器信息 ---\x1b[0m");
        } else {
          void invoke("containers_exec", { engineId, containerId, sessionId }).catch((e) => {
            if (!disposed && term) term.writeln(`\r\n\x1b[31m--- exec 启动失败：${String(e)} ---\x1b[0m`);
          });
        }
      }

      // Auto-reconnect: on ssh:status disconnected (network drop detected by
      // keepalive), show a notice, then reconnect with the same session id.
      // If the network is still down, retry with exponential backoff
      // (3s → 6s → 12s → 30s cap) until it succeeds or the pane unmounts.
      onEvent<SshSession>("ssh:status", (s) => {
        if (kind !== "ssh") return;
        if (disposed || !term || s.sessionId !== sessionId) return;
        if (s.status === "disconnected") {
          term.writeln("\r\n\x1b[33m--- 连接断开，3 秒后自动重连 ---\x1b[0m");
          const tryReconnect = (attempt: number) => {
            if (disposed || !term) return;
            invoke("ssh_reconnect", {
              sessionId,
              hostId,
              cols: term.cols,
              rows: term.rows,
            })
              .then(() => {
                if (!disposed && term) term.writeln("\x1b[32m--- 已重连 ---\x1b[0m");
              })
              .catch((e) => {
                if (disposed || !term) return;
                const delay = Math.min(3000 * 2 ** attempt, 30000);
                term.writeln(
                  `\x1b[31m--- 重连失败（第 ${attempt + 1} 次）：${String(e).slice(0, 80)}，` +
                    `${Math.round(delay / 1000)} 秒后重试 ---\x1b[0m`
                );
                window.setTimeout(() => tryReconnect(attempt + 1), delay);
              });
          };
          window.setTimeout(() => tryReconnect(0), 3000);
        }
      }).then((u) => (unsubStatus = u));
    } else {
      // Mock demo shell
      let buf = "";
      term.writeln("\x1b[90m┌──────────────────────────────────────────────┐");
      term.writeln("\x1b[90m│  DevDeck 演示终端 · Mock 模式                 │");
      term.writeln("\x1b[90m│  连接 Tauri 后端后显示真实 SSH 会话           │");
      term.writeln("\x1b[90m└──────────────────────────────────────────────┘\x1b[0m");
      term.write(`\r\n\x1b[32m${env === "prod" ? "prod" : "dev"}@devdeck\x1b[0m:\x1b[34m~\x1b[0m$ `);
      term.onData((d) => {
        if (d === "\r") {
          term.write("\r\n");
          if (buf.trim() === "clear" || buf.trim() === "cls") {
            term.clear();
          } else if (buf.trim() === "help") {
            term.writeln(
              "\x1b[90m可用命令: help, clear, echo, docker ps, uname, exit\x1b[0m"
            );
          } else if (buf.trim() === "docker ps") {
            term.writeln(
              "CONTAINER ID   IMAGE                    STATUS        PORTS\n" +
                "a1b2c3d4e5f6   nginx:1.27-alpine         Up 3 days     0.0.0.0:8080->80/tcp\n" +
                "f6e5d4c3b2a1   postgres:16-alpine        Up 3 days     127.0.0.1:5432->5432/tcp"
            );
          } else if (buf.trim() === "uname -a") {
            term.writeln("Darwin zhfb-mac.local 26.6.1 Darwin Kernel (arm64) — DevDeck mock");
          } else if (buf.trim() === "exit") {
            term.writeln("\x1b[90m会话已关闭（演示）\x1b[0m");
          } else if (buf.trim().startsWith("echo ")) {
            term.writeln(buf.slice(5));
          } else if (buf.trim() !== "") {
            term.writeln(`\x1b[90mzsh: command not found: ${buf.trim()} (mock)\x1b[0m`);
          }
          buf = "";
          term.write(`\x1b[32m${env === "prod" ? "prod" : "dev"}@devdeck\x1b[0m:\x1b[34m~\x1b[0m$ `);
        } else if (d === "\u007f") {
          if (buf.length > 0) {
            buf = buf.slice(0, -1);
            term.write("\b \b");
          }
        } else if (d >= " " && d !== "\u001b") {
          buf += d;
          term.write(d);
        }
      });
    }

    return () => {
      disposed = true;
      ro?.disconnect();
      unsub?.();
      unsubStatus?.();
      try {
        term.dispose();
      } catch {
        /* already disposed */
      }
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  return <div ref={containerRef} className="xterm-pane h-full w-full" />;
}
