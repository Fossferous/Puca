/**
 * The remembered-seed store behind "don't ask for the unattended passphrase
 * again for a while".
 *
 * What is stored is the Argon2id-stretched Ed25519 SEED, never the passphrase
 * — capability-equivalent for the one host it was proved to, but useless as a
 * password anywhere else. The entry is pinned to the host's salt (re-arming
 * changes the salt, so a stale seed MISSES rather than signing garbage), it
 * expires without use, and both miss paths must DROP the dead entry rather
 * than leave seeds in storage that nothing will ever read again.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// THIS RIG IS A NATIVE SHELL. `rememberUaSeed` refuses to write outside Tauri
// or Capacitor — what it stores is a signing key for someone's machine, and in
// a shared browser profile a later user could lift it. Under jsdom neither
// detector is true, so without this every assertion below would be about an
// empty store rather than about what the store KEEPS. The refusal itself is
// pinned in api/devices/unattended.test.ts.
vi.mock('../api/platform', () => ({ isTauri: () => true, isMobile: () => false }));
// A fake DPAPI: reversible, so the tests can see that what lands in storage is
// NOT the seed, and that recall goes back through the OS primitive.
vi.mock('../api/deviceIdentity/deviceKey', async (orig) => ({
    ...(await orig<typeof import('../api/deviceIdentity/deviceKey')>()),
    invokeTauri: async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === 'ua_seed_protect') return 'SEALED(' + String(args?.seedB64) + ')';
        if (cmd === 'ua_seed_unprotect') {
            const b = String(args?.blobB64);
            if (!b.startsWith('SEALED(')) throw new Error('not a blob sealed here');
            return b.slice(7, -1);
        }
        throw new Error('unexpected command ' + cmd);
    },
}));
const flush = () => new Promise(r => setTimeout(r, 0));

import {
    deriveUaSeed,
    signUaChallenge,
    signUaChallengeSeed,
    rememberUaSeed,
    rememberedUaSeed,
    confirmUaSeed,
    forgetUaSeed,
    UA_REMEMBER_MS,
} from '../api/devices/unattended';

const KEY = 'sovereign-ua-remember';
const SALT_B64 = btoa('salt-abcdefghij!');
const T0 = 1_700_000_000_000;

function seed32(fill: number): Uint8Array {
    return new Uint8Array(32).fill(fill);
}

// The shared setup.ts replaces localStorage with storeless vi.fn() stubs
// (getItem always undefined), which would make every round-trip assertion
// here vacuous. This file is about what the store KEEPS, so it needs a real
// one; the override is per-file — vitest gives each test file its own jsdom.
const store = new Map<string, string>();
beforeAll(() => {
    Object.defineProperty(window, 'localStorage', {
        configurable: true,
        value: {
            getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
            setItem: (k: string, v: string) => { store.set(k, String(v)); },
            removeItem: (k: string) => { store.delete(k); },
            clear: () => { store.clear(); },
        },
    });
});

beforeEach(() => {
    store.clear();
});

// Two Argon2id derivations at the production cost — ~1.2s idle, measured past
// the 5s default at 2x CPU oversubscription. It is the derivation being pinned,
// so it cannot be cached or hoisted; give it headroom instead. The store tests
// below stay on the strict default, where they run in under a millisecond.
describe('seed signing is byte-identical to passphrase signing', { timeout: 30_000 }, () => {
    /**
     * The cache path signs with a stored seed; the prompt path derives then
     * signs. If the two ever diverge, a remembered seed produces signatures
     * the host rejects — which the auto-forget would then mask as an eternal
     * re-prompt rather than an error anyone can see. Pin the equivalence.
     */
    it('signUaChallengeSeed(deriveUaSeed(p)) === signUaChallenge(p)', async () => {
        const salt = Uint8Array.from(atob(SALT_B64), c => c.charCodeAt(0));
        const nonce = new Uint8Array(32).fill(3);
        const viaPassphrase = signUaChallenge('correct horse battery', salt, 'session-1', nonce);
        const viaSeed = signUaChallengeSeed(
            deriveUaSeed('correct horse battery', salt),
            'session-1',
            nonce,
        );
        expect(Array.from(viaSeed)).toEqual(Array.from(viaPassphrase));
    });
});

