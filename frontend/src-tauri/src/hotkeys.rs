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
//! TWO SOURCES, ONE EDGE DETECTOR. The hooks give edges with no latency; a
//! GetAsyncKeyState poll of the same watched keys (every POLL_EVERY_MS, on
//! the same thread, so the two never race) is the guarantee behind them. A
//! low-level hook is removed by Windows without notice when its callback
//! misses the latency budget under load, and misses the key-up whenever
//! the key is released somewhere it cannot see (a UAC prompt, an elevated
//! game). Either way the DOWN bit stays set: push-to-talk is stuck open
//! and — because a set bit swallows the next key-down as a repeat — the
//! NEXT press is silently eaten too. That was the field report "hotkeys
//! work about half the time". The poll notices the disagreement, and after
//! POLL_CONFIRM consecutive ticks emits the edge the hook lost, so a lost
//! release costs ~40 ms of extra mic, not the rest of the call; a dead hook
//! degrades to 20 ms polling latency — and a press the poll had to supply
//! is proof the hook is gone, so both hooks are re-installed on the spot
//! rather than at the next 60 s tick. All counted in `diag`, so a rising
//! `poll_*` number says the hook is losing input.
//!
//! THE POLL MUST NOT SEE OUR OWN INJECTIONS. The hooks ignore input stamped
//! with `PUCA_INJECT_TAG` — the remote-control agent's own SendInput — so a
//! controller typing on the host can never trigger the host's bindings.
//! `GetAsyncKeyState` has no such notion: SendInput updates the key-state
//! table exactly like a real key, so a naive poll would re-open that door
//! and hand a remote controller the host's microphone. Every slot the hooks
//! see a TAGGED edge on is therefore masked (`SELF`), and the poll is blind
//! to it until the table says the key is up again. A physical press during
//! an injected hold still arrives, because it comes through the hook.
//!
//! What no source can do: see input that Windows routes to a window above
//! our integrity level (UIPI — a game "run as administrator"). Hooks, raw
//! input and GetAsyncKeyState are all blind there. That case is DETECTED
//! (foreground_capture_blocker) and reported to the frontend as an event,
//! so the user is told the truth instead of blaming the app.
//!
//! Coexists with the kill-switch guard: two WH_KEYBOARD_LL hooks in one
//! process are fine (Windows chains them); each has its own thread, statics
//! and WM_QUIT, so teardown of one never touches the other.

#[cfg(windows)]
mod imp {
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::sync::{Mutex, OnceLock};
    use tauri::{AppHandle, Emitter};
    use windows::Win32::Foundation::{CloseHandle, HANDLE, HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::Security::{
        GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, TokenIntegrityLevel,
        TOKEN_MANDATORY_LABEL, TOKEN_QUERY,
    };
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::Threading::{
        GetCurrentProcess, GetCurrentThread, GetCurrentThreadId, OpenProcess, OpenProcessToken,
        QueryFullProcessImageNameW, SetThreadPriority, PROCESS_NAME_FORMAT,
        PROCESS_QUERY_LIMITED_INFORMATION, THREAD_PRIORITY_TIME_CRITICAL,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetSystemMetrics, GetWindowThreadProcessId, SM_SWAPBUTTON,
    };
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, VK_CONTROL, VK_MENU, VK_SHIFT,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, GetMessageW, KillTimer, PostThreadMessageW, SetTimer, SetWindowsHookExW,
        UnhookWindowsHookEx,
        HHOOK, KBDLLHOOKSTRUCT, MSG, MSLLHOOKSTRUCT, WH_KEYBOARD_LL,
        WH_MOUSE_LL, WM_KEYDOWN, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MBUTTONDOWN, WM_MBUTTONUP,
        WM_MOUSEMOVE, WM_QUIT, WM_RBUTTONDOWN, WM_RBUTTONUP, WM_SYSKEYDOWN, WM_TIMER, WM_XBUTTONDOWN,
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

    /// Modifier state as the HOOK's own stream reports it (left/right folded).
    /// Microsoft documents that a low-level hook runs BEFORE the key-state
    /// table is updated for the key it is reporting, so a modifier pressed in
    /// the same input burst as the bound key can still read "up" from
    /// GetAsyncKeyState at emit time — and a Ctrl+Shift+M toggle then fails
    /// its own modifiers. These bits have already seen the modifier's down
    /// edge; the event ORs them with the table. Native matching is subset, so
    /// an extra modifier never vetoes — only a missing one does, and this is
    /// what stops it going missing. The poll clears a bit the table says is
    /// up, so a modifier release the hook missed cannot stick.
    /// Slots whose key is currently held by OUR OWN injection (a tagged
    /// edge reached the hook). The poll skips these: see the module doc —
    /// GetAsyncKeyState cannot tell SendInput from a finger, and polling a
    /// slot the hooks are deliberately ignoring would let the remote-control
    /// agent trigger the host's push-to-talk.
    static SELF_INJECTED: AtomicU32 = AtomicU32::new(0);

    static MOD_CTRL: AtomicBool = AtomicBool::new(false);
    static MOD_ALT: AtomicBool = AtomicBool::new(false);
    static MOD_SHIFT: AtomicBool = AtomicBool::new(false);

    /// Record that OUR OWN injection moved `vk`. Only watched slots matter:
    /// the mask exists purely to keep the poll off a key the hooks are
    /// ignoring. Cleared here on the tagged release, and by the poll when
    /// the key-state table says the key is up (the case where the hook
    /// never delivers that release).
    fn mark_self_injected(vk: u32, is_down: bool) {
        if let Some(slot) = watched_slot(vk) {
            let bit = 1u32 << slot;
            if is_down {
                SELF_INJECTED.fetch_or(bit, Ordering::SeqCst);
            } else {
                SELF_INJECTED.fetch_and(!bit, Ordering::SeqCst);
            }
        }
    }

    fn note_modifier(vk: u32, is_down: bool) {
        match vk {
            0x11 | 0xA2 | 0xA3 => MOD_CTRL.store(is_down, Ordering::Relaxed),  // CONTROL, L, R
            0x12 | 0xA4 | 0xA5 => MOD_ALT.store(is_down, Ordering::Relaxed),   // MENU, L, R
            0x10 | 0xA0 | 0xA1 => MOD_SHIFT.store(is_down, Ordering::Relaxed), // SHIFT, L, R
            _ => {}
        }
    }

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
        /// Our own window was the foreground window when this edge was
        /// delivered. Filled in by the emitter thread (a syscall, kept out of
        /// the hook callback): the frontend uses it instead of
        /// document.hasFocus(), which lies in the WebView.
        foreground: bool,
    }

