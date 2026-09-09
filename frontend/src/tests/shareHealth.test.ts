/**
 * Telling somebody their machine cannot keep up with their own screen share.
 *
 * The two halves that can fail silently are pinned here: WHEN it speaks (a
 * warning that fires on every keyframe is one people learn to dismiss), and
 * WHAT it offers (a "make it cheaper" button that makes something more
 * expensive is worse than no button).
 */
import { describe, it, expect } from 'vitest';

import {
    cpuStarved, nextStepDown, starvedOffer, qualityLabel,
    createShareLoadWatch, shareDimensions, stepDownFromCapture,
    CPU_WINDOW, CPU_NEEDED, RES_STEPS, FPS_STEPS,
} from '../api/rtc/shareHealth';

const cpu = { limit: 'cpu' };
const ok = { limit: 'none' };
const bw = { limit: 'bandwidth' };

describe('deciding the encoder is starved', () => {
    it('says nothing until there is a full window to judge on', () => {
        // A share that has only just started has not earned an opinion — the
        // first samples after getDisplayMedia are the least representative
        // ones there are. Every sample here is 'cpu' and it still holds off.
        for (let n = 0; n < CPU_WINDOW; n++) {
            expect(cpuStarved(Array(n).fill(cpu)), `${n} samples`).toBe(false);
        }
        expect(cpuStarved(Array(CPU_WINDOW).fill(cpu))).toBe(true);
    });

    it('tolerates a moment without calling it a problem', () => {
        // A keyframe or a level load starves the encoder for a tick. Two out
        // of five is a machine having a moment.
        expect(cpuStarved([ok, cpu, ok, cpu, ok])).toBe(false);
        expect(cpuStarved([ok, cpu, cpu, cpu, ok])).toBe(true);
        expect(CPU_NEEDED).toBeLessThan(CPU_WINDOW); // else "tolerates" is a lie
    });

    it('judges only the RECENT window, not the whole session', () => {
        // Somebody who was starved ten minutes ago and has since turned the
        // quality down must stop being warned. Old samples ageing out is the
        // whole reason this takes a list rather than a counter.
        const history = [cpu, cpu, cpu, cpu, cpu, ok, ok, ok, ok, ok];
        expect(cpuStarved(history)).toBe(false);
    });

    it('does not mistake a network cap for a CPU one', () => {
        // 'bandwidth' means the LINK is the limit. Telling that person to
        // lower their resolution to spare their CPU is advice about the wrong
        // machine, and the simulcast ladder is the answer to it instead.
        expect(cpuStarved([bw, bw, bw, bw, bw])).toBe(false);
        // Nor an absent field — pre-first-frame samples carry no reason at all.
        expect(cpuStarved([{}, {}, {}, {}, {}])).toBe(false);
    });
});

