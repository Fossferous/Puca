/**
 * The phone-side path jail — the JS port of the agent's pinning tests
 * (crates/puca-agent/src/file_transfer.rs), because a jail whose rules
 * drift from the one it mirrors is two different security policies wearing
 * one name. Every "must refuse" here has a positive-control sibling proving
 * the rig can also allow — a resolve() that refused everything would pass
 * the refusal tests and be worthless.
 */
import { describe, it, expect } from 'vitest';
import { resolveLexical, isWithin, resolveJailed, type FsProvider } from '../api/devices/fsJail';

const ROOT = '/storage/emulated/0/Download';

describe('lexical gate', () => {
    it('a relative path lands under the root', () => {
        expect(resolveLexical(ROOT, 'notes.txt')).toBe(`${ROOT}/notes.txt`);
        expect(resolveLexical(ROOT, 'sub/notes.txt')).toBe(`${ROOT}/sub/notes.txt`);
    });

    it('dot-dot cannot climb out of the root', () => {
        for (const attempt of ['../secrets.txt', 'sub/../../secrets.txt', './../../s.txt']) {
            expect(resolveLexical(ROOT, attempt), attempt).toBeNull();
        }
    });

    it('dot-dot INSIDE the root is still allowed (positive control)', () => {
        expect(resolveLexical(ROOT, 'sub/../notes.txt')).toBe(`${ROOT}/notes.txt`);
    });

    it('an absolute path outside the root is refused, inside is allowed', () => {
        expect(resolveLexical(ROOT, '/data/data/com.sovereign.app/secrets')).toBeNull();
        expect(resolveLexical(ROOT, `${ROOT}/notes.txt`)).toBe(`${ROOT}/notes.txt`);
    });

    it('a sibling sharing the root as a STRING prefix is refused', () => {
        // '/…/Download-evil' starts with '/…/Download' as a string but is not
        // under it — the comparison must be component-wise. Pinned so nobody
        // "optimises" it into startsWith.
        expect(resolveLexical(ROOT, `${ROOT}-evil/loot.txt`)).toBeNull();
    });

    it('is case-SENSITIVE — folding would open a hole on ext4', () => {
        expect(resolveLexical(ROOT, ROOT.toUpperCase() + '/x')).toBeNull();
        expect(isWithin(`${ROOT}/x`, ROOT)).toBe(true);
    });

    it('refuses NUL bytes and non-absolute roots', () => {
        expect(resolveLexical(ROOT, 'a\0b')).toBeNull();
        expect(resolveLexical('not-absolute', 'x')).toBeNull();
    });

    it('denies the Android/data|obb shape ANYWHERE, whatever the grant', () => {
        const storageRoot = '/storage/emulated/0';
        expect(resolveLexical(storageRoot, 'Android/data/com.bank/files')).toBeNull();
        expect(resolveLexical(storageRoot, 'android/obb')).toBeNull();
        // Absolute, not grant-relative: even a grant OF …/Android must not
        // serve its data/ children — that is the OS-guarded sandbox tree, and
        // the grant-relative version of this check had exactly that hole.
        expect(resolveLexical(`${storageRoot}/Android`, 'data/x')).toBeNull();
        // Positive control: 'Android' alone (or a name merely containing it)
        // is not the shape — only the component PAIR is refused.
        expect(resolveLexical(`${storageRoot}/MyAndroidStuff`, 'data/x'))
            .toBe(`${storageRoot}/MyAndroidStuff/data/x`);
        expect(resolveLexical(`${storageRoot}/Android`, 'media/x'))
            .toBe(`${storageRoot}/Android/media/x`);
    });
});

describe('canonical gate', () => {
    const provider = (canon: (p: string) => string): FsProvider => ({
        stat: async () => ({ exists: true, is_dir: false, size: 0 }),
        readdir: async () => [],
        read: async () => '',
        writeReplace: async () => {},
        append: async () => {},
        canonicalize: async p => canon(p),
    });

    it('a path that canonicalises OUT of the jail is refused', async () => {
        // The symlink case: lexically inside, actually /sdcard/../ elsewhere.
        const p = provider(() => '/data/data/com.other/loot');
        expect(await resolveJailed(p, ROOT, ROOT, 'link/notes.txt')).toBeNull();
    });

    it('a path that canonicalises INSIDE stays allowed (positive control)', async () => {
        const p = provider(x => x);
        expect(await resolveJailed(p, ROOT, ROOT, 'notes.txt')).toBe(`${ROOT}/notes.txt`);
    });

    it('a canonicalize failure is a refusal, not a pass-through', async () => {
        const p = provider(() => { throw new Error('EACCES'); });
        expect(await resolveJailed(p, ROOT, ROOT, 'notes.txt')).toBeNull();
    });
});
