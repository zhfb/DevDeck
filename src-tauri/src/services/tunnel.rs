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
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::infra::db::AppDb;
use crate::models::Tunnel;
use crate::services::ssh::SshManager;
use tokio::task::JoinHandle;
use tokio::net::{TcpListener, TcpStream};

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
    /// tunnel_id → (bytes_local_to_remote, bytes_remote_to_local) live counters
    counters: Arc<Mutex<std::collections::HashMap<String, (u64, u64)>>>,
}

impl TunnelManager {
    pub fn new(db: Arc<Mutex<AppDb>>, ssh: Arc<SshManager>) -> Self {
        Self {
            db,
            ssh,
            tasks: Arc::new(Mutex::new(std::collections::HashMap::new())),
            counters: Arc::new(Mutex::new(std::collections::HashMap::new())),
        }
    }

    pub async fn list(&self) -> Result<Vec<Tunnel>, TunnelError> {
        let db = self.db.lock().await;
        let mut tunnels = db.list_tunnels()?;
        // merge live traffic counters (P1: 端口转发实时流量统计)
        let counters = self.counters.lock().await;
        for t in tunnels.iter_mut() {
            if let Some((bytes_out, bytes_in)) = counters.get(&t.id) {
                t.bytes_in = Some(*bytes_in);
                t.bytes_out = Some(*bytes_out);
            }
        }
        Ok(tunnels)
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
        self.counters.lock().await.remove(id);
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
        // 若该隧道已有运行中的任务，先终止旧的，避免重复监听端口
        if let Some(old) = self.tasks.lock().await.remove(id) {
            old.abort();
        }
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
        if tunnel.type_ != "local" && tunnel.type_ != "socks5" {
            return Err(TunnelError::Forward("仅支持 local / remote / socks5 转发类型".to_string()));
        }
        return self.start_supervised(&tunnel).await;
    }

    /// 监督式转发循环（local / socks5）：bind 监听 + 转发连接，任务因任何
    /// 原因退出（SSH 闪断、端口瞬占、accept 失败等）后，只要隧道仍标记为
    /// active，就按指数退避（2s→4s→…→30s 封顶）自动重建，无需人工干预。
    /// 停止语义：stop() 先把状态置 stopped 再 abort 本监督任务 → 循环看到
    /// 非 active 即退出，不会"死后复活"。
    async fn start_supervised(&self, tunnel: &Tunnel) -> Result<(), TunnelError> {
        let db = self.db.clone();
        let ssh = self.ssh.clone();
        let counters = self.counters.clone();
        let task_id = tunnel.id.clone();
        let host_id = tunnel.host_id.clone();
        let listen_addr = tunnel.listen_addr.clone();
        let listen_port = tunnel.listen_port;
        let remote_host = tunnel.remote_host.clone();
        let remote_port = tunnel.remote_port;
        let type_ = tunnel.type_.clone();

        let handle = tokio::spawn(async move {
            let mut backoff_secs: u64 = 0;
            loop {
                // 退避等待（首轮 0，立即尝试）
                if backoff_secs > 0 {
                    tokio::time::sleep(std::time::Duration::from_secs(backoff_secs)).await;
                }
                // 停止检查：数据库状态必须仍为 active，否则监督循环退出
                let active = {
                    let db = db.lock().await;
                    db.list_tunnels()
                        .ok()
                        .and_then(|ts| ts.into_iter().find(|t| t.id == task_id))
                        .map(|t| t.status == "active")
                        .unwrap_or(false)
                };
                if !active {
                    break;
                }

                let addr = format!("{listen_addr}:{listen_port}");
                let Ok(listener) = TcpListener::bind(&addr).await else {
                    backoff_secs = next_backoff(backoff_secs);
                    continue;
                };
                // bind 成功 → 重置退避，健康隧道闪断后恢复得够快
                backoff_secs = 2;

                // 服务连接，直到 listener 关闭 / 任务被 abort
                loop {
                    let Ok((stream, _)) = listener.accept().await else { break };
                    let ssh = ssh.clone();
                    let host_id = host_id.clone();
                    let counters = counters.clone();
                    let task_id = task_id.clone();
                    let remote_host = remote_host.clone();
                    let type_ = type_.clone();
                    tokio::spawn(async move {
                        let proxied = if type_ == "socks5" {
                            Self::serve_socks5(stream, ssh, &host_id).await
                        } else {
                            ssh.proxy_local_connection(&host_id, stream, &remote_host, remote_port)
                                .await
                                .ok()
                        };
                        if let Some((out, input)) = proxied {
                            let mut c = counters.lock().await;
                            let entry = c.entry(task_id).or_insert((0, 0));
                            entry.0 += out;
                            entry.1 += input;
                        }
                    });
                }
                // accept 循环意外结束 → 退避后重建
                backoff_secs = next_backoff(backoff_secs);
            }
        });

        self.tasks.lock().await.insert(tunnel.id.clone(), handle);
        let db = self.db.lock().await;
        let mut tunnels = db.list_tunnels()?;
        if let Some(t) = tunnels.iter_mut().find(|t| t.id == tunnel.id) {
            t.status = "active".to_string();
            t.started_at = Some(crate::models::now_iso());
            db.upsert_tunnel(t)?;
        }
        Ok(())
    }

