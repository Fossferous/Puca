//! Input injection and display geometry for Puca.
//!
//! Extracted from the Tauri app so the desktop shell AND the native host agent
//! consume ONE implementation. Duplicating it would mean two copies of the
//! scan-code table, the held-key tracking and `release_all` — and a divergence
//! there is the kind that strands a key down in someone else's application.
//!
//! Deliberately free of any Tauri dependency: the agent has no webview and no
//! `AppHandle`. The physical-input kill switch stays in the app precisely
//! because it emits Tauri events; everything here is plain OS calls.
//!
//! Consumed as a plain PATH dependency rather than via a Cargo workspace — a
//! workspace would change the build layout the container deploy in CLAUDE.md
//! depends on.

pub mod desktop;

/// Reading the text caret's position, for the viewer's typing camera.
///
/// Behind a default-off feature because `frontend/src-tauri` depends on this
/// crate as well and never asks a caret question — see the `caret` feature in
/// Cargo.toml.
#[cfg(feature = "caret")]
pub mod caret;

use serde::{Deserialize, Serialize};
use std::sync::Mutex;

/// One input event from the controlling viewer. `t` is the discriminator;
/// coordinates in `Move` are normalized 0..1 over the shared surface.
#[derive(Debug, Deserialize)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum ControlInput {
    /// Absolute pointer move, normalized to the shared screen (0..1).
    Move { x: f64, y: f64 },
    /// Relative pointer move in HOST screen pixels — for first-person games
    /// that read mouse deltas via raw input. Driven by pointer-lock on the
    /// viewer, which pre-scales its CSS-pixel deltas (letterbox-corrected,
    /// plus user sensitivity) before sending.
    Rmove { dx: f64, dy: f64 },
    /// Mouse button press. `button` uses DOM order: 0=left, 1=middle, 2=right.
    Down { button: u8 },
    /// Mouse button release.
    Up { button: u8 },
    /// Wheel scroll. Positive `dy` scrolls up/away (Windows convention).
    Wheel { dy: f64 },
    /// Key press/release, keyed by `KeyboardEvent.code` (physical/position based).
    Key { code: String, down: bool },
    /// Literal text, as typed on a soft keyboard.
    ///
    /// SEPARATE FROM `Key` ON PURPOSE, not a convenience wrapper. `Key` is
    /// PHYSICAL — a `KeyboardEvent.code` naming a position on a US keyboard,
    /// injected as a hardware scan code so games that read raw input see it. An
    /// Android IME does not produce those. It reports `keyCode` 229 for every
    /// character and delivers the actual text through composition events,
    /// because what the user typed may be a prediction, an autocorrection, an
    /// emoji, or a character with no key at all. There is no scan code to send.
    ///
    /// So this arrives as text and is injected as text.
    ///
    /// On Windows `KEYEVENTF_UNICODE` delivers the character itself and a held
    /// modifier genuinely cannot change it. X11 has no equivalent — XTEST
    /// drives keycodes through the server's normal modifier processing — so
    /// there the host's own modifier state DOES apply, and a shifted character
    /// is typed by pressing Shift explicitly. The two platforms are therefore
    /// not identical, and claiming otherwise here (this comment used to) hides
    /// a real difference in what the same keystroke produces.
    Text { text: String },
    /// Raise the Secure Attention Sequence — what pressing Ctrl+Alt+Del does.
    ///
    /// ITS OWN EVENT BECAUSE IT IS NOT A KEYSTROKE, and pretending otherwise is
    /// what shipped: the controller sent six ordinary `Key` frames
    /// (ControlLeft/AltLeft/Delete, down then up), `SendInput` inserted all six
    /// and returned 1 for each, and NOTHING HAPPENED. win32k's SAS recogniser
    /// reads the raw hardware stream and ignores injected keys by design — that
    /// is the point of a *secure* attention sequence, and no amount of scan-code
    /// fidelity gets past it. So the agent answered `Ok`, the viewer showed no
    /// error, and the button was a decoration.
    ///
    /// The only supported way is `SendSAS` from a LocalSystem process with the
    /// `SoftwareSASGeneration` policy set. That is the caller's problem, not
    /// this crate's: see the Windows arm of [`inject`], which returns
    /// [`SAS_NEEDS_SERVICE`] rather than a comfortable `Ok(())`.
    Sas,
}

/// The exact message [`inject`] returns for [`ControlInput::Sas`] on Windows.
///
/// A NAMED CONSTANT so the test below can pin its exact text. `puca-agent`
/// intercepts `Sas` before it ever reaches `inject` and routes it to the system
/// service, so in the shipped path nobody reads this — but if that interception
/// is ever removed, refactored past, or reached by a path nobody thought of,
/// this is the message the controller sees, and it has to say something a
/// person can act on rather than "unmapped key".
///
/// The one thing it must never be is `Ok(())`. This whole event exists because
/// the previous implementation reported success for something that could not
/// possibly have happened.
pub const SAS_NEEDS_SERVICE: &str =
    "Ctrl+Alt+Del cannot be typed: Windows ignores injected keys for the secure attention \
     sequence by design. It has to be raised by the Puca system service, and this \
     process did not route it there.";

/// Longest run of characters one `Text` event may carry.
///
/// Not a buffer bound — the injection is a loop, so nothing overflows without
/// it. It is a blast radius: a controller that is granted input can already
/// type anything, but it should not be able to do it in one unbounded burst
/// that the host cannot interrupt. A soft keyboard sends a word at a time; a
/// paste large enough to hit this belongs on the clipboard path, which exists.
const MAX_TEXT_CHARS: usize = 256;

/// Shared gate for `ControlInput::Text`, so both host platforms agree on what
/// they will accept. Kept free of any OS call precisely so it can be tested —
/// the injection itself types into whatever window has focus, which is not
/// something a unit test may do.
fn validate_text(text: &str) -> Result<(), String> {
    if text.is_empty() {
        return Err("empty text".into());
    }
    let count = text.chars().count();
    if count > MAX_TEXT_CHARS {
        return Err(format!("text of {count} characters exceeds the {MAX_TEXT_CHARS} limit"));
    }
    // NO CONTROL CHARACTERS. `KEYEVENTF_UNICODE` types a carriage return as a
    // real Enter, a tab as a real Tab, and an escape as a real Escape — so a
    // pasted string could submit a form or run a line in whatever terminal
    // happened to have focus, as a side effect of what the user thought was
    // typing. Enter and Tab are available deliberately, as their own events on
    // the `Key` path, which is filtered by an allowlist; text must not be a
    // second, looser way to reach the same keys. Nothing the client produces
    // contains these: a single-line field cannot hold one.
    if let Some(c) = text.chars().find(|c| c.is_control()) {
        return Err(format!("text contains the control character {:?}", c));
    }
    Ok(())
}

/// Bounds of the monitor the viewer is watching, in virtual-desktop pixels
/// (secondary monitors can be NEGATIVE), plus the whole virtual desktop. The
/// host sends this at grant time so absolute moves map to the right screen — a
/// primary-monitor-only assumption breaks on multi-monitor setups.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct TargetMonitor {
    pub left: i32,
    pub top: i32,
    pub width: i32,
    pub height: i32,
    pub virt_left: i32,
    pub virt_top: i32,
    pub virt_width: i32,
    pub virt_height: i32,
}

/// One monitor's bounds in virtual-desktop pixels (left/top can be negative).
#[derive(Debug, Clone, Serialize)]
pub struct MonitorInfo {
    pub index: usize,
    pub left: i32,
    pub top: i32,
    pub width: i32,
    pub height: i32,
    pub scale: f64,
    pub primary: bool,
    /// `HMONITOR` as a raw handle value; 0 when unknown (non-Windows).
    ///
    /// The JOIN KEY to the capture crate's `OutputInfo::hmonitor`. This list is
    /// in GDI order and capture indexes in DXGI order, and those orders are
    /// unrelated — so "monitor 2" in one is not "monitor 2" in the other, and
    /// pairing them by position aimed injected input at the wrong screen. The
    /// handle identifies the same physical display in both.
    #[serde(default)]
    pub hmonitor: isize,
}

/// All monitors plus the virtual-desktop origin/size, for the host to choose
/// which screen the capture maps to and build a `TargetMonitor`.
#[derive(Debug, Clone, Serialize)]
pub struct MonitorList {
    pub monitors: Vec<MonitorInfo>,
    pub virt_left: i32,
    pub virt_top: i32,
    pub virt_width: i32,
    pub virt_height: i32,
}

// Pressed-state tracking so we can release everything on revoke/timeout/
// disconnect/exit (prevents stuck keys/buttons), and dedupe repeated presses so
// a flood of down-events can't amplify. Scancodes for keys, DOM codes for buttons.
static PRESSED_KEYS: Mutex<Vec<u16>> = Mutex::new(Vec::new());
static PRESSED_BUTTONS: Mutex<Vec<u8>> = Mutex::new(Vec::new());
static TARGET: Mutex<Option<TargetMonitor>> = Mutex::new(None);

/// Set (or clear, with None) the monitor the injected absolute moves map onto.
pub fn set_target(target: Option<TargetMonitor>) {
    if let Ok(mut t) = TARGET.lock() {
        *t = target;
    }
}

/// The current target monitor, for the platform backends. `TargetMonitor` is
/// `Copy`, so this hands back a snapshot rather than holding the lock across an
/// injection -- an OS call under a global lock is how input paths deadlock.
#[allow(dead_code)]
pub(crate) fn current_target() -> Option<TargetMonitor> {
    TARGET.lock().ok().and_then(|t| *t)
}

/// One axis-aligned rectangle in the same pixel space `TargetMonitor` uses
/// (left/top inclusive, right/bottom exclusive — the Win32 RECT convention).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClipRect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl ClipRect {
    pub fn intersects(&self, other: &ClipRect) -> bool {
        self.left < other.right
            && other.left < self.right
            && self.top < other.bottom
            && other.top < self.bottom
    }
}