describe('what to step down to', () => {
    it('walks the resolutions one notch at a time, largest to smallest', () => {
        expect(nextStepDown({ resolution: 'source', fps: 60 })).toEqual({ resolution: '1440', fps: 60 });
        expect(nextStepDown({ resolution: '1440', fps: 60 })).toEqual({ resolution: '1080', fps: 60 });
        expect(nextStepDown({ resolution: '1080', fps: 60 })).toEqual({ resolution: '720', fps: 60 });
    });

    it('never raises the frame rate on the way down', () => {
        // The specific thing a pixels-per-second ladder would have done:
        // 1080p30 costs more per second than 720p60, so the arithmetic would
        // happily have offered somebody MORE frames as a relief measure.
        for (const resolution of RES_STEPS) {
            for (const fps of FPS_STEPS) {
                const to = nextStepDown({ resolution, fps });
                if (to) expect(to.fps, `${resolution}p${fps}`).toBeLessThanOrEqual(fps);
            }
        }
    });

    it('spends the frame rate once the picture is as small as it goes', () => {
        expect(nextStepDown({ resolution: '720', fps: 60 })).toEqual({ resolution: '720', fps: 30 });
        expect(nextStepDown({ resolution: '720', fps: 30 })).toEqual({ resolution: '720', fps: 15 });
    });

    it('runs out honestly rather than looping', () => {
        expect(nextStepDown({ resolution: '720', fps: 15 })).toBeNull();
        // And the offer goes quiet rather than delivering bad news with no
        // action attached.
        expect(starvedOffer({ resolution: '720', fps: 15 })).toBeNull();
    });

    it('still offers a way down from an unrecognised stored value', () => {
        // The profile most likely to hold an odd value is the one that has
        // been changed most — i.e. the machine that is struggling. Refusing
        // to help it because the value is unfamiliar strands exactly the
        // wrong person.
        expect(nextStepDown({ resolution: '2160', fps: 30 })).toEqual({ resolution: '1080', fps: 30 });
        expect(nextStepDown({ resolution: '720', fps: 144 })).toEqual({ resolution: '720', fps: 30 });
    });

    it('always terminates from every reachable starting point', () => {
        // A step-down that cycled would leave the offer permanently on
        // screen. Walk each start to exhaustion under a hard bound.
        for (const resolution of RES_STEPS) {
            for (const fps of FPS_STEPS) {
                let at: { resolution: string; fps: number } | null = { resolution, fps };
                let steps = 0;
                while (at && steps < 20) { at = nextStepDown(at); steps++; }
                expect(at, `${resolution}p${fps} never bottomed out`).toBeNull();
            }
        }
    });
});

describe('what the person actually reads', () => {
    it('names the CPU and the setting it is offering', () => {
        const offer = starvedOffer({ resolution: '1080', fps: 60 });
        expect(offer?.text).toContain('CPU');
        expect(offer?.text).toContain('720p at 60 fps');
        expect(offer?.to).toEqual({ resolution: '720', fps: 60 });
    });

    it('labels Source as a word, not as "sourcep"', () => {
        expect(qualityLabel({ resolution: 'source', fps: 60 })).toBe('Source at 60 fps');
        expect(qualityLabel({ resolution: '1440', fps: 30 })).toBe('1440p at 30 fps');
    });
});

describe('the watch that decides when to speak', () => {
    it('offers exactly once, however long the share goes on', () => {
        // The defect this pins: repeating the offer every three seconds for
        // the rest of a two-hour call. Somebody who declined has answered.
        const watch = createShareLoadWatch();
        let offers = 0;
        for (let i = 0; i < 200; i++) if (watch.add(cpu)) offers++;
        expect(offers).toBe(1);
    });

    it('offers on the tick the window fills, not before', () => {
        const watch = createShareLoadWatch();
        for (let i = 0; i < CPU_WINDOW - 1; i++) {
            expect(watch.add(cpu), `sample ${i + 1}`).toBe(false);
        }
        expect(watch.add(cpu)).toBe(true);
    });

    it('is not advanced by a tick that read nothing', () => {
        // `null` is "the share has no sender to read yet" — between
        // getDisplayMedia and the first publish, or mid-teardown. Counting
        // those as evidence would let a share that never encoded a frame
        // accuse the machine of being too slow.
        const watch = createShareLoadWatch();
        for (let i = 0; i < 50; i++) expect(watch.add(null)).toBe(false);
        for (let i = 0; i < CPU_WINDOW - 1; i++) expect(watch.add(cpu)).toBe(false);
        expect(watch.add(cpu)).toBe(true);
    });

    it('remembers which encoder was in use', () => {
        // 'OpenH264' in the warning is the difference between "this machine is
        // busy" and "this machine is encoding in software".
        const watch = createShareLoadWatch();
        expect(watch.encoder()).toBeUndefined();
        watch.add({ limit: 'cpu', encoder: 'OpenH264' });
        expect(watch.encoder()).toBe('OpenH264');
    });

    it('never offers to a machine that is keeping up', () => {
        // POSITIVE CONTROL for the whole watch: a healthy share must be able
        // to run indefinitely in silence, or the test above proves nothing.
        const watch = createShareLoadWatch();
        for (let i = 0; i < 200; i++) expect(watch.add(ok)).toBe(false);
    });
});

