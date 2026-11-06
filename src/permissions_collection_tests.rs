//! A collection's permission overwrites reach the channels inside it
//! (docs/USER_GUIDE.md, "Collections and permissions"). The rule, decided 2026-11-05:
//!
//! * a collection's DENY removes access from its children for whoever it
//!   denies at the collection itself;
//! * a child's own ALLOW (any role of the member's, or @everyone) restores the
//!   bit;
//! * nothing a collection ALLOWS grants anything the child's own rules and the
//!   server base do not.
//!
//! Every case below is checked against all three resolvers, which have to agree
//! with each other AND with the table (a hand-written expectation, not a
//! second implementation of the rule).

use super::*;
use std::collections::HashSet;

const V: i64 = Permissions::VIEW_CHANNEL.bits() as i64;
const SEND: i64 = Permissions::SEND_MESSAGES.bits() as i64;
const MANAGE_MSG: i64 = Permissions::MANAGE_MESSAGES.bits() as i64;
const CONNECT: i64 = Permissions::CONNECT.bits() as i64;
const TEXT: ChannelKind = ChannelKind::Other;

/// Who is asking: owner, administrator, a plain member, a member holding Staff.
const WHO: [&str; 4] = ["owner", "admin", "plain", "staff"];
const EVERYONE: usize = 0;
const STAFF: usize = 1;

/// (role index, allow, deny)
type Ow = (usize, i64, i64);

struct Case {
    name: &'static str,
    /// The outer collection of a nested pair, if any.
    outer: &'static [Ow],
    coll: &'static [Ow],
    child: &'static [Ow],
    /// Is the child a voice channel (type 1) instead of text?
    voice: bool,
    /// (bit, owner/admin/plain/staff has it)
    expect: &'static [(i64, [bool; 4])],
}

const ALL: [bool; 4] = [true; 4];
const STAFF_ONLY: [bool; 4] = [true, true, false, true];
const NOT_PLAIN_OR_STAFF: [bool; 4] = [true, true, false, false];
const NOT_STAFF: [bool; 4] = [true, true, true, false];

const CASES: &[Case] = &[
    Case { name: "no overwrites anywhere", outer: &[], coll: &[], child: &[], voice: false, expect: &[(V, ALL), (SEND, ALL)] },
    Case {
        name: "collection denies View to @everyone: the child is closed to members",
        outer: &[], coll: &[(EVERYONE, 0, V)], child: &[], voice: false,
        expect: &[(V, NOT_PLAIN_OR_STAFF)],
    },
    Case {
        name: "...and staff holding the allow ON THE COLLECTION still get in",
        outer: &[], coll: &[(EVERYONE, 0, V), (STAFF, V, 0)], child: &[], voice: false,
        expect: &[(V, STAFF_ONLY)],
    },
    Case {
        name: "the child's own @everyone allow restores View for everyone",
        outer: &[], coll: &[(EVERYONE, 0, V)], child: &[(EVERYONE, V, 0)], voice: false,
        expect: &[(V, ALL)],
    },
    Case {
        name: "the child's own staff allow restores it for staff only",
        outer: &[], coll: &[(EVERYONE, 0, V)], child: &[(STAFF, V, 0)], voice: false,
        expect: &[(V, STAFF_ONLY)],
    },
    Case {
        name: "control: the CHANNEL's own deny, nothing on the collection",
        outer: &[], coll: &[], child: &[(EVERYONE, 0, V)], voice: false,
        expect: &[(V, NOT_PLAIN_OR_STAFF)],
    },
    Case {
        name: "a collection deny aimed at staff only",
        outer: &[], coll: &[(STAFF, 0, V)], child: &[], voice: false,
        expect: &[(V, NOT_STAFF)],
    },
    Case {
        name: "...and the child's staff allow takes it back",
        outer: &[], coll: &[(STAFF, 0, V)], child: &[(STAFF, V, 0)], voice: false,
        expect: &[(V, ALL)],
    },
    Case {
        name: "a deny of one bit takes only that bit",
        outer: &[], coll: &[(EVERYONE, 0, SEND)], child: &[], voice: false,
        expect: &[(V, ALL), (SEND, NOT_PLAIN_OR_STAFF)],
    },
    Case {
        name: "the child's allow restores that bit and no other",
        outer: &[], coll: &[(EVERYONE, 0, SEND | V)], child: &[(EVERYONE, SEND, 0)], voice: false,
        expect: &[(V, NOT_PLAIN_OR_STAFF), (SEND, ALL)],
    },
    Case {
        name: "a collection ALLOW grants nothing the base does not",
        outer: &[], coll: &[(EVERYONE, MANAGE_MSG, 0)], child: &[], voice: false,
        expect: &[(MANAGE_MSG, [true, true, false, false])],
    },
    Case {
        name: "a collection allow does not beat the child's own deny",
        outer: &[], coll: &[(EVERYONE, V, 0)], child: &[(EVERYONE, 0, V)], voice: false,
        expect: &[(V, NOT_PLAIN_OR_STAFF)],
    },
    Case {
        name: "nested: the outer collection's deny reaches a child two levels down",
        outer: &[(EVERYONE, 0, V)], coll: &[], child: &[], voice: false,
        expect: &[(V, NOT_PLAIN_OR_STAFF)],
    },
    Case {
        name: "nested: the inner collection's own allow lifts the outer's deny",
        outer: &[(EVERYONE, 0, V)], coll: &[(EVERYONE, V, 0)], child: &[], voice: false,
        expect: &[(V, ALL)],
    },
    Case {
        name: "nested: the outer's staff allow carries down",
        outer: &[(EVERYONE, 0, V), (STAFF, V, 0)], coll: &[], child: &[], voice: false,
        expect: &[(V, STAFF_ONLY)],
    },
    Case {
        name: "nested: the inner collection's deny reaches the child even when the outer allows",
        outer: &[(EVERYONE, V, 0)], coll: &[(EVERYONE, 0, V)], child: &[], voice: false,
        expect: &[(V, NOT_PLAIN_OR_STAFF)],
    },
    Case {
        name: "a voice room under a denied collection is closed too",
        outer: &[], coll: &[(EVERYONE, 0, V | CONNECT)], child: &[], voice: true,
        expect: &[(V, NOT_PLAIN_OR_STAFF), (CONNECT, NOT_PLAIN_OR_STAFF)],
    },
    Case {
        name: "a voice room's own allow restores it",
        outer: &[], coll: &[(EVERYONE, 0, V | CONNECT)], child: &[(EVERYONE, V | CONNECT, 0)], voice: true,
        expect: &[(V, ALL), (CONNECT, ALL)],
    },
];

