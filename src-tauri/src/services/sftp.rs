use std::sync::Arc;
use std::collections::HashSet;

use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::sync::Mutex;
use futures_util::stream::{self, StreamExt};
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::OpenFlags;

use crate::models::SftpEntry;
use crate::services::ssh::{SshError, SshManager};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransferDirection {
    Upload,
    Download,
}

impl TransferDirection {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Upload => "upload",
            Self::Download => "download",
        }
    }
}

#[derive(Debug, Clone)]
pub struct TransferSpec {
    pub local_path: String,
    pub remote_path: String,
    pub direction: TransferDirection,
}

#[derive(Clone)]
pub struct SftpManager {
    ssh: Arc<SshManager>,
    cancelled: Arc<Mutex<HashSet<String>>>,
}

impl SftpManager {
    pub fn new(ssh: Arc<SshManager>) -> Self {
        Self { ssh, cancelled: Arc::new(Mutex::new(HashSet::new())) }
    }

    pub async fn cancel(&self, task_id: &str) {
        self.cancelled.lock().await.insert(task_id.to_string());
    }

    pub async fn expand_transfer(&self, session_id: &str, spec: TransferSpec) -> Result<Vec<TransferSpec>, SshError> {
        match spec.direction {
            TransferDirection::Upload => {
                let root = tokio::fs::metadata(&spec.local_path).await
                    .map_err(|e| SshError::Channel(format!("stat upload path: {e}")))?;
                if !root.is_dir() { return Ok(vec![spec]); }
                let root_path = std::path::PathBuf::from(&spec.local_path);
                let mut stack = vec![root_path.clone()];
                let mut result = Vec::new();
                while let Some(path) = stack.pop() {
                    let mut entries = tokio::fs::read_dir(&path).await
                        .map_err(|e| SshError::Channel(format!("read upload directory: {e}")))?;
                    while let Some(entry) = entries.next_entry().await.map_err(|e| SshError::Channel(format!("read upload entry: {e}")))? {
                        let child = entry.path();
                        let file_type = entry.file_type().await.map_err(|e| SshError::Channel(e.to_string()))?;
                        if file_type.is_dir() {
                            stack.push(child);
                        } else if file_type.is_file() {
                            let rel = child.strip_prefix(&root_path).map_err(|e| SshError::Channel(e.to_string()))?;
                            result.push(TransferSpec { local_path: child.to_string_lossy().to_string(), remote_path: join_remote(&spec.remote_path, &rel.to_string_lossy()), direction: spec.direction });
                        }
                    }
                }
                Ok(result)
            }
            TransferDirection::Download => {
                let sftp = self.ssh.open_sftp(session_id).await?;
                let root_meta = sftp.metadata(&spec.remote_path).await.map_err(|e| SshError::Channel(format!("stat download path: {e}")))?;
                if !root_meta.is_dir() { let _ = sftp.close().await; return Ok(vec![spec]); }
                let root = normalize_remote_path(&spec.remote_path);
                let mut stack = vec![root.clone()];
                let mut result = Vec::new();
                while let Some(path) = stack.pop() {
                    let mut dir = sftp.read_dir(&path).await.map_err(|e| SshError::Channel(format!("read download directory: {e}")))?;
                    while let Some(entry) = dir.next() {
                        let child = entry.path();
                        let metadata = entry.metadata();
                        if metadata.is_dir() {
                            stack.push(child);
                        } else if metadata.is_regular() {
                            let rel = child.strip_prefix(&root).unwrap_or(&child).trim_start_matches('/');
                            result.push(TransferSpec { local_path: std::path::Path::new(&spec.local_path).join(rel).to_string_lossy().to_string(), remote_path: child, direction: spec.direction });
                        }
                    }
                }
                let _ = sftp.close().await;
                Ok(result)
            }
        }
    }

    pub async fn transfer_batch(&self, app: &AppHandle, session_id: &str, specs: Vec<TransferSpec>, concurrency: usize) -> Vec<Result<(), SshError>> {
        let manager = Arc::new(self.clone());
        let session_id = session_id.to_string();
        stream::iter(specs.into_iter().enumerate())
            .map(|(index, spec)| {
                let manager = manager.clone();
                let app = app.clone();
                let session_id = session_id.clone();
                async move {
                    let task_id = format!("batch-{index}-{}", uuid::Uuid::new_v4().simple());
                    manager.transfer(&app, &task_id, &session_id, &spec.local_path, &spec.remote_path, spec.direction, true).await
                }
            })
            .buffer_unordered(concurrency.clamp(1, 8))
            .collect()
            .await
    }

