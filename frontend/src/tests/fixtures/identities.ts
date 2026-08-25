/**
 * Cached test identities.
 *
 * `deriveIdentity` runs PBKDF2-SHA256 at 210_000 iterations in pure JS (noble),
 * which measures ~380ms per call on this machine. Suites that mint an identity
 * per test were paying that repeatedly — the worst tests made three calls and
 * sat at ~1.5s idle, which is inside the 5s default testTimeout with no margin.
 * Under parallel vitest workers plus other CPU load (a concurrent `cargo
 * build`) they crossed 5s and the suite failed a different random subset each
 * run. That is a gate people learn to re-run instead of read.
 *
 * `deriveIdentity(password, salt)` is a pure deterministic function — the same
 * inputs always produce the same 32-byte scalar — so memoising it returns
 * byte-identical results to calling it again. Callers get the SAME object, so
 * treat an Identity as immutable: nothing in `api/e2ee` mutates one, and a test
 * that wrote through `privateKey` would poison every later test in its file.
 *
 * Scope, deliberately: this caches identities used as FIXTURES. Tests that
 * assert something ABOUT derivation itself — that it is deterministic, that a
 * different password or salt gives a different key — must keep calling the real
 * `deriveIdentity`, or they would only be testing this Map. See the
 * `identity derivation` block in e2ee.test.ts, which is left untouched.
 *
 * The cache is module-level, and vitest isolates the module registry per test
 * file, so it never leaks between files.
 */
import { deriveIdentity, type Identity } from '../../api/e2ee';

/** A (password, srpSaltHex) pair — the full input to `deriveIdentity`. */
export type IdentitySpec = readonly [password: string, saltHex: string];

const cache = new Map<string, Promise<Identity>>();

/**
 * Drop-in replacement for `deriveIdentity` in tests that just need *an*
 * identity. Caches the promise, not the value, so concurrent callers of the
 * same spec share one derivation instead of racing two.
 */
export function testIdentity(password: string, saltHex: string): Promise<Identity> {
    const key = `${password}\u0000${saltHex}`; // NUL separator: no password can forge another spec's key
    let hit = cache.get(key);
    if (!hit) {
        hit = deriveIdentity(password, saltHex);
        cache.set(key, hit);
    }
    return hit;
}

/**
 * Warm every identity a file needs, up front. Call from `beforeAll` with a
 * generous hook timeout: this is the one genuinely KDF-bound step, and paying
 * it here keeps the individual tests on the strict default timeout, where a
 * real performance regression still goes red.
 */
export async function warmIdentities(specs: readonly IdentitySpec[]): Promise<void> {
    await Promise.all(specs.map(([password, salt]) => testIdentity(password, salt)));
}

/**
 * Budget for a `beforeAll` that warms identities: enough headroom for a dozen
 * 210k-iteration KDFs on a loaded machine, and still low enough that a genuine
 * hang fails the run instead of hanging CI.
 */
export const WARM_TIMEOUT_MS = 60_000;
