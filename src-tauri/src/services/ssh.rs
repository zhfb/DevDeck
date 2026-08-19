//! SSH session manager — russh 0.53 based.
//!
//! Phase-1 (implemented): connect + authenticate (password), PTY terminal
//! sessions with full data bridging:
//!   - Rust → frontend: `term:data:<session_id>` events (stdout/stderr)
//!   - frontend → Rust: `term_input` / `term_resize` commands
//!   - session lifecycle events: `ssh:status`
//!
//! Phase-2 (in progress): keepalive + auto-reconnect (G10). known_hosts
//! TOFU (G3) and Keychain private keys (G5) remain pending.

use std::collections::HashMap;
use std::sync::Arc;
use thiserror::Error;
use tokio::sync::{mpsc, Mutex};
use tauri::{AppHandle, Emitter};

use crate::models::{Host, SshSession};

use russh::client::{AuthResult, Config, DisconnectReason, Handle, Handler};
use russh::keys::PublicKey;
use russh::{ChannelMsg, Disconnect};

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

/// Commands the frontend can send into a PTY session.
pub enum PtyCmd {
    Data(Vec<u8>),
    Resize(u32, u32),
}

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
    /// session_id → input channel into the PTY reader task
    ptys: Mutex<HashMap<String, mpsc::UnboundedSender<PtyCmd>>>,
    /// session_id → client handle (for exec / disconnect)
    handles: Mutex<HashMap<String, Handle<SessionHandler>>>,
}

