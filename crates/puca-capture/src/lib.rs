//! Native screen capture for the host agent.
//!
//! THIS IS WHY THE AGENT EXISTS. `getDisplayMedia` requires transient user
//! activation — Chromium rejects it with `InvalidStateError` before any picker
//! is consulted, and activation expires in about five seconds. So a webview
//! host cannot begin a capture after a reboot with nobody present, however the
//! picker is configured. Nothing here needs a gesture, a picker, or a window.
//!
//! DXGI Desktop Duplication rather than Windows.Graphics.Capture: WGC draws a
//! yellow border that cannot be disabled before Win11 22000, and an unattended
//! host that permanently outlines the screen is not shippable. Duplication has
//! its own limits, stated plainly rather than discovered later:
//!
//!   * The SECURE DESKTOP (UAC prompts, the lock screen, the sign-in screen) is
//!     a matter of WHICH DESKTOP THE CALLING THREAD IS ON, not a limit of
//!     duplication. This file used to say duplication "cannot capture" it at
//!     all, and `puca-spike-s5` chose GDI BitBlt on that basis. MEASURED
//!     2026-08-15 and both were wrong: a process running as SYSTEM that has
//!     called `SetThreadDesktop(Winlogon)` duplicates it normally — a live UAC
//!     prompt captured at 2560x1440 with 1011 distinct sampled colours, against
//!     2807 on the Default desktop seconds earlier in the same process.
//!     What a user-token process gets is E_ACCESSDENIED, which is a permission
//!     answer about the desktop, not a statement about DXGI.
//!   * `AcquireNextFrame` returns `DXGI_ERROR_ACCESS_LOST` when the desktop
//!     switches, the GPU changes, or a fullscreen-exclusive app takes over. That
//!     is NORMAL, not fatal — the duplication is recreated. Treating it as an
//!     error is why naive implementations "stop working when you alt-tab into a
//!     game".
//!   * A frame is only produced when something CHANGES. A static desktop yields
//!     timeouts, so callers must repeat the previous frame rather than treating
//!     a timeout as a dropped connection.
//!   * Duplication is EXCLUSIVE PER OUTPUT. A second `DuplicateOutput` on the
//!     same monitor gets E_ACCESSDENIED while the first lives — so the agent
//!     must hold ONE `ScreenCapture` per monitor and share its frames between
//!     sessions. Opening a second is not a race to be retried; it is a design
//!     error that presents as "capture randomly fails to start".
//!
//! Verified live on a real desktop: a 2560x1440 frame with genuine pixel
//! variation, captured with no gesture, no picker and no window — see
//! tests/live_capture.rs.

/// A captured frame: 32-bit BGRA, top-down, `stride` bytes per row.
///
/// `stride` is NOT always `width * 4` — the GPU pads rows — and assuming it is
/// produces a picture that shears diagonally. It is carried explicitly so the
/// caller cannot forget.
#[derive(Debug, Clone)]
pub struct Frame {
    pub width: u32,
    pub height: u32,
    pub stride: usize,
    pub bgra: Vec<u8>,
}

impl Frame {
    /// Pixel at (x, y) as (b, g, r, a), or None if out of bounds.
    pub fn pixel(&self, x: u32, y: u32) -> Option<(u8, u8, u8, u8)> {
        if x >= self.width || y >= self.height {
            return None;
        }
        let at = y as usize * self.stride + x as usize * 4;
        let px = self.bgra.get(at..at + 4)?;
        Some((px[0], px[1], px[2], px[3]))
    }

    /// Whether the frame carries any variation at all.
    ///
    /// Exists for TESTS, and it earns its place: a capture path that silently
    /// yields an all-black or all-identical buffer looks exactly like a working
    /// one from every other angle — dimensions right, no error, frames arriving.
    /// Asserting "a frame was returned" would pass on a stub.
    pub fn has_variation(&self) -> bool {
        let first = match self.bgra.get(..4) {
            Some(p) => p,
            None => return false,
        };
        // Sample rather than scan: a 4K frame is 33 MB and the answer is the
        // same either way.
        let step = (self.bgra.len() / 4 / 4096).max(1) * 4;
        self.bgra
            .chunks_exact(4)
            .step_by(step / 4)
            .any(|px| px != first)
    }
}

/// How far a captured surface must be turned to match the desktop.
///
/// THE SURFACE IS NOT ROTATED FOR US. `DXGI_OUTPUT_DESC.DesktopCoordinates`
/// accounts for a rotated display — a portrait monitor reads 1440x2560 — but
/// the duplicated texture is always in the panel's NATIVE orientation, so that
/// same monitor captures as 2560x1440. Measured on the reporter's desk: outputs
/// 1 and 2 report ROTATE270 and ROTATE90 with 1440x2560 desktop rects and hand
/// back 2560x1440 frames. Nothing turned them, so a portrait screen arrived on
/// the phone lying on its side — and input, which is mapped over the DESKTOP
/// rectangle, disagreed with the picture on those screens too.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rotation {
    None,
    Cw90,
    Cw180,
    Cw270,
}

