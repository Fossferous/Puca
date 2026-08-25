//! WebSocket Message Protocol
//!
//! Strongly-typed message enums for client-server communication.

use crate::state::UserId;
use serde::{Deserialize, Serialize};

/// Messages sent from the client to the server
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", content = "payload")]
pub enum ClientMessage {
    /// Ping to keep connection alive
    Ping,

    /// Join a room/channel
    JoinRoom { room_id: String },

    /// Leave a room/channel
    LeaveRoom { room_id: String },

    /// Send a chat message
    ChatMessage { room_id: String, content: String },

    /// WebRTC signaling: Send SDP offer
    Offer { target_user: UserId, sdp: String },

    /// WebRTC signaling: Send SDP answer
    Answer { target_user: UserId, sdp: String },

    /// WebRTC signaling: Send ICE candidate
    IceCandidate {
        target_user: UserId,
        candidate: String,
    },

    /// Start streaming in a room
    StartStream { room_id: String },

    /// Stop streaming
    StopStream { room_id: String },

    /// Legacy: older clients emit this after creating a channel. The server now
    /// fans out channel creation authoritatively in `create_channel`, so this is
    /// accepted (for compat) but ignored — see the ws handler. Fields unread.
    #[allow(dead_code)]
    ChannelCreated {
        server_id: String,
        channel: ChannelInfo,
    },

    /// Send a direct message to another user
    DirectMessage { to_user_id: UserId, content: String },

    /// Start screen sharing in a room.
    ///
    /// `stream_id` is the sharer's MediaStream id, announced so mesh peers can
    /// classify the arriving video track by IDENTITY instead of by
    /// elimination — the elimination heuristic misfiled a listen-only
    /// sharer's mid-share camera as the share itself. `default` because every
    /// deployed client predates the field; those peers simply keep the old
    /// heuristic.
    ScreenShareStart {
        room_id: String,
        #[serde(default)]
        stream_id: Option<String>,
    },

    /// Stop screen sharing
    ScreenShareStop { room_id: String },

    /// Start camera in a room
    CameraStart { room_id: String },

    /// Stop camera
    CameraStop { room_id: String },

    /// User is typing in a room
    Typing { room_id: String },

    // --- Remote control of a shared screen (relayed peer-to-peer, like the
    // WebRTC signaling above). The HOST is the one sharing their screen; a
    // VIEWER asks for control, the host approves, then the viewer streams input
    // events which only the host's desktop app actually injects. The server is a
    // dumb relay — the host's client is the authoritative gate (it only injects
    // input from a viewer it has an active grant for). ---
    /// Viewer -> host: "may I control your shared screen?" `eph` carries the
    /// viewer's per-session ephemeral X25519 public key for the E2EE handshake.
    ControlRequest {
        target_user: UserId,
        #[serde(default)]
        eph: Option<String>,
    },

    /// Host -> viewer: grant/deny a pending control request. On grant, `eph`
    /// carries the host's ephemeral public key so both sides derive the session
    /// key, and `cap_w`/`cap_h` carry the host's capture pixel size so the
    /// viewer can calibrate FPS-mode delta scaling against a STABLE dimension
    /// (the decoded stream shrinks when WebRTC downscales under load).
    ControlResponse {
        target_user: UserId,
        granted: bool,
        #[serde(default)]
        eph: Option<String>,
        #[serde(default)]
        cap_w: Option<u32>,
        #[serde(default)]
        cap_h: Option<u32>,
    },

    /// Viewer -> host: one input event (opaque JSON, same as sdp/candidate).
    ControlInput { target_user: UserId, event: String },

    /// Either side -> other: end an active control session.
    ControlEnd { target_user: UserId },

    // --- Device identity ("My Devices") --------------------------------------
    //
    // The JWT is account-scoped and identical on every device, so it cannot say
    // WHICH device this connection is. A `?device_sig=` query param would be
    // replayable from logs and proxies, so possession is proved over the open
    // socket against a server-chosen nonce instead.
    /// Client -> server: answer to `DeviceChallenge`. `sig` is
    /// Ed25519(device signing key, "sovereign-device-attest-v1" || nonce || uid),
    /// base64. Failure or silence is NOT fatal — the connection simply stays
    /// unattested and is not addressable by device.
    DeviceAttest { device_id: String, sig: String },

