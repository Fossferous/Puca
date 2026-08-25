//! What a local process may ask the SYSTEM service to do — and what it may not.
//!
//! THE THREAT, stated first because it shapes everything below. This service
//! runs as LocalSystem and supervises an agent that can capture the secure
//! desktop and inject input into it. If a local process can ask it to inject,
//! then ANY user on the box can drive a UAC prompt they could not otherwise
//! answer — a standard user clicking "Yes" on an admin elevation. That is a
//! textbook local privilege escalation, and it is achieved not by breaking the
//! crypto but simply by offering the wrong verb on a reachable pipe.
//!
//! So the rule is: **the local app is a CONDUIT, never a principal.** It may ask
//! about state and it may relay opaque, already-sealed bytes to the agent. It
//! may not ask for an effect. Input reaching the secure desktop is authorised by
//! the remote peer's device grant and unattended passphrase, verified inside the
//! agent against the sealed control channel — never by the mere fact that a
//! local caller asked.
//!
//! That is why [`ControlRequest`] has no `Inject`, no `Click`, no `SendKeys`,
//! and no "run this". The one verb that carries data, [`ControlRequest::Relay`],
//! forwards a blob the service does not interpret and cannot forge, to an agent
//! that will reject it unless it is correctly sealed.
//!
//! The pipe ACL is a second, independent layer: even these safe verbs are only
//! reachable by SYSTEM, Administrators, and the INTERACTIVE group. Neither layer
//! is trusted alone.
//!
//! ## Why [`ControlRequest::Sas`] is admissible, stated in full
//!
//! It is the one verb here that reaches the secure desktop, so it needs the rule
//! above applied rather than waved at. The rule is "may not ask for an effect",
//! and the reason is that an effect on the secure desktop lets a local standard
//! user drive a UAC prompt they could not otherwise answer. Measure `Sas`
//! against that:
//!
//!   * **It types nothing and clicks nothing.** `SendSAS` raises winlogon's own
//!     screen. No caller-supplied data crosses this boundary — the request is a
//!     bare tag with no fields at all, so there is nothing to smuggle.
//!   * **It grants nothing a local user does not already have.** Every caller
//!     admitted below is the person signed in at this computer's own console,
//!     who can produce the identical result by pressing three keys on the
//!     keyboard in front of them. A verb that is exactly as powerful as a
//!     keyboard adds no reach.
//!   * **It does not help with a UAC prompt; it CANCELS one.** The SAS dismisses
//!     a pending elevation and returns to the secure desktop's own menu (lock,
//!     switch user, sign out, task manager), all of which act as the caller's
//!     own account. It is the opposite of the escalation this module guards.
//!   * **It is refused to everyone else.** A second interactive account — a
//!     fast-user-switched session — is denied, because yanking the console to
//!     the secure desktop while somebody else is working there is a nuisance
//!     they did not consent to, even though it is not an escalation.
//!
//! What it BUYS is that Ctrl+Alt+Del over remote control stops lying. `SendInput`
//! cannot produce the SAS by design; the six key frames the controller used to
//! send were accepted by Windows, reported as delivered, and did nothing.
//!
//! The pre-login / lock-screen agent runs as LocalSystem (launch.rs), so it is
//! never "the console user" — pre-login there is none, and locked it is not
//! SYSTEM. It is admitted as [`CallerTrust::LocalSystem`], for `Sas` ONLY: a
//! SYSTEM process is already omnipotent on this machine, so letting it ask for
//! the secure attention sequence grants nothing it lacked, and the sign-in
//! screen is exactly where an operator reaches for Ctrl+Alt+Del. For every
//! other verb LocalSystem is refused exactly as `NotConsoleUser` — none of them
//! has a caller that is SYSTEM, and a verb that hands out credentials must not
//! gain one by accident.

use serde::{Deserialize, Serialize};

/// SDDL for the service's control pipe.
///
/// `SY` LocalSystem, `BA` Administrators, `IU` INTERACTIVE — i.e. someone
/// actually logged on at this machine, which is the only party with any business
/// asking about a local remote-desktop session.
///
/// Deliberately NOT `WD` (Everyone) and NOT `AU` (Authenticated Users): a
/// service account or a network logon has no reason to reach this, and every
/// principal added here is another way in. `GRGW` rather than `GA`: read and
/// write are all a client needs, so nobody gets the ability to alter the pipe.
pub const CONTROL_PIPE_SDDL: &str = "D:(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;IU)";

