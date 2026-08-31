//! Clips — the consent protocol (docs/CLIPS.md, plan D1/D2/D5/D6).
//!
//! A clipper's client freezes the last N seconds of a voice call in ITS OWN
//! memory and asks here for approval. The server:
//!   1. computes WHO must approve — everyone the room's presence log saw in the
//!      window, UNIONed with whoever the client declares (union can only ADD
//!      approvers, so a lying client cannot shrink the set), minus the clipper;
//!   2. prompts them (doorbell frame; the client fetches GET /clips/:id);
//!   3. records votes — a vote is final, anonymous on the wire, and one decline
//!      ends the proposal for everyone;
//!   4. once all approved, lets the SAME user upload parts under this clip_id
//!      (upload_handlers.rs refuses bytes for anything else) and post ONE
//!      message that consumes the proposal (message_handlers.rs stamps
//!      `clip_consent` from this record, never from the request body).
//! Nothing here is persisted; a restart drops every proposal, which fails safe.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use dashmap::mapref::one::Ref;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::auth::Claims;
use crate::permissions::{get_channel_viewer_ids, get_user_channel_permissions, ChannelPermAccess, Permissions};
use crate::protocol::{ClipOutcome, ServerMessage, UserInfo};
use crate::state::{now_unix_ms, AppState, ClipDenial, ClipProposal, ClipRateState, ClipVote, ClipVoter, PresenceLog, UserId};

// ---- limits -------------------------------------------------------------------
/// 30 min (plan D2). Env-overridable ONLY so the live e2e can drive expiry
/// without a 30-minute sleep; production never sets it.
pub fn clip_proposal_ttl() -> Duration {
    std::env::var("CLIP_PROPOSAL_TTL_SECS").ok().and_then(|v| v.parse::<u64>().ok()).map(Duration::from_secs).unwrap_or(Duration::from_secs(30 * 60))
}
/// Extra time granted at full approval so the upload+post can finish.
pub const CLIP_UPLOAD_GRACE: Duration = Duration::from_secs(15 * 60);
pub const CLIP_MAX_APPROVERS: usize = 32;
pub const CLIP_MAX_DECLARED: usize = 64;
pub const CLIP_MAX_LIVE_PROPOSALS: usize = 2000;
pub const CLIP_RATE_WINDOW: Duration = Duration::from_secs(300);
pub const CLIP_RATE_MAX: u32 = 5;
pub const CLIP_DENIAL_STEPS_SECS: [u64; 5] = [30, 120, 300, 900, 1800];
pub const CLIP_DENIAL_DECAY: Duration = Duration::from_secs(1800);
pub const MIN_CLIP_MS: i64 = 5_000;

// ---- pure core -----------------------------------------------------------------

/// D1's union. `log_hits` is what the SERVER observed; `declared` is what the
/// clipper's client claims; `viewers` is who could plausibly have been in that
/// room at all. Sorted for stable frames.
///
/// UNION, never intersection: a lying client can only ADD approvers to its own
/// clip, never remove one. `declared` is filtered to `viewers` solely to stop a
/// modified client using this endpoint to fire approval prompts at arbitrary
/// accounts — a declared id that IS a real co-member is required even if the
/// log never saw them, because "the server missed it" and "the client made it
/// up" are indistinguishable here and only one of those errs safely.
pub fn union_approvers(log_hits: &HashSet<UserId>, declared: &[UserId], viewers: &HashSet<UserId>, proposer: UserId) -> Vec<UserId> {
    let mut set: HashSet<UserId> = log_hits.iter().copied().collect();
    let mut seen = HashSet::new();
    for &d in declared.iter().take(CLIP_MAX_DECLARED) {
        if seen.insert(d) && viewers.contains(&d) {
            set.insert(d);
        }
    }
    set.remove(&proposer);
    let mut out: Vec<UserId> = set.into_iter().collect();
    out.sort_unstable();
    out
}

