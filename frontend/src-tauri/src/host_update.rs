//! A PC set up for remote control keeps ITSELF up to date: the shell half.
//!
//! WHEN is the page's to decide (`frontend/src/api/devices/hostUpdate.ts`, run
//! by `components/HostAutoUpdate.tsx`): nobody connected, nobody here, nothing
//! running that a restart would cut off. What the page could not do itself,
//! and why each lives here (review of 2026-10-26):
//!
//! - **The install shows nothing on the screen.** The updater plugin's
//!   JavaScript `install()` runs the NSIS installer in the app's configured
//!   mode, passive, which puts a progress window up, and it takes no per-call
//!   options. Built here, the updater adds NSIS's own silent switch for THIS
//!   install only (`QUIET_INSTALLER_ARGS`); the update banner's installs stay
//!   as they are. The plugin still passes `/R /ARGS <this launch's arguments>`,
//!   and the installer template's `.onInstSuccess` relaunches a silent install
//!   exactly as it does a passive one (`${If} $PassiveMode = 1 ${OrIf}
//!   ${Silent}`), and a silent one closes the running app without asking, as a
//!   passive one does (read from the template the CLI embeds, 2026-10-26).
//! - **The new app comes back hidden.** `/ARGS` carries `--hidden` only when
//!   this launch had it (autostart). A Púca closed to the tray had none and
//!   would have come back with its window on the screen, in front of whatever
//!   the PC was showing. So a marker naming the version being installed is
//!   written first (`write_relaunch_marker`), and the next start hides its
//!   window when it IS that version and the marker is fresh
//!   (`take_relaunch_marker`). A start on any other version (the install
//!   failed, and someone started the old one by hand) shows its window as
//!   always, and the marker goes either way: it is read once.
//! - **The attempt is on disk before the installer runs.** It was a
//!   localStorage write a few milliseconds before `install()`, which exits the
//!   process, and whether WebView2 had flushed it was never shown. Here it is a
//!   file written, synced and renamed into place before the installer starts
//!   (`record_attempt`), so a broken update cannot loop the PC.
//! - **A download a session interrupts is stopped.** The plugin's JavaScript
//!   download runs to its end; this one is a task the page aborts
//!   (`host_update_cancel`), so a session that starts meanwhile does not share
//!   the link with an installer download.
//! - **When this PC fell behind, and when the version on offer was first
//!   seen** (`note_seen`), for the page's soak, on disk for the same reason as
//!   the attempt.
//! - **Whether someone is watching or playing** (`host_presence`): the shell's
//!   own notification state, which knows a full-screen game, a film, a
//!   presentation and a locked or switched-away session, none of which
//!   keyboard-and-mouse idleness can tell apart.
//!
//! Per Windows account: the files sit under this account's `%LOCALAPPDATA%`,
//! as the install itself does (per-user NSIS).

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Runtime, State};
use tauri_plugin_updater::UpdaterExt;

/// Added to the updater's NSIS command line for a host's own install: NSIS's
/// silent switch. Nothing else changes (the plugin's `/P /UPDATE /R /ARGS …`
/// stay), so the template relaunches the app after it.
pub const QUIET_INSTALLER_ARGS: [&str; 1] = ["/S"];

/// How long a relaunch marker is believed, from the moment the installer is
/// started (it is written just before). Short on purpose: within it, a start
/// of the NEW version by hand would come up hidden too. A silent per-user
/// install of an installer of a few tens of megabytes unpacks and copies in
/// seconds, well under a minute on a slow and busy disk, and the relaunch
/// follows at once, so five minutes is several times the slow case (not
/// measured on a real install: none may be run from here). A PC that sleeps
/// between the installer's start and the relaunch shows its window when it
/// wakes, which is acceptable: it was asleep, so nobody had a screen to keep.
pub const RELAUNCH_MARKER_MAX_AGE_MS: u64 = 5 * 60_000;

const STATE_FILE: &str = "state.json";
const RELAUNCH_MARKER: &str = "relaunch-hidden.json";

/// A version, and when (Unix ms).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Stamp {
    pub version: String,
    pub at: u64,
}

/// What this account's host updates remember across restarts.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    /// The last install this PC committed to by itself.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempt: Option<Stamp>,
    /// The newest version seen offered, and when it was first seen.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seen: Option<Stamp>,
    /// When this PC first saw ANY version newer than the one it runs, with
    /// the version it ran then: the soak's clock (coordinator, round 3). It
    /// starts again only once the running version changes, so a burst of
    /// releases cannot keep pushing it back.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub behind: Option<Stamp>,
}

