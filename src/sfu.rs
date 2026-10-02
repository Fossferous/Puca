//! Tier-2 SFU (LiveKit) control plane: join-token minting, node-global egress
//! admission control, and webhook-fed room usage tracking.
//!
//! The SFU itself only ever forwards ciphertext — media E2EE stays client-side
//! (group key derived from the channel-key system in the frontend). This module
//! never touches media or keys; it decides who may join which LiveKit room and
//! keeps the whole node's projected SFU egress inside the home-uplink budget.
//!
//! The budget is deliberately NODE-GLOBAL, not per-room: every SFU room, on any
//! server, drains the same residential uplink (which is also shared with coturn
//! relays and other hosted services), so per-room caps alone cannot prevent
//! saturation.
//!
//! Admission is HYBRID (since stream-watching went opt-in in v0.7.3):
//!
//! 1. Worst-case projection first — assumes every subscriber pulls the focus
//!    stream. If that fits the budget, admit: safe even if everyone watches.
//! 2. When the worst case would refuse, consult the MEASURED node egress
//!    (sampled from LiveKit's Prometheus endpoint by [`spawn_egress_sampler`]).
//!    Admit when `measured + worst-case cost of every seat the sample can't see
//!    yet (reservations, joins newer than the sampling lag, and this joiner)`
//!    still fits. With opt-in watching, actual egress is typically far below
//!    the projection, so this unlocks the seats the old model wrongly refused.
//!    No/stale measurement degrades to (1) alone — exactly the old behaviour.
//!
//! Known limit, accepted by design: a measured-branch admit reflects watching
//! at admission time. Viewers who START watching a share afterwards can push
//! real egress past the budget; LiveKit's congestion control + simulcast layer
//! drops absorb that transiently, and the worst-case ceiling still bounds how
//! many seats exist at all.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use dashmap::DashMap;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::{Extension, Json};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::auth::Claims;
use crate::permissions::{get_user_channel_permissions, ChannelPermAccess, Permissions};
use crate::state::AppState;

// Simulcast ladder the SFU clients publish (see frontend sfuManager): these
// drive the egress projection, so keep them in sync with the client.
const CAM_HIGH_KBPS: u64 = 2_500;
/// The rung every NON-FOCUS camera subscription actually asks for.
///
/// This was 150 (the ladder's bottom rung, 320x180) and the client asked for
/// exactly that — because nothing ever raised an unfocused camera, cameras were
/// permanently 320x180 upscaled into a 640x360 tile. The client now subscribes
/// unfocused cameras at the MID rung (640x360, 500 kbps: `subscribedQuality` in
/// frontend/src/api/rtc/sfuManager.ts), which is the size the tile actually
/// renders. THE TWO MUST MOVE TOGETHER: this constant is what admission charges
/// each subscriber for every other participant, so leaving it at the low rung
/// would under-count real egress and over-admit seats — trading a sharpness
/// complaint for a congestion one.
const CAM_LOW_KBPS: u64 = 150;
const CAM_MID_KBPS: u64 = 500;
/// At or below this head count the client subscribes unfocused cameras at the
/// MID rung, because the voice grid gives each tile a wide column there; above
/// it the tiles are ~320px and the low rung is what it asks for. Keep in step
/// with GRID_MID_MAX_PARTICIPANTS in frontend/src/api/rtc/sfuManager.ts.
const GRID_MID_MAX_PARTICIPANTS: usize = 4;
const SHARE_KBPS: u64 = 4_500;
/// WebRTC/SRTP overhead factor applied to media bitrates (×1.15).
const OVERHEAD_NUM: u64 = 115;
const OVERHEAD_DEN: u64 = 100;

/// How long a minted-but-not-yet-joined token holds a capacity slot. Long
/// enough to cover key fetch + LiveKit connect; short enough that an abandoned
/// mint doesn't wedge the room at "capacity".
const RESERVATION_TTL: Duration = Duration::from_secs(60);

/// Join-token validity. LiveKit "resume" reconnects don't re-present this JWT,
/// and our client fetches a fresh token for full rejoins, so a short TTL costs
/// nothing — while bounding how long a just-revoked member can still join.
const TOKEN_TTL_SECS: u64 = 20 * 60;

/// Max concurrent SFU connections one user may hold in a room (desktop + phone).
/// A hard cap so a single member can't mint unbounded reservations and exhaust
/// the node-global egress budget.
const MAX_OWN_CONNS: usize = 2;

/// A measured-egress sample older than this is treated as "no measurement":
/// the measured admission branch disables itself rather than trust numbers
/// from before the world changed. 3× the sampling interval, so one lost
/// scrape doesn't flap the branch off.
pub const MEASURED_STALE_SECS: u64 = 30;
/// How often the sampler scrapes LiveKit's metrics endpoint.
const SAMPLE_INTERVAL: Duration = Duration::from_secs(10);
/// A participant who joined within this window may not be visible in the
/// sampled rate yet (the sample covers the PREVIOUS interval), so the measured
/// branch still charges them at worst case.
const MEASURE_LAG: Duration = Duration::from_secs(25);

/// Bytes per RTP packet, used ONLY when LiveKit exposes a packet counter but
/// no byte counter (v1.13.4 — see [`parse_outgoing_bytes`]).
///
/// Deliberately near the MTU. Video packets, which dominate the packet count
/// in any call that matters for the egress budget, run close to it; audio
/// packets are far smaller, so audio-heavy rooms are OVER-estimated. That is
/// the safe direction for an admission ceiling — the measured branch then
/// admits fewer seats than reality would allow, never more. When a LiveKit
/// version with the real byte counter is deployed, that counter wins and this
/// approximation stops being used at all.
const AVG_PACKET_BYTES: u64 = 1_100;

/// How long a mint's session attribution ([`SfuMint`]) is kept. Longer than
/// any call in practice; a session older than this simply cannot be cut by
/// session (see [`evict_session_identities`]), and its device's own teardown
/// on RoomLeft still ends it.
const MINT_ATTRIBUTION_TTL: Duration = Duration::from_secs(24 * 3600);

/// Who minted one LiveKit identity: [`AppState::sfu_minted`]. Identities are
/// minted per TOKEN REQUEST (`u<id>#<nonce>`), not per WebSocket, so the
/// minting session's `sid` is what ties an identity to a device.
#[derive(Debug, Clone)]
pub struct SfuMint {
    pub room: String,
    pub user_id: i64,
    pub sid: String,
    pub at: Instant,
}

/// Live + reserved usage of one LiveKit room. Held in
/// [`AppState::sfu_rooms`], keyed by room name (`sfu_<channel id>`).
#[derive(Default)]
pub struct SfuRoomUsage {
    /// Identities the SFU has confirmed joined (webhook `participant_joined`),
    /// with the join time — the measured admission branch charges joins newer
    /// than [`MEASURE_LAG`] at worst case because the egress sample predates
    /// their traffic.
    pub participants: HashMap<String, Instant>,
    /// Identities holding a minted token that hasn't joined yet.
    pub reservations: HashMap<String, Instant>,
    /// Live screen-share track SIDs (webhook `track_published`).
    pub screen_shares: HashSet<String>,
    /// Participants the LiveKit resync must look at again on its next pass: a
    /// removal LiveKit did not confirm (cut again) or a join check the database
    /// could not answer (check again). They stay KNOWN meanwhile - counted by
    /// admission, reachable by every ejection - which forgetting them was not.
    pub recheck: HashMap<String, Mark>,
    /// The publish grant LiveKit is known to hold for each joined session: read
    /// from the `participant_joined` webhook or a ListParticipants listing, or
    /// recorded when LiveKit confirmed an UpdateParticipant. Absent = unknown,
    /// which every check treats as "apply it". Only ever a shortcut: a session
    /// whose recorded grant already equals what its member's permissions give
    /// is not sent the same grant again. See [`regrant_if_stale`].
    pub grants: HashMap<String, Grant>,
    /// Sessions with an UpdateParticipant on its way to LiveKit (a count per
    /// identity; see [`InFlight`]). LiveKit may apply it before a resync's
    /// listing and this process read the answer only after the merge: the
    /// merge takes neither the listed grant nor its difference (drift) for
    /// these.
    pub in_flight: HashMap<String, u32>,
    /// Sessions whose last UpdateParticipant was sent and NOT confirmed: LiveKit
    /// may hold it or the grant recorded in `grants`. Their recorded grant is
    /// no shortcut - [`regrant_if_stale`] sends even a grant equal to it - until
    /// a confirmed update, a join or a leave says what LiveKit holds.
    pub unconfirmed: HashSet<String>,
    /// Bumped on every write to a mark (`mark`, `owe`): the generation of each
    /// session's mark, so a check can tell a debt owed while it ran from the
    /// one it answered ([`clear_answered_mark`]).
    pub mark_seq: u64,
    pub mark_gens: HashMap<String, u64>,
}

/// A session's publish grant as LiveKit enforces it, compared by EFFECT, not
/// by spelling: `can_publish: true` with no source list and one naming all
/// four sources are the same grant (LiveKit's `GetCanPublishSource`, protocol
/// auth/grants.go:326-341). `subscribe` and `data` ride along because
/// UpdateParticipant overwrites them too, and a grant that dropped either
/// would cut the member's listening or the remote-control data lane.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Grant {
    subscribe: bool,
    data: bool,
    /// Bit per source LiveKit lets the session publish: [`SOURCE_BITS`].
    sources: u8,
}

/// The microphone's bit in [`Grant::sources`] - the one source SPEAK decides.
const MIC_BIT: u8 = 1;

/// (publish_sources' spelling, LiveKit's TrackSource enum name, its number,
/// the bit in [`Grant::sources`]). The enum is protocol livekit_models.proto
/// `TrackSource`: CAMERA = 1, MICROPHONE = 2, SCREEN_SHARE = 3,
/// SCREEN_SHARE_AUDIO = 4. LiveKit's grant strings are the enum names
/// lowercased (grants.go `sourceToString`), which is how the join token spells
/// them; the Twirp API takes the enum itself.
const SOURCE_BITS: [(&str, &str, i64, u8); 4] = [
    ("microphone", "MICROPHONE", 2, MIC_BIT),
    ("camera", "CAMERA", 1, 2),
    ("screen_share", "SCREEN_SHARE", 3, 4),
    ("screen_share_audio", "SCREEN_SHARE_AUDIO", 4, 8),
];

impl Grant {
    /// What a member's channel permissions entitle a session to: exactly what
    /// [`mint_join_token`] puts in the token (via [`publish_sources`]), with
    /// subscribe and data always on.
    pub(crate) fn of(perms: Permissions) -> Grant {
        let (can_publish, sources) = publish_sources(perms);
        Grant::effective(true, true, can_publish, &sources)
    }

    /// The grant to give a LIVE session whose member now has `perms`: the one
    /// it holds with ONLY the microphone changed - on for SPEAK, off without.
    /// Camera and screen keep what the session joined with. VIDEO and STREAM
    /// are checked when a camera or share STARTS (ws.rs CameraStart /
    /// ScreenShareStart), on both transports, and a new grant of them applies
    /// at the next join; taking them off a live session here would unpublish a
    /// running camera or share under an app that has no idea it happened, and
    /// would make SFU channels stricter than mesh ones mid-call. SPEAK is the
    /// one right enforced mid-call everywhere. Unknown held grant: the whole
    /// grant `perms` give - what a token minted now would carry. A JOIN-time
    /// check does not use this: it gives [`Grant::of`] (see [`GrantAt`]).
    pub(crate) fn target(held: Option<Grant>, perms: Permissions) -> Grant {
        let full = Grant::of(perms);
        match held {
            None => full,
            Some(h) => Grant {
                subscribe: true,
                data: true,
                sources: (h.sources & !MIC_BIT) | (full.sources & MIC_BIT),
            },
        }
    }

    /// The effect of a (can_publish, source list) pair, as LiveKit reads it.
    fn effective(subscribe: bool, data: bool, can_publish: bool, listed: &[&str]) -> Grant {
        let mut sources = 0u8;
        if can_publish {
            for (grant_name, _, _, bit) in SOURCE_BITS {
                // An empty list is "every source" (grants.go:330-333).
                if listed.is_empty() || listed.contains(&grant_name) {
                    sources |= bit;
                }
            }
        }
        Grant { subscribe, data, sources }
    }

    /// A `ParticipantPermission` as LiveKit reports it, or None when there is
    /// none to read (then the grant is unknown). Accepts both of LiveKit's JSON
    /// shapes: ListParticipants answers in proto field names with every field
    /// emitted, the webhook in camelCase with false and empty fields OMITTED
    /// (protocol utils/protojson Marshal) - so an absent bool is false and an
    /// absent list empty, exactly as protojson decodes them. Enum values may be
    /// names or numbers.
    fn from_permission(p: Option<&serde_json::Value>) -> Option<Grant> {
        let p = p?.as_object()?;
        let field = |snake: &str, camel: &str| p.get(snake).or_else(|| p.get(camel));
        let flag = |snake: &str, camel: &str| field(snake, camel).and_then(|v| v.as_bool()).unwrap_or(false);
        let mut listed: Vec<&str> = Vec::new();
        let mut unrecognised = false;
        for v in field("can_publish_sources", "canPublishSources")
            .and_then(|v| v.as_array())
            .into_iter()
            .flatten()
        {
            match SOURCE_BITS.iter().find(|(_, name, number, _)| enum_is(Some(v), name, *number)) {
                Some((grant_name, ..)) => listed.push(grant_name),
                // UNKNOWN (0) or a source this server does not know: it is in
                // the list, so the list is not empty and does not mean "every
                // source" - it simply allows none of ours.
                None => unrecognised = true,
            }
        }
        let can_publish = flag("can_publish", "canPublish");
        let mut g = Grant::effective(
            flag("can_subscribe", "canSubscribe"),
            flag("can_publish_data", "canPublishData"),
            can_publish,
            &listed,
        );
        if listed.is_empty() && unrecognised {
            g.sources = 0;
        }
        Some(g)
    }
}

/// The `permission` of an UpdateParticipant request for a member with `perms`
/// (protocol livekit_models.proto `ParticipantPermission`). LiveKit REPLACES
/// the session's whole grant with it (grants.go `UpdateFromPermission`), and
/// these are plain proto3 bools, so an omitted one decodes as FALSE: both
/// `can_subscribe` and `can_publish_data` are sent true explicitly, or the
/// member would stop hearing the call and lose the data lane. Sources go as
/// enum NAMES, uppercase: the Twirp decoder runs with DiscardUnknown, which
/// also drops an unknown enum name, so the token's lowercase spelling would
/// silently empty the list - and `can_publish` with an empty list is every
/// source. The fields left out (hidden, can_update_metadata, ...) are false in
/// every join token this server mints, so they stay what they were. Sources are
/// listed EXPLICITLY; no source at all is `can_publish: false`.
fn permission_json(g: Grant) -> serde_json::Value {
    let names: Vec<&str> = SOURCE_BITS
        .iter()
        .filter(|(.., bit)| g.sources & bit != 0)
        .map(|(_, name, ..)| *name)
        .collect();
    serde_json::json!({
        "can_subscribe": g.subscribe,
        "can_publish": g.sources != 0,
        "can_publish_data": g.data,
        "can_publish_sources": names,
    })
}

/// A participant's outstanding [`Recheck`], and how many passes have tried it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Mark {
    pub what: Recheck,
    pub passes: u8,
}

/// RESYNC passes a mark may fail before it is given up (one warn line; the
/// session stays known and counted). Bounds a check that can never be answered
/// and a cut LiveKit keeps refusing, which would otherwise keep
/// SFU_RESYNC_SECS=0 resyncing every 30 s for good. Only a resync pass counts
/// ([`mark`]): a sweep, kick or join check that fails outside one only makes
/// sure a mark exists ([`owe`]), or six failed sweeps between two resyncs
/// would give a mark up before any resync had retried it.
const MARK_PASSES: u8 = 5;

/// What the next resync owes a participant in [`SfuRoomUsage::recheck`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Recheck {
    /// It was to be removed and LiveKit did not confirm it: remove it again.
    Cut,
    /// A JOIN-TIME check could not be completed (the database did not answer,
    /// a removal or a grant was not confirmed): run the check again, and give
    /// the join-time grant ([`GrantAt::Join`]).
    JoinCheck,
    /// A check of a LIVE session could not be completed - the perms-change
    /// sweep's grant was not confirmed, or the resync's check of a session it
    /// learned (a live one, as far as this process can tell) went unanswered:
    /// run the check again, and give the live grant ([`GrantAt::Live`] - only
    /// the microphone moves).
    LiveGrant,
}

impl Recheck {
    /// The stronger of two debts on one session: a Cut (it must go) over a
    /// join-time check (the whole grant, or removal) over a live grant (the
    /// microphone alone). A mark only ever moves up this order, so a later,
    /// weaker failure never erases what an earlier one owed.
    fn stronger(self, other: Recheck) -> Recheck {
        let rank = |r: Recheck| match r {
            Recheck::LiveGrant => 0,
            Recheck::JoinCheck => 1,
            Recheck::Cut => 2,
        };
        if rank(other) > rank(self) {
            other
        } else {
            self
        }
    }
}

/// Which grant a check gives a session its member is entitled to keep.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum GrantAt {
    /// A JOIN this process can place: the `participant_joined` check, a
    /// reservation the resync finds already joined (its webhook never came),
    /// and a known session whose listed grant drifted from the one this
    /// process held (a rejoin with an older token whose webhook was lost).
    /// The WHOLE grant the member's permissions give now, camera and screen
    /// included - exactly what a token minted now would carry. The mic-only
    /// rule's reason (not pulling a running camera or share out from under an
    /// app mid-call) does not apply to a join, and on SFU the LiveKit grant is
    /// the only binding control for VIDEO and STREAM: receivers render a
    /// camera nobody announced. A member whose token matches their
    /// permissions already holds it, so this costs no call in the normal case.
    Join,
    /// A LIVE session: the perms-change sweep, and a session the resync learns
    /// that this process never saw join - after a backend restart that is
    /// every call in progress, possibly hours in, camera and share running.
    /// Only the microphone moves ([`Grant::target`]).
    Live,
}

impl GrantAt {
    /// The grant to give a session holding `held`, whose member has `perms`.
    fn want(self, held: Option<Grant>, perms: Permissions) -> Grant {
        match self {
            GrantAt::Join => Grant::of(perms),
            GrantAt::Live => Grant::target(held, perms),
        }
    }

    /// The mark that owes this check again.
    fn recheck(self) -> Recheck {
        match self {
            GrantAt::Join => Recheck::JoinCheck,
            GrantAt::Live => Recheck::LiveGrant,
        }
    }

    /// This check, raised to the join-time one when that is what the session
    /// owes now (`owed`: its current mark). A Cut owes a removal, which no
    /// grant answers; it leaves the grant as it is and keeps its mark (see
    /// [`clear_answered_mark`]).
    fn at_least(self, owed: Option<Recheck>) -> GrantAt {
        match owed {
            Some(Recheck::JoinCheck) => GrantAt::Join,
            _ => self,
        }
    }
}

struct SfuConfig {
    /// Client-facing signaling URL (e.g. wss://sfu.example.com).
    url: String,
    /// LIVEKIT_API_URL: where this process reaches LiveKit's server API. See
    /// [`api_base`].
    api_url: Option<String>,
    api_key: String,
    api_secret: String,
    /// Node-wide projected-egress ceiling, kbps.
    budget_kbps: u64,
    room_max_participants: usize,
    max_screen_shares: usize,
}

/// LiveKit Prometheus endpoint the egress sampler scrapes. Defaults to the
/// local node's standard port; set `SFU_METRICS_URL=off` to disable the
/// sampler (admission then uses the worst-case projection alone).
fn sfu_metrics_url() -> Option<String> {
    let v = std::env::var("SFU_METRICS_URL")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| "http://127.0.0.1:6789/metrics".to_string());
    (v != "off").then_some(v)
}

#[cfg(test)]
tokio::task_local! {
    /// A stand-in LiveKit's base URL for the future a test scopes with it:
    /// `sfu_config` then answers [`cfg_for`] of it. Task-local rather than env
    /// vars, which every test in the process would read - so a test elsewhere
    /// (the perms sweep in ws.rs) can aim this module's calls at a stand-in.
    /// A task spawned inside the scope does NOT inherit it.
    pub(crate) static TEST_LIVEKIT: String;
}

/// `fut`, boxed for `tokio::spawn`. In a test it carries the spawning task's
/// stand-in LiveKit ([`TEST_LIVEKIT`]) into the new task, which would not
/// inherit it; everywhere else it is only the future.
pub(crate) fn carry_test_livekit<F>(fut: F) -> std::pin::Pin<Box<dyn std::future::Future<Output = F::Output> + Send>>
where
    F: std::future::Future + Send + 'static,
    F::Output: Send + 'static,
{
    #[cfg(test)]
    if let Ok(base) = TEST_LIVEKIT.try_with(|b| b.clone()) {
        return Box::pin(TEST_LIVEKIT.scope(base, fut));
    }
    Box::pin(fut)
}

/// The secret the stand-in LiveKit verifies tokens under.
#[cfg(test)]
pub(crate) const RIG_SECRET: &str = "rig-secret-0123456789abcdef0123456789";

/// A config aimed at a stand-in at `base`.
#[cfg(test)]
fn cfg_for(base: &str) -> SfuConfig {
    SfuConfig {
        url: base.replacen("http://", "ws://", 1),
        api_url: None,
        api_key: "rig-key".into(),
        api_secret: RIG_SECRET.into(),
        budget_kbps: 30_000,
        room_max_participants: 8,
        max_screen_shares: usize::MAX,
    }
}

/// All-or-nothing: an unset/blank var means the SFU tier is not deployed and
/// every mint request answers 503, leaving the mesh path untouched.
fn sfu_config() -> Option<SfuConfig> {
    #[cfg(test)]
    if let Ok(base) = TEST_LIVEKIT.try_with(|b| b.clone()) {
        return Some(cfg_for(&base));
    }
    let getenv = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());
    Some(SfuConfig {
        url: getenv("LIVEKIT_URL")?,
        api_url: getenv("LIVEKIT_API_URL"),
        api_key: getenv("LIVEKIT_API_KEY")?,
        api_secret: getenv("LIVEKIT_API_SECRET")?,
        budget_kbps: getenv("SFU_EGRESS_BUDGET_MBPS")
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(30)
            * 1000,
        room_max_participants: getenv("SFU_ROOM_MAX_PARTICIPANTS")
            .and_then(|v| v.parse::<usize>().ok())
            .unwrap_or(8),
        // Unset or 0 = unlimited. The egress model charges every live share
        // (see room_egress_kbps), so admission — not this cap — is what keeps
        // shares inside the node's uplink envelope.
        max_screen_shares: getenv("SFU_MAX_SCREEN_SHARES")
            .and_then(|v| v.parse::<usize>().ok())
            .map(|n| if n == 0 { usize::MAX } else { n })
            .unwrap_or(usize::MAX),
    })
}

pub fn room_name_for_channel(channel_id: i64) -> String {
    format!("sfu_{channel_id}")
}

/// Where this process reaches LiveKit's server API (RoomService): LIVEKIT_API_URL
/// when set, else the client-facing LIVEKIT_URL; ws(s):// is read as http(s)://
/// in either.
///
/// Set it to the node's own listener (`http://127.0.0.1:7880` in the standard
/// deploy) wherever LiveKit runs on the same host. The public URL goes out
/// through the CDN and back in - and on a host DNS does NOT point at (a standby)
/// it reaches the live node instead of this host's own, so that host's kicks
/// and resyncs would act on calls it does not serve.
fn api_base(cfg: &SfuConfig) -> String {
    cfg.api_url
        .as_deref()
        .unwrap_or(&cfg.url)
        .replacen("wss://", "https://", 1)
        .replacen("ws://", "http://", 1)
        .trim_end_matches('/')
        .to_string()
}

/// Inverse of [`room_name_for_channel`]: `sfu_<id>` → channel id.
pub fn channel_id_from_room(room: &str) -> Option<i64> {
    room.strip_prefix("sfu_")
        .and_then(|s| s.parse::<i64>().ok())
}

/// Parse the user id out of a per-connection identity `u<id>#<nonce>`.
pub fn user_id_from_identity(identity: &str) -> Option<i64> {
    identity
        .strip_prefix('u')
        .and_then(|s| s.split('#').next())
        .and_then(|s| s.parse::<i64>().ok())
}

/// Projected server egress for one room under the mitigated model: every
/// subscriber pulls the live screen shares (the client subscribes each share
/// a user watches, and shares have no low simulcast layer to fall back to —
/// so each one is charged at full rate) or, with no share live, one high
/// camera layer as focus — plus low layers for the rest of the grid.
fn room_egress_kbps(participants: usize, screen_shares: usize) -> u64 {
    if participants < 2 {
        return 0;
    }
    let n = participants as u64;
    let focus = if screen_shares > 0 {
        SHARE_KBPS * screen_shares as u64
    } else {
        CAM_HIGH_KBPS
    };
    let others = if participants <= GRID_MID_MAX_PARTICIPANTS { CAM_MID_KBPS } else { CAM_LOW_KBPS };
    let per_subscriber = focus + n.saturating_sub(2) * others;
    n * per_subscriber * OVERHEAD_NUM / OVERHEAD_DEN
}

/// Node-wide projected egress if one more participant were admitted to
/// `adding_to`. A room absent from the map contributes 0 (first participant
/// alone generates no egress).
fn node_projected_egress_kbps(state: &AppState, adding_to: &str) -> u64 {
    state
        .sfu_rooms
        .iter()
        .map(|r| {
            let extra = usize::from(r.key() == adding_to);
            let n = r.participants.len() + r.reservations.len() + extra;
            room_egress_kbps(n, r.screen_shares.len())
        })
        .sum()
}

/// Worst-case egress a room ADDS on top of what the sampler has already seen:
/// full projection for all seats minus the projection for the seats whose
/// traffic is old enough to be inside the measurement window.
fn unmeasured_room_kbps(settled: usize, total: usize, shares: usize) -> u64 {
    room_egress_kbps(total, shares).saturating_sub(room_egress_kbps(settled, shares))
}

/// How old a participant's join must be to count as INCLUDED in the stored
/// sample. The sample covers a window that ended when it was taken, so the
/// bar slides back by the sample's own age: with a sample `age` seconds old,
/// only joins older than `MEASURE_LAG + age` are certainly inside it.
///
/// Judging against `MEASURE_LAG` alone (as the first cut did) was unsound
/// whenever a scrape was lost: one failed scrape leaves the stored sample up
/// to `MEASURED_STALE_SECS` old while still "fresh", and joins made after
/// that sample would then be charged in NEITHER `measured` nor `pending` —
/// admitting a seat against egress that already existed.
fn settled_cutoff(sample_age_secs: u64) -> Duration {
    MEASURE_LAG + Duration::from_secs(sample_age_secs)
}

/// Measured-branch projection: real sampled node egress plus the worst-case
/// cost of every seat the sample cannot include yet — reservations, joins
/// newer than [`settled_cutoff`], and the seat being requested. `None` when
/// the measurement is missing or stale (caller then has only the worst case).
fn node_measured_projection_kbps(state: &AppState, adding_to: &str) -> Option<u64> {
    let sampled_at = state.sfu_measured_at.load(Ordering::Relaxed);
    let now_unix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if sampled_at == 0 || now_unix.saturating_sub(sampled_at) > MEASURED_STALE_SECS {
        return None;
    }
    let measured = state.sfu_measured_egress_kbps.load(Ordering::Relaxed);
    let now = Instant::now();
    let cutoff = settled_cutoff(now_unix.saturating_sub(sampled_at));
    let pending: u64 = state
        .sfu_rooms
        .iter()
        .map(|r| {
            let settled = r
                .participants
                .values()
                .filter(|joined| now.duration_since(**joined) >= cutoff)
                .count();
            let extra = usize::from(r.key() == adding_to);
            let total = r.participants.len() + r.reservations.len() + extra;
            unmeasured_room_kbps(settled, total, r.screen_shares.len())
        })
        .sum();
    Some(measured + pending)
}

/// Sum every `livekit_packet_bytes{direction="outgoing",…}` sample in a
/// Prometheus text exposition. `None` when no such series exists (wrong
/// endpoint, or a LiveKit version that exposes neither counter).
///
/// TWO counters are accepted, because they are version-dependent and the
/// deployed LiveKit (v1.13.4) has only the second:
///
///  - `livekit_packet_bytes{direction="outgoing"}` — exact bytes. Newer
///    LiveKit only. Preferred whenever present.
///  - `livekit_node_packet_total{type="out"}` — PACKETS, present since
///    v1.13.x. Converted with [`AVG_PACKET_BYTES`].
///
/// Supporting only the byte counter (the first cut) left the measured branch
/// permanently inert on the version actually running in production: the
/// series never existed, every scrape parsed to `None`, and admission silently
/// stayed worst-case-only forever. The endpoint answered 200 the whole time,
/// so nothing looked broken.
fn parse_outgoing_bytes(text: &str) -> Option<u64> {
    let mut bytes = 0f64;
    let mut saw_bytes = false;
    let mut packets = 0f64;
    let mut saw_packets = false;

    for line in text.lines() {
        if line.starts_with('#') {
            continue;
        }
        let mut fields = line.split_whitespace();
        let Some(name_labels) = fields.next() else {
            continue;
        };
        let Some(value) = fields.next() else { continue };
        let metric = name_labels.split('{').next().unwrap_or("");
        // Reject NaN/±Inf outright: NaN poisons the sum, and `NaN as u64` is
        // 0 — which would read as "node idle" and over-admit.
        let Ok(v) = value.parse::<f64>() else {
            continue;
        };
        if !v.is_finite() {
            continue;
        }
        match metric {
            "livekit_packet_bytes" | "livekit_packet_bytes_total"
                if name_labels.contains("direction=\"outgoing\"") =>
            {
                bytes += v;
                saw_bytes = true;
            }
            "livekit_node_packet_total" if name_labels.contains("type=\"out\"") => {
                packets += v;
                saw_packets = true;
            }
            _ => {}
        }
    }

    if saw_bytes {
        return Some(bytes as u64);
    }
    if saw_packets {
        return Some((packets * AVG_PACKET_BYTES as f64) as u64);
    }
    None
}

/// Background task: every [`SAMPLE_INTERVAL`], scrape LiveKit's Prometheus
/// endpoint and turn the outgoing-bytes counter into a rate, stored in
/// [`AppState`] for the measured admission branch. Every failure mode simply
/// stops updating `sfu_measured_at`, which stales the measurement out and
/// returns admission to the worst-case projection — never fail open.
pub fn spawn_egress_sampler(state: Arc<AppState>) {
    let Some(url) = sfu_metrics_url() else {
        tracing::info!("SFU egress sampler disabled (SFU_METRICS_URL=off)");
        return;
    };
    if sfu_config().is_none() {
        return; // no SFU tier deployed — nothing to measure
    }
    tokio::spawn(async move {
        let client = match reqwest::Client::builder()
            .user_agent(HTTP_USER_AGENT)
            .timeout(Duration::from_secs(3))
            .build()
        {
            Ok(c) => c,
            Err(e) => {
                tracing::error!("SFU egress sampler: client build failed: {}", crate::http_err::http_err(&e));
                return;
            }
        };
        let mut prev: Option<(Instant, u64)> = None;
        let mut interval = tokio::time::interval(SAMPLE_INTERVAL);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        // Log endpoint trouble once per outage, not every 10s forever.
        let mut reported_down = false;
        loop {
            interval.tick().await;
            let bytes = match client.get(&url).send().await {
                Ok(resp) if resp.status().is_success() => match resp.text().await {
                    Ok(body) => parse_outgoing_bytes(&body),
                    Err(_) => None,
                },
                _ => None,
            };
            match bytes {
                Some(counter) => {
                    let now = Instant::now();
                    if let Some((t0, c0)) = prev {
                        let dt = now.duration_since(t0).as_secs_f64();
                        // A counter that went backwards means LiveKit restarted:
                        // reseed silently instead of storing a garbage rate.
                        if dt >= 1.0 && counter >= c0 {
                            let kbps = ((counter - c0) as f64 * 8.0 / 1000.0 / dt) as u64;
                            let prev_kbps =
                                state.sfu_measured_egress_kbps.swap(kbps, Ordering::Relaxed);
                            let unix = SystemTime::now()
                                .duration_since(UNIX_EPOCH)
                                .map(|d| d.as_secs())
                                .unwrap_or(0);
                            state.sfu_measured_at.store(unix, Ordering::Relaxed);
                            // Log the idle<->active transitions only: proof in
                            // the journal that the counter really does move
                            // under live media (it reads a flat 0 on an idle
                            // node, which is indistinguishable from a metric
                            // that never increments), without a line every 10s.
                            if (prev_kbps == 0) != (kbps == 0) {
                                tracing::info!(
                                    measured_kbps = kbps,
                                    "SFU egress sampler: measured egress {}",
                                    if kbps == 0 {
                                        "returned to idle"
                                    } else {
                                        "became non-zero"
                                    }
                                );
                            }
                        }
                    }
                    prev = Some((now, counter));
                    if reported_down {
                        tracing::info!("SFU egress sampler: metrics endpoint back up");
                        reported_down = false;
                    }
                }
                None => {
                    // Rate needs two consecutive good samples — a gap invalidates
                    // the pair, and the stored sample ages out on its own.
                    prev = None;
                    if !reported_down {
                        tracing::warn!(
                            url,
                            "SFU egress sampler: metrics unavailable; admission falls back to worst-case projection"
                        );
                        reported_down = true;
                    }
                }
            }
        }
    });
}

