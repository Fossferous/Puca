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

pub(crate) fn unix_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ------------------------------------------------------------ agent.log times
//
// EVERY agent.log LINE CARRIES THE UTC TIME IT WAS WRITTEN. Until now only the
// `--- puca-agent starting … ---` line did, and the rest said `+193.0s` at
// best (time since its stream started): reading the 2026-10-26 field log meant
// rebuilding a timeline from those offsets by hand, and lining it up with the
// controller's own log was guesswork.
//
// The log is the agent's STDERR, redirected at the OS level (main.rs), and
// every crate writes to it: puca-capture, puca-encode, puca-input and the
// agent's own `eprintln!`s. So the time is put on in ONE place they all pass
// through: stderr becomes a pipe, and a thread reads it, stamps each line with
// the time its first byte arrived (`LineStamper`) and appends it to the file
// (`pump_stamped`). The app appends its own `[host]` lines to the same file;
// whole lines, so the two never split each other.
//
// WHAT A HARD KILL LOSES. A line written to stderr is in the PIPE until the
// pump reads it, and in the file (the system's cache of it, which outlives
// the process) once the pump has written it. An exit through `drain_log`
// waits for the pump (bounded, 500 ms), and so does a panic. A process that
// is KILLED (TerminateProcess: Task Manager, the app's job closing, an
// installer replacing the binary) takes the pump with it, and loses what
// was still in the pipe: normally microseconds of lines (the pump runs at
// the highest normal priority, so it reads a line as soon as it is
// written), milliseconds under heavy load, and the end of a line whose
// newline had not been written. Before the pipe a write went straight to
// the file and a kill lost nothing written; this window is the price of the
// time on every line, and it is kept as short as a thread can make it.
// Measuring it needs a kill at a chosen moment, which no test here does.

/// `2026-10-26 02:36:44.123Z`: the UTC time put in front of each line.
/// Formatted by hand: the agent deliberately has no date crate.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn utc_stamp(unix_ms: u64) -> String {
    format!("{}.{:03}Z", utc_date_time(unix_ms / 1000), unix_ms % 1000)
}

/// `2026-10-26 02:36:44` for a count of seconds since 1970, UTC.
/// Civil-from-days (Howard Hinnant's algorithm): integer arithmetic, correct
/// across leap years.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn utc_date_time(unix_secs: u64) -> String {
    let days = (unix_secs / 86_400) as i64;
    let tod = unix_secs % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02}", tod / 3600, (tod % 3600) / 60, tod % 60)
}

/// What `drain_log` writes to learn when everything written before it is in
/// the file: this, its NUMBER, a NUL and a newline, in ONE write
/// (`drain_marker`). Recognised by the pump ANYWHERE in a line, taken out of
/// it, and never written to the file. NULs: no log line carries one.
///
/// NUMBERED, and found anywhere, because of what one lost marker cost. The
/// pump used to COUNT markers, and match one only as a whole line. Written in
/// two pieces, after a writer that had not ended its line (an `eprint!`, a
/// library writing to the handle itself), the marker became part of that
/// line, was written to the file, and was never counted: every drain after it
/// waited its whole timeout, for the life of the process. A drain now waits
/// for the highest number the pump has passed to reach its own, so a marker
/// lost all the same costs its own drain its timeout and nothing more.
#[cfg_attr(not(windows), allow(dead_code))]
pub const DRAIN_PREFIX: &[u8] = b"\0puca-agent-log-drain:";

/// Drain marker number `seq`, with its newline: written in one piece.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn drain_marker(seq: u64) -> Vec<u8> {
    let mut m = DRAIN_PREFIX.to_vec();
    m.extend_from_slice(seq.to_string().as_bytes());
    m.extend_from_slice(b"\0\n");
    m
}

/// Take every drain marker out of `line`, returning the highest number among
/// them. A prefix with no number and NUL after it is not a marker, and stays.
#[cfg_attr(not(windows), allow(dead_code))]
fn take_drain_markers(line: &mut Vec<u8>) -> Option<u64> {
    let mut highest = None;
    let mut from = 0;
    while let Some(at) = line[from..].windows(DRAIN_PREFIX.len()).position(|w| w == DRAIN_PREFIX) {
        let start = from + at;
        let digits = start + DRAIN_PREFIX.len();
        let end = line[digits..].iter().position(|b| !b.is_ascii_digit()).map(|n| digits + n);
        let seq = match end {
            Some(end) if end > digits && line[end] == 0 => {
                std::str::from_utf8(&line[digits..end]).ok().and_then(|s| s.parse::<u64>().ok()).map(|n| (n, end))
            }
            _ => None,
        };
        match seq {
            Some((n, end)) => {
                highest = highest.max(Some(n));
                line.drain(start..=end);
                from = start;
            }
            None => from = start + 1,
        }
    }
    highest
}