struct World {
    sid: String,
    users: [i32; 4],
    roles: [i64; 2],
}

async fn mk_user(pool: &sqlx::PgPool, tag: &str) -> i32 {
    sqlx::query_as::<_, (i32,)>("INSERT INTO users (username, salt, verifier) VALUES ($1, '00', '00') RETURNING id")
        .bind(format!("cd_{tag}_{}", uuid::Uuid::new_v4()))
        .fetch_one(pool)
        .await
        .expect("user")
        .0
}

async fn mk_channel(pool: &sqlx::PgPool, sid: &str, name: &str, kind: i32, parent: Option<i64>) -> i64 {
    sqlx::query_as::<_, (i32,)>("INSERT INTO channels (server_id, name, type, parent_id) VALUES ($1, $2, $3, $4) RETURNING id")
        .bind(sid)
        .bind(name)
        .bind(kind)
        .bind(parent.map(|p| p as i32))
        .fetch_one(pool)
        .await
        .expect("channel")
        .0 as i64
}

async fn world(pool: &sqlx::PgPool) -> World {
    let mut users = [0i32; 4];
    for (i, w) in WHO.iter().enumerate() {
        users[i] = mk_user(pool, w).await;
    }
    let sid = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO servers (id, name, owner_id) VALUES ($1, 'cd-test', $2)")
        .bind(&sid).bind(users[0]).execute(pool).await.expect("server");
    for u in users {
        sqlx::query("INSERT INTO server_members (server_id, user_id) VALUES ($1, $2)")
            .bind(&sid).bind(u).execute(pool).await.expect("member");
    }
    let mut roles = [0i64; 2];
    let (everyone,): (i64,) = sqlx::query_as("INSERT INTO server_roles (server_id, name, color, permissions, position, is_default) VALUES ($1, '@everyone', '#99AAB5', $2, 0, true) RETURNING id")
        .bind(&sid).bind(Permissions::DEFAULT_MEMBER.bits() as i64).fetch_one(pool).await.expect("@everyone");
    roles[EVERYONE] = everyone;
    let (staff,): (i64,) = sqlx::query_as("INSERT INTO server_roles (server_id, name, color, permissions, position, is_default) VALUES ($1, 'Staff', '#99AAB5', 0, 1, false) RETURNING id")
        .bind(&sid).fetch_one(pool).await.expect("staff");
    roles[STAFF] = staff;
    let (admin,): (i64,) = sqlx::query_as("INSERT INTO server_roles (server_id, name, color, permissions, position, is_default) VALUES ($1, 'Admin', '#99AAB5', $2, 2, false) RETURNING id")
        .bind(&sid).bind(Permissions::ADMINISTRATOR.bits() as i64).fetch_one(pool).await.expect("admin");
    for (user, role) in [(users[1], admin), (users[3], staff)] {
        sqlx::query("INSERT INTO member_roles (server_id, user_id, role_id) VALUES ($1, $2, $3)")
            .bind(&sid).bind(user).bind(role).execute(pool).await.expect("assign");
    }
    World { sid, users, roles }
}