    // --- Device-control sessions ---------------------------------------------
    //
    // A parallel path to the Control*/Offer/Answer relays above, NOT a widening
    // of them. Those are gated on the two users sharing a live voice room, which
    // is precisely what one person's two machines never do. Loosening that gate
    // would re-open the unsolicited-call / IP-harvest fan-out that
    // send_signal_to_user exists to prevent (audit H6), so device sessions get
    // their own registry and their own authorization: one DB check at connect,
    // then routing pinned to the two specific SOCKETS.
    /// Controller -> host: ask to control one of my own devices. `proof` is
    /// opaque here (the controller's auth record + the host-signed grant + a
    /// challenge signature); the HOST verifies it, not the server.
    DeviceConnect {
        host_device: String,
        session_id: String,
        eph: String,
        proof: String,
    },

    /// Host -> controller: accept or refuse. On accept, `eph` completes the
    /// handshake and `cap_w`/`cap_h` carry the host's capture size.
    DeviceConnectResponse {
        session_id: String,
        accepted: bool,
        #[serde(default)]
        eph: Option<String>,
        #[serde(default)]
        reason: Option<String>,
        #[serde(default)]
        cap_w: Option<u32>,
        #[serde(default)]
        cap_h: Option<u32>,
    },

    /// Either side -> other: opaque WebRTC signalling (SDP / ICE).
    DeviceSignal { session_id: String, payload: String },

    /// Controller -> host: one sealed input event.
    DeviceInput { session_id: String, event: String },

    /// Either side -> other: end the session.
    DeviceEnd {
        session_id: String,
        #[serde(default)]
        reason: Option<String>,
    },

    /// Either side -> server: my socket dropped and reconnected; rebind this
    /// still-ACTIVE session to the new socket. The server matches the claim
    /// against the (user, attested device) recorded on the session, inside
    /// the detach grace window. Answered with DeviceReattached on success,
    /// DeviceEnded when the session did not survive.
    DeviceReattach { session_id: String },

    /// Ask ANOTHER of your devices to broadcast a Wake-on-LAN packet.
    ///
    /// A magic packet is a LAN broadcast and a sleeping machine has no socket,
    /// so waking one always requires a second device already awake on the same
    /// subnet. Which device is eligible is decided CLIENT-side, after decrypting
    /// `devices.lan_info` — the server never learns MACs or internal IPs, and
    /// only relays an already-chosen instruction.
    DeviceWake {
        waker_device: String,
        mac: String,
        #[serde(default)]
        broadcast: Option<String>,
    },

    // --- Peer-to-peer file transfer (docs/P2P_FILE_TRANSFER_PLAN.md) ---------
    //
    // These carry ONLY control traffic; the bytes never touch the server. They
    // are separate from the Offer/Answer/IceCandidate variants above because
    // those are gated on the two users sharing a voice room, which is exactly
    // what two people in a DM do not do. Widening that gate would loosen call
    // signalling for everyone, so transfers get their own path with their own
    // authorization (a DM must exist and neither party may have blocked the
    // other), checked once at offer time and thereafter against the accepted
    // transfer itself.
    /// Sender -> recipient: propose a transfer. `sha256` lets the receiver
    /// verify what it assembled, and identifies the same file on a resume.
    FileOffer {
        target_user: UserId,
        transfer_id: String,
        name: String,
        size: u64,
        mime: String,
        sha256: String,
        /// Optional: which of YOUR devices to send to. Without it a
        /// self-transfer fans out to every other device of yours and whichever
        /// answers first wins — fine when you have two, ambiguous once you have
        /// three. `#[serde(default)]` so existing clients keep working.
        #[serde(default)]
        target_device: Option<String>,
        /// Base64 MAC binding this offer (id/name/size/mime/sha256/peer pair) to
        /// the sender's pinned identity key, so the SERVER cannot substitute the
        /// hash and MITM the transfer. The server only RELAYS it — it cannot
        /// forge or verify it (the key is the peers' DM shared secret). Optional
        /// on the wire for forward-compat, but the receiver requires it.
        #[serde(default)]
        auth: Option<String>,
    },

    /// Recipient -> sender: begin. `resume_from` is 0 for a fresh transfer, or
    /// the byte offset already on disk from a previous attempt.
    FileAccept {
        transfer_id: String,
        #[serde(default)]
        resume_from: u64,
    },

    /// Recipient -> sender: refuse (declined, no room on disk, unsupported).
    FileReject { transfer_id: String, reason: String },

