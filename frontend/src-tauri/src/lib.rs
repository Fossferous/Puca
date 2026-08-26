mod agent_ipc;
mod audio_capture;
mod capture_bar;
mod clip_capture;
mod clip_desktop_audio;
mod display_power;
mod display_topology;
mod device_key;
mod file_transfer;
mod hotkeys;
mod lan;
mod privacy_screen;
mod power;
mod remote_control;
mod session_events;
mod stream_boost;
mod tunnel;
mod unattended_store;
mod tunnel_pump;
mod tunnel_cmd;
#[cfg(windows)]
#[cfg(windows)]
mod lock_screen;
mod service_cmd;
#[cfg(windows)]
mod service_link;
mod wol;

use std::sync::Arc;
use tauri::Manager;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};

#[cfg(windows)]
use audio_capture::windows_audio::{AudioApp, AudioCaptureState};
use clip_capture::ClipCaptureState;
use clip_desktop_audio::ClipDesktopAudioState;

/// Async + spawn_blocking: sysinfo's process enumeration takes hundreds of ms,
/// and a sync command runs on the main thread — it froze the whole window when
/// the share dialog opened.
#[cfg(windows)]
#[tauri::command]
async fn get_running_apps() -> Vec<AudioApp> {
    tauri::async_runtime::spawn_blocking(audio_capture::windows_audio::get_running_apps)
        .await
        .unwrap_or_default()
}

