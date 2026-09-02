//! `GET /account/export` — a user's own rows, as one JSON document.
//!
//! The deletion side (`handlers::delete_account`) is thorough; this is the
//! other limb of the account lifecycle. The server holds ciphertext for
//! everything the user ever wrote, so what it can hand over is the ROWS:
//! profile, memberships, friends, blocks, the user's own messages (channel and
//! DM) exactly as stored, tasks, uploads, devices, sessions and preferences.
//! The client decrypts what its identity can open and saves the result — see
//! `frontend/src/api/accountExport.ts`. Nothing here is decrypted, because
//! nothing here can be.
//!
//! ONLY THE USER'S OWN WRITES. Other people's messages in a shared channel or
//! a DM are theirs; a "conversation export" that included them would be a way
//! to lift a peer's history out of a chat they can still delete from. The
//! conversation and channel metadata (who, where, when) is included so the
//! user's own rows have context.
//!
//! GATES. A bearer token is not enough — this is the whole account in one
//! response and a stolen token is the threat model — so a recent SRP proof is
//! required, the same `require_password_proof` the credential rewrites use;
//! the client re-proves with the password it has in hand, as `deleteAccount`
//! does. And one export per user per minute: an unrevoked stolen session must
//! not be able to drain the account in a loop, and the query is heavy for a
//! busy account. Both refusals are ordinary status codes (401 / 429) so the
//! client can say something true.
//!
//! Every timestamp is rendered in UTC: the export runs in one transaction
//! whose session time zone is pinned, and the naive `TIMESTAMP` columns (the
//! original schema's) are converted explicitly, so a reader never has to guess
//! which of the two column types a value came from.

use axum::{
    extract::{Extension, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
};
use dashmap::DashMap;
use serde_json::{json, Value};
use sqlx::PgPool;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use crate::auth::Claims;
use crate::state::AppState;

/// Version tag on the document. Bump when a section's shape changes so a
/// reader (the app's importer-to-be, a script) can tell what it has.
pub const EXPORT_FORMAT: &str = "puca-account-export/1";
/// One export per user per this window.
pub const EXPORT_COOLDOWN: Duration = Duration::from_secs(60);

/// Last export per user id. Process-local on purpose: this is a courtesy
/// throttle on an authenticated, password-proven caller, not a security
/// boundary that has to survive a restart. Bounded by the number of accounts
/// that have ever exported, each entry replaced in place.
fn recent_exports() -> &'static DashMap<i64, Instant> {
    static M: OnceLock<DashMap<i64, Instant>> = OnceLock::new();
    M.get_or_init(DashMap::new)
}

/// Claim the export slot for `user_id` at `now`. `None` = go ahead (and the
/// attempt is recorded); `Some(secs)` = an export ran within the cooldown,
/// try again in that many seconds.
pub(crate) fn take_export_slot(user_id: i64, now: Instant) -> Option<u64> {
    let map = recent_exports();
    // The Ref is dropped before the insert below: holding it across an
    // insert on the same shard would deadlock.
    let blocked = map.get(&user_id).and_then(|prev| {
        let elapsed = now.saturating_duration_since(*prev);
        (elapsed < EXPORT_COOLDOWN).then(|| (EXPORT_COOLDOWN - elapsed).as_secs().max(1))
    });
    if blocked.is_some() {
        return blocked;
    }
    map.insert(user_id, now);
    None
}

pub async fn export_account(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
) -> Response {
    if let Err(r) = crate::recovery_handlers::require_password_proof(&state, claims.sub, claims.sst) {
        return r;
    }
    if let Some(secs) = take_export_slot(claims.sub, Instant::now()) {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            [(header::RETRY_AFTER, secs.to_string())],
            format!("An export was produced less than a minute ago — try again in {secs} seconds"),
        )
            .into_response();
    }
    match build_export(&state.pool, &claims).await {
        Ok(doc) => {
            // The id, never the name: the log is a directory otherwise (logtag.rs).
            tracing::info!("account export produced for user {}", claims.sub);
            (
                StatusCode::OK,
                [(header::CONTENT_TYPE, "application/json")],
                doc.to_string(),
            )
                .into_response()
        }
        Err(e) => {
            tracing::error!("account export failed for user {}: {e:?}", claims.sub);
            (StatusCode::INTERNAL_SERVER_ERROR, "Export failed").into_response()
        }
    }
}

