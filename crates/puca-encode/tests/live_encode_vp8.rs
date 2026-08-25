//! LIVE VP8 encode test — needs the `vp8` feature and a real libvpx.
//!
//!   cargo test -p puca-encode --features vp8 --test live_encode_vp8 \
//!       -- --ignored --nocapture --test-threads=1
//!
//! Asserts on the BITSTREAM, not on the encoder's own claims. An encoder that
//! returned plausible-looking bytes with the wrong frame type, the wrong
//! dimensions, or that silently ignored a keyframe request would pass every
//! "did it return Ok" check and then fail in the field as a black rectangle
//! nobody can explain.
//!
//! The decisive one is `a_forced_keyframe_is_actually_a_keyframe`: forcing a
//! keyframe on demand is the whole reason this crate calls libvpx directly
//! rather than using `vpx-encode`, which cannot do it.

#![cfg(all(unix, feature = "vp8"))]

use puca_encode::{is_vp8_keyframe, vp8_keyframe_dimensions, FrameCodec, Vp8Encoder};

const W: u32 = 320;
const H: u32 = 240;

/// A frame with a block at a moving position, so successive frames genuinely
/// differ. A static or flat image would let a broken encoder emit near-empty
/// deltas and still look like it was working.
fn frame(step: usize) -> Vec<u8> {
    let stride = W as usize * 4;
    let mut buf = vec![40u8; stride * H as usize];
    for y in 20..80usize {
        for x in 0..60usize {
            let px = (x + step * 9) % W as usize;
            let i = y * stride + px * 4;
            buf[i] = 220; // B
            buf[i + 1] = 60; // G
            buf[i + 2] = 30; // R
            buf[i + 3] = 255;
        }
    }
    buf
}

#[test]
#[ignore = "needs libvpx; run with --features vp8 --ignored"]
fn encodes_real_vp8_with_a_correct_bitstream() {
    let mut enc = Vp8Encoder::new(W, H, 30, 1200).expect("encoder");
    let stride = W as usize * 4;

    let first = enc.encode_bgra(&frame(0), stride, true).expect("first frame");
    assert_eq!(first.codec, FrameCodec::Vp8, "frames must be tagged VP8");
    assert!(!first.data.is_empty(), "an empty frame is not output");
    assert!(first.keyframe, "the first forced frame must be a keyframe");

    // The bitstream must agree with the flag, independently of what we set.
    assert!(is_vp8_keyframe(&first.data), "flag says key but the bitstream does not");
    assert_eq!(
        vp8_keyframe_dimensions(&first.data),
        Some((W as u16, H as u16)),
        "the keyframe declares the wrong size — a stretched or torn picture",
    );

    // Subsequent frames must be DELTAS. An encoder emitting keyframes forever
    // would work but flood the link, and would hide a broken force_key.
    let mut deltas = 0;
    for step in 1..12 {
        let f = enc.encode_bgra(&frame(step), stride, false).expect("delta");
        assert_eq!(f.codec, FrameCodec::Vp8);
        assert!(!f.data.is_empty());
        if !f.keyframe {
            deltas += 1;
            assert!(!is_vp8_keyframe(&f.data), "flag says delta but the bitstream says key");
        }
    }
    assert!(deltas >= 8, "expected mostly deltas after the first frame, got {deltas}");
    println!("PASS: real VP8, {deltas} deltas, keyframe declares {W}x{H}");
}

#[test]
#[ignore = "needs libvpx; run with --features vp8 --ignored"]
fn a_forced_keyframe_is_actually_a_keyframe() {
    // THE ONE THAT JUSTIFIES THE RAW FFI. A sender that cannot honour a PLI
    // leaves any viewer who joins late — or drops the one keyframe — staring at
    // a black rectangle forever. `vpx-encode` cannot express this at all, which
    // is why this crate calls libvpx directly.
    let mut enc = Vp8Encoder::new(W, H, 30, 1200).expect("encoder");
    let stride = W as usize * 4;

    enc.encode_bgra(&frame(0), stride, true).expect("seed");
    // Run well past any automatic keyframe interval so the next one can only be
    // ours.
    for step in 1..20 {
        enc.encode_bgra(&frame(step), stride, false).expect("delta");
    }

    let forced = enc.encode_bgra(&frame(20), stride, true).expect("forced");
    assert!(forced.keyframe, "force_key did not produce a keyframe");
    assert!(is_vp8_keyframe(&forced.data), "the forced frame is not a keyframe in the bitstream");
    println!("PASS: force_key produces a real keyframe mid-stream");
}

#[test]
#[ignore = "needs libvpx; run with --features vp8 --ignored"]
fn a_padded_stride_does_not_shear_the_picture() {
    // The Windows capture path pads rows. Converting as if stride were width*4
    // walks diagonally through the image — a picture that leans, with no error.
    // Here the padding is filled with a colour that must NOT appear in the
    // output's luma if the stride is honoured.
    let mut enc = Vp8Encoder::new(W, H, 30, 1200).expect("encoder");
    let stride = W as usize * 4 + 64;
    let mut buf = vec![0u8; stride * H as usize];
    for row in 0..H as usize {
        for col in 0..W as usize {
            let i = row * stride + col * 4;
            buf[i + 1] = 200; // green content
            buf[i + 3] = 255;
        }
        // Padding: bright red, which would skew the picture if read as content.
        for pad in (W as usize * 4)..stride {
            buf[row * stride + pad] = if pad % 4 == 2 { 255 } else { 0 };
        }
    }
    let f = enc.encode_bgra(&buf, stride, true).expect("encode with padding");
    assert!(f.keyframe && is_vp8_keyframe(&f.data));
    assert_eq!(vp8_keyframe_dimensions(&f.data), Some((W as u16, H as u16)));
    println!("PASS: padded stride encodes without shearing");
}

#[test]
#[ignore = "needs libvpx; run with --features vp8 --ignored"]
fn it_never_reports_need_more_input() {
    // libvpx is SYNCHRONOUS. NeedMoreInput exists for the Windows MFT's ~16
    // frame pipeline, and the agent's stream loop maps it to "skip" — so a VP8
    // encoder returning it would be an invisible, permanent no-video.
    use puca_encode::EncodeError;
    let mut enc = Vp8Encoder::new(W, H, 30, 1200).expect("encoder");
    let stride = W as usize * 4;
    for step in 0..5 {
        match enc.encode_bgra(&frame(step), stride, step == 0) {
            Ok(_) => {}
            Err(EncodeError::NeedMoreInput) => {
                panic!("VP8 must never return NeedMoreInput; the stream loop would skip forever")
            }
            Err(e) => panic!("unexpected error: {e}"),
        }
    }
    println!("PASS: every frame produced output synchronously");
}
