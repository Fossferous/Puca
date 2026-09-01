//! Global Application State
//!
//! Thread-safe state management for WebSocket sessions and rooms.

use axum::http::HeaderMap;
use dashmap::mapref::entry::Entry;
use dashmap::DashMap;
use sqlx::PgPool;
use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, Notify};

use crate::email::EmailService;
use crate::protocol::ServerMessage;

/// A pending recovery-reset challenge (proof-of-possession of the identity
/// seed). Short-lived; keyed by lowercased username in AppState.recovery_challenges.
#[derive(Clone)]
pub struct RecoveryChallenge {
    /// Server ephemeral X25519 private scalar (32 bytes).
    pub server_ephemeral_secret: [u8; 32],
    /// Random challenge nonce (32 bytes).
    pub challenge: [u8; 32],
    /// When this challenge expires (created + 2 min).
    pub expires_at: Instant,
}

/// One live peer-to-peer file transfer. Control plane only — the bytes travel
/// over a WebRTC data channel between the two clients and never reach here.
#[derive(Clone)]
pub struct FileTransfer {
    /// Who offered the file.
    pub from: UserId,
    /// Who it was offered to. Only these two may signal on this transfer.
    pub to: UserId,
    /// Offered (not yet accepted). An offer nobody answers is reaped sooner
    /// than a running transfer, which may legitimately last a long time.
    pub accepted: bool,
    /// Last activity; drives the reap so an abandoned transfer cannot pin an
    /// entry for the process lifetime.
    pub touched_at: Instant,
    /// Connection that made the offer, and the one that accepted.
    ///
    /// Only meaningful when `from == to` — sending a file to your OWN account,
    /// PC to phone. There, routing by user id is ambiguous: `peer_of(me)`
    /// answers `me`, so every signal would fan out to BOTH devices including
    /// the one that sent it, and each end would try to apply its own SDP
    /// offer. These pin each leg to a specific socket so the two devices can
    /// actually talk to each other.
    pub from_conn: u64,
    pub to_conn: Option<u64>,
    /// Set while the offer is PARKED: the target had no live socket (or, for a
    /// self-transfer, no second device) when it was made, so the FileOffered
    /// could not be delivered. The payload is held here and re-emitted by
    /// `deliver_parked_offers` when a qualifying connection appears; `None`
    /// once delivered (or for offers that went straight out). Parked offers
    /// age out on the ordinary unaccepted-offer TTL.
    ///
    /// Exists because "offline" and "phone in a pocket" are indistinguishable
    /// at offer time: Android drops the chat socket the moment the app
    /// backgrounds, and the receiver has to pick the phone up to tap Accept
    /// anyway — refusing the offer outright made the feature unusable for the
    /// exact case it was built for (field-confirmed 2026-08-10).
    pub parked_offer: Option<ParkedOffer>,
}

/// What a parked-offer sweep produced: offers for the qualifying connection,
/// and the notes the SENDER is owed (delivery confirmations, or a
/// cancellation when their offering socket died while the offer waited).
pub struct ParkedDelivery {
    pub offers: Vec<ServerMessage>,
    pub sender_notes: Vec<(UserId, ServerMessage)>,
}

/// The deliverable payload of an offer waiting for its target to connect.
#[derive(Debug, Clone)]
pub struct ParkedOffer {
    pub from_username: String,
    pub name: String,
    pub size: u64,
    pub mime: String,
    pub sha256: String,
    /// Self-transfers only: deliver exclusively to this device when named.
    pub target_device: Option<String>,
    /// The offer MAC, carried through so a parked offer delivered later still
    /// arrives authenticated (see FileOffered.auth).
    pub auth: Option<String>,
}

impl FileTransfer {
    /// Is `user` one of the two parties?
    pub fn involves(&self, user: UserId) -> bool {
        user == self.from || user == self.to
    }

    /// The other party, given one of them.
    pub fn peer_of(&self, user: UserId) -> Option<UserId> {
        if user == self.from {
            Some(self.to)
        } else if user == self.to {
            Some(self.from)
        } else {
            None
        }
    }

    /// True when both ends are the same account (PC -> phone).
    pub fn is_self_transfer(&self) -> bool {
        self.from == self.to
    }

    /// For a SELF transfer, the connection at the other end from `conn_id`.
    /// `None` for a normal two-party transfer (route by user id there), or
    /// while the receiving device has not accepted yet.
    pub fn opposite_conn(&self, conn_id: u64) -> Option<u64> {
        if !self.is_self_transfer() {
            return None;
        }
        if conn_id == self.from_conn {
            self.to_conn
        } else {
            Some(self.from_conn)
        }
    }
}

/// Lifecycle of a device-control session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceSessionState {
    /// The host has been asked but has not answered yet.
    Pending,
    /// The host accepted; signalling and input may flow.
    Active,
}

/// One live "control my own device" session.
///
/// Modelled on `FileTransfer`, NOT on rooms: a device session is a 1:1 pinned
/// pair of connections with its own lifetime and its own authorization, which
/// is exactly what a room cannot express.
///
/// The critical difference from `FileTransfer::opposite_conn` is that this one
/// has NO user-id fallback. Routing is always connection-to-connection, and
/// membership of the session IS the authorization — so a message can never be
/// delivered to "some other device of that user" the way a user-scoped send
/// would. That fan-out is the shape audit H6 closed (see send_signal_to_user).
#[derive(Clone)]
pub struct DeviceSession {
    /// Who is driving. Stored separately from `host_user` since v1, which is
    /// exactly what let cross-user shares land as a check rather than a
    /// protocol break: same-account sessions have them equal, a session under
    /// an accepted device share does not.
    pub controller_user: UserId,
    pub host_user: UserId,
    /// The controller's username, stamped from the authenticated connection's
    /// claims at DeviceConnect. Carried so share-session notices to the OWNER
    /// can name the person without a lookup at send time.
    pub controller_username: String,
    /// Whether DeviceInput may flow. Always true same-account; under a share
    /// it requires the 'control' capability — enforced HERE at the relay, not
    /// just hidden in the controller's UI, so a modified client cannot send
    /// input on a view-only grant. (The host client enforces it again for any
    /// input path that does not cross this relay.)
    pub allow_input: bool,
    pub controller_conn: u64,
    pub host_conn: u64,
    pub controller_device: String,
    pub host_device: String,
    pub state: DeviceSessionState,
    /// Last activity; drives the reap so an abandoned session cannot pin an
    /// entry (and a host's single active slot) for the process lifetime.
    pub touched_at: Instant,
    /// When a side's socket dropped mid-session. An ACTIVE session is held for
    /// a short grace window instead of being destroyed — a phone that
    /// backgrounds the app long enough for the OS to close its socket used to
    /// lose the session outright, because by the time it reconnected the
    /// server had already deleted the entry and told the host "the other
    /// device disconnected". The reaper collects a session whose detached side
    /// never came back (see DEVICE_SESSION_DETACH_GRACE_SECS in ws.rs).
    pub controller_detached_at: Option<Instant>,
    pub host_detached_at: Option<Instant>,
    /// When the idle reaper FIRST spared this session for being
    /// quiet-but-connected (see the reprieve in ws.rs). Cleared by real
    /// relayed traffic and by a reattach. Bounds how long the sparing can
    /// go on: a socket task that panics skips its disconnect cleanup, which
    /// leaves its conn REGISTERED and the session attached-on-paper — such a
    /// ghost passes the registry check too, so without this bound one panic
    /// would pin the host's single slot until the process restarts.
    pub reprieved_since: Option<Instant>,
}

/// What `reattach_device_session` decided.
pub enum DeviceReattachOutcome {
    /// The claiming side was rebound to its new socket; tell both ends.
    /// `other_detached` is whether the PEER is itself still detached — the
    /// claimant must be told, because when both sides dropped together the
    /// DevicePeerReconnecting notice was addressed to a conn that no longer
    /// existed, and a claimant told only "reattached" cleared its banner over
    /// a session whose other half was still gone.
    Rebound {
        other_conn: u64,
        other_user: UserId,
        other_detached: bool,
    },
    /// No session by that id (or it never went Active — a mid-handshake
    /// session cannot survive a socket change, its peer was already told).
    NoSuchSession,
    /// The session exists but the claimant is not either of its recorded
    /// (user, device) pairs. Answered with SILENCE at the call site: a
    /// stranger must not learn which session ids are live.
    NotYours,
}

impl DeviceSession {
    /// The connection at the other end from `conn_id`, or `None` if `conn_id`
    /// is not part of this session at all.
    ///
    /// Returning `None` for a stranger is the whole authorization check for
    /// every message after `DeviceConnect`: no DB lookup, no room, just "are
    /// you one of the two sockets in this session".
    pub fn opposite_conn(&self, conn_id: u64) -> Option<u64> {
        if conn_id == self.controller_conn {
            Some(self.host_conn)
        } else if conn_id == self.host_conn {
            Some(self.controller_conn)
        } else {
            None
        }
    }

    /// The user owning the connection at the other end.
    pub fn opposite_user(&self, conn_id: u64) -> Option<UserId> {
        if conn_id == self.controller_conn {
            Some(self.host_user)
        } else if conn_id == self.host_conn {
            Some(self.controller_user)
        } else {
            None
        }
    }

    pub fn involves_conn(&self, conn_id: u64) -> bool {
        conn_id == self.controller_conn || conn_id == self.host_conn
    }
}

/// Unique user identifier
pub type UserId = i64;

/// Room identifier (channel or voice room)
pub type RoomId = String;

/// A connected WebSocket session (one per live connection; keyed by user in
/// `AppState.sessions`, so the user id lives on the map key).
#[derive(Debug)]
pub struct Session {
    pub username: String,
    pub tx: mpsc::Sender<ServerMessage>,
    /// Unique per-connection id, so a closing connection removes exactly its
    /// own entry from the user's session list (see unregister_session).
    pub conn_id: u64,
    /// Server-side hangup for THIS connection. `token_version` is only checked
    /// at the WS upgrade, and the receive loop only re-checks the JWT's expiry
    /// per frame — so revoking a token (account deletion, password change,
    /// recovery reset) left every already-open socket fully privileged for the
    /// rest of the JWT's lifetime. The receive loop selects on this, so a
    /// notify drops the socket immediately and its ordinary disconnect cleanup
    /// runs (rooms reaped, UserLeft/UserOffline broadcast).
    pub kill: Arc<Notify>,
    /// Set once this connection has proved possession of a registered device's
    /// signing key (see the DeviceChallenge/DeviceAttest exchange in ws.rs).
    ///
    /// `None` is normal and must stay usable: the web shell has no device key,
    /// and every already-deployed client predates the exchange entirely. An
    /// unattested connection keeps working for chat and simply is not
    /// addressable by device — attestation is a ROUTING control, not the
    /// security boundary. The real boundary is the host verifying the
    /// controller's device signature inside the E2EE handshake.
    pub device_id: Option<String>,
    /// A background DELIVERY session (the phone's native notification socket,
    /// `?mode=delivery`). Not a person at a screen: excluded from presence
    /// (a phone in a pocket must not read as "online" to friends), from
    /// file-transfer deliverability (it can only drop an offer on the floor —
    /// shipping this unmarked broke PC-to-pocketed-phone transfers outright),
    /// and it is the drain target for the undelivered-notification queue.
    pub delivery: bool,
    /// Device id CLAIMED at connect (`?device=`), unproven. Read by
    /// `kill_device_sessions` ONLY, so "sign out this device" can hang up the
    /// phone's delivery socket — which never attests (the signing key lives in
    /// the WebView it exists to outlive). Deliberately a separate field from
    /// the attested `device_id` above: nothing privilege-bearing may ever read
    /// this one, because anyone can claim any id.
    pub claimed_device_id: Option<String>,
}

/// One continuous stretch of a user's MEMBERSHIP of a voice room. `left_ms` is
/// None while they are still in it. Unix millis, not `Instant`: they are
/// compared against a clip window computed by the server from a client's
/// RELATIVE times ("ended N ms ago"), so a wall clock is the right type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PresenceSpan {
    pub user_id: UserId,
    pub joined_ms: i64,
    pub left_ms: Option<i64>,
    /// They turned their camera / a screen share on at some point in this span
    /// — their PICTURE may be in a clip of the room, not just their voice; the
    /// approval prompt says so.
    pub had_camera: bool,
    pub had_share: bool,
}

/// Bounded, TTL'd voice-presence history for ONE room. Never persisted.
///
/// This exists for exactly one question: "who could be heard in the window
/// [a,b]?" — the required-approver set for a clip (docs/CLIPS.md, plan D1). It
/// answers only for times at or after `observed_from_ms`; before that the
/// honest answer is "I do not know", and the proposal handler REFUSES rather
/// than returning a set it cannot vouch for. A silently-short approver list is
/// indistinguishable from a correct one — that distinction is the whole point.
///
/// Keyed on room MEMBERSHIP (`Room::member_conns` 0↔1), not on `streamers`:
/// `clear_media` is user-level and, with a user on two devices, stopping on
/// one clears the other's presence too (documented limitation below) — which
/// would drop that user's veto over footage they are in. Membership is
/// connection-refcounted and immune to it, and it errs toward MORE approvers
/// (a listener who never published is still someone whose channel this was).
#[derive(Debug, Clone)]
pub struct PresenceLog {
    observed_from_ms: i64,
    spans: Vec<PresenceSpan>,
}

impl PresenceLog {
    /// Longest reach a proposal can have: it may end up to MAX_ENDED_AGO_MS ago
    /// and be up to MAX_CLIP_MS long, padded at the start. Derived, not a
    /// literal — a retention shorter than the reachable window silently shrinks
    /// the approver set to whatever the CLIENT declared.
    pub const MAX_ENDED_AGO_MS: i64 = 10 * 60 * 1000;
    pub const MAX_CLIP_MS: i64 = 600 * 1000;
    pub const PAD_MS: i64 = 2 * 1000;
    pub const RETENTION_MS: i64 = Self::MAX_ENDED_AGO_MS + Self::MAX_CLIP_MS + Self::PAD_MS + 5 * 60 * 1000;
    /// A room with 32 people cycling every 20 s fits comfortably. On overflow the
    /// OLDEST CLOSED span is dropped and `observed_from_ms` advances to its
    /// `left_ms` — forgetting without advancing the watermark would make the log
    /// vouch for a period it no longer remembers.
    pub const MAX_SPANS: usize = 512;

    pub fn new(now_ms: i64) -> Self {
        Self { observed_from_ms: now_ms, spans: Vec::new() }
    }

    pub fn observed_from_ms(&self) -> i64 {
        self.observed_from_ms
    }

    fn open_index(&self, user_id: UserId) -> Option<usize> {
        self.spans.iter().rposition(|s| s.user_id == user_id && s.left_ms.is_none())
    }

    /// Idempotent: a no-op when a span is already open for this user.
    pub fn open_at(&mut self, user_id: UserId, now_ms: i64) {
        if self.open_index(user_id).is_some() {
            return;
        }
        if self.spans.len() >= Self::MAX_SPANS {
            if let Some(i) = self.spans.iter().position(|s| s.left_ms.is_some()) {
                let dropped = self.spans.remove(i);
                self.observed_from_ms = self.observed_from_ms.max(dropped.left_ms.unwrap_or(now_ms));
            }
        }
        self.spans.push(PresenceSpan { user_id, joined_ms: now_ms, left_ms: None, had_camera: false, had_share: false });
    }

    /// Record that the user's open span carried camera / screen-share media.
    pub fn mark_media(&mut self, user_id: UserId, camera: bool, share: bool) {
        if let Some(i) = self.open_index(user_id) {
            if camera { self.spans[i].had_camera = true; }
            if share { self.spans[i].had_share = true; }
        }
    }

    /// Per overlapping user: (had_camera, had_share) OR'd across their spans in the window.
    pub fn overlapping_media(&self, start_ms: i64, end_ms: i64) -> HashMap<UserId, (bool, bool)> {
        let mut out: HashMap<UserId, (bool, bool)> = HashMap::new();
        for s in self.spans.iter().filter(|s| s.joined_ms <= end_ms && s.left_ms.map_or(true, |l| l >= start_ms)) {
            let e = out.entry(s.user_id).or_insert((false, false));
            e.0 |= s.had_camera;
            e.1 |= s.had_share;
        }
        out
    }

    /// Idempotent: a no-op when no span is open.
    pub fn close_at(&mut self, user_id: UserId, now_ms: i64) {
        if let Some(i) = self.open_index(user_id) {
            self.spans[i].left_ms = Some(now_ms.max(self.spans[i].joined_ms));
        }
    }

    /// Everyone whose presence OVERLAPS [start_ms, end_ms], inclusive at both
    /// edges. Inclusive on purpose: a user who left exactly at `start_ms` was
    /// audible in the first sample, and every rounding decision here must err
    /// toward ADDING an approver.
    pub fn overlapping(&self, start_ms: i64, end_ms: i64) -> HashSet<UserId> {
        self.spans
            .iter()
            .filter(|s| s.joined_ms <= end_ms && s.left_ms.map_or(true, |l| l >= start_ms))
            .map(|s| s.user_id)
            .collect()
    }

    /// The earliest join of `user_id` the log still remembers, if any.
    pub fn first_join_of(&self, user_id: UserId) -> Option<i64> {
        self.spans.iter().filter(|s| s.user_id == user_id).map(|s| s.joined_ms).min()
    }

    /// True iff `user_id` was present for the WHOLE of [start_ms, end_ms] with no
    /// gap (a single span covers it). Used to attest a solo clip.
    pub fn present_throughout(&self, user_id: UserId, start_ms: i64, end_ms: i64) -> bool {
        self.spans.iter().any(|s| s.user_id == user_id && s.joined_ms <= start_ms && s.left_ms.map_or(true, |l| l >= end_ms))
    }

    /// Drop closed spans older than RETENTION_MS and ALWAYS advance the
    /// watermark to the pruned horizon (so the log never vouches for a period it
    /// has forgotten).
    pub fn prune_at(&mut self, now_ms: i64) {
        let horizon = now_ms - Self::RETENTION_MS;
        self.spans.retain(|s| s.left_ms.map_or(true, |l| l >= horizon));
        if horizon > self.observed_from_ms {
            self.observed_from_ms = horizon;
        }
    }

    /// Nothing open and nothing worth remembering — a member-less room's log may
    /// finally be dropped.
    pub fn is_expired_at(&self, now_ms: i64) -> bool {
        let horizon = now_ms - Self::RETENTION_MS;
        self.spans.iter().all(|s| s.left_ms.map_or(false, |l| l < horizon))
    }

    #[cfg(test)]
    pub fn open_users(&self) -> HashSet<UserId> {
        self.spans.iter().filter(|s| s.left_ms.is_none()).map(|s| s.user_id).collect()
    }
    #[cfg(test)]
    pub fn span_count(&self) -> usize {
        self.spans.len()
    }
}

/// Wall clock in unix millis (the presence log's time base).
pub fn now_unix_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// A room that users can join (text channel, voice channel, or stream)
#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct Room {
    pub id: RoomId,
    pub name: String,
    pub members: Vec<UserId>,
    pub streamers: Vec<UserId>,
    pub screen_sharers: Vec<UserId>,
    pub camera_users: Vec<UserId>,
    /// Which CONNECTIONS of each member are in the room. `members` stays the
    /// user-level view every consumer reads; this refcounts it so that with
    /// multi-device sessions a user only leaves the room when their LAST
    /// joined connection leaves — and a dead device's membership is reaped on
    /// its own disconnect instead of lingering as a ghost.
    member_conns: HashMap<UserId, HashSet<u64>>,
    /// Which CONNECTIONS of each user hold each media kind. Media is
    /// per-connection even though `streamers`/`screen_sharers`/`camera_users`
    /// stay the user-level view everyone reads.
    ///
    /// This exists because the membership refcount alone can't tell "another
    /// device" from "the same device after a reconnect". A client replays
    /// JoinRoom for every remembered room when its socket comes back, so while
    /// the dead connection is still being reaped the user has TWO connections
    /// in the room — and a user-level check ("are they still a member?") then
    /// discards the media the dead one held, so no *Stopped event is ever sent
    /// and viewers keep a frozen tile forever.
    streamer_conns: HashMap<UserId, HashSet<u64>>,
    share_conns: HashMap<UserId, HashSet<u64>>,
    camera_conns: HashMap<UserId, HashSet<u64>>,
    /// The MediaStream id each sharer ANNOUNCED for their screen share, kept
    /// so a late joiner's ScreenShareStarted replay can carry it — mesh peers
    /// classify the arriving video by this id (see protocol.rs). Only ever
    /// read for users currently in `screen_sharers`, written on announce and
    /// dropped on stop; a re-share overwrites, so a stale entry cannot
    /// outlive its usefulness.
    pub share_stream_ids: HashMap<UserId, String>,
    /// Voice-presence history (membership-keyed) — see PresenceLog. Maintained
    /// INSIDE the methods that mutate `members` (add_member / remove_member /
    /// remove_member_conn), never at the call sites, so a new mutator cannot
    /// forget it. Only voice_* rooms are ever asked; text rooms carry an unused
    /// empty log.
    pub presence_log: PresenceLog,
}

