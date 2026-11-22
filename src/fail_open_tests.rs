//! A lookup that FAILED is not an answer (src/try_again.rs).
//!
//! Each test drives a real handler against a real database
//! (TEST_DATABASE_URL; they skip themselves without one) with ONE lookup made
//! to fail through a pool of its own (src/fault_injection.rs: a per-test
//! schema on that pool's search_path, nothing global, dropped after). Each
//! pins two things:
//! - under the fault, the 503 + `Retry-After: 2` of a refusal to retry, never
//!   the 404 / 403 of a real "no" (which the client believes), and never a
//!   request let through a guard (a quota, a rate limit, a block, the owner's
//!   protection) whose check could not be read;
//! - as the CONTROL, the same request on a healthy pool getting its ordinary
//!   answer, admitted or refused for the real reason.

use crate::fault_injection::{app, claims, drop_faults, faulty_column_pool, faulty_pool, faulty_read_pool, user, Checks};
use crate::permissions::Permissions;
use crate::state::{AppState, ClipProposal, ClipVote, ClipVoter};
use axum::body::Body;
use axum::extract::{ConnectInfo, FromRequest, Multipart, Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use serde_json::json;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// `assert_eq!` / `assert!` into the test's [`Checks`], so every check is
/// reported, not only the first to fail.
macro_rules! check_eq {
    ($c:ident, $got:expr, $want:expr, $($m:tt)+) => { $c.eq(&$got, &$want, format!($($m)+)) };
}
macro_rules! check {
    ($c:ident, $ok:expr, $($m:tt)+) => { $c.that($ok, format!($($m)+)) };
}

/// A server with an owner and a plain member (@everyone = DEFAULT_MEMBER),
/// a text channel, an SFU voice channel and a collection.
struct World {
    owner: i64,
    member: i64,
    sid: String,
    text: i64,
    voice: i64,
    collection: i64,
}

async fn world(pool: &sqlx::PgPool) -> World {
    let owner = user(pool, "own").await;
    let member = user(pool, "mem").await;
    let sid = format!("srv_f503_{}", uuid::Uuid::new_v4().simple());
    sqlx::query("INSERT INTO servers (id, name, owner_id) VALUES ($1, 'f503', $2)")
        .bind(&sid)
        .bind(owner as i32)
        .execute(pool)
        .await
        .expect("server");
    for u in [owner, member] {
        sqlx::query("INSERT INTO server_members (server_id, user_id) VALUES ($1, $2)")
            .bind(&sid)
            .bind(u as i32)
            .execute(pool)
            .await
            .expect("member");
    }
    sqlx::query(
        "INSERT INTO server_roles (server_id, name, color, permissions, position, is_default) VALUES ($1, '@everyone', '#99AAB5', $2, 0, true)",
    )
    .bind(&sid)
    .bind(Permissions::DEFAULT_MEMBER.bits() as i64)
    .execute(pool)
    .await
    .expect("@everyone");
    let channel = |name: &'static str, kind: i32, sfu: bool| {
        let sid = sid.clone();
        async move {
            sqlx::query_as::<_, (i32,)>(
                "INSERT INTO channels (server_id, name, type, sfu_mode) VALUES ($1, $2, $3, $4) RETURNING id",
            )
            .bind(&sid)
            .bind(name)
            .bind(kind)
            .bind(sfu)
            .fetch_one(pool)
            .await
            .expect("channel")
            .0 as i64
        }
    };
    let text = channel("general", 0, false).await;
    let voice = channel("lounge", 1, true).await;
    let collection = channel("news", 2, false).await;
    World { owner, member, sid, text, voice, collection }
}

async fn drop_users(pool: &sqlx::PgPool, users: &[i64]) {
    let ids: Vec<i32> = users.iter().map(|u| *u as i32).collect();
    let stored: Vec<(String,)> = sqlx::query_as("DELETE FROM uploaded_files WHERE uploader_id = ANY($1) RETURNING stored_name")
        .bind(&ids)
        .fetch_all(pool)
        .await
        .unwrap_or_default();
    for (s,) in stored {
        let _ = std::fs::remove_file(format!("uploads/{s}"));
    }
    let _ = sqlx::query("DELETE FROM users WHERE id = ANY($1)").bind(&ids).execute(pool).await;
}

async fn drop_world(pool: &sqlx::PgPool, w: &World, extra: &[i64]) {
    let _ = sqlx::query("DELETE FROM servers WHERE id = $1").bind(&w.sid).execute(pool).await;
    let mut users = vec![w.owner, w.member];
    users.extend_from_slice(extra);
    drop_users(pool, &users).await;
}

fn has_retry_after(resp: &Response) -> bool {
    resp.headers().get(header::RETRY_AFTER).is_some()
}

async fn body_text(resp: Response) -> String {
    let bytes = axum::body::to_bytes(resp.into_body(), 1 << 20).await.expect("body");
    String::from_utf8_lossy(&bytes).into_owned()
}

// ---- the key routes ------------------------------------------------------------

/// GET /users/:id/public-key, /signing-key and /dm-keys. The own-key case is
/// the one the client acted on: two 404s for its own public key at sign-in
/// and it REFUSED the identity the password had unlocked (auth.ts,
/// checkPublishedOwnKey). A 503 is "no answer" there: adopted, checked again.
#[tokio::test]
async fn the_key_routes_answer_a_failed_lookup_with_a_503_not_a_404() {
    let Some((pool, url)) = crate::migrator::test_database(2).await else { return };
    let mut checks = Checks::default();
    let a = user(&pool, "a").await;
    let b = user(&pool, "b").await;
    let stranger = user(&pool, "str").await;
    for u in [a, b] {
        sqlx::query("UPDATE users SET public_key = $1, account_sign_pub = $2 WHERE id = $3")
            .bind(format!("x25519:key-of-{u}"))
            .bind(format!("ed25519:sign-of-{u}"))
            .bind(u as i32)
            .execute(&pool)
            .await
            .unwrap();
    }
    sqlx::query("INSERT INTO friends (user1_id, user2_id) VALUES ($1, $2)").bind(a.min(b)).bind(a.max(b)).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO dm_conversations (id, user1_id, user2_id) VALUES ($1, $2, $3)")
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(a.min(b))
        .bind(a.max(b))
        .execute(&pool)
        .await
        .unwrap();

    async fn public_key(pool: &sqlx::PgPool, me: i64, of: i64) -> Response {
        crate::handlers::get_user_public_key(State(app(pool)), Path(of), Extension(claims(me))).await.into_response()
    }
    async fn signing_key(pool: &sqlx::PgPool, me: i64, of: i64) -> Response {
        crate::device_handlers::get_signing_key(State(app(pool)), Extension(claims(me)), Path(of)).await.into_response()
    }
    async fn dm_keys(pool: &sqlx::PgPool, me: i64, of: i64) -> Response {
        crate::handlers::get_user_dm_keys(State(app(pool)), Path(of), Extension(claims(me))).await.into_response()
    }

    // CONTROLS on a healthy pool: the ordinary answers, the real 404 included.
    let healthy = [
        public_key(&pool, a, b).await.status(),
        public_key(&pool, a, a).await.status(),
        signing_key(&pool, a, b).await.status(),
        signing_key(&pool, a, a).await.status(),
        dm_keys(&pool, a, b).await.status(),
        dm_keys(&pool, a, a).await.status(),
    ];
    let stranger_no = [
        public_key(&pool, stranger, a).await.status(),
        signing_key(&pool, stranger, a).await.status(),
        dm_keys(&pool, stranger, a).await.status(),
    ];

    // The relationship lookup fails (friends is one of its tables).
    let (faulty, schema) = faulty_pool(&pool, &url, &["friends"]).await;
    let rel = [public_key(&faulty, a, b).await, signing_key(&faulty, a, b).await, dm_keys(&faulty, a, b).await];
    let self_through_rel_fault = public_key(&faulty, a, a).await.status();
    drop_faults(&pool, faulty, &schema).await;

    // The users row cannot be read: the own key at sign-in.
    let (faulty, schema) = faulty_pool(&pool, &url, &["users"]).await;
    let own = [public_key(&faulty, a, a).await, signing_key(&faulty, a, a).await, dm_keys(&faulty, a, a).await];
    drop_faults(&pool, faulty, &schema).await;

    // dm-keys' own lookups: the conversation row, then the session census
    // (which used to fold into an EMPTY list: a 200 saying "no v4 reader").
    let (faulty, schema) = faulty_pool(&pool, &url, &["dm_conversations"]).await;
    let conversation = dm_keys(&faulty, a, b).await;
    drop_faults(&pool, faulty, &schema).await;
    let (faulty, schema) = faulty_pool(&pool, &url, &["token_sessions"]).await;
    let census = dm_keys(&faulty, a, b).await;
    let key_through_census_fault = public_key(&faulty, a, b).await.status();
    drop_faults(&pool, faulty, &schema).await;

    drop_users(&pool, &[a, b, stranger]).await;
    check_eq!(checks, healthy, [StatusCode::OK; 6], "control: a friend and oneself are served");
    check_eq!(checks, stranger_no, [StatusCode::NOT_FOUND; 3], "control: a stranger's real 404 stays a 404");
    check_eq!(checks, self_through_rel_fault, StatusCode::OK, "control: oneself needs no relationship lookup");
    check_eq!(checks, key_through_census_fault, StatusCode::OK, "control: only dm-keys reads the session census");
    for (r, what) in rel.iter().zip(["public-key", "signing-key", "dm-keys"]) {
        checks.retry(r, &format!("{what}: the relationship lookup failed"));
    }
    for (r, what) in own.iter().zip(["public-key", "signing-key", "dm-keys"]) {
        checks.retry(r, &format!("{what} of oneself: the users row could not be read"));
    }
    checks.retry(&conversation, "dm-keys: the conversation lookup failed");
    checks.retry(&census, "dm-keys: the session census failed");
    checks.done();
}

/// PATCH /keys/public refuses to replace an established v3 identity key. The
/// lookup of the key on the row used to fold a failure into "no key yet" and
/// write over it. The fault is on the one column only, so the UPDATE after
/// it would go through (and did, before the fix).
#[tokio::test]
async fn an_established_identity_key_is_kept_when_its_lookup_fails() {
    let Some((pool, url)) = crate::migrator::test_database(2).await else { return };
    let mut checks = Checks::default();
    use base64::Engine;
    let a = user(&pool, "a").await;
    let key = |b: u8| format!("x25519:{}", base64::engine::general_purpose::STANDARD.encode([b; 32]));
    sqlx::query("UPDATE users SET public_key = $1, key_version = 3 WHERE id = $2").bind(key(1)).bind(a as i32).execute(&pool).await.unwrap();
    let patch = |pool: sqlx::PgPool, new: String| async move {
        let state = app(&pool);
        state.record_password_proof(a, 0);
        let req = crate::handlers::UpdatePublicKeyRequest { public_key: new };
        crate::handlers::update_public_key(State(state), Extension(claims(a)), Json(req)).await.into_response()
    };
    let healthy = patch(pool.clone(), key(2)).await.status();
    let (faulty, schema) = faulty_column_pool(&pool, &url, "users", "key_version").await;
    let faulted = patch(faulty.clone(), key(3)).await;
    drop_faults(&pool, faulty, &schema).await;
    let (stored,): (Option<String>,) = sqlx::query_as("SELECT public_key FROM users WHERE id = $1").bind(a as i32).fetch_one(&pool).await.unwrap();
    drop_users(&pool, &[a]).await;
    check_eq!(checks, healthy, StatusCode::CONFLICT, "control: a v3 key is not replaced");
    checks.retry(&faulted, "the key lookup failed");
    check_eq!(checks, stored, Some(key(1)), "the established key is still the one on the row");
    checks.done();
}

// ---- every REST gate on the channel permission resolver -------------------------

/// The resolver is made to fail at its LAST step (the overwrite rows), which
/// only it reads, so everything a handler asks before it answers. A member
/// gets the 503; the owner, whom the resolver answers before that step, is
/// the control that the pool itself answers.
#[tokio::test]
async fn every_rest_gate_on_the_channel_resolver_answers_a_failed_lookup_with_a_503() {
    let Some((pool, url)) = crate::migrator::test_database(2).await else { return };
    let mut checks = Checks::default();
    let w = world(&pool).await;
    let (faulty, schema) = faulty_pool(&pool, &url, &["channel_permission_overwrites"]).await;

    let resolver_fails = crate::permissions::try_user_channel_permissions(&faulty, w.text, w.member).await.is_err();
    let owner_resolves = crate::permissions::try_user_channel_permissions(&faulty, w.text, w.owner).await.is_ok();

    // (name, healthy answer for the member, the member through the fault)
    let mut seen: Vec<(&str, Response, Response)> = Vec::new();
    macro_rules! both {
        ($name:expr, $call:expr) => {{
            let call = $call;
            let healthy = call(&pool).await;
            let faulted = call(&faulty).await;
            seen.push(($name, healthy, faulted));
        }};
    }
    let (m, text, voice, coll) = (w.member, w.text, w.voice, w.collection);
    both!("GET /channels/:id/keys", |p: &sqlx::PgPool| {
        let s = app(p);
        async move { crate::key_handlers::get_channel_keys(State(s), Path(text), Extension(claims(m))).await.into_response() }
    });
    both!("GET /channels/:id/member-keys", |p: &sqlx::PgPool| {
        let s = app(p);
        async move { crate::key_handlers::get_member_keys(State(s), Path(text), Extension(claims(m))).await.into_response() }
    });
    both!("POST /channels/:id/keys", |p: &sqlx::PgPool| {
        let s = app(p);
        let req = serde_json::from_value(json!({ "epoch": 1, "keys": [] })).unwrap();
        async move { crate::key_handlers::publish_channel_keys(State(s), Path(text), Extension(claims(m)), Json(req)).await.into_response() }
    });
    both!("GET /channels/:id/messages", |p: &sqlx::PgPool| {
        let s = app(p);
        let q = serde_json::from_value(json!({})).unwrap();
        async move { crate::message_handlers::get_messages(State(s), Path(text), Query(q), Extension(claims(m))).await.into_response() }
    });
    both!("GET /channels/:id/feed", |p: &sqlx::PgPool| {
        let s = app(p);
        async move { crate::channel_handlers::get_channel_feed(State(s), Path(coll), Extension(claims(m))).await.into_response() }
    });
    both!("GET /channels/:id/overwrites", |p: &sqlx::PgPool| {
        let s = app(p);
        async move { crate::channel_handlers::list_overwrites(State(s), Path(text), Extension(claims(m))).await.into_response() }
    });
    both!("POST /channels/:id/read", |p: &sqlx::PgPool| {
        let s = app(p);
        async move { crate::server_handlers::mark_channel_read(State(s), Path(text), Extension(claims(m))).await.into_response() }
    });
    both!("GET /channels/:id/tasks", |p: &sqlx::PgPool| {
        let s = app(p);
        async move { crate::task_handlers::list_tasks(State(s), Path(text), Extension(claims(m))).await.into_response() }
    });
    both!("GET /channels/:id/sfu-token", |p: &sqlx::PgPool| {
        let s = app(p);
        async move { crate::sfu::get_sfu_token(State(s), Path(voice), Extension(claims(m))).await.into_response() }
    });
    both!("POST /channels/:id/clips", |p: &sqlx::PgPool| {
        let s = app(p);
        let req = serde_json::from_value(json!({ "target_channel_id": text, "duration_ms": 10000, "ended_ago_ms": 0 })).unwrap();
        async move { crate::clip_handlers::propose_clip(State(s), Extension(claims(m)), Path(voice), Json(req)).await.into_response() }
    });
    drop_faults(&pool, faulty, &schema).await;
    // get_sfu_token's own read of the channel (sfu_mode), after the gate.
    let (faulty, schema) = faulty_column_pool(&pool, &url, "channels", "sfu_mode").await;
    let sfu_row = crate::sfu::get_sfu_token(State(app(&faulty)), Path(w.voice), Extension(claims(w.member))).await.into_response();
    drop_faults(&pool, faulty, &schema).await;
    // The feed's own read of the collection, before the permission gate.
    let (faulty, schema) = faulty_pool(&pool, &url, &["channels"]).await;
    let feed_row = crate::channel_handlers::get_channel_feed(State(app(&faulty)), Path(w.collection), Extension(claims(w.member))).await.into_response();
    drop_faults(&pool, faulty, &schema).await;
    drop_world(&pool, &w, &[]).await;

    checks.retry(&sfu_row, "GET /channels/:id/sfu-token: the channel row could not be read");
    checks.retry(&feed_row, "GET /channels/:id/feed: the collection could not be read");
    check!(checks, resolver_fails, "the fault reaches the resolver for a member");
    check!(checks, owner_resolves, "control: the owner is answered before the faulted step");
    for (name, healthy, faulted) in &seen {
        check!(checks, 
            !has_retry_after(healthy) && healthy.status() != StatusCode::NOT_FOUND,
            "control, {name}: the member's ordinary answer on a healthy pool, got {}",
            healthy.status()
        );
        checks.retry(faulted, &format!("{name}: the permission lookup failed"));
    }
    checks.done();
}