/// Drop expired reservations and empty room entries.
fn prune(state: &AppState) {
    let now = Instant::now();
    state.sfu_minted.retain(|_, m| now.duration_since(m.at) < MINT_ATTRIBUTION_TTL);
    for mut r in state.sfu_rooms.iter_mut() {
        r.reservations
            .retain(|_, minted| now.duration_since(*minted) < RESERVATION_TTL);
    }
    state.sfu_rooms.retain(|_, u| {
        !(u.participants.is_empty() && u.reservations.is_empty() && u.screen_shares.is_empty())
    });
    // A grant is only ever known for a joined session. The paths that forget a
    // session drop its grant themselves or run this after them (the resync's
    // merge); whatever is left over is dropped here.
    for mut r in state.sfu_rooms.iter_mut() {
        let u = &mut *r;
        u.grants.retain(|id, _| u.participants.contains_key(id));
        u.unconfirmed.retain(|id| u.participants.contains_key(id));
        u.mark_gens.retain(|id, _| u.participants.contains_key(id));
    }
}

// --- Resync from LiveKit -----------------------------------------------------
//
// `sfu_rooms` is otherwise fed only by mints and webhooks, so a restarted
// backend knew nobody already in a call: a kick, ban or permission change could
// not eject them, and admission counted their room as empty. The reconciler asks
// LiveKit's RoomService which rooms and sessions exist - at startup, then every
// SFU_RESYNC_SECS - and merges that in. It restores KNOWLEDGE only and never
// ejects anyone itself: ejections still come from real events, so neither a
// standby host nor a database that is briefly unreachable at boot can drop a
// live call through it.

/// Period of the reconcile after the first success (SFU_RESYNC_SECS overrides;
/// 0 = stop after the first success). Also what repairs a lost webhook.
const RESYNC_EVERY: Duration = Duration::from_secs(180);
/// The shortest period SFU_RESYNC_SECS may set: each pass is 1 + (rooms) calls.
const RESYNC_MIN: Duration = Duration::from_secs(10);
/// Sent on every request this server makes to LiveKit. A CDN in front of the
/// API (Cloudflare's browser check, say) challenges a request with none.
const HTTP_USER_AGENT: &str = "puca-server";
/// Waits between failed attempts - LiveKit down, or started after the backend
/// (nothing orders the two units on a reboot).
const RESYNC_RETRY_SECS: [u64; 6] = [1, 2, 4, 8, 16, 30];
/// Events one resync will journal before it abandons that snapshot: a storm
/// that large means the snapshot is stale anyway, and the next one will do.
const JOURNAL_CAP: usize = 10_000;

/// One LiveKit room as the resync sees it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LkRoom {
    pub name: String,
    /// Identities in state ACTIVE: the state `participant_joined` reports.
    pub participants: Vec<String>,
    /// Sids of tracks whose source is SCREEN_SHARE.
    pub share_sids: Vec<String>,
    /// The publish grant LiveKit reports for each listed session that carried
    /// a readable `permission` (see [`parse_listed_grants`]).
    pub grants: HashMap<String, Grant>,
}

/// Webhook events and confirmed evictions seen while a snapshot was in flight.
/// The snapshot is older than every one of them, so the merge never undoes one.
#[derive(Debug, Default)]
pub struct SfuResyncJournal {
    joined: HashSet<(String, String)>,
    left: HashSet<(String, String)>,
    published: HashSet<(String, String)>,
    unpublished: HashSet<(String, String)>,
    finished: HashSet<String>,
    /// (room, user id) ejections requested during the fetch. One that found
    /// nothing to remove may concern a session only the snapshot knows.
    evict_intents: HashSet<(String, i64)>,
    /// (room, identity) sessions whose recorded grant this process changed
    /// during the fetch - one LiveKit confirmed ([`update_grant`]) or one it
    /// forgot ([`forget_grant`]). Newer than the listing: the merge keeps it.
    grants: HashSet<(String, String)>,
    overflowed: bool,
}

/// An event for [`journal`]: (room, identity) or (room, track sid).
pub(crate) enum JournalEntry<'a> {
    Joined(&'a str, &'a str),
    Left(&'a str, &'a str),
    Published(&'a str, &'a str),
    Unpublished(&'a str, &'a str),
    Finished(&'a str),
    EvictIntent(&'a str, i64),
    /// (room, identity): the recorded grant changed.
    GrantChanged(&'a str, &'a str),
}

impl SfuResyncJournal {
    fn len(&self) -> usize {
        self.joined.len()
            + self.left.len()
            + self.published.len()
            + self.unpublished.len()
            + self.finished.len()
            + self.evict_intents.len()
            + self.grants.len()
    }

    fn record(&mut self, e: JournalEntry<'_>) {
        if self.len() >= JOURNAL_CAP {
            self.overflowed = true;
            return;
        }
        let pair = |r: &str, k: &str| (r.to_string(), k.to_string());
        match e {
            JournalEntry::Joined(r, i) => {
                self.joined.insert(pair(r, i));
            }
            JournalEntry::Left(r, i) => {
                self.left.insert(pair(r, i));
            }
            JournalEntry::Published(r, s) => {
                self.published.insert(pair(r, s));
            }
            JournalEntry::Unpublished(r, s) => {
                self.unpublished.insert(pair(r, s));
            }
            JournalEntry::Finished(r) => {
                self.finished.insert(r.to_string());
            }
            JournalEntry::EvictIntent(r, uid) => {
                self.evict_intents.insert((r.to_string(), uid));
            }
            JournalEntry::GrantChanged(r, i) => {
                self.grants.insert(pair(r, i));
            }
        }
    }

    fn has(set: &HashSet<(String, String)>, room: &str, key: &str) -> bool {
        set.contains(&(room.to_string(), key.to_string()))
    }
}

/// Record an event for an in-flight resync, if there is one. Call it BEFORE
/// touching `sfu_rooms` and never while holding one of its guards: the merge
/// holds this lock while it writes the map, so the order is journal, then map.
pub(crate) fn journal(state: &AppState, e: JournalEntry<'_>) {
    let mut g = state.sfu_resync_journal.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(j) = g.as_mut() {
        j.record(e);
    }
}

/// What one resync saw and did. Counts only: which person was in which call is
/// not something this server keeps a record of (see `AppState::clip_proposals`).
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct ResyncReport {
    pub rooms: usize,
    pub participants: usize,
    pub shares: usize,
    /// Rooms LiveKit listed that are not `sfu_<channel id>`.
    pub ignored: usize,
    /// Sessions and shares this process did not know about.
    pub added: usize,
    /// Sessions and shares it knew that LiveKit no longer has.
    pub cleared: usize,
    /// Reservations LiveKit already lists as joined: their `participant_joined`
    /// was still on its way, which is not drift.
    pub moved: usize,
    /// Ejections requested during the fetch, re-applied to sessions it added.
    pub reapplied: usize,
    /// Sessions the join check refused (see [`reauthorize_added`]).
    pub denied: usize,
    /// Participants still marked for the next pass (see [`Recheck`]).
    pub pending: usize,
    /// Checked sessions whose LiveKit grant did not match their member's
    /// permissions and that LiveKit confirmed were given the right one.
    pub regranted: usize,
}

/// A merge's result: its counts, the (room, identity) sessions it ADDED, the
/// reservations it MOVED to participants, and the marked sessions LiveKit
/// still lists, with what each is owed. Their marks stay in place: success
/// clears one, failure counts another pass.
pub struct Merged {
    pub report: ResyncReport,
    pub added: Vec<(String, String)>,
    /// Listed identities that still held a reservation. Not drift (their
    /// `participant_joined` may simply be on its way), but not checked either:
    /// if that webhook was lost, nothing else ever runs their join check.
    pub moved: Vec<(String, String)>,
    pub due: Vec<(String, String, Recheck)>,
}

/// Why a resync failed. Every failure leaves `sfu_rooms` exactly as it was.
#[derive(Debug)]
pub enum ResyncError {
    Token(String),
    Transport(String),
    Refused(u16, String),
    Malformed(String),
    /// Too many events during the fetch to trust the snapshot; retried.
    Busy,
}

impl std::fmt::Display for ResyncError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ResyncError::Token(e) => write!(f, "could not sign a server-API token: {e}"),
            ResyncError::Transport(e) => write!(f, "{e}"),
            ResyncError::Refused(401, e) => write!(
                f,
                "LiveKit refused the server-API token (401): {e} - check LIVEKIT_API_KEY and LIVEKIT_API_SECRET, and this host's clock"
            ),
            ResyncError::Refused(s, e) => write!(f, "LiveKit answered {s}: {e}"),
            ResyncError::Malformed(e) => write!(f, "{e}"),
            ResyncError::Busy => write!(f, "too many events arrived during the snapshot; it was discarded"),
        }
    }
}

/// An enum field as protobuf JSON may carry it: the name, or the number.
fn enum_is(v: Option<&serde_json::Value>, name: &str, number: i64) -> bool {
    match v {
        Some(serde_json::Value::String(s)) => s == name,
        Some(serde_json::Value::Number(n)) => n.as_i64() == Some(number),
        _ => false,
    }
}

/// `{"rooms":[{"name":..},..]}` -> names. LiveKit's Twirp JSON emits unset
/// fields too, so a reply without the list is not "no rooms" but not a reply.
fn parse_room_names(body: &str) -> Result<Vec<String>, String> {
    let v: serde_json::Value =
        serde_json::from_str(body).map_err(|e| format!("ListRooms reply is not JSON: {e}"))?;
    let rooms = v
        .get("rooms")
        .and_then(|r| r.as_array())
        .ok_or("ListRooms reply carries no rooms list")?;
    rooms
        .iter()
        .map(|r| {
            r.get("name")
                .and_then(|n| n.as_str())
                .map(str::to_string)
                .ok_or_else(|| "ListRooms listed a room with no name".to_string())
        })
        .collect()
}

/// `{"participants":[..]}` -> (ACTIVE identities, SCREEN_SHARE track sids).
///
/// ACTIVE only: a JOINING or JOINED session may still abort, which LiveKit
/// reports as `participant_connection_aborted` - never the `participant_left`
/// this backend acts on - so importing one could leave a seat nobody frees.
/// It is imported on a later resync, or by its own `participant_joined`.
fn parse_participants(body: &str) -> Result<(Vec<String>, Vec<String>), String> {
    let v: serde_json::Value =
        serde_json::from_str(body).map_err(|e| format!("ListParticipants reply is not JSON: {e}"))?;
    let list = v
        .get("participants")
        .and_then(|p| p.as_array())
        .ok_or("ListParticipants reply carries no participants list")?;
    let mut ids = Vec::new();
    let mut shares = Vec::new();
    for p in list {
        if !enum_is(p.get("state"), "ACTIVE", 2) {
            continue;
        }
        let Some(id) = p.get("identity").and_then(|i| i.as_str()).filter(|i| !i.is_empty()) else {
            continue;
        };
        ids.push(id.to_string());
        let tracks = p.get("tracks").and_then(|t| t.as_array());
        for t in tracks.into_iter().flatten() {
            if !enum_is(t.get("source"), "SCREEN_SHARE", 3) {
                continue;
            }
            if let Some(sid) = t.get("sid").and_then(|s| s.as_str()).filter(|s| !s.is_empty()) {
                shares.push(sid.to_string());
            }
        }
    }
    Ok((ids, shares))
}

/// The grant LiveKit reports for each session [`parse_participants`] takes
/// (ACTIVE, with an identity), where its `permission` is readable. LiveKit
/// v1.13.4's ListParticipants emits every participant's (`ParticipantInfo`
/// carries `grants.Video.ToPermission()`, pkg/rtc/participant.go:914).
fn parse_listed_grants(body: &str) -> HashMap<String, Grant> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(body) else {
        return HashMap::new();
    };
    let list = v.get("participants").and_then(|p| p.as_array());
    list.into_iter()
        .flatten()
        .filter(|p| enum_is(p.get("state"), "ACTIVE", 2))
        .filter_map(|p| {
            let id = p.get("identity").and_then(|i| i.as_str()).filter(|i| !i.is_empty())?;
            Some((id.to_string(), Grant::from_permission(p.get("permission"))?))
        })
        .collect()
}

/// A LiveKit error body, fit for a log line. The auth middleware answers a bad
/// token in plain text - "invalid token: <the whole JWT>, error: <reason>" -
/// so keep the reason and drop the token; anything else is capped.
fn redact_livekit_error(text: &str) -> String {
    let t = text.trim();
    if let Some(rest) = t.strip_prefix("invalid token: ") {
        return match rest.split_once(", error: ") {
            Some((_, reason)) => format!("invalid token (redacted), error: {}", reason.chars().take(200).collect::<String>()),
            None => "invalid token (redacted)".to_string(),
        };
    }
    t.chars().take(200).collect()
}

/// One RoomService call. A non-2xx is LiveKit's reason (Twirp's `{"code","msg"}`,
/// or the auth middleware's plain text), never an empty answer.
async fn twirp(
    client: &reqwest::Client,
    cfg: &SfuConfig,
    method: &str,
    token: &str,
    body: serde_json::Value,
) -> Result<String, ResyncError> {
    let resp = client
        .post(format!("{}/twirp/livekit.RoomService/{method}", api_base(cfg)))
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .map_err(|e| ResyncError::Transport(format!("{method}: {}", crate::http_err::http_err(&e))))?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| ResyncError::Transport(format!("{method}: {}", crate::http_err::http_err(&e))))?;
    if !status.is_success() {
        return Err(ResyncError::Refused(status.as_u16(), format!("{method}: {}", redact_livekit_error(&text))));
    }
    Ok(text)
}

/// Every `sfu_<channel>` room LiveKit has, with its sessions, and the name of
/// EVERY room it listed. All or nothing: one failed call fails the snapshot,
/// because a room missing from a partial answer would read as "empty" and
/// clear sessions that are still live.
async fn fetch_snapshot(
    cfg: &SfuConfig,
    client: &reqwest::Client,
) -> Result<(Vec<LkRoom>, HashSet<String>), ResyncError> {
    let token = mint_list_token(cfg).map_err(|e| ResyncError::Token(e.to_string()))?;
    let names = parse_room_names(&twirp(client, cfg, "ListRooms", &token, serde_json::json!({})).await?)
        .map_err(ResyncError::Malformed)?;
    let listed: HashSet<String> = names.iter().cloned().collect();
    let mut rooms = Vec::new();
    for name in names {
        // The canonical spelling only: eviction rebuilds the name from the
        // channel id, so an entry kept as "sfu_05" or "sfu_+5" would never be
        // found by it.
        let ours = channel_id_from_room(&name).is_some_and(|cid| room_name_for_channel(cid) == name);
        if !ours {
            continue;
        }
        let token = mint_admin_token(cfg, &name).map_err(|e| ResyncError::Token(e.to_string()))?;
        let body = twirp(client, cfg, "ListParticipants", &token, serde_json::json!({ "room": name })).await?;
        let (participants, share_sids) = parse_participants(&body).map_err(ResyncError::Malformed)?;
        let grants = parse_listed_grants(&body);
        rooms.push(LkRoom { name, participants, share_sids, grants });
    }
    Ok((rooms, listed))
}

/// Merge a snapshot into `rooms`. The snapshot was requested at `started`, and
/// every webhook or eviction since then is in `journal` and wins over it.
///
/// - A listed session is added if absent, at `now` (the fail-safe choice for
///   admission's "settled" count), and a known one keeps its time. One that
///   left since `started` is not brought back. A listed identity holding a
///   reservation moves to participants, as its join would have moved it, and
///   is returned in `moved` for the join check: its token was minted under the
///   permissions of THAT moment, and if its `participant_joined` was lost no
///   other check would ever compare them with today's.
/// - A known session LiveKit does not list is cleared only if it was known
///   before `started` and no join was seen since: a `participant_left` that
///   never arrived. The same holds for rooms LiveKit no longer has at all -
///   judged against `listed`, EVERY name ListRooms returned, so a room the
///   snapshot skipped (not `sfu_<channel>`) is never mistaken for a gone one.
/// - Screen shares follow the same rules, by track sid.
/// - Reservations are never added, expired or cleared here: a minted token's
///   room does not exist in LiveKit until its first join.
/// - A listed session's grant, where LiveKit reported one, becomes the known
///   grant (not for one that joined since `started`: its webhook's is newer;
///   nor for one whose recorded grant this process changed since `started`).
///   A KNOWN session whose grant differs from the one this process held is
///   due a join check, which re-applies what its member's permissions give.
fn merge_snapshot(
    rooms: &DashMap<String, SfuRoomUsage>,
    snap: &[LkRoom],
    listed: &HashSet<String>,
    journal: &SfuResyncJournal,
    started: Instant,
    now: Instant,
) -> Merged {
    let mut report = ResyncReport::default();
    let mut added = Vec::new();
    let mut moved = Vec::new();
    let mut due = Vec::new();
    for room in snap {
        report.rooms += 1;
        report.participants += room.participants.len();
        report.shares += room.share_sids.len();
        if journal.finished.contains(&room.name) {
            continue;
        }
        let name = room.name.as_str();
        let listed: HashSet<&str> = room.participants.iter().map(String::as_str).collect();
        let listed_shares: HashSet<&str> = room.share_sids.iter().map(String::as_str).collect();
        let mut u = rooms.entry(room.name.clone()).or_default();
        let mut drifted = Vec::new();
        for id in &room.participants {
            if SfuResyncJournal::has(&journal.left, name, id) {
                continue;
            }
            let was_reserved = u.reservations.remove(id).is_some();
            let known = u.participants.contains_key(id);
            if !known {
                u.participants.insert(id.clone(), now);
                if was_reserved {
                    report.moved += 1;
                    moved.push((room.name.clone(), id.clone()));
                } else {
                    report.added += 1;
                    added.push((room.name.clone(), id.clone()));
                }
            }
            // LiveKit's word on the grant this session holds - unless it joined
            // during the fetch: that webhook's payload is newer than the listing
            // (the same identity can rejoin with its token, under the token's
            // grant), and its own check is on its way. Nor when this process
            // changed the recorded grant during the fetch (a sweep's confirmed
            // UpdateParticipant, a failed join grant forgotten): that is newer
            // than the listing too, and the difference is not drift.
            let Some(&reported) = room.grants.get(id) else { continue };
            if SfuResyncJournal::has(&journal.joined, name, id) || SfuResyncJournal::has(&journal.grants, name, id) {
                continue;
            }
            // Nor while an UpdateParticipant for it is on its way: LiveKit may
            // have applied it before this listing, with its answer not yet
            // read - the listing is then newer than the record, and the
            // difference is that update, not a rejoin.
            if u.in_flight.contains_key(id) {
                continue;
            }
            let held = u.grants.insert(id.clone(), reported);
            // A known session whose grant is not the one this process last
            // saw or applied (a join whose webhook was lost, re-using a token
            // minted under older permissions): its grant is checked against
            // the member's permissions again, with the join check. One already
            // marked is due anyway.
            if known && held.is_some_and(|h| h != reported) && !u.recheck.contains_key(id) {
                drifted.push(id.clone());
            }
        }
        for id in drifted {
            due.push((room.name.clone(), id, Recheck::JoinCheck));
        }
        let before = u.participants.len();
        u.participants.retain(|id, seen| {
            listed.contains(id.as_str()) || *seen >= started || SfuResyncJournal::has(&journal.joined, name, id)
        });
        report.cleared += before - u.participants.len();
        // Marks: only for participants still known; those LiveKit still lists
        // are due now.
        let known: HashSet<String> = u.participants.keys().cloned().collect();
        u.recheck.retain(|id, _| known.contains(id));
        for (id, m) in u.recheck.iter() {
            if listed.contains(id.as_str()) {
                due.push((room.name.clone(), id.clone(), m.what));
            }
        }
        for sid in &room.share_sids {
            if SfuResyncJournal::has(&journal.unpublished, name, sid) {
                continue;
            }
            if u.screen_shares.insert(sid.clone()) {
                report.added += 1;
            }
        }
        let before = u.screen_shares.len();
        u.screen_shares
            .retain(|sid| listed_shares.contains(sid.as_str()) || SfuResyncJournal::has(&journal.published, name, sid));
        report.cleared += before - u.screen_shares.len();
    }
    // Rooms LiveKit no longer has at all: their sessions ended unseen. Keys
    // first, so no guard is held while each entry is rewritten.
    let gone: Vec<String> = rooms
        .iter()
        .map(|r| r.key().clone())
        .filter(|k| !listed.contains(k))
        .collect();
    for name in gone {
        if let Some(mut u) = rooms.get_mut(&name) {
            let before = u.participants.len() + u.screen_shares.len();
            u.participants
                .retain(|id, seen| *seen >= started || SfuResyncJournal::has(&journal.joined, &name, id));
            u.screen_shares
                .retain(|sid| SfuResyncJournal::has(&journal.published, &name, sid));
            report.cleared += before - (u.participants.len() + u.screen_shares.len());
            let known: HashSet<String> = u.participants.keys().cloned().collect();
            u.recheck.retain(|id, _| known.contains(id));
        }
    }
    Merged { report, added, moved, due }
}

/// One resync: open the journal, take the snapshot, merge it under the
/// journal's lock, prune, then re-apply any ejection requested during the fetch
/// to the sessions the merge added. Only ever run from the one reconciler task:
/// two at once would share, and wipe, one journal.
async fn resync_once(state: &AppState, cfg: &SfuConfig, client: &reqwest::Client) -> Result<ResyncReport, ResyncError> {
    *state.sfu_resync_journal.lock().unwrap_or_else(|p| p.into_inner()) = Some(SfuResyncJournal::default());
    let started = Instant::now();
    let fetched = fetch_snapshot(cfg, client).await;
    let (mut report, intents) = {
        let mut g = state.sfu_resync_journal.lock().unwrap_or_else(|p| p.into_inner());
        let journal = g.take().unwrap_or_default();
        let (rooms, listed) = fetched?;
        if journal.overflowed {
            return Err(ResyncError::Busy);
        }
        let merged = merge_snapshot(&state.sfu_rooms, &rooms, &listed, &journal, started, Instant::now());
        let mut report = merged.report;
        report.ignored = listed.len() - rooms.len();
        (report, (journal.evict_intents, merged.added, merged.moved, merged.due))
    };
    let (intents, added, moved, due) = intents;
    prune(state);
    // What an earlier pass could not finish: cut again what LiveKit did not
    // confirm, check again what the database could not answer or LiveKit did
    // not confirm - each with the grant its check owes.
    let mut unchecked = Vec::new();
    for (room, identity, what) in due {
        match what {
            Recheck::Cut => report.reapplied += remove_or_mark(state, cfg, &room, std::slice::from_ref(&identity), Recheck::Cut).await,
            Recheck::JoinCheck => unchecked.push((room, identity, GrantAt::Join)),
            Recheck::LiveGrant => unchecked.push((room, identity, GrantAt::Live)),
        }
    }
    // An ejection requested during the fetch (a voice move, a transport change)
    // found nothing to cut for a session only the snapshot knew. Apply it to
    // THOSE sessions - the ones the merge added for that user in that room -
    // and never to one that joined since.
    for (room, identity) in added {
        let wanted_out = user_id_from_identity(&identity).is_some_and(|uid| intents.contains(&(room.clone(), uid)));
        if wanted_out {
            report.reapplied += remove_or_mark(state, cfg, &room, std::slice::from_ref(&identity), Recheck::Cut).await;
        } else {
            // A session this process never saw join is, as far as it can
            // tell, a LIVE one - after a restart, every call in progress. Its
            // running camera or share is not pulled: the live grant.
            unchecked.push((room, identity, GrantAt::Live));
        }
    }
    // A reservation LiveKit already lists as joined gets the join check too.
    // Usually its participant_joined is merely on its way and runs the same
    // check (both serialize on the server's lock, and whichever runs second
    // finds nothing to change); but if that webhook was lost, a token minted
    // before a revoke would keep its grant for the whole session. Not the
    // ejection intents, though: this process knew the reservation, so an
    // ejection during the fetch already tried to cut it by name.
    unchecked.extend(moved.into_iter().map(|(room, identity)| (room, identity, GrantAt::Join)));
    // Every other added session never went through this process's join check
    // (its participant_joined never arrived here): run it now. This is what
    // catches a kick, ban or permission change that happened while the session
    // was unknown - during the fetch, or while this process was down.
    let checked = reauthorize_added(state, cfg, &unchecked).await;
    report.denied += checked.denied;
    report.regranted += checked.regranted;
    report.pending = pending_marks(state);
    Ok(report)
}

/// Sessions marked for the next resync, across every room.
fn pending_marks(state: &AppState) -> usize {
    state.sfu_rooms.iter().map(|r| r.recheck.len()).sum()
}

/// The join check the `participant_joined` webhook runs, for sessions the
/// resync added. It acts ONLY on answers the database gave: a channel it
/// confirms is not (or no longer) an SFU voice channel, a user it confirms is
/// not a member, permissions without VIEW_CHANNEL and CONNECT. A lookup that
/// fails keeps the session: a database hiccup at boot must not drop calls. The
/// resync only runs against this host's own LiveKit (LIVEKIT_API_URL), so this
/// never judges another host's calls.
///
/// A session it keeps has its grant checked too: a token minted before a SPEAK
/// (VIDEO, STREAM) change still carries the old grant, and LiveKit enforces the
/// token's, so one that does not match what the member's permissions give now
/// is given that ([`regrant_if_stale`]) - the whole grant for a join this
/// process can place (a moved reservation, a drifted grant, a retried join
/// check), the microphone alone for a live session (one it learned, a retried
/// sweep grant): each entry's [`GrantAt`], raised to a JoinCheck owed since
/// the merge. One LiveKit does not confirm stays marked, and the next pass
/// checks it again. Each session's resolve-and-grant holds its server's
/// permissions lock ([`resolve_serialized`]), so a perms-change sweep cannot
/// land a newer grant in between and be overwritten by this older answer.
async fn reauthorize_added(state: &AppState, cfg: &SfuConfig, added: &[(String, String, GrantAt)]) -> Checked {
    if added.is_empty() {
        return Checked::default();
    }
    // Each session's mark generation, read BEFORE anything the check relies
    // on (whether the channel is an SFU one, just below; the permissions): a
    // debt owed after this is newer than the check's answer, and only a later
    // pass may pay it (clear_answered_mark).
    let gens_before: Vec<Option<u64>> = added
        .iter()
        .map(|(room, identity, _)| state.sfu_rooms.get(room).and_then(|u| u.mark_gens.get(identity).copied()))
        .collect();
    let cids: Vec<i64> = added
        .iter()
        .filter_map(|(room, ..)| channel_id_from_room(room))
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let sfu_channels: HashSet<i64> = match sqlx::query_as::<_, (i64,)>(
        "SELECT id::bigint FROM channels WHERE id::bigint = ANY($1) AND type = 1 AND COALESCE(sfu_mode, false)",
    )
    .bind(&cids)
    .fetch_all(&state.pool)
    .await
    {
        Ok(rows) => rows.into_iter().map(|(id,)| id).collect(),
        Err(e) => {
            tracing::warn!(
                "SFU resync: could not check the {} session(s) it learned ({e}); they are kept and checked again on the next pass",
                added.len()
            );
            for (room, identity, at) in added {
                mark(state, &[(room.clone(), identity.clone())], at.recheck());
            }
            return Checked::default();
        }
    };
    let mut refused: HashMap<String, Vec<String>> = HashMap::new();
    let mut regranted = 0;
    for ((room, identity, at), gen_before) in added.iter().zip(gens_before) {
        let (Some(cid), Some(uid)) = (channel_id_from_room(room), user_id_from_identity(identity)) else {
            continue;
        };
        let session = [(room.clone(), identity.clone())];
        let is_sfu = sfu_channels.contains(&cid);
        // Held until the end of this iteration: the grant below is applied
        // under the same lock as the answer it comes from.
        let (access, _serial) = if is_sfu {
            let (a, g) = resolve_serialized(state, cid, uid).await;
            (Some(a), g)
        } else {
            (None, None)
        };
        if let Some(reason) = join_check_refuses(is_sfu, access.as_ref()) {
            tracing::warn!("SFU resync: removing user {} from sfu channel {} ({})", uid, cid, reason);
            refused.entry(room.clone()).or_default().push(identity.clone());
        } else if let Some(ChannelPermAccess::Allowed { perms, .. }) = access {
            // Answered, and allowed: what is owed now is only that LiveKit
            // enforces the grant these permissions give. The mark goes once it
            // does - not before, so a grant LiveKit keeps refusing still counts
            // its passes towards MARK_PASSES.
            //
            // Which grant: what is owed NOW, re-read under the lock. `at` was
            // fixed when the merge ran; since then a rejoin's own check may
            // have failed and owed the WHOLE grant (a JoinCheck) - a live grant
            // run in its place would find nothing to change and, by clearing
            // the mark, erase that debt. The stronger of the two runs.
            let owed = state.sfu_rooms.get(room).and_then(|u| u.recheck.get(identity).map(|m| m.what));
            let at = at.at_least(owed);
            match regrant_if_stale(state, cfg, room, identity, perms, at).await {
                Regrant::Failed => mark(state, &session, at.recheck()),
                done => {
                    if done == Regrant::Applied {
                        regranted += 1;
                    }
                    clear_answered_mark(state, room, identity, at.recheck(), gen_before);
                }
            }
        } else {
            // Unanswered, not allowed: kept, and asked again next pass.
            mark(state, &session, at.recheck());
        }
    }
    let mut removed = 0;
    for (room, identities) in refused {
        removed += remove_or_mark(state, cfg, &room, &identities, Recheck::JoinCheck).await;
    }
    Checked { denied: removed, regranted }
}

/// What [`reauthorize_added`] did: sessions removed, and sessions LiveKit
/// confirmed a grant for - one that differed from what it held, or a re-send of
/// one an earlier update left unconfirmed.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct Checked {
    denied: usize,
    regranted: usize,
}

/// A RESYNC pass failed these: mark known participants for the next pass,
/// counting the passes a mark has failed; past [`MARK_PASSES`] it is given up
/// with one warn line (the session stays known and counted). One that is no
/// longer known needs nothing: it is gone from the call as far as this process
/// can tell. Only the resync calls this - see [`owe`] for everyone else. The
/// mark keeps the stronger of what it owed and `what` ([`Recheck::stronger`]).
fn mark(state: &AppState, sessions: &[(String, String)], what: Recheck) {
    for (room, identity) in sessions {
        let Some(mut u) = state.sfu_rooms.get_mut(room) else { continue };
        if !u.participants.contains_key(identity) {
            continue;
        }
        let (passes, what) = match u.recheck.get(identity) {
            Some(m) => (m.passes.saturating_add(1), m.what.stronger(what)),
            None => (1, what),
        };
        if passes > MARK_PASSES {
            u.recheck.remove(identity);
            drop(u);
            tracing::warn!(
                "SFU resync: gave up on user {:?}'s session in sfu channel {:?} after {} passes ({:?} could not be completed); it stays counted until it leaves",
                user_id_from_identity(identity),
                channel_id_from_room(room),
                MARK_PASSES,
                what
            );
            continue;
        }
        u.recheck.insert(identity.clone(), Mark { what, passes });
        bump_mark_gen(&mut u, identity);
    }
}

/// A write to `identity`'s mark: a new generation for it (see
/// [`SfuRoomUsage::mark_gens`]).
fn bump_mark_gen(u: &mut SfuRoomUsage, identity: &str) {
    u.mark_seq += 1;
    let seq = u.mark_seq;
    u.mark_gens.insert(identity.to_string(), seq);
}

/// A check OUTSIDE the resync failed for these (a sweep's grant, a kick's or a
/// join check's removal, a join check's grant): make sure the resync owes them
/// a look. A known participant with no mark gets one that no pass has tried
/// yet (`passes: 0`); an existing mark keeps its pass count - that count is the
/// resync's own - and only ever moves UP to the stronger debt (a join check
/// failing after a live grant did owes the whole grant; a Cut stays a Cut:
/// [`Recheck::stronger`]). Counting these would let a burst of failed sweeps
/// between two resyncs give a mark up before any resync had retried it.
///
/// Returns whether the resync WILL retry them: whether its loop is running,
/// read under the same lock the reconciler counts marks and decides to stop
/// under ([`AppState::sfu_resync_running`]) - so a `true` here is a mark that
/// count finds, and a `false` one no pass will ever see. Feed it to
/// [`grant_retry_note`].
fn owe(state: &AppState, sessions: &[(String, String)], what: Recheck) -> bool {
    let running = resync_running(state);
    for (room, identity) in sessions {
        let Some(mut u) = state.sfu_rooms.get_mut(room) else { continue };
        if !u.participants.contains_key(identity) {
            continue;
        }
        u.recheck
            .entry(identity.clone())
            .and_modify(|m| m.what = m.what.stronger(what))
            .or_insert(Mark { what, passes: 0 });
        // A new debt even when the mark reads the same: a check already
        // running answered the old one, not this.
        bump_mark_gen(&mut u, identity);
    }
    *running
}

/// The reconciler's running flag, locked. Lock order: this, then `sfu_rooms`.
fn resync_running(state: &AppState) -> std::sync::MutexGuard<'_, bool> {
    state.sfu_resync_running.lock().unwrap_or_else(|p| p.into_inner())
}

/// Whether the resync will retry marks made BEFORE this call: read after
/// them, a `true` means the reconciler has not stopped yet, and its stop
/// decision counts them; a `false` that it has stopped.
pub(crate) fn resync_will_retry(state: &AppState) -> bool {
    *resync_running(state)
}

