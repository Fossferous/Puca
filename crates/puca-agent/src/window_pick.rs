//! ONE APP WINDOW, shown and controlled on its own (My Devices).
//!
//! The owner asked (2026-11-20) for a way, while controlling a PC, to pick one
//! of its open windows and have the stage show and drive just that window,
//! sized to it, with an obvious way back to the whole screen. This module is
//! the agent's half: which windows to offer, and how a stream shows one.
//! docs/REMOTE_CONTROL.md, *One window*, is the people-facing account.
//!
//! HOW A WINDOW IS SHOWN: A CROP OF ITS SCREEN, not Windows.Graphics.Capture.
//!
//! * No yellow border. `CreateForWindow` draws one, and turning it off
//!   (`GraphicsCaptureSession.IsBorderRequired = false`) needs Windows 10 build
//!   20348 or later, a `Borderless` access request that asks the person at the
//!   PC in a dialog — nobody is there on an unattended PC — and a package
//!   manifest capability an unpackaged agent does not have. The capture crate
//!   chose Desktop Duplication over WGC for exactly this reason (its header).
//! * What you see is what you click. Input lands on the SCREEN at a point; a
//!   picture of the window's own pixels would hide whatever covers it while
//!   a click there hits the cover. A crop of the screen shows the cover, which
//!   is the honest picture of where a click goes.
//! * Everything the screen path does keeps working unchanged: the one
//!   duplication per output and its sharing, the viewer fit, the pointer drawn
//!   into the picture, the early look after an input, the secure-desktop
//!   handling and the pinned-screen checks. The crop is applied to the picture
//!   in hand, just before the fit (stream.rs `pump_frame`).
//!
//! What a crop cannot do, said rather than discovered: a window that something
//! else covers shows the cover (the viewer is told when another program is in
//! front); a menu or dialog drawn outside the window's rectangle is cut off
//! (Whole screen is one press away); a minimised window has no pixels (it is
//! restored when chosen, and minimising it later goes back to the whole
//! screen); a window across two screens shows the part on the screen that
//! holds most of it.
//!
//! COORDINATES. The window's rectangle is read with
//! `DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS)`, which Microsoft
//! documents as NOT adjusted for DPI: physical pixels, the space
//! `DXGI_OUTPUT_DESC.DesktopCoordinates` (the capture) uses, whatever this
//! process's DPI awareness, and without the invisible resize border
//! `GetWindowRect` includes. Input is the other way round: this process is
//! deliberately DPI-unaware and `SendInput` normalises over the virtualised
//! GDI desktop (session.rs `resolve_target`, `CaptureSurface`). So input is
//! aimed by the crop's FRACTIONS of its screen, applied to that screen's GDI
//! rectangle (`window_target`) — never by the physical numbers themselves.

use serde::Serialize;
use std::time::{Duration, Instant};

/// At most this many windows are offered. A desk rarely has twenty; the bound
/// keeps one list inside a sealed signal whatever the machine is doing.
pub const MAX_WINDOWS: usize = 64;
/// A title is cut to this many characters (a browser tab's title can be a
/// whole sentence, and the picker shows one line of it).
pub const MAX_TITLE_CHARS: usize = 160;
/// The edge of the icon sent for each program, in pixels.
pub const ICON_EDGE: u32 = 24;
/// The smallest crop shown; below it the window is "off its screen". Not 16:
/// every size reaches the H.264 encoder (the fit never steps below 320, but a
/// crop is native), and Microsoft documents no minimum frame size for its
/// encoder MFT while documenting 48x48 for its decoder, so a strip of a
/// window left on a shared screen could end the stream with an encoder that
/// refuses it. 128 is well clear of that, and of any window anyone means.
const MIN_CROP_EDGE: u32 = 128;
/// A new window SIZE is taken once it has held this long: dragging an edge
/// produces a new size every frame, and each one reconfigures the encoder and
/// changes the viewer's picture shape. A MOVE is followed at once (same size,
/// free for the encoder).
pub(crate) const SIZE_SETTLE: Duration = Duration::from_millis(250);
/// How often a stream re-reads its window's rectangle. One DWM read; a window
/// dragged across the screen is followed at about the frame rate.
pub(crate) const READ_EVERY: Duration = Duration::from_millis(33);
/// How often it asks which program is in front.
pub(crate) const FRONT_EVERY: Duration = Duration::from_millis(250);
/// How often it re-reads its SCREEN's geometry (two enumerations): a mode or
/// scaling change, or a monitor plugged in beside it, can change the screen's
/// rectangle or the virtual desktop with the capture rebuilt in place.
pub(crate) const GEOMETRY_EVERY: Duration = Duration::from_secs(1);

/// One window the picker offers, as the host app reads it (protocol.rs
/// `Response::Windows`). Nothing here is a path: `exe` is a file name.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct WindowDesc {
    /// The `HWND`, as a number. With `pid` it is what `SetWindow` names: a
    /// handle can be reused by another window once this one closes, and the
    /// pair is checked before anything is shown.
    pub hwnd: i64,
    pub pid: u32,
    pub title: String,
    /// The program's own name for itself (its file description), else the
    /// file name without `.exe`.
    pub app: String,
    pub exe: String,
    /// The key of this window's picture in `Response::Windows.icons`, shared by
    /// windows of the same program with the same icon.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(skip_serializing_if = "is_false")]
    pub minimized: bool,
    /// Its program runs above this agent (as administrator), so Windows drops
    /// the input aimed at it (input_reach.rs). It can still be watched.
    #[serde(skip_serializing_if = "is_false")]
    pub elevated: bool,
    /// The capture index of the screen holding most of it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub monitor: Option<usize>,
}

fn is_false(b: &bool) -> bool {
    !*b
}

/// A window as `SetWindow` names it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowRef {
    pub hwnd: i64,
    pub pid: u32,
}

/// A rectangle in desktop pixels (left/top inclusive, width/height).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub left: i32,
    pub top: i32,
    pub width: i32,
    pub height: i32,
}

impl Rect {
    pub fn right(self) -> i64 {
        i64::from(self.left) + i64::from(self.width)
    }
    pub fn bottom(self) -> i64 {
        i64::from(self.top) + i64::from(self.height)
    }
    /// The overlap of two rectangles, or None when they do not overlap.
    pub fn intersect(self, other: Rect) -> Option<Rect> {
        let left = self.left.max(other.left);
        let top = self.top.max(other.top);
        let right = self.right().min(other.right());
        let bottom = self.bottom().min(other.bottom());
        if right <= i64::from(left) || bottom <= i64::from(top) {
            return None;
        }
        Some(Rect { left, top, width: (right - i64::from(left)) as i32, height: (bottom - i64::from(top)) as i32 })
    }
}

/// The part of the captured picture a window stream sends, in the picture's
/// own pixels (top-left `x`,`y`, size `w`x`h`, both even).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Crop {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

/// Desktop -> picture pixels on one axis: `v` desktop pixels from the screen's
/// edge, on a screen `mon` desktop pixels across shown as `frame` picture
/// pixels. Integer maths in i64 so no screen size can overflow.
fn to_frame(v: i64, mon: i32, frame: u32) -> i64 {
    if mon <= 0 {
        return 0;
    }
    v * i64::from(frame) / i64::from(mon)
}

/// Where `win` (physical desktop pixels) sits in the picture of `mon` (the
/// screen's physical rectangle) that is `frame_w`x`frame_h` pixels: the part
/// of the window ON that screen, made even for the encoder (which rounds to
/// even, `stream.rs` masks with `!1`; a crop of another size would be
/// misdescribed to it). None when too little of the window is on the screen
/// to show.
///
/// The frame of a single screen is that screen's desktop rectangle turned the
/// right way up (capture `rotate_to_desktop`), so the scale is 1 in practice;
/// it is computed anyway, so a picture that is not would be cropped in the
/// right place rather than the wrong one.
pub(crate) fn crop_for(win: Rect, mon: Rect, frame_w: u32, frame_h: u32) -> Option<Crop> {
    let on = win.intersect(mon)?;
    let x0 = to_frame(i64::from(on.left) - i64::from(mon.left), mon.width, frame_w);
    let y0 = to_frame(i64::from(on.top) - i64::from(mon.top), mon.height, frame_h);
    let x1 = to_frame(on.right() - i64::from(mon.left), mon.width, frame_w);
    let y1 = to_frame(on.bottom() - i64::from(mon.top), mon.height, frame_h);
    let x0 = x0.clamp(0, i64::from(frame_w));
    let y0 = y0.clamp(0, i64::from(frame_h));
    let w = ((x1.clamp(0, i64::from(frame_w)) - x0) as u32) & !1;
    let h = ((y1.clamp(0, i64::from(frame_h)) - y0) as u32) & !1;
    if w < MIN_CROP_EDGE || h < MIN_CROP_EDGE {
        return None;
    }
    Some(Crop { x: x0 as u32, y: y0 as u32, w, h })
}

/// A window smaller than the smallest crop shown, on either edge (physical
/// pixels): it is not offered, and one that shrinks below it goes back to the
/// whole screen saying so.
pub(crate) fn too_small(win: Rect) -> bool {
    win.width < MIN_CROP_EDGE as i32 || win.height < MIN_CROP_EDGE as i32
}

/// `crop` kept at `size` (the size in force while a new one settles),
/// anchored at the crop's own top-left and moved back inside the picture when
/// that size would run off its edge. A window being resized is shown at its
/// old size, following its corner, until the new size has held.
pub(crate) fn crop_at_size(crop: Crop, size: (u32, u32), frame_w: u32, frame_h: u32) -> Crop {
    let w = size.0.min(frame_w & !1);
    let h = size.1.min(frame_h & !1);
    let x = crop.x.min(frame_w.saturating_sub(w));
    let y = crop.y.min(frame_h.saturating_sub(h));
    Crop { x, y, w, h }
}

/// The desktop rectangle (physical pixels) a crop of `mon`'s picture shows:
/// what the caret is mapped over and what input is aimed at.
pub(crate) fn shown_rect(crop: Crop, mon: Rect, frame_w: u32, frame_h: u32) -> Rect {
    let back = |v: u32, mon_edge: i32, frame: u32| -> i32 {
        if frame == 0 {
            return 0;
        }
        (i64::from(v) * i64::from(mon_edge) / i64::from(frame)) as i32
    };
    Rect {
        left: mon.left + back(crop.x, mon.width, frame_w),
        top: mon.top + back(crop.y, mon.height, frame_h),
        width: back(crop.w, mon.width, frame_w),
        height: back(crop.h, mon.height, frame_h),
    }
}

