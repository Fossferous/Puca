//! Browsing and moving files on the host, over the session's `files` data
//! channel.
//!
//! EVERY REQUEST IS CONFINED BY A SCOPE THE HOST DECIDED.
//!
//! This started life reading and writing any absolute path the peer sent, with
//! no grant and no jail, reachable by anything that could open a data channel.
//! Consenting to share a SCREEN is not consenting to hand over the disk, and
//! the two arrive over the same connection — so the capability has to be
//! granted separately and confined, or the screen-share prompt silently becomes
//! a file-server prompt.
//!
//! THERE ARE NOW TWO SCOPES, and they exist for two different trust stories:
//!
//! - [`FileScope::Jailed`] is the original: one folder, chosen by the person at
//!   the keyboard, in response to a prompt. Unchanged in behaviour.
//! - [`FileScope::Policy`] is for a host ARMED for unattended access, where the
//!   controller proved the unattended passphrase. There is nobody at the
//!   keyboard to pick a folder, so the scope is "this machine's fixed drives,
//!   minus the system and secret-bearing paths in [`denied_roots`]".
//!
//! WHY THE RESOLVER IS NO LONGER PURELY LEXICAL. It used to normalise `..` by
//! walking components and then check `starts_with(root)` — and never touch the
//! filesystem. That is a real hole and it was reachable before this change: a
//! junction or directory symlink INSIDE the granted folder is lexically under
//! the root, so the check passed, and then `fs` cheerfully followed it out. With
//! one hand-picked folder that needed a reparse point to already be sitting in
//! it. Under `Policy` it would be the primary bypass — a single junction would
//! defeat the whole denylist.
//!
//! So resolution is now two gates, and BOTH must pass:
//!
//! 1. The lexical walk, exactly as before. It refuses `..` escapes and rejects
//!    shapes we never want (UNC, device namespaces, alternate data streams).
//!    It works on paths that do not exist, which is every upload target — the
//!    original reason this was lexical, and still a good one.
//! 2. The real-path check. Canonicalise the deepest ancestor that EXISTS, which
//!    resolves junctions, symlinks, 8.3 short names and letter case through the
//!    filesystem, then re-append the components that do not exist yet and
//!    re-check the result. A write to a not-yet-existing file is still checked,
//!    because its PARENT is what has to be real.
//!
//! Gate 2 is skipped only when nothing on the path exists at all, in which case
//! there is nothing on disk to escape to and the open would fail anyway.
//!
//! KNOWN RESIDUAL: this is resolve-then-open, so a component swapped for a
//! junction in the window between the two would not be caught. Closing that
//! needs handle-based checks (`FILE_FLAG_OPEN_REPARSE_POINT` and re-validating
//! by handle), which is a bigger change than this one. Using the canonical path
//! for the open narrows the window but does not remove it.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Component, Path, PathBuf, Prefix};
use std::sync::OnceLock;

use crate::file_log::FileAudit;

/// Ceiling on a single read.
///
/// `len` arrives from the peer and used to be the allocation size directly, so
/// `{"len": 9999999999}` was an out-of-memory kill on the host. An SCTP message
/// cannot usefully carry more than this anyway, and base64 inflates it 1.33x
/// on top, so a bigger read would be dropped by the channel even if it fit in
/// RAM. Callers page through a large file instead.
pub const MAX_READ_LEN: u64 = 64 * 1024;

/// The most directory entries one List response carries.
///
/// A directory with tens of thousands of entries used to be enumerated in full
/// — a per-entry `metadata()` syscall each — INLINE on the session's stream
/// thread, which drives video, ICE keepalives and every other command. A huge
/// folder therefore froze the whole remote session while it churned, and shipped
/// a payload the controller then choked on rendering. Capping bounds all three:
/// the host's work, the wire size, and the controller's row count. The overflow
/// is reported (`truncated`) rather than hidden, so a user is told there is more
/// rather than silently shown a partial folder as if it were whole.
pub const MAX_LIST_ENTRIES: usize = 5000;

/// Ceiling on a single write, for the same reason in the other direction.
pub const MAX_WRITE_LEN: usize = 64 * 1024;

/// What the peer is allowed to reach.
///
/// The stream holds an `Option<FileScope>`; `None` is "not granted", which is
/// the default and what revocation restores. Keeping absence as the revoked
/// state rather than adding a `FileScope::None` means the revoke path is the
/// same `Option` it always was.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FileScope {
    /// One folder, already canonicalised by the caller at grant time.
    Jailed(PathBuf),
    /// Fixed drives minus [`denied_roots`]. Only ever set for an armed host
    /// whose controller proved the unattended passphrase.
    Policy,
}

#[derive(Deserialize, Debug)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum FsRequest {
    ListRoots,
    List {
        path: String,
    },
    Read {
        path: String,
        offset: u64,
        len: u64,
    },
    Write {
        path: String,
        offset: u64,
        data: String, // base64
        /// Cut the file at the end of this write. The client sets it on the
        /// final chunk; without it, overwriting a larger file left the old
        /// tail past the new end and the reply's byte count could not reveal it.
        #[serde(default)]
        truncate: bool,
    },
}

#[derive(Serialize, Debug)]
#[serde(tag = "ok", rename_all = "snake_case")]
pub enum FsResponse {
    Roots { roots: Vec<String> },
    List { entries: Vec<FsEntry>, truncated: bool },
    Data { data: String }, // base64
    Wrote { len: u64 },
    Error { message: String },
}

#[derive(Serialize, Debug)]
pub struct FsEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
}