describe('the pixel size each option asks for', () => {
    it('matches what the share dialog has always captured', () => {
        expect(shareDimensions('720')).toEqual({ width: 1280, height: 720 });
        expect(shareDimensions('1080')).toEqual({ width: 1920, height: 1080 });
        expect(shareDimensions('1440')).toEqual({ width: 2560, height: 1440 });
        expect(shareDimensions('source')).toEqual({ width: 3840, height: 2160 });
    });

    it('gives every offered option a size, and never zero', () => {
        // A step-down that landed on a resolution with no mapping would cap
        // the capture at 1080p while the dialog said something else.
        for (const r of RES_STEPS) {
            const d = shareDimensions(r);
            expect(d.width, r).toBeGreaterThan(0);
            expect(d.height, r).toBeGreaterThan(0);
        }
    });

    it('gets smaller at every step down, without exception', () => {
        // The property that makes "Lower it" mean anything. Walk the whole
        // ladder and assert the pixel count strictly decreases.
        let at: { resolution: string; fps: number } | null = { resolution: 'source', fps: 60 };
        let last = Infinity;
        while (at) {
            const d = shareDimensions(at.resolution);
            const cost = d.width * d.height * at.fps;
            expect(cost, `${at.resolution}p${at.fps}`).toBeLessThan(last);
            last = cost;
            at = nextStepDown(at);
        }
    });
});

describe('stepping down from what is ACTUALLY captured', () => {
    it('offers a real reduction to somebody on Source', () => {
        // THE DEFECT THIS PINS, shipped in 0.9.805. Every quality here is a
        // CEILING. "Source" caps at 3840x2160, so on a 1080p monitor the
        // capture is 1920x1080 — and the label-based step down offered
        // "1440p", a ceiling of 2560x1440, ABOVE what was already being
        // captured. Applying it changed nothing, the button said "lowered",
        // and the one-per-share offer was spent. The person was told their
        // share had been lowered while their game kept stuttering.
        const offer = starvedOffer({ resolution: 'source', fps: 60 }, { width: 1920, height: 1080 });
        expect(offer?.to).toEqual({ resolution: '720', fps: 60 });
        expect(offer?.text).toContain('720p');
    });

    it('steps down from the true size on every monitor', () => {
        expect(stepDownFromCapture({ width: 3840, height: 2160 }, { resolution: 'source', fps: 60 })).toEqual({ resolution: '1440', fps: 60 });
        expect(stepDownFromCapture({ width: 2560, height: 1440 }, { resolution: '1440', fps: 60 })).toEqual({ resolution: '1080', fps: 60 });
        expect(stepDownFromCapture({ width: 1920, height: 1080 }, { resolution: '1080', fps: 30 })).toEqual({ resolution: '720', fps: 30 });
    });

    it('always offers something strictly smaller than the capture', () => {
        // The property that makes the button honest: whatever is on screen,
        // the size offered must be below it, or applying it is a no-op.
        for (const [w, h] of [[3840, 2160], [2560, 1440], [1920, 1080], [1920, 1200], [2560, 1080]]) {
            const to = stepDownFromCapture({ width: w, height: h }, { resolution: 'source', fps: 60 });
            expect(to, `${w}x${h}`).not.toBeNull();
            const d = shareDimensions(to!.resolution);
            expect(d.width < w || d.height < h, `${w}x${h} -> ${to!.resolution}`).toBe(true);
        }
    });

    it('spends the frame rate once the capture is already small', () => {
        expect(stepDownFromCapture({ width: 1280, height: 720 }, { resolution: '720', fps: 60 }))
            .toEqual({ resolution: '720', fps: 30 });
        expect(stepDownFromCapture({ width: 1280, height: 720 }, { resolution: '720', fps: 30 }))
            .toEqual({ resolution: '720', fps: 15 });
        expect(stepDownFromCapture({ width: 1280, height: 720 }, { resolution: '720', fps: 15 }))
            .toBeNull();
    });

    it('falls back to the labels when there is no capture to read', () => {
        // POSITIVE CONTROL that the capture path is the one being used above:
        // with no track the old label-based answer still comes out, and it is
        // a DIFFERENT answer for the same input.
        expect(starvedOffer({ resolution: 'source', fps: 60 }, null)?.to)
            .toEqual({ resolution: '1440', fps: 60 });
        expect(starvedOffer({ resolution: 'source', fps: 60 }, { width: 0, height: 0 })?.to)
            .toEqual({ resolution: '1440', fps: 60 });
    });
});

