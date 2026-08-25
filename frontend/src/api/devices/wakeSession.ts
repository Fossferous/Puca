/**
 * Wake a device, then open a remote-control session on it once it comes back.
 *
 * The two halves are separate features and the join between them is the whole
 * point of this file: a magic packet has no acknowledgement, so "did it work?"
 * can only ever be answered by the target reconnecting. Everything here is a
 * wait for that one observation, with an honest story for every way it can
 * fail to arrive.
 *
 * WHY POLLING, AND WHY `online` IS ENOUGH. There is no "device came online"
 * push. But `online` on a device row is not a guess: the server computes it as
 * `conn_of_device(user, id).is_some()`, and a session only carries a device id
 * once `attest_device` has run — which happens after a verified DeviceAttest
 * round-trip. So a device reading `online` has a live socket that COMPLETED
 * ATTESTATION, which is exactly the precondition `connectToDevice` needs.
 * There is no weaker connected-but-unattested state to accidentally catch.
 * (Do not "optimise" this into a presence check; presence is a different,
 * weaker signal.)
 */
import { listDevices, type VerifiedDevice } from './index';
import { connectToDevice } from './session';
import { planWake, requestWake, openLanInfo } from './wake';
import { groupIntoMachines, machineOf, type Machine } from './machines';
import { wsClient } from '../websocket';

export type WakePhase =
    /** Choosing a waker and relaying the request. */
    | 'sending'
    /** Packet is out; waiting for the machine to boot and reconnect. */
    | 'waiting'
    /** Somebody signed in at the machine's sign-in screen; waiting for its
     *  desktop app to come up so the session can move there. Same wait as
     *  'waiting', different story — the card says why it is waiting. */
    | 'following'
    /** It came back — opening the session. */
    | 'connecting'
    | 'failed'
    | 'cancelled';

export interface WakeState {
    deviceId: string;
    phase: WakePhase;
    /** Shown verbatim under the card. */
    message: string;
    /** Whole seconds left in the wait, for a countdown. */
    secondsLeft?: number;
}

/**
 * How long to wait for a woken machine to reappear.
 *
 * Budget for the slowest realistic path that can still succeed: POST + firmware
 * (5-20s on a desktop with fast boot off), Windows loading to the sign-in
 * screen (10-30s), the user's session resuming and `HKCU\...\Run` firing (this
 * is where autostart actually happens — see the note in the UI), the app
 * launching, the WebSocket connecting and DeviceAttest completing (2-10s).
 * Three minutes covers that with room; much less and a genuinely-working slow
 * machine reports a false failure, which is worse than waiting.
 */
const WAKE_TIMEOUT_MS = 180_000;

/** Poll cadence while waiting. Fast enough to feel responsive, slow enough
 *  that a three-minute wait is ~36 requests rather than hundreds. */
const POLL_INTERVAL_MS = 5_000;

type Listener = (states: ReadonlyMap<string, WakeState>) => void;

const states = new Map<string, WakeState>();
/** The clocks of a live wait, plus the presence-frame listener that lets it
 *  look early (see `watchForRow`). All three are torn down together. */
const timers = new Map<string, { poll: number; deadline: number; unsub?: () => void }>();
const listeners = new Set<Listener>();

/**
 * Which attempt is currently live for a device.
 *
 * Every async step re-checks its own generation before writing state. Without
 * this, three things went wrong and all of them were silent: a cancel during
 * the (awaited) planning stage was simply overwritten when planning finished;
 * a `connectToDevice` that threw AFTER a cancel resurrected a deleted entry as
 * a red error the user could not dismiss; and a second press while the first
 * attempt was still planning started an entire duplicate wake, because the
 * reentrancy guard keyed on `timers`, which is not populated until the very
 * end of the function.
 */
const generation = new Map<string, number>();

/**
 * Relayed wakes still waiting for the server to say whether it got through.
 *
 * FIFO, and that is exact rather than approximate: there is ONE socket, the
 * server handles its frames in order, and it answers each `DeviceWake` with one
 * `DeviceWakeResult`. So the oldest unanswered relay is always the one a result
 * belongs to. The frame cannot name the target — the server never learns which
 * MAC belongs to which device, because `lan_info` is client-encrypted — so
 * ordering is the only correlation available, and it is enough.
 */
