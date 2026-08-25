//! Asking the SYSTEM service to raise Ctrl+Alt+Del.
//!
//! WHY THE AGENT CANNOT DO THIS ITSELF. `SendInput` cannot produce the Secure
//! Attention Sequence — win32k reads it out of the raw hardware stream and
//! discards injected events by design, which is the entire point of a *secure*
//! attention sequence. There is no scan-code trick, and the failure is silent:
//! the six key frames the controller used to send were accepted, `SendInput`
//! returned 1 for each, this agent answered `Ok`, and nothing happened. The one
//! supported path is `SendSAS` from a LocalSystem process, which this is not.
//!
//! ONE CODE PATH FOR BOTH FLAVOURS. The user-flavour agent obviously cannot call
//! `SendSAS`. The pre-login agent runs as LocalSystem and probably could — but
//! whether winlogon honours a non-SCM LocalSystem process is UNVERIFIED, and a
//! second implementation that works on one machine and not another is worse than
//! one that is refused honestly everywhere. So both ask the service — and the
//! service admits both: the console user (either account kind) and LocalSystem,
//! which is what the pre-login agent is (`control.rs`, `CallerTrust::LocalSystem`,
//! admitted for `Sas` and nothing else). Neither flavour is special-cased here;
//! a refusal, when it comes, names the real obstacle (usually the
//! SoftwareSASGeneration policy) rather than the caller.
//!
//! FRAMING: newline-delimited JSON, one request one response, no handshake —
//! the service's control pipe is not the agent's pipe and has no `hello`. Shape
//! copied from `puca-service/src/agent_client.rs`, which is the mirror
//! image of this file (the service dialling the agent) so the two cannot
//! disagree about what a local pipe conversation looks like.

#![cfg(windows)]

use std::io::{BufRead, BufReader, Write};

/// The service's control pipe.
///
/// THIS LITERAL AND `puca_service::control::CONTROL_PIPE` ARE TWO HALVES OF
/// ONE NAME. They are compiled separately — this crate deliberately does not
/// depend on `puca-service`, which would drag tokio, tokio-tungstenite and
/// reqwest into a headless capture binary — so nothing but this comment and a
/// test on each side couples them. `agent_client.rs` carries the same warning
/// about `PROTOCOL_VERSION` for the same reason.
pub const SERVICE_CONTROL_PIPE: &str = r"\\.\pipe\sovereign-service";

/// The exact line sent for a SAS request.
///
/// It is `serde_json::to_string(&ControlRequest::Sas)` on the other end — a
/// `#[serde(tag = "t", rename_all = "snake_case")]` unit variant. The service's
/// `the_sas_request_serialises_to_the_frame_the_agent_writes` pins that same
/// string against its real type, and the test below pins this one; change either
/// end and one of the two goes red. A guessed cross-process name does not fail
/// loudly — it just quietly stops working, which is how this class of bug is
/// normally found by a user rather than a test.
pub const SAS_REQUEST_LINE: &str = r#"{"t":"sas"}"#;

/// How many times to retry a busy pipe, and how long between attempts.
///
/// BOUNDED, because the service's control pipe allows exactly one instance
/// (`control_pipe.rs`: "two callers driving one agent is a race, not a feature")
/// and the desktop app is a legitimate second client. A short retry rides out
/// the app's own poll; an unbounded one would hang a control-channel request
/// behind whatever else is talking, and the viewer would see a button that never
/// answers rather than one that says why.
const BUSY_ATTEMPTS: u32 = 5;
const BUSY_WAIT: std::time::Duration = std::time::Duration::from_millis(120);

/// Turn a failed open into a sentence that names WHICH problem this is.
///
/// The three cases send a person to completely different places — install the
/// service, wait a moment, or look at who else is connected — and a bare OS
/// error number sends them nowhere. Same reasoning, and the same three numbers,
/// as `puca-service/src/agent_client.rs::describe_open_error`.
fn describe_open_error(e: &std::io::Error) -> String {
    match e.raw_os_error() {
        // ERROR_FILE_NOT_FOUND. By far the most likely: the service is opt-in
        // and most installs have never enabled it. The message has to say that
        // rather than read as a fault.
        Some(2) => "the Puca system service is not running on this computer, so Ctrl+Alt+Del \
                    cannot be raised. Enable unattended access in Settings on that machine and \
                    try again."
            .to_string(),
        // ERROR_PIPE_BUSY, after the retries above.
        Some(231) => format!(
            "the Puca system service is busy with another connection ({e}); try again in a \
             moment"
        ),
        // ERROR_ACCESS_DENIED: the pipe is there but this process's account is
        // not on its ACL. The control pipe grants SYSTEM, Administrators and the
        // INTERACTIVE group, so this means the agent is running as something
        // else entirely.
        Some(5) => format!(
            "this agent is not allowed to talk to the Puca system service ({e}); it is \
             running under an account the service's control pipe does not admit"
        ),
        _ => format!("could not reach the Puca system service: {e}"),
    }
}