/// One capturable output, in the SAME order `ScreenCapture::new` indexes.
///
/// This exists because a monitor index is meaningless without saying whose
/// enumeration it belongs to. Capture walks DXGI (adapters, then their outputs);
/// `puca_input::list_monitors` walks GDI (`EnumDisplayMonitors`). Those two
/// orders are unrelated — measured on a live 3-monitor desktop, DXGI 0/1/2 was
/// GDI 2/1/0 — so indexing one list with the other's index captures one screen
/// and injects into another. Carrying the geometry HERE, alongside the index the
/// capture actually used, is what removes the guess.
///
/// `hmonitor` is the join key back to the GDI list (`MonitorInfo::hmonitor`) for
/// anything DXGI does not report, such as DPI scale and which output the OS
/// calls primary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OutputInfo {
    /// Position in the capture enumeration — what `ScreenCapture::new` takes.
    pub index: usize,
    /// Desktop coordinates. Secondary monitors are legitimately NEGATIVE.
    pub left: i32,
    pub top: i32,
    pub width: i32,
    pub height: i32,
    /// `HMONITOR` as a raw handle value, 0 when unknown (non-Windows).
    pub hmonitor: isize,
    /// What must be undone to bring the captured surface into the orientation
    /// `left/top/width/height` describe. A portrait monitor captures landscape.
    pub rotation: Rotation,
}

/// Why a capture attempt produced no frame.
#[derive(Debug)]
pub enum CaptureError {
    /// No change since the last frame. NOT an error — repeat the previous one.
    Timeout,
    /// The desktop switched, the GPU changed, or a fullscreen app took over.
    /// The duplication has been dropped and will be rebuilt on the next call.
    AccessLost,
    /// Genuinely broken.
    Failed(String),
}

