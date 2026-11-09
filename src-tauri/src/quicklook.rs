//! Quick Look preview of one file, in-app like Finder: the shared `QLPreviewPanel` (floating, arrow-less, closed
//! with Space or Esc) instead of a detached `qlmanage -p` process. `preview` behaves like Finder's Space: asking
//! for the item the panel already shows closes it, asking for another one swaps it in place.
//!
//! The panel is an AppKit object, so everything that touches it runs on the main thread. The panel finds its
//! content provider by walking the responder chain of the key window; `Controller` is spliced in as the main
//! window's `nextResponder`, answers `acceptsPreviewPanelControl:` and acts as data source and delegate. If the
//! panel cannot be created (no main window, non-UTF-8 path, not macOS), the path goes to `qlmanage` instead.
//! The UI is told about open/close through the `quicklook` event (payload: bool) so that Esc can close the panel
//! before it leaves the screen.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use tauri::AppHandle;

const QLMANAGE: &str = "/usr/bin/qlmanage";
/// Event telling the UI whether the panel is on screen.
pub const EVENT: &str = "quicklook";

/// What a preview request does, given the file shown by the visible panel (`None` when it is hidden).
#[derive(Debug, PartialEq, Eq)]
enum Step {
    Open,
    Swap,
    Close,
}

fn plan(showing: Option<&Path>, want: &Path) -> Step {
    match showing {
        None => Step::Open,
        Some(p) if p == want => Step::Close,
        Some(_) => Step::Swap,
    }
}

/// Toggles the Quick Look panel for `path` (an existing file, already resolved from a registry id by the caller).
/// Returns whether the panel is showing afterwards.
pub fn preview(app: &AppHandle, path: PathBuf) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    match panel::toggle(app, &path) {
        panel::Toggle::Done(open) => return Ok(open),
        // The closure is still queued and may open the panel later: a `qlmanage` window now would double the preview.
        panel::Toggle::Unresponsive => return Err("Não foi possível abrir a Visualização Rápida.".into()),
        panel::Toggle::Unavailable => {}
    }
    let _ = app;
    fallback(&path).map(|()| true)
}

