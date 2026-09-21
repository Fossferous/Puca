/**
 * Create keys and the content-revision compare-and-swap, at the wire.
 *
 * Two rules are pinned here because nothing else can pin them:
 *  - a create key is RANDOM. Two notes with the SAME title get DIFFERENT
 *    keys, so the key can never work as a fingerprint of what was written.
 *    The server's shape check cannot tell a random id from a digest, which
 *    is exactly why this test exists (api/opKey.ts says so too).
 *  - `expect_rev` is sent only when the caller names a base, and is ABSENT
 *    otherwise — an absent field means "no check" to the server, which is
 *    what keeps an older client and an older server working.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

const { get, post, patch, del } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn() }));
vi.mock('../api/client', async () => {
    const real = await vi.importActual<typeof import('../api/client')>('../api/client');
    return { ...real, apiClient: { get, post, patch, delete: del, put: vi.fn() } };
});

import { ApiError } from '../api/client';
import { newOpKey, OP_KEY_SHAPE } from '../api/opKey';
import { NoteConflictError, setTaskListBody, setTaskListAttachments, createTaskListWithContent } from '../api/listContent';
import { createTaskList, createListTask, renameTaskList } from '../api/tasks';
import { sealSelfField, openSelfField } from '../api/listSeal';
import { setActiveIdentity } from '../api/e2ee';
import { testIdentity, warmIdentities, WARM_TIMEOUT_MS } from './fixtures/identities';

const ME = ['op-key-pw', 'ef'.repeat(16)] as const;

beforeAll(async () => {
    await warmIdentities([ME]);
    setActiveIdentity(await testIdentity(...ME));
}, WARM_TIMEOUT_MS);

beforeEach(() => {
    get.mockReset(); post.mockReset(); patch.mockReset(); del.mockReset();
    post.mockResolvedValue({ id: 1, title: '', created_at: 'x', total_tasks: 0, completed_tasks: 0 });
    patch.mockResolvedValue({});
});

describe('a create key is random, never a fingerprint of the content', () => {
    it('two notes with the SAME title get different keys', async () => {
        const a = newOpKey();
        const b = newOpKey();
        expect(a).not.toBe(b);
        await createTaskList('Shopping', a);
        await createTaskList('Shopping', b);
        const keys = post.mock.calls.map(c => (c[1] as Record<string, string>).op_key);
        expect(new Set(keys).size).toBe(2);
        // ...and neither is derived from the title: the sealed title differs
        // between the two calls, the key differs, and nothing links them.
        expect(JSON.stringify(post.mock.calls)).not.toContain('Shopping');
    });

    it('every minted key is the shape the server accepts', () => {
        const many = Array.from({ length: 200 }, () => newOpKey());
        expect(many.every(k => OP_KEY_SHAPE.test(k))).toBe(true);
        expect(new Set(many).size).toBe(200);
        // POSITIVE CONTROL: the shape really does refuse things.
        expect(OP_KEY_SHAPE.test('short')).toBe(false);
        expect(OP_KEY_SHAPE.test(`${newOpKey()}.`)).toBe(false);
    });
});

describe('the key rides the create, and only when the caller has one', () => {
    it('createTaskList / createListTask / createTaskListWithContent send op_key', async () => {
        const k = newOpKey();
        await createTaskList('a', k);
        expect((post.mock.calls[0][1] as Record<string, unknown>).op_key).toBe(k);

        post.mockClear();
        await createListTask(7, 'an item', undefined, undefined, k);
        expect((post.mock.calls[0][1] as Record<string, unknown>).op_key).toBe(k);

        post.mockClear();
        post.mockResolvedValue({ id: 2, title: 'x', created_at: 'x', total_tasks: 0, completed_tasks: 0, body: null, attachments: null, trashed_at: null });
        await createTaskListWithContent('note', { body: 'text' }, k);
        expect((post.mock.calls[0][1] as Record<string, unknown>).op_key).toBe(k);
    });

    it('omits the field entirely when none is given, so an older server sees today’s request', async () => {
        await createTaskList('a');
        await createListTask(7, 'an item');
        for (const call of post.mock.calls) {
            expect(Object.keys(call[1] as object)).not.toContain('op_key');
        }
    });
});

describe('a save names the revision it was based on', () => {
    it('setTaskListBody / setTaskListAttachments / renameTaskList send expect_rev when given one', async () => {
        await setTaskListBody(5, 'words', 4);
        expect((patch.mock.calls[0][1] as Record<string, unknown>).expect_rev).toBe(4);

        patch.mockClear();
        await setTaskListAttachments(5, [], 9);
        expect((patch.mock.calls[0][1] as Record<string, unknown>).expect_rev).toBe(9);

        patch.mockClear();
        await renameTaskList(5, 'New name', 0);
        // 0 is a real revision — a freshly made note — and must not be
        // dropped as falsy.
        expect((patch.mock.calls[0][1] as Record<string, unknown>).expect_rev).toBe(0);
    });

    it('omits expect_rev when the caller has no base: no check, exactly as before', async () => {
        await setTaskListBody(5, 'words');
        await setTaskListAttachments(5, []);
        await renameTaskList(5, 'name');
        for (const call of patch.mock.calls) {
            expect(Object.keys(call[1] as object)).not.toContain('expect_rev');
        }
    });

    it('answers with the new revision, and with null from a server that has none', async () => {
        patch.mockResolvedValueOnce({ content_rev: 12 });
        expect(await setTaskListBody(5, 'words', 11)).toBe(12);
        patch.mockResolvedValueOnce('');
        expect(await setTaskListBody(5, 'words', 11)).toBeNull();
    });
});

describe('the 409 that means "someone else wrote this note"', () => {
    const stale = async (body: string) => new ApiError(
        'conflict', 409,
        undefined,
        JSON.stringify({ conflict: 'stale', content_rev: 7, title: 'sealed-title', body: await sealSelfField(body), attachments: null }),
    );

    it('throws NoteConflictError carrying the OPENED copy the server holds', async () => {
        patch.mockRejectedValueOnce(await stale('their words'));
        await expect(setTaskListBody(5, 'my words', 6)).rejects.toThrow(NoteConflictError);
        patch.mockRejectedValueOnce(await stale('their words'));
        try {
            await setTaskListBody(5, 'my words', 6);
            expect.unreachable('the save must not resolve');
        } catch (err) {
            expect(err).toBeInstanceOf(NoteConflictError);
            const c = err as NoteConflictError;
            expect(c.contentRev).toBe(7);
            expect(c.body).toBe('their words');
            expect(c.attachments).toBeNull();
            // The title stays sealed: opening it needs tasks.ts, which
            // imports this path. The body UI does not need it.
            expect(c.sealedTitle).toBe('sealed-title');
        }
    });

    it('every OTHER 409 behaves exactly as it did — a trashed note, an envelope downgrade', async () => {
        for (const message of ['This note is in the trash', 'Refusing to replace content this client cannot read']) {
            patch.mockRejectedValueOnce(new ApiError(message, 409, undefined, message));
            await expect(setTaskListBody(5, 'my words', 6)).rejects.toThrow(ApiError);
            patch.mockRejectedValueOnce(new ApiError(message, 409, undefined, message));
            await expect(setTaskListBody(5, 'my words', 6)).rejects.not.toThrow(NoteConflictError);
        }
        // A 409 with a JSON body that is NOT this conflict is also left alone.
        patch.mockRejectedValueOnce(new ApiError('{"error":"nope"}', 409, undefined, '{"error":"nope"}'));
        await expect(setTaskListBody(5, 'my words', 6)).rejects.not.toThrow(NoteConflictError);
    });

    it('the sealed body really was sealed — the conflict path is not reading plaintext off the wire', async () => {
        const sealed = await sealSelfField('their words');
        expect(sealed).not.toContain('their words');
        expect(await openSelfField(sealed)).toBe('their words');
    });
});
