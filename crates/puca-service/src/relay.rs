//! One sign-in-screen session, relayed between the server and the agent.
//!
//! THE SHAPE, AND WHY IT IS THIS SHAPE. Everything a controller sends after the
//! handshake is sealed under a key this process does not have. The service
//! carries ciphertext to the agent and carries the agent's ciphertext back. It
//! learns four things and no more: that a session exists, whose device asked,
//! whether the agent accepted, and when it ended.
//!
//! WHAT THE SERVICE DOES HOLD is `static_shared` — X25519(this machine's device
//! private key, the peer's device public key) — because it is the process that
//! holds the machine's device key. That is only HALF the derivation. The
//! ephemeral private half is generated inside the agent and never leaves it, so
//! possession of `static_shared` does not let this process open a single frame.
//! Check that property before changing anything here: if the service ever ends
//! up able to derive the session key, the reason the key lives in the agent has
//! been quietly undone.
//!
//! ONE SESSION AT A TIME. The server caps a host device at one
//! (`MAX_SESSIONS_PER_HOST_DEVICE`), but this does not depend on that: a second
//! session would collide inside the agent, which refuses with "that session is
//! already streaming" — a refusal that would arrive after the controller had
//! been told it was accepted.

#![cfg(windows)]

use crate::agent_client::{error_of, sealed_payloads, AgentClient};

/// A live session, from the moment the agent accepts it.
pub struct Session {
    pub id: String,
    pub peer_device: String,
    /// Frames to send back to the controller, sealed by the agent.
    pub outbound: Vec<String>,
}

/// Why a connect request was refused. The text goes to the controller verbatim,
/// so each one has to name the ACTUAL obstacle — "this machine is not armed"
/// and "no agent is running" send someone to different places, and a single
/// generic message sends them to the wrong one.
#[derive(Debug, PartialEq, Eq)]
pub enum Refusal {
    NotArmed,
    NoAgent,
    AlreadyInSession,
    CrossUserShare,
    UnknownPeer,
    BadHandshake,
    Agent(String),
}

impl Refusal {
    pub fn reason(&self) -> String {
        match self {
            Refusal::NotArmed => {
                "this computer is not armed for sign-in-screen access".to_string()
            }
            Refusal::NoAgent => "no agent is running on the sign-in screen".to_string(),
            Refusal::AlreadyInSession => "that computer is already in a session".to_string(),
            Refusal::CrossUserShare => {
                "sign-in-screen access is not available through a device share".to_string()
            }
            Refusal::UnknownPeer => "could not agree a key with that device".to_string(),
            Refusal::BadHandshake => "could not agree a key with that device".to_string(),
            Refusal::Agent(m) => m.clone(),
        }
    }
}

/// Everything checked before a connect is accepted, in order.
///
/// SEPARATED FROM THE I/O so the policy is testable without a pipe, a socket or
/// a Windows session. The order matters and is asserted: refusing for the wrong
/// reason is how someone spends an evening fixing the wrong thing.
pub struct ConnectFacts<'a> {
    pub armed: bool,
    pub agent_alive: bool,
    pub session_in_progress: bool,
    /// `from_user` as the SERVER sends it.
    ///
    /// ABSENT MEANS SAME-ACCOUNT. `src/protocol.rs:490` states it outright —
    /// "absent = same-account, byte-identical to the pre-share wire shape" —
    /// and `src/ws.rs:2439` builds it as `cross_user.then_some(user_id)`, so the
    /// field appears ONLY for a cross-user share and then carries the GRANTEE's
    /// id, never the owner's.
    ///
    /// This was documented and implemented backwards: the code accepted only
    /// `Some(u) if u == my_user`, a shape the server never emits, so every
    /// session was refused as a device share — including the owner reaching
    /// their own machine, which is the entire feature.
    pub from_user: Option<i64>,
    pub my_user: i64,
    /// Did the peer's device row verify against the pinned account key?
    pub peer_verified: bool,
    pub peer_device_pub: Option<&'a str>,
}

pub fn may_accept(f: &ConnectFacts<'_>) -> Result<(), Refusal> {
    // Arming first: it is the one the OWNER controls, and a machine that was
    // never armed should say so rather than reporting a missing agent.
    if !f.armed {
        return Err(Refusal::NotArmed);
    }
    if f.session_in_progress {
        return Err(Refusal::AlreadyInSession);
    }
    if !f.agent_alive {
        return Err(Refusal::NoAgent);
    }
    // A CROSS-USER SHARE IS REFUSED IN v1, deliberately and fail-closed. The
    // service has none of the share-verification chain the app uses
    // (shareForGrantee / shareAuthorises / verifiedSharePeerDevice), cannot
    // verify a grant it never signed, and the walk-up-consent fallback is
    // meaningless with nobody at the machine.
    //
    // ABSENT is the same-account case and the normal one. See ConnectFacts.
    match f.from_user {
        None => {}
        // The server does not emit this for a same-account connect, but if it
        // ever did, the owner's own id is not a share. Accepting it costs
        // nothing and is robust to the field becoming unconditional.
        Some(u) if u == f.my_user => {}
        Some(_) => return Err(Refusal::CrossUserShare),
    }
    if !f.peer_verified || f.peer_device_pub.is_none() {
        return Err(Refusal::UnknownPeer);
    }
    Ok(())
}