/// Which media kinds a departing connection released at the USER level (i.e.
/// no other connection of theirs still holds it), so the caller knows which
/// *Stopped events to broadcast.
#[derive(Debug, Clone, Copy, Default)]
pub struct ReleasedMedia {
    pub streamer: bool,
    pub screen_sharer: bool,
    pub camera_user: bool,
}

impl ReleasedMedia {
    pub fn any(&self) -> bool {
        self.streamer || self.screen_sharer || self.camera_user
    }
}

/// The three per-connection media kinds a room tracks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaKind {
    Stream,
    ScreenShare,
    Camera,
}

impl Room {
    pub fn new(id: RoomId, name: String) -> Self {
        Self {
            id,
            name,
            members: Vec::new(),
            streamers: Vec::new(),
            screen_sharers: Vec::new(),
            camera_users: Vec::new(),
            member_conns: HashMap::new(),
            streamer_conns: HashMap::new(),
            share_conns: HashMap::new(),
            camera_conns: HashMap::new(),
            share_stream_ids: HashMap::new(),
            presence_log: PresenceLog::new(now_unix_ms()),
        }
    }

    pub fn add_member(&mut self, user_id: UserId, conn_id: u64) {
        self.member_conns
            .entry(user_id)
            .or_default()
            .insert(conn_id);
        if !self.members.contains(&user_id) {
            self.members.push(user_id);
            self.presence_log.open_at(user_id, now_unix_ms());
        }
    }

    /// Turn a media kind on/off for ONE connection. The user-level view stays
    /// on while any of their connections still holds it.
    pub fn set_media(&mut self, kind: MediaKind, user_id: UserId, conn_id: u64, on: bool) {
        let (conns, view) = match kind {
            MediaKind::Stream => (&mut self.streamer_conns, &mut self.streamers),
            MediaKind::ScreenShare => (&mut self.share_conns, &mut self.screen_sharers),
            MediaKind::Camera => (&mut self.camera_conns, &mut self.camera_users),
        };
        if on {
            conns.entry(user_id).or_default().insert(conn_id);
            if !view.contains(&user_id) {
                view.push(user_id);
            }
            match kind {
                MediaKind::Camera => self.presence_log.mark_media(user_id, true, false),
                MediaKind::ScreenShare => self.presence_log.mark_media(user_id, false, true),
                MediaKind::Stream => {}
            }
        } else {
            Self::release_one(conns, view, user_id, conn_id);
        }
    }

    /// Clear a media kind for the user across ALL their connections.
    ///
    /// This is deliberately what an EXPLICIT stop does, and it is exactly the
    /// pre-existing behaviour (`streamers.retain(|id| id != user)` + an
    /// unconditional broadcast). It is NOT connection-scoped, on purpose:
    ///
    /// The server cannot distinguish a live second device from a dead socket
    /// awaiting reap — a half-open connection is still a registered session, so
    /// there is no liveness signal to filter on. Given that ambiguity, matching
    /// the unconditional broadcast is the safe side: state and event always
    /// agree, and an explicit stop always takes effect immediately. Scoping it
    /// per connection instead would swallow the stop for up to the idle timeout
    /// (~90 s) after any reconnect, which is the common case.
    ///
    /// KNOWN LIMITATION (pre-existing, unchanged by the connection-scoped work):
    /// with two devices of one user in the SAME voice room, stopping on one
    /// clears the other's presence too. Fixing that needs the client to
    /// identify its device across reconnects so the server can tell a
    /// superseded connection from a second one.
    ///
    /// Per-connection release is for the DISCONNECT path (`remove_member_conn`),
    /// where the question is "what did this dead socket still hold?" — there the
    /// connection is unambiguously gone.
    pub fn clear_media(&mut self, kind: MediaKind, user_id: UserId) {
        let (conns, view) = match kind {
            MediaKind::Stream => (&mut self.streamer_conns, &mut self.streamers),
            MediaKind::ScreenShare => (&mut self.share_conns, &mut self.screen_sharers),
            MediaKind::Camera => (&mut self.camera_conns, &mut self.camera_users),
        };
        conns.remove(&user_id);
        view.retain(|&id| id != user_id);
        if kind == MediaKind::ScreenShare {
            self.share_stream_ids.remove(&user_id);
        }
    }

    /// Drop one connection's claim; returns true when the USER-level flag went
    /// from on to off (i.e. that was their last connection holding it).
    fn release_one(
        conns: &mut HashMap<UserId, HashSet<u64>>,
        view: &mut Vec<UserId>,
        user_id: UserId,
        conn_id: u64,
    ) -> bool {
        let Some(set) = conns.get_mut(&user_id) else {
            return false;
        };
        if !set.remove(&conn_id) {
            return false;
        }
        if set.is_empty() {
            conns.remove(&user_id);
            let had = view.contains(&user_id);
            view.retain(|&id| id != user_id);
            return had;
        }
        false // another connection of theirs still holds it
    }

    /// Remove one connection's membership AND release whatever media it held.
    /// The user leaves the room only when no other of their connections
    /// remains joined, but their media is released as soon as the connection
    /// that owned it goes away — that's the reconnect case.
    ///
    /// VOICE PRESENCE IS EXEMPT — see `inherit_stream_claim`.
    pub fn remove_member_conn(&mut self, user_id: UserId, conn_id: u64) -> ReleasedMedia {
        let mut released = ReleasedMedia {
            streamer: Self::release_one(
                &mut self.streamer_conns,
                &mut self.streamers,
                user_id,
                conn_id,
            ),
            screen_sharer: Self::release_one(
                &mut self.share_conns,
                &mut self.screen_sharers,
                user_id,
                conn_id,
            ),
            camera_user: Self::release_one(
                &mut self.camera_conns,
                &mut self.camera_users,
                user_id,
                conn_id,
            ),
        };
        if released.screen_sharer {
            self.share_stream_ids.remove(&user_id);
        }
        if let Some(conns) = self.member_conns.get_mut(&user_id) {
            conns.remove(&conn_id);
            if conns.is_empty() {
                self.member_conns.remove(&user_id);
                self.remove_member(user_id); // closes the presence span
            }
        }
        if released.streamer {
            released.streamer = !self.inherit_stream_claim(user_id);
        }
        released
    }

    /// When a dead connection was the last holder of the user's VOICE PRESENCE
    /// but the user still has connections joined to this room, hand the claim to
    /// those survivors instead of releasing it. Returns true when it did.
    ///
    /// Why voice presence and only voice presence:
    ///
    /// `StreamStopped` is not cosmetic — every peer deletes the user from the
    /// voice roster, closes the mesh `RTCPeerConnection` and removes their
    /// `audio-<id>` element. In an SFU room that audio loss is PERMANENT (no new
    /// track event ever fires); mesh self-heals only after a 30–60 s ICE-failure
    /// reconnect. So emitting it while the user is demonstrably still in the room
    /// is the worst outcome available.
    ///
    /// A pure per-connection release only avoids that if the client re-claims on
    /// its new socket — and that re-announce is a one-shot the server never
    /// acknowledges (`can_mutate_room` fails closed on any DB error), and clients
    /// older than 0.6.10 never send it at all. Since the client force-reconnects
    /// at 45 s without a pong while the reap waits `WS_IDLE_TIMEOUT_SECS`, a
    /// half-open socket puts the fresh connection in the room ~30 s BEFORE the
    /// zombie is reaped, so "the reap finds only the zombie holding voice" is the
    /// dominant path, not an edge case. Inheriting makes the fix independent of
    /// the client: a 0.6.10+ client already re-claimed (so `release_one` returned
    /// false and this never runs), and an older client gets exactly the
    /// user-level semantics it has always had.
    ///
    /// Screen share and camera are deliberately NOT inherited. They are the
    /// reason the per-connection work exists: a stale claim there leaves a frozen
    /// ghost tile and keeps the user in `screen_sharers` forever, which then
    /// replays a bogus `ScreenShareStarted` to everyone who joins the room later.
    /// Losing one costs a tile the sharer can restore, never audio.
    ///
    /// This also sits on the explicit `leave_room` path, where it is a no-op in
    /// practice: leaveVoice sends StopStream (→ `clear_media`, user-level)
    /// BEFORE LeaveRoom, so nothing is left to release. A client that leaves the
    /// room without stopping gets 0.6.9's semantics, which is what the
    /// LeaveRoom handler already assumes — it broadcasts no *Stopped at all.
    fn inherit_stream_claim(&mut self, user_id: UserId) -> bool {
        let Some(surviving) = self.member_conns.get(&user_id) else {
            return false;
        };
        if surviving.is_empty() {
            return false;
        }
        let claims = self.streamer_conns.entry(user_id).or_default();
        claims.extend(surviving.iter().copied());
        if !self.streamers.contains(&user_id) {
            self.streamers.push(user_id);
        }
        true
    }

    /// Connection ids of `user_id` currently joined to this room.
    pub fn conns_of(&self, user_id: UserId) -> Option<&HashSet<u64>> {
        self.member_conns.get(&user_id)
    }

    pub fn remove_member(&mut self, user_id: UserId) {
        self.member_conns.remove(&user_id);
        self.streamer_conns.remove(&user_id);
        self.share_conns.remove(&user_id);
        self.camera_conns.remove(&user_id);
        self.members.retain(|&id| id != user_id);
        self.streamers.retain(|&id| id != user_id);
        self.screen_sharers.retain(|&id| id != user_id);
        self.camera_users.retain(|&id| id != user_id);
        self.presence_log.close_at(user_id, now_unix_ms());
    }

    /// Invariant every Room test asserts: a user is in `members` iff the presence
    /// log has an open span for them.
    #[cfg(test)]
    pub fn assert_log_matches_members(&self) {
        let open = self.presence_log.open_users();
        let members: HashSet<UserId> = self.members.iter().copied().collect();
        assert_eq!(open, members, "presence log open spans must equal room members");
    }
}

/// A room a disconnecting connection's user FULLY left (no other of their
/// connections remained joined), plus the media state they held there at that
/// moment. The caller broadcasts the matching *Stopped events: an unclean
/// disconnect (crash, reload, network drop) never sent StopStream /
/// ScreenShareStop / CameraStop, so without these flags every remaining
/// participant kept a stale RTCPeerConnection and ghost roster/tile entries
/// for the departed user.
#[derive(Debug, Clone)]
pub struct VacatedRoom {
    pub room_id: RoomId,
    pub was_streamer: bool,
    pub was_screen_sharer: bool,
    pub was_camera_user: bool,
    /// True when the user left the room ENTIRELY (no other connection of
    /// theirs remained). False means only this connection's media was
    /// released — the user is still present via another connection, so the
    /// caller must NOT announce UserLeft for them.
    pub fully_left: bool,
}

/// Global application state shared across all handlers
/// How long a completed SRP login counts as "the password was just proved".
///
/// Long enough that the login-time key-custody writes (`/keys/rewrap-pw`,
/// `/keys/migrate-v3`, which run immediately after login on a slow device doing
/// Argon2id) comfortably land inside it; short enough that a token stolen later
/// is not sitting inside a live window. The change-password flow re-proves
/// explicitly rather than relying on this, so the window does not need to be
/// generous for it.
pub const PASSWORD_PROOF_TTL: std::time::Duration = std::time::Duration::from_secs(300);

pub struct AppState {
    /// Database connection pool
    pub pool: PgPool,

    /// Active WebSocket sessions: UserId -> all live connections for that user.
    /// A user may legitimately hold several at once (desktop + phone, or a new
    /// socket overlapping a not-yet-reaped old one). The previous one-slot-per-
    /// user model overwrote the old session's tx on reconnect, leaving the old
    /// socket half-dead (receivable but unable to get Pongs) — with two devices
    /// online that degenerated into a perpetual mutual-kick reconnect loop.
    /// Invariant: the Vec is never empty while its map entry exists.
    pub sessions: DashMap<UserId, Vec<Session>>,

    /// Active rooms: RoomId -> Room
    pub rooms: DashMap<RoomId, Room>,

    /// Outstanding device-token challenges. In memory, not the database: they
    /// live 120 seconds, are single-use, and a restart losing them costs one
    /// retry. A table would be a write per unauthenticated request.
    pub device_challenges: std::sync::Arc<crate::device_token::DeviceChallenges>,

    /// JWT secret for token validation
    pub jwt_secret: String,

    /// Email service (optional, requires SMTP configuration)
    pub email_service: Option<EmailService>,

    /// Pending E2EE recovery-reset challenges, keyed by lowercased username.
    /// In-memory + TTL; single-node (fine for this deployment).
    pub recovery_challenges: DashMap<String, RecoveryChallenge>,

    /// Live peer-to-peer file transfers, keyed by transfer id.
    ///
    /// The server never sees a byte of the file — this exists purely so the
    /// control and WebRTC signalling for a transfer can be authorized WITHOUT a
    /// database round trip per message. ICE negotiation emits candidates in
    /// bursts, and re-checking "may these two DM each other" on every candidate
    /// would put a query on a hot path. The DM check runs once, when the offer
    /// is made; everything afterwards is authorized against the pair recorded
    /// here, which is strictly narrower (it names the two specific users).
    pub file_transfers: DashMap<String, FileTransfer>,

    /// Live device-control sessions, keyed by session id. Same reasoning as
    /// `file_transfers`: the DB check runs ONCE at DeviceConnect, and every
    /// later message (SDP, ICE bursts, input events at up to 600/s) is
    /// authorized against the pinned connection pair recorded here — strictly
    /// narrower than the original check, and no query on a hot path.
    pub device_sessions: DashMap<String, DeviceSession>,

    /// Per-username consecutive failed-login tracking (M3). Backs an exponential
    /// response DELAY on the SRP login-finish step — NOT a hard lockout, so an
    /// attacker cannot deny a victim by spamming wrong passwords. In-memory,
    /// keyed by lowercased username; entries reset on success and age out.
    pub login_failures: DashMap<String, LoginFailureState>,

    /// When each user last PROVED their password to this server, by completing
    /// SRP (`login_step_2`). Not "when they logged in" — a JWT outlives the
    /// proof deliberately.
    ///
    /// Endpoints that rewrite credentials or key custody require a recent entry
    /// here, so a stolen bearer token alone cannot set a new SRP verifier or
    /// overwrite the wrapped seed. In-memory and single-node, which is the
    /// correct direction to fail: a restart (or a request landing on the other
    /// host) simply forces the client to re-prove, never the reverse.
    pub password_proofs: DashMap<UserId, std::time::Instant>,

    /// Per-real-IP count of in-flight /files downloads. Bounds one IP's
    /// concurrent (possibly slow-drip) streams so it can't saturate the uplink
    /// or exhaust fds. Self-cleaning: entries are removed when the count hits 0.
    pub file_streams: DashMap<IpAddr, usize>,

    /// Per-real-IP count of live WebSocket connections. Backs a per-IP ceiling on
    /// top of the per-user cap, so one host holding many accounts can't open an
    /// unbounded number of sockets. Self-cleaning at 0.
    pub ws_conns_by_ip: DashMap<IpAddr, usize>,
    /// In-flight `/upload` requests per IP (see [`IpSlotKind::Upload`]).
    pub upload_streams: DashMap<IpAddr, usize>,

    /// Live + reserved usage of LiveKit SFU rooms, keyed by room name
    /// ("sfu_<channel id>"). Fed by the /livekit/webhook event stream and by
    /// token-mint reservations; backs node-global egress admission control.
    pub sfu_rooms: DashMap<String, crate::sfu::SfuRoomUsage>,

    /// Wake-signal transport (FCM doorbell; see src/wake). `NullWake` when
    /// unconfigured. The signal carries a constant — never data.
    pub wake: std::sync::Arc<dyn crate::wake::WakeTransport>,
    /// Per-user wake rate limit: one doorbell per burst, not one per message.
    pub wake_recent: DashMap<UserId, Instant>,
    /// Notification frames that found no live session, awaiting the delivery
    /// socket the wake signal summons. Bounded + TTL'd; see enqueue/drain.
    pub undelivered: DashMap<UserId, std::collections::VecDeque<(Instant, ServerMessage)>>,

    /// Last sampled REAL SFU node egress in kbps, from LiveKit's Prometheus
    /// endpoint (see sfu::spawn_egress_sampler). 0 until the first sample.
    pub sfu_measured_egress_kbps: AtomicU64,
    /// Unix seconds of the last successful egress sample. Admission treats a
    /// sample older than sfu::MEASURED_STALE_SECS as "no measurement" and falls
    /// back to the worst-case projection alone.
    pub sfu_measured_at: AtomicU64,

    /// Presence logs of voice rooms that emptied and were dropped, kept until
    /// they expire so a clipper alone in a channel whose socket blipped does not
    /// lose the record of who was there before. Restored by `join_room` when the
    /// room is re-created; pruned by the clip sweeper.
    pub orphan_presence_logs: DashMap<RoomId, PresenceLog>,

    /// Live clip-approval proposals (docs/CLIPS.md), keyed by clip id.
    /// DELIBERATELY NOT PERSISTED: a pending-clip table would be a durable
    /// record of who was in which voice call at what time — the exact metadata
    /// this product does not keep. A restart drops every live proposal, which is
    /// the correct direction to fail: the clipper is told, and nothing was ever
    /// uploaded.
    pub clip_proposals: DashMap<String, ClipProposal>,
    /// Per-proposer proposal rate window (server-side twin of remoteControl.ts's
    /// denial ladder — enforced here because a modified client will not).
    pub clip_rate: DashMap<UserId, ClipRateState>,
    /// (proposer, voice_channel_id) → growing cooldown after a decline.
    pub clip_denials: DashMap<(UserId, i64), ClipDenial>,

    /// Monotonic source of unique per-connection ids (see Session::conn_id).
    next_conn_id: AtomicU64,
}

/// One approver's answer on a proposal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClipVote {
    Pending,
    Approved,
    Declined,
}

/// One live clip-approval proposal. See clip_handlers.rs for the protocol.
#[derive(Debug, Clone)]
pub struct ClipProposal {
    pub clip_id: String,
    pub proposer: UserId,
    pub proposer_username: String,
    pub server_id: String,
    pub voice_channel_id: i64,
    pub voice_channel_name: String,
    pub target_channel_id: i64,
    pub target_channel_name: String,
    /// Server-clock window the clip covers (padded by PresenceLog::PAD_MS at
    /// the start — that is what the presence log was queried with). The start
    /// is kept for diagnostics only: the approver set was computed from it at
    /// proposal time and is never recomputed.
    #[allow(dead_code)]
    pub window_start_ms: i64,
    pub window_end_ms: i64,
    /// The clip's REAL length as the clipper stated it — what the approver
    /// prompt shows ("The clip is 1 min 4 s"), never the padded window.
    pub duration_ms: i64,
    /// Everyone whose approval is required, computed SERVER-SIDE (union of the
    /// presence log and the client's declared list, minus the proposer), with
    /// per-user flags for the prompt copy.
    pub votes: Vec<ClipVoter>,
    /// The clipper was provably alone for the whole window (log attested).
    pub solo: bool,
    /// Diagnostics only (the sweeper keys on `expires`).
    #[allow(dead_code)]
    pub created: Instant,
    pub expires: Instant,
    /// Set the moment the last Pending becomes Approved. The message-send path
    /// requires this AND consumes the whole entry, so one approval posts exactly
    /// one message.
    pub approved_at: Option<Instant>,
}

#[derive(Debug, Clone)]
pub struct ClipVoter {
    pub user_id: UserId,
    pub username: String,
    pub vote: ClipVote,
    /// They had their camera / a screen share on at some point in the window
    /// (their picture may be in the footage, not just their voice).
    pub had_camera: bool,
    pub had_share: bool,
}

impl ClipProposal {
    pub fn approved_count(&self) -> usize {
        self.votes.iter().filter(|v| v.vote == ClipVote::Approved).count()
    }
    pub fn is_voter(&self, user_id: UserId) -> bool {
        self.votes.iter().any(|v| v.user_id == user_id)
    }
    pub fn all_approved(&self) -> bool {
        self.votes.iter().all(|v| v.vote == ClipVote::Approved)
    }
}

#[derive(Debug, Clone, Copy)]
pub struct ClipRateState {
    pub window_start: Instant,
    pub count: u32,
}

#[derive(Debug, Clone, Copy)]
pub struct ClipDenial {
    pub count: u32,
    pub until: Instant,
    pub last: Instant,
}

