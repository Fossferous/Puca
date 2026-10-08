/**
 * The microphone's device watchdog: what a live call does when the audio
 * devices under it change.
 *
 * A Bluetooth headset walking out of range used to kill a call's audio both
 * ways with nothing noticing (the raw capture dies inside the noise graph
 * while the PUBLISHED Web Audio track keeps emitting silence), and leaving and
 * rejoining was the only fix. Four signals now feed one recovery:
 *
 *   - 'sovereign:mic-device-lost' (media.ts): the raw track ended, or sat
 *     muted for 3 s -> restart the mic through the current pipeline NOW.
 *   - devicechange: a device (re)appeared or vanished, or an OS default moved
 *     -> re-route every playing element to the chosen sink, and restart the
 *     mic if we are listen-only, holding a dead/muted track, holding the
 *     fallback while the chosen device is back, or holding the device the
 *     followed default USED to name (below).
 *   - the desktop shell's own Windows default-device notification
 *     (mic_default_watch.rs, event MIC_DEFAULT_EVENT): the same check as a
 *     devicechange. Chromium does fire devicechange for a default-only change
 *     on Windows (since M65 its IMMNotificationClient reports default changes
 *     to the device monitor, and the 'default' entry's label and groupId
 *     change), so this is belt and braces, plus a puca.log line naming the
 *     new endpoint even when the page is the thing that went wrong.
 *   - visibilitychange -> visible: mobile can park capture and swallow device
 *     events while backgrounded; re-evaluate on return.
 *
 * FOLLOWING THE DEFAULT (the owner's report, 2026-10-07). On "Default", the
 * call captures Chromium's 'default' pseudo-device, which is resolved ONCE,
 * when the capture opens: Chromium never re-points a live capture. When the
 * OS default moved (Audio Hub switched it from a headset to a desk mic while
 * the headset stayed connected), the call kept recording the old device
 * until the member left and rejoined, because nothing died and the old check
 * only chased a capture whose deviceId was concrete — and on Chromium
 * desktop it is the literal string 'default', so it never did. The check is
 * now checkDefaultMoved(): the capture's groupId (fixed when it opened)
 * against the groupId the 'default' entry names NOW.
 *
 * Restarts go through VoicePanel's applyNoiseModeLive (re-acquire ->
 * replaceTrack on every mesh sender -> SFU republish -> re-assert the
 * mute/PTT gate), the one path every mic restart takes, and are coalesced:
 * one in flight, at most one queued. A default-follow restart asks the
 * re-acquire to KEEP the old capture if the new default cannot be opened:
 * the old device is still connected and working, so failing to move must
 * not cost the member their mic.
 *
 * NEVER LOOPS: a default-follow happens once per distinct default (the
 * entry's group + label), so a capture that can never match what the entry
 * says (an engine reporting groups inconsistently) costs one restart, not
 * one per event; and two follows are at least FOLLOW_MIN_GAP_MS apart, the
 * later one re-checked when the gap ends. The one exception is a follow that
 * could not OPEN the new default (another app holding it exclusively): that
 * is retried on a later device event, at most every FOLLOW_RETRY_MS, since
 * nothing changed and the device may have been freed since.
 */
import type { MicReacquireOptions, RawMicState } from './media';

/** Quiet time after the LAST device event before acting. Windows fires a
 *  burst per Bluetooth (dis)connect — each endpoint (hands-free and stereo,
 *  input and output) arriving separately, and an app such as Audio Hub
 *  moving the default in reaction to the arrival — spread over a few hundred
 *  milliseconds. 800 ms lets that settle into one decision made on the final
 *  state, and adds under a second to a switch that used to need a rejoin. */
export const SETTLE_MS = 800;
/** A stream of events that never goes quiet is still acted on this long
 *  after its first event. */
export const SETTLE_MAX_MS = 3000;
/** Two follows of a moving default are at least this far apart. */
export const FOLLOW_MIN_GAP_MS = 3000;
/** A follow whose new default would not open is tried again on a later
 *  device event, no sooner than this. */
