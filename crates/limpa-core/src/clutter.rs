//! Files: duplicates, similar images, downloads by source app, locations.
//!
//! Safety model (same as `large.rs`): scanners only read. Every produced [`Item`] is a regular file that is
//! `MoveToTrash`, never pre-selected, found without following symlinks, without crossing devices and without
//! entering hidden entries, package bundles or `~/Library`. On an external volume the volume's reserved
//! top-level folders and Time Machine disks are skipped, so every item also passes `Guard::check`.

use std::collections::HashMap;
use std::ffi::OsString;
use std::fs::{self, File, Metadata};
use std::io::Read;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use rayon::prelude::*;

use crate::disk::disk_info;
use crate::large;
use crate::model::{Group, Item, Policy, Progress};
use crate::size::own_bytes;

/// Directories that are a single document or library to the user; never descended into.
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

/// Top-level entries of an external volume that hold system or backup state (mirrors `guard.rs`).
const VOLUME_RESERVED: &[&str] = &[
    "System",
    "Library",
    "private",
    "usr",
    "bin",
    "sbin",
    "Users",
    "Applications",
    "cores",
    ".Trashes",
    ".Spotlight-V100",
    ".fseventsd",
    ".DocumentRevisions-V100",
    ".TemporaryItems",
    ".MobileBackups",
    "Backups.backupdb",
];

const IMAGE_EXTS: &[&str] = &["jpg", "jpeg", "png", "heic", "heif", "tiff", "tif", "webp", "gif", "bmp"];

/// Leading bytes hashed before committing to a full-content hash.
const HEAD_BYTES: u64 = 64 * 1024;
const READ_CHUNK: usize = 256 * 1024;
/// Smallest allocation considered for similar images.
const IMAGE_MIN_BYTES: u64 = 100_000;
const IMAGE_MAX_CANDIDATES: usize = 5000;
/// Two images are "similar" when their dHashes differ in at most this many bits.
const MAX_HAMMING: u32 = 6;
/// Thumbnails whose brightest and darkest sampled pixels are closer than this carry no structure (blank or flat
/// images); their dHash would match every other flat image.
const MIN_CONTRAST: u8 = 8;

const NOTE_KEEPER_DUP: &str = "Original sugerido";
const NOTE_KEEPER_SIMILAR: &str = "Melhor qualidade";
const NO_APP: &str = "Outros";

// ---------------------------------------------------------------------------------------------------------------
// Walking
// ---------------------------------------------------------------------------------------------------------------

/// A regular file found by a walk.
#[derive(Debug, Clone)]
struct Cand {
    path: PathBuf,
    /// Allocated bytes (what removal frees).
    alloc: u64,
    /// Logical length; equal content implies equal length.
    len: u64,
    dev: u64,
    ino: u64,
    mtime: i64,
}

fn ext_lower(path: &Path) -> Option<String> {
    path.extension().map(|e| e.to_string_lossy().to_lowercase())
}

fn is_package(path: &Path) -> bool {
    ext_lower(path).is_some_and(|e| PACKAGE_EXTS.contains(&e.as_str()))
}

fn is_volume_root(root: &Path) -> bool {
    root.starts_with("/Volumes")
}

/// Time Machine destinations are never touched (the guard refuses them too).
fn is_backup_volume(root: &Path) -> bool {
    ["Backups.backupdb", ".timemachine", ".com.apple.timemachine.donotpresent"]
        .iter()
        .any(|m| fs::symlink_metadata(root.join(m)).is_ok())
}

/// iCloud placeholder (`SF_DATALESS`): reading it would download it.
fn is_dataless(md: &Metadata) -> bool {
    #[cfg(target_os = "macos")]
    {
        use std::os::macos::fs::MetadataExt as _;
        md.st_flags() & 0x4000_0000 != 0
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = md;
        false
    }
}

/// Whether `name` directly under the walk root must be skipped.
fn skip_top_level(name: &str, volume: bool) -> bool {
    name == "Library" || (volume && VOLUME_RESERVED.contains(&name))
}

/// Regular files under `root` that satisfy `accept`, with the `large.rs` rules: parallel, no symlinks, one device,
/// no hidden entries, no packages, no top-level `Library`. Cancelled → whatever was found so far (callers check).
fn walk_files(
    root: &Path,
    skip_top: bool,
    accept: &(dyn Fn(&Path, &Metadata) -> bool + Sync),
    p: &Progress,
) -> Vec<Cand> {
    let Ok(md) = fs::metadata(root) else { return Vec::new() };
    let volume = is_volume_root(root);
    if volume && is_backup_volume(root) {
        return Vec::new();
    }
    let found = AtomicU64::new(0);
    walk_dir(root, skip_top, volume, md.dev(), accept, &found, p)
}

fn walk_dir(
    dir: &Path,
    top: bool,
    volume: bool,
    dev: u64,
    accept: &(dyn Fn(&Path, &Metadata) -> bool + Sync),
    found: &AtomicU64,
    p: &Progress,
) -> Vec<Cand> {
    if p.cancelled() {
        return Vec::new();
    }
    p.report(dir, found.load(Ordering::Relaxed));
    let Ok(rd) = fs::read_dir(dir) else { return Vec::new() };
    let entries = crate::size::stat_entries(rd);
    entries
        .par_iter()
        .flat_map_iter(|(e, md)| {
            let name = e.file_name();
            let name = name.to_string_lossy();
            if md.dev() != dev || name.starts_with('.') || (top && skip_top_level(&name, volume)) {
                return Vec::new();
            }
            let path = e.path();
            if md.is_dir() {
                if is_package(&path) {
                    return Vec::new();
                }
                return walk_dir(&path, false, volume, dev, accept, found, p);
            }
            if !md.is_file() || is_dataless(md) || !accept(&path, md) {
                return Vec::new();
            }
            let alloc = own_bytes(md);
            found.fetch_add(alloc, Ordering::Relaxed);
            vec![Cand { path, alloc, len: md.len(), dev: md.dev(), ino: md.ino(), mtime: md.mtime() }]
        })
        .collect()
}

/// Keeps one path per inode: hard links of the same file are one file, not duplicates.
fn dedup_inodes(mut cands: Vec<Cand>) -> Vec<Cand> {
    cands.sort_by(|a, b| a.path.cmp(&b.path));
    let mut seen = std::collections::HashSet::new();
    cands.retain(|c| seen.insert((c.dev, c.ino)));
    cands
}