    /// The watch list as it is actually stored: a virtual-key owns exactly
    /// ONE slot.
    ///
    /// `watched_slot` resolves a key to the FIRST slot holding it, so a
    /// second slot with the same key could never have its down-bit set by a
    /// hook — and the poll, which walks slots independently, would then read
    /// that permanently-disagreeing slot as a press the hook had missed:
    /// a duplicate event on every press (a toggle fires twice and nets
    /// nothing) plus a hook re-arm every two seconds. Two actions on one key
    /// is a configuration a user can reach (bare `M` for mute, `Ctrl+M` for
    /// deafen — the same VK, different modifiers), so this is enforced here
    /// rather than trusted to the caller.
    fn dedupe_slots(keys: &[u32]) -> [u32; WATCH_SLOTS] {
        let mut out = [0u32; WATCH_SLOTS];
        for i in 0..WATCH_SLOTS {
            let vk = keys.get(i).copied().unwrap_or(0);
            if vk != 0 && !out[..i].contains(&vk) {
                out[i] = vk;
            }
        }
        out
    }

    fn watched_slot(vk: u32) -> Option<usize> {
        WATCH.iter().position(|w| w.load(Ordering::SeqCst) == vk)
    }

    /// Counts transitions the hook has actually emitted. Read by `diag` — the
    /// one number that separates "the hook is not receiving" from "it receives
    /// and something downstream drops it", which look identical to a user.
    static EVENTS_SEEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    /// start()/stop() calls since the process began — never reset. With
    /// `active` alone, "never started" and "started, then stopped" read the
    /// same (both false); these two tell them apart from the Rust side,
    /// independent of anything the frontend remembers or forgot to log.
    static STARTS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    static STOPS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

    /// How often the hook thread tears down and re-installs both hooks.
    ///
    /// THE BUG THIS EXISTS FOR. Windows silently REMOVES a low-level hook whose
    /// callback exceeds its latency budget (LowLevelHooksTimeout). No error, no
    /// message, HOOK_LIVE still true — every global hotkey is simply dead from
    /// that moment until the feed restarts, which only a leave/rejoin of voice
    /// does. 0.8.129 moved the slow work off the callback, which makes removal
    /// RARER; it cannot make it impossible, because the budget is measured on
    /// the whole machine's scheduling, not this process's — a game plus the
    /// encoder under load is exactly the condition. Field report after that
    /// fix: "hotkeys stop working after a period of time".
    ///
    /// There is no notification to react to, so: re-install on a timer. Unhook +
    /// rehook is a few microseconds once a minute, and bounds the dead window to
    /// this interval instead of the rest of the call.
    const REARM_EVERY_MS: u32 = 60_000;

    /// How often the hook thread checks whether the foreground process sits
    /// above our integrity level (UIPI). Cheap, and the only way to know:
    /// such a process's input never reaches a hook, so there is no event to
    /// react to.
    const BLOCKER_POLL_MS: u32 = 1_000;

    /// Re-arms performed since the feed started. Surfaced by `diag`: a rising
    /// count with a stuck `events_seen` means something OTHER than hook removal
    /// is eating the input.
    static REARMS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

    /// How often the hook thread re-reads the PHYSICAL state of every watched
    /// key (GetAsyncKeyState, bit 0x8000). See the module doc: this is the
    /// second source that makes a lost hook event cost milliseconds instead
    /// of the rest of the call. Sixteen syscalls per tick; WM_TIMER is
    /// coalesced, so a busy thread never builds a backlog.
    const POLL_EVERY_MS: u32 = 20;

    /// Consecutive polls that must disagree with the hook's DOWN bit before
    /// the poll's answer wins. The hook and the key-state table are updated
    /// by different threads, so a single tick can legitimately read the old
    /// state a few microseconds after the hook reported the new one; acting
    /// on that would emit a release-then-press glitch on every keystroke.
    /// Two ticks (~40 ms) is far outside that window and still well under
    /// what a person notices on a release.
    const POLL_CONFIRM: u8 = 2;

    /// Edges the POLL produced because the hook had missed them. Both in
    /// `diag`: presses rising means the hook is being removed (the re-arm
    /// tick is too slow for the load), releases rising means key-ups are
    /// happening where the hook cannot see them.
    static POLL_PRESSES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    static POLL_RELEASES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    /// Presses the poll refused because the remote-control injector was
    /// holding something. Non-zero is not a fault: it is the self-trigger
    /// guard doing its job.
    static POLL_PRESSES_SUPPRESSED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

    /// Set by the blocker thread: the foreground window belongs to a process
    /// above our integrity level, so every capture method reads "nothing
    /// pressed". Read by the poll, which must not mistake that for evidence
    /// that the HOOK is broken.
    static BLOCKED: AtomicBool = AtomicBool::new(false);

    /// Re-arms triggered by EVIDENCE rather than the clock: a press the poll
    /// had to supply means the hook did not report it within two ticks —
    /// the hook is gone (evicted, or pushed out of the chain), and waiting
    /// for the 60 s tick would leave every press at poll latency until then.
    /// Rate-limited, because one legitimate case produces the same evidence
    /// once: a key already held when the feed starts.
    static REARMS_ON_EVIDENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    const EVIDENCE_REARM_MIN_MS: u64 = 2_000;

