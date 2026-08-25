/**
 * Source-level gate for the clip buffer's core privacy promise: nothing under
 * frontend/src/api/clips/ may reach a file-writing or persistent-storage API.
 * A behavioural test cannot catch "just cache the ring to IndexedDB for
 * reliability" — this one does, and it is the single change that would break
 * the feature's whole premise. See docs/CLIPS.md.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(__dirname, '..', 'api', 'clips');
const files = readdirSync(dir).filter(f => f.endsWith('.ts'));
/** Comments may NAME the banned APIs (the privacy contract does); code may not use them. */
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

// Anything that persists or hands bytes to the OS. `MediaRecorder` is banned
// because Chromium's blob storage can page its output to disk.
const BANNED = [
    /\bMediaRecorder\b/, /\bindexedDB\b/, /\blocalStorage\b/, /\bsessionStorage\b/,
    /\bshowSaveFilePicker\b/, /\bshowOpenFilePicker\b/, /\bgetDirectory\s*\(/, /\bnavigator\.storage\b/,
    /\bsaveAttachment\b/, /\btransfer_write\b/, /\battachment_save\b/, /\bcaches\b/,
];

describe('api/clips never touches disk', () => {
    it('finds the module set (positive control)', () => {
        expect(files).toEqual(expect.arrayContaining(['replayWorker.ts', 'replayBuffer.ts', 'clipRing.ts', 'clipCrypto.ts', 'clipPlayback.ts']));
    });
    for (const f of files) {
        it(`${f} uses no persistence / file API`, () => {
            const src = stripComments(readFileSync(join(dir, f), 'utf8'));
            for (const re of BANNED) expect(src, `${f} matches ${re}`).not.toMatch(re);
        });
    }
    it('`new Blob(` appears only in the viewer-side fallback (clipPlayback.ts) and clipUpload (the request body)', () => {
        for (const f of files) {
            const src = readFileSync(join(dir, f), 'utf8');
            const n = (src.match(/new Blob\(/g) || []).length;
            if (f === 'clipPlayback.ts' || f === 'clipUpload.ts') expect(n).toBeGreaterThan(0);
            else expect(n, `${f} constructs a Blob`).toBe(0);
        }
    });
    it('the ring key is generated NON-extractable', () => {
        const src = readFileSync(join(dir, 'clipCrypto.ts'), 'utf8');
        expect(src).toMatch(/generateKey\(\{ name: 'AES-GCM', length: 256 \}, false,/);
    });
});
