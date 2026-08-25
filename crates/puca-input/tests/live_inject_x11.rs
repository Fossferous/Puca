//! LIVE X11 injection test — needs a real X server ($DISPLAY) with XTEST.
//!
//!   cargo test -p puca-input --test live_inject_x11 -- --ignored --nocapture
//!
//! The unit tests in `linux_impl` prove the LOOKUP TABLES. They cannot prove
//! that anything is actually injected: every one of them would still pass if
//! `inject` returned `Ok(())` without touching the X server. This file closes
//! that gap by asserting on OBSERVED EFFECT — where the pointer ended up, and
//! which key event a window actually received.
//!
//! The keyboard test is the valuable one. It sends a DOM `code` through the
//! whole path (code -> keysym -> this server's keycode -> XTEST) and then reads
//! the `KeyPress` event back off a real window and maps its keycode to a keysym
//! independently. That catches an off-by-one in the keycode table, a wrong
//! keysym constant, and a layout where the map resolved to the wrong physical
//! key — none of which the unit tests can see.

#![cfg(target_os = "linux")]

use puca_input::{
    clear_stuck_keys, inject, release_all, set_target, ControlInput, TargetMonitor,
};
use x11rb::connection::Connection;
use x11rb::protocol::xproto::{
    ConnectionExt, CreateWindowAux, EventMask, InputFocus, StackMode, WindowClass,
};
use x11rb::protocol::Event;
use x11rb::wrapper::ConnectionExt as _;

fn screen_size(conn: &x11rb::rust_connection::RustConnection, n: usize) -> (i32, i32) {
    let s = &conn.setup().roots[n];
    (s.width_in_pixels as i32, s.height_in_pixels as i32)
}

/// Make the whole screen the injection target, as the host does at grant time.
fn target_whole_screen(w: i32, h: i32) {
    set_target(Some(TargetMonitor {
        left: 0,
        top: 0,
        width: w,
        height: h,
        virt_left: 0,
        virt_top: 0,
        virt_width: w,
        virt_height: h,
    }));
}

#[test]
#[ignore = "needs a real X server with XTEST; run with --ignored"]
fn an_absolute_move_puts_the_pointer_where_it_was_told() {
    let (conn, n) = x11rb::connect(None).expect("no X server on $DISPLAY");
    let root = conn.setup().roots[n].root;
    let (w, h) = screen_size(&conn, n);
    target_whole_screen(w, h);

    // Two DIFFERENT destinations. One would pass if the pointer merely happened
    // to be sitting there already; requiring both makes that implausible.
    for (fx, fy) in [(0.25_f64, 0.75_f64), (0.6_f64, 0.2_f64)] {
        inject(ControlInput::Move { x: fx, y: fy }).expect("inject move");
        conn.sync().expect("sync");
        std::thread::sleep(std::time::Duration::from_millis(80));

        let p = conn.query_pointer(root).expect("query").reply().expect("query reply");
        let (want_x, want_y) = ((fx * w as f64) as i32, (fy * h as f64) as i32);
        println!("asked ({want_x},{want_y}) got ({},{})", p.root_x, p.root_y);
        // Exact is the honest expectation — XTEST absolute motion does not
        // round-trip through acceleration. A tolerance of 2px absorbs only
        // integer truncation.
        assert!(
            (p.root_x as i32 - want_x).abs() <= 2 && (p.root_y as i32 - want_y).abs() <= 2,
            "pointer did not land where it was told: wanted ({want_x},{want_y}), \
             got ({},{}) -- absolute motion mapping is wrong",
            p.root_x,
            p.root_y,
        );
    }
    println!("PASS: absolute moves land where asked");
}

