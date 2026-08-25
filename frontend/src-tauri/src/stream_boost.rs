//! CPU scheduling-priority boost for the WebView2 capture/encode processes
//! while someone is WATCHING a live capture from this machine (voice screen
//! share, device-control host capture).
//!
//! Why: field-confirmed 2026-08-20 — an uncapped fullscreen game gets
//! Windows' foreground CPU scheduling boost while the share pipeline sits at
//! NORMAL, so v0.8.111 raised WebView2's child processes to
//! ABOVE_NORMAL_PRIORITY_CLASS.
//!
//! THE GPU HALF WAS ARCHIVED (2026-08-25). v0.8.113 additionally raised the
//! processes' GPU ENGINE scheduling priority via
//! D3DKMTSetProcessSchedulingPriorityClass (the OBS technique) because the
//! field logs showed the game pegging the GPU 3D engine, not the CPU. The
//! field answer to that build's open question came back: on the reporting
//! machine the cross-process raise returned a nonzero NTSTATUS — it needs
//! elevation, which this app never runs under — so the call was a no-op that
//! only logged. The user also traced the original choppiness to their own
//! in-game GPU load, not to this app. The implementation lives in git
//! history (sovereign v0.8.113, main 5727907) should an elevated pathway
//! ever make it worth reviving; per-machine behaviour may differ, but a
//! boost that needs an elevation prompt is its own feature decision, not a
//! silent sweep.
//!
//! What it does now: while active, every descendant `msedgewebview2.exe` of
//! this app process sitting at NORMAL is raised to ABOVE_NORMAL (CPU). A
//! re-apply tick catches processes Chromium spawns or re-prioritises
//! mid-share. On release, each process is restored to the CPU class it had —
//! after re-checking it is STILL one of our webview processes, so a recycled
//! pid is never touched.
//!
//! Deliberately NOT active for the armed clip replay buffer: nobody is
//! watching that capture live, and taking GPU/CPU time from the game to feed
//! it would recreate the "Puca makes games choppy" complaint from the
//! other direction. Holder selection lives in frontend/src/api/streamBoost.ts.

#[cfg(windows)]
use std::sync::Mutex;

/// One row of a process snapshot — enough to answer "is this pid a descendant
/// of the app, and is it a WebView2 process?". Platform-neutral so the
/// descendant walk below is unit-testable everywhere.
#[derive(Debug, Clone)]
#[cfg_attr(not(windows), allow(dead_code))] // exercised by tests + Windows imp
pub struct ProcRow {
    pub pid: u32,
    pub ppid: u32,
    /// Executable file name only (e.g. `msedgewebview2.exe`), lowercased by
    /// the caller or compared case-insensitively here.
    pub name: String,
}

/// Pids among `rows` that are strict descendants of `root` AND whose image
/// name equals `name` (case-insensitive). Pure so it can be tested without
/// Windows.
///
/// Walks child edges breadth-first with a visited set: parent pids can be
/// RECYCLED after the parent dies, which can stitch arbitrary — even cyclic —
/// shapes into the (pid, ppid) relation. Without the visited set a cycle
/// would loop forever.
#[cfg_attr(not(windows), allow(dead_code))] // exercised by tests + Windows imp
pub fn descendants_named(rows: &[ProcRow], root: u32, name: &str) -> Vec<u32> {
    use std::collections::{HashMap, HashSet, VecDeque};
    let mut children: HashMap<u32, Vec<&ProcRow>> = HashMap::new();
    for r in rows {
        children.entry(r.ppid).or_default().push(r);
    }
    let mut out = Vec::new();
    let mut seen: HashSet<u32> = HashSet::new();
    let mut queue: VecDeque<u32> = VecDeque::from([root]);
    seen.insert(root);
    while let Some(pid) = queue.pop_front() {
        for child in children.get(&pid).into_iter().flatten() {
            // A row whose ppid == its own pid (seen on some system rows) or a
            // recycled-pid cycle: `seen` breaks both.
            if !seen.insert(child.pid) {
                continue;
            }
            if child.name.eq_ignore_ascii_case(name) {
                out.push(child.pid);
            }
            queue.push_back(child.pid);
        }
    }
    out
}

/// What we changed for one pid, so release knows what to put back.
#[cfg(windows)]
#[derive(Clone, Copy)]
struct Boosted {
    /// CPU priority class it had before we raised it.
    cpu_old: u32,
}