const pendingRelays: Array<{ targetId: string; token: number; sentAt: number }> = [];

/**
 * How long a relayed wake may wait for its verdict before the entry is
 * treated as orphaned. The server answers in the same handler that relays —
 * one round trip. Anything older than this was sent on a socket that died
 * under it, and letting it linger shifts every LATER result onto the wrong
 * card (order is the only correlation the frame allows). Generous, so a slow
 * mobile link is not mistaken for a dead one.
 */
const RELAY_RESULT_TTL_MS = 20_000;

/** Drop entries whose result can no longer arrive. */
function pruneStaleRelays(now = Date.now()): void {
    while (pendingRelays.length > 0 && now - pendingRelays[0].sentAt > RELAY_RESULT_TTL_MS) {
        pendingRelays.shift();
    }
}

let wakeResultInstalled = false;

/**
 * Report a refused wake on the card that asked for it.
 *
 * WITHOUT THIS the refusal is invisible. Every server-side wake refusal used to
 * be a generic `Error` frame, and the only listener for that in the frontend is
 * the chat view, which pops an alert with no connection to the device card — so
 * "that device isn't online to send the wake packet" and "you are sending that
 * too quickly" both presented as a wake in progress, and the card counted down
 * for three minutes before advising a BIOS change.
 */
export function installWakeResultListener(): void {
    if (wakeResultInstalled) return;
    wakeResultInstalled = true;
    wsClient.on('DeviceWakeResult', (msg: { payload?: { ok?: boolean; message?: string } }) => {
        pruneStaleRelays();
        const pending = pendingRelays.shift();
        if (!pending) return;
        if (msg?.payload?.ok) return; // relayed; the wait continues
        if (!isCurrent(pending.targetId, pending.token)) return;
        clearTimers(pending.targetId);
        set(
            pending.targetId,
            'failed',
            msg?.payload?.message ?? 'The wake signal could not be sent.',
        );
    });
    // A (re)connect means every frame sent on the OLD socket is gone, and so
    // is any answer to it. Anything still queued here would only ever be
    // matched against a result meant for a later wake. `wsConnected` is a
    // WINDOW event (websocket.ts dispatches it from onopen), not a frame type —
    // registering it via wsClient.on would silently never fire.
    window.addEventListener('wsConnected', () => { pendingRelays.length = 0; });
}

/** Start a new attempt and return its token; any older attempt is now stale. */
function beginAttempt(deviceId: string): number {
    const next = (generation.get(deviceId) ?? 0) + 1;
    generation.set(deviceId, next);
    return next;
}

function isCurrent(deviceId: string, token: number): boolean {
    return generation.get(deviceId) === token;
}

/** True while an attempt for this device is genuinely LIVE — including the
 *  async planning stage before the timers exist.
 *
 *  LIVE PHASES ONLY. This used to be "any state exists", and a `failed` entry
 *  stays in `states` until the user presses Dismiss — so after one failure,
 *  every further press of a still-visible Wake button returned here silently
 *  and did nothing at all. That is the literal field report: "selecting Wake
 *  did nothing". A press on a failed/cancelled card must start a NEW attempt,
 *  which the generation tokens already make safe. */
function attemptInFlight(deviceId: string): boolean {
    if (timers.has(deviceId)) return true;
    const phase = states.get(deviceId)?.phase;
    return phase === 'sending' || phase === 'waiting' || phase === 'following' || phase === 'connecting';
}

/** True for every phase the card should show a "Stop waiting" button for. */
export function wakePhaseIsLive(phase: WakePhase | undefined): boolean {
    return phase === 'sending' || phase === 'waiting' || phase === 'following' || phase === 'connecting';
}

function emit(): void {
    // A FRESH Map every time. React bails out of a re-render when the new
    // state is `Object.is`-equal to the old, so handing subscribers the same
    // mutated instance meant the very first emit was the only one that ever
    // repainted: the button never became "Stop waiting", no status line
    // appeared, and the countdown only moved when an unrelated 15s presence
    // poll happened to replace a different piece of state.
    const snapshot: ReadonlyMap<string, WakeState> = new Map(states);
    for (const l of listeners) {
        try {
            l(snapshot);
        } catch {
            // A throwing subscriber must not stop the others, or one bad render
            // strands every other card's status.
        }
    }
}

