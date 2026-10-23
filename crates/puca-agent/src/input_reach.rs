//! Can this agent's injected input reach the window that would receive it?
//!
//! THE FAILURE THIS NAMES. Windows' User Interface Privilege Isolation (UIPI)
//! drops injected input aimed at a window whose process runs at a HIGHER
//! integrity level than the injector: a program run as administrator, Task
//! Manager on an administrator account, an installer, a game started by an
//! elevated launcher. And it says nothing. `SendInput` answers as if it worked,
//! the capture keeps showing the window, and the viewer's clicks and keys simply
//! vanish — Microsoft's own documentation says neither the return value nor
//! `GetLastError` reveals it.
//!
//! Found on 2026-10-23: "mouse doesn't always work, whenever the laptop opens a
//! game". The owner's laptop starts Steam from a scheduled task that runs with
//! highest privileges, so every Valheim it launched was elevated, and the
//! user-flavour agent (medium integrity, a child of the app) could not touch
//! it. Every input tally that evening said `failed=0`.
//!
//! So the agent asks the one question the input path cannot: for the window
//! that would receive a keystroke (the foreground) and the one that would
//! receive a click (the window under the pointer), does its process sit above
//! this one? The answer rides the 1 Hz `SessionStatus` poll to the viewer, which
//! names the program and what to do about it, and each change is one log line.
//!
//! A SYSTEM agent (the sign-in-screen flavour) is above every application and
//! never asks.

/// Mandatory integrity RIDs (winnt.h `SECURITY_MANDATORY_*_RID`).
pub(crate) const IL_MEDIUM: u32 = 0x2000;
pub(crate) const IL_HIGH: u32 = 0x3000;
pub(crate) const IL_SYSTEM: u32 = 0x4000;

/// What the probe could learn about the process that owns a window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Owner {
    /// Its integrity level, read from its token.
    Level(u32),
    /// Its token would not open for this process at all. Same-account
    /// processes at or below us always open, so this is a process above us —
    /// another account's, or the system's — which UIPI treats the same way.
    Unreadable,
}

/// Which window the probe was asking about.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Role {
    /// The foreground window: where keystrokes go.
    Foreground,
    /// The window under the pointer: where clicks go.
    UnderPointer,
}

/// One window this agent's input cannot reach.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Blocked {
    /// The program's file name, e.g. `valheim.exe`. Never a path.
    pub app: String,
    pub role: Role,
    pub owner: Owner,
}

/// Would Windows drop input from a process at `own` aimed at `owner`'s window?
pub(crate) fn blocks(own: u32, owner: Owner) -> bool {
    if own >= IL_SYSTEM {
        return false;
    }
    match owner {
        Owner::Level(level) => level > own,
        Owner::Unreadable => true,
    }
}

/// A program's file name from its full image path, safe to log and to show:
/// the last path component only (a path names the user's folders), control
/// characters dropped, and bounded. `None` for nothing usable.
pub(crate) fn app_name(image_path: &str) -> Option<String> {
    let last = image_path.rsplit(['\\', '/']).next().unwrap_or("");
    let clean: String = last.chars().filter(|c| !c.is_control()).take(64).collect();
    let clean = clean.trim().to_string();
    (!clean.is_empty()).then_some(clean)
}

/// The words for an integrity level, for the log.
pub(crate) fn level_name(owner: Owner) -> String {
    match owner {
        Owner::Level(l) if l >= IL_SYSTEM => "System".into(),
        Owner::Level(l) if l >= IL_HIGH => "High (administrator)".into(),
        Owner::Level(l) if l >= IL_MEDIUM => "Medium".into(),
        Owner::Level(l) => format!("Low (0x{l:x})"),
        Owner::Unreadable => "unreadable from here (another account, or the system)".into(),
    }
}

/// Writes a line when what the probe sees CHANGES, and never otherwise: the
/// poll runs once a second for as long as a session lasts.
#[derive(Default)]
pub(crate) struct ReachLog {
    last: Option<(String, Role)>,
}

impl ReachLog {
    pub(crate) fn observe(&mut self, now: Option<&Blocked>, own: u32) -> Option<String> {
        let key = now.map(|b| (b.app.clone(), b.role));
        if key == self.last {
            return None;
        }
        self.last = key;
        Some(match now {
            Some(b) => format!(
                "[input] Windows is dropping this agent's input to {} ({}): it runs at integrity {}, \
                 this agent at {} — UIPI blocks injection upward, and SendInput does not say so",
                b.app,
                match b.role {
                    Role::Foreground => "the window in front",
                    Role::UnderPointer => "the window under the pointer",
                },
                level_name(b.owner),
                level_name(Owner::Level(own)),
            ),
            None => "[input] the windows in front and under the pointer accept this agent's input again".into(),
        })
    }
}

