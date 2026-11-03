//! Global hotkey listener — the desktop half of frontend/src/api/hotkeys.ts.
//!
//! A WH_KEYBOARD_LL hook, plus a WH_MOUSE_LL hook ONLY while a mouse button is
//! bound (dedicated thread + message pump, WM_QUIT teardown), that emit one
//! `global-hotkey` event per TRANSITION of a WATCHED input, with the live
//! modifier state. Mouse buttons ride the same watch slots and wire format as
//! keys — their VKs (1/2/4/5/6) never collide with keyboard codes. The JS
//! registry does the matching; this side only answers "did a bound key or
//! button go down or up, anywhere on the system".
//!
//! WHY THE MOUSE HOOK IS OPTIONAL. While it exists, every mouse event on the
//! machine — a gaming mouse reports at 1-8 kHz — makes a round trip through
//! this process's hook thread before any application sees it, and waits for
//! it. It used to be installed for every call with any global binding, mouse
//! or not. Now it exists only while the watch list holds a mouse button, and
//! a rebind mid-call adds or removes it in place on the hook thread
//! (`WM_WATCH_CHANGED`), never by starting a second hook thread. See
//! `ll_hook.rs`. The hook thread also never logs: its notes go to the
//! emitter thread, so no file write ever runs on the thread that services the
//! hooks.
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
//! is proof the hook is gone, so the hooks (the mouse hook only while a
//! mouse button is bound) are re-installed on the spot rather than at the
//! next 60 s tick. All counted in `diag`, so a rising
//! `poll_*` number says the hook is losing input. A release the poll supplied
//! also leaves a line in puca.log (rate-limited, and naming only the bound key
//! it was).
//!
//! A SET DOWN BIT IS A RELEASE THE PAGE IS OWED. Rewriting the watch list used
//! to clear the bit of every slot that changed. If the key was held, the page
//! was left holding it with nothing on this side remembering that: the key-up
//! then read as "up, and already up", so a release before the poll caught up
//! (under two ticks, ~40 ms) was swallowed, and the person stayed in the wrong
//! push-to-talk or push-to-mute state until their next press. A bit now follows
//! its key to its new slot, and a key that leaves the list gets its release sent
//! right there (`rewrite_watch`, `start`).
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
//! A BLANK TABLE IS NOT A RELEASE. With such a window in front, or a secure
//! screen (a UAC prompt, the lock screen), every key reads up whatever the finger
//! is doing, so the poll "supplies a release" for a key that may still be down. A
//! window whose level cannot be read might be either, so it counts as one too,
//! until a press has been reported with that window in front: nothing reports one
//! from behind a window that hides keys, so its table can be believed from then on.
//! Push-to-talk wants that: closing a microphone costs nothing. Push-to-mute does
//! not, because there the release OPENS it. So that release goes out marked
//! `blocked`, for the page to judge per action, and the key stays owed: once the
//! table can be read again it gets a plain release if it is up, or goes back to
//! the poll and the hook if it is down (`settle_owed`).
//!
//! Coexists with the kill-switch guard: two WH_KEYBOARD_LL hooks in one
//! process are fine (Windows chains them); each has its own thread, statics
//! and WM_QUIT, so teardown of one never touches the other.

// The mouse-hook decision is pure and cross-platform so its tests run
// anywhere; outside Windows nothing else needs it.
#[cfg(any(windows, test))]
use crate::ll_hook::{HookOps, HookSet, HookStep};

/// The mouse-button virtual keys a binding can name (left, right, middle,
/// X1 "Mouse 4", X2 "Mouse 5"). VK 3 is VK_CANCEL, a keyboard code.
#[cfg(any(windows, test))]
const MOUSE_BUTTON_VKS: [u32; 5] = [1, 2, 4, 5, 6];

/// Does this watch list need the system-wide mouse hook at all? Only a bound
/// mouse button is ever read from it.
#[cfg(any(windows, test))]
fn wants_mouse_hook(watch: &[u32]) -> bool {
    watch.iter().any(|vk| MOUSE_BUTTON_VKS.contains(vk))
}

/// Install (or re-arm) the hooks for this watch list: the keyboard hook
/// always, the mouse hook only when a mouse button is watched. The hook
/// thread's first install and every re-arm go through here.
#[cfg(any(windows, test))]
fn arm_for_watch<O: HookOps>(set: &mut HookSet<O::Hook>, ops: &mut O, watch: &[u32]) {
    set.arm(ops, wants_mouse_hook(watch));
}

/// The watch list was rewritten while the feed runs (a rebind mid-call):
/// add or remove the mouse hook in place. Binding Mouse 4 mid-call must
/// install it NOW — otherwise that push-to-talk only works through the 20 ms
/// poll until the next call.
#[cfg(any(windows, test))]
fn on_watch_changed<O: HookOps>(set: &mut HookSet<O::Hook>, ops: &mut O, watch: &[u32]) -> HookStep {
    set.sync_mouse(ops, wants_mouse_hook(watch))
}

/// Posted to the hook thread by `start()` when the watch list changed, so the
/// thread adds or removes its mouse hook in place. `WM_APP + 0x31` (WM_APP is
/// 0x8000; `imp` asserts the two agree at compile time). Defined out here so
/// the pure dispatch below — and its tests — speak the same number.
#[cfg(any(windows, test))]
const WM_WATCH_CHANGED: u32 = 0x8000 + 0x31;
/// `WM_TIMER`, for the same reason (`imp` asserts it too).
#[cfg(any(windows, test))]
const WM_TIMER_MSG: u32 = 0x0113;

/// Whom `start()` must tell that the watch list changed: the running hook
/// thread, and only when something changed. `tid` 0 = no thread has
/// published its id yet; such a thread reads the new list when it installs,
/// because `start()` writes WATCH before it reads THREAD_ID.
#[cfg(any(windows, test))]
fn watch_change_post_target(changed: bool, tid: u32) -> Option<u32> {
    (changed && tid != 0).then_some(tid)
}

/// What one message on the hook thread's queue is.
#[cfg(any(windows, test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PumpMsg {
    WatchChanged,
    RearmTimer,
    PollTimer,
    Other,
}

/// Name a message from the hook thread's queue. The two timers are
/// thread-scoped, so `WM_TIMER` carries the timer id in wParam; an id of 0
/// means that timer could not be created and must match nothing.
#[cfg(any(windows, test))]
fn classify_pump_msg(message: u32, wparam: usize, rearm_timer: usize, poll_timer: usize) -> PumpMsg {
    match message {
        WM_WATCH_CHANGED => PumpMsg::WatchChanged,
        WM_TIMER_MSG if poll_timer != 0 && wparam == poll_timer => PumpMsg::PollTimer,
        WM_TIMER_MSG if rearm_timer != 0 && wparam == rearm_timer => PumpMsg::RearmTimer,
        _ => PumpMsg::Other,
    }
}

/// How the first install went for the mouse hook.
#[cfg(any(windows, test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MouseInstall {
    /// No mouse button is watched: not installed, by design.
    NotNeeded,
    Live,
    /// Wanted, but Windows refused it (mouse binds fall back to the poll).
    Refused,
}

/// What `HotkeyHooks::on_message` did, for the hook thread to report.
#[cfg(any(windows, test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Handled {
    /// WM_WATCH_CHANGED: the mouse hook was synced in place.
    Mouse(HookStep),
    /// The 60 s timer: everything was re-armed for the current watch list.
    Rearmed,
    /// The poll timer: the caller polls (GetAsyncKeyState lives in `imp`)
    /// and calls `rearm` itself when the poll finds evidence.
    Poll,
    Ignored,
}

/// Every hook decision the hotkey hook thread makes, behind the `HookOps`
/// seam. The thread in `imp` owns one of these over the real Win32 hooks and
/// does nothing to a hook except through it; the tests drive the same code
/// with a recorder, so "the thread installs the mouse hook for a
/// keyboard-only feed" is a test failure, not just a helper's.
#[cfg(any(windows, test))]
struct HotkeyHooks<O: HookOps> {
    ops: O,
    set: HookSet<O::Hook>,
}

#[cfg(any(windows, test))]
impl<O: HookOps> HotkeyHooks<O> {
    fn new(ops: O) -> Self {
        Self { ops, set: HookSet::new() }
    }

    /// The hook thread's first install.
    fn install(&mut self, watch: &[u32]) -> MouseInstall {
        arm_for_watch(&mut self.set, &mut self.ops, watch);
        if self.set.mouse.is_some() {
            MouseInstall::Live
        } else if wants_mouse_hook(watch) {
            MouseInstall::Refused
        } else {
            MouseInstall::NotNeeded
        }
    }

    /// Tear down and re-install for the CURRENT watch list (the 60 s timer
    /// and the evidence re-arm). This is also what retries a mouse hook that
    /// Windows refused while the binds stayed the same.
    fn rearm(&mut self, watch: &[u32]) {
        arm_for_watch(&mut self.set, &mut self.ops, watch);
    }

    /// Act on one message from the hook thread's queue.
    fn on_message(&mut self, msg: PumpMsg, watch: &[u32]) -> Handled {
        match msg {
            PumpMsg::WatchChanged => Handled::Mouse(on_watch_changed(&mut self.set, &mut self.ops, watch)),
            PumpMsg::RearmTimer => {
                self.rearm(watch);
                Handled::Rearmed
            }
            PumpMsg::PollTimer => Handled::Poll,
            PumpMsg::Other => Handled::Ignored,
        }
    }

    fn keyboard_live(&self) -> bool {
        self.set.keyboard.is_some()
    }

    fn mouse_live(&self) -> bool {
        self.set.mouse.is_some()
    }

    fn disarm(&mut self) {
        self.set.disarm(&mut self.ops);
    }
}

#[cfg(test)]
mod mouse_hook_tests {
    use super::{arm_for_watch, on_watch_changed, wants_mouse_hook};
    use crate::ll_hook::fake::{Call, FakeHooks, Kind};
    use crate::ll_hook::{HookSet, HookStep};

    const M: u32 = 0x4D; // the M key
    const SPACE: u32 = 0x20;
    const MOUSE4: u32 = 5; // VK_XBUTTON1

    #[test]
    fn mouse_hook_is_not_wanted_for_keyboard_only_binds() {
        assert!(!wants_mouse_hook(&[M, SPACE]));
        assert!(!wants_mouse_hook(&[]));
        assert!(!wants_mouse_hook(&[3]), "VK 3 is VK_CANCEL, not a mouse button");
    }

    #[test]
    fn mouse_hook_is_wanted_for_every_mouse_button() {
        for vk in [1, 2, 4, 5, 6] {
            assert!(wants_mouse_hook(&[SPACE, vk]), "VK {vk} is a mouse button");
        }
    }

    #[test]
    fn a_keyboard_only_feed_never_installs_the_mouse_hook() {
        let mut ops = FakeHooks::default();
        let mut set = HookSet::new();
        arm_for_watch(&mut set, &mut ops, &[M, SPACE]);
        // ...and neither does any re-arm (every 60 s, and on evidence).
        arm_for_watch(&mut set, &mut ops, &[M, SPACE]);
        assert_eq!(ops.mouse_installs(), 0, "a keyboard-only feed put every mouse event on the machine through our hook");
        assert!(set.keyboard.is_some());
    }

    #[test]
    fn positive_control_a_mouse4_bind_does_install_it() {
        let mut ops = FakeHooks::default();
        let mut set = HookSet::new();
        arm_for_watch(&mut set, &mut ops, &[M, MOUSE4]);
        assert_eq!(ops.mouse_installs(), 1);
        assert!(set.mouse.is_some());
    }

