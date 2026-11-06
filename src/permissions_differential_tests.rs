//! Differential test of the three resolvers over random FORESTS of collections.
//!
//! For a generated server (owner, an administrator, stream-only members, members
//! with random role sets; 2-3 collections nested up to three deep, now and then
//! a loop or a self-parent built with raw SQL; text and voice children; random
//! allow/deny rows on collections and children) this checks, for EVERY channel
//! and EVERY member:
//!
//! 1. `get_user_channel_permissions` == `get_user_channels_permissions` (the full
//!    `Permissions`, not just VIEW) and VIEW membership in `get_channel_viewer_ids`
//!    agrees with both;
//! 2. MONOTONICITY, independently of the layering code: the result with the
//!    collections' rows present is a SUBSET of the result for the same channel
//!    with every collection's rows deleted (a collection can only take away);
//! 3. for ordinary members, a per-bit ORACLE written separately from
//!    `layer_with_collections` (one bool per bit, from the in-memory rows, not from
//!    the database) agrees with all three resolvers - that is what catches a row
//!    reaching the wrong member or the wrong channel in the SQL.
//!
//! Needs `TEST_DATABASE_URL` (skips itself when it is unset, like its siblings).
//! 100 worlds are generated (edit WORLDS to run more).

use super::*;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicUsize, Ordering};

/// (member, channel) pairs compared, and of those the ones a collection really
/// took something from: the run must have seen both, or it proved nothing.
static COMPARED: AtomicUsize = AtomicUsize::new(0);
static REMOVED: AtomicUsize = AtomicUsize::new(0);

const TESTED: [Permissions; 6] = [
    Permissions::VIEW_CHANNEL,
    Permissions::SEND_MESSAGES,
    Permissions::READ_MESSAGE_HISTORY,
    Permissions::CONNECT,
    Permissions::SPEAK,
    Permissions::MANAGE_MESSAGES,
];

fn tested_mask() -> Permissions {
    TESTED.iter().fold(Permissions::empty(), |a, &b| a | b)
}

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    fn chance(&mut self, num: u64, den: u64) -> bool {
        self.below(den) < num
    }
}

/// One overwrite row: role index (0 = @everyone), allow, deny.
#[derive(Clone, Copy, Debug)]
struct Row {
    role: usize,
    allow: i64,
    deny: i64,
}

#[derive(Clone, Debug)]
struct Chan {
    kind: i32, // 0 text, 1 voice, 2 collection
    parent: Option<usize>,
    rows: Vec<Row>,
}

/// Role indexes: 0 @everyone, 1..=3 plain roles, 4 stream-only, 5 administrator.
const SO: usize = 4;
const ADMIN: usize = 5;

#[derive(Debug)]
struct Forest {
    role_perms: Vec<i64>,
    /// Held roles per user. User 0 is the owner (holds nothing), 1 the administrator.
    users: Vec<Vec<usize>>,
    chans: Vec<Chan>,
}

fn random_masks(rng: &mut Rng) -> (i64, i64) {
    let (mut allow, mut deny) = (0i64, 0i64);
    for bit in TESTED {
        match rng.below(8) {
            0 => allow |= bit.bits() as i64,
            1 | 2 => deny |= bit.bits() as i64,
            _ => {}
        }
    }
    (allow, deny)
}

fn random_rows(rng: &mut Rng, num: u64, den: u64) -> Vec<Row> {
    let mut rows = Vec::new();
    for role in [0usize, 1, 2, 3, SO] {
        if rng.chance(num, den) {
            let (allow, deny) = random_masks(rng);
            if allow | deny != 0 {
                rows.push(Row { role, allow, deny });
            }
        }
    }
    rows
}

