//! 远程 Docker over SSH（P2/G2 补全）
//!
//! 实现路径（docs/技术方案评审与补全报告.md §G2）：
//! russh 打开到远端 `/var/run/docker.sock` 的 direct-streamlocal 通道 → 桥接到
//! 本地临时 unix socket → bollard `Docker::connect_with_unix` 以本地客户端身份访问
//! 远端引擎。生命周期：mount 时建立桥接协程，unmount 时中止并删除 socket。
//!
//! 依赖宿主机的活跃 SSH 会话（与 exec_for_host / compose 同一连接模型）。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use bollard::container::ListContainersOptions;
use bollard::image::ListImagesOptions;
use bollard::models::{ContainerSummary, ImageSummary};
use bollard::{Docker, API_DEFAULT_VERSION};
use russh::ChannelMsg;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::Mutex;

use crate::models::{Container, DockerImage, Mount, PortMapping};
use crate::services::ssh::{SshError, SshManager};

/// 远端 Docker 默认 socket 路径
const REMOTE_DOCKER_SOCKET: &str = "/var/run/docker.sock";

#[derive(Debug, serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDockerMount {
    pub host_id: String,
    pub socket_path: String,
    pub connected: bool,
}

struct MountEntry {
    path: PathBuf,
    task: tokio::task::JoinHandle<()>,
}

pub struct RemoteDockerManager {
    ssh: Arc<SshManager>,
    mounts: Mutex<HashMap<String, MountEntry>>,
}

impl RemoteDockerManager {
    pub fn new(ssh: Arc<SshManager>) -> Self {
        Self {
            ssh,
            mounts: Mutex::new(HashMap::new()),
        }
    }

    /// 为 host 挂载远端 docker.sock 到本地临时 socket，返回 socket 路径。
    pub async fn mount(&self, host_id: &str) -> Result<RemoteDockerMount, SshError> {
        let _ = self.unmount(host_id).await;
        let path = std::env::temp_dir().join(format!("devdeck-docker-{}.sock", sanitize(host_id)));
        let _ = std::fs::remove_file(&path);

        let listener = UnixListener::bind(&path).map_err(|e| {
            SshError::Channel(format!("bind local docker socket {}: {e}", path.display()))
        })?;

        let ssh = self.ssh.clone();
        let host_id_owned = host_id.to_string();
        let socket = REMOTE_DOCKER_SOCKET.to_string();
        let task = tokio::spawn(async move {
            loop {
                match listener.accept().await {
                    Ok((local, _)) => {
                        let ssh = ssh.clone();
                        let host_id = host_id_owned.clone();
                        let socket = socket.clone();
                        tokio::spawn(async move {
                            let _ = bridge_connection(&ssh, &host_id, &socket, local).await;
                        });
                    }
                    Err(e) => {
                        // accept 失败（通常是 socket 被删除/关闭）时记录日志再退出，避免任务静默消失难以排查（review Minor）
                        tracing::error!("remote docker bridge accept failed: {e}");
                        break;
                    }
                }
            }
        });

        // 用 bollard ping 验证桥接是否可用
        let docker = Docker::connect_with_unix(path.to_str().unwrap_or_default(), 120, API_DEFAULT_VERSION)
            .map_err(|e| SshError::Channel(format!("connect local docker socket: {e}")))?;
        let connected = docker.ping().await.is_ok();
        if !connected {
            // ping 失败（通常是 SSH 通道被远端拒绝），释放资源
            task.abort();
            let _ = std::fs::remove_file(&path);
            return Err(SshError::Channel(
                "远程 docker.sock 不可达（请确认主机已连接且 Docker 正在运行）".to_string(),
            ));
        }

        self.mounts.lock().await.insert(
            host_id.to_string(),
            MountEntry {
                path: path.clone(),
                task,
            },
        );

        Ok(RemoteDockerMount {
            host_id: host_id.to_string(),
            socket_path: path.to_string_lossy().into_owned(),
            connected: true,
        })
    }

    pub async fn unmount(&self, host_id: &str) -> Result<(), SshError> {
        let mut mounts = self.mounts.lock().await;
        if let Some(entry) = mounts.remove(host_id) {
            entry.task.abort();
            let _ = std::fs::remove_file(&entry.path);
        }
        Ok(())
    }

    pub async fn list_mounts(&self) -> Vec<RemoteDockerMount> {
        self.mounts
            .lock()
            .await
            .iter()
            .map(|(host_id, m)| RemoteDockerMount {
                host_id: host_id.clone(),
                socket_path: m.path.to_string_lossy().into_owned(),
                connected: true,
            })
            .collect()
    }

    pub async fn is_mounted(&self, host_id: &str) -> bool {
        self.mounts.lock().await.contains_key(host_id)
    }

