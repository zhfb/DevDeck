//! Embedded Docker engine — DevDeck 自管的 Linux VM（Apple Virtualization.framework）。
//!
//! 与 OrbStack 同款架构：用 `limactl`（vmType=vz，Apple 原生虚拟化，无需 QEMU）
//! 启动一个跑**真正 dockerd** 的轻量 Linux 虚拟机，并把 VM 内的 docker.sock
//! 透传到宿主机 `~/.lima/devdeck/sock/docker.sock`。应用自管初始化/启动/停止，
//! 不依赖 OrbStack / Docker Desktop / Colima。
//!
//! 本模块是**无状态**的（只封装 limactl CLI 调用 + socket 路径约定），
//! 所以 DockerManager 与 AppState 可以各持一个实例而互不冲突。

use std::path::{Path, PathBuf};
use serde::Serialize;
use tokio::process::Command;
use tokio::time::{timeout, Duration};

/// 内置引擎在引擎列表中的 id（与 DockerManager 中的本地引擎命名一致）。
pub const EMBEDDED_ENGINE_ID: &str = "local-embedded";
/// 内置引擎的显示 kind（用于 EngineBadge / 引擎分类）。
pub const EMBEDDED_KIND: &str = "embedded";
/// 内置引擎显示的 machine 名称。
pub const EMBEDDED_MACHINE: &str = "devdeck";
/// Docker API socket（Lima 的 docker 模板会把 guest /var/run/docker.sock 透传到这）。
pub const EMBEDDED_SOCKET: &str = "~/.lima/devdeck/sock/docker.sock";
/// 内置引擎磁盘镜像等数据目录（便于用户理解/清理）。
pub const EMBEDDED_DATA_DIR: &str = "~/.lima/devdeck";
/// 内置引擎使用的 Lima 模板文件（自包含的 docker 模板树，含 _images/_default）。
pub const EMBEDDED_TEMPLATE: &str = "~/.devdeck/engine/lima-docker.yaml";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedStatus {
    pub installed: bool,
    pub limactl_version: Option<String>,
    pub machine: String,
    pub machine_created: bool,
    pub running: bool,
    pub socket: Option<String>,
    pub socket_exists: bool,
    pub engine_connected: bool,
    pub docker_version: Option<String>,
    pub error: Option<String>,
}

/// DevDeck 内置 Docker 引擎（基于 Lima + vz + dockerd）。
#[derive(Clone, Debug)]
pub struct EmbeddedEngine {
    pub machine: String,
}

impl Default for EmbeddedEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl EmbeddedEngine {
    pub fn new() -> Self {
        Self {
            machine: EMBEDDED_MACHINE.to_string(),
        }
    }

    /// 定位 limactl 二进制（PATH 或常见 Homebrew 路径）。
    pub fn limactl_bin(&self) -> Option<PathBuf> {
        let cands = [
            "/opt/homebrew/bin/limactl",
            "/usr/local/bin/limactl",
            "~/.devdeck/bin/limactl",
        ];
        for c in cands {
            let p = expand(c);
            if let Some(p) = p {
                if p.exists() {
                    return Some(p);
                }
            }
        }
        // PATH 查找（同步）
        if let Ok(out) = std::process::Command::new("sh")
            .arg("-lc")
            .arg("command -v limactl")
            .output()
        {
            let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !s.is_empty() && Path::new(&s).exists() {
                return Some(PathBuf::from(s));
            }
        }
        None
    }

    /// 内置引擎的 host socket 路径。
    pub fn socket_path(&self) -> PathBuf {
        expand(EMBEDDED_SOCKET).unwrap_or_else(|| PathBuf::from(EMBEDDED_SOCKET))
    }

