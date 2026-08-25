//! Puca host agent.
//!
//! A headless process that captures the screen and injects input without a
//! webview — the two things the desktop app cannot do unattended, because
//! `getDisplayMedia` requires a user gesture and a picker.
//!
//! WHAT THIS IS NOT: a second client. It never speaks WebSocket to the Puca
//! server, never holds the device key, and never decides whether a session may
//! exist. The desktop app keeps the socket and every authorization decision and
//! drives this over a local pipe. That split is what makes it safe to run
//! headless — compromising the agent yields the ability to drive the local
//! machine, which someone at the keyboard already has, NOT the ability to
//! authorise a remote session.
//!
//! Usage (a launcher starts it; it is not meant to be run by hand):
//!   puca-agent --token <per-launch-token> [--pipe <name>] [--parent-pid <pid>]
//!                    [--log <file>] [--flavour <any>] [--allow-sid <S-1-5-...>]
//!                    [--ua-record <path>]
//!
//! `--flavour` narrows what this process will do — see `flavour.rs`. It can only
//! ever take capabilities away, so omitting it is the full-capability desktop
//! agent that every install has run to date.

mod protocol;
mod session;
mod flavour;
mod control_key;
mod dll_search;
mod composite;
// Ungated, beside composite for the same reason: plain data used by code that
// compiles on every platform.
mod caret_wire;
mod privacy;
mod file_transfer;
mod input_wire;
mod file_log;

#[cfg(windows)]
mod ice;

#[cfg(windows)]
mod turn;

#[cfg(windows)]
mod stream;

#[cfg(windows)]
mod pipe;

/// Ctrl+Alt+Del, which no process but the SYSTEM service can raise.
#[cfg(windows)]
mod sas_client;
mod power;

#[cfg(windows)]
mod display_wake;

fn arg(name: &str) -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1).cloned())
}

/// Send everything this process writes to stderr into `path` instead.
///
/// WHY AT THE OS LEVEL rather than threading a logger through every module:
/// the agent already reports what matters — the ICE candidate summary, TURN
/// failures, ICE state changes, frame counts — via `eprintln!`. The problem is
/// nobody can read it. 0.8.5 added CREATE_NO_WINDOW so the agent stopped
/// popping a terminal, which also means it has no console and every one of
/// those lines goes nowhere. Rust's stderr resolves STD_ERROR_HANDLE on each
/// write, so swapping the handle here redirects all of them with no change at
/// the call sites and no chance of one being missed.
///
/// This is the fourth time this feature has failed silently, and the third time
/// diagnosing it has cost a round trip to the owner's machine because the one
/// process that knew the answer threw it away.
///
/// Failure to open the log is deliberately NOT fatal: an agent that refuses to
/// start because it could not write a log file would turn a diagnostic aid into
/// an outage.
#[cfg(windows)]
fn redirect_stderr_to(path: &str) {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::Console::{SetStdHandle, STD_ERROR_HANDLE};

    let file = match std::fs::OpenOptions::new().create(true).append(true).open(path) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("[agent] could not open log {path}: {e}");
            return;
        }
    };
    unsafe {
        let _ = SetStdHandle(STD_ERROR_HANDLE, HANDLE(file.as_raw_handle() as _));
    }
    // Leak the File on purpose: closing it would invalidate the handle we just
    // installed as the process-wide stderr, and this lives for the process.
    std::mem::forget(file);
    // ANCHOR THE LOG IN REAL TIME. Every other line is relative to process
    // start, and without this the file cannot be lined up with anything the
    // user reports ("it was laggy around four o'clock") or with the app's own
    // logs. Formatted by hand because the agent deliberately has no date crate.
    eprintln!(
        "--- puca-agent starting (pid {}) at {} ---",
        std::process::id(),
        wall_clock_now(),
    );
}

/// Wall clock as `YYYY-MM-DD HH:MM:SSZ`, from the one clock std exposes.
#[cfg(windows)]
fn wall_clock_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Civil-from-days (Howard Hinnant's algorithm): integer arithmetic, no
    // dependency, correct across leap years.
    let days = (secs / 86_400) as i64;
    let tod = secs % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02}Z",
        tod / 3600,
        (tod % 3600) / 60,
        tod % 60,
    )
}

