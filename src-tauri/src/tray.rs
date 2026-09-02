//! macOS 系统托盘（menu bar）集成 —— DevDeck P0 功能。
//!
//! 托盘菜单结构与事件约定（统一事件名 `tray:action`）：
//!
//! | 菜单项          | 行为                                              |
//! |-----------------|---------------------------------------------------|
//! | 打开 DevDeck    | show/unminimize/set_focus 主窗口（不发事件）      |
//! | 新建 SSH 连接   | emit `tray:action` `{ "action": "new-ssh" }`      |
//! | ─────────────── |                                                   |
//! | 本地引擎状态    | emit `tray:action` `{ "action": "engine-status" }`|
//! | 退出            | `app.exit(0)`                                    |
//!
//! 前端在 `frontend/src/app/TrayEvents.tsx` 监听 `tray:action` 并转发为
//! 全局 CustomEvent（`devdeck:new-ssh` / `devdeck:engine-status`）。

use tauri::{Emitter, Manager};
use std::sync::atomic::{AtomicBool, Ordering};

/// 托盘图标 id（OS 级标识，与窗口 label 无关）。
const TRAY_ID: &str = "main";
/// 主窗口 label（tauri.conf.json 未显式指定，默认即 "main"）。
const MAIN_WINDOW: &str = "main";

/// 防止 dev 热重载 / 重复 setup 时在菜单栏创建出多个托盘图标。
static TRAY_CREATED: AtomicBool = AtomicBool::new(false);

/// 菜单项 id。
const ITEM_OPEN: &str = "open";
const ITEM_NEW_SSH: &str = "new-ssh";
const ITEM_ENGINE_STATUS: &str = "engine-status";
const ITEM_QUIT: &str = "quit";

/// 统一的前端事件名。
const TRAY_ACTION_EVENT: &str = "tray:action";

/// 初始化 macOS 菜单栏托盘图标及其菜单。
pub fn init_tray(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem};

    if TRAY_CREATED.swap(true, Ordering::SeqCst) {
        tracing::debug!("devdeck: tray already created, skipping duplicate");
        return Ok(());
    }

    let icon = app
        .default_window_icon()
        .ok_or("no default window icon available for tray")?
        .clone();

    // ── 菜单 ─────────────────────────────────────────────────────────
    let open_item = MenuItem::with_id(app, ITEM_OPEN, "打开 DevDeck", true, None::<&str>)?;
    let new_ssh_item =
        MenuItem::with_id(app, ITEM_NEW_SSH, "新建 SSH 连接", true, None::<&str>)?;
    let engine_item =
        MenuItem::with_id(app, ITEM_ENGINE_STATUS, "本地引擎状态", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, ITEM_QUIT, "退出", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;

    let items: [&dyn IsMenuItem<tauri::Wry>; 5] = [
        &open_item,
        &new_ssh_item,
        &separator,
        &engine_item,
        &quit_item,
    ];
    let menu = Menu::with_items(app, &items)?;

    // ── 托盘图标 ─────────────────────────────────────────────────────
    tauri::tray::TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .menu(&menu)
        // 左键不弹菜单（macOS 惯例：左键留给"点图标唤起主窗口"类行为，
        // 菜单由右键触发；如需左键弹菜单可改 .menu_on_left_click(true)）。
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            ITEM_OPEN => {
                if let Some(win) = app.get_webview_window(MAIN_WINDOW) {
                    let _ = win.show();
                    let _ = win.unminimize();
                    let _ = win.set_focus();
                }
            }
            ITEM_NEW_SSH => {
                let _ = app.emit(
                    TRAY_ACTION_EVENT,
                    serde_json::json!({ "action": "new-ssh" }),
                );
            }
            ITEM_ENGINE_STATUS => {
                let _ = app.emit(
                    TRAY_ACTION_EVENT,
                    serde_json::json!({ "action": "engine-status" }),
                );
            }
            ITEM_QUIT => {
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;

    tracing::info!("devdeck: tray icon initialized");
    Ok(())
}
