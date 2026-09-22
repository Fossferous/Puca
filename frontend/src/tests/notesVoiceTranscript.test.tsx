/**
 * What happens to a voice note AFTER it is kept — in the open note and in the
 * composer. Three things that were wrong and looked right:
 *
 *  1. The transcript was written to the note BEHIND its text field. That
 *     field keeps an unsaved draft which wins over an external body change,
 *     and its own autosave then wrote that draft back over the transcript —
 *     so a user who typed while the phone was transcribing silently lost the
 *     words, and with them the only thing that makes a voice note findable.
 *  2. The editor never revoked the preview URL the recorder handed it. The
 *     recorder deliberately does NOT revoke it on the Keep path (the caller
 *     owns it from then on), so nothing did, and every take pinned its
 *     decoded audio in the tab for as long as the page lived.
 *  3. A voice note kept in the COMPOSER was never written down at all: it
 *     became a note titled "Voice note" with an empty body, which search —
 *     which reads text and never attachment names — can never find.
 *
 * Every assertion below is on what the user would get, and each block carries
 * a positive control so it cannot pass by doing nothing at all.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const transcribeClip = vi.fn();
vi.mock('../notes/model/transcribe', () => ({
    transcribeClip: (blob: Blob, ms: number) => transcribeClip(blob, ms),
}));
vi.mock('../api/listContent', async (orig) => {
    const real = await orig<typeof import('../api/listContent')>();
    return { ...real, deleteFiles: vi.fn(async () => {}) };
});

import { NoteContentSection } from '../notes/components/NoteContentSection';
import { QuickAdd } from '../notes/components/QuickAdd';
import { setMessageToastSink } from '../components/messageToastBus';
import type { NoteActions } from '../notes/model/notesQueries';
import type { NoteCard } from '../notes/model/notesModel';

// --- a fake microphone, the same shape notesAudioUi.test.tsx installs -----------------

let tracks: { stop: () => void; stopped: boolean }[] = [];
let recorderInstances: FakeRecorder[] = [];

class FakeRecorder {
    static isTypeSupported = (m: string) => m === 'audio/webm;codecs=opus';
    state = 'inactive';
    ondataavailable: ((e: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    constructor(public stream: unknown, public opts: { mimeType: string }) { recorderInstances.push(this); }
    start() { this.state = 'recording'; }
    stop() {
        this.state = 'inactive';
        this.ondataavailable?.({ data: new Blob([new Uint8Array(64)], { type: this.opts.mimeType }) });
        this.onstop?.();
    }
}

function installMic() {
    tracks = [];
    recorderInstances = [];
    (globalThis as unknown as { MediaRecorder: unknown }).MediaRecorder = FakeRecorder;
    navigator.mediaDevices.getUserMedia = vi.fn(async () => {
        const t = { stopped: false, stop() { this.stopped = true; } };
        tracks.push(t);
        return { getTracks: () => tracks } as unknown as MediaStream;
    }) as unknown as typeof navigator.mediaDevices.getUserMedia;
}

// --- harness -------------------------------------------------------------------------

let host: HTMLDivElement;
let root: Root;
let toasts: string[];
let created: string[];
let revoked: string[];

const settle = async () => { await act(async () => { for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0)); }); };
const buttons = () => [...document.querySelectorAll('button')] as HTMLButtonElement[];
const byText = (t: string) => buttons().find(b => b.textContent?.trim() === t);
const byLabel = (l: string) => document.querySelector(`button[aria-label="${l}"]`) as HTMLButtonElement | null;
const area = () => host.querySelector('textarea.nb-text') as HTMLTextAreaElement;

function type(el: HTMLTextAreaElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    act(() => {
        setter.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
    });
}

function typeInput(el: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
        setter.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
    });
}

const input = (label: string) => document.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;

/** Record a take and press Keep. Leaves whatever `transcribeClip` does next
 *  in flight, which is the whole point. */
