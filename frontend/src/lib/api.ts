/**
 * DevDeck API layer — dual mode:
 *  - Inside Tauri: invoke() proxies to Rust commands, events via Tauri event bus.
 *  - Plain browser (vite dev): falls back to an in-memory mock store so the UI
 *    can be developed and previewed without the Rust backend.
 *
 * High-frequency streams (docker events, stats, logs) are pushed Rust→frontend
 * via events; low-frequency queries are request/response invoke commands.
 */
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  Container,
  DockerEngine,
  DockerEventItem,
  DockerImage,
  DockerNetwork,
  DockerVolume,
  EmbeddedStatus,
  Host,
  HostGroup,
  HostProcess,
  HostStats,
  HostStatsHistoryPoint,
  IdleLockConfig,
  RegistryConfig,
  Snippet,
  SshSession,
  Tunnel,
} from "./types";

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// ---------------------------------------------------------------------------
// invoke wrapper
// ---------------------------------------------------------------------------
export async function invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauri) {
    // Tauri v2 registers commands by snake_case fn name; the mock layer
    // uses dotted names ("hosts.list") for readability.
    return tauriInvoke<T>(cmd.replace(/\./g, "_"), args);
  }
  const handler = (mockHandlers as Record<string, (a: any) => T | Promise<T>>)[cmd];
  if (handler) return handler(args ?? {});
  throw new Error(`[mock] no handler for command: ${cmd}`);
}

// ---------------------------------------------------------------------------
// Event bus abstraction
// ---------------------------------------------------------------------------
export type EventCallback<T> = (payload: T) => void;

export async function onEvent<T>(event: string, cb: EventCallback<T>): Promise<() => void> {
  if (isTauri) {
    const un = await listen<T>(event, (e) => cb(e.payload));
    return un;
  }
  return mockEvents.subscribe(event, cb as EventCallback<unknown>);
}

// ---------------------------------------------------------------------------
// Mock store — realistic sample data so the UI is fully explorable
// ---------------------------------------------------------------------------
const now = Date.now();
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();

/** mock password vault (browser mode only; real app uses Keychain) */
const mockPasswords = new Map<string, string>();

const mockEngines: DockerEngine[] = [
  {
    id: "eng-orb",
    name: "本地引擎",
    kind: "orbstack",
    endpoint: "~/.orbstack/run/docker.sock",
    version: "27.4.1",
    containers: 5,
    images: 14,
    reachable: true,
  },
];

const mockGroups: HostGroup[] = [
  { id: "g-dev", name: "Dev", env: "dev", color: "#30D158" },
  { id: "g-staging", name: "Staging", env: "staging", color: "#FFD60A" },
  { id: "g-prod", name: "Prod", env: "prod", color: "#FF453A" },
];

const mockHosts: Host[] = [
  {
    id: "h-ali-hk",
    name: "香港 VPS",
    address: "160.202.46.104",
    port: 22,
    user: "root",
    groupId: "g-prod",
    env: "prod",
    credentialRef: "keychain://h-ali-hk",
    fingerprint: "SHA256:Qf9…k2Mp",
    lastConnectedAt: iso(3600_000 * 3),
    createdAt: iso(86400_000 * 20),
  },
  {
    id: "h-dev-mac",
    name: "Mac mini",
    address: "192.168.1.20",
    port: 22,
    user: "dev",
    groupId: "g-dev",
    env: "dev",
    credentialRef: "keychain://h-dev-mac",
    lastConnectedAt: iso(3600_000 * 26),
    createdAt: iso(86400_000 * 15),
  },
];

