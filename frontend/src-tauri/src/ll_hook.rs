//! The bookkeeping both low-level-hook owners share: the hotkey feed
//! (hotkeys.rs) and the remote-control kill-switch guard (remote_control.rs).
//!
//! A `WH_MOUSE_LL` hook is not free for the REST OF THE MACHINE. Every mouse
//! event any application receives — at a gaming mouse's 1-8 kHz polling rate —
//! first makes a round trip into the thread that owns the hook, and Windows
//! holds that event until the callback returns or `LowLevelHooksTimeout`
//! expires. So a mouse hook nobody needs is a standing invitation for this
//! process to delay the user's cursor. Both owners therefore keep the mouse
//! hook OPTIONAL and install it only while something actually reads it: the
//! hotkey feed while a mouse button is bound, the guard while the opt-in
//! "any input revokes control" kill is on.
//!
//! What lives here is pure: which hook to install, remove or keep, applied
//! through a `HookOps` seam. The real `SetWindowsHookExW` implementation is
//! `Win32LowLevelHooks` below; the tests use a recorder, so no test in this
//! crate ever installs a real hook (a stalled real hook freezes the mouse of
//! whoever runs `cargo test`).

// Outside Windows only the tests use this (there are no low-level hooks).
#![cfg_attr(not(windows), allow(dead_code))]

/// Installs and removes the two low-level hooks. The real implementation calls
/// `SetWindowsHookExW` / `UnhookWindowsHookEx`; tests record the calls.
pub(crate) trait HookOps {
    type Hook;
    /// `None` = Windows refused it.
    fn install_keyboard(&mut self) -> Option<Self::Hook>;
    /// `None` = Windows refused it.
    fn install_mouse(&mut self) -> Option<Self::Hook>;
    fn remove(&mut self, hook: Self::Hook);
}

/// What one optional hook needs to do to match what is wanted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HookStep {
    Install,
    Remove,
    Keep,
}

pub(crate) fn hook_step(wanted: bool, installed: bool) -> HookStep {
    match (wanted, installed) {
        (true, false) => HookStep::Install,
        (false, true) => HookStep::Remove,
        _ => HookStep::Keep,
    }
}

/// The hooks one owner thread currently holds. Only ever touched by that
/// thread: a low-level hook is serviced by the thread that installed it, so
/// install, remove and re-arm all happen there and nowhere else.
pub(crate) struct HookSet<H> {
    pub keyboard: Option<H>,
    pub mouse: Option<H>,
}

impl<H> HookSet<H> {
    pub fn new() -> Self {
        Self { keyboard: None, mouse: None }
    }

    /// Remove whatever is installed, then install afresh: the keyboard hook
    /// always, the mouse hook only when `want_mouse`. Used for the first
    /// install and for every re-arm (Windows can drop a hook silently, and
    /// there is no way to ask whether it did).
    pub fn arm<O: HookOps<Hook = H>>(&mut self, ops: &mut O, want_mouse: bool) {
        self.disarm(ops);
        self.keyboard = ops.install_keyboard();
        if want_mouse {
            self.mouse = ops.install_mouse();
        }
    }

    /// Bring ONLY the mouse hook in line with `want_mouse`, in place. The
    /// keyboard hook is not touched: a rebind must never open a gap in it.
    pub fn sync_mouse<O: HookOps<Hook = H>>(&mut self, ops: &mut O, want_mouse: bool) -> HookStep {
        let step = hook_step(want_mouse, self.mouse.is_some());
        match step {
            HookStep::Install => self.mouse = ops.install_mouse(),
            HookStep::Remove => {
                if let Some(h) = self.mouse.take() {
                    ops.remove(h);
                }
            }
            HookStep::Keep => {}
        }
        step
    }

    pub fn disarm<O: HookOps<Hook = H>>(&mut self, ops: &mut O) {
        if let Some(h) = self.keyboard.take() {
            ops.remove(h);
        }
        if let Some(h) = self.mouse.take() {
            ops.remove(h);
        }
    }
}