/// The longest line held whole: past this a line that never ends (a runaway
/// writer) is put in the file in pieces rather than held for ever.
#[cfg_attr(not(windows), allow(dead_code))]
const MAX_LINE: usize = 64 * 1024;

/// Bytes as they were written to stderr, in, and the same bytes out as
/// whole lines, each with the UTC time its FIRST byte arrived in front:
/// `eprintln!` can hand one line over in several writes, and the time that
/// matters is when it began.
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Default)]
pub struct LineStamper {
    line: Vec<u8>,
    began: Option<u64>,
}

#[cfg_attr(not(windows), allow(dead_code))]
impl LineStamper {
    /// Take `bytes`, append every line they complete to `out`, and return
    /// the highest drain marker number that went past, if any. A marker is
    /// taken out of whatever line it landed in, and what is left of that line
    /// goes out as a line (an empty one only if it was nothing but markers is
    /// not written). `now_ms` is read once per line.
    pub fn feed(&mut self, bytes: &[u8], now_ms: &mut dyn FnMut() -> u64, out: &mut Vec<u8>) -> Option<u64> {
        let mut drained = None;
        for &b in bytes {
            if self.began.is_none() {
                self.began = Some(now_ms());
            }
            if b == b'\n' {
                match take_drain_markers(&mut self.line) {
                    Some(n) if self.line.is_empty() => {
                        drained = drained.max(Some(n));
                        self.began = None;
                    }
                    found => {
                        drained = drained.max(found);
                        self.emit(out);
                    }
                }
                continue;
            }
            self.line.push(b);
            if self.line.len() >= MAX_LINE {
                self.emit(out);
            }
        }
        drained
    }

    /// A line left without its newline (the process is going away): out
    /// with it, stamped like any other.
    pub fn finish(&mut self, out: &mut Vec<u8>) {
        if !self.line.is_empty() {
            self.emit(out);
        }
    }

    fn emit(&mut self, out: &mut Vec<u8>) {
        out.extend_from_slice(utc_stamp(self.began.unwrap_or(0)).as_bytes());
        out.push(b' ');
        out.extend_from_slice(&self.line);
        out.push(b'\n');
        self.line.clear();
        self.began = None;
    }
}

/// Copy everything read from `from` into `to`, as stamped lines, until
/// `from` ends. `drained` is told the highest drain marker number each read
/// carried, once every line before it is written.
///
/// It NEVER stops reading for a reason of its own: a write that fails (a full
/// disk) loses those lines, and the pipe keeps draining, because a pipe nobody
/// drains blocks every thread that logs, the stream threads included.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn pump_stamped(
    mut from: impl std::io::Read,
    mut to: impl std::io::Write,
    mut now_ms: impl FnMut() -> u64,
    mut drained: impl FnMut(u64),
) {
    let mut stamper = LineStamper::default();
    let mut buf = vec![0u8; 8 * 1024];
    let mut out = Vec::with_capacity(16 * 1024);
    loop {
        let n = match from.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        };
        out.clear();
        let drains = stamper.feed(&buf[..n], &mut now_ms, &mut out);
        if !out.is_empty() {
            let _ = to.write_all(&out);
            let _ = to.flush();
        }
        if let Some(seq) = drains {
            drained(seq);
        }
    }
    out.clear();
    stamper.finish(&mut out);
    if !out.is_empty() {
        let _ = to.write_all(&out);
    }
}

/// Whether stderr is the stamping pipe, so a drain has someone to answer it.
#[cfg_attr(not(windows), allow(dead_code))]
static STAMPING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// The last drain marker number handed out, and the highest the pump has
/// passed.
#[cfg_attr(not(windows), allow(dead_code))]
static DRAINS_SENT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
#[cfg_attr(not(windows), allow(dead_code))]
static DRAINS_SEEN: (std::sync::Mutex<u64>, std::sync::Condvar) =
    (std::sync::Mutex::new(0), std::sync::Condvar::new());

/// The pump passed marker `seq`: the highest number seen is what a drain
/// waits on, never a count (`DRAIN_PREFIX`).
#[cfg_attr(not(windows), allow(dead_code))]
fn note_drain(seen: &mut u64, seq: u64) {
    *seen = (*seen).max(seq);
}

#[cfg_attr(not(windows), allow(dead_code))]
fn drain_seen(seq: u64) {
    let (seen, cv) = &DRAINS_SEEN;
    if let Ok(mut n) = seen.lock() {
        note_drain(&mut n, seq);
    }
    cv.notify_all();
}

