//! ZMODEM 文件传输（P2）— 经活跃 SSH 会话的 exec 通道运行远端 `rz`/`sz`，
//! 用 zmodem2 状态机驱动协议，支持上传（本地 → 远端）与下载（远端 → 本地）。
//!
//! 约束：单文件 ≤ 4GB（zmodem2 以 u32 偏移）；远端需已安装 lrzsz。

use std::path::Path;
use std::sync::Arc;

use russh::ChannelMsg;
use tokio::io::AsyncWriteExt;
use zmodem2::{Action, Event, FileInfo, Receiver, Sender};

use crate::services::ssh::{SshError, SshManager};

const ZMODEM_TIMEOUT_SECS: u64 = 20;

pub struct ZmodemManager {
    ssh: Arc<SshManager>,
}

impl ZmodemManager {
    pub fn new(ssh: Arc<SshManager>) -> Self {
        Self { ssh }
    }

    /// 上传：本地文件 → 远端目录（远端执行 `rz -b -e`，本地作 Sender）。
    pub async fn upload(&self, host_id: &str, local_path: &str, remote_dir: &str) -> Result<String, SshError> {
        let local = Path::new(local_path);
        let data = tokio::fs::read(local).await.map_err(|e| SshError::Io(e.to_string()))?;
        if data.len() > u32::MAX as usize {
            return Err(SshError::Io("文件超过 4GB，ZMODEM 暂不支持".to_string()));
        }
        let name = local
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("upload.bin")
            .to_string();
        let cmd = format!("cd {} 2>/dev/null && rz -b -e; echo", shell_quote(remote_dir));
        let mut channel = self.ssh.open_exec_channel(host_id, &cmd).await?;

        let mut sender = Sender::new().map_err(|e| SshError::Io(format!("zmodem sender: {e}")))?;
        // SSH 是可靠、流控良好的传输：提高流式窗口减少往返等待
        sender.set_streaming_window(64);
        sender
            .start_file(FileInfo::new(name.as_bytes(), Some((data.len() as u32).into())))
            .map_err(|e| SshError::Io(format!("zmodem start_file: {e}")))?;

        let mut done = false;
        let mut tail = Vec::new();
        while !done {
            match sender.poll() {
                Action::WriteWire(bytes) => {
                    let v = bytes.to_vec();
                    channel.data(v.as_slice()).await.map_err(|e| SshError::Channel(e.to_string()))?;
                    sender.wire_written(v.len());
                }
                Action::ReadFile { offset, max_len } => {
                    let start = offset.get() as usize;
                    let end = (start + max_len).min(data.len());
                    let chunk = data[start..end].to_vec();
                    sender
                        .submit_file(&chunk)
                        .map_err(|e| SshError::Io(format!("zmodem submit_file: {e}")))?;
                }
                Action::Event(ev) => match ev {
                    Event::FileCompleted => {
                        let _ = sender.finish();
                    }
                    Event::SessionCompleted => done = true,
                    Event::Aborted => return Err(SshError::Io("ZMODEM 传输被对方中止".to_string())),
                    Event::FileStarted(_) => {}
                    _ => {}
                },
                Action::Idle => match tokio::time::timeout(
                    std::time::Duration::from_secs(ZMODEM_TIMEOUT_SECS),
                    channel.wait(),
                )
                .await
                {
                    Ok(Some(ChannelMsg::Data { data })) => {
                        let _ = sender.submit_wire(&data).map_err(|e| {
                            SshError::Io(format!("zmodem submit_wire: {e}"))
                        });
                    }
                    Ok(Some(ChannelMsg::Eof)) | Ok(Some(ChannelMsg::Close)) | Ok(None) => {
                        sender.abort();
                        done = true;
                    }
                    Ok(_) => {}
                    Err(_) => {
                        let _ = sender.timeout();
                    }
                },
                _ => {}
            }
        }
        let _ = channel.eof().await;
        // 收集远端 rz 的尾部输出（统计信息等）
        while let Ok(Some(msg)) = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            channel.wait(),
        )
        .await
        {
            match msg {
                ChannelMsg::Data { data } => tail.extend_from_slice(&data),
                _ => break,
            }
        }
        let tail_text = String::from_utf8_lossy(&tail).trim().to_string();
        Ok(if tail_text.is_empty() {
            format!("ZMODEM 上传完成：{name} → {remote_dir}/")
        } else {
            format!("ZMODEM 上传完成：{name}（远端输出：{}）", tail_text.lines().next().unwrap_or(""))
        })
    }

    /// 下载：远端文件 → 本地目录（远端执行 `sz -b -e`，本地作 Receiver）。
    pub async fn download(&self, host_id: &str, remote_path: &str, local_dir: &str) -> Result<String, SshError> {
        let cmd = format!("sz -b -e {}", shell_quote(remote_path));
        let mut channel = self.ssh.open_exec_channel(host_id, &cmd).await?;

        let mut receiver = Receiver::with_flow_control(0, true)
            .map_err(|e| SshError::Io(format!("zmodem receiver: {e}")))?;
        let mut out: Option<tokio::fs::File> = None;
        let mut saved_name = String::new();
        let mut done = false;
        let mut tail = Vec::new();

        while !done {
            match receiver.poll() {
                Action::WriteWire(bytes) => {
                    let v = bytes.to_vec();
                    channel.data(v.as_slice()).await.map_err(|e| SshError::Channel(e.to_string()))?;
                    receiver.wire_written(v.len());
                }
                Action::WriteFile(bytes) => {
                    let v = bytes.to_vec();
                    if let Some(f) = out.as_mut() {
                        f.write_all(&v).await.map_err(|e| SshError::Io(e.to_string()))?;
                    }
                    receiver
                        .file_written(v.len())
                        .map_err(|e| SshError::Io(format!("zmodem file_written: {e}")))?;
                }
                Action::Event(ev) => match ev {
                    Event::FileStarted(info) => {
                        let raw = String::from_utf8_lossy(info.name).into_owned();
                        saved_name = Path::new(&raw)
                            .file_name()
                            .and_then(|s| s.to_str())
                            .unwrap_or("download.bin")
                            .to_string();
                        let target = Path::new(local_dir).join(&saved_name);
                        out = Some(
                            tokio::fs::File::create(&target)
                                .await
                                .map_err(|e| SshError::Io(e.to_string()))?,
                        );
                    }
                    Event::FileCompleted => {
                        out = None;
                    }
                    Event::SessionCompleted => done = true,
                    Event::Aborted => return Err(SshError::Io("ZMODEM 接收被对方中止".to_string())),
                    _ => {}
                },
                Action::Idle => match tokio::time::timeout(
                    std::time::Duration::from_secs(ZMODEM_TIMEOUT_SECS),
                    channel.wait(),
                )
                .await
                {
                    Ok(Some(ChannelMsg::Data { data })) => {
                        let _ = receiver.submit_wire(&data).map_err(|e| {
                            SshError::Io(format!("zmodem submit_wire: {e}"))
                        });
                    }
                    Ok(Some(ChannelMsg::Eof)) | Ok(Some(ChannelMsg::Close)) | Ok(None) => {
                        let _ = receiver.abort();
                        done = true;
                    }
                    Ok(_) => {}
                    Err(_) => {
                        let _ = receiver.timeout();
                    }
                },
                _ => {}
            }
        }
        let _ = channel.eof().await;
        while let Ok(Some(msg)) = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            channel.wait(),
        )
        .await
        {
            match msg {
                ChannelMsg::Data { data } => tail.extend_from_slice(&data),
                _ => break,
            }
        }
        let tail_text = String::from_utf8_lossy(&tail).trim().to_string();
        Ok(if tail_text.is_empty() {
            format!("ZMODEM 下载完成：{remote_path} → {local_dir}/{saved_name}")
        } else {
            format!(
                "ZMODEM 下载完成：{saved_name}（远端输出：{}）",
                tail_text.lines().next().unwrap_or("")
            )
        })
    }
}

/// 单引号 shell 转义（与 compose.rs 一致）
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}
