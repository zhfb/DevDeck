//! Domain models — serde field names mirror frontend/src/lib/types.ts
//! (camelCase via rename_all). Keep both sides in sync.

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Docker
// ---------------------------------------------------------------------------
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DockerEngine {
    pub id: String,
    pub name: String,
    pub kind: String, // orbstack | docker-desktop | colima | podman | ssh-remote
    pub endpoint: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub containers: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub images: Option<i64>,
    pub reachable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PortMapping {
    pub ip: String,
    pub private_port: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub public_port: Option<u16>,
    #[serde(rename = "type")]
    pub type_: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Mount {
    #[serde(rename = "type")]
    pub type_: String,
    pub source: String,
    pub destination: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Container {
    pub id: String,
    pub name: String,
    pub image: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_id: Option<String>,
    pub state: String, // created | running | paused | restarting | exited | dead | removing
    pub status: String, // human string e.g. "Up 2 hours"
    pub engine_id: String,
    #[serde(default)]
    pub ports: Vec<PortMapping>,
    pub created: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mounts: Option<Vec<Mount>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu_percent: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mem_usage: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mem_limit: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DockerImage {
    pub id: String,
    pub repo_tag: String,
    pub size: u64,
    pub created: String,
    pub engine_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DockerVolume {
    pub id: String,
    pub name: String,
    pub engine_id: String,
    pub driver: String,
    pub mountpoint: String,
    pub scope: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DockerNetwork {
    pub id: String,
    pub name: String,
    pub engine_id: String,
    pub driver: String,
    pub scope: String,
    pub containers: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DockerEventItem {
    pub id: String,
    pub time: String,
    pub type_: String,
    pub action: String,
    pub actor: String,
    pub engine_id: String,
    pub host_name: Option<String>,
}

// ---------------------------------------------------------------------------
// Hosts & groups
// ---------------------------------------------------------------------------
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HostGroup {
    pub id: String,
    pub name: String,
    pub env: String, // dev | staging | prod | none
    pub color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Host {
    pub id: String,
    pub name: String,
    pub address: String,
    pub port: u16,
    pub user: String,
    pub group_id: String,
    pub env: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fingerprint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_connected_at: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HostStats {
    pub host_id: String,
    pub cpu_percent: f64,
    pub mem_used_bytes: u64,
    pub mem_total_bytes: u64,
    pub disk_used_bytes: u64,
    pub disk_total_bytes: u64,
    pub load_avg1: f64,
    pub uptime_seconds: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub os_release: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kernel: Option<String>,
    pub sampled_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HostStatsHistoryPoint {
    pub t: String,
    pub cpu: f64,
    pub mem_percent: f64,
}

// ---------------------------------------------------------------------------
// Tunnels
// ---------------------------------------------------------------------------
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Tunnel {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub type_: String, // local | remote | socks5
    pub host_id: String,
    pub listen_addr: String,
    pub listen_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
    pub status: String, // active | stopped | error
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes_in: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes_out: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// ---------------------------------------------------------------------------
// SSH sessions
// ---------------------------------------------------------------------------
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SshSession {
    pub session_id: String,
    pub host_id: String,
    pub title: String,
    pub status: String, // connecting | connected | reconnecting | disconnected | error
    pub started_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// ---------------------------------------------------------------------------
// SFTP
// ---------------------------------------------------------------------------
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SftpEntry {
    pub name: String,
    pub path: String,
    pub kind: String, // file | directory | symlink | other
    pub size: u64,
    pub modified_at: Option<String>,
}

// ---------------------------------------------------------------------------
// Host processes (P2: 主机进程查看/kill)
// ---------------------------------------------------------------------------
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HostProcess {
    pub host_id: String,
    pub pid: u32,
    pub ppid: u32,
    pub user: String,
    pub cpu_percent: f64,
    pub mem_percent: f64,
    pub rss_kb: u64,
    pub etime: String,
    pub command: String,
}

// ---------------------------------------------------------------------------
// Snippets (P1: 常用命令库 + 变量替换)
// ---------------------------------------------------------------------------
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    pub id: String,
    pub title: String,
    pub command: String,
    #[serde(default)]
    pub tags: String,
    pub created_at: String,
}

// ---------------------------------------------------------------------------
// Known hosts (TOFU)
// ---------------------------------------------------------------------------
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KnownHostRecord {
    pub host: String,
    pub port: u16,
    pub key_type: String,
    pub fingerprint: String,
    pub public_key: String,
    pub first_seen: String,
    pub last_seen: String,
}

// ---------------------------------------------------------------------------
// App info
// ---------------------------------------------------------------------------
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub backend: String,
    pub platform: String,
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}