/// Which per-IP counter an [`IpSlotGuard`] decrements on drop.
#[derive(Clone, Copy)]
pub enum IpSlotKind {
    /// `/files` download streams.
    File,
    /// Live WebSocket connections.
    Ws,
    /// In-flight `/upload` requests. Each one buffers its whole file field in
    /// RAM (up to the route's 28 MiB body limit) before anything is written, so
    /// without a ceiling a single authenticated client can hold an unbounded
    /// multiple of that resident simply by opening concurrent uploads.
    Upload,
}

/// RAII slot in a per-IP counter. Held for the lifetime of the resource it
/// bounds (a download stream / a WS connection); its Drop decrements the count
/// and prunes the map entry at zero, so no background GC is needed.
pub struct IpSlotGuard {
    state: Arc<AppState>,
    ip: IpAddr,
    kind: IpSlotKind,
}

impl Drop for IpSlotGuard {
    fn drop(&mut self) {
        let map = match self.kind {
            IpSlotKind::File => &self.state.file_streams,
            IpSlotKind::Ws => &self.state.ws_conns_by_ip,
            IpSlotKind::Upload => &self.state.upload_streams,
        };
        // Decrement under the shard lock, then prune at zero in a separate call
        // (holding the get_mut ref across remove_if would deadlock the shard).
        {
            if let Some(mut n) = map.get_mut(&self.ip) {
                *n = n.saturating_sub(1);
            }
        }
        map.remove_if(&self.ip, |_, &n| n == 0);
    }
}

/// The real client IP behind the reverse proxy.
///
/// Whether the operator has vouched for `CF-Connecting-IP`.
///
/// This header is only trustworthy on a deployment genuinely fronted by
/// Cloudflare WITH the origin firewalled to Cloudflare's ranges
/// (deploy/cloudflare/origin-firewall.sh). Anywhere else the client simply sends
/// it, and NEITHER shipped reverse-proxy config strips it — they sanitise
/// `X-Forwarded-For` and leave this one alone. Believing it unconditionally let
/// any caller mint a fresh rate-limit bucket per request by varying one header,
/// which nullified the auth and API limiters on the deployments deploy/README.md
/// actually documents. So it is OPT-IN, and off by default.
fn trust_cf_connecting_ip() -> bool {
    static TRUST: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *TRUST.get_or_init(|| {
        std::env::var("TRUST_CF_CONNECTING_IP")
            .map(|v| v.trim().eq_ignore_ascii_case("true"))
            .unwrap_or(false)
    })
}

/// Whether the TCP peer is a reverse proxy whose forwarding headers we may
/// believe.
///
/// Loopback and private/link-local peers are the documented topology: Caddy or
/// nginx on the same host (or LAN) proxying to 127.0.0.1:3000, and BOTH shipped
/// configs OVERWRITE `X-Forwarded-For` with the real TCP peer, so the value is
/// the proxy's assertion rather than the client's. A PUBLIC peer means the
/// socket is directly exposed (BIND_ADDR=0.0.0.0 with no proxy) — there the peer
/// IS the client, and anything it forwards is its own unverifiable claim.
fn peer_is_trusted_proxy(ip: IpAddr) -> bool {
    fn v4_trusted(v4: std::net::Ipv4Addr) -> bool {
        v4.is_loopback() || v4.is_private() || v4.is_link_local()
    }
    match ip {
        IpAddr::V4(v4) => v4_trusted(v4),
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return v4_trusted(v4);
            }
            let o = v6.octets();
            // ::1, unique-local fc00::/7, link-local fe80::/10
            v6.is_loopback() || (o[0] & 0xfe) == 0xfc || (o[0] == 0xfe && (o[1] & 0xc0) == 0x80)
        }
    }
}

fn header_ip(headers: &HeaderMap, name: &str) -> Option<IpAddr> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.trim().parse::<IpAddr>().ok())
}

/// The caller's real IP, for rate limiting and per-IP ceilings.
///
/// A forwarded header is believed only when something actually vouches for it:
/// `CF-Connecting-IP` when the operator opted in, `X-Forwarded-For`/`X-Real-IP`
/// when the TCP peer is a local/LAN reverse proxy. Otherwise the peer address —
/// the one value a client cannot choose — wins.
///
/// This is the SINGLE policy: the rate limiter's key extractor
/// (middleware/rate_limit.rs) calls straight into it, rather than keeping a
/// parallel copy of the precedence that could drift.
pub fn real_client_ip(headers: &HeaderMap, peer: SocketAddr) -> IpAddr {
    client_ip_with_policy(headers, peer, trust_cf_connecting_ip())
}

/// The policy itself, with the one environment-derived input passed in so it can
/// be tested both ways in the same process (the env read is cached in a
/// `OnceLock`, so a test that set the variable could not un-set it).
fn client_ip_with_policy(headers: &HeaderMap, peer: SocketAddr, trust_cf: bool) -> IpAddr {
    if trust_cf {
        if let Some(ip) = header_ip(headers, "cf-connecting-ip") {
            return ip;
        }
    }
    if peer_is_trusted_proxy(peer.ip()) {
        if let Some(xff) = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()) {
            if let Some(ip) = xff
                .split(',')
                .filter_map(|s| s.trim().parse::<IpAddr>().ok())
                .next()
            {
                return ip;
            }
        }
        if let Some(rip) = header_ip(headers, "x-real-ip") {
            return rip;
        }
    }
    peer.ip()
}

/// Ceiling on how many distinct usernames the login-backoff map will track.
///
/// Entries are keyed by a string an unauthenticated caller chooses, so the map
/// needs a bound or it is an unbounded allocation primitive. 8192 is far above
/// any real deployment's active-failure set and far below anything that matters
/// for memory.
pub const MAX_TRACKED_LOGIN_FAILURES: usize = 8192;

/// Consecutive failed-login accounting for one username (M3).
#[derive(Clone, Copy)]
pub struct LoginFailureState {
    /// Consecutive failures since the last success.
    pub count: u32,
    /// When the most recent failure was recorded (for aging out).
    pub last: Instant,
}

impl AppState {
    /// The wake transport is explicit rather than defaulted so a caller cannot
    /// forget it and silently get a deployment where the doorbell never rings —
    /// the documented failure class. Tests pass `NullWake`.
    pub fn new(
        pool: PgPool,
        jwt_secret: String,
        email_service: Option<EmailService>,
        wake: std::sync::Arc<dyn crate::wake::WakeTransport>,
    ) -> Arc<Self> {
        Arc::new(Self {
            pool,
            wake,
            wake_recent: DashMap::new(),
            undelivered: DashMap::new(),
            orphan_presence_logs: DashMap::new(),
            clip_proposals: DashMap::new(),
            clip_rate: DashMap::new(),
            clip_denials: DashMap::new(),
            sessions: DashMap::new(),
            rooms: DashMap::new(),
            jwt_secret,
            device_challenges: std::sync::Arc::new(
                crate::device_token::DeviceChallenges::new(),
            ),
            email_service,
            recovery_challenges: DashMap::new(),
            file_transfers: DashMap::new(),
            device_sessions: DashMap::new(),
            login_failures: DashMap::new(),
            password_proofs: DashMap::new(),
            file_streams: DashMap::new(),
            ws_conns_by_ip: DashMap::new(),
            upload_streams: DashMap::new(),
            sfu_rooms: DashMap::new(),
            sfu_measured_egress_kbps: AtomicU64::new(0),
            sfu_measured_at: AtomicU64::new(0),
            next_conn_id: AtomicU64::new(1),
        })
    }

    /// Response delay owed for `username` from prior consecutive failures (M3).
    /// Zero for the first few failures (so a legit typo isn't punished), then
    /// exponential and capped. A streak older than the window counts as reset.
    /// This is a THROTTLE, not a lockout — the account never becomes unusable, so
    /// an attacker cannot deny a victim by spamming wrong passwords.
    pub fn login_backoff_delay(&self, username: &str) -> std::time::Duration {
        const FREE_ATTEMPTS: u32 = 3;
        const BASE_MS: u64 = 200;
        const MAX_MS: u64 = 4000;
        const WINDOW: std::time::Duration = std::time::Duration::from_secs(900);
        let key = username.to_lowercase();
        let count = match self.login_failures.get(&key) {
            Some(e) if e.last.elapsed() <= WINDOW => e.count,
            _ => 0,
        };
        if count <= FREE_ATTEMPTS {
            return std::time::Duration::ZERO;
        }
        let steps = (count - FREE_ATTEMPTS - 1).min(20); // clamp the shift
        let ms = BASE_MS.saturating_mul(1u64 << steps).min(MAX_MS);
        std::time::Duration::from_millis(ms)
    }

    /// Record a failed login for `username` (M3). A stale streak is aged out
    /// before incrementing.
    pub fn record_login_failure(&self, username: &str) {
        const WINDOW: std::time::Duration = std::time::Duration::from_secs(900);
        let key = username.to_lowercase();
        let now = Instant::now();
        // The key is caller-supplied on an UNAUTHENTICATED route, so without a
        // ceiling this map grows forever — one permanent entry per guessed name.
        //
        // When full, EVICT THE OLDEST rather than refusing the new key. Refusing
        // was fail-open on a counter an attacker controls the keys of: flood the
        // map with 8192 throwaway names and every subsequent name — including the
        // one being attacked — records no failure and accrues no backoff. Eviction
        // keeps the same memory bound while leaving every username throttleable,
        // and costs nothing extra: the stale sweep below already walks the map.
        if self.login_failures.len() >= MAX_TRACKED_LOGIN_FAILURES
            && !self.login_failures.contains_key(&key)
        {
            self.login_failures.retain(|_, v| v.last.elapsed() <= WINDOW);
            if self.login_failures.len() >= MAX_TRACKED_LOGIN_FAILURES {
                // Still full of live streaks: drop the least recently touched, so
                // the newcomer is tracked. `last` is monotonic per entry, so the
                // minimum is the oldest activity.
                let oldest = self
                    .login_failures
                    .iter()
                    .min_by_key(|e| e.value().last)
                    .map(|e| e.key().clone());
                if let Some(k) = oldest {
                    self.login_failures.remove(&k);
                }
            }
        }
        let mut e = self.login_failures.entry(key).or_insert(LoginFailureState {
            count: 0,
            last: now,
        });
        if e.last.elapsed() > WINDOW {
            e.count = 0;
        }
        e.count = e.count.saturating_add(1);
        e.last = now;
    }

    /// Record that `user_id` just proved their password via SRP.
    ///
    /// Called from `login_step_2` ONLY — the one place the server actually
    /// verifies knowledge of the password. Anything else recording a proof
    /// would defeat the point.
    pub fn record_password_proof(&self, user_id: UserId) {
        self.password_proofs
            .insert(user_id, std::time::Instant::now());
    }

    /// Has `user_id` proved their password within [`PASSWORD_PROOF_TTL`]?
    ///
    /// Fails CLOSED: no entry (server restarted, proof expired, request landed
    /// on another host) means "not proven", and the client re-proves.
    pub fn password_recently_proven(&self, user_id: UserId) -> bool {
        self.password_proofs
            .get(&user_id)
            .is_some_and(|t| t.elapsed() < PASSWORD_PROOF_TTL)
    }

    /// Drop a user's password proof — used after a credential rewrite so one
    /// proof cannot authorise a second, unrelated rewrite later in the window.
    pub fn clear_password_proof(&self, user_id: UserId) {
        self.password_proofs.remove(&user_id);
    }

    /// Clear the failure streak for `username` after a successful login (M3).
    pub fn clear_login_failures(&self, username: &str) {
        self.login_failures.remove(&username.to_lowercase());
    }

    /// Try to take a per-IP slot in the given counter. Returns a guard (which
    /// releases the slot on drop) if the IP is under `cap`, else None. The
    /// check-and-increment is atomic under the DashMap shard lock, so it cannot
    /// overshoot the cap within a shard.
    pub fn try_acquire_ip_slot(
        self: &Arc<Self>,
        ip: IpAddr,
        kind: IpSlotKind,
        cap: usize,
    ) -> Option<IpSlotGuard> {
        {
            let map = match kind {
                IpSlotKind::File => &self.file_streams,
                IpSlotKind::Ws => &self.ws_conns_by_ip,
                IpSlotKind::Upload => &self.upload_streams,
            };
            let mut entry = map.entry(ip).or_insert(0);
            if *entry >= cap {
                return None;
            }
            *entry += 1;
        }
        Some(IpSlotGuard {
            state: Arc::clone(self),
            ip,
            kind,
        })
    }

    /// Register a new WebSocket session. Returns the unique connection id the
    /// caller must pass back to `unregister_session` on disconnect, whether
    /// this is the user's FIRST live connection (the caller broadcasts the
    /// user-online presence only in that case — a second device coming online
    /// must not re-announce an already-online user), and the hangup handle the
    /// receive loop must select on so `disconnect_user` can drop this socket.
    pub fn register_session(
        &self,
        user_id: UserId,
        username: String,
        tx: mpsc::Sender<ServerMessage>,
        delivery: bool,
        claimed_device_id: Option<String>,
    ) -> (u64, bool, Arc<Notify>) {
        let conn_id = self.next_conn_id.fetch_add(1, Ordering::Relaxed);
        let kill = Arc::new(Notify::new());

        // Bound concurrent connections per user: each is a task + channel + fd,
        // and every presence/broadcast fans out to all of them. Without a cap a
        // single reused token could open thousands of sockets and exhaust the
        // process.
        const MAX_SESSIONS_PER_USER: usize = 10;
        // Delivery sockets get their own, tighter bound INSIDE the total. A
        // full exemption would remove the DoS property the total cap exists
        // for; without any sub-bound, delivery churn alone can crowd out every
        // visible client (this is what happened: a phone's wake-driven
        // reconnects evicted the desktop that was hosting a remote-control
        // session). One install needs exactly one, so 4 is already generous.
        const MAX_DELIVERY_SESSIONS_PER_USER: usize = 4;

        // LOCK ORDER: device_sessions BEFORE sessions. That is the order the
        // reaper takes them (ws.rs calls conn_is_live, which reads `sessions`,
        // from inside a `device_sessions.retain`), and victim selection below
        // needs to know which of this user's conns are party to a live device
        // session. Scanning device_sessions while holding the `sessions` shard
        // would invert the order against the reaper and can deadlock — so the
        // set is collected FIRST, and only when this registration could
        // actually evict something (the scan is pointless otherwise).
        //
        // The probe is racy by construction: another registration can land
        // between it and the entry below. That is benign — the loser gets an
        // empty protected set for one eviction, i.e. the old behaviour — and
        // it is the only way to keep the lock order without scanning
        // device_sessions on every single connect.
        let near_cap = self
            .sessions
            .get(&user_id)
            .is_some_and(|v| v.len() + 1 >= MAX_SESSIONS_PER_USER);
        let protected: Vec<u64> = if near_cap {
            self.device_sessions
                .iter()
                .flat_map(|s| {
                    // A session can be cross-user (a device share), so take
                    // only the end that actually belongs to THIS user.
                    let mut conns = Vec::new();
                    if s.controller_user == user_id {
                        conns.push(s.controller_conn);
                    }
                    if s.host_user == user_id {
                        conns.push(s.host_conn);
                    }
                    conns
                })
                .collect()
        } else {
            Vec::new()
        };

        let mut entry = self.sessions.entry(user_id).or_default();
        // "First" for PRESENCE purposes means first VISIBLE connection: a
        // delivery socket is a phone in a pocket, and it must neither announce
        // the user online nor count as already-online when a real client
        // connects later (which would suppress that client's own announce).
        let is_first = !delivery && entry.iter().all(|s| s.delivery);

        // Every eviction below hangs its socket up with `kill.notify_one()`,
        // not just by dropping the Session: dropping only drops its tx, and
        // the receive loop keeps running (the split sink and stream are
        // independent halves), so the socket would linger registered.

        // One install, one delivery socket. `reconnectNow` drops and redials
        // UNCONDITIONALLY on every wake (deliberately — a wake means the
        // server saw no session, and a Doze-frozen socket never learns it is
        // dead because postDelayed runs on uptime, which stands still in deep
        // sleep). The corpse it leaves behind is only collected by the 75s
        // idle reaper, so without this the same phone stacks several sessions
        // between wakes. Collect the predecessor the moment its replacement
        // arrives: strictly better than any timeout, and it cannot reap a
        // healthy socket on a bad network.
        //
        // No new trust is granted by keying on the CLAIMED device id: the WS
        // upgrade has already fail-closed-verified that the claim names a
        // live, unrevoked device row owned by this user (ws.rs), and the only
        // power taken here is hanging up your own device's other socket —
        // which "sign out this device" already permits.
        if delivery {
            if let Some(dev) = claimed_device_id.as_deref() {
                let mut i = 0;
                while i < entry.len() {
                    if entry[i].delivery
                        && entry[i].claimed_device_id.as_deref() == Some(dev)
                    {
                        let stale = entry.remove(i);
                        tracing::info!(
                            "delivery socket superseded for user {}: device {} \
                             reconnected (dropping conn {})",
                            user_id,
                            dev,
                            stale.conn_id
                        );
                        stale.kill.notify_one();
                    } else {
                        i += 1;
                    }
                }
            }
            // An UNCLAIMED delivery socket (fresh install, not yet enrolled;
            // or an older client) is deliberately never deduped — it has
            // asserted no identity to dedupe on, and keying on "any delivery
            // session" would hang up a legitimate second device. The sub-cap
            // is what bounds those.
            if entry.iter().filter(|s| s.delivery).count() >= MAX_DELIVERY_SESSIONS_PER_USER
            {
                if let Some(idx) = entry.iter().position(|s| s.delivery) {
                    let evicted = entry.remove(idx);
                    tracing::warn!(
                        "delivery session cap reached for user {}: evicting conn {} \
                         (delivery, oldest of {})",
                        user_id,
                        evicted.conn_id,
                        MAX_DELIVERY_SESSIONS_PER_USER
                    );
                    evicted.kill.notify_one();
                }
            }
        }

        if entry.len() >= MAX_SESSIONS_PER_USER {
            // Choose the victim rather than always taking the oldest. The
            // oldest connection is typically the desktop that has been signed
            // in all day — which is exactly the socket HOSTING a remote-control
            // session, and hanging it up mid-session cost a real user real
            // sessions. Preference order:
            //   1. the oldest delivery socket — a pocketed phone losing its
            //      socket costs one reconnect, and the doorbell exists to
            //      bring it straight back;
            //   2. else the oldest socket NOT party to a live device session;
            //   3. else the oldest, unchanged.
            // Never refuse the NEW connection: locking a user out of the
            // client they are actively using is worse than any eviction.
            let victim = entry
                .iter()
                .position(|s| s.delivery && !protected.contains(&s.conn_id))
                .or_else(|| {
                    entry
                        .iter()
                        .position(|s| !protected.contains(&s.conn_id))
                })
                .unwrap_or(0);
            let evicted = entry.remove(victim);
            let was_in_device_session = protected.contains(&evicted.conn_id);
            // This eviction used to be completely silent, which is why it took
            // three audits to find. It hangs a socket up that nobody asked to
            // close, so it says so.
            tracing::warn!(
                "session cap reached for user {}: evicting conn {} \
                 (delivery={}, in_device_session={}, {} sessions held)",
                user_id,
                evicted.conn_id,
                evicted.delivery,
                was_in_device_session,
                MAX_SESSIONS_PER_USER
            );
            evicted.kill.notify_one();
        }
        entry.push(Session {
            username,
            tx,
            conn_id,
            kill: Arc::clone(&kill),
            device_id: None,
            delivery,
            claimed_device_id,
        });
        (conn_id, is_first, kill)
    }

    /// Record that `conn_id` proved possession of `device_id`'s signing key.
    ///
    /// Deliberately a separate call rather than an extra `register_session`
    /// parameter: attestation genuinely happens AFTER registration (the
    /// challenge round-trips over the open socket), and threading an
    /// always-None argument through the existing signature would be a bigger
    /// diff that reads as though the id were known at connect time.
    pub fn attest_device(&self, user_id: UserId, conn_id: u64, device_id: String) {
        if let Some(mut sessions) = self.sessions.get_mut(&user_id) {
            if let Some(s) = sessions.iter_mut().find(|s| s.conn_id == conn_id) {
                s.device_id = Some(device_id);
            }
        }
    }

    /// The live connection attested as `device_id`, if any.
    ///
    /// A linear scan is correct here: a user holds at most MAX_SESSIONS_PER_USER
    /// (10) sessions, so an index would cost more to maintain than it saves.
    pub fn conn_of_device(&self, user_id: UserId, device_id: &str) -> Option<u64> {
        self.sessions.get(&user_id).and_then(|sessions| {
            sessions
                .iter()
                .find(|s| s.device_id.as_deref() == Some(device_id))
                .map(|s| s.conn_id)
        })
    }

