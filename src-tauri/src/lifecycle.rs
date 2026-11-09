//! Frees the WebView while the window is closed. With the menu bar extra on, closing only hides the window (instant
//! reopen), but a hidden WKWebView keeps its content process (~130 MB). After `HIDDEN_BEFORE_DESTROY` hidden, and
//! only while no scan or cleanup runs, the window is destroyed; `tray::show_main` rebuilds it from the config.
//!
//! The decision is the pure `should_destroy`. Everything else here is bookkeeping around it: when the window was
//! hidden, whether the UI reports an operation in progress, and a teardown phase so a reopen racing the (asynchronous)
//! destroy waits instead of showing a dying window.

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, State};

use crate::state::{AppState, lock};
use crate::tray;

/// How long the main window must stay hidden before its webview is released.
pub const HIDDEN_BEFORE_DESTROY: Duration = Duration::from_secs(60);

/// Pure policy: destroy only a window that has been hidden for the full grace period and nothing is running.
/// `hidden_for` is `None` while the window is visible (or gone).
pub fn should_destroy(hidden_for: Option<Duration>, busy: bool) -> bool {
    !busy && hidden_for.is_some_and(|d| d >= HIDDEN_BEFORE_DESTROY)
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Phase {
    /// Visible, or no window exists (nothing to destroy).
    Shown,
    Hidden(Instant),
    /// `destroy()` was issued; the window may still be in the registry for a moment.
    Destroying,
}

pub struct Lifecycle {
    phase: Mutex<Phase>,
    /// Last value reported by the UI through `ui_busy`.
    ui_busy: AtomicBool,
}

impl Default for Lifecycle {
    fn default() -> Self {
        Self { phase: Mutex::new(Phase::Shown), ui_busy: AtomicBool::new(false) }
    }
}

impl Lifecycle {
    fn phase(&self) -> Phase {
        *self.phase.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn set(&self, p: Phase) {
        *self.phase.lock().unwrap_or_else(|e| e.into_inner()) = p;
    }

    fn hidden_for(&self, now: Instant) -> Option<Duration> {
        match self.phase() {
            Phase::Hidden(since) => Some(now.saturating_duration_since(since)),
            _ => None,
        }
    }

    pub fn is_destroying(&self) -> bool {
        self.phase() == Phase::Destroying
    }

    /// The existing window is visible again; its UI is alive, so the busy flag it reported stays.
    pub fn mark_visible(&self) {
        self.set(Phase::Shown);
    }

    /// The window is gone or has just been (re)created: it has a fresh UI that reports its own busy state.
    pub fn mark_shown(&self) {
        self.set(Phase::Shown);
        self.ui_busy.store(false, Ordering::Relaxed);
    }
}

fn busy(app: &AppHandle) -> bool {
    app.state::<Lifecycle>().ui_busy.load(Ordering::Relaxed)
        || !lock(&app.state::<std::sync::Arc<AppState>>().active).is_empty()
}

/// Called right after the close button hid the window: starts the grace period.
pub fn on_hidden(app: &AppHandle) {
    app.state::<Lifecycle>().set(Phase::Hidden(Instant::now()));
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(HIDDEN_BEFORE_DESTROY);
        check(&app);
    });
}

/// The window is gone (destroyed): nothing is hidden or running in it any more.
pub fn on_destroyed(app: &AppHandle) {
    app.state::<Lifecycle>().mark_shown();
}

/// Destroys the main window if the policy says so. Cheap and idempotent; called when the grace period ends and when
/// the UI turns idle. A stale timer from an earlier hide is harmless: the elapsed time is measured from the latest one.
pub fn check(app: &AppHandle) {
    if !tray::menu_bar_enabled(app) {
        return;
    }
    let lc = app.state::<Lifecycle>();
    if !should_destroy(lc.hidden_for(Instant::now()), busy(app)) {
        return;
    }
    let handle = app.clone();
    // The decision is repeated on the main thread, where `show_main` runs too, so a reopen cannot slip in between.
    let _ = app.run_on_main_thread(move || {
        let lc = handle.state::<Lifecycle>();
        if !should_destroy(lc.hidden_for(Instant::now()), busy(&handle)) || !tray::menu_bar_enabled(&handle) {
            return;
        }
        if let Some(w) = handle.get_webview_window("main") {
            lc.set(Phase::Destroying);
            let _ = w.destroy();
        } else {
            lc.mark_shown();
        }
    });
}

/// The UI reports whether a scan, removal or other operation is in progress (`setBusy` in main.js).
#[tauri::command]
pub fn ui_busy(app: AppHandle, state: State<'_, Lifecycle>, busy: bool) {
    state.ui_busy.store(busy, Ordering::Relaxed);
    if !busy {
        check(&app);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const S: fn(u64) -> Option<Duration> = |n| Some(Duration::from_secs(n));

    #[test]
    fn visible_window_is_never_destroyed() {
        assert!(!should_destroy(None, false));
        assert!(!should_destroy(None, true));
    }

    #[test]
    fn waits_for_the_full_grace_period() {
        assert!(!should_destroy(S(0), false));
        assert!(!should_destroy(S(59), false));
        assert!(!should_destroy(Some(Duration::from_millis(59_999)), false));
        assert!(should_destroy(S(60), false));
        assert!(should_destroy(S(3600), false));
    }

    #[test]
    fn never_destroys_while_busy() {
        assert!(!should_destroy(S(60), true));
        assert!(!should_destroy(S(86_400), true));
    }

    #[test]
    fn becoming_idle_after_the_grace_period_destroys() {
        let hidden = S(120);
        assert!(!should_destroy(hidden, true));
        assert!(should_destroy(hidden, false));
    }

    #[test]
    fn hidden_time_is_measured_from_the_latest_hide() {
        let lc = Lifecycle::default();
        let t0 = Instant::now();
        assert_eq!(lc.hidden_for(t0), None);
        lc.set(Phase::Hidden(t0));
        assert_eq!(lc.hidden_for(t0 + Duration::from_secs(61)), S(61));
        // Shown again, then hidden again: the old timer's clock is gone.
        lc.mark_shown();
        assert_eq!(lc.hidden_for(t0 + Duration::from_secs(61)), None);
        lc.set(Phase::Hidden(t0 + Duration::from_secs(60)));
        assert!(!should_destroy(lc.hidden_for(t0 + Duration::from_secs(61)), false));
    }

    #[test]
    fn destroying_phase_is_not_hidden_and_resets_on_show() {
        let lc = Lifecycle::default();
        lc.ui_busy.store(true, Ordering::Relaxed);
        lc.set(Phase::Destroying);
        assert!(lc.is_destroying());
        assert_eq!(lc.hidden_for(Instant::now()), None);
        lc.mark_shown();
        assert!(!lc.is_destroying());
        assert!(!lc.ui_busy.load(Ordering::Relaxed));
    }
}
