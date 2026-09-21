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
 * whose sidecar is locked cannot receive pictures (writing over it would
 * orphan the refs already in it), and a failed save leaves the modal open with
 * the picked target intact rather than throwing the work away.
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

vi.mock('../api/tasks', async (orig) => {
    const real = await orig<typeof import('../api/tasks')>();
    return {
        ...real,
        listTaskLists: vi.fn(async () => { calls.urls.push('/task-lists'); return lists; }),
        createListTask: vi.fn(async (listId: number, description: string) => { calls.tasks.push({ listId, description }); return {}; }),
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
import { createTaskListWithContent } from '../api/listContent';
import { discardCopies } from '../api/captureToNote';

const list = (id: number, title: string, attachments: string | null = null): TaskList =>
    ({ id, title, created_at: '', total_tasks: 0, completed_tasks: 0, attachments }) as TaskList;

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
    lists = [list(1, 'Shopping'), list(2, ENC_KEY_UNAVAILABLE), list(3, 'Holiday', TASK_DECRYPT_FAILED)];
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
