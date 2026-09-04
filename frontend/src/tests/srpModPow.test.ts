import { describe, it, expect } from 'vitest';
import { __testing } from '../api/auth';

/**
 * The blinded Montgomery ladder must return EXACTLY what a plain
 * square-and-multiply returns. Blinding is only sound because
 * g^(e + r(N-1)) = g^e (mod N) for a prime N; if that identity is applied
 * wrongly — wrong modulus, wrong sign, r multiplied by N instead of N-1 —
 * the result is silently a different number, and every login breaks.
 *
 * SECURITY_MODEL.md notes this SRP was "matched to the Rust crate empirically,
 * with no test vector". This does not close that gap (that needs a
 * cross-language vector) but it does close the one this change could open.
 */

/** Deliberately naive reference. Not used in production; exists to disagree. */
function referenceModPow(base: bigint, exp: bigint, mod: bigint): bigint {
    let result = 1n;
    base = base % mod;
    while (exp > 0n) {
        if (exp % 2n === 1n) result = (result * base) % mod;
        exp >>= 1n;
        base = (base * base) % mod;
    }
    return result;
}

const { modPowSecret, modPowPublic, N, g } = __testing;

describe('modPowSecret (blinded ladder)', () => {
    it('agrees with a reference implementation on the real SRP group', () => {
        // Exponents spanning the interesting shapes: tiny, one-bit, full-width,
        // and a realistic 256-bit x.
        const exps = [
            0n,
            1n,
            2n,
            255n,
            (1n << 255n) + 12345n,
            0x94b7555aabe9127cc58ccf4993db6cf84d16c124n,
            N - 2n,
        ];
        for (const e of exps) {
            expect(modPowSecret(g, e, N), `g^${e} mod N`).toBe(referenceModPow(g, e, N));
        }
    });

    it('agrees on random exponents and random bases', () => {
        for (let i = 0; i < 12; i++) {
            const bytes = crypto.getRandomValues(new Uint8Array(32));
            let e = 0n;
            for (const b of bytes) e = (e << 8n) | BigInt(b);
            const base = (g + BigInt(i) * 7919n) % N;
            expect(modPowSecret(base, e, N)).toBe(referenceModPow(base, e, N));
        }
    });

    it('is randomised internally: same inputs, same answer, different work', () => {
        // The point of blinding is that the exponent actually processed differs
        // each call. The OUTPUT must not. Ten calls, one value.
        const e = 0x2b7e151628aed2a6abf7158809cf4f3cn;
        const answers = new Set<string>();
        for (let i = 0; i < 10; i++) answers.add(modPowSecret(g, e, N).toString());
        expect(answers.size, 'blinding must not change the result').toBe(1);
        expect([...answers][0]).toBe(referenceModPow(g, e, N).toString());
    });

    it('POSITIVE CONTROL: the reference disagrees when it should', () => {
        // Without this, every assertion above would also pass if both functions
        // were the same function. Prove the comparison can fail.
        expect(referenceModPow(g, 5n, N)).not.toBe(referenceModPow(g, 6n, N));
        expect(modPowSecret(g, 5n, N)).not.toBe(referenceModPow(g, 6n, N));
    });

    it('modPowPublic still works and matches, for non-secret exponents', () => {
        expect(modPowPublic(g, 65537n, N)).toBe(referenceModPow(g, 65537n, N));
    });
});

describe('the SRP group is what blinding assumes', () => {
    it('N is odd and g is a small generator inside the field', () => {
        // Blinding relies on Fermat: g^(N-1) = 1 (mod N), which needs N prime.
        // A full primality proof does not belong in a unit test, but these are
        // the cheap properties whose failure would mean the constant was
        // corrupted in transit or truncated.
        expect(N % 2n).toBe(1n);
        expect(N > (1n << 2047n)).toBe(true);
        expect(N < (1n << 2048n)).toBe(true);
        expect(g).toBeGreaterThan(1n);
        expect(g).toBeLessThan(N);
    });

    it("Fermat's little theorem holds for this N, which is what makes blinding sound", () => {
        // If this fails, N is not prime and modPowSecret returns wrong answers.
        expect(modPowPublic(g, N - 1n, N)).toBe(1n);
    });
});