    /// Either side: abandon an offered or running transfer.
    FileCancel {
        transfer_id: String,
        /// Why, so the peer can say something truthful. Optional for
        /// compatibility with clients that predate this field.
        #[serde(default)]
        reason: Option<String>,
    },

    /// Either side: the transfer finished. Releases the registry slot so a
    /// completed transfer stops counting against the per-user cap.
    FileComplete { transfer_id: String },

    /// Either side: opaque WebRTC signalling (SDP / ICE) for the transfer's own
    /// peer connection, scoped to a transfer rather than to a room.
    FileSignal {
        transfer_id: String,
        payload: String,
    },
}

/// Messages sent from the server to the client
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", content = "payload")]
pub enum ServerMessage {
    /// Pong response to Ping
    Pong,

    /// Error message
    Error { message: String },

    /// Successfully joined a room
    RoomJoined {
        room_id: String,
        members: Vec<UserInfo>,
    },

    /// Successfully left a room
    RoomLeft { room_id: String },

    /// A moderator moved you into a different voice channel. Join
    /// `voice_<channel_id>`.
    ///
    /// The server has ALREADY removed you from `from_channel_id` and cut your
    /// media there, so ignoring this leaves you out of voice entirely — never
    /// still sitting in the channel you were moved out of.
    ///
    /// Sent INSTEAD of the `RoomLeft` that a plain eviction would carry: the
    /// client's RoomLeft handler tears the call down AND clears the current
    /// voice channel, which would race this message's own channel switch. See
    /// `ws::SelfNotice`.
    ///
    /// Carries ids only, never a channel struct: `ChannelInfo` has no
    /// `sfu_mode`, and a client that mounted its voice panel from one would
    /// negotiate a P2P mesh into an SFU channel. The client resolves the real
    /// channel from its own cache — which also handles being moved on a server
    /// it is not currently viewing.
    VoiceMoved {
        server_id: String,
        channel_id: i64,
        /// Where they were moved FROM, so a duplicate or late directive that no
        /// longer matches the client's current channel can be ignored.
        from_channel_id: i64,
        /// Display name of the moderator, for the toast.
        moved_by: String,
    },

    /// User joined the room you're in
    UserJoined { room_id: String, user: UserInfo },

    /// User left the room you're in
    UserLeft { room_id: String, user_id: UserId },

    /// Received a chat message
    ChatMessage {
        room_id: String,
        sender: UserInfo,
        content: String,
        timestamp: i64,
        /// Database id of the persisted message (set for REST-created messages).
        /// Lets receivers key reactions/edits to the real message instead of a
        /// synthetic timestamp id.
        #[serde(skip_serializing_if = "Option::is_none")]
        message_id: Option<String>,
        /// Server-stamped clip consent (docs/CLIPS.md) for a CLIP post, so the
        /// live frame renders the badge without a re-fetch. Absent (not null)
        /// for every other message — the frame is byte-identical to before.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        clip_consent: Option<serde_json::Value>,
    },

    /// A message was posted in a channel of a server you belong to. Sent to
    /// every online server member EXCEPT the author, regardless of which room
    /// they're in, so clients can play a notification sound / bump unread live
    /// for channels they aren't currently viewing. Carries no content (the
    /// full message still rides ChatMessage to the channel room); the client
    /// gates the sound on its own per-server/per-channel mute settings.
    MessageNotification {
        server_id: String,
        channel_id: i64,
        message_id: String,
        author: UserInfo,
    },

    /// Reactions on a message changed (added or removed) — clients viewing the
    /// channel should refetch that message's reactions.
    ReactionUpdate { room_id: String, message_id: String },

    /// A message was deleted (by its author or a Manage Messages holder).
    /// Sent to the channel's room so every open viewer drops the row live —
    /// without this, other viewers kept rendering deleted messages until the
    /// next history fetch.
    MessageDeleted { channel_id: i64, message_id: String },

    /// A checklist channel's tasks changed (added/toggled/moved/deleted) — other
    /// viewers refetch that channel's checklist to sync live.
    ChecklistUpdate { channel_id: i64 },

    /// You were removed from a server (kicked or banned) — drop it client-side
    /// immediately instead of waiting for the next reload.
    RemovedFromServer { server_id: String },

    /// Somebody joined a server you are in. Sent to every EXISTING member
    /// (never the joiner — their own client already knows, from the HTTP
    /// response that created the membership). Carries no permissions
    /// implication: it is an announcement, and clients refetch member lists
    /// through the usual endpoints.
    MemberJoined {
        server_id: String,
        user: UserInfo,
    },

