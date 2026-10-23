//! Which pointer the host is showing, for a viewer that draws the pointer
//! itself.
//!
//! WHY. A pointer drawn into the video trails the hand by the whole loop —
//! capture, encode, network, decode, display — and it is the one thing on
//! screen the hand is steering, so it is where the delay is felt. A desktop
//! viewer can do better: take the pointer (the `set-cursor-owner` handshake the
//! phone's trackpad already uses, after which this agent stops drawing it) and
//! let the browser draw the real mouse pointer over the picture, which moves
//! with no delay at all. What the browser cannot know is the SHAPE — the text
//! I-beam over a field, the hand over a link, a resize arrow at a window edge,
//! a busy spinner, or no pointer at all while a game holds it. That is this
//! module: the host's current system pointer, as the CSS cursor keyword that
//! draws the same shape locally, sent on the caret channel when it changes.
//!
//! The standard Windows pointers are shared handles (`LoadCursor(NULL, IDC_*)`),
//! so comparing the one in use against them names it. A pointer an application
//! drew itself has no keyword and is reported as the ordinary arrow: still at
//! no delay, just not that application's picture of it.

use std::time::{Duration, Instant};

/// How often the shape is looked at while a viewer draws the pointer. A
/// change of shape (onto a link, into a field) is noticed within this.
pub(crate) const POLL_EVERY: Duration = Duration::from_millis(30);

/// The standard pointers by their `IDC_*` resource number, as the CSS keyword
/// that draws the same shape. Numbers from winuser.h.
pub(crate) const STANDARD: &[(u16, &str)] = &[
    (32512, "default"),     // IDC_ARROW
    (32513, "text"),        // IDC_IBEAM
    (32514, "wait"),        // IDC_WAIT
    (32515, "crosshair"),   // IDC_CROSS
    (32516, "default"),     // IDC_UPARROW
    (32642, "nwse-resize"), // IDC_SIZENWSE
    (32643, "nesw-resize"), // IDC_SIZENESW
    (32644, "ew-resize"),   // IDC_SIZEWE
    (32645, "ns-resize"),   // IDC_SIZENS
    (32646, "move"),        // IDC_SIZEALL
    (32648, "not-allowed"), // IDC_NO
    (32649, "pointer"),     // IDC_HAND
    (32650, "progress"),    // IDC_APPSTARTING
    (32651, "help"),        // IDC_HELP
];

/// The line the viewer reads: `{"k":"cursor","css":"text"}`.
pub(crate) fn cursor_line(css: &str) -> Vec<u8> {
    format!("{{\"k\":\"cursor\",\"css\":\"{css}\"}}").into_bytes()
}

/// Says the shape when it changes, at most once per `POLL_EVERY`.
#[derive(Default)]
pub(crate) struct ShapeReporter {
    last_sent: Option<&'static str>,
    last_poll: Option<Instant>,
}

impl ShapeReporter {
    /// Is a look due at `now`?
    pub(crate) fn due(&self, now: Instant) -> bool {
        self.last_poll.is_none_or(|t| now.duration_since(t) >= POLL_EVERY)
    }

    /// The shape seen at `now`; returns it when it differs from the last one
    /// SENT. `sent` must then be called once the line is actually accepted, so
    /// a refused write is retried on the next look.
    pub(crate) fn observe(&mut self, now: Instant, css: &'static str) -> Option<&'static str> {
        self.last_poll = Some(now);
        (self.last_sent != Some(css)).then_some(css)
    }

    pub(crate) fn sent(&mut self, css: &'static str) {
        self.last_sent = Some(css);
    }

    /// Forget what was sent: the viewer stopped or started drawing, and the
    /// next look must say the shape again.
    pub(crate) fn reset(&mut self) {
        self.last_sent = None;
        self.last_poll = None;
    }
}

/// The host's pointer right now, as a CSS keyword: `none` while it is hidden
/// (a game in mouse-look, a video playing fullscreen), the standard shape's
/// keyword, or `default` for one an application drew itself.
#[cfg(windows)]
pub(crate) fn current_css() -> &'static str {
    use std::sync::OnceLock;
    use windows::core::PCWSTR;
    use windows::Win32::UI::WindowsAndMessaging::{GetCursorInfo, LoadCursorW, CURSORINFO};
    /// `CURSOR_SHOWING` (winuser.h).
    const SHOWING: u32 = 0x1;
    static HANDLES: OnceLock<Vec<(isize, &'static str)>> = OnceLock::new();
    let handles = HANDLES.get_or_init(|| {
        STANDARD
            .iter()
            .filter_map(|&(id, css)| {
                // MAKEINTRESOURCE: the id as the "name" pointer.
                let h = unsafe { LoadCursorW(None, PCWSTR(id as usize as *const u16)) }.ok()?;
                Some((h.0 as isize, css))
            })
            .collect()
    });
    let mut info = CURSORINFO { cbSize: std::mem::size_of::<CURSORINFO>() as u32, ..Default::default() };
    if unsafe { GetCursorInfo(&mut info) }.is_err() {
        return "default";
    }
    if info.flags.0 & SHOWING == 0 {
        return "none";
    }
    let h = info.hCursor.0 as isize;
    handles.iter().find(|(hh, _)| *hh == h).map(|(_, css)| *css).unwrap_or("default")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_standard_pointers_map_to_the_keywords_that_draw_them() {
        let css = |id: u16| STANDARD.iter().find(|(i, _)| *i == id).map(|(_, c)| *c);
        assert_eq!(css(32513), Some("text"), "IDC_IBEAM");
        assert_eq!(css(32649), Some("pointer"), "IDC_HAND");
        assert_eq!(css(32644), Some("ew-resize"), "IDC_SIZEWE");
        assert_eq!(css(32514), Some("wait"), "IDC_WAIT");
        // Every keyword is one a browser draws natively.
        let known = ["default", "text", "wait", "crosshair", "nwse-resize", "nesw-resize", "ew-resize",
            "ns-resize", "move", "not-allowed", "pointer", "progress", "help"];
        assert!(STANDARD.iter().all(|(_, c)| known.contains(c)));
    }

    #[test]
    fn the_line_is_what_the_viewer_reads() {
        assert_eq!(String::from_utf8(cursor_line("text")).unwrap(), r#"{"k":"cursor","css":"text"}"#);
    }

    #[test]
    fn a_shape_is_said_once_per_change_and_again_after_a_refused_write() {
        let t0 = Instant::now();
        let mut r = ShapeReporter::default();
        assert!(r.due(t0));
        assert_eq!(r.observe(t0, "default"), Some("default"));
        // Not accepted (SCTP full): the next look says it again.
        assert!(!r.due(t0 + Duration::from_millis(5)), "looked at most every 30 ms");
        let t1 = t0 + POLL_EVERY;
        assert_eq!(r.observe(t1, "default"), Some("default"));
        r.sent("default");
        assert_eq!(r.observe(t1 + POLL_EVERY, "default"), None, "unchanged: silent");
        assert_eq!(r.observe(t1 + POLL_EVERY * 2, "text"), Some("text"));
        r.sent("text");
        r.reset();
        assert_eq!(r.observe(t1 + POLL_EVERY * 3, "text"), Some("text"), "after a reset, said again");
    }
}
