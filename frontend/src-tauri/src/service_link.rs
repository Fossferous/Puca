//! Ask the system service whether it already has an agent worth using.
//!
//! WHY THIS EXISTS. An agent launched by this app runs on this app's token, and
//! a user-token process cannot see the Windows lock screen, the sign-in screen,
//! or a UAC prompt — Windows puts those on a separate desktop that only SYSTEM
//! may open. So while the machine is locked, the app's own agent is capturing a
//! desktop nobody is looking at.
//!
//! The optional system service launches an agent as SYSTEM for exactly that
//! window: while the console is locked or nobody is signed in, and never while
//! somebody is using the machine. This asks whether such an agent exists and,
//! if so, borrows it.
//!
//! WHY "ASK, THEN FALL BACK" IS THE WHOLE POLICY. The service runs its agent
//! only when the app's own agent would be useless, and stops it the moment that
//! stops being true. So preferring the service's agent whenever it offers one,
//! and launching our own otherwise, tracks the lock state exactly without this
//! module ever knowing what the lock state is. Nothing here polls, subscribes,
//! or keeps a flag that could go stale.
//!
//! ABSENT BY DEFAULT. The service is opt-in and most machines will not have it.
//! Every failure here — no pipe, no service, a refusal — means "we were not
//! given one", and the caller carries on exactly as it did before this file
//! existed. It must never turn an ordinary session into an error.

#![cfg(windows)]

use std::io::{BufRead, BufReader, Write};
use std::time::Duration;

/// How to reach an agent somebody else launched.
pub struct BorrowedAgent {
    pub pipe: String,
    pub token: String,
}

/// The service's control pipe, imported rather than written out again.
///
/// This was very nearly a second literal, and the first guess at it was wrong —
/// `sovereign-control` instead of `puca-service`. Two halves of a pipe name
/// living in two crates fail by SILENTLY DOING NOTHING: the app opens a path
/// nobody is serving, gets a clean "not found", treats that as "no service
/// installed", and the whole feature is simply absent with no error anywhere to
/// explain it. Importing the constant makes the mismatch unrepresentable.
use puca_service::control::CONTROL_PIPE;

/// Ask the service for its agent, or `None` for every other outcome.
///
/// Deliberately returns an Option rather than a Result: there is exactly one
/// interesting answer here, and "the service is not installed" is the common
/// case rather than a fault. Logging a failure would put a line in every user's
/// log on every connect for a feature they have not turned on.
pub fn borrow_system_agent() -> Option<BorrowedAgent> {
    // BOUNDED BY A WORKER THREAD, because there is no read timeout on a
    // std::fs::File — that is a socket API, and a named pipe opened this way
    // blocks for ever if the far end accepts and never answers.
    //
    // This runs while the agent lock is held and a session is being opened, so
    // an unbounded wait here is a session that never starts and a UI that never
    // explains why. A wedged service must cost a second and a half, not a
    // session. The thread is abandoned rather than joined on timeout: it
    // unblocks when the pipe closes, and one parked thread is a far better
    // outcome than a frozen connect.
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(ask());
    });
    match rx.recv_timeout(Duration::from_millis(1500)) {
        Ok(v) => v,
        Err(_) => {
            eprintln!("[agent] the system service did not answer in time; using our own agent");
            None
        }
    }
}

/// The blocking half, run on a thread that may be abandoned.
/// Read a `ControlResponse` into a handle.
///
/// SPLIT OUT SO IT CAN BE TESTED. `ask()` opens a real named pipe, so the parse
/// inside it was never executed by any test — and it was WRONG from the day it
/// was written: it read "ok" and "payload" while the service sends "t" with the
/// fields inline, so it returned None on every machine, forever. Nothing went
/// red, because the caller treats None as "no service installed" and quietly
/// launches its own agent. A dead handoff and a working fallback look identical
/// from outside.
///
/// The first attempt at a regression test asserted the SHAPE of the service's
/// response and still passed with the bug reinstated, because it never ran this
/// code. That is why this is a function.
fn parse_handle(v: &serde_json::Value) -> Option<BorrowedAgent> {
    // `ControlResponse` is INTERNALLY tagged — `#[serde(tag = "t")]` — so the
    // discriminant is "t" and the fields sit beside it:
    //
    //     {"t":"agent_handle","pipe":"...","token":"..."}
    if v.get("t")?.as_str()? != "agent_handle" {
        return None;
    }
    Some(BorrowedAgent {
        pipe: v.get("pipe")?.as_str()?.to_string(),
        token: v.get("token")?.as_str()?.to_string(),
    })
}

fn ask() -> Option<BorrowedAgent> {
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(CONTROL_PIPE)
        .ok()?;

    let mut writer = file.try_clone().ok()?;
    writeln!(writer, "{}", r#"{"t":"agent_handle"}"#).ok()?;
    writer.flush().ok()?;

    let mut line = String::new();
    BufReader::new(file).read_line(&mut line).ok()?;

    let v: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    // Anything other than the handle — a refusal, a status, an unknown shape —
    // means we were not given one. The service already explains refusals in its
    // own log; repeating them here would put a line in every user's log on every
    // connect, for a feature they have not turned on.
    parse_handle(&v)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_service_is_not_an_error() {
        // THE DEFAULT PATH, and the one that must never regress. Most machines
        // will never have this service; on those, this call has to be a quiet
        // None rather than anything the caller has to handle. If the pipe
        // happens to exist on this machine the call may legitimately succeed,
        // so this asserts only that it does not panic or hang.
        let started = std::time::Instant::now();
        let _ = borrow_system_agent();
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "a missing service must fail fast, not block a session"
        );
    }

    #[test]
    fn the_pipe_name_is_a_real_windows_pipe_path() {
        // The name itself now comes from the service crate, so it cannot
        // disagree. What is still worth pinning is that it is a pipe path at
        // all: a bare name silently becomes a RELATIVE FILE in the working
        // directory, which opens, reads nothing, and looks exactly like "no
        // service installed".
        assert!(CONTROL_PIPE.starts_with(r"\\.\pipe\"), "{CONTROL_PIPE}");
    }

    #[test]
    fn the_parse_reads_what_the_service_actually_sends() {
        // RUNS THE REAL PARSE against the service's REAL type. Both halves
        // matter: a handwritten fixture would only pin my misreading, and
        // asserting the wire shape without calling parse_handle passes happily
        // while the parse is broken — which is exactly what the first version
        // of this test did.
        let real = puca_service::control::ControlResponse::AgentHandle {
            pipe: r"\.\pipe\sovereign-agent-1".into(),
            token: "tok".into(),
        };
        let wire = serde_json::to_string(&real).expect("serialise");
        let v: serde_json::Value = serde_json::from_str(&wire).expect("parse");

        let got = parse_handle(&v).expect("the handle must be readable");
        assert_eq!(got.pipe, r"\.\pipe\sovereign-agent-1");
        assert_eq!(got.token, "tok");
    }

    #[test]
    fn a_refusal_is_not_mistaken_for_a_handle() {
        let refused = puca_service::control::ControlResponse::Refused {
            reason: "only the user signed in at this computer's own screen can do this".into(),
        };
        let wire = serde_json::to_string(&refused).expect("serialise");
        let v: serde_json::Value = serde_json::from_str(&wire).expect("parse");
        assert!(parse_handle(&v).is_none(), "a refusal must not read as a handle");
    }
}

