# Games — Poker and Blackjack in a voice call

Hold'em and Blackjack played with the people in your current voice call, for
free chips that exist only at that table. **The rules engine, the wire
contract and the client (both tables, desktop and phone, the owner's toggle)
are built and tested; the server half that deals is not yet.** There is no
server table, handler or timer yet — this page is the design for that step,
and the contract the engine, the frames and the client already keep.

| piece | state |
|---|---|
| Rules engine: `crates/puca-games` (Hold'em, Blackjack, evaluator, shuffle) | **built**, pure Rust, tested (below) |
| Wire contract: every frame, view, event, refusal and end reason; the `games` capability; fixtures both sides parse (*Frames*, below) | **built**, tested; the server does not confirm `games` yet (`GAMES_SERVED = false`) |
| `PLAY_GAMES` (1 << 28) and `servers.games_enabled` (migration 073, default off) | **built**; the client's toggle writes it, the server does not read it yet |
| Server tables bound to a voice room, handlers, timers, the toggle | designed here, not built |
| Client table view, desktop + 390x844 phone; the owner's toggle; `PLAY_GAMES` in the role and channel editors | **built** (*The table on screen*, below); waits for the server half to be served |

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
| Shoe | 6 decks, reshuffle at the cut card (75%), never mid-round — except that if one round empties the shoe, the discard tray is shuffled back in | `decks`, `penetration_percent` |
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
all-ins add up to a full raise since they acted. When everyone else still
in is all-in, nobody could answer a raise: the one player who can still act
gets a turn only if facing more than they have put in, and may then only
call or fold — and a player who already covers every all-in (a small blind
against a big blind all-in for less) gets no turn at all, so the turn clock
can never fold chips that already cover the pot. Uncalled chips go back
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
  odd chips, short big blind, a player who covers every all-in getting no
  turn (heads-up, after folds, and after a departure), call-or-fold only
  against a bigger all-in, showdown order and mucking, timeouts and stale
  timers, leaving mid-hand, rebuys, config lock.
- **Hold'em at random**: 3,000+ seeded hands with random legal actions,
  refused illegal ones, timeouts, departures and rebuys. After every
  operation: chips conserved; no view (and no event) holds a card other than
  the viewer's own, the board and shown hands; no card dealt twice; a turn
  is only ever given when there is something to decide (never to a player
  who covers every all-in, never with a raise nobody could answer); a refused
  action changed no view (the engine validates before it mutates). The run fails if it never exercised side pots,
  split pots, incomplete raises, timeouts, departures or a call-or-fold
  turn against a bigger all-in.
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
`GameResync` (or any frame) for a table the server does not know is answered
with `GameEnded { reason: "gone" }`, never an error, and the client clears its
stale table with that message. (The first sketch called the reason
`server_restarted`; the server cannot tell a restart from a table that closed
while the client was not listening, so the code says only what it knows.)

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

**This is the contract** both halves build against, and it is built and
tested: `src/games_wire.rs` (the pieces: views, events, refusals, the
conversions from the engine) and the `Game*` variants of `src/protocol.rs` on
the server; `frontend/src/api/games/protocol.ts` (types, `gameFrames.*`
builders, `parseGameFrame`, `versionStep`) on the client. Both are pinned to
ONE set of files, `frontend/src/tests/fixtures/games/*.json` — the server by
`protocol::games_frame_tests`, the client by `gamesProtocol.test.ts`:

| fixture | holds |
|---|---|
| `client-frames.json` | every client frame (every action once); the client's builders must produce exactly these values, the server must parse each as itself |
| `holdem-table-seated.json` | `GameTable` for the seat to act on the flop: its own two cards, everyone else `["??","??"]`, `legal`, a clock, one seat `away` |
| `holdem-table-spectator.json` | the same moment for a spectator: no card but the board |
| `holdem-events.json` | `GameEvents`: a sit, the deal, the flop, a showdown that shows two hands and mucks one, and the mucked hand shown voluntarily after |
| `blackjack-table.json` | `GameTable` mid-round: the hole card `"??"`, `legal` for the player to act |
| `blackjack-events.json` | `GameEvents`: a bet with the deal countdown, the deal (hole card dealt as `"??"`), a hit, the last bust with the reveal and the round's end |
| `refusals.json` | `GameRefused`: every code once, every op at least once |
| `ended.json` | `GameEnded`: every reason once |

The table fixtures are not hand-written: they are what real engine tables,
dealt from a fixed seed, serialise to. After a deliberate contract change,
`PUCA_WRITE_GAME_FIXTURES=1 cargo test games_frame_tests` rewrites them, and
the client's tests then say what the change broke.

#### Capability

The 0.9.832 handshake, unchanged in shape:

- The client puts `games` in its ONE caps list — `CLIENT_CAPS` in
  `frontend/src/api/websocket.ts`, sent as `/ws?caps=own_voice,presence,games`.
  Never a second `caps=` (it fails the upgrade); `check-docs-consistency.mjs`
  rule 14 pins every documented `caps=` to that list.
- The server reads it with the one tokeniser (`presence::ClientCaps`,
  `CAP_GAMES`), records it per connection (`Session.games`,
  `AppState::set_conn_games`, never for a delivery socket) and answers
  `AppState::conn_plays_games(user, conn)`. **Game frames go only to
  connections for which that is true** — and, of those, only to the ones in
  the call (`Room.member_conns`), each with `send_to_conn`.
- The server confirms `games` in `ServerFeatures` only when it plays games:
  `games_wire::GAMES_SERVED`, **false** in the contract commit and flipped by
  the commit that adds the handlers. The client sends a game frame only
  after `wsClient.hasServerFeature('games')` on THIS socket (a reconnect can
  reach an older host).
- That says the server build can play. Whether this server's owner turned
  games on is `games_enabled` (on the `Server` object, server half). The
  client offers a table only with the feature, `games_enabled`, `CONNECT` +
  `PLAY_GAMES` in that channel, and the person in the call.

#### Shared rules

- Envelope as every frame: `{"type": "<Variant>", "payload": {...}}`.
- `room_id` is the call, `voice_<channel_id>`, in EVERY frame both ways. The
  engine's registry is keyed `(room, id)`; a frame naming both is resolved
  with `get_mut(room, id)`, and membership is checked against that room.
- `table_id`: an integer in `1..2^53`, from a per-process random seed, never
  reused while the process lives (`registry::RoomTables`). A JavaScript
  number holds it exactly.
- Cards: always two characters, rank then suit (`Ah`, `Td`, `2c`; ten is `T`,
  never `10`). `"??"` is a face-down card and appears ONLY as a Hold'em
  seat's `cards` (`["??","??"]`: in the hand, not yours, not shown), as the
  Blackjack dealer's hole card in `view.dealer`, and as the card of a
  `card_dealt` to the dealer. Anywhere else it is junk.
- Seats are 0-based indexes. `user_id` is the server's user id
  (`games_wire::player_id` / `user_of` map it to the engine's `PlayerId`).
- Every number is a non-negative safe integer except `user_id` (the server's
  `i64`). Counters (`version`, `hand_no`, `round_no`, `turn_seq`) count one
  per action; stacks are capped at 10^9.
- No free text anywhere: card codes, enum names and numbers. The client
  words every code itself; nothing is rendered as HTML.
- Unknown fields are ignored both ways, so either side can grow.

#### Client → server

Sent only after the server confirmed `games` on this socket.

| frame | payload (besides `room_id`) | who | engine call |
|---|---|---|---|
| `GameCreate` | `kind` (`"holdem"`/`"blackjack"`), `config` (optional object) | in the call, `CONNECT` + `PLAY_GAMES` | `RoomTables::open` + `HoldemTable::new` / `BlackjackTable::new` |
| `GameSit` | `table_id`, `seat` | same | `sit(seat, player)` |
| `GameStand` | `table_id` | seated | `leave(seat)` — get up from the table (NOT the Blackjack action `stand`) |
| `GameAct` | `table_id`, `turn` `{hand_no, turn_seq}`, `action` | seated, their turn | `act(seat, turn, action)` |
| `GameBet` | `table_id`, `amount` | seated, Blackjack, between rounds | `place_bet(seat, amount)` |
| `GameClearBet` | `table_id` | same | `clear_bet(seat)` |
| `GameSitOut` | `table_id` | seated | `sit_out(seat)` |
| `GameSitIn` | `table_id` | seated | `sit_in(seat)` (also after the clock sat you out) |
| `GameRebuy` | `table_id` | seated, busted | `rebuy(seat)` |
| `GameShowCards` | `table_id` | seated, Hold'em, after the hand | `show_cards(seat)` |
| `GameResync` | `table_id` | in the call | none: answers `GameTable` (or `GameEnded gone`) |
| `GameClose` | `table_id` | in the call, `MOVE_MEMBERS` | `RoomTables::close(room, id)` |
| `GameRemovePlayer` | `table_id`, `seat` | in the call, `MOVE_MEMBERS` | `leave(seat)` |

`config` — every field optional, defaults are the owner's table
(`HoldemConfig::default()` / `BlackjackConfig::default()`); only the stack and
stakes are the opener's: `starting_stack` (both), `small_blind` and
`big_blind` (Hold'em), `min_bet` and `max_bet` (Blackjack). A field of the
other game is refused (`invalid_config`), not ignored; the engine's
`validate()` decides the rest (`GameConfigWire::holdem` / `::blackjack`).
There is no frame to change the settings after opening (the engine's
`configure()` is not exposed in v1): close and reopen.

`action` — `{"type":"fold"}`, `check`, `call`,
`{"type":"bet_or_raise_to","amount":60}` (the street TOTAL, never an
increment), `all_in` for Hold'em; `hit`, `stand`, `double`, `split` for
Blackjack. An action of the other game is `wrong_game`.

`turn` is the `view.turn` the client was shown; a delayed or double submit is
`stale_turn`, which the client drops silently.

The **disclosure** — *"Chips are free and worth nothing. This server deals
the cards and its operator could see them."* — is the client's to show before
a person's first `GameSit`; the server does not track it.

#### Server → client

All four go to one connection at a time with `send_to_conn`, only to
connections that announced `games` (*Capability*). Watching needs nothing but
being in the call: every such connection there gets the table (a spectator
view unless it is seated); `PLAY_GAMES` gates opening and sitting, not
watching. Leaving the call (`LeaveRoom`, a `RoomLeft`, a `VoiceMoved`) sends
no `GameEnded`: the client drops that call's table itself, because the server
stops sending to a connection the moment it is no longer in the room.

- **`GameTable { room_id, table_id, version, view }`** — the whole table as
  THIS connection may see it. Sent: to everyone in the call when a table
  opens (version 1); to a connection right after its `RoomJoined` for a call
  that has a table (a newcomer learns of it without knowing its id); in
  answer to `GameResync`; and to everyone, with `version` + 1, when the table
  changed without an engine event (a seat's `away` flag, a deal countdown
  starting).
- **`GameEvents { room_id, table_id, version, events, view }`** — one engine
  call that returned events: `events` is that call's public list, identical
  for everyone, and `view` is the table AFTER it for this connection.
  `version` is exactly one more than before the call. An engine call that
  returns no events (a no-op `sit_out`) sends nothing and keeps the version.
- **`GameEnded { room_id, table_id, reason }`** — the table is gone; drop it
  and say why. Also the answer to ANY frame naming a table that is not open
  in that room.
- **`GameRefused { room_id, table_id, op, code, ... }`** — a frame from this
  connection was refused, to this connection only. `room_id` and `table_id`
  echo the refused frame's (`room_id` may then be anything the client sent —
  `not_a_voice_room` is exactly that case; `table_id` is `null` for a
  refused `GameCreate`); `op` names the frame (`create`, `sit`, `stand`,
  `act`, `bet`, `clear_bet`, `sit_out`, `sit_in`, `rebuy`, `show_cards`,
  `resync`, `close`, `remove_player`); `code` and any numbers it carries are
  flattened into the payload. Expected refusals are ALWAYS this, never the
  generic `Error` the client shows as an alert; `Error` remains only for a
  frame that does not parse (a broken client).

**Views** (`view.game` tags them). Field by field in
`frontend/src/api/games/protocol.ts` (`HoldemView`, `BlackjackView`) and in
the fixtures. Hold'em: `viewer_seat` (`null` = spectator), `config`,
`hand_no`, `in_hand`, `street`, `button`, `small_blind_seat`,
`big_blind_seat`, `seats` (exactly `config.max_seats` entries, `null` =
empty; each `seat`, `user_id`, `stack`, `status`, `street_commit`,
`hand_commit`, `cards`, `sitting_out`, `leaving`, `away`), `board`,
`pot_total`, `current_bet`, `to_act`, `turn`, `legal` (only in the view of
the seat to act), `clock_ms`, `next_deal_in_ms`. A seat's `cards`: `null`
(not in the live hand, folded, or between hands with nothing shown),
`["??","??"]` (in the hand, face down), or real codes (the viewer's own
hand, or a shown one). Blackjack: `viewer_seat`, `config` (incl.
`blackjack_pays: [3,2]`), `round_no`, `in_round`, `seats` (each with
`pending_bet` and `hands`: `cards`, `bet`, `doubled`, `from_split`, `total`,
`soft`, `done`, `outcome`, `returned`), `dealer` (hole card `"??"`),
`dealer_total` (`null` until the reveal), `to_act` `{seat, hand}`, `turn`,
`shoe_remaining`, `shoe_size`, `reshuffle_due`, `legal` (only for the seat to
act), `clock_ms`, `next_deal_in_ms`. `clock_ms` / `next_deal_in_ms` are
RELATIVE milliseconds (like Clips' `*_in_ms`), so clock skew cannot shift
them; `away` marks a seat inside the disconnect grace.

**Events** (`type`-tagged, the engine's events one for one):
Hold'em `player_sat`, `player_left`, `sat_out` (`reason`: `requested`,
`timeouts`, `busted`), `sat_in`, `rebought`, `hand_started`,
`blind_posted`, `acted` (`kind`: `fold`/`check`/`call`/`bet`/`raise`;
`reason`: `player`/`timeout`/`left`), `board_dealt`, `uncalled_returned`,
`showdown` (`shown`: `{seat, cards, category}` in showdown order, `category`
one of `high_card` … `straight_flush`; `mucked`: seats, never their cards),
`pot_awarded`, `shown`, `hand_ended`. Blackjack `player_sat`,
`player_left`, `sat_out`, `sat_in`, `rebought`, `bet_placed`,
`bet_cleared`, `shoe_shuffled` (`cards_in_shoe`, `mid_round`),
`round_started`, `card_dealt` (`seat`/`hand` `null` = to the dealer; the
hole card is `"??"`), `dealer_peeked`, `acted` (`action`:
`hit`/`stand`/`double`/`split`), `dealer_revealed`, `hand_settled`
(`outcome`: `blackjack`/`win`/`push`/`lose`; `returned` includes the bet),
`round_ended`. A client skips an event type it does not know.

#### Versions

`version` is per table: 1 when it opens, + 1 for every change any view shows
(each engine call that returned events, and each server-side change like
`away`). Every frame carrying a view carries the version of the state it
shows, and every connection sees the same number for the same change.
`versionStep(held, incoming, frame)` in `protocol.ts` is the client's rule:
`GameEvents` at `held + 1` applies (animate its events); at or below `held`
is ignored; above `held + 1` (frames dropped under backpressure — `try_send`)
applies the view, which is complete, without animating events as if nothing
was missed. A `GameTable` at or above `held` replaces the table. So a dropped
frame heals at the next one; `GameResync` (throttled to one a second per
connection — refused `rate_limited` beyond) is for a client that cannot trust
what it holds: after `RoomJoined` for a call it still holds a table for (a
reconnect gets a NEW `conn_id`, so private cards sent to the old one are
gone), after it refused to parse a frame, or when a turn clock ran out long
ago with no frame since.

#### Refusal codes

| code | carries | meaning |
|---|---|---|
| `disabled` | | games are off on this server |
| `no_permission` | | missing `CONNECT`+`PLAY_GAMES` (open, sit) or `MOVE_MEMBERS` (close, remove) |
| `not_in_call` | | this connection is not in that call; says nothing about any table |
| `not_a_voice_room` | | `room_id` is not `voice_<id>` |
| `room_has_table` | `open_table_id`, `kind` | one table per call: the open one must close first |
| `too_many_tables` | | the server-wide cap (500) |
| `rate_limited` | | 5 opens per 5 minutes per user, or one resync a second per connection |
| `wrong_game` | | an action, bet or request of the other game |
| `not_seated` | | needs a seat |
| `invalid_config` | | the settings fail validation or mix the games |
| `config_locked` | | settings cannot change after the first hand |
| `seat_out_of_range`, `seat_taken`, `seat_empty`, `already_seated` | | seating |
| `not_your_turn` | | |
| `stale_turn` | | that decision passed; drop silently |
| `no_chips`, `not_busted`, `rebuy_not_allowed` | | stacks and rebuys |
| `bet_below_minimum` | `min` | Hold'em: the smallest legal `bet_or_raise_to` total; Blackjack: the minimum bet |
| `hand_in_progress`, `no_hand_in_progress`, `not_enough_players`, `nothing_to_call`, `raise_not_reopened`, `nobody_to_raise`, `not_showable` | | Hold'em engine |
| `cannot_check` | `to_call` | Hold'em |
| `bet_above_stack` | `max` | Hold'em: the largest street total the stack reaches |
| `round_in_progress`, `no_round_in_progress`, `no_bets`, `sitting_out`, `cannot_hit`, `cannot_double`, `cannot_split` | | Blackjack engine |
| `bet_above_maximum` | `max` | Blackjack |
| `insufficient_chips` | `stack` | Blackjack |

Every engine error maps to exactly one code (`From<HoldemError>`,
`From<BjError>`, `From<OpenError>` for `GameRefusal`, exhaustive matches: a
new engine error does not compile until it has one). A client reads an
unknown code as `other`.

#### End reasons

| reason | when |
|---|---|
| `closed` | someone with `MOVE_MEMBERS` closed it (`GameClose`) |
| `call_ended` | the call emptied and stayed empty for one rejoin grace |
| `idle` | nobody sat at it for the idle limit, so it stopped holding the call's one table slot |
| `disabled` | the owner switched games off |
| `channel_deleted` | the voice channel was deleted |
| `gone` | the answer to a frame naming a table that is not open in that room: it closed while this client was not listening, or the server restarted |

A client reads an unknown reason as `other` and still drops the table.

#### Order of checks (server half)

So a refusal never says more than the caller may know: (1) a frame that does
not parse is the generic `Error`, as for every frame; (2) `room_id` not a
voice room → `not_a_voice_room`; (3) this connection not in that room
(`conns_of` under the room guard, never `joined_rooms`) → `not_in_call` —
before anything about tables, so a non-member learns nothing; (4)
`games_enabled` off → `disabled`; (5) permissions → `no_permission`; (6)
rate limits → `rate_limited`; (7) the table, `get_mut(room, id)` — not open
→ `GameEnded gone`; (8) the op against the game → `wrong_game`, the seat →
`not_seated`; (9) the engine → its code.

#### Where this deviates from the first sketch, and why

- `room_id` in every frame (the sketch named only `table_id`): the registry
  is keyed `(room, id)` and membership is per room; the server never has to
  search for a table, and a frame for one call can never act in another.
- `GameEvents` carries the per-connection `view`: the client never
  recomputes pots, legal actions or turns (that would re-implement the
  engine in TypeScript), and a dropped frame heals at the next one instead of
  needing a resync.
- `gone` instead of `server_restarted` (see *Restart ends every table*).
- The server PUSHES `GameTable` after `RoomJoined` when the call has a
  table, because a newcomer has no id to resync with; the client still sends
  `GameResync` after `RoomJoined` when it already holds a table.
- Frames the sketch left implicit: `GameBet` / `GameClearBet` (Blackjack
  bets between rounds), `GameSitOut` / `GameSitIn` (the clock sits a player
  out after two expiries; without `GameSitIn` they could never come back),
  `GameRebuy`, `GameShowCards`, and the moderation pair `GameClose` /
  `GameRemovePlayer`; plus the typed `GameRefused`.
- The `idle` end reason (owner to confirm the limit, suggested 5 minutes):
  closing is `MOVE_MEMBERS` only, so without it a table nobody sits at would
  hold the call's one slot until a moderator noticed.
- Capability: the per-socket `games` handshake instead of a
  `gamesSupported` flag (*Gating and permissions*).

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
  default, like `clips_enabled`. **Added by migration `073_games.sql`** (LF
  bytes, additive: 0.9.832 boots over it). **Client half built**: the owner's
  toggle in Server Settings (next to Clips; owner-only like it; disabled with
  a note, and never sent, when the server did not return the field) and
  `games_enabled` on the client `Server` type. Still to do (server half): the
  plumbing through the server-row SELECTs (server and invite handlers), the
  `Server` struct and the update handler.
- **`PLAY_GAMES = 1 << 28`** — **built**: `src/permissions.rs` (the next
  free bit; `1 << 28` is exact with JS `<<`, bit 31 would not be), in
  `DEFAULT_MEMBER` so new servers have it, and migration 073 ORs it onto
  every existing @everyone role (the pattern of migrations 051/056).
  `OVERWRITABLE` derives from `Self::all()`, so per-channel overwrites cover
  it automatically (pinned by a test). Client: BOTH maps in
  `frontend/src/api/permissionBits.ts` (`PERM` for gating, `PERMISSIONS` for
  the role editor), pinned to the Rust value by
  `permissions::play_games_bit_tests`. **Built (client)**: "Play Games" in
  the role editor's Voice Permissions and in `VOICE_CHANNEL_PERMS` in the
  channel editor (voice channels only — it is a voice-only bit).
- **Capability detection** — **built**, and NOT the `gamesSupported` flag
  the first sketch borrowed from `clipsSupported`: games ride the socket, and
  a reconnect can land on an older rollback host, so the answer must be per
  socket. It is the 0.9.832 capability handshake (*Frames → Capability*).
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
  (`channel_deleted`, beside the clip-channel cleanup in `delete_channel`).

## The table on screen

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

### What is built (client)

| piece | where |
|---|---|
| The store: one table per call, fed only by the four server frames | `frontend/src/api/games/gamesStore.ts` (+ `useGames.ts`) |
| Who is offered what | `api/games/gamesGate.ts` |
| Action bar, raise presets, bet range — read off `view.legal`, never the rules | `api/games/holdemActions.ts`, `blackjackActions.ts` |
| Every code, reason and event in words | `api/games/gameWords.ts` |
| The opener's form, checked against the engine's limits | `api/games/openTableConfig.ts` |
| The disclosure, remembered per account and server | `api/games/gamesDisclosure.ts` |
| The view (`viewMode: 'table'`), both tables, card faces, the phone sheet | `components/games/*` (lazy-loaded from `Chat.tsx`) |
| Suits and the Games icon, SVG | `Icons.tsx`: `CardsIcon`, `Suit*Icon` (solid: docs/ICON_LANGUAGE.md §4) |
| Entry points | VoiceStage header button; VoicePanel control (behind the phone's chevron) |
| Owner's switch, next to Clips | `ServerSettingsModal.tsx`, `games_enabled` (sent only when the server returned the field) |
| `PLAY_GAMES` rows | `RoleSettingsModal.tsx` (Voice Permissions), `EditChannelModal.tsx` (`VOICE_CHANNEL_PERMS`) |

**The store's rules** (pinned by `gamesStore.test.ts`, fed the contract
fixtures): `versionStep` decides; a `GameEvents` at exactly the next version
is applied AND its events are logged/animated; a gap applies the complete view
and logs nothing; a frame that does not parse, `RoomJoined` for the call it
holds a table for, and a turn clock that ran out more than 8 s ago with no
frame since each send `GameResync` — throttled to one a second (the server's
own limit) and held until this socket confirms `games`. `GameEnded` drops the
table and keeps its reason; `GameRefused` becomes a typed notice the table
shows inline (`stale_turn` silently dropped, a refused resync retried);
`RoomLeft`, `VoiceMoved` or another call drop the table with no notice; a
`ServerFeatures` without `games` (an older host after a reconnect) drops it
too. The store also tracks the voice room THIS SOCKET joined (`RoomJoined` /
`RoomLeft`), and a seat is offered only when that is the call on screen — the
SFU-participant-without-a-socket case above.

**Gating** (`gamesGate`): the entry points show with the socket's `games`
feature, the voice channel's server's `games_enabled`, and this socket in the
call; opening and sitting additionally need `CONNECT` + `PLAY_GAMES` in that
channel, with the bits PRESENT (never `hasPerm`'s fail-open on a missing
set — every server that plays games sends them). Without `PLAY_GAMES` a
person in the call can still WATCH an open table, as the server allows; the
button then reads "Watch the table". `MOVE_MEMBERS` shows Close table and a
Remove on each player.

**Proof:** vitest (`gamesStore`, `gamesLogic`, `gamesView`,
`serverSettingsGames`, `roleEditorPlayGames`, `editChannelModalVoicePerms`),
and `frontend/e2e/games-walk.mjs` — two accounts in one call, desktop 1280x800
and a 390x844 coarse-pointer phone, both games, the keyboard-open sheet, the
460 px overflow control, eight themes with and without high contrast. Until
the server half was served the walk ran against a mock in front of a real
backend that answers `Game*` frames from the contract fixtures; the
integration step runs it against the real server.

### Client decisions and where they deviate from the sketch

- **A gap does NOT resync.** Every frame carries the complete per-connection
  view, so a `GameEvents` that skipped versions is applied as is (without
  animating events as if nothing was missed) — exactly the contract's
  `versionStep` rule. A resync after a gap would add a frame to a socket that
  is already dropping frames under backpressure, for nothing the view lacks.
  What DOES resync is the case where the client cannot trust what it holds: a
  games frame it could not parse, a reconnect (`RoomJoined` for its call), a
  clock that ran out long ago.
- **Your seat lives in the fixed footer** with the action bar (desktop and
  phone): the opponents, the board and the log scroll above it, so your cards
  and the buttons never scroll away.
- **The phone hides the chat composer while the table is up** (it returns with
  "Call"): with the collapsed voice bar and the bottom nav, the composer's
  ~75 px is what the two-row bar needs. The desktop keeps it.
- **The phone takes back `.messages-container`'s side padding** (40 px — a
  whole 44 px target) so the second row (four presets and the − amount +
  stepper) fits a 390 px screen.
- **Tapping the panel's Games control folds the phone's expanded voice
  controls** away for the same reason.
- **The raise amount on the phone is a button that opens the sheet**; the
  sheet has its own presets, stepper and a numeric field (16 px, `inputmode`
  numeric) and sits on the bottom of `window.visualViewport`. On the desktop
  the amount is an inline field.
- **The all-in total is sent as `all_in`**, not `bet_or_raise_to`: a stack
  short of a full raise has `max_raise_to` below the minimum, which only the
  all-in action may put in.
- **Presets are street totals:** min = `min_raise_to`; ½ pot =
  `current_bet + (pot_total + to_call) / 2` (rounded down); pot =
  `current_bet + pot_total + to_call` (call, then raise by the pot after the
  call — `pot_total` already includes this street); all-in = `max_raise_to`;
  each clamped to `[min_raise_to, max_raise_to]`. The stepper moves by one big
  blind.
- **The disclosure is remembered per account AND per server** on this device
  ("its operator" is a different operator on every server); storage that
  fails shows it again.
- **Opponents first in the strip**, open seats after them, so a phone shows
  the people at the table before any scrolling.
- **Card faces are a fixed light surface with fixed ink, the felt a fixed
  green**, in every theme — a card must read the same everywhere; only the
  face-DOWN back follows the theme's brand colour. Primary buttons use
  `--brand-active` and Fold a fixed deep red: `--brand-primary` is under 4.5:1
  against white in the green and yellow themes and `--color-danger` is 3.8:1;
  the walk measures every button, the felt and the card ink in all eight
  themes with and without high contrast.
- **"Watch the table"**: GAMES.md lets anyone in the call watch; the entry
  point says so for someone without `PLAY_GAMES` instead of hiding the table.
- **`games_enabled` on the client `Server` type** is read from the voice
  channel's OWN server (not the viewed one), like the clip policy; absent
  means a server that predates games (the toggle is disabled and never sent).

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
