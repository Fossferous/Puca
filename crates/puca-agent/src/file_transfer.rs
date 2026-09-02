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
//! 3. THE HANDLE CHECK, which closes the resolve-then-open race gates 1 and 2
//!    could not. Both of them reason about a PATH, and a path is only a
//!    description of where an object was a moment ago: a component swapped for
//!    a junction between the check and the open was not caught. So every arm
//!    now opens through [`open_verified`], which re-derives the path from the
//!    OPEN HANDLE (`GetFinalPathNameByHandleW` on Windows, `/proc/self/fd` on
//!    Linux) and runs the scope check again against THAT. The object that was
//!    checked and the object that is operated on are the same object by
//!    construction.
//!
//! DENIALS APPLY TO BOTH SCOPES. They used to apply only under `Policy`, so an
//! attended grant of the user's home folder — the obvious thing to pick in a
//! folder picker — exposed `%LOCALAPPDATA%\com.sovereign.chat` (the armed
//! record, the device key, and the WebView profile holding the remembered
//! unattended signing seed) and `~/.ssh`. A scope-shaped hole in a denylist is
//! a hole; there is now ONE denial block and every scope goes through it.
//!
//! WHAT THE PEER IS TOLD THE ROOT IS CALLED. Under `Jailed`, `ListRoots` used
//! to answer with the granted folder's absolute path — which discloses the
//! host's OS account name (commonly a real one) and their folder layout to a
//! peer who was granted FILE ACCESS, not identity. It now answers with the
//! opaque token [`JAILED_ROOT`], and `normalize_lexical` re-bases any path that
//! starts at a root but names no drive onto the granted folder. The jail
//! therefore looks like a small filesystem of its own to the controller, which
//! is both less to leak and easier to reason about.
//!
//! RESIDUAL, stated honestly. The handle check makes the checked object and the
//! opened object identical. It does NOT freeze the path an ancestor is reached
//! through: for `List` the directory handle is held open across the enumeration
//! (and without `FILE_SHARE_DELETE`, so that directory cannot be renamed or
//! deleted under it), but a rename of a GRANDPARENT between the verify and the
//! enumerate is still possible. For `Write`, the open is `create(true)`, so a
//! swap losing the race can still leave a zero-byte file at the attacker's
//! location — nothing is ever written to it, because the verify runs before the
//! first `write_all`. All of this needs code already running on the host that
//! can win a race against the agent.

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
    /// One folder, canonicalised. Build it with [`FileScope::jailed`] — the
    /// doc comment used to say "already canonicalised by the caller" and the
    /// one caller did not, which is a live functional failure, not a comment
    /// bug: `resolve` canonicalises the TARGET and compares it against the
    /// root, so a root reached through a junction, a directory symlink, a
    /// `subst` drive or an 8.3 short name — all ordinary on Windows — made
    /// every operation inside the folder the user had just granted fail with
    /// "path leaves the granted folder through a link".
    Jailed(PathBuf),
    /// Fixed drives minus [`denied_roots`]. Only ever set for an armed host
    /// whose controller proved the unattended passphrase.
    Policy,
}

/// The opaque root token a jailed peer is handed by `ListRoots`.
///
/// NOT the granted folder's absolute path, which is what this used to answer
/// with: that path names the host's OS account (`C:\Users\<real name>\…`) and
/// their folder layout, to a peer who was granted file access and nothing
/// else. `normalize_lexical` re-bases any rootless path onto the granted
/// folder, so the controller keeps sending exactly what it always sent — it
/// simply no longer LEARNS the absolute prefix. The audit log still records
/// the real path; that is host-side and should stay precise.
pub const JAILED_ROOT: &str = "/";

