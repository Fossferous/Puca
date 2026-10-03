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
    ///
    /// `take_over` (voice rooms only): "move the call here". When another
    /// connection of the SAME account is in this voice room, this connection
    /// joins first and the other one is then taken out (`RoomLeft` to it
    /// alone, with `reason: "moved"`), so the room never sees the user leave.
    /// Sent only by a client that has received `OwnVoiceState` on this socket
    /// (the server's sign that it understands the flag); never replayed.
    ///
    /// `replay`: this join is the client re-sending a room it remembers after
    /// its socket came back, not a click. A replay of a voice room that
    /// another device of the account has since ended or moved (see
    /// `LeaveOwnVoice`, `take_over`) is refused with a plain-reason RoomLeft,
    /// so a PC that slept through its RoomLeft does not rejoin with an open
    /// mic.
    ///
    /// Both `default`: every client that predates them is a plain join, and
    /// servers that predate them ignore the fields (unknown fields of a known
    /// variant are not an error).
    JoinRoom {
        room_id: String,
        #[serde(default)]
        take_over: bool,
        #[serde(default)]
        replay: bool,
    },

    /// End this account's call on its OTHER device(s): "Leave" on the
    /// "You're in <channel> on your PC" banner. Acts only on the sender's own
    /// account, and only when `room_id` is still the voice room the account
    /// is in (a stale press does nothing but refresh the sender's
    /// `OwnVoiceState`). Each other connection in the room is told `RoomLeft`
    /// with `reason: "left_elsewhere"`. NEW: an old server answers it with an
    /// Error, so a client sends it only after `OwnVoiceState` has arrived on
    /// this socket.
    LeaveOwnVoice { room_id: String },

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
        /// Record version the MAC covers (2 = binds the sender's DTLS fingerprint
        /// and a timestamp). Relayed verbatim; the receiver decides.
        #[serde(default)]
        auth_v: Option<u8>,
        /// The sender's DTLS certificate fingerprint ("<alg> <HEX>"), inside the MAC.
        #[serde(default)]
        fp: Option<String>,
        /// Offer time (ms since epoch), inside the MAC: bounds replay.
        #[serde(default)]
        ts: Option<u64>,
    },

    /// Recipient -> sender: begin. `resume_from` is 0 for a fresh transfer, or
    /// the byte offset already on disk from a previous attempt.
    FileAccept {
        transfer_id: String,
        #[serde(default)]
        resume_from: u64,
        /// The accept MAC: binds the RECEIVER's DTLS fingerprint and `resume_from`
        /// to the pair, so the sender knows whose connection will answer.
        #[serde(default)]
        auth: Option<String>,
        #[serde(default)]
        auth_v: Option<u8>,
        #[serde(default)]
        fp: Option<String>,
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

    /// Presence (capability `presence`, see `crate::presence`): this
    /// connection's LOCAL activity changed. `None` = active; `Some(n)` =
    /// inactive, and has been for `n` seconds (clamped to a day). Sent only
    /// on a transition, and on every socket once the server has confirmed
    /// the capability with `ServerFeatures` — never to a server that has not
    /// (an older one answers an unknown variant with an Error frame). The
    /// server owns the idle and away clocks; a client never claims either.
    SetActivity {
        #[serde(default)]
        inactive_secs: Option<u32>,
    },

    // --- Games: Poker and Blackjack in a voice call (docs/GAMES.md, *Frames*;
    // the pieces are in crate::games_wire). Sent ONLY on a socket whose server
    // confirmed `games` in ServerFeatures — an older server answers an unknown
    // variant with an Error, which the client shows as an alert. Every frame
    // names the call (`room_id`, `voice_<channel_id>`) and, after the first,
    // the table (`table_id`, from GameTable); a frame naming a table that is
    // not open in that room is answered with GameEnded { reason: "gone" }.
    // Refusals are GameRefused, never Error. Shapes pinned by
    // frontend/src/tests/fixtures/games/client-frames.json.
    //
    // Read by the game handlers (src/games.rs).
    /// Open a table in this call (`PLAY_GAMES` + `CONNECT`). One table per
    /// call: refused with `room_has_table` while one is open. `config`
    /// (optional) sets the opener's stack and stakes; everything else is the
    /// server's.
    GameCreate {
        room_id: String,
        kind: crate::games_wire::GameKindWire,
        #[serde(default)]
        config: Option<crate::games_wire::GameConfigWire>,
    },
    /// Take seat `seat` (0-based; `PLAY_GAMES` + `CONNECT`). The client shows
    /// the disclosure before a person's first sit.
    GameSit { room_id: String, table_id: u64, seat: usize },
    /// Get up from the table (the engine's `leave`): between hands at once;
    /// mid-hand Hold'em folds now and Blackjack stands every hand, and the
    /// seat frees when the hand ends. NOT the Blackjack action `stand`.
    GameStand { room_id: String, table_id: u64 },
    /// Act on the decision `turn` (the `view.turn` the client was shown).
    GameAct {
        room_id: String,
        table_id: u64,
        turn: crate::games_wire::TurnWire,
        action: crate::games_wire::GameActionWire,
    },
    /// Blackjack: bet `amount` on the next round (replaces a bet already
    /// placed; the chips leave the stack now).
    GameBet { room_id: String, table_id: u64, amount: u64 },
    /// Blackjack: take back the bet placed for the next round.
    GameClearBet { room_id: String, table_id: u64 },
    /// Sit out from the next hand / round (keep the seat).
    GameSitOut { room_id: String, table_id: u64 },
    /// Back in after sitting out (also after the clock sat you out).
    GameSitIn { room_id: String, table_id: u64 },
    /// A fresh starting stack for a busted player, if the table allows it.
    GameRebuy { room_id: String, table_id: u64 },
    /// Hold'em, after the hand: table your cards for everyone.
    GameShowCards { room_id: String, table_id: u64 },
    /// Send me the table again (one a second per connection). Sent after
    /// RoomJoined for a call the client still holds a table for, and
    /// whenever the client cannot trust what it holds.
    GameResync { room_id: String, table_id: u64 },
    /// Moderation (`MOVE_MEMBERS`): close the table for everyone.
    GameClose { room_id: String, table_id: u64 },
    /// Moderation (`MOVE_MEMBERS`): get the player in `seat` up from the
    /// table (the engine's `leave`, exactly as if they had stood).
    GameRemovePlayer { room_id: String, table_id: u64, seat: usize },
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

    /// Successfully left a room - or, for a voice room, were taken out of it.
    ///
    /// `reason`/`by` are present ONLY when another device of the same account
    /// ended this connection's call: `reason` is `"moved"` (that device pressed
    /// Move here, or tapped the same channel) or `"left_elsewhere"` (it pressed
    /// Leave), and `by` is the kind of device that did it (`"desktop"`,
    /// `"mobile"`, `"browser"`) when that device said. Absent otherwise, so
    /// the frame stays byte-identical to the one every client already parses;
    /// an old client ignores the two fields and tears down exactly as before.
    RoomLeft {
        room_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        by: Option<String>,
    },

    /// This ACCOUNT's voice state, as THIS connection should see it - so a
    /// phone opened while the PC is in a call can say "You're in Lounge on
    /// your PC" and offer Leave / Move here, on any screen.
    ///
    /// Sent only to connections that announced `?caps=own_voice` on the
    /// WebSocket URL (an old client is never handed a frame it does not
    /// know), and never to a delivery socket: once at connect - which is
    /// also how the client learns this server supports `LeaveOwnVoice` and
    /// `take_over` - and again to every such connection of the account
    /// whenever the account's voice membership changes.
    ///
    /// Every key is always present: `room_id` and the rest are null when the
    /// account is in no voice room. `here` is true when THIS connection is in
    /// it. `device` is the kind of device (`"desktop"`, `"mobile"`,
    /// `"browser"`) of another connection that holds the call, as that
    /// connection reported itself, or null. Names come from the database at
    /// send time; they reach only the account's own devices. The byte shape
    /// is pinned by `frontend/src/tests/fixtures/ownVoiceState.json`.
    OwnVoiceState {
        room_id: Option<String>,
        channel_id: Option<i64>,
        server_id: Option<String>,
        channel_name: Option<String>,
        server_name: Option<String>,
        here: bool,
        device: Option<String>,
    },

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

    /// The server's word on whether `user_id` may SPEAK in voice room
    /// `room_id` (`voice_<channelId>`). Only ever sent for voice rooms.
    ///
    /// The server is the authority: it resolves the member's channel-effective
    /// SPEAK bit (role permissions layered with the channel's overwrites;
    /// ADMINISTRATOR and the server owner imply it) and tells the room. Mesh
    /// voice is peer-to-peer, so the server never touches the audio and cannot
    /// silence anyone itself — before this frame a member denied SPEAK was
    /// heard by everyone. A cooperating client that reads `can_speak: false`
    /// for ITSELF does not transmit; every receiver refuses audio from a member
    /// flagged `false`, which is what holds against a client that ignores its
    /// own flag.
    ///
    /// Who receives it:
    /// - the JOINING connection, right after its `RoomJoined`: one frame for
    ///   EVERY member then in the room, itself included, each with an explicit
    ///   `true`/`false`, so it starts from a complete picture;
    /// - every OTHER occupant: the joiner's frame, since they are the ones who
    ///   must refuse the joiner's audio;
    /// - the WHOLE room, the member included, when a permission change flips
    ///   the right of someone who stays in the room (the perms-change sweep),
    ///   so their own client stops sending as well.
    ///
    /// The byte shape is pinned by
    /// `frontend/src/tests/fixtures/voiceSpeakState.json`, which the client's
    /// tests parse too.
    VoiceSpeakState {
        room_id: String,
        user_id: UserId,
        can_speak: bool,
    },

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

    /// A channel's SETTINGS changed — name, category, slowmode, AFK, checklist
    /// or the voice transport. Clients refetch that server's channel list.
    ///
    /// WHY THIS HAD TO EXIST. `update_channel` changed the row and told nobody:
    /// the only client that learned was the one whose editor made the change,
    /// because it updates its own state locally. Everyone else kept the old
    /// values indefinitely — until an app restart, which is not a thing anyone
    /// knows to do.
    ///
    /// For a rename that is cosmetic. For `sfu_mode` it is not: a client that
    /// still believes a channel is server-routed asks for a LiveKit token, and
    /// `sfu::mint_token` answers 400 "Not an SFU voice channel", so it cannot
    /// rejoin the call at all. Observed on 2026-09-08 when the owner turned SFU
    /// off mid-call and the other participant was locked out of the channel.
    ///
    /// IDS ONLY, never a channel struct. `ChannelInfo` carries no `sfu_mode`
    /// (see `VoiceMoved`), so a client that built its voice panel from one
    /// would negotiate the wrong transport — and a refetch applies the reader's
    /// OWN permissions, which a pushed struct cannot.
    /// SERVER ID ONLY. The client refetches the whole list, so a channel id
    /// buys nothing — and this reaches every member of the server, including
    /// ones who cannot VIEW the channel that changed. Naming it would tell them
    /// a channel they cannot see exists and just moved.
    ChannelUpdated { server_id: String },

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

    /// An online user's status changed: `online`, `idle` (10 minutes with no
    /// activity) or `away` (an hour). Sent ONLY to connections that announced
    /// the `presence` capability (`/ws?caps=presence`) — an older client
    /// keeps getting just UserOnline / UserOffline — to the same audience as
    /// UserOnline plus the user's own devices, and never for a user with
    /// "Show online status" off. A UserOnline means plain `online` until a
    /// UserStatus says otherwise; an unknown status reads as online. Shape
    /// pinned by `frontend/src/tests/fixtures/userStatus.json`.
    UserStatus {
        user_id: UserId,
        status: crate::presence::PresenceStatus,
    },

    /// Sent once, right after connect, ONLY to a connection that announced
    /// capabilities in `/ws?caps=`: the ones this server supports, so the
    /// client knows which new client→server frames it may send on THIS
    /// socket. An older server sends nothing, so a client must assume
    /// nothing until this arrives, per socket. Shape pinned by
    /// `frontend/src/tests/fixtures/serverFeatures.json`.
    ServerFeatures { features: Vec<String> },

    // --- Games (docs/GAMES.md, *Frames*; pieces in crate::games_wire). Sent
    // ONLY to connections that announced `games` in `/ws?caps=` and are in
    // the call (`Room.member_conns`), each with `send_to_conn` — never
    // send_to_user / broadcast_to_room, which would wake a phone in a pocket.
    // Shapes pinned by frontend/src/tests/fixtures/games/*.json. Constructed
    // by the game handlers (src/games.rs).
    /// The whole table as THIS connection may see it (its own hole cards and
    /// nobody else's). Sent when a table opens (to everyone in the call), to
    /// a connection whose RoomJoined put it in a call that has a table, in
    /// answer to GameResync, and to everyone when the table changed without
    /// an engine event (a seat's `away`, a deal countdown). `version` is the
    /// version of the state `view` shows.
    GameTable {
        room_id: String,
        table_id: u64,
        version: u64,
        view: crate::games_wire::GameView,
    },
    /// One engine call's public events (identical for everyone), and the
    /// view AFTER them for this connection. `version` is exactly one more
    /// than the version before the call.
    GameEvents {
        room_id: String,
        table_id: u64,
        version: u64,
        events: crate::games_wire::GameEventsWire,
        view: crate::games_wire::GameView,
    },
    /// The table is gone; drop it and say why. Also the answer to any frame
    /// naming a table that is not open in that room (`gone`).
    GameEnded {
        room_id: String,
        table_id: u64,
        reason: crate::games_wire::GameEndReason,
    },
    /// A game frame from THIS connection was refused: `op` names which,
    /// `code` (flattened in, with any numbers it carries) says why.
    /// `room_id` / `table_id` echo the refused frame's (`table_id` is `null`
    /// for a refused GameCreate). Never sent to anyone else, and never as an
    /// Error.
    GameRefused {
        room_id: String,
        table_id: Option<u64>,
        op: crate::games_wire::GameOp,
        #[serde(flatten)]
        refusal: crate::games_wire::GameRefusal,
    },

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
        #[serde(default)]
        auth_v: Option<u8>,
        #[serde(default)]
        fp: Option<String>,
        #[serde(default)]
        ts: Option<u64>,
    },

    /// The recipient accepted; start negotiating and sending from `resume_from`.
    FileAccepted {
        from_user: UserId,
        transfer_id: String,
        resume_from: u64,
        #[serde(default)]
        auth: Option<String>,
        #[serde(default)]
        auth_v: Option<u8>,
        #[serde(default)]
        fp: Option<String>,
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
        const CONSENT_BODY: &str = "Open Púca to approve or decline";

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

#[cfg(test)]
mod voice_speak_state_tests {
    use super::*;

    /// The server and the client are pinned to ONE file: the client's tests
    /// parse the same fixture this compares against, so a rename of the frame
    /// or of a payload key on either side goes red on that side.
    ///
    /// `user_id` is `UserId` = i64 here and a JS number there; serde_json
    /// stores a non-negative i64 and a parsed `7` alike (an unsigned integer),
    /// so the equality below is exact and would fail on `7.0` or `"7"`.
    #[test]
    fn the_voice_speak_state_frame_is_the_fixture_the_client_parses() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../frontend/src/tests/fixtures/voiceSpeakState.json"
        ))
        .expect("the fixture is JSON");
        let ours = serde_json::to_value(ServerMessage::VoiceSpeakState {
            room_id: "voice_42".into(),
            user_id: 7,
            can_speak: false,
        })
        .unwrap();
        assert_eq!(ours, fixture);

        // Not vacuous: the fixture really says what this test claims it says,
        // and a frame that differs only in the flag does NOT equal it.
        assert_eq!(fixture["type"], "VoiceSpeakState");
        assert_eq!(fixture["payload"]["user_id"].as_i64(), Some(7), "an integer, not 7.0 or \"7\"");
        assert_eq!(fixture["payload"]["can_speak"], false);
        let flipped = serde_json::to_value(ServerMessage::VoiceSpeakState {
            room_id: "voice_42".into(),
            user_id: 7,
            can_speak: true,
        })
        .unwrap();
        assert_ne!(flipped, fixture);

        // The number survives a text round trip the way the socket carries it.
        let text = serde_json::to_string(&ServerMessage::VoiceSpeakState {
            room_id: "voice_42".into(),
            user_id: 2_147_483_647,
            can_speak: true,
        })
        .unwrap();
        let back: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(back["payload"]["user_id"].as_i64(), Some(2_147_483_647));
    }
}