impl std::fmt::Display for CaptureError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CaptureError::Timeout => write!(f, "no change since the last frame"),
            CaptureError::AccessLost => write!(f, "the desktop changed; capture is being rebuilt"),
            CaptureError::Failed(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for CaptureError {}

#[cfg(windows)]
mod windows_impl;

#[cfg(windows)]
pub use windows_impl::{outputs, ScreenCapture};

#[cfg(target_os = "linux")]
mod linux_impl;

#[cfg(target_os = "linux")]
pub use linux_impl::{outputs, ScreenCapture};

#[cfg(not(any(windows, target_os = "linux")))]
mod stub {
    use super::*;

    /// Non-Windows placeholder.
    ///
    /// A hard error, not a black frame: an agent that reported "capturing" while
    /// producing nothing would look connected and show the controller a blank
    /// screen with no explanation. Windows and X11 Linux both have real
    /// implementations; this covers everything else (macOS, and Wayland until
    /// the portal work lands).
    pub struct ScreenCapture;

    impl ScreenCapture {
        pub fn new(_monitor: usize) -> Result<Self, CaptureError> {
            Err(CaptureError::Failed(
                "native screen capture is only implemented on Windows".to_string(),
            ))
        }

        pub fn next_frame(&mut self, _timeout_ms: u32) -> Result<Frame, CaptureError> {
            Err(CaptureError::Failed(
                "native screen capture is only implemented on Windows".to_string(),
            ))
        }

        pub fn monitor_count() -> usize {
            0
        }

        /// Mirrors the Windows setter so callers compile everywhere. Nothing
        /// to toggle: this implementation never produces a frame at all.
        pub fn set_draw_cursor(&mut self, _on: bool) {}
    }

    pub fn outputs() -> Vec<super::OutputInfo> {
        Vec::new()
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
pub use stub::{outputs, ScreenCapture};

#[cfg(test)]
mod tests {
    use super::*;

    fn frame_of(pixels: &[[u8; 4]], width: u32) -> Frame {
        let mut bgra = Vec::new();
        for p in pixels {
            bgra.extend_from_slice(p);
        }
        Frame {
            width,
            height: pixels.len() as u32 / width,
            stride: width as usize * 4,
            bgra,
        }
    }

    #[test]
    fn pixel_reads_respect_stride_and_bounds() {
        let f = Frame {
            width: 2,
            height: 2,
            // Padded: 3 pixels' worth of bytes per 2-pixel row. Assuming
            // width*4 here is what makes a captured picture shear diagonally.
            stride: 12,
            bgra: vec![
                1, 1, 1, 255, 2, 2, 2, 255, 0, 0, 0, 0,
                3, 3, 3, 255, 4, 4, 4, 255, 0, 0, 0, 0,
            ],
        };
        assert_eq!(f.pixel(0, 0), Some((1, 1, 1, 255)));
        assert_eq!(f.pixel(1, 0), Some((2, 2, 2, 255)));
        assert_eq!(f.pixel(0, 1), Some((3, 3, 3, 255)), "row 1 must skip the padding");
        assert_eq!(f.pixel(1, 1), Some((4, 4, 4, 255)));
        assert_eq!(f.pixel(2, 0), None);
        assert_eq!(f.pixel(0, 2), None);
    }

    #[test]
    fn has_variation_distinguishes_a_real_frame_from_a_blank_one() {
        // The guard against a stub capture path: uniform buffers must read as
        // no-variation, or the live test that uses this proves nothing.
        let black = frame_of(&[[0, 0, 0, 255]; 64], 8);
        assert!(!black.has_variation(), "an all-black frame has no variation");

        let uniform = frame_of(&[[9, 9, 9, 255]; 64], 8);
        assert!(!uniform.has_variation(), "any uniform frame has no variation");

        let mut mixed = vec![[0u8, 0, 0, 255]; 64];
        mixed[63] = [255, 255, 255, 255];
        assert!(frame_of(&mixed, 8).has_variation(), "one differing pixel is variation");
    }

    #[cfg(windows)]
    #[test]
    fn rotation_puts_a_portrait_panel_the_right_way_up() {
        use super::windows_impl::rotate_to_desktop;
        // A 3x2 landscape surface, pixels labelled by their BLUE channel so the
        // corners are identifiable after turning.
        //   1 2 3
        //   4 5 6
        let px = |b: u8| [b, 0, 0, 255];
        let mut bgra = Vec::new();
        for b in [1u8, 2, 3, 4, 5, 6] {
            bgra.extend_from_slice(&px(b));
        }
        let src = Frame { width: 3, height: 2, stride: 12, bgra };
        let blue = |f: &Frame, x: usize, y: usize| f.bgra[y * f.stride + x * 4];

        // Clockwise 90: the bottom-left corner becomes the top-left.
        //   4 1
        //   5 2
        //   6 3
        let r90 = rotate_to_desktop(src.clone(), Rotation::Cw90);
        assert_eq!((r90.width, r90.height), (2, 3), "90 degrees swaps the axes");
        assert_eq!(blue(&r90, 0, 0), 4);
        assert_eq!(blue(&r90, 1, 0), 1);
        assert_eq!(blue(&r90, 1, 2), 3);

        // Counter-clockwise (270): the top-right corner becomes the top-left.
        //   3 6
        //   2 5
        //   1 4
        let r270 = rotate_to_desktop(src.clone(), Rotation::Cw270);
        assert_eq!((r270.width, r270.height), (2, 3));
        assert_eq!(blue(&r270, 0, 0), 3);
        assert_eq!(blue(&r270, 1, 0), 6);
        assert_eq!(blue(&r270, 1, 2), 4);

        // 180 keeps the shape and reverses both axes.
        let r180 = rotate_to_desktop(src.clone(), Rotation::Cw180);
        assert_eq!((r180.width, r180.height), (3, 2));
        assert_eq!(blue(&r180, 0, 0), 6);
        assert_eq!(blue(&r180, 2, 1), 1);

        // None is a pass-through, and must not disturb a padded stride.
        let none = rotate_to_desktop(src.clone(), Rotation::None);
        assert_eq!((none.width, none.height, none.stride), (3, 2, 12));
    }

    /// POSITIVE CONTROL for the test above: prove the fixture can tell the two
    /// 90-degree directions apart, so "Cw90 is correct" is not also true of
    /// Cw270 by symmetry.
    #[cfg(windows)]
    #[test]
    fn the_two_quarter_turns_are_distinguishable() {
        use super::windows_impl::rotate_to_desktop;
        let mut bgra = Vec::new();
        for b in [1u8, 2, 3, 4, 5, 6] {
            bgra.extend_from_slice(&[b, 0, 0, 255]);
        }
        let src = Frame { width: 3, height: 2, stride: 12, bgra };
        let a = rotate_to_desktop(src.clone(), Rotation::Cw90);
        let b = rotate_to_desktop(src, Rotation::Cw270);
        assert_ne!(a.bgra, b.bgra, "a rotation test that cannot see direction proves nothing");
    }

    #[test]
    fn an_empty_frame_has_no_variation() {
        let empty = Frame { width: 0, height: 0, stride: 0, bgra: Vec::new() };
        assert!(!empty.has_variation());
        assert_eq!(empty.pixel(0, 0), None);
    }
}