    /// 运行 limactl 子命令，带超时；返回 stdout。
    async fn run(&self, args: &[&str], dur: Duration) -> Result<String, String> {
        let bin = self.limactl_bin().ok_or_else(|| "未找到 limactl（内置引擎未安装）".to_string())?;
        let out = timeout(dur, Command::new(&bin).args(args).output())
            .await
            .map_err(|_| format!("limactl 命令超时: {}", args.join(" ")))?
            .map_err(|e| format!("limactl 启动失败: {e}"))?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr);
            return Err(format!("limactl {} 失败: {}", args.join(" "), err.trim()));
        }
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    }

    /// 机器是否已创建（limactl list 中存在）。
    pub async fn machine_created(&self) -> bool {
        if self.limactl_bin().is_none() {
            return false;
        }
        match self.run(&["list", "-f", "{{.Name}}"], Duration::from_secs(10)).await {
            Ok(names) => names.lines().any(|n| n.trim() == self.machine),
            Err(_) => false,
        }
    }

    /// 机器是否在运行。
    pub async fn running(&self) -> bool {
        if self.limactl_bin().is_none() {
            return false;
        }
        match self
            .run(
                &["list", "-f", "{{.Name}} {{.Status}}"],
                Duration::from_secs(10),
            )
            .await
        {
            Ok(rows) => rows.lines().any(|l| {
                let mut it = l.split_whitespace();
                it.next() == Some(&self.machine as &str) && it.next() == Some("Running")
            }),
            Err(_) => false,
        }
    }

    /// 完整状态快照（前端设置页展示）。
    pub async fn status(&self) -> EmbeddedStatus {
        let mut st = EmbeddedStatus {
            installed: false,
            limactl_version: None,
            machine: self.machine.clone(),
            machine_created: false,
            running: false,
            socket: Some(self.socket_path().display().to_string()),
            socket_exists: self.socket_path().exists(),
            engine_connected: false,
            docker_version: None,
            error: None,
        };
        let Some(bin) = self.limactl_bin() else {
            st.error = Some("未安装 limactl。请先执行: brew install lima".to_string());
            return st;
        };
        st.installed = true;
        if let Ok(out) = timeout(
            Duration::from_secs(8),
            Command::new(&bin).arg("--version").output(),
        )
        .await
        {
            if let Ok(o) = out {
                st.limactl_version =
                    Some(String::from_utf8_lossy(&o.stdout).trim().to_string());
            }
        }
        st.machine_created = self.machine_created().await;
        st.running = self.running().await;
        st.socket_exists = self.socket_path().exists();
        st
    }

    /// 确保内置引擎模板文件存在（~/.devdeck/engine/lima-docker.yaml + _images/_default）。
    /// 全新安装时从 limactl 安装目录的 templates 自举复制，避免手工拷贝。
    pub async fn ensure_template(&self) -> Result<PathBuf, String> {
        let target_dir = expand("~/.devdeck/engine")
            .ok_or_else(|| "无法定位 ~/.devdeck/engine".to_string())?;
        std::fs::create_dir_all(&target_dir)
            .map_err(|e| format!("创建 ~/.devdeck/engine 失败: {e}"))?;
        let target = target_dir.join("lima-docker.yaml");
        if target.exists() {
            return Ok(target);
        }
        // 定位 lima templates 源目录：limactl 同级 ../share/lima/templates
        let bin = self
            .limactl_bin()
            .ok_or_else(|| "未找到 limactl，请先安装：brew install lima".to_string())?;
        let src_dir = bin
            .parent()
            .and_then(|p| p.parent())
            .map(|p| p.join("share/lima/templates"))
            .filter(|p| p.join("docker.yaml").exists())
            .ok_or_else(|| "找不到 lima templates 目录（安装可能不完整）".to_string())?;
        let tmp = target_dir.join("lima-docker.yaml.tmp");
        std::fs::copy(src_dir.join("docker.yaml"), &tmp)
            .map_err(|e| format!("复制模板失败: {e}"))?;
        std::fs::rename(&tmp, &target).map_err(|e| e.to_string())?;
        copy_tree(&src_dir.join("_images"), &target_dir.join("_images"))?;
        copy_tree(&src_dir.join("_default"), &target_dir.join("_default"))?;
        tracing::info!("embedded: template bootstrapped from {}", src_dir.display());
        Ok(target)
    }

    /// 确保内置引擎可用：未创建则初始化，未运行则启动，然后等待 socket 就绪。
    /// 返回 host socket 路径。可能耗时较长（首次需下载镜像）。
    pub async fn ensure(&self) -> Result<PathBuf, String> {
        // 0. 确保模板文件就绪（全新安装时从 lima 安装目录自举复制）
        self.ensure_template().await?;

        // 1. 未创建 → 初始化（vz 原生虚拟化 + 自包含 docker 模板，非交互）
        if !self.machine_created().await {
            tracing::info!("embedded: initializing lima machine {}", self.machine);
            let template = expand(EMBEDDED_TEMPLATE)
                .filter(|p| p.exists())
                .ok_or_else(|| "内置引擎模板缺失: ~/.devdeck/engine/lima-docker.yaml".to_string())?;
            let tpl = template.display().to_string();
            self.run(
                &[
                    "start",
                    "--name",
                    &self.machine,
                    "--tty=false",
                    "--vm-type=vz",
                    "--mount-type=virtiofs",
                    &tpl,
                ],
                Duration::from_secs(600),
            )
            .await?;
        }
        // 2. 未运行 → 启动
        if !self.running().await {
            tracing::info!("embedded: starting lima machine {}", self.machine);
            self.run(
                &["start", "--name", &self.machine, "--tty=false"],
                Duration::from_secs(300),
            )
            .await?;
        }
        // 3. 等待 docker socket 出现并可连接（最长 ~30s）
        let sock = self.socket_path();
        for _ in 0..30 {
            if sock.exists() {
                // 用 docker 版本探测确认 socket 可读（只读操作）
                if self.docker_version(&sock).await.is_some() {
                    return Ok(sock);
                }
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
        Err(format!(
            "内置引擎已启动但 docker.sock 未就绪: {}",
            sock.display()
        ))
    }

    /// 停止内置引擎 VM。
    pub async fn stop(&self) -> Result<(), String> {
        self.run(
            &["stop", "--name", &self.machine],
            Duration::from_secs(120),
        )
        .await?;
        Ok(())
    }

    /// 删除内置引擎（重置，会清空数据）。
    pub async fn reset(&self) -> Result<(), String> {
        // 先尝试停止，忽略错误
        let _ = self
            .run(
                &["stop", "--name", &self.machine],
                Duration::from_secs(60),
            )
            .await;
        self.run(
            &["delete", "--name", &self.machine, "--force"],
            Duration::from_secs(120),
        )
        .await?;
        Ok(())
    }

    /// 通过给定 docker.sock 探测 Docker 版本（只读，判断引擎是否真正可用）。
    async fn docker_version(&self, sock: &Path) -> Option<String> {
        let bin = if let Some(b) = std::env::var("DEV_DOCKER_CLI").ok().filter(|s| !s.is_empty()) {
            PathBuf::from(b)
        } else if let Ok(out) = Command::new("sh")
            .arg("-lc")
            .arg("command -v docker")
            .output()
            .await
        {
            let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if s.is_empty() {
                return None;
            }
            PathBuf::from(s)
        } else {
            return None;
        };
        if !bin.exists() {
            return None;
        }
        let out = timeout(
            Duration::from_secs(6),
            Command::new(&bin)
                .env("DOCKER_HOST", format!("unix://{}", sock.display()))
                .args(["version", "--format", "{{.Server.Version}}"])
                .output(),
        )
        .await
        .ok()?
        .ok()?;
        if !out.status.success() {
            return None;
        }
        let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if v.is_empty() {
            None
        } else {
            Some(v)
        }
    }
}

fn expand(raw: &str) -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let s = raw.replace('~', home.to_str().unwrap_or(""));
    Some(PathBuf::from(s))
}

/// 递归复制目录（模板自举用）。
fn copy_tree(from: &Path, to: &Path) -> Result<(), String> {
    if !from.exists() {
        return Ok(());
    }
    std::fs::create_dir_all(to).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(from).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let sp = entry.path();
        let dp = to.join(entry.file_name());
        if sp.is_dir() {
            copy_tree(&sp, &dp)?;
        } else {
            std::fs::copy(&sp, &dp).map_err(|e| format!("复制 {} 失败: {e}", sp.display()))?;
        }
    }
    Ok(())
}