function set(deviceId: string, phase: WakePhase, message: string, secondsLeft?: number): void {
    states.set(deviceId, { deviceId, phase, message, secondsLeft });
    emit();
}

/** Stop the clocks for one device without touching its displayed state. */
function clearTimers(deviceId: string): void {
    const t = timers.get(deviceId);
    if (!t) return;
    clearInterval(t.poll);
    clearTimeout(t.deadline);
    t.unsub?.();
    timers.delete(deviceId);
}

export function subscribeWakes(listener: Listener): () => void {
    listeners.add(listener);
    listener(states);
    return () => { listeners.delete(listener); };
}

export function wakeStateFor(deviceId: string): WakeState | undefined {
    return states.get(deviceId);
}

/** User pressed cancel, dismissed a failure, or is leaving. Silent — they
 *  know they did it. Bumping the generation is what makes an in-flight async
 *  step stop writing state afterwards.
 *
 *  GATED ON "IS THERE ANYTHING TO CLEAR", not on "is it live". This is the
 *  Dismiss button as well as the Stop button, and a `failed` card is neither
 *  in-flight nor has timers — the previous guard (`attemptInFlight` only)
 *  made Dismiss a silent no-op, so a failure explanation could not be
 *  cleared at all, for a wake OR the unlock-follow. */
export function cancelWake(deviceId: string): void {
    if (!attemptInFlight(deviceId) && !states.has(deviceId)) return;
    beginAttempt(deviceId);
    clearTimers(deviceId);
    states.delete(deviceId);
    emit();
}

/** Sign-out / teardown: drop every wait rather than leaving pollers running
 *  against an account that is no longer signed in — each poll would be a 401
 *  that trips the global auth-expired handling. */
export function cancelAllWakes(): void {
    for (const id of [...timers.keys()]) clearTimers(id);
    for (const id of [...states.keys()]) beginAttempt(id);
    states.clear();
    // Nothing is waiting for a result any more, and a stale entry would apply
    // the NEXT session's first result to a card that no longer exists.
    pendingRelays.length = 0;
    emit();
}

/**
 * Wake `target`, then connect to it when it returns.
 *
 * Resolves as soon as the request is relayed — the interesting part happens
 * afterwards and is reported through `subscribeWakes`.
 */
export async function wakeAndConnect(
    target: VerifiedDevice,
    all: VerifiedDevice[],
    thisDevice: string | null,
    userId: number,
): Promise<void> {
    // Guard on the STATE, not the timers: the timers are not created until the
    // end of this function, so keying on them let a second press slip through
    // during the awaited planning below and start a duplicate wake whose
    // timers then overwrote the first attempt's — orphaning a poller and a
    // deadline that nothing could ever clear.
    if (attemptInFlight(target.id)) return;

    const token = beginAttempt(target.id);
    set(target.id, 'sending', 'Choosing a device to send the wake signal…');

    const plan = await planWake(target, all, thisDevice);
    if (!isCurrent(target.id, token)) return; // cancelled while planning
    if (!plan.waker || !plan.mac) {
        set(target.id, 'failed', plan.reason ?? `${target.name} cannot be woken from here.`);
        return;
    }

    // Sends locally when the chosen waker is this machine; the server refuses
    // to relay a device's wake request back to itself.
    const outcome = await requestWake(plan, thisDevice);
    if (!isCurrent(target.id, token)) return;
    if (outcome.kind === 'failed') {
        // FAIL NOW rather than after three minutes. This branch used to be
        // invisible: the send swallowed its own errors and the card went
        // straight to "waiting".
        set(target.id, 'failed', outcome.reason);
        return;
    }
    if (outcome.kind === 'relayed') {
        // The server will say whether it got as far as the other device. Queued
        // in order: one socket, ordered replies, so the oldest unanswered relay
        // is the one this result belongs to. Stamped so an orphan can be aged
        // out rather than shifting later results onto the wrong card.
        pruneStaleRelays();
        pendingRelays.push({ targetId: target.id, token, sentAt: Date.now() });
    }

    // Warn BEFORE the wait rather than after a three-minute timeout: a magic
    // packet essentially never wakes a machine over Wi-Fi.
    const wired = await targetWasWired(target);
    if (!isCurrent(target.id, token)) return;
    const wifiNote = wired === false
        ? ` ${target.name} was last seen on Wi-Fi, where wake signals almost never work — this is likely to fail unless it is on Ethernet.`
        : '';

    set(
        target.id,
        'waiting',
        `Wake signal sent via ${plan.waker.name}. Waiting for ${target.name} to start up…${wifiNote}`,
        Math.round(WAKE_TIMEOUT_MS / 1000),
    );

    // Was a sign-in-screen row actually being WATCHED for this machine? Decided
    // up front, from the list this wake started with, so the deadline can say
    // something true. Computed cheaply: the fold already ran in planWake's
    // caller; re-running it here once is nothing next to a 180 s wait.
    const watchedSignIn = await targetHasSignInRow(target, all);
    if (!isCurrent(target.id, token)) return;

    watchForRow({
        cardId: target.id,
        token,
        userId,
        phase: 'waiting',
        timeoutMs: WAKE_TIMEOUT_MS,
        pollMs: POLL_INTERVAL_MS,
        // WAIT FOR THE MACHINE, NOT FOR ONE ROW OF IT. A PC that was fully
        // powered off comes back at the WINDOWS SIGN-IN SCREEN, where the
        // desktop app has not started and never will until somebody signs in —
        // so its app row stays offline for ever and this poll used to time out
        // after three minutes and blame the BIOS. The row that DOES come up is
        // the sign-in-screen service's, which is the whole point of waking the
        // machine: connect there and type the password.
        pick: machine => {
            // `online` already implies attested — see the file header.
            const fresh = machine?.onlineRow ?? null;
            if (!fresh || !fresh.verified) return null;
            return {
                row: fresh,
                connectingMessage: machine?.atSignInScreen
                    ? `${target.name} is back at its sign-in screen — opening the session…`
                    : `${target.name} is back — opening the session…`,
            };
        },
        timeoutMessage: () => timeoutMessage(target.name, watchedSignIn),
        openFailedMessage: why => `${target.name} woke up, but the session could not be opened: ${why}`,
    });
}

