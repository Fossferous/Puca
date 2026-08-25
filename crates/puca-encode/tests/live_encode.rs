//! LIVE encode test — needs a real display and a working H.264 encoder.
//!
//!   cargo test -p puca-encode -- --ignored --nocapture --test-threads=1
//!
//! `--test-threads=1` because these capture the screen, and DXGI duplication is
//! exclusive per output.
//!
//! The assertions are chosen so a stub cannot pass: "encoding returned Ok"
//! would pass on an empty buffer, so this checks for real Annex-B NAL units, a
//! genuine IDR, and a compression ratio that only real encoding produces.

use puca_capture::{CaptureError, ScreenCapture};
use puca_encode::{contains_idr, has_start_code, nal_types, EncodeError, H264Encoder};

/// Grab one frame with real content, retrying past the timeouts a still desktop
/// produces.
fn grab_frame(cap: &mut ScreenCapture) -> Option<(Vec<u8>, usize, u32, u32)> {
    for _ in 0..40 {
        match cap.next_frame(250) {
            Ok(f) if f.has_variation() => return Some((f.bgra, f.stride, f.width, f.height)),
            Ok(_) => {}
            Err(CaptureError::Timeout) | Err(CaptureError::AccessLost) => {}
            Err(e) => panic!("capture failed: {e}"),
        }
    }
    None
}

#[test]
#[ignore = "needs a real display and encoder; run with --ignored --test-threads=1"]
fn encodes_real_captured_frames_into_a_valid_h264_stream() {
    let mut cap = ScreenCapture::new(0).expect("could not start capturing");
    let (bgra, stride, width, height) = grab_frame(&mut cap).expect("no frame with content");
    println!("captured {width}x{height} stride={stride} raw={} bytes", bgra.len());

    // Even dimensions: H.264 macroblocks are 16x16 and NV12 chroma is
    // subsampled 2x2, so an odd size is not representable.
    let (w, h) = (width & !1, height & !1);
    let mut enc = H264Encoder::new(w, h, 30, 6_000_000).expect("could not create the encoder");

    let mut encoded = Vec::new();
    let mut raw_total = 0usize;

    // Feed several frames: the encoder needs a few before the pipeline emits,
    // and one frame would not prove the loop keeps working.
    for i in 0..30 {
        let frame = match grab_frame(&mut cap) {
            Some(f) => f,
            // A still screen stops producing frames; reuse the first one so the
            // encoder still gets input.
            None => (bgra.clone(), stride, width, height),
        };
        raw_total += frame.0.len();
        match enc.encode_bgra(&frame.0, frame.1, i == 0) {
            Ok(out) => {
                println!(
                    "frame {i}: {} bytes, keyframe={}, nals={:?}",
                    out.data.len(),
                    out.keyframe,
                    nal_types(&out.data),
                );
                encoded.push(out);
            }
            Err(EncodeError::NeedMoreInput) => println!("frame {i}: pipeline still filling"),
            Err(e) => panic!("encode failed: {e}"),
        }
        if encoded.len() >= 5 {
            break;
        }
    }

    assert!(!encoded.is_empty(), "the encoder never produced a frame");

    let first = &encoded[0];
    assert!(has_start_code(&first.data), "output must be Annex-B (start-code delimited)");
    assert!(
        !nal_types(&first.data).is_empty(),
        "output must contain at least one NAL unit"
    );

    // A joining viewer can only start decoding from an IDR. If none is ever
    // produced the remote screen stays black forever, and every other signal
    // looks healthy.
    assert!(
        encoded.iter().any(|f| contains_idr(&f.data)),
        "no IDR keyframe in any encoded frame — a viewer could never start decoding"
    );
    assert!(
        encoded.iter().any(|f| f.keyframe),
        "keyframe detection never fired, though an IDR was present"
    );

    let encoded_total: usize = encoded.iter().map(|f| f.data.len()).sum();
    println!(
        "raw {} bytes -> encoded {} bytes across {} frames",
        raw_total,
        encoded_total,
        encoded.len()
    );
    assert!(encoded_total > 0, "encoded output was empty");

    // The whole justification for this crate. Raw was ~14.7 MB/frame; if the
    // ratio is not dramatic, something is passing bytes through rather than
    // compressing them.
    let ratio = raw_total as f64 / encoded_total as f64;
    println!("compression ratio: {ratio:.1}x");
    assert!(
        ratio > 20.0,
        "compression ratio {ratio:.1}x is implausibly low — is this really encoding?"
    );
}