// ---------------------------------------------------------------------------------------------------------------
// Content hashing
// ---------------------------------------------------------------------------------------------------------------

/// BLAKE3 of the first `limit` bytes (or all of it). `None` when unreadable, vanished, swapped for a symlink or
/// cancelled.
fn hash_file(path: &Path, limit: Option<u64>, p: &Progress) -> Option<[u8; 32]> {
    // O_NOFOLLOW: a path swapped for a symlink after the walk is refused; O_NONBLOCK: a swapped FIFO can't hang us.
    let mut f = File::options().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK).open(path).ok()?;
    if !f.metadata().ok()?.is_file() {
        return None;
    }
    let mut hasher = blake3::Hasher::new();
    let mut buf = vec![0u8; READ_CHUNK];
    let mut left = limit.unwrap_or(u64::MAX);
    while left > 0 {
        if p.cancelled() {
            return None;
        }
        let want = buf.len().min(usize::try_from(left).unwrap_or(usize::MAX));
        let n = f.read(&mut buf[..want]).ok()?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        left -= n as u64;
    }
    Some(*hasher.finalize().as_bytes())
}

/// Splits `cands` (all with equal length) into sets of byte-identical files: head hash first, then full hash.
fn identical_sets(cands: Vec<Cand>, p: &Progress) -> Vec<Vec<Cand>> {
    let by_len = group_by(cands, |c| c.len);
    let multi: Vec<Vec<Cand>> = by_len.into_values().filter(|v| v.len() > 1).collect();
    multi
        .into_par_iter()
        .flat_map_iter(|set| {
            let heads = hashed(set, Some(HEAD_BYTES), p);
            heads
                .into_iter()
                .filter(|s| s.len() > 1)
                .flat_map(|s| hashed(s, None, p).into_iter().filter(|s| s.len() > 1))
                .collect::<Vec<_>>()
        })
        .collect()
}

/// Groups `set` by the hash of its first `limit` bytes; unreadable files drop out.
fn hashed(set: Vec<Cand>, limit: Option<u64>, p: &Progress) -> Vec<Vec<Cand>> {
    let tagged: Vec<([u8; 32], Cand)> = set
        .into_par_iter()
        .filter_map(|c| {
            let h = hash_file(&c.path, limit, p)?;
            p.report(&c.path, c.alloc);
            Some((h, c))
        })
        .collect();
    group_by(tagged, |(h, _)| *h).into_values().map(|v| v.into_iter().map(|(_, c)| c).collect()).collect()
}

fn group_by<T, K: std::hash::Hash + Eq>(items: Vec<T>, key: impl Fn(&T) -> K) -> HashMap<K, Vec<T>> {
    let mut m: HashMap<K, Vec<T>> = HashMap::new();
    for it in items {
        m.entry(key(&it)).or_default().push(it);
    }
    m
}

/// Decimal sizes, pt-BR separators ("1,2 GB"), like the UI's `fmtBytes`.
fn fmt_size(n: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut v = n as f64;
    let mut i = 0;
    while v >= 1000.0 && i < UNITS.len() - 1 {
        v /= 1000.0;
        i += 1;
    }
    let num = if i <= 1 || v >= 100.0 { format!("{v:.0}") } else { format!("{v:.1}").replace('.', ",") };
    format!("{num}\u{a0}{}", UNITS[i])
}

fn unselected_item(c: &Cand, note: Option<&str>) -> Item {
    let mut item = Item::new(c.path.clone(), c.alloc, Policy::MoveToTrash);
    item.selected = false;
    item.note = note.map(str::to_owned);
    item
}

// ---------------------------------------------------------------------------------------------------------------
// Duplicates
// ---------------------------------------------------------------------------------------------------------------

/// Suggested original: oldest modification time; tie → shortest path (then lexicographic, for determinism).
fn pick_original(set: &[Cand]) -> usize {
    (0..set.len())
        .min_by(|&a, &b| {
            let (x, y) = (&set[a], &set[b]);
            x.mtime
                .cmp(&y.mtime)
                .then_with(|| x.path.as_os_str().len().cmp(&y.path.as_os_str().len()))
                .then_with(|| x.path.cmp(&y.path))
        })
        .unwrap_or(0)
}

/// Sets of byte-identical files of at least `min_bytes` allocated under `root`, one [`Group`] per set (`dup-<n>`),
/// largest reclaimable space first. The suggested original is the first item, noted "Original sugerido".
pub fn duplicates(root: &Path, min_bytes: u64, p: &Progress) -> Vec<Group> {
    let cands = dedup_inodes(walk_files(root, true, &|_, md| own_bytes(md) >= min_bytes, p));
    if p.cancelled() {
        return Vec::new();
    }
    let mut sets = identical_sets(cands, p);
    if p.cancelled() {
        return Vec::new();
    }
    for s in &mut sets {
        let keep = pick_original(s);
        s.swap(0, keep);
        s[1..].sort_by(|a, b| a.mtime.cmp(&b.mtime).then_with(|| a.path.cmp(&b.path)));
    }
    // Most reclaimable first; path of the original breaks ties so the order is deterministic.
    sets.sort_by(|a, b| {
        let waste = |s: &Vec<Cand>| s[1..].iter().map(|c| c.alloc).sum::<u64>();
        waste(b).cmp(&waste(a)).then_with(|| a[0].path.cmp(&b[0].path))
    });
    sets.into_iter()
        .enumerate()
        .map(|(n, set)| {
            let title = set[0].path.file_name().map_or_else(String::new, |n| n.to_string_lossy().into_owned());
            let description = format!("{} cópias · {} cada", set.len(), fmt_size(set[0].alloc));
            let items =
                set.iter().enumerate().map(|(i, c)| unselected_item(c, (i == 0).then_some(NOTE_KEEPER_DUP))).collect();
            Group { id: format!("dup-{}", n + 1), title, description, items }
        })
        .collect()
}

// ---------------------------------------------------------------------------------------------------------------
// Similar images
// ---------------------------------------------------------------------------------------------------------------

/// Difference hash of a 9×8 grayscale buffer (row-major, 9 columns): bit `i` is set when a pixel is brighter than
/// its right neighbour. `None` for flat images.
pub fn dhash_gray(px: &[u8; 72]) -> Option<u64> {
    let (lo, hi) = px.iter().fold((u8::MAX, 0u8), |(lo, hi), &v| (lo.min(v), hi.max(v)));
    if hi - lo < MIN_CONTRAST {
        return None;
    }
    let mut h = 0u64;
    for row in 0..8 {
        for col in 0..8 {
            h <<= 1;
            if px[row * 9 + col] > px[row * 9 + col + 1] {
                h |= 1;
            }
        }
    }
    Some(h)
}

