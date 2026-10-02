# Games — Poker and Blackjack in a voice call

Hold'em and Blackjack played with the people in your current voice call, for
free chips that exist only at that table. **The rules engine is built and
tested; nothing else is.** There is no server wiring, no protocol frame, no
permission bit, no setting and no UI yet — this page is the design for those
next steps, and the contract the engine already keeps.

| piece | state |
|---|---|
| Rules engine: `crates/puca-games` (Hold'em, Blackjack, evaluator, shuffle) | **built**, pure Rust, tested (below) |
| Server tables bound to a voice room, frames, timers, permissions | designed here, not built |
| Client table view, desktop + 390x844 phone | designed here, not built |

## Owner decisions (fixed)

- **The server deals.** It shuffles with the OS CSPRNG, holds the hidden
  cards, and sends each player only their own. Clients send intents; the
  server's engine decides what is legal.
- **Free chips per table.** Everyone sits down with the same stack. Nothing
  persists when the table closes. Chips can never be bought, sold,
  transferred outside play, or exchanged for anything, and there are no
  prizes. **No real money, ever.**
- **One table per call.** A voice call holds at most one game table at a
  time, of either game. Opening a second one — another Poker table, or
  Blackjack beside Poker — is refused with a clear message ("a Poker table is
  already open in this call; it has to close before another game can start")
  until the first closes.

The second point is also the legal line. Gambling is, almost everywhere,
consideration + chance + prize; with no money in and nothing of value out it
is a game. It is also why chip balances must not persist: poker moves chips
between players by design, so with lasting balances losing on purpose to a
friend (chip-dumping) *is* a transfer, and the "no transfer" rule would stop
being enforceable.

## Defaults (changeable)

The lead chose these; each is a field of `HoldemConfig` / `BlackjackConfig`
in the engine, so changing one is a one-line decision, not a rewrite.

| | default | field |
|---|---|---|
| Poker variant | No-Limit Texas Hold'em, cash table | — |
| Seats | 6 (fits a phone; engine allows 2–9) | `max_seats` |
| Starting stack | 1,000 | `starting_stack` |
| Blinds | 5 / 10 | `small_blind`, `big_blind` |
| Who sets stack/blinds | the opener, before the first hand; locked after | `configure()` returns `ConfigLocked` once a hand was dealt |
| Odd chip of a split pot | first winner left of the button | — |
| Turn clock | 30 s; on expiry check if free, else fold | `turn_clock_secs` |
| Clock expiries in a row before sitting out | 2 | `timeouts_before_sit_out` |
| Leaving | between hands any time; mid-hand = fold now, seat freed when the hand ends | — |
| Coming back | you get the stack you left with (leaving is never a refill) | — |
| Busted player | may take a fresh starting stack | `allow_rebuy` |
| Blackjack | against the house only | — |
| Shoe | 6 decks, reshuffle at the cut card (75%), never mid-round | `decks`, `penetration_percent` |
| Dealer soft 17 | stands (S17) | `dealer_hits_soft_17` |
| Blackjack pays | 3:2, odd bets rounded down (15 pays 22) | `blackjack_pays` |
| Double | on any first two cards | — |
| Double after split | yes | `double_after_split` |
| Split | any two equal-value cards (10-J-Q-K equal), up to 4 hands | `max_hands` |
| Split aces | one card each, no resplit | `resplit_aces` |
| Insurance, surrender | none | — |
| Dealer peek | with an ace or ten-value up card | — |
| Blackjack bets | min 10, max 500 | `min_bet`, `max_bet` |

## Trust: what the server can see

**The server deals, so whoever runs it could technically see the cards.** A
modified client cannot cheat — it never receives another player's hidden
card, cannot act out of turn, and cannot invent chips — but the operator, or
anyone with root on the server or a patched backend, can read live hole
cards and the rest of the deck out of memory. On a friends' server the owner
is often also a player. That is said plainly, twice:

- in the table, the first time someone sits down: *"Chips are free and worth
  nothing. This server deals the cards and its operator could see them."*
- in `docs/SECURITY_MODEL.md` §2 (*What the server operator can see*), when
  the server half ships.

What the server learns that it did not already know: who sat at a table and
how chips moved — in memory only, gone when the table closes, consistent with
Clips' rule of no durable record of who was in which call.

**No commit-reveal in v1.** A "provably fair" scheme (the server commits to a
seed, players add nonces, the seed is revealed after the hand) was considered
and dropped for v1 because the obvious version is unsound here:

- *Grinding.* The server sees players' nonces before it must deal; a seated
  operator could choose their own nonce last. Every player would have to
  commit to `H(nonce)` before anyone reveals, and every client would have to
  check the full nonce set, including whose nonce was ruled missing and why.
- *It leaks mucked hands.* Revealing the seed and nonces lets every client
  recompute the whole deck, including folded and mucked cards — breaking the
  "a mucked hand is never shown" promise below. The alternative (salted
  per-card commitments, reveal only shown cards) proves no card was
  substituted, not that the shuffle was uniform.
- Neither stops the operator *peeking*, which is the realistic threat.

If it is ever added, it drives the SAME shuffle (`rng::shuffle` over a
committed stream instead of the OS), so the uniformity test still covers the
shipped code. Operator-proof dealing (cryptographic "mental poker") was
measured at ~93 ms per player per deck pass on this desktop *without* the
zero-knowledge shuffle proof that makes it safe; with the proof, on phones,
every hand would wait seconds on the slowest player. Not planned.

## The engine: `crates/puca-games`

Pure and deterministic: no I/O, no async, no clock, no randomness of its own.
The workspace's `crates/*` glob makes it a member; its only dependency is
`rand` 0.8, already in the lockfile for the backend.

- **RNG injected.** Every shuffle takes a `GameRng` (anything yielding uniform
  `u64`s). Production passes `rng::os_rng()` (getrandom); tests pass
  `rng::seeded(n)`, so every test hand replays from its seed. The shuffle is
  our own Fisher-Yates over `rng::below`, which rejection-samples instead of
  `x % n` (no modulo bias).
- **Fixed-width cards.** A card is one byte (`rank * 4 + suit`) and always
  two ASCII characters on the wire — `Ah`, `Td`, `2c`, never `10h` — so a
  frame's length never depends on which card it carries. A face-down card is
  `??`.
- **Typed actions and errors.** `Action::{Fold, Check, Call, BetOrRaiseTo(n),
  AllIn}` (amounts are street totals, so a retransmit cannot double-count);
  errors like `NotYourTurn`, `StaleTurn`, `CannotCheck { to_call }`,
  `BetBelowMinimum { min_to }`, `RaiseNotReopened`. An `Err` never changes
  the table.
- **`TurnRef { hand_no, turn_seq }`** names one decision. Client actions and
  turn-clock expiries both carry it; a stale one is refused, so a delayed
  "Call 10" cannot land on a later "Call 500" and a timer that fires after
  the player acted is a no-op.
- **Events are public; views are per seat.** Every method returns
  `Vec<Event>` that may go to everyone at the table — no event carries a
  hidden card except `Showdown`/`Shown`, which reveal exactly the shown
  hands. Hidden cards leave the engine only through
  `HoldemTable::view_for(Some(seat))`: that seat's own hole cards, plus hands
  that were shown. `view_for(None)` is the spectator view. A view is keyed on
  the player who was *dealt* the hand, so whoever sits in the seat next never
  sees the previous occupant's cards. Blackjack has one public view; the hole
  card is `None` until the dealer turns it.
- **Redacted `Debug`.** Formatting a table prints no card, so a stray log
  line cannot leak the deck.
- **One table per call, in the type.** `registry::RoomTables` is keyed by
  room, so a second table for a room has nowhere to go: `open` returns
  `OpenError::RoomHasTable { open, kind }` (whatever game is open) and changes
  nothing. It also holds the server-wide cap (`TooManyTables`) and gives each
  table a `TableId` that is never reused, so a frame or a moderator's close
  aimed at a table that has closed cannot land on the one that replaced it
  (`get_mut(room, id)`, `close(room, id)`); `close_room` and `close_where`
  are the teardown paths. Ids count up from a seed the server picks at
  random (below 2^53, so a JavaScript client holds them exactly), so an id
  a client kept from before a restart does not name a new table.

### Hold'em rules as implemented

Moving button (no dead button). Heads-up the button posts the small blind,
acts first preflop and last after the flop. A short blind is all-in for what
it has and the others still owe the full big blind. Minimum bet = big blind;
a raise must be at least the largest full raise of the street. An all-in for
less is an *incomplete* raise: it does not change the minimum and does not
reopen the betting to a player who already acted — unless several short
all-ins add up to a full raise since they acted. Uncalled chips go back
first; the rest splits into a main pot and side pots by contribution level;
folded players' chips stay in the level they reached. Showdown: the last
river aggressor shows first, else the first live seat left of the button;
each later player shows only a hand that beats or ties the best shown so far
and otherwise mucks — and a mucked hand is never revealed. With anyone
all-in, every live hand is tabled. After a hand, anyone dealt in may show
voluntarily. Odd chips go one at a time from the left of the button. No burn
cards (with a uniform shuffle they change nothing).

### What the tests prove

`cargo test -p puca-games` (about 10 s; the crate is built with `opt-level =
3` even in test builds — root Cargo.toml):

- **Evaluator known answers**, from published combinatorics: all 2,598,960
  five-card hands give straight flush 40 (4 royal), quads 624, full house
  3,744, flush 5,108, straight 10,200, trips 54,912, two pair 123,552, pair
  1,098,240, high card 1,302,540, and exactly 7,462 distinct values; a second,
  independent five-card evaluator agrees on every hand; all 20,358,520
  six-card hands match their published counts; 200,000 seeded seven-card
  hands equal the best of their 21 five-card subsets. The full 133,784,560
  seven-card enumeration is an ignored test
  (`cargo test -p puca-games --release -- --ignored`, ~35 s) and matches.
- **Shuffle**: a chi-square over the 52x52 card-by-position table, with
  Sattolo's off-by-one shuffle as the positive control it must reject; exact
  tests that the rejection sampler throws the biased tail away.
- **Hold'em on stacked decks**: heads-up and 3+ handed blind order and
  rotation, min-raise, incomplete all-ins that do and do not reopen, three
  all-ins of different sizes (main pot + two side pots + uncalled return),
  odd chips, short big blind, showdown order and mucking, timeouts and
  stale timers, leaving mid-hand, rebuys, config lock.
- **Hold'em at random**: 3,000+ seeded hands with random legal actions,
  refused illegal ones, timeouts, departures and rebuys. After every
  operation: chips conserved; no view (and no event) holds a card other than
  the viewer's own, the board and shown hands; no card dealt twice; a refused
  action changed nothing. The run fails if it never exercised side pots,
  split pots, incomplete raises, timeouts or departures.
- **One table per call**: a second table of either game is refused and the
  first is untouched; other calls are independent; a stale id cannot reach or
  close a newer table; the cap refuses without changing anything.
- **Blackjack**: 3:2 (and rounding), S17 vs H17 on soft 17, hard 16/17,
  peek with dealer blackjack, split aces, DAS on/off, four-hand split limit,
  double, bust-before-dealer, push, auto-stand on 21, limits, timeouts,
  leaving mid-round, the hole card staying hidden, the 6-deck shoe and its
  cut card. A random run of ~3,000 rounds checks chips and every card of the
  shoe after every operation, including mid-round refills from the discard
  tray.

## Server design (next step, not built)

### Tables live in the voice room

A table is bound to the voice room `voice_<channel_id>` and lives in memory
in `AppState`, in the engine's `RoomTables` keyed by room — **one table per
call, of either game** (the owner's rule: `GameCreate` in a call that already
has a table is answered with the `RoomHasTable` message and nothing opens), a
global cap of 500 (the same pattern as `CLIP_MAX_LIVE_PROPOSALS`), and a
creation rate limit (5 per 5 minutes per user, the clip-rate pattern). The
engine is synchronous: the registry sits behind a plain mutex held only to
open, close or look up a table, and each table behind its own plain mutex
held only for an engine call — never across an `.await`, and never both at
once (look the table up, drop the registry lock, then lock the table). The
client offers "Open a table" only while the call has none, and otherwise
"Join the table".

**Lock order:** never take a `state.rooms` guard while holding a table lock,
and never lock a table while holding a `rooms` guard (`evict_sweep` already
warns that holding DashMap guards across awaits risks shard deadlocks).
Read what you need from the room, drop the guard, then lock the table.

**Restart ends every table.** That includes every backend deploy. A
`GameResync` for a table the server does not know is answered with
`GameEnded { reason: "server_restarted" }`, never an error, and the client
clears its stale table with that message.

### Who is in the room: `conns_of`, never `joined_rooms`

Every game frame — create, sit, act, resync, and above all a resync that
re-sends private cards — checks membership as
`state.rooms.get(room).conns_of(user)` containing this `conn_id`, **under
the room guard**. Not the socket's `joined_rooms`: that set is local to one
socket task, and `evict_user_from_voice_room` (kick, move, the permission
sweep, voice exclusivity on the user's other device, AFK) runs on another
task and cannot update it — a kicked connection keeps `joined_rooms` until it
sends `LeaveRoom` itself. Test: evict user A, then A's stale connection sends
`GameResync` and gets no hole cards and no seat.

An SFU participant whose WebSocket never rejoined `voice_<cid>` is not a
member and cannot play; the UI must not offer them a seat.

### Fan-out: per connection, over `Room.member_conns`

Public frames go to every connection in `Room.member_conns`; a player's
private view goes to **their** connections in that room only — both with
`send_to_conn`. Never `send_to_user` or `broadcast_to_room` (which calls
`send_to_user`): those reach every session the user has, including the
Android delivery socket and devices not in the call, so a busy table would
keep waking a phone in someone's pocket. Two devices of one user in the room
both get that seat's private view; actions are sequenced per seat by
`TurnRef`, so a double submit is a harmless `StaleTurn`.

### Frames

Client: `GameCreate { room_id, kind, config }`, `GameSit { table_id, seat }`,
`GameAct { table_id, turn, action }` (the `TurnRef` it was shown),
`GameStand { table_id }`, `GameResync { table_id }`.
Server: `GameTable { table_id, version, view }` (the per-connection view —
`view_for(seat)` for a seated player, `view_for(None)` for everyone else),
`GameEvents { table_id, version, events }`, `GameEnded { table_id, reason }`.
Every frame carries `version`; a client that sees a gap sends `GameResync`
(`try_send` drops frames under backpressure). The client also sends
`GameResync` automatically after `RoomJoined` for a voice room: a reconnect
gets a NEW `conn_id`, so private cards sent to the old one are gone. Resync
is throttled per connection (one a second) so it cannot be used to pull full
snapshots at the general 50/s message rate. Frames carry no free text — no
chat-injection or amplification lever. All of them go in
`docs/API_REFERENCE.md`'s WebSocket section when they exist.

### Leaving, disconnects and the grace

**Membership removal on disconnect is immediate.** `unregister_session`
calls `remove_member_conn` for every room and then `drop_room_if_empty` at
once; the 8 s rejoin grace (`WS_REJOIN_GRACE_SECS`) only delays the
*announcements* (`src/ws.rs`, *REJOIN GRACE*). A game that folded a player on
membership removal would fold them on every network blip, lid close or
missed WebView heartbeat — and a blip by the only person left (a solo
Blackjack player, both heads-up players during a server hiccup) would empty
the room and destroy the table. So:

- each seat gets its own **disconnect grace**: on departure the seat is
  stamped `disconnected_since`; if the player is back in the room within
  `WS_REJOIN_GRACE_SECS` the seat, stack and hole cards are untouched (and
  resync re-sends the cards to the new connection). Only after the grace does
  the server call the engine's `leave(seat)` (fold now, seat freed at hand
  end; Blackjack: stand every hand);
- the **turn clock keeps running** during the grace: a disconnected player
  whose turn it is gets the clock's check-or-fold like anyone else;
- an **empty room destroys its tables only after one grace** and a re-check.

**Where the departure hook goes.** Not inside `Room::remove_member`: `Room`
is a plain struct stored inside the `rooms` DashMap, `remove_member` is
synchronous with no `AppState`, and it runs under a shard write lock
(`unregister_session` holds `rooms.iter_mut()` across its whole loop). It
cannot reach the tables without awaiting under a guard or inverting the lock
order. Instead `remove_member` records the departing user in a small
per-room list (a field of `Room`, like `presence_log`), and every caller
drains it after dropping its guard and hands it to the games layer — the same
shape as `orphan_presence_logs`. Done that way no mutator can forget the
hook. A test walks every mutator: `LeaveRoom`, disconnect
(`unregister_session`), `evict_user_from_voice_room` (kick, move, permission
sweep, exclusivity, AFK) and `drop_room_if_empty`.

**Timers.** One task per awaited decision, carrying `(table_id, TurnRef)`.
On firing it locks the table and calls `timeout(turn)`; a `StaleTurn` means
the player already acted and is a no-op, so timers never need exact
cancellation. A destroyed table is marked closed and its timers hold only a
weak reference, so they die with it. The next hand starts ~3 s after
`HandEnded` when two players can be dealt; Blackjack deals when every seated
player has bet, or 15 s after the first bet.

### Gating and permissions

- **`servers.games_enabled BOOLEAN NOT NULL DEFAULT FALSE`** — off by
  default, like `clips_enabled`. Toggled by the owner in Server Settings
  (next to Clips; owner-only like it), and plumbed through the server-row
  SELECTs (server and invite handlers), the `Server` struct, the update
  handler and the client `Server` type. Migration number: next free at merge
  time (072 today; other branches ship migrations too, and `dual-ship.sh`
  byte-matches them on every host).
- **`PLAY_GAMES = 1 << 28`** in `src/permissions.rs` (the next free bit;
  `1 << 28` is still safe with JS `<<`, bit 31 would not be), in
  `DEFAULT_MEMBER` so new servers have it, and a backfill migration ORing it
  onto every existing @everyone role (the pattern of migrations 051/056).
  `OVERWRITABLE` derives from `Self::all()`, so per-channel overwrites cover
  it automatically. Client: BOTH maps in `frontend/src/api/permissionBits.ts`
  (`PERM` for gating, `PERMISSIONS` for the role editor), the role editor
  list, and `VOICE_CHANNEL_PERMS` in the channel editor — it is a voice-only
  bit.
- **Capability detection**: a `gamesSupported` flag like `clipsSupported`,
  so a new client on an old server hides the feature instead of sending a
  frame the old server answers with "Invalid message format".
- **Who may open a table / sit**: anyone in the call holding `CONNECT` and
  `PLAY_GAMES`. **Moderators with `MOVE_MEMBERS`** may close a table or remove
  a player (the engine's `leave`).
- **The permission sweep** (`evict_sweep`) resolves `CONNECT` and `SPEAK` and
  evicts from rooms; standing a player up on losing `PLAY_GAMES` while they
  stay in the call is a NEW branch there, under its per-server lock and epoch
  ordering. On the sweep's "scope unknown" path (a database error), a
  game-only revocation can wait for the retry — the worst case is finishing a
  hand.
- **Teardown**: switching `games_enabled` off ends every table on that server
  (`GameEnded { reason: "disabled" }`); deleting a channel ends its tables
  (beside the clip-channel cleanup in `delete_channel`).

## The table on screen (not built)

A new `viewMode: 'table'` rendered as content inside `.chat-main`, next to
VoiceStage, opened from a Games button in the VoiceStage header and the
VoicePanel overflow. Like VoiceStage it is presentation only: opening or
leaving it never touches the call. Cards and suits are SVG from
`frontend/src/components/Icons.tsx`; no emoji suits (`npm run lint` fails on
emoji in chrome). Spectators — people in the call who are not seated — see
the public table.

**Phone, 390x844** (`docs/DESIGN_PHILOSOPHY.md` is the contract): content in
`.chat-main` inherits the panel transforms, but the voice panel's reserved
space leaves roughly 500–560 px. So: at most 6 seats; opponents as a compact
strip (avatar, stack, status) that scrolls sideways; board and pot in the
middle; your cards and a **two-row action bar** at the bottom — Fold /
Check-or-Call / Raise on one row, raise presets (min, ½ pot, pot, all-in)
and a stepper on the other. Every target at least 44 px, nothing hover-only.
The numeric raise field (≥16 px font, DESIGN_PHILOSOPHY §5) opens the
soft keyboard, which shrinks the viewport over the action bar: the raise
amount is edited in a sheet that rides above the keyboard (`visualViewport`),
and the walk must cover keyboard-open. A backgrounded phone gets no "your
turn" alert — the delivery socket ignores game frames — so v1 accepts the
clock's check-or-fold and says so at the table; a content-free doorbell like
`ClipPending` is the later option. The walk joins the existing family
(modelled on `frontend/e2e/clips-mobile-walk.mjs`): both tables at 390x844
with a coarse pointer, plus a 460 px overflow injection measured with
`clientWidth`, not `innerWidth`.

Surfaces: desktop, web and the Android app all run the same bundle, so the
client ships by signed OTA with no new APK; Lite gets it too (nothing depends
on remote control). Púca Notes has no calls and is unaffected.

## Not in v1

Persistent chip balances (see the chip-dumping point above); tournaments and
rising blinds; Omaha and limit games; insurance and surrender; a player as
the Blackjack bank; commit-reveal fairness; operator-proof dealing. And never
anything that turns chips into money.

## Size of the rest

The skeptic's estimate stands: the server half (registry, frames, seat grace,
departure drain, sweep branch, setting plumbing, teardown, docs) and the
client half (two tables, desktop and phone, walks) are about 12–18 working
days on top of this engine, including the adversarial review rounds this
repo requires.