describe('re-arming after a step that was taken', () => {
    it('will speak again after an ACCEPTED step, but not after a decline', () => {
        // The two answers mean opposite things. Declining is an answer;
        // accepting is a request for help that a single step — 12% on a
        // 1366x768 panel, 19% on a 1920x1200 one — may not have satisfied.
        const watch = createShareLoadWatch();
        for (let i = 0; i < CPU_WINDOW; i++) watch.add(cpu);   // first offer spent

        // Declined: silent forever.
        for (let i = 0; i < 50; i++) expect(watch.add(cpu)).toBe(false);

        // Accepted: one more offer, and only after FRESH evidence.
        watch.rearm();
        for (let i = 0; i < CPU_WINDOW - 1; i++) {
            expect(watch.add(cpu), 'must not fire on stale evidence').toBe(false);
        }
        expect(watch.add(cpu)).toBe(true);
    });

    it('re-arming does not resurrect the old window', () => {
        // If rearm kept the samples, the next offer would fire on the very
        // next tick and the step would never get a chance to work.
        const watch = createShareLoadWatch();
        for (let i = 0; i < CPU_WINDOW; i++) watch.add(cpu);
        watch.rearm();
        expect(watch.add(ok)).toBe(false);
        expect(watch.add(ok)).toBe(false);
    });

    it('does not grow without bound over a long share', () => {
        // At one sample every 3 s a three-hour share is 3600 readings, held on
        // a machine that is by definition already short of memory. Only the
        // last window is ever consulted.
        const watch = createShareLoadWatch();
        for (let i = 0; i < 5000; i++) watch.add(ok);
        // Still answers correctly after all that, and on the same schedule as
        // a fresh watch: CPU_NEEDED of the last CPU_WINDOW, so with healthy
        // samples still in the window it fires on the CPU_NEEDED-th bad one —
        // not on a full window of them.
        for (let i = 0; i < CPU_NEEDED - 1; i++) expect(watch.add(cpu)).toBe(false);
        expect(watch.add(cpu)).toBe(true);
    });
});

describe('a frame-rate step must not move the resolution', () => {
    it('keeps the chosen resolution when only the frame rate can go down', () => {
        // THE DEFECT THIS PINS. The fps branch used to return the smallest rung
        // ('720') regardless of what the person had chosen. Share one small
        // window on a big monitor — 1000x600 is under 1280x720 in BOTH axes, so
        // no rung is smaller and the only step left is the frame rate — and the
        // stored RESOLUTION was rewritten to 720p anyway. Every later
        // full-screen share then started at 720p because a step "down" had
        // moved a control the person never touched.
        expect(stepDownFromCapture({ width: 1000, height: 600 }, { resolution: 'source', fps: 60 }))
            .toEqual({ resolution: 'source', fps: 30 });
        expect(stepDownFromCapture({ width: 1000, height: 600 }, { resolution: '1440', fps: 30 }))
            .toEqual({ resolution: '1440', fps: 15 });
    });

    it('still steps the resolution when there IS a smaller one', () => {
        // POSITIVE CONTROL: the branch above must not swallow real resolution
        // steps, or "Lower it" would only ever touch the frame rate.
        expect(stepDownFromCapture({ width: 1920, height: 1080 }, { resolution: 'source', fps: 60 }))
            .toEqual({ resolution: '720', fps: 60 });
    });

    it('the offer through starvedOffer carries the same rule', () => {
        const offer = starvedOffer({ resolution: '1080', fps: 60 }, { width: 1000, height: 600 });
        expect(offer?.to).toEqual({ resolution: '1080', fps: 30 });
    });
});
