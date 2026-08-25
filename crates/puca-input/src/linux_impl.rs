//! X11 input injection via XTEST.
//!
//! The Linux counterpart to `SendInput`. XTEST rather than `/dev/uinput`
//! because it needs NO elevated privilege: uinput requires root or a udev rule
//! granting the `input` group, and an agent that cannot inject until the user
//! has written a udev rule is an agent that appears broken on first run. XTEST
//! only needs the X connection the capture already holds.
//!
//! WHAT XTEST CANNOT DO, stated here so it is not discovered in the field:
//!
//!   * It cannot reach a Wayland compositor. Under Xwayland it drives the X
//!     server only, so native Wayland clients never see it. That is the same
//!     boundary the capture path hits, and it is why Wayland needs the portal /
//!     libei route rather than a patch to this file.
//!   * It cannot inject into the display manager's greeter or a locked screen,
//!     which run as another user on another X display. That is Linux's rough
//!     equivalent of the Windows secure-desktop boundary.
//!   * It has no equivalent of UIPI, so within one X display there is no
//!     privilege gradient: anything the user can click, this can click. X11's
//!     security model IS "same display means full access".
//!
//! KEYCODES, NOT SCANCODES. X11 addresses keys by server-assigned keycode, and
//! the mapping is per-layout and per-server — hardcoding a table would type the
//! wrong characters on any non-US layout. So the map is built at connect time
//! from `GetKeyboardMapping`: DOM `code` -> X keysym (fixed, physical) -> the
//! keycode THIS server currently assigns to it. `MappingNotify` invalidates it.

use super::{ControlInput, MonitorInfo, MonitorList};
use std::sync::Mutex;
use x11rb::connection::Connection;
use x11rb::protocol::xproto::{ConnectionExt as _, GetKeyboardMappingReply};
use x11rb::protocol::xtest::ConnectionExt as _;
use x11rb::rust_connection::RustConnection;

// XTEST event types, from the protocol spec.
const KEY_PRESS: u8 = 2;
const KEY_RELEASE: u8 = 3;
const BUTTON_PRESS: u8 = 4;
const BUTTON_RELEASE: u8 = 5;
const MOTION_NOTIFY: u8 = 6;

/// `detail` for MotionNotify: 0 = absolute, 1 = relative to the current pointer.
const MOTION_ABSOLUTE: u8 = 0;
const MOTION_RELATIVE: u8 = 1;

struct Injector {
    conn: RustConnection,
    root: u32,
    min_keycode: u8,
    per_code: usize,
    /// Flattened keysym table exactly as the server returned it.
    keysyms: Vec<u32>,
}

impl Injector {
    fn connect() -> Result<Self, String> {
        let (conn, screen) = x11rb::connect(None)
            .map_err(|e| format!("cannot connect to the X server (is DISPLAY set?): {e}"))?;
        // XTEST is an extension and CAN be absent — some hardened/kiosk servers
        // build without it. Checking now turns a confusing per-keystroke failure
        // into one clear message at session start.
        conn.xtest_get_version(2, 2)
            .map_err(|e| format!("XTEST is not available on this X server: {e}"))?
            .reply()
            .map_err(|e| format!("XTEST version check failed: {e}"))?;

        let root = conn.setup().roots[screen].root;
        let min_keycode = conn.setup().min_keycode;
        let max_keycode = conn.setup().max_keycode;
        let count = max_keycode - min_keycode + 1;
        let map: GetKeyboardMappingReply = conn
            .get_keyboard_mapping(min_keycode, count)
            .map_err(|e| format!("get_keyboard_mapping failed: {e}"))?
            .reply()
            .map_err(|e| format!("get_keyboard_mapping reply failed: {e}"))?;

        Ok(Self {
            conn,
            root,
            min_keycode,
            per_code: map.keysyms_per_keycode as usize,
            keysyms: map.keysyms,
        })
    }