/// Async + spawn_blocking: start_capture now BLOCKS until WASAPI init succeeds
/// or fails (bounded ~4 s worst case: wind-down wait + ready timeout) so
/// failures reach the JS caller — that wait must not run on the main thread.
#[cfg(windows)]
#[tauri::command]
async fn start_app_audio_capture(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, Arc<AudioCaptureState>>,
    pid: u32,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        audio_capture::windows_audio::start_capture(app_handle, pid, state)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Same blocking-init contract as `start_app_audio_capture`: this returns
/// only once DXGI duplication and the hardware encoder are actually running,
/// or with the real error — never a false "armed".
#[cfg(windows)]
#[tauri::command]
async fn start_clip_video_capture(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, Arc<ClipCaptureState>>,
    fps: u32,
    bitrate: u32,
    assumed_pixels: u64,
    gop_ms: u32,
) -> Result<clip_capture::ClipCaptureTarget, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        clip_capture::start_video_capture(app_handle, state, fps, bitrate, assumed_pixels, gop_ms)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[cfg(not(windows))]
#[tauri::command]
async fn start_clip_video_capture(fps: u32, bitrate: u32, assumed_pixels: u64, gop_ms: u32) -> Result<clip_capture::ClipCaptureTarget, String> {
    let _ = (fps, bitrate, assumed_pixels, gop_ms);
    Err("native clip capture is only supported on Windows".into())
}

#[cfg(windows)]
#[tauri::command]
fn stop_clip_video_capture(state: tauri::State<'_, Arc<ClipCaptureState>>) {
    clip_capture::stop_video_capture(state.inner().clone());
}
#[cfg(not(windows))]
#[tauri::command]
fn stop_clip_video_capture() {}

/// `device_name` (JS: `deviceName`): capture the loopback of the render
/// device whose friendly name best matches, instead of whatever the DEFAULT
/// output happens to be — the user who picked a headset in Settings hears the
/// game there, and a clip that recorded the (silent) speakers instead reads
/// as "clip audio is broken". Resolves with the friendly name actually
/// captured plus the capture GENERATION the caller now owns (see
/// clip_desktop_audio.rs — the state is a process singleton and ownership is
/// what stops a failed start's cleanup killing someone else's capture).
#[cfg(windows)]
#[tauri::command]
async fn start_clip_desktop_audio(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, Arc<ClipDesktopAudioState>>,
    device_name: Option<String>,
) -> Result<clip_desktop_audio::ClipAudioStarted, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        clip_desktop_audio::start_capture(app_handle, state, device_name)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[cfg(not(windows))]
#[tauri::command]
async fn start_clip_desktop_audio(
    _device_name: Option<String>,
) -> Result<clip_desktop_audio::ClipAudioStarted, String> {
    Err("native desktop audio capture is only supported on Windows".into())
}

/// `generation` (JS: `generation`): stop only the capture the caller owns —
/// absent means "whatever is running" (a whole-session teardown).
#[cfg(windows)]
#[tauri::command]
fn stop_clip_desktop_audio(
    state: tauri::State<'_, Arc<ClipDesktopAudioState>>,
    generation: Option<u64>,
) {
    clip_desktop_audio::stop_capture(state.inner().clone(), generation);
}
#[cfg(not(windows))]
#[tauri::command]
fn stop_clip_desktop_audio(_generation: Option<u64>) {}

// start_system_audio_capture ("all audio except Puca") is REMOVED, not
// broken: WASAPI's exclude-mode loopback only filters audio sessions created
// AFTER the client initialises, and Puca's own WebView2 render session
// always predates it (the voice call is running — that was the point of the
// mode). The voice chat therefore echoed straight back into every stream and
// no ordering on our side could prevent it. The desktop UI ships in the same
// installer as this binary, so no shipped frontend can invoke the old name;
// a stale caller would get the standard command-not-found rejection, which
// appAudio.ts already degrades to "streaming video only".

/// Capture EXACTLY the given apps' audio (multi-app mixer: one include-mode
/// process-loopback capture per pid, mixed natively into one stream). Returns
/// the pids that could not be started; Err only if nothing could be captured.
#[cfg(windows)]
#[tauri::command]
async fn start_multi_app_audio_capture(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, Arc<AudioCaptureState>>,
    pids: Vec<u32>,
) -> Result<Vec<u32>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        audio_capture::windows_audio::start_multi_capture(app_handle, pids, state)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Adjust one mixer source's volume mid-stream (linear gain, 0.0–2.0).
#[cfg(windows)]
#[tauri::command]
fn set_app_capture_gain(pid: u32, gain: f32) -> Result<(), String> {
    audio_capture::windows_audio::set_capture_gain(pid, gain)
}

#[cfg(windows)]
#[tauri::command]
fn stop_app_audio_capture(state: tauri::State<'_, Arc<AudioCaptureState>>) -> Result<(), String> {
    audio_capture::windows_audio::stop_capture(state.inner().clone());
    Ok(())
}

// Non-Windows stubs
#[cfg(not(windows))]
#[tauri::command]
fn get_running_apps() -> Vec<audio_capture::windows_audio::AudioApp> {
    vec![]
}

#[cfg(not(windows))]
#[tauri::command]
fn start_app_audio_capture() -> Result<(), String> {
    Err("Per-app audio capture is only supported on Windows".to_string())
}

#[cfg(not(windows))]
#[tauri::command]
fn start_multi_app_audio_capture(_pids: Vec<u32>) -> Result<Vec<u32>, String> {
    Err("Per-app audio capture is only supported on Windows".to_string())
}

#[cfg(not(windows))]
#[tauri::command]
fn set_app_capture_gain(_pid: u32, _gain: f32) -> Result<(), String> {
    Err("Per-app audio capture is only supported on Windows".to_string())
}

#[cfg(not(windows))]
#[tauri::command]
fn stop_app_audio_capture() -> Result<(), String> {
    Ok(())
}

/// Hide WebView2's "… is sharing a window and audio" bar (see capture_bar.rs).
/// Returns how many bar windows were hidden (0 = none found yet — caller retries).
///
/// MUST stay async + spawn_blocking: the frontend polls this every 700ms for
/// the whole share, and EnumWindows over every top-level window (plus a
/// process-name query per candidate) on the MAIN thread ran ~1.4x/s in
/// exactly the window where live control input was also being injected there.
#[tauri::command]
async fn hide_screen_capture_bar() -> u32 {
    tauri::async_runtime::spawn_blocking(capture_bar::hide_capture_bar)
        .await
        .unwrap_or(0)
}

/// Inject one remote-control input event (host side; Windows only). The
/// frontend gates this behind an approved control session — see remoteControl.ts.
///
/// Handed to a DEDICATED single worker thread, for two reasons that must both
/// hold:
/// - OFF the main thread: as a sync command this ran SendInput on the webview
///   main thread once per event, so any main-thread work (a renegotiation, the
///   capture-bar sweep) head-of-line blocked live input.
/// - ORDERED: the frontend fires these without awaiting, so ordering rests
///   entirely on this side. A threadpool (`async` + spawn_blocking) can run
///   two events out of order — a `down` overtaking the move that placed it
///   clicks the wrong thing on the host. One thread + one FIFO channel keeps
///   the order the events arrived in.
#[tauri::command]
fn inject_input(event: remote_control::ControlInput) -> Result<(), String> {
    remote_control::inject_queued(event)
}

/// This device's public identity, creating the keypair on first call.
/// The private halves stay in device_key.rs and are never returned to JS.
#[tauri::command]
fn device_key_ensure() -> Result<device_key::DevicePublicIdentity, String> {
    device_key::ensure()
}

/// Sign a transcript with the device signing key (base64 signature).
///
/// The CALLER supplies the whole message, so there is exactly one definition of
/// what a device signature covers (see attestationMessage in the client). This
/// is the only way JS can exercise the key — it can never read it.
#[tauri::command]
fn device_key_sign(message: String) -> Result<String, String> {
    device_key::sign(&message)
}

/// X25519 shared secret between this device and a peer device (base64).
///
/// Returns the SECRET, never the key: JS needs the static half to derive a
/// device-control session key, but must never hold the long-lived key. A leaked
/// shared secret costs one peer pairing; a leaked private key costs the
/// machine's identity permanently.
#[tauri::command]
fn device_key_dh(peer_pub: String) -> Result<String, String> {
    device_key::dh(&peer_pub)
}

/// Read the clipboard as text.
///
/// Native rather than `navigator.clipboard.readText()`, which needs document
/// focus and a permission grant — unreliable for a HOST running in the
/// background, which is exactly when a device session wants it.
#[tauri::command]
fn clipboard_read_text() -> Result<String, String> {
    #[cfg(windows)]
    { clipboard_win::get_clipboard_string().map_err(|e| format!("cannot read the clipboard: {e}")) }
    #[cfg(not(windows))]
    { Err("clipboard access is only implemented on Windows".to_string()) }
}

/// Write text to the clipboard.
#[tauri::command]
fn clipboard_write_text(text: String) -> Result<(), String> {
    #[cfg(windows)]
    { clipboard_win::set_clipboard_string(&text).map_err(|e| format!("cannot write the clipboard: {e}")) }
    #[cfg(not(windows))]
    { let _ = text; Err("clipboard access is only implemented on Windows".to_string()) }
}

/// Append one line to the app's own log file, from the streaming diagnostic
/// sampler (frontend/src/api/streamDiag.ts).
///
/// Why this exists: `__pucaMeshDiag()`/`__pucaVoiceDiag()` need
/// DevTools focus to read, and the "share is laggy above 60fps" bug only
/// happens while a FULLSCREEN GAME holds focus — the one moment a human
/// cannot open DevTools to look. The sampler runs unattended for the
/// duration of any watched capture and calls this instead, so the samples
/// land in the same file `log::info!` already writes in release builds
/// (%LOCALAPPDATA%\com.sovereign.chat\logs\puca.log) and are readable
/// after the fact, no focus required at the moment that matters.
#[tauri::command]
fn log_stream_diag(line: String) {
    let line: String = line.chars().filter(|c| *c != '\n' && *c != '\r').take(2000).collect();
    log::info!("[stream-diag] {line}");
}

/// Is Puca set to start with the OS?
#[tauri::command]
fn autostart_enabled(app: tauri::AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

/// Turn start-with-the-OS on or off.
///
/// Reports the error rather than swallowing it: on Windows this writes to the
/// registry, which security software does block, and a toggle that silently
/// snaps back is indistinguishable from a broken app.
#[tauri::command]
fn set_autostart(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let launcher = app.autolaunch();
    if enabled {
        launcher.enable().map_err(|e| e.to_string())
    } else {
        launcher.disable().map_err(|e| e.to_string())
    }
}

/// The tray tooltip has TWO independent writers — the device-session
/// indicator and the clip-buffer indicator — and each used to be (or would
/// have been) able to clobber the other's line with its own idle text. The
/// parts live here and every writer re-composes the whole tooltip.
#[derive(Default)]
struct TrayTipState(std::sync::Mutex<TrayTipParts>);
#[derive(Default)]
struct TrayTipParts {
    device: Option<String>,
    clip: Option<String>,
}

fn compose_tray_tip(app: &tauri::AppHandle, state: &TrayTipState) {
    use tauri::tray::TrayIconId;
    let parts = state.0.lock().unwrap();
    let tip = match (&parts.device, &parts.clip) {
        (Some(d), Some(c)) => format!("{d}\n{c}"),
        (Some(d), None) => d.clone(),
        (None, Some(c)) => c.clone(),
        (None, None) => "Puca".to_string(),
    };
    drop(parts);
    if let Some(tray) = app.tray_by_id(&TrayIconId::new("main-tray")) {
        let _ = tray.set_tooltip(Some(&tip));
    }
}

/// Reflect the armed clip replay buffer in the tray.
///
/// For a native (auto) arm this is the ONLY always-present indicator that the
/// screen is being recorded: there is no OS picker, no WebView2 sharing bar
/// (native capture never had one), and the in-panel pill is invisible behind
/// a fullscreen game — which is precisely when auto-arm runs. Same reasoning
/// as the device-session indicator above: driven by the SESSION (the
/// replayBuffer controller's armed transitions), not by whether a UI is
/// mounted.
#[tauri::command]
fn set_clip_armed_indicator(
    app: tauri::AppHandle,
    state: tauri::State<'_, TrayTipState>,
    armed: bool,
    reason: Option<String>,
) {
    state.0.lock().unwrap().clip = if armed {
        Some(match reason.as_deref() {
            Some("fullscreen") => "Puca — clip buffer armed (recording your fullscreen app)".to_string(),
            Some("primary") => "Puca — clip buffer armed (recording your primary monitor)".to_string(),
            _ => "Puca — clip buffer armed (recording your screen)".to_string(),
        })
    } else {
        None
    };
    compose_tray_tip(&app, &state);
}

/// Reflect an active device session in the tray.
///
/// This is not decoration. Autostart + `--hidden` + close-to-tray means the app
/// can be resident from boot with no window ever shown; combined with remote
/// control that is, from the outside, indistinguishable from something
/// unwanted. The tooltip is the always-available answer to "is anything
/// controlling this machine right now?" — so it must be driven by the SESSION,
/// not by whether a UI happens to be mounted.
#[tauri::command]
fn set_device_session_indicator(
    app: tauri::AppHandle,
    active: bool,
    peer: Option<String>,
    // How many connections the peer is currently forwarding THROUGH this
    // machine. Defaulted so an older frontend that omits it still works.
    #[allow(unused_variables)] forwarding: Option<usize>,
    // Whether the peer can currently reach this machine's FILES.
    //
    // Its own flag rather than folded into `active`, because a file session has
    // no picture: there is nothing on screen to notice, the consent dialog that
    // used to be the notification does not appear on an armed host, and so the
    // tray is not merely the best indicator here — it is the only one. Defaulted
    // so an older frontend that omits it still works.
    #[allow(unused_variables)] files: Option<bool>,
    state: tauri::State<'_, TrayTipState>,
) {
    state.0.lock().unwrap().device = if active {
        let browsing = files.unwrap_or(false);
        let who = match (peer, browsing) {
            (Some(name), true) => format!("Puca — {name} can read and write files on this device"),
            (Some(name), false) => format!("Puca — {name} is controlling this device"),
            (None, true) => "Puca — a device is browsing this machine's files".to_string(),
            (None, false) => "Puca — a device session is active".to_string(),
        };
        // Port forwarding is the one thing happening on a host that leaves
        // NO trace on screen: a remote party reaching services on this
        // machine looks like nothing at all. The tray is the host's only
        // always-present indicator, so if it does not say this, nothing
        // does.
        Some(match forwarding.unwrap_or(0) {
            0 => who,
            1 => format!("{who} (1 forwarded connection)"),
            n => format!("{who} ({n} forwarded connections)"),
        })
    } else {
        None
    };
    compose_tray_tip(&app, &state);
}

/// Broadcast a Wake-on-LAN magic packet. Returns how many sends succeeded —
/// which means only that packets LEFT this machine, never that the target woke.
/// Only the target reconnecting proves that.
///
/// Async + spawn_blocking: `wol::send` now enumerates network adapters to find
/// the physical card to bind to, and a sync command runs on the webview's main
/// thread (same hazard as `get_running_apps`).
#[tauri::command]
async fn wol_send(mac: String, broadcast: Option<String>) -> Result<u32, String> {
    tauri::async_runtime::spawn_blocking(move || wol::send(&mac, broadcast.as_deref()))
        .await
        .unwrap_or_else(|e| Err(format!("wake task failed: {e}")))
}

/// Discard this device's identity, so a later enrolment is genuinely a NEW
/// device rather than a resurrection of a revoked one.
#[tauri::command]
fn device_key_forget() -> Result<(), String> {
    device_key::forget()
}

/// Names of anti-cheat products currently running. The host refuses to grant
/// control while any are active (injected input is unreliable / ban-prone).
///
/// MUST stay async + spawn_blocking: this enumerates every process with paths
/// (hundreds of ms), and a SYNC Tauri command runs on the main thread — which
/// froze the whole window the moment "Allow" was clicked, so the click looked
/// ignored and users clicked again. Same hazard, same fix as get_running_apps.
#[tauri::command]
async fn list_anticheat_processes() -> Vec<String> {
    tauri::async_runtime::spawn_blocking(remote_control::detect_anticheat)
        .await
        .unwrap_or_default()
}

/// Bring the main window to the user's attention (a control request arrived).
/// The host is by definition sharing their screen — usually a fullscreen game —
/// so the prompt would otherwise be painted behind everything and a click aimed
/// at "Allow" would land on whatever app is actually in front.
///
/// Modes:
/// - `"flash"`   — taskbar flash only.
/// - `"surface"` — make the window visible ABOVE the game WITHOUT activating
///   it (SW_SHOWNOACTIVATE + TOPMOST/NOACTIVATE). The game keeps foreground,
///   keyboard focus and its cursor clip: a borderless-windowed game is NOT
///   tabbed out. Pair with `release_attention_topmost` once the prompt is
///   answered. This is the correct mode for anything triggered by an inbound
///   peer message before any consent.
/// - `"raise"`   — full unminimize/show/focus steal. Only for user-initiated
///   paths (clicking an OS notification); the always-on-top toggle exists to
///   defeat Windows' foreground lock and IS a focus steal by design.
///
/// Back-compat: callers still passing `raise: bool` (or nothing) map to
/// "raise"/"flash" as before; `mode` wins when present.
#[tauri::command]
fn attention_main_window(app: tauri::AppHandle, raise: Option<bool>, mode: Option<String>) {
    use tauri::Manager;
    let mode = mode.unwrap_or_else(|| {
        if raise.unwrap_or(true) { "raise" } else { "flash" }.to_string()
    });
    if let Some(w) = app.get_webview_window("main") {
        match mode.as_str() {
            "raise" => {
                let _ = w.unminimize();
                let _ = w.show();
                // Windows' foreground lock can refuse SetForegroundWindow outright.
                // The momentary always-on-top toggle is the standard workaround.
                let _ = w.set_always_on_top(true);
                let _ = w.set_focus();
                let _ = w.set_always_on_top(false);
            }
            "surface" => {
                #[cfg(windows)]
                {
                    use windows::Win32::Foundation::HWND;
                    use windows::Win32::UI::WindowsAndMessaging::{
                        SetWindowPos, ShowWindow, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE,
                        SWP_NOSIZE, SW_SHOWNOACTIVATE,
                    };
                    if let Ok(h) = w.hwnd() {
                        let hwnd = HWND(h.0 as _);
                        unsafe {
                            let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
                            let _ = SetWindowPos(
                                hwnd,
                                HWND_TOPMOST,
                                0,
                                0,
                                0,
                                0,
                                SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE,
                            );
                        }
                    }
                    // Native safety net: the JS release path lives in webview
                    // memory, so a reload/crash mid-prompt would leave the
                    // window permanently above every game. The consent
                    // deadline is 45s; drop TOPMOST unconditionally after 60s
                    // (a re-drop after the JS release is a harmless no-op).
                    let app2 = app.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_secs(60));
                        release_attention_topmost(app2);
                    });
                }
                #[cfg(not(windows))]
                {
                    // No no-activate primitive here; visible-but-unfocused is
                    // the best available. Unminimize like the raise path, or a
                    // minimised window stays invisible.
                    let _ = w.unminimize();
                    let _ = w.show();
                }
            }
            _ => {} // "flash": the request_user_attention below is the whole job
        }
        // Always lands, even when raising is refused or skipped.
        let _ = w.request_user_attention(Some(tauri::UserAttentionType::Critical));
    }
}