/**
 * How long to wait, after somebody signs in at a machine's sign-in screen, for
 * its desktop app to come online so the session can move there.
 *
 * NOT ten seconds. That was the first figure, chosen for the unlock of a
 * session that was already running — and it is fine for that. It is nowhere
 * near enough for the case this feature exists for: a machine that was
 * powered off, woken (or switched on), and signed into for the first time
 * since boot. Windows then builds the desktop, `HKCU\...\Run` fires, the app
 * starts cold, its updater runs, WebView2 comes up, the socket connects,
 * DeviceAttest completes. That is routinely 20-60 s and the ten-second wait
 * gave up SILENTLY inside it: the stage closed, nothing said why, and the
 * user reconnected by hand — the exact chore the handover was meant to end.
 *
 * Two minutes covers a slow first sign-in with room, and the wait is now on
 * the card with a countdown and a Stop button, so a long one is a thing the
 * user can see and end rather than a mystery.
 */
const FOLLOW_TIMEOUT_MS = 120_000;
/** Faster than the wake poll: the machine is already up, only the app is
 *  loading, so it tends to arrive early in the window and the wait should
 *  end within a couple of seconds of that. */
const FOLLOW_POLL_MS = 3_000;

/**
 * Follow a machine from its sign-in screen to its signed-in desktop.
 *
 * Called when the host ended the session with the unlock-handover reason (see
 * `HANDOVER_REASON` in session.ts): somebody signed in, so the sign-in-screen
 * service stood down and the picture now lives on that machine's OTHER device
 * row, the desktop app's. This waits for that row to attest and connects
 * there — what the user would do by hand, and used to have to.
 *
 * Reported on the machine's CARD (keyed like a wake, by the primary row) so
 * the wait is visible, counts down, and can be stopped; ends with an honest
 * message when the app never appears — a machine whose desktop app is not set
 * to start with Windows is a legitimate configuration, and the user needs to
 * be told that is what happened rather than watch nothing happen.
 *
 * Reads the device list once up front only to find the card to report on;
 * the poll re-reads it itself.
 */
