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
const CAM_LOW_KBPS: u64 = 150;
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
}

struct SfuConfig {
    /// Client-facing signaling URL (e.g. wss://sfu.example.com).
    url: String,
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

/// All-or-nothing: an unset/blank var means the SFU tier is not deployed and
/// every mint request answers 503, leaving the mesh path untouched.
fn sfu_config() -> Option<SfuConfig> {
    let getenv = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());
    Some(SfuConfig {
        url: getenv("LIVEKIT_URL")?,
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
    let per_subscriber = focus + n.saturating_sub(2) * CAM_LOW_KBPS;
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
            .timeout(Duration::from_secs(3))
            .build()
        {
            Ok(c) => c,
            Err(e) => {
                tracing::error!("SFU egress sampler: client build failed: {e}");
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
    for mut r in state.sfu_rooms.iter_mut() {
        r.reservations
            .retain(|_, minted| now.duration_since(*minted) < RESERVATION_TTL);
    }
    state.sfu_rooms.retain(|_, u| {
        !(u.participants.is_empty() && u.reservations.is_empty() && u.screen_shares.is_empty())
    });
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
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    can_publish: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    can_subscribe: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    can_publish_data: bool,
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
) -> Result<String, jsonwebtoken::errors::Error> {
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
            can_publish: true,
            can_subscribe: true,
            can_publish_data: true,
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
            room_admin: true,
            can_publish: false,
            can_subscribe: false,
            can_publish_data: false,
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
pub async fn evict_user_from_channel(state: &Arc<AppState>, channel_id: i64, user_id: i64) {
    let Some(cfg) = sfu_config() else { return };
    let room = room_name_for_channel(channel_id);

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
        None => return, // no SFU activity for this channel
    };
    if identities.is_empty() {
        return;
    }

    let token = match mint_admin_token(&cfg, &room) {
        Ok(t) => t,
        Err(e) => {
            tracing::error!("SFU evict: admin token mint failed: {e}");
            return;
        }
    };
    // LiveKit twirp: POST {url}/twirp/livekit.RoomService/RemoveParticipant.
    // Derive the HTTP base from the signaling URL (ws->http, wss->https).
    let http_base = cfg
        .url
        .replacen("wss://", "https://", 1)
        .replacen("ws://", "http://", 1);
    let endpoint = format!(
        "{}/twirp/livekit.RoomService/RemoveParticipant",
        http_base.trim_end_matches('/')
    );
    // A per-request timeout: this loops over participants awaiting each call,
    // so a single hung LiveKit connection (dropped node, network black hole)
    // would otherwise stall the whole eviction — and eviction runs on the
    // path that frees egress slots. 5s is well past a healthy round-trip.
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            tracing::error!("SFU evict: could not build HTTP client: {e}");
            return;
        }
    };
    for identity in identities {
        let resp = client
            .post(&endpoint)
            .bearer_auth(&token)
            .json(&serde_json::json!({ "room": room, "identity": identity }))
            .send()
            .await;
        match resp {
            Ok(r) if r.status().is_success() => {
                // Drop from local usage so the egress projection frees the slot
                // without waiting for the participant_left webhook.
                if let Some(mut u) = state.sfu_rooms.get_mut(&room) {
                    u.participants.remove(&identity);
                    u.reservations.remove(&identity);
                }
            }
            Ok(r) => tracing::warn!("SFU evict {identity}: LiveKit returned {}", r.status()),
            Err(e) => tracing::warn!("SFU evict {identity}: request failed: {e}"),
        }
    }
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
    match get_user_channel_permissions(&state.pool, channel_id, claims.sub).await {
        ChannelPermAccess::Allowed { perms, .. }
            if perms.has(Permissions::VIEW_CHANNEL) && perms.has(Permissions::CONNECT) => {}
        ChannelPermAccess::Allowed { .. } | ChannelPermAccess::NotFound => {
            return (StatusCode::NOT_FOUND, "Channel not found").into_response()
        }
        ChannelPermAccess::NotMember => {
            return (StatusCode::FORBIDDEN, "Not a member of this server").into_response()
        }
    }

    let row: Option<(i32, bool)> =
        sqlx::query_as("SELECT type, COALESCE(sfu_mode, false) FROM channels WHERE id = $1")
            .bind(channel_id)
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

    let token = match mint_join_token(&cfg, &room, &identity, &claims.username) {
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

    match kind {
        "participant_joined" => {
            if let Some(identity) = event
                .pointer("/participant/identity")
                .and_then(|v| v.as_str())
            {
                let mut u = state.sfu_rooms.entry(room).or_default();
                u.reservations.remove(identity);
                u.participants.insert(identity.to_string(), Instant::now());
            }
        }
        "participant_left" => {
            if let Some(identity) = event
                .pointer("/participant/identity")
                .and_then(|v| v.as_str())
            {
                if let Some(mut u) = state.sfu_rooms.get_mut(&room) {
                    u.participants.remove(identity);
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
                let mut u = state.sfu_rooms.entry(room).or_default();
                if kind == "track_published" {
                    u.screen_shares.insert(sid.to_string());
                } else {
                    u.screen_shares.remove(sid);
                }
            }
        }
        "room_finished" => {
            state.sfu_rooms.remove(&room);
        }
        _ => {}
    }
    prune(&state);
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

    #[test]
    fn share_focus_replaces_camera_focus_and_extra_shares_stack() {
        // One share swaps the focus cost rather than adding to it: the delta
        // between share and no-share at N=4 is 4 × 2000 × 1.15 = 9.2 Mbps.
        let delta = room_egress_kbps(4, 1) - room_egress_kbps(4, 0);
        assert_eq!(
            delta,
            4 * (SHARE_KBPS - CAM_HIGH_KBPS) * OVERHEAD_NUM / OVERHEAD_DEN
        );
        // But each ADDITIONAL live share is charged at full share rate: shares
        // have no low simulcast layer, so admission must grow with share
        // count now that the client-side cap defaults to unlimited.
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