export const FOLLOW_RETRY_MS = 30000;
/** A wedged-but-registered device can hand back another born-muted track;
 *  'muted' restarts are throttled to one per this long. */
export const MUTED_RESTART_MIN_GAP_MS = 15000;

/** Chromium's pseudo-devices: they follow the OS default for a role. */
export type PseudoInput = 'default' | 'communications';
const isPseudo = (id: string | undefined | null): id is PseudoInput =>
    id === 'default' || id === 'communications';

export type InputEntry = { deviceId: string; groupId: string; label: string };

/** What a check concluded. `key` names the default it found, for the
 *  once-per-default rule. */
export type DefaultVerdict =
    | { moved: false; why: string }
    | { moved: true; pseudo: PseudoInput; from: string; to: string; key: string };

/** `Default - Microphone (FMA120)` -> `Microphone (FMA120)`: for log lines
 *  only, never compared. */
export function plainLabel(label: string | undefined | null): string {
    const l = (label ?? '').trim();
    const m = /^(?:Default|Communications)\s+-\s+(.+)$/.exec(l);
    return (m ? m[1] : l) || '(unnamed)';
}

/** Which pseudo-device the member's input setting follows: 'default' for
 *  Default (`selection` null — selectedInputDeviceId's spelling of it),
 *  'communications' when they picked Chromium's Communications entry
 *  itself, and nothing for a specific microphone, which must never move. */
export function followedPseudo(selection: string | null): PseudoInput | null {
    if (selection === null) return 'default';
    return selection === 'communications' ? 'communications' : null;
}

/**
 * Has the device the followed default names moved away from the device the
 * live capture actually opened?
 *
 * Chromium desktop (WebView2 included) reports a capture of the 'default'
 * pseudo-device with deviceId 'default' and the groupId the entry had when
 * it opened, and the 'default' entry shares its groupId with the concrete
 * device it aliases. So the groups are the comparison; labels are compared
 * only when an engine gives no groups. An engine that opens the CONCRETE
 * device for a default request is compared through the alias instead.
 * Anything that cannot be compared is "not moved": a missed follow costs
 * what it cost before, a false one swaps a working mic for nothing.
 */
export function checkDefaultMoved(
    selection: string | null,
    capture: Pick<RawMicState, 'deviceId' | 'groupId' | 'label'>,
    inputs: InputEntry[],
): DefaultVerdict {
    const pseudo = followedPseudo(selection);
    if (!pseudo) return { moved: false, why: 'a specific microphone is selected' };
    const entry = inputs.find(d => d.deviceId === pseudo);
    if (!entry) return { moved: false, why: `no '${pseudo}' entry to follow` };
    const key = `${pseudo}|${entry.groupId}|${entry.label}`;
    const to = plainLabel(entry.label);
    const from = plainLabel(capture.label);
    if (capture.deviceId === pseudo) {
        if (capture.groupId && entry.groupId) {
            return capture.groupId === entry.groupId
                ? { moved: false, why: 'still the same device' }
                : { moved: true, pseudo, from, to, key };
        }
        if (capture.label && entry.label) {
            return capture.label === entry.label
                ? { moved: false, why: 'still the same device' }
                : { moved: true, pseudo, from, to, key };
        }
        return { moved: false, why: 'the capture names no group or label to compare' };
    }
    if (capture.deviceId && !isPseudo(capture.deviceId)) {
        if (!entry.groupId) return { moved: false, why: `the '${pseudo}' entry names no group` };
        const aliases = inputs.filter(d => !isPseudo(d.deviceId) && d.groupId === entry.groupId);
        if (aliases.length === 0) return { moved: false, why: `the '${pseudo}' entry names no listed device` };
        if (aliases.some(d => d.deviceId === capture.deviceId)) return { moved: false, why: 'still the same device' };
        return { moved: true, pseudo, from, to: plainLabel(aliases[0].label), key };
    }
    return { moved: false, why: `the capture is not on '${pseudo}'` };
}

/** `NotReadableError: Could not start audio source` — the NAME is what
 *  tells a busy device from a refused permission. For log lines. */
