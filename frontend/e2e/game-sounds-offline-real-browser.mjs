// Do the card table's synthesized sounds render, at a sensible level, in a
// REAL browser's Web Audio - without ever reaching a speaker?
//
// WHY THIS EXISTS. vitest runs under jsdom, which has no Web Audio: the unit
// tests drive the sound player against a fake context that only records what
// would be scheduled. Whether the real graph (noise buffers, biquad filters,
// exponential ramps that throw on a zero target) actually renders, and how
// loud it actually is, only a real engine can say. This bundles the REAL
// synthesis module (src/api/games/gameSynth.ts, esbuild) and renders every
// sound into an OfflineAudioContext: a buffer in memory, never an output
// device. The browser is also launched with --mute-audio, belt and braces.
//
// Checks, per sound, at the game level (gameSounds.ts GAME_SOUND_LEVEL):
//   - it renders without throwing and is not silent (peak > 0.01);
//   - its peak never exceeds the game level by more than the summing margin
//     (several parts of one sound can overlap) and never reaches 0.3, the
//     peak of the app's own join chime;
//   - it is over within its declared length (+ 50 ms): nothing rings on;
// and, as the negative control, the same render at level 0 measures exactly
// 0 - the meter reads the sound, not some floor of its own.
//
//   cd frontend && node e2e/game-sounds-offline-real-browser.mjs
//
// No server and no build needed.
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const bundle = await build({
    entryPoints: [join(here, '..', 'src', 'api', 'games', 'gameSynth.ts')],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'GameSynth',
    platform: 'browser',
});
const moduleSrc = bundle.outputFiles[0].text;

// Must match src/api/games/gameSounds.ts (GAME_SOUND_LEVEL).
const LEVEL = 0.16;

let pass = 0, fail = 0;
const ck = (cond, label, extra = '') => {
    if (cond) { pass++; console.log('PASS', label, extra); }
    else { fail++; console.log('FAIL', label, extra); }
};

const CHANNEL = process.env.CHANNEL || 'msedge';
const browser = await chromium.launch({
    headless: true,
    ...(CHANNEL === 'bundled' ? {} : { channel: CHANNEL }),
    args: ['--mute-audio', '--autoplay-policy=user-gesture-required'],
});
try {
    const page = await (await browser.newContext()).newPage();
    await page.setContent('<!doctype html><meta charset=utf-8><title>game sounds</title><body>offline render</body>');
    await page.addScriptTag({ content: moduleSrc });
    const results = await page.evaluate(async (level) => {
        const out = {};
        const rate = 48000;
        for (const cue of Object.keys(GameSynth.CUE_SECONDS)) {
            const render = async (lv) => {
                const ctx = new OfflineAudioContext(1, Math.ceil(rate * 1.2), rate);
                GameSynth.synthCue(ctx, ctx.destination, cue, 0.05, lv);
                const buf = await ctx.startRendering();
                const d = buf.getChannelData(0);
                let peak = 0, lastLoud = 0, sumSq = 0;
                for (let i = 0; i < d.length; i++) {
                    const a = Math.abs(d[i]);
                    if (a > peak) peak = a;
                    if (a > 0.001) lastLoud = i;
                    sumSq += d[i] * d[i];
                }
                return { peak, endsAt: lastLoud / rate - 0.05, rms: Math.sqrt(sumSq / d.length) };
            };
            try {
                out[cue] = { at: await render(level), silent: await render(0), declared: GameSynth.CUE_SECONDS[cue] };
            } catch (e) {
                out[cue] = { error: String(e) };
            }
        }
        return out;
    }, LEVEL);

    for (const [cue, r] of Object.entries(results)) {
        if (r.error) { ck(false, `${cue}: renders`, r.error); continue; }
        const { peak, endsAt } = r.at;
        ck(peak > 0.01, `${cue}: audible in the render (peak ${peak.toFixed(3)})`);
        ck(peak <= LEVEL * 1.35 && peak < 0.3, `${cue}: peak ${peak.toFixed(3)} stays near the game level ${LEVEL} and under the join chime's 0.3`);
        ck(endsAt <= r.declared + 0.05, `${cue}: over by ${endsAt.toFixed(3)} s (declared ${r.declared} s)`);
        ck(r.silent.peak === 0, `NEGATIVE CONTROL ${cue}: the same render at level 0 is digital silence (the meter is not reading noise)`, r.silent.peak);
    }
} finally {
    await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