/// What `note_seen` answers: when the offered version was first seen, and
/// since when this PC has been behind.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SeenTimes {
    pub seen_at: u64,
    pub behind_since: u64,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// `%LOCALAPPDATA%\<identifier>\host-update` (this Windows account's).
fn dir() -> Result<PathBuf, String> {
    #[cfg(windows)]
    let base = std::env::var("LOCALAPPDATA").map_err(|_| "LOCALAPPDATA is not set".to_string())?;
    #[cfg(not(windows))]
    let base = std::env::var("HOME")
        .map(|h| format!("{h}/.local/share"))
        .map_err(|_| "HOME is not set".to_string())?;
    Ok(Path::new(&base).join(env!("PUCA_IDENTIFIER")).join("host-update"))
}

/// "0.9.851" and "v0.9.851" are one version.
pub fn same_version(a: &str, b: &str) -> bool {
    fn norm(v: &str) -> &str {
        let v = v.trim();
        v.strip_prefix(['v', 'V']).unwrap_or(v)
    }
    !norm(a).is_empty() && norm(a) == norm(b)
}

/// Write `bytes` to `dir/name` so that it is on disk when this returns: a
/// temporary file, synced, renamed over the old one. A crash leaves the old
/// file or the new one, never half of either.
fn write_durably(dir: &Path, name: &str, bytes: &[u8]) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(format!("{name}.tmp"));
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, dir.join(name))
}

/// The record, or an empty one for a missing or unreadable file.
pub fn read_record(dir: &Path) -> Record {
    std::fs::read(dir.join(STATE_FILE))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

pub fn write_record(dir: &Path, r: &Record) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(r).map_err(std::io::Error::other)?;
    write_durably(dir, STATE_FILE, &bytes)
}

/// `offered` is on offer, newer than `running`: when was it first seen, and
/// since when has this PC been behind? Each time already recorded, or `now`,
/// recorded. The offered version's clock starts with each new version; the
/// behind clock only once the running version changes (the PC updated).
pub fn note_seen(dir: &Path, offered: &str, running: &str, now: u64) -> std::io::Result<SeenTimes> {
    let mut r = read_record(dir);
    let mut changed = false;
    let behind_since = match &r.behind {
        Some(b) if same_version(&b.version, running) => b.at,
        _ => {
            r.behind = Some(Stamp { version: running.to_string(), at: now });
            changed = true;
            now
        }
    };
    let seen_at = match &r.seen {
        Some(s) if same_version(&s.version, offered) => s.at,
        _ => {
            r.seen = Some(Stamp { version: offered.to_string(), at: now });
            changed = true;
            now
        }
    };
    if changed {
        write_record(dir, &r)?;
    }
    Ok(SeenTimes { seen_at, behind_since })
}

/// Nothing newer is offered: the soak's two clocks go (the attempt stays,
/// the loop guard's). The next version that shows starts both afresh.
pub fn forget_offer(dir: &Path) -> std::io::Result<()> {
    let mut r = read_record(dir);
    if r.behind.is_none() && r.seen.is_none() {
        return Ok(());
    }
    r.behind = None;
    r.seen = None;
    write_record(dir, &r)
}

/// The install about to run, recorded before it runs.
pub fn record_attempt(dir: &Path, version: &str, now: u64) -> std::io::Result<()> {
    let mut r = read_record(dir);
    r.attempt = Some(Stamp { version: version.to_string(), at: now });
    write_record(dir, &r)
}

/// "The app the installer relaunches is `version`, and it starts hidden."
pub fn write_relaunch_marker(dir: &Path, version: &str, now: u64) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(&Stamp { version: version.to_string(), at: now })
        .map_err(std::io::Error::other)?;
    write_durably(dir, RELAUNCH_MARKER, &bytes)
}

pub fn remove_relaunch_marker(dir: &Path) {
    let _ = std::fs::remove_file(dir.join(RELAUNCH_MARKER));
}

/// Should this start hide its window because a host update just relaunched
/// it? Only when the marker names `running` and is fresh. Read ONCE: the
/// marker goes whatever it says, so a later start never hides by it.
pub fn take_relaunch_marker(dir: &Path, running: &str, now: u64) -> bool {
    let path = dir.join(RELAUNCH_MARKER);
    let Ok(raw) = std::fs::read(&path) else { return false };
    let _ = std::fs::remove_file(&path);
    let Ok(s) = serde_json::from_slice::<Stamp>(&raw) else { return false };
    // A marker from the future (the clock went back) is not believed either.
    let fresh = s.at <= now.saturating_add(60_000) && now.saturating_sub(s.at) <= RELAUNCH_MARKER_MAX_AGE_MS;
    fresh && same_version(&s.version, running)
}

