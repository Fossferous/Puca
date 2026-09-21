//! Capture and encode the clip replay buffer's video, OUT OF PROCESS.
//!
//! WHY THIS IS NOT IN THE APP. Windows lets a user pin an application to a
//! particular GPU (Settings -> Display -> Graphics, stored per EXECUTABLE PATH
//! in `HKCU\Software\Microsoft\DirectX\UserGpuPreferences`). The owner of the
//! machine this was written for pins `Puca.exe` to the integrated GPU on
//! purpose and is keeping it: with a game using 100% of the discrete card,
//! moving the app off it is what stopped their stream looking choppy to
//! viewers. "Unpin it" is not an answer.
//!
//! Inside a pinned process, DXGI does not merely reorder the adapters — it
//! re-points the whole output view at the preferred GPU. Measured 2026-09-10 on
//! that machine, from the app's own error: every one of the three monitors was
//! exposed by `AMD Radeon(TM) Graphics` and by nothing else, while the four
//! entries for the discrete card exposed no matching output at all. Desktop
//! duplication only works on the GPU actually driving the display, so every
//! monitor refused with `DXGI_ERROR_UNSUPPORTED` (0x887A0004) and there was no
//! other adapter to fall back to.
//!
//! An earlier fix walked every adapter looking for one that could duplicate.
//! That was the right idea for a hybrid laptop and useless here, because in a
//! pinned process the adapter it needs is not offering the monitor.
//!
//! The preference is keyed by executable PATH, so a different binary gets its
//! own (absent, therefore default) preference. Measured minutes before this was
//! written: an unpinned probe on the same machine enumerated the discrete card
//! with all three outputs and duplicated every one of them. So capture runs
//! here, in the agent, and the app keeps its pin.
//!
//! WHAT CROSSES THE PROCESS BOUNDARY IS ALREADY ENCODED. The frames never
//! leave: this writes H.264 access units, a few kilobytes each, so no shared
//! memory is needed for what would otherwise be ~200 MB/s of raw BGRA.
//!
//! If it turns out a child process DOES inherit its parent's pin, this fails in
//! exactly the same way and says so in the same words — the error names every
//! adapter it saw — which is the answer either way.

use puca_clip_wire::{Header, MAGIC};
use std::io::Write;

/// Everything the parent must decide, because the parent is the one that knows
/// the member's preset and which screen it promised them.
pub struct ClipHostArgs {
    /// Win32 `HMONITOR` of the screen to capture. NOT a capture index: indices
    /// come from a DXGI walk, and this process's walk is not the parent's —
    /// that is the entire point of running out here. `HMONITOR` is stable
    /// across processes in a session, so it is the only handle both ends agree
    /// on. Same reasoning as the monitor-index trap in `puca-capture`.
    pub hmonitor: isize,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub bitrate: u32,
    pub gop_ms: u32,
}

/// Parse the `--clip-capture` invocation. Returns None when this is not one.
pub fn args_from(argv: &[String]) -> Option<ClipHostArgs> {
    if !argv.iter().any(|a| a == "--clip-capture") {
        return None;
    }
    let get = |name: &str| -> Option<String> {
        argv.iter().position(|a| a == name).and_then(|i| argv.get(i + 1).cloned())
    };
    Some(ClipHostArgs {
        hmonitor: get("--hmonitor")?.parse().ok()?,
        width: get("--width")?.parse().ok()?,
        height: get("--height")?.parse().ok()?,
        fps: get("--fps")?.parse().ok()?,
        bitrate: get("--bitrate")?.parse().ok()?,
        gop_ms: get("--gop-ms")?.parse().ok()?,
    })
}

