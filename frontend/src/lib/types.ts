/**
 * DevDeck domain models — mirror of the Rust core layer types
 * (src-tauri/src/models). Keep field names in sync with serde JSON.
 */

/** Environment color card for host grouping */
export type Env = "dev" | "staging" | "prod" | "none";

export interface HostGroup {
  id: string;
  name: string;
  env: Env;
  color: string;
}

export interface Host {
  id: string;
  name: string;
  address: string; // host or IP
  port: number; // 22 default
  user: string;
  groupId: string;
  env: Env;
  /** keychain ref or empty = password prompt */
  credentialRef: string;
  /** key fingerprint from known_hosts TOFU */
  fingerprint?: string;
  lastConnectedAt?: string;
  /** 跳板机（ProxyJump）：经跳板 direct-tcpip 转发连接目标 */
  jumpHost?: string;
  jumpPort?: number;
  jumpUser?: string;
  createdAt: string;
}

export interface HostStatus {
  hostId: string;
  online: boolean;
  latencyMs?: number;
  lastCheckAt: string;
  stats?: HostStats;
}

/** No-agent metrics sampled over SSH */
export interface HostStats {
  hostId: string;
  cpuPercent: number;
  memUsedBytes: number;
  memTotalBytes: number;
  diskUsedBytes: number;
  diskTotalBytes: number;
  loadAvg1: number;
  uptimeSeconds: number;
  osRelease?: string;
  kernel?: string;
  sampledAt: string;
}

export interface HostStatsHistoryPoint {
  t: string;
  cpu: number;
  memPercent: number;
}

/** Local or remote docker engine */
export interface DockerEngine {
  id: string;
  name: string;
  kind: "orbstack" | "docker-desktop" | "colima" | "podman" | "ssh-remote";
  /** socket path for local, or hostId for SSH-bridged remote */
  endpoint: string;
  hostId?: string;
  version?: string;
  containers?: number;
  images?: number;
  reachable: boolean;
  error?: string;
}

export type ContainerState =
  | "created"
  | "running"
  | "paused"
  | "restarting"
  | "exited"
  | "dead"
  | "removing";

export interface PortMapping {
  ip: string;
  privatePort: number;
  publicPort?: number;
  type: "tcp" | "udp";
}

export interface Container {
  id: string;
  name: string;
  image: string;
  imageId?: string;
  state: ContainerState;
  status: string; // human string from docker, e.g. "Up 2 hours"
  engineId: string;
  ports: PortMapping[];
  created: string;
  startedAt?: string;
  command?: string;
  env?: string[];
  mounts?: { type: string; source: string; destination: string }[];
  cpuPercent?: number;
  memUsage?: number;
  memLimit?: number;
}

export interface DockerImage {
  id: string;
  repoTag: string;
  size: number;
  created: string;
  engineId: string;
  labels?: Record<string, string>;
}

export interface DockerVolume {
  id: string;
  name: string;
  engineId: string;
  driver: string;
  mountpoint: string;
  scope: string;
  created?: string;
}

export interface DockerNetwork {
  id: string;
  name: string;
  engineId: string;
  driver: string;
  scope: string;
  containers?: number;
}

export type TunnelType = "local" | "remote" | "socks5";

export interface Tunnel {
  id: string;
  name: string;
  type: TunnelType;
  hostId: string;
  /** local forward: listen on local listenPort → remote host:remotePort */
  listenAddr: string;
  listenPort: number;
  remoteHost: string;
  remotePort: number;
  status: "active" | "stopped" | "error";
  bytesIn?: number;
  bytesOut?: number;
  startedAt?: string;
  error?: string;
}

/** docker compose ps --format json 单行解析结果（后端 ComposeService） */
export interface ComposeService {
  name: string;
  state: string;
  status: string;
}

export interface SshSession {
  sessionId: string;
  hostId: string;
  title: string;
  status: "connecting" | "connected" | "reconnecting" | "disconnected" | "error";
  startedAt: string;
  error?: string;
}

export interface SftpEntry {
  name: string;
  path: string;
  kind: "file" | "directory" | "symlink" | "other" | string;
  size: number;
  modifiedAt?: string;
}

/** Terminal tab in the workspace */
export interface TerminalTab {
  id: string;
  kind: "ssh" | "docker-exec" | "local";
  sessionId?: string;
  hostId?: string;
  containerId?: string;
  engineId?: string;
  title: string;
  subtitle?: string;
  env: Env;
  /** split panes within the tab */
  panes: Pane[];
  /** split direction once the tab is split ("h" = left/right, "v" = top/bottom) */
  splitDir?: "h" | "v";
  /** focused pane id (only meaningful when panes.length > 0) */
  activePaneId?: string;
}

export interface Pane {
  id: string;
  sessionId?: string;
  title: string;
}

export interface DockerEventItem {
  id: string;
  time: string;
  type: string; // container/image/volume/network
  action: string;
  actor: string; // container name or id
  engineId: string;
  hostName?: string;
}

export interface TaskItem {
  id: string;
  kind: "pull" | "transfer" | "tunnel" | "container-op" | "connect";
  title: string;
  status: "running" | "success" | "error";
  progress?: number; // 0-100
  detail?: string;
  startedAt: string;
  finishedAt?: string;
}

/** Host process from `ps` (P2: 主机进程管理) */
export interface HostProcess {
  hostId: string;
  pid: number;
  ppid: number;
  user: string;
  cpuPercent: number;
  memPercent: number;
  rssKb: number;
  etime: string;
  command: string;
}

/** Reusable command snippet (P1: Snippets 快捷命令) */
export interface Snippet {
  id: string;
  title: string;
  command: string;
  tags: string;
  createdAt: string;
}

export interface LogLine {
  id: string;
  stream: "stdout" | "stderr" | "system";
  text: string;
  time: string;
}
