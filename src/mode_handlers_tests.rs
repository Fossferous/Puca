//! Tests of server modes. The DB-backed ones need TEST_DATABASE_URL (they skip
//! themselves without it, like every DB test here: see CLAUDE.md).

use super::*;
use crate::permissions::Permissions as P;
use serde_json::{json, Value};
use tokio::sync::mpsc;

#[test]
fn a_mode_name_is_trimmed_and_bounded() {
    assert_eq!(clean_name("  Blood on the Clocktower \n").unwrap(), "Blood on the Clocktower");
    assert_eq!(clean_name("   ").unwrap_err().0, StatusCode::BAD_REQUEST);
    assert_eq!(clean_name(&"x".repeat(MAX_MODE_NAME_LEN)).unwrap().len(), MAX_MODE_NAME_LEN);
    assert_eq!(clean_name(&"x".repeat(MAX_MODE_NAME_LEN + 1)).unwrap_err().0, StatusCode::PAYLOAD_TOO_LARGE);
}

#[test]
fn a_mode_name_holds_no_control_or_bidi_characters() {
    for bad in ["a\0b", "a\nb", "a\u{7f}b", "a\u{85}b", "a\u{202E}b", "a\u{2066}b", "a\u{200F}b", "a\u{061C}b"] {
        assert_eq!(clean_name(bad).unwrap_err().0, StatusCode::BAD_REQUEST, "{bad:?}");
    }
    assert_eq!(clean_name("Čeština 血 🎲").unwrap(), "Čeština 血 🎲", "control: names in any script");
}

#[test]
fn only_an_explicit_null_turns_a_mode_off() {
    let parse = |body: Value| serde_json::from_value::<SetActiveRequest>(body).map(|r| r.mode_id).map_err(|_| ());
    assert_eq!(parse(json!({ "mode_id": null })), Ok(None));
    assert_eq!(parse(json!({ "mode_id": 7 })), Ok(Some(7)));
    assert_eq!(parse(json!({})), Err(()), "no mode_id at all");
    assert_eq!(parse(json!({ "modeId": 7 })), Err(()), "misspelt");
}

/// Reclaim hooks all go through upload_handlers::reclaim_file: one upload can back a mode
/// and an icon, an avatar or an emoji, and remove_file checks nothing.
#[test]
fn no_reclaim_hook_calls_remove_file_directly() {
    for (name, source) in [
        ("server_handlers.rs", include_str!("server_handlers.rs")),
        ("handlers.rs", include_str!("handlers.rs")),
        ("reaction_handlers.rs", include_str!("reaction_handlers.rs")),
        ("mode_handlers.rs", include_str!("mode_handlers.rs")),
    ] {
        assert!(!source.contains("upload_handlers::remove_file("), "{name} calls remove_file directly");
    }
}

#[test]
fn an_accent_is_one_spelling_of_six_hex_digits() {
    assert_eq!(clean_accent("#7A1F3D").as_deref(), Some("#7a1f3d"));
    for bad in ["7a1f3d", "#7a1f3", "#7a1f3dd", "#7a1f3g", "red", "#", "#7a1f3\u{e9}", "url(x)"] {
        assert_eq!(clean_accent(bad), None, "{bad}");
    }
}

#[test]
fn a_mode_turns_itself_off_only_after_someone_has_been_in_it() {
    assert_eq!(auto_off_verdict(true, false, false), AutoOff::Touch, "the first person in starts the clock");
    assert_eq!(auto_off_verdict(true, true, true), AutoOff::Touch, "someone is there: it does not matter how long ago");
    assert_eq!(auto_off_verdict(false, false, false), AutoOff::Keep, "nobody yet: turning it on is often the first thing");
    assert_eq!(auto_off_verdict(false, true, false), AutoOff::Keep, "empty, but not for long enough");
    assert_eq!(auto_off_verdict(false, true, true), AutoOff::TurnOff);
}

#[test]
fn the_switch_is_a_server_right_nobody_gets_by_default() {
    assert_eq!(P::SWITCH_MODES.bits(), 1u64 << 31);
    assert!(!P::DEFAULT_MEMBER.contains(P::SWITCH_MODES));
    assert!(!P::OVERWRITABLE.contains(P::SWITCH_MODES), "a mode switches for the whole server");
    assert!(!P::STREAM_ONLY_CAP.contains(P::SWITCH_MODES));
    assert!(!P::MANAGE_CHANNELS.has(P::SWITCH_MODES), "defining a mode is not switching one");
}

mod db {
    use super::*;
    use crate::protocol::ServerMessage as M;

    /// The tick reads every server in the database and judges each by ITS OWN state's
    /// rooms, so one test's tick would turn off another test's aged mode. Every test
    /// that ticks or ages a stamp holds this.
    static AUTO_OFF_TESTS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    struct Fx {
        sid: String,
        owner: i64,
        switcher: i64,
        manager: i64,
        mover: i64,
        plain: i64,
        town: i32,
        cottage: i32,
        lobby: i32,
        text: i32,
        secret: i32,
        users: Vec<i32>,
    }

    fn claims(sub: i64) -> Claims {
        Claims { sub, username: "t".into(), exp: 0, tv: 0, sst: 0, sid: String::new(), ls: false }
    }

    fn state_of(pool: &sqlx::PgPool) -> Arc<AppState> {
        AppState::new(pool.clone(), "test-secret".into(), None, Arc::new(crate::wake::NullWake))
    }

    async fn role(pool: &sqlx::PgPool, sid: &str, user: i32, name: &str, bits: P, position: i32) {
        let (rid,): (i64,) = sqlx::query_as(
            "INSERT INTO server_roles (server_id, name, color, permissions, position, is_default) \
             VALUES ($1, $2, '#99AAB5', $3, $4, false) RETURNING id",
        )
        .bind(sid)
        .bind(name)
        .bind(bits.bits() as i64)
        .bind(position)
        .fetch_one(pool)
        .await
        .expect("role");
        sqlx::query("INSERT INTO member_roles (server_id, user_id, role_id) VALUES ($1, $2, $3)")
            .bind(sid)
            .bind(user)
            .bind(rid)
            .execute(pool)
            .await
            .expect("member role");
    }

    async fn channel(pool: &sqlx::PgPool, sid: &str, name: &str, kind: i32) -> i32 {
        let (id,): (i32,) = sqlx::query_as("INSERT INTO channels (server_id, name, type) VALUES ($1, $2, $3) RETURNING id")
            .bind(sid)
            .bind(name)
            .bind(kind)
            .fetch_one(pool)
            .await
            .expect("channel");
        id
    }

    /// Make `user` a stream-only account, in the voice channel a role overwrite opens for
    /// it: anywhere else its permissions resolve to nothing at all (docs/STREAM_ONLY.md).
    async fn stream_only_in(pool: &sqlx::PgPool, sid: &str, user: i32, channel: i32) {
        let (rid,): (i64,) = sqlx::query_as(
            "INSERT INTO server_roles (server_id, name, color, permissions, position, is_default) \
             VALUES ($1, 'stream only', '#99AAB5', $2, 4, false) RETURNING id",
        )
        .bind(sid)
        .bind(P::STREAM_ONLY.bits() as i64)
        .fetch_one(pool)
        .await
        .expect("role");
        sqlx::query("INSERT INTO member_roles (server_id, user_id, role_id) VALUES ($1, $2, $3)")
            .bind(sid)
            .bind(user)
            .bind(rid)
            .execute(pool)
            .await
            .expect("member role");
        sqlx::query("INSERT INTO channel_permission_overwrites (channel_id, role_id, allow, deny) VALUES ($1, $2, $3, 0)")
            .bind(channel as i64)
            .bind(rid)
            .bind((P::VIEW_CHANNEL | P::CONNECT).bits() as i64)
            .execute(pool)
            .await
            .expect("overwrite");
    }

    async fn subchannel(pool: &sqlx::PgPool, sid: &str, name: &str, kind: i32, parent: i32) -> i32 {
        let (id,): (i32,) =
            sqlx::query_as("INSERT INTO channels (server_id, name, type, parent_id) VALUES ($1, $2, $3, $4) RETURNING id")
                .bind(sid)
                .bind(name)
                .bind(kind)
                .bind(parent)
                .fetch_one(pool)
                .await
                .expect("subchannel");
        id
    }

    async fn setup(pool: &sqlx::PgPool) -> Fx {
        let tag = uuid::Uuid::new_v4().simple().to_string();
        let mk = |n: &str| format!("md_{n}_{}", &tag[..12]);
        let mut users = Vec::new();
        for n in ["owner", "switcher", "manager", "mover", "plain"] {
            let (id,): (i32,) = sqlx::query_as("INSERT INTO users (username, salt, verifier) VALUES ($1, $2, $3) RETURNING id")
                .bind(mk(n))
                .bind(b"s".as_ref())
                .bind(b"v".as_ref())
                .fetch_one(pool)
                .await
                .expect("user");
            users.push(id);
        }
        let sid = uuid::Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO servers (id, name, owner_id) VALUES ($1, $2, $3)")
            .bind(&sid)
            .bind(mk("srv"))
            .bind(users[0])
            .execute(pool)
            .await
            .expect("server");
        for &u in &users {
            sqlx::query("INSERT INTO server_members (server_id, user_id) VALUES ($1, $2)")
                .bind(&sid)
                .bind(u)
                .execute(pool)
                .await
                .expect("member");
        }
        let (everyone,): (i64,) = sqlx::query_as(
            "INSERT INTO server_roles (server_id, name, color, permissions, position, is_default) \
             VALUES ($1, '@everyone', '#99AAB5', $2, 0, true) RETURNING id",
        )
        .bind(&sid)
        .bind((P::VIEW_CHANNEL | P::CONNECT | P::SPEAK).bits() as i64)
        .fetch_one(pool)
        .await
        .expect("@everyone");
        role(pool, &sid, users[1], "storyteller", P::SWITCH_MODES, 1).await;
        role(pool, &sid, users[2], "manager", P::MANAGE_CHANNELS, 2).await;
        role(pool, &sid, users[3], "mover", P::MOVE_MEMBERS, 5).await;
        let town = channel(pool, &sid, "town", 1).await;
        let cottage = channel(pool, &sid, "cottage", 1).await;
        let lobby = channel(pool, &sid, "lobby", 1).await;
        let text = channel(pool, &sid, "game-chat", 0).await;
        let secret = channel(pool, &sid, "secret", 1).await;
        sqlx::query("INSERT INTO channel_permission_overwrites (channel_id, role_id, allow, deny) VALUES ($1, $2, 0, $3)")
            .bind(secret as i64)
            .bind(everyone)
            .bind(P::VIEW_CHANNEL.bits() as i64)
            .execute(pool)
            .await
            .expect("deny");
        Fx {
            sid,
            owner: users[0] as i64,
            switcher: users[1] as i64,
            manager: users[2] as i64,
            mover: users[3] as i64,
            plain: users[4] as i64,
            town,
            cottage,
            lobby,
            text,
            secret,
            users,
        }
    }

    async fn teardown(pool: &sqlx::PgPool, f: &Fx) {
        let _ = sqlx::query("DELETE FROM channels WHERE server_id = $1").bind(&f.sid).execute(pool).await;
        let _ = sqlx::query("DELETE FROM servers WHERE id = $1").bind(&f.sid).execute(pool).await;
        let _ = sqlx::query("DELETE FROM users WHERE id = ANY($1)").bind(f.users.clone()).execute(pool).await;
    }

    struct Sock {
        rx: mpsc::Receiver<ServerMessage>,
        conn: u64,
        user: i64,
    }

    impl Sock {
        fn open(state: &Arc<AppState>, user: i64) -> Sock {
            let (tx, rx) = mpsc::channel::<ServerMessage>(256);
            let (conn, _, _) = state.register_session(user, format!("u{user}"), tx, false, None, format!("s{user}"));
            Sock { rx, conn, user }
        }
        fn in_room(state: &Arc<AppState>, user: i64, channel: i32) -> Sock {
            let s = Self::open(state, user);
            state.join_room(&format!("voice_{channel}"), s.user, s.conn);
            s
        }
        fn drain(&mut self) -> Vec<ServerMessage> {
            let mut out = Vec::new();
            while let Ok(m) = self.rx.try_recv() {
                out.push(m);
            }
            out
        }
    }