/// Undo `attention_main_window("surface")`: drop the TOPMOST bit (without
/// activating anything) once the consent prompt has been answered — allow,
/// deny, auto-deny or revoke. Leaving the window permanently above the game
/// would be its own bug.
#[tauri::command]
fn release_attention_topmost(app: tauri::AppHandle) {
    use tauri::Manager;
    if let Some(w) = app.get_webview_window("main") {
        #[cfg(windows)]
        {
            use windows::Win32::Foundation::HWND;
            use windows::Win32::UI::WindowsAndMessaging::{
                SetWindowPos, HWND_NOTOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
            };
            if let Ok(h) = w.hwnd() {
                unsafe {
                    let _ = SetWindowPos(
                        HWND(h.0 as _),
                        HWND_NOTOPMOST,
                        0,
                        0,
                        0,
                        0,
                        SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE,
                    );
                }
            }
        }
        #[cfg(not(windows))]
        {
            let _ = w.set_always_on_top(false);
        }
    }
}

/// Start the host-side kill switch. The custom hotkey (`kill_vk` + `kill_mods`
/// bitmask 1=Ctrl 2=Alt 4=Shift) always revokes, even while a controlled game
/// has focus, via a one-shot `host-killswitch-hotkey` event. When `any_input`
/// is true, ANY real host mouse/keyboard input also revokes (one-shot
/// `host-input-detected`).
#[tauri::command]
fn start_control_guard(app: tauri::AppHandle, any_input: bool, kill_vk: u32, kill_mods: u32) {
    remote_control::start_guard(app, any_input, kill_vk, kill_mods);
}

