/**
 * scripts/check-api-url.mjs — the build guard against the 2026-08-03
 * failure (a release built without .env.production silently baked in
 * http://localhost:3000 and stranded every client).
 *
 * Positive control: a real server URL is ACCEPTED, proving the verdict reads
 * the value rather than always failing.
 */
import { describe, it, expect } from 'vitest';
import { verdict, readDotenvValue } from '../../scripts/check-api-url.mjs';

describe('verdict', () => {
    it('accepts a real server URL', () => {
        expect(verdict('https://chat.example.org')).toBeNull();
        expect(verdict('  https://chat.example.org/  ')).toBeNull();
        expect(verdict('http://192.168.1.22:3000')).toBeNull();   // a LAN box is reachable from a handset
    });
    it('refuses missing / empty', () => {
        expect(verdict(undefined)).toMatch(/not set/);
        expect(verdict('')).toMatch(/not set/);
        expect(verdict('   ')).toMatch(/not set/);
    });
    it('refuses this machine, unless a local build is asked for explicitly', () => {
        expect(verdict('http://localhost:3000')).toMatch(/this machine/);
        expect(verdict('http://127.0.0.1:3000')).toMatch(/this machine/);
        expect(verdict('https://localhost')).toMatch(/this machine/);
        expect(verdict('http://localhost:3000', { allowLocal: true })).toBeNull();
    });
    it('refuses a non-URL', () => {
        expect(verdict('chat.example.org')).toMatch(/absolute http/);
    });
});

describe('readDotenvValue', () => {
    it('reads KEY=VALUE, ignoring comments, blanks and quotes', () => {
        const text = [
            '# comment',
            '',
            'VITE_UPDATE_FALLBACK_API=https://other.example.org',
            'VITE_API_URL="https://chat.example.org"',
        ].join('\n');
        expect(readDotenvValue(text, 'VITE_API_URL')).toBe('https://chat.example.org');
        expect(readDotenvValue(text, 'VITE_UPDATE_FALLBACK_API')).toBe('https://other.example.org');
        expect(readDotenvValue(text, 'MISSING')).toBeUndefined();
        expect(readDotenvValue('VITE_API_URL=', 'VITE_API_URL')).toBe('');
    });
});
