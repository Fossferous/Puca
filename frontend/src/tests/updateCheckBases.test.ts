import { describe, it, expect, vi, afterEach } from 'vitest';
import { updateCheckBases, updateFallbackBase } from '../api/updateCheckBases';

/**
 * The self-heal-of-last-resort for mis-built clients (the 0.8.24/25
 * stranding): when a fallback is configured, update checks end at it whatever
 * the build baked in — while a CORRECT build must not double-query.
 *
 * The fallback is now build-time config (VITE_UPDATE_FALLBACK_API) rather than
 * a hardcoded domain, so these stub it. The unset case is a first-class
 * scenario, not an edge case: it is what a fresh clone of this public repo
 * does, and it must degrade to "try the configured base only" rather than
 * inventing a host.
 */
const FALLBACK = 'https://chat.fallback-host.test';

afterEach(() => { vi.unstubAllEnvs(); });

describe('updateCheckBases — with a fallback configured', () => {
    it('falls back after a localhost-baked base', () => {
        vi.stubEnv('VITE_UPDATE_FALLBACK_API', FALLBACK);
        expect(updateCheckBases('http://localhost:3000')).toEqual([
            'http://localhost:3000',
            FALLBACK,
        ]);
    });

    it('tries the configured base FIRST — self-hosted overrides stay primary', () => {
        vi.stubEnv('VITE_UPDATE_FALLBACK_API', FALLBACK);
        const bases = updateCheckBases('https://chat.example.org');
        expect(bases[0]).toBe('https://chat.example.org');
        expect(bases[1]).toBe(FALLBACK);
    });

    it('does not double-query a correctly built client', () => {
        vi.stubEnv('VITE_UPDATE_FALLBACK_API', FALLBACK);
        expect(updateCheckBases(FALLBACK)).toEqual([FALLBACK]);
    });
});

describe('updateCheckBases — with NO fallback configured', () => {
    it('reports no fallback', () => {
        vi.stubEnv('VITE_UPDATE_FALLBACK_API', '');
        expect(updateFallbackBase()).toBe('');
    });

    it('tries the configured base and nothing else', () => {
        vi.stubEnv('VITE_UPDATE_FALLBACK_API', '');
        expect(updateCheckBases('https://chat.example.org')).toEqual([
            'https://chat.example.org',
        ]);
    });

    it('never appends an empty base — a "" entry would be requested as a relative URL', () => {
        vi.stubEnv('VITE_UPDATE_FALLBACK_API', '');
        for (const b of updateCheckBases('http://localhost:3000')) {
            expect(b).not.toBe('');
        }
    });
});
