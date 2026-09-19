/**
 * The open note's two conversions (NoteContentSection.tsx) against the
 * offline outbox and a server that can refuse part-way.
 *
 * "Show checkboxes" used to add every item first and clear the text last.
 * Offline the items queued as temporary ones, the text clear then failed, and
 * the note kept its text AND a queued duplicate of every line — with no
 * message. It is now refused while offline or while anything is queued, and
 * it clears the text first.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../notes/model/notesOutbox', async (orig) => {
    const real = await orig<typeof import('../notes/model/notesOutbox')>();
    return { ...real, pendingOutboxCount: vi.fn(() => 0) };
});

import { NoteContentSection } from '../notes/components/NoteContentSection';
import { pendingOutboxCount } from '../notes/model/notesOutbox';
import { setMessageToastSink } from '../components/messageToastBus';
import type { NoteActions } from '../notes/model/notesQueries';
import type { NoteCard } from '../notes/model/notesModel';
import type { Task } from '../api/tasks';

const LIST = { kind: 'list' as const, id: 1 };
const card = { key: 'list:1', ref: LIST, title: 'Shopping', body: 'milk\neggs\nbread', noteAttachments: null } as unknown as NoteCard;
const made = (id: number, description: string): Task => ({
    id, channel_id: null, list_id: 1, parent_id: null, description, is_completed: false, position: id,
    created_at: '', created_by: 7, attachments: null, due_at: null,
});

let log: string[];
let toasts: string[];
function fakeActions(opts: { setBodyOk?: (body: string) => boolean; refuseItem?: string } = {}) {
    let next = 100;
    const setBody = vi.fn(async (_id: number, body: string) => { log.push(`setBody(${JSON.stringify(body)})`); return opts.setBodyOk ? opts.setBodyOk(body) : true; });
    const addTask = vi.fn(async (_n: unknown, text: string) => { log.push(`addTask(${text})`); return text === opts.refuseItem ? null : made(next++, text); });
    const deleteTaskFrom = vi.fn(async (_n: unknown, id: number) => { log.push(`delete(${id})`); return true; });
    const actions = {
        addTask, deleteTaskFrom,
        content: { features: { body: true, attachments: false }, setBody },
    } as unknown as NoteActions;
    return { actions, setBody, addTask, deleteTaskFrom };
}

let root: Root | null = null;
let onLine = true;
let spy: ReturnType<typeof vi.spyOn> | null = null;
beforeEach(() => {
    log = [];
    toasts = [];
    onLine = true;
    vi.mocked(pendingOutboxCount).mockReturnValue(0);
    spy = vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => onLine);
    setMessageToastSink(t => { toasts.push(t.title); });
});
afterEach(() => {
    act(() => { root?.unmount(); });
    root = null;
    document.body.innerHTML = '';
    setMessageToastSink(null);
    spy?.mockRestore();
});

async function convert(actions: NoteActions) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => { root!.render(<NoteContentSection card={card} actions={actions} tasks={[]} tasksLoaded />); });
    const btn = [...host.querySelectorAll('button')].find(b => b.textContent === 'Show checkboxes')!;
    expect(btn).toBeTruthy();
    await act(async () => { btn.click(); });
    for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
}

describe('Show checkboxes never half-applies', () => {
    it('offline: refused with a message — no item queued, the text untouched', async () => {
        onLine = false;
        const f = fakeActions();
        await convert(f.actions);
        expect(f.addTask).not.toHaveBeenCalled();
        expect(f.setBody).not.toHaveBeenCalled();
        expect(toasts).toEqual([expect.stringMatching(/while offline or while changes are waiting to sync/)]);
    });

    it('with changes still queued: refused the same way (every item would queue behind them)', async () => {
        vi.mocked(pendingOutboxCount).mockReturnValue(2);
        const f = fakeActions();
        await convert(f.actions);
        expect(f.addTask).not.toHaveBeenCalled();
        expect(f.setBody).not.toHaveBeenCalled();
        expect(toasts).toHaveLength(1);
    });

    it('POSITIVE CONTROL: online with nothing queued, the text is cleared FIRST, then every line becomes an item', async () => {
        const f = fakeActions();
        await convert(f.actions);
        expect(log).toEqual(['setBody("")', 'addTask(milk)', 'addTask(eggs)', 'addTask(bread)']);
        expect(toasts).toEqual([]);
        expect(document.querySelector('.notes-undo')?.textContent).toMatch(/Turned the text into a checklist/);
    });

    it('the text cannot be cleared: nothing else happens, and it says so', async () => {
        const f = fakeActions({ setBodyOk: () => false });
        await convert(f.actions);
        expect(f.addTask).not.toHaveBeenCalled();
        expect(toasts).toEqual(['Couldn’t turn the text into a checklist — the text is kept']);
    });

    it('an item refused part-way: the text comes back and the items made so far are removed', async () => {
        const f = fakeActions({ refuseItem: 'eggs' });
        await convert(f.actions);
        expect(log).toEqual(['setBody("")', 'addTask(milk)', 'addTask(eggs)', 'setBody("milk\\neggs\\nbread")', 'delete(100)']);
        expect(toasts).toEqual(['Not every line became an item — the text is kept']);
        expect(document.querySelector('.notes-undo')).toBeNull();
    });
});