    /// How long after the last tick that saw a capture blocker the evidence
    /// re-arm stays disarmed. Long enough to cover the tab-back, where every
    /// key the poll could not see while blocked reappears at once.
    const EVIDENCE_REARM_BLOCKED_QUIET_MS: u64 = 1_000;

    /// The poll's decision for one slot: given what WE believe (the DOWN bit)
    /// and what the key-state table says, does the poll emit an edge, and
    /// which? Pure, so the confirmation rule is unit-tested rather than
    /// trusted. `disagree` is the slot's running count of consecutive
    /// disagreeing ticks; agreement resets it.
    fn poll_verdict(disagree: &mut u8, ours_down: bool, phys_down: bool) -> Option<bool> {
        if ours_down == phys_down {
            *disagree = 0;
            return None;
        }
        *disagree = disagree.saturating_add(1);
        if *disagree < POLL_CONFIRM {
            return None;
        }
        *disagree = 0;
        Some(phys_down)
    }

    /// What the poll does with one slot.
    ///
    /// `masked` = the hooks last saw an edge for this slot from OUR OWN
    /// injection. While the key-state table still says it is down we do
    /// nothing at all with the slot: acting on it would turn the remote
    /// controller's keystroke into the host's push-to-talk. The mask is
    /// dropped the moment the table says the key is up — an injected key
    /// that is no longer down is no longer ours, and it must not stay
    /// masked (a hook that dies mid-injection would otherwise leave the
    /// user's own key dead until the feed restarts).
    #[derive(Debug, PartialEq, Eq)]
    enum PollAction {
        Nothing,
        /// Emit this edge: the hook did not report it.
        Emit(bool),
        /// The injection ended; the poll owns the slot again.
        ClearMask,
        /// A press the poll would have supplied, refused because the
        /// remote-control injector is holding something down.
        SuppressedPress,
    }

    /// `masked` comes from the HOOKS (they saw a tagged edge for this slot).
    /// `injector_holding` comes from the injector itself
    /// (`puca_input::injected_inputs_held`), and is the backstop for every
    /// case where the mask cannot be right: the hooks were evicted before the
    /// tagged edge arrived, or the watch list was rewritten mid-hold and the
    /// slot-indexed mask went with it. Without it, a controller holding the
    /// host's push-to-talk key opens the host's microphone — precisely what
    /// the hooks' `PUCA_INJECT_TAG` filter refuses, arrived at through the
    /// poll instead.
    ///
    /// Only PRESSES are refused. A release the poll wants to supply is always
    /// safe: closing a microphone that should already be closed costs
    /// nothing, and leaving one open is the failure this whole poll exists
    /// to prevent.
    fn poll_slot_action(
        disagree: &mut u8,
        masked: bool,
        injector_holding: bool,
        ours_down: bool,
        phys_down: bool,
    ) -> PollAction {
        if masked {
            *disagree = 0;
            return if phys_down { PollAction::Nothing } else { PollAction::ClearMask };
        }
        match poll_verdict(disagree, ours_down, phys_down) {
            Some(true) if injector_holding => PollAction::SuppressedPress,
            Some(is_down) => PollAction::Emit(is_down),
            None => PollAction::Nothing,
        }
    }

    /// One poll tick over the watch list. Runs on the hook thread only (the
    /// timer is thread-scoped), which is what lets it share the DOWN bitmap
    /// with the hook callbacks without a lock: the callback and this tick are
    /// never on the CPU at the same time. Returns whether it had to supply a
    /// PRESS — the evidence that the hook is no longer reporting.
    unsafe fn poll_watched_keys(disagree: &mut [u8; WATCH_SLOTS]) -> bool {
        // GetAsyncKeyState reports PHYSICAL mouse buttons while the hook
        // reports LOGICAL ones; with "swap buttons" on, VK 1 and 2 would
        // disagree forever and the poll would release a right-button hold
        // 40 ms after every press. Those two are left to the hook alone in
        // that configuration. Middle and X buttons are never swapped.
        let swapped = GetSystemMetrics(SM_SWAPBUTTON) != 0;
        let down = DOWN.load(Ordering::SeqCst);
        let masked_bits = SELF_INJECTED.load(Ordering::SeqCst);
        // Asked ONCE per tick, not per slot: it is a relaxed atomic read in
        // another crate, and every slot gets the same answer anyway.
        let injector_holding = puca_input::injected_inputs_held() > 0;
        let mut supplied_press = false;
        for (slot, w) in WATCH.iter().enumerate() {
            let vk = w.load(Ordering::SeqCst);
            if vk == 0 || (swapped && (vk == 1 || vk == 2)) {
                disagree[slot] = 0;
                continue;
            }
            let bit = 1u32 << slot;
            let phys = (GetAsyncKeyState(vk as i32) as u16 & 0x8000) != 0;
            let ours = down & bit != 0;
            match poll_slot_action(&mut disagree[slot], masked_bits & bit != 0, injector_holding, ours, phys) {
                PollAction::Nothing => {}
                PollAction::SuppressedPress => {
                    POLL_PRESSES_SUPPRESSED.fetch_add(1, Ordering::Relaxed);
                }
                PollAction::ClearMask => {
                    SELF_INJECTED.fetch_and(!bit, Ordering::SeqCst);
                }
                PollAction::Emit(is_down) => {
                    if is_down {
                        POLL_PRESSES.fetch_add(1, Ordering::Relaxed);
                        supplied_press = true;
                    } else {
                        POLL_RELEASES.fetch_add(1, Ordering::Relaxed);
                    }
                    emit_transition(slot, vk, is_down);
                }
            }
        }
        // A modifier bit the hook set but the table says is up: the hook
        // missed the release. One tick is enough here — the table lags the
        // hook by microseconds, not milliseconds, and a stuck Ctrl bit would
        // make a Ctrl+M binding fire on a bare M for the rest of the call.
        let up_now = |vk: i32| (GetAsyncKeyState(vk) as u16 & 0x8000) == 0;
        if MOD_CTRL.load(Ordering::Relaxed) && up_now(VK_CONTROL.0 as i32) {
            MOD_CTRL.store(false, Ordering::Relaxed);
        }
        if MOD_ALT.load(Ordering::Relaxed) && up_now(VK_MENU.0 as i32) {
            MOD_ALT.store(false, Ordering::Relaxed);
        }
        if MOD_SHIFT.load(Ordering::Relaxed) && up_now(VK_SHIFT.0 as i32) {
            MOD_SHIFT.store(false, Ordering::Relaxed);
        }
        supplied_press
    }

