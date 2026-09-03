//! Docker Compose support (P1).
//!
//! bollard does not expose a Compose API, so `docker compose` is executed
//! either through the host's active SSH session (`exec_for_host`, remote) or by
//! spawning the local `docker` CLI pointed at a local engine. The Compose panel
//! drives up/down/ps/logs/restart/pull for a chosen project directory.

use std::sync::Arc;
use thiserror::Error;
use crate::services::docker::DockerManager;
use crate::services::ssh::SshManager;

#[derive(Error, Debug)]
pub enum ComposeError {
    #[error("ssh error: {0}")]
    Ssh(#[from] crate::services::ssh::SshError),
    #[error("compose error: {0}")]
    Run(String),
}

/// 执行目标：本地引擎（本机 docker CLI，DOCKER_HOST 指向引擎 socket）
/// 或远端主机（经 SSH exec）。
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ComposeTarget {
    #[serde(rename = "local")]
    Local { engine_id: String },
    #[serde(rename = "remote")]
    Remote { host_id: String },
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposeService {
    pub name: String,
    pub state: String,   // running | exited | ...
    pub status: String,  // human status
}

pub struct ComposeManager {
    ssh: Arc<SshManager>,
    docker: Arc<DockerManager>,
}

impl ComposeManager {
    pub fn new(ssh: Arc<SshManager>, docker: Arc<DockerManager>) -> Self {
        Self { ssh, docker }
    }

    fn build_remote_command(dir: Option<&str>, file: Option<&str>, args: &[String]) -> String {
        let mut cmd = String::new();
        if let Some(dir) = dir.filter(|d| !d.is_empty()) {
            cmd.push_str(&format!("cd {} && ", shell_quote(dir)));
        }
        cmd.push_str("docker compose");
        if let Some(file) = file.filter(|f| !f.is_empty()) {
            cmd.push_str(&format!(" -f {}", shell_quote(file)));
        }
        for a in args {
            cmd.push(' ');
            cmd.push_str(&shell_quote(a));
        }
        cmd
    }

    /// 本地引擎的 socket 路径（与 bollard 探测结果同源）。
    async fn local_endpoint(&self, engine_id: &str) -> Result<String, ComposeError> {
        let engines = self.docker.list_engines().await;
        engines
            .iter()
            .find(|e| e.id == engine_id && e.kind != "ssh-remote" && e.reachable)
            .map(|e| e.endpoint.clone())
            .ok_or_else(|| ComposeError::Run(format!("本地引擎 {engine_id} 不可达或未启动")))
    }

    /// 本地通道：spawn `docker compose <args>`，DOCKER_HOST 指向目标引擎。
    async fn run_local(
        &self,
        engine_id: &str,
        dir: Option<&str>,
        file: Option<&str>,
        args: &[String],
    ) -> Result<String, ComposeError> {
        let endpoint = self.local_endpoint(engine_id).await?;
        let mut cmd = tokio::process::Command::new("docker");
        cmd.arg("compose");
        if let Some(file) = file.filter(|f| !f.is_empty()) {
            cmd.args(["-f", file]);
        }
        cmd.args(args);
        if let Some(dir) = dir.filter(|d| !d.is_empty()) {
            cmd.current_dir(dir);
        }
        // macOS GUI 进程的 PATH 不含 docker CLI，需显式补全（OrbStack / Homebrew 常见路径）
        let path = std::env::var("PATH").unwrap_or_default();
        cmd.env("PATH", format!("/usr/local/bin:/opt/homebrew/bin:{path}"));
        cmd.env("DOCKER_HOST", format!("unix://{endpoint}"));
        let out = cmd
            .output()
            .await
            .map_err(|e| ComposeError::Run(format!("本地执行失败（请确认已安装 docker CLI）：{e}")))?;
        let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        if !out.status.success() {
            return Err(ComposeError::Run(format!(
                "docker compose 退出码 {}{}",
                out.status.code().unwrap_or(-1),
                if stderr.is_empty() {
                    String::new()
                } else {
                    format!("：{stderr}")
                }
            )));
        }
        if stdout.is_empty() {
            if stderr.is_empty() {
                return Err(ComposeError::Run("docker compose 未返回输出".to_string()));
            }
            return Ok(stderr);
        }
        Ok(stdout)
    }

    /// Run an arbitrary `docker compose <args...>` on the given target.
    pub async fn run(
        &self,
        target: &ComposeTarget,
        dir: Option<&str>,
        file: Option<&str>,
        args: &[String],
    ) -> Result<String, ComposeError> {
        match target {
            ComposeTarget::Local { engine_id } => self.run_local(engine_id, dir, file, args).await,
            ComposeTarget::Remote { host_id } => {
                let command = Self::build_remote_command(dir, file, args);
                let out = self.ssh.exec_for_host(host_id, &command).await?;
                if out.trim().is_empty() {
                    return Err(ComposeError::Run(
                        "docker compose 未返回输出（请确认已安装 docker compose 插件）".to_string(),
                    ));
                }
                Ok(out)
            }
        }
    }

    /// `docker compose ps --format json` → parsed services（数组 + NDJSON 双兼容）。
    pub async fn ps(
        &self,
        target: &ComposeTarget,
        dir: Option<&str>,
        file: Option<&str>,
    ) -> Result<Vec<ComposeService>, ComposeError> {
        let args = vec!["ps".to_string(), "--format".to_string(), "json".to_string()];
        let out = self.run(target, dir, file, &args).await?;
        Ok(parse_ps_json(&out))
    }
}

/// 兼容两种 `docker compose ps --format json` 输出：
/// 顶层 JSON 数组（官方默认），或 NDJSON（每行一个对象，部分版本）。
fn parse_ps_json(out: &str) -> Vec<ComposeService> {
    // 先尝试整体数组
    if let Ok(arr) = serde_json::from_str::<Vec<serde_json::Value>>(out) {
        return arr.iter().filter_map(service_from_value).collect();
    }
    // NDJSON 兜底
    out.lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() {
                return None;
            }
            serde_json::from_str::<serde_json::Value>(line)
                .ok()
                .and_then(|v| service_from_value(&v))
        })
        .collect()
}

fn service_from_value(v: &serde_json::Value) -> Option<ComposeService> {
    if !v.is_object() {
        return None;
    }
    let name = v["Service"].as_str().or(v["Name"].as_str())?.to_string();
    let state = v["State"].as_str().unwrap_or("?").to_string();
    let status = v["Status"].as_str().unwrap_or("").to_string();
    Some(ComposeService { name, state, status })
}

/// Minimal single-quote escaping for the remote shell.
fn shell_quote(s: &str) -> String {
    let inner = s.replace('\'', "'\\''");
    format!("'{inner}'")
}
