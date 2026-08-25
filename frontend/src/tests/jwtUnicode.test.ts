/**
 * JWT payloads carry names, and names have accents.
 *
 * THE BUG: `JSON.parse(atob(part))` gets two things wrong.
 *
 *  1. `atob` returns a BINARY string — one character per byte. The UTF-8 for
 *     "ó" is 0xC3 0xB3, so it comes out as the two Latin-1 characters "Ã³" and
 *     "Brónach" renders "BrÃ³nach". Reported from the field: the name looked
 *     right in messages (fetch decodes UTF-8 properly) and wrong on the
 *     profile, which reads it from the token.
 *  2. JWT parts are base64URL — `-` and `_` instead of `+` and `/` — which
 *     plain `atob` rejects outright, and unpadded, which some engines reject.
 */
import { describe, it, expect } from 'vitest';
import { decodeJwtPayload } from '../api/auth';

/** Build a real base64url JWT payload segment, the way a server would. */
function makeToken(payload: object): string {
    const json = JSON.stringify(payload);
    const bytes = new TextEncoder().encode(json);          // real UTF-8
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    const b64url = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return `header.${b64url}.signature`;
}

describe('decodeJwtPayload handles real names', () => {
    it('round-trips the name that was breaking (ó)', () => {
        const token = makeToken({ sub: 7, username: 'Brónach' });
        const p = decodeJwtPayload(token);
        expect(p?.username).toBe('Brónach');
        // The exact mojibake that was rendering.
        expect(p?.username).not.toBe('BrÃ³nach');
    });

    it('handles accents, non-Latin scripts and emoji', () => {
        for (const name of ['Émilie', 'Þórunn', 'Ægir', 'Дмитрий', '田中', 'Ola🌊']) {
            const p = decodeJwtPayload(makeToken({ sub: 1, username: name }));
            expect(p?.username).toBe(name);
        }
    });

    /**
     * The old implementation's other failure: base64url. A payload encoding
     * that yields `-` or `_` was rejected by plain atob, so the whole token
     * failed to parse and the app fell back to "no user".
     */
    it('accepts base64url payloads containing - and _', () => {
        // Search for a payload whose base64url form actually uses both.
        let token = '';
        for (let i = 0; i < 500 && !token; i++) {
            const t = makeToken({ sub: i, username: `user~${i}?ÿ` });
            const seg = t.split('.')[1];
            if (seg.includes('-') && seg.includes('_')) token = t;
        }
        expect(token).not.toBe('');            // the case is reachable
        expect(decodeJwtPayload(token)).not.toBeNull();
    });

    it('survives an unpadded payload', () => {
        const token = makeToken({ sub: 1, username: 'ab' });   // stripped '=' above
        expect(decodeJwtPayload(token)?.sub).toBe(1);
    });

    it('returns null rather than throwing on junk', () => {
        expect(decodeJwtPayload('not-a-jwt')).toBeNull();
        expect(decodeJwtPayload('a.!!!!.c')).toBeNull();
        expect(decodeJwtPayload('')).toBeNull();
    });

    /**
     * ANTI-VACUITY: prove the old implementation really did fail these, so the
     * tests above are not just restating whatever the code happens to do.
     */
    it('the OLD decoder mangles the same token — so these assertions bite', () => {
        const token = makeToken({ sub: 7, username: 'Brónach' });
        const oldWay = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
        expect(oldWay.username).toBe('BrÃ³nach');       // the reported symptom
        expect(oldWay.username).not.toBe('Brónach');
    });
});
