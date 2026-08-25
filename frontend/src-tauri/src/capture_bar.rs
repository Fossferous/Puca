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
//! 2. owning process is `msedgewebview2.exe`,
//! 3. window title contains "sharing" (the bar's label).
//! The in-app UI already shows who is streaming, and the streamer stops the
//! share from the app, so losing the bar loses nothing.
//!
//! Caveat: the title check matches the English WebView2 UI. On other UI
//! languages the bar simply stays visible (fail-open, never hides the wrong
//! window).

#[cfg(windows)]
pub fn hide_capture_bar() -> u32 {
    use windows::Win32::Foundation::{CloseHandle, BOOL, HWND, LPARAM, MAX_PATH};
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClassNameW, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible,
        ShowWindow, SW_HIDE,
    };

    unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let hidden_count = lparam.0 as *mut u32;

        if !IsWindowVisible(hwnd).as_bool() {
            return BOOL(1);
        }

        let mut class_buf = [0u16; 64];
        let class_len = GetClassNameW(hwnd, &mut class_buf);
        let class_name = String::from_utf16_lossy(&class_buf[..class_len.max(0) as usize]);
        // Chromium's top-level widget class is normally Chrome_WidgetWin_1, but the
        // suffix can vary across WebView2/Chromium versions — match the prefix. The
        // process + "sharing" title checks below keep this specific to the bar.
        if !class_name.starts_with("Chrome_WidgetWin") {
            return BOOL(1);
        }

        let mut title_buf = [0u16; 256];
        let title_len = GetWindowTextW(hwnd, &mut title_buf);
        let title = String::from_utf16_lossy(&title_buf[..title_len.max(0) as usize]).to_lowercase();
        if !title.contains("sharing") {
            return BOOL(1);
        }

        // Confirm the window belongs to a WebView2 renderer/browser process.
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return BOOL(1);
        }
        let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return BOOL(1);
        };
        let mut path_buf = [0u16; MAX_PATH as usize];
        let mut path_len = path_buf.len() as u32;
        let is_webview = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            windows::core::PWSTR(path_buf.as_mut_ptr()),
            &mut path_len,
        )
        .is_ok()
            && String::from_utf16_lossy(&path_buf[..path_len as usize])
                .to_lowercase()
                .ends_with("msedgewebview2.exe");
        let _ = CloseHandle(handle);
        if !is_webview {
            return BOOL(1);
        }

        let _ = ShowWindow(hwnd, SW_HIDE);
        *hidden_count += 1;
        BOOL(1) // keep enumerating — bar + minimized pill can coexist
    }

    let mut hidden: u32 = 0;
    unsafe {
        let _ = EnumWindows(Some(enum_proc), LPARAM(&mut hidden as *mut u32 as isize));
    }
    hidden
}

#[cfg(not(windows))]
pub fn hide_capture_bar() -> u32 {
    0
}
