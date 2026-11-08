use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;

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

    /// ~/Library/Logs/Limpae/actions.log
    pub fn in_home(home: &Path) -> Self {
        Self::new(home.join("Library/Logs/Limpae/actions.log"))
    }

    /// Like `in_home`, first moving the pre-rebrand log (~/Library/Logs/Limpaemeo) so the activity history and
    /// the audit trail carry over. Best effort: a failed move just starts a new log.
    pub fn in_home_migrating(home: &Path) -> Self {
        let log = Self::in_home(home);
        let old_dir = home.join("Library/Logs/Limpaemeo");
        if let Some(dir) = log.path.parent()
            && fs::symlink_metadata(dir).is_err()
            && fs::symlink_metadata(&old_dir).is_ok()
        {
            let _ = fs::rename(&old_dir, dir);
        }
        log
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Stats of everything logged so far, relative to today (local time). A missing or unreadable log is an
    /// empty history, not an error. Does not take the write lock (a removal must never wait on a long read); a
    /// line being appended right now is at worst seen half-written and skipped as malformed.
    pub fn activity(&self) -> Activity {
        match File::open(&self.path) {
            Ok(f) => activity_from(BufReader::new(f), Ymd::today()),
            Err(_) => activity_from(std::io::empty(), Ymd::today()),
        }
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

/// Successful actions that count as cleaned items. "lixo" moves to the Trash without freeing space (the bytes
/// are counted when the Trash is emptied, logged as "esvaziar"), so it adds an item but no bytes; "recusado"
/// and everything unknown never count.
const CLEANED: [&str; 5] = ["apagar", "apagar-definitivo", "esvaziar", "lixo", "desincronizar"];
const NO_SPACE_YET: &str = "lixo";
/// Days in the per-day series.
pub const SERIES_DAYS: usize = 30;

/// A calendar day in local time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Ymd {
    pub y: i32,
    pub m: u32,
    pub d: u32,
}

impl Ymd {
    pub fn today() -> Self {
        // SAFETY: time/localtime_r only write into the tm we pass.
        let tm = unsafe {
            let t = libc::time(std::ptr::null_mut());
            let mut tm: libc::tm = std::mem::zeroed();
            libc::localtime_r(&t, &mut tm);
            tm
        };
        Self { y: tm.tm_year + 1900, m: (tm.tm_mon + 1) as u32, d: tm.tm_mday as u32 }
    }

    /// Days since 1970-01-01 (proleptic Gregorian; Howard Hinnant's `days_from_civil`).
    fn ordinal(self) -> i64 {
        let y = i64::from(self.y) - i64::from(self.m <= 2);
        let era = y.div_euclid(400);
        let yoe = y.rem_euclid(400);
        let mp = (i64::from(self.m) + 9) % 12;
        let doy = (153 * mp + 2) / 5 + i64::from(self.d) - 1;
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        era * 146_097 + doe - 719_468
    }

    fn from_ordinal(z: i64) -> Self {
        let z = z + 719_468;
        let era = z.div_euclid(146_097);
        let doe = z.rem_euclid(146_097);
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
        let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
        let y = (yoe + era * 400) as i32 + i32::from(m <= 2);
        Self { y, m, d }
    }

    fn iso(self) -> String {
        format!("{:04}-{:02}-{:02}", self.y, self.m, self.d)
    }
}

/// Bytes freed on one local day.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DayFreed {
    /// "YYYY-MM-DD", local time.
    pub date: String,
    pub bytes: u64,
}

/// What the action log says about past cleanups.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    /// Bytes of every successful freeing action ever logged.
    pub total_freed: u64,
    /// The same, for the current local month.
    pub month_freed: u64,
    /// Successful freeing actions (items removed).
    pub items: u64,
    /// Unix seconds of the most recent one (None = no cleanup yet).
    pub last_cleanup: Option<i64>,
    /// Exactly `SERIES_DAYS` entries, oldest first, the last one being today (zero-filled).
    pub days: Vec<DayFreed>,
}

struct Parsed<'a> {
    ymd: Ymd,
    /// "YYYY-MM-DD HH:MM:SS", fixed width, so it sorts chronologically as text.
    time: &'a str,
    bytes: u64,
}