impl FileScope {
    /// The only way a grant should build a `Jailed` scope: canonicalise now,
    /// and refuse the grant if that is impossible.
    ///
    /// FAILING CLOSED IS THE POINT. A root we cannot resolve is a jail we
    /// cannot enforce, so an unresolvable folder must not become a grant that
    /// silently checks against a path the filesystem disagrees with.
    pub fn jailed(root: &str) -> Result<Self, String> {
        let c = fs::canonicalize(root).map_err(|e| format!("that folder could not be resolved: {e}"))?;
        // REFUSE AT THE GRANT what `check_effective` refuses at every browse.
        // Until this ran here, a grant of a folder under %APPDATA% "succeeded"
        // and the peer's first listing came back with the generic browse-time
        // refusal — which reads as file transfer being broken, not as a rule,
        // and named neither the folder nor the reason. The browse-time check
        // STAYS: it is what covers a denied subtree reached from an allowed
        // root, and the Policy scope, which never passes through here.
        match denied_by_shape(&c) {
            Some("a per-user secret directory") => {
                return Err("that folder is inside AppData or another per-user secret directory (.ssh, .gnupg, .aws…) — those hold credentials and this app's own keys, so it cannot be shared; pick a folder outside it".into());
            }
            Some(other) => return Err(format!("that folder is {other}, so it cannot be shared")),
            None => {}
        }
        if denied_roots().iter().any(|d| is_within(&c, d)) {
            return Err("that folder is a system location (Windows, Program Files or ProgramData), so it cannot be shared".into());
        }
        Ok(FileScope::Jailed(c))
    }
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
    // Does the path NAME A VOLUME? That, not `is_absolute`, is the question
    // that separates "somewhere else on this machine" from "somewhere in the
    // jail" — and the two spell themselves differently per platform, which is
    // exactly the sort of difference that makes a security check mean one
    // thing on the developer's machine and another on the user's.
    let names_a_volume = matches!(raw.components().next(), Some(Component::Prefix(_)));
    let joined = if names_a_volume {
        raw.to_path_buf()
    } else {
        match base {
            // THE JAIL IS THE PEER'S WHOLE FILESYSTEM. A path that starts at a
            // root but names no drive — `/`, the [`JAILED_ROOT`] token, and
            // anything the controller builds by joining onto it — is taken
            // against the granted folder rather than against the real root.
            // Chroot semantics: under a jail there is no spelling of an
            // absolute path that leaves it, which is strictly narrower than
            // what this did before (`\Windows\System32` used to become
            // `C:\Windows\System32` and be refused; it is now a location
            // inside the jail that almost certainly does not exist).
            //
            // THE EXCEPTION, and it is not a hole: a rootless path that ALREADY
            // names a location inside the granted folder is left alone. On
            // Windows that cannot happen — a real in-jail path carries a drive
            // letter, so this arm never fires there — but on unix `/granted/x`
            // and `/x` are spelled the same way and a peer may legitimately
            // have been handed either. BOTH readings land inside the jail, so
            // the choice is about which file you get, never about whether you
            // are allowed it.
            Some(b) if raw.has_root() && is_within(raw, b) => raw.to_path_buf(),
            Some(b) => {
                let mut p = b.to_path_buf();
                for comp in raw.components() {
                    if matches!(comp, Component::RootDir) {
                        continue;
                    }
                    p.push(comp.as_os_str());
                }
                p
            }
            // Under Policy there is no base to re-base onto, so an absolute
            // path is the only thing that can be resolved at all.
            None if raw.is_absolute() => raw.to_path_buf(),
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

    check_effective(scope, &effective)?;
    Ok(effective)
}

/// Is `effective` — a path that has already been through gates 1 and 2, or one
/// re-derived from an OPEN HANDLE — inside `scope` and not denied?
///
/// Split out of `resolve` for two reasons, and the second is the important one:
///
/// - [`open_verified`] runs it a second time against the handle's own path, so
///   the check and the open cannot disagree about which object they mean.
/// - The denials used to live inside the `Policy` arm, where `Jailed` could not
///   reach them. An attended grant of a home folder therefore exposed
///   `%LOCALAPPDATA%\com.sovereign.chat` — the armed record, the device key and
///   the WebView profile holding the remembered unattended seed — and `~/.ssh`.
///   Containment is per-scope; DENIAL IS NOT. Keeping them in one block below
///   the match is what stops a third scope quietly inheriting the hole.
///
/// The deliberate consequence: a user who grants a folder inside `%APPDATA%`
/// finds it unbrowsable, and the refusal message says why. That is the right
/// answer — if some workflow genuinely needs it, the override belongs at grant
/// time, never in here.
fn check_effective(scope: &FileScope, effective: &Path) -> Result<(), String> {
    match scope {
        FileScope::Jailed(root) => {
            if !is_within(effective, root) {
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
            if !drives.iter().any(|d| is_within(effective, Path::new(d))) {
                return Err("only local fixed drives can be browsed".into());
            }
        }
    }

    // EVERY SCOPE, no exceptions. Shape first: it needs no filesystem access
    // and cannot go stale.
    if denied_by_shape(effective).is_some() {
        return Err("that path is a system or protected location".into());
    }
    for denied in denied_roots() {
        if is_within(effective, denied) {
            return Err("that path is a system or protected location".into());
        }
    }

    Ok(())
}

/// What an arm wants the handle for. Only the open flags differ.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum OpenAs {
    Read,
    Write,
    Dir,
}

/// Why an open did not happen.
///
/// The two are kept apart because the AUDIT LOG distinguishes them and a reader
/// of that log needs to: "the jail refused this" and "the file is not there"
/// are different events, and collapsing them into one string would make a
/// refused traversal indistinguishable from a typo in a filename.
#[derive(Debug)]
enum OpenError {
    /// A scope check said no — gate 1, 2 or the handle check.
    Denied(String),
    /// The scope was satisfied and the filesystem still said no.
    Io(String),
}

impl OpenError {
    fn tag(&self) -> &'static str {
        match self {
            OpenError::Denied(_) => "denied",
            OpenError::Io(_) => "error",
        }
    }

    fn into_message(self) -> String {
        match self {
            OpenError::Denied(m) | OpenError::Io(m) => m,
        }
    }
}

impl std::fmt::Display for OpenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OpenError::Denied(m) | OpenError::Io(m) => f.write_str(m),
        }
    }
}