async fn put(pool: &sqlx::PgPool, w: &World, channel: i64, rows: &[Ow]) {
    for &(role, allow, deny) in rows {
        sqlx::query("INSERT INTO channel_permission_overwrites (channel_id, role_id, allow, deny) VALUES ($1, $2, $3, $4)")
            .bind(channel as i32).bind(w.roles[role]).bind(allow).bind(deny)
            .execute(pool).await.expect("overwrite");
    }
}

async fn cleanup(pool: &sqlx::PgPool, w: &World) {
    let _ = sqlx::query("DELETE FROM servers WHERE id = $1").bind(&w.sid).execute(pool).await;
    for u in w.users {
        let _ = sqlx::query("DELETE FROM users WHERE id = $1").bind(u).execute(pool).await;
    }
}

/// All three resolvers' answers for one channel, per member.
async fn resolve(pool: &sqlx::PgPool, w: &World, channel: i64) -> [Permissions; 4] {
    let viewers = get_channel_viewer_ids(pool, channel, &w.sid).await.expect("viewers");
    let mut out = [Permissions::empty(); 4];
    for (i, &u) in w.users.iter().enumerate() {
        let single = match get_user_channel_permissions(pool, channel, u as i64).await {
            ChannelPermAccess::Allowed { perms, .. } => perms,
            _ => panic!("{} is a member", WHO[i]),
        };
        let bulk = get_user_channels_permissions(pool, &w.sid, u as i64, &[channel]).await.expect("bulk")[&channel];
        assert_eq!(single, bulk, "single and bulk resolvers disagree for {} on channel {channel}", WHO[i]);
        assert_eq!(
            single.has(Permissions::VIEW_CHANNEL),
            viewers.contains(&(u as i64)),
            "the viewer set (who is given the key) disagrees with the resolver for {} on channel {channel}",
            WHO[i]
        );
        out[i] = single;
    }
    out
}

#[tokio::test]
async fn a_collections_overwrites_reach_its_children_and_all_three_resolvers_agree() {
    let Some(pool) = crate::migrator::test_pool(4).await else { return };
    for case in CASES {
        let w = world(&pool).await;
        let outer = if case.outer.is_empty() { None } else { Some(mk_channel(&pool, &w.sid, "outer", 2, None).await) };
        let coll = mk_channel(&pool, &w.sid, "coll", 2, None).await;
        if let Some(o) = outer {
            // PATCH parent_id can nest a collection under another one.
            sqlx::query("UPDATE channels SET parent_id = $1 WHERE id = $2").bind(o as i32).bind(coll as i32).execute(&pool).await.unwrap();
            put(&pool, &w, o, case.outer).await;
        }
        let child = mk_channel(&pool, &w.sid, "child", if case.voice { 1 } else { 0 }, Some(coll)).await;
        put(&pool, &w, coll, case.coll).await;
        put(&pool, &w, child, case.child).await;
        // Control: a sibling under an unrelated collection with no rules.
        let other = mk_channel(&pool, &w.sid, "other", 2, None).await;
        let ctl = mk_channel(&pool, &w.sid, "ctl", 0, Some(other)).await;

        let got = resolve(&pool, &w, child).await;
        for &(bit, want) in case.expect {
            for i in 0..4 {
                assert_eq!(
                    got[i].has(Permissions::from_bits_truncate(bit as u64)),
                    want[i],
                    "case \"{}\": {} bit {bit:#x} on the child",
                    case.name, WHO[i]
                );
            }
        }
        let ctl_perms = resolve(&pool, &w, ctl).await;
        for i in 0..4 {
            assert!(ctl_perms[i].has(Permissions::VIEW_CHANNEL), "case \"{}\": control sibling hidden from {}", case.name, WHO[i]);
        }
        // The collection ROW itself resolves by its own rows (+ its parents'):
        // the staff allow on it is what keeps staff on the collection.
        let _ = resolve(&pool, &w, coll).await;
        cleanup(&pool, &w).await;
    }
}

