//! Docker engine manager — local socket probing + container/image ops.
//! Backed by bollard. Remote engines (Docker over SSH) arrive in a later phase:
//! the bridge is designed as russh streamlocal tunnel → local temp socket → bollard.

use bollard::container::{Config, CreateContainerOptions, ListContainersOptions, LogsOptions, RemoveContainerOptions};
use bollard::exec::{CreateExecOptions, ResizeExecOptions, StartExecOptions, StartExecResults};
use bollard::image::{ListImagesOptions, RemoveImageOptions};
use bollard::network::{CreateNetworkOptions, ListNetworksOptions};
use bollard::volume::{CreateVolumeOptions, ListVolumesOptions};
use bollard::models::{ContainerSummary, CreateImageInfo, HostConfig, ImageSummary, PortBinding};
use bollard::service::EventMessage;
use bollard::system::EventsOptions;
use bollard::{Docker, API_DEFAULT_VERSION};
use std::collections::HashMap;
use std::path::Path;
use thiserror::Error;
use tokio::sync::Mutex;
use tokio::io::AsyncWriteExt;
use futures_util::StreamExt;
use tauri::{AppHandle, Emitter};

use crate::models::{
    Container, DockerEngine, DockerEventItem, DockerImage, Mount, PortMapping,
};
use crate::services::power::PowerManager;

