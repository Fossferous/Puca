//! The Puca unattended-access service binary.
//!
//! Runs as LocalSystem. It makes NO capture or injection itself — it only keeps
//! an agent alive in the right session as the machine logs in/out, locks/unlocks
//! and switches the console, using the pure [`Supervisor`] to decide and the
//! [`launch`] layer to act. This is the piece that can only be exercised once
//! installed; the decision logic and the launch mechanism it drives are already
//! tested (the supervisor exhaustively, the launch path by spike S5).
//!
//! NOT YET WIRED, and called out so it is not mistaken for done: the agent↔service
//! authorization IPC (named pipe with an SDDL and a per-launch token, per the
//! plan) and the unattended-passphrase gate (crates/puca-ua) are not
//! connected here. This binary proves the LIFECYCLE — that the right agent runs
//! in the right place at the right time — which is the untestable-until-installed
//! half. The agent it launches currently receives only its session/flavour on the
//! command line; the sealed control channel is the next increment.

#[cfg(not(windows))]
fn main() {
    eprintln!("puca-service is Windows-only: it is a Windows service.");
    std::process::exit(2);
}

#[cfg(windows)]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    // FIRST, before anything that can load a library by bare name. This process
    // runs as LocalSystem, where the application directory sitting ahead of
    // System32 in the DLL search order is a privilege escalation rather than a
    // curiosity. Nothing may be added above this line.
    // stderr rather than the service log: `service_log` lives inside the SCM
    // run body, and hoisting it out to reach here would put a file write above
    // the line that says nothing may go above it. The subcommand paths (install,
    // uninstall) have a console and will show this; the SCM path has none, which
    // is acceptable because the unit test asserts the call succeeds — a failure
    // here would be caught before it ever reached a machine.
    if !puca_service::dll_search::harden() {
        eprintln!("WARNING: could not restrict the DLL search path");
    }

    // Subcommands let the one binary install/remove itself (the elevated helper
    // the app shells out to), while NO argument is the path the SCM takes when
    // it launches the service — `service_dispatcher::start` only succeeds there.
    match std::env::args().nth(1).as_deref() {
        Some("install") => {
            let exe = std::env::current_exe()?;
            puca_service::install::install(&exe)?;
            println!("installed and started {} ({})", puca_service::SERVICE_NAME, exe.display());
            Ok(())
        }
        // THE OPT-IN ENTRY POINT. Nothing installs this service as part of
        // shipping the app: it exists on a machine only because somebody
        // deliberately turned it on, approved a UAC prompt, and this ran.
        //
        // Takes the agent's path rather than guessing it, because the app knows
        // where its own sidecar is and this binary — running elevated from a
        // temporary copy — does not.
        Some("provision") => {
            let agent = std::env::args().nth(2).ok_or(
                "usage: puca-service provision <path-to-puca-agent.exe>",
            )?;
            let me = std::env::current_exe()?;
            let installed = puca_service::provision::provision_and_install(
                &me,
                std::path::Path::new(&agent),
            )?;
            println!("installed {} at {}", puca_service::SERVICE_NAME, installed.display());
            Ok(())
        }
        // Replace the installed binaries with this build's, keeping the
        // registration, the enrolment and the arming record. The app shells
        // out to THIS (freshly-updated, bundled) binary elevated, so the copy
        // source is always the newest build. One UAC prompt.
        Some("update") => {
            let agent = std::env::args().nth(2).ok_or(
                "usage: puca-service update <path-to-puca-agent.exe>",
            )?;
            let me = std::env::current_exe()?;
            println!(
                "{}",
                puca_service::provision::update_binaries(
                    &me,
                    std::path::Path::new(&agent),
                )?
            );
            Ok(())
        }
        // "Off": the service is stopped, deleted, and its binaries removed.
        //
        // This deliberately KEEPS `secrets/` — this machine's enrolment — so
        // that toggling the feature off and on again does not force a
        // re-enrolment (see `provision::deprovision`, and the bug that cost
        // three of them). That is a real convenience and it is why the comment
        // that used to sit here — "must leave nothing behind, or 'off' is a
        // claim rather than a state" — was describing an intention this
        // command has never implemented. Use `deprovision-forget` for the
        // version that genuinely leaves nothing.
        Some("deprovision") => {
            println!("{}", puca_service::provision::deprovision()?);
            Ok(())
        }
        // "Off, and forget this machine too." One elevated run, so the app can
        // offer it as a single action rather than two consecutive UAC prompts.
        Some("deprovision-forget") => {
            println!("{}", puca_service::provision::deprovision_and_forget()?);
            Ok(())
        }
        Some("uninstall") => {
            puca_service::install::uninstall()?;
            println!("uninstalled {}", puca_service::SERVICE_NAME);
            Ok(())
        }
        Some("status") => {
            match puca_service::install::status()? {
                Some(state) => println!("{}: {state:?}", puca_service::SERVICE_NAME),
                None => println!("{}: not installed", puca_service::SERVICE_NAME),
            }
            Ok(())
        }
        Some("run") | None => windows_impl::run(),
        Some(other) => {
            eprintln!("unknown command {other:?}; use provision <agent> | update <agent> | deprovision | deprovision-forget | status | install | uninstall | run");
            std::process::exit(2);
        }
    }
}