    pub async fn list(&self, session_id: &str, path: &str) -> Result<Vec<SftpEntry>, SshError> {
        let sftp = self.ssh.open_sftp(session_id).await?;
        let mut dir = sftp
            .read_dir(path)
            .await
            .map_err(|e| SshError::Channel(format!("sftp read_dir: {e}")))?;
        let mut entries = Vec::new();
        while let Some(entry) = dir.next() {
            let metadata = entry.metadata();
            let kind = if metadata.is_dir() {
                "directory"
            } else if metadata.is_symlink() {
                "symlink"
            } else if metadata.is_regular() {
                "file"
            } else {
                "other"
            };
            entries.push(SftpEntry {
                name: entry.file_name(),
                path: entry.path(),
                kind: kind.to_string(),
                size: metadata.size.unwrap_or(0),
                modified_at: metadata.mtime.map(|mtime| {
                    chrono::DateTime::<chrono::Utc>::from_timestamp(mtime as i64, 0)
                        .map(|t| t.to_rfc3339())
                        .unwrap_or_default()
                }),
            });
        }
        entries.sort_by_key(|entry| (!matches!(entry.kind.as_str(), "directory"), entry.name.to_lowercase()));
        let _ = sftp.close().await;
        Ok(entries)
    }

    pub async fn mkdir(&self, session_id: &str, path: &str) -> Result<(), SshError> {
        let sftp = self.ssh.open_sftp(session_id).await?;
        sftp.create_dir(path)
            .await
            .map_err(|e| SshError::Channel(format!("sftp mkdir: {e}")))?;
        let _ = sftp.close().await;
        Ok(())
    }

    pub async fn remove(&self, session_id: &str, path: &str, directory: bool) -> Result<(), SshError> {
        let sftp = self.ssh.open_sftp(session_id).await?;
        let result = if directory {
            sftp.remove_dir(path).await
        } else {
            sftp.remove_file(path).await
        };
        result.map_err(|e| SshError::Channel(format!("sftp remove: {e}")))?;
        let _ = sftp.close().await;
        Ok(())
    }

    pub async fn rename(&self, session_id: &str, old_path: &str, new_path: &str) -> Result<(), SshError> {
        let sftp = self.ssh.open_sftp(session_id).await?;
        sftp.rename(old_path, new_path)
            .await
            .map_err(|e| SshError::Channel(format!("sftp rename: {e}")))?;
        let _ = sftp.close().await;
        Ok(())
    }

    pub async fn transfer(
        &self,
        app: &AppHandle,
        task_id: &str,
        session_id: &str,
        local_path: &str,
        remote_path: &str,
        direction: TransferDirection,
        resume: bool,
    ) -> Result<(), SshError> {
        let _activity = crate::services::macos_power::begin_activity("DevDeck SFTP transfer");
        self.cancelled.lock().await.remove(task_id);
        let sftp = self.ssh.open_sftp(session_id).await?;
        let result = match direction {
            TransferDirection::Upload => {
                self.upload(&sftp, app, task_id, local_path, remote_path, resume).await
            }
            TransferDirection::Download => {
                self.download(&sftp, app, task_id, local_path, remote_path, resume).await
            }
        };
        let _ = sftp.close().await;
        result
    }

    async fn upload(
        &self,
        sftp: &SftpSession,
        app: &AppHandle,
        task_id: &str,
        local_path: &str,
        remote_path: &str,
        resume: bool,
    ) -> Result<(), SshError> {
        let mut local = tokio::fs::File::open(local_path)
            .await
            .map_err(|e| SshError::Channel(format!("open local file: {e}")))?;
        let total = local
            .metadata()
            .await
            .map_err(|e| SshError::Channel(format!("stat local file: {e}")))?
            .len();
        let offset = if resume {
            sftp.metadata(remote_path)
                .await
                .ok()
                .and_then(|meta| meta.size)
                .unwrap_or(0)
                .min(total)
        } else {
            0
        };
        local
            .seek(std::io::SeekFrom::Start(offset))
            .await
            .map_err(|e| SshError::Channel(format!("seek local file: {e}")))?;
        let flags = if offset > 0 {
            OpenFlags::WRITE | OpenFlags::CREATE
        } else {
            OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE
        };
        let mut remote = sftp
            .open_with_flags(remote_path, flags)
            .await
            .map_err(|e| SshError::Channel(format!("open remote file: {e}")))?;
        if offset > 0 {
            remote
                .seek(std::io::SeekFrom::Start(offset))
                .await
                .map_err(|e| SshError::Channel(format!("seek remote file: {e}")))?;
        }
        copy_with_progress(&self.cancelled, app, task_id, TransferDirection::Upload, &mut local, &mut remote, offset, total).await?;
        remote.shutdown().await.map_err(|e| SshError::Channel(format!("close remote file: {e}")))?;
        Ok(())
    }