/// Closes the panel if it is on screen. Does nothing otherwise (or when there is no native panel).
pub fn close(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    panel::close(app);
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// Detached `qlmanage -p`; a thread reaps it so it never lingers as a zombie once the user closes its window.
fn fallback(path: &Path) -> Result<(), String> {
    let mut child = Command::new(QLMANAGE)
        .arg("-p")
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Não foi possível abrir a Visualização Rápida: {e}"))?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(target_os = "macos")]
mod panel {
    use std::cell::RefCell;
    use std::path::{Path, PathBuf};
    use std::sync::mpsc;
    use std::time::Duration;

    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, ProtocolObject};
    use objc2::{DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send};
    use objc2_app_kit::{NSResponder, NSWindow};
    use objc2_foundation::{NSInteger, NSObjectProtocol, NSString, NSURL};
    use objc2_quick_look_ui::{QLPreviewPanel, QLPreviewPanelDataSource};
    use tauri::{AppHandle, Emitter, Manager};

    use super::{EVENT, Step, plan};

    /// The main thread answers within microseconds; this only bounds a wedged event loop.
    const MAIN_THREAD_WAIT: Duration = Duration::from_secs(2);

    struct Ivars {
        app: AppHandle,
        shown: RefCell<Option<(PathBuf, Retained<NSURL>)>>,
    }

    define_class!(
        // NSResponder (not NSObject): the panel walks `nextResponder` links while it looks for a controller.
        #[unsafe(super(NSResponder))]
        #[thread_kind = MainThreadOnly]
        #[name = "LimpaeQuickLookController"]
        #[ivars = Ivars]
        struct Controller;

        impl Controller {
            #[unsafe(method(acceptsPreviewPanelControl:))]
            fn accepts_panel_control(&self, _panel: Option<&QLPreviewPanel>) -> bool {
                true
            }

            #[unsafe(method(beginPreviewPanelControl:))]
            fn begin_panel_control(&self, panel: Option<&QLPreviewPanel>) {
                if let Some(panel) = panel {
                    self.attach(panel);
                }
            }

            // Sent whenever the panel lets go of us, which includes the user closing it (Space or Esc inside it):
            // the UI must stop treating Esc as "close the preview".
            #[unsafe(method(endPreviewPanelControl:))]
            fn end_panel_control(&self, panel: Option<&QLPreviewPanel>) {
                *self.ivars().shown.borrow_mut() = None;
                let _ = self.ivars().app.emit(EVENT, false);
                if let Some(panel) = panel {
                    // SAFETY: plain setters on the main thread; clearing never leaves a dangling data source.
                    unsafe {
                        panel.setDataSource(None);
                        panel.setDelegate(None);
                    }
                }
            }
        }

        unsafe impl NSObjectProtocol for Controller {}

        unsafe impl QLPreviewPanelDataSource for Controller {
            #[unsafe(method(numberOfPreviewItemsInPreviewPanel:))]
            fn number_of_items(&self, _panel: Option<&QLPreviewPanel>) -> NSInteger {
                NSInteger::from(self.ivars().shown.borrow().is_some())
            }

            #[unsafe(method(previewPanel:previewItemAtIndex:))]
            fn item_at(&self, _panel: Option<&QLPreviewPanel>, _index: NSInteger) -> *mut NSURL {
                // NSURL is itself a QLPreviewItem (its title is the file name). `define_class!` cannot return a
                // `Retained`, so the (+0, as the protocol expects) reference is autoreleased by hand.
                match self.ivars().shown.borrow().as_ref() {
                    Some((_, url)) => Retained::autorelease_return(Retained::clone(url)),
                    None => std::ptr::null_mut(),
                }
            }
        }
    );

    impl Controller {
        fn new(mtm: MainThreadMarker, app: &AppHandle) -> Retained<Self> {
            let this = Self::alloc(mtm).set_ivars(Ivars { app: app.clone(), shown: RefCell::new(None) });
            // SAFETY: NSResponder's designated initializer.
            unsafe { msg_send![super(this), init] }
        }

        fn attach(&self, panel: &QLPreviewPanel) {
            let me: &AnyObject = self.as_ref();
            // SAFETY: the panel keeps neither unretained; the controller lives in `CONTROLLER` for the whole process.
            unsafe {
                panel.setDataSource(Some(ProtocolObject::from_ref(self)));
                panel.setDelegate(Some(me));
            }
        }

        fn shown_path(&self) -> Option<PathBuf> {
            self.ivars().shown.borrow().as_ref().map(|(p, _)| p.clone())
        }

        fn show(&self, path: &Path, url: Retained<NSURL>) {
            *self.ivars().shown.borrow_mut() = Some((path.to_path_buf(), url));
        }
    }

    thread_local! {
        /// Main thread only. Never dropped: the window's `nextResponder` link does not retain it.
        static CONTROLLER: RefCell<Option<Retained<Controller>>> = const { RefCell::new(None) };
    }

    fn controller(mtm: MainThreadMarker, app: &AppHandle) -> Retained<Controller> {
        CONTROLLER.with(|c| c.borrow_mut().get_or_insert_with(|| Controller::new(mtm, app)).clone())
    }

    /// Splices the controller into the window's responder chain (once per window; a rebuilt window gets it again).
    fn install(window: &NSWindow, ctl: &Controller) {
        let ctl_responder: &NSResponder = ctl;
        // SAFETY: main thread. `nextResponder` is unretained: the controller outlives every window (see `CONTROLLER`),
        // and the old link is only read back right here, while its owner is alive.
        unsafe {
            let next = window.nextResponder();
            if !next.as_deref().is_some_and(|r| std::ptr::eq(r, ctl_responder)) {
                ctl.setNextResponder(next.as_deref());
                window.setNextResponder(Some(ctl_responder));
            }
        }
    }

    /// How a toggle ended.
    pub enum Toggle {
        /// The panel is showing (true) or hidden (false) afterwards.
        Done(bool),
        /// No native panel can be shown (no window, odd path, no shared panel): the caller falls back to `qlmanage`.
        Unavailable,
        /// The main thread did not answer in time. The queued closure may still run, so no fallback may start.
        Unresponsive,
    }

    /// Runs `f` on the main thread and waits for its answer; `None` when it cannot run (event loop gone or stuck).
    fn on_main<T: Send + 'static>(
        app: &AppHandle,
        f: impl FnOnce(MainThreadMarker, &AppHandle) -> T + Send + 'static,
    ) -> Option<T> {
        let (tx, rx) = mpsc::channel();
        let handle = app.clone();
        app.run_on_main_thread(move || {
            if let Some(mtm) = MainThreadMarker::new() {
                let _ = tx.send(f(mtm, &handle));
            }
        })
        .ok()?;
        rx.recv_timeout(MAIN_THREAD_WAIT).ok()
    }

    pub fn toggle(app: &AppHandle, path: &Path) -> Toggle {
        let path = path.to_path_buf();
        match on_main(app, move |mtm, app| toggle_on_main(mtm, app, &path)) {
            Some(Some(open)) => Toggle::Done(open),
            Some(None) => Toggle::Unavailable,
            None => Toggle::Unresponsive,
        }
    }

    fn toggle_on_main(mtm: MainThreadMarker, app: &AppHandle, path: &Path) -> Option<bool> {
        let url = NSURL::fileURLWithPath(&NSString::from_str(path.to_str()?));
        let window = app.get_webview_window("main")?.ns_window().ok()?;
        // SAFETY: tao hands out its live NSWindow; we are on the main thread and only borrow it for this call.
        let window = unsafe { (window as *const NSWindow).as_ref() }?;
        // SAFETY: main thread.
        let panel = unsafe { QLPreviewPanel::sharedPreviewPanel(mtm) }?;
        let ctl = controller(mtm, app);
        install(window, &ctl);

        let showing = if panel.isVisible() { ctl.shown_path() } else { None };
        let open = match plan(showing.as_deref(), path) {
            Step::Close => {
                panel.orderOut(None);
                *ctl.ivars().shown.borrow_mut() = None;
                false
            }
            step => {
                // SAFETY: main thread. The panel adopts the controller through the responder chain; if it did not
                // (key window not ours yet), the data source is set by hand so the panel never shows nothing.
                unsafe {
                    panel.updateController();
                    // After the update: handing over control ends the previous session, which clears the shown item.
                    ctl.show(path, url);
                    let current = panel.currentController();
                    let ours = current.as_deref().is_some_and(|c| std::ptr::eq(c, AsRef::<AnyObject>::as_ref(&*ctl)));
                    if !ours {
                        ctl.attach(&panel);
                    }
                    panel.reloadData();
                }
                if step == Step::Open || !panel.isVisible() {
                    panel.makeKeyAndOrderFront(None);
                }
                true
            }
        };
        let _ = app.emit(EVENT, open);
        Some(open)
    }

    pub fn close(app: &AppHandle) {
        let _ = on_main(app, |mtm, app| {
            // SAFETY: main thread; never creates the panel just to hide it.
            if unsafe { QLPreviewPanel::sharedPreviewPanelExists(mtm) }
                && let Some(panel) = unsafe { QLPreviewPanel::sharedPreviewPanel(mtm) }
                && panel.isVisible()
            {
                panel.orderOut(None);
                *controller(mtm, app).ivars().shown.borrow_mut() = None;
            }
            let _ = app.emit(EVENT, false);
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_item_closes_other_item_swaps_hidden_panel_opens() {
        let a = Path::new("/tmp/a.txt");
        let b = Path::new("/tmp/b.txt");
        assert_eq!(plan(None, a), Step::Open);
        assert_eq!(plan(Some(a), a), Step::Close);
        assert_eq!(plan(Some(a), b), Step::Swap);
    }
}
