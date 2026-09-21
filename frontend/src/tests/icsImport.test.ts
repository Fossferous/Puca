// The paced .ics import: dedupe by UID, split before the per-list cap, back
// off on 429 and resume exactly where it stopped, cancel cleanly.
import { describe, expect, it, vi } from 'vitest';
import { MAX_PER_LIST, MAX_RETRY_WAIT_MS, PACE_MS, icsImportTargets, importSummary, runImport, type ImportIO } from '../api/icsImport';
import { type IcsImportItem } from '../api/ics';
import { ApiError, apiClient, retryAfterMsOf } from '../api/client';
import { parseSchedule, serializeSchedule } from '../api/taskSchedule';
import { type Task } from '../api/tasks';

const item = (i: number, extra: Partial<IcsImportItem> = {}): IcsImportItem => ({
    kind: 'event', uid: `uid-${i}`, summary: `Event ${i}`, notes: [],
    schedule: { v: 1, kind: 'event', uid: `uid-${i}`, allDay: true, start: '2026-10-05', alertTz: 'UTC', alerts: [-540] },
    ...extra,
});

function fakeIO() {
    let nextId = 100;
    const lists: string[] = [];
    const tasks: { listId: number; text: string; parentId?: number; schedule?: string | null; dueAt?: string | null }[] = [];
    const sleeps: number[] = [];
    const io: ImportIO = {
        createList: vi.fn(async (title: string) => { lists.push(title); return { id: nextId++ }; }),
        createTask: vi.fn(async (listId, text, parentId, timing) => { tasks.push({ listId, text, parentId, schedule: timing?.schedule, dueAt: timing?.dueAt }); return { id: nextId++ }; }),
        sleep: vi.fn(async (ms: number) => { sleeps.push(ms); }),
    };
    return { io, lists, tasks, sleeps };
}

const NOW = Date.parse('2026-10-01T00:00:00Z');

describe('runImport', () => {
    it('creates a new note, one sealed-schedule item each, the description as a subtask, paced', async () => {
        const f = fakeIO();
        const s = await runImport([item(1, { description: 'Bring cake' }), item(2)], { listId: null, title: 'Work', existingCount: 0, existingUids: new Set() }, f.io, { nowMs: NOW, signal: { cancelled: false } });
        expect(f.lists).toEqual(['Work']);
        expect(f.tasks.map(t => t.text)).toEqual(['Event 1', 'Bring cake', 'Event 2']);
        expect(f.tasks[1].parentId).toBeDefined();
        expect(parseSchedule(f.tasks[0].schedule).state).toBe('ok');
        expect(f.tasks[0].dueAt).toBe('2026-10-05T09:00:00.000Z');
        expect(f.sleeps.every(ms => ms === PACE_MS)).toBe(true);
        expect(s).toMatchObject({ created: 2, skipped: 0, next: 2 });
    });

    it('skips UIDs the target already has, and duplicates inside the file', async () => {
        const f = fakeIO();
        const s = await runImport([item(1), item(2), item(2)], { listId: 7, title: 'x', existingCount: 3, existingUids: new Set(['uid-1']) }, f.io, { nowMs: NOW, signal: { cancelled: false } });
        expect(f.lists).toEqual([]);
        expect(f.tasks.map(t => t.text)).toEqual(['Event 2']);
        expect(f.tasks[0].listId).toBe(7);
        expect(s).toMatchObject({ created: 1, skipped: 2 });
    });

    it('moves on to "<title> (2)" before the per-list cap', async () => {
        const f = fakeIO();
        const items = Array.from({ length: 12 }, (_, i) => item(i));
        const s = await runImport(items, { listId: 7, title: 'Big', existingCount: MAX_PER_LIST - 5, existingUids: new Set() }, f.io, { nowMs: NOW, signal: { cancelled: false } });
        expect(f.lists).toEqual(['Big (2)']);
        expect(f.tasks.filter(t => t.listId === 7)).toHaveLength(5);
        expect(s.listIds).toHaveLength(2);
        expect(importSummary(s, 12)).toMatch(/split across 2 notes/);
    });

    it('a 429 backs off and retries the SAME item; a limiter that never clears stops with a resumable state', async () => {
        const f = fakeIO();
        const real = f.io.createTask;
        let fails = 1;
        f.io.createTask = vi.fn(async (...a: Parameters<ImportIO['createTask']>) => {
            if (fails-- > 0) throw new ApiError('Too many requests', 429);
            return real(...a);
        });
        const s = await runImport([item(1), item(2)], { listId: 7, title: 'x', existingCount: 0, existingUids: new Set() }, f.io, { nowMs: NOW, signal: { cancelled: false } });
        expect(s.created).toBe(2);
        expect(f.sleeps).toContain(2000);
        expect(f.tasks.map(t => t.text)).toEqual(['Event 1', 'Event 2']);

        const g = fakeIO();
        g.io.createTask = vi.fn(async () => { throw new ApiError('Too many requests', 429); });
        const stopped = await runImport([item(1), item(2)], { listId: 7, title: 'x', existingCount: 0, existingUids: new Set() }, g.io, { nowMs: NOW, signal: { cancelled: false } });
        expect(stopped.stoppedBy).toMatch(/Resume/);
        expect(stopped.next).toBe(0);
        // Resume later: picks up at item 0, nothing duplicated.
        const h = fakeIO();
        const resumed = await runImport([item(1), item(2)], { listId: 7, title: 'x', existingCount: 0, existingUids: new Set() }, h.io, { nowMs: NOW, signal: { cancelled: false }, resume: stopped });
        expect(h.tasks.map(t => t.text)).toEqual(['Event 1', 'Event 2']);
        expect(resumed.created).toBe(2);
    });

    it('cancel stops before the next item; the summary says how many were left', async () => {
        const f = fakeIO();
        const signal = { cancelled: false };
        f.io.sleep = vi.fn(async () => { signal.cancelled = true; });
        const s = await runImport([item(1), item(2), item(3)], { listId: 7, title: 'x', existingCount: 0, existingUids: new Set() }, f.io, { nowMs: NOW, signal });
        expect(s.created).toBe(1);
        expect(s.cancelled).toBe(true);
        expect(importSummary(s, 3)).toMatch(/2 not imported \(cancelled\)/);
    });

    it('a failing item is reported and the rest continue', async () => {
        const f = fakeIO();
        const real = f.io.createTask;
        f.io.createTask = vi.fn(async (listId, text, parentId, timing) => {
            if (text === 'Event 2') throw new ApiError('Task description too long', 413);
            return real(listId, text, parentId, timing);
        });
        const s = await runImport([item(1), item(2), item(3)], { listId: 7, title: 'x', existingCount: 0, existingUids: new Set() }, f.io, { nowMs: NOW, signal: { cancelled: false } });
        expect(s.created).toBe(2);
        expect(s.failed).toEqual([{ summary: 'Event 2', reason: 'Task description too long' }]);
    });
});