    /// RFC 1928 handshake + CONNECT. Returns proxied bytes (out, in) on success.
    async fn serve_socks5(
        mut stream: TcpStream,
        ssh: Arc<SshManager>,
        host_id: &str,
    ) -> Option<(u64, u64)> {
        // greeting: VER(5) NMETHODS METHODS…
        let mut head = [0u8; 2];
        stream.read_exact(&mut head).await.ok()?;
        if head[0] != 0x05 {
            return None;
        }
        let mut methods = vec![0u8; head[1] as usize];
        stream.read_exact(&mut methods).await.ok()?;
        // reply: no-auth
        stream.write_all(&[0x05, 0x00]).await.ok()?;

        // request: VER CMD RSV ATYP … 
        let mut req = [0u8; 4];
        stream.read_exact(&mut req).await.ok()?;
        if req[0] != 0x05 || req[1] != 0x01 {
            // only CONNECT supported
            let _ = stream.write_all(&[0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await;
            return None;
        }
        let (host, port) = match req[3] {
            0x01 => {
                let mut ip = [0u8; 4];
                stream.read_exact(&mut ip).await.ok()?;
                (format!("{}.{}.{}.{}", ip[0], ip[1], ip[2], ip[3]), read_port(&mut stream).await?)
            }
            0x03 => {
                let mut len = [0u8; 1];
                stream.read_exact(&mut len).await.ok()?;
                let mut domain = vec![0u8; len[0] as usize];
                stream.read_exact(&mut domain).await.ok()?;
                (String::from_utf8_lossy(&domain).to_string(), read_port(&mut stream).await?)
            }
            0x04 => {
                let mut ip = [0u8; 16];
                stream.read_exact(&mut ip).await.ok()?;
                let s = ip
                    .chunks(2)
                    .map(|c| format!("{:02x}{:02x}", c[0], c[1]))
                    .collect::<Vec<_>>()
                    .join(":");
                (s, read_port(&mut stream).await?)
            }
            _ => return None,
        };
        // success reply
        let _ = stream.write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await;
        ssh.proxy_local_connection(host_id, stream, &host, port).await.ok()
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
        self.counters.lock().await.remove(id);
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

/// Read a 2-byte big-endian SOCKS5 port.
async fn read_port(stream: &mut TcpStream) -> Option<u16> {
    let mut b = [0u8; 2];
    stream.read_exact(&mut b).await.ok()?;
    Some(u16::from_be_bytes(b))
}

/// 监督循环的退避间隔：0 → 2s → 4s → 8s → … → 30s 封顶。
fn next_backoff(prev: u64) -> u64 {
    if prev == 0 { 2 } else { (prev * 2).min(30) }
}