/// HOW DEEP IS THE ENCODER'S PIPELINE?
///
/// This is the latency question for remote control. This crate's own header
/// recorded that the MFT "buffers roughly 16 frames before emitting anything —
/// at 30fps that is around half a second", and named `CODECAPI_AVLowLatencyMode`
/// as the untested lever. Half a second between moving a finger and seeing the
/// result is the difference between a usable remote desktop and an unusable
/// one, so the depth is measured here rather than assumed.
///
/// The threshold is deliberately generous: an encoder that emits within three
/// inputs is interactive, one that needs sixteen is not. Run it before and
/// after changing the encoder's configuration — the number it prints is the
/// point of the test, not just the pass/fail.
#[test]
#[ignore = "needs a real encoder; run with --ignored --test-threads=1"]
fn the_first_encoded_frame_emerges_within_a_few_inputs() {
    let mut cap = ScreenCapture::new(0).expect("could not start capturing");
    let (bgra, stride, width, height) = grab_frame(&mut cap).expect("no frame with content");
    let (w, h) = (width & !1, height & !1);
    let mut enc = H264Encoder::new(w, h, 30, 6_000_000).expect("could not create the encoder");

    let mut fed = 0usize;
    let mut emerged_at = None;
    for i in 0..40 {
        let frame = grab_frame(&mut cap).unwrap_or_else(|| (bgra.clone(), stride, width, height));
        fed += 1;
        match enc.encode_bgra(&frame.0, frame.1, i == 0) {
            Ok(out) if !out.data.is_empty() => {
                emerged_at = Some(fed);
                break;
            }
            Ok(_) => {}
            Err(EncodeError::NeedMoreInput) => {}
            Err(e) => panic!("encode failed: {e}"),
        }
    }

    let depth = emerged_at.expect("the encoder never emitted a frame at all");
    println!("first encoded frame emerged after {depth} input frame(s)");
    println!("  ~{:.0}ms of pipeline latency at 30fps", depth as f64 * 1000.0 / 30.0);
    assert!(
        depth <= 3,
        "the encoder held {depth} frames before emitting one — about {:.0}ms of \
         latency at 30fps, before capture, network or decode. Remote control is \
         unusable at that depth.",
        depth as f64 * 1000.0 / 30.0,
    );
}

#[test]
#[ignore = "needs a real encoder; run with --ignored --test-threads=1"]
fn a_frame_shorter_than_its_stride_is_refused() {
    // Guards against reading past the end of a caller's buffer, which is a
    // crash in the best case and someone else's memory in the worst.
    let mut enc = H264Encoder::new(64, 64, 30, 500_000).expect("encoder");
    let too_small = vec![0u8; 64 * 4 * 10]; // 10 rows, not 64
    assert!(enc.encode_bgra(&too_small, 64 * 4, false).is_err());
}