    /// Which device, if any, this connection attested as.
    pub fn device_of_conn(&self, user_id: UserId, conn_id: u64) -> Option<String> {
        self.sessions.get(&user_id).and_then(|sessions| {
            sessions
                .iter()
                .find(|s| s.conn_id == conn_id)
                .and_then(|s| s.device_id.clone())
        })
    }

    /// `(sessions this user has, sessions targeting this host device)`.
    /// Counted in one pass so the two caps cannot disagree under concurrency.
    pub fn count_device_sessions(&self, user_id: UserId, host_device: &str) -> (usize, usize) {
        let mut mine = 0;
        let mut on_host = 0;
        for s in self.device_sessions.iter() {
            if s.controller_user == user_id || s.host_user == user_id {
                mine += 1;
            }
            if s.host_device == host_device {
                on_host += 1;
            }
        }
        (mine, on_host)
    }

    /// Mark a session alive and return the OTHER end's `(conn, user)`.
    ///
    /// `None` when the session does not exist or `conn_id` is not one of its
    /// two sockets — which is the entire authorization check for every message
    /// after DeviceConnect. There is deliberately no user-id fallback: a
    /// message can never be delivered to "some other device of that user".
    ///
    /// The user id rides along because sends are looked up BY user: under a
    /// cross-user share the opposite socket belongs to the other account, and
    /// a send keyed on the sender's own user id would silently vanish.
    pub fn touch_device_session(&self, session_id: &str, conn_id: u64) -> Option<(u64, UserId)> {
        let mut s = self.device_sessions.get_mut(session_id)?;
        let other = s.opposite_conn(conn_id)?;
        let other_user = s.opposite_user(conn_id)?;
        s.touched_at = Instant::now();
        s.reprieved_since = None;
        Some((other, other_user))
    }

    /// Is this exact socket still in the registry?
    ///
    /// This vouches for LESS than it looks like: a conn is here from
    /// register_session until unregister_session, and the disconnect cleanup
    /// that calls the latter is ordinary code after the receive loop — a
    /// PANICKED socket task skips it and its conn stays registered for the
    /// process lifetime. So this check catches sessions whose conns were
    /// properly closed or evicted (the common case: the phone's socket died
    /// and cleanup ran), and it is the reprieve's REPRIEVE_MAX bound, not
    /// this check, that stops a panic-ghost from being spared forever.
    pub fn conn_is_live(&self, user_id: UserId, conn_id: u64) -> bool {
        self.sessions
            .get(&user_id)
            .is_some_and(|v| v.iter().any(|s| s.conn_id == conn_id))
    }

    /// Every parked file offer this connection qualifies to receive, plus the
    /// notes the SENDER is owed about what happened — and the side effects of
    /// qualifying: a delivered offer stops being parked (delivered-once), its
    /// clock is touched, and a parked offer whose OFFERING socket has since
    /// died is removed WITH a cancellation to the sender (the file bytes live
    /// in that tab's JS; with the socket gone nothing can honour an accept,
    /// and silently dropping the record stranded the sender's card on
    /// "waiting" with no TTL notice ever coming — the record was gone).
    ///
    /// Called when a connection registers, and again when it attests a device
    /// id — a device-pinned offer cannot match before the id is known.
    /// Returns the messages rather than sending, so no map guard is ever held
    /// across a channel send.
    pub fn deliver_parked_offers(&self, user_id: UserId, conn_id: u64) -> ParkedDelivery {
        // The connecting session's attested device id, for device-pinned offers.
        let my_device: Option<String> = self.device_of_conn(user_id, conn_id);
        let mut delivery = ParkedDelivery { offers: Vec::new(), sender_notes: Vec::new() };
        let mut dead: Vec<(String, UserId)> = Vec::new();
        for mut entry in self.file_transfers.iter_mut() {
            let id = entry.key().clone();
            let t = entry.value_mut();
            if t.to != user_id || t.parked_offer.is_none() {
                continue;
            }
            // A self-transfer must never be offered back to the DEVICE that
            // sent it — the connect-a-channel-to-itself hazard. Conn identity
            // alone is not enough: on a reconnect the same physical device
            // returns with a NEW conn while its old socket can linger
            // registered for a while, so compare attested device ids too when
            // both sides have them.
            if t.is_self_transfer() {
                if t.from_conn == conn_id {
                    continue;
                }
                let from_device = self.device_of_conn(t.from, t.from_conn);
                if from_device.is_some() && from_device == my_device {
                    continue;
                }
            }
            if let Some(want) = t.parked_offer.as_ref().and_then(|p| p.target_device.as_deref()) {
                if my_device.as_deref() != Some(want) {
                    continue;
                }
            }
            if !self.conn_is_live(t.from, t.from_conn) {
                dead.push((id, t.from));
                continue;
            }
            let p = t.parked_offer.take().expect("checked is_some above");
            t.touched_at = Instant::now();
            // Tell the sender the wait is over — their card was explaining a
            // parked offer, and "delivered, waiting for them to accept" is a
            // different (true) message. Rides the same FileParked type; old
            // clients ignore it exactly as they ignored the first one.
            delivery.sender_notes.push((
                t.from,
                ServerMessage::FileParked {
                    from_user: t.to,
                    transfer_id: id.clone(),
                    reason: "the offer reached them — waiting for them to accept".to_string(),
                },
            ));
            delivery.offers.push(ServerMessage::FileOffered {
                from_user: t.from,
                from_username: p.from_username,
                transfer_id: id,
                name: p.name,
                size: p.size,
                mime: p.mime,
                sha256: p.sha256,
                auth: p.auth,
            });
        }
        for (id, from) in dead {
            self.file_transfers.remove(&id);
            delivery.sender_notes.push((
                from,
                ServerMessage::FileCancelled {
                    from_user: user_id,
                    transfer_id: id,
                    reason: "your end reconnected before the offer could be delivered — send it again"
                        .to_string(),
                },
            ));
        }
        delivery
    }

    /// Remove a session, returning the other end's `(conn, user)` so it can be
    /// told. `None` if `conn_id` is not part of it — a stranger cannot end a
    /// session merely by naming its id.
    pub fn end_device_session(&self, session_id: &str, conn_id: u64) -> Option<(u64, UserId)> {
        let other = {
            let s = self.device_sessions.get(session_id)?;
            (s.opposite_conn(conn_id)?, s.opposite_user(conn_id)?)
        };
        self.device_sessions.remove(session_id);
        Some(other)
    }

    /// End every live session running under one specific share — the grant
    /// revocation counterpart of `kill_device_sessions`, but NARROWER on
    /// purpose: it removes only sessions where `grantee_user` is driving
    /// `host_device`, and it does NOT kill sockets. The grantee's socket is
    /// their whole app connection (chat included) and revoking one device
    /// share must not log them out of everything; ending the relay entry and
    /// telling both sides is what tears the session down (the host client
    /// stops capture and closes the peer connection on DeviceEnded, and the
    /// host is the enforcement point for what leaves its machine).
    ///
    /// Returns `(session_id, controller_user, controller_conn, host_user,
    /// host_conn)` per ended session so the caller can notify both ends —
    /// collected first, so no map guard is held across channel sends.
    pub fn end_share_sessions(
        &self,
        host_device: &str,
        grantee_user: UserId,
    ) -> Vec<(String, UserId, u64, UserId, u64)> {
        let mut ended = Vec::new();
        self.device_sessions.retain(|id, s| {
            if s.host_device == host_device && s.controller_user == grantee_user {
                ended.push((
                    id.clone(),
                    s.controller_user,
                    s.controller_conn,
                    s.host_user,
                    s.host_conn,
                ));
                return false;
            }
            true
        });
        ended
    }

    /// Handle every device session a departing connection was part of.
    ///
    /// A PENDING session dies with the socket — the handshake cannot survive a
    /// conn change — and lands in `ended`. An ACTIVE one is NOT destroyed: the
    /// departing side is marked detached and the session held for the grace
    /// window (the ws.rs reaper enforces it), so a briefly-backgrounded phone
    /// can reattach instead of losing the session; it lands in `detached` so
    /// the survivor can be told "reconnecting", not "gone". Both vecs carry
    /// `(session_id, other_conn, other_user)`.
    ///
    /// The active session still cannot leak: if nobody reattaches, the reaper
    /// ends it (freeing the host's single slot), and the survivor is told.
    pub fn drop_device_sessions_for_conn(
        &self,
        conn_id: u64,
    ) -> (Vec<(String, u64, UserId)>, Vec<(String, u64, UserId)>) {
        let mut ended = Vec::new();
        let mut detached = Vec::new();
        let now = Instant::now();
        self.device_sessions.retain(|id, s| {
            if !s.involves_conn(conn_id) {
                return true;
            }
            let notify = match (s.opposite_conn(conn_id), s.opposite_user(conn_id)) {
                (Some(other), Some(user)) => Some((id.clone(), other, user)),
                _ => None,
            };
            if s.state == DeviceSessionState::Active {
                if conn_id == s.controller_conn {
                    s.controller_detached_at = Some(now);
                } else {
                    s.host_detached_at = Some(now);
                }
                // The detach IS activity for the idle clock. A minimized
                // controller sends nothing, so idle ages near the TTL are the
                // normal steady state now — without this refresh, a session
                // 150s quiet when its phone backgrounded hit the 180s idle
                // reap 30s into a grace window documented as 60s.
                s.touched_at = now;
                if let Some(n) = notify {
                    detached.push(n);
                }
                return true;
            }
            if let Some(n) = notify {
                ended.push(n);
            }
            false
        });
        (ended, detached)
    }

    /// A fresh DeviceConnect from the same (user, controller device) to the
    /// same host supersedes that pair's own DETACHED session. When the OS
    /// killed the app rather than suspending it, the E2EE session key died
    /// with the webview and no reattach can ever come — without this the
    /// corpse holds the host's single slot for the whole grace window and the
    /// user's immediate retry is refused with "already handling a session".
    /// Returns `(session_id, host_conn, host_user)` so the host can be told.
    pub fn supersede_detached_session(
        &self,
        user_id: UserId,
        controller_device: &str,
        host_device: &str,
    ) -> Option<(String, u64, UserId)> {
        let mut found = None;
        self.device_sessions.retain(|id, s| {
            if found.is_none()
                && s.controller_user == user_id
                && s.controller_device == controller_device
                && s.host_device == host_device
                && s.controller_detached_at.is_some()
            {
                found = Some((id.clone(), s.host_conn, s.host_user));
                return false;
            }
            true
        });
        found
    }

    /// Rebind one side of a still-live ACTIVE session to a fresh socket.
    ///
    /// The claim is checked against the (user, device) pair RECORDED ON THE
    /// SESSION — not just the user, because both sides of a v1 session belong
    /// to the same account, so a user check alone could rebind the wrong side.
    /// The device id comes from the connection's attestation (device_of_conn),
    /// never from the client's message. Rebinding is allowed even when the
    /// side is not marked detached: a fast reconnect can reattach before the
    /// server has processed the old socket's close, and when that close does
    /// arrive its stale conn_id no longer matches, so it detaches nothing.
    ///
    /// This grants relay routing only. Everything that matters inside the
    /// session is sealed under the E2EE session key, which never touched the
    /// server — a socket that reattaches without that key can decrypt nothing
    /// and sign nothing.
    pub fn reattach_device_session(
        &self,
        session_id: &str,
        user_id: UserId,
        device_id: &str,
        conn_id: u64,
    ) -> DeviceReattachOutcome {
        let Some(mut s) = self.device_sessions.get_mut(session_id) else {
            return DeviceReattachOutcome::NoSuchSession;
        };
        if s.state != DeviceSessionState::Active {
            return DeviceReattachOutcome::NoSuchSession;
        }
        if s.controller_user == user_id && s.controller_device == device_id {
            s.controller_conn = conn_id;
            s.controller_detached_at = None;
            s.touched_at = Instant::now();
            s.reprieved_since = None;
            DeviceReattachOutcome::Rebound {
                other_conn: s.host_conn,
                other_user: s.host_user,
                other_detached: s.host_detached_at.is_some(),
            }
        } else if s.host_user == user_id && s.host_device == device_id {
            s.host_conn = conn_id;
            s.host_detached_at = None;
            s.touched_at = Instant::now();
            s.reprieved_since = None;
            DeviceReattachOutcome::Rebound {
                other_conn: s.controller_conn,
                other_user: s.controller_user,
                other_detached: s.controller_detached_at.is_some(),
            }
        } else {
            DeviceReattachOutcome::NotYours
        }
    }

    /// Hang up every live socket attested as `device_id`.
    ///
    /// Revocation that only writes a DB row is theatre: the socket was
    /// authorised at upgrade time and would otherwise stay fully privileged for
    /// the rest of the JWT's lifetime. Reuses the same `Session.kill` path as
    /// account deletion and password change. Returns how many were dropped.
    pub fn kill_device_sessions(&self, user_id: UserId, device_id: &str) -> usize {
        let Some(sessions) = self.sessions.get(&user_id) else {
            return 0;
        };
        let mut killed = 0;
        for s in sessions.iter().filter(|s| {
            // Attested id, or the id the delivery socket CLAIMED at connect.
            // The claim is unproven, but for a KILL that is fine — the worst a
            // false claim earns its holder is being hung up. Without the
            // claimed match, "sign out this device" could not reach the
            // phone's delivery socket at all (it never attests), and a lost
            // phone kept receiving lock-screen titles until token expiry.
            s.device_id.as_deref() == Some(device_id)
                || s.claimed_device_id.as_deref() == Some(device_id)
        }) {
            s.kill.notify_one();
            killed += 1;
        }
        killed
    }

    /// Hang up every live socket belonging to `user_id`. Returns how many were
    /// signalled.
    ///
    /// This is the enforcement half of a `token_version` bump: the bump alone
    /// only refuses the NEXT upgrade, and the receive loop re-checks the JWT's
    /// expiry per frame but not its version (that would be a DB round trip per
    /// frame). Each socket's own cleanup path runs after it breaks out, so
    /// rooms, media flags and presence are torn down exactly as they are for an
    /// ordinary disconnect — nothing is removed from `sessions` here.
    pub fn disconnect_user(&self, user_id: UserId) -> usize {
        match self.sessions.get(&user_id) {
            Some(sessions) => {
                for session in sessions.iter() {
                    session.kill.notify_one();
                }
                sessions.len()
            }
            None => 0,
        }
    }

    /// Unregister one connection on disconnect. Removes exactly the `conn_id`
    /// entry and reaps THAT connection's room memberships; other live
    /// connections for the same user (another device) are untouched. Returns
    /// (last_visible_gone, vacated_rooms): the first is true iff this was the
    /// user's last VISIBLE connection (caller broadcasts UserOffline — a
    /// surviving delivery socket is not presence and must not hold the dot);
    /// `vacated_rooms` are rooms the user FULLY left because of this
    /// disconnect (caller broadcasts UserLeft to them when the user is still
    /// online elsewhere — otherwise UserOffline already covers it), each
    /// carrying the media state held there at departure so the caller can
    /// broadcast the *Stopped events an unclean disconnect never sent.
    /// Returns `(last_visible_gone, vacated_rooms)`.
    ///
    /// The first is true when the connection removed was the user's last
    /// VISIBLE one — the presence question, not the emptiness question. Gating
    /// the UserOffline broadcast on full emptiness only fixed half the
    /// green-dot bug: the announce side ignored delivery sockets, but the
    /// retract side still waited for a socket that is deliberately permanent,
    /// so the dot went up honestly and never came down.
    pub fn unregister_session(&self, user_id: UserId, conn_id: u64) -> (bool, Vec<VacatedRoom>) {
        // Remove + emptiness check atomically under the shard lock (Entry API):
        // a concurrent register_session for the same user serializes against
        // this block, so a fast reconnect can never observe a stale "empty"
        // and tear down state a brand-new connection depends on.
        let last_visible_gone = match self.sessions.entry(user_id) {
            Entry::Occupied(mut occupied) => {
                let was_visible = occupied
                    .get()
                    .iter()
                    .any(|s| s.conn_id == conn_id && !s.delivery);
                occupied.get_mut().retain(|s| s.conn_id != conn_id);
                let visible_left = occupied.get().iter().any(|s| !s.delivery);
                if occupied.get().is_empty() {
                    occupied.remove();
                }
                was_visible && !visible_left
            }
            Entry::Vacant(_) => false,
        };
        let fully_offline = last_visible_gone;

        // A user who vanishes mid-transfer must not stay counted against the
        // per-user cap. Only drop transfers when their last VISIBLE connection
        // goes: a second device can still carry them, but a delivery socket
        // cannot (it drops transfer frames unread) — and since that socket is
        // deliberately permanent, gating this purge on full emptiness meant it
        // never ran for an Android user at all.
        if fully_offline || !self.is_user_visibly_online(user_id) {
            self.file_transfers
                .retain(|_, t| t.from != user_id && t.to != user_id);
        }

        // Reap THIS connection's room memberships regardless of other live
        // sessions — a dead device must not stay a ghost in its voice rooms.
        // The user only leaves a room when no other of their connections is
        // joined to it (refcounted in Room::member_conns).
        let mut emptied: Vec<RoomId> = Vec::new();
        let mut vacated: Vec<VacatedRoom> = Vec::new();
        for mut room in self.rooms.iter_mut() {
            let was_member = room.members.contains(&user_id);
            // Media is released per CONNECTION, so a reconnecting client (which
            // is briefly in the room twice) still gets its dead connection's
            // share/camera/stream torn down — the user-level "are they still a
            // member?" check used to swallow exactly that case, leaving a
            // permanent ghost tile AND a bogus screen_sharers entry that got
            // replayed to everyone who joined the room afterwards.
            let released = room.remove_member_conn(user_id, conn_id);
            let fully_left = was_member && !room.members.contains(&user_id);
            if fully_left || released.any() {
                vacated.push(VacatedRoom {
                    room_id: room.key().clone(),
                    was_streamer: released.streamer,
                    was_screen_sharer: released.screen_sharer,
                    was_camera_user: released.camera_user,
                    fully_left,
                });
            }
            if room.members.is_empty() {
                emptied.push(room.key().clone());
            }
        }
        // Drop the now-empty rooms so abandoned-by-disconnect rooms don't
        // accumulate for the process lifetime (leave_room already does this).
        // remove_if re-checks emptiness under the shard lock, so a concurrent
        // join that repopulated the room is not clobbered.
        for room_id in emptied {
            self.drop_room_if_empty(&room_id);
        }
        (fully_offline, vacated)
    }

    /// Send a message to a specific user
    ///
    /// Uses a BOUNDED per-connection channel with try_send: if a consumer stops
    /// reading and its queue fills, further messages are DROPPED (returns false)
    /// rather than buffered without limit. This applies backpressure so one slow
    /// or malicious socket can't drive the process to OOM; the client resyncs
    /// missed state over REST on its next poll/reconnect.
    pub fn send_to_user(&self, user_id: UserId, msg: ServerMessage) -> bool {
        if let Some(sessions) = self.sessions.get(&user_id) {
            // Fan out to every live connection (desktop + phone). Delivered if
            // at least one accepted; a dead tx is reaped by its own disconnect.
            // Single-session (the overwhelmingly common case) moves the msg —
            // no clone on the hot path.
            match sessions.as_slice() {
                [only] => only.tx.try_send(msg).is_ok(),
                many => {
                    let mut delivered = false;
                    for session in many {
                        if session.tx.try_send(msg.clone()).is_ok() {
                            delivered = true;
                        }
                    }
                    delivered
                }
            }
        } else {
            false
        }
    }

    /// Send to exactly one of a user's connections. Used for direct replies to
    /// a request that arrived on that connection (Pong, Error, RoomJoined…) —
    /// fanning these to every device would, e.g., let the desktop's Pongs keep
    /// a half-dead phone socket looking alive.
    pub fn send_to_conn(&self, user_id: UserId, conn_id: u64, msg: ServerMessage) -> bool {
        if let Some(sessions) = self.sessions.get(&user_id) {
            sessions
                .iter()
                .find(|s| s.conn_id == conn_id)
                .map(|s| s.tx.try_send(msg).is_ok())
                .unwrap_or(false)
        } else {
            false
        }
    }

    /// Send to all of a user's connections EXCEPT one.
    ///
    /// Exists for messaging yourself: a file offer addressed to your own
    /// account must reach your OTHER devices, never echo back to the device
    /// that sent it. `send_to_user` fans out to every session, so the sending
    /// phone would answer its own offer.
    ///
    /// Returns how many connections it actually reached, so the caller can
    /// tell "your other device isn't open" from "delivered".
    pub fn send_to_user_except_conn(
        &self,
        user_id: UserId,
        exclude_conn_id: u64,
        msg: ServerMessage,
    ) -> usize {
        let Some(sessions) = self.sessions.get(&user_id) else {
            return 0;
        };
        let mut delivered = 0;
        for session in sessions.iter().filter(|s| s.conn_id != exclude_conn_id) {
            if session.tx.try_send(msg.clone()).is_ok() {
                delivered += 1;
            }
        }
        delivered
    }

