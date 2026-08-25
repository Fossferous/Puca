import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { buildForwardText } from '../components/contextMenuUtils';

// Guards the fail-closed E2EE + encrypt-before-send findings:
//   H3 — channel message EDITS must be encrypted (were plaintext).
//   H4 — channel + DM sends fail CLOSED (throw SecureSendError) instead of
//        silently downgrading to plaintext; the recipient/member key is resolved
//        through the pin path.
// The Forward flow (ForwardModal) sends via sendChannelMessageEncrypted /
// encryptDMContent, so asserting those emit ciphertext also guards the forward
// path's "ciphertext is sent" requirement.

// Stateful fake of the key + message endpoints (mirrors channelKeys.test.ts).
const captured = { sentContent: '' as string, sentEpoch: null as number | null, editedContent: '' as string };
const fake = {
    currentEpoch: 0,
    currentGeneration: 0,
    epochGeneration: 0,
    published: [] as { epoch: number; wrapped_key: string; sender_public_key: string; member_generation: number }[],
    members: [] as { user_id: number; public_key: string | null }[],
    userKeys: new Map<number, string | null>(),
    reset() {
        this.currentEpoch = 0; this.currentGeneration = 0; this.epochGeneration = 0;
        this.published = []; this.members = []; this.userKeys = new Map();
        captured.sentContent = ''; captured.sentEpoch = null; captured.editedContent = '';
    },
};

vi.mock('../api/client', () => ({
    apiClient: {
        get: vi.fn(async (url: string) => {
            if (url.endsWith('/keys')) {
                return {
                    current_epoch: fake.currentEpoch,
                    current_generation: fake.currentGeneration,
                    epoch_generation: fake.epochGeneration,
                    keys: fake.published.filter((k) => k.epoch === fake.currentEpoch),
                };
            }
            if (url.endsWith('/member-keys')) return fake.members;
            const pk = url.match(/\/users\/(\d+)\/public-key/);
            if (pk) return { public_key: fake.userKeys.get(Number(pk[1])) ?? null };
            throw new Error('unexpected GET ' + url);
        }),
        post: vi.fn(async (url: string, body: Record<string, unknown>) => {
            if (url.endsWith('/keys')) {
                fake.currentEpoch = body.epoch as number;
                fake.epochGeneration = body.member_generation as number;
                const keys = body.keys as Array<{ recipient_id: number; wrapped_key: string; sender_public_key: string }>;
                const mine = keys.find((k) => k.recipient_id === 1);
                if (mine) fake.published.push({ epoch: body.epoch as number, wrapped_key: mine.wrapped_key, sender_public_key: mine.sender_public_key, member_generation: body.member_generation as number });
                return {};
            }
            if (/\/channels\/\d+\/messages$/.test(url)) {
                captured.sentContent = body.content as string;
                captured.sentEpoch = (body.key_epoch as number | null) ?? null;
                return { id: 'srv-1' };
            }
            throw new Error('unexpected POST ' + url);
        }),
        patch: vi.fn(async (url: string, body: Record<string, unknown>) => {
            if (/\/channels\/\d+\/messages\/.+/.test(url)) { captured.editedContent = body.content as string; return; }
            throw new Error('unexpected PATCH ' + url);
        }),
    },
}));

import { setActiveIdentity, clearActiveIdentity, parseEnvelope, SecureSendError } from '../api/e2ee';
import { testIdentity, warmIdentities, WARM_TIMEOUT_MS } from './fixtures/identities';

// Derived in beforeEach, so this was a ~380ms PBKDF2 per test. Warm once.
const ME = ['me', 'a1'.repeat(16)] as const;
const PEER = ['peer', 'b2'.repeat(16)] as const;

beforeAll(() => warmIdentities([ME, PEER]), WARM_TIMEOUT_MS);
import { sendChannelMessageEncrypted, editChannelMessageEncrypted } from '../api/servers';
import { encryptDMContent } from '../api/dms';
import { clearChannelKeyCache } from '../api/channelKeys';
import { pinServedIdentityKey } from '../api/keyVerification';

