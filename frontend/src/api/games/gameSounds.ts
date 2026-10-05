/**
 * Plays the card table's sounds (docs/GAMES.md, *Sounds*).
 *
 * WHEN NOTHING PLAYS - checked before anything is created, and again right
 * before the sounds are scheduled (a deafen can land in between):
 *   - Settings > Notifications > Card game sounds is off (also the table's
 *     own speaker button), or Enable Sounds is off altogether;
 *   - you are deafened in the call (voiceState's self-deafen mirror);
 *   - the master Output Volume is 0.
 *
 * HOW IT PLAYS. Like every other app sound (utils/audioFeedback.ts): one
 * AudioContext, created on the first sound that is actually wanted, routed to
 * the Output Device chosen in Settings BEFORE anything is scheduled on it
 * (a fresh context is born on the OS default - possibly a streaming host's
 * virtual cable), following later device changes, and at the game level
 * times the master Output Volume. A context the browser holds suspended for
 * want of a click is resumed; sounds still waiting after STALE_MS are dropped
 * rather than played late.
 */
import { applyOutputDeviceToContext, loadSettings, outputGain } from '../../components/settingsStore';
import { isSelfDeafened } from '../../components/voiceState';
import { synthCue } from './gameSynth';
import type { TimedCue } from './gameTimeline';

/** The loudest any one game sound gets at 100% Output Volume. The app's own
 *  join chime peaks at 0.3; a sound that repeats every few seconds of play
 *  sits well under that. */
export const GAME_SOUND_LEVEL = 0.16;

/** Sounds that could not start within this long are dropped, not played late. */
const STALE_MS = 1500;

const TIMED_OUT = Symbol('timed out');
/** Settles after `ms` at the latest - with TIMED_OUT if `p` had not: a
 *  resume() the browser holds for want of a click, or a device switch that
 *  hangs, must not keep each frame's sounds waiting forever. */
const within = (p: Promise<unknown>, ms: number) =>
    Promise.race([p, new Promise<typeof TIMED_OUT>(r => setTimeout(() => r(TIMED_OUT), ms))]);

let ctx: AudioContext | null = null;
let routed: Promise<void> = Promise.resolve();
let followArmed = false;

/** Is the setting on (and the master sound switch)? Deafen is separate. */
export function gameSoundsSetting(): boolean {
    const s = loadSettings();
    return s.soundsEnabled !== false && s.gameSounds !== false;
}

function wanted(): boolean {
    return gameSoundsSetting() && !isSelfDeafened() && outputGain() > 0;
}

function context(): AudioContext | null {
    if (typeof AudioContext === 'undefined') return null;
    if (ctx && ctx.state === 'closed') ctx = null;
    if (!ctx) {
        try {
            ctx = new AudioContext({ latencyHint: 'interactive' });
        } catch {
            return null;
        }
        routed = applyOutputDeviceToContext(ctx);
    }
    if (!followArmed && typeof window !== 'undefined') {
        followArmed = true;
        const follow = () => {
            if (ctx && ctx.state !== 'closed') routed = applyOutputDeviceToContext(ctx);
        };
        window.addEventListener('settingsChanged', follow);
        navigator.mediaDevices?.addEventListener?.('devicechange', follow);
    }
    return ctx;
}

/**
 * Play one frame's sounds. Returns false when nothing will play (muted,
 * deafened, volume 0, no Web Audio); true when they were handed to the
 * context (they can still be dropped if it never wakes).
 */
export function playGameCues(cues: TimedCue[]): boolean {
    if (cues.length === 0 || !wanted()) return false;
    const c = context();
    if (!c) return false;
    const asked = Date.now();
    void Promise.all([within(routed, STALE_MS), c.state === 'suspended' ? within(c.resume(), STALE_MS) : undefined])
        .then(([route, resume]) => {
            // Never on a device we have not finished routing to, never late.
            if (route === TIMED_OUT || resume === TIMED_OUT || Date.now() - asked > STALE_MS) return;
            // Re-checked: deafened, muted or turned down while we waited.
            if (!wanted() || c.state !== 'running') return;
            const level = GAME_SOUND_LEVEL * outputGain();
            const t0 = c.currentTime + 0.03;
            for (const q of cues) synthCue(c, c.destination, q.cue, t0 + q.at, level);
        })
        .catch(() => { /* no user gesture yet: nothing plays */ });
    return true;
}

/** Tests only. */
export function resetGameSoundsForTests(): void {
    ctx = null;
    routed = Promise.resolve();
}