/// Stop the physical-input kill switch.
#[tauri::command]
fn stop_control_guard() {
    remote_control::stop_guard();
}

/// Start the global hotkey listener: emits a `global-hotkey` event per key
/// TRANSITION of any watched virtual-key (with live modifier state), so
/// push-to-talk and the voice shortcuts work while a game has focus. `keys`
/// is the currently-bound VK codes — nothing else is ever forwarded, and OS
/// auto-repeat is collapsed on the Rust side. Calling again just swaps the
/// watch list (rebinds apply live).
/// Returns TRUE only when a hook is really watching — the frontend disables
/// its own stuck-key safety net based on this, so it must not be optimistic.
#[tauri::command]
fn start_hotkey_listener(app: tauri::AppHandle, keys: Vec<u32>) -> bool {
    hotkeys::start(app, keys)
}

/// Stop the global hotkey listener (leaving a voice call).
#[tauri::command]
fn stop_hotkey_listener() {
    hotkeys::stop();
}

/// Enumerate monitors + the virtual desktop so the host can map the shared
/// surface onto the right screen (multi-monitor / negative coordinates).
#[tauri::command]
fn list_monitors() -> remote_control::MonitorList {
    remote_control::list_monitors()
}

/// Set which monitor the injected absolute moves map onto (None = primary).
#[tauri::command]
fn set_control_monitor(target: Option<remote_control::TargetMonitor>) {
    remote_control::set_target(target);
}