/// Has a program taken the pointer for itself — hidden it AND confined it with
/// `ClipCursor`? That is a game in mouse-look: it re-centres the pointer every
/// frame and reads raw motion, so absolute moves cannot steer it, and the
/// viewer's Game mode (relative moves under pointer lock) is the way in.
/// Either alone is ordinary — a video player hides the pointer, a windowed
/// game confines it in its menus — so only the pair counts. `clip == virt` is
/// Windows' way of saying no clip is in force.
pub(crate) fn captured(hidden: bool, clip: puca_input::ClipRect, virt: puca_input::ClipRect) -> bool {
    hidden && clip != virt
}

/// `captured`, read live: the pointer's visibility (`GetCursorInfo`) and the
/// clip in force (`puca_input::read_cursor_clip`). False when either cannot be
/// read — this only ever offers a hint.
#[cfg(windows)]
pub(crate) fn pointer_captured() -> bool {
    use windows::Win32::UI::WindowsAndMessaging::{GetCursorInfo, CURSORINFO};
    /// `CURSOR_SHOWING` (winuser.h).
    const SHOWING: u32 = 0x1;
    let mut info = CURSORINFO { cbSize: std::mem::size_of::<CURSORINFO>() as u32, ..Default::default() };
    if unsafe { GetCursorInfo(&mut info) }.is_err() {
        return false;
    }
    let hidden = info.flags.0 & SHOWING == 0;
    match puca_input::read_cursor_clip() {
        Some((clip, virt)) => captured(hidden, clip, virt),
        None => false,
    }
}

#[cfg(not(windows))]
pub(crate) fn pointer_captured() -> bool {
    false
}

/// The probe itself: the foreground window first (keys), then the window under
/// the pointer (clicks). `None` when both are reachable, when either cannot be
/// asked about, and on every platform without UIPI.
#[cfg(windows)]
pub(crate) fn probe() -> Option<Blocked> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetCursorPos, GetForegroundWindow, GetWindowThreadProcessId, WindowFromPoint,
    };
    let own = own_level()?;
    if own >= IL_SYSTEM {
        return None;
    }
    let me = std::process::id();
    let mut asked = Vec::with_capacity(2);
    let fg = unsafe { GetForegroundWindow() };
    asked.push((fg, Role::Foreground));
    let mut pt = POINT::default();
    if unsafe { GetCursorPos(&mut pt) }.is_ok() {
        asked.push((unsafe { WindowFromPoint(pt) }, Role::UnderPointer));
    }
    let mut seen = Vec::with_capacity(2);
    for (hwnd, role) in asked {
        if hwnd.0.is_null() {
            continue;
        }
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
        if pid == 0 || pid == me || seen.contains(&pid) {
            continue;
        }
        seen.push(pid);
        let Some((owner, app)) = owner_of(pid) else { continue };
        if blocks(own, owner) {
            return Some(Blocked { app, role, owner });
        }
    }
    None
}

#[cfg(not(windows))]
pub(crate) fn probe() -> Option<Blocked> {
    None
}

/// This process's own integrity level, read once: it cannot change.
#[cfg(windows)]
pub(crate) fn own_level() -> Option<u32> {
    use std::sync::OnceLock;
    use windows::Win32::System::Threading::GetCurrentProcess;
    static OWN: OnceLock<Option<u32>> = OnceLock::new();
    *OWN.get_or_init(|| match token_level(unsafe { GetCurrentProcess() }) {
        Some(Owner::Level(l)) => Some(l),
        _ => None,
    })
}

#[cfg(not(windows))]
pub(crate) fn own_level() -> Option<u32> {
    None
}

/// The owner of a window's process: its integrity level (or that it would not
/// say) and its file name. `None` when the process cannot be opened at all —
/// gone, or protected — which is "cannot tell", never "blocked".
#[cfg(windows)]
fn owner_of(pid: u32) -> Option<(Owner, String)> {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
    let owner = token_level(process).unwrap_or(Owner::Unreadable);
    let mut buf = [0u16; 1024];
    let mut len = buf.len() as u32;
    let name = unsafe {
        QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len)
    }
    .ok()
    .and_then(|_| app_name(&String::from_utf16_lossy(&buf[..len as usize])));
    unsafe {
        let _ = CloseHandle(process);
    }
    Some((owner, name.unwrap_or_else(|| format!("process {pid}"))))
}