const mockContainers: Container[] = [
  {
    id: "a1b2c3d4e5f60718293a",
    name: "nginx-gateway",
    image: "nginx:1.27-alpine",
    state: "running",
    status: "Up 3 days",
    engineId: "eng-orb",
    ports: [{ ip: "0.0.0.0", privatePort: 80, publicPort: 8080, type: "tcp" }],
    created: iso(86400_000 * 3),
    startedAt: iso(86400_000 * 3),
    command: "nginx -g daemon off;",
    cpuPercent: 0.4,
    memUsage: 8.5 * 1024 * 1024,
    memLimit: 512 * 1024 * 1024,
  },
  {
    id: "f6e5d4c3b2a10918273b",
    name: "postgres-16",
    image: "postgres:16-alpine",
    state: "running",
    status: "Up 3 days",
    engineId: "eng-orb",
    ports: [{ ip: "127.0.0.1", privatePort: 5432, publicPort: 5432, type: "tcp" }],
    created: iso(86400_000 * 5),
    startedAt: iso(86400_000 * 3),
    command: "docker-entrypoint.sh postgres",
    cpuPercent: 1.2,
    memUsage: 96 * 1024 * 1024,
    memLimit: 1024 * 1024 * 1024,
  },
  {
    id: "9d8c7b6a5f4e3d2c1b0a",
    name: "redis-cache",
    image: "redis:7-alpine",
    state: "running",
    status: "Up 3 days",
    engineId: "eng-orb",
    ports: [{ ip: "127.0.0.1", privatePort: 6379, publicPort: 6379, type: "tcp" }],
    created: iso(86400_000 * 5),
    startedAt: iso(86400_000 * 3),
    command: "redis-server",
    cpuPercent: 0.2,
    memUsage: 12 * 1024 * 1024,
    memLimit: 512 * 1024 * 1024,
  },
  {
    id: "3e2d1c0b9a8f7e6d5c4b",
    name: "course-reminder",
    image: "ghcr.io/zhfb/course-reminder:latest",
    state: "running",
    status: "Up 12 days",
    engineId: "eng-orb",
    ports: [{ ip: "0.0.0.0", privatePort: 8000, publicPort: 8000, type: "tcp" }],
    created: iso(86400_000 * 12),
    startedAt: iso(86400_000 * 12),
    command: "python main.py",
    cpuPercent: 0.6,
    memUsage: 48 * 1024 * 1024,
    memLimit: 256 * 1024 * 1024,
  },
  {
    id: "5a4b3c2d1e0f9a8b7c6d",
    name: "searxng",
    image: "searxng/searxng:latest",
    state: "paused",
    status: "Paused 2 hours",
    engineId: "eng-orb",
    ports: [{ ip: "127.0.0.1", privatePort: 8080, publicPort: 8080, type: "tcp" }],
    created: iso(86400_000 * 30),
    startedAt: iso(86400_000 * 10),
    command: "/usr/local/searxng/dockerfiles/docker-entrypoint.sh",
    cpuPercent: 0,
    memUsage: 120 * 1024 * 1024,
    memLimit: 1024 * 1024 * 1024,
  },
  {
    id: "7f6e5d4c3b2a10987f6e5",
    name: "grafana-old",
    image: "grafana/grafana:10.4.2",
    state: "exited",
    status: "Exited (0) 4 days ago",
    engineId: "eng-orb",
    ports: [{ ip: "127.0.0.1", privatePort: 3000, publicPort: 3000, type: "tcp" }],
    created: iso(86400_000 * 40),
    command: "/run.sh",
  },
];

const mockImages: DockerImage[] = [
  { id: "sha256:a1b2…c3", repoTag: "nginx:1.27-alpine", size: 42_000_000, created: iso(86400_000 * 30), engineId: "eng-orb" },
  { id: "sha256:d4e5…f6", repoTag: "postgres:16-alpine", size: 210_000_000, created: iso(86400_000 * 25), engineId: "eng-orb" },
  { id: "sha256:g7h8…i9", repoTag: "redis:7-alpine", size: 41_000_000, created: iso(86400_000 * 25), engineId: "eng-orb" },
  { id: "sha256:j1k2…l3", repoTag: "ghcr.io/zhfb/course-reminder:latest", size: 96_000_000, created: iso(86400_000 * 12), engineId: "eng-orb" },
  { id: "sha256:m4n5…o6", repoTag: "searxng/searxng:latest", size: 180_000_000, created: iso(86400_000 * 30), engineId: "eng-orb" },
  { id: "sha256:p7q8…r9", repoTag: "grafana/grafana:10.4.2", size: 280_000_000, created: iso(86400_000 * 40), engineId: "eng-orb" },
  { id: "sha256:s1t2…u3", repoTag: "hello-world:latest", size: 9_000_000, created: iso(86400_000 * 60), engineId: "eng-orb" },
  { id: "sha256:v4w5…x6", repoTag: "ubuntu:24.04", size: 78_000_000, created: iso(86400_000 * 90), engineId: "eng-orb" },
  { id: "sha256:y7z8…a9", repoTag: "<none>:<none>", size: 340_000_000, created: iso(86400_000 * 45), engineId: "eng-orb" },
];

