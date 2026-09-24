use crate::state::{AppState, UserId};
use axum::{
    extract::{Request, State},
    http::{header, StatusCode},
    middleware::Next,
    response::Response,
};
use chrono::Utc;
use jsonwebtoken::{decode, DecodingKey, Validation};
use serde::{Deserialize, Serialize};
use srp::groups::G_2048;
use std::sync::Arc;

// Re-export for use in handlers
#[allow(dead_code)]
pub type SrpGroup = G_2048;

/// JWT claims structure
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Claims {
    pub sub: UserId, // User ID
    pub username: String,
    pub exp: i64, // Expiration timestamp
    /// Token version (M1 revocation). Compared against users.token_version on
    /// every authenticated request; a mismatch rejects the token. `#[serde(default)]`
    /// so pre-migration tokens (no `tv`) decode as 0 and keep working until a
    /// revocation event bumps the user's counter.
    #[serde(default)]
    pub tv: i32,
    /// Session start (unix seconds) — when the user last actually
    /// authenticated. Preserved across sliding renewals so a session can only
    /// slide for `MAX_SESSION_DAYS` before real re-authentication is required,
    /// and every token minted for the session expires by `sst` + that cap
    /// (`token_exp_at`), so the last renewal cannot carry it past the cap.
    /// `#[serde(default)]`: tokens minted before this claim existed decode as
    /// 0 and start their clock at first renewal rather than being refused.
    #[serde(default)]
    pub sst: i64,
    /// Session id (one per sign-in, one per device token). `tv` is per USER
    /// and cannot revoke one device; this can: revoking a device marks the
    /// sessions it PROVED (token_sessions.device_id, set by DeviceAttest or
    /// the device-token mint, never by a client claim), signing out one
    /// session marks that row, and the middleware + WebSocket upgrade refuse
    /// a token whose sid is revoked, or is bound to a revoked device, while
    /// every other session keeps working. `#[serde(default)]`: tokens
    /// minted before the claim decode as "" and stay accepted (no row can be
    /// revoked for them); their first sliding renewal mints one.
    #[serde(default)]
    pub sid: String,
    /// Long session — the user ticked "Stay signed in on this device" at the
    /// sign-in form. It changes two numbers and nothing else: the token's own
    /// lifetime (`LONG_TOKEN_TTL_DAYS` instead of `TOKEN_TTL_HOURS`) and the
    /// absolute cap renewal is measured against (`LONG_MAX_SESSION_DAYS`
    /// instead of `MAX_SESSION_DAYS`). Carried forward by every renewal, so
    /// the choice survives without a database column.
    ///
    /// REVOCATION IS UNCHANGED, and that is what makes the longer lifetime
    /// acceptable: signing out locally drops the token; `POST
    /// /auth/logout-session` revokes this one `sid` (checked on every request
    /// and on the WebSocket upgrade); revoking the device revokes the sessions
    /// it proved; and "sign out everywhere", a password change or a recovery
    /// reset bump `users.token_version`, which kills every outstanding token
    /// for the account instantly. An already-EXPIRED long token is never
    /// renewed either: `validate_token` refuses it once it is more than
    /// jsonwebtoken's 60 s clock-skew leeway past `exp`, and `renew_if_stale`
    /// refuses it inside that minute (`claims.exp <= now`).
    ///
    /// `#[serde(default)]` so every token minted before this claim existed
    /// decodes as `false` and keeps its old 24-hour behaviour exactly.
    #[serde(default)]
    pub ls: bool,
}

/// Lifetime of a freshly minted token.
pub const TOKEN_TTL_HOURS: i64 = 24;
/// Renew once the token is more than a few hours old. Any authenticated
/// request past that point silently extends the session.
///
/// WAS 12 (renew only in the last half of the token's life), and that window
/// was too narrow to catch ordinary use. A session renews only if a request
/// happens to land between 12 and 24 hours after the token was minted, so
/// someone who opens the app once a day, at a slightly earlier hour than
/// yesterday, never enters the window and is signed out roughly daily —
/// despite using the app every single day. Measured on the live server: of
/// nine accounts, four had ZERO renewals in a week, and the reported symptom
/// was "it keeps logging me out."
///
/// Widening it does not lengthen how long a stolen token stays usable. That
/// ceiling is `MAX_SESSION_DAYS`, enforced against `sst` (the real sign-in
/// time, which renewal carries forward and cannot reset): renewal stops at
/// it and every minted token's exp is clamped to it (`token_exp_at`). And
/// revocation is unaffected either way because `token_version` is re-checked
/// on every single request. All this changes is how much ordinary use it takes to stay signed
/// in: now any request more than four hours after the last mint.
const RENEW_WHEN_REMAINING_HOURS: i64 = 20;
/// A sliding session still ends: after this long since the user actually
/// signed in, renewal stops and they must authenticate again.
const MAX_SESSION_DAYS: i64 = 30;

/// Lifetime of a freshly minted LONG token ("Stay signed in on this device").
///
/// The renewal cadence above only helps someone who uses the app. A device
/// that is switched off, or a browser tab closed, for longer than the token's
/// own lifetime comes back to the sign-in form no matter how wide the window
/// is — which is the whole complaint about Púca Notes on a phone: a day away
/// and the notes are behind a password again. So the opt-in moves the
/// LIFETIME, not the window: a month of silence is fine, and ordinary use
/// still slides it forward.
pub const LONG_TOKEN_TTL_DAYS: i64 = 30;
/// ...and a long session still ends. A year after the real sign-in, renewal
/// stops and the password is asked for again.
const LONG_MAX_SESSION_DAYS: i64 = 365;
/// How old a token must be before a request renews it — ONE cadence for both
/// kinds, derived from the numbers above rather than restated, so a normal
/// session keeps exactly the behaviour it has today (24 h TTL, renew below
/// 20 h remaining = renew once four hours old) and a long one renews on the
/// same four-hour rhythm against its own 30-day TTL.
const RENEW_AFTER_AGE_HOURS: i64 = TOKEN_TTL_HOURS - RENEW_WHEN_REMAINING_HOURS;

/// The token's full lifetime in seconds, by kind. The ONE place either TTL is
/// turned into a duration — `create_token_with_start` mints against it and
/// `renew_if_stale` measures against it, so the two cannot drift.
pub fn token_ttl_secs(long: bool) -> i64 {
    if long {
        LONG_TOKEN_TTL_DAYS * 86_400
    } else {
        TOKEN_TTL_HOURS * 3600
    }
}

