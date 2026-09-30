//! Every microphone's Windows input level, into puca.log, during a call.
//!
//! WHY (2026-09-30): three of the owner's capture endpoints were found at
//! exactly 7.8 %, i.e. 20/255, the floor of WebRTC's input volume controller,
//! and one headset mic had gone nearly silent. Chromium applies that
//! controller's recommendation to the OS endpoint whenever a getUserMedia
//! track has autoGainControl on, unless the WebRtcAllowInputVolumeAdjustment
//! feature is disabled, which tauri.conf.json now does. This module is how a
//! regression becomes visible: the levels at call start, a line whenever one
//! moves during the call, and a warning at the end naming every endpoint that
//! finished the call at a different level than it started at.
//!
//! READ-ONLY by construction: it calls GetMasterVolumeLevelScalar and GetMute
//! and nothing else on the endpoint. Púca must never set a microphone level.

use std::collections::BTreeMap;
use std::sync::Mutex;

/// One endpoint's state: level as a 0..=100 percentage (one decimal), muted.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Level {
    pub percent: f32,
    pub muted: bool,
}

/// Endpoint friendly name → state.
pub type Snapshot = BTreeMap<String, Level>;

/// `Microphone (FMA120) 100% | CABLE Output 7.8% muted`
pub fn format_snapshot(s: &Snapshot) -> String {
    if s.is_empty() {
        return "(no active microphones)".into();
    }
    s.iter()
        .map(|(n, l)| format!("{n} {}%{}", fmt_pct(l.percent), if l.muted { " muted" } else { "" }))
        .collect::<Vec<_>>()
        .join(" | ")
}

fn fmt_pct(p: f32) -> String {
    let r = (p * 10.0).round() / 10.0;
    if r.fract() == 0.0 { format!("{r:.0}") } else { format!("{r:.1}") }
}

/// Endpoints present in both whose level moved by at least half a point, or
/// whose mute changed: `Microphone (FMA120) 100% -> 7.8%`. Endpoints that
/// appeared or vanished (a headset switched on or off) are not changes.
pub fn changes(before: &Snapshot, after: &Snapshot) -> Vec<String> {
    after
        .iter()
        .filter_map(|(n, a)| {
            let b = before.get(n)?;
            let moved = (a.percent - b.percent).abs() >= 0.5;
            if !moved && a.muted == b.muted {
                return None;
            }
            let m = |l: &Level| if l.muted { " muted" } else { "" };
            Some(format!("{n} {}%{} -> {}%{}", fmt_pct(b.percent), m(b), fmt_pct(a.percent), m(a)))
        })
        .collect()
}

/// What the three phases write, given the snapshots. Pure, for the tests.
/// `start`: the levels. `check`: a line only when something moved since the
/// last read. `end`: the levels, plus a WARN naming whatever differs from the
/// call's start. Returns (warn, line) pairs to log.
pub fn lines_for(
    phase: &str,
    now: &Snapshot,
    at_start: Option<&Snapshot>,
    last: Option<&Snapshot>,
) -> Vec<(bool, String)> {
    match phase {
        "start" => vec![(false, format!("[mic-level] call start: {}", format_snapshot(now)))],
        "check" => {
            let moved = last.map(|l| changes(l, now)).unwrap_or_default();
            if moved.is_empty() {
                vec![]
            } else {
                vec![(true, format!("[mic-level] changed during the call: {}", moved.join(" | ")))]
            }
        }
        "end" => {
            let mut out = vec![(false, format!("[mic-level] call end: {}", format_snapshot(now)))];
            let diff = at_start.map(|s| changes(s, now)).unwrap_or_default();
            if !diff.is_empty() {
                out.push((
                    true,
                    format!(
                        "[mic-level] a microphone's Windows input level is not what it was when the call started \
                         (Púca must never change it): {}",
                        diff.join(" | ")
                    ),
                ));
            }
            out
        }
        _ => vec![],
    }
}

struct State {
    at_start: Option<Snapshot>,
    last: Option<Snapshot>,
}
static STATE: Mutex<State> = Mutex::new(State { at_start: None, last: None });

#[cfg(windows)]
fn read_snapshot() -> Result<Snapshot, String> {
    use windows::core::PCWSTR;
    use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
    use windows::Win32::Media::Audio::{IMMDeviceEnumerator, MMDeviceEnumerator};
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};

    let _ = wasapi::initialize_mta();
    let names = wasapi::DeviceEnumerator::new().map_err(|e| e.to_string())?;
    let col = names.get_device_collection(&wasapi::Direction::Capture).map_err(|e| e.to_string())?;
    let n = col.get_nbr_devices().map_err(|e| e.to_string())?;
    let en: IMMDeviceEnumerator =
        unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }.map_err(|e| e.to_string())?;
    let mut out = Snapshot::new();
    for i in 0..n {
        let Ok(dev) = col.get_device_at_index(i) else { continue };
        let (Ok(name), Ok(id)) = (dev.get_friendlyname(), dev.get_id()) else { continue };
        let wide: Vec<u16> = id.encode_utf16().chain(std::iter::once(0)).collect();
        let level = unsafe {
            en.GetDevice(PCWSTR(wide.as_ptr()))
                .and_then(|d| d.Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None))
                .and_then(|v| Ok(Level { percent: v.GetMasterVolumeLevelScalar()? * 100.0, muted: v.GetMute()?.as_bool() }))
        };
        if let Ok(l) = level {
            out.insert(name, l);
        }
    }
    Ok(out)
}

