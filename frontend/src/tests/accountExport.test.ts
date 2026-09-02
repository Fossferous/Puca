/**
 * The data export's assembly: every sealed body the device can open appears
 * as plaintext, every one it cannot is reported — never dropped — and the
 * ciphertext as stored survives in both cases.
 *
 * The readers are injected (the real ones need keys and a server); what is
 * under test is the assembly, the counting and the file naming. The
 * positive control is the mixed fixture itself: one unreadable row among
 * readable ones, so an assembly that silently skipped failures — or one
 * that called everything "opened" — could not pass.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../api/auth', () => ({ requestAccountExport: vi.fn() }));
vi.mock('../api/servers', () => ({ decryptChannelContent: vi.fn() }));
vi.mock('../api/dms', () => ({ decryptDMContent: vi.fn() }));
vi.mock('../api/tasks', () => ({ openChannelTaskText: vi.fn(), openSelfTaskText: vi.fn() }));
vi.mock('../api/saveAttachment', () => ({ saveAttachment: vi.fn() }));
vi.mock('../api/platform', () => ({ isMobile: () => false, isTauri: () => false }));

import { openExport, exportFileName, envelopeMeta, type AccountExportRaw, type ExportReaders } from '../api/accountExport';
import { ENC_KEY_UNAVAILABLE, ENC_CONTEXT_MISMATCH } from '../api/decryptMarkers';

const CH = (ct: string, epoch = 3) => JSON.stringify({ v: 3, t: 'ch', epoch, ct });
const DM = (ct: string) => JSON.stringify({ v: 3, t: 'dm', ct });
const SELF = (ct: string) => JSON.stringify({ v: 2, t: 'self', ct });

const raw: AccountExportRaw = {
    format: 'puca-account-export/1',
    user_id: 7,
    profile: { username: 'alice' },
    channel_messages: [
        { id: 'm1', channel_id: 10, content: CH('c1') },
        { id: 'm2', channel_id: 10, content: CH('c2', 4) },
        { id: 'm3', channel_id: 11, content: CH('no-key', 9) },
        { id: 'm4', channel_id: 10, content: 'hello from before encryption' },
    ],
    dm_messages: [
        { id: 'd1', partner_user_id: 8, content: DM('dm1') },
    ],
    tasks: [
        { id: 1, channel_id: 10, list_id: null, description: CH('task'), attachments: null, created_by: 7 },
        { id: 2, channel_id: null, list_id: 5, description: SELF('mine'), attachments: SELF('att'), created_by: 7 },
    ],
    task_lists: [{ id: 5, title: SELF('title') }],
};

/** Readers keyed on the fixture's ciphertexts; anything unknown "fails". */
const readers: ExportReaders = {
    channelMessage: async (channelId, content, senderId) => {
        expect(senderId, 'own messages are opened as their author').toBe(7);
        const { ct, epoch } = JSON.parse(content);
        if (ct === 'no-key') return ENC_KEY_UNAVAILABLE;
        return `plain:${channelId}:${epoch}:${ct}`;
    },
    dmMessage: async (content, partner, sender) => `dm:${partner}:${sender}:${JSON.parse(content).ct}`,
    channelTask: async (channelId, stored, kind, owner) => `${kind}:${channelId}:${owner}:${JSON.parse(stored).ct}`,
    selfText: async (stored) => `self:${JSON.parse(stored).ct}`,
};