    async fn download(
        &self,
        sftp: &SftpSession,
        app: &AppHandle,
        task_id: &str,
        local_path: &str,
        remote_path: &str,
        resume: bool,
    ) -> Result<(), SshError> {
        let mut remote = sftp
            .open(remote_path)
            .await
            .map_err(|e| SshError::Channel(format!("open remote file: {e}")))?;
        let total = remote
            .metadata()
            .await
            .map_err(|e| SshError::Channel(format!("stat remote file: {e}")))?
            .size
            .unwrap_or(0);
        let offset = if resume {
            tokio::fs::metadata(local_path).await.ok().map(|m| m.len()).unwrap_or(0).min(total)
        } else {
            0
        };
        let mut options = tokio::fs::OpenOptions::new();
        options.create(true).write(true);
        if offset == 0 {
            options.truncate(true);
        }
        if let Some(parent) = std::path::Path::new(local_path).parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|e| SshError::Channel(format!("create download directory: {e}")))?;
        }
        let mut local = options
            .open(local_path)
            .await
            .map_err(|e| SshError::Channel(format!("open local file: {e}")))?;
        remote
            .seek(std::io::SeekFrom::Start(offset))
            .await
            .map_err(|e| SshError::Channel(format!("seek remote file: {e}")))?;
        local
            .seek(std::io::SeekFrom::Start(offset))
            .await
            .map_err(|e| SshError::Channel(format!("seek local file: {e}")))?;
        copy_with_progress(&self.cancelled, app, task_id, TransferDirection::Download, &mut remote, &mut local, offset, total).await?;
        Ok(())
    }
}

async fn copy_with_progress<R, W>(
    cancelled: &Arc<Mutex<HashSet<String>>>,
    app: &AppHandle,
    task_id: &str,
    direction: TransferDirection,
    reader: &mut R,
    writer: &mut W,
    mut completed: u64,
    total: u64,
) -> Result<(), SshError>
where
    R: tokio::io::AsyncRead + Unpin,
    W: tokio::io::AsyncWrite + Unpin,
{
    let mut buffer = vec![0_u8; 256 * 1024];
    loop {
        if cancelled.lock().await.contains(task_id) {
            let _ = app.emit("sftp:progress", serde_json::json!({
                "taskId": task_id,
                "direction": direction.as_str(),
                "completedBytes": completed,
                "totalBytes": total,
                "percent": if total == 0 { 0 } else { ((completed as f64 / total as f64) * 100.0).round() as u8 },
                "state": "error",
                "error": "传输已取消",
            }));
            return Err(SshError::Channel("transfer cancelled".to_string()));
        }
        let read = reader
            .read(&mut buffer)
            .await
            .map_err(|e| SshError::Channel(format!("read transfer: {e}")))?;
        if read == 0 {
            break;
        }
        writer
            .write_all(&buffer[..read])
            .await
            .map_err(|e| SshError::Channel(format!("write transfer: {e}")))?;
        completed += read as u64;
        let percent = if total == 0 { 100 } else { ((completed as f64 / total as f64) * 100.0).round().min(100.0) as u8 };
        let _ = app.emit("sftp:progress", serde_json::json!({
            "taskId": task_id,
            "direction": direction.as_str(),
            "completedBytes": completed,
            "totalBytes": total,
            "percent": percent,
            "state": "running",
        }));
    }
    let _ = app.emit("sftp:progress", serde_json::json!({
        "taskId": task_id,
        "direction": direction.as_str(),
        "completedBytes": total,
        "totalBytes": total,
        "percent": 100,
        "state": "done",
    }));
    Ok(())
}

pub fn normalize_remote_path(path: &str) -> String {
    let trimmed = path.trim();
    if trimmed.is_empty() { "/".to_string() }
    else if trimmed.starts_with('/') { trimmed.trim_end_matches('/').to_string().if_empty(|| "/".to_string()) }
    else { format!("/{}", trimmed.trim_end_matches('/')) }
}

fn join_remote(root: &str, relative: &str) -> String {
    let root = normalize_remote_path(root);
    let relative = relative.replace('\\', "/").trim_matches('/').to_string();
    if relative.is_empty() { root } else if root == "/" { format!("/{relative}") } else { format!("{root}/{relative}") }
}

trait EmptyPath {
    fn if_empty(self, fallback: impl FnOnce() -> String) -> String;
}

impl EmptyPath for String {
    fn if_empty(self, fallback: impl FnOnce() -> String) -> String {
        if self.is_empty() { fallback() } else { self }
    }
}

#[cfg(test)]
mod tests {
    use super::normalize_remote_path;

    #[test]
    fn normalizes_remote_paths_for_the_sftp_browser() {
        assert_eq!(normalize_remote_path(""), "/");
        assert_eq!(normalize_remote_path("etc/"), "/etc");
        assert_eq!(normalize_remote_path("/var/log/"), "/var/log");
    }
}