#[cfg(not(windows))]
fn read_snapshot() -> Result<Snapshot, String> {
    Err("microphone levels are read on Windows only".into())
}

/// `phase`: "start" | "check" | "end". Logs, never sets anything.
#[tauri::command]
pub async fn log_mic_levels(phase: String) {
    let _ = tauri::async_runtime::spawn_blocking(move || {
        let now = match read_snapshot() {
            Ok(s) => s,
            Err(e) => {
                if phase == "start" {
                    log::info!("[mic-level] unavailable: {e}");
                }
                return;
            }
        };
        let mut st = STATE.lock().unwrap_or_else(|p| p.into_inner());
        for (warn, line) in lines_for(&phase, &now, st.at_start.as_ref(), st.last.as_ref()) {
            if warn { log::warn!("{line}") } else { log::info!("{line}") }
        }
        match phase.as_str() {
            "start" => { st.at_start = Some(now.clone()); st.last = Some(now); }
            "check" => st.last = Some(now),
            "end" => { st.at_start = None; st.last = None; }
            _ => {}
        }
    })
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snap(v: &[(&str, f32, bool)]) -> Snapshot {
        v.iter().map(|(n, p, m)| (n.to_string(), Level { percent: *p, muted: *m })).collect()
    }

    #[test]
    fn formats_levels_readably() {
        let s = snap(&[("Microphone (FMA120)", 100.0, false), ("CABLE Output", 7.843_137, true)]);
        assert_eq!(format_snapshot(&s), "CABLE Output 7.8% muted | Microphone (FMA120) 100%");
        assert_eq!(format_snapshot(&Snapshot::new()), "(no active microphones)");
    }

    #[test]
    fn a_lowered_level_is_a_change_and_noise_is_not() {
        let a = snap(&[("Mic", 100.0, false), ("Cable", 50.0, false)]);
        let b = snap(&[("Mic", 7.843_137, false), ("Cable", 50.3, false), ("New headset", 20.0, false)]);
        assert_eq!(changes(&a, &b), vec!["Mic 100% -> 7.8%".to_string()]);
        let muted = snap(&[("Mic", 100.0, true), ("Cable", 50.0, false)]);
        assert_eq!(changes(&a, &muted), vec!["Mic 100% -> 100% muted".to_string()]);
        assert!(changes(&a, &a).is_empty());
    }

    #[test]
    fn start_logs_the_levels_check_logs_only_a_move_end_warns_on_a_difference() {
        let start = snap(&[("Mic", 100.0, false)]);
        let low = snap(&[("Mic", 7.843_137, false)]);
        assert_eq!(lines_for("start", &start, None, None), vec![(false, "[mic-level] call start: Mic 100%".into())]);
        assert!(lines_for("check", &start, Some(&start), Some(&start)).is_empty());
        let moved = lines_for("check", &low, Some(&start), Some(&start));
        assert_eq!(moved, vec![(true, "[mic-level] changed during the call: Mic 100% -> 7.8%".into())]);
        // Reported once: the next check compares with the level it last saw.
        assert!(lines_for("check", &low, Some(&start), Some(&low)).is_empty());
        let end = lines_for("end", &low, Some(&start), Some(&low));
        assert_eq!(end.len(), 2);
        assert_eq!(end[0], (false, "[mic-level] call end: Mic 7.8%".into()));
        assert!(end[1].0 && end[1].1.contains("Mic 100% -> 7.8%"), "{:?}", end[1]);
        // Unchanged over the call: the end line, no warning.
        assert_eq!(lines_for("end", &start, Some(&start), Some(&start)).len(), 1);
        assert!(lines_for("bogus", &start, None, None).is_empty());
    }

    /// The real endpoints of the machine running the test, read-only. Skips
    /// where there is no capture device (CI); proves the COM path works here.
    #[cfg(windows)]
    #[test]
    fn reads_this_machines_microphones_without_changing_them() {
        let a = read_snapshot().expect("capture endpoints readable");
        let b = read_snapshot().expect("again");
        assert!(changes(&a, &b).is_empty(), "reading must not move a level: {a:?} vs {b:?}");
        for (n, l) in &a {
            assert!((0.0..=100.0).contains(&l.percent), "{n}: {}", l.percent);
        }
        eprintln!("{}", format_snapshot(&a));
    }
}
