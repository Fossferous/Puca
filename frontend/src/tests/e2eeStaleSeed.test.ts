// The identity memo must follow storage once ANOTHER document changed it
// (api/e2ee.ts getActiveIdentity): a sign-out in the Púca tab must not leave
// the Keep tab sealing under the old seed, and an account switch must swap
// the identity. Same-document reads without a storage event keep the memo —
// that is the fast path every seal takes.
import { describe, it, expect, beforeEach, type Mock } from 'vitest';
import { setActiveIdentity, getActiveIdentity, clearActiveIdentity, makeIdentity, generateIdentitySeed, toBase64 } from '../api/e2ee';

const backing = new Map<string, string>();
beforeEach(() => {
    backing.clear();
    (localStorage.getItem as Mock).mockImplementation((k: string) => backing.get(k) ?? null);
    (localStorage.setItem as Mock).mockImplementation((k: string, v: string) => { backing.set(k, v); });
    (localStorage.removeItem as Mock).mockImplementation((k: string) => { backing.delete(k); });
    clearActiveIdentity();
});

function fire(key: string | null) {
    window.dispatchEvent(new StorageEvent('storage', { key }));
}

describe('getActiveIdentity across documents', () => {
    it('memoizes within the document and persists the seed', () => {
        const id = makeIdentity(generateIdentitySeed());
        setActiveIdentity(id);
        expect(backing.get('e2ee_seed_v2')).toBe(toBase64(id.privateKey));
        expect(getActiveIdentity()).toBe(id);
        expect(getActiveIdentity()).toBe(id);
    });

    it('returns null once another document removed the seed (a sign-out elsewhere)', () => {
        setActiveIdentity(makeIdentity(generateIdentitySeed()));
        backing.delete('e2ee_seed_v2');   // the other tab's logout()
        expect(getActiveIdentity()).not.toBeNull();   // no event yet: the memo stands
        fire('e2ee_seed_v2');
        expect(getActiveIdentity()).toBeNull();
    });

    it('swaps to the new seed once another document wrote one (an account switch)', () => {
        const a = makeIdentity(generateIdentitySeed());
        setActiveIdentity(a);
        const b = makeIdentity(generateIdentitySeed());
        backing.set('e2ee_seed_v2', toBase64(b.privateKey));   // the other tab's login()
        fire('e2ee_seed_v2');
        const now = getActiveIdentity();
        expect(now).not.toBeNull();
        expect(now!.publicKeyEncoded).toBe(b.publicKeyEncoded);
        expect(now!.publicKeyEncoded).not.toBe(a.publicKeyEncoded);
    });

    it('a storage event for the same seed keeps the same identity object', () => {
        const a = makeIdentity(generateIdentitySeed());
        setActiveIdentity(a);
        fire(null);   // clear() elsewhere with the seed then re-written identically
        // Storage still holds a's seed (this stub never cleared it).
        expect(getActiveIdentity()).toBe(a);
    });

    it('a storage event for an unrelated key changes nothing', () => {
        const a = makeIdentity(generateIdentitySeed());
        setActiveIdentity(a);
        backing.delete('e2ee_seed_v2');
        fire('sovereign_settings');
        expect(getActiveIdentity()).toBe(a);
    });

    it('a fresh document rebuilds the identity from storage', () => {
        const a = makeIdentity(generateIdentitySeed());
        backing.set('e2ee_seed_v2', toBase64(a.privateKey));
        expect(getActiveIdentity()?.publicKeyEncoded).toBe(a.publicKeyEncoded);
    });
});
