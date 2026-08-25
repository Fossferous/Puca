// Per-application audio capture using Windows WASAPI
// Only compiled on Windows targets

/// Walk `parent_of` upward from `pid` and report whether `root` appears in the
/// ancestry chain (including `pid == root` itself). Bounded and cycle-safe.
///
/// Used to keep Puca's OWN process tree out of the capturable-apps list
/// and to refuse include-mode capture of ourselves: WebView2 reports generic
/// surface labels instead of window titles, which defeats title matching, and
/// the "last app" fallback could then resolve to Puca — so "game only"
/// captured Puca's own audio output (voice chat + notification sounds)
/// instead of the game. Platform-agnostic (pure std) so it stays testable with
/// plain `cargo test` — note this crate is NOT in the CI test matrix (only the
/// server crate is), so these tests run on local Windows builds.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn pid_in_tree(
    parent_of: &std::collections::HashMap<u32, u32>,
    mut pid: u32,
    root: u32,
) -> bool {
    for _ in 0..64 {
        if pid == root {
            return true;
        }
        match parent_of.get(&pid) {
            Some(&parent) if parent != 0 && parent != pid => pid = parent,
            _ => return false,
        }
    }
    false // depth bound hit (or a longer cycle) — treat as not in tree
}

/// Given the pids that own ACTIVE audio render sessions, mark each of them AND
/// every ancestor in `parent_of` (bounded, cycle-safe). Games and browsers
/// often play audio from a CHILD process (engine subprocess, audio-service
/// utility) while the window the user recognizes belongs to the PARENT exe —
/// marking the whole chain lets the windowed parent carry the
/// "currently playing audio" flag that auto-detect keys on.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn mark_ancestry(
    parent_of: &std::collections::HashMap<u32, u32>,
    session_pids: &[u32],
) -> std::collections::HashSet<u32> {
    let mut marked = std::collections::HashSet::new();
    for &start in session_pids {
        let mut pid = start;
        for _ in 0..64 {
            if !marked.insert(pid) {
                break; // chain already walked from here (also breaks cycles)
            }
            match parent_of.get(&pid) {
                Some(&parent) if parent != 0 && parent != pid => pid = parent,
                _ => break,
            }
        }
    }
    marked
}

/// Accumulate gain-scaled samples from `src` into `out`, index-aligned.
/// The multi-app mixer sums every selected source through this.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn accumulate_into(out: &mut [f32], src: &[f32], gain: f32) {
    for (o, s) in out.iter_mut().zip(src.iter()) {
        *o += s * gain;
    }
}

/// Hard-clamp a mixed buffer to the valid [-1, 1] sample range. Summing
/// several loud sources can exceed full scale; clamping keeps the payload
/// valid PCM (mild distortion only at the extremes — acceptable for v1).
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn clamp_samples(out: &mut [f32]) {
    for v in out.iter_mut() {
        *v = v.clamp(-1.0, 1.0);
    }
}

#[cfg(test)]
mod mix_tests {
    use super::{accumulate_into, clamp_samples};

    #[test]
    fn accumulates_with_gain() {
        let mut out = vec![0.1f32, 0.2, 0.3];
        accumulate_into(&mut out, &[0.5, 0.5, 0.5], 0.5);
        assert!((out[0] - 0.35).abs() < 1e-6);
        assert!((out[1] - 0.45).abs() < 1e-6);
        assert!((out[2] - 0.55).abs() < 1e-6);
    }

    #[test]
    fn sums_multiple_sources_and_handles_short_src() {
        let mut out = vec![0.0f32; 4];
        accumulate_into(&mut out, &[0.25, 0.25, 0.25, 0.25], 1.0);
        accumulate_into(&mut out, &[0.25, 0.25], 2.0); // shorter source: only first 2 slots
        assert_eq!(out, vec![0.75, 0.75, 0.25, 0.25]);
    }

    #[test]
    fn clamps_over_full_scale() {
        let mut out = vec![1.7f32, -2.3, 0.5];
        clamp_samples(&mut out);
        assert_eq!(out, vec![1.0, -1.0, 0.5]);
    }

    #[test]
    fn zero_gain_mutes_a_source() {
        let mut out = vec![0.4f32; 2];
        accumulate_into(&mut out, &[0.9, 0.9], 0.0);
        assert_eq!(out, vec![0.4, 0.4]);
    }
}

#[cfg(test)]
mod mark_ancestry_tests {
    use super::mark_ancestry;
    use std::collections::HashMap;

    fn map(pairs: &[(u32, u32)]) -> HashMap<u32, u32> {
        pairs.iter().copied().collect()
    }

    #[test]
    fn marks_session_owner_and_all_ancestors() {
        // audio session owned by 300; 300 -> 200 -> 100
        let m = map(&[(300, 200), (200, 100)]);
        let marked = mark_ancestry(&m, &[300]);
        assert!(marked.contains(&300) && marked.contains(&200) && marked.contains(&100));
        assert_eq!(marked.len(), 3);
    }

    #[test]
    fn merges_chains_and_survives_cycles() {
        let m = map(&[(300, 200), (200, 100), (700, 800), (800, 700)]);
        let marked = mark_ancestry(&m, &[300, 700]);
        assert!(marked.contains(&100)); // shared walk still completes
        assert!(marked.contains(&700) && marked.contains(&800)); // cycle marked, no hang
        assert!(!marked.contains(&999));
    }

    #[test]
    fn empty_sessions_mark_nothing() {
        let m = map(&[(300, 200)]);
        assert!(mark_ancestry(&m, &[]).is_empty());
    }
}

#[cfg(test)]
mod pid_tree_tests {
    use super::pid_in_tree;
    use std::collections::HashMap;

    fn map(pairs: &[(u32, u32)]) -> HashMap<u32, u32> {
        pairs.iter().copied().collect()
    }

