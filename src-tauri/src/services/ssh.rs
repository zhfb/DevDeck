//! SSH session manager — russh 0.53 based.
//!
//! Phase-1 scope: connect + authenticate (password), session registry,
//! exec single commands (used by no-agent stats sampling), session-status
//! events to the frontend.
//!
//! Phase-2 scope (PTY interactive terminals + term:data/term:input event
//! bridging) is designed here — see SshManager::open_pty — and lands with
//! the terminal pipeline (V1.0).

use std::collections::HashMap;
use std::sync::Arc;
use thiserror::Error;
use tokio::sync::Mutex;
use tauri::{AppHandle, Emitter};

use crate::models::{Host, SshSession};

use russh::client::{AuthResult, Config, DisconnectReason, Handle, Handler};
use russh::keys::PublicKey;
use russh::{Channel, ChannelMsg, Disconnect};

#[derive(Error, Debug)]
pub enum SshError {
    #[error("ssh connect error: {0}")]
    Connect(String),
    #[error("auth error: {0}")]
    Auth(String),
    #[error("channel error: {0}")]
    Channel(String),
    #[error("host not found: {0}")]
    HostNotFound(String),
    #[error("session not found: {0}")]
    SessionNotFound(String),
}

impl From<russh::Error> for SshError {
    fn from(e: russh::Error) -> Self {
        SshError::Connect(e.to_string())
    }
}

/// Channel message type used by russh 0.53 client channels.
type Msg = russh::client::Msg;

/// Per-session handler (russh client handler trait).
#[derive(Clone)]
struct SessionHandler {
    app: AppHandle,
    session_id: String,
    host_id: String,
    title: String,
}

impl Handler for SessionHandler {
    type Error = SshError;

    async fn check_server_key(&mut self, key: &PublicKey) -> Result<bool, Self::Error> {
        // TODO(G3): known_hosts TOFU — compare fingerprint against SQLite,
        // first-seen → prompt user; change → alert. Phase 1 accepts all.
        let _ = key;
        Ok(true)
    }

    async fn disconnected(
        &mut self,
        reason: DisconnectReason<Self::Error>,
    ) -> Result<(), Self::Error> {
        tracing::info!(session = %self.session_id, reason = ?reason, "ssh disconnected");
        let _ = self.app.emit(
            "ssh:status",
            SshSession {
                session_id: self.session_id.clone(),
                host_id: self.host_id.clone(),
                title: self.title.clone(),
                status: "disconnected".to_string(),
                started_at: crate::models::now_iso(),
                error: Some(format!("{reason:?}")),
            },
        );
        Ok(())
    }
}

pub struct SshManager {
    app: AppHandle,
    /// session_id → live client handle
    sessions: Mutex<HashMap<String, Handle<SessionHandler>>>,
}

impl SshManager {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            sessions: Mutex::new(HashMap::new()),
        }
    }

    pub async fn connect(
        &self,
        host: &Host,
        password: Option<&str>,
    ) -> Result<SshSession, SshError> {
        let session_id = uuid::Uuid::new_v4().simple().to_string();
        let title = format!("{}@{}", host.user, host.address);
        let handler = SessionHandler {
            app: self.app.clone(),
            session_id: session_id.clone(),
            host_id: host.id.clone(),
            title: title.clone(),
        };

        let addr = format!("{}:{}", host.address, host.port);
        let config = Arc::new(Config::default());

        let mut client = russh::client::connect(config, addr.as_str(), handler).await?;

        let auth_ok = match password {
            Some(pw) => matches!(
                client
                    .authenticate_password(&host.user, pw)
                    .await
                    .map_err(|e| SshError::Auth(e.to_string()))?,
                AuthResult::Success
            ),
            None => {
                // TODO(G5): ssh-agent / keychain private key auth
                matches!(
                    client
                        .authenticate_none(&host.user)
                        .await
                        .map_err(|e| SshError::Auth(e.to_string()))?,
                    AuthResult::Success
                )
            }
        };
        if !auth_ok {
            return Err(SshError::Auth(format!(
                "authentication failed for {}@{}:{}",
                host.user, host.address, host.port
            )));
        }

        self.sessions.lock().await.insert(session_id.clone(), client);

        let session = SshSession {
            session_id: session_id.clone(),
            host_id: host.id.clone(),
            title,
            status: "connected".to_string(),
            started_at: crate::models::now_iso(),
            error: None,
        };
        let _ = self.app.emit("ssh:status", session.clone());
        Ok(session)
    }

    /// Open an interactive PTY channel (Phase 2: wired to term events).
    #[allow(dead_code)]
    pub async fn open_pty(
        &self,
        session_id: &str,
        cols: u32,
        rows: u32,
    ) -> Result<Channel<Msg>, SshError> {
        let sessions = self.sessions.lock().await;
        let handle = sessions
            .get(session_id)
            .ok_or_else(|| SshError::SessionNotFound(session_id.to_string()))?;
        let channel = handle
            .channel_open_session()
            .await
            .map_err(|e| SshError::Channel(e.to_string()))?;
        channel
            .request_pty(false, "xterm-256color", cols, rows, 0, 0, &[])
            .await
            .map_err(|e| SshError::Channel(e.to_string()))?;
        channel
            .exec(true, "$SHELL")
            .await
            .map_err(|e| SshError::Channel(e.to_string()))?;
        Ok(channel)
    }

    /// Run a single command; returns stdout string. Used by stats sampling.
    #[allow(dead_code)]
    pub async fn exec(&self, session_id: &str, cmd: &str) -> Result<String, SshError> {
        let sessions = self.sessions.lock().await;
        let handle = sessions
            .get(session_id)
            .ok_or_else(|| SshError::SessionNotFound(session_id.to_string()))?;
        let mut channel = handle
            .channel_open_session()
            .await
            .map_err(|e| SshError::Channel(e.to_string()))?;
        channel
            .exec(true, cmd)
            .await
            .map_err(|e| SshError::Channel(e.to_string()))?;

        let mut out = String::new();
        let mut exit_status = None;
        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { data } => out.push_str(&String::from_utf8_lossy(&data)),
                ChannelMsg::ExtendedData { data, .. } => {
                    out.push_str(&String::from_utf8_lossy(&data))
                }
                ChannelMsg::ExitStatus { exit_status: s } => exit_status = Some(s),
                _ => {}
            }
            if exit_status.is_some() {
                break;
            }
        }
        Ok(out)
    }

    pub async fn list_sessions(&self) -> Vec<SshSession> {
        let sessions = self.sessions.lock().await;
        sessions
            .keys()
            .map(|sid| SshSession {
                session_id: sid.clone(),
                host_id: String::new(),
                title: sid.clone(),
                status: "connected".to_string(),
                started_at: crate::models::now_iso(),
                error: None,
            })
            .collect()
    }

    pub async fn disconnect(&self, session_id: &str) -> Result<(), SshError> {
        let handle = self
            .sessions
            .lock()
            .await
            .remove(session_id)
            .ok_or_else(|| SshError::SessionNotFound(session_id.to_string()))?;
        handle
            .disconnect(Disconnect::ByApplication, "user disconnect", "")
            .await
            .map_err(|e| SshError::Connect(e.to_string()))?;
        Ok(())
    }
}
