//! Event-driven port forwarding (P1).
//!
//! When a container starts on an engine and publishes ports, automatically
//! create local forwards through the configured SSH host, so a local
//! `127.0.0.1:<published>` reaches the container port on the remote host.
//! Containers "die"/"stop"/"destroy" tear down their auto-created tunnels.

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::infra::db::AppDb;
use crate::models::Tunnel;
use crate::services::docker::DockerManager;
use crate::services::tunnel::TunnelManager;

pub struct AutoForwardManager {
    db: Arc<Mutex<AppDb>>,
    docker: Arc<DockerManager>,
    tunnels: Arc<TunnelManager>,
    /// engine_id → host_id (SSH host the local forwards are tunnelled through)
    configs: Mutex<HashMap<String, String>>,
    /// container_id → auto-created tunnel ids
    created: Mutex<HashMap<String, Vec<String>>>,
}

impl AutoForwardManager {
    pub fn new(
        db: Arc<Mutex<AppDb>>,
        docker: Arc<DockerManager>,
        tunnels: Arc<TunnelManager>,
    ) -> Self {
        Self {
            db,
            docker,
            tunnels,
            configs: Mutex::new(HashMap::new()),
            created: Mutex::new(HashMap::new()),
        }
    }

    /// Enable (host_id = Some) or disable (None) event-driven forwarding for an engine.
    pub async fn set(&self, engine_id: &str, host_id: Option<&str>) {
        let mut configs = self.configs.lock().await;
        match host_id {
            Some(h) => {
                configs.insert(engine_id.to_string(), h.to_string());
            }
            None => {
                configs.remove(engine_id);
            }
        }
    }

    pub async fn get(&self, engine_id: &str) -> Option<String> {
        self.configs.lock().await.get(engine_id).cloned()
    }

    /// Long-lived watcher: subscribe to docker events for `engine_id`, create
    /// local forwards for started containers and tear them down on exit.
    pub async fn run(&self, engine_id: String) {
        use futures_util::StreamExt;
        loop {
            // wait until this engine is enabled
            let _host_id = match self.configs.lock().await.get(&engine_id).cloned() {
                Some(h) => h,
                None => {
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                    continue;
                }
            };
            match self.docker.event_stream(&engine_id).await {
                Ok(stream) => {
                    tracing::info!(engine_id, "auto-forward events connected");
                    let mut stream = Box::pin(stream);
                    while let Some(ev) = stream.next().await {
                        // if disabled mid-stream, drop out and wait
                        let host_id = match self.configs.lock().await.get(&engine_id).cloned() {
                            Some(h) => h,
                            None => break,
                        };
                        if ev.type_ != "container" {
                            continue;
                        }
                        let cid = ev.id.clone();
                        if matches!(ev.action.as_str(), "start" | "restart") {
                            self.handle_start(&engine_id, &host_id, &cid).await;
                        } else if matches!(ev.action.as_str(), "die" | "stop" | "destroy" | "kill") {
                            self.handle_stop(&cid).await;
                        }
                    }
                    tracing::warn!(engine_id, "auto-forward events stream ended");
                }
                Err(e) => {
                    tracing::warn!(engine_id, err = %e, "auto-forward events connect failed");
                }
            }
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        }
    }

    async fn handle_start(&self, engine_id: &str, host_id: &str, cid: &str) {
        let Ok(Some(container)) = self.docker.get_container(engine_id, cid).await else {
            return;
        };
        for pm in container.ports.iter().filter(|p| p.public_port.is_some()) {
            let local = pm.public_port.unwrap();
            let remote = pm.private_port;
            if local == 0 {
                continue;
            }
            let short = cid.chars().take(8).collect::<String>();
            let tid = format!("auto-{short}-{engine_id}-{local}");
            // idempotent: skip if the tunnel already exists
            {
                let db = self.db.lock().await;
                let Ok(tunnels) = db.list_tunnels() else { continue };
                if tunnels.iter().any(|t| t.id == tid) {
                    continue;
                }
            }
            let t = Tunnel {
                id: tid.clone(),
                name: format!("auto {} → :{}", container.name, remote),
                type_: "local".to_string(),
                host_id: host_id.to_string(),
                listen_addr: "127.0.0.1".to_string(),
                listen_port: local,
                remote_host: "127.0.0.1".to_string(),
                remote_port: remote,
                status: "stopped".to_string(),
                bytes_in: None,
                bytes_out: None,
                started_at: None,
                error: None,
            };
            if self.tunnels.save(&t).await.is_ok() && self.tunnels.start(&tid).await.is_ok() {
                tracing::info!(tid, container = %container.name, "auto-forward created");
                self.created
                    .lock()
                    .await
                    .entry(cid.to_string())
                    .or_default()
                    .push(tid);
            }
        }
    }

    async fn handle_stop(&self, cid: &str) {
        let mut created = self.created.lock().await;
        if let Some(ids) = created.remove(cid) {
            for tid in ids {
                let _ = self.tunnels.stop(&tid).await;
                tracing::info!(tid, "auto-forward stopped");
            }
        }
    }
}
