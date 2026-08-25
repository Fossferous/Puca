//! LIVE capture test — needs a real display, so it is `#[ignore]`d by default.
//!
//!   cargo test -p puca-capture -- --ignored --nocapture --test-threads=1
//!
//! `--test-threads=1` is REQUIRED, not tidiness. DXGI duplication is EXCLUSIVE
//! per output: a second `DuplicateOutput` on the same monitor returns
//! E_ACCESSDENIED while the first is alive. Run in parallel, these two tests
//! fight over monitor 0 and one fails at construction — which reads like a
//! broken capture path and is not. The same exclusivity means the agent must
//! hold ONE duplication per monitor and share frames, never open a second.
//!
//! Deliberately NOT a silently-skipping test. A test that returns early when it
//! cannot find a display is a test that can never fail, and this is the one
//! claim in the whole agent that most needs proving: that a frame can be
//! captured with NO user gesture, NO picker, and NO window — which is precisely
//! what `getDisplayMedia` cannot do.
//!
//! The assertions are chosen so a stub cannot pass them. "A frame was returned"
//! would pass on a zero-filled buffer; a real screen has varied pixels.

use puca_capture::{CaptureError, ScreenCapture};

#[test]
#[ignore = "needs a real display; run with --ignored"]
fn captures_a_real_frame_with_no_gesture_and_no_picker() {
    let count = ScreenCapture::monitor_count();
    println!("monitors detected: {count}");
    assert!(count > 0, "no outputs found — cannot prove capture works");

    let mut cap = ScreenCapture::new(0).expect("could not start capturing monitor 0");

    // Duplication only produces a frame when something CHANGES, so a still
    // desktop legitimately times out. Retry rather than treating the first
    // timeout as failure — that misreading is why naive implementations look
    // broken on an idle machine.
    let mut frame = None;
    for attempt in 0..40 {
        match cap.next_frame(250) {
            Ok(f) => {
                println!(
                    "attempt {attempt}: {}x{} stride={} bytes={}",
                    f.width, f.height, f.stride, f.bgra.len()
                );
                if f.has_variation() {
                    frame = Some(f);
                    break;
                }
                // A uniform frame is suspicious but not conclusive on its own
                // (a locked or blanked screen is genuinely uniform), so keep
                // trying rather than passing on it.
                println!("attempt {attempt}: frame had no variation, retrying");
            }
            Err(CaptureError::Timeout) => { /* nothing moved; normal */ }
            Err(CaptureError::AccessLost) => println!("attempt {attempt}: access lost, rebuilding"),
            Err(e) => panic!("capture failed: {e}"),
        }
    }

    let frame = frame.expect(
        "no frame with any pixel variation after 40 attempts — \
         capture is producing blank buffers, or the screen is genuinely blank",
    );

    assert!(frame.width > 0 && frame.height > 0, "a real screen has non-zero dimensions");
    assert!(
        frame.stride >= frame.width as usize * 4,
        "stride must cover at least width*4 bytes"
    );
    assert_eq!(
        frame.bgra.len(),
        frame.stride * frame.height as usize,
        "buffer must match stride * height"
    );
    assert!(frame.pixel(0, 0).is_some(), "the top-left pixel must be readable");
    assert!(
        frame.pixel(frame.width - 1, frame.height - 1).is_some(),
        "the bottom-right pixel must be readable — proves stride handling"
    );
    assert!(frame.has_variation(), "a real desktop is not one flat colour");

    println!(
        "PASS: captured {}x{} with real content, no gesture and no picker",
        frame.width, frame.height
    );
}

#[test]
#[ignore = "needs a real display; run with --ignored"]
fn survives_repeated_capture_without_leaking_frames() {
    // Every successful AcquireNextFrame must be paired with ReleaseFrame. If one
    // is leaked, acquiring fails FOREVER after — so a loop is the only way to
    // catch it. A single-frame test passes happily with the bug present.
    let mut cap = ScreenCapture::new(0).expect("could not start capturing");
    let mut ok = 0;
    let mut timeouts = 0;
    for _ in 0..60 {
        match cap.next_frame(100) {
            Ok(_) => ok += 1,
            Err(CaptureError::Timeout) => timeouts += 1,
            Err(CaptureError::AccessLost) => { /* rebuilt on the next call */ }
            Err(e) => panic!("capture broke partway through: {e}"),
        }
    }
    println!("60 attempts: {ok} frames, {timeouts} timeouts");
    assert!(ok + timeouts > 0, "the capture loop produced nothing at all");
}
