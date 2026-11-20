/**
 * The window picker (DeviceStageWindowPicker.tsx) on its own: it asks for a
 * fresh list when it opens, the keyboard reaches every row from the search
 * field, a choice is SENT and the picker waits for the host to confirm it
 * (closing only then), a refusal keeps it open, Whole screen is the first
 * row, a phone sheet does not focus the field (the soft keyboard would cover
 * the list), and Escape closes it wherever the focus is. The real-browser
 * walk (e2e/device-stage-window-picker-real-browser.mjs) measures layout,
 * touch targets and contrast; this pins the behaviour.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DeviceControlSession } from '../api/devices/session';

const h = vi.hoisted(() => ({
    requestWindowList: vi.fn((..._a: unknown[]) => {}),
    chooseWindow: vi.fn((..._a: unknown[]) => {}),
}));
vi.mock('../api/devices/session', () => ({
    requestWindowList: (...a: unknown[]) => h.requestWindowList(...a),
    chooseWindow: (...a: unknown[]) => h.chooseWindow(...a),
}));
vi.mock('../hooks/useBackClose', () => ({ useBackClose: () => { /* no Android back here */ } }));

import { DeviceStageWindowPicker } from '../components/DeviceStageWindowPicker';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const WINDOWS = [
    { hwnd: 1, pid: 10, title: 'Quarterly report.docx - Word', app: 'Microsoft Word', icon: 'ia' },
    { hwnd: 2, pid: 20, title: 'notes.txt - Notepad', app: 'Notepad', minimized: true },
    { hwnd: 3, pid: 30, title: 'Task Manager', app: 'Task Manager', elevated: true },
];

function snapshot(over: Partial<DeviceControlSession> = {}): DeviceControlSession {
    return {
        id: 'ds1', peerName: 'Study PC', windowsSupported: true, activeWindow: null, windowNotice: null, windowFront: true,
        windowList: { rid: 'r', loading: false, error: null, windows: WINDOWS, icons: { ia: PNG } },
        ...over,
    } as unknown as DeviceControlSession;
}

let root: Root;
let host: HTMLDivElement;
let onClose: Mock<() => void>;
function render(s: DeviceControlSession, touch = false) {
    act(() => { root.render(<DeviceStageWindowPicker session={s} touch={touch} onClose={onClose} />); });
}
const rows = () => [...host.querySelectorAll('.dswp-row')] as HTMLElement[];
const titles = () => rows().map(r => r.querySelector('.dswp-title')!.textContent);
const field = () => host.querySelector('input[aria-label="Find a window"]') as HTMLInputElement;
function key(el: Element, k: string, extra: KeyboardEventInit = {}) {
    act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra })); });
}
function type(value: string) {
    const input = field();
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
        set.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
}

beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    onClose = vi.fn<() => void>();
    h.requestWindowList.mockClear();
    h.chooseWindow.mockClear();
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

