//! Talking to the host agent.
//!
//! The app owns the agent's lifetime: it generates the per-launch token, starts
//! the process, and holds the only pipe connection. That is deliberate — the
//! agent is a capability the app lends itself, not an independent service. It
//! never speaks to the Puca server, so if the app is not running there is
//! nothing to authorise a session anyway.
//!
//! Everything here is synchronous and serialised behind one mutex. The command
//! rate is a handful per session (start, stop, occasional input) — the pixels
//! travel over UDP, not through this pipe — so a lock is simpler and safer than
//! a channel, and it makes "one request, one response" impossible to get wrong.

use std::io::{BufRead, BufReader, Write};
use std::sync::Mutex;

#[cfg(windows)]
use std::fs::OpenOptions;
#[cfg(windows)]
use std::os::windows::fs::OpenOptionsExt;

/// From WinBase.h. Not re-exported by the `windows` crate in a form
/// OpenOptionsExt::custom_flags takes, so they are spelled out here.
#[cfg(windows)]
const SECURITY_SQOS_PRESENT: u32 = 0x0010_0000;
#[cfg(windows)]
const SECURITY_IDENTIFICATION: u32 = 0x0001_0000;

/// Where the agent writes what it is doing.
///
/// Next to the binary rather than in a temp dir, so "send me the log" is a
/// path the user can find without being told how to expand an environment
/// variable — and so it survives a reboot.
fn agent_log_path() -> String {
    let dir = std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(std::env::temp_dir);
    dir.join("agent.log").to_string_lossy().to_string()
}

/// The agent binary, alongside the app executable.
fn agent_path() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let candidate = dir.join(if cfg!(windows) { "puca-agent.exe" } else { "puca-agent" });
    candidate.exists().then_some(candidate)
}

struct Connection {
    #[cfg(windows)]
    reader: BufReader<std::fs::File>,
    #[cfg(windows)]
    writer: std::fs::File,
    child: Option<std::process::Child>,
    pipe_name: String,
}

static CONN: Mutex<Option<Connection>> = Mutex::new(None);

/// When `CONN` last carried a successful exchange. Only meaningful for a
/// BORROWED connection (`child.is_none()`) — see `release_idle_borrowed_agent`.
static LAST_USED: Mutex<Option<std::time::Instant>> = Mutex::new(None);

/// How long a borrowed connection may sit idle before this app gives it back.
///
/// THE FIX FOR "All pipe instances are busy" (os error 231). The service's
/// agent pipe allows exactly ONE connected client
/// (`puca-agent/src/pipe.rs`, "two callers fighting over one mouse").
/// Before this, a borrowed connection was cached in `CONN` for the PROCESS
/// LIFETIME — released only on app exit or an I/O error — so once this app
/// borrowed the service's agent (which happens on ordinary UI paths: a probe,
/// a diagnose, any request while the console is locked with an administrator
/// signed in), it held the service's only pipe instance until the app closed.
/// The service's own link.rs, wanting that exact pipe to relay a remote
/// session while the console is locked, got ERROR_PIPE_BUSY every time —
/// reproduced three times in a row against the real machine.
///
/// Short enough that giving the pipe back is prompt once nobody is driving a
/// session; long enough that an ordinary burst of clicks and keystrokes
/// (routinely <200ms apart) does not thrash a reconnect between them, at
/// ~100ms per `connect()` attempt.
const IDLE_RELEASE_MS: u64 = 2_000;

/// Start the background thread that gives back an idle borrowed connection.
///
/// Started lazily, once, the first time this app actually borrows the
/// service's agent — the overwhelming majority of installs never do, and
/// spawning a thread that will never have anything to release is pure cost.
#[cfg(windows)]
fn ensure_reaper_running() {
    static STARTED: std::sync::Once = std::sync::Once::new();
    STARTED.call_once(|| {
        std::thread::spawn(|| loop {
            std::thread::sleep(std::time::Duration::from_millis(500));
            let idle_for = LAST_USED
                .lock()
                .ok()
                .and_then(|g| *g)
                .map(|t| t.elapsed().as_millis() as u64);
            let Some(idle_for) = idle_for else { continue };
            if idle_for < IDLE_RELEASE_MS {
                continue;
            }
            let Ok(mut guard) = CONN.lock() else { continue };
            // ONLY a borrowed connection (child.is_none()) is released this
            // way. This app's OWN agent (child.is_some()) holds a pipe named
            // for OUR pid that nothing else contends for, and killing that
            // connection between clicks would just make ordinary use of this
            // app's own capture agent stutter for no reason.
            if guard.as_ref().is_some_and(|c| c.child.is_none()) {
                eprintln!("[agent] giving back the idle borrowed system agent connection");
                *guard = None;
                if let Ok(mut lu) = LAST_USED.lock() {
                    *lu = None;
                }
            }
        });
    });
}

