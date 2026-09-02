//! Disk sink for peer-to-peer file transfers.
//!
//! The browser cannot stream gigabytes to disk; this is why the desktop app is
//! the platform where "no cap" is actually true. See
//! docs/P2P_FILE_TRANSFER_PLAN.md §5.
//!
//! Two deliberate choices:
//!
//! 1. **JS never names a path.** Commands take a transfer id and look up a file
//!    handle held here. The only filename input from outside is the offered
//!    name, which comes from ANOTHER USER and is sanitized before it touches
//!    the filesystem — a peer must not be able to talk this process into
//!    writing to `..\..\Windows\System32` or a reserved device name.
//! 2. **Bytes land in `<name>.part` and are renamed only on success.** A
//!    partial transfer is therefore never mistaken for a complete file, and the
//!    partial is what a resume appends to.

use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::ipc::{InvokeBody, Request};
use tauri::Manager;

/// Open partial files, keyed by transfer id.
#[derive(Default)]
pub struct TransferFiles(Mutex<HashMap<String, OpenPart>>);

pub struct OpenPart {
    file: File,
    part_path: PathBuf,
    final_name: String,
    written: u64,
    /// Where the user asked for the file in a Save As dialog. None = the
    /// default <Downloads>/Puca with a de-duplicated name.
    chosen: Option<PathBuf>,
}

#[derive(Serialize)]
pub struct FinishResult {
    /// Where the completed file landed.
    pub path: String,
    /// Digest of the file AT REST, present only when verification was asked
    /// for. A resumed transfer cannot be verified any other way: the receiving
    /// process never saw the bytes the earlier attempt wrote.
    pub sha256: Option<String>,
}