/// The absolute session cap in seconds, by kind: how long after the real
/// sign-in (`sst`) a session may last at all. The ONE place either cap is
/// turned into a duration — `renew_if_stale` stops renewing against it and
/// `token_exp_at` clamps every minted token to it.
pub fn session_cap_secs(long: bool) -> i64 {
    if long {
        LONG_MAX_SESSION_DAYS * 86_400
    } else {
        MAX_SESSION_DAYS * 86_400
    }
}

/// The `exp` a token minted at `now` gets: a full TTL, but never past the
/// session's cap. Without the clamp a renewal a day before the one-year cap
/// minted a fresh 30-day token, so "a year" was up to 395 days (and an
/// ordinary session's 30 days up to 31): the cap stopped RENEWAL but not
/// VALIDITY, and `validate_token` never looks at `sst`. `session_start == 0`
/// is a pre-`sst` token's "no start recorded", which is never clamped.
pub fn token_exp_at(now: i64, session_start: i64, long: bool) -> i64 {
    let full = now + token_ttl_secs(long);
    if session_start > 0 {
        full.min(session_start + session_cap_secs(long))
    } else {
        full
    }
}
/// Should this request log that its session has no row? Once per sid.
///
/// A row-less session (minted by a release that returned the token even when
/// its row's INSERT failed) is refused renewal on EVERY request once its token
/// is RENEW_AFTER_AGE_HOURS old, and nothing is written that would stop the
/// next request finding the same thing. Logging each time would put a warning
/// in the log per request for as long as the token lives (up to 30 days for a
/// long session). One line per session says the same thing. `seen` is bounded:
/// at `cap` it starts over, which at worst repeats a line, never grows.
fn note_rowless(seen: &mut std::collections::HashSet<String>, sid: &str, cap: usize) -> bool {
    if seen.contains(sid) {
        return false;
    }
    if seen.len() >= cap {
        seen.clear();
    }
    seen.insert(sid.to_string())
}

/// The process's `note_rowless` record.
fn first_rowless_report(sid: &str) -> bool {
    static SEEN: std::sync::Mutex<Option<std::collections::HashSet<String>>> = std::sync::Mutex::new(None);
    let mut guard = SEEN.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    note_rowless(guard.get_or_insert_with(Default::default), sid, 4096)
}

/// Response header carrying a renewed token. Must be in the CORS
/// `expose_headers` list or browsers can't read it cross-origin.
pub const RENEWED_TOKEN_HEADER: &str = "x-renewed-token";

/// Mint a replacement token when the current one is running out, so users stop
/// being dumped at the login screen every 24 h.
///
/// Safe against the obvious abuse: this runs only AFTER the caller's token has
/// been validated and its `tv` matched against the live `users.token_version`,
/// and the new token carries that same `tv` — so anything that bumps that
/// counter kills every renewed token instantly. Account-wide revocation is a
/// password change, a recovery reset or "sign out everywhere" (all three bump
/// it); in-app "Sign out" revokes THIS session by its `sid` (`logout_session`)
/// and leaves the account's other devices alone — the note that once stood
/// here, saying sign-out was local-only because there was no per-session
/// claim, predates `sid`. `sst` bounds how long a stolen-but-unrevoked token
/// can keep renewing itself in the meantime, against `MAX_SESSION_DAYS` or,
/// for a long session, `LONG_MAX_SESSION_DAYS` — and the replacement's exp
/// is clamped to that same cap, so the session ends AT it, not a TTL later.
///
/// Returns `None` (no new token, and so no session-row write) when the token
/// is already expired — even inside the 60 s leeway `validate_token` allows —
/// when it is young, when the session is past its cap, and when a renewal
/// could not push exp any later (the clamped last stretch before the cap).
pub fn renew_if_stale(claims: &Claims, sid: &str, secret: &str) -> Option<String> {
    let now = Utc::now().timestamp();
    // An expired token is never renewed. `validate_token` alone does not
    // guarantee that: jsonwebtoken's default 60 s leeway ACCEPTS a token up to
    // a minute past its exp (clock-skew tolerance between the two hosts, kept
    // for acceptance on purpose), and without this line such a token reached
    // here and was slid forward by a whole TTL.
    if claims.exp <= now {
        return None;
    }
    // Renew once the token is RENEW_AFTER_AGE_HOURS into its own life. For an
    // ordinary token that is "remaining < 20 h of 24", byte for byte what it
    // has always been; for a long one, "remaining < 30 days minus 4 h".
    if claims.exp - now > token_ttl_secs(claims.ls) - RENEW_AFTER_AGE_HOURS * 3600 {
        return None; // plenty of life left
    }
    let started = if claims.sst > 0 { claims.sst } else { now };
    if now - started > session_cap_secs(claims.ls) {
        return None; // session too old to slide — require a real sign-in
    }
    // In the last TTL before the cap the replacement is clamped to the cap
    // (`token_exp_at`), so once one renewal has reached it there is nothing
    // left to extend. Without this every request past the four-hour mark
    // would re-mint the same exp and write token_sessions.last_seen_at — a
    // database write per request for the final month of a long session.
    if token_exp_at(now, started, claims.ls) <= claims.exp {
        return None;
    }
    // `claims.ls` carries the choice forward: the flag lives in the token, so
    // a renewal is the only thing that can keep it alive, and losing it here
    // would quietly demote a long session to 24 hours at its first renewal.
    crate::ws::create_token_with_start(claims.sub, &claims.username, claims.tv, started, sid, claims.ls, secret)
        .ok()
}

