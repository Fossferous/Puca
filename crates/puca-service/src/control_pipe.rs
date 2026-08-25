//! The service's control pipe — the I/O half of [`crate::control`].
//!
//! The POLICY lives next door and is enforced by `control::check` before
//! anything here acts. This module only moves bytes and holds the ACL. Keeping
//! them apart is what let every refusal be tested without standing up a pipe.
//!
//! ONE INSTANCE, and single-threaded on purpose. This is a control channel for a
//! single supervised agent, not a server: two callers driving one session is not
//! a feature, it is a race over one mouse. A second connection waits.
//!
//! NEWLINE-DELIMITED JSON. The agent's pipe already speaks that, and a control
//! channel carrying a handful of small messages does not need a framing layer of
//! its own — one more format is one more thing to get subtly wrong.

use crate::control::{check, ControlRequest, ControlResponse, CONTROL_PIPE, CONTROL_PIPE_SDDL};
use std::io::{BufRead, BufReader, Write};
use windows::core::{HSTRING, PCWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
use windows::Win32::Security::Authorization::{
    ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};
use windows::Win32::Storage::FileSystem::{
    FlushFileBuffers, ReadFile, WriteFile, FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_DUPLEX,
};
use windows::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PIPE_READMODE_BYTE, PIPE_TYPE_BYTE,
    PIPE_WAIT,
};

/// What the pipe needs to know about the service to answer a request.
///
/// Passed in rather than reached for, so the handler stays testable and the
/// supervisor is not shared across threads.
pub struct ServiceView {
    pub running_session: Option<u32>,
    pub flavour: Option<String>,
    pub agent_alive: bool,
    /// Who the caller is, decided by the I/O layer once per connection.
    ///
    /// Lives here rather than being looked up inside `handle_line` so the
    /// policy stays a pure function: every caller shape can be exercised in a
    /// unit test without a pipe, a service, or a second Windows account. A gate
    /// that can only be tested by logging in as somebody else never is.
    pub caller: crate::control::CallerTrust,
    /// How to reach the running SYSTEM agent — the secret `AgentHandle`
    /// returns. `None` when no agent is running, which is also why the identity
    /// check happens BEFORE this is consulted.
    pub agent_handle: Option<(String, String)>,
}

/// A relay the pipe accepted and the service should carry out.
///
/// Returned rather than performed here: this module has no business touching the
/// agent, and keeping the effect at the caller means the pipe cannot become a
/// second place where authorisation decisions live.
#[derive(Debug, PartialEq, Eq)]
pub enum Accepted {
    Keyframe,
    Relay { session: u32, payload: Vec<u8> },
}

struct PipeHandle(HANDLE);

impl Drop for PipeHandle {
    fn drop(&mut self) {
        unsafe {
            let _ = DisconnectNamedPipe(self.0);
            let _ = CloseHandle(self.0);
        }
    }
}

struct PipeIo(HANDLE);

impl std::io::Read for PipeIo {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let mut read = 0u32;
        unsafe {
            ReadFile(self.0, Some(buf), Some(&mut read), None)
                .map_err(|e| std::io::Error::other(format!("{e}")))?;
        }
        Ok(read as usize)
    }
}

impl Write for PipeIo {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let mut written = 0u32;
        unsafe {
            WriteFile(self.0, Some(buf), Some(&mut written), None)
                .map_err(|e| std::io::Error::other(format!("{e}")))?;
        }
        Ok(written as usize)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        unsafe {
            let _ = FlushFileBuffers(self.0);
        }
        Ok(())
    }
}