#[cfg(test)]
mod own_voice_wire_tests {
    use super::*;

    /// One file pins the server and the client: `ownVoiceState.json` holds the
    /// "your call is on another device" frame in both its shapes, and the two
    /// RoomLeft shapes - the one a displaced device is sent (with why, and by
    /// which kind of device) and the plain one, which must stay byte-identical
    /// to the frame every client already parses. The client's tests read the
    /// same file (`ownVoice.test.ts`).
    #[test]
    fn the_own_voice_frames_are_the_fixture_the_client_parses() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../frontend/src/tests/fixtures/ownVoiceState.json"))
                .expect("the fixture is JSON");
        let elsewhere = serde_json::to_value(ServerMessage::OwnVoiceState {
            room_id: Some("voice_42".into()),
            channel_id: Some(42),
            server_id: Some("5f1d2c3e-0000-4000-8000-000000000042".into()),
            channel_name: Some("Lounge".into()),
            server_name: Some("Friends".into()),
            here: false,
            device: Some("desktop".into()),
        })
        .unwrap();
        let none = serde_json::to_value(ServerMessage::OwnVoiceState {
            room_id: None,
            channel_id: None,
            server_id: None,
            channel_name: None,
            server_name: None,
            here: false,
            device: None,
        })
        .unwrap();
        let displaced = serde_json::to_value(ServerMessage::RoomLeft {
            room_id: "voice_42".into(),
            reason: Some("moved".into()),
            by: Some("mobile".into()),
        })
        .unwrap();
        let plain = serde_json::to_value(ServerMessage::RoomLeft { room_id: "voice_42".into(), reason: None, by: None }).unwrap();
        assert_eq!(fixture[0], elsewhere);
        assert_eq!(fixture[1], none, "every key present, as null: one shape for the client to read");
        assert_eq!(fixture[2], displaced);
        assert_eq!(fixture[3], plain);
        // The plain RoomLeft is EXACTLY the pre-feature bytes.
        assert_eq!(
            serde_json::to_string(&ServerMessage::RoomLeft { room_id: "voice_42".into(), reason: None, by: None }).unwrap(),
            r#"{"type":"RoomLeft","payload":{"room_id":"voice_42"}}"#
        );
        // Not vacuous: `here` and the channel id really are what the fixture says.
        assert_eq!(fixture[0]["payload"]["here"], false);
        assert_eq!(fixture[0]["payload"]["channel_id"].as_i64(), Some(42));
        let here = serde_json::to_value(ServerMessage::OwnVoiceState {
            room_id: Some("voice_42".into()),
            channel_id: Some(42),
            server_id: Some("5f1d2c3e-0000-4000-8000-000000000042".into()),
            channel_name: Some("Lounge".into()),
            server_name: Some("Friends".into()),
            here: true,
            device: Some("desktop".into()),
        })
        .unwrap();
        assert_ne!(here, fixture[0]);
    }

    /// Old servers ignored unknown JoinRoom fields; THIS server reads the two
    /// new ones and defaults both to false, so every client that predates them
    /// keeps today's join.
    #[test]
    fn join_room_reads_take_over_and_replay_and_defaults_them_off() {
        let old: ClientMessage = serde_json::from_str(r#"{"type":"JoinRoom","payload":{"room_id":"voice_1"}}"#).unwrap();
        assert!(matches!(old, ClientMessage::JoinRoom { take_over: false, replay: false, .. }));
        let new: ClientMessage =
            serde_json::from_str(r#"{"type":"JoinRoom","payload":{"room_id":"voice_1","take_over":true,"replay":true}}"#).unwrap();
        assert!(matches!(new, ClientMessage::JoinRoom { take_over: true, replay: true, .. }));
        let leave: ClientMessage = serde_json::from_str(r#"{"type":"LeaveOwnVoice","payload":{"room_id":"voice_1"}}"#).unwrap();
        assert!(matches!(leave, ClientMessage::LeaveOwnVoice { ref room_id } if room_id == "voice_1"));
    }
}

#[cfg(test)]
mod presence_frame_tests {
    use super::*;
    use crate::presence::PresenceStatus;

    /// The server and the client are pinned to ONE file each, as with
    /// VoiceSpeakState: the client's tests parse the same fixtures.
    #[test]
    fn user_status_is_the_fixture_the_client_parses() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../frontend/src/tests/fixtures/userStatus.json")).expect("JSON");
        let ours = serde_json::to_value(ServerMessage::UserStatus { user_id: 7, status: PresenceStatus::Idle }).unwrap();
        assert_eq!(ours, fixture);
        // Not vacuous: another status is a different frame, and each status
        // has the lowercase wire name the client switches on.
        let away = serde_json::to_value(ServerMessage::UserStatus { user_id: 7, status: PresenceStatus::Away }).unwrap();
        assert_ne!(away, fixture);
        assert_eq!(away["payload"]["status"], "away");
        let online = serde_json::to_value(ServerMessage::UserStatus { user_id: 7, status: PresenceStatus::Online }).unwrap();
        assert_eq!(online["payload"]["status"], "online");
    }

    #[test]
    fn server_features_is_the_fixture_the_client_parses() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../frontend/src/tests/fixtures/serverFeatures.json")).expect("JSON");
        let ours = serde_json::to_value(ServerMessage::ServerFeatures { features: vec!["presence".into()] }).unwrap();
        assert_eq!(ours, fixture);
        assert_ne!(serde_json::to_value(ServerMessage::ServerFeatures { features: vec![] }).unwrap(), fixture);
    }

    #[test]
    fn set_activity_parses_the_client_shapes() {
        let idle: ClientMessage =
            serde_json::from_str(r#"{"type":"SetActivity","payload":{"inactive_secs":700}}"#).unwrap();
        assert!(matches!(idle, ClientMessage::SetActivity { inactive_secs: Some(700) }));
        let active: ClientMessage =
            serde_json::from_str(r#"{"type":"SetActivity","payload":{"inactive_secs":null}}"#).unwrap();
        assert!(matches!(active, ClientMessage::SetActivity { inactive_secs: None }));
        // A negative or fractional number is refused, not wrapped.
        assert!(serde_json::from_str::<ClientMessage>(r#"{"type":"SetActivity","payload":{"inactive_secs":-1}}"#).is_err());
        assert!(serde_json::from_str::<ClientMessage>(r#"{"type":"SetActivity","payload":{"inactive_secs":1.5}}"#).is_err());
    }
}

/// The games wire contract (docs/GAMES.md, *Frames*), pinned to the files the
/// client's tests read too (`frontend/src/tests/fixtures/games/*.json`,
/// `frontend/src/tests/gamesProtocol.test.ts`): one example of every frame.
///
/// The table fixtures are NOT hand-written: they are what a real engine table
/// dealt from a fixed seed serialises to, so they show exactly what the
/// server half will send, cards included. `PUCA_WRITE_GAME_FIXTURES=1 cargo
/// test games_frame_tests` rewrites them after a deliberate contract change;
/// the client's tests then say what that change broke.
#[cfg(test)]
mod games_frame_tests {
    use super::*;
    use crate::games_wire::*;
    use puca_games::blackjack::{BlackjackConfig, BlackjackTable};
    use puca_games::holdem::{Action, Event, HoldemConfig, HoldemTable, Street};
    use puca_games::rng::seeded;
    use serde_json::{json, Value};
    use std::collections::BTreeSet;

    const DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/frontend/src/tests/fixtures/games/");
    const ROOM: &str = "voice_42";
    /// 2^52 + 1: well above 2^32 (a client storing it in an int32 breaks) and
    /// still exact in a JavaScript number.
    const TABLE: u64 = 4_503_599_627_370_497;
    /// Seeds chosen so the hands exercise what the fixtures must show: a
    /// Hold'em check-down whose showdown both shows and mucks a hand, and a
    /// Blackjack round the dealer's peek does not end at once.
    const HOLDEM_SEED: u64 = 1;
    const BLACKJACK_SEED: u64 = 3;

    fn pin(name: &str, ours: &Value) {
        let path = format!("{DIR}{name}");
        if std::env::var_os("PUCA_WRITE_GAME_FIXTURES").is_some() {
            std::fs::create_dir_all(DIR).expect("fixture dir");
            std::fs::write(&path, serde_json::to_string_pretty(ours).expect("JSON") + "\n").expect("write fixture");
        }
        let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
        let fixture: Value = serde_json::from_str(&text).expect("the fixture is JSON");
        assert_eq!(&fixture, ours, "{name} is not what the server sends");
    }

    fn fixture(name: &str) -> Value {
        let path = format!("{DIR}{name}");
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"))).expect("JSON")
    }

    fn to_value(m: ServerMessage) -> Value {
        serde_json::to_value(m).expect("serialises")
    }

    fn table_frame(version: u64, view: GameView) -> Value {
        to_value(ServerMessage::GameTable { room_id: ROOM.into(), table_id: TABLE, version, view })
    }

    fn events_frame(version: u64, events: GameEventsWire, view: GameView) -> Value {
        to_value(ServerMessage::GameEvents { room_id: ROOM.into(), table_id: TABLE, version, events, view })
    }

    /// Every two-character card code in a JSON value (`"??"` excluded).
    fn cards_in(v: &Value, out: &mut BTreeSet<String>) {
        match v {
            Value::String(s) if puca_games::Card::parse(s).is_some() => {
                out.insert(s.clone());
            }
            Value::Array(a) => a.iter().for_each(|x| cards_in(x, out)),
            Value::Object(o) => o.values().for_each(|x| cards_in(x, out)),
            _ => {}
        }
    }

    fn card_set(v: &Value) -> BTreeSet<String> {
        let mut s = BTreeSet::new();
        cards_in(v, &mut s);
        s
    }

    // -- Hold'em: three players check a hand down from a fixed seed.

    struct HoldemRun {
        /// Engine call by engine call: (version, events frame for seat 0,
        /// events frame for a spectator).
        frames: Vec<(u64, Value, Value)>,
        /// GameTable at the start of the flop for the seat to act, and for a
        /// spectator, at the same version.
        flop_seated: Value,
        flop_spectator: Value,
        flop_viewer: usize,
        /// The showdown: who showed, who mucked and what the mucked hands were.
        shown: Vec<usize>,
        mucked: Vec<(usize, Vec<String>)>,
        board: Vec<String>,
    }

    fn holdem_run(seed: u64) -> HoldemRun {
        let mut t = HoldemTable::new(HoldemConfig::default()).expect("default config");
        let mut version = 1; // 1 = the table as it opened
        let mut frames = Vec::new();
        let none = ViewExtras::default();
        let mut push = |t: &HoldemTable, ev: Vec<Event>, extras: &ViewExtras, frames: &mut Vec<(u64, Value, Value)>| {
            assert!(!ev.is_empty(), "every engine call here changes the table");
            version += 1;
            frames.push((
                version,
                events_frame(version, holdem_events(&ev), holdem_view(&t.view_for(Some(0)), extras)),
                events_frame(version, holdem_events(&ev), holdem_view(&t.view_for(None), extras)),
            ));
            version
        };
        for (seat, user) in [(0, 7), (2, 8), (4, 9)] {
            let ev = t.sit(seat, player_id(user)).expect("sit");
            push(&t, ev, &none, &mut frames);
        }
        let ev = t.start_hand(&mut seeded(seed)).expect("deal");
        push(&t, ev, &none, &mut frames);
        let mut flop = None;
        let mut showdown = None;
        while t.hand_in_progress() {
            let seat = t.to_act().expect("a decision is awaited");
            let legal = t.legal_actions(seat).expect("legal");
            let action = if legal.can_check { Action::Check } else { Action::Call };
            let ev = t.act(seat, t.turn().expect("turn"), action).expect("act");
            let ends_hand = ev.iter().any(|e| matches!(e, Event::HandEnded { .. }));
            let extras = if ends_hand { ViewExtras { next_deal_in_ms: Some(3_000), ..Default::default() } } else { none.clone() };
            if let Some(Event::Showdown { shown, mucked }) = ev.iter().find(|e| matches!(e, Event::Showdown { .. })) {
                showdown = Some((shown.iter().map(|h| h.seat).collect::<Vec<_>>(), mucked.clone()));
            }
            let v = push(&t, ev, &extras, &mut frames);
            if flop.is_none() && t.view_for(None).street == Some(Street::Flop) {
                let viewer = t.to_act().expect("someone acts first on the flop");
                let x = ViewExtras { away: vec![4], clock_ms: Some(27_500), next_deal_in_ms: None };
                flop = Some((
                    table_frame(v, holdem_view(&t.view_for(Some(viewer)), &x)),
                    table_frame(v, holdem_view(&t.view_for(None), &x)),
                    viewer,
                ));
            }
        }
        let (shown, mucked_seats) = showdown.expect("the hand was checked down to a showdown");
        // The mucked hands, as only their owners ever saw them.
        let mucked = mucked_seats
            .iter()
            .map(|&s| (s, t.view_for(Some(s)).my_cards.expect("own cards").iter().map(|c| c.to_string()).collect()))
            .collect();
        let board = t.view_for(None).board.iter().map(|c| c.to_string()).collect();
        let (flop_seated, flop_spectator, flop_viewer) = flop.expect("the hand saw a flop");
        // After the hand, a player who mucked tables their cards anyway.
        if let Some(&s) = mucked_seats.first() {
            let ev = t.show_cards(s).expect("a mucked hand may be shown after the hand");
            push(&t, ev, &none, &mut frames);
        }
        HoldemRun { frames, flop_seated, flop_spectator, flop_viewer, shown, mucked, board }
    }

    /// The frames the fixture keeps: a sit, the deal, the flop, the showdown
    /// and a voluntary show â€” every Hold'em event type but the rare ones
    /// (sat out, rebought, uncalled returned), which the client's tests
    /// cover from hand-written frames.
    fn holdem_fixture_frames(run: &HoldemRun) -> Vec<Value> {
        let has = |f: &Value, ty: &str| f["payload"]["events"].as_array().unwrap().iter().any(|e| e["type"] == ty);
        let pick = |ty: &str| run.frames.iter().find(|(_, f, _)| has(f, ty)).unwrap_or_else(|| panic!("no {ty}")).1.clone();
        vec![pick("player_sat"), pick("hand_started"), pick("board_dealt"), pick("showdown"), pick("shown")]
    }

    #[test]
    fn holdem_tables_are_the_fixtures_the_client_parses() {
        let run = holdem_run(HOLDEM_SEED);
        pin("holdem-table-seated.json", &run.flop_seated);
        pin("holdem-table-spectator.json", &run.flop_spectator);
        pin("holdem-events.json", &Value::Array(holdem_fixture_frames(&run)));

        // Not vacuous: the seated view really has the viewer's own two cards,
        // its turn and what it may do; the spectator's has none of those.
        let me = &run.flop_seated["payload"]["view"];
        assert_eq!(me["game"], "holdem");
        assert_eq!(me["viewer_seat"], run.flop_viewer);
        let mine = &me["seats"][run.flop_viewer]["cards"];
        assert_eq!(mine.as_array().map(Vec::len), Some(2));
        assert!(mine.as_array().unwrap().iter().all(|c| puca_games::Card::parse(c.as_str().unwrap()).is_some()), "{mine}");
        assert!(me["legal"].is_object() && me["turn"].is_object());
        assert_eq!(me["board"].as_array().map(Vec::len), Some(3));
        let spec = &run.flop_spectator["payload"]["view"];
        assert_eq!(spec["viewer_seat"], Value::Null);
        assert_eq!(spec["legal"], Value::Null);
        assert_eq!(spec["seats"][run.flop_viewer]["cards"], json!(["??", "??"]));
        assert_eq!(spec["seats"][4]["away"], true);
        assert_eq!(spec["seats"][1], Value::Null, "an empty seat is null");
        // Everyone else's cards are face down in the seated view too.
        for s in [0, 2, 4].into_iter().filter(|&s| s != run.flop_viewer) {
            assert_eq!(me["seats"][s]["cards"], json!(["??", "??"]), "seat {s}");
        }
        // The showdown both showed and mucked, so the fixture shows both.
        assert!(!run.shown.is_empty() && !run.mucked.is_empty(), "seed {HOLDEM_SEED}: shown {:?} mucked {:?}", run.shown, run.mucked);
    }

    /// The privacy promise, on the wire: a SPECTATOR's frames never hold a
    /// card but the board and the hands shown at showdown; a seated player's
    /// add only their own. Checked on every frame of the hand, not just the
    /// fixtures. (The engine proves its views; this proves the translation
    /// added nothing to them.)
    #[test]
    fn a_spectator_never_sees_a_card_but_the_board_and_shown_hands() {
        let run = holdem_run(HOLDEM_SEED);
        let board: BTreeSet<String> = run.board.iter().cloned().collect();
        let showdown = run
            .frames
            .iter()
            .find_map(|(_, _, spec)| {
                spec["payload"]["events"].as_array().unwrap().iter().find(|e| e["type"] == "showdown").cloned()
            })
            .expect("a showdown");
        let shown = card_set(&showdown["shown"]);
        assert_eq!(shown.len(), 2 * run.shown.len());
        let allowed: BTreeSet<String> = board.union(&shown).cloned().collect();
        // The flop snapshot: the board, nothing else.
        assert_eq!(card_set(&run.flop_spectator), card_set(&run.flop_spectator["payload"]["view"]["board"]));
        assert_eq!(card_set(&run.flop_spectator).len(), 3);
        // Every spectator frame up to the voluntary show.
        let mucked_cards: BTreeSet<String> = run.mucked.iter().flat_map(|(_, c)| c.iter().cloned()).collect();
        assert!(!run.mucked.is_empty(), "seed {HOLDEM_SEED} mucked nothing: this test would prove nothing about mucks");
        assert_eq!(mucked_cards.len(), 2 * run.mucked.len());
        let before_show = run.frames.len() - 1;
        for (v, _, spec) in &run.frames[..before_show] {
            let seen = card_set(spec);
            assert!(seen.is_subset(&allowed), "v{v}: {:?} beyond board+shown", seen.difference(&allowed).collect::<Vec<_>>());
            assert!(seen.is_disjoint(&mucked_cards), "v{v}: a mucked hand leaked");
        }
        // Seat 0's frames add exactly seat 0's own cards (once dealt).
        let own: BTreeSet<String> = card_set(&run.frames[3].1["payload"]["view"]["seats"][0]["cards"]);
        assert_eq!(own.len(), 2, "seat 0 sees its own hand after the deal");
        let allowed_0: BTreeSet<String> = allowed.union(&own).cloned().collect();
        for (v, mine, _) in &run.frames[..before_show] {
            let seen = card_set(mine);
            assert!(seen.is_subset(&allowed_0), "v{v}: {:?}", seen.difference(&allowed_0).collect::<Vec<_>>());
        }
        // The voluntary show is the ONE place a mucked hand appears.
        let (_, _, last) = run.frames.last().unwrap();
        assert!(!card_set(last).is_disjoint(&mucked_cards));
    }

    /// Versions: 1 when the table opens, then exactly one more per engine
    /// call, the same number in every connection's frame for that call.
    #[test]
    fn versions_count_one_per_change_and_agree_across_viewers() {
        let run = holdem_run(HOLDEM_SEED);
        for (i, (v, mine, spec)) in run.frames.iter().enumerate() {
            assert_eq!(*v, i as u64 + 2);
            assert_eq!(mine["payload"]["version"], *v);
            assert_eq!(spec["payload"]["version"], *v);
            assert_eq!(mine["payload"]["events"], spec["payload"]["events"], "events are public: one list for everyone");
        }
    }

    // -- Blackjack: two players, one round, from a fixed seed.

    struct BlackjackRun {
        frames: Vec<(u64, Value)>,
        dealt_table: Value,
        hole: String,
    }

    fn blackjack_run(seed: u64) -> BlackjackRun {
        let mut rng = seeded(seed);
        let mut t = BlackjackTable::new(BlackjackConfig::default()).expect("default config");
        let mut version = 1;
        let mut frames = Vec::new();
        let mut push = |t: &BlackjackTable, ev: Vec<puca_games::blackjack::BjEvent>, x: &ViewExtras, frames: &mut Vec<(u64, Value)>| {
            assert!(!ev.is_empty());
            version += 1;
            frames.push((version, events_frame(version, blackjack_events(&ev), blackjack_view(&t.view(), Some(0), x))));
            version
        };
        let none = ViewExtras::default();
        for (seat, user) in [(0, 7), (1, 8)] {
            let ev = t.sit(seat, player_id(user)).expect("sit");
            push(&t, ev, &none, &mut frames);
        }
        let countdown = ViewExtras { next_deal_in_ms: Some(15_000), ..Default::default() };
        let ev = t.place_bet(0, 50).expect("bet");
        push(&t, ev, &countdown, &mut frames);
        let ev = t.place_bet(1, 100).expect("bet");
        push(&t, ev, &countdown, &mut frames);
        let ev = t.deal(&mut rng).expect("deal");
        let v = push(&t, ev, &none, &mut frames);
        assert!(t.round_in_progress(), "seed {seed}: the peek ended the round; pick another seed");
        let (to_act, _) = t.to_act().expect("a player acts");
        let dealt_table = table_frame(
            v,
            blackjack_view(&t.view(), Some(to_act), &ViewExtras { clock_ms: Some(30_000), ..Default::default() }),
        );
        while t.round_in_progress() {
            let (seat, hand) = t.to_act().expect("to act");
            let total = t.view().seats[seat].as_ref().unwrap().hands[hand].total;
            let action = if total < 17 { GameActionWire::Hit } else { GameActionWire::Stand };
            let ev = t.act(seat, t.turn().unwrap(), action.blackjack().unwrap(), &mut rng).expect("act");
            push(&t, ev, &none, &mut frames);
        }
        let hole = frames
            .iter()
            .find_map(|(_, f)| {
                f["payload"]["events"].as_array().unwrap().iter().find(|e| e["type"] == "dealer_revealed").map(|e| e["card"].as_str().unwrap().to_string())
            })
            .expect("the dealer turned the hole card");
        BlackjackRun { frames, dealt_table, hole }
    }

    fn blackjack_fixture_frames(run: &BlackjackRun) -> Vec<Value> {
        let has = |f: &Value, ty: &str| f["payload"]["events"].as_array().unwrap().iter().any(|e| e["type"] == ty);
        let pick = |ty: &str| run.frames.iter().find(|(_, f)| has(f, ty)).unwrap_or_else(|| panic!("no {ty}")).1.clone();
        vec![pick("bet_placed"), pick("round_started"), pick("acted"), pick("round_ended")]
    }

    #[test]
    fn blackjack_tables_are_the_fixtures_the_client_parses() {
        let run = blackjack_run(BLACKJACK_SEED);
        pin("blackjack-table.json", &run.dealt_table);
        pin("blackjack-events.json", &Value::Array(blackjack_fixture_frames(&run)));

        let view = &run.dealt_table["payload"]["view"];
        assert_eq!(view["game"], "blackjack");
        // The hole card is face down, and the frame does not hold it anywhere.
        assert_eq!(view["dealer"][1], "??");
        assert_eq!(view["dealer_total"], Value::Null);
        assert!(!card_set(&run.dealt_table).contains(&run.hole), "the hole card {} leaked", run.hole);
        // The player to act sees what they may do; it is their view.
        assert_eq!(view["viewer_seat"], view["to_act"]["seat"]);
        assert!(view["legal"].is_object());
        // Nor is it in any frame before the dealer turns it: the deal sends
        // it as "??".
        let deal = &run.frames.iter().find(|(_, f)| f["payload"]["events"].as_array().unwrap().iter().any(|e| e["type"] == "round_started")).unwrap().1;
        assert!(deal["payload"]["events"].as_array().unwrap().iter().any(|e| e["type"] == "card_dealt" && e["seat"].is_null() && e["card"] == "??"));
        for (v, f) in &run.frames {
            let revealed = f["payload"]["events"].as_array().unwrap().iter().any(|e| e["type"] == "dealer_revealed");
            if revealed {
                break;
            }
            assert!(!card_set(f).contains(&run.hole), "v{v}: the hole card leaked before the reveal");
        }
    }

    /// A Blackjack view shows `legal` only to the seat whose turn it is.
    #[test]
    fn blackjack_legal_goes_only_to_the_player_to_act() {
        let run = blackjack_run(BLACKJACK_SEED);
        let to_act = run.dealt_table["payload"]["view"]["to_act"]["seat"].as_u64().unwrap() as usize;
        let mut t = BlackjackTable::new(BlackjackConfig::default()).unwrap();
        let mut rng = seeded(BLACKJACK_SEED);
        t.sit(0, player_id(7)).unwrap();
        t.sit(1, player_id(8)).unwrap();
        t.place_bet(0, 50).unwrap();
        t.place_bet(1, 100).unwrap();
        t.deal(&mut rng).unwrap();
        let x = ViewExtras::default();
        let get = |viewer| serde_json::to_value(blackjack_view(&t.view(), viewer, &x)).unwrap()["legal"].clone();
        assert!(get(Some(to_act)).is_object());
        assert_eq!(get(Some(1 - to_act)), Value::Null);
        assert_eq!(get(None), Value::Null);
    }

    // -- Refusals and endings: one of each, every code.

    /// Index of every refusal; a new variant fails to compile here until it
    /// gets an example below (and so a line in the fixture).
    fn refusal_index(r: &GameRefusal) -> usize {
        use GameRefusal::*;
        match r {
            Disabled => 0,
            NoPermission => 1,
            NotInCall => 2,
            NotAVoiceRoom => 3,
            RoomHasTable { .. } => 4,
            TooManyTables => 5,
            RateLimited => 6,
            WrongGame => 7,
            NotSeated => 8,
            InvalidConfig => 9,
            ConfigLocked => 10,
            SeatOutOfRange => 11,
            SeatTaken => 12,
            SeatEmpty => 13,
            AlreadySeated => 14,
            NotYourTurn => 15,
            StaleTurn => 16,
            NoChips => 17,
            NotBusted => 18,
            RebuyNotAllowed => 19,
            BetBelowMinimum { .. } => 20,
            HandInProgress => 21,
            NoHandInProgress => 22,
            NotEnoughPlayers => 23,
            CannotCheck { .. } => 24,
            NothingToCall => 25,
            BetAboveStack { .. } => 26,
            RaiseNotReopened => 27,
            NobodyToRaise => 28,
            NotShowable => 29,
            RoundInProgress => 30,
            NoRoundInProgress => 31,
            NoBets => 32,
            BetAboveMaximum { .. } => 33,
            InsufficientChips { .. } => 34,
            SittingOut => 35,
            CannotHit => 36,
            CannotDouble => 37,
            CannotSplit => 38,
        }
    }
    const REFUSALS: usize = 39;

    /// (op, table_id, refusal): every code once, each with the frame it
    /// would plausibly answer.
    fn every_refusal() -> Vec<(GameOp, Option<u64>, GameRefusal)> {
        use GameOp as O;
        use GameRefusal::*;
        let t = Some(TABLE);
        vec![
            (O::Create, None, Disabled),
            (O::Close, t, NoPermission),
            (O::SitOut, t, NotInCall),
            (O::Create, None, NotAVoiceRoom),
            (O::Create, None, RoomHasTable { open_table_id: TABLE, kind: GameKindWire::Holdem }),
            (O::Create, None, TooManyTables),
            (O::Resync, t, RateLimited),
            (O::Bet, t, WrongGame),
            (O::Stand, t, NotSeated),
            (O::Create, None, InvalidConfig),
            (O::Create, None, ConfigLocked),
            (O::Sit, t, SeatOutOfRange),
            (O::Sit, t, SeatTaken),
            (O::RemovePlayer, t, SeatEmpty),
            (O::Sit, t, AlreadySeated),
            (O::Act, t, NotYourTurn),
            (O::Act, t, StaleTurn),
            (O::SitIn, t, NoChips),
            (O::Rebuy, t, NotBusted),
            (O::Rebuy, t, RebuyNotAllowed),
            (O::Act, t, BetBelowMinimum { min: 40 }),
            (O::ShowCards, t, HandInProgress),
            (O::Act, t, NoHandInProgress),
            (O::Act, t, NotEnoughPlayers),
            (O::Act, t, CannotCheck { to_call: 10 }),
            (O::Act, t, NothingToCall),
            (O::Act, t, BetAboveStack { max: 990 }),
            (O::Act, t, RaiseNotReopened),
            (O::Act, t, NobodyToRaise),
            (O::ShowCards, t, NotShowable),
            (O::ClearBet, t, RoundInProgress),
            (O::Act, t, NoRoundInProgress),
            (O::Act, t, NoBets),
            (O::Bet, t, BetAboveMaximum { max: 500 }),
            (O::Bet, t, InsufficientChips { stack: 35 }),
            (O::Bet, t, SittingOut),
            (O::Act, t, CannotHit),
            (O::Act, t, CannotDouble),
            (O::Act, t, CannotSplit),
        ]
    }

    #[test]
    fn every_refusal_is_the_fixture_the_client_parses() {
        let all = every_refusal();
        let mut seen = vec![false; REFUSALS];
        for (_, _, r) in &all {
            assert!(!std::mem::replace(&mut seen[refusal_index(r)], true), "{r:?} twice");
        }
        assert!(seen.iter().all(|&s| s), "a refusal code has no example");
        let frames: Vec<Value> = all
            .into_iter()
            .map(|(op, table_id, refusal)| to_value(ServerMessage::GameRefused { room_id: ROOM.into(), table_id, op, refusal }))
            .collect();
        pin("refusals.json", &Value::Array(frames.clone()));
        // The shape the client switches on: flat, `code` beside the numbers,
        // never a message.
        assert_eq!(
            frames[4],
            json!({"type": "GameRefused", "payload": {"room_id": "voice_42", "table_id": null, "op": "create",
                   "code": "room_has_table", "open_table_id": TABLE, "kind": "holdem"}})
        );
        assert_eq!(frames[20]["payload"]["code"], "bet_below_minimum");
        assert_eq!(frames[20]["payload"]["min"], 40);
        for f in &frames {
            assert!(f["payload"].get("message").is_none(), "no free text: {f}");
        }
        // And every op appears, so the client's parser is pinned on each.
        let ops: BTreeSet<String> = frames.iter().map(|f| f["payload"]["op"].as_str().unwrap().to_string()).collect();
        assert_eq!(ops.len(), 13, "{ops:?}");
    }

    fn end_index(r: GameEndReason) -> usize {
        match r {
            GameEndReason::Closed => 0,
            GameEndReason::CallEnded => 1,
            GameEndReason::Idle => 2,
            GameEndReason::Disabled => 3,
            GameEndReason::ChannelDeleted => 4,
            GameEndReason::Gone => 5,
        }
    }

    #[test]
    fn every_end_reason_is_the_fixture_the_client_parses() {
        let all = [
            GameEndReason::Closed,
            GameEndReason::CallEnded,
            GameEndReason::Idle,
            GameEndReason::Disabled,
            GameEndReason::ChannelDeleted,
            GameEndReason::Gone,
        ];
        assert_eq!(all.iter().map(|&r| end_index(r)).collect::<Vec<_>>(), (0..6).collect::<Vec<_>>());
        let frames: Vec<Value> = all
            .iter()
            .map(|&reason| to_value(ServerMessage::GameEnded { room_id: ROOM.into(), table_id: TABLE, reason }))
            .collect();
        pin("ended.json", &Value::Array(frames.clone()));
        assert_eq!(frames[5], json!({"type": "GameEnded", "payload": {"room_id": "voice_42", "table_id": TABLE, "reason": "gone"}}));
    }

    // -- Client frames: the client's builders produce client-frames.json
    // (gamesProtocol.test.ts); here every entry must parse into the frame
    // it claims to be.

    #[test]
    fn every_client_frame_in_the_fixture_parses_as_itself() {
        use crate::games_wire::GameActionWire as A;
        let fx = fixture("client-frames.json");
        let frames = fx.as_array().expect("an array");
        let room = || ROOM.to_string();
        let turn = TurnWire { hand_no: 3, turn_seq: 7 };
        let act = |action| ClientMessage::GameAct { room_id: room(), table_id: TABLE, turn, action };
        let expected = vec![
            ClientMessage::GameCreate {
                room_id: room(),
                kind: GameKindWire::Holdem,
                config: Some(GameConfigWire { starting_stack: Some(1_000), small_blind: Some(5), big_blind: Some(10), ..Default::default() }),
            },
            ClientMessage::GameCreate {
                room_id: room(),
                kind: GameKindWire::Blackjack,
                config: Some(GameConfigWire { starting_stack: Some(1_000), min_bet: Some(10), max_bet: Some(500), ..Default::default() }),
            },
            ClientMessage::GameCreate { room_id: room(), kind: GameKindWire::Holdem, config: Some(GameConfigWire::default()) },
            ClientMessage::GameSit { room_id: room(), table_id: TABLE, seat: 2 },
            ClientMessage::GameStand { room_id: room(), table_id: TABLE },
            act(A::Fold),
            act(A::Check),
            act(A::Call),
            act(A::BetOrRaiseTo { amount: 60 }),
            act(A::AllIn),
            act(A::Hit),
            act(A::Stand),
            act(A::Double),
            act(A::Split),
            ClientMessage::GameBet { room_id: room(), table_id: TABLE, amount: 50 },
            ClientMessage::GameClearBet { room_id: room(), table_id: TABLE },
            ClientMessage::GameSitOut { room_id: room(), table_id: TABLE },
            ClientMessage::GameSitIn { room_id: room(), table_id: TABLE },
            ClientMessage::GameRebuy { room_id: room(), table_id: TABLE },
            ClientMessage::GameShowCards { room_id: room(), table_id: TABLE },
            ClientMessage::GameResync { room_id: room(), table_id: TABLE },
            ClientMessage::GameClose { room_id: room(), table_id: TABLE },
            ClientMessage::GameRemovePlayer { room_id: room(), table_id: TABLE, seat: 4 },
        ];
        assert_eq!(frames.len(), expected.len(), "one fixture entry per expected frame");
        for (i, (f, want)) in frames.iter().zip(&expected).enumerate() {
            let got: ClientMessage = serde_json::from_value(f.clone()).unwrap_or_else(|e| panic!("#{i} {f}: {e}"));
            assert_eq!(format!("{got:?}"), format!("{want:?}"), "#{i}");
        }
        // Every Game* client variant is in the fixture.
        let types: BTreeSet<&str> = frames.iter().map(|f| f["type"].as_str().unwrap()).collect();
        assert_eq!(types.len(), 13, "{types:?}");
    }

    #[test]
    fn client_frames_tolerate_what_they_should_and_refuse_junk() {
        let parse = |s: &str| serde_json::from_str::<ClientMessage>(s);
        // `config` may be missing or null: the default table.
        for s in [
            r#"{"type":"GameCreate","payload":{"room_id":"voice_1","kind":"blackjack"}}"#,
            r#"{"type":"GameCreate","payload":{"room_id":"voice_1","kind":"blackjack","config":null}}"#,
        ] {
            assert!(matches!(parse(s), Ok(ClientMessage::GameCreate { config: None, .. })), "{s}");
        }
        // Unknown fields are ignored (a newer client must not draw an Error).
        assert!(parse(r#"{"type":"GameStand","payload":{"room_id":"voice_1","table_id":5,"later":true}}"#).is_ok());
        assert!(parse(r#"{"type":"GameCreate","payload":{"room_id":"voice_1","kind":"holdem","config":{"ante":5}}}"#).is_ok());
        // Junk is refused.
        for s in [
            r#"{"type":"GameCreate","payload":{"room_id":"voice_1","kind":"omaha"}}"#,
            r#"{"type":"GameSit","payload":{"room_id":"voice_1","table_id":5,"seat":-1}}"#,
            r#"{"type":"GameSit","payload":{"room_id":"voice_1","table_id":5.5,"seat":1}}"#,
            r#"{"type":"GameSit","payload":{"room_id":"voice_1","table_id":"5","seat":1}}"#,
            r#"{"type":"GameAct","payload":{"room_id":"voice_1","table_id":5,"turn":{"hand_no":1,"turn_seq":1},"action":{"type":"raise","amount":60}}}"#,
            r#"{"type":"GameAct","payload":{"room_id":"voice_1","table_id":5,"turn":{"hand_no":1,"turn_seq":1},"action":{"type":"bet_or_raise_to"}}}"#,
            r#"{"type":"GameAct","payload":{"room_id":"voice_1","table_id":5,"turn":{"hand_no":1,"turn_seq":1},"action":{"type":"bet_or_raise_to","amount":-60}}}"#,
            r#"{"type":"GameAct","payload":{"room_id":"voice_1","table_id":5,"action":{"type":"fold"}}}"#,
            r#"{"type":"GameBet","payload":{"room_id":"voice_1","table_id":5}}"#,
            r#"{"type":"GameResync","payload":{"room_id":"voice_1"}}"#,
        ] {
            assert!(parse(s).is_err(), "accepted junk: {s}");
        }
    }
}