/// Release every key/button currently held (called on any control teardown).
/// Ordered behind the injection queue, so a queued `down` cannot re-stick a
/// key after this reports done.
#[tauri::command]
fn release_control_input() {
    remote_control::release_all_ordered();
}

/// Open an external URL in the system browser / default handler (update
/// prompt, chat message links). Scheme-ALLOWLISTED so the webview can never
/// launch arbitrary programs (file:, javascript:, UNC paths, custom schemes).
/// http/https/mailto mirrors the chat parser's SAFE_URL_SCHEMES minus the
/// internal sovereign-enc scheme, which never reaches an anchor.
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    let lower = url.to_ascii_lowercase();
    let allowed = lower.starts_with("https://")
        || lower.starts_with("http://")
        || lower.starts_with("mailto:");
    if !allowed {
        return Err("Only http(s) and mailto URLs can be opened".to_string());
    }
    opener::open(&url).map_err(|e| e.to_string())
}

/// Runtime-generated red disc (RGBA) for the unread badge — no asset files.
/// A plain filled disc with a ~1px soft edge: Windows renders taskbar
/// overlays at ~16px, where any glyph or count would be unreadable.
fn red_dot_rgba(size: u32) -> Vec<u8> {
    let mut buf = vec![0u8; (size * size * 4) as usize];
    let c = (size as f32 - 1.0) / 2.0;
    let r = size as f32 * 0.42;
    for y in 0..size {
        for x in 0..size {
            let dx = x as f32 - c;
            let dy = y as f32 - c;
            let a = ((r - (dx * dx + dy * dy).sqrt() + 0.5).clamp(0.0, 1.0) * 255.0) as u8;
            if a > 0 {
                let i = ((y * size + x) * 4) as usize;
                buf[i] = 0xF0;
                buf[i + 1] = 0x3E;
                buf[i + 2] = 0x3E;
                buf[i + 3] = a;
            }
        }
    }
    buf
}

