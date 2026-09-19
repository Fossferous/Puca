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
const decryptChannelMessage = vi.fn(async () => 'OPENED-CH');
vi.mock('../api/e2ee', async importOriginal => ({
    ...(await importOriginal<typeof import('../api/e2ee')>()),
    getActiveIdentity: () => ({ publicKey: new Uint8Array(32), privateKey: new Uint8Array(32) }),
    decryptSelf: (...a: unknown[]) => decryptSelf(...(a as [])),
    decryptChannelMessage: (...a: unknown[]) => decryptChannelMessage(...(a as [])),
}));
vi.mock('../api/channelKeys', async importOriginal => ({
    ...(await importOriginal<typeof import('../api/channelKeys')>()),
    getChannelKeyForEpoch: async () => new Uint8Array(32),
}));

import { openTaskTiming } from '../api/tasks';
import { isUndecryptable } from '../api/decryptMarkers';
import { parseSchedule, parseSnooze } from '../api/taskSchedule';

const PLAIN_SCHEDULE = JSON.stringify({ v: 1, kind: 'event', uid: 'x', allDay: true, start: '2030-01-01' });
const PLAIN_SNOOZE = JSON.stringify({ k: 'snooze/1', forDue: '2030-01-01T09:00:00Z', until: '2030-01-01T10:00:00Z' });
const SEALED = '{"v":2,"t":"self","ct":"AAAA"}';

beforeEach(() => { decryptSelf.mockClear(); decryptChannelMessage.mockClear(); });

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

describe('a CHANNEL task’s timing opens only from a v3 (bound) envelope', () => {
    const V2 = '{"v":2,"t":"ch","epoch":1,"ct":"AAAA"}';
    const V3 = '{"v":3,"t":"ch","epoch":1,"ct":"AAAA"}';

    it('a v2 channel envelope in schedule or snooze opens to a failure marker, never through the unbound path', async () => {
        const out = await openTaskTiming({ channel_id: 7, created_by: 1, schedule: V2, snooze: V2 });
        expect(isUndecryptable(out.schedule ?? '')).toBe(true);
        expect(isUndecryptable(out.snooze ?? '')).toBe(true);
        expect(parseSchedule(out.schedule).state).toBe('readonly');
        expect(parseSnooze(out.snooze)).toBeNull();
        expect(decryptChannelMessage).not.toHaveBeenCalled();
    });

    it('positive control: the same shape at v3 IS opened, with the timing kinds as its AAD', async () => {
        const out = await openTaskTiming({ channel_id: 7, created_by: 1, schedule: V3, snooze: V3 });
        expect(out).toEqual({ schedule: 'OPENED-CH', snooze: 'OPENED-CH' });
        const kinds = decryptChannelMessage.mock.calls.map(c => (c as unknown[])[2]).map(ctx => (ctx as { kind: string }).kind);
        expect(kinds.sort()).toEqual(['chan-taskevt', 'chan-tasksnz']);
    });

    it('a personal item keeps its self envelope (self binds nothing either way)', async () => {
        const out = await openTaskTiming({ channel_id: null, created_by: 1, schedule: '{"v":2,"t":"self","ct":"AAAA"}' });
        expect(out.schedule).toBe('OPENED');
    });
});