/// Is this token still good: the user's token_version matches AND, when the
/// token carries a session id, that session has not been revoked — and, when
/// that session is BOUND to a device, the device has not been revoked either.
/// ONE query (the middleware runs on every request): LEFT JOINs, so a legacy
/// token with no sid, or a sid with no row, is judged on token_version alone,
/// and an ordinary sign-in (no `device_id`) is never judged by a device.
///
/// WHY THE DEVICE, and not just the session row. `revoke_device` marks the
/// rows bound to the device, but a row written by a mint that raced the revoke
/// could land after that sweep: the device-token mint read the device as live,
/// the revoke swept, then the mint's INSERT arrived with `revoked_at` NULL.
/// This check read only that row, so the session was accepted on every request
/// and renewed into a 24 h token sliding for 30 days — for a device its owner
/// had revoked and could no longer see to revoke again. The mint and the
/// revoke now close that race between themselves (`INSERT_DEVICE_SESSION`,
/// `revoke_device`); this is the check that does not depend on them getting
/// the timing right, and it also covers the WS `DeviceAttest` binding, which
/// has the same read-then-write shape. A revoked device stays revoked (nothing
/// clears `devices.revoked_at`), so refusing its sessions forever is correct.
/// A binding to a device row that is GONE fails closed too: device rows are
/// never hard-deleted outside the account's own cascade, so there is nothing
/// left that could vouch for it.
pub async fn token_session_live(pool: &sqlx::PgPool, claims: &Claims) -> Result<bool, sqlx::Error> {
    let row: Option<(i32, bool)> = sqlx::query_as(
        "SELECT u.token_version, \
                COALESCE(s.revoked_at IS NOT NULL, false) \
                OR (s.device_id IS NOT NULL AND (d.id IS NULL OR d.revoked_at IS NOT NULL)) \
         FROM users u \
         LEFT JOIN token_sessions s ON s.sid = $2 AND s.user_id = u.id \
         LEFT JOIN devices d ON d.id = s.device_id \
         WHERE u.id = $1",
    )
    .bind(claims.sub as i32)
    .bind(&claims.sid)
    .fetch_optional(pool)
    .await?;
    Ok(matches!(row, Some((tv, false)) if tv == claims.tv))
}

#[allow(dead_code)]
#[derive(Debug, Deserialize)]
pub struct RegisterRequest {
    pub username: String,
    pub salt: String,     // Hex encoded
    pub verifier: String, // Hex encoded
}

#[allow(dead_code)]
#[derive(Debug, Deserialize)]
pub struct LoginStartRequest {
    pub username: String,
    pub a_pub: String, // Hex encoded
}

#[allow(dead_code)]
#[derive(Debug, Serialize)]
pub struct LoginStartResponse {
    pub salt: String,  // Hex encoded
    pub b_pub: String, // Hex encoded
}

#[allow(dead_code)]
#[derive(Debug, Deserialize)]
pub struct LoginFinishRequest {
    pub username: String,
    pub m1: String, // Hex encoded
}

#[allow(dead_code)]
#[derive(Debug, Serialize)]
pub struct LoginFinishResponse {
    pub m2: String, // Hex encoded
    pub session_token: String,
}

// Helper to decode hex
#[allow(dead_code)]
pub fn decode_hex(s: &str) -> anyhow::Result<Vec<u8>> {
    hex::decode(s).map_err(|e| anyhow::anyhow!("Hex decode error: {}", e))
}

// Helper to encode hex
#[allow(dead_code)]
pub fn encode_hex(b: &[u8]) -> String {
    hex::encode(b)
}

/// Validate JWT token and extract claims
pub fn validate_token(token: &str, secret: &str) -> Result<Claims, String> {
    let key = DecodingKey::from_secret(secret.as_bytes());
    let validation = Validation::default();

    decode::<Claims>(token, &key, &validation)
        .map(|data| data.claims)
        .map_err(|e| format!("Token validation failed: {}", e))
}