const mockTunnels: Tunnel[] = [  {
    id: "tun-1",
    name: "docker.sock → 香港",
    type: "local",
    hostId: "h-ali-hk",
    listenAddr: "127.0.0.1",
    listenPort: 2375,
    remoteHost: "localhost",
    remotePort: 2375,
    status: "active",
    bytesIn: 12_400_000,
    bytesOut: 8_900_000,
    startedAt: iso(3600_000 * 5),
  },
  {
    id: "tun-2",
    name: "pg-admin",
    type: "local",
    hostId: "h-ali-hk",
    listenAddr: "127.0.0.1",
    listenPort: 15432,
    remoteHost: "localhost",
    remotePort: 5432,
    status: "active",
    bytesIn: 2_100_000,
    bytesOut: 9_700_000,
    startedAt: iso(3600_000 * 26),
  },
  {
    id: "tun-3",
    name: "searxng-remote",
    type: "remote",
    hostId: "h-ali-hk",
    listenAddr: "0.0.0.0",
    listenPort: 8081,
    remoteHost: "127.0.0.1",
    remotePort: 8080,
    status: "stopped",
  },
];

const mockVolumes: DockerVolume[] = [
  { id: "vol-data", name: "pgdata", engineId: "eng-orb", driver: "local", mountpoint: "/var/lib/docker/volumes/pgdata/_data", scope: "local" },
  { id: "vol-cache", name: "redis-cache-data", engineId: "eng-orb", driver: "local", mountpoint: "/var/lib/docker/volumes/redis-cache-data/_data", scope: "local" },
];

const mockNetworks: DockerNetwork[] = [
  { id: "nw-bridge", name: "bridge", engineId: "eng-orb", driver: "bridge", scope: "local", containers: 3 },
  { id: "nw-app", name: "app-net", engineId: "eng-orb", driver: "bridge", scope: "local", containers: 2 },
];

const mockRegistries: RegistryConfig[] = [
  {
    id: "reg-ucloud",
    name: "UCloud 镜像仓库",
    url: "https://uhub.service.ucloud.cn",
    username: "demo",
    credentialRef: null,
    insecure: false,
    isDockerHub: false,
    createdAt: iso(86400_000 * 10),
  },
];

const mockProcesses: HostProcess[] = [
  { hostId: "h-ali-hk", pid: 1, ppid: 0, user: "root", cpuPercent: 0.0, memPercent: 0.1, rssKb: 8_192, etime: "21:03:11", command: "/sbin/init" },
  { hostId: "h-ali-hk", pid: 1284, ppid: 1, user: "root", cpuPercent: 23.1, memPercent: 4.2, rssKb: 85_000, etime: "02:11:05", command: "nginx: worker process" },
  { hostId: "h-ali-hk", pid: 1830, ppid: 1, user: "postgres", cpuPercent: 1.8, memPercent: 9.4, rssKb: 192_000, etime: "02:11:05", command: "postgres -D /var/lib/postgresql/16/main" },
  { hostId: "h-ali-hk", pid: 2105, ppid: 1284, user: "root", cpuPercent: 0.4, memPercent: 1.1, rssKb: 22_000, etime: "02:10:58", command: "sshd: root@pts/0" },
];

const mockSnippets: Snippet[] = [
  { id: "sn-1", title: "查看磁盘占用", command: "df -h && echo --- && du -sh /* 2>/dev/null | sort -rh | head", tags: "磁盘,运维", createdAt: iso(86400_000 * 3) },
  { id: "sn-2", title: "Docker 清理悬空镜像", command: "docker image prune -af", tags: "docker,清理", createdAt: iso(86400_000 * 2) },
  { id: "sn-3", title: "查看最近日志", command: "journalctl -n 50 --no-pager", tags: "日志,排查", createdAt: iso(3600_000 * 20) },
];

