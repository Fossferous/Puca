/**
 * v3 envelopes bind CONTEXT into the AES-GCM tag (api/e2ee.ts, "v3 context
 * binding"). These pin, at the primitive level and through the real message
 * wrappers, exactly what that buys — and, as importantly, that v2 history still
 * opens under the new reader, since a mistake there is permanent.
 *
 * EMIT_ENVELOPE_V3 has been ON since 0.8.136 (0.8.135 shipped the reader
 * alone). The explicit-version seal functions still mint v2 where a test needs
 * the old format on purpose.
 */
import { describe, it, expect, vi } from 'vitest';
import {
    makeIdentity, sealChannelEnvelope, decryptChannelMessage, encryptChannelMessage, setActiveIdentity, clearActiveIdentity,
    wrapChannelKeyForMembers, unwrapChannelKey, wrapAad, isWrapV3, EMIT_WRAP_V3,
    sealDmEnvelope, decryptDM, encryptDM, channelAad, dmAad, parseEnvelopeEx, isEncrypted,
    messageEncState, EMIT_ENVELOPE_V3, type Envelope,
} from '../api/e2ee';
import { ENC_UNSUPPORTED_VERSION, ENC_CONTEXT_MISMATCH, ENC_CANNOT_DECRYPT, ENC_KEY_UNAVAILABLE, isUndecryptable } from '../api/decryptMarkers';
import kat from './fixtures/e2ee-wire-format-kat.json';

// Wrap (not replace) the channel producer so the wrapper tests can see WHICH
// context each send path seals under: the call is direct evidence of the
// context, independent of whether a decrypt round-trip would have caught it.
vi.mock('../api/e2ee', async (orig) => {
    const m = await orig<typeof import('../api/e2ee')>();
    return { ...m, encryptChannelMessage: vi.fn(m.encryptChannelMessage), encryptDM: vi.fn(m.encryptDM) };
});
vi.mock('../api/keyVerification', () => ({
    // The DM wrapper resolves the partner's key through the pin path; user 8 is A.
    resolvePinnedIdentityKey: async (userId: number) => (userId === 8 ? A().publicKeyEncoded : null),
}));

const fromB64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));
const CK = fromB64(kat.channelKey_b64);
const A = () => makeIdentity(fromB64(kat.seedA_b64));
const B = () => makeIdentity(fromB64(kat.seedB_b64));
const ctx = { kind: 'chan-msg' as const, channelId: 7, senderId: 41 };

describe('the AAD grammar', () => {
    it('is the documented byte layout', () => {
        expect(Buffer.from(channelAad(ctx, 3)).toString()).toBe('puca/v3/chan-msg/7/3/41');
        expect(Buffer.from(dmAad({ senderId: 41, recipientId: 8 })).toString()).toBe('puca/v3/dm/41/8');
    });
    it('refuses anything that is not a non-negative safe integer, rather than stringifying it', () => {
        expect(() => channelAad({ ...ctx, channelId: -1 }, 3)).toThrow();
        expect(() => channelAad({ ...ctx, senderId: 1.5 }, 3)).toThrow();
        expect(() => channelAad(ctx, Number.NaN)).toThrow();
        expect(() => dmAad({ senderId: 1, recipientId: undefined as unknown as number })).toThrow();
        expect(() => channelAad({ ...ctx, kind: 'chan-x' as never }, 3)).toThrow();
    });
});

describe('v2 history survives the new reader (the permanent-loss canary)', () => {
    it('opens the frozen v2 channel message whatever context is supplied', async () => {
        expect(await decryptChannelMessage(CK, kat.ch.envelope as Envelope, { kind: 'chan-task', channelId: 1, senderId: 1 })).toBe(kat.ch.plaintext);
    });
    it('opens the frozen v2 DM whatever direction is supplied', async () => {
        expect(await decryptDM(B(), kat.pubA, kat.dm.envelope as Envelope, { senderId: 9, recipientId: 9 })).toBe(kat.dm.plaintext);
    });
    it('the default producers emit v3 now that EMIT_ENVELOPE_V3 is on', async () => {
        expect(EMIT_ENVELOPE_V3).toBe(true);
        expect((await encryptChannelMessage(CK, 3, 'x', ctx)).v).toBe(3);
        expect((await encryptDM(A(), B().publicKeyEncoded, 'x', { senderId: 1, recipientId: 2 }))?.v).toBe(3);
    });
});