/// One log line, or `None` when it is malformed, failed, or not a freeing action. Never panics.
fn parse_line(line: &str) -> Option<Parsed<'_>> {
    let mut f = line.splitn(5, '\t');
    let (time, action, status, bytes) = (f.next()?, f.next()?, f.next()?, f.next()?);
    f.next()?; // the path; may itself contain anything but must be present
    if status != "ok" || !CLEANED.contains(&action) {
        return None;
    }
    let bytes = if action == NO_SPACE_YET { 0 } else { bytes.parse::<u64>().ok()? };
    let t = time.as_bytes();
    let digits = |r: std::ops::Range<usize>| t[r].iter().all(u8::is_ascii_digit);
    if t.len() != 19 || t[4] != b'-' || t[7] != b'-' || t[10] != b' ' || t[13] != b':' || t[16] != b':' {
        return None;
    }
    if !(digits(0..4) && digits(5..7) && digits(8..10) && digits(11..13) && digits(14..16) && digits(17..19)) {
        return None;
    }
    let num = |r: std::ops::Range<usize>| time[r].parse::<u32>().ok();
    let (y, m, d, hh, mi, ss) = (num(0..4)?, num(5..7)?, num(8..10)?, num(11..13)?, num(14..16)?, num(17..19)?);
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) || hh > 23 || mi > 59 || ss > 60 {
        return None;
    }
    Some(Parsed { ymd: Ymd { y: y as i32, m, d }, time, bytes })
}

fn local_to_unix(time: &str) -> Option<i64> {
    let n = |r: std::ops::Range<usize>| time.get(r)?.parse::<i32>().ok();
    // SAFETY: tm is plain data; mktime only reads and normalizes it.
    let t = unsafe {
        let mut tm: libc::tm = std::mem::zeroed();
        tm.tm_year = n(0..4)? - 1900;
        tm.tm_mon = n(5..7)? - 1;
        tm.tm_mday = n(8..10)?;
        tm.tm_hour = n(11..13)?;
        tm.tm_min = n(14..16)?;
        tm.tm_sec = n(17..19)?.min(59);
        tm.tm_isdst = -1;
        libc::mktime(&mut tm)
    };
    (t != -1).then_some(t as i64)
}

/// Streams `reader` line by line (the log can be large) and folds it into [`Activity`]. Invalid UTF-8, short
/// lines, bad numbers or dates are skipped, never fatal. Rows dated after `today` still count in the totals but
/// not in the month or the series.
pub fn activity_from<R: BufRead>(mut reader: R, today: Ymd) -> Activity {
    let today_n = today.ordinal();
    let mut series = [0u64; SERIES_DAYS];
    let mut a = Activity::default();
    let mut last_time = String::new();
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let line = String::from_utf8_lossy(&buf);
        let Some(p) = parse_line(line.trim_end_matches(['\n', '\r'])) else { continue };
        a.total_freed = a.total_freed.saturating_add(p.bytes);
        a.items += 1;
        if p.time > last_time.as_str() {
            last_time = p.time.to_string();
        }
        if p.ymd.y == today.y && p.ymd.m == today.m && p.ymd.d <= today.d {
            a.month_freed = a.month_freed.saturating_add(p.bytes);
        }
        let age = today_n - p.ymd.ordinal();
        if (0..SERIES_DAYS as i64).contains(&age) {
            let slot = &mut series[SERIES_DAYS - 1 - age as usize];
            *slot = slot.saturating_add(p.bytes);
        }
    }
    a.last_cleanup = local_to_unix(&last_time);
    a.days = series
        .iter()
        .enumerate()
        .map(|(i, &bytes)| DayFreed { date: Ymd::from_ordinal(today_n - (SERIES_DAYS - 1 - i) as i64).iso(), bytes })
        .collect();
    a
}

