/**
 * The reminder loop's two modes. Púca (and Notes in a browser) keeps today's
 * behaviour: a newly due item fires a notification. Púca Notes' Android app
 * runs the SAME loop with `notify: false` and hands every fetch to its native
 * alarms instead — so the loop itself must post nothing (or every due item
 * would notify twice: once from the WebView, once from the alarm).
 *
 * The default-options case is the positive control for the must-not case.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

const listTaskReminders = vi.fn();
const notifyTasksDue = vi.fn();
vi.mock('../api/tasks', () => ({ listTaskReminders: () => listTaskReminders() }));
vi.mock('../api/desktopNotify', () => ({ notifyTasksDue: (n: number) => notifyTasksDue(n) }));

const { reminderEntries, startTaskReminders } = await import('../api/taskReminders');

const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0));
};

const PAST = '2020-01-01T10:00:00Z';
const FUTURE = '2999-01-01T10:00:00Z';

beforeEach(() => {
    listTaskReminders.mockReset();
    notifyTasksDue.mockReset();
    (localStorage.setItem as unknown as Mock).mockClear();
    (localStorage.getItem as unknown as Mock).mockReturnValue(null);
});

const FIRED_KEY = 'sovereignTaskRemindersFired';
const firedWrites = () => (localStorage.setItem as unknown as Mock).mock.calls.filter(c => c[0] === FIRED_KEY);

let stop: (() => void) | null = null;
afterEach(() => { stop?.(); stop = null; });

describe('reminderEntries', () => {
    it('maps the feed to {id, at, mark, due}', () => {
        expect(reminderEntries([
            { id: 5, channel_id: null, list_id: 2, due_at: PAST },
        ])).toEqual([{ id: 5, at: Date.parse(PAST), mark: PAST, due: PAST }]);
    });
    it('drops a row whose time cannot be read', () => {
        expect(reminderEntries([
            { id: 1, channel_id: null, list_id: 2, due_at: 'never' },
            { id: 2, channel_id: null, list_id: 2, due_at: FUTURE },
        ]).map(e => e.id)).toEqual([2]);
    });
});

describe('startTaskReminders', () => {
    it('default: a past-due item notifies (positive control)', async () => {
        listTaskReminders.mockResolvedValue([{ id: 1, channel_id: null, list_id: 2, due_at: PAST }]);
        stop = startTaskReminders();
        await settle();
        expect(notifyTasksDue).toHaveBeenCalledWith(1);
        expect(firedWrites().some(c => String(c[1]).includes(PAST))).toBe(true);
    });

    it('notify:false never notifies, and hands the feed to onFeed', async () => {
        listTaskReminders.mockResolvedValue([
            { id: 1, channel_id: null, list_id: 2, due_at: PAST },
            { id: 2, channel_id: null, list_id: 2, due_at: FUTURE },
        ]);
        const onFeed = vi.fn();
        stop = startTaskReminders({ notify: false, onFeed });
        await settle();
        expect(notifyTasksDue).not.toHaveBeenCalled();
        expect(onFeed).toHaveBeenCalledTimes(1);
        expect(onFeed.mock.calls[0][0].map((e: { id: number }) => e.id)).toEqual([1, 2]);
        // No fired markers either: this loop fired nothing.
        expect(firedWrites()).toEqual([]);
    });

    it('a throwing onFeed does not kill the loop', async () => {
        listTaskReminders.mockResolvedValue([{ id: 1, channel_id: null, list_id: 2, due_at: PAST }]);
        stop = startTaskReminders({ onFeed: () => { throw new Error('bad consumer'); } });
        await settle();
        expect(notifyTasksDue).toHaveBeenCalledWith(1);
    });

    it('a failed fetch calls nothing', async () => {
        listTaskReminders.mockRejectedValue(new Error('offline'));
        const onFeed = vi.fn();
        stop = startTaskReminders({ notify: false, onFeed });
        await settle();
        expect(onFeed).not.toHaveBeenCalled();
    });
});