fn generate(seed: u64) -> Forest {
    let mut rng = Rng(seed | 1);
    for _ in 0..4 {
        rng.next();
    }
    let mut role_perms = vec![0i64; 6];
    let mut everyone = Permissions::DEFAULT_MEMBER;
    if rng.chance(1, 4) {
        everyone.remove(TESTED[1 + rng.below(5) as usize]);
    }
    role_perms[0] = everyone.bits() as i64;
    for r in 1..=3 {
        let mut p = Permissions::empty();
        for bit in TESTED {
            if rng.chance(1, 4) {
                p |= bit;
            }
        }
        role_perms[r] = p.bits() as i64;
    }
    role_perms[SO] = (Permissions::STREAM_ONLY | Permissions::VIEW_CHANNEL | Permissions::CONNECT | Permissions::STREAM).bits() as i64;
    role_perms[ADMIN] = Permissions::ADMINISTRATOR.bits() as i64;

    let mut users: Vec<Vec<usize>> = vec![vec![], vec![ADMIN], vec![SO], vec![SO, 1]];
    for _ in 0..5 {
        users.push((1..=3).filter(|_| rng.chance(1, 2)).collect());
    }
    users.push(vec![]); // a member with no role at all

    let n_coll = 2 + rng.below(2) as usize;
    let mut chans: Vec<Chan> = Vec::new();
    for i in 0..n_coll {
        let parent = if i > 0 && rng.chance(2, 3) { Some(rng.below(i as u64) as usize) } else { None };
        chans.push(Chan { kind: 2, parent, rows: random_rows(&mut rng, 1, 2) });
    }
    // A loop (the first collection under the last) now and then, a self-parent more rarely.
    if rng.chance(1, 6) {
        chans[0].parent = Some(n_coll - 1);
    } else if rng.chance(1, 30) {
        chans[0].parent = Some(0);
    }
    let n_kids = 4 + rng.below(3) as usize;
    for _ in 0..n_kids {
        let parent = if rng.chance(4, 5) { Some(rng.below(n_coll as u64) as usize) } else { None };
        let kind = if rng.chance(2, 5) { 1 } else { 0 };
        chans.push(Chan { kind, parent, rows: random_rows(&mut rng, 2, 5) });
    }
    Forest { role_perms, users, chans }
}

// ---------------------------------------------------------------- the oracle

type R = (bool, i64, i64); // (is_default, allow, deny)

fn layer_bit(base: bool, rows: &[R], bit: i64) -> bool {
    let (mut ea, mut ed, mut ra, mut rd) = (false, false, false, false);
    for &(d, a, x) in rows {
        if d {
            ea |= a & bit != 0;
            ed |= x & bit != 0;
        } else {
            ra |= a & bit != 0;
            rd |= x & bit != 0;
        }
    }
    let mut v = base;
    if ed {
        v = false;
    }
    if ea {
        v = true;
    }
    if rd {
        v = false;
    }
    if ra {
        v = true;
    }
    v
}

fn expected_bit(base: bool, chain: &[Vec<R>], own: &[R], bit: i64) -> bool {
    let mut denied = false;
    for rows in chain {
        let lifted = rows.iter().any(|r| r.1 & bit != 0);
        let mut eff = layer_bit(base, rows, bit);
        if denied && !lifted {
            eff = false;
        }
        denied = base && !eff;
    }
    let mut v = layer_bit(base, own, bit);
    if denied && !own.iter().any(|r| r.1 & bit != 0) {
        v = false;
    }
    v
}

/// The collections above `at`, outermost first, the nearest 8, a loop ending the walk.
fn chain_above(chans: &[Chan], at: usize) -> Vec<usize> {
    let mut seen = HashSet::from([at]);
    let mut up = Vec::new();
    let mut here = at;
    while up.len() < 8 {
        match chans[here].parent {
            Some(p) if seen.insert(p) => {
                up.push(p);
                here = p;
            }
            _ => break,
        }
    }
    up.reverse();
    up
}

fn rows_for(f: &Forest, ch: usize, user: usize) -> Vec<R> {
    f.chans[ch]
        .rows
        .iter()
        .filter(|r| r.role == 0 || f.users[user].contains(&r.role))
        .map(|r| (r.role == 0, r.allow, r.deny))
        .collect()
}

fn base_of(f: &Forest, user: usize) -> Permissions {
    let mut bits = f.role_perms[0];
    for &r in &f.users[user] {
        bits |= f.role_perms[r];
    }
    Permissions::from_bits_truncate(bits as u64)
}

// ------------------------------------------------------------------ database

struct Built {
    sid: String,
    user_ids: Vec<i32>,
    chan_ids: Vec<i64>,
}