/// Does a cursor clip make the CONTROLLED monitor unreachable?
///
/// The failure this names: a fullscreen game on one screen calls `ClipCursor`
/// around its own window, and every injected absolute move onto a DIFFERENT
/// screen gets clamped back inside the game — the viewer's clicks land in the
/// game, or nowhere, with no error anywhere. `SendInput` reports success; the
/// OS applies the clamp after the fact.
///
/// The rule is deliberately narrow, in the safe direction:
/// - `clip == virt` is Windows' way of saying "no clip in force"
///   (`GetClipCursor` hands back the whole virtual screen) — never a conflict.
/// - A clip that OVERLAPS the watched monitor at all is not flagged: a game
///   clipping to its own window ON the controlled screen still lets the
///   pointer reach (part of) what the viewer is looking at, and flagging it
///   would put a scary banner over every fullscreen game someone remotes into
///   deliberately. Only a clip entirely elsewhere — pointer provably unable to
///   reach any pixel the viewer can see — is a conflict.
///
/// Pure and OS-free so it can be table-tested; `cursor_clip_conflict_for` is
/// the thin OS shim that feeds it.
pub fn monitor_unreachable_under_clip(clip: ClipRect, monitor: ClipRect, virt: ClipRect) -> bool {
    if clip == virt {
        return false;
    }
    // A monitor rect that does not intersect the desktop at all is a STALE
    // snapshot (the screen was unplugged or re-arranged since the stream
    // aimed at it) — unknowable, and unknowable must never become a banner.
    if !monitor.intersects(&virt) {
        return false;
    }
    !clip.intersects(&monitor)
}

/// Read the live clip state against ONE monitor — the one the asking
/// SESSION streams, not the process-global input target (two concurrent
/// sessions stream different screens, and the global answers only for
/// whichever aimed last).
///
/// `false` on every unknowable path (the OS call failing, stale geometry):
/// this feeds a banner asserting the machine is unreachable, and a probe
/// hiccup must not paste that over a working session. The monitor rect and
/// `GetClipCursor` come from the SAME process's GDI coordinate space — the
/// target was built from this process's own `list_monitors` — so DPI
/// virtualization cancels out. The virtual-screen rect is read LIVE
/// (`GetSystemMetrics`), never from the target snapshot: a display change
/// makes the snapshot stale, and a stale `virt` broke the "no clip in
/// force" equality — the unplugged-monitor false banner.
///
/// Cheap enough for its caller's cadence (the app's 1 Hz `session_status`
/// poll): two `user32` reads, no allocation. Do not call it per input event.
#[cfg(windows)]
pub fn cursor_clip_conflict_for(t: TargetMonitor) -> bool {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetClipCursor, GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN,
        SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
    };
    let mut r = windows::Win32::Foundation::RECT::default();
    if unsafe { GetClipCursor(&mut r) }.is_err() {
        return false;
    }
    let clip = ClipRect { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    let monitor = ClipRect {
        left: t.left,
        top: t.top,
        right: t.left.saturating_add(t.width),
        bottom: t.top.saturating_add(t.height),
    };
    let (vl, vt, vw, vh) = unsafe {
        (
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
            GetSystemMetrics(SM_CXVIRTUALSCREEN),
            GetSystemMetrics(SM_CYVIRTUALSCREEN),
        )
    };
    let virt =
        ClipRect { left: vl, top: vt, right: vl.saturating_add(vw), bottom: vt.saturating_add(vh) };
    monitor_unreachable_under_clip(clip, monitor, virt)
}

#[cfg(not(windows))]
pub fn cursor_clip_conflict_for(_t: TargetMonitor) -> bool {
    // No ClipCursor equivalent is read on other platforms; "no conflict" is
    // the honest default, matching how session_status answers elsewhere.
    false
}

#[cfg(windows)]
mod win {
    use super::TargetMonitor;
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYEVENTF_EXTENDEDKEY,
        KEYEVENTF_KEYUP,
        KEYEVENTF_SCANCODE, KEYEVENTF_UNICODE, MOUSEINPUT, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_LEFTDOWN,
        MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MOVE,
        MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_VIRTUALDESK, MOUSEEVENTF_WHEEL,
        MOUSE_EVENT_FLAGS,
    };

    pub fn send(input: INPUT) -> bool {
        unsafe { SendInput(&[input], std::mem::size_of::<INPUT>() as i32) == 1 }
    }

    fn mouse(dx: i32, dy: i32, data: i32, flags: MOUSE_EVENT_FLAGS) -> INPUT {
        INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx,
                    dy,
                    mouseData: data as u32,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    /// Absolute move to normalized (0..1) position, mapped onto `target` if set
    /// (virtual-desktop coords, handles negative origins) else the primary monitor.
    pub fn move_abs(x: f64, y: f64, target: Option<TargetMonitor>) -> INPUT {
        let x = x.clamp(0.0, 1.0);
        let y = y.clamp(0.0, 1.0);
        match target {
            Some(m) if m.virt_width > 1 && m.virt_height > 1 => {
                let px = m.left as f64 + x * m.width as f64;
                let py = m.top as f64 + y * m.height as f64;
                let ax = ((px - m.virt_left as f64) * 65535.0 / (m.virt_width as f64 - 1.0))
                    .round()
                    .clamp(0.0, 65535.0) as i32;
                let ay = ((py - m.virt_top as f64) * 65535.0 / (m.virt_height as f64 - 1.0))
                    .round()
                    .clamp(0.0, 65535.0) as i32;
                mouse(ax, ay, 0, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK)
            }
            _ => {
                let nx = (x * 65535.0).round() as i32;
                let ny = (y * 65535.0).round() as i32;
                mouse(nx, ny, 0, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE)
            }
        }
    }

    // MOUSEEVENTF_MOVE_NOCOALESCE (0x2000) isn't re-exported by every
    // windows-rs version. It stops Windows from merging queued injected moves —
    // raw-input games sample each motion event, and coalescing loses deltas.
    const MOUSEEVENTF_MOVE_NOCOALESCE: MOUSE_EVENT_FLAGS = MOUSE_EVENT_FLAGS(0x2000);

    pub fn move_rel(dx: i32, dy: i32) -> INPUT {
        mouse(dx, dy, 0, MOUSEEVENTF_MOVE | MOUSEEVENTF_MOVE_NOCOALESCE)
    }

    pub fn wheel(dy: i32) -> INPUT {
        mouse(0, 0, dy, MOUSEEVENTF_WHEEL)
    }

    pub fn button(dom: u8, down: bool) -> Option<INPUT> {
        let flag = match (dom, down) {
            (0, true) => MOUSEEVENTF_LEFTDOWN,
            (0, false) => MOUSEEVENTF_LEFTUP,
            (1, true) => MOUSEEVENTF_MIDDLEDOWN,
            (1, false) => MOUSEEVENTF_MIDDLEUP,
            (2, true) => MOUSEEVENTF_RIGHTDOWN,
            (2, false) => MOUSEEVENTF_RIGHTUP,
            _ => return None,
        };
        Some(mouse(0, 0, 0, flag))
    }

    /// One UTF-16 code unit as a literal character.
    ///
    /// `KEYEVENTF_UNICODE` makes `wScan` a character rather than a scan code,
    /// which is the only way to type something with no key on the layout.
    pub fn unicode(unit: u16, down: bool) -> INPUT {
        let mut flags = KEYEVENTF_UNICODE;
        if !down {
            flags |= KEYEVENTF_KEYUP;
        }
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY(0),
                    wScan: unit,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    /// Every keyboard event needed to type `text`, in order.
    ///
    /// Split out from `inject` so the construction can be tested: injecting it
    /// types into whatever window has focus, which a unit test may not do.
    pub fn text_batch(text: &str) -> Vec<INPUT> {
        let mut batch = Vec::with_capacity(text.len() * 2);
        for unit in text.encode_utf16() {
            batch.push(unicode(unit, true));
            batch.push(unicode(unit, false));
        }
        batch
    }

    /// Send a whole batch in ONE call.
    ///
    /// Required, not an optimisation: a character outside the basic plane is
    /// two UTF-16 units and Windows only recombines them into one character
    /// when they arrive in the same `SendInput` array. Sent one at a time an
    /// emoji becomes two replacement characters.
    pub fn send_many(inputs: &[INPUT]) -> bool {
        if inputs.is_empty() {
            return true;
        }
        unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) as usize == inputs.len() }
    }

    /// Key event by hardware scan code (games often ignore VK-only injection).
    ///
    /// `extended` SETS `KEYEVENTF_EXTENDEDKEY`, and never setting it was a real,
    /// visible bug for the eighteen keys in `EXTENDED_CODES`. A PC keyboard
    /// distinguishes the grey editing cluster from the numeric keypad ONLY by an
    /// `E0` prefix byte in front of an otherwise identical scan code: Delete and
    /// the numpad `.` are both `0x53`, Home and numpad `7` are both `0x47`, and
    /// so on for Insert/End/PageUp/PageDown/the four arrows/right Control/right
    /// Alt/numpad `/`/numpad Enter/PrintScreen. So the remote "Delete" key was
    /// arriving as the keypad decimal point — which with NumLock on types a `.`,
    /// and with it off is a second Delete only by coincidence of the layout.
    ///
    /// `wScan` still carries the LOW byte only; the prefix rides in the flag.
    pub fn key(scan: u16, extended: bool, down: bool) -> INPUT {
        let mut flags = KEYEVENTF_SCANCODE;
        if extended {
            flags |= KEYEVENTF_EXTENDEDKEY;
        }
        if !down {
            flags |= KEYEVENTF_KEYUP;
        }
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY(0),
                    wScan: scan,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }
}

/// The `E0` prefix byte a PC keyboard puts in front of an extended scan code.
///
/// `MAPVK_VK_TO_VSC_EX` returns it in the HIGH byte of its answer; `SendInput`
/// wants it as `KEYEVENTF_EXTENDEDKEY` instead, with only the low byte in
/// `wScan`. This constant is the bridge between the two representations and is
/// used by both `extended_from_mapping` and `pack_key`.
#[cfg(windows)]
const E0_PREFIX: u32 = 0xE000;

