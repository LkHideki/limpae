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
        ])
        .run(tauri::generate_context!())
        .expect("erro ao iniciar o Limpaemeo");
}