async fn build(pool: &sqlx::PgPool, f: &Forest) -> Built {
    let mut user_ids = Vec::new();
    for i in 0..f.users.len() {
        let id = sqlx::query_as::<_, (i32,)>("INSERT INTO users (username, salt, verifier) VALUES ($1, '00', '00') RETURNING id")
            .bind(format!("df_{i}_{}", uuid::Uuid::new_v4()))
            .fetch_one(pool)
            .await
            .expect("user")
            .0;
        user_ids.push(id);
    }
    let sid = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO servers (id, name, owner_id) VALUES ($1, 'df-test', $2)")
        .bind(&sid).bind(user_ids[0]).execute(pool).await.expect("server");
    for &u in &user_ids {
        sqlx::query("INSERT INTO server_members (server_id, user_id) VALUES ($1, $2)")
            .bind(&sid).bind(u).execute(pool).await.expect("member");
    }
    let mut role_ids = Vec::new();
    for (i, &perms) in f.role_perms.iter().enumerate() {
        let (id,): (i64,) = sqlx::query_as("INSERT INTO server_roles (server_id, name, color, permissions, position, is_default) VALUES ($1, $2, '#99AAB5', $3, $4, $5) RETURNING id")
            .bind(&sid).bind(format!("role{i}")).bind(perms).bind(i as i32).bind(i == 0)
            .fetch_one(pool).await.expect("role");
        role_ids.push(id);
    }
    for (u, held) in f.users.iter().enumerate() {
        for &r in held {
            sqlx::query("INSERT INTO member_roles (server_id, user_id, role_id) VALUES ($1, $2, $3)")
                .bind(&sid).bind(user_ids[u]).bind(role_ids[r]).execute(pool).await.expect("assign");
        }
    }
    let mut chan_ids = Vec::new();
    for (i, c) in f.chans.iter().enumerate() {
        let id = sqlx::query_as::<_, (i32,)>("INSERT INTO channels (server_id, name, type) VALUES ($1, $2, $3) RETURNING id")
            .bind(&sid).bind(format!("c{i}")).bind(c.kind)
            .fetch_one(pool).await.expect("channel").0 as i64;
        chan_ids.push(id);
    }
    // Parents last, with raw SQL: this is how a loop or a self-parent gets in.
    for (i, c) in f.chans.iter().enumerate() {
        if let Some(p) = c.parent {
            sqlx::query("UPDATE channels SET parent_id = $1 WHERE id = $2")
                .bind(chan_ids[p] as i32).bind(chan_ids[i] as i32).execute(pool).await.expect("parent");
        }
        for r in &c.rows {
            sqlx::query("INSERT INTO channel_permission_overwrites (channel_id, role_id, allow, deny) VALUES ($1, $2, $3, $4)")
                .bind(chan_ids[i] as i32).bind(role_ids[r.role]).bind(r.allow).bind(r.deny)
                .execute(pool).await.expect("overwrite");
        }
    }
    Built { sid, user_ids, chan_ids }
}

async fn cleanup(pool: &sqlx::PgPool, b: &Built) {
    let _ = sqlx::query("DELETE FROM servers WHERE id = $1").bind(&b.sid).execute(pool).await;
    for &u in &b.user_ids {
        let _ = sqlx::query("DELETE FROM users WHERE id = $1").bind(u).execute(pool).await;
    }
}

/// What the bulk resolver says, every member x every channel.
async fn bulk_all(pool: &sqlx::PgPool, b: &Built) -> Vec<HashMap<i64, Permissions>> {
    let mut out = Vec::new();
    for &u in &b.user_ids {
        out.push(get_user_channels_permissions(pool, &b.sid, u as i64, &b.chan_ids).await.expect("bulk"));
    }
    out
}

fn dump(f: &Forest) -> String {
    format!("{f:#?}")
}

async fn check_world(pool: &sqlx::PgPool, seed: u64) -> Result<(), String> {
    let f = generate(seed);
    let b = build(pool, &f).await;
    let result = check_built(pool, &f, &b).await;
    cleanup(pool, &b).await;
    result.map_err(|e| format!("seed {seed:#x}: {e}\nforest: {}", dump(&f)))
}