    /// WebRTC signaling: Received SDP offer
    Offer { from_user: UserId, sdp: String },

    /// WebRTC signaling: Received SDP answer
    Answer { from_user: UserId, sdp: String },

    /// WebRTC signaling: Received ICE candidate
    IceCandidate {
        from_user: UserId,
        candidate: String,
    },

    /// User started streaming
    StreamStarted { room_id: String, streamer: UserInfo },

    /// User stopped streaming
    StreamStopped {
        room_id: String,
        streamer_id: UserId,
    },

    /// A new channel was created
    ChannelCreated {
        server_id: String,
        channel: ChannelInfo,
    },

    /// Channel permissions changed somewhere in this server (an overwrite was
    /// created/updated/deleted, a role's permissions were edited, or a member's
    /// roles changed) — clients refetch the channel list / my_permissions. The
    /// server also evicts now-VIEW-denied users from the affected live rooms.
    ChannelPermsChanged { server_id: String },

    /// Received a direct message
    DirectMessage {
        message_id: String,
        conversation_id: String,
        sender: UserInfo,
        content: String,
        timestamp: i64,
    },

    /// User started screen sharing. `stream_id` identifies WHICH MediaStream
    /// is the share (see ClientMessage::ScreenShareStart); absent when the
    /// sharer's client predates the field.
    ScreenShareStarted {
        room_id: String,
        streamer: UserInfo,
        #[serde(skip_serializing_if = "Option::is_none")]
        stream_id: Option<String>,
    },

    /// User stopped screen sharing
    ScreenShareStopped {
        room_id: String,
        streamer_id: UserId,
    },

    /// User started camera
    CameraStarted { room_id: String, user: UserInfo },

    /// User stopped camera
    CameraStopped { room_id: String, user_id: UserId },

    /// User is typing
    UserTyping { room_id: String, user: UserInfo },

    /// User came online (Global presence)
    UserOnline { user: UserInfo },

    /// User went offline (Global presence)
    UserOffline { user_id: UserId },

    // --- Remote control (host receives these; see ClientMessage above) ---
    /// A viewer is asking to control this (host) user's shared screen. Username
    /// included so the host's approval prompt can name the requester. `eph` is
    /// the viewer's per-session ephemeral public key for the E2EE handshake.
    ControlRequested {
        from_user: UserId,
        from_username: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        eph: Option<String>,
    },

    /// Host answered the viewer's request. On grant, `eph` is the host's
    /// ephemeral public key and `cap_w`/`cap_h` are the host's capture size.
    ControlResponse {
        from_user: UserId,
        granted: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        eph: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cap_w: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cap_h: Option<u32>,
    },

    /// An input event from the controlling viewer (opaque JSON).
    ControlInput { from_user: UserId, event: String },

    /// The other party ended the control session.
    ControlEnded { from_user: UserId },

    // --- Device identity ("My Devices") --------------------------------------
    /// Sent immediately after the socket opens. `nonce` is 32 random bytes,
    /// base64, single-use and scoped to THIS connection — so an attestation
    /// captured from one socket cannot be replayed onto another.
    DeviceChallenge { nonce: String },

    /// The connection is now addressable as this device.
    DeviceAttested { device_id: String },

    /// A device was revoked. Sent to all of the user's connections so open
    /// device lists update; the revoked device's own sockets are hung up
    /// separately and will simply drop.
    DeviceRevoked { device_id: String },

    /// One of this user's devices just attested (`online: true`) or its
    /// attested connection just closed (`online: false`). Sent to the user's
    /// OTHER connections so an open device list can re-read itself at once
    /// instead of on its next 15 s poll — the moment a machine comes up is
    /// exactly the moment someone is waiting to press Control on it.
    ///
    /// A HINT, NOT A STATE. The client is expected to refresh the list, not
    /// to apply the boolean: two frames can cross for a device that
    /// reconnects quickly (new socket attests, old socket closes), and the
    /// list endpoint computes `online` from the live connections either way.
    DevicePresence { device_id: String, online: bool },

