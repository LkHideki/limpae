//! User-facing text for system I/O errors. std's messages are English ("Read-only file system (os error 30)") and
//! would reach the UI untranslated; these are Portuguese source texts the UI dictionary translates.

use std::io;

/// Portuguese description of an I/O error. Errors that already carry our own message (built with
/// `io::Error::new(kind, "…")`) keep it; unknown OS errors keep the system text inside a translatable template.
pub fn describe_io(e: &io::Error) -> String {
    if e.raw_os_error().is_none() && e.get_ref().is_some() {
        return e.to_string();
    }
    let known = match e.raw_os_error() {
        Some(libc::ENOENT) => Some("o item não existe mais"),
        Some(libc::EPERM | libc::EACCES) => Some("sem permissão para alterar este item"),
        Some(libc::EROFS) => Some("o disco é somente leitura"),
        Some(libc::ENOSPC) => Some("não há espaço livre no disco"),
        Some(libc::ENAMETOOLONG) => Some("o nome do item é longo demais"),
        Some(libc::EBUSY | libc::ENOTEMPTY) => Some("o item está em uso; tente de novo"),
        Some(libc::EXDEV) => Some("o item está em outro disco"),
        Some(libc::EIO) => Some("erro de leitura ou gravação no disco"),
        _ => None,
    };
    match (known, e.kind()) {
        (Some(s), _) => s.into(),
        (None, io::ErrorKind::NotFound) => "o item não existe mais".into(),
        (None, io::ErrorKind::PermissionDenied) => "sem permissão para alterar este item".into(),
        (None, _) => format!("erro do sistema: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn os_errors_become_portuguese_and_own_messages_are_kept() {
        assert_eq!(describe_io(&io::Error::from_raw_os_error(libc::EROFS)), "o disco é somente leitura");
        assert_eq!(describe_io(&io::Error::from_raw_os_error(libc::ENOSPC)), "não há espaço livre no disco");
        assert_eq!(
            describe_io(&io::Error::other("cancelado; o item continua no lugar")),
            "cancelado; o item continua no lugar"
        );
        assert_eq!(describe_io(&io::Error::from(io::ErrorKind::NotFound)), "o item não existe mais");
        assert!(describe_io(&io::Error::from_raw_os_error(libc::ELOOP)).starts_with("erro do sistema: "));
    }
}