/// Run until stdout closes (the parent went away) or capture fails for good.
///
/// The return value is the process exit code. Diagnostics go to stderr, which
/// the parent reads and puts in front of the member — so they must say what
/// happened in words someone can act on, not just a HRESULT.
#[cfg(windows)]
pub fn run(args: ClipHostArgs) -> i32 {
    use puca_capture::{CaptureError, ScreenCapture};
    use puca_encode::{EncodeError, H264Encoder};

    // The parent gave us an HMONITOR; find what index THIS process's DXGI walk
    // calls it. They can differ, and a wrong index is a clip of the wrong
    // screen rather than an error.
    let index = match puca_capture::outputs().into_iter().find(|o| o.hmonitor == args.hmonitor) {
        Some(o) => o.index,
        None => {
            let seen: Vec<String> = puca_capture::outputs()
                .iter()
                .map(|o| format!("{}x{} ({:#x})", o.width, o.height, o.hmonitor))
                .collect();
            eprintln!(
                "clip-host: the requested monitor is not in this process's output list \
                 (it has {}: {}). The screen was probably unplugged or put to sleep \
                 between the app choosing it and this starting.",
                seen.len(),
                seen.join(", ")
            );
            return 2;
        }
    };

    let mut capture = match ScreenCapture::new(index) {
        Ok(c) => c,
        Err(e) => {
            // This message is the one that reaches the member. It already
            // names every adapter tried and why each refused.
            eprintln!("clip-host: could not start capturing that screen: {e}");
            return 3;
        }
    };
    let mut encoder = match H264Encoder::new(args.width, args.height, args.fps, args.bitrate) {
        Ok(e) => e,
        Err(e) => {
            eprintln!("clip-host: could not start the video encoder: {e}");
            return 4;
        }
    };
    // Frames here are stored, not watched live: no need to spin for each one.
    encoder.set_patient_output(true);

    let stdout = std::io::stdout();
    let mut out = std::io::BufWriter::new(stdout.lock());
    if out.write_all(MAGIC).is_err() || out.flush().is_err() {
        return 5; // the parent is already gone
    }

    let start = std::time::Instant::now();
    let gop_us = args.gop_ms as u128 * 1000;
    let mut last_key_us: i128 = -(gop_us as i128); // a keyframe on the very first frame
    // Only for the wait before the FIRST frame. After that the pacer decides
    // when to look and for how long.
    let first_frame_timeout_ms = ((1000 / args.fps.max(1)) as u32).max(15);
    let dur_us = (1_000_000u64 / args.fps.max(1) as u64).max(1);
    // THE CAP. `--fps` used to set only how long an acquire would wait, and
    // an acquire returns on every present: a 165 Hz screen playing a video
    // was encoded at ~78 fps and ~21 Mbit/s when 30 and 8 were asked for.
    // See puca-clip-wire's pacer.rs for the measurement and the design.
    let mut pacer = puca_clip_wire::FramePacer::new(args.fps);
    // The frame is STORED and re-encoded on a timeout rather than cloned: on a
    // static desktop DXGI produces nothing, and the ring buffer only closes a
    // GOP on a video keyframe, so silence would let audio grow it unbounded.
    let mut last_frame: Option<puca_capture::Frame> = None;
    // Names the pixels in last_frame for the encoder: bumped for every new
    // picture, unchanged when the stored one is re-sent, so a still screen's
    // repeats skip the colour conversion (encode_bgra_picture).
    let mut picture: u64 = 0;
    let mut access_lost_streak: u32 = 0;

    loop {
        // Wait for the slot BEFORE acquiring. Presents that land meanwhile are
        // folded into the next acquire by DXGI, so this loop spends nothing on
        // them: no readback, no conversion, no encode. The newest picture wins.
        let wait = pacer.wait(std::time::Instant::now());
        if !wait.is_zero() {
            std::thread::sleep(wait);
        }
        let slot_at = std::time::Instant::now();
        let had_frame = last_frame.is_some();
        let acquired = if had_frame {
            // Returns at once if a present is pending; otherwise waits for one
            // for about the first half of the slot (pacer.rs: a plain poll
            // stutters when the frame rate matches the content's). The OS may
            // round that wait up to its ~15.6 ms timer tick; the grid absorbs
            // it, because the slot is spent as of when it opened.
            pacer.acquire_within(
                slot_at,
                |ms| capture.next_frame(ms),
                |e| matches!(e, CaptureError::Timeout),
            )
        } else {
            capture.next_frame(first_frame_timeout_ms)
        };
        match acquired {
            Ok(f) => {
                access_lost_streak = 0;
                // The previous picture's buffer carries the next readback.
                if let Some(old) = last_frame.replace(f) {
                    capture.recycle(old);
                }
                picture += 1;
            }
            Err(CaptureError::Timeout) => {
                if last_frame.is_none() {
                    continue; // nothing captured yet at all
                }
                // No new picture within this slot's window (or only the
                // pointer moved): re-encode the stored frame, once per slot.
            }
            Err(CaptureError::AccessLost) => {
                // A locked screen or a sleeping panel returns this on every
                // tick for as long as it lasts, so back off rather than
                // pegging a core. Capped at a second.
                access_lost_streak = access_lost_streak.saturating_add(1);
                std::thread::sleep(std::time::Duration::from_millis(
                    (access_lost_streak.min(20) * 50) as u64,
                ));
                continue;
            }
            Err(CaptureError::Failed(e)) => {
                eprintln!("clip-host: capture failed: {e}");
                return 6;
            }
        }
        let frame = last_frame.as_ref().expect("guarded above");
        // Spend the slot on the SUBMISSION, whatever the encoder answers (an
        // async encoder can take the frame and still say "need more input"),
        // and as of the instant it OPENED, so a slow readback does not restart
        // the grid from its own end. Not for the very first frame: that
        // acquire blocked, so the second frame would follow it at once.
        pacer.take(if had_frame { slot_at } else { std::time::Instant::now() });

        let ts_us = start.elapsed().as_micros();
        let force_key = ts_us as i128 - last_key_us >= gop_us as i128;
        if force_key {
            // Pace on the REQUEST, not the delivery: the async MFT emits the
            // keyframe a frame or two after the submission that asked for it,
            // so waiting for the IDR before resetting the clock fires a second
            // force inside that window.
            last_key_us = ts_us as i128;
        }

        let encoded = match encoder.encode_bgra_picture(&frame.bgra, frame.stride, force_key, picture) {
            Ok(f) => f,
            Err(EncodeError::NeedMoreInput) => continue, // buffering; nothing to emit
            Err(e) => {
                eprintln!("clip-host: encode failed: {e}");
                return 7;
            }
        };

        let header = Header {
            keyframe: encoded.keyframe,
            ts_us: ts_us as u64,
            dur_us,
            len: encoded.data.len() as u32,
        };
        // A write that fails means the parent closed the pipe: it disarmed, or
        // it died. Either way this process has no reason to keep capturing,
        // and exiting is what stops an orphan holding a duplication open.
        if out.write_all(&header.to_bytes()).is_err()
            || out.write_all(&encoded.data).is_err()
            || out.flush().is_err()
        {
            return 0;
        }
    }
}

