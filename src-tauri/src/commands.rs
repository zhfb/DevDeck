//! Tauri commands — the invoke contract consumed by frontend/src/lib/api.ts.
//! Keep command names + argument/return shapes in sync with the frontend.

use std::sync::Arc;
use tauri::{AppHandle, State};
use tokio::sync::Mutex;

use crate::infra::db::AppDb;
use crate::models::*;
use crate::services::{
    docker::DockerManager, hostkey::HostKeyResolver, ssh::SshManager, stats::StatsCollector,
    power::{PowerManager, PowerState}, sftp::{SftpManager, TransferDirection, TransferSpec}, tunnel::TunnelManager,
};

pub struct AppState {
    pub db: Arc<Mutex<AppDb>>,
    pub docker: Arc<DockerManager>,
    pub ssh: Arc<SshManager>,
    pub stats: StatsCollector,
    pub power: PowerManager,
    pub sftp: Arc<SftpManager>,
    pub tunnels: Arc<TunnelManager>,
    /// known_hosts TOFU — resolves pending `ssh:host-key-verify` prompts
    pub hostkey: Arc<HostKeyResolver>,
}

type CmdResult<T> = Result<T, String>;

// ---------------------------------------------------------------------------
// app
// ---------------------------------------------------------------------------
#[tauri::command]
pub async fn app_info() -> CmdResult<AppInfo> {
    Ok(AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        backend: "tauri-rust".to_string(),
        platform: std::env::consts::OS.to_string(),
    })
}

// ---------------------------------------------------------------------------
// power / adaptive load
// ---------------------------------------------------------------------------
#[tauri::command]
pub async fn power_state_get(state: State<'_, AppState>) -> CmdResult<crate::services::power::PowerSnapshot> {
    Ok(state.power.snapshot().await)
}

#[tauri::command]
pub async fn power_state_set(
    state: State<'_, AppState>,
    power_state: PowerState,
) -> CmdResult<crate::services::power::PowerSnapshot> {
    Ok(state.power.set_state(power_state).await)
}

