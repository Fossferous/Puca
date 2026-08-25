//! Native SYSTEM (desktop-wide) audio capture for Clips auto-arm.
//!
//! Deliberately a SEPARATE module from `audio_capture.rs`'s per-app capture
//! ("game only" stream audio), not an extra mode bolted onto it: that file's
//! `AudioCaptureState`/`AudioContext`/`dest` are process-wide singletons a
//! live screen share already uses for its own "include this app's audio"
//! feature, and a second concurrent capture through the same state would
//! silently stop the share's audio to start the clip's (`start_capture_track`
//! in `appAudio.ts` calls `stopGameAudio()` first if one is already running).
//! Someone sharing a screen WITH game audio while the clip buffer is also
//! armed is a completely ordinary case, so this owns its own state and its
//! own event name (`clip-audio-data`, never `audio-data`).
//!
//! WASAPI mechanics mirror `audio_capture.rs`'s proven capture loop, with one
//! difference: that file opens a per-PROCESS loopback client
//! (`AudioClient::new_application_loopback_client`), which can only capture
//! ONE app (+children). This wants the whole desktop — the same thing
//! `getDisplayMedia({audio:{systemAudio:'include'}})` currently provides —
//! so it opens the classic WASAPI loopback instead: the DEFAULT RENDER
//! device's `AudioClient`, initialized with `Direction::Capture` (the
//! `wasapi` crate turns exactly that Render-device/Capture-direction/Shared
//! combination into `AUDCLNT_STREAMFLAGS_LOOPBACK` internally — see its
//! `initialize_client`). Same format (32-bit float, 48 kHz, stereo) the clip
//! ring's AudioEncoder already expects, so the JS side needs no new decode
//! path — only a new small scheduler mirroring `appAudio.ts`'s (kept
//! separate for the same singleton-collision reason as the Rust side).

use base64::Engine;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

pub struct ClipDesktopAudioState {
    pub is_capturing: AtomicBool,
    pub stop_signal: AtomicBool,
    /// Which capture the state currently belongs to. The state is a process
    /// singleton, and without an owner a FAILED start's cleanup could stop a
    /// capture someone else had meanwhile started — review-caught: retry's
    /// start loses the CAS race to a re-arm's, its teardown fires the global
    /// stop, and the re-arm's healthy capture dies through the CLEAN exit
    /// path, so no error event ever says so. Every event and the stop
    /// command now carry the generation.
    pub generation: AtomicU64,
}

impl Default for ClipDesktopAudioState {
    fn default() -> Self {
        Self {
            is_capturing: AtomicBool::new(false),
            stop_signal: AtomicBool::new(false),
            generation: AtomicU64::new(0),
        }
    }
}

#[derive(Serialize, Clone)]
struct ClipAudioDataEvent {
    data: String, // base64 f32 LE PCM, interleaved
    sample_rate: u32,
    channels: u32,
    bits_per_sample: u32,
    silent: bool,
    /// Which capture produced this. The JS side drops events from a
    /// generation it does not own — an old thread's tail (it can outlive its
    /// stop signal by up to one 100ms wait) must not feed the new graph.
    generation: u64,
}

/// What `start_clip_desktop_audio` resolves with. The desktop shell and its
/// bundled frontend ship as ONE artifact (Tauri bundles dist/), so this shape
/// can change freely with its caller — there is no cross-version skew on the
/// invoke boundary.
#[derive(Serialize, Clone)]
pub struct ClipAudioStarted {
    pub device_name: String,
    pub generation: u64,
}

/// A capture death, attributed. `message` is the human string; `generation`
/// lets the JS ignore a stale death that arrives after a successful retry
/// (the capture thread clears `is_capturing` BEFORE it emits the error, so a
/// successor can be fully started when the predecessor's error lands).
#[derive(Serialize, Clone)]
struct ClipAudioError {
    message: String,
    generation: u64,
}