/// JWT Auth middleware - extracts claims from Authorization header and adds to request extensions
pub async fn jwt_auth_middleware(
    State(state): State<Arc<AppState>>,
    mut request: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    // Get Authorization header
    let auth_header = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok());

    let token = match auth_header {
        Some(header) if header.starts_with("Bearer ") => &header[7..],
        _ => return Err(StatusCode::UNAUTHORIZED),
    };

    // Validate token
    let claims = validate_token(token, &state.jwt_secret).map_err(|_| StatusCode::UNAUTHORIZED)?;

    // M1 revocation: reject a token whose `tv` no longer matches the user's
    // current token_version (bumped on logout / password change / recovery
    // reset), and reject tokens for a user that no longer exists.
    // ...and reject a token whose SESSION was revoked (device revoked, or this
    // one session signed out) while the user's other sessions live on.
    match token_session_live(&state.pool, &claims).await {
        Ok(true) => {}
        Ok(false) => return Err(StatusCode::UNAUTHORIZED),
        Err(_) => return Err(StatusCode::INTERNAL_SERVER_ERROR),
    }

    // Sliding session: hand back a fresh token once this one is past halfway.
    // Computed before `claims` moves into the extensions. A legacy token (no
    // sid) is given one here, with its row, so revocation reaches it from now.
    let renew_sid = if claims.sid.is_empty() { uuid::Uuid::new_v4().to_string() } else { claims.sid.clone() };
    let mut renewed = renew_if_stale(&claims, &renew_sid, &state.jwt_secret);
    if renewed.is_some() {
        let recorded = if claims.sid.is_empty() {
            sqlx::query("INSERT INTO token_sessions (sid, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING")
                .bind(&renew_sid).bind(claims.sub as i32).execute(&state.pool).await
                .map(|_| true)
        } else {
            // Matching NO row is a failure too, not a success: a sid-bearing
            // token whose row does not exist is a session nothing per-session
            // can revoke, and sliding it would keep it alive for up to a year.
            // Both mint sites now refuse to issue a token without its row, so
            // this only stops a session minted row-less by an older release.
            // Not an upsert: a recreated row would lose device_id and headless.
            sqlx::query("UPDATE token_sessions SET last_seen_at = NOW() WHERE sid = $1")
                .bind(&renew_sid).execute(&state.pool).await
                .map(|done| done.rows_affected() > 0)
        };
        match recorded {
            Ok(true) => {}
            Ok(false) => {
                if first_rowless_report(&renew_sid) {
                    tracing::warn!("renewal: session of user {} has no row — not renewing (said once per session)", claims.sub);
                }
                renewed = None;
            }
            Err(e) => {
                // A renewed token whose session row could not be written would be
                // a live session nothing can revoke. Keep the caller on its current
                // token instead (it still expires on its own clock) and try again
                // on a later request.
                tracing::warn!("renewal: could not record session for user {}: {:?} — not renewing", claims.sub, e);
                renewed = None;
            }
        }
    }
    let user_id = claims.sub;

    // Add claims to request extensions
    request.extensions_mut().insert(claims);

    let mut response = next.run(request).await;
    if let Some(token) = renewed {
        if let Ok(value) = header::HeaderValue::from_str(&token) {
            response.headers_mut().insert(RENEWED_TOKEN_HEADER, value);
            // This response now carries a bearer credential. Forbid ANY shared
            // cache (CDN, proxy, browser) from storing it — a cached copy would
            // hand one user's session token to whoever got the cache hit.
            response.headers_mut().insert(
                header::CACHE_CONTROL,
                header::HeaderValue::from_static("no-store, private"),
            );
            // Operationally important: this is what stops sessions dying at
            // 24 h. No token material is logged — just that it happened.
            tracing::info!("issued a renewed session token for user {}", user_id);
        }
    }
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "test-secret-for-renewal-rules";

    /// A row-less session is refused renewal on every request past the 4 h
    /// mark; the warning must not repeat with it. A local set, not the
    /// process's, so the cap can be exercised without racing other tests.
    #[test]
    fn a_rowless_session_is_reported_once_not_on_every_request() {
        let mut seen = std::collections::HashSet::new();
        assert!(note_rowless(&mut seen, "sid-a", 3), "positive control: the first request of a session is reported");
        assert!(!note_rowless(&mut seen, "sid-a", 3), "the same session's next request logs nothing");
        assert!(!note_rowless(&mut seen, "sid-a", 3), "nor the one after");
        assert!(note_rowless(&mut seen, "sid-b", 3), "a different session is still reported");
        assert!(note_rowless(&mut seen, "sid-c", 3));
        // Bounded: at the cap the record starts over rather than growing.
        assert!(note_rowless(&mut seen, "sid-d", 3), "a new session past the cap is reported");
        assert!(seen.len() <= 3, "the record never exceeds its cap ({} entries)", seen.len());
    }

    fn claims_with(exp_offset_secs: i64, sst: i64) -> Claims {
        claims_of_kind(exp_offset_secs, sst, false)
    }

    /// The same, for a LONG session (`ls: true`). Separate entry point on
    /// purpose: every test above still builds an ordinary token through
    /// `claims_with`, so they remain the positive control that the long
    /// session changed nothing for everybody else.
    fn long_claims_with(exp_offset_secs: i64, sst: i64) -> Claims {
        claims_of_kind(exp_offset_secs, sst, true)
    }

    fn claims_of_kind(exp_offset_secs: i64, sst: i64, ls: bool) -> Claims {
        Claims {
            sub: 7,
            username: "tester".to_string(),
            exp: Utc::now().timestamp() + exp_offset_secs,
            tv: 3,
            sst,
            sid: String::new(),
            ls,
        }
    }

    #[test]
    fn does_not_renew_while_plenty_of_life_remains() {
        // Freshly issued (24h left) — renewing on every request would mint a
        // JWT per call for no benefit.
        let c = claims_with(TOKEN_TTL_HOURS * 3600, Utc::now().timestamp());
        assert!(renew_if_stale(&c, &c.sid, SECRET).is_none());
    }

    #[test]
    fn renews_once_past_halfway() {
        // 1h left: without this the session dies and the user is dumped at the
        // login screen — the whole bug this fixes.
        let now = Utc::now().timestamp();
        let c = claims_with(3600, now);
        let renewed = renew_if_stale(&c, &c.sid, SECRET).expect("should renew");
        let out = validate_token(&renewed, SECRET).expect("renewed token must verify");
        assert_eq!(out.sub, c.sub);
        assert_eq!(out.tv, c.tv, "revocation counter must carry over");
        assert_eq!(
            out.sst, now,
            "session start must NOT reset, or the cap never bites"
        );
        assert!(out.exp > c.exp, "renewal must actually extend expiry");
    }

    #[test]
    fn renews_for_a_user_who_opens_the_app_daily_at_a_drifting_hour() {
        // THE REPORTED BUG. With the old 12-hour window, a token 8 hours old
        // (16 remaining) did NOT renew — so someone who opens the app each day
        // slightly earlier than the day before never lands inside the window
        // and is signed out roughly daily, despite daily use. Four of nine live
        // accounts had zero renewals in a week.
        //
        // Deliberately asserted at 16h remaining rather than "past the
        // constant": pinning the behaviour rather than restating the threshold
        // means narrowing the window back would fail this test instead of
        // quietly moving with it.
        let now = Utc::now().timestamp();
        let c = claims_with(16 * 3600, now);
        let renewed = renew_if_stale(&c, &c.sid, SECRET).expect("a token 8h into its life must renew");
        let out = validate_token(&renewed, SECRET).expect("renewed token must verify");
        assert!(out.exp > c.exp, "renewal must extend expiry");
        assert_eq!(
            out.sst, now,
            "widening the window must NOT reset the session start, or the 30-day cap never bites",
        );
    }

    #[test]
    fn stops_renewing_past_the_absolute_session_cap() {
        // Slid for longer than MAX_SESSION_DAYS: require a real sign-in, so a
        // stolen-but-unrevoked token can't renew itself forever.
        let old_start = Utc::now().timestamp() - (MAX_SESSION_DAYS * 86_400 + 60);
        let c = claims_with(3600, old_start);
        assert!(renew_if_stale(&c, &c.sid, SECRET).is_none());
    }

    #[test]
    fn legacy_token_without_sst_starts_its_clock_now() {
        // Tokens minted before the `sst` claim existed decode as 0. They must
        // renew (not be locked out) AND come back stamped, so the cap applies
        // from here rather than never.
        let c = claims_with(3600, 0);
        let renewed = renew_if_stale(&c, &c.sid, SECRET).expect("legacy token should renew");
        let out = validate_token(&renewed, SECRET).unwrap();
        assert!(out.sst > 0, "renewal must stamp a session start");
    }

    #[test]
    fn expired_tokens_are_rejected_before_renewal_is_ever_considered() {
        // Defence in depth: renew_if_stale is only reached AFTER validate_token
        // in the middleware, so an already-expired token can never be slid
        // forward — it must fail validation outright. (Well past the 60 s
        // clock-skew leeway jsonwebtoken's Validation::default() allows;
        // INSIDE that minute validation passes and renew_if_stale itself
        // refuses — see a_token_inside_the_skew_leeway_after_expiry_
        // validates_but_is_not_renewed.)
        let c = claims_with(-3600, Utc::now().timestamp() - 7200);
        let token = jsonwebtoken::encode(
            &jsonwebtoken::Header::default(),
            &c,
            &jsonwebtoken::EncodingKey::from_secret(SECRET.as_bytes()),
        )
        .unwrap();
        assert!(
            validate_token(&token, SECRET).is_err(),
            "expired token must not validate"
        );
    }

    // ---- "Stay signed in on this device" (Claims::ls) ----------------------
    //
    // The six tests above are the NEGATIVE CONTROL for these: they build their
    // claims through `claims_with`, which is `ls: false`, and they are
    // unchanged. If anything below leaked into the ordinary path — a wider
    // renewal window, a longer TTL, a looser cap — they would go red.

    #[test]
    fn a_long_session_token_is_minted_for_thirty_days_and_says_so() {
        // The whole point of the feature: the LIFETIME moves, so a phone that
        // was off for a week still opens Notes without the password. A minted
        // ordinary token is checked alongside, in the same test, so "30 days"
        // cannot silently become the answer for everyone.
        let now = Utc::now().timestamp();
        let long = crate::ws::create_token_with_start(7, "alice", 3, now, "sid-l", true, SECRET).unwrap();
        let long = validate_token(&long, SECRET).expect("long token must verify");
        assert!(long.ls, "the claim must record the choice, or renewal cannot carry it");
        let long_days = (long.exp - now) as f64 / 86_400.0;
        assert!(
            (LONG_TOKEN_TTL_DAYS as f64 - long_days).abs() < 0.01,
            "a long token must live {LONG_TOKEN_TTL_DAYS} days, got {long_days}",
        );

        let normal = crate::ws::create_token_with_start(7, "alice", 3, now, "sid-n", false, SECRET).unwrap();
        let normal = validate_token(&normal, SECRET).expect("ordinary token must verify");
        assert!(!normal.ls);
        let normal_hours = (normal.exp - now) as f64 / 3600.0;
        assert!(
            (TOKEN_TTL_HOURS as f64 - normal_hours).abs() < 0.01,
            "an ordinary token must still live {TOKEN_TTL_HOURS} hours, got {normal_hours}",
        );
    }

    #[test]
    fn a_long_session_renews_on_the_same_four_hour_cadence_and_keeps_its_flag() {
        // Four hours into its 30 days. The cadence is expressed against the
        // token's OWN ttl, so this is the same rhythm an ordinary session has
        // — not "renew only in the last four hours of a month", which would
        // let a fortnightly user's session die with two weeks left on it.
        let now = Utc::now().timestamp();
        let four_hours_old = LONG_TOKEN_TTL_DAYS * 86_400 - 4 * 3600 - 60;
        let c = long_claims_with(four_hours_old, now);
        let renewed = renew_if_stale(&c, &c.sid, SECRET).expect("a long token 4h into its life must renew");
        let out = validate_token(&renewed, SECRET).expect("renewed token must verify");
        assert!(out.ls, "the long-session flag must carry forward, or the first renewal demotes it to 24h");
        assert_eq!(out.tv, c.tv, "revocation counter must carry over");
        assert_eq!(out.sst, now, "session start must NOT reset, or the one-year cap never bites");
        let days_left = (out.exp - now) as f64 / 86_400.0;
        assert!((LONG_TOKEN_TTL_DAYS as f64 - days_left).abs() < 0.01, "renewal must mint another full 30 days, got {days_left}");
    }

    #[test]
    fn a_long_session_younger_than_four_hours_is_not_renewed() {
        // Minting a JWT on every request for a month-long token would be pure
        // waste; and without this the test above could pass by renewing
        // unconditionally.
        let now = Utc::now().timestamp();
        let c = long_claims_with(LONG_TOKEN_TTL_DAYS * 86_400 - 3600, now); // 1h old
        assert!(renew_if_stale(&c, &c.sid, SECRET).is_none());
    }

    #[test]
    fn a_long_session_stops_renewing_a_year_after_the_real_sign_in() {
        // It is a long session, not a permanent one: past the cap the password
        // is asked for again. Asserted just either side of the boundary so a
        // cap that was quietly removed (or set to i64::MAX) fails here.
        let now = Utc::now().timestamp();
        let inside = long_claims_with(3600, now - (LONG_MAX_SESSION_DAYS * 86_400 - 86_400));
        let renewed = renew_if_stale(&inside, &inside.sid, SECRET).expect("a day short of the cap still renews");
        let out = validate_token(&renewed, SECRET).unwrap();
        assert!(out.exp <= out.sst + LONG_MAX_SESSION_DAYS * 86_400, "...but only up to the cap");
        let past = long_claims_with(3600, now - (LONG_MAX_SESSION_DAYS * 86_400 + 60));
        assert!(renew_if_stale(&past, &past.sid, SECRET).is_none(), "past the cap, renewal must stop");
    }

    #[test]
    fn at_thirty_one_days_the_two_caps_disagree_and_that_is_the_whole_point() {
        // One session start, two kinds of token: the ordinary one is past its
        // 30-day cap and must stop, the long one is nowhere near 365 and must
        // keep going. If `ls` were ignored when the cap is chosen, one of
        // these two assertions fails whichever way it went.
        let started = Utc::now().timestamp() - (MAX_SESSION_DAYS * 86_400 + 86_400);
        let ordinary = claims_with(3600, started);
        assert!(renew_if_stale(&ordinary, &ordinary.sid, SECRET).is_none(), "31 days is past the ordinary cap");
        let long = long_claims_with(3600, started);
        assert!(renew_if_stale(&long, &long.sid, SECRET).is_some(), "31 days is well inside the long cap");
    }

    #[test]
    fn an_expired_long_token_is_refused_outright_and_never_renewed() {
        // A month is long enough that "expired" will genuinely happen. The
        // middleware validates before it renews, so an expired long token is
        // an expired token — it cannot be slid forward by an hour or a month.
        // (The minute of leeway before validation refuses it is covered by
        // a_token_inside_the_skew_leeway_after_expiry_validates_but_is_not_renewed.)
        let c = long_claims_with(-3600, Utc::now().timestamp() - 7200);
        let token = jsonwebtoken::encode(
            &jsonwebtoken::Header::default(),
            &c,
            &jsonwebtoken::EncodingKey::from_secret(SECRET.as_bytes()),
        )
        .unwrap();
        assert!(validate_token(&token, SECRET).is_err(), "expired long token must not validate");
    }

    #[test]
    fn a_token_minted_before_the_claim_existed_decodes_as_an_ordinary_session() {
        // Every token outstanding when this ships has no `ls` field at all.
        // It must decode (not 400 the user out) and it must decode as FALSE —
        // defaulting the other way would silently hand every live session a
        // month-long life nobody asked for.
        use jsonwebtoken::{encode, EncodingKey, Header};
        let legacy = serde_json::json!({
            "sub": 7, "username": "alice", "exp": Utc::now().timestamp() + 3600, "tv": 3,
            "sst": Utc::now().timestamp() - 7200, "sid": "s"
        });
        let tok = encode(&Header::default(), &legacy, &EncodingKey::from_secret(SECRET.as_bytes())).unwrap();
        let out = validate_token(&tok, SECRET).expect("a pre-ls token must still decode");
        assert!(!out.ls, "no `ls` means an ordinary 24-hour session");
        let renewed = renew_if_stale(&out, &out.sid, SECRET).expect("and it still renews");
        let back = validate_token(&renewed, SECRET).unwrap();
        assert!(!back.ls);
        let hours = (back.exp - Utc::now().timestamp()) as f64 / 3600.0;
        assert!((TOKEN_TTL_HOURS as f64 - hours).abs() < 0.01, "renewed to 24h, got {hours}");
    }

    // ---- The cap bounds VALIDITY, not just renewal (finding 2) -------------
    //
    // A renewal a day before the one-year cap used to mint a fresh 30-day
    // token, so the "year" was really up to 395 days; an ordinary session's
    // "30 days" was up to 31. Every renewal and mint is now clamped to
    // `sst + cap`. The positive control that a session far from its cap is
    // untouched is `a_long_session_renews_on_the_same_four_hour_cadence_and_
    // keeps_its_flag` (a full 30 days at sst = now) and the ordinary twin
    // below.

    #[test]
    fn a_renewal_just_inside_the_long_cap_never_outlives_it() {
        let now = Utc::now().timestamp();
        let cap = LONG_MAX_SESSION_DAYS * 86_400;
        let c = long_claims_with(3600, now - (cap - 86_400)); // a day short of the year
        let renewed = renew_if_stale(&c, &c.sid, SECRET).expect("a day short of the cap still renews");
        let out = validate_token(&renewed, SECRET).expect("renewed token must verify");
        assert!(out.exp > c.exp, "it must still extend the token, to the cap");
        assert!(
            out.exp <= out.sst + cap,
            "a renewal must not outlive the one-year cap: exp is {} days past it",
            (out.exp - (out.sst + cap)) as f64 / 86_400.0,
        );
    }

    #[test]
    fn a_renewal_just_inside_the_ordinary_cap_never_outlives_it() {
        let now = Utc::now().timestamp();
        let cap = MAX_SESSION_DAYS * 86_400;
        let c = claims_with(1800, now - (cap - 3600)); // an hour short of 30 days
        let renewed = renew_if_stale(&c, &c.sid, SECRET).expect("an hour short of the cap still renews");
        let out = validate_token(&renewed, SECRET).expect("renewed token must verify");
        assert!(out.exp > c.exp, "it must still extend the token, to the cap");
        assert!(
            out.exp <= out.sst + cap,
            "a renewal must not outlive the 30-day cap: exp is {} hours past it",
            (out.exp - (out.sst + cap)) as f64 / 3600.0,
        );
    }

    #[test]
    fn a_token_already_clamped_to_the_cap_is_not_renewed_on_every_request() {
        // The last TTL before the cap: the token already ends at sst + cap and
        // is older than four hours, so it looks "stale" to the cadence check.
        // A renewal could not extend it, only re-mint the same exp and write
        // token_sessions.last_seen_at, on EVERY request for the final month.
        let now = Utc::now().timestamp();
        let cap = LONG_MAX_SESSION_DAYS * 86_400;
        let sst = now - (cap - 10 * 86_400); // ten days left of the year
        let mut c = long_claims_with(0, sst);
        c.exp = sst + cap;
        assert!(renew_if_stale(&c, &c.sid, SECRET).is_none(), "nothing to extend: no new token, no write");
        let mut o = claims_with(0, now - (MAX_SESSION_DAYS * 86_400 - 3 * 3600));
        o.exp = o.sst + MAX_SESSION_DAYS * 86_400; // three hours left, and that is the cap
        assert!(renew_if_stale(&o, &o.sid, SECRET).is_none(), "the ordinary twin");
    }

    #[test]
    fn a_mint_for_a_session_near_its_cap_is_clamped_to_it() {
        // The clamp lives in the mint, so no caller can forget it.
        let now = Utc::now().timestamp();
        for (long, cap) in [(true, LONG_MAX_SESSION_DAYS * 86_400), (false, MAX_SESSION_DAYS * 86_400)] {
            let sst = now - (cap - 2 * 3600); // two hours left
            let tok = crate::ws::create_token_with_start(7, "alice", 3, sst, "sid-c", long, SECRET).unwrap();
            let out = validate_token(&tok, SECRET).expect("still valid for its last two hours");
            assert_eq!(out.exp, sst + cap, "long={long}: exp must be the cap, not now + TTL");
        }
    }

    #[test]
    fn an_ordinary_renewal_far_from_the_cap_is_exactly_what_it_was() {
        // The ordinary path, byte for byte: 24 h from now, every other claim
        // carried over, and the same encoding a hand-built Claims produces.
        let now = Utc::now().timestamp();
        let mut c = claims_with(3600, now - 86_400);
        c.sid = "sid-same".into();
        let before = Utc::now().timestamp();
        let renewed = renew_if_stale(&c, &c.sid, SECRET).expect("renews");
        let after = Utc::now().timestamp();
        let out = validate_token(&renewed, SECRET).unwrap();
        assert!(
            out.exp >= before + TOKEN_TTL_HOURS * 3600 && out.exp <= after + TOKEN_TTL_HOURS * 3600,
            "exp must be now + 24 h, unclamped",
        );
        let expected = Claims { exp: out.exp, ..c.clone() };
        let rebuilt = jsonwebtoken::encode(
            &jsonwebtoken::Header::default(),
            &expected,
            &jsonwebtoken::EncodingKey::from_secret(SECRET.as_bytes()),
        )
        .unwrap();
        assert_eq!(renewed, rebuilt, "the renewed token is the same bytes as before the clamp existed");
    }

    // ---- Inside jsonwebtoken's 60 s leeway: accepted, never renewed (15) ---

    #[test]
    fn a_token_inside_the_skew_leeway_after_expiry_validates_but_is_not_renewed() {
        for c in [
            claims_with(-30, Utc::now().timestamp() - 3600),
            long_claims_with(-30, Utc::now().timestamp() - 3600),
        ] {
            let token = jsonwebtoken::encode(
                &jsonwebtoken::Header::default(),
                &c,
                &jsonwebtoken::EncodingKey::from_secret(SECRET.as_bytes()),
            )
            .unwrap();
            // Positive control: this token really is in the leeway window, so
            // the middleware reaches renew_if_stale with it.
            assert!(validate_token(&token, SECRET).is_ok(), "30 s past exp is inside the 60 s leeway");
            assert!(
                renew_if_stale(&c, &c.sid, SECRET).is_none(),
                "ls={}: an expired token must never be renewed, leeway or not",
                c.ls,
            );
        }
    }
}

