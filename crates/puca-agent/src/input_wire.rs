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

/// What the agent seals and sends back on the channel to say "I will serve
/// this". The controller keeps using the RELAY until it opens under the
/// session key — see session.ts's `inputProved`.
///
/// A CONSTANT, and sealed rather than bare, because this frame's only job is
/// to move a controller OFF a working transport. Anything that could write on
/// the channel without the key could otherwise strand input on a dead one.
pub const HELLO_PLAINTEXT: &str = r#"{"hello":1}"#;

/// The agent's hello, as it goes on the wire. `sealed` is
/// `control_key::seal(key, HELLO_PLAINTEXT)`.
#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct InputHello {
    pub sid: String,
    pub hello: String,
    /// WHICH KEY OPENS `hello` — and therefore which key the controller must
    /// seal its frames with.
    ///
    /// Absent means the SESSION key: what a sealed session uses, and what
    /// every agent built before this field existed sent. `2`
    /// (`HELLO_KEY_INPUT_SUBKEY`) means the input-only subkey the host app
    /// derived and handed down — see `InputAuth`.
    ///
    /// A controller that does not understand the value it is given simply
    /// fails to open the hello and stays on the relay, which is the safe
    /// state. So this field can strand nobody: the worst it can do is leave
    /// input exactly where it already was.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub v: Option<u32>,
}

/// `InputHello::v` for a hello sealed under the app-derived input subkey.
pub const HELLO_KEY_INPUT_SUBKEY: u32 = 2;

/// R4 FOR AN ATTENDED SESSION: what the host APP hands down so this agent can
/// serve the input channel of a session it did not open itself.
///
/// WHY IT HAD TO EXIST. The agent only ever held a key for a session it opened
/// (`OpenSession` — the service's lock-screen path), so `StartStream` built an
/// `InputChannel` only for those. An ordinary session — someone signed in, app
/// running — derives its key in the app, so the agent had nothing to seal a
/// hello with, sent none, and the controller correctly kept input on the
/// relay: controller → server → app → pipe → agent. Measured on the author's
/// own machine on 2026-09-08, from `agent.log`: fifteen consecutive sessions
/// over a fortnight, every one of them logging the refusal, not one armed —
/// while the VIDEO for those same sessions went straight across the LAN. The
/// pointer was taking an internet round trip to a machine two metres away.
///
/// `key` IS NOT THE SESSION KEY. It is HKDF-SHA256 of it under
/// `sovereign-device-input-v1`, derived identically by the controller, so this
/// process can open input frames and nothing else — not signalling, not the
/// clipboard. `control_key.rs` argues that exactly one process should hold a
/// session key; this keeps that true while still letting the agent prove it
/// will serve.
///
/// And it grants this process no capability it did not already have: on this
/// path the app ALREADY opens every event and hands it here over the pipe for
/// `SendInput`. What changes is the route, not who can type.
///
/// `granted` and `ua_ok` default to FALSE. An app that predates them has not
/// said yes, and silence is not consent on an authorisation question.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct InputAuth {
    /// base64, 32 bytes.
    pub key: String,
    /// The app verified a grant that includes control for this session — the
    /// same question `InputArm` answers for a sealed one.
    #[serde(default)]
    pub granted: bool,
    /// The app's unattended-access gate is satisfied (not required, or already
    /// proved).
    #[serde(default)]
    pub ua_ok: bool,
}

/// Where an `InputChannel`'s key came from.
///
/// Carried rather than inferred because it decides what the hello advertises,
/// and a hello that names the wrong key is a controller sealing frames this
/// end cannot open — input silently dead, which is the exact failure mode this
/// whole module was written to close.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputKeySource {
    /// A session this agent opened itself: the key IS the session key.
    SealedSession,
    /// An attended session: the host app derived an input-only subkey.
    AppSubkey,
}

