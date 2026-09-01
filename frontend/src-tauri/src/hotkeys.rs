//! Global hotkey listener — the desktop half of frontend/src/api/hotkeys.ts.
//!
//! WH_KEYBOARD_LL + WH_MOUSE_LL hooks (same proven plumbing as
//! remote_control's kill-switch guard: dedicated thread + message pump,
//! WM_QUIT teardown) that emit one `global-hotkey` event per TRANSITION of a
//! WATCHED input, with the live modifier state. Mouse buttons ride the same
//! watch slots and wire format as keys — their VKs (1/2/4/5/6) never collide
//! with keyboard codes. The JS registry does the matching; this side only
//! answers "did a bound key or button go down or up, anywhere on the system".
//!
//! Deliberately NOT a keystroke feed: only virtual-keys the frontend has
//! actually bound are ever forwarded (at most WATCH_SLOTS of them), so the
//! webview never sees what the user types in other apps. OS auto-repeat is
//! collapsed here (down-state bitmap) — the frontend receives clean edges.
//!
//! Coexists with the kill-switch guard: two WH_KEYBOARD_LL hooks in one
//! process are fine (Windows chains them); each has its own thread, statics
//! and WM_QUIT, so teardown of one never touches the other.

#[cfg(windows)]
mod imp {
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::sync::{Mutex, OnceLock};
    use tauri::{AppHandle, Emitter};
    use windows::Win32::Foundation::{HINSTANCE, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, VK_CONTROL, VK_MENU, VK_SHIFT,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, GetMessageW, PostThreadMessageW, SetWindowsHookExW, UnhookWindowsHookEx,
        KBDLLHOOKSTRUCT, LLKHF_INJECTED, LLMHF_INJECTED, MSG, MSLLHOOKSTRUCT, WH_KEYBOARD_LL,
        WH_MOUSE_LL, WM_KEYDOWN, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MBUTTONDOWN, WM_MBUTTONUP,
        WM_MOUSEMOVE, WM_QUIT, WM_RBUTTONDOWN, WM_RBUTTONUP, WM_SYSKEYDOWN, WM_XBUTTONDOWN,
        WM_XBUTTONUP,
    };

    static ACTIVE: AtomicBool = AtomicBool::new(false);
    static THREAD_ID: AtomicU32 = AtomicU32::new(0);
    static APP: OnceLock<AppHandle> = OnceLock::new();
    /// Set by the hook thread once SetWindowsHookExW has actually succeeded,
    /// cleared when it tears down. `start()` waits briefly on this so it can
    /// report the truth to the frontend rather than "the command returned".
    static HOOK_LIVE: AtomicBool = AtomicBool::new(false);
    /// True from the moment a hook thread is spawned until it has fully
    /// unwound. THREAD_ID cannot carry that invariant on its own: it is
    /// published from INSIDE the thread, so `stop()` immediately followed by
    /// `start()` (exactly what a voice input-mode switch does) saw a zero id
    /// and spawned a second hooked thread while the first was still alive.
    static THREAD_RUNNING: AtomicBool = AtomicBool::new(false);
    /// Serialises start/stop so the two can never interleave. Held only by the
    /// Tauri command thread — the hook proc itself stays lock-free, which is
    /// the constraint that actually matters (a lock there would stall every
    /// keystroke on the system).
    static LIFECYCLE: Mutex<()> = Mutex::new(());

    /// The bound virtual-keys (0 = empty slot). Fixed slots so the hook proc
    /// stays lock-free — a mutex inside a low-level keyboard hook would stall
    /// every keystroke on the system while the webview holds it.
    pub const WATCH_SLOTS: usize = 16;
    static WATCH: [AtomicU32; WATCH_SLOTS] = [const { AtomicU32::new(0) }; WATCH_SLOTS];
    /// Bitmap of watched slots currently physically down — collapses OS
    /// auto-repeat to one edge per press, and lets keyup match the slot even
    /// if the watch list was re-written mid-hold.
    static DOWN: AtomicU32 = AtomicU32::new(0);

    #[derive(Clone, serde::Serialize)]
    struct KeyEvent {
        #[serde(rename = "keyCode")]
        key_code: u32,
        #[serde(rename = "ctrlKey")]
        ctrl_key: bool,
        #[serde(rename = "altKey")]
        alt_key: bool,
        #[serde(rename = "shiftKey")]
        shift_key: bool,
        down: bool,
    }

    fn watched_slot(vk: u32) -> Option<usize> {
        WATCH.iter().position(|w| w.load(Ordering::SeqCst) == vk)
    }

    /// Counts transitions the hook has actually emitted. Read by `diag` — the
    /// one number that separates "the hook is not receiving" from "it receives
    /// and something downstream drops it", which look identical to a user.
    static EVENTS_SEEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