const mockHostStats = new Map<string, HostStats>();
mockHostStats.set("h-ali-hk", {
  hostId: "h-ali-hk",
  cpuPercent: 23.4,
  memUsedBytes: 1.4 * 1024 ** 3,
  memTotalBytes: 2 * 1024 ** 3,
  diskUsedBytes: 18 * 1024 ** 3,
  diskTotalBytes: 40 * 1024 ** 3,
  loadAvg1: 0.42,
  uptimeSeconds: 86400 * 21,
  osRelease: "Ubuntu 22.04.5 LTS",
  kernel: "5.15.0-113-generic",
  sampledAt: new Date().toISOString(),
});
mockHostStats.set("h-dev-mac", {
  hostId: "h-dev-mac",
  cpuPercent: 8.1,
  memUsedBytes: 6.2 * 1024 ** 3,
  memTotalBytes: 16 * 1024 ** 3,
  diskUsedBytes: 320 * 1024 ** 3,
  diskTotalBytes: 512 * 1024 ** 3,
  loadAvg1: 1.1,
  uptimeSeconds: 86400 * 9,
  osRelease: "macOS 14.5",
  kernel: "23.5.0",
  sampledAt: new Date().toISOString(),
});

// history generator — deterministic-ish walk
function genHistory(hostId: string, points = 60): HostStatsHistoryPoint[] {
  const base = hostId === "h-ali-hk" ? 23 : 8;
  return Array.from({ length: points }, (_, i) => {
    const t = new Date(now - (points - i) * 60_000).toISOString();
    const wave = Math.sin(i / 6) * 6;
    const noise = ((i * 37) % 9) - 4;
    return { t, cpu: Math.max(0.5, base + wave + noise), memPercent: Math.max(10, 55 + wave * 0.8) };
  });
}

