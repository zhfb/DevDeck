//! Docker Compose support (P1).
//!
//! bollard does not expose a Compose API, so `docker compose` is executed
//! either through the host's active SSH session (`exec_for_host`, remote) or by
//! spawning the local `docker` CLI pointed at a local engine. The Compose panel
//! drives up/down/ps/logs/restart/pull for a chosen project directory.

use std::sync::Arc;
use thiserror::Error;
use tokio::io::AsyncReadExt;
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

/// 远端引擎类型的标识（与 models.rs / docker.rs 一致）
const SSH_REMOTE_KIND: &str = "ssh-remote";
/// 本地 docker compose 超时（up/build 涉及网络拉取，放宽到 10 分钟）
const LOCAL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(600);

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
            .find(|e| e.id == engine_id && e.kind != SSH_REMOTE_KIND && e.reachable)
            .map(|e| e.endpoint.clone())
            .ok_or_else(|| ComposeError::Run(format!("本地引擎 {engine_id} 不可达或未启动")))
    }

    /// 本地通道：spawn `docker compose <args>`，DOCKER_HOST 指向目标引擎。
    /// 带超时保护：挂起（交互提示/网络卡死/引擎无响应）时终止子进程，避免 UI 永久冻结。
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
        // macOS GUI 进程的 PATH 不含 docker CLI，需显式补全常见安装路径：
        // OrbStack(~/.orbstack/bin)、Docker Desktop(~/.docker/bin)、Homebrew(/usr/local|/opt/homebrew)
        let home = std::env::var("HOME").unwrap_or_default();
        let path = std::env::var("PATH").unwrap_or_default();
        cmd.env(
            "PATH",
            format!("{home}/.orbstack/bin:{home}/.docker/bin:/usr/local/bin:/opt/homebrew/bin:{path}"),
        );
        cmd.env("DOCKER_HOST", format!("unix://{endpoint}"));
        // 用 default context 确保 DOCKER_HOST 完全生效，避免用户自定义 context 干扰
        cmd.env("DOCKER_CONTEXT", "default");

        let mut child = cmd
            .spawn()
            .map_err(|e| ComposeError::Run(format!("本地执行失败（请确认已安装 docker CLI）：{e}")))?;
        // 手动接管管道 + join 等待，child 保留在外层，超时后可 kill
        let mut out_buf = Vec::new();
        let mut err_buf = Vec::new();
        let mut out_pipe = child.stdout.take();
        let mut err_pipe = child.stderr.take();
        let read_out = async {
            if let Some(mut p) = out_pipe.take() {
                let _ = p.read_to_end(&mut out_buf).await;
            }
        };
        let read_err = async {
            if let Some(mut p) = err_pipe.take() {
                let _ = p.read_to_end(&mut err_buf).await;
            }
        };
        let status = tokio::time::timeout(LOCAL_TIMEOUT, async {
            tokio::join!(child.wait(), read_out, read_err).0
        })
        .await;
        let status = match status {
            Ok(Ok(s)) => s,
            Ok(Err(e)) => {
                return Err(ComposeError::Run(format!("docker compose 执行失败：{e}")));
            }
            Err(_) => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                return Err(ComposeError::Run("docker compose 执行超时（600s），已终止".to_string()));
            }
        };
        let stdout = String::from_utf8_lossy(&out_buf).trim().to_string();
        let stderr = String::from_utf8_lossy(&err_buf).trim().to_string();
        if !status.success() {
            return Err(ComposeError::Run(format!(
                "docker compose 退出码 {}{}",
                status.code().unwrap_or(-1),
                if stderr.is_empty() {
                    String::new()
                } else {
                    format!("：{stderr}")
                }
            )));
        }
        // 非零退出已单独处理；成功时若 stderr 有警告，追加到输出里避免被误判为失败
        if stdout.is_empty() && stderr.is_empty() {
            return Err(ComposeError::Run("docker compose 未返回输出".to_string()));
        }
        Ok(if stderr.is_empty() {
            stdout
        } else if stdout.is_empty() {
            stderr
        } else {
            format!("{stdout}\n{stderr}")
        })
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_top_level_array_format() {
        // docker compose v2 官方默认：单行 JSON 数组
        let out = r#"[{"Service":"web","State":"running","Status":"Up 3 minutes"},{"Service":"db","State":"exited","Status":"Exited (0) 2 minutes ago"}]"#;
        let svcs = parse_ps_json(out);
        assert_eq!(svcs.len(), 2);
        assert_eq!(svcs[0].name, "web");
        assert_eq!(svcs[0].state, "running");
        assert_eq!(svcs[1].name, "db");
        assert_eq!(svcs[1].state, "exited");
    }

    #[test]
    fn parses_ndjson_line_by_line() {
        // 部分 compose 版本输出 NDJSON：每行一个对象
        let out = "{\"Name\":\"proj-web-1\",\"Service\":\"web\",\"State\":\"running\"}\n{\"Name\":\"proj-db-1\",\"Service\":\"db\",\"State\":\"exited\"}\n";
        let svcs = parse_ps_json(out);
        assert_eq!(svcs.len(), 2);
        assert_eq!(svcs[0].name, "web");
        assert_eq!(svcs[1].name, "db");
    }

    #[test]
    fn empty_array_yields_empty_vec() {
        assert!(parse_ps_json("[]").is_empty());
    }

    #[test]
    fn falls_back_to_name_when_service_missing() {
        let out = r#"[{"Name":"proj-web-1","State":"running","Status":"Up 3 minutes"}]"#;
        let svcs = parse_ps_json(out);
        assert_eq!(svcs.len(), 1);
        assert_eq!(svcs[0].name, "proj-web-1");
    }

    #[test]
    fn filters_non_object_and_blank_lines() {
        // 混入非对象元素/空行不应产生垃圾条目
        let out = "[\n  {\"Service\":\"web\",\"State\":\"running\"},\n  42\n]\n\n";
        let svcs = parse_ps_json(out);
        assert_eq!(svcs.len(), 1);
        assert_eq!(svcs[0].name, "web");
    }

    #[test]
    fn blank_or_garbage_input_yields_empty_vec() {
        assert!(parse_ps_json("").is_empty());
        assert!(parse_ps_json("not json at all").is_empty());
    }

    #[test]
    fn shell_quote_wraps_and_escapes() {
        assert_eq!(shell_quote("plain"), "'plain'");
        assert_eq!(shell_quote("a'b"), "'a'\\''b'");
    }
}
