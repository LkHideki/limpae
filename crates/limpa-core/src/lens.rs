//! Disk Map: a size tree of a folder or volume for the bubble map.
//!
//! Sizes follow [`crate::size::alloc_size`]: allocated bytes, symlinks not followed, other devices not entered,
//! hard links counted once, unreadable entries count as 0. To keep memory bounded on large homes, every
//! directory gets a node, files below [`SMALL_FILE_BYTES`] are folded into one synthetic "small files" node per
//! directory, and packages (`.app`, `.photoslibrary`, ...) are leaves sized as a whole.
//!
//! The tree is stored as a flat arena in breadth-first order: the children of a node are contiguous and already
//! sorted by size (descending), so [`LensTree::children`] is a slice lookup. Paths are never stored, only names;
//! a path is rebuilt by walking up the parents.

use std::collections::{HashSet, VecDeque};
use std::ffi::{OsStr, OsString};
use std::fs::{self, DirEntry, Metadata};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use rayon::prelude::*;
use serde::Serialize;

use crate::disk::disk_info;
use crate::model::Progress;
use crate::size::own_bytes;

/// Files whose allocated size is below this are folded into the directory's "small files" node (1 MB, decimal).
pub const SMALL_FILE_BYTES: u64 = 1_000_000;

/// Directories that are a single document or library to the user; leaves in the tree.
const PACKAGE_EXTS: &[&str] = &[
    "app",
    "photoslibrary",
    "photolibrary",
    "musiclibrary",
    "tvlibrary",
    "imovielibrary",
    "fcpbundle",
    "logicx",
    "band",
    "bundle",
    "framework",
    "plugin",
    "kext",
    "xcodeproj",
    "xcworkspace",
    "xcarchive",
    "pkg",
    "mpkg",
    "rtfd",
    "pages",
    "numbers",
    "key",
    "lrlibrary",
    "lrdata",
    "aplibrary",
    "sparsebundle",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    /// A directory whose children are in the tree.
    Dir,
    /// A file of at least the folding threshold.
    File,
    /// A package folder, sized as a whole and never opened.
    Package,
    /// Synthetic node: every file below the threshold in one directory.
    Small,
}

const NO_PARENT: u32 = u32::MAX;

struct Data {
    name: Box<OsStr>,
    parent: u32,
    first_child: u32,
    n_children: u32,
    /// Files inside (the file count for a "Small" node).
    items: u32,
    size: u64,
    ino: u64,
    kind: Kind,
}

/// Read-only view of one tree node. `path` is for display; use [`LensTree::path_of`] to act on a node.
#[derive(Debug, Clone, Serialize)]
pub struct Node {
    pub id: u32,
    pub parent: Option<u32>,
    pub name: String,
    pub path: String,
    pub size: u64,
    pub is_dir: bool,
    pub kind: Kind,
    pub items: u32,
}

pub struct LensTree {
    nodes: Vec<Data>,
    root_path: PathBuf,
    dev: u64,
}