#[cfg(windows)]
struct BoostState {
    /// Bumped on every deactivate; the re-apply thread exits when it no longer
    /// matches the generation it was spawned with.
    generation: u64,
    active: bool,
    boosted: std::collections::HashMap<u32, Boosted>,
}

#[cfg(windows)]
static STATE: std::sync::LazyLock<Mutex<BoostState>> = std::sync::LazyLock::new(|| {
    Mutex::new(BoostState {
        generation: 0,
        active: false,
        boosted: std::collections::HashMap::new(),
    })
});

#[cfg(windows)]
mod imp {
    use super::{descendants_named, Boosted, ProcRow, STATE};
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::Threading::{
        GetPriorityClass, OpenProcess, SetPriorityClass, ABOVE_NORMAL_PRIORITY_CLASS,
        NORMAL_PRIORITY_CLASS, PROCESS_CREATION_FLAGS, PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_SET_INFORMATION,
    };

    const WEBVIEW_EXE: &str = "msedgewebview2.exe";

    /// Re-apply cadence while active. Chromium re-prioritises children on its
    /// own events (visibility, audio) and spawns utility processes lazily; a
    /// periodic sweep wins those races without being hot.
    const REAPPLY_MS: u64 = 10_000;
    /// Staleness-check granularity inside a re-apply interval, so releasing
    /// the boost never waits ~10 s for the thread to notice.
    const TICK_MS: u64 = 500;