    pub(super) fn diag() -> serde_json::Value {
        let watching: Vec<u32> = WATCH
            .iter()
            .map(|w| w.load(Ordering::SeqCst))
            .filter(|v| *v != 0)
            .collect();
        serde_json::json!({
            "platform": "windows",
            "active": ACTIVE.load(Ordering::SeqCst),
            "hook_live": HOOK_LIVE.load(Ordering::SeqCst),
            "watching": watching,
            "events_seen": EVENTS_SEEN.load(Ordering::SeqCst),
        })
    }

    /// Hands transitions from the hook callback to a dedicated emitter thread.
    ///
    /// `app.emit` used to run INSIDE the hook proc. That call serializes the
    /// payload and walks the runtime's listener plumbing — work whose latency
    /// is not ours to bound — and Windows SILENTLY REMOVES a low-level hook
    /// whose callback repeatedly exceeds its latency budget
    /// (LowLevelHooksTimeout): no error, no signal, HOOK_LIVE still true, and
    /// every global hotkey is dead until the feed is restarted. A game plus
    /// the encoder is exactly the load that produces it — the field report
    /// was "hotkeys sometimes stop working". The hook proc now only pushes
    /// onto an unbounded channel (an atomic-list append, never blocking) and
    /// the emitter thread does the slow part at its leisure.
    static EMITTER: OnceLock<std::sync::mpsc::Sender<KeyEvent>> = OnceLock::new();

