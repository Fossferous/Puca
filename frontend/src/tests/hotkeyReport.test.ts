// @vitest-environment jsdom
/**
 * The "voice hotkeys" section of Send diagnostics / Copy diagnostics.
 *
 * Two jobs, and the second is a hard rule. It has to be able to settle a report
 * of a stuck key from the file alone, and it must never become a keylogger:
 * action names and the keys the person bound, nothing else.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const { nativeAnswer } = vi.hoisted(() => ({ nativeAnswer: vi.fn() }));

vi.mock('../api/hotkeys', async (importOriginal) => ({
    ...await importOriginal<typeof import('../api/hotkeys')>(),
    nativeDiag: nativeAnswer,
}));

import {
    handleNativeHotkeyPayload, hotkeyFeedState, nativeKeyEvent, registerHold, registerPress,
    resetHotkeysForTest, setCaptureBlockerForTest, setNativeFeedHost, setNativeFeedStateForTest,
} from '../api/hotkeys';
import { hotkeyReportLines, hotkeyReportSection } from '../api/hotkeyReport';
import { defaultSettings, type KeyBinding, type Settings } from '../components/settingsStore';
import { QUICK_TIMEOUT_MS } from '../api/withTimeout';

const V: KeyBinding = { keyCode: 86, ctrl: false, alt: false, shift: false, label: 'V' };
const MOUSE4: KeyBinding = { keyCode: 5, ctrl: false, alt: false, shift: false, label: 'Mouse 4' };
const up = { ctrlKey: false, altKey: false, shiftKey: false };

const settings: Settings = {
    ...defaultSettings,
    voiceInputMode: 'pushToMute',
    pttBinding: null,
    ptmBinding: V,
    saveClipBinding: MOUSE4,
};

function typed(keyCode: number): void {
    for (const type of ['keydown', 'keyup']) {
        const e = new KeyboardEvent(type, { bubbles: true });
        Object.defineProperty(e, 'keyCode', { value: keyCode });
        window.dispatchEvent(e);
    }
}

beforeEach(() => {
    nativeAnswer.mockReset().mockResolvedValue({ platform: 'web' });
});
afterEach(() => {
    setNativeFeedHost(null);
    resetHotkeysForTest();
    vi.mocked(localStorage.getItem).mockReset();
});

/** The profile on disk (setup.ts makes localStorage a stand-in that remembers nothing). */
const storedSettings = (stored: Settings) => vi.mocked(localStorage.getItem)
    .mockImplementation(key => (key === 'sovereign_settings' ? JSON.stringify(stored) : null));

const report = (over: Partial<Parameters<typeof hotkeyReportLines>[0]> = {}) =>
    hotkeyReportLines({ settings, feed: hotkeyFeedState(), native: { platform: 'web' }, ...over }).join('\n');

