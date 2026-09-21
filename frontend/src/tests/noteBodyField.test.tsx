/**
 * The note-text field Púca Notes and Púca's Tasks view share: it saves a
 * pause after typing (not per keystroke), a failed save KEEPS what was typed
 * and offers a retry, and unreadable text is shown locked, never editable —
 * an edit there would seal the marker over the real ciphertext.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NoteBodyField } from '../components/NoteBodyField';
import { BODY_SAVE_DELAY_MS, flushBodySave } from '../api/listContent';
import { TASK_DECRYPT_FAILED } from '../api/decryptMarkers';

let root: Root;
let container: HTMLDivElement;

function type(el: HTMLTextAreaElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    act(() => {
        setter.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
    });
}
const area = () => container.querySelector('textarea') as HTMLTextAreaElement;
const flushPromises = async () => { for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); }); };

beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
    vi.useRealTimers();
});

describe('NoteBodyField', () => {
    it('saves once, a pause after the last keystroke', async () => {
        const onSave = vi.fn(async () => true);
        act(() => { root.render(<NoteBodyField value="" onSave={onSave} />); });
        type(area(), 'H');
        type(area(), 'He');
        type(area(), 'Hello');
        act(() => { vi.advanceTimersByTime(BODY_SAVE_DELAY_MS - 1); });
        expect(onSave).not.toHaveBeenCalled();
        act(() => { vi.advanceTimersByTime(1); });
        await flushPromises();
        expect(onSave).toHaveBeenCalledTimes(1);
        expect(onSave).toHaveBeenCalledWith('Hello', undefined);
    });

    it('a failed save keeps the typed text and offers a retry that saves it', async () => {
        const onSave = vi.fn(async () => false);
        act(() => { root.render(<NoteBodyField value="old" onSave={onSave} />); });
        type(area(), 'new words');
        act(() => { vi.advanceTimersByTime(BODY_SAVE_DELAY_MS); });
        await flushPromises();
        expect(area().value).toBe('new words');
        expect(container.textContent).toMatch(/Not saved/);
        onSave.mockImplementation(async () => true);
        const retry = container.querySelector('.nb-retry') as HTMLButtonElement;
        act(() => { retry.click(); });
        await flushPromises();
        expect(onSave).toHaveBeenLastCalledWith('new words', undefined);
        expect(container.textContent).not.toMatch(/Not saved/);
    });

    it('closing the note saves what was typed', async () => {
        const onSave = vi.fn(async () => true);
        act(() => { root.render(<NoteBodyField value="" onSave={onSave} />); });
        type(area(), 'last thought');
        act(() => { root.render(<></>); });
        await flushPromises();
        expect(onSave).toHaveBeenCalledWith('last thought', undefined);
    });

    it('a trash of the list waits for text typed inside the save pause (flushBodySave)', async () => {
        let resolveSave!: (ok: boolean) => void;
        const onSave = vi.fn(() => new Promise<boolean>(r => { resolveSave = r; }));
        act(() => { root.render(<NoteBodyField listId={41} value="" onSave={onSave} />); });
        type(area(), 'typed a moment ago');
        // No timer has fired: the save would still be 800 ms away.
        let flushed = false;
        const flushing = flushBodySave(41).then(() => { flushed = true; });
        await flushPromises();
        expect(onSave).toHaveBeenCalledWith('typed a moment ago', undefined);
        expect(flushed).toBe(false);   // ...and it waits for the save to LAND
        await act(async () => { resolveSave(true); await flushing; });
        expect(flushed).toBe(true);
        // POSITIVE CONTROL: another list's flush has nothing to wait for.
        await flushBodySave(42);
    });

    it('...also when the field has already unmounted (closing the note is what a trash does)', async () => {
        let resolveSave!: (ok: boolean) => void;
        const onSave = vi.fn(() => new Promise<boolean>(r => { resolveSave = r; }));
        act(() => { root.render(<NoteBodyField listId={43} value="" onSave={onSave} />); });
        type(area(), 'last words');
        act(() => { root.render(<></>); });
        let flushed = false;
        const flushing = flushBodySave(43).then(() => { flushed = true; });
        await flushPromises();
        expect(onSave).toHaveBeenCalledWith('last words', undefined);
        expect(flushed).toBe(false);
        await act(async () => { resolveSave(true); await flushing; });
        expect(flushed).toBe(true);
    });

    it('text from another device replaces the field only when nothing is being typed here', async () => {
        const onSave = vi.fn(async () => true);
        act(() => { root.render(<NoteBodyField value="v1" onSave={onSave} />); });
        act(() => { root.render(<NoteBodyField value="v2" onSave={onSave} />); });
        expect(area().value).toBe('v2');
        type(area(), 'mine');
        act(() => { root.render(<NoteBodyField value="v3" onSave={onSave} />); });
        expect(area().value).toBe('mine');
        // v3 is NOT lost here: the save that follows is refused by the server
        // (it names the revision 'mine' was typed on top of) and the test
        // below is what happens next. This test used to end at the line above
        // and call the loss correct.
    });

    describe('two devices, one note', () => {
        it('a refused save keeps what was typed, shows the other copy, and asks', async () => {
            const onSave = vi.fn(async () => ({ conflict: { theirs: 'v3 from the phone' } }));
            act(() => { root.render(<NoteBodyField value="v2" onSave={onSave} />); });
            type(area(), 'mine');
            act(() => { vi.advanceTimersByTime(BODY_SAVE_DELAY_MS); });
            await flushPromises();

            expect(onSave).toHaveBeenCalledWith('mine', undefined);
            expect(area().value).toBe('mine');   // not a word of it thrown away
            const banner = container.querySelector('[data-conflict="stale"]') as HTMLElement;
            expect(banner).not.toBeNull();
            expect(banner.textContent).toContain('v3 from the phone');   // nothing is chosen blind
            expect(banner.querySelector('[data-action="keep-mine"]')).not.toBeNull();
            expect(banner.querySelector('[data-action="use-theirs"]')).not.toBeNull();
        });

        it('"Use theirs" replaces the field with their copy and clears the banner', async () => {
            const onSave = vi.fn(async () => ({ conflict: { theirs: 'theirs' } }));
            act(() => { root.render(<NoteBodyField value="v2" onSave={onSave} />); });
            type(area(), 'mine');
            act(() => { vi.advanceTimersByTime(BODY_SAVE_DELAY_MS); });
            await flushPromises();
            act(() => { (container.querySelector('[data-action="use-theirs"]') as HTMLButtonElement).click(); });
            expect(area().value).toBe('theirs');
            expect(container.querySelector('[data-conflict="stale"]')).toBeNull();
            // And it does not immediately re-save: taking their copy is not
            // an edit of it.
            act(() => { vi.advanceTimersByTime(BODY_SAVE_DELAY_MS * 2); });
            await flushPromises();
            expect(onSave).toHaveBeenCalledTimes(1);
        });

        it('"Keep mine" saves the typed text again — against the revision the refusal handed back', async () => {
            // First call loses the race; the second (against the new base) wins.
            const onSave = vi.fn()
                .mockResolvedValueOnce({ conflict: { theirs: 'theirs' } })
                .mockResolvedValueOnce(true);
            act(() => { root.render(<NoteBodyField value="v2" onSave={onSave} />); });
            type(area(), 'mine');
            act(() => { vi.advanceTimersByTime(BODY_SAVE_DELAY_MS); });
            await flushPromises();
            act(() => { (container.querySelector('[data-action="keep-mine"]') as HTMLButtonElement).click(); });
            await flushPromises();
            expect(onSave).toHaveBeenCalledTimes(2);
            expect(onSave).toHaveBeenLastCalledWith('mine', undefined);
            expect(area().value).toBe('mine');
            expect(container.querySelector('[data-conflict="stale"]')).toBeNull();
        });

        it('their copy cannot be read here: no preview, and no way to seal the error over it', async () => {
            const onSave = vi.fn(async () => ({ conflict: { theirs: TASK_DECRYPT_FAILED } }));
            act(() => { root.render(<NoteBodyField value="v2" onSave={onSave} />); });
            type(area(), 'mine');
            act(() => { vi.advanceTimersByTime(BODY_SAVE_DELAY_MS); });
            await flushPromises();
            const banner = container.querySelector('[data-conflict="stale"]') as HTMLElement;
            expect(banner).not.toBeNull();
            expect(banner.querySelector('[data-theirs]')).toBeNull();
            expect(banner.querySelector('[data-action="use-theirs"]')).toBeNull();
            // POSITIVE CONTROL: the user can still keep their own words.
            expect(banner.querySelector('[data-action="keep-mine"]')).not.toBeNull();
        });

        it('names the revision typing STARTED from, not the one the note has by the time it saves', async () => {
            // The other device's change lands mid-sentence: the field keeps
            // the words AND the base they were written on top of. Reading the
            // revision at save time would name the newer one and win.
            const onSave = vi.fn(async () => true);
            act(() => { root.render(<NoteBodyField value="v2" contentRev={3} onSave={onSave} />); });
            type(area(), 'mine');
            act(() => { root.render(<NoteBodyField value="v3 from the phone" contentRev={4} onSave={onSave} />); });
            expect(area().value).toBe('mine');
            act(() => { vi.advanceTimersByTime(BODY_SAVE_DELAY_MS); });
            await flushPromises();
            expect(onSave).toHaveBeenCalledWith('mine', 3);

            // POSITIVE CONTROL: with nothing typed, the remote text replaces
            // the field and the NEXT edit names the newer revision.
            act(() => { root.render(<NoteBodyField value="v4" contentRev={5} onSave={onSave} />); });
            expect(area().value).toBe('v4');
            type(area(), 'after');
            act(() => { vi.advanceTimersByTime(BODY_SAVE_DELAY_MS); });
            await flushPromises();
            expect(onSave).toHaveBeenLastCalledWith('after', 5);
        });

        it('a save that lands moves the base, so words typed while it was out are not refused', async () => {
            let release = (_v: unknown) => {};
            const onSave = vi.fn(() => new Promise(res => { release = res; }));
            act(() => { root.render(<NoteBodyField value="" contentRev={3} onSave={onSave} />); });
            type(area(), 'first');
            act(() => { vi.advanceTimersByTime(BODY_SAVE_DELAY_MS); });
            await flushPromises();
            expect(onSave).toHaveBeenCalledWith('first', 3);
            // More typing while the save is still out.
            type(area(), 'first and more');
            await act(async () => { release({ rev: 4 }); await flushPromises(); });
            act(() => { vi.advanceTimersByTime(BODY_SAVE_DELAY_MS); });
            await flushPromises();
            // ...is based on what that save wrote, not on the revision before it.
            expect(onSave).toHaveBeenLastCalledWith('first and more', 4);
        });

        // AN UNRESOLVED CONFLICT IS NOT ANSWERED BY LEAVING THE FIELD. The
        // banner asks a question; a blur, a close or a trash must not answer
        // it with "keep mine" on the user's behalf. It nearly did: the field
        // stays dirty while the question is open (it has to — the words are
        // still unsaved) and the cache now holds THEIR text, so the very next
        // flush() saw dirty && draft !== value, re-sent the typed text
        // against the revision that WON, and the server took it. The other
        // device's copy was gone with nobody ever choosing — the exact loss
        // this whole feature exists to prevent.
        it('a blur while the question is open saves NOTHING over the other copy', async () => {
            const onSave = vi.fn(async () => ({ conflict: { theirs: 'theirs', rev: 9 } }));
            act(() => { root.render(<NoteBodyField value="v2" contentRev={3} onSave={onSave} />); });
            type(area(), 'mine');
            act(() => { area().focus(); });
            act(() => { vi.advanceTimersByTime(BODY_SAVE_DELAY_MS); });
            await flushPromises();
            expect(container.querySelector('[data-conflict="stale"]')).not.toBeNull();
            // Nothing was written, so the data layer puts the copy that won
            // in the cache: the field re-renders with THEIR text as `value`
            // while the draft still holds the words being asked about.
            act(() => { root.render(<NoteBodyField value="theirs" contentRev={9} onSave={onSave} />); });
            expect(area().value).toBe('mine');

            act(() => { area().blur(); });
            await flushPromises();
            expect(onSave).toHaveBeenCalledTimes(1);
            expect(container.querySelector('[data-conflict="stale"]')).not.toBeNull();   // still asking
        });

        it('POSITIVE CONTROL: a blur with no question open is still what saves the note', async () => {
            const onSave = vi.fn(async () => true);
            act(() => { root.render(<NoteBodyField value="v2" contentRev={3} onSave={onSave} />); });
            type(area(), 'mine');
            act(() => { area().focus(); });
            act(() => { area().blur(); });
            await flushPromises();
            expect(onSave).toHaveBeenCalledWith('mine', 3);
        });

        it('closing the note on an open question leaves the other copy standing', async () => {
            const onSave = vi.fn(async () => ({ conflict: { theirs: 'theirs', rev: 9 } }));
            act(() => { root.render(<NoteBodyField listId={77} value="v2" contentRev={3} onSave={onSave} />); });
            type(area(), 'mine');
            act(() => { vi.advanceTimersByTime(BODY_SAVE_DELAY_MS); });
            await flushPromises();
            expect(onSave).toHaveBeenCalledTimes(1);
            act(() => { root.render(<NoteBodyField value="theirs" contentRev={9} onSave={onSave} />); });

            // Closing the note — and a trash, which goes through the same
            // registered flush — must not commit the losing text.
            act(() => { root.render(<></>); });
            await act(async () => { await flushBodySave(77); });
            await flushPromises();
            expect(onSave).toHaveBeenCalledTimes(1);
        });

        it('"Use theirs" is not preceded by a save of mine — the button blurs the field first', async () => {
            const onSave = vi.fn(async () => ({ conflict: { theirs: 'theirs', rev: 9 } }));
            act(() => { root.render(<NoteBodyField value="v2" contentRev={3} onSave={onSave} />); });
            type(area(), 'mine');
            act(() => { area().focus(); });
            act(() => { vi.advanceTimersByTime(BODY_SAVE_DELAY_MS); });
            await flushPromises();
            act(() => { root.render(<NoteBodyField value="theirs" contentRev={9} onSave={onSave} />); });
            // A real pointer press on a sibling button blurs the textarea
            // BEFORE the click handler runs: the banner's own answer used to
            // fire a winning save of my words on its way in, leaving the
            // server holding mine while the screen showed theirs.
            act(() => { area().blur(); });
            await flushPromises();
            act(() => { (container.querySelector('[data-action="use-theirs"]') as HTMLButtonElement).click(); });
            await flushPromises();
            expect(onSave).toHaveBeenCalledTimes(1);
            expect(area().value).toBe('theirs');
            expect(container.querySelector('[data-conflict="stale"]')).toBeNull();
        });

        it('typing on over the banner IS an answer, and saves again', async () => {
            // Dismissing the banner by writing more is a deliberate "keep
            // mine": the user has read their copy and carried on. The guard
            // above must not wedge the field shut.
            const onSave = vi.fn()
                .mockResolvedValueOnce({ conflict: { theirs: 'theirs', rev: 9 } })
                .mockResolvedValueOnce({ rev: 10 });
            act(() => { root.render(<NoteBodyField value="v2" contentRev={3} onSave={onSave} />); });
            type(area(), 'mine');
            act(() => { vi.advanceTimersByTime(BODY_SAVE_DELAY_MS); });
            await flushPromises();
            expect(container.querySelector('[data-conflict="stale"]')).not.toBeNull();
            type(area(), 'mine and more');
            expect(container.querySelector('[data-conflict="stale"]')).toBeNull();
            act(() => { vi.advanceTimersByTime(BODY_SAVE_DELAY_MS); });
            await flushPromises();
            expect(onSave).toHaveBeenCalledTimes(2);
            expect(onSave).toHaveBeenLastCalledWith('mine and more', 9);
        });

        it('an ordinary failed save is still a failed save, not a conflict', async () => {
            const onSave = vi.fn(async () => false);
            act(() => { root.render(<NoteBodyField value="v2" onSave={onSave} />); });
            type(area(), 'mine');
            act(() => { vi.advanceTimersByTime(BODY_SAVE_DELAY_MS); });
            await flushPromises();
            expect(container.querySelector('[data-conflict="stale"]')).toBeNull();
            expect(container.querySelector('.nb-status.failed')!.textContent).toContain('Not saved');
        });
    });

    it('unreadable text is locked: no field to type into', () => {
        act(() => { root.render(<NoteBodyField value={TASK_DECRYPT_FAILED} onSave={vi.fn()} />); });
        expect(container.querySelector('textarea')).toBeNull();
        expect(container.querySelector('.nb-locked')).not.toBeNull();
        // POSITIVE CONTROL: readable text is editable.
        act(() => { root.render(<NoteBodyField value="fine" onSave={vi.fn()} />); });
        expect(container.querySelector('textarea')).not.toBeNull();
    });
});