    /// The keycode this server assigns to `keysym`, or None if the layout has
    /// no key for it.
    ///
    /// Only the FIRST (unshifted) level is searched, deliberately. The
    /// controller sends physical `code`s and sends Shift as its own event, so
    /// "Digit1" must produce the `1` key and let the host's own Shift state
    /// decide whether that yields `!`. Searching shifted levels too would make
    /// an unmodified Digit1 land on whatever key happens to carry `1` in its
    /// shifted position — a different key entirely on several layouts.
    fn keycode_for(&self, keysym: u32) -> Option<u8> {
        if self.per_code == 0 {
            return None;
        }
        self.keysyms
            .chunks(self.per_code)
            .position(|levels| levels.first() == Some(&keysym))
            // CHECKED, not `min_keycode + i as u8`. X11 permits any min_keycode
            // up to 255 and up to 248 entries, so the sum can leave u8 -- which
            // panics in debug and silently wraps to a WRONG KEY in release.
            // A keyboard path that types the wrong character on an unusual
            // server is worse than one that refuses the key.
            .and_then(|i| u8::try_from(i).ok())
            .and_then(|i| self.min_keycode.checked_add(i))
    }

    /// Where a character lives on this layout: its keycode, and whether Shift
    /// is needed to reach it.
    ///
    /// SEPARATE FROM `keycode_for` and it must stay that way. That one searches
    /// level 0 only, deliberately, because the `Key` path carries PHYSICAL keys
    /// and lets the host's own Shift decide what they produce. Typing TEXT is
    /// the opposite problem: `'H'` exists only at level 1 of the `h` key, so a
    /// level-0-only search cannot type a capital letter at all — nor any of
    /// `! @ # $ % & * ( ) _ + { } | : " < > ? ~`.
    fn keycode_and_shift_for(&self, keysym: u32) -> Option<(u8, bool)> {
        if self.per_code == 0 {
            return None;
        }
        for level in 0..self.per_code.min(2) {
            let found = self
                .keysyms
                .chunks(self.per_code)
                .position(|levels| levels.get(level) == Some(&keysym))
                .and_then(|i| u8::try_from(i).ok())
                .and_then(|i| self.min_keycode.checked_add(i));
            if let Some(kc) = found {
                return Some((kc, level == 1));
            }
        }
        None
    }

    fn fake(&self, type_: u8, detail: u8, x: i16, y: i16) -> Result<(), String> {
        self.conn
            .xtest_fake_input(type_, detail, 0, self.root, x, y, 0)
            .map_err(|e| format!("xtest_fake_input failed: {e}"))?;
        // XTEST is asynchronous; without a flush the events sit in the output
        // buffer and the remote pointer appears to lag by one action.
        self.conn
            .flush()
            .map_err(|e| format!("flush failed: {e}"))?;
        Ok(())
    }
}

static INJECTOR: Mutex<Option<Injector>> = Mutex::new(None);
// Same discipline as the Windows path: track what is held so a revoke, timeout
// or disconnect can release it. A key left down on someone's desktop outlives
// the session and is indistinguishable from broken hardware.
static PRESSED_KEYCODES: Mutex<Vec<u8>> = Mutex::new(Vec::new());
static PRESSED_BUTTONS_X: Mutex<Vec<u8>> = Mutex::new(Vec::new());

fn with_injector<T>(f: impl FnOnce(&Injector) -> Result<T, String>) -> Result<T, String> {
    let mut guard = INJECTOR.lock().map_err(|_| "injector lock poisoned".to_string())?;
    if guard.is_none() {
        *guard = Some(Injector::connect()?);
    }
    f(guard.as_ref().expect("just initialised"))
}

/// Drop the cached X connection and mapping.
///
/// Called when the layout changes and on session end. Rebuilding on the next
/// injection is cheap; keeping a stale keycode map types the wrong letters.
pub fn reset_connection() {
    if let Ok(mut g) = INJECTOR.lock() {
        *g = None;
    }
}