    fn snapshot() -> Vec<ProcRow> {
        let mut rows = Vec::new();
        // SAFETY: standard Toolhelp iteration; the snapshot handle is closed
        // on every path and PROCESSENTRY32W is stack-owned.
        unsafe {
            let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
                return rows;
            };
            let mut entry = PROCESSENTRY32W {
                dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
                ..Default::default()
            };
            if Process32FirstW(snap, &mut entry).is_ok() {
                loop {
                    let len = entry
                        .szExeFile
                        .iter()
                        .position(|&c| c == 0)
                        .unwrap_or(entry.szExeFile.len());
                    rows.push(ProcRow {
                        pid: entry.th32ProcessID,
                        ppid: entry.th32ParentProcessID,
                        name: String::from_utf16_lossy(&entry.szExeFile[..len]),
                    });
                    if Process32NextW(snap, &mut entry).is_err() {
                        break;
                    }
                }
            }
            let _ = CloseHandle(snap);
        }
        rows
    }

    fn our_webview_pids() -> Vec<u32> {
        descendants_named(&snapshot(), std::process::id(), WEBVIEW_EXE)
    }

    /// Raise `pid`'s CPU priority to ABOVE_NORMAL. Returns what changed,
    /// when anything did, so it can be restored later.
    fn boost_one(pid: u32) -> Option<Boosted> {
        // SAFETY: handle is closed on every path; failures return None.
        unsafe {
            let handle =
                OpenProcess(PROCESS_SET_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
                    .ok()?;
            let cpu_old = GetPriorityClass(handle);
            // Only lift processes sitting at NORMAL. BELOW_NORMAL/IDLE children
            // (crashpad, parked utilities) were parked deliberately and are not
            // on the media path; anything already elevated is left alone.
            let cpu_changed = if cpu_old == NORMAL_PRIORITY_CLASS.0 {
                SetPriorityClass(handle, ABOVE_NORMAL_PRIORITY_CLASS).is_ok()
            } else {
                false
            };
            let _ = CloseHandle(handle);
            cpu_changed.then_some(Boosted { cpu_old })
        }
    }

    fn restore_one(pid: u32, boosted: Boosted) {
        // SAFETY: as in boost_one.
        unsafe {
            if let Ok(handle) =
                OpenProcess(PROCESS_SET_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
            {
                let _ = SetPriorityClass(handle, PROCESS_CREATION_FLAGS(boosted.cpu_old));
                let _ = CloseHandle(handle);
            }
        }
    }

    /// Boost every current webview descendant not already boosted. Returns
    /// the number of processes currently held boosted.
    fn apply() -> usize {
        let pids = our_webview_pids();
        let mut state = STATE.lock().unwrap();
        if !state.active {
            return 0; // released while we were snapshotting — don't re-boost
        }
        for pid in pids {
            // Called for pids we've ALREADY boosted too: Chromium re-asserts
            // its own child priorities on its own events (visibility, audio)
            // and can slide a process back to NORMAL mid-share — boost_one
            // re-lifts exactly that case. or_insert only: cpu_old must stay
            // the FIRST-seen original class (a re-sweep of an already-lifted
            // pid would read back ABOVE_NORMAL as "old", corrupting the
            // restore target).
            if let Some(new) = boost_one(pid) {
                state.boosted.entry(pid).or_insert(new);
            }
        }
        state.boosted.len()
    }

    pub fn activate() -> usize {
        let generation = {
            let mut state = STATE.lock().unwrap();
            let was_active = state.active;
            state.active = true;
            if was_active {
                drop(state);
                return apply(); // already running — just sweep now
            }
            state.generation
        };
        let counts = apply();
        std::thread::spawn(move || loop {
            for _ in 0..(REAPPLY_MS / TICK_MS) {
                std::thread::sleep(std::time::Duration::from_millis(TICK_MS));
                let state = STATE.lock().unwrap();
                if !state.active || state.generation != generation {
                    return;
                }
            }
            apply();
        });
        counts
    }

    pub fn deactivate() -> usize {
        let drained: Vec<(u32, Boosted)> = {
            let mut state = STATE.lock().unwrap();
            state.active = false;
            state.generation += 1;
            state.boosted.drain().collect()
        };
        if drained.is_empty() {
            return 0;
        }
        // Re-verify each pid is STILL one of our webview processes before
        // touching it: a pid can be recycled by an unrelated process between
        // boost and release, and priorities of strangers are not ours to set.
        let still_ours: std::collections::HashSet<u32> =
            our_webview_pids().into_iter().collect();
        let mut restored = 0;
        for (pid, boosted) in drained {
            if still_ours.contains(&pid) {
                restore_one(pid, boosted);
                restored += 1;
            }
        }
        restored
    }
}

/// Toggle the streaming priority boost. Returns the number of processes
/// currently boosted (activate) or restored (deactivate). Non-Windows: no-op —
/// the starvation this counters is a Windows foreground-scheduling behaviour.
#[tauri::command]
pub fn set_stream_boost(active: bool) -> Result<u32, String> {
    #[cfg(windows)]
    {
        if active {
            let n = imp::activate();
            log::info!("[stream-boost] on ({n} webview process(es))");
            Ok(n as u32)
        } else {
            let n = imp::deactivate();
            log::info!("[stream-boost] off ({n} webview process(es))");
            Ok(n as u32)
        }
    }
    #[cfg(not(windows))]
    {
        let _ = active;
        Ok(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(pid: u32, ppid: u32, name: &str) -> ProcRow {
        ProcRow { pid, ppid, name: name.into() }
    }

    /// Positive control: the walk CAN find a nested webview chain (browser →
    /// gpu/renderer), so the exclusion tests below are meaningful.
    #[test]
    fn finds_nested_webview_descendants() {
        let rows = vec![
            row(100, 1, "sovereign.exe"),
            row(200, 100, "msedgewebview2.exe"), // browser
            row(201, 200, "msedgewebview2.exe"), // gpu
            row(202, 200, "msedgewebview2.exe"), // renderer
        ];
        let mut got = descendants_named(&rows, 100, "msedgewebview2.exe");
        got.sort_unstable();
        assert_eq!(got, vec![200, 201, 202]);
    }

    #[test]
    fn excludes_unrelated_processes_and_other_names() {
        let rows = vec![
            row(100, 1, "sovereign.exe"),
            row(200, 100, "msedgewebview2.exe"),
            // Same exe name but under a DIFFERENT root (e.g. another app's
            // WebView2) — must not be touched.
            row(900, 1, "msedgewebview2.exe"),
            // Our child, but not a webview process.
            row(300, 100, "crashpad_handler.exe"),
        ];
        assert_eq!(descendants_named(&rows, 100, "msedgewebview2.exe"), vec![200]);
    }

    #[test]
    fn name_match_is_case_insensitive() {
        let rows = vec![row(200, 100, "MsEdgeWebView2.EXE")];
        assert_eq!(descendants_named(&rows, 100, "msedgewebview2.exe"), vec![200]);
    }

    /// Pid recycling can stitch cycles into the (pid, ppid) relation; the walk
    /// must terminate rather than loop.
    #[test]
    fn survives_ppid_cycles_and_self_parents() {
        let rows = vec![
            row(100, 200, "a.exe"), // 100's "parent" recycled to its own child
            row(200, 100, "msedgewebview2.exe"),
            row(300, 300, "msedgewebview2.exe"), // self-parented system row
        ];
        assert_eq!(descendants_named(&rows, 100, "msedgewebview2.exe"), vec![200]);
    }
}