/// One section: the query must produce exactly one row with one TEXT column
/// holding JSON — `json_agg` (always one row, `[]` when empty) or the
/// `COALESCE((SELECT row_to_json …), 'null')` shape for a single record.
/// Built as JSON inside Postgres so the column types (uuid, timestamptz, jsonb,
/// time) are rendered by the one encoder that knows them all, rather than a
/// tuple per table that has to match every column type by hand.
async fn section(tx: &mut sqlx::PgConnection, sql: &str, user_id: i64) -> Result<Value, sqlx::Error> {
    let (text,): (String,) = sqlx::query_as(sql).bind(user_id).fetch_one(&mut *tx).await?;
    Ok(serde_json::from_str(&text).unwrap_or(Value::Null))
}

/// `$1::bigint` throughout: the user-id columns are a mix of INTEGER (the
/// original schema) and BIGINT (the 019 rewrite), and an explicitly typed
/// parameter compares against both without a per-column bind type.
const PROFILE_SQL: &str = "SELECT COALESCE((SELECT row_to_json(t) FROM ( \
    SELECT id, username, display_name, email, email_verified, \
           (email_verified_at AT TIME ZONE 'UTC') AS email_verified_at, \
           (created_at AT TIME ZONE 'UTC') AS created_at, \
           public_key, account_sign_pub, key_version, avatar_file_id, \
           join_sound_file_id, leave_sound_file_id, \
           allow_dms_from_server_members, show_online_status \
    FROM users WHERE id = $1::bigint) t), 'null'::json)::text";

const SERVERS_SQL: &str = "SELECT COALESCE(json_agg(t), '[]'::json)::text FROM ( \
    SELECT s.id AS server_id, s.name, (s.owner_id = $1::bigint) AS is_owner, \
           (m.joined_at AT TIME ZONE 'UTC') AS joined_at, n.nickname, \
           (SELECT COALESCE(json_agg(r.name ORDER BY r.position), '[]'::json) \
              FROM member_roles mr JOIN server_roles r ON r.id = mr.role_id \
             WHERE mr.user_id = m.user_id AND r.server_id = s.id) AS roles \
    FROM server_members m \
    JOIN servers s ON s.id = m.server_id \
    LEFT JOIN server_nicknames n ON n.server_id = s.id AND n.user_id = m.user_id \
    WHERE m.user_id = $1::bigint \
    ORDER BY m.joined_at, s.id) t";

const FRIENDS_SQL: &str = "SELECT COALESCE(json_agg(t), '[]'::json)::text FROM ( \
    SELECT u.id AS user_id, u.username, u.display_name, (f.created_at AT TIME ZONE 'UTC') AS since \
    FROM friends f \
    JOIN users u ON u.id = (CASE WHEN f.user1_id = $1::bigint THEN f.user2_id ELSE f.user1_id END) \
    WHERE f.user1_id = $1::bigint OR f.user2_id = $1::bigint \
    ORDER BY f.created_at, u.id) t";

const FRIEND_REQUESTS_SQL: &str = "SELECT COALESCE(json_agg(t), '[]'::json)::text FROM ( \
    SELECT fr.id, \
           CASE WHEN fr.sender_id = $1::bigint THEN 'sent' ELSE 'received' END AS direction, \
           u.id AS user_id, u.username, fr.status, (fr.created_at AT TIME ZONE 'UTC') AS created_at \
    FROM friend_requests fr \
    JOIN users u ON u.id = (CASE WHEN fr.sender_id = $1::bigint THEN fr.receiver_id ELSE fr.sender_id END) \
    WHERE fr.sender_id = $1::bigint OR fr.receiver_id = $1::bigint \
    ORDER BY fr.created_at, fr.id) t";

const BLOCKED_SQL: &str = "SELECT COALESCE(json_agg(t), '[]'::json)::text FROM ( \
    SELECT b.blocked_id AS user_id, u.username, (b.created_at AT TIME ZONE 'UTC') AS blocked_at \
    FROM blocked_users b JOIN users u ON u.id = b.blocked_id \
    WHERE b.blocker_id = $1::bigint \
    ORDER BY b.created_at, b.blocked_id) t";