/// DOM `KeyboardEvent.code` -> X11 keysym.
///
/// Keysyms are the stable, layout-independent half of the lookup: `XK_a` is
/// always 0x61 whatever the keyboard. The layout-dependent half is
/// `keycode_for`, resolved against the live server.
fn code_to_keysym(code: &str) -> Option<u32> {
    // Letters map to the LOWERCASE keysym: X11 level 0 is unshifted, and the
    // controller sends Shift separately.
    if let Some(rest) = code.strip_prefix("Key") {
        let b = rest.as_bytes();
        if b.len() == 1 && b[0].is_ascii_uppercase() {
            return Some(b[0].to_ascii_lowercase() as u32);
        }
    }
    if let Some(rest) = code.strip_prefix("Digit") {
        let b = rest.as_bytes();
        if b.len() == 1 && b[0].is_ascii_digit() {
            return Some(b[0] as u32);
        }
    }
    if let Some(rest) = code.strip_prefix("Numpad") {
        if let Some(d) = rest.parse::<u32>().ok().filter(|d| *d <= 9) {
            return Some(0xFFB0 + d); // XK_KP_0
        }
    }
    // Must come after the Numpad/F-key prefixes above so "F1" is not eaten by a
    // looser rule.
    if let Some(rest) = code.strip_prefix('F') {
        if let Ok(n) = rest.parse::<u32>() {
            if (1..=24).contains(&n) {
                return Some(0xFFBE + (n - 1)); // XK_F1
            }
        }
    }

    let ks = match code {
        "Space" => 0x0020,
        "Enter" => 0xFF0D,        // XK_Return
        "NumpadEnter" => 0xFF8D,  // XK_KP_Enter
        "Escape" => 0xFF1B,
        "Tab" => 0xFF09,
        "Backspace" => 0xFF08,
        "Delete" => 0xFFFF,
        "Insert" => 0xFF63,
        "Home" => 0xFF50,
        "End" => 0xFF57,
        "PageUp" => 0xFF55,
        "PageDown" => 0xFF56,
        "ArrowUp" => 0xFF52,
        "ArrowDown" => 0xFF54,
        "ArrowLeft" => 0xFF51,
        "ArrowRight" => 0xFF53,
        "ShiftLeft" => 0xFFE1,
        "ShiftRight" => 0xFFE2,
        "ControlLeft" => 0xFFE3,
        "ControlRight" => 0xFFE4,
        "AltLeft" => 0xFFE9,
        "AltRight" => 0xFFEA,     // XK_Alt_R; AltGr layouts remap this themselves
        "MetaLeft" => 0xFFEB,     // XK_Super_L
        "MetaRight" => 0xFFEC,
        "CapsLock" => 0xFFE5,
        "Minus" => 0x002D,
        "Equal" => 0x003D,
        "BracketLeft" => 0x005B,
        "BracketRight" => 0x005D,
        "Backslash" => 0x005C,
        "Semicolon" => 0x003B,
        "Quote" => 0x0027,
        "Comma" => 0x002C,
        "Period" => 0x002E,
        "Slash" => 0x002F,
        "Backquote" => 0x0060,
        "NumpadAdd" => 0xFFAB,
        "NumpadSubtract" => 0xFFAD,
        "NumpadMultiply" => 0xFFAA,
        "NumpadDivide" => 0xFFAF,
        "NumpadDecimal" => 0xFFAE,
        _ => return None,
    };
    Some(ks)
}

/// DOM button order (0=left, 1=middle, 2=right) -> X button number.
///
/// X numbers them 1=left, 2=MIDDLE, 3=right — the middle and right are swapped
/// relative to DOM, and getting this wrong pastes the X selection every time
/// the viewer right-clicks.
fn dom_button_to_x(button: u8) -> Option<u8> {
    match button {
        0 => Some(1),
        1 => Some(2),
        2 => Some(3),
        _ => None,
    }
}

