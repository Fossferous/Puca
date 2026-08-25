//! Native video capture for Clips auto-arm — no `getDisplayMedia`, no OS
//! picker.
//!
//! `getDisplayMedia` cannot be made picker-free from JS: Chromium always draws
//! the source-selection dialog, and even requesting it programmatically first
//! requires transient user activation (`puca-capture`'s own header: "a
//! webview host cannot begin a capture ... however the picker is configured").
//! That is exactly why the native remote-desktop agent exists at all. This
//! module reuses the SAME two proven crates the agent uses for unattended
//! capture — `puca-capture` (DXGI Desktop Duplication) and
//! `puca-encode` (the MFT hardware H.264 encoder) — wired to a LOCAL
//! sink (Tauri events into this webview) instead of a WebRTC peer. Nothing
//! here needs a gesture, a picker, or a window.
//!
//! Threading/state pattern deliberately mirrors `audio_capture.rs`'s
//! `start_capture`: an `AtomicBool` pair claims the single capture slot via
//! compare-exchange, a dedicated `std::thread` runs the blocking loop, and a
//! one-shot channel reports init success/failure back to the async command
//! synchronously so a broken capture never LOOKS armed.
//!
//! The bitstream format: `puca-encode`'s `H264Encoder` emits Annex-B
//! (start-code delimited). We do NOT convert it — mediabunny (the muxer used
//! by `replayWorker.ts`) auto-detects Annex-B input and derives the
//! AVCDecoderConfigurationRecord itself from the SPS/PPS in the first
//! keyframe, exactly the same way `EncodedVideoPacketSource` already handles
//! a WebCodecs `avc:{format:'annexb'}` stream. We DO extract profile/level
//! from the real SPS ourselves (`sps_codec_string`) so the codec string
//! reported to JS — used for `MediaSource.isTypeSupported` when previewing —
//! describes the bitstream that is actually there, not a guess.
//!
//! What this module deliberately does NOT do: scale captured frames. The
//! encoder is configured at the CAPTURED MONITOR'S NATIVE RESOLUTION — the
//! `Quality` preset's max-width/height only applies to the browser-based
//! path. A future revision can add a downscale pass if 4K displays prove too
//! heavy; for v1, correctness over an untested resize routine.

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

use puca_capture::{outputs as capture_outputs, CaptureError, OutputInfo, ScreenCapture};
use puca_encode::{EncodeError, H264Encoder};

pub struct ClipCaptureState {
    pub is_capturing: AtomicBool,
    pub stop_signal: AtomicBool,
}

impl Default for ClipCaptureState {
    fn default() -> Self {
        Self {
            is_capturing: AtomicBool::new(false),
            stop_signal: AtomicBool::new(false),
        }
    }
}