#[cfg(windows)]
mod windows_impl {
    use std::collections::HashMap;
    use std::ffi::OsString;
    use std::path::PathBuf;
    use std::sync::mpsc;
    use std::time::Duration;

    use windows_service::service::{
        ServiceControl, ServiceControlAccept, ServiceExitCode, ServiceState, ServiceStatus,
        ServiceType, SessionChangeReason,
    };
    use windows_service::service_control_handler::{self, ServiceControlHandlerResult};
    use windows_service::{define_windows_service, service_dispatcher};

    use puca_service::launch::{
        active_console_session, launch_as_system_in_session, AgentProcess,
    };
    use puca_service::control_pipe::{self, Accepted, ServiceView};
    use puca_service::launch_id;
    use puca_service::restart::{RestartDecision, RestartPolicy};
    use puca_service::supervisor::{Action, AgentFlavour, SessionEvent, Supervisor};
    use puca_service::wts::is_user_logged_on;
    use puca_service::SERVICE_NAME;

    /// How often to check that the agent we believe is running actually is. A
    /// crashed agent otherwise stays "running" in our model until the next
    /// session change, which could be hours.
    const LIVENESS_INTERVAL: Duration = Duration::from_secs(2);

    /// Milliseconds since the service started. Used only for restart backoff,
    /// so a steady tick matters more than wall-clock accuracy.
    fn uptime_ms(start: std::time::Instant) -> u64 {
        start.elapsed().as_millis() as u64
    }

    /// Append a line to the service log.
    ///
    /// The implementation moved to `puca_service::log` so the link — which
    /// lives in the library — writes to the SAME file rather than opening a
    /// second one. Two logs for one service is how a timeline gets lost.
    fn service_log(msg: &str) {
        puca_service::log::line(msg)
    }

    define_windows_service!(ffi_service_main, service_main);

    pub fn run() -> Result<(), Box<dyn std::error::Error>> {
        // Hands control to the SCM, which calls back into service_main.
        service_dispatcher::start(SERVICE_NAME, ffi_service_main)?;
        Ok(())
    }

    fn service_main(_args: Vec<OsString>) {
        if let Err(e) = run_service() {
            // No console as a service; the SCM records the failure exit code,
            // and once IPC lands this becomes a structured log line.
            eprintln!("[puca-service] fatal: {e}");
        }
    }

    /// Internal messages from the SCM control handler to the worker loop.
    enum Msg {
        Session(SessionEvent),
        /// Something a local client asked for and the control policy allowed.
        /// Routed through the SAME channel as SCM events so the worker loop
        /// stays the only place that touches agents — a second mutator would
        /// need locking and would be a second place for bugs to live.
        Control(Accepted),
        Stop,
    }