describe('v3 channel messages', () => {
    it('round-trip under the exact context', async () => {
        const env = await sealChannelEnvelope(CK, 3, 'hello', ctx, 3);
        expect(env.v).toBe(3);
        expect(await decryptChannelMessage(CK, env, ctx)).toBe('hello');
    });
    it('FAIL when the server moves them to another channel (same key)', async () => {
        const env = await sealChannelEnvelope(CK, 3, 'hello', ctx, 3);
        expect(await decryptChannelMessage(CK, env, { ...ctx, channelId: 8 })).toBeNull();
    });
    it('FAIL when the server re-attributes them to another member (same key)', async () => {
        const env = await sealChannelEnvelope(CK, 3, 'hello', ctx, 3);
        expect(await decryptChannelMessage(CK, env, { ...ctx, senderId: 42 })).toBeNull();
    });
    it('FAIL when the epoch label is rewritten, even though the key is the same', async () => {
        // The reader binds the epoch the ENVELOPE carries — the value it used to
        // pick the key. With v2 the same relabel would silently succeed.
        const v3 = await sealChannelEnvelope(CK, 3, 'hello', ctx, 3);
        const v2 = await sealChannelEnvelope(CK, 3, 'hello', ctx, 2);
        expect(await decryptChannelMessage(CK, { ...v2, epoch: 4 }, ctx)).toBe('hello');
        expect(await decryptChannelMessage(CK, { ...v3, epoch: 4 }, ctx)).toBeNull();
    });
    it('a checklist item does not open as a message, nor an attachment sidecar as a description', async () => {
        const task = await sealChannelEnvelope(CK, 3, 'buy milk', { ...ctx, kind: 'chan-task' }, 3);
        expect(await decryptChannelMessage(CK, task, ctx)).toBeNull();
        expect(await decryptChannelMessage(CK, task, { ...ctx, kind: 'chan-taskatt' })).toBeNull();
        expect(await decryptChannelMessage(CK, task, { ...ctx, kind: 'chan-task' })).toBe('buy milk');
    });
});

describe('v3 channel key wraps (the highest-value binding: the wrong KEY, not just the wrong author)', () => {
    const members = () => [{ userId: 41, publicKey: B().publicKeyEncoded }];
    const ctx = { channelId: 7, epoch: 5 };

    it('the grammar', () => {
        expect(Buffer.from(wrapAad(ctx, 41)).toString()).toBe('puca/v3/wrap/7/5/41');
    });
    it('the default producer emits v3 (prefixed) and it opens under the row\'s own channel/epoch/recipient', async () => {
        expect(EMIT_WRAP_V3).toBe(true);
        const [w] = await wrapChannelKeyForMembers(A(), CK, members(), ctx);
        expect(isWrapV3(w.wrappedKey)).toBe(true);
        expect(await unwrapChannelKey(B(), w, { ...ctx, recipientId: 41 })).toEqual(CK);
    });
    it('a v3 wrap lifted to another channel, another epoch or another recipient is null — the substitution the KEK never prevented', async () => {
        const [w] = await wrapChannelKeyForMembers(A(), CK, members(), ctx);
        expect(await unwrapChannelKey(B(), w, { channelId: 8, epoch: 5, recipientId: 41 })).toBeNull();
        expect(await unwrapChannelKey(B(), w, { channelId: 7, epoch: 2, recipientId: 41 })).toBeNull();
        expect(await unwrapChannelKey(B(), w, { channelId: 7, epoch: 5, recipientId: 42 })).toBeNull();
        expect(await unwrapChannelKey(B(), w)).toBeNull(); // a reader that predates v3
    });
    it('a v2 wrap (the frozen format, and what every pre-0.9.0 client wrote) still opens under any or no context', async () => {
        const [w] = await wrapChannelKeyForMembers(A(), CK, members(), ctx, 2);
        expect(isWrapV3(w.wrappedKey)).toBe(false);
        expect(await unwrapChannelKey(B(), w)).toEqual(CK);
        expect(await unwrapChannelKey(B(), w, { channelId: 999, epoch: 999, recipientId: 999 })).toEqual(CK);
        expect(await unwrapChannelKey(B(), kat.wrappedChannelKey as never)).toEqual(CK);
    });
});