/// A loop built by PATCH parent_id must not hang a resolver, and it still
/// applies each collection's rows once.
#[tokio::test]
async fn a_loop_of_collections_terminates_and_still_denies() {
    let Some(pool) = crate::migrator::test_pool(4).await else { return };
    let w = world(&pool).await;
    let a = mk_channel(&pool, &w.sid, "a", 2, None).await;
    let b = mk_channel(&pool, &w.sid, "b", 2, None).await;
    sqlx::query("UPDATE channels SET parent_id = $1 WHERE id = $2").bind(b as i32).bind(a as i32).execute(&pool).await.unwrap();
    sqlx::query("UPDATE channels SET parent_id = $1 WHERE id = $2").bind(a as i32).bind(b as i32).execute(&pool).await.unwrap();
    let child = mk_channel(&pool, &w.sid, "child", 0, Some(a)).await;
    put(&pool, &w, b, &[(EVERYONE, 0, V)]).await;
    let got = tokio::time::timeout(std::time::Duration::from_secs(20), resolve(&pool, &w, child))
        .await
        .expect("a resolver looped");
    assert!(!got[2].has(Permissions::VIEW_CHANNEL), "the denial inside the loop still applies");
    assert!(got[0].has(Permissions::VIEW_CHANNEL) && got[1].has(Permissions::VIEW_CHANNEL));
    cleanup(&pool, &w).await;
}

/// The member list of who is told about a brand-new channel is the viewer set
/// of its resolver, not base permissions (create_channel).
#[tokio::test]
async fn viewer_ids_of_a_child_leave_out_who_the_collection_denies() {
    let Some(pool) = crate::migrator::test_pool(4).await else { return };
    let w = world(&pool).await;
    let coll = mk_channel(&pool, &w.sid, "vault", 2, None).await;
    put(&pool, &w, coll, &[(EVERYONE, 0, V), (STAFF, V, 0)]).await;
    let child = mk_channel(&pool, &w.sid, "child", 0, Some(coll)).await;
    let v: HashSet<i64> = get_channel_viewer_ids(&pool, child, &w.sid).await.expect("viewers");
    let want: HashSet<i64> = [w.users[0], w.users[1], w.users[3]].iter().map(|&u| u as i64).collect();
    assert_eq!(v, want);
    cleanup(&pool, &w).await;
}

// --- the pure parts, no database ---

fn chain_of(pairs: &[(i64, i64)], id: i64) -> Vec<i64> {
    ancestor_chain(&pairs.iter().copied().collect(), id)
}

#[test]
fn the_chain_is_outermost_first_and_empty_for_a_top_level_channel() {
    assert_eq!(chain_of(&[], 5), Vec::<i64>::new());
    assert_eq!(chain_of(&[(5, 4)], 5), vec![4]);
    assert_eq!(chain_of(&[(5, 4), (4, 3)], 5), vec![3, 4], "outermost first");
}

#[test]
fn a_loop_ends_the_walk_and_counts_each_collection_once() {
    assert_eq!(chain_of(&[(5, 4), (4, 3), (3, 4)], 5), vec![3, 4]);
    assert_eq!(chain_of(&[(5, 5)], 5), Vec::<i64>::new(), "a channel that is its own parent");
    assert_eq!(chain_of(&[(5, 4), (4, 5)], 5), vec![4], "the channel itself is never its own ancestor");
}

/// No depth limit: a limit would drop the OUTERMOST collections, the ones most
/// likely to carry the deny (a nested chain is only reachable through PATCH).
#[test]
fn the_chain_has_no_depth_limit_so_the_outermost_collection_is_always_read() {
    let pairs: Vec<(i64, i64)> = (0..30).map(|i| (i, i + 1)).collect();
    let chain = chain_of(&pairs, 0);
    assert_eq!(chain.len(), 30);
    assert_eq!(chain[0], 30, "the outermost first");
    assert_eq!(*chain.last().unwrap(), 1, "the nearest last");
}