/// Decode `MAPVK_VK_TO_VSC_EX`'s answer into (scan code, extended?).
///
/// PURE, taking the raw mapping rather than a virtual key, so every case
/// including the ones this machine's layout does not have can be exercised
/// without calling into win32k at all.
///
/// `None` means "no scan code", which the caller must report rather than send:
/// a zero scan code is a keystroke Windows will accept and silently do nothing
/// with.
///
/// THE `0xE1` CASE IS DELIBERATELY NOT EXTENDED. Pause is the one key whose make
/// code is a three-code sequence (`E1 1D 45`), and no single `KEYBDINPUT`
/// expresses it — treating `E1` as `E0` would send `0x1D`, which is Control, and
/// dropping the prefix would send `0x45`, which is NumLock. So it falls through
/// to the plain mapping, which for `VK_PAUSE` is `0` (MEASURED — see
/// `the_mapping_decode_handles_every_prefix_windows_can_return`), i.e. the same
/// honest "no scan code for Pause" this crate has always returned. Pause over
/// remote control is unimplemented, not silently wrong.
#[cfg(windows)]
fn extended_from_mapping(mapping_ex: u32, mapping_plain: u32) -> Option<(u16, bool)> {
    if mapping_ex & 0xFF00 == E0_PREFIX {
        let scan = (mapping_ex & 0xFF) as u16;
        if scan != 0 {
            return Some((scan, true));
        }
    }
    let plain = (mapping_plain & 0xFF) as u16;
    if plain == 0 {
        return None;
    }
    Some((plain, false))
}

/// The scan code and extended flag Windows's own mapping reports for `vk`.
///
/// Split from `inject` so it can be checked without injecting anything:
/// `MapVirtualKeyW` is a lookup, not an action, so unlike `SendInput` it is safe
/// to call from a unit test on a machine somebody is using.
#[cfg(windows)]
fn scan_for_vk(vk: u16) -> Option<(u16, bool)> {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        MapVirtualKeyW, MAPVK_VK_TO_VSC, MAPVK_VK_TO_VSC_EX,
    };
    let ex = unsafe { MapVirtualKeyW(vk as u32, MAPVK_VK_TO_VSC_EX) };
    let plain = unsafe { MapVirtualKeyW(vk as u32, MAPVK_VK_TO_VSC) };
    extended_from_mapping(ex, plain)
}

/// DOM codes that must be injected with the `E0` prefix, and — for the one key
/// whose scan code Windows also gets wrong for this purpose — what to send.
///
/// A TABLE RATHER THAN A QUERY, BECAUSE THE OS CANNOT ANSWER THIS. Measured on
/// Windows 11 26200 with `MAPVK_VK_TO_VSC_EX`, the flag that is supposed to
/// report the prefix:
///
/// ```text
///   VK_DELETE   -> 0x0053     VK_DECIMAL -> 0x0053      (identical!)
///   VK_HOME     -> 0x0047     VK_NUMPAD7 -> 0x0047      (identical!)
///   VK_INSERT   -> 0x0052     VK_UP      -> 0x0048      (no prefix)
///   VK_RCONTROL -> 0xE01D     VK_RMENU   -> 0xE038      VK_DIVIDE -> 0xE035
/// ```
///
/// So the mapping carries the prefix for the right-hand modifiers and the numpad
/// slash, and NOT for the grey editing cluster or the arrows — where the entire
/// difference from the keypad IS the prefix. Deriving the flag from the mapping
/// alone would have fixed those three and left the other twelve still typing
/// their keypad twins, which is the bug being fixed: remote "Delete" arrived as
/// numpad `.` and typed a full stop with NumLock on.
///
/// Extended-ness is a property of the PHYSICAL KEY and `KeyboardEvent.code` is a
/// physical-key name, so the code is the right thing to key this on — and the
/// table can then be checked without a keyboard, a desktop, or win32k.
#[cfg(windows)]
const EXTENDED_CODES: &[(&str, Option<u16>)] = &[
    ("Insert", None),
    ("Delete", None),
    ("Home", None),
    ("End", None),
    ("PageUp", None),
    ("PageDown", None),
    ("ArrowUp", None),
    ("ArrowDown", None),
    ("ArrowLeft", None),
    ("ArrowRight", None),
    // Already prefixed by the mapping; listed anyway so the whole set is stated
    // in one place rather than half here and half in an OS behaviour.
    ("ControlRight", None),
    ("AltRight", None),
    ("MetaLeft", None),
    ("MetaRight", None),
    ("ContextMenu", None),
    ("NumpadDivide", None),
    // `Enter` and `NumpadEnter` share `VK_RETURN` (see `code_to_vk`), so the
    // virtual key cannot distinguish them at all. The numpad one is `E0 1C`.
    ("NumpadEnter", None),
    // THE ONE SCAN-CODE OVERRIDE. `MapVirtualKeyW` answers `0x54` for
    // `VK_SNAPSHOT`, which is SysRq — what a keyboard sends for
    // Alt+PrintScreen — and `E0 54` is not a key at all. Plain PrintScreen is
    // `E0 37`.
    ("PrintScreen", Some(0x37)),
];

/// The scan code and `E0` flag to inject for `code`, given the OS mapping.
///
/// PURE: the OS answer is a parameter, so every row of [`EXTENDED_CODES`] is
/// exercisable off-device. A code not in the table keeps whatever the mapping
/// said, which is how the right-hand modifiers stay correct on their own.
#[cfg(windows)]
fn scan_and_prefix(code: &str, mapped: (u16, bool)) -> (u16, bool) {
    match EXTENDED_CODES.iter().find(|(c, _)| *c == code) {
        Some((_, override_scan)) => (override_scan.unwrap_or(mapped.0), true),
        None => mapped,
    }
}

/// The key identity `PRESSED_KEYS` tracks: scan code plus its `E0` prefix.
///
/// THE PREFIX IS PART OF THE IDENTITY, not decoration. Delete is `E0 53` and the
/// numpad decimal point is `53`; tracking the low byte alone would mean holding
/// Delete swallowed a numpad `.` as a duplicate, and `release_all` would release
/// the wrong one of the pair — leaving a key physically stuck down on somebody
/// else's machine, which is the exact failure this map exists to prevent.
#[cfg(windows)]
fn pack_key(scan: u16, extended: bool) -> u16 {
    if extended {
        E0_PREFIX as u16 | scan
    } else {
        scan
    }
}

/// Inverse of [`pack_key`], for `release_all`.
#[cfg(windows)]
fn unpack_key(packed: u16) -> (u16, bool) {
    (packed & 0x00FF, packed as u32 & 0xFF00 == E0_PREFIX)
}

/// Turn `SendInput`'s return into an answer the caller can act on, with an
/// optional note on what `follow_input_desktop` did.
///
/// SendInput reports how many events it actually inserted, and it returns 0 in
/// exactly the cases that matter most for remote control: the calling thread is
/// not attached to the desktop that currently owns input — a UAC prompt, the
/// lock screen, the sign-in screen — or UIPI blocked the event because the
/// foreground window runs at a higher integrity level than this process.
///
/// Six call sites in `inject` discarded it with `let _ =`, so every one of those
/// became a silent no-op that `Response::Ok` reported to the controller as
/// success. That is the worst available answer while somebody is typing a
/// password into a screen they can see but not affect: the keystrokes vanish and
/// nothing anywhere says so. `Text` alone got this right, which is what made the
/// omission look deliberate rather than missed.
///
/// `release_all` deliberately keeps `let _ =`: it is best-effort teardown with
/// no caller left to tell, and one failure there must not stop the remaining
/// keys being released.
///
/// `follow` IS A SEPARATE PARAMETER RATHER THAN FOLDED INTO `what`: this
/// process's own eprintln! diagnostics (`sent_following`'s "followed the input
/// desktop to '{name}', retrying") do not reach anywhere visible in
/// production — the agent has no console, and the SERVICE only ever sees the
/// FINAL error string relayed back over the pipe. Every prior refusal on the
/// sign-in screen showed only "Windows refused the injected pointer move" in
/// service.log, with no way to tell whether `follow_input_desktop` was ever
/// even attempted, let alone what it reported. Putting that detail INTO the
/// error string is the only way it reaches a log a person can read.
#[cfg(windows)]
fn sent_detail(
    ok: bool,
    what: &str,
    follow: Option<&Result<String, String>>,
    last_error: Option<u32>,
) -> Result<(), String> {
    if ok {
        return Ok(());
    }
    let detail = match follow {
        None => " (no retry was attempted)".to_string(),
        Some(Ok(name)) => format!(" (followed the input desktop to '{name}', but the retry was STILL refused)"),
        Some(Err(e)) => format!(" (could not follow the input desktop: {e})"),
    };
    // GetLastError, READ AT THE CALL SITE, immediately after SendInput
    // returned 0 — this is the actual experiment. `5` (ERROR_ACCESS_DENIED)
    // confirms the calling thread lacks a desktop access right (see
    // desktop.rs's DESKTOP_JOURNALPLAYBACK fix); anything else, especially
    // `0`, means the refusal is UIPI blocking silently rather than a
    // fixable access-rights gap, and this approach needs rethinking.
    let code = match last_error {
        Some(0) | None => String::new(),
        Some(c) => format!(" GetLastError={c}."),
    };
    Err(format!(
        "Windows refused the injected {what}{detail}.{code} The usual cause is that the \
         screen showing right now is one this process cannot reach — a security \
         prompt, the lock screen, or a window running as administrator."
    ))
}