#[test]
#[ignore = "needs a real X server with XTEST; run with --ignored"]
fn a_relative_move_shifts_the_pointer_by_the_delta() {
    let (conn, n) = x11rb::connect(None).expect("no X server");
    let root = conn.setup().roots[n].root;
    let (w, h) = screen_size(&conn, n);
    target_whole_screen(w, h);

    // Start from the middle so the delta cannot be clipped by a screen edge —
    // clipping would make a broken relative path look like a working one.
    inject(ControlInput::Move { x: 0.5, y: 0.5 }).expect("seed move");
    conn.sync().expect("sync");
    std::thread::sleep(std::time::Duration::from_millis(80));
    let before = conn.query_pointer(root).expect("q").reply().expect("qr");

    inject(ControlInput::Rmove { dx: 37.0, dy: -21.0 }).expect("inject rmove");
    conn.sync().expect("sync");
    std::thread::sleep(std::time::Duration::from_millis(80));
    let after = conn.query_pointer(root).expect("q").reply().expect("qr");

    let (dx, dy) = (
        after.root_x as i32 - before.root_x as i32,
        after.root_y as i32 - before.root_y as i32,
    );
    println!("relative delta applied: ({dx},{dy}) (asked 37,-21)");
    assert_eq!((dx, dy), (37, -21), "relative motion must apply the exact delta");
    println!("PASS: relative moves apply the exact delta");
}

/// THE ONE THAT MATTERS: a DOM `code` arrives at a window as the right key.
#[test]
#[ignore = "needs a real X server with XTEST; run with --ignored"]
fn an_injected_key_arrives_at_a_window_as_the_right_key() {
    let (conn, n) = x11rb::connect(None).expect("no X server");
    let screen = &conn.setup().roots[n];
    let (root, visual) = (screen.root, screen.root_visual);
    let min_keycode = conn.setup().min_keycode;
    let max_keycode = conn.setup().max_keycode;

    // Override-redirect so no window manager is needed to get focus.
    let win = conn.generate_id().expect("id");
    conn.create_window(
        x11rb::COPY_DEPTH_FROM_PARENT,
        win,
        root,
        0,
        0,
        200,
        200,
        0,
        WindowClass::INPUT_OUTPUT,
        visual,
        &CreateWindowAux::new()
            .override_redirect(1)
            .event_mask(EventMask::KEY_PRESS | EventMask::KEY_RELEASE),
    )
    .expect("create")
    .check()
    .expect("create check");
    conn.map_window(win).expect("map").check().expect("map check");
    conn.configure_window(
        win,
        &x11rb::protocol::xproto::ConfigureWindowAux::new().stack_mode(StackMode::ABOVE),
    )
    .expect("raise");
    conn.set_input_focus(InputFocus::PARENT, win, x11rb::CURRENT_TIME)
        .expect("focus")
        .check()
        .expect("focus check");
    conn.sync().expect("sync");
    std::thread::sleep(std::time::Duration::from_millis(200));

    // Drain anything queued before the test key, so we cannot read a stale event
    // and call it a pass.
    while conn.poll_for_event().ok().flatten().is_some() {}

    // Deliberately not a letter: a letter would pass even if the table
    // collapsed every code onto the same key, since the check would be
    // self-consistent. These three exercise three different table branches
    // (letter, digit, named key) and must each resolve distinctly.
    for (code, want_keysym) in [("KeyQ", 0x71_u32), ("Digit7", 0x37), ("Tab", 0xFF09)] {
        inject(ControlInput::Key { code: code.to_string(), down: true })
            .unwrap_or_else(|e| panic!("inject {code}: {e}"));
        conn.sync().expect("sync");

        let mut got = None;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while std::time::Instant::now() < deadline {
            match conn.poll_for_event() {
                Ok(Some(Event::KeyPress(ev))) => {
                    got = Some(ev.detail);
                    break;
                }
                Ok(Some(_)) => continue,
                Ok(None) => std::thread::sleep(std::time::Duration::from_millis(20)),
                Err(e) => panic!("event poll failed: {e}"),
            }
        }
        let _ = inject(ControlInput::Key { code: code.to_string(), down: false });
        conn.sync().expect("sync");

        let keycode = got.unwrap_or_else(|| {
            panic!("{code} was injected but NO KeyPress ever arrived -- injection is not reaching the server")
        });
        assert!(
            (min_keycode..=max_keycode).contains(&keycode),
            "{code} produced keycode {keycode}, outside the server's range",
        );

        // Resolve the received keycode back to a keysym INDEPENDENTLY of the
        // code under test. If this used the same lookup, a wrong table would
        // agree with itself and the test would prove nothing.
        let m = conn
            .get_keyboard_mapping(keycode, 1)
            .expect("mapping")
            .reply()
            .expect("mapping reply");
        let level0 = *m.keysyms.first().expect("at least one keysym");
        println!("{code} -> keycode {keycode} -> keysym {level0:#x} (want {want_keysym:#x})");
        assert_eq!(
            level0, want_keysym,
            "{code} was delivered as keysym {level0:#x}, not {want_keysym:#x} -- \
             the code->keysym->keycode mapping resolves to the wrong physical key",
        );
    }

    release_all();
    let _ = conn.destroy_window(win);
    let _ = conn.sync();
    println!("PASS: injected keys arrive as the correct keys");
}

