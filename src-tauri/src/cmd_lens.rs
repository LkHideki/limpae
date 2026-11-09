//! Disk Map and iCloud commands. Same contract as `commands`: the UI passes indexes and ids, never paths.
//! Lens nodes are addressed by their index in the in-memory tree; what the user selects for removal is
//! registered under `TASK_LENS` and removed by the existing guarded `remove`. iCloud files are registered under
//! `TASK_ICLOUD`, which `remove` refuses: they can only be evicted (local copy dropped, the file stays in iCloud).

use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::io::ErrorKind;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use limpa_core::cloud;
use limpa_core::lens::{self, Kind, LensTree, Node};
use limpa_core::running::app_icon_png;
use limpa_core::{Group, Guard, Item, Policy, Progress};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::dto::{OutcomeDto, ProgressEvent, RemoveResult, ScanResult};
use crate::registry::{TASK_ICLOUD, TASK_LENS};
use crate::state::{AppState, lock};

type Shared = Arc<AppState>;

const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);
const ERR_CANCELLED: &str = "Varredura cancelada.";
const ERR_NO_ROOT: &str = "Local não encontrado. Atualize a lista.";
const ERR_NO_TREE: &str = "Nenhum mapa disponível. Analise o espaço de novo.";
const ERR_NO_NODE: &str = "Item desconhecido. Analise o espaço de novo.";
const ERR_EMPTY_ROOT: &str = "Não foi possível ler este local.";
const ERR_NOTHING_REMOVABLE: &str = "Nenhum dos itens selecionados pode ser removido.";
const ERR_GONE: &str = "O item não existe mais no disco.";
const ERR_NO_PREVIEW: &str = "Este item não tem uma pasta própria para visualizar.";
const ICON_PX: u32 = 128;
/// Icons are tiny and few (one per `.app` on screen); the cache is dropped wholesale when it grows past this.
const ICON_CACHE_MAX: usize = 256;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RootDto {
    pub index: usize,
    pub name: String,
    pub path: String,
    pub is_volume: bool,
    pub total: u64,
    pub used: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeDto {
    pub id: u32,
    pub parent: Option<u32>,
    pub name: String,
    pub path: String,
    pub size: u64,
    pub is_dir: bool,
    pub kind: Kind,
    pub items: u32,
    /// The user may tick this node: not the synthetic small-files node, and the guard would accept removing it.
    pub selectable: bool,
    /// Double-click opens it: a folder whose contents are in the tree.
    pub drillable: bool,
}

#[derive(Debug, Serialize)]
pub struct CrumbDto {
    pub id: u32,
    pub name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LensScanDto {
    pub root: NodeDto,
    pub nodes: usize,
    pub tree_bytes: usize,
    pub volume_total: u64,
    pub volume_used: u64,
}

#[derive(Debug, Serialize)]
pub struct ChildrenDto {
    pub node: NodeDto,
    pub crumbs: Vec<CrumbDto>,
    pub children: Vec<NodeDto>,
}

fn describe(tree: &LensTree, guard: &Guard, n: Node) -> NodeDto {
    let selectable =
        n.kind != Kind::Small && tree.path_of(n.id).is_some_and(|p| guard.check(&p, &Policy::MoveToTrash).is_ok());
    NodeDto {
        id: n.id,
        parent: n.parent,
        drillable: n.kind == Kind::Dir && tree.child_count(n.id) > 0,
        name: n.name,
        path: n.path,
        size: n.size,
        is_dir: n.is_dir,
        kind: n.kind,
        items: n.items,
        selectable,
    }
}

/// Items for the nodes the user ticked: the synthetic node and anything the guard rejects are dropped first,
/// then nested picks collapse into their folder. Each item remembers the (device, inode) the scan saw.
fn review_items(tree: &LensTree, guard: &Guard, ids: &[u32]) -> Vec<Item> {
    let allowed: Vec<u32> = ids
        .iter()
        .copied()
        .filter(|&id| tree.path_of(id).is_some_and(|p| guard.check(&p, &Policy::MoveToTrash).is_ok()))
        .collect();
    tree.prune_nested(&allowed)
        .into_iter()
        .filter_map(|id| {
            let mut item = Item::new(tree.path_of(id)?, tree.size(id)?, Policy::MoveToTrash);
            if let Some(ident) = tree.ident(id) {
                item.ident = Some(ident);
            }
            Some(item)
        })
        .collect()
}

fn current_tree(st: &AppState) -> Result<Arc<LensTree>, String> {
    lock(&st.lens).tree.clone().ok_or_else(|| ERR_NO_TREE.to_string())
}

async fn blocking<T, F>(f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|_| "A operação foi interrompida de forma inesperada.".to_string())?
}

/// Unregisters the cancel flag from `AppState::active` on drop, panics included.
struct ActiveFlag {
    state: Shared,
    flag: Arc<AtomicBool>,
}

impl Drop for ActiveFlag {
    fn drop(&mut self) {
        lock(&self.state.active).retain(|f| !Arc::ptr_eq(f, &self.flag));
    }
}

/// Runs `f` on the blocking pool with a cancel flag (reached by `cancel_scan`) and a throttled `scan-progress`.
async fn run_scan<T, F>(app: AppHandle, state: &State<'_, Shared>, task: &'static str, f: F) -> Result<T, String>
where
    F: FnOnce(&AppState, &Progress) -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    let st = Arc::clone(state.inner());
    blocking(move || {
        let flag = Arc::new(AtomicBool::new(false));
        lock(&st.active).push(Arc::clone(&flag));
        let _active = ActiveFlag { state: Arc::clone(&st), flag: Arc::clone(&flag) };
        let last: Mutex<Option<Instant>> = Mutex::new(None);
        let progress = Progress::new(flag, move |path, bytes| {
            // Called from many scan threads; skipping when contended is fine, it is only a progress hint.
            let Ok(mut last) = last.try_lock() else { return };
            if last.is_some_and(|t| t.elapsed() < PROGRESS_INTERVAL) {
                return;
            }
            *last = Some(Instant::now());
            let _ = app.emit("scan-progress", ProgressEvent { task, path: path.to_string_lossy().into_owned(), bytes });
        });
        f(&st, &progress)
    })
    .await
}