/// The app icon with the red unread dot composed into the bottom-right
/// corner — used as the tray icon while there are unread messages.
fn badged_tray_icon(app: &tauri::AppHandle) -> Option<tauri::image::Image<'static>> {
    let base = app.default_window_icon()?;
    let (w, h) = (base.width(), base.height());
    // A base icon smaller than the minimum dot would underflow the offset
    // math below (w - dot on u32). No badge beats a panic.
    if w.min(h) < 8 {
        return None;
    }
    let mut rgba = base.rgba().to_vec();
    let dot = (w.min(h) / 2).max(8); // must stay legible at the 16px tray size
    let dot_rgba = red_dot_rgba(dot);
    let (ox, oy) = (w - dot, h - dot);
    for y in 0..dot {
        for x in 0..dot {
            let si = ((y * dot + x) * 4) as usize;
            let a = dot_rgba[si + 3] as u32;
            if a == 0 {
                continue;
            }
            let di = (((oy + y) * w + (ox + x)) * 4) as usize;
            // Source-over blend so the disc's soft edge composes cleanly.
            for ch in 0..3 {
                let s = dot_rgba[si + ch] as u32;
                let d = rgba[di + ch] as u32;
                rgba[di + ch] = ((s * a + d * (255 - a)) / 255) as u8;
            }
            rgba[di + 3] = rgba[di + 3].max(dot_rgba[si + 3]);
        }
    }
    Some(tauri::image::Image::new_owned(rgba, w, h))
}

/// Show/clear the unread indicator: a red-dot overlay on the Windows taskbar
/// button plus a badged tray icon. The frontend latches it on when a
/// notification-worthy message arrives while the window is unfocused, and
/// clears it on focus. All calls are best-effort — a missing window/tray
/// (shutdown races) must never error into the webview.
#[tauri::command]
fn set_unread_badge(app: tauri::AppHandle, unread: bool) {
    #[cfg(windows)]
    if let Some(w) = app.get_webview_window("main") {
        let overlay = if unread {
            Some(tauri::image::Image::new_owned(red_dot_rgba(32), 32, 32))
        } else {
            None
        };
        let _ = w.set_overlay_icon(overlay);
    }
    if let Some(tray) = app.tray_by_id("main-tray") {
        let icon = if unread {
            badged_tray_icon(&app)
        } else {
            app.default_window_icon().cloned()
        };
        let _ = tray.set_icon(icon);
    }
}

/// Seconds since the last SYSTEM-WIDE keyboard/mouse input (GetLastInputInfo).
/// Presence probe for the AFK auto-mover: someone deep in a game generates
/// constant input the app can never see as speech — they must not be moved.
/// This is a single idle-duration number, not an input hook; nothing about
/// WHAT was pressed is available.
///
/// Returns idle SECONDS, or **-1 for "no probe on this platform"**. The two
/// are deliberately distinct: 0 means "input just now, definitely present",
/// while -1 tells the client it has no presence signal at all so it should
/// fall back to the plain inactivity timer. Returning 0 in both cases (the
/// first cut) meant any non-Windows desktop build read as permanently active
/// and AFK auto-move silently never fired there.
///
/// A probe FAILURE on Windows still reports 0/"active" — wrongly moving a
/// present user is the worse outcome, and a failing API is not the same as an
/// absent one.
#[tauri::command]
fn get_idle_seconds() -> i64 {
    #[cfg(windows)]
    unsafe {
        use windows::Win32::System::SystemInformation::GetTickCount;
        use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
        let mut lii = LASTINPUTINFO {
            cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };
        if GetLastInputInfo(&mut lii).as_bool() {
            // Tick counts wrap every ~49.7 days; wrapping_sub stays correct
            // across the wrap.
            return (GetTickCount().wrapping_sub(lii.dwTime) / 1000) as i64;
        }
        return 0; // API failed — assume present.
    }
    #[cfg(not(windows))]
    -1 // no system idle probe here; caller uses the timer alone
}

#[tauri::command]
fn clear_webview_permissions() -> Result<String, String> {
    // WebView2 files are locked while running, so we schedule deletion for next startup
    #[cfg(windows)]
    {
        if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
            let app_data = std::path::Path::new(&local_app_data).join("com.sovereign.chat");
            let marker_file = app_data.join(".clear_permissions_on_start");

            // Create marker file to signal cleanup on next startup
            if let Err(e) = std::fs::create_dir_all(&app_data) {
                return Err(format!("Failed to create app data dir: {}", e));
            }

            if let Err(e) = std::fs::write(&marker_file, "1") {
                return Err(format!("Failed to create marker file: {}", e));
            }

            return Ok("Permissions will be reset on restart. The app will now close.".to_string());
        }
        Err("Could not find LOCALAPPDATA".to_string())
    }

    #[cfg(not(windows))]
    {
        Ok("Permission reset not needed on this platform".to_string())
    }
}

/// Check and clear WebView2 data on startup if marker file exists
fn check_and_clear_permissions_on_startup() {
    #[cfg(windows)]
    {
        if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
            let app_data = std::path::Path::new(&local_app_data).join("com.sovereign.chat");
            let marker_file = app_data.join(".clear_permissions_on_start");
            let webview_path = app_data.join("EBWebView");

            if marker_file.exists() {
                // Remove marker file first
                let _ = std::fs::remove_file(&marker_file);

                // Clear WebView2 data
                if webview_path.exists() {
                    if let Err(e) = std::fs::remove_dir_all(&webview_path) {
                        eprintln!("Failed to clear WebView data on startup: {}", e);
                    } else {
                        println!("WebView permissions cleared successfully on startup");
                    }
                }
            }
        }
    }
}

/// Whether closing the window hides to the tray instead of exiting.
///
/// Default ON, because that is what makes notifications arrive after you close
/// the window — the whole point of the tray. The frontend flips it from
/// Settings via `set_close_to_tray`, and a real Quit is always available from
/// the tray menu, so this can never trap someone in an unquittable app.
static CLOSE_TO_TRAY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);