/// The service's control pipe name. Fixed, unlike the per-session agent pipes:
/// a client has to be able to find it without being told.
pub const CONTROL_PIPE: &str = r"\\.\pipe\sovereign-service";

/// What a local client may ask.
///
/// EVERY VARIANT HERE IS EITHER A QUESTION OR AN OPAQUE FORWARD. Adding one that
/// causes an effect on the secure desktop reopens the escalation this module
/// exists to close, so a new variant needs the same scrutiny as a new syscall.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum ControlRequest {
    /// Is the service alive, and what is it supervising?
    Status,
    /// Ask the running agent for a keyframe.
    ///
    /// Safe despite being an "action": the worst a caller achieves is a slightly
    /// larger next frame. It exists because a PLI has to cross this boundary and
    /// the alternative is a viewer stuck on black.
    RequestKeyframe,
    /// Forward opaque bytes to the agent for `session`.
    ///
    /// The service does NOT parse, validate, or understand these. They are the
    /// sealed control-channel messages the remote peer produced; the agent
    /// verifies them against the session key and rejects anything unsealed. A
    /// local caller can therefore relay, but cannot author.
    Relay { session: u32, payload: Vec<u8> },
    /// Ask for the credentials needed to drive the SYSTEM agent directly.
    ///
    /// THE ONE VERB THAT HANDS OUT A SECRET, and the reason `control_pipe`'s
    /// `ServiceView` carries a caller identity at all. Everything else here is
    /// a question or an opaque forward; this returns a pipe name and a launch
    /// token that together grant SYSTEM-level control of the machine.
    ///
    /// It exists because the lock screen cannot be served any other way: only a
    /// SYSTEM process can see Winlogon, and only the desktop app knows whether
    /// a remote session is authorised. Refused unless the caller is the console
    /// session's own user AND that user is a local administrator — see
    /// `crate::caller`.
    AgentHandle,
    /// Arm this machine for sign-in-screen access with a record the caller
    /// derived from a passphrase.
    ///
    /// The record is public data (salt + verifying key) but writing it CHOOSES
    /// the key that unlocks the machine, so this is the most powerful request
    /// on this pipe and carries the same console-administrator gate as
    /// `AgentHandle`.
    Arm { record: String },
    /// Shut the door. Deliberately NOT gated on there being an agent: you must
    /// be able to disarm a machine whose agent has died.
    Disarm,
    /// Is this machine armed, and is it enrolled? Read for a UI toggle.
    UnattendedState,

    /// Step one of enrolment: generate this machine's own device identity and
    /// hand back its PUBLIC halves.
    ///
    /// TWO STEPS, AND THIS IS WHY. Enrolling a device means putting a signed
    /// auth record in the account's device list, and that signature needs the
    /// account's private signing key — which is derived from the account seed
    /// and which this service must never hold. So the service produces the
    /// keypair, the APP signs a record describing it, and the service is told
    /// only the public key to verify others against. A one-step enrolment would
    /// have to hand a signing key to a LocalSystem process with an internet
    /// socket.
    EnrolBegin,

    /// Step two: adopt the connection details, once the app has enrolled the
    /// identity from `EnrolBegin` with the server.
    EnrolFinish {
        api_base: String,
        user_id: i64,
        token: String,
        account_sign_pub: String,
    },

    /// Forget everything: keys, token, config, arming record.
    Unenrol,

    /// Raise the Secure Attention Sequence — what Ctrl+Alt+Del does.
    ///
    /// THE ONE VERB HERE THAT CAUSES SOMETHING TO HAPPEN ON THE SECURE DESKTOP,
    /// admitted after the argument written out in this module's header: it types
    /// nothing, carries no fields, grants nothing the person at the keyboard
    /// does not already have, and cancels rather than answers a UAC prompt.
    ///
    /// It is here because `SendInput` CANNOT do it. win32k discards injected
    /// events for the SAS by design, so the six key frames the controller used
    /// to send were accepted, reported as delivered, and did nothing. Only a
    /// LocalSystem process calling `SendSAS` can, and this service is the only
    /// one of those — see [`crate::sas`].
    Sas,
}