    /// 查询已挂载主机的容器列表
    pub async fn list_containers(&self, host_id: &str) -> Result<Vec<Container>, SshError> {
        let mounts = self.mounts.lock().await;
        let entry = mounts
            .get(host_id)
            .ok_or_else(|| SshError::SessionNotFound(format!("docker not mounted for host {host_id}")))?;
        let docker = Docker::connect_with_unix(
            entry.path.to_str().unwrap_or_default(),
            120,
            API_DEFAULT_VERSION,
        )
        .map_err(|e| SshError::Channel(format!("connect docker socket: {e}")))?;
        let list = docker
            .list_containers(Some(ListContainersOptions::<String> {
                all: true,
                size: false,
                ..Default::default()
            }))
            .await
            .map_err(|e| SshError::Channel(format!("list containers: {e}")))?;
        Ok(list
            .into_iter()
            .map(|c| convert_container(c, host_id))
            .collect())
    }

    /// 查询已挂载主机的镜像列表
    pub async fn list_images(&self, host_id: &str) -> Result<Vec<DockerImage>, SshError> {
        let mounts = self.mounts.lock().await;
        let entry = mounts
            .get(host_id)
            .ok_or_else(|| SshError::SessionNotFound(format!("docker not mounted for host {host_id}")))?;
        let docker = Docker::connect_with_unix(
            entry.path.to_str().unwrap_or_default(),
            120,
            API_DEFAULT_VERSION,
        )
        .map_err(|e| SshError::Channel(format!("connect docker socket: {e}")))?;
        let list: Vec<ImageSummary> = docker
            .list_images(Some(ListImagesOptions::<String> {
                all: true,
                ..Default::default()
            }))
            .await
            .map_err(|e| SshError::Channel(format!("list images: {e}")))?;
        Ok(list
            .into_iter()
            .map(|img| DockerImage {
                id: img.id.clone(),
                repo_tag: img
                    .repo_tags
                    .into_iter()
                    .next()
                    .unwrap_or_else(|| "<none>:<none>".to_string()),
                size: img.size as u64,
                created: chrono::DateTime::from_timestamp(img.created, 0)
                    .map(|d| d.to_rfc3339())
                    .unwrap_or_default(),
                engine_id: format!("ssh:{host_id}"),
            })
            .collect())
    }
}

/// 单条连接的桥接：本地 unix stream ↔ SSH direct-streamlocal 通道
async fn bridge_connection(
    ssh: &SshManager,
    host_id: &str,
    socket_path: &str,
    mut local: UnixStream,
) -> Result<(), SshError> {
    let mut channel = ssh.open_docker_channel(host_id, socket_path).await?;
    let mut buf = vec![0_u8; 64 * 1024];
    let mut local_closed = false;
    loop {
        tokio::select! {
            r = local.read(&mut buf), if !local_closed => {
                match r {
                    Ok(0) => { local_closed = true; let _ = channel.eof().await; }
                    Ok(n) => { if channel.data(&buf[..n]).await.is_err() { break; } }
                    Err(_) => break,
                }
            }
            m = channel.wait() => {
                match m {
                    Some(ChannelMsg::Data { data }) => {
                        if local.write_all(&data).await.is_err() { break; }
                    }
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                    _ => {}
                }
            }
        }
    }
    Ok(())
}

fn sanitize(id: &str) -> String {
    id.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

fn convert_container(c: ContainerSummary, engine_id: &str) -> Container {
    let name = c
        .names
        .as_ref()
        .and_then(|n| n.first())
        .cloned()
        .unwrap_or_default()
        .trim_start_matches('/')
        .to_string();
    let ports = c
        .ports
        .unwrap_or_default()
        .into_iter()
        .map(|p| PortMapping {
            ip: p.ip.unwrap_or_default(),
            private_port: p.private_port,
            public_port: p.public_port,
            type_: match p.typ {
                Some(t) => t.to_string(),
                None => String::new(),
            },
        })
        .collect::<Vec<_>>();
    let mounts = c
        .mounts
        .unwrap_or_default()
        .into_iter()
        .map(|m| Mount {
            type_: m.typ.map(|t| t.to_string()).unwrap_or_default(),
            source: m.source.unwrap_or_default(),
            destination: m.destination.unwrap_or_default(),
        })
        .collect::<Vec<_>>();
    Container {
        id: c.id.unwrap_or_default(),
        name,
        image: c.image.unwrap_or_default(),
        image_id: c.image_id,
        state: c.state.unwrap_or_default(),
        status: c.status.unwrap_or_default(),
        engine_id: engine_id.to_string(),
        ports,
        created: c
            .created
            .map(|t| chrono::DateTime::from_timestamp(t, 0).map(|d| d.to_rfc3339()).unwrap_or_default())
            .unwrap_or_default(),
        started_at: None,
        command: c.command,
        env: None,
        mounts: Some(mounts),
        cpu_percent: None,
        mem_usage: None,
        mem_limit: None,
    }
}
