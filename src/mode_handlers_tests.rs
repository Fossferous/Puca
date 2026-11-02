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

        let delete = |id: i32| {
            delete_mode(State(Arc::clone(&state)), Path((f.sid.clone(), id)), Extension(claims(f.manager)))
        };
        let deleted_off = delete(off).await.status();
        let cottage_after = occupants(&state, f.cottage);
        let cottage_frames = in_cottage.drain();
        let deleted_on = delete(on).await.status();
        let town_after = occupants(&state, f.town);
        let town_story = story(&in_town.drain());
        let gone_again = delete(on).await.status();
        let (stored,): (Option<i32>,) =
            sqlx::query_as("SELECT active_mode_id FROM servers WHERE id = $1").bind(&f.sid).fetch_one(&pool).await.unwrap();
        let channel_kept = sqlx::query_scalar::<_, bool>("SELECT EXISTS (SELECT 1 FROM channels WHERE id = $1)")
            .bind(f.town)
            .fetch_one(&pool)
            .await
            .unwrap();
        teardown(&pool, &f).await;

        assert_eq!(deleted_off, StatusCode::OK);
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

        // Someone joins: the clock starts, and a stale stamp is refreshed.
        let call = Sock::in_room(&state, f.plain, f.town);
        age(pool.clone(), f.sid.clone(), 45).await;
        auto_off_tick(&state).await;
        let occupied_stays = active(pool.clone(), f.sid.clone()).await;
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

        // Opted back in: off, and everyone is told nobody did it.
        assert_eq!(patch(&state, &f, f.owner, mode, json!({ "auto_off": true })).await, StatusCode::OK);
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
        assert_eq!(occupied_stays, Some(mode));
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
        teardown(&pool, &f).await;
        assert_eq!(renamed, StatusCode::OK);
        assert_eq!(kept["modes"][0]["channel_ids"], json!([f.town, f.cottage]), "control: another edit leaves it");
        assert_eq!(made_afk, StatusCode::OK);
        assert_eq!(left["modes"][0]["channel_ids"], json!([f.cottage]));
        assert!(frames.iter().any(|m| matches!(m, M::ServerModesEdited { .. })), "and everyone hears");
    }

    /// The server rows carry the field: it is how a client knows this backend
    /// has modes at all.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn the_server_row_says_which_mode_is_on() {
        let Some(pool) = crate::migrator::test_pool(8).await else { return };
        let f = setup(&pool).await;
        let state = state_of(&pool);
        let mode = make(&state, &f, "Clocktower", &[f.town]).await;
        let row = |state: Arc<AppState>, user: i64, sid: String| async move {
            let resp = crate::server_handlers::list_servers(State(state), Extension(claims(user))).await.into_response();
            let (_, rows) = read(resp).await;
            rows.as_array().unwrap().iter().find(|s| s["id"] == sid.as_str()).unwrap()["active_mode_id"].clone()
        };
        let before = row(Arc::clone(&state), f.plain, f.sid.clone()).await;
        assert_eq!(switch(&state, &f, f.owner, Some(mode)).await.0, StatusCode::OK);
        let after = row(Arc::clone(&state), f.plain, f.sid.clone()).await;
        teardown(&pool, &f).await;
        assert_eq!(before, Value::Null, "present and null, never absent: absent means an older backend");
        assert_eq!(after, json!(mode));
    }
}