export function describeMicError(err: unknown): string {
    if (err && typeof err === 'object' && 'name' in err) {
        const e = err as { name?: unknown; message?: unknown };
        const msg = typeof e.message === 'string' && e.message ? `: ${e.message}` : '';
        return `${String(e.name)}${msg}`.slice(0, 200);
    }
    return String(err).slice(0, 200);
}

/** What a restart came to: undefined when it was not attempted (not in a
 *  call, no SPEAK). */
export type MicRestartOutcome =
    | { ok: true; swapped: boolean }
    /** `kept`: it failed opening the new mic, so the call still has the
     *  old one; otherwise it failed after the swap (publishing it). */
    | { ok: false; error: string; kept?: boolean };

/** The desktop shell's notification payload (mic_default_watch.rs). */
export type NativeDefaultChange = {
    /** Roles whose default moved: 'console' (what 'default' opens) and/or
     *  'communications'. */
    roles?: string[];
    /** Friendly names of the new defaults, '' when none is left. */
    console?: string | null;
    communications?: string | null;
};

export interface MicWatchdogDeps {
    mediaDevices: Pick<MediaDevices, 'enumerateDevices' | 'addEventListener' | 'removeEventListener'> | undefined;
    inVoice: () => boolean;
    isSpeakDenied: () => boolean;
    isListenOnly: () => boolean;
    rawMic: () => RawMicState | null;
    /** The chosen input: null = Default (selectedInputDeviceId). */
    selectedInput: () => string | null;
    restartMic: (opts: MicReacquireOptions) => Promise<MicRestartOutcome | undefined> | undefined;
    rerouteOutputs: () => void;
    log: (line: string) => void;
    /** The desktop shell's default-device notification; absent elsewhere. */
    subscribeNative?: (fn: (n: NativeDefaultChange) => void) => () => void;
    now?: () => number;
}

type Restart = { reason: string; keepOld: boolean; from?: string; to?: string; key?: string };