/// Turn the service's answer line into this agent's result.
///
/// PURE, so every shape of reply — including the ones a live service is hard to
/// coax into producing — is exercised without a pipe. It is also where the rule
/// lives: ONLY an explicit `ok` is success. A reply this build does not
/// understand is a failure, because a newer or older service answering something
/// unexpected must not be read as "it happened".
pub fn interpret(line: &str) -> Result<(), String> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
        return Err(
            "the Puca system service sent an answer this agent could not read".to_string()
        );
    };
    match v.get("t").and_then(|x| x.as_str()) {
        Some("ok") => Ok(()),
        // The reason comes from `puca_service::sas` and names the actual
        // obstacle — usually the SoftwareSASGeneration policy. Passed through
        // verbatim rather than flattened: a generic "refused" puts the person
        // back where they started, in front of a button that does nothing.
        Some("refused") => Err(v
            .get("reason")
            .and_then(|x| x.as_str())
            .filter(|r| !r.is_empty())
            .unwrap_or("the Puca system service refused, without saying why")
            .to_string()),
        _ => Err(
            "the Puca system service answered something this agent does not understand"
                .to_string(),
        ),
    }
}

/// Open the control pipe, ask for the SAS, and report what the service said.
///
/// `SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION` and not the default:
/// without it a process that squatted the pipe name gets to IMPERSONATE whoever
/// connects. For the pre-login agent, whoever connects is LocalSystem. Both
/// other clients of a local pipe in this codebase set the same flag.
///
/// BLOCKING, on the caller's thread — which is the agent's request loop, so a
/// service that accepted the connection and then never answered would wedge this
/// session's control channel. Left blocking anyway, and recorded here rather
/// than guarded on speculation: both other local-pipe clients in this codebase
/// (`puca-service/src/agent_client.rs` and
/// `frontend/src-tauri/src/agent_ipc.rs`) read the same way, the service answers
/// every line it reads, and `SendSAS` returns immediately. Adding a private
/// timeout mechanism here for a hang nobody has observed would make this the odd
/// one out for no measured gain. If it is ever seen, the fix belongs in all
/// three.
///
/// Dead ONLY under `cfg(test)`, where `session.rs` swaps in a stand-in so the
/// suite never dials a real pipe. The real build calls it, and a dead-code
/// warning there would be a genuine finding — hence the narrow `cfg_attr`
/// rather than a blanket allow.
#[cfg_attr(test, allow(dead_code))]
pub fn raise_sas() -> Result<(), String> {
    use std::os::windows::fs::OpenOptionsExt;
    const SECURITY_SQOS_PRESENT: u32 = 0x0010_0000;
    const SECURITY_IDENTIFICATION: u32 = 0x0001_0000;

    let mut last: Option<std::io::Error> = None;
    for attempt in 0..BUSY_ATTEMPTS {
        match std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION)
            .open(SERVICE_CONTROL_PIPE)
        {
            Ok(handle) => {
                let mut writer = handle
                    .try_clone()
                    .map_err(|e| format!("could not clone the service pipe handle: {e}"))?;
                let mut reader = BufReader::new(handle);
                writer
                    .write_all(format!("{SAS_REQUEST_LINE}\n").as_bytes())
                    .map_err(|e| format!("could not ask the Puca system service: {e}"))?;
                writer.flush().ok();

                let mut line = String::new();
                reader
                    .read_line(&mut line)
                    .map_err(|e| format!("could not read the system service's answer: {e}"))?;
                if line.trim().is_empty() {
                    return Err("the Puca system service closed the connection".to_string());
                }
                return interpret(line.trim());
            }
            Err(e) => {
                // RETRY ONLY A BUSY PIPE. "Not installed" and "access denied"
                // will not change in 600ms, and retrying them would turn an
                // instant, accurate refusal into a stall followed by the same
                // refusal.
                let busy = e.raw_os_error() == Some(231);
                last = Some(e);
                if !busy {
                    break;
                }
                if attempt + 1 < BUSY_ATTEMPTS {
                    std::thread::sleep(BUSY_WAIT);
                }
            }
        }
    }
    Err(describe_open_error(&last.unwrap_or_else(|| {
        std::io::Error::other("the service pipe could not be opened and gave no reason")
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_request_line_is_the_frame_the_service_parses() {
        // THE OTHER HALF OF A CROSS-PROCESS NAME. `puca-service`'s
        // `the_sas_request_serialises_to_the_frame_the_agent_writes` asserts
        // that `serde_json::to_string(&ControlRequest::Sas)` is this exact
        // string. The two crates are compiled separately, so these two tests are
        // the only thing that couples them — change one end and one of them goes
        // red, which is the whole point.
        assert_eq!(SAS_REQUEST_LINE, r#"{"t":"sas"}"#);

        // It must be valid, single-line JSON with the tag and nothing else: the
        // pipe is newline-delimited, so an embedded newline would split one
        // request into two unparseable halves.
        let v: serde_json::Value = serde_json::from_str(SAS_REQUEST_LINE).expect("valid JSON");
        assert_eq!(v["t"], "sas");
        assert_eq!(v.as_object().map(|o| o.len()), Some(1), "the request carries no data");
        assert!(!SAS_REQUEST_LINE.contains('\n'));
    }

    #[test]
    fn the_pipe_name_matches_the_services_own_constant() {
        // Duplicated from `puca_service::control::CONTROL_PIPE` for the
        // reason in this module's header. Pinned so the duplication is at least
        // visible when it breaks.
        assert_eq!(SERVICE_CONTROL_PIPE, r"\\.\pipe\sovereign-service");
    }

    #[test]
    fn only_an_explicit_ok_is_treated_as_success() {
        assert!(interpret(r#"{"t":"ok"}"#).is_ok());

        // A refusal carries the service's own reason through untouched — this is
        // the sentence that tells somebody the SoftwareSASGeneration policy is
        // missing, and flattening it would leave them with a dead button and no
        // explanation.
        let err = interpret(
            r#"{"t":"refused","reason":"the SoftwareSASGeneration policy is not set"}"#,
        )
        .expect_err("a refusal is not a success");
        assert!(err.contains("SoftwareSASGeneration"), "{err}");

        // A refusal with no reason still refuses, and says something.
        assert!(interpret(r#"{"t":"refused"}"#).is_err());
        assert!(interpret(r#"{"t":"refused","reason":""}"#).is_err());
    }

    #[test]
    fn anything_unrecognised_fails_rather_than_being_read_as_success() {
        // THE RULE THIS FILE EXISTS TO ENFORCE. The bug being fixed is a path
        // that reported success for something that had not happened; a client
        // that treats "I do not understand this reply" as Ok would rebuild it at
        // a different layer.
        for reply in [
            "",
            "not json",
            "{}",
            r#"{"t":"status","session":2}"#,
            r#"{"t":"agent_handle","pipe":"x","token":"y"}"#,
            r#"{"ok":"ok"}"#,
            "null",
            "[]",
        ] {
            assert!(
                interpret(reply).is_err(),
                "{reply:?} must not be read as a raised secure attention sequence",
            );
        }
    }

    #[test]
    fn a_missing_service_reads_as_a_missing_service_and_not_as_an_error_number() {
        // The overwhelmingly likely case: the SYSTEM service is opt-in and most
        // installs have never enabled it. "os error 2" would send nobody
        // anywhere.
        let texts = [
            describe_open_error(&std::io::Error::from_raw_os_error(2)),
            describe_open_error(&std::io::Error::from_raw_os_error(231)),
            describe_open_error(&std::io::Error::from_raw_os_error(5)),
            describe_open_error(&std::io::Error::other("something else")),
        ];
        assert!(texts[0].contains("not running"), "{}", texts[0]);
        assert!(texts[0].contains("unattended access"), "must say how to fix it: {}", texts[0]);
        assert!(texts[1].contains("busy"), "{}", texts[1]);
        assert!(texts[2].contains("not allowed"), "{}", texts[2]);

        for (i, a) in texts.iter().enumerate() {
            for b in texts.iter().skip(i + 1) {
                assert_ne!(a, b, "two different causes must not read the same");
            }
        }
    }

    #[test]
    fn only_a_busy_pipe_is_worth_retrying() {
        // Stated as a property of the constants rather than by timing a real
        // dial: five attempts at 120ms is a little over half a second, which is
        // long enough to ride out the desktop app's own poll and short enough
        // that a viewer waiting on a button does not think it has hung.
        assert!(BUSY_ATTEMPTS >= 2, "one attempt is not a retry");
        assert!(
            BUSY_ATTEMPTS as u128 * BUSY_WAIT.as_millis() < 2_000,
            "a control-channel request must not stall the session for seconds",
        );
    }
}