#[derive(Error, Debug)]
pub enum DockerError {
    #[error("docker error: {0}")]
    Bollard(#[from] bollard::errors::Error),
    #[error("engine not found: {0}")]
    EngineNotFound(String),
    #[error("no local docker engine detected")]
    NoEngine,
    #[error("invalid input: {0}")]
    InvalidInput(String),
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullProgress {
    pub percent: Option<u8>,
    pub status: String,
    pub detail: Option<String>,
}

/// Candidate local socket paths, probed in order (first hit wins).
const SOCKET_CANDIDATES: &[(&str, &str)] = &[
    ("orbstack", "~/.orbstack/run/docker.sock"),
    ("docker-desktop", "~/.docker/run/docker.sock"),
    ("docker-desktop", "/var/run/docker.sock"),
    ("colima", "~/.colima/default/docker.sock"),
    ("podman", "$XDG_RUNTIME_DIR/podman/podman.sock"),
];

/// 单个 exec 会话通道：Docker 客户端 + exec id + 终端输入写入端
pub struct ExecChannel {
    pub client: Docker,
    pub exec_id: String,
    pub input: std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send>>,
}

pub struct DockerManager {
    /// engine_id → Docker client (local engines only for now)
    engines: Mutex<HashMap<String, Docker>>,
    /// engine_id → metadata
    meta: Mutex<HashMap<String, DockerEngine>>,
    execs: Mutex<HashMap<String, ExecChannel>>,
}

impl Default for DockerManager {
    fn default() -> Self {
        Self::new()
    }
}

impl DockerManager {
    pub fn new() -> Self {
        Self {
            engines: Mutex::new(HashMap::new()),
            meta: Mutex::new(HashMap::new()),
            execs: Mutex::new(HashMap::new()),
        }
    }

    /// Probe local sockets, connect to the first reachable engine.
    /// Falls back to the DevDeck self-managed embedded engine (Lima vz + dockerd)
    /// so the app works without OrbStack / Docker Desktop / Colima.
    pub async fn probe(&self) -> Result<Vec<DockerEngine>, DockerError> {
        let mut found: Vec<DockerEngine> = Vec::new();
        let mut engines = self.engines.lock().await;
        let mut meta = self.meta.lock().await;

        for (kind, raw_path) in SOCKET_CANDIDATES {
            let path = expand(raw_path);
            if path.is_none() || !Path::new(path.as_ref().unwrap()).exists() {
                continue;
            }
            let path = path.unwrap();
            let id = format!("local-{kind}");
            let docker = Docker::connect_with_unix(&path, 120, API_DEFAULT_VERSION);
            match docker {
                Ok(client) => match client.version().await {
                    Ok(v) => {
                        let engine = DockerEngine {
                            id: id.clone(),
                            name: engine_display_name(kind),
                            kind: kind.to_string(),
                            endpoint: path.clone(),
                            host_id: None,
                            version: v.version,
                            containers: None,
                            images: None,
                            reachable: true,
                            error: None,
                        };
                        engines.insert(id.clone(), client);
                        meta.insert(id.clone(), engine.clone());
                        found.push(engine);
                        break; // first engine wins (OrbStack takes precedence)
                    }
                    Err(e) => {
                        tracing::warn!(path = %path, err = %e, "engine socket unreachable");
                        meta.insert(
                            id.clone(),
                            DockerEngine {
                                id: id.clone(),
                                name: engine_display_name(kind),
                                kind: kind.to_string(),
                                endpoint: path,
                                host_id: None,
                                version: None,
                                containers: None,
                                images: None,
                                reachable: false,
                                error: Some(e.to_string()),
                            },
                        );
                    }
                },
                Err(e) => {
                    tracing::warn!(path = %path, err = %e, "engine connect failed");
                }
            }
        }

        // Embedded: DevDeck 自管的内置引擎（Lima vz + dockerd）。
        // 快速路径——只有 socket 已经就绪才接入，避免 probe 触发重负载的 VM 启动。
        if found.is_empty() {
            let embedded = crate::services::embedded::EmbeddedEngine::new();
            let sock = embedded.socket_path();
            if sock.exists() {
                let id = crate::services::embedded::EMBEDDED_ENGINE_ID.to_string();
                let sock_str = sock.display().to_string();
                let docker = Docker::connect_with_unix(&sock_str, 120, API_DEFAULT_VERSION);
                match docker {
                    Ok(client) => match client.version().await {
                        Ok(v) => {
                            let engine = DockerEngine {
                                id: id.clone(),
                                name: "内置引擎 (Docker)".to_string(),
                                kind: crate::services::embedded::EMBEDDED_KIND.to_string(),
                                endpoint: sock.display().to_string(),
                                host_id: None,
                                version: v.version,
                                containers: None,
                                images: None,
                                reachable: true,
                                error: None,
                            };
                            engines.insert(id.clone(), client);
                            meta.insert(id.clone(), engine.clone());
                            found.push(engine);
                            tracing::info!("embedded engine connected via {}", sock.display());
                        }
                        Err(e) => {
                            tracing::warn!(sock = %sock.display(), err = %e, "embedded socket unreachable");
                        }
                    },
                    Err(e) => {
                        tracing::warn!(sock = %sock.display(), err = %e, "embedded connect failed");
                    }
                }
            }
        }
        drop(meta);
        drop(engines);
        Ok(found)
    }

    pub async fn list_engines(&self) -> Vec<DockerEngine> {
        // 先取快照并立即释放 meta 锁，避免与 probe()（先锁 engines 再锁 meta）形成
        // ABBA 死锁导致 engines.list 永久挂起（表现为前端“未检测到 Docker 引擎”）。
        let mut list: Vec<DockerEngine> = {
            let meta = self.meta.lock().await;
            meta.values().cloned().collect()
        };
        // refresh counts for reachable engines
        for e in list.iter_mut() {
            if e.reachable {
                // 用带超时的锁获取 + 超时的容器/镜像列表，确保任何一次 bollard 卡死
                // 都不会让 engines.list 永久挂起（前端轮询会一直拿不到结果）。
                let guard = match tokio::time::timeout(
                    std::time::Duration::from_secs(5),
                    self.engines.lock(),
                )
                .await
                {
                    Ok(g) => g,
                    Err(_) => {
                        tracing::warn!("list_engines: engines lock timeout, skipping counts for {}", e.id);
                        continue;
                    }
                };
                if let Some(client) = guard.get(&e.id).cloned() {
                    let cs = match tokio::time::timeout(
                        std::time::Duration::from_secs(10),
                        list_containers_inner(&client, &e.id),
                    )
                    .await
                    {
                        Ok(Ok(c)) => Some(c.len() as i64),
                        Ok(Err(_)) => None,
                        Err(_) => None,
                    };
                    if let Some(n) = cs {
                        e.containers = Some(n);
                    }
                    let imgs = match tokio::time::timeout(
                        std::time::Duration::from_secs(10),
                        list_images_inner(&client, &e.id),
                    )
                    .await
                    {
                        Ok(Ok(i)) => Some(i.len() as i64),
                        Ok(Err(_)) => None,
                        Err(_) => None,
                    };
                    if let Some(n) = imgs {
                        e.images = Some(n);
                    }
                }
            }
        }
        list
    }

    async fn client(&self, engine_id: &str) -> Result<Docker, DockerError> {
        let g = self.engines.lock().await;
        let r = g.get(engine_id).cloned().ok_or_else(|| DockerError::EngineNotFound(engine_id.to_string()));
        drop(g);
        r
    }

    // ---- containers ----
    pub async fn list_containers(&self, engine_id: Option<&str>) -> Result<Vec<Container>, DockerError> {
        match engine_id {
            Some(eid) => {
                let client = self.client(eid).await?;
                list_containers_inner(&client, eid).await
            }
            None => {
                let mut out = Vec::new();
                // 必须先收集 id 释放 engines 锁，再循环执行 client()/list_containers_inner，
                // 否则 for 循环头里的临时 MutexGuard 会持锁到循环结束，一旦 bollard 调用
                // 挂起就会永久占用引擎锁，导致 engines.list / probe 全部阻塞。
                let ids: Vec<String> = self.engines.lock().await.keys().cloned().collect();
                for eid in ids {
                    let client = self.client(&eid).await?;
                    out.extend(list_containers_inner(&client, &eid).await?);
                }
                Ok(out)
            }
        }
    }

    pub async fn get_container(&self, engine_id: &str, id: &str) -> Result<Option<Container>, DockerError> {
        let client = self.client(engine_id).await?;
        let list = list_containers_inner(&client, engine_id).await?;
        Ok(list.into_iter().find(|c| c.id.starts_with(id) || c.name == id))
    }

    pub async fn start(&self, engine_id: &str, id: &str) -> Result<(), DockerError> {
        let client = self.client(engine_id).await?;
        client.start_container::<&str>(id, None).await?;
        Ok(())
    }

    pub async fn stop(&self, engine_id: &str, id: &str) -> Result<(), DockerError> {
        let client = self.client(engine_id).await?;
        client.stop_container(id, None).await?;
        Ok(())
    }

    pub async fn restart(&self, engine_id: &str, id: &str) -> Result<(), DockerError> {
        let client = self.client(engine_id).await?;
        client.restart_container(id, None).await?;
        Ok(())
    }

    pub async fn pause(&self, engine_id: &str, id: &str) -> Result<(), DockerError> {
        let client = self.client(engine_id).await?;
        client.pause_container(id).await?;
        Ok(())
    }

    pub async fn unpause(&self, engine_id: &str, id: &str) -> Result<(), DockerError> {
        let client = self.client(engine_id).await?;
        client.unpause_container(id).await?;
        Ok(())
    }

    pub async fn remove(&self, engine_id: &str, id: &str) -> Result<(), DockerError> {
        let client = self.client(engine_id).await?;
        client
            .remove_container(id, Some(RemoveContainerOptions { force: true, v: true, link: false }))
            .await?;
        Ok(())
    }

    // ---- images ----
    pub async fn list_images(&self, engine_id: Option<&str>) -> Result<Vec<DockerImage>, DockerError> {
        match engine_id {
            Some(eid) => {
                let client = self.client(eid).await?;
                list_images_inner(&client, eid).await
            }
            None => {
                let mut out = Vec::new();
                // 同上：先收集 id 释放锁，避免持锁执行 bollard 调用。
                let ids: Vec<String> = self.engines.lock().await.keys().cloned().collect();
                for eid in ids {
                    let client = self.client(&eid).await?;
                    out.extend(list_images_inner(&client, &eid).await?);
                }
                Ok(out)
            }
        }
    }

    pub async fn list_volumes(&self, engine_id: Option<&str>) -> Result<Vec<crate::models::DockerVolume>, DockerError> {
        let ids = match engine_id {
            Some(id) => vec![id.to_string()],
            None => self.engines.lock().await.keys().cloned().collect(),
        };
        let mut result = Vec::new();
        for id in ids {
            let client = self.client(&id).await?;
            let response = client.list_volumes(Some(ListVolumesOptions::<String>::default())).await?;
            for volume in response.volumes.unwrap_or_default() {
                result.push(crate::models::DockerVolume {
                    id: volume.name.clone(),
                    name: volume.name,
                    engine_id: id.clone(),
                    driver: volume.driver,
                    mountpoint: volume.mountpoint,
                    scope: volume.scope.map(|scope| format!("{scope:?}")).unwrap_or_default(),
                });
            }
        }
        Ok(result)
    }

    pub async fn list_networks(&self, engine_id: Option<&str>) -> Result<Vec<crate::models::DockerNetwork>, DockerError> {
        let ids = match engine_id {
            Some(id) => vec![id.to_string()],
            None => self.engines.lock().await.keys().cloned().collect(),
        };
        let mut result = Vec::new();
        for id in ids {
            let client = self.client(&id).await?;
            for network in client.list_networks(Some(ListNetworksOptions::<String>::default())).await? {
                result.push(crate::models::DockerNetwork {
                    id: network.id.unwrap_or_default(),
                    name: network.name.unwrap_or_default(),
                    engine_id: id.clone(),
                    driver: network.driver.unwrap_or_default(),
                    scope: network.scope.unwrap_or_default(),
                    containers: network.containers.map(|containers| containers.len() as i64),
                });
            }
        }
        Ok(result)
    }

    // ---- container create (P0: 运行新容器表单) ----
    /// Create and start a container from a full [`ContainerCreateSpec`].
    ///
    /// Ports: `"8080:80, 3000:80/udp"` (host:container). Exposed ports without
    /// a host mapping are published on random host ports by Docker.
    pub async fn create_container(
        &self,
        spec: &crate::commands::ContainerCreateSpec,
    ) -> Result<String, DockerError> {
        let client = self.client(&spec.engine_id).await?;

        let mut exposed_ports: HashMap<String, HashMap<(), ()>> = HashMap::new();
        let mut port_bindings: HashMap<String, Option<Vec<PortBinding>>> = HashMap::new();
        for p in spec.ports.as_deref().unwrap_or("").split(',') {
            let spec = p.trim();
            if spec.is_empty() {
                continue;
            }
            let parts: Vec<&str> = spec.split(':').collect();
            let (host_port, container_spec) = if parts.len() == 2 {
                (Some(parts[0]), parts[1])
            } else {
                (None, parts[0])
            };
            let container_port = container_spec.split('/').next().unwrap_or(container_spec);
            let proto = if container_spec.contains("udp") { "udp" } else { "tcp" };
            let key = format!("{container_port}/{proto}");
            exposed_ports.insert(key.clone(), HashMap::new());
            if let Some(host) = host_port {
                port_bindings.insert(
                    key,
                    Some(vec![PortBinding {
                        host_ip: Some("127.0.0.1".to_string()),
                        host_port: Some(host.to_string()),
                    }]),
                );
            }
        }

        // 启动命令 / entrypoint：使用 POSIX 词法拆分，支持引号包裹的参数
        let cmd = spec.cmd.as_deref().map(split_command).transpose()?.flatten();
        let entrypoint = spec.entrypoint.as_deref().map(split_command).transpose()?.flatten();

        // 卷挂载：透传 "host:container[:ro]"，空串过滤
        let binds: Option<Vec<String>> = spec
            .volumes
            .as_ref()
            .map(|vs| {
                vs.iter()
                    .map(|v| v.trim().to_string())
                    .filter(|v| !v.is_empty())
                    .collect()
            })
            .filter(|vs: &Vec<String>| !vs.is_empty());

        // 重启策略
        let restart_policy = match spec.restart.as_deref().unwrap_or("no") {
            "" | "no" => None,
            "always" => Some(bollard::models::RestartPolicy {
                name: Some(bollard::models::RestartPolicyNameEnum::ALWAYS),
                maximum_retry_count: None,
            }),
            "on-failure" => Some(bollard::models::RestartPolicy {
                name: Some(bollard::models::RestartPolicyNameEnum::ON_FAILURE),
                maximum_retry_count: Some(5),
            }),
            "unless-stopped" => Some(bollard::models::RestartPolicy {
                name: Some(bollard::models::RestartPolicyNameEnum::UNLESS_STOPPED),
                maximum_retry_count: None,
            }),
            other => {
                return Err(DockerError::InvalidInput(format!(
                    "不支持的重启策略: {other}"
                )));
            }
        };

        // 内存/CPU 限制：拒绝非法值（NaN/负数/超范围），前端亦校验，此处兜底（review Important）
        let memory = match spec.memory_mb {
            Some(0) => None,
            Some(mb) => {
                let bytes = (mb as i128)
                    .checked_mul(1024 * 1024)
                    .ok_or_else(|| DockerError::InvalidInput("内存上限数值过大".to_string()))?;
                if bytes > i64::MAX as i128 {
                    return Err(DockerError::InvalidInput("内存上限数值过大".to_string()));
                }
                Some(bytes as i64)
            }
            None => None,
        };
        let nano_cpus = match spec.cpus {
            Some(c) if c.is_finite() && c > 0.0 => Some((c * 1_000_000_000.0) as i64),
            Some(c) => return Err(DockerError::InvalidInput(format!("无效的 CPU 限制: {c}"))),
            None => None,
        };

        let config = Config {
            image: Some(spec.image.clone()),
            // hostname 遵循 RFC 1123：容器名中的下划线替换为连字符（review Minor）
            hostname: Some(spec.name.replace('_', "-")),
            cmd,
            entrypoint,
            env: spec.env.clone(),
            exposed_ports: Some(exposed_ports),
            host_config: Some(HostConfig {
                port_bindings: Some(port_bindings),
                binds,
                network_mode: spec.network.clone(),
                restart_policy,
                memory,
                nano_cpus,
                ..Default::default()
            }),
            ..Default::default()
        };
        let options = CreateContainerOptions { name: spec.name.clone(), platform: None };
        let created = client.create_container(Some(options), config).await?;
        if let Err(e) = client.start_container::<String>(&created.id, None).await {
            // 启动失败时回滚刚创建的容器，避免残留 Created 状态容器（review Important）
            let _ = client.remove_container(&created.id, None).await;
            return Err(e.into());
        }
        Ok(created.id)
    }

    // ---- volumes (P1: 卷创建/删除) ----
    pub async fn create_volume(
        &self,
        engine_id: &str,
        name: &str,
        driver: Option<&str>,
    ) -> Result<(), DockerError> {
        let client = self.client(engine_id).await?;
        client
            .create_volume(CreateVolumeOptions {
                name: name.to_string(),
                driver: driver.unwrap_or("local").to_string(),
                ..Default::default()
            })
            .await?;
        Ok(())
    }

    pub async fn remove_volume(&self, engine_id: &str, name: &str) -> Result<(), DockerError> {
        let client = self.client(engine_id).await?;
        client.remove_volume(name, None).await?;
        Ok(())
    }

    // ---- networks (P2: 网络创建/删除) ----
    pub async fn create_network(
        &self,
        engine_id: &str,
        name: &str,
        driver: Option<&str>,
    ) -> Result<(), DockerError> {
        let client = self.client(engine_id).await?;
        client
            .create_network(CreateNetworkOptions {
                name: name.to_string(),
                driver: driver.unwrap_or("bridge").to_string(),
                ..Default::default()
            })
            .await?;
        Ok(())
    }

    pub async fn remove_network(&self, engine_id: &str, id: &str) -> Result<(), DockerError> {
        let client = self.client(engine_id).await?;
        client.remove_network(id).await?;
        Ok(())
    }

    pub async fn pull_image(
        &self,
        engine_id: &str,
        image: &str,
        app: &AppHandle,
        task_id: &str,
    ) -> Result<(), DockerError> {
        let client = self.client(engine_id).await?;
        let mut stream = client.create_image(
            Some(bollard::image::CreateImageOptions {
                from_image: image.to_string(),
                ..Default::default()
            }),
            None,
            None,
        );
        while let Some(message) = stream.next().await {
            let info = message?;
            if let Some(error) = info.error.as_deref() {
                return Err(DockerError::Bollard(bollard::errors::Error::DockerResponseServerError {
                    status_code: 500,
                    message: error.to_string(),
                }));
            }
            if let Some(progress) = pull_progress(&info) {
                let _ = app.emit(
                    "docker:pull-progress",
                    serde_json::json!({
                        "taskId": task_id,
                        "image": image,
                        "engineId": engine_id,
                        "percent": progress.percent,
                        "status": progress.status,
                        "detail": progress.detail,
                    }),
                );
            }
        }
        Ok(())
    }

    pub async fn remove_image(&self, engine_id: &str, id: &str) -> Result<(), DockerError> {
        let client = self.client(engine_id).await?;
        client.remove_image(id, Some(RemoveImageOptions { force: true, ..Default::default() }), None).await?;
        Ok(())
    }

    pub async fn exec_start(
        &self,
        app: &AppHandle,
        engine_id: &str,
        container_id: &str,
        session_id: &str,
    ) -> Result<(), DockerError> {
        let client = self.client(engine_id).await?;
        let created = client
            .create_exec(
                container_id,
                CreateExecOptions {
                    attach_stdin: Some(true),
                    attach_stdout: Some(true),
                    attach_stderr: Some(true),
                    tty: Some(true),
                    cmd: Some(vec!["sh".to_string()]),
                    ..Default::default()
                },
            )
            .await?;
        let attached = client
            .start_exec(
                &created.id,
                Some(StartExecOptions {
                    detach: false,
                    tty: true,
                    output_capacity: Some(32 * 1024),
                }),
            )
            .await?;
        let StartExecResults::Attached { mut output, input } = attached else {
            return Err(DockerError::NoEngine);
        };
        self.execs.lock().await.insert(
            session_id.to_string(),
            ExecChannel { client, exec_id: created.id, input },
        );
        let app = app.clone();
        let session_id = session_id.to_string();
        tokio::spawn(async move {
            let event_name = format!("term:data:{session_id}");
            while let Some(Ok(chunk)) = output.next().await {
                let _ = app.emit(event_name.as_str(), chunk.to_string());
            }
            let _ = app.emit(
                "docker:exec-status",
                serde_json::json!({ "sessionId": session_id, "status": "disconnected" }),
            );
        });
        Ok(())
    }

    pub async fn exec_input(&self, session_id: &str, data: &[u8]) -> Result<(), DockerError> {
        let mut execs = self.execs.lock().await;
        let exec = execs
            .get_mut(session_id)
            .ok_or_else(|| DockerError::EngineNotFound(format!("exec session not found: {session_id}")))?;
        exec.input.write_all(data).await.map_err(|e| DockerError::EngineNotFound(e.to_string()))?;
        Ok(())
    }

    pub async fn exec_resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), DockerError> {
        if cols == 0 || rows == 0 {
            return Err(DockerError::EngineNotFound("exec terminal size must be positive".to_string()));
        }
        let execs = self.execs.lock().await;
        let exec = execs
            .get(session_id)
            .ok_or_else(|| DockerError::EngineNotFound(format!("exec session not found: {session_id}")))?;
        exec.client.resize_exec(&exec.exec_id, ResizeExecOptions { height: rows, width: cols }).await?;
        Ok(())
    }

    pub async fn exec_disconnect(&self, session_id: &str) {
        self.execs.lock().await.remove(session_id);
    }

    pub async fn logs_stream(
        &self,
        app: &AppHandle,
        engine_id: &str,
        container_id: &str,
    ) -> Result<(), DockerError> {
        let client = self.client(engine_id).await?;
        let mut stream = client.logs(
            container_id,
            Some(LogsOptions::<String> {
                stdout: true,
                stderr: true,
                follow: true,
                timestamps: true,
                tail: "200".to_string(),
                ..Default::default()
            }),
        );
        let app = app.clone();
        let container_id = container_id.to_string();
        tokio::spawn(async move {
            while let Some(Ok(line)) = stream.next().await {
                let _ = app.emit(
                    "docker:logs",
                    serde_json::json!({ "containerId": container_id, "line": line.to_string() }),
                );
            }
        });
        Ok(())
    }

    // ---- events ----
    /// Subscribe to docker events; returns a stream of parsed items.
    pub async fn event_stream(
        &self,
        engine_id: &str,
    ) -> Result<std::pin::Pin<Box<dyn futures_util::Stream<Item = DockerEventItem> + Send>>, DockerError> {
        let client = self.client(engine_id).await?;
        let meta = self.meta.lock().await;
        let host_name = meta.get(engine_id).map(|m| m.name.clone());
        let engine_id = engine_id.to_string();
        let stream = client.events(Some(EventsOptions::<String>::default()));
        let mapped = stream.filter_map(move |msg| {
            let host_name = host_name.clone();
            let engine_id = engine_id.clone();
            async move { Some(parse_event(msg.ok()?, engine_id, host_name)) }
        });
        drop(meta);
        Ok(Box::pin(mapped))
    }

    /// Self-healing Docker /events forwarding loop.
    ///
    /// Keeps a long-lived events stream open and forwards every event to the
    /// frontend as `docker:events`. On stream disconnect (or connect failure)
    /// it logs a warning, sleeps 3s and retries forever. After every
    /// successful (re)connect it first emits a `docker:snapshot` carrying the
    /// full container list, so the frontend can compensate for any events
    /// missed while the stream was down. Runs until the process exits.
    ///
    /// Note: `event_stream` maps the underlying bollard stream through
    /// `filter_map(msg.ok()?)`, so transport errors are dropped and a dead
    /// connection surfaces here as `stream.next() -> None`.
    pub async fn run_event_forwarding(
        &self,
        app: tauri::AppHandle,
        engine_id: &str,
        power: PowerManager,
    ) -> Result<(), String> {
        use futures_util::StreamExt;
        use tauri::Emitter;

        loop {
            match self.event_stream(engine_id).await {
                Ok(stream) => {
                    tracing::info!(engine_id, "docker events stream connected");

                    // Snapshot compensation: full container list on every connect.
                    // 包超时：个别环境下 bollard 请求可能卡死，不能让事件转发循环被拖住。
                    match tokio::time::timeout(
                        std::time::Duration::from_secs(10),
                        self.list_containers(Some(engine_id)),
                    )
                    .await
                    {
                        Ok(Ok(containers)) => {
                            let _ = app.emit(
                                "docker:snapshot",
                                serde_json::json!({
                                    "engineId": engine_id,
                                    "containers": containers,
                                }),
                            );
                        }
                        Ok(Err(e)) => {
                            tracing::warn!(engine_id, err = %e, "docker snapshot list failed");
                        }
                        Err(_) => {
                            tracing::warn!(engine_id, "docker snapshot list timed out");
                        }
                    }

                    let mut stream = Box::pin(stream);
                    let mut batch = Vec::with_capacity(32);
                    loop {
                        match tokio::time::timeout(std::time::Duration::from_millis(500), stream.next()).await {
                            Ok(Some(ev)) => {
                                if power.snapshot().await.policy.render_events {
                                    let _ = app.emit("docker:events", serde_json::json!({ "events": [ev] }));
                                } else {
                                    batch.push(ev);
                                    // Keep background buffering bounded. The UI
                                    // can request a fresh snapshot on resume.
                                    if batch.len() >= 50 {
                                        let events = std::mem::take(&mut batch);
                                        let _ = app.emit("docker:events", serde_json::json!({ "events": events }));
                                    }
                                }
                            }
                            Ok(None) => {
                                if !batch.is_empty() {
                                    let events = std::mem::take(&mut batch);
                                    let _ = app.emit("docker:events", serde_json::json!({ "events": events }));
                                }
                                tracing::warn!(
                                    engine_id,
                                    "docker events stream disconnected, reconnecting in 3s"
                                );
                                break;
                            }
                            Err(_) => {
                                if !batch.is_empty() {
                                    let events = std::mem::take(&mut batch);
                                    let _ = app.emit("docker:events", serde_json::json!({ "events": events }));
                                }
                            }
                        }
                    }
                }
                Err(e) => {
                    tracing::warn!(
                        engine_id,
                        err = %e,
                        "docker events connect failed, retrying in 3s"
                    );
                }
            }
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        }
    }
}

// ---------------------------------------------------------------------------
// inner helpers
// ---------------------------------------------------------------------------
fn parse_event(msg: EventMessage, engine_id: String, host_name: Option<String>) -> DockerEventItem {
    let actor = msg.actor.as_ref();
    let actor_name = actor
        .and_then(|a| a.attributes.as_ref())
        .and_then(|attrs| attrs.get("name").cloned())
        .or_else(|| actor.and_then(|a| a.id.clone()))
        .unwrap_or_default();
    DockerEventItem {
        id: format!("ev-{}", uuid::Uuid::new_v4().simple()),
        time: chrono::Utc::now().to_rfc3339(),
        type_: match msg.typ {
            Some(t) => t.to_string(),
            None => String::new(),
        },
        action: msg.action.unwrap_or_default(),
        actor: actor_name,
        engine_id,
        host_name,
    }
}

fn pull_progress(info: &CreateImageInfo) -> Option<PullProgress> {
    let status = info.status.clone().or_else(|| info.error.clone())?;
    let percent = info.progress_detail.as_ref().and_then(|detail| {
        let current = detail.current?;
        let total = detail.total?;
        if total <= 0 {
            return None;
        }
        Some(((current.max(0) as f64 / total as f64) * 100.0).round().clamp(0.0, 100.0) as u8)
    });
    Some(PullProgress {
        percent,
        status,
        detail: info.id.clone(),
    })
}

async fn list_containers_inner(docker: &Docker, engine_id: &str) -> Result<Vec<Container>, DockerError> {
    let opts = ListContainersOptions::<String> {
        all: true,
        size: false,
        ..Default::default()
    };
    let list = docker.list_containers(Some(opts)).await?;
    Ok(list.into_iter().map(|c| convert_container(c, engine_id)).collect())
}

fn convert_container(c: ContainerSummary, engine_id: &str) -> Container {
    let name = c.names.as_ref().and_then(|n| n.first()).cloned().unwrap_or_default().trim_start_matches('/').to_string();
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
    let mounts = c.mounts.unwrap_or_default().into_iter().map(|m| Mount {
        type_: m.typ.map(|t| t.to_string()).unwrap_or_default(),
        source: m.source.unwrap_or_default(),
        destination: m.destination.unwrap_or_default(),
    }).collect::<Vec<_>>();
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
        started_at: None, // populated via inspect in a later phase
        command: c.command,
        env: None,
        mounts: Some(mounts),
        cpu_percent: None,
        mem_usage: None,
        mem_limit: None,
    }
}