describe('v3 DMs', () => {
    it('round-trip in the sealed direction, from either end of the pair', async () => {
        const env = await sealDmEnvelope(A(), B().publicKeyEncoded, 'hi', { senderId: 1, recipientId: 2 }, 3);
        expect(env?.v).toBe(3);
        expect(await decryptDM(B(), A().publicKeyEncoded, env as Envelope, { senderId: 1, recipientId: 2 })).toBe('hi');
        expect(await decryptDM(A(), B().publicKeyEncoded, env as Envelope, { senderId: 1, recipientId: 2 })).toBe('hi');
    });
    it('FAIL when the direction is flipped (the sender_id re-attribution attack)', async () => {
        const env = await sealDmEnvelope(A(), B().publicKeyEncoded, 'hi', { senderId: 1, recipientId: 2 }, 3);
        expect(await decryptDM(B(), A().publicKeyEncoded, env as Envelope, { senderId: 2, recipientId: 1 })).toBeNull();
    });
});

describe('version detection', () => {
    it('an envelope-shaped v4 is "unsupported", never plaintext', () => {
        const wire = JSON.stringify({ v: 4, t: 'ch', epoch: 1, ct: 'AAAA' });
        expect(parseEnvelopeEx(wire)).toEqual({ kind: 'unsupported-version', v: 4 });
        expect(isEncrypted(wire)).toBe(true);
        expect(messageEncState(wire, ENC_UNSUPPORTED_VERSION)).toBe('failed');
        expect(isUndecryptable(ENC_UNSUPPORTED_VERSION)).toBe(true);
        expect(isUndecryptable(ENC_CONTEXT_MISMATCH)).toBe(true);
    });
    it('plaintext and non-envelope JSON stay plaintext', () => {
        expect(parseEnvelopeEx('hello')).toEqual({ kind: 'plaintext' });
        expect(parseEnvelopeEx('{"a":1}')).toEqual({ kind: 'plaintext' });
        expect(parseEnvelopeEx('{not json')).toEqual({ kind: 'plaintext' });
    });
});