    #[test]
    fn detects_self_and_descendants() {
        // 300 -> 200 -> 100 (root)
        let m = map(&[(300, 200), (200, 100)]);
        assert!(pid_in_tree(&m, 100, 100)); // the root itself
        assert!(pid_in_tree(&m, 200, 100)); // direct child
        assert!(pid_in_tree(&m, 300, 100)); // grandchild
    }

    #[test]
    fn rejects_unrelated_processes() {
        let m = map(&[(300, 200), (200, 100), (555, 444)]);
        assert!(!pid_in_tree(&m, 555, 100)); // different tree
        assert!(!pid_in_tree(&m, 444, 100)); // orphan root of another tree
    }

    #[test]
    fn survives_missing_parents_and_cycles() {
        // 300's parent is unknown; 700 <-> 800 is a cycle.
        let m = map(&[(700, 800), (800, 700)]);
        assert!(!pid_in_tree(&m, 300, 100));
        assert!(!pid_in_tree(&m, 700, 100)); // bounded walk exits the cycle
    }
}

#[cfg(windows)]
pub mod windows_audio {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use serde::{Deserialize, Serialize};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use sysinfo::System;
    use tauri::{AppHandle, Emitter};
    use wasapi::{AudioClient, DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat};

    /// Represents a running application that can be captured
    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct AudioApp {
        pub pid: u32,
        pub name: String,
        pub window_title: Option<String>,
        /// This app's process tree owns an ACTIVE audio render session right
        /// now — the strongest auto-detect signal we have. WebView2 reports
        /// generic surface labels instead of window titles, so title matching
        /// usually fails; "the one non-Puca app currently making sound"
        /// is almost always the game being streamed.
        #[serde(default)]
        pub has_active_audio: bool,
        pub icon: Option<String>,
    }

    /// Audio capture state
    pub struct AudioCaptureState {
        pub is_capturing: AtomicBool,
        pub stop_signal: AtomicBool,
    }

    impl Default for AudioCaptureState {
        fn default() -> Self {
            Self {
                is_capturing: AtomicBool::new(false),
                stop_signal: AtomicBool::new(false),
            }
        }
    }

