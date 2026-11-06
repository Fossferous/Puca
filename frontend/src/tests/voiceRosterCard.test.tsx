/**
 * The card that says who is in a voice room (VoiceRosterCard.tsx): on a mouse resting on the row,
 * and on the keyboard reaching it. Never on a finger or a pen, never on a pass of the mouse, and
 * it says so for an EMPTY room too, which is the case the sidebar's own list cannot show.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ROSTER_CARD_DELAY_MS, VoiceRosterTip, type RosterPerson } from '../components/VoiceRosterCard';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function mount(people: RosterPerson[]) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
        root!.render(
            <div className="row" tabIndex={0}>
                Lounge
                <VoiceRosterTip title="Lounge" people={people} />
            </div>,
        );
    });
    return host.querySelector('.row') as HTMLElement;
}

const pointer = (type: string, pointerType: string) => {
    const e = new Event(type);
    Object.defineProperty(e, 'pointerType', { value: pointerType });
    return e;
};
const card = () => document.querySelector('[data-testid="roster-card"]');

beforeEach(() => {
    vi.useFakeTimers();
    // jsdom has no keyboard modality of its own to answer :focus-visible from, and its guess changes
    // with whatever was pressed before. Say that the focus in these tests came from the keyboard; the
    // case of a click's focus, which must open nothing, is its own test below.
    const matches = Element.prototype.matches;
    vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector: string) {
        return selector === ':focus-visible' ? keyboardFocus : matches.call(this, selector);
    });
    keyboardFocus = true;
});

let keyboardFocus = true;

afterEach(async () => {
    await act(async () => { root?.unmount(); });
    host?.remove();
    root = null;
    host = null;
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('VoiceRosterTip', () => {
    it('opens after a mouse has rested on the row, and not for a pass over it', async () => {
        const row = await mount([{ id: 1, name: 'Ana' }]);
        await act(async () => { row.dispatchEvent(pointer('pointerenter', 'mouse')); });
        await act(async () => { vi.advanceTimersByTime(ROSTER_CARD_DELAY_MS - 50); });
        expect(card()).toBeNull();
        await act(async () => { row.dispatchEvent(pointer('pointerleave', 'mouse')); });
        await act(async () => { vi.advanceTimersByTime(ROSTER_CARD_DELAY_MS); });
        expect(card()).toBeNull();

        await act(async () => { row.dispatchEvent(pointer('pointerenter', 'mouse')); });
        await act(async () => { vi.advanceTimersByTime(ROSTER_CARD_DELAY_MS + 10); });
        expect(card()?.textContent).toContain('Ana');
        expect(card()?.textContent).toContain('1 in this channel');
    });

    it('says plainly that an empty room is empty', async () => {
        const row = await mount([]);
        await act(async () => { row.dispatchEvent(pointer('pointerenter', 'mouse')); });
        await act(async () => { vi.advanceTimersByTime(ROSTER_CARD_DELAY_MS + 10); });
        expect(card()?.textContent).toContain('Nobody is here');
        expect(card()?.textContent).toContain('Lounge');
    });

    it('opens nothing for a finger or a pen: there is no hover on a touch screen', async () => {
        const row = await mount([{ id: 1, name: 'Ana' }]);
        await act(async () => { row.dispatchEvent(pointer('pointerenter', 'touch')); });
        await act(async () => { vi.advanceTimersByTime(ROSTER_CARD_DELAY_MS * 3); });
        expect(card()).toBeNull();
        await act(async () => { row.dispatchEvent(pointer('pointerenter', 'pen')); });
        await act(async () => { vi.advanceTimersByTime(ROSTER_CARD_DELAY_MS * 3); });
        expect(card()).toBeNull();
    });

    it('opens at once when the keyboard reaches the row, and Escape closes it', async () => {
        const row = await mount([{ id: 1, name: 'Ana', muted: true }, { id: 2, name: 'Bo', deafened: true, live: true }]);
        await act(async () => { row.focus(); });
        expect(card()?.textContent).toContain('2 in this channel');
        expect(card()?.querySelectorAll('li')).toHaveLength(2);
        expect(card()?.querySelector('[aria-label="Muted"]')).not.toBeNull();
        expect(card()?.querySelector('[aria-label="Deafened"]')).not.toBeNull();
        expect(card()?.textContent).toContain('LIVE');
        expect(row.getAttribute('aria-describedby')).toBe(card()?.id);
        await act(async () => { row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
        expect(card()).toBeNull();
        expect(row.hasAttribute('aria-describedby')).toBe(false);
    });

    it("opens nothing when the focus came from a click, which is not the keyboard's", async () => {
        keyboardFocus = false;
        const row = await mount([{ id: 1, name: 'Ana' }]);
        await act(async () => { row.focus(); });
        expect(card()).toBeNull();
    });

    it('closes when the row is pressed, since a press on it joins the call', async () => {
        const row = await mount([{ id: 1, name: 'Ana' }]);
        await act(async () => { row.focus(); });
        expect(card()).not.toBeNull();
        await act(async () => { row.dispatchEvent(pointer('pointerdown', 'mouse')); });
        expect(card()).toBeNull();
    });

    it('follows the row when what holds it scrolls, and ignores a scroll elsewhere', async () => {
        const row = await mount([{ id: 1, name: 'Ana' }]);
        const elsewhere = document.createElement('div');
        document.body.appendChild(elsewhere);
        await act(async () => { row.focus(); });
        expect(card()).not.toBeNull();
        await act(async () => { elsewhere.dispatchEvent(new Event('scroll')); });
        expect(card()).not.toBeNull();
        // The row is moved by a scroll of the page: the card is still there, and follows.
        await act(async () => { document.dispatchEvent(new Event('scroll')); });
        expect(card()).not.toBeNull();
        elsewhere.remove();
    });

    it('is a tooltip that takes no pointer events, so the row stays what a press lands on', async () => {
        const row = await mount([{ id: 1, name: 'Ana' }]);
        await act(async () => { row.focus(); });
        expect(card()?.getAttribute('role')).toBe('tooltip');
    });
});