/// Does the encoder keep up, frame for frame, at a real capture cadence?
///
/// `the_first_encoded_frame_emerges_within_a_few_inputs` only measures the
/// pipeline's DEPTH — how far behind the stream settles. This measures whether
/// it stays there. An asynchronous hardware MFT can refuse input when it is
/// busy, and the agent's answer to that is to drop the frame; a few drops are
/// invisible, but an encoder that only accepts two frames in three turns a
/// 30fps stream into 20fps while every counter still says "fine".
///
/// The number it prints is the point. Sustained yield is the pass/fail.
#[test]
#[ignore = "needs a real display and encoder; run with --ignored --test-threads=1"]
fn the_encoder_keeps_up_at_capture_cadence() {
    let mut cap = ScreenCapture::new(0).expect("could not start capturing");
    let (bgra, stride, width, height) = grab_frame(&mut cap).expect("no frame with content");
    let (w, h) = (width & !1, height & !1);
    let mut enc = H264Encoder::new(w, h, 30, 6_000_000).expect("could not create the encoder");
    println!("backend: {}", enc.backend());

    // Warm up past the fill depth so the measurement is of steady state.
    for _ in 0..5 {
        let _ = enc.encode_bgra(&bgra, stride, false);
    }

    const FRAMES: usize = 60;
    let mut out = 0usize;
    let mut fresh = 0usize;
    let mut bytes = 0usize;
    let mut keyframes = 0usize;
    let mut worst = std::time::Duration::ZERO;
    let mut total = std::time::Duration::ZERO;
    for i in 0..FRAMES {
        // Count how often the DESKTOP actually produced something. Falling back
        // to the cached frame is fine occasionally — a still screen sends
        // nothing — but if duplication were dead for the whole run, every
        // iteration would feed the same static buffer. That is the easiest
        // possible input for a rate-controlled encoder, so the test would pass
        // having proved nothing about capture at all.
        let frame = match grab_frame(&mut cap) {
            Some(f) => {
                fresh += 1;
                f
            }
            None => (bgra.clone(), stride, width, height),
        };
        let t0 = std::time::Instant::now();
        match enc.encode_bgra(&frame.0, frame.1, i == 0) {
            Ok(f) => {
                assert!(!f.data.is_empty(), "the encoder returned Ok with no bytes in it");
                out += 1;
                bytes += f.data.len();
                if f.keyframe {
                    keyframes += 1;
                }
            }
            Err(EncodeError::NeedMoreInput) => {}
            Err(e) => panic!("encode failed: {e}"),
        }
        let took = t0.elapsed();
        total += took;
        worst = worst.max(took);
    }
    let mean_ms = total.as_secs_f64() * 1000.0 / FRAMES as f64;

    println!(
        "{out}/{FRAMES} out, {fresh} fresh captures, {keyframes} keyframes, {bytes} bytes; encode_bgra mean {mean_ms:.1}ms worst {:.1}ms",
        worst.as_secs_f64() * 1000.0,
    );

    // Two allowances, both deliberate: the encoder may still be one frame
    // behind at the end, and a single hiccup should not fail a timing test on a
    // machine that is also running a desktop.
    assert!(
        out + 2 >= FRAMES,
        "only {out} of {FRAMES} frames came back out — the encoder is dropping input, which shows up to a viewer as a stuttering picture while every frame counter still looks healthy",
    );

    // THE TIME IS THE POINT, so assert it rather than only printing it. This
    // test computed a mean, a worst case and an achievable frame rate, printed
    // all three and asserted none of them — an encoder taking 200ms per call, a
    // comprehensively broken "keeps up", passed. The budget is one whole 30fps
    // frame period, because this measures only the CPU side of `encode_bgra`
    // and capture, sealing and the network share the same 33ms.
    assert!(
        mean_ms < 33.0,
        "encode_bgra averaged {mean_ms:.1}ms, a whole frame period on its own — there is no budget left for capture, sealing or the network",
    );

    // The keyframe was REQUESTED on the first input. Frames coming back with no
    // keyframe among them means a viewer joining mid-stream has nothing it can
    // decode: a black picture from a pipeline whose counters all read healthy.
    assert!(keyframes >= 1, "no keyframe came back despite the first input asking for one");

    assert!(
        fresh > 0,
        "the desktop never produced a frame in {FRAMES} attempts — this run encoded one cached still image and proves nothing about capture",
    );
}