// ---- uploads ---------------------------------------------------------------------

async fn multipart(fields: &[(&str, &[u8], bool)]) -> Multipart {
    let boundary = "f503-boundary";
    let mut body: Vec<u8> = Vec::new();
    for (name, data, is_file) in fields {
        body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
        if *is_file {
            body.extend_from_slice(
                format!("Content-Disposition: form-data; name=\"{name}\"; filename=\"f503.bin\"\r\nContent-Type: application/octet-stream\r\n\r\n").as_bytes(),
            );
        } else {
            body.extend_from_slice(format!("Content-Disposition: form-data; name=\"{name}\"\r\n\r\n").as_bytes());
        }
        body.extend_from_slice(data);
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    let req = Request::builder()
        .method("POST")
        .uri("/upload")
        .header(header::CONTENT_TYPE, format!("multipart/form-data; boundary={boundary}"))
        .body(Body::from(body))
        .unwrap();
    Multipart::from_request(req, &()).await.expect("multipart")
}

async fn upload(state: Arc<AppState>, caller: i64, headers: HeaderMap, fields: &[(&str, &[u8], bool)]) -> Response {
    std::fs::create_dir_all("uploads").expect("uploads dir");
    crate::upload_handlers::upload_file(
        State(state),
        Extension(claims(caller)),
        headers,
        ConnectInfo("127.0.0.1:40001".parse().unwrap()),
        multipart(fields).await,
    )
    .await
    .into_response()
}

async fn uploads_of(pool: &sqlx::PgPool, user: i64) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM uploaded_files WHERE uploader_id = $1").bind(user as i32).fetch_one(pool).await.unwrap()
}

fn approved_clip(proposer: i64, voter: Option<i64>, w: &World) -> ClipProposal {
    ClipProposal {
        clip_id: uuid::Uuid::new_v4().to_string(),
        proposer,
        proposer_username: format!("u{proposer}"),
        server_id: w.sid.clone(),
        voice_channel_id: w.voice,
        voice_channel_name: "lounge".into(),
        target_channel_id: w.text,
        target_channel_name: "general".into(),
        window_start_ms: 0,
        window_end_ms: 10_000,
        duration_ms: 10_000,
        votes: voter
            .map(|v| ClipVoter { user_id: v, username: format!("u{v}"), vote: ClipVote::Pending, had_camera: false, had_share: false, in_window: true })
            .into_iter()
            .collect(),
        solo: voter.is_none(),
        created: Instant::now(),
        expires: Instant::now() + Duration::from_secs(300),
        approved_at: if voter.is_none() { Some(Instant::now()) } else { None },
    }
}

/// POST /upload's three guards. Each used to fold a failed lookup into a
/// pass: the storage quota into an empty account, the clip-part cap into zero
/// parts, ATTACH_FILES into a 403. The quota and the clip cap are shown with
/// the READ of uploaded_files failing while its INSERT still goes through,
/// so the upload WOULD land: it must be refused, and nothing stored.
#[tokio::test]
async fn an_upload_is_refused_when_its_guards_cannot_be_read() {
    let Some((pool, url)) = crate::migrator::test_database(2).await else { return };
    let mut checks = Checks::default();
    let w = world(&pool).await;
    let data: &[u8] = b"f503 bytes";

    // The storage quota.
    let healthy = upload(app(&pool), w.member, HeaderMap::new(), &[("file", data, true)]).await.status();
    let stored_healthy = uploads_of(&pool, w.member).await;
    let (faulty, schema) = faulty_read_pool(&pool, &url, "uploaded_files").await;
    let quota = upload(app(&faulty), w.member, HeaderMap::new(), &[("file", data, true)]).await;
    drop_faults(&pool, faulty, &schema).await;
    let stored_after_quota = uploads_of(&pool, w.member).await;

    // The clip-part cap: a live, approved proposal of the member's own.
    let clip = approved_clip(w.member, None, &w);
    let cid = clip.clip_id.clone();
    let clip_fields = |idx: &'static [u8]| -> Vec<(&'static str, Vec<u8>, bool)> {
        vec![("kind", b"clip".to_vec(), false), ("clip_id", cid.clone().into_bytes(), false), ("part_index", idx.to_vec(), false), ("file", b"part".to_vec(), true)]
    };
    let member = w.member;
    let send_clip = |state: Arc<AppState>, idx: &'static [u8]| {
        let f = clip_fields(idx);
        async move {
            let fields: Vec<(&str, &[u8], bool)> = f.iter().map(|(n, d, file)| (*n, d.as_slice(), *file)).collect();
            upload(state, member, HeaderMap::new(), &fields).await
        }
    };
    let state = app(&pool);
    state.clip_proposals.insert(cid.clone(), clip.clone());
    let clip_healthy = send_clip(Arc::clone(&state), b"0").await.status();
    let (faulty, schema) = faulty_read_pool(&pool, &url, "uploaded_files").await;
    let state = app(&faulty);
    state.clip_proposals.insert(cid.clone(), clip.clone());
    let clip_cap = send_clip(state, b"1").await;
    drop_faults(&pool, faulty, &schema).await;
    // The lookup that makes a retried part idempotent: the second read.
    let (faulty, schema) = crate::fault_injection::faulty_after_pool(&pool, &url, "uploaded_files", 1).await;
    let state = app(&faulty);
    state.clip_proposals.insert(cid.clone(), clip.clone());
    let clip_retry = send_clip(state, b"1").await;
    drop_faults(&pool, faulty, &schema).await;
    let parts: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM uploaded_files WHERE clip_id = $1::uuid").bind(&cid).fetch_one(&pool).await.unwrap();

    // ATTACH_FILES, named by the X-Puca-Channel header.
    let mut headers = HeaderMap::new();
    headers.insert("x-puca-channel", HeaderValue::from_str(&w.text.to_string()).unwrap());
    let attach_healthy = upload(app(&pool), w.member, headers.clone(), &[("file", data, true)]).await.status();
    let (faulty, schema) = faulty_pool(&pool, &url, &["channel_permission_overwrites"]).await;
    let attach = upload(app(&faulty), w.member, headers, &[("file", data, true)]).await;
    drop_faults(&pool, faulty, &schema).await;

    drop_world(&pool, &w, &[]).await;
    check_eq!(checks, healthy, StatusCode::OK, "control: an upload under the quota is stored");
    check_eq!(checks, stored_healthy, 1, "control: it is stored");
    checks.retry(&quota, "the quota sum failed");
    check_eq!(checks, stored_after_quota, 1, "nothing was stored past a quota that could not be read");
    check_eq!(checks, clip_healthy, StatusCode::OK, "control: an approved clip part is stored");
    checks.retry(&clip_cap, "the clip-part count failed");
    checks.retry(&clip_retry, "the clip part's own lookup failed");
    check_eq!(checks, parts, 1, "no part was stored past a cap that could not be read");
    check_eq!(checks, attach_healthy, StatusCode::OK, "control: a member may attach in the channel");
    checks.retry(&attach, "the ATTACH_FILES lookup failed");
    checks.done();
}

// ---- clips -------------------------------------------------------------------

/// The REST clip views. A vote answered 404 drops the prompt for good
/// ("That clip request is no longer waiting.", clipProposals.ts), and the
/// pending list left the proposal out.
#[tokio::test]
async fn the_clip_views_answer_a_failed_lookup_with_a_503() {
    let Some((pool, url)) = crate::migrator::test_database(2).await else { return };
    let mut checks = Checks::default();
    let w = world(&pool).await;
    let clip = approved_clip(w.owner, Some(w.member), &w);
    let cid = clip.clip_id.clone();
    let with_clip = |p: &sqlx::PgPool| {
        let s = app(p);
        s.clip_proposals.insert(cid.clone(), clip.clone());
        s
    };
    let (faulty, schema) = faulty_pool(&pool, &url, &["channel_permission_overwrites"]).await;
    let fs = with_clip(&faulty);
    let vote = crate::clip_handlers::vote_clip(State(Arc::clone(&fs)), Extension(claims(w.member)), Path(cid.clone()), Json(serde_json::from_value(json!({ "approve": true })).unwrap())).await;
    let still_pending = fs.clip_proposals.get(&cid).map(|p| p.votes[0].vote == ClipVote::Pending).unwrap_or(false);
    let get = crate::clip_handlers::get_clip(State(Arc::clone(&fs)), Extension(claims(w.member)), Path(cid.clone())).await;
    let pending = crate::clip_handlers::list_pending_clips(State(Arc::clone(&fs)), Extension(claims(w.member))).await;
    drop_faults(&pool, faulty, &schema).await;

    let hs = with_clip(&pool);
    let get_healthy = crate::clip_handlers::get_clip(State(Arc::clone(&hs)), Extension(claims(w.member)), Path(cid.clone())).await.status();
    let pending_healthy = body_text(crate::clip_handlers::list_pending_clips(State(Arc::clone(&hs)), Extension(claims(w.member))).await).await;
    let vote_healthy = crate::clip_handlers::vote_clip(State(Arc::clone(&hs)), Extension(claims(w.member)), Path(cid.clone()), Json(serde_json::from_value(json!({ "approve": true })).unwrap())).await.status();
    drop_world(&pool, &w, &[]).await;

    check_eq!(checks, get_healthy, StatusCode::OK, "control: an approver sees the clip");
    check!(checks, pending_healthy.contains(&cid), "control: and it is in their pending list: {pending_healthy}");
    check_eq!(checks, vote_healthy, StatusCode::OK, "control: and may vote on it");
    checks.retry(&vote, "vote: the permission lookup failed");
    check!(checks, still_pending, "a vote that could not be checked was not counted");
    checks.retry(&get, "GET /clips/:id: the permission lookup failed");
    checks.retry(&pending, "GET /clips/pending: the permission lookup failed");
    checks.done();
}

// ---- reactions and reports -----------------------------------------------------

async fn channel_message(pool: &sqlx::PgPool, channel: i64, author: i64) -> String {
    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO messages (id, channel_id, user_id, content) VALUES ($1, $2, $3, 'hello')")
        .bind(&id)
        .bind(channel as i32)
        .bind(author as i32)
        .execute(pool)
        .await
        .expect("message");
    id
}

async fn react(pool: &sqlx::PgPool, message: &str, who: i64) -> Response {
    crate::reaction_handlers::add_reaction(
        State(app(pool)),
        Path(message.to_string()),
        Extension(claims(who)),
        Json(serde_json::from_value(json!({ "emoji": "+1" })).unwrap()),
    )
    .await
    .into_response()
}

/// POST /messages/:id/reactions: the message-view check (a channel message's
/// permissions, a DM's participants), the DM block check that used to let a
/// blocked user's reaction through, and the per-message cap whose count used
/// to fold into zero.
#[tokio::test]
async fn a_reaction_is_refused_when_its_checks_cannot_be_read() {
    let Some((pool, url)) = crate::migrator::test_database(2).await else { return };
    let mut checks = Checks::default();
    let w = world(&pool).await;
    let msg = channel_message(&pool, w.text, w.owner).await;
    // A DM between the member and a friend of theirs.
    let friend = user(&pool, "fr").await;
    let conv = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO dm_conversations (id, user1_id, user2_id) VALUES ($1, $2, $3)")
        .bind(&conv)
        .bind(w.member.min(friend))
        .bind(w.member.max(friend))
        .execute(&pool)
        .await
        .unwrap();
    let dm = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO dm_messages (id, conversation_id, sender_id, content) VALUES ($1, $2, $3, 'hi')")
        .bind(&dm)
        .bind(&conv)
        .bind(friend)
        .execute(&pool)
        .await
        .unwrap();

    let mut faulted = Vec::new();
    for (table, message, why) in [
        ("channel_permission_overwrites", msg.as_str(), "the channel permission lookup failed"),
        ("message_reactions", msg.as_str(), "the reaction cap's count failed"),
        ("dm_conversations", dm.as_str(), "the DM participant lookup failed"),
        ("blocked_users", dm.as_str(), "the DM block lookup failed"),
    ] {
        let (faulty, schema) = faulty_pool(&pool, &url, &[table]).await;
        faulted.push((react(&faulty, message, w.member).await, why));
        drop_faults(&pool, faulty, &schema).await;
    }
    let reactions_while_faulted: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM message_reactions WHERE message_id = ANY($1)")
        .bind(vec![msg.clone(), dm.clone()])
        .fetch_one(&pool)
        .await
        .unwrap();
    let healthy = [react(&pool, &msg, w.member).await.status(), react(&pool, &dm, w.member).await.status()];
    let _ = sqlx::query("DELETE FROM message_reactions WHERE message_id = ANY($1)").bind(vec![msg.clone(), dm.clone()]).execute(&pool).await;
    let _ = sqlx::query("DELETE FROM dm_conversations WHERE id = $1").bind(&conv).execute(&pool).await;
    drop_world(&pool, &w, &[friend]).await;

    check_eq!(checks, healthy, [StatusCode::CREATED; 2], "control: the member may react to both");
    for (r, why) in &faulted {
        checks.retry(r, why);
    }
    check_eq!(checks, reactions_while_faulted, 0, "no reaction was stored past a check that could not be read");
    checks.done();
}