/// Send, and if Windows refuses, follow the input desktop and send once more.
///
/// THE RETRY IS THE WHOLE MECHANISM, not a papering-over. A zero from SendInput
/// here means the desktop that owns input changed under this thread — someone
/// raised a UAC prompt, or locked the machine. Attaching to it and repeating the
/// event is the correct response and costs microseconds.
///
/// Attaching ON REFUSAL rather than on a timer is deliberate: this path runs at
/// pointer rate, and polling OpenInputDesktop on every event would pay a kernel
/// call to answer a question whose answer almost never changes. The refusal IS
/// the notification, and it is exact rather than sampled.
///
/// EXACTLY ONE retry. A loop would turn a genuinely refused event — UIPI, a
/// higher-integrity foreground window, or a user-token agent that must not touch
/// the secure desktop at all — into a spin at pointer rate. If the second
/// attempt fails the caller is told, which is what the controller needs to say
/// something true.
#[cfg(windows)]
fn sent_following(send: impl Fn() -> bool, what: &str) -> Result<(), String> {
    if send() {
        return Ok(());
    }
    let follow = crate::desktop::follow_input_desktop();
    match &follow {
        Ok(name) => {
            eprintln!("[input] refused; followed the input desktop to '{name}', retrying");
            let ok = send();
            // READ IMMEDIATELY: GetLastError is only valid until the next
            // Win32 call on this thread, and `send()` itself is the only
            // Win32 call between the refusal and this read.
            let err = if ok {
                None
            } else {
                Some(unsafe { windows::Win32::Foundation::GetLastError() }.0)
            };
            sent_detail(ok, what, Some(&follow), err)
        }
        // The retry still happens, but the ORIGINAL refusal is what leads the
        // message — "this process cannot reach that screen" is the useful
        // sentence, and a user-token agent failing to open Winlogon is the
        // EXPECTED case, not a second fault. The attach failure now rides
        // along as detail rather than being dropped, per sent_detail's doc.
        Err(_) => sent_detail(false, what, Some(&follow), None),
    }
}

#[cfg(windows)]
pub fn inject(event: ControlInput) -> Result<(), String> {
    match event {
        ControlInput::Move { x, y } => {
            if !x.is_finite() || !y.is_finite() {
                return Err("non-finite coordinate".into());
            }
            let target = TARGET.lock().ok().and_then(|t| *t);
            sent_following(|| win::send(win::move_abs(x, y, target)), "pointer move")
        }
        ControlInput::Rmove { dx, dy } => {
            if !dx.is_finite() || !dy.is_finite() {
                return Err("non-finite delta".into());
            }
            // Sanity bound on the TOTAL: a hostile payload still can't fling the
            // cursor arbitrarily far in one event.
            if dx.abs() > 100_000.0 || dy.abs() > 100_000.0 {
                return Err("relative delta out of bounds".into());
            }
            // Split a large delta into sequential <=4000px steps instead of
            // clamping — with viewer-side scaling a legitimate fast flick can
            // exceed one step, and clipping it would shorten the turn.
            const STEP: i64 = 4000;
            let mut dx = dx.round() as i64;
            let mut dy = dy.round() as i64;
            while dx != 0 || dy != 0 {
                let sx = dx.clamp(-STEP, STEP);
                let sy = dy.clamp(-STEP, STEP);
                // Stop at the first refused step. Grinding through the rest
                // would send a flick the OS is discarding anyway and then
                // report the whole gesture as delivered.
                sent_following(|| win::send(win::move_rel(sx as i32, sy as i32)), "pointer move")?;
                dx -= sx;
                dy -= sy;
            }
            Ok(())
        }
        ControlInput::Wheel { dy } => {
            if !dy.is_finite() {
                return Err("non-finite wheel".into());
            }
            sent_following(|| win::send(win::wheel(dy.round().clamp(-3000.0, 3000.0) as i32)), "scroll")
        }
        ControlInput::Down { button } => {
            if button > 2 {
                return Ok(());
            }
            // Dedupe: ignore a press for an already-held button.
            if let Ok(mut b) = PRESSED_BUTTONS.lock() {
                if b.contains(&button) {
                    return Ok(());
                }
                b.push(button);
            }
            if let Some(i) = win::button(button, true) {
                return sent_following(|| win::send(i), "button press");
            }
            Ok(())
        }
        ControlInput::Up { button } => {
            if button > 2 {
                return Ok(());
            }
            // Only release a button we recorded as down.
            if let Ok(mut b) = PRESSED_BUTTONS.lock() {
                if let Some(pos) = b.iter().position(|x| *x == button) {
                    b.swap_remove(pos);
                } else {
                    return Ok(());
                }
            }
            if let Some(i) = win::button(button, false) {
                return sent_following(|| win::send(i), "button release");
            }
            Ok(())
        }
        ControlInput::Key { code, down } => {
            let vk = code_to_vk(&code).ok_or_else(|| format!("unmapped key: {code}"))?;
            let mapped = scan_for_vk(vk.0).ok_or_else(|| format!("no scan code for {code}"))?;
            let (scan, extended) = scan_and_prefix(&code, mapped);
            // Tracked by scan code AND prefix: see `pack_key`.
            let held_key = pack_key(scan, extended);
            if let Ok(mut keys) = PRESSED_KEYS.lock() {
                let held = keys.contains(&held_key);
                if down {
                    if held {
                        return Ok(()); // dedupe key repeat
                    }
                    keys.push(held_key);
                } else if let Some(pos) = keys.iter().position(|k| *k == held_key) {
                    keys.swap_remove(pos);
                } else {
                    return Ok(()); // release for a key we never saw down
                }
            }
            sent_following(
                || win::send(win::key(scan, extended, down)),
                if down { "key press" } else { "key release" },
            )
        }
        ControlInput::Text { text } => {
            validate_text(&text)?;
            // Down AND up per unit, all in one batch. Windows composes a
            // surrogate pair only when both halves arrive together, so an emoji
            // sent unit by unit turns into two replacement characters.
            let batch = win::text_batch(&text);
            // THE PATH THAT TYPES THE PIN. An Android soft keyboard reports
            // keyCode 229 for every character and delivers the real text
            // through composition events — see ControlInput::Text's own doc
            // comment — so a phone's PIN entry goes through here, not through
            // Key. This used to call SendInput directly with no desktop-follow
            // retry at all, so it never even attempted to reach Winlogon: the
            // log showed "SendInput rejected the text" with none of the
            // "followed the input desktop" detail every other path produced.
            sent_following(|| win::send_many(&batch), "text")
        }
        // NEVER `Ok(())`, AND NEVER `SendInput`. There is no scan code, no
        // sequence of them, and no flag combination that produces the secure
        // attention sequence from an injected event — win32k reads the SAS out
        // of the raw hardware stream specifically so that this is true. Sending
        // Ctrl, Alt and Delete here would return 1 three times over and do
        // nothing, which is precisely the lie this variant exists to end.
        //
        // The routing lives one layer up, in the agent, because it needs a
        // named pipe and a protocol; this crate is deliberately free of both.
        ControlInput::Sas => Err(SAS_NEEDS_SERVICE.to_string()),
    }
}

/// Release every key/button we currently believe is held. Called on any teardown
/// so a session never leaves input stuck down.
#[cfg(windows)]
pub fn release_all() {
    if let Ok(mut b) = PRESSED_BUTTONS.lock() {
        for button in b.drain(..) {
            if let Some(i) = win::button(button, false) {
                let _ = win::send(i);
            }
        }
    }
    if let Ok(mut keys) = PRESSED_KEYS.lock() {
        for packed in keys.drain(..) {
            // Released with the SAME prefix it was pressed with. A release that
            // dropped the E0 would leave the grey Delete down and lift the
            // numpad decimal point instead — a key stuck on somebody else's
            // machine, which is the one outcome this function exists to avoid.
            let (scan, extended) = unpack_key(packed);
            let _ = win::send(win::key(scan, extended, false));
        }
    }
}

#[cfg(target_os = "linux")]
mod linux_impl;

/// X11 injection via XTEST. See `linux_impl` for what this cannot reach:
/// Wayland clients, the display-manager greeter, and a locked screen.
#[cfg(target_os = "linux")]
pub use linux_impl::{
    clear_stuck_keys, inject, injection_availability, release_all, reset_connection,
};

#[cfg(not(any(windows, target_os = "linux")))]
pub fn inject(_event: ControlInput) -> Result<(), String> {
    Err("Remote control injection is supported on Windows and X11 Linux only".to_string())
}

#[cfg(not(any(windows, target_os = "linux")))]
pub fn release_all() {}

/// Enumerate monitors + the virtual desktop so the host can map the shared
/// surface to the correct screen (multi-monitor, negative coords).
#[cfg(windows)]
pub fn list_monitors() -> MonitorList {
    use windows::Win32::Foundation::{BOOL, LPARAM, RECT, TRUE};
    use windows::Win32::Graphics::Gdi::{
        EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO,
    };
    // MONITORINFOF_PRIMARY (0x1) isn't re-exported by this windows-rs version.
    const MONITORINFOF_PRIMARY: u32 = 0x0000_0001;
    use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
        SM_YVIRTUALSCREEN,
    };

    unsafe extern "system" fn enum_proc(
        hmon: HMONITOR,
        _hdc: HDC,
        _rc: *mut RECT,
        lparam: LPARAM,
    ) -> BOOL {
        let out = &mut *(lparam.0 as *mut Vec<MonitorInfo>);
        let mut mi = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if GetMonitorInfoW(hmon, &mut mi).as_bool() {
            let r = mi.rcMonitor;
            let (mut dpix, mut dpiy) = (96u32, 96u32);
            let _ = GetDpiForMonitor(hmon, MDT_EFFECTIVE_DPI, &mut dpix, &mut dpiy);
            out.push(MonitorInfo {
                index: out.len(),
                left: r.left,
                top: r.top,
                width: r.right - r.left,
                height: r.bottom - r.top,
                scale: dpix as f64 / 96.0,
                primary: mi.dwFlags & MONITORINFOF_PRIMARY != 0,
                hmonitor: hmon.0 as isize,
            });
        }
        TRUE
    }

    let mut monitors: Vec<MonitorInfo> = Vec::new();
    unsafe {
        let _ = EnumDisplayMonitors(
            HDC::default(),
            None,
            Some(enum_proc),
            LPARAM(&mut monitors as *mut _ as isize),
        );
        MonitorList {
            monitors,
            virt_left: GetSystemMetrics(SM_XVIRTUALSCREEN),
            virt_top: GetSystemMetrics(SM_YVIRTUALSCREEN),
            virt_width: GetSystemMetrics(SM_CXVIRTUALSCREEN),
            virt_height: GetSystemMetrics(SM_CYVIRTUALSCREEN),
        }
    }
}