/// The integrity level on a process's token. `Some(Unreadable)` when the token
/// will not open (see `Owner::Unreadable`); `None` when it opened but the label
/// could not be read, which says nothing either way.
#[cfg(windows)]
fn token_level(process: windows::Win32::Foundation::HANDLE) -> Option<Owner> {
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::Security::{
        GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, TokenIntegrityLevel,
        TOKEN_MANDATORY_LABEL, TOKEN_QUERY,
    };
    use windows::Win32::System::Threading::OpenProcessToken;
    let mut token = HANDLE::default();
    if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) }.is_err() {
        return Some(Owner::Unreadable);
    }
    let level = unsafe {
        let mut needed = 0u32;
        let _ = GetTokenInformation(token, TokenIntegrityLevel, None, 0, &mut needed);
        let mut buf = vec![0u8; needed.max(64) as usize];
        let read = GetTokenInformation(
            token,
            TokenIntegrityLevel,
            Some(buf.as_mut_ptr() as *mut _),
            buf.len() as u32,
            &mut needed,
        );
        let level = read.ok().and_then(|_| {
            let label = &*(buf.as_ptr() as *const TOKEN_MANDATORY_LABEL);
            let sid = label.Label.Sid;
            if sid.0.is_null() {
                return None;
            }
            let count = *GetSidSubAuthorityCount(sid);
            if count == 0 {
                return None;
            }
            Some(*GetSidSubAuthority(sid, u32::from(count) - 1))
        });
        let _ = CloseHandle(token);
        level
    };
    level.map(Owner::Level)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_elevated_window_blocks_a_medium_agent() {
        assert!(blocks(IL_MEDIUM, Owner::Level(IL_HIGH)));
        assert!(blocks(IL_MEDIUM, Owner::Level(IL_SYSTEM)));
        assert!(blocks(IL_MEDIUM, Owner::Unreadable));
    }

    #[test]
    fn equal_or_lower_never_blocks() {
        assert!(!blocks(IL_MEDIUM, Owner::Level(IL_MEDIUM)));
        assert!(!blocks(IL_MEDIUM, Owner::Level(0x1000)));
        assert!(!blocks(IL_HIGH, Owner::Level(IL_HIGH)));
    }

    #[test]
    fn a_system_agent_reaches_everything_and_never_reports() {
        assert!(!blocks(IL_SYSTEM, Owner::Level(IL_SYSTEM)));
        assert!(!blocks(IL_SYSTEM, Owner::Unreadable));
    }

    #[test]
    fn the_app_name_is_the_file_name_only() {
        assert_eq!(app_name(r"C:\Valheim\valheim.exe").as_deref(), Some("valheim.exe"));
        assert_eq!(app_name("/usr/bin/foo").as_deref(), Some("foo"));
        assert_eq!(app_name(r"C:\Users\someone\x\Taskmgr.exe").as_deref(), Some("Taskmgr.exe"));
        assert_eq!(app_name(""), None);
        assert_eq!(app_name(r"C:\dir\"), None);
        // Control characters cannot reach a log line or the viewer's banner.
        assert_eq!(app_name("a\nb\u{7}.exe").as_deref(), Some("ab.exe"));
        assert_eq!(app_name(&"x".repeat(300)).map(|s| s.len()), Some(64));
    }

    #[test]
    fn the_log_speaks_only_on_change() {
        let mut log = ReachLog::default();
        let valheim = Blocked { app: "valheim.exe".into(), role: Role::Foreground, owner: Owner::Level(IL_HIGH) };
        assert_eq!(log.observe(None, IL_MEDIUM), None, "nothing blocked from the start: silent");
        let line = log.observe(Some(&valheim), IL_MEDIUM).expect("the block starting is logged");
        assert!(line.contains("valheim.exe") && line.contains("the window in front"), "{line}");
        assert!(line.contains("High") && line.contains("Medium"), "{line}");
        assert_eq!(log.observe(Some(&valheim), IL_MEDIUM), None, "the same block a second later: silent");
        let under = Blocked { role: Role::UnderPointer, ..valheim.clone() };
        assert!(log.observe(Some(&under), IL_MEDIUM).is_some(), "a different role is a change");
        assert!(log.observe(None, IL_MEDIUM).expect("the block ending is logged").contains("again"));
        assert_eq!(log.observe(None, IL_MEDIUM), None);
    }

    #[test]
    fn only_a_hidden_and_confined_pointer_is_captured() {
        use puca_input::ClipRect;
        let virt = ClipRect { left: 0, top: 0, right: 1920, bottom: 1080 };
        let game = ClipRect { left: 640, top: 300, right: 1280, bottom: 660 };
        assert!(captured(true, game, virt), "a game in mouse-look: hidden and confined");
        assert!(!captured(false, game, virt), "a windowed game's menu: confined, pointer showing");
        assert!(!captured(true, virt, virt), "a video player: hidden, no clip in force");
        assert!(!captured(false, virt, virt));
    }

    /// The probe on THIS machine. It must not report the foreground window of
    /// whoever runs the tests as blocked unless it really is above us, so the
    /// only firm claim is about our own level: a test process is never above
    /// System, and on Windows it can read itself.
    #[cfg(windows)]
    #[test]
    fn this_process_can_read_its_own_level() {
        let own = own_level().expect("a process can always read its own token");
        assert!((0x1000..=IL_SYSTEM).contains(&own), "unexpected integrity RID 0x{own:x}");
    }
}
