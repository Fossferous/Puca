//! Keep the owner's per-application GPU pin on the WebView2 runtime that
//! actually captures and encodes a screen share.
//!
//! WHY. Windows lets a user pin an application to a GPU (Settings -> System ->
//! Display -> Graphics). The pin is stored per EXECUTABLE PATH in
//! `HKCU\Software\Microsoft\DirectX\UserGpuPreferences` as
//! `<exe path> = "GpuPreference=1;"` (1 = power saving, the integrated GPU;
//! 2 = high performance; 0 = let Windows decide). The owner of the machine
//! this was written for pins `Puca.exe` to the integrated GPU deliberately:
//! with a game using 100% of the discrete card, moving the app off it is what
//! stopped their stream looking choppy to viewers, and "unpin it" is not an
//! answer (`crates/puca-capture/examples/gpu-preference.rs`, `clip_capture.rs`).
//!
//! But `Puca.exe` is not the process that captures and encodes the share. That
//! is the WebView2 child — `msedgewebview2.exe` — whose path carries the
//! runtime version: `C:\Program Files (x86)\Microsoft\EdgeWebView\Application\
//! 153.0.4234.32\msedgewebview2.exe`. Every WebView2 auto-update changes that
//! path, and a pin keyed by the old path matches nothing. It went stale at 151
//! and again at 150, and on 2026-09-16 it was re-created by hand for 153 —
//! each time noticed only after a choppy share. This module does that hand
//! work at every start.
//!
//! WHEN. The preference is read when a process enumerates its adapters, and
//! Chromium's GPU process does that as it starts — moments after the webview
//! is created. Tauri creates the windows declared in `tauri.conf.json` BEFORE
//! the `setup` closure runs (`tauri::app::setup`), so `apply_before_webview`
//! is called from `run()` ahead of `tauri::Builder`, not from `setup`. A pin
//! written in `setup` would apply only to the NEXT launch, and an app that
//! lives in the tray may not be relaunched for weeks. The runtime the loader
//! is about to start is therefore resolved without a running webview: the
//! loader reports the version it will use (`tauri::webview_version`, i.e.
//! `GetAvailableCoreWebView2BrowserVersionString`) and the executable is
//! looked for under that version in the folders the runtime installs to, with
//! EdgeUpdate's own `EBWebView` folder hint tried first. Once the webview is
//! up, `confirm_running_webview` compares that answer against the browser
//! child's real image path and pins that too if they differ, so an exotic
//! layout (a fixed-version runtime, a policy folder) corrects itself for the
//! next launch and the log says what actually ran.
//!
//! The logger is attached at the END of `setup` — after the webview — so the
//! startup pass keeps its one line in `REPORT` and `log_outcome` writes it
//! once there is somewhere for it to go.
//!
//! WHAT IT WILL NOT DO. Nothing without a pin on this executable: a machine
//! whose owner never pinned the app is left exactly as it was — the key is
//! never created and never written. HKCU only, so no elevation. Entries for
//! other `msedgewebview2.exe` versions are removed only when their executable
//! is gone from disk (the runtime keeps the previous version's folder while a
//! process still uses it). Nothing else in the key is ever touched.
//!
//! THE PIN'S REACH. Windows keys it by executable path, and every WebView2 app
//! on the machine (Outlook, Teams, Widgets, ...) runs the same
//! `msedgewebview2.exe`. Pinning it pins them all — which is exactly what the
//! owner's hand-made entry already did. docs/FAQ.md says so to users.
//!
//! WHY NOT A CHROMIUM SWITCH. Chromium has `--use-adapter-luid=<high>,<low>`
//! ("Initialize the GPU process using the adapter with the specified LUID",
//! ui/gl/gl_switches.cc), and WebView2 APPENDS the
//! `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` environment variable (or an HKCU
//! `Software\Policies\Microsoft\Edge\WebView2\AdditionalBrowserArguments`
//! value named after the executable) to the configured arguments, so a switch
//! could be injected at startup without touching the pin key. The switch DOES
//! work: measured 2026-09-16 in headless Edge 153 (the same Chromium build as
//! that day's runtime) on an RTX 4080 SUPER + AMD iGPU machine,
//! `--use-adapter-luid=0,<iGPU>` moved the GPU process's ANGLE device from
//! `ANGLE (NVIDIA, ...)` to `ANGLE (AMD, ...)` with the AMD row marked ACTIVE
//! in chrome://gpu. It was still not adopted: a LUID is assigned per boot, so
//! the value would have to be recomputed at every start anyway; it steers
//! only the GPU process's ANGLE device, while the OS pin covers every process
//! of that image — including the browser process, where Chromium hosts the
//! desktop capture; and the OS pin is the mechanism the owner measured the
//! smooth stream with, so the switch would ship a configuration nobody has
//! measured. The registry mirror is the whole of the OS feature, applied to
//! the right file. If the shared-runtime reach ever matters more than that,
//! the switch is the alternative, and the FAQ records the same evidence.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use crate::stream_boost::ProcRow;

/// Where Windows Settings stores per-application GPU pins, under HKCU.
pub const KEY_PATH: &str = r"Software\Microsoft\DirectX\UserGpuPreferences";
/// The WebView2 runtime's process image. Every one of its processes —
/// browser, gpu, renderer, utility — runs from this file, so one pin covers
/// the capture and the encode.
const WEBVIEW_EXE: &str = "msedgewebview2.exe";
/// The token inside a value that carries the choice: `GpuPreference=1;`.
const TOKEN: &str = "GpuPreference";
/// EdgeUpdate's per-product state for the WebView2 runtime; its `EBWebView`
/// value names the versioned folder it last installed.
const EDGEUPDATE_WEBVIEW_CLIENT: &str =
    r"Microsoft\EdgeUpdate\ClientState\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";

