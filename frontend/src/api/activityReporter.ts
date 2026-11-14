/**
 * Tells the server, on each socket, whether the person at THIS device is
 * active — the input to idle/away presence (src/presence.rs).
 *
 * The owner's rule: idle after 10 minutes with no input ANYWHERE on the PC,
 * away after an hour. Someone in a game is not idle, so the desktop reads the
 * OS-wide last-input time (`get_idle_seconds`, GetLastInputInfo — one number,
 * nothing about what was typed). The web app and Android have no such probe
 * and use what the page can see: input in the page, and whether it is shown
 * at all (a backgrounded phone or a hidden tab is inactive at once). Speaking
 * in a call — the local speaking ring lit — counts as activity everywhere.
 *
 * The SERVER owns the 10-minute and 1-hour clocks. This module only reports
 * TRANSITIONS: `SetActivity { inactive_secs: null }` when the person is back,
 * `{ inactive_secs: n }` once they have been quiet for REPORT_AFTER_SECS
 * (n = how long). A phone's timers freeze when it is backgrounded, so it
 * could never report "an hour" itself — it reports the moment it goes, and
 * the server's sweep does the rest. No per-minute pulses.
 *
 * Never sent unless THIS socket's server confirmed `presence` in
 * ServerFeatures: an older server answers an unknown frame with an Error,
 * which the chat view shows as an error notice. Every socket that confirms
 * it is told the current state once (a fresh server session starts active).
 */
import { wsClient } from './websocket';
import { isTauri } from './platform';
import { hostIdleSeconds, hostReportsIdle } from './embedHost';
import { combineHostIdle } from '../utils/afkIdle';
import { globalSpeakingUsers, subscribeToSpeaking } from '../components/voiceState';

/** Quiet this long before a device says it is inactive. Well under the
 *  server's 10-minute idle clock, and long enough that a pause to read a
 *  message is not a transition at all. */
export const REPORT_AFTER_SECS = 60;

const DEFAULT_POLL_MS = 15_000;

/**
 * The poll while this device has told its server the person is gone AND an
 * OS-wide probe is what will see them come back (the desktop's
 * GetLastInputInfo, or an embedding host's idleSeconds). Input in the game
 * they return from never reaches the page, so the probe is the only way back
 * to green, and at the 15 s poll that took up to 15 s; at this it is about 3.
 * Only then: active, or with no probe (web, Android: input in the page and
 * showing it report back at once), the poll stays at DEFAULT_POLL_MS. The
 * desktop app starts WebView2 with background timer throttling off
 * (tauri.conf.json), so a minimised window keeps this cadence.
 */
export const IDLE_POLL_MS = 3_000;

export interface ActivityInputs {
    /** OS-wide seconds since the last input, or null when there is no probe. */
    osIdleSecs: number | null;
    /** Local activity the OS probe cannot see (or, without a probe, all of
     *  it): speech, and without a probe in-page input. Date.now() ms. */
    lastLocalActivityMs: number;
    /** The page is hidden (backgrounded app, minimised window, other tab). */
    hidden: boolean;
    /** When this user's own speaking ring was last lit (Date.now() ms; 0 =
     *  never). Talking keeps even a HIDDEN page active: a phone in a call
     *  with its screen locked is a person, not an empty room. */
    lastSpeechMs?: number;
    nowMs: number;
}

/**
 * The rule: null = active; a number = inactive for that many seconds.
 *
 * With an OS probe, the probe (and speech) decides and page visibility does
 * not — Púca minimised to the tray with a game in front is a busy person.
 * Without one, a hidden page is inactive at once (nothing in it can see the
 * person any more), a shown one after REPORT_AFTER_SECS without input.
 *
 * Always whole seconds: the server reads `inactive_secs` as an integer and
 * answers anything else with an Error frame, which Chat shows as a notice.
 * An embedding host's idle time comes with fractions.
 */
export function decideReport(i: ActivityInputs): number | null {
    const sinceLocal = Math.max(0, Math.floor((i.nowMs - i.lastLocalActivityMs) / 1000));
    if (i.osIdleSecs !== null) {
        const secs = Math.floor(Math.min(i.osIdleSecs, sinceLocal));
        return secs >= REPORT_AFTER_SECS ? secs : null;
    }
    if (i.hidden) {
        // Hidden: inactive at once — a backgrounded phone's timers freeze, so
        // this is the last chance to say so — unless the person is talking.
        const sinceSpeech = i.lastSpeechMs ? Math.floor((i.nowMs - i.lastSpeechMs) / 1000) : Infinity;
        return sinceSpeech < REPORT_AFTER_SECS ? null : sinceLocal;
    }
    return sinceLocal >= REPORT_AFTER_SECS ? sinceLocal : null;
}

/** The desktop's OS-wide probe; null where there is none (web, Android, and
 *  non-Windows desktops, where the command answers -1). */
async function osIdleProbe(): Promise<number | null> {
    if (!isTauri()) return null;
    const { invoke } = await import('@tauri-apps/api/core');
    const secs = await invoke<number>('get_idle_seconds');
    return typeof secs === 'number' && secs >= 0 ? secs : null;
}