export async function followToDesktop(
    signInRowId: string,
    userId: number,
): Promise<void> {
    let all: VerifiedDevice[];
    try {
        all = await listDevices(userId);
    } catch {
        // No list, no card to report on and no way to find the other row.
        // The user is back at the Devices view either way and can reconnect.
        return;
    }
    const machine = machineOf(await groupIntoMachines(all), signInRowId);
    if (!machine) return;
    // A sign-in row that grouped ALONE (its lan_info never got a MAC, or the
    // fold could not read it) has no other row to move to, and the fold will
    // not grow one later — the app row is on the list already, just not
    // provably the same box. A wait here could only ever time out, on a card
    // named "This PC (sign-in screen)". Say nothing; the list is right there.
    if (!machine.rows.some(r => r.id !== signInRowId)) return;
    const cardId = machine.primary.id;
    const name = machine.primary.name;
    // A wake in flight for this card (someone pressed Wake, then it came up
    // at the sign-in screen and we connected, then they signed in) has done
    // its job; the follow supersedes it rather than yielding to it.
    if (attemptInFlight(cardId)) {
        clearTimers(cardId);
    }
    const token = beginAttempt(cardId);
    set(
        cardId,
        'following',
        `Signed in on ${name} — waiting for its desktop app to come up so the session can move there…`,
        Math.round(FOLLOW_TIMEOUT_MS / 1000),
    );
    watchForRow({
        cardId,
        token,
        userId,
        phase: 'following',
        timeoutMs: FOLLOW_TIMEOUT_MS,
        pollMs: FOLLOW_POLL_MS,
        // The row to move to is any ONLINE row of this machine that is not the
        // sign-in row we just left — i.e. the desktop app's. The sign-in row may
        // still read online for a moment after its DeviceEnd (the socket close
        // lands a beat later), so it is excluded by id, not by state.
        pick: m => {
            const row = m?.rows.find(r => r.id !== signInRowId && r.online && r.verified) ?? null;
            if (!row) return null;
            return { row, connectingMessage: `${name} is signed in — opening its desktop…` };
        },
        timeoutMessage: () =>
            `${name} was signed in, but its desktop app did not come online within two minutes. ` +
            'If Puca is not set to start with Windows on that computer, open it there — ' +
            'or press Control here once it is running.',
        openFailedMessage: why => `${name} is signed in, but the session could not be opened: ${why}`,
        // Poll immediately: after an unlock of an already-running desktop the
        // app row is online NOW, and waiting a full interval before looking
        // is a visible pause for nothing.
        pollNow: true,
    });
}

/**
 * Follow a machine from its signed-in desktop to its SIGN-IN SCREEN — the
 * mirror of `followToDesktop`, for the "Lock" action.
 *
 * Called when the host ended the session with the lock-handover reason (see
 * `LOCK_HANDOVER_REASON` in session.ts): the controller asked the desktop to
 * lock, the desktop app can no longer capture (a user-token agent cannot see
 * the secure desktop), and the picture now lives on the machine's sign-in-
 * screen row — the SYSTEM service, which comes online the moment the console
 * locks. This waits for that row and connects there, so "Lock" from a phone
 * lands on the PIN box instead of a dead session.
 *
 * A machine with NO sign-in row (sign-in-screen access never set up) has
 * nowhere to follow to: say so on the card and stop — that is a legitimate
 * configuration, and the user should be told the session ended because of it
 * rather than watch a two-minute wait time out.
 */
export async function followToSignIn(
    appRowId: string,
    userId: number,
): Promise<void> {
    let all: VerifiedDevice[];
    try {
        all = await listDevices(userId);
    } catch {
        return;
    }
    const machine = machineOf(await groupIntoMachines(all), appRowId);
    if (!machine) return;
    const cardId = machine.primary.id;
    const name = machine.primary.name;
    if (!machine.signInRow) {
        // Nothing to move to. Honest end, no wait.
        set(cardId, 'failed', `${name} is locked. Sign-in-screen access is not set up on it, so the session ended — set it up in the device's Advanced settings to keep control while it is locked.`);
        return;
    }
    const signInRowId = machine.signInRow.id;
    if (attemptInFlight(cardId)) {
        clearTimers(cardId);
    }
    const token = beginAttempt(cardId);
    set(
        cardId,
        'following',
        `Locked ${name} — waiting for its sign-in screen to come online so the session can move there…`,
        Math.round(FOLLOW_TIMEOUT_MS / 1000),
    );
    watchForRow({
        cardId,
        token,
        userId,
        phase: 'following',
        timeoutMs: FOLLOW_TIMEOUT_MS,
        pollMs: FOLLOW_POLL_MS,
        // The row to move to is the sign-in row, once online and verified. The
        // app row may still read online for a moment after its DeviceEnd, so
        // the pick is by id, not by "whichever row is up".
        pick: m => {
            const row = m?.rows.find(r => r.id === signInRowId && r.online && r.verified) ?? null;
            if (!row) return null;
            return { row, connectingMessage: `${name} is locked — opening its sign-in screen…` };
        },
        timeoutMessage: () =>
            `${name} was locked, but its sign-in screen did not come online within two minutes. ` +
            'Press Control here once its card shows the sign-in screen as online.',
        openFailedMessage: why => `${name} is locked, but the session could not be opened: ${why}`,
        pollNow: true,
    });
}