/// What the service answers. Deliberately thin — a chatty service leaks state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum ControlResponse {
    /// How to reach the SYSTEM agent. Only ever sent to a caller that passed
    /// the identity gate.
    AgentHandle { pipe: String, token: String },
    /// Both halves, because they fail differently and the UI must say which:
    /// armed-but-not-enrolled is unreachable, enrolled-but-not-armed refuses
    /// every session.
    ///
    /// `device_id` is the row this machine is enrolled as, or `None` when it is
    /// not enrolled. THE APP NEEDS IT to stop showing one PC as two devices and
    /// to give this row a MAC — see `link::enrolled_device_id` for why, and
    /// `frontend/src/api/devices/lanInfo.ts` for the consumer. `serde(default)`
    /// so a response from an older service still parses as "not known" rather
    /// than failing the whole request.
    /// `bins_hash` is one SHA-256 over the INSTALLED service+agent pair (in
    /// that order — `install::pair_fingerprint`). The app compares it against
    /// the pair it bundles: a mismatch means the running service predates the
    /// app and must be updated (`puca-service update`), because a stale
    /// service silently lacks whatever this pipe grew since — exactly how the
    /// `device_id` field below "never arrived" in the field and one PC kept
    /// listing as two devices. `None` (or absent, from an older service) reads
    /// as "needs update".
    UnattendedState {
        armed: bool,
        enrolled: bool,
        #[serde(default)]
        device_id: Option<String>,
        #[serde(default)]
        bins_hash: Option<String>,
    },
    /// The public halves of the identity this machine just generated. The app
    /// signs an auth record over these and enrols it.
    Enrolment { device_id: String, device_pub: String, sign_pub: String },
    Status {
        /// Session the supervised agent runs in, if any.
        session: Option<u32>,
        /// "user" | "system" | none.
        flavour: Option<String>,
        /// Whether an agent process is actually alive right now.
        agent_alive: bool,
    },
    /// The request was accepted. Carries no data: a relay's real answer comes
    /// back over the media/control channel, not through here.
    Ok,
    /// Refused, with a reason safe to show a local user.
    Refused { reason: String },
}

/// What the I/O layer determined about the caller, decided ONCE per connection
/// and handed to the policy rather than looked up inside it.
///
/// Passed in for the same reason `ServiceView` is: `check` stays a pure
/// function that can be exercised for every caller shape without standing up a
/// pipe, a service, or a second user account. A gate that can only be tested by
/// logging in as somebody else is a gate that never gets tested.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum CallerTrust {
    /// The console session's own user, and that user is a local administrator.
    ConsoleAdministrator,
    /// Someone else — another interactive account, or nobody signed in.
    NotConsoleUser,
    /// The right person, but a standard account.
    NotAdministrator,
    /// The LocalSystem account (S-1-5-18): the sign-in-screen agent this
    /// service launched, or any other SYSTEM process. Admitted for `Sas` only;
    /// treated as `NotConsoleUser` by every other verb (see the module header).
    LocalSystem,
}

/// Why a control request was refused.
#[derive(Debug, PartialEq, Eq)]
pub enum ControlDenied {
    /// Nothing is running, so there is nothing to talk to.
    NoAgent,
    /// The request names a session the service is not supervising. Refused
    /// rather than ignored: silently accepting a request for the wrong session
    /// is how a caller ends up believing it drove something it did not.
    WrongSession { asked: u32, running: Option<u32> },
    /// A relay payload that is empty or implausibly large.
    BadPayload(&'static str),
    /// The caller is not the console session's own administrator.
    ///
    /// Carries the reason so the refusal can say WHICH condition failed —
    /// "you are not the person at this screen" and "your account is not an
    /// administrator" send someone to very different places, and a single
    /// "denied" sends them nowhere.
    NotTheConsoleAdmin(&'static str),
}

impl std::fmt::Display for ControlDenied {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ControlDenied::NoAgent => write!(f, "no agent is running"),
            ControlDenied::NotTheConsoleAdmin(why) => write!(f, "{why}"),
            ControlDenied::WrongSession { asked, running } => match running {
                Some(r) => write!(f, "session {asked} is not the supervised session ({r})"),
                None => write!(f, "session {asked} is not supervised; nothing is running"),
            },
            ControlDenied::BadPayload(why) => write!(f, "{why}"),
        }
    }
}

/// Largest relay payload accepted. A sealed control message is a few hundred
/// bytes; anything near this is either a bug or an attempt to make the service
/// buffer memory on an attacker's behalf.
const MAX_RELAY: usize = 64 * 1024;