#[tauri::command]
fn set_close_to_tray(enabled: bool) {
    CLOSE_TO_TRAY.store(enabled, std::sync::atomic::Ordering::Relaxed);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// Bring the main window forward. Needed in two places that cannot share a
/// closure: the tray, and the single-instance callback (which fires before
/// `setup` has run).
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// Launched by the OS (or with `--hidden`)? Then start in the tray instead of
/// popping a window on every boot — the thing that makes people turn autostart
/// straight back off.
fn started_hidden() -> bool {
    std::env::args().any(|a| a == "--hidden")
}

pub fn run() {
    // Check for scheduled permission reset BEFORE WebView2 initializes
    check_and_clear_permissions_on_startup();

    tauri::Builder::default()
        // FIRST, before every other plugin — that is this plugin's documented
        // requirement, and the failure mode without it is silent (see the
        // Cargo.toml note on WebView2's user-data lock).
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // A second launch should surface the window that already exists
            // rather than doing nothing. Without this, clicking the shortcut
            // while the app sits hidden in the tray looks like a broken app.
            show_main_window(app);
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            // Launched by the OS => start in the tray. A window appearing on
            // every boot is what makes people disable autostart.
            Some(vec!["--hidden"]),
        ))
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if CLOSE_TO_TRAY.load(std::sync::atomic::Ordering::Relaxed) {
                    // Hide, don't exit. The WebSocket stays connected, so
                    // MessageNotification keeps arriving and the OS keeps
                    // showing notifications. Quit from the tray menu really
                    // does exit.
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(|app| {
            #[cfg(windows)]
            app.manage(Arc::new(AudioCaptureState::default()));
            app.manage(TrayTipState::default());
            #[cfg(windows)]
            app.manage(Arc::new(ClipCaptureState::default()));
            #[cfg(windows)]
            app.manage(Arc::new(ClipDesktopAudioState::default()));
            app.manage(Arc::new(display_power::DisplayPower::default()));
            let topology = Arc::new(display_topology::DisplayTopology::default());
            app.manage(topology.clone());
            // A leftover detach marker means the last run died mid-detach:
            // put the displays back before anything else runs. Off-thread —
            // SetDisplayConfig can block, and this is the webview's setup.
            std::thread::Builder::new()
                .name("display-topology-startup".into())
                .spawn(move || topology.restore_if_marked())
                .ok();

            // Suspend / session-lock feed (session_events.rs): lets in-memory
            // features such as the clip replay buffer wipe themselves before a
            // hibernation writes RAM to disk. Best effort; the app is fine without it.
            session_events::windows_impl::start(app.handle().clone());

            // Tray icon. This is what makes a notification possible at all when
            // the window is closed: until now `close` ended the process, so
            // there was no socket, no MessageNotification, and nothing for the
            // OS to show. Hiding to the tray keeps the existing WebSocket alive,
            // which means desktop notifications need NO push service, no FCM,
            // no APNs and no third party — only the app still being here.
            let open_item = MenuItem::with_id(app, "open", "Open Puca", true, None::<&str>)?;
            // THE KILL SWITCH for file access, and it belongs here rather than in
            // the window.
            //
            // An armed host grants files without a dialog, and a file-only
            // session shows no picture — so the person at this machine may have
            // no window open and nothing on screen to click. The tray is the only
            // surface guaranteed to be present, which makes it the only place a
            // revoke can actually live. Always enabled: a menu item that greys
            // itself out would leak whether a grant is currently live to anyone
            // who can see the menu, and revoking nothing costs nothing.
            let stop_files_item =
                MenuItem::with_id(app, "stop-files", "Stop file access", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&open_item, &stop_files_item, &quit_item])?;

            let show_main = show_main_window;

            // Honour --hidden. The window is created visible (so an ordinary
            // launch has no flash), and only an OS-started instance hides it.
            if started_hidden() {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }

            TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().cloned().ok_or("no window icon")?)
                .tooltip("Puca")
                .menu(&tray_menu)
                // Left-click should restore, not open the menu — the menu is
                // right-click, which is what people expect on Windows.
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "open" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.unminimize();
                            let _ = w.set_focus();
                        }
                    }
                    // Revoke every file grant this machine is currently handing
                    // out. Done by asking the frontend rather than the agent
                    // directly: the frontend owns the session list, and the
                    // agent takes a session id per grant. It re-reads the scope
                    // on every request, so this takes effect on the next one
                    // with no reconnect.
                    "stop-files" => {
                        use tauri::Emitter;
                        let _ = app.emit("sovereign://revoke-file-access", ());
                    }
                    // The ONLY way to actually exit once close-to-tray is on.
                    // Without this the app would be unquittable from the UI,
                    // which is worse than not having a tray at all.
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(move |tray, event| {
                    match event {
                        TrayIconEvent::Click { button: tauri::tray::MouseButton::Left, button_state: tauri::tray::MouseButtonState::Up, .. } => {
                            show_main(tray.app_handle());
                        }
                        // INSTRUMENTATION for the "right-clicking the tray
                        // freezes the remote mouse" report: the context menu
                        // that follows this event pumps a modal message loop
                        // on the MAIN thread, which also dispatches every
                        // Tauri invoke (including input injection). This
                        // stamp brackets the stall window in the log; pair it
                        // with the host webview's [inject-slow] lines.
                        TrayIconEvent::Click { button: tauri::tray::MouseButton::Right, button_state: tauri::tray::MouseButtonState::Up, .. } => {
                            agent_ipc::agent_log(
                                "[tray] context menu opening - main thread blocks until dismissed".into(),
                            );
                        }
                        _ => {}
                    }
                })
                .build(app)?;

            // Open partial files for in-flight peer-to-peer transfers.
            app.manage(file_transfer::TransferFiles::default());
            app.manage(tunnel_cmd::Tunnels::default());
            app.manage(unattended_store::UaGateState::default());

            // Logger: debug builds log to stdout + the webview console; release
            // builds log to a FILE only (no console spam) so field diagnostics
            // like get_running_apps' session enumeration are actually
            // recoverable. Previously the whole plugin was debug-only, so every
            // log::info!/warn! vanished in the installed app and users asked to
            // check for a diagnostic line correctly saw nothing.
            {
                use tauri_plugin_log::{Target, TargetKind, TimezoneStrategy};
                // Local-time stamps: users read this log to correlate with what
                // they just did; UTC lines an hour off caused real confusion.
                let builder = tauri_plugin_log::Builder::default()
                    .level(log::LevelFilter::Info)
                    .timezone_strategy(TimezoneStrategy::UseLocal);
                let builder = if cfg!(debug_assertions) {
                    builder
                        .target(Target::new(TargetKind::Stdout))
                        .target(Target::new(TargetKind::Webview))
                } else {
                    // Release: file only. Lands in the OS log dir for this app —
                    // on Windows: %LOCALAPPDATA%\com.sovereign.chat\logs\puca.log
                    builder
                        .clear_targets()
                        .target(Target::new(TargetKind::LogDir {
                            file_name: Some("puca".into()),
                        }))
                };
                app.handle().plugin(builder.build())?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            #[cfg(windows)]
            service_cmd::service_state,
            #[cfg(windows)]
            lock_screen::lock_screen_state,
            #[cfg(windows)]
            lock_screen::lock_screen_begin_enrol,
            #[cfg(windows)]
            lock_screen::lock_screen_finish_enrol,
            #[cfg(windows)]
            lock_screen::lock_screen_arm,
            #[cfg(windows)]
            lock_screen::lock_screen_disarm,
            #[cfg(windows)]
            lock_screen::lock_screen_unenrol,
            #[cfg(windows)]
            service_cmd::service_enable,
            #[cfg(windows)]
            service_cmd::service_disable,
            service_cmd::service_update,
            service_cmd::service_bundled_fingerprint,
            set_close_to_tray,
            get_running_apps,
            start_app_audio_capture,
            start_multi_app_audio_capture,
            set_app_capture_gain,
            stop_app_audio_capture,
            hide_screen_capture_bar,
            start_clip_video_capture,
            stop_clip_video_capture,
            start_clip_desktop_audio,
            stop_clip_desktop_audio,
            inject_input,
            device_key_ensure,
            device_key_sign,
            device_key_dh,
            device_key_forget,
            wol_send,
            lan::lan_info,
            tunnel_cmd::tunnel_arm_host,
            tunnel_cmd::tunnel_open_listener,
            tunnel_cmd::tunnel_inbound,
            tunnel_cmd::tunnel_status,
            tunnel_cmd::tunnel_close,
            tunnel_cmd::tunnel_policy_get,
            tunnel_cmd::tunnel_policy_set,
            unattended_store::unattended_state,
            unattended_store::unattended_arm,
            unattended_store::unattended_disarm,
            unattended_store::unattended_challenge,
            unattended_store::unattended_verify,
            privacy_screen::privacy_screen_engage,
            privacy_screen::privacy_screen_release,
            privacy_screen::privacy_screen_supported,
            privacy_screen::privacy_screen_lock_would_blind,
            power::power_action,
            power::display_power_session_end,
            stream_boost::set_stream_boost,
            log_stream_diag,
            agent_ipc::agent_probe,
            agent_ipc::agent_diagnose,
            agent_ipc::agent_log,
            agent_ipc::agent_request,
            agent_ipc::agent_stop,
            clipboard_read_text,
            clipboard_write_text,
            autostart_enabled,
            set_autostart,
            set_device_session_indicator,
            set_clip_armed_indicator,
            list_anticheat_processes,
            attention_main_window,
            release_attention_topmost,
            start_control_guard,
            stop_control_guard,
            start_hotkey_listener,
            stop_hotkey_listener,
            list_monitors,
            set_control_monitor,
            release_control_input,
            open_external,
            set_unread_badge,
            get_idle_seconds,
            clear_webview_permissions,
            file_transfer::transfer_begin,
            file_transfer::transfer_write,
            file_transfer::transfer_finish,
            file_transfer::transfer_abort,
            file_transfer::attachment_save,
            file_transfer::shareable_folders,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|handle, event| {
            // On exit, release any keys/buttons a control session left held so a
            // crash/quit mid-control can't strand input down in the target app.
            if let tauri::RunEvent::Exit = event {
                remote_control::release_all_ordered();
                // The agent holds a screen capture and can inject input; it must
                // not outlive the app that authorises it.
                agent_ipc::agent_stop();
                // Forwarded ports must not outlive the app either: an orphaned
                // listener is a route into this machine's network with nothing
                // left to authorise it.
                if let Some(tunnels) = handle.try_state::<tunnel_cmd::Tunnels>() {
                    tunnel_cmd::close_all(&tunnels);
                }
            }
        });
}