/// Which render device should the loopback capture, given the friendly names
/// WASAPI enumerated and what the UI asked for.
///
/// Three passes, strictest first — exact, then case-insensitive, then
/// case-insensitive substring — because the two sides spell the same device
/// differently: the browser's `enumerateDevices` label and WASAPI's friendly
/// name usually agree, but not always ("Speakers (2- Realtek(R) Audio)" vs
/// "Speakers"), and a near-miss should still find the right panel rather
/// than silently recording the wrong one. `None` means "nothing plausible":
/// the caller logs and uses the default output, which is the pre-feature
/// behaviour and always produces SOME audio.
///
/// Pure and OS-free so the ranking is table-testable.
pub fn pick_render_device(names: &[String], wanted: &str) -> Option<usize> {
    if wanted.is_empty() {
        return None;
    }
    if let Some(i) = names.iter().position(|n| n == wanted) {
        return Some(i);
    }
    let wanted_lower = wanted.to_lowercase();
    if let Some(i) = names.iter().position(|n| n.to_lowercase() == wanted_lower) {
        return Some(i);
    }
    names.iter().position(|n| {
        let n = n.to_lowercase();
        !n.is_empty() && (n.contains(&wanted_lower) || wanted_lower.contains(&n))
    })
}

#[cfg(windows)]
pub fn start_capture(
    app: AppHandle,
    state: Arc<ClipDesktopAudioState>,
    device_name: Option<String>,
) -> Result<ClipAudioStarted, String> {
    let mut waited_ms = 0u32;
    loop {
        match state.is_capturing.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst) {
            Ok(_) => break,
            Err(_) => {
                // BOTH refusal paths return WITHOUT having claimed anything,
                // and the caller must not clean up after them: someone else
                // owns (or is about to own) the singleton, and the old
                // unconditional stop-on-failure is exactly how a losing
                // starter killed the winner's capture.
                if !state.stop_signal.load(Ordering::SeqCst) {
                    return Err("Already capturing desktop audio".to_string());
                }
                if waited_ms >= 1000 {
                    return Err("Previous desktop audio capture is still shutting down".to_string());
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
                waited_ms += 10;
            }
        }
    }
    state.stop_signal.store(false, Ordering::SeqCst);
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;

    // The ready channel carries the friendly name of the device the loop
    // actually opened, so the UI can name what the clip is listening to.
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<String, String>>();
    let state_clone = state.clone();
    let emit_handle = app.clone();
    std::thread::spawn(move || {
        let result = capture_loop(app, state_clone.clone(), device_name, generation, ready_tx);
        state_clone.is_capturing.store(false, Ordering::SeqCst);
        if let Err(e) = result {
            log::error!("Clip desktop audio capture error: {}", e);
            let _ = emit_handle
                .emit("clip-audio-capture-error", ClipAudioError { message: e, generation });
        }
    });

    match ready_rx.recv_timeout(std::time::Duration::from_secs(3)) {
        Ok(Ok(name)) => Ok(ClipAudioStarted { device_name: name, generation }),
        Ok(Err(e)) => Err(e),
        Err(_) => {
            // WE claimed the singleton and our thread is wedged or slow
            // mid-init: reclaim it ourselves, so the caller never needs the
            // global stop on a failure path (see the refusal comment above —
            // a failed start must never be able to stop anyone else).
            state.stop_signal.store(true, Ordering::SeqCst);
            Err("Desktop audio capture initialisation timed out".to_string())
        }
    }
}

/// Signal the capture to stop — but only the capture the caller OWNS.
/// `generation` from the start's reply; `None` stops whatever is running
/// (the pre-generation behaviour, kept for teardown paths that genuinely
/// mean "whatever it is, end it").
#[cfg(windows)]
pub fn stop_capture(state: Arc<ClipDesktopAudioState>, generation: Option<u64>) {
    if generation.map_or(true, |g| g == state.generation.load(Ordering::SeqCst)) {
        state.stop_signal.store(true, Ordering::SeqCst);
    }
}

