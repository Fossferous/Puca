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
//! path. A downscale pass would be the wrong lever anyway: the resize would
//! run AFTER the full GPU-to-staging readback, so it removes none of the
//! per-frame cost and adds a pass over the surface.
//!
//! What it does instead, since the cost is pixels x fps: when the monitor is
//! bigger than the preset assumed, the excess is folded into the FRAME RATE
//! (`effective_encode_settings`), and the bitrate follows the cadence so the
//! member gets roughly the budget their preset's label promised. Before that,
//! "1080p60 — about 9 Mbps" on a 2560x1440 monitor meant a 2560x1440 60 fps
//! 16 Mbps encode: 1.78x the work asked for, measured at 73-92% of a core on
//! a real machine, against docs/CLIPS.md's own bench of ~40% at ~50 fps. That
//! document already said this loop cannot hold 60 fps at 1440p or above, so
//! the frames were being dropped regardless; the cadence is now honest.

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
}

#[derive(Debug, Clone, Copy)]
pub struct MonitorCandidate {
    pub hmonitor: isize,
    pub rect: Rect,
    pub primary: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TargetReason {
    Primary,
    /// No monitor is flagged primary in the list (should not happen on a real
    /// desktop) — falls back to the first entry rather than panicking.
    FirstAvailable,
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
pub fn choose_target(monitors: &[MonitorCandidate]) -> Option<(MonitorCandidate, TargetReason)> {
    // THE PRIMARY DISPLAY, ALWAYS.
    //
    // This used to look at the foreground window first and prefer whichever
    // monitor a fullscreen app was filling, on the theory that the app you are
    // playing is the thing you want to clip. It cost more than it bought:
    //
    //  * a display that cannot be captured at all looks exactly like one that
    //    can, right up until DuplicateOutput refuses. A VR link display, a
    //    phone-as-second-screen driver or a remote-desktop adapter enumerates
    //    like any other monitor and reports an ordinary resolution — and a
    //    fullscreen VR app on one of those is precisely the case the heuristic
    //    reached for. On 2026-09-09 an arm failed with a bare
    //    `DXGI_ERROR_UNSUPPORTED` while two perfectly capturable monitors sat
    //    beside the one it picked;
    //  * and the rule was invisible. Nothing told you which screen it had
    //    chosen or why, so "it recorded the wrong monitor" was unreportable.
    //
    // The primary display is the one the member can point at, and it is the
    // same one every time. `rank_targets` still falls through to the others if
    // the primary itself cannot be captured, so this is a preference, not a
    // single point of failure.
    if let Some(m) = monitors.iter().find(|m| m.primary) {
        return Some((*m, TargetReason::Primary));
    }
    // No monitor claims to be primary — take the first that exists rather than
    // refusing to arm.
    monitors.first().map(|m| (*m, TargetReason::FirstAvailable))
}

#[derive(Debug, Clone, Serialize)]
pub struct ClipCaptureTarget {
    /// Index into `puca_capture::outputs()` — what `ScreenCapture::new` takes.
    ///
    /// ONLY MEANINGFUL IN THIS PROCESS. Capture runs in the agent now, and a
    /// DXGI walk is per-process: under a GPU pin the app and the host do not
    /// even see the same adapters. `hmonitor` is what crosses the boundary.
    pub output_index: usize,
    /// Win32 `HMONITOR` — stable across processes in a session, so it is the
    /// only handle the app and the capture host can both resolve.
    pub hmonitor: isize,
    pub width: u32,
    pub height: u32,
    pub reason: &'static str,
    /// The bitrate the encoder was ACTUALLY configured with — the caller's
    /// requested bitrate scaled to this monitor's real pixel count (see
    /// `scale_bitrate`). 0 from `pick_target`, which starts no encoder.
    pub bitrate: u32,
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

/// Every candidate monitor in preference order, best first, no repeats.
///
/// WHY AN ORDER AND NOT A SINGLE CHOICE. `choose_target` answers "which monitor
/// does the member most likely mean", which is the right question — but the
/// answer can be a monitor that cannot be captured at all. A virtual display
/// (VR headset link, a phone-as-monitor driver, a remote-desktop adapter)
/// enumerates like any other screen and reports a perfectly ordinary
/// resolution, and desktop duplication on it fails outright with
/// `DXGI_ERROR_UNSUPPORTED`. That happened here on 2026-09-09: the arm failed
/// with a raw HRESULT while two working monitors sat beside the broken one.
///
/// Nobody CHOSE that monitor — a heuristic did — so falling through to the next
/// candidate is what the member meant. `choose_target` stays exactly as it was,
/// including its tests: this only says what to try next when the best answer
/// turns out not to be capturable.
#[cfg(windows)]
pub fn rank_targets(monitors: &[MonitorCandidate]) -> Vec<(MonitorCandidate, TargetReason)> {
    let mut ranked: Vec<(MonitorCandidate, TargetReason)> = Vec::new();
    let push = |m: MonitorCandidate, r: TargetReason, out: &mut Vec<(MonitorCandidate, TargetReason)>| {
        if !out.iter().any(|(c, _)| c.hmonitor == m.hmonitor) {
            out.push((m, r));
        }
    };
    if let Some((best, reason)) = choose_target(monitors) {
        push(best, reason, &mut ranked);
    }
    if let Some(m) = monitors.iter().find(|m| m.primary) {
        push(*m, TargetReason::Primary, &mut ranked);
    }
    for m in monitors {
        push(*m, TargetReason::FirstAvailable, &mut ranked);
    }
    ranked
}

#[cfg(windows)]
pub fn pick_target() -> Result<ClipCaptureTarget, String> {
    let candidates = monitor_candidates();
    if candidates.is_empty() {
        return Err("no capturable monitor found".into());
    }
    let monitors: Vec<MonitorCandidate> = candidates.iter().map(|(m, _)| *m).collect();
    let ranked = rank_targets(&monitors);
    if ranked.is_empty() {
        return Err("no capturable monitor found".into());
    }

    // THE PROBE THAT LIVED HERE IS GONE, and it had to.
    //
    // It opened a duplication to prove the screen could be captured before
    // promising it — a virtual display looks identical to a real one in both
    // enumerations right up until DuplicateOutput refuses. But capture now runs
    // in the agent, because this process may be pinned to a GPU that drives no
    // display, and in that case EVERY probe here fails. Keeping it would have
    // turned "clips work again" into "clips refuse to arm before they even
    // start". The host reports what it finds instead, and its message names
    // every adapter it tried.
    let mut refused: Vec<String> = Vec::new();
    for (chosen, reason) in &ranked {
        let Some((_, output_index)) = candidates.iter().find(|(m, _)| m.hmonitor == chosen.hmonitor)
        else {
            // The monitor went away between enumerating and now.
            refused.push(format!("{}x{}: vanished while choosing",
                chosen.rect.width().max(0), chosen.rect.height().max(0)));
            continue;
        };
        return Ok(ClipCaptureTarget {
            output_index: *output_index,
            hmonitor: chosen.hmonitor,
            width: chosen.rect.width().max(0) as u32,
            height: chosen.rect.height().max(0) as u32,
            reason: match reason {
                TargetReason::Primary => "primary",
                TargetReason::FirstAvailable => "primary", // same UI copy — "no primary flag" is not user-meaningful
            },
            bitrate: 0,
        });
    }

    // Everything was refused. Name what was tried: the bare HRESULT this used
    // to surface said nothing about WHICH screen, which is most of the work in
    // understanding it.
    Err(format!(
        "no monitor could be captured — tried {}: {}",
        refused.len(),
        refused.join("; ")
    ))
}

/// What the encoder should actually be asked for, given the preset the member
/// chose and the monitor it turned out to be pointed at.
///
/// WHY THE FRAME RATE MOVES AND THE FRAME SIZE DOES NOT. This path never
/// scales frames (see the module header): the preset's max width/height apply
/// only to the browser path, so "1080p60" on a 2560x1440 monitor captured
/// 2560x1440 at 60 fps, and `scale_bitrate` raised the promised ~9 Mbps to
/// exactly 16 Mbps to match the extra pixels. Cost is pixels x fps, so that is
/// 1.78x what the member asked for, sustained, for as long as the buffer is
/// armed. Measured on such a host: 73-92% of a core, against a documented
/// bench of ~40% at ~50 fps — and docs/CLIPS.md already says the loop cannot
/// hold 60 fps at 1440p or above as written. It was dropping frames anyway;
/// this makes the cadence honest instead of aspirational.
///
/// A CPU downscale would be the wrong answer even though it sounds like the
/// obvious one: the resize runs AFTER the full GPU-to-staging readback, so it
/// removes none of the per-frame cost and adds another pass over the surface.
/// Trading frame rate is the only lever that actually reduces work here.
///
/// So: when the captured frame is bigger than the preset assumed, fold the
/// excess into the frame rate instead, and carry the bitrate with it so the
/// member gets roughly the bit budget the label promised.
pub fn effective_encode_settings(
    requested_fps: u32,
    requested_bitrate: u32,
    assumed_pixels: u64,
    actual_pixels: u64,
) -> (u32, u32) {
    let bitrate = scale_bitrate(requested_bitrate, assumed_pixels, actual_pixels);
    // A monitor at or under the preset's budget gets exactly what was asked
    // for — the common 1080p case is untouched.
    if assumed_pixels == 0 || actual_pixels <= assumed_pixels || requested_fps == 0 {
        return (requested_fps, bitrate);
    }
    // Keep pixels-per-second at the preset's budget, then round to a cadence a
    // player renders cleanly rather than to whatever the ratio produces. The
    // floor is 24: below that a clip stops reading as motion, and a member who
    // wants more can pick a lower-resolution preset — that choice is now real.
    let budget = (requested_fps as u64).saturating_mul(assumed_pixels) / actual_pixels;
    let fps = match budget {
        0..=29 => 24,
        30..=47 => 30,
        48..=59 => 48,
        _ => requested_fps,
    }
    .min(requested_fps);
    // Bits follow the cadence: fewer frames per second need fewer bits per
    // second for the same picture, and this lands back near the labelled rate.
    let bitrate = ((bitrate as u64) * fps as u64 / requested_fps as u64).clamp(1_500_000, 20_000_000) as u32;
    (fps, bitrate)
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
    // max_width * max_height) — `effective_encode_settings` reconciles it with
    // the monitor actually captured.
    assumed_pixels: u64,
    gop_ms: u32,
) -> Result<ClipCaptureTarget, String> {
    let mut target = pick_target()?;
    let actual_pixels = target.width as u64 * target.height as u64;
    let (effective_fps, scaled_bitrate) =
        effective_encode_settings(fps, bitrate, assumed_pixels, actual_pixels);
    target.bitrate = scaled_bitrate;
    if effective_fps != fps {
        // Say it plainly: the member picked a preset and is getting a
        // different cadence, because their monitor is bigger than the preset
        // assumed. Silent is how "1080p60" became a 1440p60 encode.
        log::info!(
            "Clip capture: {}x{} is larger than this preset assumed, so the buffer records at {} fps, not {} ({} kbps)",
            target.width, target.height, effective_fps, fps, scaled_bitrate / 1000
        );
    }
    let fps = effective_fps;

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
        let result = capture_loop(app, state_clone.clone(), t, fps, gop_ms, ready_tx);
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
    // SAY SO. This used to flip the flag and nothing else, and the loop's clean
    // exit was silent too — so the log recorded a start and never a stop, and
    // "no stop line" proved nothing about whether a capture was still running.
    // Diagnosing a machine that had been capturing for four and a half hours
    // took a process-memory scan because of it.
    log::info!("Clip video capture: stop requested");
    state.stop_signal.store(true, Ordering::SeqCst);
}

#[cfg(windows)]
/// Where the agent sidecar is, if this build has one.
///
/// Mirrors `agent_ipc::agent_path`. Kept separate deliberately: that one is
/// about the remote-control agent's lifecycle, and a clip capture must not be
/// able to disturb, restart, or be restarted by an attended session.
fn clip_host_path() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let candidate = dir.join("puca-agent.exe");
    candidate.exists().then_some(candidate)
}

#[cfg(windows)]
/// Capture out of process when we can, in process when there is no sidecar.
///
/// WHY OUT OF PROCESS AT ALL: Windows pins a GPU preference per EXECUTABLE
/// PATH, and this app is deliberately pinned to the integrated GPU by the
/// owner of the machine it was written for — it is what stops their stream
/// looking choppy while a game holds the discrete card at 100%. Desktop
/// duplication only works on the GPU driving the display, and inside a pinned
/// process the discrete card does not offer the monitors at all: measured
/// 2026-09-10, all three were exposed by the integrated adapter and by nothing
/// else, so every one refused with 0x887A0004 and there was no other adapter to
/// fall back to. The agent is a different executable, so it gets its own
/// (absent, therefore default) preference.
///
/// The in-process path stays for builds with no sidecar — a dev run — and is
/// the same code that has always run. It is not a workaround for a failing
/// host: if the host cannot capture, that is the answer, and it says why.
fn capture_loop(
    app: AppHandle,
    state: Arc<ClipCaptureState>,
    target: ClipCaptureTarget,
    fps: u32,
    gop_ms: u32,
    ready: std::sync::mpsc::Sender<Result<(), String>>,
) -> Result<(), String> {
    match clip_host_path() {
        Some(path) => sidecar_capture_loop(path, app, state, target, fps, gop_ms, ready),
        None => {
            log::info!("Clip video capture: no agent sidecar beside the app, capturing in process");
            in_process_capture_loop(app, state, target, fps, gop_ms, ready)
        }
    }
}

#[cfg(windows)]
fn sidecar_capture_loop(
    path: std::path::PathBuf,
    app: AppHandle,
    state: Arc<ClipCaptureState>,
    target: ClipCaptureTarget,
    fps: u32,
    gop_ms: u32,
    ready: std::sync::mpsc::Sender<Result<(), String>>,
) -> Result<(), String> {
    use std::io::Read;

    // CREATE_NO_WINDOW. The agent is a CONSOLE binary and this is a GUI app, so
    // spawning it plainly pops a black console window on the member's desktop —
    // every time the buffer arms, which is on every voice join. The existing
    // agent launch in agent_ipc.rs sets this for the same reason. Giving it
    // piped stdio is unaffected: the pipes are handed over explicitly, so the
    // absent console costs nothing.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    use std::os::windows::process::CommandExt;
    let mut child = match std::process::Command::new(&path)
        .creation_flags(CREATE_NO_WINDOW)
        .args([
            "--clip-capture",
            "--hmonitor", &target.hmonitor.to_string(),
            "--width", &target.width.to_string(),
            "--height", &target.height.to_string(),
            "--fps", &fps.to_string(),
            "--bitrate", &target.bitrate.to_string(),
            "--gop-ms", &gop_ms.to_string(),
        ])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            let msg = format!("Could not start the capture helper: {e}");
            let _ = ready.send(Err(msg.clone()));
            return Err(msg);
        }
    };

