mod cmd_apps;
mod cmd_cleanup;
mod cmd_clutter;
mod cmd_health;
mod cmd_lens;
mod cmd_perf;
mod cmd_security;
mod commands;
mod dto;
mod registry;
mod state;
mod tray;

use std::sync::Arc;

use tauri::{Manager, RunEvent, WindowEvent};

use state::AppState;

fn main() {
    let state = match AppState::new() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    };

    let app = tauri::Builder::default()
        .manage(Arc::new(state))
        .manage(tray::TrayState::default())
        .setup(|app| {
            tray::apply(app.handle());
            tray::start_timer(app.handle());
            Ok(())
        })
        // With the menu bar extra on, closing the window only hides it (the app keeps living in the menu bar and
        // the Dock icon stays). Without it, closing quits as before.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event
                && window.label() == "main"
                && tray::menu_bar_enabled(window.app_handle())
            {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::disk_overview,
            commands::scan_junk,
            commands::scan_trash,
            commands::scan_large,
            commands::list_apps,
            commands::app_icon,
            commands::app_leftovers,
            commands::remove,
            commands::uninstall,
            commands::cancel_scan,
            commands::reveal,
            commands::open_app,
            commands::reveal_log,
            commands::open_fda_settings,
            commands::get_settings,
            commands::set_settings,
            commands::ignore_item,
            commands::list_ignored,
            commands::unignore,
            commands::trash_history,
            commands::restore_trashed,
            cmd_cleanup::quick_look,
            cmd_clutter::clutter_locations,
            cmd_clutter::scan_duplicates,
            cmd_clutter::scan_download_dups,
            cmd_clutter::scan_similar,
            cmd_clutter::scan_downloads,
            cmd_clutter::scan_large_at,
            cmd_clutter::thumb,
            cmd_apps::apps_overview,
            cmd_apps::app_meta,
            cmd_apps::open_update,
            cmd_lens::lens_roots,
            cmd_lens::lens_scan,
            cmd_lens::lens_children,
            cmd_lens::lens_select_review,
            cmd_lens::lens_icon,
            cmd_lens::lens_reveal,
            cmd_lens::lens_quicklook,
            cmd_lens::cloud_scan,
            cmd_lens::cloud_evict,
            cmd_health::health,
            cmd_health::activity,
            cmd_health::mark_smart_care,
            cmd_security::security_checks,
            cmd_security::open_security_fix,
            cmd_security::tcc_permissions,
            cmd_security::tcc_revoke,
            cmd_security::privacy_scan,
            cmd_security::privacy_remove,
            cmd_perf::perf_scan,
            cmd_perf::perf_monitor,
            cmd_perf::perf_icon,
            cmd_perf::agent_toggle,
            cmd_perf::agent_remove,
            cmd_perf::login_item_remove,
            cmd_perf::tm_thin,
        ])
        .build(tauri::generate_context!())
        .expect("erro ao iniciar o Limpae");

    app.run(|app, event| {
        // Clicking the Dock icon while the window is hidden brings it back.
        if let RunEvent::Reopen { has_visible_windows: false, .. } = event {
            tray::show_main(app, None);
        }
    });
}
