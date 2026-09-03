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
        // 用户直接输入的远端路径不允许 `..`（跨目录跳转），严格拒绝而非静默改写（review Minor）
        if sanitize_rel_strict(&spec.remote_path.replace('\\', "/")).is_none() {
            return Err(SshError::Channel(
                "远端路径包含 `..` 或反斜杠，已拒绝（不允许跨目录跳转）".to_string(),
            ));
        }
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
                            let Some(rel_safe) = sanitize_rel(&rel.to_string_lossy()) else { continue; };
                            result.push(TransferSpec { local_path: child.to_string_lossy().to_string(), remote_path: join_remote(&spec.remote_path, &rel_safe), direction: spec.direction });
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
                    let dir = sftp.read_dir(&path).await.map_err(|e| SshError::Channel(format!("read download directory: {e}")))?;
                    for entry in dir {
                        let child = entry.path();
                        let metadata = entry.metadata();
                        if metadata.is_dir() {
                            stack.push(child);
                        } else if metadata.is_regular() {
                            let raw = child.strip_prefix(&root).unwrap_or(&child).trim_start_matches('/');
                            let Some(rel) = sanitize_rel(raw) else { continue; };
                            result.push(TransferSpec { local_path: std::path::Path::new(&spec.local_path).join(&rel).to_string_lossy().to_string(), remote_path: child, direction: spec.direction });
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
        let result = async {
            let dir = sftp
                .read_dir(path)
                .await
                .map_err(|e| SshError::Channel(format!("sftp read_dir: {e}")))?;
            let mut entries = Vec::new();
            for entry in dir {
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
            Ok::<_, SshError>(entries)
        }
        .await;
        // 无论成败都关闭 SFTP 会话，避免子通道/会话泄漏
        let _ = sftp.close().await;
        result
    }

    pub async fn mkdir(&self, session_id: &str, path: &str) -> Result<(), SshError> {
        let sftp = self.ssh.open_sftp(session_id).await?;
        let result = sftp
            .create_dir(path)
            .await
            .map_err(|e| SshError::Channel(format!("sftp mkdir: {e}")));
        let _ = sftp.close().await;
        result
    }

    pub async fn remove(&self, session_id: &str, path: &str, directory: bool) -> Result<(), SshError> {
        let sftp = self.ssh.open_sftp(session_id).await?;
        let result = if directory {
            sftp.remove_dir(path).await
        } else {
            sftp.remove_file(path).await
        }
        .map_err(|e| SshError::Channel(format!("sftp remove: {e}")));
        let _ = sftp.close().await;
        result
    }

    pub async fn rename(&self, session_id: &str, old_path: &str, new_path: &str) -> Result<(), SshError> {
        let sftp = self.ssh.open_sftp(session_id).await?;
        let result = sftp
            .rename(old_path, new_path)
            .await
            .map_err(|e| SshError::Channel(format!("sftp rename: {e}")));
        let _ = sftp.close().await;
        result
    }

    #[allow(clippy::too_many_arguments)]
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

#[allow(clippy::too_many_arguments)]
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
    let relative = sanitize_rel(&relative.replace('\\', "/")).unwrap_or_default();
    if relative.is_empty() { root } else if root == "/" { format!("/{relative}") } else { format!("{root}/{relative}") }
}

/// 目录递归展开时，规范化相对路径中的 `..` / `.` / 绝对段并拒绝反斜杠，
/// 防止跨目录写入。`..` 段被跳过，含反斜杠的段使整条路径返回 None。
fn sanitize_rel(path: &str) -> Option<String> {
    let mut out = Vec::new();
    for seg in path.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." {
            continue;
        }
        if seg.contains('\\') {
            return None;
        }
        out.push(seg);
    }
    Some(out.join("/"))
}

/// 用户直接输入的远端路径校验：与 [`sanitize_rel`] 不同，遇到 `..` 段直接拒绝
/// （返回 None），防止用户输入 `/data/../etc` 之类路径被静默改写后跨目录写入/读取。
fn sanitize_rel_strict(path: &str) -> Option<String> {
    let mut out = Vec::new();
    for seg in path.split('/') {
        if seg == ".." {
            return None;
        }
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg.contains('\\') {
            return None;
        }
        out.push(seg);
    }
    Some(out.join("/"))
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
    use super::{join_remote, normalize_remote_path, sanitize_rel, sanitize_rel_strict};

    #[test]
    fn normalizes_remote_paths_for_the_sftp_browser() {
        assert_eq!(normalize_remote_path(""), "/");
        assert_eq!(normalize_remote_path("etc/"), "/etc");
        assert_eq!(normalize_remote_path("/var/log/"), "/var/log");
    }

    #[test]
    fn join_remote_blocks_parent_traversal() {
        // `..` 段被跳过，不会拼出逃逸路径
        assert_eq!(join_remote("/data", "../etc/passwd"), "/data/etc/passwd");
        assert_eq!(join_remote("/data", "a/../../b"), "/data/a/b");
        // 反斜杠被当作分隔符处理，`..\..` 同样被跳过，不会逃逸
        assert_eq!(join_remote("/data", r"..\..\win"), "/data/win");
        // 空相对路径保持不变
        assert_eq!(join_remote("/data", ""), "/data");
    }

    #[test]
    fn sanitize_rel_drops_unsafe_segments() {
        assert_eq!(sanitize_rel("a/b/c").as_deref(), Some("a/b/c"));
        assert_eq!(sanitize_rel("a/./b").as_deref(), Some("a/b"));
        // `..` 段被跳过（规范化），不会形成逃逸路径
        assert_eq!(sanitize_rel("a/../b").as_deref(), Some("a/b"));
        // 绝对路径段被相对化，防止写入到目标目录之外
        assert_eq!(sanitize_rel("/etc/passwd").as_deref(), Some("etc/passwd"));
        // 反斜杠（Windows 风格逃逸）整段拒绝
        assert_eq!(sanitize_rel(r"a\b"), None);
    }

    #[test]
    fn sanitize_rel_strict_rejects_parent_traversal() {
        // 用户输入路径：`..` 直接拒绝，而不是静默改写
        assert_eq!(sanitize_rel_strict("a/../b"), None);
        assert_eq!(sanitize_rel_strict("/data/../etc"), None);
        assert_eq!(sanitize_rel_strict("../etc/passwd"), None);
        assert_eq!(sanitize_rel_strict(r"..\..\win"), None);
        // 正常路径与 `.` 段仍被接受/规范化
        assert_eq!(sanitize_rel_strict("a/b/c").as_deref(), Some("a/b/c"));
        assert_eq!(sanitize_rel_strict("a/./b").as_deref(), Some("a/b"));
        assert_eq!(sanitize_rel_strict("/data/app").as_deref(), Some("data/app"));
    }
}
