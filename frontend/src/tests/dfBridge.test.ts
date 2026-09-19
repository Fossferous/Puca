/**
 * The RNNoise bridge's alignment rests on one number read out of a library:
 * RNNOISE_WORKLET_LATENCY (rnnoiseNode.ts), derived from
 * @sapphi-red/web-noise-suppressor 0.4.0's processor. A different version may
 * frame differently, and a wrong latency turns every DeepFilter <-> bridge
 * swap into a small time jump that no test here would notice. So an upgrade
 * fails THIS test on purpose: re-derive the latency from the new
 * processor.ts, update both numbers, and move on.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RNNOISE_WORKLET_LATENCY } from '../api/rnnoiseNode';

describe('RNNoise bridge alignment', () => {
    it('is derived for the library version actually installed', () => {
        const pkg = JSON.parse(readFileSync(
            resolve(process.cwd(), 'node_modules/@sapphi-red/web-noise-suppressor/package.json'), 'utf8',
        )) as { version: string };
        expect(pkg.version).toBe('0.4.0');
        expect(RNNOISE_WORKLET_LATENCY).toBe(992);
    });

    it('matches the processor the library ships, plus RNNoise\'s own frame', () => {
        // The minified processor reads `(input + 1280) % 1920`, i.e. 640
        // behind the position after this quantum's write, which is 512
        // behind the quantum's first sample. RNNoise's overlap-add adds one
        // 480-sample frame on top; that part lives in the wasm, so it is
        // proved by e2e/df-bridge-verify.mjs, not readable here.
        const src = readFileSync(resolve(process.cwd(),
            'node_modules/@sapphi-red/web-noise-suppressor/dist/rnnoise/workletProcessor.js'), 'utf8');
        expect(src).toMatch(/r=1920/);
        expect(src).toMatch(/\(a\+1280\)%r/);
        expect(src).toMatch(/frameSize!==480/);
        expect((1920 - 1280 - 128) + 480).toBe(RNNOISE_WORKLET_LATENCY);
    });
});
