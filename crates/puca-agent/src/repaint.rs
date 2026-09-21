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
//! WHAT WAS TRIED. Re-opening the duplication and a `RedrawWindow` over the
//! desktop both came back empty in the 2026-09-22 probes, and so did this
//! window; but every probe ran against panels that were ASLEEP (the probe
//! below reports that case as inconclusive now), so none of them is a
//! disproof. The stream's net therefore wakes the panel first
//! (display_wake::nudge, the same wake as a cold start) and then changes
//! the scene with this window; run the probe while the panels are on to
//! see the awake-and-still half proved.
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
    /// rests on. Finds a screen that is standing still (a second of
    /// Timeouts), provokes a present on it, and expects the duplication to
    /// deliver a real picture within a quarter of a second. Passes and says
    /// so when no screen is still (inconclusive, not proof).
    #[test]
    #[ignore = "needs a real display"]
    fn live_a_provoked_present_wakes_a_still_screen() {
        // Per screen: how many pictures arrive unprovoked in three seconds
        // (zero on EVERY screen means the panels are asleep, and the probe
        // is inconclusive: a sleeping panel presents nothing whatever the
        // scene does), whether it then stands still, and what a provoked
        // present yields on a still one.
        let outputs = puca_capture::outputs();
        let mut proved = 0;
        let mut any_frames = 0;
        for m in 0..ScreenCapture::monitor_count() {
            let rect = outputs.iter().find(|o| o.index == m).map(|o| format!("{}x{} at ({},{})", o.width, o.height, o.left, o.top)).unwrap_or_else(|| "?".into());
            let Ok(mut c) = ScreenCapture::new(m) else { eprintln!("monitor {m} [{rect}]: cannot open"); continue };
            let started = Instant::now();
            let (mut frames, mut still_for) = (0u32, 0u32);
            while started.elapsed() < Duration::from_secs(3) {
                match c.next_frame(50) {
                    Ok(_) => { frames += 1; still_for = 0; }
                    Err(CaptureError::Timeout) => still_for += 1,
                    Err(e) => { eprintln!("monitor {m} [{rect}]: {e}"); break; }
                }
            }
            any_frames += frames;
            if still_for < 20 {
                eprintln!("monitor {m} [{rect}]: {frames} picture(s) in 3 s, not still at the end: skipped");
                continue;
            }
            let shown = provoke_present(m);
            let t0 = Instant::now();
            let mut got = None;
            let mut timeouts = 0;
            for _ in 0..10 {
                match c.next_frame(50) {
                    Ok(f) => {
                        let (lo, hi) = f.bgra.iter().step_by(97).fold((255u8, 0u8), |(lo, hi), &b| (lo.min(b), hi.max(b)));
                        got = Some((f.width, f.height, t0.elapsed(), hi > lo));
                        break;
                    }
                    Err(CaptureError::Timeout) => timeouts += 1,
                    Err(e) => { eprintln!("monitor {m} [{rect}]: {e}"); break; }
                }
            }
            match got {
                Some((w, h, took, varied)) => {
                    eprintln!("monitor {m} [{rect}]: {frames} picture(s) in 3 s, then still; provoked (shown={shown}) -> {w}x{h} {} in {} ms", if varied { "with real pixels" } else { "BLANK" }, took.as_millis());
                    if varied { proved += 1; }
                }
                None => eprintln!("monitor {m} [{rect}]: {frames} picture(s) in 3 s, then still; provoked (shown={shown}) -> nothing in 500 ms ({timeouts} timeouts)"),
            }
        }
        if any_frames == 0 {
            eprintln!("INCONCLUSIVE: no screen presented anything unprovoked in 3 s, the panels are probably asleep");
        } else {
            eprintln!("{proved} still screen(s) proved a provoked present delivers a picture");
        }
    }
}