/// Whatever the collections say, the result is never MORE than the channel's
/// own rows give: a collection can only take away. Checked over a generated
/// space of bases, rows and chains, with the loosest possible inputs (allow and
/// deny on the same bit, every combination of @everyone and role rows).
#[test]
fn a_collection_can_only_remove_never_grant() {
    fn next(state: &mut u64) -> u64 {
        *state ^= *state << 13;
        *state ^= *state >> 7;
        *state ^= *state << 17;
        *state
    }
    fn mask(n: u64) -> i64 {
        let bits = [V, SEND, MANAGE_MSG, CONNECT, Permissions::READ_MESSAGE_HISTORY.bits() as i64];
        bits.iter().enumerate().filter(|(i, _)| n >> i & 1 == 1).fold(0, |a, (_, b)| a | b)
    }
    fn rows(state: &mut u64, n: usize) -> Vec<OverwriteRow> {
        (0..n).map(|k| (mask(next(state)), mask(next(state)), k == 0)).collect()
    }
    let mut state: u64 = 0x9e37_79b9_7f4a_7c15;
    let mut removed_something = 0;
    for _ in 0..4000 {
        let base = Permissions::from_bits_truncate(
            (Permissions::DEFAULT_MEMBER.bits() | (mask(next(&mut state)) as u64)) & !Permissions::ADMINISTRATOR.bits(),
        );
        let levels = (next(&mut state) % 3) as usize;
        let chain_rows: Vec<Vec<OverwriteRow>> = (0..levels)
            .map(|_| {
                let n = (next(&mut state) % 3) as usize;
                rows(&mut state, n)
            })
            .collect();
        let n = (next(&mut state) % 3) as usize;
        let own = rows(&mut state, n);
        let chain: Vec<&[OverwriteRow]> = chain_rows.iter().map(Vec::as_slice).collect();
        let alone = layer_overwrite_rows(1, TEXT, base, &own);
        let with = layer_with_collections(1, TEXT, base, &chain, &own);
        assert!(alone.contains(with), "a collection granted something: base {base:?} chain {chain_rows:?} own {own:?}");
        if with != alone {
            removed_something += 1;
        }
    }
    assert!(removed_something > 200, "the generator never produced a denial ({removed_something}): the test would pass vacuously");
}

/// The member the collection does not deny, and the child's own allow, are
/// exactly the two ways back in.
#[test]
fn the_two_ways_back_in_are_the_collections_own_allow_and_the_childs() {
    let base = Permissions::DEFAULT_MEMBER;
    let deny_everyone: [OverwriteRow; 1] = [(0, V, true)];
    let staff_allow: [OverwriteRow; 2] = [(0, V, true), (V, 0, false)];
    let view = |chain: &[&[OverwriteRow]], own: &[OverwriteRow]| layer_with_collections(1, TEXT, base, chain, own).has(Permissions::VIEW_CHANNEL);
    assert!(!view(&[&deny_everyone], &[]));
    assert!(view(&[&staff_allow], &[]), "the collection's own allow lifts the deny for that member");
    assert!(view(&[&deny_everyone], &[(V, 0, true)]), "the child's own allow");
    assert!(!view(&[&deny_everyone], &[(0, SEND, true)]), "an allow of a different bit restores nothing");
}

/// A stream-only account keeps a voice room only while it can see and join it. A
/// collection that denies it View leaves it nothing when the room's own rows only
/// open Connect; the room's own allow of a bit takes it back, as for anyone (an
/// opening that names View as well is not stopped by the collection); and a deny
/// of a bit this member never had changes nothing.
#[test]
fn a_stream_only_account_loses_a_room_a_collection_denies_and_keeps_one_it_does_not() {
    let base = Permissions::VIEW_CHANNEL | Permissions::CONNECT | Permissions::STREAM | Permissions::STREAM_ONLY;
    let stream = Permissions::STREAM.bits() as i64;
    let opened_by_connect: [OverwriteRow; 1] = [(CONNECT | stream, 0, false)];
    let alone = layer_with_collections(1, ChannelKind::Voice, base, &[], &opened_by_connect);
    assert!(alone.contains(Permissions::VIEW_CHANNEL | Permissions::CONNECT), "control: opened for its role, it has the room: {alone:?}");

    let deny_view: [OverwriteRow; 1] = [(0, V, true)];
    let deny_send: [OverwriteRow; 1] = [(0, SEND, true)];
    let gone = layer_with_collections(1, ChannelKind::Voice, base, &[&deny_view], &opened_by_connect);
    assert_eq!(gone, Permissions::empty(), "a collection that denies View leaves nothing: {gone:?}");
    let unrelated = layer_with_collections(1, ChannelKind::Voice, base, &[&deny_send], &opened_by_connect);
    assert_eq!(unrelated, alone, "a deny of a bit this member never had changes nothing");
    let opened_with_view: [OverwriteRow; 1] = [(V | CONNECT | stream, 0, false)];
    let restored = layer_with_collections(1, ChannelKind::Voice, base, &[&deny_view], &opened_with_view);
    assert!(restored.contains(Permissions::VIEW_CHANNEL | Permissions::CONNECT), "the room's own allow of View takes it back: {restored:?}");
}