#[tauri::command]
pub async fn lens_roots(state: State<'_, Shared>) -> Result<Vec<RootDto>, String> {
    let st = Arc::clone(state.inner());
    blocking(move || {
        let roots = lens::roots(&st.home);
        let dto = roots
            .iter()
            .enumerate()
            .map(|(index, r)| RootDto {
                index,
                name: r.name.clone(),
                path: r.path.to_string_lossy().into_owned(),
                is_volume: r.is_volume,
                total: r.total,
                used: r.used,
            })
            .collect();
        lock(&st.lens).roots = roots;
        Ok(dto)
    })
    .await
}

#[tauri::command]
pub async fn lens_scan(app: AppHandle, state: State<'_, Shared>, root: usize) -> Result<LensScanDto, String> {
    run_scan(app, &state, "lens", move |st, p| {
        let root = lock(&st.lens).roots.get(root).cloned().ok_or(ERR_NO_ROOT)?;
        // Free the previous map first: two big trees must not coexist.
        lock(&st.lens).tree = None;
        let tree = lens::build(&root.path, p);
        if p.cancelled() {
            return Err(ERR_CANCELLED.into());
        }
        let top = tree.node(LensTree::ROOT).ok_or(ERR_EMPTY_ROOT)?;
        let dto = LensScanDto {
            root: describe(&tree, &st.guard, top),
            nodes: tree.len(),
            tree_bytes: tree.heap_bytes(),
            volume_total: root.total,
            volume_used: root.used,
        };
        lock(&st.lens).tree = Some(Arc::new(tree));
        Ok(dto)
    })
    .await
}

#[tauri::command]
pub async fn lens_children(state: State<'_, Shared>, node_id: u32) -> Result<ChildrenDto, String> {
    let st = Arc::clone(state.inner());
    blocking(move || {
        let tree = current_tree(&st)?;
        let node = tree.node(node_id).ok_or(ERR_NO_NODE)?;
        let crumbs = tree
            .ancestors(node_id)
            .into_iter()
            .filter_map(|id| tree.node(id))
            .map(|n| CrumbDto { id: n.id, name: n.name })
            .collect();
        let children = tree.children(node_id).into_iter().map(|n| describe(&tree, &st.guard, n)).collect();
        Ok(ChildrenDto { node: describe(&tree, &st.guard, node), crumbs, children })
    })
    .await
}

/// Registers the ticked nodes as removal candidates (selected, Trash policy) and returns them like any scan.
#[tauri::command]
pub async fn lens_select_review(state: State<'_, Shared>, node_ids: Vec<u32>) -> Result<ScanResult, String> {
    let st = Arc::clone(state.inner());
    blocking(move || {
        let tree = current_tree(&st)?;
        let items = review_items(&tree, &st.guard, &node_ids);
        if items.is_empty() {
            return Err(ERR_NOTHING_REMOVABLE.into());
        }
        let group = Group {
            id: "lens".into(),
            title: "Itens selecionados".into(),
            description: "Serão movidos para o Lixo; dá para restaurá-los de lá.".into(),
            items,
        };
        Ok(ScanResult::new(lock(&st.registry).replace(TASK_LENS, vec![group]), false))
    })
    .await
}

