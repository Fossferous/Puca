//! The agent's local control protocol.
//!
//! Newline-delimited JSON over a local pipe. Deliberately small: the agent is
//! not a second client. It never speaks WebSocket to the Puca server, never
//! holds the device key, and never decides whether a session may exist — the
//! desktop app keeps all of that. The agent's entire job is "capture this
//! screen" and "inject this event", both of which the app cannot do itself
//! without a webview and a user gesture.
//!
//! That split is what makes the agent safe to run headless: compromising it
//! yields the ability to drive the local machine, which an attacker at the
//! keyboard already has — not the ability to authorise a remote session.

use serde::{Deserialize, Serialize};

/// Bump when the shape changes. The app refuses an agent it does not
/// understand rather than guessing, because a half-understood agent that
/// accepts a StartSession and silently captures nothing is indistinguishable
/// from a working one.
///
/// 2: `StartStream.data_only` and `SetFileAccess.policy`.
///
/// Bumped rather than relied upon to degrade, because serde IGNORES unknown
/// fields by default and the failure is the mirror of the one above: a v1 agent
/// handed `data_only: true` drops it on the floor and CAPTURES THE SCREEN for a
/// session the user opened to browse files. Silently doing the more invasive
/// thing is the worst available outcome, so the handshake refuses the pair
/// instead. The app and the agent binary ship together, so a mismatch means
/// something is genuinely stale and should say so out loud.
pub const PROTOCOL_VERSION: u32 = 2;

/// Frame rates a stream may be started with or moved to.
///
/// An allowlist rather than a range: these are the values the UI offers, and
/// anything else is a caller bug worth reporting rather than quietly clamping.
pub const ALLOWED_FPS: [u32; 3] = [15, 30, 60];

/// Bitrates, in BITS per second.
///
/// Named and shared because StartStream and UpdateStream both check it, and
/// when the two lists drifted a quality the UI offered ("Ultra") was accepted
/// at connect time and refused on every later change. The UI's kbps values are
/// these divided by 1000 — the single conversion lives in hostAgent.ts.
pub const ALLOWED_BITRATE_BPS: [u32; 4] = [1_000_000, 3_000_000, 6_000_000, 10_000_000];