    /// Relay a connection-scoped message (WebRTC signaling, remote control) to
    /// the target user's connections that share a live VOICE room
    /// (`voice_<channelId>`) with the sending connection. Only voice rooms are
    /// signaling-eligible: a call / screen-share / remote-control session only
    /// exists inside one, and gating here (rather than merely excluding
    /// `channel_` rooms) stops a shared text/DM/bare room from routing media
    /// signaling. If no shared voice room places the target beside this sender
    /// connection, NOTHING is delivered — the former fallback to send_to_user
    /// fanned an Offer/ControlRequest out to ALL of the target's devices
    /// (including idle phones), which was an unsolicited-call / negotiation-
    /// clobber / IP-harvest vector (H6).
    pub fn send_signal_to_user(
        &self,
        sender_id: UserId,
        sender_conn: u64,
        target_user: UserId,
        msg: ServerMessage,
    ) -> bool {
        let mut target_conns: HashSet<u64> = HashSet::new();
        for room in self.rooms.iter() {
            if !room.id.starts_with("voice_") {
                continue;
            }
            let sender_in_room = room
                .conns_of(sender_id)
                .is_some_and(|conns| conns.contains(&sender_conn));
            if !sender_in_room {
                continue;
            }
            if let Some(conns) = room.conns_of(target_user) {
                target_conns.extend(conns);
            }
        }

        if target_conns.is_empty() {
            return false;
        }
        if let Some(sessions) = self.sessions.get(&target_user) {
            let mut delivered = false;
            for session in sessions
                .iter()
                .filter(|s| target_conns.contains(&s.conn_id))
            {
                if session.tx.try_send(msg.clone()).is_ok() {
                    delivered = true;
                }
            }
            delivered
        } else {
            false
        }
    }

    /// Broadcast a message to all users in a room
    pub fn broadcast_to_room(&self, room_id: &str, msg: ServerMessage, exclude: Option<UserId>) {
        if let Some(room) = self.rooms.get(room_id) {
            for &member_id in &room.members {
                if Some(member_id) != exclude {
                    self.send_to_user(member_id, msg.clone());
                }
            }
        }
    }

    /// Join a room (connection-scoped: the same user may be joined from
    /// several devices; see Room::member_conns).
    pub fn join_room(&self, room_id: &str, user_id: UserId, conn_id: u64) {
        self.rooms
            .entry(room_id.to_string())
            .or_insert_with(|| {
                let mut room = Room::new(room_id.to_string(), room_id.to_string());
                // A voice room that emptied and was dropped keeps its presence
                // history in the orphan map until it expires; re-attach it so a
                // clip window reaching back before the re-creation is still
                // answerable (docs/CLIPS.md).
                if let Some((_, log)) = self.orphan_presence_logs.remove(room_id) {
                    room.presence_log = log;
                }
                room
            })
            .add_member(user_id, conn_id);
    }

    /// Drop `room_id` if it has no members — the ONE place a room is removed.
    /// For a voice room whose presence log has not expired, the log moves to
    /// `orphan_presence_logs` (see join_room). Re-checks emptiness under the
    /// shard lock so a concurrent join is not clobbered.
    pub fn drop_room_if_empty(&self, room_id: &str) {
        if let Some((id, room)) = self.rooms.remove_if(room_id, |_, r| r.members.is_empty()) {
            let now_ms = now_unix_ms();
            if id.starts_with("voice_") && !room.presence_log.is_expired_at(now_ms) {
                self.orphan_presence_logs.insert(id, room.presence_log);
            }
        }
    }

    /// Leave a room (connection-scoped: the user stays a member while any
    /// other of their connections remains joined).
    pub fn leave_room(&self, room_id: &str, user_id: UserId, conn_id: u64) {
        let now_empty = if let Some(mut room) = self.rooms.get_mut(room_id) {
            room.remove_member_conn(user_id, conn_id);
            room.members.is_empty()
        } else {
            false
        };

        // Guard dropped above. Remove only if STILL empty: remove_if re-checks the
        // predicate while holding the shard lock, so a concurrent join_room that
        // repopulated the room between the drop and here is not clobbered (the old
        // drop-then-unconditional-remove had a TOCTOU that could delete a room a
        // new member had just joined, silently stranding them).
        if now_empty {
            self.drop_room_if_empty(room_id);
        }
    }

    /// Get username by user ID
    pub fn get_username(&self, user_id: UserId) -> Option<String> {
        self.sessions
            .get(&user_id)
            .and_then(|sessions| sessions.first().map(|s| s.username.clone()))
    }

    /// Check if a user is online (has an active WebSocket session)
    // NOTE: there is deliberately no `is_user_online` ("any session at all")
    // helper any more. Every caller that existed wanted PRESENCE and was wrong
    // the moment permanent delivery sockets appeared; routing paths test
    // delivery directly via send_to_user's return value. If you need the raw
    // form, you are probably about to re-create the permanently-green-dot bug.

    /// Online AS A PERSON: at least one non-delivery session. This is the
    /// answer every presence surface must use — the green dot, UserOnline/
    /// UserOffline, member lists, file-transfer deliverability. The plain
    /// `is_user_online` above answers "can a frame reach them at all", which
    /// is the right question only for routing. Conflating the two is how a
    /// phone in a pocket became permanently "online" to every friend.
    pub fn is_user_visibly_online(&self, user_id: UserId) -> bool {
        self.sessions
            .get(&user_id)
            .map(|v| v.iter().any(|s| !s.delivery))
            .unwrap_or(false)
    }

    /// How many VISIBLE (non-delivery) connections the user holds. The
    /// self-transfer "a second device must exist" check counts these — a
    /// WebView plus its own phone's delivery socket is one device, not two.
    pub fn visible_session_count(&self, user_id: UserId) -> usize {
        self.sessions
            .get(&user_id)
            .map(|v| v.iter().filter(|s| !s.delivery).count())
            .unwrap_or(0)
    }

    // --- undelivered-notification queue ------------------------------------
    //
    // A bounded, short-lived queue of notification frames that found NO live
    // session (`send_to_user` returned false). Drained into the next DELIVERY
    // session that connects — the wake signal's other half: the doorbell gets
    // the house to answer, this hands over what knocked. Never drained into a
    // visible session: those repaint from REST state on connect, and replaying
    // a DirectMessage into the WebView would double-render an open chat.

    /// How long a parked frame is worth delivering. Beyond this the user has
    /// almost certainly read it elsewhere, and a notification for it would be
    /// noise about old news.
    ///
    /// Enforced in BOTH directions, which is the point: at drain (what the
    /// client is handed) and at the opportunistic prune (what the process
    /// keeps holding).
    const UNDELIVERED_TTL: Duration = Duration::from_secs(60 * 60);

    /// Park an undelivered notification frame for `user_id`.
    pub fn enqueue_undelivered(&self, user_id: UserId, msg: ServerMessage) {
        const CAP: usize = 32;
        // The TTL below is applied at DRAIN time, so a user who never opens a
        // delivery socket again (uninstalled the app, only ever uses the
        // desktop) leaves their parked frames resident for the process
        // lifetime. Prune opportunistically once the map is large enough for
        // that to matter — same shape as the wake sender's own prune. Keyed on
        // the NEWEST frame, so an actively-queueing user is never pruned.
        const PRUNE_ABOVE: usize = 1024;
        if self.undelivered.len() > PRUNE_ABOVE {
            self.prune_undelivered_at(Instant::now());
        }
        let mut q = self.undelivered.entry(user_id).or_default();
        if q.len() >= CAP {
            // Drop-oldest: a bounded queue of stale doorbells beats an
            // unbounded one, and the client's own catch-up covers history.
            q.pop_front();
        }
        q.push_back((Instant::now(), msg));
    }

    /// Drop every user whose NEWEST parked frame is older than the TTL.
    ///
    /// Takes `now` as a test seam, the same one the reapers in ws.rs carry: a
    /// test that rewinds a real `Instant` by an hour PANICS on a machine booted
    /// more recently, because `Instant` cannot represent a time before its own
    /// epoch. That fired for real here on a nine-minute-old boot. Shifting
    /// `now` FORWARD keeps the same relative gaps with arithmetic that cannot
    /// underflow.
    ///
    /// Keyed on the newest frame, so an actively-queueing user is never pruned.
    pub fn prune_undelivered_at(&self, now: Instant) {
        self.undelivered.retain(|_, q| {
            q.back()
                .is_some_and(|(at, _)| now.duration_since(*at) < Self::UNDELIVERED_TTL)
        });
    }

    /// Take every still-fresh parked frame for `user_id`.
    pub fn drain_undelivered(&self, user_id: UserId) -> Vec<ServerMessage> {
        let Some((_, q)) = self.undelivered.remove(&user_id) else {
            return Vec::new();
        };
        q.into_iter()
            .filter(|(at, _)| at.elapsed() < Self::UNDELIVERED_TTL)
            .map(|(_, m)| m)
            .collect()
    }
}

#[cfg(test)]
mod client_ip_tests {
    use super::{client_ip_with_policy, peer_is_trusted_proxy};
    use axum::http::HeaderMap;
    use std::net::SocketAddr;

    /// A directly-exposed socket: the peer IS the client (BIND_ADDR=0.0.0.0).
    fn direct() -> SocketAddr {
        "203.0.113.9:4000".parse().unwrap()
    }
    /// The documented topology: Caddy/nginx proxying to the loopback listener.
    fn behind_proxy() -> SocketAddr {
        "127.0.0.1:54321".parse().unwrap()
    }

    #[test]
    fn direct_peer_ignores_every_forwarded_header() {
        // THE ATTACK this gate exists to stop: one header per request minted a
        // fresh rate-limit bucket, nullifying the 5/s auth and 50/s API limits.
        let mut h = HeaderMap::new();
        h.insert("cf-connecting-ip", "198.51.100.7".parse().unwrap());
        h.insert("x-forwarded-for", "1.2.3.4".parse().unwrap());
        h.insert("x-real-ip", "192.0.2.55".parse().unwrap());
        assert_eq!(
            client_ip_with_policy(&h, direct(), false),
            direct().ip(),
            "a directly-exposed peer must be keyed on its socket address"
        );
    }

    #[test]
    fn proxied_peer_honours_leftmost_xff() {
        // POSITIVE CONTROL for the test above: the same headers ARE honoured
        // when something vouches for them, so `direct_peer_ignores_*` is proving
        // the gate works rather than that the rig never reads a header at all.
        let mut h = HeaderMap::new();
        h.insert("x-forwarded-for", "5.6.7.8, 9.9.9.9".parse().unwrap());
        assert_eq!(
            client_ip_with_policy(&h, behind_proxy(), false).to_string(),
            "5.6.7.8"
        );

        let mut r = HeaderMap::new();
        r.insert("x-real-ip", "192.0.2.55".parse().unwrap());
        assert_eq!(
            client_ip_with_policy(&r, behind_proxy(), false).to_string(),
            "192.0.2.55"
        );
    }

    #[test]
    fn cf_header_needs_the_operator_opt_in() {
        let mut h = HeaderMap::new();
        h.insert("cf-connecting-ip", "198.51.100.7".parse().unwrap());
        // Off by default, even from a proxy: neither shipped config strips it,
        // so the value reaching us is still the client's own.
        assert_eq!(
            client_ip_with_policy(&h, behind_proxy(), false),
            behind_proxy().ip()
        );
        // On when the operator asserts a Cloudflare front door. The peer there is
        // a PUBLIC Cloudflare address, so this must not depend on a private peer.
        assert_eq!(
            client_ip_with_policy(&h, direct(), true).to_string(),
            "198.51.100.7"
        );
    }

    #[test]
    fn garbage_headers_do_not_panic_and_fall_through() {
        let mut h = HeaderMap::new();
        h.insert("cf-connecting-ip", "not-an-ip".parse().unwrap());
        h.insert("x-forwarded-for", "also-not-an-ip".parse().unwrap());
        h.insert("x-real-ip", "192.0.2.55".parse().unwrap());
        assert_eq!(
            client_ip_with_policy(&h, behind_proxy(), true).to_string(),
            "192.0.2.55"
        );
        let empty = HeaderMap::new();
        assert_eq!(
            client_ip_with_policy(&empty, behind_proxy(), true),
            behind_proxy().ip()
        );
    }

    #[test]
    fn trusted_proxy_classification() {
        for ip in [
            "127.0.0.1",
            "10.1.2.3",
            "192.168.0.5",
            "172.16.0.1",
            "169.254.1.1",
            "::1",
            "fd00::1",
            "fe80::1",
            "::ffff:127.0.0.1",
        ] {
            assert!(
                peer_is_trusted_proxy(ip.parse().unwrap()),
                "{ip} should be treated as a local reverse proxy"
            );
        }
        for ip in [
            "203.0.113.9",
            "8.8.8.8",
            "172.32.0.1", // just outside 172.16/12
            "2606:4700::1",
            "::ffff:203.0.113.9",
        ] {
            assert!(
                !peer_is_trusted_proxy(ip.parse().unwrap()),
                "{ip} is a public peer and must not be trusted to forward"
            );
        }
    }
}

#[cfg(test)]
mod crash_resistance_tests {
    use super::*;
    use crate::protocol::ServerMessage;

    /// Build an AppState WITHOUT touching a database. connect_lazy never opens a
    /// connection, so the session/room bookkeeping (which is all in-memory) is
    /// testable in isolation.
    fn test_state() -> Arc<AppState> {
        let pool = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://localhost/does_not_connect")
            .expect("lazy pool");
        AppState::new(pool, "test-secret".into(), None, std::sync::Arc::new(crate::wake::NullWake))
    }

    /// The login-backoff map is bounded, and being full must not switch the
    /// throttle OFF for a name the attacker has not already inserted.
    ///
    /// Refusing new keys when full was fail-open on a counter whose keys an
    /// unauthenticated caller chooses: flood it with throwaway names and the
    /// account actually under attack records no failures and accrues no delay.
    /// The bound is kept by EVICTING the oldest entry instead.
    #[tokio::test]
    async fn full_login_failure_map_evicts_rather_than_stopping_the_throttle() {
        let state = test_state();
        for i in 0..MAX_TRACKED_LOGIN_FAILURES {
            state.record_login_failure(&format!("filler-{i}"));
        }
        assert_eq!(
            state.login_failures.len(),
            MAX_TRACKED_LOGIN_FAILURES,
            "precondition: the map should be exactly at its ceiling"
        );

        // The attacked account, seen for the first time while the map is full.
        for _ in 0..10 {
            state.record_login_failure("victim");
        }

        assert!(
            state.login_failures.contains_key("victim"),
            "a fresh username must still be tracked when the map is full"
        );
        assert!(
            !state.login_backoff_delay("victim").is_zero(),
            "and must therefore accrue backoff after repeated failures"
        );
        assert!(
            state.login_failures.len() <= MAX_TRACKED_LOGIN_FAILURES,
            "eviction must keep the memory bound the ceiling exists for"
        );
    }

    /// The presence split. Every assertion here maps to a shipped bug: a
    /// phone's permanent delivery socket made its user permanently "online"
    /// to friends, suppressed the real client's own online announce, and
    /// counted as a "device" for file-transfer deliverability.
    #[tokio::test]
    async fn delivery_sessions_are_invisible_to_presence() {
        let state = test_state();
        let (tx, _rx) = mpsc::channel::<ServerMessage>(8);
        let (_, first, _) = state.register_session(1, "u".into(), tx, true, None);
        assert!(!first, "a delivery socket must never announce the user online");
        assert!(
            !state.is_user_visibly_online(1),
            "a user whose only session is their phone's delivery socket is not online"
        );
        assert_eq!(state.visible_session_count(1), 0);

        // POSITIVE CONTROL, and the suppression half: the first REAL client
        // arriving alongside the delivery socket must still announce.
        let (tx2, _rx2) = mpsc::channel::<ServerMessage>(8);
        let (_, first2, _) = state.register_session(1, "u".into(), tx2, false, None);
        assert!(first2, "the delivery socket must not eat the real client's announce");
        assert!(state.is_user_visibly_online(1));
        assert_eq!(state.visible_session_count(1), 1);

        // A second real client is NOT first — unchanged semantics.
        let (tx3, _rx3) = mpsc::channel::<ServerMessage>(8);
        let (_, first3, _) = state.register_session(1, "u".into(), tx3, false, None);
        assert!(!first3);
    }

    #[tokio::test]
    async fn a_claimed_device_id_is_killable_but_never_attested() {
        let state = test_state();
        let (tx, _rx) = mpsc::channel::<ServerMessage>(8);
        state.register_session(2, "u".into(), tx, true, Some("dev-abc".into()));
        // "Sign out this device" reaches the delivery socket via the CLAIM —
        // it never attests (the signing key lives in the WebView).
        assert_eq!(state.kill_device_sessions(2, "dev-abc"), 1);
        // And the claim must not have leaked into the attested field.
        let attested = state
            .sessions
            .get(&2)
            .map(|v| v.iter().any(|s| s.device_id.is_some()))
            .unwrap_or(false);
        assert!(!attested, "a claim is not an attestation");
    }

    #[tokio::test]
    async fn undelivered_queue_caps_and_drains_once() {
        let state = test_state();
        for i in 0..40 {
            state.enqueue_undelivered(3, ServerMessage::MessageDeleted {
                channel_id: 1,
                message_id: format!("m{i}"),
            });
        }
        let drained = state.drain_undelivered(3);
        assert_eq!(drained.len(), 32, "cap must drop-oldest, not grow unbounded");
        // Oldest were dropped: the first surviving frame is m8.
        match &drained[0] {
            ServerMessage::MessageDeleted { message_id, .. } => assert_eq!(message_id, "m8"),
            other => panic!("unexpected frame {other:?}"),
        }
        // A drain is a TAKE: the doorbell's frames must not replay on the
        // next reconnect.
        assert!(state.drain_undelivered(3).is_empty());
    }

    #[tokio::test]
    async fn sessions_per_user_are_capped() {
        let state = test_state();
        // Open far more connections than the cap for one user.
        for _ in 0..50 {
            let (tx, _rx) = mpsc::channel::<ServerMessage>(8);
            state.register_session(7, "mallory".into(), tx, false, None);
        }
        let live = state.sessions.get(&7).map(|v| v.len()).unwrap_or(0);
        assert!(live <= 10, "sessions per user must be capped, got {live}");
    }

    /// Unclean disconnect of a streaming user's last in-room connection must
    /// report the media state they held, so ws.rs can broadcast the *Stopped
    /// events the dead client never sent (stale-peer / ghost-roster producer).
    #[tokio::test]
    async fn unclean_disconnect_reports_held_media_state() {
        let state = test_state();
        let (tx, _rx) = mpsc::channel::<ServerMessage>(8);
        let (conn_id, _first, _) = state.register_session(1, "streamer".into(), tx, false, None);

        let mut room = Room::new("voice:v1".into(), "voice:v1".into());
        room.add_member(1, conn_id);
        room.set_media(MediaKind::Stream, 1, conn_id, true);
        room.set_media(MediaKind::ScreenShare, 1, conn_id, true);
        state.rooms.insert("voice:v1".into(), room);

        let (fully_offline, vacated) = state.unregister_session(1, conn_id);
        assert!(fully_offline);
        assert_eq!(vacated.len(), 1);
        assert_eq!(vacated[0].room_id, "voice:v1");
        assert!(vacated[0].was_streamer);
        assert!(vacated[0].was_screen_sharer);
        assert!(!vacated[0].was_camera_user);
        assert!(vacated[0].fully_left);
    }

    /// Multi-device refcounting: while ANOTHER of the user's connections is
    /// still joined to the room, a device death must not vacate it (and so
    /// must not trigger any Stopped broadcast) — the user is still there.
    #[tokio::test]
    async fn other_device_in_room_prevents_vacate() {
        let state = test_state();
        let (tx1, _rx1) = mpsc::channel::<ServerMessage>(8);
        let (tx2, _rx2) = mpsc::channel::<ServerMessage>(8);
        let (conn1, _, _) = state.register_session(2, "dual".into(), tx1, false, None);
        let (conn2, _, _) = state.register_session(2, "dual".into(), tx2, false, None);

        let mut room = Room::new("voice:v2".into(), "voice:v2".into());
        room.add_member(2, conn1);
        room.add_member(2, conn2);
        // BOTH connections hold the stream, as a genuine second device would.
        room.set_media(MediaKind::Stream, 2, conn1, true);
        room.set_media(MediaKind::Stream, 2, conn2, true);
        state.rooms.insert("voice:v2".into(), room);

        let (fully_offline, vacated) = state.unregister_session(2, conn1);
        assert!(!fully_offline);
        assert!(
            vacated.is_empty(),
            "room with a surviving connection must not be vacated"
        );
        let room = state.rooms.get("voice:v2").expect("room kept");
        assert!(room.members.contains(&2));
        assert!(room.streamers.contains(&2));
    }

