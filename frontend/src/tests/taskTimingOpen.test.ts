/**
 * The read path for the sealed timing columns (tasks.ts openTaskTiming).
 * `schedule` and `snooze` never had a plaintext era, so a non-envelope value
 * from the server must NOT pass through as "legacy plaintext" the way an old
 * description does: a compromised server could otherwise inject a fake event
 * (a time, a place) that validates and renders. It must open to a failure
 * marker, which parseSchedule reads as read-only and parseSnooze as none.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const decryptSelf = vi.fn(async () => 'OPENED');
vi.mock('../api/e2ee', async importOriginal => ({
    ...(await importOriginal<typeof import('../api/e2ee')>()),
    getActiveIdentity: () => ({ publicKey: new Uint8Array(32), privateKey: new Uint8Array(32) }),
    decryptSelf: (...a: unknown[]) => decryptSelf(...(a as [])),
}));

import { openTaskTiming } from '../api/tasks';
import { isUndecryptable } from '../api/decryptMarkers';
import { parseSchedule, parseSnooze } from '../api/taskSchedule';

const PLAIN_SCHEDULE = JSON.stringify({ v: 1, kind: 'event', uid: 'x', allDay: true, start: '2030-01-01' });
const PLAIN_SNOOZE = JSON.stringify({ k: 'snooze/1', forDue: '2030-01-01T09:00:00Z', until: '2030-01-01T10:00:00Z' });
const SEALED = '{"v":2,"t":"self","ct":"AAAA"}';

beforeEach(() => decryptSelf.mockClear());

describe('openTaskTiming refuses plaintext in the sealed timing columns', () => {
    it('a plaintext schedule from the server opens to a failure marker, and reads as read-only', async () => {
        const out = await openTaskTiming({ channel_id: null, created_by: 1, schedule: PLAIN_SCHEDULE });
        expect(isUndecryptable(out.schedule ?? '')).toBe(true);
        expect(parseSchedule(out.schedule).state).toBe('readonly');
        expect(decryptSelf).not.toHaveBeenCalled();
    });

    it('a plaintext snooze opens to a failure marker, which is "no snooze"', async () => {
        const out = await openTaskTiming({ channel_id: null, created_by: 1, snooze: PLAIN_SNOOZE });
        expect(isUndecryptable(out.snooze ?? '')).toBe(true);
        expect(parseSnooze(out.snooze)).toBeNull();
    });

    it('the same plaintext in a CHANNEL task is refused before any key is fetched', async () => {
        const out = await openTaskTiming({ channel_id: 7, created_by: 1, schedule: PLAIN_SCHEDULE });
        expect(isUndecryptable(out.schedule ?? '')).toBe(true);
    });

    it('positive control: a self envelope IS opened', async () => {
        const out = await openTaskTiming({ channel_id: null, created_by: 1, schedule: SEALED, snooze: SEALED });
        expect(out).toEqual({ schedule: 'OPENED', snooze: 'OPENED' });
        expect(decryptSelf).toHaveBeenCalledTimes(2);
    });

    it('keys the server did not send stay absent; null stays null', async () => {
        expect(await openTaskTiming({ channel_id: null, created_by: 1 })).toEqual({});
        expect(await openTaskTiming({ channel_id: null, created_by: 1, schedule: null, snooze: null })).toEqual({ schedule: null, snooze: null });
    });
});
