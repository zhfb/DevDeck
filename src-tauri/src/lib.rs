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
    auto_forward::AutoForwardManager, compose::ComposeManager, docker::DockerManager, hostkey::HostKeyResolver, hostkey::{ssh_host_key_decide, ssh_known_hosts_forget},
    remote_docker::RemoteDockerManager, zmodem::ZmodemManager,
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

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build());

    // Sentry crash reporting (P1) — only activates when DEVDDECK_SENTRY_DSN
    // is set, so dev builds stay dependency-free at runtime. Release CI
    // passes the DSN via env.
    if let Ok(dsn) = std::env::var("DEVDDECK_SENTRY_DSN") {
        if !dsn.is_empty() {
            let mut opts = sentry::ClientOptions::default();
            opts.release = sentry::release_name!();
            opts.environment = Some(
                (if cfg!(debug_assertions) { "development" } else { "production" }).into(),
            );
            let client = sentry::init((dsn, opts));
            builder = builder.plugin(tauri_plugin_sentry::init(&client));
        }
    }

    builder
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
            let auto_forward = Arc::new(AutoForwardManager::new(db.clone(), docker.clone(), tunnels.clone()));
            let compose = Arc::new(ComposeManager::new(ssh.clone()));
            let remote_docker = Arc::new(RemoteDockerManager::new(ssh.clone()));
            let zmodem = Arc::new(ZmodemManager::new(ssh.clone()));

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
            let auto_forward_bg = auto_forward.clone();
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
                    let engine_id = engine.id.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = docker.run_event_forwarding(app, &engine_id, power).await;
                    });
                    // event-driven port forwarding watcher (enabled at runtime
                    // via auto_forward_set; idle-poll while disabled)
                    let af = auto_forward_bg.clone();
                    tauri::async_runtime::spawn(async move {
                        af.run(engine.id.clone()).await;
                    });
                }
            });

            // 内置引擎自动拉起：若没有外部引擎（OrbStack 等未运行），延迟片刻后
            // 自管启动 DevDeck 的内置 dockerd VM，让应用"开箱即用"。
            let docker_for_emb = docker.clone();
            app.manage(AppState {
                db,
                docker,
                ssh,
                stats,
                power,
                sftp,
                tunnels,
                hostkey,
                auto_forward,
                compose,
                remote_docker,
                zmodem,
                embedded: crate::services::embedded::EmbeddedEngine::new(),
                local: crate::services::local_pty::LocalPtyManager::new(app.handle().clone()),
            });

            {
                let emb = crate::services::embedded::EmbeddedEngine::new();
                let docker_bg = docker_for_emb;
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(8)).await;
                    // 若已有可用引擎（如 OrbStack 正在运行），则跳过自启动
                    if let Ok(engines) = docker_bg.probe().await {
                        if !engines.is_empty() {
                            tracing::info!("embedded: external engine present, skip auto-ensure");
                            return;
                        }
                    }
                    match emb.ensure().await {
                        Ok(sock) => {
                            tracing::info!("embedded engine ready: {}", sock.display());
                            let _ = docker_bg.probe().await;
                        }
                        Err(e) => {
                            tracing::warn!("embedded auto-ensure failed: {e}");
                        }
                    }
                });
            }

            // 恢复 sudo 自动填充开关（默认开启）
            {
                let st = app_handle.state::<crate::commands::AppState>();
                let db = st.db.clone();
                let ssh = st.ssh.clone();
                tauri::async_runtime::spawn(async move {
                    let enabled = {
                        let db = db.lock().await;
                        db.get_setting("sudo_autofill")
                            .ok()
                            .flatten()
                            .map(|s| s == "1")
                            .unwrap_or(true)
                    };
                    ssh.set_sudo_autofill(enabled);
                });
            }

            // macOS 系统托盘（menu bar）—— P0
            if let Err(e) = tray::init_tray(app_handle) {
                tracing::warn!("tray init failed: {e}");
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            power_state_get,
            power_state_set,
            updater_check,
            updater_install,
            sftp_list,
            sftp_mkdir,
            sftp_remove,
            sftp_rename,
            sftp_transfer,
            sftp_transfer_cancel,
            sftp_transfer_batch,
            local_fs_list,
            engines_list,
            embedded_status,
            embedded_start,
            embedded_stop,
            embedded_reset,
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
            containers_create,
            images_list,
            images_pull,
            images_remove,
            registries_list,
            registries_save,
            registries_delete,
            registry_ping,
            registry_repos,
            registry_tags,
            config_export,
            config_import,
            idle_lock_config_get,
            idle_lock_config_set,
            idle_lock_unlock,
            local_shell_start,
            local_shell_stop,
            sudo_config_get,
            sudo_config_set,
            volumes_list,
            volumes_create,
            volumes_remove,
            networks_list,
            networks_create,
            networks_remove,
            host_processes,
            snippets_list,
            snippets_save,
            snippets_delete,
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
            ssh_auth_respond,
            ssh_broadcast,
            auto_forward_set,
            auto_forward_get,
            compose_run,
            compose_ps,
            remote_docker_mount,
            remote_docker_unmount,
            remote_docker_list_mounts,
            remote_docker_containers,
            remote_docker_images,
            zmodem_upload,
            zmodem_download,
            term_input,
            term_resize,
        ])
        .run(tauri::generate_context!())
        .expect("error while running DevDeck");
}
