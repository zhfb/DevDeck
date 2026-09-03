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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use thiserror::Error;
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tauri::{AppHandle, Emitter};

use crate::models::{Host, SshSession};
use crate::services::hostkey::HostKeyResolver;

use russh::client::{AuthResult, Config, DisconnectReason, Handle, Handler, KeyboardInteractiveAuthResponse};
use russh::keys::PublicKey;
use russh::{ChannelMsg, Disconnect};
use russh_sftp::client::SftpSession;

#[derive(Debug, Clone)]
pub struct RemoteForwardTarget {
    pub local_host: String,
    pub local_port: u16,
}

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
    #[error("io error: {0}")]
    Io(String),
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
    host: String,
    port: u16,
    hostkey: HostKeyResolver,
    remote_forwards: Arc<Mutex<HashMap<String, RemoteForwardTarget>>>,
}

impl Handler for SessionHandler {
    type Error = SshError;

    async fn check_server_key(&mut self, key: &PublicKey) -> Result<bool, Self::Error> {
        // known_hosts TOFU (G3): resolve trust against SQLite, prompting the
        // user on first contact and refusing on key change. The resolver
        // opens the DB per call (WAL mode makes concurrent opens safe).
        self.hostkey
            .verify(&self.host, self.port, key)
            .await
            .map_err(SshError::Connect)
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

    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<russh::client::Msg>,
        _connected_address: &str,
        _connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        _session: &mut russh::client::Session,
    ) -> Result<(), Self::Error> {
        let target = self.remote_forwards.lock().await.get(&self.session_id).cloned();
        let Some(target) = target else { return Ok(()); };
        tokio::spawn(async move {
            let Ok(mut local) = tokio::net::TcpStream::connect((target.local_host.as_str(), target.local_port)).await else { return; };
            let mut forwarded = channel.into_stream();
            let _ = tokio::io::copy_bidirectional(&mut local, &mut forwarded).await;
        });
        Ok(())
    }
}

/// Minimal client handler for the jump (bastion) hop. TOFU-verifies the jump
/// host's key via the same resolver used for target hosts.
#[derive(Clone)]
struct JumpHandler {
    hostkey: HostKeyResolver,
    host: String,
    port: u16,
}

impl Handler for JumpHandler {
    type Error = SshError;

    async fn check_server_key(&mut self, key: &PublicKey) -> Result<bool, Self::Error> {
        self.hostkey
            .verify(&self.host, self.port, key)
            .await
            .map_err(SshError::Connect)
    }
}

/// Wraps a direct-tcpip channel stream opened on the jump connection and keeps
/// the jump connection's `Handle` alive for exactly as long as the transport.
/// When the target connection drops this stream, the jump handle drops too and
/// the bastion hop closes cleanly.
struct JumpStream<R> {
    inner: R,
    _jump: Handle<JumpHandler>,
}

impl<R: AsyncRead + AsyncWrite + Unpin> AsyncRead for JumpStream<R> {
    fn poll_read(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.get_mut().inner).poll_read(cx, buf)
    }
}

impl<R: AsyncRead + AsyncWrite + Unpin> AsyncWrite for JumpStream<R> {
    fn poll_write(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        std::pin::Pin::new(&mut self.get_mut().inner).poll_write(cx, buf)
    }
    fn poll_flush(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.get_mut().inner).poll_flush(cx)
    }
    fn poll_shutdown(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.get_mut().inner).poll_shutdown(cx)
    }
}

/// 共享 SSH 连接句柄：同一主机的多个终端 Tab 复用同一条传输（会话复用）。
type SharedHandle = Arc<tokio::sync::Mutex<Handle<SessionHandler>>>;

/// 主机级连接池条目：持有传输句柄与挂接的会话集合。
struct PoolEntry {
    slot: SharedHandle,
    sessions: std::collections::HashSet<String>,
}

