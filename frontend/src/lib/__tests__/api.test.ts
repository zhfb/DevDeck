import { describe, it, expect, beforeAll } from "vitest";
import { invoke } from "@/lib/api";

// mock 模式（非 Tauri 运行时）下 invoke 走 mockHandlers，
// 这些测试用于锁定后端命令与前端 mock 之间的一致性。
describe("api mock handlers（与真实命令对齐）", () => {
  beforeAll(() => {
    // 确保以 mock 模式运行（jsdom 无 __TAURI_INTERNALS__）
    expect(typeof window).toBe("object");
    expect("__TAURI_INTERNALS__" in window).toBe(false);
  });

  it("local_shell_start 返回会话 id", async () => {
    const id = await invoke<string>("local_shell_start", { cols: 100, rows: 30 });
    expect(id).toMatch(/^local-mock-/);
  });

  it("local_shell_stop 返回成功", async () => {
    const r = await invoke("local_shell_stop", { sessionId: "x" });
    expect(r).toEqual({ ok: true });
  });

  it("sudo_config.get 默认开启", async () => {
    const enabled = await invoke<boolean>("sudo_config_get");
    expect(enabled).toBe(true);
  });

  it("sudo_config.set 返回成功", async () => {
    await expect(invoke("sudo_config_set", { enabled: false })).resolves.toBeTruthy();
  });

  it("registry_repos 返回仓库列表（含 UCloud 示例）", async () => {
    const repos = await invoke<{ name: string; tags?: string[] }[]>("registry_repos", {
      id: "reg-ucloud",
    });
    expect(Array.isArray(repos)).toBe(true);
    expect(repos.length).toBeGreaterThan(0);
    expect(repos[0]).toHaveProperty("name");
    expect(repos[0].tags).toContain("latest");
  });

  it("idle_lock_config.get 返回配置对象", async () => {
    const cfg = await invoke<{
      enabled: boolean;
      timeoutMinutes: number;
      hasPin: boolean;
    }>("idle_lock_config_get");
    expect(cfg).toHaveProperty("enabled");
    expect(cfg).toHaveProperty("timeoutMinutes");
  });

  it("未知命令抛错而非静默返回", async () => {
    await expect(invoke("no_such_command")).rejects.toBeTruthy();
  });
});
