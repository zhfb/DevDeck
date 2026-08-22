use std::sync::Arc;

use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
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

pub struct SftpManager {
    ssh: Arc<SshManager>,
}

impl SftpManager {
    pub fn new(ssh: Arc<SshManager>) -> Self {
        Self { ssh }
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
        copy_with_progress(app, task_id, TransferDirection::Upload, &mut local, &mut remote, offset, total).await?;
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
        copy_with_progress(app, task_id, TransferDirection::Download, &mut remote, &mut local, offset, total).await?;
        Ok(())
    }
}

async fn copy_with_progress<R, W>(
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