/// Block until the process `pid` exits.
///
/// Returns immediately if the parent is already gone — which is the right
/// answer, not an error: being unable to open it means it is not running, and
/// an agent whose launcher has already died has nobody left to authorise a
/// session for it.
#[cfg(windows)]
fn watch_parent(pid: u32) {
    use windows::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
    use windows::Win32::System::Threading::{
        OpenProcess, WaitForSingleObject, INFINITE, PROCESS_SYNCHRONIZE,
    };
    unsafe {
        // SYNCHRONIZE only. The agent has no business reading or writing the
        // app's memory, and asking for rights it does not need is how a helper
        // process quietly becomes a privilege-escalation step.
        let Ok(handle) = OpenProcess(PROCESS_SYNCHRONIZE, false, pid) else {
            eprintln!("[agent] parent {pid} is already gone; exiting");
            return;
        };
        let reason = WaitForSingleObject(handle, INFINITE);
        let _ = CloseHandle(handle);
        if reason == WAIT_OBJECT_0 {
            eprintln!("[agent] parent {pid} exited; shutting down");
        } else {
            eprintln!("[agent] stopped waiting on parent {pid} ({reason:?}); shutting down");
        }
    }
}

fn main() {
    // FIRST, before anything that can load a library by bare name. This
    // process may be running as LocalSystem, where the application directory
    // sitting ahead of System32 in the search order is a privilege escalation
    // rather than a curiosity. Nothing may be added above this line.
    if !dll_search::harden() {
        eprintln!("[agent] WARNING: could not restrict the DLL search path");
    }
    privacy::init();
    // The token is REQUIRED. Defaulting to something would mean any local
    // process that knows the pipe name could drive OS input on this machine.
    let Some(token) = arg("--token") else {
        eprintln!("puca-agent: --token is required");
        eprintln!("This is launched by the Puca desktop app, not run by hand.");
        std::process::exit(2);
    };
    if token.len() < 16 {
        eprintln!("puca-agent: --token is too short to be a real launch token");
        std::process::exit(2);
    }

    let pipe_name = arg("--pipe").unwrap_or_else(|| {
        format!(r"\\.\pipe\sovereign-agent-{}", std::process::id())
    });

    // Before anything that might have something to report.
    #[cfg(windows)]
    if let Some(path) = arg("--log") {
        redirect_stderr_to(&path);
    }

    // DIE WITH THE APP.
    //
    // The agent used to outlive its launcher, and the app only calls
    // agent_stop() on a clean `RunEvent::Exit`. The NSIS updater KILLS the app
    // rather than exiting it — so every update left an orphan holding
    // puca-agent.exe open, and the NEXT install could not replace the file.
    // Each update broke the following one, silently: the installer reported it
    // could not install the agent, the old binary stayed, and the app went on
    // talking to a build several releases stale. Measured on the owner's machine:
    // two orphans, one six hours old whose parent was long dead, and a 0.8.6
    // install that left the 0.8.5 agent in place.
    //
    // Waiting on the parent's handle rather than polling for the pid means no
    // window where a recycled pid is mistaken for a live parent — the handle
    // stays valid and signalled once the process it names has exited, whatever
    // the pid gets reused for afterwards.
    #[cfg(windows)]
    if let Some(pid) = arg("--parent-pid").and_then(|p| p.parse::<u32>().ok()) {
        std::thread::spawn(move || {
            watch_parent(pid);
            // Release before dying: the app being gone must not strand a key
            // down in whatever window had focus.
            puca_input::release_all();
            std::process::exit(0);
        });
    }

    // Decided once, here, from the launch argument, and never re-read: a
    // capability answer that depends on argv at the point of use is one
    // std::env::set_var away from changing under a live session.
    let flavour = flavour::Flavour::parse(arg("--flavour").as_deref());
    eprintln!("[agent] flavour: {flavour:?}");

    #[cfg(windows)]
    {
        println!("puca-agent listening on {pipe_name}");
        // Told, never inferred. Only the service can launch this process at
        // all, and only it knows which account is at the console and has
        // already established that account is an administrator.
        let allow_sid = arg("--allow-sid");
        // The machine-scope unattended record. Only the service passes this,
        // and only for the headless flavour — a desktop agent is driven by
        // someone already at the keyboard and has nothing to gate.
        let ua_record = arg("--ua-record");
        if let Err(e) =
            pipe::serve(&pipe_name, token, flavour, allow_sid.as_deref(), ua_record.as_deref())
        {
            eprintln!("puca-agent: {e}");
            // Release anything a session left held before going away: a crash
            // mid-keypress must not strand a key down in another application.
            puca_input::release_all();
            std::process::exit(1);
        }
    }

    #[cfg(not(windows))]
    {
        let _ = (pipe_name, token);
        eprintln!("puca-agent: only implemented on Windows so far.");
        eprintln!("Linux hosting needs PipeWire/X11 capture and uinput injection.");
        std::process::exit(2);
    }
}
