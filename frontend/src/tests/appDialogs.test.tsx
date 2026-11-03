/**
 * How the app asks and tells (api/appDialogs.ts, components/AppDialogs.tsx): in the
 * page on the desktop, where a native dialog stops the JavaScript that closes a
 * push-to-talk microphone and carries relayed input, and the browser's own elsewhere.
 * What jsdom cannot show (the top layer, what a real key does) is in
 * e2e/app-dialogs-real-browser.mjs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { mountAppDialogs } from './appDialogsHost';
import { askConfirm, askText, closeAppDialogs, leaveNotice, tellUser, tellUserAndWait } from '../api/appDialogs';
import { NotesDialog } from '../components/NotesDialog';
import { ImageLightbox } from '../components/ImageLightbox';
import { Calendar } from '../components/calendar/Calendar';

let dialogs: ReturnType<typeof mountAppDialogs> | null;
let confirmSpy: ReturnType<typeof vi.spyOn>;
let alertSpy: ReturnType<typeof vi.spyOn>;
let promptSpy: ReturnType<typeof vi.spyOn>;

const desktop = () => { (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}; };

beforeEach(() => {
    confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('typed');
    dialogs = mountAppDialogs();
});
afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    act(() => closeAppDialogs());
    dialogs?.unmount();
    dialogs = null;
    vi.restoreAllMocks();
    vi.useRealTimers();
});

const question = () => document.querySelector<HTMLDialogElement>('dialog.app-question');
const ok = () => question()!.querySelector<HTMLButtonElement>('.app-question-ok')!;
const cancel = () => [...question()!.querySelectorAll('button')].find(b => b.textContent === 'Cancel')!;
const press = (init: KeyboardEventInit) => act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
});
const click = (el: HTMLElement) => act(async () => { el.click(); });
/** A question asked inside act, so it is on screen by the next line. In an object,
 *  because an async function that returns a promise waits for it. */
async function asked<T>(ask: () => Promise<T>): Promise<{ answer: Promise<T> }> {
    let answer!: Promise<T>;
    await act(async () => { answer = ask(); });
    return { answer };
}

describe('on the web and on Android they are the browser\'s own, as they always were', () => {
    it('a question is window.confirm, with its answer', async () => {
        expect(await askConfirm('Sure?')).toBe(true);
        confirmSpy.mockReturnValue(false);
        expect(await askConfirm('Sure?')).toBe(false);
        expect(confirmSpy).toHaveBeenCalledWith('Sure?');
        expect(question()).toBeNull();
    });

    it('a text question is window.prompt, and its first value goes with it', async () => {
        expect(await askText('Name?', 'old')).toBe('typed');
        expect(promptSpy).toHaveBeenCalledWith('Name?', 'old');
    });

    it('the answer to a press is window.alert', () => {
        tellUser('Could not delete that message.');
        expect(alertSpy).toHaveBeenCalledWith('Could not delete that message.');
        expect(dialogs!.notices()).toEqual([]);
    });

    it('but what nobody pressed anything for is the notice here too', () => {
        act(() => leaveNotice('Message failed to send.'));
        expect(alertSpy).not.toHaveBeenCalled();
        expect(dialogs!.notices()).toEqual(['Message failed to send.']);
    });
});

describe('with no host on the page, nothing goes unasked or untold', () => {
    beforeEach(() => { dialogs!.unmount(); dialogs = null; desktop(); });

    it('a question falls back to the native one, even on the desktop', async () => {
        expect(await askConfirm('Sure?')).toBe(true);
        expect(confirmSpy).toHaveBeenCalledTimes(1);
    });

    it('and so does a notice', () => {
        leaveNotice('Message failed to send.');
        expect(alertSpy).toHaveBeenCalledWith('Message failed to send.');
    });
});

