/**
 * The client's one games table (docs/GAMES.md, *The table on screen*): what
 * the server last showed THIS connection of the table in THIS call, fed only
 * by the contract's frames (protocol.ts). Nothing here re-implements a rule —
 * pots, turns and legal actions are the server's view, taken as sent.
 *
 * A plain module store (subscribe / getSnapshot, like ownVoice.ts), so it
 * survives the table view being closed and reopened: opening or leaving the
 * view never touches the call, and must not lose the table either.
 *
 * What it does with each frame (versionStep is the contract's rule):
 *   - GameTable / GameEvents for the call we are in: apply the view; animate
 *     a GameEvents' events only when it is exactly the next version. A frame
 *     that skipped versions (dropped under backpressure) still carries the
 *     whole view, so it is applied WITHOUT a resync — GAMES.md: "a dropped
 *     frame heals at the next one".
 *   - A games frame that does not parse: we cannot trust what we hold, so
 *     GameResync (throttled to one a second, the server's own limit).
 *   - RoomJoined for the call we hold a table for (a reconnect: a NEW conn_id,
 *     so private cards sent to the old one are gone): GameResync.
 *   - A turn clock that ran out long ago with no frame since: GameResync.
 *   - GameEnded: drop the table, keep the reason to say why.
 *   - GameRefused: a typed notice the table shows inline for
 *     REFUSAL_NOTICE_MS (never an alert); `stale_turn` is dropped silently
 *     (a delayed double submit). `lastRefusalAt` outlives the notice, so a
 *     table can tell "my action was refused" after the words have gone.
 *   - Leaving the call (RoomLeft, VoiceMoved, another call): drop the table
 *     silently — the server sends no GameEnded for that.
 *
 * Nothing is sent unless this socket's server confirmed `games` in
 * ServerFeatures: an older server answers an unknown frame with an Error,
 * which the chat view shows as an alert.
 */
import {
    GAMES_FEATURE,
    gameFrames,
    parseGameFrame,
    versionStep,
    type BlackjackEvent,
    type GameClientFrame,
    type GameEndReason,
    type GameOp,
    type GameRefusal,
    type GameView,
    type HoldemEvent,
} from './protocol';

/** The slice of wsClient the store needs; tests pass a fake. */
export interface GamesSocket {
    on(type: string, handler: (msg: { type: string; payload?: Record<string, unknown> }) => void): void;
    off(type: string, handler: (msg: { type: string; payload?: Record<string, unknown> }) => void): void;
    send(message: object): boolean;
    hasServerFeature(name: string): boolean;
}

export type GameEvent = HoldemEvent | BlackjackEvent;

export interface HeldTable {
    room_id: string;
    table_id: number;
    version: number;
    view: GameView;
    /** `performance.now()`-style ms when the view arrived; the clocks in the
     *  view (`clock_ms`, `next_deal_in_ms`) are relative to this moment. */
    receivedAt: number;
    /** Events to animate/log: the latest GameEvents that was exactly the next
     *  version. Empty after a gap or a snapshot. */
    events: GameEvent[];
    /** The version `events` belong to (so a view can tell new from shown). */
    eventsVersion: number;
    /** Every event applied in order since this table arrived here, newest
     *  last, capped at LOG_MAX — what the table words as "what happened".
     *  A gap appends nothing (those events were never seen). */
    log: GameEvent[];
}

export type GamesNotice =
    | { kind: 'refused'; room_id: string; table_id: number | null; op: GameOp | 'other'; refusal: GameRefusal; at: number }
    | { kind: 'ended'; room_id: string; table_id: number; reason: GameEndReason | 'other'; at: number };

export interface GamesState {
    /** The call this client shows (Chat's voice channel, `voice_<id>`), or null. */
    room: string | null;
    /** The voice room this SOCKET is in, per RoomJoined / RoomLeft. Only a
     *  connection in the room is a member the server deals to (GAMES.md: an
     *  SFU participant whose socket never rejoined cannot play), so a seat is
     *  offered only when this equals `room`. */
    joined: string | null;
    /** This socket's server confirmed `games`. */
    feature: boolean;
    table: HeldTable | null;
    notice: GamesNotice | null;
    /** When the last refusal arrived (Date.now()), kept after its notice
     *  fades: the action bar re-enables on it. */
    lastRefusalAt: number | null;
}

/** How long past a turn clock's end, with no frame since, before we stop
 *  trusting what we hold and resync. The server's timer acts at 0. */
export const CLOCK_STALE_GRACE_MS = 8_000;
/** The server refuses a second resync inside one second (`rate_limited`). */
export const RESYNC_MIN_INTERVAL_MS = 1_000;

const EMPTY: GamesState = { room: null, joined: null, feature: false, table: null, notice: null, lastRefusalAt: null };

/** How long a refusal's words stay up; an ending stays until dismissed. */
export const REFUSAL_NOTICE_MS = 8_000;

/** How many events the table keeps for its "what happened" lines. */
export const LOG_MAX = 60;