/// A proposal is live only while unexpired — enforced HERE, not just by the
/// sweeper, so a 60 s sweep lag can never let an expired proposal be voted on
/// or posted with.
pub fn live_proposal<'a>(state: &'a AppState, clip_id: &str) -> Option<Ref<'a, String, ClipProposal>> {
    let r = state.clip_proposals.get(clip_id)?;
    if Instant::now() >= r.expires {
        return None;
    }
    Some(r)
}

fn plain(status: StatusCode, msg: &'static str) -> Response {
    (status, msg).into_response()
}

// ---- fan-out ------------------------------------------------------------------

/// The doorbell. Live sockets get ClipProposed; an offline approver gets a
/// CONTENT-FREE ClipPending parked for the delivery socket the wake summons.
fn notify_proposed(state: &Arc<AppState>, p: &ClipProposal) {
    let expires_in_ms = p.expires.saturating_duration_since(Instant::now()).as_millis() as i64;
    for v in &p.votes {
        let live = ServerMessage::ClipProposed { clip_id: p.clip_id.clone(), expires_in_ms };
        if !state.send_to_user(v.user_id, live) {
            state.enqueue_undelivered(v.user_id, ServerMessage::ClipPending { clip_id: p.clip_id.clone() });
            crate::wake::sender::wake_user(state, v.user_id);
        }
    }
}

/// Terminal frames: the proposer sees the real outcome; approvers see only
/// `approved` or `closed`. Best-effort delivery, never parked (waking a phone
/// to say "that clip expired" is noise on a doorbell budget that exists for
/// messages; the client reconciles via GET /clips/pending on reconnect).
pub fn broadcast_resolved(state: &Arc<AppState>, p: &ClipProposal, outcome: ClipOutcome) {
    state.send_to_user(p.proposer, ServerMessage::ClipResolved { clip_id: p.clip_id.clone(), outcome });
    let for_others = if outcome == ClipOutcome::Approved { ClipOutcome::Approved } else { ClipOutcome::Closed };
    for v in &p.votes {
        state.send_to_user(v.user_id, ServerMessage::ClipResolved { clip_id: p.clip_id.clone(), outcome: for_others });
    }
}

// ---- DTOs -------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct ProposeClipRequest {
    pub target_channel_id: i64,
    /// Length of the sealed clip. u64: serde rejects negatives with 422, and the
    /// explicit bounds below stay so a future type change cannot reopen it.
    pub duration_ms: u64,
    /// How long ago (ms) the clip ENDED — relative, so client clock skew cannot
    /// shift the window.
    pub ended_ago_ms: u64,
    #[serde(default)]
    pub declared_participants: Vec<UserId>,
}

#[derive(Serialize)]
pub struct ApproverView {
    pub id: UserId,
    pub username: String,
    pub online: bool,
}

#[derive(Serialize)]
pub struct ProposeClipResponse {
    pub clip_id: String,
    pub expires_in_ms: i64,
    /// Names go to the PROPOSER only — and only of people the proposer shared
    /// the room with (the window is bounded by their own presence).
    pub approvers: Vec<ApproverView>,
    pub solo: bool,
    pub resolved: bool,
    pub approved: bool,
}

#[derive(Serialize)]
struct RefusalWithData<'a> {
    error: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    earliest_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    retry_after_ms: Option<i64>,
}

#[derive(Deserialize)]
pub struct VoteRequest {
    pub approve: bool,
}

#[derive(Serialize)]
pub struct VoteResponse {
    pub clip_id: String,
    pub state: &'static str,
    pub approved_count: u32,
    pub total: u32,
}

/// What GET /clips/:id returns. Approvers get a reduced view (no other names).
#[derive(Serialize)]
pub struct ClipView {
    pub clip_id: String,
    pub proposer: UserInfo,
    pub server_id: String,
    pub voice_channel_id: i64,
    pub voice_channel_name: String,
    pub target_channel_id: i64,
    pub target_channel_name: String,
    pub duration_ms: i64,
    pub ended_ago_ms: i64,
    pub expires_in_ms: i64,
    pub approver_count: u32,
    pub approved_count: u32,
    pub solo: bool,
    pub resolved: bool,
    pub approved: bool,
    /// Proposer only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approvers: Option<Vec<ApproverView>>,
    /// Approver only: your own vote + flags for the prompt copy.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub my_vote: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub you: Option<YouView>,
}

