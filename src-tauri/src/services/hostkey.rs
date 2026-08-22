//! known_hosts TOFU (G3) — server host key trust resolution.
//!
//! First contact with a server emits `ssh:host-key-verify` and waits for the
//! user's accept/reject decision; on accept the fingerprint + public key are
//! stored. Later connections are checked against the stored record and
//! refused when the fingerprint changed (`ssh:host-key-changed`, possible
//! MITM).

use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::{oneshot, Mutex};

use crate::infra::db::AppDb;
use crate::models::{now_iso, KnownHostRecord};

/// Payload for `ssh:host-key-verify` / `ssh:host-key-changed` events.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyPrompt {
    pub request_id: String,
    pub host: String,
    pub port: u16,
    pub key_type: String,
    pub fingerprint: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recorded_fingerprint: Option<String>,
}

/// Resolves server host keys via known_hosts TOFU with a user prompt.
#[derive(Clone)]
pub struct HostKeyResolver {
    pub app: AppHandle,
    /// requestId → oneshot for the frontend's accept/reject decision
    pub pending: Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>>,
}

impl HostKeyResolver {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            pending: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Verify a server host key; `Ok(true)` means the connection may proceed.
    ///
    /// The SQLite store is opened per call (WAL mode makes concurrent opens
    /// safe) — a borrowed `&AppDb` cannot be held across the pending-await
    /// because rusqlite's `Connection` is `!Sync` and russh's
    /// `check_server_key` requires a `Send` future.
    ///
    /// Three branches:
    ///   1. known record, same fingerprint → trusted (touch last_seen)
    ///   2. known record, different fingerprint → warn + refuse
    ///   3. unknown → TOFU prompt (120s), store on accept
    pub async fn verify(
        &self,
        host: &str,
        port: u16,
        key: &russh::keys::PublicKey,
    ) -> Result<bool, String> {
        let db = AppDb::open().map_err(|e| e.to_string())?;
        let fingerprint = key.fingerprint(russh::keys::HashAlg::Sha256).to_string();
        let key_type = key.algorithm().to_string();

        // 1) known host, same fingerprint → trusted
        if let Some(rec) = db.get_known_host(host, port, &key_type).map_err(|e| e.to_string())? {
            if rec.fingerprint == fingerprint {
                if let Err(e) = db.touch_known_host_last_seen(host, port, &key_type, &now_iso()) {
                    tracing::warn!(err = %e, "touch_known_host_last_seen failed");
                }
                return Ok(true);
            }
            // 2) known host, DIFFERENT fingerprint → possible MITM, refuse
            let _ = self.app.emit(
                "ssh:host-key-changed",
                HostKeyPrompt {
                    request_id: String::new(),
                    host: host.to_string(),
                    port,
                    key_type: key_type.clone(),
                    fingerprint: fingerprint.clone(),
                    recorded_fingerprint: Some(rec.fingerprint),
                },
            );
            return Ok(false);
        }

        // 3) unknown host → TOFU prompt
        let request_id = uuid::Uuid::new_v4().simple().to_string();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(request_id.clone(), tx);

        let _ = self.app.emit(
            "ssh:host-key-verify",
            HostKeyPrompt {
                request_id: request_id.clone(),
                host: host.to_string(),
                port,
                key_type: key_type.clone(),
                fingerprint: fingerprint.clone(),
                recorded_fingerprint: None,
            },
        );

        match tokio::time::timeout(std::time::Duration::from_secs(120), rx).await {
            Ok(Ok(true)) => {
                let now = now_iso();
                let rec = KnownHostRecord {
                    host: host.to_string(),
                    port,
                    key_type: key_type.clone(),
                    fingerprint: fingerprint.clone(),
                    public_key: key.to_openssh().unwrap_or_default(),
                    first_seen: now.clone(),
                    last_seen: now,
                };
                db.upsert_known_host(&rec).map_err(|e| e.to_string())?;
                Ok(true)
            }
            Ok(Ok(false)) => Err("用户拒绝了主机密钥".to_string()),
            Ok(Err(_)) => {
                self.pending.lock().await.remove(&request_id);
                Err("主机密钥确认通道已关闭".to_string())
            }
            Err(_) => {
                self.pending.lock().await.remove(&request_id);
                Err("主机密钥确认超时，已取消连接".to_string())
            }
        }
    }
}

/// Frontend decision for a pending `ssh:host-key-verify` prompt.
#[tauri::command]
pub async fn ssh_host_key_decide(
    state: tauri::State<'_, crate::commands::AppState>,
    request_id: String,
    accept: bool,
) -> Result<(), String> {
    let sender = state.hostkey.pending.lock().await.remove(&request_id);
    match sender {
        Some(tx) => {
            if tx.send(accept).is_ok() {
                Ok(())
            } else {
                Err("主机密钥确认通道已关闭".to_string())
            }
        }
        None => Err("未找到对应的主机密钥确认请求（可能已超时）".to_string()),
    }
}

/// Forget all stored host keys for a host — e.g. after a
/// `ssh:host-key-changed` warning so the next connect re-runs TOFU.
/// Returns the number of deleted records.
#[tauri::command]
pub async fn ssh_known_hosts_forget(
    state: tauri::State<'_, crate::commands::AppState>,
    host: String,
    port: u16,
) -> Result<usize, String> {
    let db = state.db.lock().await;
    db.delete_known_host(&host, port).map_err(|e| e.to_string())
}
