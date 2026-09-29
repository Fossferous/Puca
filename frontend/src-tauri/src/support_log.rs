//! The desktop half of "Send diagnostics to the server owner": this app's own
//! log files, as one text, for the person to send through an encrypted DM.
//!
//! The webview cannot read `%LOCALAPPDATA%\com.sovereign.chat\logs` itself, and
//! "press Win+R and paste this path" is exactly the step people give up on.
//!
//! What goes out is what the log holds: minute-by-minute call health, the
//! share's frame rate and encoder, audio and clip capture events, and the
//! names of programs (whose audio was shared, or which were in front when a
//! hotkey could not be heard). It never held messages, keys or addresses; the
//! one personal thing a path can carry, the Windows account name in
//! `C:\Users\<name>\…`, is replaced before the text leaves this module.

use std::path::{Path, PathBuf};

/// The log plugin's file name (lib.rs: `file_name: Some("puca")`). Archives are
/// `puca_<yyyy-mm-dd_hh-mm-ss>.log` beside the active `puca.log`.
const STEM: &str = "puca";

/// The most text sent. The files rotate at 2 MB and three are kept, so this
/// only bites if that changes; the NEWEST text is the part kept, because the
/// problem being reported is the recent one.
pub const MAX_BYTES: usize = 8 * 1024 * 1024;

/// This app's log files, oldest first: dated archives in name order (the date
/// in the name sorts), then the active file last.
pub fn log_files(dir: &Path) -> Vec<PathBuf> {
    let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut archives = Vec::new();
    let mut active = None;
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name == format!("{STEM}.log") {
            active = Some(entry.path());
        } else if name.starts_with(&format!("{STEM}_")) && name.ends_with(".log") {
            archives.push(entry.path());
        }
    }
    archives.sort();
    archives.extend(active);
    archives
}

/// Every file under a header naming it, oldest first, cut to the newest
/// `max` bytes at a line boundary.
pub fn gather(files: &[PathBuf], max: usize) -> String {
    if files.is_empty() {
        return "(no log files)\n".to_string();
    }
    let mut out = String::new();
    for f in files {
        let name = f.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        out.push_str(&format!("===== {name} =====\n"));
        match std::fs::read(f) {
            Ok(bytes) => out.push_str(&String::from_utf8_lossy(&bytes)),
            Err(e) => out.push_str(&format!("(could not read: {e})\n")),
        }
        if !out.ends_with('\n') {
            out.push('\n');
        }
    }
    keep_newest(out, max)
}

fn keep_newest(text: String, max: usize) -> String {
    if text.len() <= max {
        return text;
    }
    let mut cut = text.len() - max;
    while !text.is_char_boundary(cut) {
        cut += 1;
    }
    let start = text[cut..].find('\n').map(|i| cut + i + 1).unwrap_or(cut);
    format!(
        "(older lines dropped: the report keeps the newest {} KB)\n{}",
        max / 1024,
        &text[start..]
    )
}

/// `…\Users\<name>\…` → `…\Users\<user>\…`, either slash, any case.
pub fn redact_user_paths(text: &str) -> String {
    let lower = text.to_ascii_lowercase();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < text.len() {
        let rest = &lower[i..];
        if rest.starts_with("\\users\\") || rest.starts_with("/users/") {
            out.push_str(&text[i..i + 7]);
            i += 7;
            // An account name can hold spaces ("Jo Smith"), so the segment
            // runs to the next path separator when one follows on the same
            // line; with none (a bare `…\Users\jo` at the end), to the next
            // blank, quote or line end.
            let rest = &text[i..];
            let line_end = rest
                .find(|c: char| matches!(c, '"' | '\'' | '\n' | '\r'))
                .unwrap_or(rest.len());
            let seg_len = rest[..line_end]
                .find(|c: char| matches!(c, '\\' | '/'))
                .or_else(|| rest[..line_end].find(char::is_whitespace))
                .unwrap_or(line_end);
            if seg_len > 0 {
                out.push_str("<user>");
            }
            i += seg_len;
        } else {
            let ch = text[i..].chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    out
}

/// The whole log, redacted, for the report.
#[tauri::command]
pub async fn read_support_log(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        redact_user_paths(&gather(&log_files(&dir), MAX_BYTES))
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("puca-support-log-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn archives_oldest_first_then_the_active_file_and_nothing_else() {
        let d = tmp("order");
        for (n, body) in [
            ("puca.log", "active\n"),
            ("puca_2026-09-28_05-22-52.log", "newer\n"),
            ("puca_2026-09-26_17-20-49.log", "older\n"),
            ("sovereign.log", "other app name\n"),
            ("puca.txt", "not a log\n"),
        ] {
            std::fs::write(d.join(n), body).unwrap();
        }
        let files = log_files(&d);
        let names: Vec<String> =
            files.iter().map(|f| f.file_name().unwrap().to_string_lossy().to_string()).collect();
        assert_eq!(names, ["puca_2026-09-26_17-20-49.log", "puca_2026-09-28_05-22-52.log", "puca.log"]);
        let text = gather(&files, MAX_BYTES);
        let (o, n, a) = (text.find("older").unwrap(), text.find("newer").unwrap(), text.find("active").unwrap());
        assert!(o < n && n < a, "{text}");
        assert!(text.contains("===== puca.log =====\nactive\n"), "{text}");
        assert!(!text.contains("other app name") && !text.contains("not a log"), "{text}");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn no_logs_says_so() {
        let d = tmp("empty");
        assert_eq!(gather(&log_files(&d), MAX_BYTES), "(no log files)\n");
        assert_eq!(gather(&log_files(&d.join("missing")), MAX_BYTES), "(no log files)\n");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn an_oversized_log_keeps_the_newest_whole_lines() {
        let text: String = (0..1000).map(|i| format!("line {i:04}\n")).collect();
        assert_eq!(keep_newest(text.clone(), 1024 * 1024), text, "under the cap nothing changes");
        let kept = keep_newest(text, 105);
        assert!(kept.starts_with("(older lines dropped"), "{kept}");
        let body: Vec<&str> = kept.lines().skip(1).collect();
        assert_eq!(body.last(), Some(&"line 0999"));
        assert!(body.iter().all(|l| l.len() == 9 && l.starts_with("line ")), "no half line: {body:?}");
        assert!(!body.is_empty() && body.len() <= 11, "{body:?}");
    }

    #[test]
    fn the_account_name_in_a_path_is_replaced() {
        let s = r#"[gpu-pin] wrote for C:\Users\Zeuso Smith\AppData\x.exe and c:/users/bob/y and "C:\USERS\ann" C:\Program Files\z"#;
        let r = redact_user_paths(s);
        for name in ["Zeuso", "Smith", "bob", "ann"] {
            assert!(!r.contains(name), "{name} survived: {r}");
        }
        assert!(r.contains(r"C:\Users\<user>\AppData\x.exe"), "{r}");
        assert!(r.contains("c:/users/<user>/y"), "{r}");
        assert!(r.contains(r#""C:\USERS\<user>""#), "{r}");
        assert!(r.contains(r"C:\Program Files\z"), "untouched: {r}");
        assert_eq!(redact_user_paths(r"at C:\Users\jo then"), r"at C:\Users\<user> then");
        assert_eq!(redact_user_paths("héllo \\users\\"), "héllo \\users\\", "nothing after the prefix");
        let clean = "[stream-diag] health t=5min heap236MB ü";
        assert_eq!(redact_user_paths(clean), clean);
    }
}
