// The paced .ics import: dedupe by UID, split before the per-list cap, back
// off on 429 and resume exactly where it stopped, cancel cleanly.
import { describe, expect, it, vi } from 'vitest';
import { MAX_PER_LIST, PACE_MS, importSummary, runImport, type ImportIO } from '../api/icsImport';
import { type IcsImportItem } from '../api/ics';
import { ApiError } from '../api/client';
import { parseSchedule } from '../api/taskSchedule';

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
