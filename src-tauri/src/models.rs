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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub jump_host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub jump_port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub jump_user: Option<String>,
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
// Registry (镜像仓库配置)
// ---------------------------------------------------------------------------
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RegistryConfig {
    pub id: String,
    pub name: String,
    /// Base URL，例如 https://registry.example.com 或 http://127.0.0.1:5000
    pub url: String,
    pub username: String,
    /// Keychain 引用（密码只存 Keychain）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential_ref: Option<String>,
    /// 允许 http / 跳过 TLS 校验（本地或内网仓库）
    #[serde(default)]
    pub insecure: bool,
    /// 是否为 Docker Hub（走 Bearer token 认证流）
    #[serde(default)]
    pub is_docker_hub: bool,
    pub created_at: String,
}

/// 仓库浏览结果：仓库名 + tags
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryRepo {
    pub name: String,
    #[serde(default)]
    pub tags: Vec<String>,
}

// ---------------------------------------------------------------------------
// Idle auto-lock（闲置自动锁）
// ---------------------------------------------------------------------------
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdleLockConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_idle_timeout")]
    pub timeout_minutes: u32,
    #[serde(default)]
    pub use_touch_id: bool,
    /// 是否已设置解锁 PIN（仅读，由后端探测 Keychain）
    #[serde(default)]
    pub has_pin: bool,
}

fn default_idle_timeout() -> u32 {
    10
}

// ---------------------------------------------------------------------------
// Config export / import（配置导入导出，不含密钥本体）
// ---------------------------------------------------------------------------
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigBundle {
    pub app: String,
    pub schema_version: u32,
    pub exported_at: String,
    #[serde(default)]
    pub host_groups: Vec<HostGroup>,
    #[serde(default)]
    pub hosts: Vec<Host>,
    #[serde(default)]
    pub tunnels: Vec<Tunnel>,
    #[serde(default)]
    pub snippets: Vec<Snippet>,
    #[serde(default)]
    pub registries: Vec<RegistryConfig>,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idle_lock_config_defaults_when_fields_missing() {
        let cfg: IdleLockConfig = serde_json::from_str(r#"{"enabled":true}"#).unwrap();
        assert!(cfg.enabled);
        assert_eq!(cfg.timeout_minutes, 10, "缺省超时应回退默认 10 分钟");
        assert!(!cfg.use_touch_id);
        assert!(!cfg.has_pin);
    }

    #[test]
    fn idle_lock_config_round_trip_keeps_camel_case() {
        let cfg = IdleLockConfig {
            enabled: true,
            timeout_minutes: 15,
            use_touch_id: false,
            has_pin: true,
        };
        let json = serde_json::to_string(&cfg).unwrap();
        assert!(json.contains("timeoutMinutes"));
        assert!(json.contains("hasPin"));
        let back: IdleLockConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back.enabled, cfg.enabled);
        assert_eq!(back.timeout_minutes, 15);
        assert!(back.has_pin);
    }

    #[test]
    fn registry_config_round_trip_omits_optional_credential_ref() {
        let cfg = RegistryConfig {
            id: "r1".into(),
            name: "UCloud".into(),
            url: "https://registry.ucloud.cn".into(),
            username: "zhfb".into(),
            credential_ref: None,
            insecure: true,
            is_docker_hub: false,
            created_at: "2026-09-03T00:00:00Z".into(),
        };
        let json = serde_json::to_string(&cfg).unwrap();
        assert!(!json.contains("credentialRef"), "None 字段应被跳过");
        let back: RegistryConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back.url, cfg.url);
        assert!(back.insecure);
    }

    #[test]
    fn config_bundle_round_trip_preserves_app_and_version() {
        let bundle = ConfigBundle {
            app: "devdeck".into(),
            schema_version: 1,
            exported_at: "2026-09-03T00:00:00Z".into(),
            host_groups: vec![],
            hosts: vec![],
            tunnels: vec![],
            snippets: vec![],
            registries: vec![],
        };
        let json = serde_json::to_string(&bundle).unwrap();
        let back: ConfigBundle = serde_json::from_str(&json).unwrap();
        assert_eq!(back.app, "devdeck");
        assert_eq!(back.schema_version, 1);
        assert!(json.contains("schemaVersion"));
    }

    #[test]
    fn config_bundle_missing_lists_default_to_empty() {
        let json = r#"{"app":"devdeck","schemaVersion":1,"exportedAt":"2026-09-03T00:00:00Z"}"#;
        let back: ConfigBundle = serde_json::from_str(json).unwrap();
        assert!(back.hosts.is_empty());
        assert!(back.registries.is_empty());
    }

    #[test]
    fn registry_repo_tags_default_to_empty() {
        let repo: RegistryRepo = serde_json::from_str(r#"{"name":"library/alpine"}"#).unwrap();
        assert_eq!(repo.name, "library/alpine");
        assert!(repo.tags.is_empty());
    }
}