#[derive(Serialize)]
pub struct YouView {
    pub had_camera: bool,
    pub had_share: bool,
    pub still_in_call: bool,
}

fn vote_str(v: ClipVote) -> &'static str {
    match v {
        ClipVote::Pending => "pending",
        ClipVote::Approved => "approved",
        ClipVote::Declined => "declined",
    }
}

fn view_for(state: &AppState, p: &ClipProposal, viewer: UserId) -> ClipView {
    let now = Instant::now();
    let now_ms = now_unix_ms();
    let is_proposer = viewer == p.proposer;
    let mine = p.votes.iter().find(|v| v.user_id == viewer);
    let still_in_call = state.rooms.get(&format!("voice_{}", p.voice_channel_id)).map(|r| r.members.contains(&viewer)).unwrap_or(false);
    ClipView {
        clip_id: p.clip_id.clone(),
        proposer: UserInfo::new(p.proposer, p.proposer_username.clone()),
        server_id: p.server_id.clone(),
        voice_channel_id: p.voice_channel_id,
        voice_channel_name: p.voice_channel_name.clone(),
        target_channel_id: p.target_channel_id,
        target_channel_name: p.target_channel_name.clone(),
        duration_ms: p.duration_ms,
        ended_ago_ms: (now_ms - p.window_end_ms).max(0),
        expires_in_ms: p.expires.saturating_duration_since(now).as_millis() as i64,
        approver_count: p.votes.len() as u32,
        approved_count: p.approved_count() as u32,
        solo: p.solo,
        resolved: p.approved_at.is_some(),
        approved: p.approved_at.is_some(),
        approvers: if is_proposer {
            Some(p.votes.iter().map(|v| ApproverView { id: v.user_id, username: v.username.clone(), online: state.sessions.contains_key(&v.user_id) }).collect())
        } else {
            None
        },
        my_vote: mine.map(|v| vote_str(v.vote)),
        you: mine.map(|v| YouView { had_camera: v.had_camera, had_share: v.had_share, still_in_call }),
    }
}

// ---- rate limiting --------------------------------------------------------------

/// None = allowed; Some(retry_after_ms) = refused.
fn check_rate(state: &AppState, user: UserId, voice_channel_id: i64) -> Option<i64> {
    let now = Instant::now();
    if let Some(d) = state.clip_denials.get(&(user, voice_channel_id)) {
        if now < d.until {
            return Some(d.until.duration_since(now).as_millis() as i64);
        }
    }
    let mut r = state.clip_rate.entry(user).or_insert(ClipRateState { window_start: now, count: 0 });
    if now.duration_since(r.window_start) > CLIP_RATE_WINDOW {
        r.window_start = now;
        r.count = 0;
    }
    if r.count >= CLIP_RATE_MAX {
        return Some((CLIP_RATE_WINDOW - now.duration_since(r.window_start)).as_millis() as i64);
    }
    r.count += 1;
    None
}

fn bump_denial(state: &AppState, user: UserId, voice_channel_id: i64) {
    let now = Instant::now();
    let mut d = state.clip_denials.entry((user, voice_channel_id)).or_insert(ClipDenial { count: 0, until: now, last: now });
    if now.duration_since(d.last) > CLIP_DENIAL_DECAY {
        d.count = 0;
    }
    let step = CLIP_DENIAL_STEPS_SECS[(d.count as usize).min(CLIP_DENIAL_STEPS_SECS.len() - 1)];
    d.count += 1;
    d.last = now;
    d.until = now + Duration::from_secs(step);
}

// ---- handlers ---------------------------------------------------------------------

