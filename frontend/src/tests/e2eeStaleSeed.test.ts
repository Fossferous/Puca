// The identity memo must follow storage once ANOTHER document changed it
// (api/e2ee.ts getActiveIdentity): a sign-out in the Púca tab must not leave
// the Notes tab sealing under the old seed, and an account switch must swap
// the identity. Same-document reads without a storage event keep the memo —
// that is the fast path every seal takes.
import { describe, it, expect, beforeEach, type Mock } from 'vitest';
import { setActiveIdentity, getActiveIdentity, clearActiveIdentity, seedMatchesCurrentAccount, makeIdentity, generateIdentitySeed, toBase64 } from '../api/e2ee';

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

// The seed is stamped with the account it belongs to (SEED_OWNER_KEY). Two
// flows leave one account's seed beside another account's token — a soft
// expiry keeps the seed on purpose, and login() stores the token before the
// seed — and in both the old identity used to be handed out under the new
// token. Púca Notes sealed a note to it; a personal list has no history, so
// that note was unreadable for good.
function jwt(sub: number): string {
    return `h.${btoa(JSON.stringify({ sub, username: `u${sub}` }))}.s`;
}
const signInAs = (sub: number) => { backing.set('auth_token', jwt(sub)); };
const SEED = 'e2ee_seed_v2';
const OWNER = 'e2ee_seed_owner_v1';

describe('the stored seed belongs to ONE account', () => {
    it('is stamped with the signed-in account — seed first, stamp second', () => {
        signInAs(1);
        (localStorage.setItem as Mock).mockClear();
        setActiveIdentity(makeIdentity(generateIdentitySeed()));
        expect(backing.get(OWNER)).toBe('1');
        // The other order would show another document the OLD seed under the
        // NEW stamp, which reads as a match.
        const order = (localStorage.setItem as Mock).mock.calls.map(c => c[0]).filter(k => k === SEED || k === OWNER);
        expect(order).toEqual([SEED, OWNER]);
    });

    it('same document: a new account\'s token before its seed gets NO identity, not the old one', () => {
        signInAs(1);
        const a = makeIdentity(generateIdentitySeed());
        setActiveIdentity(a);
        expect(getActiveIdentity()).toBe(a);
        backing.delete('auth_token');            // soft expiry: the seed stays
        expect(getActiveIdentity()).toBe(a);     // no token, nothing to mis-seal under
        signInAs(2);                             // login() stores the token first...
        expect(getActiveIdentity()).toBeNull();  // ...and a's identity is not account 2's
        const b = makeIdentity(generateIdentitySeed());
        setActiveIdentity(b);                    // ...then the seed
        expect(getActiveIdentity()).toBe(b);
        expect(backing.get(OWNER)).toBe('2');
    });

    it('fresh document: a stored seed stamped for another account is refused, and accepted for its own', () => {
        const a = makeIdentity(generateIdentitySeed());
        backing.set(SEED, toBase64(a.privateKey));
        backing.set(OWNER, '1');
        signInAs(2);
        expect(seedMatchesCurrentAccount()).toBe(false);
        expect(getActiveIdentity()).toBeNull();
        expect(backing.get(OWNER)).toBe('1');    // refused, not re-stamped
        signInAs(1);
        expect(seedMatchesCurrentAccount()).toBe(true);
        expect(getActiveIdentity()?.publicKeyEncoded).toBe(a.publicKeyEncoded);
    });

    it('an unstamped seed (written before the stamp existed) is accepted, adopted, and from then on guarded', () => {
        const a = makeIdentity(generateIdentitySeed());
        backing.set(SEED, toBase64(a.privateKey));
        signInAs(7);
        expect(seedMatchesCurrentAccount()).toBe(true);
        expect(getActiveIdentity()?.publicKeyEncoded).toBe(a.publicKeyEncoded);
        expect(backing.get(OWNER)).toBe('7');
        signInAs(8);
        expect(getActiveIdentity()).toBeNull();
    });

    it('registration (no token yet) leaves the seed unstamped and clears a stale stamp', () => {
        backing.set(OWNER, '1');
        const a = makeIdentity(generateIdentitySeed());
        setActiveIdentity(a);
        expect(backing.has(OWNER)).toBe(false);
        signInAs(3);                             // the sign-in that follows registration
        expect(getActiveIdentity()).toBe(a);
        expect(backing.get(OWNER)).toBe('3');
    });

    it('another document\'s stamp write re-validates the memo', () => {
        signInAs(1);
        setActiveIdentity(makeIdentity(generateIdentitySeed()));
        const b = makeIdentity(generateIdentitySeed());
        signInAs(2);                             // the other tab's login()
        backing.set(SEED, toBase64(b.privateKey));
        backing.set(OWNER, '2');
        expect(getActiveIdentity()).toBeNull();  // no event yet: the memo is account 1's
        fire(OWNER);
        expect(getActiveIdentity()?.publicKeyEncoded).toBe(b.publicKeyEncoded);
    });

    it('sign-out removes the stamp with the seed; no seed is never a match', () => {
        signInAs(1);
        setActiveIdentity(makeIdentity(generateIdentitySeed()));
        clearActiveIdentity();
        expect(backing.has(SEED)).toBe(false);
        expect(backing.has(OWNER)).toBe(false);
        expect(seedMatchesCurrentAccount()).toBe(false);
    });
});