impl FsResponse {
    pub fn error(msg: impl Into<String>) -> Self {
        FsResponse::Error {
            message: msg.into(),
        }
    }
}

/// One path component reduced to a comparison key.
///
/// Two normalisations happen here and both are load-bearing:
///
/// - A disk prefix collapses to its bare letter, so the verbatim form
///   `\\?\C:` that `canonicalize` returns compares equal to the plain `C:` a
///   peer sends. Without this every real-path check would compare a verbatim
///   path against a non-verbatim root and refuse everything — or worse, a
///   denylist entry would never match and would silently allow.
/// - On Windows the key is lower-cased, because the filesystem is
///   case-insensitive but `Path::starts_with` is not. `c:\windows` must match
///   `C:\Windows`, or the denylist is bypassed by pressing shift.
///
/// `None` means "a component shape we refuse outright" — UNC shares, device
/// namespaces, anything that is not a plain local disk.
fn comp_key(c: Component<'_>) -> Option<String> {
    match c {
        Component::Prefix(p) => match p.kind() {
            Prefix::Disk(d) | Prefix::VerbatimDisk(d) => {
                Some((d as char).to_ascii_lowercase().to_string())
            }
            // UNC and device namespaces are not this machine's filesystem.
            // Allowing them would turn a file browse into an SMB client that
            // authenticates as whoever the agent runs as.
            _ => None,
        },
        Component::RootDir => Some("\\".into()),
        Component::Normal(s) => {
            let s = s.to_string_lossy().to_string();
            Some(if cfg!(windows) { s.to_lowercase() } else { s })
        }
        // Normalised away before this is called.
        Component::CurDir | Component::ParentDir => None,
    }
}

/// Is `child` at or underneath `parent`? Component-wise and case-folded.
///
/// Component-wise matters: `C:\granted-evil` starts with `C:\granted` as a
/// STRING but is not under it. There is a test pinning that, because a
/// "simplification" to a string prefix would be a silent jail break.
fn is_within(child: &Path, parent: &Path) -> bool {
    let Some(c) = keys(child) else { return false };
    let Some(p) = keys(parent) else { return false };
    p.len() <= c.len() && c[..p.len()] == p[..]
}

fn keys(p: &Path) -> Option<Vec<String>> {
    p.components().map(comp_key).collect()
}

/// Normalise `requested` without touching the filesystem.
///
/// `base` is the folder a relative path is taken against. Under [`FileScope::Policy`]
/// there is no single base, so a relative path is refused rather than guessed at.
fn normalize_lexical(base: Option<&Path>, requested: &str) -> Result<PathBuf, String> {
    let raw = Path::new(requested);
    let joined = if raw.is_absolute() {
        raw.to_path_buf()
    } else {
        match base {
            Some(b) => b.join(raw),
            None => {
                return Err("a relative path needs a folder to resolve against".into());
            }
        }
    };

    let mut out = PathBuf::new();
    for comp in joined.components() {
        match comp {
            Component::ParentDir => {
                // Refuse rather than clamp: silently rewriting ".." to the root
                // would let a traversal attempt read the root's own contents
                // and look like it worked.
                if !out.pop() {
                    return Err("path escapes the granted folder".into());
                }
            }
            Component::CurDir => {}
            Component::Prefix(p) => {
                match p.kind() {
                    Prefix::Disk(_) | Prefix::VerbatimDisk(_) => {}
                    _ => return Err("only local disks can be browsed".into()),
                }
                out.push(comp.as_os_str());
            }
            Component::Normal(s) => {
                // An alternate data stream rides on a colon: `notes.txt:hidden`
                // is a different stream of the same file, and neither the
                // canonical form nor a directory listing reveals it. Refuse the
                // shape rather than try to reason about it.
                if s.to_string_lossy().contains(':') {
                    return Err("alternate data streams cannot be browsed".into());
                }
                out.push(s);
            }
            other => out.push(other.as_os_str()),
        }
    }

    Ok(out)
}

/// Resolve `p` through the filesystem as far as it exists.
///
/// Returns `Ok(None)` when no ancestor exists — nothing to escape to, and any
/// open will fail on its own. Returns `Err` when something exists but cannot be
/// resolved, which is a refusal: failing open here is how a jail becomes a
/// suggestion.
fn real_path(p: &Path) -> Result<Option<PathBuf>, String> {
    let mut existing = p.to_path_buf();
    let mut tail: Vec<std::ffi::OsString> = Vec::new();

    loop {
        // symlink_metadata, not metadata: a dangling link EXISTS as a link, and
        // treating it as absent would skip gate 2 for exactly the shape gate 2
        // is here to catch.
        if existing.symlink_metadata().is_ok() {
            break;
        }
        let Some(name) = existing.file_name().map(|n| n.to_os_string()) else {
            return Ok(None);
        };
        tail.push(name);
        if !existing.pop() {
            return Ok(None);
        }
    }

    let mut real = existing
        .canonicalize()
        .map_err(|e| format!("cannot resolve path: {e}"))?;
    for name in tail.iter().rev() {
        real.push(name);
    }
    Ok(Some(real))
}

/// Secret-bearing directory names, refused wherever they appear in a path.
///
/// BY SHAPE, not by enumerating the profiles that exist. The first version walked
/// `C:\Users` once and denied `<each home>\AppData` — which froze the answer at
/// the moment of the first request. A user who logged in for the first time after
/// that had their whole `AppData` readable, because their home simply had not
/// existed when the list was built. Matching the NAME cannot go stale, and it
/// covers profiles on other drives and redirected homes for free.
const DENIED_COMPONENTS: [&str; 6] = ["appdata", ".ssh", ".gnupg", ".aws", ".azure", ".kube"];