async fn check_built(pool: &sqlx::PgPool, f: &Forest, b: &Built) -> Result<(), String> {
    let bulk = bulk_all(pool, b).await;
    let mut viewers: Vec<HashSet<i64>> = Vec::new();
    for &c in &b.chan_ids {
        viewers.push(get_channel_viewer_ids(pool, c, &b.sid).await.map_err(|e| format!("viewers: {e}"))?);
    }

    for (ci, &c) in b.chan_ids.iter().enumerate() {
        let chain: Vec<usize> = chain_above(&f.chans, ci);
        for (ui, &u) in b.user_ids.iter().enumerate() {
            let who = format!("user {ui} (roles {:?}) on channel {ci} (db {c}, kind {})", f.users[ui], f.chans[ci].kind);
            let single = match get_user_channel_permissions(pool, c, u as i64).await {
                ChannelPermAccess::Allowed { perms, .. } => perms,
                other => return Err(format!("{who}: not Allowed ({})", matches!(other, ChannelPermAccess::NotMember) as u8)),
            };
            let bulk_p = bulk[ui][&c];
            if single != bulk_p {
                return Err(format!("{who}: single {single:?} != bulk {bulk_p:?}"));
            }
            if single.has(Permissions::VIEW_CHANNEL) != viewers[ci].contains(&(u as i64)) {
                return Err(format!("{who}: VIEW {} but viewer-set membership {}", single.has(Permissions::VIEW_CHANNEL), viewers[ci].contains(&(u as i64))));
            }

            let base = base_of(f, ui);
            if ui == 0 || base.is_admin() {
                for bit in TESTED {
                    if !single.has(bit) {
                        return Err(format!("{who}: owner/admin lacks {bit:?}"));
                    }
                }
                continue;
            }
            if base.is_stream_only() {
                let allowed_bits = Permissions::STREAM_ONLY_CAP | Permissions::RESTRICTING;
                if f.chans[ci].kind != 1 && !single.is_empty() {
                    return Err(format!("{who}: a stream-only member resolves {single:?} in a non-voice channel"));
                }
                if !allowed_bits.contains(single) {
                    return Err(format!("{who}: a stream-only member exceeds the cap: {single:?}"));
                }
                if !single.is_empty() && !single.contains(Permissions::VIEW_CHANNEL | Permissions::CONNECT) {
                    return Err(format!("{who}: a stream-only member keeps {single:?} without View+Connect"));
                }
                continue;
            }

            // Ordinary member: the per-bit oracle, then the bits no overwrite touches.
            let chain_rows: Vec<Vec<R>> = chain.iter().map(|&a| rows_for(f, a, ui)).collect();
            let own = rows_for(f, ci, ui);
            for bit in TESTED {
                let want = expected_bit(base.contains(bit), &chain_rows, &own, bit.bits() as i64);
                if single.contains(bit) != want {
                    return Err(format!("{who}: bit {bit:?} resolver {} oracle {want} (base has it: {}); chain {chain:?}, rows above {chain_rows:?}, own {own:?}", single.contains(bit), base.contains(bit)));
                }
            }
            let untouched = Permissions::all() & !tested_mask();
            if single & untouched != base & untouched {
                return Err(format!("{who}: bits outside the overwritten six changed: {:?} vs base {:?}", single & untouched, base & untouched));
            }
        }
    }

    // Monotonicity: delete EVERY collection's rows and resolve again.
    let colls: Vec<i32> = f.chans.iter().zip(&b.chan_ids).filter(|(c, _)| c.kind == 2).map(|(_, &id)| id as i32).collect();
    sqlx::query("DELETE FROM channel_permission_overwrites WHERE channel_id = ANY($1)")
        .bind(&colls).execute(pool).await.map_err(|e| format!("delete collection rows: {e}"))?;
    let without = bulk_all(pool, b).await;
    for (ci, &c) in b.chan_ids.iter().enumerate() {
        if f.chans[ci].kind == 2 {
            continue;
        }
        for ui in 0..b.user_ids.len() {
            let with = bulk[ui][&c];
            let free = without[ui][&c];
            COMPARED.fetch_add(1, Ordering::Relaxed);
            if with != free {
                REMOVED.fetch_add(1, Ordering::Relaxed);
            }
            if !free.contains(with) {
                return Err(format!("MONOTONICITY: user {ui} (roles {:?}) on channel {ci}: with the collections' rows {with:?} is not a subset of without {free:?}", f.users[ui]));
            }
        }
    }
    Ok(())
}

#[tokio::test]
async fn the_three_resolvers_agree_over_random_forests_and_a_collection_only_removes() {
    let Some(pool) = crate::migrator::test_pool(4).await else { return };
    const WORLDS: u64 = 100;
    let worlds = WORLDS;
    let mut failures = Vec::new();
    for i in 0..worlds {
        let seed = 0x1234_5678_9abc_def1u64.wrapping_add(i.wrapping_mul(0x9e37_79b9_7f4a_7c15));
        if let Err(e) = check_world(&pool, seed).await {
            failures.push(e);
            if failures.len() >= 3 {
                break;
            }
        }
    }
    assert!(failures.is_empty(), "{} world(s) failed; first:\n{}", failures.len(), failures.join("\n\n"));
    let (compared, removed) = (COMPARED.load(Ordering::Relaxed), REMOVED.load(Ordering::Relaxed));
    eprintln!("differential: {worlds} worlds, {compared} (member, channel) pairs, {removed} where a collection removed something");
    assert!(compared > 0 && removed * 20 > compared, "the collections removed something from only {removed} of {compared} pairs: the run is too tame to mean anything");
}