/// POST /servers/:id/reports: the reported message's view check (it used to
/// read as "not a message in this server", a 400) and the per-hour limit,
/// whose count used to fold into zero.
#[tokio::test]
async fn a_report_is_refused_when_its_checks_cannot_be_read() {
    let Some((pool, url)) = crate::migrator::test_database(2).await else { return };
    let mut checks = Checks::default();
    let w = world(&pool).await;
    let msg = channel_message(&pool, w.text, w.owner).await;
    let report = |p: &sqlx::PgPool, message: Option<String>| {
        let s = app(p);
        let sid = w.sid.clone();
        let m = w.member;
        async move {
            let req = serde_json::from_value(json!({ "reported_message_id": message, "report_type": "spam", "reason": "f503" })).unwrap();
            crate::moderation_handlers::create_report(State(s), Path(sid), Extension(claims(m)), Json(req)).await.into_response()
        }
    };
    let (faulty, schema) = faulty_pool(&pool, &url, &["channel_permission_overwrites"]).await;
    let view = report(&faulty, Some(msg.clone())).await;
    drop_faults(&pool, faulty, &schema).await;
    let (faulty, schema) = faulty_read_pool(&pool, &url, "reports").await;
    let limit = report(&faulty, None).await;
    drop_faults(&pool, faulty, &schema).await;
    let filed_while_faulted: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM reports WHERE server_id = $1").bind(&w.sid).fetch_one(&pool).await.unwrap();
    let healthy = report(&pool, Some(msg.clone())).await.status();
    let _ = sqlx::query("DELETE FROM reports WHERE server_id = $1").bind(&w.sid).execute(&pool).await;
    drop_world(&pool, &w, &[]).await;

    check!(checks, healthy.is_success(), "control: the member may report a message they can see, got {healthy}");
    checks.retry(&view, "the reported message's view check failed");
    checks.retry(&limit, "the report limit's count failed");
    check_eq!(checks, filed_while_faulted, 0, "no report was filed past a limit that could not be read");
    checks.done();
}

// ---- sending a message ---------------------------------------------------------

async fn send(state: Arc<AppState>, channel: i64, who: i64, body: serde_json::Value) -> Response {
    crate::message_handlers::send_message(State(state), Path(channel), Extension(claims(who)), Json(serde_json::from_value(body).unwrap()))
        .await
        .into_response()
}

/// Slowmode: the channel's setting and the member's last message were both
/// read with a failure folded into "none", which switched slowmode off for a
/// busy moment. Then a clip post, whose part list used to be read AFTER the
/// approval was consumed and folded into an empty list, posted for good.
#[tokio::test]
async fn sending_fails_closed_when_slowmode_or_a_clip_cannot_be_read() {
    let Some((pool, url)) = crate::migrator::test_database(2).await else { return };
    let mut checks = Checks::default();
    let w = world(&pool).await;
    sqlx::query("UPDATE channels SET slowmode_seconds = 300 WHERE id = $1").bind(w.text as i32).execute(&pool).await.unwrap();
    let msg = |n: u32| json!({ "content": format!("f503 {n}") });
    let first = send(app(&pool), w.text, w.member, msg(1)).await.status();
    let second = send(app(&pool), w.text, w.member, msg(2)).await.status();
    let (faulty, schema) = faulty_column_pool(&pool, &url, "channels", "slowmode_seconds").await;
    let setting = send(app(&faulty), w.text, w.member, msg(3)).await;
    drop_faults(&pool, faulty, &schema).await;
    let (faulty, schema) = faulty_read_pool(&pool, &url, "messages").await;
    let last_message = send(app(&faulty), w.text, w.member, msg(4)).await;
    drop_faults(&pool, faulty, &schema).await;
    let sent: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM messages WHERE channel_id = $1 AND user_id = $2")
        .bind(w.text as i32)
        .bind(w.member as i32)
        .fetch_one(&pool)
        .await
        .unwrap();

    // A clip post. Clips on, slowmode off, an approved solo clip of the member's.
    sqlx::query("UPDATE channels SET slowmode_seconds = 0 WHERE id = $1").bind(w.text as i32).execute(&pool).await.unwrap();
    sqlx::query("UPDATE servers SET clips_enabled = true, clip_channel_id = $1 WHERE id = $2").bind(w.text as i32).bind(&w.sid).execute(&pool).await.unwrap();
    let clip = approved_clip(w.member, None, &w);
    let post = |s: &Arc<AppState>| {
        s.clip_proposals.insert(clip.clip_id.clone(), clip.clone());
        send(Arc::clone(s), w.text, w.member, json!({ "content": "clip", "clip_id": clip.clip_id }))
    };
    let (faulty, schema) = faulty_pool(&pool, &url, &["uploaded_files"]).await;
    let fs = app(&faulty);
    let parts = post(&fs).await;
    let kept_after_parts = fs.clip_proposals.contains_key(&clip.clip_id);
    drop_faults(&pool, faulty, &schema).await;
    let (faulty, schema) = faulty_column_pool(&pool, &url, "servers", "clips_enabled").await;
    let fs = app(&faulty);
    let enabled = post(&fs).await;
    let kept_after_enabled = fs.clip_proposals.contains_key(&clip.clip_id);
    drop_faults(&pool, faulty, &schema).await;
    let hs = app(&pool);
    let posted = post(&hs).await.status();
    let consumed = !hs.clip_proposals.contains_key(&clip.clip_id);
    let _ = sqlx::query("DELETE FROM messages WHERE channel_id = $1").bind(w.text as i32).execute(&pool).await;
    drop_world(&pool, &w, &[]).await;

    check_eq!(checks, (first, second), (StatusCode::OK, StatusCode::TOO_MANY_REQUESTS), "control: slowmode holds the second message back");
    checks.retry(&setting, "the slowmode setting could not be read");
    checks.retry(&last_message, "the member's last message could not be read");
    check_eq!(checks, sent, 1, "no message went past a slowmode that could not be read");
    checks.retry(&parts, "the clip's part list could not be read");
    check!(checks, kept_after_parts, "and the approval is kept for the retry");
    checks.retry(&enabled, "the server's clip setting could not be read");
    check!(checks, kept_after_enabled, "and the approval is kept for the retry");
    check_eq!(checks, posted, StatusCode::OK, "control: the clip posts on a healthy pool");
    check!(checks, consumed, "control: posting consumes the approval");
    checks.done();
}

// ---- tasks -----------------------------------------------------------------------

async fn create_task(pool: &sqlx::PgPool, w: &World, body: serde_json::Value) -> Response {
    crate::task_handlers::create_task(State(app(pool)), Path(w.text), Extension(claims(w.member)), Json(serde_json::from_value(body).unwrap()))
        .await
        .into_response()
}

/// The checklist cap (a count folded into zero), the parent check, and the
/// task lookup the write routes share (both folded into "not found").
#[tokio::test]
async fn task_writes_answer_a_failed_lookup_with_a_503() {
    let Some((pool, url)) = crate::migrator::test_database(2).await else { return };
    let mut checks = Checks::default();
    let w = world(&pool).await;
    let created = create_task(&pool, &w, json!({ "description": "parent" })).await;
    let created_status = created.status();
    let parent: serde_json::Value = serde_json::from_str(&body_text(created).await).unwrap_or_default();
    let parent_id = parent["id"].as_i64().unwrap_or(-1);
    let (faulty, schema) = faulty_pool(&pool, &url, &["channel_tasks"]).await;
    let cap = create_task(&faulty, &w, json!({ "description": "child" })).await;
    let with_parent = create_task(&faulty, &w, json!({ "description": "child", "parent_id": parent_id })).await;
    let update = crate::task_handlers::update_task(
        State(app(&faulty)),
        Path(parent_id),
        Extension(claims(w.member)),
        Json(serde_json::from_value(json!({ "is_completed": true })).unwrap()),
    )
    .await
    .into_response();
    drop_faults(&pool, faulty, &schema).await;
    // The depth walk is validate_parent's SECOND read of channel_tasks.
    let (faulty, schema) = crate::fault_injection::faulty_after_pool(&pool, &url, "channel_tasks", 1).await;
    let depth = create_task(&faulty, &w, json!({ "description": "child", "parent_id": parent_id })).await;
    drop_faults(&pool, faulty, &schema).await;
    let child = create_task(&pool, &w, json!({ "description": "child", "parent_id": parent_id })).await.status();
    let tasks: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM channel_tasks WHERE channel_id = $1").bind(w.text).fetch_one(&pool).await.unwrap();
    drop_world(&pool, &w, &[]).await;

    check_eq!(checks, created_status, StatusCode::OK, "control: a member creates a task");
    check_eq!(checks, child, StatusCode::OK, "control: and a subtask of it");
    check_eq!(checks, tasks, 2, "nothing was created through the fault");
    checks.retry(&cap, "the checklist cap's count failed");
    checks.retry(&with_parent, "the parent lookup failed");
    checks.retry(&depth, "the parent's depth walk failed");
    checks.retry(&update, "the task lookup failed");
    checks.done();
}

// ---- moderation --------------------------------------------------------------------

/// Kick and ban protect the owner twice: a lookup of the owner, then the rank
/// check (can_moderate). Both folded a failure into "not the owner": a
/// moderator whose request met a database that could not read
/// servers.owner_id could kick the owner out of their own server.
#[tokio::test]
async fn the_owner_cannot_be_kicked_or_banned_through_a_failed_lookup() {
    let Some((pool, url)) = crate::migrator::test_database(2).await else { return };
    let mut checks = Checks::default();
    let w = world(&pool).await;
    let moderator = user(&pool, "mod").await;
    sqlx::query("INSERT INTO server_members (server_id, user_id) VALUES ($1, $2)").bind(&w.sid).bind(moderator as i32).execute(&pool).await.unwrap();
    let (role,): (i64,) = sqlx::query_as(
        "INSERT INTO server_roles (server_id, name, color, permissions, position, is_default) VALUES ($1, 'Mod', '#99AAB5', $2, 1, false) RETURNING id",
    )
    .bind(&w.sid)
    .bind((Permissions::KICK_MEMBERS | Permissions::BAN_MEMBERS | Permissions::MUTE_MEMBERS | Permissions::MANAGE_ROLES).bits() as i64)
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO member_roles (server_id, user_id, role_id) VALUES ($1, $2, $3)").bind(&w.sid).bind(moderator as i32).bind(role).execute(&pool).await.unwrap();
    let kick = |p: &sqlx::PgPool, target: i64| {
        let s = app(p);
        let sid = w.sid.clone();
        async move {
            crate::moderation_handlers::kick_member(State(s), Path((sid, target)), Extension(claims(moderator)), Json(serde_json::from_value(json!({})).unwrap()))
                .await
                .into_response()
        }
    };
    let ban = |p: &sqlx::PgPool, target: i64| {
        let s = app(p);
        let sid = w.sid.clone();
        async move {
            crate::moderation_handlers::ban_member(State(s), Path((sid, target)), Extension(claims(moderator)), Json(serde_json::from_value(json!({})).unwrap()))
                .await
                .into_response()
        }
    };
    // The other routes that ask can_moderate, each aimed at the owner.
    let (low,): (i64,) = sqlx::query_as(
        "INSERT INTO server_roles (server_id, name, color, permissions, position, is_default) VALUES ($1, 'Low', '#99AAB5', 0, 0, false) RETURNING id",
    )
    .bind(&w.sid)
    .fetch_one(&pool)
    .await
    .unwrap();
    let others = |p: &sqlx::PgPool| {
        let p = p.clone();
        let sid = w.sid.clone();
        let owner = w.owner;
        async move {
            let by = || Extension(claims(moderator));
            vec![
                ("timeout", crate::moderation_handlers::timeout_member(
                    State(app(&p)), Path((sid.clone(), owner)), by(),
                    Json(serde_json::from_value(json!({ "duration_seconds": 60 })).unwrap()),
                ).await.into_response()),
                ("lift timeout", crate::moderation_handlers::remove_timeout(State(app(&p)), Path((sid.clone(), owner)), by()).await.into_response()),
                ("custom sounds", crate::moderation_handlers::set_member_custom_sounds(
                    State(app(&p)), Path((sid.clone(), owner)), by(),
                    Json(serde_json::from_value(json!({ "disabled": true })).unwrap()),
                ).await.into_response()),
                ("assign role", crate::role_handlers::assign_role(State(app(&p)), Path((sid.clone(), owner, low)), by()).await.into_response()),
                ("remove role", crate::role_handlers::remove_role(State(app(&p)), Path((sid.clone(), owner, low)), by()).await.into_response()),
            ]
        }
    };
    let healthy = (kick(&pool, w.owner).await.status(), ban(&pool, w.owner).await.status());
    let others_healthy: Vec<(&str, StatusCode)> = others(&pool).await.into_iter().map(|(n, r)| (n, r.status())).collect();
    let (faulty, schema) = faulty_column_pool(&pool, &url, "servers", "owner_id").await;
    let rank = crate::permissions::can_moderate(&faulty, &w.sid, moderator, w.owner).await;
    let faulted = (kick(&faulty, w.owner).await, ban(&faulty, w.owner).await);
    let others_faulted = others(&faulty).await;
    drop_faults(&pool, faulty, &schema).await;
    let owner_untouched: bool = sqlx::query_scalar(
        "SELECT NOT EXISTS (SELECT 1 FROM member_roles WHERE server_id = $1 AND user_id = $2) \
            AND NOT EXISTS (SELECT 1 FROM member_timeouts WHERE server_id = $1 AND user_id = $2) \
            AND NOT EXISTS (SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2 AND custom_sounds_disabled)",
    )
    .bind(&w.sid)
    .bind(w.owner as i32)
    .fetch_one(&pool)
    .await
    .unwrap();
    let owner_still_in: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2)")
        .bind(&w.sid)
        .bind(w.owner as i32)
        .fetch_one(&pool)
        .await
        .unwrap();
    let owner_banned: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM bans WHERE server_id = $1 AND user_id = $2)")
        .bind(&w.sid)
        .bind(w.owner as i32)
        .fetch_one(&pool)
        .await
        .unwrap();
    let member_kicked = kick(&pool, w.member).await.status();
    drop_world(&pool, &w, &[moderator]).await;

    check_eq!(checks, healthy, (StatusCode::FORBIDDEN, StatusCode::FORBIDDEN), "control: the owner cannot be kicked or banned");
    check_eq!(checks, member_kicked, StatusCode::OK, "control: the moderator may kick a plain member");
    check!(checks, rank.is_err(), "the rank check reports the failed lookup: {rank:?}");
    checks.retry(&faulted.0, "kick: the owner lookup failed");
    checks.retry(&faulted.1, "ban: the owner lookup failed");
    check!(checks, owner_still_in && !owner_banned, "the owner is still a member, and not banned");
    for (name, status) in &others_healthy {
        check_eq!(checks, *status, StatusCode::FORBIDDEN, "control: {name} on the owner is refused");
    }
    for (name, r) in &others_faulted {
        checks.retry(r, &format!("{name}: the rank lookup failed"));
    }
    check!(checks, owner_untouched, "the owner was not timed out, muted or given a role");
    checks.done();
}

