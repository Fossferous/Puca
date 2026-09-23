/**
 * "Save to Notes" — the picker.
 *
 * The rule with teeth: only PERSONAL lists are offered. A channel checklist is
 * a shared note, and writing a captured message into one would publish it to
 * every member of that channel — per-person sharing is deferred by the owner,
 * and it is not going to arrive by accident through this modal. `GET
 * /task-lists` returns only personal lists, so the guard is that the modal
 * asks THAT endpoint and nothing else; a switch to `listTasks`/channel tabs
 * would turn this red.
 *
 * Also covered: a note whose title cannot be read is not a target, a note
 * whose sidecar or TEXT is locked cannot be written to at all (every write
 * here replaces what is stored, so it would seal the capture over content the
 * user still has under a key this device has not got), the refusal survives
 * the reason arriving AFTER the pick, and a failed save leaves the modal open
 * with the picked target intact rather than throwing the work away — without
 * leaving a half-made note behind.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ENC_KEY_UNAVAILABLE, TASK_DECRYPT_FAILED } from '../api/decryptMarkers';
import type { TaskList } from '../api/tasks';

const calls = { created: [] as unknown[], tasks: [] as unknown[], urls: [] as string[] };
let lists: TaskList[] = [];
let features = { attachments: true, dedupes: true };
let createFails = false;
let addItemFails = false;
/** The item request's answer is lost (a fetch TypeError, not a refusal). */
let addItemLost = false;
let deleteListFails = false;
let attachFails = false;
/** The picture write's answer is lost (it may have landed). */
let attachLost = false;
let copyFails = false;
/** One create that the server COMMITS but whose answer never arrives. */
let createAnswerLost = false;
/** Holds `copyRefsIntoMyNote` open so a save can be observed IN FLIGHT. */
let copyGate: { promise: Promise<void>; release: () => void } | null = null;
function holdCopies(): () => void {
    let release!: () => void;
    const promise = new Promise<void>(r => { release = r; });
    copyGate = { promise, release };
    return release;
}

vi.mock('../api/tasks', async (orig) => {
    const real = await orig<typeof import('../api/tasks')>();
    return {
        ...real,
        listTaskLists: vi.fn(async () => { calls.urls.push('/task-lists'); return lists; }),
        createListTask: vi.fn(async (listId: number, description: string) => {
            if (addItemFails) throw new Error('the item would not go in');
            if (addItemLost) throw new TypeError('Failed to fetch');
            calls.tasks.push({ listId, description });
            return {};
        }),
        deleteTaskList: vi.fn(async () => { if (deleteListFails) throw new Error('delete refused'); }),
    };
});
vi.mock('../api/listContent', async (orig) => {
    const real = await orig<typeof import('../api/listContent')>();
    return {
        ...real,
        fetchListFeatures: vi.fn(async () => ({ ...real.NO_LIST_FEATURES, attachments: features.attachments, body: true, idempotentCreates: features.dedupes })),
        createTaskListWithContent: vi.fn(async (title: string, content: unknown) => {
            if (createFails) throw new Error('server said no');
            if (createAnswerLost) { createAnswerLost = false; throw new TypeError('Failed to fetch'); }
            calls.created.push({ title, content });
            return { id: 99, title } as TaskList;
        }),
        setTaskListBody: vi.fn(async () => undefined),
        setTaskListAttachments: vi.fn(async () => { if (attachFails) throw new Error('the pictures would not go in'); }),
        addTaskListAttachments: vi.fn(async () => {
            if (attachFails) throw new Error('the pictures would not go in');
            if (attachLost) throw new TypeError('Failed to fetch');
            return [];
        }),
    };
});
vi.mock('../api/captureToNote', async (orig) => {
    const real = await orig<typeof import('../api/captureToNote')>();
    return {
        ...real,
        copyRefsIntoMyNote: vi.fn(async (refs: { href: string; name: string }[]) => {
            if (copyGate) await copyGate.promise;
            if (copyFails) throw new Error('the copies would not upload');
            return refs.map((r, i) => ({ href: `sovereign-enc:COPY${i}?k=NEW${i}`, name: r.name }));
        }),
        discardCopies: vi.fn(async () => undefined),
    };
});