/// Path a node stands for on disk. The synthetic small-files node has none of its own, so "reveal" falls back to
/// the folder that holds those files; `preview` refuses it instead.
fn node_path(tree: &LensTree, id: u32, fallback_parent: bool) -> Result<PathBuf, String> {
    let node = tree.node(id).ok_or(ERR_NO_NODE)?;
    let path = match tree.path_of(id) {
        Some(p) => Some(p),
        None if fallback_parent => node.parent.and_then(|p| tree.path_of(p)),
        None => None,
    };
    let path = path.ok_or(ERR_NO_PREVIEW)?;
    if std::fs::symlink_metadata(&path).is_err() {
        return Err(ERR_GONE.into());
    }
    Ok(path)
}

fn is_app_bundle(path: &std::path::Path) -> bool {
    path.extension().is_some_and(|e| e.eq_ignore_ascii_case("app"))
}

/// Finder icon of an `.app` bundle as a PNG data URL, cached by path (node ids change with every scan).
fn app_icon_url(path: &std::path::Path) -> Option<String> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, Option<String>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(hit) = lock(cache).get(path) {
        return hit.clone();
    }
    let url = app_icon_png(path, ICON_PX).map(|png| format!("data:image/png;base64,{}", STANDARD.encode(png)));
    let mut c = lock(cache);
    if c.len() >= ICON_CACHE_MAX {
        c.clear();
    }
    c.insert(path.to_path_buf(), url.clone());
    url
}

/// Real icon for an `.app` package node; `None` for anything else (the UI draws its own glyph).
#[tauri::command]
pub async fn lens_icon(state: State<'_, Shared>, node_id: u32) -> Result<Option<String>, String> {
    let st = Arc::clone(state.inner());
    blocking(move || {
        let tree = current_tree(&st)?;
        let node = tree.node(node_id).ok_or(ERR_NO_NODE)?;
        if node.kind != Kind::Package {
            return Ok(None);
        }
        Ok(tree.path_of(node_id).filter(|p| is_app_bundle(p)).and_then(|p| app_icon_url(&p)))
    })
    .await
}

/// Shows the node in Finder (`open -R`). The path is resolved from the tree; the UI only sends the id.
#[tauri::command]
pub async fn lens_reveal(state: State<'_, Shared>, node_id: u32) -> Result<(), String> {
    let st = Arc::clone(state.inner());
    blocking(move || {
        let tree = current_tree(&st)?;
        let path = node_path(&tree, node_id, true)?;
        crate::commands::open(&[OsStr::new("-R"), path.as_os_str()])
    })
    .await
}

/// Toggles the Quick Look panel for a node (see `cmd_cleanup::quick_look`); the path is resolved from the tree.
#[tauri::command]
pub async fn lens_quicklook(app: AppHandle, state: State<'_, Shared>, node_id: u32) -> Result<bool, String> {
    let st = Arc::clone(state.inner());
    blocking(move || {
        let tree = current_tree(&st)?;
        let path = node_path(&tree, node_id, false)?;
        crate::quicklook::preview(&app, path)
    })
    .await
}

#[tauri::command]
pub async fn cloud_scan(app: AppHandle, state: State<'_, Shared>) -> Result<ScanResult, String> {
    run_scan(app, &state, "icloud", |st, p| {
        let found = cloud::scan_downloaded(&st.home, cloud::MIN_BYTES, p);
        if p.cancelled() {
            return Err(ERR_CANCELLED.into());
        }
        match found {
            Ok(groups) => {
                let groups = lock(&st.settings).filter(groups);
                Ok(ScanResult::new(lock(&st.registry).replace(TASK_ICLOUD, groups), false))
            }
            // iCloud Drive is not set up on this Mac: nothing to list.
            Err(e) if e.kind() == ErrorKind::NotFound => {
                lock(&st.registry).replace(TASK_ICLOUD, Vec::new());
                Ok(ScanResult::new(Vec::new(), false))
            }
            Err(e) if e.kind() == ErrorKind::PermissionDenied => {
                lock(&st.registry).replace(TASK_ICLOUD, Vec::new());
                Ok(ScanResult::needs_fda())
            }
            Err(e) => Err(format!("Não foi possível ler o iCloud Drive: {e}")),
        }
    })
    .await
}