/// Random hex, from the OS. The token is what stops any local process driving
/// an agent that injects OS input, so it must not come from a weak source.
fn new_token() -> String {
    let mut bytes = [0u8; 24];
    getrandom(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(windows)]
fn getrandom(buf: &mut [u8]) {
    use windows::Win32::Security::Cryptography::{BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG};
    unsafe {
        let _ = BCryptGenRandom(None, buf, BCRYPT_USE_SYSTEM_PREFERRED_RNG);
    }
}

#[cfg(not(windows))]
fn getrandom(buf: &mut [u8]) {
    use std::io::Read;
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        let _ = f.read_exact(buf);
    }
}

#[cfg(windows)]
fn connect(pipe_name: &str, token: &str, attempts: u32) -> Result<Connection, String> {
    // The pipe may not exist for a moment after spawn. Retry briefly rather
    // than failing on a race the user would see as "the agent doesn't work".
    let mut last = String::new();
    for _ in 0..attempts {
        // SERVER may do with this client's token: it can identify us, but it
        // cannot impersonate us to open files or hit the network as this user.
        // Without it a squatting server gets to act as whoever connects. The
        // default when no SQOS is specified is impersonation.
        match OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION)
            .open(pipe_name)
        {
            Ok(handle) => {
                let writer = handle
                    .try_clone()
                    .map_err(|e| format!("could not clone the pipe handle: {e}"))?;
                let mut conn = Connection {
                    reader: BufReader::new(handle),
                    writer,
                    child: None,
                    pipe_name: pipe_name.to_string(),
                };
                // Authenticate immediately: an unauthenticated connection is
                // refused for every other command, so a failure here should
                // surface now rather than at the first real request.
                // 2 as of data_only / policy on the agent protocol. This literal
                // and puca_agent::protocol::PROTOCOL_VERSION are the two
                // halves of one number and must move together: they are compiled
                // separately, so nothing but this comment couples them.
                let hello = format!(
                    r#"{{"cmd":"hello","token":"{token}","version":2}}"#
                );
                let reply = exchange(&mut conn, &hello)?;
                if !reply.contains("\"ok\":\"hello\"") {
                    return Err(format!("the agent refused our token: {reply}"));
                }
                return Ok(conn);
            }
            Err(e) => {
                last = describe_open_error(&e);
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
        }
    }
    Err(format!("could not open {pipe_name}: {last}"))
}

/// Turn a failed pipe open into a message that names WHICH of three very
/// different problems happened, rather than a bare OS error number.
///
/// Before this, "not installed", "starting up" and "someone else is talking to
/// it" all produced the same shape of string — `e.to_string()` verbatim — and
/// only the raw number at the end told them apart, which nobody reads a log
/// looking for. `os error 231` (`ERROR_PIPE_BUSY`) is exactly the symptom that
/// went undiagnosed for three consecutive refused sessions on the SERVICE
/// side: THIS app was the other legitimate client, holding the agent's one
/// pipe instance for the process lifetime — see `ensure_reaper_running` for
/// the fix to that.
///
/// SAME LOGIC IN `crates/puca-service/src/agent_client.rs`, deliberately
/// duplicated rather than shared — the two crates share no dependency edge.
#[cfg(windows)]
fn describe_open_error(e: &std::io::Error) -> String {
    match e.raw_os_error() {
        // ERROR_PIPE_BUSY: the pipe exists and IS being served, but its one
        // instance is already connected to someone else — the service, most
        // likely, relaying a sign-in-screen session.
        Some(231) => format!("the agent is busy with another connection ({e})"),
        // ERROR_FILE_NOT_FOUND: no agent is listening under this name yet.
        Some(2) => format!("no agent is listening on that pipe yet ({e})"),
        // ERROR_ACCESS_DENIED: the pipe exists but this caller's SID is not on
        // its ACL.
        Some(5) => format!("this caller is not allowed to open that pipe ({e})"),
        _ => e.to_string(),
    }
}