pub fn hamming(a: u64, b: u64) -> u32 {
    (a ^ b).count_ones()
}

struct UnionFind(Vec<usize>);

impl UnionFind {
    fn new(n: usize) -> Self {
        Self((0..n).collect())
    }

    fn find(&mut self, mut x: usize) -> usize {
        while self.0[x] != x {
            self.0[x] = self.0[self.0[x]];
            x = self.0[x];
        }
        x
    }

    fn union(&mut self, a: usize, b: usize) {
        let (a, b) = (self.find(a), self.find(b));
        if a != b {
            self.0[b.max(a)] = b.min(a);
        }
    }
}

/// Indices of `hashes` grouped into clusters (size ≥ 2) whose members chain within [`MAX_HAMMING`] bits.
fn cluster(hashes: &[u64]) -> Vec<Vec<usize>> {
    let mut uf = UnionFind::new(hashes.len());
    for i in 0..hashes.len() {
        for j in i + 1..hashes.len() {
            if hamming(hashes[i], hashes[j]) <= MAX_HAMMING {
                uf.union(i, j);
            }
        }
    }
    let mut by_root: HashMap<usize, Vec<usize>> = HashMap::new();
    for i in 0..hashes.len() {
        let r = uf.find(i);
        by_root.entry(r).or_default().push(i);
    }
    let mut out: Vec<Vec<usize>> = by_root.into_values().filter(|v| v.len() > 1).collect();
    out.sort();
    out
}

/// Groups of visually similar (but not byte-identical) images under `root`, one [`Group`] per cluster (`sim-<n>`).
/// The first item is the suggested keeper (most pixels, then newest), noted "Melhor qualidade". Runs ImageIO, so
/// call it off the main thread.
pub fn similar_images(root: &Path, p: &Progress) -> Vec<Group> {
    let is_image = |path: &Path, md: &Metadata| own_bytes(md) > IMAGE_MIN_BYTES && is_image_path(path);
    let mut cands = dedup_inodes(walk_files(root, true, &is_image, p));
    if p.cancelled() {
        return Vec::new();
    }
    cands.sort_by(|a, b| b.alloc.cmp(&a.alloc).then_with(|| a.path.cmp(&b.path)));
    cands.truncate(IMAGE_MAX_CANDIDATES);

    let hashed: Vec<(Cand, u64, u64)> = cands
        .into_par_iter()
        .filter_map(|c| {
            if p.cancelled() {
                return None;
            }
            p.report(&c.path, c.alloc);
            let (hash, area) = image_hash(&c.path)?;
            Some((c, hash, area))
        })
        .collect();
    if p.cancelled() {
        return Vec::new();
    }
    let mut hashed = hashed;
    hashed.sort_by(|a, b| a.0.path.cmp(&b.0.path));
    let hashes: Vec<u64> = hashed.iter().map(|h| h.1).collect();

    let mut groups: Vec<(u64, Vec<(Cand, u64)>)> = Vec::new();
    for members in cluster(&hashes) {
        if p.cancelled() {
            return Vec::new();
        }
        let members: Vec<(Cand, u64)> = members.into_iter().map(|i| (hashed[i].0.clone(), hashed[i].2)).collect();
        // Byte-identical files belong to the duplicates view: keep one of each.
        let distinct = collapse_identical(members, p);
        if distinct.len() > 1 {
            let total = distinct.iter().map(|(c, _)| c.alloc).sum();
            groups.push((total, distinct));
        }
    }
    groups.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1[0].0.path.cmp(&b.1[0].0.path)));
    groups
        .into_iter()
        .enumerate()
        .map(|(n, (_, mut members))| {
            // Keeper: most pixels, then newest, then shortest path.
            members.sort_by(|a, b| {
                b.1.cmp(&a.1)
                    .then_with(|| b.0.mtime.cmp(&a.0.mtime))
                    .then_with(|| a.0.path.as_os_str().len().cmp(&b.0.path.as_os_str().len()))
                    .then_with(|| a.0.path.cmp(&b.0.path))
            });
            let title = members[0].0.path.file_name().map_or_else(String::new, |n| n.to_string_lossy().into_owned());
            let description = format!("{} imagens parecidas", members.len());
            let items = members
                .iter()
                .enumerate()
                .map(|(i, (c, _))| unselected_item(c, (i == 0).then_some(NOTE_KEEPER_SIMILAR)))
                .collect();
            Group { id: format!("sim-{}", n + 1), title, description, items }
        })
        .collect()
}

/// One member per set of byte-identical files (the first by path).
fn collapse_identical(members: Vec<(Cand, u64)>, p: &Progress) -> Vec<(Cand, u64)> {
    let cands: Vec<Cand> = members.iter().map(|(c, _)| c.clone()).collect();
    let mut drop: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
    for mut set in identical_sets(cands, p) {
        set.sort_by(|a, b| a.path.cmp(&b.path));
        drop.extend(set.into_iter().skip(1).map(|c| c.path));
    }
    members.into_iter().filter(|(c, _)| !drop.contains(&c.path)).collect()
}

/// (dHash, pixel area) of an image file; `None` when ImageIO can't decode it or it is flat.
fn image_hash(path: &Path) -> Option<(u64, u64)> {
    #[cfg(target_os = "macos")]
    {
        macos_image::hash(path)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        None
    }
}

/// Whether `path` has an image extension that the similar-images scan and thumbnails handle.
pub fn is_image_path(path: &Path) -> bool {
    ext_lower(path).is_some_and(|e| IMAGE_EXTS.contains(&e.as_str()))
}

/// PNG bytes of a thumbnail of the image at `path`, at most `max_px` pixels on the longest side (ImageIO).
pub fn thumbnail_png(path: &Path, max_px: u32) -> Option<Vec<u8>> {
    #[cfg(target_os = "macos")]
    {
        macos_image::thumbnail_png(path, max_px)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (path, max_px);
        None
    }
}

#[cfg(target_os = "macos")]
mod macos_image {
    use std::path::Path;