/// The hello this stream should write when the controller opens the channel,
/// or `None` when it cannot serve and must say nothing.
///
/// EXTRACTED FROM THE STREAM LOOP so it can be tested at all. Everything about
/// the hello was covered — which key it names, what it serialises to — except
/// the one place that actually builds and sends one, which lives inside a live
/// str0m event loop and is reachable only by a real peer connection. A pure
/// function reached by the loop is a function a test can reach too.
///
/// `seal` is passed in for the same reason `accept_frame` takes its opener:
/// the rules stay testable without the crypto, and this module stays free of
/// the key type.
pub fn hello_for<F>(ch: Option<&InputChannel>, seal: F) -> Option<InputHello>
where
    F: FnOnce(&[u8; 32], &str) -> Option<String>,
{
    // `serves()` and nothing else decides. A hello that promised more than
    // `accept_frame` grants is the failure this whole module exists to close:
    // a controller off the relay and onto a channel that drops everything.
    let ch = ch.filter(|c| c.serves())?;
    let sealed = seal(&ch.key, HELLO_PLAINTEXT)?;
    Some(InputHello {
        sid: ch.session_id.clone(),
        hello: sealed,
        // Read off the channel, never decided here: the hello must name the
        // key this end is actually holding.
        v: ch.hello_version(),
    })
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
    /// Had this session proved unattended access when the stream started?
    ///
    /// `InjectSealed` checks `ua_ok` on every frame and this path must too,
    /// or the module's own promise ("independently of the flavour gate and
    /// of ua_ok, both of which still apply") is false — which it was until
    /// review caught it, with `InputReject::NotProved` defined, described,
    /// iterated in a test, and UNREACHABLE. A snapshot is sound because
    /// nothing ever sets `ua_ok` back to false; if that changes, this must
    /// become shared state, and the test below is what will notice.
    pub ua_ok: bool,
    /// Does this agent's FLAVOUR allow input at all? StartStream gates on
    /// Capture, not Input, so a future flavour with capture-but-not-input
    /// would otherwise reach this path — the exact hole the exhaustive
    /// capability match exists to prevent.
    pub flavour_allows_input: bool,
    /// Which key `key` is, so the hello can say so. See `InputKeySource`.
    pub key_source: InputKeySource,
    /// Highest `s` accepted on THIS transport — its own namespace, separate
    /// from the relayed path's (`SealedSession::recv_seq`). The controller
    /// numbers them independently.
    pub dc_recv_seq: std::sync::atomic::AtomicI64,
}

impl InputChannel {
    /// Will this channel actually serve frames — every AUTHORISATION gate
    /// satisfied, so the only remaining ways to refuse are per-frame (a bad
    /// seal, a stale sequence)?
    ///
    /// THE HELLO ASSERTS EXACTLY THIS, and that is why it is a method rather
    /// than three checks copied into the sender. A hello that promised more
    /// than `accept_frame` grants would put the controller back in the hole
    /// this whole mechanism exists to close: off the relay, onto a channel
    /// that silently drops everything. The test below pins the two together,
    /// so adding a gate to `accept_frame` without adding it here fails.
    pub fn serves(&self) -> bool {
        self.flavour_allows_input && self.arm.granted && self.ua_ok
    }

    /// What the hello must say about `key`.
    ///
    /// Derived from the source rather than passed in beside it, so the two
    /// cannot drift: there is one place that decides, and a test below pins
    /// both arms of it.
    pub fn hello_version(&self) -> Option<u32> {
        match self.key_source {
            InputKeySource::SealedSession => None,
            InputKeySource::AppSubkey => Some(HELLO_KEY_INPUT_SUBKEY),
        }
    }