describe('the channel message wrapper (servers.decryptChannelContent)', () => {
    vi.mock('../api/channelKeys', () => ({
        ensureChannelKey: async () => ({ key: CK, epoch: 3 }),
        getChannelKeyForEpoch: async () => CK,
    }));
    vi.mock('../api/auth', async (orig) => ({ ...(await orig<typeof import('../api/auth')>()), currentUserIdFromToken: () => 41 }));

    it('shows the context marker for a v3 message the server re-attributed, and the plain failure marker for a v2 one', async () => {
        const { decryptChannelContent } = await import('../api/servers');
        const v3 = JSON.stringify(await sealChannelEnvelope(CK, 3, 'hello', ctx, 3));
        expect(await decryptChannelContent(7, v3, 41)).toBe('hello');
        expect(await decryptChannelContent(7, v3, 42)).toBe(ENC_CONTEXT_MISMATCH);
        const v2 = await sealChannelEnvelope(CK, 3, 'hello', ctx, 2);
        const tail = v2.ct.endsWith('AAAA') ? 'BBBB' : 'AAAA'; // never a no-op
        const tampered = JSON.stringify({ ...v2, ct: v2.ct.slice(0, -4) + tail });
        expect(await decryptChannelContent(7, tampered, 41)).toBe(ENC_CANNOT_DECRYPT);
        expect(await decryptChannelContent(7, JSON.stringify({ v: 4, t: 'ch', ct: 'x' }), 41)).toBe(ENC_UNSUPPORTED_VERSION);
        const dmInChannelRow = JSON.stringify(await sealDmEnvelope(A(), B().publicKeyEncoded, 'x', { senderId: 1, recipientId: 2 }, 2));
        expect(await decryptChannelContent(7, dmInChannelRow, 41)).toBe(ENC_CANNOT_DECRYPT);
        expect(await decryptChannelContent(7, 'plain legacy text', 41)).toBe('plain legacy text');
    });

    it('the send path seals under the current epoch and the signed-in user as author', async () => {
        const { sendChannelMessageEncrypted } = await import('../api/servers');
        const { apiClient } = await import('../api/client');
        const post = vi.spyOn(apiClient, 'post').mockResolvedValue({ id: 'm1' } as never);
        const sent = await sendChannelMessageEncrypted(7, 'hello');
        expect(sent.keyEpoch).toBe(3);
        const env = JSON.parse(sent.wireContent) as Envelope;
        expect(env.v).toBe(3); // emitting since 0.8.136
        expect(await decryptChannelMessage(CK, env, ctx)).toBe('hello');
        // v2 cannot show the context, so check the call the producer received.
        expect(vi.mocked(encryptChannelMessage)).toHaveBeenLastCalledWith(CK, 3, 'hello', { kind: 'chan-msg', channelId: 7, senderId: 41 });
        post.mockRestore();
    });

    it('an edit whose text is a decrypt-failure marker is refused before any key work (it would seal the marker over the original)', async () => {
        const { editChannelMessageEncrypted } = await import('../api/servers');
        const { apiClient } = await import('../api/client');
        const patch = vi.spyOn(apiClient, 'patch').mockResolvedValue(undefined as never);
        await editChannelMessageEncrypted(7, 'm1', 'fixed typo');
        // The edit tells the server the highest envelope version it can open, so a
        // reader-first build is never mistaken for a stale one.
        expect(patch).toHaveBeenLastCalledWith('/channels/7/messages/m1', expect.objectContaining({ reads_up_to: 3, content: expect.stringContaining('"v":3') }));
        patch.mockRestore();
        await expect(editChannelMessageEncrypted(7, 'm1', ENC_CONTEXT_MISMATCH)).rejects.toThrow(/can't be edited/);
        await expect(editChannelMessageEncrypted(7, 'm1', ENC_KEY_UNAVAILABLE)).rejects.toThrow(/can't be edited/);
    });
});

describe('the checklist wrappers (tasks.ts) seal under the CREATOR, never the editor', () => {
    const row = (created_by: number, description: string) => ({
        id: 1, channel_id: 7, list_id: null, parent_id: null, description, is_completed: false,
        position: 0, created_at: '2026-09-02T00:00:00Z', created_by, attachments: null,
    });

    it('createTask seals under the signed-in user; the update paths under created_by', async () => {
        const { createTask, updateChannelTask, updateChannelTaskAttachments } = await import('../api/tasks');
        const { apiClient } = await import('../api/client');
        const post = vi.spyOn(apiClient, 'post').mockImplementation(async (_url: string, body: unknown) => row(41, (body as { description: string }).description) as never);
        const patch = vi.spyOn(apiClient, 'patch').mockResolvedValue(undefined as never);
        await createTask(7, 'buy milk');
        expect(vi.mocked(encryptChannelMessage)).toHaveBeenLastCalledWith(CK, 3, 'buy milk', { kind: 'chan-task', channelId: 7, senderId: 41 });
        await updateChannelTask(7, 1, { description: 'buy oat milk' }, 99); // a manager editing 99's item
        expect(vi.mocked(encryptChannelMessage)).toHaveBeenLastCalledWith(CK, 3, 'buy oat milk', { kind: 'chan-task', channelId: 7, senderId: 99 });
        await updateChannelTaskAttachments(7, 1, [{ href: 'sovereign-enc:f1?k=K&m=image%2Fpng', name: 'pic.png' }], 99);
        expect(vi.mocked(encryptChannelMessage)).toHaveBeenLastCalledWith(CK, 3, expect.any(String), { kind: 'chan-taskatt', channelId: 7, senderId: 99 });
        await expect(updateChannelTask(7, 1, { description: ENC_KEY_UNAVAILABLE }, 99)).rejects.toThrow(/decrypt-failure marker/);
        expect(patch).not.toHaveBeenCalledWith('/tasks/1', expect.objectContaining({ description: expect.stringContaining('[Encrypted') }));
        expect(patch).toHaveBeenCalledWith('/tasks/1', expect.objectContaining({ reads_up_to: 3 }));
        post.mockRestore(); patch.mockRestore();
    });

    it('a personal list opens plaintext and v2 self items, and calls a v3 self item unsupported (no self grammar exists)', async () => {
        const { listListTasks } = await import('../api/tasks');
        const { apiClient } = await import('../api/client');
        const get = vi.spyOn(apiClient, 'get').mockResolvedValue([
            { ...row(41, 'plain legacy note'), list_id: 5, channel_id: null },
            { ...row(41, JSON.stringify({ v: 3, t: 'self', ct: 'AAAA' })), id: 2, list_id: 5, channel_id: null },
        ] as never);
        const out = await listListTasks(5);
        expect(out[0].description).toBe('plain legacy note');
        expect(out[1].description).toBe(ENC_UNSUPPORTED_VERSION);
        get.mockRestore();
    });

    it('listTasks opens each item under ITS created_by; a re-attributed v3 item shows the context marker', async () => {
        const { listTasks } = await import('../api/tasks');
        const { apiClient } = await import('../api/client');
        const sealed = JSON.stringify(await sealChannelEnvelope(CK, 3, 'buy milk', { kind: 'chan-task', channelId: 7, senderId: 41 }, 3));
        const get = vi.spyOn(apiClient, 'get').mockResolvedValue([row(41, sealed), { ...row(42, sealed), id: 2 }] as never);
        const out = await listTasks(7);
        expect(out[0].description).toBe('buy milk');
        expect(out[1].description).toBe(ENC_CONTEXT_MISMATCH);
        get.mockRestore();
    });
});

describe('the DM wrapper (dms.decryptDMContent) with the real primitives', () => {
    // me = 41 (B, per the auth mock); the partner A is user 8.
    const seal = (v: 2 | 3) => sealDmEnvelope(A(), B().publicKeyEncoded, 'hi', { senderId: 8, recipientId: 41 }, v);

    it('opens a v3 DM from the partner, refuses it re-attributed or flipped, and still opens v2 under any sender', async () => {
        setActiveIdentity(B());
        try {
            const { decryptDMContent } = await import('../api/dms');
            const v3 = JSON.stringify(await seal(3));
            expect(await decryptDMContent(v3, 8, 8)).toBe('hi');
            expect(await decryptDMContent(v3, 8, 9)).toBe(ENC_CONTEXT_MISMATCH);   // sender not in the pair
            expect(await decryptDMContent(v3, 8, 41)).toBe(ENC_CONTEXT_MISMATCH);  // direction flipped
            const v2 = JSON.stringify(await seal(2));
            expect(await decryptDMContent(v2, 8, 999)).toBe('hi');
            expect(await decryptDMContent(JSON.stringify({ v: 4, t: 'dm', ct: 'x' }), 8, 8)).toBe(ENC_UNSUPPORTED_VERSION);
            const chInDmRow = JSON.stringify(await sealChannelEnvelope(CK, 3, 'x', ctx, 2));
            expect(await decryptDMContent(chInDmRow, 8, 8)).toBe(ENC_CANNOT_DECRYPT);
            expect(await decryptDMContent('plain legacy text', 8, 8)).toBe('plain legacy text');
            expect(await decryptDMContent(JSON.stringify({ v: 3, t: 'self', ct: 'AAAA' }), 41, 41)).toBe(ENC_UNSUPPORTED_VERSION);
            const { encryptDMContent } = await import('../api/dms');
            await expect(encryptDMContent(ENC_CONTEXT_MISMATCH, 8)).rejects.toThrow(/can't be edited or re-sent/);
            // The send path seals under me -> partner, the direction the reader recomputes.
            const wire = await encryptDMContent('hi there', 8);
            expect(vi.mocked(encryptDM)).toHaveBeenLastCalledWith(expect.anything(), A().publicKeyEncoded, 'hi there', { senderId: 41, recipientId: 8 });
            expect((JSON.parse(wire) as Envelope).v).toBe(3);
            expect(await decryptDMContent(wire, 8, 41)).toBe('hi there'); // my own echo, read back
        } finally {
            clearActiveIdentity();
        }
    });
});