pub fn inject(event: ControlInput) -> Result<(), String> {
    match event {
        ControlInput::Move { x, y } => {
            // Same mapping rule as Windows: normalized over the TARGET monitor,
            // translated into virtual-desktop coordinates. X11 root coordinates
            // already span all monitors, so no extra normalization is needed —
            // but the target's origin still has to be added or every move lands
            // on the primary screen.
            // Reject non-finite input BEFORE arithmetic. `f64::clamp`
            // propagates NaN rather than clamping it, and `NaN as i16` is 0 --
            // so a malformed coordinate would silently warp the pointer to the
            // monitor's origin instead of being refused.
            if !x.is_finite() || !y.is_finite() {
                return Err(format!("non-finite move coordinates ({x}, {y})"));
            }
            let t = super::current_target();
            let (px, py) = match t {
                Some(t) => (
                    t.left as f64 + x.clamp(0.0, 1.0) * t.width as f64,
                    t.top as f64 + y.clamp(0.0, 1.0) * t.height as f64,
                ),
                None => return Err("no target monitor set for absolute move".to_string()),
            };
            with_injector(|inj| {
                inj.fake(MOTION_NOTIFY, MOTION_ABSOLUTE, px as i16, py as i16)
            })
        }
        ControlInput::Rmove { dx, dy } => {
            if !dx.is_finite() || !dy.is_finite() {
                return Err(format!("non-finite relative delta ({dx}, {dy})"));
            }
            // Saturating by design: `as i16` clamps, so an absurd delta pins the
            // pointer at a screen edge rather than wrapping to the far side.
            with_injector(|inj| {
                inj.fake(MOTION_NOTIFY, MOTION_RELATIVE, dx as i16, dy as i16)
            })
        }
        ControlInput::Down { button } => {
            let b = dom_button_to_x(button).ok_or_else(|| format!("unknown button {button}"))?;
            with_injector(|inj| inj.fake(BUTTON_PRESS, b, 0, 0))?;
            if let Ok(mut p) = PRESSED_BUTTONS_X.lock() {
                if !p.contains(&b) {
                    p.push(b);
                }
            }
            Ok(())
        }
        ControlInput::Up { button } => {
            let b = dom_button_to_x(button).ok_or_else(|| format!("unknown button {button}"))?;
            with_injector(|inj| inj.fake(BUTTON_RELEASE, b, 0, 0))?;
            if let Ok(mut p) = PRESSED_BUTTONS_X.lock() {
                p.retain(|x| *x != b);
            }
            Ok(())
        }
        ControlInput::Wheel { dy } => {
            // X11 has no scroll axis in core input: the wheel IS buttons 4 (up)
            // and 5 (down), delivered as a press/release pair.
            if dy == 0.0 {
                return Ok(());
            }
            let b = if dy > 0.0 { 4 } else { 5 };
            with_injector(|inj| {
                inj.fake(BUTTON_PRESS, b, 0, 0)?;
                inj.fake(BUTTON_RELEASE, b, 0, 0)
            })
        }
        ControlInput::Key { code, down } => {
            let keysym = code_to_keysym(&code).ok_or_else(|| format!("unmapped key {code}"))?;
            let kc = with_injector(|inj| {
                inj.keycode_for(keysym).ok_or_else(|| {
                    format!("this keyboard layout has no key for {code} (keysym {keysym:#x})")
                })
            })?;
            with_injector(|inj| {
                inj.fake(if down { KEY_PRESS } else { KEY_RELEASE }, kc, 0, 0)
            })?;
            if let Ok(mut p) = PRESSED_KEYCODES.lock() {
                if down {
                    if !p.contains(&kc) {
                        p.push(kc);
                    }
                } else {
                    p.retain(|x| *x != kc);
                }
            }
            Ok(())
        }
        // X11 has no secure attention sequence to raise. Ctrl+Alt+Del on a Linux
        // console is an ordinary key combination that init or the desktop
        // environment happens to bind, not a kernel-trusted path — so there is
        // nothing here to be "not implemented yet". Answering with a plain
        // refusal rather than typing the three keys, because typing them would
        // reboot some machines and do nothing on others, and the caller asked
        // for neither.
        ControlInput::Sas => {
            Err("the secure attention sequence is a Windows concept".to_string())
        }
        ControlInput::Text { text } => {
            super::validate_text(&text)?;
            // X11 has no "type this character" call. XTEST drives KEYCODES, so
            // a character can only be typed if the CURRENT LAYOUT has a key for
            // it. Remapping a spare keycode per character is the general answer
            // and is not attempted here: it mutates the host's keyboard mapping
            // and a crash mid-sequence would leave the person at that desk with
            // a broken key.
            //
            // RESOLVE EVERYTHING FIRST, THEN TYPE. The obvious loop — resolve
            // and type each character in turn — fails HALFWAY on the first
            // character the layout cannot reach, leaving a fragment of the
            // user's sentence in whatever window had focus and returning an
            // error the controller never displays. Either the whole string can
            // be typed or none of it is.
            let plan: Vec<(u8, bool)> = with_injector(|inj| {
                text.chars()
                    .map(|c| {
                        let keysym = keysym_for_char(c);
                        inj.keycode_and_shift_for(keysym).ok_or_else(|| {
                            format!(
                                "this keyboard layout has no key for {c:?} (keysym {keysym:#x})"
                            )
                        })
                    })
                    .collect()
            })?;

            // Option, not Result: this is consulted once per shifted character
            // inside the loop, and a Result carrying a String cannot be read
            // twice.
            let shift: Option<u8> = with_injector(|inj| Ok(inj.keycode_for(XK_SHIFT_L)))
                .unwrap_or(None);

            for (kc, needs_shift) in plan {
                if needs_shift {
                    let Some(sk) = shift else {
                        return Err("this keyboard layout has no Shift key".into());
                    };
                    with_injector(|inj| inj.fake(KEY_PRESS, sk, 0, 0))?;
                    // RELEASE WHATEVER WE PRESSED, even when the press of the
                    // character itself fails. A Shift left down by an early
                    // return is stuck on the host's real desktop for the rest
                    // of the session — `clear_stuck_keys` only runs at session
                    // start — and every subsequent keystroke is capitalised.
                    let typed = with_injector(|inj| inj.fake(KEY_PRESS, kc, 0, 0))
                        .and_then(|()| with_injector(|inj| inj.fake(KEY_RELEASE, kc, 0, 0)));
                    let released = with_injector(|inj| inj.fake(KEY_RELEASE, sk, 0, 0));
                    typed?;
                    released?;
                } else {
                    let pressed = with_injector(|inj| inj.fake(KEY_PRESS, kc, 0, 0));
                    let released = with_injector(|inj| inj.fake(KEY_RELEASE, kc, 0, 0));
                    pressed?;
                    released?;
                }
            }
            Ok(())
        }
    }
}

