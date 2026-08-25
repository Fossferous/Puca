//! The `input` data channel: sealed control frames straight from the
//! CONTROLLER to this agent, skipping the app entirely (R4).
//!
//! WHY. Today a keystroke on a My Devices session travels controller → WS
//! relay → host app (webview) → Tauri IPC → named pipe → agent → SendInput.
//! Five hops, two of them process boundaries inside the host machine, and
//! the pipe is the one that wedged for 46 seconds in the field (see
//! agent_ipc.rs's deadline work). The agent already owns the peer
//! connection for these sessions, so the controller can hand it input
//! directly: one hop, no webview, no IPC, no pipe.
//!
//! UNGATED MODULE, deliberately — the same rule caret_wire.rs states: plain
//! data with no Win32 in it must not live inside `#[cfg(windows)]`, or the
//! Linux build breaks (E0433) and CI's frontend job goes permanently red.
//!
//! THE FRAMES ARE THE PIPE'S FRAMES. Payload bytes are exactly what
//! `InjectSealed` carries — `control_key::open` over `{s, e}` with a
//! strictly increasing `s` — so this is a transport change and nothing else.
//! What it is NOT allowed to be is an authorisation change: see
//! `InputArm` below.

use serde::{Deserialize, Serialize};

/// The data channel the CONTROLLER opens for this.
///
/// Both ends must spell it identically and a mismatch fails SILENTLY —
/// str0m opens the stream whatever the label is, so the controller's
/// `onopen` fires either way and the only symptom is input that never
/// arrives (and quietly keeps working over the relay, which is worse to
/// diagnose than a break). Pinned against `session.ts` by the test below,
/// the same way `caret` is.
pub const CHANNEL_NAME: &str = "input";

/// Whether THIS session may inject at all.
///
/// THE SECURITY QUESTION THIS FEATURE RAISED, answered in the type. Before
/// R4 the view-only rule lived entirely in the host APP: a share without
/// `control` established a perfectly ordinary sealed session (it needs one
/// for signalling and media), and the app simply never called
/// `injectEvent` for it. The agent has never known the difference — its
/// gates are the flavour capability and `ua_ok`, neither of which says
/// anything about the grant.
///
/// A direct controller→agent channel bypasses the app, so shipping R4
/// without this would let a VIEW-ONLY peer seal input frames and have them
/// injected: a privilege escalation created by a latency optimisation. The
/// app now states the grant's control capability when it opens the session,
/// and the agent refuses input on a session that was not granted it —
/// independently of the flavour gate and of `ua_ok`, both of which still
/// apply.
///
/// Defaults to REFUSED on the wire (`#[serde(default)]` = false): an app
/// that predates this field is one that has not told us the session may
/// inject, and "no answer" must never mean "yes" on an authorisation
/// question.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct InputArm {
    /// The app verified a grant that includes control for this session.
    pub granted: bool,
}

impl InputArm {
    pub fn refused() -> Self {
        Self { granted: false }
    }
    pub fn allowed() -> Self {
        Self { granted: true }
    }
}

/// Why an input frame on the channel was not injected. A value, not a
/// string, so the tests can assert on it and the ordinary path allocates
/// nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputReject {
    /// No sealed session with that id (or it ended).
    NoSession,
    /// The session exists but was never granted control (view-only share).
    NotGranted,
    /// The session has not answered the unattended-access challenge.
    NotProved,
    /// The frame did not open under the session key, or was malformed.
    Unopenable,
    /// Replay or reorder: `s` did not strictly increase.
    StaleSequence,
    /// Opened and fresh, but not a control event this agent accepts.
    NotAnEvent,
}

impl InputReject {
    pub fn describe(self) -> &'static str {
        match self {
            Self::NoSession => "no sealed session with that id",
            Self::NotGranted => "this session was not granted control",
            Self::NotProved => "this session has not proved unattended access",
            Self::Unopenable => "that frame could not be opened",
            Self::StaleSequence => "stale or replayed input frame",
            Self::NotAnEvent => "not a control event",
        }
    }
}

/// The frame the controller writes on the channel.
///
/// `sid` names WHICH sealed session's key opens `payload`. The channel
/// belongs to one peer connection and therefore one session in practice,
/// but the id is carried anyway: an agent serving several sessions must
/// never guess which key to try, and trying them all would be an oracle.
#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct InputFrame {
    pub sid: String,
    /// base64 of the same sealed bytes `InjectSealed` carries.
    pub payload: String,
}