    #[test]
    fn binding_mouse4_mid_call_installs_the_mouse_hook_in_place() {
        let mut ops = FakeHooks::default();
        let mut set = HookSet::new();
        arm_for_watch(&mut set, &mut ops, &[M]);
        ops.calls.clear();
        assert_eq!(on_watch_changed(&mut set, &mut ops, &[M, MOUSE4]), HookStep::Install);
        assert!(set.mouse.is_some(), "Mouse 4 push-to-talk bound mid-call must work at once");
        assert_eq!(ops.calls, vec![Call::Install(Kind::Mouse)], "the keyboard hook must not be touched");
    }

    #[test]
    fn unbinding_the_last_mouse_button_removes_the_mouse_hook() {
        let mut ops = FakeHooks::default();
        let mut set = HookSet::new();
        arm_for_watch(&mut set, &mut ops, &[M, MOUSE4]);
        ops.calls.clear();
        assert_eq!(on_watch_changed(&mut set, &mut ops, &[M]), HookStep::Remove);
        assert!(set.mouse.is_none());
        assert_eq!(ops.calls, vec![Call::Remove(Kind::Mouse)]);
    }

    #[test]
    fn a_rebind_that_keeps_a_mouse_button_touches_no_hook() {
        let mut ops = FakeHooks::default();
        let mut set = HookSet::new();
        arm_for_watch(&mut set, &mut ops, &[MOUSE4]);
        ops.calls.clear();
        assert_eq!(on_watch_changed(&mut set, &mut ops, &[MOUSE4, M]), HookStep::Keep);
        assert!(ops.calls.is_empty());
    }

    // --- The hook thread's own decisions (HotkeyHooks) ----------------------
    //
    // `imp::hook_thread` touches hooks ONLY through HotkeyHooks, and names its
    // messages ONLY through classify_pump_msg; `imp::start` decides whether to
    // post ONLY through watch_change_post_target. These drive that same code.

    use super::{classify_pump_msg, watch_change_post_target, Handled, HotkeyHooks, MouseInstall, PumpMsg};
    use super::{WM_TIMER_MSG, WM_WATCH_CHANGED};

    const REARM_TIMER: usize = 7;
    const POLL_TIMER: usize = 8;

    /// One hook thread's life: first install, then each queued message (named
    /// exactly as the real pump names it), then teardown.
    fn run_thread(first_watch: &[u32], queue: &[(u32, usize, &[u32])]) -> (FakeHooks, MouseInstall, Vec<Handled>) {
        let mut hooks = HotkeyHooks::new(FakeHooks::default());
        let first = hooks.install(first_watch);
        let mut handled = Vec::new();
        for (message, wparam, watch) in queue {
            let msg = classify_pump_msg(*message, *wparam, REARM_TIMER, POLL_TIMER);
            handled.push(hooks.on_message(msg, watch));
        }
        hooks.disarm();
        (hooks.ops, first, handled)
    }

    #[test]
    fn the_hook_thread_never_installs_the_mouse_hook_for_a_keyboard_only_feed() {
        // First install, three 60 s re-arms, a poll tick, a rebind that stays
        // keyboard-only: zero mouse installs from start to teardown.
        let (ops, first, handled) = run_thread(
            &[M, SPACE],
            &[
                (WM_TIMER_MSG, REARM_TIMER, &[M, SPACE]),
                (WM_TIMER_MSG, POLL_TIMER, &[M, SPACE]),
                (WM_TIMER_MSG, REARM_TIMER, &[M, SPACE]),
                (WM_WATCH_CHANGED, 0, &[M]),
                (WM_TIMER_MSG, REARM_TIMER, &[M]),
            ],
        );
        assert_eq!(first, MouseInstall::NotNeeded);
        assert_eq!(
            handled,
            vec![Handled::Rearmed, Handled::Poll, Handled::Rearmed, Handled::Mouse(HookStep::Keep), Handled::Rearmed]
        );
        assert_eq!(ops.mouse_installs(), 0, "a keyboard-only feed put every mouse event on the machine through our hook");
    }

    #[test]
    fn positive_control_the_hook_thread_installs_it_for_a_mouse4_bind_and_keeps_it_across_rearms() {
        let (ops, first, _) = run_thread(&[M, MOUSE4], &[(WM_TIMER_MSG, REARM_TIMER, &[M, MOUSE4])]);
        assert_eq!(first, MouseInstall::Live);
        assert_eq!(ops.mouse_installs(), 2, "first install + one re-arm");
    }

    #[test]
    fn a_watch_changed_message_adds_and_removes_the_mouse_hook_in_place() {
        let (ops, _, handled) = run_thread(
            &[M],
            &[(WM_WATCH_CHANGED, 0, &[M, MOUSE4]), (WM_WATCH_CHANGED, 0, &[M])],
        );
        assert_eq!(handled, vec![Handled::Mouse(HookStep::Install), Handled::Mouse(HookStep::Remove)]);
        assert_eq!(
            ops.calls,
            vec![
                Call::Install(Kind::Keyboard),
                Call::Install(Kind::Mouse),
                Call::Remove(Kind::Mouse),
                Call::Remove(Kind::Keyboard),
            ],
            "the rebinds touch only the mouse hook; teardown removes what is left"
        );
    }

    #[test]
    fn a_rearm_follows_the_watch_list_at_the_time_it_fires() {
        // A rebind whose WM_WATCH_CHANGED has not been processed yet is still
        // honoured by a re-arm that runs first: it reads the current list.
        let (ops, _, _) = run_thread(&[M, MOUSE4], &[(WM_TIMER_MSG, REARM_TIMER, &[M])]);
        assert_eq!(ops.mouse_installs(), 1, "the re-arm must not re-install a mouse hook the list no longer wants");
    }

    #[test]
    fn a_refused_mouse_hook_is_reported_and_retried_by_the_next_rearm() {
        let mut hooks = HotkeyHooks::new(FakeHooks { refuse_mouse: true, ..Default::default() });
        assert_eq!(hooks.install(&[M, MOUSE4]), MouseInstall::Refused);
        assert!(hooks.keyboard_live(), "keyboard bindings must survive a refused mouse hook");
        hooks.ops.refuse_mouse = false;
        assert_eq!(hooks.on_message(PumpMsg::RearmTimer, &[M, MOUSE4]), Handled::Rearmed);
        assert!(hooks.mouse_live(), "binds unchanged: the 60 s re-arm is the retry");
    }

    #[test]
    fn pump_messages_are_named_by_message_and_timer_id() {
        assert_eq!(classify_pump_msg(WM_WATCH_CHANGED, 0, REARM_TIMER, POLL_TIMER), PumpMsg::WatchChanged);
        assert_eq!(classify_pump_msg(WM_TIMER_MSG, REARM_TIMER, REARM_TIMER, POLL_TIMER), PumpMsg::RearmTimer);
        assert_eq!(classify_pump_msg(WM_TIMER_MSG, POLL_TIMER, REARM_TIMER, POLL_TIMER), PumpMsg::PollTimer);
        assert_eq!(classify_pump_msg(WM_TIMER_MSG, 99, REARM_TIMER, POLL_TIMER), PumpMsg::Other);
        assert_eq!(classify_pump_msg(0x0401, 0, REARM_TIMER, POLL_TIMER), PumpMsg::Other);
        // A timer SetTimer refused (id 0) matches nothing, even a wParam of 0.
        assert_eq!(classify_pump_msg(WM_TIMER_MSG, 0, 0, 0), PumpMsg::Other);
    }

    #[test]
    fn start_posts_the_watch_change_to_a_published_thread_only_when_it_changed() {
        assert_eq!(watch_change_post_target(true, 4242), Some(4242));
        assert_eq!(watch_change_post_target(false, 4242), None, "an unchanged list needs no message");
        assert_eq!(watch_change_post_target(true, 0), None, "an unpublished thread reads the list itself");
    }
}