describe('what the section says', () => {
    it('names the input mode and every binding the person configured', () => {
        const text = report();
        expect(text).toContain('input mode  pushToMute');
        expect(text).toContain('bind        Push to Mute: V (vk 86)');
        expect(text).toContain('bind        Push to Talk: not set');
        expect(text).toContain('bind        Save clip: Mouse 4 (vk 5)');
        expect(text).toContain('bind        Toggle Mute: Ctrl+Shift+M (vk 77), in-app:default');
        expect(text).toContain('other apps  off');
    });

    it('says when the call is not in the mode the settings say', () => {
        setNativeFeedHost(() => ({ voiceInputMode: 'open' }));
        expect(report()).toContain('this call is in open');
        // Positive control.
        setNativeFeedHost(() => ({ voiceInputMode: 'pushToMute' }));
        expect(report()).not.toContain('this call is in');
    });

    it('says what is held right now, by action', () => {
        registerHold('voice.ptm', () => V, { onDown: () => {}, onUp: () => {} });
        expect(report()).toContain('held now    nothing');
        nativeKeyEvent('down', { keyCode: 86, ...up });
        expect(report()).toContain('held now    voice.ptm');
    });

    it('says what the voice panel knows about the call', () => {
        setNativeFeedHost(() => ({ isInVoice: true, isAfkChannel: false, listenOnly: true, speakDenied: false, clipArmed: false }));
        expect(report()).toContain('in voice: yes, AFK channel: no, listen only: yes, speak denied: no, clip buffer armed: no');
    });

    // No SPEAK joins listen-only and drops every mic hotkey, while a plain
    // listen-only call keeps Toggle Mute watched. Same `listen only: yes`, same
    // empty feed: without this the first reads as a feed bug.
    it('tells a channel permission from a listen-only call', () => {
        setNativeFeedHost(() => ({ isInVoice: true, listenOnly: true, speakDenied: true }));
        expect(report()).toContain('listen only: yes, speak denied: yes');
    });

    it('the voice panel really does say whether speaking is denied', () => {
        const panel = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../components/VoicePanel.tsx'), 'utf8');
        const snapshot = panel.slice(panel.indexOf('setNativeFeedHost(() => {'), panel.indexOf('return () => setNativeFeedHost(null)'));
        expect(snapshot, 'the snapshot is where this looks').toContain('listenOnly: listenOnlyRef.current');
        expect(snapshot).toContain('speakDenied: speakDeniedRef.current');
    });

    it('survives a voice panel that throws, as the debug snapshot always has', () => {
        setNativeFeedHost(() => { throw new Error('torn down'); });
        expect(report()).toContain('call        (the voice panel has not said)');
    });

    it('reports the counters that say the poll stepped in', () => {
        const text = report({ native: { hook_live: true, watching: [86, 77], poll_releases: 3, releases_on_rewrite: 1, down_bits: 0 } });
        expect(text).toContain('native      hook_live=true watching=[86,77] poll_releases=3 releases_on_rewrite=1 down_bits=0');
    });

    it('says plainly when there is no native feed to ask', () => {
        expect(report()).toContain('native      none (no global hook in a browser)');
    });

    // It clears on a click in an ordinary window or at the end of the call, and a
    // report is often made after both.
    it('an elevated window that has come and gone is still in the report', () => {
        expect(report()).not.toContain('elevated windows have come to the front');
        setCaptureBlockerForTest('game.exe');
        setCaptureBlockerForTest('');
        const text = report();
        expect(text).toContain('in front    nothing known to hide keys; elevated windows have come to the front 1 time(s)');
        expect(text).not.toContain('game.exe');
    });

    it('reports how many of the poll releases a hiding window produced, and what is still owed', () => {
        const text = report({ native: { poll_releases: 3, poll_releases_blocked: 2, releases_owed: 1 } });
        expect(text).toContain('poll_releases=3 poll_releases_blocked=2 releases_owed=1');
    });

    // `+8123456 ms` is milliseconds since the page loaded, and nothing else in
    // the report says how long ago that was.
    it('places each feed log line in time, on the clock puca.log uses', () => {
        vi.useFakeTimers({ now: new Date(2026, 10, 2, 12, 0, 0) });
        try {
            const feed = hotkeyFeedState();
            const entry = (agoMs: number, reason: string) => ({
                at: feed.now - agoMs, kind: 'start' as const, reason, ids: ['voice.ptt'], keys: [86], result: 'hooked',
            });
            const text = hotkeyReportLines({
                settings,
                feed: { ...feed, log: [entry(2_500, 'recent'), entry(3_600_000, 'old')] },
                native: { platform: 'web' },
            }).join('\n');
            expect(text).toContain('feed log    11:59:57, 2.5 s ago: start (recent): voice.ptt=86 -> hooked');
            expect(text).toContain('feed log    11:00:00, 60 min ago: start (old): voice.ptt=86 -> hooked');
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('it does not become a keylogger', () => {
    it('keys nobody bound leave no trace, whichever feed they came through', () => {
        registerHold('voice.ptm', () => V, { onDown: () => {}, onUp: () => {} });
        registerPress('voice.toggleMute', () => settings.toggleMuteBinding, () => {});
        setNativeFeedStateForTest(true, ['voice.ptm', 'voice.toggleMute']);
        const secret = 'hunter2';
        for (const ch of secret) {
            const vk = ch.toUpperCase().charCodeAt(0);
            typed(vk);
            handleNativeHotkeyPayload({ keyCode: vk, ...up, down: true, foreground: true });
            handleNativeHotkeyPayload({ keyCode: vk, ...up, down: false, foreground: true });
        }
        const text = report();
        // Only keys from the settings: every number that names a key.
        const named = [...text.matchAll(/vk (\d+)/g)].map(m => Number(m[1]));
        const bound = [settings.toggleMuteBinding, settings.toggleDeafenBinding, settings.openSettingsBinding,
            settings.searchBinding, settings.remoteControlKillKey, V, MOUSE4].map(b => b?.keyCode);
        for (const vk of named) expect(bound, `vk ${vk} is not a binding`).toContain(vk);
        // Positive control: the check above is looking at something.
        expect(named).toContain(86);
        expect(text.toLowerCase()).not.toContain(secret);
        // H, U, N, T, E, R as virtual-key numbers, anywhere at all.
        for (const vk of [72, 85, 78, 84, 69, 82]) expect(text).not.toMatch(new RegExp(`(^|[^0-9])${vk}([^0-9]|$)`, 'm'));
    });

    it('prints the native answer only through its named fields', () => {
        const text = report({ native: {
            hook_live: true,
            // None of these is in the list, and all of them are the kind of thing
            // that must not leave the machine because someone added a field.
            foreground_blocker: 'secret-game.exe',
            typed_recently: [72, 85, 78],
            last_key: 72,
        } });
        expect(text).toContain('hook_live=true');
        expect(text).not.toContain('secret-game');
        expect(text).not.toContain('typed_recently');
        expect(text).not.toContain('last_key');
    });

    it('a listed field that turns into text is dropped, not printed', () => {
        const text = report({ native: { watching: ['secret-game.exe'], hook_live: 'also-secret' } });
        expect(text).not.toContain('secret');
    });

    it('says an elevated window was last in front without naming it', () => {
        expect(report()).toContain('in front    nothing known to hide keys');
        setCaptureBlockerForTest('secret-game.exe');
        const text = report();
        expect(text).toContain('in front    an elevated window was last in front and is still running');
        expect(text).not.toContain('secret-game');
    });

    // The name is latched while Púca is in front, which is where a report is made:
    // the line must not read as "that window is in front now", and this says who is.
    it('carries who is in front now, beside the latched line', () => {
        setCaptureBlockerForTest('game.exe');
        const text = report({ native: { hook_live: true, foreground_is_us: true } });
        expect(text).toContain('foreground_is_us=true');
        expect(text).not.toContain('in front    an elevated window:');
        // CONTROL: the other answer is printed too, not only a true.
        expect(report({ native: { hook_live: true, foreground_is_us: false } })).toContain('foreground_is_us=false');
    });

    // `poll_releases_blocked` rising under a window that was never read can be the
    // hook losing a key-up (docs/HOTKEYS.md): this is the one field that says so.
    it('carries whether the window in front could be read', () => {
        const blocked = { hook_live: true, poll_releases_blocked: 1, releases_owed: 1 };
        expect(report({ native: { ...blocked, foreground_unreadable: true } })).toContain('foreground_unreadable=true');
        // CONTROL: the other answer is printed too, not only a true.
        expect(report({ native: { ...blocked, foreground_unreadable: false } })).toContain('foreground_unreadable=false');
    });

    it('the state it reads has no slot for a key press', () => {
        // This object is what could grow, so a new field here is a decision.
        const state = hotkeyFeedState();
        expect(Object.keys(state).sort()).toEqual([
            'active', 'allowed', 'blocker', 'blockerSeen', 'held', 'host', 'log', 'nativeDispatches', 'now',
            'ownershipDeferrals', 'registered', 'requested',
        ]);
    });
});

describe('gathering it', () => {
    it('reads the live settings', async () => {
        storedSettings(settings);
        const text = (await hotkeyReportSection()).join('\n');
        expect(text).toContain('input mode  pushToMute');
        expect(text).toContain('Push to Mute: V (vk 86)');
    });

    it('a native feed that never answers costs that line, not the section', async () => {
        vi.useFakeTimers();
        try {
            storedSettings(settings);
            nativeAnswer.mockImplementation(() => new Promise<never>(() => {}));
            const lines = hotkeyReportSection();
            await vi.advanceTimersByTimeAsync(QUICK_TIMEOUT_MS + 100);
            const text = (await lines).join('\n');
            expect(text).toMatch(/native {6}\(the native hotkey feed gave no answer/);
            expect(text).toContain('Push to Mute: V (vk 86)');
        } finally {
            vi.useRealTimers();
        }
    });
});
