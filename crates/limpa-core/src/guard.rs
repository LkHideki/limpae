use std::fmt;
use std::fs;
use std::path::{Component, Path, PathBuf};

use crate::model::Policy;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GuardError {
    NotAbsolute,
    Traversal,
    Missing,
    /// The path is, or contains, a location that must never be removed.
    Protected,
    /// The path lies inside a subtree that must never be touched.
    Forbidden,
    OutsideRoot,
    InvalidRoot,
    /// The path now names a different file than the one the scan found.
    Changed,
}

impl fmt::Display for GuardError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::NotAbsolute => "caminho não é absoluto",
            Self::Traversal => "caminho contém '..' ou '.'",
            Self::Missing => "item não existe mais",
            Self::Protected => "local protegido",
            Self::Forbidden => "dentro de área proibida",
            Self::OutsideRoot => "fora da área permitida",
            Self::InvalidRoot => "raiz de limpeza inválida",
            Self::Changed => "o item mudou desde a análise; analise de novo",
        })
    }
}

impl std::error::Error for GuardError {}

const SYSTEM_PROTECTED: &[&str] = &[
    "/",
    "/System",
    "/Library",
    "/Applications",
    "/Users",
    "/usr",
    "/bin",
    "/sbin",
    "/private",
    "/etc",
    "/var",
    "/opt",
    "/Volumes",
    "/cores",
    "/dev",
];

const HOME_PROTECTED: &[&str] = &[
    "Library",
    "Library/Caches",
    "Library/Logs",
    "Library/Application Support",
    "Library/Preferences",
    "Library/Containers",
    "Library/Group Containers",
    "Library/Developer",
    "Library/Developer/Xcode",
    "Library/Developer/Xcode/DerivedData",
    "Library/Developer/Xcode/iOS DeviceSupport",
    "Library/Developer/CoreSimulator",
    "Library/LaunchAgents",
    "Library/Saved Application State",
    "Library/HTTPStorages",
    "Library/WebKit",
    "Library/Application Scripts",
    "Desktop",
    "Documents",
    "Downloads",
    "Pictures",
    "Movies",
    "Music",
    "Public",
    "Applications",
    ".Trash",
    ".npm",
    ".cargo",
    ".gradle",
];

/// Subtrees where nothing may be removed, whatever the policy.
const HOME_FORBIDDEN: &[&str] = &[
    "Library/Keychains",
    "Library/Mobile Documents",
    "Library/CloudStorage",
    "Library/Mail",
    "Library/Messages",
    "Library/Photos",
    ".ssh",
    ".gnupg",
];

const APP_ROOTS: &[&str] = &["/Applications"];

/// Last line of defence before anything is removed. Every removal goes
/// through [`Guard::check`] at removal time, not at scan time, so state that
/// changed in between (e.g. a directory swapped for a symlink) is caught.
#[derive(Debug, Clone)]
pub struct Guard {
    home: PathBuf,
    protected: Vec<PathBuf>,
    forbidden: Vec<PathBuf>,
    app_roots: Vec<PathBuf>,
    trash: PathBuf,
}

