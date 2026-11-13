//! Hides WebView2's built-in screen-capture notification bar.
//!
//! When `getDisplayMedia` starts, Chromium (inside WebView2) shows a topmost
//! bar at the bottom of the screen: "tauri.localhost is sharing a window and
//! audio — Stop sharing / Hide". There is no WebView2 API or browser flag to
//! suppress it (some Electron-based chat apps patch it out of Chromium itself),
//! so we do what the bar's own "Hide" button does, programmatically: find the
//! bar's top-level window and hide it.
//!
//! Identification is deliberately conservative — all three must match:
//! 1. window class `Chrome_WidgetWin_1` (Chromium top-level widget),
//! 2. window title contains "sharing" (the bar's label),
//! 3. owning process is one of THIS app's own `msedgewebview2.exe` processes
//!    ([`own_webviews`]).
//! The in-app UI already shows who is streaming, and the streamer stops the
//! share from the app, so losing the bar loses nothing.
//!
//! ONLY PÚCA'S OWN BAR. Every WebView2 app on the machine draws the same bar from
//! a process of the same name, so the name alone also hides other apps' bars.
//! One of those is started by Púca itself: the Discord window (discord_window.rs)
//! is a second process of this executable with a WebView2 of its own, and a
//! screen share from Discord's page shows "discord.com is sharing your screen"
//! with its own Stop sharing button. That share goes to Discord, Púca's tray does
//! not turn amber for it, and with the Discord window behind a game the bar is the
//! one thing on the desktop that says it is still running. So it is never hidden,
//! and neither is any other app's: a WebView2 process is ours only when it is in
//! this process's tree and not in the Discord window's. That is the rule
//! `stream_boost::boost_targets` keeps for the same reason, and [`own_webviews`]
//! asks it rather than keeping a second one.
//!
//! Caveat: the title check matches the English WebView2 UI. On other UI
//! languages the bar simply stays visible (fail-open, never hides the wrong
//! window).

use crate::stream_boost::ProcRow;
use std::collections::HashSet;

/// The image every WebView2 process runs (browser, GPU, renderer, utility).
#[cfg_attr(not(windows), allow(dead_code))] // exercised by tests + Windows imp
const WEBVIEW_EXE: &str = "msedgewebview2.exe";

/// The processes whose sharing bar may be hidden: this app's own WebView2
/// processes. Every `msedgewebview2.exe` descended from `self_pid`, less those
/// under another process of this executable (the Discord window, whose bar
/// stays). Another app's WebView2 is not in this tree at all.
///
/// The same set a stream boost may touch, from the same function, so the two
/// cannot drift apart. Pure, so it is tested without a window.
#[cfg_attr(not(windows), allow(dead_code))] // exercised by tests + Windows imp
fn own_webviews(rows: &[ProcRow], self_pid: u32) -> HashSet<u32> {
    crate::stream_boost::boost_targets(rows, self_pid, WEBVIEW_EXE).into_iter().collect()
}

#[cfg(windows)]
pub fn hide_capture_bar() -> u32 {
    use windows::Win32::Foundation::{BOOL, HWND, LPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClassNameW, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible,
        ShowWindow, SW_HIDE,
    };

    struct Search {
        hidden: u32,
        /// This app's own WebView2 processes, read once, on the first window that
        /// looks like a bar (a poll with no bar on screen takes no snapshot).
        own: Option<HashSet<u32>>,
    }

    unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let search = &mut *(lparam.0 as *mut Search);

        if !IsWindowVisible(hwnd).as_bool() {
            return BOOL(1);
        }

        let mut class_buf = [0u16; 64];
        let class_len = GetClassNameW(hwnd, &mut class_buf);
        let class_name = String::from_utf16_lossy(&class_buf[..class_len.max(0) as usize]);
        // Chromium's top-level widget class is normally Chrome_WidgetWin_1, but the
        // suffix can vary across WebView2/Chromium versions — match the prefix. The
        // "sharing" title and process checks below keep this specific to the bar.
        if !class_name.starts_with("Chrome_WidgetWin") {
            return BOOL(1);
        }

        let mut title_buf = [0u16; 256];
        let title_len = GetWindowTextW(hwnd, &mut title_buf);
        let title = String::from_utf16_lossy(&title_buf[..title_len.max(0) as usize]).to_lowercase();
        if !title.contains("sharing") {
            return BOOL(1);
        }

        // Only a bar of THIS app's own WebView2 (see the module header).
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return BOOL(1);
        }
        let own = search
            .own
            .get_or_insert_with(|| own_webviews(&crate::stream_boost::process_snapshot(), std::process::id()));
        if !own.contains(&pid) {
            return BOOL(1);
        }

        let _ = ShowWindow(hwnd, SW_HIDE);
        search.hidden += 1;
        BOOL(1) // keep enumerating — bar + minimized pill can coexist
    }

    let mut search = Search { hidden: 0, own: None };
    unsafe {
        let _ = EnumWindows(Some(enum_proc), LPARAM(&mut search as *mut Search as isize));
    }
    search.hidden
}