// ---------------------------------------------------------------------------
// Mock command handlers
// ---------------------------------------------------------------------------
export const mockHandlers: Record<string, (a: any) => unknown> = {
  "engines.list": async () => mockEngines,
  // 内置 Docker 引擎（浏览器 mock：模拟"未安装/未启动"，Tauri 里走真实 limactl）
  "embedded_status": async (): Promise<EmbeddedStatus> => ({
    installed: false,
    limactlVersion: null,
    machine: "devdeck",
    machineCreated: false,
    running: false,
    socket: "~/.lima/devdeck/sock/docker.sock",
    socketExists: false,
    engineConnected: false,
    dockerVersion: null,
    error: "浏览器模式下内置引擎不可用，请在 DevDeck 桌面应用中体验（需 brew install lima）",
  }),
  "embedded_start": async (): Promise<EmbeddedStatus> => ({
    installed: false,
    limactlVersion: null,
    machine: "devdeck",
    machineCreated: false,
    running: false,
    socket: "~/.lima/devdeck/sock/docker.sock",
    socketExists: false,
    engineConnected: false,
    dockerVersion: null,
    error: "浏览器模式下无法启动内置引擎",
  }),
  "embedded_stop": async (): Promise<EmbeddedStatus> => ({
    installed: true,
    limactlVersion: "2.2.0",
    machine: "devdeck",
    machineCreated: true,
    running: false,
    socket: "~/.lima/devdeck/sock/docker.sock",
    socketExists: false,
    engineConnected: false,
    dockerVersion: null,
    error: null,
  }),
  "embedded_reset": async (): Promise<EmbeddedStatus> => ({
    installed: true,
    limactlVersion: "2.2.0",
    machine: "devdeck",
    machineCreated: false,
    running: false,
    socket: "~/.lima/devdeck/sock/docker.sock",
    socketExists: false,
    engineConnected: false,
    dockerVersion: null,
    error: null,
  }),
  "hosts.list": async () => mockHosts,
  "hosts.groups": async () => mockGroups,
  "hosts.save": async ({ host, password }: { host: Host; password?: string | null }) => {
    await sleep(400);
    const exists = mockHosts.findIndex((h) => h.id === host.id);
    if (exists >= 0) mockHosts[exists] = host;
    else mockHosts.push(host);
    if (password) {
      // mock keeps it in-memory only — real app stores in Keychain
      mockPasswords.set(`${host.user}@${host.address}:${host.port}`, password);
    }
    return { ok: true };
  },
  "hosts.stats": async ({ hostId }: { hostId: string }) => mockHostStats.get(hostId) ?? null,
  "hosts.stats_history": async ({ hostId }: { hostId: string }) => genHistory(hostId),
  "containers.list": async ({ engineId }: { engineId?: string }) =>
    engineId ? mockContainers.filter((c) => c.engineId === engineId) : mockContainers,
  "containers.get": async ({ id }: { id: string }) => mockContainers.find((c) => c.id === id) ?? null,
  "images.list": async ({ engineId }: { engineId?: string }) =>
    engineId ? mockImages.filter((i) => i.engineId === engineId) : mockImages,
  "volumes.list": async () => mockVolumes,
  "networks.list": async () => mockNetworks,
  "registries.list": async () => mockRegistries,
  "registry.repos": async ({ id }: { id: string }) =>
    mockRegistries
      .filter((r) => r.id === id)
      .map((r) => {
        const host = r.url.replace(/^https?:\/\//, "").split(":")[0];
        return { name: `${host}/devdeck-demo`, tags: ["latest", "v1.0.0", "v1.1.0"] };
      }),
  "registry.tags": async () => ["latest", "v1.0.0", "v1.1.0"],
  "registry.ping": async () => "v2",
  "host.processes": async ({ hostId }: { hostId: string }) => mockProcesses.filter((p) => p.hostId === hostId),
  "snippets.list": async () => mockSnippets,
  "tunnels.list": async () => mockTunnels,
  "tunnels.get": async ({ id }: { id: string }) => mockTunnels.find((t) => t.id === id) ?? null,
  "ssh.sessions": async () => [] as SshSession[],
  "ssh_auth_respond": async () => ({ ok: true }),
  "ssh_broadcast": async ({ sessionIds }: { sessionIds: string[] }) => sessionIds.length,
  "auto_forward_set": async () => ({ ok: true }),
  "auto_forward_get": async () => null,
  "compose_run": async ({ args }: { args: string[] }) =>
    `mock: docker compose ${args.join(" ")}\n[+] Running 0/0\n ✔ Container demo  Started\n`,
  "compose_ps": async () => [
    { name: "web", state: "running", status: "Up 3 minutes" },
    { name: "db", state: "running", status: "Up 3 minutes" },
    { name: "redis", state: "exited", status: "Exited (0) 2 minutes ago" },
  ],
  "remote_docker_mount": async ({ hostId }: { hostId: string }) => ({
    hostId,
    socketPath: `/tmp/devdeck-docker-${hostId}.sock`,
    connected: true,
  }),
  "remote_docker_unmount": async () => ({ ok: true }),
  "remote_docker_list_mounts": async () => [] as { hostId: string; socketPath: string; connected: boolean }[],
  "remote_docker_containers": async ({ hostId }: { hostId: string }) =>
    mockContainers.map((c) => ({ ...c, engineId: `ssh:${hostId}` })),
  "remote_docker_images": async ({ hostId }: { hostId: string }) =>
    mockImages.map((i) => ({ ...i, engineId: `ssh:${hostId}` })),
  "app.info": async () => ({ version: "0.1.0", backend: "mock", platform: navigator.platform }),
  "updater_check": async () => ({
    available: false,
    currentVersion: "0.1.0",
    version: "0.1.0",
    notes: null,
    downloadUrl: null,
  }),
  "updater_install": async () => "已是最新版本（mock）",
  "power_state_get": async () => ({
    state: "active",
    policy: { statsIntervalSecs: 5, renderEvents: true, keepConnections: true },
  }),
  "power_state_set": async ({ powerState }: { powerState: string }) => ({
    state: powerState,
    policy: {
      statsIntervalSecs: powerState === "active" ? 5 : powerState === "background" ? 30 : null,
      renderEvents: powerState === "active",
      keepConnections: true,
    },
  }),
  "local_fs_list": async ({ path }: { path?: string }) => [
    { name: "src", path: `${path ?? "."}/src`, kind: "directory", size: 0 },
    { name: "README.md", path: `${path ?? "."}/README.md`, kind: "file", size: 3570 },
  ],
  "sftp_list": async ({ path }: { path: string }) => [
    { name: "etc", path: `${path === "/" ? "" : path}/etc`, kind: "directory", size: 0 },
    { name: "var", path: `${path === "/" ? "" : path}/var`, kind: "directory", size: 0 },
    { name: "deploy.txt", path: `${path === "/" ? "" : path}/deploy.txt`, kind: "file", size: 18_432 },
  ],
};

// SSH mock handlers (object literal continues separately — see above)
mockHandlers["ssh_connect"] = async (a: { hostId: string }) => ({
  sessionId: `sess-mock-${a.hostId}`,
  hostId: a.hostId,
  title: "demo",
  status: "connected",
  startedAt: new Date().toISOString(),
});
mockHandlers["ssh_reconnect"] = async (a: { sessionId: string; hostId: string }) => ({
  sessionId: a.sessionId,
  hostId: a.hostId,
  title: "demo",
  status: "connected",
  startedAt: new Date().toISOString(),
});
mockHandlers["term_input"] = async () => ({ ok: true });
mockHandlers["term_resize"] = async () => ({ ok: true });
mockHandlers["sftp_transfer"] = async ({ direction, localPath, remotePath }: { direction: "upload" | "download"; localPath: string; remotePath: string }) => {
  const taskId = `sftp-mock-${Date.now().toString(36)}`;
  void (async () => {
    for (const percent of [10, 35, 70, 100]) {
      await sleep(250);
      mockEvents.emit("sftp:progress", {
        taskId,
        direction,
        completedBytes: percent * 1000,
        totalBytes: 100_000,
        percent,
        state: percent === 100 ? "done" : "running",
        detail: `${localPath} → ${remotePath}`,
      });
    }
  })();
  return taskId;
};
mockHandlers["sftp_transfer_cancel"] = async () => ({ ok: true });
mockHandlers["sftp_transfer_batch"] = async ({ input }: { input: { direction: "upload" | "download"; localPath: string; remotePath: string } }) => {
  const taskId = `sftp-batch-mock-${Date.now().toString(36)}`;
  setTimeout(() => mockEvents.emit("sftp:batch-progress", { taskId, state: "done", completed: 1, total: 1, failed: 0 }), 300);
  return taskId;
};

// Mutation handlers — simulate latency + state change, keep UI responsive
mockHandlers["containers.start"] = async ({ id }: { id: string }) => {
  await sleep(600);
  const c = mockContainers.find((x) => x.id === id);
  if (c) {
    c.state = "running";
    c.status = "Up just now";
    c.startedAt = new Date().toISOString();
  }
  return { ok: true };
};
mockHandlers["containers.stop"] = async ({ id }: { id: string }) => {
  await sleep(600);
  const c = mockContainers.find((x) => x.id === id);
  if (c) {
    c.state = "exited";
    c.status = "Exited (0) just now";
  }
  return { ok: true };
};
mockHandlers["containers.restart"] = async ({ id }: { id: string }) => {
  await sleep(900);
  const c = mockContainers.find((x) => x.id === id);
  if (c) {
    c.state = "running";
    c.status = "Up just now";
    c.startedAt = new Date().toISOString();
  }
  return { ok: true };
};
mockHandlers["containers.pause"] = async ({ id }: { id: string }) => {
  await sleep(400);
  const c = mockContainers.find((x) => x.id === id);
  if (c) {
    c.state = "paused";
    c.status = "Paused just now";
  }
  return { ok: true };
};
mockHandlers["containers.remove"] = async ({ id }: { id: string }) => {
  await sleep(700);
  const i = mockContainers.findIndex((x) => x.id === id);
  if (i >= 0) mockContainers.splice(i, 1);
  return { ok: true };
};
mockHandlers["containers.create"] = async ({ name, image, ports }: { name: string; image: string; ports?: string }) => {
  await sleep(700);
  mockContainers.push({
    id: `new-${Date.now().toString(36)}`,
    name,
    image,
    state: "running",
    status: "Up just now",
    engineId: "eng-orb",
    ports: [],
    created: new Date().toISOString(),
    startedAt: new Date().toISOString(),
  });
  return `new-${Date.now().toString(36)}`;
};
mockHandlers["volumes.create"] = async ({ name, driver }: { name: string; driver?: string }) => {
  await sleep(400);
  mockVolumes.push({ id: `vol-${Date.now().toString(36)}`, name, engineId: "eng-orb", driver: driver ?? "local", mountpoint: "", scope: "local" });
  return { ok: true };
};
mockHandlers["volumes.remove"] = async ({ name }: { name: string }) => {
  await sleep(400);
  const i = mockVolumes.findIndex((v) => v.name === name);
  if (i >= 0) mockVolumes.splice(i, 1);
  return { ok: true };
};
mockHandlers["networks.create"] = async ({ name, driver }: { name: string; driver?: string }) => {
  await sleep(400);
  mockNetworks.push({ id: `nw-${Date.now().toString(36)}`, name, engineId: "eng-orb", driver: driver ?? "bridge", scope: "local", containers: 0 });
  return { ok: true };
};
mockHandlers["networks.remove"] = async ({ id }: { id: string }) => {
  await sleep(400);
  const i = mockNetworks.findIndex((n) => n.id === id);
  if (i >= 0) mockNetworks.splice(i, 1);
  return { ok: true };
};
mockHandlers["snippets.save"] = async ({ snippet }: { snippet: Snippet }) => {
  await sleep(200);
  const i = mockSnippets.findIndex((s) => s.id === snippet.id);
  if (i >= 0) mockSnippets[i] = snippet;
  else mockSnippets.unshift(snippet);
  return { ok: true };
};
mockHandlers["snippets.delete"] = async ({ id }: { id: string }) => {
  await sleep(200);
  const i = mockSnippets.findIndex((s) => s.id === id);
  if (i >= 0) mockSnippets.splice(i, 1);
  return { ok: true };
};
mockHandlers["tunnels.start"] = async ({ id }: { id: string }) => {
  await sleep(800);
  const t = mockTunnels.find((x) => x.id === id);
  if (t) {
    t.status = "active";
    t.startedAt = new Date().toISOString();
  }
  return { ok: true };
};
mockHandlers["images.remove"] = async ({ engineId, id }: { engineId: string; id: string }) => {
  await sleep(600);
  const i = mockImages.findIndex((x) => x.id === id && x.engineId === engineId);
  if (i >= 0) mockImages.splice(i, 1);
  return { ok: true };
};
mockHandlers["tunnels.stop"] = async ({ id }: { id: string }) => {
  await sleep(400);
  const t = mockTunnels.find((x) => x.id === id);
  if (t) t.status = "stopped";
  return { ok: true };
};

// Host key TOFU (G3) — mock accepts decisions / forgets silently
mockHandlers["ssh_host_key_decide"] = async () => ({ ok: true });
mockHandlers["ssh_known_hosts_forget"] = async () => 0;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Mock event stream — simulates docker events + stats ticks
// ---------------------------------------------------------------------------
const mockEvents = {
  listeners: new Map<string, Set<EventCallback<unknown>>>(),
  subscribe(event: string, cb: EventCallback<unknown>) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(cb);
    return () => this.listeners.get(event)?.delete(cb);
  },
  emit(event: string, payload: unknown) {
    this.listeners.get(event)?.forEach((cb) => cb(payload));
  },
};