describe('the window picker', () => {
    it('asks the host for a fresh list as it opens, and lists Whole screen first', () => {
        render(snapshot());
        expect(h.requestWindowList).toHaveBeenCalledWith('ds1');
        expect(titles()).toEqual(['Whole screen', ...WINDOWS.map(w => w.title)]);
        expect(rows()[0].getAttribute('aria-selected'), 'the whole screen is what shows now').toBe('true');
    });

    it('shows each program\'s icon from the list, a glyph without one, and says what a row cannot do', () => {
        render(snapshot());
        expect(rows()[1].querySelector('img')?.getAttribute('src')).toBe(PNG);
        expect(rows()[2].querySelector('img')).toBeNull();
        expect(rows()[2].querySelector('svg')).not.toBeNull();
        expect(rows()[2].textContent).toContain('minimised');
        expect(rows()[3].textContent).toContain('Windows will not let your clicks and keys reach it');
        expect(rows()[1].textContent).not.toContain('administrator');
    });

    it('on a desktop the search field has the keyboard; typing filters; the arrows and Enter choose', () => {
        render(snapshot());
        expect(document.activeElement).toBe(field());
        type('note');
        expect(titles()).toEqual(['Whole screen', 'notes.txt - Notepad']);
        // The match, not Whole screen, is what Enter takes after typing.
        key(field(), 'Enter');
        expect(h.chooseWindow).toHaveBeenCalledWith('ds1', { hwnd: 2, pid: 20 });
        expect(onClose, 'closed only once the host confirms').not.toHaveBeenCalled();
        expect(host.querySelector('.dswp-status')?.textContent).toBe('Showing that window…');
        // The host confirms.
        render(snapshot({ activeWindow: { hwnd: 2, pid: 20, title: 'notes.txt - Notepad', app: 'Notepad', width: 800, height: 600 } }));
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('the arrows walk every row, Whole screen included, and stop at the ends', () => {
        render(snapshot());
        const active = () => host.querySelector('.dswp-row.active .dswp-title')?.textContent;
        expect(active()).toBe('Whole screen');
        key(field(), 'ArrowUp');
        expect(active()).toBe('Whole screen');
        for (let i = 0; i < 5; i++) key(field(), 'ArrowDown');
        expect(active()).toBe('Task Manager');
        expect(field().getAttribute('aria-activedescendant'), 'the field says which row').toBe(host.querySelector('.dswp-row.active')!.id);
        key(field(), 'Home', { ctrlKey: true });
        expect(active()).toBe('Whole screen');
        // A held Enter (auto-repeat) is no choice.
        key(field(), 'ArrowDown');
        key(field(), 'Enter', { repeat: true });
        expect(h.chooseWindow).not.toHaveBeenCalled();
    });

    it('a refusal keeps the picker open and says why', () => {
        render(snapshot());
        act(() => { rows()[1].click(); });
        expect(h.chooseWindow).toHaveBeenCalledWith('ds1', { hwnd: 1, pid: 10 });
        render(snapshot({ windowNotice: 'Could not show that window: that window has closed.' }));
        expect(onClose).not.toHaveBeenCalled();
        expect(host.querySelector('[data-testid="window-picker-notice"]')?.textContent).toBe('Could not show that window: that window has closed.');
        expect(host.querySelector('[data-testid="window-picker-status"]'), 'nothing is pending any more').toBeNull();
    });

    it('Whole screen, chosen while a window shows, is sent as no window; the row already shown just closes', () => {
        const shown = { hwnd: 1, pid: 10, title: 'Quarterly report.docx - Word', app: 'Microsoft Word', width: 800, height: 600 };
        render(snapshot({ activeWindow: shown }));
        expect(rows()[1].getAttribute('aria-selected')).toBe('true');
        act(() => { rows()[1].click(); });
        expect(h.chooseWindow, 'the window already shown is not asked for again').not.toHaveBeenCalled();
        expect(onClose).toHaveBeenCalledTimes(1);
        act(() => { rows()[0].click(); });
        expect(h.chooseWindow).toHaveBeenCalledWith('ds1', null);
        render(snapshot({ activeWindow: null }));
        expect(onClose).toHaveBeenCalledTimes(2);
    });

    it('on a phone nothing typed into takes the focus, and a short list has no search', () => {
        render(snapshot({ windowList: { rid: 'r', loading: false, error: null, windows: WINDOWS, icons: {} } }), true);
        expect(field(), 'three windows fit without a search').toBeNull();
        expect(document.activeElement?.tagName).not.toBe('INPUT');
        expect(host.querySelector('.dswp-touch')).not.toBeNull();
    });

    it('says when it is asking, when there is nothing, and when nothing matches', () => {
        render(snapshot({ windowList: { rid: 'r', loading: true, error: null, windows: [], icons: {} } }));
        expect(host.querySelector('.dswp-status')?.textContent).toBe('Asking Study PC for its windows…');
        render(snapshot({ windowList: { rid: 'r', loading: false, error: null, windows: [], icons: {} } }));
        expect(host.querySelector('.dswp-status')?.textContent).toBe('No windows are open on Study PC.');
        render(snapshot());
        type('zzz');
        expect(host.querySelector('.dswp-status')?.textContent).toBe('No window matches “zzz”.');
    });

    it('Escape closes it wherever the focus is', () => {
        render(snapshot());
        act(() => { (document.activeElement as HTMLElement).blur(); });
        key(document.body, 'Escape');
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