let state: GamesState = EMPTY;
const listeners = new Set<() => void>();
let socket: GamesSocket | null = null;
let now: () => number = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// Resync bookkeeping: never two inside RESYNC_MIN_INTERVAL_MS, and one wanted
// while the feature is not (yet) confirmed waits for it.
let lastResyncAt = -Infinity;
let resyncTimer: ReturnType<typeof setTimeout> | null = null;
let resyncPending = false;
let clockTimer: ReturnType<typeof setTimeout> | null = null;
let noticeTimer: ReturnType<typeof setTimeout> | null = null;

function emit() {
    for (const l of [...listeners]) l();
}
function set(next: Partial<GamesState>) {
    state = { ...state, ...next };
    emit();
}

/** The clock the store stamps `receivedAt` with; views count down against it. */
export function gamesNow(): number {
    return now();
}

export function getGamesState(): GamesState {
    return state;
}
export function subscribeGames(fn: () => void): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
}

/** Send a game frame if (and only if) this socket's server plays games. */
export function sendGame(frame: GameClientFrame): boolean {
    if (!socket || !socket.hasServerFeature(GAMES_FEATURE)) return false;
    return socket.send(frame);
}

function clearTimers() {
    if (resyncTimer) { clearTimeout(resyncTimer); resyncTimer = null; }
    if (clockTimer) { clearTimeout(clockTimer); clockTimer = null; }
}

function showRefusal(n: GamesNotice & { kind: 'refused' }) {
    if (noticeTimer) clearTimeout(noticeTimer);
    set({ notice: n, lastRefusalAt: n.at });
    noticeTimer = setTimeout(() => {
        noticeTimer = null;
        if (state.notice === n) set({ notice: null });
    }, REFUSAL_NOTICE_MS);
}

/** Ask the server for the whole table again (throttled; waits for the feature). */
export function requestResync(): void {
    const t = state.table;
    if (!t) return;
    if (!socket || !socket.hasServerFeature(GAMES_FEATURE)) {
        resyncPending = true;
        return;
    }
    const wait = lastResyncAt + RESYNC_MIN_INTERVAL_MS - now();
    if (wait > 0) {
        resyncPending = true;
        if (!resyncTimer) {
            resyncTimer = setTimeout(() => {
                resyncTimer = null;
                if (resyncPending) requestResync();
            }, wait);
        }
        return;
    }
    resyncPending = false;
    if (sendGame(gameFrames.resync(t.room_id, t.table_id))) lastResyncAt = now();
    else resyncPending = true;
}

/** Re-arm the "clock ran out long ago" watchdog for the view just applied. */
function armClockWatchdog(t: HeldTable) {
    if (clockTimer) { clearTimeout(clockTimer); clockTimer = null; }
    const clock = t.view.clock_ms;
    if (clock === null) return;
    const version = t.version;
    const tableId = t.table_id;
    clockTimer = setTimeout(() => {
        clockTimer = null;
        // Still holding exactly what we held when the clock started: no
        // frame came in after the clock's end + grace, so frames were lost.
        if (state.table && state.table.table_id === tableId && state.table.version === version) requestResync();
    }, clock + CLOCK_STALE_GRACE_MS);
}

function dropTable(notice: GamesNotice | null = state.notice) {
    clearTimers();
    resyncPending = false;
    set({ table: null, notice });
}

/** The call this client is in (Chat's currentVoiceChannel). Another call, or
 *  none, drops whatever table we held — silently, as GAMES.md says. */
export function setGamesRoom(room: string | null): void {
    if (state.room === room) return;
    if (state.table && state.table.room_id !== room) {
        clearTimers();
        resyncPending = false;
        state = { ...state, table: null, notice: null };
    }
    set({ room, notice: state.notice && state.notice.room_id === room ? state.notice : null });
}

/** Forget the shown refusal / ending (the person dismissed it). */
export function clearGamesNotice(): void {
    if (state.notice) set({ notice: null });
}

function applyView(room_id: string, table_id: number, version: number, view: GameView, events: GameEvent[] | null) {
    const prev = state.table;
    const sameTable = prev !== null && prev.room_id === room_id && prev.table_id === table_id;
    const log = sameTable ? prev.log : [];
    const next: HeldTable = {
        room_id,
        table_id,
        version,
        view,
        receivedAt: now(),
        events: events ?? [],
        eventsVersion: events ? version : (sameTable ? prev.eventsVersion : 0),
        log: events && events.length ? [...log, ...events].slice(-LOG_MAX) : log,
    };
    // A table arriving clears an ending notice for the call (a new one opened);
    // a refusal fades on its own timer (showRefusal).
    const notice = state.notice && state.notice.kind === 'ended' ? null : state.notice;
    set({ table: next, notice });
    armClockWatchdog(next);
}

/**
 * One socket message. Exported for the tests; production wiring is
 * attachGamesSocket. Returns what happened, for the tests' benefit.
 */
