/**
 * How many WebCrypto calls are running right now, for tests that skip a
 * product's pauses with fake timers but must still let its real work finish.
 *
 * Sealing and opening list content is WebCrypto, whose promises settle from
 * Node's thread pool on the real event loop. How many loop turns that takes is
 * the machine's business, so a test that counts turns is guessing.
 * tasksViewPasteChecklist's 200-item paste counted them, and with a real
 * millisecond or two added to each encrypt/importKey (2026-10-01) it ran out
 * at 12 of 200 items; the 188 creates still to come then landed in the tests
 * after it. Waiting until this reads 0 is a fact about the work instead.
 *
 * `trackCrypto()` wraps the instance's methods (composing with anything
 * already installed on them) and returns the undo for afterEach. Each install
 * counts on its own: a call still running from an earlier one (a test that
 * ended with WebCrypto out) settles against THAT count, so it can never take
 * the next test's below 0, where a wait for 0 would never end.
 */
const METHODS = [
    'encrypt', 'decrypt', 'sign', 'verify', 'digest', 'generateKey', 'deriveKey',
    'deriveBits', 'importKey', 'exportKey', 'wrapKey', 'unwrapKey',
] as const;

/** The current install's count; a fresh, unwatched one when not tracking. */
let current = { n: 0 };
let restore: (() => void) | null = null;

export function trackCrypto(): () => void {
    restore?.();
    const count = { n: 0 };
    current = count;
    const subtle = globalThis.crypto.subtle as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    const saved: Array<[string, PropertyDescriptor | undefined]> = [];
    for (const m of METHODS) {
        const before = subtle[m];
        if (typeof before !== 'function') continue;
        saved.push([m, Object.getOwnPropertyDescriptor(subtle, m)]);
        Object.defineProperty(subtle, m, {
            configurable: true,
            writable: true,
            value: (...a: unknown[]) => {
                count.n++;
                let p: Promise<unknown>;
                try { p = Promise.resolve(before.apply(subtle, a)); } catch (e) { count.n--; throw e; }
                return p.finally(() => { count.n--; });
            },
        });
    }
    restore = () => {
        for (const [m, d] of saved) {
            if (d) Object.defineProperty(subtle, m, d);
            else delete subtle[m];
        }
        restore = null;
        current = { n: 0 };
    };
    return () => restore?.();
}

/** WebCrypto calls started and not yet settled (0 when not tracking). */
export function cryptoInFlight(): number {
    return current.n;
}