#[cfg(test)]
mod session_tests {
    use super::*;

    const SECRET: &str = "session-tests-secret";

    #[test]
    fn a_minted_token_carries_its_session_id_and_a_legacy_token_decodes_as_empty() {
        // `false`: an ordinary session — this test is about the sid claim.
        // The session start is an hour ago, not a fixed date: a mint is
        // clamped to sst + the session cap, so a start from 2023 now (rightly)
        // yields a token that expired years ago.
        let sst = Utc::now().timestamp() - 3600;
        let tok = crate::ws::create_token_with_start(7, "alice", 3, sst, "sid-abc", false, SECRET).unwrap();
        let c = validate_token(&tok, SECRET).unwrap();
        assert_eq!(c.sid, "sid-abc");
        assert_eq!(c.sst, sst);
        // A token from before the claim existed: no `sid` field at all.
        use jsonwebtoken::{encode, EncodingKey, Header};
        let legacy = serde_json::json!({ "sub": 7, "username": "alice", "exp": Utc::now().timestamp() + 3600, "tv": 3, "sst": 1 });
        let tok = encode(&Header::default(), &legacy, &EncodingKey::from_secret(SECRET.as_bytes())).unwrap();
        assert_eq!(validate_token(&tok, SECRET).unwrap().sid, "", "legacy tokens keep working");
    }

