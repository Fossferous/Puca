//! Provoke one desktop present on a screen, so a duplication of a still
//! screen has a picture to hand over.
//!
//! WHY. DXGI desktop duplication delivers a frame only when the compositor
//! presents one, and the compositor presents only when its scene changes
//! (and never to a panel that is asleep). A screen nobody is changing
//! presents nothing, and a pointer-only update is not a picture: its
//! surface comes back blank (puca-capture, `next_frame`). So a stream that
//! holds nothing to re-send, which is where a switch out of All Displays
//! lands when the destination screen is still, had no way to get a picture
//! except to wait for the user to change something on it. On 2026-09-21
//! two phone sessions sat frozen from "capture committed" until they were
//! torn down, every click landing on a picture that never moved.
//!
//! MEASURED 2026-09-22 on the owner's machine, panels on, by the probe
//! below: on the two screens that stand still between caret blinks, a
//! provoked present delivered a real picture within 150 ms in 5 of 5
//! trials, and the unprovoked control in 0 of 5. Re-opening the duplication
//! and a `RedrawWindow` over the desktop were tried first and came back
//! empty, but only against panels that were ASLEEP (the probe reports that
//! case as inconclusive), so they are unproven either way; a sleeping panel
//! presents nothing whatever the scene does, which is why the stream's net
//! wakes the panel first (display_wake::nudge, the same wake as a cold
//! start) and then changes the scene with this window.
//!
//! HOW (the scene change). A one-pixel layered window at one part
//! in 255 of opacity, click-through, a tool window that never activates and
//! never appears in the taskbar, shown on the target screen for about
//! three frames and destroyed. The compositor presents for its appearance
//! and again for its removal; the duplication delivers those presents, and
//! the picture is the desktop as it is. Nothing gains focus, nothing moves,
//! and no one can see a pixel at that opacity. Best effort: a refusal
//! leaves us where we started, and the caller retries on its own clock, a
//! bounded number of times, and says so in the log each time.
use std::time::{Duration, Instant};

use windows::core::w;
use windows::Win32::Foundation::{COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, PeekMessageW, RegisterClassW,
    SetLayeredWindowAttributes, ShowWindow, TranslateMessage, UnregisterClassW, LWA_ALPHA, MSG, PM_REMOVE,
    SW_SHOWNOACTIVATE, WNDCLASSW, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST,
    WS_EX_TRANSPARENT, WS_POPUP,
};

/// How long the pixel stays: past two frames at 60 Hz, so the compositor
/// composes it at least once before it goes.
const DWELL: Duration = Duration::from_millis(50);

unsafe extern "system" fn wndproc(h: HWND, m: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    DefWindowProcW(h, m, w, l)
}