describe('openExport', () => {
    it('opens what it can, reports what it cannot, and keeps every ciphertext', async () => {
        const { doc, stats } = await openExport(raw, readers);
        const msgs = doc.channel_messages as Array<Record<string, unknown>>;

        expect(msgs.map(m => m.text)).toEqual([
            'plain:10:3:c1',
            'plain:10:4:c2',
            null,                              // unreadable, present, not dropped
            'hello from before encryption',    // legacy plaintext passes through
        ]);
        expect(msgs[2].unreadable).toBe(ENC_KEY_UNAVAILABLE);
        expect(msgs[2].envelope).toEqual({ version: 3, type: 'ch', epoch: 9 });
        // The stored bytes are never lost — including for the row that opened.
        expect(msgs[0].content_ciphertext).toBe(CH('c1'));
        expect(msgs[2].content_ciphertext).toBe(CH('no-key', 9));
        expect(msgs[3].envelope).toBeNull();
        // The raw `content` field is replaced, not duplicated under a second name.
        expect('content' in msgs[0]).toBe(false);

        const dms = doc.dm_messages as Array<Record<string, unknown>>;
        expect(dms[0].text).toBe('dm:8:7:dm1');

        const tasks = doc.tasks as Array<Record<string, { text: string | null }>>;
        expect(tasks[0].description.text).toBe('chan-task:10:7:task');
        expect(tasks[1].description.text).toBe('self:mine');
        expect(tasks[1].attachments.text).toBe('self:att');
        const lists = doc.task_lists as Array<Record<string, { text: string | null }>>;
        expect(lists[0].title.text).toBe('self:title');

        // 3 channel + 1 dm + 2 task descriptions + 1 attachment + 1 title = 8 sealed; one unreadable.
        expect(stats).toEqual({ sealed: 8, opened: 7, unreadable: 1 });
        const opened = doc.opened_on as Record<string, unknown>;
        expect(opened.unreadable).toBe(1);
        // Untouched sections ride through.
        expect(doc.profile).toEqual({ username: 'alice' });
        expect(doc.format).toBe('puca-account-export/1');
    });

    it('a reader that THROWS is reported on the row, not fatal to the export', async () => {
        const { doc, stats } = await openExport(
            { ...raw, dm_messages: [], tasks: [], task_lists: [], channel_messages: [{ id: 'x', channel_id: 1, content: CH('boom') }] },
            { ...readers, channelMessage: async () => { throw new Error('identity locked'); } },
        );
        const [row] = doc.channel_messages as Array<Record<string, unknown>>;
        expect(row.text).toBeNull();
        expect(String(row.unreadable)).toContain('identity locked');
        expect(stats).toEqual({ sealed: 1, opened: 0, unreadable: 1 });
    });

    it('a channel whose reader throws is asked ONCE, not once per row (each ask is a key fetch)', async () => {
        let calls = 0;
        const { doc, stats } = await openExport(
            { ...raw, dm_messages: [], task_lists: [],
              channel_messages: [
                  { id: 'a', channel_id: 11, content: CH('x') },
                  { id: 'b', channel_id: 11, content: CH('y') },
                  { id: 'c', channel_id: 10, content: CH('z') },
              ],
              tasks: [{ id: 9, channel_id: 11, list_id: null, description: CH('t'), attachments: null, created_by: 7 }] },
            {
                ...readers,
                channelMessage: async (channelId, content) => {
                    if (channelId === 11) { calls++; throw new Error('not a member of that channel'); }
                    return `ok:${JSON.parse(content).ct}`;
                },
                channelTask: async () => { calls++; throw new Error('not a member of that channel'); },
            },
        );
        expect(calls, 'the dead channel is asked once, across messages AND tasks').toBe(1);
        const rows = doc.channel_messages as Array<Record<string, unknown>>;
        expect(rows.map(r => r.text)).toEqual([null, null, 'ok:z']);
        expect(String(rows[1].unreadable)).toContain('not a member');
        const [task] = doc.tasks as Array<Record<string, { unreadable: string | null }>>;
        expect(String(task.description.unreadable)).toContain('not a member');
        expect(stats).toEqual({ sealed: 4, opened: 1, unreadable: 3 });
    });

    it('a context mismatch marker counts as unreadable too (the marker set is the contract)', async () => {
        const { stats } = await openExport(
            { ...raw, dm_messages: [], tasks: [], task_lists: [], channel_messages: [{ id: 'x', channel_id: 1, content: CH('moved') }] },
            { ...readers, channelMessage: async () => ENC_CONTEXT_MISMATCH },
        );
        expect(stats.unreadable).toBe(1);
    });

    it('reports progress in batches and at the end', async () => {
        const many: AccountExportRaw = {
            ...raw, dm_messages: [], tasks: [], task_lists: [],
            channel_messages: Array.from({ length: 120 }, (_, i) => ({ id: `m${i}`, channel_id: 10, content: CH(`c${i}`) })),
        };
        const seen: number[] = [];
        await openExport(many, readers, (done) => seen.push(done));
        expect(seen).toEqual([50, 100, 120]);
    });
});

describe('envelopeMeta', () => {
    it('describes a sealed body without opening it, and null for plaintext', () => {
        expect(envelopeMeta(CH('x', 12))).toEqual({ version: 3, type: 'ch', epoch: 12 });
        expect(envelopeMeta(DM('x'))).toEqual({ version: 3, type: 'dm', epoch: null });
        expect(envelopeMeta('just words')).toBeNull();
        expect(envelopeMeta(JSON.stringify({ v: 99, t: 'ch', ct: 'x' }))).toEqual({ version: 99, type: 'unknown', epoch: null });
    });
});

describe('exportFileName', () => {
    it('names the file after the user and the day, safely', () => {
        expect(exportFileName('alice', new Date('2026-09-02T23:59:00Z'))).toBe('puca-export-alice-2026-09-02.json');
        expect(exportFileName('../evil name/', new Date('2026-09-02T00:00:00Z'))).toBe('puca-export-.._evil_name_-2026-09-02.json');
        expect(exportFileName('', new Date('2026-09-02T00:00:00Z'))).toBe('puca-export-account-2026-09-02.json');
    });
});