/// Whether macOS "Optimize Mac Storage" is on; `None` when the system does not say (key unset).
#[tauri::command]
pub fn cloud_optimize_status() -> Option<bool> {
    cloud::optimize_storage_enabled()
}

/// Drops the local copy of the listed iCloud files ("desincronizar"). Only ids of the last cloud scan are
/// accepted, and every file is re-validated by `cloud::evict` right before the system call.
#[tauri::command]
pub async fn cloud_evict(state: State<'_, Shared>, ids: Vec<u64>) -> Result<RemoveResult, String> {
    let st = Arc::clone(state.inner());
    blocking(move || {
        let resolved = lock(&st.registry).resolve_task(TASK_ICLOUD, &ids);
        let mut by_id: HashMap<u64, OutcomeDto> = HashMap::new();
        let mut done = Vec::new();
        for (id, item) in &resolved.items {
            match cloud::evict(&st.home, &item.path, item.ident) {
                Ok(freed) => {
                    st.log.record("desincronizar", &item.path, true, freed);
                    done.push(*id);
                    by_id.insert(*id, OutcomeDto::done(*id, freed));
                }
                Err(e) => {
                    st.log.record("desincronizar", &item.path, false, 0);
                    by_id.insert(*id, OutcomeDto::failed(*id, e.to_string()));
                }
            }
        }
        lock(&st.registry).forget(&done);
        by_id.extend(resolved.rejected.into_iter().map(|(id, why)| (id, OutcomeDto::failed(id, why))));
        let mut seen = HashSet::new();
        let outcomes: Vec<OutcomeDto> =
            ids.iter().filter(|id| seen.insert(**id)).filter_map(|id| by_id.remove(id)).collect();
        let freed = outcomes.iter().filter(|o| o.ok).map(|o| o.freed).sum();
        Ok(RemoveResult { outcomes, freed })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;
    use std::path::{Path, PathBuf};

    const SMALL: u64 = 100_000;

    fn write(path: &Path, bytes: usize) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut f = fs::File::create(path).unwrap();
        f.write_all(&vec![7u8; bytes]).unwrap();
        f.sync_all().unwrap();
    }

    /// Scratch folder removed on drop (this crate has no `tempfile` dev-dependency).
    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
            let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let dir = std::env::temp_dir().join(format!("limpae-lens-{}-{n}", std::process::id()));
            fs::create_dir_all(&dir).unwrap();
            Self(fs::canonicalize(dir).unwrap())
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    struct Fx {
        _t: TempDir,
        home: PathBuf,
        guard: Guard,
        tree: LensTree,
    }

    fn fixture() -> Fx {
        let t = TempDir::new();
        let home = t.0.join("home");
        write(&home.join("Documents/big.mov"), 300_000);
        write(&home.join("Documents/note1.txt"), 1000);
        write(&home.join("Documents/note2.txt"), 1000);
        write(&home.join("Projects/app/data.bin"), 300_000);
        write(&home.join("Library/Caches/x.bin"), 300_000);
        write(&home.join("Library/Keychains/k.bin"), 300_000);
        write(&home.join("Applications/Foo.app/Contents/x"), 300_000);
        let tree = lens::build_with(&home, &Progress::silent(), SMALL);
        Fx { guard: Guard::new(&home), tree, home, _t: t }
    }

    fn find(f: &Fx, parent: u32, name: &str) -> NodeDto {
        let n = f.tree.children(parent).into_iter().find(|n| n.name == name).unwrap_or_else(|| panic!("no {name}"));
        describe(&f.tree, &f.guard, n)
    }

    #[test]
    fn selectable_flags_follow_the_guard() {
        let f = fixture();
        let root = describe(&f.tree, &f.guard, f.tree.node(0).unwrap());
        assert!(!root.selectable, "the home itself is protected");
        assert!(root.drillable);

        let docs = find(&f, 0, "Documents");
        assert!(!docs.selectable, "~/Documents is a protected location");
        assert!(docs.drillable);
        let lib = find(&f, 0, "Library");
        assert!(!lib.selectable);
        assert!(!find(&f, lib.id, "Keychains").selectable, "forbidden subtree");
        assert!(!find(&f, lib.id, "Caches").selectable, "protected location");

        let big = find(&f, docs.id, "big.mov");
        assert!(big.selectable && !big.drillable && big.kind == Kind::File);
        let small = f.tree.children(docs.id).into_iter().find(|n| n.kind == Kind::Small).unwrap();
        let small = describe(&f.tree, &f.guard, small);
        assert!(!small.selectable && !small.drillable);
        assert_eq!(small.name, "2 arquivos pequenos");

        assert!(find(&f, 0, "Projects").selectable);
        let app = find(&f, find(&f, 0, "Applications").id, "Foo.app");
        assert!(app.selectable && app.kind == Kind::Package && !app.drillable);
    }

    #[test]
    fn review_keeps_selectable_nodes_prunes_nested_and_records_identity() {
        let f = fixture();
        let docs = find(&f, 0, "Documents");
        let big = find(&f, docs.id, "big.mov");
        let small = f.tree.children(docs.id).into_iter().find(|n| n.kind == Kind::Small).unwrap();
        let projects = find(&f, 0, "Projects");
        let app_dir = find(&f, projects.id, "app");
        let data = find(&f, app_dir.id, "data.bin");
        let ids = [big.id, small.id, docs.id, 0, data.id, projects.id, app_dir.id, big.id, 99_999];
        let items = review_items(&f.tree, &f.guard, &ids);
        // Documents and the home are rejected by the guard, the small node has no path, data.bin is inside
        // Projects, and duplicates/unknown ids vanish.
        let paths: Vec<_> = items.iter().map(|i| i.path.clone()).collect();
        assert_eq!(paths, [f.home.join("Documents/big.mov"), f.home.join("Projects")]);
        assert!(items.iter().all(|i| i.selected && i.policy == Policy::MoveToTrash));
        let md = fs::metadata(&paths[0]).unwrap();
        use std::os::unix::fs::MetadataExt;
        assert_eq!(items[0].ident, Some((md.dev(), md.ino())));
        assert_eq!(items[0].size, big.size);
        assert!(review_items(&f.tree, &f.guard, &[0, small.id, docs.id]).is_empty());
    }

    #[test]
    fn scan_state_and_registry_wiring() {
        let f = fixture();
        let st = AppState::with_home(f.home.clone());
        let items = review_items(&f.tree, &st.guard, &[find(&f, 0, "Projects").id]);
        let group = Group { id: "lens".into(), title: "t".into(), description: String::new(), items };
        let dto = lock(&st.registry).replace(TASK_LENS, vec![group]);
        let ids: Vec<u64> = dto[0].items.iter().map(|i| i.id).collect();
        let resolved = lock(&st.registry).resolve_removal(&ids);
        assert_eq!(resolved.items.len(), 1);
        // The cloud eviction refuses lens ids, and `remove` refuses cloud ids.
        assert_eq!(lock(&st.registry).resolve_task(TASK_ICLOUD, &ids).items.len(), 0);
        assert!(current_tree(&st).is_err());
    }

    #[test]
    fn node_paths_resolve_from_the_tree_only() {
        let f = fixture();
        let docs = find(&f, 0, "Documents");
        let big = find(&f, docs.id, "big.mov");
        assert_eq!(node_path(&f.tree, big.id, false).unwrap(), f.home.join("Documents/big.mov"));
        assert_eq!(node_path(&f.tree, 99_999, true).unwrap_err(), ERR_NO_NODE);
        // Synthetic small-files node: Finder reveals the folder that holds them; Quick Look has nothing to show.
        let small = f.tree.children(docs.id).into_iter().find(|n| n.kind == Kind::Small).unwrap();
        assert_eq!(node_path(&f.tree, small.id, true).unwrap(), f.home.join("Documents"));
        assert_eq!(node_path(&f.tree, small.id, false).unwrap_err(), ERR_NO_PREVIEW);
        // A file removed after the scan is reported instead of being handed to `open`.
        fs::remove_file(f.home.join("Documents/big.mov")).unwrap();
        assert_eq!(node_path(&f.tree, big.id, false).unwrap_err(), ERR_GONE);
    }

    #[test]
    fn only_app_bundles_get_a_real_icon() {
        assert!(is_app_bundle(std::path::Path::new("/Applications/Foo.app")));
        assert!(is_app_bundle(std::path::Path::new("/Applications/Foo.APP")));
        assert!(!is_app_bundle(std::path::Path::new("/Users/x/Fotos.photoslibrary")));
        assert!(!is_app_bundle(std::path::Path::new("/Users/x/app")));
        assert!(app_icon_url(std::path::Path::new("/nonexistent/Nope.app")).is_none());
        // The miss is cached too: asking again must agree.
        assert!(app_icon_url(std::path::Path::new("/nonexistent/Nope.app")).is_none());
    }
}