/// POST /channels/:voice_channel_id/clips
pub async fn propose_clip(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(voice_channel_id): Path<i64>,
    Json(req): Json<ProposeClipRequest>,
) -> Response {
    let user = claims.sub;
    // 1. VIEW + CREATE_CLIPS on the voice channel (404 hides existence).
    let (server_id, perms) = match get_user_channel_permissions(&state.pool, voice_channel_id, user).await {
        ChannelPermAccess::Allowed { server_id, perms } => {
            if !perms.has(Permissions::VIEW_CHANNEL) { return plain(StatusCode::NOT_FOUND, "Channel not found"); }
            (server_id, perms)
        }
        ChannelPermAccess::NotFound => return plain(StatusCode::NOT_FOUND, "Channel not found"),
        ChannelPermAccess::NotMember => return plain(StatusCode::FORBIDDEN, "Not a member of this server"),
    };
    if !perms.has(Permissions::CREATE_CLIPS) {
        return plain(StatusCode::FORBIDDEN, "Missing Create Clips permission");
    }
    // 2. Server policy.
    let policy: Option<(bool, i32, Option<i32>)> = match sqlx::query_as("SELECT clips_enabled, clip_max_seconds, clip_channel_id FROM servers WHERE id = $1")
        .bind(&server_id).fetch_optional(&state.pool).await
    {
        Ok(v) => v,
        Err(e) => { tracing::error!("propose_clip: policy lookup failed: {e:?}"); return plain(StatusCode::INTERNAL_SERVER_ERROR, "Could not read the server's clip policy"); }
    };
    let Some((enabled, max_seconds, pinned)) = policy else { return plain(StatusCode::NOT_FOUND, "Server not found"); };
    if !enabled { return plain(StatusCode::CONFLICT, "Clips are turned off in this server"); }
    // 3. Proposer is in the voice room right now.
    let room_id = format!("voice_{voice_channel_id}");
    let in_room = state.rooms.get(&room_id).map(|r| r.members.contains(&user)).unwrap_or(false);
    if !in_room { return plain(StatusCode::CONFLICT, "You are not in that voice channel"); }
    // 4. Window sanity (explicit bounds even though the fields are unsigned).
    let duration_ms = req.duration_ms as i64;
    let ended_ago_ms = req.ended_ago_ms as i64;
    if duration_ms < MIN_CLIP_MS { return plain(StatusCode::BAD_REQUEST, "Clip too short"); }
    if duration_ms > (max_seconds as i64) * 1000 { return plain(StatusCode::BAD_REQUEST, "Clip longer than this server allows"); }
    if ended_ago_ms < 0 || ended_ago_ms > PresenceLog::MAX_ENDED_AGO_MS { return plain(StatusCode::BAD_REQUEST, "That clip ended too long ago to be posted"); }
    let now_ms = now_unix_ms();
    let end_ms = now_ms - ended_ago_ms;
    // Padded at the START only (inclusion-erring where a late-recorded join
    // could matter); padding the end would name people who arrived after the
    // clip ended.
    let start_ms = end_ms - duration_ms - PresenceLog::PAD_MS;
    // 5. Pinned channel + target channel checks. REQUIRED PIN (S1): a
    // clips-enabled server with no pinned channel predates the rule — new
    // clients (0.8.118+) already refuse to compose against it, and this 409
    // is the gate for OLD clients, whose per-clip picker would otherwise
    // post anywhere the proposer can send: the approval prompt names a
    // destination, and an unpinned server let the clipper change it after
    // everyone agreed. 409 rather than 400: the request is well-formed; the
    // SERVER's configuration is what cannot accept it yet.
    let Some(pin) = pinned else {
        return plain(
            StatusCode::CONFLICT,
            "This server has no clips channel yet — the owner needs to pick one in Server Settings before clips can be posted",
        );
    };
    if pin as i64 != req.target_channel_id { return plain(StatusCode::FORBIDDEN, "This server pins clips to one channel"); }
    let target_ok = match get_user_channel_permissions(&state.pool, req.target_channel_id, user).await {
        ChannelPermAccess::Allowed { server_id: tsid, perms: tperms } => {
            if !tperms.has(Permissions::VIEW_CHANNEL) { return plain(StatusCode::NOT_FOUND, "Target channel not found"); }
            if tsid != server_id { return plain(StatusCode::BAD_REQUEST, "The target channel must be in the same server as the voice channel"); }
            tperms.has(Permissions::SEND_MESSAGES)
        }
        ChannelPermAccess::NotFound => return plain(StatusCode::NOT_FOUND, "Target channel not found"),
        ChannelPermAccess::NotMember => return plain(StatusCode::FORBIDDEN, "Not a member of this server"),
    };
    if !target_ok { return plain(StatusCode::FORBIDDEN, "You cannot post in that channel"); }
    // The column is `type` (schema), NOT `channel_type` (the API field name) —
    // the same trap that returned 404 for every voice move once. Do not
    // `.unwrap_or(None)` a query error into "not found": log it and 500.
    let target_meta: Option<(i32, String)> = match sqlx::query_as("SELECT type, name FROM channels WHERE id = $1")
        .bind(req.target_channel_id as i32).fetch_optional(&state.pool).await
    {
        Ok(v) => v,
        Err(e) => { tracing::error!("propose_clip: target lookup failed: {e:?}"); return plain(StatusCode::INTERNAL_SERVER_ERROR, "Could not resolve the target channel"); }
    };
    let Some((ttype, target_name)) = target_meta else { return plain(StatusCode::NOT_FOUND, "Target channel not found"); };
    if ttype != 0 { return plain(StatusCode::BAD_REQUEST, "Clips can only be posted to a text channel"); }
    let voice_name: String = sqlx::query_scalar("SELECT name FROM channels WHERE id = $1")
        .bind(voice_channel_id as i32).fetch_optional(&state.pool).await.ok().flatten().unwrap_or_default();
    // 6. Rate limits: one live proposal per user, N per window, decline ladder.
    if state.clip_proposals.iter().any(|p| p.proposer == user && Instant::now() < p.expires) {
        return plain(StatusCode::CONFLICT, "You already have a clip waiting for approval");
    }
    if let Some(retry) = check_rate(&state, user, voice_channel_id) {
        return (StatusCode::TOO_MANY_REQUESTS, Json(RefusalWithData { error: "rate_limited", earliest_ms: None, retry_after_ms: Some(retry) })).into_response();
    }
    // 7. Approver set from the presence log ∪ declared, bounded by the
    //    proposer's OWN presence (a window before they joined would be a
    //    presence-history oracle, and empty by construction).
    let (log_hits, media, log_from, proposer_first, proposer_alone) = {
        let Some(room) = state.rooms.get(&room_id) else { return plain(StatusCode::CONFLICT, "You are not in that voice channel"); };
        let log = &room.presence_log;
        (
            log.overlapping(start_ms, end_ms),
            log.overlapping_media(start_ms, end_ms),
            log.observed_from_ms(),
            log.first_join_of(user),
            log.present_throughout(user, start_ms, end_ms),
        )
    };
    let earliest = proposer_first.map(|j| j.max(log_from)).unwrap_or(log_from);
    if start_ms < earliest {
        return (StatusCode::CONFLICT, Json(RefusalWithData { error: "window_predates_log", earliest_ms: Some(earliest), retry_after_ms: None })).into_response();
    }
    let viewers = match get_channel_viewer_ids(&state.pool, voice_channel_id, &server_id).await {
        Ok(v) => v,
        Err(_) => return plain(StatusCode::INTERNAL_SERVER_ERROR, "Could not resolve channel members"),
    };
    let ids = union_approvers(&log_hits, &req.declared_participants, &viewers, user);
    if ids.len() > CLIP_MAX_APPROVERS { return plain(StatusCode::BAD_REQUEST, "Too many people were in that call for a clip to be approved"); }
    // Zero approvers is allowed ONLY with positive attestation that the clipper
    // was alone for the whole window; "no data" must never read as "nobody".
    let solo = ids.is_empty();
    if solo && !proposer_alone {
        return (StatusCode::CONFLICT, Json(RefusalWithData { error: "window_predates_log", earliest_ms: Some(earliest), retry_after_ms: None })).into_response();
    }
    // FAIL CLOSED on a DB error. `unwrap_or_default()` here turned a transient
    // failure into an EMPTY approver list, and an empty list resolves with
    // nobody prompted — a multi-party clip published as though the clipper had
    // been alone. "No data" must never read as "nobody was there"; that is the
    // same rule the `solo && !proposer_alone` guard four lines up enforces.
    let names: Vec<(i32, String)> = if ids.is_empty() {
        Vec::new()
    } else {
        match sqlx::query_as("SELECT id, username FROM users WHERE id = ANY($1)")
            .bind(ids.iter().map(|&i| i as i32).collect::<Vec<i32>>())
            .fetch_all(&state.pool)
            .await
        {
            Ok(rows) => rows,
            Err(e) => {
                tracing::error!("propose_clip: approver lookup failed: {:?}", e);
                return plain(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Could not confirm who was in that call. Try again in a moment.",
                );
            }
        }
    };
    // Deleted accounts (no users row) are dropped — they can never consent.
    let votes: Vec<ClipVoter> = names.into_iter().map(|(id, username)| {
        let (cam, share) = media.get(&(id as i64)).copied().unwrap_or((false, false));
        ClipVoter { user_id: id as i64, username, vote: ClipVote::Pending, had_camera: cam, had_share: share }
    }).collect();
    if state.clip_proposals.len() >= CLIP_MAX_LIVE_PROPOSALS { return plain(StatusCode::SERVICE_UNAVAILABLE, "Too many clips are waiting for approval right now"); }
    let now = Instant::now();
    let clip_id = uuid::Uuid::new_v4().to_string();
    let solo = votes.is_empty();
    let proposal = ClipProposal {
        clip_id: clip_id.clone(), proposer: user, proposer_username: claims.username.clone(), server_id,
        voice_channel_id, voice_channel_name: voice_name, target_channel_id: req.target_channel_id, target_channel_name: target_name,
        window_start_ms: start_ms, window_end_ms: end_ms, duration_ms, votes, solo, created: now,
        expires: now + clip_proposal_ttl() + if solo { CLIP_UPLOAD_GRACE } else { Duration::ZERO },
        approved_at: if solo { Some(now) } else { None },
    };
    let resp = ProposeClipResponse {
        clip_id: clip_id.clone(),
        expires_in_ms: proposal.expires.saturating_duration_since(now).as_millis() as i64,
        approvers: proposal.votes.iter().map(|v| ApproverView { id: v.user_id, username: v.username.clone(), online: state.sessions.contains_key(&v.user_id) }).collect(),
        solo, resolved: solo, approved: solo,
    };
    notify_proposed(&state, &proposal);
    state.clip_proposals.insert(clip_id, proposal);
    (StatusCode::CREATED, Json(resp)).into_response()
}