/// What happens next to a grant LiveKit did not confirm, for its log line -
/// exactly: `retried` is what [`owe`] returned for it, `at` the grant it was.
pub(crate) fn grant_retry_note(retried: bool, at: GrantAt) -> &'static str {
    match (retried, at) {
        (true, GrantAt::Live) => "it is marked, and the LiveKit resync will retry it",
        (true, GrantAt::Join) => "it is marked, and the LiveKit resync will retry the whole grant",
        // LiveKit may have applied it without answering. The session is
        // marked unconfirmed, so the next sweep sends its microphone grant
        // even if it looks unchanged.
        (false, GrantAt::Live) => {
            "it may not be enforced at LiveKit (LiveKit may have applied it without answering) until the sweep for the next permission change in that server sends it again - which it now does for this session even when its grant looks unchanged - or the session rejoins (the LiveKit resync is not running to retry it)"
        }
        // forget_grant recorded the session's grant as unknown, so any
        // sweep's grant for it is the whole one.
        (false, GrantAt::Join) => {
            "it is NOT enforced at LiveKit until the sweep for the next permission change in that server (which now sends this session the whole grant: the one it held is recorded as unknown) or the session's rejoin (the LiveKit resync is not running to retry it)"
        }
    }
}

/// The check `ran` answered what this participant owed: its mark goes -
/// unless the mark now owes something STRONGER than that check (a Cut, or a
/// JoinCheck owed after a weaker live check was scheduled), or was written
/// again after `gen_before` - the mark's generation read before the check read
/// anything it relied on. A debt owed while the check ran (an eviction that
/// failed after a flip out of SFU mode, say) is newer than the check's answer,
/// even when it reads the same, and is left for the next pass to answer.
/// Only a check at least as strong as the debt, and newer than it, pays it.
fn clear_answered_mark(state: &AppState, room: &str, identity: &str, ran: Recheck, gen_before: Option<u64>) {
    if let Some(mut u) = state.sfu_rooms.get_mut(room) {
        let unchanged = u.mark_gens.get(identity).copied() == gen_before;
        if unchanged && u.recheck.get(identity).is_some_and(|m| ran.stronger(m.what) == ran) {
            u.recheck.remove(identity);
        }
    }
}

/// The join check's verdict on one session, as a reason to remove it or None
/// to keep it. `access` is None when the channel was confirmed not to be an
/// SFU voice channel (no lookup needed). Only ANSWERS refuse: `NotFound` here
/// is a lookup that failed (the channel was just confirmed to exist), and a
/// failed lookup keeps the session.
fn join_check_refuses(channel_is_sfu: bool, access: Option<&ChannelPermAccess>) -> Option<&'static str> {
    if !channel_is_sfu {
        return Some("the channel is not an SFU voice channel");
    }
    match access? {
        a @ ChannelPermAccess::Allowed { .. } if !sfu_entitled(a) => Some("VIEW_CHANNEL or CONNECT denied"),
        ChannelPermAccess::Allowed { .. } => None,
        ChannelPermAccess::NotMember => Some("not a member of the server"),
        ChannelPermAccess::NotFound => None,
    }
}

/// Remove `identities` from `room` at LiveKit. One LiveKit did not confirm
/// stays KNOWN - still counted, still reachable by every ejection - and is
/// marked `what`, so the next resync cuts or checks it again. Returns how many
/// LiveKit confirmed.
async fn remove_or_mark(state: &AppState, cfg: &SfuConfig, room: &str, identities: &[String], what: Recheck) -> usize {
    let removed = remove_identities(state, cfg, room, identities).await.removed;
    if removed < identities.len() {
        let left: Vec<(String, String)> = identities.iter().map(|i| (room.to_string(), i.clone())).collect();
        mark(state, &left, what);
    }
    removed
}

/// Who an `sfu_mode` change must still cut at the SFU: when LEAVING SFU mode,
/// everyone in the channel's LiveKit room whose voice-room eviction did not
/// already cut them (`cut`). Entering SFU mode cuts nobody: the room then holds
/// the new call's first joiners.
pub(crate) fn sfu_only_to_cut(was_sfu: bool, cut: &std::collections::BTreeSet<i64>, usage: Option<&SfuRoomUsage>) -> std::collections::BTreeSet<i64> {
    if !was_sfu {
        return Default::default();
    }
    usage
        .map(|u| {
            u.participants
                .keys()
                .chain(u.reservations.keys())
                .filter_map(|i| user_id_from_identity(i))
                .filter(|uid| !cut.contains(uid))
                .collect()
        })
        .unwrap_or_default()
}

/// SFU_RESYNC_SECS as a period: unset = [`RESYNC_EVERY`]; 0 = only until the
/// first successful read; anything else at least [`RESYNC_MIN`]. Unparseable
/// is an error for the caller to log, with the default used instead.
fn resync_period(raw: Option<&str>) -> Result<Duration, String> {
    match raw.map(str::trim).filter(|s| !s.is_empty()) {
        None => Ok(RESYNC_EVERY),
        Some(s) => match s.parse::<u64>() {
            Ok(0) => Ok(Duration::ZERO),
            Ok(n) => Ok(Duration::from_secs(n).max(RESYNC_MIN)),
            Err(_) => Err(format!("SFU_RESYNC_SECS={s:?} is not a whole number of seconds")),
        },
    }
}

/// Background task: resync from LiveKit now, then every SFU_RESYNC_SECS,
/// backing off while LiveKit cannot be read. No-op without the SFU tier, and
/// OFF unless LIVEKIT_API_URL is set: without it the calls go to the public
/// LIVEKIT_URL, which on a host DNS does not point at is ANOTHER host's node -
/// that host's rooms would be mirrored here, and a kick issued here would act
/// on its calls.
pub fn spawn_livekit_reconciler(state: Arc<AppState>) {
    let Some(cfg) = sfu_config() else { return };
    let every = match reconciler_plan(cfg.api_url.is_some(), std::env::var("SFU_RESYNC_SECS").ok().as_deref()) {
        None => {
            tracing::warn!(
                "SFU resync is off: LIVEKIT_API_URL is not set. Set it to this host's LiveKit (http://127.0.0.1:7880 in the standard deploy) so a restart does not forget who is already in a call - until then such a session cannot be ejected or counted. See .env.example."
            );
            return;
        }
        Some(Ok(p)) => p,
        Some(Err(e)) => {
            tracing::warn!("SFU resync: {e}; using {} s", RESYNC_EVERY.as_secs());
            RESYNC_EVERY
        }
    };
    tokio::spawn(run_reconciler(state, every, sfu_config));
}

/// Whether the reconciler runs, and how often: None without LIVEKIT_API_URL
/// (see [`spawn_livekit_reconciler`]), else SFU_RESYNC_SECS as [`resync_period`]
/// reads it.
fn reconciler_plan(api_url_set: bool, raw_secs: Option<&str>) -> Option<Result<Duration, String>> {
    api_url_set.then(|| resync_period(raw_secs))
}

/// How long the reconciler waits after a successful pass, or None to stop:
/// SFU_RESYNC_SECS=0 stops after its first success - unless sessions are
/// still marked for another look, which then come back at the retry pace
/// (each mark for at most [`MARK_PASSES`] passes, so this always ends).
fn next_wait(every: Duration, pending: usize) -> Option<Duration> {
    match (every.is_zero(), pending) {
        (false, _) => Some(every),
        (true, 0) => None,
        (true, _) => Some(Duration::from_secs(RESYNC_RETRY_SECS[RESYNC_RETRY_SECS.len() - 1])),
    }
}

/// Sets [`AppState::sfu_resync_running`] for as long as it lives: whichever
/// way the reconciler ends - its last pass, a missing config, a panic, the
/// task dropped - the flag no longer says a resync will retry anything.
struct Running<'a>(&'a AppState);

impl<'a> Running<'a> {
    fn start(state: &'a AppState) -> Running<'a> {
        *resync_running(state) = true;
        Running(state)
    }
}

impl Drop for Running<'_> {
    fn drop(&mut self) {
        *resync_running(self.0) = false;
    }
}

/// The reconciler loop. `config` is read on every pass (`sfu_config` in
/// production) so a test can aim the loop at a stand-in.
async fn run_reconciler<F>(state: Arc<AppState>, every: Duration, config: F)
where
    F: Fn() -> Option<SfuConfig> + Send + Sync + 'static,
{
    let client = match reqwest::Client::builder()
        .user_agent(HTTP_USER_AGENT)
        .timeout(Duration::from_secs(10))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            tracing::error!("SFU resync: could not build an HTTP client: {}", crate::http_err::http_err(&e));
            return;
        }
    };
    // Running from here to whichever way this returns (the guard clears it).
    let _running = Running::start(&state);
    let mut failures = 0usize;
    let mut synced = false;
    let mut reported_down = false;
    let mut drifted = false;
    loop {
        let Some(cfg) = config() else { return };
        match resync_once(&state, &cfg, &client).await {
            Ok(r) => {
                let drift = r.added > 0 || r.cleared > 0;
                if !synced {
                    tracing::info!(
                        "SFU resync: LiveKit has {} room(s), {} session(s), {} screen share(s); this process now knows them ({} added, {} cleared, {} other room(s) ignored)",
                        r.rooms,
                        r.participants,
                        r.shares,
                        r.added,
                        r.cleared,
                        r.ignored
                    );
                } else if drift && drifted {
                    // Twice in a row is not a webhook still in flight.
                    tracing::warn!(
                        "SFU resync: LiveKit disagreed with this process on two reads in a row ({} added, {} cleared) - webhooks are being missed",
                        r.added,
                        r.cleared
                    );
                } else if drift {
                    // LiveKit updates what ListParticipants reads BEFORE it
                    // sends the matching webhook, so one read can land between.
                    tracing::info!(
                        "SFU resync: LiveKit disagreed with this process ({} added, {} cleared); a webhook may still have been on its way",
                        r.added,
                        r.cleared
                    );
                }
                if r.reapplied > 0 {
                    tracing::info!(
                        "SFU resync: re-applied {} ejection(s) requested while LiveKit was being read",
                        r.reapplied
                    );
                }
                if r.denied > 0 {
                    tracing::info!(
                        "SFU resync: removed {} session(s) the join check refuses (no longer a member, or no VIEW_CHANNEL/CONNECT)",
                        r.denied
                    );
                }
                if r.regranted > 0 {
                    tracing::info!(
                        "SFU resync: sent {} session(s) the publish grant their member's permissions give now (a grant LiveKit held that differed, or one it had not confirmed)",
                        r.regranted
                    );
                }
                drifted = synced && drift;
                if reported_down {
                    tracing::info!("SFU resync: LiveKit's rooms are readable again");
                    reported_down = false;
                }
                synced = true;
                failures = 0;
                if r.pending > 0 {
                    tracing::info!("SFU resync: {} session(s) to cut or check again on the next pass", r.pending);
                }
                match next_wait(every, r.pending) {
                    Some(wait) => tokio::time::sleep(wait).await,
                    None => {
                        // Stopping (SFU_RESYNC_SECS=0, nothing owed as of the
                        // pass's own count). Count again and decide UNDER the
                        // running flag's lock, which every check outside the
                        // resync marks and reads under (`owe`): a mark made
                        // before this is in the count, and the loop goes on
                        // for it, having told its caller it would; one made
                        // after it reads "not running", and nothing retries it.
                        // Neither is ever told the other.
                        let owed = {
                            let mut running = resync_running(&state);
                            let owed = pending_marks(&state);
                            if owed == 0 {
                                *running = false;
                            }
                            owed
                        };
                        let Some(wait) = next_wait(every, owed) else { return };
                        tokio::time::sleep(wait).await;
                    }
                }
            }
            Err(ResyncError::Busy) => {
                tracing::info!("SFU resync: a snapshot was overtaken by events and discarded; retrying");
                tokio::time::sleep(Duration::from_secs(RESYNC_RETRY_SECS[0])).await;
            }
            Err(e) => {
                if !reported_down {
                    if synced {
                        tracing::warn!("SFU resync: cannot read LiveKit's rooms ({e}); what this process knows is kept - retrying");
                    } else {
                        tracing::warn!(
                            "SFU resync: cannot read LiveKit's rooms ({e}); until it can, sessions from before this process started cannot be ejected or counted - retrying"
                        );
                    }
                    reported_down = true;
                }
                let wait = RESYNC_RETRY_SECS[failures.min(RESYNC_RETRY_SECS.len() - 1)];
                failures += 1;
                tokio::time::sleep(Duration::from_secs(wait)).await;
            }
        }
    }
}

// --- LiveKit access token ---------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VideoGrant<'a> {
    room: &'a str,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    room_join: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    room_create: bool,
    /// Server-side room management (RemoveParticipant). Only set on admin tokens.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    room_admin: bool,
    /// Listing every room (ListRooms). Only set on the resync's list token.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    room_list: bool,
    // NEVER skipped when false: LiveKit's default for an ABSENT canPublish /
    // canSubscribe / canPublishData is TRUE, so skipping the false value
    // handed a member with no media permission the full grant (the deny case
    // of `publish_sources` serialised to nothing).
    can_publish: bool,
    can_subscribe: bool,
    can_publish_data: bool,
    /// Which sources a member may publish, from their channel permissions.
    /// LiveKit's default for an ABSENT list is "every source", so an empty
    /// list is only ever emitted alongside `can_publish: false` — see
    /// `publish_sources`, which returns the pair together.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    can_publish_sources: Vec<&'static str>,
}

/// The publish grant a member's channel permissions allow: SPEAK → microphone,
/// VIDEO → camera, STREAM → screen share (+ its audio); ADMINISTRATOR gets
/// all four. Returned as (can_publish, sources) so the two are never set
/// inconsistently: no sources means no publishing at all, explicitly.
pub(crate) fn publish_sources(perms: Permissions) -> (bool, Vec<&'static str>) {
    if perms.has(Permissions::ADMINISTRATOR) {
        return (true, vec!["microphone", "camera", "screen_share", "screen_share_audio"]);
    }
    let mut sources = Vec::new();
    if perms.has(Permissions::SPEAK) {
        sources.push("microphone");
    }
    if perms.has(Permissions::VIDEO) {
        sources.push("camera");
    }
    if perms.has(Permissions::STREAM) {
        sources.push("screen_share");
        sources.push("screen_share_audio");
    }
    (!sources.is_empty(), sources)
}

/// May this user be in the channel's SFU room right now? The same VIEW+CONNECT
/// pair `get_sfu_token` gates the mint on, re-applied to a resolved access so
/// the join-time webhook can ask it again. Fails CLOSED: NotFound (which is
/// also what a DB error resolves to) and NotMember both mean "not entitled" —
/// a re-joining member we cannot vouch for is evicted, never waved through.
pub(crate) fn sfu_entitled(access: &ChannelPermAccess) -> bool {
    match access {
        ChannelPermAccess::Allowed { perms, .. } => {
            perms.has(Permissions::VIEW_CHANNEL) && perms.has(Permissions::CONNECT)
        }
        ChannelPermAccess::NotFound | ChannelPermAccess::NotMember => false,
    }
}

#[derive(Serialize)]
struct LiveKitClaims<'a> {
    iss: &'a str,
    sub: &'a str,
    jti: &'a str,
    iat: u64,
    nbf: u64,
    exp: u64,
    /// Display name shown by LiveKit; the UI aggregates tiles by user id
    /// parsed from the identity instead.
    name: &'a str,
    video: VideoGrant<'a>,
}

fn mint_join_token(
    cfg: &SfuConfig,
    room: &str,
    identity: &str,
    display_name: &str,
    perms: Permissions,
) -> Result<String, jsonwebtoken::errors::Error> {
    // Enforced by LiveKit itself — the one place a publish gate holds
    // server-side in the SFU tier (the mesh gates live in ws.rs and are
    // advisory to a modified client). The token's grant is fixed at mint: a
    // change mid-call reaches a live session through `regrant_user` (the
    // perms-change sweep), and a session joined with an older token through
    // the `participant_joined` check (`reauth_join`) and the resync.
    let (can_publish, can_publish_sources) = publish_sources(perms);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let claims = LiveKitClaims {
        iss: &cfg.api_key,
        sub: identity,
        jti: identity,
        iat: now,
        nbf: now.saturating_sub(10),
        exp: now + TOKEN_TTL_SECS,
        name: display_name,
        video: VideoGrant {
            room,
            room_join: true,
            room_create: false,
            room_admin: false,
            room_list: false,
            can_publish,
            can_subscribe: true,
            can_publish_data: true,
            can_publish_sources,
        },
    };
    jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        &claims,
        &jsonwebtoken::EncodingKey::from_secret(cfg.api_secret.as_bytes()),
    )
}

/// Mint a short-lived admin token for a server-to-server LiveKit API call
/// (RemoveParticipant). No join/publish/subscribe grants — room admin only.
fn mint_admin_token(cfg: &SfuConfig, room: &str) -> Result<String, jsonwebtoken::errors::Error> {
    mint_service_token(cfg, room, true, false)
}

/// ListRooms checks `roomList` alone; it is not scoped to a room.
fn mint_list_token(cfg: &SfuConfig) -> Result<String, jsonwebtoken::errors::Error> {
    mint_service_token(cfg, "", false, true)
}

fn mint_service_token(
    cfg: &SfuConfig,
    room: &str,
    room_admin: bool,
    room_list: bool,
) -> Result<String, jsonwebtoken::errors::Error> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let claims = LiveKitClaims {
        iss: &cfg.api_key,
        sub: "sovereign-backend",
        jti: "sovereign-admin",
        iat: now,
        nbf: now.saturating_sub(10),
        exp: now + 60,
        name: "",
        video: VideoGrant {
            room,
            room_join: false,
            room_create: false,
            room_admin,
            room_list,
            can_publish: false,
            can_subscribe: false,
            can_publish_data: false,
            can_publish_sources: Vec::new(),
        },
    };
    jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        &claims,
        &jsonwebtoken::EncodingKey::from_secret(cfg.api_secret.as_bytes()),
    )
}

/// Evict every SFU connection of `user_id` from the channel's LiveKit room via
/// the RemoveParticipant twirp API. Best-effort and fire-and-forget: on any
/// error we log and move on (the 20-min token TTL still bounds re-joins, and the
/// caller has already revoked membership in the DB). Also fires a
/// ParticipantDisconnected on remaining clients, which drives an immediate media
/// key rotation (closing the forward-secrecy latency window).
///
/// It evicts the identities `sfu_rooms` knows: mint reservations (60 s),
/// `participant_joined` webhooks, and what the LiveKit resync found (see
/// [`spawn_livekit_reconciler`]) - which is how a session that outlived a
/// backend restart is known at all.
pub async fn evict_user_from_channel(state: &Arc<AppState>, channel_id: i64, user_id: i64) -> Evicted {
    let Some(cfg) = sfu_config() else { return Evicted::default() };
    evict_with(state, &cfg, channel_id, user_id).await
}

/// The body of [`evict_user_from_channel`], with the configuration passed in.
async fn evict_with(state: &AppState, cfg: &SfuConfig, channel_id: i64, user_id: i64) -> Evicted {
    let room = room_name_for_channel(channel_id);
    // The INTENT, before the map is read: a resync whose snapshot is in flight
    // may be about to add a session of this user that the map does not have
    // yet, and the resync re-applies this eviction to whatever it adds.
    journal(state, JournalEntry::EvictIntent(&room, user_id));

    // Which of this user's per-connection identities are live/reserved here?
    let prefix = format!("u{user_id}#");
    let identities: Vec<String> = match state.sfu_rooms.get(&room) {
        Some(u) => u
            .participants
            .keys()
            .chain(u.reservations.keys())
            .filter(|i| i.starts_with(&prefix))
            .cloned()
            .collect(),
        None => return Evicted::default(), // no SFU activity for this channel
    };
    if identities.is_empty() {
        return Evicted::default();
    }
    let out = remove_identities(state, cfg, &room, &identities).await;
    if out.removed < out.tried {
        // LiveKit did not confirm every removal. A kick, ban, re-auth or
        // transport change must not end there: the resync (while it runs)
        // checks these sessions again, and cuts the ones still refused. Owed,
        // not counted: this is not a resync pass (see `owe`).
        let left: Vec<(String, String)> = identities.iter().map(|i| (room.clone(), i.clone())).collect();
        owe(state, &left, Recheck::JoinCheck);
    }
    out
}

/// Cut the LiveKit sessions of `user_id` in the channel's room that were
/// minted on one of `sids` - and no other. "Move here" uses it: the user stays
/// in the call (on the phone), so [`evict_user_from_channel`] - every
/// `u<id>#` identity - would cut the phone too, and no eviction INTENT is
/// journaled for the same reason (the resync would apply it to the user).
///
/// Best-effort like every eviction: an identity minted before this process
/// started, or by a legacy token, is not attributed and is left to the
/// displaced device's own teardown on its RoomLeft.
pub async fn evict_session_identities(state: &Arc<AppState>, channel_id: i64, user_id: i64, sids: &[String]) -> Evicted {
    let Some(cfg) = sfu_config() else { return Evicted::default() };
    let room = room_name_for_channel(channel_id);
    let identities = session_identities(state, &room, user_id, sids);
    if identities.is_empty() {
        return Evicted::default();
    }
    remove_identities(state, &cfg, &room, &identities).await
}

/// The identities [`evict_session_identities`] would cut: minted in `room`,
/// by `user_id`, on one of `sids` (never an empty sid).
fn session_identities(state: &AppState, room: &str, user_id: i64, sids: &[String]) -> Vec<String> {
    let mut out: Vec<String> = state
        .sfu_minted
        .iter()
        .filter(|m| m.room == room && m.user_id == user_id && !m.sid.is_empty() && sids.contains(&m.sid))
        .map(|m| m.key().clone())
        .collect();
    out.sort();
    out
}

/// RemoveParticipant for each identity in `room`; a confirmed removal is
/// journaled and dropped from `sfu_rooms`.
async fn remove_identities(state: &AppState, cfg: &SfuConfig, room: &str, identities: &[String]) -> Evicted {
    let tried = identities.len();
    let room = room.to_string();

    let token = match mint_admin_token(cfg, &room) {
        Ok(t) => t,
        Err(e) => {
            tracing::error!("SFU evict: admin token mint failed: {e}");
            return Evicted { tried, removed: 0 };
        }
    };
    // LiveKit twirp: POST {api}/twirp/livekit.RoomService/RemoveParticipant.
    let endpoint = format!("{}/twirp/livekit.RoomService/RemoveParticipant", api_base(cfg));
    // A per-request timeout: this loops over participants awaiting each call,
    // so a single hung LiveKit connection (dropped node, network black hole)
    // would otherwise stall the whole eviction — and eviction runs on the
    // path that frees egress slots. 5s is well past a healthy round-trip.
    let client = match reqwest::Client::builder()
        .user_agent(HTTP_USER_AGENT)
        .timeout(std::time::Duration::from_secs(5))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            tracing::error!("SFU evict: could not build HTTP client: {}", crate::http_err::http_err(&e));
            return Evicted { tried, removed: 0 };
        }
    };
    let mut removed = 0;
    for identity in identities {
        let identity = identity.as_str();
        // A perms sweep whose LiveKit already failed to answer sends no more:
        // not removed, so owed to the resync like any unconfirmed removal.
        if breaker_stops_call() {
            continue;
        }
        let resp = client
            .post(&endpoint)
            .bearer_auth(&token)
            .json(&serde_json::json!({ "room": room, "identity": identity }))
            .send()
            .await;
        match resp {
            Ok(r) if r.status().is_success() => {
                removed += 1;
                // Journal first: a resync whose snapshot still listed this
                // session must not bring it back.
                journal(state, JournalEntry::Left(&room, identity));
                // Drop from local usage so the egress projection frees the slot
                // without waiting for the participant_left webhook.
                if let Some(mut u) = state.sfu_rooms.get_mut(&room) {
                    u.participants.remove(identity);
                    u.reservations.remove(identity);
                    u.recheck.remove(identity);
                    u.grants.remove(identity);
                    u.unconfirmed.remove(identity);
                }
                state.sfu_minted.remove(identity);
            }
            Ok(r) => tracing::warn!("SFU evict {identity}: LiveKit returned {}", r.status()),
            Err(e) => {
                tracing::warn!("SFU evict {identity}: request failed: {}", crate::http_err::http_err(&e));
                trip_breaker();
            }
        }
    }
    Evicted { tried, removed }
}

/// What an eviction achieved: how many of the user's LiveKit sessions it asked
/// LiveKit to remove, and how many LiveKit confirmed. `tried == 0` means this
/// process knew of no session to remove (see `evict_user_from_channel`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Evicted {
    pub tried: usize,
    pub removed: usize,
}

// --- Publish grants mid-call ----------------------------------------------------
//
// A join token's grant is fixed when it is minted (publish_sources), and LiveKit
// enforces the token's grant for the whole session. So a SPEAK (VIDEO, STREAM)
// revoke mid-call used to live only in the WebSocket room and on the receivers:
// a modified client could leave voice_<id> - the server then forgets the deny -
// and keep publishing its microphone into LiveKit under the old grant, heard by
// everyone, including anyone who joined later.
//
// UpdateParticipant replaces a live session's grant (LiveKit v1.13.4:
// pkg/service/roomservice.go:260-293 -> RoomManager.UpdateParticipant,
// pkg/service/roommanager.go:874-898 -> ParticipantImpl.SetPermission,
// pkg/rtc/participant.go:807-867). SetPermission then REMOVES every published
// track whose source the new grant does not allow (participant.go:835-840):
// the track is closed for every subscriber (UpTrackManager.RemovePublishedTrack,
// pkg/rtc/uptrackmanager.go:285-291) and the publisher is told
// TrackUnpublished (participant.go:2259-2267; a client on protocol > 6 - ours
// is 17), on which livekit-client unpublishes it. It is not a mute the client
// could lift: a new AddTrack for that source is refused NOT_ALLOWED
// (participant.go:1328-1339) and media for one arriving anyway is dropped
// (participant.go:2337-2343). The session itself stays: it keeps subscribing
// (the grant keeps can_subscribe), so a member who loses SPEAK is left in the
// call listening - honest client or not, nobody is evicted for it.

/// What [`regrant_if_stale`] did for one session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Regrant {
    /// The grant LiveKit holds for it is already the one its member's
    /// permissions give (as far as this process knows): nothing was sent.
    Unchanged,
    /// Sent, and LiveKit's answer shows it holds that grant now.
    Applied,
    /// Sent and not confirmed: refused, unreachable, or answered with another
    /// grant. The caller owes it to the resync ([`owe`]; [`mark`] in a pass).
    Failed,
}

/// Make LiveKit enforce on `identity`'s session the grant `perms` give at
/// `at` (the whole grant at a join, the microphone alone on a live session:
/// [`GrantAt`]), unless it is known to hold it already
/// ([`SfuRoomUsage::grants`]): the one LiveKit call, never sent when nothing
/// changed. The caller holds the server's permissions lock from the
/// resolution `perms` came from until this returns.
async fn regrant_if_stale(
    state: &AppState,
    cfg: &SfuConfig,
    room: &str,
    identity: &str,
    perms: Permissions,
    at: GrantAt,
) -> Regrant {
    // One read: the grant, and WHICH session of this identity it belongs to
    // (its join time - a token can be used again, and every join re-times it).
    let (held, session, unconfirmed) = state
        .sfu_rooms
        .get(room)
        .map(|u| (u.grants.get(identity).copied(), u.participants.get(identity).copied(), u.unconfirmed.contains(identity)))
        .unwrap_or((None, None, false));
    let want = at.want(held, perms);
    // The shortcut trusts the recorded grant - except after an update LiveKit
    // did not confirm, which it may hold instead: then even a grant equal to
    // the recorded one is sent (a SPEAK restore after a revoke whose answer
    // was lost would otherwise never reach LiveKit).
    if held == Some(want) && !unconfirmed {
        return Regrant::Unchanged;
    }
    let done = update_grant(state, cfg, room, identity, want, session).await;
    if done == Regrant::Failed && at == GrantAt::Join {
        forget_grant(state, room, identity, session);
    }
    done
}

/// A JOIN-time grant LiveKit did not confirm: what the session holds is no
/// longer known. LiveKit may have applied it (the answer was lost) or kept the
/// token's; the token's grant must not stay recorded either way, or the next
/// sweep's live grant ([`Grant::target`], which keeps the held camera and
/// screen) would hand back a camera or share the join check took away.
/// Unknown, the next grant for it - a sweep's included - is the whole grant the
/// permissions give. Journaled, so an in-flight resync does not write its
/// older listing back; and only for `session`, the join it was sent for.
fn forget_grant(state: &AppState, room: &str, identity: &str, session: Option<Instant>) {
    journal(state, JournalEntry::GrantChanged(room, identity));
    if let Some(mut u) = state.sfu_rooms.get_mut(room) {
        if session.is_some() && u.participants.get(identity).copied() == session {
            u.grants.remove(identity);
        }
    }
}

/// UpdateParticipant with the grant `want` (see [`permission_json`]).
/// Confirmed only when LiveKit's answer - the participant as it now is,
/// roommanager.go:897 - shows exactly that grant: a field LiveKit did not read
/// (its decoder discards unknown names) shows up there as the OLD grant, not
/// as an error. A confirmed grant becomes the known one - for `session` (the
/// join time it was sent for) only.
async fn update_grant(
    state: &AppState,
    cfg: &SfuConfig,
    room: &str,
    identity: &str,
    want: Grant,
    session: Option<Instant>,
) -> Regrant {
    // A perms sweep whose LiveKit already failed to answer sends no more.
    if breaker_stops_call() {
        return Regrant::Failed;
    }
    let token = match mint_admin_token(cfg, room) {
        Ok(t) => t,
        Err(e) => {
            tracing::error!("SFU grant: admin token mint failed: {e}");
            return Regrant::Failed;
        }
    };
    // The same per-request bound as an eviction: the sweep awaits these in turn.
    let client = match reqwest::Client::builder()
        .user_agent(HTTP_USER_AGENT)
        .timeout(Duration::from_secs(5))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            tracing::error!("SFU grant: could not build HTTP client: {}", crate::http_err::http_err(&e));
            return Regrant::Failed;
        }
    };
    let body = serde_json::json!({ "room": room, "identity": identity, "permission": permission_json(want) });
    // In flight from before it is sent until its answer is recorded: LiveKit
    // may apply it before a resync lists the room, and that resync must not
    // read the difference as drift (see merge_snapshot).
    let flight = InFlight::start(state, room, identity);
    let resp = client
        .post(format!("{}/twirp/livekit.RoomService/UpdateParticipant", api_base(cfg)))
        .bearer_auth(&token)
        .json(&body)
        .send()
        .await;
    // Every failure from here on was SENT: LiveKit may have applied it.
    let text = match resp {
        Ok(r) if r.status().is_success() => match r.text().await {
            Ok(t) => t,
            Err(e) => {
                tracing::warn!("SFU grant {identity}: reading LiveKit's answer failed: {}", crate::http_err::http_err(&e));
                trip_breaker();
                return unconfirmed_update(state, room, identity);
            }
        },
        Ok(r) => {
            let status = r.status();
            let reason = r.text().await.map(|t| redact_livekit_error(&t)).unwrap_or_default();
            tracing::warn!("SFU grant {identity}: LiveKit returned {status}: {reason}");
            return unconfirmed_update(state, room, identity);
        }
        Err(e) => {
            tracing::warn!("SFU grant {identity}: request failed: {}", crate::http_err::http_err(&e));
            trip_breaker();
            return unconfirmed_update(state, room, identity);
        }
    };
    let shown = serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|v| Grant::from_permission(v.get("permission")));
    if shown != Some(want) {
        tracing::warn!("SFU grant {identity}: LiveKit answered, but shows {shown:?} rather than {want:?}; not confirmed");
        return unconfirmed_update(state, room, identity);
    }
    // Recorded only for the SAME session it was sent for. One that left has
    // nothing to hold a grant for. If the identity joined again meanwhile (its
    // token used again), LiveKit applied this to the NEW session - it updates
    // an identity's current session - which that join's payload did not show:
    // its grant is unknown now, so its own check sends the whole grant rather
    // than trusting the payload. Journaled first (the journal-then-map order),
    // so a resync whose listing predates this answer keeps it rather than
    // calling the difference drift.
    journal(state, JournalEntry::GrantChanged(room, identity));
    if let Some(mut u) = state.sfu_rooms.get_mut(room) {
        if session.is_some() && u.participants.get(identity).copied() == session {
            u.grants.insert(identity.to_string(), want);
            u.unconfirmed.remove(identity);
        } else {
            u.grants.remove(identity);
        }
    }
    drop(flight);
    Regrant::Applied
}

/// An update was sent and not confirmed: LiveKit may hold it, or the grant
/// recorded before it. Marked, so the recorded grant is no shortcut until
/// something confirms what LiveKit holds (see [`SfuRoomUsage::unconfirmed`]).
fn unconfirmed_update(state: &AppState, room: &str, identity: &str) -> Regrant {
    if let Some(mut u) = state.sfu_rooms.get_mut(room) {
        if u.participants.contains_key(identity) {
            u.unconfirmed.insert(identity.to_string());
        }
    }
    Regrant::Failed
}

/// An UpdateParticipant in flight for (room, identity), until dropped - also
/// when the future sending it is cancelled.
struct InFlight<'a> {
    state: &'a AppState,
    room: &'a str,
    identity: &'a str,
}

impl<'a> InFlight<'a> {
    fn start(state: &'a AppState, room: &'a str, identity: &'a str) -> InFlight<'a> {
        if let Some(mut u) = state.sfu_rooms.get_mut(room) {
            *u.in_flight.entry(identity.to_string()).or_insert(0) += 1;
        }
        InFlight { state, room, identity }
    }
}

impl Drop for InFlight<'_> {
    fn drop(&mut self) {
        if let Some(mut u) = self.state.sfu_rooms.get_mut(self.room) {
            if let Some(n) = u.in_flight.get_mut(self.identity) {
                *n = n.saturating_sub(1);
                if *n == 0 {
                    u.in_flight.remove(self.identity);
                }
            }
        }
    }
}