// Image pull mock — mirrors the Rust event contract so the task queue remains
// explorable in browser mode.
mockHandlers["registries.save"] = async ({ registry, password }: { registry: RegistryConfig; password?: string | null }) => {
  const existing = mockRegistries.findIndex((r) => r.id === registry.id);
  if (existing >= 0) {
    mockRegistries[existing] = { ...registry, credentialRef: password ? "mock-keychain" : registry.credentialRef };
  } else {
    mockRegistries.push(registry);
  }
  return { ok: true };
};

mockHandlers["registries.delete"] = async ({ id }: { id: string }) => {
  const idx = mockRegistries.findIndex((r) => r.id === id);
  if (idx >= 0) mockRegistries.splice(idx, 1);
  return { ok: true };
};

mockHandlers["config.export"] = async () => ({
  app: "devdeck",
  schemaVersion: 1,
  exportedAt: new Date().toISOString(),
  hostGroups: mockHostGroups,
  hosts: mockHosts,
  tunnels: mockTunnels,
  snippets: mockSnippets,
  registries: mockRegistries,
});

mockHandlers["config.import"] = async ({ bundle }: { bundle: { app?: string } }) => {
  if (bundle?.app !== "devdeck") throw new Error("不是有效的 DevDeck 配置文件");
  return { groups: 1, hosts: 2, tunnels: 1, snippets: 3, registries: 1 };
};