/// Where injected input is aimed while a window is shown: the rectangle the
/// viewer sees (`shown`, physical pixels) as fractions of its screen (`mon`,
/// physical), laid over that screen's whole-screen target (`whole`, the GDI
/// rectangle `resolve_target` gives, in the DPI-virtualised space `SendInput`
/// normalises over). Mixing the two spaces directly is wrong by the scale
/// factor on any scaled screen — 2560 against 1707 at 150%.
pub(crate) fn window_target(shown: Rect, mon: Rect, whole: puca_input::TargetMonitor) -> puca_input::TargetMonitor {
    let map = |v: i64, mon_edge: i32, gdi_edge: i32| -> i32 {
        if mon_edge <= 0 {
            return 0;
        }
        // Rounded to the nearest pixel, not truncated: a pixel short on the
        // left edge and a pixel short on the width compound.
        ((v * i64::from(gdi_edge) * 2 + i64::from(mon_edge)) / (2 * i64::from(mon_edge))) as i32
    };
    puca_input::TargetMonitor {
        left: whole.left + map(i64::from(shown.left) - i64::from(mon.left), mon.width, whole.width),
        top: whole.top + map(i64::from(shown.top) - i64::from(mon.top), mon.height, whole.height),
        width: map(i64::from(shown.width), mon.width, whole.width).max(1),
        height: map(i64::from(shown.height), mon.height, whole.height).max(1),
        virt_left: whole.virt_left,
        virt_top: whole.virt_top,
        virt_width: whole.virt_width,
        virt_height: whole.virt_height,
    }
}

/// What the enumeration read about one top-level window, before deciding
/// whether to offer it. Plain data so the rule is tested without a desktop.
#[derive(Debug, Clone, Default)]
pub(crate) struct WindowFacts {
    pub visible: bool,
    /// DWM has it cloaked: a window on another virtual desktop, a suspended
    /// Store app, a shell surface that is not showing.
    pub cloaked: bool,
    pub tool_window: bool,
    pub app_window: bool,
    pub no_activate: bool,
    /// It has an owner window (a dialog, a floating palette).
    pub owned: bool,
    pub title: String,
    pub class: String,
    /// It belongs to this agent's own process.
    pub own_process: bool,
}

/// The desktop and the taskbar: top-level, visible and titled on some
/// Windows versions, and never a window anyone means.
const SHELL_CLASSES: [&str; 4] = ["Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd"];

/// Would Windows give this window a taskbar button (and Alt+Tab a place)?
/// That is the list people recognise as "my open windows", so it is the rule:
/// visible, not cloaked, titled, and either an ordinary unowned window that
/// can be activated or one that asked for a taskbar button (`WS_EX_APPWINDOW`).
pub(crate) fn listable(f: &WindowFacts) -> bool {
    if !f.visible || f.cloaked || f.own_process {
        return false;
    }
    if f.title.trim().is_empty() || SHELL_CLASSES.contains(&f.class.as_str()) {
        return false;
    }
    f.app_window || (!f.tool_window && !f.owned && !f.no_activate)
}

/// Text from another program, made safe to show and to carry: control
/// characters dropped (a title can contain anything, newlines included),
/// whitespace trimmed, and at most `max` characters.
pub(crate) fn clean_text(s: &str, max: usize) -> String {
    let kept: String = s.chars().filter(|c| !c.is_control()).collect();
    kept.trim().chars().take(max).collect::<String>().trim_end().to_string()
}

/// The name the picker shows for a window's program: its file description
/// ("Google Chrome"), else its file name without `.exe` ("notepad").
/// Store apps all run in the frame host, whose own name says nothing, so for
/// them the window's title is the program ("Calculator").
pub(crate) fn app_label(description: Option<&str>, exe: &str, title: &str) -> String {
    if exe.eq_ignore_ascii_case("ApplicationFrameHost.exe") && !title.trim().is_empty() {
        return clean_text(title, 64);
    }
    if let Some(d) = description.map(|d| clean_text(d, 64)).filter(|d| !d.is_empty()) {
        return d;
    }
    let stem = exe.strip_suffix(".exe").or_else(|| exe.strip_suffix(".EXE")).unwrap_or(exe);
    let stem = clean_text(stem, 64);
    if stem.is_empty() {
        "Program".to_string()
    } else {
        stem
    }
}

/// Why a window stream went back to the whole screen. The codes are the wire
/// (`SessionState.window_end`, and the viewer's sentence for each).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Gone {
    /// The window closed, or its handle now belongs to another program.
    Closed,
    Minimized,
    /// It was hidden (an app put away in the tray when its X is pressed) or
    /// cloaked (moved to another virtual desktop, or that desktop left): its
    /// rectangle is still there, with something else drawn in it.
    Hidden,
    /// It became smaller than the smallest crop shown (`MIN_CROP_EDGE`).
    Small,
    /// No part of it is on the screen being captured (moved to another one).
    Offscreen,
    /// The capture itself changed under it: another screen was chosen, or the
    /// screens were rebuilt (a display unplugged, a lid).
    Screen,
}

impl Gone {
    pub fn code(self) -> &'static str {
        match self {
            Gone::Closed => "closed",
            Gone::Minimized => "minimized",
            Gone::Hidden => "hidden",
            Gone::Small => "small",
            Gone::Offscreen => "offscreen",
            Gone::Screen => "screen",
        }
    }
}

/// The size in force, and a new one waiting to have held for `SIZE_SETTLE`.
#[derive(Debug, Default)]
pub(crate) struct SizeSettle {
    size: Option<(u32, u32)>,
    pending: Option<((u32, u32), Instant)>,
}

impl SizeSettle {
    /// The size to send now, given the size the window wants (`want`).
    pub(crate) fn settle(&mut self, want: (u32, u32), now: Instant) -> (u32, u32) {
        let Some(size) = self.size else {
            self.size = Some(want);
            return want;
        };
        if want == size {
            self.pending = None;
            return size;
        }
        match self.pending {
            Some((p, since)) if p == want => {
                if now.duration_since(since) >= SIZE_SETTLE {
                    self.size = Some(want);
                    self.pending = None;
                    want
                } else {
                    size
                }
            }
            _ => {
                self.pending = Some((want, now));
                size
            }
        }
    }
}

/// What a stream asks the system about its window: a seam, so every decision
/// in `WindowTrack` is tested with a scripted desktop.
pub(crate) trait WindowOs {
    /// Is the handle a window at all (`IsWindow`)?
    fn alive(&self, hwnd: i64) -> bool;
    /// The process that owns it now.
    fn pid(&self, hwnd: i64) -> u32;
    fn iconic(&self, hwnd: i64) -> bool;
    /// It is showing: visible and not cloaked (the list's own test).
    fn shown(&self, hwnd: i64) -> bool;
    /// Its rectangle in PHYSICAL desktop pixels (the DWM frame bounds).
    fn rect(&self, hwnd: i64) -> Option<Rect>;
    /// The screen holding most of it, by HMONITOR.
    fn monitor(&self, hwnd: i64) -> Option<isize>;
    /// The process whose window is in front (keys go there).
    fn foreground_pid(&self) -> Option<u32>;
}

/// One window being shown by a stream.
#[derive(Debug)]
pub(crate) struct WindowTrack {
    pub window: WindowRef,
    /// The capture index it is cropped from, and that screen's handle.
    pub monitor: usize,
    pub monitor_handle: Option<isize>,
    /// That screen's physical rectangle (the capture's), and its whole-screen
    /// input target (GDI), both read when the window was chosen.
    mon_phys: Rect,
    whole_target: Option<puca_input::TargetMonitor>,
    settle: SizeSettle,
    read_at: Option<Instant>,
    front_at: Option<Instant>,
    geometry_at: Option<Instant>,
    crop: Option<Crop>,
    shown: Option<Rect>,
    /// The input target last set, so it is set again only when it moves.
    aimed: Option<(i32, i32, i32, i32)>,
    /// Its program is the one in front (keys reach it).
    pub front: bool,
    /// Another screen holds most of it now (its HMONITOR): the host app may
    /// follow it there if that screen was shared.
    pub elsewhere: Option<isize>,
}

/// What one look at the window found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Tick {
    /// Nothing the stream must act on (the crop may have moved; `crop()` has it).
    Showing,
    /// It cannot be shown any more: go back to the whole screen.
    Gone(Gone),
}

impl WindowTrack {
    pub(crate) fn new(
        window: WindowRef,
        monitor: usize,
        monitor_handle: Option<isize>,
        mon_phys: Rect,
        whole_target: Option<puca_input::TargetMonitor>,
    ) -> Self {
        Self {
            window,
            monitor,
            monitor_handle,
            mon_phys,
            whole_target,
            settle: SizeSettle::default(),
            read_at: None,
            front_at: None,
            geometry_at: None,
            crop: None,
            shown: None,
            aimed: None,
            front: true,
            elsewhere: None,
        }
    }

    pub(crate) fn crop(&self) -> Option<Crop> {
        self.crop
    }

    /// Its screen's physical rectangle, as the crop is worked out against it.
    pub(crate) fn mon_phys(&self) -> Rect {
        self.mon_phys
    }

    /// The size of its screen's picture when it was chosen: what the crop is
    /// worked out against until a picture of the screen is in hand.
    pub(crate) fn screen_size(&self) -> (u32, u32) {
        (self.mon_phys.width.max(0) as u32, self.mon_phys.height.max(0) as u32)
    }

    /// The physical desktop rectangle the picture shows now.
    pub(crate) fn shown(&self) -> Option<Rect> {
        self.shown
    }