/// Where an OPEN HANDLE actually points, asked of the OS rather than of the
/// path we happened to open with.
///
/// `None` means "this platform cannot answer", which is deliberately distinct
/// from an error: on a platform with no way to interrogate a handle there is
/// nothing to compare, and refusing every open would disable the feature rather
/// than harden it. Windows (the only platform the grant path is even compiled
/// for — `Request::SetFileAccess` is `#[cfg(windows)]`) and Linux both answer.
#[cfg(windows)]
fn handle_real_path(f: &fs::File) -> Option<PathBuf> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{GetFinalPathNameByHandleW, FILE_NAME_NORMALIZED};

    let handle = HANDLE(f.as_raw_handle());
    let mut buf = vec![0u16; 512];
    loop {
        let n = unsafe { GetFinalPathNameByHandleW(handle, &mut buf, FILE_NAME_NORMALIZED) };
        if n == 0 {
            return None;
        }
        // Success returns the length WITHOUT the NUL; "too small" returns the
        // length WITH it. Treating the second as the first would silently
        // compare a truncated path, which is the failure mode that turns a
        // security check into a coin flip.
        if (n as usize) < buf.len() {
            return Some(PathBuf::from(String::from_utf16_lossy(&buf[..n as usize])));
        }
        buf = vec![0u16; n as usize + 1];
    }
}

#[cfg(target_os = "linux")]
fn handle_real_path(f: &fs::File) -> Option<PathBuf> {
    use std::os::unix::io::AsRawFd;
    fs::read_link(format!("/proc/self/fd/{}", f.as_raw_fd())).ok()
}

#[cfg(not(any(windows, target_os = "linux")))]
fn handle_real_path(_f: &fs::File) -> Option<PathBuf> {
    None
}

