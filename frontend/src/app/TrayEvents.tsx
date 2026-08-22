import { useEffect } from "react";
import { onEvent } from "@/lib/api";

/**
 * TrayEvents — macOS 托盘事件桥（P0）。
 *
 * 监听后端托盘菜单发出的统一事件 `tray:action`，并将动作转发为全局
 * CustomEvent，供父组件消费（零耦合，不直接依赖 workspace store）：
 *
 *   - `devdeck:new-ssh`      托盘『新建 SSH 连接』
 *   - `devdeck:engine-status` 托盘『本地引擎状态』
 *
 * 集成方式（在 App 中挂载一次，无需 props）：
 *
 *   <TrayEvents />
 *
 * 消费方示例（如打开 SSH 主机面板或新建连接对话框）：
 *
 *   window.addEventListener("devdeck:new-ssh", () => {
 *     useWorkspace.getState().openTab({
 *       kind: "panel", panel: "hosts", title: "SSH 主机", env: "none",
 *     });
 *   });
 *
 * 组件返回 null，不产生任何 DOM。
 */
export default function TrayEvents() {
  useEffect(() => {
    let unlisten: (() => void) | undefined;

    void onEvent<{ action?: string }>("tray:action", (payload) => {
      const action = payload?.action;
      if (action === "new-ssh") {
        window.dispatchEvent(new CustomEvent("devdeck:new-ssh"));
      } else if (action === "engine-status") {
        window.dispatchEvent(new CustomEvent("devdeck:engine-status"));
      }
    }).then((un) => {
      unlisten = un;
    });

    return () => {
      unlisten?.();
    };
  }, []);

  return null;
}