describe('the remembered-seed store', () => {
    it('returns what was remembered, inside the window, under the same salt', async () => {
        rememberUaSeed('dev-a', SALT_B64, seed32(7), T0); await flush();
        const got = await rememberedUaSeed('dev-a', SALT_B64, T0 + UA_REMEMBER_MS - 1);
        expect(got).not.toBeNull();
        expect(Array.from(got!)).toEqual(Array.from(seed32(7)));
    });

    it('is keyed per device', async () => {
        rememberUaSeed('dev-a', SALT_B64, seed32(7), T0); await flush();
        expect(await rememberedUaSeed('dev-b', SALT_B64, T0)).toBeNull();
    });

    it('misses on a salt change AND drops the stale entry', async () => {
        rememberUaSeed('dev-a', SALT_B64, seed32(7), T0); await flush();
        const otherSalt = btoa('salt-REARMED-...!');
        expect(await rememberedUaSeed('dev-a', otherSalt, T0), 'a re-armed host must miss').toBeNull();
        // The drop is the half that keeps dead seeds out of storage: the
        // original salt must ALSO miss now.
        expect(await rememberedUaSeed('dev-a', SALT_B64, T0), 'and the stale entry is gone').toBeNull();
    });

    it('expires without use, dropping the entry', async () => {
        rememberUaSeed('dev-a', SALT_B64, seed32(7), T0); await flush();
        expect(await rememberedUaSeed('dev-a', SALT_B64, T0 + UA_REMEMBER_MS)).toBeNull();
        expect(localStorage.getItem(KEY), 'an emptied store removes its key').toBeNull();
    });

    it('confirmUaSeed slides the expiry', async () => {
        rememberUaSeed('dev-a', SALT_B64, seed32(7), T0); await flush();
        const halfway = T0 + UA_REMEMBER_MS / 2;
        confirmUaSeed('dev-a', halfway);
        // Past the ORIGINAL window, inside the slid one.
        expect(await rememberedUaSeed('dev-a', SALT_B64, T0 + UA_REMEMBER_MS + 1)).not.toBeNull();
        expect(await rememberedUaSeed('dev-a', SALT_B64, halfway + UA_REMEMBER_MS)).toBeNull();
    });

    it('forgetUaSeed removes exactly one device', async () => {
        rememberUaSeed('dev-a', SALT_B64, seed32(1), T0);
        rememberUaSeed('dev-b', SALT_B64, seed32(2), T0);
        forgetUaSeed('dev-a');
        expect(await rememberedUaSeed('dev-a', SALT_B64, T0)).toBeNull();
        expect(await rememberedUaSeed('dev-b', SALT_B64, T0)).not.toBeNull();
    });

    it('tolerates a corrupted store', async () => {
        localStorage.setItem(KEY, '{not json');
        expect(await rememberedUaSeed('dev-a', SALT_B64, T0)).toBeNull();
        // And recovers: remembering over the corruption works.
        rememberUaSeed('dev-a', SALT_B64, seed32(7), T0); await flush();
        expect(await rememberedUaSeed('dev-a', SALT_B64, T0)).not.toBeNull();
    });

    it('refuses a stored seed of the wrong length', async () => {
        localStorage.setItem(KEY, JSON.stringify({
            'dev-a': { salt: SALT_B64, seed: btoa('short'), expires: T0 + UA_REMEMBER_MS },
        }));
        expect(await rememberedUaSeed('dev-a', SALT_B64, T0), 'a truncated seed must not sign').toBeNull();
    });
});