import { SaveToNoteModal } from '../components/SaveToNoteModal';
import { addTaskListAttachments, createTaskListWithContent, setTaskListAttachments, setTaskListBody } from '../api/listContent';
import { NoteConflictError } from '../api/listConflict';
import { deleteTaskList } from '../api/tasks';
import { discardCopies } from '../api/captureToNote';
import { OP_KEY_SHAPE } from '../api/opKey';

const list = (id: number, title: string, attachments: string | null = null, body: string | null = null): TaskList =>
    ({ id, title, created_at: '', total_tasks: 0, completed_tasks: 0, attachments, body }) as TaskList;

async function mount(content: string) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const saved: string[] = [];
    let closed = false;
    await act(async () => {
        createRoot(host).render(
            <SaveToNoteModal content={content} onClose={() => { closed = true; }} onSaved={t => saved.push(t)} />,
        );
    });
    for (let i = 0; i < 8; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    return { saved, isClosed: () => closed };
}

const rows = () => [...document.querySelectorAll('.save-note-row')] as HTMLButtonElement[];
const rowText = () => rows().map(r => (r.textContent ?? '').trim());
const click = (el: Element | null | undefined) => { if (!el) throw new Error('no element'); act(() => { (el as HTMLElement).click(); }); };
const rowNamed = (t: string) => rows().find(r => (r.textContent ?? '').includes(t));
const flush = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };

beforeEach(() => {
    // Calls accumulate across tests otherwise, and mock.calls[0] would be the
    // PREVIOUS test's — a green assertion about the wrong save.
    vi.clearAllMocks();
    calls.created = []; calls.tasks = []; calls.urls = [];
    features = { attachments: true, dedupes: true };
    createFails = false;
    addItemFails = false;
    addItemLost = false;
    deleteListFails = false;
    attachFails = false;
    attachLost = false;
    copyFails = false;
    createAnswerLost = false;
    copyGate = null;
    lists = [
        list(1, 'Shopping'),
        list(2, ENC_KEY_UNAVAILABLE),
        list(3, 'Holiday', TASK_DECRYPT_FAILED),
        // Readable title, readable sidecar, UNREADABLE text.
        list(4, 'Journal', null, ENC_KEY_UNAVAILABLE),
    ];
});
afterEach(() => { document.body.innerHTML = ''; });

describe('the target list', () => {
    it('offers New note and your own notes — and asks only /task-lists, never a channel', async () => {
        await mount('pack the tent');
        expect(rowText()).toContain('New note');
        expect(rowText()).toContain('Shopping');
        expect(calls.urls).toEqual(['/task-lists']);
    });

    it('leaves out a note whose title this device cannot read', async () => {
        await mount('pack the tent');
        expect(rowText().some(t => t.includes(ENC_KEY_UNAVAILABLE))).toBe(false);
    });

    it('disables a note with a locked sidecar while pictures are being copied, and enables it when they are not', async () => {
        await mount('see this ![a.png](sovereign-enc:SRC?k=K&m=image%2Fpng)');
        expect(rowNamed('Holiday')!.disabled).toBe(true);
        click(document.querySelector('.save-note-check input'));  // untick "also keep pictures"
        expect(rowNamed('Holiday')!.disabled).toBe(false);
    });

    it('disables a note whose TEXT cannot be read, once the text is what would be written', async () => {
        // Two lines, so the shape defaults to "As the note's text" — the one
        // path that REPLACES the stored body.
        await mount('pack the tent\nand the stove');
        expect(rowNamed('Journal')!.disabled).toBe(true);
        expect(rowNamed('Journal')!.title).toMatch(/text can.t be read/i);
        // ...and it is fine as an ITEM: that appends a row, it overwrites nothing.
        click(document.querySelector('.save-note-shape button'));  // "As an item"
        expect(rowNamed('Journal')!.disabled).toBe(false);
    });

    it('a note picked as an item stops being savable the moment the shape becomes its text', async () => {
        await mount('pack the tent');
        click(rowNamed('Journal'));
        expect((document.querySelector('.save-note-go') as HTMLButtonElement).disabled).toBe(false);
        click(document.querySelectorAll('.save-note-shape button')[1]);  // "As the note's text"
        expect(rowNamed('Journal')!.disabled).toBe(true);
        expect((document.querySelector('.save-note-go') as HTMLButtonElement).disabled).toBe(true);
    });

    it('says so instead of offering pictures when the server cannot hold them', async () => {
        features = { attachments: false, dedupes: true };
        await mount('see this ![a.png](sovereign-enc:SRC?k=K&m=image%2Fpng)');
        expect(document.querySelector('.save-note-check')).toBeNull();
        expect(document.querySelector('.save-note-hint')!.textContent).toMatch(/only the text/i);
    });
});