/// One perms sweep's LiveKit circuit breaker. While LiveKit accepts
/// connections and never answers, every call costs its whole 5 s timeout, one
/// after another - and the sweep holds its server's lock throughout, so the
/// next change's mesh pass (a kick's eviction from its text and voice rooms,
/// a SPEAK flip) used to wait N x 5 s behind it, every run for as long as
/// LiveKit hung. The first call in the sweep that gets no answer (a transport
/// error or a timeout; an error ANSWER is LiveKit working) opens it, and the
/// sweep sends no more: every later grant or removal fails at once and is
/// owed to the resync with its own Recheck, as any unconfirmed one is. So a
/// sweep's SFU pass costs at most one LiveKit timeout. Set for the sweep's SFU
/// pass only ([`with_livekit_breaker`]); every other caller sends as before.
#[derive(Default)]
pub(crate) struct LiveKitBreaker {
    tripped: std::sync::atomic::AtomicBool,
    skipped: std::sync::atomic::AtomicUsize,
}

impl LiveKitBreaker {
    /// Whether a call got no answer.
    pub(crate) fn tripped(&self) -> bool {
        self.tripped.load(Ordering::SeqCst)
    }

    /// Calls not sent because of it.
    pub(crate) fn skipped(&self) -> usize {
        self.skipped.load(Ordering::SeqCst)
    }
}

tokio::task_local! {
    static SWEEP_BREAKER: Arc<LiveKitBreaker>;
}

/// Run `f` - a sweep's SFU pass - with `breaker` guarding its LiveKit calls.
pub(crate) async fn with_livekit_breaker<F: std::future::Future>(breaker: Arc<LiveKitBreaker>, f: F) -> F::Output {
    SWEEP_BREAKER.scope(breaker, f).await
}

/// Whether this task's breaker is open - counting the call it stops. False
/// outside a sweep's SFU pass.
fn breaker_stops_call() -> bool {
    SWEEP_BREAKER
        .try_with(|b| {
            let open = b.tripped();
            if open {
                b.skipped.fetch_add(1, Ordering::SeqCst);
            }
            open
        })
        .unwrap_or(false)
}

/// A call got no answer: open this task's breaker, if it has one.
fn trip_breaker() {
    let _ = SWEEP_BREAKER.try_with(|b| b.tripped.store(true, Ordering::SeqCst));
}

/// What [`regrant_user`] did across one user's sessions in one SFU room.
/// `tried == 0` means none needed a new grant (or this process knows none).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Regranted {
    /// Sessions sent UpdateParticipant: their grant had to change, or an
    /// earlier update of it went unconfirmed and is re-sent.
    pub tried: usize,
    /// Of those, how many LiveKit confirmed.
    pub applied: usize,
    /// Sessions already holding the right grant: nothing sent.
    pub unchanged: usize,
    /// Whether the LiveKit resync will retry the ones LiveKit did not confirm
    /// (what [`owe`] said): feed it to [`grant_retry_note`] with
    /// [`GrantAt::Live`]. False when every one was confirmed.
    pub resync_retries: bool,
}

/// For the perms-change sweep: make LiveKit enforce, on every JOINED session
/// `user_id` holds in `channel_id`'s SFU room, the MICROPHONE grant `perms`
/// give (SPEAK) - in both directions, a revoke and a grant alike. Camera and
/// screen stay what the session holds (see [`Grant::target`]). A session LiveKit
/// does not confirm is owed a [`Recheck::LiveGrant`], which the resync (while
/// it runs: [`grant_retry_note`]) applies again. Reservations are left alone: a
/// token not yet used has no session to update, and its `participant_joined`
/// check compares its grant then. The caller (the sweep) holds the server's
/// permissions lock across the resolution of `perms` and this call.
pub async fn regrant_user(state: &AppState, channel_id: i64, user_id: i64, perms: Permissions) -> Regranted {
    let Some(cfg) = sfu_config() else { return Regranted::default() };
    regrant_user_with(state, &cfg, channel_id, user_id, perms).await
}

async fn regrant_user_with(state: &AppState, cfg: &SfuConfig, channel_id: i64, user_id: i64, perms: Permissions) -> Regranted {
    let room = room_name_for_channel(channel_id);
    let prefix = format!("u{user_id}#");
    let identities: Vec<String> = match state.sfu_rooms.get(&room) {
        Some(u) => u.participants.keys().filter(|i| i.starts_with(&prefix)).cloned().collect(),
        None => return Regranted::default(),
    };
    let mut out = Regranted::default();
    for identity in identities {
        match regrant_if_stale(state, cfg, &room, &identity, perms, GrantAt::Live).await {
            Regrant::Unchanged => out.unchanged += 1,
            Regrant::Applied => {
                out.tried += 1;
                out.applied += 1;
            }
            Regrant::Failed => {
                out.tried += 1;
                out.resync_retries = owe(state, &[(room.clone(), identity)], Recheck::LiveGrant);
            }
        }
    }
    out
}

/// `uid`'s access to `cid`, resolved while holding the lock of the server the
/// channel belongs to ([`AppState::lock_server_perms`]); the caller keeps the
/// guard until it has ACTED on the answer, so no perms-change sweep for that
/// server can resolve and apply a newer answer in between. The server is
/// learned from a first resolution; only an `Allowed` names it, and only an
/// `Allowed` carries a grant that could be applied stale - a `NotMember` or
/// `NotFound` is returned as it is, with no lock (no grant is ever applied
/// from either: the join webhook removes the session, the resync removes a
/// non-member and asks again about a failed lookup). The second resolution,
/// under the lock, is the one acted on: it has seen every change a sweep
/// before it acted on.
async fn resolve_serialized(
    state: &AppState,
    cid: i64,
    uid: i64,
) -> (ChannelPermAccess, Option<crate::state::ServerPermsGuard<'_>>) {
    let first = get_user_channel_permissions(&state.pool, cid, uid).await;
    let ChannelPermAccess::Allowed { server_id, .. } = &first else {
        return (first, None);
    };
    let guard = state.lock_server_perms(server_id).await;
    (get_user_channel_permissions(&state.pool, cid, uid).await, Some(guard))
}

/// The check `participant_joined` runs for a (re)joined session: the mint-time
/// gate again - a member no longer entitled (fails CLOSED: a lookup that fails
/// evicts) is removed - and, for one who stays, the WHOLE grant their
/// permissions give NOW ([`GrantAt::Join`]: camera and screen too), applied if
/// the token's differs. That second half is what stops a token minted while
/// SPEAK (VIDEO, STREAM) was allowed from publishing after the revoke, for the
/// 20 minutes it stays valid. Resolve and grant hold the server's permissions
/// lock ([`resolve_serialized`]), so a sweep for a later change cannot apply
/// its newer grant in between and then be overwritten by this older answer.
async fn reauth_join(state: &AppState, cfg: &SfuConfig, room: &str, identity: &str, cid: i64, uid: i64) {
    let (access, _serial) = resolve_serialized(state, cid, uid).await;
    if sfu_entitled(&access) {
        if let ChannelPermAccess::Allowed { perms, .. } = access {
            match regrant_if_stale(state, cfg, room, identity, perms, GrantAt::Join).await {
                Regrant::Unchanged => {}
                Regrant::Applied => tracing::info!(
                    "SFU join re-auth: user {} joined sfu channel {} with a grant that was not (or not reported as) the one their permissions give; LiveKit confirmed the current one",
                    uid,
                    cid
                ),
                Regrant::Failed => {
                    // Owed before the line is written: see grant_retry_note.
                    let retried = owe(state, &[(room.to_string(), identity.to_string())], Recheck::JoinCheck);
                    tracing::warn!(
                        "SFU join re-auth: user {} joined sfu channel {} with a grant that was not (or not reported as) the one their permissions give, and LiveKit did NOT confirm the current one; {}",
                        uid,
                        cid,
                        grant_retry_note(retried, GrantAt::Join)
                    );
                }
            }
        }
        return;
    }
    let reason = match access {
        ChannelPermAccess::NotFound => "channel not found or lookup failed",
        ChannelPermAccess::NotMember => "not a member of the server",
        ChannelPermAccess::Allowed { .. } => "VIEW_CHANNEL or CONNECT denied",
    };
    tracing::warn!("SFU join re-auth: evicting user {} from sfu channel {} ({})", uid, cid, reason);
    evict_with(state, cfg, cid, uid).await;
}

/// Apply one authenticated LiveKit webhook event to `sfu_rooms`. Every arm
/// journals its event BEFORE it touches the map (see [`journal`]).
fn apply_webhook_event(state: &Arc<AppState>, kind: &str, room: String, event: &serde_json::Value) {
    match kind {
        "participant_joined" => {
            if let Some(identity) = event
                .pointer("/participant/identity")
                .and_then(|v| v.as_str())
            {
                let channel_id = channel_id_from_room(&room);
                let user_id = user_id_from_identity(identity);
                journal(&state, JournalEntry::Joined(&room, identity));
                {
                    // Record first, in a scope of its own: the map guard must be
                    // gone before any await, and the eviction below finds this
                    // user's identities through this very entry.
                    let mut u = state.sfu_rooms.entry(room.clone()).or_default();
                    u.reservations.remove(identity);
                    u.participants.insert(identity.to_string(), Instant::now());
                    // The re-auth below is this session's check now; an older
                    // mark (a cut or a check owed) must not act after it.
                    u.recheck.remove(identity);
                    // The grant this session joined with is its TOKEN's, never
                    // one applied to an earlier session of the same identity
                    // (a token can be used again until it expires). What the
                    // payload says, then - and unknown, so the check below
                    // applies it, when it says nothing.
                    match Grant::from_permission(event.pointer("/participant/permission")) {
                        Some(g) => u.grants.insert(identity.to_string(), g),
                        None => u.grants.remove(identity),
                    };
                    // A new session: nothing earlier is unconfirmed about it.
                    u.unconfirmed.remove(identity);
                }
                // Re-authorize the join. A join token is minted against the
                // perms of that moment and LiveKit checks only its signature,
                // so a member kicked, banned or VIEW/CONNECT-denied inside the
                // 20-minute TTL — or holding tokens stockpiled beforehand,
                // whose identities the perms-change sweep never saw — can
                // reconnect after every eviction. This webhook is the one
                // server-side point that observes a (re)join, so the mint-time
                // gate is re-run here and a no-longer-entitled participant is
                // removed - and an entitled one whose token grants what their
                // permissions no longer do is given the grant they do.
                // Spawned: both await a LiveKit round trip, and the webhook
                // response must not wait on LiveKit.
                match (channel_id, user_id) {
                    (Some(cid), Some(uid)) => {
                        let state = Arc::clone(&state);
                        let (room, identity) = (room.clone(), identity.to_string());
                        tokio::spawn(async move {
                            let Some(cfg) = sfu_config() else { return };
                            reauth_join(&state, &cfg, &room, &identity, cid, uid).await;
                        });
                    }
                    _ => {
                        // Only the API secret can mint a token for a room or
                        // identity outside our naming scheme, and there is no
                        // user to evict — but it should never happen, so say so.
                        tracing::warn!(
                            "SFU join re-auth: unrecognised room {:?} / identity {:?}, not re-checked",
                            room,
                            identity
                        );
                    }
                }
            }
        }
        "participant_left" => {
            if let Some(identity) = event
                .pointer("/participant/identity")
                .and_then(|v| v.as_str())
            {
                journal(&state, JournalEntry::Left(&room, identity));
                if let Some(mut u) = state.sfu_rooms.get_mut(&room) {
                    u.participants.remove(identity);
                    u.recheck.remove(identity);
                    u.grants.remove(identity);
                    u.unconfirmed.remove(identity);
                }
            }
        }
        "track_published" | "track_unpublished" => {
            let source = event
                .pointer("/track/source")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let sid = event
                .pointer("/track/sid")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            // Source is protobuf-JSON: "SCREEN_SHARE" (and "SCREEN_SHARE_AUDIO").
            if source == "SCREEN_SHARE" && !sid.is_empty() {
                journal(
                    &state,
                    if kind == "track_published" {
                        JournalEntry::Published(&room, sid)
                    } else {
                        JournalEntry::Unpublished(&room, sid)
                    },
                );
                let mut u = state.sfu_rooms.entry(room).or_default();
                if kind == "track_published" {
                    u.screen_shares.insert(sid.to_string());
                } else {
                    u.screen_shares.remove(sid);
                }
            }
        }
        "room_finished" => {
            journal(&state, JournalEntry::Finished(&room));
            state.sfu_rooms.remove(&room);
        }
        _ => {}
    }
    prune(state);
}

// --- Handlers -----------------------------------------------------------------

#[derive(Serialize)]
pub struct SfuTokenResponse {
    pub url: String,
    pub token: String,
    /// Per-connection LiveKit identity: `u<user id>#<nonce>`. LiveKit evicts a
    /// same-identity double join, so a bare user id would resurrect the old
    /// desktop/phone mutual-kick bug — every mint gets a fresh identity and the
    /// UI aggregates tiles by the `u<id>` prefix.
    pub identity: String,
    pub room: String,
    /// Ladder + limits the client must apply when publishing.
    pub max_screen_shares: usize,
}

/// GET /channels/:channel_id/sfu-token — mint a LiveKit join token for this
/// channel's SFU room. VIEW-gated exactly like the channel-key endpoints (404
/// hides the channel's existence), voice+sfu_mode channels only, and subject
/// to node-global egress admission.
pub async fn get_sfu_token(
    State(state): State<Arc<AppState>>,
    Path(channel_id): Path<i64>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
    // BOTH halves of the voice-join pair must enforce CONNECT: the mesh tier
    // gates it in ws.rs JoinRoom, and this is the SFU tier's equivalent. Gating
    // only one would leave the other as the bypass — an sfu_mode channel is
    // joined by minting a token here, never by JoinRoom alone.
    let perms = match get_user_channel_permissions(&state.pool, channel_id, claims.sub).await {
        ChannelPermAccess::Allowed { perms, .. }
            if perms.has(Permissions::VIEW_CHANNEL) && perms.has(Permissions::CONNECT) => perms,
        ChannelPermAccess::Allowed { .. } | ChannelPermAccess::NotFound => {
            return (StatusCode::NOT_FOUND, "Channel not found").into_response()
        }
        ChannelPermAccess::NotMember => {
            return (StatusCode::FORBIDDEN, "Not a member of this server").into_response()
        }
    };

    // i32, MATCHING update_channel's copy of this exact text (channels.id is
    // INT4): sqlx caches the prepared statement per connection keyed by the
    // text alone, so with i64 here every SFU join that landed on a pooled
    // connection which had served a channel edit failed with 22P03 - read
    // below as "Channel not found" (see the 22P03 note in device_token.rs).
    let row: Option<(i32, bool)> =
        sqlx::query_as("SELECT type, COALESCE(sfu_mode, false) FROM channels WHERE id = $1")
            .bind(channel_id as i32)
            .fetch_optional(&state.pool)
            .await
            .unwrap_or(None);
    match row {
        Some((1, true)) => {}
        Some(_) => return (StatusCode::BAD_REQUEST, "Not an SFU voice channel").into_response(),
        None => return (StatusCode::NOT_FOUND, "Channel not found").into_response(),
    }

    let Some(cfg) = sfu_config() else {
        return (StatusCode::SERVICE_UNAVAILABLE, "SFU not configured").into_response();
    };

    let room = room_name_for_channel(channel_id);
    prune(&state);

    // Capacity gates. Both checks read before the reservation is inserted; the
    // small race between concurrent mints is acceptable for human-scale rooms —
    // the budget already carries bufferbloat headroom.
    {
        let already_in = |u: &SfuRoomUsage, uid: i64| {
            let prefix = format!("u{uid}#");
            u.participants
                .keys()
                .chain(u.reservations.keys())
                .filter(|i| i.starts_with(&prefix))
                .count()
        };
        let usage = state.sfu_rooms.get(&room);
        let (occupancy, own_conns) = usage
            .as_ref()
            .map(|u| {
                (
                    u.participants.len() + u.reservations.len(),
                    already_in(u, claims.sub),
                )
            })
            .unwrap_or((0, 0));
        // Hard per-user connection cap. Without this, any member holding one
        // connection skipped the room cap for unlimited mints — each mint adds a
        // reservation that counts toward the NODE-GLOBAL egress budget, so one
        // low-privilege user could exhaust the whole node's SFU tier. Bound each
        // user to MAX_OWN_CONNS (desktop + phone), enforced regardless of room
        // state, so no single user can inflate the projection unboundedly.
        if own_conns >= MAX_OWN_CONNS {
            return (
                StatusCode::CONFLICT,
                "This call is already open on your maximum number of devices",
            )
                .into_response();
        }
        // A genuinely new participant (no existing connection) can't join a full
        // room; a returning device (own_conns in 1..MAX) may, since it doesn't add
        // a new logical seat.
        if occupancy >= cfg.room_max_participants && own_conns == 0 {
            return (StatusCode::CONFLICT, "Call is at capacity").into_response();
        }
        drop(usage);
        // Hybrid egress admission (see module docs): the worst-case projection
        // admits unconditionally when it fits; when it would refuse, a fresh
        // measurement of REAL egress may still show room for this seat.
        let projected = node_projected_egress_kbps(&state, &room);
        if projected > cfg.budget_kbps {
            match node_measured_projection_kbps(&state, &room) {
                Some(measured) if measured <= cfg.budget_kbps => {
                    tracing::info!(
                        room,
                        projected_kbps = projected,
                        measured_kbps = measured,
                        budget_kbps = cfg.budget_kbps,
                        "SFU admission: worst-case over budget, admitted on measured egress"
                    );
                }
                verdict => {
                    tracing::warn!(
                        room,
                        projected_kbps = projected,
                        measured_kbps = ?verdict,
                        budget_kbps = cfg.budget_kbps,
                        "SFU admission denied: node egress budget exceeded"
                    );
                    return (StatusCode::CONFLICT, "Server is at streaming capacity")
                        .into_response();
                }
            }
        }
    }

    // Per-connection identity (see SfuTokenResponse::identity).
    let nonce: u32 = rand::random();
    let identity = format!("u{}#{:08x}", claims.sub, nonce);

    let token = match mint_join_token(&cfg, &room, &identity, &claims.username, perms) {
        Ok(t) => t,
        Err(e) => {
            tracing::error!("failed to mint LiveKit token: {e}");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to mint SFU token",
            )
                .into_response();
        }
    };

    state
        .sfu_rooms
        .entry(room.clone())
        .or_default()
        .reservations
        .insert(identity.clone(), Instant::now());
    // Which session holds this identity: "Move here" cuts the PC's LiveKit
    // session by it without touching the phone's (evict_session_identities).
    // A legacy token with no sid is not recorded - it cannot be told apart.
    if !claims.sid.is_empty() {
        state.sfu_minted.insert(
            identity.clone(),
            SfuMint { room: room.clone(), user_id: claims.sub, sid: claims.sid.clone(), at: Instant::now() },
        );
    }

    Json(SfuTokenResponse {
        url: cfg.url,
        token,
        identity,
        room,
        max_screen_shares: cfg.max_screen_shares,
    })
    .into_response()
}

// --- Webhook ------------------------------------------------------------------

#[derive(serde::Deserialize)]
struct WebhookAuthClaims {
    iss: String,
    sha256: String,
}

/// POST /livekit/webhook — LiveKit event feed keeping the usage map honest.
/// Unauthenticated route; authenticity comes from the JWT in the Authorization
/// header (HS256 under the shared API secret, carrying a SHA-256 of the body).
pub async fn livekit_webhook(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    body: String,
) -> impl IntoResponse {
    let Some(cfg) = sfu_config() else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };

    // LiveKit sends the JWT bare (no "Bearer " prefix); accept both.
    let Some(token) = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.strip_prefix("Bearer ").unwrap_or(v).trim())
    else {
        return StatusCode::UNAUTHORIZED.into_response();
    };

    let mut validation = jsonwebtoken::Validation::default();
    // The payload-hash claim is the integrity mechanism; expiry is incidental
    // (some LiveKit versions omit it) and replaying usage events is harmless.
    validation.validate_exp = false;
    validation.required_spec_claims.clear();
    let decoded = jsonwebtoken::decode::<WebhookAuthClaims>(
        token,
        &jsonwebtoken::DecodingKey::from_secret(cfg.api_secret.as_bytes()),
        &validation,
    );
    let auth = match decoded {
        Ok(d) if d.claims.iss == cfg.api_key => d.claims,
        _ => return StatusCode::UNAUTHORIZED.into_response(),
    };
    let body_hash = hex::encode(Sha256::digest(body.as_bytes()));
    // LiveKit encodes the hash claim in either hex or base64 depending on
    // version; compare against both encodings.
    use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
    let body_hash_b64 = B64.encode(Sha256::digest(body.as_bytes()));
    if auth.sha256 != body_hash && auth.sha256 != body_hash_b64 {
        return StatusCode::UNAUTHORIZED.into_response();
    }

    let Ok(event) = serde_json::from_str::<serde_json::Value>(&body) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let kind = event.get("event").and_then(|v| v.as_str()).unwrap_or("");
    let room = event
        .pointer("/room/name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if room.is_empty() {
        return StatusCode::OK.into_response();
    }

    apply_webhook_event(&state, kind, room, &event);
    StatusCode::OK.into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn egress_model_matches_design_envelope() {
        // Solo participant produces no server egress.
        assert_eq!(room_egress_kbps(1, 0), 0);
        // N=6 all-camera grid: 6 × (2500 + 4×150) × 1.15 ≈ 21.4 Mbps.
        let n6 = room_egress_kbps(6, 0);
        assert!((21_000..22_000).contains(&n6), "n6={n6}");
        // N=6 with a live share as focus: 6 × (4500 + 4×150) × 1.15 ≈ 35.2 Mbps.
        let n6s = room_egress_kbps(6, 1);
        assert!((34_500..36_000).contains(&n6s), "n6s={n6s}");
        // N=8 all-camera: 8 × (2500 + 6×150) × 1.15 ≈ 31.3 Mbps — inside the
        // default 30 Mbps budget only without a share, which is the point of
        // admission control.
        let n8 = room_egress_kbps(8, 0);
        assert!((30_500..32_000).contains(&n8), "n8={n8}");
    }

    /// The camera rung follows the head count, because the client's tiles do.
    ///
    /// Unfocused cameras were charged at the ladder's bottom rung for every
    /// room size, and the client asked for exactly that — which is why a camera
    /// was 320x180 upscaled into a 640x360 tile in a one-to-one call. The
    /// client now asks for the MID rung while the grid is small. If this
    /// arithmetic did not move with it, admission would under-count real egress
    /// and over-admit seats.
    #[test]
    fn a_small_grid_is_charged_for_the_mid_camera_rung() {
        // N=4: focus + 2 others at the MID rung.
        assert_eq!(
            room_egress_kbps(4, 0),
            4 * (CAM_HIGH_KBPS + 2 * CAM_MID_KBPS) * OVERHEAD_NUM / OVERHEAD_DEN
        );
        // N=6 is past the threshold: the tiles are ~320px and so is the rung.
        assert_eq!(
            room_egress_kbps(6, 0),
            6 * (CAM_HIGH_KBPS + 4 * CAM_LOW_KBPS) * OVERHEAD_NUM / OVERHEAD_DEN
        );
        // The step at the threshold must be UPWARD as the room SHRINKS — a
        // smaller room costs more per subscriber, which is the whole point.
        assert!(
            room_egress_kbps(4, 0) / 4 > room_egress_kbps(6, 0) / 6,
            "per-subscriber egress must be higher in a small grid"
        );
    }

    #[test]
    fn the_client_publishes_the_share_bitrate_this_file_charges_for() {
        // ONE NUMBER COMPILED TWICE. `SHARE_KBPS` is what admission charges
        // every subscriber for every live share; `SHARE_BITRATE` is what the
        // client actually publishes the top rung at. Nothing connects them but
        // a comment, and a divergence is silent in the direction that matters:
        // raise the client and the node admits seats whose egress it
        // under-counted, which is a congestion incident rather than an error.
        let client = include_str!("../frontend/src/api/rtc/sfuManager.ts");
        assert!(
            client.len() > 20_000,
            "that is not the real sfuManager.ts ({} bytes) — the path is wrong \
             and this test is checking nothing",
            client.len()
        );
        let line = client
            .lines()
            .find(|l| l.trim_start().starts_with("const SHARE_BITRATE"))
            .expect("sfuManager.ts no longer declares SHARE_BITRATE");
        let bps: u64 = line
            .split('=')
            .nth(1)
            .and_then(|v| v.trim().trim_end_matches(';').replace('_', "").parse().ok())
            .expect("could not read SHARE_BITRATE's value");
        assert_eq!(
            bps,
            SHARE_KBPS * 1000,
            "the client publishes shares at {bps} bps but admission charges {} bps",
            SHARE_KBPS * 1000,
        );
        // POSITIVE CONTROL for the search: the ladder this charge assumes is
        // really there, so a future `simulcast: false` cannot pass silently.
        assert!(
            client.contains("screenShareSimulcastLayers"),
            "shares are no longer published with a simulcast ladder — a subscriber \
             in trouble has nothing smaller to fall back to, and this file's \
             worst-case charge became the ONLY case"
        );
    }

    #[test]
    fn share_focus_replaces_camera_focus_and_extra_shares_stack() {
        // One share swaps the focus cost rather than adding to it: the delta
        // between share and no-share at N=4 is 4 × 2000 × 1.15 = 9.2 Mbps.
        let delta = room_egress_kbps(4, 1) - room_egress_kbps(4, 0);
        assert_eq!(
            delta,
            4 * (SHARE_KBPS - CAM_HIGH_KBPS) * OVERHEAD_NUM / OVERHEAD_DEN
        );
        // But each ADDITIONAL live share is charged at full share rate. Shares
        // DO have lower simulcast rungs now (SHARE_LOW/SHARE_MID in
        // sfuManager.ts), and a subscriber receives exactly one of them — so
        // charging the top rung is the worst case rather than the only case,
        // and admission stays conservative instead of becoming wrong. It must
        // still grow with share count now that the client-side cap defaults to
        // unlimited.
        let delta2 = room_egress_kbps(4, 2) - room_egress_kbps(4, 1);
        assert_eq!(delta2, 4 * SHARE_KBPS * OVERHEAD_NUM / OVERHEAD_DEN);
    }

    #[test]
    fn settled_cutoff_slides_back_by_the_samples_own_age() {
        // Fresh sample: the plain lag applies.
        assert_eq!(settled_cutoff(0), MEASURE_LAG);
        // A sample that is itself 20s old cannot contain a join from 22s ago —
        // the bar must move out to 45s, not stay at 25s.
        assert_eq!(settled_cutoff(20), MEASURE_LAG + Duration::from_secs(20));
        // Soundness invariant across EVERY sample age the staleness gate
        // accepts: a join is only "settled" if it predates the sample window
        // start (sample time minus one sampling interval).
        for age in 0..=MEASURED_STALE_SECS {
            let join_age = settled_cutoff(age);
            let before_sample = join_age.saturating_sub(Duration::from_secs(age));
            assert!(
                before_sample >= SAMPLE_INTERVAL,
                "age={age}: settled joins must predate the sample window ({before_sample:?} < {SAMPLE_INTERVAL:?})"
            );
        }
    }

    #[test]
    fn prometheus_parser_sums_only_outgoing_bytes() {
        let text = "\
# HELP livekit_packet_bytes bytes\n\
# TYPE livekit_packet_bytes counter\n\
livekit_packet_bytes{country=\"GB\",direction=\"incoming\",transmission=\"initial\"} 111\n\
livekit_packet_bytes{country=\"GB\",direction=\"outgoing\",transmission=\"initial\"} 1000\n\
livekit_packet_bytes{country=\"GB\",direction=\"outgoing\",transmission=\"retransmit\"} 500.5\n\
livekit_nack_total{direction=\"outgoing\"} 9\n";
        // Initial + retransmit outgoing, incoming excluded, other metrics excluded.
        assert_eq!(parse_outgoing_bytes(text), Some(1500));
        // No outgoing series at all → None (endpoint exists but wrong shape):
        // storing 0 instead would masquerade as "node idle" and over-admit.
        assert_eq!(
            parse_outgoing_bytes("livekit_packet_bytes{direction=\"incoming\"} 5\n"),
            None
        );
        assert_eq!(parse_outgoing_bytes(""), None);
        // An endpoint serving only Go runtime metrics (LiveKit idle) is still
        // "no measurement", not "zero egress".
        assert_eq!(
            parse_outgoing_bytes("go_memstats_alloc_bytes 7.2e+06\n"),
            None
        );
        // Exponent notation is legal Prometheus and must sum, not be dropped.
        assert_eq!(
            parse_outgoing_bytes("livekit_packet_bytes{direction=\"outgoing\"} 1.5e+03\n"),
            Some(1500)
        );
    }

    #[test]
    fn parses_the_packet_counter_the_deployed_livekit_actually_exposes() {
        // Verbatim shape from the production node (LiveKit v1.13.4,
        // prometheus port 6789). This version has NO livekit_packet_bytes at
        // all — supporting only that name left the measured admission branch
        // permanently inert while the endpoint happily answered 200.
        let v1134 = "\
# HELP livekit_node_packet_total System level packet count. Count starts at 0 when service is first started.\n\
# TYPE livekit_node_packet_total gauge\n\
livekit_node_packet_total{node_id=\"ND_nktxgbmB4QXY\",node_type=\"SERVER\",type=\"dropped\"} 17\n\
livekit_node_packet_total{node_id=\"ND_nktxgbmB4QXY\",node_type=\"SERVER\",type=\"out\"} 1000\n\
livekit_participant_total{node_id=\"ND_x\",node_type=\"SERVER\",state=\"active\"} 2\n";
        // Only type="out" counts — "dropped" is not egress.
        assert_eq!(parse_outgoing_bytes(v1134), Some(1000 * AVG_PACKET_BYTES));

        // When BOTH counters exist (a newer LiveKit), the exact byte counter
        // must win over the packet approximation.
        let both = "\
livekit_node_packet_total{type=\"out\"} 1000\n\
livekit_packet_bytes{direction=\"outgoing\",transmission=\"initial\"} 4242\n";
        assert_eq!(parse_outgoing_bytes(both), Some(4242));
    }

    #[test]
    fn non_finite_metric_values_never_read_as_an_idle_node() {
        // NaN poisons a running f64 sum and `NaN as u64` is 0 — which the
        // sampler would store as a valid "0 kbps" rate with a fresh timestamp,
        // wedging the measured branch open on a saturated node. +Inf is the
        // same wedge one step later (saturating counter → zero delta forever).
        // Both must be dropped, so a series that is ONLY non-finite yields
        // None and the admission falls back to worst-case-only.
        assert_eq!(
            parse_outgoing_bytes("livekit_packet_bytes{direction=\"outgoing\"} NaN\n"),
            None
        );
        assert_eq!(
            parse_outgoing_bytes("livekit_packet_bytes{direction=\"outgoing\"} +Inf\n"),
            None
        );
        assert_eq!(
            parse_outgoing_bytes("livekit_packet_bytes{direction=\"outgoing\"} -Inf\n"),
            None
        );
        // A poisoned series alongside good ones must not take the good ones
        // down with it (the sum stays finite and real).
        let mixed = "livekit_packet_bytes{direction=\"outgoing\",transmission=\"initial\"} 900\n\
                     livekit_packet_bytes{direction=\"outgoing\",transmission=\"retransmit\"} NaN\n";
        assert_eq!(parse_outgoing_bytes(mixed), Some(900));
    }

    #[test]
    fn unmeasured_seats_charge_worst_case_on_top_of_the_sample() {
        // 4 settled seats, 6 total (1 reservation + 1 joiner), one live share:
        // the sample already contains the 4, so the branch adds only the
        // marginal worst case of the 2 unseen seats.
        let add = unmeasured_room_kbps(4, 6, 1);
        assert_eq!(add, room_egress_kbps(6, 1) - room_egress_kbps(4, 1));
        assert!(add > 0);
        // Everyone settled → the measurement speaks for the whole room.
        assert_eq!(unmeasured_room_kbps(5, 5, 1), 0);
        // Webhook lag can leave settled > total transiently — clamp, don't wrap.
        assert_eq!(unmeasured_room_kbps(6, 5, 1), 0);
        // Nobody settled (fresh room): identical to the full worst-case model.
        assert_eq!(unmeasured_room_kbps(0, 5, 0), room_egress_kbps(5, 0));
    }
}

#[cfg(test)]
mod sfu_entitled_tests {
    use super::sfu_entitled;
    use crate::permissions::{ChannelPermAccess, Permissions};

    fn allowed(perms: Permissions) -> ChannelPermAccess {
        ChannelPermAccess::Allowed { server_id: "s".into(), perms }
    }

    #[test]
    fn needs_both_view_and_connect() {
        assert!(sfu_entitled(&allowed(Permissions::VIEW_CHANNEL | Permissions::CONNECT)));
        assert!(!sfu_entitled(&allowed(Permissions::VIEW_CHANNEL)), "VIEW alone is a text-channel reader, not a voice seat");
        assert!(!sfu_entitled(&allowed(Permissions::CONNECT)), "CONNECT without VIEW is a hidden channel — the mint gate 404s it");
        assert!(!sfu_entitled(&allowed(Permissions::SPEAK | Permissions::VIDEO | Permissions::STREAM)), "publish bits do not imply a seat");
    }

    #[test]
    fn administrator_bypasses_like_the_mint_gate() {
        assert!(sfu_entitled(&allowed(Permissions::ADMINISTRATOR)));
    }

    /// NotFound is also what a failed DB lookup resolves to (permissions.rs
    /// fails closed), so this is the "resolve error means evict" case.
    #[test]
    fn unresolvable_or_outsider_is_not_entitled() {
        assert!(!sfu_entitled(&ChannelPermAccess::NotFound));
        assert!(!sfu_entitled(&ChannelPermAccess::NotMember));
        assert!(!sfu_entitled(&allowed(Permissions::empty())), "no permissions at all: refused");
    }
}