export interface ReporterOptions {
    /** This account, to recognise its own speaking ring. */
    userId: number;
    /** Override the OS probe (tests). */
    probe?: () => Promise<number | null>;
    pollMs?: number;
    /** The poll while reported inactive with a probe answering (IDLE_POLL_MS). */
    idlePollMs?: number;
}

const INPUT_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'focus'] as const;

/** Start reporting; returns the stop function. One per signed-in session. */
export function startActivityReporter(opts: ReporterOptions): () => void {
    let lastInApp = Date.now(); // opening the app is activity
    // An embedding host sees input this page never does (Púca for Steam Deck:
    // the Deck's controls, during a call; docs/EMBEDDING.md, idleSeconds), so
    // it stands where the desktop's OS probe does. Input in the page still
    // counts, the more recent of the two deciding, as for the AFK move; a
    // host that cannot tell (null) leaves the page's own rules.
    const probe = opts.probe ?? (async () => (
        !isTauri() && hostReportsIdle()
            ? combineHostIdle(await hostIdleSeconds(), lastInApp, Date.now())
            : osIdleProbe()
    ));
    let lastSpeaking = 0;
    // What THIS socket's server was last told; null = nothing yet.
    let told: 'active' | 'inactive' | null = null;
    let stopped = false;
    // The last poll's probe answered: an OS-wide (or host) view of input.
    let probed = false;
    // ONE pending poll at a time, armed only by schedule(), and its cadence.
    let timer: ReturnType<typeof setTimeout> | null = null;
    let armedMs = 0;

    const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';
    const noteSpeaking = () => {
        if (globalSpeakingUsers.has(opts.userId)) lastSpeaking = Date.now();
    };

    /** The cadence the current state calls for: IDLE_POLL_MS while told
     *  inactive with a probe that will see the person come back. */
    const pollEvery = () => (told === 'inactive' && probed
        ? opts.idlePollMs ?? IDLE_POLL_MS
        : opts.pollMs ?? DEFAULT_POLL_MS);
    /** (Re)arm the next poll at that cadence. */
    const schedule = () => {
        if (timer !== null) clearTimeout(timer);
        timer = null;
        if (stopped) return;
        armedMs = pollEvery();
        timer = setTimeout(() => {
            timer = null;
            void evaluate().finally(schedule);
        }, armedMs);
    };

    const tell = (secs: number | null) => {
        if (stopped || !wsClient.hasServerFeature('presence')) return;
        const kind = secs === null ? 'active' : 'inactive';
        if (kind === told) return; // transitions only
        if (wsClient.send({ type: 'SetActivity', payload: { inactive_secs: secs } })) told = kind;
        // Gone idle: start the fast poll NOW, not after the slow poll's wait,
        // or coming back inside it would still take up to 15 s. (Back: the
        // armed fast poll runs once more and re-arms the slow one.)
        if (timer !== null && pollEvery() < armedMs) schedule();
    };

    const evaluate = async () => {
        if (stopped) return;
        let os: number | null = null;
        try {
            os = await probe();
        } catch {
            os = null; // a probe that fails falls back to what the page sees
        }
        if (stopped) return;
        probed = os !== null;
        noteSpeaking();
        const local = os !== null ? lastSpeaking : Math.max(lastInApp, lastSpeaking);
        tell(decideReport({
            osIdleSecs: os, lastLocalActivityMs: local, hidden: hidden(), lastSpeechMs: lastSpeaking, nowMs: Date.now(),
        }));
    };

    // Input in the page: back at once, no need to wait for the next poll.
    const onInput = () => {
        lastInApp = Date.now();
        if (told === 'inactive') tell(null);
    };
    const onVisibility = () => {
        if (hidden()) void evaluate();
        else onInput();
    };
    const onFeatures = () => {
        if (!wsClient.hasServerFeature('presence')) return;
        told = null; // a new server session: tell it the current state once
        void evaluate();
    };
    const onClosed = () => { told = null; };

    const opt = { capture: true, passive: true } as AddEventListenerOptions;
    for (const ev of INPUT_EVENTS) window.addEventListener(ev, onInput, opt);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('wsClosed', onClosed);
    wsClient.on('ServerFeatures', onFeatures);
    const unsubscribeSpeaking = subscribeToSpeaking(() => {
        noteSpeaking();
        if (globalSpeakingUsers.has(opts.userId) && told === 'inactive') tell(null);
    });
    schedule();

    // The socket may have confirmed the capability before this started.
    if (wsClient.hasServerFeature('presence')) void evaluate();

    return () => {
        stopped = true;
        if (timer !== null) clearTimeout(timer);
        timer = null;
        for (const ev of INPUT_EVENTS) window.removeEventListener(ev, onInput, opt);
        document.removeEventListener('visibilitychange', onVisibility);
        window.removeEventListener('wsClosed', onClosed);
        wsClient.off('ServerFeatures', onFeatures);
        unsubscribeSpeaking();
    };
}
