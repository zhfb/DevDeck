//! 本地终端：打开 macOS 本地 shell（PTY）。
//!
//! 复用与 SSH 会话相同的前端协议：
//! - 输出：emit `term:data:{sessionId}`（UTF-8 lossy）
//! - 输入 / 尺寸：由命令层 `local_term_input` / `local_term_resize` 转发
//!
//! 实现基于 portable-pty（forkpty / posix_openpt），读线程为阻塞式，
//! 放到独立 std::thread 中，输出经 Tauri event 广播给前端。
//!
//! shell 自然退出时（EOF）读线程会回收子进程（`child.wait()`）并通知
//! 后台清理任务移除 sessions 映射，避免僵尸进程与无限增长的会话表。

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, Mutex as TokioMutex};
use uuid::Uuid;

#[derive(Debug, thiserror::Error)]
pub enum LocalPtyError {
    #[error("open pty failed: {0}")]
    Open(String),
    #[error("spawn shell failed: {0}")]
    Spawn(String),
    #[error("session not found: {0}")]
    NotFound(String),
    #[error("pty error: {0}")]
    Pty(String),
}

struct LocalSession {
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    child: Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
    running: Arc<AtomicBool>,
}

pub struct LocalPtyManager {
    app: AppHandle,
    sessions: Arc<TokioMutex<HashMap<String, LocalSession>>>,
    cleanup_tx: mpsc::UnboundedSender<String>,
}

impl LocalPtyManager {
    pub fn new(app: AppHandle) -> Self {
        let (cleanup_tx, mut cleanup_rx) = mpsc::unbounded_channel::<String>();
        let sessions: Arc<TokioMutex<HashMap<String, LocalSession>>> =
            Arc::new(TokioMutex::new(HashMap::new()));

        // 后台清理任务：shell 自然退出后回收子进程并移除会话映射。
        // 注意：`new()` 可能在 tokio runtime 外被调用，须用 Tauri 的 async_runtime。
        {
            let sessions = sessions.clone();
            tauri::async_runtime::spawn(async move {
                while let Some(session_id) = cleanup_rx.recv().await {
                    if let Some(s) = sessions.lock().await.remove(&session_id) {
                        s.running.store(false, Ordering::Relaxed);
                        if let Ok(mut child) = s.child.lock() {
                            let _ = child.wait();
                        }
                    }
                }
            });
        }

        Self {
            app,
            sessions,
            cleanup_tx,
        }
    }

    /// 启动一个本地 shell 会话，返回 sessionId。
    pub async fn start(&self, cols: u32, rows: u32) -> Result<String, LocalPtyError> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: rows.max(2) as u16,
                cols: cols.max(2) as u16,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| LocalPtyError::Open(e.to_string()))?;

        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        let mut cmd = CommandBuilder::new(&shell);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("LANG", std::env::var("LANG").unwrap_or_else(|_| "en_US.UTF-8".into()));
        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| LocalPtyError::Spawn(e.to_string()))?;
        drop(pair.slave);

        let child = Arc::new(Mutex::new(child));

        let master = pair.master;
        let mut reader = master
            .try_clone_reader()
            .map_err(|e| LocalPtyError::Pty(e.to_string()))?;
        let writer = master
            .take_writer()
            .map_err(|e| LocalPtyError::Pty(e.to_string()))?;

        let session_id = Uuid::new_v4().simple().to_string();
        let app = self.app.clone();
        let id_for_task = session_id.clone();
        let running = Arc::new(AtomicBool::new(true));
        let running_for_task = running.clone();
        let child_for_task = child.clone();
        let cleanup_tx = self.cleanup_tx.clone();

        // 阻塞读线程：PTY 输出 → term:data 事件
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if !running_for_task.load(Ordering::Relaxed) {
                            break;
                        }
                        let text = String::from_utf8_lossy(&buf[..n]).to_string();
                        let event = format!("term:data:{id_for_task}");
                        let _ = app.emit(event.as_str(), text);
                    }
                }
            }
            // shell 已退出：回收子进程（避免僵尸）并通知清理任务移除会话
            if let Ok(mut c) = child_for_task.lock() {
                let _ = c.wait();
            }
            let _ = cleanup_tx.send(id_for_task.clone());
            let _ = app.emit(
                "local:status",
                serde_json::json!({
                    "sessionId": id_for_task,
                    "status": "disconnected",
                }),
            );
        });

        self.sessions.lock().await.insert(
            session_id.clone(),
            LocalSession {
                master: Arc::new(Mutex::new(master)),
                writer: Arc::new(Mutex::new(writer)),
                child,
                running,
            },
        );
        Ok(session_id)
    }

    pub async fn input(&self, session_id: &str, data: &[u8]) -> Result<(), LocalPtyError> {
        let sessions = self.sessions.lock().await;
        let s = sessions
            .get(session_id)
            .ok_or_else(|| LocalPtyError::NotFound(session_id.to_string()))?;
        let mut w = s
            .writer
            .lock()
            .map_err(|_| LocalPtyError::Pty("writer lock poisoned".into()))?;
        w.write_all(data)
            .map_err(|e| LocalPtyError::Pty(e.to_string()))?;
        w.flush().map_err(|e| LocalPtyError::Pty(e.to_string()))?;
        Ok(())
    }

    pub async fn resize(&self, session_id: &str, cols: u32, rows: u32) -> Result<(), LocalPtyError> {
        let sessions = self.sessions.lock().await;
        let s = sessions
            .get(session_id)
            .ok_or_else(|| LocalPtyError::NotFound(session_id.to_string()))?;
        let master = s
            .master
            .lock()
            .map_err(|_| LocalPtyError::Pty("master lock poisoned".into()))?;
        master
            .resize(PtySize {
                rows: rows.max(2) as u16,
                cols: cols.max(2) as u16,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| LocalPtyError::Pty(e.to_string()))?;
        Ok(())
    }

    pub async fn stop(&self, session_id: &str) -> Result<(), LocalPtyError> {
        let mut sessions = self.sessions.lock().await;
        if let Some(s) = sessions.remove(session_id) {
            s.running.store(false, Ordering::Relaxed);
            if let Ok(mut child) = s.child.lock() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
        Ok(())
    }
}