#[cfg(not(windows))]
fn connect(_pipe_name: &str, _token: &str, _attempts: u32) -> Result<Connection, String> {
    Err("the host agent is only implemented on Windows".to_string())
}

#[cfg(windows)]
fn exchange(conn: &mut Connection, request: &str) -> Result<String, String> {
    conn.writer
        .write_all(format!("{request}\n").as_bytes())
        .map_err(|e| format!("could not write to the agent: {e}"))?;
    conn.writer.flush().ok();

    let mut line = String::new();
    conn.reader
        .read_line(&mut line)
        .map_err(|e| format!("could not read from the agent: {e}"))?;
    if line.trim().is_empty() {
        return Err("the agent closed the connection".to_string());
    }
    Ok(line.trim().to_string())
}

#[cfg(not(windows))]
fn exchange(_conn: &mut Connection, _request: &str) -> Result<String, String> {
    Err("the host agent is only implemented on Windows".to_string())
}

/// Start the agent if it is not already running, and connect.
///
/// `connect_attempts` bounds the pipe-open retry (100ms each). The explicit
/// probe paths keep the long window — an agent starting for the first time
/// under AV scanning can honestly take seconds. The per-request path passes a
/// SHORT one: it runs while a session is live, every other agent call queues
/// behind it, and a dead agent that needs 20s to be declared dead reads as
/// "input frozen for 20 seconds" on the controller.
fn ensure_started(connect_attempts: u32) -> Result<(), String> {
    let mut guard = CONN.lock().map_err(|_| "agent lock poisoned".to_string())?;
    if guard.is_some() {
        return Ok(());
    }
    // ASK THE SERVICE FIRST, if one is installed at all.
    //
    // An agent this app launches runs on this app's token, and a user-token
    // process cannot see the lock screen, the sign-in screen, or a UAC prompt.
    // The optional system service runs an agent as SYSTEM for exactly the window
    // where that matters — while the console is locked or nobody is signed in —
    // and stops it again on unlock. So borrowing its agent whenever it offers
    // one, and launching our own otherwise, tracks the lock state exactly
    // without this function ever asking what the lock state is.
    //
    // Costs nothing on the overwhelming majority of machines: the service is
    // opt-in, the pipe does not exist, and the open fails immediately.
    #[cfg(windows)]
    if let Some(borrowed) = crate::service_link::borrow_system_agent() {
        // No child process: this agent belongs to the service, which started it
        // and will stop it. Recording one here would make `agent_stop` kill
        // something it does not own — and on unlock the service would relaunch
        // it, leaving two.
        match connect(&borrowed.pipe, &borrowed.token, connect_attempts) {
            Ok(conn) => {
                eprintln!("[agent] using the system service's agent (it can see the lock screen)");
                *guard = Some(conn);
                if let Ok(mut lu) = LAST_USED.lock() {
                    *lu = Some(std::time::Instant::now());
                }
                ensure_reaper_running();
                return Ok(());
            }
            // Fall through to our own agent. The service may have stopped its
            // one between the answer and the dial — an unlock does exactly
            // that — and in that state our own agent is the correct one anyway.
            Err(e) => eprintln!("[agent] the service offered an agent but it did not answer: {e}"),
        }
    }

    let path = agent_path().ok_or_else(|| {
        "no host agent is installed alongside this app".to_string()
    })?;

    let token = new_token();
    let pipe_name = format!(r"\\.\pipe\sovereign-agent-{}", std::process::id());

    // CREATE_NO_WINDOW: the agent is a console binary, so spawning it without
    // this pops a terminal in the user's face every time they start a session —
    // reported from real use. It also means the agent inherits no console, which
    // is what a background helper should have.
    #[cfg(windows)]
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    // --parent-pid is what stops the agent outliving us.
    //
    // agent_stop() only runs on a clean RunEvent::Exit, and the NSIS updater
    // KILLS this process rather than exiting it — so every update used to leave
    // an orphaned agent holding puca-agent.exe open, and the NEXT install
    // could not replace the file. Each update broke the following one, and the
    // only symptom was an installer complaining it could not install the agent
    // while the app carried on driving a binary several releases old.
    let mut cmd = std::process::Command::new(&path);
    let my_pid = std::process::id().to_string();
    let log = agent_log_path();
    cmd.args([
        "--token", &token,
        "--pipe", &pipe_name,
        "--parent-pid", &my_pid,
        "--log", &log,
    ]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let child = cmd
        .spawn()
        .map_err(|e| format!("could not start the host agent: {e}"))?;

    match connect(&pipe_name, &token, connect_attempts) {
        Ok(mut conn) => {
            conn.child = Some(child);
            *guard = Some(conn);
            Ok(())
        }
        Err(e) => {
            // Do not leave an orphan holding a screen capture.
            let mut child = child;
            let _ = child.kill();
            Err(e)
        }
    }
}

/// The probe/diagnose window: a cold agent start under AV scanning.
const CONNECT_ATTEMPTS_PROBE: u32 = 200; // 20s
/// The in-session window: fail fast, the next probe can do the long start.
const CONNECT_ATTEMPTS_REQUEST: u32 = 15; // 1.5s

/// Is a host agent available on this machine?
///
/// Answering false is a normal outcome, not an error — the webview host is the
/// fallback, and reporting a failure here would make the Devices UI look broken
/// on every machine without an agent installed.
/// MUST stay async + spawn_blocking: a cold agent start (or a 20s failed one)
/// on a SYNC command runs on the main thread and freezes the whole window —
/// the same hazard list_anticheat_processes documents.
#[tauri::command]
pub async fn agent_probe() -> bool {
    if agent_path().is_none() {
        return false;
    }
    tauri::async_runtime::spawn_blocking(|| ensure_started(CONNECT_ATTEMPTS_PROBE).is_ok())
        .await
        .unwrap_or(false)
}

/// WHY the agent is or is not usable, in words, for the Devices screen.
///
/// agent_probe answers a bare yes/no and throws the reason away. That was
/// defensible while no installer shipped an agent — false meant "not installed"
/// and there was nothing to explain. Since 0.8.4 ships one, false now means
/// something WENT WRONG, and the only symptom the user gets is the browser's
/// screen picker appearing on a machine that is supposed to capture directly.
///
/// Diagnosing that took five rounds of guessing between the author and the
/// owner, because the one process that knew the answer discarded it. It is the
/// fourth silent failure found in this feature; the others were a passphrase
/// that enforced nothing, an update that failed without saying so, and a
/// controller that waited forever without saying why.
#[tauri::command]
pub async fn agent_diagnose() -> String {
    let Some(path) = agent_path() else {
        return "No capture agent is installed next to the app. Reinstall Puca \
                and restart it — screen sharing will fall back to asking you to pick \
                a window until it is present."
            .to_string();
    };
    let started = tauri::async_runtime::spawn_blocking(|| ensure_started(CONNECT_ATTEMPTS_PROBE))
        .await
        .unwrap_or_else(|e| Err(format!("probe task failed: {e}")));
    match started {
        // The PATH TO THE LOG, not just "ready".
        //
        // "Direct capture ready" was true and useless: it says the agent
        // started, which is the one part that was never broken by the time it
        // mattered. Whether a session actually works is decided afterwards, by
        // what ICE candidates the agent gathers — and that was reported only to
        // a console that CREATE_NO_WINDOW guarantees does not exist. Naming the
        // file here is what turns "still doesn't work" into something readable
        // without another round trip.
        Ok(()) => format!(
            "Direct capture ready ({}). If a session still fails, the details are in {}.",
            path.display(),
            agent_log_path(),
        ),
        Err(e) => format!(
            "The capture agent is installed at {} but would not start: {e}. \
             Screen sharing is falling back to asking you to pick a window.",
            path.display()
        ),
    }
}

/// Append one line to the agent log, from the webview side.
///
/// The agent logs what IT did; only the app knows which host backend was
/// chosen, and the interesting failure is the app deciding not to use the agent
/// at all. That decision produced the browser's screen picker and left no trace
/// anywhere — so both halves belong in one file, in order.
///
/// Bounded and newline-stripped: this appends to a file a user is asked to send
/// back, so an unbounded or multi-line string from the webview would let one
/// call forge arbitrary log content.
#[tauri::command]
pub fn agent_log(line: String) {
    let line: String = line.chars().filter(|c| *c != '\n' && *c != '\r').take(2000).collect();
    let path = agent_log_path();
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        use std::io::Write;
        let _ = writeln!(f, "{line}");
    }
}