/// A held key must not survive the session.
#[test]
#[ignore = "needs a real X server with XTEST; run with --ignored"]
fn release_all_clears_a_key_left_held() {
    let (conn, _) = x11rb::connect(None).expect("no X server");

    inject(ControlInput::Key { code: "ShiftLeft".into(), down: true }).expect("press");
    conn.sync().expect("sync");
    std::thread::sleep(std::time::Duration::from_millis(80));

    let held = conn.query_keymap().expect("keymap").reply().expect("keymap reply");
    let any_down = held.keys.iter().any(|b| *b != 0);
    assert!(any_down, "the test could not hold a key down, so it cannot prove release works");

    release_all();
    conn.sync().expect("sync");
    std::thread::sleep(std::time::Duration::from_millis(120));

    let after = conn.query_keymap().expect("keymap").reply().expect("keymap reply");
    let still: Vec<usize> = after
        .keys
        .iter()
        .enumerate()
        .filter(|(_, b)| **b != 0)
        .map(|(i, _)| i)
        .collect();
    assert!(
        still.is_empty(),
        "keys are STILL held after release_all (keymap bytes {still:?}) -- \
         a stuck key outlives the session and looks like broken hardware",
    );
    println!("PASS: release_all clears held keys");
}

/// Wheel scroll must be button 4/5 press+release, not a no-op.
#[test]
#[ignore = "needs a real X server with XTEST; run with --ignored"]
fn wheel_scroll_reaches_a_window_as_button_events() {
    let (conn, n) = x11rb::connect(None).expect("no X server");
    let screen = &conn.setup().roots[n];
    let (root, visual) = (screen.root, screen.root_visual);
    let (w, h) = screen_size(&conn, n);
    target_whole_screen(w, h);

    let win = conn.generate_id().expect("id");
    conn.create_window(
        x11rb::COPY_DEPTH_FROM_PARENT,
        win,
        root,
        0,
        0,
        300,
        300,
        0,
        WindowClass::INPUT_OUTPUT,
        visual,
        &CreateWindowAux::new()
            .override_redirect(1)
            .event_mask(EventMask::BUTTON_PRESS | EventMask::BUTTON_RELEASE),
    )
    .expect("create")
    .check()
    .expect("create check");
    conn.map_window(win).expect("map").check().expect("map check");
    conn.sync().expect("sync");
    std::thread::sleep(std::time::Duration::from_millis(200));

    // Put the pointer inside the window, or the events go somewhere else.
    inject(ControlInput::Move { x: 150.0 / w as f64, y: 150.0 / h as f64 }).expect("move");
    conn.sync().expect("sync");
    std::thread::sleep(std::time::Duration::from_millis(80));
    while conn.poll_for_event().ok().flatten().is_some() {}

    // dy > 0 is scroll-up, which X11 delivers as button 4.
    inject(ControlInput::Wheel { dy: 1.0 }).expect("wheel");
    conn.sync().expect("sync");

    let mut seen = Vec::new();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    while std::time::Instant::now() < deadline && seen.len() < 2 {
        match conn.poll_for_event() {
            Ok(Some(Event::ButtonPress(e))) => seen.push(('p', e.detail)),
            Ok(Some(Event::ButtonRelease(e))) => seen.push(('r', e.detail)),
            Ok(Some(_)) => continue,
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(20)),
            Err(e) => panic!("poll: {e}"),
        }
    }
    let _ = conn.destroy_window(win);
    let _ = conn.sync();

    println!("wheel produced {seen:?}");
    assert_eq!(
        seen,
        vec![('p', 4), ('r', 4)],
        "scroll-up must be a press AND release of button 4 -- a press with no \
         release leaves the button latched",
    );
    println!("PASS: wheel scroll arrives as button 4 press+release");
}