    #[test]
    fn renewal_carries_the_session_id_forward() {
        let c = Claims { sub: 7, username: "alice".into(), exp: Utc::now().timestamp() + 60, tv: 3, sst: Utc::now().timestamp() - 60, sid: "sid-keep".into(), ls: false };
        let renewed = renew_if_stale(&c, &c.sid, SECRET).expect("past halfway: renews");
        assert_eq!(validate_token(&renewed, SECRET).unwrap().sid, "sid-keep");
    }

    /// The decision the middleware and the WS upgrade share, against a real
    /// database. Skips (prints) only without TEST_DATABASE_URL, and fails if
    /// it is set but unreachable (migrator::test_pool).
    #[tokio::test]
    async fn a_revoked_session_is_refused_while_its_siblings_and_legacy_tokens_live() {
        let Some(pool) = crate::migrator::test_pool(2).await else { return };
        let name = format!("sess_test_{}", uuid::Uuid::new_v4());
        let (uid,): (i32,) = sqlx::query_as("INSERT INTO users (username, email, salt, verifier, created_at) VALUES ($1, $2, $3, $4, NOW()) RETURNING id")
            .bind(&name).bind(format!("{name}@test.invalid")).bind(b"s".as_ref()).bind(b"v".as_ref())
            .fetch_one(&pool).await.expect("insert user");
        let (tv,): (i32,) = sqlx::query_as("SELECT token_version FROM users WHERE id = $1").bind(uid).fetch_one(&pool).await.unwrap();
        for sid in ["sid-live", "sid-dead"] {
            sqlx::query("INSERT INTO token_sessions (sid, user_id) VALUES ($1, $2)").bind(sid).bind(uid).execute(&pool).await.unwrap();
        }
        sqlx::query("UPDATE token_sessions SET revoked_at = NOW() WHERE sid = 'sid-dead'").execute(&pool).await.unwrap();
        let claims = |sid: &str, tv: i32| Claims { sub: uid as UserId, username: name.clone(), exp: 0, tv, sst: 0, sid: sid.into(), ls: false };
        assert!(token_session_live(&pool, &claims("sid-live", tv)).await.unwrap(), "the sibling session lives");
        assert!(!token_session_live(&pool, &claims("sid-dead", tv)).await.unwrap(), "the revoked session is refused");
        assert!(token_session_live(&pool, &claims("", tv)).await.unwrap(), "a legacy token (no sid) is judged on token_version alone");
        assert!(token_session_live(&pool, &claims("sid-unknown", tv)).await.unwrap(), "an unknown sid has no row to be revoked");
        assert!(!token_session_live(&pool, &claims("sid-live", tv + 1)).await.unwrap(), "token_version still rules");
        let _ = sqlx::query("DELETE FROM users WHERE id = $1").bind(uid).execute(&pool).await;
    }