    /// A second device that is NOT in the room doesn't stop the vacate: the
    /// dying device was the user's only presence there, so the streamer flag
    /// must be reported even though the user stays online elsewhere.
    #[tokio::test]
    async fn online_elsewhere_still_vacates_room() {
        let state = test_state();
        let (tx1, _rx1) = mpsc::channel::<ServerMessage>(8);
        let (tx2, _rx2) = mpsc::channel::<ServerMessage>(8);
        let (conn1, _, _) = state.register_session(3, "roamer".into(), tx1, false, None);
        let (_conn2, _, _) = state.register_session(3, "roamer".into(), tx2, false, None);

        let mut room = Room::new("voice:v3".into(), "voice:v3".into());
        room.add_member(3, conn1);
        room.set_media(MediaKind::Stream, 3, conn1, true);
        state.rooms.insert("voice:v3".into(), room);

        let (fully_offline, vacated) = state.unregister_session(3, conn1);
        assert!(!fully_offline, "user still online on the other device");
        assert_eq!(vacated.len(), 1);
        assert!(vacated[0].was_streamer);
    }

    /// THE RECONNECT CASE. A client replays JoinRoom for every remembered room
    /// when its socket comes back, so while the dead connection is still being
    /// reaped the user is in the room TWICE. Media must still be released —
    /// the user-level "are they still a member?" check swallowed it, so no
    /// ScreenShareStopped was ever sent and viewers kept a frozen tile while
    /// `screen_sharers` kept replaying a bogus share to later joiners.
    #[tokio::test]
    async fn reconnect_releases_the_dead_connections_media() {
        let state = test_state();
        let (tx1, _rx1) = mpsc::channel::<ServerMessage>(8);
        let (tx2, _rx2) = mpsc::channel::<ServerMessage>(8);
        let (old_conn, _, _) = state.register_session(4, "resharer".into(), tx1, false, None);
        let (new_conn, _, _) = state.register_session(4, "resharer".into(), tx2, false, None);

        let mut room = Room::new("voice:v4".into(), "voice:v4".into());
        room.add_member(4, old_conn);
        room.set_media(MediaKind::ScreenShare, 4, old_conn, true);
        room.add_member(4, new_conn); // the reconnect re-joins before the reap
        state.rooms.insert("voice:v4".into(), room);

        let (fully_offline, vacated) = state.unregister_session(4, old_conn);

        assert!(!fully_offline, "the new connection keeps the user online");
        assert_eq!(
            vacated.len(),
            1,
            "the dead connection's media must be reported"
        );
        assert!(vacated[0].was_screen_sharer);
        assert!(
            !vacated[0].fully_left,
            "the user is still in the room via the new connection — no UserLeft"
        );
        let room = state.rooms.get("voice:v4").expect("room kept");
        assert!(
            room.members.contains(&4),
            "still a member via the new connection"
        );
        assert!(
            !room.screen_sharers.contains(&4),
            "the stale share must be gone, or it replays to everyone who joins later"
        );
    }

    /// THE RECONNECT CASE FOR VOICE, for a client that does NOT re-announce
    /// (anything older than 0.6.10, and any 0.6.10+ client whose one-shot
    /// re-claim was lost or rejected). The dead connection is the only holder of
    /// the user's voice presence while the fresh connection is already in the
    /// room. Releasing it would broadcast StreamStopped at a user who is plainly
    /// still in voice — every peer drops them from the roster and tears down
    /// their audio, permanently in an SFU room. The claim must be inherited by
    /// the surviving connection instead, and must still fire when that one goes.
    #[tokio::test]
    async fn reconnect_without_reannounce_keeps_voice_presence() {
        let state = test_state();
        let (tx1, _rx1) = mpsc::channel::<ServerMessage>(8);
        let (tx2, _rx2) = mpsc::channel::<ServerMessage>(8);
        let (old_conn, _, _) = state.register_session(6, "blipper".into(), tx1, false, None);
        let (new_conn, _, _) = state.register_session(6, "blipper".into(), tx2, false, None);

        let mut room = Room::new("voice:v6".into(), "voice:v6".into());
        room.add_member(6, old_conn);
        room.set_media(MediaKind::Stream, 6, old_conn, true);
        // The reconnect replays JoinRoom only — no StartStream. This is exactly
        // what a 0.6.9 client does, and the half-open-socket timing (client
        // reconnects at 45 s, reap at 75 s) makes it the dominant ordering.
        room.add_member(6, new_conn);
        state.rooms.insert("voice:v6".into(), room);

        let (fully_offline, vacated) = state.unregister_session(6, old_conn);

        assert!(!fully_offline, "the new connection keeps the user online");
        assert!(
            !vacated.iter().any(|v| v.was_streamer),
            "must NOT announce StreamStopped for a user still in the room"
        );
        {
            let room = state.rooms.get("voice:v6").expect("room kept");
            assert!(
                room.streamers.contains(&6),
                "voice presence must survive the reap of the connection that held it"
            );
            assert_eq!(
                room.streamer_conns
                    .get(&6)
                    .map(|c| c.iter().copied().collect::<Vec<_>>()),
                Some(vec![new_conn]),
                "the claim must move to the surviving connection, not linger on the dead one"
            );
        }

        // And the inherited claim must still resolve: when the surviving
        // connection goes, this IS a real departure and peers must be told.
        let (fully_offline, vacated) = state.unregister_session(6, new_conn);
        assert!(fully_offline);
        assert_eq!(vacated.len(), 1);
        assert!(
            vacated[0].was_streamer,
            "the inherited claim must still fire on a real leave"
        );
        assert!(vacated[0].fully_left);
    }

    /// The exemption is voice-presence ONLY. Screen share is the bug the
    /// per-connection work exists for: an inherited share claim is a frozen
    /// ghost tile plus a `screen_sharers` entry replayed to later joiners.
    #[tokio::test]
    async fn share_and_camera_are_not_inherited_on_reconnect() {
        let mut room = Room::new("voice:v7".into(), "voice:v7".into());
        room.add_member(7, 200);
        room.set_media(MediaKind::Stream, 7, 200, true);
        room.set_media(MediaKind::ScreenShare, 7, 200, true);
        room.set_media(MediaKind::Camera, 7, 200, true);
        room.add_member(7, 201); // reconnect, no re-announce

        let released = room.remove_member_conn(7, 200);
        assert!(!released.streamer, "voice presence is inherited");
        assert!(released.screen_sharer, "a dead share must be torn down");
        assert!(released.camera_user, "a dead camera must be torn down");
        assert!(!room.screen_sharers.contains(&7));
        assert!(!room.camera_users.contains(&7));
        assert!(room.streamers.contains(&7));
    }

    /// An explicit stop clears every connection of that user, so the derived
    /// view always agrees with the unconditional *Stopped broadcast — and a
    /// later reap of a stale connection must not re-report it as a second stop.
    ///
    /// This is the PRE-EXISTING behaviour, kept deliberately: the server has no
    /// way to tell a live second device from a half-open socket (both are
    /// registered sessions), and scoping the stop per connection would swallow
    /// it for up to the idle timeout after any reconnect. See Room::clear_media
    /// for the known two-devices-in-one-room limitation this leaves in place.
    #[tokio::test]
    async fn explicit_stop_clears_the_user_and_reap_reports_nothing_further() {
        let mut room = Room::new("voice:v5".into(), "voice:v5".into());
        room.add_member(5, 100);
        room.add_member(5, 101);
        room.set_media(MediaKind::Stream, 5, 100, true);
        room.set_media(MediaKind::Stream, 5, 101, true);
        assert!(room.streamers.contains(&5));

        room.clear_media(MediaKind::Stream, 5);
        assert!(
            !room.streamers.contains(&5),
            "state must match the broadcast"
        );

        // A stale connection reaped afterwards must not fire a duplicate.
        let released = room.remove_member_conn(5, 100);
        assert!(
            !released.streamer,
            "already stopped — no duplicate StreamStopped"
        );
        let released = room.remove_member_conn(5, 101);
        assert!(!released.streamer);
    }

    #[tokio::test]
    async fn slow_consumer_drops_instead_of_buffering_unbounded() {
        let state = test_state();
        // Register a session but NEVER drain its receiver (a client that stopped
        // reading its socket). Keep _rx alive so the channel isn't closed.
        let (tx, _rx) = mpsc::channel::<ServerMessage>(4);
        state.register_session(9, "slow".into(), tx, false, None);
        // Push far more than the channel capacity.
        let mut delivered = 0;
        for _ in 0..1000 {
            if state.send_to_user(9, ServerMessage::Pong) {
                delivered += 1;
            }
        }
        // A bounded channel accepts at most its capacity before try_send fails,
        // so the vast majority are dropped rather than buffered without limit.
        assert!(
            delivered <= 4,
            "bounded channel must drop past capacity, delivered {delivered}"
        );
    }

    // --- Peer-to-peer file transfer registry --------------------------------
    // The registry is what authorizes transfer signalling after the one-off DM
    // check, so its membership rules are a security boundary, not bookkeeping.

    fn transfer(from: UserId, to: UserId, accepted: bool) -> FileTransfer {
        FileTransfer {
            from,
            to,
            accepted,
            touched_at: Instant::now(),
            from_conn: 1,
            to_conn: None,
            parked_offer: None,
        }
    }

    /// Sending a file to your OWN account: both legs are the same user id, so
    /// routing must fall back to CONNECTION ids or each device receives its own
    /// SDP offer back and both ends fail to connect.
    #[tokio::test]
    async fn self_transfer_routes_by_connection_not_user() {
        let mut t = transfer(7, 7, false);
        t.from_conn = 100;
        assert!(t.is_self_transfer());
        // Before the other device accepts there is nowhere to route a reply.
        assert_eq!(t.opposite_conn(100), None);
        // Once accepted, each leg resolves to the OTHER socket.
        t.to_conn = Some(200);
        assert_eq!(
            t.opposite_conn(100),
            Some(200),
            "offering device -> accepting device"
        );
        assert_eq!(
            t.opposite_conn(200),
            Some(100),
            "accepting device -> offering device"
        );
        // peer_of still answers the same user, which is exactly why the
        // connection pin is needed.
        assert_eq!(t.peer_of(7), Some(7));
    }

    #[tokio::test]
    async fn two_party_transfers_never_use_connection_pinning() {
        let mut t = transfer(1, 2, true);
        t.from_conn = 100;
        t.to_conn = Some(200);
        assert!(!t.is_self_transfer());
        // None means "route by user id", the normal path.
        assert_eq!(t.opposite_conn(100), None);
        assert_eq!(t.opposite_conn(200), None);
    }

    #[tokio::test]
    async fn transfer_routes_only_between_its_two_parties() {
        let t = transfer(1, 2, true);
        assert_eq!(
            t.peer_of(1),
            Some(2),
            "sender's messages go to the recipient"
        );
        assert_eq!(
            t.peer_of(2),
            Some(1),
            "recipient's messages go to the sender"
        );
        // A third party naming someone else's transfer id gets nothing: no
        // peer to route to, so the handler refuses rather than relaying.
        assert_eq!(t.peer_of(3), None, "an outsider must not be able to signal");
        assert!(t.involves(1) && t.involves(2) && !t.involves(3));
    }

    /// A transfer between two OTHER people must not become a channel a third
    /// user can inject into by guessing or reusing the id.
    #[tokio::test]
    async fn outsider_cannot_join_someone_elses_transfer() {
        let state = test_state();
        state
            .file_transfers
            .insert("abcd1234".into(), transfer(1, 2, true));
        let entry = state.file_transfers.get("abcd1234").expect("registered");
        assert!(!entry.involves(99));
        assert_eq!(entry.peer_of(99), None);
    }

    /// A sender who crashes mid-transfer must not stay counted against the
    /// per-user cap: the count is over registry entries, so eight abandoned
    /// transfers would refuse every later offer until the 6-hour idle TTL.
    #[tokio::test]
    async fn transfers_are_released_when_the_user_goes_fully_offline() {
        let state = test_state();
        let (tx, _rx) = mpsc::channel::<ServerMessage>(8);
        let (conn, _, _) = state.register_session(21, "sender".into(), tx, false, None);
        state
            .file_transfers
            .insert("xfer-a1b2c3d4".into(), transfer(21, 22, true));
        state
            .file_transfers
            .insert("other-party99".into(), transfer(30, 31, true));

        let (fully_offline, _) = state.unregister_session(21, conn);
        assert!(fully_offline);
        assert!(
            !state.file_transfers.contains_key("xfer-a1b2c3d4"),
            "a fully-offline user's transfers must not keep occupying their cap"
        );
        assert!(
            state.file_transfers.contains_key("other-party99"),
            "other people's transfers must be untouched"
        );
    }

    /// A second device keeps the user online, so their transfers must survive.
    #[tokio::test]
    async fn transfers_survive_while_another_device_is_still_connected() {
        let state = test_state();
        let (tx1, _rx1) = mpsc::channel::<ServerMessage>(8);
        let (tx2, _rx2) = mpsc::channel::<ServerMessage>(8);
        let (conn1, _, _) = state.register_session(23, "dual".into(), tx1, false, None);
        let (_conn2, _, _) = state.register_session(23, "dual".into(), tx2, false, None);
        state
            .file_transfers
            .insert("stillrunning1".into(), transfer(23, 24, true));

        let (fully_offline, _) = state.unregister_session(23, conn1);
        assert!(!fully_offline);
        assert!(
            state.file_transfers.contains_key("stillrunning1"),
            "one device disconnecting must not kill a transfer the other carries"
        );
    }

    /// A reject reason is arbitrary text from another user. Capping it with a
    /// BYTE index panics unless that index is a char boundary — and a panic in
    /// handle_message unwinds the socket task, skipping the disconnect cleanup
    /// that lives after the receive loop. The session and its room memberships
    /// would be left behind permanently: a ghost that still shows online and
    /// can still hold a screen-share claim.
    #[tokio::test]
    async fn reject_reasons_are_capped_without_splitting_a_character() {
        // 3-byte characters: the 120-byte cap lands mid-character.
        let euro = "\u{20ac}".repeat(60);
        let out = crate::ws::truncate_reason_for_test(&format!("a{euro}"));
        assert!(
            out.len() <= 120,
            "must respect the byte cap, got {}",
            out.len()
        );

        // 4-byte characters, cap inside a surrogate-pair-sized sequence.
        let emoji = "\u{1f4a5}".repeat(40);
        assert!(crate::ws::truncate_reason_for_test(&emoji).len() <= 120);

        // Short strings pass through untouched.
        assert_eq!(crate::ws::truncate_reason_for_test("nope"), "nope");

        // And the result is still valid UTF-8 by construction (it is a String).
        let mixed = format!("{}{}", "ok ", "\u{4f60}".repeat(80));
        let capped = crate::ws::truncate_reason_for_test(&mixed);
        assert!(capped.len() <= 120);
        assert!(mixed.starts_with(&capped), "must be a prefix, not mangled");
    }

    /// Unanswered offers are reaped fast; a running transfer may legitimately
    /// take hours over a domestic uplink and must NOT be swept out from under
    /// itself. Both are bounded, so an abandoned transfer can never pin the
    /// per-user cap for the process lifetime.
    #[tokio::test]
    async fn stale_offers_are_reaped_but_live_transfers_survive() {
        let state = test_state();
        // NOW, not a rewound past. `Instant::now() - 10min` panics outright on a
        // machine booted more recently than that, which is exactly what happened
        // the morning after the Wake-on-LAN work left this box with nine minutes
        // of uptime. The gap is created by shifting `now` FORWARD below, which
        // cannot underflow.
        let old = Instant::now();
        // Offered 10 minutes ago and never answered -> past the 2 min offer TTL.
        state.file_transfers.insert(
            "staleoffer1".into(),
            FileTransfer {
                from: 1,
                to: 2,
                accepted: false,
                touched_at: old,
                from_conn: 1,
                to_conn: None,
                parked_offer: None,
            },
        );
        // Accepted and active 10 minutes ago -> well inside the idle TTL.
        state.file_transfers.insert(
            "liverunning".into(),
            FileTransfer {
                from: 1,
                to: 3,
                accepted: true,
                touched_at: old,
                from_conn: 1,
                to_conn: Some(2),
                parked_offer: None,
            },
        );
        // Ten minutes after both were touched: past the 2-minute offer TTL,
        // well inside the idle TTL an accepted transfer gets.
        crate::ws::reap_stale_transfers_at(&state, old + std::time::Duration::from_secs(10 * 60));
        assert!(
            !state.file_transfers.contains_key("staleoffer1"),
            "an offer nobody answered must not linger"
        );
        assert!(
            state.file_transfers.contains_key("liverunning"),
            "a long-running accepted transfer must never be reaped as stale"
        );
    }

    // --- Parked offers ------------------------------------------------------
    // An offer whose target had no qualifying socket is HELD and delivered by
    // deliver_parked_offers when one appears. These pin the qualifying rules:
    // never back to the offering socket, only to the named device when pinned,
    // exactly once, and never for a sender whose own socket has since died
    // (the file bytes live in that tab).

    fn parked_payload(dev: Option<&str>) -> ParkedOffer {
        ParkedOffer {
            from_username: "me".into(),
            name: "f.bin".into(),
            size: 8,
            mime: "application/octet-stream".into(),
            sha256: "ab".repeat(32),
            target_device: dev.map(String::from),
            auth: None,
        }
    }

    fn park(state: &AppState, id: &str, from: UserId, to: UserId, from_conn: u64, dev: Option<&str>) {
        state.file_transfers.insert(
            id.into(),
            FileTransfer {
                from,
                to,
                accepted: false,
                touched_at: Instant::now(),
                from_conn,
                to_conn: None,
                parked_offer: Some(parked_payload(dev)),
            },
        );
    }

    #[tokio::test]
    async fn parked_self_offer_reaches_the_second_device_exactly_once() {
        let state = test_state();
        let (tx, _rx) = mpsc::channel::<ServerMessage>(8);
        let (sender_conn, _, _) = state.register_session(1, "me".into(), tx, false, None);
        park(&state, "parked1", 1, 1, sender_conn, None);

        // The offering socket itself must never collect the offer — that is
        // the dial-a-channel-to-yourself hazard.
        assert!(
            state.deliver_parked_offers(1, sender_conn).offers.is_empty(),
            "the offering socket must not be offered its own file"
        );

        let (tx2, _rx2) = mpsc::channel::<ServerMessage>(8);
        let (second_conn, _, _) = state.register_session(1, "me".into(), tx2, false, None);
        let delivered = state.deliver_parked_offers(1, second_conn);
        assert_eq!(delivered.offers.len(), 1, "the second device collects the parked offer");
        assert!(
            matches!(&delivered.offers[0], ServerMessage::FileOffered { transfer_id, .. } if transfer_id == "parked1"),
            "the delivered message is the held offer"
        );
        // The sender is told the wait ended — their card was explaining a
        // parked offer, and silence would leave it lying.
        assert!(
            delivered.sender_notes.iter().any(|(u, m)| *u == 1
                && matches!(m, ServerMessage::FileParked { transfer_id, .. } if transfer_id == "parked1")),
            "delivery must notify the sender"
        );
        // Delivered-once: the payload is consumed, the record stays for accept.
        assert!(
            state.deliver_parked_offers(1, second_conn).offers.is_empty(),
            "a delivered offer must not be re-delivered"
        );
        assert!(
            state.file_transfers.contains_key("parked1"),
            "delivery must not remove the transfer record itself"
        );
    }

    #[tokio::test]
    async fn parked_offer_from_a_dead_sender_socket_is_dropped() {
        let state = test_state();
        // from_conn 999 was never registered — the offering tab is gone, and
        // with it the file bytes; nothing can honour an accept.
        park(&state, "orphan1", 1, 2, 999, None);
        let (tx, _rx) = mpsc::channel::<ServerMessage>(8);
        let (conn, _, _) = state.register_session(2, "them".into(), tx, false, None);
        let delivery = state.deliver_parked_offers(2, conn);
        assert!(
            delivery.offers.is_empty(),
            "nothing to deliver for a transfer whose sender tab died"
        );
        assert!(
            !state.file_transfers.contains_key("orphan1"),
            "the unfulfillable record is dropped, not left to the reaper"
        );
        // The SENDER is told — a silent drop stranded their card on
        // "waiting" forever, with the record gone no TTL notice ever came.
        assert!(
            delivery.sender_notes.iter().any(|(u, m)| *u == 1
                && matches!(m, ServerMessage::FileCancelled { transfer_id, .. } if transfer_id == "orphan1")),
            "the sender must be told their offer died with their old socket"
        );
    }

