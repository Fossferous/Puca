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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

pub struct ClipDesktopAudioState {
    pub is_capturing: AtomicBool,
    pub stop_signal: AtomicBool,
}

impl Default for ClipDesktopAudioState {
    fn default() -> Self {
        Self { is_capturing: AtomicBool::new(false), stop_signal: AtomicBool::new(false) }
    }
}

#[derive(Serialize, Clone)]
struct ClipAudioDataEvent {
    data: String, // base64 f32 LE PCM, interleaved
    sample_rate: u32,
    channels: u32,
    bits_per_sample: u32,
    silent: bool,
}

#[cfg(windows)]
pub fn start_capture(app: AppHandle, state: Arc<ClipDesktopAudioState>) -> Result<(), String> {
    let mut waited_ms = 0u32;
    loop {
        match state.is_capturing.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst) {
            Ok(_) => break,
            Err(_) => {
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

    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();
    let state_clone = state.clone();
    let emit_handle = app.clone();
    std::thread::spawn(move || {
        let result = capture_loop(app, state_clone.clone(), ready_tx);
        state_clone.is_capturing.store(false, Ordering::SeqCst);
        if let Err(e) = result {
            log::error!("Clip desktop audio capture error: {}", e);
            let _ = emit_handle.emit("clip-audio-capture-error", e);
        }
    });

    match ready_rx.recv_timeout(std::time::Duration::from_secs(3)) {
        Ok(Ok(())) => Ok(()),
        Ok(Err(e)) => Err(e),
        Err(_) => Err("Desktop audio capture initialisation timed out".to_string()),
    }
}

#[cfg(windows)]
pub fn stop_capture(state: Arc<ClipDesktopAudioState>) {
    state.stop_signal.store(true, Ordering::SeqCst);
}

#[cfg(windows)]
fn capture_loop(
    app: AppHandle,
    state: Arc<ClipDesktopAudioState>,
    ready: std::sync::mpsc::Sender<Result<(), String>>,
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
    // The RENDER device (what's playing, e.g. the default speakers) opened
    // for CAPTURE is what the wasapi crate turns into desktop loopback — see
    // the module header.
    let device = init_step!(enumerator
        .get_default_device(&Direction::Render)
        .map_err(|e| format!("No default playback device: {e:?}")));
    let mut audio_client = init_step!(device.get_iaudioclient().map_err(|e| format!("Failed to open the playback device: {e:?}")));

    let desired_format = WaveFormat::new(32, 32, &SampleType::Float, 48000, 2, None);
    let mode = StreamMode::EventsShared { autoconvert: true, buffer_duration_hns: 200_000 };
    init_step!(audio_client
        .initialize_client(&desired_format, &Direction::Capture, &mode)
        .map_err(|e| format!("Failed to initialize desktop loopback: {e:?}")));

    let capture_client = init_step!(audio_client.get_audiocaptureclient().map_err(|e| format!("Failed to get capture client: {e:?}")));
    let event_handle = init_step!(audio_client.set_get_eventhandle().map_err(|e| format!("Failed to get event handle: {e:?}")));
    init_step!(audio_client.start_stream().map_err(|e| format!("Failed to start desktop audio capture: {e:?}")));

    let _ = ready.send(Ok(()));
    log::info!("Clip desktop audio capture started");

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
pub fn start_capture(_app: AppHandle, _state: Arc<ClipDesktopAudioState>) -> Result<(), String> {
    Err("native desktop audio capture is only supported on Windows".into())
}

#[cfg(not(windows))]
pub fn stop_capture(_state: Arc<ClipDesktopAudioState>) {}
