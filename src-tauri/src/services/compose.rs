//! Docker Compose support (P1).
//!
//! bollard does not expose a Compose API, so `docker compose` is executed
//! through the host's active SSH session (`exec_for_host`). The Compose panel
//! drives up/down/ps/logs/restart/pull for a chosen project directory.

use std::sync::Arc;
use thiserror::Error;
use crate::services::ssh::SshManager;

#[derive(Error, Debug)]
pub enum ComposeError {
    #[error("ssh error: {0}")]
    Ssh(#[from] crate::services::ssh::SshError),
    #[error("compose error: {0}")]
    Run(String),
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
}

impl ComposeManager {
    pub fn new(ssh: Arc<SshManager>) -> Self {
        Self { ssh }
    }

    fn build_command(dir: Option<&str>, file: Option<&str>, args: &[String]) -> String {
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

    /// Run an arbitrary `docker compose <args...>` in `dir` and return stdout+stderr.
    pub async fn run(
        &self,
        host_id: &str,
        dir: Option<&str>,
        file: Option<&str>,
        args: &[String],
    ) -> Result<String, ComposeError> {
        let command = Self::build_command(dir, file, args);
        let out = self.ssh.exec_for_host(host_id, &command).await?;
        if out.trim().is_empty() {
            return Err(ComposeError::Run("docker compose 未返回输出（请确认已安装 docker compose 插件）".to_string()));
        }
        Ok(out)
    }

    /// `docker compose ps --format json` → parsed services.
    pub async fn ps(
        &self,
        host_id: &str,
        dir: Option<&str>,
        file: Option<&str>,
    ) -> Result<Vec<ComposeService>, ComposeError> {
        let args = vec![
            "ps".to_string(),
            "--format".to_string(),
            "json".to_string(),
        ];
        let command = Self::build_command(dir, file, &args);
        let out = self.ssh.exec_for_host(host_id, &command).await?;
        let mut services = Vec::new();
        // `docker compose ps --format json` may emit one JSON object per line
        for line in out.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('[') || line.starts_with(']') {
                continue;
            }
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                let name = v["Service"].as_str().or(v["Name"].as_str()).unwrap_or("?").to_string();
                let state = v["State"].as_str().unwrap_or("?").to_string();
                let status = v["Status"].as_str().unwrap_or("").to_string();
                services.push(ComposeService { name, state, status });
            }
        }
        Ok(services)
    }
}

/// Minimal single-quote escaping for the remote shell.
fn shell_quote(s: &str) -> String {
    let inner = s.replace('\'', "'\\''");
    format!("'{inner}'")
}