/// At startup (lib.rs setup): this launch is a host update's relaunch, so the
/// window stays hidden. `running` is this build's version.
pub fn take_relaunch_hidden(running: &str) -> bool {
    match dir() {
        Ok(d) => take_relaunch_marker(&d, running, now_ms()),
        Err(_) => false,
    }
}

/// Where a host's own update is.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
enum Phase {
    #[default]
    Idle,
    /// Asking the server what is newer.
    Checking,
    Downloading { version: String },
    /// Downloaded and its signature verified: waiting for the page's last look.
    Ready { version: String },
    Failed { version: String, error: String },
}

#[derive(Default)]
struct Inner {
    phase: Phase,
    task: Option<tauri::async_runtime::JoinHandle<()>>,
    held: Option<(tauri_plugin_updater::Update, Vec<u8>)>,
    /// Moved by every start and cancel, so a download cancelled while its
    /// last bytes arrived cannot write itself back in.
    gen: u64,
    /// Bytes the request's download has received so far: the page stops a
    /// download that makes no progress (the updater has no timeout of its
    /// own). A fresh counter per request, so a late chunk of an aborted one
    /// counts for nothing.
    bytes: Arc<AtomicU64>,
}

#[derive(Default)]
pub struct HostUpdateState {
    inner: Mutex<Inner>,
}

/// Drop whatever a request left behind (a download in flight, an update
/// held) and move the generation, so nothing it does later writes back in.
fn drop_request(inner: &mut Inner) {
    inner.gen += 1;
    if let Some(task) = inner.task.take() {
        task.abort();
    }
    inner.held = None;
    inner.phase = Phase::Idle;
}