    /// Tear down and re-install both hooks. Unconditional: there is no way to
    /// ASK Windows whether it dropped a hook, so re-arming only when a check
    /// says so is not an option. A few microseconds; any edge that lands in
    /// the gap is the poll's to supply.
    unsafe fn rearm(
        kbd_hook: &mut windows::core::Result<HHOOK>,
        mouse_hook: &mut windows::core::Result<HHOOK>,
        hinst: HINSTANCE,
    ) {
        if let Ok(h) = *kbd_hook { let _ = UnhookWindowsHookEx(h); }
        if let Ok(h) = *mouse_hook { let _ = UnhookWindowsHookEx(h); }
        *kbd_hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(kbd_proc), hinst, 0);
        *mouse_hook = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), hinst, 0);
        HOOK_LIVE.store(kbd_hook.is_ok(), Ordering::SeqCst);
        REARMS.fetch_add(1, Ordering::Relaxed);
        if let Err(e) = kbd_hook {
            log::warn!("[hotkeys] re-arm FAILED, the poll is the only source until the next one: {e:?}");
        }
    }

    /// Integrity level of the token behind `process` (SECURITY_MANDATORY_*_RID),
    /// or None when it cannot be read.
    ///
    /// None means UNKNOWN, and callers must treat it as such. It used to be
    /// folded into "higher than us", on the theory that a refusal implies a
    /// UIPI boundary. It does not: UIPI governs window messages, while handle
    /// access is decided by the process DACL and the mandatory policy, whose
    /// default (no-write-up) allows query reads upward. A protected or
    /// anti-cheat-shielded game, or an app started as a different user, is
    /// refused while its keys reach us perfectly — and the user was being
    /// told to restart it as administrator for no reason.
    unsafe fn integrity_level_of(process: HANDLE) -> Option<u32> {
        let mut token = HANDLE::default();
        OpenProcessToken(process, TOKEN_QUERY, &mut token).ok()?;
        let mut needed = 0u32;
        let _ = GetTokenInformation(token, TokenIntegrityLevel, None, 0, &mut needed);
        let mut buf = vec![0u8; needed as usize];
        let got = GetTokenInformation(
            token,
            TokenIntegrityLevel,
            Some(buf.as_mut_ptr() as *mut _),
            needed,
            &mut needed,
        );
        let _ = CloseHandle(token);
        got.ok()?;
        let label = &*(buf.as_ptr() as *const TOKEN_MANDATORY_LABEL);
        let sid = label.Label.Sid;
        let count = *GetSidSubAuthorityCount(sid);
        if count == 0 {
            return None;
        }
        Some(*GetSidSubAuthority(sid, (count - 1) as u32))
    }

    /// The executable name of the foreground window's process, when that
    /// process runs at a HIGHER integrity level than we do — the one case in
    /// which Windows (UIPI) delivers none of its keystrokes to our hooks, to
    /// GetAsyncKeyState, or to raw input, and no amount of re-arming helps.
    /// A game launched "as administrator" is the everyday instance. None when
    /// the foreground window is ours, absent, or at our level or below. The
    /// pid rides along so the caller can tell later whether that process is
    /// still running.
    pub(super) fn foreground_capture_blocker() -> (Option<String>, u32) {
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd == HWND::default() {
                return (None, 0);
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid == 0 || pid == std::process::id() {
                return (None, 0);
            }
            let ours = integrity_level_of(GetCurrentProcess()).unwrap_or(0x2000);
            let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
                // Cannot open it at all: unknown, not "elevated". Recorded so
                // a diagnosis can see the difference; never shown to the user
                // as a process name (a banner reading "pid 4312 runs as
                // administrator" is a guess wearing a fact's clothes).
                FOREGROUND_UNREADABLE.store(true, Ordering::SeqCst);
                return (None, 0);
            };
            let theirs = integrity_level_of(process);
            let name = {
                let mut buf = [0u16; 512];
                let mut len = buf.len() as u32;
                let ok = QueryFullProcessImageNameW(process, PROCESS_NAME_FORMAT(0), windows::core::PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
                if ok {
                    let full = String::from_utf16_lossy(&buf[..len as usize]);
                    full.rsplit(['\\', '/']).next().unwrap_or(&full).to_string()
                } else {
                    format!("pid {pid}")
                }
            };
            let _ = CloseHandle(process);
            match theirs {
                // The only case we claim: a level was READ and it is higher.
                Some(level) if level > ours => {
                    FOREGROUND_UNREADABLE.store(false, Ordering::SeqCst);
                    (Some(name), pid)
                }
                Some(_) => {
                    FOREGROUND_UNREADABLE.store(false, Ordering::SeqCst);
                    (None, 0)
                }
                None => {
                    FOREGROUND_UNREADABLE.store(true, Ordering::SeqCst);
                    (None, 0)
                }
            }
        }
    }

    /// The last probe could not read the foreground process's integrity
    /// level. Not a blocker — an unknown. In `diag` so "hotkeys are dead and
    /// nothing is reported" can be told apart from "nothing is wrong".
    static FOREGROUND_UNREADABLE: AtomicBool = AtomicBool::new(false);

    /// Whether the foreground window belongs to THIS process — the truth the
    /// frontend needs where `document.hasFocus()` in the WebView has been seen
    /// to lie (desktopNotify.ts records the same finding).
    pub(super) fn foreground_is_us() -> bool {
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd == HWND::default() {
                return false;
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            pid == std::process::id()
        }
    }

    /// Last blocker reported to the frontend (empty = none), so the change
    /// event fires on transitions only.
    static BLOCKER: Mutex<String> = Mutex::new(String::new());

    /// The pid behind that name, so the latch below can tell "the game is
    /// still running, the user has just tabbed over to read the banner" from
    /// "the game is gone".
    static BLOCKER_PID: AtomicU32 = AtomicU32::new(0);

    /// Is this pid still alive? A limited-information handle is obtainable
    /// across integrity levels for ordinary processes; failing to get one is
    /// treated as gone, which at worst clears a banner a second early.
    fn process_alive(pid: u32) -> bool {
        if pid == 0 {
            return false;
        }
        unsafe {
            match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
                Ok(h) => {
                    let _ = CloseHandle(h);
                    true
                }
                Err(_) => false,
            }
        }
    }

    /// The probe runs on ITS OWN process-lifetime thread, never on the hook
    /// thread. It costs an OpenProcess, a token read and a path read; the
    /// hook thread's latency budget is measured in milliseconds by Windows
    /// (LowLevelHooksTimeout) and it also owns the 20 ms poll, so nothing
    /// that calls into another process belongs on it.
    static BLOCKER_THREAD: OnceLock<()> = OnceLock::new();

    fn ensure_blocker_thread() {
        BLOCKER_THREAD.get_or_init(|| {
            std::thread::spawn(|| loop {
                std::thread::sleep(std::time::Duration::from_millis(BLOCKER_POLL_MS as u64));
                if ACTIVE.load(Ordering::SeqCst) {
                    poll_capture_blocker();
                } else if !BLOCKER.lock().unwrap_or_else(|e| e.into_inner()).is_empty() {
                    // The feed stopped while a blocker stood: forget it, so
                    // the next feed reports afresh and the banner does not
                    // outlive the call it was about.
                    BLOCKED.store(false, Ordering::SeqCst);
                    poll_capture_blocker_reset();
                }
            });
        });
    }

    /// Clear the remembered blocker and tell the frontend, without probing.
    fn poll_capture_blocker_reset() {
        let mut last = BLOCKER.lock().unwrap_or_else(|e| e.into_inner());
        if !last.is_empty() {
            last.clear();
            if let Some(app) = APP.get() {
                let _ = app.emit("global-hotkey-blocked", serde_json::json!({ "process": "" }));
            }
        }
    }

    /// Re-probe the foreground process and tell the frontend when the answer
    /// changed. Runs on the blocker thread only.
    ///
    /// THE ANSWER IS LATCHED WHILE OUR OWN WINDOW IS IN FRONT. The banner
    /// exists to be read, and the only moment the user can read it is after
    /// they alt-tab out of the game that caused it — at which point a plain
    /// change-detector would immediately report "no blocker" and take the
    /// banner away, having shown it only underneath a fullscreen game. So:
    /// our own window in front changes nothing; the latch is released when
    /// an ORDINARY other window is in front (the user has moved on), when
    /// the blocking process exits, or when the feed stops.
    /// The latch rule, as a pure decision so it can be tested.
    #[derive(Debug, PartialEq, Eq)]
    enum BlockerUpdate {
        /// A blocking process is in front.
        Set,
        /// Nothing is blocking any more.
        Clear,
        /// Our own window is in front and the blocker still exists: the user
        /// is looking at the banner. Change nothing.
        Keep,
    }

    fn blocker_update(
        blocking: bool,
        we_are_in_front: bool,
        latched: bool,
        latched_process_alive: bool,
    ) -> BlockerUpdate {
        if blocking {
            BlockerUpdate::Set
        } else if we_are_in_front && latched && latched_process_alive {
            BlockerUpdate::Keep
        } else {
            BlockerUpdate::Clear
        }
    }

    fn poll_capture_blocker() {
        let (probe, pid) = foreground_capture_blocker();
        BLOCKED.store(probe.is_some(), Ordering::SeqCst);
        let mut last = BLOCKER.lock().unwrap_or_else(|e| e.into_inner());
        let latched_pid = BLOCKER_PID.load(Ordering::SeqCst);
        let decision = blocker_update(
            probe.is_some(),
            foreground_is_us(),
            !last.is_empty(),
            process_alive(latched_pid),
        );
        let now = match decision {
            BlockerUpdate::Keep => return,
            BlockerUpdate::Set => {
                BLOCKER_PID.store(pid, Ordering::SeqCst);
                probe.unwrap_or_default()
            }
            BlockerUpdate::Clear => {
                BLOCKER_PID.store(0, Ordering::SeqCst);
                String::new()
            }
        };
        if *last != now {
            *last = now.clone();
            if let Some(app) = APP.get() {
                if now.is_empty() {
                    log::info!("[hotkeys] foreground input reachable again");
                } else {
                    log::warn!("[hotkeys] foreground process {now} runs above our integrity level: its input is invisible to every capture method (UIPI)");
                }
                let _ = app.emit("global-hotkey-blocked", serde_json::json!({ "process": now }));
            }
        }
    }

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
            "starts": STARTS.load(Ordering::SeqCst),
            "stops": STOPS.load(Ordering::SeqCst),
            "rearms": REARMS.load(Ordering::SeqCst),
            "rearm_every_ms": REARM_EVERY_MS,
            // The second source. Rising poll_presses = the hook is being
            // removed under load; rising poll_releases = key-ups are
            // happening where the hook cannot see them. Either way the poll
            // covered it — these explain, they do not indicate a failure.
            "poll_every_ms": POLL_EVERY_MS,
            "poll_presses": POLL_PRESSES.load(Ordering::Relaxed),
            "poll_releases": POLL_RELEASES.load(Ordering::Relaxed),
            // Presses refused because our own remote-control injector was
            // holding a key. Expected during a device session, zero otherwise.
            "poll_presses_suppressed": POLL_PRESSES_SUPPRESSED.load(Ordering::Relaxed),
            "injected_inputs_held": puca_input::injected_inputs_held(),
            // Of `rearms`, how many the poll's evidence triggered (the rest
            // are the 60 s clock). Each one is a hook Windows had removed.
            "rearms_on_evidence": REARMS_ON_EVIDENCE.load(Ordering::Relaxed),
            // Slots believed physically down right now (bit i = slot i).
            "down_bits": DOWN.load(Ordering::SeqCst),
            // Slots held by OUR OWN injected input, which the poll ignores
            // so a remote controller cannot trigger the host's bindings.
            "self_injected_bits": SELF_INJECTED.load(Ordering::SeqCst),
            // Non-empty = the foreground app runs above our integrity level
            // (launched as administrator); Windows hides its input from us.
            // The LATCHED answer, not a fresh probe: a snapshot is read in
            // DevTools with Púca in front, where a fresh probe is always
            // empty by definition.
            "foreground_blocker": BLOCKER.lock().unwrap_or_else(|e| e.into_inner()).clone(),
            "foreground_is_us": foreground_is_us(),
            // True = the foreground process could not be inspected at all
            // (protected, or another user). NOT the same as blocked.
            "foreground_unreadable": FOREGROUND_UNREADABLE.load(Ordering::SeqCst),
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
                while let Ok(mut ev) = rx.recv() {
                    ev.foreground = foreground_is_us();
                    if let Some(app) = APP.get() {
                        if let Err(e) = app.emit("global-hotkey", ev) {
                            log::warn!("[hotkeys] emit failed: {e:?}");
                        }
                    } else {
                        log::warn!("[hotkeys] transition dropped: no app handle");
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
            ctrl_key: MOD_CTRL.load(Ordering::Relaxed) || down_now(VK_CONTROL.0 as i32),
            alt_key: MOD_ALT.load(Ordering::Relaxed) || down_now(VK_MENU.0 as i32),
            shift_key: MOD_SHIFT.load(Ordering::Relaxed) || down_now(VK_SHIFT.0 as i32),
            down: is_down,
            foreground: false, // set by the emitter thread
        };
        EVENTS_SEEN.fetch_add(1, Ordering::Relaxed);
        let _ = emitter().send(ev); // receiver lives for the process
    }

    unsafe extern "system" fn kbd_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 && ACTIVE.load(Ordering::SeqCst) {
            let info = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
            // Only OUR OWN synthetic input is ignored — the remote-control
            // agent stamps every INPUT it sends with PUCA_INJECT_TAG, and that
            // is the self-trigger this filter exists for. The old rule skipped
            // everything with LLKHF_INJECTED, which is also how a gaming
            // mouse's driver (G HUB, Synapse) delivers a remapped side button
            // and how AutoHotkey delivers anything: exactly the keys people
            // bind push-to-talk to, silently dead in every game profile.
            let ours = info.dwExtraInfo == puca_input::PUCA_INJECT_TAG;
            if info.vkCode != 0 {
                let msg = wparam.0 as u32;
                let is_down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
                if ours {
                    // Never a binding — and the POLL must not act on it
                    // either, because SendInput updates the key-state table.
                    mark_self_injected(info.vkCode, is_down);
                } else {
                    note_modifier(info.vkCode, is_down);
                    if let Some(slot) = watched_slot(info.vkCode) {
                        emit_transition(slot, info.vkCode, is_down);
                    }
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
                // Same rule as the keyboard hook: our own injections never
                // trigger a binding, and they mask the slot so the poll
                // cannot act on them either.
                if let Some((vk, is_down)) = mouse_event_vk(msg, info) {
                    if info.dwExtraInfo == puca_input::PUCA_INJECT_TAG {
                        mark_self_injected(vk, is_down);
                    } else if let Some(slot) = watched_slot(vk) {
                        emit_transition(slot, vk, is_down);
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

            // The hook callback's latency budget (LowLevelHooksTimeout) is
            // measured in wall time, which includes waiting for THIS thread
            // to be scheduled. Under a game plus the encoder a normal-priority
            // thread can wait long enough to lose the hook. The thread does
            // microseconds of work per event, so the highest priority the
            // normal priority class allows is safe and is what keeps it on
            // the CPU when it matters.
            if let Err(e) = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL) {
                log::warn!("[hotkeys] could not raise hook thread priority: {e:?}");
            }

            let hmod = GetModuleHandleW(None).unwrap_or_default();
            let hinst = HINSTANCE(hmod.0);
            let mut kbd_hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(kbd_proc), hinst, 0);
            // Mouse hook rides the same thread/pump (the remote_control guard
            // proves the pattern). Best-effort: keyboard bindings must keep
            // working even if the mouse hook is refused.
            let mut mouse_hook = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), hinst, 0);
            if let Err(e) = &mouse_hook {
                log::warn!("[hotkeys] WH_MOUSE_LL install FAILED (mouse bindings inactive): {e:?}");
            }
            let installed = match &kbd_hook {
                Ok(_) => {
                    HOOK_LIVE.store(true, Ordering::SeqCst);
                    log::info!("[hotkeys] WH_KEYBOARD_LL hook installed (mouse: {})",
                        if mouse_hook.is_ok() { "ok" } else { "unavailable" });
                    true
                }
                Err(e) => {
                    log::error!("[hotkeys] hook install FAILED: {e:?}");
                    false
                }
            };

            // Pump messages until PostThreadMessage(WM_QUIT) from stop().
            // Skipped when there is no hook to service (nothing would ever be
            // delivered), and when stop() already ran: it clears ACTIVE first,
            // so a false ACTIVE here means we were told to quit before we were
            // reachable and the WM_QUIT went nowhere.
            if installed && ACTIVE.load(Ordering::SeqCst) {
                // Thread-scoped timer (no window): WM_TIMER is posted to this
                // thread's queue and arrives through the GetMessageW below.
                let timer = SetTimer(None, 0, REARM_EVERY_MS, None);
                let poll_timer = SetTimer(None, 0, POLL_EVERY_MS, None);
                if poll_timer == 0 {
                    log::warn!("[hotkeys] poll timer unavailable: the hook is the only source");
                }
                let mut disagree = [0u8; WATCH_SLOTS];
                let mut last_rearm = std::time::Instant::now();
                let mut last_blocked = std::time::Instant::now();
                let mut msg = MSG::default();
                loop {
                    let r = GetMessageW(&mut msg, None, 0, 0).0;
                    if r == 0 || r == -1 {
                        break; // WM_QUIT (0) or error (-1)
                    }
                    if msg.message != WM_TIMER {
                        continue;
                    }
                    // Two thread-scoped timers; WM_TIMER carries the id.
                    let id = msg.wParam.0;
                    if poll_timer != 0 && id == poll_timer {
                        // While a higher-integrity window is in front,
                        // GetAsyncKeyState returns 0 for EVERYTHING — the
                        // documented UIPI failure return, indistinguishable
                        // from "up". Tabbing back out of such a game then
                        // looks exactly like a press the hook missed. It is
                        // not evidence about the hook, so the evidence
                        // re-arm stands down around it.
                        if BLOCKED.load(Ordering::SeqCst) {
                            last_blocked = std::time::Instant::now();
                        }
                        let hook_missed_a_press = poll_watched_keys(&mut disagree);
                        if hook_missed_a_press
                            && last_rearm.elapsed() >= std::time::Duration::from_millis(EVIDENCE_REARM_MIN_MS)
                            && last_blocked.elapsed() >= std::time::Duration::from_millis(EVIDENCE_REARM_BLOCKED_QUIET_MS)
                        {
                            log::warn!("[hotkeys] the poll saw a press the hook did not: re-arming now");
                            rearm(&mut kbd_hook, &mut mouse_hook, hinst);
                            REARMS_ON_EVIDENCE.fetch_add(1, Ordering::Relaxed);
                            last_rearm = std::time::Instant::now();
                        }
                    } else if timer != 0 && id == timer {
                        rearm(&mut kbd_hook, &mut mouse_hook, hinst);
                        last_rearm = std::time::Instant::now();
                    }
                }
                for t in [timer, poll_timer] {
                    if t != 0 {
                        let _ = KillTimer(None, t);
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
        STARTS.fetch_add(1, Ordering::Relaxed);
        let _ = APP.set(app);
        // The emitter thread is created HERE, on the command thread. It used
        // to be created lazily by the first watched transition — a thread
        // spawn inside a low-level hook callback, which is precisely the
        // unbounded work that gets a hook evicted, and it fell on the first
        // press of every session.
        let _ = emitter();
        ensure_blocker_thread();
        // Re-arming a slot with a DIFFERENT key invalidates that slot's
        // down-state bit: the bit tracks a physical key, so after a rebind it
        // claims the new key is already held — swallowing its first press (no
        // edge is emitted) and, if the old key really was down, never emitting
        // its release. Only changed slots are cleared, so rebinding one action
        // cannot disturb another key the user is currently holding.
        let wanted = dedupe_slots(&keys);
        for (i, slot) in WATCH.iter().enumerate() {
            let next = wanted[i];
            if slot.swap(next, Ordering::SeqCst) != next {
                DOWN.fetch_and(!(1u32 << i), Ordering::SeqCst);
                // The mask describes a KEY, not a slot: a slot that now
                // holds a different key inherits nothing.
                SELF_INJECTED.fetch_and(!(1u32 << i), Ordering::SeqCst);
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

    #[cfg(test)]
    mod poll_tests {
        use super::{poll_verdict, POLL_CONFIRM};

        #[test]
        fn agreement_emits_nothing_and_resets_the_count() {
            let mut d = 1;
            assert_eq!(poll_verdict(&mut d, true, true), None);
            assert_eq!(d, 0);
            assert_eq!(poll_verdict(&mut d, false, false), None);
            assert_eq!(d, 0);
        }

        #[test]
        fn a_single_disagreeing_tick_is_not_acted_on() {
            // The hook just reported DOWN; the key-state table has not caught
            // up yet. One tick must NOT release the key.
            let mut d = 0;
            assert_eq!(poll_verdict(&mut d, true, false), None);
            assert_eq!(d, 1);
        }

        #[test]
        fn a_lost_release_is_emitted_after_confirm_ticks() {
            let mut d = 0;
            for _ in 0..(POLL_CONFIRM - 1) {
                assert_eq!(poll_verdict(&mut d, true, false), None);
            }
            assert_eq!(poll_verdict(&mut d, true, false), Some(false));
            assert_eq!(d, 0, "acted on: the count starts over");
        }

        #[test]
        fn a_press_the_hook_missed_is_emitted_as_down() {
            let mut d = 0;
            for _ in 0..(POLL_CONFIRM - 1) {
                assert_eq!(poll_verdict(&mut d, false, true), None);
            }
            assert_eq!(poll_verdict(&mut d, false, true), Some(true));
        }

        #[test]
        fn our_own_injected_hold_is_invisible_to_the_poll() {
            use super::{poll_slot_action, PollAction};
            // The controller is holding the host's push-to-talk key through
            // SendInput. GetAsyncKeyState reports it down exactly like a
            // real key; the hooks ignored it, so DOWN says up.
            let mut d = 0;
            for _ in 0..10 {
                assert_eq!(
                    poll_slot_action(&mut d, true, false, false, true),
                    PollAction::Nothing,
                    "the poll must never open the mic for our own injection",
                );
            }
        }

        #[test]
        fn positive_control_the_same_edge_WOULD_fire_unmasked() {
            use super::{poll_slot_action, PollAction};
            // Identical inputs with the mask off: proof the test above is
            // watching a rig that CAN see the bad case.
            let mut d = 0;
            let mut got = PollAction::Nothing;
            for _ in 0..POLL_CONFIRM {
                got = poll_slot_action(&mut d, false, false, false, true);
            }
            assert_eq!(got, PollAction::Emit(true));
        }

        #[test]
        fn the_mask_lifts_when_the_injected_key_goes_up() {
            use super::{poll_slot_action, PollAction};
            let mut d = 0;
            assert_eq!(poll_slot_action(&mut d, true, false, false, false), PollAction::ClearMask);
        }

        #[test]
        fn a_masked_slot_does_not_accumulate_disagreement() {
            use super::poll_slot_action;
            // Otherwise the first tick after the mask lifts would fire
            // immediately, on a count built up while we were blind.
            let mut d = 0;
            for _ in 0..10 {
                let _ = poll_slot_action(&mut d, true, false, false, true);
            }
            assert_eq!(d, 0);
        }

        #[test]
        fn a_press_is_refused_while_our_own_injector_holds_a_key() {
            use super::{poll_slot_action, PollAction};
            // The mask is the hooks' answer and can be missing: they may have
            // been evicted before the tagged edge, or the watch list may have
            // been rewritten mid-hold. The injector's own count is not.
            let mut d = 0;
            let mut got = PollAction::Nothing;
            for _ in 0..POLL_CONFIRM {
                got = poll_slot_action(&mut d, false, true, false, true);
            }
            assert_eq!(got, PollAction::SuppressedPress);
        }

        #[test]
        fn positive_control_the_same_press_lands_when_the_injector_is_idle() {
            use super::{poll_slot_action, PollAction};
            let mut d = 0;
            let mut got = PollAction::Nothing;
            for _ in 0..POLL_CONFIRM {
                got = poll_slot_action(&mut d, false, false, false, true);
            }
            assert_eq!(got, PollAction::Emit(true));
        }

        #[test]
        fn a_release_is_never_refused_for_the_injector() {
            use super::{poll_slot_action, PollAction};
            // A microphone closing a moment early costs nothing; one that
            // stays open is the failure the poll exists for.
            let mut d = 0;
            let mut got = PollAction::Nothing;
            for _ in 0..POLL_CONFIRM {
                got = poll_slot_action(&mut d, false, true, true, false);
            }
            assert_eq!(got, PollAction::Emit(false));
        }

        #[test]
        fn the_banner_survives_the_alt_tab_back_to_read_it() {
            use super::{blocker_update, BlockerUpdate};
            // In the game: blocked.
            assert_eq!(blocker_update(true, false, false, false), BlockerUpdate::Set);
            // Alt-tab to Púca to find out why the mic stayed shut. The game
            // is still running: the banner must still be there.
            assert_eq!(blocker_update(false, true, true, true), BlockerUpdate::Keep);
        }

        #[test]
        fn the_latch_releases_when_the_game_exits_or_the_user_moves_on() {
            use super::{blocker_update, BlockerUpdate};
            // Púca in front, the blocking process is gone.
            assert_eq!(blocker_update(false, true, true, false), BlockerUpdate::Clear);
            // Some ordinary other window is in front: the user has moved on.
            assert_eq!(blocker_update(false, false, true, true), BlockerUpdate::Clear);
            // Nothing was ever latched.
            assert_eq!(blocker_update(false, true, false, false), BlockerUpdate::Clear);
        }

        #[test]
        fn a_key_bound_to_two_actions_occupies_one_slot() {
            use super::dedupe_slots;
            // Toggle Mute on bare M, Toggle Deafen on Ctrl+M: the frontend
            // sends VK 0x4D twice. A second slot holding it would be a slot
            // no hook can ever set, which the poll reads as a missed press.
            let got = dedupe_slots(&[0x4D, 0x4D, 0x20]);
            assert_eq!(got[0], 0x4D);
            assert_eq!(got[1], 0, "the duplicate must not occupy a slot");
            assert_eq!(got[2], 0x20, "unrelated keys keep their position");
        }

        #[test]
        fn dedupe_leaves_a_normal_watch_list_alone() {
            use super::dedupe_slots;
            let got = dedupe_slots(&[0x20, 0x4D, 0x44, 5]);
            assert_eq!(&got[..4], &[0x20, 0x4D, 0x44, 5]);
            assert!(got[4..].iter().all(|v| *v == 0));
        }

        #[test]
        fn a_transient_disagreement_that_heals_never_fires() {
            // Down reported by the hook, table lags one tick, then agrees.
            let mut d = 0;
            assert_eq!(poll_verdict(&mut d, true, false), None);
            assert_eq!(poll_verdict(&mut d, true, true), None);
            assert_eq!(d, 0);
            // A fresh disagreement starts from zero again.
            assert_eq!(poll_verdict(&mut d, true, false), None);
        }
    }

    /// Stop watching and tear the hook down. Any key still physically held
    /// gets no further events — the frontend releases its holds itself when
    /// it stops the feed.
    pub fn stop() {
        let _lifecycle = LIFECYCLE.lock().unwrap_or_else(|e| e.into_inner());
        STOPS.fetch_add(1, Ordering::Relaxed);
        // ACTIVE first: it is what a thread that has not yet published its id
        // checks to discover it was told to quit before it was reachable.
        ACTIVE.store(false, Ordering::SeqCst);
        DOWN.store(0, Ordering::SeqCst);
        SELF_INJECTED.store(0, Ordering::SeqCst);
        MOD_CTRL.store(false, Ordering::Relaxed);
        MOD_ALT.store(false, Ordering::Relaxed);
        MOD_SHIFT.store(false, Ordering::Relaxed);
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
        log::warn!("[hotkeys] stop: hook thread did not exit within 100ms");
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
/// pressing the key means the hook is not receiving at all. `starts` /
/// `stops`: lifetime call counts — active:false with both at zero means
/// nothing in this process ever asked for a hook; with `stops` > 0 it was
/// asked for and then stopped (the frontend's feed log says by whom).
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
        "starts": 0,
        "stops": 0,
        "poll_presses": 0,
        "poll_releases": 0,
        "foreground_blocker": "",
        "note": "global hotkeys need the Windows low-level hook; unavailable here",
    })
}

#[cfg(not(windows))]
pub fn start(_app: tauri::AppHandle, _keys: Vec<u32>) -> bool {
    false // no low-level hook outside Windows
}

#[cfg(not(windows))]
pub fn stop() {}