async fn list_images_inner(docker: &Docker, engine_id: &str) -> Result<Vec<DockerImage>, DockerError> {
    let list: Vec<ImageSummary> = docker
        .list_images(Some(ListImagesOptions::<String> {
            all: true,
            ..Default::default()
        }))
        .await?;
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
            engine_id: engine_id.to_string(),
        })
        .collect())
}

fn expand(raw: &str) -> Option<String> {
    let home = dirs::home_dir()?;
    let s = raw
        .replace('~', home.to_str().unwrap_or(""))
        .replace("$XDG_RUNTIME_DIR", "/run/user/1000");
    Some(s)
}

fn engine_display_name(kind: &str) -> String {
    match kind {
        "orbstack" => "本地引擎 (OrbStack)".to_string(),
        "docker-desktop" => "本地引擎 (Docker Desktop)".to_string(),
        "colima" => "本地引擎 (Colima)".to_string(),
        "podman" => "本地引擎 (Podman)".to_string(),
        "embedded" => "内置引擎 (Docker)".to_string(),
        _ => kind.to_string(),
    }
}

/// POSIX 风格词法拆分命令行，支持引号/转义包裹的参数。
/// 空输入返回 `Ok(None)`（不覆盖镜像默认 CMD/ENTRYPOINT）。
fn split_command(cmd: &str) -> Result<Option<Vec<String>>, DockerError> {
    let trimmed = cmd.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let args = shell_words::split(trimmed).map_err(|e| {
        DockerError::Bollard(bollard::errors::Error::IOError {
            err: std::io::Error::new(std::io::ErrorKind::InvalidInput, format!("命令解析失败: {e}")),
        })
    })?;
    if args.is_empty() {
        Ok(None)
    } else {
        Ok(Some(args))
    }
}