// ---- email -----------------------------------------------------------------------

fn with_mail(pool: &sqlx::PgPool) -> Arc<AppState> {
    // A relay nobody listens on: a send fails at once and reaches nobody.
    let mail = crate::email::EmailService::new(crate::email::EmailConfig {
        smtp_host: "127.0.0.1".into(),
        smtp_port: 1,
        smtp_username: "f503".into(),
        smtp_password: "f503".into(),
        from_email: "f503@test.invalid".into(),
        app_url: "http://127.0.0.1:1".into(),
    });
    AppState::new(pool.clone(), "test-secret".into(), Some(mail), Arc::new(crate::wake::NullWake))
}

/// The two mail limiters. The verification-mail one deliberately opened on a
/// failed count; the reset one did so silently. The token tables' READS fail
/// while their INSERTs go through, so a request past the limiter would leave
/// a token row: there must be none. The reset route keeps its generic answer
/// (a 503 there would say which addresses have an account) and sends nothing.
#[tokio::test]
async fn the_mail_limiters_fail_closed() {
    let Some((pool, url)) = crate::migrator::test_database(2).await else { return };
    let mut checks = Checks::default();
    let a = user(&pool, "mail").await;
    let address = format!("f503-{}@test.invalid", uuid::Uuid::new_v4().simple());
    sqlx::query("UPDATE users SET email = $1, email_verified = true WHERE id = $2").bind(&address).bind(a as i32).execute(&pool).await.unwrap();
    let verify = |p: &sqlx::PgPool| {
        let s = with_mail(p);
        let req = crate::email_handlers::SendVerificationRequest { email: format!("new-{}@test.invalid", a) };
        async move { crate::email_handlers::send_verification_email(State(s), Extension(claims(a)), Json(req)).await }
    };
    let forgot = |p: &sqlx::PgPool| {
        let s = with_mail(p);
        let req = crate::email_handlers::ForgotPasswordRequest { email: address.clone() };
        async move { crate::email_handlers::forgot_password(State(s), Json(req)).await }
    };
    let tokens = |table: &'static str| {
        let pool = pool.clone();
        async move {
            sqlx::query_scalar::<_, i64>(&format!("SELECT COUNT(*) FROM {table} WHERE user_id = $1"))
                .bind(a as i32)
                .fetch_one(&pool)
                .await
                .unwrap()
        }
    };

    let (faulty, schema) = faulty_read_pool(&pool, &url, "email_verification_tokens").await;
    let verify_limit = verify(&faulty).await;
    drop_faults(&pool, faulty, &schema).await;
    let verify_tokens_faulted = tokens("email_verification_tokens").await;
    let (faulty, schema) = faulty_read_pool(&pool, &url, "password_reset_tokens").await;
    let forgot_limit = forgot(&faulty).await.status();
    drop_faults(&pool, faulty, &schema).await;
    let reset_tokens_faulted = tokens("password_reset_tokens").await;
    let (faulty, schema) = faulty_pool(&pool, &url, &["users"]).await;
    let verify_user = verify(&faulty).await;
    let forgot_user = forgot(&faulty).await;
    drop_faults(&pool, faulty, &schema).await;

    let verify_healthy = body_text(verify(&pool).await).await;
    let forgot_healthy = forgot(&pool).await.status();
    let reset_tokens_healthy = tokens("password_reset_tokens").await;
    drop_users(&pool, &[a]).await;

    check!(checks, verify_healthy.contains("Failed to send verification email"), "control: past the limiter to the (refused) relay: {verify_healthy}");
    check_eq!(checks, forgot_healthy, StatusCode::OK, "control: the reset route answers");
    check_eq!(checks, reset_tokens_healthy, 1, "control: a reset under the limit mints a token");
    checks.retry(&verify_limit, "the verification-mail limit's count failed");
    check_eq!(checks, verify_tokens_faulted, 0, "no verification token was minted past it");
    check_eq!(checks, forgot_limit, StatusCode::OK, "the reset route keeps its one generic answer");
    check_eq!(checks, reset_tokens_faulted, 0, "and minted no token past a limit it could not read");
    checks.retry(&verify_user, "verification: the account lookup failed");
    checks.retry(&forgot_user, "reset: the account lookup failed (before anything about the address is known)");
    checks.done();
}

// ---- voice moves -----------------------------------------------------------------

/// A socket for `user`, in `room`, on `state` (kept open by the returned receiver).
fn in_voice(state: &Arc<AppState>, user: i64, channel: i64) -> tokio::sync::mpsc::Receiver<crate::protocol::ServerMessage> {
    let (tx, rx) = tokio::sync::mpsc::channel(256);
    let (conn, _, _) = state.register_session(user, format!("u{user}"), tx, false, None, format!("s{user}"));
    state.join_room(&format!("voice_{channel}"), user, conn);
    rx
}

/// A voice move checks the MOVER sees the source room and the person moved
/// may join the destination; Call everyone back checks the caller sees the
/// mode's main room. Each read a failed lookup as "cannot see it" and
/// answered "not in a voice channel", "can't join", "no main voice channel".
#[tokio::test]
async fn the_voice_moves_answer_a_failed_permission_lookup_with_a_503() {
    let Some((pool, url)) = crate::migrator::test_database(2).await else { return };
    let mut checks = Checks::default();
    let w = world(&pool).await;
    let mover = user(&pool, "mover").await;
    sqlx::query("INSERT INTO server_members (server_id, user_id) VALUES ($1, $2)").bind(&w.sid).bind(mover as i32).execute(&pool).await.unwrap();
    let (role,): (i64,) = sqlx::query_as(
        "INSERT INTO server_roles (server_id, name, color, permissions, position, is_default) VALUES ($1, 'Movers', '#99AAB5', $2, 1, false) RETURNING id",
    )
    .bind(&w.sid)
    .bind(Permissions::MOVE_MEMBERS.bits() as i64)
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO member_roles (server_id, user_id, role_id) VALUES ($1, $2, $3)").bind(&w.sid).bind(mover as i32).bind(role).execute(&pool).await.unwrap();
    let (other,): (i32,) = sqlx::query_as("INSERT INTO channels (server_id, name, type) VALUES ($1, 'other', 1) RETURNING id")
        .bind(&w.sid)
        .fetch_one(&pool)
        .await
        .unwrap();
    let (mode,): (i32,) = sqlx::query_as("INSERT INTO server_modes (server_id, name, home_channel_id) VALUES ($1, 'f503', $2) RETURNING id")
        .bind(&w.sid)
        .bind(w.voice as i32)
        .fetch_one(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE servers SET active_mode_id = $1 WHERE id = $2").bind(mode).bind(&w.sid).execute(&pool).await.unwrap();

    // `by` moves the member from the voice room into `other`.
    let move_member = |p: &sqlx::PgPool, by: i64| {
        let s = app(p);
        let rx = in_voice(&s, w.member, w.voice);
        let sid = w.sid.clone();
        let target = w.member;
        async move {
            let req = serde_json::from_value(json!({ "channel_id": other })).unwrap();
            let r = crate::moderation_handlers::move_member_voice(State(s), Path((sid, target)), Extension(claims(by)), Json(req)).await.into_response();
            drop(rx);
            r
        }
    };
    let call_back = |p: &sqlx::PgPool| {
        let s = app(p);
        let sid = w.sid.clone();
        async move { crate::mode_handlers::call_everyone_back(State(s), Path(sid), Extension(claims(mover))).await.into_response() }
    };
    let (faulty, schema) = faulty_pool(&pool, &url, &["channel_permission_overwrites"]).await;
    // The mover's own view of the source room is resolved first.
    let mover_source = move_member(&faulty, mover).await;
    // The owner is answered before the faulted step, so for them it is the
    // MOVED member's permission in the destination that fails.
    let target_dest = move_member(&faulty, w.owner).await;
    let home = call_back(&faulty).await;
    drop_faults(&pool, faulty, &schema).await;
    let healthy = (move_member(&pool, mover).await.status(), move_member(&pool, w.owner).await.status(), call_back(&pool).await.status());
    let _ = sqlx::query("UPDATE servers SET active_mode_id = NULL WHERE id = $1").bind(&w.sid).execute(&pool).await;
    drop_world(&pool, &w, &[mover]).await;

    check_eq!(checks, healthy, (StatusCode::OK, StatusCode::OK, StatusCode::OK), "control: the moves and the call-back go through on a healthy pool");
    checks.retry(&mover_source, "move: the mover's view of the source room could not be read");
    checks.retry(&target_dest, "move: the member's permission in the destination could not be read");
    checks.retry(&home, "call everyone back: the caller's view of the main room could not be read");
    checks.done();
}

/// The database going busy between two lookups of ONE request. Edit Channel's
/// save window resolves the saving manager a second time after the first
/// answer hid the channel, and a clip proposal resolves the target channel
/// after the voice channel. Each second answer folded a failure into the 404
/// of a channel that is not there.
#[tokio::test]
async fn a_lookup_that_fails_on_the_second_read_of_a_request_is_still_a_503() {
    let Some((pool, url)) = crate::migrator::test_database(2).await else { return };
    let mut checks = Checks::default();
    let w = world(&pool).await;

    // A manager with Manage Channels from whom @everyone's deny hides `staff`,
    // halfway through a save of theirs (state.overwrite_saves).
    let manager = user(&pool, "mgr").await;
    sqlx::query("INSERT INTO server_members (server_id, user_id) VALUES ($1, $2)").bind(&w.sid).bind(manager as i32).execute(&pool).await.unwrap();
    let (role,): (i64,) = sqlx::query_as(
        "INSERT INTO server_roles (server_id, name, color, permissions, position, is_default) VALUES ($1, 'Managers', '#99AAB5', $2, 1, false) RETURNING id",
    )
    .bind(&w.sid)
    .bind(Permissions::MANAGE_CHANNELS.bits() as i64)
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO member_roles (server_id, user_id, role_id) VALUES ($1, $2, $3)").bind(&w.sid).bind(manager as i32).bind(role).execute(&pool).await.unwrap();
    let (everyone,): (i64,) = sqlx::query_as("SELECT id FROM server_roles WHERE server_id = $1 AND is_default").bind(&w.sid).fetch_one(&pool).await.unwrap();
    let (hidden,): (i32,) = sqlx::query_as("INSERT INTO channels (server_id, name, type) VALUES ($1, 'staff', 0) RETURNING id")
        .bind(&w.sid)
        .fetch_one(&pool)
        .await
        .unwrap();
    // i64, as every other site of this text binds it (scripts/check-sql-bind-types.py).
    sqlx::query("INSERT INTO channel_permission_overwrites (channel_id, role_id, allow, deny) VALUES ($1, $2, 0, $3)")
        .bind(hidden as i64)
        .bind(everyone)
        .bind(Permissions::VIEW_CHANNEL.bits() as i64)
        .execute(&pool)
        .await
        .unwrap();
    let list = |p: &sqlx::PgPool| {
        let s = app(p);
        s.overwrite_saves.insert((manager, hidden as i64), Instant::now() + Duration::from_secs(60));
        async move { crate::channel_handlers::list_overwrites(State(s), Path(hidden as i64), Extension(claims(manager))).await.into_response() }
    };
    let (faulty, schema) = crate::fault_injection::faulty_after_pool(&pool, &url, "channel_permission_overwrites", 1).await;
    let saving = list(&faulty).await;
    drop_faults(&pool, faulty, &schema).await;
    let saving_healthy = list(&pool).await.status();

    // A clip proposal into the pinned clips channel, from inside the voice room.
    sqlx::query("UPDATE servers SET clips_enabled = true, clip_channel_id = $1 WHERE id = $2").bind(w.text as i32).bind(&w.sid).execute(&pool).await.unwrap();
    let propose = |p: &sqlx::PgPool| {
        let s = app(p);
        let rx = in_voice(&s, w.member, w.voice);
        let req = serde_json::from_value(json!({ "target_channel_id": w.text, "duration_ms": 10000, "ended_ago_ms": 0 })).unwrap();
        let (m, voice) = (w.member, w.voice);
        async move {
            let r = crate::clip_handlers::propose_clip(State(s), Extension(claims(m)), Path(voice), Json(req)).await.into_response();
            drop(rx);
            r
        }
    };
    let (faulty, schema) = crate::fault_injection::faulty_after_pool(&pool, &url, "channel_permission_overwrites", 1).await;
    let target = propose(&faulty).await;
    drop_faults(&pool, faulty, &schema).await;
    let target_healthy = propose(&pool).await;
    drop_world(&pool, &w, &[manager]).await;

    check_eq!(checks, saving_healthy, StatusCode::OK, "control: a manager inside their save window lists the overwrites");
    checks.retry(&saving, "the save window's second permission lookup failed");
    check!(
        checks,
        !has_retry_after(&target_healthy) && target_healthy.status() != StatusCode::NOT_FOUND,
        "control: the proposal gets past the target check on a healthy pool, got {}",
        target_healthy.status()
    );
    checks.retry(&target, "the proposal's target-channel lookup failed");
    checks.done();
}

// ---- the account -----------------------------------------------------------------

/// The owned-server count that keeps an owner from deleting their account out
/// from under their servers folded a failed lookup into zero, and the account
/// lookup before it into "Account not found".
#[tokio::test]
async fn deleting_an_account_fails_closed() {
    let Some((pool, url)) = crate::migrator::test_database(2).await else { return };
    let mut checks = Checks::default();
    let w = world(&pool).await;
    let (owner_name,): (String,) = sqlx::query_as("SELECT username FROM users WHERE id = $1").bind(w.owner as i32).fetch_one(&pool).await.unwrap();

    // The owner deleting their account while they still own the server.
    let delete = |p: &sqlx::PgPool| {
        let s = app(p);
        s.record_password_proof(w.owner, 0);
        let req = crate::handlers::DeleteAccountRequest { confirm_username: owner_name.clone() };
        let owner = w.owner;
        async move { crate::handlers::delete_account(State(s), Extension(claims(owner)), Json(req)).await.into_response() }
    };
    let delete_healthy = delete(&pool).await.status();
    let (faulty, schema) = faulty_column_pool(&pool, &url, "servers", "owner_id").await;
    let delete_owned = delete(&faulty).await;
    drop_faults(&pool, faulty, &schema).await;
    let (faulty, schema) = faulty_pool(&pool, &url, &["users"]).await;
    let delete_account_row = delete(&faulty).await;
    drop_faults(&pool, faulty, &schema).await;
    let owner_alive: bool = sqlx::query_scalar("SELECT deleted_at IS NULL FROM users WHERE id = $1").bind(w.owner as i32).fetch_one(&pool).await.unwrap();

    drop_world(&pool, &w, &[]).await;

    check_eq!(checks, delete_healthy, StatusCode::CONFLICT, "control: an owner cannot delete their account");
    checks.retry(&delete_owned, "delete account: the owned-server count failed");
    checks.retry(&delete_account_row, "delete account: the account lookup failed");
    check!(checks, owner_alive, "the owner's account is still there");
    checks.done();
}

// ---- personal lists (Púca Notes) ---------------------------------------------------

/// A personal list of `owner`'s with one item per description, at positions
/// 1, 2, ... in that order.
async fn personal_list(pool: &sqlx::PgPool, owner: i64, items: &[&str]) -> (i64, Vec<i64>) {
    let (list,): (i64,) = sqlx::query_as("INSERT INTO task_lists (owner_id, title) VALUES ($1, 'f503 note') RETURNING id")
        .bind(owner)
        .fetch_one(pool)
        .await
        .expect("list");
    let mut ids = Vec::new();
    for (i, description) in items.iter().enumerate() {
        let (id,): (i64,) = sqlx::query_as(
            "INSERT INTO channel_tasks (list_id, description, created_by, position) VALUES ($1, $2, $3, $4) RETURNING id",
        )
        .bind(list)
        .bind(*description)
        .bind(owner)
        .bind(i as i64 + 1)
        .fetch_one(pool)
        .await
        .expect("item");
        ids.push(id);
    }
    (list, ids)
}

/// Every write to a personal list goes through check_list_owner, which folded
/// a failed lookup of the list into the 404 "List not found". Púca Notes'
/// outbox takes a 404 as a definite refusal and DROPS the queued edit (the
/// "did not save" toast), where it retries a 503.
#[tokio::test]
async fn personal_list_routes_answer_a_failed_list_lookup_with_a_503_not_a_404() {
    let Some((pool, url)) = crate::migrator::test_database(2).await else { return };
    let mut checks = Checks::default();
    let owner = user(&pool, "note").await;
    let (list, items) = personal_list(&pool, owner, &["first", "second"]).await;
    let (spare, _) = personal_list(&pool, owner, &[]).await;
    let (first, second) = (items[0], items[1]);

    fn body<T: serde::de::DeserializeOwned>(v: serde_json::Value) -> T {
        serde_json::from_value(v).expect("request body")
    }
    let routes = |p: &sqlx::PgPool| {
        let p = p.clone();
        async move {
            let c = || Extension(claims(owner));
            let s = || State(app(&p));
            vec![
                ("GET /task-lists/:id/tasks", crate::task_handlers::list_list_tasks(s(), Path(list), c()).await.into_response()),
                ("PATCH /tasks/:id", crate::task_handlers::update_task(s(), Path(first), c(), Json(body(json!({ "is_completed": true })))).await.into_response()),
                ("POST /task-lists/:id/tasks", crate::task_handlers::create_list_task(s(), Path(list), c(), Json(body(json!({ "description": "third" })))).await.into_response()),
                ("PATCH /task-lists/:id", crate::task_handlers::rename_task_list(s(), Path(list), c(), Json(body(json!({ "title": "renamed" })))).await.into_response()),
                ("POST /tasks/:id/move", crate::task_handlers::move_task(s(), Path(second), c(), Json(body(json!({ "direction": "up" })))).await.into_response()),
                ("POST /tasks/:id/reorder", crate::task_handlers::reorder_task(s(), Path(second), c(), Json(body(json!({ "after_id": null })))).await.into_response()),
                ("DELETE /tasks/:id", crate::task_handlers::delete_task(s(), Path(first), c()).await.into_response()),
                ("DELETE /task-lists/:id", crate::task_handlers::delete_task_list(s(), Path(spare), c()).await.into_response()),
            ]
        }
    };
    let (faulty, schema) = faulty_pool(&pool, &url, &["task_lists"]).await;
    let faulted = routes(&faulty).await;
    drop_faults(&pool, faulty, &schema).await;
    let untouched: (i64, i64, String, i64) = sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM channel_tasks WHERE list_id = $1 AND NOT is_completed), \
                (SELECT COUNT(*) FROM task_lists WHERE id = $2), \
                (SELECT title FROM task_lists WHERE id = $1), \
                (SELECT position FROM channel_tasks WHERE id = $3)",
    )
    .bind(list)
    .bind(spare)
    .bind(second)
    .fetch_one(&pool)
    .await
    .unwrap();
    let healthy = routes(&pool).await;
    let _ = sqlx::query("DELETE FROM task_lists WHERE id = ANY($1)").bind(vec![list, spare]).execute(&pool).await;
    drop_users(&pool, &[owner]).await;

    check_eq!(checks, untouched, (2, 1, "f503 note".to_string(), 2), "nothing was changed, made or deleted through the fault");
    for ((name, faulted), (_, healthy)) in faulted.iter().zip(&healthy) {
        check!(checks, healthy.status().is_success(), "control, {name}: the owner's ordinary answer on a healthy pool, got {}", healthy.status());
        checks.retry(faulted, &format!("{name}: the list lookup failed"));
    }
    checks.done();
}