/// POST /clips/:clip_id/vote — the voter is the authenticated caller, never a body field.
pub async fn vote_clip(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(clip_id): Path<String>,
    Json(req): Json<VoteRequest>,
) -> Response {
    let user = claims.sub;
    // Mutate under the entry lock; collect what to broadcast, then release.
    enum After { Vote(ClipProposal), Approved(ClipProposal), Declined(ClipProposal) }
    let (status, body, after) = {
        let Some(mut p) = state.clip_proposals.get_mut(&clip_id) else { return plain(StatusCode::NOT_FOUND, "No such clip request"); };
        if Instant::now() >= p.expires || !p.is_voter(user) {
            // Unknown, expired and not-listed are indistinguishable: no oracle.
            return plain(StatusCode::NOT_FOUND, "No such clip request");
        }
        let idx = p.votes.iter().position(|v| v.user_id == user).unwrap();
        if p.votes[idx].vote != ClipVote::Pending {
            return plain(StatusCode::CONFLICT, "You already answered — a vote is final");
        }
        if req.approve {
            p.votes[idx].vote = ClipVote::Approved;
            if p.all_approved() {
                p.approved_at = Some(Instant::now());
                p.expires = Instant::now() + CLIP_UPLOAD_GRACE;
                let snap = p.clone();
                (StatusCode::OK, VoteResponse { clip_id: clip_id.clone(), state: "approved", approved_count: snap.approved_count() as u32, total: snap.votes.len() as u32 }, After::Approved(snap))
            } else {
                let snap = p.clone();
                (StatusCode::OK, VoteResponse { clip_id: clip_id.clone(), state: "pending", approved_count: snap.approved_count() as u32, total: snap.votes.len() as u32 }, After::Vote(snap))
            }
        } else {
            p.votes[idx].vote = ClipVote::Declined;
            let snap = p.clone();
            (StatusCode::OK, VoteResponse { clip_id: clip_id.clone(), state: "declined", approved_count: snap.approved_count() as u32, total: snap.votes.len() as u32 }, After::Declined(snap))
        }
    };
    match after {
        After::Vote(p) => {
            state.send_to_user(p.proposer, ServerMessage::ClipVoteUpdate { clip_id: p.clip_id.clone(), approved_count: p.approved_count() as u32, total: p.votes.len() as u32 });
        }
        After::Approved(p) => {
            state.send_to_user(p.proposer, ServerMessage::ClipVoteUpdate { clip_id: p.clip_id.clone(), approved_count: p.approved_count() as u32, total: p.votes.len() as u32 });
            broadcast_resolved(&state, &p, ClipOutcome::Approved);
        }
        After::Declined(p) => {
            state.clip_proposals.remove(&p.clip_id);
            bump_denial(&state, p.proposer, p.voice_channel_id);
            broadcast_resolved(&state, &p, ClipOutcome::Declined);
        }
    }
    (status, Json(body)).into_response()
}