let mockIdleLock: IdleLockConfig = {
  enabled: false,
  timeoutMinutes: 10,
  useTouchId: false,
  hasPin: true,
};

mockHandlers["idle_lock_config.get"] = async () => mockIdleLock;
mockHandlers["idle_lock_config.set"] = async ({
  enabled,
  timeoutMinutes,
  useTouchId,
  pin,
}: {
  enabled: boolean;
  timeoutMinutes?: number;
  useTouchId?: boolean;
  pin?: string | null;
}) => {
  mockIdleLock = {
    ...mockIdleLock,
    enabled,
    timeoutMinutes: timeoutMinutes ?? mockIdleLock.timeoutMinutes,
    useTouchId: useTouchId ?? mockIdleLock.useTouchId,
    hasPin: pin ? true : mockIdleLock.hasPin,
  };
  return { ok: true };
};
mockHandlers["idle_lock.unlock"] = async ({ pin }: { pin: string }) => pin === "1234";

mockHandlers["sudo_config.get"] = async () => true;
mockHandlers["sudo_config.set"] = async () => ({});

mockHandlers["local_shell_start"] = async () => `local-mock-${Date.now().toString(36)}`;
mockHandlers["local_shell_stop"] = async () => ({ ok: true });

mockHandlers["images.pull"] = async ({ image }: { image: string }) => {
  const taskId = `pull-mock-${Date.now().toString(36)}`;
  void (async () => {
    for (const [percent, status] of [
      [5, "开始拉取"],
      [35, "Downloading"],
      [75, "Extracting"],
    ] as const) {
      await sleep(350);
      mockEvents.emit("docker:pull-progress", {
        taskId,
        image,
        percent,
        status,
        detail: "mock-layer",
      });
    }
    await sleep(350);
    mockEvents.emit("docker:pull-progress", {
      taskId,
      image,
      percent: 100,
      status: "完成",
      state: "done",
    });
  })();
  return taskId;
};

