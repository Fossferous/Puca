/**
 * VALIDATING the remembered screen-share quality.
 *
 * SCOPE, because the first version of this docblock overclaimed and that
 * mattered: every assertion here calls the pure `rememberedQuality` validator
 * with literal objects. It never renders the dialog and never touches
 * localStorage, so it would stay green against a dialog that read the stored
 * value once and then ignored it forever — which is exactly the defect that
 * shipped in 0.9.805. The dialog's actual reading and writing is covered by
 * shareQualityRemembered.test.tsx, which installs a real localStorage because
 * the shared test setup's is a mock that stores nothing.
 *
 * WHY IT MATTERS. The share is encoded in SOFTWARE on every machine this
 * project has logs from (`encoder=OpenH264`), so the resolution and frame rate
 * are not a taste setting — they are the one control a weaker machine has over
 * how much CPU sharing takes away from the game being shared. The dialog used
 * to open on 1080p30 every time, so somebody who turned it down to 720p got
 * 1080p handed back on their very next share, and every share after that.
 *
 * The validation half matters just as much: a stored value is only as
 * trustworthy as the build that wrote it, and a resolution this build no longer
 * offers would leave the dialog with no option highlighted and no way to tell
 * what would actually be captured.
 */
import { describe, it, expect } from 'vitest';

import { rememberedQuality } from '../api/rtc/shareHealth';

describe('the remembered screen-share quality', () => {
    it('gives back exactly what was stored', () => {
        // POSITIVE CONTROL for every rejection case below: a valid stored
        // choice really does survive, so the fallbacks are about validation
        // and not about a function that always returns its defaults.
        expect(rememberedQuality({ shareResolution: '720', shareFps: 15 }))
            .toEqual({ resolution: '720', fps: 15 });
        expect(rememberedQuality({ shareResolution: 'source', shareFps: 60 }))
            .toEqual({ resolution: 'source', fps: 60 });
    });

    it('falls back when the stored value is not one this build offers', () => {
        // '4k' was never an option; '2160' is the kind of thing a future build
        // might add and a downgrade would leave behind.
        expect(rememberedQuality({ shareResolution: '2160', shareFps: 30 }).resolution).toBe('1080');
        expect(rememberedQuality({ shareResolution: '1080', shareFps: 144 }).fps).toBe(30);
    });

    it('falls back on a profile that has no stored value at all', () => {
        // Every install that predates this setting. `undefined` must not
        // become an unselected dialog.
        const q = rememberedQuality({ shareResolution: undefined as unknown as string, shareFps: undefined as unknown as number });
        expect(q).toEqual({ resolution: '1080', fps: 30 });
    });

    it('does not accept a near-miss type', () => {
        // The stored blob is JSON somebody could have hand-edited, and a
        // string '30' would compare unequal to every FPS option while still
        // looking right in the profile.
        expect(rememberedQuality({ shareResolution: 1080 as unknown as string, shareFps: '30' as unknown as number }))
            .toEqual({ resolution: '1080', fps: 30 });
    });
});