/// Ask the agent to open the session, and return the ephemeral it generated.
///
/// The returned string goes straight into `DeviceConnectResponse.eph`. This
/// process never sees the private half.
pub fn open_on_agent(
    agent: &mut AgentClient,
    session_id: &str,
    static_shared: &[u8; 32],
    peer_eph_pub: &str,
    ice_servers: &serde_json::Value,
) -> Result<String, Refusal> {
    let req = serde_json::json!({
        "cmd": "open_session",
        "session_id": session_id,
        "static_shared": base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD, static_shared),
        "peer_eph_pub": peer_eph_pub,
        "ice_servers": ice_servers,
        // R4: this session MAY inject. Safe to assert unconditionally here
        // because `check_connect` above refuses a cross-user share outright
        // (Refusal::CrossUserShare) — every session that reaches this call is
        // the owner's own account, and a view-only grant cannot exist for it.
        // The agent defaults to REFUSED when the field is absent, so a future
        // path that forgets to say this gets no input rather than silent
        // permission.
        "input_granted": true,
    });
    let reply = agent.call(&req).map_err(Refusal::Agent)?;
    if let Some(e) = error_of(&reply) {
        return Err(Refusal::Agent(e));
    }
    reply
        .get("eph_pub")
        .and_then(|x| x.as_str())
        .map(str::to_string)
        .ok_or(Refusal::BadHandshake)
}

/// Ask the agent for the sealed unattended challenge.
pub fn sealed_challenge(agent: &mut AgentClient, session_id: &str) -> Result<Vec<String>, String> {
    let reply = agent.call(&serde_json::json!({
        "cmd": "sealed_challenge",
        "session_id": session_id,
    }))?;
    if let Some(e) = error_of(&reply) {
        return Err(e);
    }
    Ok(sealed_payloads(&reply))
}

/// Hand one sealed signalling frame to the agent; return whatever it wants sent
/// back, still sealed.
pub fn relay_signal(
    agent: &mut AgentClient,
    session_id: &str,
    payload: &str,
) -> Result<Vec<String>, String> {
    let reply = agent.call(&serde_json::json!({
        "cmd": "sealed_signal",
        "session_id": session_id,
        "payload": payload,
    }))?;
    if let Some(e) = error_of(&reply) {
        return Err(e);
    }
    Ok(sealed_payloads(&reply))
}