#[cfg(target_os = "linux")]
pub use linux_impl::list_monitors;

#[cfg(not(any(windows, target_os = "linux")))]
pub fn list_monitors() -> MonitorList {
    MonitorList {
        monitors: Vec::new(),
        virt_left: 0,
        virt_top: 0,
        virt_width: 0,
        virt_height: 0,
    }
}

/// Map a `KeyboardEvent.code` string to a Windows virtual key.
#[cfg(windows)]
fn code_to_vk(
    code: &str,
) -> Option<windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY> {
    use windows::Win32::UI::Input::KeyboardAndMouse::*;

    // Letters: "KeyA".. -> 0x41.. (ASCII 'A' == VK_A). Digits: "Digit0".. -> 0x30..
    if let Some(rest) = code.strip_prefix("Key") {
        let b = rest.as_bytes();
        if b.len() == 1 && b[0].is_ascii_uppercase() {
            return Some(VIRTUAL_KEY(b[0] as u16));
        }
    }
    if let Some(rest) = code.strip_prefix("Digit") {
        let b = rest.as_bytes();
        if b.len() == 1 && b[0].is_ascii_digit() {
            return Some(VIRTUAL_KEY(b[0] as u16));
        }
    }
    if let Some(rest) = code.strip_prefix("Numpad") {
        if let Some(d) = rest.parse::<u16>().ok().filter(|d| *d <= 9) {
            return Some(VIRTUAL_KEY(VK_NUMPAD0.0 + d));
        }
    }
    if let Some(rest) = code.strip_prefix('F') {
        if let Ok(n) = rest.parse::<u16>() {
            if (1..=24).contains(&n) {
                return Some(VIRTUAL_KEY(VK_F1.0 + (n - 1)));
            }
        }
    }

    let vk = match code {
        "Space" => VK_SPACE,
        "Enter" | "NumpadEnter" => VK_RETURN,
        "Escape" => VK_ESCAPE,
        "Tab" => VK_TAB,
        "Backspace" => VK_BACK,
        "Delete" => VK_DELETE,
        "Insert" => VK_INSERT,
        "Home" => VK_HOME,
        "End" => VK_END,
        "PageUp" => VK_PRIOR,
        "PageDown" => VK_NEXT,
        "ArrowUp" => VK_UP,
        "ArrowDown" => VK_DOWN,
        "ArrowLeft" => VK_LEFT,
        "ArrowRight" => VK_RIGHT,
        "ShiftLeft" => VK_LSHIFT,
        "ShiftRight" => VK_RSHIFT,
        "ControlLeft" => VK_LCONTROL,
        "ControlRight" => VK_RCONTROL,
        "AltLeft" => VK_LMENU,
        "AltRight" => VK_RMENU,
        // Two keys, not one: the same left/right conflation the extended-key
        // table fixed for ControlRight/AltRight. VK_RWIN is E0 5C; VK_LWIN E0 5B.
        "MetaLeft" => VK_LWIN,
        "MetaRight" => VK_RWIN,
        "CapsLock" => VK_CAPITAL,
        "Minus" => VK_OEM_MINUS,
        "Equal" => VK_OEM_PLUS,
        "BracketLeft" => VK_OEM_4,
        "BracketRight" => VK_OEM_6,
        "Backslash" => VK_OEM_5,
        "Semicolon" => VK_OEM_1,
        "Quote" => VK_OEM_7,
        "Comma" => VK_OEM_COMMA,
        "Period" => VK_OEM_PERIOD,
        "Slash" => VK_OEM_2,
        "Backquote" => VK_OEM_3,
        "NumpadAdd" => VK_ADD,
        "NumpadSubtract" => VK_SUBTRACT,
        "NumpadMultiply" => VK_MULTIPLY,
        "NumpadDivide" => VK_DIVIDE,
        "NumpadDecimal" => VK_DECIMAL,
        // The mobile keyboard overlay's third row. Without these it sent codes
        // that fell through to None, so the agent logged "inject failed" and
        // four visible buttons did nothing. (There is deliberately no "Fn":
        // it is handled in keyboard firmware and has no virtual-key code, so
        // that button was removed rather than mapped.)
        "PrintScreen" => VK_SNAPSHOT,
        "ScrollLock" => VK_SCROLL,
        "Pause" => VK_PAUSE,
        "ContextMenu" => VK_APPS,
        "NumLock" => VK_NUMLOCK,
        _ => return None,
    };
    Some(vk)
}

/// Names of running anti-cheat products (empty if none / non-Windows). The host
/// uses this to refuse control while one is active — injected input there is
/// unreliable and can trigger a ban.
#[cfg(windows)]
pub fn detect_anticheat() -> Vec<String> {
    use sysinfo::System;

    // (process-name substring, product label)
    const KNOWN: &[(&str, &str)] = &[
        ("easyanticheat", "Easy Anti-Cheat"),
        ("beservice", "BattlEye"),
        ("bedaisy", "BattlEye"),
        ("vgc", "Riot Vanguard"),
        ("vgtray", "Riot Vanguard"),
        ("vanguard", "Riot Vanguard"),
        ("faceit", "FACEIT Anti-Cheat"),
        ("gameguard", "nProtect GameGuard"),
        ("xhunter", "XIGNCODE/GameGuard"),
        ("anticheatexpert", "Anti-Cheat Expert"),
        ("ricochet", "Ricochet"),
        ("mhyprot", "mihoyo Anti-Cheat"),
    ];

    let mut sys = System::new();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    let mut found = std::collections::BTreeSet::new();
    for process in sys.processes().values() {
        let name = process.name().to_string_lossy().to_lowercase();
        for (needle, label) in KNOWN {
            if name.contains(needle) {
                found.insert((*label).to_string());
            }
        }
    }
    found.into_iter().collect()
}

#[cfg(target_os = "linux")]
pub use linux_impl::detect_anticheat;

