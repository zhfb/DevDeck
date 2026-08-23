//! Tunnel manager — port forwarding lifecycle.
//!
//! Phase-1 scope: CRUD + status in SQLite, commands for start/stop.
//! Phase-2 (V1.0): real forwarding via russh direct-tcpip / streamlocal —
//! each active tunnel owns a Tokio task: local listener → channel to remote.
//!
//! NOTE: all methods are async — Tauri commands run inside the Tokio
//! runtime, so `blocking_lock()` panics; always `.lock().await`.

use std::sync::Arc;
use thiserror::Error;
use tokio::sync::Mutex;

use crate::infra::db::AppDb;
use crate::models::Tunnel;
use crate::services::ssh::SshManager;
use tokio::task::JoinHandle;
use tokio::net::TcpListener;

#[derive(Error, Debug)]
pub enum TunnelError {
    #[error("tunnel not found: {0}")]
    NotFound(String),
    #[error("db error: {0}")]
    Db(#[from] crate::infra::db::DbError),
    #[error("forwarding error: {0}")]
    Forward(String),
}

pub struct TunnelManager {
    db: Arc<Mutex<AppDb>>,
    ssh: Arc<SshManager>,
    tasks: Arc<Mutex<std::collections::HashMap<String, JoinHandle<()>>>>,
}

impl TunnelManager {
    pub fn new(db: Arc<Mutex<AppDb>>, ssh: Arc<SshManager>) -> Self {
        Self { db, ssh, tasks: Arc::new(Mutex::new(std::collections::HashMap::new())) }
    }

    pub async fn list(&self) -> Result<Vec<Tunnel>, TunnelError> {
        let db = self.db.lock().await;
        Ok(db.list_tunnels()?)
    }

    /// Persist a tunnel config (create/update).
    pub async fn save(&self, t: &Tunnel) -> Result<(), TunnelError> {
        let db = self.db.lock().await;
        db.upsert_tunnel(t)?;
        Ok(())
    }

    pub async fn remove(&self, id: &str) -> Result<(), TunnelError> {
        if let Some(handle) = self.tasks.lock().await.remove(id) {
            handle.abort();
        }
        let db = self.db.lock().await;
        db.delete_tunnel(id)?;
        Ok(())
    }

    pub async fn start(&self, id: &str) -> Result<(), TunnelError> {
        let tunnel = {
            let db = self.db.lock().await;
            db.list_tunnels()?.into_iter()
            .find(|t| t.id == id)
            .ok_or_else(|| TunnelError::NotFound(id.to_string()))?
        };
        if tunnel.type_ == "remote" {
            let bound_port = self.ssh.start_remote_forward(
                &tunnel.host_id,
                &tunnel.listen_addr,
                tunnel.listen_port,
                &tunnel.remote_host,
                tunnel.remote_port,
            ).await.map_err(|e| TunnelError::Forward(e.to_string()))?;
            let task = tokio::spawn(async { std::future::pending::<()>().await });
            self.tasks.lock().await.insert(tunnel.id.clone(), task);
            let db = self.db.lock().await;
            let mut tunnels = db.list_tunnels()?;
            if let Some(t) = tunnels.iter_mut().find(|t| t.id == id) {
                t.status = "active".to_string();
                t.listen_port = bound_port;
                t.started_at = Some(crate::models::now_iso());
                db.upsert_tunnel(t)?;
            }
            return Ok(());
        }
        if tunnel.type_ != "local" {
            return Err(TunnelError::Forward("当前版本支持 Local/Remote Forwarding；SOCKS5 尚未接入".to_string()));
        }
        let listener = TcpListener::bind(format!("{}:{}", tunnel.listen_addr, tunnel.listen_port))
            .await
            .map_err(|e| TunnelError::Forward(e.to_string()))?;
        let ssh = self.ssh.clone();
        let db = self.db.clone();
        let task_id = tunnel.id.clone();
        let host_id = tunnel.host_id.clone();
        let remote_host = tunnel.remote_host.clone();
        let remote_port = tunnel.remote_port;
        let handle = tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else { break };
                let ssh = ssh.clone();
                let host_id = host_id.clone();
                let remote_host = remote_host.clone();
                tokio::spawn(async move {
                    let _ = ssh.proxy_local_connection(&host_id, stream, &remote_host, remote_port).await;
                });
            }
            if let Ok(db) = db.try_lock() {
                if let Ok(mut tunnels) = db.list_tunnels() {
                    if let Some(t) = tunnels.iter_mut().find(|t| t.id == task_id) {
                        t.status = "stopped".to_string();
                        let _ = db.upsert_tunnel(t);
                    }
                }
            }
        });
        self.tasks.lock().await.insert(tunnel.id.clone(), handle);
        let db = self.db.lock().await;
        let mut tunnels = db.list_tunnels()?;
        if let Some(t) = tunnels.iter_mut().find(|t| t.id == id) {
            t.status = "active".to_string();
            t.started_at = Some(crate::models::now_iso());
            db.upsert_tunnel(t)?;
        }
        Ok(())
    }

    pub async fn stop(&self, id: &str) -> Result<(), TunnelError> {
        let tunnel = {
            let db = self.db.lock().await;
            db.list_tunnels()?.into_iter().find(|t| t.id == id)
        };
        if let Some(tunnel) = tunnel.as_ref().filter(|t| t.type_ == "remote") {
            self.ssh.stop_remote_forward(&tunnel.host_id, &tunnel.listen_addr, tunnel.listen_port)
                .await.map_err(|e| TunnelError::Forward(e.to_string()))?;
        }
        if let Some(handle) = self.tasks.lock().await.remove(id) {
            handle.abort();
        }
        let db = self.db.lock().await;
        let mut tunnels = db.list_tunnels()?;
        let t = tunnels
            .iter_mut()
            .find(|t| t.id == id)
            .ok_or_else(|| TunnelError::NotFound(id.to_string()))?;
        t.status = "stopped".to_string();
        db.upsert_tunnel(t)?;
        Ok(())
    }
}
