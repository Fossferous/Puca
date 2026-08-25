//! X11 screen capture.
//!
//! The Linux counterpart to the DXGI path, and it exists for the same reason:
//! nothing here needs a user gesture, a picker, or a window. A Linux host is
//! the case where that matters most, because the webview host cannot work there
//! AT ALL — Tauri on Linux is WebKitGTK, which has no insertable streams, so
//! media E2EE silently drops every frame and the viewer gets a black screen with
//! no error.
//!
//! Pure-Rust x11rb rather than binding libX11: the agent has to build on
//! machines where installing dev packages needs root, and a C header dependency
//! would make it undeployable exactly where it is most wanted.
//!
//! DIFFERENCES FROM THE WINDOWS PATH, which callers must not paper over:
//!
//!   * X11 has no change notification here. `GetImage` always returns the
//!     current screen, so unlike DXGI duplication there is no `Timeout` meaning
//!     "nothing moved" — every call yields a frame. The encoder therefore sees a
//!     steady rate rather than only-on-change, which costs bandwidth on a still
//!     desktop but removes a whole class of stall.
//!   * X11 has no concept of a secure desktop, so there is no equivalent of the
//!     UAC boundary. A privileged prompt on Linux is an ordinary window and IS
//!     capturable. Wayland is the opposite and is why it needs the portal.
//!   * MIT-SHM is used when the server offers it, which it does for a local
//!     connection. Without it every frame crosses the X socket, which at 4K is
//!     slow enough to matter.

use super::{CaptureError, Frame, OutputInfo};
use x11rb::connection::Connection;
use x11rb::protocol::shm::{self, ConnectionExt as ShmConnectionExt};
use x11rb::protocol::xproto::{ConnectionExt, ImageFormat, Screen};
use x11rb::rust_connection::RustConnection;

pub struct ScreenCapture {
    conn: RustConnection,
    /// What we read from. Normally the root window; a specific window id when
    /// capturing one application, which is also the only thing that WORKS under
    /// a compositing server (see the note on Xwayland below).
    root: u32,
    width: u16,
    height: u16,
    /// Present only when the server supports MIT-SHM. Without it we fall back
    /// to GetImage over the socket, which works but copies far more.
    shm: Option<ShmBuffer>,
}

struct ShmBuffer {
    seg: shm::Seg,
    addr: *mut u8,
    len: usize,
    shmid: i32,
}

impl Drop for ShmBuffer {
    fn drop(&mut self) {
        unsafe {
            // Detach then mark for destruction. Skipping either leaks a System V
            // segment for the life of the machine, and they are a finite
            // resource — a long-running agent would eventually fail to start a
            // session with a confusing ENOSPC.
            libc_shmdt(self.addr as *mut core::ffi::c_void);
            libc_shmctl(self.shmid, 0 /* IPC_RMID */, core::ptr::null_mut());
        }
    }
}

// Minimal System V shared-memory bindings. Declared here rather than pulling in
// the `libc` crate for four symbols.
extern "C" {
    #[link_name = "shmget"]
    fn libc_shmget(key: i32, size: usize, shmflg: i32) -> i32;
    #[link_name = "shmat"]
    fn libc_shmat(shmid: i32, shmaddr: *const core::ffi::c_void, shmflg: i32) -> *mut core::ffi::c_void;
    #[link_name = "shmdt"]
    fn libc_shmdt(shmaddr: *const core::ffi::c_void) -> i32;
    #[link_name = "shmctl"]
    fn libc_shmctl(shmid: i32, cmd: i32, buf: *mut core::ffi::c_void) -> i32;
}

const IPC_PRIVATE: i32 = 0;
const IPC_CREAT: i32 = 0o1000;

fn screen_of(conn: &RustConnection, index: usize) -> Result<Screen, CaptureError> {
    conn.setup()
        .roots
        .get(index)
        .cloned()
        .ok_or_else(|| CaptureError::Failed(format!("no X screen at index {index}")))
}

impl ScreenCapture {
    /// Connect to the X server named by `$DISPLAY` and prepare to capture.
    ///
    /// `monitor` indexes X SCREENS, not RandR outputs. On virtually every modern
    /// setup a multi-monitor desktop is ONE screen spanning all of them, so 0 is
    /// almost always right and higher indices usually do not exist. Per-monitor
    /// cropping is a RandR query and is deliberately not done here.
    pub fn new(monitor: usize) -> Result<Self, CaptureError> {
        let (conn, default_screen) = x11rb::connect(None).map_err(|e| {
            CaptureError::Failed(format!(
                "cannot connect to the X server (is DISPLAY set?): {e}"
            ))
        })?;
        let index = if monitor == 0 { default_screen } else { monitor };
        let screen = screen_of(&conn, index)?;
        let (root, width, height) = (screen.root, screen.width_in_pixels, screen.height_in_pixels);

        let shm = Self::try_shm(&conn, width, height);
        Ok(Self { conn, root, width, height, shm })
    }

    /// Set up MIT-SHM, or `None` if the server does not offer it.
    ///
    /// Failure here is not an error: a remote X connection legitimately has no
    /// shared memory, and GetImage still works. Treating it as fatal would make
    /// the agent refuse to run over SSH X-forwarding.
    fn try_shm(conn: &RustConnection, width: u16, height: u16) -> Option<ShmBuffer> {
        conn.shm_query_version().ok()?.reply().ok()?;
        let len = width as usize * height as usize * 4;
        unsafe {
            let shmid = libc_shmget(IPC_PRIVATE, len, IPC_CREAT | 0o600);
            if shmid < 0 {
                return None;
            }
            let addr = libc_shmat(shmid, core::ptr::null(), 0);
            if addr as isize == -1 {
                libc_shmctl(shmid, 0, core::ptr::null_mut());
                return None;
            }
            let seg = conn.generate_id().ok()?;
            if conn.shm_attach(seg, shmid as u32, false).is_err() {
                libc_shmdt(addr);
                libc_shmctl(shmid, 0, core::ptr::null_mut());
                return None;
            }
            // Mark for destruction NOW: the segment stays alive while attached,
            // and this way it cannot outlive the process even on a hard kill.
            libc_shmctl(shmid, 0, core::ptr::null_mut());
            Some(ShmBuffer { seg, addr: addr as *mut u8, len, shmid })
        }
    }