fn canon(p: &Path) -> PathBuf {
    fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

impl Guard {
    pub fn new(home: &Path) -> Self {
        let home = canon(home);
        let mut protected: Vec<PathBuf> = SYSTEM_PROTECTED.iter().map(|p| canon(Path::new(p))).collect();
        protected.push(home.clone());
        protected.extend(HOME_PROTECTED.iter().map(|p| canon(&home.join(p))));
        let forbidden = HOME_FORBIDDEN.iter().map(|p| canon(&home.join(p))).collect();
        let mut app_roots: Vec<PathBuf> = APP_ROOTS.iter().map(|p| canon(Path::new(p))).collect();
        app_roots.push(canon(&home.join("Applications")));
        let trash = canon(&home.join(".Trash"));
        Self { home, protected, forbidden, app_roots, trash }
    }

    pub fn home(&self) -> &Path {
        &self.home
    }

    /// Validates `path` for removal under `policy` and returns its resolved
    /// location. Only the parent is canonicalized: a symlink item resolves to
    /// the link itself, so removing it never touches the link target.
    pub fn check(&self, path: &Path, policy: &Policy) -> Result<PathBuf, GuardError> {
        if !path.is_absolute() {
            return Err(GuardError::NotAbsolute);
        }
        if path.components().any(|c| matches!(c, Component::ParentDir | Component::CurDir)) {
            return Err(GuardError::Traversal);
        }
        fs::symlink_metadata(path).map_err(|_| GuardError::Missing)?;
        let (Some(parent), Some(name)) = (path.parent(), path.file_name()) else {
            return Err(GuardError::Protected);
        };
        let real = fs::canonicalize(parent).map_err(|_| GuardError::Missing)?.join(name);

        if self.protected.iter().any(|p| p.starts_with(&real)) {
            return Err(GuardError::Protected);
        }
        if self.forbidden.iter().any(|f| real.starts_with(f)) {
            return Err(GuardError::Forbidden);
        }

        let allowed = match policy {
            Policy::DeleteJunk { root } => {
                let root = fs::canonicalize(root).map_err(|_| GuardError::InvalidRoot)?;
                if !root.starts_with(&self.home) || root == self.home {
                    return Err(GuardError::InvalidRoot);
                }
                real.starts_with(&root) && real != root
            }
            Policy::MoveToTrash => self.in_home(&real) || self.is_installed_app(&real),
            Policy::EmptyTrashEntry => real.parent() == Some(self.trash.as_path()),
        };
        if allowed { Ok(real) } else { Err(GuardError::OutsideRoot) }
    }

    fn in_home(&self, real: &Path) -> bool {
        real.starts_with(&self.home) && real != self.home
    }

    /// A top-level `.app` bundle under an applications root (one folder level
    /// allowed, e.g. /Applications/Utilities/X.app), never a nested bundle.
    fn is_installed_app(&self, real: &Path) -> bool {
        if real.extension().is_none_or(|e| e != "app") {
            return false;
        }
        self.app_roots.iter().any(|root| {
            let Ok(rel) = real.strip_prefix(root) else { return false };
            let parts: Vec<_> = rel.components().collect();
            let nested = parts[..parts.len().saturating_sub(1)]
                .iter()
                .any(|c| Path::new(c.as_os_str()).extension().is_some_and(|e| e == "app"));
            (1..=2).contains(&parts.len()) && !nested
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    struct Fixture {
        _tmp: tempfile::TempDir,
        home: PathBuf,
        guard: Guard,
    }

    fn fixture() -> Fixture {
        let tmp = tempfile::tempdir().unwrap();
        let home = fs::canonicalize(tmp.path()).unwrap().join("home");
        for d in ["Library/Caches/com.foo", "Library/Logs", "Documents", ".Trash", ".ssh", "Library/Keychains"] {
            fs::create_dir_all(home.join(d)).unwrap();
        }
        fs::write(home.join("Library/Caches/com.foo/x"), b"x").unwrap();
        fs::write(home.join("Documents/big.mov"), b"x").unwrap();
        fs::write(home.join(".Trash/old.txt"), b"x").unwrap();
        fs::write(home.join(".ssh/id_ed25519"), b"x").unwrap();
        let guard = Guard::new(&home);
        Fixture { _tmp: tmp, home, guard }
    }

    fn junk(f: &Fixture) -> Policy {
        Policy::DeleteJunk { root: f.home.join("Library/Caches") }
    }

    #[test]
    fn allows_item_inside_junk_root() {
        let f = fixture();
        let p = f.home.join("Library/Caches/com.foo");
        assert_eq!(f.guard.check(&p, &junk(&f)), Ok(p));
    }

    #[test]
    fn rejects_junk_root_itself_and_ancestors() {
        let f = fixture();
        assert_eq!(f.guard.check(&f.home.join("Library/Caches"), &junk(&f)), Err(GuardError::Protected));
        assert_eq!(f.guard.check(&f.home.join("Library"), &junk(&f)), Err(GuardError::Protected));
        assert_eq!(f.guard.check(&f.home, &Policy::MoveToTrash), Err(GuardError::Protected));
        assert_eq!(f.guard.check(Path::new("/"), &Policy::MoveToTrash), Err(GuardError::Protected));
        assert_eq!(f.guard.check(&f.home.join("Documents"), &Policy::MoveToTrash), Err(GuardError::Protected));
    }

    #[test]
    fn rejects_junk_outside_its_root() {
        let f = fixture();
        let p = f.home.join("Documents/big.mov");
        assert_eq!(f.guard.check(&p, &junk(&f)), Err(GuardError::OutsideRoot));
    }

    #[test]
    fn rejects_junk_root_outside_home() {
        let f = fixture();
        let p = f.home.join("Library/Caches/com.foo");
        let policy = Policy::DeleteJunk { root: PathBuf::from("/tmp") };
        assert_eq!(f.guard.check(&p, &policy), Err(GuardError::InvalidRoot));
    }

    #[test]
    fn rejects_relative_traversal_and_missing() {
        let f = fixture();
        assert_eq!(f.guard.check(Path::new("Library/Caches/x"), &junk(&f)), Err(GuardError::NotAbsolute));
        let trav = f.home.join("Library/Caches/com.foo/../../../Documents/big.mov");
        assert_eq!(f.guard.check(&trav, &junk(&f)), Err(GuardError::Traversal));
        assert_eq!(f.guard.check(&f.home.join("Library/Caches/gone"), &junk(&f)), Err(GuardError::Missing));
    }

    #[test]
    fn rejects_path_through_symlinked_dir_escaping_root() {
        let f = fixture();
        symlink(f.home.join("Documents"), f.home.join("Library/Caches/evil")).unwrap();
        let p = f.home.join("Library/Caches/evil/big.mov");
        assert_eq!(f.guard.check(&p, &junk(&f)), Err(GuardError::OutsideRoot));
    }

    #[test]
    fn symlink_item_resolves_to_link_not_target() {
        let f = fixture();
        let link = f.home.join("Library/Caches/link");
        symlink(f.home.join("Documents"), &link).unwrap();
        assert_eq!(f.guard.check(&link, &junk(&f)), Ok(link));
    }

    #[test]
    fn forbidden_subtrees_rejected() {
        let f = fixture();
        let p = f.home.join(".ssh/id_ed25519");
        assert_eq!(f.guard.check(&p, &Policy::MoveToTrash), Err(GuardError::Forbidden));
    }

    #[test]
    fn move_to_trash_limited_to_home_and_apps() {
        let f = fixture();
        let doc = f.home.join("Documents/big.mov");
        assert_eq!(f.guard.check(&doc, &Policy::MoveToTrash), Ok(doc));
        let other = tempfile::tempdir().unwrap();
        let outside = other.path().join("f");
        fs::write(&outside, b"x").unwrap();
        assert_eq!(f.guard.check(&outside, &Policy::MoveToTrash), Err(GuardError::OutsideRoot));
    }

    #[test]
    fn installed_app_rules() {
        let f = fixture();
        let apps = f.home.join("Applications");
        fs::create_dir_all(apps.join("Foo.app/Contents/Helpers/Bar.app")).unwrap();
        fs::create_dir_all(apps.join("Sub/Baz.app")).unwrap();
        assert!(f.guard.is_installed_app(&apps.join("Foo.app")));
        assert!(f.guard.is_installed_app(&apps.join("Sub/Baz.app")));
        assert!(!f.guard.is_installed_app(&apps.join("Foo.app/Contents/Helpers/Bar.app")));
        assert!(!f.guard.is_installed_app(Path::new("/Applications/Utilities")));
        assert!(f.guard.is_installed_app(Path::new("/Applications/Utilities/Some.app")));
        assert!(!f.guard.is_installed_app(Path::new("/System/Applications/Mail.app")));
    }

    #[test]
    fn empty_trash_only_direct_children() {
        let f = fixture();
        let entry = f.home.join(".Trash/old.txt");
        assert_eq!(f.guard.check(&entry, &Policy::EmptyTrashEntry), Ok(entry));
        let doc = f.home.join("Documents/big.mov");
        assert_eq!(f.guard.check(&doc, &Policy::EmptyTrashEntry), Err(GuardError::OutsideRoot));
        assert_eq!(f.guard.check(&f.home.join(".Trash"), &Policy::EmptyTrashEntry), Err(GuardError::Protected));
    }
}
