/**
 * Speaking state, and who re-renders when it changes.
 *
 * Measured 2026-09-26 (e2e/idle-call-cost.mjs): sitting in a 6-person call made
 * ~52 React commits a second. Each speaking flip re-built the roster, re-ran
 * the call's socket effect and notified the whole of Chat, and the other
 * readers polled because "a flip doesn't always emit". The contract now:
 *   - a flip emits exactly once, and a non-change emits nothing;
 *   - only the rows for THAT user re-render;
 *   - the periodic timers (typing cleanup, encryption poll) render nothing on
 *     a tick where nothing changed.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { act, Profiler, type ProfilerOnRenderCallback } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
    setUserSpeaking, clearSpeaking, subscribeToSpeaking, globalSpeakingUsers, isUserSpeaking,
} from '../components/voiceState';
import { SpeakingDiv, SpeakingLi } from '../components/SpeakingClass';
import { keepDetail, keepSummary, pruneExpiredTyping, type TypingEntry } from '../components/stableState';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => { clearSpeaking(); });

describe('the speaking store', () => {
    it('announces a flip once, and says nothing when nothing changed', () => {
        let calls = 0;
        const off = subscribeToSpeaking(() => { calls++; });
        setUserSpeaking(7, true);
        setUserSpeaking(7, true); // same state again: silent
        setUserSpeaking(7, false);
        setUserSpeaking(7, false);
        off();
        setUserSpeaking(7, true); // unsubscribed
        expect(calls).toBe(2);
        expect(isUserSpeaking(7)).toBe(true);
    });

    it('clears everybody at once when the call ends', () => {
        setUserSpeaking(1, true); setUserSpeaking(2, true);
        let calls = 0;
        const off = subscribeToSpeaking(() => { calls++; });
        clearSpeaking();
        clearSpeaking(); // already empty: silent
        off();
        expect(globalSpeakingUsers.size).toBe(0);
        expect(calls).toBe(1);
    });
});

describe('who re-renders on a flip', () => {
    let root: Root | null = null;
    let host: HTMLElement | null = null;
    afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; });

    it('only the rows of the user who started or stopped talking', () => {
        const renders = new Map<string, number>();
        const count: ProfilerOnRenderCallback = (id) => { renders.set(id, (renders.get(id) ?? 0) + 1); };
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        act(() => root!.render(
            <ul>
                <Profiler id="u1" onRender={count}><SpeakingLi userId={1} className="voice-user-item">one</SpeakingLi></Profiler>
                <Profiler id="u2" onRender={count}><SpeakingLi userId={2} className="voice-user-item">two</SpeakingLi></Profiler>
                <Profiler id="u2-ring" onRender={count}><SpeakingDiv userId={2} className="voice-user-avatar-small" /></Profiler>
            </ul>,
        ));
        renders.clear();

        act(() => setUserSpeaking(2, true));
        expect(renders.get('u1') ?? 0).toBe(0);
        expect(renders.get('u2')).toBe(1);
        expect(renders.get('u2-ring')).toBe(1);
        // POSITIVE CONTROL: the class really follows the voice.
        expect(host.querySelectorAll('.speaking').length).toBe(2);
        expect(host.querySelector('li.voice-user-item.speaking')?.textContent).toBe('two');

        act(() => setUserSpeaking(2, false));
        expect(host.querySelectorAll('.speaking').length).toBe(0);
        expect(renders.get('u1') ?? 0).toBe(0);
    });
});

describe('periodic ticks that change nothing', () => {
    it('keeps the same typing map when nobody stopped typing', () => {
        const prev = new Map<number, TypingEntry>([[1, { username: 'a', expiry: 10_000 }]]);
        expect(pruneExpiredTyping(prev, 5_000)).toBe(prev);
        // POSITIVE CONTROL: an expiry does produce a new map, without the entry.
        const pruned = pruneExpiredTyping(prev, 20_000);
        expect(pruned).not.toBe(prev);
        expect(pruned.size).toBe(0);
        expect(prev.size).toBe(1); // never mutates the previous state
    });

    it('keeps the same encryption summary and detail when nothing changed', () => {
        const a = { total: 5, encrypted: 5, supported: true, enforced: false };
        expect(keepSummary(a, { ...a })).toBe(a);
        expect(keepSummary(a, { ...a, encrypted: 4 })).not.toBe(a);
        const d = [{ userId: 1, encrypted: true, reason: 'encrypted' as const }];
        expect(keepDetail(d, [{ ...d[0] }])).toBe(d);
        expect(keepDetail(d, [{ ...d[0], encrypted: false }])).not.toBe(d);
        expect(keepDetail(d, [])).not.toBe(d);
    });
});