    let mut out = child.stdout.take().expect("piped");
    let mut err_pipe = child.stderr.take().expect("piped");
    // Drain stderr on its own thread. The host writes one line and exits when
    // it fails, and a full pipe would otherwise wedge it before it could.
    let (err_tx, err_rx) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        let mut buf = String::new();
        let _ = err_pipe.read_to_string(&mut buf);
        let _ = err_tx.send(buf);
    });

    let child = std::sync::Arc::new(std::sync::Mutex::new(child));
    // A read on the pipe blocks, so `stop` has to arrive from outside: this
    // watcher kills the host, which closes the pipe, which ends the loop.
    let done = Arc::new(AtomicBool::new(false));
    {
        let (state, child, done) = (state.clone(), child.clone(), done.clone());
        std::thread::spawn(move || {
            while !done.load(Ordering::SeqCst) {
                if state.stop_signal.load(Ordering::SeqCst) {
                    if let Ok(mut c) = child.lock() {
                        let _ = c.kill();
                    }
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        });
    }
    // Whatever happens below, stop the watcher and the host with it.
    struct StopGuard(Arc<AtomicBool>, std::sync::Arc<std::sync::Mutex<std::process::Child>>);
    impl Drop for StopGuard {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
            if let Ok(mut c) = self.1.lock() {
                let _ = c.kill();
                let _ = c.wait();
            }
        }
    }
    let _guard = StopGuard(done, child.clone());

    // The magic is the host's READY signal: it is written only once capture and
    // the encoder have both opened. No magic means it never started, and the
    // reason is on stderr.
    let mut magic = [0u8; 8];
    if out.read_exact(&mut magic).is_err() || &magic != puca_clip_wire::MAGIC {
        let reason = err_rx
            .recv_timeout(std::time::Duration::from_secs(3))
            .unwrap_or_default();
        let reason = reason.trim();
        let msg = if reason.is_empty() {
            "The capture helper stopped before it produced anything.".to_string()
        } else {
            reason.trim_start_matches("clip-host: ").to_string()
        };
        let _ = ready.send(Err(msg.clone()));
        return Err(msg);
    }
    let _ = ready.send(Ok(()));
    log::info!(
        "Clip video capture started in the agent: monitor {:#x} ({}x{} @ {} fps, {} kbps)",
        target.hmonitor, target.width, target.height, fps, target.bitrate / 1000
    );

    let start = std::time::Instant::now();
    let mut params = ParamSetCache::default();
    let mut consecutive_sps_failures = 0u32;
    let mut frames_encoded: u64 = 0;
    let mut bytes_emitted: u64 = 0;
    let mut last_beat = std::time::Instant::now();
    const HEARTBEAT: std::time::Duration = std::time::Duration::from_secs(60);

    loop {
        let mut head = [0u8; puca_clip_wire::HEADER_LEN];
        if out.read_exact(&mut head).is_err() {
            break; // the host exited; why is decided below
        }
        let head = puca_clip_wire::Header::from_bytes(&head);
        let (keyframe, ts_us, dur_us) = (head.keyframe, head.ts_us, head.dur_us);
        // A length is the one field a desynced stream could turn into a
        // multi-gigabyte allocation, because it is trusted BEFORE the bytes
        // behind it have been seen.
        if !puca_clip_wire::payload_len_is_sane(head.len) {
            return Err("The capture helper sent a frame that cannot be right.".to_string());
        }
        let mut data = vec![0u8; head.len as usize];
        if out.read_exact(&mut data).is_err() {
            break;
        }
        if keyframe {
            data = params.prime_keyframe(data);
        }

        // The codec string rides on EVERY keyframe — see the note at the old
        // compute site: chunks emitted before the JS ring exists are dropped,
        // and a one-shot made that race permanent.
        let codec = if keyframe {
            match sps_codec_string(&data) {
                Some(c) => { consecutive_sps_failures = 0; Some(c) }
                None => {
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

        let emitted_bytes = data.len() as u64;
        let event = ClipVideoChunkEvent {
            data: base64_encode(&data),
            keyframe,
            ts_us,
            dur_us,
            codec,
            width: target.width,
            height: target.height,
        };
        if app.emit("clip-video-chunk", event).is_err() {
            break; // the window is gone — nothing left to stream to
        }
        frames_encoded += 1;
        bytes_emitted += emitted_bytes;
        if last_beat.elapsed() >= HEARTBEAT {
            let secs = start.elapsed().as_secs_f64().max(0.001);
            log::info!(
                "Clip video capture: still armed — {:.0}s, {} frames ({:.1} fps), {:.1} Mbit/s, agent host",
                secs, frames_encoded, frames_encoded as f64 / secs,
                (bytes_emitted as f64 * 8.0) / secs / 1_000_000.0,
            );
            last_beat = std::time::Instant::now();
        }
    }

    let stopped_on_purpose = state.stop_signal.load(Ordering::SeqCst);
    let secs = start.elapsed().as_secs_f64().max(0.001);
    log::info!(
        "Clip video capture stopped: {:.0}s, {} frames ({:.1} fps), {:.1} Mbit/s, agent host",
        secs, frames_encoded, frames_encoded as f64 / secs,
        (bytes_emitted as f64 * 8.0) / secs / 1_000_000.0,
    );
    if stopped_on_purpose {
        return Ok(());
    }
    // The host died on its own. Its last words are the useful part — they name
    // the screen and every adapter tried — so they must reach the member rather
    // than becoming "capture ended".
    let reason = err_rx
        .recv_timeout(std::time::Duration::from_secs(3))
        .unwrap_or_default();
    let reason = reason.trim().trim_start_matches("clip-host: ").to_string();
    if reason.is_empty() {
        Err("The capture helper stopped unexpectedly.".to_string())
    } else {
        Err(reason)
    }
}

#[cfg(windows)]
fn in_process_capture_loop(
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
    // A capture nobody is watching should still be able to say what it is
    // costing: without a heartbeat, hours of recording leave exactly one line.
    let mut frames_encoded: u64 = 0;
    let mut bytes_emitted: u64 = 0;
    let mut last_beat = std::time::Instant::now();
    const HEARTBEAT: std::time::Duration = std::time::Duration::from_secs(60);

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
        let emitted_bytes = data.len() as u64;
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
        frames_encoded += 1;
        bytes_emitted += emitted_bytes;
        if last_beat.elapsed() >= HEARTBEAT {
            let secs = start.elapsed().as_secs_f64().max(0.001);
            log::info!(
                "Clip video capture: still armed — {:.0}s, {} frames ({:.1} fps), {:.1} Mbit/s, output {}",
                secs,
                frames_encoded,
                frames_encoded as f64 / secs,
                (bytes_emitted as f64 * 8.0) / secs / 1_000_000.0,
                target.output_index,
            );
            last_beat = std::time::Instant::now();
        }
    }
    let secs = start.elapsed().as_secs_f64().max(0.001);
    log::info!(
        "Clip video capture stopped: {:.0}s, {} frames ({:.1} fps), {:.1} Mbit/s, output {}",
        secs,
        frames_encoded,
        frames_encoded as f64 / secs,
        (bytes_emitted as f64 * 8.0) / secs / 1_000_000.0,
        target.output_index,
    );
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
    // ---- which monitor gets captured -------------------------------------
    //
    // TOMBSTONE. Until 2026-09-09 this picked whichever monitor a CHROMELESS
    // foreground window covered by >=95%, on the theory that the fullscreen app
    // is the thing worth clipping, and eleven tests here pinned that rule
    // (exclusive vs borderless, maximized-but-not-fullscreen, spanning two
    // monitors, and so on).
    //
    // It is gone, deliberately. A display that CANNOT be captured looks
    // identical to one that can until DuplicateOutput refuses — and a VR link
    // display or a phone-as-second-screen driver, running a fullscreen app, is
    // exactly what the heuristic reached for. An arm failed with a bare
    // DXGI_ERROR_UNSUPPORTED while two capturable monitors sat beside the one
    // it chose. The rule was also invisible: nothing said which screen it had
    // picked, so "it recorded the wrong monitor" could not be reported.
    //
    // If fullscreen-follows ever comes back it needs BOTH halves: a
    // capturability probe before committing, and telling the member which
    // screen it chose.

    #[test]
    fn the_primary_display_is_the_target() {
        let mons = [m(1, r(0, 0, 1920, 1080), false), m(2, r(1920, 0, 3840, 1080), true)];
        let (chosen, reason) = choose_target(&mons).unwrap();
        assert_eq!(chosen.hmonitor, 2, "the monitor flagged primary, not the first in the list");
        assert_eq!(reason, TargetReason::Primary);
    }

    #[test]
    fn the_primary_wins_wherever_it_sits_in_the_list() {
        // POSITIVE CONTROL for the test above: moving the primary flag moves
        // the answer, so that assertion is about `primary` and not about
        // position.
        let mons = [m(7, r(0, 0, 1920, 1080), true), m(8, r(1920, 0, 3840, 1080), false)];
        assert_eq!(choose_target(&mons).unwrap().0.hmonitor, 7);
    }

    #[test]
    fn with_no_primary_flag_it_takes_the_first_rather_than_refusing() {
        // Should not happen on a real desktop, but refusing to arm because
        // Windows did not flag a primary would be a worse answer than picking
        // one.
        let mons = [m(4, r(0, 0, 1920, 1080), false), m(5, r(1920, 0, 3840, 1080), false)];
        let (chosen, reason) = choose_target(&mons).unwrap();
        assert_eq!(chosen.hmonitor, 4);
        assert_eq!(reason, TargetReason::FirstAvailable);
    }

    #[test]
    fn no_monitors_at_all_returns_none_rather_than_panicking() {
        assert!(choose_target(&[]).is_none());
    }

    /// The measured case, from a real machine on 2026-09-07: the member had
    /// picked "1080p 60 fps — about 9 Mbps" and the log line read
    /// "2560x1440 @ 60 fps, 16000 kbps". Cost is pixels x fps, so that was
    /// 1.78x the work the label promised, sustained, and it showed up as
    /// 73-92% of a core.
    #[test]
    fn a_monitor_larger_than_the_preset_trades_frame_rate_not_frame_size() {
        let hd = 1920u64 * 1080;
        let qhd = 2560u64 * 1440;
        let (fps, bitrate) = effective_encode_settings(60, 9_000_000, hd, qhd);
        assert_eq!(fps, 30, "1440p at the 1080p60 pixel budget is ~34 fps, so 30");
        // 16 Mbps for the bigger frame, halved with the cadence, lands back
        // near the ~9 Mbps the preset's label promised.
        assert_eq!(bitrate, 8_000_000);
    }

    /// The common case must be untouched: a 1080p monitor on a 1080p preset
    /// gets exactly what it asked for, at exactly the labelled bitrate.
    #[test]
    fn a_monitor_within_the_preset_is_left_alone() {
        let hd = 1920u64 * 1080;
        assert_eq!(effective_encode_settings(60, 9_000_000, hd, hd), (60, 9_000_000));
        let small = 1600u64 * 900;
        let (fps, bitrate) = effective_encode_settings(60, 9_000_000, hd, small);
        assert_eq!(fps, 60);
        assert!(bitrate < 9_000_000, "a smaller monitor still gets scale_bitrate's reduction");
    }

    /// 4K on a 1080p preset is four times the pixels; the cadence floor keeps
    /// the result watchable rather than following the ratio to 15 fps.
    #[test]
    fn a_4k_monitor_lands_on_the_cadence_floor() {
        let hd = 1920u64 * 1080;
        let uhd = 3840u64 * 2160;
        let (fps, _) = effective_encode_settings(60, 9_000_000, hd, uhd);
        assert_eq!(fps, 24);
    }

    /// Degenerate inputs must not pick the most expensive setting.
    #[test]
    fn effective_settings_survive_degenerate_inputs() {
        assert_eq!(effective_encode_settings(0, 9_000_000, 1, 4).0, 0);
        let (fps, _) = effective_encode_settings(60, 9_000_000, 0, 4);
        assert_eq!(fps, 60, "an unknown assumption cannot justify changing the cadence");
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
    // ---- the fallback order, after a monitor that cannot be captured -------

    #[test]
    fn ranking_leads_with_the_same_answer_choose_target_gives() {
        // The fallback must not change WHICH monitor is preferred — only what
        // happens when that one turns out not to be capturable.
        for mons in [
            vec![m(1, r(0, 0, 1920, 1080), true), m(2, r(1920, 0, 3840, 1080), false)],
            vec![m(1, r(0, 0, 1920, 1080), false), m(2, r(1920, 0, 3840, 1080), true)],
            vec![m(1, r(0, 0, 1920, 1080), false), m(2, r(1920, 0, 3840, 1080), false)],
        ] {
            let best = choose_target(&mons).unwrap();
            let ranked = rank_targets(&mons);
            assert_eq!(ranked[0].0.hmonitor, best.0.hmonitor);
            assert_eq!(ranked[0].1, best.1);
        }
    }

    #[test]
    fn ranking_offers_every_monitor_exactly_once() {
        // THE CASE THAT HAPPENED: a virtual display enumerates like any other
        // screen, gets chosen, and then refuses to be duplicated. Two working
        // monitors sat beside it and the arm failed anyway. Every monitor has
        // to be reachable, and none may be offered twice — a repeat would mean
        // probing the broken one again and naming it twice in the error.
        let mons = [
            m(1, r(0, 0, 1920, 1080), true),
            m(2, r(1920, 0, 3840, 1080), false),
            m(3, r(-1920, 0, 0, 1080), false),
        ];
        let ranked = rank_targets(&mons);
        assert_eq!(ranked.len(), mons.len(), "every monitor must be a candidate");
        let mut seen: Vec<isize> = ranked.iter().map(|(c, _)| c.hmonitor).collect();
        seen.sort_unstable();
        seen.dedup();
        assert_eq!(seen.len(), mons.len(), "no monitor may appear twice");
    }

    #[test]
    fn ranking_leads_with_the_primary_and_keeps_the_rest() {
        // A fullscreen window on the secondary takes first place; the primary
        // is the next most likely thing the member meant, ahead of the rest.
        let mons = [
            m(1, r(0, 0, 1920, 1080), true),
            m(2, r(1920, 0, 3840, 1080), false),
            m(3, r(-1920, 0, 0, 1080), false),
        ];
        let ranked = rank_targets(&mons);
        assert!(ranked[0].0.primary, "the primary leads");
        assert_eq!(ranked.len(), 3, "and the others remain reachable behind it");
    }

    #[test]
    fn ranking_is_empty_only_when_there_are_no_monitors() {
        // POSITIVE CONTROL for pick_target's emptiness check: with any monitor
        // at all there is always something to try, so an empty ranking means
        // exactly one thing.
        assert!(rank_targets(&[]).is_empty());
        assert!(!rank_targets(&[m(1, r(0, 0, 1920, 1080), true)]).is_empty());
    }

}