impl LensTree {
    pub const ROOT: u32 = 0;

    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }

    pub fn root_path(&self) -> &Path {
        &self.root_path
    }

    /// Bytes held by the tree: the arena plus the name buffers.
    pub fn heap_bytes(&self) -> usize {
        self.nodes.capacity() * size_of::<Data>() + self.nodes.iter().map(|n| n.name.len()).sum::<usize>()
    }

    fn display_name(&self, d: &Data, id: u32) -> String {
        match d.kind {
            Kind::Small if d.items == 1 => "1 arquivo pequeno".to_string(),
            Kind::Small => format!("{} arquivos pequenos", group_digits(d.items)),
            _ if id == Self::ROOT => self
                .root_path
                .file_name()
                .map_or_else(|| self.root_path.to_string_lossy().into_owned(), |n| n.to_string_lossy().into_owned()),
            _ => d.name.to_string_lossy().into_owned(),
        }
    }

    pub fn node(&self, id: u32) -> Option<Node> {
        let d = self.nodes.get(id as usize)?;
        let path = match d.kind {
            Kind::Small => self.path_of(d.parent)?,
            _ => self.path_of(id)?,
        };
        Some(Node {
            id,
            parent: (d.parent != NO_PARENT).then_some(d.parent),
            name: self.display_name(d, id),
            path: path.to_string_lossy().into_owned(),
            size: d.size,
            is_dir: matches!(d.kind, Kind::Dir | Kind::Package),
            kind: d.kind,
            items: d.items,
        })
    }

    /// Direct children, largest first (the synthetic small-files node competes by size like any other).
    pub fn children(&self, id: u32) -> Vec<Node> {
        let Some(d) = self.nodes.get(id as usize) else { return Vec::new() };
        (d.first_child..d.first_child + d.n_children).filter_map(|c| self.node(c)).collect()
    }

    pub fn child_count(&self, id: u32) -> usize {
        self.nodes.get(id as usize).map_or(0, |d| d.n_children as usize)
    }

    pub fn kind(&self, id: u32) -> Option<Kind> {
        self.nodes.get(id as usize).map(|d| d.kind)
    }

    pub fn size(&self, id: u32) -> Option<u64> {
        self.nodes.get(id as usize).map(|d| d.size)
    }

    /// Filesystem path of a real node (not the synthetic small-files node, which has none).
    pub fn path_of(&self, id: u32) -> Option<PathBuf> {
        let mut names: Vec<&OsStr> = Vec::new();
        let mut cur = id;
        loop {
            let d = self.nodes.get(cur as usize)?;
            if d.kind == Kind::Small {
                return None;
            }
            if d.parent == NO_PARENT {
                break;
            }
            names.push(&d.name);
            cur = d.parent;
        }
        let mut p = self.root_path.clone();
        p.extend(names.into_iter().rev());
        Some(p)
    }

    /// (device, inode) recorded by the scan; removal uses it to refuse a path that now names another file.
    pub fn ident(&self, id: u32) -> Option<(u64, u64)> {
        let d = self.nodes.get(id as usize)?;
        (d.kind != Kind::Small).then_some((self.dev, d.ino))
    }

    /// Root-first chain of node ids ending at `id` (inclusive).
    pub fn ancestors(&self, id: u32) -> Vec<u32> {
        let mut chain = Vec::new();
        let mut cur = id;
        while let Some(d) = self.nodes.get(cur as usize) {
            chain.push(cur);
            if d.parent == NO_PARENT {
                break;
            }
            cur = d.parent;
        }
        chain.reverse();
        chain
    }

    /// Drops duplicates, unknown ids, and every node whose ancestor is also in the set, so a folder and its
    /// contents are never removed twice. Input order is kept.
    pub fn prune_nested(&self, ids: &[u32]) -> Vec<u32> {
        let set: HashSet<u32> = ids.iter().copied().filter(|&i| (i as usize) < self.nodes.len()).collect();
        let mut seen = HashSet::new();
        ids.iter()
            .copied()
            .filter(|i| set.contains(i) && seen.insert(*i))
            .filter(|&i| {
                let mut cur = self.nodes[i as usize].parent;
                while cur != NO_PARENT {
                    if set.contains(&cur) {
                        return false;
                    }
                    cur = self.nodes[cur as usize].parent;
                }
                true
            })
            .collect()
    }
}

fn group_digits(n: u32) -> String {
    let s = n.to_string();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i).is_multiple_of(3) {
            out.push('.');
        }
        out.push(c);
    }
    out
}

/// A scannable starting point: the home folder or a mounted external volume.
#[derive(Debug, Clone, Serialize)]
pub struct Root {
    pub name: String,
    pub path: PathBuf,
    pub is_volume: bool,
    pub total: u64,
    pub used: u64,
}

/// Home plus every mounted volume under `/Volumes` except the boot disk's alias (it canonicalizes to "/").
pub fn roots(home: &Path) -> Vec<Root> {
    roots_in(home, Path::new("/Volumes"))
}

pub fn roots_in(home: &Path, volumes: &Path) -> Vec<Root> {
    let mut out = Vec::new();
    let capacity = |p: &Path| disk_info(p).map_or((0, 0), |d| (d.total, d.used));
    let (total, used) = capacity(home);
    let home_name = home.file_name().map_or_else(|| "Início".to_string(), |n| n.to_string_lossy().into_owned());
    out.push(Root { name: home_name, path: home.to_path_buf(), is_volume: false, total, used });

    let Ok(rd) = fs::read_dir(volumes) else { return out };
    let mut vols: Vec<_> = rd.filter_map(Result::ok).collect();
    vols.sort_by_key(DirEntry::file_name);
    for e in vols {
        let Ok(real) = fs::canonicalize(e.path()) else { continue };
        if real == Path::new("/") || !fs::metadata(&real).is_ok_and(|m| m.is_dir()) {
            continue;
        }
        let (total, used) = capacity(&real);
        out.push(Root { name: e.file_name().to_string_lossy().into_owned(), path: real, is_volume: true, total, used });
    }
    out
}