/// OS furniture and raw memory images, refused directly below a drive root.
///
/// Also by shape and for the same reason, with a sharper edge: the ALLOW side
/// (`fixed_drive_roots`) is evaluated live on every request, so a volume that
/// appears mid-session — a mounted VHDX, a BitLocker unlock, a Storage Spaces
/// volume coming online — was offered by `ListRoots` and accepted by `resolve`
/// while having no entry at all in the frozen denylist. Live allow against frozen
/// deny is the asymmetry; matching by name removes it.
///
/// Only at the drive root, so an ordinary folder a user happens to call
/// "Recovery" stays browsable.
const DENIED_AT_DRIVE_ROOT: [&str; 9] = [
    "$recycle.bin",
    "system volume information",
    "windows.old",
    "config.msi",
    "recovery",
    "perflogs",
    "pagefile.sys",
    "hiberfil.sys",
    "swapfile.sys",
];

/// Does `effective` match a denied SHAPE? Returns why, for the log.
fn denied_by_shape(effective: &Path) -> Option<&'static str> {
    let keys = keys(effective)?;
    // comp_key already lower-cases on Windows; compare case-insensitively anyway
    // so this cannot depend on that staying true.
    let root_at = keys.iter().position(|k| k == "\\");
    for (i, k) in keys.iter().enumerate() {
        if DENIED_COMPONENTS.iter().any(|d| k.eq_ignore_ascii_case(d)) {
            return Some("a per-user secret directory");
        }
        if Some(i) == root_at.map(|r| r + 1)
            && DENIED_AT_DRIVE_ROOT.iter().any(|d| k.eq_ignore_ascii_case(d))
        {
            return Some("system volume metadata");
        }
    }
    None
}

/// Paths a `Policy` scope refuses that are pinned to a location, not a name.
///
/// Built from the environment, because a machine can have Windows on D: and
/// Program Files redirected, and a denylist that names the wrong drive denies
/// nothing. Both forms of each entry are kept — the canonical one when it
/// resolves, and the literal one always — so a directory created after the agent
/// started is still refused.
///
/// Cacheable, unlike the two shape lists above: every entry here comes from an
/// environment variable that does not change for the life of the process.
///
/// THE ENTRY THAT MATTERS MOST is the agent's own data directory. It holds
/// `unattended.json` (the armed record) and the device key. A browse that can
/// read the verifying key or overwrite that file defeats the very gate that
/// authorised the browse, so this is not one denial among many.
fn denied_roots() -> &'static Vec<PathBuf> {
    static DENIED: OnceLock<Vec<PathBuf>> = OnceLock::new();
    DENIED.get_or_init(build_denied_roots)
}

fn build_denied_roots() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let mut add = |p: PathBuf| {
        if let Ok(c) = p.canonicalize() {
            out.push(c);
        }
        // Keep the literal form too — see the doc comment.
        out.push(p);
    };

    for var in ["SystemRoot", "ProgramData", "ProgramFiles", "ProgramFiles(x86)"] {
        if let Ok(v) = std::env::var(var) {
            if !v.is_empty() {
                add(PathBuf::from(v));
            }
        }
    }

    // The app's own state, including the armed record and the audit log.
    if let Ok(v) = std::env::var("LOCALAPPDATA") {
        if !v.is_empty() {
            add(PathBuf::from(v).join("com.sovereign.chat"));
        }
    }

    out
}

/// Drive roots to offer under `Policy`.
///
/// FIXED drives only. Removable and network drives are excluded deliberately:
/// a mapped share would make this an SMB proxy authenticating as whoever the
/// agent runs as, and a USB stick appearing mid-session would silently widen
/// the scope without anyone granting anything.
#[cfg(windows)]
fn fixed_drive_roots() -> Vec<String> {
    use windows::Win32::Storage::FileSystem::{GetDriveTypeW, GetLogicalDrives};

    /// `DRIVE_FIXED` from winbase.h. Spelled out because the `windows` crate
    /// does not re-export it from this module, and a named constant is worth
    /// more here than a bare 3 in a security check.
    const DRIVE_FIXED: u32 = 3;

    let mask = unsafe { GetLogicalDrives() };
    let mut out = Vec::new();
    for i in 0..26u32 {
        if mask & (1 << i) == 0 {
            continue;
        }
        let letter = (b'A' + i as u8) as char;
        let root = format!("{letter}:\\");
        let wide: Vec<u16> = root.encode_utf16().chain(std::iter::once(0)).collect();
        let kind = unsafe { GetDriveTypeW(windows::core::PCWSTR(wide.as_ptr())) };
        if kind == DRIVE_FIXED {
            out.push(root);
        }
    }
    out
}

#[cfg(not(windows))]
fn fixed_drive_roots() -> Vec<String> {
    vec!["/".to_string()]
}

