/**
 * The two decisions NotesDesktopView makes for embedded Notes
 * (components/notesDesktopView.utils.ts):
 *
 *  - notesOwnsKey: whose a key press is, now that one window holds both the
 *    app and Notes, and Notes' shortcuts are bare letters. Every "no" is
 *    checked beside the same press getting a "yes" once that one reason is
 *    gone, so no case passes because the gate says no to everything.
 *  - whenIdentityReady: when the sealed on-device cache may be read back.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({ identity: null as null | object, seedOk: false }));
vi.mock('../api/e2ee', async importOriginal => ({
    ...(await importOriginal<typeof import('../api/e2ee')>()),
    getActiveIdentity: () => h.identity,
    seedMatchesCurrentAccount: () => h.seedOk,
}));

const { notesOwnsKey, whenIdentityReady } = await import('../components/notesDesktopView.utils');
const { registerPress, resetHotkeysForTest } = await import('../api/hotkeys');

let host: HTMLElement;
let inside: HTMLElement;
let outside: HTMLInputElement;

function key(init: KeyboardEventInit & { keyCode?: number }, target: EventTarget): KeyboardEvent {
    const e = new KeyboardEvent('keydown', init);
    Object.defineProperty(e, 'target', { value: target });
    if (init.keyCode !== undefined) Object.defineProperty(e, 'keyCode', { value: init.keyCode });
    return e;
}

beforeEach(() => {
    host = document.createElement('div');
    host.className = 'notes-desktop-view';
    inside = document.createElement('button');
    host.appendChild(inside);
    outside = document.createElement('input');
    document.body.append(host, outside);
});
afterEach(() => {
    document.body.innerHTML = '';
    resetHotkeysForTest();
    vi.restoreAllMocks();
    h.identity = null;
    h.seedOk = false;
    // jsdom has no elementFromPoint; a test that stubbed one takes it away.
    delete (document as { elementFromPoint?: unknown }).elementFromPoint;
});

describe('notesOwnsKey', () => {
    it('focus nowhere, or inside Notes: the key is Notes’', () => {
        expect(notesOwnsKey(key({ key: 'c' }, document.body), host)).toBe(true);
        expect(notesOwnsKey(key({ key: 'c' }, inside), host)).toBe(true);
    });

    it('the view hidden (inert): no', () => {
        host.setAttribute('inert', '');
        expect(notesOwnsKey(key({ key: 'c' }, document.body), host)).toBe(false);
    });

    it('no view at all: no', () => {
        expect(notesOwnsKey(key({ key: 'c' }, document.body), null)).toBe(false);
    });

    it('focus in the app’s own chrome: no', () => {
        expect(notesOwnsKey(key({ key: 'c' }, outside), host)).toBe(false);
    });

    it('one of Púca’s hotkeys (push-to-talk on a bare C): no — and yes again once it is bound elsewhere', () => {
        let binding = { keyCode: 67, ctrl: false, alt: false, shift: false, label: 'C' };
        registerPress('test.ptt', () => binding, () => {});
        const c = () => key({ key: 'c', keyCode: 67 }, document.body);
        expect(notesOwnsKey(c(), host)).toBe(false);
        binding = { keyCode: 86, ctrl: false, alt: false, shift: false, label: 'V' };
        expect(notesOwnsKey(c(), host)).toBe(true);
    });

    describe('something of the app’s over the view', () => {
        const box = { left: 72, top: 0, width: 800, height: 600, right: 872, bottom: 600, x: 72, y: 0, toJSON() {} } as DOMRect;
        let onTop: Element | null = null;
        let asked: [number, number] | null = null;
        beforeEach(() => {
            vi.spyOn(host, 'getBoundingClientRect').mockReturnValue(box);
            (document as { elementFromPoint?: unknown }).elementFromPoint = (x: number, y: number) => { asked = [x, y]; return onTop; };
        });

        it('a dialog of the app’s at the view’s centre: no', () => {
            const dialog = document.createElement('div');
            document.body.appendChild(dialog);
            onTop = dialog;
            expect(notesOwnsKey(key({ key: 'c' }, document.body), host)).toBe(false);
            expect(asked).toEqual([472, 300]);
        });

        it('Notes’ own dialog (in its layer, inside the view) on top: yes', () => {
            const layer = document.createElement('div');
            const noteDialog = document.createElement('div');
            layer.appendChild(noteDialog);
            host.appendChild(layer);
            onTop = noteDialog;
            expect(notesOwnsKey(key({ key: 'c' }, document.body), host)).toBe(true);
        });
    });
});

describe('whenIdentityReady', () => {
    it('keys already in hand: runs at once, not late', () => {
        h.identity = {};
        h.seedOk = true;
        const cb = vi.fn();
        whenIdentityReady(cb);
        expect(cb).toHaveBeenCalledWith(false);
    });

    it('a seed of ANOTHER account in storage (a soft expiry left it): waits', () => {
        h.identity = {};
        h.seedOk = false;
        const cb = vi.fn();
        whenIdentityReady(cb);
        expect(cb).not.toHaveBeenCalled();
    });

    it('keys restored later: runs once, late, when the restore lands — not on a restore event that brought none', () => {
        const cb = vi.fn();
        whenIdentityReady(cb);
        window.dispatchEvent(new CustomEvent('identity-restore-changed'));
        expect(cb).not.toHaveBeenCalled();
        h.identity = {};
        h.seedOk = true;
        window.dispatchEvent(new CustomEvent('identity-restore-changed'));
        window.dispatchEvent(new CustomEvent('identity-restore-changed'));
        expect(cb).toHaveBeenCalledTimes(1);
        expect(cb).toHaveBeenCalledWith(true);
    });

    it('cancelled before the keys came: never runs', () => {
        const cb = vi.fn();
        const cancel = whenIdentityReady(cb);
        cancel();
        h.identity = {};
        h.seedOk = true;
        window.dispatchEvent(new CustomEvent('identity-restore-changed'));
        expect(cb).not.toHaveBeenCalled();
    });
});
