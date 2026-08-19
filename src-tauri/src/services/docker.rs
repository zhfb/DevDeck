//! Docker engine manager — local socket probing + container/image ops.
//! Backed by bollard. Remote engines (Docker over SSH) arrive in a later phase:
//! the bridge is designed as russh streamlocal tunnel → local temp socket → bollard.

use bollard::container::{ListContainersOptions, RemoveContainerOptions};
use bollard::image::{ListImagesOptions, RemoveImageOptions};
use bollard::models::{ContainerSummary, ImageSummary};
use bollard::service::EventMessage;
use bollard::system::EventsOptions;
use bollard::{Docker, API_DEFAULT_VERSION};
use std::collections::HashMap;
use std::path::Path;
use thiserror::Error;
use tokio::sync::Mutex;
use futures_util::StreamExt;

use crate::models::{
    Container, DockerEngine, DockerEventItem, DockerImage, Mount, PortMapping,
};

#[derive(Error, Debug)]
pub enum DockerError {
    #[error("docker error: {0}")]
    Bollard(#[from] bollard::errors::Error),
    #[error("engine not found: {0}")]
    EngineNotFound(String),
    #[error("no local docker engine detected")]
    NoEngine,
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
}

impl DockerManager {
    pub fn new() -> Self {
        Self {
            engines: Mutex::new(HashMap::new()),
            meta: Mutex::new(HashMap::new()),
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

    pub async fn pull_image(&self, engine_id: &str, image: &str) -> Result<(), DockerError> {
        let client = self.client(engine_id).await?;
        let mut stream = client.create_image(
            Some(bollard::image::CreateImageOptions {
                from_image: image.to_string(),
                ..Default::default()
            }),
            None,
            None,
        );
        while let Some(Ok(_msg)) = stream.next().await {
            // progress frames streamed; future: forward to task queue
        }
        Ok(())
    }

    pub async fn remove_image(&self, engine_id: &str, id: &str) -> Result<(), DockerError> {
        let client = self.client(engine_id).await?;
        client.remove_image(id, Some(RemoveImageOptions { force: true, ..Default::default() }), None).await?;
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