describe('Retry-After', () => {
    it('a 429 that says how long to wait is waited THAT long, not the backoff', async () => {
        const f = fakeIO();
        const real = f.io.createTask;
        let fails = 1;
        f.io.createTask = vi.fn(async (...a: Parameters<ImportIO['createTask']>) => {
            if (fails-- > 0) throw new ApiError('Too many requests', 429, 7000);
            return real(...a);
        });
        const s = await runImport([item(1)], { listId: 7, title: 'x', existingCount: 0, existingUids: new Set() }, f.io, { nowMs: NOW, signal: { cancelled: false } });
        expect(s.created).toBe(1);
        expect(f.sleeps).toContain(7000);
        expect(f.sleeps).not.toContain(2000);
    });

    it('an absurd Retry-After is capped; none falls back to the backoff (positive control)', async () => {
        const f = fakeIO();
        const real = f.io.createTask;
        const waits = [3_600_000, undefined];
        f.io.createTask = vi.fn(async (...a: Parameters<ImportIO['createTask']>) => {
            if (waits.length) throw new ApiError('Too many requests', 429, waits.shift());
            return real(...a);
        });
        await runImport([item(1)], { listId: 7, title: 'x', existingCount: 0, existingUids: new Set() }, f.io, { nowMs: NOW, signal: { cancelled: false } });
        expect(f.sleeps.slice(0, 2)).toEqual([MAX_RETRY_WAIT_MS, 4000]);
    });

    it('retryAfterMsOf reads Retry-After seconds, an HTTP-date, the limiter header and a body', () => {
        const now = Date.parse('2026-10-01T00:00:00Z');
        expect(retryAfterMsOf(new Headers({ 'retry-after': '7' }), '', now)).toBe(7000);
        expect(retryAfterMsOf(new Headers({ 'retry-after': 'Thu, 01 Oct 2026 00:00:12 GMT' }), '', now)).toBe(12_000);
        expect(retryAfterMsOf(new Headers({ 'x-ratelimit-after': '2' }), '', now)).toBe(2000);
        expect(retryAfterMsOf(new Headers(), '{"error":"rate_limited","retry_after_ms":1500}', now)).toBe(1500);
        expect(retryAfterMsOf(new Headers(), 'Too Many Requests', now)).toBeUndefined();
        expect(retryAfterMsOf(new Headers({ 'retry-after': 'soon' }), '', now)).toBeUndefined();
    });

    it('the API client carries a 429’s Retry-After on the ApiError it throws', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response('Too Many Requests', { status: 429, headers: { 'retry-after': '3' } }),
        );
        try {
            const err = await apiClient.get('/task-features').catch((e: unknown) => e);
            expect(err).toBeInstanceOf(ApiError);
            expect((err as ApiError).status).toBe(429);
            expect((err as ApiError).retryAfterMs).toBe(3000);
        } finally {
            fetchSpy.mockRestore();
        }
    });
});

