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
    /// slide for `MAX_SESSION_DAYS` before real re-authentication is required.
    /// `#[serde(default)]`: tokens minted before this claim existed decode as
    /// 0 and start their clock at first renewal rather than being refused.
    #[serde(default)]
    pub sst: i64,
    /// Session id (one per sign-in, one per device token). `tv` is per USER
    /// and cannot revoke one device; this can: revoking a device marks the
    /// sessions it PROVED (token_sessions.device_id, set by DeviceAttest,
    /// never by a client claim), signing out one session marks that row, and
    /// the middleware + WebSocket upgrade refuse a token whose sid is revoked
    /// while every other session keeps working. `#[serde(default)]`: tokens
    /// minted before the claim decode as "" and stay accepted (no row can be
    /// revoked for them); their first sliding renewal mints one.
    #[serde(default)]
    pub sid: String,
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
/// time, which renewal carries forward and cannot reset), and revocation is
/// unaffected either way because `token_version` is re-checked on every single
/// request. All this changes is how much ordinary use it takes to stay signed
/// in: now any request more than four hours after the last mint.
const RENEW_WHEN_REMAINING_HOURS: i64 = 20;
/// A sliding session still ends: after this long since the user actually
/// signed in, renewal stops and they must authenticate again.
const MAX_SESSION_DAYS: i64 = 30;
/// Response header carrying a renewed token. Must be in the CORS
/// `expose_headers` list or browsers can't read it cross-origin.
pub const RENEWED_TOKEN_HEADER: &str = "x-renewed-token";

/// Mint a replacement token when the current one is running out, so users stop
/// being dumped at the login screen every 24 h.
///
/// Safe against the obvious abuse: this runs only AFTER the caller's token has
/// been validated and its `tv` matched against the live `users.token_version`,
/// and the new token carries that same `tv` — so anything that bumps that
/// counter kills every renewed token instantly. NOTE that in-app "Sign out" is
/// deliberately local-only: `token_version` is per-USER with no per-session
/// claim, so revoking there would sign the user out on every other device too.
/// Account-wide revocation is therefore a password change or recovery reset
/// (both bump it). `sst` bounds how long a stolen-but-unrevoked token can keep
/// renewing itself in the meantime.
pub fn renew_if_stale(claims: &Claims, sid: &str, secret: &str) -> Option<String> {
    let now = Utc::now().timestamp();
    if claims.exp - now > RENEW_WHEN_REMAINING_HOURS * 3600 {
        return None; // plenty of life left
    }
    let started = if claims.sst > 0 { claims.sst } else { now };
    if now - started > MAX_SESSION_DAYS * 86_400 {
        return None; // session too old to slide — require a real sign-in
    }
    crate::ws::create_token_with_start(claims.sub, &claims.username, claims.tv, started, sid, secret)
        .ok()
}