/// Make the compositor present the screen that `monitor` (a capture index,
/// as `ScreenCapture::new` takes it) is on. True when the window was shown.
pub fn provoke_present(monitor: usize) -> bool {
    let (x, y) = puca_capture::outputs()
        .into_iter()
        .find(|o| o.index == monitor)
        .map(|o| (o.left, o.top))
        .unwrap_or((0, 0));
    // SAFETY: plain Win32 window lifecycle on this thread: register, create,
    // show, pump its own messages, destroy, unregister. The class name and
    // the procedure outlive every call that uses them.
    unsafe {
        let hinst = HINSTANCE(GetModuleHandleW(None).map(|m| m.0).unwrap_or(std::ptr::null_mut()));
        let class = w!("PucaPresentNudge");
        let wc = WNDCLASSW { lpfnWndProc: Some(wndproc), hInstance: hinst, lpszClassName: class, ..Default::default() };
        // Registering twice (a retry) reports "already exists"; that is fine.
        let _ = RegisterClassW(&wc);
        let Ok(hwnd) = CreateWindowExW(
            WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TOPMOST,
            class,
            w!(""),
            WS_POPUP,
            x,
            y,
            1,
            1,
            None,
            None,
            hinst,
            None,
        ) else {
            let _ = UnregisterClassW(class, hinst);
            return false;
        };
        let _ = SetLayeredWindowAttributes(hwnd, COLORREF(0), 1, LWA_ALPHA);
        let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        let until = Instant::now() + DWELL;
        let mut msg = MSG::default();
        while Instant::now() < until {
            while PeekMessageW(&mut msg, hwnd, 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        let _ = DestroyWindow(hwnd);
        let _ = UnregisterClassW(class, hinst);
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use puca_capture::{CaptureError, ScreenCapture};

    /// DIAGNOSTIC, run by hand (`cargo test -p puca-agent -- --ignored
    /// live_a_provoked --nocapture`): the premise the stranded-switch net
    /// rests on, measured on a screen that is NOT being changed. A desktop
    /// is rarely dead still (a caret blinks, a clock ticks), so this is
    /// statistical: on each screen, wait for a natural gap of 300 ms with
    /// no picture, then either provoke a present or do nothing (the
    /// control), and see whether a picture arrives within 150 ms. Five
    /// provoked trials and five control trials per screen; the provoke is
    /// proved when it delivers in at least four and the control in at most
    /// one. A screen that never has a 300 ms gap (something animating on
    /// it) is skipped; a screen with no pictures at all in the settle
    /// window is asleep, and the probe says so.
    #[test]
    #[ignore = "needs a real display"]
    fn live_a_provoked_present_wakes_a_still_screen() {
        let outputs = puca_capture::outputs();
        let mut proved = 0;
        let mut any_frames = 0;
        for m in 0..ScreenCapture::monitor_count() {
            let rect = outputs.iter().find(|o| o.index == m).map(|o| format!("{}x{} at ({},{})", o.width, o.height, o.left, o.top)).unwrap_or_else(|| "?".into());
            let Ok(mut c) = ScreenCapture::new(m) else { eprintln!("monitor {m} [{rect}]: cannot open"); continue };
            // Settle: what the screen does on its own for three seconds.
            let started = Instant::now();
            let mut frames = 0u32;
            while started.elapsed() < Duration::from_secs(3) {
                match c.next_frame(50) {
                    Ok(_) => frames += 1,
                    Err(CaptureError::Timeout) => {}
                    Err(e) => { eprintln!("monitor {m} [{rect}]: {e}"); break; }
                }
            }
            any_frames += frames;
            // Trials, provoked and control alternating.
            let (mut hits, mut control_hits, mut trials, mut controls) = (0u32, 0u32, 0u32, 0u32);
            let budget = Instant::now() + Duration::from_secs(40);
            let mut skipped = false;
            while trials < 5 || controls < 5 {
                if Instant::now() > budget { skipped = true; break; }
                // A natural gap: 300 ms with no picture (a caret blinks about
                // every 500-700 ms, so the next natural picture is not yet due).
                let mut quiet = 0u32;
                while quiet < 6 && Instant::now() < budget {
                    match c.next_frame(50) {
                        Ok(_) => quiet = 0,
                        Err(CaptureError::Timeout) => quiet += 1,
                        Err(e) => { eprintln!("monitor {m} [{rect}]: {e}"); quiet = 6; }
                    }
                }
                if quiet < 6 { skipped = true; break; }
                let provoke = trials <= controls && trials < 5;
                let t0 = Instant::now();
                if provoke { provoke_present(m); }
                let mut got = false;
                while t0.elapsed() < Duration::from_millis(150) {
                    if let Ok(f) = c.next_frame(20) {
                        let (lo, hi) = f.bgra.iter().step_by(97).fold((255u8, 0u8), |(lo, hi), &b| (lo.min(b), hi.max(b)));
                        got = hi > lo;
                        break;
                    }
                }
                if provoke { trials += 1; hits += u32::from(got); } else { controls += 1; control_hits += u32::from(got); }
            }
            if frames == 0 {
                eprintln!("monitor {m} [{rect}]: 0 pictures in 3 s (asleep?), provoked {hits}/{trials}, control {control_hits}/{controls}");
                continue;
            }
            if skipped && trials < 5 {
                eprintln!("monitor {m} [{rect}]: {frames} pictures in 3 s and never a 300 ms gap in 40 s: skipped (provoked {hits}/{trials}, control {control_hits}/{controls})");
                continue;
            }
            let ok = hits >= 4 && control_hits <= 1;
            eprintln!("monitor {m} [{rect}]: {frames} pictures in 3 s; provoked present delivered {hits}/{trials} within 150 ms, unprovoked control {control_hits}/{controls}: {}", if ok { "PROVED" } else { "NOT proved" });
            if ok { proved += 1; }
        }
        if any_frames == 0 {
            eprintln!("INCONCLUSIVE: no screen presented anything in the settle window, the panels are probably asleep");
        } else {
            eprintln!("{proved} screen(s) proved a provoked present delivers a picture on a still screen");
        }
    }
}
