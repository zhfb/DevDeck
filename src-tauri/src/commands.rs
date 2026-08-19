//! Tauri commands — the invoke contract consumed by frontend/src/lib/api.ts.
//! Keep command names + argument/return shapes in sync with the frontend.

use std::sync::Arc;
use tauri::State;
use tokio::sync::Mutex;

use crate::infra::db::AppDb;
use crate::models::*;
use crate::services::{docker::DockerManager, ssh::SshManager, stats::StatsCollector, tunnel::TunnelManager};

pub struct AppState {
    pub db: Arc<Mutex<AppDb>>,
    pub docker: Arc<DockerManager>,
    pub ssh: Arc<SshManager>,
    pub stats: StatsCollector,
    pub tunnels: Arc<TunnelManager>,
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
    Ok(state.stats.latest(&host_id).await)
}

#[tauri::command]
pub async fn hosts_stats_history(state: State<'_, AppState>, host_id: String) -> CmdResult<Vec<HostStatsHistoryPoint>> {
    Ok(state.stats.history(&host_id).await)
}

#[tauri::command]
pub async fn hosts_save(state: State<'_, AppState>, host: Host) -> CmdResult<()> {
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
pub async fn images_pull(state: State<'_, AppState>, engine_id: String, image: String) -> CmdResult<()> {
    state.docker.pull_image(&engine_id, &image).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn images_remove(state: State<'_, AppState>, engine_id: String, id: String) -> CmdResult<()> {
    state.docker.remove_image(&engine_id, &id).await.map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// volumes / networks (Phase 2 detail)
// ---------------------------------------------------------------------------
#[tauri::command]
pub async fn volumes_list(_state: State<'_, AppState>, _engine_id: Option<String>) -> CmdResult<Vec<DockerVolume>> {
    Ok(vec![])
}

#[tauri::command]
pub async fn networks_list(_state: State<'_, AppState>, _engine_id: Option<String>) -> CmdResult<Vec<DockerNetwork>> {
    Ok(vec![])
}

// ---------------------------------------------------------------------------
// tunnels
// ---------------------------------------------------------------------------
#[tauri::command]
pub async fn tunnels_list(state: State<'_, AppState>) -> CmdResult<Vec<Tunnel>> {
    state.tunnels.list().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn tunnels_save(state: State<'_, AppState>, tunnel: Tunnel) -> CmdResult<()> {
    state.tunnels.save(&tunnel).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn tunnels_delete(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.tunnels.remove(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn tunnels_start(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.tunnels.start(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn tunnels_stop(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.tunnels.stop(&id).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// ssh
// ---------------------------------------------------------------------------
#[tauri::command]
pub async fn ssh_connect(
    state: State<'_, AppState>,
    host_id: String,
    password: Option<String>,
) -> CmdResult<SshSession> {
    let db = state.db.lock().await;
    let host = db
        .get_host(&host_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("host not found: {host_id}"))?;
    drop(db);

    let session = state.ssh.connect(&host, password.as_deref()).await.map_err(|e| e.to_string())?;

    // record last-connect timestamp
    if let Ok(db) = state.db.try_lock() {
        let _ = db.touch_host(&host_id, &session.started_at);
    }
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