fn create_pipe() -> Result<PipeHandle, String> {
    let mut sd = PSECURITY_DESCRIPTOR::default();
    unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            &HSTRING::from(CONTROL_PIPE_SDDL),
            SDDL_REVISION_1,
            &mut sd,
            None,
        )
        .map_err(|e| format!("could not build the control pipe security descriptor: {e}"))?;
    }
    let sa = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: sd.0,
        bInheritHandle: false.into(),
    };
    let wide: Vec<u16> = CONTROL_PIPE.encode_utf16().chain(std::iter::once(0)).collect();
    let handle = unsafe {
        CreateNamedPipeW(
            PCWSTR(wide.as_ptr()),
            // See the agent's pipe: without FIRST_PIPE_INSTANCE a local process
            // can squat this name before the service starts and impersonate it.
            // This pipe is the SYSTEM service's control channel, so that matters
            // more here than anywhere else in the product.
            PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
            // ONE instance: two callers driving one agent is a race, not a
            // feature.
            1,
            64 * 1024,
            64 * 1024,
            0,
            Some(&sa),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(format!(
            "CreateNamedPipe({CONTROL_PIPE}) failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(PipeHandle(handle))
}

/// Handle exactly one request from `line`, given `view`.
///
/// Split out from the I/O so the whole request path — parse, policy, response —
/// is testable without a pipe. The alternative is that "does a bad request get
/// refused" can only be checked by connecting to a live SYSTEM service, which
/// means in practice it never gets checked.
/// Fingerprint of the pair of binaries this service is actually running from.
///
/// Cached for the process lifetime: the installed files cannot change under a
/// running service except through `update`, which restarts it — so the first
/// answer stays true until the next start, and hashing ~10 MB on every UI
/// poll would be waste. `None` when either file cannot be read, which the app
/// treats the same as an old service: offer the update.
fn installed_pair_fingerprint() -> Option<String> {
    static FINGERPRINT: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    FINGERPRINT
        .get_or_init(|| {
            let me = std::env::current_exe().ok()?;
            let agent = me.parent()?.join(crate::INSTALLED_AGENT_EXE);
            crate::install::pair_fingerprint(&me, &agent).ok()
        })
        .clone()
}

/// The one place `ControlRequest::Sas` reaches `SendSAS`.
///
/// A SEAM FOR THE SAME REASON THE AGENT HAS ONE. `cargo test` runs on a real
/// desktop; a test that drove this through to the real `SendSAS` would throw the
/// secure desktop over whatever the person running it was doing, and would do it
/// on every run. `puca-agent/src/session.rs::dispatch_input` closed exactly
/// this hole one layer up after its canary string was landing in whatever app
/// had focus.
#[cfg(not(test))]
fn dispatch_sas() -> Result<(), String> {
    crate::sas::raise()
}

// What the test stand-in will answer, and how often it was reached.
//
// A THREAD-LOCAL, not a static: `cargo test` runs tests in parallel on separate
// threads, and a shared cell would make one test's expectation another test's
// flake. Each test gets its own, initialised to the honest default for a machine
// that has never had the policy set.
#[cfg(test)]
thread_local! {
    static SAS_STANDIN: std::cell::RefCell<(usize, Result<(), String>)> =
        std::cell::RefCell::new((0, Err(crate::sas::POLICY_NOT_SET.to_string())));
}

#[cfg(test)]
fn dispatch_sas() -> Result<(), String> {
    SAS_STANDIN.with(|c| {
        let mut c = c.borrow_mut();
        c.0 += 1;
        c.1.clone()
    })
}

pub fn handle_line(line: &str, view: &ServiceView) -> (ControlResponse, Option<Accepted>) {
    let req: ControlRequest = match serde_json::from_str(line) {
        Ok(r) => r,
        // An unparseable or unknown request is refused with a flat message. It
        // is NOT echoed back: reflecting attacker-chosen bytes into a log or a
        // UI is a needless gift.
        Err(_) => {
            return (
                ControlResponse::Refused { reason: "unrecognised request".into() },
                None,
            )
        }
    };

    if let Err(denied) = check(&req, view.running_session, view.agent_alive, view.caller) {
        return (ControlResponse::Refused { reason: denied.to_string() }, None);
    }

    match req {
        ControlRequest::Status => (
            ControlResponse::Status {
                session: view.running_session,
                flavour: view.flavour.clone(),
                agent_alive: view.agent_alive,
            },
            None,
        ),
        // ANSWERED HONESTLY RATHER THAN Ok. The worker loop only LOGS these
        // two (main.rs), so a caller was told the work happened when nothing
        // reached the agent — the same silent-success shape that hid a dead
        // agent handoff in this codebase for weeks.
        //
        // Not deleted, so an out-of-tree caller gets a reason instead of an
        // unknown-variant parse error. The working path is AgentHandle: borrow
        // the agent's own pipe and speak to it directly, which is what the app
        // does and what link.rs does for a sign-in-screen session.
        ControlRequest::RequestKeyframe => (
            ControlResponse::Refused {
                reason: "ask the agent directly: borrow its pipe with agent_handle".into(),
            },
            None,
        ),
        ControlRequest::AgentHandle => match &view.agent_handle {
            Some((pipe, token)) => (
                ControlResponse::AgentHandle { pipe: pipe.clone(), token: token.clone() },
                None,
            ),
            // `check` already required a live agent, so this is the race where
            // it died between the two. Refused rather than papered over: a
            // caller that gets a stale pipe name dials nothing and blames the
            // feature.
            None => (
                ControlResponse::Refused { reason: "the agent stopped just now".into() },
                None,
            ),
        },
        ControlRequest::Relay { session, payload } => {
            let _ = (session, payload);
            (
                ControlResponse::Refused {
                    reason: "ask the agent directly: borrow its pipe with agent_handle".into(),
                },
                None,
            )
        }

        // Arming is done HERE rather than handed to the worker loop as an
        // Accepted: it is a file write with no supervisor state involved, and
        // the caller needs the real outcome. Routing it through the loop would
        // mean answering Ok before knowing whether the write succeeded.
        ControlRequest::Arm { record } => {
            match serde_json::from_str::<puca_ua::UaRecord>(&record) {
                Ok(rec) => match crate::arming::arm(&rec) {
                    Ok(()) => {
                        crate::log::line("[arm] this machine is now armed for the sign-in screen");
                        (ControlResponse::Ok, None)
                    }
                    Err(e) => (ControlResponse::Refused { reason: e }, None),
                },
                Err(_) => (
                    ControlResponse::Refused { reason: "that is not an arming record".into() },
                    None,
                ),
            }
        }

        ControlRequest::Disarm => match crate::arming::disarm() {
            Ok(()) => {
                crate::log::line("[arm] sign-in-screen access has been disarmed");
                (ControlResponse::Ok, None)
            }
            Err(e) => (ControlResponse::Refused { reason: e }, None),
        },

        ControlRequest::EnrolBegin => match crate::enrol::begin() {
            Ok(id) => (
                ControlResponse::Enrolment {
                    device_id: id.device_id,
                    device_pub: id.device_pub,
                    sign_pub: id.sign_pub,
                },
                None,
            ),
            Err(e) => (ControlResponse::Refused { reason: e }, None),
        },

        ControlRequest::EnrolFinish { api_base, user_id, token, account_sign_pub } => {
            match crate::enrol::finish(&api_base, user_id, &token, &account_sign_pub) {
                Ok(()) => {
                    crate::log::line("[enrol] this machine is now reachable at its sign-in screen");
                    (ControlResponse::Ok, None)
                }
                Err(e) => (ControlResponse::Refused { reason: e }, None),
            }
        }

        ControlRequest::Unenrol => match crate::enrol::forget() {
            Ok(()) => {
                crate::log::line("[enrol] this machine has been unenrolled");
                (ControlResponse::Ok, None)
            }
            Err(e) => (ControlResponse::Refused { reason: e }, None),
        },

        // DONE HERE, like arming, rather than handed to the worker loop as an
        // `Accepted`: the caller needs the REAL outcome. Routing it through the
        // loop would answer Ok before knowing whether anything happened, which
        // is the precise failure mode this whole change exists to remove — and
        // the one `RequestKeyframe` and `Relay` above were caught doing.
        ControlRequest::Sas => match dispatch_sas() {
            Ok(()) => {
                crate::log::line("[sas] raised the secure attention sequence");
                (ControlResponse::Ok, None)
            }
            // The reason is `crate::sas`'s own text, which names the policy and
            // what to do about it. Flattening it to "refused" would put a person
            // back where they started: a button that does nothing.
            Err(e) => {
                crate::log::line(&format!("[sas] refused: {e}"));
                (ControlResponse::Refused { reason: e }, None)
            }
        },

        ControlRequest::UnattendedState => (
            ControlResponse::UnattendedState {
                armed: crate::arming::is_armed(),
                enrolled: crate::link::is_enrolled(),
                device_id: crate::link::enrolled_device_id(),
                bins_hash: installed_pair_fingerprint(),
            },
            None,
        ),
    }
}

/// Serve the control pipe until `should_stop` returns true.
///
/// `view` is re-read per connection so a client always sees current state, and
/// `on_accepted` performs whatever the policy allowed — this module never
/// touches the agent itself.
///
/// The view is a FUNCTION OF THE CALLER because only this loop holds the pipe
/// handle, and identifying the client requires impersonating it through that
/// handle. Deciding it here and handing the verdict to the policy keeps
/// `handle_line` pure and keeps the authorisation in one place; the alternative
/// — letting the policy reach for the handle — would put a second, untestable
/// decision inside a module whose whole design is that its refusals can be
/// exercised without a pipe.
pub fn serve(
    mut view: impl FnMut(crate::control::CallerTrust) -> ServiceView,
    mut on_accepted: impl FnMut(Accepted),
    should_stop: impl Fn() -> bool,
    mut log: impl FnMut(&str),
) {
    // Created ONCE, outside the loop, and recycled per client.
    //
    // It used to be created per connection, which left a gap between one client
    // disconnecting and the next `create_pipe` where the name belonged to
    // nobody. `FILE_FLAG_FIRST_PIPE_INSTANCE` is what stops a local process
    // squatting the name before the service starts — but it only protects the
    // FIRST creation, so a per-connection create handed that protection away on
    // every subsequent one: a squatter who won the race would own the SYSTEM
    // service's control channel, and our own create would then fail.
    //
    // Holding one handle for the life of the service closes the gap entirely:
    // the name is ours from first creation to shutdown.
    let pipe = match create_pipe() {
        Ok(p) => p,
        Err(e) => {
            log(&format!("control pipe: {e} (control channel unavailable this run)"));
            return;
        }
    };

    let mut first = true;
    while !should_stop() {
        if !first {
            // Release the previous client and reuse the same instance rather
            // than making a new one.
            unsafe {
                let _ = FlushFileBuffers(pipe.0);
                let _ = DisconnectNamedPipe(pipe.0);
            }
        }
        first = false;
        unsafe {
            // ERROR_PIPE_CONNECTED means a client raced in before we called
            // this; that is a successful connection, not a failure.
            let _ = ConnectNamedPipe(pipe.0, None);
        }
        if should_stop() {
            return;
        }

        let mut reader = BufReader::new(PipeIo(pipe.0));
        let mut out = PipeIo(pipe.0);
        let mut line = String::new();

        // IDENTIFY THE CLIENT ONCE PER CONNECTION, BUT ONLY AFTER READING.
        //
        // This used to classify here, before the read, with a comment boasting
        // that it ran "before a single byte of theirs has been read". That is
        // exactly the condition under which it cannot work:
        // `ImpersonateNamedPipeClient` fails with ERROR_CANNOT_IMPERSONATE
        // until the server has read a message from the client. So every
        // identification failed, `classify` fell to its safe default of
        // NotConsoleUser, and the gate refused EVERY caller — including the
        // console administrator it exists to admit. Nothing logged it, because
        // a refusal is a normal outcome.
        //
        // Deferring to the first message keeps the property the old comment
        // wanted — identity is fixed for the whole conversation, so a caller
        // cannot change who they are midway — while letting impersonation
        // actually succeed.
        let mut trust: Option<crate::control::CallerTrust> = None;

        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => break, // client hung up
                Ok(_) => {}
                Err(_) => break,
            }
            // `console_session` is read at classification time rather than
            // captured at startup: a fast-user-switch changes who "the person
            // at this screen" is, and a stale answer would hand the previous
            // user's rights to the new one.
            let trust = *trust.get_or_insert_with(|| {
                crate::caller::classify(
                    pipe.0,
                    crate::launch::active_console_session().unwrap_or(u32::MAX),
                )
            });
            let (resp, accepted) = handle_line(line.trim(), &view(trust));
            if let Some(a) = accepted {
                on_accepted(a);
            }
            let mut body = match serde_json::to_string(&resp) {
                Ok(b) => b,
                Err(_) => continue,
            };
            body.push('\n');
            if out.write_all(body.as_bytes()).is_err() {
                break;
            }
            let _ = out.flush();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A live agent, asked for by the one caller allowed to have it. Existing
    /// tests exercise verbs that ignore the caller, so they get the trusted
    /// identity and their meaning is unchanged.
    fn running() -> ServiceView {
        ServiceView {
            running_session: Some(2),
            flavour: Some("user".into()),
            agent_alive: true,
            agent_handle: Some((r"\.\pipe\sovereign-agent-2".into(), "tok".into())),
            caller: crate::control::CallerTrust::ConsoleAdministrator,
        }
    }

    fn idle() -> ServiceView {
        ServiceView {
            running_session: None,
            flavour: None,
            agent_alive: false,
            agent_handle: None,
            caller: crate::control::CallerTrust::ConsoleAdministrator,
        }
    }

    /// The same live agent, but somebody else is asking.
    fn running_as(caller: crate::control::CallerTrust) -> ServiceView {
        ServiceView { caller, ..running() }
    }

    #[test]
    fn status_reports_what_is_running() {
        let (resp, accepted) = handle_line(r#"{"t":"status"}"#, &running());
        assert_eq!(accepted, None, "a question must not cause an action");
        match resp {
            ControlResponse::Status { session, flavour, agent_alive } => {
                assert_eq!(session, Some(2));
                assert_eq!(flavour.as_deref(), Some("user"));
                assert!(agent_alive);
            }
            other => panic!("expected Status, got {other:?}"),
        }
    }

    #[test]
    fn status_still_answers_when_nothing_runs() {
        let (resp, _) = handle_line(r#"{"t":"status"}"#, &idle());
        assert!(matches!(resp, ControlResponse::Status { session: None, .. }));
    }

    #[test]
    fn a_relay_is_refused_rather_than_accepted_and_dropped() {
        // THIS TEST USED TO ASSERT THE BUG. It pinned `Ok` plus an
        // `Accepted::Relay`, which is exactly what the code did — and the worker
        // loop that received it only wrote a log line. A caller was told the
        // sealed bytes had been delivered to the agent while nothing left the
        // service.
        //
        // Answering honestly is the fix; the path that actually works is
        // AgentHandle, which hands over the agent's own pipe.
        let (resp, accepted) =
            handle_line(r#"{"t":"relay","session":2,"payload":[1,2,3]}"#, &running());
        assert_eq!(accepted, None, "nothing may be queued for work that is not done");
        match resp {
            ControlResponse::Refused { reason } => {
                assert!(reason.contains("agent_handle"), "must name the path that works: {reason}");
            }
            other => panic!("a relay that goes nowhere must not answer Ok, got {other:?}"),
        }
    }

    #[test]
    fn a_relay_for_the_wrong_session_causes_no_action() {
        // The refusal must ALSO mean nothing happened; a response that says no
        // while the effect already fired is the worst of both.
        let (resp, accepted) =
            handle_line(r#"{"t":"relay","session":9,"payload":[1]}"#, &running());
        assert!(matches!(resp, ControlResponse::Refused { .. }));
        assert_eq!(accepted, None);
    }

    #[test]
    fn an_injection_attempt_is_refused_and_not_echoed() {
        // The escalation attempt. It must be refused, cause nothing, and NOT
        // reflect the attacker's own bytes back into a log or UI.
        //
        // STILL REFUSED NOW THAT `sas` EXISTS, and that is the point of leaving
        // this payload exactly as it was: adding a legitimate way to raise the
        // secure attention sequence must not have quietly opened a
        // data-carrying one. `{"t":"sas"}` is admitted; `{"t":"inject", ...}` is
        // not, and never will be.
        let (resp, accepted) =
            handle_line(r#"{"t":"inject","keys":"ctrl+alt+del"}"#, &running());
        assert_eq!(accepted, None, "an unknown verb must never cause an action");
        match resp {
            ControlResponse::Refused { reason } => {
                assert!(!reason.contains("ctrl+alt+del"), "must not echo attacker bytes: {reason}");
                assert!(!reason.contains("inject"), "must not echo the attempted verb: {reason}");
            }
            other => panic!("expected Refused, got {other:?}"),
        }
        // The stand-in must not have been touched: a refused parse must not
        // reach the dispatcher at all.
        assert_eq!(sas_calls(), 0, "an unparseable verb reached the SAS path");
    }

    // --- the secure attention sequence -------------------------------------

    /// How many times the `SendSAS` stand-in was reached on this thread.
    fn sas_calls() -> usize {
        super::SAS_STANDIN.with(|c| c.borrow().0)
    }

    /// Make the stand-in answer `outcome` for the rest of this test.
    fn sas_answers(outcome: Result<(), String>) {
        super::SAS_STANDIN.with(|c| c.borrow_mut().1 = outcome);
    }

    #[test]
    fn a_sas_request_that_cannot_be_carried_out_is_refused_with_the_real_reason() {
        // THE WHOLE POINT. `SendSAS` returns void, so a machine without the
        // policy is a silent no-op — and the previous implementation
        // (`SendInput` with three key codes) was a silent no-op that reported
        // success. Anything other than a refusal here rebuilds that.
        //
        // The stand-in defaults to the no-policy refusal, so this is the case a
        // machine that has never run the service is actually in.
        let (resp, accepted) = handle_line(r#"{"t":"sas"}"#, &running());
        assert_eq!(accepted, None, "the effect happens here, not in the worker loop");
        assert_eq!(sas_calls(), 1, "the request must have reached the dispatcher");
        match resp {
            ControlResponse::Refused { reason } => {
                assert!(
                    reason.contains("SoftwareSASGeneration"),
                    "the refusal must name what is actually wrong: {reason}"
                );
            }
            other => panic!("a SAS that did not happen must not answer Ok, got {other:?}"),
        }
    }

    #[test]
    fn a_sas_request_that_succeeds_answers_ok() {
        // THE POSITIVE CONTROL. Without it, a `dispatch_sas` that returned Err
        // unconditionally would satisfy every other test here while leaving the
        // feature exactly as dead as it is today.
        sas_answers(Ok(()));
        let (resp, accepted) = handle_line(r#"{"t":"sas"}"#, &running());
        assert!(matches!(resp, ControlResponse::Ok), "expected Ok, got {resp:?}");
        assert_eq!(accepted, None);
        assert_eq!(sas_calls(), 1);
    }

    #[test]
    fn a_sas_request_works_with_no_agent_running() {
        // Ctrl+Alt+Del is what you reach for when the remote desktop has
        // stopped responding, which is when the agent is most likely dead.
        sas_answers(Ok(()));
        let (resp, _) = handle_line(r#"{"t":"sas"}"#, &idle());
        assert!(matches!(resp, ControlResponse::Ok), "{resp:?}");
    }

    #[test]
    fn a_stranger_cannot_raise_the_secure_attention_sequence() {
        use crate::control::CallerTrust;
        // Refused BEFORE the dispatcher: a gate that refuses after the effect
        // has fired is the worst of both.
        sas_answers(Ok(()));
        let (resp, _) =
            handle_line(r#"{"t":"sas"}"#, &running_as(CallerTrust::NotConsoleUser));
        match resp {
            ControlResponse::Refused { reason } => {
                assert!(reason.contains("own screen"), "must say which condition failed: {reason}")
            }
            other => panic!("a stranger must not reach the secure desktop: {other:?}"),
        }
        assert_eq!(sas_calls(), 0, "the refusal came AFTER the sequence was raised");
    }

    #[test]
    fn a_standard_console_user_may_raise_it() {
        use crate::control::CallerTrust;
        // Unlike `agent_handle`, this does NOT need an administrator: the person
        // at this screen can press the three keys themselves.
        sas_answers(Ok(()));
        let (resp, _) =
            handle_line(r#"{"t":"sas"}"#, &running_as(CallerTrust::NotAdministrator));
        assert!(matches!(resp, ControlResponse::Ok), "{resp:?}");
        assert_eq!(sas_calls(), 1);
    }

    #[test]
    fn malformed_json_is_refused_without_panicking() {
        for junk in ["", "{", "null", "[]", r#"{"t":}"#, "not json at all"] {
            let (resp, accepted) = handle_line(junk, &running());
            assert_eq!(accepted, None, "junk must not cause an action: {junk:?}");
            assert!(matches!(resp, ControlResponse::Refused { .. }), "for {junk:?}");
        }
    }

    #[test]
    fn a_keyframe_request_is_refused_with_no_agent_and_causes_nothing() {
        let (resp, accepted) = handle_line(r#"{"t":"request_keyframe"}"#, &idle());
        assert!(matches!(resp, ControlResponse::Refused { .. }));
        assert_eq!(accepted, None);

        // With an agent running it is STILL refused: the worker loop never
        // forwarded a keyframe request, it only logged one. See the relay test
        // above — this pair pinned the silent-success shape.
        let (resp, accepted) = handle_line(r#"{"t":"request_keyframe"}"#, &running());
        assert_eq!(accepted, None);
        assert!(matches!(resp, ControlResponse::Refused { .. }));
    }

    #[test]
    fn an_oversized_relay_is_refused_before_it_is_acted_on() {
        // A SYSTEM service must not be made to buffer memory on an attacker's
        // behalf, and it certainly must not forward it.
        let payload: Vec<u8> = vec![0; 64 * 1024 + 1];
        let line = serde_json::to_string(&ControlRequest::Relay { session: 2, payload }).unwrap();
        let (resp, accepted) = handle_line(&line, &running());
        assert!(matches!(resp, ControlResponse::Refused { .. }));
        assert_eq!(accepted, None);
    }

    // --- the one verb that hands out a secret ------------------------------

    #[test]
    fn the_console_administrator_is_told_how_to_reach_the_agent() {
        // THE POSITIVE CONTROL, and the more important half. A gate that
        // refused everyone would pass every test below while making the
        // lock-screen feature impossible, and nothing else in this file would
        // notice.
        let (resp, accepted) = handle_line(r#"{"t":"agent_handle"}"#, &running());
        match resp {
            ControlResponse::AgentHandle { pipe, token } => {
                assert!(pipe.contains("sovereign-agent"), "{pipe}");
                assert_eq!(token, "tok");
            }
            other => panic!("expected the handle, got {other:?}"),
        }
        assert!(accepted.is_none(), "answering a question must cause no effect");
    }

    #[test]
    fn another_interactive_user_is_refused_and_told_why() {
        use crate::control::CallerTrust;
        // The escalation this gate exists to stop. This machine has enabled
        // non-admin accounts, and the control pipe grants IU, so without the
        // per-call identity check any of them could ask for SYSTEM-level
        // control of the console session.
        let (resp, _) = handle_line(
            r#"{"t":"agent_handle"}"#,
            &running_as(CallerTrust::NotConsoleUser),
        );
        match resp {
            ControlResponse::Refused { reason } => assert!(
                reason.contains("own screen"),
                "the refusal must say which condition failed: {reason}"
            ),
            other => panic!("a stranger must not be handed the agent: {other:?}"),
        }
    }

    #[test]
    fn a_standard_console_user_is_refused_differently() {
        use crate::control::CallerTrust;
        // Right person, wrong account type. Distinguished from the case above
        // because the two send someone to completely different places, and a
        // single "denied" sends them nowhere.
        let (resp, _) = handle_line(
            r#"{"t":"agent_handle"}"#,
            &running_as(CallerTrust::NotAdministrator),
        );
        match resp {
            ControlResponse::Refused { reason } => assert!(
                reason.contains("administrator"),
                "must name the account type: {reason}"
            ),
            other => panic!("a standard user must not be handed the agent: {other:?}"),
        }
    }

    #[test]
    fn identity_is_checked_before_the_agent_is_even_mentioned() {
        use crate::control::CallerTrust;
        // An untrusted caller must not learn WHETHER an agent is running.
        // Answering "no agent" to them and "here it is" later turns this verb
        // into a free lock/unlock oracle for any local account: poll it, and
        // the moment the answer changes you know the machine just locked.
        let (resp, _) = handle_line(
            r#"{"t":"agent_handle"}"#,
            &ServiceView { caller: CallerTrust::NotConsoleUser, ..idle() },
        );
        match resp {
            ControlResponse::Refused { reason } => assert!(
                !reason.contains("no agent"),
                "a stranger must not learn the agent's state: {reason}"
            ),
            other => panic!("expected a refusal, got {other:?}"),
        }
    }
}