    /// Look at the window (at most every `READ_EVERY`, unless `force`), and
    /// work out the crop for a picture of `frame_w`x`frame_h`.
    pub(crate) fn tick(
        &mut self,
        os: &impl WindowOs,
        now: Instant,
        frame_w: u32,
        frame_h: u32,
        force: bool,
    ) -> Tick {
        let due = force || self.read_at.is_none_or(|t| now.duration_since(t) >= READ_EVERY);
        if !due && self.crop.is_some() {
            return Tick::Showing;
        }
        self.read_at = Some(now);
        let hwnd = self.window.hwnd;
        if !os.alive(hwnd) || os.pid(hwnd) != self.window.pid {
            return Tick::Gone(Gone::Closed);
        }
        if os.iconic(hwnd) {
            return Tick::Gone(Gone::Minimized);
        }
        // A window hidden to the tray, or cloaked on another virtual desktop,
        // keeps its rectangle; cropping it would show (and click) whatever is
        // drawn there now.
        if !os.shown(hwnd) {
            return Tick::Gone(Gone::Hidden);
        }
        let Some(win) = os.rect(hwnd) else {
            // A window that will not say where it is, for one look, is not
            // gone; one that never says is closed in all but name.
            return if self.crop.is_some() { Tick::Showing } else { Tick::Gone(Gone::Closed) };
        };
        // Shrunk below the smallest crop shown: said as that, not as a move
        // (crop_for's None below is "not enough of it on this screen").
        if too_small(win) {
            return Tick::Gone(Gone::Small);
        }
        let Some(full) = crop_for(win, self.mon_phys, frame_w, frame_h) else {
            return Tick::Gone(Gone::Offscreen);
        };
        let size = self.settle.settle((full.w, full.h), now);
        let crop = crop_at_size(full, size, frame_w, frame_h);
        self.crop = Some(crop);
        self.shown = Some(shown_rect(crop, self.mon_phys, frame_w, frame_h));
        let on = os.monitor(hwnd);
        self.elsewhere = match (on, self.monitor_handle) {
            (Some(h), Some(own)) if h != own => Some(h),
            _ => None,
        };
        if force || self.front_at.is_none_or(|t| now.duration_since(t) >= FRONT_EVERY) {
            self.front_at = Some(now);
            // Unknown (no window in front, a protected one) reads as in front:
            // this only ever offers a hint.
            self.front = os.foreground_pid().is_none_or(|p| p == self.window.pid);
        }
        Tick::Showing
    }

    /// The input target for what is shown now, when it differs from the one
    /// last handed out (`None`: nothing to change). Marks it handed out.
    pub(crate) fn retarget(&mut self) -> Option<puca_input::TargetMonitor> {
        let shown = self.shown?;
        let whole = self.whole_target?;
        let t = window_target(shown, self.mon_phys, whole);
        let key = (t.left, t.top, t.width, t.height);
        if self.aimed == Some(key) {
            return None;
        }
        self.aimed = Some(key);
        Some(t)
    }

    /// Is its screen's geometry due a re-read (`GEOMETRY_EVERY`)? Marks it read.
    pub(crate) fn geometry_due(&mut self, now: Instant) -> bool {
        if self.geometry_at.is_some_and(|t| now.duration_since(t) < GEOMETRY_EVERY) {
            return false;
        }
        self.geometry_at = Some(now);
        true
    }

    /// Its screen as read again: `mon` its physical rectangle now (None when
    /// the screen at its index is gone or is another screen), `whole` its
    /// whole-screen input target now. The screen's own rectangle changing
    /// (a mode change, a rotation) is the picture changing under the crop:
    /// back to the whole screen. A new whole-screen target with the same
    /// rectangle (the virtual desktop grew, or the scaling changed) is taken,
    /// and input is aimed again at the next look.
    pub(crate) fn regeometry(
        &mut self,
        mon: Option<Rect>,
        whole: Option<puca_input::TargetMonitor>,
    ) -> Result<(), Gone> {
        if mon != Some(self.mon_phys) {
            return Err(Gone::Screen);
        }
        let same = |a: &puca_input::TargetMonitor, b: &puca_input::TargetMonitor| {
            (a.left, a.top, a.width, a.height, a.virt_left, a.virt_top, a.virt_width, a.virt_height)
                == (b.left, b.top, b.width, b.height, b.virt_left, b.virt_top, b.virt_width, b.virt_height)
        };
        let changed = match (&self.whole_target, &whole) {
            (Some(a), Some(b)) => !same(a, b),
            (None, None) => false,
            _ => true,
        };
        if changed {
            self.whole_target = whole;
            self.aimed = None;
        }
        Ok(())
    }

    /// The caret surface: what the picture shows, in physical pixels.
    pub(crate) fn surface(&self) -> Option<crate::session::CaptureSurface> {
        self.shown.map(|r| crate::session::CaptureSurface::Single {
            left: r.left,
            top: r.top,
            width: r.width,
            height: r.height,
        })
    }
}

/// What a stream says about its window, for `SessionStatus`: shared between
/// the stream thread (writer) and the agent (reader).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WindowStatus {
    /// The window shown now.
    pub active: Option<WindowRef>,
    /// Why the last one stopped being shown (cleared by the next choice).
    pub ended: Option<Gone>,
    /// The screen it was on when it ended `Offscreen` (its HMONITOR).
    pub ended_on: Option<isize>,
    /// Its program is in front.
    pub front: bool,
    /// Another screen holds most of it now (HMONITOR).
    pub elsewhere: Option<isize>,
    /// What the picture shows of it, physical pixels: the viewer's surface
    /// for the caret, which a resize changes.
    pub size: Option<(u32, u32)>,
}

/// Where a crop of a picture can be read WITHOUT copying it: the byte offset
/// of its top-left pixel, when the slice from there is long enough for an
/// encoder that wants `stride * h` bytes (puca-encode checks exactly that).
/// None when the crop runs to the picture's last row and does not start at
/// its left edge: then the last row's tail is short by `x * 4` bytes, and the
/// crop is copied instead.
pub(crate) fn borrowable_offset(crop: Crop, frame_h: u32, stride: usize, len: usize) -> Option<usize> {
    let offset = crop.y as usize * stride + crop.x as usize * 4;
    let need = crop.h as usize * stride;
    let _ = frame_h;
    (len >= offset && len - offset >= need).then_some(offset)
}

/// A crop made to fit a picture of `frame_w`x`frame_h` (a picture whose size
/// changed since the crop was worked out, a display mode changed under it):
/// cut to the picture and moved inside it, even, or None when too little is
/// left to show.
pub(crate) fn clamp_crop(c: Crop, frame_w: u32, frame_h: u32) -> Option<Crop> {
    let w = c.w.min(frame_w & !1);
    let h = c.h.min(frame_h & !1);
    if w < MIN_CROP_EDGE || h < MIN_CROP_EDGE {
        return None;
    }
    Some(Crop { x: c.x.min(frame_w - w), y: c.y.min(frame_h - h), w, h })
}

/// Copy a crop out of a picture into `out` (rows `w * 4` bytes apart).
pub(crate) fn copy_crop(bgra: &[u8], stride: usize, crop: Crop, out: &mut Vec<u8>) {
    let row = crop.w as usize * 4;
    out.clear();
    out.reserve(row * crop.h as usize);
    for r in 0..crop.h as usize {
        let at = (crop.y as usize + r) * stride + crop.x as usize * 4;
        match bgra.get(at..at + row) {
            Some(px) => out.extend_from_slice(px),
            None => out.resize(out.len() + row, 0),
        }
    }
}

// ---------------------------------------------------------------- icons --

/// One pixel of an icon drawn twice, on black and on white, back to straight
/// RGBA. A pixel drawn with alpha `a` over black is `c*a`, over white
/// `c*a + 255*(1-a)`, so their difference is `255*(1-a)` on every channel.
/// This recovers the alpha of ANY icon — 32-bit with alpha, or the older
/// colour-and-mask kind GDI draws with no alpha at all — without trusting
/// what `DrawIconEx` leaves in a DIB's alpha byte, which depends on the kind.
pub(crate) fn unblend(on_black: [u8; 3], on_white: [u8; 3]) -> [u8; 4] {
    let diff: u32 = (0..3).map(|i| u32::from(on_white[i].saturating_sub(on_black[i]))).sum::<u32>();
    let a = 255u32.saturating_sub((diff + 1) / 3);
    if a == 0 {
        return [0, 0, 0, 0];
    }
    let c = |v: u8| ((u32::from(v) * 255 + a / 2) / a).min(255) as u8;
    [c(on_black[0]), c(on_black[1]), c(on_black[2]), a as u8]
}

/// CRC-32 (ISO-HDLC, the one PNG uses).
pub(crate) fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &b in data {
        crc ^= u32::from(b);
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
        }
    }
    !crc
}

/// Adler-32, the zlib stream's checksum.
pub(crate) fn adler32(data: &[u8]) -> u32 {
    let (mut a, mut b) = (1u32, 0u32);
    for &x in data {
        a = (a + u32::from(x)) % 65_521;
        b = (b + a) % 65_521;
    }
    (b << 16) | a
}

/// A PNG of `rgba` (`w`x`h`, straight alpha, top-down), its pixels in STORED
/// deflate blocks: no compression, so no compressor to get wrong. A 24 px
/// icon is about 2.4 KB of PNG this way, which a sealed signal carries a dozen
/// at a time. No dependency was added for it: the agent has no image crate,
/// and a stored block is a length, its complement and the bytes.
pub(crate) fn png_rgba(w: u32, h: u32, rgba: &[u8]) -> Vec<u8> {
    let row = w as usize * 4;
    let mut raw = Vec::with_capacity((row + 1) * h as usize);
    for y in 0..h as usize {
        raw.push(0); // filter: none
        let at = y * row;
        match rgba.get(at..at + row) {
            Some(px) => raw.extend_from_slice(px),
            None => raw.resize(raw.len() + row, 0),
        }
    }
    let mut z = vec![0x78, 0x01];
    let mut chunks = raw.chunks(65_535).peekable();
    if chunks.peek().is_none() {
        z.extend_from_slice(&[1, 0, 0, 0xFF, 0xFF]);
    }
    while let Some(block) = chunks.next() {
        let last = chunks.peek().is_none();
        z.push(u8::from(last));
        let len = block.len() as u16;
        z.extend_from_slice(&len.to_le_bytes());
        z.extend_from_slice(&(!len).to_le_bytes());
        z.extend_from_slice(block);
    }
    z.extend_from_slice(&adler32(&raw).to_be_bytes());

    let mut out = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    let mut chunk = |kind: &[u8; 4], data: &[u8]| {
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        let mut crc_in = Vec::with_capacity(4 + data.len());
        crc_in.extend_from_slice(kind);
        crc_in.extend_from_slice(data);
        out.extend_from_slice(&crc_in);
        out.extend_from_slice(&crc32(&crc_in).to_be_bytes());
    };
    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&w.to_be_bytes());
    ihdr.extend_from_slice(&h.to_be_bytes());
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]); // 8-bit RGBA, deflate, adaptive filter, no interlace
    chunk(b"IHDR", &ihdr);
    chunk(b"IDAT", &z);
    chunk(b"IEND", &[]);
    out
}