struct Built {
    name: OsString,
    size: u64,
    ino: u64,
    kind: Kind,
    items: u32,
    children: Vec<Built>,
}

enum Part {
    Skip,
    Small(u64),
    Node(Built),
}

struct Ctx<'a> {
    dev: u64,
    small_below: u64,
    /// (device, inode) of multiply-linked files already counted.
    seen: Mutex<HashSet<(u64, u64)>>,
    found: AtomicU64,
    p: &'a Progress,
}

impl Ctx<'_> {
    /// True the first time a multiply-linked file is met (always true for single links).
    fn first_link(&self, md: &Metadata) -> bool {
        md.nlink() <= 1 || self.seen.lock().unwrap_or_else(|e| e.into_inner()).insert((md.dev(), md.ino()))
    }
}

/// Builds the size tree under `root`; check `p.cancelled()` afterwards: a cancelled build is partial.
pub fn build(root: &Path, p: &Progress) -> LensTree {
    build_with(root, p, SMALL_FILE_BYTES)
}

pub fn build_with(root: &Path, p: &Progress, small_below: u64) -> LensTree {
    let md = fs::symlink_metadata(root).ok().filter(Metadata::is_dir);
    let dev = md.as_ref().map_or(0, MetadataExt::dev);
    let built = md.map(|md| {
        let ctx = Ctx { dev, small_below, seen: Mutex::new(HashSet::new()), found: AtomicU64::new(0), p };
        walk_dir(root, &md, &ctx)
    });
    let nodes = built.map_or_else(Vec::new, |b| flatten(b, root));
    LensTree { nodes, root_path: root.to_path_buf(), dev }
}

fn walk_dir(path: &Path, md: &Metadata, ctx: &Ctx) -> Built {
    let mut b = Built {
        name: OsString::new(),
        size: own_bytes(md),
        ino: md.ino(),
        kind: Kind::Dir,
        items: 0,
        children: Vec::new(),
    };
    if ctx.p.cancelled() {
        return b;
    }
    ctx.p.report(path, ctx.found.load(Ordering::Relaxed));
    let Ok(rd) = fs::read_dir(path) else { return b };
    let entries: Vec<DirEntry> = rd.filter_map(Result::ok).collect();
    let parts: Vec<Part> = entries.par_iter().map(|e| classify(e, ctx)).collect();
    let (mut small_n, mut small_bytes) = (0u32, 0u64);
    for part in parts {
        match part {
            Part::Skip => {}
            Part::Small(bytes) => {
                small_n += 1;
                small_bytes += bytes;
            }
            Part::Node(n) => {
                b.size += n.size;
                b.items += n.items;
                b.children.push(n);
            }
        }
    }
    if small_n > 0 {
        b.size += small_bytes;
        b.items += small_n;
        b.children.push(Built {
            name: OsString::new(),
            size: small_bytes,
            ino: 0,
            kind: Kind::Small,
            items: small_n,
            children: Vec::new(),
        });
    }
    b
}

fn classify(e: &DirEntry, ctx: &Ctx) -> Part {
    // DirEntry::metadata does not traverse symlinks on unix.
    let Ok(md) = e.metadata() else { return Part::Skip };
    if md.dev() != ctx.dev {
        return Part::Skip;
    }
    let path = e.path();
    if md.is_dir() {
        if is_package(&path) {
            let (size, items) = measure(&path, &md, ctx);
            return Part::Node(Built {
                name: e.file_name(),
                size,
                ino: md.ino(),
                kind: Kind::Package,
                items,
                children: Vec::new(),
            });
        }
        let mut b = walk_dir(&path, &md, ctx);
        b.name = e.file_name();
        return Part::Node(b);
    }
    if !ctx.first_link(&md) {
        return Part::Skip;
    }
    let bytes = own_bytes(&md);
    ctx.found.fetch_add(bytes, Ordering::Relaxed);
    if md.is_file() && bytes >= ctx.small_below {
        return Part::Node(Built {
            name: e.file_name(),
            size: bytes,
            ino: md.ino(),
            kind: Kind::File,
            items: 1,
            children: Vec::new(),
        });
    }
    Part::Small(bytes)
}