    // --- Device-control sessions ---------------------------------------------
    /// Someone wants to control this device. `from_device` is the controller's
    /// id; `proof` is verified by THIS client, not by the server.
    ///
    /// The `from_user`/`from_username`/`capabilities` trio is present ONLY for
    /// a cross-user connection under an accepted share (absent = same-account,
    /// byte-identical to the pre-share wire shape). They are stamped by the
    /// SERVER from the authenticated connection's claims — never taken from
    /// the client — so a grantee cannot spoof another identity into the
    /// owner's consent prompt (same defence ControlRequested already has).
    /// The host treats them as ROUTING hints for its own verification: it
    /// still independently verifies the controller's device record against
    /// the grantee's pinned account signing key and its own signed grant.
    DeviceConnectRequested {
        session_id: String,
        from_device: String,
        eph: String,
        proof: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        from_user: Option<UserId>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        from_username: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        capabilities: Option<Vec<String>>,
    },

    /// The host answered. `accepted:false` carries a `reason` the controller
    /// can show — a refusal that arrives as silence is indistinguishable from a
    /// dropped message.
    DeviceConnectAnswered {
        session_id: String,
        accepted: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        eph: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cap_w: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cap_h: Option<u32>,
    },

    /// Opaque WebRTC signalling from the other end of the session.
    DeviceSignalled { session_id: String, payload: String },

    /// A sealed input event from the controller.
    DeviceInputted { session_id: String, event: String },

    /// The session ended — by either party, by the reaper, or because the other
    /// side's socket went away. Always carries a reason so the UI can say WHY
    /// rather than just going blank.
    DeviceEnded { session_id: String, reason: String },

    /// The peer's socket dropped mid-session; the server is holding the
    /// session for a short grace window in case it reattaches. NOT an end —
    /// DevicePeerReconnected or DeviceEnded follows. Old clients that predate
    /// this message ignore it and simply learn the outcome from whichever of
    /// those two arrives.
    DevicePeerReconnecting { session_id: String },

    /// The peer reattached inside the grace window; the relay is whole again.
    DevicePeerReconnected { session_id: String },

    /// Your own DeviceReattach succeeded. `peer_connected: false` means the
    /// OTHER side is still detached — show "reconnecting" until its return
    /// arrives as DevicePeerReconnected (or its failure as DeviceEnded).
    /// Carried here because the DevicePeerReconnecting notice may have been
    /// addressed to this claimant's DEAD conn when both sides dropped at once.
    DeviceReattached {
        session_id: String,
        peer_connected: bool,
    },

    /// This device should broadcast a wake packet for `mac`.
    DeviceWakeRequested {
        mac: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        broadcast: Option<String>,
    },

    /// What happened to the `DeviceWake` you just sent.
    ///
    /// WHY THIS EXISTS AT ALL. Every refusal on the wake path used to be a bare
    /// `ServerMessage::Error`, and the only listener for that frame in the whole
    /// frontend is the chat view, which pops an `alert()` unconnected to the
    /// device card. So a wake that was refused outright — an offline waker, a
    /// rate-limit drop, a device asking to wake itself — looked exactly like a
    /// wake in progress: the card counted down for a full three minutes and then
    /// blamed the user's BIOS for a packet that was never sent. An unexplained
    /// three-minute wait is the one diagnosis that sends someone to reflash
    /// firmware over a software bug.
    ///
    /// `ok` means the request was RELAYED, not that anything woke. Nothing can
    /// promise that: a magic packet is unacknowledged, and the only proof is the
    /// machine coming back.
    DeviceWakeResult {
        ok: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },

    // --- Cross-user device shares ("share a device with a friend") -----------
    //
    // Live-update notices for the REST share flow (device_handlers.rs). All
    // identity fields are stamped server-side from the authenticated caller's
    // claims, never from a request body.
    /// A friend invited you to standing access on one of their devices.
    DeviceShareInvited {
        invite_id: i64,
        from_user: UserId,
        from_username: String,
        host_device: String,
        host_device_name: String,
        capabilities: Vec<String>,
    },

    /// The grantee answered your invite. Sent to the OWNER's sessions — the
    /// host device auto-signs the grant when it hears an accept.
    DeviceShareAnswered {
        invite_id: i64,
        host_device: String,
        accepted: bool,
        grantee_user: UserId,
        grantee_username: String,
    },

    /// The share is accepted AND host-signed: connectable from now on. Sent
    /// to the GRANTEE's sessions, whichever of accept/sign completed last.
    DeviceShareReady {
        invite_id: i64,
        host_device: String,
    },