/// Recovery from a CRASHED agent — the case `release_all` structurally cannot
/// handle.
///
/// The key here is pressed by the test's OWN X connection, never through
/// `inject`, so our per-process tracking has no record of it. That is exactly
/// the state a killed agent leaves behind, and it is not hypothetical: a
/// sabotage run during development left a real ShiftLeft held across process
/// restarts. `release_all` is asserted to be INSUFFICIENT first, so this cannot
/// silently degrade into re-testing the easy path.
#[test]
#[ignore = "needs a real X server with XTEST; run with --ignored"]
fn a_key_held_by_a_dead_process_is_cleared_on_recovery() {
    use x11rb::protocol::xtest::ConnectionExt as _;
    let (conn, n) = x11rb::connect(None).expect("no X server");
    let root = conn.setup().roots[n].root;

    // Start from a clean slate, or a leftover from another test would let this
    // pass without proving anything.
    let _ = clear_stuck_keys();
    conn.sync().expect("sync");
    std::thread::sleep(std::time::Duration::from_millis(100));

    // ControlLeft, pressed OUTSIDE our injector — the "previous process died
    // holding this" state.
    let keycode = 37_u8;
    conn.xtest_fake_input(2 /* KeyPress */, keycode, 0, root, 0, 0, 0)
        .expect("raw press");
    conn.sync().expect("sync");
    std::thread::sleep(std::time::Duration::from_millis(120));

    let held = conn.query_keymap().expect("km").reply().expect("km reply");
    assert!(
        held.keys.iter().any(|b| *b != 0),
        "could not hold a key outside the injector, so this test proves nothing",
    );

    // release_all knows nothing about it, so the key MUST still be held after.
    release_all();
    conn.sync().expect("sync");
    std::thread::sleep(std::time::Duration::from_millis(120));
    let after_release_all = conn.query_keymap().expect("km").reply().expect("km reply");
    assert!(
        after_release_all.keys.iter().any(|b| *b != 0),
        "release_all cleared an untracked key -- if that is now true this test is          obsolete, but it also means the tracking assumption changed silently",
    );

    let cleared = clear_stuck_keys().expect("clear_stuck_keys");
    conn.sync().expect("sync");
    std::thread::sleep(std::time::Duration::from_millis(120));

    let after = conn.query_keymap().expect("km").reply().expect("km reply");
    let still: Vec<usize> = after
        .keys
        .iter()
        .enumerate()
        .filter(|(_, b)| **b != 0)
        .map(|(i, _)| i)
        .collect();
    println!("clear_stuck_keys released {cleared} key(s); remaining bitmap bytes {still:?}");
    assert!(cleared >= 1, "nothing was reported as cleared, yet a key was held");
    assert!(
        still.is_empty(),
        "a key held by a dead process survived recovery (bitmap bytes {still:?})",
    );
    println!("PASS: a key held by a dead process is cleared on recovery");
}