/// `XK_Shift_L`, needed to reach a layout's shifted level.
const XK_SHIFT_L: u32 = 0xffe1;

/// The X keysym for a character.
///
/// Latin-1 code points ARE their own keysyms; everything else uses the Unicode
/// escape range. This is the standard mapping, not a Puca convention.
fn keysym_for_char(c: char) -> u32 {
    let cp = c as u32;
    if cp < 0x100 {
        cp
    } else {
        0x0100_0000 + cp
    }
}

/// Release everything currently held. Safe to call when nothing is held.
pub fn release_all() {
    let keys: Vec<u8> = PRESSED_KEYCODES.lock().map(|mut p| std::mem::take(&mut *p)).unwrap_or_default();
    let buttons: Vec<u8> =
        PRESSED_BUTTONS_X.lock().map(|mut p| std::mem::take(&mut *p)).unwrap_or_default();
    // Errors are swallowed on purpose: this runs on disconnect and teardown,
    // where the X connection may already be gone. Failing here would mask the
    // real reason the session ended.
    let _ = with_injector(|inj| {
        for kc in keys {
            let _ = inj.fake(KEY_RELEASE, kc, 0, 0);
        }
        for b in buttons {
            let _ = inj.fake(BUTTON_RELEASE, b, 0, 0);
        }
        Ok(())
    });
}

/// Release EVERY key the X server currently reports as held, whoever pressed it.
///
/// `release_all` can only release what THIS process tracked. If the agent was
/// killed mid-session with keys down -- crash, OOM, `systemctl restart` -- the
/// replacement process has no record of them and they stay held forever on the
/// user's desktop. That is not hypothetical: it happened during development,
/// and a stuck ShiftLeft survived across process restarts until cleared by hand.
///
/// So this is the recovery path, and it deliberately asks the SERVER what is
/// down rather than trusting local state. Call it at session START only. The
/// trade-off, stated because it is real: if someone is physically at the
/// machine holding a key at that exact moment, this releases it and they must
/// press it again. On an unattended host nobody is there, and a momentary
/// released key is a far smaller harm than a permanently stuck one.
pub fn clear_stuck_keys() -> Result<usize, String> {
    with_injector(|inj| {
        let held = inj
            .conn
            .query_keymap()
            .map_err(|e| format!("query_keymap failed: {e}"))?
            .reply()
            .map_err(|e| format!("query_keymap reply failed: {e}"))?;

        // The reply is a 32-byte bitmap: byte i, bit b => keycode i * 8 + b.
        let mut cleared = 0;
        for (i, byte) in held.keys.iter().enumerate() {
            if *byte == 0 {
                continue;
            }
            for b in 0..8 {
                if byte & (1 << b) != 0 {
                    let keycode = (i * 8 + b) as u8;
                    inj.fake(KEY_RELEASE, keycode, 0, 0)?;
                    cleared += 1;
                }
            }
        }
        Ok(cleared)
    })
    .inspect(|_| {
        // Our own tracking is now meaningless -- the server state was reset out
        // from under it, and leaving stale entries would make a later
        // release_all send releases for keys nobody holds.
        if let Ok(mut p) = PRESSED_KEYCODES.lock() {
            p.clear();
        }
    })
}

