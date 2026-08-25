//! LIVE X11 capture test — needs a real X server ($DISPLAY).
//!
//!   cargo test -p puca-capture --test live_capture_x11 -- --ignored --nocapture
//!
//! STRONGER than the Windows live test, and deliberately so. That one asserts
//! "the frame has varied pixels", which works because a real desktop is never
//! one flat colour. A bare X server often IS: an X root with no clients is
//! uniformly black, so a variation check there proves nothing and would fail on
//! a perfectly working capture.
//!
//! So this DRAWS a known colour on the X display and asserts that exact colour
//! comes back through `ScreenCapture`. That cannot pass on a stub, a black
//! buffer, or a capture of the wrong surface — it only passes if the pixels
//! really came from the server we drew on.
//!
//! WHY THE STRICT ASSERTION IS ON THE WINDOW AND NOT THE ROOT. Measured under
//! WSLg: the window drawable returned exactly the colour drawn, and the root
//! returned #000000 at the same coordinates. That is not a capture bug — on a
//! COMPOSITING server (Xwayland, or any WM that redirects windows to offscreen
//! pixmaps) the X root genuinely does not hold window content. Asserting on the
//! root would therefore fail on a working capture on half the world's displays
//! and pass on the other half, which makes it a test of the environment rather
//! than of the code. The window path is correct on BOTH, so that is where the
//! must-pass assertion lives; the root is measured and reported, and its result
//! is asserted against what the server has already told us it is.

#![cfg(target_os = "linux")]

use puca_capture::ScreenCapture;
use x11rb::connection::Connection;
use x11rb::protocol::xproto::{
    ConnectionExt, CreateGCAux, CreateWindowAux, EventMask, ImageFormat, Rectangle, WindowClass,
};
use x11rb::wrapper::ConnectionExt as _;

/// A colour unlikely to occur by accident, so a false positive is implausible.
const MARK_R: u8 = 0xC7;
const MARK_G: u8 = 0x2B;
const MARK_B: u8 = 0x9E;

struct Marked {
    conn: x11rb::rust_connection::RustConnection,
    win: u32,
}

impl Drop for Marked {
    fn drop(&mut self) {
        let _ = self.conn.destroy_window(self.win);
        let _ = self.conn.sync();
    }
}

/// Map an override-redirect window filled with the marker colour.
///
/// Override-redirect so no window manager is required: relying on a WM would
/// make this fail on a bare server, which is exactly where it needs to work.
fn draw_marker(w: u16, h: u16) -> Marked {
    let (conn, screen_num) = x11rb::connect(None).expect("no X server on $DISPLAY");
    let screen = &conn.setup().roots[screen_num];
    let (root, root_visual, black) = (screen.root, screen.root_visual, screen.black_pixel);

    let win = conn.generate_id().expect("window id");
    conn.create_window(
        x11rb::COPY_DEPTH_FROM_PARENT,
        win,
        root,
        0,
        0,
        w,
        h,
        0,
        WindowClass::INPUT_OUTPUT,
        root_visual,
        &CreateWindowAux::new()
            .override_redirect(1)
            .background_pixel(black)
            .event_mask(EventMask::EXPOSURE),
    )
    .expect("create_window")
    .check()
    .expect("create_window check");

    conn.map_window(win).expect("map").check().expect("map check");

    // The visual here is TrueColor 24/32-bit, so a packed 0xRRGGBB pixel value
    // is what the server expects.
    let gc = conn.generate_id().expect("gc id");
    let pixel = ((MARK_R as u32) << 16) | ((MARK_G as u32) << 8) | MARK_B as u32;
    conn.create_gc(gc, win, &CreateGCAux::new().foreground(pixel))
        .expect("create_gc")
        .check()
        .expect("create_gc check");
    conn.poly_fill_rectangle(win, gc, &[Rectangle { x: 0, y: 0, width: w, height: h }])
        .expect("fill");
    conn.sync().expect("sync");
    std::thread::sleep(std::time::Duration::from_millis(400));

    Marked { conn, win }
}

/// Is a compositing manager running, i.e. are windows redirected offscreen?
///
/// The standard check: `_NET_WM_CM_S<screen>` has a selection owner. Reported so
/// a root capture that comes back empty is explained rather than mysterious.
fn compositor_running(conn: &x11rb::rust_connection::RustConnection, screen: usize) -> bool {
    let name = format!("_NET_WM_CM_S{screen}");
    conn.intern_atom(false, name.as_bytes())
        .ok()
        .and_then(|c| c.reply().ok())
        .and_then(|r| conn.get_selection_owner(r.atom).ok())
        .and_then(|c| c.reply().ok())
        .map(|r| r.owner != x11rb::NONE)
        .unwrap_or(false)
}