    /// A session BOUND to a device dies with the device, whatever its own row
    /// says. The row's mark cannot be the only defence: a device-token mint
    /// (or a DeviceAttest binding) that read the device as live before the
    /// revoke and wrote its row after the revoke's sweep left a row with
    /// `revoked_at` NULL, and this check used to accept it on every request —
    /// and renew it into a 24 h token sliding for 30 days. Here the device is
    /// revoked and its session row deliberately is NOT, which is exactly the
    /// state that race produced. TEST_DATABASE_URL only.
    #[tokio::test]
    async fn a_session_bound_to_a_revoked_device_is_refused_even_if_its_row_was_missed() {
        let Some(pool) = crate::migrator::test_pool(2).await else { return };
        let name = format!("sess_dev_{}", uuid::Uuid::new_v4().simple());
        let (uid, tv): (i32, i32) = sqlx::query_as("INSERT INTO users (username, salt, verifier) VALUES ($1, $2, $3) RETURNING id, token_version")
            .bind(&name).bind(b"s".as_ref()).bind(b"v".as_ref())
            .fetch_one(&pool).await.expect("insert user");
        let tag = uuid::Uuid::new_v4().simple().to_string();
        let (live_dev, dead_dev, gone_dev) = (format!("ld-{tag}"), format!("rd-{tag}"), format!("gd-{tag}"));
        for dev in [&live_dev, &dead_dev] {
            sqlx::query(
                "INSERT INTO devices (id, user_id, device_pub, sign_pub, name, platform, auth_record, auth_sig) \
                 VALUES ($1, $2, 'x25519:' || $1, 'ed25519:' || $1, 'test', 'windows', '{}', 'x')",
            )
            .bind(dev).bind(uid).execute(&pool).await.expect("insert device");
        }
        let (plain, on_live, on_dead, on_gone) =
            (format!("p-{tag}"), format!("l-{tag}"), format!("r-{tag}"), format!("g-{tag}"));
        sqlx::query("INSERT INTO token_sessions (sid, user_id) VALUES ($1, $2)").bind(&plain).bind(uid).execute(&pool).await.unwrap();
        for (sid, dev) in [(&on_live, &live_dev), (&on_dead, &dead_dev), (&on_gone, &gone_dev)] {
            sqlx::query("INSERT INTO token_sessions (sid, user_id, device_id, headless) VALUES ($1, $2, $3, TRUE)")
                .bind(sid).bind(uid).bind(dev).execute(&pool).await.unwrap();
        }
        // The device only — the session row is left live, as the race left it.
        sqlx::query("UPDATE devices SET revoked_at = NOW() WHERE id = $1").bind(&dead_dev).execute(&pool).await.unwrap();

        let claims = |sid: &str| Claims { sub: uid as UserId, username: name.clone(), exp: 0, tv, sst: 0, sid: sid.into(), ls: false };
        let plain_ok = token_session_live(&pool, &claims(&plain)).await.unwrap();
        let live_ok = token_session_live(&pool, &claims(&on_live)).await.unwrap();
        let dead_ok = token_session_live(&pool, &claims(&on_dead)).await.unwrap();
        let gone_ok = token_session_live(&pool, &claims(&on_gone)).await.unwrap();
        let legacy_ok = token_session_live(&pool, &claims("")).await.unwrap();
        let (dead_row_live,): (bool,) = sqlx::query_as("SELECT revoked_at IS NULL FROM token_sessions WHERE sid = $1")
            .bind(&on_dead).fetch_one(&pool).await.unwrap();
        let _ = sqlx::query("DELETE FROM users WHERE id = $1").bind(uid).execute(&pool).await;

        // Positive controls: an ordinary sign-in is bound to no device and must
        // not be judged by one, and a session on a LIVE device is untouched —
        // without these a query that refused everything would pass.
        assert!(plain_ok, "an ordinary (deviceless) session is still accepted");
        assert!(live_ok, "a session bound to a live device is still accepted");
        assert!(legacy_ok, "a legacy token (no sid) is still judged on token_version alone");
        assert!(dead_row_live, "fixture: the session row itself really is unrevoked");
        assert!(!dead_ok, "a session bound to a REVOKED device must be refused though its row was missed");
        // Devices are never hard-deleted (a revoked one stays, so it cannot
        // re-enrol), so a binding to a row that is gone names a device nothing
        // can vouch for any more: refused, the same fail-closed rule the WS
        // delivery claim uses.
        assert!(!gone_ok, "a session bound to a device row that no longer exists is refused");
    }

