import { describe, it, expect, beforeAll } from "vitest";
import { invoke, mockHandlers } from "@/lib/api";

// 后端命令名清单：与 src-tauri/src/lib.rs 中 tauri::generate_handler![...] 一一对应。
// 若后端命令改名/新增，必须同步此清单，否则测试失败——防止“mock 正常但真实运行断接口”
// 的命名漂移回归（review Important）。
const BACKEND_COMMANDS: readonly string[] = [
  "app_info", "power_state_get", "power_state_set", "updater_check", "updater_install",
  "sftp_list", "sftp_mkdir", "sftp_remove", "sftp_rename", "sftp_transfer",
  "sftp_transfer_cancel", "sftp_transfer_batch", "local_fs_list", "engines_list",
  "embedded_status", "embedded_start", "embedded_stop", "embedded_reset",
  "hosts_list", "hosts_groups", "hosts_stats", "hosts_stats_history", "hosts_save", "hosts_delete",
  "containers_list", "containers_get", "containers_start", "containers_stop",
  "containers_restart", "containers_pause", "containers_unpause", "containers_remove",
  "containers_exec", "containers_logs", "containers_create",
  "images_list", "images_pull", "images_remove",
  "registries_list", "registries_save", "registries_delete", "registry_ping",
  "registry_repos", "registry_tags",
  "config_export", "config_import",
  "idle_lock_config_get", "idle_lock_config_set", "idle_lock_unlock",
  "local_shell_start", "local_shell_stop",
  "sudo_config_get", "sudo_config_set",
  "volumes_list", "volumes_create", "volumes_remove",
  "networks_list", "networks_create", "networks_remove",
  "host_processes", "snippets_list", "snippets_save", "snippets_delete",
  "tunnels_list", "tunnels_save", "tunnels_delete", "tunnels_start", "tunnels_stop",
  "ssh_connect", "ssh_reconnect", "ssh_disconnect", "ssh_sessions",
  "ssh_host_key_decide", "ssh_known_hosts_forget", "ssh_auth_respond", "ssh_broadcast",
  "auto_forward_set", "auto_forward_get",
  "compose_run", "compose_ps",
  "remote_docker_mount", "remote_docker_unmount", "remote_docker_list_mounts",
  "remote_docker_containers", "remote_docker_images",
  "zmodem_upload", "zmodem_download",
  "term_input", "term_resize",
];

// mock 模式（非 Tauri 运行时）下 invoke 走 mockHandlers，
// 这些测试用于锁定后端命令与前端 mock 之间的一致性。
describe("api mock handlers（与真实命令对齐）", () => {
  beforeAll(() => {
    // 确保以 mock 模式运行（jsdom 无 __TAURI_INTERNALS__）
    expect(typeof window).toBe("object");
    expect("__TAURI_INTERNALS__" in window).toBe(false);
  });

  it("每个 mock handler 命令名都存在于后端命令清单中", () => {
    const mockKeys = Object.keys(mockHandlers);
    expect(mockKeys.length).toBeGreaterThan(0);
    for (const key of mockKeys) {
      expect(BACKEND_COMMANDS, `mock handler "${key}" 不在后端命令清单中，请同步 lib.rs 或改回原名`).toContain(key);
    }
  });

  it("后端命令清单无重复", () => {
    const dup = BACKEND_COMMANDS.filter((c, i) => BACKEND_COMMANDS.indexOf(c) !== i);
    expect(dup).toEqual([]);
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
