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

/// All-or-nothing: an unset/blank var means the SFU tier is not deployed and
/// every mint request answers 503, leaving the mesh path untouched.
fn sfu_config() -> Option<SfuConfig> {
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
    for mut r in state.sfu_rooms.iter_mut() {
        r.reservations
            .retain(|_, minted| now.duration_since(*minted) < RESERVATION_TTL);
    }
    state.sfu_rooms.retain(|_, u| {
        !(u.participants.is_empty() && u.reservations.is_empty() && u.screen_shares.is_empty())
    });
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
}

impl SfuResyncJournal {
    fn len(&self) -> usize {
        self.joined.len()
            + self.left.len()
            + self.published.len()
            + self.unpublished.len()
            + self.finished.len()
            + self.evict_intents.len()
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
        rooms.push(LkRoom { name, participants, share_sids });
    }
    Ok((rooms, listed))
}

/// Merge a snapshot into `rooms`. The snapshot was requested at `started`, and
/// every webhook or eviction since then is in `journal` and wins over it.
///
/// - A listed session is added if absent, at `now` (the fail-safe choice for
///   admission's "settled" count), and a known one keeps its time. One that
///   left since `started` is not brought back. A listed identity holding a
///   reservation moves to participants, as its join would have moved it.
/// - A known session LiveKit does not list is cleared only if it was known
///   before `started` and no join was seen since: a `participant_left` that
///   never arrived. The same holds for rooms LiveKit no longer has at all -
///   judged against `listed`, EVERY name ListRooms returned, so a room the
///   snapshot skipped (not `sfu_<channel>`) is never mistaken for a gone one.
/// - Screen shares follow the same rules, by track sid.
/// - Reservations are never added, expired or cleared here: a minted token's
///   room does not exist in LiveKit until its first join.
fn merge_snapshot(
    rooms: &DashMap<String, SfuRoomUsage>,
    snap: &[LkRoom],
    listed: &HashSet<String>,
    journal: &SfuResyncJournal,
    started: Instant,
    now: Instant,
) -> ResyncReport {
    let mut report = ResyncReport::default();
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
        for id in &room.participants {
            if SfuResyncJournal::has(&journal.left, name, id) {
                continue;
            }
            let was_reserved = u.reservations.remove(id).is_some();
            if !u.participants.contains_key(id) {
                u.participants.insert(id.clone(), now);
                if was_reserved {
                    report.moved += 1;
                } else {
                    report.added += 1;
                }
            }
        }
        let before = u.participants.len();
        u.participants.retain(|id, seen| {
            listed.contains(id.as_str()) || *seen >= started || SfuResyncJournal::has(&journal.joined, name, id)
        });
        report.cleared += before - u.participants.len();
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
        }
    }
    report
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
        let mut report = merge_snapshot(&state.sfu_rooms, &rooms, &listed, &journal, started, Instant::now());
        report.ignored = listed.len() - rooms.len();
        (report, journal.evict_intents)
    };
    prune(state);
    // A kick, ban or transport change during the fetch found nothing to eject
    // for a session only the snapshot knew; now the map knows it.
    for (room, uid) in intents {
        let Some(cid) = channel_id_from_room(&room) else { continue };
        let prefix = format!("u{uid}#");
        let known = state.sfu_rooms.get(&room).is_some_and(|u| {
            u.participants.keys().chain(u.reservations.keys()).any(|i| i.starts_with(&prefix))
        });
        if known {
            report.reapplied += evict_with(state, cfg, cid, uid).await.removed;
        }
    }
    Ok(report)
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
    if cfg.api_url.is_none() {
        tracing::warn!(
            "SFU resync is off: LIVEKIT_API_URL is not set. Set it to this host's LiveKit (http://127.0.0.1:7880 in the standard deploy) so a restart does not forget who is already in a call - until then such a session cannot be ejected or counted. See .env.example."
        );
        return;
    }
    let every = match resync_period(std::env::var("SFU_RESYNC_SECS").ok().as_deref()) {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!("SFU resync: {e}; using {} s", RESYNC_EVERY.as_secs());
            RESYNC_EVERY
        }
    };
    tokio::spawn(run_reconciler(state, every, sfu_config));
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
                drifted = synced && drift;
                if reported_down {
                    tracing::info!("SFU resync: LiveKit's rooms are readable again");
                    reported_down = false;
                }
                synced = true;
                failures = 0;
                if every.is_zero() {
                    return;
                }
                tokio::time::sleep(every).await;
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
    // advisory to a modified client). A demotion mid-call takes effect at
    // the next token (TOKEN_TTL_SECS) unless the member is evicted.
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
    let tried = identities.len();

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
                journal(state, JournalEntry::Left(&room, &identity));
                // Drop from local usage so the egress projection frees the slot
                // without waiting for the participant_left webhook.
                if let Some(mut u) = state.sfu_rooms.get_mut(&room) {
                    u.participants.remove(&identity);
                    u.reservations.remove(&identity);
                }
            }
            Ok(r) => tracing::warn!("SFU evict {identity}: LiveKit returned {}", r.status()),
            Err(e) => tracing::warn!(
                "SFU evict {identity}: request failed: {}",
                crate::http_err::http_err(&e)
            ),
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
                }
                // Re-authorize the join. A join token is minted against the
                // perms of that moment and LiveKit checks only its signature,
                // so a member kicked, banned or VIEW/CONNECT-denied inside the
                // 20-minute TTL — or holding tokens stockpiled beforehand,
                // whose identities the perms-change sweep never saw — can
                // reconnect after every eviction. This webhook is the one
                // server-side point that observes a (re)join, so the mint-time
                // gate is re-run here and a no-longer-entitled participant is
                // removed. Spawned: eviction awaits a RemoveParticipant round
                // trip, and the webhook response must not wait on LiveKit.
                match (channel_id, user_id) {
                    (Some(cid), Some(uid)) => {
                        let state = Arc::clone(&state);
                        tokio::spawn(async move {
                            let access =
                                get_user_channel_permissions(&state.pool, cid, uid).await;
                            if sfu_entitled(&access) {
                                return;
                            }
                            let reason = match access {
                                ChannelPermAccess::NotFound => "channel not found or lookup failed",
                                ChannelPermAccess::NotMember => "not a member of the server",
                                ChannelPermAccess::Allowed { .. } => "VIEW_CHANNEL or CONNECT denied",
                            };
                            tracing::warn!(
                                "SFU join re-auth: evicting user {} from sfu channel {} ({})",
                                uid,
                                cid,
                                reason
                            );
                            evict_user_from_channel(&state, cid, uid).await;
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
        assert!(!sfu_entitled(&allowed(Permissions::empty())), "a role-fetch DB error resolves to Allowed with empty perms");
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
mod resync_tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn listed(name: &str, ids: &[&str], shares: &[&str]) -> LkRoom {
        LkRoom {
            name: name.into(),
            participants: ids.iter().map(|s| s.to_string()).collect(),
            share_sids: shares.iter().map(|s| s.to_string()).collect(),
        }
    }

    fn usage(parts: &[(&str, Instant)], res: &[&str], shares: &[&str]) -> SfuRoomUsage {
        SfuRoomUsage {
            participants: parts.iter().map(|(i, t)| (i.to_string(), *t)).collect(),
            reservations: res.iter().map(|i| (i.to_string(), Instant::now())).collect(),
            screen_shares: shares.iter().map(|s| s.to_string()).collect(),
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

    const RIG_SECRET: &str = "rig-secret-0123456789abcdef0123456789";

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

    #[test]
    fn the_admin_api_url_prefers_livekit_api_url() {
        let mut cfg = cfg_for("http://127.0.0.1:1");
        cfg.url = "wss://sfu.example.com/".into();
        assert_eq!(api_base(&cfg), "https://sfu.example.com");
        cfg.api_url = Some("http://127.0.0.1:7880/".into());
        assert_eq!(api_base(&cfg), "http://127.0.0.1:7880", "the host's own node, not the public name");
    }

    struct Seen {
        body: String,
        claims: serde_json::Value,
    }

    /// Serve `script` in order, one connection each: (path it must be, status,
    /// reply). `on_call` runs with the method name as each request arrives,
    /// before the reply. A token that does not verify under the rig secret is
    /// answered 401, as LiveKit would.
    async fn livekit_stand_in(
        script: Vec<(&'static str, u16, String)>,
        on_call: Option<Box<dyn Fn(&str) + Send>>,
    ) -> (String, tokio::task::JoinHandle<Vec<Seen>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let base = format!("http://{}", listener.local_addr().expect("addr"));
        let task = tokio::spawn(async move {
            let mut seen = Vec::new();
            for (want, status, reply) in script {
                let (mut s, _) = listener.accept().await.expect("accept");
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
                assert_eq!(path, want, "the calls come in this order");
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
                let (claims, status) = match verified {
                    Ok(t) => (t.claims, status),
                    Err(_) => (serde_json::Value::Null, 401),
                };
                if let Some(f) = &on_call {
                    f(path.rsplit('/').next().unwrap_or(""));
                }
                seen.push(Seen { body, claims });
                let resp = format!(
                    "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{reply}",
                    reply.len()
                );
                s.write_all(resp.as_bytes()).await.expect("write");
                let _ = s.shutdown().await;
            }
            seen
        });
        (base, task)
    }

    async fn asked(task: tokio::task::JoinHandle<Vec<Seen>>) -> Vec<Seen> {
        tokio::time::timeout(Duration::from_secs(10), task)
            .await
            .expect("a scripted call never came")
            .expect("stand-in")
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

    fn test_state() -> Arc<AppState> {
        let pool = sqlx::postgres::PgPoolOptions::new()
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
        merge_snapshot(rooms, snap, &listed, journal, started, now)
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
        let r = merge(&rooms, &[listed("sfu_7", &["u5#aa"], &[])], &SfuResyncJournal::default(), Instant::now(), Instant::now());
        assert_eq!((r.added, r.moved), (0, 1), "its participant_joined was merely still on its way");
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
        let r = merge_snapshot(&rooms, &[], &listed_names, &SfuResyncJournal::default(), Instant::now(), Instant::now());
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
    async fn every_webhook_arm_journals_before_it_touches_the_map() {
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
        let g = state.sfu_resync_journal.lock().unwrap();
        let j = g.as_ref().unwrap();
        assert!(j.evict_intents.contains(&("sfu_7".to_string(), 5)));
        assert!(SfuResyncJournal::has(&j.left, "sfu_7", "u5#aa"));
        assert!(!state.sfu_rooms.get("sfu_7").unwrap().participants.contains_key("u5#aa"));
    }

    #[tokio::test]
    async fn a_kick_during_the_fetch_is_applied_to_what_the_merge_adds() {
        let state = test_state();
        let during = Arc::clone(&state);
        let (base, srv) = livekit_stand_in(
            vec![
                ("/twirp/livekit.RoomService/ListRooms", 200, r#"{"rooms":[{"name":"sfu_7"}]}"#.to_string()),
                ("/twirp/livekit.RoomService/ListParticipants", 200,
                 r#"{"participants":[{"identity":"u5#aa","state":"ACTIVE","tracks":[]},{"identity":"u6#bb","state":"ACTIVE","tracks":[]}]}"#.to_string()),
                ("/twirp/livekit.RoomService/RemoveParticipant", 200, "{}".to_string()),
            ],
            // The kick lands while LiveKit is being read, and finds nothing:
            // this process does not know u5 yet.
            Some(Box::new(move |m: &str| {
                if m == "ListRooms" {
                    journal(&during, JournalEntry::EvictIntent("sfu_7", 5))
                }
            })),
        )
        .await;
        let r = resync_once(&state, &cfg_for(&base), &client()).await.expect("resync");
        let seen = asked(srv).await;
        assert_eq!(r.reapplied, 1);
        let body: serde_json::Value = serde_json::from_str(&seen[2].body).unwrap();
        assert_eq!(body, serde_json::json!({ "room": "sfu_7", "identity": "u5#aa" }));
        let u = state.sfu_rooms.get("sfu_7").unwrap();
        assert!(!u.participants.contains_key("u5#aa"), "ejected after all");
        assert!(u.participants.contains_key("u6#bb"), "control: the other session is learned and left alone");
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
        let state = test_state();
        let (base, srv) = livekit_stand_in(
            vec![
                ("/twirp/livekit.RoomService/ListRooms", 503, r#"{"code":"unavailable","msg":"starting"}"#.to_string()),
                ("/twirp/livekit.RoomService/ListRooms", 200, r#"{"rooms":[]}"#.to_string()),
            ],
            None,
        )
        .await;
        let cfg_base = base.clone();
        let started = Instant::now();
        tokio::time::timeout(
            Duration::from_secs(15),
            run_reconciler(state, Duration::ZERO, move || Some(cfg_for(&cfg_base))),
        )
        .await
        .expect("SFU_RESYNC_SECS=0 returns after its first success");
        assert!(started.elapsed() >= Duration::from_secs(RESYNC_RETRY_SECS[0]), "it waited before retrying");
        assert_eq!(asked(srv).await.len(), 2, "one failure, one success, then nothing");
    }

}