const DM_CONVERSATIONS_SQL: &str = "SELECT COALESCE(json_agg(t), '[]'::json)::text FROM ( \
    SELECT c.id, \
           (CASE WHEN c.user1_id = $1::bigint THEN c.user2_id ELSE c.user1_id END) AS partner_user_id, \
           ou.username AS partner_username, \
           (c.created_at AT TIME ZONE 'UTC') AS created_at, (c.updated_at AT TIME ZONE 'UTC') AS updated_at \
    FROM dm_conversations c \
    JOIN users ou ON ou.id = (CASE WHEN c.user1_id = $1::bigint THEN c.user2_id ELSE c.user1_id END) \
    WHERE c.user1_id = $1::bigint OR c.user2_id = $1::bigint \
    ORDER BY c.created_at, c.id) t";

/// The user's OWN DM messages (`sender_id`), never the partner's.
const DM_MESSAGES_SQL: &str = "SELECT COALESCE(json_agg(t), '[]'::json)::text FROM ( \
    SELECT m.id, m.conversation_id, \
           (CASE WHEN c.user1_id = $1::bigint THEN c.user2_id ELSE c.user1_id END) AS partner_user_id, \
           m.content, m.encrypted, (m.created_at AT TIME ZONE 'UTC') AS created_at \
    FROM dm_messages m JOIN dm_conversations c ON c.id = m.conversation_id \
    WHERE m.sender_id = $1::bigint \
    ORDER BY m.created_at, m.id) t";

/// The user's OWN channel messages (`user_id`), with where they were posted.
const CHANNEL_MESSAGES_SQL: &str = "SELECT COALESCE(json_agg(t), '[]'::json)::text FROM ( \
    SELECT m.id, m.channel_id, ch.name AS channel_name, ch.server_id, s.name AS server_name, \
           m.content, m.key_epoch, m.reply_to_id, m.is_pinned, m.is_task, m.is_completed, \
           m.parent_message_id, m.clip_consent, \
           (m.created_at AT TIME ZONE 'UTC') AS created_at, (m.edited_at AT TIME ZONE 'UTC') AS edited_at \
    FROM messages m \
    JOIN channels ch ON ch.id = m.channel_id \
    LEFT JOIN servers s ON s.id = ch.server_id \
    WHERE m.user_id = $1::bigint \
    ORDER BY m.created_at, m.id) t";

const REACTIONS_SQL: &str = "SELECT COALESCE(json_agg(t), '[]'::json)::text FROM ( \
    SELECT r.message_id, r.emoji, r.is_custom, r.created_at \
    FROM message_reactions r WHERE r.user_id = $1::bigint \
    ORDER BY r.created_at, r.id) t";

const TASK_LISTS_SQL: &str = "SELECT COALESCE(json_agg(t), '[]'::json)::text FROM ( \
    SELECT id, title, created_at FROM task_lists WHERE owner_id = $1::bigint ORDER BY id) t";

/// Checklist items the user created, plus every item in the user's own
/// personal lists (those are encrypt-to-self: nobody else can have written
/// them, whatever `created_by` says after a list rename).
const TASKS_SQL: &str = "SELECT COALESCE(json_agg(t), '[]'::json)::text FROM ( \
    SELECT t.id, t.channel_id, t.list_id, t.parent_id, t.description, t.is_completed, \
           t.position, t.due_at, t.attachments, t.created_at, t.created_by \
    FROM channel_tasks t \
    WHERE t.created_by = $1::bigint \
       OR t.list_id IN (SELECT id FROM task_lists WHERE owner_id = $1::bigint) \
    ORDER BY t.id) t";

const UPLOADS_SQL: &str = "SELECT COALESCE(json_agg(t), '[]'::json)::text FROM ( \
    SELECT id, original_name, mime_type, size_bytes, kind, created_at, purge_after \
    FROM uploaded_files WHERE uploader_id = $1::bigint ORDER BY created_at, id) t";

/// Public halves only; `lan_info` is a client-encrypted blob and is handed
/// back as the ciphertext it is (the app holds the seed that opens it).
const DEVICES_SQL: &str = "SELECT COALESCE(json_agg(t), '[]'::json)::text FROM ( \
    SELECT id, name, platform, device_pub, sign_pub, host_enabled, \
           lan_info AS lan_info_ciphertext, created_at, last_seen_at, revoked_at \
    FROM devices WHERE user_id = $1::bigint ORDER BY created_at, id) t";