/// Parse one channel message. `None` for anything that is not an input
/// frame — the channel accepts exactly one shape, like `caret` does.
pub fn parse_frame(bytes: &[u8]) -> Option<InputFrame> {
    serde_json::from_slice::<InputFrame>(bytes).ok()
}

/// What the STREAM THREAD needs to serve the channel, without reaching into
/// the pipe thread's session map.
///
/// The keys live on `Agent` (pipe thread) and the data channel lives on the
/// stream thread; handing the stream a small shared handle is what lets the
/// frames be opened where they arrive instead of hopping threads. Created at
/// StartStream from the already-open sealed session, so a stream can never
/// exist with a key the session did not authorise.
pub struct InputChannel {
    pub session_id: String,
    pub key: [u8; 32],
    pub arm: InputArm,
    /// Highest `s` accepted on THIS transport — its own namespace, separate
    /// from the relayed path's (`SealedSession::recv_seq`). The controller
    /// numbers them independently.
    pub dc_recv_seq: std::sync::atomic::AtomicI64,
}

impl InputChannel {
    pub fn new(session_id: String, key: [u8; 32], arm: InputArm) -> Self {
        Self { session_id, key, arm, dc_recv_seq: std::sync::atomic::AtomicI64::new(-1) }
    }
}

/// The whole decision for one frame, OS-free so every refusal is testable:
/// right session, granted, opened, fresh, an event. Returns the event JSON
/// for the caller to dispatch, or why not.
///
/// `open` is passed in (rather than called here) so the test can drive the
/// rules without the crypto, and so this module stays free of the key type.
pub fn accept_frame<F>(
    ch: &InputChannel,
    frame: &InputFrame,
    open: F,
) -> Result<String, InputReject>
where
    F: FnOnce(&[u8; 32], &str) -> Option<String>,
{
    if frame.sid != ch.session_id {
        return Err(InputReject::NoSession);
    }
    // AUTHORISATION BEFORE DECRYPTION, the same order InjectSealed states:
    // a peer who may not inject must not get the agent to decrypt
    // attacker-chosen bytes, and the timing difference between "opened then
    // refused" and "refused" is itself a signal.
    if !ch.arm.granted {
        return Err(InputReject::NotGranted);
    }
    let Some(plain) = open(&ch.key, &frame.payload) else {
        return Err(InputReject::Unopenable);
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&plain) else {
        return Err(InputReject::Unopenable);
    };
    let Some(s) = v.get("s").and_then(|x| x.as_i64()) else {
        return Err(InputReject::Unopenable);
    };
    // Strictly increasing, per transport — what makes a captured frame
    // unreplayable.
    let prev = ch.dc_recv_seq.load(std::sync::atomic::Ordering::SeqCst);
    if s <= prev {
        return Err(InputReject::StaleSequence);
    }
    let Some(e) = v.get("e") else {
        return Err(InputReject::NotAnEvent);
    };
    ch.dc_recv_seq.store(s, std::sync::atomic::Ordering::SeqCst);
    Ok(e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The label is one wire contract compiled twice. A rename on either
    /// side fails SILENTLY (str0m opens any label), so the only guard is
    /// reading the other end's source — the caret_wire.rs pattern.
    #[test]
    fn the_controller_opens_the_channel_this_agent_serves() {
        let client = include_str!("../../../frontend/src/api/devices/session.ts");
        assert!(
            client.len() > 100_000,
            "that is not the real session.ts ({} bytes) — the path is wrong and \
             this test is checking nothing",
            client.len()
        );
        assert!(
            client.contains(&format!("createDataChannel('{CHANNEL_NAME}'")),
            "session.ts no longer opens a '{CHANNEL_NAME}' data channel; the two \
             ends of the P2P input contract have drifted"
        );
        // POSITIVE CONTROL for the search itself: the caret channel, whose
        // own pin lives in caret_wire.rs, must also be findable this way.
        assert!(
            client.contains("createDataChannel('caret'"),
            "the search cannot see a channel it should — this test is broken, \
             not the contract"
        );
    }

    #[test]
    fn an_unstated_grant_is_a_refusal() {
        // The default MUST be refused: an app that predates the capability
        // has not said this session may inject, and silence is not consent.
        assert_eq!(InputArm::default(), InputArm::refused());
        assert!(!InputArm::default().granted);
        assert!(InputArm::allowed().granted);
    }

    #[test]
    fn the_frame_parses_from_what_the_controller_writes() {
        let bytes = br#"{"sid":"s1","payload":"AAAA"}"#;
        let f = parse_frame(bytes).expect("the controller's frame must parse");
        assert_eq!(f.sid, "s1");
        assert_eq!(f.payload, "AAAA");
        // Anything else is not an input frame — the channel takes one shape.
        assert!(parse_frame(b"{}").is_none());
        assert!(parse_frame(br#"{"sid":"s1"}"#).is_none());
        assert!(parse_frame(b"not json").is_none());
        assert!(parse_frame(b"").is_none());
    }

    fn arm(granted: bool) -> InputChannel {
        InputChannel::new("s1".into(), [7u8; 32], if granted { InputArm::allowed() } else { InputArm::refused() })
    }
    /// Stand-in opener: echoes the payload as if it decrypted.
    fn opens_to(json: &'static str) -> impl FnOnce(&[u8; 32], &str) -> Option<String> {
        move |_k, _p| Some(json.to_string())
    }

    #[test]
    fn a_view_only_session_is_refused_before_anything_is_decrypted() {
        let ch = arm(false);
        let f = InputFrame { sid: "s1".into(), payload: "x".into() };
        let mut opened = false;
        let r = accept_frame(&ch, &f, |_k, _p| { opened = true; Some("{}".into()) });
        assert_eq!(r, Err(InputReject::NotGranted));
        assert!(!opened, "authorisation must come BEFORE decryption");
        // POSITIVE CONTROL: the same frame on a granted session gets that far.
        let ok = arm(true);
        assert!(accept_frame(&ok, &f, opens_to(r#"{"s":1,"e":{"t":"down","button":0}}"#)).is_ok());
    }

    #[test]
    fn a_frame_for_another_session_never_tries_this_key() {
        let ch = arm(true);
        let f = InputFrame { sid: "other".into(), payload: "x".into() };
        let mut opened = false;
        let r = accept_frame(&ch, &f, |_k, _p| { opened = true; Some("{}".into()) });
        assert_eq!(r, Err(InputReject::NoSession));
        assert!(!opened, "trying every key would be an oracle");
    }

    #[test]
    fn the_sequence_must_strictly_increase_on_this_transport() {
        let ch = arm(true);
        let f = InputFrame { sid: "s1".into(), payload: "x".into() };
        assert!(accept_frame(&ch, &f, opens_to(r#"{"s":5,"e":{"t":"down","button":0}}"#)).is_ok());
        // Replay of the same number, and anything behind it, is refused.
        assert_eq!(
            accept_frame(&ch, &f, opens_to(r#"{"s":5,"e":{"t":"down","button":0}}"#)),
            Err(InputReject::StaleSequence)
        );
        assert_eq!(
            accept_frame(&ch, &f, opens_to(r#"{"s":4,"e":{"t":"down","button":0}}"#)),
            Err(InputReject::StaleSequence)
        );
        // POSITIVE CONTROL: forward still lands, and a REFUSED frame must not
        // have advanced the counter (6 follows 5, not 5-then-4-then-6-only).
        assert!(accept_frame(&ch, &f, opens_to(r#"{"s":6,"e":{"t":"up","button":0}}"#)).is_ok());
    }

    #[test]
    fn unopenable_and_shapeless_frames_are_refused_without_injecting() {
        let ch = arm(true);
        let f = InputFrame { sid: "s1".into(), payload: "x".into() };
        assert_eq!(accept_frame(&ch, &f, |_k, _p| None), Err(InputReject::Unopenable));
        assert_eq!(accept_frame(&ch, &f, opens_to("not json")), Err(InputReject::Unopenable));
        assert_eq!(accept_frame(&ch, &f, opens_to(r#"{"e":{}}"#)), Err(InputReject::Unopenable));
        assert_eq!(accept_frame(&ch, &f, opens_to(r#"{"s":1}"#)), Err(InputReject::NotAnEvent));
    }

    #[test]
    fn every_rejection_says_something_a_log_reader_can_act_on() {
        for r in [
            InputReject::NoSession, InputReject::NotGranted, InputReject::NotProved,
            InputReject::Unopenable, InputReject::StaleSequence, InputReject::NotAnEvent,
        ] {
            assert!(!r.describe().is_empty());
        }
        // The two that mean "authorisation", specifically, must read
        // differently — a log that cannot tell a view-only refusal from an
        // unproved passphrase sends the reader to the wrong place.
        assert_ne!(
            InputReject::NotGranted.describe(),
            InputReject::NotProved.describe()
        );
    }
}