    /// A share was withdrawn (by the owner) or given up (by the grantee).
    /// Sent to the OTHER party's sessions; any live session under it has
    /// already been ended with its own DeviceEnded.
    DeviceShareRevoked {
        invite_id: i64,
        host_device: String,
    },

    /// A granted friend's session on your device just went active. Fanned out
    /// to ALL the owner's sessions so the owner hears about it even when the
    /// host machine is unattended (the host device itself also shows a live
    /// in-session banner for the whole duration).
    DeviceShareSessionStarted {
        host_device: String,
        from_user: UserId,
        from_username: String,
    },

    // --- Clips (replay-buffer consent; clip_handlers.rs, docs/CLIPS.md) --------
    //
    // Nothing here is relayed from a request body: proposer, counts and times
    // are stamped by the server from the authenticated caller's claims and its
    // OWN in-memory presence log — the same rule the device-share notices
    // follow. Client→server is REST (proposals need status codes and rate
    // limits, and an approver may be on a phone that is NOT in the voice room,
    // so send_signal_to_user's shared-room scoping is the wrong transport).
    //
    // Deliberate omissions: no `voter` anywhere, no `by` on a decline, no
    // approver NAMES on approver-facing frames. The person with the veto is
    // the person in the footage; telling the group who used it turns a private
    // "no" into a confrontation. Times are RELATIVE (`*_in_ms`, `ended_ago_ms`)
    // so a client's clock skew cannot shrink or shift a window.
    /// A clip is waiting on YOUR approval. A DOORBELL: the client fetches
    /// GET /clips/:id (the authority) before rendering anything.
    ClipProposed {
        clip_id: String,
        expires_in_ms: i64,
    },

    /// Content-free twin of ClipProposed for the undelivered/wake queue: a
    /// parked frame is drained minutes later on a phone that may not be the
    /// owner's — it must carry nothing but the id to look up.
    ClipPending {
        clip_id: String,
    },

    /// Progress. PROPOSER ONLY (approvers would infer who has not voted).
    ClipVoteUpdate {
        clip_id: String,
        approved_count: u32,
        total: u32,
    },

    /// Terminal. The proposer sees the real outcome; every other approver
    /// receives only `approved` or `closed`.
    ClipResolved {
        clip_id: String,
        outcome: ClipOutcome,
    },

    // --- Peer-to-peer file transfer (see ClientMessage for the rationale) ----
    /// Someone wants to send you a file.
    FileOffered {
        from_user: UserId,
        from_username: String,
        transfer_id: String,
        name: String,
        size: u64,
        mime: String,
        sha256: String,
        /// Relayed verbatim from the sender's `FileOffer.auth` — the offer MAC
        /// the recipient verifies against the sender's pinned identity key.
        #[serde(default)]
        auth: Option<String>,
    },

    /// The recipient accepted; start negotiating and sending from `resume_from`.
    FileAccepted {
        from_user: UserId,
        transfer_id: String,
        resume_from: u64,
    },

    /// The recipient refused.
    FileRejected {
        from_user: UserId,
        transfer_id: String,
        reason: String,
    },

    /// The other party abandoned the transfer (or it was reaped).
    FileCancelled {
        from_user: UserId,
        transfer_id: String,
        reason: String,
    },

    /// SENDER only: the offer could not be delivered right now (the target has
    /// no live socket — a backgrounded phone looks exactly like offline) and
    /// is being HELD server-side until they connect or the offer TTL reaps
    /// it. Not a cancellation: the transfer is still live and FileAccepted
    /// may follow. Old clients ignore the unknown type and simply keep
    /// showing "Waiting for them to accept…", which is true.
    FileParked {
        from_user: UserId,
        transfer_id: String,
        reason: String,
    },

    /// Opaque WebRTC signalling for a transfer's peer connection.
    FileSignal {
        from_user: UserId,
        transfer_id: String,
        payload: String,
    },
}

/// Basic user information for messages
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserInfo {
    pub id: UserId,
    pub username: String,
}

impl UserInfo {
    pub fn new(id: UserId, username: String) -> Self {
        Self { id, username }
    }
}

/// Channel information for messages
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelInfo {
    pub id: i64,
    pub name: String,
    pub channel_type: i32,
    pub server_id: Option<String>,
    #[serde(default)]
    pub parent_id: Option<i64>,
    #[serde(default)]
    pub is_afk: bool,
    #[serde(default)]
    pub has_checklist: bool,
}