    #[tokio::test]
    async fn device_pinned_offer_waits_for_the_named_device_to_attest() {
        let state = test_state();
        let (tx, _rx) = mpsc::channel::<ServerMessage>(8);
        let (sender_conn, _, _) = state.register_session(1, "me".into(), tx, false, None);
        park(&state, "pinned1", 1, 1, sender_conn, Some("dev-laptop"));

        let (tx2, _rx2) = mpsc::channel::<ServerMessage>(8);
        let (second_conn, _, _) = state.register_session(1, "me".into(), tx2, false, None);
        // Connected but not yet attested: the pin cannot match.
        assert!(
            state.deliver_parked_offers(1, second_conn).offers.is_empty(),
            "a device-pinned offer must wait for the device id"
        );
        // The WRONG device attesting must not collect it either.
        state.attest_device(1, second_conn, "dev-phone".into());
        assert!(
            state.deliver_parked_offers(1, second_conn).offers.is_empty(),
            "a different device must not collect a pinned offer"
        );
        state.attest_device(1, second_conn, "dev-laptop".into());
        assert_eq!(
            state.deliver_parked_offers(1, second_conn).offers.len(),
            1,
            "the named device collects the offer once attested"
        );
    }

    #[tokio::test]
    async fn a_reconnected_offering_device_is_not_offered_its_own_file() {
        // Self-transfer hazard beyond conn identity: the offering DEVICE
        // reconnects with a NEW conn while its old socket lingers registered.
        // Conn ids differ, the old conn is still "live" — only the attested
        // device id can say this is the same physical machine.
        let state = test_state();
        let (tx, _rx) = mpsc::channel::<ServerMessage>(8);
        let (old_conn, _, _) = state.register_session(1, "me".into(), tx, false, None);
        state.attest_device(1, old_conn, "dev-pc".into());
        park(&state, "selfdup1", 1, 1, old_conn, None);

        let (tx2, _rx2) = mpsc::channel::<ServerMessage>(8);
        let (new_conn, _, _) = state.register_session(1, "me".into(), tx2, false, None);
        state.attest_device(1, new_conn, "dev-pc".into()); // SAME device, new socket
        assert!(
            state.deliver_parked_offers(1, new_conn).offers.is_empty(),
            "the same physical device must not collect its own offer via a new socket"
        );
        // A genuinely different device still qualifies.
        let (tx3, _rx3) = mpsc::channel::<ServerMessage>(8);
        let (phone_conn, _, _) = state.register_session(1, "me".into(), tx3, false, None);
        state.attest_device(1, phone_conn, "dev-phone".into());
        assert_eq!(
            state.deliver_parked_offers(1, phone_conn).offers.len(),
            1,
            "a different device collects it"
        );
    }

    #[tokio::test]
    async fn parked_two_party_offer_reaches_the_target_on_connect() {
        let state = test_state();
        let (tx, _rx) = mpsc::channel::<ServerMessage>(8);
        let (sender_conn, _, _) = state.register_session(1, "me".into(), tx, false, None);
        park(&state, "friend1", 1, 2, sender_conn, None);
        let (tx2, _rx2) = mpsc::channel::<ServerMessage>(8);
        let (their_conn, _, _) = state.register_session(2, "them".into(), tx2, false, None);
        assert_eq!(
            state.deliver_parked_offers(2, their_conn).offers.len(),
            1,
            "the target's fresh connection collects the held offer"
        );
    }

    #[tokio::test]
    async fn a_reaped_parked_offer_tells_the_sender_it_never_arrived() {
        // The reason must distinguish "they saw it and ignored it" from "it
        // never reached them" — different facts, different next actions.
        let state = test_state();
        let (tx, mut rx) = mpsc::channel::<ServerMessage>(8);
        let (sender_conn, _, _) = state.register_session(1, "me".into(), tx, false, None);
        park(&state, "expired1", 1, 2, sender_conn, None);
        // Age it past the offer TTL.
        state
            .file_transfers
            .get_mut("expired1")
            .unwrap()
            .touched_at = Instant::now();

        crate::ws::reap_stale_transfers_at(&state, Instant::now() + std::time::Duration::from_secs(3 * 60));
        assert!(!state.file_transfers.contains_key("expired1"));
        let mut reason = None;
        while let Ok(msg) = rx.try_recv() {
            if let ServerMessage::FileCancelled { transfer_id, reason: r, .. } = msg {
                if transfer_id == "expired1" {
                    reason = Some(r);
                }
            }
        }
        let reason = reason.expect("the sender must be told the offer expired");
        assert!(
            reason.contains("never came online"),
            "the parked expiry must name the real cause, got: {reason}"
        );
    }
}

#[cfg(test)]
mod device_session_tests {
    use super::*;

    fn test_state() -> Arc<AppState> {
        let pool = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://localhost/does_not_connect")
            .expect("lazy pool");
        AppState::new(pool, "test-secret".into(), None, std::sync::Arc::new(crate::wake::NullWake))
    }

    fn session(controller_conn: u64, host_conn: u64) -> DeviceSession {
        DeviceSession {
            controller_user: 1,
            host_user: 1,
            controller_username: "tester".into(),
            allow_input: true,
            controller_conn,
            host_conn,
            controller_device: "ctl".into(),
            host_device: "host".into(),
            state: DeviceSessionState::Active,
            touched_at: Instant::now(),
            controller_detached_at: None,
            host_detached_at: None,
            reprieved_since: None,
        }
    }

    #[test]
    fn opposite_conn_routes_both_ways() {
        let s = session(10, 20);
        assert_eq!(s.opposite_conn(10), Some(20));
        assert_eq!(s.opposite_conn(20), Some(10));
    }

    /// The load-bearing property. Unlike FileTransfer::opposite_conn — whose
    /// None means "fall back to routing by user id" — None here means REFUSE.
    /// A third connection of the same account must not be able to signal or
    /// inject into a session it is not part of.
    #[test]
    fn a_stranger_conn_gets_no_route() {
        let s = session(10, 20);
        assert_eq!(
            s.opposite_conn(30),
            None,
            "a third socket must not be routable"
        );
        assert_eq!(s.opposite_user(30), None);
        assert!(!s.involves_conn(30));
    }

    #[tokio::test]
    async fn touch_refuses_a_conn_outside_the_session() {
        let state = test_state();
        state.device_sessions.insert("s1".into(), session(10, 20));
        assert_eq!(state.touch_device_session("s1", 10), Some((20, 1)));
        assert_eq!(state.touch_device_session("s1", 20), Some((10, 1)));
        assert_eq!(
            state.touch_device_session("s1", 30),
            None,
            "stranger must not route"
        );
        assert_eq!(
            state.touch_device_session("nope", 10),
            None,
            "unknown session"
        );
    }

    /// A stranger must not be able to end a session merely by naming its id —
    /// that would be a trivial denial of service against your own remote desktop.
    #[tokio::test]
    async fn a_stranger_cannot_end_a_session() {
        let state = test_state();
        state.device_sessions.insert("s1".into(), session(10, 20));
        assert_eq!(state.end_device_session("s1", 30), None);
        assert!(
            state.device_sessions.contains_key("s1"),
            "session must survive"
        );

        assert_eq!(state.end_device_session("s1", 10), Some((20, 1)));
        assert!(!state.device_sessions.contains_key("s1"), "owner ends it");
    }

    /// An ACTIVE session survives its socket dropping — held detached for the
    /// grace window so a backgrounded phone can reattach — and only ITS
    /// sessions are touched. Destroying it here is what made every brief app
    /// switch on mobile fatal.
    #[tokio::test]
    async fn a_departing_conn_detaches_only_its_own_active_sessions() {
        let state = test_state();
        state.device_sessions.insert("mine".into(), session(10, 20));
        state
            .device_sessions
            .insert("other".into(), session(40, 50));

        let (ended, detached) = state.drop_device_sessions_for_conn(10);
        assert!(ended.is_empty(), "an active session is not ended by a socket drop");
        assert_eq!(detached.len(), 1);
        assert_eq!(detached[0].0, "mine");
        assert_eq!(detached[0].1, 20, "the survivor is told the peer is reconnecting");
        let s = state.device_sessions.get("mine").expect("session held for the grace window");
        assert!(s.controller_detached_at.is_some(), "the DEPARTING side is marked");
        assert!(s.host_detached_at.is_none());
        drop(s);
        assert!(
            state
                .device_sessions
                .get("other")
                .is_some_and(|s| s.controller_detached_at.is_none() && s.host_detached_at.is_none()),
            "unrelated session untouched"
        );
    }

    /// A PENDING session cannot survive a socket change — the handshake dies
    /// with the socket, exactly as before the grace window existed.
    #[tokio::test]
    async fn a_pending_session_still_dies_with_its_socket() {
        let state = test_state();
        let mut pending = session(10, 20);
        pending.state = DeviceSessionState::Pending;
        state.device_sessions.insert("p".into(), pending);

        let (ended, detached) = state.drop_device_sessions_for_conn(20);
        assert_eq!(ended.len(), 1);
        assert_eq!(ended[0].1, 10, "the controller is told");
        assert!(detached.is_empty());
        assert!(!state.device_sessions.contains_key("p"));
    }

    /// Reattach rebinds exactly the side whose (user, attested device) pair is
    /// recorded on the session — a user check alone would be wrong here,
    /// because BOTH sides of a v1 session belong to the same account.
    #[tokio::test]
    async fn reattach_rebinds_the_matching_side_and_routes_to_it() {
        let state = test_state();
        state.device_sessions.insert("s1".into(), session(10, 20));
        state.drop_device_sessions_for_conn(20);

        match state.reattach_device_session("s1", 1, "host", 99) {
            DeviceReattachOutcome::Rebound { other_conn, .. } => {
                assert_eq!(other_conn, 10, "the reattacher is told where its peer is")
            }
            _ => panic!("the host's own device must be able to reattach"),
        }
        let s = state.device_sessions.get("s1").expect("still live");
        assert_eq!(s.host_conn, 99);
        assert!(s.host_detached_at.is_none(), "no longer detached");
        drop(s);
        assert_eq!(
            state.touch_device_session("s1", 99),
            Some((10, 1)),
            "relay routing works from the NEW socket"
        );
        // And the OLD socket's late close must not re-detach what it no
        // longer owns: its conn id matches nothing now.
        let (ended, detached) = state.drop_device_sessions_for_conn(20);
        assert!(ended.is_empty() && detached.is_empty());
        assert!(state
            .device_sessions
            .get("s1")
            .is_some_and(|s| s.host_detached_at.is_none()));
    }

    /// The grace is a WINDOW, not a leak: a detached session nobody reclaims
    /// is reaped, and the host's single slot comes back with it.
    #[tokio::test]
    async fn a_detached_session_nobody_reclaims_is_reaped_after_the_grace() {
        let state = test_state();
        state.device_sessions.insert("s1".into(), session(10, 20));
        state.drop_device_sessions_for_conn(20);

        crate::ws::reap_stale_device_sessions(&state);
        assert!(
            state.device_sessions.contains_key("s1"),
            "inside the grace window the session is held"
        );

        state
            .device_sessions
            .get_mut("s1")
            .expect("held")
            .host_detached_at = Some(Instant::now());
        // Gap built by ADDING to `now`, never by rewinding it: a rewound
        // `Instant` panics on a machine booted more recently than the offset.
        crate::ws::reap_stale_device_sessions_at(
            &state,
            Instant::now() + std::time::Duration::from_secs(61),
        );
        assert!(!state.device_sessions.contains_key("s1"));
        assert_eq!(state.count_device_sessions(1, "host"), (0, 0), "slot freed");
    }

    /// A new connect from the same controller device replaces its own
    /// detached corpse — the OS killed the app, the key is gone, no reattach
    /// is coming — but never touches a session whose controller is live.
    #[tokio::test]
    async fn a_new_connect_supersedes_its_own_detached_corpse_only() {
        let state = test_state();
        state.device_sessions.insert("old".into(), session(10, 20));
        state.drop_device_sessions_for_conn(10);

        let superseded = state.supersede_detached_session(1, "ctl", "host");
        assert_eq!(
            superseded,
            Some(("old".to_string(), 20, 1)),
            "the corpse is removed and the host identified for notification"
        );
        assert!(!state.device_sessions.contains_key("old"));

        state.device_sessions.insert("live".into(), session(11, 21));
        assert!(
            state.supersede_detached_session(1, "ctl", "host").is_none(),
            "a session whose controller is still attached is not for taking"
        );
    }

    /// The claim is checked, not believed: the right user with the WRONG
    /// device gets NotYours, and an unknown session id gets NoSuchSession.
    #[tokio::test]
    async fn reattach_refuses_a_wrong_device_and_an_unknown_session() {
        let state = test_state();
        state.device_sessions.insert("s1".into(), session(10, 20));
        state.drop_device_sessions_for_conn(20);

        assert!(matches!(
            state.reattach_device_session("s1", 1, "some-third-device", 99),
            DeviceReattachOutcome::NotYours
        ));
        assert!(matches!(
            state.reattach_device_session("nope", 1, "host", 99),
            DeviceReattachOutcome::NoSuchSession
        ));
        assert!(
            state
                .device_sessions
                .get("s1")
                .is_some_and(|s| s.host_conn == 20 && s.host_detached_at.is_some()),
            "a refused claim must change nothing"
        );
    }

    /// Quiet is not gone: an ACTIVE session whose both sockets are still in
    /// the registry is refreshed at the idle TTL instead of reaped — a phone
    /// with the app minimized legitimately sends no input for as long as the
    /// user is in another app. Sessions whose conns were properly closed or
    /// evicted (so the registry no longer holds them) must still reap. Both
    /// halves of the two-sided check are pinned separately: a session with
    /// only ONE registered socket is not spared, or `&&` could silently
    /// become `||`.
    #[tokio::test]
    async fn an_idle_session_is_spared_only_while_both_sockets_are_registered() {
        let state = test_state();
        let (tx, _rx_ctl) = mpsc::channel::<ServerMessage>(8);
        let (ctl_conn, _, _) = state.register_session(1, "me".into(), tx, false, None);
        let (tx, _rx_host) = mpsc::channel::<ServerMessage>(8);
        let (host_conn, _, _) = state.register_session(1, "me".into(), tx, false, None);

        // Everything is stamped NOW and the reaper is run 181s later, so the
        // same relative gaps hold with arithmetic that cannot underflow.
        let idle = Instant::now();
        let mut live = session(ctl_conn, host_conn);
        live.touched_at = idle;
        state.device_sessions.insert("live".into(), live);
        // Conns the registry has never held — the shape left when a conn was
        // evicted or unregistered without the device-session detach running.
        let mut gone = session(9998, 9999);
        gone.touched_at = idle;
        state.device_sessions.insert("gone".into(), gone);
        // Exactly ONE registered socket: must NOT be spared.
        let mut half_live = session(ctl_conn, 9999);
        half_live.touched_at = idle;
        state.device_sessions.insert("half_live".into(), half_live);

        // 181s after everything was stamped: past the 180s idle TTL.
        crate::ws::reap_stale_device_sessions_at(
            &state,
            idle + std::time::Duration::from_secs(181),
        );

        assert!(
            state.device_sessions.contains_key("live"),
            "both sockets registered -> idle refreshes instead of reaping"
        );
        assert!(
            state
                .device_sessions
                .get("live")
                .is_some_and(|s| Instant::now().duration_since(s.touched_at).as_secs() < 180),
            "the clock must actually be refreshed, or the next tick undoes the reprieve"
        );
        assert!(
            !state.device_sessions.contains_key("gone"),
            "unregistered conns must still hit the idle TTL"
        );
        assert!(
            !state.device_sessions.contains_key("half_live"),
            "one live socket is not two: the check must be a conjunction"
        );

        // A detached side disables the reprieve even though its peer's socket
        // is registered — the detach grace stays the authority there.
        let mut half = session(ctl_conn, host_conn);
        half.touched_at = idle;
        half.host_detached_at = Some(idle);
        state.device_sessions.insert("half".into(), half);
        crate::ws::reap_stale_device_sessions_at(
            &state,
            idle + std::time::Duration::from_secs(181),
        );
        assert!(
            !state.device_sessions.contains_key("half"),
            "an expired detach still reaps whatever the registry says"
        );
    }

    /// The reprieve has a ceiling. A panicked socket task skips its cleanup,
    /// leaving its conn REGISTERED — such a ghost passes the registry check,
    /// and only the REPRIEVE_MAX cap frees the host's slot from it.
    #[tokio::test]
    async fn the_reprieve_cannot_spare_a_session_forever() {
        let state = test_state();
        let (tx, _rx_ctl) = mpsc::channel::<ServerMessage>(8);
        let (ctl_conn, _, _) = state.register_session(1, "me".into(), tx, false, None);
        let (tx, _rx_host) = mpsc::channel::<ServerMessage>(8);
        let (host_conn, _, _) = state.register_session(1, "me".into(), tx, false, None);

        // Shift the REAP MOMENT forward instead of rewinding the timestamps:
        // rewinding a real Instant by 24h panics on a machine booted more
        // recently than that (underflow — it happened). Same relative gaps:
        // at reap time, touched_at is 181s stale and the reprieve is 24h+1s old.
        let base = Instant::now();
        let reap_at = base + std::time::Duration::from_secs(24 * 60 * 60 + 1);
        let mut s = session(ctl_conn, host_conn);
        s.touched_at = reap_at - std::time::Duration::from_secs(181);
        s.reprieved_since = Some(base);
        state.device_sessions.insert("ghost".into(), s);

        crate::ws::reap_stale_device_sessions_at(&state, reap_at);
        assert!(
            !state.device_sessions.contains_key("ghost"),
            "a day of unbroken silence ends the sparing, registered conns or not"
        );

        // Real traffic resets the ceiling — touch clears reprieved_since.
        // The age of the reprieve is irrelevant here — touch clears it
        // whatever it holds — so a fresh Instant avoids the underflow trap.
        let mut s = session(ctl_conn, host_conn);
        s.reprieved_since = Some(Instant::now());
        state.device_sessions.insert("busy".into(), s);
        state.touch_device_session("busy", ctl_conn);
        assert!(
            state
                .device_sessions
                .get("busy")
                .is_some_and(|s| s.reprieved_since.is_none()),
            "relayed traffic must clear the sparing clock"
        );
    }

    /// The detach itself counts as activity. A minimized controller sends
    /// nothing, so idle ages near the TTL are the normal steady state — a
    /// session 150s quiet when its socket dropped used to hit the 180s idle
    /// reap 30s into a grace window documented as 60s.
    #[tokio::test]
    async fn a_detach_refreshes_the_idle_clock_so_the_grace_is_never_truncated() {
        let state = test_state();
        let mut s = session(10, 20);
        // Stamped NOW and compared for MOVEMENT, rather than rewound. The
        // property under test is "the detach resets the idle clock", and a
        // clock that moved forward proves that without needing to express a
        // past instant the machine may be too young to have.
        let stamped = Instant::now();
        s.touched_at = stamped;
        state.device_sessions.insert("s1".into(), s);

        // Enough for the monotonic clock to tick, so `>` below is not a race.
        std::thread::sleep(std::time::Duration::from_millis(5));
        state.drop_device_sessions_for_conn(20);
        assert!(
            state
                .device_sessions
                .get("s1")
                .is_some_and(|s| s.touched_at > stamped),
            "the detach must RESET the idle clock, not leave it where it was"
        );
        assert!(
            state
                .device_sessions
                .get("s1")
                .is_some_and(|s| Instant::now().duration_since(s.touched_at).as_secs() < 2),
            "marking a side detached must restart the idle clock"
        );
        crate::ws::reap_stale_device_sessions(&state);
        assert!(
            state.device_sessions.contains_key("s1"),
            "a fresh detach is inside the grace, whatever the idle age was before"
        );
    }

    #[tokio::test]
    async fn counts_drive_both_caps_independently() {
        let state = test_state();
        state.device_sessions.insert("a".into(), session(10, 20));
        let mut other_host = session(11, 21);
        other_host.host_device = "host2".into();
        state.device_sessions.insert("b".into(), other_host);

        let (mine, on_host) = state.count_device_sessions(1, "host");
        assert_eq!(mine, 2, "both belong to this user");
        assert_eq!(on_host, 1, "only one targets that host device");
    }

    #[tokio::test]
    async fn device_of_conn_reports_only_after_attestation() {
        let state = test_state();
        let (tx, _rx) = mpsc::channel(4);
        let (conn_id, _, _) = state.register_session(1, "u".into(), tx, false, None);
        assert_eq!(
            state.device_of_conn(1, conn_id),
            None,
            "unattested by default"
        );

        state.attest_device(1, conn_id, "devA".into());
        assert_eq!(state.device_of_conn(1, conn_id), Some("devA".into()));
        assert_eq!(state.conn_of_device(1, "devA"), Some(conn_id));
        assert_eq!(state.conn_of_device(1, "devB"), None);
    }