/// THE MUST-PASS ASSERTION: capture returns the exact pixels drawn.
///
/// Uses the window path, which is correct on every X server — composited or
/// not. A stub, a zeroed buffer or a capture of the wrong drawable all fail.
#[test]
#[ignore = "needs a real X server; run with --ignored"]
fn captures_the_exact_colour_drawn_on_the_display() {
    let (w, h) = (400u16, 300u16);
    let marked = draw_marker(w, h);

    let mut cap = ScreenCapture::new_for_window(marked.win).expect("could not capture the window");
    println!("using MIT-SHM: {}", cap.using_shm());

    let mut sample = String::from("<none>");
    let mut found = false;
    for _ in 0..10 {
        let frame = cap.next_frame(200).expect("capture");
        assert!(frame.width > 0 && frame.height > 0, "real dimensions");
        assert_eq!(
            frame.bgra.len(),
            frame.stride * frame.height as usize,
            "buffer must match stride * height",
        );

        // Inside the drawn rectangle, away from its edges.
        if let Some((b, g, r, _)) = frame.pixel(40, 40) {
            sample = format!("#{r:02X}{g:02X}{b:02X}");
            // Exact match: X11 GetImage is lossless, so anything else means we
            // captured a different surface.
            if (r, g, b) == (MARK_R, MARK_G, MARK_B) {
                found = true;
                break;
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(150));
    }

    assert!(
        found,
        "the drawn colour #{MARK_R:02X}{MARK_G:02X}{MARK_B:02X} never appeared in the capture \
         (saw {sample}) -- the capture is not reading the surface we drew on",
    );
    println!("PASS: captured the exact colour drawn on the X display");
}

/// Whether a full-screen (root) capture can work on THIS display, and why.
///
/// Not a pass/fail on the code — it is a measurement of the server, asserted
/// against what that same server independently reports. It still fails on a
/// real defect: if a compositor is running the root MUST be empty of our window,
/// and if none is running the root MUST contain it. Either surprise means an
/// assumption in `linux_impl.rs` is wrong and the fullscreen path needs work.
#[test]
#[ignore = "needs a real X server; run with --ignored"]
fn root_capture_matches_what_the_server_says_about_compositing() {
    let (w, h) = (400u16, 300u16);
    let marked = draw_marker(w, h);
    let screen_num = 0;
    let composited = compositor_running(&marked.conn, screen_num);

    // Read the window drawable directly, so a root miss is attributed to
    // redirection rather than to the marker never having been drawn.
    let on_window = marked
        .conn
        .get_image(ImageFormat::Z_PIXMAP, marked.win, 40, 40, 1, 1, !0)
        .ok()
        .and_then(|c| c.reply().ok())
        .map(|r| (r.data[2], r.data[1], r.data[0]))
        .expect("could not read the window drawable");
    assert_eq!(
        on_window,
        (MARK_R, MARK_G, MARK_B),
        "the marker was never drawn -- this test cannot conclude anything about the root",
    );

    let mut cap = ScreenCapture::new(0).expect("could not start root capture");
    let mut on_root = (0u8, 0u8, 0u8);
    let mut in_root = false;
    for _ in 0..10 {
        let frame = cap.next_frame(200).expect("capture");
        if let Some((b, g, r, _)) = frame.pixel(40, 40) {
            on_root = (r, g, b);
            if on_root == (MARK_R, MARK_G, MARK_B) {
                in_root = true;
                break;
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(150));
    }

    println!(
        "compositor running: {composited}; marker in root capture: {in_root} \
         (root had #{:02X}{:02X}{:02X})",
        on_root.0, on_root.1, on_root.2
    );

    if composited {
        assert!(
            !in_root,
            "a compositor is running yet the root capture DID contain the window -- \
             the redirection assumption in linux_impl.rs is wrong for this server, \
             and the fullscreen path should be preferred here",
        );
        println!(
            "MEASURED: compositing server. Fullscreen X11 capture cannot see window \
             content here; use ScreenCapture::new_for_window, or the Wayland portal."
        );
    } else {
        assert!(
            in_root,
            "no compositor is running, so the root MUST contain the window -- \
             a miss here is a real fullscreen capture defect, not a platform limit",
        );
        println!("PASS: non-compositing server, fullscreen root capture works");
    }
}

#[test]
#[ignore = "needs a real X server; run with --ignored"]
fn repeated_capture_stays_stable() {
    // X11 has no per-frame resource to release the way DXGI does, but a leaked
    // SHM segment or reply buffer would show up as a failure partway through
    // rather than on the first call.
    let mut cap = ScreenCapture::new(0).expect("could not start capture");
    let mut ok = 0;
    for _ in 0..30 {
        match cap.next_frame(0) {
            Ok(f) => {
                assert!(f.width > 0 && f.height > 0);
                ok += 1;
            }
            Err(e) => panic!("capture broke partway through: {e}"),
        }
    }
    println!("{ok}/30 frames");
    assert_eq!(ok, 30);
}

/// A window that has gone away must be an error, not a silent black stream.
///
/// The agent's failure mode when sharing one application and the user closes it.
/// Returning zeroed frames would present to the controller as "the screen went
/// black" with nothing in any log.
#[test]
#[ignore = "needs a real X server; run with --ignored"]
fn capturing_a_destroyed_window_reports_an_error() {
    let win = {
        let marked = draw_marker(100, 100);
        let win = marked.win;
        // Prove capture worked BEFORE the window died, so a failure afterwards
        // is attributable to the destruction and not to a broken setup.
        let mut cap = ScreenCapture::new_for_window(win).expect("capture the live window");
        cap.next_frame(200).expect("the live window must capture");
        win
    }; // Marked::drop destroys and syncs here.

    std::thread::sleep(std::time::Duration::from_millis(200));
    match ScreenCapture::new_for_window(win).and_then(|mut c| c.next_frame(200)) {
        Err(e) => println!("PASS: destroyed window reports an error: {e}"),
        Ok(f) => panic!(
            "capturing a destroyed window returned a {}x{} frame instead of an error -- \
             the controller would see a black screen with nothing logged",
            f.width, f.height
        ),
    }
}

#[test]
#[ignore = "needs a real X server; run with --ignored"]
fn root_content_probe_agrees_with_a_real_capture() {
    // root_has_content() is what the agent uses to REFUSE a fullscreen session
    // with a real reason instead of streaming black. If it disagreed with an
    // actual capture it would be worse than not having it.
    let mut cap = ScreenCapture::new(0).expect("capture");
    let probe = cap.root_has_content();
    let direct = cap.next_frame(200).expect("capture").has_variation();
    println!("root_has_content()={probe} direct has_variation()={direct}");
    assert_eq!(probe, direct, "the probe must report what a real capture would show");
}
