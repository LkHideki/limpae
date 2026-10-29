use std::ffi::CString;
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::path::Path;

use serde::Serialize;

#[derive(Debug, Clone, Copy, Serialize)]
pub struct DiskInfo {
    pub total: u64,
    /// Space available to the user (f_bavail); excludes APFS purgeable space.
    pub free: u64,
    pub used: u64,
}

/// Capacity of the volume holding `path`. Pass the home folder: on APFS "/"
/// is the sealed system snapshot, while home lives on the Data volume.
pub fn disk_info(path: &Path) -> io::Result<DiskInfo> {
    let c = CString::new(path.as_os_str().as_bytes()).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
    // SAFETY: statfs is plain-old-data; libc fills it on success.
    let mut s: libc::statfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statfs(c.as_ptr(), &mut s) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let bsize = s.f_bsize as u64;
    let total = s.f_blocks * bsize;
    let free = s.f_bavail * bsize;
    Ok(DiskInfo { total, free, used: total.saturating_sub(free) })
}

#[cfg(test)]
mod tests {
    #[test]
    fn reports_sane_capacity() {
        let d = super::disk_info(std::path::Path::new("/")).unwrap();
        assert!(d.total > 0 && d.free <= d.total && d.used + d.free == d.total);
    }
}
