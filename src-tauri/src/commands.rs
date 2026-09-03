//! Tauri commands — the invoke contract consumed by frontend/src/lib/api.ts.
//! Keep command names + argument/return shapes in sync with the frontend.

use std::sync::Arc;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, State};
use tokio::sync::Mutex;

/// PIN 暴力破解防护：连续失败达到阈值后进入冷却期
static PIN_FAILURES: AtomicU32 = AtomicU32::new(0);
/// 冷却截止时间（unix 毫秒），0 表示未锁定
static PIN_LOCKED_UNTIL: AtomicU64 = AtomicU64::new(0);
const PIN_MAX_FAILURES: u32 = 5;
const PIN_LOCKOUT_STEP: u64 = 30; // 每次锁定 30s * 超额次数

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

use crate::infra::db::AppDb;
use crate::models::*;
use crate::services::{
    docker::DockerManager, hostkey::HostKeyResolver, ssh::SshManager, stats::StatsCollector,
    power::{PowerManager, PowerState}, sftp::{SftpManager, TransferDirection, TransferSpec}, tunnel::TunnelManager,
    auto_forward::AutoForwardManager, compose::{ComposeManager, ComposeService},
    remote_docker::{RemoteDockerManager, RemoteDockerMount},
    zmodem::ZmodemManager,
    local_pty::LocalPtyManager,
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
    /// event-driven port forwarding
    pub auto_forward: Arc<AutoForwardManager>,
    /// docker compose via SSH exec
    pub compose: Arc<ComposeManager>,
    /// remote Docker over SSH (streamlocal bridge to docker.sock)
    pub remote_docker: Arc<RemoteDockerManager>,
    /// ZMODEM file transfer over SSH
    pub zmodem: Arc<ZmodemManager>,
    /// 内置 Docker 引擎（DevDeck 自管 Lima vz + dockerd，不依赖 OrbStack）
    pub embedded: crate::services::embedded::EmbeddedEngine,
    /// 本地终端（macOS 本地 shell PTY）
    pub local: LocalPtyManager,
}

type CmdResult<T> = Result<T, String>;

// ---------------------------------------------------------------------------
// app
// ---------------------------------------------------------------------------

/// 自动更新检查结果（P2：tauri-plugin-updater）
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub available: bool,
    pub current_version: String,
    pub version: String,
    pub notes: Option<String>,
    pub download_url: Option<String>,
}

#[tauri::command]
pub async fn updater_check(app: AppHandle) -> CmdResult<UpdateInfo> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| e.to_string())?;
    let current_version = app.package_info().version.to_string();
    match updater.check().await.map_err(|e| e.to_string())? {
        Some(u) => Ok(UpdateInfo {
            available: true,
            current_version,
            version: u.version.clone(),
            notes: u.body.clone(),
            download_url: Some(u.download_url.to_string()),
        }),
        None => Ok(UpdateInfo {
            available: false,
            current_version: current_version.clone(),
            version: current_version,
            notes: None,
            download_url: None,
        }),
    }
}

#[tauri::command]
pub async fn updater_install(app: AppHandle) -> CmdResult<String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| e.to_string())?;
    match updater.check().await.map_err(|e| e.to_string())? {
        Some(update) => {
            update
                .download_and_install(
                    |_, _| {},
                    || {},
                )
                .await
                .map_err(|e| e.to_string())?;
            Ok(format!("已下载并安装更新 v{}，请重启应用生效", update.version))
        }
        None => Ok("已是最新版本".to_string()),
    }
}
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
    let snapshot = state.power.set_state(power_state).await;
    crate::services::macos_power::set_thread_qos(snapshot.state);
    Ok(snapshot)
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
// embedded engine (内置 Docker 引擎 — Lima vz + dockerd)
// ---------------------------------------------------------------------------
#[tauri::command]
pub async fn embedded_status(state: State<'_, AppState>) -> CmdResult<crate::services::embedded::EmbeddedStatus> {
    Ok(state.embedded.status().await)
}

