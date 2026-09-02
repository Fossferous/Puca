/**
 * The static-CRT flag is a WINDOWS flag (scripts/crtStatic.mjs). Applied on
 * Linux it makes rustc drop proc-macro crates, so serde's derive cannot build
 * and the agent sidecar — the very thing the Linux-enablement work keeps
 * green — fails. These pin the decision the two build scripts share.
 */
import { describe, it, expect } from 'vitest';
import { CRT_STATIC, rustflagsFor, envWithCrtStatic } from '../../scripts/crtStatic.mjs';

describe('crt-static RUSTFLAGS decision', () => {
    it('adds the flag on Windows', () => {
        expect(rustflagsFor('win32', {})).toBe(CRT_STATIC);
    });

    it('APPENDS to an existing RUSTFLAGS on Windows (the vcpkg -L must survive)', () => {
        expect(rustflagsFor('win32', { RUSTFLAGS: '-L C:/vcpkg/lib' })).toBe(`-L C:/vcpkg/lib ${CRT_STATIC}`);
    });

    it('does not double-apply', () => {
        expect(rustflagsFor('win32', { RUSTFLAGS: CRT_STATIC })).toBe(CRT_STATIC);
    });

    it('THE BUG: never adds the flag off Windows — Linux cannot build proc-macros under it', () => {
        expect(rustflagsFor('linux', {})).toBeUndefined();
        expect(rustflagsFor('darwin', {})).toBeUndefined();
        expect(rustflagsFor('linux', { RUSTFLAGS: '-C opt-level=2' })).toBe('-C opt-level=2');
    });

    it('leaves RUSTFLAGS ABSENT from the child environment, not the string "undefined"', () => {
        const env = envWithCrtStatic('linux', { PATH: '/usr/bin' });
        expect('RUSTFLAGS' in env).toBe(false);
        expect(env.PATH).toBe('/usr/bin');
        expect(envWithCrtStatic('win32', { PATH: 'x' }).RUSTFLAGS).toBe(CRT_STATIC);
    });
});