// ---- target selection -------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl Rect {
    fn width(&self) -> i32 {
        self.right - self.left
    }
    fn height(&self) -> i32 {
        self.bottom - self.top
    }
    fn area(&self) -> i64 {
        (self.width().max(0) as i64) * (self.height().max(0) as i64)
    }
    /// Intersection area with `other`, 0 if disjoint.
    fn intersection_area(&self, other: &Rect) -> i64 {
        let l = self.left.max(other.left);
        let t = self.top.max(other.top);
        let r = self.right.min(other.right);
        let b = self.bottom.min(other.bottom);
        if r <= l || b <= t {
            0
        } else {
            (r - l) as i64 * (b - t) as i64
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct MonitorCandidate {
    pub hmonitor: isize,
    pub rect: Rect,
    pub primary: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TargetReason {
    Fullscreen,
    Primary,
    /// No monitor is flagged primary in the list (should not happen on a real
    /// desktop) — falls back to the first entry rather than panicking.
    FirstAvailable,
}

/// The foreground window's rect, plus whether it still has window CHROME
/// (a title bar and/or a resize border). A maximized ordinary window keeps
/// both — and Windows extends its rect slightly PAST the monitor edge to
/// cover the invisible resize border, so it can score >=100% coverage on
/// the area test alone. Real fullscreen (exclusive or borderless) removes
/// both, which is what actually distinguishes "this app IS the screen" from
/// "this app is merely maximized" — a banking site maximized on a second
/// monitor must never read as fullscreen.
#[derive(Debug, Clone, Copy)]
pub struct ForegroundWindow {
    pub rect: Rect,
    pub has_chrome: bool,
}

/// Pure decision: which monitor to capture with no user interaction.
///
/// Rule: the foreground window must be CHROMELESS (no caption, no resize
/// border — excludes an ordinary maximized window) AND cover at least 95%
/// of a monitor's area (a tolerance for the 1-2 px a borderless-fullscreen
/// window is sometimes off by, and for a monitor's DPI-rounded edge).
/// Otherwise capture whichever monitor is flagged primary.
///
/// No Win32 calls — everything the decision needs is passed in, so this is
/// exercised by ordinary `cargo test` with fabricated tables instead of
/// needing a live foreground window and a live monitor layout.
pub fn choose_target(
    foreground: Option<ForegroundWindow>,
    monitors: &[MonitorCandidate],
) -> Option<(MonitorCandidate, TargetReason)> {
    if monitors.is_empty() {
        return None;
    }
    if let Some(fg) = foreground {
        if fg.rect.area() > 0 && !fg.has_chrome {
            // The monitor the window overlaps MOST, then check that overlap
            // against THAT monitor's own area — a window can span two
            // monitors (multi-monitor spanning) without filling either.
            let best = monitors
                .iter()
                .max_by_key(|m| fg.rect.intersection_area(&m.rect));
            if let Some(m) = best {
                let overlap = fg.rect.intersection_area(&m.rect);
                if m.rect.area() > 0 && overlap * 100 >= m.rect.area() * 95 {
                    return Some((*m, TargetReason::Fullscreen));
                }
            }
        }
    }
    if let Some(m) = monitors.iter().find(|m| m.primary) {
        return Some((*m, TargetReason::Primary));
    }
    monitors.first().map(|m| (*m, TargetReason::FirstAvailable))
}

#[derive(Debug, Clone, Serialize)]
pub struct ClipCaptureTarget {
    /// Index into `puca_capture::outputs()` — what `ScreenCapture::new` takes.
    pub output_index: usize,
    pub width: u32,
    pub height: u32,
    pub reason: &'static str,
    /// The bitrate the encoder was ACTUALLY configured with — the caller's
    /// requested bitrate scaled to this monitor's real pixel count (see
    /// `scale_bitrate`). 0 from `pick_target`, which starts no encoder.
    pub bitrate: u32,
}

/// Real Win32 lookup, feeding the pure `choose_target` above. Windows-only —
/// off-Windows this whole feature is unreachable (Clips is desktop/Tauri
/// only, and only ships on Windows today), so a non-Windows build just
/// refuses rather than growing a second, untestable code path.
#[cfg(windows)]
fn foreground_window() -> Option<ForegroundWindow> {
    use windows::Win32::Foundation::RECT;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetShellWindow, GetWindowLongW, GetWindowRect, IsIconic,
        IsWindowVisible, GWL_STYLE, WS_CAPTION, WS_THICKFRAME,
    };
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_invalid() {
            return None;
        }
        // The desktop/shell "window" is always foreground when nothing else
        // has focus (e.g. everything minimized) — that is "no app", not "the
        // shell is fullscreen".
        if hwnd == GetShellWindow() {
            return None;
        }
        if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
            return None;
        }
        let mut rect = RECT::default();
        if GetWindowRect(hwnd, &mut rect).is_err() {
            return None;
        }
        let style = GetWindowLongW(hwnd, GWL_STYLE) as u32;
        let has_chrome = (style & (WS_CAPTION.0 | WS_THICKFRAME.0)) != 0;
        Some(ForegroundWindow {
            rect: Rect { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
            has_chrome,
        })
    }
}

#[cfg(windows)]
fn monitor_candidates() -> Vec<(MonitorCandidate, usize)> {
    // Join puca_input's GDI list (has `primary`) to puca_capture's
    // DXGI list (has the capture INDEX) by hmonitor — the two enumerations
    // are in unrelated orders (documented on `OutputInfo`), so anything else
    // captures the wrong screen.
    let gdi = puca_input::list_monitors();
    let dxgi = capture_outputs();
    gdi.monitors
        .iter()
        .filter_map(|g| {
            let d: &OutputInfo = dxgi.iter().find(|d| d.hmonitor == g.hmonitor)?;
            Some((
                MonitorCandidate {
                    hmonitor: g.hmonitor,
                    rect: Rect { left: d.left, top: d.top, right: d.left + d.width, bottom: d.top + d.height },
                    primary: g.primary,
                },
                d.index,
            ))
        })
        .collect()
}

#[cfg(windows)]
pub fn pick_target() -> Result<ClipCaptureTarget, String> {
    let candidates = monitor_candidates();
    if candidates.is_empty() {
        return Err("no capturable monitor found".into());
    }
    let monitors: Vec<MonitorCandidate> = candidates.iter().map(|(m, _)| *m).collect();
    let fg = foreground_window();
    let (chosen, reason) =
        choose_target(fg, &monitors).ok_or_else(|| "no capturable monitor found".to_string())?;
    let (_, output_index) = candidates
        .iter()
        .find(|(m, _)| m.hmonitor == chosen.hmonitor)
        .ok_or_else(|| "monitor disappeared while picking a target".to_string())?;
    Ok(ClipCaptureTarget {
        output_index: *output_index,
        width: chosen.rect.width().max(0) as u32,
        height: chosen.rect.height().max(0) as u32,
        reason: match reason {
            TargetReason::Fullscreen => "fullscreen",
            TargetReason::Primary => "primary",
            TargetReason::FirstAvailable => "primary", // same UI copy — "no primary flag" is not user-meaningful
        },
        bitrate: 0,
    })
}

/// The quality preset's bitrate is tuned for the preset's ASSUMED resolution;
/// native capture runs at the monitor's real one (never scaled). Scale by the
/// pixel ratio, clamped so a tiny monitor is not over-bitrated and a 4K one
/// not starved. Pure, so the clamp arithmetic is unit-testable.
pub fn scale_bitrate(requested: u32, assumed_pixels: u64, actual_pixels: u64) -> u32 {
    if assumed_pixels == 0 {
        // A degenerate assumption must not silently pick the MOST expensive
        // setting — fall back to what the caller asked for, clamped.
        return (requested as u64).clamp(1_500_000, 20_000_000) as u32;
    }
    let scaled = (requested as u64).saturating_mul(actual_pixels) / assumed_pixels;
    scaled.clamp(1_500_000, 20_000_000) as u32
}

// ---- SPS-derived codec string -----------------------------------------------

/// Locate NAL unit payloads in an Annex-B access unit: `(nal_type, payload_without_header)`.
///
/// Tracks the START of each start code (not just where its payload begins),
/// so a NAL's END is simply the next NAL's start-code position — no
/// backing-off-over-zero-bytes heuristic, which mishandles a start code
/// whose last byte (`0x01`) is not itself `0x00` and so is never stripped.
fn annexb_nals(data: &[u8]) -> Vec<(u8, &[u8])> {
    let mut marks = Vec::new(); // (code_start, payload_start)
    let mut i = 0usize;
    while i + 3 <= data.len() {
        if i + 4 <= data.len() && data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 0 && data[i + 3] == 1 {
            marks.push((i, i + 4));
            i += 4;
        } else if data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 {
            marks.push((i, i + 3));
            i += 3;
        } else {
            i += 1;
        }
    }
    let mut out = Vec::with_capacity(marks.len());
    for (k, &(_, payload_start)) in marks.iter().enumerate() {
        if payload_start >= data.len() {
            continue;
        }
        let end = marks.get(k + 1).map(|&(code_start, _)| code_start).unwrap_or(data.len());
        if end <= payload_start {
            continue;
        }
        let nal_type = data[payload_start] & 0x1f;
        out.push((nal_type, &data[payload_start + 1..end]));
    }
    out
}

/// `avc1.PPCCLL` (profile_idc, constraint flags, level_idc — the three bytes
/// that follow the NAL header in an SPS) built from the REAL SPS in `data`,
/// rather than assumed from the profile we asked the encoder for — the
/// negotiated profile can differ (`H264Encoder::new_with_profile` falls back
/// to Baseline when an MFT refuses the requested one), and `MediaSource`
/// preview must describe the bitstream that is actually there.
pub fn sps_codec_string(data: &[u8]) -> Option<String> {
    let (_, sps) = annexb_nals(data).into_iter().find(|(t, _)| *t == 7)?;
    if sps.len() < 3 {
        return None;
    }
    Some(format!("avc1.{:02X}{:02X}{:02X}", sps[0], sps[1], sps[2]))
}

/// The raw SPS (type 7) and PPS (type 8) NAL payloads present in `data`, if any.
fn find_sps_pps(data: &[u8]) -> (Option<Vec<u8>>, Option<Vec<u8>>) {
    let mut sps = None;
    let mut pps = None;
    for (t, payload) in annexb_nals(data) {
        if t == 7 && sps.is_none() {
            sps = Some(payload.to_vec());
        } else if t == 8 && pps.is_none() {
            pps = Some(payload.to_vec());
        }
    }
    (sps, pps)
}

/// mediabunny (the muxer) derives the AVCDecoderConfigurationRecord from the
/// SPS/PPS on the FIRST packet it is given per re-mux (clip_capture.rs's
/// module header, and replayWorker.ts's re-seal on every `seal()`/`trim()`);
/// it throws if that packet has neither. A Windows H.264 MFT is not
/// guaranteed to repeat the sequence header before every IDR (some only send
/// it once, at stream start) — `selectWindow` in the ring can pick ANY
/// keyframe as a seal's priming packet, so a keyframe missing SPS/PPS would
/// silently break every later seal with an opaque mediabunny error. This
/// caches the first SPS/PPS seen and PREPENDS them (as fresh Annex-B NALs) to
/// any later keyframe that is missing either, so every keyframe the JS side
/// ever primes a re-mux with is guaranteed self-describing.
#[derive(Default)]
pub struct ParamSetCache {
    sps: Option<Vec<u8>>,
    pps: Option<Vec<u8>>,
}

impl ParamSetCache {
    /// Learn from `data` (a keyframe's Annex-B bytes) and return `data`,
    /// prepending the CACHED sps/pps if this keyframe doesn't carry its own.
    /// Only ever called on keyframes — delta frames need no parameter sets.
    pub fn prime_keyframe(&mut self, data: Vec<u8>) -> Vec<u8> {
        let (sps, pps) = find_sps_pps(&data);
        let this_has_both = sps.is_some() && pps.is_some();
        if let Some(s) = sps { self.sps = Some(s); }
        if let Some(p) = pps { self.pps = Some(p); }
        if this_has_both {
            return data;
        }
        let (Some(sps), Some(pps)) = (&self.sps, &self.pps) else { return data };
        let mut out = Vec::with_capacity(data.len() + sps.len() + pps.len() + 16);
        out.extend_from_slice(&[0, 0, 0, 1, 0x67]);
        out.extend_from_slice(sps);
        out.extend_from_slice(&[0, 0, 0, 1, 0x68]);
        out.extend_from_slice(pps);
        out.extend_from_slice(&data);
        out
    }
}

// ---- capture + encode loop ---------------------------------------------------

#[derive(Serialize, Clone)]
struct ClipVideoChunkEvent {
    /// Base64 Annex-B bitstream (same wire convention as `audio-data`).
    data: String,
    keyframe: bool,
    /// Capture-relative microseconds — the FIRST chunk of a session is 0.
    ts_us: u64,
    dur_us: u64,
    /// The SPS-derived `avc1.PPCCLL` string, present on EVERY keyframe
    /// (`null` on deltas). The JS worker consumes the first one it sees;
    /// carrying it on every keyframe makes early-chunk loss self-healing
    /// (see the note at the compute site).
    codec: Option<String>,
    width: u32,
    height: u32,
}

#[cfg(windows)]
pub fn start_video_capture(
    app: AppHandle,
    state: Arc<ClipCaptureState>,
    fps: u32,
    bitrate: u32,
    // Pixel count the caller's `bitrate` was tuned for (the preset's
    // max_width * max_height) — the encoder gets `scale_bitrate` of it.
    assumed_pixels: u64,
    gop_ms: u32,
) -> Result<ClipCaptureTarget, String> {
    let mut target = pick_target()?;
    target.bitrate = scale_bitrate(bitrate, assumed_pixels, target.width as u64 * target.height as u64);

    let mut waited_ms = 0u32;
    loop {
        match state.is_capturing.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst) {
            Ok(_) => break,
            Err(_) => {
                if !state.stop_signal.load(Ordering::SeqCst) {
                    return Err("Already capturing video".to_string());
                }
                if waited_ms >= 1000 {
                    return Err("Previous video capture is still shutting down".to_string());
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
                waited_ms += 10;
            }
        }
    }
    state.stop_signal.store(false, Ordering::SeqCst);

    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();
    let state_clone = state.clone();
    let emit_handle = app.clone();
    let t = target.clone();
    std::thread::spawn(move || {
        let result = video_capture_loop(app, state_clone.clone(), t, fps, gop_ms, ready_tx);
        state_clone.is_capturing.store(false, Ordering::SeqCst);
        if let Err(e) = result {
            log::error!("Clip video capture error: {}", e);
            let _ = emit_handle.emit("clip-video-capture-error", e);
        }
    });

    match ready_rx.recv_timeout(std::time::Duration::from_secs(5)) {
        Ok(Ok(())) => Ok(target),
        Ok(Err(e)) => Err(e),
        Err(_) => {
            // Init was merely SLOW, not failed — the thread is very likely
            // still running (or about to start). Signal it to stop rather
            // than leaving a live, invisible DXGI+encoder loop behind a
            // caller who just saw an error and moved on.
            state.stop_signal.store(true, Ordering::SeqCst);
            Err("Video capture initialisation timed out".to_string())
        }
    }
}

#[cfg(windows)]
pub fn stop_video_capture(state: Arc<ClipCaptureState>) {
    state.stop_signal.store(true, Ordering::SeqCst);
}

#[cfg(windows)]
fn video_capture_loop(
    app: AppHandle,
    state: Arc<ClipCaptureState>,
    target: ClipCaptureTarget,
    fps: u32,
    gop_ms: u32,
    ready: std::sync::mpsc::Sender<Result<(), String>>,
) -> Result<(), String> {
    macro_rules! init_step {
        ($e:expr) => {
            match $e {
                Ok(v) => v,
                Err(msg) => {
                    let _ = ready.send(Err(msg.clone()));
                    return Err(msg);
                }
            }
        };
    }

    let mut capture = init_step!(ScreenCapture::new(target.output_index)
        .map_err(|e| format!("Failed to start screen capture: {e}")));
    let mut encoder = init_step!(H264Encoder::new(target.width, target.height, fps, target.bitrate)
        .map_err(|e| format!("Failed to start the video encoder: {e}")));

    let _ = ready.send(Ok(()));
    log::info!(
        "Clip video capture started: output {} ({}x{} @ {} fps, {} kbps)",
        target.output_index, target.width, target.height, fps, target.bitrate / 1000
    );

    let start = std::time::Instant::now();
    let gop_us = gop_ms as u128 * 1000;
    let mut last_key_us: i128 = -(gop_us as i128); // force a keyframe on the very first frame
    let mut params = ParamSetCache::default();
    let mut consecutive_sps_failures = 0u32;
    // On a static desktop, DXGI legitimately produces nothing to capture —
    // `next_frame`'s own contract (puca-capture's header) is that the
    // caller repeats the PREVIOUS frame rather than treating that as "no
    // output": the ring only closes/evicts GOPs on a video keyframe
    // (replayWorker.ts), so silence here would let audio grow the open GOP
    // unbounded for as long as the screen doesn't change. Re-submit at most
    // once per frame period so a long static stretch costs one cheap
    // re-encode per tick, not a frame-rate encode of nothing.
    let mut last_frame: Option<puca_capture::Frame> = None;
    let mut last_emit_at = std::time::Instant::now();
    let frame_timeout_ms = ((1000 / fps.max(1)) as u32).max(15);
    let frame_period = std::time::Duration::from_millis(frame_timeout_ms as u64);
    // AccessLost can be continuous (a sleeping/disconnected display) — the
    // crate rebuilds duplication on every call with no wait of its own, so
    // without a backoff this would peg a core for as long as the condition
    // lasts.
    let mut access_lost_streak: u32 = 0;

    while !state.stop_signal.load(Ordering::SeqCst) {
        // The frame is STORED (moved, not cloned) and encoded by reference —
        // a per-frame clone of a 4K BGRA buffer is a ~33 MB memcpy at up to
        // 60 Hz, pure waste. The Timeout branch then re-encodes the same
        // stored frame, which is the whole reason it is kept.
        match capture.next_frame(frame_timeout_ms) {
            Ok(f) => { access_lost_streak = 0; last_frame = Some(f); }
            Err(CaptureError::Timeout) => {
                if last_emit_at.elapsed() < frame_period || last_frame.is_none() {
                    continue; // paced, or nothing captured yet at all
                }
                // fall through and re-encode the stored frame
            }
            Err(CaptureError::AccessLost) => {
                access_lost_streak += 1;
                std::thread::sleep(std::time::Duration::from_millis((access_lost_streak.min(20) * 50) as u64));
                continue;
            }
            Err(CaptureError::Failed(e)) => return Err(format!("capture failed: {e}")),
        }
        let frame = last_frame.as_ref().expect("guarded above");
        let ts_us = start.elapsed().as_micros();
        let force_key = ts_us as i128 - last_key_us >= gop_us as i128;
        if force_key {
            // Pace on the REQUEST, not the delivery: the async MFT emits the
            // keyframe one or two frames after the submission that asked for
            // it, so waiting for `encoded.keyframe` before resetting the clock
            // fired a second force in that window — measured as IDR pairs
            // ~14 ms apart, every GOP (live_encode's forced_keyframes test).
            // A request the encoder could not take is carried by its own
            // `owed_keyframe` until an IDR really appears, so this cannot
            // starve keys.
            last_key_us = ts_us as i128;
        }

        let encoded = match encoder.encode_bgra(&frame.bgra, frame.stride, force_key) {
            Ok(f) => f,
            Err(EncodeError::NeedMoreInput) => continue, // encoder is buffering — nothing to emit yet
            Err(e) => return Err(format!("encode failed: {e}")),
        };
        let mut data = encoded.data;
        if encoded.keyframe {
            data = params.prime_keyframe(data);
        }

        // The codec string rides on EVERY keyframe, not just the first one:
        // the JS side only consumes the first it SEES, but chunks emitted
        // before the worker's ring exists are dropped on the floor (the arm
        // message races WASAPI audio init on the main thread), and a latched
        // one-shot here turned that ordinary race into a permanently
        // codec-less — hence permanently un-seal-able — session. At one
        // keyframe per GOP (~0.5 Hz) the re-scan is nothing.
        let codec = if encoded.keyframe {
            match sps_codec_string(&data) {
                Some(c) => { consecutive_sps_failures = 0; Some(c) }
                None => {
                    // Even with the cache primed this keyframe has no SPS at
                    // all (only possible before ANY keyframe has ever carried
                    // one) — report failure rather than silently running
                    // forever with the JS side stuck at 'arming'.
                    consecutive_sps_failures += 1;
                    // "fails after 5 keyframes" — docs/CLIPS.md holds this number.
                    if consecutive_sps_failures >= 5 {
                        return Err("the encoder never produced a usable H.264 sequence header".to_string());
                    }
                    None
                }
            }
        } else {
            None
        };

        let dur_us = (1_000_000u64 / fps.max(1) as u64).max(1);
        let event = ClipVideoChunkEvent {
            data: base64_encode(&data),
            keyframe: encoded.keyframe,
            ts_us: ts_us as u64,
            dur_us,
            codec,
            width: target.width,
            height: target.height,
        };
        if app.emit("clip-video-chunk", event).is_err() {
            break; // the window is gone — nothing left to stream to
        }
        last_emit_at = std::time::Instant::now();
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn start_video_capture(
    _app: AppHandle,
    _state: Arc<ClipCaptureState>,
    _fps: u32,
    _bitrate: u32,
    _assumed_pixels: u64,
    _gop_ms: u32,
) -> Result<ClipCaptureTarget, String> {
    Err("native clip capture is only supported on Windows".into())
}

#[cfg(not(windows))]
pub fn stop_video_capture(_state: Arc<ClipCaptureState>) {}

/// No base64 crate pulled in just for this — the app already depends on one
/// for `audio_capture.rs`; reuse it so there is exactly one implementation.
fn base64_encode(data: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(data)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(left: i32, top: i32, w: i32, h: i32) -> Rect {
        Rect { left, top, right: left + w, bottom: top + h }
    }
    fn m(hmonitor: isize, rect: Rect, primary: bool) -> MonitorCandidate {
        MonitorCandidate { hmonitor, rect, primary }
    }
    /// A chromeless (real fullscreen — exclusive or borderless) foreground window.
    fn fg(rect: Rect) -> Option<ForegroundWindow> {
        Some(ForegroundWindow { rect, has_chrome: false })
    }
    /// An ORDINARY window at `rect` — has a caption/resize border, so it can
    /// never read as fullscreen no matter how much area it covers.
    fn fg_chrome(rect: Rect) -> Option<ForegroundWindow> {
        Some(ForegroundWindow { rect, has_chrome: true })
    }

    #[test]
    fn exclusive_fullscreen_on_the_primary_is_picked_as_fullscreen() {
        let mons = [m(1, r(0, 0, 1920, 1080), true)];
        let (chosen, reason) = choose_target(fg(r(0, 0, 1920, 1080)), &mons).unwrap();
        assert_eq!(chosen.hmonitor, 1);
        assert_eq!(reason, TargetReason::Fullscreen);
    }

    #[test]
    fn borderless_fullscreen_off_by_a_couple_of_pixels_still_counts() {
        // A borderless window that is 1px short on each edge — common with
        // DPI rounding — must still read as "fullscreen", not "primary".
        let mons = [m(1, r(0, 0, 1920, 1080), true)];
        let (chosen, reason) = choose_target(fg(r(1, 1, 1918, 1078)), &mons).unwrap();
        assert_eq!(chosen.hmonitor, 1);
        assert_eq!(reason, TargetReason::Fullscreen);
    }

    #[test]
    fn a_normal_windowed_app_is_not_treated_as_fullscreen() {
        let mons = [m(1, r(0, 0, 1920, 1080), true)];
        let (_, reason) = choose_target(fg(r(100, 100, 900, 700)), &mons).unwrap();
        assert_eq!(reason, TargetReason::Primary);
    }

    #[test]
    fn a_maximized_window_covering_100_percent_of_a_secondary_monitor_is_still_not_fullscreen() {
        // A maximized window's rect extends past the monitor edge to cover
        // its own invisible resize border, so the area test alone would
        // happily accept it. A banking site maximized on a second monitor
        // must never become the capture target.
        let mons = [m(1, r(0, 0, 1920, 1080), true), m(2, r(1920, 0, 3840, 1080), false)];
        let maximized_on_secondary = r(1920 - 7, -7, 1920 + 14, 1080 + 14); // resize-border overshoot
        let (chosen, reason) = choose_target(fg_chrome(maximized_on_secondary), &mons).unwrap();
        assert_eq!(chosen.hmonitor, 1); // falls back to the PRIMARY, not the maximized window's monitor
        assert_eq!(reason, TargetReason::Primary);
    }

    #[test]
    fn a_chromeless_window_still_wins_even_with_the_same_geometry_a_maximized_window_would_have() {
        // Same rect as the case above, but genuinely chromeless (a real
        // fullscreen game/app) — this one SHOULD be captured.
        let mons = [m(1, r(0, 0, 1920, 1080), true), m(2, r(1920, 0, 3840, 1080), false)];
        let (chosen, reason) = choose_target(fg(r(1920, 0, 3840, 1080)), &mons).unwrap();
        assert_eq!(chosen.hmonitor, 2);
        assert_eq!(reason, TargetReason::Fullscreen);
    }

    #[test]
    fn fullscreen_on_a_secondary_monitor_is_captured_there_not_the_primary() {
        let mons = [
            m(1, r(0, 0, 1920, 1080), true),
            m(2, r(1920, 0, 2560, 1440), false), // secondary, to the right, higher res
        ];
        let fullscreen_on_secondary = r(1920, 0, 1920 + 2560, 1440);
        let (chosen, reason) = choose_target(fg(fullscreen_on_secondary), &mons).unwrap();
        assert_eq!(chosen.hmonitor, 2);
        assert_eq!(reason, TargetReason::Fullscreen);
    }

    #[test]
    fn no_foreground_window_falls_back_to_primary() {
        let mons = [m(1, r(0, 0, 1920, 1080), false), m(2, r(1920, 0, 3840, 1080), true)];
        let (chosen, reason) = choose_target(None, &mons).unwrap();
        assert_eq!(chosen.hmonitor, 2);
        assert_eq!(reason, TargetReason::Primary);
    }

    #[test]
    fn a_window_spanning_two_monitors_without_filling_either_is_not_fullscreen() {
        let mons = [m(1, r(0, 0, 1920, 1080), true), m(2, r(1920, 0, 3840, 1080), false)];
        // Straddles the boundary — half of each monitor, fills neither.
        let straddling = r(960, 0, 960 + 1920, 1080);
        let (_, reason) = choose_target(fg(straddling), &mons).unwrap();
        assert_eq!(reason, TargetReason::Primary);
    }

    #[test]
    fn no_monitors_at_all_returns_none_rather_than_panicking() {
        assert!(choose_target(fg(r(0, 0, 100, 100)), &[]).is_none());
    }

    #[test]
    fn zero_area_foreground_rect_is_ignored_not_treated_as_covering_everything() {
        // A window mid-animation / minimizing can report a degenerate rect.
        let mons = [m(1, r(0, 0, 1920, 1080), true)];
        let (_, reason) = choose_target(fg(r(500, 500, 0, 0)), &mons).unwrap();
        assert_eq!(reason, TargetReason::Primary);
    }

    #[test]
    fn bitrate_scales_with_pixel_count_and_clamps_both_ends() {
        let assumed = 1920u64 * 1080; // the 1080p30 preset's assumption
        // same resolution -> unchanged
        assert_eq!(scale_bitrate(6_000_000, assumed, assumed), 6_000_000);
        // 4K -> 4x the pixels -> 4x the bitrate, under the 20 Mbps cap
        assert_eq!(scale_bitrate(4_000_000, assumed, 3840 * 2160), 16_000_000);
        // 4K at a high preset -> clamped to 20 Mbps
        assert_eq!(scale_bitrate(10_000_000, assumed, 3840 * 2160), 20_000_000);
        // a tiny 1024x768 secondary -> floored at 1.5 Mbps
        assert_eq!(scale_bitrate(6_000_000, assumed, 1024 * 768), 2_275_555 /* ratio ~0.379 */);
        assert_eq!(scale_bitrate(3_000_000, assumed, 640 * 480), 1_500_000);
        // degenerate assumed=0 must not divide by zero NOR max out the
        // encoder on an unknown assumption — fall back to the request
        assert_eq!(scale_bitrate(6_000_000, 0, assumed), 6_000_000);
        assert_eq!(scale_bitrate(500_000, 0, assumed), 1_500_000); // still clamped
    }

    // ---- SPS codec-string extraction -------------------------------------

    fn annexb(nals: &[(u8, &[u8])]) -> Vec<u8> {
        let mut out = Vec::new();
        for (nal_type, payload) in nals {
            out.extend_from_slice(&[0, 0, 0, 1]);
            out.push(*nal_type & 0x1f);
            out.extend_from_slice(payload);
        }
        out
    }

    #[test]
    fn extracts_profile_constraints_level_from_a_real_shaped_sps_nal() {
        // profile_idc=0x42 (Baseline), constraint_set flags=0xE0, level_idc=0x1E (3.0)
        let sps_payload = [0x42u8, 0xE0, 0x1E, 0xAA, 0xBB];
        let au = annexb(&[(9, &[0xF0]), (7, &sps_payload), (8, &[0x01]), (5, &[0xAA, 0xBB])]);
        assert_eq!(sps_codec_string(&au).as_deref(), Some("avc1.42E01E"));
    }

    #[test]
    fn works_with_3_byte_start_codes_too() {
        let mut au = Vec::new();
        au.extend_from_slice(&[0, 0, 1, 7, 0x64, 0x00, 0x28, 0x99]); // High profile, level 4.0
        assert_eq!(sps_codec_string(&au).as_deref(), Some("avc1.640028"));
    }

    #[test]
    fn no_sps_present_yields_none_rather_than_a_wrong_guess() {
        let au = annexb(&[(9, &[0xF0]), (5, &[0xAA, 0xBB])]); // AUD + slice, no SPS
        assert_eq!(sps_codec_string(&au), None);
    }

    #[test]
    fn a_truncated_sps_nal_yields_none_rather_than_panicking() {
        let au = annexb(&[(7, &[0x42])]); // only 1 byte of SPS payload
        assert_eq!(sps_codec_string(&au), None);
    }

    // ---- ParamSetCache: keyframes missing their own SPS/PPS ----------------

    #[test]
    fn a_keyframe_that_already_carries_sps_and_pps_is_returned_unchanged() {
        let sps = [0x42u8, 0xE0, 0x1E];
        let pps = [0x01u8];
        let au = annexb(&[(7, &sps), (8, &pps), (5, &[0xAA])]);
        let mut cache = ParamSetCache::default();
        let out = cache.prime_keyframe(au.clone());
        assert_eq!(out, au);
    }

    #[test]
    fn a_later_keyframe_missing_sps_pps_is_primed_from_the_first_one_seen() {
        let sps = [0x42u8, 0xE0, 0x1E];
        let pps = [0x01u8];
        let first = annexb(&[(7, &sps), (8, &pps), (5, &[0xAA])]);
        let mut cache = ParamSetCache::default();
        let primed_first = cache.prime_keyframe(first);
        assert_eq!(sps_codec_string(&primed_first).as_deref(), Some("avc1.42E01E"));

        // A LATER keyframe from an MFT that doesn't repeat the sequence
        // header — no SPS/PPS NALs at all, just the IDR slice.
        let bare_keyframe = annexb(&[(9, &[0xF0]), (5, &[0xBB, 0xCC])]);
        assert_eq!(sps_codec_string(&bare_keyframe), None); // positive control: really has none
        let primed = cache.prime_keyframe(bare_keyframe);
        // Primed with the CACHED sps/pps — mediabunny (and our own
        // extraction) can now derive a real AVCDecoderConfigurationRecord
        // from this keyframe too, exactly as the module header promises.
        assert_eq!(sps_codec_string(&primed).as_deref(), Some("avc1.42E01E"));
        // The original slice payload must still be present, untouched.
        assert!(primed.windows(2).any(|w| w == [0xBB, 0xCC]));
    }

    #[test]
    fn priming_before_any_sps_has_ever_been_seen_is_a_no_op_not_a_panic() {
        let mut cache = ParamSetCache::default();
        let bare = annexb(&[(5, &[0x11, 0x22])]);
        let out = cache.prime_keyframe(bare.clone());
        assert_eq!(out, bare); // nothing to prepend yet — unchanged, not corrupted
    }

    #[test]
    fn a_keyframe_with_only_an_sps_is_learned_but_still_primed_from_the_pps_cache() {
        // Realistic MFT quirk: SPS repeated, PPS not (or vice versa).
        let sps1 = [0x42u8, 0xE0, 0x1E];
        let pps1 = [0x01u8];
        let mut cache = ParamSetCache::default();
        cache.prime_keyframe(annexb(&[(7, &sps1), (8, &pps1), (5, &[0xAA])]));

        let sps_only = annexb(&[(7, &sps1), (5, &[0xDD])]); // no PPS this time
        let primed = cache.prime_keyframe(sps_only);
        assert_eq!(sps_codec_string(&primed).as_deref(), Some("avc1.42E01E"));
        let (_, pps_out) = find_sps_pps(&primed);
        assert_eq!(pps_out.as_deref(), Some(&pps1[..]));
    }
}
