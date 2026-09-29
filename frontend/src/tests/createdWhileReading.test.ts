/**
 * createdWhileReading (components/createdWhileReading.ts): what a read's
 * answer gets back — the rows this view created while THAT read was out, and
 * nothing else. The views' tests (tasksViewPasteChecklist, checklistBodyPaste)
 * show the rows staying on screen; these pin the rules they rest on, some of
 * which no view test can reach: a row that answered BEFORE the read left and
 * is missing from it was deleted elsewhere, and must stay gone.
 */
import { describe, it, expect } from 'vitest';
import type { Task } from '../api/tasks';
import { createdWhileReading } from '../components/createdWhileReading';

const task = (id: number) => ({ id, description: `t${id}` }) as Task;
const ids = (tasks: Task[]) => tasks.map(t => t.id);

describe('createdWhileReading', () => {
    it('gives a read back what landed while it was out and it lacks, in the order it landed', () => {
        const w = createdWhileReading();
        const read = w.reading('list:1');
        w.created('list:1', task(3));
        w.created('list:1', task(4));
        expect(ids(read.merge([task(1), task(2)]))).toEqual([1, 2, 3, 4]);
    });

    it('never twice: a row the answer already holds is not added again', () => {
        const w = createdWhileReading();
        const read = w.reading('list:1');
        w.created('list:1', task(3));
        expect(ids(read.merge([task(1), task(3)]))).toEqual([1, 3]);
    });

    it("only that list's rows", () => {
        const w = createdWhileReading();
        const read = w.reading('list:1');
        w.created('list:2', task(7));
        w.created('channel:1', task(8));
        expect(ids(read.merge([task(1)]))).toEqual([1]);
    });

    it('not a row that landed before the read left: missing from the answer, it was deleted elsewhere', () => {
        const w = createdWhileReading();
        const earlier = w.reading('list:1');          // keeps what lands from here on
        w.created('list:1', task(5));
        const later = w.reading('list:1');
        expect(ids(later.merge([task(1)]))).toEqual([1]);
        // POSITIVE CONTROL: the read that was out when it landed does get it.
        expect(ids(earlier.merge([task(1)]))).toEqual([1, 5]);
    });

    it('not a row deleted here since', () => {
        const w = createdWhileReading();
        const read = w.reading('list:1');
        w.created('list:1', task(3));
        w.created('list:1', task(4));
        w.forget(new Set([3]));
        expect(ids(read.merge([]))).toEqual([4]);
    });

    it('one read over is one read over, however often it says so: a read still out keeps what lands', () => {
        const w = createdWhileReading();
        const a = w.reading('list:1');
        const b = w.reading('list:1');
        a.done();
        a.done();
        w.created('list:1', task(9));
        expect(ids(b.merge([]))).toEqual([9]);
    });
});