describe('saving', () => {
    it('saves nothing until a target is picked', async () => {
        await mount('pack the tent');
        expect((document.querySelector('.save-note-go') as HTMLButtonElement).disabled).toBe(true);
    });

    it('a new note takes the message as an item, titled after it', async () => {
        const { saved, isClosed } = await mount('pack the tent');
        click(rowNamed('New note'));
        click(document.querySelector('.save-note-go'));
        for (let i = 0; i < 10; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); });
        expect(vi.mocked(createTaskListWithContent).mock.calls[0][0]).toBe('pack the tent');
        expect(calls.tasks).toEqual([{ listId: 99, description: 'pack the tent' }]);
        expect(saved).toEqual(['pack the tent']);
        expect(isClosed()).toBe(true);
    });

    it('the copied picture is a NEW file, and its key never comes from the message', async () => {
        await mount('look ![a.png](sovereign-enc:SRC?k=THEIRKEY&m=image%2Fpng)');
        click(rowNamed('New note'));
        click(document.querySelector('.save-note-go'));
        for (let i = 0; i < 10; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); });
        const content = vi.mocked(createTaskListWithContent).mock.calls[0][1] as { refs?: { href: string }[] };
        expect(content.refs?.[0].href).toContain('COPY0');
        expect(content.refs?.[0].href).not.toContain('THEIRKEY');
    });

    it('NEVER writes over a body this device cannot read, even with both buttons forced', async () => {
        await mount('pack the tent\nand the stove');
        // Force the disabled row and click it, the way a stale pick would.
        rowNamed('Journal')!.disabled = false;
        click(rowNamed('Journal'));
        // The pick does not become a target: Save stays dead...
        expect((document.querySelector('.save-note-go') as HTMLButtonElement).disabled).toBe(true);
        // ...and forcing THAT too still writes nothing, because the refusal is
        // what Save is derived from, not a separate check beside it.
        (document.querySelector('.save-note-go') as HTMLButtonElement).disabled = false;
        click(document.querySelector('.save-note-go'));
        for (let i = 0; i < 10; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); });
        expect(setTaskListBody).not.toHaveBeenCalled();
        expect(createTaskListWithContent).not.toHaveBeenCalled();
    });

    it('un-ticking pictures, picking a locked note, then re-ticking does not orphan its pictures', async () => {
        await mount('see this ![a.png](sovereign-enc:SRC?k=K&m=image%2Fpng)');
        click(document.querySelector('.save-note-check input'));   // untick
        click(rowNamed('Holiday'));                                 // now allowed
        expect((document.querySelector('.save-note-go') as HTMLButtonElement).disabled).toBe(false);
        click(document.querySelector('.save-note-check input'));   // re-tick
        expect(rowNamed('Holiday')!.disabled).toBe(true);
        expect((document.querySelector('.save-note-go') as HTMLButtonElement).disabled).toBe(true);
        (document.querySelector('.save-note-go') as HTMLButtonElement).disabled = false;
        click(document.querySelector('.save-note-go'));
        for (let i = 0; i < 10; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); });
        expect(setTaskListAttachments).not.toHaveBeenCalled();
        expect(addTaskListAttachments).not.toHaveBeenCalled();
    });

    /**
     * Into an EXISTING note, both writes used to replace what the server holds
     * with this modal's snapshot of it, taken when the sheet opened, with no
     * revision (finding 7): a picture — or a paragraph — another device added
     * meanwhile was silently dropped.
     */
    it('pictures go into an existing note as an INTENT against what the server holds now', async () => {
        await mount('look ![a.png](sovereign-enc:SRC?k=K&m=image%2Fpng)');
        click(rowNamed('Shopping'));
        click(document.querySelector('.save-note-go'));
        await flush();
        expect(addTaskListAttachments).toHaveBeenCalledWith(1, [{ href: 'sovereign-enc:COPY0?k=NEW0', name: 'a.png' }]);
        expect(setTaskListAttachments).not.toHaveBeenCalled();
    });

    it('text appended to an existing note names the revision it read, and re-appends onto a newer copy', async () => {
        lists = [{ ...list(1, 'Shopping', null, 'old words'), content_rev: 5 } as TaskList];
        vi.mocked(setTaskListBody).mockRejectedValueOnce(new NoteConflictError(7, 'their words', null, null));
        const { isClosed } = await mount('keep this\nand this');
        click(rowNamed('Shopping'));
        click(document.querySelector('.save-note-go'));
        await flush();
        expect(vi.mocked(setTaskListBody).mock.calls).toEqual([
            [1, 'old words\n\nkeep this\nand this', 5],
            [1, 'their words\n\nkeep this\nand this', 7],
        ]);
        expect(isClosed()).toBe(true);
    });

    it('...but never appends onto a newer copy it cannot READ', async () => {
        lists = [{ ...list(1, 'Shopping', null, 'old words'), content_rev: 5 } as TaskList];
        vi.mocked(setTaskListBody).mockRejectedValueOnce(new NoteConflictError(7, ENC_KEY_UNAVAILABLE, null, null));
        const { isClosed } = await mount('keep this\nand this');
        click(rowNamed('Shopping'));
        click(document.querySelector('.save-note-go'));
        await flush();
        expect(setTaskListBody).toHaveBeenCalledTimes(1);
        expect(isClosed()).toBe(false);
    });

    it('a new note that half-saved is undone, not left behind with broken pictures', async () => {
        addItemFails = true;
        await mount('look ![a.png](sovereign-enc:SRC?k=K&m=image%2Fpng)');
        click(rowNamed('New note'));
        click(document.querySelector('.save-note-go'));
        for (let i = 0; i < 10; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); });
        // The list was created and NAMES the copies, so it goes first...
        expect(deleteTaskList).toHaveBeenCalledWith(99);
        // ...and only then are the files safe to take back.
        expect(discardCopies).toHaveBeenCalledTimes(1);
        expect(document.querySelector('.save-note-error')!.textContent).toMatch(/would not go in/);
    });

    /**
     * Kept copies are for a write that may have NAMED them. A lost answer on
     * the ITEM names nothing: the new note it went into is undone, and into
     * an existing note no picture write has been tried yet — so the copies
     * still go back, whatever kind of failure it was.
     */
    it('a lost answer on the ITEM still takes the copies back: nothing names them', async () => {
        addItemLost = true;
        await mount('look ![a.png](sovereign-enc:SRC?k=K&m=image%2Fpng)');
        click(rowNamed('New note'));
        click(document.querySelector('.save-note-go'));
        await flush();
        expect(deleteTaskList).toHaveBeenCalledWith(99);
        expect(discardCopies).toHaveBeenCalledTimes(1);
    });

    it('POSITIVE CONTROL: a lost answer on the PICTURE write keeps the copies — the note may name them', async () => {
        attachLost = true;
        await mount('look ![a.png](sovereign-enc:SRC?k=K&m=image%2Fpng)');
        click(rowNamed('Shopping'));
        click(document.querySelector('.save-note-go'));
        await flush();
        expect(addTaskListAttachments).toHaveBeenCalledTimes(1);
        expect(discardCopies).not.toHaveBeenCalled();
    });

    it('...and the same into an EXISTING note, before any picture write was tried', async () => {
        addItemLost = true;
        await mount('look ![a.png](sovereign-enc:SRC?k=K&m=image%2Fpng)');
        click(rowNamed('Shopping'));
        click(document.querySelector('.save-note-go'));
        await flush();
        expect(addTaskListAttachments).not.toHaveBeenCalled();
        expect(discardCopies).toHaveBeenCalledTimes(1);
    });

    it('when the half-made note CANNOT be undone it keeps the files and says so', async () => {
        addItemFails = true;
        deleteListFails = true;
        await mount('look ![a.png](sovereign-enc:SRC?k=K&m=image%2Fpng)');
        click(rowNamed('New note'));
        click(document.querySelector('.save-note-go'));
        for (let i = 0; i < 10; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); });
        // Deleting the copies here would leave note 99 with broken pictures.
        expect(discardCopies).not.toHaveBeenCalled();
        expect(document.querySelector('.save-note-error')!.textContent).toMatch(/note was made/i);
    });

    it('a failed save keeps the modal open, keeps the target, and takes the copies back', async () => {
        createFails = true;
        const { isClosed } = await mount('look ![a.png](sovereign-enc:SRC?k=K&m=image%2Fpng)');
        click(rowNamed('New note'));
        click(document.querySelector('.save-note-go'));
        for (let i = 0; i < 10; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); });
        expect(isClosed()).toBe(false);
        expect(document.querySelector('.save-note-error')!.textContent).toMatch(/server said no/);
        expect(rowNamed('New note')!.className).toContain('picked');
        expect(discardCopies).toHaveBeenCalledTimes(1);
    });

    /**
     * A create whose ANSWER was lost (finding 4): the server may have made the
     * note, and its sealed sidecar names the copies — so they must not be
     * deleted, and pressing Save again must re-send the same create key and
     * the same copies, so the server answers with the note it already made.
     */
    it('a new note whose answer was lost keeps its copies, and Save again re-sends the same key and copies', async () => {
        createAnswerLost = true;
        const { isClosed } = await mount('look ![a.png](sovereign-enc:SRC?k=K&m=image%2Fpng)');
        click(rowNamed('New note'));
        click(document.querySelector('.save-note-go'));
        await flush();
        expect(isClosed()).toBe(false);
        expect(discardCopies).not.toHaveBeenCalled();
        click(document.querySelector('.save-note-go'));
        await flush();
        expect(isClosed()).toBe(true);
        const { copyRefsIntoMyNote } = await import('../api/captureToNote');
        expect(copyRefsIntoMyNote).toHaveBeenCalledTimes(1);
        const [first, second] = vi.mocked(createTaskListWithContent).mock.calls;
        expect(first[2]).toMatch(OP_KEY_SHAPE);
        expect(second[2]).toBe(first[2]);
        expect(second[1]).toEqual(first[1]);
    });

    it('...but on a server that cannot de-duplicate creates, Save again makes FRESH copies (two notes never share files)', async () => {
        features = { attachments: true, dedupes: false };
        createAnswerLost = true;
        const { isClosed } = await mount('look ![a.png](sovereign-enc:SRC?k=K&m=image%2Fpng)');
        click(rowNamed('New note'));
        click(document.querySelector('.save-note-go'));
        await flush();
        click(document.querySelector('.save-note-go'));
        await flush();
        expect(isClosed()).toBe(true);
        const { copyRefsIntoMyNote } = await import('../api/captureToNote');
        expect(copyRefsIntoMyNote).toHaveBeenCalledTimes(2);
        // The first attempt's copies are not deleted either: they may be named.
        expect(discardCopies).not.toHaveBeenCalled();
    });

    /**
     * An EXISTING note has no undo. The new-note branch deletes the note it
     * made and can honestly say nothing was kept; here the item or the
     * appended text is already in a note the user keeps, so "nothing was kept"
     * would be a lie that earns a retry — and the retry appends the same line
     * a second time.
     */
    it('pictures failing on an EXISTING note says the text was kept, and deletes nothing', async () => {
        attachFails = true;
        await mount('look ![a.png](sovereign-enc:SRC?k=K&m=image%2Fpng)');
        click(rowNamed('Shopping'));
        click(document.querySelector('.save-note-go'));
        await flush();
        // The item went in, and there is no note of ours to take away.
        expect(calls.tasks).toEqual([{ listId: 1, description: 'look' }]);
        expect(deleteTaskList).not.toHaveBeenCalled();
        // Nothing names the copies now, so those DO go back.
        expect(discardCopies).toHaveBeenCalledTimes(1);
        const msg = document.querySelector('.save-note-error')!.textContent ?? '';
        expect(msg).toMatch(/text was kept/i);
        expect(msg).not.toMatch(/nothing was kept/i);
    });

    it('the same on an existing note saved AS ITS TEXT', async () => {
        attachFails = true;
        await mount('look at this\nand this ![a.png](sovereign-enc:SRC?k=K&m=image%2Fpng)');
        click(rowNamed('Shopping'));
        expect((document.querySelector('.save-note-shape button.active') as HTMLButtonElement).textContent)
            .toMatch(/note’s text/);
        click(document.querySelector('.save-note-go'));
        await flush();
        expect(setTaskListBody).toHaveBeenCalledTimes(1);
        expect(document.querySelector('.save-note-error')!.textContent).toMatch(/text was kept/i);
    });

    /** Positive control for the two above: when the failure comes BEFORE any
     *  write lands, the honest message is still the blunt one. */
    it('positive control: a failure before anything lands still says nothing was kept', async () => {
        copyFails = true;
        await mount('look ![a.png](sovereign-enc:SRC?k=K&m=image%2Fpng)');
        click(rowNamed('Shopping'));
        click(document.querySelector('.save-note-go'));
        await flush();
        expect(calls.tasks).toEqual([]);
        expect(document.querySelector('.save-note-error')!.textContent).toMatch(/would not upload/);
    });
});