#[cfg(windows)]
fn capture_loop(
    app: AppHandle,
    state: Arc<ClipDesktopAudioState>,
    device_name: Option<String>,
    generation: u64,
    ready: std::sync::mpsc::Sender<Result<String, String>>,
) -> Result<(), String> {
    use wasapi::{DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat};

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

    let hr = wasapi::initialize_mta();
    if hr.is_err() {
        let e = format!("COM init failed: {:?}", hr);
        let _ = ready.send(Err(e.clone()));
        return Err(e);
    }

    let enumerator = init_step!(DeviceEnumerator::new().map_err(|e| format!("Failed to enumerate audio devices: {e:?}")));
    // The RENDER device (what's playing) opened for CAPTURE is what the
    // wasapi crate turns into desktop loopback — see the module header. Which
    // render device matters: loopback hears ONLY what plays through that
    // device, so capturing the default speakers while the game plays through
    // the user's chosen headset records silence. Honour the preference when
    // one is given; any miss falls back to the default output, logged — the
    // pre-feature behaviour, and always some audio rather than none.
    let device = match device_name.as_deref().filter(|w| !w.is_empty()) {
        Some(wanted) => {
            let picked = enumerator
                .get_device_collection(&Direction::Render)
                .ok()
                .and_then(|coll| {
                    let n = coll.get_nbr_devices().ok()?;
                    let names: Vec<String> = (0..n)
                        .map(|i| {
                            coll.get_device_at_index(i)
                                .ok()
                                .and_then(|d| d.get_friendlyname().ok())
                                .unwrap_or_default()
                        })
                        .collect();
                    let idx = pick_render_device(&names, wanted);
                    if idx.is_none() {
                        log::warn!(
                            "[clip-audio] no render device matches {wanted:?} (have {names:?}); \
                             using the default output"
                        );
                    }
                    coll.get_device_at_index(idx? as u32).ok()
                });
            match picked {
                Some(d) => d,
                None => init_step!(enumerator
                    .get_default_device(&Direction::Render)
                    .map_err(|e| format!("No default playback device: {e:?}"))),
            }
        }
        None => init_step!(enumerator
            .get_default_device(&Direction::Render)
            .map_err(|e| format!("No default playback device: {e:?}"))),
    };
    let captured_name =
        device.get_friendlyname().unwrap_or_else(|_| "Default output".to_string());
    let mut audio_client = init_step!(device.get_iaudioclient().map_err(|e| format!("Failed to open the playback device: {e:?}")));

    let desired_format = WaveFormat::new(32, 32, &SampleType::Float, 48000, 2, None);
    let mode = StreamMode::EventsShared { autoconvert: true, buffer_duration_hns: 200_000 };
    init_step!(audio_client
        .initialize_client(&desired_format, &Direction::Capture, &mode)
        .map_err(|e| format!("Failed to initialize desktop loopback: {e:?}")));

    let capture_client = init_step!(audio_client.get_audiocaptureclient().map_err(|e| format!("Failed to get capture client: {e:?}")));
    let event_handle = init_step!(audio_client.set_get_eventhandle().map_err(|e| format!("Failed to get event handle: {e:?}")));
    init_step!(audio_client.start_stream().map_err(|e| format!("Failed to start desktop audio capture: {e:?}")));

    let _ = ready.send(Ok(captured_name.clone()));
    log::info!("Clip desktop audio capture started on {captured_name:?}");

    let bytes_per_frame = 2 * 4; // stereo * 32-bit float
    let mut buffer: Vec<u8> = vec![0u8; 48000 * bytes_per_frame / 10]; // ~100ms starting size

    let mut silent_streak: u32 = 0;
    let mut warned_silent_streak = false;

    while !state.stop_signal.load(Ordering::SeqCst) {
        if event_handle.wait_for_event(100).is_err() {
            continue; // timeout — nothing new, loop back and re-check stop_signal
        }
        match capture_client.get_next_packet_size() {
            Ok(Some(packet_size)) if packet_size > 0 => {
                let bytes_needed = packet_size as usize * bytes_per_frame;
                if buffer.len() < bytes_needed {
                    buffer.resize(bytes_needed, 0);
                }
                match capture_client.read_from_device(&mut buffer[..bytes_needed]) {
                    Ok((frames_read, buffer_info)) => {
                        let actual_bytes = frames_read as usize * bytes_per_frame;
                        if buffer_info.flags.silent {
                            silent_streak += 1;
                            if !warned_silent_streak && silent_streak >= 50 {
                                warned_silent_streak = true;
                                log::warn!(
                                    "WASAPI has flagged ~1s of continuous desktop audio as SILENT — \
                                     capture is alive and 'succeeding' but Windows says there is nothing \
                                     real to give right now (as opposed to no packets arriving at all)"
                                );
                            }
                        } else {
                            silent_streak = 0;
                        }
                        let encoded = base64::engine::general_purpose::STANDARD.encode(&buffer[..actual_bytes]);
                        if app
                            .emit("clip-audio-data", ClipAudioDataEvent {
                                data: encoded,
                                sample_rate: 48000,
                                channels: 2,
                                bits_per_sample: 32,
                                silent: buffer_info.flags.silent,
                                generation,
                            })
                            .is_err()
                        {
                            break; // window gone
                        }
                    }
                    Err(e) => return Err(format!("Failed to read desktop audio: {e:?}")),
                }
            }
            Ok(_) => { /* nothing pending this tick */ }
            Err(e) => return Err(format!("Failed to query desktop audio packet size: {e:?}")),
        }
    }
    let _ = audio_client.stop_stream();
    Ok(())
}