    pub fn new(
        session_id: String,
        key: [u8; 32],
        arm: InputArm,
        ua_ok: bool,
        flavour_allows_input: bool,
        key_source: InputKeySource,
    ) -> Self {
        Self {
            session_id,
            key,
            arm,
            ua_ok,
            flavour_allows_input,
            key_source,
            dc_recv_seq: std::sync::atomic::AtomicI64::new(-1),
        }
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
    // refused" and "refused" is itself a signal. All three gates sit on this
    // side of the line — the grant, the flavour, and the passphrase — which
    // is what makes this path's authorisation equal to InjectSealed's.
    if !ch.flavour_allows_input {
        return Err(InputReject::NotGranted);
    }
    if !ch.arm.granted {
        return Err(InputReject::NotGranted);
    }
    if !ch.ua_ok {
        return Err(InputReject::NotProved);
    }
    // Anything added above this line must also be in `serves()`, or the
    // controller is told this channel works and then loses every event.
    debug_assert!(ch.serves(), "serves() and accept_frame's gates have drifted");
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
        InputChannel::new(
            "s1".into(), [7u8; 32],
            if granted { InputArm::allowed() } else { InputArm::refused() },
            true, true, InputKeySource::SealedSession,
        )
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
    fn an_unproved_session_and_a_flavour_without_input_are_both_refused_undecrypted() {
        let f = InputFrame { sid: "s1".into(), payload: "x".into() };
        // Passphrase not proved: the same gate InjectSealed applies, which
        // this path silently lacked until review — NotProved was defined,
        // described, and unreachable.
        let unproved = InputChannel::new(
            "s1".into(), [7u8; 32], InputArm::allowed(), false, true, InputKeySource::SealedSession,
        );
        let mut opened = false;
        assert_eq!(
            accept_frame(&unproved, &f, |_k, _p| { opened = true; Some("{}".into()) }),
            Err(InputReject::NotProved)
        );
        assert!(!opened, "authorisation must come BEFORE decryption");
        // A flavour that may capture but not inject (StartStream gates on
        // Capture, so such a session CAN reach this path).
        let no_input = InputChannel::new(
            "s1".into(), [7u8; 32], InputArm::allowed(), true, false, InputKeySource::SealedSession,
        );
        assert_eq!(
            accept_frame(&no_input, &f, |_k, _p| Some("{}".into())),
            Err(InputReject::NotGranted)
        );
        // POSITIVE CONTROL: all three satisfied and the frame lands.
        let ok = arm(true);
        assert!(accept_frame(&ok, &f, opens_to(r#"{"s":1,"e":{"t":"down","button":0}}"#)).is_ok());
    }

    #[test]
    fn serves_and_accept_frame_agree_on_every_combination() {
        // THE DRIFT PIN. `serves()` is what makes the agent send a hello, and
        // the hello is what takes the controller OFF the relay. If it ever
        // says yes where `accept_frame` says no on authorisation, input goes
        // to a channel that drops it and the session looks dead — the exact
        // 0.8.121 field failure this pair exists to prevent.
        let f = InputFrame { sid: "s1".into(), payload: "x".into() };
        for flavour in [false, true] {
            for granted in [false, true] {
                for ua in [false, true] {
                    let ch = InputChannel::new(
                        "s1".into(),
                        [7u8; 32],
                        if granted { InputArm::allowed() } else { InputArm::refused() },
                        ua,
                        flavour,
                        InputKeySource::SealedSession,
                    );
                    let accepted = accept_frame(
                        &ch,
                        &f,
                        opens_to(r#"{"s":1,"e":{"t":"down","button":0}}"#),
                    )
                    .is_ok();
                    assert_eq!(
                        ch.serves(),
                        accepted,
                        "serves()={} but accept_frame accepted={} for                          flavour={flavour} granted={granted} ua_ok={ua}",
                        ch.serves(),
                        accepted
                    );
                }
            }
        }
    }

    #[test]
    fn the_hello_says_what_the_controller_is_looking_for() {
        // A second wire contract compiled twice, and it fails as silently as
        // the label does: a controller that cannot recognise the hello simply
        // stays on the relay for ever, with input still working, which is why
        // nothing would ever report it.
        let client = include_str!("../../../frontend/src/api/devices/session.ts");
        assert!(
            client.len() > 100_000,
            "that is not the real session.ts ({} bytes) — this test is checking nothing",
            client.len()
        );
        // The agent seals exactly this; the controller opens it and checks the
        // `hello` member is 1.
        assert_eq!(HELLO_PLAINTEXT, r#"{"hello":1}"#);
        assert!(
            client.contains("hello?: unknown }).hello === 1"),
            "session.ts no longer recognises the agent's input hello; the              controller would silently stay on the relay for ever"
        );
        // And the envelope field names it reads.
        assert!(client.contains("sid?: unknown; hello?: unknown"));
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

    #[test]
    fn the_hello_names_the_key_the_channel_is_actually_holding() {
        // THE DRIFT THAT WOULD KILL INPUT SILENTLY. The controller seals its
        // frames with whatever key this field names. Name the wrong one and
        // every frame arrives unopenable — the channel looks alive, `serves()`
        // is true, and nothing lands. So the mapping is derived from the
        // source in one place and asserted in both directions here.
        let sealed = InputChannel::new(
            "s1".into(), [1u8; 32], InputArm::allowed(), true, true,
            InputKeySource::SealedSession,
        );
        assert_eq!(sealed.hello_version(), None, "a sealed session uses the session key");

        let attended = InputChannel::new(
            "s1".into(), [2u8; 32], InputArm::allowed(), true, true,
            InputKeySource::AppSubkey,
        );
        assert_eq!(attended.hello_version(), Some(HELLO_KEY_INPUT_SUBKEY));
        assert_eq!(HELLO_KEY_INPUT_SUBKEY, 2, "the wire value is pinned; controllers switch on it");
    }

    #[test]
    fn a_sealed_hello_stays_byte_identical_to_what_older_controllers_expect() {
        // An agent that ships this field must not change the frame a
        // controller built before the field existed is parsing. `v` is absent
        // for the sealed path and skipped on the wire, so the JSON is exactly
        // what 0.9.x sent.
        let sealed = serde_json::to_string(&InputHello {
            sid: "s1".into(), hello: "AAAA".into(), v: None,
        })
        .unwrap();
        assert_eq!(sealed, r#"{"sid":"s1","hello":"AAAA"}"#);

        let attended = serde_json::to_string(&InputHello {
            sid: "s1".into(), hello: "AAAA".into(), v: Some(HELLO_KEY_INPUT_SUBKEY),
        })
        .unwrap();
        assert_eq!(attended, r#"{"sid":"s1","hello":"AAAA","v":2}"#);

        // And the other direction: a hello from an OLDER agent, with no field
        // at all, reads as the session key rather than failing to parse.
        let old: InputHello = serde_json::from_str(r#"{"sid":"s1","hello":"AAAA"}"#).unwrap();
        assert_eq!(old.v, None);
    }

    #[test]
    fn an_input_auth_that_says_nothing_grants_nothing() {
        // Silence is not consent. An app that sends only the key — an older
        // one, or one with a bug — must not thereby arm input.
        let quiet: InputAuth = serde_json::from_str(r#"{"key":"AAAA"}"#).unwrap();
        assert!(!quiet.granted, "a missing grant must read as refused");
        assert!(!quiet.ua_ok, "a missing passphrase answer must read as unproved");

        // POSITIVE CONTROL: the fields do arrive when they are sent, so the
        // assertions above are about the defaults and not about a parser that
        // ignores the whole object.
        let loud: InputAuth =
            serde_json::from_str(r#"{"key":"AAAA","granted":true,"ua_ok":true}"#).unwrap();
        assert!(loud.granted && loud.ua_ok);
    }


    /// The hello's key selector is one wire contract compiled twice, and it
    /// fails the way everything on this channel fails: silently. An attended
    /// agent naming a key the controller does not switch on leaves input on
    /// the relay for ever, with both ends convinced they did their part.
    #[test]
    fn the_controller_switches_on_the_same_key_selector_this_agent_sends() {
        let client = include_str!("../../../frontend/src/api/devices/session.ts");
        assert!(
            client.len() > 100_000,
            "that is not the real session.ts ({} bytes) — the path is wrong and \
             this test is checking nothing",
            client.len()
        );
        assert!(
            client.contains(&format!(
                "const HELLO_KEY_INPUT_SUBKEY = {HELLO_KEY_INPUT_SUBKEY};"
            )),
            "session.ts no longer declares HELLO_KEY_INPUT_SUBKEY = {HELLO_KEY_INPUT_SUBKEY}; \
             an attended host would name a key the controller never tries"
        );
        // POSITIVE CONTROL: the controller really does derive the subkey this
        // agent is handed, rather than merely holding the number.
        assert!(
            client.contains("deriveDeviceInputKey"),
            "session.ts does not derive the input subkey at all — the search is \
             broken, or the controller half was reverted"
        );
    }


    #[test]
    fn the_hello_a_stream_sends_names_the_key_it_holds_and_seals_with_it() {
        // The send site itself, not just the pieces it uses. Everything below
        // was previously reachable only through a live str0m session.
        let mut sealed_with: Option<[u8; 32]> = None;
        let attended = InputChannel::new(
            "s7".into(), [0xAB; 32], InputArm::allowed(), true, true, InputKeySource::AppSubkey,
        );
        let hello = hello_for(Some(&attended), |k, p| {
            sealed_with = Some(*k);
            assert_eq!(p, HELLO_PLAINTEXT, "the hello's plaintext is a constant, pinned by the controller");
            Some("sealed".to_string())
        })
        .expect("a serving channel must send a hello");
        assert_eq!(hello.sid, "s7");
        assert_eq!(hello.v, Some(HELLO_KEY_INPUT_SUBKEY));
        assert_eq!(
            sealed_with,
            Some([0xAB; 32]),
            "sealed under the channel's own key — under anything else the controller cannot open it",
        );

        // A sealed session's hello still names no key, so an older controller
        // reads it exactly as it always did.
        let sealed_session = InputChannel::new(
            "s7".into(), [0x11; 32], InputArm::allowed(), true, true, InputKeySource::SealedSession,
        );
        assert_eq!(
            hello_for(Some(&sealed_session), |_k, _p| Some("sealed".into())).unwrap().v,
            None,
        );
    }

    #[test]
    fn a_stream_that_cannot_serve_says_nothing_at_all() {
        // Silence is what keeps the controller on the relay. Anything else —
        // an empty hello, an unsealed marker — is a working transport
        // abandoned for a dead one.
        let f = |_k: &[u8; 32], _p: &str| Some("sealed".to_string());
        assert!(hello_for(None, f).is_none(), "no channel, no hello");
        for (granted, ua_ok, flavour) in [(false, true, true), (true, false, true), (true, true, false)] {
            let ch = InputChannel::new(
                "s7".into(),
                [7u8; 32],
                if granted { InputArm::allowed() } else { InputArm::refused() },
                ua_ok,
                flavour,
                InputKeySource::AppSubkey,
            );
            assert!(
                hello_for(Some(&ch), f).is_none(),
                "granted={granted} ua_ok={ua_ok} flavour={flavour} must send no hello",
            );
        }
        // A seal that fails sends nothing either, rather than a hello with an
        // empty payload the controller would try to open.
        let ok = InputChannel::new(
            "s7".into(), [7u8; 32], InputArm::allowed(), true, true, InputKeySource::AppSubkey,
        );
        assert!(hello_for(Some(&ok), |_k, _p| None).is_none());
        // POSITIVE CONTROL: the same channel with a seal that works DOES.
        assert!(hello_for(Some(&ok), f).is_some());
    }

}
