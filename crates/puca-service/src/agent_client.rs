//! The service's own connection to the agent it launched.
//!
//! WHY THE SERVICE NEEDS ONE. Until now nothing in this crate ever dialled the
//! agent: `AgentHandle` hands the pipe name and token to the DESKTOP APP, which
//! does the talking. At a sign-in screen there is no app, so the service has to
//! be the one driving — it is the only process that knows the launch token,
//! because that token deliberately never leaves it (`main.rs`: "Nothing is
//! published. The token stays in this process").
//!
//! WHAT IT MAY AND MAY NOT SEND. Everything crossing this pipe for a remote
//! session is SEALED and opaque to this process — see `puca-agent`'s
//! `SealedSignal`. The service relays ciphertext and reads the agent's yes/no;
//! it never learns what a controller asked for, and it never holds the session
//! key. That is deliberate and is the whole reason the key stayed in the agent:
//! this process also holds a public internet socket.
//!
//! FRAMING: newline-delimited JSON, one request one response, `hello` first.
//! Copied from `frontend/src-tauri/src/agent_ipc.rs`, which is the only other
//! implementation, so the two cannot disagree about what a frame looks like.

#![cfg(windows)]

use std::io::{BufRead, BufReader, Write};

/// The agent protocol version this client speaks.
///
/// THIS LITERAL AND `puca_agent::protocol::PROTOCOL_VERSION` ARE TWO HALVES
/// OF ONE NUMBER. They are compiled separately — the agent is a bin-only crate
/// with no lib target — so nothing but this comment couples them. `agent_ipc.rs`
/// carries the same warning for the same reason.
pub const PROTOCOL_VERSION: u32 = 2;

pub struct AgentClient {
    reader: BufReader<std::fs::File>,
    writer: std::fs::File,
}

/// Turn a failed pipe open into a message that names WHICH of three very
/// different problems happened, rather than a bare OS error number.
///
/// Before this, "not installed", "starting up" and "someone else is talking to
/// it" all produced the same shape of string — `e.to_string()` verbatim — and
/// only the raw number at the end told them apart, which nobody reads a log
/// looking for. `os error 231` (`ERROR_PIPE_BUSY`) is exactly the symptom that
/// went undiagnosed for three consecutive refused sessions: the OTHER
/// legitimate client (the desktop app, borrowing this same pipe — see
/// `frontend/src-tauri/src/agent_ipc.rs`'s idle-release fix) was holding the
/// single instance this pipe allows.
///
/// SAME LOGIC IN `agent_ipc.rs`, deliberately duplicated rather than shared —
/// the two crates share no dependency edge, and a raw OS error number is worth
/// naming identically wherever it is read.
fn describe_open_error(e: &std::io::Error) -> String {
    match e.raw_os_error() {
        // ERROR_PIPE_BUSY: the pipe exists and IS being served, but its one
        // instance (`puca-agent/src/pipe.rs`'s nMaxInstances = 1) is
        // already connected to someone else.
        Some(231) => format!("the agent is busy with another connection ({e})"),
        // ERROR_FILE_NOT_FOUND: no agent is listening under this name at all —
        // not started yet, or the wrong session's pipe name was guessed.
        Some(2) => format!("no agent is listening on that pipe yet ({e})"),
        // ERROR_ACCESS_DENIED: the pipe exists but this caller's SID is not on
        // its ACL — a genuinely different problem from either of the above.
        Some(5) => format!("this caller is not allowed to open that pipe ({e})"),
        _ => e.to_string(),
    }
}

