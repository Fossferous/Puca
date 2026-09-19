/**
 * Bulk selection (L16): the pure selection helpers, the one-save pin that
 * keeps every hidden note's slot, the one-write colour/label/archive, the
 * bounded delete that reports partial failure, and the phone's long press.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { buildPrefsForOrder } from '../api/tasks';
import { bulkPinOrder, keepVisible, rangeSelection, toggleInSelection } from '../notes/model/notesModel';
import { labelCoverage, withArchived, withColor, withLabel } from '../notes/model/notesBulk';
import { LONG_PRESS_MS, useLongPress } from '../notes/components/useLongPress';
import { runBounded } from '../notes/components/useNoteSelection';

describe('selection helpers', () => {
    const vis = ['list:1', 'list:2', 'channel:3', 'list:4'];
    it('toggle, range over the visible order, and only visible notes stay selected', () => {
        expect([...toggleInSelection(new Set(), 'list:1')]).toEqual(['list:1']);
        expect([...toggleInSelection(new Set(['list:1']), 'list:1')]).toEqual([]);
        expect([...rangeSelection(new Set(['list:1']), vis, 'list:1', 'list:4')].sort()).toEqual([...vis].sort());
        expect([...rangeSelection(new Set(), vis, 'list:4', 'list:2')].sort()).toEqual(['channel:3', 'list:2', 'list:4']);
        expect([...rangeSelection(new Set(), vis, null, 'list:2')]).toEqual(['list:2']);   // no anchor: a toggle
        const sel = new Set(['list:1', 'list:9']);
        expect([...keepVisible(sel, vis)]).toEqual(['list:1']);
        const same = new Set(['list:1']);
        expect(keepVisible(same, vis)).toBe(same);                                            // stable when nothing changed
    });
});

describe('bulk pin', () => {
    it('is ONE prefs set over the FULL order: hidden notes keep their slots and flags', () => {
        // list:2 is archived (hidden from the grid) and was a favourite; channel:9
        // is a tab Púca knows that Notes has not loaded at all.
        const full = ['list:1', 'list:2', 'list:3', 'list:4'];
        const old = [
            { kind: 'list' as const, ref_id: 1, is_favorite: false },
            { kind: 'list' as const, ref_id: 2, is_favorite: true },
            { kind: 'list' as const, ref_id: 3, is_favorite: false },
            { kind: 'list' as const, ref_id: 4, is_favorite: false },
            { kind: 'channel' as const, ref_id: 9, is_favorite: false },
        ];
        const { order, overrides } = bulkPinOrder(full, new Set(['list:3', 'list:4']), true);
        expect(order).toEqual(['list:3', 'list:4', 'list:1', 'list:2']);
        const tabs = order.map(k => ({ kind: k.split(':')[0] as 'list', id: Number(k.split(':')[1]) }));
        const next = buildPrefsForOrder(tabs, old, overrides);
        expect(next.map(p => `${p.kind}:${p.ref_id}:${p.is_favorite}`)).toEqual([
            'list:3:true', 'list:4:true', 'list:1:false', 'list:2:true', 'channel:9:false',
        ]);
        // Unpinning changes no order.
        const un = bulkPinOrder(full, new Set(['list:2']), false);
        expect(un.order).toEqual(full);
        expect(un.overrides.get('list:2')).toBe(false);
    });
});

describe('bulk colour, labels, archive', () => {
    const s = { colors: { 'list:1': 'mint' as const }, labels: { 'list:1': ['Home'], 'list:2': ['Work'] }, archived: {} };
    it('apply to every key in one state', () => {
        expect(withColor(s, ['list:1', 'list:2'], 'dusk').colors).toEqual({ 'list:1': 'dusk', 'list:2': 'dusk' });
        expect(withColor(s, ['list:1'], 'default').colors).toEqual({});
        expect(withLabel(s, ['list:1', 'list:2'], 'Home', true).labels).toEqual({ 'list:1': ['Home'], 'list:2': ['Work', 'Home'] });
        expect(withLabel(s, ['list:1', 'list:2'], 'home', false).labels).toEqual({ 'list:2': ['Work'] });
        expect(withArchived(s, ['list:1', 'list:2'], true).archived).toEqual({ 'list:1': true, 'list:2': true });
        expect(labelCoverage(s, ['list:1', 'list:2'], ['Home', 'Work', 'Nope'])).toEqual(new Map([['Home', 'some'], ['Work', 'some'], ['Nope', 'none']]));
    });
});

describe('bounded delete', () => {
    it('never runs more than the limit at once, and returns exactly the failures', async () => {
        let live = 0;
        let peak = 0;
        const failed = await runBounded([1, 2, 3, 4, 5, 6, 7], 3, async n => {
            live++; peak = Math.max(peak, live);
            await new Promise(r => setTimeout(r, 5));
            live--;
            if (n === 6) throw new Error('boom');
            return n !== 2;
        });
        expect(peak).toBe(3);
        expect(failed.sort()).toEqual([2, 6]);
    });
});

function PressTarget({ onLong, onClick }: { onLong: () => void; onClick: () => void }) {
    const press = useLongPress(onLong);
    return <div data-testid="t" {...press.handlers} onClick={() => { if (!press.swallowClick()) onClick(); }} />;
}

/** jsdom has no PointerEvent: a MouseEvent carrying pointerType does for React. */
function pointer(el: Element, type: string, init: { pointerType: string; clientX?: number; clientY?: number }) {
    const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: init.clientX ?? 0, clientY: init.clientY ?? 0 });
    Object.defineProperty(e, 'pointerType', { value: init.pointerType });
    act(() => { el.dispatchEvent(e); });
}
function click(el: Element) {
    act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
}
function mount(ui: React.ReactElement): HTMLElement {
    const host = document.createElement('div');
    document.body.appendChild(host);
    act(() => { createRoot(host).render(ui); });
    return host.firstElementChild as HTMLElement;
}

describe('long press (phone)', () => {
    afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ''; });

    it('a held touch selects and swallows the click; a moved one (a scroll) does neither', () => {
        vi.useFakeTimers();
        const onLong = vi.fn();
        const onClick = vi.fn();
        const t = mount(<PressTarget onLong={onLong} onClick={onClick} />);
        pointer(t, 'pointerdown', { pointerType: 'touch', clientX: 10, clientY: 10 });
        act(() => { vi.advanceTimersByTime(LONG_PRESS_MS + 10); });
        pointer(t, 'pointerup', { pointerType: 'touch' });
        click(t);
        expect(onLong).toHaveBeenCalledTimes(1);
        expect(onClick).not.toHaveBeenCalled();

        pointer(t, 'pointerdown', { pointerType: 'touch', clientX: 10, clientY: 10 });
        pointer(t, 'pointermove', { pointerType: 'touch', clientX: 10, clientY: 60 });
        act(() => { vi.advanceTimersByTime(LONG_PRESS_MS + 10); });
        pointer(t, 'pointerup', { pointerType: 'touch' });
        click(t);
        expect(onLong).toHaveBeenCalledTimes(1);
        expect(onClick).toHaveBeenCalledTimes(1);          // positive control: a tap still taps
    });

    it('a mouse press never becomes a long press', () => {
        vi.useFakeTimers();
        const onLong = vi.fn();
        const t = mount(<PressTarget onLong={onLong} onClick={() => {}} />);
        pointer(t, 'pointerdown', { pointerType: 'mouse' });
        act(() => { vi.advanceTimersByTime(LONG_PRESS_MS * 3); });
        expect(onLong).not.toHaveBeenCalled();
    });
});