    /// Finding 3, defence in depth: a sid-bearing token whose session row does
    /// not exist must not be slid forward. The UPDATE that "records" the
    /// renewal matched 0 rows and was treated as success, so a row-less
    /// session renewed for up to a year with nothing per-session able to
    /// revoke it. Drives the real middleware; TEST_DATABASE_URL only.
    #[tokio::test]
    async fn the_middleware_does_not_renew_a_session_that_has_no_row() {
        use axum::{body::Body, routing::get, Router};
        use tower::ServiceExt;
        let Some(pool) = crate::migrator::test_pool(2).await else { return };
        let state = AppState::new(pool.clone(), SECRET.into(), None, Arc::new(crate::wake::NullWake));
        let name = format!("renew_row_{}", uuid::Uuid::new_v4().simple());
        let (uid, tv): (i32, i32) = sqlx::query_as("INSERT INTO users (username, salt, verifier) VALUES ($1, $2, $3) RETURNING id, token_version")
            .bind(&name).bind(b"s".as_ref()).bind(b"v".as_ref())
            .fetch_one(&pool).await.expect("insert user");
        let with_row = format!("sid-row-{}", uuid::Uuid::new_v4().simple());
        let without_row = format!("sid-none-{}", uuid::Uuid::new_v4().simple());
        sqlx::query("INSERT INTO token_sessions (sid, user_id) VALUES ($1, $2)").bind(&with_row).bind(uid).execute(&pool).await.unwrap();

        let app = Router::new()
            .route("/x", get(|| async { "ok" }))
            .layer(axum::middleware::from_fn_with_state(state.clone(), jwt_auth_middleware));
        // Five hours into an ordinary token's day: stale, so it renews.
        let now = Utc::now().timestamp();
        let bearer = |sid: &str| {
            let c = Claims { sub: uid as UserId, username: name.clone(), exp: now + 19 * 3600, tv, sst: now - 5 * 3600, sid: sid.into(), ls: false };
            let t = jsonwebtoken::encode(&jsonwebtoken::Header::default(), &c, &jsonwebtoken::EncodingKey::from_secret(SECRET.as_bytes())).unwrap();
            axum::http::Request::get("/x").header(header::AUTHORIZATION, format!("Bearer {t}")).body(Body::empty()).unwrap()
        };
        let control = app.clone().oneshot(bearer(&with_row)).await.unwrap();
        let rowless = app.clone().oneshot(bearer(&without_row)).await.unwrap();
        let _ = sqlx::query("DELETE FROM users WHERE id = $1").bind(uid).execute(&pool).await;

        assert_eq!(control.status(), StatusCode::OK);
        assert!(control.headers().contains_key(RENEWED_TOKEN_HEADER), "positive control: a session with its row renews");
        assert_eq!(rowless.status(), StatusCode::OK, "the request itself is still served (the row-less case is judged on token_version)");
        assert!(
            !rowless.headers().contains_key(RENEWED_TOKEN_HEADER),
            "a session with no row must not be renewed: nothing per-session could ever revoke it",
        );
    }
}

/// Make every INSERT into `token_sessions` for ONE user fail, the way a
/// dropped connection or a pool timeout at that statement would. Scoped to
/// the user so tests running beside it on the same database are untouched.
/// Returns the name to hand to [`allow_session_rows`]. THROWAWAY DATABASE
/// ONLY (TEST_DATABASE_URL).
#[cfg(test)]
pub(crate) async fn refuse_session_rows_for(pool: &sqlx::PgPool, uid: i32) -> String {
    let name = format!("test_refuse_ts_{}", uuid::Uuid::new_v4().simple());
    sqlx::query(&format!(
        "CREATE FUNCTION {name}() RETURNS trigger LANGUAGE plpgsql AS $f$ \
         BEGIN IF NEW.user_id = {uid} THEN RAISE EXCEPTION 'test: the session store is unavailable'; END IF; RETURN NEW; END $f$"
    ))
    .execute(pool)
    .await
    .expect("create fault function");
    sqlx::query(&format!("CREATE TRIGGER {name} BEFORE INSERT ON token_sessions FOR EACH ROW EXECUTE FUNCTION {name}()"))
        .execute(pool)
        .await
        .expect("create fault trigger");
    name
}

#[cfg(test)]
pub(crate) async fn allow_session_rows(pool: &sqlx::PgPool, name: &str) {
    let _ = sqlx::query(&format!("DROP TRIGGER IF EXISTS {name} ON token_sessions")).execute(pool).await;
    let _ = sqlx::query(&format!("DROP FUNCTION IF EXISTS {name}()")).execute(pool).await;
}
