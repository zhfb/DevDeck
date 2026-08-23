//! DevDeck Tauri application core.

pub mod commands;
pub mod infra;
pub mod models;
pub mod services;
pub mod tray;

use std::sync::Arc;
use tauri::Manager;
use tokio::sync::Mutex;

use commands::{AppState, *};
use infra::db::AppDb;
use services::{
    docker::DockerManager, hostkey::HostKeyResolver, hostkey::{ssh_host_key_decide, ssh_known_hosts_forget},
    power::PowerManager, ssh::SshManager, stats::StatsCollector, tunnel::TunnelManager,
    sftp::SftpManager,
};

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
            // macOS dev 模式：显式设置 Dock 应用图标（dev 二进制无 bundle，Tauri 默认图标是黑底 exec）
            #[cfg(all(dev, target_os = "macos"))]
            {
                use objc2::{AllocAnyThread, MainThreadMarker};
                use objc2_app_kit::{NSApplication, NSImage};
                use objc2_foundation::NSData;

                let mtm = unsafe { MainThreadMarker::new_unchecked() };
                let ns_app = NSApplication::sharedApplication(mtm);
                let data = NSData::with_bytes(include_bytes!("../icons/icon.png"));
                let app_icon =
                    NSImage::initWithData(NSImage::alloc(), &data).expect("creating app icon");
                tracing::info!(
                    "devdeck: setting dock icon via NSApp, img={}x{}",
                    app_icon.size().width,
                    app_icon.size().height
                );
                unsafe { ns_app.setApplicationIconImage(Some(&app_icon)) };
                tracing::info!("devdeck: dock icon set done");
            }

            let app_handle = app.handle();

            // persistent store
            let db = Arc::new(Mutex::new(AppDb::open().map_err(|e| {
                tracing::error!("db init failed: {e}");
                e.to_string()
            })?));

            // services
            let docker = Arc::new(DockerManager::new());
            // known_hosts TOFU resolver — shared between SshManager (host key
            // verification during the handshake) and AppState (so the
            // `ssh_host_key_decide` command can resolve pending prompts).
            let hostkey = Arc::new(HostKeyResolver::new(app_handle.clone()));
            let ssh = Arc::new(SshManager::new(app_handle.clone(), (*hostkey).clone()));
            let stats = StatsCollector::new(app_handle.clone());
            let power = PowerManager::new();
            let tunnels = Arc::new(TunnelManager::new(db.clone(), ssh.clone()));
            let sftp = Arc::new(SftpManager::new(ssh.clone()));

            // Adaptive no-agent monitoring: SSH keepalive and active tunnels
            // remain independent; only optional stats sampling is throttled.
            let stats_bg = stats.clone();
            let ssh_bg = ssh.clone();
            let power_bg = power.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    let policy = power_bg.snapshot().await.policy;
                    if let Some(interval) = policy.stats_interval_secs {
                        for host_id in ssh_bg.active_host_ids().await {
                            if let Ok(output) = ssh_bg.exec_for_host(&host_id, services::stats::STATS_BATCH_CMD).await {
                                if let Some(sample) = stats_bg.parse_batch(&host_id, &output) {
                                    stats_bg.record(sample).await;
                                }
                            }
                        }
                        tokio::time::sleep(std::time::Duration::from_secs(interval)).await;
                    } else {
                        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                    }
                }
            });

            // background tasks
            let docker_bg = docker.clone();
            let app_bg = app_handle.clone();
            let power_bg = power.clone();
            tauri::async_runtime::spawn(async move {
                // probe local engines on startup
                let engines = match docker_bg.probe().await {
                    Ok(engines) => engines,
                    Err(e) => {
                        tracing::warn!("docker probe failed: {e}");
                        return;
                    }
                };
                // Forward each reachable engine independently. This avoids a
                // hard-coded OrbStack id and lets Docker Desktop/Colima/Podman
                // receive the same self-healing events + snapshot compensation.
                for engine in engines {
                    let docker = docker_bg.clone();
                    let app = app_bg.clone();
                    let power = power_bg.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = docker.run_event_forwarding(app, &engine.id, power).await;
                    });
                }
            });

            app.manage(AppState {
                db,
                docker,
                ssh,
                stats,
                power,
                sftp,
                tunnels,
                hostkey,
            });

            // macOS 系统托盘（menu bar）—— P0
            if let Err(e) = tray::init_tray(&app_handle) {
                tracing::warn!("tray init failed: {e}");
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            power_state_get,
            power_state_set,
            sftp_list,
            sftp_mkdir,
            sftp_remove,
            sftp_rename,
            sftp_transfer,
            sftp_transfer_cancel,
            sftp_transfer_batch,
            local_fs_list,
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
            containers_exec,
            containers_logs,
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
            ssh_reconnect,
            ssh_disconnect,
            ssh_sessions,
            ssh_host_key_decide,
            ssh_known_hosts_forget,
            term_input,
            term_resize,
        ])
        .run(tauri::generate_context!())
        .expect("error while running DevDeck");
}