/// One STUN or TURN server, in the shape `RTCIceServer` uses.
///
/// `urls` is deliberately tolerant: the WebRTC dictionary allows either a
/// single string or an array of them, and the app forwards whatever the server
/// sent it. Accepting only the array would make a perfectly valid config
/// deserialize-fail, and a failed StartStream is indistinguishable to the user
/// from the host-only bug this field exists to fix.
#[derive(Debug, Clone, Deserialize)]
pub struct IceServer {
    #[serde(default)]
    pub urls: Urls,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub credential: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum Urls {
    One(String),
    Many(Vec<String>),
}

impl Default for Urls {
    fn default() -> Self {
        Urls::Many(Vec::new())
    }
}

impl Urls {
    pub fn as_slice(&self) -> Vec<&str> {
        match self {
            Urls::One(s) => vec![s.as_str()],
            Urls::Many(v) => v.iter().map(String::as_str).collect(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum Request {
    /// Handshake. Must be first: every other request is refused until the
    /// per-launch token is presented.
    Hello { token: String, version: u32 },
    /// What this machine can actually do.
    Capabilities,
    /// Available outputs.
    ListMonitors,
    /// Begin capturing. `monitor` is an index into ListMonitors.
    StartCapture { session_id: String, monitor: Option<usize> },
    /// One frame, base64 BGRA. Polled by the caller rather than pushed, so the
    /// pipe cannot outrun a slow consumer.
    ///
    /// FOR BRING-UP AND TESTS ONLY — this is not how frames will ship. Measured
    /// on a 2560x1440 display, one frame is 19.6 MB of base64; at 30fps that is
    /// roughly 440 MB/s through a named pipe, which is absurd. The endgame is
    /// that the AGENT encodes and owns the WebRTC connection (`agent-pc` in
    /// hostBackend.ts) and this pipe carries only control. Keeping the raw path
    /// is still worth it: it is what makes capture verifiable without an
    /// encoder, and it is how the live test proves real pixels arrive.
    NextFrame { session_id: String, timeout_ms: Option<u32> },
    StopCapture { session_id: String },
    /// Begin a real WebRTC stream: capture the monitor, encode it, and answer
    /// the browser's offer. This is the path that actually ships pixels — the
    /// raw NextFrame path above exists so capture is verifiable without one.
    StartStream {
        session_id: String,
        monitor: Option<usize>,
        offer_sdp: String,
        fps: Option<u32>,
        bitrate: Option<u32>,
        /// STUN/TURN servers, forwarded from the app's `fetchIceConfig()`.
        ///
        /// WITHOUT THESE THE AGENT OFFERS HOST CANDIDATES ONLY, which is what
        /// shipped in 0.8.4: the webview host built its peer connection from
        /// `fetchIceConfig()` and the agent path had no way to be told, so
        /// making `agent_probe` succeed moved a user OFF the transport that
        /// could relay and onto one that only works on the same LAN segment.
        /// The visible result was "Waiting for the device's screen…" forever.
        ///
        /// Optional so an older app still gets a stream (host-only, as before)
        /// rather than an error — but the agent SAYS SO in its answer path
        /// rather than silently degrading.
        #[serde(default)]
        ice_servers: Vec<IceServer>,
        /// Answer the offer and open the data channels, but never capture.
        ///
        /// This is how files are browsed without opening the host's screen. The
        /// transport is identical — the `files` channel is served from the
        /// socket arm of the stream loop and has never touched the picture — so
        /// "no video" costs nothing more than not acquiring the duplication.
        ///
        /// A data-only session takes NO monitor reservation and is not recorded
        /// in the agent's session map, so `Inject` and `SetPrivacyMode` cannot
        /// target it. A session with no screen must not be able to move a
        /// pointer on one.
        #[serde(default)]
        data_only: bool,
    },
    /// One ICE candidate trickled by the controller.
    ///
    /// Separate from StartStream because the browser sends most of its
    /// candidates AFTER the offer — an agent given only what the offer carried
    /// has nothing to connect to.
    AddRemoteCandidate { session_id: String, candidate: String },
    /// Tear the stream down and release its capture.
    StopStream { session_id: String },
    /// Update encoding quality parameters on the fly.
    UpdateStream {
        session_id: String,
        fps: Option<u32>,
        bitrate: Option<u32>,
    },
    /// Retrieve the current encoder settings for this session.
    QueryStreamQuality { session_id: String },
    /// Force the next encoded frame to be an IDR.
    ///
    /// The GOP is infinite (keyframes only on demand), so a controller whose
    /// decoder lost reference state — Android freezing the app mid-session is
    /// the canonical case — has NO recovery unless its own libwebrtc happens
    /// to PLI. This is the explicit lever: side-effect-free, idempotent, and
    /// harmless to run late, which is why it carries no generation/deadline.
    /// An agent older than this request answers "bad request" and keeps the
    /// pipe (pipe.rs answers rather than dropping) — callers must swallow
    /// that. Do NOT bump PROTOCOL_VERSION for it: the Hello handshake refuses
    /// version skew outright, and both halves hard-code the number.
    RequestKeyframe { session_id: String },
    /// Point a LIVE stream at a different output.
    ///
    /// Deliberately not StopStream + StartStream: that would need a fresh SDP
    /// offer/answer round trip through the relay, and the viewer would watch the
    /// session drop and rebuild to change monitor. Swapping the capture under
    /// the running encoder keeps the peer connection and the video track exactly
    /// where they are — the only visible effect is the picture changing.
    SetMonitor { session_id: String, monitor: usize },
    /// Enable or disable privacy mode (blank screen overlay).
    SetPrivacyMode { session_id: String, enabled: bool },

    /// Stop blending the host's pointer into this stream's frames, because the
    /// controller is drawing its own (see ScreenCapture::set_draw_cursor).
    ///
    /// ADDITIVE — do NOT bump PROTOCOL_VERSION for it, exactly as for
    /// RequestKeyframe. An older agent answers "bad request", the host turns
    /// that into a `cursor-owner-failed` signal, and the controller stays at
    /// cursorOwned=false: the host keeps drawing the cursor and the
    /// controller keeps not drawing one, which is precisely today's
    /// behaviour. Every mixed-version pair therefore lands on exactly one
    /// cursor.
    SetDrawCursor { session_id: String, enabled: bool },

    /// Is a Windows secure desktop (a UAC prompt, the lock screen, or the
    /// sign-in screen) currently blocking this session's capture, on an agent
    /// that cannot follow it there?
    ///
    /// Read-only and side-effect-free. The app polls it during a live session so
    /// it can bring up the SYSTEM secure-desktop bridge the instant a UAC prompt
    /// steals the picture (a `Flavour::User` agent cannot cross to Winlogon; the
    /// stream thread raises the flag when its `follow_input_desktop()` is
    /// refused, and clears it when capture resumes).
    ///
    /// ADDITIVE — do NOT bump PROTOCOL_VERSION for it, exactly as for
    /// RequestKeyframe and SetDrawCursor. An older agent answers "bad request";
    /// the app reads that as "no secure desktop" and simply never offers the
    /// bridge, which is precisely today's behaviour.
    SessionStatus { session_id: String },
    //
    // (see ALLOWED_FPS / ALLOWED_BITRATE_BPS below for what StartStream and
    // UpdateStream will accept)
    //
    /// Grant (or revoke) file access for a live stream, confined to one folder.
    ///
    /// `root: None` revokes. Nothing on the peer's side can send this — it
    /// arrives over the app's authenticated pipe, and the app only sends it
    /// once the person at this machine has approved the folder. Until then the
    /// stream's `files` channel is answered with a refusal, so consenting to
    /// share a screen never silently also shares the disk.
    SetFileAccess {
        session_id: String,
        root: Option<String>,
        /// Grant the unattended POLICY scope — fixed drives minus the system and
        /// secret-bearing locations — instead of a single folder.
        ///
        /// Set only for a host that is ARMED for unattended access and whose
        /// controller proved the passphrase. There is nobody at the keyboard to
        /// pick a folder in that case, which is the entire point of it.
        ///
        /// A bool rather than the scope's contents: if the app could enumerate
        /// the paths, the app could WIDEN them, and the app is the only thing
        /// between this pipe and a remote peer. The agent resolves the policy
        /// itself so that the answer cannot be argued with over the wire.
        ///
        /// `#[serde(default)]` so an older app that sends only `root` keeps
        /// working rather than failing to parse.
        #[serde(default)]
        policy: bool,
    },
    /// Inject one input event, already opened and sequence-checked by the app.
    ///
    /// THE ORIGINAL PATH, kept working unchanged. It is correct whenever the
    /// caller is the desktop app: the app owns the socket, the session and the
    /// authorisation decision, so it is already trusted with the plaintext and
    /// adding a second key owner would be worse, not better.
    ///
    /// It is NOT correct once a LocalSystem service holds the socket, because
    /// then the process opening the frames is one that also faces the internet.
    /// `InjectSealed` exists for that case. Both are kept so this is not a flag
    /// day — a session uses one or the other depending on who opened it.
    Inject { session_id: String, event: serde_json::Value },

    /// Begin a session whose control frames THIS PROCESS opens.
    ///
    /// `static_shared` is X25519(the host's device private key, the peer's
    /// device public key), computed by whoever holds that key — today the Tauri
    /// process, on a cold-boot host the agent itself once it has a machine-scope
    /// identity. The agent generates its own ephemeral pair, derives the session
    /// key, and returns only the PUBLIC half for the host to put in its
    /// DeviceConnectResponse.
    OpenSession {
        session_id: String,
        /// base64, 32 bytes.
        static_shared: String,
        /// The controller's ephemeral public key, `x25519:`-prefixed.
        peer_eph_pub: String,
            /// TURN/STUN for the stream this session will negotiate.
        ///
        /// CARRIED HERE rather than on the sealed offer, because the offer is
        /// opened inside the agent and the relay must never need to read it.
        /// Empty means host candidates only, which works across a LAN and fails
        /// from mobile data — the exact regression 0.8.6-0.8.9 fixed — so the
        /// caller is expected to have fetched `GET /ice-config` first.
        #[serde(default)]
        ice_servers: Vec<IceServer>,
},

    /// Inject one input event that ARRIVED SEALED and is opened here.
    ///
    /// Never returns the plaintext — not on success, not in an error, not in a
    /// log line. The whole point of moving the key down is that the owner's
    /// Windows password stops existing above this process, and an error message
    /// echoing the frame would put it straight back.
    InjectSealed { session_id: String, payload: String },

    /// One SEALED signalling frame, opened and acted on inside the agent.
    ///
    /// WHY THIS EXISTS RATHER THAN THE HOST OPENING IT. At a sign-in screen the
    /// process holding the WebSocket is the SYSTEM service, which also holds a
    /// public internet socket. If it opened these frames it would hold the
    /// session key — and the same key opens the input frames carrying the
    /// owner's Windows password. `control_key.rs`'s header exists to keep
    /// exactly one process in possession of that, and it is this one, because
    /// this one already calls SendInput.
    ///
    /// So the service relays ciphertext it cannot read, in both directions.
    /// Returns any frames the agent wants sent back, already sealed.
    SealedSignal { session_id: String, payload: String },

    /// The unattended-access challenge, sealed and ready to relay.
    ///
    /// `UaChallenge` returns the salt and nonce in the clear for a caller that
    /// is going to seal them itself. A headless relay cannot, so this returns
    /// the finished frame instead.
    SealedChallenge { session_id: String },

    /// Answer an unattended-access challenge for `session_id`.
    ///
    /// Until this succeeds, `InjectSealed` refuses. Sealing protects
    /// confidentiality; it says nothing about whether the peer is allowed to
    /// type here, and once a LocalSystem process holds an internet socket that
    /// is the property that matters.
    UaProve { session_id: String, nonce: String, sig: String },

    /// Issue an unattended-access challenge for `session_id`.
    UaChallenge { session_id: String },
    /// Release every held key/button. Called on teardown so a session ending
    /// mid-keypress cannot strand a key down.
    ReleaseInput,
}

/// One capturable output as the app's picker should describe it.
///
/// Geometry comes from the capture enumeration, so `index` and the rectangle
/// always refer to the same physical screen — the property that was missing
/// when the app synthesised this list from a count.
#[derive(Debug, Clone, Serialize)]
pub struct MonitorDesc {
    pub index: usize,
    pub left: i32,
    pub top: i32,
    pub width: i32,
    pub height: i32,
    /// Whether the OS calls this the primary display. Reported rather than
    /// assumed of index 0, which DXGI does not promise.
    pub primary: bool,
}

#[derive(Debug, Serialize)]
#[serde(tag = "ok", rename_all = "snake_case")]
pub enum Response {
    /// The agent's ephemeral public key for a session it now holds the key for.
    SessionOpened { eph_pub: String },
    /// A single-use unattended-access challenge, plus the salt the controller
    /// needs to reproduce the key derivation. The salt is not a secret.
    UaChallenge { nonce: String, salt: String },
    Hello {
        version: u32,
        platform: String,
    },
    StreamQualityAck {
        session_id: String,
        fps: u32,
        bitrate_kbps: u32,
        applied: bool,
    },
    Capabilities {
        capture: bool,
        /// The whole point: true means a capture can START with nobody present.
        unattended: bool,
        input: bool,
        /// UAC / lock screen. False until the SYSTEM service exists, and saying
        /// so is better than a session that freezes at the first prompt.
        elevated: bool,
        monitors: usize,
    },
    Monitors {
        count: usize,
        /// The outputs themselves, in the order `monitor` indexes them.
        ///
        /// A COUNT ALONE IS NOT ENOUGH, and shipping only one is why the picker
        /// invented its own labels: it called output 0 "Main display" and
        /// numbered the rest, neither of which DXGI guarantees. Someone with
        /// three screens then chose a label that named a different panel from
        /// the one that appeared. `count` stays for an older app reading this
        /// reply.
        monitors: Vec<MonitorDesc>,
    },
    Started {
        session_id: String,
        width: u32,
        height: u32,
    },
    Frame {
        width: u32,
        height: u32,
        stride: usize,
        /// base64 BGRA, top-down.
        bgra: String,
    },
    /// The stream is negotiated and running. `answer_sdp` goes back to the
    /// browser; frames flow over UDP from here, not over this pipe.
    Streaming {
        session_id: String,
        answer_sdp: String,
    },

    /// Zero or more sealed frames for the caller to relay verbatim.
    ///
    /// A LIST, not an Option, because one inbound frame can produce none (an
    /// ICE candidate) or one (an offer's answer), and a caller that has to
    /// branch on which is which would be reading the contents — which is the
    /// thing this whole shape exists to avoid.
    SealedSignals { payloads: Vec<String> },
    /// Answer to `SessionStatus`.
    ///
    /// `secure_desktop: true` means a UAC/lock/sign-in screen currently owns the
    /// display for this session and this agent cannot follow it there, so the
    /// picture is frozen until the SYSTEM bridge takes over (or the prompt
    /// closes). `false` is the ordinary case.
    SessionState { secure_desktop: bool },
    /// Nothing changed since the last frame. NOT an error — the caller repeats
    /// the previous frame. A still desktop produces these constantly.
    NoChange,
    Ok,
    Error {
        message: String,
    },
}

impl Response {
    pub fn error(message: impl Into<String>) -> Self {
        Response::Error { message: message.into() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// THE EXACT BYTES THE APP SENDS, pinned at this end too.
    ///
    /// `frontend/src/api/devices/hostAgent.ts` builds this frame from a literal
    /// — it cannot import these types — and its own test
    /// (`secureDesktopStatus.test.ts`) pins the same string. Two pinned
    /// literals is not duplication for its own sake, it is the only guard
    /// available: a guessed cross-process name does not fail loudly, it just
    /// stops working. Rename the variant and one of the two tests goes red.
    ///
    /// Silence is the specific danger here. This request is POLLED, and the
    /// caller turns any failure into "no secure desktop" so a 1Hz error storm
    /// cannot kill a session — so a broken name would present as a machine that
    /// simply never shows a UAC prompt, forever, with nothing logged.
    #[test]
    fn session_status_parses_from_the_frame_the_app_writes() {
        let line = r#"{"cmd":"session_status","session_id":"s1"}"#;
        match serde_json::from_str::<Request>(line).expect("the app's frame must parse") {
            Request::SessionStatus { session_id } => assert_eq!(session_id, "s1"),
            other => panic!("the app's session_status frame reached the wrong arm: {other:?}"),
        }
    }

    /// The other half of the wire: the REPLY. `hostAgent.ts` reads
    /// `secure_desktop` off this object, and a rename here would have every
    /// poll read as "no prompt" — the same silent failure from the other end.
    #[test]
    fn session_state_serialises_to_what_the_app_reads() {
        assert_eq!(
            serde_json::to_string(&Response::SessionState { secure_desktop: true }).unwrap(),
            r#"{"ok":"session_state","secure_desktop":true}"#,
        );
        assert_eq!(
            serde_json::to_string(&Response::SessionState { secure_desktop: false }).unwrap(),
            r#"{"ok":"session_state","secure_desktop":false}"#,
        );
    }
}
