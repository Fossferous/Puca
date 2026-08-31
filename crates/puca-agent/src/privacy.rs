use std::sync::atomic::AtomicBool;
#[cfg(windows)]
use std::sync::atomic::Ordering;
#[cfg(windows)]
use std::thread;

#[cfg(windows)]
use windows::core::w;
#[cfg(windows)]
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
#[cfg(windows)]
use windows::Win32::Graphics::Gdi::CreateSolidBrush;
#[cfg(windows)]
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::*;

static PRIVACY_ENABLED: AtomicBool = AtomicBool::new(false);
static HWND_REF: std::sync::Mutex<Option<isize>> = std::sync::Mutex::new(None);

/// Start the background thread for the privacy window if not started.
/// Does nothing if already running.
#[cfg(windows)]
pub fn init() {
    thread::spawn(move || {
        let h_instance = unsafe { GetModuleHandleW(None).unwrap_or_default() };

        let wnd_class = WNDCLASSW {
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(wndproc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: h_instance.into(),
            hIcon: unsafe { LoadIconW(None, IDI_APPLICATION).unwrap_or_default() },
            hCursor: unsafe { LoadCursorW(None, IDC_ARROW).unwrap_or_default() },
            hbrBackground: unsafe { CreateSolidBrush(windows::Win32::Foundation::COLORREF(0)) },
            lpszMenuName: windows::core::PCWSTR::null(),
            lpszClassName: w!("PucaPrivacyModeClass"),
        };

        unsafe {
            if RegisterClassW(&wnd_class) == 0 {
                // If it fails because it's already registered, that's fine.
            }
        }

        let hwnd = unsafe {
            CreateWindowExW(
                WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_LAYERED | WS_EX_TRANSPARENT,
                w!("PucaPrivacyModeClass"),
                w!("Puca Privacy Overlay"),
                WS_POPUP,
                0,
                0,
                0,
                0,
                None,
                None,
                h_instance,
                None,
            )
        };

        if let Ok(hwnd) = hwnd {
            // WDA_EXCLUDEFROMCAPTURE hides it from Desktop Duplication
            unsafe {
                let _ = SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);
                // Opaque black
                let _ = SetLayeredWindowAttributes(hwnd, windows::Win32::Foundation::COLORREF(0), 255, LWA_ALPHA);
            }

            *HWND_REF.lock().unwrap() = Some(hwnd.0 as isize);

            let mut message = MSG::default();
            while unsafe { GetMessageW(&mut message, None, 0, 0) }.into() {
                unsafe {
                    let _ = TranslateMessage(&message);
                    DispatchMessageW(&message);
                }
            }
        }
    });
}

#[cfg(not(windows))]
pub fn init() {}

#[cfg(windows)]
unsafe extern "system" fn wndproc(window: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match message {
        WM_DESTROY => {
            PostQuitMessage(0);
            LRESULT(0)
        }
        _ => DefWindowProcW(window, message, wparam, lparam),
    }
}

/// Show or hide the blackout overlay.
///
/// The window is checked BEFORE the flag is swapped, and the flag only moves
/// once the window actually did something. The previous order swapped first and
/// early-returned when the value was unchanged, so if `init()`'s thread had not
/// yet published the HWND — or `CreateWindowExW` had failed, leaving it None
/// forever — the first call latched "on", blanked nothing, answered Ok, and
/// every retry then short-circuited on `was_enabled == enabled`. The user saw
/// privacy mode reported as active over a perfectly visible screen.
pub fn set_enabled(enabled: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        let hwnd_isize = match *HWND_REF.lock().map_err(|_| "privacy lock poisoned".to_string())? {
            Some(h) => h,
            None => return Err("the privacy overlay window is not available".into()),
        };
        if PRIVACY_ENABLED.load(Ordering::SeqCst) == enabled {
            return Ok(());
        }
        let hwnd = HWND(hwnd_isize as *mut core::ffi::c_void);
        unsafe {
            if enabled {
                let x = GetSystemMetrics(SM_XVIRTUALSCREEN);
                let y = GetSystemMetrics(SM_YVIRTUALSCREEN);
                let cx = GetSystemMetrics(SM_CXVIRTUALSCREEN);
                let cy = GetSystemMetrics(SM_CYVIRTUALSCREEN);
                SetWindowPos(hwnd, HWND_TOPMOST, x, y, cx, cy, SWP_SHOWWINDOW)
                    .map_err(|e| format!("could not show the privacy overlay: {e}"))?;
            } else {
                let _ = ShowWindow(hwnd, SW_HIDE);
            }
        }
        PRIVACY_ENABLED.store(enabled, Ordering::SeqCst);
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = enabled;
        Err("privacy mode is Windows-only".into())
    }
}