/// A new request starts clean, REPLACING anything an earlier one left:
/// a page reloaded mid-download leaves its download (or the update it
/// held) with nobody to cancel it, and refusing every later request as
/// "already downloading" stopped a host updating until Púca restarted
/// (coordinator, round 3). Answers the request's generation.
fn begin(inner: &mut Inner) -> u64 {
    drop_request(inner);
    inner.bytes = Arc::new(AtomicU64::new(0));
    inner.phase = Phase::Checking;
    inner.gen
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostUpdateStatus {
    /// "idle" | "checking" | "downloading" | "ready" | "failed"
    pub phase: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Bytes received, while downloading and once downloaded.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u64>,
}

fn status_of(p: &Phase, bytes: u64) -> HostUpdateStatus {
    let (phase, version, error) = match p {
        Phase::Idle => ("idle", None, None),
        Phase::Checking => ("checking", None, None),
        Phase::Downloading { version } => ("downloading", Some(version.clone()), None),
        Phase::Ready { version } => ("ready", Some(version.clone()), None),
        Phase::Failed { version, error } => ("failed", Some(version.clone()), Some(error.clone())),
    };
    let bytes = matches!(p, Phase::Downloading { .. } | Phase::Ready { .. }).then_some(bytes);
    HostUpdateStatus { phase, version, error, bytes }
}

/// The updater built for a host's OWN install (quiet), asked what it offers:
/// latest.json's newer version, if any.
async fn check_offer<R: Runtime>(app: &AppHandle<R>) -> Result<Option<tauri_plugin_updater::Update>, String> {
    let updater = app
        .updater_builder()
        .installer_args(QUIET_INSTALLER_ARGS)
        .build()
        .map_err(|e| e.to_string())?;
    bounded(OFFER_CHECK_TIMEOUT, async { updater.check().await.map_err(|e| e.to_string()) }).await
}

/// How long a look at latest.json may take. It has no bound of its own, and
/// the page waits on it at every look: a request that hung used to keep the
/// page's look busy, and with it every later one, until Púca restarted
/// (coordinator, round 3). Generous for a few hundred bytes of JSON; the
/// DOWNLOAD is not bounded by it (the page's stall bound watches that).
pub const OFFER_CHECK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// `fut`, or a failure once `limit` has passed: a look that hangs is a look
/// that failed.
async fn bounded<T>(
    limit: std::time::Duration,
    fut: impl std::future::Future<Output = Result<T, String>>,
) -> Result<T, String> {
    match tokio::time::timeout(limit, fut).await {
        Ok(result) => result,
        Err(_) => Err(format!("the updater did not answer within {} s", limit.as_secs())),
    }
}

/// The version latest.json offers this build, or None for nothing newer.
/// What a host would install, and so what its soak and its loop guard key
/// on; the page installs only while /app-version agrees (coordinator, round
/// 3: during a ship to several boxes the two can differ).
#[tauri::command]
pub async fn host_update_offer<R: Runtime>(app: AppHandle<R>) -> Result<Option<String>, String> {
    let offered = check_offer(&app).await?.map(|u| u.version);
    if offered.is_none() {
        // A look that found nothing newer: this PC is not behind. A version
        // offered and then pulled must not leave its clocks running for the
        // next one, or for itself republished (coordinator, round 3). A look
        // that FAILED (the `?` above) clears nothing.
        if let Ok(d) = dir() {
            let _ = forget_offer(&d);
        }
    }
    Ok(offered)
}

/// Ask the server, and start downloading what is newer, if it is `expected`:
/// the version the page judged. Answers the version being downloaded, or None
/// for nothing newer. Returns at once: the page polls `host_update_status`,
/// and `host_update_cancel` stops it.
#[tauri::command]
pub async fn host_update_download<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, Arc<HostUpdateState>>,
    expected: String,
) -> Result<Option<String>, String> {
    let gen = begin(&mut state.inner.lock().unwrap());
    let checked = check_offer(&app).await;
    let st = state.inner().clone();
    let mut inner = st.inner.lock().unwrap();
    if inner.gen != gen {
        // Cancelled while the server answered.
        return Ok(None);
    }
    let update = match checked {
        Ok(Some(u)) => u,
        Ok(None) => {
            inner.phase = Phase::Idle;
            return Ok(None);
        }
        Err(e) => {
            inner.phase = Phase::Idle;
            return Err(e);
        }
    };
    // Only the version the page judged. latest.json can move between its look
    // and this one (a ship in progress), and installing another would record
    // an attempt the page's guard would not recognise as this version's.
    if !same_version(&update.version, &expected) {
        inner.phase = Phase::Idle;
        return Err(format!("the updater offers {} now, not {expected}", update.version));
    }
    let version = update.version.clone();
    inner.phase = Phase::Downloading { version: version.clone() };
    let owner = st.clone();
    let received = inner.bytes.clone();
    inner.task = Some(tauri::async_runtime::spawn(async move {
        // The plugin checks the signature against the app's public key before
        // it hands the bytes back. Each chunk is counted, for the page's stall
        // bound.
        let on_chunk = move |n: usize, _total: Option<u64>| {
            received.fetch_add(n as u64, Ordering::Relaxed);
        };
        let result = update.download(on_chunk, || {}).await;
        let mut inner = owner.inner.lock().unwrap();
        if inner.gen != gen {
            return;
        }
        inner.task = None;
        match result {
            Ok(bytes) => {
                inner.phase = Phase::Ready { version: update.version.clone() };
                inner.held = Some((update, bytes));
            }
            Err(e) => {
                inner.phase = Phase::Failed { version: update.version.clone(), error: e.to_string() };
            }
        }
    }));
    Ok(Some(version))
}

#[tauri::command]
pub fn host_update_status(state: State<'_, Arc<HostUpdateState>>) -> HostUpdateStatus {
    let inner = state.inner.lock().unwrap();
    status_of(&inner.phase, inner.bytes.load(Ordering::Relaxed))
}

/// Stop a download, and drop what was downloaded. Nothing to stop is fine.
#[tauri::command]
pub fn host_update_cancel(state: State<'_, Arc<HostUpdateState>>) {
    drop_request(&mut state.inner.lock().unwrap());
}