    fn get_app_icon_base64(exe_path: &std::path::Path) -> Option<String> {
        use std::os::windows::ffi::OsStrExt;
        use windows::core::PCWSTR;
        use windows::Win32::Graphics::Gdi::{
            CreateCompatibleDC, DeleteDC, DeleteObject, BITMAPINFO,
            BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, RGBQUAD, GetDIBits, GetObjectW, BITMAP,
        };
        use windows::Win32::UI::Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON};
        use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, ICONINFO};

        let wide_path: Vec<u16> = exe_path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        let mut shfi = SHFILEINFOW::default();
        
        let res = unsafe {
            SHGetFileInfoW(
                PCWSTR(wide_path.as_ptr()),
                windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES(0),
                Some(&mut shfi),
                std::mem::size_of::<SHFILEINFOW>() as u32,
                SHGFI_ICON | SHGFI_LARGEICON,
            )
        };
        
        if res == 0 || shfi.hIcon.is_invalid() {
            return None;
        }

        let hicon = shfi.hIcon;
        let mut icon_info = ICONINFO::default();
        
        unsafe {
            if GetIconInfo(hicon, &mut icon_info).is_err() {
                let _ = DestroyIcon(hicon);
                return None;
            }
        }

        let hdc = unsafe { CreateCompatibleDC(None) };
        
        let mut bmp_info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: 0,
                biHeight: 0,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                biSizeImage: 0,
                biXPelsPerMeter: 0,
                biYPelsPerMeter: 0,
                biClrUsed: 0,
                biClrImportant: 0,
            },
            bmiColors: [RGBQUAD { rgbBlue: 0, rgbGreen: 0, rgbRed: 0, rgbReserved: 0 }; 1],
        };

        let mut bitmap = BITMAP::default();
        unsafe {
            GetObjectW(
                icon_info.hbmColor,
                std::mem::size_of::<BITMAP>() as i32,
                Some(&mut bitmap as *mut _ as *mut core::ffi::c_void),
            );
        }
        
        let width = bitmap.bmWidth;
        let height = bitmap.bmHeight;
        
        if width == 0 || height == 0 {
            unsafe {
                let _ = DeleteObject(icon_info.hbmColor);
                let _ = DeleteObject(icon_info.hbmMask);
                let _ = DeleteDC(hdc);
                let _ = DestroyIcon(hicon);
            }
            return None;
        }

        bmp_info.bmiHeader.biWidth = width;
        bmp_info.bmiHeader.biHeight = -height; // Top-down
        
        let pixel_count = (width * height) as usize;
        let mut color_pixels = vec![0u32; pixel_count];
        let mut mask_pixels = vec![0u32; pixel_count];

        unsafe {
            // Get color bits
            GetDIBits(
                hdc,
                icon_info.hbmColor,
                0,
                height as u32,
                Some(color_pixels.as_mut_ptr() as *mut _),
                &mut bmp_info,
                DIB_RGB_COLORS,
            );
            
            // Get mask bits
            GetDIBits(
                hdc,
                icon_info.hbmMask,
                0,
                height as u32,
                Some(mask_pixels.as_mut_ptr() as *mut _),
                &mut bmp_info,
                DIB_RGB_COLORS,
            );
            
            let _ = DeleteObject(icon_info.hbmColor);
            let _ = DeleteObject(icon_info.hbmMask);
            let _ = DeleteDC(hdc);
            let _ = DestroyIcon(hicon);
        }

        // Check if color_pixels has an alpha channel (any pixel with alpha > 0)
        let has_alpha = color_pixels.iter().any(|&p| (p >> 24) > 0);

        let mut rgba = vec![0u8; pixel_count * 4];
        
        for (i, (&color, &mask)) in color_pixels.iter().zip(mask_pixels.iter()).enumerate() {
            let b = (color & 0xFF) as u8;
            let g = ((color >> 8) & 0xFF) as u8;
            let r = ((color >> 16) & 0xFF) as u8;
            let mut a = ((color >> 24) & 0xFF) as u8;

            if !has_alpha {
                // Reconstruct alpha from mask: black mask (0) = opaque, white mask (!=0) = transparent
                a = if mask == 0 { 255 } else { 0 };
            }

            rgba[i * 4] = r;
            rgba[i * 4 + 1] = g;
            rgba[i * 4 + 2] = b;
            rgba[i * 4 + 3] = a;
        }

        let mut png_data = Vec::new();
        let encoder = image::codecs::png::PngEncoder::new(&mut png_data);
        use image::ImageEncoder;
        if encoder.write_image(&rgba, width as u32, height as u32, image::ColorType::Rgba8).is_err() {
            return None;
        }

        use base64::Engine;
        Some(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(&png_data)))
    }

    /// Get list of running applications that may have audio.
    /// Only refresh the process list — `System::new_all()` also enumerates
    /// disks/network/CPU and took long enough to visibly stall the share dialog.
    /// Window titles are attached so the frontend can auto-match the app the
    /// user picked in the OS share dialog (the video track's label is the
    /// shared window's title).
    pub fn get_running_apps() -> Vec<AudioApp> {
        let mut sys = System::new();
        // Exe path, name and parent are all this function reads; the default
        // refresh also queries memory/CPU/disk counters per process — an
        // OpenProcess plus three kernel queries each, all thrown away.
        sys.refresh_processes_specifics(
            sysinfo::ProcessesToUpdate::All,
            true,
            sysinfo::ProcessRefreshKind::new().with_exe(sysinfo::UpdateKind::OnlyIfNotSet),
        );
        let titles = window_titles_by_pid();

        // Puca's own process tree (this exe + its WebView2 children) must
        // never be a capture candidate: capturing the app's own voice-chat
        // output echoes the call back at the viewers — and with WebView2's
        // generic surface labels defeating window-title matching, listing
        // ourselves let the "last app" fallback resolve to Puca, so
        // "game only" streamed Puca's audio.
        let own_pid = std::process::id();
        let parent_of: std::collections::HashMap<u32, u32> = sys
            .processes()
            .iter()
            .filter_map(|(pid, p)| p.parent().map(|pp| (pid.as_u32(), pp.as_u32())))
            .collect();

        // Which process trees are making sound RIGHT NOW (best-effort — an
        // enumeration failure just means every flag is false and auto-detect
        // falls back to its older heuristics).
        let audible = super::mark_ancestry(&parent_of, &active_audio_session_pids());

        let mut apps: Vec<AudioApp> = Vec::new();

        // FIRST PASS: names only. Icon extraction is the dominant per-item
        // cost — a shell + GDI + PNG round trip per process — and running it
        // before the dedup meant every Chrome/Electron helper paid it for a
        // row the dedup then threw away. Names first, dedup, icons last.
        for (pid, process) in sys.processes() {
            let name = process.name().to_string_lossy().to_string();

            if super::pid_in_tree(&parent_of, pid.as_u32(), own_pid) {
                continue;
            }

            // Filter to likely audio-producing apps
            // Skip system processes
            if name.ends_with(".exe") && !is_system_process(&name) {
                apps.push(AudioApp {
                    pid: pid.as_u32(),
                    name: name.trim_end_matches(".exe").to_string(),
                    window_title: titles.get(&pid.as_u32()).cloned(),
                    has_active_audio: audible.contains(&pid.as_u32()),
                    icon: None,
                });
            }
        }

        // Windowed apps first (games have windows), then by name.
        apps.sort_by(|a, b| {
            b.window_title.is_some()
                .cmp(&a.window_title.is_some())
                .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });

        // Remove duplicates (same name), keeping the windowed entry.
        let mut seen = std::collections::HashSet::new();
        apps.retain(|a| seen.insert(a.name.to_lowercase()));

        // SECOND PASS: icons, survivors only, through the session cache.
        for app in &mut apps {
            app.icon = sys
                .process(sysinfo::Pid::from_u32(app.pid))
                .and_then(|p| p.exe())
                .and_then(cached_app_icon);
        }

        apps
    }

    /// Process-lifetime icon cache, NEGATIVE results included: an exe's icon
    /// does not change while it runs, and a miss costs the full shell + GDI +
    /// PNG round trip. Capped, cleared on overflow, so a machine churning
    /// through processes cannot grow it without bound.
    fn cached_app_icon(path: &std::path::Path) -> Option<String> {
        static ICON_CACHE: std::sync::OnceLock<
            std::sync::Mutex<std::collections::HashMap<std::path::PathBuf, Option<String>>>,
        > = std::sync::OnceLock::new();
        let cache = ICON_CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()));
        let Ok(mut map) = cache.lock() else {
            return get_app_icon_base64(path);
        };
        if map.len() > 512 {
            map.clear();
        }
        if let Some(hit) = map.get(path) {
            return hit.clone();
        }
        let icon = get_app_icon_base64(path);
        map.insert(path.to_path_buf(), icon.clone());
        icon
    }

    /// Map pid -> title of its first visible, titled, top-level window.
    fn window_titles_by_pid() -> std::collections::HashMap<u32, String> {
        use std::collections::HashMap;
        use windows::Win32::Foundation::{BOOL, HWND, LPARAM};
        use windows::Win32::UI::WindowsAndMessaging::{
            EnumWindows, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible,
        };

        unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
            let map = &mut *(lparam.0 as *mut HashMap<u32, String>);
            if IsWindowVisible(hwnd).as_bool() {
                let mut buf = [0u16; 256];
                let len = GetWindowTextW(hwnd, &mut buf);
                if len > 0 {
                    let mut pid: u32 = 0;
                    GetWindowThreadProcessId(hwnd, Some(&mut pid));
                    if pid != 0 {
                        let title = String::from_utf16_lossy(&buf[..len as usize]);
                        map.entry(pid).or_insert(title);
                    }
                }
            }
            BOOL(1)
        }

        let mut map: HashMap<u32, String> = HashMap::new();
        unsafe {
            let _ = EnumWindows(Some(enum_proc), LPARAM(&mut map as *mut _ as isize));
        }
        map
    }

    /// PIDs owning an ACTIVE render session on the default output device.
    /// Best-effort: any COM/WASAPI failure returns an empty list (auto-detect
    /// then simply lacks the audio-activity signal — nothing breaks).
    /// initialize_mta is safe to call repeatedly on a thread; S_FALSE
    /// ("already initialized") is not an error.
    fn active_audio_session_pids() -> Vec<u32> {
        let hr = wasapi::initialize_mta();
        if hr.is_err() {
            log::debug!("[audio-sessions] COM init failed for app-list enumeration: {:?}", hr);
            return Vec::new();
        }
        let enumerate = || -> Result<Vec<u32>, String> {
            let enumerator = DeviceEnumerator::new().map_err(|e| format!("{:?}", e))?;
            let device = enumerator
                .get_default_device(&Direction::Render)
                .map_err(|e| format!("{:?}", e))?;
            let session_mgr = device
                .get_iaudiosessionmanager()
                .map_err(|e| format!("{:?}", e))?;
            let sessions = session_mgr
                .get_audiosessionenumerator()
                .map_err(|e| format!("{:?}", e))?;
            let count = sessions.get_count().map_err(|e| format!("{:?}", e))?;
            let mut pids = Vec::new();
            for i in 0..count {
                let Ok(ctrl) = sessions.get_session(i) else { continue };
                let Ok(pid) = ctrl.get_process_id() else { continue };
                if pid == 0 {
                    continue; // system-sounds session has no owning process
                }
                if matches!(ctrl.get_state(), Ok(wasapi::SessionState::Active)) {
                    pids.push(pid);
                }
            }
            Ok(pids)
        };
        match enumerate() {
            Ok(pids) => pids,
            Err(e) => {
                log::debug!("[audio-sessions] app-list enumeration failed: {}", e);
                Vec::new()
            }
        }
    }

    /// Check if process is a system process we should skip.
    /// Pre-lowercased list + one lowercase of the name — the old shape
    /// allocated a fresh String per list entry per process in the hot loop.
    fn is_system_process(name: &str) -> bool {
        const SYSTEM_PROCS: [&str; 21] = [
            "svchost", "csrss", "wininit", "services", "lsass",
            "smss", "system", "registry", "dwm", "fontdrvhost",
            "winlogon", "sihost", "taskhostw", "ctfmon", "conhost",
            "runtimebroker", "searchhost", "startmenuexperiencehost",
            "shellexperiencehost", "textinputhost", "dllhost",
        ];
        let lower = name.to_lowercase();
        SYSTEM_PROCS.iter().any(|p| lower.contains(p))
    }

    // log_audio_session_tree (the "[audio-sessions]" dump) went with the
    // exclude mode it existed to debug: it proved WASAPI's exclusion TIMING
    // was the flaw (a session predating the exclude client is never
    // excluded), which is why the mode was removed rather than patched.

    /// Start capturing audio from a specific process (include-mode
    /// process-loopback; the multi-app mixer runs one of these per pid).
    ///
    /// The exclude-mode variant ("system audio minus Puca") is gone —
    /// WASAPI only excludes sessions created after the client initialises,
    /// and Puca's own voice call always predates it, so the mode echoed
    /// the call into every stream.
    ///
    /// Blocks (bounded) until WASAPI is actually delivering — a failed COM /
    /// loopback-client init returns Err to the JS caller instead of silently
    /// streaming a track that never receives data. Later runtime errors are
    /// emitted as 'audio-capture-error' events.
    pub fn start_capture(
        app_handle: AppHandle,
        pid: u32,
        state: Arc<AudioCaptureState>,
    ) -> Result<(), String> {
        // Guard: capture must never target Puca's own process tree —
        // that captures our voice-chat/notification output, not a game.
        // get_running_apps() no longer lists us, but a stale persisted
        // "last app" pid (or any future matching bug) must fail loudly here
        // instead of silently streaming ourselves.
        {
            let own_pid = std::process::id();
            let mut sys = System::new();
            // Parents are all this guard reads — skip the per-process
            // memory/CPU/disk queries the default refresh performs.
            sys.refresh_processes_specifics(
                sysinfo::ProcessesToUpdate::All,
                true,
                sysinfo::ProcessRefreshKind::new(),
            );
            let parent_of: std::collections::HashMap<u32, u32> = sys
                .processes()
                .iter()
                .filter_map(|(p, proc_)| proc_.parent().map(|pp| (p.as_u32(), pp.as_u32())))
                .collect();
            if super::pid_in_tree(&parent_of, pid, own_pid) {
                log::warn!(
                    "Refusing capture of PID {} — it is Puca's own process tree (own pid {})",
                    pid, own_pid
                );
                return Err(
                    "That capture target is Puca itself — pick the game in the stream settings".to_string(),
                );
            }
        }

        // A previous capture may still be winding down (stop_capture only
        // signals; the thread takes up to ~100 ms to notice) — wait briefly
        // instead of failing a quick stop-share -> re-share. The slot is then
        // CLAIMED with a compare-exchange: two concurrent starts (the commands
        // run off the main thread) can both pass the wait, but only one wins.
        let mut waited_ms = 0u32;
        loop {
            match state.is_capturing.compare_exchange(
                false,
                true,
                Ordering::SeqCst,
                Ordering::SeqCst,
            ) {
                Ok(_) => break, // claimed
                Err(_) => {
                    if !state.stop_signal.load(Ordering::SeqCst) {
                        return Err("Already capturing audio".to_string());
                    }
                    if waited_ms >= 1000 {
                        return Err("Previous audio capture is still shutting down".to_string());
                    }
                    std::thread::sleep(std::time::Duration::from_millis(10));
                    waited_ms += 10;
                }
            }
        }

        // Reset stop signal (the claim above established is_capturing = true)
        state.stop_signal.store(false, Ordering::SeqCst);

        // Spawn capture thread. It reports init success/failure back over the
        // channel; `is_capturing` is ALWAYS cleared when it exits (a failed
        // init used to leave it stuck true, bricking capture until restart).
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();
        let state_clone = state.clone();
        let emit_handle = app_handle.clone();
        std::thread::spawn(move || {
            let result = capture_loop(app_handle, pid, state_clone.clone(), ready_tx);
            state_clone.is_capturing.store(false, Ordering::SeqCst);
            if let Err(e) = result {
                log::error!("Audio capture error: {}", e);
                let _ = emit_handle.emit("audio-capture-error", e);
            }
        });

        match ready_rx.recv_timeout(std::time::Duration::from_secs(3)) {
            Ok(Ok(())) => Ok(()),
            Ok(Err(e)) => Err(e),
            Err(_) => Err("Audio capture initialisation timed out".to_string()),
        }
    }

    /// Stop audio capture
    pub fn stop_capture(state: Arc<AudioCaptureState>) {
        state.stop_signal.store(true, Ordering::SeqCst);
    }

    /// Main capture loop. Sends exactly one message on `ready` — Ok once WASAPI
    /// is initialised and streaming, or the init error — so start_capture can
    /// report failures to the JS caller synchronously.
    fn capture_loop(
        app_handle: AppHandle,
        pid: u32,
        state: Arc<AudioCaptureState>,
        ready: std::sync::mpsc::Sender<Result<(), String>>,
    ) -> Result<(), String> {
        log::info!("Starting audio capture for PID {}", pid);

        // Forward an init-step error over `ready` before returning it.
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

        // Initialize COM for this thread (wasapi 0.22 returns HRESULT)
        let hr = wasapi::initialize_mta();
        if hr.is_err() {
            let e = format!("COM init failed: {:?}", hr);
            let _ = ready.send(Err(e.clone()));
            return Err(e);
        }

        // Process loopback client, include-mode: the process + its children.
        // (The exclude-mode flip is gone with the system-audio option.)
        let mut audio_client = init_step!(AudioClient::new_application_loopback_client(pid, true)
            .map_err(|e| format!("Failed to create loopback client: {:?}", e)));

        // Define the format we want (32-bit float, 48kHz, stereo)
        let desired_format = WaveFormat::new(32, 32, &SampleType::Float, 48000, 2, None);

        // Configure stream mode (event-driven shared mode)
        let mode = StreamMode::EventsShared {
            autoconvert: true,
            buffer_duration_hns: 200_000, // 20ms buffer
        };

        // Initialize the client
        init_step!(audio_client
            .initialize_client(&desired_format, &Direction::Capture, &mode)
            .map_err(|e| format!("Failed to initialize client: {:?}", e)));

        // Get the capture client
        let capture_client = init_step!(audio_client
            .get_audiocaptureclient()
            .map_err(|e| format!("Failed to get capture client: {:?}", e)));

        // Get the event handle for waiting
        let event_handle = init_step!(audio_client
            .set_get_eventhandle()
            .map_err(|e| format!("Failed to get event handle: {:?}", e)));

        // Start capture
        init_step!(audio_client
            .start_stream()
            .map_err(|e| format!("Failed to start stream: {:?}", e)));

        let _ = ready.send(Ok(()));
        log::info!("Audio capture started successfully for PID {}", pid);

        // Watch the captured process so the stream can end with the game.
        // PROCESS_SYNCHRONIZE lets WaitForSingleObject(h, 0) report exit.
        let process_handle = {
            use windows::Win32::System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE};
            unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, pid) }.ok()
        };

        // Buffer for reading audio data
        // 48000 samples/sec * 2 channels * 4 bytes/sample * 0.1 sec = 38400 bytes
        let mut buffer: Vec<u8> = vec![0u8; 48000 * 2 * 4];

        // A fatal mid-capture error ends the loop and is returned (the spawn
        // wrapper emits it as 'audio-capture-error' so the UI can react).
        let mut run_error: Option<String> = None;

        // WASAPI can mark a packet AUDCLNT_BUFFERFLAGS_SILENT — the source had
        // nothing to give this tick. Forwarding it is still correct (it IS
        // real silence), but if EVERY packet keeps coming back silent-flagged
        // that's a distinct failure mode from "no packets at all" (already
        // covered by the JS-side no-data watchdog): the capture is alive and
        // "succeeding", yet Windows is handing back nothing real. Surface it
        // once so this isn't indistinguishable from the AudioContext-suspended
        // case on the JS side.
        let mut silent_streak: u32 = 0;
        let mut warned_silent_streak = false;

        // Capture loop
        while !state.stop_signal.load(Ordering::SeqCst) {
            // Game exited? Tell the frontend so it can stop the whole stream.
            if let Some(h) = &process_handle {
                use windows::Win32::Foundation::WAIT_OBJECT_0;
                use windows::Win32::System::Threading::WaitForSingleObject;
                if unsafe { WaitForSingleObject(*h, 0) } == WAIT_OBJECT_0 {
                    log::info!("Captured process {} exited — ending game audio", pid);
                    let _ = app_handle.emit("game-audio-ended", pid);
                    break;
                }
            }

            // Wait for audio data (with timeout)
            if event_handle.wait_for_event(100).is_ok() {
                // Get available packet size
                match capture_client.get_next_packet_size() {
                    Ok(Some(packet_size)) if packet_size > 0 => {
                        // Calculate bytes needed
                        let bytes_per_frame = 2 * 4; // stereo * 32-bit
                        let bytes_needed = packet_size as usize * bytes_per_frame;
                        
                        // Ensure buffer is large enough
                        if buffer.len() < bytes_needed {
                            buffer.resize(bytes_needed, 0);
                        }

                        // Read the audio data into buffer
                        match capture_client.read_from_device(&mut buffer[..bytes_needed]) {
                            Ok((frames_read, buffer_info)) => {
                                let actual_bytes = frames_read as usize * bytes_per_frame;
                                if buffer_info.flags.silent {
                                    silent_streak += 1;
                                    if !warned_silent_streak && silent_streak >= 50 {
                                        warned_silent_streak = true;
                                        log::warn!(
                                            "WASAPI has flagged ~1s of continuous audio as SILENT for PID {} — \
                                             capture is alive and 'succeeding' but Windows says this source has \
                                             nothing real to give (as opposed to no packets arriving at all)",
                                            pid
                                        );
                                    }
                                } else {
                                    silent_streak = 0;
                                }
                                // Emit audio data to frontend
                                let encoded = STANDARD.encode(&buffer[..actual_bytes]);
                                let _ = app_handle.emit("audio-data", AudioDataEvent {
                                    data: encoded,
                                    sample_rate: 48000,
                                    channels: 2,
                                    bits_per_sample: 32,
                                    silent: buffer_info.flags.silent,
                                });
                            }
                            Err(e) => {
                                log::warn!("Failed to read audio data: {:?}", e);
                            }
                        }
                    }
                    Ok(_) => {
                        // No packets available
                    }
                    Err(e) => {
                        log::error!("Error getting packet size: {:?}", e);
                        run_error = Some(format!("Audio capture failed mid-stream: {:?}", e));
                        break;
                    }
                }
            }
        }

        // Stop and cleanup (`is_capturing` is cleared by the spawn wrapper).
        let _ = audio_client.stop_stream();
        if let Some(h) = process_handle {
            use windows::Win32::Foundation::CloseHandle;
            let _ = unsafe { CloseHandle(h) };
        }
        log::info!("Audio capture stopped for PID {}", pid);

        match run_error {
            Some(e) => Err(e),
            None => Ok(()),
        }
    }

    /// Audio data event payload
    #[derive(Clone, Serialize)]
    struct AudioDataEvent {
        data: String, // Base64 encoded PCM data
        sample_rate: u32,
        channels: u32,
        bits_per_sample: u32,
        /// AUDCLNT_BUFFERFLAGS_SILENT was set on this packet — WASAPI says
        /// there was nothing real to capture this tick (distinct from no
        /// packet arriving at all).
        silent: bool,
    }

    // ================= Multi-app capture (mixer) =================
    //
    // "Stream exactly these apps": one INCLUDE-mode process-loopback capture
    // per selected app, mixed on a 10 ms tick into the SAME 'audio-data'
    // stream the single-capture path emits — the frontend pipeline (jitter
    // buffer, scheduling, silence watchdog) is untouched. Include-mode only,
    // and Puca's own tree is refused, so the stream structurally cannot
    // carry Puca's voice-chat output (the exclude-mode leak class).

    use std::collections::{HashMap as StdHashMap, VecDeque};
    use std::sync::atomic::AtomicU32;
    use std::sync::{Mutex, OnceLock};

    /// Ring cap ≈ 0.5 s of 48 kHz stereo f32 — a stalled source (or a mixer
    /// falling behind) drops its oldest audio instead of growing latency.
    const SOURCE_RING_CAP: usize = 48_000;
    /// One mixer tick: 10 ms of 48 kHz stereo.
    const SAMPLES_PER_TICK: usize = 48_000 / 100 * 2;

    struct MixSource {
        pid: u32,
        ring: Arc<Mutex<VecDeque<f32>>>,
        /// Linear gain (f32 bits in an AtomicU32); 1.0 = 100%.
        gain: Arc<AtomicU32>,
    }

    /// Gain handles for the CURRENTLY running multi-capture, so the
    /// set_app_capture_gain command can move sliders mid-stream.
    static ACTIVE_GAINS: OnceLock<Mutex<StdHashMap<u32, Arc<AtomicU32>>>> = OnceLock::new();
    fn active_gains() -> &'static Mutex<StdHashMap<u32, Arc<AtomicU32>>> {
        ACTIVE_GAINS.get_or_init(|| Mutex::new(StdHashMap::new()))
    }

    /// Set a running mixer source's gain (linear, clamped to 0.0–2.0).
    pub fn set_capture_gain(pid: u32, gain: f32) -> Result<(), String> {
        // NaN survives clamp() and would propagate through the mix into the
        // emitted PCM — reject junk outright.
        if !gain.is_finite() {
            return Err("gain must be a finite number".to_string());
        }
        let clamped = gain.clamp(0.0, 2.0);
        match active_gains().lock().unwrap().get(&pid) {
            Some(g) => {
                g.store(clamped.to_bits(), Ordering::Relaxed);
                Ok(())
            }
            None => Err(format!("No active mixer capture for PID {pid}")),
        }
    }

    /// One mixer source: an include-mode loopback capture of `pid`'s tree that
    /// writes interleaved f32 into its ring. Watches the pid for exit and
    /// emits 'app-audio-source-ended' (the STREAM keeps going — the UI just
    /// drops this app from its list), unlike the single-capture path where a
    /// game exiting ends the whole stream.
    fn source_loop(
        app_handle: AppHandle,
        pid: u32,
        state: Arc<AudioCaptureState>,
        ring: Arc<Mutex<VecDeque<f32>>>,
        ready: std::sync::mpsc::Sender<Result<(), String>>,
    ) {
        macro_rules! init_step {
            ($e:expr) => {
                match $e {
                    Ok(v) => v,
                    Err(msg) => {
                        let _ = ready.send(Err(msg));
                        return;
                    }
                }
            };
        }

        let hr = wasapi::initialize_mta();
        if hr.is_err() {
            let _ = ready.send(Err(format!("COM init failed: {:?}", hr)));
            return;
        }
        let mut audio_client = init_step!(AudioClient::new_application_loopback_client(pid, true)
            .map_err(|e| format!("Failed to create loopback client: {:?}", e)));
        let desired_format = WaveFormat::new(32, 32, &SampleType::Float, 48000, 2, None);
        let mode = StreamMode::EventsShared {
            autoconvert: true,
            buffer_duration_hns: 200_000,
        };
        init_step!(audio_client
            .initialize_client(&desired_format, &Direction::Capture, &mode)
            .map_err(|e| format!("Failed to initialize client: {:?}", e)));
        let capture_client = init_step!(audio_client
            .get_audiocaptureclient()
            .map_err(|e| format!("Failed to get capture client: {:?}", e)));
        let event_handle = init_step!(audio_client
            .set_get_eventhandle()
            .map_err(|e| format!("Failed to get event handle: {:?}", e)));
        init_step!(audio_client
            .start_stream()
            .map_err(|e| format!("Failed to start stream: {:?}", e)));
        let _ = ready.send(Ok(()));
        log::info!("Mixer source started for PID {}", pid);

        let process_handle = {
            use windows::Win32::System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE};
            unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, pid) }.ok()
        };
        let mut buffer: Vec<u8> = vec![0u8; 48_000 * 2 * 4];

        while !state.stop_signal.load(Ordering::SeqCst) {
            if let Some(h) = &process_handle {
                use windows::Win32::Foundation::WAIT_OBJECT_0;
                use windows::Win32::System::Threading::WaitForSingleObject;
                if unsafe { WaitForSingleObject(*h, 0) } == WAIT_OBJECT_0 {
                    log::info!("Mixer source PID {} exited", pid);
                    let _ = app_handle.emit("app-audio-source-ended", pid);
                    break;
                }
            }
            if event_handle.wait_for_event(100).is_ok() {
                match capture_client.get_next_packet_size() {
                    Ok(Some(packet_size)) if packet_size > 0 => {
                        let bytes_needed = packet_size as usize * 8; // stereo f32
                        if buffer.len() < bytes_needed {
                            buffer.resize(bytes_needed, 0);
                        }
                        match capture_client.read_from_device(&mut buffer[..bytes_needed]) {
                            Ok((frames_read, _info)) => {
                                let samples = frames_read as usize * 2;
                                let mut r = ring.lock().unwrap();
                                for i in 0..samples {
                                    let b = i * 4;
                                    r.push_back(f32::from_le_bytes([
                                        buffer[b],
                                        buffer[b + 1],
                                        buffer[b + 2],
                                        buffer[b + 3],
                                    ]));
                                }
                                while r.len() > SOURCE_RING_CAP {
                                    r.pop_front();
                                }
                            }
                            Err(e) => log::warn!("Mixer source {}: read failed: {:?}", pid, e),
                        }
                    }
                    Ok(_) => {}
                    Err(e) => {
                        log::error!("Mixer source {}: packet-size error: {:?}", pid, e);
                        let _ = app_handle.emit("app-audio-source-ended", pid);
                        break;
                    }
                }
            }
        }

        let _ = audio_client.stop_stream();
        if let Some(h) = process_handle {
            use windows::Win32::Foundation::CloseHandle;
            let _ = unsafe { CloseHandle(h) };
        }
        log::info!("Mixer source stopped for PID {}", pid);
    }

    /// 10 ms mixer tick: drain up to one tick of samples from every source
    /// ring, gain-scale, sum, clamp, emit ONE 'audio-data' chunk.
    fn mixer_loop(app_handle: AppHandle, sources: Vec<MixSource>, state: Arc<AudioCaptureState>) {
        let tick = std::time::Duration::from_millis(10);
        let mut next = std::time::Instant::now() + tick;
        let mut mix = vec![0f32; SAMPLES_PER_TICK];
        let mut scratch = vec![0f32; SAMPLES_PER_TICK];

        while !state.stop_signal.load(Ordering::SeqCst) {
            let now = std::time::Instant::now();
            if next > now {
                std::thread::sleep(next - now);
            }
            // DEFICIT-REPAYING cadence: advance the deadline by exactly one
            // tick, so sleep overshoot (Windows wakes on a ~15.6 ms quantum by
            // default) makes the next sleep shorter — down to zero, i.e.
            // back-to-back ticks until the deficit is repaid. Without this the
            // mixer consumes < 100 ticks/s while sources produce 48 kHz
            // continuously: rings saturate and the ring cap then discards
            // audio nonstop (permanent choppy dropouts at max latency).
            next += tick;
            // After a real stall (laptop sleep, debugger pause) the rings have
            // already overflowed — resnap instead of bursting through a huge
            // backlog of silent ticks.
            let now = std::time::Instant::now();
            if now > next + std::time::Duration::from_millis(500) {
                next = now + tick;
            }

            mix.fill(0.0);
            let mut any = false;
            for s in &sources {
                let gain = f32::from_bits(s.gain.load(Ordering::Relaxed));
                let n = {
                    let mut r = s.ring.lock().unwrap();
                    let n = r.len().min(SAMPLES_PER_TICK);
                    for slot in scratch.iter_mut().take(n) {
                        *slot = r.pop_front().unwrap_or(0.0);
                    }
                    n
                };
                if n > 0 {
                    any = true;
                    super::accumulate_into(&mut mix[..n], &scratch[..n], gain);
                }
            }
            super::clamp_samples(&mut mix);

            let mut bytes = Vec::with_capacity(SAMPLES_PER_TICK * 4);
            for v in &mix {
                bytes.extend_from_slice(&v.to_le_bytes());
            }
            let _ = app_handle.emit("audio-data", AudioDataEvent {
                data: STANDARD.encode(&bytes),
                sample_rate: 48000,
                channels: 2,
                bits_per_sample: 32,
                silent: !any,
            });
        }
        log::info!("Mixer capture stopped");
    }

    /// Start capturing EXACTLY the given apps' audio (one include-mode capture
    /// per pid, mixed). Returns the pids that could NOT be started (own-tree,
    /// init failure) — an Err only when nothing could be captured at all.
    /// Shares the single capture slot + stop signal with the other modes.
    pub fn start_multi_capture(
        app_handle: AppHandle,
        pids: Vec<u32>,
        state: Arc<AudioCaptureState>,
    ) -> Result<Vec<u32>, String> {
        // Own-tree guard, same rationale as start_capture's include-mode guard.
        let own_pid = std::process::id();
        let mut sys = System::new();
        sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
        let parent_of: StdHashMap<u32, u32> = sys
            .processes()
            .iter()
            .filter_map(|(p, proc_)| proc_.parent().map(|pp| (p.as_u32(), pp.as_u32())))
            .collect();
        let mut failed: Vec<u32> = Vec::new();
        let targets: Vec<u32> = pids
            .into_iter()
            .filter(|&p| {
                if super::pid_in_tree(&parent_of, p, own_pid) {
                    log::warn!("Refusing mixer capture of PID {} — Puca's own tree", p);
                    failed.push(p);
                    false
                } else {
                    true
                }
            })
            .collect();
        if targets.is_empty() {
            return Err("None of the selected apps can be captured".to_string());
        }

        // Claim the capture slot (same wind-down wait as start_capture).
        let mut waited_ms = 0u32;
        loop {
            match state.is_capturing.compare_exchange(
                false,
                true,
                Ordering::SeqCst,
                Ordering::SeqCst,
            ) {
                Ok(_) => break,
                Err(_) => {
                    if !state.stop_signal.load(Ordering::SeqCst) {
                        return Err("Already capturing audio".to_string());
                    }
                    if waited_ms >= 1000 {
                        return Err("Previous audio capture is still shutting down".to_string());
                    }
                    std::thread::sleep(std::time::Duration::from_millis(10));
                    waited_ms += 10;
                }
            }
        }
        state.stop_signal.store(false, Ordering::SeqCst);

        // Spawn every source first, then collect init results. Keep every
        // JoinHandle — the capture slot must not be released until every
        // source thread has actually FINISHED (a lagging source can sit up to
        // ~100 ms in wait_for_event, or seconds in init): releasing early lets
        // a quick restart clear stop_signal before the laggard observes it,
        // leaking a live WASAPI capture that runs until the NEXT stop.
        let mut pending = Vec::new();
        for pid in targets {
            let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
            let ring = Arc::new(Mutex::new(VecDeque::new()));
            let gain = Arc::new(AtomicU32::new(1.0f32.to_bits()));
            let handle = app_handle.clone();
            let st = state.clone();
            let r = ring.clone();
            let join = std::thread::spawn(move || source_loop(handle, pid, st, r, tx));
            pending.push((pid, rx, ring, gain, join));
        }
        let mut sources: Vec<MixSource> = Vec::new();
        let mut source_joins = Vec::new();
        for (pid, rx, ring, gain, join) in pending {
            source_joins.push(join);
            match rx.recv_timeout(std::time::Duration::from_secs(3)) {
                Ok(Ok(())) => sources.push(MixSource { pid, ring, gain }),
                Ok(Err(e)) => {
                    log::warn!("Mixer source {} failed to start: {}", pid, e);
                    failed.push(pid);
                }
                Err(_) => {
                    log::warn!("Mixer source {} init timed out", pid);
                    failed.push(pid);
                }
            }
        }
        if sources.is_empty() {
            // Signal every half-started thread down, WAIT for them, then free
            // the slot.
            state.stop_signal.store(true, Ordering::SeqCst);
            for j in source_joins {
                let _ = j.join();
            }
            state.is_capturing.store(false, Ordering::SeqCst);
            return Err("No selected app could be captured".to_string());
        }

        {
            let mut g = active_gains().lock().unwrap();
            g.clear();
            for s in &sources {
                g.insert(s.pid, s.gain.clone());
            }
        }
        log::info!(
            "Mixer capture started: {} source(s) {:?}, {} failed",
            sources.len(),
            sources.iter().map(|s| s.pid).collect::<Vec<_>>(),
            failed.len()
        );

        let st = state.clone();
        std::thread::spawn(move || {
            mixer_loop(app_handle, sources, st.clone());
            // The mixer only exits once stop_signal is set — now wait for every
            // source thread to actually finish before releasing the slot, so a
            // quick restart can't clear stop_signal before a lagging source
            // observed it (which would leak a live capture until the next stop).
            for j in source_joins {
                let _ = j.join();
            }
            active_gains().lock().unwrap().clear();
            st.is_capturing.store(false, Ordering::SeqCst);
        });

        Ok(failed)
    }
}

// Non-Windows stubs
#[cfg(not(windows))]
pub mod windows_audio {
    use serde::{Deserialize, Serialize};

    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct AudioApp {
        pub pid: u32,
        pub name: String,
        pub window_title: Option<String>,
        #[serde(default)]
        pub has_active_audio: bool,
    }

    pub fn get_running_apps() -> Vec<AudioApp> {
        vec![]
    }
}