/// DELETE /clips/:clip_id — proposer only (else 404, no oracle).
pub async fn cancel_clip(State(state): State<Arc<AppState>>, Extension(claims): Extension<Claims>, Path(clip_id): Path<String>) -> Response {
    let removed = {
        let is_mine = state.clip_proposals.get(&clip_id).map(|p| p.proposer == claims.sub).unwrap_or(false);
        if !is_mine { return plain(StatusCode::NOT_FOUND, "No such clip request"); }
        state.clip_proposals.remove(&clip_id).map(|(_, p)| p)
    };
    if let Some(p) = removed { broadcast_resolved(&state, &p, ClipOutcome::Cancelled); }
    StatusCode::NO_CONTENT.into_response()
}

/// GET /clips/:clip_id — proposer or listed approver; everyone else 404.
pub async fn get_clip(State(state): State<Arc<AppState>>, Extension(claims): Extension<Claims>, Path(clip_id): Path<String>) -> Response {
    let Some(p) = live_proposal(&state, &clip_id) else { return plain(StatusCode::NOT_FOUND, "No such clip request"); };
    if p.proposer != claims.sub && !p.is_voter(claims.sub) { return plain(StatusCode::NOT_FOUND, "No such clip request"); }
    let view = view_for(&state, &p, claims.sub);
    Json(view).into_response()
}