impl AgentClient {
    /// Dial the agent and authenticate.
    ///
    /// `SECURITY_IDENTIFICATION` and not the default: without it a squatting
    /// pipe server gets to IMPERSONATE whoever connects, and whoever connects
    /// here is LocalSystem. The desktop app sets the same flag for a far less
    /// dangerous caller.
    pub fn connect(pipe_name: &str, token: &str, attempts: u32) -> Result<Self, String> {
        use std::os::windows::fs::OpenOptionsExt;
        const SECURITY_SQOS_PRESENT: u32 = 0x0010_0000;
        const SECURITY_IDENTIFICATION: u32 = 0x0001_0000;

        let mut last = String::new();
        for _ in 0..attempts.max(1) {
            match std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .custom_flags(SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION)
                .open(pipe_name)
            {
                Ok(handle) => {
                    let writer = handle
                        .try_clone()
                        .map_err(|e| format!("could not clone the pipe handle: {e}"))?;
                    let mut c = Self { reader: BufReader::new(handle), writer };
                    // Authenticate immediately: every other command is refused
                    // until this lands, so a bad token should surface here and
                    // not at the first real request.
                    let hello = serde_json::json!({
                        "cmd": "hello",
                        "token": token,
                        "version": PROTOCOL_VERSION,
                    });
                    let reply = c.exchange(&hello.to_string())?;
                    if !reply.contains("\"ok\":\"hello\"") {
                        return Err(format!("the agent refused our token: {reply}"));
                    }
                    return Ok(c);
                }
                Err(e) => {
                    last = describe_open_error(&e);
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
            }
        }
        Err(format!("could not open {pipe_name}: {last}"))
    }

    pub fn exchange(&mut self, request: &str) -> Result<String, String> {
        self.writer
            .write_all(format!("{request}\n").as_bytes())
            .map_err(|e| format!("could not write to the agent: {e}"))?;
        self.writer.flush().ok();

        let mut line = String::new();
        self.reader
            .read_line(&mut line)
            .map_err(|e| format!("could not read from the agent: {e}"))?;
        if line.trim().is_empty() {
            return Err("the agent closed the connection".into());
        }
        Ok(line.trim().to_string())
    }

    /// Send a request built from a JSON value, and parse the reply.
    pub fn call(&mut self, req: &serde_json::Value) -> Result<serde_json::Value, String> {
        let raw = self.exchange(&req.to_string())?;
        serde_json::from_str(&raw).map_err(|e| format!("the agent sent something unreadable: {e}"))
    }
}

/// The agent said no. Returns the message if the reply is an error, else None.
///
/// A FUNCTION RATHER THAN AN INLINE CHECK because the agent's refusals are the
/// good half of its diagnostics — "that session is already streaming" and "no
/// monitor" send you to different places — and every call site must pass them
/// through rather than replacing them with a generic failure.
pub fn error_of(reply: &serde_json::Value) -> Option<String> {
    if reply.get("ok").and_then(|x| x.as_str()) == Some("error") {
        return Some(
            reply
                .get("message")
                .and_then(|x| x.as_str())
                .unwrap_or("the agent refused, without saying why")
                .to_string(),
        );
    }
    None
}

/// The sealed frames an agent reply carries, if any.
pub fn sealed_payloads(reply: &serde_json::Value) -> Vec<String> {
    reply
        .get("payloads")
        .and_then(|x| x.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_busy_pipe_reads_differently_from_a_missing_or_forbidden_one() {
        // THE FIX FOR THREE INDISTINGUISHABLE LOG LINES. "not installed",
        // "starting up" and "someone else has it" used to all read as
        // `e.to_string()` verbatim, with only a trailing OS number telling
        // them apart — which is exactly how a real pipe-contention bug (the
        // desktop app holding the agent's one instance) went undiagnosed for
        // three consecutive refused sessions.
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
    fn the_protocol_version_is_stated_where_a_reader_will_see_it() {
        // The agent refuses a hello whose version it does not know. These two
        // literals live in separately-compiled crates, so when the agent's
        // PROTOCOL_VERSION moves, this must move with it — and the only thing
        // that will tell you is this constant's comment and a session that
        // stops working.
        assert_eq!(PROTOCOL_VERSION, 2);
    }

    #[test]
    fn an_agent_refusal_is_passed_through_rather_than_flattened() {
        let refused = serde_json::json!({
            "ok": "error",
            "message": "that session is already streaming",
        });
        assert_eq!(error_of(&refused).as_deref(), Some("that session is already streaming"));

        // A success is not an error, however it is shaped.
        assert_eq!(error_of(&serde_json::json!({ "ok": "ok" })), None);
        assert_eq!(error_of(&serde_json::json!({ "ok": "sealed_signals" })), None);

        // An error with no message still reports SOMETHING: returning None here
        // would make a refusal look like success.
        assert!(error_of(&serde_json::json!({ "ok": "error" })).is_some());
    }

    #[test]
    fn sealed_payloads_are_read_without_being_understood() {
        let reply = serde_json::json!({
            "ok": "sealed_signals",
            "payloads": ["AAAA", "BBBB"],
        });
        assert_eq!(sealed_payloads(&reply), vec!["AAAA", "BBBB"]);

        // No payloads is the normal case for an ICE candidate, and must be an
        // empty list rather than an error.
        assert!(sealed_payloads(&serde_json::json!({ "ok": "sealed_signals" })).is_empty());
        assert!(sealed_payloads(&serde_json::json!({ "ok": "ok" })).is_empty());

        // Non-strings are dropped rather than panicking: this parses whatever
        // came off a pipe inside a LocalSystem service.
        assert_eq!(
            sealed_payloads(&serde_json::json!({ "payloads": ["ok", 7, null] })),
            vec!["ok"]
        );
    }

    #[test]
    fn the_hello_frame_matches_what_the_agent_parses() {
        // Built as JSON rather than a format! string so a token containing a
        // quote cannot break the frame — agent_ipc.rs builds this one by
        // interpolation, which is safe only because its token is hex.
        let hello = serde_json::json!({
            "cmd": "hello",
            "token": "a\"b\\c",
            "version": PROTOCOL_VERSION,
        });
        let s = hello.to_string();
        assert!(s.contains(r#""cmd":"hello""#));
        assert!(s.contains(r#""version":2"#));
        // The quote survived as data rather than ending the string early.
        let back: serde_json::Value = serde_json::from_str(&s).expect("still valid JSON");
        assert_eq!(back["token"], "a\"b\\c");
    }
}
