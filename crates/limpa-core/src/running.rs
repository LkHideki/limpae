use std::collections::HashSet;
use std::path::Path;

/// Bundle identifiers of applications currently running for this user.
///
/// Safe off the main thread: in objc2-app-kit 0.3 `NSWorkspace` is a plain `NSObject` subclass (not
/// `MainThreadOnly`), and `runningApplications` only reads process state.
pub fn running_bundle_ids() -> HashSet<String> {
    #[cfg(target_os = "macos")]
    {
        use objc2::rc::autoreleasepool;
        use objc2_app_kit::NSWorkspace;

        autoreleasepool(|_| {
            NSWorkspace::sharedWorkspace()
                .runningApplications()
                .iter()
                .filter_map(|a| a.bundleIdentifier())
                .map(|id| id.to_string())
                .collect()
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        HashSet::new()
    }
}

/// PNG bytes of the Finder icon of `path`, rendered at `px`×`px` pixels.
///
/// `iconForFile:` yields a multi-representation `NSImage` (up to 1024 px); asking for a CGImage of a `px`-sized rect
/// lets AppKit pick the closest representation, so the UI never receives a huge PNG for a thumbnail. Only
/// thread-safe image APIs are used (no views, nothing drawn into windows), so it is callable from a worker thread.
pub fn app_icon_png(path: &Path, px: u32) -> Option<Vec<u8>> {
    #[cfg(target_os = "macos")]
    {
        macos_icon::render(path, px)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (path, px);
        None
    }
}

#[cfg(target_os = "macos")]
mod macos_icon {
    use std::path::Path;
    use std::ptr;

    use objc2::AnyThread;
    use objc2::rc::autoreleasepool;
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSWorkspace};
    use objc2_core_foundation::{CFRetained, CGPoint, CGRect, CGSize};
    use objc2_core_graphics::{
        CGBitmapContextCreate, CGBitmapContextCreateImage, CGColorSpace, CGContext, CGImage, CGInterpolationQuality,
    };
    use objc2_foundation::{NSDictionary, NSPoint, NSRect, NSSize, NSString};

    /// `CGImageForProposedRect` only picks the best-fitting representation (it returns 256 px for a 128 px request on
    /// a Retina Mac), so an image of another size is redrawn into an exact `px`×`px` RGBA bitmap.
    fn fit(cg: CFRetained<CGImage>, px: usize) -> Option<CFRetained<CGImage>> {
        if CGImage::width(Some(&cg)) == px && CGImage::height(Some(&cg)) == px {
            return Some(cg);
        }
        let space = CGColorSpace::new_device_rgb()?;
        const PREMULTIPLIED_LAST: u32 = 1; // kCGImageAlphaPremultipliedLast
        // SAFETY: null `data` makes CoreGraphics allocate and own the pixel buffer; the arguments describe a valid
        // 8-bit RGBA layout.
        let ctx = unsafe { CGBitmapContextCreate(ptr::null_mut(), px, px, 8, 0, Some(&space), PREMULTIPLIED_LAST) }?;
        CGContext::set_interpolation_quality(Some(&ctx), CGInterpolationQuality::High);
        let dest = CGRect::new(CGPoint::new(0.0, 0.0), CGSize::new(px as f64, px as f64));
        CGContext::draw_image(Some(&ctx), dest, Some(&cg));
        CGBitmapContextCreateImage(Some(&ctx))
    }

    pub fn render(path: &Path, px: u32) -> Option<Vec<u8>> {
        if px == 0 || !path.exists() {
            return None;
        }
        autoreleasepool(|_| {
            let icon = NSWorkspace::sharedWorkspace().iconForFile(&NSString::from_str(path.to_str()?));
            let mut rect = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(f64::from(px), f64::from(px)));
            // SAFETY: `rect` is a valid, writable NSRect; context and hints are nil, which AppKit allows.
            let cg = unsafe { icon.CGImageForProposedRect_context_hints(&mut rect, None, None) }?;
            let cg = fit(CFRetained::from(cg), px as usize)?;
            let rep = NSBitmapImageRep::initWithCGImage(NSBitmapImageRep::alloc(), &cg);
            let props = NSDictionary::<_, AnyObject>::new();
            // SAFETY: an empty properties dictionary is valid for PNG output.
            let data = unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &props) }?;
            Some(data.to_vec())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn running_contains_finder_and_dock() {
        let ids = running_bundle_ids();
        assert!(ids.contains("com.apple.finder"), "{ids:?}");
        assert!(ids.contains("com.apple.dock"), "{ids:?}");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn running_works_off_main_thread() {
        let ids = std::thread::spawn(running_bundle_ids).join().unwrap();
        assert!(ids.contains("com.apple.finder"));
    }

    #[cfg(target_os = "macos")]
    fn assert_png_width(png: &[u8]) {
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        let w = u32::from_be_bytes(png[16..20].try_into().unwrap());
        assert!((64..=256).contains(&w), "width {w}");
        assert_eq!(w, 128, "icon must be rendered at the requested size");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn icon_png_is_requested_size() {
        let png = app_icon_png(Path::new("/System/Applications/Calculator.app"), 128).expect("icon");
        assert_png_width(&png);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn icon_png_works_off_main_thread() {
        let png = std::thread::spawn(|| app_icon_png(Path::new("/System/Applications/Calculator.app"), 128))
            .join()
            .unwrap()
            .expect("icon");
        assert_png_width(&png);
    }

    #[test]
    fn icon_missing_path_is_none() {
        assert!(app_icon_png(Path::new("/nonexistent/Nope.app"), 128).is_none());
    }
}