#[cfg(test)]
mod tests {
    use super::{pull_progress, split_command};
    use bollard::models::{CreateImageInfo, ProgressDetail};

    #[test]
    fn pull_progress_converts_layer_bytes_to_percentage_and_detail() {
        let info = CreateImageInfo {
            id: Some("layer-1".to_string()),
            status: Some("Downloading".to_string()),
            progress: Some("[=====>             ]".to_string()),
            progress_detail: Some(ProgressDetail {
                current: Some(25),
                total: Some(100),
            }),
            ..Default::default()
        };

        let progress = pull_progress(&info).expect("progress frame");

        assert_eq!(progress.percent, Some(25));
        assert_eq!(progress.status, "Downloading");
        assert_eq!(progress.detail.as_deref(), Some("layer-1"));
    }

    #[test]
    fn pull_progress_keeps_status_frames_without_byte_totals() {
        let info = CreateImageInfo {
            status: Some("Pulling from library/alpine".to_string()),
            ..Default::default()
        };

        let progress = pull_progress(&info).expect("status frame");

        assert_eq!(progress.percent, None);
        assert_eq!(progress.status, "Pulling from library/alpine");
    }

    #[test]
    fn split_command_handles_quoted_arguments() {
        let args = split_command("nginx -g 'daemon off;'").unwrap().unwrap();
        assert_eq!(args, vec!["nginx", "-g", "daemon off;"]);
    }

    #[test]
    fn split_command_empty_or_whitespace_returns_none() {
        assert_eq!(split_command("").unwrap(), None);
        assert_eq!(split_command("   ").unwrap(), None);
    }

    #[test]
    fn split_command_plain_words() {
        let args = split_command("sh -c 'echo hello world'").unwrap().unwrap();
        assert_eq!(args, vec!["sh", "-c", "echo hello world"]);
    }

    #[test]
    fn split_command_unbalanced_quote_is_an_error() {
        assert!(split_command("echo \"unterminated").is_err());
    }
}
