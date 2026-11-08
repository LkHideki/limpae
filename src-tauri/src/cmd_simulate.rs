//! Dry run of a removal: every check the real removal makes, nothing removed, and a report file the user can
//! keep. The real removal still checks everything again, since the disk can change in between.

use std::collections::HashSet;
use std::ffi::OsStr;
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use limpa_core::log::local_time;
use limpa_core::remove::{Plan, preflight};
use limpa_core::running::running_keys;
use serde::Serialize;
use tauri::State;

use crate::commands::{ERR_APP_OPEN, Shared, blocking, cache_of_running_app, open};
use crate::state::lock;

/// Reports kept; older ones are deleted when a new one is written.
const KEEP_REPORTS: usize = 20;

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tally {
    pub count: u64,
    pub bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Refusal {
    pub id: u64,
    pub error: String,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Simulation {
    /// Deleted for good (caches, logs, Trash entries, or everything with "Delete permanently").
    pub delete: Tally,
    /// Moved to the Trash (recoverable).
    pub trash: Tally,
    pub refused: Vec<Refusal>,
    /// The report file, when it could be written.
    pub report: Option<PathBuf>,
}

fn reports_dir(home: &Path) -> PathBuf {
    home.join("Library/Logs/Limpae/simulations")
}

/// Tab-separated, like the action log: action, would-happen/refused, bytes, path, reason.
fn report_text(rows: &[(u64, Plan)], permanent: bool) -> String {
    // The report is a file, in the same language as the action log; it never reaches the UI. i18n-ignore below.
    let mut s = format!("# Limpae — simulação de limpeza, {}\n", local_time()); // i18n-ignore
    let _ = writeln!(s, "# Nada foi removido. Apagar definitivamente: {}", if permanent { "sim" } else { "não" }); // i18n-ignore
    s.push_str("# ação\tresultado\tbytes\tcaminho\tmotivo\n"); // i18n-ignore
    for (_, p) in rows {
        let status = if p.error.is_some() { "recusado" } else { "ok" };
        let _ = writeln!(
            s,
            "{}\t{status}\t{}\t{}\t{}",
            p.action,
            p.size,
            p.path.display(),
            p.error.as_deref().unwrap_or("")
        );
    }
    s
}

fn write_report(home: &Path, text: &str) -> Option<PathBuf> {
    let dir = reports_dir(home);
    fs::create_dir_all(&dir).ok()?;
    let stamp = local_time().replace(':', ".").replace(' ', "_");
    let path = dir.join(format!("simulacao-{stamp}.tsv"));
    fs::write(&path, text).ok()?;
    let mut old: Vec<PathBuf> = fs::read_dir(&dir)
        .ok()?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "tsv"))
        .collect();
    old.sort();
    let excess = old.len().saturating_sub(KEEP_REPORTS);
    for p in old.into_iter().take(excess) {
        let _ = fs::remove_file(p);
    }
    Some(path)
}

pub(crate) fn simulate(
    st: &crate::state::AppState,
    ids: &[u64],
    permanent: bool,
    keys: &HashSet<String>,
) -> Simulation {
    let resolved = lock(&st.registry).resolve_removal(ids);
    let excluded = lock(&st.settings).excluded_for_removal();
    let mut sim = Simulation::default();
    let (busy, free): (Vec<_>, Vec<_>) = resolved.items.into_iter().partition(|(_, it)| cache_of_running_app(it, keys));
    let plain: Vec<_> = free.iter().map(|(_, it)| it.clone()).collect();
    let mut rows: Vec<(u64, Plan)> =
        free.iter().map(|(id, _)| *id).zip(preflight(&plain, &st.guard, permanent, &excluded)).collect();
    for (id, it) in busy {
        rows.push((id, Plan { path: it.path, action: "apagar", size: it.size, error: Some(ERR_APP_OPEN.into()) }));
    }
    for (id, p) in &rows {
        match (&p.error, p.action) {
            (Some(e), _) => sim.refused.push(Refusal { id: *id, error: e.clone() }),
            (None, "lixo") => (sim.trash.count, sim.trash.bytes) = (sim.trash.count + 1, sim.trash.bytes + p.size),
            (None, _) => (sim.delete.count, sim.delete.bytes) = (sim.delete.count + 1, sim.delete.bytes + p.size),
        }
    }
    sim.refused.extend(resolved.rejected.into_iter().map(|(id, why)| Refusal { id, error: why.into() }));
    sim.report = write_report(&st.home, &report_text(&rows, permanent));
    sim
}

#[tauri::command]
pub async fn simulate_removal(
    state: State<'_, Shared>,
    ids: Vec<u64>,
    permanent: Option<bool>,
) -> Result<Simulation, String> {
    let st = Arc::clone(state.inner());
    blocking(move || Ok(simulate(&st, &ids, permanent.unwrap_or(false), &running_keys()))).await
}

/// Shows a simulation report in the Finder. Only files inside the reports folder are accepted.
#[tauri::command]
pub async fn reveal_report(state: State<'_, Shared>, path: PathBuf) -> Result<(), String> {
    let st = Arc::clone(state.inner());
    blocking(move || {
        let dir = fs::canonicalize(reports_dir(&st.home)).map_err(|_| "Relatório não encontrado.".to_string())?;
        let real = fs::canonicalize(&path).map_err(|_| "Relatório não encontrado.".to_string())?;
        if real.parent() != Some(dir.as_path()) {
            return Err("Relatório não encontrado.".into());
        }
        open(&[OsStr::new("-R"), real.as_os_str()])
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry::Task;
    use crate::state::AppState;
    use limpa_core::{Group, Item, Policy};

    #[test]
    fn simulation_counts_refuses_and_writes_a_report_without_removing() {
        let tmp = tempfile::tempdir().unwrap();
        let home = fs::canonicalize(tmp.path()).unwrap();
        let caches = home.join("Library/Caches");
        fs::create_dir_all(caches.join("com.a")).unwrap();
        fs::create_dir_all(home.join("Documents")).unwrap();
        fs::write(home.join("Documents/d.txt"), b"d").unwrap();
        let st = AppState::with_home(home.clone());
        let items = vec![
            Item::new(caches.join("com.a"), 100, Policy::DeleteJunk { root: caches.clone() }),
            Item::new(home.join("Documents/d.txt"), 7, Policy::MoveToTrash),
            Item::new(caches.join("gone"), 5, Policy::DeleteJunk { root: caches.clone() }),
        ];
        let group = Group { id: "g".into(), title: "g".into(), description: String::new(), items };
        let dto = lock(&st.registry).replace(Task::Junk, vec![group]);
        let ids: Vec<u64> = dto[0].items.iter().map(|i| i.id).collect();
        let sim = simulate(&st, &[ids.clone(), vec![999_999]].concat(), false, &HashSet::new());
        assert_eq!((sim.delete.count, sim.delete.bytes), (1, 100));
        assert_eq!((sim.trash.count, sim.trash.bytes), (1, 7));
        assert_eq!(sim.refused.len(), 2, "{:?}", sim.refused);
        let report = fs::read_to_string(sim.report.unwrap()).unwrap();
        assert!(report.contains("\nlixo\tok\t7\t"), "{report}");
        assert!(report.contains("\napagar\trecusado\t5\t"), "{report}");
        assert!(caches.join("com.a").exists() && home.join("Documents/d.txt").exists());
    }
}
