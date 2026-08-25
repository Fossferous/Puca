import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import {
    hideMessage, unhideMessage, isMessageHidden, _resetHiddenMessagesCacheForTests,
} from '../components/hiddenMessagesStore';

// The global setup replaces localStorage with inert vi.fn()s; back them with a
// real Map so this suite tests STORAGE behaviour, not just the parse cache.
// (Same pattern as inputGain.test.ts.)
const store = new Map<string, string>();

/**
 * "Delete for Me" store. What matters here: per-ACCOUNT isolation (two
 * accounts on one device must not inherit each other's hidden messages —
 * the muted stores are deliberately device-global, this one must not be),
 * the change event consumers re-render on, and not trusting a corrupt blob.
 */

const tokenFor = (sub: number) =>
    `x.${btoa(JSON.stringify({ sub }))}.y`;

beforeEach(() => {
    (localStorage.getItem as Mock).mockImplementation((k: string) => store.get(k) ?? null);
    (localStorage.setItem as Mock).mockImplementation((k: string, v: string) => { store.set(k, String(v)); });
    (localStorage.removeItem as Mock).mockImplementation((k: string) => { store.delete(k); });
    (localStorage.clear as Mock).mockImplementation(() => store.clear());
    localStorage.clear();
    _resetHiddenMessagesCacheForTests();
    localStorage.setItem('auth_token', tokenFor(1));
});

describe('hiddenMessagesStore', () => {
    it('hides and unhides a message, firing the change event both ways', () => {
        const events: unknown[] = [];
        const listener = (e: Event) => events.push((e as CustomEvent).detail);
        window.addEventListener('hiddenMessagesChanged', listener);
        try {
            expect(isMessageHidden('m1')).toBe(false);
            hideMessage('m1');
            expect(isMessageHidden('m1')).toBe(true);
            unhideMessage('m1');
            expect(isMessageHidden('m1')).toBe(false);
            expect(events).toEqual([
                { messageId: 'm1', hidden: true },
                { messageId: 'm1', hidden: false },
            ]);
        } finally {
            window.removeEventListener('hiddenMessagesChanged', listener);
        }
    });

    it('unhide of an id that was never hidden is a silent no-op', () => {
        const spy = vi.fn();
        window.addEventListener('hiddenMessagesChanged', spy);
        try {
            unhideMessage('never-hidden');
            expect(spy).not.toHaveBeenCalled();
        } finally {
            window.removeEventListener('hiddenMessagesChanged', spy);
        }
    });

    it('scopes hidden messages per account — a second account sees nothing', () => {
        hideMessage('m1');
        expect(isMessageHidden('m1')).toBe(true);

        // Same device, different signed-in account.
        localStorage.setItem('auth_token', tokenFor(2));
        expect(isMessageHidden('m1')).toBe(false);
        hideMessage('m2');

        // Back to the first account: its own hide survives, the other's doesn't leak.
        localStorage.setItem('auth_token', tokenFor(1));
        expect(isMessageHidden('m1')).toBe(true);
        expect(isMessageHidden('m2')).toBe(false);
    });

    it('persists across a reread (storage-backed, not memory-only)', () => {
        hideMessage('m1');
        const raw = localStorage.getItem('sovereign_hidden_messages:1');
        expect(raw).toBeTruthy();
        expect(JSON.parse(raw!)).toEqual({ m1: true });
    });

    it('treats a corrupt blob as nothing hidden instead of crashing a render', () => {
        localStorage.setItem('sovereign_hidden_messages:1', '{not json');
        // The cache may hold an older parse; a different id forces a fresh
        // read path through the guarded parse either way.
        expect(isMessageHidden('whatever')).toBe(false);
        // And the store recovers: hiding after corruption works.
        hideMessage('m3');
        expect(isMessageHidden('m3')).toBe(true);
    });
});
