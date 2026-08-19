//! DevDeck Tauri application core.

pub mod commands;
pub mod infra;
pub mod models;
pub mod services;

use std::sync::Arc;
use tauri::{Emitter, Manager};
use tokio::sync::Mutex;

use commands::{AppState, *};
use infra::db::AppDb;
use services::{docker::DockerManager, ssh::SshManager, stats::StatsCollector, tunnel::TunnelManager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,devdeck=debug".into()),
        )
        .with_target(false)
        .init();

    tauri::Builder::default()
        .setup(|app| {
            let app_handle = app.handle();

            // persistent store
            let db = Arc::new(Mutex::new(AppDb::open().map_err(|e| {
                tracing::error!("db init failed: {e}");
                e.to_string()
            })?));

            // services
            let docker = Arc::new(DockerManager::new());
            let ssh = Arc::new(SshManager::new(app_handle.clone()));
            let stats = StatsCollector::new(app_handle.clone());
            let tunnels = Arc::new(TunnelManager::new(db.clone()));

            // background tasks
            let docker_bg = docker.clone();
            let app_bg = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                // probe local engines on startup
                if let Err(e) = docker_bg.probe().await {
                    tracing::warn!("docker probe failed: {e}");
                }
                // forward docker events → frontend
                if let Ok(stream) = docker_bg.event_stream("local-orbstack").await {
                    use futures_util::StreamExt;
                    let mut stream = Box::pin(stream);
                    while let Some(ev) = stream.next().await {
                        let _ = app_bg.emit("docker:events", serde_json::json!({ "events": [ev] }));
                    }
                }
            });

            app.manage(AppState {
                db,
                docker,
                ssh,
                stats,
                tunnels,
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            engines_list,
            hosts_list,
            hosts_groups,
            hosts_stats,
            hosts_stats_history,
            hosts_save,
            hosts_delete,
            containers_list,
            containers_get,
            containers_start,
            containers_stop,
            containers_restart,
            containers_pause,
            containers_unpause,
            containers_remove,
            images_list,
            images_pull,
            images_remove,
            volumes_list,
            networks_list,
            tunnels_list,
            tunnels_save,
            tunnels_delete,
            tunnels_start,
            tunnels_stop,
            ssh_connect,
            ssh_disconnect,
            ssh_sessions,
            term_input,
            term_resize,
        ])
        .run(tauri::generate_context!())
        .expect("error while running DevDeck");
}