/// Outcome of a clip proposal as sent on the wire (snake_case).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ClipOutcome {
    Approved,
    Declined,
    Expired,
    Cancelled,
    /// What a NON-proposer approver sees for any of declined/expired/cancelled.
    Closed,
}

#[cfg(test)]
mod clip_frame_tests {
    use super::*;

    /// The exact bytes the clip frames go out as — and, as importantly, the keys
    /// that must NOT be there. `voter`/`by`/names on approver-facing frames are
    /// the privacy decision (docs/CLIPS.md); a later "helpful" addition goes red.
    #[test]
    fn the_clip_frames_serialise_the_way_the_client_parses_them() {
        let j = |m: &ServerMessage| -> serde_json::Value {
            serde_json::from_str(&serde_json::to_string(m).unwrap()).unwrap()
        };
        let p = j(&ServerMessage::ClipProposed { clip_id: "c1".into(), expires_in_ms: 1_800_000 });
        assert_eq!(p["type"], "ClipProposed");
        assert_eq!(p["payload"]["clip_id"], "c1");
        assert_eq!(p["payload"]["expires_in_ms"], 1_800_000);
        assert!(p["payload"].get("approvers").is_none(), "no names on the doorbell: {p}");
        assert!(p["payload"].get("proposer").is_none(), "no proposer on the doorbell: {p}");

        let pending = j(&ServerMessage::ClipPending { clip_id: "c1".into() });
        assert_eq!(pending["type"], "ClipPending");
        assert_eq!(pending["payload"].as_object().unwrap().len(), 1, "content-free: {pending}");

        let v = j(&ServerMessage::ClipVoteUpdate { clip_id: "c1".into(), approved_count: 1, total: 3 });
        assert_eq!(v["type"], "ClipVoteUpdate");
        assert_eq!(v["payload"]["approved_count"], 1);
        assert_eq!(v["payload"]["total"], 3);
        assert!(v["payload"].get("voter").is_none(), "votes are anonymous on the wire: {v}");

        let r = j(&ServerMessage::ClipResolved { clip_id: "c1".into(), outcome: ClipOutcome::Declined });
        assert_eq!(r["type"], "ClipResolved");
        assert_eq!(r["payload"]["outcome"], "declined");
        assert!(r["payload"].get("by").is_none(), "a decline names nobody: {r}");
        for (o, s) in [(ClipOutcome::Approved, "approved"), (ClipOutcome::Expired, "expired"), (ClipOutcome::Cancelled, "cancelled"), (ClipOutcome::Closed, "closed")] {
            assert_eq!(j(&ServerMessage::ClipResolved { clip_id: "x".into(), outcome: o })["payload"]["outcome"], s);
        }
    }

    /// The live ChatMessage frame carries the consent stamp ONLY for a clip
    /// post; every other message serialises exactly as before Clips existed
    /// (no `clip_consent` key at all — not even null).
    #[test]
    fn chat_message_frame_is_byte_identical_without_a_clip_stamp() {
        let plain = ServerMessage::ChatMessage {
            room_id: "channel_1".into(), sender: UserInfo::new(1, "a".into()), content: "hi".into(), timestamp: 5, message_id: Some("m1".into()), clip_consent: None,
        };
        let s = serde_json::to_string(&plain).unwrap();
        assert!(!s.contains("clip_consent"), "{s}");
        let stamped = ServerMessage::ChatMessage {
            room_id: "channel_1".into(), sender: UserInfo::new(1, "a".into()), content: "hi".into(), timestamp: 5, message_id: Some("m1".into()),
            clip_consent: Some(serde_json::json!({"proposal_id": "p", "approver_count": 2, "part_file_ids": ["f"], "solo": false})),
        };
        let v: serde_json::Value = serde_json::from_str(&serde_json::to_string(&stamped).unwrap()).unwrap();
        assert_eq!(v["payload"]["clip_consent"]["approver_count"], 2);
    }

    /// The OTHER end really does read those names (same rationale as the wake
    /// frame test below: scanned from the frontend source's NON-TEST text).
    #[test]
    fn the_client_listens_for_exactly_these_frames() {
        let ts = include_str!("../frontend/src/api/clips/clipProposals.ts");
        let src = ts.split("__resetClipProposalsForTests").next().unwrap();
        for frame in ["ClipProposed", "ClipPending", "ClipVoteUpdate", "ClipResolved"] {
            assert!(src.contains(&format!("wsClient.on('{frame}'")), "the client must subscribe to {frame}");
        }
        for key in ["expires_in_ms", "approved_count", "outcome"] {
            assert!(src.contains(key), "the client must read `{key}`");
        }
    }