#[derive(Serialize)]
pub struct PendingResponse {
    pub proposals: Vec<ClipView>,
}

/// GET /clips/pending — every live proposal the caller is proposer or approver
/// of. Mandatory reconciliation path: the undelivered queue drops oldest at its
/// cap, so a doorbell can legitimately be lost.
pub async fn list_pending_clips(State(state): State<Arc<AppState>>, Extension(claims): Extension<Claims>) -> Response {
    let now = Instant::now();
    let proposals: Vec<ClipView> = state.clip_proposals.iter()
        .filter(|p| now < p.expires && (p.proposer == claims.sub || p.is_voter(claims.sub)))
        .map(|p| view_for(&state, &p, claims.sub))
        .collect();
    Json(PendingResponse { proposals }).into_response()
}

// ---- lifecycle -------------------------------------------------------------------

/// The proposer's last visible connection went away (ws.rs disconnect path):
/// D2 says the clipper quitting discards the clip, so every live proposal of
/// theirs is cancelled and its approvers' prompts close.
pub fn cancel_proposals_of(state: &Arc<AppState>, user: UserId) {
    let ids: Vec<String> = state.clip_proposals.iter().filter(|p| p.proposer == user).map(|p| p.clip_id.clone()).collect();
    for id in ids {
        if let Some((_, p)) = state.clip_proposals.remove(&id) {
            broadcast_resolved(state, &p, ClipOutcome::Cancelled);
        }
    }
}