/// Monitor geometry from the X screen.
///
/// One X screen spanning every physical monitor is the norm, so this reports a
/// single entry covering the whole desktop rather than pretending to know where
/// the individual panels are. Per-monitor bounds are a RandR query — worth
/// adding when per-monitor selection ships, and honestly absent until then.
pub fn list_monitors() -> MonitorList {
    let (w, h) = x11rb::connect(None)
        .ok()
        .and_then(|(conn, s)| {
            conn.setup()
                .roots
                .get(s)
                .map(|r| (r.width_in_pixels as i32, r.height_in_pixels as i32))
        })
        .unwrap_or((0, 0));

    MonitorList {
        monitors: vec![MonitorInfo {
            index: 0,
            left: 0,
            top: 0,
            width: w,
            height: h,
            scale: 1.0,
            primary: true,
            hmonitor: 0,
        }],
        virt_left: 0,
        virt_top: 0,
        virt_width: w,
        virt_height: h,
    }
}

/// Anti-cheat detection is Windows-only; the products in question do not run
/// here. An empty list means "nothing blocking", which is correct.
pub fn detect_anticheat() -> Vec<String> {
    Vec::new()
}

/// Whether injection can work at all on this display, with the reason if not.
///
/// The host calls this BEFORE offering control, so a Wayland session refuses up
/// front with an explanation rather than accepting a session in which every
/// keystroke silently does nothing.
pub fn injection_availability() -> Result<(), String> {
    if std::env::var("DISPLAY").is_err() {
        let wayland = std::env::var("WAYLAND_DISPLAY").is_ok();
        return Err(if wayland {
            "this is a Wayland session with no X server; XTEST cannot inject here \
             (Wayland needs the desktop portal / libei path)"
                .to_string()
        } else {
            "no DISPLAY is set, so there is no X server to inject into".to_string()
        });
    }
    with_injector(|_| Ok(()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_finite_coordinates_are_refused_not_silently_zeroed() {
        // `NaN as i16` is 0, so without an explicit guard a malformed
        // coordinate warps the pointer to the target's origin and looks like a
        // deliberate move. These must be errors.
        super::super::set_target(Some(super::super::TargetMonitor {
            left: 0, top: 0, width: 1920, height: 1080,
            virt_left: 0, virt_top: 0, virt_width: 1920, virt_height: 1080,
        }));
        for (x, y) in [(f64::NAN, 0.5), (0.5, f64::NAN), (f64::INFINITY, 0.5)] {
            let e = inject(ControlInput::Move { x, y }).expect_err("must be refused");
            assert!(e.contains("non-finite"), "wrong error for ({x},{y}): {e}");
        }
        for (dx, dy) in [(f64::NAN, 1.0), (1.0, f64::NEG_INFINITY)] {
            let e = inject(ControlInput::Rmove { dx, dy }).expect_err("must be refused");
            assert!(e.contains("non-finite"), "wrong error for ({dx},{dy}): {e}");
        }
    }

    #[test]
    fn dom_and_x_button_order_differ_where_it_matters() {
        // The swap is the whole point of the function: DOM 1 is MIDDLE, X 2 is
        // middle, DOM 2 is RIGHT, X 3 is right. A pass-through +1 would send
        // right-clicks as middle-clicks and paste the X selection every time.
        assert_eq!(dom_button_to_x(0), Some(1), "left");
        assert_eq!(dom_button_to_x(1), Some(2), "DOM middle -> X 2");
        assert_eq!(dom_button_to_x(2), Some(3), "DOM right -> X 3");
        assert_eq!(dom_button_to_x(3), None, "unknown buttons are refused, not guessed");
    }

    #[test]
    fn letters_map_to_unshifted_keysyms() {
        // Level 0 is lowercase. Returning the UPPERCASE keysym would fail to
        // find a keycode on most layouts, since uppercase lives at level 1.
        assert_eq!(code_to_keysym("KeyA"), Some(0x61));
        assert_eq!(code_to_keysym("KeyZ"), Some(0x7A));
        assert_eq!(code_to_keysym("Digit0"), Some(0x30));
        assert_eq!(code_to_keysym("Digit9"), Some(0x39));
    }

    #[test]
    fn function_and_numpad_keys_do_not_collide() {
        // "F1" and "Numpad1" both start with a letter that a looser prefix rule
        // would swallow; this pins the ordering that keeps them apart.
        assert_eq!(code_to_keysym("F1"), Some(0xFFBE));
        assert_eq!(code_to_keysym("F12"), Some(0xFFC9));
        assert_eq!(code_to_keysym("F24"), Some(0xFFD5));
        assert_eq!(code_to_keysym("Numpad1"), Some(0xFFB1));
        assert_eq!(code_to_keysym("NumpadEnter"), Some(0xFF8D));
        assert_ne!(
            code_to_keysym("NumpadEnter"),
            code_to_keysym("Enter"),
            "the numpad Enter is a distinct key and some apps tell them apart",
        );
    }

    #[test]
    fn out_of_range_function_keys_are_refused() {
        assert_eq!(code_to_keysym("F0"), None);
        assert_eq!(code_to_keysym("F25"), None);
        assert_eq!(code_to_keysym("Numpad10"), None);
        assert_eq!(code_to_keysym("Fnord"), None);
        assert_eq!(code_to_keysym("KeyAA"), None);
    }

    #[test]
    fn every_key_the_windows_table_accepts_is_also_mapped_here() {
        // The two backends must accept the SAME `code` vocabulary. If Windows
        // handles a key and Linux does not, the same viewer produces different
        // behaviour per host and it presents as "this key doesn't work on my
        // Linux box" with nothing in any log.
        const CODES: &[&str] = &[
            "Space", "Enter", "NumpadEnter", "Escape", "Tab", "Backspace", "Delete", "Insert",
            "Home", "End", "PageUp", "PageDown", "ArrowUp", "ArrowDown", "ArrowLeft",
            "ArrowRight", "ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight", "AltLeft",
            "AltRight", "MetaLeft", "MetaRight", "CapsLock", "Minus", "Equal", "BracketLeft",
            "BracketRight", "Backslash", "Semicolon", "Quote", "Comma", "Period", "Slash",
            "Backquote", "NumpadAdd", "NumpadSubtract", "NumpadMultiply", "NumpadDivide",
            "NumpadDecimal",
        ];
        for c in CODES {
            assert!(code_to_keysym(c).is_some(), "{c} is mapped on Windows but not here");
        }
        for n in 1..=24 {
            let c = format!("F{n}");
            assert!(code_to_keysym(&c).is_some(), "{c} unmapped");
        }
        for d in 0..=9 {
            assert!(code_to_keysym(&format!("Digit{d}")).is_some());
            assert!(code_to_keysym(&format!("Numpad{d}")).is_some());
        }
        for c in b'A'..=b'Z' {
            assert!(code_to_keysym(&format!("Key{}", c as char)).is_some());
        }
    }

    #[test]
    fn distinct_codes_get_distinct_keysyms() {
        // A duplicated constant in the table would silently alias two keys —
        // e.g. typing Home when the viewer pressed Insert.
        let mut seen = std::collections::HashMap::new();
        let mut codes: Vec<String> = vec![
            "Space", "Enter", "NumpadEnter", "Escape", "Tab", "Backspace", "Delete", "Insert",
            "Home", "End", "PageUp", "PageDown", "ArrowUp", "ArrowDown", "ArrowLeft",
            "ArrowRight", "ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight", "AltLeft",
            "AltRight", "MetaLeft", "MetaRight", "CapsLock", "Minus", "Equal", "BracketLeft",
            "BracketRight", "Backslash", "Semicolon", "Quote", "Comma", "Period", "Slash",
            "Backquote", "NumpadAdd", "NumpadSubtract", "NumpadMultiply", "NumpadDivide",
            "NumpadDecimal",
        ]
        .into_iter()
        .map(String::from)
        .collect();
        codes.extend((1..=24).map(|n| format!("F{n}")));
        codes.extend((0..=9).map(|d| format!("Digit{d}")));
        codes.extend((0..=9).map(|d| format!("Numpad{d}")));
        codes.extend((b'A'..=b'Z').map(|c| format!("Key{}", c as char)));

        for c in codes {
            let ks = code_to_keysym(&c).expect(&c);
            if let Some(prev) = seen.insert(ks, c.clone()) {
                panic!("{c} and {prev} both map to keysym {ks:#x}");
            }
        }
    }
}
