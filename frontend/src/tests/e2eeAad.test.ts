/**
 * v3 envelopes bind CONTEXT into the AES-GCM tag (api/e2ee.ts, "v3 context
 * binding"). These pin, at the primitive level and through the real message
 * wrappers, exactly what that buys — and, as importantly, that v2 history still
 * opens under the new reader, since a mistake there is permanent.
 *
 * EMIT_ENVELOPE_V3 is off in this release (reader-only rollout), so v3 is
 * produced here through the explicit-version seal functions.
 */
import { describe, it, expect, vi } from 'vitest';
import {
    makeIdentity, sealChannelEnvelope, decryptChannelMessage, encryptChannelMessage,
    sealDmEnvelope, decryptDM, encryptDM, channelAad, dmAad, parseEnvelopeEx, isEncrypted,
    messageEncState, EMIT_ENVELOPE_V3, type Envelope,
} from '../api/e2ee';
import { ENC_UNSUPPORTED_VERSION, ENC_CONTEXT_MISMATCH, ENC_CANNOT_DECRYPT, isUndecryptable } from '../api/decryptMarkers';
import kat from './fixtures/e2ee-wire-format-kat.json';

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
    });
});

describe('v2 history survives the new reader (the permanent-loss canary)', () => {
    it('opens the frozen v2 channel message whatever context is supplied', async () => {
        expect(await decryptChannelMessage(CK, kat.ch.envelope as Envelope, { kind: 'chan-task', channelId: 1, senderId: 1 })).toBe(kat.ch.plaintext);
    });
    it('opens the frozen v2 DM whatever direction is supplied', async () => {
        expect(await decryptDM(B(), kat.pubA, kat.dm.envelope as Envelope, { senderId: 9, recipientId: 9 })).toBe(kat.dm.plaintext);
    });
    it('the default producers still emit v2 while EMIT_ENVELOPE_V3 is off', async () => {
        expect(EMIT_ENVELOPE_V3).toBe(false);
        expect((await encryptChannelMessage(CK, 3, 'x', ctx)).v).toBe(2);
        expect((await encryptDM(A(), B().publicKeyEncoded, 'x', { senderId: 1, recipientId: 2 }))?.v).toBe(2);
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
        const tampered = JSON.stringify({ ...v2, ct: v2.ct.slice(0, -4) + 'AAAA' });
        expect(await decryptChannelContent(7, tampered, 41)).toBe(ENC_CANNOT_DECRYPT);
        expect(await decryptChannelContent(7, JSON.stringify({ v: 4, t: 'ch', ct: 'x' }), 41)).toBe(ENC_UNSUPPORTED_VERSION);
    });

    it('the send path seals under the current epoch and the signed-in user as author', async () => {
        const { sendChannelMessageEncrypted } = await import('../api/servers');
        const { apiClient } = await import('../api/client');
        const post = vi.spyOn(apiClient, 'post').mockResolvedValue({ id: 'm1' } as never);
        const sent = await sendChannelMessageEncrypted(7, 'hello');
        expect(sent.keyEpoch).toBe(3);
        const env = JSON.parse(sent.wireContent) as Envelope;
        expect(env.v).toBe(2); // reader-only release
        expect(await decryptChannelMessage(CK, env, ctx)).toBe('hello');
        post.mockRestore();
    });
});
