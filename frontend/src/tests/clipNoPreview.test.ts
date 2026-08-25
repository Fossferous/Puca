/**
 * Source-level gate for WHEN the clipper may see the footage (docs/CLIPS.md).
 *
 * The rule: nobody — not even the clipper — decodes a frame before every call
 * participant has approved. After approval the clipper reviews + trims, then
 * posts. v0.8.100 removed ALL preview to close the pre-approval gap; this
 * version restores it strictly behind the `approved` phase, so the guard has
 * to pin the GATE, not the mere absence of a <video>.
 *
 * Checked here:
 *  1. The composer's <video> and attachPreview() call live ONLY inside the
 *     `phase === 'approved'` render branch / the effect keyed on that phase.
 *     (A <video> in the `sealed`/`pending` branches would be the regression.)
 *  2. The only transitions INTO 'approved' are (a) a proposal the server
 *     returned already-approved (solo) and (b) the bus reporting
 *     outgoingStatus === 'approved' — i.e. the server's word, never a local
 *     decision.
 *  3. No module other than the composer ever calls attachPreview (a sweep,
 *     not a single-file grep). Trim's "can only shrink" property is a
 *     behavioural test against the real muxer in clipTrimRemux.test.ts.
 *
 * Every regex is positive-controlled below so a reintroduction goes red.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const composerPath = join(__dirname, '..', 'components', 'ClipComposerModal.tsx');
/** Comments may DESCRIBE the <video> (the file header does); only JSX counts. */
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const src = () => stripComments(readFileSync(composerPath, 'utf8'));
/** A real JSX <video ...> element (any attribute order), not the word in prose —
 *  comments are stripped first, and the composer has no `<video` in copy. */
const VIDEO_EL = /<video\b/g;

/** Concatenate EVERY `{phase === 'X' && (` render branch for that phase, each
 *  sliced up to the next branch of any phase. The `&&` distinguishes a branch
 *  from a ternary in copy (the standing line reads `phase === 'approved' ? …`).
 *  A phase may have several branches (`approved` renders a terminal-copy
 *  branch and the review branch). */
function renderBranch(code: string, phase: string): string {
    const open = new RegExp(`\\{phase === '${phase}' &&`, 'g');
    let out = '';
    for (const m of code.matchAll(open)) {
        const rest = code.slice(m.index! + 1);
        const next = rest.search(/\{phase === '[a-z]+' &&|\{\(phase === '[a-z]+' \|\|/);
        out += next < 0 ? rest : rest.slice(0, next);
    }
    return out;
}

function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (/\.(tsx?|mjs|js)$/.test(name)) out.push(p);
    }
    return out;
}

describe('clip preview is gated on approval (docs/CLIPS.md)', () => {
    it('the <video> and attachPreview appear in the approved branch and NOWHERE before it', () => {
        const code = src();
        // Exactly one JSX <video>, and it is inside the approved render branch.
        const approved = renderBranch(code, 'approved');
        expect(approved).toMatch(VIDEO_EL);
        expect((code.match(VIDEO_EL) ?? []).length).toBe(1);
        // None of the pre-approval branches render one.
        for (const pre of ['choose', 'sealing', 'sealed', 'proposing', 'pending']) {
            expect(renderBranch(code, pre), `a <video> in the '${pre}' branch`).not.toMatch(VIDEO_EL);
        }
        // The attach effect is keyed on the approved phase.
        expect(code).toMatch(/if \(phase !== 'approved' \|\| !videoRef\.current\) return;\s*\n\s*setPreviewState\('loading'\);\s*\n\s*const \{ ready, detach \} = attachPreview\(/);
        expect((code.match(/attachPreview\(/g) ?? []).length).toBe(1); // exactly one call site (the import is `attachPreview,` without a paren)
    });

    it("the only ways into 'approved' are the server's word: a solo (already-approved) proposal or the bus reporting approved", () => {
        const code = src();
        const sets = [...code.matchAll(/setPhase\('approved'\)/g)].length;
        expect(sets).toBe(2);
        expect(code).toMatch(/if \(out\.status === 'approved'\) \{[\s\S]*?setPhase\('approved'\);/);
        expect(code).toMatch(/if \(outgoingStatus === 'approved'\) setPhase\('approved'\);/);
        // and nothing jumps from pending straight to uploading any more
        expect(code).not.toMatch(/if \(outgoingStatus === 'approved'\) void uploadAndPost/);
    });

    it('the replay worker has no pre-seal/pre-approval decode path beyond preview + trim', () => {
        const worker = readFileSync(join(__dirname, '..', 'api', 'clips', 'replayWorker.ts'), 'utf8');
        // preview/trim exist (restored) — and both operate on `sealed` only,
        // never on the live ring, so the worker cannot leak un-sealed footage.
        expect(worker).toMatch(/async function preview\(seq: number\)/);
        expect(worker).toMatch(/async function trimSealed\(/);
        const previewBody = worker.slice(worker.indexOf('async function preview(seq: number)'), worker.indexOf('async function trimSealed('));
        expect(previewBody).not.toMatch(/\bring\b\.\w|this\.gops|ring!\./);
        const trimBody = worker.slice(worker.indexOf('async function trimSealed('), worker.indexOf('async function upload('));
        expect(trimBody).not.toMatch(/\bring\b\.\w|this\.gops|ring!\./);
        expect(trimBody).toMatch(/trimSealedParts\(/); // re-mux under fresh secrets (clipTrim.ts), not "relist a subset of the parts"
    });

    it('attachPreview is called from the composer and nowhere else (sweep of src/)', () => {
        const root = join(__dirname, '..');
        const callers = walk(root)
            .filter(p => !/[\\/]tests[\\/]/.test(p))
            .filter(p => /attachPreview\(/.test(stripComments(readFileSync(p, 'utf8'))))
            .map(p => p.slice(root.length + 1).replace(/\\/g, '/'))
            .sort();
        expect(callers).toEqual(['api/clips/replayBuffer.ts', 'components/ClipComposerModal.tsx']);
    });

    it('(positive control) the branch slicer actually finds the branches it is asked for', () => {
        const code = src();
        expect(renderBranch(code, 'approved').length).toBeGreaterThan(100);
        expect(renderBranch(code, 'pending').length).toBeGreaterThan(100);
        expect(renderBranch(code, 'nonexistent')).toBe('');
        // and it sees BOTH approved branches (terminal copy + review), else the
        // <video> count below could be satisfied by the wrong one
        expect((code.match(/\{phase === 'approved' &&/g) ?? []).length).toBe(2);
        // VIDEO_EL matches a real element regardless of attribute order
        expect('<video className="x" ref={r} />').toMatch(VIDEO_EL);
        expect('a <video> in prose').toMatch(VIDEO_EL); // which is why comments are stripped first
    });
});