/// The icon key for a picture: windows of one program usually share one, and
/// the list carries each picture once.
pub(crate) fn icon_key(png: &[u8]) -> String {
    format!("i{:08x}{:04x}", crc32(png), png.len() as u16)
}

// ------------------------------------------------------------ Windows ---

#[cfg(windows)]
pub(crate) use live::{bring_forward, list_windows, LiveWindows};

#[cfg(windows)]
mod live {
    use super::*;
    use std::collections::BTreeMap;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{BOOL, HWND, LPARAM, RECT};
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS};
    use windows::Win32::Graphics::Gdi::{MonitorFromWindow, MONITOR_DEFAULTTONEAREST};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetForegroundWindow, GetWindow, GetWindowLongPtrW, GetWindowRect, GetWindowTextW,
        GetClassNameW, GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible, GWL_EXSTYLE,
        GW_OWNER, WS_EX_APPWINDOW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    };

    pub(crate) fn hwnd(h: i64) -> HWND {
        HWND(h as isize as *mut core::ffi::c_void)
    }

    /// The real desktop, for a stream's `WindowTrack`.
    pub(crate) struct LiveWindows;

    impl WindowOs for LiveWindows {
        fn alive(&self, h: i64) -> bool {
            unsafe { IsWindow(hwnd(h)) }.as_bool()
        }
        fn pid(&self, h: i64) -> u32 {
            let mut pid = 0u32;
            unsafe { GetWindowThreadProcessId(hwnd(h), Some(&mut pid)) };
            pid
        }
        fn iconic(&self, h: i64) -> bool {
            unsafe { IsIconic(hwnd(h)) }.as_bool()
        }
        fn shown(&self, h: i64) -> bool {
            unsafe { IsWindowVisible(hwnd(h)) }.as_bool() && !cloaked(hwnd(h))
        }
        fn rect(&self, h: i64) -> Option<Rect> {
            frame_bounds(hwnd(h))
        }
        fn monitor(&self, h: i64) -> Option<isize> {
            let m = unsafe { MonitorFromWindow(hwnd(h), MONITOR_DEFAULTTONEAREST) };
            (!m.0.is_null()).then_some(m.0 as isize)
        }
        fn foreground_pid(&self) -> Option<u32> {
            let fg = unsafe { GetForegroundWindow() };
            if fg.0.is_null() {
                return None;
            }
            let mut pid = 0u32;
            unsafe { GetWindowThreadProcessId(fg, Some(&mut pid)) };
            (pid != 0).then_some(pid)
        }
    }

    /// The window's visible frame in PHYSICAL pixels (module header). Falls
    /// back to `GetWindowRect` only for a window DWM does not frame, which
    /// on a current Windows is none that the picker offers.
    fn frame_bounds(h: HWND) -> Option<Rect> {
        let mut r = RECT::default();
        let dwm = unsafe {
            DwmGetWindowAttribute(
                h,
                DWMWA_EXTENDED_FRAME_BOUNDS,
                &mut r as *mut RECT as *mut core::ffi::c_void,
                std::mem::size_of::<RECT>() as u32,
            )
        };
        if dwm.is_err() && unsafe { GetWindowRect(h, &mut r) }.is_err() {
            return None;
        }
        let width = r.right.checked_sub(r.left)?;
        let height = r.bottom.checked_sub(r.top)?;
        (width > 0 && height > 0).then_some(Rect { left: r.left, top: r.top, width, height })
    }

    fn cloaked(h: HWND) -> bool {
        let mut v = 0u32;
        let ok = unsafe {
            DwmGetWindowAttribute(h, DWMWA_CLOAKED, &mut v as *mut u32 as *mut core::ffi::c_void, 4)
        };
        ok.is_ok() && v != 0
    }

    fn text_of(h: HWND, class: bool) -> String {
        let mut buf = [0u16; 512];
        let n = unsafe { if class { GetClassNameW(h, &mut buf) } else { GetWindowTextW(h, &mut buf) } };
        String::from_utf16_lossy(&buf[..n.clamp(0, buf.len() as i32) as usize])
    }

    pub(crate) fn facts(h: HWND, me: u32) -> (WindowFacts, u32) {
        let ex = unsafe { GetWindowLongPtrW(h, GWL_EXSTYLE) } as u32;
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(h, Some(&mut pid)) };
        let owner = unsafe { GetWindow(h, GW_OWNER) }.ok().filter(|o| !o.0.is_null());
        (
            WindowFacts {
                visible: unsafe { IsWindowVisible(h) }.as_bool(),
                cloaked: cloaked(h),
                tool_window: ex & WS_EX_TOOLWINDOW.0 != 0,
                app_window: ex & WS_EX_APPWINDOW.0 != 0,
                no_activate: ex & WS_EX_NOACTIVATE.0 != 0,
                owned: owner.is_some(),
                title: text_of(h, false),
                class: text_of(h, true),
                own_process: pid == me,
            },
            pid,
        )
    }

    unsafe extern "system" fn collect(h: HWND, lparam: LPARAM) -> BOOL {
        let list = &mut *(lparam.0 as *mut Vec<HWND>);
        list.push(h);
        BOOL(1)
    }

    /// Every top-level window, in Z order (front first).
    pub(crate) fn top_level() -> Vec<HWND> {
        let mut list: Vec<HWND> = Vec::new();
        let _ = unsafe { EnumWindows(Some(collect), LPARAM(&mut list as *mut Vec<HWND> as isize)) };
        list
    }

    /// The windows the picker offers, in Z order (the one in front first),
    /// and the pictures their `icon` keys name, each as a `data:` URL.
    ///
    /// The time spent asking programs for their icons is bounded: a program
    /// that is slow to answer `WM_GETICON` (not hung — those are skipped at
    /// once) could otherwise hold the host app's pipe, and the input behind
    /// it, for 30 ms a window.
    pub(crate) fn list_windows() -> (Vec<WindowDesc>, BTreeMap<String, String>) {
        let me = std::process::id();
        let outputs = puca_capture::outputs();
        let own_level = crate::input_reach::own_level();
        let started = Instant::now();
        let mut icons: BTreeMap<String, String> = BTreeMap::new();
        let mut out = Vec::new();
        for h in top_level() {
            if out.len() >= MAX_WINDOWS {
                break;
            }
            let (f, pid) = facts(h, me);
            if !listable(&f) {
                continue;
            }
            // Too small to show on its own (a minimised window's rectangle
            // says nothing about the size it comes back at, so it stays).
            if !unsafe { IsIconic(h) }.as_bool() && frame_bounds(h).is_some_and(too_small) {
                continue;
            }
            let image = crate::input_reach::process_image(pid);
            let (exe, description, elevated) = match &image {
                Some((owner, path)) => (
                    crate::input_reach::app_name(path).unwrap_or_default(),
                    file_description(path),
                    own_level.is_some_and(|own| crate::input_reach::blocks(own, *owner)),
                ),
                None => (String::new(), None, false),
            };
            let title = clean_text(&f.title, MAX_TITLE_CHARS);
            let monitor = {
                let m = unsafe { MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST) };
                outputs.iter().find(|o| o.hmonitor != 0 && o.hmonitor == m.0 as isize).map(|o| o.index)
            };
            let may_ask = started.elapsed() < Duration::from_millis(400);
            let icon = super::icons::icon_png(h, may_ask).map(|png| {
                let key = icon_key(&png);
                icons.entry(key.clone()).or_insert_with(|| {
                    use base64::Engine;
                    format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(&png))
                });
                key
            });
            out.push(WindowDesc {
                hwnd: h.0 as isize as i64,
                pid,
                app: app_label(description.as_deref(), &exe, &title),
                title,
                exe,
                icon,
                minimized: unsafe { IsIconic(h) }.as_bool(),
                elevated,
                monitor,
            });
        }
        (out, icons)
    }

    /// The program's own name for itself, from its version resource. Cached
    /// per path: the picker is opened again and again, and a file's
    /// description does not change while it runs.
    fn file_description(path: &str) -> Option<String> {
        use std::collections::HashMap;
        use std::sync::Mutex;
        use windows::Win32::Storage::FileSystem::{GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW};
        static CACHE: Mutex<Option<HashMap<String, Option<String>>>> = Mutex::new(None);
        if let Ok(c) = CACHE.lock() {
            if let Some(hit) = c.as_ref().and_then(|m| m.get(path)) {
                return hit.clone();
            }
        }
        let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
        let read = || -> Option<String> {
            let size = unsafe { GetFileVersionInfoSizeW(PCWSTR(wide.as_ptr()), None) };
            if size == 0 || size > 4 * 1024 * 1024 {
                return None;
            }
            let mut block = vec![0u8; size as usize];
            unsafe { GetFileVersionInfoW(PCWSTR(wide.as_ptr()), 0, size, block.as_mut_ptr() as *mut _) }.ok()?;
            let query = |sub: &str| -> Option<(*const u8, u32)> {
                let w: Vec<u16> = sub.encode_utf16().chain(std::iter::once(0)).collect();
                let mut p: *mut core::ffi::c_void = std::ptr::null_mut();
                let mut len = 0u32;
                let ok = unsafe { VerQueryValueW(block.as_ptr() as *const _, PCWSTR(w.as_ptr()), &mut p, &mut len) };
                (ok.as_bool() && !p.is_null() && len > 0).then_some((p as *const u8, len))
            };
            // The first language the file lists, else US English in Unicode.
            let lang = query("\\VarFileInfo\\Translation")
                .filter(|&(_, len)| len >= 4)
                .map(|(p, _)| unsafe {
                    let words = std::slice::from_raw_parts(p as *const u16, 2);
                    (words[0], words[1])
                })
                .unwrap_or((0x0409, 0x04B0));
            let (p, len) = query(&format!("\\StringFileInfo\\{:04x}{:04x}\\FileDescription", lang.0, lang.1))?;
            let chars = unsafe { std::slice::from_raw_parts(p as *const u16, len as usize) };
            let end = chars.iter().position(|&c| c == 0).unwrap_or(chars.len());
            let text = clean_text(&String::from_utf16_lossy(&chars[..end]), 64);
            (!text.is_empty()).then_some(text)
        };
        let found = read();
        if let Ok(mut c) = CACHE.lock() {
            let m = c.get_or_insert_with(HashMap::new);
            if m.len() > 256 {
                m.clear();
            }
            m.insert(path.to_string(), found.clone());
        }
        found
    }

    /// The operating-system half of bringing a chosen window forward, behind
    /// a seam so the order is tested without touching the owner's desktop.
    pub(crate) trait FrontOs {
        fn iconic(&self, h: i64) -> bool;
        fn restore(&self, h: i64);
        fn set_foreground(&self, h: i64) -> bool;
        fn sleep(&self, d: Duration);
    }

    /// The real one. A test build refuses to run it: no test may restore,
    /// raise or focus a window on the machine it runs on.
    pub(crate) struct LiveFront;

    impl FrontOs for LiveFront {
        fn iconic(&self, h: i64) -> bool {
            unsafe { IsIconic(hwnd(h)) }.as_bool()
        }
        fn restore(&self, h: i64) {
            use windows::Win32::UI::WindowsAndMessaging::{ShowWindowAsync, SW_RESTORE};
            assert!(!cfg!(test), "a test reached the real window restore ({h})");
            // ASYNC: posted, never waited on, so a hung program cannot hold
            // the pipe (and everything queued behind it).
            let _ = unsafe { ShowWindowAsync(hwnd(h), SW_RESTORE) };
        }
        fn set_foreground(&self, h: i64) -> bool {
            use windows::Win32::UI::WindowsAndMessaging::SetForegroundWindow;
            assert!(!cfg!(test), "a test reached the real SetForegroundWindow ({h})");
            unsafe { SetForegroundWindow(hwnd(h)) }.as_bool()
        }
        fn sleep(&self, d: Duration) {
            std::thread::sleep(d);
        }
    }

    /// What bringing a window forward came to.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub(crate) struct Forward {
        /// Still minimised after the wait: it cannot be shown.
        pub still_minimized: bool,
        /// Windows let it come to the front.
        pub front: bool,
    }

    /// Restore a minimised window and wait (at most 600 ms) for it to come
    /// back, then ask Windows to put it in front. ONLY `SetForegroundWindow`,
    /// which Windows may refuse (the foreground lock): no injected Alt key, no
    /// `AttachThreadInput` (Raymond Chen documents that attaching input queues
    /// hangs). A refusal leaves it behind whatever is in front; the viewer is
    /// told, and a click into it brings it forward the way any click does.
    pub(crate) fn bring_forward_with(os: &impl FrontOs, h: i64) -> Forward {
        if os.iconic(h) {
            os.restore(h);
            let mut waited = Duration::ZERO;
            while os.iconic(h) && waited < Duration::from_millis(600) {
                os.sleep(Duration::from_millis(30));
                waited += Duration::from_millis(30);
            }
            if os.iconic(h) {
                return Forward { still_minimized: true, front: false };
            }
        }
        Forward { still_minimized: false, front: os.set_foreground(h) }
    }

    pub(crate) fn bring_forward(h: i64) -> Forward {
        bring_forward_with(&LiveFront, h)
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::cell::RefCell;

        /// A window that stays minimised for `restores_after` looks.
        struct Scripted {
            iconic_looks: RefCell<u32>,
            calls: RefCell<Vec<&'static str>>,
            foreground_ok: bool,
        }
        impl FrontOs for Scripted {
            fn iconic(&self, _h: i64) -> bool {
                let mut n = self.iconic_looks.borrow_mut();
                if *n == 0 {
                    return false;
                }
                *n -= 1;
                true
            }
            fn restore(&self, _h: i64) {
                self.calls.borrow_mut().push("restore");
            }
            fn set_foreground(&self, _h: i64) -> bool {
                self.calls.borrow_mut().push("foreground");
                self.foreground_ok
            }
            fn sleep(&self, _d: Duration) {
                self.calls.borrow_mut().push("sleep");
            }
        }

        #[test]
        fn a_minimised_window_is_restored_before_it_is_raised() {
            let os = Scripted { iconic_looks: RefCell::new(3), calls: RefCell::new(vec![]), foreground_ok: true };
            let f = bring_forward_with(&os, 1);
            assert_eq!(f, Forward { still_minimized: false, front: true });
            let calls = os.calls.borrow();
            assert_eq!(calls.first(), Some(&"restore"));
            assert_eq!(calls.last(), Some(&"foreground"), "raised only once it is back: {calls:?}");
        }

        #[test]
        fn a_window_that_never_comes_back_is_not_raised() {
            let os = Scripted { iconic_looks: RefCell::new(1000), calls: RefCell::new(vec![]), foreground_ok: true };
            let f = bring_forward_with(&os, 1);
            assert!(f.still_minimized);
            assert!(!os.calls.borrow().contains(&"foreground"));
            // 600 ms in 30 ms steps: bounded, never a hang.
            assert_eq!(os.calls.borrow().iter().filter(|c| **c == "sleep").count(), 20);
        }

        #[test]
        fn an_open_window_is_only_asked_to_come_forward_and_a_refusal_is_reported() {
            let os = Scripted { iconic_looks: RefCell::new(0), calls: RefCell::new(vec![]), foreground_ok: false };
            let f = bring_forward_with(&os, 1);
            assert_eq!(f, Forward { still_minimized: false, front: false });
            assert_eq!(*os.calls.borrow(), vec!["foreground"], "no restore, no sleep, no second attempt");
        }

        #[test]
        #[should_panic(expected = "a test reached the real SetForegroundWindow")]
        fn the_real_raise_refuses_to_run_in_a_test() {
            // The guard itself: should anything above ever hand a test the
            // live seam, it stops before touching the desktop. Asked about
            // handle 0, so even a broken guard would raise nothing.
            let _ = LiveFront.set_foreground(0);
        }

        #[test]
        #[should_panic(expected = "a test reached the real window restore")]
        fn the_real_restore_refuses_to_run_in_a_test() {
            LiveFront.restore(0);
        }
    }
}