/// The one place a path is checked. Every arm of [`handle_request`] goes through
/// this; there is a test asserting that, because a guard only one caller uses is
/// not a guard.
fn resolve(scope: &FileScope, requested: &str) -> Result<PathBuf, String> {
    let base = match scope {
        FileScope::Jailed(root) => Some(root.as_path()),
        FileScope::Policy => None,
    };

    // Gate 1: lexical.
    let lexical = normalize_lexical(base, requested)?;
    if let FileScope::Jailed(root) = scope {
        if !is_within(&lexical, root) {
            return Err("path is outside the granted folder".into());
        }
    }

    // Gate 2: real path, when any of it exists.
    let effective = match real_path(&lexical)? {
        Some(real) => real,
        None => lexical,
    };

    match scope {
        FileScope::Jailed(root) => {
            if !is_within(&effective, root) {
                // This is the junction case: lexically inside, actually outside.
                return Err("path leaves the granted folder through a link".into());
            }
        }
        FileScope::Policy => {
            let drives = fixed_drive_roots();
            // Empty means the enumeration failed, not "everywhere is fine". Fail
            // closed: with no drive list there is nothing to bound the scope to.
            if drives.is_empty() {
                return Err("could not determine this machine's drives".into());
            }
            if !drives.iter().any(|d| is_within(&effective, Path::new(d))) {
                return Err("only local fixed drives can be browsed".into());
            }
            // Shape first: it needs no filesystem access and cannot go stale.
            if denied_by_shape(&effective).is_some() {
                return Err("that path is a system or protected location".into());
            }
            for denied in denied_roots() {
                if is_within(&effective, denied) {
                    return Err("that path is a system or protected location".into());
                }
            }
        }
    }

    Ok(effective)
}

