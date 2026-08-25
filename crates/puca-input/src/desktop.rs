//! Follow the desktop that currently owns input.
//!
//! WHY THIS EXISTS, AND WHAT MEASUREMENT IT RESTS ON. Windows puts UAC prompts,
//! the lock screen and the sign-in screen on a separate desktop called
//! `Winlogon`. Capture and `SendInput` both operate on the CALLING THREAD's
//! desktop, so a thread sitting on `Default` can neither see nor touch any of
//! them — which is why a UAC prompt froze the picture and swallowed keystrokes.
//!
//! It was long believed that crossing that boundary was impossible for
//! duplication and that only GDI could see it. That was never tested and is
//! false for CAPTURE: measured 2026-08-15, a SYSTEM process that calls
//! `SetThreadDesktop` on `Winlogon` duplicates it with DXGI at full resolution.
//!
//! THE "SendInput ACCEPTED THERE" HALF OF THAT CLAIM WAS WRONG, and it shipped
//! believing an actual measurement backed it. The probe
//! (`crates/puca-spike-s5`) called `puca_input::inject` with
//! `Rmove { dx: 0.0, dy: 0.0 }`, and the `Rmove` handler is `while dx != 0 ||
//! dy != 0 { ... }` — a zero delta never enters the loop, so `SendInput` was
//! never called, and the function returns `Ok(())` unconditionally regardless
//! of the desktop. The probe could not have failed. Confirmed against the real
//! sign-in screen 2026-08-16: `OpenInputDesktop` and `SetThreadDesktop` both
//! succeed, and `SendInput` still returns 0 there — see `follow_input_desktop`'s
//! access mask below.
//!
//! ON FAILURE, NOT ON A TIMER. Nothing here polls. `OpenInputDesktop` is a
//! kernel call and the injection path runs at pointer rate, so a poll would cost
//! something on every event to answer a question whose answer almost never
//! changes. Instead each caller attaches when it is refused — capture on
//! `AccessLost`, input on a zero from `SendInput` — which is precisely when the
//! desktop has changed under it. The failure IS the notification, and it is
//! exact rather than sampled.
//!
//! PER THREAD, DELIBERATELY. `SetThreadDesktop` affects only the calling thread,
//! and this agent injects on the pipe thread while capturing on the stream
//! thread. Both call this independently; there is no shared state to keep in
//! step, which is the point — a single "current desktop" global would be a lie
//! the moment those two threads disagreed.
//!
//! It fails for an agent running on a user token, and that is correct: reaching
//! the secure desktop is exactly the privilege a user-flavour agent must not
//! have. The refusal is reported, not hidden, so the caller can say why.

#[cfg(windows)]
mod imp {
    use windows::Win32::System::StationsAndDesktops::{
        CloseDesktop, GetUserObjectInformationW, OpenInputDesktop, SetThreadDesktop,
        DESKTOP_ACCESS_FLAGS, DESKTOP_CONTROL_FLAGS, DESKTOP_JOURNALPLAYBACK,
        DESKTOP_READOBJECTS, DESKTOP_WRITEOBJECTS, HDESK, UOI_NAME,
    };

    /// The rights `SendInput` needs on the desktop it targets.
    ///
    /// `DESKTOP_JOURNALPLAYBACK` IS THE FIX. Microsoft documents that the
    /// calling thread must hold it on the input desktop or `SendInput` fails
    /// with `GetLastError` = 5 (`ERROR_ACCESS_DENIED`) while still returning a
    /// plain 0 — exactly what was measured against the real sign-in screen:
    /// `OpenInputDesktop` and `SetThreadDesktop` both succeeded, and every
    /// injected event was refused anyway.
    ///
    /// NAMED CONSTANTS, not raw hex — raw hex is what let a previous version of
    /// this call request `0x0100 | 0x0001` under the comment
    /// `// READOBJECTS | WRITEOBJECTS`, which is wrong on both counts (`0x0100`
    /// is `SWITCHDESKTOP`; `WRITEOBJECTS` is `0x0080` and was never actually
    /// requested). `DESKTOP_ACCESS_FLAGS` has no `BitOr` impl in windows 0.58,
    /// so the flags are combined through `.0`.
    ///
    /// `SWITCHDESKTOP` is dropped: nothing here calls `SwitchDesktop`, and this
    /// module's own header argues against requesting rights that go unused.
    pub(super) const FULL_MASK: DESKTOP_ACCESS_FLAGS = DESKTOP_ACCESS_FLAGS(
        DESKTOP_READOBJECTS.0 | DESKTOP_WRITEOBJECTS.0 | DESKTOP_JOURNALPLAYBACK.0,
    );

    /// Read a desktop's name, for logs and for deciding whether anything moved.
    fn name_of(desk: HDESK) -> String {
        let mut buf = [0u16; 256];
        let mut needed = 0u32;
        let ok = unsafe {
            GetUserObjectInformationW(
                windows::Win32::Foundation::HANDLE(desk.0),
                UOI_NAME,
                Some(buf.as_mut_ptr() as *mut _),
                (buf.len() * 2) as u32,
                Some(&mut needed),
            )
        };
        if ok.is_err() {
            return "<unnamed>".into();
        }
        let end = buf.iter().position(|&c| c == 0).unwrap_or(0);
        String::from_utf16_lossy(&buf[..end])
    }