#[cfg(not(windows))]
pub fn run(_args: ClipHostArgs) -> i32 {
    eprintln!("clip-host: screen capture for clips is implemented on Windows only");
    8
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn an_ordinary_agent_launch_is_not_a_clip_host() {
        // POSITIVE CONTROL for the parse below: the agent's normal invocation
        // must fall straight through, or adding this mode would break every
        // remote-control session on the machine.
        assert!(args_from(&argv(&["--token", "abc"])).is_none());
    }

    #[test]
    fn a_full_invocation_parses() {
        let a = args_from(&argv(&[
            "--clip-capture",
            "--hmonitor",
            "65539",
            "--width",
            "2560",
            "--height",
            "1440",
            "--fps",
            "60",
            "--bitrate",
            "12000000",
            "--gop-ms",
            "2000",
        ]))
        .expect("should parse");
        assert_eq!(a.hmonitor, 65539);
        assert_eq!(a.width, 2560);
        assert_eq!(a.height, 1440);
        assert_eq!(a.fps, 60);
        assert_eq!(a.bitrate, 12_000_000);
        assert_eq!(a.gop_ms, 2000);
    }

    #[test]
    fn a_missing_argument_is_refused_rather_than_defaulted() {
        // Defaulting any of these would capture the wrong screen, or encode at
        // a cadence nobody asked for, and both look like a product bug rather
        // than a malformed launch.
        assert!(args_from(&argv(&["--clip-capture", "--hmonitor", "1"])).is_none());
    }

    #[test]
    fn a_negative_hmonitor_is_accepted_because_windows_hands_those_out() {
        // HMONITOR is a pointer-shaped handle; on a 64-bit machine its isize
        // form is routinely negative. Parsing it as unsigned would refuse a
        // perfectly ordinary monitor.
        let a = args_from(&argv(&[
            "--clip-capture", "--hmonitor", "-1234567", "--width", "1", "--height", "1",
            "--fps", "1", "--bitrate", "1", "--gop-ms", "1",
        ]))
        .expect("should parse");
        assert_eq!(a.hmonitor, -1234567);
    }
}