    /// THE THIRD end: Android's native delivery socket parses these frames in
    /// Java, in a different build, and posts the notification the WebView
    /// cannot post while it is frozen.
    ///
    /// Two ways that drifts silently, both invisible to every other test here:
    /// rename a frame and the phone stops ringing for parked proposals (the
    /// Java parser returns null for an unknown type — no error, no log, just a
    /// consent prompt nobody ever sees); reword the copy on one side only and
    /// the SAME proposal stacks twice in the shade, because the two paths
    /// deliberately share a collapse key but would no longer share a body.
    ///
    /// Not a tautology: the strings live in two other languages' source files,
    /// and nothing in this repository generates them from here.
    #[test]
    fn the_android_and_web_clients_ring_the_same_doorbell_with_the_same_words() {
        const CLIP_TITLE: &str = "Approval needed";
        const CONSENT_BODY: &str = "Open Puca to approve or decline";

        let java = include_str!(
            "../frontend/android/app/src/main/java/com/sovereign/app/PushFrames.java"
        );
        // Quoted: a mention in a comment must not satisfy this — the frame
        // names have to be string literals the parser dispatches on, and the
        // copy a literal it actually posts.
        for lit in ["ClipProposed", "ClipPending", CLIP_TITLE, CONSENT_BODY] {
            assert!(
                java.contains(&format!("\"{lit}\"")),
                "PushFrames.java must carry the literal \"{lit}\" — the native delivery \
                 socket is the path that rings while the WebView is frozen"
            );
        }

        let ts = include_str!("../frontend/src/api/clips/clipProposals.ts");
        let ts = ts.split("__resetClipProposalsForTests").next().unwrap();
        for lit in [CLIP_TITLE, CONSENT_BODY] {
            assert!(
                ts.contains(lit),
                "clipProposals.ts must post the same words as PushFrames.java (`{lit}`): the \
                 two paths share a collapse key, so different copy means the same proposal \
                 stacking twice in the shade"
            );
        }
    }
}

#[cfg(test)]
mod wake_frame_tests {
    use super::*;

    /// The exact bytes the wake result goes out as.
    ///
    /// Pinned because the consumer is in ANOTHER LANGUAGE, in another build,
    /// and nothing but this shape joins them. A drift here does not fail
    /// loudly: the frontend simply never hears a refusal, so a wake that the
    /// server declined outright presents as one in progress and the device card
    /// counts down for three minutes before advising a BIOS change. That is the
    /// precise failure this frame was added to remove.
    #[test]
    fn the_wake_result_frame_serialises_the_way_the_client_parses_it() {
        let refused = ServerMessage::DeviceWakeResult {
            ok: false,
            message: Some("that device isn't online to send the wake packet".into()),
        };
        let v: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&refused).unwrap()).unwrap();

        assert_eq!(v["type"], "DeviceWakeResult");
        assert_eq!(v["payload"]["ok"], false);
        assert_eq!(
            v["payload"]["message"],
            "that device isn't online to send the wake packet"
        );

        // Success carries no message, and must not emit a null the client would
        // have to special-case.
        let ok = ServerMessage::DeviceWakeResult { ok: true, message: None };
        let v: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&ok).unwrap()).unwrap();
        assert_eq!(v["payload"]["ok"], true);
        assert!(v["payload"].get("message").is_none(), "no null message: {v}");
    }

    /// The OTHER end really does read those names.
    ///
    /// Scanned from the frontend source rather than restated here, so renaming
    /// the frame or a payload key on the Rust side without following through in
    /// TypeScript goes red. Deliberately reads the file's NON-TEST text: a scan
    /// that included the test module would find every string in its own
    /// assertions and pass whatever the real code said.
    #[test]
    fn the_client_listens_for_exactly_this_frame() {
        let ts = include_str!("../frontend/src/api/devices/wakeSession.ts");
        let src = ts.split("__resetWakeSessionsForTests").next().unwrap();

        assert!(
            src.contains("wsClient.on('DeviceWakeResult'"),
            "the client must subscribe to the frame this file emits"
        );
        // The payload keys it destructures.
        assert!(src.contains("ok?: boolean"), "the client must read `ok`");
        assert!(src.contains("message?: string"), "the client must read `message`");
    }
}