    fn emitter() -> &'static std::sync::mpsc::Sender<KeyEvent> {
        EMITTER.get_or_init(|| {
            let (tx, rx) = std::sync::mpsc::channel::<KeyEvent>();
            // Process-lifetime thread; parks on recv when idle. Torn down with
            // the process — the ACTIVE gate already stops events at the source.
            std::thread::spawn(move || {
                while let Ok(ev) = rx.recv() {
                    if let Some(app) = APP.get() {
                        if let Err(e) = app.emit("global-hotkey", ev) {
                            eprintln!("[hotkeys] emit failed: {e:?}");
                        }
                    } else {
                        eprintln!("[hotkeys] transition dropped: no app handle");
                    }
                }
            });
            tx
        })
    }

    /// Shared edge detector for both hooks. Only real transitions: keyboard
    /// auto-repeat sends WM_KEYDOWN over and over while held, and the frontend
    /// wants edges. Runs in the hook callback — everything here must be cheap
    /// and lock-free (atomics, GetAsyncKeyState, a channel append).
    unsafe fn emit_transition(slot: usize, vk: u32, is_down: bool) {
        let bit = 1u32 << slot;
        let was_down = DOWN.load(Ordering::SeqCst) & bit != 0;
        if is_down == was_down {
            return;
        }
        if is_down {
            DOWN.fetch_or(bit, Ordering::SeqCst);
        } else {
            DOWN.fetch_and(!bit, Ordering::SeqCst);
        }
        let down_now = |vk| (GetAsyncKeyState(vk) as u16 & 0x8000) != 0;
        let ev = KeyEvent {
            key_code: vk,
            ctrl_key: down_now(VK_CONTROL.0 as i32),
            alt_key: down_now(VK_MENU.0 as i32),
            shift_key: down_now(VK_SHIFT.0 as i32),
            down: is_down,
        };
        EVENTS_SEEN.fetch_add(1, Ordering::Relaxed);
        let _ = emitter().send(ev); // receiver lives for the process
    }

    unsafe extern "system" fn kbd_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 && ACTIVE.load(Ordering::SeqCst) {
            let info = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
            let injected = info.flags.0 & LLKHF_INJECTED.0 != 0;
            if !injected && info.vkCode != 0 {
                let msg = wparam.0 as u32;
                let is_down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
                if let Some(slot) = watched_slot(info.vkCode) {
                    emit_transition(slot, info.vkCode, is_down);
                }
            }
        }
        CallNextHookEx(None, code, wparam, lparam)
    }

    /// Which mouse-button VK (1/2/4/5/6) a WH_MOUSE_LL message is, and whether
    /// it is a press. X buttons carry which one in the HIWORD of mouseData.
    fn mouse_event_vk(msg: u32, info: &MSLLHOOKSTRUCT) -> Option<(u32, bool)> {
        match msg {
            WM_LBUTTONDOWN => Some((1, true)),
            WM_LBUTTONUP => Some((1, false)),
            WM_RBUTTONDOWN => Some((2, true)),
            WM_RBUTTONUP => Some((2, false)),
            WM_MBUTTONDOWN => Some((4, true)),
            WM_MBUTTONUP => Some((4, false)),
            WM_XBUTTONDOWN | WM_XBUTTONUP => {
                let vk = match (info.mouseData >> 16) & 0xffff {
                    1 => 5, // XBUTTON1 → VK_XBUTTON1 ("Mouse 4")
                    2 => 6, // XBUTTON2 → VK_XBUTTON2 ("Mouse 5")
                    _ => return None,
                };
                Some((vk, msg == WM_XBUTTONDOWN))
            }
            _ => None,
        }
    }

    /// Mouse twin of kbd_proc, so bindings can live on mouse buttons (the
    /// keyboard hook never sees button messages). Same watch slots, same wire
    /// format — mouse VKs 1..6 never collide with keyboard codes. WM_MOUSEMOVE
    /// dominates this hook's traffic and is rejected before anything else;
    /// injected input is skipped so remote-control's SendInput can't
    /// self-trigger a binding. Never swallows — the button still works in the
    /// game/app under the cursor.
    unsafe extern "system" fn mouse_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 {
            let msg = wparam.0 as u32;
            if msg != WM_MOUSEMOVE && ACTIVE.load(Ordering::SeqCst) {
                let info = &*(lparam.0 as *const MSLLHOOKSTRUCT);
                if info.flags & LLMHF_INJECTED == 0 {
                    if let Some((vk, is_down)) = mouse_event_vk(msg, info) {
                        if let Some(slot) = watched_slot(vk) {
                            emit_transition(slot, vk, is_down);
                        }
                    }
                }
            }
        }
        CallNextHookEx(None, code, wparam, lparam)
    }

    fn hook_thread() {
        unsafe {
            // Publish the id BEFORE installing the hook. stop() can only reach
            // a thread whose id it can see, and the install plus its readiness
            // wait was a wide enough window for a stop() to miss the thread
            // entirely — orphaning a live system-wide hook nothing could quit.
            let my_tid = GetCurrentThreadId();
            THREAD_ID.store(my_tid, Ordering::SeqCst);

            let hmod = GetModuleHandleW(None).unwrap_or_default();
            let hinst = HINSTANCE(hmod.0);
            let kbd_hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(kbd_proc), hinst, 0);
            // Mouse hook rides the same thread/pump (the remote_control guard
            // proves the pattern). Best-effort: keyboard bindings must keep
            // working even if the mouse hook is refused.
            let mouse_hook = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), hinst, 0);
            if let Err(e) = &mouse_hook {
                eprintln!("[hotkeys] WH_MOUSE_LL install FAILED (mouse bindings inactive): {e:?}");
            }
            let installed = match &kbd_hook {
                Ok(_) => {
                    HOOK_LIVE.store(true, Ordering::SeqCst);
                    eprintln!("[hotkeys] WH_KEYBOARD_LL hook installed (mouse: {})",
                        if mouse_hook.is_ok() { "ok" } else { "unavailable" });
                    true
                }
                Err(e) => {
                    eprintln!("[hotkeys] hook install FAILED: {e:?}");
                    false
                }
            };

            // Pump messages until PostThreadMessage(WM_QUIT) from stop().
            // Skipped when there is no hook to service (nothing would ever be
            // delivered), and when stop() already ran: it clears ACTIVE first,
            // so a false ACTIVE here means we were told to quit before we were
            // reachable and the WM_QUIT went nowhere.
            if installed && ACTIVE.load(Ordering::SeqCst) {
                let mut msg = MSG::default();
                loop {
                    let r = GetMessageW(&mut msg, None, 0, 0).0;
                    if r == 0 || r == -1 {
                        break; // WM_QUIT (0) or error (-1)
                    }
                }
            }

            if let Ok(h) = kbd_hook {
                let _ = UnhookWindowsHookEx(h);
            }
            if let Ok(h) = mouse_hook {
                let _ = UnhookWindowsHookEx(h);
            }
            HOOK_LIVE.store(false, Ordering::SeqCst);
            // Clear the slot only if it is still OURS. Belt-and-braces beside
            // THREAD_RUNNING: an unconditional store here let a thread finishing
            // its WM_QUIT unwind zero a replacement's id, after which stop()
            // could never quit the replacement and start() stacked another hook
            // on top of it on every subsequent call.
            let _ = THREAD_ID.compare_exchange(my_tid, 0, Ordering::SeqCst, Ordering::SeqCst);
            // Last: releases start() to spawn a successor.
            THREAD_RUNNING.store(false, Ordering::SeqCst);
        }
    }

    /// (Re)configure the watch list and ensure the hook thread runs. Called
    /// again on every rebind — the slots are swapped in place, no restart.
    /// Returns whether a hook is actually live (see the wrapper's doc).
    pub fn start(app: AppHandle, keys: Vec<u32>) -> bool {
        let _lifecycle = LIFECYCLE.lock().unwrap_or_else(|e| e.into_inner());
        let _ = APP.set(app);
        // Re-arming a slot with a DIFFERENT key invalidates that slot's
        // down-state bit: the bit tracks a physical key, so after a rebind it
        // claims the new key is already held — swallowing its first press (no
        // edge is emitted) and, if the old key really was down, never emitting
        // its release. Only changed slots are cleared, so rebinding one action
        // cannot disturb another key the user is currently holding.
        for (i, slot) in WATCH.iter().enumerate() {
            let next = keys.get(i).copied().unwrap_or(0);
            if slot.swap(next, Ordering::SeqCst) != next {
                DOWN.fetch_and(!(1u32 << i), Ordering::SeqCst);
            }
        }
        ACTIVE.store(true, Ordering::SeqCst);
        // Already hooked? The new watch list above is all that was needed.
        if THREAD_RUNNING.load(Ordering::SeqCst) && HOOK_LIVE.load(Ordering::SeqCst) {
            return true;
        }
        // A predecessor may still be unwinding from a stop() in the same tick
        // (the input-mode switch does exactly stop-then-start). Wait for it to
        // release ownership rather than spawning alongside it.
        for _ in 0..50 {
            if THREAD_RUNNING
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
            {
                std::thread::spawn(hook_thread);
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        // The hook install is the thread's first real act; give it a moment so
        // the answer reflects reality rather than the spawn. Bounded, so a
        // wedged thread can't block the command.
        for _ in 0..50 {
            if HOOK_LIVE.load(Ordering::SeqCst) {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        HOOK_LIVE.load(Ordering::SeqCst)
    }

    /// Stop watching and tear the hook down. Any key still physically held
    /// gets no further events — the frontend releases its holds itself when
    /// it stops the feed.
    pub fn stop() {
        let _lifecycle = LIFECYCLE.lock().unwrap_or_else(|e| e.into_inner());
        // ACTIVE first: it is what a thread that has not yet published its id
        // checks to discover it was told to quit before it was reachable.
        ACTIVE.store(false, Ordering::SeqCst);
        DOWN.store(0, Ordering::SeqCst);
        for slot in WATCH.iter() {
            slot.store(0, Ordering::SeqCst);
        }
        let tid = THREAD_ID.swap(0, Ordering::SeqCst);
        if tid != 0 {
            unsafe {
                let _ = PostThreadMessageW(tid, WM_QUIT, WPARAM(0), LPARAM(0));
            }
        }
        // Wait for the thread to actually unwind, so a start() right behind
        // this one begins from a clean slate instead of finding ownership still
        // taken and giving up without a hook. Normally sub-millisecond.
        for _ in 0..50 {
            if !THREAD_RUNNING.load(Ordering::SeqCst) {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        eprintln!("[hotkeys] stop: hook thread did not exit within 100ms");
    }
}

/// Returns whether a global hook is actually WATCHING. The frontend needs the
/// truth, not a resolved promise: it disables its blur-releases-everything
/// safety net while the native feed is live, so believing in a feed that does
/// not exist (non-Windows build, or a refused hook) leaves push-to-talk stuck
/// open the moment the user alt-tabs away.
#[cfg(windows)]
pub fn start(app: tauri::AppHandle, keys: Vec<u32>) -> bool {
    imp::start(app, keys)
}

#[cfg(windows)]
pub fn stop() {
    imp::stop();
}

/// What the native feed currently believes, for diagnosing "hotkeys don't work
/// when Puca isn't focused".
///
/// EXISTS BECAUSE GUESSING FAILED. That report has been chased three times on
/// three different theories — modifiers not subset-matching, a hook silently
/// removed for exceeding its latency budget, and the shipped defaults being
/// deliberately in-app only — each plausible, each fixed, and the report
/// survived all three. Nothing observable from outside distinguishes "the hook
/// was never installed" from "the key never reached the watch list" from
/// "presses arrive and something later discards them", and those have entirely
/// different causes.
///
/// `active`: the feed was asked to run. `hook_live`: SetWindowsHookExW
/// actually succeeded. `watching`: the virtual-key codes in the watch list — a
/// missing key here means the problem is upstream in the frontend, not in the
/// hook. `events_seen`: transitions emitted since start; still zero while
/// pressing the key means the hook is not receiving at all.
#[cfg(windows)]
pub fn diag() -> serde_json::Value {
    imp::diag()
}

#[cfg(not(windows))]
pub fn diag() -> serde_json::Value {
    serde_json::json!({
        "platform": "non-windows",
        "active": false,
        "hook_live": false,
        "watching": Vec::<u32>::new(),
        "events_seen": 0,
        "note": "global hotkeys need the Windows low-level hook; unavailable here",
    })
}

#[cfg(not(windows))]
pub fn start(_app: tauri::AppHandle, _keys: Vec<u32>) -> bool {
    false // no low-level hook outside Windows
}

#[cfg(not(windows))]
pub fn stop() {}
