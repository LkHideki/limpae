//! Menu bar extra: a native NSMenu (no webview, nothing resident beyond the status item). The stat rows are
//! refreshed by a 60 s timer and just before the menu opens; both only do a statfs, two sysctls and, at most
//! every 5 minutes, a walk of `~/.Trash` (timer thread only, never on the main thread).

use std::sync::{Arc, Mutex};
use std::time::Duration;

use limpa_core::health;
use tauri::image::Image;
use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

use crate::cmd_health::{Effort, inputs, memory_label};
use crate::state::{AppState, lock};

const TRAY_ID: &str = "limpae-tray";
/// 36 px (18 pt @2x) template image as raw RGBA (black + alpha, generated with `tray@2x.png` from `tray.svg`);
/// macOS tints it for light, dark and highlighted menu bars. Raw because decoding the PNG would need tauri's
/// `image-png` feature, which pulls in the `image` crate and three more.
const ICON: &[u8] = include_bytes!("../icons/tray@2x.rgba");
const ICON_SIDE: u32 = 36;
const TIMER: Duration = Duration::from_secs(60);
/// Hovering the icon and clicking it both ask for a refresh; one is enough per this window.
const EVENT_REFRESH_GAP: Duration = Duration::from_secs(2);

#[derive(Clone)]
struct Rows {
    header: MenuItem<tauri::Wry>,
    disk: MenuItem<tauri::Wry>,
    memory: MenuItem<tauri::Wry>,
    trash: MenuItem<tauri::Wry>,
}

#[derive(Default)]
pub struct TrayState {
    rows: Mutex<Option<Rows>>,
    last_event_refresh: Mutex<Option<std::time::Instant>>,
}

fn state_of(app: &AppHandle) -> Arc<AppState> {
    Arc::clone(app.state::<Arc<AppState>>().inner())
}

pub fn menu_bar_enabled(app: &AppHandle) -> bool {
    lock(&state_of(app).settings).menu_bar
}

/// Brings the tray in line with `settings.menu_bar`. Safe to call from any thread, any number of times.
pub fn apply(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let want = menu_bar_enabled(&handle);
        let ts = handle.state::<TrayState>();
        let mut rows = ts.rows.lock().unwrap_or_else(|e| e.into_inner());
        match (want, rows.is_some()) {
            (true, false) => match build(&handle) {
                Ok(r) => {
                    *rows = Some(r);
                    drop(rows);
                    refresh(&handle, Effort::INSTANT);
                    // The first Trash walk happens off the main thread; the row says "calculando…" until then.
                    let h = handle.clone();
                    std::thread::spawn(move || refresh(&h, Effort::TIMER));
                }
                Err(e) => eprintln!("barra de menus: {e}"),
            },
            (false, true) => {
                *rows = None;
                handle.remove_tray_by_id(TRAY_ID);
            }
            _ => {}
        }
    });
}

fn build(app: &AppHandle) -> tauri::Result<Rows> {
    let header = MenuItem::with_id(app, "header", "Limpae", false, None::<&str>)?;
    let disk = MenuItem::with_id(app, "disk", "Livre: …", false, None::<&str>)?;
    let memory = MenuItem::with_id(app, "memory", "Memória: …", false, None::<&str>)?;
    let trash = MenuItem::with_id(app, "trash-size", "Lixeira: …", false, None::<&str>)?;
    let item = |id: &str, text: &str| MenuItem::with_id(app, id, text, true, None::<&str>);
    let open = item("open", "Abrir Limpae")?;
    let smart = item("smart", "Faxina…")?;
    let empty = item("trash", "Esvaziar Lixeira…")?;
    let prefs = item("settings", "Ajustes…")?;
    let quit = item("quit", "Sair")?;
    let sep = || PredefinedMenuItem::separator(app);
    let menu = Menu::with_items(
        app,
        &[&header, &disk, &memory, &trash, &sep()?, &open, &smart, &empty, &sep()?, &prefs, &quit],
    )?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(Image::new(ICON, ICON_SIDE, ICON_SIDE))
        .icon_as_template(true)
        .tooltip("Limpae")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(on_menu)
        .on_tray_icon_event(|tray, event| {
            let wants_refresh = matches!(
                event,
                TrayIconEvent::Enter { .. } | TrayIconEvent::Click { button_state: MouseButtonState::Down, .. }
            );
            if wants_refresh {
                refresh_from_event(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(Rows { header, disk, memory, trash })
}

fn on_menu(app: &AppHandle, event: MenuEvent) {
    match event.id().as_ref() {
        "open" => show_main(app, None),
        "smart" => show_main(app, Some("smart")),
        "trash" => show_main(app, Some("trash")),
        "settings" => show_main(app, Some("settings")),
        "quit" => app.exit(0),
        _ => {}
    }
}

/// Shows (and focuses) the main window; with `module`, asks the UI to navigate there. The UI ignores the request
/// while an operation is running, so a menu click can never interrupt a cleanup.
pub fn show_main(app: &AppHandle, module: Option<&str>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
    if let Some(m) = module {
        let _ = app.emit("navigate", m);
    }
}

fn refresh_from_event(app: &AppHandle) {
    let ts = app.state::<TrayState>();
    {
        let mut last = ts.last_event_refresh.lock().unwrap_or_else(|e| e.into_inner());
        if last.is_some_and(|t| t.elapsed() < EVENT_REFRESH_GAP) {
            return;
        }
        *last = Some(std::time::Instant::now());
    }
    refresh(app, Effort::INSTANT);
}

/// Updates the four stat rows. A no-op while the tray is off. The (possibly slow) inputs are gathered and the
/// row handles cloned before touching any item, so no lock is held while waiting on the main thread.
pub fn refresh(app: &AppHandle, effort: Effort) {
    let rows = app.state::<TrayState>().rows.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let Some(r) = rows else { return };
    let i = inputs(&state_of(app), effort);
    let h = health::score(&i);
    let _ = r.header.set_text(format!("Limpae · Saúde: {}", h.level.label()));
    let _ = r.disk.set_text(if i.disk_total > 0 {
        format!("Livre: {} de {}", health::fmt_bytes(i.disk_free), health::fmt_bytes(i.disk_total))
    } else {
        "Livre: indisponível".into()
    });
    let _ = r.memory.set_text(format!("Memória: {}", memory_label(i.memory)));
    let _ = r.trash.set_text(match (i.fda, i.trash_bytes) {
        (_, Some(b)) => format!("Lixeira: {}", health::fmt_bytes(b)),
        (false, None) => "Lixeira: requer Acesso Total ao Disco".into(),
        (true, None) => "Lixeira: calculando…".into(),
    });
}

/// Starts the 60 s refresh thread. It sleeps between ticks and does nothing while the tray is off.
pub fn start_timer(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(TIMER);
            if menu_bar_enabled(&app) {
                refresh(&app, Effort::TIMER);
            }
        }
    });
}