/// move_task and reorder_task read the task again after check_task_access:
/// its scope, then its row inside the lock, then (move) the neighbour it
/// swaps with. The first two folded a failure into the 404 "Task not found",
/// and the neighbour's into "already at the edge", a 200 for a move that did
/// not happen.
#[tokio::test]
async fn a_move_whose_later_read_fails_is_a_503_and_moves_nothing() {
    let Some((pool, url)) = crate::migrator::test_database(2).await else { return };
    let mut checks = Checks::default();
    let owner = user(&pool, "mv").await;
    let (list, items) = personal_list(&pool, owner, &["first", "second"]).await;
    let second = items[1];
    let mv = |p: &sqlx::PgPool| {
        let s = app(p);
        async move {
            let req = serde_json::from_value(json!({ "direction": "up" })).unwrap();
            crate::task_handlers::move_task(State(s), Path(second), Extension(claims(owner)), Json(req)).await.into_response()
        }
    };
    let reorder = |p: &sqlx::PgPool| {
        let s = app(p);
        async move {
            let req = serde_json::from_value(json!({ "after_id": null })).unwrap();
            crate::task_handlers::reorder_task(State(s), Path(second), Extension(claims(owner)), Json(req)).await.into_response()
        }
    };
    // Reads of channel_tasks, in order: check_task_access, the scope, the
    // row inside the lock, the neighbour. `ok` lets the first `ok` answer.
    let mut faulted = Vec::new();
    for (ok, what) in [(1, "the scope"), (2, "the task's row"), (3, "the neighbour")] {
        let (faulty, schema) = crate::fault_injection::faulty_after_pool(&pool, &url, "channel_tasks", ok).await;
        faulted.push((format!("POST /tasks/:id/move: {what} could not be read"), mv(&faulty).await));
        drop_faults(&pool, faulty, &schema).await;
    }
    for (ok, what) in [(1, "the scope"), (2, "the task's row")] {
        let (faulty, schema) = crate::fault_injection::faulty_after_pool(&pool, &url, "channel_tasks", ok).await;
        faulted.push((format!("POST /tasks/:id/reorder: {what} could not be read"), reorder(&faulty).await));
        drop_faults(&pool, faulty, &schema).await;
    }
    let order = |p: sqlx::PgPool| async move {
        sqlx::query_scalar::<_, i64>("SELECT id FROM channel_tasks WHERE list_id = $1 ORDER BY position, id")
            .bind(list)
            .fetch_all(&p)
            .await
            .unwrap()
    };
    let before = order(pool.clone()).await;
    let moved = mv(&pool).await.status();
    let after = order(pool.clone()).await;
    let _ = sqlx::query("DELETE FROM task_lists WHERE id = $1").bind(list).execute(&pool).await;
    drop_users(&pool, &[owner]).await;

    check_eq!(checks, before, items.clone(), "nothing moved through the fault");
    check_eq!(checks, moved, StatusCode::OK, "control: on a healthy pool the item moves up");
    check_eq!(checks, after, vec![items[1], items[0]], "control: and it did move (it had a neighbour to swap with)");
    for (name, resp) in &faulted {
        checks.retry(resp, name);
    }
    checks.done();
}

// ---- channel history ---------------------------------------------------------------

/// GET /channels/:id/messages folded a failed history query into `200 []`:
/// the client clears the channel, marks it read, stops scrolling back and
/// search takes the partial history as all of it. Edit and delete folded the
/// message lookup into "Message not found", and the edit history into "no
/// edits".
#[tokio::test]
async fn channel_history_answers_a_failed_query_with_a_503_not_an_empty_page() {
    let Some((pool, url)) = crate::migrator::test_database(2).await else { return };
    let mut checks = Checks::default();
    let w = world(&pool).await;
    let msg = channel_message(&pool, w.text, w.member).await;
    let (m, text) = (w.member, w.text);
    let history = |p: &sqlx::PgPool| {
        let s = app(p);
        let q = serde_json::from_value(json!({})).unwrap();
        async move { crate::message_handlers::get_messages(State(s), Path(text), Query(q), Extension(claims(m))).await.into_response() }
    };
    let edits = |p: &sqlx::PgPool| {
        let s = app(p);
        let id = msg.clone();
        async move { crate::message_handlers::get_message_edits(State(s), Path((text, id)), Extension(claims(m))).await.into_response() }
    };
    let edit = |p: &sqlx::PgPool| {
        let s = app(p);
        let id = msg.clone();
        let req = serde_json::from_value(json!({ "content": "hello again" })).unwrap();
        async move { crate::message_handlers::edit_message(State(s), Path((text, id)), Extension(claims(m)), Json(req)).await.into_response() }
    };
    let delete = |p: &sqlx::PgPool| {
        let s = app(p);
        let id = msg.clone();
        async move { crate::message_handlers::delete_message(State(s), Path((text, id)), Extension(claims(m))).await.into_response() }
    };

    // The same history in a DM between the member and a friend.
    let friend = user(&pool, "dmf").await;
    let conv = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO dm_conversations (id, user1_id, user2_id) VALUES ($1, $2, $3)")
        .bind(&conv)
        .bind(m.min(friend))
        .bind(m.max(friend))
        .execute(&pool)
        .await
        .unwrap();
    let dm = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO dm_messages (id, conversation_id, sender_id, content) VALUES ($1, $2, $3, 'hi')")
        .bind(&dm)
        .bind(&conv)
        .bind(friend)
        .execute(&pool)
        .await
        .unwrap();
    let dm_history = |p: &sqlx::PgPool| {
        let s = app(p);
        let q = serde_json::from_value(json!({})).unwrap();
        let conv = conv.clone();
        async move { crate::dm_handlers::get_messages(State(s), Path(conv), Query(q), Extension(claims(m))).await.into_response() }
    };

    let (faulty, schema) = faulty_pool(&pool, &url, &["messages"]).await;
    let history_faulted = history(&faulty).await;
    let edit_faulted = edit(&faulty).await;
    let delete_faulted = delete(&faulty).await;
    drop_faults(&pool, faulty, &schema).await;
    let (faulty, schema) = faulty_pool(&pool, &url, &["message_edits"]).await;
    let edits_faulted = edits(&faulty).await;
    drop_faults(&pool, faulty, &schema).await;
    let (faulty, schema) = faulty_pool(&pool, &url, &["dm_conversations"]).await;
    let dm_participant_faulted = dm_history(&faulty).await;
    drop_faults(&pool, faulty, &schema).await;
    let (faulty, schema) = faulty_pool(&pool, &url, &["dm_messages"]).await;
    let dm_history_faulted = dm_history(&faulty).await;
    drop_faults(&pool, faulty, &schema).await;
    let kept: Option<String> = sqlx::query_scalar("SELECT content FROM messages WHERE id = $1").bind(&msg).fetch_optional(&pool).await.unwrap();

    let history_healthy = history(&pool).await;
    let history_status = history_healthy.status();
    let page: Vec<serde_json::Value> = serde_json::from_str(&body_text(history_healthy).await).unwrap_or_default();
    let dm_healthy = dm_history(&pool).await;
    let dm_status = dm_healthy.status();
    let dm_page: Vec<serde_json::Value> = serde_json::from_str(&body_text(dm_healthy).await).unwrap_or_default();
    let edits_healthy = edits(&pool).await.status();
    let edit_healthy = edit(&pool).await.status();
    let delete_healthy = delete(&pool).await.status();
    let _ = sqlx::query("DELETE FROM dm_conversations WHERE id = $1").bind(&conv).execute(&pool).await;
    drop_world(&pool, &w, &[friend]).await;

    check_eq!(checks, kept, Some("hello".to_string()), "the message was neither edited nor deleted through the fault");
    check_eq!(checks, history_status, StatusCode::OK, "control: the member reads the channel's history");
    check!(checks, page.iter().any(|row| row["id"] == json!(msg)), "control: and it holds the message, got {page:?}");
    check_eq!(checks, dm_status, StatusCode::OK, "control: the member reads the DM's history");
    check!(checks, dm_page.iter().any(|row| row["id"] == json!(dm)), "control: and it holds the DM, got {dm_page:?}");
    checks.retry(&dm_participant_faulted, "GET /dms/:id/messages: the participant lookup failed");
    checks.retry(&dm_history_faulted, "GET /dms/:id/messages: the history query failed");
    check_eq!(checks, edits_healthy, StatusCode::OK, "control: the member reads the message's edit history");
    check_eq!(checks, edit_healthy, StatusCode::OK, "control: the author edits the message");
    check!(checks, delete_healthy.is_success(), "control: the author deletes the message, got {delete_healthy}");
    checks.retry(&history_faulted, "GET /channels/:id/messages: the history query failed");
    checks.retry(&edits_faulted, "GET /channels/:id/messages/:mid/edits: the history query failed");
    checks.retry(&edit_faulted, "PATCH /channels/:id/messages/:mid: the message lookup failed");
    checks.retry(&delete_faulted, "DELETE /channels/:id/messages/:mid: the message lookup failed");
    checks.done();
}

