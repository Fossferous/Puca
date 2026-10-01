import { describe, it, expect, afterEach } from 'vitest';
import { cryptoInFlight, trackCrypto } from './fixtures/cryptoInFlight';

let untrack: () => void = () => {};
afterEach(() => untrack());

describe('fixtures/cryptoInFlight', () => {
    it('counts a WebCrypto call while it runs, and not after', async () => {
        untrack = trackCrypto();
        expect(cryptoInFlight()).toBe(0);
        const p = crypto.subtle.digest('SHA-256', new Uint8Array([1, 2, 3]));
        expect(cryptoInFlight()).toBe(1);
        const two = crypto.subtle.digest('SHA-256', new Uint8Array([4]));
        expect(cryptoInFlight()).toBe(2);
        await Promise.all([p, two]);
        expect(cryptoInFlight()).toBe(0);
    });

    it('a refused call is not left counted', async () => {
        untrack = trackCrypto();
        await expect(crypto.subtle.digest('NOT-A-HASH', new Uint8Array([1]))).rejects.toBeTruthy();
        expect(cryptoInFlight()).toBe(0);
    });

    it('the undo puts the methods back, and the answers are the real ones throughout', async () => {
        const own = Object.prototype.hasOwnProperty.call(crypto.subtle, 'digest');
        const real = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array([7])));
        untrack = trackCrypto();
        expect(Object.prototype.hasOwnProperty.call(crypto.subtle, 'digest')).toBe(true);
        expect(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array([7])))).toEqual(real);
        untrack();
        expect(Object.prototype.hasOwnProperty.call(crypto.subtle, 'digest')).toBe(own);
        crypto.subtle.digest('SHA-256', new Uint8Array([7]));
        expect(cryptoInFlight()).toBe(0);
    });
});