    /// Translate an SCM session-change notification into a supervisor event.
    ///
    /// `ConsoleConnect` needs the session's logged-on state, which the handler
    /// queries here (a fast WTS call). Lock state is not queried — it is assumed
    /// unlocked and corrected by the next Lock/Unlock (see `wts`). Reasons we do
    /// not act on (remote connect/disconnect, session create/terminate) map to
    /// `None` so v1 stays focused on the physical console.
    fn map_session_change(reason: SessionChangeReason, session: u32) -> Option<SessionEvent> {
        match reason {
            SessionChangeReason::ConsoleConnect => Some(SessionEvent::ConsoleConnect {
                session,
                logged_on: is_user_logged_on(session),
                locked: false,
            }),
            SessionChangeReason::ConsoleDisconnect => {
                Some(SessionEvent::ConsoleDisconnect { session })
            }
            SessionChangeReason::SessionLogon => Some(SessionEvent::Logon { session }),
            SessionChangeReason::SessionLogoff => Some(SessionEvent::Logoff { session }),
            SessionChangeReason::SessionLock => Some(SessionEvent::Lock { session }),
            SessionChangeReason::SessionUnlock => Some(SessionEvent::Unlock { session }),
            _ => None,
        }
    }

    /// Where the agent binary lives: beside the service executable, full stop.
    ///
    /// This used to consult `%ProgramData%\Sovereign\agent.path` and run
    /// whatever it named. That indirection decided what a LocalSystem service
    /// executes on the interactive desktop, and `C:\ProgramData` lets any
    /// standard user create the `Sovereign` folder and own it — so it was a
    /// privilege escalation from "can log in" to "owns the machine".
    ///
    /// It was guarded twice and both guards were wrong. The first compared
    /// lowercased string prefixes, so `C:\Program Files Evil\x.exe` passed. The
    /// second canonicalised the path but the caller then launched the ORIGINAL
    /// string, so a directory junction (no privilege required) could resolve
    /// into Program Files for the check and be repointed at an attacker's binary
    /// afterwards — and `agent_exe_path` is called ONCE at service start and its
    /// result reused for the process lifetime, so the swap lasted forever.
    ///
    /// The feature earning that risk: a doc comment claimed "the installer
    /// writes it", and nothing in this repository ever did — not the installer,
    /// not any script. Its only real use was pointing the one-time install
    /// checkpoint at an inert stub, and that checkpoint passed on 2026-07-29.
    ///
    /// So it is gone. Not guarded a third time — deleted. The agent is the file
    /// next to the service binary, which lives wherever the service was
    /// installed; replacing it requires the same privilege as installing the
    /// service in the first place, which is the property we actually wanted.
    /// A future checkpoint swaps that file instead, needing no new mechanism.
    fn agent_exe_path() -> PathBuf {
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join(puca_service::INSTALLED_AGENT_EXE)))
            .unwrap_or_else(|| PathBuf::from(puca_service::INSTALLED_AGENT_EXE))
    }


    /// Where the SYSTEM agent's stderr goes. Beside service.log, same
    /// visibility rules. None only when %ProgramData% is unresolvable, in
    /// which case the agent simply runs unlogged as it always used to.
    fn agent_log_path() -> Option<String> {
        let dir = std::env::var("ProgramData").ok()?;
        let dir = std::path::Path::new(&dir).join("Sovereign");
        let _ = std::fs::create_dir_all(&dir);
        Some(dir.join("agent-system.log").to_string_lossy().into_owned())
    }

    /// Roll the agent log at 5 MB, AT LAUNCH TIME. Honest about the bound:
    /// this caps what each new agent INHERITS, not what one writes — a
    /// marathon agent (a machine that stays locked for days with the same
    /// process) appends past the threshold until its next relaunch, because
    /// rotating under a live writer just renames the file its open handle
    /// follows. The agent's own output is deliberately rate-limited (the
    /// stream logs on a frames-sent cadence, notices are once-per-condition),
    /// so in practice this holds the pair to ~10 MB; it is not a hard
    /// ceiling. Delete-then-rename because Windows `rename` refuses an
    /// existing destination; a rename failure after the delete costs the
    /// archive generation, which is worth one line in the service log rather
    /// than silence — but never the launch.
    fn rotate_agent_log(path: &std::path::Path) {
        const MAX_BYTES: u64 = 5 * 1024 * 1024;
        let Ok(meta) = std::fs::metadata(path) else { return };
        if meta.len() < MAX_BYTES {
            return;
        }
        let old = path.with_extension("log.old");
        let _ = std::fs::remove_file(&old);
        if let Err(e) = std::fs::rename(path, &old) {
            service_log(&format!(
                "could not rotate {}: {e} (the previous archive is gone and the log keeps growing)",
                path.display()
            ));
        }
    }

    /// Launch an agent of `flavour` in `session`. Returns None on a launch error
    /// (e.g. the user logged off between the decision and the launch — a race the
    /// liveness check and the next event will recover from).
    fn launch_agent(session: u32, flavour: AgentFlavour, exe: &PathBuf) -> Option<AgentProcess> {
        let flavour_arg = match flavour {
            AgentFlavour::SystemInteractive => "system",
        };

        // The agent REQUIRES --token and exits immediately without one. Omitting
        // it meant the service could never start the real agent — every launch
        // would exit instantly and the restart policy would give up after five.
        // The install checkpoint missed this because it ran a stub.
        let token = match launch_id::generate_token() {
            Ok(t) => t,
            Err(e) => {
                service_log(&format!("could not generate a launch token: {e}"));
                return None;
            }
        };
        let pipe = launch_id::pipe_name(session);
        let session_s = session.to_string();

        // WHO MAY REACH THIS AGENT BESIDES SYSTEM.
        //
        // The agent's pipe is owner+SYSTEM only, which was right while the app
        // launched its own agent and is an impasse now: the process that can see
        // Winlogon has to be SYSTEM, and the process that knows whether a remote
        // session is authorised is the user's app. One named account is added so
        // they can meet — the console session's own user, and only if that user
        // is a local administrator, which is the same pair of conditions the
        // control pipe enforces before handing out the token.
        //
        // Nobody is signed in at a cold-boot sign-in screen, so this is None
        // there and the pipe stays SYSTEM-only. That case needs the service to
        // hold its own connection rather than a local rendezvous, which is a
        // separate piece of work.
        let allow_sid = puca_service::caller::console_user_sid(session)
            .filter(|_| {
                // Established the same way the control pipe does, so the pipe
                // ACL and the token gate cannot disagree about who is trusted.
                puca_service::caller::console_user_is_administrator(session)
            })
            .and_then(|sid| sid.to_string_sid());
        match &allow_sid {
            Some(sid) => service_log(&format!("agent pipe will also admit {sid}")),
            None => service_log(
                "agent pipe stays SYSTEM-only (nobody signed in, or not an administrator)",
            ),
        }

        let mut args = vec![
            "--service-session",
            &session_s,
            "--flavour",
            flavour_arg,
            "--token",
            &token,
            "--pipe",
            &pipe,
        ];
        if let Some(sid) = allow_sid.as_deref() {
            args.push("--allow-sid");
            args.push(sid);
        }
        // The machine-scope unattended record. Passed as a PATH, and passed
        // even when the file does not exist yet: the agent re-reads it on every
        // connection, so arming later must not need a relaunch.
        let ua_record = puca_service::arming::record_path()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        if !ua_record.is_empty() {
            args.push("--ua-record");
            args.push(&ua_record);
        }
        // WHERE THE AGENT'S OWN STORY GOES. The agent is launched with
        // CREATE_NO_WINDOW, so without this flag every one of its eprintln
        // lines — the capture-blocked notices, the desktop follows, the ICE
        // summary — evaporates. That is exactly how the 2026-08-17
        // invisible-PIN freeze went undiagnosable: the ONE process that
        // watched the capture die had nowhere to say so. Same directory as
        // service.log, same world-readable-no-secrets rules (the agent's log
        // discipline already forbids credentials on stderr). Rotated here at
        // launch rather than in the agent: the agent appends blindly, and a
        // service that rotates before each spawn bounds the pair at ~10 MB
        // without the agent needing file-management it would run under
        // seccomp-adjacent hardening some day.
        let agent_log = agent_log_path();
        if let Some(ref log) = agent_log {
            rotate_agent_log(std::path::Path::new(log));
            args.push("--log");
            args.push(log);
        }
        let result = match flavour {
            AgentFlavour::SystemInteractive => launch_as_system_in_session(session, exe, &args),
        };
        match result {
            Ok(agent) => {
                service_log(&format!(
                    "launched {flavour_arg} agent pid {} in session {session}",
                    agent.pid
                ));
                // Nothing is published. The token stays in this process and on
                // the child's command line, and dies with them: the only party
                // that ever needed to read it from disk was a user-flavour
                // agent's app, and that flavour no longer exists.
                Some(agent)
            }
            Err(e) => {
                service_log(&format!("launch {flavour_arg} in session {session} FAILED: {e}"));
                None
            }
        }
    }

    /// Carry out one supervisor action against the live agent map.
    fn execute(action: &Action, agents: &mut HashMap<u32, AgentProcess>, exe: &PathBuf) {
        match *action {
            Action::Stop { session } => {
                if let Some(agent) = agents.remove(&session) {
                    service_log(&format!("stopping agent pid {} in session {session}", agent.pid));
                    agent.terminate();
                }
            }
            Action::Launch { session, flavour } => {
                // Replace any existing agent for this session first, so we never
                // hold two on one output.
                if let Some(old) = agents.remove(&session) {
                    old.terminate();
                }
                if let Some(agent) = launch_agent(session, flavour, exe) {
                    agents.insert(session, agent);
                }
            }
        }
    }

    /// Relaunch an agent the supervisor still wants but whose process has died.
    /// Relaunch a dead agent, subject to the restart policy.
    ///
    /// The policy is not optional garnish: the first live install run relaunched
    /// a fast-exiting agent every 2s indefinitely. Without backoff and a
    /// give-up rule, a broken agent becomes a process-spawning loop that buries
    /// its own error in the log.
    fn recover_dead_agents(
        supervisor: &Supervisor,
        agents: &mut HashMap<u32, AgentProcess>,
        exe: &PathBuf,
        policy: &mut RestartPolicy,
        launched_at: &mut Option<u64>,
        now_ms: u64,
    ) {
        let Some((session, flavour)) = supervisor.running() else { return };

        if agents.get(&session).map(|a| a.is_alive()).unwrap_or(false) {
            // Alive. Only real uptime clears the failure streak — an agent that
            // dies after three seconds must not look like a fresh first failure
            // forever.
            if let Some(at) = *launched_at {
                policy.record_healthy(at, now_ms);
            }
            return;
        }

        agents.remove(&session);
        match policy.on_dead(now_ms) {
            RestartDecision::Restart => {
                if let Some(agent) = launch_agent(session, flavour, exe) {
                    agents.insert(session, agent);
                    *launched_at = Some(now_ms);
                }
            }
            RestartDecision::GiveUp => {
                service_log(&format!(
                    "agent in session {session} failed {} times in a row; giving up until the \
                     next session change. Check that {} exists and runs.",
                    policy.consecutive_failures(),
                    exe.display(),
                ));
            }
            // Wait: backing off. Silent: already reported, stay quiet so the log
            // remains readable.
            RestartDecision::Wait | RestartDecision::Silent => {}
        }
    }

    fn run_service() -> Result<(), Box<dyn std::error::Error>> {
        let (tx, rx) = mpsc::channel::<Msg>();

        let handler_tx = tx.clone();
        let event_handler = move |control| -> ServiceControlHandlerResult {
            match control {
                ServiceControl::Stop | ServiceControl::Shutdown => {
                    let _ = handler_tx.send(Msg::Stop);
                    ServiceControlHandlerResult::NoError
                }
                ServiceControl::SessionChange(param) => {
                    if let Some(ev) = map_session_change(param.reason, param.notification.session_id)
                    {
                        let _ = handler_tx.send(Msg::Session(ev));
                    }
                    ServiceControlHandlerResult::NoError
                }
                ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
                _ => ServiceControlHandlerResult::NotImplemented,
            }
        };
        let status_handle = service_control_handler::register(SERVICE_NAME, event_handler)?;

        let set_state = |state: ServiceState, accept: ServiceControlAccept| ServiceStatus {
            service_type: ServiceType::OWN_PROCESS,
            current_state: state,
            controls_accepted: accept,
            exit_code: ServiceExitCode::Win32(0),
            checkpoint: 0,
            wait_hint: Duration::default(),
            process_id: None,
        };

        status_handle.set_service_status(set_state(
            ServiceState::Running,
            ServiceControlAccept::STOP | ServiceControlAccept::SESSION_CHANGE,
        ))?;

        let mut supervisor = Supervisor::new();
        let mut agents: HashMap<u32, AgentProcess> = HashMap::new();
        let mut policy = RestartPolicy::new();
        // Deferred: the startup launch below sets it. Declaring it None here
        // and overwriting would be a value never read, and would also mask a
        // future path that forgot to set it — this way the compiler proves it.
        let mut launched_at: Option<u64>;
        let started = std::time::Instant::now();
        let exe = agent_exe_path();

        // THE LINK. Its own thread with its own socket; see `link.rs`. It is
        // inert unless this machine was deliberately enrolled, so on every
        // ordinary install it starts, finds nothing, and stays closed.
        //
        // `agent_alive` is separate from the gate on purpose: the gate says what
        // SHOULD be running, this says what IS. Reporting "no agent" when one is
        // merely wanted, or the reverse, would put a wrong reason in front of
        // whoever is trying to connect.
        let link_gate = puca_service::link::LinkGate::new();
        let agent_alive = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        // The agent's pipe name and launch token. The token never leaves this
        // process — see the launch site — so the link cannot reach the agent
        // without being handed it here.
        let link_agent: puca_service::link::AgentHandle =
            std::sync::Arc::new(std::sync::Mutex::new(None));
        puca_service::link::run_thread(
            link_gate.clone(),
            agent_alive.clone(),
            link_agent.clone(),
        );

        // Startup snapshot: what does the console look like right now?
        let console = active_console_session();
        let logged_on = console.map(is_user_logged_on).unwrap_or(false);
        service_log(&format!(
            "=== service starting: console={console:?} logged_on={logged_on} agent_exe={} ===",
            exe.display()
        ));
        // SOFTWARE SAS, EVERY START — not only at install.
        //
        // `puca-service update` replaces the binaries and restarts without
        // re-running the installer, so a policy applied only in `install` would
        // be absent on every machine that updated into this feature rather than
        // installing fresh. It is idempotent, it never overwrites a value
        // somebody else set, and a failure is logged and carried on from: losing
        // Ctrl+Alt+Del is not a reason to lose unattended access.
        service_log(&format!("[sas] {}", puca_service::sas::ensure_policy()));

        let startup = SessionEvent::Startup { console, logged_on, locked: false };
        for action in supervisor.on_event(startup) {
            execute(&action, &mut agents, &exe);
        }
        link_gate.set(supervisor.wants_link());
        agent_alive.store(
                        agents.values().any(|a| a.is_alive()),
                        std::sync::atomic::Ordering::SeqCst,
                    );
        launched_at = Some(uptime_ms(started));

        // Serve the control pipe on its own thread. It only PARSES and applies
        // policy; anything it accepts comes back here as a message, so the
        // worker loop remains the single mutator.
        //
        // The state it reports is published through an Arc rather than shared
        // directly: the supervisor is owned by this loop and must stay that way.
        // Fourth slot: how to reach the running agent. Published alongside the
        // rest so the control pipe answers from one consistent snapshot rather
        // than reading the supervisor from another thread.
        type SharedView = (Option<u32>, Option<String>, bool, Option<(String, String)>);
        let shared: std::sync::Arc<std::sync::Mutex<SharedView>> =
            std::sync::Arc::new(std::sync::Mutex::new((None, None, false, None)));
        {
            let shared = std::sync::Arc::clone(&shared);
            let ctl_tx = tx.clone();
            let stopping = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            let stop_flag = std::sync::Arc::clone(&stopping);
            std::thread::spawn(move || {
                control_pipe::serve(
                    |caller| {
                        let g = shared.lock().unwrap_or_else(|e| e.into_inner());
                        ServiceView {
                            running_session: g.0,
                            flavour: g.1.clone(),
                            agent_alive: g.2,
                            agent_handle: g.3.clone(),
                            caller,
                        }
                    },
                    |accepted| {
                        let _ = ctl_tx.send(Msg::Control(accepted));
                    },
                    move || stop_flag.load(std::sync::atomic::Ordering::SeqCst),
                    |m| service_log(&format!("[control] {m}")),
                );
            });
        }

        // Keep the published view in step with reality.
        let publish_view = |shared: &std::sync::Arc<std::sync::Mutex<SharedView>>,
                            supervisor: &Supervisor,
                            agents: &HashMap<u32, AgentProcess>| {
            let running = supervisor.running();
            let alive = running
                .map(|(sess, _)| agents.get(&sess).map(|a| a.is_alive()).unwrap_or(false))
                .unwrap_or(false);
            // Published ONLY while the agent is actually alive. A pipe name for
            // a dead agent is worse than none: the app would dial it, get
            // nothing, and report the feature as broken rather than absent.
            let handle = running
                .map(|(sess, _)| sess)
                .and_then(|sess| agents.get(&sess))
                .filter(|a| a.is_alive())
                .map(|a| (a.pipe.clone(), a.token.clone()));
            // The LINK gets the same handle from the same computation. Two
            // separate derivations of "which agent is live" would eventually
            // disagree, and the link would dial a pipe the control view had
            // already retired.
            if let Ok(mut lg) = link_agent.lock() {
                *lg = handle.clone();
            }
            let mut g = shared.lock().unwrap_or_else(|e| e.into_inner());
            *g = (
                running.map(|(sess, _)| sess),
                running.map(|(_, f)| match f {
                    AgentFlavour::SystemInteractive => "system".to_string(),
                }),
                alive,
                handle,
            );
        };
        publish_view(&shared, &supervisor, &agents);

        // Worker loop: react to session changes; on the idle tick, resurrect a
        // crashed agent. Ends on Stop/Shutdown or a dropped channel.
        loop {
            match rx.recv_timeout(LIVENESS_INTERVAL) {
                Ok(Msg::Stop) => break,
                // NOTHING REACHES HERE ANY MORE. Both variants that produced an
                // Accepted were only ever logged below — the caller was told Ok
                // while nothing was forwarded — so control_pipe.rs now refuses
                // them outright and names the path that works. Kept as an arm
                // rather than deleted so the type stays honest about what the
                // channel can carry.
                Ok(Msg::Control(accepted)) => {
                    service_log(&format!("[control] ignoring {accepted:?}"));
                }
                Ok(Msg::Session(ev)) => {
                    service_log(&format!("session event: {ev:?}"));
                    // The situation has materially changed (a user logged in, the
                    // desktop switched), so a launch that kept failing may now
                    // succeed. Re-arm rather than staying given-up.
                    policy.reset();
                    launched_at = Some(uptime_ms(started));
                    for action in supervisor.on_event(ev) {
                        execute(&action, &mut agents, &exe);
                    }
                    // Set the gate from the SAME supervisor read that drove the
                    // actions, so the socket and the agent can never disagree
                    // about which state the machine is in.
                    link_gate.set(supervisor.wants_link());
                    agent_alive.store(
                        agents.values().any(|a| a.is_alive()),
                        std::sync::atomic::Ordering::SeqCst,
                    );
                    publish_view(&shared, &supervisor, &agents);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    link_gate.set(supervisor.wants_link());
                    agent_alive.store(
                        agents.values().any(|a| a.is_alive()),
                        std::sync::atomic::Ordering::SeqCst,
                    );
                    publish_view(&shared, &supervisor, &agents);
                    recover_dead_agents(
                        &supervisor,
                        &mut agents,
                        &exe,
                        &mut policy,
                        &mut launched_at,
                        uptime_ms(started),
                    );
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }

        // Teardown: stop every agent, then report Stopped.
        service_log("=== service stopping; terminating agents ===");
        for (session, agent) in agents.drain() {
            service_log(&format!("terminating agent pid {} in session {session}", agent.pid));
            agent.terminate();
        }
        status_handle
            .set_service_status(set_state(ServiceState::Stopped, ServiceControlAccept::empty()))?;
        Ok(())
    }
}
