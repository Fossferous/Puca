// Removing the date & repeat from an item that keeps its time PRIVATE must
// not publish that time as a plaintext due_at without the user's yes. The
// pure rule (scheduleForm.dueAtAfterRemoving) and the editor's Remove button,
// mounted with react-dom/client + act (the repo's component-test pattern).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ScheduleEditor } from '../components/schedule/ScheduleEditor';
import { dueAtAfterRemoving, removingRevealsPrivateTime } from '../api/scheduleForm';
import { parseSchedule, serializeSchedule, type EventSchedule } from '../api/taskSchedule';
import type { Task } from '../api/tasks';

const base: EventSchedule = { v: 1, kind: 'event', uid: 'uid-priv-0001', allDay: false, start: '2030-10-05T15:00', end: '2030-10-05T16:00', tz: 'UTC', rrule: 'FREQ=WEEKLY', alerts: [10] };
const PRIVATE = serializeSchedule({ ...base, privateTiming: true });
const PUBLIC = serializeSchedule(base);
const NOW = Date.parse('2030-10-01T00:00:00Z');
const NEXT = '2030-10-05T15:00:00.000Z';

describe('dueAtAfterRemoving', () => {
    it('a private schedule removed WITHOUT a yes leaves due_at null', () => {
        const p = parseSchedule(PRIVATE);
        expect(removingRevealsPrivateTime(p)).toBe(true);
        expect(dueAtAfterRemoving(p, null, NOW, false)).toBeNull();
    });
    it('with the yes it keeps a reminder at the next occurrence', () => {
        expect(dueAtAfterRemoving(parseSchedule(PRIVATE), null, NOW, true)).toBe(NEXT);
    });
    it('positive control: a public schedule keeps its next occurrence as before, and does not ask', () => {
        const p = parseSchedule(PUBLIC);
        expect(removingRevealsPrivateTime(p)).toBe(false);
        expect(dueAtAfterRemoving(p, '2030-10-05T14:50:00.000Z', NOW, true)).toBe(NEXT);
    });
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
    vi.restoreAllMocks();
});

function mount(schedule: string) {
    const task: Task = {
        id: 1, channel_id: null, list_id: 1, parent_id: null, description: 'Secret meeting', is_completed: false, position: 1,
        created_at: '2030-09-01T00:00:00Z', created_by: 1, attachments: null, due_at: null, schedule,
    };
    const onSave = vi.fn();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<ScheduleEditor task={task} onSave={onSave} onClose={() => {}} now={NOW} />));
    const remove = [...document.body.querySelectorAll('button')].find(b => b.textContent === 'Remove');
    return { onSave, remove };
}

describe('ScheduleEditor → Remove', () => {
    it('on a private item it ASKS, and Cancel saves due_at null', () => {
        vi.spyOn(Date, 'now').mockReturnValue(NOW);
        const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
        const { onSave, remove } = mount(PRIVATE);
        expect(remove).toBeTruthy();
        act(() => remove!.click());
        expect(confirm).toHaveBeenCalledTimes(1);
        expect(onSave).toHaveBeenCalledWith(null, null);
    });
    it('OK keeps a reminder (the user chose to reveal it)', () => {
        vi.spyOn(Date, 'now').mockReturnValue(NOW);
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        const { onSave, remove } = mount(PRIVATE);
        act(() => remove!.click());
        expect(onSave).toHaveBeenCalledWith(null, NEXT);
    });
    it('positive control: a public item does not ask and keeps its next time', () => {
        vi.spyOn(Date, 'now').mockReturnValue(NOW);
        const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
        const { onSave, remove } = mount(PUBLIC);
        act(() => remove!.click());
        expect(confirm).not.toHaveBeenCalled();
        expect(onSave).toHaveBeenCalledWith(null, NEXT);
    });
});