let statsTimer: ReturnType<typeof setInterval> | null = null;

/** Start mock live streams (browser mode only) */
export function startMockStreams() {
  if (isTauri || statsTimer) return;
  // stats tick every 5s
  statsTimer = setInterval(() => {
    for (const [hostId, s] of mockHostStats) {
      const noise = ((Math.random() * 12) - 5);
      s.cpuPercent = Math.max(1, Math.min(98, s.cpuPercent + noise));
      s.sampledAt = new Date().toISOString();
      mockEvents.emit("hosts:stats", s);
    }
    // container cpu jitter
    for (const c of mockContainers) {
      if (c.state === "running" && c.cpuPercent !== undefined) {
        c.cpuPercent = Math.max(0.1, c.cpuPercent + ((Math.random() * 1.2) - 0.6));
      }
    }
  }, 5000);
  // occasional docker event
  const events: DockerEventItem[] = [
    { id: "ev-1", time: iso(60_000 * 42), type: "container", action: "start", actor: "course-reminder", engineId: "eng-orb", hostName: "本地引擎" },
    { id: "ev-2", time: iso(60_000 * 37), type: "container", action: "die", actor: "grafana-old", engineId: "eng-orb", hostName: "本地引擎" },
    { id: "ev-3", time: iso(60_000 * 21), type: "image", action: "pull", actor: "nginx:1.27-alpine", engineId: "eng-orb", hostName: "本地引擎" },
    { id: "ev-4", time: iso(60_000 * 9), type: "container", action: "health_status", actor: "postgres-16", engineId: "eng-orb", hostName: "本地引擎" },
  ];
  mockEvents.emit("docker:events", { events });
  mockEvents.emit("ssh:status", {
    sessionId: "sess-mock-1",
    hostId: "h-ali-hk",
    status: "connected",
    title: "香港 VPS",
  });
}

export function stopMockStreams() {
  if (statsTimer) clearInterval(statsTimer);
  statsTimer = null;
}