    async fn read(resp: Response) -> (StatusCode, Value) {
        let status = resp.status();
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.expect("body");
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    async fn create(state: &Arc<AppState>, f: &Fx, by: i64, body: Value) -> (StatusCode, Value) {
        read(
            create_mode(
                State(Arc::clone(state)),
                Path(f.sid.clone()),
                Extension(claims(by)),
                Json(serde_json::from_value(body).unwrap()),
            )
            .await,
        )
        .await
    }

    async fn make(state: &Arc<AppState>, f: &Fx, name: &str, channels: &[i32]) -> i32 {
        let (status, body) = create(state, f, f.owner, json!({ "name": name, "channel_ids": channels })).await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        body["id"].as_i64().unwrap() as i32
    }

    async fn switch(state: &Arc<AppState>, f: &Fx, by: i64, mode: Option<i32>) -> (StatusCode, Value) {
        read(
            set_active_mode(
                State(Arc::clone(state)),
                Path(f.sid.clone()),
                Extension(claims(by)),
                Json(SetActiveRequest { mode_id: mode }),
            )
            .await,
        )
        .await
    }

    async fn patch(state: &Arc<AppState>, f: &Fx, by: i64, mode: i32, body: Value) -> StatusCode {
        update_mode(
            State(Arc::clone(state)),
            Path((f.sid.clone(), mode)),
            Extension(claims(by)),
            Json(serde_json::from_value(body).unwrap()),
        )
        .await
        .status()
    }

    async fn modes(state: &Arc<AppState>, f: &Fx, by: i64) -> (StatusCode, Value) {
        read(list_modes(State(Arc::clone(state)), Path(f.sid.clone()), Extension(claims(by))).await).await
    }

    /// (kind, room or mode) of every mode and call-ending frame, in order.
    fn story(frames: &[ServerMessage]) -> Vec<String> {
        frames
            .iter()
            .filter_map(|m| match m {
                M::ServerModeChanged { active_mode_id, .. } => Some(format!("mode:{active_mode_id:?}")),
                M::RoomLeft { room_id, .. } => Some(format!("left:{room_id}")),
                _ => None,
            })
            .collect()
    }

    /// The whole point of hiding rather than denying: a switch touches no
    /// permission and rotates no key, and the list a client gets still has every
    /// channel in it (an older client lists them all). The control is what a
    /// real permission change does to the same counter.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_switch_changes_no_permission_and_rotates_no_key() {
        let Some(pool) = crate::migrator::test_pool(8).await else { return };
        let f = setup(&pool).await;
        let state = state_of(&pool);
        let mode = make(&state, &f, "Clocktower", &[f.town, f.text]).await;
        let generation = |pool: sqlx::PgPool, sid: String| async move {
            sqlx::query_scalar::<_, i32>("SELECT member_generation FROM servers WHERE id = $1")
                .bind(sid)
                .fetch_one(&pool)
                .await
                .unwrap()
        };
        let before = generation(pool.clone(), f.sid.clone()).await;
        let overwrites = |pool: sqlx::PgPool, town: i32| async move {
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM channel_permission_overwrites WHERE channel_id = $1")
                .bind(town)
                .fetch_one(&pool)
                .await
                .unwrap()
        };
        let overwrites_before = overwrites(pool.clone(), f.town).await;
        assert_eq!(switch(&state, &f, f.owner, Some(mode)).await.0, StatusCode::OK);
        assert_eq!(switch(&state, &f, f.owner, None).await.0, StatusCode::OK);
        let after = generation(pool.clone(), f.sid.clone()).await;
        let overwrites_after = overwrites(pool.clone(), f.town).await;

        let listed = crate::channel_handlers::list_channels(
            State(Arc::clone(&state)),
            Path(f.sid.clone()),
            Extension(claims(f.plain)),
        )
        .await
        .into_response();
        let (_, rows) = read(listed).await;
        let town = rows.as_array().unwrap().iter().find(|c| c["id"] == f.town).expect("still listed while off").clone();

        crate::ws::broadcast_perms_changed_and_evict(&state, &f.sid).await;
        let control = generation(pool.clone(), f.sid.clone()).await;
        teardown(&pool, &f).await;
        assert_eq!(after, before, "no key rotation");
        assert_eq!(overwrites_after, overwrites_before);
        assert_eq!(town["mode_ids"], json!([mode]));
        assert_ne!(town["my_permissions"], 0);
        assert_eq!(control, before + 1, "control: a real permission change does bump it");
    }

    /// Switch Modes switches and does nothing else; Manage Channels edits and
    /// does not switch; the owner does both; a member does neither.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn the_switch_and_the_editor_are_separate_rights() {
        let Some(pool) = crate::migrator::test_pool(8).await else { return };
        let f = setup(&pool).await;
        let state = state_of(&pool);
        let mode = make(&state, &f, "Clocktower", &[f.town]).await;

        let plain_switch = switch(&state, &f, f.plain, Some(mode)).await.0;
        let manager_switch = switch(&state, &f, f.manager, Some(mode)).await.0;
        let switcher_switch = switch(&state, &f, f.switcher, Some(mode)).await.0;
        let owner_switch = switch(&state, &f, f.owner, None).await.0;

        let plain_edit = patch(&state, &f, f.plain, mode, json!({ "name": "x" })).await;
        let switcher_edit = patch(&state, &f, f.switcher, mode, json!({ "name": "x" })).await;
        let manager_edit = patch(&state, &f, f.manager, mode, json!({ "name": "Renamed" })).await;
        let plain_create = create(&state, &f, f.plain, json!({ "name": "x" })).await.0;
        let switcher_create = create(&state, &f, f.switcher, json!({ "name": "x" })).await.0;

        let (_, for_plain) = modes(&state, &f, f.plain).await;
        let (_, for_switcher) = modes(&state, &f, f.switcher).await;
        let (_, for_manager) = modes(&state, &f, f.manager).await;
        let (_, for_owner) = modes(&state, &f, f.owner).await;
        let rights = |v: &Value| (v["can_switch"].clone(), v["can_edit"].clone(), v["can_call_back"].clone());

        let outsider: (i32,) = sqlx::query_as("INSERT INTO users (username, salt, verifier) VALUES ($1, $2, $3) RETURNING id")
            .bind(format!("md_out_{}", uuid::Uuid::new_v4().simple()))
            .bind(b"s".as_ref())
            .bind(b"v".as_ref())
            .fetch_one(&pool)
            .await
            .unwrap();
        let outsider_read = modes(&state, &f, outsider.0 as i64).await.0;
        let outsider_switch = switch(&state, &f, outsider.0 as i64, None).await.0;
        let _ = sqlx::query("DELETE FROM users WHERE id = $1").bind(outsider.0).execute(&pool).await;
        teardown(&pool, &f).await;

