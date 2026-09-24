/**
 * The freshness stamp's blind spot: THIS device's own writes (review of
 * finding 8).
 *
 * A tick says how current its view is (`expect_schedules_as_of`, the newest
 * server `updated_at` among the rows it sweeps), and the server refuses it
 * when a dated row changed after that. Migration 066's trigger stamps
 * `updated_at` on nearly every change — text, date, repeat, attachments, a
 * tick, a move to another parent — and a view that applied its own write
 * optimistically still holds the OLD stamp. Sent, that reads to the server as
 * "this device missed a change", and the user's own edit of a dated item
 * followed by a tick was refused as "changed on another device" — every time,
 * in a view that does not refetch.
 *
 * So every task write goes through one tracker in api/tasks.ts, and a row
 * this device wrote vouches for nothing until a read that STARTED after the
 * write finished has replaced it. Driven through the real writers and the
 * real reader with only the HTTP client mocked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { get, patch, post, del } = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn(), post: vi.fn(), del: vi.fn() }));
vi.mock('../api/client', async () => {
    const real = await vi.importActual<typeof import('../api/client')>('../api/client');
    return { ...real, apiClient: { get, patch, post, delete: del } };
});
vi.mock('../api/taskReminders', () => ({ pokeTaskReminders: () => {} }));

import { planToggle } from '../api/taskCompletion';
import {
    type Task, listListTasks, patchTaskTiming, updateTask, updateListTaskAttachments, reorderTask, moveTask,
    ownWriteUnconfirmed,
} from '../api/tasks';

const T0 = '2030-10-01T09:00:00.123456Z';
const T1 = '2030-10-01T09:05:00.5Z';

/** A wire row (plaintext description: a legacy row opens as itself). */
const wire = (id: number, over: Partial<Task> = {}): Task => ({
    id, channel_id: null, list_id: 1, parent_id: null, description: `t${id}`, is_completed: false, position: id,
    created_at: '2030-09-01T00:00:00Z', created_by: 2, attachments: null, due_at: '2030-10-07T09:00:00.000Z',
    updated_at: T0, ...over,
});

/** What the server holds for list 1. */
let server: Task[] = [];
const read = () => listListTasks(1);
const stampOf = (rows: Task[], id: number) => planToggle(rows, rows.find(t => t.id === id)!, true, { canEdit: true }).patch?.expect_schedules_as_of;

// Every test uses its own ids: the tracker is the module's, for the session.
let nextId = 100;
const ids = (n: number) => Array.from({ length: n }, () => nextId++);

beforeEach(() => {
    get.mockReset(); patch.mockReset(); post.mockReset(); del.mockReset();
    get.mockImplementation(async (path: string) => {
        if (path === '/task-lists/1/tasks') return server.map(t => ({ ...t }));
        throw new Error(`unexpected GET ${path}`);
    });
    patch.mockResolvedValue({});
    post.mockResolvedValue({});
});

describe('a row this device wrote vouches for nothing until the server sends it back', () => {
    it('set a date, then tick: no stale stamp (the reviewer’s scenario) — and a later read restores it', async () => {
        const [x] = ids(1);
        server = [wire(x)];
        let rows = await read();
        expect(stampOf(rows, x), 'freshly read: the stamp rides').toBe(T0);

        // The Tasks tab's date button: optimistic, then one PATCH.
        rows = rows.map(t => (t.id === x ? { ...t, due_at: '2030-10-09T09:00:00.000Z' } : t));
        await patchTaskTiming(rows[0], { due_at: '2030-10-09T09:00:00.000Z' });
        server = [wire(x, { due_at: '2030-10-09T09:00:00.000Z', updated_at: T1 })];   // the trigger's new stamp

        expect(stampOf(rows, x), 'T0 would be refused: the server moved it to T1 for OUR write').toBeUndefined();

        rows = await read();
        expect(stampOf(rows, x), 'read after the write finished: vouched for again').toBe(T1);
    });

    it('every writer counts: text, plain fields, attachments, a move to another parent', async () => {
        const writes: Array<(id: number) => Promise<unknown>> = [
            id => updateTask(id, { description: 'x' }),
            id => updateListTaskAttachments(id, []),
            id => reorderTask(id, null, { parentId: null }),
            id => patchTaskTiming({ id, channel_id: null, created_by: 2 }, { is_completed: false }),
        ];
        for (const write of writes) {
            const [x] = ids(1);
            server = [wire(x)];
            const rows = await read();
            await write(x);
            expect(stampOf(rows, x), String(write)).toBeUndefined();
        }
    });

    it('a write under or above the ticked item counts too (the server sweeps down and reopens up)', async () => {
        const [top, mid, low] = ids(3);
        server = [wire(top), wire(mid, { parent_id: top }), wire(low, { parent_id: mid })];
        let rows = await read();
        await updateTask(low, { description: 'x' });
        expect(stampOf(rows, top), 'below').toBeUndefined();
        rows = await read();
        await updateTask(top, { description: 'x' });
        expect(stampOf(rows, mid), 'above').toBeUndefined();
    });

    it('a read that STARTED before the write finished does not clear it', async () => {
        const [x] = ids(1);
        server = [wire(x)];
        await read();
        let finish!: () => void;
        patch.mockImplementationOnce(() => new Promise<void>(r => { finish = r; }));
        const writing = updateTask(x, { description: 'x' });
        const during = await read();
        expect(ownWriteUnconfirmed(during[0]), 'in flight').toBe(true);
        expect(stampOf(during, x)).toBeUndefined();
        finish();
        await writing;
        expect(stampOf(during, x), 'read while in flight: may predate it').toBeUndefined();
        expect(stampOf(await read(), x), 'read after').toBe(T0);
    });

    it('a failed write still counts until a read (the server may have applied it)', async () => {
        const [x] = ids(1);
        server = [wire(x)];
        const rows = await read();
        patch.mockRejectedValueOnce(new Error('lost answer'));
        await expect(updateTask(x, { description: 'x' })).rejects.toThrow();
        expect(stampOf(rows, x)).toBeUndefined();
        expect(stampOf(await read(), x)).toBe(T0);
    });

    it('POSITIVE CONTROLS: an unrelated row’s write, a position-only move, and a row restored from an earlier session all keep the stamp', async () => {
        const [x, other] = ids(2);
        server = [wire(x), wire(other)];
        const rows = await read();
        await updateTask(other, { description: 'x' });
        await moveTask(x, 'up');   // position is not content: the trigger leaves updated_at alone
        expect(stampOf(rows, x)).toBe(T0);
        // A persisted cache from a previous page load: its read tag is not
        // this session's, and this session wrote nothing to it.
        const restored = rows.map(t => ({ ...t, readAt: 'another-session:5' }));
        expect(stampOf(restored, x)).toBe(T0);
    });
});