/// One value in the pin key: an executable path and its setting string.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub name: String,
    pub value: String,
}

/// What the pin key should end up saying about the runtime executable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// This executable carries no pin to mirror (no entry, no token, or "let
    /// Windows decide" with nothing to update) — the machine is left alone.
    NoPin,
    /// The runtime entry already carries the same preference.
    AlreadyPinned { preference: String },
    /// Write `value` under `name` (`previous` is what was there, if anything).
    Write {
        name: String,
        value: String,
        previous: Option<String>,
    },
}

/// The whole decision, computed from plain inputs so it is testable without a
/// registry: what to write for the runtime, and which dead entries to drop.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    pub outcome: Outcome,
    /// Value names to delete: `msedgewebview2.exe` entries whose file is gone.
    pub remove: Vec<String>,
}

/// Where the runtime might be, for `candidate_exe_paths`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Hints {
    /// `WEBVIEW2_BROWSER_EXECUTABLE_FOLDER`: a fixed-version runtime, with the
    /// executable directly inside. The loader honours it over everything.
    pub fixed_folder: Option<PathBuf>,
    /// EdgeUpdate's `EBWebView` values (per-user, then machine): the versioned
    /// folder of the runtime it manages.
    pub ebwebview: Vec<PathBuf>,
    /// `%ProgramFiles(x86)%`, `%ProgramFiles%`, `%LOCALAPPDATA%` — the roots
    /// the runtime installs under `Microsoft\<channel folder>\Application\<version>`.
    pub roots: Vec<PathBuf>,
}

// ---- pure logic --------------------------------------------------------------

/// `GpuPreference=1;AppStatus=0;` -> `Some("1")`. Tokens are `key=value;`
/// pairs; Windows writes the preference first but nothing relies on order.
pub fn gpu_preference_of(value: &str) -> Option<&str> {
    value
        .split(';')
        .filter_map(|kv| kv.trim().split_once('='))
        .find(|(k, _)| k.trim().eq_ignore_ascii_case(TOKEN))
        .map(|(_, v)| v.trim())
        .filter(|v| !v.is_empty())
}

/// The runtime's value with the preference set to `preference`: the token
/// first (where Windows puts it), every other token of `existing` kept as it
/// was, so a flag some other tool wrote beside it survives.
pub fn merged_value(existing: Option<&str>, preference: &str) -> String {
    let mut out = format!("{TOKEN}={preference};");
    for kv in existing.unwrap_or("").split(';') {
        let kv = kv.trim();
        if kv.is_empty() {
            continue;
        }
        let is_pref = kv
            .split_once('=')
            .is_some_and(|(k, _)| k.trim().eq_ignore_ascii_case(TOKEN));
        if !is_pref {
            out.push_str(kv);
            out.push(';');
        }
    }
    out
}

/// Value names are executable paths, occasionally wrapped in quotes by
/// whichever tool wrote them. The registry's own lookups are case-insensitive;
/// so are ours.
fn normalise_name(name: &str) -> String {
    name.trim().trim_matches('"').to_lowercase()
}

/// The entry for `path`, however it was spelled when it was written.
pub fn find_entry<'a>(entries: &'a [Entry], path: &str) -> Option<&'a Entry> {
    let wanted = normalise_name(path);
    entries.iter().find(|e| normalise_name(&e.name) == wanted)
}

/// Value names that name a `msedgewebview2.exe` — in any folder — which no
/// longer exists. Nothing else is ever a candidate: another app's dead entry
/// is not ours to tidy, and non-path values (`DirectXUserGlobalSettings`)
/// never end in the runtime's file name.
pub fn stale_webview_entries(entries: &[Entry], exists: impl Fn(&Path) -> bool) -> Vec<String> {
    entries
        .iter()
        .filter(|e| {
            let name = e.name.trim().trim_matches('"');
            let is_webview = Path::new(name)
                .file_name()
                .is_some_and(|f| f.to_string_lossy().eq_ignore_ascii_case(WEBVIEW_EXE));
            is_webview && !exists(Path::new(name))
        })
        .map(|e| e.name.clone())
        .collect()
}

/// The decision. `app_exe` is this executable, `webview_exe` the runtime it
/// is about to start; `exists` answers for the stale sweep.
///
/// "Let Windows decide" (`GpuPreference=0`) counts as no pin for CREATING an
/// entry — a runtime entry saying "decide" would be noise — but an existing
/// runtime entry still follows it, so setting the app back to "decide" in
/// Settings releases the runtime at the next start instead of leaving it
/// pinned by a value the app wrote.
pub fn plan(
    entries: &[Entry],
    app_exe: &str,
    webview_exe: &str,
    exists: impl Fn(&Path) -> bool,
) -> Plan {
    let no_plan = Plan {
        outcome: Outcome::NoPin,
        remove: Vec::new(),
    };
    let Some(preference) = find_entry(entries, app_exe)
        .and_then(|e| gpu_preference_of(&e.value))
        .map(str::to_string)
    else {
        return no_plan;
    };
    let existing = find_entry(entries, webview_exe);
    if preference == "0" && existing.is_none() {
        return no_plan;
    }
    let outcome = match existing.and_then(|e| gpu_preference_of(&e.value)) {
        Some(current) if current == preference => Outcome::AlreadyPinned { preference },
        _ => Outcome::Write {
            // Reuse the stored spelling (case, quotes) so the write updates
            // that value instead of adding a second one for the same file.
            name: existing
                .map(|e| e.name.clone())
                .unwrap_or_else(|| webview_exe.to_string()),
            value: merged_value(existing.map(|e| e.value.as_str()), &preference),
            previous: existing.map(|e| e.value.clone()),
        },
    };
    Plan {
        outcome,
        remove: stale_webview_entries(entries, exists),
    }
}