/// Is this token still good: the user's token_version matches AND, when the
/// token carries a session id, that session has not been revoked. ONE query
/// (the middleware runs on every request): a LEFT JOIN, so a legacy token with
/// no sid, or a sid with no row, is judged on token_version alone.
pub async fn token_session_live(pool: &sqlx::PgPool, claims: &Claims) -> Result<bool, sqlx::Error> {
    let row: Option<(i32, bool)> = sqlx::query_as(
        "SELECT u.token_version, COALESCE(s.revoked_at IS NOT NULL, false) FROM users u \
         LEFT JOIN token_sessions s ON s.sid = $2 AND s.user_id = u.id \
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
    let renewed = renew_if_stale(&claims, &renew_sid, &state.jwt_secret);
    if renewed.is_some() {
        let _ = if claims.sid.is_empty() {
            sqlx::query("INSERT INTO token_sessions (sid, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING")
                .bind(&renew_sid).bind(claims.sub as i32).execute(&state.pool).await
        } else {
            sqlx::query("UPDATE token_sessions SET last_seen_at = NOW() WHERE sid = $1")
                .bind(&renew_sid).execute(&state.pool).await
        };
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

    fn claims_with(exp_offset_secs: i64, sst: i64) -> Claims {
        Claims {
            sub: 7,
            username: "tester".to_string(),
            exp: Utc::now().timestamp() + exp_offset_secs,
            tv: 3,
            sst,
            sid: String::new(),
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
        // clock-skew leeway jsonwebtoken's Validation::default() allows.)
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
}

#[cfg(test)]
mod session_tests {
    use super::*;

    const SECRET: &str = "session-tests-secret";

    #[test]
    fn a_minted_token_carries_its_session_id_and_a_legacy_token_decodes_as_empty() {
        let tok = crate::ws::create_token_with_start(7, "alice", 3, 1_700_000_000, "sid-abc", SECRET).unwrap();
        let c = validate_token(&tok, SECRET).unwrap();
        assert_eq!(c.sid, "sid-abc");
        assert_eq!(c.sst, 1_700_000_000);
        // A token from before the claim existed: no `sid` field at all.
        use jsonwebtoken::{encode, EncodingKey, Header};
        let legacy = serde_json::json!({ "sub": 7, "username": "alice", "exp": Utc::now().timestamp() + 3600, "tv": 3, "sst": 1 });
        let tok = encode(&Header::default(), &legacy, &EncodingKey::from_secret(SECRET.as_bytes())).unwrap();
        assert_eq!(validate_token(&tok, SECRET).unwrap().sid, "", "legacy tokens keep working");
    }

    #[test]
    fn renewal_carries_the_session_id_forward() {
        let c = Claims { sub: 7, username: "alice".into(), exp: Utc::now().timestamp() + 60, tv: 3, sst: Utc::now().timestamp() - 60, sid: "sid-keep".into() };
        let renewed = renew_if_stale(&c, &c.sid, SECRET).expect("past halfway: renews");
        assert_eq!(validate_token(&renewed, SECRET).unwrap().sid, "sid-keep");
    }

    /// The decision the middleware and the WS upgrade share, against a real
    /// database. Skips (prints) without TEST_DATABASE_URL / DATABASE_URL.
    #[tokio::test]
    async fn a_revoked_session_is_refused_while_its_siblings_and_legacy_tokens_live() {
        dotenv::dotenv().ok();
        let url = match std::env::var("TEST_DATABASE_URL").or_else(|_| std::env::var("DATABASE_URL")) {
            Ok(u) => u,
            Err(_) => { println!("skipping: no database"); return; }
        };
        let pool = match sqlx::postgres::PgPoolOptions::new().max_connections(2).connect(&url).await {
            Ok(p) => p,
            Err(_) => { println!("skipping: database unreachable"); return; }
        };
        let name = format!("sess_test_{}", uuid::Uuid::new_v4());
        let (uid,): (i32,) = sqlx::query_as("INSERT INTO users (username, email, salt, verifier, created_at) VALUES ($1, $2, $3, $4, NOW()) RETURNING id")
            .bind(&name).bind(format!("{name}@test.invalid")).bind(b"s".as_ref()).bind(b"v".as_ref())
            .fetch_one(&pool).await.expect("insert user");
        let (tv,): (i32,) = sqlx::query_as("SELECT token_version FROM users WHERE id = $1").bind(uid).fetch_one(&pool).await.unwrap();
        for sid in ["sid-live", "sid-dead"] {
            sqlx::query("INSERT INTO token_sessions (sid, user_id) VALUES ($1, $2)").bind(sid).bind(uid).execute(&pool).await.unwrap();
        }
        sqlx::query("UPDATE token_sessions SET revoked_at = NOW() WHERE sid = 'sid-dead'").execute(&pool).await.unwrap();
        let claims = |sid: &str, tv: i32| Claims { sub: uid as UserId, username: name.clone(), exp: 0, tv, sst: 0, sid: sid.into() };
        assert!(token_session_live(&pool, &claims("sid-live", tv)).await.unwrap(), "the sibling session lives");
        assert!(!token_session_live(&pool, &claims("sid-dead", tv)).await.unwrap(), "the revoked session is refused");
        assert!(token_session_live(&pool, &claims("", tv)).await.unwrap(), "a legacy token (no sid) is judged on token_version alone");
        assert!(token_session_live(&pool, &claims("sid-unknown", tv)).await.unwrap(), "an unknown sid has no row to be revoked");
        assert!(!token_session_live(&pool, &claims("sid-live", tv + 1)).await.unwrap(), "token_version still rules");
        let _ = sqlx::query("DELETE FROM users WHERE id = $1").bind(uid).execute(&pool).await;
    }
}