#[cfg(not(windows))]
pub fn start_capture(
    _app: AppHandle,
    _state: Arc<ClipDesktopAudioState>,
    _device_name: Option<String>,
) -> Result<ClipAudioStarted, String> {
    Err("native desktop audio capture is only supported on Windows".into())
}

#[cfg(not(windows))]
pub fn stop_capture(_state: Arc<ClipDesktopAudioState>, _generation: Option<u64>) {}

#[cfg(test)]
mod tests {
    use super::pick_render_device;

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn the_device_ranking_prefers_exact_then_case_then_substring() {
        let devs = names(&[
            "Speakers (2- Realtek(R) Audio)",
            "Headset Earphone (Arctis 7)",
            "DELL U2720Q (NVIDIA High Definition Audio)",
        ]);
        // Exact wins even when a later name would also substring-match.
        assert_eq!(pick_render_device(&devs, "Headset Earphone (Arctis 7)"), Some(1));
        // Case-insensitive exact.
        assert_eq!(pick_render_device(&devs, "headset earphone (arctis 7)"), Some(1));
        // Substring, either direction: the browser label is often shorter
        // than WASAPI's friendly name — and sometimes longer.
        assert_eq!(pick_render_device(&devs, "arctis"), Some(1));
        assert_eq!(
            pick_render_device(&devs, "DELL U2720Q (NVIDIA High Definition Audio) - Display"),
            Some(2)
        );
        // No plausible match: the caller must fall back to the default
        // output, not guess — a wrong device records the wrong audio with no
        // error anywhere.
        assert_eq!(pick_render_device(&devs, "Bluetooth Hands-Free"), None);
        // Degenerates: an empty wanted string must never match everything.
        assert_eq!(pick_render_device(&devs, ""), None);
        assert_eq!(pick_render_device(&[], "anything"), None);
        // An empty ENUMERATED name must never satisfy the containment test
        // ("" is a substring of every wanted string).
        assert_eq!(pick_render_device(&names(&["", "Speakers"]), "Speakers"), Some(1));
    }
}