describe('channel send/edit encryption (H3, H4)', () => {
    beforeEach(async () => {
        fake.reset();
        clearChannelKeyCache();
        const me = await testIdentity(...ME);
        setActiveIdentity(me);
        fake.members = [{ user_id: 1, public_key: me.publicKeyEncoded }];
    });

    it('sends ciphertext (a channel envelope), never the plaintext', async () => {
        const res = await sendChannelMessageEncrypted(42, 'hello secret');
        const env = parseEnvelope(captured.sentContent);
        expect(env).not.toBeNull();
        expect(env!.t).toBe('ch');
        expect(captured.sentContent).not.toContain('hello secret');
        expect(res.keyEpoch).toBe(captured.sentEpoch);
        expect(typeof res.keyEpoch).toBe('number');
    });

    it('encrypts EDITS under the channel key — not raw plaintext (H3)', async () => {
        await editChannelMessageEncrypted(42, 'msg-9', 'edited secret');
        const env = parseEnvelope(captured.editedContent);
        expect(env).not.toBeNull();
        expect(env!.t).toBe('ch');
        expect(captured.editedContent).not.toContain('edited secret');
    });

    it('encrypts forwarded content (Forward path ciphertext)', async () => {
        await sendChannelMessageEncrypted(42, buildForwardText('secret note'));
        expect(captured.sentContent).not.toContain('secret note');
        expect(parseEnvelope(captured.sentContent)!.t).toBe('ch');
    });

    it('FAILS CLOSED (throws) instead of sending plaintext when no key is available', async () => {
        clearActiveIdentity();
        clearChannelKeyCache();
        await expect(sendChannelMessageEncrypted(42, 'nope')).rejects.toBeInstanceOf(SecureSendError);
        await expect(editChannelMessageEncrypted(42, 'm', 'nope')).rejects.toBeInstanceOf(SecureSendError);
        expect(captured.sentContent).toBe('');
        expect(captured.editedContent).toBe('');
    });
});

describe('DM send fail-closed (H4)', () => {
    beforeEach(async () => {
        fake.reset();
        const me = await testIdentity(...ME);
        setActiveIdentity(me);
    });

    it('encrypts to a DM envelope when the recipient key is available', async () => {
        const peer = await testIdentity(...PEER);
        fake.userKeys.set(701, peer.publicKeyEncoded);
        const wire = await encryptDMContent('private msg', 701);
        const env = parseEnvelope(wire);
        expect(env!.t).toBe('dm');
        expect(wire).not.toContain('private msg');
    });

    it('throws SecureSendError (no plaintext) when the recipient key is withheld', async () => {
        fake.userKeys.set(702, null);
        await expect(encryptDMContent('secret', 702)).rejects.toBeInstanceOf(SecureSendError);
    });

    it('throws when the identity is missing', async () => {
        clearActiveIdentity();
        await expect(encryptDMContent('secret', 703)).rejects.toBeInstanceOf(SecureSendError);
    });

    // The DM/media getCachedPublicKey session-cache already fixes a key for the
    // session, so a mid-session swap can't reach the pin; the pin is what catches
    // a swap across reloads (localStorage) or an uncached fetch. Test that pin
    // logic directly — it's the fail-closed anchor for H4 (and the channel M6).
    it('pinServedIdentityKey pins on first use and REFUSES a later different key', () => {
        expect(pinServedIdentityKey(90001, 'x25519:AAAAkey')).toBe('x25519:AAAAkey'); // pin
        expect(pinServedIdentityKey(90001, 'x25519:AAAAkey')).toBe('x25519:AAAAkey'); // same → ok
        expect(pinServedIdentityKey(90001, 'x25519:BBBBkey')).toBeNull();              // changed → refuse
        expect(pinServedIdentityKey(90002, null)).toBeNull();                          // missing → refuse
    });
});
