/**
 * The data export opens a task's sealed schedule and snooze (migration 066)
 * the way it opens attachments — with the right AAD kind per scope — and,
 * because those columns never held plaintext, reports a non-envelope value as
 * unreadable instead of exporting it as the user's text.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../api/auth', () => ({ requestAccountExport: vi.fn() }));
vi.mock('../api/servers', () => ({ decryptChannelContent: vi.fn() }));
vi.mock('../api/dms', () => ({ decryptDMContent: vi.fn() }));
vi.mock('../api/tasks', () => ({ openChannelTaskText: vi.fn(), openSelfTaskText: vi.fn() }));
vi.mock('../api/saveAttachment', () => ({ saveAttachment: vi.fn() }));
vi.mock('../api/platform', () => ({ isMobile: () => false, isTauri: () => false }));

import { openExport, type AccountExportRaw, type ExportReaders } from '../api/accountExport';

const CH = (ct: string) => JSON.stringify({ v: 3, t: 'ch', epoch: 2, ct });
const SELF = (ct: string) => JSON.stringify({ v: 2, t: 'self', ct });

const readers: ExportReaders = {
    channelMessage: async () => 'x',
    dmMessage: async () => 'x',
    channelTask: async (channelId, stored, kind, owner) => `${kind}:${channelId}:${owner}:${JSON.parse(stored).ct}`,
    selfText: async stored => `self:${JSON.parse(stored).ct}`,
};

const base = (tasks: AccountExportRaw['tasks']): AccountExportRaw => ({
    format: 'puca-account-export/1', user_id: 7, channel_messages: [], dm_messages: [], task_lists: [], tasks,
});

describe('openExport — task timing', () => {
    it('opens schedule and snooze with their own AAD kinds (channel) and to self (list)', async () => {
        const { doc, stats } = await openExport(base([
            { id: 1, channel_id: 10, list_id: null, description: CH('d'), attachments: null, created_by: 7, schedule: CH('ev'), snooze: CH('sn') },
            { id: 2, channel_id: null, list_id: 5, description: SELF('d2'), attachments: null, created_by: 7, schedule: SELF('ev2'), snooze: null },
        ]), readers);
        const tasks = doc.tasks as Array<Record<string, { text: string | null; content_ciphertext: string } | null>>;
        expect(tasks[0].schedule?.text).toBe('chan-taskevt:10:7:ev');
        expect(tasks[0].snooze?.text).toBe('chan-tasksnz:10:7:sn');
        expect(tasks[0].schedule?.content_ciphertext).toBe(CH('ev'));
        expect(tasks[1].schedule?.text).toBe('self:ev2');
        expect(tasks[1].snooze).toBeNull();
        // 2 descriptions + 2 schedules + 1 snooze.
        expect(stats).toEqual({ sealed: 5, opened: 5, unreadable: 0 });
    });

    it('a plaintext timing value is reported unreadable, never exported as text', async () => {
        const plain = JSON.stringify({ v: 1, kind: 'event', uid: 'u', allDay: true, start: '2030-01-01' });
        const { doc, stats } = await openExport(base([
            { id: 3, channel_id: null, list_id: 5, description: 'old plaintext description', attachments: null, created_by: 7, schedule: plain },
        ]), readers);
        const t = (doc.tasks as Array<Record<string, { text: string | null; unreadable: string | null } | null>>)[0];
        expect(t.schedule?.text).toBeNull();
        expect(t.schedule?.unreadable).toMatch(/Not sealed/);
        // Positive control in the same row: a legacy plaintext DESCRIPTION still passes through.
        expect(t.description?.text).toBe('old plaintext description');
        expect(stats).toEqual({ sealed: 1, opened: 0, unreadable: 1 });
    });

    it('an older server (no timing keys) exports exactly as before', async () => {
        const { doc } = await openExport(base([
            { id: 4, channel_id: null, list_id: 5, description: SELF('d'), attachments: null, created_by: 7 },
        ]), readers);
        const t = (doc.tasks as Array<Record<string, unknown>>)[0];
        expect('schedule' in t).toBe(false);
        expect('snooze' in t).toBe(false);
    });
});