// ---------------------------------------------------------------------------
// sftp
// ---------------------------------------------------------------------------
#[tauri::command]
pub async fn sftp_list(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> CmdResult<Vec<crate::models::SftpEntry>> {
    state
        .sftp
        .list(&session_id, &crate::services::sftp::normalize_remote_path(&path))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sftp_mkdir(state: State<'_, AppState>, session_id: String, path: String) -> CmdResult<()> {
    state.sftp.mkdir(&session_id, &path).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sftp_remove(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    directory: bool,
) -> CmdResult<()> {
    state.sftp.remove(&session_id, &path, directory).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sftp_rename(
    state: State<'_, AppState>,
    session_id: String,
    old_path: String,
    new_path: String,
) -> CmdResult<()> {
    state.sftp.rename(&session_id, &old_path, &new_path).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sftp_transfer(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    local_path: String,
    remote_path: String,
    direction: String,
    resume: Option<bool>,
) -> CmdResult<String> {
    let direction = match direction.as_str() {
        "upload" => TransferDirection::Upload,
        "download" => TransferDirection::Download,
        other => return Err(format!("unsupported sftp direction: {other}")),
    };
    let task_id = format!("sftp-{}", uuid::Uuid::new_v4().simple());
    let manager = state.sftp.clone();
    let task_id_job = task_id.clone();
    tauri::async_runtime::spawn(async move {
        use tauri::Emitter;
        let result = manager
            .transfer(&app, &task_id_job, &session_id, &local_path, &remote_path, direction, resume.unwrap_or(true))
            .await;
        if let Err(error) = result {
            let _ = app.emit("sftp:progress", serde_json::json!({
                "taskId": task_id_job,
                "direction": direction.as_str(),
                "percent": 0,
                "state": "error",
                "error": error.to_string(),
            }));
        }
    });
    Ok(task_id)
}

#[tauri::command]
pub async fn sftp_transfer_cancel(state: State<'_, AppState>, task_id: String) -> CmdResult<()> {
    state.sftp.cancel(&task_id).await;
    Ok(())
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpBatchInput {
    pub session_id: String,
    pub local_path: String,
    pub remote_path: String,
    pub direction: String,
    pub concurrency: Option<usize>,
}

#[tauri::command]
pub async fn sftp_transfer_batch(app: AppHandle, state: State<'_, AppState>, input: SftpBatchInput) -> CmdResult<String> {
    let direction = match input.direction.as_str() {
        "upload" => TransferDirection::Upload,
        "download" => TransferDirection::Download,
        other => return Err(format!("unsupported sftp direction: {other}")),
    };
    let specs = state.sftp.expand_transfer(&input.session_id, TransferSpec {
        local_path: input.local_path,
        remote_path: input.remote_path,
        direction,
    }).await.map_err(|e| e.to_string())?;
    let batch_id = format!("sftp-batch-{}", uuid::Uuid::new_v4().simple());
    let manager = state.sftp.clone();
    let session_id = input.session_id;
    let concurrency = input.concurrency.unwrap_or(4);
    let event_id = batch_id.clone();
    tauri::async_runtime::spawn(async move {
        use tauri::Emitter;
        let results = manager.transfer_batch(&app, &session_id, specs, concurrency).await;
        let failed = results.iter().filter(|result| result.is_err()).count();
        let _ = app.emit("sftp:batch-progress", serde_json::json!({
            "taskId": event_id,
            "state": if failed == 0 { "done" } else { "error" },
            "completed": results.len().saturating_sub(failed),
            "total": results.len(),
            "failed": failed,
        }));
    });
    Ok(batch_id)
}

#[tauri::command]
pub async fn local_fs_list(path: Option<String>) -> CmdResult<Vec<crate::models::SftpEntry>> {
    let path = path.unwrap_or_else(|| ".".to_string());
    let dir = std::path::PathBuf::from(&path);
    let mut entries = tokio::fs::read_dir(&dir).await.map_err(|e| e.to_string())?;
    let mut result = Vec::new();
    while let Some(entry) = entries.next_entry().await.map_err(|e| e.to_string())? {
        let metadata = entry.metadata().await.map_err(|e| e.to_string())?;
        let kind = if metadata.is_dir() { "directory" } else if metadata.is_file() { "file" } else { "other" };
        result.push(crate::models::SftpEntry {
            name: entry.file_name().to_string_lossy().to_string(),
            path: entry.path().to_string_lossy().to_string(),
            kind: kind.to_string(),
            size: metadata.len(),
            modified_at: metadata.modified().ok().map(|time| chrono::DateTime::<chrono::Utc>::from(time).to_rfc3339()),
        });
    }
    result.sort_by_key(|entry| (!matches!(entry.kind.as_str(), "directory"), entry.name.to_lowercase()));
    Ok(result)
}

// ---------------------------------------------------------------------------
// engines
// ---------------------------------------------------------------------------
#[tauri::command]
pub async fn engines_list(state: State<'_, AppState>) -> CmdResult<Vec<DockerEngine>> {
    // ensure probe ran at least once
    state.docker.probe().await.map_err(|e| e.to_string())?;
    Ok(state.docker.list_engines().await)
}

// ---------------------------------------------------------------------------
// hosts
// ---------------------------------------------------------------------------
#[tauri::command]
pub async fn hosts_list(state: State<'_, AppState>) -> CmdResult<Vec<Host>> {
    let db = state.db.lock().await;
    db.list_hosts().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn hosts_groups(state: State<'_, AppState>) -> CmdResult<Vec<HostGroup>> {
    let db = state.db.lock().await;
    db.list_groups().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn hosts_stats(state: State<'_, AppState>, host_id: String) -> CmdResult<Option<HostStats>> {
    if let Ok(output) = state.ssh.exec_for_host(&host_id, crate::services::stats::STATS_BATCH_CMD).await {
        if let Some(stats) = state.stats.parse_batch(&host_id, &output) {
            state.stats.record(stats).await;
        }
    }
    Ok(state.stats.latest(&host_id).await)
}

#[tauri::command]
pub async fn hosts_stats_history(state: State<'_, AppState>, host_id: String) -> CmdResult<Vec<HostStatsHistoryPoint>> {
    Ok(state.stats.history(&host_id).await)
}

#[tauri::command]
pub async fn hosts_save(
    state: State<'_, AppState>,
    mut host: Host,
    password: Option<String>,
    private_key: Option<String>,
) -> CmdResult<()> {
    // optional password → Keychain, DB keeps only the account ref
    if let Some(pw) = password.filter(|p| !p.is_empty()) {
        let account =
            crate::infra::keychain::account_for(&host.user, &host.address, host.port);
        crate::infra::keychain::store_password(&account, &pw).map_err(|e| e.to_string())?;
        host.credential_ref = Some(account);
    }
    if let Some(private_key) = private_key.filter(|key| !key.trim().is_empty()) {
        let account = crate::infra::keychain::account_for(&host.user, &host.address, host.port);
        crate::infra::keychain::store_private_key(&account, &private_key).map_err(|e| e.to_string())?;
    }
    let db = state.db.lock().await;
    db.upsert_host(&host).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn hosts_delete(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    let db = state.db.lock().await;
    db.delete_host(&id).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// containers
// ---------------------------------------------------------------------------
#[tauri::command]
pub async fn containers_list(
    state: State<'_, AppState>,
    engine_id: Option<String>,
) -> CmdResult<Vec<Container>> {
    state
        .docker
        .list_containers(engine_id.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn containers_get(state: State<'_, AppState>, id: String) -> CmdResult<Option<Container>> {
    // search across all reachable engines
    for engine in state.docker.list_engines().await {
        if engine.reachable {
            if let Ok(Some(c)) = state.docker.get_container(&engine.id, &id).await {
                return Ok(Some(c));
            }
        }
    }
    Ok(None)
}

#[tauri::command]
pub async fn containers_start(state: State<'_, AppState>, engine_id: String, id: String) -> CmdResult<()> {
    state.docker.start(&engine_id, &id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn containers_stop(state: State<'_, AppState>, engine_id: String, id: String) -> CmdResult<()> {
    state.docker.stop(&engine_id, &id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn containers_restart(state: State<'_, AppState>, engine_id: String, id: String) -> CmdResult<()> {
    state.docker.restart(&engine_id, &id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn containers_pause(state: State<'_, AppState>, engine_id: String, id: String) -> CmdResult<()> {
    state.docker.pause(&engine_id, &id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn containers_unpause(state: State<'_, AppState>, engine_id: String, id: String) -> CmdResult<()> {
    state.docker.unpause(&engine_id, &id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn containers_remove(state: State<'_, AppState>, engine_id: String, id: String) -> CmdResult<()> {
    state.docker.remove(&engine_id, &id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn containers_exec(
    app: AppHandle,
    state: State<'_, AppState>,
    engine_id: String,
    container_id: String,
    session_id: String,
) -> CmdResult<()> {
    state.docker.exec_start(&app, &engine_id, &container_id, &session_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn containers_logs(
    app: AppHandle,
    state: State<'_, AppState>,
    engine_id: String,
    container_id: String,
) -> CmdResult<()> {
    state.docker.logs_stream(&app, &engine_id, &container_id).await.map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// images
// ---------------------------------------------------------------------------
#[tauri::command]
pub async fn images_list(state: State<'_, AppState>, engine_id: Option<String>) -> CmdResult<Vec<DockerImage>> {
    state
        .docker
        .list_images(engine_id.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn images_pull(
    app: AppHandle,
    state: State<'_, AppState>,
    engine_id: Option<String>,
    image: String,
) -> CmdResult<String> {
    let engine_id = match engine_id {
        Some(id) => id,
        None => state
            .docker
            .list_engines()
            .await
            .into_iter()
            .find(|engine| engine.reachable)
            .map(|engine| engine.id)
            .ok_or_else(|| "没有可用的 Docker 引擎".to_string())?,
    };
    let task_id = format!("pull-{}", uuid::Uuid::new_v4().simple());
    let docker = state.docker.clone();
    let task_id_for_job = task_id.clone();
    let image_for_job = image.clone();
    let app_for_job = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = docker
            .pull_image(&engine_id, &image_for_job, &app_for_job, &task_id_for_job)
            .await;
        use tauri::Emitter;
        let payload = match result {
            Ok(()) => serde_json::json!({
                "taskId": task_id_for_job,
                "image": image_for_job,
                "engineId": engine_id,
                "percent": 100,
                "status": "完成",
                "state": "done",
            }),
            Err(error) => serde_json::json!({
                "taskId": task_id_for_job,
                "image": image_for_job,
                "engineId": engine_id,
                "percent": 0,
                "status": error.to_string(),
                "state": "error",
            }),
        };
        let _ = app_for_job.emit("docker:pull-progress", payload);
    });
    Ok(task_id)
}

#[tauri::command]
pub async fn images_remove(state: State<'_, AppState>, engine_id: String, id: String) -> CmdResult<()> {
    state.docker.remove_image(&engine_id, &id).await.map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// volumes / networks (Phase 2 detail)
// ---------------------------------------------------------------------------
#[tauri::command]
pub async fn volumes_list(state: State<'_, AppState>, engine_id: Option<String>) -> CmdResult<Vec<DockerVolume>> {
    state.docker.list_volumes(engine_id.as_deref()).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn networks_list(state: State<'_, AppState>, engine_id: Option<String>) -> CmdResult<Vec<DockerNetwork>> {
    state.docker.list_networks(engine_id.as_deref()).await.map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// tunnels
// ---------------------------------------------------------------------------
#[tauri::command]
pub async fn tunnels_list(state: State<'_, AppState>) -> CmdResult<Vec<Tunnel>> {
    state.tunnels.list().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn tunnels_save(state: State<'_, AppState>, tunnel: Tunnel) -> CmdResult<()> {
    state.tunnels.save(&tunnel).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn tunnels_delete(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.tunnels.remove(&id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn tunnels_start(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.tunnels.start(&id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn tunnels_stop(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.tunnels.stop(&id).await.map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// ssh
// ---------------------------------------------------------------------------
#[tauri::command]
pub async fn ssh_connect(
    state: State<'_, AppState>,
    host_id: String,
    password: Option<String>,
    cols: Option<u32>,
    rows: Option<u32>,
) -> CmdResult<SshSession> {
    let db = state.db.lock().await;
    let host = db
        .get_host(&host_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("host not found: {host_id}"))?;
    drop(db);

    // fall back to Keychain-stored password when none typed
    let password = password.or_else(|| {
        host.credential_ref
            .as_deref()
            .and_then(|r| crate::infra::keychain::load_password(r).ok())
    });

    let session = state
        .ssh
        .connect_pty(&host, password.as_deref(), cols.unwrap_or(80), rows.unwrap_or(24))
        .await
        .map_err(|e| e.to_string())?;

    // record last-connect timestamp
    if let Ok(db) = state.db.try_lock() {
        let _ = db.touch_host(&host_id, &session.started_at);
    }
    Ok(session)
}

/// Forward raw terminal input into a PTY session.
#[tauri::command]
pub async fn term_input(state: State<'_, AppState>, session_id: String, data: String) -> CmdResult<()> {
    match state.ssh.send_data(&session_id, data.as_bytes()).await {
        Ok(()) => Ok(()),
        Err(_) => state.docker.exec_input(&session_id, data.as_bytes()).await.map_err(|e| e.to_string()),
    }
}

/// Resize a PTY session (xterm fit → SSH window-change).
#[tauri::command]
pub async fn term_resize(state: State<'_, AppState>, session_id: String, cols: u32, rows: u32) -> CmdResult<()> {
    match state.ssh.resize(&session_id, cols, rows).await {
        Ok(()) => Ok(()),
        Err(_) => state.docker.exec_resize(&session_id, cols as u16, rows as u16).await.map_err(|e| e.to_string()),
    }
}

/// Reconnect a dropped PTY session (auto-reconnect after keepalive detects
/// the drop). Reuses the original session id; credentials come from Keychain.
#[tauri::command]
pub async fn ssh_reconnect(
    state: State<'_, AppState>,
    session_id: String,
    host_id: String,
    cols: Option<u32>,
    rows: Option<u32>,
) -> CmdResult<SshSession> {
    let db = state.db.lock().await;
    let host = db
        .get_host(&host_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("host not found: {host_id}"))?;
    drop(db);

    let session = state
        .ssh
        .reconnect(&session_id, &host, cols.unwrap_or(80), rows.unwrap_or(24))
        .await
        .map_err(|e| e.to_string())?;
    Ok(session)
}

#[tauri::command]
pub async fn ssh_disconnect(state: State<'_, AppState>, session_id: String) -> CmdResult<()> {
    state.ssh.disconnect(&session_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ssh_sessions(state: State<'_, AppState>) -> CmdResult<Vec<SshSession>> {
    Ok(state.ssh.list_sessions().await)
}
