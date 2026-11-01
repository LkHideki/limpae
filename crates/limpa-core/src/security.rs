//! Security: the Mac's security posture (read-only), app permissions (TCC) and privacy data.
//!
//! This module only reads state: it reads what macOS itself reports, lists what the user has granted
//! to each app and offers to clear usage traces (recent items and data of closed browsers).
//! Every subprocess uses an absolute path, an argument vector (no shell) and a timeout.

pub mod posture;
pub mod privacy;
pub mod tcc;

use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Output of a subprocess that finished within the timeout.
#[derive(Debug, Clone)]
pub struct Captured {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
}

/// Each stream is read only up to this limit; the rest is discarded.
const MAX_CAPTURE: u64 = 8_000_000;
const POLL: Duration = Duration::from_millis(10);

fn read_capped(mut r: impl Read) -> String {
    let mut buf = Vec::new();
    let _ = (&mut r).take(MAX_CAPTURE).read_to_end(&mut buf);
    // Drain the rest so the process never blocks writing into a full pipe.
    let _ = std::io::copy(&mut r, &mut std::io::sink());
    String::from_utf8_lossy(&buf).into_owned()
}

/// Runs `program` (absolute path) with `args`, without a shell. `None` if it did not start or exceeded `timeout`
/// (in which case the process is terminated).
pub fn run_capture(program: &str, args: &[&str], timeout: Duration) -> Option<Captured> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    let out = child.stdout.take()?;
    let err = child.stderr.take()?;
    let t_out = std::thread::spawn(move || read_capped(out));
    let t_err = std::thread::spawn(move || read_capped(err));
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Some(s),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(POLL),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let stdout = t_out.join().unwrap_or_default();
    let stderr = t_err.join().unwrap_or_default();
    status.map(|s| Captured { ok: s.success(), stdout, stderr })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn captures_output_and_status() {
        let r = run_capture("/bin/echo", &["olá"], Duration::from_secs(3)).unwrap();
        assert!(r.ok);
        assert_eq!(r.stdout.trim(), "olá");
        let f = run_capture("/usr/bin/false", &[], Duration::from_secs(3)).unwrap();
        assert!(!f.ok);
    }

    #[test]
    fn times_out_and_kills() {
        let t = Instant::now();
        assert!(run_capture("/bin/sleep", &["5"], Duration::from_millis(200)).is_none());
        assert!(t.elapsed() < Duration::from_secs(3));
    }

    /// Read-only report for this machine: `cargo test -p limpa-core real_machine -- --ignored --nocapture`.
    #[test]
    #[ignore = "lê o Mac real; só para inspeção manual"]
    fn real_machine_report() {
        use std::collections::HashSet;
        let home = std::env::home_dir().unwrap();
        for c in posture::run_checks() {
            eprintln!("CHECK {:<10} ok={:?} fix={} | {}", c.id, c.ok, c.fix.is_some(), c.detail);
        }
        match tcc::read_all(&home) {
            Ok(rows) => eprintln!(
                "TCC {} entradas: {:?}",
                rows.len(),
                rows.iter().map(|e| (e.service, &e.client)).collect::<Vec<_>>()
            ),
            Err(e) => eprintln!("TCC {e:?}"),
        }
        let running: HashSet<String> = crate::running::running_bundle_ids();
        for b in privacy::browser_states(&home, &running) {
            eprintln!("BROWSER {} present={} running={}", b.name, b.present, b.running);
        }
        let groups = privacy::scan(&home, &running, &crate::Progress::silent());
        for g in &groups {
            eprintln!("GROUP {:<18} items={} total={} {}", g.id, g.items.len(), g.total(), g.description);
        }
        let guard = crate::Guard::new(&home);
        for i in groups.iter().flat_map(|g| &g.items) {
            assert!(guard.check(&i.path, &i.policy).is_ok(), "{}", i.path.display());
        }
    }

    #[test]
    fn missing_program_is_none() {
        assert!(run_capture("/nonexistent/bin/x", &[], Duration::from_secs(1)).is_none());
    }
}
