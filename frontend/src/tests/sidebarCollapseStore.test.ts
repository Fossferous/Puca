// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { ALL_SERVERS, foldedCollections, foldedFrom, isCollapsed, toggleCollapsed } from '../components/sidebarCollapseStore';

// The global setup replaces localStorage with inert vi.fn()s; back them with a real Map so this
// suite tests STORAGE behaviour (same pattern as hiddenMessagesStore.test.ts).
const store = new Map<string, string>();

beforeEach(() => {
    (localStorage.getItem as Mock).mockImplementation((k: string) => store.get(k) ?? null);
    (localStorage.setItem as Mock).mockImplementation((k: string, v: string) => { store.set(k, String(v)); });
    (localStorage.removeItem as Mock).mockImplementation((k: string) => { store.delete(k); });
    (localStorage.clear as Mock).mockImplementation(() => store.clear());
    localStorage.clear();
});

describe('the folds of the channel list, per server and per device', () => {
    it('start open', () => {
        expect(isCollapsed('s1', 'text')).toBe(false);
    });

    it('toggle on and off, and say which they now are', () => {
        expect(toggleCollapsed('s1', 'text')).toBe(true);
        expect(isCollapsed('s1', 'text')).toBe(true);
        expect(toggleCollapsed('s1', 'text')).toBe(false);
        expect(isCollapsed('s1', 'text')).toBe(false);
    });

    it('belong to one server: folding one leaves the next as it was', () => {
        toggleCollapsed('s1', 'text');
        toggleCollapsed('s1', 'c7');
        expect(isCollapsed('s2', 'text')).toBe(false);
        expect(isCollapsed('s1', 'voice')).toBe(false);
        expect(foldedCollections(foldedFrom(localStorage.getItem('puca_sidebar_collapsed'), 's1'))).toEqual(new Set([7]));
    });

    it("keep the member list's panel under its own pseudo-server", () => {
        toggleCollapsed(ALL_SERVERS, 'active');
        expect(isCollapsed(ALL_SERVERS, 'active')).toBe(true);
        expect(isCollapsed('s1', 'active')).toBe(false);
    });

    it('announce a change so the sidebar redraws', () => {
        const seen = vi.fn();
        window.addEventListener('sidebarCollapseChanged', seen);
        toggleCollapsed('s1', 'voice');
        window.removeEventListener('sidebarCollapseChanged', seen);
        expect(seen).toHaveBeenCalledTimes(1);
    });

    it('still fold when storage cannot be written (quota, blocked site data), until reload', () => {
        (localStorage.setItem as Mock).mockImplementation(() => { throw new Error('QuotaExceededError'); });
        const seen = vi.fn();
        window.addEventListener('sidebarCollapseChanged', seen);
        expect(toggleCollapsed('s1', 'text')).toBe(true);
        expect(isCollapsed('s1', 'text')).toBe(true);
        expect(seen).toHaveBeenCalledTimes(1);
        expect(toggleCollapsed('s1', 'text')).toBe(false);
        expect(isCollapsed('s1', 'text')).toBe(false);
        window.removeEventListener('sidebarCollapseChanged', seen);
        // Writable again: the next toggle is stored, and the held copy is let go.
        (localStorage.setItem as Mock).mockImplementation((k: string, v: string) => { store.set(k, String(v)); });
        expect(toggleCollapsed('s1', 'voice')).toBe(true);
        expect(store.get('puca_sidebar_collapsed')).toContain('voice');
    });

    it('survive storage that holds rubbish', () => {
        localStorage.setItem('puca_sidebar_collapsed', '[1,2');
        expect(isCollapsed('s1', 'text')).toBe(false);
        expect(toggleCollapsed('s1', 'text')).toBe(true);
        localStorage.setItem('puca_sidebar_collapsed', JSON.stringify({ s1: 'text', s2: ['text', 3, null] }));
        expect(isCollapsed('s1', 'text')).toBe(false);
        expect(isCollapsed('s2', 'text')).toBe(true);
    });
});
