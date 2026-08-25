//! The service log.
//!
//! A Windows service has no console, so without a file on disk the whole
//! lifecycle is invisible — which is exactly what made the S5 spike impossible
//! to read until it logged somewhere.
//!
//! `%ProgramData%\Sovereign` is writable by SYSTEM and readable by an admin. A
//! user's `%TEMP%` is NOT writable by a SYSTEM/session-0 process (the S5 trap),
//! so it must never be used here. And this is deliberately NOT the secrets
//! directory: a log is not a secret, and putting it there would mean either
//! widening that ACL or making the log unreadable by the admin trying to
//! diagnose the machine.
//!
//! WHAT MUST NEVER REACH THIS FILE. It is world-readable by design, and the
//! link handles a token, an attestation signature and session keys. Log the
//! fact and the identifier, never the credential — `read_secret` failures name
//! the path, not the contents, for the same reason.

/// Append a line, best-effort. A logging failure must never take the service
/// down: it is diagnosis, not function.
pub fn line(msg: &str) {
    use std::io::Write;
    let dir = std::env::var("ProgramData").unwrap_or_else(|_| "C:\\ProgramData".into());
    let dir = std::path::Path::new(&dir).join("Sovereign");
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut f) =
        std::fs::OpenOptions::new().append(true).create(true).open(dir.join("service.log"))
    {
        let _ = writeln!(f, "{msg}");
    }
}