/// Total allocated bytes and file count under a package, sharing the hard-link set with the main walk.
fn measure(path: &Path, md: &Metadata, ctx: &Ctx) -> (u64, u32) {
    if ctx.p.cancelled() {
        return (0, 0);
    }
    let own = own_bytes(md);
    let Ok(rd) = fs::read_dir(path) else { return (own, 0) };
    let entries: Vec<DirEntry> = rd.filter_map(Result::ok).collect();
    let (bytes, items) = entries
        .par_iter()
        .map(|e| {
            let Ok(m) = e.metadata() else { return (0, 0) };
            if m.dev() != ctx.dev {
                return (0, 0);
            }
            if m.is_dir() {
                return measure(&e.path(), &m, ctx);
            }
            if !ctx.first_link(&m) {
                return (0, 0);
            }
            (own_bytes(&m), 1)
        })
        .reduce(|| (0, 0), |a, b| (a.0 + b.0, a.1 + b.1));
    ctx.found.fetch_add(bytes, Ordering::Relaxed);
    (own + bytes, items)
}

fn is_package(path: &Path) -> bool {
    path.extension().is_some_and(|e| {
        let e = e.to_string_lossy().to_lowercase();
        PACKAGE_EXTS.contains(&e.as_str())
    })
}

/// Breadth-first flatten: children of a node get consecutive ids, largest first.
fn flatten(root: Built, root_path: &Path) -> Vec<Data> {
    let mut nodes = vec![Data {
        name: root_path.file_name().unwrap_or(OsStr::new("/")).into(),
        parent: NO_PARENT,
        first_child: 0,
        n_children: 0,
        items: root.items,
        size: root.size,
        ino: root.ino,
        kind: Kind::Dir,
    }];
    let mut queue: VecDeque<(u32, Vec<Built>)> = VecDeque::new();
    queue.push_back((0, root.children));
    while let Some((parent, mut kids)) = queue.pop_front() {
        kids.sort_by(|a, b| b.size.cmp(&a.size).then_with(|| a.name.as_bytes().cmp(b.name.as_bytes())));
        let first = nodes.len() as u32;
        nodes[parent as usize].first_child = first;
        nodes[parent as usize].n_children = kids.len() as u32;
        for (i, k) in kids.into_iter().enumerate() {
            nodes.push(Data {
                name: k.name.into_boxed_os_str(),
                parent,
                first_child: 0,
                n_children: 0,
                items: k.items,
                size: k.size,
                ino: k.ino,
                kind: k.kind,
            });
            if !k.children.is_empty() {
                queue.push_back((first + i as u32, k.children));
            }
        }
    }
    nodes.shrink_to_fit();
    nodes
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::size::alloc_size;
    use std::io::Write;
    use std::sync::Arc;
    use std::sync::atomic::AtomicBool;

    const KB64: usize = 64 * 1024;
    const SMALL: u64 = 100_000;

    fn write(path: &Path, bytes: usize) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut f = fs::File::create(path).unwrap();
        f.write_all(&vec![7u8; bytes]).unwrap();
        f.sync_all().unwrap();
    }

    fn tmp() -> (tempfile::TempDir, PathBuf) {
        let t = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(t.path()).unwrap().join("root");
        fs::create_dir_all(&root).unwrap();
        (t, root)
    }

    fn tree(root: &Path) -> LensTree {
        build_with(root, &Progress::silent(), SMALL)
    }

    fn find(t: &LensTree, parent: u32, name: &str) -> Node {
        t.children(parent).into_iter().find(|n| n.name == name).unwrap_or_else(|| panic!("no {name}"))
    }

    #[test]
    fn sizes_match_alloc_size_for_every_directory() {
        let (_t, root) = tmp();
        write(&root.join("a/big1.bin"), 4 * KB64);
        write(&root.join("a/tiny.txt"), 1000);
        write(&root.join("a/b/big2.bin"), 6 * KB64);
        write(&root.join("a/b/c/x.txt"), 10);
        write(&root.join("z/y.bin"), 3 * KB64);
        fs::create_dir_all(root.join("empty")).unwrap();
        let t = tree(&root);
        let no_cancel = AtomicBool::new(false);
        assert_eq!(t.size(0), Some(alloc_size(&root, &no_cancel)));
        let mut dirs = 0;
        for id in 0..t.len() as u32 {
            if t.kind(id) == Some(Kind::Dir) {
                let path = t.path_of(id).unwrap();
                assert_eq!(t.size(id), Some(alloc_size(&path, &no_cancel)), "{path:?}");
                dirs += 1;
            }
        }
        assert_eq!(dirs, 6, "root, a, a/b, a/b/c, z, empty");
        assert_eq!(t.node(0).unwrap().items, 5);
    }

    #[test]
    fn small_files_fold_into_one_node_per_directory() {
        let (_t, root) = tmp();
        write(&root.join("d/big.bin"), 4 * KB64);
        for i in 0..5 {
            write(&root.join(format!("d/s{i}.txt")), 2000);
        }
        write(&root.join("only-small/one.txt"), 2000);
        let t = tree(&root);
        let d = find(&t, 0, "d");
        let kids = t.children(d.id);
        assert_eq!(kids.len(), 2, "{kids:?}");
        let small = kids.iter().find(|n| n.kind == Kind::Small).unwrap();
        assert_eq!(small.name, "5 arquivos pequenos");
        assert_eq!(small.items, 5);
        assert!(!small.is_dir);
        assert_eq!(small.parent, Some(d.id));
        assert_eq!(small.path, d.path, "synthetic node shows its folder");
        assert!(t.path_of(small.id).is_none() && t.ident(small.id).is_none());
        let big = kids.iter().find(|n| n.kind == Kind::File).unwrap();
        assert_eq!(big.name, "big.bin");
        assert_eq!(d.size, big.size + small.size + own_bytes(&fs::metadata(root.join("d")).unwrap()));
        let one = t.children(find(&t, 0, "only-small").id);
        assert_eq!(one.len(), 1);
        assert_eq!(one[0].name, "1 arquivo pequeno");
        // Folding keeps the tree small: 1 root + d + only-small + big + two synthetic nodes.
        assert_eq!(t.len(), 6);
    }

    #[test]
    fn children_are_sorted_by_size_descending() {
        let (_t, root) = tmp();
        write(&root.join("a.bin"), 2 * KB64);
        write(&root.join("b.bin"), 5 * KB64);
        write(&root.join("c/c.bin"), 3 * KB64);
        let t = tree(&root);
        let sizes: Vec<u64> = t.children(0).iter().map(|n| n.size).collect();
        assert!(sizes.windows(2).all(|w| w[0] >= w[1]), "{sizes:?}");
        assert_eq!(t.children(0)[0].name, "b.bin");
    }

    #[test]
    fn packages_are_leaves_sized_as_a_whole() {
        let (_t, root) = tmp();
        write(&root.join("Foo.APP/Contents/MacOS/foo"), 8 * KB64);
        write(&root.join("Foo.APP/Contents/Resources/r.dat"), 2 * KB64);
        write(&root.join("Lib.photoslibrary/original.jpg"), 4 * KB64);
        let t = tree(&root);
        let app = find(&t, 0, "Foo.APP");
        assert_eq!(app.kind, Kind::Package);
        assert!(app.is_dir && t.children(app.id).is_empty());
        assert_eq!(app.size, alloc_size(&root.join("Foo.APP"), &AtomicBool::new(false)));
        assert_eq!(app.items, 2);
        assert_eq!(find(&t, 0, "Lib.photoslibrary").kind, Kind::Package);
        assert_eq!(t.size(0), Some(alloc_size(&root, &AtomicBool::new(false))));
        // Node count: root + two packages.
        assert_eq!(t.len(), 3);
    }

    #[test]
    fn symlinks_are_not_followed_and_hard_links_count_once() {
        let outside = tempfile::tempdir().unwrap();
        write(&outside.path().join("big"), 20 * KB64);
        let (_t, root) = tmp();
        std::os::unix::fs::symlink(outside.path(), root.join("linkdir")).unwrap();
        std::os::unix::fs::symlink(outside.path().join("big"), root.join("linkfile")).unwrap();
        write(&root.join("a.bin"), 8 * KB64);
        fs::hard_link(root.join("a.bin"), root.join("b.bin")).unwrap();
        let t = tree(&root);
        let names: Vec<String> = t.children(0).iter().map(|n| n.name.clone()).collect();
        assert!(!names.iter().any(|n| n == "linkdir" || n == "linkfile"), "{names:?}");
        let big: Vec<_> = t.children(0).into_iter().filter(|n| n.kind == Kind::File).collect();
        assert_eq!(big.len(), 1, "hard link counted twice: {big:?}");
        assert!(t.size(0).unwrap() < 12 * KB64 as u64);
        assert_eq!(t.size(0), Some(alloc_size(&root, &AtomicBool::new(false))));
    }

    #[test]
    fn path_ident_ancestors_and_prune() {
        let (_t, root) = tmp();
        write(&root.join("a/b/f.bin"), 4 * KB64);
        write(&root.join("a/g.bin"), 4 * KB64);
        write(&root.join("h.bin"), 4 * KB64);
        let t = tree(&root);
        let a = find(&t, 0, "a");
        let b = find(&t, a.id, "b");
        let f = find(&t, b.id, "f.bin");
        let g = find(&t, a.id, "g.bin");
        let h = find(&t, 0, "h.bin");
        assert_eq!(t.path_of(f.id), Some(root.join("a/b/f.bin")));
        assert_eq!(f.path, root.join("a/b/f.bin").to_string_lossy());
        assert_eq!(t.path_of(0), Some(root.clone()));
        let md = fs::metadata(root.join("a/b/f.bin")).unwrap();
        assert_eq!(t.ident(f.id), Some((md.dev(), md.ino())));
        assert_eq!(t.ancestors(f.id), vec![0, a.id, b.id, f.id]);
        assert_eq!(t.prune_nested(&[f.id, a.id, h.id, a.id, g.id, 9999]), vec![a.id, h.id]);
        assert_eq!(t.prune_nested(&[f.id, g.id]), vec![f.id, g.id]);
        assert!(t.node(9999).is_none() && t.children(9999).is_empty());
    }

    #[test]
    fn cancelled_build_stops_and_progress_is_reported() {
        let (_t, root) = tmp();
        write(&root.join("a/b/x.bin"), 4 * KB64);
        let calls = Arc::new(AtomicU64::new(0));
        let c = calls.clone();
        let p = Progress::new(Arc::new(AtomicBool::new(false)), move |_, _| {
            c.fetch_add(1, Ordering::Relaxed);
        });
        let t = build_with(&root, &p, SMALL);
        assert_eq!(calls.load(Ordering::Relaxed), 3, "root, a, a/b");
        assert_eq!(t.len(), 4);

        let cancelled = Progress::new(Arc::new(AtomicBool::new(true)), |_, _| {});
        let t = build_with(&root, &cancelled, SMALL);
        assert_eq!(t.len(), 1);
    }

    #[test]
    fn missing_or_file_root_gives_empty_tree() {
        let (_t, root) = tmp();
        assert!(tree(&root.join("nope")).is_empty());
        write(&root.join("f"), 10);
        assert!(tree(&root.join("f")).is_empty());
    }

    #[test]
    fn roots_list_home_and_skip_boot_alias() {
        let (_t, home) = tmp();
        let volumes = home.parent().unwrap().join("Volumes");
        fs::create_dir_all(volumes.join("Externo")).unwrap();
        std::os::unix::fs::symlink("/", volumes.join("Macintosh HD")).unwrap();
        fs::write(volumes.join("arquivo"), b"x").unwrap();
        let roots = roots_in(&home, &volumes);
        let names: Vec<_> = roots.iter().map(|r| (r.name.as_str(), r.is_volume)).collect();
        assert_eq!(names, [("root", false), ("Externo", true)]);
        assert_eq!(roots[1].path, volumes.join("Externo"));
        assert!(roots[0].total > 0 && roots[0].used <= roots[0].total);
        assert_eq!(roots_in(&home, &home.join("missing")).len(), 1);
    }

    #[test]
    fn digit_grouping_matches_pt_br() {
        assert_eq!(group_digits(7), "7");
        assert_eq!(group_digits(1234), "1.234");
        assert_eq!(group_digits(1_234_567), "1.234.567");
    }

    /// Manual benchmark on the real home: `cargo test -p limpa-core --release real_home -- --ignored --nocapture`.
    #[test]
    #[ignore = "scans the real home folder"]
    fn real_home_build_time_and_memory() {
        let home = std::env::home_dir().unwrap();
        let rss = || {
            // SAFETY: getrusage only writes into the struct we pass.
            let mut u: libc::rusage = unsafe { std::mem::zeroed() };
            unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut u) };
            u.ru_maxrss as f64 / 1e6
        };
        let start = std::time::Instant::now();
        let t = build(&home, &Progress::silent());
        let secs = start.elapsed().as_secs_f64();
        println!(
            "lens: {secs:.1}s nodes={} files={} size={:.1}GB tree={:.1}MB peak_rss={:.1}MB",
            t.len(),
            t.node(0).unwrap().items,
            t.size(0).unwrap() as f64 / 1e9,
            t.heap_bytes() as f64 / 1e6,
            rss()
        );
    }
}