/// `GetAvailableCoreWebView2BrowserVersionString` answers "153.0.4234.32", or
/// "153.0.4234.32 beta" when an Edge channel is standing in for the runtime.
/// -> (version, channel), or `None` for anything that is not a four-part
/// version.
pub fn parse_loader_version(s: &str) -> Option<(String, Option<String>)> {
    let mut parts = s.split_whitespace();
    let version = parts.next()?;
    let four_numbers = version.split('.').count() == 4
        && version
            .split('.')
            .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()));
    if !four_numbers {
        return None;
    }
    Some((version.to_string(), parts.next().map(str::to_lowercase)))
}

/// The folder under `...\Microsoft\` each channel installs into. Unknown
/// channels fall back to the runtime's — the candidate simply will not exist,
/// and `confirm_running_webview` catches whatever really ran.
pub fn channel_folder(channel: Option<&str>) -> &'static str {
    match channel {
        Some("beta") => "Edge Beta",
        Some("dev") => "Edge Dev",
        Some("canary") => "Edge SxS",
        _ => "EdgeWebView",
    }
}

/// Where the runtime executable for `version` may be, most authoritative
/// first: the fixed-version folder, EdgeUpdate's hint (only when it names
/// THIS version — mid-update the loader can already be on the newer one),
/// then the standard install roots.
pub fn candidate_exe_paths(version: &str, channel: Option<&str>, hints: &Hints) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let mut push = |p: PathBuf| {
        if !out.contains(&p) {
            out.push(p);
        }
    };
    if let Some(fixed) = &hints.fixed_folder {
        push(fixed.join(WEBVIEW_EXE));
    }
    for folder in &hints.ebwebview {
        if folder
            .file_name()
            .is_some_and(|n| n.to_string_lossy() == version)
        {
            push(folder.join(WEBVIEW_EXE));
        }
    }
    for root in &hints.roots {
        push(
            root.join("Microsoft")
                .join(channel_folder(channel))
                .join("Application")
                .join(version)
                .join(WEBVIEW_EXE),
        );
    }
    out
}

/// The runtime executable the loader is about to start, or `None` when its
/// version string is not one or no candidate exists.
pub fn resolve_exe(
    loader_version: &str,
    hints: &Hints,
    exists: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    let (version, channel) = parse_loader_version(loader_version)?;
    candidate_exe_paths(&version, channel.as_deref(), hints)
        .into_iter()
        .find(|p| exists(p))
}

/// The WebView2 BROWSER process: the direct child of this process named
/// `msedgewebview2.exe`. Its gpu/renderer/utility processes are grandchildren
/// and run from the same file, so one path answers for all of them.
pub fn browser_child(rows: &[ProcRow], self_pid: u32) -> Option<u32> {
    rows.iter()
        .find(|r| {
            r.ppid == self_pid && r.pid != self_pid && r.name.eq_ignore_ascii_case(WEBVIEW_EXE)
        })
        .map(|r| r.pid)
}

// ---- startup wiring -----------------------------------------------------------

/// What the startup pass did, kept until the logger exists and for the
/// confirmation pass.
struct Report {
    line: String,
    warn: bool,
    /// The preference this executable carries, when it has one.
    preference: Option<String>,
    /// The runtime executable the startup pass settled on (normalised).
    pinned: Option<String>,
}

static REPORT: OnceLock<Report> = OnceLock::new();

/// Mirror the pin now — before `tauri::Builder` creates the webview. Cheap: a
/// handful of registry reads, one loader call, a few `stat`s.
pub fn apply_before_webview() {
    let _ = REPORT.set(imp::apply());
}

/// The one line about what `apply_before_webview` did. Call once the log
/// plugin is attached.
pub fn log_outcome() {
    if let Some(r) = REPORT.get() {
        if r.warn {
            log::warn!("{}", r.line);
        } else {
            log::info!("{}", r.line);
        }
    }
}

/// With the webview up: is the browser child really running from the file the
/// startup pass pinned? If not, pin that one too (for the next launch) and say
/// so. Silent when they agree — the startup line already told the story.
pub fn confirm_running_webview() {
    let Some(report) = REPORT.get() else {
        return;
    };
    if report.preference.is_none() {
        return;
    }
    let pinned = report.pinned.clone();
    std::thread::Builder::new()
        .name("webview-gpu-pin-confirm".into())
        .spawn(move || imp::confirm(pinned.as_deref()))
        .ok();
}

