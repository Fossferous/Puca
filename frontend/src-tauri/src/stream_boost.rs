//! CPU AND GPU scheduling-priority boost for the WebView2 capture/encode
//! processes while someone is WATCHING a live capture from this machine
//! (voice screen share, device-control host capture).
//!
//! Why, and why twice: field-confirmed 2026-08-20 — an uncapped fullscreen
//! game gets Windows' foreground CPU scheduling boost while the share
//! pipeline sits at NORMAL, so v0.8.111 raised WebView2's child processes to
//! ABOVE_NORMAL_PRIORITY_CLASS. Field-confirmed 2026-08-21 that alone was
//! NOT enough — the user's own log showed `qualityLimitationReason` never
//! once reporting `cpu`, and Task Manager showed the GAME (not dwm.exe)
//! pegging the GPU's 3D engine at 100% even in borderless (so it isn't an
//! exclusive-fullscreen/independent-flip compositor bypass either). CPU
//! thread priority and GPU ENGINE scheduling priority are two separate
//! Windows subsystems — SetPriorityClass only ever touched the first. This
//! adds the second: D3DKMTSetProcessSchedulingPriorityClass, the same
//! GDI32.dll-exported, Microsoft-documented (learn.microsoft.com WDK DDI
//! reference) call OBS Studio uses for exactly this failure mode ("prevent
//! being deprioritized by Windows over fullscreen games" — see
//! obs-studio@ec769ef). Resolved dynamically via GetProcAddress, matching
//! OBS's own approach, so a Windows version without it (or a restricted
//! environment) degrades to CPU-only boost rather than failing.
//!
//! UNVERIFIED, by design logged rather than assumed: whether raising
//! ANOTHER process's GPU priority (as opposed to your own, which is what
//! OBS's traced call site does) needs elevation on a machine running
//! unelevated, as Puca always does. `try_boost_gpu`'s failure log below
//! is the read: NTSTATUS 0 (STATUS_SUCCESS) on this machine means it worked
//! with no elevation; a nonzero status is the machine telling us it needs more.
//!
//! What it does: while active, every descendant `msedgewebview2.exe` of this
//! app process is raised to ABOVE_NORMAL_PRIORITY_CLASS (CPU) and, where the
//! call succeeds, D3DKMT_SCHEDULINGPRIORITYCLASS_HIGH (GPU) — HIGH rather
//! than REALTIME because REALTIME is documented as typically privileged and
//! this app does not run elevated; renderer = software encoder, GPU process
//! = capture copy + composition, utility = the video-capture service. A
//! re-apply tick catches processes Chromium spawns or re-prioritises
//! mid-share. On release, each process is restored to the CPU class it had
//! (GPU priority has no queryable "previous value" resolved here, so it is
//! reset to NORMAL, the OS default for a freshly spawned process) — after
//! re-checking it is STILL one of our webview processes, so a recycled pid
//! is never touched.
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
    /// Whether the GPU scheduling-priority call succeeded for this pid (so
    /// release knows to reset it — there is no cheap "previous value" to
    /// query back, see the module doc).
    gpu_applied: bool,
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
    use windows::Win32::Foundation::{CloseHandle, HANDLE, NTSTATUS};
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
    use windows::Win32::System::Threading::{
        GetPriorityClass, OpenProcess, SetPriorityClass, ABOVE_NORMAL_PRIORITY_CLASS,
        NORMAL_PRIORITY_CLASS, PROCESS_CREATION_FLAGS, PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_SET_INFORMATION,
    };

    const WEBVIEW_EXE: &str = "msedgewebview2.exe";

    /// D3DKMT_SCHEDULINGPRIORITYCLASS (d3dkmthk.h) — a WDK/driver-facing enum,
    /// not part of the `windows` crate's win32metadata-generated bindings
    /// (confirmed: it lives under learn.microsoft.com's "Windows drivers" WDK
    /// DDI reference, not the public Win32 API reference), so it is declared
    /// here to match the documented declaration order exactly: IDLE,
    /// BELOW_NORMAL, NORMAL, ABOVE_NORMAL, HIGH, REALTIME = 0..5.
    #[repr(i32)]
    #[allow(dead_code)]
    enum GpuPriorityClass {
        Idle = 0,
        BelowNormal = 1,
        Normal = 2,
        AboveNormal = 3,
        High = 4,
        /// Not used here: documented behavior (and OBS's own "not admin?"
        /// fallback comment) suggests it typically needs elevation, which
        /// this app does not run under.
        #[allow(dead_code)]
        Realtime = 5,
    }

    type SetGpuPriorityFn = unsafe extern "system" fn(HANDLE, i32) -> NTSTATUS;

    /// Resolve D3DKMTSetProcessSchedulingPriorityClass from Gdi32.dll once.
    /// GetModuleHandleW (not LoadLibraryW): gdi32.dll is already loaded in
    /// any GUI process, so this never adds a new DLL dependency and never
    /// fails for a reason other than "this Windows build lacks the export."
    fn gpu_priority_fn() -> Option<SetGpuPriorityFn> {
        static ADDR: std::sync::OnceLock<Option<usize>> = std::sync::OnceLock::new();
        let addr = *ADDR.get_or_init(|| unsafe {
            let module = GetModuleHandleW(windows::core::w!("gdi32.dll")).ok()?;
            let proc = GetProcAddress(
                module,
                windows::core::s!("D3DKMTSetProcessSchedulingPriorityClass"),
            )?;
            Some(proc as usize)
        });
        // SAFETY: transmuting a resolved GetProcAddress result to the exact
        // signature documented for this export (learn.microsoft.com
        // nf-d3dkmthk-d3dkmtsetprocessschedulingpriorityclass).
        addr.map(|a| unsafe { std::mem::transmute::<usize, SetGpuPriorityFn>(a) })
    }

    /// Attempt the GPU priority raise on an already-open handle. On failure,
    /// logs the NTSTATUS — but only ONCE ever (not once per pid per 10s
    /// sweep, which would spam the log for the whole session if this needs
    /// elevation on this machine): the per-activation summary line in
    /// `set_stream_boost` already reports the live success COUNT every
    /// toggle, so the detailed NTSTATUS only needs to be captured once to
    /// answer the module header's open question.
    fn try_boost_gpu(handle: HANDLE, pid: u32) -> bool {
        let Some(f) = gpu_priority_fn() else { return false };
        // SAFETY: handle is a live, still-owned process handle for the
        // duration of this call (caller holds it open); f's signature is the
        // documented NTSTATUS(HANDLE, D3DKMT_SCHEDULINGPRIORITYCLASS).
        let status = unsafe { f(handle, GpuPriorityClass::High as i32) };
        let ok = status.0 == 0;
        if !ok {
            static LOGGED_ONCE: std::sync::OnceLock<()> = std::sync::OnceLock::new();
            LOGGED_ONCE.get_or_init(|| {
                log::info!("[stream-boost] GPU priority raise for pid {pid} returned NTSTATUS {:#x} (elevation?) — logged once, see the per-toggle summary line for the ongoing count", status.0);
            });
        }
        ok
    }

    fn try_restore_gpu(handle: HANDLE) {
        if let Some(f) = gpu_priority_fn() {
            // SAFETY: as in try_boost_gpu.
            let _ = unsafe { f(handle, GpuPriorityClass::Normal as i32) };
        }
    }

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

    /// Raise `pid`'s CPU priority to ABOVE_NORMAL and attempt its GPU
    /// scheduling priority too. Returns what actually changed, when
    /// anything did, so it can be restored later.
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
            let gpu_applied = try_boost_gpu(handle, pid);
            let _ = CloseHandle(handle);
            (cpu_changed || gpu_applied).then_some(Boosted { cpu_old, gpu_applied })
        }
    }

    fn restore_one(pid: u32, boosted: Boosted) {
        // SAFETY: as in boost_one.
        unsafe {
            if let Ok(handle) =
                OpenProcess(PROCESS_SET_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
            {
                let _ = SetPriorityClass(handle, PROCESS_CREATION_FLAGS(boosted.cpu_old));
                if boosted.gpu_applied {
                    try_restore_gpu(handle);
                }
                let _ = CloseHandle(handle);
            }
        }
    }

    /// Boost every current webview descendant not already boosted. Returns
    /// (processes currently held boosted, of those, how many got the GPU
    /// priority raise too — the number that answers the module header's
    /// open question about whether this needs elevation on this machine).
    fn apply() -> (usize, usize) {
        let pids = our_webview_pids();
        let mut state = STATE.lock().unwrap();
        if !state.active {
            return (0, 0); // released while we were snapshotting — don't re-boost
        }
        for pid in pids {
            // Called for pids we've ALREADY boosted too: Chromium re-asserts
            // its own child priorities on its own events (visibility, audio)
            // and can slide a process back to NORMAL mid-share — boost_one
            // re-lifts exactly that case. and_modify/or_insert: cpu_old must
            // stay the FIRST-seen original class (a re-sweep of an
            // already-lifted pid would read back ABOVE_NORMAL as "old",
            // corrupting the restore target) — but gpu_applied is OR'd
            // forward, so a GPU raise that only succeeds on a LATER sweep
            // (e.g. a transient failure, or a newly spawned utility process)
            // still gets reset on release rather than silently skipped.
            if let Some(new) = boost_one(pid) {
                state.boosted.entry(pid)
                    .and_modify(|b| b.gpu_applied = b.gpu_applied || new.gpu_applied)
                    .or_insert(new);
            }
        }
        let gpu_ok = state.boosted.values().filter(|b| b.gpu_applied).count();
        (state.boosted.len(), gpu_ok)
    }

    pub fn activate() -> (usize, usize) {
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
            let (n, gpu_ok) = imp::activate();
            log::info!("[stream-boost] on ({n} webview process(es), {gpu_ok} with GPU priority raised)");
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