        assert_eq!(plain_switch, StatusCode::FORBIDDEN);
        assert_eq!(manager_switch, StatusCode::FORBIDDEN);
        assert_eq!(switcher_switch, StatusCode::OK);
        assert_eq!(owner_switch, StatusCode::OK);
        assert_eq!(plain_edit, StatusCode::FORBIDDEN);
        assert_eq!(switcher_edit, StatusCode::FORBIDDEN);
        assert_eq!(manager_edit, StatusCode::OK);
        assert_eq!(plain_create, StatusCode::FORBIDDEN);
        assert_eq!(switcher_create, StatusCode::FORBIDDEN);
        assert_eq!(rights(&for_plain), (json!(false), json!(false), json!(false)));
        assert_eq!(rights(&for_switcher), (json!(true), json!(false), json!(false)));
        assert_eq!(rights(&for_manager), (json!(false), json!(true), json!(false)));
        assert_eq!(rights(&for_owner), (json!(true), json!(true), json!(true)));
        assert_eq!(outsider_read, StatusCode::FORBIDDEN);
        assert_eq!(outsider_switch, StatusCode::FORBIDDEN);
    }

    /// Turning a mode off ends the calls in its voice channels and nobody else's.
    /// Everyone hears about it, and the frame goes first so a client knows why
    /// its call is ending. Turning a mode ON disconnects nobody.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn turning_off_ends_only_the_calls_it_hides() {
        let Some(pool) = crate::migrator::test_pool(8).await else { return };
        let f = setup(&pool).await;
        let state = state_of(&pool);
        let mode = make(&state, &f, "Clocktower", &[f.town, f.cottage, f.text]).await;

        let mut in_town = Sock::in_room(&state, f.plain, f.town);
        let mut in_cottage = Sock::in_room(&state, f.mover, f.cottage);
        let mut in_lobby = Sock::in_room(&state, f.manager, f.lobby);
        let mut watcher = Sock::open(&state, f.switcher);

        let (on_status, on_body) = switch(&state, &f, f.owner, Some(mode)).await;
        let town_after_on = occupants(&state, f.town);
        let on_story = story(&in_town.drain());
        in_cottage.drain();
        in_lobby.drain();
        watcher.drain();

        let (off_status, off_body) = switch(&state, &f, f.switcher, None).await;
        let town_after_off = occupants(&state, f.town);
        let cottage_after_off = occupants(&state, f.cottage);
        let lobby_after_off = occupants(&state, f.lobby);
        let town_story = story(&in_town.drain());
        let cottage_story = story(&in_cottage.drain());
        let lobby_story = story(&in_lobby.drain());
        let watcher_story = story(&watcher.drain());
        let (stored,): (Option<i32>,) =
            sqlx::query_as("SELECT active_mode_id FROM servers WHERE id = $1").bind(&f.sid).fetch_one(&pool).await.unwrap();
        let (audit,): (String,) = sqlx::query_as(
            "SELECT details FROM audit_log WHERE server_id = $1 AND action_type = 'mode_switch' ORDER BY id DESC LIMIT 1",
        )
        .bind(&f.sid)
        .fetch_one(&pool)
        .await
        .unwrap();
        teardown(&pool, &f).await;

        assert_eq!(on_status, StatusCode::OK);
        assert_eq!(on_body["disconnected"], 0, "turning on takes nobody out");
        assert_eq!(town_after_on, vec![f.plain]);
        assert_eq!(on_story, vec![format!("mode:Some({mode})")]);

        assert_eq!(off_status, StatusCode::OK);
        assert_eq!(off_body["active_mode_id"], Value::Null);
        assert_eq!(off_body["disconnected"], 2);
        assert_eq!(stored, None);
        assert!(town_after_off.is_empty() && cottage_after_off.is_empty(), "both calls ended");
        assert_eq!(lobby_after_off, vec![f.manager], "a channel in no mode keeps its call");
        let left = |c: i32| format!("left:voice_{c}");
        assert_eq!(town_story, vec!["mode:None".to_string(), left(f.town)], "the reason first");
        assert_eq!(cottage_story, vec!["mode:None".to_string(), left(f.cottage)]);
        assert_eq!(lobby_story, vec!["mode:None".to_string()]);
        assert_eq!(watcher_story, vec!["mode:None".to_string()], "members out of voice hear too");
        assert_eq!(audit, "Clocktower off, 2 disconnected");
    }

    /// One at a time: picking a mode replaces the current one, and a call in a
    /// channel the two share carries on.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn switching_between_modes_keeps_a_shared_call() {
        let Some(pool) = crate::migrator::test_pool(8).await else { return };
        let f = setup(&pool).await;
        let state = state_of(&pool);
        let a = make(&state, &f, "A", &[f.town, f.cottage]).await;
        let b = make(&state, &f, "B", &[f.town, f.lobby]).await;
        let mut in_town = Sock::in_room(&state, f.plain, f.town);
        let mut in_cottage = Sock::in_room(&state, f.mover, f.cottage);
        assert_eq!(switch(&state, &f, f.owner, Some(a)).await.0, StatusCode::OK);
        in_town.drain();
        in_cottage.drain();

        let (status, body) = switch(&state, &f, f.owner, Some(b)).await;
        let town = occupants(&state, f.town);
        let cottage = occupants(&state, f.cottage);
        let town_frames = in_town.drain();
        let cottage_story = story(&in_cottage.drain());
        // The same mode again is not a switch: no frame, nothing ended.
        let (again_status, again_body) = switch(&state, &f, f.owner, Some(b)).await;
        let again_frames = story(&in_town.drain());
        teardown(&pool, &f).await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["active_mode_id"], b);
        assert_eq!(body["disconnected"], 1);
        assert_eq!(town, vec![f.plain], "town is in both modes");
        assert!(cottage.is_empty());
        let previous = town_frames.iter().find_map(|m| match m {
            M::ServerModeChanged { previous_mode_id, active_mode_id, by, .. } => Some((*previous_mode_id, *active_mode_id, *by)),
            _ => None,
        });
        assert_eq!(previous, Some((Some(a as i64), Some(b as i64), Some(f.owner))));
        assert_eq!(story(&town_frames), vec![format!("mode:Some({b})")], "no RoomLeft for town");
        assert_eq!(cottage_story, vec![format!("mode:Some({b})"), format!("left:voice_{}", f.cottage)]);
        assert_eq!(again_status, StatusCode::OK);
        assert_eq!(again_body["disconnected"], 0);
        assert!(again_frames.is_empty(), "{again_frames:?}");
    }

    /// A mode names channels only to people who can see them, and a manager's
    /// save cannot quietly drop a channel hidden from them.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn channels_the_reader_cannot_see_stay_unnamed_and_survive_a_save() {
        let Some(pool) = crate::migrator::test_pool(8).await else { return };
        let f = setup(&pool).await;
        let state = state_of(&pool);
        let mode = make(&state, &f, "Clocktower", &[f.town, f.secret]).await;
        assert_eq!(patch(&state, &f, f.owner, mode, json!({ "home_channel_id": f.secret })).await, StatusCode::OK);

        let (_, for_owner) = modes(&state, &f, f.owner).await;
        let (_, for_plain) = modes(&state, &f, f.plain).await;

        let hidden_refused = patch(&state, &f, f.manager, mode, json!({ "channel_ids": [f.secret] })).await;
        let saved = patch(&state, &f, f.manager, mode, json!({ "channel_ids": [f.cottage] })).await;
        let (_, after_for_owner) = modes(&state, &f, f.owner).await;
        let (_, after_for_manager) = modes(&state, &f, f.manager).await;
        teardown(&pool, &f).await;

        let of = |v: &Value| (v["modes"][0]["channel_ids"].clone(), v["modes"][0]["home_channel_id"].clone());
        assert_eq!(of(&for_owner), (json!([f.town, f.secret]), json!(f.secret)));
        assert_eq!(of(&for_plain), (json!([f.town]), Value::Null), "the hidden channel is not named, even as the home");
        assert_eq!(hidden_refused, StatusCode::BAD_REQUEST, "a manager cannot add what they cannot see");
        assert_eq!(saved, StatusCode::OK);
        assert_eq!(of(&after_for_owner).0, json!([f.cottage, f.secret]), "town replaced, secret kept");
        assert_eq!(of(&after_for_manager).0, json!([f.cottage]));
    }

    /// What may go into a mode and what may not.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn an_edit_is_checked_against_this_server() {
        let Some(pool) = crate::migrator::test_pool(8).await else { return };
        let f = setup(&pool).await;
        let state = state_of(&pool);
        let other = setup(&pool).await;
        let mode = make(&state, &f, "Clocktower", &[f.town]).await;
        sqlx::query("UPDATE channels SET is_afk = true WHERE id = $1").bind(f.lobby).execute(&pool).await.unwrap();

        let foreign_channel = patch(&state, &f, f.owner, mode, json!({ "channel_ids": [other.town] })).await;
        let afk_channel = patch(&state, &f, f.owner, mode, json!({ "channel_ids": [f.lobby] })).await;
        let text_home = patch(&state, &f, f.owner, mode, json!({ "home_channel_id": f.text })).await;
        let foreign_home = patch(&state, &f, f.owner, mode, json!({ "home_channel_id": other.town })).await;
        let afk_home = patch(&state, &f, f.owner, mode, json!({ "home_channel_id": f.lobby })).await;
        let good_home = patch(&state, &f, f.owner, mode, json!({ "home_channel_id": f.town })).await;
        let cleared_home = patch(&state, &f, f.owner, mode, json!({ "home_channel_id": 0 })).await;
        let bad_accent = patch(&state, &f, f.owner, mode, json!({ "accent_color": "red" })).await;
        let good_accent = patch(&state, &f, f.owner, mode, json!({ "accent_color": "#7A1F3D" })).await;
        let blank_name = patch(&state, &f, f.owner, mode, json!({ "name": "  " })).await;
        let foreign_mode = patch(&state, &other, other.owner, mode, json!({ "name": "stolen" })).await;
        let (_, read) = modes(&state, &f, f.owner).await;
        let cross_switch = switch(&state, &other, other.owner, Some(mode)).await.0;
        let nameless = create(&state, &f, f.owner, json!({})).await.0;
        teardown(&pool, &f).await;
        teardown(&pool, &other).await;

        assert_eq!(foreign_channel, StatusCode::BAD_REQUEST);
        assert_eq!(afk_channel, StatusCode::BAD_REQUEST);
        assert_eq!(text_home, StatusCode::BAD_REQUEST);
        assert_eq!(foreign_home, StatusCode::BAD_REQUEST);
        assert_eq!(afk_home, StatusCode::BAD_REQUEST);
        assert_eq!(good_home, StatusCode::OK);
        assert_eq!(cleared_home, StatusCode::OK);
        assert_eq!(bad_accent, StatusCode::BAD_REQUEST);
        assert_eq!(good_accent, StatusCode::OK);
        assert_eq!(blank_name, StatusCode::BAD_REQUEST);
        assert_eq!(foreign_mode, StatusCode::NOT_FOUND);
        assert_eq!(read["modes"][0]["name"], "Clocktower");
        assert_eq!(read["modes"][0]["accent_color"], "#7a1f3d");
        assert_eq!(read["modes"][0]["home_channel_id"], Value::Null);
        assert_eq!(cross_switch, StatusCode::NOT_FOUND);
        assert_eq!(nameless, StatusCode::BAD_REQUEST);
    }

    async fn upload(pool: &sqlx::PgPool, by: i64, mime: &str, size: i64) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO uploaded_files (id, uploader_id, original_name, stored_name, mime_type, size_bytes) \
             VALUES ($1::uuid, $2, 'bg', $3, $4, $5)",
        )
        .bind(&id)
        .bind(by as i32)
        .bind(format!("mode-test-{id}"))
        .bind(mime)
        .bind(size)
        .execute(pool)
        .await
        .expect("upload");
        id
    }

    async fn file_exists(pool: &sqlx::PgPool, id: &str) -> bool {
        sqlx::query_scalar::<_, bool>("SELECT EXISTS (SELECT 1 FROM uploaded_files WHERE id = $1::uuid)")
            .bind(id)
            .fetch_one(pool)
            .await
            .unwrap()
    }

    /// The picture is guarded like a server icon, everywhere an icon is: only
    /// your own upload, only a picture of a bearable size, members may fetch it,
    /// it cannot be deleted while in use, and replacing it reclaims the old file
    /// unless something else still points at it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_background_is_guarded_like_a_server_icon() {
        let Some(pool) = crate::migrator::test_pool(8).await else { return };
        let f = setup(&pool).await;
        let state = state_of(&pool);
        let mode = make(&state, &f, "Clocktower", &[]).await;
        let mine = upload(&pool, f.manager, "image/jpeg", 1000).await;
        let someone_elses = upload(&pool, f.plain, "image/jpeg", 1000).await;
        let not_a_picture = upload(&pool, f.manager, "application/pdf", 1000).await;
        let a_gif = upload(&pool, f.manager, "image/gif", 1000).await;
        let too_big = upload(&pool, f.manager, "image/jpeg", MAX_BACKGROUND_BYTES + 1).await;

        let set = |id: String| json!({ "background_file_id": id });
        let elses = patch(&state, &f, f.manager, mode, set(someone_elses.clone())).await;
        let pdf = patch(&state, &f, f.manager, mode, set(not_a_picture.clone())).await;
        let gif = patch(&state, &f, f.manager, mode, set(a_gif.clone())).await;
        let big = patch(&state, &f, f.manager, mode, set(too_big.clone())).await;
        let garbage = patch(&state, &f, f.manager, mode, set("not-a-uuid".into())).await;
        let good = patch(&state, &f, f.manager, mode, set(mine.clone())).await;

        let delete_while_used = crate::upload_handlers::file_is_referenced(&pool, &mine).await.unwrap();
        let unused = crate::upload_handlers::file_is_referenced(&pool, &not_a_picture).await.unwrap();

        // Another mode shares it: replacing it in this one keeps the file.
        let sharer = make(&state, &f, "Sharer", &[]).await;
        assert_eq!(patch(&state, &f, f.manager, sharer, set(mine.clone())).await, StatusCode::OK);
        let next = upload(&pool, f.manager, "image/webp", 1000).await;
        assert_eq!(patch(&state, &f, f.manager, mode, set(next.clone())).await, StatusCode::OK);
        let kept_while_shared = file_exists(&pool, &mine).await;
        // The last reference goes: now it does.
        assert_eq!(patch(&state, &f, f.manager, sharer, set(String::new())).await, StatusCode::OK);
        let reclaimed = !file_exists(&pool, &mine).await;
        // Caller-scoped: someone else clearing it leaves the uploader's file.
        assert_eq!(patch(&state, &f, f.owner, mode, set(String::new())).await, StatusCode::OK);
        let kept_for_uploader = file_exists(&pool, &next).await;

        // An account's deletion keeps a file that backs a mode (the icon's rule).
        let backing = upload(&pool, f.manager, "image/png", 1000).await;
        let loose = upload(&pool, f.manager, "image/png", 1000).await;
        assert_eq!(patch(&state, &f, f.manager, mode, set(backing.clone())).await, StatusCode::OK);
        sqlx::query(crate::handlers::UPLOAD_GRACE_STAMP_SQL).bind(f.manager as i32).bind(30i32).execute(&pool).await.expect("stamp");
        let f_manager = f.manager;
        let stamp_of = |id: String| {
            let pool = pool.clone();
            async move {
                sqlx::query_scalar::<_, bool>("SELECT purge_after IS NOT NULL FROM uploaded_files WHERE id = $1::uuid")
                    .bind(id)
                    .fetch_one(&pool)
                    .await
                    .unwrap()
            }
        };
        let backing_stamped = stamp_of(backing.clone()).await;
        let loose_stamped = stamp_of(loose.clone()).await;

        // ...and the sweep that acts on the stamp skips one picked up since.
        sqlx::query("UPDATE uploaded_files SET purge_after = NOW() - make_interval(days => 1) WHERE id = ANY($1::uuid[])")
            .bind(vec![backing.clone(), loose.clone()])
            .execute(&pool)
            .await
            .unwrap();
        let due: Vec<(String, String)> = sqlx::query_as(crate::upload_handlers::UPLOADS_DUE_FOR_PURGE_SQL).fetch_all(&pool).await.unwrap();
        let backing_due = due.iter().any(|(id, _)| *id == backing);
        let loose_due = due.iter().any(|(id, _)| *id == loose);

        // Who may fetch it: a member, as with a server icon. Not an outsider.
        let visible = |caller: i64, id: String| {
            let pool = pool.clone();
            async move { crate::upload_handlers::uncapped_file_visible(&pool, &id, f_manager, "attachment", None, Some(chrono::Utc::now()), caller).await }
        };
        let member_sees = visible(f.plain, backing.clone()).await;
        let (outsider,): (i32,) = sqlx::query_as("INSERT INTO users (username, salt, verifier) VALUES ($1, $2, $3) RETURNING id")
            .bind(format!("md_out_{}", uuid::Uuid::new_v4().simple()))
            .bind(b"s".as_ref())
            .bind(b"v".as_ref())
            .fetch_one(&pool)
            .await
            .unwrap();
        let outsider_sees = visible(outsider as i64, backing.clone()).await;
        let _ = sqlx::query("DELETE FROM users WHERE id = $1").bind(outsider).execute(&pool).await;

        let _ = sqlx::query("DELETE FROM uploaded_files WHERE uploader_id = ANY($1)").bind(f.users.clone()).execute(&pool).await;
        teardown(&pool, &f).await;

        assert_eq!(elses, StatusCode::FORBIDDEN);
        assert_eq!(pdf, StatusCode::BAD_REQUEST);
        assert_eq!(gif, StatusCode::BAD_REQUEST, "no animated pictures");
        assert_eq!(big, StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(garbage, StatusCode::FORBIDDEN);
        assert_eq!(good, StatusCode::OK);
        assert!(delete_while_used, "in use: the delete route refuses it");
        assert!(!unused);
        assert!(kept_while_shared, "another mode still shows it");
        assert!(reclaimed);
        assert!(kept_for_uploader, "a reclaim only ever deletes the caller's own upload");
        assert!(!backing_stamped, "a mode's background belongs to the server");
        assert!(loose_stamped, "control: an unreferenced upload is stamped");
        assert!(!backing_due, "the sweep skips a background");
        assert!(loose_due, "control: the sweep takes what nothing uses");
        assert!(member_sees, "members may fetch it, as with a server icon");
        assert!(!outsider_sees, "an outsider may not");
    }

    /// Deleting the mode that is on is turning it off, with all that means.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn deleting_the_active_mode_turns_it_off() {
        let Some(pool) = crate::migrator::test_pool(8).await else { return };
        let f = setup(&pool).await;
        let state = state_of(&pool);
        let on = make(&state, &f, "On", &[f.town]).await;
        let off = make(&state, &f, "Off", &[f.cottage]).await;
        let mut in_town = Sock::in_room(&state, f.plain, f.town);
        let mut in_cottage = Sock::in_room(&state, f.mover, f.cottage);
        assert_eq!(switch(&state, &f, f.owner, Some(on)).await.0, StatusCode::OK);
        in_town.drain();
        in_cottage.drain();

        let delete = |id: i32, by: i64| {
            delete_mode(State(Arc::clone(&state)), Path((f.sid.clone(), id)), Extension(claims(by)))
        };
        let deleted_off = delete(off, f.manager).await.status();
        let cottage_after = occupants(&state, f.cottage);
        let cottage_frames = in_cottage.drain();
        let deleted_on = delete(on, f.owner).await.status();
        let town_after = occupants(&state, f.town);
        let town_story = story(&in_town.drain());
        let gone_again = delete(on, f.owner).await.status();
        let (stored,): (Option<i32>,) =
            sqlx::query_as("SELECT active_mode_id FROM servers WHERE id = $1").bind(&f.sid).fetch_one(&pool).await.unwrap();
        let channel_kept = sqlx::query_scalar::<_, bool>("SELECT EXISTS (SELECT 1 FROM channels WHERE id = $1)")
            .bind(f.town)
            .fetch_one(&pool)
            .await
            .unwrap();
        teardown(&pool, &f).await;

        assert_eq!(deleted_off, StatusCode::OK, "Manage Channels is enough for a mode that is off");
        assert_eq!(cottage_after, vec![f.mover], "deleting a mode that is off ends nothing");
        assert!(story(&cottage_frames).is_empty(), "{cottage_frames:?}");
        assert!(cottage_frames.iter().any(|m| matches!(m, M::ServerModesEdited { .. })), "everyone refetches");
        assert_eq!(deleted_on, StatusCode::OK);
        assert!(town_after.is_empty());
        assert_eq!(town_story, vec!["mode:None".to_string(), format!("left:voice_{}", f.town)]);
        assert_eq!(gone_again, StatusCode::NOT_FOUND);
        assert_eq!(stored, None);
        assert!(channel_kept, "a mode's channels outlive it");
    }

    /// Deleting a channel takes it out of its modes; deleting a server with a
    /// mode on works despite the two foreign keys pointing at each other.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn channels_and_servers_can_still_be_deleted() {
        let Some(pool) = crate::migrator::test_pool(8).await else { return };
        let f = setup(&pool).await;
        let state = state_of(&pool);
        let mode = make(&state, &f, "Clocktower", &[f.town, f.cottage]).await;
        assert_eq!(patch(&state, &f, f.owner, mode, json!({ "home_channel_id": f.cottage })).await, StatusCode::OK);
        assert_eq!(switch(&state, &f, f.owner, Some(mode)).await.0, StatusCode::OK);
        sqlx::query("DELETE FROM channels WHERE id = $1").bind(f.cottage).execute(&pool).await.expect("delete channel");
        let (_, read) = modes(&state, &f, f.owner).await;
        let deleted = sqlx::query("DELETE FROM servers WHERE id = $1").bind(&f.sid).execute(&pool).await;
        let left = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM server_modes WHERE id = $1")
            .bind(mode)
            .fetch_one(&pool)
            .await
            .unwrap();
        teardown(&pool, &f).await;
        assert_eq!(read["modes"][0]["channel_ids"], json!([f.town]));
        assert_eq!(read["modes"][0]["home_channel_id"], Value::Null, "the main channel went with it");
        assert!(deleted.is_ok(), "{deleted:?}");
        assert_eq!(left, 0);
    }

    /// The counts a switch and Call everyone back answer with must not give away who
    /// is in a room hidden from the caller: a voice move's own answers read like no
    /// call at all there, and the audit log, for administrators, has the whole count.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn the_counts_say_nothing_of_a_room_hidden_from_the_caller() {
        let Some(pool) = crate::migrator::test_pool(8).await else { return };
        let f = setup(&pool).await;
        let state = state_of(&pool);
        // `secret` is VIEW-denied to everyone but the owner.
        let mode = make(&state, &f, "Clocktower", &[f.town, f.cottage, f.secret]).await;
        assert_eq!(patch(&state, &f, f.owner, mode, json!({ "home_channel_id": f.town })).await, StatusCode::OK);
        assert_eq!(switch(&state, &f, f.owner, Some(mode)).await.0, StatusCode::OK);
        let _in_secret = Sock::in_room(&state, f.manager, f.secret);
        let _in_cottage = Sock::in_room(&state, f.plain, f.cottage);

        let (_, back) = read(
            call_everyone_back(State(Arc::clone(&state)), Path(f.sid.clone()), Extension(claims(f.mover))).await,
        )
        .await;
        let secret_after_back = occupants(&state, f.secret);
        let _in_cottage_again = Sock::in_room(&state, f.plain, f.cottage);

        let (_, off) = switch(&state, &f, f.switcher, None).await;
        let secret_after_off = occupants(&state, f.secret);
        let (audit,): (String,) = sqlx::query_as(
            "SELECT details FROM audit_log WHERE server_id = $1 AND action_type = 'mode_switch' ORDER BY id DESC LIMIT 1",
        )
        .bind(&f.sid)
        .fetch_one(&pool)
        .await
        .unwrap();
        teardown(&pool, &f).await;

        assert_eq!(back["moved"], 1, "the person in the room the mover can see");
        assert_eq!(back["skipped"], 0, "the hidden room is not counted at all");
        assert_eq!(secret_after_back, vec![f.manager], "and nobody was moved out of it");
        assert_eq!(off["disconnected"], 1, "the switcher hears of the room they can see");
        assert!(secret_after_off.is_empty(), "the hidden room's call still ended");
        assert_eq!(audit, "Clocktower off, 2 disconnected", "the audit log has the whole count");
    }

    /// Call everyone back moves people through the same checks as a drag: only
    /// from the mode's own channels, never someone ranked at or above the caller,
    /// and they are counted instead. Never the caller: their client walks.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn call_everyone_back_gathers_who_it_may() {
        let Some(pool) = crate::migrator::test_pool(8).await else { return };
        let f = setup(&pool).await;
        let state = state_of(&pool);
        let mode = make(&state, &f, "Clocktower", &[f.town, f.cottage, f.text]).await;
        let call = |by: i64| {
            call_everyone_back(State(Arc::clone(&state)), Path(f.sid.clone()), Extension(claims(by)))
        };
        let nothing_on = call(f.mover).await.status();
        assert_eq!(switch(&state, &f, f.owner, Some(mode)).await.0, StatusCode::OK);
        let no_home = call(f.mover).await.status();
        assert_eq!(patch(&state, &f, f.owner, mode, json!({ "home_channel_id": f.town })).await, StatusCode::OK);

        let mut plain = Sock::in_room(&state, f.plain, f.cottage); // moves
        let mut owner = Sock::in_room(&state, f.owner, f.cottage); // ranked above: stays
        let _mover = Sock::in_room(&state, f.mover, f.cottage); // the caller
        let _in_town = Sock::in_room(&state, f.manager, f.town); // already there
        let mut outsider = Sock::in_room(&state, f.switcher, f.lobby); // not in the mode's channels
        plain.drain();
        owner.drain();
        outsider.drain();

        let not_allowed = call(f.plain).await.status();
        let (status, body) = read(call(f.mover).await).await;
        let plain_frames = plain.drain();
        let owner_frames = owner.drain();
        let outsider_frames = outsider.drain();
        let cottage = occupants(&state, f.cottage);
        let lobby = occupants(&state, f.lobby);
        // A main channel another mode has since taken is nowhere to gather.
        let other = make(&state, &f, "Other", &[f.town]).await;
        sqlx::query("DELETE FROM server_mode_channels WHERE mode_id = $1 AND channel_id = $2")
            .bind(mode)
            .bind(f.town)
            .execute(&pool)
            .await
            .unwrap();
        let hidden_home = call(f.mover).await.status();
        let _ = other;
        teardown(&pool, &f).await;

        assert_eq!(nothing_on, StatusCode::CONFLICT);
        assert_eq!(no_home, StatusCode::CONFLICT);
        assert_eq!(not_allowed, StatusCode::FORBIDDEN);
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["moved"], 1);
        assert_eq!(body["skipped"], 1);
        let moved_to = plain_frames.iter().find_map(|m| match m {
            M::VoiceMoved { channel_id, .. } => Some(*channel_id),
            _ => None,
        });
        assert_eq!(moved_to, Some(f.town as i64));
        assert!(!owner_frames.iter().any(|m| matches!(m, M::VoiceMoved { .. })), "ranked above the caller");
        assert!(!outsider_frames.iter().any(|m| matches!(m, M::VoiceMoved { .. })), "not in the mode's channels");
        assert!(cottage.contains(&f.owner) && cottage.contains(&f.mover), "{cottage:?}");
        assert_eq!(lobby, vec![f.switcher]);
        assert_eq!(hidden_home, StatusCode::CONFLICT);
    }

    /// The auto-off: starts counting at the first person, turns off after the
    /// window, not before, not for a mode nobody joined, not for one that opted
    /// out, and tells everyone with nobody named as having done it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn an_empty_mode_turns_itself_off() {
        let Some(pool) = crate::migrator::test_pool(8).await else { return };
        let _only_tick = AUTO_OFF_TESTS.lock().await;
        let f = setup(&pool).await;
        let state = state_of(&pool);
        let mode = make(&state, &f, "Clocktower", &[f.town]).await;
        assert_eq!(switch(&state, &f, f.owner, Some(mode)).await.0, StatusCode::OK);
        let active = |pool: sqlx::PgPool, sid: String| async move {
            sqlx::query_scalar::<_, Option<i32>>("SELECT active_mode_id FROM servers WHERE id = $1")
                .bind(sid)
                .fetch_one(&pool)
                .await
                .unwrap()
        };
        let age = |pool: sqlx::PgPool, sid: String, minutes: i32| async move {
            sqlx::query("UPDATE servers SET active_mode_occupied_at = NOW() - make_interval(mins => $1) WHERE id = $2")
                .bind(minutes)
                .bind(sid)
                .execute(&pool)
                .await
                .unwrap();
        };
        let seen = |pool: sqlx::PgPool, sid: String| async move {
            sqlx::query_scalar::<_, bool>("SELECT active_mode_occupied_at IS NOT NULL FROM servers WHERE id = $1")
                .bind(sid)
                .fetch_one(&pool)
                .await
                .unwrap()
        };

        // Nobody has joined: however long it has been on, it stays. A restart does not
        // count as someone having been there.
        auto_off_after_restart(&state).await;
        auto_off_tick(&state).await;
        let untouched_seen = seen(pool.clone(), f.sid.clone()).await;
        let stays_unjoined = active(pool.clone(), f.sid.clone()).await;

        // Someone joins (the tick sees them): the clock starts from nothing...
        let stamp_age = |pool: sqlx::PgPool, sid: String| async move {
            sqlx::query_scalar::<_, Option<f64>>("SELECT EXTRACT(EPOCH FROM NOW() - active_mode_occupied_at)::float8 FROM servers WHERE id = $1")
                .bind(sid)
                .fetch_one(&pool)
                .await
                .unwrap()
        };
        let call = Sock::in_room(&state, f.plain, f.town);
        auto_off_tick(&state).await;
        let started = stamp_age(pool.clone(), f.sid.clone()).await;
        // ...and a stale stamp is refreshed.
        age(pool.clone(), f.sid.clone(), 45).await;
        auto_off_tick(&state).await;
        let occupied_stays = active(pool.clone(), f.sid.clone()).await;
        let refreshed = stamp_age(pool.clone(), f.sid.clone()).await;
        state.leave_room(&format!("voice_{}", f.town), call.user, call.conn);

        // Empty, within the window.
        age(pool.clone(), f.sid.clone(), AUTO_OFF_EMPTY_MINUTES - 2).await;
        auto_off_tick(&state).await;
        let fresh_stays = active(pool.clone(), f.sid.clone()).await;

        // Long past it, but everyone gathered in the main channel, which is an
        // always-listed one in no mode: they are still playing.
        assert_eq!(patch(&state, &f, f.owner, mode, json!({ "home_channel_id": f.lobby })).await, StatusCode::OK);
        let gathered = Sock::in_room(&state, f.plain, f.lobby);
        age(pool.clone(), f.sid.clone(), AUTO_OFF_EMPTY_MINUTES + 2).await;
        auto_off_tick(&state).await;
        let gathered_stays = active(pool.clone(), f.sid.clone()).await;
        state.leave_room(&format!("voice_{}", f.lobby), gathered.user, gathered.conn);

        // Past it, and a restart: voice rooms are in memory, so every room reads empty
        // though nobody left. The window starts again.
        age(pool.clone(), f.sid.clone(), AUTO_OFF_EMPTY_MINUTES + 600).await;
        auto_off_after_restart(&state).await;
        auto_off_tick(&state).await;
        let restart_stays = active(pool.clone(), f.sid.clone()).await;

        // Opted out, long past it.
        age(pool.clone(), f.sid.clone(), AUTO_OFF_EMPTY_MINUTES + 2).await;
        assert_eq!(patch(&state, &f, f.owner, mode, json!({ "auto_off": false })).await, StatusCode::OK);
        auto_off_tick(&state).await;
        let opted_out_stays = active(pool.clone(), f.sid.clone()).await;

        // Opted back in, and the window then runs out: off, and everyone is told nobody did it.
        assert_eq!(patch(&state, &f, f.owner, mode, json!({ "auto_off": true })).await, StatusCode::OK);
        age(pool.clone(), f.sid.clone(), AUTO_OFF_EMPTY_MINUTES + 2).await;
        let mut watcher = Sock::open(&state, f.switcher);
        auto_off_tick(&state).await;
        let after = active(pool.clone(), f.sid.clone()).await;
        let cleared = seen(pool.clone(), f.sid.clone()).await;
        let frames = watcher.drain();
        let (audit_actor, audit_details): (Option<i32>, String) = sqlx::query_as(
            "SELECT actor_id, details FROM audit_log WHERE server_id = $1 AND action_type = 'mode_auto_off'",
        )
        .bind(&f.sid)
        .fetch_one(&pool)
        .await
        .unwrap();
        // Turning it back on starts the count from nothing again.
        assert_eq!(switch(&state, &f, f.owner, Some(mode)).await.0, StatusCode::OK);
        let reset = seen(pool.clone(), f.sid.clone()).await;
        teardown(&pool, &f).await;

        assert!(!untouched_seen);
        assert_eq!(stays_unjoined, Some(mode));
        assert!(started.is_some_and(|a| a < 30.0), "the first person starts the clock: {started:?}");
        assert_eq!(occupied_stays, Some(mode));
        assert!(refreshed.is_some_and(|a| a < 30.0), "someone there moves a stale stamp: {refreshed:?}");
        assert_eq!(fresh_stays, Some(mode));
        assert_eq!(gathered_stays, Some(mode), "people in the main channel count");
        assert_eq!(restart_stays, Some(mode), "a restart is not everyone leaving");
        assert_eq!(opted_out_stays, Some(mode));
        assert_eq!(after, None);
        assert!(!cleared);
        let told = frames.iter().find_map(|m| match m {
            M::ServerModeChanged { active_mode_id, previous_mode_id, by, .. } => Some((*active_mode_id, *previous_mode_id, *by)),
            _ => None,
        });
        assert_eq!(told, Some((None, Some(mode as i64), None)));
        assert_eq!(audit_actor, None);
        assert_eq!(audit_details, "Clocktower off");
        assert!(!reset);
    }

    /// A request dropped after its commit must still tell everyone and still end
    /// the calls: axum drops the handler when the client goes away.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_switch_survives_a_request_dropped_after_the_commit() {
        let Some(pool) = crate::migrator::test_pool(8).await else { return };
        let f = setup(&pool).await;
        let state = state_of(&pool);
        let mode = make(&state, &f, "Clocktower", &[f.town]).await;
        assert_eq!(switch(&state, &f, f.owner, Some(mode)).await.0, StatusCode::OK);
        let mut in_town = Sock::in_room(&state, f.plain, f.town);

        // The member list is slow (a held table lock); the client gives up after
        // 300 ms, which drops the handler after the commit.
        let mut locker = pool.begin().await.unwrap();
        sqlx::query("SET LOCAL lock_timeout = '5s'").execute(&mut *locker).await.unwrap();
        sqlx::query("LOCK TABLE server_members IN ACCESS EXCLUSIVE MODE").execute(&mut *locker).await.unwrap();
        let dropped = tokio::time::timeout(
            std::time::Duration::from_millis(300),
            set_active_mode(
                State(Arc::clone(&state)),
                Path(f.sid.clone()),
                Extension(claims(f.owner)),
                Json(SetActiveRequest { mode_id: None }),
            ),
        )
        .await
        .is_err();
        locker.rollback().await.unwrap();
        let mut seen = Vec::new();
        for _ in 0..50 {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            seen.extend(story(&in_town.drain()));
            if seen.len() >= 2 {
                break;
            }
        }
        let town = occupants(&state, f.town);
        teardown(&pool, &f).await;
        assert!(dropped, "the request was dropped while the push was waiting");
        assert_eq!(seen, vec!["mode:None".to_string(), format!("left:voice_{}", f.town)]);
        assert!(town.is_empty());
    }

    /// A hidden channel's unread is left out of the rail's bubble: nothing in the
    /// list could clear it. It comes back with the mode, and the channel's own row
    /// (GET /servers/:id/unread) still has it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn the_rail_does_not_count_what_a_mode_hides() {
        let Some(pool) = crate::migrator::test_pool(8).await else { return };
        let f = setup(&pool).await;
        let state = state_of(&pool);
        let mode = make(&state, &f, "Clocktower", &[f.text]).await;
        let plain_text = channel(&pool, &f.sid, "general", 0).await;
        for (i, ch) in [f.text, f.text, plain_text].iter().enumerate() {
            sqlx::query("INSERT INTO messages (id, channel_id, user_id, content) VALUES ($1, $2, $3, $4)")
                .bind(uuid::Uuid::new_v4().to_string())
                .bind(*ch)
                .bind(f.owner as i32)
                .bind(format!("m{i}"))
                .execute(&pool)
                .await
                .expect("message");
        }
        let total = |state: Arc<AppState>, user: i64, sid: String| async move {
            let resp = crate::server_handlers::get_all_unread_counts(State(state), Extension(claims(user))).await.into_response();
            let (_, body) = read(resp).await;
            body["servers"].as_array().unwrap().iter().find(|s| s["server_id"] == sid.as_str()).map(|s| s["unread_count"].clone())
        };
        let off = total(Arc::clone(&state), f.plain, f.sid.clone()).await;
        assert_eq!(switch(&state, &f, f.owner, Some(mode)).await.0, StatusCode::OK);
        let on = total(Arc::clone(&state), f.plain, f.sid.clone()).await;
        let (_, channel_rows) = read(
            crate::server_handlers::get_unread_counts(State(Arc::clone(&state)), Path(f.sid.clone()), Extension(claims(f.plain)))
                .await
                .into_response(),
        )
        .await;
        let row = channel_rows["channels"].as_array().unwrap().iter().find(|c| c["channel_id"] == f.text).cloned();
        let _ = sqlx::query("DELETE FROM messages WHERE channel_id = ANY($1)").bind(vec![f.text, plain_text]).execute(&pool).await;
        teardown(&pool, &f).await;
        assert_eq!(off, Some(json!(1)), "off: only the channel in no mode");
        assert_eq!(on, Some(json!(3)), "on: the mode's channel counts again");
        assert_eq!(row.unwrap()["unread_count"], 2);
    }

    /// A subchannel goes with its collection: hidden with it, out of the rail with it.
    /// And the row stays when the total does not count it, because the reconnect
    /// catch-up diffs rows and would otherwise ping for old messages when a mode comes
    /// on during a gap.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_collection_takes_its_subchannels_and_the_rows_stay() {
        let Some(pool) = crate::migrator::test_pool(8).await else { return };
        let f = setup(&pool).await;
        let state = state_of(&pool);
        let collection = channel(&pool, &f.sid, "rooms", 2).await;
        let (sub,): (i32,) =
            sqlx::query_as("INSERT INTO channels (server_id, name, type, parent_id) VALUES ($1, 'room-a', 0, $2) RETURNING id")
                .bind(&f.sid)
                .bind(collection)
                .fetch_one(&pool)
                .await
                .expect("subchannel");
        let mode = make(&state, &f, "Clocktower", &[collection]).await;
        sqlx::query("INSERT INTO messages (id, channel_id, user_id, content) VALUES ($1, $2, $3, $4)")
            .bind(uuid::Uuid::new_v4().to_string())
            .bind(sub)
            .bind(f.owner as i32)
            .bind("m")
            .execute(&pool)
            .await
            .expect("message");
        let rail = |state: Arc<AppState>, user: i64, sid: String| async move {
            let resp = crate::server_handlers::get_all_unread_counts(State(state), Extension(claims(user))).await.into_response();
            let (_, body) = read(resp).await;
            body["servers"].as_array().unwrap().iter().find(|s| s["server_id"] == sid.as_str()).cloned()
        };
        let hidden_set = channels_hidden_from(&pool, f.plain).await.unwrap();
        let off = rail(Arc::clone(&state), f.plain, f.sid.clone()).await.expect("the server's row stays");
        assert_eq!(switch(&state, &f, f.owner, Some(mode)).await.0, StatusCode::OK);
        let hidden_set_on = channels_hidden_from(&pool, f.plain).await.unwrap();
        let on = rail(Arc::clone(&state), f.plain, f.sid.clone()).await.expect("the server's row");
        let _ = sqlx::query("DELETE FROM messages WHERE channel_id = $1").bind(sub).execute(&pool).await;
        teardown(&pool, &f).await;

        assert!(hidden_set.contains(&(sub as i64)), "the subchannel, in no mode itself, goes with its collection");
        assert!(hidden_set.contains(&(collection as i64)));
        assert!(!hidden_set.contains(&(f.lobby as i64)), "control: a channel in no mode under no collection");
        assert_eq!(off["unread_count"], 0, "out of the bubble");
        assert_eq!(off["channels"][0]["channel_id"], sub, "but the row is still there for the catch-up");
        assert_eq!(off["channels"][0]["unread_count"], 1);
        assert!(!hidden_set_on.contains(&(sub as i64)));
        assert_eq!(on["unread_count"], 1);
    }

    /// What a member's refetch of the channel list says the channel's parent is.
    async fn parent_in_list(state: &Arc<AppState>, f: &Fx, by: i64, channel: i32) -> Value {
        let resp = crate::channel_handlers::list_channels(State(Arc::clone(state)), Path(f.sid.clone()), Extension(claims(by)))
            .await
            .into_response();
        let (status, body) = read(resp).await;
        assert_eq!(status, StatusCode::OK);
        let row = body.as_array().expect("a list").iter().find(|c| c["id"] == channel).expect("listed").clone();
        row["parent_id"].clone()
    }

    /// Edit Channel's "No parent (top level)" sends null, and the server used to read
    /// that as "nothing said", so the parent stayed. ChannelUpdated names only the server:
    /// every member refetches the list, so the list is what has to say it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_null_parent_clears_a_left_out_one_leaves_it_and_a_value_sets_it() {
        let Some(pool) = crate::migrator::test_pool(8).await else { return };
        let f = setup(&pool).await;
        let elsewhere = setup(&pool).await;
        let state = state_of(&pool);
        let rooms = channel(&pool, &f.sid, "rooms", 2).await;
        let shelf = channel(&pool, &f.sid, "shelf", 2).await;
        let room = subchannel(&pool, &f.sid, "room-a", 1, rooms).await;
        let notes = subchannel(&pool, &f.sid, "notes", 0, rooms).await;
        make(&state, &f, "Clocktower", &[rooms]).await;
        let mut member = Sock::open(&state, f.plain);
        let edit = |by: i64, channel: i32, body: Value| {
            crate::channel_handlers::update_channel(
                State(Arc::clone(&state)),
                Path(channel as i64),
                Extension(claims(by)),
                Json(serde_json::from_value(body).unwrap()),
            )
        };

        let renamed = edit(f.owner, room, json!({ "name": "room-b" })).await.into_response().status();
        let after_rename = parent_in_list(&state, &f, f.plain, room).await;
        let refused = edit(f.plain, room, json!({ "parent_id": null })).await.into_response().status();
        let after_refusal = parent_in_list(&state, &f, f.plain, room).await;
        let hidden_under = channels_hidden_from(&pool, f.plain).await.unwrap();

        member.drain();
        let cleared_room = edit(f.owner, room, json!({ "parent_id": null })).await.into_response().status();
        let told = member.drain();
        let after_clear = parent_in_list(&state, &f, f.plain, room).await;
        let hidden_clear = channels_hidden_from(&pool, f.plain).await.unwrap();
        let cleared_notes = edit(f.manager, notes, json!({ "parent_id": null })).await.into_response().status();
        let notes_after = parent_in_list(&state, &f, f.plain, notes).await;

        let again = edit(f.owner, room, json!({ "parent_id": null })).await.into_response().status();
        let after_again = parent_in_list(&state, &f, f.plain, room).await;
        let set = edit(f.owner, room, json!({ "parent_id": shelf })).await.into_response().status();
        let after_set = parent_in_list(&state, &f, f.plain, room).await;
        let foreign = edit(f.owner, room, json!({ "parent_id": elsewhere.town })).await.into_response().status();
        let after_foreign = parent_in_list(&state, &f, f.plain, room).await;
        let stored: (Option<i32>,) =
            sqlx::query_as("SELECT parent_id FROM channels WHERE id = $1").bind(notes).fetch_one(&pool).await.unwrap();
        teardown(&pool, &f).await;
        teardown(&pool, &elsewhere).await;

        assert_eq!(renamed, StatusCode::OK);
        assert_eq!(after_rename, json!(rooms), "control: an edit that leaves the field out leaves the parent");
        assert_eq!(refused, StatusCode::FORBIDDEN);
        assert_eq!(after_refusal, json!(rooms), "and clearing it still takes Manage Channels");
        assert!(hidden_under.contains(&(room as i64)), "control: under a ticked collection, the mode that is off hides it");

        assert_eq!(cleared_room, StatusCode::OK);
        assert_eq!(after_clear, Value::Null, "null takes a voice room out of its collection");
        assert!(
            told.iter().any(|m| matches!(m, M::ChannelUpdated { server_id } if *server_id == f.sid)),
            "and another member is told to refetch"
        );
        assert!(!hidden_clear.contains(&(room as i64)), "so the mode no longer takes it along");
        assert!(hidden_clear.contains(&(rooms as i64)), "control: the collection is still in the mode");

        assert_eq!(cleared_notes, StatusCode::OK);
        assert_eq!(notes_after, Value::Null, "a text channel too");
        assert_eq!(stored.0, None, "in the row itself");

        assert_eq!(again, StatusCode::OK);
        assert_eq!(after_again, Value::Null, "already at the top level: still fine");
        assert_eq!(set, StatusCode::OK);
        assert_eq!(after_set, json!(shelf), "a value still sets it");
        assert_eq!(foreign, StatusCode::BAD_REQUEST);
        assert_eq!(after_foreign, json!(shelf), "and another server's channel is still refused");
    }

    /// Deleting a mode can finish no matter what the request does: its picture is
    /// reclaimed and everyone is told, even when the client gave up after the commit.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_delete_survives_a_request_dropped_after_the_commit() {
        let Some(pool) = crate::migrator::test_pool(8).await else { return };
        let f = setup(&pool).await;
        let state = state_of(&pool);
        let mode = make(&state, &f, "Clocktower", &[f.town]).await;
        let mut watcher = Sock::open(&state, f.plain);
        let mut locker = pool.begin().await.unwrap();
        sqlx::query("SET LOCAL lock_timeout = '5s'").execute(&mut *locker).await.unwrap();
        sqlx::query("LOCK TABLE server_members IN ACCESS EXCLUSIVE MODE").execute(&mut *locker).await.unwrap();
        // get_user_server_permissions reads server_members, so the permission check must
        // be past before the lock: the owner resolves from the servers row alone.
        let dropped = tokio::time::timeout(
            std::time::Duration::from_millis(300),
            delete_mode(State(Arc::clone(&state)), Path((f.sid.clone(), mode)), Extension(claims(f.owner))),
        )
        .await
        .is_err();
        locker.rollback().await.unwrap();
        let mut told = false;
        for _ in 0..50 {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            if watcher.drain().iter().any(|m| matches!(m, M::ServerModesEdited { .. })) {
                told = true;
                break;
            }
        }
        teardown(&pool, &f).await;
        assert!(dropped, "the request was dropped while the push was waiting");
        assert!(told, "everyone was still told");
    }

    /// A channel made AFK leaves its modes: an idle member is moved into it, so it
    /// can't be hidden. The mode editor refuses it, and this is the other door.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_channel_made_afk_leaves_its_modes() {
        let Some(pool) = crate::migrator::test_pool(8).await else { return };
        let f = setup(&pool).await;
        let state = state_of(&pool);
        let mode = make(&state, &f, "Clocktower", &[f.town, f.cottage]).await;
        assert_eq!(patch(&state, &f, f.owner, mode, json!({ "home_channel_id": f.town })).await, StatusCode::OK);
        // A main channel in no mode: nothing leaves a mode's list, and it still goes.
        let other = make(&state, &f, "Other", &[]).await;
        assert_eq!(patch(&state, &f, f.owner, other, json!({ "home_channel_id": f.lobby })).await, StatusCode::OK);
        let mut watcher = Sock::open(&state, f.plain);
        let edit = |channel: i32, body: Value| {
            crate::channel_handlers::update_channel(
                State(Arc::clone(&state)),
                Path(channel as i64),
                Extension(claims(f.owner)),
                Json(serde_json::from_value(body).unwrap()),
            )
        };
        let renamed = edit(f.cottage, json!({ "name": "renamed" })).await.into_response().status();
        let (_, kept) = modes(&state, &f, f.owner).await;
        watcher.drain();
        let made_afk = edit(f.town, json!({ "is_afk": true })).await.into_response().status();
        let frames = watcher.drain();
        let (_, left) = modes(&state, &f, f.owner).await;
        let lobby_afk = edit(f.lobby, json!({ "is_afk": true })).await.into_response().status();
        let lobby_frames = watcher.drain();
        let (_, lobby_left) = modes(&state, &f, f.owner).await;
        teardown(&pool, &f).await;
        assert_eq!(renamed, StatusCode::OK);
        assert_eq!(kept["modes"][0]["channel_ids"], json!([f.town, f.cottage]), "control: another edit leaves it");
        assert_eq!(kept["modes"][0]["home_channel_id"], f.town, "control");
        assert_eq!(made_afk, StatusCode::OK);
        assert_eq!(left["modes"][0]["channel_ids"], json!([f.cottage]));
        assert_eq!(left["modes"][0]["home_channel_id"], Value::Null, "and stops being the main channel");
        assert!(frames.iter().any(|m| matches!(m, M::ServerModesEdited { .. })), "and everyone hears");
        assert_eq!(lobby_afk, StatusCode::OK);
        assert_eq!(lobby_left["modes"][1]["home_channel_id"], Value::Null, "a main channel in no mode goes too");
        assert!(lobby_frames.iter().any(|m| matches!(m, M::ServerModesEdited { .. })), "and that is announced as well");
    }

    /// A voice channel under a ticked collection IS in the mode, everywhere: this is how
    /// a game's private rooms are usually laid out. The channel's own row names no mode,
    /// so each of these used to miss it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_voice_channel_under_a_ticked_collection_is_in_the_mode() {
        let Some(pool) = crate::migrator::test_pool(8).await else { return };
        let _only_tick = AUTO_OFF_TESTS.lock().await;
        let f = setup(&pool).await;
        let state = state_of(&pool);
        let rooms = channel(&pool, &f.sid, "rooms", 2).await;
        let room_a = subchannel(&pool, &f.sid, "room-a", 1, rooms).await;
        let room_b = subchannel(&pool, &f.sid, "room-b", 1, rooms).await;
        let mode = make(&state, &f, "Clocktower", &[rooms, f.town]).await;
        assert_eq!(patch(&state, &f, f.owner, mode, json!({ "home_channel_id": f.town })).await, StatusCode::OK);
        let also = make(&state, &f, "Shares the collection", &[rooms]).await;
        let without = make(&state, &f, "Without it", &[f.lobby]).await;

        // Auto-off: the stamp moves for people in a room under the collection.
        assert_eq!(switch(&state, &f, f.owner, Some(mode)).await.0, StatusCode::OK);
        let in_room_a = Sock::in_room(&state, f.plain, room_a);
        sqlx::query("UPDATE servers SET active_mode_occupied_at = NOW() - make_interval(mins => $1) WHERE id = $2")
            .bind(AUTO_OFF_EMPTY_MINUTES + 5)
            .bind(&f.sid)
            .execute(&pool)
            .await
            .unwrap();
        auto_off_tick(&state).await;
        let (stays_on,): (Option<i32>,) =
            sqlx::query_as("SELECT active_mode_id FROM servers WHERE id = $1").bind(&f.sid).fetch_one(&pool).await.unwrap();

        // Call everyone back reaches them.
        let (_, back) = read(
            call_everyone_back(State(Arc::clone(&state)), Path(f.sid.clone()), Extension(claims(f.owner))).await,
        )
        .await;
        drop(in_room_a);

        // A main channel under the collection is somewhere people can follow...
        let (under, under_in_b) = (subchannel(&pool, &f.sid, "under", 1, rooms).await, Sock::in_room(&state, f.plain, room_b));
        assert_eq!(patch(&state, &f, f.owner, mode, json!({ "home_channel_id": under })).await, StatusCode::OK);
        let (_, back_to_sub) = read(
            call_everyone_back(State(Arc::clone(&state)), Path(f.sid.clone()), Extension(claims(f.owner))).await,
        )
        .await;
        drop(under_in_b);

        // ...and one under a collection this mode does not list is not.
        let elsewhere = channel(&pool, &f.sid, "elsewhere", 2).await;
        let beyond = subchannel(&pool, &f.sid, "beyond", 1, elsewhere).await;
        make(&state, &f, "Beyond", &[elsewhere]).await;
        assert_eq!(patch(&state, &f, f.owner, mode, json!({ "home_channel_id": beyond })).await, StatusCode::OK);
        let hidden_home = call_everyone_back(State(Arc::clone(&state)), Path(f.sid.clone()), Extension(claims(f.owner))).await.status();

        // The next mode shares the collection: the call carries on.
        let mut sharing = Sock::in_room(&state, f.mover, room_a);
        let (_, kept) = switch(&state, &f, f.owner, Some(also)).await;
        let room_a_kept = occupants(&state, room_a);
        let sharing_story = story(&sharing.drain());

        // It does not: the call ends, with the reason first.
        let (_, ended) = switch(&state, &f, f.owner, Some(without)).await;
        let room_a_ended = occupants(&state, room_a);
        let ended_story = story(&sharing.drain());
        teardown(&pool, &f).await;

        assert_eq!(stays_on, Some(mode), "someone in a room under the collection keeps the mode on");
        assert_eq!(back["moved"], 1, "Call everyone back pulled them out of it");
        assert_eq!(back_to_sub["moved"], 1, "a main channel under the collection works");
        assert_eq!(hidden_home, StatusCode::CONFLICT, "one under a collection this mode does not list does not");
        assert_eq!(kept["disconnected"], 0);
        assert_eq!(room_a_kept, vec![f.mover], "a collection both modes tick keeps its calls");
        assert_eq!(sharing_story, vec![format!("mode:Some({also})")]);
        assert_eq!(ended["disconnected"], 1, "counted in the answer");
        assert!(room_a_ended.is_empty(), "turning it off ends the calls under the collection");
        assert_eq!(ended_story, vec![format!("mode:Some({without})"), format!("left:voice_{room_a}")]);
    }

    /// "Listed under the next mode" is the channel list's own rule, not "ticked or under
    /// a ticked collection": ticked in the next mode under a collection it does not tick
    /// is not listed, and neither is a channel in another mode under a collection it does.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_switch_hides_what_the_list_would_hide() {
        let Some(pool) = crate::migrator::test_pool(8).await else { return };
        let f = setup(&pool).await;
        let state = state_of(&pool);
        let rooms = channel(&pool, &f.sid, "rooms", 2).await;
        let ticked_alone = subchannel(&pool, &f.sid, "ticked-alone", 1, rooms).await;
        let on_a = make(&state, &f, "Collection on", &[rooms]).await;
        let on_b = make(&state, &f, "Its room alone", &[ticked_alone]).await;
        // The AFK channel can't be hidden, even by its collection.
        let afk = subchannel(&pool, &f.sid, "afk", 1, rooms).await;
        sqlx::query("UPDATE channels SET is_afk = true WHERE id = $1").bind(afk).execute(&pool).await.unwrap();

        assert_eq!(switch(&state, &f, f.owner, Some(on_a)).await.0, StatusCode::OK);
        let mut in_room = Sock::in_room(&state, f.plain, ticked_alone);
        let parked = Sock::in_room(&state, f.manager, afk);
        in_room.drain();
        let (_, first) = switch(&state, &f, f.owner, Some(on_b)).await;
        let after_first = occupants(&state, ticked_alone);
        let hidden_from = channels_hidden_from(&pool, f.plain).await.unwrap();
        let (_, off) = switch(&state, &f, f.owner, None).await;
        let afk_after = occupants(&state, afk);
        let hidden_off = channels_hidden_from(&pool, f.plain).await.unwrap();
        drop(parked);
        teardown(&pool, &f).await;

        assert_eq!(first["disconnected"], 1, "its collection is not listed under the next mode, so it is not either");
        assert!(after_first.is_empty());
        assert!(hidden_from.contains(&(ticked_alone as i64)), "and the rail agrees");
        assert_eq!(off["disconnected"], 0);
        assert_eq!(afk_after, vec![f.manager], "nobody is put out of the AFK channel by a mode");
        assert!(!hidden_off.contains(&(afk as i64)), "and it never leaves the rail");
        assert!(hidden_off.contains(&(rooms as i64)), "control: its collection does");
    }

    /// Turning a mode off cuts a LiveKit session whose socket is not in voice_<id> (it
    /// died, or the backend just restarted): the room has no entry for it. It counts, in
    /// the answer and the audit. And a session in the room is cut exactly as before.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn turning_off_cuts_a_livekit_session_with_no_room_entry() {
        use crate::sfu::resync_tests::{asked, livekit_stand_in, no_env_proxy};
        let Some(pool) = crate::migrator::test_pool(8).await else { return };
        no_env_proxy();
        let f = setup(&pool).await;
        let state = state_of(&pool);
        let mode = make(&state, &f, "Clocktower", &[f.town, f.lobby]).await;
        assert_eq!(switch(&state, &f, f.owner, Some(mode)).await.0, StatusCode::OK);
        let room = crate::sfu::room_name_for_channel(f.town as i64);
        let (socketless, in_room) = (format!("u{}#gone", f.mover), format!("u{}#here", f.plain));
        {
            let mut usage = state.sfu_rooms.entry(room.clone()).or_default();
            usage.participants.insert(socketless.clone(), std::time::Instant::now());
            usage.participants.insert(in_room.clone(), std::time::Instant::now());
        }
        let mut sock = Sock::in_room(&state, f.plain, f.town);
        sock.drain();
        let (base, srv) = livekit_stand_in(
            vec![
                ("/twirp/livekit.RoomService/RemoveParticipant", 200, "{}".to_string()),
                ("/twirp/livekit.RoomService/RemoveParticipant", 200, "{}".to_string()),
            ],
            None,
        )
        .await;
        let (status, body) = crate::sfu::TEST_LIVEKIT.scope(base, switch(&state, &f, f.owner, None)).await;
        let seen = asked(srv).await;
        let (audit,): (String,) = sqlx::query_as(
            "SELECT details FROM audit_log WHERE server_id = $1 AND action_type = 'mode_switch' ORDER BY id DESC LIMIT 1",
        )
        .bind(&f.sid)
        .fetch_one(&pool)
        .await
        .unwrap();
        teardown(&pool, &f).await;

        assert_eq!(status, StatusCode::OK);
        let removed: Vec<String> = seen.iter().map(|s| s.body.clone()).collect();
        assert!(removed.iter().any(|b| b.contains(&socketless)), "the session with no room entry: {removed:?}");
        assert!(removed.iter().any(|b| b.contains(&in_room)), "control: the one in the room: {removed:?}");
        assert_eq!(body["disconnected"], 2, "both counted");
        assert_eq!(audit, "Clocktower off, 2 disconnected");
    }

    /// Someone being there, for the auto-off: a person in the room or a LiveKit session
    /// with no room entry is; a stream-only account (it can sit there unattended) is not,
    /// though the disconnect still reaches it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn the_auto_off_counts_people_not_stream_only_accounts() {
        let Some(pool) = crate::migrator::test_pool(8).await else { return };
        let f = setup(&pool).await;
        let state = state_of(&pool);
        let mode = make(&state, &f, "Clocktower", &[f.town]).await;
        assert_eq!(switch(&state, &f, f.owner, Some(mode)).await.0, StatusCode::OK);
        stream_only_in(&pool, &f.sid, f.manager as i32, f.town).await;

        let nobody = someone_there(&state, f.town).await;
        // A stream-only account in the room.
        let mut bot = Sock::in_room(&state, f.manager, f.town);
        let room_name = format!("voice_{}", f.town);
        state.rooms.get_mut(&room_name).unwrap().set_voice_rights(
            f.manager,
            crate::state::VoiceRights { can_speak: false, receives: false, reads_text: false },
        );
        let bot_alone = someone_there(&state, f.town).await;
        // The same account's LiveKit session must not count just because its socket is the
        // one the room knows: in the room, it has been judged already.
        let sfu = crate::sfu::room_name_for_channel(f.town as i64);
        state.sfu_rooms.entry(sfu.clone()).or_default().participants.insert(format!("u{}#bot", f.manager), std::time::Instant::now());
        let bot_with_session = someone_there(&state, f.town).await;
        // A person's LiveKit session with no room entry.
        state.sfu_rooms.entry(sfu.clone()).or_default().participants.insert(format!("u{}#gone", f.plain), std::time::Instant::now());
        let person_session = someone_there(&state, f.town).await;
        state.sfu_rooms.remove(&sfu);
        // A stream-only account's LiveKit session with no room entry.
        state.leave_room(&room_name, bot.user, bot.conn);
        state.sfu_rooms.entry(sfu.clone()).or_default().participants.insert(format!("u{}#bot", f.manager), std::time::Instant::now());
        let bot_session_only = someone_there(&state, f.town).await;
        state.sfu_rooms.remove(&sfu);
        // A person in the room.
        let _person = Sock::in_room(&state, f.plain, f.town);
        let person = someone_there(&state, f.town).await;
        // ...and the disconnect still takes the stream-only account.
        state.join_room(&room_name, bot.user, bot.conn);
        state.rooms.get_mut(&room_name).unwrap().set_voice_rights(
            f.manager,
            crate::state::VoiceRights { can_speak: false, receives: false, reads_text: false },
        );
        bot.drain();
        let (_, off) = switch(&state, &f, f.owner, None).await;
        let bot_told = story(&bot.drain());
        teardown(&pool, &f).await;

        assert!(!nobody, "control: an empty room");
        assert!(!bot_alone, "a stream-only account in the room is nobody being there");
        assert!(!bot_with_session, "nor is its LiveKit session");
        assert!(person_session, "a person's LiveKit session with no room entry is");
        assert!(!bot_session_only, "a stream-only account's session with no room entry is not");
        assert!(person, "control: a person in the room");
        assert_eq!(off["disconnected"], 2);
        assert_eq!(bot_told, vec!["mode:None".to_string(), format!("left:voice_{}", f.town)]);
    }

    /// A socket that slept through the switch must not replay itself back into the ended
    /// call: the session that held the call is tombstoned with the reason, and one whose
    /// socket had just died (out of the room already) is too. A deliberate join is not
    /// refused: a mode tidies the list, it does not lock anything.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_replay_of_a_call_a_mode_ended_is_refused_with_the_reason() {
        let Some(pool) = crate::migrator::test_pool(8).await else { return };
        let f = setup(&pool).await;
        let state = state_of(&pool);
        let mode = make(&state, &f, "Clocktower", &[f.town]).await;
        assert_eq!(switch(&state, &f, f.owner, Some(mode)).await.0, StatusCode::OK);
        let room = format!("voice_{}", f.town);
        let send = |state: Arc<AppState>, user: i64, conn: u64, frame: Value| async move {
            crate::ws::handle_message(&state, user, conn, "t", &frame.to_string(), &mut std::collections::HashSet::new(), "").await
        };
        let replay = |room: String| json!({ "type": "JoinRoom", "payload": { "room_id": room, "replay": true } });
        let join = |room: String| json!({ "type": "JoinRoom", "payload": { "room_id": room } });

        // In the room, and a second device of the same account not in the call.
        let mut held = Sock::open(&state, f.plain);
        send(Arc::clone(&state), f.plain, held.conn, join(room.clone())).await.expect("join");
        let mut other_device = Sock::open(&state, f.plain);
        // A socket that died in the room: its sid is what its replay comes back under.
        let dropped = Sock::open(&state, f.mover);
        send(Arc::clone(&state), f.mover, dropped.conn, join(room.clone())).await.expect("join");
        state.unregister_session(f.mover, dropped.conn);
        let dropped_again = Sock::open(&state, f.mover);
        // Control: a call in a channel no mode names.
        let control = Sock::open(&state, f.switcher);
        let lobby = format!("voice_{}", f.lobby);
        send(Arc::clone(&state), f.switcher, control.conn, join(lobby.clone())).await.expect("join");
        held.drain();
        other_device.drain();

        assert_eq!(switch(&state, &f, f.owner, None).await.0, StatusCode::OK);
        let reason_of = |frames: Vec<ServerMessage>, room: &str| {
            frames.into_iter().find_map(|m| match m {
                M::RoomLeft { room_id, reason, .. } if room_id == room => Some(reason),
                _ => None,
            })
        };
        let held_reason = reason_of(held.drain(), &room);
        let other_reason = reason_of(other_device.drain(), &room);

        // The replays.
        send(Arc::clone(&state), f.plain, held.conn, replay(room.clone())).await.expect("replay");
        let held_after = occupants(&state, f.town);
        let held_replay = reason_of(held.drain(), &room);
        let mut again = dropped_again;
        send(Arc::clone(&state), f.mover, again.conn, replay(room.clone())).await.expect("replay");
        let dropped_after = occupants(&state, f.town);
        let dropped_replay = reason_of(again.drain(), &room);
        // A replay in a channel no mode ended goes through.
        state.leave_room(&lobby, f.switcher, control.conn);
        send(Arc::clone(&state), f.switcher, control.conn, replay(lobby.clone())).await.expect("replay");
        let control_after = occupants(&state, f.lobby);
        // Choosing to join is not refused.
        send(Arc::clone(&state), f.plain, held.conn, join(room.clone())).await.expect("a deliberate join");
        let deliberate = occupants(&state, f.town);
        teardown(&pool, &f).await;

        assert_eq!(held_reason, Some(Some(crate::ws::MODE_ENDED.to_string())), "the device in the call is told why");
        assert_eq!(other_reason, Some(None), "another device of the account is told plainly: it says nothing");
        assert!(held_after.is_empty(), "{held_after:?}");
        assert_eq!(held_replay, Some(Some(crate::ws::MODE_ENDED.to_string())), "and its replay is refused with the reason");
        assert!(dropped_after.is_empty(), "a socket that died in the room stays out too: {dropped_after:?}");
        assert_eq!(dropped_replay, Some(Some(crate::ws::MODE_ENDED.to_string())));
        assert_eq!(control_after, vec![f.switcher], "control");
        assert_eq!(deliberate, vec![f.plain], "nothing refuses a later join");
    }

    /// Two switches settle in tasks nothing orders and a client keeps the last frame it
    /// got, so every frame says what is in the row, not what its own switch asked for.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn the_frame_announces_the_stored_mode() {
        let Some(pool) = crate::migrator::test_pool(8).await else { return };
        let f = setup(&pool).await;
        let state = state_of(&pool);
        let (a, b) = (make(&state, &f, "A", &[]).await, make(&state, &f, "B", &[]).await);
        // The row has moved on to B by the time the first switch settles.
        sqlx::query("UPDATE servers SET active_mode_id = $1 WHERE id = $2").bind(b).bind(&f.sid).execute(&pool).await.unwrap();
        let mut watcher = Sock::open(&state, f.plain);
        settle(
            &state,
            Switch { server_id: f.sid.clone(), previous: None, next: Some(a), by: Some(f.owner), hidden: Vec::new(), details: String::new() },
        )
        .await;
        let frame = watcher.drain().into_iter().find_map(|m| match m {
            M::ServerModeChanged { active_mode_id, previous_mode_id, .. } => Some((active_mode_id, previous_mode_id)),
            _ => None,
        });
        teardown(&pool, &f).await;
        assert_eq!(frame, Some((Some(b as i64), None)));
    }

    /// Two switches at once: the row lock makes each read the other's result as its
    /// `previous`, so neither one's hidden channels are missed. Several rounds: without
    /// the lock this is a race that either read can win.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn two_switches_at_once_miss_nothing() {
        let Some(pool) = crate::migrator::test_pool(12).await else { return };
        let f = setup(&pool).await;
        let state = state_of(&pool);
        let (ra, rb, rc) = (
            channel(&pool, &f.sid, "room-a", 1).await,
            channel(&pool, &f.sid, "room-b", 1).await,
            channel(&pool, &f.sid, "room-c", 1).await,
        );
        let (a, b, c) = (
            make(&state, &f, "A", &[ra]).await,
            make(&state, &f, "B", &[rb]).await,
            make(&state, &f, "C", &[rc]).await,
        );
        let mut wrong = Vec::new();
        for round in 0..6 {
            assert_eq!(switch(&state, &f, f.owner, Some(a)).await.0, StatusCode::OK);
            let _in_a = Sock::in_room(&state, f.plain, ra);
            let _in_b = Sock::in_room(&state, f.mover, rb);
            let _in_c = Sock::in_room(&state, f.manager, rc);
            let (first, second) = tokio::join!(switch(&state, &f, f.owner, Some(b)), switch(&state, &f, f.switcher, Some(c)));
            assert_eq!((first.0, second.0), (StatusCode::OK, StatusCode::OK));
            let (stored,): (Option<i32>,) =
                sqlx::query_as("SELECT active_mode_id FROM servers WHERE id = $1").bind(&f.sid).fetch_one(&pool).await.unwrap();
            let (kept, lost) = if stored == Some(b) { (rb, rc) } else { (rc, rb) };
            if !occupants(&state, ra).is_empty() || occupants(&state, kept).len() != 1 || !occupants(&state, lost).is_empty() {
                wrong.push(round);
            }
            for room in [ra, rb, rc] {
                for member in occupants(&state, room) {
                    let conns: Vec<u64> = state.rooms.get(&format!("voice_{room}")).and_then(|r| r.conns_of(member).cloned()).map(|c| c.into_iter().collect()).unwrap_or_default();
                    for conn in conns {
                        state.leave_room(&format!("voice_{room}"), member, conn);
                    }
                }
            }
        }
        teardown(&pool, &f).await;
        assert!(wrong.is_empty(), "rounds that missed a hidden channel: {wrong:?}");
    }

    /// A selector, not a catalogue.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_server_holds_at_most_32_modes() {
        let Some(pool) = crate::migrator::test_pool(8).await else { return };
        let f = setup(&pool).await;
        let state = state_of(&pool);
        for i in 0..MAX_MODES_PER_SERVER {
            make(&state, &f, &format!("M{i}"), &[]).await;
        }
        let (status, _) = create(&state, &f, f.owner, json!({ "name": "One too many" })).await;
        teardown(&pool, &f).await;
        assert_eq!(status, StatusCode::CONFLICT);
    }

    /// Deleting a mode reclaims its picture, unless another mode still shows it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn deleting_a_mode_reclaims_its_picture() {
        let Some(pool) = crate::migrator::test_pool(8).await else { return };
        let f = setup(&pool).await;
        let state = state_of(&pool);
        let (one, two) = (make(&state, &f, "One", &[]).await, make(&state, &f, "Two", &[]).await);
        let shared = upload(&pool, f.owner, "image/jpeg", 1000).await;
        for m in [one, two] {
            assert_eq!(patch(&state, &f, f.owner, m, json!({ "background_file_id": shared.clone() })).await, StatusCode::OK);
        }
        let delete = |mode: i32| delete_mode(State(Arc::clone(&state)), Path((f.sid.clone(), mode)), Extension(claims(f.owner)));
        assert_eq!(delete(one).await.status(), StatusCode::OK);
        let kept_while_shared = file_exists(&pool, &shared).await;
        assert_eq!(delete(two).await.status(), StatusCode::OK);
        let reclaimed = !file_exists(&pool, &shared).await;
        let _ = sqlx::query("DELETE FROM uploaded_files WHERE uploader_id = ANY($1)").bind(f.users.clone()).execute(&pool).await;
        teardown(&pool, &f).await;
        assert!(kept_while_shared, "another mode still shows it");
        assert!(reclaimed, "the last one went");
    }

    /// Every spelling of a uuid the cast accepts is stored as the one the guards compare:
    /// a mode's background and a server icon both, and DELETE /files reads through it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_file_is_stored_under_its_one_spelling() {
        let Some(pool) = crate::migrator::test_pool(8).await else { return };
        let f = setup(&pool).await;
        let state = state_of(&pool);
        let mode = make(&state, &f, "Clocktower", &[]).await;
        let file = upload(&pool, f.owner, "image/jpeg", 1000).await;
        let shouted = file.to_uppercase();

        assert_eq!(patch(&state, &f, f.owner, mode, json!({ "background_file_id": shouted.clone() })).await, StatusCode::OK);
        let (_, read_back) = modes(&state, &f, f.owner).await;
        let guarded = crate::upload_handlers::file_is_referenced(&pool, &file).await.unwrap();
        // Saving the canonical spelling is not a replacement: the picture stays.
        assert_eq!(patch(&state, &f, f.owner, mode, json!({ "background_file_id": file.clone() })).await, StatusCode::OK);
        let still_there = file_exists(&pool, &file).await;
        let delete_shouted = crate::upload_handlers::delete_file(
            State(Arc::clone(&state)),
            Path(shouted.clone()),
            Extension(claims(f.owner)),
        )
        .await
        .into_response()
        .status();

        let icon = upload(&pool, f.owner, "image/png", 1000).await;
        let set_icon = crate::server_handlers::update_server_settings(
            State(Arc::clone(&state)),
            Path(f.sid.clone()),
            Extension(claims(f.owner)),
            Json(serde_json::from_value(json!({ "icon_file_id": icon.to_uppercase() })).unwrap()),
        )
        .await
        .into_response()
        .status();
        let stored_icon: Option<String> = sqlx::query_scalar("SELECT icon_file_id FROM servers WHERE id = $1")
            .bind(&f.sid)
            .fetch_one(&pool)
            .await
            .unwrap();
        let _ = sqlx::query("UPDATE servers SET icon_file_id = NULL WHERE id = $1").bind(&f.sid).execute(&pool).await;
        let _ = sqlx::query("DELETE FROM uploaded_files WHERE uploader_id = ANY($1)").bind(f.users.clone()).execute(&pool).await;
        teardown(&pool, &f).await;

        assert_eq!(read_back["modes"][0]["background_file_id"], json!(file));
        assert!(guarded, "the in-use check finds it");
        assert!(still_there, "a save of the same file under another spelling is not a replacement");
        assert_eq!(delete_shouted, StatusCode::CONFLICT, "DELETE under another spelling is refused like the canonical one");
        assert_eq!(set_icon, StatusCode::OK);
        assert_eq!(stored_icon.as_deref(), Some(icon.as_str()));
    }

    /// One upload can back a mode and an icon: replacing the icon keeps the file. Reclaim
    /// hooks go through reclaim_file, which is what the source pin below holds them to.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn replacing_an_icon_keeps_a_file_a_mode_still_shows() {
        let Some(pool) = crate::migrator::test_pool(8).await else { return };
        let f = setup(&pool).await;
        let state = state_of(&pool);
        let mode = make(&state, &f, "Clocktower", &[]).await;
        let both = upload(&pool, f.owner, "image/jpeg", 1000).await;
        let icon_only = upload(&pool, f.owner, "image/jpeg", 1000).await;
        let next = upload(&pool, f.owner, "image/jpeg", 1000).await;
        assert_eq!(patch(&state, &f, f.owner, mode, json!({ "background_file_id": both.clone() })).await, StatusCode::OK);
        let set_icon = |id: String| {
            crate::server_handlers::update_server_settings(
                State(Arc::clone(&state)),
                Path(f.sid.clone()),
                Extension(claims(f.owner)),
                Json(serde_json::from_value(json!({ "icon_file_id": id })).unwrap()),
            )
        };
        assert_eq!(set_icon(both.clone()).await.into_response().status(), StatusCode::OK);
        assert_eq!(set_icon(icon_only.clone()).await.into_response().status(), StatusCode::OK);
        let kept = file_exists(&pool, &both).await;
        assert_eq!(set_icon(next.clone()).await.into_response().status(), StatusCode::OK);
        let control = !file_exists(&pool, &icon_only).await;
        let _ = sqlx::query("UPDATE servers SET icon_file_id = NULL WHERE id = $1").bind(&f.sid).execute(&pool).await;
        let _ = sqlx::query("DELETE FROM uploaded_files WHERE uploader_id = ANY($1)").bind(f.users.clone()).execute(&pool).await;
        teardown(&pool, &f).await;
        assert!(kept, "the mode still shows it");
        assert!(control, "control: an icon nothing else uses is reclaimed");
    }

    /// Deleting a channel a mode names tells everyone, or a mode editor still holding its
    /// id has every save refused with no row to untick. A channel no mode names says
    /// nothing. Whoever is on the server refetches their channels through this frame too.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn deleting_a_channel_a_mode_names_announces_it() {
        let Some(pool) = crate::migrator::test_pool(8).await else { return };
        let f = setup(&pool).await;
        let state = state_of(&pool);
        let rooms = channel(&pool, &f.sid, "rooms", 2).await;
        let under = subchannel(&pool, &f.sid, "under", 0, rooms).await;
        let mode = make(&state, &f, "Clocktower", &[f.town, under]).await;
        assert_eq!(patch(&state, &f, f.owner, mode, json!({ "home_channel_id": f.cottage })).await, StatusCode::OK);
        let mut watcher = Sock::open(&state, f.plain);
        let delete = |id: i32| {
            crate::channel_handlers::delete_channel(State(Arc::clone(&state)), Path(id as i64), Extension(claims(f.owner)))
        };
        let edited = |frames: Vec<ServerMessage>| frames.iter().any(|m| matches!(m, M::ServerModesEdited { .. }));

        assert_eq!(delete(f.lobby).await.into_response().status(), StatusCode::NO_CONTENT);
        let in_no_mode = edited(watcher.drain());
        assert_eq!(delete(f.town).await.into_response().status(), StatusCode::NO_CONTENT);
        let ticked = edited(watcher.drain());
        assert_eq!(delete(f.cottage).await.into_response().status(), StatusCode::NO_CONTENT);
        let main_channel = edited(watcher.drain());
        assert_eq!(delete(rooms).await.into_response().status(), StatusCode::NO_CONTENT);
        let collection_of_a_ticked_one = edited(watcher.drain());
        teardown(&pool, &f).await;

        assert!(!in_no_mode, "control: no mode names it");
        assert!(ticked);
        assert!(main_channel);
        assert!(collection_of_a_ticked_one, "the delete takes the ticked subchannel with it");
    }

    /// The mode that is on takes Switch Modes to delete: it is turning it off.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn deleting_the_mode_that_is_on_takes_switch_modes() {
        let Some(pool) = crate::migrator::test_pool(8).await else { return };
        let f = setup(&pool).await;
        let state = state_of(&pool);
        let on = make(&state, &f, "On", &[f.town]).await;
        let _in_town = Sock::in_room(&state, f.plain, f.town);
        assert_eq!(switch(&state, &f, f.owner, Some(on)).await.0, StatusCode::OK);
        role(&pool, &f.sid, f.switcher as i32, "and channels", P::MANAGE_CHANNELS, 3).await;
        let delete = |by: i64| delete_mode(State(Arc::clone(&state)), Path((f.sid.clone(), on)), Extension(claims(by)));

        let manager_only = delete(f.manager).await.status();
        let town_after_refusal = occupants(&state, f.town);
        let (stored,): (Option<i32>,) =
            sqlx::query_as("SELECT active_mode_id FROM servers WHERE id = $1").bind(&f.sid).fetch_one(&pool).await.unwrap();
        let switcher_only = delete(f.mover).await.status();
        let both = delete(f.switcher).await.status();
        let town_after = occupants(&state, f.town);
        teardown(&pool, &f).await;

        assert_eq!(manager_only, StatusCode::FORBIDDEN);
        assert_eq!(town_after_refusal, vec![f.plain], "nothing happened");
        assert_eq!(stored, Some(on));
        assert_eq!(switcher_only, StatusCode::FORBIDDEN, "a mover has neither");
        assert_eq!(both, StatusCode::OK);
        assert!(town_after.is_empty());
    }

    /// Re-enabling Turn off when empty starts a fresh window: the room may have emptied
    /// while it was off. The stamp keeps moving while it is off, so a mode someone used
    /// meanwhile is known to have been used, and one nobody joined stays unjoined.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn re_enabling_the_auto_off_starts_a_fresh_window() {
        let Some(pool) = crate::migrator::test_pool(8).await else { return };
        let _only_tick = AUTO_OFF_TESTS.lock().await;
        let f = setup(&pool).await;
        let state = state_of(&pool);
        let mode = make(&state, &f, "Clocktower", &[f.town]).await;
        assert_eq!(switch(&state, &f, f.owner, Some(mode)).await.0, StatusCode::OK);
        let active = || async {
            sqlx::query_scalar::<_, Option<i32>>("SELECT active_mode_id FROM servers WHERE id = $1").bind(&f.sid).fetch_one(&pool).await.unwrap()
        };
        let age_of_stamp = || async {
            sqlx::query_scalar::<_, Option<f64>>("SELECT EXTRACT(EPOCH FROM NOW() - active_mode_occupied_at)::float8 FROM servers WHERE id = $1")
                .bind(&f.sid)
                .fetch_one(&pool)
                .await
                .unwrap()
        };
        let (age_pool, age_sid) = (&pool, &f.sid);
        let age = move |minutes: i32| async move {
            sqlx::query("UPDATE servers SET active_mode_occupied_at = NOW() - make_interval(mins => $1) WHERE id = $2")
                .bind(minutes)
                .bind(age_sid)
                .execute(age_pool)
                .await
                .unwrap();
        };

        // Opted out, unjoined: re-enabling does not make it look joined.
        assert_eq!(patch(&state, &f, f.owner, mode, json!({ "auto_off": false })).await, StatusCode::OK);
        assert_eq!(patch(&state, &f, f.owner, mode, json!({ "auto_off": true })).await, StatusCode::OK);
        let still_unjoined = age_of_stamp().await;
        assert_eq!(patch(&state, &f, f.owner, mode, json!({ "auto_off": false })).await, StatusCode::OK);

        // Opted out, someone comes: the tick still stamps.
        let visitor = Sock::in_room(&state, f.plain, f.town);
        auto_off_tick(&state).await;
        let stamped_while_out = age_of_stamp().await;
        state.leave_room(&format!("voice_{}", f.town), visitor.user, visitor.conn);

        // Three hours later, re-enabled: a fresh window, not an instant turn-off.
        age(180).await;
        auto_off_tick(&state).await;
        let opted_out_stays = active().await;
        // The turn-off itself re-checks, for an owner who unticked it after the read.
        turn_off_empty(&state, &f.sid, mode, "Clocktower").await;
        let unticked_since_the_read = active().await;
        assert_eq!(patch(&state, &f, f.owner, mode, json!({ "auto_off": true })).await, StatusCode::OK);
        let fresh = age_of_stamp().await;
        auto_off_tick(&state).await;
        let stays = active().await;

        // A later edit of something else does not refresh it.
        age(AUTO_OFF_EMPTY_MINUTES + 1).await;
        assert_eq!(patch(&state, &f, f.owner, mode, json!({ "name": "Renamed" })).await, StatusCode::OK);
        auto_off_tick(&state).await;
        let control = active().await;
        teardown(&pool, &f).await;

        assert_eq!(still_unjoined, None);
        assert!(stamped_while_out.is_some_and(|a| a < 30.0), "{stamped_while_out:?}");
        assert_eq!(opted_out_stays, Some(mode));
        assert_eq!(unticked_since_the_read, Some(mode));
        assert!(fresh.is_some_and(|a| a < 30.0), "{fresh:?}");
        assert_eq!(stays, Some(mode));
        assert_eq!(control, None, "control: an old stamp and no re-enable does turn it off");
    }

    /// A visit shorter than one tick counts: JoinRoom stamps. Only for a channel the mode
    /// on there uses, and not for a stream-only account, which can sit there unattended.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn joining_stamps_the_mode_however_short_the_visit() {
        let Some(pool) = crate::migrator::test_pool(8).await else { return };
        let f = setup(&pool).await;
        let state = state_of(&pool);
        let rooms = channel(&pool, &f.sid, "rooms", 2).await;
        let under = subchannel(&pool, &f.sid, "under", 1, rooms).await;
        let mode = make(&state, &f, "Clocktower", &[f.town, rooms]).await;
        assert_eq!(patch(&state, &f, f.owner, mode, json!({ "home_channel_id": f.lobby })).await, StatusCode::OK);
        assert_eq!(switch(&state, &f, f.owner, Some(mode)).await.0, StatusCode::OK);
        let other = channel(&pool, &f.sid, "elsewhere", 1).await;
        let seen = || async {
            sqlx::query_scalar::<_, bool>("SELECT active_mode_occupied_at IS NOT NULL FROM servers WHERE id = $1")
                .bind(&f.sid)
                .fetch_one(&pool)
                .await
                .unwrap()
        };
        let clear = || async {
            sqlx::query("UPDATE servers SET active_mode_occupied_at = NULL WHERE id = $1").bind(&f.sid).execute(&pool).await.unwrap();
        };
        let join = |user: i64, conn: u64, room: i32| {
            let frame = json!({ "type": "JoinRoom", "payload": { "room_id": format!("voice_{room}") } }).to_string();
            let state = Arc::clone(&state);
            async move { crate::ws::handle_message(&state, user, conn, "t", &frame, &mut std::collections::HashSet::new(), "").await }
        };
        let person = Sock::open(&state, f.plain);

        join(f.plain, person.conn, other).await.expect("join");
        let not_the_mode = seen().await;
        join(f.plain, person.conn, f.town).await.expect("join");
        let ticked = seen().await;
        clear().await;
        join(f.plain, person.conn, under).await.expect("join");
        let under_the_collection = seen().await;
        clear().await;
        join(f.plain, person.conn, f.lobby).await.expect("join");
        let main_channel = seen().await;
        clear().await;

        stream_only_in(&pool, &f.sid, f.manager as i32, f.town).await;
        let bot = Sock::open(&state, f.manager);
        let bot_joined = join(f.manager, bot.conn, f.town).await;
        let bot_stamped = seen().await;
        let bot_in_room = occupants(&state, f.town).contains(&f.manager);
        teardown(&pool, &f).await;

        assert!(!not_the_mode, "a channel this mode has nothing to do with");
        assert!(ticked);
        assert!(under_the_collection);
        assert!(main_channel);
        assert!(bot_joined.is_ok() && bot_in_room, "the fixture's bot did join: {bot_joined:?}");
        assert!(!bot_stamped, "a stream-only account is nobody being there");
    }

    /// The server rows carry the field: it is how a client knows this backend
    /// has modes at all, so absent and null are two different answers. Every road a
    /// client gets a row by: the list, a server just made, a server just joined.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn the_server_row_says_which_mode_is_on() {
        let Some(pool) = crate::migrator::test_pool(8).await else { return };
        let f = setup(&pool).await;
        let state = state_of(&pool);
        let mode = make(&state, &f, "Clocktower", &[f.town]).await;
        let row = |state: Arc<AppState>, user: i64, sid: String| async move {
            let resp = crate::server_handlers::list_servers(State(state), Extension(claims(user))).await.into_response();
            let (_, rows) = read(resp).await;
            rows.as_array().unwrap().iter().find(|s| s["id"] == sid.as_str()).unwrap().as_object().unwrap().get("active_mode_id").cloned()
        };
        let before = row(Arc::clone(&state), f.plain, f.sid.clone()).await;
        assert_eq!(switch(&state, &f, f.owner, Some(mode)).await.0, StatusCode::OK);
        let after = row(Arc::clone(&state), f.plain, f.sid.clone()).await;

        let (created_status, created) = read(
            crate::server_handlers::create_server(
                State(Arc::clone(&state)),
                Extension(claims(f.owner)),
                Json(serde_json::from_value(json!({ "name": "made just now" })).unwrap()),
            )
            .await
            .into_response(),
        )
        .await;
        let made = created["id"].as_str().map(str::to_string);

        let code = format!("md{}", &uuid::Uuid::new_v4().simple().to_string()[..10]);
        sqlx::query("INSERT INTO server_invites (code, server_id, creator_id) VALUES ($1, $2, $3)")
            .bind(&code)
            .bind(&f.sid)
            .bind(f.owner as i32)
            .execute(&pool)
            .await
            .expect("invite");
        let (joiner,): (i32,) = sqlx::query_as("INSERT INTO users (username, salt, verifier) VALUES ($1, $2, $3) RETURNING id")
            .bind(format!("md_join_{}", uuid::Uuid::new_v4().simple()))
            .bind(b"s".as_ref())
            .bind(b"v".as_ref())
            .fetch_one(&pool)
            .await
            .unwrap();
        let (joined_status, joined) = read(
            crate::invite_handlers::join_via_invite(State(Arc::clone(&state)), Path(code.clone()), Extension(claims(joiner as i64)))
                .await
                .into_response(),
        )
        .await;
        if let Some(made) = &made {
            let _ = sqlx::query("DELETE FROM channels WHERE server_id = $1").bind(made).execute(&pool).await;
            let _ = sqlx::query("DELETE FROM servers WHERE id = $1").bind(made).execute(&pool).await;
        }
        let _ = sqlx::query("DELETE FROM users WHERE id = $1").bind(joiner).execute(&pool).await;
        teardown(&pool, &f).await;
        assert_eq!(before, Some(Value::Null), "present and null, never absent: absent means an older backend");
        assert_eq!(after, Some(json!(mode)));
        assert!(created_status.is_success(), "{created}");
        assert_eq!(created.as_object().unwrap().get("active_mode_id"), Some(&Value::Null), "a server just made");
        assert!(joined_status.is_success(), "{joined}");
        assert_eq!(joined.as_object().unwrap().get("active_mode_id"), Some(&json!(mode)), "a server just joined");
    }
}