/**
 * Closing does not CANCEL a save. The copies keep uploading and the note keeps
 * being written, so an exit taken mid-save hides work that then lands — and
 * the obvious next move is to open the sheet and save again, which keeps the
 * message twice and uploads a second set of copies against the quota. Cancel
 * was already disabled while `saving`; the backdrop and the X were not.
 */
describe('the exits while a save is in flight', () => {
    it('the backdrop and the X do nothing until it lands, and it lands once', async () => {
        const release = holdCopies();
        const { saved, isClosed } = await mount('look ![a.png](sovereign-enc:SRC?k=K&m=image%2Fpng)');
        click(rowNamed('New note'));
        click(document.querySelector('.save-note-go'));
        await flush();
        // In flight: the copies are held open.
        expect(document.querySelector('.save-note-go')!.textContent).toMatch(/Saving/);
        expect(createTaskListWithContent).not.toHaveBeenCalled();

        click(document.querySelector('.save-note-overlay'));
        click(document.querySelector('.save-note-close'));
        expect(isClosed()).toBe(false);
        expect((document.querySelector('.save-note-close') as HTMLButtonElement).disabled).toBe(true);
        expect((document.querySelector('.save-note-cancel') as HTMLButtonElement).disabled).toBe(true);

        release();
        await flush();
        expect(createTaskListWithContent).toHaveBeenCalledTimes(1);
        expect(saved).toHaveLength(1);
        expect(isClosed()).toBe(true);
    });

    it('positive control: the X closes when nothing is being saved', async () => {
        const { isClosed } = await mount('pack the tent');
        expect((document.querySelector('.save-note-close') as HTMLButtonElement).disabled).toBe(false);
        click(document.querySelector('.save-note-close'));
        expect(isClosed()).toBe(true);
    });

    it('positive control: the backdrop closes when nothing is being saved', async () => {
        const { isClosed } = await mount('pack the tent');
        click(document.querySelector('.save-note-overlay'));
        expect(isClosed()).toBe(true);
    });
});