/// Local time as "YYYY-MM-DD HH:MM:SS".
pub fn local_time() -> String {
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

    const TODAY: Ymd = Ymd { y: 2026, m: 3, d: 15 };

    fn stats(text: &str) -> Activity {
        activity_from(text.as_bytes(), TODAY)
    }

    #[test]
    fn empty_history_has_a_zero_filled_series() {
        let a = stats("");
        assert_eq!((a.total_freed, a.month_freed, a.items, a.last_cleanup), (0, 0, 0, None));
        assert_eq!(a.days.len(), SERIES_DAYS);
        assert_eq!(a.days[SERIES_DAYS - 1].date, "2026-03-15");
        assert_eq!(a.days[0].date, "2026-02-14", "29 days before, crossing a month boundary");
        assert!(a.days.iter().all(|d| d.bytes == 0));
    }

    #[test]
    fn counts_only_successful_freeing_actions() {
        let a = stats(concat!(
            "2026-03-15 10:00:00\tapagar\tok\t100\t/a\n",
            "2026-03-15 10:00:01\tesvaziar\tok\t200\t/b\n",
            "2026-03-14 09:00:00\tlixo\tok\t300\t/c\n",
            "2026-03-10 09:00:00\tdesincronizar\tok\t400\t/d\n",
            "2026-03-15 10:00:02\tapagar\terro\t999\t/e\n",
            "2026-03-15 10:00:03\trecusado\terro\t0\t/f\n",
            "2026-03-15 10:00:04\trecusado\tok\t777\t/g\n",
            "2026-03-15 10:00:05\tdesconhecida\tok\t555\t/h\n",
        ));
        // The "lixo" row is a cleaned item but frees nothing until the Trash is emptied.
        assert_eq!((a.total_freed, a.items), (700, 4));
        assert_eq!(a.month_freed, 700);
        assert_eq!(a.days[SERIES_DAYS - 1].bytes, 300);
        assert_eq!(a.days[SERIES_DAYS - 2].bytes, 0);
        assert_eq!(a.days[SERIES_DAYS - 6].bytes, 400);
        assert_eq!(a.days.iter().map(|d| d.bytes).sum::<u64>(), 700);
    }

    #[test]
    fn month_series_window_and_last_cleanup_boundaries() {
        let a = stats(concat!(
            "2026-02-28 23:59:59\tapagar\tok\t10\t/prev-month\n",
            "2026-03-01 00:00:00\tapagar\tok\t20\t/first-of-month\n",
            "2026-02-14 12:00:00\tapagar\tok\t30\t/oldest-in-window\n",
            "2026-02-13 12:00:00\tapagar\tok\t40\t/just-outside\n",
            "2025-03-15 12:00:00\tapagar\tok\t50\t/last-year-same-day\n",
            "2026-03-16 12:00:00\tapagar\tok\t60\t/future\n",
        ));
        assert_eq!(a.total_freed, 210, "everything counts in the total");
        assert_eq!(a.month_freed, 20, "only March up to today");
        assert_eq!(a.days[0].bytes, 30);
        assert_eq!(a.days.iter().map(|d| d.bytes).sum::<u64>(), 10 + 20 + 30);
        let last = a.last_cleanup.unwrap();
        // The latest row is the future one (2026-03-16 12:00:00 local): round-trips through localtime.
        let mut tm: libc::tm = unsafe { std::mem::zeroed() };
        unsafe { libc::localtime_r(&last, &mut tm) };
        assert_eq!((tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday, tm.tm_hour), (2026, 3, 16, 12));
    }

    #[test]
    fn last_cleanup_is_the_latest_ok_row_regardless_of_order() {
        let a = stats(concat!(
            "2026-03-10 08:00:00\tapagar\tok\t1\t/a\n",
            "2026-03-12 08:00:00\tapagar\tok\t1\t/b\n",
            "2026-03-11 08:00:00\tapagar\tok\t1\t/c\n",
            "2026-03-14 08:00:00\tapagar\terro\t1\t/failed-is-ignored\n",
        ));
        let mut tm: libc::tm = unsafe { std::mem::zeroed() };
        let t = a.last_cleanup.unwrap();
        unsafe { libc::localtime_r(&t, &mut tm) };
        assert_eq!((tm.tm_mon + 1, tm.tm_mday), (3, 12));
    }

    #[test]
    fn malformed_lines_are_skipped_not_fatal() {
        let mut raw: Vec<u8> = Vec::new();
        for line in [
            "",
            "lixo sem tabs",
            "2026-03-15 10:00:00\tapagar\tok",
            "2026-03-15 10:00:00\tapagar\tok\t12",
            "2026-03-15 10:00:00\tapagar\tok\tNaN\t/x",
            "2026-03-15 10:00:00\tapagar\tok\t-5\t/x",
            "2026-03-15 10:00:00\tapagar\tok\t99999999999999999999999\t/x",
            "15/03/2026 10:00:00\tapagar\tok\t5\t/x",
            "2026-13-15 10:00:00\tapagar\tok\t5\t/x",
            "2026-03-32 10:00:00\tapagar\tok\t5\t/x",
            "2026-03-15 25:00:00\tapagar\tok\t5\t/x",
            "2026-03-15T10:00:00\tapagar\tok\t5\t/x",
            "２０２６-03-15 10:00:00\tapagar\tok\t5\t/x",
            "\t\t\t\t",
        ] {
            raw.extend_from_slice(line.as_bytes());
            raw.push(b'\n');
        }
        raw.extend_from_slice(b"2026-03-15 10:00:00\tapagar\tok\t7\t/inv\xff\xfealid-utf8\n");
        raw.extend_from_slice(b"2026-03-15 11:00:00\tlixo\tok\t8\t/a\tb\twith\ttabs\r\n");
        raw.extend_from_slice(b"2026-03-15 12:00:00\tlixo\tok\t9\t/no-trailing-newline");
        let a = activity_from(&raw[..], TODAY);
        // Both "lixo" rows parse (tabs in the path, no trailing newline) and count as items, not bytes.
        assert_eq!((a.total_freed, a.items), (7, 3));
    }

    #[test]
    fn calendar_math_roundtrips() {
        for z in [-800_000, -1, 0, 1, 59, 60, 365, 11_016, 19_000, 20_527, 2_932_896] {
            assert_eq!(Ymd::from_ordinal(z).ordinal(), z);
        }
        let leap = Ymd { y: 2024, m: 3, d: 1 };
        assert_eq!(Ymd::from_ordinal(leap.ordinal() - 1).iso(), "2024-02-29");
        assert_eq!(Ymd { y: 1970, m: 1, d: 1 }.ordinal(), 0);
        assert_eq!(Ymd { y: 2000, m: 3, d: 1 }.ordinal() - Ymd { y: 2000, m: 2, d: 28 }.ordinal(), 2);
    }

    #[test]
    fn reads_the_real_log_written_by_record() {
        let dir = tempfile::tempdir().unwrap();
        let log = ActionLog::in_home(dir.path());
        assert_eq!(log.activity().total_freed, 0, "missing log = empty history");
        log.record("apagar", Path::new("/a"), true, 1_000);
        log.record("lixo", Path::new("/b"), true, 500);
        log.record("apagar", Path::new("/c"), false, 9_999);
        log.record("apagar-definitivo", Path::new("/d"), true, 0);
        let a = log.activity();
        assert_eq!((a.total_freed, a.month_freed, a.items), (1_000, 1_000, 3));
        assert_eq!(a.days[SERIES_DAYS - 1].bytes, 1_000);
        let now = unsafe { libc::time(std::ptr::null_mut()) } as i64;
        assert!((now - a.last_cleanup.unwrap()).abs() < 5);
    }

    #[test]
    fn serializes_for_the_ui() {
        let v = serde_json::to_value(stats("2026-03-15 10:00:00\tapagar\tok\t100\t/a\n")).unwrap();
        assert_eq!(v["totalFreed"], 100);
        assert_eq!(v["monthFreed"], 100);
        assert_eq!(v["days"][29]["date"], "2026-03-15");
    }

    #[test]
    fn migrates_the_old_log_folder() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("Library/Logs/Limpaemeo/actions.log");
        fs::create_dir_all(old.parent().unwrap()).unwrap();
        fs::write(&old, "2026-10-29 10:00:00\tapagar\tok\t5\t/a\n").unwrap();
        let log = ActionLog::in_home_migrating(dir.path());
        assert_eq!(log.activity().total_freed, 5);
        assert!(!old.exists());
    }
}