/** Start watching; returns the disposer. */
export function startMicDeviceWatchdog(d: MicWatchdogDeps): () => void {
    const now = d.now ?? (() => Date.now());
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let burstStart: number | null = null;
    let heard = { devicechange: 0, windows: 0 };
    let lastNative: NativeDefaultChange | null = null;
    let running = false;
    let queued: Restart | null = null;
    let lastMuteRestart = -Infinity;
    let lastFollowAt = -Infinity;
    let lastFollowKey: string | null = null;
    /** lastFollowKey's attempt could not open the new default. */
    let lastFollowFailed = false;
    let evaluating = false;
    let evaluateAgain = false;

    const restartMic = (r: Restart) => {
        if (disposed || !d.inVoice()) return;
        if (running) {
            // At most one queued. Keep the old capture only if EVERY request
            // merged into it was a default-follow: a lost device has nothing
            // left to keep.
            queued = queued
                ? { ...(r.keepOld ? queued : r), keepOld: queued.keepOld && r.keepOld }
                : r;
            return;
        }
        running = true;
        const t0 = now();
        Promise.resolve(d.restartMic({ keepOldOnFailure: r.keepOld }))
            .then(outcome => {
                const ms = Math.round(now() - t0);
                const after = d.rawMic();
                if (r.reason === 'default-moved') {
                    // Only a follow that never opened is worth another try.
                    if (r.key === lastFollowKey) lastFollowFailed = !!outcome && !outcome.ok && outcome.kept === true;
                    if (!outcome) d.log(`[mic] default input changed: ${r.from} -> ${r.to}; not re-acquired (left the call or no SPEAK)`);
                    else if (!outcome.ok) {
                        d.log(outcome.kept
                            ? `[mic] default input changed: ${r.from} -> ${r.to}; could not open it (${outcome.error}); kept ${r.from}`
                            : `[mic] default input changed: ${r.from} -> ${r.to}; re-acquired but the restart then failed after ${ms} ms (${outcome.error})`);
                    }
                    else if (outcome.swapped) d.log(`[mic] default input changed: ${r.from} -> ${plainLabel(after?.label || r.to)}; re-acquired in ${ms} ms`);
                    else d.log(`[mic] default input changed: ${r.from} -> ${r.to}; nothing was swapped (${ms} ms)`);
                } else if (outcome && !outcome.ok) {
                    d.log(`[mic] microphone restart (${r.reason}) failed after ${ms} ms: ${outcome.error}`);
                } else if (outcome) {
                    d.log(`[mic] microphone restart (${r.reason}) ${outcome.swapped ? `done in ${ms} ms, now ${plainLabel(after?.label)}` : `swapped nothing (${ms} ms)`}`
                        + (d.isListenOnly() ? '; no microphone could be opened, listen-only' : ''));
                }
            })
            .catch(() => { /* restartMic reports its own failures */ })
            .finally(() => {
                running = false;
                const q = queued;
                queued = null;
                if (q && !disposed) restartMic(q);
            });
    };

    const schedule = (ms: number) => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            timer = null;
            burstStart = null;
            void evaluate();
        }, Math.max(0, ms));
    };

    /** A device event: (re)start the settle wait, bounded by SETTLE_MAX_MS
     *  from the burst's first event. */
    const onEvent = (source: 'devicechange' | 'windows' | 'visible') => {
        if (disposed || !d.inVoice()) return;
        if (source !== 'visible') heard[source]++;
        const t = now();
        if (burstStart === null) burstStart = t;
        schedule(Math.min(SETTLE_MS, burstStart + SETTLE_MAX_MS - t));
    };

    const summary = (h: typeof heard): string => {
        const parts: string[] = [];
        if (h.devicechange) parts.push(`devicechange x${h.devicechange}`);
        if (h.windows) {
            const n = lastNative;
            const named = n?.roles?.length
                ? ` (${n.roles.join('+')}: ${plainLabel(n.console ?? n.communications)})`
                : '';
            parts.push(`windows default x${h.windows}${named}`);
        }
        return parts.join(', ');
    };

    const evaluate = async (): Promise<void> => {
        if (disposed) return;
        if (evaluating) { evaluateAgain = true; return; }
        const seen = heard;
        heard = { devicechange: 0, windows: 0 };
        if (!d.inVoice()) return;
        evaluating = true;
        const what = summary(seen);
        const note = (verdict: string) => { if (what) d.log(`[mic] devices changed (${what}): ${verdict}`); };
        try {
            // OUTPUT half: chase the chosen sink. applyOutputDevice routes
            // back to it when it reappears and falls back to the default when
            // it is gone, so the element keeps playing somewhere.
            d.rerouteOutputs();
            // INPUT half. Not for a member without SPEAK: "listen-only, so
            // retry the mic" is exactly the loop that must never run for them.
            if (d.isSpeakDenied()) { note('no SPEAK here, the microphone stays closed'); return; }
            const state = d.rawMic();
            const dead = d.isListenOnly() ? 'listen-only'
                : !state ? 'no capture open'
                    : state.ended ? 'the capture ended'
                        : state.muted ? 'the capture is muted' : null;
            if (dead) {
                d.log(`[mic] devices changed (${what || 'window visible again'}): ${dead}, restarting the microphone`);
                restartMic({ reason: dead, keepOld: false });
                return;
            }
            let inputs: InputEntry[];
            try {
                inputs = (await d.mediaDevices!.enumerateDevices())
                    .filter(x => x.kind === 'audioinput')
                    .map(x => ({ deviceId: x.deviceId, groupId: x.groupId, label: x.label }));
            } catch (e) {
                note(`cannot list devices (${String(e).slice(0, 120)})`);
                return;
            }
            if (disposed || !d.inVoice() || d.isSpeakDenied()) return;
            // Read the capture AGAIN: the enumerate was an await, and a
            // restart that finished meanwhile changed it.
            const cap = d.rawMic();
            if (!cap) return;
            const capName = `${plainLabel(cap.label)} [${cap.deviceId === 'default' || cap.deviceId === 'communications' ? cap.deviceId + ', ' : ''}grp ${(cap.groupId ?? '').slice(0, 6) || '?'}]`;
            const selected = d.selectedInput();
            if (selected !== null && !isPseudo(selected)) {
                // The device the member chose is back, but we are still
                // holding the fallback we degraded to while it was away.
                const back = !!cap.deviceId && cap.deviceId !== selected && inputs.some(x => x.deviceId === selected);
                if (back) {
                    d.log(`[mic] devices changed (${what || 'window visible again'}): the selected microphone is back (capturing ${capName}), restarting onto it`);
                    restartMic({ reason: 'selected microphone back', keepOld: false });
                } else {
                    note(`${inputs.length} inputs; a specific microphone is selected, capturing ${capName}: nothing to follow`);
                }
                return;
            }
            const v = checkDefaultMoved(selected, cap, inputs);
            const pseudo = followedPseudo(selected) ?? 'default';
            const entry = inputs.find(x => x.deviceId === pseudo);
            const target = entry ? `${plainLabel(entry.label)} [grp ${entry.groupId.slice(0, 6) || '?'}]` : 'none';
            if (!v.moved) {
                note(`${inputs.length} inputs; ${pseudo} -> ${target}; capturing ${capName}: ${v.why}`);
                return;
            }
            if (v.key === lastFollowKey && !(lastFollowFailed && now() - lastFollowAt >= FOLLOW_RETRY_MS)) {
                note(`${pseudo} -> ${target}; capturing ${capName}: `
                    + (lastFollowFailed ? `it would not open ${Math.round((now() - lastFollowAt) / 1000)} s ago; retrying after ${FOLLOW_RETRY_MS / 1000} s` : 'already followed this default once, not again'));
                return;
            }
            const wait = lastFollowAt + FOLLOW_MIN_GAP_MS - now();
            if (wait > 0) {
                note(`${pseudo} -> ${target}; capturing ${capName}: moved again within ${FOLLOW_MIN_GAP_MS} ms, re-checking in ${Math.round(wait)} ms`);
                schedule(wait);
                return;
            }
            lastFollowKey = v.key;
            lastFollowAt = now();
            lastFollowFailed = false;
            d.log(`[mic] devices changed (${what || 'window visible again'}): ${pseudo} -> ${target}; capturing ${capName}: the default moved, following it`);
            restartMic({ reason: 'default-moved', keepOld: true, from: v.from, to: v.to, key: v.key });
        } finally {
            evaluating = false;
            if (evaluateAgain && !disposed) { evaluateAgain = false; schedule(SETTLE_MS); }
        }
    };

    const onMicLost = (e: Event) => {
        if (disposed || !d.inVoice()) return;
        if (d.isSpeakDenied()) return; // nothing may re-open the mic
        const kind = (e as CustomEvent<{ kind?: string } | null>).detail?.kind;
        if (kind === 'muted') {
            // Real removals fire 'ended' or devicechange, which stay
            // unthrottled.
            const t = now();
            if (t - lastMuteRestart < MUTED_RESTART_MIN_GAP_MS) return;
            lastMuteRestart = t;
        }
        d.log(`[mic] microphone device lost (${kind ?? 'unknown'}), restarting the microphone`);
        restartMic({ reason: `device lost: ${kind ?? 'unknown'}`, keepOld: false });
    };
    const onDeviceChange = () => onEvent('devicechange');
    const onVisible = () => {
        if (document.visibilityState === 'visible') onEvent('visible');
    };

    window.addEventListener('sovereign:mic-device-lost', onMicLost);
    d.mediaDevices?.addEventListener?.('devicechange', onDeviceChange);
    document.addEventListener('visibilitychange', onVisible);
    const unNative = d.subscribeNative?.((n) => {
        lastNative = n;
        onEvent('windows');
    }) ?? null;

    return () => {
        disposed = true;
        window.removeEventListener('sovereign:mic-device-lost', onMicLost);
        d.mediaDevices?.removeEventListener?.('devicechange', onDeviceChange);
        document.removeEventListener('visibilitychange', onVisible);
        unNative?.();
        if (timer) clearTimeout(timer);
        timer = null;
    };
}