    /// The invariant the disconnect path in ws.rs leans on when deciding
    /// whether to announce `DevicePresence { online: false }`: after a fast
    /// reconnect (new socket attested, old socket closing behind it) the
    /// device is STILL online, and `conn_of_device` must say so once the old
    /// conn is gone — otherwise every reconnect would flash "offline" across
    /// the user's open device lists.
    #[tokio::test]
    async fn a_device_stays_resolvable_after_its_older_socket_unregisters() {
        let state = test_state();
        let (tx_old, _rx_old) = mpsc::channel(4);
        let (old, _, _) = state.register_session(1, "u".into(), tx_old, false, None);
        state.attest_device(1, old, "devA".into());

        let (tx_new, _rx_new) = mpsc::channel(4);
        let (new, _, _) = state.register_session(1, "u".into(), tx_new, false, None);
        state.attest_device(1, new, "devA".into());

        // The old socket is what the disconnect path is about to unregister;
        // it still knows which device it carried.
        assert_eq!(state.device_of_conn(1, old), Some("devA".into()));
        state.unregister_session(1, old);
        // ...and the device is still online on the newer socket, so no
        // offline hint is due.
        assert_eq!(state.conn_of_device(1, "devA"), Some(new));

        // The positive control: when the LAST socket for the device goes,
        // it really is gone.
        state.unregister_session(1, new);
        assert_eq!(state.conn_of_device(1, "devA"), None);
    }
}

#[cfg(test)]
mod session_cap_tests {
    use super::*;

    fn test_state() -> Arc<AppState> {
        let pool = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://localhost/does_not_connect")
            .expect("lazy pool");
        AppState::new(
            pool,
            "test-secret".into(),
            None,
            std::sync::Arc::new(crate::wake::NullWake),
        )
    }

    /// Register, and hand back the receiver so the caller can keep it alive:
    /// dropping it would close the channel and make the session look dead for
    /// reasons that have nothing to do with what these tests measure.
    fn connect(
        state: &AppState,
        delivery: bool,
        claim: Option<&str>,
    ) -> (u64, mpsc::Receiver<ServerMessage>) {
        let (tx, rx) = mpsc::channel::<ServerMessage>(8);
        let (conn_id, _, _) = state.register_session(
            1,
            "tester".into(),
            tx,
            delivery,
            claim.map(|s| s.to_string()),
        );
        (conn_id, rx)
    }

    fn live_conns(state: &AppState) -> Vec<u64> {
        state
            .sessions
            .get(&1)
            .map(|v| v.iter().map(|s| s.conn_id).collect())
            .unwrap_or_default()
    }

    fn device_session(controller_conn: u64, host_conn: u64) -> DeviceSession {
        DeviceSession {
            controller_user: 1,
            host_user: 1,
            controller_username: "tester".into(),
            allow_input: true,
            controller_conn,
            host_conn,
            controller_device: "ctl".into(),
            host_device: "host".into(),
            state: DeviceSessionState::Active,
            touched_at: Instant::now(),
            controller_detached_at: None,
            host_detached_at: None,
            reprieved_since: None,
        }
    }

    #[tokio::test]
    async fn delivery_dedupe_kills_the_same_claim() {
        // Red without the dedupe block: every wake-driven redial stacks
        // another delivery socket, because the Doze-frozen predecessor is not
        // collected until the 75s idle reaper.
        let state = test_state();
        let (first, _r1) = connect(&state, true, Some("dev-a"));
        let (second, _r2) = connect(&state, true, Some("dev-a"));
        assert_eq!(
            live_conns(&state),
            vec![second],
            "one install holds exactly one delivery socket"
        );
        assert_ne!(first, second);
    }

    #[tokio::test]
    async fn two_devices_keep_two_delivery_sockets() {
        // Positive control: the dedupe keys on the DEVICE, not on "is a
        // delivery socket". A phone and a tablet are both entitled to one.
        let state = test_state();
        let (phone, _r1) = connect(&state, true, Some("dev-phone"));
        let (tablet, _r2) = connect(&state, true, Some("dev-tablet"));
        assert_eq!(live_conns(&state), vec![phone, tablet]);
    }

    #[tokio::test]
    async fn an_unclaimed_delivery_socket_is_never_deduped() {
        // A fresh install has not enrolled yet, so it asserts no identity;
        // deduping on absence would hang up an unrelated device.
        let state = test_state();
        let (a, _r1) = connect(&state, true, None);
        let (b, _r2) = connect(&state, true, None);
        assert_eq!(live_conns(&state), vec![a, b]);
    }

    #[tokio::test]
    async fn the_delivery_subcap_evicts_only_delivery_sessions() {
        let state = test_state();
        let (visible_a, _va) = connect(&state, false, None);
        let (visible_b, _vb) = connect(&state, false, None);
        let mut held = Vec::new();
        for _ in 0..4 {
            held.push(connect(&state, true, None));
        }
        let oldest_delivery = held[0].0;
        let (newest, _rn) = connect(&state, true, None);

        let live = live_conns(&state);
        assert!(
            !live.contains(&oldest_delivery),
            "the oldest delivery socket is the victim"
        );
        assert!(
            live.contains(&visible_a) && live.contains(&visible_b),
            "visible clients are untouched by delivery churn"
        );
        assert!(live.contains(&newest));
    }

    #[tokio::test]
    async fn eviction_prefers_a_delivery_ghost_over_a_visible_conn() {
        // The ghost is registered in the MIDDLE, never at index 0 — otherwise
        // "oldest" and "delivery" name the same session and the test would
        // pass against the old `remove(0)` too, proving nothing.
        let state = test_state();
        let mut visible = Vec::new();
        for _ in 0..3 {
            visible.push(connect(&state, false, None));
        }
        let (ghost, _g) = connect(&state, true, None);
        let oldest_visible = visible[0].0;
        for _ in 0..7 {
            visible.push(connect(&state, false, None));
        }
        let live = live_conns(&state);
        assert_eq!(live.len(), 10, "the cap held");
        assert!(
            !live.contains(&ghost),
            "a pocketed phone's socket is the cheapest thing to drop"
        );
        assert!(
            live.contains(&oldest_visible),
            "being oldest is not what makes a session expendable"
        );
        for (c, _) in &visible {
            assert!(live.contains(c), "no visible client was evicted");
        }
    }

    #[tokio::test]
    async fn eviction_spares_a_conn_party_to_a_device_session() {
        // THE REGRESSION TEST. The victim used to be `entry.remove(0)` — the
        // oldest conn — which is exactly the all-day desktop HOSTING a
        // remote-control session. Revert the victim-selection block and this
        // goes red: `pc` is evicted and the session dies with "the other
        // device did not come back".
        let state = test_state();
        let (pc, _pc_rx) = connect(&state, false, None);
        let (controller, _c_rx) = connect(&state, false, None);
        state
            .device_sessions
            .insert("sess-1".into(), device_session(controller, pc));

        let mut later = Vec::new();
        for _ in 0..8 {
            later.push(connect(&state, false, None));
        }
        let (newest, _n) = connect(&state, false, None);

        let live = live_conns(&state);
        assert!(
            live.contains(&pc),
            "the conn hosting a live device session must survive the cap"
        );
        assert!(live.contains(&controller), "so must the conn driving it");
        assert!(live.contains(&newest));
        assert_eq!(live.len(), 10, "the cap still holds");
    }

    #[tokio::test]
    async fn the_cap_still_holds_when_every_conn_is_protected() {
        // Protection must never turn a bound into a leak: if every candidate
        // is party to a device session, something is still evicted.
        let state = test_state();
        let mut conns = Vec::new();
        for _ in 0..10 {
            conns.push(connect(&state, false, None));
        }
        for (i, pair) in conns.chunks(2).enumerate() {
            state
                .device_sessions
                .insert(format!("sess-{i}"), device_session(pair[0].0, pair[1].0));
        }
        let (newest, _n) = connect(&state, false, None);
        let live = live_conns(&state);
        assert_eq!(live.len(), 10, "the cap is a hard bound, protection or not");
        assert!(
            live.contains(&newest),
            "the new connection is never the one refused"
        );
    }

    #[tokio::test]
    async fn a_cross_user_share_protects_this_users_end() {
        // Under a device share the two ends belong to DIFFERENT accounts, so
        // the protected set is filtered by user. Driven through
        // register_session rather than by re-implementing the filter in the
        // test — a test that recomputes the logic it is checking passes no
        // matter what the shipped code does.
        let state = test_state();
        let (mine, _m) = connect(&state, false, None);
        let mut s = device_session(mine, 999_999);
        s.controller_user = 1;
        s.host_user = 2; // the far end is someone else's socket
        state.device_sessions.insert("shared".into(), s);

        for _ in 0..10 {
            connect(&state, false, None);
        }
        assert!(
            live_conns(&state).contains(&mine),
            "the conn driving a SHARED session survives the cap like any other"
        );
    }

    #[tokio::test]
    async fn another_users_conn_id_does_not_protect_this_user() {
        // Conn ids are global. If the protected set were collected without
        // filtering by user, user 2's recorded conn id would shield whichever
        // of user 1's sockets happened to share that number.
        let state = test_state();
        let (tx, _rx) = mpsc::channel::<ServerMessage>(8);
        let (first, _, _) = state.register_session(1, "one".into(), tx, false, None);
        // A session belonging ENTIRELY to user 2, recording user 1's conn id
        // in the slot that is not user 1's.
        let mut s = device_session(555_555, first);
        s.controller_user = 2;
        s.host_user = 2;
        state.device_sessions.insert("theirs".into(), s);

        let mut rest = Vec::new();
        for _ in 0..10 {
            rest.push(connect(&state, false, None));
        }
        assert!(
            !live_conns(&state).contains(&first),
            "a conn is only protected by a session THIS user is party to"
        );
        assert_eq!(live_conns(&state).len(), 10);
    }

    // Multi-thread flavour so the sqlx pool in `test_state` has a runtime; the
    // workers below are real OS threads, not tasks, deliberately.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn registering_never_deadlocks_against_the_reaper() {
        // Victim selection has to know which conns are party to a live device
        // session, which means touching BOTH maps. The reaper already takes
        // them device_sessions -> sessions (conn_is_live runs inside a
        // device_sessions.retain), so registration must take them in that same
        // order — a `sessions` guard held across a `device_sessions` scan is a
        // classic inversion, and DashMap shards are shared across users, so it
        // would deadlock the whole process rather than one account.
        //
        // Runs on real OS threads and watches a PROGRESS COUNTER rather than
        // joining: DashMap blocks the thread, so a deadlock would starve any
        // async timer set to rescue it (measured — a tokio::time::timeout
        // version of this test hung the suite instead of failing it). The
        // watchdog below turns the hang into a clean assertion failure; the
        // stuck threads are reaped when the process exits.
        let state = test_state();
        for i in 0..6u64 {
            state
                .device_sessions
                .insert(format!("s-{i}"), device_session(i * 2, i * 2 + 1));
        }

        let progress = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let mut tasks = Vec::new();
        for u in 0..8i32 {
            let st = Arc::clone(&state);
            let progress = Arc::clone(&progress);
            tasks.push(std::thread::spawn(move || {
                // Sessions are HELD, not registered-and-dropped: the map entry
                // has to be populated for the near-cap probe to actually take
                // a `sessions` read guard, and populated past the cap for
                // victim selection to run at all. A test that leaves the entry
                // empty exercises neither and would pass against an inversion.
                let mut held = Vec::new();
                for _ in 0..40 {
                    let (tx, rx) = mpsc::channel::<ServerMessage>(4);
                    let (conn, _, _) =
                        st.register_session(u as UserId, "u".into(), tx, false, None);
                    held.push((conn, rx));
                    // Interleave the reaper's own access pattern.
                    st.device_sessions.retain(|_, s| {
                        !(st.conn_is_live(u as UserId, s.controller_conn)
                            && s.controller_conn == u64::MAX)
                    });
                    // Keep a standing population so the cap is exercised, but
                    // still churn so unregister participates in the race.
                    if held.len() > 12 {
                        let (old, _) = held.remove(0);
                        st.unregister_session(u as UserId, old);
                    }
                    progress.fetch_add(1, Ordering::Relaxed);
                }
            }));
        }

        // Watchdog: fail on STALLED progress rather than on total runtime, so
        // a slow machine cannot flake this while a genuine deadlock still
        // fails fast.
        const TOTAL: usize = 8 * 40;
        let deadline = Instant::now() + Duration::from_secs(30);
        let mut last = 0;
        let mut stalled_since = Instant::now();
        loop {
            let done = progress.load(Ordering::Relaxed);
            if done >= TOTAL {
                break;
            }
            if done > last {
                last = done;
                stalled_since = Instant::now();
            }
            assert!(
                stalled_since.elapsed() < Duration::from_secs(10) && Instant::now() < deadline,
                "register_session deadlocked against the device_sessions reaper \
                 (stopped at {done}/{TOTAL} registrations)"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        for t in tasks {
            t.join().expect("no thread panicked");
        }
    }

    #[tokio::test]
    async fn undelivered_prune_drops_only_expired_users() {
        let state = test_state();
        for u in 1000..2100i32 {
            state.enqueue_undelivered(u as UserId, ServerMessage::Pong);
        }
        state.enqueue_undelivered(7, ServerMessage::Pong);

        // THE GAP IS BUILT BY ADDING, NEVER SUBTRACTING. `Instant::now() - 61min`
        // panics on a machine booted more recently than that — which is exactly
        // what happened here on a nine-minute-old boot the morning after the
        // Wake-on-LAN work. So user 7's frame is stamped FORWARD instead, and
        // the prune runs a moment after it: everyone else is then an hour stale
        // relative to that point, and 7 is one second fresh.
        let base = Instant::now();
        let fresh = base + Duration::from_secs(60 * 61);
        for mut e in state.undelivered.iter_mut() {
            if *e.key() == 7 {
                for slot in e.value_mut().iter_mut() {
                    slot.0 = fresh;
                }
            }
        }

        let before = state.undelivered.len();
        state.prune_undelivered_at(fresh + Duration::from_secs(1));
        state.enqueue_undelivered(8, ServerMessage::Pong);
        assert!(
            state.undelivered.contains_key(&7),
            "a fresh queue survives the prune"
        );
        assert!(state.undelivered.contains_key(&8));
        assert!(
            state.undelivered.len() < before / 2,
            "stale queues are released rather than held for the process lifetime \
             (before {before}, after {})",
            state.undelivered.len()
        );
    }
}

#[cfg(test)]
mod presence_log_tests {
    use super::*;
    use crate::protocol::ServerMessage;
    use tokio::sync::mpsc;

    fn test_state() -> Arc<AppState> {
        let pool = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://localhost/does_not_connect")
            .expect("lazy pool");
        AppState::new(pool, "test-secret".into(), None, std::sync::Arc::new(crate::wake::NullWake))
    }

    #[test]
    fn a_user_on_two_devices_has_one_span_and_clear_media_does_not_close_it() {
        let mut room = Room::new("voice_9".into(), "voice_9".into());
        room.add_member(5, 1);
        room.add_member(5, 2);
        room.set_media(MediaKind::Stream, 5, 1, true);
        room.set_media(MediaKind::Stream, 5, 2, true);
        assert_eq!(room.presence_log.span_count(), 1);
        room.assert_log_matches_members();
        // The documented user-level clear_media limitation must NOT drop the veto:
        room.clear_media(MediaKind::Stream, 5);
        assert_eq!(room.presence_log.open_users(), [5].into_iter().collect::<HashSet<_>>());
        // One device leaves: still a member, span still open.
        room.remove_member_conn(5, 1);
        assert_eq!(room.presence_log.open_users().len(), 1);
        room.assert_log_matches_members();
        // Last device leaves: span closes, exactly one span total.
        room.remove_member_conn(5, 2);
        assert!(room.presence_log.open_users().is_empty());
        assert_eq!(room.presence_log.span_count(), 1);
        room.assert_log_matches_members();
    }

    #[test]
    fn every_path_that_removes_membership_closes_the_span() {
        let mut room = Room::new("voice_9".into(), "voice_9".into());
        room.add_member(1, 10);
        room.add_member(2, 20);
        room.remove_member(1);
        room.remove_member_conn(2, 20);
        assert!(room.presence_log.open_users().is_empty());
        room.assert_log_matches_members();
        assert_eq!(room.presence_log.span_count(), 2);
    }

    #[test]
    fn overlap_is_inclusive_at_both_edges_and_media_flags_are_ord() {
        let mut log = PresenceLog::new(0);
        log.open_at(7, 100);
        log.mark_media(7, true, false);
        log.close_at(7, 200);
        // touching the start edge / the end edge counts; strictly outside does not
        assert!(log.overlapping(200, 300).contains(&7));
        assert!(log.overlapping(0, 100).contains(&7));
        assert!(!log.overlapping(201, 300).contains(&7));
        assert!(!log.overlapping(0, 99).contains(&7));
        assert_eq!(log.overlapping_media(150, 160).get(&7), Some(&(true, false)));
        // still-open span overlaps any later window
        log.open_at(8, 250);
        assert!(log.overlapping(1_000, 2_000).contains(&8));
        assert!(log.present_throughout(8, 260, 5_000));
        assert!(!log.present_throughout(7, 150, 250));
        assert_eq!(log.first_join_of(7), Some(100));
    }

    #[test]
    fn open_and_close_are_idempotent() {
        let mut log = PresenceLog::new(0);
        log.open_at(1, 10);
        log.open_at(1, 20); // no second span
        assert_eq!(log.span_count(), 1);
        log.close_at(1, 30);
        log.close_at(1, 40); // no-op
        assert_eq!(log.span_count(), 1);
        log.open_at(1, 50); // a real re-join is a second span
        assert_eq!(log.span_count(), 2);
    }

    #[test]
    fn overflow_and_prune_advance_the_watermark() {
        let mut log = PresenceLog::new(0);
        for i in 0..(PresenceLog::MAX_SPANS as i64 + 1) {
            log.open_at(i, i * 10);
            log.close_at(i, i * 10 + 5);
        }
        // the oldest closed span was dropped and the watermark moved to its left_ms
        assert_eq!(log.span_count(), PresenceLog::MAX_SPANS);
        assert!(log.observed_from_ms() >= 5);
        // pruning far in the future forgets everything AND advances the watermark
        let far = 10_000_000 + PresenceLog::RETENTION_MS;
        log.prune_at(far);
        assert_eq!(log.span_count(), 0);
        assert_eq!(log.observed_from_ms(), far - PresenceLog::RETENTION_MS);
        assert!(log.is_expired_at(far));
    }

    #[test]
    fn worst_case_window_is_inside_retention() {
        // A proposal may reach MAX_ENDED_AGO + MAX_CLIP + PAD into the past; the
        // log must still remember it (else the approver set silently shrinks to
        // the client's declared list).
        let mut log = PresenceLog::new(0);
        let now = 100 * 60 * 1000;
        let start = now - PresenceLog::MAX_ENDED_AGO_MS - PresenceLog::MAX_CLIP_MS - PresenceLog::PAD_MS;
        log.open_at(3, start - 1000);
        log.close_at(3, start + 1000);
        log.prune_at(now);
        assert!(log.overlapping(start, now).contains(&3), "retention {} too short", PresenceLog::RETENTION_MS);
    }

    /// The log survives the last member leaving and is restored on rejoin — the
    /// case a lone clipper's socket blip creates. Red if any of the five
    /// room-removal sites bypasses drop_room_if_empty.
    #[tokio::test]
    async fn an_empty_voice_rooms_log_is_kept_and_restored() {
        let state = test_state();
        let (tx, _rx) = mpsc::channel::<ServerMessage>(8);
        let (conn, _, _) = state.register_session(1, "u".into(), tx, false, None);
        state.join_room("voice_42", 1, conn);
        state.join_room("voice_42", 2, 999); // a second user, one socket
        state.leave_room("voice_42", 2, 999);
        // room still has user 1
        assert!(state.rooms.get("voice_42").unwrap().members.contains(&1));
        state.leave_room("voice_42", 1, conn);
        assert!(state.rooms.get("voice_42").is_none(), "empty rooms are still dropped");
        assert!(state.orphan_presence_logs.contains_key("voice_42"), "the log must be kept");
        // rejoin: the log comes back with both closed spans + a new open one
        state.join_room("voice_42", 1, conn);
        let room = state.rooms.get("voice_42").unwrap();
        assert!(!state.orphan_presence_logs.contains_key("voice_42"));
        assert_eq!(room.presence_log.span_count(), 3);
        assert!(room.presence_log.overlapping(0, i64::MAX).contains(&2), "user 2's earlier presence must still be known");
        drop(room);
        // the disconnect path drops rooms too — same rule
        let (_, _) = state.unregister_session(1, conn);
        assert!(state.rooms.get("voice_42").is_none());
        assert!(state.orphan_presence_logs.contains_key("voice_42"));
    }
}