describe('on the desktop a question is in the page', () => {
    beforeEach(desktop);

    it('and never reaches the native one', async () => {
        await asked(() => askConfirm('Kick Bob?'));
        expect(question()?.textContent).toContain('Kick Bob?');
        expect(confirmSpy).not.toHaveBeenCalled();
    });

    it('waits for its answer while the page goes on running', async () => {
        const answered = vi.fn();
        const { answer: pending } = await asked(() => askConfirm('Kick Bob?'));
        void pending.then(answered);
        // What a native dialog stops: a timer is the same turn of the loop as a
        // released push-to-talk or a relayed click.
        let ranMeanwhile = false;
        await act(async () => {
            await new Promise<void>(r => setTimeout(() => { ranMeanwhile = true; r(); }, 0));
        });
        expect(ranMeanwhile).toBe(true);
        expect(answered, 'nothing answered yet').not.toHaveBeenCalled();
        await click(ok());
        expect(answered).toHaveBeenCalledWith(true);
    });

    it('OK is yes and Cancel is no, and either takes the question away', async () => {
        const { answer: yes } = await asked(() => askConfirm('One'));
        await click(ok());
        await expect(yes).resolves.toBe(true);
        expect(question()).toBeNull();
        const { answer: no } = await asked(() => askConfirm('Two'));
        await click(cancel());
        await expect(no).resolves.toBe(false);
        expect(question()).toBeNull();
    });

    it('Escape is Cancel, for a yes-or-no and for a text', async () => {
        const { answer: no } = await asked(() => askConfirm('One'));
        await press({ key: 'Escape' });
        await expect(no).resolves.toBe(false);
        const { answer: none } = await asked(() => askText('Two', 'x'));
        await press({ key: 'Escape' });
        await expect(none).resolves.toBeNull();
    });

    it('its first control has the focus, and the focus goes back after', async () => {
        const opener = document.createElement('button');
        document.body.appendChild(opener);
        opener.focus();
        const { answer: pending } = await asked(() => askConfirm('One'));
        expect(document.activeElement).toBe(ok());
        await click(ok());
        await pending;
        expect(document.activeElement).toBe(opener);
        opener.remove();
    });

    it('a key still held from what opened it is no answer', async () => {
        const { answer: pending } = await asked(() => askConfirm('Delete it?'));
        const done = vi.fn();
        void pending.then(done);
        const repeat = new KeyboardEvent('keydown', { key: 'Enter', repeat: true, bubbles: true, cancelable: true });
        await act(async () => { document.activeElement!.dispatchEvent(repeat); });
        expect(repeat.defaultPrevented, 'the browser would have pressed OK with it').toBe(true);
        expect(done).not.toHaveBeenCalled();
        // CONTROL: a fresh Enter reaches OK. (jsdom turns no key into a click itself.)
        const fresh = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
        await act(async () => { document.activeElement!.dispatchEvent(fresh); });
        expect(fresh.defaultPrevented).toBe(false);
        await click(ok());
    });

    it('the second click of a double click, on what just opened, is no answer', async () => {
        const { answer: pending } = await asked(() => askConfirm('Delete it?'));
        const done = vi.fn();
        void pending.then(done);
        await act(async () => { ok().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 2 })); });
        expect(done).not.toHaveBeenCalled();
        expect(question()).not.toBeNull();
        await act(async () => { ok().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 })); });
        expect(done).toHaveBeenCalledWith(true);
    });

    // Both would go on to the same yes, and the thing asked about would happen twice.
    it('the same question asked again before its answer is a no, and only the first goes on', async () => {
        const { answer: first } = await asked(() => askConfirm('Delete it?'));
        const { answer: second } = await asked(() => askConfirm('Delete it?'));
        await expect(second).resolves.toBe(false);
        expect(document.querySelectorAll('dialog.app-question')).toHaveLength(1);
        await click(ok());
        await expect(first).resolves.toBe(true);
        expect(question(), 'nothing is left to answer').toBeNull();
        // CONTROL: answered, it can be asked again.
        const { answer: again } = await asked(() => askConfirm('Delete it?'));
        expect(question()).not.toBeNull();
        await click(ok());
        await expect(again).resolves.toBe(true);
    });

    it('so does a text question, with the no a text question answers', async () => {
        const { answer: first } = await asked(() => askText('Reason?', 'x'));
        const { answer: second } = await asked(() => askText('Reason?', 'x'));
        await expect(second).resolves.toBeNull();
        await click(ok());
        await expect(first).resolves.toBe('x');
    });

    it('questions wait their turn, oldest first', async () => {
        const { answer: first } = await asked(() => askConfirm('First'));
        const { answer: second } = await asked(() => askConfirm('Second'));
        expect(question()?.textContent).toContain('First');
        expect(document.querySelectorAll('dialog.app-question')).toHaveLength(1);
        await click(ok());
        await expect(first).resolves.toBe(true);
        expect(question()?.textContent).toContain('Second');
        await click(cancel());
        await expect(second).resolves.toBe(false);
    });

    it('a text question starts from what it was given, and answers what was typed', async () => {
        const { answer: pending } = await asked(() => askText('Edit message:', 'old words'));
        const input = question()!.querySelector('input')!;
        expect(input.value).toBe('old words');
        expect(document.activeElement).toBe(input);
        act(() => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'new words');
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await click(ok());
        await expect(pending).resolves.toBe('new words');
    });

    describe('a text of several lines', () => {
        const LINES = 'first line\nsecond line\n```\nfn main() {}\n```';
        const lines = () => question()!.querySelector('textarea')!;
        const type = (value: string) => act(() => {
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(lines(), value);
            lines().dispatchEvent(new Event('input', { bubbles: true }));
        });
        /** The key on the field. Was it left for the browser, or stopped from typing? */
        const key = async (init: KeyboardEventInit) => {
            const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init });
            await act(async () => { lines().dispatchEvent(event); });
            return { typedByTheBrowser: !event.defaultPrevented };
        };

        it('keeps them, in a field that can hold them, with the focus and all of it selected', async () => {
            const { answer: pending } = await asked(() => askText('Edit message:', LINES));
            expect(question()!.querySelector('input'), 'an <input> takes the line breaks out').toBeNull();
            expect(lines().value).toBe(LINES);
            expect(document.activeElement).toBe(lines());
            expect([lines().selectionStart, lines().selectionEnd]).toEqual([0, LINES.length]);
            await click(ok());
            await expect(pending).resolves.toBe(LINES);
        });

        it('an edit keeps every line, and Enter is the answer', async () => {
            const { answer: pending } = await asked(() => askText('Edit message:', LINES));
            type('first line, fixed\nsecond line');
            expect(await key({}), 'or it would be a new line as well').toEqual({ typedByTheBrowser: false });
            await expect(pending).resolves.toBe('first line, fixed\nsecond line');
            expect(question()).toBeNull();
        });

        it('Shift+Enter is a new line and no answer, held or not', async () => {
            const { answer: pending } = await asked(() => askText('Edit message:', LINES));
            const done = vi.fn();
            void pending.then(done);
            expect(await key({ shiftKey: true })).toEqual({ typedByTheBrowser: true });
            expect(await key({ shiftKey: true, repeat: true })).toEqual({ typedByTheBrowser: true });
            expect(done).not.toHaveBeenCalled();
            await click(cancel());
        });

        it('a held Enter is no answer, and no new line either', async () => {
            const { answer: pending } = await asked(() => askText('Edit message:', LINES));
            const done = vi.fn();
            void pending.then(done);
            expect(await key({ repeat: true })).toEqual({ typedByTheBrowser: false });
            expect(done).not.toHaveBeenCalled();
            // CONTROL: a fresh one is.
            await key({});
            expect(done).toHaveBeenCalledWith(LINES);
        });

        it('a held Space is only spaces, in here', async () => {
            const { answer: pending } = await asked(() => askText('Edit message:', LINES));
            expect(await key({ key: ' ', repeat: true })).toEqual({ typedByTheBrowser: true });
            await click(cancel());
            await pending;
        });

        it('an Enter or an Escape an IME is using is no answer', async () => {
            const { answer: pending } = await asked(() => askText('Edit message:', LINES));
            const done = vi.fn();
            void pending.then(done);
            expect(await key({ isComposing: true })).toEqual({ typedByTheBrowser: true });
            // WebKit says it only this way, for the Enter that ends a composition.
            expect(await key({ keyCode: 229 })).toEqual({ typedByTheBrowser: true });
            // Stopped, or the browser cancels the modal <dialog> with it (the real browser script).
            expect(await key({ key: 'Escape', isComposing: true })).toEqual({ typedByTheBrowser: false });
            expect(done).not.toHaveBeenCalled();
            expect(question()).not.toBeNull();
            // CONTROL: with none composing, the same Escape is Cancel.
            await key({ key: 'Escape' });
            expect(done).toHaveBeenCalledWith(null);
        });

        it('Tab to OK and a held Enter there is still no answer', async () => {
            const { answer: pending } = await asked(() => askText('Edit message:', LINES));
            act(() => { ok().focus(); });
            const repeat = new KeyboardEvent('keydown', { key: 'Enter', repeat: true, bubbles: true, cancelable: true });
            await act(async () => { ok().dispatchEvent(repeat); });
            expect(repeat.defaultPrevented, 'the browser would have pressed OK with it').toBe(true);
            await click(cancel());
            await pending;
        });

        it('CONTROL: a question of one line stays the field it was, and leaves Enter to the browser', async () => {
            const { answer: pending } = await asked(() => askText('Name?', 'one line'));
            const input = question()!.querySelector('input')!;
            expect(question()!.querySelector('textarea')).toBeNull();
            const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
            await act(async () => { input.dispatchEvent(enter); });
            expect(enter.defaultPrevented).toBe(false);
            expect(question(), 'jsdom turns no key into an answer; the real browser script does').not.toBeNull();
            await click(cancel());
            await pending;
        });
    });

    it('Cancel on a text question is null, not the text', async () => {
        const { answer: pending } = await asked(() => askText('Ban Bob? Enter reason (optional):'));
        await click(cancel());
        await expect(pending).resolves.toBeNull();
        expect(promptSpy).not.toHaveBeenCalled();
    });

    it('an empty text is an answer too: a ban with no reason', async () => {
        const { answer: pending } = await asked(() => askText('Ban Bob? Enter reason (optional):'));
        await click(ok());
        await expect(pending).resolves.toBe('');
    });

    it('Escape over another dialog closes the question and leaves that dialog', async () => {
        const below = document.createElement('div');
        document.body.appendChild(below);
        const belowRoot = createRoot(below);
        const closed = vi.fn();
        act(() => { belowRoot.render(<NotesDialog title="Below" onClose={closed}><span>below</span></NotesDialog>); });
        const { answer: pending } = await asked(() => askConfirm('On top'));
        await press({ key: 'Escape' });
        await expect(pending).resolves.toBe(false);
        expect(closed, 'the native dialog never let the page see this key').not.toHaveBeenCalled();
        // CONTROL: with no question, that Escape is the dialog's.
        await press({ key: 'Escape' });
        expect(closed).toHaveBeenCalledTimes(1);
        act(() => { belowRoot.unmount(); });
        below.remove();
    });

    // A question listens on the window too, and stopping a key takes nothing from the
    // listeners beside it there. These two listen there, and got in first.
    describe('what also listens on the window', () => {
        let below: HTMLDivElement;
        let belowRoot: ReturnType<typeof createRoot>;
        beforeEach(() => {
            below = document.createElement('div');
            document.body.appendChild(below);
            belowRoot = createRoot(below);
        });
        afterEach(() => {
            act(() => { belowRoot.unmount(); });
            below.remove();
        });

        it('Escape over the picture viewer closes the question and leaves the picture', async () => {
            const closed = vi.fn();
            act(() => { belowRoot.render(<ImageLightbox url="blob:picture" name="p.png" onClose={closed} />); });
            const { answer: pending } = await asked(() => askConfirm('Update now?'));
            await press({ key: 'Escape' });
            await expect(pending).resolves.toBe(false);
            expect(closed).not.toHaveBeenCalled();
            // CONTROL: with no question, that Escape is the viewer's.
            await press({ key: 'Escape' });
            expect(closed).toHaveBeenCalledTimes(1);
        });

        it('and when the viewer has bound again since, so it hears the key after the question', async () => {
            const closed = vi.fn();
            const viewer = () => <ImageLightbox url="blob:picture" name="p.png" onClose={() => closed()} />;
            act(() => { belowRoot.render(viewer()); });
            const { answer: pending } = await asked(() => askConfirm('Update now?'));
            // The page goes on running: what holds the viewer drew again, with a new onClose.
            act(() => { belowRoot.render(viewer()); });
            await press({ key: 'Escape' });
            await expect(pending).resolves.toBe(false);
            expect(closed, 'the question was gone by the time it looked').not.toHaveBeenCalled();
            await press({ key: 'Escape' });
            expect(closed).toHaveBeenCalledTimes(1);
        });

        it('nothing typed at a question moves the calendar behind it', async () => {
            const onNavigate = vi.fn();
            const onAdd = vi.fn();
            act(() => {
                belowRoot.render(
                    <Calendar
                        sources={[]} view="month" date="2030-10-07" onNavigate={onNavigate} showCompleted={false} showPlain
                        onToggleCompleted={() => {}} onTogglePlain={() => {}} weekStart={1} now={Date.parse('2030-10-01T12:00:00Z')} coarse={false}
                        onOpen={() => {}} onMove={() => {}} onAdd={onAdd} onToggleDone={() => {}} shortcutsEnabled
                    />,
                );
            });
            const { answer: pending } = await asked(() => askConfirm('Delete it?'));
            for (const key of ['j', 'k', 'n', 'p', 't', 'm', 'd', 'a', 'c']) {
                const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
                await act(async () => { document.activeElement!.dispatchEvent(event); });
                expect(event.defaultPrevented, `${key} took nothing`).toBe(false);
            }
            expect(onNavigate).not.toHaveBeenCalled();
            expect(onAdd).not.toHaveBeenCalled();
            await click(ok());
            await pending;
            // CONTROL: with no question, the same keys are the calendar's.
            await press({ key: 'j' });
            expect(onNavigate).toHaveBeenCalledTimes(1);
            await press({ key: 'c' });
            expect(onAdd).toHaveBeenCalledTimes(1);
        });
    });

    it('sign-out answers what is open with a no', async () => {
        const { answer: pending } = await asked(() => askConfirm('Delete it?'));
        act(() => closeAppDialogs());
        await expect(pending).resolves.toBe(false);
        expect(question()).toBeNull();
    });

    it('tellUserAndWait shows only OK, and goes on when it is pressed', async () => {
        const done = vi.fn();
        const { answer: pending } = await asked(() => tellUserAndWait('Permissions reset. Púca will close.'));
        void pending.then(done);
        expect([...question()!.querySelectorAll('button')].map(b => b.textContent)).toEqual(['OK']);
        await act(async () => { await Promise.resolve(); });
        expect(done).not.toHaveBeenCalled();
        await click(ok());
        expect(done).toHaveBeenCalled();
        expect(alertSpy).not.toHaveBeenCalled();
    });
});

