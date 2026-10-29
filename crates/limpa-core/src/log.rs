use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Append-only record of every removal attempt, so the user can audit what
/// was deleted (tab-separated: local time, action, ok/err, bytes, path).
pub struct ActionLog {
    path: PathBuf,
    lock: Mutex<()>,
}

impl ActionLog {
    pub fn new(path: PathBuf) -> Self {
        Self { path, lock: Mutex::new(()) }
    }

    /// ~/Library/Logs/Limpaemeo/actions.log
    pub fn in_home(home: &Path) -> Self {
        Self::new(home.join("Library/Logs/Limpaemeo/actions.log"))
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Logging must never block a removal, so I/O errors are ignored.
    pub fn record(&self, action: &str, path: &Path, ok: bool, bytes: u64) {
        let _guard = self.lock.lock().unwrap();
        if let Some(dir) = self.path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&self.path) {
            let status = if ok { "ok" } else { "erro" };
            let _ = writeln!(f, "{}\t{action}\t{status}\t{bytes}\t{}", local_time(), path.display());
        }
    }
}

fn local_time() -> String {
    // SAFETY: time/localtime_r/strftime only write into the buffers we pass.
    unsafe {
        let t = libc::time(std::ptr::null_mut());
        let mut tm: libc::tm = std::mem::zeroed();
        libc::localtime_r(&t, &mut tm);
        let mut buf = [0u8; 32];
        let n = libc::strftime(buf.as_mut_ptr().cast(), buf.len(), c"%Y-%m-%d %H:%M:%S".as_ptr(), &tm);
        String::from_utf8_lossy(&buf[..n]).into_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appends_tab_separated_lines() {
        let dir = tempfile::tempdir().unwrap();
        let log = ActionLog::in_home(dir.path());
        log.record("apagar", Path::new("/a b"), true, 42);
        log.record("lixo", Path::new("/c"), false, 0);
        let text = fs::read_to_string(log.path()).unwrap();
        let lines: Vec<_> = text.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].ends_with("\tapagar\tok\t42\t/a b"), "{}", lines[0]);
        assert!(lines[1].contains("\tlixo\terro\t0\t/c"));
    }
}