#[cfg(not(windows))]
pub fn hide_capture_bar() -> u32 {
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(pid: u32, ppid: u32, name: &str) -> ProcRow {
        ProcRow { pid, ppid, name: name.into() }
    }

    /// This Púca with its WebView2, the Discord window it started
    /// (`Puca.exe --discord-window`) with Discord's WebView2, and another app's
    /// WebView2.
    fn machine() -> Vec<ProcRow> {
        vec![
            row(100, 1, "Puca.exe"),
            row(200, 100, "msedgewebview2.exe"), // Púca's browser: Púca's bar
            row(201, 200, "msedgewebview2.exe"), // Púca's renderer
            row(500, 100, "Puca.exe"),           // Puca.exe --discord-window
            row(600, 500, "msedgewebview2.exe"), // Discord's browser: Discord's bar
            row(601, 600, "msedgewebview2.exe"), // Discord's renderer
            row(800, 1, "OtherApp.exe"),
            row(900, 800, "msedgewebview2.exe"), // another app's WebView2
        ]
    }

    /// Púca's own bar is hidden; the Discord window's (and its Stop sharing
    /// button) is not, and neither is another app's.
    #[test]
    fn only_pucas_own_bar_is_hidden_never_the_discord_windows() {
        let rows = machine();
        let own = own_webviews(&rows, 100);
        assert!(own.contains(&200), "Púca's own bar is hidden: {own:?}");
        assert!(own.contains(&201));
        for pid in [600, 601] {
            assert!(!own.contains(&pid), "the Discord window's bar ({pid}) must stay: {own:?}");
        }
        assert!(!own.contains(&900), "another app's bar must stay: {own:?}");
        assert!(!own.contains(&100) && !own.contains(&500), "not WebView2 processes: {own:?}");
        // CONTROL: by name alone (what the hider used to ask), every one of them
        // is a WebView2 process, and the tree walk does reach Discord's.
        let by_name: Vec<u32> =
            rows.iter().filter(|r| r.name.eq_ignore_ascii_case(WEBVIEW_EXE)).map(|r| r.pid).collect();
        assert_eq!(by_name, vec![200, 201, 600, 601, 900]);
        let mut walked = crate::stream_boost::descendants_named(&rows, 100, WEBVIEW_EXE);
        walked.sort_unstable();
        assert_eq!(walked, vec![200, 201, 600, 601]);
    }

    /// The Discord window outliving the Púca that started it (a restart, an
    /// update): it is in no tree of the new Púca's, so its bar stays too.
    #[test]
    fn a_discord_window_from_an_earlier_puca_keeps_its_bar() {
        let rows = vec![
            row(100, 1, "Puca.exe"),
            row(200, 100, "msedgewebview2.exe"),
            row(500, 4242, "Puca.exe"), // the Púca that started it is gone
            row(600, 500, "msedgewebview2.exe"),
        ];
        assert_eq!(own_webviews(&rows, 100), HashSet::from([200]));
    }

    /// Púca Lite runs as `Puca-Lite.exe` and starts its Discord window as
    /// `Puca-Lite.exe --discord-window`; a debug build is `puca.exe`. The Discord
    /// window is found by this process's own image as the snapshot names it, not
    /// by a fixed name, so its bar stays in every build.
    #[test]
    fn the_discord_windows_bar_stays_whatever_this_executable_is_called() {
        for image in ["Puca-Lite.exe", "puca.exe"] {
            let rows = vec![
                row(100, 1, image),
                row(200, 100, "msedgewebview2.exe"), // this build's own bar
                row(500, 100, image),                // its --discord-window
                row(600, 500, "msedgewebview2.exe"), // Discord's bar
                row(601, 600, "msedgewebview2.exe"),
            ];
            assert_eq!(own_webviews(&rows, 100), HashSet::from([200]), "{image}");
        }
    }
}
