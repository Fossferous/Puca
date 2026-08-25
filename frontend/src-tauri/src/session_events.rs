//! System suspend / session lock notifications for the frontend.
//!
//! Emits the Tauri event `system-suspend-or-lock` (payload `{ reason }`,
//! `"suspend"` or `"lock"`) so features that keep sensitive material in memory
//! can drop it before the machine hibernates or the console locks. Today's one
//! consumer is the clip replay buffer (frontend/src/api/clips/replayBuffer.ts,
//! docs/CLIPS.md): a hibernation writes all of RAM to `hiberfil.sys`, so the
//! buffer must not survive it.
//!
//! Mechanism: a HIDDEN TOP-LEVEL window on its own thread with a message loop.
//! It has to be a real top-level window, not a message-only one — Windows
//! broadcasts `WM_POWERBROADCAST` and `WM_WTSSESSION_CHANGE` to top-level
//! windows only; `HWND_MESSAGE` windows never see broadcasts. Same pattern as
//! hotkeys.rs's hook thread (a dedicated thread owning its own loop), kept
//! separate so neither can stall the other.

#[cfg(target_os = "windows")]
pub mod windows_impl {
    use std::sync::OnceLock;
    use tauri::{AppHandle, Emitter};
    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::RemoteDesktop::WTSRegisterSessionNotification;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, RegisterClassW,
        TranslateMessage, MSG, WINDOW_EX_STYLE, WNDCLASSW, WS_OVERLAPPED,
    };

    // Stable Win32 ABI values (winuser.h / wtsapi32.h); the crate version we
    // pin does not export all of them under the features we compile.
    const WM_POWERBROADCAST: u32 = 0x0218;
    const PBT_APMSUSPEND: usize = 0x0004;
    const WM_WTSSESSION_CHANGE: u32 = 0x02B1;
    const NOTIFY_FOR_THIS_SESSION: u32 = 0;
    const WTS_CONSOLE_DISCONNECT: u32 = 2;
    const WTS_REMOTE_DISCONNECT: u32 = 4;
    const WTS_SESSION_LOCK: u32 = 7;

    static APP: OnceLock<AppHandle> = OnceLock::new();

    #[derive(serde::Serialize, Clone)]
    struct Payload {
        reason: &'static str,
    }

    /// Start the listener thread once. Idempotent; a failure to create the
    /// window is logged and the app runs without the event (the consumer's
    /// wipe-on-disarm/leave/quit paths still apply).
    pub fn start(app: AppHandle) {
        if APP.set(app).is_err() {
            return; // already started
        }
        std::thread::Builder::new()
            .name("session-events".into())
            .spawn(thread_main)
            .ok();
    }

    fn emit(reason: &'static str) {
        if let Some(app) = APP.get() {
            if let Err(e) = app.emit("system-suspend-or-lock", Payload { reason }) {
                log::warn!("[session-events] emit failed: {e:?}");
            } else {
                log::info!("[session-events] {reason}");
            }
        }
    }

    unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        match msg {
            WM_POWERBROADCAST if wparam.0 == PBT_APMSUSPEND => {
                emit("suspend");
                LRESULT(1) // TRUE: we handled it (and do not veto)
            }
            WM_WTSSESSION_CHANGE => {
                let code = wparam.0 as u32;
                if code == WTS_SESSION_LOCK || code == WTS_CONSOLE_DISCONNECT || code == WTS_REMOTE_DISCONNECT {
                    emit("lock");
                }
                LRESULT(0)
            }
            _ => DefWindowProcW(hwnd, msg, wparam, lparam),
        }
    }

    fn thread_main() {
        unsafe {
            let hinstance = match GetModuleHandleW(PCWSTR::null()) {
                Ok(h) => h,
                Err(e) => { log::warn!("[session-events] GetModuleHandleW failed: {e:?}"); return; }
            };
            let class_name = w!("PucaSessionEvents");
            let wc = WNDCLASSW {
                lpfnWndProc: Some(wndproc),
                hInstance: hinstance.into(),
                lpszClassName: class_name,
                ..Default::default()
            };
            if RegisterClassW(&wc) == 0 {
                log::warn!("[session-events] RegisterClassW failed");
                return;
            }
            let hwnd = match CreateWindowExW(
                WINDOW_EX_STYLE(0), class_name, w!(""), WS_OVERLAPPED,
                0, 0, 0, 0, None, None, hinstance, None,
            ) {
                Ok(h) => h,
                Err(e) => { log::warn!("[session-events] CreateWindowExW failed: {e:?}"); return; }
            };
            if let Err(e) = WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION) {
                // Power broadcasts still arrive without this; only lock detection is lost.
                log::warn!("[session-events] WTSRegisterSessionNotification failed: {e:?}");
            }
            let mut m = MSG::default();
            while GetMessageW(&mut m, None, 0, 0).0 > 0 {
                let _ = TranslateMessage(&m);
                DispatchMessageW(&m);
            }
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub mod windows_impl {
    /// No suspend/lock feed off Windows yet; the frontend treats a missing event
    /// as "not wired" and keeps its other wipe paths.
    pub fn start(_app: tauri::AppHandle) {}
}