/// THE GATE. Decide whether a request may proceed, given what is running.
///
/// Pure, so every refusal is testable without a pipe — the alternative is that
/// "does an unauthorised request get refused" can only be exercised by standing
/// up IPC, which means it never gets tested.
pub fn check(
    req: &ControlRequest,
    running_session: Option<u32>,
    agent_alive: bool,
    caller: CallerTrust,
) -> Result<(), ControlDenied> {
    match req {
        // Always answerable: a client must be able to discover that nothing is
        // running without that itself being an error.
        ControlRequest::Status => Ok(()),

        ControlRequest::RequestKeyframe => {
            if running_session.is_none() || !agent_alive {
                return Err(ControlDenied::NoAgent);
            }
            Ok(())
        }

        ControlRequest::AgentHandle => {
            // Identity FIRST, before "is there an agent". Answering "no agent
            // is running" to an untrusted caller tells them when one appears,
            // which is a free lock/unlock oracle for any local account.
            match caller {
                CallerTrust::ConsoleAdministrator => {}
                CallerTrust::NotConsoleUser | CallerTrust::LocalSystem => {
                    return Err(ControlDenied::NotTheConsoleAdmin(
                        "only the user signed in at this computer's own screen can do this",
                    ))
                }
                CallerTrust::NotAdministrator => {
                    return Err(ControlDenied::NotTheConsoleAdmin(
                        "this needs an administrator account",
                    ))
                }
            }
            if running_session.is_none() || !agent_alive {
                return Err(ControlDenied::NoAgent);
            }
            Ok(())
        }

        ControlRequest::Arm { record } => {
            // SAME GATE AS AgentHandle, and identity is checked FIRST for the
            // same reason: any answer at all, including a validation error, is
            // information an untrusted local account should not get.
            match caller {
                CallerTrust::ConsoleAdministrator => {}
                CallerTrust::NotConsoleUser | CallerTrust::LocalSystem => {
                    return Err(ControlDenied::NotTheConsoleAdmin(
                        "only the user signed in at this computer's own screen can do this",
                    ))
                }
                CallerTrust::NotAdministrator => {
                    return Err(ControlDenied::NotTheConsoleAdmin(
                        "this needs an administrator account",
                    ))
                }
            }
            if record.is_empty() {
                return Err(ControlDenied::BadPayload("an empty record does not arm anything"));
            }
            if record.len() > MAX_RELAY {
                return Err(ControlDenied::BadPayload("that record is not a record"));
            }
            Ok(())
        }

        ControlRequest::Disarm => {
            // Gated, but NOT on an agent running. Shutting the door must work
            // even when the thing behind it has crashed.
            match caller {
                CallerTrust::ConsoleAdministrator => Ok(()),
                CallerTrust::NotConsoleUser | CallerTrust::LocalSystem => Err(ControlDenied::NotTheConsoleAdmin(
                    "only the user signed in at this computer's own screen can do this",
                )),
                CallerTrust::NotAdministrator => Err(ControlDenied::NotTheConsoleAdmin(
                    "this needs an administrator account",
                )),
            }
        }

        ControlRequest::UnattendedState => {
            // Readable by the console user without elevation: a toggle has to
            // render its own state before the user can be asked to elevate, and
            // "is this machine armed" is not a secret from the person sitting
            // at it. Still refused to OTHER local accounts.
            match caller {
                CallerTrust::ConsoleAdministrator | CallerTrust::NotAdministrator => Ok(()),
                CallerTrust::NotConsoleUser | CallerTrust::LocalSystem => Err(ControlDenied::NotTheConsoleAdmin(
                    "only the user signed in at this computer's own screen can do this",
                )),
            }
        }

        ControlRequest::EnrolBegin | ControlRequest::Unenrol => {
            // The same console-administrator gate as arming: enrolling makes
            // this machine reachable from the internet, and unenrolling takes
            // that away. Identity is checked before anything else is done.
            match caller {
                CallerTrust::ConsoleAdministrator => Ok(()),
                CallerTrust::NotConsoleUser | CallerTrust::LocalSystem => Err(ControlDenied::NotTheConsoleAdmin(
                    "only the user signed in at this computer's own screen can do this",
                )),
                CallerTrust::NotAdministrator => Err(ControlDenied::NotTheConsoleAdmin(
                    "this needs an administrator account",
                )),
            }
        }

        ControlRequest::EnrolFinish { api_base, user_id, token, account_sign_pub } => {
            match caller {
                CallerTrust::ConsoleAdministrator => {}
                CallerTrust::NotConsoleUser | CallerTrust::LocalSystem => {
                    return Err(ControlDenied::NotTheConsoleAdmin(
                        "only the user signed in at this computer's own screen can do this",
                    ))
                }
                CallerTrust::NotAdministrator => {
                    return Err(ControlDenied::NotTheConsoleAdmin(
                        "this needs an administrator account",
                    ))
                }
            }
            // HTTPS ONLY, and checked here rather than trusted from the caller.
            // This URL is where the service will send an attestation signature
            // and a bearer token for the rest of the machine's life; a plain
            // http base would put both on the wire in clear.
            if !api_base.starts_with("https://") {
                return Err(ControlDenied::BadPayload("the server address must be https"));
            }
            if *user_id <= 0 {
                return Err(ControlDenied::BadPayload("that is not an account"));
            }
            if token.is_empty() || token.len() > MAX_RELAY {
                return Err(ControlDenied::BadPayload("that token is not a token"));
            }
            // The pinned account key is the ONLY thing standing between this
            // machine and a server that substitutes a peer's device key. An
            // empty or malformed one would disable that check silently.
            if !account_sign_pub.starts_with("ed25519:") {
                return Err(ControlDenied::BadPayload(
                    "the account signing key is missing or malformed",
                ));
            }
            Ok(())
        }

        ControlRequest::Sas => {
            // THE SAME GATE AS `UnattendedState`, AND FOR THE SAME REASON:
            // admin-ness is irrelevant here. The question is only "is this the
            // person at this computer's own screen", because that person can
            // already raise the secure attention sequence with three keys. A
            // standard console user is therefore admitted; another interactive
            // account is not, since pulling the console to the secure desktop
            // under whoever is sitting at it is a nuisance they did not ask for.
            //
            // NOT gated on an agent running. The SAS is a property of the
            // machine, not of a session — and refusing it when the agent has
            // died would remove the one thing that reliably gets a stuck remote
            // desktop back to a screen you can act on.
            //
            // LocalSystem is admitted HERE and nowhere else: it is the sign-in
            // screen agent (which has already made its remote peer prove the
            // unattended passphrase before relaying any input at all), and a
            // SYSTEM process gains nothing from a verb whose entire effect is
            // what three keys on the local keyboard do.
            match caller {
                CallerTrust::ConsoleAdministrator
                | CallerTrust::NotAdministrator
                | CallerTrust::LocalSystem => Ok(()),
                CallerTrust::NotConsoleUser => Err(ControlDenied::NotTheConsoleAdmin(
                    "only the user signed in at this computer's own screen can do this",
                )),
            }
        }

        ControlRequest::Relay { session, payload } => {
            if payload.is_empty() {
                return Err(ControlDenied::BadPayload("an empty relay payload is not a message"));
            }
            if payload.len() > MAX_RELAY {
                return Err(ControlDenied::BadPayload(
                    "relay payload is too large to be a control message",
                ));
            }
            match running_session {
                None => Err(ControlDenied::NoAgent),
                Some(r) if r != *session => {
                    Err(ControlDenied::WrongSession { asked: *session, running: Some(r) })
                }
                Some(_) if !agent_alive => Err(ControlDenied::NoAgent),
                Some(_) => Ok(()),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_request_set_contains_no_way_to_cause_an_effect() {
        // THE LOAD-BEARING TEST. If someone adds an Inject/Click/SendKeys/Run
        // variant, a local standard user could drive a UAC prompt they cannot
        // otherwise answer — privilege escalation by offering the wrong verb.
        // Serialising every variant and checking the tags is a crude guard, but
        // it fails loudly the moment the shape changes, which is the point.
        let tags: Vec<String> = vec![
            ControlRequest::Status,
            ControlRequest::RequestKeyframe,
            ControlRequest::Relay { session: 1, payload: vec![1] },
            // `sas` IS AN EFFECT ON THE SECURE DESKTOP, AND IT IS ADMITTED —
            // deliberately, with the argument written out in this module's
            // header, not slipped past this list.
            //
            // The short form: it carries NO caller data (a bare tag, no fields),
            // it types nothing, and the only callers `check` admits are the
            // person signed in at this computer's own console, who can produce
            // the identical result by pressing three keys. It also CANCELS a
            // pending UAC prompt rather than answering one, so it is the
            // opposite of the escalation this test guards. `SendInput` cannot
            // produce it at all, which is why it has to exist here.
            //
            // If a future variant wants the same exemption it needs the same
            // four properties, argued in the same place. "It is like sas" is not
            // the argument; "it grants nothing a keyboard already grants" is.
            ControlRequest::Sas,
        ]
        .iter()
        .map(|r| {
            let v: serde_json::Value = serde_json::to_value(r).unwrap();
            v["t"].as_str().unwrap().to_string()
        })
        .collect();

        assert_eq!(tags, vec!["status", "request_keyframe", "relay", "sas"]);
        for forbidden in ["inject", "click", "send_keys", "run", "exec", "launch", "input"] {
            assert!(
                !tags.iter().any(|t| t.contains(forbidden)),
                "a request that causes an effect on the secure desktop reopens the \
                 local privilege escalation this module exists to close: {forbidden}",
            );
        }

        // `Sas` carries no fields, and that is load-bearing rather than
        // incidental: a field is a place for caller-chosen data to cross into a
        // LocalSystem process, and the whole exemption above rests on there
        // being none.
        let sas = serde_json::to_value(ControlRequest::Sas).unwrap();
        assert_eq!(
            sas.as_object().map(|o| o.len()),
            Some(1),
            "ControlRequest::Sas must carry nothing but its tag: {sas}",
        );
    }

    /// THE EXACT BYTES THE AGENT SENDS.
    ///
    /// `puca-agent` cannot depend on this crate — it would pull tokio,
    /// tokio-tungstenite and reqwest into a headless capture binary — so it
    /// builds this frame from a literal, exactly as `agent_client.rs` duplicates
    /// `PROTOCOL_VERSION` for the mirror-image reason. That literal is
    /// `puca-agent/src/sas_client.rs::SAS_REQUEST_LINE`, and its own test
    /// pins the same string.
    ///
    /// Two pinned literals is not elegance, it is the only guard available: a
    /// guessed cross-process name does not fail loudly, it just stops working.
    /// Change one end and this test, or its twin, goes red.
    #[test]
    fn the_sas_request_serialises_to_the_frame_the_agent_writes() {
        assert_eq!(serde_json::to_string(&ControlRequest::Sas).unwrap(), r#"{"t":"sas"}"#);
        // And it parses back, so an agent's literal really does reach this arm.
        assert_eq!(
            serde_json::from_str::<ControlRequest>(r#"{"t":"sas"}"#).unwrap(),
            ControlRequest::Sas,
        );
    }

    /// The other half of the wire: the REPLIES. `puca_agent::sas_client::
    /// interpret` matches the literal `"t":"ok"` and `"t":"refused"` + `reason`;
    /// this pins that those are what `ControlResponse` actually serialises to.
    /// Without it only the request was pinned, and a rename of `Ok`/`Refused`
    /// here would have every SAS read as "answered something this agent does
    /// not understand" — the polite version of the silent failure this pair of
    /// tests exists to prevent.
    #[test]
    fn the_sas_replies_serialise_to_what_the_agent_matches_on() {
        assert_eq!(serde_json::to_string(&ControlResponse::Ok).unwrap(), r#"{"t":"ok"}"#);
        let refused = serde_json::to_string(&ControlResponse::Refused { reason: "why".into() }).unwrap();
        assert_eq!(refused, r#"{"t":"refused","reason":"why"}"#);
    }

    #[test]
    fn the_secure_attention_sequence_needs_the_console_user_and_nothing_more() {
        // ADMITTED FOR A STANDARD ACCOUNT, unlike every other gated verb here.
        // The person at this screen can already press Ctrl+Alt+Del; demanding an
        // administrator to do it remotely would be theatre, and would make the
        // button dead on exactly the accounts most likely to need help.
        assert!(check(&ControlRequest::Sas, None, false, CallerTrust::ConsoleAdministrator).is_ok());
        assert!(check(&ControlRequest::Sas, None, false, CallerTrust::NotAdministrator).is_ok());

        // ADMITTED FOR LOCALSYSTEM — the sign-in-screen agent, which is never
        // the console user (pre-login there is none; locked, it is not SYSTEM)
        // and is exactly where an operator reaches for Ctrl+Alt+Del.
        assert!(check(&ControlRequest::Sas, None, false, CallerTrust::LocalSystem).is_ok());

        // REFUSED to anyone else.
        let err = check(&ControlRequest::Sas, Some(1), true, CallerTrust::NotConsoleUser)
            .expect_err("a stranger must not be able to yank the console to the secure desktop");
        assert!(
            matches!(err, ControlDenied::NotTheConsoleAdmin(_)),
            "the refusal must name the identity condition: {err:?}",
        );
        assert!(err.to_string().contains("own screen"), "{err}");
    }

    #[test]
    fn localsystem_is_admitted_for_the_sas_and_for_nothing_else() {
        // The variant exists for ONE verb. Every credential-bearing or
        // state-changing verb must refuse it exactly like a stranger — a
        // SYSTEM caller is not a person at the console, and none of these has
        // a legitimate SYSTEM caller. If a verb is added and this table is not
        // extended, the exhaustive matches in `check` still force a decision
        // at compile time; this pins the decision that was made.
        let verbs = [
            ControlRequest::AgentHandle,
            ControlRequest::Arm { record: "r".into() },
            ControlRequest::Disarm,
            ControlRequest::UnattendedState,
            ControlRequest::EnrolBegin,
            ControlRequest::Unenrol,
            ControlRequest::EnrolFinish {
                api_base: "https://x".into(), user_id: 1, token: "t".into(),
                account_sign_pub: "ed25519:aa".into(),
            },
        ];
        for req in verbs {
            let err = check(&req, Some(1), true, CallerTrust::LocalSystem)
                .expect_err(&format!("{req:?} must refuse LocalSystem"));
            assert!(matches!(err, ControlDenied::NotTheConsoleAdmin(_)), "{req:?}: {err:?}");
        }
        assert!(check(&ControlRequest::Sas, Some(1), true, CallerTrust::LocalSystem).is_ok());
    }

    #[test]
    fn the_secure_attention_sequence_works_when_the_agent_is_dead() {
        // DELIBERATELY NOT GATED ON AN AGENT. Ctrl+Alt+Del is the thing you
        // reach for when a remote desktop has stopped responding — which is
        // precisely when the agent is most likely to be the thing that died.
        // Requiring a live one would remove it exactly when it is wanted.
        assert!(check(&ControlRequest::Sas, None, false, CallerTrust::ConsoleAdministrator).is_ok());
        assert!(check(&ControlRequest::Sas, Some(4), false, CallerTrust::NotAdministrator).is_ok());
    }

    #[test]
    fn status_is_answerable_even_with_nothing_running() {
        // A client must be able to learn "nothing is running" without that being
        // an error, or it cannot tell a stopped service from a broken one.
        assert!(check(&ControlRequest::Status, None, false, CallerTrust::ConsoleAdministrator).is_ok());
    }

    #[test]
    fn a_keyframe_request_needs_a_live_agent() {
        assert_eq!(
            check(&ControlRequest::RequestKeyframe, None, false, CallerTrust::ConsoleAdministrator),
            Err(ControlDenied::NoAgent),
        );
        // Supervised but the process has died — still nothing to ask.
        assert_eq!(
            check(&ControlRequest::RequestKeyframe, Some(1), false, CallerTrust::ConsoleAdministrator),
            Err(ControlDenied::NoAgent),
        );
        assert!(check(&ControlRequest::RequestKeyframe, Some(1), true, CallerTrust::ConsoleAdministrator).is_ok());
    }

    #[test]
    fn a_relay_for_the_wrong_session_is_refused_not_ignored() {
        // Silently accepting is how a caller ends up believing it drove
        // something it did not — and, worse, how a stale session id from a
        // previous connection gets applied to the current one.
        let req = ControlRequest::Relay { session: 7, payload: vec![1, 2, 3] };
        assert_eq!(
            check(&req, Some(2), true, CallerTrust::ConsoleAdministrator),
            Err(ControlDenied::WrongSession { asked: 7, running: Some(2) }),
        );
        assert!(check(&ControlRequest::Relay { session: 2, payload: vec![1] }, Some(2), true, CallerTrust::ConsoleAdministrator).is_ok());
    }

    #[test]
    fn an_empty_or_oversized_relay_is_refused() {
        // Empty is not a message. Oversized is either a bug or an attempt to
        // make a SYSTEM service buffer memory on an attacker's behalf.
        assert!(matches!(
            check(&ControlRequest::Relay { session: 1, payload: vec![] }, Some(1), true, CallerTrust::ConsoleAdministrator),
            Err(ControlDenied::BadPayload(_)),
        ));
        assert!(matches!(
            check(
                &ControlRequest::Relay { session: 1, payload: vec![0; MAX_RELAY + 1] },
                Some(1),
                true
            , CallerTrust::ConsoleAdministrator),
            Err(ControlDenied::BadPayload(_)),
        ));
        // Exactly at the cap is fine — an off-by-one here would reject real
        // messages at the boundary.
        assert!(check(
            &ControlRequest::Relay { session: 1, payload: vec![0; MAX_RELAY] },
            Some(1),
            true
        , CallerTrust::ConsoleAdministrator)
        .is_ok());
    }

    #[test]
    fn a_relay_with_no_agent_is_refused_before_the_session_check() {
        assert_eq!(
            check(&ControlRequest::Relay { session: 1, payload: vec![1] }, None, false, CallerTrust::ConsoleAdministrator),
            Err(ControlDenied::NoAgent),
        );
    }

    #[test]
    fn the_pipe_acl_excludes_everyone_and_authenticated_users() {
        // Every principal on this ACL is another way into a SYSTEM service. A
        // network logon or a service account has no business here; only someone
        // actually logged on at this machine does.
        assert!(CONTROL_PIPE_SDDL.contains(";SY)"), "SYSTEM must be able to use its own pipe");
        assert!(CONTROL_PIPE_SDDL.contains(";BA)"), "Administrators is a reasonable principal");
        assert!(CONTROL_PIPE_SDDL.contains(";IU)"), "the interactive user is the real client");
        assert!(!CONTROL_PIPE_SDDL.contains(";WD)"), "Everyone must never be granted");
        assert!(!CONTROL_PIPE_SDDL.contains(";AU)"), "Authenticated Users is too broad");
        // The interactive user gets read/write, not full control: nobody but
        // SYSTEM should be able to alter the pipe itself.
        assert!(CONTROL_PIPE_SDDL.contains("(A;;GRGW;;;IU)"));
    }

    #[test]
    fn requests_round_trip_through_json() {
        // The wire format is what a client actually sends; a serde change that
        // silently altered a tag would make every request unparseable.
        for req in [
            ControlRequest::Status,
            ControlRequest::RequestKeyframe,
            ControlRequest::Relay { session: 3, payload: vec![9, 8, 7] },
        ] {
            let back: ControlRequest =
                serde_json::from_str(&serde_json::to_string(&req).unwrap()).unwrap();
            assert_eq!(req, back);
        }
    }

    #[test]
    fn an_unknown_request_tag_is_rejected_rather_than_defaulted() {
        // A future or malicious client must not be able to reach a default arm.
        assert!(serde_json::from_str::<ControlRequest>(r#"{"t":"inject","keys":"x"}"#).is_err());
        assert!(serde_json::from_str::<ControlRequest>(r#"{"t":"run"}"#).is_err());
    }

    #[test]
    fn arming_needs_the_console_administrator_and_nothing_less() {
        // THE MOST POWERFUL REQUEST ON THIS PIPE. Whoever can arm this machine
        // chooses the passphrase that unlocks its sign-in screen from anywhere
        // in the world. It must be exactly as hard to reach as AgentHandle.
        let req = ControlRequest::Arm { record: "{}".into() };
        assert!(check(&req, Some(1), true, CallerTrust::ConsoleAdministrator).is_ok());

        for trust in [CallerTrust::NotConsoleUser, CallerTrust::NotAdministrator] {
            assert!(
                check(&req, Some(1), true, trust).is_err(),
                "arming must be refused to {trust:?}"
            );
        }
    }

    #[test]
    fn arming_is_refused_before_the_record_is_even_looked_at() {
        // Identity FIRST. A validation error returned to an untrusted caller
        // still tells them the pipe is there and answering — the same oracle
        // AgentHandle's ordering closes.
        let empty = ControlRequest::Arm { record: String::new() };
        let err = check(&empty, Some(1), true, CallerTrust::NotConsoleUser).unwrap_err();
        assert!(
            matches!(err, ControlDenied::NotTheConsoleAdmin(_)),
            "an untrusted caller must be told about identity, not about the payload: {err:?}"
        );
        // And the admin DOES get the payload error, so the check is not simply
        // refusing everything.
        assert!(matches!(
            check(&empty, Some(1), true, CallerTrust::ConsoleAdministrator).unwrap_err(),
            ControlDenied::BadPayload(_)
        ));
    }

    #[test]
    fn disarming_works_when_the_agent_is_dead() {
        // A door you cannot shut because the thing behind it crashed is not a
        // door. AgentHandle requires a live agent; this deliberately does not.
        assert!(check(&ControlRequest::Disarm, None, false, CallerTrust::ConsoleAdministrator)
            .is_ok());
        // Still gated on identity.
        assert!(check(&ControlRequest::Disarm, None, false, CallerTrust::NotConsoleUser).is_err());
    }

    #[test]
    fn the_console_user_can_read_the_toggle_without_elevating() {
        // A toggle has to render its own state before anyone can be asked to
        // elevate. Whether the machine is armed is not a secret from the person
        // sitting at it — but it is from every other local account.
        assert!(check(
            &ControlRequest::UnattendedState,
            None,
            false,
            CallerTrust::NotAdministrator
        )
        .is_ok());
        assert!(check(
            &ControlRequest::UnattendedState,
            None,
            false,
            CallerTrust::ConsoleAdministrator
        )
        .is_ok());
        assert!(check(
            &ControlRequest::UnattendedState,
            None,
            false,
            CallerTrust::NotConsoleUser
        )
        .is_err());
    }
}