/// Send one JSON request to the agent and return its JSON response.
///
/// The whole command set is passed through rather than mirrored as individual
/// Tauri commands: the agent's protocol is already the contract, and wrapping
/// each command would mean two places to change for every addition.
/// MUST stay async + spawn_blocking. This used to be a sync command: it ran on
/// the MAIN THREAD, once per input event during a control session, holding the
/// pipe mutex across a blocking write+read — and after an agent crash the
/// in-line reconnect could park the whole window (and every queued input
/// event behind the mutex) for up to 20 seconds. Off the main thread, with the
/// reconnect bounded to 1.5s, a dead agent costs one short stall instead.
#[tauri::command]
pub async fn agent_request(request: String) -> Result<String, String> {
    // Bound it: this crosses into a process that injects OS input, and an
    // unbounded string from the webview is a needless hazard.
    if request.len() > 256 * 1024 {
        return Err("agent request too large".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || agent_request_blocking(&request))
        .await
        .map_err(|e| format!("agent task failed: {e}"))?
}

fn agent_request_blocking(request: &str) -> Result<String, String> {
    ensure_started(CONNECT_ATTEMPTS_REQUEST)?;
    let mut guard = CONN.lock().map_err(|_| "agent lock poisoned".to_string())?;
    let conn = guard.as_mut().ok_or_else(|| "the agent is not connected".to_string())?;

    match exchange(conn, request) {
        Ok(reply) => {
            // Reset the idle clock on every successful exchange, so the reaper
            // never releases a connection mid-session — only once activity has
            // genuinely stopped for IDLE_RELEASE_MS.
            if let Ok(mut lu) = LAST_USED.lock() {
                *lu = Some(std::time::Instant::now());
            }
            Ok(reply)
        }
        Err(e) => {
            // A broken pipe means the agent died. Drop the connection so the
            // next call restarts it, rather than failing forever against a
            // handle that will never answer.
            if let Some(mut c) = guard.take() {
                if let Some(mut child) = c.child.take() {
                    let _ = child.kill();
                }
                let _ = c.pipe_name;
            }
            Err(e)
        }
    }
}

/// Stop the agent (on app exit, or when hosting is disarmed).
#[tauri::command]
pub fn agent_stop() {
    let Ok(mut guard) = CONN.lock() else { return };
    if let Some(mut conn) = guard.take() {
        if let Some(mut child) = conn.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn a_busy_pipe_reads_differently_from_a_missing_or_forbidden_one() {
        // Same fix, same reasoning as puca-service's copy: "not
        // installed", "starting up" and "someone else has it" used to all
        // read as `e.to_string()` verbatim, with only a trailing OS number
        // telling them apart.
        let busy = std::io::Error::from_raw_os_error(231);
        let missing = std::io::Error::from_raw_os_error(2);
        let denied = std::io::Error::from_raw_os_error(5);
        let other = std::io::Error::new(std::io::ErrorKind::Other, "some other failure");

        let texts = [
            describe_open_error(&busy),
            describe_open_error(&missing),
            describe_open_error(&denied),
            describe_open_error(&other),
        ];
        assert!(texts[0].contains("busy with another connection"), "{}", texts[0]);
        assert!(texts[1].contains("no agent is listening"), "{}", texts[1]);
        assert!(texts[2].contains("not allowed"), "{}", texts[2]);

        for (i, a) in texts.iter().enumerate() {
            for b in texts.iter().skip(i + 1) {
                assert_ne!(a, b, "two different causes must not read the same");
            }
        }
    }

    #[test]
    fn a_borrowed_connection_is_the_only_kind_the_reaper_may_release() {
        // THE DISCRIMINATOR THE WHOLE FIX RESTS ON: `child.is_none()` means
        // "borrowed from the service", `child.is_some()` means "this app's
        // own agent, which nothing else contends for". Pinned directly
        // because getting this backwards would make the reaper release the
        // WRONG connection — killing this app's own live capture session
        // instead of giving back a pipe instance someone else needs.
        //
        // connect() always returns child: None; only ensure_started's own-
        // agent branch sets Some(child) after spawning. This test cannot
        // drive a real Connection (that needs a live pipe), so it pins the
        // invariant `connect()` establishes: the field the reaper reads is
        // the SAME field ensure_started sets, not a second copy that could
        // drift.
        let src = include_str!("agent_ipc.rs").split("#[cfg(all(test").next().unwrap();
        assert!(
            src.contains("child: None,"),
            "connect() must construct every fresh connection as borrowed by default"
        );
        assert!(
            src.contains("conn.child = Some(child);"),
            "only spawning our OWN agent may mark a connection as not-borrowed"
        );
        assert!(
            src.contains("if guard.as_ref().is_some_and(|c| c.child.is_none())"),
            "the reaper must gate on the exact same field, read the exact same way"
        );
    }
}