// ---- the reminder feed ---------------------------------------------------------------

/// GET /task-reminders resolves each channel its rows name and leaves out the
/// rows of a channel the caller may not see. A channel whose permissions
/// could not be READ was left out the same way, in a 200: Púca Notes'
/// ReminderMerge then drops every id the feed no longer lists, alarms and
/// marks with it. Now the whole feed is a 503; a channel the caller really
/// cannot see (here, one in a server they are not in) is still left out.
#[tokio::test]
async fn the_reminder_feed_is_a_503_when_a_channel_cannot_be_checked() {
    let Some((pool, url)) = crate::migrator::test_database(2).await else { return };
    let mut checks = Checks::default();
    let w = world(&pool).await;
    let elsewhere = world(&pool).await;
    let due = |channel: i64| {
        let pool = pool.clone();
        let creator = w.member;
        async move {
            sqlx::query_scalar::<_, i64>(
                "INSERT INTO channel_tasks (channel_id, description, created_by, position, due_at) \
                 VALUES ($1, 'f503 reminder', $2, 1, NOW() + INTERVAL '1 day') RETURNING id",
            )
            .bind(channel)
            .bind(creator)
            .fetch_one(&pool)
            .await
            .expect("due task")
        }
    };
    let seen = due(w.text).await;
    let not_a_member = due(elsewhere.text).await;
    let feed = |p: &sqlx::PgPool| {
        let s = app(p);
        let m = w.member;
        async move { crate::task_handlers::list_task_reminders(State(s), Extension(claims(m))).await.into_response() }
    };
    let (faulty, schema) = faulty_pool(&pool, &url, &["channel_permission_overwrites"]).await;
    let faulted = feed(&faulty).await;
    drop_faults(&pool, faulty, &schema).await;
    let healthy = feed(&pool).await;
    let healthy_status = healthy.status();
    let rows: Vec<serde_json::Value> = serde_json::from_str(&body_text(healthy).await).unwrap_or_default();
    let ids: Vec<i64> = rows.iter().filter_map(|r| r["id"].as_i64()).collect();
    drop_world(&pool, &elsewhere, &[]).await;
    drop_world(&pool, &w, &[]).await;

    check_eq!(checks, healthy_status, StatusCode::OK, "control: the feed answers on a healthy pool");
    check!(checks, ids.contains(&seen), "control: it lists the reminder in the member's channel, got {ids:?}");
    check!(checks, !ids.contains(&not_a_member), "control: and leaves out the one in a server they are not in, got {ids:?}");
    checks.retry(&faulted, "GET /task-reminders: a channel's permissions could not be read");
    checks.done();
}

// ---- a channel's keys, past the gate ---------------------------------------------------