pub struct SshManager {
    app: AppHandle,
    /// known_hosts TOFU resolver (shared with the AppState so the
    /// `ssh_host_key_decide` command can resolve pending prompts)
    hostkey: HostKeyResolver,
    /// session_id → input channel into the PTY reader task
    ptys: Mutex<HashMap<String, mpsc::UnboundedSender<PtyCmd>>>,
    /// session_id → PTY reader task 的句柄，用于断开/重连时强制终止旧任务
    tasks: Mutex<HashMap<String, tokio::task::JoinHandle<()>>>,
    /// session_id → client handle (for exec / disconnect)。
    /// 复用同一条 SSH 传输时，多个 session 共享同一个 slot。
    handles: Mutex<HashMap<String, SharedHandle>>,
    host_by_session: Mutex<HashMap<String, String>>,
    /// host_id → 连接池（会话复用：多 Tab 共享同一 SSH 连接）
    pool: Mutex<HashMap<String, PoolEntry>>,
    remote_forwards: Arc<Mutex<HashMap<String, RemoteForwardTarget>>>,
    /// prompt_id → channel to resolve a pending keyboard-interactive (TOTP) prompt
    pending_auth: Mutex<HashMap<String, oneshot::Sender<Vec<String>>>>,
    /// sudo 自动填充开关（可关，设置页控制）
    sudo_autofill: Arc<AtomicBool>,
    /// session_id → 连接时使用的密码（仅内存，用于 sudo 自动填充）
    sudo_passwords: Arc<Mutex<HashMap<String, String>>>,
}