/**
 * The shared wait: poll the device list until `pick` finds a row, connect to
 * it, or give up at the deadline. Both the wake and the unlock-follow are this
 * loop with a different predicate and a different story.
 */
function watchForRow(opts: {
    cardId: string;
    token: number;
    userId: number;
    /** The live phase to keep the countdown ticking under. */
    phase: 'waiting' | 'following';
    timeoutMs: number;
    pollMs: number;
    /** From the freshly re-grouped machines, the row to connect to (or null to
     *  keep waiting) and what to say while opening it. */
    pick: (machine: Machine | null) => { row: VerifiedDevice; connectingMessage: string } | null;
    /** The verdict at the deadline. */
    timeoutMessage: () => string;
    /** The row appeared but connectToDevice threw. */
    openFailedMessage: (why: string) => string;
    /** Run the first poll immediately rather than after one interval. */
    pollNow?: boolean;
}): void {
    const { cardId, token, userId, phase, timeoutMs, pollMs } = opts;
    const startedAt = Date.now();
    let polling = false;
    // The reason the LAST connect attempt failed, if any. A follow-connect can
    // fail TRANSIENTLY (the target's desktop app racing the unlock transition —
    // its first capture-open lands on the still-secure desktop), so a single
    // stumble must not be terminal; the poll retries within the deadline. This
    // is only surfaced if the deadline itself expires, to say WHY rather than a
    // generic "did not come online".
    let lastConnectError: string | null = null;

    const tick = async () => {
        // One poll at a time. `listDevices` verifies a signature per device
        // and can outlast the interval on a slow link; two overlapping polls
        // both observing "it's back" would each call connectToDevice.
        if (polling || !isCurrent(cardId, token)) return;
        polling = true;
        try {
            const left = Math.max(0, timeoutMs - (Date.now() - startedAt));
            let devices: VerifiedDevice[];
            try {
                devices = await listDevices(userId);
            } catch {
                // Transient; the deadline still governs. Keep the countdown
                // moving so a flaky link does not look like a frozen UI.
                const current = states.get(cardId);
                if (current?.phase === phase && isCurrent(cardId, token)) {
                    set(cardId, phase, current.message, Math.round(left / 1000));
                }
                return;
            }
            if (!isCurrent(cardId, token)) return;

            // Re-grouped from the FRESH list each poll, because the row we
            // are waiting for may not have existed in the list this attempt
            // started from.
            const machine = machineOf(await groupIntoMachines(devices), cardId);
            if (!isCurrent(cardId, token)) return;
            const found = opts.pick(machine);
            if (!found) {
                const current = states.get(cardId);
                if (current?.phase === phase) {
                    set(cardId, phase, current.message, Math.round(left / 1000));
                }
                return;
            }

            // NOTE: timers are NOT cleared before the attempt. clearTimers
            // stops both the poll and the deadline; doing it here meant a
            // single connect failure could never retry, even with the whole
            // deadline budget unspent. Only a SUCCESS clears them (below); a
            // failure leaves the poll running so the next tick re-attempts —
            // which is exactly what a manual Connect did after the auto-follow
            // gave up. The `polling` guard already prevents overlapping ticks
            // while a connect is in flight.
            set(cardId, 'connecting', found.connectingMessage);
            try {
                await connectToDevice(found.row.id);
                if (!isCurrent(cardId, token)) return;
                clearTimers(cardId);
                // The session UI takes over from here; drop our status so
                // the card does not keep a stale "connecting" line under a
                // live session.
                states.delete(cardId);
                emit();
            } catch (e) {
                // Only if this attempt is still the live one: a failure
                // arriving after the user cancelled must not resurrect a
                // dismissed card as an error they cannot get rid of.
                if (!isCurrent(cardId, token)) return;
                // Transient by default: remember why, keep waiting under the
                // SAME deadline, and let the next poll retry. Only the deadline
                // expiry turns a persistently-failing follow into 'failed'.
                lastConnectError = e instanceof Error ? e.message : String(e);
                console.info('[wake] follow connect failed; will retry within the window:', lastConnectError);
                const left = Math.max(0, timeoutMs - (Date.now() - startedAt));
                set(cardId, phase, found.connectingMessage, Math.round(left / 1000));
            }
        } finally {
            polling = false;
        }
    };

    const poll = window.setInterval(() => { void tick(); }, pollMs);
    const deadline = window.setTimeout(() => {
        if (!isCurrent(cardId, token)) return;
        clearTimers(cardId);
        // If we actually reached the target and it kept refusing the open, say
        // WHY (openFailedMessage) rather than "it never came online" — the row
        // clearly did. Only when no connect was ever attempted does the generic
        // timeout message apply.
        set(cardId, 'failed', lastConnectError
            ? opts.openFailedMessage(lastConnectError)
            : opts.timeoutMessage());
    }, timeoutMs);
    // LOOK EARLY when the server says one of our devices just attested. The
    // poll is the guarantee; this is what makes the wait end within a second
    // of the machine coming up instead of up to one interval later. Harmless
    // against a server that never sends it. Any device's frame is a reason
    // to look — `tick` re-groups and decides; a stray look costs one list.
    const onPresence = () => { void tick(); };
    wsClient.on('DevicePresence', onPresence);
    timers.set(cardId, { poll, deadline, unsub: () => wsClient.off('DevicePresence', onPresence) });
    if (opts.pollNow) void tick();
}