/// GET /channels/:id/keys and /member-keys, and POST /channels/:id/keys, after
/// their permission gate answered. GET /keys served a failed epoch read as
/// `current_epoch: 0`, the answer for a channel with no keys yet (a device with
/// no epoch floor then mints epoch 1, and can adopt a superseded epoch-1 key on
/// the 409), a failed read of the caller's wrapped keys as `keys: []` (history
/// undecryptable, and a send refused as "cannot send securely"), the server's
/// generation as -1 and the epoch's as 0. GET /member-keys served a failed
/// member list as `200 []` and a failed viewer resolve as a 500. The publish
/// read its epoch bound, the caller's own key and the epoch's first wrapper in
/// a transaction the failure had already aborted, and answered "Invalid
/// epoch", "must be your own identity key" or a 500 (its viewer resolve a
/// 500 too). Each is a 503 now, and nothing is written.
#[tokio::test]
async fn a_channels_keys_are_a_503_when_a_lookup_past_the_gate_fails() {
    let Some((pool, url)) = crate::migrator::test_database(2).await else { return };
    let mut checks = Checks::default();
    let w = world(&pool).await;
    let (m, text) = (w.member, w.text);
    for (who, key) in [(w.owner, "pk-owner"), (m, "pk-member")] {
        sqlx::query("UPDATE users SET public_key = $1 WHERE id = $2").bind(key).bind(who as i32).execute(&pool).await.unwrap();
    }
    sqlx::query("UPDATE servers SET member_generation = 7 WHERE id = $1").bind(&w.sid).execute(&pool).await.unwrap();
    for epoch in [1i32, 2] {
        sqlx::query(
            "INSERT INTO channel_keys (channel_id, epoch, recipient_id, wrapped_key, sender_public_key, member_generation, sender_user_id) \
             VALUES ($1, $2, $3, $4, 'pk-owner', 7, $5)",
        )
        .bind(text as i32)
        .bind(epoch)
        .bind(m as i32)
        .bind(format!("wrapped-{epoch}"))
        .bind(w.owner as i32)
        .execute(&pool)
        .await
        .unwrap();
    }
    let keys = |p: &sqlx::PgPool| {
        let s = app(p);
        async move { crate::key_handlers::get_channel_keys(State(s), Path(text), Extension(claims(m))).await.into_response() }
    };
    let member_keys = |p: &sqlx::PgPool| {
        let s = app(p);
        async move { crate::key_handlers::get_member_keys(State(s), Path(text), Extension(claims(m))).await.into_response() }
    };
    // Epoch 3 is the next one; epoch 2 is held, by the owner.
    let publish = |p: &sqlx::PgPool, epoch: i32| {
        let s = app(p);
        let req = serde_json::from_value(json!({
            "epoch": epoch,
            "member_generation": 7,
            "keys": [{ "recipient_id": m, "wrapped_key": format!("wrapped-{epoch}-again"), "sender_public_key": "pk-member" }],
        }))
        .unwrap();
        async move { crate::key_handlers::publish_channel_keys(State(s), Path(text), Extension(claims(m)), Json(req)).await.into_response() }
    };

    let mut faulted: Vec<(&str, Response)> = Vec::new();
    let (faulty, schema) = faulty_pool(&pool, &url, &["channel_keys"]).await;
    faulted.push(("GET /channels/:id/keys: the current-epoch read", keys(&faulty).await));
    faulted.push(("POST /channels/:id/keys: the epoch bound", publish(&faulty, 3).await));
    drop_faults(&pool, faulty, &schema).await;
    let (faulty, schema) = faulty_column_pool(&pool, &url, "servers", "member_generation").await;
    faulted.push(("GET /channels/:id/keys: the server's member generation", keys(&faulty).await));
    drop_faults(&pool, faulty, &schema).await;
    let (faulty, schema) = faulty_column_pool(&pool, &url, "channel_keys", "member_generation").await;
    faulted.push(("GET /channels/:id/keys: the generation the current epoch was minted for", keys(&faulty).await));
    drop_faults(&pool, faulty, &schema).await;
    let (faulty, schema) = faulty_column_pool(&pool, &url, "channel_keys", "wrapped_key").await;
    faulted.push(("GET /channels/:id/keys: the caller's wrapped keys", keys(&faulty).await));
    drop_faults(&pool, faulty, &schema).await;
    let (faulty, schema) = faulty_column_pool(&pool, &url, "users", "public_key").await;
    faulted.push(("GET /channels/:id/member-keys: the members and their keys", member_keys(&faulty).await));
    faulted.push(("POST /channels/:id/keys: the caller's own identity key", publish(&faulty, 3).await));
    drop_faults(&pool, faulty, &schema).await;
    // Read only where a row of the epoch is: a publish of the held epoch 2.
    let (faulty, schema) = faulty_column_pool(&pool, &url, "channel_keys", "sender_public_key").await;
    faulted.push(("POST /channels/:id/keys: who established the epoch", publish(&faulty, 2).await));
    drop_faults(&pool, faulty, &schema).await;
    // The gate resolves the member's overwrites once; the viewer resolve after
    // it reads them again. A pool each: the count is the pool's.
    let (faulty, schema) = crate::fault_injection::faulty_after_pool(&pool, &url, "channel_permission_overwrites", 1).await;
    faulted.push(("GET /channels/:id/member-keys: the channel's viewers", member_keys(&faulty).await));
    drop_faults(&pool, faulty, &schema).await;
    let (faulty, schema) = crate::fault_injection::faulty_after_pool(&pool, &url, "channel_permission_overwrites", 1).await;
    faulted.push(("POST /channels/:id/keys: the channel's viewers", publish(&faulty, 3).await));
    drop_faults(&pool, faulty, &schema).await;
    let (written,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM channel_keys WHERE channel_id = $1 AND epoch = 3")
        .bind(text as i32)
        .fetch_one(&pool)
        .await
        .unwrap();

    let healthy_keys = keys(&pool).await;
    let keys_status = healthy_keys.status();
    let served: serde_json::Value = serde_json::from_str(&body_text(healthy_keys).await).unwrap_or_default();
    let healthy_members = member_keys(&pool).await;
    let members_status = healthy_members.status();
    let listed: Vec<serde_json::Value> = serde_json::from_str(&body_text(healthy_members).await).unwrap_or_default();
    let held = publish(&pool, 2).await.status();
    let published = publish(&pool, 3).await.status();
    let (stored,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM channel_keys WHERE channel_id = $1 AND epoch = 3")
        .bind(text as i32)
        .fetch_one(&pool)
        .await
        .unwrap();
    drop_world(&pool, &w, &[]).await;

    check_eq!(checks, keys_status, StatusCode::OK, "control: the member reads the channel's keys");
    check_eq!(
        checks,
        (&served["current_epoch"], &served["max_epoch"], &served["current_generation"], &served["epoch_generation"]),
        (&json!(2), &json!(2), &json!(7), &json!(7)),
        "control: the epochs and generations a healthy read serves"
    );
    check_eq!(checks, served["keys"].as_array().map(Vec::len), Some(2), "control: both wrapped keys, got {served}");
    check_eq!(checks, members_status, StatusCode::OK, "control: the member reads the member keys");
    check!(
        checks,
        listed.iter().any(|k| k["user_id"] == json!(w.owner) && k["public_key"] == json!("pk-owner"))
            && listed.iter().any(|k| k["user_id"] == json!(m) && k["public_key"] == json!("pk-member")),
        "control: both members with their keys, got {listed:?}"
    );
    check_eq!(checks, written, 0, "nothing was published through a fault");
    check_eq!(checks, held, StatusCode::CONFLICT, "control: a publish of the epoch the owner holds is refused 409");
    check_eq!(checks, published, StatusCode::OK, "control: the member publishes the next epoch");
    check_eq!(checks, stored, 1, "control: and its row is stored");
    for (name, resp) in &faulted {
        checks.retry(resp, name);
    }
    checks.done();
}

// ---- editing a channel, past the gate ---------------------------------------------------

fn in_room(state: &AppState, user: i64, channel: i64) -> bool {
    state.rooms.get(&format!("voice_{channel}")).is_some_and(|r| r.members.contains(&user))
}

async fn channel_row(pool: &sqlx::PgPool, channel: i64) -> (bool, Option<i32>) {
    sqlx::query_as("SELECT COALESCE(sfu_mode, false), parent_id FROM channels WHERE id = $1")
        .bind(channel as i32)
        .fetch_one(pool)
        .await
        .expect("channel row")
}

/// PATCH /channels/:id after its gate answered, and POST /servers/:id/channels'
/// parent check. The channel as it stood was read with a failure folded into
/// "no row": a switch between mesh and SFU then committed and skipped putting
/// the call out (the room splits in two, the 2026-09-08 failure the eviction
/// exists for), and a parent the caller sees read as none, so "No parent (top
/// level)" answered 200 and changed nothing. A failed check of a new parent
/// (a collection here, one the caller can see, not a loop) answered the 400 a
/// client shows as "must be a collection in the same server". Each is a 503
/// now and changes nothing. The caller is the owner, whom the gate answers
/// after one read of `channels`, so the reads of `channels` are counted:
/// the gate's, the channel as it stands, the collection check, the
/// visibility of the parent (the resolver's first read) and the loop check.
#[tokio::test]
async fn a_channel_edit_whose_lookup_fails_is_a_503_and_changes_nothing() {
    let Some((pool, url)) = crate::migrator::test_database(2).await else { return };
    let mut checks = Checks::default();
    let w = world(&pool).await;
    let (owner, sid, voice, loose, collection) = (w.owner, w.sid.clone(), w.voice, w.text, w.collection);
    let (inside,): (i32,) = sqlx::query_as("INSERT INTO channels (server_id, name, type, parent_id) VALUES ($1, 'inside', 0, $2) RETURNING id")
        .bind(&sid)
        .bind(collection as i32)
        .fetch_one(&pool)
        .await
        .unwrap();
    let inside = inside as i64;
    let edit = |s: Arc<AppState>, channel: i64, body: serde_json::Value| async move {
        let req = serde_json::from_value(body).unwrap();
        crate::channel_handlers::update_channel(State(s), Path(channel), Extension(claims(owner)), Json(req)).await.into_response()
    };
    let create = |p: &sqlx::PgPool| {
        let s = app(p);
        let sid = sid.clone();
        let req = serde_json::from_value(json!({ "name": "f503-new", "channel_type": 0, "parent_id": collection })).unwrap();
        async move { crate::channel_handlers::create_channel(State(s), Path(sid), Extension(claims(owner)), Json(req)).await.into_response() }
    };
    let created = |p: &sqlx::PgPool| {
        let (p, sid) = (p.clone(), sid.clone());
        async move {
            sqlx::query_scalar::<_, Option<i32>>("SELECT parent_id FROM channels WHERE server_id = $1 AND name = 'f503-new'")
                .bind(sid)
                .fetch_all(&p)
                .await
                .unwrap()
        }
    };

    // Mesh <-> SFU with the member in the call: the channel as it stands fails.
    let (faulty, schema) = crate::fault_injection::faulty_once_pool(&pool, &url, "channels", 1).await;
    let s = app(&faulty);
    let rx = in_voice(&s, w.member, voice);
    let transport = edit(s.clone(), voice, json!({ "sfu_mode": false })).await;
    let still_in_call = in_room(&s, w.member, voice);
    drop(rx);
    drop_faults(&pool, faulty, &schema).await;
    let transport_row = channel_row(&pool, voice).await;

    // "No parent (top level)" for a channel in a collection the owner sees:
    // the resolver's read for the collection fails (the third).
    let (faulty, schema) = crate::fault_injection::faulty_once_pool(&pool, &url, "channels", 2).await;
    let out = edit(app(&faulty), inside, json!({ "parent_id": null })).await;
    drop_faults(&pool, faulty, &schema).await;
    let out_row = channel_row(&pool, inside).await;

    // A top-level channel moved into the collection: the collection check, the
    // parent's visibility, the loop check.
    let mut into = Vec::new();
    for (skip, what) in [(2, "the collection check"), (3, "the parent's visibility"), (4, "the loop check")] {
        let (faulty, schema) = crate::fault_injection::faulty_once_pool(&pool, &url, "channels", skip).await;
        into.push((what, edit(app(&faulty), loose, json!({ "parent_id": collection })).await));
        drop_faults(&pool, faulty, &schema).await;
    }
    let into_row = channel_row(&pool, loose).await;

    // Creating a channel in the collection: the collection check, the visibility.
    let mut made = Vec::new();
    for (skip, what) in [(0, "the collection check"), (1, "the parent's visibility")] {
        let (faulty, schema) = crate::fault_injection::faulty_once_pool(&pool, &url, "channels", skip).await;
        made.push((what, create(&faulty).await));
        drop_faults(&pool, faulty, &schema).await;
    }
    let made_rows = created(&pool).await;

    // Controls, on a healthy pool.
    let s = app(&pool);
    let rx = in_voice(&s, w.member, voice);
    let transport_healthy = edit(s.clone(), voice, json!({ "sfu_mode": false })).await.status();
    let put_out = !in_room(&s, w.member, voice);
    drop(rx);
    let transport_healthy_row = channel_row(&pool, voice).await;
    let out_healthy = edit(app(&pool), inside, json!({ "parent_id": null })).await.status();
    let out_healthy_row = channel_row(&pool, inside).await;
    let into_healthy = edit(app(&pool), loose, json!({ "parent_id": collection })).await.status();
    let into_healthy_row = channel_row(&pool, loose).await;
    let made_healthy = create(&pool).await.status();
    let made_healthy_rows = created(&pool).await;
    drop_world(&pool, &w, &[]).await;

    checks.retry(&transport, "PATCH /channels/:id (sfu_mode): the channel as it stands could not be read");
    check_eq!(checks, transport_row.0, true, "the voice channel is still on SFU after the fault");
    check!(checks, still_in_call, "and the call was left as it was");
    check_eq!(checks, transport_healthy, StatusCode::OK, "control: the owner switches the channel to mesh");
    check_eq!(checks, transport_healthy_row.0, false, "control: and it is on mesh");
    check!(checks, put_out, "control: and the call in it was put out");

    checks.retry(&out, "PATCH /channels/:id (parent_id null): the collection's visibility could not be read");
    check_eq!(checks, out_row.1, Some(collection as i32), "the channel is still in its collection after the fault");
    check_eq!(checks, out_healthy, StatusCode::OK, "control: the owner takes the channel out of its collection");
    check_eq!(checks, out_healthy_row.1, None, "control: and it is at the top level");

    for (what, resp) in &into {
        checks.retry(resp, &format!("PATCH /channels/:id (into a collection): {what} could not be made"));
    }
    check_eq!(checks, into_row.1, None, "the channel is still at the top level after the faults");
    check_eq!(checks, into_healthy, StatusCode::OK, "control: the owner moves the channel into the collection");
    check_eq!(checks, into_healthy_row.1, Some(collection as i32), "control: and it is inside it");

    for (what, resp) in &made {
        checks.retry(resp, &format!("POST /servers/:id/channels (in a collection): {what} could not be made"));
    }
    check!(checks, made_rows.is_empty(), "no channel was created through a fault, got {made_rows:?}");
    check_eq!(checks, made_healthy, StatusCode::OK, "control: the owner creates a channel in the collection");
    check_eq!(checks, made_healthy_rows, vec![Some(collection as i32)], "control: and it is inside it");
    checks.done();
}

// ---- the bulk channel resolver, and the routes on it ------------------------------------

/// A member of `w`'s server holding `bits` through a role of their own (position 1).
async fn staff(pool: &sqlx::PgPool, w: &World, bits: Permissions) -> i64 {
    let who = user(pool, "staff").await;
    sqlx::query("INSERT INTO server_members (server_id, user_id) VALUES ($1, $2)").bind(&w.sid).bind(who as i32).execute(pool).await.unwrap();
    let (role,): (i64,) = sqlx::query_as(
        "INSERT INTO server_roles (server_id, name, color, permissions, position, is_default) VALUES ($1, 'Staff', '#99AAB5', $2, 1, false) RETURNING id",
    )
    .bind(&w.sid)
    .bind(bits.bits() as i64)
    .fetch_one(pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO member_roles (server_id, user_id, role_id) VALUES ($1, $2, $3)").bind(&w.sid).bind(who as i32).bind(role).execute(pool).await.unwrap();
    who
}

/// A text channel inside `w`'s collection, and whether @everyone is denied it.
async fn child_of_collection(pool: &sqlx::PgPool, w: &World, hidden: bool) -> i64 {
    let (id,): (i32,) = sqlx::query_as("INSERT INTO channels (server_id, name, type, parent_id) VALUES ($1, 'inside', 0, $2) RETURNING id")
        .bind(&w.sid)
        .bind(w.collection as i32)
        .fetch_one(pool)
        .await
        .unwrap();
    if hidden {
        let (everyone,): (i64,) = sqlx::query_as("SELECT id FROM server_roles WHERE server_id = $1 AND is_default").bind(&w.sid).fetch_one(pool).await.unwrap();
        // i64, as every other site of this text binds it (scripts/check-sql-bind-types.py).
        sqlx::query("INSERT INTO channel_permission_overwrites (channel_id, role_id, allow, deny) VALUES ($1, $2, 0, $3)")
            .bind(id as i64)
            .bind(everyone)
            .bind(Permissions::VIEW_CHANNEL.bits() as i64)
            .execute(pool)
            .await
            .unwrap();
    }
    id as i64
}

async fn json_of(resp: Response) -> serde_json::Value {
    serde_json::from_str(&body_text(resp).await).unwrap_or(serde_json::Value::Null)
}

/// get_user_channels_permissions read its base (owner, membership, roles)
/// through get_user_server_permissions, which folds a failed lookup into "not
/// the owner" or "no permissions". The bulk resolver then answered `Ok` with
/// every channel denied, or with the owner judged as a plain member, where
/// try_user_channel_permissions answers `Err`. Each table the base reads,
/// faulted in turn, for a member and for the owner: the two resolvers agree.
#[tokio::test]
async fn the_bulk_channel_resolver_fails_where_the_single_one_does() {
    let Some((pool, url)) = crate::migrator::test_database(2).await else { return };
    let mut checks = Checks::default();
    let w = world(&pool).await;
    let ids = [w.text, w.voice, w.collection];
    let either = |ok: bool| if ok { "Ok" } else { "Err" };
    for table in ["servers", "server_members", "server_roles", "member_roles"] {
        let (faulty, schema) = faulty_pool(&pool, &url, &[table]).await;
        for (who, name) in [(w.member, "member"), (w.owner, "owner")] {
            let single = crate::permissions::try_user_channel_permissions(&faulty, w.text, who).await;
            let bulk = crate::permissions::get_user_channels_permissions(&faulty, &w.sid, who, &ids).await;
            let server = crate::permissions::try_user_server_permissions(&faulty, &w.sid, who).await;
            match (&single, &bulk) {
                (Err(_), Err(_)) => {}
                (Ok(crate::permissions::ChannelPermAccess::Allowed { perms, .. }), Ok(map)) => {
                    check_eq!(checks, map.get(&w.text).copied(), Some(*perms), "{table} faulted, the {name}: the two resolvers agree");
                }
                _ => check!(
                    checks,
                    false,
                    "{table} faulted, the {name}: the single resolver answered {} and the bulk one {}",
                    either(single.is_ok()),
                    either(bulk.is_ok())
                ),
            }
            if who == w.member {
                check!(checks, bulk.is_err(), "{table} faulted: the member's base could not be read, so the bulk resolver is Err");
                check!(checks, server.is_err(), "{table} faulted: so is try_user_server_permissions");
            }
        }
        drop_faults(&pool, faulty, &schema).await;
    }
    let member = crate::permissions::get_user_channels_permissions(&pool, &w.sid, w.member, &ids).await.expect("member");
    let owner = crate::permissions::get_user_channels_permissions(&pool, &w.sid, w.owner, &ids).await.expect("owner");
    let member_server = crate::permissions::try_user_server_permissions(&pool, &w.sid, w.member).await;
    drop_world(&pool, &w, &[]).await;

    check!(checks, member[&w.text].has(Permissions::VIEW_CHANNEL) && !member[&w.text].is_admin(), "control: the member sees the text channel, as a member");
    check!(checks, ids.iter().all(|c| owner[c].is_admin()), "control: the owner is an administrator in every channel");
    check_eq!(checks, member_server, Ok(Permissions::DEFAULT_MEMBER), "control: the member's server permissions are @everyone's");
    checks.done();
}

async fn list_channels_as(pool: &sqlx::PgPool, sid: &str, who: i64) -> Response {
    crate::channel_handlers::list_channels(State(app(pool)), Path(sid.to_string()), Extension(claims(who))).await.into_response()
}

/// GET /servers/:id/channels, the most-used channel route. Its own membership
/// check read a failure as "not a member" (403), and the bulk resolver's base
/// as every channel denied: a 200 listing nothing, or, for the owner, the list
/// a plain member gets. Its other reads were 500s. Each is a 503 now.
#[tokio::test]
async fn the_channel_list_is_a_503_when_a_lookup_fails() {
    let Some((pool, url)) = crate::migrator::test_database(2).await else { return };
    let mut checks = Checks::default();
    let w = world(&pool).await;
    let mut faulted = Vec::new();
    for (table, who, what) in [
        ("server_members", w.member, "the membership check"),
        ("member_roles", w.member, "the member's roles"),
        ("server_roles", w.member, "the server's roles"),
        ("servers", w.owner, "the owner check"),
        ("channels", w.member, "the channel list"),
        ("channel_permission_overwrites", w.member, "the overwrites"),
        ("server_mode_channels", w.member, "the channels' modes"),
    ] {
        let (faulty, schema) = faulty_pool(&pool, &url, &[table]).await;
        faulted.push((table, what, list_channels_as(&faulty, &w.sid, who).await));
        drop_faults(&pool, faulty, &schema).await;
    }
    let member_list = json_of(list_channels_as(&pool, &w.sid, w.member).await).await;
    let owner_list = json_of(list_channels_as(&pool, &w.sid, w.owner).await).await;
    let stranger = user(&pool, "str").await;
    let stranger_list = list_channels_as(&pool, &w.sid, stranger).await.status();
    drop_world(&pool, &w, &[stranger]).await;

    for (table, what, resp) in &faulted {
        checks.retry(resp, &format!("GET /servers/:id/channels: {what} ({table}) could not be read"));
    }
    let admin = |c: &serde_json::Value| c["my_permissions"].as_i64().is_some_and(|b| b as u64 & Permissions::ADMINISTRATOR.bits() != 0);
    check_eq!(checks, member_list.as_array().map(Vec::len), Some(3), "control: the member is listed every channel");
    check!(
        checks,
        owner_list.as_array().is_some_and(|a| a.len() == 3 && a.iter().all(admin)),
        "control: the owner is listed every channel as an administrator, got {owner_list}"
    );
    check_eq!(checks, stranger_list, StatusCode::FORBIDDEN, "control: a stranger still gets the real 403");
    checks.done();
}

/// GET /channels/:id/feed past its gate: the children, the bulk resolver's
/// base and each child's messages folded into a feed with them left out (a
/// 200 of nothing). The gate reads member_roles once for the member, the bulk
/// resolver's base a second time; the feed reads `channels` for the
/// collection, the gate for the same, then for the children.
#[tokio::test]
async fn the_collection_feed_is_a_503_when_a_read_past_its_gate_fails() {
    let Some((pool, url)) = crate::migrator::test_database(2).await else { return };
    let mut checks = Checks::default();
    let w = world(&pool).await;
    let child = child_of_collection(&pool, &w, false).await;
    let _ = channel_message(&pool, child, w.owner).await;
    let feed = |p: &sqlx::PgPool| {
        let s = app(p);
        let (coll, m) = (w.collection, w.member);
        async move { crate::channel_handlers::get_channel_feed(State(s), Path(coll), Extension(claims(m))).await.into_response() }
    };
    let (faulty, schema) = crate::fault_injection::faulty_after_pool(&pool, &url, "member_roles", 1).await;
    let base = feed(&faulty).await;
    drop_faults(&pool, faulty, &schema).await;
    let (faulty, schema) = crate::fault_injection::faulty_once_pool(&pool, &url, "channels", 2).await;
    let children = feed(&faulty).await;
    drop_faults(&pool, faulty, &schema).await;
    let (faulty, schema) = faulty_pool(&pool, &url, &["messages"]).await;
    let messages = feed(&faulty).await;
    drop_faults(&pool, faulty, &schema).await;
    let healthy = json_of(feed(&pool).await).await;
    drop_world(&pool, &w, &[]).await;

    checks.retry(&base, "GET /channels/:id/feed: the member's base permissions could not be read");
    checks.retry(&children, "GET /channels/:id/feed: the collection's children could not be read");
    checks.retry(&messages, "GET /channels/:id/feed: a child's messages could not be read");
    let kids = healthy["children"].as_array().cloned().unwrap_or_default();
    check!(
        checks,
        kids.len() == 1 && kids[0]["id"].as_i64() == Some(child) && kids[0]["messages"].as_array().map(Vec::len) == Some(1),
        "control: the feed holds the child and its message, got {healthy}"
    );
    checks.done();
}

async fn channel_exists(pool: &sqlx::PgPool, id: i64) -> bool {
    sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM channels WHERE id = $1)").bind(id as i32).fetch_one(pool).await.unwrap()
}

async fn positions(pool: &sqlx::PgPool, sid: &str) -> Vec<(i32, i32)> {
    sqlx::query_as("SELECT id, position FROM channels WHERE server_id = $1 ORDER BY id").bind(sid).fetch_all(pool).await.unwrap()
}

/// DELETE /channels/:id and POST /servers/:id/channels/reorder. Through the
/// folded base, a failed read of the caller's view made a delete answer the
/// 409 "would take a channel you cannot see" and a reorder a 200 that had
/// moved nothing, and the Manage Channels check of both answered its 403.
/// Each is a 503 now and changes nothing. A manager (Manage Channels through
/// a role) and the owner; the reads counted are member_roles' (the manager's
/// roles: the delete gate's resolver, then the Manage Channels check; for a
/// reorder, that check, then the bulk resolver) and `servers`' (the owner:
/// the delete gate's join, the Manage Channels check, then the bulk resolver).
#[tokio::test]
async fn a_delete_or_a_reorder_whose_view_cannot_be_read_is_a_503_and_changes_nothing() {
    let Some((pool, url)) = crate::migrator::test_database(2).await else { return };
    let mut checks = Checks::default();
    let w = world(&pool).await;
    let manager = staff(&pool, &w, Permissions::MANAGE_CHANNELS).await;
    let hidden = child_of_collection(&pool, &w, true).await;
    let reorder = |p: &sqlx::PgPool, who: i64| {
        let s = app(p);
        let sid = w.sid.clone();
        let req = serde_json::from_value(json!({ "channel_ids": [w.collection, w.voice, w.text] })).unwrap();
        async move { crate::channel_handlers::reorder_channels(State(s), Path(sid), Extension(claims(who)), Json(req)).await.into_response() }
    };
    let delete = |p: &sqlx::PgPool, who: i64| {
        let s = app(p);
        let coll = w.collection;
        async move { crate::channel_handlers::delete_channel(State(s), Path(coll), Extension(claims(who))).await.into_response() }
    };
    let before = positions(&pool, &w.sid).await;

    let (faulty, schema) = faulty_pool(&pool, &url, &["member_roles"]).await;
    let reorder_gate = reorder(&faulty, manager).await;
    drop_faults(&pool, faulty, &schema).await;
    let (faulty, schema) = crate::fault_injection::faulty_after_pool(&pool, &url, "member_roles", 1).await;
    let reorder_view = reorder(&faulty, manager).await;
    drop_faults(&pool, faulty, &schema).await;
    let after_faults = positions(&pool, &w.sid).await;

    let (faulty, schema) = crate::fault_injection::faulty_after_pool(&pool, &url, "member_roles", 1).await;
    let delete_gate = delete(&faulty, manager).await;
    drop_faults(&pool, faulty, &schema).await;
    let (faulty, schema) = crate::fault_injection::faulty_after_pool(&pool, &url, "servers", 2).await;
    let delete_view = delete(&faulty, w.owner).await;
    drop_faults(&pool, faulty, &schema).await;
    let kept = (channel_exists(&pool, w.collection).await, channel_exists(&pool, hidden).await);

    // Controls, on a healthy pool.
    let reorder_healthy = reorder(&pool, manager).await.status();
    let after_healthy = positions(&pool, &w.sid).await;
    let delete_manager = delete(&pool, manager).await.status();
    let delete_owner = delete(&pool, w.owner).await.status();
    let gone = (channel_exists(&pool, w.collection).await, channel_exists(&pool, hidden).await);
    drop_world(&pool, &w, &[manager]).await;

    checks.retry(&reorder_gate, "reorder: the manager's Manage Channels could not be read");
    checks.retry(&reorder_view, "reorder: the manager's view of the channels could not be read");
    check_eq!(checks, after_faults, before.clone(), "no channel moved through a fault");
    checks.retry(&delete_gate, "delete: the manager's Manage Channels could not be read");
    checks.retry(&delete_view, "delete: the owner's view of what goes along could not be read");
    check_eq!(checks, kept, (true, true), "nothing was deleted through a fault");

    check_eq!(checks, reorder_healthy, StatusCode::OK, "control: the manager reorders the channels");
    let at = |rows: &[(i32, i32)], id: i64| rows.iter().find(|r| r.0 as i64 == id).map(|r| r.1);
    check_eq!(
        checks,
        (at(&after_healthy, w.collection), at(&after_healthy, w.voice), at(&after_healthy, w.text)),
        (Some(0), Some(1), Some(2)),
        "control: in the order asked for"
    );
    check_eq!(checks, delete_manager, StatusCode::CONFLICT, "control: a manager who cannot see a channel inside gets the real 409");
    check_eq!(checks, delete_owner, StatusCode::NO_CONTENT, "control: the owner deletes the collection");
    check_eq!(checks, gone, (false, false), "control: and what was in it");
    checks.done();
}

/// GET /servers/:id/unread, GET /unread, POST /servers/:id/read and GET
/// /servers/:id/voice-users. Each checked membership with a failure read as
/// "not a member" (403), and resolved the channels through the folded base,
/// so a failure there was a 200 with every channel left out: nothing unread,
/// the server's bubble off the rail, nothing marked read, nobody in voice.
/// Their own lists folded the same way (an empty count list, an empty channel
/// list). Each is a 503 now, and nothing is marked read.
#[tokio::test]
async fn the_server_unread_read_and_voice_routes_are_a_503_when_a_lookup_fails() {
    let Some((pool, url)) = crate::migrator::test_database(2).await else { return };
    let mut checks = Checks::default();
    let w = world(&pool).await;
    let _ = channel_message(&pool, w.text, w.owner).await;
    #[derive(Clone, Copy, Debug)]
    enum Route {
        Unread,
        AllUnread,
        MarkRead,
        VoiceUsers,
    }
    let call = |p: &sqlx::PgPool, route: Route| {
        let s = app(p);
        let (sid, m) = (w.sid.clone(), w.member);
        let rx = in_voice(&s, m, w.voice);
        if let Some(mut room) = s.rooms.get_mut(&format!("voice_{}", w.voice)) {
            room.streamers.push(m);
        }
        async move {
            let r = match route {
                Route::Unread => crate::server_handlers::get_unread_counts(State(s), Path(sid), Extension(claims(m))).await.into_response(),
                Route::AllUnread => crate::server_handlers::get_all_unread_counts(State(s), Extension(claims(m))).await.into_response(),
                Route::MarkRead => crate::server_handlers::mark_server_read(State(s), Path(sid), Extension(claims(m))).await.into_response(),
                Route::VoiceUsers => crate::server_handlers::get_voice_users(State(s), Path(sid), Extension(claims(m))).await.into_response(),
            };
            drop(rx);
            r
        }
    };
    let read_rows = || {
        let p = pool.clone();
        let m = w.member;
        async move {
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM channel_read_state WHERE user_id = $1").bind(m as i32).fetch_one(&p).await.unwrap()
        }
    };
    let all = [Route::Unread, Route::AllUnread, Route::MarkRead, Route::VoiceUsers];
    let mut faulted = Vec::new();
    for (table, routes, what) in [
        ("member_roles", &all[..], "the member's base permissions"),
        ("server_members", &all[..], "the membership check"),
        ("channel_read_state", &[Route::Unread, Route::AllUnread][..], "the unread counts"),
        ("channels", &all[..], "the channel list"),
    ] {
        let (faulty, schema) = faulty_pool(&pool, &url, &[table]).await;
        for &route in routes {
            faulted.push((format!("{route:?}: {what} ({table})"), call(&faulty, route).await));
        }
        drop_faults(&pool, faulty, &schema).await;
    }
    let marked_through_faults = read_rows().await;

    let unread = json_of(call(&pool, Route::Unread).await).await;
    let all_unread = json_of(call(&pool, Route::AllUnread).await).await;
    let voice = json_of(call(&pool, Route::VoiceUsers).await).await;
    let marked = call(&pool, Route::MarkRead).await.status();
    let marked_rows = read_rows().await;
    drop_world(&pool, &w, &[]).await;

    for (what, resp) in &faulted {
        checks.retry(resp, &format!("{what} could not be read"));
    }
    check_eq!(checks, marked_through_faults, 0, "nothing was marked read through a fault");
    let text_unread = unread["channels"]
        .as_array()
        .and_then(|a| a.iter().find(|c| c["channel_id"].as_i64() == Some(w.text)))
        .and_then(|c| c["unread_count"].as_i64());
    check_eq!(checks, text_unread, Some(1), "control: the member has the owner's message unread, got {unread}");
    let server_unread = all_unread["servers"]
        .as_array()
        .and_then(|a| a.iter().find(|s| s["server_id"].as_str() == Some(w.sid.as_str())))
        .and_then(|s| s["unread_count"].as_i64());
    check_eq!(checks, server_unread, Some(1), "control: and the rail's bubble for the server says so, got {all_unread}");
    check!(
        checks,
        voice["voice_users"].as_array().is_some_and(|a| a.iter().any(|u| u["user_id"].as_i64() == Some(w.member))),
        "control: the member is listed in voice, got {voice}"
    );
    check_eq!(checks, marked, StatusCode::OK, "control: the member marks the server read");
    check!(checks, marked_rows > 0, "control: and it is marked read");
    checks.done();
}

/// The modes: GET /servers/:id/modes, a mode's channel check (POST
/// /servers/:id/modes) and Call everyone back. Through the folded base, a
/// failed read of the caller's view listed a mode with its channels and main
/// channel left out (and, read again for the switches, every switch hidden),
/// refused a mode's channels with the 400 "not on this server", and called
/// nobody back with a 200. A staff member holding Manage Channels and Move
/// Members; the reads counted are member_roles' (their roles).
#[tokio::test]
async fn the_mode_routes_are_a_503_when_the_callers_view_cannot_be_read() {
    let Some((pool, url)) = crate::migrator::test_database(2).await else { return };
    let mut checks = Checks::default();
    let w = world(&pool).await;
    let lead = staff(&pool, &w, Permissions::MANAGE_CHANNELS | Permissions::MOVE_MEMBERS).await;
    let (other,): (i32,) = sqlx::query_as("INSERT INTO channels (server_id, name, type) VALUES ($1, 'other', 1) RETURNING id")
        .bind(&w.sid)
        .fetch_one(&pool)
        .await
        .unwrap();
    let (mode,): (i32,) = sqlx::query_as("INSERT INTO server_modes (server_id, name, home_channel_id) VALUES ($1, 'f503', $2) RETURNING id")
        .bind(&w.sid)
        .bind(w.voice as i32)
        .fetch_one(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO server_mode_channels (mode_id, channel_id) VALUES ($1, $2)").bind(mode).bind(other).execute(&pool).await.unwrap();
    sqlx::query("UPDATE servers SET active_mode_id = $1 WHERE id = $2").bind(mode).bind(&w.sid).execute(&pool).await.unwrap();

    let list = |p: &sqlx::PgPool| {
        let s = app(p);
        let sid = w.sid.clone();
        async move { crate::mode_handlers::list_modes(State(s), Path(sid), Extension(claims(lead))).await.into_response() }
    };
    let create = |p: &sqlx::PgPool| {
        let s = app(p);
        let sid = w.sid.clone();
        let edit = serde_json::from_value(json!({ "name": "f503-new", "channel_ids": [w.text] })).unwrap();
        async move { crate::mode_handlers::create_mode(State(s), Path(sid), Extension(claims(lead)), Json(edit)).await.into_response() }
    };
    let call_back = |p: &sqlx::PgPool| {
        let s = app(p);
        let sid = w.sid.clone();
        let rx = in_voice(&s, w.member, other as i64);
        async move {
            let r = crate::mode_handlers::call_everyone_back(State(s), Path(sid), Extension(claims(lead))).await.into_response();
            drop(rx);
            r
        }
    };
    let created = || {
        let (p, sid) = (pool.clone(), w.sid.clone());
        async move {
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM server_modes WHERE server_id = $1 AND name = 'f503-new'").bind(sid).fetch_one(&p).await.unwrap()
        }
    };

    // The bulk resolver's base is the first read of member_roles in a listing,
    // the switches the second.
    let (faulty, schema) = faulty_pool(&pool, &url, &["member_roles"]).await;
    let list_view = list(&faulty).await;
    drop_faults(&pool, faulty, &schema).await;
    let (faulty, schema) = crate::fault_injection::faulty_after_pool(&pool, &url, "member_roles", 1).await;
    let list_switches = list(&faulty).await;
    drop_faults(&pool, faulty, &schema).await;
    // After Manage Channels (the first read).
    let (faulty, schema) = crate::fault_injection::faulty_after_pool(&pool, &url, "member_roles", 1).await;
    let create_view = create(&faulty).await;
    drop_faults(&pool, faulty, &schema).await;
    let created_through_fault = created().await;
    // After Move Members and the main channel's resolution (the first two).
    let (faulty, schema) = crate::fault_injection::faulty_after_pool(&pool, &url, "member_roles", 2).await;
    let call_back_view = call_back(&faulty).await;
    drop_faults(&pool, faulty, &schema).await;

    let listed = json_of(list(&pool).await).await;
    let called_back = json_of(call_back(&pool).await).await;
    let create_healthy = create(&pool).await.status();
    let created_healthy = created().await;
    let _ = sqlx::query("UPDATE servers SET active_mode_id = NULL WHERE id = $1").bind(&w.sid).execute(&pool).await;
    drop_world(&pool, &w, &[lead]).await;

    checks.retry(&list_view, "GET /servers/:id/modes: the caller's view of the mode's channels could not be read");
    checks.retry(&list_switches, "GET /servers/:id/modes: the caller's server permissions (the switches) could not be read");
    checks.retry(&create_view, "POST /servers/:id/modes: the caller's view of the mode's channels could not be read");
    check_eq!(checks, created_through_fault, 0, "no mode was created through a fault");
    checks.retry(&call_back_view, "call everyone back: the caller's view of the mode's rooms could not be read");

    let the_mode = listed["modes"].as_array().and_then(|a| a.iter().find(|m| m["id"].as_i64() == Some(mode as i64))).cloned();
    check!(
        checks,
        the_mode.as_ref().is_some_and(|m| m["channel_ids"] == json!([other]) && m["home_channel_id"].as_i64() == Some(w.voice))
            && listed["can_call_back"] == json!(true),
        "control: the mode is listed with its channel and main channel, and Call everyone back offered, got {listed}"
    );
    check_eq!(checks, called_back["moved"].as_i64(), Some(1), "control: the member is called back, got {called_back}");
    check_eq!(checks, create_healthy, StatusCode::CREATED, "control: the mode is created");
    check_eq!(checks, created_healthy, 1, "control: once");
    checks.done();
}