    /// Capture ONE window rather than the whole screen.
    ///
    /// This is a real capability -- "share just this application" -- and it is
    /// also the only thing that works on a COMPOSITING server. Under Xwayland,
    /// and under any compositing window manager that redirects windows to
    /// offscreen pixmaps, the X root window does not contain window content: a
    /// root capture comes back empty while every call succeeds. Measured
    /// directly under WSLg, where a window drawable returned the exact colour
    /// drawn on it and the root returned #000000 at the same coordinates.
    ///
    /// The consequence for the product is stated plainly rather than left to be
    /// discovered: root capture is right for a plain X11 desktop (which is what
    /// most self-hosters run, and what ffmpeg's x11grab assumes), and a Wayland
    /// session needs the xdg-desktop-portal path instead. Capturing a window is
    /// the bridge that works on both.
    pub fn new_for_window(window: u32) -> Result<Self, CaptureError> {
        let (conn, _) = x11rb::connect(None).map_err(|e| {
            CaptureError::Failed(format!("cannot connect to the X server: {e}"))
        })?;
        let geom = conn
            .get_geometry(window)
            .map_err(|e| CaptureError::Failed(format!("get_geometry failed: {e}")))?
            .reply()
            .map_err(|e| CaptureError::Failed(format!("get_geometry reply failed: {e}")))?;
        let (width, height) = (geom.width, geom.height);
        let shm = Self::try_shm(&conn, width, height);
        Ok(Self { conn, root: window, width, height, shm })
    }

    /// Does the root window actually carry content on this display?
    ///
    /// False means a compositing server (Xwayland, or a redirecting WM), where a
    /// full-screen X11 capture is structurally impossible however correct the
    /// code is. Callers should report that rather than streaming a black screen
    /// and letting the user conclude the feature is broken.
    pub fn root_has_content(&mut self) -> bool {
        self.next_frame(0).map(|f| f.has_variation()).unwrap_or(false)
    }

    /// Number of X screens. Usually 1 even with several physical monitors.
    pub fn monitor_count() -> usize {
        x11rb::connect(None)
            .map(|(conn, _)| conn.setup().roots.len())
            .unwrap_or(0)
    }

    /// Grab the current screen.
    ///
    /// `timeout_ms` is accepted for parity with the Windows path and IGNORED:
    /// X11 has no change notification here, so there is no waiting to do and
    /// never a `Timeout`. Callers written against DXGI keep working; they simply
    /// never see the no-change case.
    pub fn next_frame(&mut self, _timeout_ms: u32) -> Result<Frame, CaptureError> {
        let (w, h) = (self.width, self.height);

        if let Some(shm) = &self.shm {
            let cookie = self
                .conn
                .shm_get_image(
                    self.root,
                    0,
                    0,
                    w,
                    h,
                    !0,
                    ImageFormat::Z_PIXMAP.into(),
                    shm.seg,
                    0,
                )
                .map_err(|e| CaptureError::Failed(format!("shm_get_image failed: {e}")))?;
            cookie
                .reply()
                .map_err(|e| CaptureError::Failed(format!("shm_get_image reply failed: {e}")))?;

            let bytes = unsafe { std::slice::from_raw_parts(shm.addr, shm.len) };
            return Ok(Frame {
                width: w as u32,
                height: h as u32,
                stride: w as usize * 4,
                bgra: bytes.to_vec(),
            });
        }

        let reply = self
            .conn
            .get_image(ImageFormat::Z_PIXMAP, self.root, 0, 0, w, h, !0)
            .map_err(|e| CaptureError::Failed(format!("get_image failed: {e}")))?
            .reply()
            .map_err(|e| CaptureError::Failed(format!("get_image reply failed: {e}")))?;

        Ok(Frame {
            width: w as u32,
            height: h as u32,
            stride: w as usize * 4,
            bgra: reply.data,
        })
    }

    /// Whether this capture is using shared memory. Surfaced for diagnostics:
    /// the fallback works but is markedly slower, and knowing which path is in
    /// use turns "the stream is sluggish" into an answerable question.
    pub fn using_shm(&self) -> bool {
        self.shm.is_some()
    }
}

/// Capturable outputs with their geometry, in capture-index order.
///
/// One X screen normally spans every physical monitor, so this reports whole
/// screens rather than panels — matching `puca_input::list_monitors` on
/// this platform, which is why the two enumerations cannot disagree here the way
/// DXGI and GDI do on Windows. Per-monitor bounds are a RandR query, worth
/// adding when per-monitor selection ships.
pub fn outputs() -> Vec<OutputInfo> {
    let Ok((conn, _)) = x11rb::connect(None) else {
        return Vec::new();
    };
    conn.setup()
        .roots
        .iter()
        .enumerate()
        .map(|(index, r)| OutputInfo {
            index,
            left: 0,
            top: 0,
            width: r.width_in_pixels as i32,
            height: r.height_in_pixels as i32,
            hmonitor: 0,
            // X hands back the screen already in its displayed orientation;
            // RandR rotation is applied server-side.
            rotation: super::Rotation::None,
        })
        .collect()
}