/// Each tested bit must actually be removed by a collection in some generated
/// world, or the run above proves nothing about it (a generator that never denied
/// anything would pass).
#[test]
fn the_generator_exercises_denials_loops_and_nesting() {
    let (mut loops, mut nested3, mut denies, mut lifts) = (0, 0, 0, 0);
    for i in 0..400u64 {
        let f = generate(0x1234_5678_9abc_def1u64.wrapping_add(i.wrapping_mul(0x9e37_79b9_7f4a_7c15)));
        for ci in 0..f.chans.len() {
            let chain = chain_above(&f.chans, ci);
            if chain.len() >= 3 {
                nested3 += 1;
            }
            let mut seen = HashSet::new();
            let mut at = ci;
            while let Some(p) = f.chans[at].parent {
                if !seen.insert(p) {
                    loops += 1;
                    break;
                }
                at = p;
            }
        }
        for c in f.chans.iter().filter(|c| c.kind == 2) {
            for r in &c.rows {
                denies += (r.deny & Permissions::VIEW_CHANNEL.bits() as i64 != 0) as u32;
            }
        }
        for c in f.chans.iter().filter(|c| c.kind != 2 && c.parent.is_some()) {
            for r in &c.rows {
                lifts += (r.allow & Permissions::VIEW_CHANNEL.bits() as i64 != 0) as u32;
            }
        }
    }
    assert!(loops > 10 && nested3 > 100 && denies > 100 && lifts > 50, "loops {loops}, 3-deep {nested3}, collection View denies {denies}, child View allows {lifts}");
}

/// `PATCH /channels/:id` accepts a collection under a collection at any depth. A
/// walk limited to the nearest few would drop the OUTERMOST collection, which is the
/// one carrying the deny here; found by the independent review, fixed by walking
/// without a limit.
#[tokio::test]
async fn a_deny_on_a_collection_beyond_the_depth_limit_still_reaches_the_channel() {
    let Some(pool) = crate::migrator::test_pool(4).await else { return };
    let depth = 12;
    let mut chans: Vec<Chan> = (0..depth)
        .map(|i| Chan { kind: 2, parent: if i == 0 { None } else { Some(i - 1) }, rows: vec![] })
        .collect();
    chans[0].rows.push(Row { role: 0, allow: 0, deny: Permissions::VIEW_CHANNEL.bits() as i64 });
    chans.push(Chan { kind: 0, parent: Some(depth - 1), rows: vec![] });
    let mut role_perms = vec![0i64; 6];
    role_perms[0] = Permissions::DEFAULT_MEMBER.bits() as i64;
    let f = Forest { role_perms, users: vec![vec![], vec![]], chans };
    let b = build(&pool, &f).await;
    let kid = *b.chan_ids.last().unwrap();
    let seen = match get_user_channel_permissions(&pool, kid, b.user_ids[1] as i64).await {
        ChannelPermAccess::Allowed { perms, .. } => perms.has(Permissions::VIEW_CHANNEL),
        _ => false,
    };
    cleanup(&pool, &b).await;
    assert!(!seen, "the outermost collection denies View to @everyone, {depth} levels above the channel, and the member still sees it");
}

// --------------------------------------------------- claims the docs make, no database

const V: i64 = Permissions::VIEW_CHANNEL.bits() as i64;
const TEXT: ChannelKind = ChannelKind::Other;

/// The two levels are NOT layered as one channel is: the owner's rule is that the
/// channel's own allow, from any role of the member's or @everyone, takes a bit back
/// that a collection took (per bit; docs/USER_GUIDE.md says so). In ONE channel a
/// role's cross would beat @everyone's tick; across a collection and its channel
/// the child's @everyone tick restores the bit the collection crossed for the
/// member's role. Pinned so that it is a decision and not an accident.
#[test]
fn an_everyone_tick_on_the_child_restores_a_bit_the_collection_crossed_for_the_members_role() {
    let base = Permissions::DEFAULT_MEMBER;
    let role_denies: [OverwriteRow; 1] = [(0, V, false)];
    let everyone_ticks: [OverwriteRow; 1] = [(V, 0, true)];
    // The same two rows in ONE channel: the role's cross wins.
    let one_channel = layer_overwrite_rows(1, TEXT, base, &[role_denies[0], everyone_ticks[0]]);
    assert!(!one_channel.has(Permissions::VIEW_CHANNEL), "control: in a single channel the role's cross beats @everyone's tick");
    let across = layer_with_collections(1, TEXT, base, &[&role_denies], &everyone_ticks);
    assert!(
        across.has(Permissions::VIEW_CHANNEL),
        "the channel's own tick, from whichever role or @everyone, takes the bit back"
    );
}
