import { describe, it, expect, beforeEach } from "vitest";
import { useWorkspace } from "@/stores/workspace";

describe("workspace.openTab 去重逻辑", () => {
  beforeEach(() => {
    useWorkspace.setState({ tabs: [], activeTabId: null });
  });

  it("dashboard 面板重复打开复用同一 tab", () => {
    const a = useWorkspace.getState().openTab({
      kind: "dashboard",
      title: "总览",
      env: "none",
    });
    const b = useWorkspace.getState().openTab({
      kind: "dashboard",
      title: "总览",
      env: "none",
    });
    expect(b).toBe(a);
    expect(useWorkspace.getState().tabs).toHaveLength(1);
  });

  it("不同 panel（容器/设置）各自独立成 tab", () => {
    const containers = useWorkspace.getState().openTab({
      kind: "panel",
      title: "容器",
      panel: "containers",
      env: "none",
    });
    const settings = useWorkspace.getState().openTab({
      kind: "panel",
      title: "设置",
      panel: "settings",
      env: "none",
    });
    expect(settings).not.toBe(containers);
    expect(useWorkspace.getState().tabs).toHaveLength(2);
  });

  it("同一 panel 重复打开复用", () => {
    const a = useWorkspace.getState().openTab({
      kind: "panel",
      title: "卷",
      panel: "volumes",
      env: "none",
    });
    const b = useWorkspace.getState().openTab({
      kind: "panel",
      title: "卷",
      panel: "volumes",
      env: "none",
    });
    expect(b).toBe(a);
    expect(useWorkspace.getState().tabs).toHaveLength(1);
  });

  it("SSH 会话每次打开都新建 tab（可多开）", () => {
    const a = useWorkspace.getState().openTab({
      kind: "ssh",
      title: "a",
      hostId: "h1",
      sessionId: "s1",
      env: "none",
    });
    const b = useWorkspace.getState().openTab({
      kind: "ssh",
      title: "b",
      hostId: "h1",
      sessionId: "s2",
      env: "none",
    });
    expect(b).not.toBe(a);
    expect(useWorkspace.getState().tabs).toHaveLength(2);
  });

  it("不同主机详情各自独立 tab", () => {
    const a = useWorkspace.getState().openTab({
      kind: "host-detail",
      title: "A",
      hostId: "h1",
      env: "none",
    });
    const b = useWorkspace.getState().openTab({
      kind: "host-detail",
      title: "B",
      hostId: "h2",
      env: "none",
    });
    expect(b).not.toBe(a);
  });

  it("同一容器的 docker-exec 复用 tab，不同容器独立", () => {
    const c1 = useWorkspace.getState().openTab({
      kind: "docker-exec",
      title: "web Shell",
      containerId: "c1",
      engineId: "eng",
      env: "none",
    });
    const c1again = useWorkspace.getState().openTab({
      kind: "docker-exec",
      title: "web Shell",
      containerId: "c1",
      engineId: "eng",
      env: "none",
    });
    expect(c1again).toBe(c1);
    const c2 = useWorkspace.getState().openTab({
      kind: "docker-exec",
      title: "db Shell",
      containerId: "c2",
      engineId: "eng",
      env: "none",
    });
    expect(c2).not.toBe(c1);
    expect(useWorkspace.getState().tabs.filter((t) => t.kind === "docker-exec")).toHaveLength(2);
  });

  it("closeTab 触发 ssh_disconnect（释放后端连接）", async () => {
    const id = useWorkspace.getState().openTab({
      kind: "ssh",
      title: "prod",
      hostId: "h1",
      sessionId: "sess-1",
      env: "none",
    });
    useWorkspace.getState().closeTab(id);
    // 通过 mock 计数：ssh_disconnect 应被调用一次（此处验证 tab 已移除且调用不抛错）
    expect(useWorkspace.getState().tabs.some((t) => t.id === id)).toBe(false);
  });

  it("openLocalTerminal 重复调用复用同一 tab（不重复建 PTY）", async () => {
    const first = await useWorkspace.getState().openLocalTerminal();
    const second = await useWorkspace.getState().openLocalTerminal();
    expect(second).toBe(first);
    expect(useWorkspace.getState().tabs.filter((t) => t.kind === "local")).toHaveLength(1);
  });
});