    use objc2::AnyThread;
    use objc2::rc::autoreleasepool;
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep};
    use objc2_core_foundation::{
        CFBoolean, CFDictionary, CFNumber, CFRetained, CFString, CFType, CFURL, CGPoint, CGRect, CGSize,
    };
    use objc2_core_graphics::{CGBitmapContextCreate, CGColorSpace, CGContext, CGImage, CGInterpolationQuality};
    use objc2_foundation::NSDictionary;
    use objc2_image_io::{
        CGImageSource, kCGImagePropertyPixelHeight, kCGImagePropertyPixelWidth,
        kCGImageSourceCreateThumbnailFromImageAlways, kCGImageSourceCreateThumbnailWithTransform,
        kCGImageSourceShouldCache, kCGImageSourceThumbnailMaxPixelSize,
    };

    use super::dhash_gray;

    fn source(path: &Path) -> Option<CFRetained<CGImageSource>> {
        let url = CFURL::from_file_path(path)?;
        let no_cache = CFBoolean::new(false);
        let opts = CFDictionary::<CFString, CFType>::from_slices(
            &[unsafe { kCGImageSourceShouldCache }],
            &[no_cache.as_ref()],
        );
        // SAFETY: `opts` has CFString keys and CFType values, as ImageIO expects.
        unsafe { CGImageSource::with_url(&url, Some(opts.as_ref())) }
    }

    /// Thumbnail with EXIF orientation applied, rendered from the full image (not an embedded preview).
    fn thumbnail(src: &CGImageSource, max_px: u32) -> Option<CFRetained<CGImage>> {
        let yes = CFBoolean::new(true);
        let size = CFNumber::new_i32(i32::try_from(max_px).ok()?);
        // SAFETY: the extern statics are valid CFStrings for the lifetime of the process.
        let keys = unsafe {
            [
                kCGImageSourceCreateThumbnailFromImageAlways,
                kCGImageSourceCreateThumbnailWithTransform,
                kCGImageSourceThumbnailMaxPixelSize,
            ]
        };
        let opts = CFDictionary::<CFString, CFType>::from_slices(&keys, &[yes.as_ref(), yes.as_ref(), size.as_ref()]);
        // SAFETY: `opts` has CFString keys and CFType values, as ImageIO expects.
        unsafe { src.thumbnail_at_index(0, Some(opts.as_ref())) }
    }

    fn pixel_area(src: &CGImageSource) -> u64 {
        // SAFETY: no options; the result is a CFDictionary with CFString keys and CF values.
        let Some(props) = (unsafe { src.properties_at_index(0, None) }) else { return 0 };
        // SAFETY: ImageIO property dictionaries are keyed by CFString and hold CFNumber for the pixel sizes.
        let props = unsafe { CFRetained::cast_unchecked::<CFDictionary<CFString, CFNumber>>(props) };
        let dim = |key: &'static CFString| props.get(key).and_then(|n| n.as_i64()).unwrap_or(0).max(0) as u64;
        // SAFETY: extern statics, valid for the process lifetime.
        let (w, h) = unsafe { (dim(kCGImagePropertyPixelWidth), dim(kCGImagePropertyPixelHeight)) };
        w * h
    }

    pub fn hash(path: &Path) -> Option<(u64, u64)> {
        autoreleasepool(|_| {
            let src = source(path)?;
            let thumb = thumbnail(&src, 64)?;
            let gray = gray_9x8(&thumb)?;
            Some((dhash_gray(&gray)?, pixel_area(&src)))
        })
    }

    /// Draws `img` scaled into a 9×8 8-bit grayscale bitmap.
    fn gray_9x8(img: &CGImage) -> Option<[u8; 72]> {
        let mut buf = [0u8; 72];
        let space = CGColorSpace::new_device_gray()?;
        // SAFETY: `buf` outlives the context (dropped before returning) and holds 8 rows of 9 one-byte pixels, which
        // is exactly what the width, height, bits-per-component and bytes-per-row below describe.
        let ctx = unsafe { CGBitmapContextCreate(buf.as_mut_ptr().cast(), 9, 8, 8, 9, Some(&space), 0) }?;
        CGContext::set_interpolation_quality(Some(&ctx), CGInterpolationQuality::High);
        CGContext::draw_image(Some(&ctx), CGRect::new(CGPoint::new(0.0, 0.0), CGSize::new(9.0, 8.0)), Some(img));
        drop(ctx);
        Some(buf)
    }

    pub fn thumbnail_png(path: &Path, max_px: u32) -> Option<Vec<u8>> {
        autoreleasepool(|_| {
            let src = source(path)?;
            let thumb = thumbnail(&src, max_px)?;
            let rep = NSBitmapImageRep::initWithCGImage(NSBitmapImageRep::alloc(), &thumb);
            let props = NSDictionary::<_, AnyObject>::new();
            // SAFETY: an empty properties dictionary is valid for PNG output.
            let data = unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &props) }?;
            Some(data.to_vec())
        })
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Downloads by source app
// ---------------------------------------------------------------------------------------------------------------

/// Agent name of a `com.apple.quarantine` value (`flags;hex-time;Agent Name;UUID`); `None` when absent or empty.
pub fn parse_quarantine(value: &str) -> Option<String> {
    let name = unescape_hex(value.split(';').nth(2)?);
    let name: String = name.trim().chars().filter(|c| !c.is_control()).collect();
    (!name.is_empty()).then_some(name)
}