async function recordAndKeep(label: string) {
    await act(async () => { byLabel(label)!.click(); });
    await settle();
    expect(recorderInstances.length, 'the recorder never took the microphone').toBe(1);
    await act(async () => { recorderInstances[0].stop(); });
    await settle();
    const keep = byText('Keep');
    expect(keep, 'there was no take to keep').toBeTruthy();
    await act(async () => { keep!.click(); });
    await settle();
}

/** A transcribeClip that stays pending until the test resolves it. */
function pendingTranscribe() {
    let done!: (v: { text: string | null; reason: string | null }) => void;
    transcribeClip.mockImplementation(() => new Promise(r => { done = r; }));
    return async (v: { text: string | null; reason: string | null }) => {
        await act(async () => { done(v); await Promise.resolve(); });
        await settle();
    };
}

beforeEach(() => {
    toasts = [];
    created = [];
    revoked = [];
    installMic();
    transcribeClip.mockReset();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const realCreate = URL.createObjectURL.bind(URL);
    vi.spyOn(URL, 'createObjectURL').mockImplementation((b: Blob | MediaSource) => {
        const u = realCreate(b as Blob);
        created.push(u);
        return u;
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((u: string) => { revoked.push(u); });
    setMessageToastSink(t => { toasts.push(t.title); });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(async () => {
    await act(async () => { root.unmount(); });
    host.remove();
    document.body.innerHTML = '';
    setMessageToastSink(null);
    vi.restoreAllMocks();
});

// --- the open note -------------------------------------------------------------------

const LIST = { kind: 'list' as const, id: 1 };
const card = {
    key: 'list:1', ref: LIST, title: 'Shopping', body: 'Shopping', noteAttachments: null,
} as unknown as NoteCard;

function editorActions() {
    const setBody = vi.fn(async () => true);
    const addNoteMedia = vi.fn(async () => true);
    const actions = {
        content: { features: { body: true, attachments: true }, setBody, addNoteMedia, setNoteAttachments: vi.fn(async () => true) },
    } as unknown as NoteActions;
    return { actions, setBody, addNoteMedia };
}

async function openEditor(actions: NoteActions) {
    await act(async () => { root.render(<NoteContentSection card={card} actions={actions} tasks={[]} tasksLoaded />); });
    await settle();
}

describe('an open note: the transcript goes through the text field, not behind it', () => {
    it('adds what was heard to what is being TYPED, and saves both', async () => {
        const f = editorActions();
        const resolveWith = pendingTranscribe();
        await openEditor(f.actions);
        await recordAndKeep('Voice note');
        expect(f.addNoteMedia, 'the clip was not saved').toHaveBeenCalledTimes(1);

        // The recorder sheet is gone and the phone is still listening: this
        // is exactly the moment the user carries on typing.
        type(area(), 'Shopping\neggs');
        await resolveWith({ text: 'milk and bread', reason: null });

        const saved = f.setBody.mock.calls.map(c => c[1] as string);
        expect(saved.at(-1), 'the transcript was not added to the typed draft').toBe('Shopping\neggs\n\nmilk and bread');
        // The old behaviour: appended to the SAVED body, so the draft's own
        // autosave would put "Shopping\neggs" back over it.
        expect(saved).not.toContain('Shopping\n\nmilk and bread');
        expect(area().value).toBe('Shopping\neggs\n\nmilk and bread');
    });

    it('POSITIVE CONTROL: with nothing typed it still lands, below the note’s own words', async () => {
        const f = editorActions();
        const resolveWith = pendingTranscribe();
        await openEditor(f.actions);
        await recordAndKeep('Voice note');
        await resolveWith({ text: 'milk and bread', reason: null });
        expect(f.setBody.mock.calls.at(-1)?.[1]).toBe('Shopping\n\nmilk and bread');
    });

    it('frees the preview blob once the clip is kept', async () => {
        const f = editorActions();
        const resolveWith = pendingTranscribe();
        await openEditor(f.actions);
        await recordAndKeep('Voice note');
        // Positive control: a preview URL was made, so "revoked" below is not
        // vacuously true.
        expect(created.length).toBeGreaterThan(0);
        expect(revoked, 'revoked before the transcript was even written').not.toContain(created.at(-1));
        await resolveWith({ text: 'milk and bread', reason: null });
        expect(revoked).toContain(created.at(-1));
    });

    it('a refusal is shown in words, the clip is still saved, and the blob is still freed', async () => {
        const f = editorActions();
        const resolveWith = pendingTranscribe();
        await openEditor(f.actions);
        await recordAndKeep('Voice note');
        await resolveWith({ text: null, reason: 'This device can’t write down recordings on its own, so it didn’t — the recording is saved.' });
        expect(host.querySelector('.notes-transcribe-notice')?.textContent).toMatch(/can’t write down/);
        expect(f.addNoteMedia).toHaveBeenCalledTimes(1);
        expect(f.setBody).not.toHaveBeenCalled();
        expect(revoked).toContain(created.at(-1));
    });

    it('removing a recording asks about a recording, not a picture', async () => {
        const f = editorActions();
        const withClip = {
            ...card,
            noteAttachments: JSON.stringify([{
                href: `sovereign-enc:file-1?k=${'A'.repeat(43)}&m=${encodeURIComponent('audio/webm')}`,
                name: 'voice-1.webm',
            }]),
        } as unknown as NoteCard;
        await act(async () => { root.render(<NoteContentSection card={withClip} actions={f.actions} tasks={[]} tasksLoaded />); });
        await settle();
        const confirm = vi.mocked(window.confirm);
        confirm.mockClear();
        confirm.mockReturnValue(false);
        const remove = byLabel('Remove voice note');
        expect(remove, 'the clip did not render as a removable gallery item').toBeTruthy();
        await act(async () => { remove!.click(); });
        expect(confirm.mock.calls[0][0]).toMatch(/Remove this voice note\?/);
    });
});

// --- the composer --------------------------------------------------------------------

describe('the composer: a voice note is written down there too', () => {
    const openComposer = async (onCreate: (t: string, i: string[], e?: unknown) => Promise<boolean>) => {
        await act(async () => {
            root.render(<QuickAdd
                onCreate={onCreate as never}
                content={{ text: true, pictures: true }}
                openSignal={1}
            />);
        });
        await settle();
    };

    it('the words it heard are saved WITH the note, in its text', async () => {
        const onCreate = vi.fn(async () => true);
        const resolveWith = pendingTranscribe();
        await openComposer(onCreate);
        await recordAndKeep('Voice note');
        await resolveWith({ text: 'pick up the prescription on Thursday', reason: null });
        await act(async () => { byText('Done')!.click(); });
        await settle();
        expect(onCreate).toHaveBeenCalledTimes(1);
        const extra = onCreate.mock.calls[0][2] as { body?: string; audio?: File[] };
        expect(extra.audio, 'the recording itself was not saved').toHaveLength(1);
        expect(extra.body, 'the note was saved without what was said').toBe('pick up the prescription on Thursday');
    });

    it('Done WAITS for a transcript still being written', async () => {
        const onCreate = vi.fn(async () => true);
        const resolveWith = pendingTranscribe();
        await openComposer(onCreate);
        await recordAndKeep('Voice note');
        await act(async () => { byText('Done')!.click(); });
        await settle();
        // The assertion that fails if the save stops waiting: saving now
        // would create the note with no text at all.
        expect(onCreate, 'the note was saved before the phone had finished').not.toHaveBeenCalled();
        await resolveWith({ text: 'pick up the prescription', reason: null });
        await settle();
        expect(onCreate).toHaveBeenCalledTimes(1);
        expect((onCreate.mock.calls[0][2] as { body?: string }).body).toBe('pick up the prescription');
    });

    it('POSITIVE CONTROL: a refusal says so and still saves the recording', async () => {
        const onCreate = vi.fn(async () => true);
        const resolveWith = pendingTranscribe();
        await openComposer(onCreate);
        await recordAndKeep('Voice note');
        await resolveWith({ text: null, reason: 'This device can’t write down recordings on its own, so it didn’t — the recording is saved.' });
        expect(document.querySelector('.notes-transcribe-notice')?.textContent).toMatch(/can’t write down/);
        await act(async () => { byText('Done')!.click(); });
        await settle();
        const extra = onCreate.mock.calls[0][2] as { body?: string; audio?: File[] };
        expect(extra.audio).toHaveLength(1);
        expect(extra.body).toBeUndefined();
    });

    it('what is typed WHILE the phone is writing it down is in the note', async () => {
        const onCreate = vi.fn(async () => true);
        const resolveWith = pendingTranscribe();
        await openComposer(onCreate);
        await recordAndKeep('Voice note');
        await act(async () => { byText('Done')!.click(); });
        await settle();
        expect(onCreate, 'the save did not wait, so there is no window to test').not.toHaveBeenCalled();

        // The composer is still on the screen, the notice reads "Writing down
        // what you said…", and nothing here is disabled: this is exactly when
        // someone adds the shop's name.
        expect(document.querySelector('.notes-transcribe-notice')?.textContent).toMatch(/Writing down/);
        typeInput(input('Title'), 'Milk from the corner shop');
        typeInput(input('Item 1'), 'eggs');

        await resolveWith({ text: 'pick up the prescription', reason: null });
        await settle();
        expect(onCreate).toHaveBeenCalledTimes(1);
        expect(onCreate.mock.calls[0][0], 'the title was read from the render that started the save').toBe('Milk from the corner shop');
        expect(onCreate.mock.calls[0][1], 'the item typed during the wait was dropped').toContain('eggs');
        // Positive control: the words it heard still made it in, so this is
        // not passing because the transcript path broke.
        expect((onCreate.mock.calls[0][2] as { body?: string }).body).toBe('pick up the prescription');
    });

    it('Discard during that wait cancels the save — it does not land on the NEXT note', async () => {
        const onCreate = vi.fn(async () => true);
        const resolveWith = pendingTranscribe();
        await openComposer(onCreate);
        await recordAndKeep('Voice note');
        await act(async () => { byText('Done')!.click(); });
        await settle();
        expect(onCreate).not.toHaveBeenCalled();

        // Changed their mind while it was still thinking. window.confirm is
        // mocked true, so "Discard this note?" is answered yes.
        await act(async () => { byLabel('Discard note')!.click(); });
        await settle();

        // And they start the NEXT note, still inside the old wait.
        await act(async () => { byText('Take a note…')!.click(); });
        expect(byText('Saving…'), 'the reopened composer still claims to be saving the note that was discarded, so its Done is dead').toBeUndefined();
        typeInput(input('Title'), 'Bread');
        expect(onCreate).not.toHaveBeenCalled();

        await resolveWith({ text: 'pick up the prescription', reason: null });
        await settle();
        // Nobody pressed Done on "Bread". A save that survives its own
        // Discard picks the live draft up and creates it behind their back —
        // and then resets the composer, taking the typing with it.
        expect(onCreate, 'the cancelled save created the next note by itself').not.toHaveBeenCalled();
        expect(input('Title').value, 'the cancelled save wiped the draft on screen').toBe('Bread');

        // POSITIVE CONTROL: their own Done still works, and carries nothing
        // of the discarded note — no recording, no words.
        await act(async () => { byText('Done')!.click(); });
        await settle();
        expect(onCreate).toHaveBeenCalledTimes(1);
        expect(onCreate.mock.calls[0][0]).toBe('Bread');
        expect(onCreate.mock.calls[0][2], 'the discarded recording came back').toBeUndefined();
    });

    it('a take that is removed takes its words with it', async () => {
        const onCreate = vi.fn(async () => true);
        const resolveWith = pendingTranscribe();
        await openComposer(onCreate);
        await recordAndKeep('Voice note');
        await resolveWith({ text: 'pick up the prescription', reason: null });
        await act(async () => { byLabel('Remove recording')!.click(); });
        await settle();
        // Nothing left to save, so Done just closes: the words of a deleted
        // recording must not turn up in the next note.
        await act(async () => { byText('Done')!.click(); });
        await settle();
        expect(onCreate).not.toHaveBeenCalled();
        expect(toasts).toEqual([]);
    });
});