/// Open `resolved` and prove the OPENED OBJECT is inside `scope`.
///
/// GATE 3, and the reason it exists: gates 1 and 2 check a path, and between
/// checking a path and opening it another process can swap a component for a
/// junction. Re-deriving the path from the handle and re-running
/// [`check_effective`] against it makes the checked object and the opened
/// object the same object — the check no longer depends on nothing having
/// moved. A disagreement is a refusal, not a warning.
///
/// Separate from [`open_checked`] so a test can drive the handle gate on its
/// own, by handing it a path `resolve` would have refused: that is precisely
/// the state a lost race leaves behind, and there is no other way to reach it
/// deterministically.
fn open_verified(
    scope: &FileScope,
    resolved: &Path,
    mode: OpenAs,
) -> Result<(fs::File, PathBuf), OpenError> {
    let mut opts = fs::OpenOptions::new();
    match mode {
        OpenAs::Read | OpenAs::Dir => {
            opts.read(true);
        }
        OpenAs::Write => {
            opts.write(true).create(true);
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        /// `FILE_FLAG_BACKUP_SEMANTICS` — without it CreateFile refuses to open
        /// a DIRECTORY at all, and there would be no handle to validate.
        const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
        /// FILE_SHARE_READ | FILE_SHARE_WRITE. Note the ABSENCE of
        /// FILE_SHARE_DELETE: while this handle is held, the directory it names
        /// cannot be renamed or deleted, which is the swap the enumeration
        /// below would otherwise still be racing.
        const SHARE_NO_DELETE: u32 = 0x0000_0003;
        if mode == OpenAs::Dir {
            opts.custom_flags(FILE_FLAG_BACKUP_SEMANTICS).share_mode(SHARE_NO_DELETE);
        }
    }
    let file = opts
        .open(resolved)
        .map_err(|e| OpenError::Io(format!("could not open path: {e}")))?;

    match handle_real_path(&file) {
        Some(real) => {
            check_effective(scope, &real).map_err(OpenError::Denied)?;
            Ok((file, real))
        }
        // Nothing to compare against. Fall back to what gates 1 and 2 already
        // established rather than refusing every open on a platform that cannot
        // interrogate a handle.
        None => Ok((file, resolved.to_path_buf())),
    }
}

/// Resolve then open, with the handle check in between. The one entry point
/// every arm uses.
fn open_checked(
    scope: &FileScope,
    requested: &str,
    mode: OpenAs,
) -> Result<(fs::File, PathBuf), OpenError> {
    let resolved = resolve(scope, requested).map_err(OpenError::Denied)?;
    open_verified(scope, &resolved, mode)
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
                // The OPAQUE token, not the folder's absolute path: that path
                // names the host's OS account and folder layout to a peer who
                // was granted file access and nothing else. See JAILED_ROOT.
                FileScope::Jailed(_) => vec![JAILED_ROOT.to_string()],
                FileScope::Policy => fixed_drive_roots(),
            };
            log("list_roots", "", roots.len() as u64, "ok");
            FsResponse::Roots { roots }
        }

        FsRequest::List { path } => {
            // The handle is bound to `_dir` and HELD for the whole enumeration
            // on purpose: it was opened without FILE_SHARE_DELETE, so this
            // directory cannot be renamed or deleted out from under the read
            // below. Dropping it early would put the swap back on the table.
            let (_dir, dir) = match open_checked(scope, &path, OpenAs::Dir) {
                Ok(p) => p,
                Err(e) => {
                    log("list", &path, 0, &format!("{}: {}", e.tag(), e));
                    return FsResponse::error(e.into_message());
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
            // BEFORE the open: an over-limit read is refused without touching
            // the disk at all, which is what stopped `{"len": 9999999999}`
            // being an out-of-memory kill on the host.
            if len > MAX_READ_LEN {
                log("read", &path, len, "denied: over limit");
                return FsResponse::error(format!(
                    "read of {len} bytes is over the {MAX_READ_LEN}-byte limit; request it in chunks"
                ));
            }
            let (mut file, file_path) = match open_checked(scope, &path, OpenAs::Read) {
                Ok(p) => p,
                Err(e) => {
                    log("read", &path, 0, &format!("{}: {}", e.tag(), e));
                    return FsResponse::error(e.into_message());
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
            // Decode and size-check BEFORE the open, so an over-limit chunk
            // never even creates a file.
            let decoded = match BASE64_STANDARD.decode(&data) {
                Ok(d) => d,
                Err(e) => return FsResponse::error(format!("could not decode base64: {e}")),
            };
            if decoded.len() > MAX_WRITE_LEN {
                log("write", &path, decoded.len() as u64, "denied: over limit");
                return FsResponse::error(format!(
                    "write of {} bytes is over the {MAX_WRITE_LEN}-byte limit; send it in chunks",
                    decoded.len()
                ));
            }
            let (mut file, file_path) = match open_checked(scope, &path, OpenAs::Write) {
                Ok(p) => p,
                Err(e) => {
                    log("write", &path, 0, &format!("{}: {}", e.tag(), e));
                    return FsResponse::error(e.into_message());
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

    /// A real directory that exists AND that both scopes allow.
    ///
    /// NOT `std::env::temp_dir()`, which this used to be: on Windows that is
    /// `%USERPROFILE%\AppData\Local\Temp`, and AppData is on the denylist —
    /// which since L8-NATIVE-2 applies to `Jailed` as well as `Policy`. A test
    /// rooted there is refused because of WHERE IT STARTS, which would make an
    /// "allowed" test fail and — far worse — make a "denied" test pass without
    /// ever exercising the thing it claims to check. The junction tests below
    /// are exactly that trap: built under temp_dir they would be refused for
    /// their base rather than for the junction, and would have looked green.
    fn tempdir(tag: &str) -> PathBuf {
        let home = std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
            .expect("a home directory to test under");
        let p = PathBuf::from(home).join(format!("puca-ft-{tag}-{}", stamp()));
        fs::create_dir_all(&p).unwrap();
        let c = p.canonicalize().unwrap();
        // Guard the guard, for BOTH scopes: if this location is itself denied,
        // every test using it is meaningless, so say so instead of reporting a
        // pass.
        assert!(
            resolve(&FileScope::Policy, &c.to_string_lossy()).is_ok(),
            "the test fixture directory {} must itself be allowed by Policy, \
             or the tests built on it prove nothing",
            c.display()
        );
        assert!(
            resolve(&FileScope::Jailed(c.clone()), &c.to_string_lossy()).is_ok(),
            "the test fixture directory {} must itself be allowed as a jail root, \
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
    fn a_path_naming_another_volume_is_refused() {
        let r = root();
        if cfg!(windows) {
            // A path that NAMES A VOLUME is a claim about somewhere else on
            // this machine, and there is no jail it could be inside.
            assert!(resolve(&jailed(), "C:\\Windows\\System32\\config\\SAM").is_err());
        }

        // Positive control: an absolute path INSIDE the root is fine, so the
        // rejection above is about location and not about absoluteness.
        let inside = r.join("notes.txt");
        assert_resolves_to(&jailed(), &inside.to_string_lossy(), &inside);
    }

    #[test]
    fn a_rootless_path_is_taken_against_the_jail_not_the_real_root() {
        // THE OPAQUE-ROOT CONTRACT (INFO-2). The controller is handed
        // JAILED_ROOT and joins onto it, so `/etc/shadow` and
        // `\Windows\System32\config\SAM` name locations INSIDE the granted
        // folder — they can no longer denote the real ones at all.
        //
        // Asserted as containment rather than as a refusal, because a refusal
        // is what the pre-INFO-2 code did and this is deliberately the safer
        // of the two: under a jail there is now NO spelling of an absolute
        // path that leaves it.
        let r = root();
        assert_resolves_to(&jailed(), JAILED_ROOT, &r);
        assert_resolves_to(&jailed(), "/notes.txt", &r.join("notes.txt"));
        assert_resolves_to(&jailed(), "/sub/notes.txt", &r.join("sub").join("notes.txt"));
        let escape = if cfg!(windows) {
            "\\Windows\\System32\\config\\SAM"
        } else {
            "/etc/shadow"
        };
        let got = resolve(&jailed(), escape).expect("a rootless path re-bases into the jail");
        assert!(
            is_within(&got, &r),
            "{escape} must land inside the jail, got {}",
            got.display()
        );

        // And `..` still cannot climb out of the re-based path, or the
        // re-basing would be a way round gate 1.
        assert!(resolve(&jailed(), "/../secrets.txt").is_err());
    }

    #[test]
    fn a_rootless_path_is_still_refused_under_policy() {
        // Positive control for the re-basing: it is the JAIL that supplies the
        // base. Under Policy there is none, so a path that names no volume has
        // nothing to resolve against and must stay refused rather than being
        // quietly taken against some default.
        if !cfg!(windows) {
            return; // on unix a leading "/" IS an absolute path; nothing to test
        }
        let err = resolve(&FileScope::Policy, "\\Windows\\System32\\config\\SAM").unwrap_err();
        assert!(err.contains("relative"), "{err}");
    }

    #[test]
    fn a_sibling_directory_sharing_the_root_prefix_is_refused() {
        // "C:\granted-evil" starts with "C:\granted" as a STRING but is not
        // under it. The comparison is component-wise, which is why this passes
        // -- pin it so nobody "optimises" it into a string compare.
        let r = root();
        if cfg!(windows) {
            assert!(resolve(&jailed(), "C:\\granted-evil\\loot.txt").is_err());
        }
        // Asserted as containment rather than as a refusal on unix, where a
        // rootless path is re-based into the jail: `/granted-evil/loot.txt`
        // names a folder INSIDE the granted one. Either way the property is
        // the same and it is the one that matters — the real sibling directory
        // is not reachable.
        let sibling = if cfg!(windows) {
            "C:\\granted-evil\\loot.txt"
        } else {
            "/granted-evil/loot.txt"
        };
        match resolve(&jailed(), sibling) {
            Err(_) => {}
            Ok(got) => assert!(
                is_within(&got, &r),
                "{sibling} must never resolve to the real sibling, got {}",
                got.display()
            ),
        }
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
        let dir = tempdir("policy-allow");
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
        let dir = tempdir("shape-control");
        let ordinary = dir.join("Recovery").join("notes.txt");
        assert!(
            resolve(&FileScope::Policy, &ordinary.to_string_lossy()).is_ok(),
            "a Recovery folder that is not at a drive root must be browsable"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_grant_inside_appdata_is_refused_at_grant_time_and_says_why() {
        if !cfg!(windows) {
            return;
        }
        // The system temp directory lives under %LOCALAPPDATA%\Temp — the
        // exact kind of folder a user pastes from a shell. Before the check
        // moved forward, this grant SUCCEEDED and only the peer's first
        // listing was refused, with a message that named neither.
        let temp = std::env::temp_dir();
        let err = FileScope::jailed(&temp.to_string_lossy())
            .err()
            .expect("a folder under AppData must not become a grant");
        assert!(err.contains("AppData"), "the refusal must name the rule, got: {err}");

        // POSITIVE CONTROL: an ordinary folder under the profile is granted —
        // without this, a jailed() that refused everything would pass above.
        let dir = tempdir("jail-grant");
        assert!(
            matches!(FileScope::jailed(&dir.to_string_lossy()), Ok(FileScope::Jailed(_))),
            "an ordinary folder must still be grantable"
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
        let dir = tempdir("policy-newfile");
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
    fn listing_roots_does_not_disclose_the_granted_folders_absolute_path() {
        // INFO-2. The absolute path names the host's OS account
        // (`C:\Users\<real name>\…`) and their folder layout, to a peer who was
        // granted FILE ACCESS and nothing else. The peer gets an opaque token.
        let dir = tempdir("roots-opaque");
        let scope = FileScope::Jailed(dir.clone());
        match handle_request(FsRequest::ListRoots, &scope, None) {
            FsResponse::Roots { roots } => {
                assert_eq!(roots, vec![JAILED_ROOT.to_string()]);
                // Said the other way round too, so a future "helpful" label
                // that happens to embed the path fails this rather than
                // passing it: NO root may contain the granted prefix. The
                // last component alone would still leak a folder name, and the
                // parent chain is the part that carries the account name.
                for r in &roots {
                    assert!(
                        !r.contains(&*dir.to_string_lossy()),
                        "a root must not carry the granted folder's absolute path: {r}"
                    );
                }
            }
            other => panic!("expected roots, got {other:?}"),
        }

        // POSITIVE CONTROL: the token the peer is handed must actually WORK —
        // a redaction that made the root unusable would pass the assertions
        // above while breaking every browse.
        fs::write(dir.join("notes.txt"), b"hi").unwrap();
        match handle_request(FsRequest::List { path: JAILED_ROOT.into() }, &scope, None) {
            FsResponse::List { entries, .. } => {
                assert!(
                    entries.iter().any(|e| e.name == "notes.txt"),
                    "listing the opaque root must show the granted folder's contents"
                );
            }
            other => panic!("expected a list, got {other:?}"),
        }

        let _ = fs::remove_dir_all(&dir);
    }

    // ---- L8-NATIVE-2: the denials apply to a JAIL too ----------------------

    #[test]
    fn a_jail_refuses_the_agents_own_state_and_ssh_keys() {
        // The composition this closes: an attended grant of the user's HOME
        // folder — the obvious thing to pick in a folder picker — used to
        // expose %LOCALAPPDATA%\com.sovereign.chat (the armed record, the
        // device key, and the WebView profile holding the remembered
        // unattended signing seed) and ~/.ssh, because the denylist lived
        // inside resolve()'s Policy arm where Jailed could not reach it.
        let home = tempdir("jail-denied");
        let scope = FileScope::Jailed(home.clone());
        for attempt in [
            home.join("AppData").join("Local").join("com.sovereign.chat")
                .join("device").join("unattended.json"),
            home.join(".ssh").join("id_ed25519"),
            home.join(".aws").join("credentials"),
        ] {
            let got = resolve(&scope, &attempt.to_string_lossy());
            assert!(
                got.is_err(),
                "{} must be refused under a jail, got {got:?}",
                attempt.display()
            );
        }

        // POSITIVE CONTROL, and it is the assertion that matters: a resolve
        // that refused EVERYTHING would satisfy the loop above while making
        // the whole feature useless.
        let ordinary = home.join("Documents").join("notes.txt");
        assert!(
            resolve(&scope, &ordinary.to_string_lossy()).is_ok(),
            "an ordinary file under the same grant must still resolve"
        );

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn a_jail_refuses_a_denied_root_it_was_granted_through() {
        // The other half: the denial is by LOCATION as well as by shape, and
        // the entry that matters most is the agent's own data directory.
        if !cfg!(windows) {
            return;
        }
        let Ok(lad) = std::env::var("LOCALAPPDATA") else { return };
        let state = PathBuf::from(&lad).join("com.sovereign.chat");
        // The jail root itself is inside a denied root, so nothing under it
        // resolves — including the grant's own folder.
        let scope = FileScope::Jailed(state.clone());
        let got = resolve(&scope, JAILED_ROOT);
        assert!(
            got.is_err(),
            "a jail rooted at the agent's own state must resolve nothing, got {got:?}"
        );
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
        let base = tempdir("junction-policy");
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

    // ---- INFO-4: the grant canonicalises, or it is not a grant -------------

    #[test]
    #[cfg(windows)]
    fn a_grant_reached_through_a_junction_is_usable() {
        // THE LIVE FAILURE. `resolve` canonicalises the TARGET and compares it
        // against the root, so a root that was never canonicalised — reached
        // through a junction, a directory symlink, a `subst` drive or an 8.3
        // short name, all ordinary on Windows — resolved out from under itself
        // and EVERY operation inside the folder the user had just picked was
        // refused with "path leaves the granted folder through a link".
        let base = tempdir("grant-canon");
        let real = base.join("real");
        fs::create_dir_all(&real).unwrap();
        fs::write(real.join("notes.txt"), b"fine").unwrap();

        let link = base.join("link");
        assert!(
            make_junction(&link, &real),
            "could not create a test junction; INFO-4 is UNVERIFIED on this machine"
        );

        // POSITIVE CONTROL, and it is the bug itself: granted RAW, the folder
        // refuses its own contents — gate 2 canonicalises `link\notes.txt` to
        // `real\notes.txt`, which is not under the raw root `link`. The peer's
        // request is the ordinary one (a path relative to the granted folder,
        // which is all the opaque root ever gives it). If this ever starts
        // passing, the constructor below has stopped being what fixes it.
        let raw = FileScope::Jailed(link.clone());
        let refused = resolve(&raw, "notes.txt").unwrap_err();
        assert!(
            refused.contains("link"),
            "the un-canonicalised grant must still fail exactly this way, got: {refused}"
        );

        // And the fix: canonicalised at the grant, the folder works — both
        // relative and through the opaque root the peer is actually handed.
        let scope = FileScope::jailed(&link.to_string_lossy()).expect("the folder resolves");
        assert!(
            resolve(&scope, "notes.txt").is_ok(),
            "a grant made through FileScope::jailed must be usable"
        );
        assert!(resolve(&scope, "/notes.txt").is_ok());

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn a_grant_of_a_folder_that_does_not_exist_fails_at_grant_time() {
        // Failing CLOSED: a root we cannot resolve is a jail we cannot enforce,
        // so it must not become a grant that silently checks against a path the
        // filesystem disagrees with.
        let missing = tempdir("grant-missing").join("no-such-folder");
        let got = FileScope::jailed(&missing.to_string_lossy());
        assert!(got.is_err(), "an unresolvable root must not be granted");

        // Positive control: the constructor is not simply always-Err.
        let real = tempdir("grant-real");
        assert!(FileScope::jailed(&real.to_string_lossy()).is_ok());
        let _ = fs::remove_dir_all(&real);
    }

    // ---- L8-NATIVE-1 / gate 3: the handle, not the path --------------------

    #[cfg(windows)]
    fn make_dir_link(link: &Path, target: &Path) -> bool {
        make_junction(link, target)
    }

    #[cfg(unix)]
    fn make_dir_link(link: &Path, target: &Path) -> bool {
        std::os::unix::fs::symlink(target, link).is_ok()
    }

    #[test]
    fn this_platform_can_derive_a_path_from_an_open_handle() {
        // Gate 3 degrades to nothing on a platform that cannot answer "where
        // does this handle actually point". Without this assertion the test
        // below would pass for that reason and look like a working defence.
        let dir = tempdir("handle-avail");
        let f = dir.join("x.txt");
        fs::write(&f, b"x").unwrap();
        let file = fs::File::open(&f).unwrap();
        let real = handle_real_path(&file)
            .expect("gate 3 needs a handle-to-path syscall on this platform");
        assert!(
            is_within(&real, &dir),
            "{} should be inside {}",
            real.display(),
            dir.display()
        );
        drop(file);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_open_is_validated_by_the_handle_not_by_the_path() {
        // THE RESOLVE-THEN-OPEN RACE. `open_verified` is driven directly with a
        // path `resolve` would have refused, because that is exactly the state
        // a lost race leaves behind — the check passed, and then the object
        // moved — and there is no deterministic way to lose a race on purpose.
        let base = tempdir("handle-gate");
        let inside = base.join("granted");
        let outside = base.join("secrets");
        fs::create_dir_all(&inside).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("loot.txt"), b"top secret").unwrap();
        fs::write(inside.join("notes.txt"), b"fine").unwrap();

        let link = inside.join("escape");
        assert!(
            make_dir_link(&link, &outside),
            "could not create a test link; gate 3 is UNVERIFIED on this machine"
        );

        let scope = FileScope::Jailed(inside.clone());

        // POSITIVE CONTROL FIRST: a file genuinely inside the jail must open,
        // or "everything is refused" would look like a working gate.
        let ok = open_verified(&scope, &inside.join("notes.txt"), OpenAs::Read);
        assert!(ok.is_ok(), "a file inside the jail must open: {:?}", ok.err());
        let dir_ok = open_verified(&scope, &inside, OpenAs::Dir);
        assert!(dir_ok.is_ok(), "the jail root must open as a directory: {:?}", dir_ok.err());

        // The gate: lexically inside, actually outside.
        let attempt = link.join("loot.txt");
        assert!(
            is_within(&attempt, &inside),
            "the fixture must be LEXICALLY inside, or this proves nothing about gate 3"
        );
        let got = open_verified(&scope, &attempt, OpenAs::Read);
        assert!(
            got.is_err(),
            "the handle's real path is outside the jail and must be refused, got {:?}",
            got.map(|(_, p)| p)
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