/// Session rows without their ids: a sid is not a credential on its own, but
/// there is nothing a user can do with one either.
const SESSIONS_SQL: &str = "SELECT COALESCE(json_agg(t), '[]'::json)::text FROM ( \
    SELECT device_id, created_at, last_seen_at, revoked_at, (sid = $2::text) AS is_this_session \
    FROM token_sessions WHERE user_id = $1::bigint ORDER BY created_at, sid) t";

const NOTIFICATION_PREFS_SQL: &str = "SELECT COALESCE((SELECT row_to_json(t) FROM ( \
    SELECT push_enabled, push_messages, push_mentions, push_dms, push_friend_requests, \
           quiet_hours_start, quiet_hours_end, updated_at \
    FROM notification_preferences WHERE user_id = $1::bigint) t), 'null'::json)::text";

pub(crate) async fn build_export(pool: &PgPool, claims: &Claims) -> Result<Value, sqlx::Error> {
    let uid = claims.sub;
    let mut tx = pool.begin().await?;
    // Pins how row_to_json renders every timestamptz in this transaction,
    // whatever the server's default zone is. LOCAL: gone at commit.
    sqlx::query("SET LOCAL TIME ZONE 'UTC'").execute(&mut *tx).await?;

    let profile = section(&mut tx, PROFILE_SQL, uid).await?;
    let servers = section(&mut tx, SERVERS_SQL, uid).await?;
    let friends = section(&mut tx, FRIENDS_SQL, uid).await?;
    let friend_requests = section(&mut tx, FRIEND_REQUESTS_SQL, uid).await?;
    let blocked_users = section(&mut tx, BLOCKED_SQL, uid).await?;
    let dm_conversations = section(&mut tx, DM_CONVERSATIONS_SQL, uid).await?;
    let dm_messages = section(&mut tx, DM_MESSAGES_SQL, uid).await?;
    let channel_messages = section(&mut tx, CHANNEL_MESSAGES_SQL, uid).await?;
    let reactions = section(&mut tx, REACTIONS_SQL, uid).await?;
    let task_lists = section(&mut tx, TASK_LISTS_SQL, uid).await?;
    let tasks = section(&mut tx, TASKS_SQL, uid).await?;
    let uploaded_files = section(&mut tx, UPLOADS_SQL, uid).await?;
    let devices = section(&mut tx, DEVICES_SQL, uid).await?;
    let sessions = {
        let (text,): (String,) = sqlx::query_as(SESSIONS_SQL)
            .bind(uid)
            .bind(&claims.sid)
            .fetch_one(&mut *tx)
            .await?;
        serde_json::from_str(&text).unwrap_or(Value::Null)
    };
    let notification_preferences = section(&mut tx, NOTIFICATION_PREFS_SQL, uid).await?;
    tx.commit().await?;

    Ok(json!({
        "format": EXPORT_FORMAT,
        "exported_at": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        "user_id": uid,
        "note": "Every time is UTC. Message bodies, task descriptions and personal list titles are the ciphertext the server stores — the app that produced this file adds a decrypted copy beside each one it could open. Only rows this account wrote are included; other people's messages are theirs.",
        "profile": profile,
        "servers": servers,
        "friends": friends,
        "friend_requests": friend_requests,
        "blocked_users": blocked_users,
        "dm_conversations": dm_conversations,
        "dm_messages": dm_messages,
        "channel_messages": channel_messages,
        "reactions": reactions,
        "task_lists": task_lists,
        "tasks": tasks,
        "uploaded_files": uploaded_files,
        "devices": devices,
        "sessions": sessions,
        "notification_preferences": notification_preferences,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::UserId;

    #[test]
    fn the_cooldown_admits_one_export_per_window_per_user() {
        let now = Instant::now();
        let uid = -9_000_001; // negative: cannot collide with a real account in the process-wide map
        assert_eq!(take_export_slot(uid, now), None, "first export goes ahead");
        let again = take_export_slot(uid, now + Duration::from_secs(10)).expect("second within the window is refused");
        assert!((45..=50).contains(&again), "says how long to wait, got {again}");
        // Another user is unaffected (per-user, not global).
        assert_eq!(take_export_slot(uid - 1, now + Duration::from_secs(10)), None);
        // And the window really ends.
        assert_eq!(take_export_slot(uid, now + EXPORT_COOLDOWN + Duration::from_secs(1)), None);
    }

    /// The whole handler against a real database: the gate, the throttle, and
    /// — the part no unit test can check — that every section's SQL is valid
    /// against the migrated schema and returns THIS user's rows and nobody
    /// else's. Skips (prints) without TEST_DATABASE_URL / DATABASE_URL, like
    /// auth::session_tests; the migrator is run first so a fresh database works.
    #[tokio::test]
    async fn the_export_carries_the_users_own_rows_and_only_theirs() {
        dotenv::dotenv().ok();
        let url = match std::env::var("TEST_DATABASE_URL").or_else(|_| std::env::var("DATABASE_URL")) {
            Ok(u) => u,
            Err(_) => { println!("skipping: no database"); return; }
        };
        let pool = match sqlx::postgres::PgPoolOptions::new().max_connections(2).connect(&url).await {
            Ok(p) => p,
            Err(_) => { println!("skipping: database unreachable"); return; }
        };
        sqlx::migrate!("./migrations").run(&pool).await.expect("migrations apply");
        let state = AppState::new(pool.clone(), "test-secret".into(), None, Arc::new(crate::wake::NullWake));

        let tag = uuid::Uuid::new_v4().simple().to_string();
        let mk_user = |name: String| {
            let pool = pool.clone();
            async move {
                let (id,): (i32,) = sqlx::query_as("INSERT INTO users (username, salt, verifier) VALUES ($1, $2, $3) RETURNING id")
                    .bind(&name).bind(b"s".as_ref()).bind(b"v".as_ref())
                    .fetch_one(&pool).await.expect("insert user");
                id
            }
        };
        let alice = mk_user(format!("exp_alice_{tag}")).await;
        let bob = mk_user(format!("exp_bob_{tag}")).await;

        // A server both are in, one channel, one message each.
        let server_id = format!("srv-{tag}");
        sqlx::query("INSERT INTO servers (id, name, owner_id) VALUES ($1, 'Export Server', $2)")
            .bind(&server_id).bind(alice).execute(&pool).await.unwrap();
        for u in [alice, bob] {
            sqlx::query("INSERT INTO server_members (server_id, user_id) VALUES ($1, $2)")
                .bind(&server_id).bind(u).execute(&pool).await.unwrap();
        }
        let (channel_id,): (i32,) = sqlx::query_as("INSERT INTO channels (name, server_id) VALUES ('general', $1) RETURNING id")
            .bind(&server_id).fetch_one(&pool).await.unwrap();
        let alice_ct = format!("{{\"v\":3,\"t\":\"ch\",\"epoch\":1,\"ct\":\"alice-{tag}\"}}");
        let bob_ct = format!("{{\"v\":3,\"t\":\"ch\",\"epoch\":1,\"ct\":\"bob-{tag}\"}}");
        for (who, ct) in [(alice, &alice_ct), (bob, &bob_ct)] {
            sqlx::query("INSERT INTO messages (id, channel_id, user_id, content, key_epoch) VALUES ($1, $2, $3, $4, 1)")
                .bind(uuid::Uuid::new_v4().to_string()).bind(channel_id).bind(who).bind(ct)
                .execute(&pool).await.unwrap();
        }
        // A DM thread with one message from each side.
        let conv = format!("dm-{tag}");
        sqlx::query("INSERT INTO dm_conversations (id, user1_id, user2_id) VALUES ($1, $2, $3)")
            .bind(&conv).bind(alice as i64).bind(bob as i64).execute(&pool).await.unwrap();
        let alice_dm = format!("{{\"v\":3,\"t\":\"dm\",\"ct\":\"alice-dm-{tag}\"}}");
        let bob_dm = format!("{{\"v\":3,\"t\":\"dm\",\"ct\":\"bob-dm-{tag}\"}}");
        for (who, ct) in [(alice, &alice_dm), (bob, &bob_dm)] {
            sqlx::query("INSERT INTO dm_messages (id, conversation_id, sender_id, content, encrypted) VALUES ($1, $2, $3, $4, TRUE)")
                .bind(uuid::Uuid::new_v4().to_string()).bind(&conv).bind(who as i64).bind(ct)
                .execute(&pool).await.unwrap();
        }
        // An upload, a personal list, a session, a friendship.
        sqlx::query("INSERT INTO uploaded_files (id, uploader_id, original_name, stored_name, mime_type, size_bytes) VALUES (gen_random_uuid(), $1, 'attachment.enc', $2, 'application/octet-stream', 1234)")
            .bind(alice).bind(format!("stored-{tag}")).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO task_lists (owner_id, title) VALUES ($1, $2)")
            .bind(alice as i64).bind(format!("list-{tag}")).execute(&pool).await.unwrap();
        let sid = format!("sid-{tag}");
        sqlx::query("INSERT INTO token_sessions (sid, user_id) VALUES ($1, $2)")
            .bind(&sid).bind(alice).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO friends (user1_id, user2_id) VALUES ($1, $2)")
            .bind(alice as i64).bind(bob as i64).execute(&pool).await.unwrap();

        let claims = Claims {
            sub: alice as UserId,
            username: format!("exp_alice_{tag}"),
            exp: 0,
            tv: 0,
            sst: 1_700_000_000,
            sid: sid.clone(),
        };

        // 1. A bare bearer token is refused: no recent password proof.
        let refused = export_account(State(state.clone()), Extension(claims.clone())).await;
        assert_eq!(refused.status(), StatusCode::UNAUTHORIZED, "the export must demand a password proof");

        // 2. Proven: the document carries Alice's rows.
        state.record_password_proof(claims.sub, claims.sst);
        let ok = export_account(State(state.clone()), Extension(claims.clone())).await;
        assert_eq!(ok.status(), StatusCode::OK);
        let body = axum::body::to_bytes(ok.into_body(), usize::MAX).await.unwrap();
        let doc: Value = serde_json::from_slice(&body).expect("the body is JSON");
        assert_eq!(doc["format"], EXPORT_FORMAT);
        assert_eq!(doc["profile"]["username"], format!("exp_alice_{tag}"));
        // The stored bodies, field by field (a substring search over the
        // re-serialised document would miss them: the envelope JSON inside a
        // string is escaped there).
        let contents = |section: &str| -> Vec<String> {
            doc[section]
                .as_array()
                .map(|rows| rows.iter().filter_map(|r| r["content"].as_str().map(String::from)).collect())
                .unwrap_or_default()
        };
        let ch = contents("channel_messages");
        let dm = contents("dm_messages");
        assert_eq!(ch, vec![alice_ct.clone()], "Alice's channel message, as stored, and ONLY hers — Bob's is his");
        assert_eq!(dm, vec![alice_dm.clone()], "Alice's DM, as stored, and only her side of it");
        assert!(!ch.contains(&bob_ct) && !dm.contains(&bob_dm));
        assert_eq!(doc["channel_messages"].as_array().map(|a| a.len()), Some(1));
        assert_eq!(doc["channel_messages"][0]["channel_name"], "general");
        assert_eq!(doc["channel_messages"][0]["server_name"], "Export Server");
        assert_eq!(doc["dm_messages"][0]["partner_user_id"], bob);
        assert_eq!(doc["dm_conversations"][0]["partner_username"], format!("exp_bob_{tag}"));
        assert_eq!(doc["servers"][0]["is_owner"], true);
        assert_eq!(doc["friends"][0]["user_id"], bob);
        assert_eq!(doc["uploaded_files"][0]["size_bytes"], 1234);
        assert_eq!(doc["task_lists"][0]["title"], format!("list-{tag}"));
        assert_eq!(doc["sessions"][0]["is_this_session"], true);
        // Times are UTC and say so — the naive TIMESTAMP columns were converted.
        let created = doc["channel_messages"][0]["created_at"].as_str().unwrap_or("");
        assert!(created.ends_with("+00:00") || created.ends_with('Z'), "timestamps must carry a UTC offset, got {created}");

        // 3. Straight away again: throttled, with a Retry-After.
        let again = export_account(State(state.clone()), Extension(claims.clone())).await;
        assert_eq!(again.status(), StatusCode::TOO_MANY_REQUESTS);
        assert!(again.headers().get(header::RETRY_AFTER).is_some());

        let _ = sqlx::query("DELETE FROM users WHERE id = $1 OR id = $2").bind(alice).bind(bob).execute(&pool).await;
        let _ = sqlx::query("DELETE FROM servers WHERE id = $1").bind(&server_id).execute(&pool).await;
    }
}