/// The real hooks. Construct and use it ONLY on the thread that pumps
/// messages for them.
#[cfg(windows)]
pub(crate) struct Win32LowLevelHooks {
    hinst: windows::Win32::Foundation::HINSTANCE,
    keyboard_proc: windows::Win32::UI::WindowsAndMessaging::HOOKPROC,
    mouse_proc: windows::Win32::UI::WindowsAndMessaging::HOOKPROC,
    /// HRESULT of the last keyboard / mouse install attempt that Windows
    /// refused (`None` = the last attempt succeeded), for the caller to
    /// report — OFF the hook thread, see the owners' docs.
    pub keyboard_error: Option<i32>,
    pub mouse_error: Option<i32>,
}

#[cfg(windows)]
impl Win32LowLevelHooks {
    pub fn new(
        keyboard_proc: windows::Win32::UI::WindowsAndMessaging::HOOKPROC,
        mouse_proc: windows::Win32::UI::WindowsAndMessaging::HOOKPROC,
    ) -> Self {
        use windows::Win32::System::LibraryLoader::GetModuleHandleW;
        // SAFETY: GetModuleHandleW(None) returns this process's own module
        // handle; it is never freed while the process runs.
        let hmod = unsafe { GetModuleHandleW(None) }.unwrap_or_default();
        Self {
            hinst: windows::Win32::Foundation::HINSTANCE(hmod.0),
            keyboard_proc,
            mouse_proc,
            keyboard_error: None,
            mouse_error: None,
        }
    }

    fn install(
        &self,
        id: windows::Win32::UI::WindowsAndMessaging::WINDOWS_HOOK_ID,
        proc_: windows::Win32::UI::WindowsAndMessaging::HOOKPROC,
    ) -> Result<windows::Win32::UI::WindowsAndMessaging::HHOOK, i32> {
        use windows::Win32::UI::WindowsAndMessaging::SetWindowsHookExW;
        // SAFETY: a global low-level hook (thread id 0) with a procedure that
        // lives for the whole process; it is removed by this same thread.
        unsafe { SetWindowsHookExW(id, proc_, self.hinst, 0) }.map_err(|e| e.code().0)
    }
}

#[cfg(windows)]
impl HookOps for Win32LowLevelHooks {
    type Hook = windows::Win32::UI::WindowsAndMessaging::HHOOK;

    fn install_keyboard(&mut self) -> Option<Self::Hook> {
        let r = self.install(windows::Win32::UI::WindowsAndMessaging::WH_KEYBOARD_LL, self.keyboard_proc);
        self.keyboard_error = r.err();
        r.ok()
    }

    fn install_mouse(&mut self) -> Option<Self::Hook> {
        let r = self.install(windows::Win32::UI::WindowsAndMessaging::WH_MOUSE_LL, self.mouse_proc);
        self.mouse_error = r.err();
        r.ok()
    }

    fn remove(&mut self, hook: Self::Hook) {
        // SAFETY: `hook` came from SetWindowsHookExW on this thread and is
        // removed exactly once (HookSet takes it out of its slot first).
        let _ = unsafe { windows::Win32::UI::WindowsAndMessaging::UnhookWindowsHookEx(hook) };
    }
}