/// Install what `host_update_download` fetched: the attempt and the relaunch
/// marker on disk first, then the installer, quiet. On Windows this does not
/// return when it works: the installer replaces this process, and relaunches
/// the app hidden.
#[tauri::command]
pub fn host_update_install<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, Arc<HostUpdateState>>,
) -> Result<(), String> {
    let (update, bytes) = {
        let mut inner = state.inner.lock().unwrap();
        if !matches!(inner.phase, Phase::Ready { .. }) {
            return Err("no downloaded update to install".into());
        }
        inner.phase = Phase::Idle;
        inner.held.take().ok_or("no downloaded update to install")?
    };
    let dir = dir()?;
    let now = now_ms();
    record_attempt(&dir, &update.version, now).map_err(|e| format!("could not record the attempt: {e}"))?;
    // No marker, no install: a relaunch that cannot be told to stay hidden
    // would put its window on the screen.
    write_relaunch_marker(&dir, &update.version, now)
        .map_err(|e| format!("could not write the relaunch marker: {e}"))?;
    log::info!("[host-update] installing {} quietly; Púca starts again hidden", update.version);
    let result = update.install(&bytes).map_err(|e| e.to_string());
    match result {
        Err(e) => {
            // The installer never started: nothing will relaunch, and a later
            // start must not hide by this marker.
            remove_relaunch_marker(&dir);
            Err(e)
        }
        Ok(()) => {
            // Off Windows the update is in place and this process carries on:
            // start the new one (the marker hides its window).
            #[cfg(not(windows))]
            app.restart();
            #[cfg(windows)]
            {
                let _ = &app;
                Ok(())
            }
        }
    }
}

/// What this account's host updates remember (the page's loop guard and soak).
#[tauri::command]
pub fn host_update_record() -> Record {
    dir().map(|d| read_record(&d)).unwrap_or_default()
}

