/**
 * Púca Notes' list content (migration 065): the STRICT reader for a list's
 * sealed body and sidecar, capability detection against older servers, the
 * trash helpers, and the saved-order rule that keeps a trashed note's slot.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

const { get, post, patch, del } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn() }));
vi.mock('../api/client', async () => {
    const real = await vi.importActual<typeof import('../api/client')>('../api/client');
    return { ...real, apiClient: { get, post, patch, delete: del, put: vi.fn() } };
});

import { ApiError } from '../api/client';
import {
    NO_LIST_FEATURES, parseListFeatures, fetchListFeatures, listTrashedTaskLists, keepHiddenSlots,
    trashPurgeAt, listsDueForClientPurge, toggleFavoriteKeepingHidden, noteFileIds, deleteListForever, setTaskListBody,
    setTaskListAttachments, createTaskListWithContent, bodyBytes, MAX_BODY_BYTES,
} from '../api/listContent';
import { openSelfField, openListContent, sealSelfField } from '../api/listSeal';
import { buildPrefsForOrder, openSelfTaskText, toggleFavoritePrefs, type Task, type TaskTabPref } from '../api/tasks';
import { encryptSelf, serializeEnvelope, setActiveIdentity, isEncrypted } from '../api/e2ee';
import { DECRYPT_FAILURE_MARKERS, TASK_DECRYPT_FAILED } from '../api/decryptMarkers';
import { testIdentity, warmIdentities, WARM_TIMEOUT_MS } from './fixtures/identities';

const ME = ['list-content-pw', 'cd'.repeat(16)] as const;
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)); };

function task(id: number, o: Partial<Task> = {}): Task {
    return {
        id, channel_id: null, list_id: 1, parent_id: null, description: `t${id}`, is_completed: false,
        position: id, created_at: '2026-09-01', created_by: 1, attachments: null, due_at: null, ...o,
    };
}
const ref = (id: string, mime = 'image/png', name = `${id}.png`) => ({ href: `sovereign-enc:${id}?k=KEY&m=${encodeURIComponent(mime)}`, name });

beforeAll(async () => {
    await warmIdentities([ME]);
    setActiveIdentity(await testIdentity(...ME));
}, WARM_TIMEOUT_MS);
beforeEach(() => { get.mockReset(); post.mockReset(); patch.mockReset(); del.mockReset(); });

describe('the strict reader for fields that never held plaintext', () => {
    it('opens a sealed body', async () => {
        const stored = serializeEnvelope(await encryptSelf((await testIdentity(...ME)), 'Remember the milk'));
        expect(await openSelfField(stored)).toBe('Remember the milk');
    });

    it('refuses a plaintext body instead of showing it as the owner’s words', async () => {
        expect(await openSelfField('I was written by the server')).toBe(TASK_DECRYPT_FAILED);
        // POSITIVE CONTROL: the title reader, which predates encryption,
        // passes the same value through — so the strictness is this reader's.
        expect(await openSelfTaskText('I was written by the server')).toBe('I was written by the server');
    });

    it('refuses a channel envelope and an unknown version with a marker, never the JSON', async () => {
        expect(DECRYPT_FAILURE_MARKERS.has(await openSelfField('{"v":3,"t":"ch","epoch":1,"ct":"AAAA"}'))).toBe(true);
        expect(DECRYPT_FAILURE_MARKERS.has(await openSelfField('{"v":9,"t":"self","ct":"AAAA"}'))).toBe(true);
    });

    it('keeps absent fields absent (an older server) and opens present ones', async () => {
        expect(await openListContent({})).toEqual({});
        const sealed = await sealSelfField('text');
        expect(await openListContent({ body: sealed, attachments: null, trashed_at: null })).toEqual({ body: 'text', attachments: null, trashed_at: null });
    });

    it('refuses to seal a decrypt-failure marker back over its ciphertext', async () => {
        await expect(sealSelfField(TASK_DECRYPT_FAILED)).rejects.toThrow(/marker/);
    });
});

describe('writes carry envelopes, never the text', () => {
    it('a body save sends a sealed body and the reader version', async () => {
        patch.mockResolvedValue({});
        await setTaskListBody(5, 'secret plans');
        const [path, payload] = patch.mock.calls[0];
        expect(path).toBe('/task-lists/5');
        expect(isEncrypted(payload.body)).toBe(true);
        expect(JSON.stringify(payload)).not.toContain('secret plans');
        expect(payload.reads_up_to).toBeGreaterThanOrEqual(2);
        expect(await openSelfField(payload.body)).toBe('secret plans');
    });

    it('clearing sends "" (the server stores NULL), and an empty sidecar clears too', async () => {
        patch.mockResolvedValue({});
        await setTaskListBody(5, '');
        await setTaskListAttachments(5, []);
        expect(patch.mock.calls[0][1].body).toBe('');
        expect(patch.mock.calls[1][1].attachments).toBe('');
    });

    it('a photo note is created in ONE request with a sealed sidecar', async () => {
        post.mockImplementation(async (_p: string, body: Record<string, string>) => ({ id: 9, title: body.title, created_at: 'x', total_tasks: 0, completed_tasks: 0, body: body.body ?? null, attachments: body.attachments ?? null, trashed_at: null }));
        const created = await createTaskListWithContent('Holiday', { body: 'beach', refs: [ref('f1')] });
        expect(post).toHaveBeenCalledTimes(1);
        const sent = post.mock.calls[0][1];
        expect(isEncrypted(sent.title) && isEncrypted(sent.body) && isEncrypted(sent.attachments)).toBe(true);
        expect(JSON.stringify(sent)).not.toMatch(/Holiday|beach|f1/);
        expect(created.title).toBe('Holiday');
        expect(created.body).toBe('beach');
        expect(JSON.parse(created.attachments!)).toEqual([ref('f1')]);
    });
});

describe('capability detection does not depend on having lists', () => {
    it('a server older than 065 (404/405 on the route) supports none of it', async () => {
        get.mockRejectedValueOnce(new ApiError('Method Not Allowed', 405));
        expect(await fetchListFeatures()).toEqual(NO_LIST_FEATURES);
        get.mockRejectedValueOnce(new ApiError('Not Found', 404));
        expect(await fetchListFeatures()).toEqual(NO_LIST_FEATURES);
    });

    it('any other failure THROWS, so an offline moment is never read as "old server"', async () => {
        get.mockRejectedValueOnce(new TypeError('Failed to fetch'));
        await expect(fetchListFeatures()).rejects.toThrow();
        get.mockRejectedValueOnce(new ApiError('boom', 500));
        await expect(fetchListFeatures()).rejects.toThrow();
    });

    it('parses the answer field by field, never assuming support', async () => {
        get.mockResolvedValueOnce({ body: true, attachments: true, trash: true, trash_retention_days: 30, max_body_len: 65536 });
        expect(await fetchListFeatures()).toEqual({ body: true, attachments: true, trash: true, trashRetentionDays: 30, maxBodyLen: 65536 });
        expect(parseListFeatures('nonsense')).toEqual(NO_LIST_FEATURES);
        expect(parseListFeatures({ body: 'yes', trash: true, trash_retention_days: -3 })).toEqual({ ...NO_LIST_FEATURES, trash: true });
    });
});

describe('the trash listing', () => {
    it('drops rows without a trash time — an older server ignores ?trashed=true and answers with every live list', async () => {
        get.mockResolvedValueOnce([
            { id: 1, title: 'live', created_at: 'x', total_tasks: 0, completed_tasks: 0 },
            { id: 2, title: 'live too', created_at: 'x', total_tasks: 0, completed_tasks: 0, trashed_at: null },
        ]);
        expect(await listTrashedTaskLists()).toEqual([]);
        expect(get).toHaveBeenCalledWith('/task-lists?trashed=true');
    });

    it('keeps and opens the trashed ones', async () => {
        const sealed = await sealSelfField('trashed text');
        get.mockResolvedValueOnce([{ id: 3, title: 'Old', created_at: 'x', total_tasks: 1, completed_tasks: 0, body: sealed, attachments: null, trashed_at: '2026-09-01T00:00:00Z' }]);
        const [l] = await listTrashedTaskLists();
        expect(l.id).toBe(3);
        expect(l.body).toBe('trashed text');
    });

    it('knows when the server will purge, and purges its own a day early', () => {
        const day = 86_400_000;
        const t0 = Date.parse('2026-09-01T00:00:00Z');
        expect(trashPurgeAt('2026-09-01T00:00:00Z', 30)).toBe(t0 + 30 * day);
        expect(trashPurgeAt('2026-09-01T00:00:00Z', 0)).toBeNull();
        const lists = [{ id: 1, trashed_at: '2026-09-01T00:00:00Z' }, { id: 2, trashed_at: '2026-09-20T00:00:00Z' }];
        expect(listsDueForClientPurge(lists, 30, t0 + 29 * day + 1).map(l => l.id)).toEqual([1]);
        expect(listsDueForClientPurge(lists, 30, t0 + 28 * day).map(l => l.id)).toEqual([]);
        expect(listsDueForClientPurge(lists, 0, t0 + 1000 * day)).toEqual([]);
    });
});

describe('a trashed note keeps its slot in the saved order', () => {
    const prefs: TaskTabPref[] = [
        { kind: 'list', ref_id: 1, is_favorite: false },
        { kind: 'list', ref_id: 2, is_favorite: true },   // trashed
        { kind: 'list', ref_id: 3, is_favorite: false },
        { kind: 'channel', ref_id: 9, is_favorite: false },
    ];
    const hidden = new Set(['list:2']);

    it('a reorder while it is in the trash leaves it where it was, flags intact', () => {
        const visible = [{ kind: 'list' as const, id: 3 }, { kind: 'list' as const, id: 1 }, { kind: 'channel' as const, id: 9 }];
        const saved = buildPrefsForOrder(keepHiddenSlots(visible, prefs, hidden), prefs);
        expect(saved.map(p => `${p.kind}:${p.ref_id}`)).toEqual(['list:3', 'list:2', 'list:1', 'channel:9']);
        expect(saved.find(p => p.ref_id === 2)?.is_favorite).toBe(true);
        // POSITIVE CONTROL: without it the trashed note drifts to the tail.
        const plain = buildPrefsForOrder(visible, prefs);
        expect(plain.map(p => `${p.kind}:${p.ref_id}`)).toEqual(['list:3', 'list:1', 'channel:9', 'list:2']);
    });

    it('pinning pulls the note to the front of what is SHOWN, and the trashed one keeps its index', () => {
        const visible = [{ kind: 'list' as const, id: 1 }, { kind: 'list' as const, id: 3 }, { kind: 'channel' as const, id: 9 }];
        const saved = toggleFavoriteKeepingHidden(visible, prefs, { kind: 'channel', id: 9 }, hidden);
        expect(saved.map(p => `${p.kind}:${p.ref_id}`)).toEqual(['channel:9', 'list:2', 'list:1', 'list:3']);
        expect(saved.find(p => p.kind === 'channel')?.is_favorite).toBe(true);
        // POSITIVE CONTROL: the shared helper alone sends the trashed note to the tail.
        expect(toggleFavoritePrefs(visible, prefs, { kind: 'channel', id: 9 }).map(p => `${p.kind}:${p.ref_id}`))
            .toEqual(['channel:9', 'list:1', 'list:3', 'list:2']);
        // Unpinning changes the flag and nothing else.
        const unpinned = toggleFavoriteKeepingHidden(visible, saved, { kind: 'channel', id: 9 }, hidden);
        expect(unpinned.find(p => p.kind === 'channel')?.is_favorite).toBe(false);
    });

    it('clamps to the end when the order shrank, and ignores keys that were never saved', () => {
        const out = keepHiddenSlots([{ kind: 'list', id: 1 }], prefs, new Set(['list:3', 'list:77']));
        expect(out).toEqual([{ kind: 'list', id: 1 }, { kind: 'list', id: 3 }]);
    });
});

describe('Delete forever takes the note’s files with it', () => {
    it('names every readable file, its own and its items’, but nothing behind a locked sidecar', () => {
        const own = JSON.stringify([ref('a'), ref('b', 'application/x-puca-drawing', 'b.json')]);
        const items = [task(1, { attachments: JSON.stringify([ref('c', 'video/mp4', 'c.mp4')]) }), task(2, { attachments: TASK_DECRYPT_FAILED })];
        expect(noteFileIds(own, items).sort()).toEqual(['a', 'b', 'c']);
        expect(noteFileIds(TASK_DECRYPT_FAILED, [])).toEqual([]);
    });

    it('deletes the files FIRST, then the list', async () => {
        const order: string[] = [];
        get.mockResolvedValueOnce([task(1, { attachments: null })]);
        del.mockImplementation(async (path: string) => { order.push(path); return {}; });
        await deleteListForever({ id: 4, attachments: JSON.stringify([ref('p1'), ref('p2')]) });
        await settle();
        expect(order).toEqual(['/files/p1', '/files/p2', '/task-lists/4']);
    });

    it('a file that will not delete does not stop the note going (best effort)', async () => {
        get.mockResolvedValueOnce([]);
        del.mockImplementation(async (path: string) => { if (path.startsWith('/files/')) throw new ApiError('nope', 404); return {}; });
        await deleteListForever({ id: 4, attachments: JSON.stringify([ref('p1')]) });
        expect(del).toHaveBeenLastCalledWith('/task-lists/4');
    });
});

describe('the note text limit', () => {
    it('counts bytes, not characters', () => {
        expect(bodyBytes('abc')).toBe(3);
        expect(bodyBytes('é')).toBe(2);
        expect(MAX_BODY_BYTES).toBeLessThan(65536 * 3 / 4);
    });
});