/// Records every install and removal instead of touching the OS.
#[cfg(test)]
pub(crate) mod fake {
    use super::HookOps;

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum Kind {
        Keyboard,
        Mouse,
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    pub enum Call {
        Install(Kind),
        Remove(Kind),
    }

    #[derive(Default)]
    pub struct FakeHooks {
        pub calls: Vec<Call>,
        pub refuse_mouse: bool,
        pub refuse_keyboard: bool,
    }

    impl FakeHooks {
        pub fn mouse_installs(&self) -> usize {
            self.calls.iter().filter(|c| **c == Call::Install(Kind::Mouse)).count()
        }
    }

    impl HookOps for FakeHooks {
        type Hook = Kind;
        fn install_keyboard(&mut self) -> Option<Kind> {
            self.calls.push(Call::Install(Kind::Keyboard));
            (!self.refuse_keyboard).then_some(Kind::Keyboard)
        }
        fn install_mouse(&mut self) -> Option<Kind> {
            self.calls.push(Call::Install(Kind::Mouse));
            (!self.refuse_mouse).then_some(Kind::Mouse)
        }
        fn remove(&mut self, hook: Kind) {
            self.calls.push(Call::Remove(hook));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fake::{Call, FakeHooks, Kind};
    use super::{hook_step, HookSet, HookStep};

    #[test]
    fn hook_step_installs_removes_or_keeps() {
        assert_eq!(hook_step(true, false), HookStep::Install);
        assert_eq!(hook_step(false, true), HookStep::Remove);
        assert_eq!(hook_step(true, true), HookStep::Keep);
        assert_eq!(hook_step(false, false), HookStep::Keep);
    }

    #[test]
    fn arm_without_the_mouse_installs_only_the_keyboard_hook() {
        let mut ops = FakeHooks::default();
        let mut set = HookSet::new();
        set.arm(&mut ops, false);
        assert_eq!(ops.calls, vec![Call::Install(Kind::Keyboard)]);
        assert!(set.mouse.is_none());
    }

    #[test]
    fn re_arming_removes_both_before_installing_again() {
        let mut ops = FakeHooks::default();
        let mut set = HookSet::new();
        set.arm(&mut ops, true);
        ops.calls.clear();
        set.arm(&mut ops, true);
        assert_eq!(
            ops.calls,
            vec![
                Call::Remove(Kind::Keyboard),
                Call::Remove(Kind::Mouse),
                Call::Install(Kind::Keyboard),
                Call::Install(Kind::Mouse),
            ]
        );
    }

    #[test]
    fn sync_mouse_never_touches_the_keyboard_hook() {
        let mut ops = FakeHooks::default();
        let mut set = HookSet::new();
        set.arm(&mut ops, false);
        ops.calls.clear();
        assert_eq!(set.sync_mouse(&mut ops, true), HookStep::Install);
        assert_eq!(set.sync_mouse(&mut ops, true), HookStep::Keep);
        assert_eq!(set.sync_mouse(&mut ops, false), HookStep::Remove);
        assert_eq!(set.sync_mouse(&mut ops, false), HookStep::Keep);
        assert_eq!(ops.calls, vec![Call::Install(Kind::Mouse), Call::Remove(Kind::Mouse)]);
        assert!(set.keyboard.is_some());
    }

    #[test]
    fn a_refused_mouse_hook_is_retried_by_the_next_sync_and_keyboard_survives() {
        let mut ops = FakeHooks { refuse_mouse: true, ..Default::default() };
        let mut set = HookSet::new();
        set.arm(&mut ops, true);
        assert!(set.keyboard.is_some(), "keyboard bindings must survive a refused mouse hook");
        assert!(set.mouse.is_none());
        ops.refuse_mouse = false;
        assert_eq!(set.sync_mouse(&mut ops, true), HookStep::Install);
        assert!(set.mouse.is_some());
    }

    #[test]
    fn disarm_leaves_nothing_installed() {
        let mut ops = FakeHooks::default();
        let mut set = HookSet::new();
        set.arm(&mut ops, true);
        set.disarm(&mut ops);
        assert!(set.keyboard.is_none() && set.mouse.is_none());
        let installs = ops.calls.iter().filter(|c| matches!(c, Call::Install(_))).count();
        let removes = ops.calls.iter().filter(|c| matches!(c, Call::Remove(_))).count();
        assert_eq!(installs, removes, "every installed hook is removed exactly once");
    }
}