#[cfg(test)]
mod publish_sources_tests {
    use super::publish_sources;
    use crate::permissions::Permissions;

    #[test]
    fn no_voice_bits_means_no_publishing_explicitly() {
        let (can, sources) = publish_sources(Permissions::VIEW_CHANNEL | Permissions::CONNECT);
        assert!(!can, "an empty source list must travel with can_publish=false, or LiveKit defaults to every source");
        assert!(sources.is_empty());
    }

    #[test]
    fn each_bit_maps_to_its_sources() {
        assert_eq!(publish_sources(Permissions::SPEAK), (true, vec!["microphone"]));
        assert_eq!(publish_sources(Permissions::VIDEO), (true, vec!["camera"]));
        assert_eq!(publish_sources(Permissions::STREAM), (true, vec!["screen_share", "screen_share_audio"]));
        assert_eq!(
            publish_sources(Permissions::SPEAK | Permissions::VIDEO | Permissions::STREAM),
            (true, vec!["microphone", "camera", "screen_share", "screen_share_audio"])
        );
    }

    #[test]
    fn administrator_gets_everything() {
        assert_eq!(publish_sources(Permissions::ADMINISTRATOR).1.len(), 4);
    }
}

#[cfg(test)]
mod grant_serialization_tests {
    use super::VideoGrant;

    /// The deny case must be visible on the wire: an absent `canPublish` is
    /// "true" to LiveKit, so a grant that means "no media" has to say false.
    #[test]
    fn a_denied_publish_grant_says_so_on_the_wire() {
        let g = VideoGrant {
            room: "r", room_join: true, room_create: false, room_admin: false, room_list: false,
            can_publish: false, can_subscribe: true, can_publish_data: true,
            can_publish_sources: vec![],
        };
        let json = serde_json::to_string(&g).unwrap();
        assert!(json.contains("\"canPublish\":false"), "{json}");
        assert!(json.contains("\"canSubscribe\":true"), "{json}");
        assert!(!json.contains("canPublishSources"), "an empty list is omitted; canPublish:false is what denies — {json}");
        assert!(!json.contains("roomCreate"), "false room flags stay absent (LiveKit defaults them to false) — {json}");
        assert!(!json.contains("roomList"), "{json}");
    }
}