/// Wait, at most `timeout`, until everything written to stderr so far is in
/// the file. For the ways out of this process (`std::process::exit` does not
/// wait for the pump), so the last line before the agent goes is not left in
/// the pipe. Does nothing when stderr is not the stamping pipe.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn drain_log(timeout: std::time::Duration) {
    use std::io::Write as _;
    if !STAMPING.load(std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    // Numbered under stderr's own lock, so the numbers enter the pipe in
    // order, and written in ONE piece, so no other writer's bytes land
    // between a marker and its newline.
    let target = {
        let mut err = std::io::stderr().lock();
        let target = DRAINS_SENT.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        let _ = err.write_all(&drain_marker(target));
        target
    };
    let deadline = std::time::Instant::now() + timeout;
    let (count, cv) = &DRAINS_SEEN;
    let Ok(mut seen) = count.lock() else { return };
    while *seen < target {
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        if left.is_zero() {
            return;
        }
        seen = match cv.wait_timeout(seen, left) {
            Ok((g, _)) => g,
            Err(_) => return,
        };
    }
}

/// Make stderr the stamping pipe into `file` (Windows). Falls back to
/// writing straight into the file, unstamped, as every agent before this did,
/// if the pipe or its thread cannot be had, and says so in the file.
///
/// Every handle involved stays open for the life of the process: the pipe's
/// two ends and the file. Closing one under a live stderr would turn a log
/// line into a write to a handle Windows may since have given to something
/// else. If the pump's thread ever ends, stderr is pointed straight at the
/// file again on its way out (`StraightToFile`), so nothing blocks on a pipe
/// nobody drains.
#[cfg(windows)]
pub fn stamp_stderr_into(file: std::fs::File) {
    use std::os::windows::io::{AsRawHandle, FromRawHandle};
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::Console::{SetStdHandle, STD_ERROR_HANDLE};
    use windows::Win32::System::Pipes::CreatePipe;

    struct StraightToFile(isize);
    impl Drop for StraightToFile {
        fn drop(&mut self) {
            STAMPING.store(false, std::sync::atomic::Ordering::SeqCst);
            unsafe {
                let _ = SetStdHandle(STD_ERROR_HANDLE, HANDLE(self.0 as _));
            }
        }
    }

    let file = std::mem::ManuallyDrop::new(file);
    let file_handle = file.as_raw_handle() as isize;
    let straight = |why: String| unsafe {
        let _ = SetStdHandle(STD_ERROR_HANDLE, HANDLE(file_handle as _));
        eprintln!("[agent] the log's lines go in without their time: {why}");
    };
    let (mut read, mut write) = (HANDLE::default(), HANDLE::default());
    // 64 KiB: room for a burst while the pump is descheduled.
    if let Err(e) = unsafe { CreatePipe(&mut read, &mut write, None, 64 * 1024) } {
        straight(format!("no pipe ({e})"));
        return;
    }
    let reader = std::mem::ManuallyDrop::new(unsafe { std::fs::File::from_raw_handle(read.0 as _) });
    let spawned = std::thread::Builder::new().name("agent-log".into()).spawn(move || {
        let _straight = StraightToFile(file_handle);
        // HIGHEST, so a line spends as little time in the pipe as the
        // scheduler allows: what a hard kill loses is what the pump has not
        // read yet (see "What a hard kill loses" above). Its work per line
        // is a few microseconds, so it takes nothing from anything else.
        unsafe {
            use windows::Win32::System::Threading::{GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_HIGHEST};
            let _ = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_HIGHEST);
        }
        pump_stamped(&*reader, &*file, unix_millis, drain_seen);
    });
    match spawned {
        Ok(_) => unsafe {
            let _ = SetStdHandle(STD_ERROR_HANDLE, write);
            STAMPING.store(true, std::sync::atomic::Ordering::SeqCst);
        },
        Err(e) => straight(format!("no thread to stamp them ({e})")),
    }
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

    // ---- agent.log times ----------------------------------------------------

    #[test]
    fn the_stamp_is_the_utc_date_and_time_to_the_millisecond() {
        assert_eq!(utc_stamp(0), "1970-01-01 00:00:00.000Z");
        assert_eq!(utc_stamp(1_792_982_204_123), "2026-10-26 02:36:44.123Z");
        // Leap days, and the century rules either side of them.
        assert_eq!(utc_stamp(1_709_251_199_999), "2024-02-29 23:59:59.999Z");
        assert_eq!(utc_stamp(951_868_800_000), "2000-03-01 00:00:00.000Z");
        assert_eq!(utc_stamp(4_107_542_400_000), "2100-03-01 00:00:00.000Z");
    }

    /// A clock that ticks one millisecond each time it is read, from 1000.
    fn ticking() -> impl FnMut() -> u64 {
        let mut t = 999;
        move || {
            t += 1;
            t
        }
    }

    /// EVERY LINE, AND THE TIME IT BEGAN. `eprintln!` can hand one line over
    /// in several writes; the line is stamped once, with the time its first
    /// piece arrived, and not before its newline. Two lines in one write get
    /// a time each.
    #[test]
    fn each_line_is_stamped_once_with_the_time_it_began() {
        let mut s = LineStamper::default();
        let mut clock = ticking();
        let mut out = Vec::new();
        // One line in three writes: nothing out until its end.
        s.feed(b"[stream] fra", &mut clock, &mut out);
        s.feed(b"mes sent: ", &mut clock, &mut out);
        assert!(out.is_empty(), "a line is held until its newline");
        s.feed(b"3\n[lid] the lid is now closed\n[agent] x", &mut clock, &mut out);
        assert_eq!(
            String::from_utf8(out.clone()).unwrap(),
            "1970-01-01 00:00:01.000Z [stream] frames sent: 3\n\
             1970-01-01 00:00:01.001Z [lid] the lid is now closed\n",
        );
        // The rest of a line still being written goes out when it ends, or
        // when the pump finishes.
        out.clear();
        s.finish(&mut out);
        assert_eq!(String::from_utf8(out).unwrap(), "1970-01-01 00:00:01.002Z [agent] x\n");
    }

    /// The drain's marker is counted, never written; an empty line is still
    /// a line; a line that never ends is written in pieces, not held for
    /// ever.
    #[test]
    fn a_drain_marker_is_counted_not_written_and_a_runaway_line_is_cut() {
        let mut s = LineStamper::default();
        let mut clock = ticking();
        let mut out = Vec::new();
        let mut written = b"before\n".to_vec();
        written.extend_from_slice(&drain_marker(1));
        written.extend_from_slice(b"\nafter\n");
        assert_eq!(s.feed(&written, &mut clock, &mut out), Some(1), "drain 1 went past");
        let text = String::from_utf8(out.clone()).unwrap();
        assert_eq!(text.lines().count(), 3, "{text:?}");
        assert!(!text.contains("drain"), "the marker never reaches the file: {text:?}");
        assert!(text.ends_with("Z after\n"));

        out.clear();
        let runaway = vec![b'x'; MAX_LINE * 2 + 10];
        s.feed(&runaway, &mut clock, &mut out);
        assert_eq!(String::from_utf8(out).unwrap().lines().count(), 2, "cut at MAX_LINE, twice");
    }

    /// REVIEW FINDING 6. A marker that lands in the middle of a line (another
    /// writer had not ended its line) is still a drain, and is still taken
    /// out; what came before it goes out as the line it was. It used to be
    /// matched only as a whole line, so it went into the file, uncounted.
    #[test]
    fn a_drain_marker_inside_a_line_is_found_and_taken_out() {
        let mut s = LineStamper::default();
        let mut clock = ticking();
        let mut out = Vec::new();
        let mut written = b"[capture] half a line".to_vec();
        written.extend_from_slice(&drain_marker(7));
        assert_eq!(s.feed(&written, &mut clock, &mut out), Some(7));
        let text = String::from_utf8(out).unwrap();
        assert_eq!(text, "1970-01-01 00:00:01.000Z [capture] half a line\n");
        // Not every NUL is a marker: no number, or no NUL after it.
        let mut line = b"a\0puca-agent-log-drain:\0b\0puca-agent-log-drain:12".to_vec();
        assert_eq!(take_drain_markers(&mut line), None);
        assert_eq!(line, b"a\0puca-agent-log-drain:\0b\0puca-agent-log-drain:12".to_vec(), "left alone");
        // Two in one line: both out, the higher one counts.
        let mut two = drain_marker(3);
        two.pop();
        two.extend_from_slice(b"x");
        two.extend_from_slice(&drain_marker(4));
        two.pop();
        assert_eq!(take_drain_markers(&mut two), Some(4));
        assert_eq!(two, b"x".to_vec());
    }

    /// REVIEW FINDING 6. A drain waits for the highest marker number the
    /// pump has passed, not for a count: one marker lost (drain 2) costs its
    /// own drain, and drain 3 is answered once marker 3 is through. Counted,
    /// two markers seen read as "drain 2" for ever, and every later drain
    /// waited its whole timeout.
    #[test]
    fn one_lost_marker_does_not_hold_up_every_drain_after_it() {
        let mut seen = 0;
        note_drain(&mut seen, 1);
        note_drain(&mut seen, 3);
        assert!(seen >= 3, "drain 3 is answered");
        note_drain(&mut seen, 2);
        assert_eq!(seen, 3, "a late lower number changes nothing");
    }

    /// REVIEW FINDING 6. The marker and its newline go in ONE write, so no
    /// other writer's bytes can land between them.
    #[test]
    fn a_drain_marker_is_one_write() {
        let m = drain_marker(42);
        assert_eq!(m, b"\0puca-agent-log-drain:42\0\n".to_vec());
        let src = include_str!("file_log.rs").replace('\r', "");
        let drain = src.split("\npub fn drain_log(").nth(1).unwrap().split("\n}\n").next().unwrap();
        assert_eq!(drain.matches("write_all(").count(), 1, "one write in drain_log");
        assert!(drain.contains("write_all(&drain_marker(target))"));
    }

    /// The pump end to end, over a reader that hands the bytes over in odd
    /// pieces: every line out once and stamped, the drain told only after
    /// the lines before it are written.
    #[test]
    fn the_pump_stamps_every_line_and_answers_a_drain_after_what_came_before() {
        struct Pieces(Vec<Vec<u8>>);
        impl std::io::Read for Pieces {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                if self.0.is_empty() {
                    return Ok(0);
                }
                let p = self.0.remove(0);
                buf[..p.len()].copy_from_slice(&p);
                Ok(p.len())
            }
        }
        // The end of "two" and the marker in ONE read: the drain must still
        // be answered only once "two" is written.
        let mut two_and_marker = b"o\n".to_vec();
        two_and_marker.extend_from_slice(&drain_marker(1));
        let input = Pieces(vec![b"one\ntw".to_vec(), two_and_marker, b"three".to_vec()]);
        let file = std::cell::RefCell::new(Vec::new());
        let mut lines_when_drained = None;
        struct Sink<'a>(&'a std::cell::RefCell<Vec<u8>>);
        impl std::io::Write for Sink<'_> {
            fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
                self.0.borrow_mut().extend_from_slice(b);
                Ok(b.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        pump_stamped(input, Sink(&file), ticking(), |seq| {
            assert_eq!(seq, 1);
            lines_when_drained = Some(String::from_utf8(file.borrow().clone()).unwrap().lines().count());
        });
        let text = String::from_utf8(file.into_inner()).unwrap();
        let bodies: Vec<&str> = text.lines().map(|l| l.split_once("Z ").unwrap().1).collect();
        assert_eq!(bodies, ["one", "two", "three"], "{text:?}");
        assert!(text.lines().all(|l| l.starts_with("1970-01-01 00:00:01.")), "{text:?}");
        assert_eq!(lines_when_drained, Some(2), "the drain was answered once both lines before it were in");
    }

    /// The same over a REAL Windows pipe into a real file: what stderr
    /// becomes (`stamp_stderr_into`), minus taking this test process's own
    /// stderr. Its writer closing ends the pump, so nothing is left behind.
    #[cfg(windows)]
    #[test]
    fn a_real_pipe_carries_stamped_lines_into_the_file() {
        use std::io::Write as _;
        use std::os::windows::io::FromRawHandle;
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::System::Pipes::CreatePipe;
        let (mut r, mut w) = (HANDLE::default(), HANDLE::default());
        unsafe { CreatePipe(&mut r, &mut w, None, 64 * 1024) }.expect("a pipe");
        let reader = unsafe { std::fs::File::from_raw_handle(r.0 as _) };
        let mut writer = unsafe { std::fs::File::from_raw_handle(w.0 as _) };
        let dir = std::env::temp_dir().join(format!("puca-agent-log-{}-{}", std::process::id(), unix_millis()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("agent.log");
        let file = std::fs::OpenOptions::new().create(true).append(true).open(&path).unwrap();
        let before = unix_millis();
        let pump = std::thread::spawn(move || pump_stamped(&reader, &file, unix_millis, |_| {}));
        writer.write_all(b"[stream] frames sent: 1\n[lid] the lid is now ").unwrap();
        writer.write_all(b"closed\n").unwrap();
        drop(writer);
        pump.join().unwrap();
        let body = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = body.lines().collect();
        assert_eq!(lines.len(), 2, "{body:?}");
        assert!(lines[1].ends_with("Z [lid] the lid is now closed"), "{body:?}");
        let stamp = &lines[0][..24];
        assert!(stamp >= utc_stamp(before).as_str() && stamp <= utc_stamp(unix_millis()).as_str(), "{stamp}");
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
