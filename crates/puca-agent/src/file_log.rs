//! Append-only audit trail for remote file access.
//!
//! WHY THIS EXISTS. Until now, browsing a host's files required a human at that
//! machine to approve a folder, and the approval dialog WAS the notification —
//! you knew it happened because you clicked it. Unattended access removes the
//! dialog, so it also removes the only local evidence. Without something in its
//! place, "armed" would mean "readable and writable, silently, with no trace on
//! the machine at all".
//!
//! So this is not decoration on the feature; it is the half of it that replaces
//! consent. The tray indicator says access is happening NOW; this file says what
//! happened while nobody was looking.
//!
//! REFUSALS ARE LOGGED TOO, and they are the interesting entries. A run of
//! `denied` lines against system paths is what an attempted escape looks like;
//! logging only successes would hide exactly the thing worth seeing.
//!
//! Owned by the AGENT, not the webview: the agent is the process that actually
//! touches the disk, and it outlives the window (the deployment this exists for
//! is autostart + close-to-tray, where there may be no window at all).
//!
//! The log's own directory is on the denylist in `file_transfer.rs`. An audit
//! trail a remote peer can rewrite is not an audit trail.

use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

/// Roll over past this size, so a long-lived host cannot fill its own disk.
/// One generation is kept: enough to survive a rotation mid-incident, without
/// pretending to be a log pipeline.
const MAX_BYTES: u64 = 8 * 1024 * 1024;

pub struct FileAudit {
    path: PathBuf,
    session_id: String,
    /// Serialises appends. Every write is open-append-close rather than a held
    /// handle: a held handle would keep the file locked against the rotation
    /// below, and an audit line that is lost because the writer was mid-rotate
    /// is the one line you needed.
    lock: Mutex<()>,
}

/// Where the log goes: the agent's own data directory, the same one
/// `unattended_store.rs` writes `unattended.json` into. Deliberately the same
/// place, because that directory is already the one the denylist refuses to
/// serve — putting the audit trail anywhere else would mean protecting a second
/// location and remembering to keep them in step.
pub fn agent_data_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    let base = std::env::var("LOCALAPPDATA").ok()?;
    #[cfg(not(windows))]
    let base = format!("{}/.local/share", std::env::var("HOME").ok()?);
    Some(PathBuf::from(base).join("com.sovereign.chat").join("device"))
}

impl FileAudit {
    /// `dir` is the agent's own data directory — the same one that holds
    /// `unattended.json`, and the one the denylist refuses to serve.
    pub fn new(dir: PathBuf, session_id: String) -> Self {
        Self {
            path: dir.join("file-access.log"),
            session_id,
            lock: Mutex::new(()),
        }
    }

    /// One line per operation. `result` is `ok` or a short reason.
    ///
    /// Deliberately infallible: a failure to log must not fail the operation or
    /// panic the stream thread. A dropped line is bad; a dead session because
    /// the disk was full is worse.
    pub fn record(&self, op: &str, path: &str, bytes: u64, result: &str) {
        // A PROCESS-WIDE lock, because the path is process-wide.
        //
        // Every stream builds its own FileAudit, each with its own mutex, and all
        // of them append to the same file. Two concurrent sessions therefore
        // serialised against different locks and raced on one path: two rotations
        // could fire together (one renaming the file the other had just opened,
        // losing its lines), and interleaved appends could split a line.
        // Per-instance locking is the wrong granularity for a shared resource.
        static LOG: Mutex<()> = Mutex::new(());
        let Ok(_shared) = LOG.lock() else { return };
        let Ok(_guard) = self.lock.lock() else { return };

        if let Ok(meta) = std::fs::metadata(&self.path) {
            if meta.len() >= MAX_BYTES {
                // Single generation. Failure here is ignored on purpose: if the
                // rename cannot happen we keep appending to an oversized file,
                // which is still better than losing the trail.
                let _ = std::fs::rename(&self.path, self.path.with_extension("log.1"));
            }
        }

        // Hand-built rather than serde_json: the values are short and this
        // avoids allocating a map per logged operation on the stream thread.
        let line = format!(
            "{{\"ts\":{},\"session\":\"{}\",\"op\":\"{}\",\"path\":\"{}\",\"bytes\":{},\"result\":\"{}\"}}\n",
            unix_millis(),
            escape(&self.session_id),
            escape(op),
            escape(path),
            bytes,
            escape(result),
        );

        if let Some(parent) = self.path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&self.path) {
            let _ = f.write_all(line.as_bytes());
        }
    }
}

fn unix_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Escape for a JSON string. Paths carry backslashes on Windows and can carry
/// quotes anywhere; an unescaped one would produce a line no parser can read,
/// which is the same as not logging it.
fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escaping_survives_a_windows_path_with_quotes() {
        assert_eq!(escape(r"C:\a\b"), r"C:\\a\\b");
        assert_eq!(escape("say \"hi\""), "say \\\"hi\\\"");
        assert_eq!(escape("a\nb"), "a\\nb");
    }

    #[test]
    fn a_recorded_line_is_parseable_json_and_names_the_operation() {
        let dir = std::env::temp_dir().join(format!("sov-audit-{}", unix_millis()));
        std::fs::create_dir_all(&dir).unwrap();
        let a = FileAudit::new(dir.clone(), "ds-test".into());
        a.record("read", r"C:\some\path.txt", 42, "ok");

        let body = std::fs::read_to_string(dir.join("file-access.log")).unwrap();
        assert!(body.contains("\"op\":\"read\""), "{body}");
        assert!(body.contains("\"bytes\":42"), "{body}");
        assert!(body.contains(r#""path":"C:\\some\\path.txt""#), "{body}");
        // The line must be ONE line — a multi-line entry breaks jsonl parsing.
        assert_eq!(body.trim().lines().count(), 1, "{body}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_refusal_is_recorded_not_dropped() {
        // Positive control for the "refusals are the interesting entries" claim:
        // if record() only wrote successes this would find an empty file.
        let dir = std::env::temp_dir().join(format!("sov-audit-deny-{}", unix_millis()));
        std::fs::create_dir_all(&dir).unwrap();
        let a = FileAudit::new(dir.clone(), "ds-test".into());
        a.record("read", r"C:\Windows\System32\config\SAM", 0, "denied: system path");

        let body = std::fs::read_to_string(dir.join("file-access.log")).unwrap();
        assert!(body.contains("denied"), "{body}");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