/** Does the machine this target belongs to have a sign-in-screen row grouped
 *  with it — i.e. would a cold boot to the Windows login screen be VISIBLE to
 *  the wait, or would the machine come up and stay invisibly unreachable? */
async function targetHasSignInRow(target: VerifiedDevice, all: VerifiedDevice[]): Promise<boolean> {
    try {
        const machine = machineOf(await groupIntoMachines(all), target.id);
        return machine?.signInRow !== null && machine?.signInRow !== undefined;
    } catch {
        return false;
    }
}

/**
 * The three-minute verdict — HONEST about what it can and cannot conclude.
 *
 * Exported for the test. The previous text claimed a timeout "means the packet
 * did not wake it rather than that it came back unreachable" UNCONDITIONALLY.
 * That is only true when a sign-in-screen row was actually being watched. If
 * it was not (sign-in access never enrolled, or its row never got a MAC and so
 * never grouped), the machine may well have woken — to a login screen the
 * wait could not see — and blaming the BIOS sends someone to reflash firmware
 * over a software gap. Say which case this is.
 */
export function timeoutMessage(name: string, watchedSignIn: boolean): string {
    const head =
        `${name} did not come back within three minutes. The wake signal was sent, but nothing can confirm it arrived — ` +
        'check that Wake-on-LAN is enabled in its BIOS and network adapter, and that Windows Fast Startup is off (it makes ' +
        '"Shut down" a hybrid hibernate that usually cannot be woken). Wired Ethernet only; Wi-Fi almost never works. ';
    if (watchedSignIn) {
        return head +
            'This machine has sign-in-screen access, so it would have been reachable the moment it reached its login ' +
            'screen — a timeout here means the packet did not wake it.';
    }
    return head +
        'A machine that was fully shut down comes back at the Windows sign-in screen, where Puca has not started ' +
        'yet — so it may have woken and simply be unreachable. Turn on "Reach this computer after it restarts" on it ' +
        'to be able to connect there.';
}

/** True when the target's recorded interface was wired, false when it was
 *  Wi-Fi, null when unknown. Split out so `wakeAndConnect` reads linearly. */
async function targetWasWired(target: VerifiedDevice): Promise<boolean | null> {
    try {
        const lan = await openLanInfo(target.lan_info);
        return typeof lan?.wired === 'boolean' ? lan.wired : null;
    } catch {
        return null;
    }
}

/** Test seam. */
export function __resetWakeSessionsForTests(): void {
    cancelAllWakes();
    listeners.clear();
}
