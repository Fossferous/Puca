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
let features = { attachments: true };
let createFails = false;
let addItemFails = false;
let deleteListFails = false;

vi.mock('../api/tasks', async (orig) => {
    const real = await orig<typeof import('../api/tasks')>();
    return {
        ...real,
        listTaskLists: vi.fn(async () => { calls.urls.push('/task-lists'); return lists; }),
        createListTask: vi.fn(async (listId: number, description: string) => {
            if (addItemFails) throw new Error('the item would not go in');
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
        fetchListFeatures: vi.fn(async () => ({ ...real.NO_LIST_FEATURES, attachments: features.attachments, body: true })),
        createTaskListWithContent: vi.fn(async (title: string, content: unknown) => {
            if (createFails) throw new Error('server said no');
            calls.created.push({ title, content });
            return { id: 99, title } as TaskList;
        }),
        setTaskListBody: vi.fn(async () => undefined),
        setTaskListAttachments: vi.fn(async () => undefined),
    };
});
vi.mock('../api/captureToNote', async (orig) => {
    const real = await orig<typeof import('../api/captureToNote')>();
    return {
        ...real,
        copyRefsIntoMyNote: vi.fn(async (refs: { href: string; name: string }[]) =>
            refs.map((r, i) => ({ href: `sovereign-enc:COPY${i}?k=NEW${i}`, name: r.name }))),
        discardCopies: vi.fn(async () => undefined),
    };
});

import { SaveToNoteModal } from '../components/SaveToNoteModal';
import { createTaskListWithContent, setTaskListAttachments, setTaskListBody } from '../api/listContent';
import { deleteTaskList } from '../api/tasks';
import { discardCopies } from '../api/captureToNote';

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

beforeEach(() => {
    // Calls accumulate across tests otherwise, and mock.calls[0] would be the
    // PREVIOUS test's — a green assertion about the wrong save.
    vi.clearAllMocks();
    calls.created = []; calls.tasks = []; calls.urls = [];
    features = { attachments: true };
    createFails = false;
    addItemFails = false;
    deleteListFails = false;
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
        features = { attachments: false };
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
});