/// The system writes some agent names with `\xNN` escapes (`App\x20Web`).
fn unescape_hex(s: &str) -> String {
    let mut out = Vec::with_capacity(s.len());
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        let hex = (b[i] == b'\\' && b.get(i + 1) == Some(&b'x'))
            .then(|| s.get(i + 2..i + 4).and_then(|h| u8::from_str_radix(h, 16).ok()))
            .flatten();
        match hex {
            Some(v) => {
                out.push(v);
                i += 4;
            }
            None => {
                out.push(b[i]);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Source app recorded by the system when `path` was downloaded; the xattr is read without following symlinks.
fn quarantine_app(path: &Path) -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        let c = CString::new(path.as_os_str().as_bytes()).ok()?;
        let mut buf = [0u8; 1024];
        // SAFETY: `c` and the attribute name are NUL-terminated; `buf` is writable for `buf.len()` bytes.
        let n = unsafe {
            libc::getxattr(
                c.as_ptr(),
                c"com.apple.quarantine".as_ptr(),
                buf.as_mut_ptr().cast(),
                buf.len(),
                0,
                libc::XATTR_NOFOLLOW,
            )
        };
        let n = usize::try_from(n).ok().filter(|&n| n > 0)?;
        parse_quarantine(&String::from_utf8_lossy(&buf[..n.min(buf.len())]))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        None
    }
}

/// Files under `~/Downloads`, one [`Group`] per source app (`dl-<n>`, by total size; unknown source → "Outros").
pub fn downloads(home: &Path, p: &Progress) -> Vec<Group> {
    let dir = home.join("Downloads");
    // A symlinked Downloads folder would point the walk (and removal) somewhere else.
    if !fs::symlink_metadata(&dir).is_ok_and(|m| m.is_dir()) {
        return Vec::new();
    }
    let files = walk_files(&dir, false, &|_, md| own_bytes(md) > 0, p);
    if p.cancelled() {
        return Vec::new();
    }
    let tagged: Vec<(String, Cand)> =
        files.into_par_iter().map(|c| (quarantine_app(&c.path).unwrap_or_else(|| NO_APP.to_owned()), c)).collect();
    let mut apps: Vec<(String, Vec<Cand>)> = group_by(tagged, |(app, _)| app.clone())
        .into_iter()
        .map(|(app, v)| (app, v.into_iter().map(|(_, c)| c).collect()))
        .collect();
    let total = |v: &Vec<Cand>| v.iter().map(|c| c.alloc).sum::<u64>();
    apps.sort_by(|a, b| total(&b.1).cmp(&total(&a.1)).then_with(|| a.0.cmp(&b.0)));
    apps.into_iter()
        .enumerate()
        .map(|(n, (app, mut v))| {
            v.sort_by(|a, b| b.alloc.cmp(&a.alloc).then_with(|| a.path.cmp(&b.path)));
            let count = v.len();
            let description = format!("{count} {}", if count == 1 { "arquivo" } else { "arquivos" });
            Group {
                id: format!("dl-{}", n + 1),
                title: app,
                description,
                items: v.iter().map(|c| unselected_item(c, None)).collect(),
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------------------------------------------
// Locations and Large and old
// ---------------------------------------------------------------------------------------------------------------

/// (name, root, free bytes, total bytes) of the places that can be scanned: the home folder, then every mounted
/// volume under `/Volumes` except the boot disk's alias and Time Machine disks.
pub fn volumes() -> Vec<(String, PathBuf, u64, u64)> {
    let Some(home) = std::env::home_dir() else { return Vec::new() };
    volumes_in(&home, Path::new("/Volumes"))
}

pub fn volumes_in(home: &Path, volumes_dir: &Path) -> Vec<(String, PathBuf, u64, u64)> {
    let mut out = Vec::new();
    if let Ok(d) = disk_info(home) {
        out.push(("Pasta pessoal".to_owned(), home.to_path_buf(), d.free, d.total));
    }
    let boot_dev = fs::metadata("/").map(|m| m.dev()).ok();
    let Ok(rd) = fs::read_dir(volumes_dir) else { return out };
    let mut vols: Vec<(OsString, PathBuf)> = rd.filter_map(Result::ok).map(|e| (e.file_name(), e.path())).collect();
    vols.sort();
    for (name, path) in vols {
        // The boot volume shows up as a symlink to "/".
        let Ok(real) = fs::canonicalize(&path) else { continue };
        let Ok(md) = fs::metadata(&real) else { continue };
        if real == Path::new("/") || !md.is_dir() || Some(md.dev()) == boot_dev || is_backup_volume(&real) {
            continue;
        }
        if name.to_string_lossy().starts_with('.') {
            continue;
        }
        if let Ok(d) = disk_info(&real) {
            out.push((name.to_string_lossy().into_owned(), path, d.free, d.total));
        }
    }
    out
}

/// Large and old for any location: `large::scan_large`, minus the reserved top-level folders of an external volume
/// (the guard would refuse them).
pub fn large_old(root: &Path, min_bytes: u64, p: &Progress) -> Vec<Group> {
    let groups = large::scan_large(root, min_bytes, p);
    if !is_volume_root(root) {
        return groups;
    }
    if is_backup_volume(root) {
        return Vec::new();
    }
    groups
        .into_iter()
        .filter_map(|mut g| {
            g.items.retain(|i| {
                let first = i.path.strip_prefix(root).ok().and_then(|r| r.components().next());
                first.is_some_and(|c| !VOLUME_RESERVED.iter().any(|r| c.as_os_str() == *r))
            });
            (!g.items.is_empty()).then_some(g)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::guard::Guard;
    use std::io::Write;
    use std::sync::Arc;
    use std::sync::atomic::AtomicBool;

    fn fake_home() -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let home = fs::canonicalize(tmp.path()).unwrap().join("home");
        fs::create_dir_all(&home).unwrap();
        (tmp, home)
    }

    fn write_bytes(path: &Path, data: &[u8]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut f = fs::File::create(path).unwrap();
        f.write_all(data).unwrap();
        f.sync_all().unwrap();
    }

    /// `n` bytes of a repeating pattern keyed by `seed`.
    fn pattern(seed: u8, n: usize) -> Vec<u8> {
        (0..n).map(|i| seed.wrapping_add((i % 251) as u8)).collect()
    }

    fn set_mtime(path: &Path, secs: i64) {
        let f = fs::File::options().write(true).open(path).unwrap();
        f.set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(secs as u64)).unwrap();
    }

    fn assert_guard_ok(home: &Path, groups: &[Group]) {
        let guard = Guard::new(home);
        for item in groups.iter().flat_map(|g| &g.items) {
            assert!(guard.check(&item.path, &item.policy).is_ok(), "guard rejects {:?}", item.path);
            assert!(!item.selected, "{:?} is pre-selected", item.path);
            assert_eq!(item.policy, Policy::MoveToTrash);
        }
    }

    fn names(g: &Group) -> Vec<String> {
        g.items.iter().map(|i| i.name.clone()).collect()
    }

    // ---- duplicates ----

    #[test]
    fn finds_identical_files_not_same_size_different_content() {
        let (_t, home) = fake_home();
        let a = pattern(1, 150_000);
        let mut b = a.clone();
        *b.last_mut().unwrap() ^= 0xff; // differs only in the tail: head hash equal, full hash differs
        let mut c = a.clone();
        c[10] ^= 0xff; // differs inside the head
        write_bytes(&home.join("Documents/a.bin"), &a);
        write_bytes(&home.join("Documents/copy of a.bin"), &a);
        write_bytes(&home.join("Other/a2.bin"), &a);
        write_bytes(&home.join("Documents/b.bin"), &b);
        write_bytes(&home.join("Documents/c.bin"), &c);
        write_bytes(&home.join("Documents/small1.bin"), &pattern(9, 1000));
        write_bytes(&home.join("Documents/small2.bin"), &pattern(9, 1000));
        let groups = duplicates(&home, 100_000, &Progress::silent());
        assert_guard_ok(&home, &groups);
        assert_eq!(groups.len(), 1, "{:?}", groups.iter().map(names).collect::<Vec<_>>());
        let g = &groups[0];
        assert_eq!(g.id, "dup-1");
        assert_eq!(g.items.len(), 3);
        let mut n = names(g);
        n.sort();
        assert_eq!(n, ["a.bin", "a2.bin", "copy of a.bin"]);
        assert!(g.description.starts_with("3 cópias · "), "{}", g.description);
        assert!(g.description.ends_with(" cada"));
    }

    #[test]
    fn hard_links_are_not_duplicates() {
        let (_t, home) = fake_home();
        let data = pattern(3, 200_000);
        write_bytes(&home.join("a.bin"), &data);
        fs::hard_link(home.join("a.bin"), home.join("b.bin")).unwrap();
        assert!(duplicates(&home, 100_000, &Progress::silent()).is_empty());
        // A real copy next to the linked pair is a duplicate of one inode only.
        write_bytes(&home.join("c.bin"), &data);
        let groups = duplicates(&home, 100_000, &Progress::silent());
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].items.len(), 2);
    }

    #[test]
    fn keeper_is_oldest_then_shortest_path() {
        let (_t, home) = fake_home();
        let data = pattern(5, 120_000);
        for p in ["new/file.bin", "old/deep/er/file.bin", "old/file.bin", "mid/file.bin"] {
            write_bytes(&home.join(p), &data);
        }
        set_mtime(&home.join("new/file.bin"), 3_000_000);
        set_mtime(&home.join("mid/file.bin"), 2_000_000);
        // Two oldest tie on mtime; the shorter path wins.
        set_mtime(&home.join("old/deep/er/file.bin"), 1_000_000);
        set_mtime(&home.join("old/file.bin"), 1_000_000);
        let groups = duplicates(&home, 100_000, &Progress::silent());
        let g = &groups[0];
        assert_eq!(g.items[0].path, home.join("old/file.bin"));
        assert_eq!(g.items[0].note.as_deref(), Some("Original sugerido"));
        assert!(g.items[1..].iter().all(|i| i.note.is_none()));
        assert_eq!(g.items.iter().filter(|i| i.note.is_some()).count(), 1);
    }

    #[test]
    fn groups_ordered_by_reclaimable_space() {
        let (_t, home) = fake_home();
        let small = pattern(1, 120_000);
        let big = pattern(2, 600_000);
        write_bytes(&home.join("s1.bin"), &small);
        write_bytes(&home.join("s2.bin"), &small);
        write_bytes(&home.join("b1.bin"), &big);
        write_bytes(&home.join("b2.bin"), &big);
        let groups = duplicates(&home, 100_000, &Progress::silent());
        assert_eq!(groups.len(), 2);
        assert!(groups[0].items[0].name.starts_with('b'));
        assert_eq!((groups[0].id.as_str(), groups[1].id.as_str()), ("dup-1", "dup-2"));
    }

    #[test]
    fn duplicates_skip_library_hidden_packages_and_symlinks() {
        let (_t, home) = fake_home();
        let data = pattern(4, 150_000);
        write_bytes(&home.join("Documents/x.bin"), &data);
        write_bytes(&home.join("Library/Caches/x.bin"), &data);
        write_bytes(&home.join(".hidden/x.bin"), &data);
        write_bytes(&home.join("Documents/.dot.bin"), &data);
        write_bytes(&home.join("Foo.app/Contents/x.bin"), &data);
        write_bytes(&home.join("Photos.photoslibrary/x.bin"), &data);
        let outside = tempfile::tempdir().unwrap();
        write_bytes(&outside.path().join("out.bin"), &data);
        std::os::unix::fs::symlink(outside.path(), home.join("linkdir")).unwrap();
        std::os::unix::fs::symlink(outside.path().join("out.bin"), home.join("link.bin")).unwrap();
        assert!(duplicates(&home, 100_000, &Progress::silent()).is_empty());
        write_bytes(&home.join("Documents/Sub/Library/y.bin"), &data);
        let groups = duplicates(&home, 100_000, &Progress::silent());
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].items.len(), 2, "only nested Library is walked");
        assert_guard_ok(&home, &groups);
    }

    #[test]
    fn duplicates_honor_cancel_and_report_progress() {
        let (_t, home) = fake_home();
        let data = pattern(6, 150_000);
        write_bytes(&home.join("a/x.bin"), &data);
        write_bytes(&home.join("b/x.bin"), &data);
        let calls = Arc::new(AtomicU64::new(0));
        let c = calls.clone();
        let p = Progress::new(Arc::new(AtomicBool::new(false)), move |_, _| {
            c.fetch_add(1, Ordering::Relaxed);
        });
        assert_eq!(duplicates(&home, 100_000, &p).len(), 1);
        assert!(calls.load(Ordering::Relaxed) >= 3);
        let cancelled = Progress::new(Arc::new(AtomicBool::new(true)), |_, _| {});
        assert!(duplicates(&home, 100_000, &cancelled).is_empty());
        assert!(similar_images(&home, &cancelled).is_empty());
        assert!(downloads(&home, &cancelled).is_empty());
    }

    // ---- hashing helpers ----

    #[test]
    fn dhash_orders_bits_and_rejects_flat_images() {
        let mut ramp = [0u8; 72];
        for r in 0..8 {
            for c in 0..9 {
                ramp[r * 9 + c] = (c * 20) as u8; // rising → never brighter than the right neighbour
            }
        }
        assert_eq!(dhash_gray(&ramp), Some(0));
        let mut fall = ramp;
        for r in 0..8 {
            for c in 0..9 {
                fall[r * 9 + c] = (200 - c * 20) as u8; // falling → every bit set
            }
        }
        assert_eq!(dhash_gray(&fall), Some(u64::MAX));
        assert_eq!(dhash_gray(&[128u8; 72]), None);
        assert_eq!(hamming(0, u64::MAX), 64);
        assert_eq!(hamming(0b1011, 0b0010), 2);
    }

    #[test]
    fn clustering_chains_within_threshold_and_splits_beyond() {
        let a = 0u64;
        let near = 0b11_1111u64; // distance 6 from a
        let far = 0b111_1111u64; // distance 7 from a, 1 from near
        let unrelated = u64::MAX;
        let c = cluster(&[a, near, unrelated]);
        assert_eq!(c, vec![vec![0, 1]]);
        // union-find chains: far joins through near even though d(a, far) = 7
        let c = cluster(&[a, near, far]);
        assert_eq!(c, vec![vec![0, 1, 2]]);
    }

    // ---- similar images (real ImageIO) ----

    /// 24-bit uncompressed BMP of `w`×`h` with `shade(x, y)` in 0..=255 (normalized coordinates in 0..1).
    fn write_bmp(path: &Path, w: u32, h: u32, shade: impl Fn(f32, f32) -> u8) {
        let row = (w * 3).div_ceil(4) * 4;
        let size = 54 + row * h;
        let mut b = Vec::with_capacity(size as usize);
        b.extend_from_slice(b"BM");
        b.extend_from_slice(&size.to_le_bytes());
        b.extend_from_slice(&[0, 0, 0, 0]);
        b.extend_from_slice(&54u32.to_le_bytes());
        b.extend_from_slice(&40u32.to_le_bytes());
        b.extend_from_slice(&w.to_le_bytes());
        b.extend_from_slice(&h.to_le_bytes());
        b.extend_from_slice(&1u16.to_le_bytes());
        b.extend_from_slice(&24u16.to_le_bytes());
        b.extend_from_slice(&[0; 24]);
        for y in (0..h).rev() {
            // bottom-up rows
            for x in 0..w {
                let v = shade(x as f32 / w as f32, y as f32 / h as f32);
                b.extend_from_slice(&[v, v, v]);
            }
            b.resize(b.len() + (row - w * 3) as usize, 0);
        }
        write_bytes(path, &b);
    }

    fn scene_a(x: f32, y: f32) -> u8 {
        let d = ((x - 0.3).powi(2) + (y - 0.4).powi(2)).sqrt();
        if d < 0.2 { 240 } else { (40.0 + 120.0 * x) as u8 }
    }

    fn scene_b(x: f32, y: f32) -> u8 {
        // Different structure: bright band on the right, vertical stripes
        if x > 0.7 { 30 } else { (60.0 + 150.0 * ((x * 9.0).sin() * 0.5 + 0.5) * (1.0 - y)) as u8 }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn similar_images_group_resized_copies_and_keep_best_quality() {
        let (_t, home) = fake_home();
        write_bmp(&home.join("Pictures/a_big.bmp"), 640, 480, scene_a);
        write_bmp(&home.join("Pictures/a_small.bmp"), 480, 360, scene_a);
        write_bmp(&home.join("Pictures/b.bmp"), 640, 480, scene_b);
        write_bmp(&home.join("Pictures/flat1.bmp"), 640, 480, |_, _| 90);
        write_bmp(&home.join("Pictures/flat2.bmp"), 600, 450, |_, _| 90);
        // Byte-identical copy of a_big: belongs to duplicates, not here.
        fs::copy(home.join("Pictures/a_big.bmp"), home.join("Pictures/a_big_copy.bmp")).unwrap();
        // Tiny image below the size floor.
        write_bmp(&home.join("Pictures/tiny.bmp"), 40, 30, scene_a);
        let groups = similar_images(&home, &Progress::silent());
        assert_guard_ok(&home, &groups);
        assert_eq!(groups.len(), 1, "{:?}", groups.iter().map(names).collect::<Vec<_>>());
        let g = &groups[0];
        assert_eq!(g.id, "sim-1");
        assert_eq!(g.items.len(), 2, "{:?}", names(g));
        assert_eq!(g.items[0].name, "a_big.bmp");
        assert_eq!(g.items[0].note.as_deref(), Some("Melhor qualidade"));
        assert_eq!(g.items[1].name, "a_small.bmp");
        assert!(g.items[1].note.is_none());
        assert_eq!(g.description, "2 imagens parecidas");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn image_hash_is_stable_across_sizes_and_differs_across_scenes() {
        let (_t, home) = fake_home();
        write_bmp(&home.join("a1.bmp"), 640, 480, scene_a);
        write_bmp(&home.join("a2.bmp"), 320, 240, scene_a);
        write_bmp(&home.join("b.bmp"), 640, 480, scene_b);
        let (a1, area1) = image_hash(&home.join("a1.bmp")).unwrap();
        let (a2, area2) = image_hash(&home.join("a2.bmp")).unwrap();
        let (b, _) = image_hash(&home.join("b.bmp")).unwrap();
        assert_eq!((area1, area2), (640 * 480, 320 * 240));
        assert!(hamming(a1, a2) <= MAX_HAMMING, "{}", hamming(a1, a2));
        assert!(hamming(a1, b) > MAX_HAMMING, "{}", hamming(a1, b));
        assert!(image_hash(&home.join("missing.bmp")).is_none());
        write_bytes(&home.join("notimage.bmp"), &pattern(1, 5000));
        assert!(image_hash(&home.join("notimage.bmp")).is_none());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn thumbnail_png_is_bounded() {
        let (_t, home) = fake_home();
        write_bmp(&home.join("a.bmp"), 640, 480, scene_a);
        let png = thumbnail_png(&home.join("a.bmp"), 160).unwrap();
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        let w = u32::from_be_bytes(png[16..20].try_into().unwrap());
        let h = u32::from_be_bytes(png[20..24].try_into().unwrap());
        assert_eq!((w, h), (160, 120));
        assert!(thumbnail_png(&home.join("nope.bmp"), 160).is_none());
    }

    // ---- downloads ----

    #[test]
    fn parses_quarantine_values() {
        let id = "01C9B2A2-5E4B-4C1E-8C5E-1F3A6C0D7A11";
        assert_eq!(parse_quarantine(&format!("0083;5f3e1a2b;Google Chrome;{id}")).as_deref(), Some("Google Chrome"));
        assert_eq!(parse_quarantine(&format!("0081;67a1b2c3;Safari;{id}")).as_deref(), Some("Safari"));
        assert_eq!(parse_quarantine("0083;5f3e1a2b;Slack;").as_deref(), Some("Slack"));
        assert_eq!(parse_quarantine("0083;5f3e1a2b;  Telegram \n;x").as_deref(), Some("Telegram"));
        assert_eq!(parse_quarantine("0083;5f3e1a2b;App\\x20Web;x").as_deref(), Some("App Web"));
        assert_eq!(parse_quarantine("0083;5f3e1a2b;Bad\\xZZ;x").as_deref(), Some("Bad\\xZZ"));
        assert_eq!(parse_quarantine("0083;5f3e1a2b;;x"), None);
        assert_eq!(parse_quarantine("0083;5f3e1a2b"), None);
        assert_eq!(parse_quarantine(""), None);
    }

    #[cfg(target_os = "macos")]
    fn set_quarantine(path: &Path, value: &str) {
        use std::os::unix::ffi::OsStrExt;
        let c = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
        // SAFETY: valid NUL-terminated strings and a readable value buffer of the given length.
        let rc = unsafe {
            libc::setxattr(c.as_ptr(), c"com.apple.quarantine".as_ptr(), value.as_ptr().cast(), value.len(), 0, 0)
        };
        assert_eq!(rc, 0, "{}", std::io::Error::last_os_error());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn downloads_group_by_source_app() {
        let (_t, home) = fake_home();
        let d = home.join("Downloads");
        write_bytes(&d.join("a.zip"), &pattern(1, 50_000));
        write_bytes(&d.join("sub/b.dmg"), &pattern(2, 90_000));
        write_bytes(&d.join("c.pdf"), &pattern(3, 20_000));
        write_bytes(&d.join("d.txt"), &pattern(4, 10_000));
        write_bytes(&d.join(".hidden"), &pattern(5, 10_000));
        write_bytes(&d.join("Foo.app/x"), &pattern(5, 10_000));
        write_bytes(&home.join("Documents/outside.zip"), &pattern(6, 10_000));
        set_quarantine(&d.join("a.zip"), "0083;5f3e1a2b;Google Chrome;ABC");
        set_quarantine(&d.join("sub/b.dmg"), "0083;5f3e1a2b;Google Chrome;DEF");
        set_quarantine(&d.join("c.pdf"), "0081;5f3e1a2b;Slack;GHI");
        let groups = downloads(&home, &Progress::silent());
        assert_guard_ok(&home, &groups);
        let titles: Vec<_> = groups.iter().map(|g| g.title.as_str()).collect();
        assert_eq!(titles, ["Google Chrome", "Slack", "Outros"]);
        assert_eq!(names(&groups[0]), ["b.dmg", "a.zip"]);
        assert_eq!(groups[0].description, "2 arquivos");
        assert_eq!(groups[1].description, "1 arquivo");
        assert_eq!(names(&groups[2]), ["d.txt"]);
        assert!(groups.iter().flat_map(|g| &g.items).all(|i| i.note.is_none()));
        // Symlinked Downloads is refused.
        let (_t2, home2) = fake_home();
        std::os::unix::fs::symlink(&d, home2.join("Downloads")).unwrap();
        assert!(downloads(&home2, &Progress::silent()).is_empty());
        // Missing Downloads is fine.
        let (_t3, home3) = fake_home();
        assert!(downloads(&home3, &Progress::silent()).is_empty());
    }

    // ---- locations and large & old ----

    #[test]
    fn volumes_start_with_home_and_skip_boot_alias() {
        let (_t, home) = fake_home();
        let vols = volumes_in(&home, Path::new("/Volumes"));
        assert_eq!(vols[0].0, "Pasta pessoal");
        assert_eq!(vols[0].1, home);
        assert!(vols[0].3 > 0 && vols[0].2 <= vols[0].3);
        for (name, root, free, total) in &vols[1..] {
            assert_ne!(fs::canonicalize(root).unwrap(), Path::new("/"), "{name}");
            assert!(free <= total);
        }
        // A directory on the same device as "/" (here a temp dir) is not a separate volume.
        let (_t2, fake_volumes) = fake_home();
        fs::create_dir(fake_volumes.join("Disk")).unwrap();
        let dev_root = fs::metadata("/").unwrap().dev();
        let listed = volumes_in(&home, &fake_volumes);
        let same_dev = fs::metadata(fake_volumes.join("Disk")).unwrap().dev() == dev_root;
        assert_eq!(listed.len(), if same_dev { 1 } else { 2 });
    }

    #[test]
    fn large_old_items_carry_access_time() {
        let (_t, home) = fake_home();
        write_bytes(&home.join("Movies/a.mov"), &pattern(1, 300_000));
        let groups = large_old(&home, 100_000, &Progress::silent());
        assert_guard_ok(&home, &groups);
        let item = &groups[0].items[0];
        assert!(item.accessed.is_some_and(|t| t > 1_500_000_000));
        assert!(item.modified.is_some());
    }

    #[test]
    fn formats_sizes_like_the_ui() {
        assert_eq!(fmt_size(999), "999\u{a0}B");
        assert_eq!(fmt_size(1_234_000), "1,2\u{a0}MB");
        assert_eq!(fmt_size(150_000_000), "150\u{a0}MB");
        assert_eq!(fmt_size(9_200_000_000), "9,2\u{a0}GB");
    }

    /// Read-only timing on the real home folder: `cargo test --release -p limpa-core real_home -- --ignored --nocapture`.
    #[ignore = "scans the real home folder"]
    #[test]
    fn real_home_timing() {
        let home = std::env::home_dir().unwrap();
        let t = std::time::Instant::now();
        let walked = walk_files(&home, true, &|_, md| own_bytes(md) >= 100_000, &Progress::silent());
        println!("walk only: {:?}, {} candidates", t.elapsed(), walked.len());
        let t = std::time::Instant::now();
        let dups = duplicates(&home, 100_000, &Progress::silent());
        let waste: u64 = dups.iter().map(|g| g.items[1..].iter().map(|i| i.size).sum::<u64>()).sum();
        println!("duplicates: {:?}, {} sets, {} reclaimable", t.elapsed(), dups.len(), fmt_size(waste));
        let t = std::time::Instant::now();
        let sim = similar_images(&home, &Progress::silent());
        println!(
            "similar_images: {:?}, {} clusters, {} files",
            t.elapsed(),
            sim.len(),
            sim.iter().map(|g| g.items.len()).sum::<usize>()
        );
        let t = std::time::Instant::now();
        let dl = downloads(&home, &Progress::silent());
        println!(
            "downloads: {:?}, {:?}",
            t.elapsed(),
            dl.iter().map(|g| (g.title.clone(), g.items.len())).collect::<Vec<_>>()
        );
        let guard = Guard::new(&home);
        for it in dups.iter().chain(&sim).chain(&dl).flat_map(|g| &g.items) {
            assert!(guard.check(&it.path, &it.policy).is_ok(), "{:?}", it.path);
        }
    }
}
