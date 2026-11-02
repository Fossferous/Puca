/**
 * The "voice hotkeys" section of the diagnostics report: enough to settle a
 * report of a stuck push-to-talk or push-to-mute from the file alone. How is the
 * person set up (input mode, what they bound), what does the page believe is held
 * right now, and what does the native feed believe.
 *
 * THIS MUST NOT BECOME A KEYLOGGER. It prints action names, the keys the person
 * bound as hotkeys, and counts. Nothing in hotkeys.ts or hotkeys.rs records any
 * other key, and this reads the native feed's answer through a list of named
 * fields of known type, not by printing all of it, so a field added there later
 * reaches a report only if someone decides it should. The foreground process's
 * name is left out on the same footing: "something elevated is in front" is what
 * this section needs, and puca.log already says which, when it happens.
 */
import { BIND_FIELDS } from '../components/keybindFields';
import { loadSettings, type KeyBinding, type Settings } from '../components/settingsStore';
import { isVoiceBindField, voiceBindScope } from './hotkeyScope';
import { hotkeyFeedState, nativeDiag, type HotkeyFeedState } from './hotkeys';
import { QUICK_TIMEOUT_MS, withTimeout } from './withTimeout';

/** Of everything `hotkey_diag` answers (hotkeys.rs, diag), what a report carries. */
const NATIVE_FIELDS = [
    'active', 'hook_live', 'mouse_hook_wanted', 'mouse_hook_live', 'watching', 'events_seen',
    'starts', 'stops', 'rearms', 'rearms_on_evidence', 'poll_presses', 'poll_releases', 'poll_releases_blocked',
    'releases_owed', 'poll_presses_suppressed', 'releases_on_rewrite', 'injected_inputs_held', 'down_bits',
    'self_injected_bits',
] as const;

/** Enough of the start/stop history to see what a save did. */
const FEED_LOG_LINES = 12;

const yesNo = (v: unknown): string => (v === true ? 'yes' : 'no');

function describeBinding(b: KeyBinding | null | undefined): string {
    if (!b) return 'not set';
    const label = String(b.label ?? '?').replace(/\s+/g, ' ').trim().slice(0, 24);
    const combo = [b.ctrl && 'Ctrl', b.alt && 'Alt', b.shift && 'Shift', label].filter(Boolean).join('+');
    return `${combo} (vk ${b.keyCode})`;
}

function watchPairs(watch: { ids: string[]; keys: number[] } | null | undefined): string {
    if (!watch) return 'nothing';
    return watch.ids.map((id, i) => `${id}=${watch.keys[i]}`).join(' ') || 'nothing';
}

/** A number, a yes/no or a list of numbers, and nothing else: a string has no
 *  business being in this line, whatever the native side starts sending. */
function nativeValue(v: unknown): string | null {
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (Array.isArray(v) && v.every(n => typeof n === 'number')) return `[${v.join(',')}]`;
    return null;
}

function nativeLine(native: unknown): string {
    if (typeof native === 'string') return `native      (${native})`;
    if (!native || typeof native !== 'object') return 'native      (no answer)';
    const answer = native as Record<string, unknown>;
    if (answer.platform === 'web') return 'native      none (no global hook in a browser)';
    const fields = NATIVE_FIELDS.flatMap(name => {
        const value = nativeValue(answer[name]);
        return value === null ? [] : [`${name}=${value}`];
    });
    return `native      ${fields.join(' ') || '(no answer)'}`;
}

/** A feed log entry's time as something a reader can use: the local clock, which
 *  is what puca.log prints, and how long before this report that was. `at` alone
 *  is milliseconds since the page loaded, which no one reading a file can place. */
function feedLogWhen(now: number, at: number): string {
    const age = Math.max(0, now - at);
    const clock = new Date(Date.now() - age).toTimeString().slice(0, 8);
    const seconds = age / 1000;
    return `${clock}, ${seconds < 120 ? `${seconds.toFixed(1)} s` : `${Math.round(seconds / 60)} min`} ago`;
}

export interface HotkeyReportInput {
    settings: Settings;
    feed: HotkeyFeedState;
    /** `hotkey_diag`'s answer, or a sentence saying why there is none. */
    native: unknown;
}

export function hotkeyReportLines({ settings, feed, native }: HotkeyReportInput): string[] {
    const { host } = feed;
    const lines = [`input mode  ${settings.voiceInputMode}`];
    if (typeof host?.voiceInputMode === 'string' && host.voiceInputMode !== settings.voiceInputMode) {
        lines.push(`            this call is in ${host.voiceInputMode}`);
    }
    lines.push(`other apps  ${settings.globalVoiceHotkeys === true ? 'on' : 'off'} (Use Mute and Deafen from other apps)`);
    // Every row of the Keybinds tab, not only the voice ones: a non-voice row is
    // what shows an overlap with a voice bind.
    for (const [field, name] of BIND_FIELDS) {
        const scope = isVoiceBindField(field) ? `, ${voiceBindScope(settings, field)}` : '';
        lines.push(`bind        ${name}: ${describeBinding(settings[field])}${settings[field] ? scope : ''}`);
    }
    lines.push(host && !('error' in host)
        ? `call        in voice: ${yesNo(host.isInVoice)}, AFK channel: ${yesNo(host.isAfkChannel)}, listen only: ${yesNo(host.listenOnly)}, speak denied: ${yesNo(host.speakDenied)}, clip buffer armed: ${yesNo(host.clipArmed)}`
        : 'call        (the voice panel has not said)');
    lines.push(`feed        live: ${yesNo(feed.active)}, covers: ${feed.allowed?.join(' ') || 'nothing'}, last asked to watch: ${watchPairs(feed.requested)}`);
    lines.push(`held now    ${feed.held.join(' ') || 'nothing'}`);
    const history = feed.blockerSeen > 0 ? `; elevated windows have come to the front ${feed.blockerSeen} time(s) since the app started` : '';
    lines.push(`in front    ${feed.blocker ? 'an elevated window: no capture method can see its keys' : 'nothing known to hide keys'}${history}`);
    lines.push(`presses     deferred to the native feed: ${feed.ownershipDeferrals}, fired by it: ${feed.nativeDispatches}`);
    lines.push(nativeLine(native));
    for (const entry of feed.log.slice(-FEED_LOG_LINES)) {
        const watch = entry.ids && entry.keys ? watchPairs({ ids: entry.ids, keys: entry.keys }) : 'nothing';
        lines.push(`feed log    ${feedLogWhen(feed.now, entry.at)}: ${entry.kind} (${entry.reason}): ${watch} -> ${entry.result}`);
    }
    return lines;
}

/** The section, gathered. What the page believes is read first, so it describes
 *  the moment the report was asked for and not the native side's answer. */
export async function hotkeyReportSection(): Promise<string[]> {
    const settings = loadSettings();
    const feed = hotkeyFeedState();
    let native: unknown;
    try {
        native = await withTimeout(nativeDiag(), QUICK_TIMEOUT_MS, 'the native hotkey feed');
    } catch (e) {
        native = e instanceof Error ? e.message : String(e);
    }
    return hotkeyReportLines({ settings, feed, native });
}