#[cfg(test)]
pub(crate) mod resync_tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn listed(name: &str, ids: &[&str], shares: &[&str]) -> LkRoom {
        LkRoom {
            name: name.into(),
            participants: ids.iter().map(|s| s.to_string()).collect(),
            share_sids: shares.iter().map(|s| s.to_string()).collect(),
            grants: HashMap::new(),
        }
    }

    fn usage(parts: &[(&str, Instant)], res: &[&str], shares: &[&str]) -> SfuRoomUsage {
        SfuRoomUsage {
            participants: parts.iter().map(|(i, t)| (i.to_string(), *t)).collect(),
            reservations: res.iter().map(|i| (i.to_string(), Instant::now())).collect(),
            screen_shares: shares.iter().map(|s| s.to_string()).collect(),
            recheck: HashMap::new(),
            grants: HashMap::new(),
            ..SfuRoomUsage::default()
        }
    }

    // ---- parsing: what LiveKit v1.13.4's Twirp JSON actually looks like -----------

    /// Proto field names, EVERY field emitted (unset ones as "", 0, [] or
    /// "JOINING"), 64-bit integers as strings, enums by name.
    const PARTICIPANTS_SNAKE: &str = r#"{"participants":[
        {"sid":"PA_1","identity":"u5#aa","state":"ACTIVE","tracks":[
            {"sid":"TR_cam","type":"VIDEO","source":"CAMERA"},
            {"sid":"TR_scr","type":"VIDEO","source":"SCREEN_SHARE"},
            {"sid":"TR_sca","type":"AUDIO","source":"SCREEN_SHARE_AUDIO"}],
         "joined_at":"1727350000","joined_at_ms":"1727350000123","is_publisher":true},
        {"sid":"PA_2","identity":"u6#bb","state":"JOINING","tracks":[],"joined_at":"0"},
        {"sid":"PA_3","identity":"u7#cc","state":"JOINED","tracks":[]},
        {"sid":"PA_4","identity":"u8#dd","state":"DISCONNECTED","tracks":[]},
        {"sid":"PA_5","identity":"","state":"ACTIVE","tracks":[]}]}"#;

    #[test]
    fn only_active_sessions_and_screen_shares_are_taken() {
        let (ids, shares) = parse_participants(PARTICIPANTS_SNAKE).expect("parses");
        assert_eq!(ids, vec!["u5#aa".to_string()], "JOINING, JOINED, DISCONNECTED and a blank identity are not sessions");
        assert_eq!(shares, vec!["TR_scr".to_string()], "the camera and the share's AUDIO are not screen shares");
    }

    #[test]
    fn enums_as_numbers_parse_the_same() {
        // What protojson emits with other options: enum numbers, unset fields
        // omitted. ACTIVE = 2, SCREEN_SHARE = 3.
        let body = r#"{"participants":[{"identity":"u5#aa","state":2,"tracks":[{"sid":"TR_scr","source":3},{"sid":"TR_cam","source":1}],"joinedAt":"1"},{"identity":"u6#bb"}]}"#;
        let (ids, shares) = parse_participants(body).expect("parses");
        assert_eq!(ids, vec!["u5#aa".to_string()], "no state at all is JOINING (0), not ACTIVE");
        assert_eq!(shares, vec!["TR_scr".to_string()]);
    }

    #[test]
    fn a_reply_without_its_list_is_an_error_not_an_empty_room() {
        // LiveKit emits unset lists as []; a body without one is not LiveKit's
        // answer (a proxy page, an error shape), and reading it as "nobody here"
        // would clear live sessions.
        assert!(parse_participants(r#"{"code":"unauthenticated","msg":"no"}"#).is_err());
        assert!(parse_room_names(r#"{"code":"unauthenticated","msg":"no"}"#).is_err());
        assert!(parse_room_names("<html>").is_err());
        assert_eq!(parse_participants(r#"{"participants":[]}"#).expect("empty is fine"), (vec![], vec![]));
        assert_eq!(
            parse_room_names(r#"{"rooms":[{"sid":"RM_1","name":"sfu_7","num_participants":1,"creation_time":"1"}]}"#).expect("parses"),
            vec!["sfu_7".to_string()]
        );
    }

    // ---- the merge -------------------------------------------------------------------

    #[test]
    fn a_session_nobody_told_this_process_about_is_learned() {
        let rooms = DashMap::new();
        let journal = SfuResyncJournal::default();
        let started = Instant::now();
        let r = merge(&rooms, &[listed("sfu_7", &["u5#aa"], &["TR_scr"])], &journal, started, Instant::now());
        let u = rooms.get("sfu_7").expect("the room is known now");
        assert!(u.participants.contains_key("u5#aa"), "THE GAP: after a restart this map was empty");
        assert!(u.screen_shares.contains("TR_scr"));
        assert_eq!((r.rooms, r.participants, r.shares, r.added, r.cleared), (1, 1, 1, 2, 0));
    }

    #[test]
    fn a_known_session_keeps_its_time() {
        let rooms = DashMap::new();
        let long_ago = Instant::now();
        rooms.insert("sfu_7".to_string(), usage(&[("u5#aa", long_ago)], &[], &[]));
        std::thread::sleep(Duration::from_millis(5));
        let started = Instant::now();
        let r = merge(&rooms, &[listed("sfu_7", &["u5#aa"], &[])], &SfuResyncJournal::default(), started, Instant::now());
        assert_eq!(rooms.get("sfu_7").unwrap().participants["u5#aa"], long_ago, "admission's settled count must not reset every resync");
        assert_eq!((r.added, r.cleared), (0, 0));
    }

    #[test]
    fn a_session_that_left_during_the_fetch_is_not_brought_back() {
        let rooms = DashMap::new();
        let mut journal = SfuResyncJournal::default();
        journal.record(JournalEntry::Left("sfu_7", "u5#aa"));
        let started = Instant::now();
        merge(&rooms, &[listed("sfu_7", &["u5#aa", "u6#bb"], &[])], &journal, started, Instant::now());
        let u = rooms.get("sfu_7").unwrap();
        assert!(!u.participants.contains_key("u5#aa"), "the snapshot predates the leave");
        // Positive control: the same snapshot DOES add an identity with no
        // journal entry, so the line above is the journal's doing.
        assert!(u.participants.contains_key("u6#bb"));
    }

    #[test]
    fn a_share_unpublished_during_the_fetch_is_not_brought_back() {
        let rooms = DashMap::new();
        let mut journal = SfuResyncJournal::default();
        journal.record(JournalEntry::Unpublished("sfu_7", "TR_1"));
        merge(&rooms, &[listed("sfu_7", &["u5#aa"], &["TR_1", "TR_2"])], &journal, Instant::now(), Instant::now());
        let u = rooms.get("sfu_7").unwrap();
        assert!(!u.screen_shares.contains("TR_1"));
        assert!(u.screen_shares.contains("TR_2"), "control");
    }

    #[test]
    fn a_lost_leave_is_cleared_but_nothing_newer_than_the_snapshot_is() {
        let rooms = DashMap::new();
        let before = Instant::now();
        rooms.insert("sfu_7".to_string(), usage(&[("u5#gone", before), ("u6#joined", before)], &[], &["TR_gone"]));
        std::thread::sleep(Duration::from_millis(5));
        let started = Instant::now();
        let mut journal = SfuResyncJournal::default();
        // Joined DURING the fetch (the snapshot missed it, the webhook did not).
        journal.record(JournalEntry::Joined("sfu_7", "u6#joined"));
        // Inserted after the request went out, by a join this snapshot cannot know.
        rooms.get_mut("sfu_7").unwrap().participants.insert("u7#late".into(), Instant::now());
        let r = merge(&rooms, &[listed("sfu_7", &[], &[])], &journal, started, Instant::now());
        let u = rooms.get("sfu_7").unwrap();
        assert!(!u.participants.contains_key("u5#gone"), "a participant_left that never arrived");
        assert!(u.participants.contains_key("u6#joined"), "journaled join kept");
        assert!(u.participants.contains_key("u7#late"), "newer than the snapshot kept");
        assert!(!u.screen_shares.contains("TR_gone"));
        assert_eq!(r.cleared, 2);
    }

    #[test]
    fn reservations_are_never_the_resyncs_business() {
        let rooms = DashMap::new();
        // A minted token whose room LiveKit does not have yet (it is created by
        // the first join), and one whose holder the snapshot lists as joined.
        rooms.insert("sfu_8".to_string(), usage(&[], &["u9#minted"], &[]));
        rooms.insert("sfu_7".to_string(), usage(&[], &["u5#aa", "u6#waiting"], &[]));
        merge(&rooms, &[listed("sfu_7", &["u5#aa"], &[])], &SfuResyncJournal::default(), Instant::now(), Instant::now());
        assert!(rooms.get("sfu_8").unwrap().reservations.contains_key("u9#minted"), "a room LiveKit lacks keeps its reservations");
        let u = rooms.get("sfu_7").unwrap();
        assert!(u.reservations.contains_key("u6#waiting"), "an unlisted reservation stays");
        assert!(!u.reservations.contains_key("u5#aa") && u.participants.contains_key("u5#aa"), "a listed reservation moves, as its join would move it");
    }

    #[test]
    fn a_room_that_ended_unseen_is_cleared_and_a_finished_one_is_left_alone() {
        let rooms = DashMap::new();
        let before = Instant::now();
        rooms.insert("sfu_9".to_string(), usage(&[("u5#aa", before)], &[], &["TR_1"]));
        std::thread::sleep(Duration::from_millis(5));
        let started = Instant::now();
        let mut journal = SfuResyncJournal::default();
        journal.record(JournalEntry::Finished("sfu_7"));
        let r = merge(&rooms, &[listed("sfu_7", &["u6#bb"], &[])], &journal, started, Instant::now());
        let u = rooms.get("sfu_9").unwrap();
        assert!(u.participants.is_empty() && u.screen_shares.is_empty(), "LiveKit no longer has sfu_9 at all");
        assert!(rooms.get("sfu_7").is_none(), "room_finished during the fetch: the snapshot's view of it is stale");
        assert_eq!(r.cleared, 2);
    }

    #[test]
    fn an_overflowing_journal_marks_itself() {
        let mut j = SfuResyncJournal::default();
        for i in 0..JOURNAL_CAP {
            j.record(JournalEntry::Joined("sfu_1", &format!("u{i}#x")));
        }
        assert!(!j.overflowed, "exactly at the cap is still whole");
        j.record(JournalEntry::Left("sfu_1", "u0#x"));
        assert!(j.overflowed);
    }

    // ---- the calls, over a socket -------------------------------------------------------

    #[test]
    fn the_admin_api_url_prefers_livekit_api_url() {
        let mut cfg = cfg_for("http://127.0.0.1:1");
        cfg.url = "wss://sfu.example.com/".into();
        assert_eq!(api_base(&cfg), "https://sfu.example.com");
        cfg.api_url = Some("http://127.0.0.1:7880/".into());
        assert_eq!(api_base(&cfg), "http://127.0.0.1:7880", "the host's own node, not the public name");
    }

    pub(crate) struct Seen {
        pub(crate) body: String,
        pub(crate) claims: serde_json::Value,
        /// The User-Agent header, as sent.
        ua: String,
        /// A request that came AFTER the script ran out: a call the test did
        /// not expect. `asked` fails on any.
        extra: bool,
    }

    /// Serve `script` in order, one connection each: (path it must be, status,
    /// reply). `on_call` runs with the method name as each request arrives,
    /// before the reply. A token that does not verify under the rig secret is
    /// answered 401, as LiveKit would.
    /// A running stand-in: its task, and the signal that the code under test
    /// is done, until which any call beyond the script is caught.
    pub(crate) struct StandIn {
        task: tokio::task::JoinHandle<Vec<Seen>>,
        stop: tokio::sync::oneshot::Sender<()>,
    }

    pub(crate) async fn livekit_stand_in(
        script: Vec<(&'static str, u16, String)>,
        on_call: Option<Box<dyn Fn(&str) + Send>>,
    ) -> (String, StandIn) {
        livekit_stand_in_holding(script, on_call, None).await
    }

    /// [`livekit_stand_in`], but the reply to scripted call number `hold.0`
    /// (from 0) waits until `hold.1` fires (or its sender is dropped): the code
    /// under test is then parked mid-call, for as long as the test needs.
    pub(crate) async fn livekit_stand_in_holding(
        script: Vec<(&'static str, u16, String)>,
        on_call: Option<Box<dyn Fn(&str) + Send>>,
        mut hold: Option<(usize, tokio::sync::oneshot::Receiver<()>)>,
    ) -> (String, StandIn) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let base = format!("http://{}", listener.local_addr().expect("addr"));
        let (stop, mut stopped) = tokio::sync::oneshot::channel::<()>();
        let task = tokio::spawn(async move {
            let mut seen = Vec::new();
            // The scripted calls, then a watch for any beyond them until stopped.
            let scripted = script.len();
            let mut script = script.into_iter().map(Some).collect::<Vec<_>>();
            script.push(None);
            let mut i = 0usize;
            loop {
                let entry = if i < scripted { script[i].take() } else { None };
                i += 1;
                let accepted = if entry.is_some() {
                    Some(listener.accept().await.expect("accept"))
                } else {
                    tokio::select! {
                        r = listener.accept() => Some(r.expect("accept")),
                        _ = &mut stopped => None,
                    }
                };
                let Some((mut s, _)) = accepted else { break };
                let extra = entry.is_none();
                let (want, status, reply) = entry.unwrap_or(("", 500, String::from("{}")));
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                let (head, body) = loop {
                    let n = s.read(&mut chunk).await.expect("read");
                    assert!(n > 0, "closed before a whole request");
                    buf.extend_from_slice(&chunk[..n]);
                    let text = String::from_utf8_lossy(&buf).to_string();
                    if let Some(end) = text.find("\r\n\r\n") {
                        let len = text[..end]
                            .lines()
                            .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0)))
                            .unwrap_or(0);
                        if buf.len() >= end + 4 + len {
                            break (text[..end].to_string(), text[end + 4..end + 4 + len].to_string());
                        }
                    }
                };
                let path = head.split_whitespace().nth(1).unwrap_or("").to_string();
                if !extra {
                    assert_eq!(path, want, "the calls come in this order");
                }
                let bearer = head
                    .lines()
                    .find_map(|l| l.to_ascii_lowercase().starts_with("authorization:").then(|| l.to_string()))
                    .and_then(|l| l.split_whitespace().nth(2).map(str::to_string))
                    .unwrap_or_default();
                let verified = jsonwebtoken::decode::<serde_json::Value>(
                    &bearer,
                    &jsonwebtoken::DecodingKey::from_secret(RIG_SECRET.as_bytes()),
                    &jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::HS256),
                );
                let ua = head
                    .lines()
                    .find_map(|l| l.to_ascii_lowercase().starts_with("user-agent:").then(|| l[11..].trim().to_string()))
                    .unwrap_or_default();
                let (claims, status) = match verified {
                    Ok(t) => (t.claims, status),
                    Err(_) => (serde_json::Value::Null, 401),
                };
                if let Some(f) = &on_call {
                    f(path.rsplit('/').next().unwrap_or(""));
                }
                if hold.as_ref().is_some_and(|(n, _)| *n + 1 == i) {
                    let (_, released) = hold.take().expect("checked");
                    let _ = released.await;
                }
                seen.push(Seen { body, claims, ua, extra });
                let resp = format!(
                    "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{reply}",
                    reply.len()
                );
                s.write_all(resp.as_bytes()).await.expect("write");
                let _ = s.shutdown().await;
            }
            seen
        });
        (base, StandIn { task, stop })
    }

    pub(crate) async fn asked(srv: StandIn) -> Vec<Seen> {
        let _ = srv.stop.send(());
        let seen = tokio::time::timeout(Duration::from_secs(10), srv.task)
            .await
            .expect("a scripted call never came")
            .expect("stand-in");
        let extra: Vec<&str> = seen.iter().filter(|s| s.extra).map(|s| s.body.as_str()).collect();
        assert!(extra.is_empty(), "calls beyond the script: {extra:?}");
        seen
    }

    fn client() -> reqwest::Client {
        reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(10)).build().expect("client")
    }

    #[tokio::test]
    async fn the_snapshot_lists_rooms_then_each_rooms_sessions_with_the_right_grants() {
        let (base, srv) = livekit_stand_in(
            vec![
                ("/twirp/livekit.RoomService/ListRooms", 200,
                 r#"{"rooms":[{"name":"sfu_7"},{"name":"sfu_07"},{"name":"someone-elses"}]}"#.to_string()),
                ("/twirp/livekit.RoomService/ListParticipants", 200, PARTICIPANTS_SNAKE.to_string()),
            ],
            None,
        )
        .await;
        let (rooms, names) = fetch_snapshot(&cfg_for(&base), &client()).await.expect("snapshot");
        let ignored = names.len() - rooms.len();
        assert!(names.contains("someone-elses") && names.contains("sfu_07"), "every listed name is reported, kept or not");
        assert_eq!(rooms, vec![listed("sfu_7", &["u5#aa"], &["TR_scr"])]);
        assert_eq!(ignored, 2, "a non-canonical spelling and a foreign room are not ours");
        let seen = asked(srv).await;
        assert_eq!(seen[0].body, "{}");
        assert_eq!(seen[0].claims["video"]["roomList"], true, "ListRooms needs roomList");
        assert_eq!(seen[0].claims["iss"], "rig-key");
        let body: serde_json::Value = serde_json::from_str(&seen[1].body).expect("json");
        assert_eq!(body, serde_json::json!({ "room": "sfu_7" }));
        assert_eq!(seen[1].claims["video"]["roomAdmin"], true);
        assert_eq!(seen[1].claims["video"]["room"], "sfu_7", "LiveKit matches the admin grant's room exactly");
    }

    #[tokio::test]
    async fn a_failed_room_fails_the_whole_snapshot() {
        let (base, srv) = livekit_stand_in(
            vec![
                ("/twirp/livekit.RoomService/ListRooms", 200, r#"{"rooms":[{"name":"sfu_7"},{"name":"sfu_8"}]}"#.to_string()),
                ("/twirp/livekit.RoomService/ListParticipants", 200, r#"{"participants":[]}"#.to_string()),
                ("/twirp/livekit.RoomService/ListParticipants", 500, r#"{"code":"internal","msg":"boom"}"#.to_string()),
            ],
            None,
        )
        .await;
        match fetch_snapshot(&cfg_for(&base), &client()).await {
            Err(ResyncError::Refused(500, m)) => assert!(m.contains("boom"), "{m}"),
            other => panic!("a partial snapshot must not be used: {other:?}"),
        }
        asked(srv).await;
    }

    #[test]
    fn a_401_names_the_credentials() {
        let m = ResyncError::Refused(401, "ListRooms: {}".into()).to_string();
        assert!(m.contains("LIVEKIT_API_KEY"), "{m}");
    }

    /// An AppState whose database never answers - quickly: without the short
    /// acquire timeout a lookup waits out sqlx's 30 s default.
    fn test_state() -> Arc<AppState> {
        let pool = sqlx::postgres::PgPoolOptions::new()
            .acquire_timeout(Duration::from_secs(2))
            .connect_lazy("postgres://localhost/does_not_connect")
            .expect("lazy pool");
        AppState::new(pool, "test-secret".into(), None, Arc::new(crate::wake::NullWake))
    }

    /// THE RACE, end to end: while the snapshot is in flight, a webhook says one
    /// listed session left. The merge must honour it, and must still learn the
    /// other one.
    #[tokio::test]
    async fn a_leave_that_lands_during_the_resync_wins_over_its_snapshot() {
        let state = test_state();
        let during = Arc::clone(&state);
        let (base, srv) = livekit_stand_in(
            vec![
                ("/twirp/livekit.RoomService/ListRooms", 200, r#"{"rooms":[{"name":"sfu_7"}]}"#.to_string()),
                ("/twirp/livekit.RoomService/ListParticipants", 200,
                 r#"{"participants":[{"identity":"u5#left","state":"ACTIVE","tracks":[]},{"identity":"u6#stays","state":"ACTIVE","tracks":[]}]}"#.to_string()),
            ],
            // At ListRooms, the FIRST call: the journal must already be open.
            Some(Box::new(move |m: &str| {
                if m == "ListRooms" {
                    journal(&during, JournalEntry::Left("sfu_7", "u5#left"))
                }
            })),
        )
        .await;
        let r = resync_once(&state, &cfg_for(&base), &client()).await.expect("resync");
        asked(srv).await;
        let u = state.sfu_rooms.get("sfu_7").expect("room known");
        assert!(!u.participants.contains_key("u5#left"), "the leave arrived after the snapshot was taken");
        assert!(u.participants.contains_key("u6#stays"));
        assert_eq!(r.added, 1);
        assert!(state.sfu_resync_journal.lock().unwrap().is_none(), "the journal closes with the resync");
    }

    #[tokio::test]
    async fn a_failed_resync_changes_nothing_and_closes_its_journal() {
        let state = test_state();
        state.sfu_rooms.insert("sfu_7".into(), usage(&[("u5#aa", Instant::now())], &[], &[]));
        let (base, srv) = livekit_stand_in(
            vec![("/twirp/livekit.RoomService/ListRooms", 401, r#"{"code":"unauthenticated","msg":"bad token"}"#.to_string())],
            None,
        )
        .await;
        let e = resync_once(&state, &cfg_for(&base), &client()).await.expect_err("401");
        assert!(e.to_string().contains("LIVEKIT_API_KEY"), "{e}");
        asked(srv).await;
        assert!(state.sfu_rooms.get("sfu_7").unwrap().participants.contains_key("u5#aa"), "an unreadable LiveKit is not an empty one");
        assert!(state.sfu_resync_journal.lock().unwrap().is_none());
    }

    /// merge_snapshot with every snapshot room counted as listed.
    fn merge(rooms: &DashMap<String, SfuRoomUsage>, snap: &[LkRoom], journal: &SfuResyncJournal, started: Instant, now: Instant) -> ResyncReport {
        let listed: HashSet<String> = snap.iter().map(|r| r.name.clone()).collect();
        merge_snapshot(rooms, snap, &listed, journal, started, now).report
    }

    #[test]
    fn a_learned_session_is_timed_now_the_fail_safe() {
        let rooms = DashMap::new();
        let started = Instant::now();
        std::thread::sleep(Duration::from_millis(5));
        let now = Instant::now();
        merge(&rooms, &[listed("sfu_7", &["u5#aa"], &[])], &SfuResyncJournal::default(), started, now);
        assert_eq!(rooms.get("sfu_7").unwrap().participants["u5#aa"], now, "admission must charge it as not yet measured");
    }

    #[test]
    fn a_reservation_already_joined_is_moved_not_counted_as_drift() {
        let rooms = DashMap::new();
        rooms.insert("sfu_7".to_string(), usage(&[], &["u5#aa"], &[]));
        let names: HashSet<String> = ["sfu_7".to_string()].into_iter().collect();
        let m = merge_snapshot(&rooms, &[listed("sfu_7", &["u5#aa"], &[])], &names, &SfuResyncJournal::default(), Instant::now(), Instant::now());
        assert_eq!((m.report.added, m.report.moved), (0, 1), "its participant_joined may merely be on its way");
        assert!(m.added.is_empty(), "not added: an ejection intent is no business of a session this process knew");
        assert_eq!(m.moved, vec![("sfu_7".to_string(), "u5#aa".to_string())], "but it IS checked (see resync_once)");
    }

    #[test]
    fn a_room_the_snapshot_skipped_is_not_a_gone_room() {
        let rooms = DashMap::new();
        let before = Instant::now();
        rooms.insert("someone-elses".to_string(), usage(&[("x#1", before)], &[], &["TR_x"]));
        rooms.insert("sfu_9".to_string(), usage(&[("u5#aa", before)], &[], &[]));
        std::thread::sleep(Duration::from_millis(5));
        // LiveKit listed both; the snapshot kept neither sessions list for the
        // foreign one (it is not sfu_<channel>) and sfu_9 is simply absent.
        let listed_names: HashSet<String> = ["someone-elses".to_string()].into_iter().collect();
        let r = merge_snapshot(&rooms, &[], &listed_names, &SfuResyncJournal::default(), Instant::now(), Instant::now()).report;
        let other = rooms.get("someone-elses").unwrap();
        assert!(other.participants.contains_key("x#1") && other.screen_shares.contains("TR_x"), "LiveKit listed it: not gone");
        assert!(rooms.get("sfu_9").unwrap().participants.is_empty(), "control: a room LiveKit did not list IS cleared");
        assert_eq!(r.cleared, 1);
    }

    #[test]
    fn a_share_published_during_the_fetch_survives_in_both_kinds_of_room() {
        let rooms = DashMap::new();
        rooms.insert("sfu_7".to_string(), usage(&[], &[], &["TR_new7", "TR_old7"]));
        rooms.insert("sfu_9".to_string(), usage(&[], &[], &["TR_new9", "TR_old9"]));
        let mut journal = SfuResyncJournal::default();
        journal.record(JournalEntry::Published("sfu_7", "TR_new7"));
        journal.record(JournalEntry::Published("sfu_9", "TR_new9"));
        // sfu_7 listed without either share; sfu_9 not listed at all.
        merge(&rooms, &[listed("sfu_7", &[], &[])], &journal, Instant::now(), Instant::now());
        let (a, b) = (rooms.get("sfu_7").unwrap(), rooms.get("sfu_9").unwrap());
        assert!(a.screen_shares.contains("TR_new7") && b.screen_shares.contains("TR_new9"), "journaled publishes kept");
        assert!(!a.screen_shares.contains("TR_old7") && !b.screen_shares.contains("TR_old9"), "control: unjournaled old shares cleared");
    }

    #[test]
    fn an_unlisted_room_keeps_what_is_newer_than_the_snapshot() {
        let rooms = DashMap::new();
        let before = Instant::now();
        rooms.insert("sfu_9".to_string(), usage(&[("u5#old", before), ("u6#joined", before)], &[], &[]));
        std::thread::sleep(Duration::from_millis(5));
        let started = Instant::now();
        rooms.get_mut("sfu_9").unwrap().participants.insert("u7#late".into(), Instant::now());
        let mut journal = SfuResyncJournal::default();
        journal.record(JournalEntry::Joined("sfu_9", "u6#joined"));
        merge(&rooms, &[], &journal, started, Instant::now());
        let u = rooms.get("sfu_9").unwrap();
        assert!(!u.participants.contains_key("u5#old"));
        assert!(u.participants.contains_key("u6#joined") && u.participants.contains_key("u7#late"));
    }

    #[test]
    fn livekit_api_url_is_where_the_calls_go() {
        let rt_cfg = |base: &str| {
            let mut c = cfg_for("http://127.0.0.1:9");
            c.url = "wss://nowhere.invalid".into();
            c.api_url = Some(base.replacen("http://", "ws://", 1));
            c
        };
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let (base, srv) = livekit_stand_in(
                vec![("/twirp/livekit.RoomService/ListRooms", 200, r#"{"rooms":[]}"#.to_string())],
                None,
            )
            .await;
            // LIVEKIT_URL is unreachable; LIVEKIT_API_URL (written ws://, read
            // as http://) is the stand-in.
            let (rooms, _) = fetch_snapshot(&rt_cfg(&base), &client()).await.expect("snapshot through LIVEKIT_API_URL");
            assert!(rooms.is_empty());
            asked(srv).await;
        });
    }

    #[test]
    fn a_rejected_token_is_logged_without_the_token() {
        let body = "invalid token: eyJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJrZXkifQ.c2lnbmF0dXJl, error: token is expired";
        let m = redact_livekit_error(body);
        assert_eq!(m, "invalid token (redacted), error: token is expired");
        assert!(!m.contains("eyJ"), "{m}");
        assert_eq!(redact_livekit_error(r#"{"code":"internal","msg":"boom"}"#), r#"{"code":"internal","msg":"boom"}"#);
    }

    #[test]
    fn resync_secs_parses_with_a_floor_and_a_startup_only_zero() {
        assert_eq!(resync_period(None), Ok(RESYNC_EVERY));
        assert_eq!(resync_period(Some(" ")), Ok(RESYNC_EVERY));
        assert_eq!(resync_period(Some("0")), Ok(Duration::ZERO));
        assert_eq!(resync_period(Some("1")), Ok(RESYNC_MIN), "raised to the floor");
        assert_eq!(resync_period(Some("600")), Ok(Duration::from_secs(600)));
        assert!(resync_period(Some("180s")).is_err());
        assert!(resync_period(Some("-1")).is_err());
    }

    #[tokio::test]
    async fn every_webhook_arm_journals_its_event() {
        let state = test_state();
        *state.sfu_resync_journal.lock().unwrap() = Some(SfuResyncJournal::default());
        let ev = |v: serde_json::Value| v;
        apply_webhook_event(&state, "participant_joined", "sfu_7".into(), &ev(serde_json::json!({"participant": {"identity": "u5#aa"}})));
        apply_webhook_event(&state, "participant_left", "sfu_7".into(), &ev(serde_json::json!({"participant": {"identity": "u6#bb"}})));
        apply_webhook_event(&state, "track_published", "sfu_7".into(), &ev(serde_json::json!({"track": {"source": "SCREEN_SHARE", "sid": "TR_1"}})));
        apply_webhook_event(&state, "track_unpublished", "sfu_7".into(), &ev(serde_json::json!({"track": {"source": "SCREEN_SHARE", "sid": "TR_2"}})));
        apply_webhook_event(&state, "room_finished", "sfu_8".into(), &ev(serde_json::json!({})));
        let g = state.sfu_resync_journal.lock().unwrap();
        let j = g.as_ref().expect("still open");
        assert!(SfuResyncJournal::has(&j.joined, "sfu_7", "u5#aa"));
        assert!(SfuResyncJournal::has(&j.left, "sfu_7", "u6#bb"));
        assert!(SfuResyncJournal::has(&j.published, "sfu_7", "TR_1"));
        assert!(SfuResyncJournal::has(&j.unpublished, "sfu_7", "TR_2"));
        assert!(j.finished.contains("sfu_8"));
        // And the map itself moved as before.
        assert!(state.sfu_rooms.get("sfu_7").unwrap().participants.contains_key("u5#aa"));
    }

    #[tokio::test]
    async fn an_ejection_journals_its_intent_and_its_confirmed_removal() {
        no_env_proxy();
        let state = test_state();
        state.sfu_rooms.insert("sfu_7".into(), usage(&[("u5#aa", Instant::now())], &[], &[]));
        *state.sfu_resync_journal.lock().unwrap() = Some(SfuResyncJournal::default());
        let (base, srv) = livekit_stand_in(
            vec![("/twirp/livekit.RoomService/RemoveParticipant", 200, "{}".to_string())],
            None,
        )
        .await;
        let out = evict_with(&state, &cfg_for(&base), 7, 5).await;
        assert_eq!(out, Evicted { tried: 1, removed: 1 });
        let seen = asked(srv).await;
        assert_eq!(seen[0].claims["video"]["roomAdmin"], true, "a verified admin token");
        assert_eq!(seen[0].ua, "puca-server", "a CDN in front of LiveKit challenges requests without one");
        let g = state.sfu_resync_journal.lock().unwrap();
        let j = g.as_ref().unwrap();
        assert!(j.evict_intents.contains(&("sfu_7".to_string(), 5)));
        assert!(SfuResyncJournal::has(&j.left, "sfu_7", "u5#aa"));
        assert!(!state.sfu_rooms.get("sfu_7").unwrap().participants.contains_key("u5#aa"));
    }

    #[tokio::test]
    async fn an_ejection_during_the_fetch_is_applied_to_what_the_merge_added_only() {
        no_env_proxy();
        let state = test_state();
        let during = Arc::clone(&state);
        let (base, srv) = livekit_stand_in(
            vec![
                ("/twirp/livekit.RoomService/ListRooms", 200, r#"{"rooms":[{"name":"sfu_7"}]}"#.to_string()),
                ("/twirp/livekit.RoomService/ListParticipants", 200,
                 r#"{"participants":[{"identity":"u5#aa","state":"ACTIVE","tracks":[]},{"identity":"u6#bb","state":"ACTIVE","tracks":[]}]}"#.to_string()),
                ("/twirp/livekit.RoomService/RemoveParticipant", 200, "{}".to_string()),
            ],
            // While LiveKit is being read, user 5 is moved out of this room (the
            // cut finds nothing: this process does not know u5#aa yet), and
            // then joins again as u5#new - a session the ejection predates.
            Some(Box::new(move |m: &str| {
                if m == "ListRooms" {
                    journal(&during, JournalEntry::EvictIntent("sfu_7", 5));
                    journal(&during, JournalEntry::Joined("sfu_7", "u5#new"));
                    during.sfu_rooms.entry("sfu_7".into()).or_default().participants.insert("u5#new".into(), Instant::now());
                }
            })),
        )
        .await;
        let r = resync_once(&state, &cfg_for(&base), &client()).await.expect("resync");
        let seen = asked(srv).await;
        assert_eq!(r.reapplied, 1);
        assert_eq!(seen.len(), 3, "exactly one removal (asked fails on any call beyond the script)");
        let body: serde_json::Value = serde_json::from_str(&seen[2].body).unwrap();
        assert_eq!(body, serde_json::json!({ "room": "sfu_7", "identity": "u5#aa" }), "the session the merge added");
        assert_eq!(seen[2].ua, "puca-server");
        let u = state.sfu_rooms.get("sfu_7").unwrap();
        assert!(!u.participants.contains_key("u5#aa"), "ejected after all");
        assert!(u.participants.contains_key("u5#new"), "a session newer than the ejection is not its business");
        // u6#bb is added and goes through the join check, whose database here
        // cannot answer: a failed lookup keeps the session.
        assert!(u.participants.contains_key("u6#bb"), "an unanswerable join check drops nobody");
        assert_eq!(r.denied, 0);
    }

    #[tokio::test]
    async fn an_overflowing_journal_discards_the_snapshot() {
        let state = test_state();
        state.sfu_rooms.insert("sfu_7".into(), usage(&[("u5#aa", Instant::now())], &[], &[]));
        let during = Arc::clone(&state);
        let (base, srv) = livekit_stand_in(
            vec![("/twirp/livekit.RoomService/ListRooms", 200, r#"{"rooms":[]}"#.to_string())],
            Some(Box::new(move |_: &str| {
                for i in 0..=JOURNAL_CAP {
                    journal(&during, JournalEntry::Joined("sfu_1", &format!("u{i}#x")));
                }
            })),
        )
        .await;
        match resync_once(&state, &cfg_for(&base), &client()).await {
            Err(ResyncError::Busy) => {}
            other => panic!("an overflowed journal cannot vouch for the snapshot: {other:?}"),
        }
        asked(srv).await;
        assert!(state.sfu_rooms.get("sfu_7").unwrap().participants.contains_key("u5#aa"), "an empty listing was NOT applied");
        assert!(state.sfu_resync_journal.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn the_reconciler_backs_off_retries_and_zero_stops_after_the_first_success() {
        no_env_proxy();
        let state = test_state();
        // Whether the reconciler said it was running, at each call it made.
        let running_at_calls = Arc::new(std::sync::Mutex::new(Vec::new()));
        let (during, record) = (Arc::clone(&state), Arc::clone(&running_at_calls));
        let (base, srv) = livekit_stand_in(
            vec![
                ("/twirp/livekit.RoomService/ListRooms", 503, r#"{"code":"unavailable","msg":"starting"}"#.to_string()),
                ("/twirp/livekit.RoomService/ListRooms", 200, r#"{"rooms":[]}"#.to_string()),
            ],
            Some(Box::new(move |_: &str| {
                record.lock().unwrap().push(*during.sfu_resync_running.lock().unwrap());
            })),
        )
        .await;
        let cfg_base = base.clone();
        let started = Instant::now();
        assert!(!*state.sfu_resync_running.lock().unwrap(), "not running before it starts");
        tokio::time::timeout(
            Duration::from_secs(15),
            run_reconciler(Arc::clone(&state), Duration::ZERO, move || Some(cfg_for(&cfg_base))),
        )
        .await
        .expect("SFU_RESYNC_SECS=0 returns after its first success");
        assert!(started.elapsed() >= Duration::from_secs(RESYNC_RETRY_SECS[0]), "it waited before retrying");
        assert_eq!(asked(srv).await.len(), 2, "one failure, one success, then nothing");
        assert_eq!(*running_at_calls.lock().unwrap(), vec![true, true], "running - so retries are promised - while it works");
        assert!(!*state.sfu_resync_running.lock().unwrap(), "stopped: nothing will retry a mark made now, and the logs must say so");
    }


    /// Tests that reach the stand-in through the PRODUCTION clients (which
    /// honour HTTP(S)_PROXY / ALL_PROXY) need 127.0.0.1 exempted; say so.
    pub(crate) fn no_env_proxy() {
        let no = std::env::var("NO_PROXY").or_else(|_| std::env::var("no_proxy")).unwrap_or_default();
        let exempt = no.split(',').map(str::trim).any(|h| h == "*" || h == "127.0.0.1" || h.starts_with("127.0.0.0/"));
        // The stand-in is http://, so HTTPS_PROXY never applies to it.
        for k in ["HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"] {
            if std::env::var_os(k).is_some_and(|v| !v.is_empty()) {
                assert!(exempt, "{k} is set: add 127.0.0.1 to NO_PROXY to run the resync socket tests");
            }
        }
    }

    #[tokio::test]
    async fn an_ejection_of_a_user_this_process_does_not_know_still_leaves_its_intent() {
        let state = test_state();
        *state.sfu_resync_journal.lock().unwrap() = Some(SfuResyncJournal::default());
        // No stand-in: with nothing known there is nothing to call.
        let out = evict_with(&state, &cfg_for("http://127.0.0.1:9"), 7, 5).await;
        assert_eq!(out, Evicted::default());
        let g = state.sfu_resync_journal.lock().unwrap();
        assert!(g.as_ref().unwrap().evict_intents.contains(&("sfu_7".to_string(), 5)), "the case the intent exists for");
    }

    #[tokio::test]
    async fn a_token_signed_with_another_secret_is_refused_by_the_stand_in() {
        // The negative control for every signature check above.
        let (base, srv) = livekit_stand_in(
            vec![("/twirp/livekit.RoomService/ListRooms", 200, r#"{"rooms":[]}"#.to_string())],
            None,
        )
        .await;
        let mut cfg = cfg_for(&base);
        cfg.api_secret = "some-other-secret-0123456789abcdef".into();
        match fetch_snapshot(&cfg, &client()).await {
            Err(ResyncError::Refused(401, _)) => {}
            other => panic!("a wrongly signed token must be refused: {other:?}"),
        }
        asked(srv).await;
    }

    #[test]
    fn the_reconciler_runs_only_with_livekit_api_url() {
        assert!(reconciler_plan(false, None).is_none(), "off: the public URL may be another host's node");
        assert!(reconciler_plan(false, Some("60")).is_none());
        assert_eq!(reconciler_plan(true, None), Some(Ok(RESYNC_EVERY)));
        assert_eq!(reconciler_plan(true, Some("60")), Some(Ok(Duration::from_secs(60))));
        assert!(matches!(reconciler_plan(true, Some("x")), Some(Err(_))));
    }

    #[test]
    fn only_leaving_sfu_mode_cuts_sessions_at_the_sfu() {
        let usage = usage(&[("u5#aa", Instant::now()), ("u6#bb", Instant::now())], &["u7#cc"], &[]);
        let cut: std::collections::BTreeSet<i64> = [5].into_iter().collect();
        assert!(sfu_only_to_cut(false, &cut, Some(&usage)).is_empty(), "entering SFU mode: the room holds the new call");
        assert_eq!(sfu_only_to_cut(true, &cut, Some(&usage)), [6, 7].into_iter().collect(), "leaving: all but those already cut");
        assert!(sfu_only_to_cut(true, &cut, None).is_empty());
    }

    /// THE JOIN CHECK against a real database (TEST_DATABASE_URL; skips without
    /// it). The resync learns a member and a non-member in an SFU channel; only
    /// the non-member is removed, exactly as participant_joined would have done.
    #[tokio::test]
    async fn the_join_check_removes_only_whom_the_database_refuses() {
        let Some(pool) = crate::migrator::test_pool(2).await else { return };
        no_env_proxy();
        let tag = uuid::Uuid::new_v4().simple().to_string();
        let mk = |n: &str| format!("rs_{n}_{}", &tag[..12]);
        let mut users = Vec::new();
        for n in ["owner", "member", "outsider"] {
            let (id,): (i32,) = sqlx::query_as("INSERT INTO users (username, email, salt, verifier, created_at) VALUES ($1, $2, $3, $4, NOW()) RETURNING id")
                .bind(mk(n)).bind(format!("{}@test.invalid", mk(n))).bind(b"s".as_ref()).bind(b"v".as_ref())
                .fetch_one(&pool).await.expect("user");
            users.push(id as i64);
        }
        let (owner, member, outsider) = (users[0], users[1], users[2]);
        let sid = uuid::Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO servers (id, name, owner_id) VALUES ($1, $2, $3)").bind(&sid).bind(mk("srv")).bind(owner as i32).execute(&pool).await.expect("server");
        sqlx::query("INSERT INTO server_members (server_id, user_id) VALUES ($1, $2), ($1, $3)").bind(&sid).bind(owner as i32).bind(member as i32).execute(&pool).await.expect("members");
        let everyone = (Permissions::VIEW_CHANNEL | Permissions::CONNECT).bits() as i64;
        sqlx::query("INSERT INTO server_roles (server_id, name, color, permissions, position, is_default) VALUES ($1, '@everyone', '#99AAB5', $2, 0, true)")
            .bind(&sid).bind(everyone).execute(&pool).await.expect("@everyone");
        let (cid,): (i32,) = sqlx::query_as("INSERT INTO channels (server_id, name, type, sfu_mode) VALUES ($1, 'v', 1, true) RETURNING id")
            .bind(&sid).fetch_one(&pool).await.expect("channel");
        let cid = cid as i64;
        // A voice channel NOT in SFU mode: nobody belongs in its LiveKit room.
        let (mesh,): (i32,) = sqlx::query_as("INSERT INTO channels (server_id, name, type, sfu_mode) VALUES ($1, 'm', 1, false) RETURNING id")
            .bind(&sid).fetch_one(&pool).await.expect("mesh channel");
        let mesh_room = room_name_for_channel(mesh as i64);
        // A voice channel with no owning server: it exists (the channels query
        // confirms it), yet the permission lookup can only answer NotFound - the
        // unanswered case, which must keep the session and mark it.
        let (orphan,): (i32,) = sqlx::query_as("INSERT INTO channels (name, type, sfu_mode) VALUES ('o', 1, true) RETURNING id")
            .fetch_one(&pool).await.expect("server-less channel");
        let orphan_room = room_name_for_channel(orphan as i64);

        let state = AppState::new(pool.clone(), "test-secret".into(), None, Arc::new(crate::wake::NullWake));
        let room = room_name_for_channel(cid);
        let (id_m, id_x, id_mesh) = (format!("u{member}#m1"), format!("u{outsider}#x1"), format!("u{member}#m2"));
        let id_orphan = format!("u{member}#m3");
        let (base, srv) = livekit_stand_in(
            vec![
                ("/twirp/livekit.RoomService/ListRooms", 200, format!(r#"{{"rooms":[{{"name":"{room}"}},{{"name":"{mesh_room}"}},{{"name":"{orphan_room}"}}]}}"#)),
                ("/twirp/livekit.RoomService/ListParticipants", 200,
                 // The member's grant is already what VIEW + CONNECT give (no
                 // publishing), so keeping them sends nothing either.
                 format!(r#"{{"participants":[{{"identity":"{id_m}","state":"ACTIVE","tracks":[],"permission":{{"can_subscribe":true,"can_publish":false,"can_publish_data":true,"can_publish_sources":[]}}}},{{"identity":"{id_x}","state":"ACTIVE","tracks":[]}}]}}"#)),
                ("/twirp/livekit.RoomService/ListParticipants", 200,
                 format!(r#"{{"participants":[{{"identity":"{id_mesh}","state":"ACTIVE","tracks":[]}}]}}"#)),
                ("/twirp/livekit.RoomService/ListParticipants", 200,
                 format!(r#"{{"participants":[{{"identity":"{id_orphan}","state":"ACTIVE","tracks":[]}}]}}"#)),
                ("/twirp/livekit.RoomService/RemoveParticipant", 200, "{}".to_string()),
                ("/twirp/livekit.RoomService/RemoveParticipant", 200, "{}".to_string()),
            ],
            None,
        )
        .await;
        // The member's session is already known and owed a check from an earlier
        // pass that could not get an answer: this pass answers it, and the mark
        // must go.
        {
            let mut u = state.sfu_rooms.entry(room.clone()).or_default();
            u.participants.insert(id_m.clone(), Instant::now());
            u.recheck.insert(id_m.clone(), Mark { what: Recheck::JoinCheck, passes: 1 });
        }
        let r = resync_once(&state, &cfg_for(&base), &client()).await.expect("resync");
        let seen = asked(srv).await;
        let removed: std::collections::BTreeSet<String> = seen[4..]
            .iter()
            .map(|s| serde_json::from_str::<serde_json::Value>(&s.body).unwrap()["identity"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(removed, [id_x.clone(), id_mesh.clone()].into_iter().collect(), "the non-member, and the member in a non-SFU channel");
        assert_eq!(r.denied, 2);
        assert_eq!(r.pending, 1, "only the server-less channel's session is owed another look");
        let u = state.sfu_rooms.get(&room).unwrap();
        assert!(u.participants.contains_key(&id_m), "a member of an SFU channel stays");
        assert!(u.recheck.get(&id_m).is_none(), "answered and allowed: the owed check is cleared");
        assert!(!u.participants.contains_key(&id_x));
        drop(u);
        let o = state.sfu_rooms.get(&orphan_room).unwrap();
        assert!(o.participants.contains_key(&id_orphan), "an unanswered lookup keeps the session");
        assert_eq!(
            o.recheck.get(&id_orphan).map(|m| m.what),
            Some(Recheck::LiveGrant),
            "and marks it to be asked again - as the live session it is"
        );
        drop(o);
        let _ = sqlx::query("DELETE FROM channels WHERE id = $1").bind(orphan).execute(&pool).await;
        let _ = sqlx::query("DELETE FROM servers WHERE id = $1").bind(&sid).execute(&pool).await;
        let _ = sqlx::query("DELETE FROM users WHERE id = ANY($1)").bind(users.iter().map(|u| *u as i32).collect::<Vec<_>>()).execute(&pool).await;
    }


    #[test]
    fn the_join_check_refuses_only_on_answers() {
        use crate::permissions::Permissions as P;
        let allowed = |p: P| ChannelPermAccess::Allowed { server_id: "s".into(), perms: p };
        assert_eq!(join_check_refuses(false, None), Some("the channel is not an SFU voice channel"));
        assert_eq!(join_check_refuses(true, Some(&allowed(P::VIEW_CHANNEL | P::CONNECT))), None);
        assert!(join_check_refuses(true, Some(&allowed(P::VIEW_CHANNEL))).is_some(), "no CONNECT");
        assert!(join_check_refuses(true, Some(&ChannelPermAccess::NotMember)).is_some(), "a confirmed non-member");
        assert_eq!(join_check_refuses(true, Some(&ChannelPermAccess::NotFound)), None, "a failed lookup keeps the session");
    }

    #[tokio::test]
    async fn a_removal_livekit_does_not_confirm_stays_known_and_is_cut_again_next_pass() {
        no_env_proxy();
        let state = test_state();
        state.sfu_rooms.insert("sfu_7".into(), usage(&[("u5#aa", Instant::now())], &[], &[]));
        let (base, srv) = livekit_stand_in(
            vec![("/twirp/livekit.RoomService/RemoveParticipant", 503, r#"{"code":"unavailable"}"#.to_string())],
            None,
        )
        .await;
        let removed = remove_or_mark(&state, &cfg_for(&base), "sfu_7", &["u5#aa".to_string()], Recheck::Cut).await;
        asked(srv).await;
        assert_eq!(removed, 0);
        {
            let u = state.sfu_rooms.get("sfu_7").unwrap();
            assert!(u.participants.contains_key("u5#aa"), "still KNOWN: counted by admission, reachable by a kick");
            assert_eq!(u.recheck.get("u5#aa"), Some(&Mark { what: Recheck::Cut, passes: 1 }));
        }
        // The next pass: LiveKit still lists it, so it is cut again - and it is
        // not drift, it was never unknown.
        let (base, srv) = livekit_stand_in(
            vec![
                ("/twirp/livekit.RoomService/ListRooms", 200, r#"{"rooms":[{"name":"sfu_7"}]}"#.to_string()),
                ("/twirp/livekit.RoomService/ListParticipants", 200, r#"{"participants":[{"identity":"u5#aa","state":"ACTIVE","tracks":[]}]}"#.to_string()),
                ("/twirp/livekit.RoomService/RemoveParticipant", 200, "{}".to_string()),
            ],
            None,
        )
        .await;
        let r = resync_once(&state, &cfg_for(&base), &client()).await.expect("resync");
        asked(srv).await;
        assert_eq!((r.reapplied, r.added, r.pending), (1, 0, 0));
        assert!(!state.sfu_rooms.get("sfu_7").map(|u| u.participants.contains_key("u5#aa")).unwrap_or(false));
    }

    #[tokio::test]
    async fn an_unanswerable_join_check_is_asked_again_next_pass() {
        no_env_proxy();
        let state = test_state();
        let (base, srv) = livekit_stand_in(
            vec![
                ("/twirp/livekit.RoomService/ListRooms", 200, r#"{"rooms":[{"name":"sfu_7"}]}"#.to_string()),
                ("/twirp/livekit.RoomService/ListParticipants", 200, r#"{"participants":[{"identity":"u6#bb","state":"ACTIVE","tracks":[]}]}"#.to_string()),
            ],
            None,
        )
        .await;
        // test_state's database never answers.
        let r = resync_once(&state, &cfg_for(&base), &client()).await.expect("resync");
        asked(srv).await;
        {
            let u = state.sfu_rooms.get("sfu_7").unwrap();
            assert!(u.participants.contains_key("u6#bb"), "kept: nobody is dropped on a database that cannot answer");
            assert_eq!(u.recheck.get("u6#bb"), Some(&Mark { what: Recheck::LiveGrant, passes: 1 }), "and asked about again - a live session");
        }
        assert_eq!(r.pending, 1);
        // The next pass: it is DUE (not added - no drift), asked again, and
        // still unanswered: one more pass counted.
        let (base, srv) = livekit_stand_in(
            vec![
                ("/twirp/livekit.RoomService/ListRooms", 200, r#"{"rooms":[{"name":"sfu_7"}]}"#.to_string()),
                ("/twirp/livekit.RoomService/ListParticipants", 200, r#"{"participants":[{"identity":"u6#bb","state":"ACTIVE","tracks":[]}]}"#.to_string()),
            ],
            None,
        )
        .await;
        let r = resync_once(&state, &cfg_for(&base), &client()).await.expect("second pass");
        asked(srv).await;
        assert_eq!((r.added, r.pending), (0, 1));
        assert_eq!(state.sfu_rooms.get("sfu_7").unwrap().recheck.get("u6#bb"), Some(&Mark { what: Recheck::LiveGrant, passes: 2 }));
    }

    #[tokio::test]
    async fn a_mark_that_never_completes_is_given_up_and_the_session_kept() {
        no_env_proxy();
        let state = test_state();
        let mut u = usage(&[("u6#bb", Instant::now())], &[], &[]);
        u.recheck.insert("u6#bb".into(), Mark { what: Recheck::JoinCheck, passes: MARK_PASSES });
        state.sfu_rooms.insert("sfu_7".into(), u);
        let (base, srv) = livekit_stand_in(
            vec![
                ("/twirp/livekit.RoomService/ListRooms", 200, r#"{"rooms":[{"name":"sfu_7"}]}"#.to_string()),
                ("/twirp/livekit.RoomService/ListParticipants", 200, r#"{"participants":[{"identity":"u6#bb","state":"ACTIVE","tracks":[]}]}"#.to_string()),
            ],
            None,
        )
        .await;
        let r = resync_once(&state, &cfg_for(&base), &client()).await.expect("resync");
        asked(srv).await;
        let u = state.sfu_rooms.get("sfu_7").unwrap();
        assert!(u.recheck.is_empty(), "past the bound: given up, so SFU_RESYNC_SECS=0 can stop");
        assert!(u.participants.contains_key("u6#bb"), "given up is not forgotten: still counted");
        assert_eq!(r.pending, 0);
    }

    #[tokio::test]
    async fn any_ejection_livekit_does_not_confirm_is_marked_for_a_check() {
        no_env_proxy();
        let state = test_state();
        state.sfu_rooms.insert("sfu_7".into(), usage(&[("u5#aa", Instant::now())], &[], &[]));
        let (base, srv) = livekit_stand_in(
            vec![("/twirp/livekit.RoomService/RemoveParticipant", 503, r#"{"code":"unavailable"}"#.to_string())],
            None,
        )
        .await;
        // What a kick, a ban or the join webhook's re-auth calls.
        let out = evict_with(&state, &cfg_for(&base), 7, 5).await;
        asked(srv).await;
        assert_eq!(out, Evicted { tried: 1, removed: 0 });
        assert_eq!(
            state.sfu_rooms.get("sfu_7").unwrap().recheck.get("u5#aa"),
            Some(&Mark { what: Recheck::JoinCheck, passes: 0 }),
            "the next resync checks it again instead of the kick ending there - owed, with no resync pass counted yet"
        );
    }

    /// Only a RESYNC pass counts towards MARK_PASSES. A kick, a sweep or a join
    /// check failing outside one makes sure a mark exists and leaves an
    /// existing one exactly as it is - so any number of failed sweeps between
    /// two resyncs cannot give a mark up before a resync has retried it. The
    /// resync's own failure (`mark`) is the positive control: it does count.
    #[tokio::test]
    async fn a_failure_outside_the_resync_owes_a_mark_but_never_counts_a_pass() {
        use crate::permissions::Permissions as P;
        no_env_proxy();
        let state = test_state();
        {
            let now = Instant::now();
            let mut u = usage(&[("u5#new", now), ("u5#owed", now), ("u5#cut", now)], &[], &[]);
            for id in ["u5#new", "u5#owed", "u5#cut"] {
                u.grants.insert(id.into(), Grant::of(P::SPEAK | P::VIDEO));
            }
            u.recheck.insert("u5#owed".into(), Mark { what: Recheck::JoinCheck, passes: 3 });
            u.recheck.insert("u5#cut".into(), Mark { what: Recheck::Cut, passes: 2 });
            state.sfu_rooms.insert("sfu_7".into(), u);
        }
        let marks = || {
            let u = state.sfu_rooms.get("sfu_7").unwrap();
            ["u5#new", "u5#owed", "u5#cut"].map(|id| u.recheck.get(id).copied())
        };
        let want = [
            Some(Mark { what: Recheck::LiveGrant, passes: 0 }),
            Some(Mark { what: Recheck::JoinCheck, passes: 3 }),
            Some(Mark { what: Recheck::Cut, passes: 2 }),
        ];
        // More failed sweeps than MARK_PASSES, one after another: every grant
        // refused, every time.
        for sweep in 0..=MARK_PASSES {
            let refused = (0..3)
                .map(|_| ("/twirp/livekit.RoomService/UpdateParticipant", 503, r#"{"code":"unavailable"}"#.to_string()))
                .collect();
            let (base, srv) = livekit_stand_in(refused, None).await;
            let out = regrant_user_with(&state, &cfg_for(&base), 7, 5, P::VIEW_CHANNEL | P::CONNECT | P::VIDEO).await;
            asked(srv).await;
            assert_eq!(out, Regranted { tried: 3, applied: 0, unchanged: 0, resync_retries: false });
            assert_eq!(marks(), want, "sweep {sweep}: owed once, never counted, never given up");
        }
        // A failed kick of the same user does not count either. It does raise
        // the owed live grant to a join check (the stronger debt), and it
        // never lowers a Cut.
        let refused = (0..3)
            .map(|_| ("/twirp/livekit.RoomService/RemoveParticipant", 503, r#"{"code":"unavailable"}"#.to_string()))
            .collect();
        let (base, srv) = livekit_stand_in(refused, None).await;
        assert_eq!(evict_with(&state, &cfg_for(&base), 7, 5).await, Evicted { tried: 3, removed: 0 });
        asked(srv).await;
        let raised = Some(Mark { what: Recheck::JoinCheck, passes: 0 });
        assert_eq!(marks(), [raised, want[1], want[2]], "a failed kick owes, and counts nothing");
        // Positive control: a RESYNC pass that fails them counts one pass each
        // - and it, too, keeps the stronger debt.
        let all = ["u5#new", "u5#owed", "u5#cut"].map(|id| ("sfu_7".to_string(), id.to_string()));
        mark(&state, &all, Recheck::LiveGrant);
        assert_eq!(
            marks(),
            [
                Some(Mark { what: Recheck::JoinCheck, passes: 1 }),
                Some(Mark { what: Recheck::JoinCheck, passes: 4 }),
                Some(Mark { what: Recheck::Cut, passes: 3 }),
            ]
        );
    }

    #[test]
    fn a_mark_only_ever_moves_up_to_the_stronger_debt() {
        use Recheck::*;
        for (a, b, strong) in [(LiveGrant, JoinCheck, JoinCheck), (JoinCheck, Cut, Cut), (LiveGrant, Cut, Cut)] {
            assert_eq!(a.stronger(b), strong);
            assert_eq!(b.stronger(a), strong);
            assert_eq!(a.stronger(a), a);
        }
    }

    /// A line about an unconfirmed grant promises a retry only while the
    /// reconciler runs - `owe` reports it, read under the running flag's lock -
    /// and otherwise says the grant is NOT enforced, and until WHAT: for a live
    /// (microphone) grant, a later sweep that finds it still differing from the
    /// grant last confirmed; for a join-time grant, the next permission change
    /// (whose sweep now sends the whole grant) or a rejoin.
    #[tokio::test]
    async fn the_retry_note_promises_a_retry_only_while_the_reconciler_runs() {
        let state = test_state();
        state.sfu_rooms.insert("sfu_7".into(), usage(&[("u5#a", Instant::now())], &[], &[]));
        let session = [("sfu_7".to_string(), "u5#a".to_string())];
        let retried = owe(&state, &session, Recheck::LiveGrant);
        assert!(!retried, "never started (no LIVEKIT_API_URL): nothing will retry it");
        let (live, join) = (grant_retry_note(retried, GrantAt::Live), grant_retry_note(retried, GrantAt::Join));
        assert!(live.contains("may not be enforced") && live.contains("even when its grant looks unchanged"), "{live}");
        assert!(join.contains("NOT enforced") && join.contains("whole grant"), "{join}");
        *state.sfu_resync_running.lock().unwrap() = true;
        let retried = owe(&state, &session, Recheck::JoinCheck);
        assert!(retried, "running: the resync will retry it");
        for at in [GrantAt::Live, GrantAt::Join] {
            let note = grant_retry_note(retried, at);
            assert!(note.contains("will retry") && !note.contains("NOT"), "{note}");
        }
    }

    #[tokio::test]
    async fn a_join_clears_an_older_mark() {
        let state = test_state();
        let mut u = usage(&[("u5#aa", Instant::now())], &[], &[]);
        u.recheck.insert("u5#aa".into(), Mark { what: Recheck::Cut, passes: 2 });
        state.sfu_rooms.insert("sfu_7".into(), u);
        apply_webhook_event(&state, "participant_joined", "sfu_7".into(), &serde_json::json!({"participant": {"identity": "u5#aa"}}));
        assert!(state.sfu_rooms.get("sfu_7").unwrap().recheck.is_empty(), "the webhook's own check supersedes it");
    }

    #[test]
    fn zero_period_keeps_going_only_while_something_is_owed() {
        assert_eq!(next_wait(Duration::from_secs(180), 0), Some(Duration::from_secs(180)));
        assert_eq!(next_wait(Duration::from_secs(180), 3), Some(Duration::from_secs(180)));
        assert_eq!(next_wait(Duration::ZERO, 0), None, "SFU_RESYNC_SECS=0: done after the first success");
        assert_eq!(next_wait(Duration::ZERO, 2), Some(Duration::from_secs(30)), "unless a cut or a check is still owed");
    }


    // ---- publish grants mid-call --------------------------------------------------------

    /// A ParticipantInfo as LiveKit's Twirp JSON spells it (proto names, every
    /// field emitted) - what UpdateParticipant answers - carrying `permission`.
    fn info_reply(permission: &str) -> String {
        format!(r#"{{"sid":"PA_1","identity":"u5#a","state":"ACTIVE","tracks":[],"permission":{permission},"joined_at":"1"}}"#)
    }

    /// Permissions as LiveKit reports them back (every field emitted).
    pub(crate) const CAMERA_ONLY: &str = r#"{"can_subscribe":true,"can_publish":true,"can_publish_data":true,"can_publish_sources":["CAMERA"],"hidden":false,"recorder":false,"can_update_metadata":false,"agent":false,"can_subscribe_metrics":false,"can_manage_agent_session":false}"#;
    pub(crate) const MIC_AND_CAMERA: &str = r#"{"can_subscribe":true,"can_publish":true,"can_publish_data":true,"can_publish_sources":["MICROPHONE","CAMERA"],"hidden":false,"recorder":false,"can_update_metadata":false,"agent":false,"can_subscribe_metrics":false,"can_manage_agent_session":false}"#;

    pub(crate) const MIC_ONLY: &str = r#"{"can_subscribe":true,"can_publish":true,"can_publish_data":true,"can_publish_sources":["MICROPHONE"],"hidden":false,"recorder":false,"can_update_metadata":false,"agent":false,"can_subscribe_metrics":false,"can_manage_agent_session":false}"#;

    /// The request body a revoke of SPEAK sends for a member who keeps VIDEO.
    fn camera_only_request(room: &str, identity: &str) -> serde_json::Value {
        serde_json::json!({
            "room": room,
            "identity": identity,
            "permission": {"can_subscribe": true, "can_publish": true, "can_publish_data": true, "can_publish_sources": ["CAMERA"]}
        })
    }

    /// The request body a join-time check sends for a member who may SPEAK but
    /// no longer use VIDEO: the whole grant, camera removed.
    fn mic_only_request(room: &str, identity: &str) -> serde_json::Value {
        serde_json::json!({
            "room": room,
            "identity": identity,
            "permission": {"can_subscribe": true, "can_publish": true, "can_publish_data": true, "can_publish_sources": ["MICROPHONE"]}
        })
    }

    /// JOIN time versus LIVE: a token minted with SPEAK and VIDEO, VIDEO
    /// revoked since. A join-time check gives the WHOLE grant the member has
    /// now - camera removed (on SFU the grant is the only binding control for
    /// a camera) - while the live sweep moves only the microphone, which is
    /// already right, and so sends nothing at all. The same held grant and the
    /// same permissions, so the difference is the moment alone.
    #[tokio::test]
    async fn a_join_time_check_gives_the_whole_grant_and_a_live_one_only_the_microphone() {
        use crate::permissions::Permissions as P;
        no_env_proxy();
        let state = test_state();
        let token = Grant::of(P::SPEAK | P::VIDEO);
        let now_perms = P::VIEW_CHANNEL | P::CONNECT | P::SPEAK;
        {
            let mut u = usage(&[("u5#a", Instant::now())], &[], &[]);
            u.grants.insert("u5#a".into(), token);
            state.sfu_rooms.insert("sfu_7".into(), u);
        }
        // Live: nothing to send (the stand-in fails on any call).
        let (base, srv) = livekit_stand_in(vec![], None).await;
        let live = regrant_if_stale(&state, &cfg_for(&base), "sfu_7", "u5#a", now_perms, GrantAt::Live).await;
        asked(srv).await;
        assert_eq!(live, Regrant::Unchanged, "a live session keeps its camera");
        assert_eq!(state.sfu_rooms.get("sfu_7").unwrap().grants.get("u5#a"), Some(&token));
        // Join: the whole grant, camera removed.
        let (base, srv) = livekit_stand_in(
            vec![("/twirp/livekit.RoomService/UpdateParticipant", 200, info_reply(MIC_ONLY))],
            None,
        )
        .await;
        let join = regrant_if_stale(&state, &cfg_for(&base), "sfu_7", "u5#a", now_perms, GrantAt::Join).await;
        let seen = asked(srv).await;
        assert_eq!(join, Regrant::Applied);
        assert_eq!(serde_json::from_str::<serde_json::Value>(&seen[0].body).unwrap(), mic_only_request("sfu_7", "u5#a"));
        assert_eq!(state.sfu_rooms.get("sfu_7").unwrap().grants.get("u5#a"), Some(&Grant::of(P::SPEAK)));
        // And a token that already matches costs no call at a join either.
        let (base, srv) = livekit_stand_in(vec![], None).await;
        let again = regrant_if_stale(&state, &cfg_for(&base), "sfu_7", "u5#a", now_perms, GrantAt::Join).await;
        asked(srv).await;
        assert_eq!(again, Regrant::Unchanged);
    }

    #[test]
    fn the_grant_request_keeps_listening_and_data_and_names_sources_as_livekit_enums() {
        use crate::permissions::Permissions as P;
        // A SPEAK revoke for a member who keeps VIDEO: the microphone goes, the
        // camera stays, and listening and the data lane are said out loud - an
        // omitted proto3 bool is FALSE to LiveKit, and UpdateParticipant
        // replaces the whole grant.
        assert_eq!(
            permission_json(Grant::of(P::VIEW_CHANNEL | P::CONNECT | P::VIDEO)),
            serde_json::json!({"can_subscribe": true, "can_publish": true, "can_publish_data": true, "can_publish_sources": ["CAMERA"]})
        );
        // The grant back, the microphone by its enum NAME: the lowercase grant
        // spelling would be discarded as unknown, leaving an empty list, and
        // can_publish with an empty list is every source.
        assert_eq!(
            permission_json(Grant::of(P::SPEAK | P::VIDEO)),
            serde_json::json!({"can_subscribe": true, "can_publish": true, "can_publish_data": true, "can_publish_sources": ["MICROPHONE", "CAMERA"]})
        );
        // No publish bits at all: can_publish false says it.
        assert_eq!(
            permission_json(Grant::of(P::VIEW_CHANNEL | P::CONNECT)),
            serde_json::json!({"can_subscribe": true, "can_publish": false, "can_publish_data": true, "can_publish_sources": []})
        );
        assert_eq!(
            permission_json(Grant::of(P::ADMINISTRATOR))["can_publish_sources"],
            serde_json::json!(["MICROPHONE", "CAMERA", "SCREEN_SHARE", "SCREEN_SHARE_AUDIO"])
        );
        // The join token's order, so LiveKit's MatchesPermission (an ordered
        // comparison) sees an unchanged grant as unchanged.
        for perms in [P::SPEAK, P::SPEAK | P::STREAM, P::ADMINISTRATOR, P::VIDEO | P::STREAM] {
            let names: Vec<String> = permission_json(Grant::of(perms))["can_publish_sources"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap().to_ascii_lowercase())
                .collect();
            assert_eq!(names, publish_sources(perms).1, "{perms:?}");
        }
    }

    #[test]
    fn a_permission_reads_the_same_in_both_of_livekits_json_shapes() {
        use crate::permissions::Permissions as P;
        let read = |s: &str| Grant::from_permission(Some(&serde_json::from_str::<serde_json::Value>(s).unwrap()));
        // ListParticipants / UpdateParticipant: proto names, every field.
        assert_eq!(read(CAMERA_ONLY), Some(Grant::of(P::VIDEO)));
        assert_eq!(read(MIC_AND_CAMERA), Some(Grant::of(P::SPEAK | P::VIDEO)));
        // The webhook: camelCase, false and empty OMITTED.
        assert_eq!(
            read(r#"{"canSubscribe":true,"canPublish":true,"canPublishData":true,"canPublishSources":["CAMERA"]}"#),
            Some(Grant::of(P::VIDEO))
        );
        assert_eq!(read(r#"{"canSubscribe":true,"canPublishData":true}"#), Some(Grant::of(P::empty())), "an omitted canPublish is false");
        // Enum numbers: MICROPHONE = 2, CAMERA = 1.
        assert_eq!(
            read(r#"{"canSubscribe":true,"canPublish":true,"canPublishData":true,"canPublishSources":[2,1]}"#),
            Some(Grant::of(P::SPEAK | P::VIDEO))
        );
        // can_publish with no list is EVERY source, as LiveKit enforces it.
        assert_eq!(
            read(r#"{"can_subscribe":true,"can_publish":true,"can_publish_data":true,"can_publish_sources":[]}"#),
            Some(Grant::of(P::ADMINISTRATOR))
        );
        // A list naming only something else allows none of ours; it is not an
        // empty list.
        assert_eq!(
            read(r#"{"can_subscribe":true,"can_publish":true,"can_publish_data":true,"can_publish_sources":["UNKNOWN"]}"#),
            Some(Grant::of(P::empty()))
        );
        // Listening and data are part of the grant: one that lost either differs.
        assert_ne!(
            read(r#"{"can_subscribe":false,"can_publish":true,"can_publish_data":true,"can_publish_sources":["CAMERA"]}"#),
            Some(Grant::of(P::VIDEO))
        );
        // Nothing to read is unknown, never "no grant".
        assert_eq!(Grant::from_permission(None), None);
        assert_eq!(Grant::from_permission(Some(&serde_json::json!("x"))), None);
        // What this server sends reads back as what it meant.
        for perms in [P::empty(), P::SPEAK, P::VIDEO, P::SPEAK | P::VIDEO | P::STREAM, P::ADMINISTRATOR] {
            assert_eq!(Grant::from_permission(Some(&permission_json(Grant::of(perms)))), Some(Grant::of(perms)), "{perms:?}");
        }
    }

    #[test]
    fn the_listing_reports_each_active_sessions_grant() {
        use crate::permissions::Permissions as P;
        let body = format!(
            r#"{{"participants":[
            {{"identity":"u5#aa","state":"ACTIVE","tracks":[],"permission":{CAMERA_ONLY}}},
            {{"identity":"u6#bb","state":"JOINING","tracks":[],"permission":{CAMERA_ONLY}}},
            {{"identity":"u7#cc","state":"ACTIVE","tracks":[]}}]}}"#
        );
        let g = parse_listed_grants(&body);
        assert_eq!(g.get("u5#aa"), Some(&Grant::of(P::VIDEO)));
        assert_eq!(g.len(), 1, "a JOINING session is not taken, and one without a permission has no grant to report");
    }

    /// The sweep's call: one UpdateParticipant per joined session of the user
    /// whose known grant is not the one their permissions give - and none for
    /// a session that already holds it, another user's, or a reservation.
    /// Only SPEAK is enforced on a LIVE session: the microphone moves, camera
    /// and screen keep what the session joined with (VIDEO and STREAM are
    /// checked when a camera or share starts, on both transports).
    #[test]
    fn the_live_target_moves_only_the_microphone() {
        use crate::permissions::Permissions as P;
        let all = Grant::of(P::SPEAK | P::VIDEO | P::STREAM);
        assert_eq!(Grant::target(Some(all), P::VIDEO | P::STREAM), Grant::of(P::VIDEO | P::STREAM), "SPEAK revoked: mic off, the rest kept");
        assert_eq!(Grant::target(Some(all), P::SPEAK), all, "VIDEO and STREAM revoked: a live session keeps its camera and share");
        assert_eq!(Grant::target(Some(Grant::of(P::VIDEO)), P::SPEAK), Grant::of(P::SPEAK | P::VIDEO), "SPEAK granted: mic on, camera kept");
        assert_eq!(Grant::target(Some(Grant::of(P::empty())), P::SPEAK | P::VIDEO), Grant::of(P::SPEAK), "a new VIDEO allow waits for the next join");
        assert_eq!(Grant::target(None, P::SPEAK | P::VIDEO), Grant::of(P::SPEAK | P::VIDEO), "unknown held grant: the whole grant");
    }

    /// The sweep never takes a running camera off a live session: a VIDEO
    /// revoke alone sends nothing, and a revoke of both only drops the mic.
    #[tokio::test]
    async fn a_live_session_loses_only_its_microphone() {
        use crate::permissions::Permissions as P;
        no_env_proxy();
        let state = test_state();
        {
            let now = Instant::now();
            let mut u = usage(&[("u5#a", now)], &[], &[]);
            u.grants.insert("u5#a".into(), Grant::of(P::SPEAK | P::VIDEO)); // joined with mic and camera
            state.sfu_rooms.insert("sfu_7".into(), u);
        }
        // VIDEO revoked, SPEAK kept: nothing sent (the stand-in fails on any call).
        let (base, srv) = livekit_stand_in(vec![], None).await;
        let out = regrant_user_with(&state, &cfg_for(&base), 7, 5, P::VIEW_CHANNEL | P::CONNECT | P::SPEAK).await;
        asked(srv).await;
        assert_eq!(out, Regranted { tried: 0, applied: 0, unchanged: 1, resync_retries: false });
        // SPEAK and VIDEO revoked together: the request keeps the camera.
        let (base, srv) = livekit_stand_in(
            vec![("/twirp/livekit.RoomService/UpdateParticipant", 200, info_reply(CAMERA_ONLY))],
            None,
        )
        .await;
        let out = regrant_user_with(&state, &cfg_for(&base), 7, 5, P::VIEW_CHANNEL | P::CONNECT).await;
        let seen = asked(srv).await;
        assert_eq!(out, Regranted { tried: 1, applied: 1, unchanged: 0, resync_retries: false });
        let body: serde_json::Value = serde_json::from_str(&seen[0].body).unwrap();
        assert_eq!(body, camera_only_request("sfu_7", "u5#a"));
    }

    #[tokio::test]
    async fn a_grant_is_sent_to_each_session_whose_known_grant_differs_and_to_no_other() {
        use crate::permissions::Permissions as P;
        no_env_proxy();
        let state = test_state();
        {
            let now = Instant::now();
            let mut u = usage(&[("u5#a", now), ("u5#b", now), ("u6#c", now)], &["u5#r"], &[]);
            u.grants.insert("u5#a".into(), Grant::of(P::SPEAK | P::VIDEO)); // joined while SPEAK was allowed
            u.grants.insert("u5#b".into(), Grant::of(P::VIDEO)); // already what the revoke gives
            u.grants.insert("u6#c".into(), Grant::of(P::SPEAK | P::VIDEO)); // another user
            state.sfu_rooms.insert("sfu_7".into(), u);
        }
        // The revoke: exactly one call, for u5#a.
        let (base, srv) = livekit_stand_in(
            vec![("/twirp/livekit.RoomService/UpdateParticipant", 200, info_reply(CAMERA_ONLY))],
            None,
        )
        .await;
        let out = regrant_user_with(&state, &cfg_for(&base), 7, 5, P::VIEW_CHANNEL | P::CONNECT | P::VIDEO).await;
        let seen = asked(srv).await;
        assert_eq!(out, Regranted { tried: 1, applied: 1, unchanged: 1, resync_retries: false });
        let body: serde_json::Value = serde_json::from_str(&seen[0].body).unwrap();
        assert_eq!(body, camera_only_request("sfu_7", "u5#a"));
        assert_eq!(seen[0].claims["video"]["roomAdmin"], true, "UpdateParticipant needs room admin");
        assert_eq!(seen[0].claims["video"]["room"], "sfu_7");
        assert_eq!(seen[0].ua, "puca-server");
        {
            let u = state.sfu_rooms.get("sfu_7").unwrap();
            assert_eq!(u.grants.get("u5#a"), Some(&Grant::of(P::VIDEO)), "confirmed, so known");
            assert_eq!(u.grants.get("u6#c"), Some(&Grant::of(P::SPEAK | P::VIDEO)), "another user's session is untouched");
            assert!(u.recheck.is_empty(), "nothing owed");
        }
        // Nothing changed since: nothing is sent (the stand-in fails on any call).
        let (base, srv) = livekit_stand_in(vec![], None).await;
        let again = regrant_user_with(&state, &cfg_for(&base), 7, 5, P::VIEW_CHANNEL | P::CONNECT | P::VIDEO).await;
        asked(srv).await;
        assert_eq!(again, Regranted { tried: 0, applied: 0, unchanged: 2, resync_retries: false });
        // The grant back reaches both joined sessions, and only them.
        let (base, srv) = livekit_stand_in(
            vec![
                ("/twirp/livekit.RoomService/UpdateParticipant", 200, info_reply(MIC_AND_CAMERA)),
                ("/twirp/livekit.RoomService/UpdateParticipant", 200, info_reply(MIC_AND_CAMERA)),
            ],
            None,
        )
        .await;
        let back = regrant_user_with(&state, &cfg_for(&base), 7, 5, P::VIEW_CHANNEL | P::CONNECT | P::SPEAK | P::VIDEO).await;
        let seen = asked(srv).await;
        assert_eq!(back, Regranted { tried: 2, applied: 2, unchanged: 0, resync_retries: false });
        let mut who = Vec::new();
        for s in &seen {
            let b: serde_json::Value = serde_json::from_str(&s.body).unwrap();
            assert_eq!(
                b["permission"],
                serde_json::json!({"can_subscribe": true, "can_publish": true, "can_publish_data": true, "can_publish_sources": ["MICROPHONE", "CAMERA"]})
            );
            who.push(b["identity"].as_str().unwrap().to_string());
        }
        who.sort();
        assert_eq!(who, vec!["u5#a".to_string(), "u5#b".to_string()], "joined sessions only: a reservation has no session to update");
    }

    /// Not confirmed is not held: refused, answered with the OLD grant (what
    /// LiveKit shows when it did not read a field), or answered with something
    /// that is not LiveKit's answer. Each is owed a LIVE-grant retry by the
    /// resync (no pass counted yet: see `owe`), and its grant stays
    /// unconfirmed, so the next sweep sends it again.
    #[tokio::test]
    async fn a_grant_livekit_does_not_confirm_is_marked_and_not_taken_as_held() {
        use crate::permissions::Permissions as P;
        no_env_proxy();
        let state = test_state();
        {
            let now = Instant::now();
            let mut u = usage(&[("u5#a", now), ("u5#b", now), ("u5#c", now)], &[], &[]);
            for id in ["u5#a", "u5#b", "u5#c"] {
                u.grants.insert(id.into(), Grant::of(P::SPEAK | P::VIDEO));
            }
            state.sfu_rooms.insert("sfu_7".into(), u);
        }
        let (base, srv) = livekit_stand_in(
            vec![
                ("/twirp/livekit.RoomService/UpdateParticipant", 503, r#"{"code":"unavailable","msg":"starting"}"#.to_string()),
                ("/twirp/livekit.RoomService/UpdateParticipant", 200, info_reply(MIC_AND_CAMERA)),
                ("/twirp/livekit.RoomService/UpdateParticipant", 200, "<html>ok</html>".to_string()),
            ],
            None,
        )
        .await;
        let out = regrant_user_with(&state, &cfg_for(&base), 7, 5, P::VIEW_CHANNEL | P::CONNECT | P::VIDEO).await;
        asked(srv).await;
        assert_eq!(out, Regranted { tried: 3, applied: 0, unchanged: 0, resync_retries: false });
        let u = state.sfu_rooms.get("sfu_7").unwrap();
        for id in ["u5#a", "u5#b", "u5#c"] {
            assert_eq!(u.grants.get(id), Some(&Grant::of(P::SPEAK | P::VIDEO)), "{id}: not confirmed, so not recorded as held");
            assert_eq!(u.recheck.get(id), Some(&Mark { what: Recheck::LiveGrant, passes: 0 }), "{id}: the resync applies the live grant again");
        }
    }

    /// A confirmed grant is recorded for the session it was sent to, only. If
    /// the identity joined again while the call was in flight (its token used
    /// again), LiveKit applied the update to the NEW session - it updates an
    /// identity's current session - which that join's payload did not show.
    /// Its grant is then UNKNOWN, not the payload's: the join check sends the
    /// whole grant. Here the payload (the token's grant: no publishing, VIDEO
    /// and SPEAK denied when it was minted) equals what the permissions give
    /// now, so trusting it found nothing to change and left the session the
    /// camera the sweep's live grant had kept for the OLD session.
    #[tokio::test]
    async fn an_update_that_lands_on_a_rejoined_session_leaves_its_grant_unknown() {
        use crate::permissions::Permissions as P;
        no_env_proxy();
        let state = test_state();
        {
            let mut u = usage(&[("u5#a", Instant::now())], &[], &[]);
            u.grants.insert("u5#a".into(), Grant::of(P::SPEAK | P::VIDEO));
            state.sfu_rooms.insert("sfu_7".into(), u);
        }
        let during = Arc::clone(&state);
        let (base, srv) = livekit_stand_in(
            vec![("/twirp/livekit.RoomService/UpdateParticipant", 200, info_reply(CAMERA_ONLY))],
            Some(Box::new(move |m: &str| {
                if m == "UpdateParticipant" {
                    std::thread::sleep(Duration::from_millis(2)); // a later join time
                    apply_webhook_event(
                        &during,
                        "participant_joined",
                        "sfu_7".into(),
                        &serde_json::json!({"participant": {"identity": "u5#a", "permission": {
                            "canSubscribe": true, "canPublishData": true}}}),
                    );
                }
            })),
        )
        .await;
        let now_perms = P::VIEW_CHANNEL | P::CONNECT;
        let out = regrant_user_with(&state, &cfg_for(&base), 7, 5, now_perms).await;
        asked(srv).await;
        assert_eq!(out, Regranted { tried: 1, applied: 1, unchanged: 0, resync_retries: false }, "LiveKit confirmed it, for the session it reached");
        assert_eq!(state.sfu_rooms.get("sfu_7").unwrap().grants.get("u5#a"), None, "unknown: the payload is older than the update");
        // The new join's check: the whole grant is sent, taking the camera.
        let (base, srv) = livekit_stand_in(
            vec![("/twirp/livekit.RoomService/UpdateParticipant", 200, info_reply(NO_PUBLISH))],
            None,
        )
        .await;
        let join = regrant_if_stale(&state, &cfg_for(&base), "sfu_7", "u5#a", now_perms, GrantAt::Join).await;
        asked(srv).await;
        assert_eq!(join, Regrant::Applied);
    }

    /// A join's grant is its TOKEN's: the webhook's report replaces whatever
    /// was applied to an earlier session of the same identity, a join that
    /// reports none leaves it unknown, and a leave forgets it.
    #[tokio::test]
    async fn a_join_records_the_grant_its_token_carries_and_forgets_one_it_cannot_read() {
        use crate::permissions::Permissions as P;
        let state = test_state();
        {
            let mut u = usage(&[("u5#a", Instant::now())], &[], &[]);
            u.grants.insert("u5#a".into(), Grant::of(P::VIDEO)); // applied to an earlier session
            state.sfu_rooms.insert("sfu_7".into(), u);
        }
        let grant_of = || state.sfu_rooms.get("sfu_7").and_then(|u| u.grants.get("u5#a").copied());
        apply_webhook_event(
            &state,
            "participant_joined",
            "sfu_7".into(),
            &serde_json::json!({"participant": {"identity": "u5#a", "permission": {
                "canSubscribe": true, "canPublish": true, "canPublishData": true, "canPublishSources": ["MICROPHONE", "CAMERA"]}}}),
        );
        assert_eq!(grant_of(), Some(Grant::of(P::SPEAK | P::VIDEO)), "the token's grant, not the one applied before");
        apply_webhook_event(&state, "participant_joined", "sfu_7".into(), &serde_json::json!({"participant": {"identity": "u5#a"}}));
        assert_eq!(grant_of(), None, "no permission reported: unknown, so its check applies the grant");
        state.sfu_rooms.get_mut("sfu_7").unwrap().grants.insert("u5#a".into(), Grant::of(P::VIDEO));
        apply_webhook_event(&state, "participant_left", "sfu_7".into(), &serde_json::json!({"participant": {"identity": "u5#a"}}));
        assert_eq!(grant_of(), None, "a leave forgets it");
    }

    /// The resync's merge takes LiveKit's word for each listed grant, and a
    /// KNOWN session whose grant is not the one this process held (a token
    /// used again with its webhook lost) is due a join check. A listed
    /// reservation is handed back as moved, for the join check as well.
    #[test]
    fn a_known_session_whose_listed_grant_changed_is_due_a_join_check() {
        use crate::permissions::Permissions as P;
        let rooms = DashMap::new();
        let before = Instant::now();
        let mut u = usage(
            &[("u5#drift", before), ("u6#same", before), ("u7#unknown", before), ("u8#rejoined", before), ("u9#marked", before)],
            &["u4#minted"],
            &[],
        );
        u.grants.insert("u5#drift".into(), Grant::of(P::VIDEO));
        u.grants.insert("u6#same".into(), Grant::of(P::SPEAK));
        u.grants.insert("u8#rejoined".into(), Grant::of(P::SPEAK | P::VIDEO));
        u.grants.insert("u9#marked".into(), Grant::of(P::VIDEO));
        u.recheck.insert("u9#marked".into(), Mark { what: Recheck::Cut, passes: 1 });
        rooms.insert("sfu_7".to_string(), u);
        std::thread::sleep(Duration::from_millis(5));
        let started = Instant::now();
        let mut journal = SfuResyncJournal::default();
        // Joined again DURING the fetch: its webhook's grant is newer than the listing.
        journal.record(JournalEntry::Joined("sfu_7", "u8#rejoined"));
        let mut snap = listed(
            "sfu_7",
            &["u5#drift", "u6#same", "u7#unknown", "u8#rejoined", "u9#marked", "u4#minted", "u3#new"],
            &[],
        );
        for (id, g) in [
            ("u5#drift", P::SPEAK | P::VIDEO),
            ("u6#same", P::SPEAK),
            ("u7#unknown", P::SPEAK),
            ("u8#rejoined", P::VIDEO),
            ("u9#marked", P::SPEAK),
            ("u4#minted", P::SPEAK),
            ("u3#new", P::SPEAK),
        ] {
            snap.grants.insert(id.into(), Grant::of(g));
        }
        let names: HashSet<String> = ["sfu_7".to_string()].into_iter().collect();
        let m = merge_snapshot(&rooms, &[snap], &names, &journal, started, Instant::now());
        let mut due: Vec<(String, Recheck)> = m.due.iter().map(|(_, id, w)| (id.clone(), *w)).collect();
        due.sort_by(|a, b| a.0.cmp(&b.0));
        assert_eq!(
            due,
            vec![("u5#drift".to_string(), Recheck::JoinCheck), ("u9#marked".to_string(), Recheck::Cut)],
            "the drifted one, and the marked one once, for its own mark"
        );
        assert_eq!(m.added, vec![("sfu_7".to_string(), "u3#new".to_string())], "a new one gets the join check as added");
        assert_eq!(
            m.moved,
            vec![("sfu_7".to_string(), "u4#minted".to_string())],
            "a moved reservation gets the join check too: its webhook may have been lost - but it is not drift, and not `added`"
        );
        let u = rooms.get("sfu_7").unwrap();
        assert_eq!(u.grants.get("u5#drift"), Some(&Grant::of(P::SPEAK | P::VIDEO)), "LiveKit's word, until the check re-applies");
        assert_eq!(u.grants.get("u7#unknown"), Some(&Grant::of(P::SPEAK)), "learned; nothing to differ from");
        assert_eq!(u.grants.get("u8#rejoined"), Some(&Grant::of(P::SPEAK | P::VIDEO)), "not overwritten by the older listing");
        assert_eq!(u.grants.get("u4#minted"), Some(&Grant::of(P::SPEAK)), "a moved reservation: LiveKit's word, which its join check compares");
        assert_eq!(u.grants.get("u3#new"), Some(&Grant::of(P::SPEAK)));
    }

    /// A server with an SFU voice channel whose @everyone may VIEW, CONNECT,
    /// SPEAK and use VIDEO; `muted` holds a role the channel denies SPEAK,
    /// `camless` one it denies VIDEO, `speaker` neither, and `outsider` is no
    /// member at all.
    struct SpeakFixture {
        sid: String,
        cid: i64,
        muted: i64,
        speaker: i64,
        outsider: i64,
        camless: i64,
        users: Vec<i32>,
    }

    async fn speak_fixture(pool: &sqlx::PgPool) -> SpeakFixture {
        use crate::permissions::Permissions as P;
        let tag = uuid::Uuid::new_v4().simple().to_string();
        let mk = |n: &str| format!("gr_{n}_{}", &tag[..12]);
        let mut users = Vec::new();
        for n in ["owner", "muted", "speaker", "outsider", "camless"] {
            let (id,): (i32,) = sqlx::query_as("INSERT INTO users (username, email, salt, verifier, created_at) VALUES ($1, $2, $3, $4, NOW()) RETURNING id")
                .bind(mk(n)).bind(format!("{}@test.invalid", mk(n))).bind(b"s".as_ref()).bind(b"v".as_ref())
                .fetch_one(pool).await.expect("user");
            users.push(id);
        }
        let sid = uuid::Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO servers (id, name, owner_id) VALUES ($1, $2, $3)").bind(&sid).bind(mk("srv")).bind(users[0]).execute(pool).await.expect("server");
        sqlx::query("INSERT INTO server_members (server_id, user_id) VALUES ($1, $2), ($1, $3), ($1, $4), ($1, $5)")
            .bind(&sid).bind(users[0]).bind(users[1]).bind(users[2]).bind(users[4]).execute(pool).await.expect("members");
        let everyone = (P::VIEW_CHANNEL | P::CONNECT | P::SPEAK | P::VIDEO).bits() as i64;
        sqlx::query("INSERT INTO server_roles (server_id, name, color, permissions, position, is_default) VALUES ($1, '@everyone', '#99AAB5', $2, 0, true)")
            .bind(&sid).bind(everyone).execute(pool).await.expect("@everyone");
        let (cid,): (i32,) = sqlx::query_as("INSERT INTO channels (server_id, name, type, sfu_mode) VALUES ($1, 'v', 1, true) RETURNING id")
            .bind(&sid).fetch_one(pool).await.expect("channel");
        for (name, holder, denied) in [("muted", users[1], P::SPEAK), ("camless", users[4], P::VIDEO)] {
            let (rid,): (i64,) = sqlx::query_as("INSERT INTO server_roles (server_id, name, color, permissions, position, is_default) VALUES ($1, $2, '#99AAB5', 0, 1, false) RETURNING id")
                .bind(&sid).bind(name).fetch_one(pool).await.expect("role");
            sqlx::query("INSERT INTO member_roles (server_id, user_id, role_id) VALUES ($1, $2, $3)").bind(&sid).bind(holder).bind(rid).execute(pool).await.expect("member role");
            sqlx::query("INSERT INTO channel_permission_overwrites (channel_id, role_id, allow, deny) VALUES ($1, $2, 0, $3)")
                .bind(cid as i64).bind(rid).bind(denied.bits() as i64).execute(pool).await.expect("deny");
        }
        SpeakFixture {
            sid,
            cid: cid as i64,
            muted: users[1] as i64,
            speaker: users[2] as i64,
            outsider: users[3] as i64,
            camless: users[4] as i64,
            users,
        }
    }

    async fn drop_fixture(pool: &sqlx::PgPool, f: &SpeakFixture) {
        let _ = sqlx::query("DELETE FROM channels WHERE id = $1").bind(f.cid as i32).execute(pool).await;
        let _ = sqlx::query("DELETE FROM servers WHERE id = $1").bind(&f.sid).execute(pool).await;
        let _ = sqlx::query("DELETE FROM users WHERE id = ANY($1)").bind(f.users.clone()).execute(pool).await;
    }

    /// A STOCKPILED TOKEN, through the resync (TEST_DATABASE_URL; skips without
    /// it). LiveKit lists a session of the SPEAK-denied member that joined with
    /// a token minted before the deny (its grant names the microphone); the
    /// join check keeps them - they may still VIEW and CONNECT - and gives the
    /// session the grant they have now. So does a KNOWN session whose grant
    /// drifted back to the token's. The speaker's session, whose grant is
    /// current, is sent nothing.
    #[tokio::test]
    async fn the_resyncs_join_check_gives_a_session_the_grant_its_members_permissions_give_now() {
        use crate::permissions::Permissions as P;
        let Some(pool) = crate::migrator::test_pool(2).await else { return };
        no_env_proxy();
        let f = speak_fixture(&pool).await;
        let state = AppState::new(pool.clone(), "test-secret".into(), None, Arc::new(crate::wake::NullWake));
        let room = room_name_for_channel(f.cid);
        let (stock, fine, known) = (format!("u{}#stock", f.muted), format!("u{}#fine", f.speaker), format!("u{}#known", f.muted));
        // Listed with no permission at all: its grant is unknown, so it is given one.
        let bare = format!("u{}#bare", f.speaker);
        {
            // Applied by an earlier sweep; the listing below says otherwise.
            let mut u = state.sfu_rooms.entry(room.clone()).or_default();
            u.participants.insert(known.clone(), Instant::now());
            u.grants.insert(known.clone(), Grant::of(P::VIDEO));
        }
        let (base, srv) = livekit_stand_in(
            vec![
                ("/twirp/livekit.RoomService/ListRooms", 200, format!(r#"{{"rooms":[{{"name":"{room}"}}]}}"#)),
                ("/twirp/livekit.RoomService/ListParticipants", 200, format!(
                    r#"{{"participants":[
                    {{"identity":"{stock}","state":"ACTIVE","tracks":[],"permission":{MIC_AND_CAMERA}}},
                    {{"identity":"{fine}","state":"ACTIVE","tracks":[],"permission":{MIC_AND_CAMERA}}},
                    {{"identity":"{known}","state":"ACTIVE","tracks":[],"permission":{MIC_AND_CAMERA}}},
                    {{"identity":"{bare}","state":"ACTIVE","tracks":[]}}]}}"#
                )),
                // In check order: the due (drifted) one, then the added ones as listed.
                ("/twirp/livekit.RoomService/UpdateParticipant", 200, info_reply(CAMERA_ONLY)),
                ("/twirp/livekit.RoomService/UpdateParticipant", 200, info_reply(CAMERA_ONLY)),
                ("/twirp/livekit.RoomService/UpdateParticipant", 200, info_reply(MIC_AND_CAMERA)),
            ],
            None,
        )
        .await;
        let r = resync_once(&state, &cfg_for(&base), &client()).await;
        let seen = asked(srv).await;
        let grants: Vec<Option<Grant>> = [&stock, &fine, &known, &bare]
            .iter()
            .map(|id| state.sfu_rooms.get(&room).and_then(|u| u.grants.get(*id).copied()))
            .collect();
        let still_in = state.sfu_rooms.get(&room).map(|u| u.participants.len()).unwrap_or(0);
        drop_fixture(&pool, &f).await;

        let r = r.expect("resync");
        let mut bodies: Vec<serde_json::Value> = seen[2..].iter().map(|s| serde_json::from_str(&s.body).unwrap()).collect();
        bodies.sort_by(|a, b| a["identity"].as_str().cmp(&b["identity"].as_str()));
        let mut bare_request = camera_only_request(&room, &bare);
        bare_request["permission"]["can_publish_sources"] = serde_json::json!(["MICROPHONE", "CAMERA"]);
        let mut want = vec![camera_only_request(&room, &known), camera_only_request(&room, &stock), bare_request];
        want.sort_by(|a, b| a["identity"].as_str().cmp(&b["identity"].as_str()));
        assert_eq!(bodies, want, "the stockpiled token's session, the drifted one and the unreported one; never the speaker's current one");
        assert_eq!((r.regranted, r.denied, r.pending, r.added), (3, 0, 0, 3));
        assert_eq!(
            grants,
            vec![Some(Grant::of(P::VIDEO)), Some(Grant::of(P::SPEAK | P::VIDEO)), Some(Grant::of(P::VIDEO)), Some(Grant::of(P::SPEAK | P::VIDEO))]
        );
        assert_eq!(still_in, 4, "a SPEAK deny evicts nobody: they stay, listening");
    }

    /// A RESERVATION LiveKit already lists as joined, through the resync
    /// (TEST_DATABASE_URL; skips without it) - the case where its
    /// `participant_joined` was lost, so nothing else would ever check it. It
    /// gets the join check an added session gets: the SPEAK-denied member's
    /// token (minted before the deny, naming the microphone) is given the grant
    /// they have now; the VIDEO-denied member's the WHOLE grant, camera
    /// removed; a member no longer in the server is removed. The speaker,
    /// whose token is current, is sent nothing and stays: the check evicts
    /// nobody who is entitled.
    #[tokio::test]
    async fn a_reservation_the_resync_finds_joined_gets_the_join_check() {
        use crate::permissions::Permissions as P;
        let Some(pool) = crate::migrator::test_pool(2).await else { return };
        no_env_proxy();
        let f = speak_fixture(&pool).await;
        let state = AppState::new(pool.clone(), "test-secret".into(), None, Arc::new(crate::wake::NullWake));
        let room = room_name_for_channel(f.cid);
        let ids = [
            format!("u{}#r1", f.muted),
            format!("u{}#r2", f.speaker),
            format!("u{}#r3", f.camless),
            format!("u{}#r4", f.outsider),
        ];
        let [muted, fine, camless, stranger] = &ids;
        {
            // Minted here, never seen joining: the webhook was lost.
            let mut u = state.sfu_rooms.entry(room.clone()).or_default();
            for id in &ids {
                u.reservations.insert(id.clone(), Instant::now());
            }
        }
        let listing = ids
            .iter()
            .map(|id| format!(r#"{{"identity":"{id}","state":"ACTIVE","tracks":[],"permission":{MIC_AND_CAMERA}}}"#))
            .collect::<Vec<_>>()
            .join(",");
        let (base, srv) = livekit_stand_in(
            vec![
                ("/twirp/livekit.RoomService/ListRooms", 200, format!(r#"{{"rooms":[{{"name":"{room}"}}]}}"#)),
                ("/twirp/livekit.RoomService/ListParticipants", 200, format!(r#"{{"participants":[{listing}]}}"#)),
                // In listing order; the refused one is removed after the checks.
                ("/twirp/livekit.RoomService/UpdateParticipant", 200, info_reply(CAMERA_ONLY)),
                ("/twirp/livekit.RoomService/UpdateParticipant", 200, info_reply(MIC_ONLY)),
                ("/twirp/livekit.RoomService/RemoveParticipant", 200, "{}".to_string()),
            ],
            None,
        )
        .await;
        let r = resync_once(&state, &cfg_for(&base), &client()).await;
        let seen = asked(srv).await;
        let (still_in, reserved, grants) = {
            let u = state.sfu_rooms.get(&room).expect("room");
            let still_in: Vec<bool> = ids.iter().map(|id| u.participants.contains_key(id)).collect();
            let grants: Vec<Option<Grant>> = ids.iter().map(|id| u.grants.get(id).copied()).collect();
            (still_in, u.reservations.len(), grants)
        };
        drop_fixture(&pool, &f).await;

        let r = r.expect("resync");
        let bodies: Vec<serde_json::Value> = seen[2..].iter().map(|s| serde_json::from_str(&s.body).unwrap()).collect();
        assert_eq!(
            bodies,
            vec![
                camera_only_request(&room, muted),
                mic_only_request(&room, camless),
                serde_json::json!({ "room": room, "identity": stranger }),
            ],
            "the stale microphone, the stale camera, the non-member - never the speaker's current grant ({fine})"
        );
        assert_eq!((r.moved, r.added, r.regranted, r.denied, r.pending), (4, 0, 2, 1, 0), "moved, not drift - and checked");
        assert_eq!(still_in, vec![true, true, true, false], "an entitled member stays; only the non-member goes");
        assert_eq!(reserved, 0, "every listed reservation moved");
        assert_eq!(
            grants[..3],
            [Some(Grant::of(P::VIDEO)), Some(Grant::of(P::SPEAK | P::VIDEO)), Some(Grant::of(P::SPEAK))],
            "each holds what its member's permissions give now"
        );
    }

    /// The join check is SERIALIZED with the perms-change sweep
    /// (TEST_DATABASE_URL; skips without it). A sweep for the server holds its
    /// lock - here, the test does - when the speaker's join arrives, its token
    /// naming the microphone, which is still right. While the check waits, the
    /// change that sweep is acting on lands: @everyone loses SPEAK. The check
    /// must act on the permissions as they are once the sweep is done - take
    /// the microphone away - not on the answer it read on arrival, which would
    /// have found nothing to change and left LiveKit granting a microphone the
    /// database denies.
    #[tokio::test]
    async fn the_join_check_waits_for_a_running_sweep_and_acts_on_what_it_left() {
        use crate::permissions::Permissions as P;
        use std::sync::atomic::AtomicBool;
        let Some(pool) = crate::migrator::test_pool(4).await else { return };
        no_env_proxy();
        let f = speak_fixture(&pool).await;
        let state = AppState::new(pool.clone(), "test-secret".into(), None, Arc::new(crate::wake::NullWake));
        let room = room_name_for_channel(f.cid);
        let id = format!("u{}#j", f.speaker);
        apply_webhook_event(
            &state,
            "participant_joined",
            room.clone(),
            &serde_json::json!({"participant": {"identity": id, "permission": {
                "canSubscribe": true, "canPublish": true, "canPublishData": true, "canPublishSources": ["MICROPHONE", "CAMERA"]}}}),
        );
        let (base, srv) = livekit_stand_in(
            vec![("/twirp/livekit.RoomService/UpdateParticipant", 200, info_reply(CAMERA_ONLY))],
            None,
        )
        .await;
        let cfg = cfg_for(&base);
        let sweep = state.lock_server_perms(&f.sid).await; // a sweep for this server, running
        let check_done = AtomicBool::new(false);
        let check = async {
            reauth_join(&state, &cfg, &room, &id, f.cid, f.speaker).await;
            check_done.store(true, Ordering::SeqCst);
        };
        let the_sweep = async {
            // Until the check is queued behind the sweep (the map's clone, the
            // sweep's, the check's) - or, were it not serialized, done.
            let deadline = Instant::now() + Duration::from_secs(10);
            while !check_done.load(Ordering::SeqCst)
                && state.server_perms_locks.get(&f.sid).map(|m| Arc::strong_count(&m)) != Some(3)
            {
                assert!(Instant::now() < deadline, "the join check neither queued nor finished");
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            sqlx::query("UPDATE server_roles SET permissions = $1 WHERE server_id = $2 AND is_default")
                .bind((P::VIEW_CHANNEL | P::CONNECT | P::VIDEO).bits() as i64)
                .bind(&f.sid)
                .execute(&pool)
                .await
                .expect("@everyone loses SPEAK");
            drop(sweep);
        };
        tokio::time::timeout(Duration::from_secs(30), async { tokio::join!(check, the_sweep) })
            .await
            .expect("the check finished");
        let held = state.sfu_rooms.get(&room).and_then(|u| u.grants.get(&id).copied());
        let in_call = state.sfu_rooms.get(&room).is_some_and(|u| u.participants.contains_key(&id));
        drop_fixture(&pool, &f).await;

        assert_eq!(held, Some(Grant::of(P::VIDEO)), "the answer after the sweep: no microphone");
        assert!(in_call, "a SPEAK change evicts nobody");
        let seen = asked(srv).await;
        assert_eq!(serde_json::from_str::<serde_json::Value>(&seen[0].body).unwrap(), camera_only_request(&room, &id));
    }

    /// A retried grant keeps its MOMENT (TEST_DATABASE_URL; skips without it).
    /// The VIDEO-denied member's session is live with the camera-only grant a
    /// SPEAK deny left it, and SPEAK is allowed again. Owed a LIVE grant (the
    /// sweep's re-grant of the microphone was not confirmed), the resync gives
    /// the microphone back and leaves the running camera alone - the sweep's
    /// own rule. Owed a JOIN-time check instead, it gets the whole grant the
    /// member has now: the camera goes.
    #[tokio::test]
    async fn a_retried_grant_keeps_its_moment_live_or_join() {
        use crate::permissions::Permissions as P;
        let Some(pool) = crate::migrator::test_pool(2).await else { return };
        no_env_proxy();
        let f = speak_fixture(&pool).await;
        let room = room_name_for_channel(f.cid);
        let id = format!("u{}#live", f.camless);
        let mut outcomes = Vec::new();
        for (what, reply) in [(Recheck::LiveGrant, MIC_AND_CAMERA), (Recheck::JoinCheck, MIC_ONLY)] {
            let state = AppState::new(pool.clone(), "test-secret".into(), None, Arc::new(crate::wake::NullWake));
            {
                let mut u = state.sfu_rooms.entry(room.clone()).or_default();
                u.participants.insert(id.clone(), Instant::now());
                u.grants.insert(id.clone(), Grant::of(P::VIDEO));
                u.recheck.insert(id.clone(), Mark { what, passes: 0 });
            }
            let (base, srv) = livekit_stand_in(
                vec![
                    ("/twirp/livekit.RoomService/ListRooms", 200, format!(r#"{{"rooms":[{{"name":"{room}"}}]}}"#)),
                    ("/twirp/livekit.RoomService/ListParticipants", 200,
                     format!(r#"{{"participants":[{{"identity":"{id}","state":"ACTIVE","tracks":[],"permission":{CAMERA_ONLY}}}]}}"#)),
                    ("/twirp/livekit.RoomService/UpdateParticipant", 200, info_reply(reply)),
                ],
                None,
            )
            .await;
            let r = resync_once(&state, &cfg_for(&base), &client()).await;
            let seen = asked(srv).await;
            let u = state.sfu_rooms.get(&room).expect("room");
            outcomes.push((
                r.map(|r| (r.regranted, r.pending)).map_err(|e| e.to_string()),
                seen.get(2).map(|s| serde_json::from_str::<serde_json::Value>(&s.body).unwrap()["permission"]["can_publish_sources"].clone()),
                u.grants.get(&id).copied(),
                u.participants.contains_key(&id),
            ));
        }
        drop_fixture(&pool, &f).await;

        assert_eq!(
            outcomes[0],
            (Ok((1, 0)), Some(serde_json::json!(["MICROPHONE", "CAMERA"])), Some(Grant::of(P::SPEAK | P::VIDEO)), true),
            "a retried LIVE grant: the microphone back, the running camera kept"
        );
        assert_eq!(
            outcomes[1],
            (Ok((1, 0)), Some(serde_json::json!(["MICROPHONE"])), Some(Grant::of(P::SPEAK)), true),
            "a retried JOIN check: the whole grant, camera removed"
        );
    }

    /// No publishing at all, as LiveKit reports it back.
    const NO_PUBLISH: &str = r#"{"can_subscribe":true,"can_publish":false,"can_publish_data":true,"can_publish_sources":[],"hidden":false,"recorder":false,"can_update_metadata":false,"agent":false,"can_subscribe_metrics":false,"can_manage_agent_session":false}"#;

    /// A grant LiveKit CONFIRMS while a resync's snapshot is in flight is
    /// journaled, so that resync's merge keeps it (see the merge test below).
    #[tokio::test]
    async fn a_grant_confirmed_during_a_resync_fetch_is_journaled() {
        use crate::permissions::Permissions as P;
        no_env_proxy();
        let state = test_state();
        {
            let mut u = usage(&[("u5#a", Instant::now())], &[], &[]);
            u.grants.insert("u5#a".into(), Grant::of(P::SPEAK | P::VIDEO));
            state.sfu_rooms.insert("sfu_7".into(), u);
        }
        *state.sfu_resync_journal.lock().unwrap() = Some(SfuResyncJournal::default());
        let (base, srv) = livekit_stand_in(
            vec![("/twirp/livekit.RoomService/UpdateParticipant", 200, info_reply(CAMERA_ONLY))],
            None,
        )
        .await;
        let out = regrant_user_with(&state, &cfg_for(&base), 7, 5, P::VIEW_CHANNEL | P::CONNECT | P::VIDEO).await;
        asked(srv).await;
        assert_eq!(out.applied, 1);
        let g = state.sfu_resync_journal.lock().unwrap();
        assert!(SfuResyncJournal::has(&g.as_ref().unwrap().grants, "sfu_7", "u5#a"), "journaled with the confirmation");
    }

    /// The merge keeps a grant this process changed during the fetch - a
    /// sweep's confirmed grant is newer than the listing - and does not call
    /// the difference drift (whose join check would pull a live camera).
    /// Positive control: the same difference with nothing journaled IS drift.
    #[test]
    fn a_grant_changed_during_the_fetch_is_kept_and_is_not_drift() {
        use crate::permissions::Permissions as P;
        let rooms = DashMap::new();
        let before = Instant::now();
        let mut u = usage(&[("u5#swept", before), ("u6#drift", before)], &[], &[]);
        u.grants.insert("u5#swept".into(), Grant::of(P::VIDEO)); // the sweep's confirmed grant
        u.grants.insert("u6#drift".into(), Grant::of(P::VIDEO));
        rooms.insert("sfu_7".to_string(), u);
        std::thread::sleep(Duration::from_millis(5));
        let started = Instant::now();
        let mut journal = SfuResyncJournal::default();
        journal.record(JournalEntry::GrantChanged("sfu_7", "u5#swept"));
        let mut snap = listed("sfu_7", &["u5#swept", "u6#drift"], &[]);
        for id in ["u5#swept", "u6#drift"] {
            snap.grants.insert(id.into(), Grant::of(P::SPEAK | P::VIDEO)); // listed before the sweep
        }
        let names: HashSet<String> = ["sfu_7".to_string()].into_iter().collect();
        let m = merge_snapshot(&rooms, &[snap], &names, &journal, started, Instant::now());
        let due: Vec<String> = m.due.iter().map(|(_, id, _)| id.clone()).collect();
        assert_eq!(due, vec!["u6#drift".to_string()], "only the unjournaled difference is drift");
        let u = rooms.get("sfu_7").unwrap();
        assert_eq!(u.grants.get("u5#swept"), Some(&Grant::of(P::VIDEO)), "this process's newer word kept");
        assert_eq!(u.grants.get("u6#drift"), Some(&Grant::of(P::SPEAK | P::VIDEO)), "control: LiveKit's word taken");
    }

    /// A JOIN-time grant LiveKit does not confirm leaves the session's grant
    /// UNKNOWN (journaled for an in-flight resync), never the token's: a SPEAK
    /// deny's sweep then sends the whole grant its permissions give - it does
    /// not hand back the camera the join check took away (VIDEO revoked since
    /// the token). An unconfirmed LIVE grant is not forgotten: the grant last
    /// confirmed stays what the sweep compares with.
    #[tokio::test]
    async fn an_unconfirmed_join_grant_is_forgotten_so_no_sweep_hands_the_camera_back() {
        use crate::permissions::Permissions as P;
        no_env_proxy();
        let state = test_state();
        let token = Grant::of(P::SPEAK | P::VIDEO);
        {
            let now = Instant::now();
            let mut u = usage(&[("u5#join", now), ("u5#live", now)], &[], &[]);
            u.grants.insert("u5#join".into(), token);
            u.grants.insert("u5#live".into(), token);
            state.sfu_rooms.insert("sfu_7".into(), u);
        }
        *state.sfu_resync_journal.lock().unwrap() = Some(SfuResyncJournal::default());
        let refused = || ("/twirp/livekit.RoomService/UpdateParticipant", 503, r#"{"code":"unavailable"}"#.to_string());
        let (base, srv) = livekit_stand_in(vec![refused(), refused()], None).await;
        let cfg = cfg_for(&base);
        let speak_no_video = P::VIEW_CHANNEL | P::CONNECT | P::SPEAK;
        assert_eq!(regrant_if_stale(&state, &cfg, "sfu_7", "u5#join", speak_no_video, GrantAt::Join).await, Regrant::Failed);
        // Positive control: the same failure for a LIVE grant (SPEAK revoked).
        assert_eq!(
            regrant_if_stale(&state, &cfg, "sfu_7", "u5#live", P::VIEW_CHANNEL | P::CONNECT | P::VIDEO, GrantAt::Live).await,
            Regrant::Failed
        );
        asked(srv).await;
        {
            let u = state.sfu_rooms.get("sfu_7").unwrap();
            assert_eq!(u.grants.get("u5#join"), None, "unknown, not the token's grant");
            assert_eq!(u.grants.get("u5#live"), Some(&token), "a live grant's last confirmed one stays");
        }
        assert!(SfuResyncJournal::has(&state.sfu_resync_journal.lock().unwrap().as_ref().unwrap().grants, "sfu_7", "u5#join"));
        // SPEAK denied now: the sweep's grant for the join-checked session is
        // the whole one - no camera.
        state.sfu_rooms.get_mut("sfu_7").unwrap().participants.remove("u5#live");
        let (base, srv) = livekit_stand_in(
            vec![("/twirp/livekit.RoomService/UpdateParticipant", 200, info_reply(NO_PUBLISH))],
            None,
        )
        .await;
        let out = regrant_user_with(&state, &cfg_for(&base), 7, 5, P::VIEW_CHANNEL | P::CONNECT).await;
        let seen = asked(srv).await;
        assert_eq!(out.applied, 1);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&seen[0].body).unwrap()["permission"],
            serde_json::json!({"can_subscribe": true, "can_publish": false, "can_publish_data": true, "can_publish_sources": []}),
            "no camera handed back"
        );
    }

    /// An UpdateParticipant is IN FLIGHT from before it is sent until its
    /// answer is recorded, and a resync merging meanwhile - LiveKit already
    /// lists the applied grant, this process has not read the answer yet -
    /// takes neither the listed grant nor its difference (drift, whose join
    /// check would pull the live camera) for that session. Positive control:
    /// once the answer is in, nothing is in flight.
    #[tokio::test]
    async fn an_update_in_flight_is_not_read_as_drift() {
        use crate::permissions::Permissions as P;
        use std::sync::Mutex;
        no_env_proxy();
        let state = test_state();
        {
            let mut u = usage(&[("u5#a", Instant::now())], &[], &[]);
            u.grants.insert("u5#a".into(), Grant::of(P::SPEAK | P::VIDEO));
            state.sfu_rooms.insert("sfu_7".into(), u);
        }
        std::thread::sleep(Duration::from_millis(5));
        let during = Arc::clone(&state);
        let seen: Arc<Mutex<Option<(bool, usize, Option<Grant>)>>> = Arc::new(Mutex::new(None));
        let record = Arc::clone(&seen);
        let (base, srv) = livekit_stand_in(
            vec![("/twirp/livekit.RoomService/UpdateParticipant", 200, info_reply(CAMERA_ONLY))],
            Some(Box::new(move |m: &str| {
                if m != "UpdateParticipant" {
                    return;
                }
                // LiveKit has applied it; a resync lists and merges NOW.
                let in_flight = during.sfu_rooms.get("sfu_7").is_some_and(|u| u.in_flight.contains_key("u5#a"));
                let mut snap = listed("sfu_7", &["u5#a"], &[]);
                snap.grants.insert("u5#a".into(), Grant::of(P::VIDEO));
                let names: HashSet<String> = ["sfu_7".to_string()].into_iter().collect();
                let m = merge_snapshot(&during.sfu_rooms, &[snap], &names, &SfuResyncJournal::default(), Instant::now(), Instant::now());
                let held = during.sfu_rooms.get("sfu_7").and_then(|u| u.grants.get("u5#a").copied());
                *record.lock().unwrap() = Some((in_flight, m.due.len(), held));
            })),
        )
        .await;
        let out = regrant_user_with(&state, &cfg_for(&base), 7, 5, P::VIEW_CHANNEL | P::CONNECT | P::VIDEO).await;
        asked(srv).await;
        let after = state.sfu_rooms.get("sfu_7").map(|u| (u.in_flight.is_empty(), u.grants.get("u5#a").copied()));

        assert_eq!(out.applied, 1);
        assert_eq!(
            *seen.lock().unwrap(),
            Some((true, 0, Some(Grant::of(P::SPEAK | P::VIDEO)))),
            "in flight while LiveKit had it: no drift, and the record left to the answer"
        );
        assert_eq!(after, Some((true, Some(Grant::of(P::VIDEO)))), "answered: nothing in flight, the confirmed grant recorded");
    }

    /// A LIVE grant LiveKit did not confirm leaves its session UNCONFIRMED:
    /// the recorded grant is no shortcut until something confirms what LiveKit
    /// holds. SPEAK is revoked and LiveKit does not confirm it (it may hold
    /// it); SPEAK is restored, and the restore's grant - equal to the recorded
    /// one - is SENT, not judged unchanged, which with the resync off would
    /// leave LiveKit refusing a microphone the member may use. Its confirmation
    /// ends the marker. The camera stays throughout: the grant is not
    /// forgotten, which would send the whole grant and pull it.
    #[tokio::test]
    async fn a_live_grant_livekit_did_not_confirm_is_sent_again_even_when_it_looks_unchanged() {
        use crate::permissions::Permissions as P;
        no_env_proxy();
        let state = test_state();
        let held = Grant::of(P::SPEAK | P::VIDEO);
        {
            let mut u = usage(&[("u5#a", Instant::now())], &[], &[]);
            u.grants.insert("u5#a".into(), held);
            state.sfu_rooms.insert("sfu_7".into(), u);
        }
        let (base, srv) = livekit_stand_in(
            vec![("/twirp/livekit.RoomService/UpdateParticipant", 503, r#"{"code":"unavailable"}"#.to_string())],
            None,
        )
        .await;
        let revoke = regrant_user_with(&state, &cfg_for(&base), 7, 5, P::VIEW_CHANNEL | P::CONNECT | P::VIDEO).await;
        asked(srv).await;
        let after_revoke = state.sfu_rooms.get("sfu_7").map(|u| (u.unconfirmed.contains("u5#a"), u.grants.get("u5#a").copied()));
        let (base, srv) = livekit_stand_in(
            vec![("/twirp/livekit.RoomService/UpdateParticipant", 200, info_reply(MIC_AND_CAMERA))],
            None,
        )
        .await;
        let restore = regrant_user_with(&state, &cfg_for(&base), 7, 5, P::VIEW_CHANNEL | P::CONNECT | P::SPEAK | P::VIDEO).await;
        let seen = asked(srv).await;
        let after_restore = state.sfu_rooms.get("sfu_7").map(|u| u.unconfirmed.contains("u5#a"));

        assert_eq!(revoke.applied, 0);
        assert_eq!(after_revoke, Some((true, Some(held))), "unconfirmed, and the camera's grant kept");
        assert_eq!((restore.tried, restore.applied), (1, 1), "sent although it equals the recorded grant");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&seen[0].body).unwrap()["permission"]["can_publish_sources"],
            serde_json::json!(["MICROPHONE", "CAMERA"])
        );
        assert_eq!(after_restore, Some(false), "confirmed: the marker goes");
    }

    /// After a backend restart this process knows no session: the resync
    /// learns every call in progress, and they are LIVE sessions (TEST_DATABASE_URL;
    /// skips without it). The VIDEO-denied member's running camera - kept by
    /// the live rule when VIDEO was revoked mid-call - is not pulled by the
    /// first pass after a deploy; the SPEAK-denied member's microphone still
    /// goes (the one right the live rule enforces).
    #[tokio::test]
    async fn a_session_the_resync_learns_keeps_its_running_camera() {
        use crate::permissions::Permissions as P;
        let Some(pool) = crate::migrator::test_pool(2).await else { return };
        no_env_proxy();
        let f = speak_fixture(&pool).await;
        let state = AppState::new(pool.clone(), "test-secret".into(), None, Arc::new(crate::wake::NullWake));
        let room = room_name_for_channel(f.cid);
        let (cam, mic) = (format!("u{}#live", f.camless), format!("u{}#live", f.muted));
        let camera_track = r#"[{"sid":"TR_cam","source":"CAMERA"}]"#;
        let (base, srv) = livekit_stand_in(
            vec![
                ("/twirp/livekit.RoomService/ListRooms", 200, format!(r#"{{"rooms":[{{"name":"{room}"}}]}}"#)),
                ("/twirp/livekit.RoomService/ListParticipants", 200, format!(
                    r#"{{"participants":[
                    {{"identity":"{cam}","state":"ACTIVE","tracks":{camera_track},"permission":{MIC_AND_CAMERA}}},
                    {{"identity":"{mic}","state":"ACTIVE","tracks":[],"permission":{MIC_AND_CAMERA}}}]}}"#
                )),
                // Only the SPEAK-denied member's microphone: nothing for the camera.
                ("/twirp/livekit.RoomService/UpdateParticipant", 200, info_reply(CAMERA_ONLY)),
            ],
            None,
        )
        .await;
        let r = resync_once(&state, &cfg_for(&base), &client()).await;
        let seen = asked(srv).await;
        let grants: Vec<Option<Grant>> =
            [&cam, &mic].iter().map(|id| state.sfu_rooms.get(&room).and_then(|u| u.grants.get(*id).copied())).collect();
        drop_fixture(&pool, &f).await;

        let r = r.expect("resync");
        assert_eq!((r.added, r.regranted, r.denied), (2, 1, 0));
        assert_eq!(serde_json::from_str::<serde_json::Value>(&seen[2].body).unwrap(), camera_only_request(&room, &mic));
        assert_eq!(grants, vec![Some(Grant::of(P::SPEAK | P::VIDEO)), Some(Grant::of(P::VIDEO))], "the camera stays running");
    }

    /// A debt owed SINCE the merge wins (TEST_DATABASE_URL; skips without it).
    /// Two live sessions of the VIDEO-denied member are due a retried LIVE
    /// grant. While the resync waits for the server's lock, one of them rejoins
    /// and its join check fails - owing the whole grant (a JoinCheck) - and the
    /// other is owed a Cut. The first must get the WHOLE grant (camera removed)
    /// and only then lose its mark; the Cut, which no grant answers, must stay.
    /// Scheduled as live, the first found nothing to change and its clear
    /// erased the join check's debt, so nothing ever looked again.
    #[tokio::test]
    async fn a_join_check_owed_since_the_merge_is_given_and_a_stronger_debt_kept() {
        use crate::permissions::Permissions as P;
        use std::sync::atomic::AtomicBool;
        let Some(pool) = crate::migrator::test_pool(4).await else { return };
        no_env_proxy();
        let f = speak_fixture(&pool).await;
        let state = AppState::new(pool.clone(), "test-secret".into(), None, Arc::new(crate::wake::NullWake));
        let room = room_name_for_channel(f.cid);
        let (rejoined, cut) = (format!("u{}#x", f.camless), format!("u{}#y", f.camless));
        {
            let mut u = state.sfu_rooms.entry(room.clone()).or_default();
            for id in [&rejoined, &cut] {
                u.participants.insert(id.clone(), Instant::now());
                u.grants.insert(id.clone(), Grant::of(P::SPEAK | P::VIDEO));
                u.recheck.insert(id.clone(), Mark { what: Recheck::LiveGrant, passes: 0 });
            }
        }
        let listing = [&rejoined, &cut]
            .iter()
            .map(|id| format!(r#"{{"identity":"{id}","state":"ACTIVE","tracks":[],"permission":{MIC_AND_CAMERA}}}"#))
            .collect::<Vec<_>>()
            .join(",");
        let (base, srv) = livekit_stand_in(
            vec![
                ("/twirp/livekit.RoomService/ListRooms", 200, format!(r#"{{"rooms":[{{"name":"{room}"}}]}}"#)),
                ("/twirp/livekit.RoomService/ListParticipants", 200, format!(r#"{{"participants":[{listing}]}}"#)),
                ("/twirp/livekit.RoomService/UpdateParticipant", 200, info_reply(MIC_ONLY)),
            ],
            None,
        )
        .await;
        let held = state.lock_server_perms(&f.sid).await;
        let done = AtomicBool::new(false);
        let resync = async {
            let r = resync_once(&state, &cfg_for(&base), &client()).await;
            done.store(true, Ordering::SeqCst);
            r
        };
        let meanwhile = async {
            let deadline = Instant::now() + Duration::from_secs(10);
            while !done.load(Ordering::SeqCst) && state.server_perms_locks.get(&f.sid).map(|m| Arc::strong_count(&m)) != Some(3) {
                assert!(Instant::now() < deadline, "the resync never queued on the server's lock");
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            {
                let mut u = state.sfu_rooms.get_mut(&room).unwrap();
                u.recheck.insert(rejoined.clone(), Mark { what: Recheck::JoinCheck, passes: 0 });
                u.recheck.insert(cut.clone(), Mark { what: Recheck::Cut, passes: 0 });
            }
            drop(held);
        };
        let (r, ()) = tokio::time::timeout(Duration::from_secs(30), async { tokio::join!(resync, meanwhile) })
            .await
            .expect("the resync finished");
        let seen = asked(srv).await;
        let (marks, grant) = {
            let u = state.sfu_rooms.get(&room).unwrap();
            ([&rejoined, &cut].map(|id| u.recheck.get(id).map(|m| m.what)), u.grants.get(&rejoined).copied())
        };
        drop_fixture(&pool, &f).await;

        r.expect("resync");
        assert_eq!(serde_json::from_str::<serde_json::Value>(&seen[2].body).unwrap(), mic_only_request(&room, &rejoined));
        assert_eq!(grant, Some(Grant::of(P::SPEAK)), "the whole grant: camera removed");
        assert_eq!(marks, [None, Some(Recheck::Cut)], "the join check's debt paid; the Cut, which no grant answers, kept");
    }

    /// A debt owed WHILE a check runs survives it (TEST_DATABASE_URL; skips
    /// without it). The speaker's session is owed a join check. The resync
    /// reads its mark's generation, then waits for the server's lock; meanwhile
    /// an eviction that does not take that lock - a flip out of SFU mode,
    /// whose RemoveParticipant LiveKit did not confirm - owes the session a
    /// join check again. The check runs on what it read before that (the
    /// channel still an SFU one), finds nothing to change - and must NOT clear
    /// the newer debt: the next pass's check, which would find the channel no
    /// longer an SFU one and cut the session, has to run. (The F4 test is the
    /// positive control: a mark only raised, not written again, is cleared.)
    #[tokio::test]
    async fn a_debt_owed_while_the_check_ran_is_left_for_the_next_pass() {
        use std::sync::atomic::AtomicBool;
        let Some(pool) = crate::migrator::test_pool(4).await else { return };
        no_env_proxy();
        let f = speak_fixture(&pool).await;
        let state = AppState::new(pool.clone(), "test-secret".into(), None, Arc::new(crate::wake::NullWake));
        let room = room_name_for_channel(f.cid);
        let id = format!("u{}#s", f.speaker);
        {
            let mut u = state.sfu_rooms.entry(room.clone()).or_default();
            u.participants.insert(id.clone(), Instant::now());
            u.grants.insert(id.clone(), Grant::of(Permissions::SPEAK | Permissions::VIDEO));
            u.recheck.insert(id.clone(), Mark { what: Recheck::JoinCheck, passes: 0 });
        }
        let (base, srv) = livekit_stand_in(
            vec![
                ("/twirp/livekit.RoomService/ListRooms", 200, format!(r#"{{"rooms":[{{"name":"{room}"}}]}}"#)),
                ("/twirp/livekit.RoomService/ListParticipants", 200,
                 format!(r#"{{"participants":[{{"identity":"{id}","state":"ACTIVE","tracks":[],"permission":{MIC_AND_CAMERA}}}]}}"#)),
            ],
            None,
        )
        .await;
        let held = state.lock_server_perms(&f.sid).await;
        let done = AtomicBool::new(false);
        let resync = async {
            let r = resync_once(&state, &cfg_for(&base), &client()).await;
            done.store(true, Ordering::SeqCst);
            r
        };
        let meanwhile = async {
            let deadline = Instant::now() + Duration::from_secs(10);
            while !done.load(Ordering::SeqCst) && state.server_perms_locks.get(&f.sid).map(|m| Arc::strong_count(&m)) != Some(3) {
                assert!(Instant::now() < deadline, "the resync never queued on the server's lock");
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            owe(&state, &[(room.clone(), id.clone())], Recheck::JoinCheck);
            drop(held);
        };
        let (r, ()) = tokio::time::timeout(Duration::from_secs(30), async { tokio::join!(resync, meanwhile) })
            .await
            .expect("the resync finished");
        asked(srv).await;
        let mark = state.sfu_rooms.get(&room).and_then(|u| u.recheck.get(&id).map(|m| m.what));
        drop_fixture(&pool, &f).await;

        r.expect("resync");
        assert_eq!(mark, Some(Recheck::JoinCheck), "owed after the check read its answer: left for the next pass");
    }

    /// A STOCKPILED TOKEN, through the `participant_joined` check
    /// (TEST_DATABASE_URL; skips without it): a join whose token's grant names
    /// the microphone for a member denied SPEAK is given the current grant; a
    /// join whose grant is current is sent nothing; a join that reports no
    /// grant is given it (unknown); a non-member is still evicted; and a join
    /// whose token names the camera for a member denied VIDEO since is given
    /// the WHOLE current grant - camera removed, not just the microphone moved.
    #[tokio::test]
    async fn the_join_webhooks_check_gives_a_stockpiled_token_the_grant_permissions_give_now() {
        let Some(pool) = crate::migrator::test_pool(2).await else { return };
        no_env_proxy();
        let f = speak_fixture(&pool).await;
        let state = AppState::new(pool.clone(), "test-secret".into(), None, Arc::new(crate::wake::NullWake));
        let room = room_name_for_channel(f.cid);
        let (stock, fine, silent, stranger, camless) = (
            format!("u{}#w1", f.muted),
            format!("u{}#w2", f.speaker),
            format!("u{}#w3", f.muted),
            format!("u{}#w4", f.outsider),
            format!("u{}#w5", f.camless),
        );
        let (base, srv) = livekit_stand_in(
            vec![
                ("/twirp/livekit.RoomService/UpdateParticipant", 200, info_reply(CAMERA_ONLY)),
                ("/twirp/livekit.RoomService/UpdateParticipant", 200, info_reply(CAMERA_ONLY)),
                ("/twirp/livekit.RoomService/RemoveParticipant", 200, "{}".to_string()),
                ("/twirp/livekit.RoomService/UpdateParticipant", 200, info_reply(MIC_ONLY)),
            ],
            None,
        )
        .await;
        let cfg = cfg_for(&base);
        let token_grant = serde_json::json!({"canSubscribe": true, "canPublish": true, "canPublishData": true, "canPublishSources": ["MICROPHONE", "CAMERA"]});
        for (identity, uid, permission) in [
            (&stock, f.muted, Some(&token_grant)),
            (&fine, f.speaker, Some(&token_grant)),
            (&silent, f.muted, None),
            (&stranger, f.outsider, Some(&token_grant)),
            (&camless, f.camless, Some(&token_grant)),
        ] {
            let mut p = serde_json::json!({ "identity": identity });
            if let Some(g) = permission {
                p["permission"] = g.clone();
            }
            // Records the payload's grant; its own spawned check finds no SFU
            // configuration in a test and does nothing - this is that check:
            apply_webhook_event(&state, "participant_joined", room.clone(), &serde_json::json!({ "participant": p }));
            reauth_join(&state, &cfg, &room, identity, f.cid, uid).await;
        }
        let seen = asked(srv).await;
        let known: Vec<bool> = [&stock, &fine, &silent, &stranger, &camless]
            .iter()
            .map(|id| state.sfu_rooms.get(&room).is_some_and(|u| u.participants.contains_key(*id)))
            .collect();
        let camless_grant = state.sfu_rooms.get(&room).and_then(|u| u.grants.get(&camless).copied());
        drop_fixture(&pool, &f).await;

        let bodies: Vec<serde_json::Value> = seen.iter().map(|s| serde_json::from_str(&s.body).unwrap()).collect();
        assert_eq!(
            bodies,
            vec![
                camera_only_request(&room, &stock),
                camera_only_request(&room, &silent),
                serde_json::json!({ "room": room, "identity": stranger }),
                mic_only_request(&room, &camless),
            ],
            "the stale token, the unreported grant, the non-member's eviction, then the camera a VIDEO deny took away - nothing for the speaker"
        );
        assert_eq!(known, vec![true, true, true, false, true], "only the non-member leaves");
        assert_eq!(camless_grant, Some(Grant::of(Permissions::SPEAK)), "confirmed: the join-time grant, camera removed");
    }

}
