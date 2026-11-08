//! Read-only timing of the scanners on this Mac's real home folder. Nothing is removed.
//!
//!     cargo run -p limpa-core --release --example bench [-- junk large lens dups]
//!
//! Each scanner runs in a fresh process (see scripts/measure.sh) so the peak RSS is its own; run twice to compare
//! a cold and a warm file-system cache.

use std::collections::HashSet;
use std::time::Instant;

use limpa_core::Progress;

fn peak_rss_mb() -> f64 {
    // SAFETY: getrusage only writes into the struct we pass.
    let mut u: libc::rusage = unsafe { std::mem::zeroed() };
    unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut u) };
    u.ru_maxrss as f64 / 1e6 // bytes on macOS
}

fn main() {
    let home = std::env::home_dir().expect("home");
    let which: Vec<String> = std::env::args().skip(1).collect();
    let all = ["junk", "large", "lens", "dups"];
    let run: Vec<&str> = if which.is_empty() {
        all.to_vec()
    } else {
        which.iter().map(String::as_str).filter(|w| all.contains(w)).collect()
    };
    let p = Progress::silent();
    for name in run {
        let t = Instant::now();
        let (items, bytes): (usize, u64) = match name {
            "junk" => {
                let g = limpa_core::junk::scan_junk(&home, &HashSet::new(), &p);
                (g.iter().map(|g| g.items.len()).sum(), g.iter().flat_map(|g| &g.items).map(|i| i.size).sum())
            }
            "large" => {
                let g = limpa_core::large::scan_large(&home, 50 << 20, &p);
                (g.iter().map(|g| g.items.len()).sum(), g.iter().flat_map(|g| &g.items).map(|i| i.size).sum())
            }
            "lens" => {
                let tree = limpa_core::lens::build(&home, &p);
                (tree.len(), tree.size(0).unwrap_or(0))
            }
            "dups" => {
                let g = limpa_core::clutter::duplicates(&home, 1 << 20, &p);
                (g.iter().map(|g| g.items.len()).sum(), g.iter().flat_map(|g| &g.items).map(|i| i.size).sum())
            }
            _ => unreachable!(),
        };
        println!(
            "{name:6} {:7.2}s  items={items:<8} size={:8.2}GB  peak_rss={:.0}MB",
            t.elapsed().as_secs_f64(),
            bytes as f64 / 1e9,
            peak_rss_mb()
        );
    }
}