/// Pacing bench for the CLIP AUTO-ARM path (frontend/src-tauri/src/clip_capture.rs
/// runs exactly this loop): how much CPU does capture+convert+encode of the
/// real desktop cost per frame, and can it hold the target fps? Prints
/// numbers; the only assertion is that it ran. Requested by the 2026-08-19
/// field report "puca was making games choppy" — the suspect is the
/// armed buffer's continuous encode, and this measures the native path's
/// share of it headlessly (no window, no focus change; a real game A/B is
/// the on-device walk's job).
#[test]
#[ignore = "live pacing bench; run with --ignored --nocapture --test-threads=1"]
fn bench_clip_capture_encode_pacing() {
    use std::time::{Duration, Instant};
    let mut cap = ScreenCapture::new(0).expect("could not start capturing");
    let first = grab_frame(&mut cap).expect("no frame with content");
    let (w, h) = (first.2 & !1, first.3 & !1);
    // The auto-arm bitrate rule: preset 6 Mbps @ 1920x1080, scaled by pixels, clamped.
    let bitrate = ((6_000_000u64 * (w as u64 * h as u64) / (1920 * 1080)).clamp(1_500_000, 20_000_000)) as u32;
    let fps = 60u32;
    let mut enc = H264Encoder::new(w, h, fps, bitrate).expect("could not create the encoder");
    println!("bench: {w}x{h} @ {fps} fps target, {} kbps, backend={}", bitrate / 1000, enc.backend());

    let run = Duration::from_secs(10);
    let start = Instant::now();
    let mut frames = 0u32;
    let mut timeouts = 0u32;
    let mut need_more = 0u32;
    let mut bytes = 0usize;
    let mut encode_ms: Vec<f64> = Vec::new();
    let mut last_key = Instant::now() - Duration::from_secs(10);
    let mut cached: Option<(Vec<u8>, usize)> = Some((first.0, first.1));
    while start.elapsed() < run {
        let frame = match cap.next_frame(16) {
            Ok(f) => { let fr = (f.bgra, f.stride); cached = Some(fr.clone()); fr }
            Err(CaptureError::Timeout) => match &cached { Some(c) => { timeouts += 1; c.clone() } None => continue },
            Err(CaptureError::AccessLost) => continue,
            Err(e) => panic!("capture failed: {e}"),
        };
        let force_key = last_key.elapsed() >= Duration::from_secs(2);
        let t0 = Instant::now();
        match enc.encode_bgra(&frame.0, frame.1, force_key) {
            Ok(out) => {
                encode_ms.push(t0.elapsed().as_secs_f64() * 1000.0);
                if out.keyframe { last_key = Instant::now(); }
                frames += 1;
                bytes += out.data.len();
            }
            Err(EncodeError::NeedMoreInput) => { need_more += 1; }
            Err(e) => panic!("encode failed: {e}"),
        }
    }
    encode_ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let wall = start.elapsed().as_secs_f64();
    let total_ms: f64 = encode_ms.iter().sum();
    let mean = if encode_ms.is_empty() { 0.0 } else { total_ms / encode_ms.len() as f64 };
    let p95 = encode_ms.get(encode_ms.len().saturating_mul(95) / 100).copied().unwrap_or(0.0);
    let p99 = encode_ms.get(encode_ms.len().saturating_mul(99) / 100).copied().unwrap_or(0.0);
    println!(
        "bench: {frames} frames in {wall:.1}s = {:.1} fps achieved ({timeouts} still-screen re-submits, {need_more} NeedMoreInput)",
        frames as f64 / wall
    );
    println!(
        "bench: encode_bgra (BGRA->NV12 convert + MFT submit/drain): mean {mean:.2} ms, p95 {p95:.2} ms, p99 {p99:.2} ms per frame"
    );
    println!(
        "bench: CPU share of ONE core at the achieved rate: {:.0}% | bitstream {:.1} Mbps",
        100.0 * (total_ms / 1000.0) / wall,
        (bytes as f64 * 8.0) / wall / 1e6
    );
    assert!(frames > 0, "no frames encoded — the bench measured nothing");
}

/// The clip auto-arm loop's keyframe cadence on the REAL encoder: force a key
/// every 2 s (exactly what clip_capture.rs does) and check IDRs actually come
/// out. Written to diagnose the 0.8.108 field failure "part 1 exceeds
/// PART_MAX_PLAINTEXT": with the infinite-GOP config, a force-key that does
/// not work means ONE IDR ever (the fresh encoder's first frame) and the mux
/// emits the whole clip as a single giant fragment.
#[test]
#[ignore = "live keyframe-cadence check; run with --ignored --nocapture --test-threads=1"]
fn forced_keyframes_actually_come_out_every_gop() {
    use std::time::{Duration, Instant};
    let mut cap = ScreenCapture::new(0).expect("could not start capturing");
    let first = grab_frame(&mut cap).expect("no frame with content");
    let (w, h) = (first.2 & !1, first.3 & !1);
    let mut enc = H264Encoder::new(w, h, 30, 6_000_000).expect("could not create the encoder");
    println!("cadence: {w}x{h} backend={}", enc.backend());

    let run = Duration::from_secs(8);
    let start = Instant::now();
    let mut last_key_at: i64 = -2_000_000; // force on the first frame, like the clip loop
    let mut frames = 0u32;
    let mut key_times_ms: Vec<u64> = Vec::new();
    let mut cached: Option<(Vec<u8>, usize)> = Some((first.0, first.1));
    while start.elapsed() < run {
        let frame = match cap.next_frame(33) {
            Ok(f) => { let fr = (f.bgra, f.stride); cached = Some(fr.clone()); fr }
            Err(CaptureError::Timeout) => match &cached { Some(c) => c.clone(), None => continue },
            Err(CaptureError::AccessLost) => continue,
            Err(e) => panic!("capture failed: {e}"),
        };
        let ts_us = start.elapsed().as_micros() as i64;
        let force_key = ts_us - last_key_at >= 2_000_000;
        // Pace on the REQUEST, exactly like clip_capture.rs: the async MFT
        // delivers the key a frame or two later, and pacing on delivery
        // double-requested (measured: IDR pairs ~14 ms apart every GOP).
        if force_key {
            last_key_at = ts_us;
        }
        match enc.encode_bgra(&frame.0, frame.1, force_key) {
            Ok(out) => {
                frames += 1;
                if out.keyframe {
                    key_times_ms.push((ts_us / 1000) as u64);
                }
            }
            Err(EncodeError::NeedMoreInput) => {}
            Err(e) => panic!("encode failed: {e}"),
        }
    }
    println!("cadence: {frames} frames in 8s; keyframes at (ms): {key_times_ms:?}");
    let max_gap = key_times_ms.windows(2).map(|w| w[1] - w[0]).max().unwrap_or(8_000);
    println!("cadence: {} keyframes, max inter-key gap {} ms", key_times_ms.len(), max_gap);
    assert!(
        key_times_ms.len() >= 3 && max_gap < 3_500,
        "force-key is NOT producing IDRs: {} keyframes in 8 s (expected ~4, one per 2 s GOP), max gap {} ms — \
         this is the 0.8.108 'part 1 exceeds PART_MAX_PLAINTEXT' root cause",
        key_times_ms.len(), max_gap
    );
    let min_gap = key_times_ms.windows(2).map(|w| w[1] - w[0]).min().unwrap_or(8_000);
    assert!(
        min_gap > 500,
        "keyframes arrive in PAIRS ({min_gap} ms apart) — the caller is pacing on delivery instead of on the request"
    );
}