#[cfg(windows)]
mod icons {
    use super::*;
    use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GdiFlush, SelectObject, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        DrawIconEx, GetClassLongPtrW, SendMessageTimeoutW, DI_NORMAL, GCLP_HICON, GCLP_HICONSM, HICON,
        ICON_BIG, ICON_SMALL2, SMTO_ABORTIFHUNG, SMTO_BLOCK, WM_GETICON,
    };

    /// The window's icon as a PNG, `ICON_EDGE` px square: what the window
    /// says (`WM_GETICON`, asked only while `may_ask`; `SMTO_ABORTIFHUNG`
    /// skips a hung program at once), else its class's. None when it has
    /// neither; the viewer draws a plain window glyph. These icons belong to
    /// the window or its class, so none is destroyed here.
    pub(crate) fn icon_png(h: HWND, may_ask: bool) -> Option<Vec<u8>> {
        let mut found: Option<HICON> = None;
        if may_ask {
            for kind in [ICON_BIG, ICON_SMALL2] {
                let mut res = 0usize;
                let ok = unsafe {
                    SendMessageTimeoutW(
                        h,
                        WM_GETICON,
                        WPARAM(kind as usize),
                        LPARAM(0),
                        SMTO_ABORTIFHUNG | SMTO_BLOCK,
                        30,
                        Some(&mut res),
                    )
                };
                if ok.0 != 0 && res != 0 {
                    found = Some(HICON(res as *mut core::ffi::c_void));
                    break;
                }
            }
        }
        if found.is_none() {
            for idx in [GCLP_HICON, GCLP_HICONSM] {
                let v = unsafe { GetClassLongPtrW(h, idx) };
                if v != 0 {
                    found = Some(HICON(v as *mut core::ffi::c_void));
                    break;
                }
            }
        }
        let rgba = render(found?)?;
        Some(png_rgba(ICON_EDGE, ICON_EDGE, &rgba))
    }

    /// Draw the icon at `ICON_EDGE` px on black and on white and recover its
    /// straight RGBA (`unblend`). None when nothing was drawn.
    pub(crate) fn render(icon: HICON) -> Option<Vec<u8>> {
        let edge = ICON_EDGE as i32;
        let n = (ICON_EDGE * ICON_EDGE) as usize;
        let mut on: [Vec<u8>; 2] = [Vec::new(), Vec::new()];
        unsafe {
            let dc = CreateCompatibleDC(None);
            if dc.is_invalid() {
                return None;
            }
            let info = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: edge,
                    biHeight: -edge, // top-down
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
            let Ok(bmp) = CreateDIBSection(dc, &info, DIB_RGB_COLORS, &mut bits, None, 0) else {
                let _ = DeleteDC(dc);
                return None;
            };
            let old = SelectObject(dc, bmp);
            for (i, fill) in [0u8, 255u8].into_iter().enumerate() {
                std::ptr::write_bytes(bits as *mut u8, fill, n * 4);
                let drew = DrawIconEx(dc, 0, 0, icon, edge, edge, 0, None, DI_NORMAL);
                let _ = GdiFlush();
                if drew.is_err() {
                    break;
                }
                on[i] = std::slice::from_raw_parts(bits as *const u8, n * 4).to_vec();
            }
            SelectObject(dc, old);
            let _ = DeleteObject(bmp);
            let _ = DeleteDC(dc);
        }
        let [black, white] = on;
        if black.len() != n * 4 || white.len() != n * 4 {
            return None;
        }
        let mut rgba = Vec::with_capacity(n * 4);
        for (b, w) in black.chunks_exact(4).zip(white.chunks_exact(4)) {
            // The DIB is BGRA; `unblend` and the PNG are RGB(A).
            let px = unblend([b[2], b[1], b[0]], [w[2], w[1], w[0]]);
            rgba.extend_from_slice(&px);
        }
        rgba.chunks_exact(4).any(|p| p[3] != 0).then_some(rgba)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(left: i32, top: i32, width: i32, height: i32) -> Rect {
        Rect { left, top, width, height }
    }

    fn facts(title: &str) -> WindowFacts {
        WindowFacts { visible: true, title: title.into(), class: "Notepad".into(), ..Default::default() }
    }

    #[test]
    fn an_ordinary_window_is_offered() {
        assert!(listable(&facts("notes.txt - Notepad")));
    }

    #[test]
    fn what_the_taskbar_leaves_out_the_picker_leaves_out() {
        // Each one fails for its own reason, against the positive control above.
        let cases: [(&str, fn(&mut WindowFacts)); 8] = [
            ("hidden", |f| f.visible = false),
            ("cloaked (another virtual desktop, a suspended Store app)", |f| f.cloaked = true),
            ("untitled", |f| f.title = "   ".into()),
            ("a tool window", |f| f.tool_window = true),
            ("owned (a dialog, a palette)", |f| f.owned = true),
            ("never activated", |f| f.no_activate = true),
            ("this agent's own", |f| f.own_process = true),
            ("the desktop itself", |f| f.class = "Progman".into()),
        ];
        for (why, change) in cases {
            let mut f = facts("x");
            change(&mut f);
            assert!(!listable(&f), "a window that is {why} must not be offered");
        }
    }

    #[test]
    fn a_window_that_asks_for_a_taskbar_button_is_offered_even_when_owned() {
        let mut f = facts("Download progress");
        f.owned = true;
        f.tool_window = true;
        f.app_window = true;
        assert!(listable(&f), "WS_EX_APPWINDOW puts a window on the taskbar whatever else it is");
        f.cloaked = true;
        assert!(!listable(&f), "but not one that is not showing");
    }

    #[test]
    fn a_title_is_cleaned_and_bounded() {
        assert_eq!(clean_text("  a\u{0}b\nc\u{7}  ", 10), "abc");
        let long = "x".repeat(500);
        assert_eq!(clean_text(&long, MAX_TITLE_CHARS).chars().count(), MAX_TITLE_CHARS);
        // Characters, not bytes: a title in another script is not cut mid-letter.
        assert_eq!(clean_text("ééééé", 3), "ééé");
    }

    #[test]
    fn the_program_is_named_as_it_names_itself() {
        assert_eq!(app_label(Some("Google Chrome"), "chrome.exe", "Inbox"), "Google Chrome");
        assert_eq!(app_label(None, "notepad.exe", "x"), "notepad");
        assert_eq!(app_label(Some("  "), "GAME.EXE", "x"), "GAME");
        assert_eq!(app_label(Some("Application Frame Host"), "ApplicationFrameHost.exe", "Calculator"), "Calculator");
        assert_eq!(app_label(None, "", ""), "Program");
    }

    #[test]
    fn a_window_inside_its_screen_is_cropped_exactly() {
        // Screen 1920x1080 at the origin, window 800x600 at (100, 50).
        let c = crop_for(r(100, 50, 800, 600), r(0, 0, 1920, 1080), 1920, 1080).unwrap();
        assert_eq!(c, Crop { x: 100, y: 50, w: 800, h: 600 });
    }

    #[test]
    fn a_window_on_a_screen_left_of_and_above_the_main_one_is_cropped_from_that_screen() {
        // Secondary monitors are legitimately NEGATIVE.
        let mon = r(-1440, -700, 1440, 2560);
        let c = crop_for(r(-1300, -600, 1001, 801), mon, 1440, 2560).unwrap();
        assert_eq!(c, Crop { x: 140, y: 100, w: 1000, h: 800 }, "odd sizes are made even");
    }

    #[test]
    fn only_the_part_on_the_screen_is_shown() {
        // Half off the right edge, and a little above the top.
        let c = crop_for(r(1500, -20, 800, 400), r(0, 0, 1920, 1080), 1920, 1080).unwrap();
        assert_eq!(c, Crop { x: 1500, y: 0, w: 420, h: 380 });
    }

    #[test]
    fn a_window_off_its_screen_or_almost_is_not_cropped() {
        assert_eq!(crop_for(r(2000, 0, 800, 600), r(0, 0, 1920, 1080), 1920, 1080), None);
        assert_eq!(crop_for(r(1800, 0, 800, 600), r(0, 0, 1920, 1080), 1920, 1080), None, "120 px is not a picture an encoder is sure to take");
        // The positive control at the edge of the rule.
        assert!(crop_for(r(1792, 0, 800, 600), r(0, 0, 1920, 1080), 1920, 1080).is_some());
    }

    #[test]
    fn a_picture_at_another_scale_is_cropped_in_the_right_place() {
        // The same screen delivered at half size: the crop halves with it.
        let c = crop_for(r(100, 50, 800, 600), r(0, 0, 1920, 1080), 960, 540).unwrap();
        assert_eq!(c, Crop { x: 50, y: 25, w: 400, h: 300 });
        let back = shown_rect(c, r(0, 0, 1920, 1080), 960, 540);
        assert_eq!(back, r(100, 50, 800, 600));
    }

    fn whole(left: i32, top: i32, width: i32, height: i32) -> puca_input::TargetMonitor {
        puca_input::TargetMonitor {
            left,
            top,
            width,
            height,
            virt_left: -1000,
            virt_top: 0,
            virt_width: 9999,
            virt_height: 9999,
        }
    }

    #[test]
    fn input_is_aimed_by_the_windows_fractions_of_its_screen_not_its_pixels() {
        // A 2560x1440 screen at 150%: physical 2560 wide, GDI (DPI-unaware) 1707.
        let mon = r(0, 0, 2560, 1440);
        let gdi = whole(0, 0, 1707, 960);
        let shown = r(640, 360, 1280, 720); // the middle quarter
        let t = window_target(shown, mon, gdi);
        assert_eq!((t.left, t.top, t.width, t.height), (427, 240, 854, 480), "853.5 rounds up");
        assert_eq!((t.virt_left, t.virt_width), (-1000, 9999), "the virtual desktop is the whole screen's");
        // The NEGATIVE CONTROL: the physical numbers used as they are would aim
        // a third of the screen further right and down.
        assert_ne!((t.left, t.width), (shown.left, shown.width));
    }

    #[test]
    fn input_on_an_unscaled_screen_is_the_window_itself() {
        let mon = r(-1920, 0, 1920, 1080);
        let t = window_target(r(-1800, 100, 640, 480), mon, whole(-1920, 0, 1920, 1080));
        assert_eq!((t.left, t.top, t.width, t.height), (-1800, 100, 640, 480));
    }

    #[test]
    fn a_new_size_waits_until_it_has_held_and_a_flapping_one_never_lands() {
        let t0 = Instant::now();
        let ms = |n: u64| t0 + Duration::from_millis(n);
        let mut s = SizeSettle::default();
        assert_eq!(s.settle((800, 600), t0), (800, 600), "the first size is taken at once");
        assert_eq!(s.settle((900, 600), ms(10)), (800, 600));
        assert_eq!(s.settle((900, 600), ms(200)), (800, 600), "not yet held for 250 ms");
        assert_eq!(s.settle((900, 600), ms(261)), (900, 600));
        // Dragging an edge: a new size every frame never settles.
        for i in 0..20u64 {
            assert_eq!(s.settle((900 + 2 * (i as u32 + 1), 600), ms(300 + i * 16)), (900, 600));
        }
        // Back where it was: no change at all.
        assert_eq!(s.settle((900, 600), ms(700)), (900, 600));
    }

    #[test]
    fn a_settling_size_follows_the_window_and_stays_inside_the_picture() {
        let c = crop_at_size(Crop { x: 1800, y: 1000, w: 100, h: 60 }, (400, 300), 1920, 1080);
        assert_eq!(c, Crop { x: 1520, y: 780, w: 400, h: 300 });
        let c = crop_at_size(Crop { x: 10, y: 20, w: 400, h: 300 }, (100, 60), 1920, 1080);
        assert_eq!(c, Crop { x: 10, y: 20, w: 100, h: 60 });
    }

    /// A desktop that does what the test says.
    struct Desk {
        alive: bool,
        pid: u32,
        iconic: bool,
        shown: bool,
        rect: Option<Rect>,
        monitor: Option<isize>,
        fg: Option<u32>,
    }
    impl WindowOs for Desk {
        fn alive(&self, _h: i64) -> bool {
            self.alive
        }
        fn pid(&self, _h: i64) -> u32 {
            self.pid
        }
        fn iconic(&self, _h: i64) -> bool {
            self.iconic
        }
        fn shown(&self, _h: i64) -> bool {
            self.shown
        }
        fn rect(&self, _h: i64) -> Option<Rect> {
            self.rect
        }
        fn monitor(&self, _h: i64) -> Option<isize> {
            self.monitor
        }
        fn foreground_pid(&self) -> Option<u32> {
            self.fg
        }
    }

    fn desk() -> Desk {
        Desk { alive: true, pid: 42, iconic: false, shown: true, rect: Some(r(100, 100, 800, 600)), monitor: Some(7), fg: Some(42) }
    }

    fn track() -> WindowTrack {
        WindowTrack::new(
            WindowRef { hwnd: 0x1234, pid: 42 },
            0,
            Some(7),
            r(0, 0, 1920, 1080),
            Some(whole(0, 0, 1920, 1080)),
        )
    }

    #[test]
    fn a_shown_window_is_cropped_and_input_follows_it_when_it_moves() {
        let mut t = track();
        let mut d = desk();
        let t0 = Instant::now();
        assert_eq!(t.tick(&d, t0, 1920, 1080, true), Tick::Showing);
        assert_eq!(t.crop(), Some(Crop { x: 100, y: 100, w: 800, h: 600 }));
        let first = t.retarget().expect("the first target is handed out");
        assert_eq!((first.left, first.top, first.width, first.height), (100, 100, 800, 600));
        assert!(t.retarget().is_none(), "the same target is not handed out twice");
        // Dragged: followed at the next look, same size, and input with it.
        d.rect = Some(r(300, 200, 800, 600));
        assert_eq!(t.tick(&d, t0 + Duration::from_millis(5), 1920, 1080, false), Tick::Showing);
        assert_eq!(t.crop().unwrap().x, 100, "not looked at again before READ_EVERY");
        assert_eq!(t.tick(&d, t0 + READ_EVERY, 1920, 1080, false), Tick::Showing);
        assert_eq!(t.crop(), Some(Crop { x: 300, y: 200, w: 800, h: 600 }));
        let moved = t.retarget().expect("a moved window moves the target");
        assert_eq!((moved.left, moved.top), (300, 200));
        assert_eq!(t.surface(), Some(crate::session::CaptureSurface::Single { left: 300, top: 200, width: 800, height: 600 }));
    }

    #[test]
    fn a_window_that_closes_is_minimised_or_leaves_its_screen_goes_back_to_the_whole_screen() {
        let t0 = Instant::now();
        let cases: [(Gone, fn(&mut Desk)); 6] = [
            (Gone::Closed, |d| d.alive = false),
            (Gone::Closed, |d| d.pid = 99), // the handle reused by another program
            (Gone::Minimized, |d| d.iconic = true),
            // Hidden to the tray, or cloaked on another virtual desktop: its
            // rectangle is still there (review, 2026-11-20).
            (Gone::Hidden, |d| d.shown = false),
            (Gone::Offscreen, |d| d.rect = Some(r(2500, 0, 800, 600))),
            // Shrunk below the smallest crop: said as that, not as a move.
            (Gone::Small, |d| d.rect = Some(r(100, 100, 800, 120))),
        ];
        for (want, change) in cases {
            let mut t = track();
            let mut d = desk();
            assert_eq!(t.tick(&d, t0, 1920, 1080, true), Tick::Showing, "the control: shown first");
            change(&mut d);
            assert_eq!(t.tick(&d, t0 + READ_EVERY, 1920, 1080, false), Tick::Gone(want));
        }
    }

    #[test]
    fn a_window_mostly_on_another_screen_says_which_and_one_behind_another_program_says_so() {
        let mut t = track();
        let mut d = desk();
        let t0 = Instant::now();
        t.tick(&d, t0, 1920, 1080, true);
        assert_eq!((t.elsewhere, t.front), (None, true));
        d.monitor = Some(8);
        d.fg = Some(5);
        t.tick(&d, t0 + FRONT_EVERY, 1920, 1080, false);
        assert_eq!(t.elsewhere, Some(8));
        assert!(!t.front, "another program is in front: keys go there");
        d.fg = None;
        t.tick(&d, t0 + FRONT_EVERY * 2, 1920, 1080, false);
        assert!(t.front, "nothing in front reads as in front: this is only a hint");
    }

    #[test]
    fn its_screen_changing_under_it_goes_back_and_a_new_desktop_re_aims_input() {
        let mut t = track();
        let d = desk();
        let t0 = Instant::now();
        t.tick(&d, t0, 1920, 1080, true);
        assert!(t.retarget().is_some());
        assert!(t.geometry_due(t0));
        assert!(!t.geometry_due(t0 + Duration::from_millis(500)), "not before GEOMETRY_EVERY");
        // The same screen, the same desktop: nothing to do.
        assert_eq!(t.regeometry(Some(r(0, 0, 1920, 1080)), Some(whole(0, 0, 1920, 1080))), Ok(()));
        assert!(t.retarget().is_none());
        // The virtual desktop changed (a monitor plugged in beside it): input
        // is aimed again, with the new desktop.
        let mut grown = whole(0, 0, 1920, 1080);
        grown.virt_width = 3840;
        assert_eq!(t.regeometry(Some(r(0, 0, 1920, 1080)), Some(grown)), Ok(()));
        assert_eq!(t.retarget().map(|x| x.virt_width), Some(3840));
        // Its own rectangle changed (a new mode), or the screen is gone.
        assert_eq!(t.regeometry(Some(r(0, 0, 2560, 1440)), Some(grown)), Err(Gone::Screen));
        assert_eq!(t.regeometry(None, Some(grown)), Err(Gone::Screen));
    }

    #[test]
    fn a_window_resized_is_shown_at_its_old_size_until_the_new_one_holds() {
        let mut t = track();
        let mut d = desk();
        let t0 = Instant::now();
        t.tick(&d, t0, 1920, 1080, true);
        d.rect = Some(r(100, 100, 1000, 700));
        t.tick(&d, t0 + READ_EVERY, 1920, 1080, false);
        assert_eq!(t.crop(), Some(Crop { x: 100, y: 100, w: 800, h: 600 }));
        t.tick(&d, t0 + READ_EVERY + SIZE_SETTLE, 1920, 1080, false);
        assert_eq!(t.crop(), Some(Crop { x: 100, y: 100, w: 1000, h: 700 }));
    }

    #[test]
    fn a_crop_is_read_in_place_unless_it_runs_to_the_last_row_off_the_left_edge() {
        // 100x50 picture, stride 400 + padding.
        let stride = 416;
        let len = stride * 50;
        let c = Crop { x: 10, y: 5, w: 40, h: 20 };
        assert_eq!(borrowable_offset(c, 50, stride, len), Some(5 * stride + 40));
        // Down to the last row and not from x = 0: the encoder's stride*h
        // check would refuse the slice, so it is copied.
        let bottom = Crop { x: 10, y: 30, w: 40, h: 20 };
        assert_eq!(borrowable_offset(bottom, 50, stride, len), None);
        let bottom_left = Crop { x: 0, y: 30, w: 40, h: 20 };
        assert_eq!(borrowable_offset(bottom_left, 50, stride, len), Some(30 * stride));
    }

    #[test]
    fn a_window_too_small_to_show_is_told_apart_from_one_that_left() {
        assert!(too_small(r(0, 0, 800, 127)));
        assert!(too_small(r(0, 0, 100, 600)));
        assert!(!too_small(r(0, 0, 128, 128)));
    }

    #[test]
    fn a_crop_is_made_to_fit_a_picture_that_changed_size() {
        let c = Crop { x: 1500, y: 900, w: 600, h: 400 };
        assert_eq!(clamp_crop(c, 1920, 1080), Some(Crop { x: 1320, y: 680, w: 600, h: 400 }));
        assert_eq!(clamp_crop(c, 1280, 720), Some(Crop { x: 680, y: 320, w: 600, h: 400 }));
        assert_eq!(clamp_crop(c, 501, 301), Some(Crop { x: 1, y: 1, w: 500, h: 300 }));
        assert_eq!(clamp_crop(c, 100, 100), None);
    }

    #[test]
    fn a_copied_crop_is_the_crop() {
        // 4x3 picture, each pixel's blue byte = its index.
        let stride = 4 * 4 + 8;
        let mut bgra = vec![0u8; stride * 3];
        for y in 0..3 {
            for x in 0..4 {
                bgra[y * stride + x * 4] = (y * 4 + x) as u8;
            }
        }
        let mut out = Vec::new();
        copy_crop(&bgra, stride, Crop { x: 1, y: 1, w: 2, h: 2 }, &mut out);
        let blues: Vec<u8> = out.chunks_exact(4).map(|p| p[0]).collect();
        assert_eq!(blues, vec![5, 6, 9, 10]);
    }

    #[test]
    fn crc32_and_adler32_match_their_reference_values() {
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
        assert_eq!(crc32(b"IEND"), 0xAE42_6082, "the CRC every PNG ends with");
        assert_eq!(adler32(b"Wikipedia"), 0x11E6_0398);
    }

    /// Read back what `png_rgba` wrote, the way a decoder would: chunk
    /// lengths and CRCs, the zlib header and checksum, stored blocks, filters.
    fn decode_stored_png(png: &[u8]) -> (u32, u32, Vec<u8>) {
        assert_eq!(&png[..8], &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]);
        let mut at = 8;
        let (mut w, mut h, mut idat) = (0, 0, Vec::new());
        let mut kinds = Vec::new();
        while at < png.len() {
            let len = u32::from_be_bytes(png[at..at + 4].try_into().unwrap()) as usize;
            let kind = &png[at + 4..at + 8];
            let data = &png[at + 8..at + 8 + len];
            let crc = u32::from_be_bytes(png[at + 8 + len..at + 12 + len].try_into().unwrap());
            assert_eq!(crc, crc32(&png[at + 4..at + 8 + len]), "chunk {:?} CRC", std::str::from_utf8(kind));
            kinds.push(kind.to_vec());
            if kind == b"IHDR" {
                w = u32::from_be_bytes(data[0..4].try_into().unwrap());
                h = u32::from_be_bytes(data[4..8].try_into().unwrap());
                assert_eq!(&data[8..13], &[8, 6, 0, 0, 0]);
            }
            if kind == b"IDAT" {
                idat.extend_from_slice(data);
            }
            at += 12 + len;
        }
        assert_eq!(kinds, vec![b"IHDR".to_vec(), b"IDAT".to_vec(), b"IEND".to_vec()]);
        assert_eq!(&idat[..2], &[0x78, 0x01]);
        assert_eq!((u16::from(idat[0]) << 8 | u16::from(idat[1])) % 31, 0, "zlib header check bits");
        let mut raw = Vec::new();
        let mut p = 2;
        loop {
            let last = idat[p] & 1;
            assert_eq!(idat[p] >> 1, 0, "stored block");
            let len = u16::from_le_bytes([idat[p + 1], idat[p + 2]]);
            let nlen = u16::from_le_bytes([idat[p + 3], idat[p + 4]]);
            assert_eq!(len, !nlen);
            raw.extend_from_slice(&idat[p + 5..p + 5 + len as usize]);
            p += 5 + len as usize;
            if last == 1 {
                break;
            }
        }
        assert_eq!(u32::from_be_bytes(idat[p..p + 4].try_into().unwrap()), adler32(&raw));
        let row = w as usize * 4;
        let mut px = Vec::new();
        for y in 0..h as usize {
            assert_eq!(raw[y * (row + 1)], 0, "filter none");
            px.extend_from_slice(&raw[y * (row + 1) + 1..(y + 1) * (row + 1)]);
        }
        (w, h, px)
    }

    #[test]
    fn a_png_round_trips_its_pixels() {
        let mut rgba = Vec::new();
        for i in 0..(ICON_EDGE * ICON_EDGE) {
            rgba.extend_from_slice(&[(i % 251) as u8, (i * 7 % 256) as u8, 200, (i % 3 * 120) as u8]);
        }
        let png = png_rgba(ICON_EDGE, ICON_EDGE, &rgba);
        let (w, h, px) = decode_stored_png(&png);
        assert_eq!((w, h), (ICON_EDGE, ICON_EDGE));
        assert_eq!(px, rgba);
        assert!(png.len() < 2600, "a 24 px icon is about 2.4 KB stored: {}", png.len());
    }

    #[test]
    fn a_picture_larger_than_one_stored_block_spans_several() {
        let (w, h) = (200u32, 100u32); // 80,100 bytes of rows: two blocks
        let rgba: Vec<u8> = (0..w * h * 4).map(|i| (i % 253) as u8).collect();
        let (dw, dh, px) = decode_stored_png(&png_rgba(w, h, &rgba));
        assert_eq!((dw, dh), (w, h));
        assert_eq!(px, rgba);
    }

    /// THE FIXTURE THE STAGE HARNESS SHOWS (frontend/e2e/device-stage/windowIcons.json):
    /// an icon made by this encoder, byte for byte, so the real-browser walk
    /// proves a browser decodes what the agent sends. Regenerate it with
    /// `cargo test -p puca-agent window_pick::tests::the_harness_icon -- --ignored --nocapture`
    /// if the encoder ever changes, and the test below goes red until then.
    fn harness_icon() -> Vec<u8> {
        // A 24 px badge: a transparent corner, a half-transparent ring and an
        // opaque teal centre, so the walk can read alpha and colour back.
        let mut rgba = Vec::new();
        for y in 0..ICON_EDGE as i32 {
            for x in 0..ICON_EDGE as i32 {
                let (dx, dy) = (x - 12, y - 12);
                let d2 = dx * dx + dy * dy;
                let px = if d2 <= 36 {
                    [0x1a, 0x9e, 0x8f, 0xff]
                } else if d2 <= 100 {
                    [0xf2, 0xb1, 0x34, 0x80]
                } else {
                    [0, 0, 0, 0]
                };
                rgba.extend_from_slice(&px);
            }
        }
        png_rgba(ICON_EDGE, ICON_EDGE, &rgba)
    }

    #[test]
    fn the_harness_icon_fixture_is_this_encoders_output() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../frontend/e2e/device-stage/windowIcons.json");
        let text = std::fs::read_to_string(path).expect("the harness's icon fixture");
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        use base64::Engine;
        let want = format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(harness_icon())
        );
        assert_eq!(v["badge"].as_str(), Some(want.as_str()), "regenerate the fixture (see harness_icon)");
    }

    #[test]
    #[ignore = "prints the harness fixture; run by hand when the encoder changes"]
    fn the_harness_icon() {
        use base64::Engine;
        println!(
            "{{\"badge\":\"data:image/png;base64,{}\"}}",
            base64::engine::general_purpose::STANDARD.encode(harness_icon())
        );
    }

    #[test]
    fn unblending_recovers_alpha_and_colour() {
        // Opaque: the same on both backgrounds.
        assert_eq!(unblend([10, 20, 30], [10, 20, 30]), [10, 20, 30, 255]);
        // Fully transparent: black on black, white on white.
        assert_eq!(unblend([0, 0, 0], [255, 255, 255]), [0, 0, 0, 0]);
        // Half-transparent red (255, 0, 0, 128): over black (128,0,0), over white (255,127,127).
        let px = unblend([128, 0, 0], [255, 127, 127]);
        assert_eq!(px[3], 128);
        assert!(px[0] >= 254 && px[1] == 0 && px[2] == 0, "{px:?}");
    }

    #[test]
    fn the_icon_key_is_shared_by_the_same_picture_and_differs_for_another() {
        let a = png_rgba(2, 2, &[1; 16]);
        let b = png_rgba(2, 2, &[2; 16]);
        assert_eq!(icon_key(&a), icon_key(&a.clone()));
        assert_ne!(icon_key(&a), icon_key(&b));
    }

    #[test]
    fn a_desc_serialises_to_what_the_host_app_reads() {
        let d = WindowDesc {
            hwnd: 66_000,
            pid: 4,
            title: "notes.txt - Notepad".into(),
            app: "Notepad".into(),
            exe: "notepad.exe".into(),
            icon: Some("iabc".into()),
            minimized: false,
            elevated: true,
            monitor: Some(1),
        };
        assert_eq!(
            serde_json::to_string(&d).unwrap(),
            r#"{"hwnd":66000,"pid":4,"title":"notes.txt - Notepad","app":"Notepad","exe":"notepad.exe","icon":"iabc","elevated":true,"monitor":1}"#
        );
    }

    /// THE REAL DESKTOP CALLS, on a window this test owns and never shows: a
    /// top-level window, created hidden (no `WS_VISIBLE`, never
    /// `ShowWindow`), far off every screen, with a class icon of a known
    /// pattern. Nothing appears on the screen or the taskbar, nothing is
    /// focused, and it is destroyed before the test ends.
    ///
    /// It proves the enumeration reads a window's facts right (the hidden
    /// window is refused for being hidden and this process's own, and with
    /// just those two facts flipped the same facts are offered: the positive
    /// control) and that the icon path draws a real HICON into the PNG the
    /// viewer decodes. Showing a window cannot be tested here without putting
    /// one on the owner's desktop; that is the `#[ignore]`d test below.
    #[cfg(windows)]
    #[test]
    fn a_hidden_window_this_test_owns_reads_back_right_and_its_icon_is_drawn() {
        use windows::core::w;
        use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
        use windows::Win32::Graphics::Gdi::{
            CreateBitmap, CreateDIBSection, DeleteObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
        };
        use windows::Win32::System::LibraryLoader::GetModuleHandleW;
        use windows::Win32::UI::WindowsAndMessaging::{
            CreateIconIndirect, CreateWindowExW, DefWindowProcW, DestroyIcon, DestroyWindow, IsWindowVisible,
            RegisterClassW, UnregisterClassW, HICON, ICONINFO, WINDOW_EX_STYLE, WNDCLASSW, WS_OVERLAPPEDWINDOW,
        };
        unsafe extern "system" fn proc(h: HWND, m: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
            DefWindowProcW(h, m, wp, lp)
        }
        // An opaque teal disc on transparent, 24 px, in either of the two
        // kinds of icon Windows has: 32-bit colour with an ALPHA channel (a
        // DIB section; its mask is ignored), or colour with no alpha and an
        // AND MASK saying what is transparent (the older kind). The second is
        // the kind `unblend` exists for: GDI draws it with no alpha at all.
        let edge = ICON_EDGE as i32;
        let inside = |x: i32, y: i32| (x - 12) * (x - 12) + (y - 12) * (y - 12) <= 49;
        let make_icon = |alpha: bool| -> HICON {
            unsafe {
                let info = BITMAPINFO {
                    bmiHeader: BITMAPINFOHEADER {
                        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                        biWidth: edge,
                        biHeight: -edge,
                        biPlanes: 1,
                        biBitCount: 32,
                        biCompression: BI_RGB.0,
                        ..Default::default()
                    },
                    ..Default::default()
                };
                let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
                let color = CreateDIBSection(None, &info, DIB_RGB_COLORS, &mut bits, None, 0).expect("a DIB");
                let px = std::slice::from_raw_parts_mut(bits as *mut u8, (edge * edge * 4) as usize);
                // 1 bpp rows are padded to 16 bits: 24 px is 3 bytes, stored in 4.
                let mut mask_bits = vec![0u8; (edge * 4) as usize];
                for y in 0..edge {
                    for x in 0..edge {
                        let at = ((y * edge + x) * 4) as usize;
                        let on = inside(x, y);
                        let a = if alpha && on { 0xff } else { 0 };
                        let c: [u8; 4] = if on { [0x8f, 0x9e, 0x1a, a] } else { [0, 0, 0, 0] };
                        px[at..at + 4].copy_from_slice(&c);
                        if !alpha && !on {
                            mask_bits[(y * 4 + x / 8) as usize] |= 0x80 >> (x % 8);
                        }
                    }
                }
                let mask = CreateBitmap(edge, edge, 1, 1, Some(mask_bits.as_ptr() as *const _));
                let icon = CreateIconIndirect(&ICONINFO {
                    fIcon: true.into(),
                    xHotspot: 0,
                    yHotspot: 0,
                    hbmMask: mask,
                    hbmColor: color,
                })
                .expect("an icon");
                // The icon holds its own copies.
                let _ = DeleteObject(color);
                let _ = DeleteObject(mask);
                icon
            }
        };
        for alpha in [true, false] {
            unsafe {
                let icon = make_icon(alpha);
                let module: HINSTANCE = GetModuleHandleW(None).expect("this module").into();
                let class = if alpha { w!("PucaWindowPickTestA") } else { w!("PucaWindowPickTestM") };
                let wc = WNDCLASSW {
                    lpfnWndProc: Some(proc),
                    hInstance: module,
                    hIcon: icon,
                    lpszClassName: class,
                    ..Default::default()
                };
                assert_ne!(RegisterClassW(&wc), 0, "the test's window class");
                // NOT WS_VISIBLE, never shown, and nowhere near a screen.
                let h = CreateWindowExW(
                    WINDOW_EX_STYLE(0),
                    class,
                    w!("Puca window-pick test"),
                    WS_OVERLAPPEDWINDOW,
                    -32_000,
                    -32_000,
                    320,
                    200,
                    None,
                    None,
                    module,
                    None,
                )
                .expect("the hidden test window");
                assert!(!IsWindowVisible(h).as_bool(), "the test window must never be visible");

                let me = std::process::id();
                let (f, pid) = live::facts(h, me);
                assert_eq!(pid, me);
                assert_eq!(f.title, "Puca window-pick test");
                assert_eq!(f.class, if alpha { "PucaWindowPickTestA" } else { "PucaWindowPickTestM" });
                assert!(!f.visible && f.own_process && !f.owned && !f.tool_window);
                assert!(!listable(&f), "hidden, and this agent's own: never offered");
                let mut shown = f.clone();
                shown.visible = true;
                shown.own_process = false;
                assert!(listable(&shown), "the POSITIVE CONTROL: the same facts, visible and someone else's, are offered");

                let png = icons::icon_png(h, true).expect("its class icon, drawn");
                let (iw, ih, px) = decode_stored_png(&png);
                assert_eq!((iw, ih), (ICON_EDGE, ICON_EDGE));
                let at = |x: usize, y: usize| px[(y * ICON_EDGE as usize + x) * 4..][..4].to_vec();
                assert_eq!(at(0, 0)[3], 0, "the corner is transparent (alpha icon: {alpha})");
                let c = at(12, 12);
                assert_eq!(c[3], 255, "the centre is opaque (alpha icon: {alpha})");
                assert!(
                    c[0].abs_diff(0x1a) <= 2 && c[1].abs_diff(0x9e) <= 2 && c[2].abs_diff(0x8f) <= 2,
                    "the centre is the icon's teal, unblended: {c:?} (alpha icon: {alpha})"
                );

                let _ = DestroyWindow(h);
                let _ = UnregisterClassW(class, module);
                let _ = DestroyIcon(icon);
            }
        }
    }

    /// Showing a real window cropped from a real screen needs a window ON a
    /// screen, which on this machine is a window on the owner's desktop —
    /// never opened by a test. The crop, the mapping and every fallback are
    /// tested above on scripted desktops; this is the end-to-end check for a
    /// gate machine with a desktop of its own.
    #[cfg(windows)]
    #[test]
    #[ignore = "needs a visible window on a real screen: run on a machine whose desktop is the test's to use"]
    fn live_a_visible_window_is_listed_and_its_frame_is_on_a_screen() {
        let (windows, icons) = live::list_windows();
        assert!(!windows.is_empty(), "a desktop with a window open lists it");
        for w in &windows {
            assert!(w.title.chars().count() <= MAX_TITLE_CHARS);
            if let Some(k) = &w.icon {
                assert!(icons.contains_key(k), "every icon key names a picture");
            }
        }
    }
}