describe('resuming never overruns a list or duplicates an item', () => {
    it('the cap is checked against REAL per-list task counts across a stop and a resume', async () => {
        // Every item brings a notes subtask: two tasks each. The old resume
        // re-derived the count as existing + items created and under-counted.
        const items = Array.from({ length: 10 }, (_, i) => item(i, { description: `notes ${i}` }));
        const target = { listId: 7, title: 'Cal', existingCount: MAX_PER_LIST - 9, existingUids: new Set<string>() };
        const f = fakeIO();
        const real = f.io.createTask;
        let calls = 0;
        f.io.createTask = vi.fn(async (...a: Parameters<ImportIO['createTask']>) => {
            if (++calls > 6) throw new ApiError('Too many requests', 429);   // stops after 3 whole items
            return real(...a);
        });
        const stopped = await runImport(items, target, f.io, { nowMs: NOW, signal: { cancelled: false } });
        expect(stopped.stoppedBy).toMatch(/Resume/);
        expect(stopped.listCounts).toEqual([MAX_PER_LIST - 3]);
        const g = fakeIO();
        const resumed = await runImport(items, target, g.io, { nowMs: NOW, signal: { cancelled: false }, resume: stopped });
        const inFirst = (MAX_PER_LIST - 9) + f.tasks.filter(t => t.listId === 7).length + g.tasks.filter(t => t.listId === 7).length;
        expect(inFirst).toBeLessThanOrEqual(MAX_PER_LIST);
        expect(resumed.listIds.length).toBe(2);
        expect(resumed.created).toBe(10);
        // Every item exactly once across both runs.
        const titles = [...f.tasks, ...g.tasks].map(t => t.text).filter(t => t.startsWith('Event'));
        expect(new Set(titles).size).toBe(10);
        expect(titles).toHaveLength(10);
    });

    it('a stop between an item and its notes subtask resumes with ONLY the subtask', async () => {
        const f = fakeIO();
        const real = f.io.createTask;
        f.io.createTask = vi.fn(async (listId, text, parentId, timing) => {
            if (parentId !== undefined) throw new ApiError('Too many requests', 429);
            return real(listId, text, parentId, timing);
        });
        const items = [item(1, { description: 'Bring cake' }), item(2)];
        const target = { listId: 7, title: 'x', existingCount: 0, existingUids: new Set<string>() };
        const stopped = await runImport(items, target, f.io, { nowMs: NOW, signal: { cancelled: false } });
        expect(stopped.next).toBe(0);
        expect(stopped.pendingDescription).toBeDefined();
        const parentId = stopped.pendingDescription!.parentId;
        expect(f.tasks.map(t => t.text)).toEqual(['Event 1']);
        // The dialog re-reads the note, so the target now holds uid-1.
        const g = fakeIO();
        const resumed = await runImport(items, { ...target, existingCount: 1, existingUids: new Set(['uid-1']) }, g.io, { nowMs: NOW, signal: { cancelled: false }, resume: stopped });
        expect(g.tasks.map(t => [t.text, t.parentId])).toEqual([['Bring cake', parentId], ['Event 2', undefined]]);
        expect(resumed).toMatchObject({ created: 2, skipped: 0, next: 2 });
        expect(resumed.pendingDescription).toBeUndefined();
        expect(resumed.listCounts).toEqual([3]);
    });
});

// The picker's targets, shared by both calendars (Púca Notes' /calendar and
// Púca's Calendar tab). Personal lists only is the whole point: an import
// into a shared checklist would notify every member for every item, so the
// builder is given lists and never channels, and a second run of the same
// file finds its UIDs already there.
describe('icsImportTargets', () => {
    const task = (id: number, schedule?: string): Task => ({
        id, channel_id: null, list_id: 1, parent_id: null, description: `t${id}`, is_completed: false, position: id,
        created_at: '2026-09-01T00:00:00Z', created_by: 1, attachments: null, due_at: null, schedule: schedule ?? null,
    });
    const sched = (uid: string) => serializeSchedule({
        v: 1, kind: 'event', uid, allDay: false, start: '2026-10-05T09:00', end: '2026-10-05T10:00', tz: 'UTC',
    });

    it('offers every personal list, with what it already holds', () => {
        const targets = icsImportTargets(
            [{ id: 1, title: 'Trips' }, { id: 2, title: 'Home' }],
            id => (id === 1 ? [task(10, sched('uid-a')), task(11)] : []),
        );
        expect(targets.map(t => [t.listId, t.title, t.count])).toEqual([[1, 'Trips', 2], [2, 'Home', 0]]);
        expect([...targets[0].uids]).toEqual(['uid-a']);
        // The item with no schedule contributes no UID — importing its event
        // again must not be skipped on the strength of a plain reminder.
        expect(targets[0].uids.size).toBe(1);
        expect([...targets[1].uids]).toEqual([]);
    });

    it('a list whose items have not been read yet is offered as empty, not skipped', () => {
        const targets = icsImportTargets([{ id: 3, title: 'New' }], () => undefined);
        expect(targets).toHaveLength(1);
        expect(targets[0].count).toBe(0);
    });
});