/// When `version` (on offer, newer than this build) was first seen here, and
/// since when this PC has been behind (Unix ms), recorded the first time each
/// is asked.
#[tauri::command]
pub fn host_update_note_seen<R: Runtime>(app: AppHandle<R>, version: String) -> Result<SeenTimes, String> {
    let d = dir()?;
    let running = app.package_info().version.to_string();
    note_seen(&d, &version, &running, now_ms())
        .map_err(|e| format!("could not record when {version} was first seen: {e}"))
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostPresence {
    /// `SHQueryUserNotificationState` for this session: 1 not present (locked,
    /// screen saver, switched-away session), 2 busy (full screen, or
    /// presentation settings), 3 a full-screen Direct3D game, 4 presentation
    /// mode, 5 accepts notifications (none of those), 6 quiet time, 7 a Store
    /// app in front. None where it cannot be read (not Windows, or it failed).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notification_state: Option<i32>,
}

#[tauri::command]
pub fn host_presence() -> HostPresence {
    #[cfg(windows)]
    {
        // Documented, Vista and later, for any caller: no privilege, and it
        // answers for the calling user's own session.
        let state = unsafe { windows::Win32::UI::Shell::SHQueryUserNotificationState() };
        HostPresence { notification_state: state.ok().map(|s| s.0) }
    }
    #[cfg(not(windows))]
    {
        HostPresence { notification_state: None }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// A fresh, empty directory per test, under the system temp folder.
    fn scratch(name: &str) -> PathBuf {
        static N: AtomicU32 = AtomicU32::new(0);
        let d = std::env::temp_dir().join(format!(
            "puca-host-update-test-{}-{}-{name}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn the_quiet_switch_is_nsis_silent_and_nothing_else() {
        assert_eq!(QUIET_INSTALLER_ARGS, ["/S"]);
    }

    /// Pinned in the source: the host's own updater, and only it, carries the
    /// quiet switch (the banner's install, in the page, stays passive).
    #[test]
    fn only_the_host_download_builds_a_quiet_updater() {
        let src = include_str!("host_update.rs");
        let check = src.split("async fn check_offer").nth(1).expect("the check");
        let check = check.split("#[tauri::command]").next().unwrap();
        assert!(check.contains(".installer_args(QUIET_INSTALLER_ARGS)"));
        let body = src.split("pub async fn host_update_download").nth(1).expect("the command");
        let body = body.split("#[tauri::command]").next().unwrap();
        assert!(body.contains("check_offer(&app).await"));
        let lib = include_str!("lib.rs");
        assert!(!lib.contains("QUIET_INSTALLER_ARGS"), "no other updater may be made quiet");
    }

    #[test]
    fn a_missing_or_broken_record_reads_as_empty() {
        let d = scratch("missing");
        assert_eq!(read_record(&d), Record::default());
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join(STATE_FILE), b"{not json").unwrap();
        assert_eq!(read_record(&d), Record::default());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn the_attempt_is_on_disk_and_leaves_no_temporary_file() {
        let d = scratch("attempt");
        record_attempt(&d, "0.9.851", 1_000).unwrap();
        assert_eq!(read_record(&d).attempt, Some(Stamp { version: "0.9.851".into(), at: 1_000 }));
        assert!(!d.join(format!("{STATE_FILE}.tmp")).exists());
        // It keeps what else was there.
        note_seen(&d, "0.9.852", "0.9.850", 2_000).unwrap();
        record_attempt(&d, "0.9.852", 3_000).unwrap();
        let r = read_record(&d);
        assert_eq!(r.seen, Some(Stamp { version: "0.9.852".into(), at: 2_000 }));
        assert_eq!(r.attempt, Some(Stamp { version: "0.9.852".into(), at: 3_000 }));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_version_keeps_the_time_it_was_first_seen_and_a_newer_one_starts_again() {
        let d = scratch("seen");
        let seen = |v: &str, now| note_seen(&d, v, "0.9.850", now).unwrap().seen_at;
        assert_eq!(seen("0.9.851", 1_000), 1_000);
        assert_eq!(seen("0.9.851", 9_000), 1_000, "the first sighting stands");
        assert_eq!(seen("v0.9.851", 9_000), 1_000, "one version, either spelling");
        assert_eq!(seen("0.9.852", 9_500), 9_500, "a newer one has its own clock");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// Coordinator, round 3: the clock that matters is how long this PC has
    /// been BEHIND, which a burst of releases must not keep resetting.
    #[test]
    fn behind_since_the_first_newer_version_through_a_burst_and_again_after_an_update() {
        let d = scratch("behind");
        let at = |offered: &str, running: &str, now| note_seen(&d, offered, running, now).unwrap();
        assert_eq!(at("0.9.851", "0.9.850", 1_000), SeenTimes { seen_at: 1_000, behind_since: 1_000 });
        // 0.9.852 and 0.9.853 ship hours apart: each has its own sighting,
        // and the PC has been behind since the first.
        assert_eq!(at("0.9.852", "0.9.850", 5_000), SeenTimes { seen_at: 5_000, behind_since: 1_000 });
        assert_eq!(at("0.9.853", "0.9.850", 9_000), SeenTimes { seen_at: 9_000, behind_since: 1_000 });
        // Restarted on the same version: both stand (they are on disk).
        assert_eq!(at("0.9.853", "0.9.850", 20_000), SeenTimes { seen_at: 9_000, behind_since: 1_000 });
        // Updated to 0.9.853, and 0.9.854 is out: behind again, from now.
        assert_eq!(at("0.9.854", "0.9.853", 30_000), SeenTimes { seen_at: 30_000, behind_since: 30_000 });
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn the_relaunch_marker_hides_the_version_it_names_once() {
        let d = scratch("marker");
        write_relaunch_marker(&d, "0.9.851", 10_000).unwrap();
        assert!(take_relaunch_marker(&d, "0.9.851", 40_000));
        assert!(!take_relaunch_marker(&d, "0.9.851", 41_000), "read once");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_start_on_another_version_shows_its_window() {
        // The install failed, and the old Púca was started by hand.
        let d = scratch("other");
        write_relaunch_marker(&d, "0.9.851", 10_000).unwrap();
        assert!(!take_relaunch_marker(&d, "0.9.850", 40_000));
        assert!(!d.join(RELAUNCH_MARKER).exists(), "and the marker is gone all the same");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_stale_or_future_marker_is_not_believed() {
        let d = scratch("stale");
        write_relaunch_marker(&d, "0.9.851", 10_000).unwrap();
        assert!(!take_relaunch_marker(&d, "0.9.851", 10_000 + RELAUNCH_MARKER_MAX_AGE_MS + 1));
        write_relaunch_marker(&d, "0.9.851", 10_000_000).unwrap();
        assert!(!take_relaunch_marker(&d, "0.9.851", 1_000), "from the future: the clock went back");
        // CONTROL: the edge of fresh still counts.
        write_relaunch_marker(&d, "0.9.851", 10_000).unwrap();
        assert!(take_relaunch_marker(&d, "0.9.851", 10_000 + RELAUNCH_MARKER_MAX_AGE_MS));
        let _ = std::fs::remove_dir_all(&d);
    }

    /// Its window also hides a start BY HAND of the new version, so it is kept
    /// to a few minutes from the installer's start (coordinator, round 3).
    #[test]
    fn the_marker_is_believed_for_minutes_not_a_quarter_hour() {
        assert!(RELAUNCH_MARKER_MAX_AGE_MS <= 5 * 60_000);
        let d = scratch("minutes");
        write_relaunch_marker(&d, "0.9.851", 10_000).unwrap();
        assert!(!take_relaunch_marker(&d, "0.9.851", 10_000 + 6 * 60_000), "six minutes on: a hand start shows its window");
        // CONTROL: a relaunch two minutes into a slow install is still hidden.
        write_relaunch_marker(&d, "0.9.851", 10_000).unwrap();
        assert!(take_relaunch_marker(&d, "0.9.851", 10_000 + 2 * 60_000));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn no_marker_or_a_broken_one_hides_nothing() {
        let d = scratch("none");
        assert!(!take_relaunch_marker(&d, "0.9.851", 1));
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join(RELAUNCH_MARKER), b"garbage").unwrap();
        assert!(!take_relaunch_marker(&d, "0.9.851", 1));
        assert!(!d.join(RELAUNCH_MARKER).exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn versions_compare_with_or_without_a_v() {
        assert!(same_version("0.9.851", "v0.9.851"));
        assert!(same_version(" 0.9.851 ", "0.9.851"));
        assert!(!same_version("0.9.851", "0.9.85"));
        assert!(!same_version("", ""), "an empty version is no version");
    }

    /// A host downloads only the version the page judged (coordinator, round
    /// 3): the soak and the loop guard key on what latest.json offers, and the
    /// download refuses another one, so an attempt is always recorded under
    /// the version the guard compares.
    #[test]
    fn the_download_takes_only_the_version_the_page_judged() {
        let src = include_str!("host_update.rs");
        let body = src.split("pub async fn host_update_download").nth(1).unwrap().split("#[tauri::command]").next().unwrap();
        let refuse = body.find("if !same_version(&update.version, &expected)").expect("it compares");
        let start = body.find("Phase::Downloading { version").expect("it downloads");
        assert!(refuse < start, "compared before anything downloads");
        let offer = src.split("pub async fn host_update_offer").nth(1).unwrap().split("#[tauri::command]").next().unwrap();
        assert!(offer.contains("check_offer(&app).await?.map(|u| u.version)"), "the page is told the same version the download checks");
    }

    /// Coordinator, round 3: a look at latest.json that hangs must end, as a
    /// failed look, so the page's next look can run. The bound wraps the
    /// CHECK only: the builder's own timeout would also cap the download.
    #[test]
    fn a_look_that_hangs_ends_as_a_failed_look_within_the_bound() {
        let started = std::time::Instant::now();
        let hung: Result<(), String> = tauri::async_runtime::block_on(bounded(
            std::time::Duration::from_millis(50),
            std::future::pending::<Result<(), String>>(),
        ));
        assert_eq!(hung, Err("the updater did not answer within 0 s".to_string()));
        assert!(started.elapsed() < std::time::Duration::from_secs(5), "ended near its bound");
        // CONTROL: an answer inside the bound is the answer.
        let answered = tauri::async_runtime::block_on(bounded(std::time::Duration::from_secs(5), async { Ok::<_, String>(7) }));
        assert_eq!(answered, Ok(7));
        // And the look uses it, with a real bound, and the builder no timeout.
        assert!(OFFER_CHECK_TIMEOUT <= std::time::Duration::from_secs(60) && OFFER_CHECK_TIMEOUT >= std::time::Duration::from_secs(10));
        let src = include_str!("host_update.rs");
        let check = src.split("async fn check_offer").nth(1).unwrap().split("#[tauri::command]").next().unwrap();
        assert!(check.contains("bounded(OFFER_CHECK_TIMEOUT,"));
        assert!(!check.contains(".timeout("), "the download must not be capped by the look's bound");
    }

    /// Coordinator, round 3: V seen, then pulled (a look finds nothing
    /// newer), then V' seen: the day counts from V', and a republished V is
    /// as new as a first sighting.
    #[test]
    fn a_pulled_release_does_not_leave_its_clocks_running_for_the_next() {
        let d = scratch("pulled");
        let at = |offered: &str, now| note_seen(&d, offered, "0.9.850", now).unwrap();
        assert_eq!(at("0.9.851", 1_000), SeenTimes { seen_at: 1_000, behind_since: 1_000 });
        forget_offer(&d).unwrap();
        assert_eq!(at("0.9.852", 9_000), SeenTimes { seen_at: 9_000, behind_since: 9_000 }, "both from the next one");
        forget_offer(&d).unwrap();
        assert_eq!(at("0.9.852", 20_000), SeenTimes { seen_at: 20_000, behind_since: 20_000 }, "republished, it starts again");
        // The loop guard is not the soak's: it stays.
        record_attempt(&d, "0.9.852", 21_000).unwrap();
        forget_offer(&d).unwrap();
        assert_eq!(read_record(&d).attempt, Some(Stamp { version: "0.9.852".into(), at: 21_000 }));
        // And the look clears it only when it found nothing (a failed look
        // returns before, through the `?`).
        let src = include_str!("host_update.rs");
        let offer = src.split("pub async fn host_update_offer").nth(1).unwrap().split("#[tauri::command]").next().unwrap();
        let none = offer.find("if offered.is_none()").expect("on nothing newer");
        let forget = offer.find("forget_offer(&d)").expect("it forgets");
        assert!(none < forget);
        let _ = std::fs::remove_dir_all(&d);
    }

    /// The page's stall bound reads how far the download has got: the bytes,
    /// while downloading and once downloaded, from a counter each request
    /// starts afresh (coordinator, round 3: the updater has no timeout).
    #[test]
    fn the_status_says_how_many_bytes_have_arrived() {
        assert_eq!(status_of(&Phase::Downloading { version: "1".into() }, 4_096).bytes, Some(4_096));
        assert_eq!(status_of(&Phase::Ready { version: "1".into() }, 8_192).bytes, Some(8_192));
        assert_eq!(status_of(&Phase::Checking, 5).bytes, None);
        let mut inner = Inner::default();
        inner.bytes.fetch_add(100, Ordering::Relaxed);
        let old = inner.bytes.clone();
        begin(&mut inner);
        assert_eq!(inner.bytes.load(Ordering::Relaxed), 0, "a new request counts from nothing");
        old.fetch_add(1, Ordering::Relaxed);
        assert_eq!(inner.bytes.load(Ordering::Relaxed), 0, "and a late chunk of the old one counts for nothing");
        // The download feeds it, chunk by chunk.
        let src = include_str!("host_update.rs");
        let body = src.split("pub async fn host_update_download").nth(1).unwrap().split("#[tauri::command]").next().unwrap();
        assert!(body.contains("received.fetch_add(n as u64, Ordering::Relaxed)"));
    }

    /// A page reloaded mid-download leaves the shell downloading, or holding
    /// the update, with nobody left to cancel it. A new request must replace
    /// that, not be refused (coordinator, round 3).
    #[test]
    fn a_new_request_replaces_whatever_an_earlier_one_left() {
        for left in [
            Phase::Checking,
            Phase::Downloading { version: "0.9.851".into() },
            Phase::Ready { version: "0.9.851".into() },
            Phase::Failed { version: "0.9.851".into(), error: "x".into() },
        ] {
            let mut inner = Inner { phase: left.clone(), gen: 7, ..Inner::default() };
            let gen = begin(&mut inner);
            assert_eq!(inner.phase, Phase::Checking, "{left:?}");
            assert!(inner.held.is_none() && inner.task.is_none());
            assert!(gen > 7, "a later answer for the old request cannot write itself back in");
        }
        // The command no longer refuses one that is under way.
        let src = include_str!("host_update.rs");
        let body = src.split("pub async fn host_update_download").nth(1).unwrap().split("#[tauri::command]").next().unwrap();
        assert!(body.contains("begin(&mut state.inner.lock().unwrap())"));
        assert!(!body.contains("already being checked"));
    }

    #[test]
    fn the_status_names_each_phase_for_the_page() {
        assert_eq!(status_of(&Phase::Idle, 0), HostUpdateStatus { phase: "idle", version: None, error: None, bytes: None });
        assert_eq!(status_of(&Phase::Downloading { version: "1".into() }, 0).phase, "downloading");
        let failed = status_of(&Phase::Failed { version: "1".into(), error: "boom".into() }, 9);
        assert_eq!((failed.phase, failed.error.as_deref(), failed.bytes), ("failed", Some("boom"), None));
        assert_eq!(status_of(&Phase::Ready { version: "1".into() }, 9).version.as_deref(), Some("1"));
    }

    /// The relaunched app reads the marker BEFORE it can show a window: in
    /// setup, together with `--hidden`.
    #[test]
    fn setup_hides_the_window_on_a_relaunch_marker() {
        let lib = include_str!("lib.rs");
        let setup = lib.split(".setup(move |app|").nth(1).expect("setup");
        let hide_at = setup.find("let _ = w.hide();").expect("the hide");
        let take_at = setup.find("host_update::take_relaunch_hidden").expect("the marker is read in setup");
        assert!(take_at < hide_at, "read before the hide that it decides");
    }
}