/// Periodic sweep (main.rs, 60 s): expire proposals (collect first, notify after
/// — never send while iterating a shard), prune rate/denial maps, prune every
/// presence log, drop expired orphan logs. `now`/`now_ms` are test seams; a test
/// shifts them FORWARD (rewinding a real Instant panics on a fresh boot).
pub fn reap_stale_clips_at(state: &Arc<AppState>, now: Instant, now_ms: i64) {
    let expired: Vec<String> = state.clip_proposals.iter().filter(|p| now >= p.expires).map(|p| p.clip_id.clone()).collect();
    for id in expired {
        if let Some((_, p)) = state.clip_proposals.remove(&id) {
            broadcast_resolved(state, &p, ClipOutcome::Expired);
        }
    }
    state.clip_rate.retain(|_, r| now.duration_since(r.window_start) <= CLIP_RATE_WINDOW);
    state.clip_denials.retain(|_, d| now.duration_since(d.last) <= CLIP_DENIAL_DECAY);
    for mut room in state.rooms.iter_mut() {
        room.presence_log.prune_at(now_ms);
    }
    state.orphan_presence_logs.retain(|_, log| { log.prune_at(now_ms); !log.is_expired_at(now_ms) });
}

pub fn reap_stale_clips(state: &Arc<AppState>) {
    reap_stale_clips_at(state, Instant::now(), now_unix_ms());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(v: &[i64]) -> HashSet<UserId> { v.iter().copied().collect() }

    #[test]
    fn union_adds_declared_co_members_and_never_removes_log_hits() {
        let viewers = set(&[1, 2, 3, 4, 5]);
        // log saw 2 and 3; client declares 3 and 4 (a co-member the log missed) and 99 (a stranger)
        let out = union_approvers(&set(&[2, 3]), &[3, 4, 99], &viewers, 1);
        assert_eq!(out, vec![2, 3, 4]);
    }

    #[test]
    fn union_removes_the_proposer_and_dedupes() {
        let viewers = set(&[1, 2]);
        assert_eq!(union_approvers(&set(&[1, 2]), &[2, 2, 1], &viewers, 1), vec![2]);
    }

    #[test]
    fn a_declared_list_cannot_shrink_the_set_and_is_filtered_to_viewers() {
        let viewers = set(&[1, 2, 3]);
        // declaring nobody still yields the log's people
        assert_eq!(union_approvers(&set(&[2, 3]), &[], &viewers, 1), vec![2, 3]);
        // declaring only strangers adds nothing
        assert_eq!(union_approvers(&set(&[2]), &[7, 8, 9], &viewers, 1), vec![2]);
    }

    #[test]
    fn declared_is_capped_at_the_maximum() {
        let viewers: HashSet<UserId> = (1..=200).collect();
        let declared: Vec<UserId> = (2..=200).collect();
        let out = union_approvers(&set(&[]), &declared, &viewers, 1);
        assert_eq!(out.len(), CLIP_MAX_DECLARED); // only the first 64 declared are even considered
    }

    #[test]
    fn empty_everything_is_empty_not_a_panic() {
        assert!(union_approvers(&set(&[]), &[], &set(&[]), 1).is_empty());
    }

    #[test]
    fn retention_covers_the_reachable_window() {
        // A proposal may reach MAX_ENDED_AGO + MAX_CLIP + PAD into the past; the
        // log must remember at least that much or the approver set silently
        // shrinks to the client's declared list.
        assert!(PresenceLog::RETENTION_MS > PresenceLog::MAX_ENDED_AGO_MS + PresenceLog::MAX_CLIP_MS + PresenceLog::PAD_MS);
    }
}