#[cfg(windows)]
mod imp {
    use super::{
        classify_pump_msg, wants_mouse_hook, watch_change_post_target, Handled, HotkeyHooks, MouseInstall,
        WM_TIMER_MSG, WM_WATCH_CHANGED,
    };
    use crate::ll_hook::{HookStep, Win32LowLevelHooks};
    use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU32, Ordering};
    use std::sync::{Mutex, OnceLock};
    use tauri::{AppHandle, Emitter};
    use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::Security::{
        GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, TokenIntegrityLevel,
        TOKEN_MANDATORY_LABEL, TOKEN_QUERY,
    };
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
        CallNextHookEx, GetMessageW, KillTimer, PeekMessageW, PostThreadMessageW, SetTimer,
        KBDLLHOOKSTRUCT, MSG, MSLLHOOKSTRUCT, PM_NOREMOVE, WM_APP,
        WM_KEYDOWN, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MBUTTONDOWN, WM_MBUTTONUP,
        WM_MOUSEMOVE, WM_QUIT, WM_RBUTTONDOWN, WM_RBUTTONUP, WM_SYSKEYDOWN, WM_TIMER, WM_USER,
        WM_XBUTTONDOWN, WM_XBUTTONUP,
    };

    static ACTIVE: AtomicBool = AtomicBool::new(false);
    static THREAD_ID: AtomicU32 = AtomicU32::new(0);
    static APP: OnceLock<AppHandle> = OnceLock::new();
    /// Set by the hook thread once SetWindowsHookExW has actually succeeded,
    /// cleared when it tears down. `start()` waits briefly on this so it can
    /// report the truth to the frontend rather than "the command returned".
    static HOOK_LIVE: AtomicBool = AtomicBool::new(false);
    /// The mouse hook is installed right now. False with a mouse button in
    /// the watch list means Windows refused it (that button then works
    /// through the 20 ms poll only); false without one is the normal case.
    static MOUSE_HOOK_LIVE: AtomicBool = AtomicBool::new(false);
    // The pure dispatch outside `imp` spells these numerically; keep it honest.
    const _: () = assert!(WM_WATCH_CHANGED == WM_APP + 0x31 && WM_TIMER_MSG == WM_TIMER);
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
    /// Bitmap of watched slots the page was last told are down — collapses OS
    /// auto-repeat to one edge per press. A set bit is a release the page is
    /// owed, so nothing may clear one without sending that release: see
    /// `rewrite_watch`, and `stop`, where the frontend releases its own holds.
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
        /// A release the poll supplied while the foreground hides every key, so
        /// the key may well still be down. Set by the emitter thread. See the
        /// module doc, "A blank table is not a release".
        blocked: bool,
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

    /// Which slot of this table holds `vk`. A parameter, so the tests walk the
    /// same lookup the hook does.
    fn slot_of(watch: &[AtomicU32; WATCH_SLOTS], vk: u32) -> Option<usize> {
        watch.iter().position(|w| w.load(Ordering::SeqCst) == vk)
    }

    fn watched_slot(vk: u32) -> Option<usize> {
        slot_of(&WATCH, vk)
    }

    /// What a rewrite of the watch list did to keys that were down.
    #[derive(Debug, Default, PartialEq, Eq)]
    struct WatchRewrite {
        /// The list differs from what it was, so the hook thread has to look.
        changed: bool,
        /// Keys that were down and are no longer watched. No later edge can
        /// come for them, so the caller owes the page a release for each.
        released: Vec<u32>,
        /// Keys that were down and are still watched. Their release still
        /// reaches the page in the ordinary way.
        kept: Vec<u32>,
    }

    /// Carry a slot bitmap across a rewrite. A bit describes a KEY, not a slot:
    /// it follows the key to its new slot and goes when the key goes, and a
    /// slot that now holds a different key inherits nothing.
    fn carry_bits(bits: u32, old: &[u32; WATCH_SLOTS], new: &[u32; WATCH_SLOTS]) -> u32 {
        let mut out = 0;
        for (slot, vk) in old.iter().enumerate() {
            if *vk != 0 && bits & (1u32 << slot) != 0 {
                if let Some(to) = new.iter().position(|n| n == vk) {
                    out |= 1u32 << to;
                }
            }
        }
        out
    }

    /// Swap the watch list. A save moves keys between slots without anyone
    /// rebinding them, because `computeNativeWatch` builds the list in order:
    /// turning on "Use Mute and Deafen from other apps" pushes push-to-talk from
    /// slot 0 to slot 2.
    ///
    /// The tables are parameters so a test drives this exact code: `start()`
    /// passes the real statics. An unchanged list, which is most saves (a slider
    /// drag saves on every tick), touches nothing at all.
    ///
    /// The hook thread can run in the middle of this. `fetch_update` keeps an edge
    /// it records on another key. An edge on a key being moved, in the microseconds
    /// this takes, can leave DOWN disagreeing with the key-state table for the poll
    /// to put right within two ticks. Only a press landing in those microseconds
    /// and released inside those two ticks gets past that; closing it would mean
    /// rewriting the list on the hook thread, for a tap no finger can aim.
    fn rewrite_watch(
        watch: &[AtomicU32; WATCH_SLOTS],
        down: &AtomicU32,
        masked: &AtomicU32,
        wanted: &[u32; WATCH_SLOTS],
    ) -> WatchRewrite {
        let old: [u32; WATCH_SLOTS] = std::array::from_fn(|i| watch[i].load(Ordering::SeqCst));
        if old == *wanted {
            return WatchRewrite::default();
        }
        for (slot, next) in watch.iter().zip(wanted) {
            slot.store(*next, Ordering::SeqCst);
        }
        let carry = |bits| Some(carry_bits(bits, &old, wanted));
        let was_down = down.fetch_update(Ordering::SeqCst, Ordering::SeqCst, carry).unwrap_or_else(|bits| bits);
        let _ = masked.fetch_update(Ordering::SeqCst, Ordering::SeqCst, carry);

        let mut out = WatchRewrite { changed: true, ..WatchRewrite::default() };
        for (slot, vk) in old.iter().enumerate() {
            if *vk != 0 && was_down & (1u32 << slot) != 0 {
                if wanted.contains(vk) {
                    out.kept.push(*vk);
                } else {
                    out.released.push(*vk);
                }
            }
        }
        out
    }

    /// `rewrite_watch`, then the release owed for each key that left the list:
    /// no later edge can come for one. Both halves in one place, with the sending
    /// passed in, so the tests run what `start()` runs and not a copy of it.
    fn apply_watch_list(
        watch: &[AtomicU32; WATCH_SLOTS],
        down: &AtomicU32,
        masked: &AtomicU32,
        wanted: &[u32; WATCH_SLOTS],
        mut send_release: impl FnMut(u32),
    ) -> WatchRewrite {
        let rewrite = rewrite_watch(watch, down, masked, wanted);
        for vk in &rewrite.released {
            send_release(*vk);
        }
        rewrite
    }

    /// The puca.log line for a rewrite that found a key down, or nothing: the
    /// list also changes whenever the clip buffer arms, and that is not news.
    /// Every key named was in the watch list, so was bound by the person.
    fn rewrite_log_line(r: &WatchRewrite) -> Option<String> {
        if r.kept.is_empty() && r.released.is_empty() {
            return None;
        }
        Some(format!(
            "[hotkeys] watch list changed with a key down: still watched vk={:?}, released now vk={:?}",
            r.kept, r.released
        ))
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

    /// How often the hook thread tears down and re-installs its hooks (the
    /// mouse hook only while a mouse button is bound).
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
    /// Of `POLL_RELEASES`, those made while the foreground may have hidden every
    /// key: maybe not a release at all. Behind a window above us they are no evidence
    /// about the hook. Behind an unreadable window they may be: a key pressed before
    /// it came to the front, whose key-up the hook then lost, lands here too.
    static POLL_RELEASES_BLOCKED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    /// Releases sent because a save stopped watching a key that was down.
    static RELEASES_ON_REWRITE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

    /// How often a release the poll supplied may reach puca.log, per kind (see
    /// `ReleaseNotes`). One physical release is one line at most, so this only
    /// matters with a dead hook and a fast finger; `poll_releases` in `diag` still
    /// counts every one, and the next line says how many went unwritten.
    const POLL_RELEASE_LOG_MIN_MS: u64 = 10_000;

    /// At most one note per `min_gap_ms`: the first one at once, then whatever
    /// the clock allows, each saying how many were held back before it.
    struct NoteLimiter {
        min_gap_ms: u64,
        last_ms: Option<u64>,
        held_back: u64,
    }

    impl NoteLimiter {
        fn new(min_gap_ms: u64) -> Self {
            Self { min_gap_ms, last_ms: None, held_back: 0 }
        }

        /// `Some(n)`: write a note now; `n` others were held back since the
        /// last one. `None`: not yet, and it is counted.
        fn offer(&mut self, now_ms: u64) -> Option<u64> {
            match self.last_ms {
                Some(last) if now_ms.saturating_sub(last) < self.min_gap_ms => {
                    self.held_back += 1;
                    None
                }
                _ => {
                    self.last_ms = Some(now_ms);
                    Some(std::mem::take(&mut self.held_back))
                }
            }
        }
    }

    /// The line that settles "was my key stuck, or did the hook just miss it?"
    /// `vk` comes from the watch list and nowhere else, so it is a key the person
    /// bound: no other key has any way into this line.
    fn poll_release_line(vk: u32, total: u64, held_back: u64, blocked: bool) -> String {
        let why = if blocked { " (an elevated or unreadable window, or a secure screen, is in front: every key may read up)" } else { "" };
        format!("[hotkeys] the poll supplied a release the hook missed: vk={vk}, poll_releases={total}, {held_back} more since the last line{why}")
    }

    /// One rate limit per kind of line. They answer different questions (is the
    /// hook losing key-ups, or is a window hiding keys?), so a line about one must
    /// not cost the other its line.
    struct ReleaseNotes {
        ordinary: NoteLimiter,
        blocked: NoteLimiter,
    }

    impl ReleaseNotes {
        fn new() -> Self {
            Self {
                ordinary: NoteLimiter::new(POLL_RELEASE_LOG_MIN_MS),
                blocked: NoteLimiter::new(POLL_RELEASE_LOG_MIN_MS),
            }
        }
    }

    /// A release the poll supplied, on the emitter thread and in the order that
    /// matters: the edge first, then the line. The line is a synchronous file
    /// write on a logger other threads share, and this release may be the one
    /// closing a microphone, so it does not wait for the disk.
    fn deliver_poll_release(
        mut ev: KeyEvent,
        total: u64,
        blocked: bool,
        notes: &mut ReleaseNotes,
        now_ms: u64,
        emit: impl FnOnce(KeyEvent),
        write_line: impl FnOnce(String),
    ) {
        let vk = ev.key_code;
        ev.blocked = blocked;
        emit(ev);
        let limit = if blocked { &mut notes.blocked } else { &mut notes.ordinary };
        if let Some(held_back) = limit.offer(now_ms) {
            write_line(poll_release_line(vk, total, held_back, blocked));
        }
    }

    /// Keys the page was told went up while the table was blank: the plain answer
    /// is still owed for each. Added by the emitter thread and settled by the
    /// blocker thread, never touched on the hook thread, so a lock is fine here.
    static OWED_RELEASES: Mutex<Vec<u32>> = Mutex::new(Vec::new());

    /// One look at the owed keys, for a table that can be read again. DOWN bit set:
    /// the hook or the poll has seen it pressed, so they owe the page its release
    /// from here on and nothing is sent. Otherwise up: send the release. Otherwise
    /// down with no bit yet: ask again next time, because a release now would read
    /// as "up, and already up" and reach nobody.
    ///
    /// THE BIT IS READ FIRST. A low-level hook runs before Windows updates the key
    /// table, so a press landing on this look has set the bit while the table still
    /// says up. Read the other way round, that press got a release, which for
    /// push-to-mute opens the microphone with the finger going down.
    fn settle_owed(
        owed: &mut Vec<u32>,
        mut key_is_down: impl FnMut(u32) -> bool,
        mut down_bit_set: impl FnMut(u32) -> bool,
        mut send_release: impl FnMut(u32),
    ) {
        owed.retain(|&vk| {
            if down_bit_set(vk) {
                return false;
            }
            if key_is_down(vk) {
                return true;
            }
            send_release(vk);
            false
        });
    }

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
    /// tagged edge arrived, or the key joined the watch list while an injection
    /// was already holding it. Without it, a controller holding the
    /// host's push-to-talk key opens the host's microphone — precisely what
    /// the hooks' `PUCA_INJECT_TAG` filter refuses, arrived at through the
    /// poll instead.
    ///
    /// Only PRESSES are refused here. A release the poll wants to supply goes out
    /// whatever the injector is doing: leaving a push-to-talk microphone open is
    /// the failure this whole poll exists to prevent. It is not always safe, since
    /// a push-to-mute release OPENS the microphone, but the one case where that
    /// release may be false is a blank table, and the emitter thread marks those
    /// (`Out::PollRelease`) for the page to judge per action.
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

    /// What one poll tick works from, read once at the top of the tick.
    struct PollView {
        watch: [u32; WATCH_SLOTS],
        down: u32,
        masked: u32,
        injector_holding: bool,
        swapped: bool,
    }

    /// The tick's decisions, with the key-state read as a parameter. `read_key`
    /// is only ever asked about a key in `view.watch`: nothing else on the
    /// keyboard is read, here or anywhere, and a test holds this to that.
    fn poll_tick(
        view: &PollView,
        disagree: &mut [u8; WATCH_SLOTS],
        mut read_key: impl FnMut(u32) -> bool,
        mut act: impl FnMut(usize, u32, PollAction),
    ) {
        for (slot, &vk) in view.watch.iter().enumerate() {
            if vk == 0 || (view.swapped && (vk == 1 || vk == 2)) {
                disagree[slot] = 0;
                continue;
            }
            let bit = 1u32 << slot;
            let phys = read_key(vk);
            let ours = view.down & bit != 0;
            match poll_slot_action(&mut disagree[slot], view.masked & bit != 0, view.injector_holding, ours, phys) {
                PollAction::Nothing => {}
                action => act(slot, vk, action),
            }
        }
    }

    /// One poll tick over the watch list. Runs on the hook thread only (the
    /// timer is thread-scoped), which is what lets it share the DOWN bitmap
    /// with the hook callbacks without a lock: the callback and this tick are
    /// never on the CPU at the same time. Returns whether it had to supply a
    /// PRESS — the evidence that the hook is no longer reporting.
    unsafe fn poll_watched_keys(disagree: &mut [u8; WATCH_SLOTS]) -> bool {
        let view = PollView {
            watch: watch_snapshot(),
            down: DOWN.load(Ordering::SeqCst),
            masked: SELF_INJECTED.load(Ordering::SeqCst),
            // Asked ONCE per tick, not per slot: it is a relaxed atomic read in
            // another crate, and every slot gets the same answer anyway.
            injector_holding: puca_input::injected_inputs_held() > 0,
            // GetAsyncKeyState reports PHYSICAL mouse buttons while the hook
            // reports LOGICAL ones; with "swap buttons" on, VK 1 and 2 would
            // disagree forever and the poll would release a right-button hold
            // 40 ms after every press. Those two are left to the hook alone in
            // that configuration. Middle and X buttons are never swapped.
            swapped: GetSystemMetrics(SM_SWAPBUTTON) != 0,
        };
        let mut supplied_press = false;
        poll_tick(
            &view,
            disagree,
            |vk| (GetAsyncKeyState(vk as i32) as u16 & 0x8000) != 0,
            |slot, vk, action| match action {
                PollAction::Nothing => {}
                PollAction::SuppressedPress => {
                    POLL_PRESSES_SUPPRESSED.fetch_add(1, Ordering::Relaxed);
                }
                PollAction::ClearMask => {
                    SELF_INJECTED.fetch_and(!(1u32 << slot), Ordering::SeqCst);
                }
                PollAction::Emit(true) => {
                    POLL_PRESSES.fetch_add(1, Ordering::Relaxed);
                    supplied_press = true;
                    emit_transition(slot, vk, true);
                }
                PollAction::Emit(false) => {
                    // Is it a real release? Asking means calling into another
                    // process, and the answer in BLOCKED is up to a second old,
                    // so the emitter thread asks when it delivers this.
                    let total = POLL_RELEASES.fetch_add(1, Ordering::Relaxed) + 1;
                    if take_edge(&DOWN, slot, false) {
                        send(Out::PollRelease { ev: key_event(vk, false), total });
                    }
                }
            },
        );
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

    /// The watch list as it stands right now.
    fn watch_snapshot() -> [u32; WATCH_SLOTS] {
        std::array::from_fn(|i| WATCH[i].load(Ordering::SeqCst))
    }

    type Hooks = HotkeyHooks<Win32LowLevelHooks>;

    fn publish_hook_state(hooks: &Hooks) {
        HOOK_LIVE.store(hooks.keyboard_live(), Ordering::SeqCst);
        MOUSE_HOOK_LIVE.store(hooks.mouse_live(), Ordering::SeqCst);
    }

    /// Bookkeeping after a re-arm (the 60 s timer or the evidence re-arm),
    /// which tore down and re-installed the hooks — the mouse hook only if
    /// the watch list still needs it. Unconditional by design: there is no
    /// way to ASK Windows whether it dropped a hook, so re-arming only when a
    /// check says so is not an option. A few microseconds; any edge that
    /// lands in the gap is the poll's to supply.
    fn after_rearm(hooks: &Hooks) {
        publish_hook_state(hooks);
        REARMS.fetch_add(1, Ordering::Relaxed);
        if !hooks.keyboard_live() {
            note(HookNote::RearmFailed(hooks.ops.keyboard_error.unwrap_or(0)));
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

    /// What one look at the foreground window found.
    enum ForegroundLook {
        /// No foreground window to ask about: a secure screen, or a window losing
        /// activation for a moment.
        NoWindow,
        /// Ours, or at our integrity level or below. Its keys reach us.
        NotAbove,
        /// At a HIGHER integrity level than ours: the one case in which Windows
        /// (UIPI) delivers none of its keystrokes to our hooks, to
        /// GetAsyncKeyState, or to raw input, and no amount of re-arming helps.
        /// A game launched "as administrator" is the everyday instance. The pid
        /// rides along so the caller can tell later whether it is still running.
        Above { name: String, pid: u32 },
        /// Its level could not be read: a protected process, anti-cheat, another
        /// user. It may be above us or not. The window rides along for
        /// `hides_keys`.
        Unreadable { window: isize },
    }

    impl ForegroundLook {
        /// May the key-state table read up for every key right now?
        ///
        /// Unreadable counts as yes: if that window is in fact above us, believing
        /// the table would open a held push-to-mute with the finger still down.
        /// Until a press has been reported with that very window in front
        /// (`keys_shown_in`, the last window one was): the hooks and the table are
        /// all blind behind a window that hides keys, so that press says this one
        /// does not, whichever of them reported it. From there its releases are
        /// true, so a press and release clears a hold kept for it, and a key-up the
        /// hook lost costs 40 ms as it does anywhere else.
        ///
        /// What stays is a key pressed BEFORE the window came to the front, with
        /// no press since: nothing has been seen to say the window shows its keys.
        /// Its hold waits for the next press and release, or for leaving the window.
        fn hides_keys(&self, keys_shown_in: isize) -> bool {
            match self {
                Self::NotAbove => false,
                Self::Unreadable { window } => *window != keys_shown_in,
                Self::NoWindow | Self::Above { .. } => true,
            }
        }
    }

    /// The last foreground window a press was reported in, by the hook or the poll.
    /// One window, not a list: another window's press costs at most a press and
    /// release when the person comes back, and a handle can be reused.
    static KEYS_SHOWN_IN: AtomicIsize = AtomicIsize::new(0);

    /// What reading a foreground process found, from the process's side.
    enum ProcessRead {
        NotAbove,
        Above { name: String },
        Unreadable,
    }

    /// The name and pid of a foreground process above our integrity level, for
    /// the banner: `(None, 0)` for anything else, an unreadable process included,
    /// because the banner claims only what was read.
    pub(super) fn foreground_capture_blocker() -> (Option<String>, u32) {
        match look_at_foreground() {
            ForegroundLook::Above { name, pid } => (Some(name), pid),
            _ => (None, 0),
        }
    }

    /// One foreground window, from what was asked about it. The syscalls are
    /// parameters so a test drives this exact decision.
    fn look_from(window: isize, pid: u32, own_pid: u32, read_process: impl FnOnce(u32) -> ProcessRead) -> ForegroundLook {
        if window == 0 {
            return ForegroundLook::NoWindow;
        }
        if pid == 0 || pid == own_pid {
            return ForegroundLook::NotAbove;
        }
        match read_process(pid) {
            ProcessRead::NotAbove => ForegroundLook::NotAbove,
            ProcessRead::Above { name } => ForegroundLook::Above { name, pid },
            ProcessRead::Unreadable => ForegroundLook::Unreadable { window },
        }
    }

    fn look_at_foreground() -> ForegroundLook {
        unsafe {
            let hwnd = GetForegroundWindow();
            let mut pid = 0u32;
            if hwnd != HWND::default() {
                GetWindowThreadProcessId(hwnd, Some(&mut pid));
            }
            look_from(hwnd.0 as isize, pid, std::process::id(), read_foreground_process)
        }
    }

    fn read_foreground_process(pid: u32) -> ProcessRead {
        unsafe {
            let ours = integrity_level_of(GetCurrentProcess()).unwrap_or(0x2000);
            let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
                // Cannot open it at all: unknown, not "elevated". Recorded so
                // a diagnosis can see the difference; never shown to the user
                // as a process name (a banner reading "pid 4312 runs as
                // administrator" is a guess wearing a fact's clothes).
                FOREGROUND_UNREADABLE.store(true, Ordering::SeqCst);
                return ProcessRead::Unreadable;
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
                    ProcessRead::Above { name }
                }
                Some(_) => {
                    FOREGROUND_UNREADABLE.store(false, Ordering::SeqCst);
                    ProcessRead::NotAbove
                }
                None => {
                    FOREGROUND_UNREADABLE.store(true, Ordering::SeqCst);
                    ProcessRead::Unreadable
                }
            }
        }
    }

    /// The last probe could not read the foreground process's integrity
    /// level. Not a blocker for the banner — an unknown. In `diag` so "hotkeys are
    /// dead and nothing is reported" can be told apart from "nothing is wrong".
    /// Sticky across a look at our own window, as a snapshot is read from there:
    /// `ForegroundLook` is what to decide on.
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

    /// May the key-state table read up for every key right now? True with a window
    /// above our integrity level in front, with one whose level cannot be read and
    /// that has not been seen to show its keys, and with no foreground window to ask
    /// about: a secure screen (a UAC prompt, the lock screen) takes the whole desktop
    /// away, and GetAsyncKeyState documents zero for that too. A window losing
    /// activation also reads as no window for a moment, which at worst delays a
    /// push-to-mute release until the next look at the owed keys.
    ///
    /// Not for the hook thread (`BLOCKER_THREAD` says why).
    fn foreground_hides_keys() -> bool {
        look_at_foreground().hides_keys(KEYS_SHOWN_IN.load(Ordering::SeqCst))
    }

    /// Answer what a blank table left owing, once the table can be read again.
    /// At worst a second late, and only for a key the page chose to keep holding.
    fn settle_owed_releases() {
        // Its own statement, so the lock is not held across the probe.
        let nothing_owed = OWED_RELEASES.lock().unwrap_or_else(|e| e.into_inner()).is_empty();
        if nothing_owed || foreground_hides_keys() {
            return;
        }
        settle_owed(
            &mut OWED_RELEASES.lock().unwrap_or_else(|e| e.into_inner()),
            |vk| unsafe { (GetAsyncKeyState(vk as i32) as u16 & 0x8000) != 0 },
            |vk| watched_slot(vk).is_some_and(|slot| DOWN.load(Ordering::SeqCst) & (1u32 << slot) != 0),
            |vk| unsafe { send_edge(vk, false) },
        );
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
                    settle_owed_releases();
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
            // The system-wide mouse hook exists only while a mouse button is
            // watched. wanted && !live = Windows refused it (mouse binds then
            // run on the 20 ms poll); !wanted && !live is the normal case.
            "mouse_hook_wanted": wants_mouse_hook(&watching),
            "mouse_hook_live": MOUSE_HOOK_LIVE.load(Ordering::SeqCst),
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
            // Of those, how many came while a window may have been hiding every
            // key: maybe not releases at all. With `foreground_unreadable` false,
            // no evidence about the hook; with it true they may be its lost
            // key-ups. `releases_owed` is how many of those keys still await a
            // reading of the table.
            "poll_releases_blocked": POLL_RELEASES_BLOCKED.load(Ordering::Relaxed),
            "releases_owed": OWED_RELEASES.lock().unwrap_or_else(|e| e.into_inner()).len(),
            // Releases sent because a save stopped watching a key that was
            // down. Each one is also a line in puca.log.
            "releases_on_rewrite": RELEASES_ON_REWRITE.load(Ordering::Relaxed),
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
            // (protected, or another user). NOT the same as blocked. The one field
            // that tells a window hiding a key from a hook losing one behind a
            // window that hid nothing, so a report carries it (`NATIVE_FIELDS`).
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
    ///
    /// The hook THREAD's log lines ride the same channel (`Out::Note`): a
    /// file write on the thread that services the hooks holds every input
    /// event on the machine for as long as the disk takes.
    static EMITTER: OnceLock<std::sync::mpsc::Sender<Out>> = OnceLock::new();

    enum Out {
        Key(KeyEvent),
        /// A release the poll supplied. One message, so the probe that decides
        /// `blocked`, the edge and the log line all happen here and in that order.
        PollRelease { ev: KeyEvent, total: u64 },
        Note(HookNote),
    }

    /// What the hook thread has to say. Formatted and logged on the emitter
    /// thread, never on the hook thread. Codes are HRESULTs.
    enum HookNote {
        PriorityRefused(i32),
        Installed { keyboard: Option<i32>, mouse: MouseNote },
        Mouse(MouseNote),
        PollTimerUnavailable,
        EvidenceRearm,
        RearmFailed(i32),
    }

    enum MouseNote {
        NotNeeded,
        Live,
        Removed,
        Refused(i32),
    }

    fn mouse_note_text(m: &MouseNote) -> String {
        match m {
            MouseNote::NotNeeded => "not needed (no mouse button bound)".into(),
            MouseNote::Live => "ok".into(),
            MouseNote::Removed => "removed (no mouse button bound any more)".into(),
            MouseNote::Refused(c) => format!("REFUSED 0x{:08X} (mouse bindings fall back to the 20 ms poll)", *c as u32),
        }
    }

    fn log_note(n: HookNote) {
        match n {
            HookNote::PriorityRefused(c) => {
                log::warn!("[hotkeys] could not raise hook thread priority: 0x{:08X}", c as u32)
            }
            HookNote::Installed { keyboard: None, mouse } => {
                log::info!("[hotkeys] WH_KEYBOARD_LL hook installed (mouse: {})", mouse_note_text(&mouse))
            }
            HookNote::Installed { keyboard: Some(c), .. } => {
                log::error!("[hotkeys] hook install FAILED: 0x{:08X}", c as u32)
            }
            HookNote::Mouse(m) => log::info!("[hotkeys] WH_MOUSE_LL: {}", mouse_note_text(&m)),
            HookNote::PollTimerUnavailable => {
                log::warn!("[hotkeys] poll timer unavailable: the hook is the only source")
            }
            HookNote::EvidenceRearm => {
                log::warn!("[hotkeys] the poll saw a press the hook did not: re-arming now")
            }
            HookNote::RearmFailed(c) => log::warn!(
                "[hotkeys] re-arm FAILED, the poll is the only source until the next one: 0x{:08X}",
                c as u32
            ),
        }
    }

    fn emit_key(mut ev: KeyEvent) {
        ev.foreground = foreground_is_us();
        if let Some(app) = APP.get() {
            if let Err(e) = app.emit("global-hotkey", ev) {
                log::warn!("[hotkeys] emit failed: {e:?}");
            }
        } else {
            log::warn!("[hotkeys] transition dropped: no app handle");
        }
    }

    fn emitter() -> &'static std::sync::mpsc::Sender<Out> {
        EMITTER.get_or_init(|| {
            let (tx, rx) = std::sync::mpsc::channel::<Out>();
            // Process-lifetime thread; parks on recv when idle. Torn down with
            // the process — the ACTIVE gate already stops events at the source.
            std::thread::spawn(move || {
                let started = std::time::Instant::now();
                let mut release_notes = ReleaseNotes::new();
                while let Ok(out) = rx.recv() {
                    match out {
                        Out::Key(ev) => emit_key(ev),
                        Out::Note(n) => log_note(n),
                        Out::PollRelease { ev, total } => {
                            // A fresh answer, and only on this path, which is
                            // rare: BLOCKED is up to a second old, and the table
                            // goes blank the moment the window comes to the front.
                            let blocked = foreground_hides_keys();
                            if blocked {
                                POLL_RELEASES_BLOCKED.fetch_add(1, Ordering::Relaxed);
                                let mut owed = OWED_RELEASES.lock().unwrap_or_else(|e| e.into_inner());
                                if !owed.contains(&ev.key_code) {
                                    owed.push(ev.key_code);
                                }
                            }
                            let now_ms = started.elapsed().as_millis() as u64;
                            deliver_poll_release(ev, total, blocked, &mut release_notes, now_ms, emit_key, |line| {
                                log::warn!("{line}");
                            });
                        }
                    }
                }
            });
            tx
        })
    }

    /// Hand a message to the emitter thread. Never creates it (start() does,
    /// before any hook thread exists), so this cannot spawn a thread from the
    /// hook thread. The receiver lives for the process.
    fn send(out: Out) {
        if let Some(tx) = EMITTER.get() {
            let _ = tx.send(out);
        }
    }

    /// Hand a note to the emitter thread.
    fn note(n: HookNote) {
        send(Out::Note(n));
    }

    /// Shared edge detector for both hooks. Only real transitions: keyboard
    /// auto-repeat sends WM_KEYDOWN over and over while held, and the frontend
    /// wants edges. Runs in the hook callback — everything here must be cheap
    /// and lock-free (atomics, GetAsyncKeyState, a channel append).
    unsafe fn emit_transition(slot: usize, vk: u32, is_down: bool) {
        if take_reported_edge(&DOWN, &KEYS_SHOWN_IN, slot, is_down, || GetForegroundWindow().0 as isize) {
            send_edge(vk, is_down);
        }
    }

    /// `take_edge` for an edge the hook or the poll has just seen on the key: a press
    /// also says the window in front shows its keys (`ForegroundLook::hides_keys`).
    /// The window is read only for that, and it is one cheap call on the hook thread.
    fn take_reported_edge(
        down: &AtomicU32,
        keys_shown_in: &AtomicIsize,
        slot: usize,
        is_down: bool,
        foreground_window: impl FnOnce() -> isize,
    ) -> bool {
        let is_edge = take_edge(down, slot, is_down);
        if is_edge && is_down {
            keys_shown_in.store(foreground_window(), Ordering::SeqCst);
        }
        is_edge
    }

    /// The edge detector: is this report a change from what the page was last
    /// told about the slot? Records it if so.
    fn take_edge(down: &AtomicU32, slot: usize, is_down: bool) -> bool {
        let bit = 1u32 << slot;
        let was_down = down.load(Ordering::SeqCst) & bit != 0;
        if is_down == was_down {
            return false;
        }
        if is_down {
            down.fetch_or(bit, Ordering::SeqCst);
        } else {
            down.fetch_and(!bit, Ordering::SeqCst);
        }
        true
    }

    /// The edge as the page will hear it. Only ever called with a key that is, or
    /// a moment ago was, in the watch list.
    unsafe fn key_event(vk: u32, is_down: bool) -> KeyEvent {
        let down_now = |vk| (GetAsyncKeyState(vk) as u16 & 0x8000) != 0;
        EVENTS_SEEN.fetch_add(1, Ordering::Relaxed);
        KeyEvent {
            key_code: vk,
            ctrl_key: MOD_CTRL.load(Ordering::Relaxed) || down_now(VK_CONTROL.0 as i32),
            alt_key: MOD_ALT.load(Ordering::Relaxed) || down_now(VK_MENU.0 as i32),
            shift_key: MOD_SHIFT.load(Ordering::Relaxed) || down_now(VK_SHIFT.0 as i32),
            down: is_down,
            foreground: false, // set by the emitter thread
            blocked: false,    // and this, on the one path that can be
        }
    }

    /// Tell the page about an edge. `send`, never `emitter()`: start() created the
    /// channel before any hook existed, and a lazy init here would be a thread
    /// spawn inside a hook callback.
    unsafe fn send_edge(vk: u32, is_down: bool) {
        send(Out::Key(key_event(vk, is_down)));
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

    /// The hook thread. Once a hook exists, nothing here may wait on anything
    /// but its own message queue: this thread services the hooks, so a stall
    /// on it is a stall of every key or mouse event on the machine. Its log
    /// lines go to the emitter thread (`note`).
    fn hook_thread() {
        unsafe {
            // Publish the id BEFORE installing the hook. stop() can only reach
            // a thread whose id it can see, and the install plus its readiness
            // wait was a wide enough window for a stop() to miss the thread
            // entirely — orphaning a live system-wide hook nothing could quit.
            // The message queue is created first (PeekMessageW): a thread
            // message posted to a thread that has no queue yet is LOST, and
            // that includes start()'s WM_WATCH_CHANGED.
            let my_tid = GetCurrentThreadId();
            let mut msg = MSG::default();
            let _ = PeekMessageW(&mut msg, None, WM_USER, WM_USER, PM_NOREMOVE);
            THREAD_ID.store(my_tid, Ordering::SeqCst);

            // The hook callback's latency budget (LowLevelHooksTimeout) is
            // measured in wall time, which includes waiting for THIS thread
            // to be scheduled. Under a game plus the encoder a normal-priority
            // thread can wait long enough to lose the hook. The thread does
            // microseconds of work per event, so the highest priority the
            // normal priority class allows is safe and is what keeps it on
            // the CPU when it matters.
            if let Err(e) = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL) {
                note(HookNote::PriorityRefused(e.code().0));
            }

            // Keyboard hook always; mouse hook only while a mouse button is
            // watched (module doc). Best-effort: keyboard bindings must keep
            // working even if the mouse hook is refused. Every hook decision
            // below goes through HotkeyHooks — the code the tests drive.
            let mut hooks: Hooks = HotkeyHooks::new(Win32LowLevelHooks::new(Some(kbd_proc), Some(mouse_proc)));
            let mouse = match hooks.install(&watch_snapshot()) {
                MouseInstall::Live => MouseNote::Live,
                MouseInstall::Refused => MouseNote::Refused(hooks.ops.mouse_error.unwrap_or(0)),
                MouseInstall::NotNeeded => MouseNote::NotNeeded,
            };
            publish_hook_state(&hooks);
            let installed = hooks.keyboard_live();
            note(HookNote::Installed {
                keyboard: if installed { None } else { Some(hooks.ops.keyboard_error.unwrap_or(0)) },
                mouse,
            });

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
                    note(HookNote::PollTimerUnavailable);
                }
                let mut disagree = [0u8; WATCH_SLOTS];
                let mut last_rearm = std::time::Instant::now();
                let mut last_blocked = std::time::Instant::now();
                loop {
                    let r = GetMessageW(&mut msg, None, 0, 0).0;
                    if r == 0 || r == -1 {
                        break; // WM_QUIT (0) or error (-1)
                    }
                    let kind = classify_pump_msg(msg.message, msg.wParam.0, timer, poll_timer);
                    match hooks.on_message(kind, &watch_snapshot()) {
                        // A rebind: the mouse hook was added or removed in place.
                        Handled::Mouse(step) => {
                            // Each count was about whichever key its slot held.
                            disagree = [0u8; WATCH_SLOTS];
                            publish_hook_state(&hooks);
                            match step {
                                HookStep::Install if hooks.mouse_live() => note(HookNote::Mouse(MouseNote::Live)),
                                HookStep::Install => {
                                    note(HookNote::Mouse(MouseNote::Refused(hooks.ops.mouse_error.unwrap_or(0))))
                                }
                                HookStep::Remove => note(HookNote::Mouse(MouseNote::Removed)),
                                HookStep::Keep => {}
                            }
                        }
                        Handled::Rearmed => {
                            after_rearm(&hooks);
                            last_rearm = std::time::Instant::now();
                        }
                        Handled::Poll => {
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
                                note(HookNote::EvidenceRearm);
                                hooks.rearm(&watch_snapshot());
                                after_rearm(&hooks);
                                REARMS_ON_EVIDENCE.fetch_add(1, Ordering::Relaxed);
                                last_rearm = std::time::Instant::now();
                            }
                        }
                        Handled::Ignored => {}
                    }
                }
                for t in [timer, poll_timer] {
                    if t != 0 {
                        let _ = KillTimer(None, t);
                    }
                }
            }

            hooks.disarm();
            publish_hook_state(&hooks);
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
        // A down bit belongs to its key, so it moves with it: a slot's new key
        // does not inherit it (its first press would be swallowed), and the key
        // that was held keeps it (its release would be). A key that leaves the
        // list is told now, because no later edge can come for it. Sent from this
        // thread on the same channel the hook thread uses.
        let rewrite = apply_watch_list(&WATCH, &DOWN, &SELF_INJECTED, &dedupe_slots(&keys), |vk| {
            RELEASES_ON_REWRITE.fetch_add(1, Ordering::Relaxed);
            unsafe { send_edge(vk, false) };
        });
        let changed = rewrite.changed;
        if let Some(line) = rewrite_log_line(&rewrite) {
            log::info!("{line}");
        }
        ACTIVE.store(true, Ordering::SeqCst);
        // A running hook thread re-checks whether it needs its mouse hook —
        // in place, on that thread, which is the only one that may install
        // or remove a hook it services. Never a second thread. A thread that
        // has not published its id yet reads the new list when it installs
        // (WATCH is written above, before this read of THREAD_ID).
        if let Some(tid) = watch_change_post_target(changed, THREAD_ID.load(Ordering::SeqCst)) {
            unsafe {
                let _ = PostThreadMessageW(tid, WM_WATCH_CHANGED, WPARAM(0), LPARAM(0));
            }
        }
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

    /// The feed with Win32 taken out and the page reduced to what it believes:
    /// the hook's edges, `start()`'s rewrite and the poll's tick all run the real
    /// functions over tables of the test's own. `hook` is a report the hook
    /// delivered; `finger` is a key moving where the hook cannot see it.
    #[cfg(test)]
    mod rewrite_tests {
        use super::{
            apply_watch_list, dedupe_slots, deliver_poll_release, look_from, poll_release_line, poll_tick,
            read_foreground_process, rewrite_log_line, settle_owed, slot_of, take_edge, take_reported_edge, ForegroundLook,
            KeyEvent, NoteLimiter, PollAction, PollView, ProcessRead, ReleaseNotes, WatchRewrite, POLL_CONFIRM,
            POLL_RELEASE_LOG_MIN_MS, WATCH_SLOTS,
        };
        use std::sync::atomic::{AtomicIsize, AtomicU32, Ordering};

        const V: u32 = 0x56; // the push-to-mute key in these stories
        const M: u32 = 0x4D; // Toggle Mute
        const D: u32 = 0x44; // Toggle Deafen
        const B: u32 = 0x42;
        const TYPED: u32 = 0x41; // A: bound to nothing, however often it is pressed
        const ORDINARY: isize = 0x100; // window handles
        const ELEVATED: isize = 0x200;
        const UNREADABLE: isize = 0x300;

        struct Rig {
            watch: [AtomicU32; WATCH_SLOTS],
            down: AtomicU32,
            masked: AtomicU32,
            disagree: [u8; WATCH_SLOTS],
            /// What the key-state table says.
            physical: Vec<u32>,
            /// What the page believes is held: down edges minus up edges.
            page: Vec<u32>,
            /// Every edge the page heard, in order.
            heard: Vec<(u32, bool)>,
            injector_holding: bool,
            last_rewrite: WatchRewrite,
            /// A window hides every key: the table reads up, whatever the finger
            /// is doing. What the window IS comes separately: an unreadable window
            /// may or may not do this, and the emitter decides on `front` alone.
            blank_table: bool,
            /// What `look_at_foreground` answers, and the handle it was asked about.
            front: ForegroundLook,
            front_window: isize,
            keys_shown_in: AtomicIsize,
            /// Releases the page heard marked `blocked`. It keeps the key on these,
            /// as a push-to-mute page does.
            heard_blocked: Vec<u32>,
            owed: Vec<u32>,
        }

        impl Rig {
            fn watching(keys: &[u32]) -> Self {
                let mut rig = Rig {
                    watch: [const { AtomicU32::new(0) }; WATCH_SLOTS],
                    down: AtomicU32::new(0),
                    masked: AtomicU32::new(0),
                    disagree: [0; WATCH_SLOTS],
                    physical: Vec::new(),
                    page: Vec::new(),
                    heard: Vec::new(),
                    injector_holding: false,
                    last_rewrite: WatchRewrite::default(),
                    blank_table: false,
                    front: ForegroundLook::NotAbove,
                    front_window: ORDINARY,
                    keys_shown_in: AtomicIsize::new(0),
                    heard_blocked: Vec::new(),
                    owed: Vec::new(),
                };
                rig.save(keys);
                rig
            }

            fn page_hears(&mut self, vk: u32, is_down: bool) {
                self.heard.push((vk, is_down));
                self.page.retain(|k| *k != vk);
                if is_down {
                    self.page.push(vk);
                }
            }

            fn finger(&mut self, vk: u32, is_down: bool) {
                self.physical.retain(|k| *k != vk);
                if is_down {
                    self.physical.push(vk);
                }
            }

            /// The key moved and the hook reported it (kbd_proc's own path).
            fn hook(&mut self, vk: u32, is_down: bool) {
                self.finger(vk, is_down);
                if let Some(slot) = slot_of(&self.watch, vk) {
                    let window = self.front_window;
                    if take_reported_edge(&self.down, &self.keys_shown_in, slot, is_down, || window) {
                        self.page_hears(vk, is_down);
                    }
                }
            }

            /// An elevated window comes to the front: its keys reach nothing.
            fn elevated_window_in_front(&mut self) {
                self.front = ForegroundLook::Above { name: "game.exe".into(), pid: 1 };
                self.front_window = ELEVATED;
                self.blank_table = true;
            }

            /// A window whose level cannot be read, hiding its keys or not.
            fn unreadable_window_in_front(&mut self, shows_its_keys: bool) {
                self.front = ForegroundLook::Unreadable { window: UNREADABLE };
                self.front_window = UNREADABLE;
                self.blank_table = !shows_its_keys;
            }

            fn ordinary_window_in_front(&mut self) {
                self.front = ForegroundLook::NotAbove;
                self.front_window = ORDINARY;
                self.blank_table = false;
            }

            /// A settings save reaching `start()`, and what `start()` sends for it.
            fn save(&mut self, keys: &[u32]) {
                let mut sent = Vec::new();
                self.last_rewrite = apply_watch_list(&self.watch, &self.down, &self.masked, &dedupe_slots(keys), |vk| sent.push(vk));
                for vk in sent {
                    self.page_hears(vk, false);
                }
            }

            /// The blocker thread's look at the owed keys (`settle_owed_releases`):
            /// nothing until the table can be read again.
            fn settle(&mut self) {
                if self.front.hides_keys(self.keys_shown_in.load(Ordering::SeqCst)) {
                    return;
                }
                let physical = self.physical.clone();
                let watch = &self.watch;
                let down = &self.down;
                let mut sent = Vec::new();
                settle_owed(
                    &mut self.owed,
                    |vk| physical.contains(&vk),
                    |vk| slot_of(watch, vk).is_some_and(|slot| down.load(Ordering::SeqCst) & (1u32 << slot) != 0),
                    |vk| sent.push(vk),
                );
                for vk in sent {
                    self.page_hears(vk, false);
                }
            }

            fn tick(&mut self) {
                let view = PollView {
                    watch: std::array::from_fn(|i| self.watch[i].load(Ordering::SeqCst)),
                    down: self.down.load(Ordering::SeqCst),
                    masked: self.masked.load(Ordering::SeqCst),
                    injector_holding: self.injector_holding,
                    swapped: false,
                };
                let physical = if self.blank_table { Vec::new() } else { self.physical.clone() };
                let mut acted = Vec::new();
                poll_tick(&view, &mut self.disagree, |vk| physical.contains(&vk), |slot, vk, action| acted.push((slot, vk, action)));
                for (slot, vk, action) in acted {
                    match action {
                        PollAction::Emit(is_down) => {
                            let window = self.front_window;
                            let edge = if is_down {
                                take_reported_edge(&self.down, &self.keys_shown_in, slot, true, || window)
                            } else {
                                // The poll's own release path (`poll_watched_keys`).
                                take_edge(&self.down, slot, false)
                            };
                            if edge {
                                // The emitter's decision (`Out::PollRelease`).
                                if !is_down && self.front.hides_keys(self.keys_shown_in.load(Ordering::SeqCst)) {
                                    self.heard_blocked.push(vk);
                                    if !self.owed.contains(&vk) {
                                        self.owed.push(vk);
                                    }
                                } else {
                                    self.page_hears(vk, is_down);
                                }
                            }
                        }
                        PollAction::ClearMask => {
                            self.masked.fetch_and(!(1u32 << slot), Ordering::SeqCst);
                        }
                        PollAction::Nothing | PollAction::SuppressedPress => {}
                    }
                }
            }

            fn ticks(&mut self, n: u8) {
                for _ in 0..n {
                    self.tick();
                }
            }
        }

        /// THE BUG. Push-to-mute on V, nothing else system-wide, and a save that
        /// makes Toggle Mute system-wide too: computeNativeWatch lists Toggle
        /// Mute first, so V moves from slot 0 to slot 1 while it is held. A
        /// release before the poll has caught up (under two ticks, ~40 ms) must
        /// still reach the page, or it stays muted until the next press.
        #[test]
        fn a_release_right_after_a_save_that_moved_the_key_reaches_the_page() {
            for ticks_before_release in 0..POLL_CONFIRM {
                let mut rig = Rig::watching(&[V]);
                rig.hook(V, true);
                assert_eq!(rig.page, [V]);

                rig.save(&[M, V]);
                rig.ticks(ticks_before_release);
                rig.hook(V, false);
                rig.ticks(POLL_CONFIRM + 3);

                assert_eq!(rig.page, [] as [u32; 0], "released {ticks_before_release} tick(s) after the save: the page never heard it");
            }
        }

        #[test]
        fn positive_control_with_no_save_the_same_release_reaches_the_page() {
            let mut rig = Rig::watching(&[V]);
            rig.hook(V, true);
            rig.hook(V, false);
            rig.ticks(POLL_CONFIRM + 3);
            assert_eq!(rig.heard, [(V, true), (V, false)]);
        }

        /// The sibling: V stops being watched while it is held. Nothing can
        /// report its release from here on, so the save itself has to.
        #[test]
        fn a_hold_whose_key_left_the_watch_list_is_released_by_the_save() {
            let mut rig = Rig::watching(&[V, M]);
            rig.hook(V, true);
            rig.save(&[B, M]);
            assert_eq!(rig.page, [] as [u32; 0], "no later edge can come for a key nobody watches");
            assert_eq!(rig.heard, [(V, true), (V, false)]);
            assert_eq!(rig.last_rewrite.released, [V]);
        }

        #[test]
        fn a_key_that_moved_and_is_still_held_is_neither_released_nor_pressed_again() {
            let mut rig = Rig::watching(&[V]);
            rig.hook(V, true);
            rig.save(&[M, D, V]);
            rig.ticks(POLL_CONFIRM + 3);
            assert_eq!(rig.page, [V]);
            // A second "down" here would be the poll supplying a press, which
            // the hook thread reads as proof its hook is dead and re-arms.
            assert_eq!(rig.heard, [(V, true)], "a move is not an edge");
            assert_eq!(rig.last_rewrite.kept, [V]);
            assert_eq!(rig.last_rewrite.released, [] as [u32; 0]);
        }

        #[test]
        fn a_key_that_moved_is_still_released_by_the_poll_when_the_hook_misses_it() {
            let mut rig = Rig::watching(&[V]);
            rig.hook(V, true);
            rig.save(&[M, V]);
            rig.finger(V, false); // released where the hook cannot see it
            rig.ticks(POLL_CONFIRM);
            assert_eq!(rig.page, [] as [u32; 0], "the poll is the guarantee behind the hook");
        }

        #[test]
        fn a_slot_that_now_holds_a_different_key_inherits_nothing() {
            let mut rig = Rig::watching(&[V]);
            rig.hook(V, true);
            rig.save(&[M, V]);
            // Slot 0 was V's and its bit was set: M's first press must be an
            // edge, not a repeat of V's.
            rig.hook(M, true);
            assert_eq!(rig.page, [V, M]);
            rig.hook(M, false);
            assert_eq!(rig.page, [V], "M going up must not touch V");
        }

        #[test]
        fn two_keys_down_one_moved_one_gone() {
            let mut rig = Rig::watching(&[M, V]);
            rig.hook(M, true);
            rig.hook(V, true);
            rig.save(&[V]); // V moves to slot 0, M stops being watched
            assert_eq!(rig.page, [V]);
            assert_eq!(rig.last_rewrite.released, [M]);
            rig.hook(V, false);
            assert_eq!(rig.page, [] as [u32; 0]);
        }

        #[test]
        fn a_key_bound_to_two_actions_keeps_its_one_slot_through_a_save() {
            // Bare M for one action, Ctrl+M for another: the frontend sends the
            // same VK twice, and dedupe_slots gives it one slot.
            let mut rig = Rig::watching(&[M, M, V]);
            rig.hook(V, true);
            rig.save(&[M, V, V]);
            rig.hook(V, false);
            rig.ticks(POLL_CONFIRM + 3);
            assert_eq!(rig.page, [] as [u32; 0]);
        }

        #[test]
        fn a_save_that_changes_nothing_touches_nothing() {
            // A slider drag saves on every tick and each save reaches start().
            let mut rig = Rig::watching(&[M, V]);
            rig.hook(V, true);
            let down = rig.down.load(Ordering::SeqCst);
            rig.masked.store(0b01, Ordering::SeqCst);
            rig.save(&[M, V]);
            assert!(!rig.last_rewrite.changed, "an unchanged list must not wake the hook thread");
            assert_eq!(rig.down.load(Ordering::SeqCst), down);
            assert_eq!(rig.masked.load(Ordering::SeqCst), 0b01);
            assert_eq!(rig.heard, [(V, true)]);
        }

        /// A remote controller is holding the host's V through SendInput when a
        /// save moves it. The mask is about the KEY: if it stayed behind, the
        /// poll would read that hold as a press the hook missed and open the
        /// host's microphone for them.
        #[test]
        fn the_injection_mask_moves_with_its_key() {
            let mut rig = Rig::watching(&[V]);
            rig.masked.store(0b1, Ordering::SeqCst); // the hook saw the tagged edge
            rig.finger(V, true); // SendInput moves the key-state table
            rig.save(&[M, V]);
            rig.ticks(POLL_CONFIRM + 3);
            assert_eq!(rig.heard, [] as [(u32, bool); 0], "the poll acted on our own injection");
            assert_eq!(rig.masked.load(Ordering::SeqCst), 0b10);
            // And the mask still lifts once the key is up.
            rig.finger(V, false);
            rig.tick();
            assert_eq!(rig.masked.load(Ordering::SeqCst), 0);
        }

        #[test]
        fn a_mask_does_not_land_on_the_key_that_takes_over_its_slot() {
            let mut rig = Rig::watching(&[V]);
            rig.masked.store(0b1, Ordering::SeqCst);
            rig.save(&[M, V]);
            rig.finger(M, true); // a real press the hook did not report
            rig.ticks(POLL_CONFIRM);
            assert_eq!(rig.heard, [(M, true)], "M was never injected: the poll must still see it");
        }

        /// A key that joins the list while it is really down reaches the page as
        /// a press: someone holding the push-to-talk key as the list gains it means
        /// to talk. This is why rebinding a key does not seed its DOWN bit. The key
        /// pressed to BE that binding is the page's to ignore (hotkeys.ts,
        /// markKeySpentByCapture), because only the page knows it was.
        #[test]
        fn a_key_added_to_the_list_while_it_is_held_gets_its_press() {
            let mut rig = Rig::watching(&[M]);
            rig.finger(V, true);
            rig.save(&[M, V]);
            assert_eq!(rig.down.load(Ordering::SeqCst), 0, "no bit until the page has been told");
            rig.ticks(POLL_CONFIRM);
            assert_eq!(rig.heard, [(V, true)]);
        }

        // --- A window that hides every key ------------------------------------

        /// Push-to-mute held on V when an elevated window takes the foreground:
        /// the table reads up, with the finger still down.
        fn held_when_the_table_went_blank() -> Rig {
            let mut rig = Rig::watching(&[V]);
            rig.hook(V, true);
            rig.elevated_window_in_front();
            rig.ticks(POLL_CONFIRM);
            assert_eq!(rig.heard_blocked, [V], "the poll said up, and said it might not be");
            assert_eq!(rig.page, [V], "the page kept the hold");
            rig
        }

        #[test]
        fn a_key_released_behind_the_window_gets_its_real_release_when_the_window_goes() {
            let mut rig = held_when_the_table_went_blank();
            rig.finger(V, false); // nothing can see this
            rig.ordinary_window_in_front();
            rig.settle();
            assert_eq!(rig.page, [] as [u32; 0], "or the person stays muted until their next press");
            assert_eq!(rig.owed, [] as [u32; 0]);
        }

        #[test]
        fn a_key_still_down_when_the_window_goes_keeps_its_hold_to_the_end() {
            let mut rig = held_when_the_table_went_blank();
            rig.ordinary_window_in_front();
            rig.ticks(POLL_CONFIRM); // the table reads down again: the poll supplies a press
            rig.settle();
            assert_eq!(rig.heard, [(V, true), (V, true)], "no release in between");
            assert_eq!(rig.owed, [] as [u32; 0], "the hook owes the release from here");
            rig.hook(V, false);
            assert_eq!(rig.page, [] as [u32; 0]);
        }

        /// The look at the owed keys lands inside the two ticks the poll takes to
        /// supply the press, and the finger comes up right after it. With the key
        /// dropped from the list at that look, no edge would ever come: DOWN says
        /// up, the table says up, and the page holds on.
        #[test]
        fn a_key_read_down_before_the_poll_has_it_stays_owed() {
            let mut rig = held_when_the_table_went_blank();
            rig.ordinary_window_in_front();
            rig.settle();
            assert_eq!(rig.owed, [V]);
            assert_eq!(rig.page, [V]);
            rig.finger(V, false);
            rig.ticks(POLL_CONFIRM + 3);
            assert_eq!(rig.page, [V], "the poll has nothing to say: both sides read up");
            rig.settle();
            assert_eq!(rig.page, [] as [u32; 0]);
            assert_eq!(rig.owed, [] as [u32; 0]);
        }

        /// A low-level hook runs before Windows updates the key table. So a press
        /// landing on the look has set the DOWN bit while the table still reads
        /// up: that is a press, and a release here opens a push-to-mute microphone
        /// as the finger goes down. Fails with the table read first.
        #[test]
        fn a_press_the_table_has_not_caught_up_with_gets_no_release() {
            let mut rig = held_when_the_table_went_blank();
            rig.finger(V, false); // let go behind the window, which then goes
            rig.ordinary_window_in_front();
            rig.hook(V, true);
            rig.finger(V, false); // the hook has run; the table has not been updated
            let heard_before = rig.heard.len();
            rig.settle();
            assert!(rig.heard[heard_before..].is_empty(), "a false release: {:?}", rig.heard);
            assert_eq!(rig.page, [V]);
            assert_eq!(rig.owed, [] as [u32; 0], "the hook owes the release from here");
            rig.hook(V, false);
            assert_eq!(rig.page, [] as [u32; 0], "the real release still arrives");
        }

        /// What the emitter and the blocker thread decide on.
        #[test]
        fn a_window_we_cannot_read_counts_as_hiding_keys_until_it_has_shown_one() {
            let unreadable = ForegroundLook::Unreadable { window: UNREADABLE };
            assert!(unreadable.hides_keys(0));
            assert!(unreadable.hides_keys(ORDINARY), "a press in another window says nothing about this one");
            assert!(!unreadable.hides_keys(UNREADABLE));
            // No press can say this about these: a press seen a moment before the
            // window came to the front must not read as the window showing keys.
            assert!(ForegroundLook::NoWindow.hides_keys(0));
            assert!(ForegroundLook::Above { name: "game.exe".into(), pid: 1 }.hides_keys(ELEVATED));
            // Or a key let go in an ordinary window would never be released.
            assert!(!ForegroundLook::NotAbove.hides_keys(0));
        }

        /// What each answer about the foreground window becomes.
        #[test]
        fn the_look_says_unreadable_only_for_a_process_it_could_not_read() {
            let never = |_: u32| -> ProcessRead { panic!("no process to read") };
            assert!(matches!(look_from(0, 0, 7, never), ForegroundLook::NoWindow));
            assert!(matches!(look_from(ORDINARY, 7, 7, never), ForegroundLook::NotAbove), "our own window");
            assert!(matches!(look_from(ORDINARY, 0, 7, never), ForegroundLook::NotAbove), "a window already gone");
            assert!(matches!(
                look_from(UNREADABLE, 9, 7, |_| ProcessRead::Unreadable),
                ForegroundLook::Unreadable { window: UNREADABLE },
            ));
            assert!(matches!(look_from(ORDINARY, 9, 7, |_| ProcessRead::NotAbove), ForegroundLook::NotAbove));
            assert!(matches!(
                look_from(ELEVATED, 9, 7, |_| ProcessRead::Above { name: "game.exe".into() }),
                ForegroundLook::Above { pid: 9, .. },
            ));
        }

        /// The real calls: a pid nothing can have cannot be opened, the case the
        /// first half of this exists for. CONTROL: this process can be read.
        #[test]
        fn a_process_that_cannot_be_opened_reads_as_unreadable() {
            assert!(matches!(read_foreground_process(0xFFFF_FFFC), ProcessRead::Unreadable));
            assert!(matches!(read_foreground_process(std::process::id()), ProcessRead::NotAbove));
        }

        /// Both decisions go through `foreground_hides_keys`, and it asks the look.
        /// Each is one line no test can run (it needs a real foreground window), and
        /// changing one of them is how an unreadable window goes back to counting
        /// as an ordinary one with every test above still green.
        #[test]
        fn both_decisions_ask_the_look_at_the_foreground() {
            let source = include_str!("hotkeys.rs");
            let body_of = |start: &str, end: &str| {
                let from = source.find(start).unwrap_or_else(|| panic!("no {start}")) + start.len();
                source[from..].split(end).next().unwrap().to_string()
            };
            let hides = body_of("fn foreground_hides_keys() -> bool {", "}");
            assert_eq!(hides.trim(), "look_at_foreground().hides_keys(KEYS_SHOWN_IN.load(Ordering::SeqCst))");
            assert!(body_of("Out::PollRelease { ev, total } => {", "let now_ms").contains("let blocked = foreground_hides_keys();"));
            assert!(body_of("fn settle_owed_releases() {", "settle_owed(").contains("nothing_owed || foreground_hides_keys()"));
            // The look goes through the decision the tests drive.
            assert!(body_of("fn look_at_foreground() -> ForegroundLook {", "fn read_foreground_process").contains("look_from("));
            // And a press from either source says the window shows its keys: the
            // hook's and the poll's both come through `emit_transition`.
            assert!(body_of("unsafe fn emit_transition(", "///").contains("take_reported_edge("));
            assert!(body_of("PollAction::Emit(true) => {", "PollAction::Emit(false)").contains("emit_transition(slot, vk, true)"));
            assert!(body_of("unsafe extern \"system\" fn kbd_proc(", "CallNextHookEx").contains("emit_transition("));
        }

        /// THE PRICE of counting an unreadable window, and the way out. The bound key
        /// reaches us only through the poll (Mouse 4 with WH_MOUSE_LL refused, or a
        /// failed re-arm), so nothing but the table can say the window shows its keys.
        /// Press and release there and the release counts: fails if a press the poll
        /// supplied says nothing about the window, which left the person muted for as
        /// long as it stayed in front, with no key press clearing it.
        #[test]
        fn a_poll_only_press_and_release_in_an_unreadable_window_clears_the_hold() {
            let mut rig = Rig::watching(&[V]);
            rig.unreadable_window_in_front(true);
            rig.finger(V, true);
            rig.ticks(POLL_CONFIRM);
            assert_eq!(rig.page, [V], "the poll supplied the press");
            rig.finger(V, false);
            rig.ticks(POLL_CONFIRM);
            assert_eq!(rig.page, [] as [u32; 0], "and the release is believed");
            assert_eq!(rig.heard_blocked, [] as [u32; 0]);
            assert_eq!(rig.owed, [] as [u32; 0]);
        }

        /// The same, for a hold from before the window came: its first release cannot
        /// be told from a table gone blank, and the next press settles it.
        #[test]
        fn a_hold_kept_for_an_unreadable_window_that_shows_its_keys_clears_on_a_re_press() {
            let mut rig = Rig::watching(&[V]);
            rig.finger(V, true);
            rig.ticks(POLL_CONFIRM);
            rig.unreadable_window_in_front(true);
            rig.finger(V, false);
            rig.ticks(POLL_CONFIRM);
            assert_eq!(rig.heard_blocked, [V], "nothing has shown this window's keys yet");
            assert_eq!(rig.page, [V], "the page kept the hold");
            rig.finger(V, true);
            rig.ticks(POLL_CONFIRM);
            rig.finger(V, false);
            rig.ticks(POLL_CONFIRM);
            assert_eq!(rig.page, [] as [u32; 0], "no longer muted");
            assert_eq!(rig.heard_blocked, [V], "and that release was not held back");
            rig.settle();
            assert_eq!(rig.page, [] as [u32; 0], "the look after it finds nothing left to do");
            assert_eq!(rig.owed, [] as [u32; 0]);
        }

        /// The everyday form: the hook is alive and loses one key-up.
        #[test]
        fn a_key_up_the_hook_lost_in_an_unreadable_window_still_costs_only_the_poll() {
            let mut rig = Rig::watching(&[V]);
            rig.unreadable_window_in_front(true);
            rig.hook(V, true);
            rig.finger(V, false);
            rig.ticks(POLL_CONFIRM);
            assert_eq!(rig.page, [] as [u32; 0]);
            assert_eq!(rig.heard_blocked, [] as [u32; 0]);
        }

        /// NEGATIVE CONTROL: the unreadable window that really does hide keys. Nothing
        /// can report a press from behind it, so the finger still holding push-to-mute
        /// stays muted, whatever was pressed before it came.
        #[test]
        fn an_unreadable_window_that_hides_keys_keeps_the_hold() {
            let mut rig = Rig::watching(&[V, M]);
            rig.hook(M, true);
            rig.hook(M, false); // a press seen, in the window before this one
            rig.hook(V, true);
            rig.unreadable_window_in_front(false);
            rig.ticks(POLL_CONFIRM);
            assert_eq!(rig.heard_blocked, [V]);
            assert_eq!(rig.page, [V], "the release may be false, so the mic stays shut");
            rig.settle();
            assert_eq!(rig.page, [V], "and the table cannot be read here");
            rig.ordinary_window_in_front();
            rig.ticks(POLL_CONFIRM);
            assert_eq!(rig.page, [V]);
            rig.hook(V, false);
            assert_eq!(rig.page, [] as [u32; 0], "the real release, once it can be seen");
        }

        /// A press in the unreadable window says nothing once another window has been
        /// in front: that one's press is the last seen, and the handle may be gone.
        #[test]
        fn another_windows_press_takes_the_proof_away() {
            let mut rig = Rig::watching(&[V, M]);
            rig.unreadable_window_in_front(true);
            rig.hook(M, true);
            rig.hook(M, false);
            rig.ordinary_window_in_front();
            rig.hook(M, true);
            rig.hook(M, false);
            rig.hook(V, true);
            rig.unreadable_window_in_front(true);
            rig.finger(V, false);
            rig.ticks(POLL_CONFIRM);
            assert_eq!(rig.heard_blocked, [V]);
        }

        #[test]
        fn an_owed_key_that_left_the_list_is_still_answered() {
            let mut rig = held_when_the_table_went_blank();
            rig.save(&[B]);
            assert_eq!(rig.last_rewrite.released, [] as [u32; 0], "its bit went with the blocked release");
            rig.finger(V, false);
            rig.ordinary_window_in_front();
            rig.settle();
            assert_eq!(rig.page, [] as [u32; 0]);
        }

        fn release_of(vk: u32) -> KeyEvent {
            KeyEvent { key_code: vk, ctrl_key: false, alt_key: false, shift_key: false, down: false, foreground: false, blocked: false }
        }

        /// Everything the emitter did with one release, in order.
        fn deliver(blocked: bool, notes: &mut ReleaseNotes, now_ms: u64) -> Vec<String> {
            let steps = std::cell::RefCell::new(Vec::new());
            deliver_poll_release(
                release_of(V),
                1,
                blocked,
                notes,
                now_ms,
                |ev| steps.borrow_mut().push(format!("edge blocked={}", ev.blocked)),
                |line| steps.borrow_mut().push(line),
            );
            steps.into_inner()
        }

        /// The line is a synchronous file write, and the edge may be closing a
        /// microphone: a stalled disk must not stand in front of it.
        #[test]
        fn the_edge_goes_out_before_the_log_line_is_written() {
            let steps = deliver(false, &mut ReleaseNotes::new(), 0);
            assert_eq!(steps.len(), 2);
            assert_eq!(steps[0], "edge blocked=false");
            assert!(steps[1].starts_with("[hotkeys] the poll supplied a release"), "{}", steps[1]);
        }

        #[test]
        fn a_release_behind_a_hiding_window_is_marked_on_the_edge_and_in_the_line() {
            let steps = deliver(true, &mut ReleaseNotes::new(), 0);
            assert_eq!(steps[0], "edge blocked=true");
            assert!(steps[1].ends_with("(an elevated or unreadable window, or a secure screen, is in front: every key may read up)"), "{}", steps[1]);
        }

        #[test]
        fn the_page_reads_blocked_by_that_name() {
            let mut ev = release_of(V);
            ev.blocked = true;
            let wire = serde_json::to_value(&ev).expect("a KeyEvent serializes");
            assert_eq!(wire["blocked"], true);
            assert_eq!(wire["keyCode"], V);
        }

        /// The two kinds of line answer different questions, so an earlier line
        /// about the hook must not cost a hiding window its own.
        #[test]
        fn a_hook_line_does_not_rate_limit_away_a_hiding_window_line() {
            let mut notes = ReleaseNotes::new();
            assert_eq!(deliver(false, &mut notes, 0).len(), 2);
            let steps = deliver(true, &mut notes, 1);
            assert_eq!(steps.len(), 2, "the blocked line is still written: {steps:?}");
            // Positive control: each kind is still limited against itself, and the
            // edge is never what gets dropped.
            assert_eq!(deliver(false, &mut notes, 2), ["edge blocked=false"]);
            assert_eq!(deliver(true, &mut notes, 3), ["edge blocked=true"]);
        }

        // --- It must not become a keylogger ---------------------------------

        #[test]
        fn the_poll_never_reads_or_reports_a_key_that_is_not_watched() {
            let view = PollView { watch: dedupe_slots(&[M, V]), down: 0, masked: 0, injector_holding: false, swapped: false };
            let mut asked = Vec::new();
            let mut acted = Vec::new();
            let mut disagree = [0; WATCH_SLOTS];
            // Every key on the board reads down, as far as this tick can tell.
            for _ in 0..POLL_CONFIRM {
                poll_tick(&view, &mut disagree, |vk| { asked.push(vk); true }, |_, vk, _| acted.push(vk));
            }
            assert_eq!(asked, [M, V, M, V], "the only keys whose state is ever read");
            assert_eq!(acted, [M, V], "the only keys a line or an edge can name");
        }

        /// Everything that leaves this file with a key in it starts from a watched
        /// slot. A hook callback sees EVERY key on the machine, so what it must
        /// never do is write anything down: this reads their source, since no test
        /// can run them without installing a real system-wide hook.
        #[test]
        fn the_hook_callbacks_see_every_key_and_write_none_of_them_down() {
            let src = include_str!("hotkeys.rs");
            for callback in ["unsafe extern \"system\" fn kbd_proc", "unsafe extern \"system\" fn mouse_proc"] {
                let at = src.find(callback).expect("the callback is in this file");
                let rest = &src[at..];
                let body = &rest[..rest.find("CallNextHookEx").expect("it ends by passing the event on")];
                assert!(body.contains("watched_slot("), "{callback}: the gate every forwarded key passes");
                for writes in ["log::", "note(", "format!", "println!", "emit("] {
                    assert!(!body.contains(writes), "{callback} must not contain {writes}");
                }
            }
            // The positive control: the words it looks for do exist in this file.
            assert!(src.contains("log::warn!") && src.contains("format!"));
        }

        #[test]
        fn the_exact_lines_in_puca_log() {
            assert_eq!(
                poll_release_line(V, 3, 2, false),
                "[hotkeys] the poll supplied a release the hook missed: vk=86, poll_releases=3, 2 more since the last line",
            );
            assert_eq!(
                poll_release_line(V, 1, 0, true),
                "[hotkeys] the poll supplied a release the hook missed: vk=86, poll_releases=1, 0 more since the last line (an elevated or unreadable window, or a secure screen, is in front: every key may read up)",
            );
            let rewrite = WatchRewrite { changed: true, kept: vec![V], released: vec![M] };
            assert_eq!(
                rewrite_log_line(&rewrite).as_deref(),
                Some("[hotkeys] watch list changed with a key down: still watched vk=[86], released now vk=[77]"),
            );
        }

        #[test]
        fn a_rewrite_with_nothing_held_writes_no_line() {
            // The list changes whenever the clip buffer arms; that alone is not news.
            assert_eq!(rewrite_log_line(&WatchRewrite { changed: true, ..WatchRewrite::default() }), None);
        }

        #[test]
        fn a_rewrite_names_only_keys_that_were_watched() {
            let mut rig = Rig::watching(&[M, V]);
            rig.hook(TYPED, true);
            rig.hook(V, true);
            rig.save(&[B]);
            assert_eq!(rig.last_rewrite.released, [V]);
            assert_eq!(rig.last_rewrite.kept, [] as [u32; 0]);
        }

        #[test]
        fn the_release_line_is_rate_limited_and_counts_what_it_held_back() {
            let mut limit = NoteLimiter::new(POLL_RELEASE_LOG_MIN_MS);
            assert_eq!(limit.offer(0), Some(0), "the first one is written at once");
            assert_eq!(limit.offer(1), None);
            assert_eq!(limit.offer(POLL_RELEASE_LOG_MIN_MS - 1), None);
            assert_eq!(limit.offer(POLL_RELEASE_LOG_MIN_MS), Some(2), "and the next says how many it held back");
            assert_eq!(limit.offer(POLL_RELEASE_LOG_MIN_MS + 1), None);
            assert_eq!(limit.offer(10 * POLL_RELEASE_LOG_MIN_MS), Some(1));
            assert_eq!(limit.offer(100 * POLL_RELEASE_LOG_MIN_MS), Some(0), "the count starts over");
        }

        #[test]
        fn a_flood_of_releases_stays_a_trickle_of_lines() {
            // A dead hook and PTT tapped ten times a second for a minute.
            let mut limit = NoteLimiter::new(POLL_RELEASE_LOG_MIN_MS);
            let written = (0..600u64).filter(|i| limit.offer(i * 100).is_some()).count();
            assert_eq!(written, 6);
        }

        #[test]
        fn a_key_nobody_bound_produces_nothing_at_all() {
            let mut rig = Rig::watching(&[M, V]);
            rig.hook(TYPED, true);
            rig.ticks(POLL_CONFIRM + 3);
            rig.hook(TYPED, false);
            rig.save(&[V, M]);
            rig.ticks(POLL_CONFIRM + 3);
            assert_eq!(rig.heard, [] as [(u32, bool); 0], "an unbound key reached the page");
            assert_eq!(rig.last_rewrite.kept, [] as [u32; 0]);
            assert_eq!(rig.last_rewrite.released, [] as [u32; 0]);
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
        OWED_RELEASES.lock().unwrap_or_else(|e| e.into_inner()).clear();
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
/// actually succeeded (the keyboard hook). `mouse_hook_live`: the mouse hook
/// is installed — it exists only while `mouse_hook_wanted` (a mouse button is
/// in the watch list). `watching`: the virtual-key codes in the watch list — a
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
        "mouse_hook_wanted": false,
        "mouse_hook_live": false,
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
