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

pub struct DockerManager {
    /// engine_id → Docker client (local engines only for now)
    engines: Mutex<HashMap<String, Docker>>,
    /// engine_id → metadata
    meta: Mutex<HashMap<String, DockerEngine>>,
    execs: Mutex<HashMap<String, (Docker, String, std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send>>) >>,
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
        Ok(found)
    }

    pub async fn list_engines(&self) -> Vec<DockerEngine> {
        let meta = self.meta.lock().await;
        let mut list: Vec<DockerEngine> = meta.values().cloned().collect();
        // refresh counts for reachable engines
        for e in list.iter_mut() {
            if e.reachable {
                if let Some(client) = self.engines.lock().await.get(&e.id) {
                    if let Ok(cs) = list_containers_inner(client, &e.id).await {
                        e.containers = Some(cs.len() as i64);
                    }
                    if let Ok(imgs) = list_images_inner(client, &e.id).await {
                        e.images = Some(imgs.len() as i64);
                    }
                }
            }
        }
        list
    }

    async fn client(&self, engine_id: &str) -> Result<Docker, DockerError> {
        self.engines
            .lock()
            .await
            .get(engine_id)
            .cloned()
            .ok_or_else(|| DockerError::EngineNotFound(engine_id.to_string()))
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
                for eid in self.engines.lock().await.keys().cloned().collect::<Vec<_>>() {
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
                for eid in self.engines.lock().await.keys().cloned().collect::<Vec<_>>() {
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
    /// Create and start a container from an image with a simple port mapping
    /// spec (`"8080:80, 3000:80/udp"`, host:container). Exposed ports without
    /// a host mapping are published on random host ports by Docker.
    pub async fn create_container(
        &self,
        engine_id: &str,
        name: &str,
        image: &str,
        ports: &str,
    ) -> Result<String, DockerError> {
        let client = self.client(engine_id).await?;

        let mut exposed_ports: HashMap<String, HashMap<(), ()>> = HashMap::new();
        let mut port_bindings: HashMap<String, Option<Vec<PortBinding>>> = HashMap::new();
        for spec in ports.split(',') {
            let spec = spec.trim();
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

        let config = Config {
            image: Some(image.to_string()),
            hostname: Some(name.to_string()),
            exposed_ports: Some(exposed_ports),
            host_config: Some(HostConfig {
                port_bindings: Some(port_bindings),
                ..Default::default()
            }),
            ..Default::default()
        };
        let options = CreateContainerOptions { name: name.to_string(), platform: None };
        let created = client.create_container(Some(options), config).await?;
        client.start_container::<String>(&created.id, None).await?;
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
        self.execs.lock().await.insert(session_id.to_string(), (client, created.id, input));
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
        let (_, _, input) = execs
            .get_mut(session_id)
            .ok_or_else(|| DockerError::EngineNotFound(format!("exec session not found: {session_id}")))?;
        input.write_all(data).await.map_err(|e| DockerError::EngineNotFound(e.to_string()))?;
        Ok(())
    }

    pub async fn exec_resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), DockerError> {
        if cols == 0 || rows == 0 {
            return Err(DockerError::EngineNotFound("exec terminal size must be positive".to_string()));
        }
        let execs = self.execs.lock().await;
        let (client, exec_id, _) = execs
            .get(session_id)
            .ok_or_else(|| DockerError::EngineNotFound(format!("exec session not found: {session_id}")))?;
        client.resize_exec(exec_id, ResizeExecOptions { height: rows as u16, width: cols as u16 }).await?;
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
                    match self.list_containers(Some(engine_id)).await {
                        Ok(containers) => {
                            let _ = app.emit(
                                "docker:snapshot",
                                serde_json::json!({
                                    "engineId": engine_id,
                                    "containers": containers,
                                }),
                            );
                        }
                        Err(e) => {
                            tracing::warn!(engine_id, err = %e, "docker snapshot emit failed");
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

#[cfg(test)]
mod tests {
    use super::pull_progress;
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
                ..Default::default()
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
        _ => kind.to_string(),
    }
}