/// Hand one sealed input frame to the agent.
///
/// Errors are returned but are NOT session-ending at the call site: a refused
/// keystroke is a refused keystroke. Tearing the session down over one would
/// turn a transient into a disconnect in the middle of typing a password.
pub fn relay_input(
    agent: &mut AgentClient,
    session_id: &str,
    payload: &str,
) -> Result<(), String> {
    let reply = agent.call(&serde_json::json!({
        "cmd": "inject_sealed",
        "session_id": session_id,
        "payload": payload,
    }))?;
    match error_of(&reply) {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

/// Stop the agent's stream for a session that has ended.
pub fn close_on_agent(agent: &mut AgentClient, session_id: &str) {
    // Best-effort and deliberately ignoring the result: the session is over
    // either way, and an error here would only be logged. What must NOT happen
    // is skipping it, because the capture stays reserved and the next session
    // fails with "already streaming".
    let _ = agent.call(&serde_json::json!({
        "cmd": "stop_stream",
        "session_id": session_id,
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok_facts() -> ConnectFacts<'static> {
        ConnectFacts {
            armed: true,
            agent_alive: true,
            session_in_progress: false,
            // ABSENT — what the server sends for a same-account connect, which
            // is what this feature is for. Using Some(7) here was the bug: it
            // made the positive control assert a shape the wire never carries,
            // so the inverted check passed.
            from_user: None,
            my_user: 7,
            peer_verified: true,
            peer_device_pub: Some("x25519:AAAA"),
        }
    }

    #[test]
    fn an_ordinary_request_is_accepted() {
        // THE POSITIVE CONTROL. Every refusal below is worthless without it: a
        // gate that refused everything would satisfy them all while making the
        // feature impossible.
        assert_eq!(may_accept(&ok_facts()), Ok(()));
    }

    #[test]
    fn an_unarmed_machine_refuses_and_says_so() {
        // The hard precondition. There is no fallback: the app's unarmed branch
        // asks the person at the keyboard, and a sign-in screen has none.
        let f = ConnectFacts { armed: false, ..ok_facts() };
        assert_eq!(may_accept(&f), Err(Refusal::NotArmed));
        assert!(Refusal::NotArmed.reason().contains("not armed"));
    }

    #[test]
    fn arming_is_reported_before_a_missing_agent() {
        // ORDER, not just outcome. A machine nobody ever armed must be told
        // that, not told its agent is missing — one is a setting the owner
        // changes, the other is a fault they cannot act on.
        let f = ConnectFacts { armed: false, agent_alive: false, ..ok_facts() };
        assert_eq!(may_accept(&f), Err(Refusal::NotArmed));
    }

    #[test]
    fn a_second_session_is_refused_before_reaching_the_agent() {
        // The agent WOULD refuse with "already streaming", but only after this
        // process had already told the controller it was accepted.
        let f = ConnectFacts { session_in_progress: true, ..ok_facts() };
        assert_eq!(may_accept(&f), Err(Refusal::AlreadyInSession));
    }

    #[test]
    fn a_cross_user_share_is_refused_and_a_same_account_connect_is_not() {
        // BOTH HALVES, because this check was shipped inverted and the test that
        // was supposed to cover it asserted the inverse of the wire.
        //
        // PRESENT means a share (ws.rs:2439 `cross_user.then_some(user_id)`,
        // carrying the GRANTEE's id) -> refused in v1.
        let share = ConnectFacts { from_user: Some(8), ..ok_facts() };
        assert_eq!(may_accept(&share), Err(Refusal::CrossUserShare));

        // ABSENT means same-account (protocol.rs:490) -> accepted. This is the
        // owner reaching their own machine, i.e. the whole feature.
        let mine = ConnectFacts { from_user: None, ..ok_facts() };
        assert_eq!(may_accept(&mine), Ok(()));
    }

    #[test]
    fn the_from_user_convention_is_the_one_the_server_actually_uses() {
        // A CROSS-CRATE PIN. The two ends share no type, and reading this
        // backwards cost the entire feature: every session was refused as a
        // device share, including the owner's own. If the server ever starts
        // sending from_user unconditionally, this fails and says so.
        let server = include_str!("../../../src/ws.rs");
        assert!(
            server.contains("from_user: cross_user.then_some(user_id)"),
            "the server no longer omits from_user for a same-account connect — \
             re-read may_accept before changing this test"
        );
        let protocol = include_str!("../../../src/protocol.rs");
        assert!(
            protocol.contains("absent = same-account"),
            "the protocol no longer documents absent as same-account"
        );
    }

    #[test]
    fn an_unverified_peer_is_refused() {
        // The server never verifies auth_sig, so an unverified row is one that
        // could have been substituted by the server to sit in the middle.
        let f = ConnectFacts { peer_verified: false, ..ok_facts() };
        assert_eq!(may_accept(&f), Err(Refusal::UnknownPeer));

        let no_key = ConnectFacts { peer_device_pub: None, ..ok_facts() };
        assert_eq!(may_accept(&no_key), Err(Refusal::UnknownPeer));
    }

    #[test]
    fn every_refusal_names_a_different_obstacle() {
        // A generic "connection refused" sends someone to check their network
        // when the real answer is a toggle they never turned on. These strings
        // reach the controller verbatim.
        let all = [
            Refusal::NotArmed,
            Refusal::NoAgent,
            Refusal::AlreadyInSession,
            Refusal::CrossUserShare,
            Refusal::UnknownPeer,
        ];
        let texts: Vec<String> = all.iter().map(|r| r.reason()).collect();
        for (i, a) in texts.iter().enumerate() {
            assert!(!a.is_empty());
            for b in texts.iter().skip(i + 1) {
                assert_ne!(a, b, "two refusals read the same");
            }
        }
        // The agent's own refusals pass through unchanged: "already streaming"
        // and "no monitor" are the good half of its diagnostics.
        assert_eq!(Refusal::Agent("no monitor".into()).reason(), "no monitor");
    }

    #[test]
    fn the_agent_commands_are_spelled_the_way_the_agent_parses_them() {
        // snake_case, matching Request's `#[serde(tag = "cmd", rename_all =
        // "snake_case")]`. A misspelling here is refused by the agent as an
        // unknown command, which surfaces as a session that connects and then
        // shows nothing.
        // SCANNED WITHOUT THE TEST MODULE. `include_str!` of this file includes
        // the assertions below, so every string searched for is present in the
        // test's own source and the check passes whatever the real code says.
        // Four tests in this change were written that way and could not fail.
        let src = include_str!("relay.rs").split("#[cfg(test)]").next().unwrap();
        for cmd in [
            "\"open_session\"",
            "\"sealed_challenge\"",
            "\"sealed_signal\"",
            "\"inject_sealed\"",
            "\"stop_stream\"",
        ] {
            assert!(src.contains(cmd), "missing command {cmd}");
        }
        // camelCase would be silently unknown to the agent.
        assert!(!src.contains("\"openSession\""));
        assert!(!src.contains("\"sealedSignal\""));
    }
}