    /// Attach the CALLING THREAD to whichever desktop currently owns input.
    ///
    /// Returns its name on success. The handle is deliberately leaked: the
    /// desktop must outlive this call for the thread to keep using it, and
    /// closing it here is a use-after-free the OS reports much later as an
    /// unrelated capture failure. One handle per real desktop switch is a
    /// bounded, tiny cost.
    pub fn follow_input_desktop() -> Result<String, String> {
        // No DF_ALLOWOTHERACCOUNTHOOK: this needs to read and inject, not to
        // install hooks for other accounts, and asking for rights we do not use
        // is how a helper quietly becomes an escalation step.
        //
        // FALL BACK ON FAILURE. Asking for MORE rights than before can make
        // this fail somewhere it used to succeed — a stricter desktop security
        // descriptor than the ones this was tested against is not impossible.
        // If the full mask is refused, retry with READOBJECTS alone (what this
        // function requested before), so a refusal is attributable to the
        // added rights specifically rather than looking like a total regression
        // in capture too.
        let (desk, mask_used) = match unsafe {
            OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, FULL_MASK)
        } {
            Ok(d) => (d, "full"),
            Err(_) => {
                let d = unsafe {
                    OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_READOBJECTS)
                }
                .map_err(|e| {
                    format!(
                        "cannot open the input desktop ({e}). Running as the signed-in \
                         user rather than as the system is the usual reason."
                    )
                })?;
                (d, "read-only fallback")
            }
        };
        let name = name_of(desk);
        // The mask actually used is folded into the returned name rather than
        // only `eprintln!`'d: this string is what `sent_following`/`sent_detail`
        // put into the error a controller-driven refusal ends up logging, and
        // `eprintln!` from an agent with no console reaches nobody. Whether the
        // fallback fired is exactly the fact needed to tell "the extra rights
        // were refused" from "the extra rights did not help".
        let name = if mask_used == "full" { name } else { format!("{name} ({mask_used})") };
        match unsafe { SetThreadDesktop(desk) } {
            Ok(()) => {
                // CLOSE THE PREVIOUS handle, keep this one. The original
                // design leaked every successful handle "for the life of the
                // process", which was one handle back when each caller
                // attached once per refusal — and stopped being bounded the
                // day the capture path started following PERIODICALLY while
                // blocked (every 2s, the invisible-PIN fix): a pathological
                // never-recovering blockage would leak thirty handles a
                // minute for as long as it lasted. A handle may not be closed
                // while it is the thread's current desktop, but the PREVIOUS
                // one stops being current the instant SetThreadDesktop
                // succeeds — so each thread carries exactly one live handle,
                // however often it re-follows. Thread-local because desktops
                // are per-thread state: the pipe thread and the stream thread
                // each own their one.
                PREV_DESKTOP.with(|prev| {
                    let old = prev.replace(desk.0 as isize);
                    if old != 0 {
                        unsafe {
                            let _ = CloseDesktop(HDESK(old as *mut core::ffi::c_void));
                        }
                    }
                });
                Ok(name)
            }
            Err(e) => {
                // Only safe to close on the failure path, where nothing is
                // using it. The thread must own no windows or hooks for this to
                // succeed, which is why the capture and pipe threads were chosen.
                unsafe {
                    let _ = CloseDesktop(desk);
                }
                Err(format!("cannot attach this thread to desktop '{name}': {e}"))
            }
        }
    }

    thread_local! {
        /// The desktop handle this thread currently sits on (0 = none yet) —
        /// see the close-the-previous note in `follow_input_desktop`.
        static PREV_DESKTOP: std::cell::Cell<isize> = const { std::cell::Cell::new(0) };
    }
}

#[cfg(windows)]
pub use imp::follow_input_desktop;

#[cfg(not(windows))]
pub fn follow_input_desktop() -> Result<String, String> {
    // X11 and Wayland have no equivalent boundary: there is no separate secure
    // desktop to follow, so the honest answer is that there is nothing to do
    // rather than a failure.
    Ok("default".into())
}

#[cfg(windows)]
#[cfg(test)]
mod tests {
    use super::imp::FULL_MASK;

    #[test]
    fn the_access_mask_holds_journalplayback_and_not_switchdesktop() {
        // THE FIX ITSELF, pinned as a value rather than trusted by inspection.
        // Microsoft documents that SendInput fails with GetLastError=5
        // (ERROR_ACCESS_DENIED) unless the calling thread holds
        // DESKTOP_JOURNALPLAYBACK (0x0020) on the input desktop — this is the
        // whole reason typing into the sign-in screen was refused. A silent
        // regression here (someone "simplifying" the mask back to the old
        // 0x0100 | 0x0001) would reintroduce exactly that bug with no test
        // going red anywhere else, since nothing else in this crate can
        // exercise the real Winlogon desktop.
        const DESKTOP_JOURNALPLAYBACK: u32 = 0x0020;
        const DESKTOP_READOBJECTS: u32 = 0x0001;
        const DESKTOP_WRITEOBJECTS: u32 = 0x0080;
        const DESKTOP_SWITCHDESKTOP: u32 = 0x0100;

        let mask = FULL_MASK.0;
        assert_eq!(
            mask & DESKTOP_JOURNALPLAYBACK,
            DESKTOP_JOURNALPLAYBACK,
            "DESKTOP_JOURNALPLAYBACK must be requested — this is the actual fix"
        );
        assert_eq!(mask & DESKTOP_READOBJECTS, DESKTOP_READOBJECTS);
        assert_eq!(mask & DESKTOP_WRITEOBJECTS, DESKTOP_WRITEOBJECTS);
        // SWITCHDESKTOP was requested by a previous version under a WRONG
        // comment (it labelled 0x0100 as WRITEOBJECTS). Nothing here calls
        // SwitchDesktop; asking for it is the exact "rights we do not use"
        // this module's own header warns against.
        assert_eq!(mask & DESKTOP_SWITCHDESKTOP, 0, "must not request an unused right");
    }
}