#[cfg(not(any(windows, target_os = "linux")))]
pub fn detect_anticheat() -> Vec<String> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn the_text_path_goes_through_the_desktop_following_retry() {
        // THE PATH THAT TYPES THE PIN, and the one that used to skip the retry
        // entirely. Scanned from source rather than exercised at runtime:
        // actually calling inject(Text) types into whatever window has focus
        // on this machine, which a unit test must not do (see this module's
        // own note on why Text cannot be driven end-to-end here).
        //
        // Scoped to ONLY the non-test half of the file — a self-scan that also
        // reads the test module would find this very assertion's own source
        // text and pass regardless of what the real code does.
        let src = include_str!("lib.rs").split("#[cfg(test)]").next().unwrap();
        let arm_start = src.find("ControlInput::Text { text } =>").expect("the Text arm");
        let arm = &src[arm_start..arm_start + 1100];
        assert!(
            arm.contains("sent_following"),
            "Text must route through the same desktop-follow retry every other \
             input path uses, not call SendInput directly: {arm}"
        );
        assert!(
            !arm.contains("win::send_many(&batch) {"),
            "must not call send_many directly and skip the retry: {arm}"
        );
    }

    /// The clip-conflict rule, one row per way it can be wrong. Geometry: a
    /// two-monitor desktop, primary 0..1920 x 0..1080, secondary to its right
    /// at 1920..3840 x 0..1080, virtual desktop spanning both.
    #[test]
    fn a_clip_is_a_conflict_only_when_the_watched_monitor_is_entirely_outside_it() {
        let virt = ClipRect { left: 0, top: 0, right: 3840, bottom: 1080 };
        let primary = ClipRect { left: 0, top: 0, right: 1920, bottom: 1080 };
        let secondary = ClipRect { left: 1920, top: 0, right: 3840, bottom: 1080 };
        // A game window on the primary, clipping the cursor to itself.
        let game_on_primary = ClipRect { left: 100, top: 100, right: 1820, bottom: 980 };

        assert!(
            !monitor_unreachable_under_clip(virt, secondary, virt),
            "no clip in force (clip == virtual desktop) is the normal state"
        );
        assert!(
            monitor_unreachable_under_clip(game_on_primary, secondary, virt),
            "the viewer watches the secondary; a game holding the pointer on \
             the primary makes every click there impossible — THE conflict"
        );
        assert!(
            !monitor_unreachable_under_clip(game_on_primary, primary, virt),
            "the same game, viewer watching the SAME screen: the pointer can \
             still reach what they see, so no banner — the overlap control"
        );
        // Straddling the shared edge: part of the secondary is reachable.
        let straddle = ClipRect { left: 1800, top: 0, right: 2100, bottom: 1080 };
        assert!(
            !monitor_unreachable_under_clip(straddle, secondary, virt),
            "partial overlap keeps the monitor reachable"
        );
        // Edge-touching without overlap: RECT right/bottom are EXCLUSIVE, so a
        // clip ending exactly at the boundary shares zero pixels.
        let flush_left = ClipRect { left: 0, top: 0, right: 1920, bottom: 1080 };
        assert!(
            monitor_unreachable_under_clip(flush_left, secondary, virt),
            "a clip flush against the boundary shares no pixel with the \
             secondary — still a conflict"
        );
        // A STALE monitor snapshot — the streamed screen was unplugged and
        // its rect no longer intersects the live desktop. Unknowable, and
        // before this guard it read as 'conflict' (the stale rect misses
        // every live clip), blaming a fullscreen app for a missing screen.
        let unplugged = ClipRect { left: 3840, top: 0, right: 5760, bottom: 1080 };
        assert!(
            !monitor_unreachable_under_clip(game_on_primary, unplugged, virt),
            "a monitor outside the live desktop is stale geometry, not a conflict"
        );
    }

    /// The wire shape the controller sends. If serde's mapping drifts, input
    /// silently stops arriving — the session looks connected and does nothing,
    /// which is the hardest failure to diagnose from a bug report.
    #[test]
    fn control_input_parses_the_wire_shape() {
        let move_ev: ControlInput =
            serde_json::from_str(r#"{"t":"move","x":0.25,"y":0.75}"#).unwrap();
        assert!(matches!(move_ev, ControlInput::Move { x, y } if x == 0.25 && y == 0.75));

        let down: ControlInput = serde_json::from_str(r#"{"t":"down","button":2}"#).unwrap();
        assert!(matches!(down, ControlInput::Down { button: 2 }));

        let key: ControlInput =
            serde_json::from_str(r#"{"t":"key","code":"KeyA","down":true}"#).unwrap();
        assert!(matches!(key, ControlInput::Key { ref code, down: true } if code == "KeyA"));

        let wheel: ControlInput = serde_json::from_str(r#"{"t":"wheel","dy":-120.0}"#).unwrap();
        assert!(matches!(wheel, ControlInput::Wheel { dy } if dy == -120.0));

        let text: ControlInput = serde_json::from_str(r#"{"t":"text","text":"hi"}"#).unwrap();
        assert!(matches!(text, ControlInput::Text { ref text } if text == "hi"));
    }

    /// The Ctrl+Alt+Del wire shape: a tag and NOTHING else.
    ///
    /// A fieldless variant is the whole design. The controller used to express
    /// this as six `Key` frames, which meant the host could not tell "the user
    /// asked for the secure attention sequence" from "the user is holding Ctrl
    /// and Alt and pressed Delete in a text editor" — and so could not route the
    /// first anywhere different. One tag, one meaning.
    #[test]
    fn the_secure_attention_sequence_has_its_own_wire_shape() {
        let sas: ControlInput = serde_json::from_str(r#"{"t":"sas"}"#).unwrap();
        assert!(matches!(sas, ControlInput::Sas));

        // Unit variants in serde's internally-tagged form accept extra fields,
        // which is fine — what must NOT happen is a neighbouring tag being
        // accepted as this one, or this one being accepted without its tag.
        assert!(serde_json::from_str::<ControlInput>(r#"{"t":"sass"}"#).is_err());
        assert!(serde_json::from_str::<ControlInput>(r#"{"t":"SAS"}"#).is_err());
        assert!(serde_json::from_str::<ControlInput>(r#"{"t":"secure_attention"}"#).is_err());
    }

    /// THE POINT OF THE VARIANT. `inject` must refuse it on every platform.
    ///
    /// Driven for real rather than scanned from source: the `Sas` arm makes no
    /// OS call at all, so unlike `Text` it is safe to exercise on a machine
    /// somebody is using — and a behaviour test cannot be satisfied by a
    /// comment that happens to contain the right word.
    ///
    /// Revert the arm to `Ok(())` and this goes red. That is the regression it
    /// exists for: the shipped code answered `Ok` for a sequence that had
    /// provably not happened.
    #[test]
    fn the_sas_arm_can_never_answer_ok() {
        let err = inject(ControlInput::Sas)
            .expect_err("a secure attention sequence this crate cannot raise must not report success");
        assert!(!err.is_empty(), "a refusal with no reason tells the viewer nothing");

        #[cfg(windows)]
        {
            assert_eq!(err, SAS_NEEDS_SERVICE, "the refusal must be the named, actionable message, not a generic one");
            assert!(
                err.contains("system service"),
                "the refusal must name what would actually work: {err}"
            );
        }
        #[cfg(target_os = "linux")]
        assert!(err.contains("Windows concept"), "{err}");
    }

    /// An OLD host must treat `Text` as an unknown event, never mistake it for
    /// something else. Serde's tagged enums give this for free, but it is the
    /// property the whole soft-keyboard feature rests on: a v0.8.20 agent that
    /// cannot type text has to REFUSE it, not inject something adjacent.
    #[test]
    fn text_does_not_masquerade_as_another_event() {
        let as_key = serde_json::from_str::<ControlInput>(r#"{"t":"text","code":"KeyA"}"#);
        assert!(as_key.is_err(), "text without its own field parsed as something");
        assert!(serde_json::from_str::<ControlInput>(r#"{"t":"text"}"#).is_err());
    }

    /// The length gate, tested where it costs nothing: `inject` itself types
    /// into whatever window has focus, so the accepting case cannot be
    /// exercised through it.
    #[test]
    fn text_is_gated_on_length_at_both_ends() {
        assert!(validate_text("").is_err(), "empty text should be refused");
        assert!(validate_text("hello").is_ok(), "ordinary text should be accepted");

        let at_limit = "a".repeat(MAX_TEXT_CHARS);
        assert!(validate_text(&at_limit).is_ok(), "the limit itself should be allowed");
        let over = "a".repeat(MAX_TEXT_CHARS + 1);
        assert!(validate_text(&over).is_err(), "one past the limit should be refused");

        // CHARACTERS, not bytes: 256 emoji are 1024 bytes and still 256 taps of
        // a keyboard. Counting bytes would refuse a legitimate message in any
        // language that does not fit in ASCII.
        let wide = "\u{1F600}".repeat(MAX_TEXT_CHARS);
        assert!(wide.len() > MAX_TEXT_CHARS, "fixture is not actually multi-byte");
        assert!(validate_text(&wide).is_ok(), "the limit is counting bytes, not characters");
    }

    /// The batch this crate hands to `SendInput`, checked against the real
    /// thing rather than against `str::encode_utf16`.
    ///
    /// The first version of this test asserted only that an emoji is two UTF-16
    /// units — a property of the standard library, naming no symbol from this
    /// crate. Rewriting `Text` as a per-unit loop, the exact regression its own
    /// comment warns about, left it green.
    ///
    /// A character outside the basic plane is a SURROGATE PAIR, and Windows
    /// recombines the halves only when they arrive in one call. One batch
    /// containing every unit is what makes that true.
    #[cfg(windows)]
    #[test]
    fn the_whole_string_becomes_one_batch_of_press_release_pairs() {
        use windows::Win32::UI::Input::KeyboardAndMouse::KEYEVENTF_KEYUP;

        // 'e-acute' is one unit; the emoji is a surrogate PAIR. Three units.
        let batch = win::text_batch("\u{00E9}\u{1F600}");
        assert_eq!(batch.len(), 6, "expected a press and a release for each of 3 units");

        let units: Vec<u16> = "\u{00E9}\u{1F600}".encode_utf16().collect();
        assert_eq!(units.len(), 3, "fixture is not actually a surrogate pair");
        for (i, unit) in units.iter().enumerate() {
            let (down, up) = unsafe { (batch[i * 2].Anonymous.ki, batch[i * 2 + 1].Anonymous.ki) };
            assert_eq!(down.wScan, *unit, "unit {i} press carries the wrong character");
            assert_eq!(up.wScan, *unit, "unit {i} release carries the wrong character");
            assert!(
                (down.dwFlags & KEYEVENTF_KEYUP).0 == 0,
                "unit {i} press is flagged as a release",
            );
            assert!(
                (up.dwFlags & KEYEVENTF_KEYUP).0 != 0,
                "unit {i} release is not flagged as one — the key would stay down",
            );
        }
    }

    /// Positive control for the test above: it can tell two strings apart, so a
    /// `text_batch` that returned a fixed array would not satisfy both.
    #[cfg(windows)]
    #[test]
    fn different_text_produces_a_different_batch() {
        let a = win::text_batch("a");
        let b = win::text_batch("b");
        assert_eq!(a.len(), b.len());
        assert_ne!(
            unsafe { a[0].Anonymous.ki.wScan },
            unsafe { b[0].Anonymous.ki.wScan },
            "the batch does not depend on its input",
        );
    }

    #[test]
    fn control_characters_are_refused_rather_than_typed() {
        // A carriage return through KEYEVENTF_UNICODE is a real Enter: enough
        // to submit a form or run a line in a terminal that happens to have
        // focus, as a side effect of pasting.
        for bad in ["hello\r", "\ttab", "esc\u{1b}", "nul\0"] {
            assert!(validate_text(bad).is_err(), "{bad:?} should have been refused");
        }
        assert!(validate_text("hello world!").is_ok(), "ordinary text must still pass");
    }

    #[test]
    fn an_unknown_event_kind_is_refused_rather_than_guessed() {
        // A clipboard event shares the sealed channel with input; if it reached
        // the injector and parsed as SOMETHING, it would be replayed as a
        // keystroke. It must simply fail to parse.
        assert!(serde_json::from_str::<ControlInput>(r#"{"t":"clip","data":"x"}"#).is_err());
        assert!(serde_json::from_str::<ControlInput>(r#"{"t":"move"}"#).is_err());
        assert!(serde_json::from_str::<ControlInput>(r#"{}"#).is_err());
    }

    /// Non-finite coordinates must never reach the OS: they cast to garbage
    /// pixel positions and would fling the cursor somewhere unpredictable on a
    /// machine the user cannot see.
    #[cfg(windows)]
    #[test]
    fn non_finite_coordinates_are_rejected() {
        assert!(inject(ControlInput::Move { x: f64::NAN, y: 0.5 }).is_err());
        assert!(inject(ControlInput::Move { x: 0.5, y: f64::INFINITY }).is_err());
        assert!(inject(ControlInput::Rmove { dx: f64::NAN, dy: 0.0 }).is_err());
        assert!(inject(ControlInput::Wheel { dy: f64::NAN }).is_err());
    }

    // --- the E0 prefix: fifteen keys that were typing the wrong thing -------

    /// THE BUG, stated as a table of what must actually reach `SendInput`.
    ///
    /// Every key in the first list shares its scan code with a numeric-keypad
    /// key (or with SysRq) and is distinguished from it ONLY by an `E0` prefix
    /// byte. `win::key` never set `KEYEVENTF_EXTENDEDKEY`, so each was injected
    /// as its twin: remote Delete arrived as numpad `.` — a literal full stop
    /// with NumLock on — Home as numpad `7`, the arrows as `8`/`4`/`6`/`2`,
    /// right Control as left Control, numpad `/` as the main-row `/`, and
    /// PrintScreen as SysRq.
    ///
    /// The expected scan codes are the IBM set-1 make codes, written as the
    /// constants they are rather than transcribed from a run of this code — an
    /// assertion on our own output would pass whatever the function did.
    #[cfg(windows)]
    #[test]
    fn the_grey_editing_keys_are_sent_as_extended_and_the_ordinary_ones_are_not() {
        /// Exactly what `inject` would hand to `win::key` for this DOM code.
        fn injected(code: &str) -> (u16, bool) {
            let vk = code_to_vk(code).unwrap_or_else(|| panic!("{code} is unmapped"));
            let mapped = scan_for_vk(vk.0).unwrap_or_else(|| panic!("no scan code for {code}"));
            scan_and_prefix(code, mapped)
        }

        for (code, scan) in [
            ("Insert", 0x52u16),
            ("Delete", 0x53),
            ("Home", 0x47),
            ("End", 0x4F),
            ("PageUp", 0x49),
            ("PageDown", 0x51),
            ("ArrowUp", 0x48),
            ("ArrowDown", 0x50),
            ("ArrowLeft", 0x4B),
            ("ArrowRight", 0x4D),
            ("ControlRight", 0x1D),
            ("AltRight", 0x38),
            ("NumpadDivide", 0x35),
            ("NumpadEnter", 0x1C),
            ("PrintScreen", 0x37),
        ] {
            assert_eq!(
                injected(code),
                (scan, true),
                "{code} must be injected as E0 {scan:02X}, or it types its twin",
            );
        }

        for (code, scan) in [
            ("KeyA", 0x1Eu16),
            ("Digit1", 0x02),
            ("Space", 0x39),
            ("Enter", 0x1C),
            ("ControlLeft", 0x1D),
            ("AltLeft", 0x38),
            ("ShiftLeft", 0x2A),
            ("NumpadDecimal", 0x53),
            ("Numpad7", 0x47),
            ("NumpadMultiply", 0x37),
        ] {
            assert_eq!(
                injected(code),
                (scan, false),
                "{code} is not an extended key and must not be flagged as one",
            );
        }

        // THE COLLISIONS THEMSELVES, which are what make the flag load-bearing
        // rather than cosmetic: without it each of these pairs is one event.
        for (grey, keypad) in [
            ("Delete", "NumpadDecimal"),
            ("Home", "Numpad7"),
            ("PrintScreen", "NumpadMultiply"),
        ] {
            assert_eq!(
                injected(grey).0,
                injected(keypad).0,
                "{grey} and {keypad} must share a scan code, or this test proves nothing",
            );
            assert_ne!(
                injected(grey),
                injected(keypad),
                "{grey} is indistinguishable from {keypad}",
            );
        }
    }

    /// The measurement the table rests on, kept as a test so it stays true.
    ///
    /// `MAPVK_VK_TO_VSC_EX` is documented as reporting the `E0` prefix, and for
    /// the right-hand modifiers it does. For the editing cluster and the arrows
    /// it DOES NOT — it hands back the bare keypad scan code. That asymmetry is
    /// why the prefix is decided by a table over `KeyboardEvent.code` rather
    /// than read out of the OS; if Windows ever starts reporting it, the table
    /// becomes redundant rather than wrong, and this test says so.
    #[cfg(windows)]
    #[test]
    fn the_os_mapping_cannot_tell_the_editing_cluster_from_the_keypad() {
        use windows::Win32::UI::Input::KeyboardAndMouse::*;

        // Prefix reported: these three would be right even without the table.
        for (name, vk) in [("RControl", VK_RCONTROL), ("RAlt", VK_RMENU), ("Divide", VK_DIVIDE)] {
            let (_, ext) = scan_for_vk(vk.0).unwrap_or_else(|| panic!("no scan code for {name}"));
            assert!(ext, "{name}: the mapping is expected to carry E0 for this key");
        }

        // Prefix NOT reported, and identical to the keypad twin. This is the gap
        // the table fills; if it ever closes, this assertion is what says so.
        for (grey, keypad) in [(VK_DELETE, VK_DECIMAL), (VK_HOME, VK_NUMPAD7), (VK_UP, VK_NUMPAD8)] {
            assert_eq!(
                scan_for_vk(grey.0),
                scan_for_vk(keypad.0),
                "the OS mapping now distinguishes these; EXTENDED_CODES may be redundant",
            );
            assert_eq!(scan_for_vk(grey.0).map(|(_, e)| e), Some(false));
        }
    }

    /// `KEYEVENTF_EXTENDEDKEY` reaches the actual `KEYBDINPUT`, and only when asked.
    #[cfg(windows)]
    #[test]
    fn the_extended_flag_reaches_the_input_windows_receives() {
        use windows::Win32::UI::Input::KeyboardAndMouse::{
            KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_SCANCODE,
        };
        let ext = unsafe { win::key(0x53, true, true).Anonymous.ki };
        assert_eq!(ext.wScan, 0x53, "only the low byte belongs in wScan");
        assert!((ext.dwFlags & KEYEVENTF_EXTENDEDKEY).0 != 0);
        assert!((ext.dwFlags & KEYEVENTF_SCANCODE).0 != 0, "still a scan-code event");
        assert!((ext.dwFlags & KEYEVENTF_KEYUP).0 == 0);

        let plain = unsafe { win::key(0x53, false, true).Anonymous.ki };
        assert!(
            (plain.dwFlags & KEYEVENTF_EXTENDEDKEY).0 == 0,
            "an ordinary key must not be flagged extended, or numpad . becomes Delete",
        );

        // The release carries the prefix too. Pressing E0 53 and releasing 53
        // leaves Delete held down on somebody else's machine.
        let up = unsafe { win::key(0x53, true, false).Anonymous.ki };
        assert!((up.dwFlags & KEYEVENTF_EXTENDEDKEY).0 != 0, "the release lost the prefix");
        assert!((up.dwFlags & KEYEVENTF_KEYUP).0 != 0);
    }

    /// The prefix decode, including the `E1` case no keyboard test can force.
    #[cfg(windows)]
    #[test]
    fn the_mapping_decode_handles_every_prefix_windows_can_return() {
        // Ordinary: no prefix, plain mapping wins.
        assert_eq!(extended_from_mapping(0x001D, 0x001D), Some((0x1D, false)));
        // E0: extended, low byte only.
        assert_eq!(extended_from_mapping(0xE053, 0x0053), Some((0x53, true)));
        assert_eq!(extended_from_mapping(0xE01D, 0x001D), Some((0x1D, true)));
        // E1 is Pause, whose make code is three scan codes long. Neither half is
        // a legal single event: 0x1D is Control and 0x45 is NumLock. The real
        // mapping hands back 0 for the plain form (asserted against the OS
        // below), so this resolves to "no scan code" — the same honest refusal
        // this crate has always given for Pause.
        assert_eq!(extended_from_mapping(0xE11D, 0x0000), None);
        // No scan code at all is an error, not a zero keystroke.
        assert_eq!(extended_from_mapping(0, 0), None);
        // An E0 with a zero low byte is not a usable key either; fall through
        // rather than sending E0 00.
        assert_eq!(extended_from_mapping(0xE000, 0), None);

        // THE MEASUREMENT behind the E1 row, so it is not folklore.
        use windows::Win32::UI::Input::KeyboardAndMouse::VK_PAUSE;
        assert_eq!(
            scan_for_vk(VK_PAUSE.0),
            None,
            "Pause has no single-event scan code; injecting one would be Control or NumLock",
        );
        assert!(inject(ControlInput::Key { code: "Pause".into(), down: true }).is_err());
    }

    /// The held-key identity keeps the twins apart, in both directions.
    #[cfg(windows)]
    #[test]
    fn a_held_key_is_identified_by_its_prefix_as_well_as_its_scan_code() {
        assert_ne!(
            pack_key(0x53, true),
            pack_key(0x53, false),
            "Delete and numpad . must not share a slot in PRESSED_KEYS",
        );
        // Round-trips, because `release_all` sends back exactly what was recorded.
        for (scan, ext) in [(0x53u16, true), (0x53, false), (0x1D, true), (0x2A, false)] {
            assert_eq!(unpack_key(pack_key(scan, ext)), (scan, ext));
        }
    }

    /// `inject` really does track held keys by the PACKED identity.
    ///
    /// THE GAP THIS CLOSES WAS FOUND BY BREAKING THE CODE AND WATCHING THE SUITE
    /// STAY GREEN. `pack_key`'s own test proves the function is injective and
    /// proves nothing about whether the `Key` arm uses it: replacing
    /// `pack_key(scan, extended)` with a bare `scan` reintroduces the collision —
    /// hold Delete and the host swallows a numpad `.` as a duplicate, and
    /// `release_all` then lifts the wrong one, leaving a key down on somebody
    /// else's machine — and every test still passed.
    ///
    /// Scanned from source because the alternative is driving `inject` for real,
    /// which presses keys into whatever window has focus. Scoped to the non-test
    /// half of the file: a scan that also read this module would find this
    /// assertion's own text and pass whatever the real code does.
    #[cfg(windows)]
    #[test]
    fn the_key_arm_tracks_held_keys_by_the_packed_identity() {
        let src = include_str!("lib.rs").split("#[cfg(test)]").next().unwrap();
        let arm_start = src.find("ControlInput::Key { code, down } =>").expect("the Key arm");
        let arm = &src[arm_start..arm_start + 1200];
        assert!(
            arm.contains("pack_key(scan, extended)"),
            "the held-key set must be keyed on scan code AND prefix: {arm}"
        );
        assert!(
            arm.contains("scan_and_prefix(&code, mapped)"),
            "the prefix must come from the table, not from the raw mapping: {arm}"
        );
        // THE DELIVERY. Deciding the flag and then not passing it to the OS
        // call is the one line that could be reverted with everything above
        // still green: `win::key(scan, extended, down)` is what puts
        // KEYEVENTF_EXTENDEDKEY on the wire (the_extended_flag_reaches_the_
        // input_windows_receives pins what that helper does with `true`).
        assert!(
            arm.contains("win::key(scan, extended, down)"),
            "the Key arm must hand the decided prefix to SendInput: {arm}"
        );
        // And `release_all` must undo it symmetrically, or the pair is stuck.
        let rel = src.find("pub fn release_all()").expect("release_all");
        let body = &src[rel..rel + 900];
        assert!(body.contains("unpack_key(packed)"), "release_all lost the prefix: {body}");
        assert!(
            body.contains("win::key(scan, extended, false)"),
            "release_all must lift the key with the same prefix it was pressed with: {body}"
        );
    }

    /// The prefix decision itself, with no OS in the loop at all.
    #[cfg(windows)]
    #[test]
    fn the_extended_table_decides_off_device_and_leaves_everything_else_alone() {
        // In the table, no override: the mapping's scan code, flag forced on.
        assert_eq!(scan_and_prefix("Delete", (0x53, false)), (0x53, true));
        assert_eq!(scan_and_prefix("ArrowUp", (0x48, false)), (0x48, true));
        // In the table AND already flagged by the mapping: idempotent.
        assert_eq!(scan_and_prefix("ControlRight", (0x1D, true)), (0x1D, true));
        // In the table WITH an override: the mapping's 0x54 (SysRq) is replaced.
        assert_eq!(scan_and_prefix("PrintScreen", (0x54, false)), (0x37, true));
        // Not in the table: untouched, in both directions.
        assert_eq!(scan_and_prefix("KeyA", (0x1E, false)), (0x1E, false));
        assert_eq!(scan_and_prefix("Enter", (0x1C, false)), (0x1C, false));
        assert_eq!(scan_and_prefix("NumpadDecimal", (0x53, false)), (0x53, false));
        // A code the table does not know keeps whatever the OS said, so a future
        // extended key still works before anyone remembers this list.
        assert_eq!(scan_and_prefix("SomethingNew", (0x2B, true)), (0x2B, true));

        // Every row names a code `code_to_vk` actually maps, or it is decoration
        // that can never fire.
        for (code, _) in EXTENDED_CODES {
            assert!(code_to_vk(code).is_some(), "{code} is in EXTENDED_CODES but is unmapped");
        }
        // Enter is deliberately NOT in it, and that is the whole reason the list
        // is keyed on the DOM code: it shares VK_RETURN with NumpadEnter.
        assert!(!EXTENDED_CODES.iter().any(|(c, _)| *c == "Enter"));
        assert_eq!(code_to_vk("Enter"), code_to_vk("NumpadEnter"));
        // The two Win keys are two keys (the mapping had both on VK_LWIN), and
        // both plus the menu key are E0-prefixed — idempotent through the table
        // with the real scan codes: E0 5B, E0 5C, E0 5D.
        assert_ne!(code_to_vk("MetaLeft"), code_to_vk("MetaRight"));
        assert_eq!(scan_and_prefix("MetaLeft", (0x5B, true)), (0x5B, true));
        assert_eq!(scan_and_prefix("MetaRight", (0x5C, true)), (0x5C, true));
        assert_eq!(scan_and_prefix("ContextMenu", (0x5D, true)), (0x5D, true));
        for c in ["MetaLeft", "MetaRight", "ContextMenu"] {
            assert!(EXTENDED_CODES.iter().any(|(k, _)| *k == c), "{c} must be in the E0 table");
        }
    }

    #[cfg(windows)]
    #[test]
    fn an_unmapped_key_code_is_an_error_not_a_wrong_key() {
        // Injecting the wrong key is worse than injecting none: it is a
        // keystroke the user never typed, on their own machine.
        assert!(inject(ControlInput::Key { code: "NotAKey".into(), down: true }).is_err());
        assert!(inject(ControlInput::Key { code: String::new(), down: true }).is_err());
    }

    #[cfg(not(any(windows, target_os = "linux")))]
    #[test]
    fn injection_is_a_hard_error_off_windows() {
        // Silently accepting input it cannot inject would make an agent look
        // connected while doing nothing at all.
        assert!(inject(ControlInput::Move { x: 0.5, y: 0.5 }).is_err());
        assert!(list_monitors().monitors.is_empty());
    }

    // --- SendInput's return is the only proof a keystroke landed ------------

    #[cfg(windows)]
    #[test]
    fn a_refused_injection_is_an_error_that_names_the_likely_cause() {
        // The regression this exists to catch: six call sites in `inject` used
        // to discard SendInput's return, so a keystroke aimed at a UAC prompt
        // or the lock screen did nothing and was reported as success. That is
        // unacceptable specifically because the feature this codebase is
        // building is "type your Windows password into a screen you can see" —
        // silent failure there is indistinguishable from a wrong password.
        let err =
            super::sent_detail(false, "key press", None, None).expect_err("false must be an error");
        assert!(err.contains("no retry was attempted"), "None must say so: {err}");
        assert!(err.contains("key press"), "must say WHAT was refused: {err}");
        assert!(
            err.contains("security prompt") || err.contains("lock screen"),
            "must point at the real cause rather than a bare failure: {err}"
        );
    }

    #[cfg(windows)]
    #[test]
    fn the_follow_result_reaches_the_final_error_string() {
        // THE WHOLE REASON THIS DETAIL EXISTS. Every refusal against the real
        // sign-in screen showed only the generic "Windows refused the injected
        // pointer move" — with no way to tell whether follow_input_desktop was
        // even attempted, let alone what it reported. This is the only channel
        // that detail can reach a person: the agent has no console, and the
        // relay only ever forwards the final error string.
        let attached = super::sent_detail(false, "pointer move", Some(&Ok("Winlogon".into())), None)
            .expect_err("still refused after the retry");
        assert!(attached.contains("Winlogon"), "must name the desktop it reached: {attached}");
        assert!(
            attached.contains("STILL refused"),
            "must say the retry itself was the one that failed: {attached}"
        );

        let could_not_attach = super::sent_detail(
            false,
            "pointer move",
            Some(&Err("cannot open the input desktop (access denied)".into())),
            None,
        )
        .expect_err("attach itself failed");
        assert!(
            could_not_attach.contains("access denied"),
            "must carry the attach failure through: {could_not_attach}"
        );

        // The three cases must not collapse into the same sentence, or the
        // detail this exists to add is not actually distinguishing anything.
        let no_retry = super::sent_detail(false, "pointer move", None, None).unwrap_err();
        let texts = [attached, could_not_attach, no_retry];
        for (i, a) in texts.iter().enumerate() {
            for b in texts.iter().skip(i + 1) {
                assert_ne!(a, b, "two different follow outcomes must read differently");
            }
        }
    }

    #[cfg(windows)]
    #[test]
    fn get_last_error_reaches_the_final_string_and_is_silent_when_absent() {
        // THE ACTUAL EXPERIMENT this fix depends on. `5` distinguishes "the
        // access-rights fix should work" from anything else, which means
        // "this needs a different mechanism entirely" — so the code must not
        // fold that number into the generic detail text or lose it.
        let with_code = super::sent_detail(false, "pointer move", None, Some(5))
            .expect_err("still refused");
        assert!(with_code.contains("GetLastError=5"), "{with_code}");

        // 0 and None must both stay silent: a 0 means nothing meaningful was
        // recorded, and printing "GetLastError=0" would read as a real code
        // rather than as noise.
        let zero = super::sent_detail(false, "pointer move", None, Some(0)).unwrap_err();
        assert!(!zero.contains("GetLastError"), "{zero}");
        let absent = super::sent_detail(false, "pointer move", None, None).unwrap_err();
        assert!(!absent.contains("GetLastError"), "{absent}");
    }

    #[cfg(windows)]
    #[test]
    fn a_delivered_injection_is_not_an_error() {
        // The positive control. Without it, a `sent` that returned Err
        // unconditionally would satisfy the test above while breaking every
        // mouse move and keystroke on every shipped install.
        assert!(super::sent_detail(true, "pointer move", None, None).is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn following_the_input_desktop_works_where_this_process_is_allowed() {
        // The positive control for the whole mechanism. As the signed-in user
        // on an interactive desktop this must SUCCEED and name it — if it
        // cannot attach to the desktop it is already on, the failure on
        // Winlogon later would be meaningless and the retry in `sent_following`
        // would be dead code that silently never fires.
        //
        // Tolerates a headless/service context, where there is no input desktop
        // to open at all: that is a different condition from being refused one,
        // and asserting Ok unconditionally would make this test a CI flake
        // rather than a check.
        match super::desktop::follow_input_desktop() {
            Ok(name) => {
                assert!(!name.is_empty(), "an attached desktop must have a name");
                // Attaching twice must be idempotent, because the retry path
                // can run repeatedly on a machine that keeps raising prompts.
                assert!(super::desktop::follow_input_desktop().is_ok(), "not idempotent");
            }
            Err(e) => {
                // Reached only where there is no input desktop at all — a
                // service or a headless runner. Verified NOT to be the branch
                // taken on a real interactive session: run under --nocapture on
                // a desktop and it reports `Default`. Kept tolerant rather than
                // asserting Ok unconditionally, because that would make this a
                // CI flake instead of a check; but it must still prove the
                // refusal names its step, or a passing test here would tell us
                // nothing about which half of the function ran.
                assert!(
                    e.contains("input desktop") || e.contains("attach"),
                    "a refusal must say which step failed: {e}"
                );
            }
        }
    }
}
