mod cmd_apps;
mod cmd_cleanup;
mod cmd_clutter;
mod commands;
mod dto;
mod registry;
mod state;

use std::sync::Arc;

use state::AppState;

fn main() {
    let state = match AppState::new() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    };

    tauri::Builder::default()
        .manage(Arc::new(state))
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
            commands::reveal_log,
            commands::open_fda_settings,
            commands::get_settings,
            commands::set_settings,
            commands::ignore_item,
            commands::list_ignored,
            commands::unignore,
            cmd_cleanup::quick_look,
            cmd_clutter::clutter_locations,
            cmd_clutter::scan_duplicates,
            cmd_clutter::scan_similar,
            cmd_clutter::scan_downloads,
            cmd_clutter::scan_large_at,
            cmd_clutter::thumb,
            cmd_apps::apps_overview,
            cmd_apps::app_meta,
            cmd_apps::open_update,
        ])
        .run(tauri::generate_context!())
        .expect("erro ao iniciar o Limpaemeo");
}
