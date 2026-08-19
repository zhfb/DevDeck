//! Tunnel manager — port forwarding lifecycle.
//!
//! Phase-1 scope: CRUD + status in SQLite, commands for start/stop.
//! Phase-2 (V1.0): real forwarding via russh direct-tcpip / streamlocal —
//! each active tunnel owns a Tokio task: local listener → channel to remote.

use std::sync::Arc;
use thiserror::Error;
use tokio::sync::Mutex;

use crate::infra::db::AppDb;
use crate::models::Tunnel;

#[derive(Error, Debug)]
pub enum TunnelError {
    #[error("tunnel not found: {0}")]
    NotFound(String),
    #[error("db error: {0}")]
    Db(#[from] crate::infra::db::DbError),
}

pub struct TunnelManager {
    db: Arc<Mutex<AppDb>>,
}

impl TunnelManager {
    pub fn new(db: Arc<Mutex<AppDb>>) -> Self {
        Self { db }
    }

    pub fn list(&self) -> Result<Vec<Tunnel>, TunnelError> {
        let db = self.db.blocking_lock();
        Ok(db.list_tunnels()?)
    }

    /// Persist a tunnel config (create/update).
    pub fn save(&self, t: &Tunnel) -> Result<(), TunnelError> {
        let db = self.db.blocking_lock();
        db.upsert_tunnel(t)?;
        Ok(())
    }

    pub fn remove(&self, id: &str) -> Result<(), TunnelError> {
        let db = self.db.blocking_lock();
        db.delete_tunnel(id)?;
        Ok(())
    }

    /// Start forwarding. Phase 2: spawn russh direct-tcpip task per tunnel.
    pub fn start(&self, id: &str) -> Result<(), TunnelError> {
        let db = self.db.blocking_lock();
        let mut tunnels = db.list_tunnels()?;
        let t = tunnels
            .iter_mut()
            .find(|t| t.id == id)
            .ok_or_else(|| TunnelError::NotFound(id.to_string()))?;
        t.status = "active".to_string();
        t.started_at = Some(crate::models::now_iso());
        db.upsert_tunnel(t)?;
        Ok(())
    }

    pub fn stop(&self, id: &str) -> Result<(), TunnelError> {
        let db = self.db.blocking_lock();
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