/// `update_size` must reconfigure the LIVE transform (or refuse cleanly).
/// Synthetic frames on purpose: the property under test is the transform
/// surviving a media-type change, not capture — and skipping capture frees
/// the test from DXGI exclusivity.
#[test]
#[ignore = "needs a working H.264 encoder; run with --ignored --test-threads=1"]
fn update_size_reconfigures_without_a_rebuild() {
    fn synth(w: u32, h: u32, seed: u8) -> (Vec<u8>, usize) {
        let stride = w as usize * 4;
        let mut b = vec![0u8; stride * h as usize];
        for y in 0..h as usize {
            for x in 0..w as usize {
                let at = y * stride + x * 4;
                b[at] = (x as u8).wrapping_add(seed);
                b[at + 1] = (y as u8).wrapping_mul(3);
                b[at + 2] = seed;
                b[at + 3] = 255;
            }
        }
        (b, stride)
    }
    let mut enc = H264Encoder::new(1920, 1080, 30, 6_000_000).expect("create");
    let (f1, s1) = synth(1920, 1080, 7);
    let mut got = 0;
    for i in 0..30 {
        match enc.encode_bgra(&f1, s1, i == 0) {
            Ok(_) => {
                got += 1;
                if got >= 3 {
                    break;
                }
            }
            Err(EncodeError::NeedMoreInput) => {}
            Err(e) => panic!("warmup encode failed: {e}"),
        }
    }
    assert!(got >= 1, "the encoder never produced output at the first size");

    let t0 = std::time::Instant::now();
    let ok = enc.update_size(2560, 1440);
    println!("update_size(2560x1440) -> {ok} in {} ms", t0.elapsed().as_millis());

    if ok {
        assert_eq!(enc.dims(), (2560, 1440));
        let (f2, s2) = synth(2560, 1440, 90);
        let mut first = None;
        for _ in 0..30 {
            match enc.encode_bgra(&f2, s2, false) {
                Ok(out) => {
                    first = Some(out);
                    break;
                }
                Err(EncodeError::NeedMoreInput) => {}
                Err(e) => panic!("encode after update_size failed: {e}"),
            }
        }
        let first = first.expect("no output after the size change");
        assert!(
            contains_idr(&first.data),
            "the first frame at a new size must be an IDR — a viewer can only start decoding there"
        );
        assert!(first.keyframe);
    } else {
        println!("this transform refuses live resize — the caller rebuilds (the old path)");
    }

    // The refusal path's positive control: whatever an absurd size returns,
    // a FRESH build must still work afterwards — the fallback the caller
    // depends on when update_size says no.
    let refused = !enc.update_size(16384, 16384);
    println!("update_size(16384x16384) refused = {refused}");
    drop(enc);
    let mut fresh =
        H264Encoder::new(1280, 720, 30, 3_000_000).expect("a fresh build after refusal must work");
    let (f3, s3) = synth(1280, 720, 33);
    let mut ok_any = false;
    for i in 0..30 {
        match fresh.encode_bgra(&f3, s3, i == 0) {
            Ok(_) => {
                ok_any = true;
                break;
            }
            Err(EncodeError::NeedMoreInput) => {}
            Err(e) => panic!("fresh encode failed: {e}"),
        }
    }
    assert!(ok_any, "the rebuild path must still work after a refusal");
}