mod imp {
    use super::*;
    use windows::core::{HSTRING, PCWSTR, PWSTR};
    use windows::Win32::Foundation::{CloseHandle, ERROR_MORE_DATA, ERROR_SUCCESS};
    use windows::Win32::System::Registry::{
        RegCloseKey, RegDeleteValueW, RegEnumValueW, RegGetValueW, RegOpenKeyExW, RegSetValueExW,
        HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_QUERY_VALUE, KEY_SET_VALUE, REG_SAM_FLAGS,
        REG_SZ, RRF_RT_REG_SZ,
    };
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// Raw REG_SZ bytes -> String, minus the terminator(s).
    fn sz_to_string(bytes: &[u8]) -> String {
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&units)
            .trim_end_matches('\0')
            .to_string()
    }

    fn open_pin_key(access: REG_SAM_FLAGS) -> Option<HKEY> {
        let mut hkey = HKEY::default();
        // SAFETY: plain registry open against a predefined root; the handle
        // is closed by every caller on every path.
        let rc = unsafe {
            RegOpenKeyExW(
                HKEY_CURRENT_USER,
                &HSTRING::from(KEY_PATH),
                0,
                access,
                &mut hkey,
            )
        };
        (rc == ERROR_SUCCESS).then_some(hkey)
    }

    /// Every REG_SZ value in the pin key. `None` when the key does not exist:
    /// nobody on this machine has pinned anything, and we never create it.
    pub(super) fn read_entries() -> Option<Vec<Entry>> {
        let hkey = open_pin_key(KEY_QUERY_VALUE)?;
        let mut out = Vec::new();
        // Value names are at most 16 383 characters; data grows on demand.
        let mut name = vec![0u16; 16_384];
        let mut data = vec![0u8; 4096];
        let mut index = 0u32;
        loop {
            let mut name_len = name.len() as u32;
            let mut ty = 0u32;
            let mut data_len = data.len() as u32;
            // SAFETY: both buffers outlive the call and their lengths are
            // passed alongside; the API writes within them.
            let rc = unsafe {
                RegEnumValueW(
                    hkey,
                    index,
                    PWSTR(name.as_mut_ptr()),
                    &mut name_len,
                    None,
                    Some(&mut ty),
                    Some(data.as_mut_ptr()),
                    Some(&mut data_len),
                )
            };
            if rc == ERROR_MORE_DATA && data.len() < (1 << 20) {
                // Same index again with room for the data it asked for. Grow
                // geometrically too: if the API ever reports MORE_DATA without
                // a size (it does so for a short NAME buffer), this stays a
                // handful of calls rather than a two-byte crawl to the cap.
                let wanted = (data_len as usize + 2).max(data.len() * 2);
                data.resize(wanted, 0);
                continue;
            }
            if rc != ERROR_SUCCESS {
                break;
            }
            if ty == REG_SZ.0 {
                out.push(Entry {
                    name: String::from_utf16_lossy(&name[..name_len as usize]),
                    value: sz_to_string(&data[..data_len as usize]),
                });
            }
            index += 1;
        }
        // SAFETY: handle from open_pin_key, closed exactly once.
        unsafe {
            let _ = RegCloseKey(hkey);
        }
        Some(out)
    }

    pub(super) fn set_value(name: &str, value: &str) -> Result<(), u32> {
        let hkey = open_pin_key(KEY_SET_VALUE).ok_or(0u32)?;
        let name_w = wide(name);
        let data: Vec<u8> = wide(value).iter().flat_map(|u| u.to_le_bytes()).collect();
        // SAFETY: name_w and data outlive the call; REG_SZ data is the
        // NUL-terminated UTF-16 the API expects.
        let rc = unsafe { RegSetValueExW(hkey, PCWSTR(name_w.as_ptr()), 0, REG_SZ, Some(&data)) };
        unsafe {
            let _ = RegCloseKey(hkey);
        }
        (rc == ERROR_SUCCESS).then_some(()).ok_or(rc.0)
    }

    pub(super) fn delete_value(name: &str) -> Result<(), u32> {
        let hkey = open_pin_key(KEY_SET_VALUE).ok_or(0u32)?;
        let name_w = wide(name);
        // SAFETY: name_w outlives the call.
        let rc = unsafe { RegDeleteValueW(hkey, PCWSTR(name_w.as_ptr())) };
        unsafe {
            let _ = RegCloseKey(hkey);
        }
        (rc == ERROR_SUCCESS).then_some(()).ok_or(rc.0)
    }

    /// A REG_SZ read in one call (RegGetValueW opens, type-checks, closes).
    fn read_string(root: HKEY, subkey: &str, value: &str) -> Option<String> {
        let subkey = HSTRING::from(subkey);
        let value = HSTRING::from(value);
        let mut size = 0u32;
        // SAFETY: size query first (no buffer), then a buffer of that size.
        unsafe {
            let rc = RegGetValueW(
                root,
                &subkey,
                &value,
                RRF_RT_REG_SZ,
                None,
                None,
                Some(&mut size),
            );
            if rc != ERROR_SUCCESS || size == 0 {
                return None;
            }
            let mut buf = vec![0u8; size as usize];
            let rc = RegGetValueW(
                root,
                &subkey,
                &value,
                RRF_RT_REG_SZ,
                None,
                Some(buf.as_mut_ptr() as *mut _),
                Some(&mut size),
            );
            if rc != ERROR_SUCCESS {
                return None;
            }
            let s = sz_to_string(&buf[..(size as usize).min(buf.len())]);
            (!s.is_empty()).then_some(s)
        }
    }

    pub(super) fn hints() -> Hints {
        let env_path = |k: &str| {
            std::env::var_os(k)
                .map(PathBuf::from)
                .filter(|p| !p.as_os_str().is_empty())
        };
        let mut ebwebview = Vec::new();
        // Per-user runtime first, then the machine-wide one. EdgeUpdate is
        // 32-bit, so on a 64-bit OS its machine state sits under WOW6432Node.
        let places = [
            (
                HKEY_CURRENT_USER,
                format!(r"Software\{EDGEUPDATE_WEBVIEW_CLIENT}"),
            ),
            (
                HKEY_LOCAL_MACHINE,
                format!(r"SOFTWARE\WOW6432Node\{EDGEUPDATE_WEBVIEW_CLIENT}"),
            ),
            (
                HKEY_LOCAL_MACHINE,
                format!(r"SOFTWARE\{EDGEUPDATE_WEBVIEW_CLIENT}"),
            ),
        ];
        for (root, subkey) in places {
            if let Some(folder) = read_string(root, &subkey, "EBWebView") {
                ebwebview.push(PathBuf::from(folder));
            }
        }
        Hints {
            fixed_folder: env_path("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER"),
            ebwebview,
            roots: ["ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"]
                .into_iter()
                .filter_map(env_path)
                .collect(),
        }
    }

    fn app_identity() -> Option<(PathBuf, String)> {
        let exe = std::env::current_exe().ok()?;
        let name = exe
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| exe.to_string_lossy().into_owned());
        Some((exe, name))
    }

    /// Plan against `entries` for `webview_exe`, carry it out, and describe
    /// it (without the `[gpu-pin]` prefix). `true` = worth a warning.
    fn execute(
        entries: &[Entry],
        app_name: &str,
        app_exe: &str,
        webview_exe: &Path,
    ) -> (String, bool) {
        let webview_s = webview_exe.to_string_lossy();
        let plan = plan(entries, app_exe, &webview_s, |p| p.exists());
        let mut warn = false;
        let mut line = match &plan.outcome {
            Outcome::NoPin => {
                format!("{app_name} has no GPU pin to mirror (absent, or \"let Windows decide\")")
            }
            Outcome::AlreadyPinned { preference } => format!(
                "{webview_s} already carries GpuPreference={preference}, matching {app_name}; nothing to write"
            ),
            Outcome::Write {
                name,
                value,
                previous,
            } => match set_value(name, value) {
                Ok(()) => {
                    let was = previous
                        .as_deref()
                        .map(|p| format!("was {p:?}"))
                        .unwrap_or_else(|| "was absent".into());
                    format!("wrote {value:?} for {name} to match {app_name} ({was})")
                }
                Err(code) => {
                    warn = true;
                    format!("could not write {value:?} for {name} (error {code})")
                }
            },
        };
        let mut removed = Vec::new();
        let mut failed = Vec::new();
        for name in &plan.remove {
            match delete_value(name) {
                Ok(()) => removed.push(name.clone()),
                Err(code) => failed.push(format!("{name} (error {code})")),
            }
        }
        if !removed.is_empty() {
            let noun = if removed.len() == 1 {
                "entry"
            } else {
                "entries"
            };
            line.push_str(&format!(
                "; removed {} stale runtime {noun}: {}",
                removed.len(),
                removed.join(", ")
            ));
        }
        if !failed.is_empty() {
            warn = true;
            line.push_str(&format!("; could not remove {}", failed.join(", ")));
        }
        (line, warn)
    }

    pub(super) fn apply() -> Report {
        let none = |line: String, warn: bool| Report {
            line,
            warn,
            preference: None,
            pinned: None,
        };
        let Some((app_exe, app_name)) = app_identity() else {
            return none(
                "[gpu-pin] cannot tell this executable's path; GPU pin not mirrored".into(),
                true,
            );
        };
        let app_exe_s = app_exe.to_string_lossy().into_owned();
        let Some(entries) = read_entries() else {
            return none(
                format!("[gpu-pin] no per-app GPU preferences for this user; {app_name} is not pinned, WebView2 left alone"),
                false,
            );
        };
        let Some(preference) = find_entry(&entries, &app_exe_s)
            .and_then(|e| gpu_preference_of(&e.value))
            .map(str::to_string)
        else {
            return none(
                format!("[gpu-pin] {app_name} has no GPU preference (HKCU\\{KEY_PATH}); WebView2 left alone"),
                false,
            );
        };
        let pinned_report = |line: String, warn: bool, pinned: Option<String>| Report {
            line,
            warn,
            preference: Some(preference.clone()),
            pinned,
        };
        let version = match tauri::webview_version() {
            Ok(v) => v,
            Err(e) => {
                return pinned_report(
                    format!("[gpu-pin] {app_name} is pinned (GpuPreference={preference}) but the WebView2 loader gave no version ({e}); nothing written"),
                    true,
                    None,
                )
            }
        };
        let Some(webview_exe) = resolve_exe(&version, &hints(), |p| p.exists()) else {
            return pinned_report(
                format!("[gpu-pin] {app_name} is pinned (GpuPreference={preference}) but no {WEBVIEW_EXE} for runtime {version:?} was found; nothing written"),
                true,
                None,
            );
        };
        let (line, warn) = execute(&entries, &app_name, &app_exe_s, &webview_exe);
        pinned_report(
            format!("[gpu-pin] {line}"),
            warn,
            Some(normalise_name(&webview_exe.to_string_lossy())),
        )
    }

    fn image_path(pid: u32) -> Option<PathBuf> {
        // SAFETY: limited-information handle, closed on every path; the
        // buffer outlives the call and its length travels with it.
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
            let mut buf = vec![0u16; 32_768];
            let mut len = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(
                handle,
                PROCESS_NAME_WIN32,
                PWSTR(buf.as_mut_ptr()),
                &mut len,
            )
            .is_ok();
            let _ = CloseHandle(handle);
            ok.then(|| PathBuf::from(String::from_utf16_lossy(&buf[..len as usize])))
        }
    }

    pub(super) fn confirm(pinned: Option<&str>) {
        let rows = crate::stream_boost::process_snapshot();
        let Some(pid) = browser_child(&rows, std::process::id()) else {
            return;
        };
        let Some(real) = image_path(pid) else {
            return;
        };
        let real_s = real.to_string_lossy().into_owned();
        if pinned == Some(normalise_name(&real_s).as_str()) {
            return;
        }
        let Some((app_exe, app_name)) = app_identity() else {
            return;
        };
        let Some(entries) = read_entries() else {
            return;
        };
        let (line, _) = execute(&entries, &app_name, &app_exe.to_string_lossy(), &real);
        let instead = pinned
            .map(|p| format!(" rather than {p}"))
            .unwrap_or_default();
        log::warn!(
            "[gpu-pin] the running WebView2 is {real_s}{instead}; {line}; that pin applies from the next launch"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const APP: &str = r"C:\Users\someone\AppData\Local\Púca\Puca.exe";
    const RT: &str = r"C:\Program Files (x86)\Microsoft\EdgeWebView\Application\153.0.4234.32\msedgewebview2.exe";
    const OLD: &str = r"C:\Program Files (x86)\Microsoft\EdgeWebView\Application\151.0.4160.20\msedgewebview2.exe";

    fn e(name: &str, value: &str) -> Entry {
        Entry {
            name: name.into(),
            value: value.into(),
        }
    }

    /// `exists` that knows exactly the given files.
    fn on_disk<'a>(files: &'a [&'a str]) -> impl Fn(&Path) -> bool + 'a {
        move |p: &Path| files.iter().any(|f| Path::new(f) == p)
    }

    /// The key as Windows Settings leaves it: the app's pin, a non-path
    /// value, other apps' entries in every shape seen in the wild.
    fn settings_key() -> Vec<Entry> {
        vec![
            e("GraphicsFeaturesNotificationConfig", "1"),
            e(r"C:\Program Files\Other\other.exe", "GpuPreference=1;"),
            e(r"E:\Games\game\game.exe", "GpuPreference=0;AppStatus=0;"),
            e(
                r#""C:\Users\someone\AppData\Local\Programs\quoted\app.exe""#,
                "GpuPreference=2;",
            ),
            e("DirectXUserGlobalSettings", "SwapEffectUpgradeEnable=1;"),
            e(APP, "GpuPreference=1;"),
        ]
    }

    #[test]
    fn preference_token_is_extracted_from_settings_style_values() {
        assert_eq!(gpu_preference_of("GpuPreference=1;"), Some("1"));
        assert_eq!(gpu_preference_of("GpuPreference=0;AppStatus=0;"), Some("0"));
        assert_eq!(gpu_preference_of("AppStatus=0;GpuPreference=2;"), Some("2"));
        assert_eq!(gpu_preference_of(" gpupreference = 2 ; "), Some("2"));
        assert_eq!(gpu_preference_of("AppStatus=0;"), None);
        assert_eq!(gpu_preference_of("GpuPreference=;"), None);
        assert_eq!(gpu_preference_of(""), None);
    }

    #[test]
    fn merged_value_puts_the_preference_first_and_keeps_the_rest() {
        assert_eq!(merged_value(None, "1"), "GpuPreference=1;");
        assert_eq!(
            merged_value(Some("GpuPreference=2;AppStatus=0;"), "1"),
            "GpuPreference=1;AppStatus=0;"
        );
        assert_eq!(
            merged_value(Some("AppStatus=0;"), "1"),
            "GpuPreference=1;AppStatus=0;"
        );
        assert_eq!(
            merged_value(Some("GpuPreference=1"), "1"),
            "GpuPreference=1;"
        );
        assert_eq!(merged_value(Some(";;"), "2"), "GpuPreference=2;");
    }

    #[test]
    fn loader_version_with_and_without_a_channel() {
        assert_eq!(
            parse_loader_version("153.0.4234.32"),
            Some(("153.0.4234.32".into(), None))
        );
        assert_eq!(
            parse_loader_version("153.0.4234.32 Beta"),
            Some(("153.0.4234.32".into(), Some("beta".into())))
        );
        assert_eq!(parse_loader_version(""), None);
        assert_eq!(parse_loader_version("153.0"), None);
        assert_eq!(parse_loader_version("153.0.4234.x"), None);
        assert_eq!(parse_loader_version("..."), None);
    }

    #[test]
    fn channel_folders() {
        assert_eq!(channel_folder(None), "EdgeWebView");
        assert_eq!(channel_folder(Some("beta")), "Edge Beta");
        assert_eq!(channel_folder(Some("dev")), "Edge Dev");
        assert_eq!(channel_folder(Some("canary")), "Edge SxS");
        assert_eq!(channel_folder(Some("weird")), "EdgeWebView");
    }

    #[test]
    fn candidates_follow_the_loader_order_and_drop_a_hint_for_another_version() {
        let hints = Hints {
            fixed_folder: Some(PathBuf::from(r"D:\fixed-runtime")),
            ebwebview: vec![
                // Mid-update: EdgeUpdate still says 152 while the loader is on 153.
                PathBuf::from(
                    r"C:\Program Files (x86)\Microsoft\EdgeWebView\Application\152.0.4191.66",
                ),
                PathBuf::from(
                    r"C:\Users\someone\AppData\Local\Microsoft\EdgeWebView\Application\153.0.4234.32",
                ),
            ],
            roots: vec![
                PathBuf::from(r"C:\Program Files (x86)"),
                PathBuf::from(r"C:\Program Files"),
                PathBuf::from(r"C:\Users\someone\AppData\Local"),
            ],
        };
        let got = candidate_exe_paths("153.0.4234.32", None, &hints);
        let want: Vec<PathBuf> = [
            r"D:\fixed-runtime\msedgewebview2.exe",
            r"C:\Users\someone\AppData\Local\Microsoft\EdgeWebView\Application\153.0.4234.32\msedgewebview2.exe",
            RT,
            r"C:\Program Files\Microsoft\EdgeWebView\Application\153.0.4234.32\msedgewebview2.exe",
        ]
        .into_iter()
        .map(PathBuf::from)
        .collect();
        assert_eq!(got, want, "fixed folder, matching hint, then the roots; the per-user root is deduplicated against the hint");
        assert!(
            !got.iter()
                .any(|p| p.to_string_lossy().contains("152.0.4191.66")),
            "a hint for another version must not be pinned"
        );
    }

    #[test]
    fn a_channel_runtime_lives_under_its_own_folder() {
        let hints = Hints {
            roots: vec![PathBuf::from(r"C:\Program Files (x86)")],
            ..Hints::default()
        };
        let got = candidate_exe_paths("154.0.4300.1", Some("beta"), &hints);
        assert_eq!(
            got,
            vec![PathBuf::from(
                r"C:\Program Files (x86)\Microsoft\Edge Beta\Application\154.0.4300.1\msedgewebview2.exe"
            )]
        );
    }

    #[test]
    fn resolve_picks_the_first_candidate_that_exists() {
        let hints = Hints {
            roots: vec![
                PathBuf::from(r"C:\Program Files (x86)"),
                PathBuf::from(r"C:\Users\someone\AppData\Local"),
            ],
            ..Hints::default()
        };
        let per_user = r"C:\Users\someone\AppData\Local\Microsoft\EdgeWebView\Application\153.0.4234.32\msedgewebview2.exe";
        assert_eq!(
            resolve_exe("153.0.4234.32", &hints, on_disk(&[per_user])),
            Some(PathBuf::from(per_user))
        );
        assert_eq!(
            resolve_exe("153.0.4234.32", &hints, on_disk(&[RT, per_user])),
            Some(PathBuf::from(RT)),
            "the machine-wide root comes first when both exist"
        );
        assert_eq!(resolve_exe("153.0.4234.32", &hints, on_disk(&[])), None);
        assert_eq!(resolve_exe("not a version", &hints, on_disk(&[RT])), None);
    }

    #[test]
    fn no_pin_on_the_app_means_nothing_at_all_even_with_stale_entries() {
        let mut entries = settings_key();
        entries.retain(|e| e.name != APP);
        entries.push(e(OLD, "GpuPreference=1;"));
        let got = plan(&entries, APP, RT, on_disk(&[RT]));
        assert_eq!(
            got,
            Plan {
                outcome: Outcome::NoPin,
                remove: vec![]
            },
            "an unpinned machine is left exactly as it was — no sweep either"
        );
    }

    #[test]
    fn an_app_entry_without_the_token_is_not_a_pin() {
        let mut entries = settings_key();
        entries.retain(|e| e.name != APP);
        entries.push(e(APP, "AppStatus=0;"));
        assert_eq!(
            plan(&entries, APP, RT, on_disk(&[RT])).outcome,
            Outcome::NoPin
        );
    }

    #[test]
    fn an_absent_runtime_entry_is_written_with_the_apps_preference() {
        let got = plan(&settings_key(), APP, RT, on_disk(&[RT]));
        assert_eq!(
            got.outcome,
            Outcome::Write {
                name: RT.into(),
                value: "GpuPreference=1;".into(),
                previous: None
            }
        );
        assert!(got.remove.is_empty());
    }

    #[test]
    fn a_matching_runtime_entry_is_left_alone() {
        let mut entries = settings_key();
        entries.push(e(RT, "GpuPreference=1;"));
        assert_eq!(
            plan(&entries, APP, RT, on_disk(&[RT])).outcome,
            Outcome::AlreadyPinned {
                preference: "1".into()
            }
        );
    }

    #[test]
    fn a_differing_runtime_entry_is_overwritten_keeping_its_other_tokens() {
        let mut entries = settings_key();
        entries.push(e(RT, "GpuPreference=2;AppStatus=0;"));
        assert_eq!(
            plan(&entries, APP, RT, on_disk(&[RT])).outcome,
            Outcome::Write {
                name: RT.into(),
                value: "GpuPreference=1;AppStatus=0;".into(),
                previous: Some("GpuPreference=2;AppStatus=0;".into())
            }
        );
    }

    #[test]
    fn let_windows_decide_creates_nothing_but_releases_an_existing_runtime_entry() {
        let mut entries = settings_key();
        entries.retain(|e| e.name != APP);
        entries.push(e(APP, "GpuPreference=0;"));
        assert_eq!(
            plan(&entries, APP, RT, on_disk(&[RT])).outcome,
            Outcome::NoPin,
            "a runtime entry saying \"decide\" would be noise"
        );
        entries.push(e(RT, "GpuPreference=1;"));
        assert_eq!(
            plan(&entries, APP, RT, on_disk(&[RT])).outcome,
            Outcome::Write {
                name: RT.into(),
                value: "GpuPreference=0;".into(),
                previous: Some("GpuPreference=1;".into())
            },
            "unpinning the app in Settings must unpin the runtime the app pinned"
        );
    }

    #[test]
    fn lookups_ignore_case_and_quotes_and_reuse_the_stored_spelling() {
        let entries = vec![
            e(&APP.to_uppercase(), "GpuPreference=2;"),
            e(&format!("\"{RT}\""), "GpuPreference=1;"),
        ];
        let got = plan(&entries, APP, RT, on_disk(&[RT]));
        assert_eq!(
            got.outcome,
            Outcome::Write {
                name: format!("\"{RT}\""),
                value: "GpuPreference=2;".into(),
                previous: Some("GpuPreference=1;".into())
            },
            "the write goes to the value that already exists, not a second spelling of it"
        );
    }

    #[test]
    fn only_runtime_entries_whose_file_is_gone_are_stale() {
        let mut entries = settings_key();
        entries.push(e(OLD, "GpuPreference=1;"));
        entries.push(e(RT, "GpuPreference=1;"));
        entries.push(e(
            &format!("\"{}\"", OLD.replace("151", "150")),
            "GpuPreference=1;",
        ));
        // The other apps' executables do not "exist" here either — never ours to remove.
        let got = plan(&entries, APP, RT, on_disk(&[RT]));
        assert_eq!(
            got.remove,
            vec![
                OLD.to_string(),
                format!("\"{}\"", OLD.replace("151", "150"))
            ]
        );
        assert_eq!(
            got.outcome,
            Outcome::AlreadyPinned {
                preference: "1".into()
            }
        );
    }

    #[test]
    fn stale_sweep_matches_the_file_name_case_insensitively() {
        let upper = OLD.replace("msedgewebview2.exe", "MsEdgeWebView2.EXE");
        let entries = vec![e(&upper, "GpuPreference=1;")];
        assert_eq!(stale_webview_entries(&entries, on_disk(&[])), vec![upper]);
        assert!(
            stale_webview_entries(&[e("DirectXUserGlobalSettings", "x")], on_disk(&[])).is_empty()
        );
    }

    #[test]
    fn the_browser_process_is_the_direct_child_only() {
        let row = |pid, ppid, name: &str| ProcRow {
            pid,
            ppid,
            name: name.into(),
        };
        let rows = vec![
            row(100, 1, "Puca.exe"),
            row(201, 200, "msedgewebview2.exe"), // gpu — a grandchild
            row(200, 100, "MsEdgeWebView2.EXE"), // browser
            row(300, 1, "msedgewebview2.exe"),   // someone else's runtime
            row(101, 100, "puca-agent.exe"),
        ];
        assert_eq!(browser_child(&rows, 100), Some(200));
        assert_eq!(browser_child(&rows, 999), None);
    }

    // ---- human-run, against THIS machine ------------------------------------
    //
    //   cargo test --manifest-path frontend/src-tauri/Cargo.toml --lib \
    //       webview_gpu_pin::tests::real_ -- --ignored --nocapture
    //
    // Everything above fabricates its inputs. These two touch the real
    // registry and the real loader, which is the only way to know the FFI
    // half (buffer sizes, string encodings, key access) is right — a green
    // pure test says nothing about that.

    /// Read-only: what the app would do on this machine, for this test binary
    /// (never pinned, so NoPin) and for whatever executables ARE pinned.
    #[test]
    #[ignore = "reads this machine's UserGpuPreferences key and WebView2 loader; run by hand with --nocapture"]
    fn real_machine_read_only_plan() {
        let Some(entries) = imp::read_entries() else {
            eprintln!("no UserGpuPreferences key: nothing on this machine is pinned");
            return;
        };
        eprintln!("{} REG_SZ entries in HKCU\\{KEY_PATH}", entries.len());
        let version = tauri::webview_version().expect("WebView2 runtime present");
        let (parsed, channel) = parse_loader_version(&version).expect("a four-part version");
        eprintln!("loader version {version:?} -> {parsed} channel {channel:?}");
        let hints = imp::hints();
        eprintln!("hints: {hints:#?}");
        let rt = resolve_exe(&version, &hints, |p| p.exists()).expect("runtime exe resolved");
        assert!(rt.exists());
        eprintln!("runtime exe: {}", rt.display());
        let me = std::env::current_exe()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert_eq!(
            plan(&entries, &me, &rt.to_string_lossy(), |p| p.exists()).outcome,
            Outcome::NoPin,
            "a test binary is never pinned"
        );
        for e in entries
            .iter()
            .filter(|e| gpu_preference_of(&e.value).is_some())
        {
            let p = plan(&entries, &e.name, &rt.to_string_lossy(), |p| p.exists());
            eprintln!("if {} were this app -> {:?}", e.name, p);
        }
    }

    /// Write, read back, delete ONE throwaway value. The name is a
    /// `msedgewebview2.exe` path that cannot exist, so if this ever dies
    /// half-way the app's own stale sweep removes it at the next start.
    #[test]
    #[ignore = "writes then deletes one throwaway value in this user's UserGpuPreferences key"]
    fn real_key_write_and_delete_roundtrip() {
        const NAME: &str = r"C:\Puca-gpu-pin-selftest-not-a-real-folder\msedgewebview2.exe";
        let Some(before) = imp::read_entries() else {
            eprintln!("SKIPPED: no UserGpuPreferences key, and the app never creates it");
            return;
        };
        assert!(
            find_entry(&before, NAME).is_none(),
            "a previous run left the value behind"
        );
        imp::set_value(NAME, "GpuPreference=1;AppStatus=0;").expect("write");
        let mid = imp::read_entries().unwrap();
        let written = find_entry(&mid, NAME).expect("readable after the write");
        assert_eq!(written.value, "GpuPreference=1;AppStatus=0;");
        assert_eq!(
            written.name, NAME,
            "stored spelling is exactly what was written"
        );
        assert_eq!(
            stale_webview_entries(&mid, |p| p.exists()),
            vec![NAME.to_string()],
            "the throwaway is the only stale runtime entry (so it is self-cleaning)"
        );
        imp::delete_value(NAME).expect("delete");
        let after = imp::read_entries().unwrap();
        assert!(find_entry(&after, NAME).is_none());
        assert_eq!(after, before, "the key is exactly as it was");
    }
}