impl SshManager {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            ptys: Mutex::new(HashMap::new()),
            handles: Mutex::new(HashMap::new()),
        }
    }

    async fn authenticate(
        client: &mut Handle<SessionHandler>,
        host: &Host,
        password: Option<&str>,
    ) -> Result<bool, SshError> {
        // 1) try public key auth with default ~/.ssh keys (G5 — keychain
        //    private keys arrive in a later pass)
        if Self::auth_with_keys(client, &host.user).await? {
            return Ok(true);
        }
        // 2) password auth
        match password {
            Some(pw) => Ok(matches!(
                client
                    .authenticate_password(&host.user, pw)
                    .await
                    .map_err(|e| SshError::Auth(e.to_string()))?,
                AuthResult::Success
            )),
            None => Ok(matches!(
                client
                    .authenticate_none(&host.user)
                    .await
                    .map_err(|e| SshError::Auth(e.to_string()))?,
                AuthResult::Success
            )),
        }
    }

    /// Try `~/.ssh/id_ed25519` / `id_ecdsa` / `id_rsa` (unencrypted) as the
    /// authentication identity. Returns true on first success.
    async fn auth_with_keys(
        client: &mut Handle<SessionHandler>,
        user: &str,
    ) -> Result<bool, SshError> {
        use russh::keys::decode_secret_key;
        use russh::keys::PrivateKeyWithHashAlg;

        let Some(home) = dirs::home_dir() else {
            return Ok(false);
        };
        for name in ["id_ed25519", "id_ecdsa", "id_rsa"] {
            let path = home.join(".ssh").join(name);
            let Ok(pem) = std::fs::read_to_string(&path) else {
                continue;
            };
            let Ok(key) = decode_secret_key(&pem, None) else {
                tracing::debug!(path = %path.display(), "key unreadable or encrypted — skip");
                continue;
            };
            let key = PrivateKeyWithHashAlg::new(std::sync::Arc::new(key), None);
            match client.authenticate_publickey(user, key).await {
                Ok(AuthResult::Success) => {
                    tracing::info!(path = %path.display(), "public key auth ok");
                    return Ok(true);
                }
                Ok(_) => continue,
                Err(e) => {
                    tracing::debug!(path = %path.display(), err = %e, "key auth failed");
                    continue;
                }
            }
        }
        Ok(false)
    }

    async fn connect_inner(
        &self,
        host: &Host,
        password: Option<&str>,
        session_id: Option<String>,
    ) -> Result<(Handle<SessionHandler>, SshSession), SshError> {
        let session_id = session_id.unwrap_or_else(|| uuid::Uuid::new_v4().simple().to_string());
        let title = format!("{}@{}", host.user, host.address);
        let handler = SessionHandler {
            app: self.app.clone(),
            session_id: session_id.clone(),
            host_id: host.id.clone(),
            title: title.clone(),
        };

        let addr = format!("{}:{}", host.address, host.port);
        let mut config = Config::default();
        // keepalive every 15s → network drop is detected within ~30-45s and
        // the session's `disconnected` event fires so the frontend can
        // auto-reconnect.
        config.keepalive_interval = Some(std::time::Duration::from_secs(15));
        let config = Arc::new(config);

        let mut client = russh::client::connect(config, addr.as_str(), handler).await?;

        if !Self::authenticate(&mut client, host, password).await? {
            return Err(SshError::Auth(format!(
                "authentication failed for {}@{}:{}",
                host.user, host.address, host.port
            )));
        }

        let session = SshSession {
            session_id: session_id.clone(),
            host_id: host.id.clone(),
            title,
            status: "connected".to_string(),
            started_at: crate::models::now_iso(),
            error: None,
        };
        Ok((client, session))
    }

    /// Connect and open an interactive PTY shell, wiring the data bridge.
    pub async fn connect_pty(
        &self,
        host: &Host,
        password: Option<&str>,
        cols: u32,
        rows: u32,
    ) -> Result<SshSession, SshError> {
        self.connect_pty_inner(host, password, cols, rows, None).await
    }

    /// Reconnect an existing session id (used by auto-reconnect after a drop).
    /// Reuses the original session id so the frontend event wiring
    /// (`term:data:<sid>`) keeps working without re-subscribing.
    pub async fn reconnect(
        &self,
        session_id: &str,
        host: &Host,
        cols: u32,
        rows: u32,
    ) -> Result<SshSession, SshError> {
        // drop any stale reader-task mappings for this session id
        self.ptys.lock().await.remove(session_id);
        self.handles.lock().await.remove(session_id);

        // credentials: Keychain only — there is no user typing on reconnect
        let password = host
            .credential_ref
            .as_deref()
            .and_then(|r| crate::infra::keychain::load_password(r).ok());

        self.connect_pty_inner(host, password.as_deref(), cols, rows, Some(session_id.to_string()))
            .await
    }

    async fn connect_pty_inner(
        &self,
        host: &Host,
        password: Option<&str>,
        cols: u32,
        rows: u32,
        session_id: Option<String>,
    ) -> Result<SshSession, SshError> {
        let (client, session) = self.connect_inner(host, password, session_id).await?;
        let session_id = session.session_id.clone();

        let channel = client
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

        let (mut read_half, write_half) = channel.split();
        let (tx, mut rx) = mpsc::unbounded_channel::<PtyCmd>();

        let app = self.app.clone();
        let session_for_task = session.clone();
        let session_id_task = session_id.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    msg = read_half.wait() => {
                        match msg {
                            Some(ChannelMsg::Data { data }) => {
                                let text = String::from_utf8_lossy(&data).to_string();
                                let event = format!("term:data:{session_id_task}");
                                let _ = app.emit(event.as_str(), text);
                            }
                            Some(ChannelMsg::ExtendedData { data, .. }) => {
                                let text = String::from_utf8_lossy(&data).to_string();
                                let event = format!("term:data:{session_id_task}");
                                let _ = app.emit(event.as_str(), text);
                            }
                            Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                            _ => {}
                        }
                    }
                    cmd = rx.recv() => {
                        match cmd {
                            Some(PtyCmd::Data(d)) => {
                                let _ = write_half.data(&d[..]).await;
                            }
                            Some(PtyCmd::Resize(c, r)) => {
                                let _ = write_half.window_change(c, r, 0, 0).await;
                            }
                            None => break,
                        }
                    }
                }
            }
            let _ = write_half.eof().await;
            let _ = app.emit(
                "ssh:status",
                SshSession {
                    session_id: session_for_task.session_id.clone(),
                    host_id: session_for_task.host_id.clone(),
                    title: session_for_task.title.clone(),
                    status: "disconnected".to_string(),
                    started_at: crate::models::now_iso(),
                    error: None,
                },
            );
        });

        self.ptys.lock().await.insert(session_id.clone(), tx);
        self.handles.lock().await.insert(session_id.clone(), client);
        let _ = self.app.emit("ssh:status", session.clone());
        Ok(session)
    }

    /// Send raw input bytes into a PTY session.
    pub async fn send_data(&self, session_id: &str, data: &[u8]) -> Result<(), SshError> {
        let tx = self
            .ptys
            .lock()
            .await
            .get(session_id)
            .cloned()
            .ok_or_else(|| SshError::SessionNotFound(session_id.to_string()))?;
        let _ = tx.send(PtyCmd::Data(data.to_vec()));
        Ok(())
    }

    /// Resize a PTY session.
    pub async fn resize(&self, session_id: &str, cols: u32, rows: u32) -> Result<(), SshError> {
        let tx = self
            .ptys
            .lock()
            .await
            .get(session_id)
            .cloned()
            .ok_or_else(|| SshError::SessionNotFound(session_id.to_string()))?;
        let _ = tx.send(PtyCmd::Resize(cols, rows));
        Ok(())
    }

    /// Run a single command on an existing session; returns stdout.
    /// NOTE: disabled until stats sampling needs it — Handle is not Clone,
    /// so exec would need its own connection (planned with the stats loop).
    #[allow(dead_code)]
    pub async fn exec_standalone(&self, host: &Host, password: Option<&str>, cmd: &str) -> Result<String, SshError> {
        let (_client, _session) = self.connect_inner(host, password, None).await?;
        // future: open channel on _client, exec, collect output
        let _ = cmd;
        Ok(String::new())
    }

    pub async fn list_sessions(&self) -> Vec<SshSession> {
        let ptys = self.ptys.lock().await;
        ptys.keys()
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
        self.ptys.lock().await.remove(session_id);
        let handle = self
            .handles
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