/// 启动/确保内置引擎（首次会初始化 VM 并下载镜像，可能较慢）。
#[tauri::command]
pub async fn embedded_start(state: State<'_, AppState>) -> CmdResult<crate::services::embedded::EmbeddedStatus> {
    match state.embedded.ensure().await {
        Ok(sock) => {
            // 重新探测一次，让内置引擎立刻出现在引擎列表
            let _ = state.docker.probe().await;
            let mut st = state.embedded.status().await;
            st.socket = Some(sock.display().to_string());
            st.socket_exists = true;
            st.engine_connected = state.docker.list_engines().await.iter().any(|e| e.id == crate::services::embedded::EMBEDDED_ENGINE_ID);
            if st.engine_connected {
                st.docker_version = Some("connected".to_string());
                st.error = None;
            }
            Ok(st)
        }
        Err(e) => {
            let mut st = state.embedded.status().await;
            st.error = Some(e);
            Ok(st)
        }
    }
}

/// 停止内置引擎 VM。
#[tauri::command]
pub async fn embedded_stop(state: State<'_, AppState>) -> CmdResult<crate::services::embedded::EmbeddedStatus> {
    state.embedded.stop().await.map_err(|e| e.to_string())?;
    Ok(state.embedded.status().await)
}

/// 删除内置引擎（重置，清空数据）。
#[tauri::command]
pub async fn embedded_reset(state: State<'_, AppState>) -> CmdResult<crate::services::embedded::EmbeddedStatus> {
    state.embedded.reset().await.map_err(|e| e.to_string())?;
    Ok(state.embedded.status().await)
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
    // 先删 DB 记录，成功后再清理 Keychain 凭据：
    // 若 DB 删除失败，主机仍存在但凭据不能提前销毁，避免“删除失败却丢了凭据”（review Important）
    let account = match db.get_host(&id) {
        Ok(Some(host)) => host.credential_ref,
        _ => None,
    };
    db.delete_host(&id).map_err(|e| e.to_string())?;
    if let Some(account) = account.as_deref() {
        let _ = crate::infra::keychain::delete_password(account);
        let _ = crate::infra::keychain::delete_password(&format!("{account}:private-key"));
    }
    Ok(())
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
// registries (镜像仓库配置 + Docker Registry API v2 浏览)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn registries_list(state: State<'_, AppState>) -> CmdResult<Vec<RegistryConfig>> {
    let db = state.db.lock().await;
    db.list_registries().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn registries_save(
    state: State<'_, AppState>,
    mut registry: RegistryConfig,
    password: Option<String>,
) -> CmdResult<()> {
    // 密码写入 Keychain，DB 只保留引用
    if let Some(pw) = password.filter(|p| !p.is_empty()) {
        let account = crate::infra::keychain::registry_account(&registry.id);
        crate::infra::keychain::store_password(&account, &pw).map_err(|e| e.to_string())?;
        registry.credential_ref = Some(account);
    }
    let db = state.db.lock().await;
    db.upsert_registry(&registry).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn registries_delete(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    // 清理 Keychain 中的密码（若有）
    let account = crate::infra::keychain::registry_account(&id);
    let _ = crate::infra::keychain::delete_password(&account);
    let db = state.db.lock().await;
    db.delete_registry(&id).map_err(|e| e.to_string())
}

/// 读取配置并构造 RegistryClient（密码从 Keychain 取出）。
async fn registry_client(
    state: &AppState,
    id: &str,
) -> Result<(RegistryConfig, crate::services::registry::RegistryClient), String> {
    let db = state.db.lock().await;
    let cfg = db
        .get_registry(id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("未找到镜像仓库配置: {id}"))?;
    drop(db);
    let password = cfg
        .credential_ref
        .as_deref()
        .and_then(|a| crate::infra::keychain::load_password(a).ok());
    let client = crate::services::registry::RegistryClient::new(&cfg, password);
    Ok((cfg, client))
}

/// 校验连接与凭据（探测 /v2/）。
#[tauri::command]
pub async fn registry_ping(state: State<'_, AppState>, id: String) -> CmdResult<String> {
    let (_cfg, client) = registry_client(&state, &id).await?;
    client.ping().await.map_err(|e| e.to_string())
}

/// 列出仓库（repositories）。可选返回每个仓库的 tag（tags=true 时逐个拉取）。
/// 若配置了 namespace，则只返回这些命名空间下的仓库（逗号分隔，如 "variety,ceph0618"；
/// UCloud 等公开目录可能包含海量公共镜像）。
#[tauri::command]
pub async fn registry_repos(
    state: State<'_, AppState>,
    id: String,
    with_tags: Option<bool>,
) -> CmdResult<Vec<RegistryRepo>> {
    let (cfg, client) = registry_client(&state, &id).await?;
    let mut repos = client.catalog().await.map_err(|e| e.to_string())?;
    if let Some(raw) = cfg.namespace.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let namespaces: Vec<&str> = raw
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .collect();
        if !namespaces.is_empty() {
            repos.retain(|r| {
                namespaces.iter().any(|n| r == *n || r.starts_with(&format!("{n}/")))
            });
        }
    }
    let with_tags = with_tags.unwrap_or(false);
    let mut out: Vec<RegistryRepo> = Vec::new();
    for name in repos {
        let tags = if with_tags {
            client.tags(&name).await.unwrap_or_default()
        } else {
            Vec::new()
        };
        out.push(RegistryRepo { name, tags });
    }
    Ok(out)
}

/// 列出某个仓库的镜像 tag。
#[tauri::command]
pub async fn registry_tags(
    state: State<'_, AppState>,
    id: String,
    repo: String,
) -> CmdResult<Vec<String>> {
    let (_cfg, client) = registry_client(&state, &id).await?;
    client.tags(&repo).await.map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// config import / export（配置导入导出）
// 导出不含密钥本体：凭据仅保留 Keychain 引用，密码/私钥内容不落盘。
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn config_export(state: State<'_, AppState>) -> CmdResult<ConfigBundle> {
    let db = state.db.lock().await;
    Ok(ConfigBundle {
        app: "devdeck".to_string(),
        schema_version: 1,
        exported_at: now_iso(),
        host_groups: db.list_groups().map_err(|e| e.to_string())?,
        hosts: db.list_hosts().map_err(|e| e.to_string())?,
        tunnels: db.list_tunnels().map_err(|e| e.to_string())?,
        snippets: db.list_snippets().map_err(|e| e.to_string())?,
        registries: db.list_registries().map_err(|e| e.to_string())?,
    })
}

#[tauri::command]
pub async fn config_import(state: State<'_, AppState>, bundle: ConfigBundle) -> CmdResult<ConfigImportStats> {
    if bundle.app != "devdeck" {
        return Err("不是有效的 DevDeck 配置文件".to_string());
    }
    let mut stats = ConfigImportStats::default();
    let db = state.db.lock().await;
    // 事务：全部成功才生效
    db.transact(|tx| -> Result<(), crate::infra::db::DbError> {
        for g in &bundle.host_groups {
            tx.upsert_group(g)?;
            stats.groups += 1;
        }
        for h in &bundle.hosts {
            tx.upsert_host(h)?;
            stats.hosts += 1;
        }
        for t in &bundle.tunnels {
            tx.upsert_tunnel(t)?;
            stats.tunnels += 1;
        }
        for s in &bundle.snippets {
            tx.upsert_snippet(s)?;
            stats.snippets += 1;
        }
        for r in &bundle.registries {
            tx.upsert_registry(r)?;
            stats.registries += 1;
        }
        Ok(())
    })
    .map_err(|e| e.to_string())?;
    Ok(stats)
}

#[derive(Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigImportStats {
    pub groups: usize,
    pub hosts: usize,
    pub tunnels: usize,
    pub snippets: usize,
    pub registries: usize,
}

// ---------------------------------------------------------------------------
// idle auto-lock（闲置自动锁）
// PIN 存 Keychain；启用/时长/是否 Touch ID 存 settings KV。
// ---------------------------------------------------------------------------

const IDLE_LOCK_KEY: &str = "idle_lock";

#[tauri::command]
pub async fn idle_lock_config_get(state: State<'_, AppState>) -> CmdResult<IdleLockConfig> {
    let db = state.db.lock().await;
    let raw = db.get_setting(IDLE_LOCK_KEY).map_err(|e| e.to_string())?;
    let mut cfg: IdleLockConfig = raw
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or(IdleLockConfig {
            enabled: false,
            timeout_minutes: 10,
            use_touch_id: false,
            has_pin: false,
        });
    cfg.has_pin = crate::infra::keychain::load_password(&crate::infra::keychain::idle_lock_pin_account())
        .is_ok();
    Ok(cfg)
}

#[tauri::command]
pub async fn idle_lock_config_set(
    state: State<'_, AppState>,
    enabled: bool,
    timeout_minutes: Option<u32>,
    use_touch_id: Option<bool>,
    pin: Option<String>,
) -> CmdResult<()> {
    // PIN：写入 / 覆盖 / 清除（传空字符串表示清除）
    let account = crate::infra::keychain::idle_lock_pin_account();
    match pin {
        Some(p) if !p.is_empty() => {
            crate::infra::keychain::store_password(&account, &p).map_err(|e| e.to_string())?
        }
        Some(_) => {
            // 传了空串 → 清除 PIN
            let _ = crate::infra::keychain::delete_password(&account);
        }
        None => {}
    }
    let db = state.db.lock().await;
    let existing: IdleLockConfig = db
        .get_setting(IDLE_LOCK_KEY)
        .map_err(|e| e.to_string())?
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or(IdleLockConfig {
            enabled: false,
            timeout_minutes: 10,
            use_touch_id: false,
            has_pin: false,
        });
    let next = IdleLockConfig {
        enabled,
        timeout_minutes: timeout_minutes.unwrap_or(existing.timeout_minutes).clamp(1, 60),
        use_touch_id: use_touch_id.unwrap_or(existing.use_touch_id),
        has_pin: existing.has_pin,
    };
    let raw = serde_json::to_string(&next).map_err(|e| e.to_string())?;
    db.set_setting(IDLE_LOCK_KEY, &raw).map_err(|e| e.to_string())?;
    Ok(())
}

/// 用 PIN 解锁。成功返回 true；失败返回 false（不抛错，便于前端提示）。
#[tauri::command]
pub async fn idle_lock_unlock(state: State<'_, AppState>, pin: String) -> CmdResult<bool> {
    let account = crate::infra::keychain::idle_lock_pin_account();
    let stored = crate::infra::keychain::load_password(&account);
    let db = state.db.lock().await;
    let cfg: IdleLockConfig = db
        .get_setting(IDLE_LOCK_KEY)
        .map_err(|e| e.to_string())?
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or(IdleLockConfig {
            enabled: false,
            timeout_minutes: 10,
            use_touch_id: false,
            has_pin: false,
        });
    drop(db);
    if !cfg.enabled {
        return Ok(true);
    }
    // 暴力破解防护：冷却期内直接拒绝（前端展示剩余等待时间）
    let now = now_ms();
    let locked_until = PIN_LOCKED_UNTIL.load(Ordering::Relaxed);
    if now < locked_until {
        return Ok(false);
    }
    let ok = match stored {
        Ok(s) => s == pin,
        Err(_) => false,
    };
    if ok {
        PIN_FAILURES.store(0, Ordering::Relaxed);
        PIN_LOCKED_UNTIL.store(0, Ordering::Relaxed);
        return Ok(true);
    }
    let failures = PIN_FAILURES.fetch_add(1, Ordering::Relaxed) + 1;
    if failures >= PIN_MAX_FAILURES {
        let extra = failures - PIN_MAX_FAILURES;
        let lock_ms = (PIN_LOCKOUT_STEP * (extra as u64 + 1)) * 1000;
        PIN_LOCKED_UNTIL.store(now + lock_ms, Ordering::Relaxed);
        // 注意：此处不要重置 PIN_FAILURES。累计失败次数用于让每次锁定期递增
        // （30s → 60s → 90s…），仅在成功解锁时归零（见上方 ok 分支）。
    }
    Ok(false)
}

// ---------------------------------------------------------------------------
// sudo 密码自动填充（SSH 会话，可关）
// ---------------------------------------------------------------------------

const SUDO_AUTOFILL_KEY: &str = "sudo_autofill";

#[tauri::command]
pub async fn sudo_config_get(state: State<'_, AppState>) -> CmdResult<bool> {
    let db = state.db.lock().await;
    let raw = db.get_setting(SUDO_AUTOFILL_KEY).map_err(|e| e.to_string())?;
    Ok(raw.as_deref().map(|s| s == "1").unwrap_or(true))
}

#[tauri::command]
pub async fn sudo_config_set(state: State<'_, AppState>, enabled: bool) -> CmdResult<()> {
    let db = state.db.lock().await;
    db.set_setting(SUDO_AUTOFILL_KEY, if enabled { "1" } else { "0" })
        .map_err(|e| e.to_string())?;
    drop(db);
    state.ssh.set_sudo_autofill(enabled);
    Ok(())
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
// container create (P0: 运行新容器表单)
// ---------------------------------------------------------------------------

/// 运行新容器的完整参数（与前端「运行容器」弹窗一一对应）。
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerCreateSpec {
    pub engine_id: String,
    pub name: String,
    pub image: String,
    /// 启动命令（覆盖镜像 CMD），如 `nginx -g 'daemon off;'`
    pub cmd: Option<String>,
    /// 覆盖镜像 ENTRYPOINT，如 `/usr/local/bin/start.sh --prod`
    pub entrypoint: Option<String>,
    /// 环境变量，`KEY=VALUE` 列表
    pub env: Option<Vec<String>>,
    /// 端口映射，逗号分隔 `host:container[/proto]`，如 `8080:80,5432:5432`
    pub ports: Option<String>,
    /// 卷挂载，`host:container[:ro]` 列表
    pub volumes: Option<Vec<String>>,
    /// 网络名（默认 bridge）
    pub network: Option<String>,
    /// 重启策略：no / always / on-failure / unless-stopped
    pub restart: Option<String>,
    /// 内存上限（MB）
    pub memory_mb: Option<u64>,
    /// CPU 数量限制
    pub cpus: Option<f64>,
}

#[tauri::command]
pub async fn containers_create(
    state: State<'_, AppState>,
    input: ContainerCreateSpec,
) -> CmdResult<String> {
    state.docker.create_container(&input).await.map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// volumes (P1: 卷创建/删除)
// ---------------------------------------------------------------------------
#[tauri::command]
pub async fn volumes_create(
    state: State<'_, AppState>,
    engine_id: String,
    name: String,
    driver: Option<String>,
    driver_opts: Option<std::collections::HashMap<String, String>>,
    labels: Option<std::collections::HashMap<String, String>>,
) -> CmdResult<()> {
    state
        .docker
        .create_volume(&engine_id, &name, driver.as_deref(), driver_opts, labels)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn volumes_remove(state: State<'_, AppState>, engine_id: String, name: String) -> CmdResult<()> {
    state
        .docker
        .remove_volume(&engine_id, &name)
        .await
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// networks (P2: 网络创建/删除)
// ---------------------------------------------------------------------------
#[tauri::command]
pub async fn networks_create(
    state: State<'_, AppState>,
    engine_id: String,
    name: String,
    driver: Option<String>,
) -> CmdResult<()> {
    state
        .docker
        .create_network(&engine_id, &name, driver.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn networks_remove(state: State<'_, AppState>, engine_id: String, id: String) -> CmdResult<()> {
    state
        .docker
        .remove_network(&engine_id, &id)
        .await
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// host processes (P2: 主机进程查看)
// ---------------------------------------------------------------------------
#[tauri::command]
pub async fn host_processes(state: State<'_, AppState>, host_id: String) -> CmdResult<Vec<crate::models::HostProcess>> {
    state.ssh.list_processes(&host_id).await.map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// snippets (P1: 常用命令库)
// ---------------------------------------------------------------------------
#[tauri::command]
pub async fn snippets_list(state: State<'_, AppState>) -> CmdResult<Vec<crate::models::Snippet>> {
    let db = state.db.lock().await;
    db.list_snippets().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn snippets_save(state: State<'_, AppState>, snippet: crate::models::Snippet) -> CmdResult<()> {
    let db = state.db.lock().await;
    db.upsert_snippet(&snippet).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn snippets_delete(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    let db = state.db.lock().await;
    db.delete_snippet(&id).map_err(|e| e.to_string())
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

// event-driven port forwarding
#[tauri::command]
pub async fn auto_forward_set(
    state: State<'_, AppState>,
    engine_id: String,
    host_id: Option<String>,
) -> CmdResult<()> {
    state
        .auto_forward
        .set(&engine_id, host_id.as_deref())
        .await;
    Ok(())
}

#[tauri::command]
pub async fn auto_forward_get(
    state: State<'_, AppState>,
    engine_id: String,
) -> CmdResult<Option<String>> {
    Ok(state.auto_forward.get(&engine_id).await)
}

// docker compose (P1)
#[tauri::command]
pub async fn compose_run(
    state: State<'_, AppState>,
    host_id: String,
    dir: Option<String>,
    file: Option<String>,
    args: Vec<String>,
) -> CmdResult<String> {
    state
        .compose
        .run(&host_id, dir.as_deref(), file.as_deref(), &args)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn compose_ps(
    state: State<'_, AppState>,
    host_id: String,
    dir: Option<String>,
    file: Option<String>,
) -> CmdResult<Vec<ComposeService>> {
    state
        .compose
        .ps(&host_id, dir.as_deref(), file.as_deref())
        .await
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// remote docker over SSH (streamlocal bridge to docker.sock)
// ---------------------------------------------------------------------------
#[tauri::command]
pub async fn remote_docker_mount(
    state: State<'_, AppState>,
    host_id: String,
) -> CmdResult<RemoteDockerMount> {
    state.remote_docker.mount(&host_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn remote_docker_unmount(state: State<'_, AppState>, host_id: String) -> CmdResult<()> {
    state.remote_docker.unmount(&host_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn remote_docker_list_mounts(
    state: State<'_, AppState>,
) -> CmdResult<Vec<RemoteDockerMount>> {
    Ok(state.remote_docker.list_mounts().await)
}

#[tauri::command]
pub async fn remote_docker_containers(
    state: State<'_, AppState>,
    host_id: String,
) -> CmdResult<Vec<Container>> {
    state
        .remote_docker
        .list_containers(&host_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn remote_docker_images(
    state: State<'_, AppState>,
    host_id: String,
) -> CmdResult<Vec<DockerImage>> {
    state
        .remote_docker
        .list_images(&host_id)
        .await
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// ZMODEM file transfer
// ---------------------------------------------------------------------------
#[tauri::command]
pub async fn zmodem_upload(
    state: State<'_, AppState>,
    host_id: String,
    local_path: String,
    remote_dir: String,
) -> CmdResult<String> {
    state
        .zmodem
        .upload(&host_id, &local_path, &remote_dir)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn zmodem_download(
    state: State<'_, AppState>,
    host_id: String,
    remote_path: String,
    local_dir: String,
) -> CmdResult<String> {
    state
        .zmodem
        .download(&host_id, &remote_path, &local_dir)
        .await
        .map_err(|e| e.to_string())
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
        Err(_) => match state.docker.exec_input(&session_id, data.as_bytes()).await {
            Ok(()) => Ok(()),
            Err(_) => state.local.input(&session_id, data.as_bytes()).await.map_err(|e| e.to_string()),
        },
    }
}

/// Resize a PTY session (xterm fit → SSH window-change).
#[tauri::command]
pub async fn term_resize(state: State<'_, AppState>, session_id: String, cols: u32, rows: u32) -> CmdResult<()> {
    match state.ssh.resize(&session_id, cols, rows).await {
        Ok(()) => Ok(()),
        Err(_) => match state.docker.exec_resize(&session_id, cols as u16, rows as u16).await {
            Ok(()) => Ok(()),
            Err(_) => state.local.resize(&session_id, cols, rows).await.map_err(|e| e.to_string()),
        },
    }
}

/// 打开 macOS 本地 shell（PTY）。返回本地会话 id。
#[tauri::command]
pub async fn local_shell_start(
    state: State<'_, AppState>,
    cols: Option<u32>,
    rows: Option<u32>,
) -> CmdResult<String> {
    state
        .local
        .start(cols.unwrap_or(80), rows.unwrap_or(24))
        .await
        .map_err(|e| e.to_string())
}

/// 关闭本地 shell 会话。
#[tauri::command]
pub async fn local_shell_stop(state: State<'_, AppState>, session_id: String) -> CmdResult<()> {
    state.local.stop(&session_id).await.map_err(|e| e.to_string())
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

#[tauri::command]
pub async fn ssh_auth_respond(
    state: State<'_, AppState>,
    prompt_id: String,
    answers: Vec<String>,
) -> CmdResult<()> {
    state
        .ssh
        .resolve_auth(&prompt_id, answers)
        .await
        .map_err(|e| e.to_string())
}

/// 广播终端：把输入写入多个已连接会话的 PTY。
#[tauri::command]
pub async fn ssh_broadcast(
    state: State<'_, AppState>,
    session_ids: Vec<String>,
    data: String,
) -> CmdResult<usize> {
    state
        .ssh
        .broadcast(&session_ids, data.as_bytes())
        .await
        .map_err(|e| e.to_string())
}