impl SshManager {
    pub fn new(app: AppHandle, hostkey: HostKeyResolver) -> Self {
        Self {
            app,
            hostkey,
            ptys: Mutex::new(HashMap::new()),
            tasks: Mutex::new(HashMap::new()),
            handles: Mutex::new(HashMap::new()),
            host_by_session: Mutex::new(HashMap::new()),
            pool: Mutex::new(HashMap::new()),
            remote_forwards: Arc::new(Mutex::new(HashMap::new())),
            pending_auth: Mutex::new(HashMap::new()),
            sudo_autofill: Arc::new(AtomicBool::new(true)),
            sudo_passwords: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// 设置 sudo 自动填充开关。
    pub fn set_sudo_autofill(&self, enabled: bool) {
        self.sudo_autofill
            .store(enabled, std::sync::atomic::Ordering::Relaxed);
    }

    /// 是否启用 sudo 自动填充。
    pub fn sudo_autofill_enabled(&self) -> bool {
        self.sudo_autofill.load(std::sync::atomic::Ordering::Relaxed)
    }

    pub async fn open_sftp(&self, session_id: &str) -> Result<SftpSession, SshError> {
        let slot = self
            .handles
            .lock()
            .await
            .get(session_id)
            .cloned()
            .ok_or_else(|| SshError::SessionNotFound(session_id.to_string()))?;
        let handle = slot.lock().await;
        let channel = handle
            .channel_open_session()
            .await
            .map_err(|e| SshError::Channel(format!("open sftp channel: {e}")))?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|e| SshError::Channel(format!("request sftp subsystem: {e}")))?;
        let session = SftpSession::new(channel.into_stream())
            .await
            .map_err(|e| SshError::Channel(format!("start sftp session: {e}")))?;
        drop(handle);
        Ok(session)
    }

    async fn authenticate(
        &self,
        client: &mut Handle<SessionHandler>,
        host: &Host,
        password: Option<&str>,
    ) -> Result<bool, SshError> {
        // 1) try the user's running ssh-agent.
        if Self::auth_with_agent(client, &host.user).await? {
            return Ok(true);
        }
        // 2) try public key auth with default ~/.ssh keys (G5 — keychain
        //    private keys arrive in a later pass)
        if Self::auth_with_keys(client, &host.user, &host.address, host.port).await? {
            return Ok(true);
        }
        // 3) password auth
        match password {
            Some(pw) => {
                if matches!(
                    client
                        .authenticate_password(&host.user, pw)
                        .await
                        .map_err(|e| SshError::Auth(e.to_string()))?,
                    AuthResult::Success
                ) {
                    return Ok(true);
                }
            }
            None => {
                if matches!(
                    client
                        .authenticate_none(&host.user)
                        .await
                        .map_err(|e| SshError::Auth(e.to_string()))?,
                    AuthResult::Success
                ) {
                    return Ok(true);
                }
            }
        }
        // 4) keyboard-interactive (TOTP 2FA / challenge-response) — commonly
        //    used for password+TOTP servers (e.g. Google Authenticator PAM).
        self.auth_keyboard_interactive(client, host).await
    }

    /// Keyboard-interactive authentication with user prompts bridged to the
    /// frontend via `ssh:auth-request` and resolved by `ssh_auth_respond`.
    async fn auth_keyboard_interactive(
        &self,
        client: &mut Handle<SessionHandler>,
        host: &Host,
    ) -> Result<bool, SshError> {
        loop {
            match client
                .authenticate_keyboard_interactive_start(&host.user, None)
                .await
            {
                Ok(KeyboardInteractiveAuthResponse::Success) => return Ok(true),
                Ok(KeyboardInteractiveAuthResponse::Failure { .. }) => return Ok(false),
                Ok(KeyboardInteractiveAuthResponse::InfoRequest { name, instructions, prompts }) => {
                    let prompt_id = uuid::Uuid::new_v4().simple().to_string();
                    let (tx, rx) = oneshot::channel();
                    self.pending_auth.lock().await.insert(prompt_id.clone(), tx);
                    let _ = self.app.emit(
                        "ssh:auth-request",
                        serde_json::json!({
                            "promptId": prompt_id,
                            "hostId": host.id,
                            "name": name,
                            "instructions": instructions,
                            "prompts": prompts.iter().map(|p| p.prompt.clone()).collect::<Vec<_>>(),
                            "echo": prompts.iter().any(|p| p.echo),
                        }),
                    );
                    let answers = match tokio::time::timeout(std::time::Duration::from_secs(120), rx)
                        .await
                    {
                        Ok(Ok(answers)) => answers,
                        _ => {
                            self.pending_auth.lock().await.remove(&prompt_id);
                            return Err(SshError::Auth(
                                "二次验证码（TOTP）输入超时（120 秒）".to_string(),
                            ));
                        }
                    };
                    match client.authenticate_keyboard_interactive_respond(answers).await {
                        Ok(KeyboardInteractiveAuthResponse::Success) => return Ok(true),
                        Ok(KeyboardInteractiveAuthResponse::InfoRequest { .. }) => continue,
                        _ => return Ok(false),
                    }
                }
                Err(e) => return Err(SshError::Auth(format!("keyboard-interactive auth: {e}"))),
            }
        }
    }

    /// Resolve a pending keyboard-interactive (TOTP) prompt from the frontend.
    pub async fn resolve_auth(&self, prompt_id: &str, answers: Vec<String>) -> Result<(), SshError> {
        let tx = self
            .pending_auth
            .lock()
            .await
            .remove(prompt_id)
            .ok_or_else(|| SshError::Auth("prompt not found or expired".to_string()))?;
        let _ = tx.send(answers);
        Ok(())
    }

    /// 广播终端（P1）：把同一段输入写入多个会话的 PTY。
    pub async fn broadcast(&self, session_ids: &[String], data: &[u8]) -> Result<usize, SshError> {
        let ptys = self.ptys.lock().await;
        let mut sent = 0usize;
        for sid in session_ids {
            if let Some(tx) = ptys.get(sid) {
                if tx.send(PtyCmd::Data(data.to_vec())).is_ok() {
                    sent += 1;
                }
            }
        }
        Ok(sent)
    }

    async fn auth_with_agent<H: Handler>(
        client: &mut Handle<H>,
        user: &str,
    ) -> Result<bool, SshError> {
        let Some(socket) = std::env::var_os("SSH_AUTH_SOCK") else { return Ok(false); };
        let stream = match tokio::net::UnixStream::connect(socket).await {
            Ok(stream) => stream,
            Err(_) => return Ok(false),
        };
        let mut agent = russh::keys::agent::client::AgentClient::connect(stream);
        let identities = agent.request_identities().await.map_err(|e| SshError::Auth(format!("ssh-agent identities: {e}")))?;
        for key in identities {
            match client.authenticate_publickey_with(user, key, None, &mut agent).await {
                Ok(AuthResult::Success) => return Ok(true),
                Ok(_) => continue,
                Err(e) => tracing::debug!(err = %e, "ssh-agent key rejected"),
            }
        }
        Ok(false)
    }

    /// Try `~/.ssh/id_ed25519` / `id_ecdsa` / `id_rsa` (unencrypted) as the
    /// authentication identity. Returns true on first success.
    async fn auth_with_keys<H: Handler>(
        client: &mut Handle<H>,
        user: &str,
        address: &str,
        port: u16,
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
        let account = crate::infra::keychain::account_for(user, address, port);
        if let Ok(pem) = crate::infra::keychain::load_private_key(&account) {
            if let Ok(key) = decode_secret_key(&pem, None) {
                let key = PrivateKeyWithHashAlg::new(std::sync::Arc::new(key), None);
                if matches!(client.authenticate_publickey(user, key).await, Ok(AuthResult::Success)) {
                    return Ok(true);
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
            host: host.address.clone(),
            port: host.port,
            hostkey: self.hostkey.clone(),
            remote_forwards: self.remote_forwards.clone(),
        };

        // keepalive every 15s → network drop is detected within ~30-45s and
        // the session's `disconnected` event fires so the frontend can
        // auto-reconnect. keepalive_max (default 3) closes the connection
        // after that many unanswered keepalives.
        let config = Arc::new(Config {
            keepalive_interval: Some(std::time::Duration::from_secs(15)),
            ..Config::default()
        });

        tracing::info!(
            host = %host.address,
            port = host.port,
            jump = host.jump_host.as_deref().unwrap_or("-"),
            "ssh: establish transport (direct or via jump)"
        );
        let mut client = tokio::time::timeout(
            std::time::Duration::from_secs(130),
            self.open_transport(host, config, handler),
        )
        .await
        .map_err(|_| {
            SshError::Connect(format!(
                "握手超时：{}:{}（130 秒），主机密钥确认未完成或服务端未响应",
                host.address, host.port
            ))
        })??;

        tracing::info!(host = %host.address, "ssh: handshake ok, authenticating (10s)");
        let authenticated = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            self.authenticate(&mut client, host, password),
        )
        .await
        .map_err(|_| {
            SshError::Auth(format!(
                "认证超时：{}@{} 未响应（10 秒）",
                host.user, host.address
            ))
        })??;
        if !authenticated {
            return Err(SshError::Auth(format!(
                "authentication failed for {}@{}:{}",
                host.user, host.address, host.port
            )));
        }
        tracing::info!(host = %host.address, "ssh: authenticated");

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

    /// Establish the SSH transport to `host`. When the host is reachable only
    /// through a jump (bastion) host, the target connection is tunnelled over
    /// a direct-tcpip channel opened on the jump connection — application-level
    /// ProxyJump, no external ssh binary required.
    async fn open_transport(
        &self,
        host: &Host,
        config: Arc<Config>,
        handler: SessionHandler,
    ) -> Result<Handle<SessionHandler>, SshError> {
        let Some(jump) = host.jump_host.clone() else {
            // direct path: bound TCP connect (unreachable host fails fast, 10s)
            tracing::info!(host = %host.address, port = host.port, "ssh: tcp connect (10s)");
            return self
                .connect_tcp(&host.address, host.port, config, handler)
                .await;
        };

        // --- jump (bastion) path ---
        let jump_port = host.jump_port.unwrap_or(22);
        let jump_user = host
            .jump_user
            .clone()
            .unwrap_or_else(|| host.user.clone());
        tracing::info!(jump = %jump, jump_port, "ssh: connecting via jump host");
        let jump_handler = JumpHandler {
            hostkey: self.hostkey.clone(),
            host: jump.clone(),
            port: jump_port,
        };
        let mut jump_client = self
            .connect_tcp(&jump, jump_port, config.clone(), jump_handler)
            .await
            .map_err(|e| {
                SshError::Connect(format!("跳板机 {jump}:{jump_port} 连接失败：{e}"))
            })?;
        // authenticate the bastion hop with the same identity as the target
        if !Self::auth_with_agent(&mut jump_client, &jump_user).await? {
            Self::auth_with_keys(&mut jump_client, &jump_user, &jump, jump_port).await?;
        }
        tracing::info!(jump = %jump, "ssh: jump authenticated, opening direct-tcpip to target");
        let channel = tokio::time::timeout(
            std::time::Duration::from_secs(20),
            jump_client.channel_open_direct_tcpip(&host.address, host.port as u32, "localhost", 0u32),
        )
        .await
        .map_err(|_| SshError::Connect("跳板机转发通道超时（20 秒）".to_string()))?
        .map_err(|e| SshError::Connect(format!("跳板机打开目标通道失败：{e}")))?;
        let stream = JumpStream {
            inner: channel.into_stream(),
            _jump: jump_client,
        };
        tracing::info!(target = %host.address, "ssh: jump channel open, handshake target");
        russh::client::connect_stream(config, stream, handler)
            .await
            .map_err(|e| SshError::Connect(e.to_string()))
    }

    /// TCP-connect with a 10s budget, then run the SSH handshake over it.
    async fn connect_tcp<H: Handler<Error = SshError> + Send + 'static>(
        &self,
        host: &str,
        port: u16,
        config: Arc<Config>,
        handler: H,
    ) -> Result<Handle<H>, SshError> {
        let addr = format!("{host}:{port}");
        let stream = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            tokio::net::TcpStream::connect(addr.as_str()),
        )
        .await
        .map_err(|_| {
            SshError::Connect(format!(
                "连接超时：{} 无响应（10 秒），请检查主机地址、网络或防火墙",
                addr
            ))
        })?
        .map_err(|e| SshError::Connect(e.to_string()))?;
        russh::client::connect_stream(config, stream, handler)
            .await
            .map_err(|e| SshError::Connect(e.to_string()))
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
        // 强制终止旧的 PTY reader 任务，避免新旧连接同时向同一 session 发射数据
        if let Some(h) = self.tasks.lock().await.remove(session_id) {
            h.abort();
        }
        self.handles.lock().await.remove(session_id);
        // 旧会话的 sudo 密码可能已失效，重连后不沿用
        self.sudo_passwords.lock().await.remove(session_id);
        // 若原传输已失效，重置连接池，让重连建立一条全新传输
        self.pool.lock().await.remove(&host.id);

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
        let session_id = session_id
            .unwrap_or_else(|| uuid::Uuid::new_v4().simple().to_string());
        let title = format!("{}@{}", host.user, host.address);

        // 会话复用：同一主机已有共享连接则复用，否则新建一条传输并加入连接池。
        // 注意：connect_inner 可能阻塞数十秒（认证/超时），绝不能持锁 await。
        let slot = {
            let existing = {
                let mut pool = self.pool.lock().await;
                if let Some(entry) = pool.get_mut(&host.id) {
                    entry.sessions.insert(session_id.clone());
                    Some(entry.slot.clone())
                } else {
                    None
                }
            };
            match existing {
                Some(slot) => slot,
                None => {
                    let (client, _) = self
                        .connect_inner(host, password, Some(session_id.clone()))
                        .await?;
                    let slot: SharedHandle = Arc::new(Mutex::new(client));
                    let mut pool = self.pool.lock().await;
                    if let Some(entry) = pool.get_mut(&host.id) {
                        // 等待期间另一任务已插入该主机连接：复用已有 slot，丢弃本次新建
                        entry.sessions.insert(session_id.clone());
                        entry.slot.clone()
                    } else {
                        pool.insert(
                            host.id.clone(),
                            PoolEntry {
                                slot: slot.clone(),
                                sessions: std::collections::HashSet::from([session_id.clone()]),
                            },
                        );
                        slot
                    }
                }
            }
        };
        {
            let mut handles = self.handles.lock().await;
            handles.insert(session_id.clone(), slot.clone());
        }

        let session = SshSession {
            session_id: session_id.clone(),
            host_id: host.id.clone(),
            title: title.clone(),
            status: "connected".to_string(),
            started_at: crate::models::now_iso(),
            error: None,
        };

        let client = slot.lock().await;
        let channel = client
            .channel_open_session()
            .await
            .map_err(|e| SshError::Channel(e.to_string()))?;
        channel
            .request_pty(false, "xterm-256color", cols, rows, 0, 0, &[])
            .await
            .map_err(|e| SshError::Channel(e.to_string()))?;
        // Agent 转发默认关闭：避免将本机 SSH Agent socket 暴露给远端
        // （CVE-2016-10009 类风险）。DevDeck 使用密码/私钥文件认证，无需转发。
        let _ = channel.agent_forward(false).await;
        channel
            .exec(true, "$SHELL")
            .await
            .map_err(|e| SshError::Channel(e.to_string()))?;

        let (mut read_half, write_half) = channel.split();
        let (tx, mut rx) = mpsc::unbounded_channel::<PtyCmd>();

        // 仅当 sudo 自动填充开启时才缓存密码（仅内存），关闭时不为暴露面留明文
        if let Some(pw) = password {
            if self.sudo_autofill.load(std::sync::atomic::Ordering::Relaxed) {
                self.sudo_passwords
                    .lock()
                    .await
                    .insert(session_id.clone(), pw.to_string());
            }
        }

        let app = self.app.clone();
        let session_for_task = session.clone();
        let session_id_task = session_id.clone();
        let sudo_passwords = self.sudo_passwords.clone();
        let sudo_autofill = self.sudo_autofill.clone();
        let tx_task = tx.clone();
        let handle = tokio::spawn(async move {
            loop {
                tokio::select! {
                    msg = read_half.wait() => {
                        match msg {
                            Some(ChannelMsg::Data { data }) => {
                                let text = String::from_utf8_lossy(&data).to_string();
                                maybe_autofill_sudo(
                                    &text,
                                    &sudo_autofill,
                                    &sudo_passwords,
                                    &session_id_task,
                                    &tx_task,
                                    &app,
                                ).await;
                                let event = format!("term:data:{session_id_task}");
                                let _ = app.emit(event.as_str(), text);
                            }
                            Some(ChannelMsg::ExtendedData { data, .. }) => {
                                let text = String::from_utf8_lossy(&data).to_string();
                                maybe_autofill_sudo(
                                    &text,
                                    &sudo_autofill,
                                    &sudo_passwords,
                                    &session_id_task,
                                    &tx_task,
                                    &app,
                                ).await;
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
        drop(client);

        self.ptys.lock().await.insert(session_id.clone(), tx);
        self.tasks.lock().await.insert(session_id.clone(), handle);
        self.host_by_session.lock().await.insert(session_id.clone(), host.id.clone());
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

    pub async fn exec_command(&self, session_id: &str, command: &str) -> Result<String, SshError> {
        let slot = self
            .handles
            .lock()
            .await
            .get(session_id)
            .cloned()
            .ok_or_else(|| SshError::SessionNotFound(session_id.to_string()))?;
        let mut channel = {
            let handle = slot.lock().await;
            let ch = handle
                .channel_open_session()
                .await
                .map_err(|e| SshError::Channel(format!("open exec channel: {e}")))?;
            // 立即释放共享连接锁：命令执行期间不阻塞其他标签页/SFTP/转发
            ch
        };
        channel
            .exec(true, command)
            .await
            .map_err(|e| SshError::Channel(format!("exec command: {e}")))?;
        let mut output = Vec::new();
        while let Some(message) = channel.wait().await {
            if let ChannelMsg::Data { data } = message {
                output.extend_from_slice(&data);
            }
        }
        String::from_utf8(output).map_err(|e| SshError::Channel(format!("exec output is not utf8: {e}")))
    }

    pub async fn exec_for_host(&self, host_id: &str, command: &str) -> Result<String, SshError> {
        let session_id = self
            .host_by_session
            .lock()
            .await
            .iter()
            .find_map(|(session_id, current_host)| (current_host == host_id).then_some(session_id.clone()))
            .ok_or_else(|| SshError::SessionNotFound(format!("no active session for host {host_id}")))?;
        self.exec_command(&session_id, command).await
    }

    /// 打开一条非 PTY 的 exec 通道（供 ZMODEM 等二进制协议使用）。
    pub async fn open_exec_channel(
        &self,
        host_id: &str,
        command: &str,
    ) -> Result<russh::Channel<russh::client::Msg>, SshError> {
        let session_id = self
            .host_by_session
            .lock()
            .await
            .iter()
            .find_map(|(sid, current_host)| (current_host == host_id).then_some(sid.clone()))
            .ok_or_else(|| SshError::SessionNotFound(format!("no active session for host {host_id}")))?;
        let slot = self
            .handles
            .lock()
            .await
            .get(&session_id)
            .cloned()
            .ok_or_else(|| SshError::SessionNotFound(session_id.to_string()))?;
        let handle = slot.lock().await;
        let channel = handle
            .channel_open_session()
            .await
            .map_err(|e| SshError::Channel(format!("open exec channel: {e}")))?;
        channel
            .exec(true, command)
            .await
            .map_err(|e| SshError::Channel(format!("exec command: {e}")))?;
        Ok(channel)
    }

    pub async fn active_host_ids(&self) -> Vec<String> {
        self.host_by_session.lock().await.values().cloned().collect()
    }

    /// 主机进程列表（P2）— 复用活跃 SSH 会话执行 `ps`，解析为结构化数据。
    /// 需主机当前存在连接（与无 Agent 监控一致的前置条件）。
    pub async fn list_processes(&self, host_id: &str) -> Result<Vec<crate::models::HostProcess>, SshError> {
        let output = self
            .exec_for_host(
                host_id,
                "ps -eo pid,ppid,user,%cpu,%mem,rss,etime,args --sort=-%cpu | head -100",
            )
            .await?;
        Ok(parse_processes(host_id, &output))
    }

    pub async fn start_remote_forward(
        &self,
        host_id: &str,
        listen_addr: &str,
        listen_port: u16,
        local_host: &str,
        local_port: u16,
    ) -> Result<u16, SshError> {
        let session_id = self
            .host_by_session
            .lock()
            .await
            .iter()
            .find_map(|(session_id, current_host)| (current_host == host_id).then_some(session_id.clone()))
            .ok_or_else(|| SshError::SessionNotFound(format!("no active session for host {host_id}")))?;
        let slot = self
            .handles
            .lock()
            .await
            .get(&session_id)
            .cloned()
            .ok_or_else(|| SshError::SessionNotFound(session_id.clone()))?;
        let mut handle = slot.lock().await;
        let bound_port = handle.tcpip_forward(listen_addr.to_string(), listen_port as u32).await
            .map_err(|e| SshError::Channel(format!("request remote forwarding: {e}")))? as u16;
        self.remote_forwards.lock().await.insert(session_id, RemoteForwardTarget {
            local_host: local_host.to_string(), local_port,
        });
        Ok(if bound_port == 0 { listen_port } else { bound_port })
    }

    pub async fn stop_remote_forward(&self, host_id: &str, listen_addr: &str, listen_port: u16) -> Result<(), SshError> {
        let session_id = self
            .host_by_session
            .lock()
            .await
            .iter()
            .find_map(|(session_id, current_host)| (current_host == host_id).then_some(session_id.clone()))
            .ok_or_else(|| SshError::SessionNotFound(format!("no active session for host {host_id}")))?;
        let slot = self
            .handles
            .lock()
            .await
            .get(&session_id)
            .cloned()
            .ok_or_else(|| SshError::SessionNotFound(session_id.clone()))?;
        let handle = slot.lock().await;
        handle.cancel_tcpip_forward(listen_addr.to_string(), listen_port as u32).await
            .map_err(|e| SshError::Channel(format!("cancel remote forwarding: {e}")))?;
        self.remote_forwards.lock().await.remove(&session_id);
        Ok(())
    }

    /// 打开到远端 unix socket（如 /var/run/docker.sock）的 direct-streamlocal 通道，
    /// 供远程 Docker 桥接复用当前活跃会话的 SSH 连接。
    pub async fn open_docker_channel(
        &self,
        host_id: &str,
        socket_path: &str,
    ) -> Result<russh::Channel<russh::client::Msg>, SshError> {
        let session_id = self
            .host_by_session
            .lock()
            .await
            .iter()
            .find_map(|(session_id, current_host)| (current_host == host_id).then_some(session_id.clone()))
            .ok_or_else(|| SshError::SessionNotFound(format!("no active session for host {host_id}")))?;
        let slot = self
            .handles
            .lock()
            .await
            .get(&session_id)
            .cloned()
            .ok_or_else(|| SshError::SessionNotFound(session_id.clone()))?;
        let handle = slot.lock().await;
        let channel = handle
            .channel_open_direct_streamlocal(socket_path)
            .await
            .map_err(|e| SshError::Channel(format!("open streamlocal {socket_path}: {e}")))?;
        Ok(channel)
    }

    pub async fn proxy_local_connection(
        &self,
        host_id: &str,
        mut local: tokio::net::TcpStream,
        remote_host: &str,
        remote_port: u16,
    ) -> Result<(u64, u64), SshError> {
        let session_id = self
            .host_by_session
            .lock()
            .await
            .iter()
            .find_map(|(session_id, current_host)| (current_host == host_id).then_some(session_id.clone()))
            .ok_or_else(|| SshError::SessionNotFound(format!("no active session for host {host_id}")))?;
        let slot = self
            .handles
            .lock()
            .await
            .get(&session_id)
            .cloned()
            .ok_or_else(|| SshError::SessionNotFound(session_id.clone()))?;
        let handle = slot.lock().await;
        let mut channel = handle
            .channel_open_direct_tcpip(remote_host, remote_port as u32, "127.0.0.1", 0)
            .await
            .map_err(|e| SshError::Channel(format!("open forwarding channel: {e}")))?;
        drop(handle);

        let mut local_to_remote = 0_u64;
        let mut remote_to_local = 0_u64;
        let mut buf = vec![0_u8; 64 * 1024];
        let mut local_closed = false;
        loop {
            tokio::select! {
                result = local.read(&mut buf), if !local_closed => {
                    match result {
                        Ok(0) => { local_closed = true; channel.eof().await.map_err(|e| SshError::Channel(e.to_string()))?; }
                        Ok(n) => { local_to_remote += n as u64; channel.data(&buf[..n]).await.map_err(|e| SshError::Channel(e.to_string()))?; }
                        Err(e) => return Err(SshError::Channel(e.to_string())),
                    }
                }
                message = channel.wait() => {
                    match message {
                        Some(ChannelMsg::Data { data }) => {
                            remote_to_local += data.len() as u64;
                            local.write_all(&data).await.map_err(|e| SshError::Channel(e.to_string()))?;
                        }
                        Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                        _ => {}
                    }
                }
            }
        }
        Ok((local_to_remote, remote_to_local))
    }

    pub async fn disconnect(&self, session_id: &str) -> Result<(), SshError> {
        self.ptys.lock().await.remove(session_id);
        // 强制终止 PTY reader 任务，避免残留后台任务继续发射事件
        if let Some(h) = self.tasks.lock().await.remove(session_id) {
            h.abort();
        }
        // 断开后立即清除内存中的 sudo 密码，避免明文残留
        self.sudo_passwords.lock().await.remove(session_id);
        let host_id = self.host_by_session.lock().await.remove(session_id);
        let slot = self.handles.lock().await.remove(session_id);
        let mut released = false;
        // 会话复用：仅释放该会话对共享连接的引用；当主机再无会话时才真正断开传输
        if let Some(host_id) = host_id {
            let mut pool = self.pool.lock().await;
            if let Some(entry) = pool.get_mut(&host_id) {
                entry.sessions.remove(session_id);
                if entry.sessions.is_empty() {
                    if let Some(entry) = pool.remove(&host_id) {
                        let handle = entry.slot.lock().await;
                        let _ = handle
                            .disconnect(Disconnect::ByApplication, "no active sessions", "")
                            .await;
                    }
                }
                released = true; // 由池管理，不再单独 disconnect
            }
        }
        if !released {
            if let Some(slot) = slot {
                let handle = slot.lock().await;
                let _ = handle
                    .disconnect(Disconnect::ByApplication, "user disconnect", "")
                    .await;
            }
        }
        Ok(())
    }
}

/// Parse `ps -eo pid,ppid,user,%cpu,%mem,rss,etime,args` output.
/// The command (last column) may contain spaces, so it is joined from the
/// remaining tokens after the fixed-width numeric columns.
fn parse_processes(host_id: &str, output: &str) -> Vec<crate::models::HostProcess> {
    let mut out = Vec::new();
    for line in output.lines().skip(1) {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let mut it = line.split_whitespace();
        let (Some(pid), Some(ppid), Some(user), Some(cpu), Some(mem), Some(rss), Some(etime)) = (
            it.next(),
            it.next(),
            it.next(),
            it.next(),
            it.next(),
            it.next(),
            it.next(),
        ) else {
            continue;
        };
        let command = it.collect::<Vec<_>>().join(" ");
        let (Ok(pid), Ok(ppid), Ok(cpu_percent), Ok(mem_percent), Ok(rss_kb)) = (
            pid.parse::<u32>(),
            ppid.parse::<u32>(),
            cpu.parse::<f64>(),
            mem.parse::<f64>(),
            rss.parse::<u64>(),
        ) else {
            continue;
        };
        out.push(crate::models::HostProcess {
            host_id: host_id.to_string(),
            pid,
            ppid,
            user: user.to_string(),
            cpu_percent,
            mem_percent,
            rss_kb,
            etime: etime.to_string(),
            command,
        });
    }
    out
}

// ---------------------------------------------------------------------------
// sudo 密码自动填充
// ---------------------------------------------------------------------------

/// 判断输出是否为 sudo 密码提示。
/// 保守匹配 `[sudo] password for`，避免误填其他程序自身的密码提示。
fn looks_like_sudo_prompt(text: &str) -> bool {
    let lower = text.to_lowercase();
    lower.contains("[sudo] password for")
}

/// 若命中 sudo 提示且该会话缓存了连接密码，自动回填 `密码\r`，
/// 并通过 `term:notice:{sessionId}` 告知前端（可选 UI 提示）。
async fn maybe_autofill_sudo(
    text: &str,
    enabled: &AtomicBool,
    passwords: &Mutex<HashMap<String, String>>,
    session_id: &str,
    tx: &mpsc::UnboundedSender<PtyCmd>,
    app: &AppHandle,
) {
    if !enabled.load(Ordering::Relaxed) {
        return;
    }
    if !looks_like_sudo_prompt(text) {
        return;
    }
    let pw = passwords.lock().await.get(session_id).cloned();
    if let Some(pw) = pw {
        let _ = tx.send(PtyCmd::Data(format!("{pw}\r").into_bytes()));
        let _ = app.emit(&format!("term:notice:{session_id}"), "已自动填充 sudo 密码");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sudo_prompt_detection_matches_sudo_hint() {
        assert!(looks_like_sudo_prompt("[sudo] password for zhfb: "));
        assert!(looks_like_sudo_prompt("We trust you have received the usual lecture...\r\n[sudo] password for root:"));
    }

    #[test]
    fn sudo_prompt_detection_is_case_insensitive() {
        assert!(looks_like_sudo_prompt("[SUDO] Password For admin: "));
    }

    #[test]
    fn sudo_prompt_detection_does_not_match_other_password_prompts() {
        // 其他程序自身的密码提示不应被误判为 sudo
        assert!(!looks_like_sudo_prompt("Password: "));
        assert!(!looks_like_sudo_prompt("password for root: "));
        assert!(!looks_like_sudo_prompt("Enter passphrase for key '/Users/zhfb99/.ssh/id_ed25519':"));
    }

    #[test]
    fn sudo_prompt_detection_ignores_normal_shell_output() {
        assert!(!looks_like_sudo_prompt("zhfb@macbook ~ % ls -la"));
        assert!(!looks_like_sudo_prompt("total 16\ndrwxr-xr-x  zhfb99  staff"));
        assert!(!looks_like_sudo_prompt(""));
    }
}