pub fn handle_request(req: FsRequest, scope: &FileScope, audit: Option<&FileAudit>) -> FsResponse {
    let log = |op: &str, path: &str, bytes: u64, result: &str| {
        if let Some(a) = audit {
            a.record(op, path, bytes, result);
        }
    };

    match req {
        // Under a jail there is exactly one root and it is the granted folder —
        // enumerating drive letters would advertise paths every other branch
        // then refuses. Under Policy that reasoning INVERTS: the drives really
        // are browsable, so refusing to name them would leave the peer guessing
        // at paths it is allowed to have.
        FsRequest::ListRoots => {
            let roots = match scope {
                FileScope::Jailed(root) => vec![root.to_string_lossy().to_string()],
                FileScope::Policy => fixed_drive_roots(),
            };
            log("list_roots", "", roots.len() as u64, "ok");
            FsResponse::Roots { roots }
        }

        FsRequest::List { path } => {
            let dir = match resolve(scope, &path) {
                Ok(p) => p,
                Err(e) => {
                    log("list", &path, 0, &format!("denied: {e}"));
                    return FsResponse::error(e);
                }
            };
            match fs::read_dir(&dir) {
                Ok(entries) => {
                    let mut result = Vec::new();
                    let mut truncated = false;
                    for entry in entries.flatten() {
                        // STOP at the cap. Past it, every extra entry is another
                        // stat syscall on the stream thread and another row the
                        // controller has to lay out — the exact cost that froze
                        // the session on a giant folder. The peer is told the
                        // list is partial (`truncated`) rather than shown a lie.
                        if result.len() >= MAX_LIST_ENTRIES {
                            truncated = true;
                            break;
                        }
                        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
                        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                        let name = entry.file_name().to_string_lossy().to_string();
                        result.push(FsEntry { name, is_dir, size });
                    }
                    log(
                        "list",
                        &dir.to_string_lossy(),
                        result.len() as u64,
                        if truncated { "ok (truncated)" } else { "ok" },
                    );
                    FsResponse::List { entries: result, truncated }
                }
                Err(e) => {
                    log("list", &dir.to_string_lossy(), 0, &format!("error: {e}"));
                    FsResponse::error(format!("could not read dir: {e}"))
                }
            }
        }

        FsRequest::Read { path, offset, len } => {
            use std::io::{Read, Seek, SeekFrom};
            let file_path = match resolve(scope, &path) {
                Ok(p) => p,
                Err(e) => {
                    log("read", &path, 0, &format!("denied: {e}"));
                    return FsResponse::error(e);
                }
            };
            if len > MAX_READ_LEN {
                log("read", &file_path.to_string_lossy(), len, "denied: over limit");
                return FsResponse::error(format!(
                    "read of {len} bytes is over the {MAX_READ_LEN}-byte limit; request it in chunks"
                ));
            }
            let mut file = match fs::File::open(&file_path) {
                Ok(f) => f,
                Err(e) => {
                    log("read", &file_path.to_string_lossy(), 0, &format!("error: {e}"));
                    return FsResponse::error(format!("could not open file: {e}"));
                }
            };
            if let Err(e) = file.seek(SeekFrom::Start(offset)) {
                return FsResponse::error(format!("could not seek: {e}"));
            }
            let mut buf = vec![0; len as usize];
            match file.read(&mut buf) {
                Ok(n) => {
                    buf.truncate(n);
                    use base64::prelude::*;
                    log("read", &file_path.to_string_lossy(), n as u64, "ok");
                    FsResponse::Data {
                        data: BASE64_STANDARD.encode(&buf),
                    }
                }
                Err(e) => {
                    log("read", &file_path.to_string_lossy(), 0, &format!("error: {e}"));
                    FsResponse::error(format!("could not read file: {e}"))
                }
            }
        }

        FsRequest::Write {
            path,
            offset,
            data,
            truncate,
        } => {
            use base64::prelude::*;
            use std::io::{Seek, SeekFrom, Write};
            let file_path = match resolve(scope, &path) {
                Ok(p) => p,
                Err(e) => {
                    log("write", &path, 0, &format!("denied: {e}"));
                    return FsResponse::error(e);
                }
            };
            let decoded = match BASE64_STANDARD.decode(&data) {
                Ok(d) => d,
                Err(e) => return FsResponse::error(format!("could not decode base64: {e}")),
            };
            if decoded.len() > MAX_WRITE_LEN {
                log(
                    "write",
                    &file_path.to_string_lossy(),
                    decoded.len() as u64,
                    "denied: over limit",
                );
                return FsResponse::error(format!(
                    "write of {} bytes is over the {MAX_WRITE_LEN}-byte limit; send it in chunks",
                    decoded.len()
                ));
            }
            let mut file = match fs::OpenOptions::new().write(true).create(true).open(&file_path) {
                Ok(f) => f,
                Err(e) => {
                    log("write", &file_path.to_string_lossy(), 0, &format!("error: {e}"));
                    return FsResponse::error(format!("could not open file: {e}"));
                }
            };
            // NO HOLES. `offset` comes from the peer and was never checked against
            // the file's length, so a single 1-byte write at offset 2^40 seeked
            // past the end and produced a sparse file that big — repeatable, on a
            // scope that is now the whole disk rather than one hand-picked folder,
            // which is a remote way to exhaust a host's storage.
            //
            // Uploads are strictly sequential (chunk N lands at N*chunk), so
            // "append or overwrite, never skip" costs a legitimate client nothing
            // while removing the amplification entirely. offset == len is the
            // append case and must stay allowed.
            let current_len = file.metadata().map(|m| m.len()).unwrap_or(0);
            if offset > current_len {
                log(
                    "write",
                    &file_path.to_string_lossy(),
                    offset,
                    "denied: offset past end of file",
                );
                return FsResponse::error(format!(
                    "write at offset {offset} would leave a hole in a {current_len}-byte file; \
                     write sequentially"
                ));
            }
            // Overflow would wrap in release and panic the stream thread in debug.
            let Some(end) = offset.checked_add(decoded.len() as u64) else {
                return FsResponse::error("write offset and length overflow".to_string());
            };
            if let Err(e) = file.seek(SeekFrom::Start(offset)) {
                return FsResponse::error(format!("could not seek: {e}"));
            }
            if let Err(e) = file.write_all(&decoded) {
                log("write", &file_path.to_string_lossy(), 0, &format!("error: {e}"));
                return FsResponse::error(format!("could not write file: {e}"));
            }
            if truncate {
                // Cut at the current position, i.e. the end of this chunk.
                if let Err(e) = file.set_len(end) {
                    return FsResponse::error(format!("could not truncate file: {e}"));
                }
            }
            log(
                "write",
                &file_path.to_string_lossy(),
                decoded.len() as u64,
                "ok",
            );
            FsResponse::Wrote {
                len: decoded.len() as u64,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> PathBuf {
        // Gate 2 is skipped when nothing on the path exists, so the lexical
        // behaviour can still be tested against a root that is not on disk.
        PathBuf::from(if cfg!(windows) {
            "C:\\granted"
        } else {
            "/granted"
        })
    }

    fn jailed() -> FileScope {
        FileScope::Jailed(root())
    }

    fn stamp() -> u128 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    }

    /// A real directory that exists, for the tests that need gate 2 to engage.
    ///
    /// Fine for `Jailed` tests, where the denylist does not apply.
    fn tempdir(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("sov-ft-{tag}-{}", stamp()));
        fs::create_dir_all(&p).unwrap();
        p.canonicalize().unwrap()
    }

    /// A real directory that `Policy` ALLOWS.
    ///
    /// Not `std::env::temp_dir()`: on Windows that is
    /// `%USERPROFILE%\AppData\Local\Temp`, and AppData is on the denylist. A
    /// Policy test rooted there is refused because of WHERE IT STARTS, which
    /// would make an "allowed" test fail and — far worse — make a "denied" test
    /// pass without ever exercising the thing it claims to check. The junction
    /// test below is exactly that trap: built under temp_dir it would be refused
    /// for its base rather than for the junction, and would have looked green.
    fn policy_tempdir(tag: &str) -> PathBuf {
        let home = std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
            .expect("a home directory to test under");
        let p = PathBuf::from(home).join(format!("sov-ft-{tag}-{}", stamp()));
        fs::create_dir_all(&p).unwrap();
        let c = p.canonicalize().unwrap();
        // Guard the guard: if this location is itself denied, every test using
        // it is meaningless, so say so instead of reporting a pass.
        assert!(
            resolve(&FileScope::Policy, &c.to_string_lossy()).is_ok(),
            "the test fixture directory {} must itself be allowed by Policy, \
             or the tests built on it prove nothing",
            c.display()
        );
        c
    }

    /// `resolve` returns the CANONICAL path, which on Windows is the verbatim
    /// `\\?\C:\…` form — deliberately, because using the resolved path for the
    /// open is what narrows the resolve-then-open window. So these tests assert
    /// the security property (where the path ended up) rather than its spelling.
    fn assert_resolves_to(scope: &FileScope, requested: &str, expected: &Path) {
        let got = resolve(scope, requested)
            .unwrap_or_else(|e| panic!("{requested} should resolve, got {e}"));
        assert!(
            is_within(&got, expected) && is_within(expected, &got),
            "{requested} resolved to {}, expected {}",
            got.display(),
            expected.display()
        );
    }

    #[test]
    fn a_relative_path_lands_under_the_root() {
        let r = root();
        assert_resolves_to(&jailed(), "notes.txt", &r.join("notes.txt"));
        assert_resolves_to(&jailed(), "sub/notes.txt", &r.join("sub").join("notes.txt"));
    }

    #[test]
    fn dot_dot_cannot_climb_out_of_the_root() {
        for attempt in [
            "../secrets.txt",
            "sub/../../secrets.txt",
            "./../../secrets.txt",
        ] {
            assert!(
                resolve(&jailed(), attempt).is_err(),
                "{attempt} must be refused"
            );
        }
    }

    #[test]
    fn dot_dot_inside_the_root_is_still_allowed() {
        // Positive control: proves the check refuses ESCAPES, not every "..".
        // Without this, a resolve that rejected all input would pass the test
        // above and look correct.
        let r = root();
        assert_resolves_to(&jailed(), "sub/../notes.txt", &r.join("notes.txt"));
    }

    #[test]
    fn an_absolute_path_outside_the_root_is_refused() {
        let r = root();
        let outside = if cfg!(windows) {
            "C:\\Windows\\System32\\config\\SAM"
        } else {
            "/etc/shadow"
        };
        assert!(resolve(&jailed(), outside).is_err());

        // Positive control: an absolute path INSIDE the root is fine, so the
        // rejection above is about location and not about absoluteness.
        let inside = r.join("notes.txt");
        assert_resolves_to(&jailed(), &inside.to_string_lossy(), &inside);
    }

    #[test]
    fn a_sibling_directory_sharing_the_root_prefix_is_refused() {
        // "C:\granted-evil" starts with "C:\granted" as a STRING but is not
        // under it. The comparison is component-wise, which is why this passes
        // -- pin it so nobody "optimises" it into a string compare.
        let sibling = if cfg!(windows) {
            "C:\\granted-evil\\loot.txt"
        } else {
            "/granted-evil/loot.txt"
        };
        assert!(resolve(&jailed(), sibling).is_err());
    }

    #[test]
    fn case_differences_do_not_defeat_the_jail_on_windows() {
        if !cfg!(windows) {
            return;
        }
        // Positive control for the case-folding in comp_key: the same path in
        // a different case must still resolve INSIDE the jail. Before folding,
        // Path::starts_with would have refused this outright, and the same
        // blindness is what would let `c:\windows` slip past the denylist.
        let shouty = "C:\\GRANTED\\notes.txt";
        assert!(
            resolve(&jailed(), shouty).is_ok(),
            "case-only difference must still be inside the jail"
        );
    }

    #[test]
    fn an_alternate_data_stream_is_refused() {
        assert!(resolve(&jailed(), "notes.txt:hidden").is_err());
        // Positive control: the same name without a stream is fine, so the
        // refusal is about the colon and not about the file.
        assert!(resolve(&jailed(), "notes.txt").is_ok());
    }

    #[test]
    fn a_unc_path_is_refused() {
        if !cfg!(windows) {
            return;
        }
        assert!(resolve(&FileScope::Policy, "\\\\server\\share\\loot.txt").is_err());
    }

    #[test]
    fn a_relative_path_has_nothing_to_resolve_against_under_policy() {
        let err = resolve(&FileScope::Policy, "notes.txt").unwrap_err();
        assert!(err.contains("relative"), "{err}");
    }

    #[test]
    fn policy_refuses_the_system_root_and_the_agents_own_state() {
        if !cfg!(windows) {
            return;
        }
        let sysroot = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
        let sam = format!("{sysroot}\\System32\\config\\SAM");
        assert!(
            resolve(&FileScope::Policy, &sam).is_err(),
            "the SAM hive must be refused"
        );

        if let Ok(lad) = std::env::var("LOCALAPPDATA") {
            let armed = format!("{lad}\\com.sovereign.chat\\device\\unattended.json");
            assert!(
                resolve(&FileScope::Policy, &armed).is_err(),
                "the armed record must be refused — reading it defeats the gate"
            );
        }
    }

    #[test]
    fn policy_allows_an_ordinary_path_on_a_fixed_drive() {
        // Positive control for the denylist: if Policy refused everything, the
        // test above would pass while the feature was useless. This proves the
        // refusals are about WHICH path, not about Policy itself.
        let dir = policy_tempdir("policy-allow");
        let f = dir.join("notes.txt");
        fs::write(&f, b"hello").unwrap();

        let got = resolve(&FileScope::Policy, &f.to_string_lossy());
        assert!(got.is_ok(), "{:?}", got.err());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn policy_refuses_a_secret_directory_that_did_not_exist_at_startup() {
        if !cfg!(windows) {
            return;
        }
        // THE STALENESS BUG. The denylist used to be built by walking C:\Users
        // once and denying each home it found, cached for the process lifetime.
        // A profile created afterwards therefore had no entry at all, and its
        // whole AppData was readable. Matching by NAME cannot go stale, so a
        // profile that has never existed is refused just the same.
        let sysdrive = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into());
        for attempt in [
            format!("{sysdrive}\\Users\\nobody-has-ever-logged-in-as-this\\AppData\\Local\\creds.db"),
            format!("{sysdrive}\\Users\\nobody-has-ever-logged-in-as-this\\.ssh\\id_ed25519"),
            format!("{sysdrive}\\some\\redirected\\home\\.aws\\credentials"),
        ] {
            assert!(
                resolve(&FileScope::Policy, &attempt).is_err(),
                "{attempt} must be refused by shape, not by enumeration"
            );
        }
    }

    #[test]
    fn policy_refuses_volume_metadata_on_any_drive_root() {
        if !cfg!(windows) {
            return;
        }
        // Same asymmetry from the other side: the ALLOW list (fixed_drive_roots)
        // is evaluated live on every request, so a volume appearing mid-session
        // was offered while having no entry in the frozen denylist.
        let sysdrive = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into());
        for name in ["System Volume Information", "$Recycle.Bin", "pagefile.sys"] {
            let p = format!("{sysdrive}\\{name}");
            assert!(
                resolve(&FileScope::Policy, &p).is_err(),
                "{p} must be refused at a drive root"
            );
        }
    }

    #[test]
    fn the_drive_root_denials_apply_only_at_the_root() {
        // POSITIVE CONTROL for the shape match: a folder a user happens to have
        // called "Recovery" deeper in the tree is ordinary and must stay
        // browsable. Without this, denying the name everywhere would look
        // identical to denying it at the root.
        let dir = policy_tempdir("shape-control");
        let ordinary = dir.join("Recovery").join("notes.txt");
        assert!(
            resolve(&FileScope::Policy, &ordinary.to_string_lossy()).is_ok(),
            "a Recovery folder that is not at a drive root must be browsable"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn policy_refuses_every_profiles_appdata() {
        if !cfg!(windows) {
            return;
        }
        // AppData is where tokens, browser profiles and credential stores live,
        // so it is denied for EVERY profile rather than just the agent's own.
        // This also documents why `policy_tempdir` exists: the system temp
        // directory is inside AppData and is therefore denied.
        let temp = std::env::temp_dir();
        assert!(
            resolve(&FileScope::Policy, &temp.to_string_lossy()).is_err(),
            "the system temp directory is under AppData and must be denied"
        );
    }

    #[test]
    fn a_write_target_that_does_not_exist_yet_is_still_allowed() {
        // The whole reason gate 1 stayed lexical. If gate 2 demanded that the
        // target exist, every upload would be refused.
        let dir = policy_tempdir("policy-newfile");
        let target = dir.join("does-not-exist-yet.txt");
        assert!(resolve(&FileScope::Policy, &target.to_string_lossy()).is_ok());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_oversized_read_is_refused_rather_than_allocated() {
        let resp = handle_request(
            FsRequest::Read {
                path: "notes.txt".into(),
                offset: 0,
                len: u64::MAX,
            },
            &jailed(),
            None,
        );
        match resp {
            FsResponse::Error { message } => assert!(message.contains("limit"), "{message}"),
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    #[test]
    fn listing_roots_reports_only_the_granted_folder_when_jailed() {
        let r = root();
        match handle_request(FsRequest::ListRoots, &jailed(), None) {
            FsResponse::Roots { roots } => {
                assert_eq!(roots, vec![r.to_string_lossy().to_string()])
            }
            other => panic!("expected roots, got {other:?}"),
        }
    }

    #[test]
    fn a_huge_directory_is_capped_and_marked_truncated() {
        // THE FREEZE FIX, pinned. An uncapped directory was enumerated in full
        // on the session's stream thread (a metadata() syscall per entry) and
        // shipped whole, freezing the remote session on a giant folder. The cap
        // bounds the work and the wire, and says so rather than silently showing
        // a partial folder as if it were the whole thing.
        let dir = tempdir("list-cap");
        for i in 0..(MAX_LIST_ENTRIES + 3) {
            fs::write(dir.join(format!("f{i:05}.txt")), b"").unwrap();
        }
        let scope = FileScope::Jailed(dir.clone());
        match handle_request(
            FsRequest::List { path: dir.to_string_lossy().to_string() },
            &scope,
            None,
        ) {
            FsResponse::List { entries, truncated } => {
                assert_eq!(entries.len(), MAX_LIST_ENTRIES, "must cap at the limit");
                assert!(truncated, "the overflow must be reported");
            }
            other => panic!("expected a list, got {other:?}"),
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_small_directory_is_not_marked_truncated() {
        // Positive control: `truncated` is about the CAP, not always-on. Without
        // it, a cap wired to `truncated = true` unconditionally would pass the
        // test above while lying about every folder.
        let dir = tempdir("list-small");
        for i in 0..5 {
            fs::write(dir.join(format!("f{i}.txt")), b"").unwrap();
        }
        let scope = FileScope::Jailed(dir.clone());
        match handle_request(
            FsRequest::List { path: dir.to_string_lossy().to_string() },
            &scope,
            None,
        ) {
            FsResponse::List { entries, truncated } => {
                assert_eq!(entries.len(), 5);
                assert!(!truncated, "a small directory is complete, not truncated");
            }
            other => panic!("expected a list, got {other:?}"),
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn listing_roots_reports_real_drives_under_policy() {
        // The inverted invariant, pinned in both directions alongside the test
        // above: Jailed names one folder, Policy names the drives.
        match handle_request(FsRequest::ListRoots, &FileScope::Policy, None) {
            FsResponse::Roots { roots } => {
                assert!(!roots.is_empty(), "policy must name at least one drive");
                if cfg!(windows) {
                    assert!(
                        roots.iter().any(|r| r.ends_with(":\\")),
                        "expected drive roots, got {roots:?}"
                    );
                }
            }
            other => panic!("expected roots, got {other:?}"),
        }
    }

    #[test]
    fn traversal_is_refused_by_the_request_handler_not_just_the_helper() {
        // The helper is only a guard if every arm actually calls it.
        for req in [
            FsRequest::List {
                path: "../..".into(),
            },
            FsRequest::Read {
                path: "../secrets.txt".into(),
                offset: 0,
                len: 16,
            },
            FsRequest::Write {
                path: "../secrets.txt".into(),
                offset: 0,
                data: String::new(),
                truncate: false,
            },
        ] {
            match handle_request(req, &jailed(), None) {
                FsResponse::Error { message } => {
                    assert!(message.contains("escapes") || message.contains("outside"), "{message}")
                }
                other => panic!("expected a refusal, got {other:?}"),
            }
        }
    }

    #[test]
    fn every_arm_refuses_a_denied_path_under_policy() {
        if !cfg!(windows) {
            return;
        }
        let sysroot = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
        // Every arm must refuse. The REASON differs by path and that is fine:
        // the SAM hive is locked by the OS, so `canonicalize` fails with access
        // denied before the denylist is even consulted. Both are refusals; only
        // one of them is the denylist talking. Asserting the exact message for
        // all three is what made this test fail against a correct implementation.
        for req in [
            FsRequest::List {
                path: sysroot.clone(),
            },
            FsRequest::Read {
                path: format!("{sysroot}\\System32\\config\\SAM"),
                offset: 0,
                len: 16,
            },
            FsRequest::Write {
                path: format!("{sysroot}\\evil.txt"),
                offset: 0,
                data: String::new(),
                truncate: false,
            },
        ] {
            match handle_request(req, &FileScope::Policy, None) {
                FsResponse::Error { .. } => {}
                other => panic!("expected a refusal, got {other:?}"),
            }
        }

        // And pin that the DENYLIST specifically is what refuses a path it can
        // resolve, so the loop above cannot be satisfied purely by I/O errors.
        match handle_request(FsRequest::List { path: sysroot }, &FileScope::Policy, None) {
            FsResponse::Error { message } => {
                assert!(message.contains("system or protected"), "{message}")
            }
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    // ---- gate 2: reparse points -------------------------------------------
    //
    // These need a real junction on disk. `mklink /J` does not require
    // elevation (a directory SYMLINK would), so this runs unprivileged. If the
    // junction cannot be created the test SKIPS LOUDLY rather than passing
    // silently — a security test that quietly no-ops is worse than none.

    #[cfg(windows)]
    fn make_junction(link: &Path, target: &Path) -> bool {
        std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    #[test]
    #[cfg(windows)]
    fn a_junction_out_of_the_jail_is_refused() {
        let base = tempdir("junction");
        let inside = base.join("granted");
        let outside = base.join("secrets");
        fs::create_dir_all(&inside).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("loot.txt"), b"top secret").unwrap();

        let link = inside.join("escape");
        if !make_junction(&link, &outside) {
            panic!("could not create a test junction; gate 2 is UNVERIFIED on this machine");
            let _ = fs::remove_dir_all(&base);
            return;
        }

        let scope = FileScope::Jailed(inside.clone());
        // Lexically this is inside the jail. Only gate 2 can see that it is not.
        let attempt = link.join("loot.txt");
        let got = resolve(&scope, &attempt.to_string_lossy());
        assert!(
            got.is_err(),
            "a junction out of the jail must be refused, got {got:?}"
        );

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    #[cfg(windows)]
    fn a_junction_that_stays_inside_the_jail_still_works() {
        // POSITIVE CONTROL for the test above. Without it, a resolve() that
        // refused every path containing a reparse point — or refused
        // everything at all — would look like a working defence.
        let base = tempdir("junction-ok");
        let inside = base.join("granted");
        let real = inside.join("real");
        fs::create_dir_all(&real).unwrap();
        fs::write(real.join("notes.txt"), b"fine").unwrap();

        let link = inside.join("shortcut");
        if !make_junction(&link, &real) {
            panic!("could not create a test junction; gate 2 is UNVERIFIED on this machine");
            let _ = fs::remove_dir_all(&base);
            return;
        }

        let scope = FileScope::Jailed(inside.clone());
        let attempt = link.join("notes.txt");
        let got = resolve(&scope, &attempt.to_string_lossy());
        assert!(
            got.is_ok(),
            "a junction INSIDE the jail must still resolve, got {got:?}"
        );

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    #[cfg(windows)]
    fn a_junction_into_a_denied_location_is_refused_under_policy() {
        // The denylist bypass this whole change exists to close: the junction
        // sits somewhere ALLOWED, so gate 1, the drive check and the denylist all
        // pass on the path as written. Only gate 2 can see where it really goes.
        //
        // `policy_tempdir`, not `tempdir`: under the system temp directory the
        // base is inside AppData and already denied, so the refusal would prove
        // nothing about junctions and this test would be green and worthless.
        let base = policy_tempdir("junction-policy");
        let link = base.join("winlink");
        let sysroot = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());

        if !make_junction(&link, Path::new(&sysroot)) {
            panic!("could not create a test junction; gate 2 is UNVERIFIED on this machine");
            let _ = fs::remove_dir_all(&base);
            return;
        }

        let attempt = link.join("System32").join("config").join("SAM");
        let got = resolve(&FileScope::Policy, &attempt.to_string_lossy());
        assert!(
            got.is_err(),
            "a junction into the system root must be refused, got {got:?}"
        );

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    #[cfg(windows)]
    fn a_short_name_expanding_into_a_denied_location_is_refused() {
        // 8.3 short names are a second aliasing route. canonicalize() expands
        // them, so gate 2 catches this; gate 1 alone never could.
        let sysdrive = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into());
        let candidate = format!("{sysdrive}\\PROGRA~1");
        // A genuine environment difference rather than a broken fixture: 8.3 name
        // generation can be disabled on a volume. Fail rather than skip anyway —
        // this asserts a security property, and "it did not apply here" reported
        // as a pass is how the check quietly stops covering anything. If a machine
        // legitimately has short names off, the honest move is to see this red and
        // gate it on the volume setting, not to have never noticed.
        assert!(
            Path::new(&candidate).exists(),
            "no {candidate}: 8.3 short names appear to be disabled, so the short-name \
             aliasing route is UNVERIFIED on this machine"
        );
        let got = resolve(&FileScope::Policy, &candidate);
        assert!(
            got.is_err(),
            "PROGRA~1 expands into Program Files, which is denied; got {got:?}"
        );
    }
}