describe('on the desktop a notice stays until it is dismissed', () => {
    beforeEach(desktop);

    it('the answer to a press is one, and never the native alert', () => {
        act(() => tellUser('Could not delete that message.'));
        expect(dialogs!.notices()).toEqual(['Could not delete that message.']);
        expect(alertSpy).not.toHaveBeenCalled();
    });

    it('it takes no focus from what they are typing in', () => {
        const field = document.createElement('textarea');
        document.body.appendChild(field);
        field.focus();
        act(() => leaveNotice('Message failed to send.'));
        expect(document.activeElement).toBe(field);
        field.remove();
    });

    it('it has no lifetime, however long they are away', () => {
        vi.useFakeTimers();
        act(() => leaveNotice('Message failed to send.'));
        act(() => { vi.advanceTimersByTime(60 * 60 * 1000); });
        expect(dialogs!.notices()).toEqual(['Message failed to send.']);
    });

    it('good news with `brief` does go away by itself', () => {
        vi.useFakeTimers();
        act(() => tellUser('Message pinned!', { brief: true }));
        expect(dialogs!.notices()).toEqual(['Message pinned!']);
        act(() => { vi.advanceTimersByTime(5_000); });
        expect(dialogs!.notices()).toEqual([]);
    });

    it('its button dismisses that one', () => {
        act(() => { leaveNotice('One'); leaveNotice('Two'); });
        const closeFirst = document.querySelector<HTMLButtonElement>('.app-notice-close')!;
        act(() => { closeFirst.click(); });
        expect(dialogs!.notices()).toEqual(['Two']);
    });

    describe('a press on it is no press on what they were doing', () => {
        const press = (el: Element, type: string) => {
            const event = new MouseEvent(type, { bubbles: true, cancelable: true });
            act(() => { el.dispatchEvent(event); });
            return event;
        };
        const PRESSES = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'click', 'contextmenu'];
        let heard: string[];
        const listen = (e: Event) => { heard.push(e.type); };
        beforeEach(() => {
            heard = [];
            for (const type of PRESSES) document.addEventListener(type, listen);
            act(() => leaveNotice('Message failed to send.'));
        });
        afterEach(() => { for (const type of PRESSES) document.removeEventListener(type, listen); });

        // What QuickAdd's outside press listens on, and a menu's outside click.
        it.each(['.app-notice-close', '.app-notice-text'])('%s: it goes no further than the notice', selector => {
            const el = document.querySelector(selector)!;
            for (const type of PRESSES.filter(t => t !== 'click')) press(el, type);
            expect(heard).toEqual([]);
            // CONTROL: what is not the notice is heard, each of them.
            for (const type of PRESSES) press(document.body, type);
            expect(heard).toEqual(PRESSES);
        });

        it('the X leaves the focus where it is, and the words do not', () => {
            expect(press(document.querySelector('.app-notice-close')!, 'mousedown').defaultPrevented).toBe(true);
            expect(press(document.querySelector('.app-notice-text')!, 'mousedown').defaultPrevented, 'selecting needs it').toBe(false);
        });

        it('and the X still dismisses it', () => {
            act(() => { document.querySelector<HTMLButtonElement>('.app-notice-close')!.click(); });
            expect(dialogs!.notices()).toEqual([]);
            expect(heard, 'nor is that click heard').toEqual([]);
        });
    });

    it('the same words twice are one notice, and a burst keeps the newest', () => {
        act(() => { leaveNotice('Slow down'); leaveNotice('Slow down'); });
        expect(dialogs!.notices()).toEqual(['Slow down']);
        act(() => { for (let i = 0; i < 8; i++) leaveNotice(`n${i}`); });
        expect(dialogs!.notices()).toEqual(['n3', 'n4', 'n5', 'n6', 'n7']);
    });

    it('sign-out takes them away', () => {
        act(() => leaveNotice('One'));
        act(() => closeAppDialogs());
        expect(dialogs!.notices()).toEqual([]);
    });
});