export function handleGamesMessage(msg: { type: string; payload?: unknown }): string {
    switch (msg.type) {
        case 'ServerFeatures': {
            const feature = !!socket && socket.hasServerFeature(GAMES_FEATURE);
            if (!feature) {
                // This socket's server does not play games (an older rollback
                // host): what we held came from somewhere else.
                if (state.table) dropTable(null);
                set({ feature: false });
                return 'feature-off';
            }
            set({ feature: true });
            if (resyncPending) requestResync();
            return 'feature-on';
        }
        case 'RoomJoined': {
            const room = (msg.payload as { room_id?: unknown } | undefined)?.room_id;
            if (typeof room === 'string' && room.startsWith('voice_')) set({ joined: room });
            if (typeof room === 'string' && state.table && state.table.room_id === room) {
                requestResync();
                return 'resync-after-join';
            }
            return 'ignored';
        }
        case 'RoomLeft': {
            const room = (msg.payload as { room_id?: unknown } | undefined)?.room_id;
            if (typeof room === 'string' && state.joined === room) set({ joined: null });
            if (typeof room === 'string' && state.table && state.table.room_id === room) {
                dropTable(null);
                return 'dropped';
            }
            return 'ignored';
        }
        case 'VoiceMoved': {
            const from = (msg.payload as { from_channel_id?: unknown } | undefined)?.from_channel_id;
            if (typeof from === 'number' && state.joined === `voice_${from}`) set({ joined: null });
            if (typeof from === 'number' && state.table && state.table.room_id === `voice_${from}`) {
                dropTable(null);
                return 'dropped';
            }
            return 'ignored';
        }
        case 'GameTable':
        case 'GameEvents':
        case 'GameEnded':
        case 'GameRefused':
            break;
        default:
            return 'ignored';
    }

    const f = parseGameFrame(msg as { type: string; payload?: unknown });
    if (!f) {
        // A games frame we could not read: what we hold may be wrong now.
        requestResync();
        return 'junk';
    }
    if (f.type === 'GameRefused') {
        if (f.room_id !== state.room) return 'ignored';
        if (f.refusal.code === 'stale_turn') return 'stale';
        // A refused resync is the throttle or a race; the next one fixes it.
        if (f.op === 'resync' && f.refusal.code === 'rate_limited') {
            resyncPending = true;
            requestResync();
            return 'resync-throttled';
        }
        showRefusal({ kind: 'refused', room_id: f.room_id, table_id: f.table_id, op: f.op, refusal: f.refusal, at: Date.now() });
        return 'refused';
    }
    if (f.room_id !== state.room) return 'ignored';
    if (f.type === 'GameEnded') {
        const t = state.table;
        // An ending for a table we do not hold says nothing about ours.
        if (!t || t.table_id !== f.table_id) return 'ignored';
        dropTable({ kind: 'ended', room_id: f.room_id, table_id: f.table_id, reason: f.reason, at: Date.now() });
        return 'ended';
    }
    const held = state.table && state.table.table_id === f.table_id ? state.table.version : null;
    const step = versionStep(held, f.version, f.type);
    if (step === 'ignore') return 'ignored';
    if (f.type === 'GameEvents' && step === 'apply' && held !== null) {
        applyView(f.room_id, f.table_id, f.version, f.view, f.events);
        return 'applied';
    }
    applyView(f.room_id, f.table_id, f.version, f.view, null);
    return step === 'apply_after_gap' ? 'applied-after-gap' : 'applied';
}

const WATCHED = ['ServerFeatures', 'RoomJoined', 'RoomLeft', 'VoiceMoved', 'GameTable', 'GameEvents', 'GameEnded', 'GameRefused'];

/** Wire the store to a socket (Chat does this once). Returns the detach. */
export function attachGamesSocket(ws: GamesSocket): () => void {
    socket = ws;
    const handler = (m: { type: string; payload?: unknown }) => { handleGamesMessage(m); };
    for (const t of WATCHED) ws.on(t, handler);
    // The socket closed: its server's confirmation went with it, and the
    // next one must prove itself (it may be an older host). The table is
    // kept so the reconnect's RoomJoined can resync it.
    const onClosed = () => {
        if (state.feature || state.joined) set({ feature: false, joined: null });
    };
    if (typeof window !== 'undefined') window.addEventListener('wsClosed', onClosed);
    set({ feature: ws.hasServerFeature(GAMES_FEATURE) });
    return () => {
        for (const t of WATCHED) ws.off(t, handler);
        if (typeof window !== 'undefined') window.removeEventListener('wsClosed', onClosed);
        if (socket === ws) socket = null;
    };
}

/** Tests only: a clean store, optionally with a fake clock. */
export function resetGamesStoreForTests(clock?: () => number): void {
    clearTimers();
    if (noticeTimer) { clearTimeout(noticeTimer); noticeTimer = null; }
    state = EMPTY;
    listeners.clear();
    socket = null;
    lastResyncAt = -Infinity;
    resyncPending = false;
    now = clock ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
}