/// Hash a finished file in chunks — never loads it into memory.
fn hash_file(path: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let mut file = File::open(path).map_err(|e| format!("could not reopen {path:?}: {e}"))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).map_err(|e| format!("read failed: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

#[derive(Serialize)]
pub struct BeginResult {
    /// Bytes already on disk from a previous attempt — the offset to resume at.
    pub existing_bytes: u64,
    /// Shown in the UI so the user knows where it is going.
    pub path: String,
}

/// Strip everything that could escape the download directory or confuse
/// Windows. The name arrives from a peer, so it is untrusted input.
fn sanitize_file_name(raw: &str) -> String {
    // Take the last path segment: a peer sending "../../x" or "C:\\x" must not
    // get any say in the directory.
    let base = raw
        .rsplit(|c| c == '/' || c == '\\')
        .next()
        .unwrap_or("file");

    let mut cleaned: String = base
        .chars()
        .map(|c| match c {
            // Reserved on Windows, plus control characters.
            '<' | '>' | ':' | '"' | '|' | '?' | '*' | '\0' => '_',
            c if (c as u32) < 0x20 => '_',
            c => c,
        })
        .collect();

    // "." and ".." are not names. A trailing dot or space is silently stripped
    // by Windows, which would make the on-disk name differ from what we report.
    cleaned = cleaned.trim_matches(|c: char| c == '.' || c.is_whitespace()).to_string();
    if cleaned.is_empty() {
        cleaned = "file".to_string();
    }

    // Reserved DOS device names are invalid even with an extension.
    const RESERVED: [&str; 22] = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
        "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    let stem = cleaned.split('.').next().unwrap_or("").to_ascii_uppercase();
    if RESERVED.contains(&stem.as_str()) {
        cleaned = format!("_{cleaned}");
    }

    // Leave room for the ".part" suffix and a dedup counter.
    //
    // NOT a bare `String::truncate`: `len()` is bytes and truncate panics
    // unless the index is a char boundary, so a long CJK or emoji name would
    // panic here. That panic unwinds the command task, the `invoke` promise
    // never settles, and the download button sits disabled on "saving" forever
    // with no error — the silent-failure shape this codebase keeps producing.
    // The name comes from another user: exactly the input an attacker controls.
    if cleaned.len() > 200 {
        let mut end = 200;
        while end > 0 && !cleaned.is_char_boundary(end) {
            end -= 1;
        }
        cleaned.truncate(end);
    }
    cleaned
}

/// `name.ext` -> `name (2).ext` until nothing is overwritten. A completed
/// transfer must never clobber a file the user already had.
fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    for n in 2..10_000 {
        let candidate = dir.join(format!("{stem} ({n}){ext}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    dir.join(format!("{stem} ({}){ext}", uuid_like()))
}

/// A destination the user picked in the OS Save As dialog. The dialog returns
/// an absolute path with a file name; anything else is a caller bug and is
/// refused rather than resolved against a working directory nobody chose.
fn chosen_destination(s: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(s);
    if !p.is_absolute() {
        return Err(format!("save destination must be an absolute path: {s:?}"));
    }
    if p.file_name().is_none() {
        return Err(format!("save destination has no file name: {s:?}"));
    }
    Ok(p)
}

/// Enough entropy to break a pathological tie, without pulling in a uuid crate.
fn uuid_like() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

/// Open (or reopen) the partial file for a transfer.
///
/// The `.part` name is keyed by the file's DIGEST, not its name: a resume must
/// find the partial belonging to the same bytes, and two different files can
/// share a name.
#[tauri::command]
pub async fn transfer_begin(
    app: tauri::AppHandle,
    state: tauri::State<'_, TransferFiles>,
    transfer_id: String,
    file_name: String,
    sha256: String,
    dest_path: Option<String>,
) -> Result<BeginResult, String> {
    // "Ask where to save files" (Settings): the frontend already ran the OS
    // Save As dialog and hands over the path the user picked. The partial
    // still lives beside it (same directory, digest-keyed name) so a resume
    // can find it.
    let chosen = dest_path.as_deref().map(chosen_destination).transpose()?;
    let dir = match &chosen {
        Some(p) => p
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| "chosen path has no parent directory".to_string())?,
        None => app
            .path()
            .download_dir()
            .map_err(|e| format!("no downloads directory: {e}"))?
            .join("Puca"),
    };
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {dir:?}: {e}"))?;

    // The chosen name is the user's own; it still goes through the sanitizer
    // because the .part sibling is built from it.
    let safe_name = match &chosen {
        Some(p) => p
            .file_name()
            .and_then(|n| n.to_str())
            .map(sanitize_file_name)
            .ok_or_else(|| "chosen path has no file name".to_string())?,
        None => sanitize_file_name(&file_name),
    };
    // Digest-keyed, so a resume reopens the right partial even if another
    // transfer shares the display name.
    // Hex-only, because this lands in a path. The digest is peer-chosen: it
    // rides the sender's FileOffer and the server only relays it here. Today
    // ws.rs refuses an offer whose sha256 is not exactly 64 ascii-hex bytes, so
    // nothing hostile reaches this line in the shipped product — but that check
    // lives on a remote machine, and `dir.join()` on a string carrying `..` and
    // a separator escapes the download directory. `sanitize_file_name` is
    // applied to the name one line up for the same reason; the digest was the
    // half that trusted somebody else to have checked.
    let digest_key: String = sha256
        .chars()
        .filter(|c| c.is_ascii_hexdigit())
        .take(16)
        .collect();
    let part_path = dir.join(format!("{safe_name}.{digest_key}.part"));

    let existing_bytes = std::fs::metadata(&part_path).map(|m| m.len()).unwrap_or(0);

    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&part_path)
        .map_err(|e| format!("could not open {part_path:?}: {e}"))?;

    state.0.lock().unwrap().insert(
        transfer_id,
        OpenPart { file, part_path: part_path.clone(), final_name: safe_name, written: existing_bytes, chosen },
    );

    Ok(BeginResult {
        existing_bytes,
        path: part_path.to_string_lossy().to_string(),
    })
}

/// Append one chunk. The bytes ride as a RAW ipc body — serializing 16 KiB as a
/// JSON array of numbers would inflate it several-fold and dominate the cost of
/// the whole transfer.
#[tauri::command]
pub async fn transfer_write(
    state: tauri::State<'_, TransferFiles>,
    request: Request<'_>,
) -> Result<u64, String> {
    let transfer_id = request
        .headers()
        .get("x-transfer-id")
        .and_then(|v| v.to_str().ok())
        .ok_or("missing transfer id")?
        .to_string();

    let bytes = match request.body() {
        InvokeBody::Raw(bytes) => bytes,
        _ => return Err("expected a raw body".into()),
    };

    let mut open = state.0.lock().unwrap();
    let part = open.get_mut(&transfer_id).ok_or("unknown transfer")?;
    part.file.write_all(bytes).map_err(|e| format!("write failed: {e}"))?;
    part.written += bytes.len() as u64;
    Ok(part.written)
}

/// Flush, close, and promote `.part` to its real name. Returns the final path.
#[tauri::command]
pub async fn transfer_finish(
    app: tauri::AppHandle,
    state: tauri::State<'_, TransferFiles>,
    transfer_id: String,
    verify: bool,
) -> Result<FinishResult, String> {
    let part = state.0.lock().unwrap().remove(&transfer_id).ok_or("unknown transfer")?;
    let OpenPart { mut file, part_path, final_name, chosen, .. } = part;
    file.flush().map_err(|e| format!("flush failed: {e}"))?;
    drop(file);

    // A user-chosen destination is written exactly where they said, replacing
    // what is there (the dialog already asked them); the default location
    // never clobbers an existing file.
    let final_path = match chosen {
        Some(p) => p,
        None => {
            let dir = app
                .path()
                .download_dir()
                .map_err(|e| format!("no downloads directory: {e}"))?
                .join("Puca");
            unique_path(&dir, &final_name)
        }
    };
    std::fs::rename(&part_path, &final_path)
        .map_err(|e| format!("could not finish {part_path:?}: {e}"))?;
    // After the rename, never on the .part: an abandoned partial is deleted,
    // and a stream written before a cross-volume rename would not follow. One
    // call covers both the default folder and a Save As destination.
    mark_as_internet_sourced(&final_path);

    let sha256 = if verify { Some(hash_file(&final_path)?) } else { None };
    Ok(FinishResult { path: final_path.to_string_lossy().to_string(), sha256 })
}

/// Close a transfer that did not complete. `keep` retains the partial so a
/// later attempt can resume; otherwise it is removed, because a corrupt or
/// abandoned partial left lying in Downloads is worse than nothing.
#[tauri::command]
pub async fn transfer_abort(
    state: tauri::State<'_, TransferFiles>,
    transfer_id: String,
    keep: bool,
) -> Result<(), String> {
    let Some(part) = state.0.lock().unwrap().remove(&transfer_id) else {
        return Ok(()); // already gone
    };
    let OpenPart { file, part_path, .. } = part;
    drop(file);
    if !keep {
        let _ = std::fs::remove_file(&part_path);
    }
    Ok(())
}

/// Save a decrypted attachment to the downloads folder.
///
/// Desktop needs its own path because the browser trick — an anchor with
/// `download` pointing at a `blob:` URL — is not reliable in a webview, and the
/// persistent form of that anchor is a security problem in its own right: a
/// blob document inherits the app's origin, and the MIME comes from whoever
/// sent the attachment.
///
/// Bytes ride as a RAW ipc body; the name comes in a header and goes through
/// the same sanitizer as a peer-to-peer transfer, because it is the same kind
/// of untrusted input.
#[tauri::command]
pub async fn attachment_save(app: tauri::AppHandle, request: Request<'_>) -> Result<String, String> {
    let raw_name = request
        .headers()
        .get("x-file-name")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("attachment");
    // The header is ASCII-only, so the sender's name arrives percent-encoded.
    let decoded = percent_decode(raw_name);
    let safe_name = sanitize_file_name(&decoded);

    let bytes = match request.body() {
        InvokeBody::Raw(bytes) => bytes,
        _ => return Err("expected a raw body".into()),
    };

    // "Ask where to save files": the frontend ran the OS dialog and sends the
    // chosen path in a second header, percent-encoded like the name.
    let dest = request
        .headers()
        .get("x-dest-path")
        .and_then(|v| v.to_str().ok())
        .map(percent_decode)
        .map(|s| chosen_destination(&s))
        .transpose()?;
    let path = match dest {
        Some(p) => {
            if let Some(parent) = p.parent() {
                std::fs::create_dir_all(parent).map_err(|e| format!("could not create {parent:?}: {e}"))?;
            }
            p
        }
        None => {
            let dir = app
                .path()
                .download_dir()
                .map_err(|e| format!("no downloads directory: {e}"))?
                .join("Puca");
            std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {dir:?}: {e}"))?;
            unique_path(&dir, &safe_name)
        }
    };
    std::fs::write(&path, bytes).map_err(|e| format!("could not write {path:?}: {e}"))?;
    mark_as_internet_sourced(&path);
    Ok(path.to_string_lossy().to_string())
}

/// Tag a saved file with the Mark of the Web (Windows).
///
/// A file that arrived from another person over the network is internet-sourced,
/// and Windows decides a lot on that basis: SmartScreen prompts before running
/// it, Office opens it in Protected View, and script hosts refuse it outright.
/// Without the mark, a received `.exe`/`.docm` looks locally-authored and every
/// one of those defences is skipped — the browser download path sets it, so a
/// file saved through this app was strictly less safe than the same file saved
/// through a browser.
///
/// Written as the `Zone.Identifier` alternate data stream; `ZoneId=3` is
/// URLZONE_INTERNET.
///
/// BEST EFFORT by design — the save has already succeeded, and failing it here
/// would be worse than an unmarked file. ADSs only exist on NTFS, so writing to
/// a FAT32/exFAT stick (a normal thing to do) fails and must not turn a
/// completed download into an error. Non-Windows targets have no equivalent
/// (Linux/macOS use xattrs with different semantics) and simply do nothing.
fn mark_as_internet_sourced(path: &std::path::Path) {
    #[cfg(windows)]
    {
        let mut ads = path.as_os_str().to_os_string();
        ads.push(":Zone.Identifier");
        if let Err(e) = std::fs::write(&ads, "[ZoneTransfer]\r\nZoneId=3\r\n") {
            log::debug!("could not write Mark of the Web for {path:?}: {e}");
        }
    }
    #[cfg(not(windows))]
    {
        let _ = path;
    }
}

/// Minimal percent-decoding for the filename header. Anything malformed is left
/// as-is; `sanitize_file_name` is what actually makes the result safe.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(v) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

/// Folders worth offering when the person at this machine is choosing what to
/// expose to a remote session.
///
/// `tauri-plugin-dialog` is not registered in this app, so there is no native
/// folder picker to call. Rather than make the user type an absolute path from
/// memory — and get "that is not a folder" back from the agent when they get it
/// wrong — offer the handful of directories that actually exist, resolved here
/// where the OS knows where they are.
///
/// Only directories that exist are returned, so nothing on this list can be
/// approved and then fail validation.
#[cfg(feature = "remote-control")]
#[tauri::command]
pub async fn shareable_folders(app: tauri::AppHandle) -> Vec<ShareableFolder> {
    let p = app.path();
    let candidates: Vec<(&str, Option<std::path::PathBuf>)> = vec![
        ("Puca downloads", p.download_dir().ok().map(|d| d.join("Puca"))),
        ("Downloads", p.download_dir().ok()),
        ("Documents", p.document_dir().ok()),
        ("Desktop", p.desktop_dir().ok()),
        ("Pictures", p.picture_dir().ok()),
    ];
    candidates
        .into_iter()
        .filter_map(|(label, path)| {
            let path = path?;
            if !path.is_dir() {
                return None;
            }
            Some(ShareableFolder {
                label: label.to_string(),
                path: path.to_string_lossy().to_string(),
            })
        })
        .collect()
}

#[cfg(feature = "remote-control")]
#[derive(serde::Serialize)]
pub struct ShareableFolder {
    pub label: String,
    pub path: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_any_attempt_to_escape_the_download_directory() {
        // The name comes from another user, so these are the inputs that matter.
        assert_eq!(sanitize_file_name("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_file_name(r"..\..\Windows\System32\evil.dll"), "evil.dll");
        assert_eq!(sanitize_file_name("/absolute/path.txt"), "path.txt");
        assert_eq!(sanitize_file_name(r"C:\Users\someone\thing.txt"), "thing.txt");
    }

    #[test]
    fn neutralises_names_windows_treats_specially() {
        assert_eq!(sanitize_file_name("CON"), "_CON");
        assert_eq!(sanitize_file_name("nul.txt"), "_nul.txt");
        // A trailing dot or space is silently dropped by Windows, which would
        // make the real name differ from the one reported to the user.
        assert_eq!(sanitize_file_name("report. "), "report");
        assert_eq!(sanitize_file_name("a<b>c:d|e?f*g.txt"), "a_b_c_d_e_f_g.txt");
    }

    #[test]
    fn never_produces_an_empty_or_dot_name() {
        assert_eq!(sanitize_file_name(""), "file");
        assert_eq!(sanitize_file_name("."), "file");
        assert_eq!(sanitize_file_name(".."), "file");
        assert_eq!(sanitize_file_name("   "), "file");
    }

    #[test]
    fn percent_decodes_a_header_name_before_sanitizing() {
        assert_eq!(percent_decode("holiday%20photo.png"), "holiday photo.png");
        assert_eq!(percent_decode("caf%C3%A9.txt"), "café.txt");
        // Malformed escapes are left alone rather than dropped.
        assert_eq!(percent_decode("100%.txt"), "100%.txt");
        // And an encoded traversal still gets sanitized afterwards.
        assert_eq!(sanitize_file_name(&percent_decode("..%2F..%2Fevil.dll")), "evil.dll");
    }

    #[test]
    fn keeps_ordinary_names_intact() {
        assert_eq!(sanitize_file_name("holiday photo.png"), "holiday photo.png");
        assert_eq!(sanitize_file_name("archive.tar.gz"), "archive.tar.gz");
    }

    #[test]
    fn bounds_the_length_so_the_part_suffix_still_fits() {
        let long = "x".repeat(500);
        assert!(sanitize_file_name(&long).len() <= 200);
    }

    /// The ASCII case above passes even with a byte-index `truncate`, because
    /// every ASCII byte is a char boundary — so it could never have caught the
    /// panic. These are multibyte, where the 200th byte lands mid-character.
    #[test]
    fn does_not_panic_on_multibyte_names_at_the_length_cap() {
        let cjk = format!("{}{}", "\u{4f60}".repeat(80), ".png");   // 3 bytes each
        let out = sanitize_file_name(&cjk);
        assert!(out.len() <= 200 && !out.is_empty());

        let emoji = "\u{1f4ce}".repeat(60);                          // 4 bytes each
        assert!(sanitize_file_name(&emoji).len() <= 200);

        // A mixed name whose cap falls INSIDE a multibyte sequence.
        let mixed = format!("a{}", "\u{20ac}".repeat(90));
        assert!(sanitize_file_name(&mixed).len() <= 200);
    }
}

#[cfg(test)]
mod chosen_destination_tests {
    use super::chosen_destination;

    #[test]
    fn an_absolute_path_with_a_name_is_accepted_as_given() {
        let p = if cfg!(windows) { r"C:\keep\report.pdf" } else { "/keep/report.pdf" };
        assert_eq!(chosen_destination(p).unwrap().to_string_lossy(), p);
    }

    #[test]
    fn a_relative_name_is_refused() {
        assert!(chosen_destination("report.pdf").is_err());
        assert!(chosen_destination("..\\report.pdf").is_err());
    }

    #[test]
    fn a_bare_root_has_no_file_name_and_is_refused() {
        let root = if cfg!(windows) { r"C:\" } else { "/" };
        assert!(chosen_destination(root).is_err());
    }
}

#[cfg(test)]
mod mark_of_the_web_tests {
    use super::mark_as_internet_sourced;

    #[test]
    fn a_finished_transfer_is_marked_on_windows_and_untouched_elsewhere() {
        let dir = std::env::temp_dir().join(format!("puca-motw-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let part = dir.join("x.part");
        std::fs::write(&part, b"hi").unwrap();
        let fin = dir.join("x.bin");
        std::fs::rename(&part, &fin).unwrap();
        mark_as_internet_sourced(&fin);
        #[cfg(windows)]
        {
            let mut ads = fin.as_os_str().to_os_string();
            ads.push(":Zone.Identifier");
            let zone = std::fs::read_to_string(&ads).expect("the Zone.Identifier stream exists");
            assert!(zone.contains("ZoneId=3"), "{zone}");
        }
        assert_eq!(std::fs::read(&fin).unwrap(), b"hi", "the file body is untouched");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
