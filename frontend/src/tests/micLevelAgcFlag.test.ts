/**
 * Púca must never change a microphone's Windows input level.
 *
 * 2026-09-30: three of the owner's capture endpoints were at exactly 7.8 %
 * (20/255, the floor of WebRTC's input volume controller) and a headset mic
 * had gone nearly silent. Every Púca call asks getUserMedia for
 * autoGainControl (Settings default, noiseFilter.ts getMicConstraints), and
 * Chromium applies the audio processor's input-volume recommendation to the
 * OS endpoint unless the WebRtcAllowInputVolumeAdjustment feature is off
 * (media/webrtc/webrtc_features.cc: "When disabled, any WebRTC Audio
 * Processing Module input volume recommendation is ignored and no adjustment
 * takes place"). Auto gain itself stays: it still evens out the voice
 * digitally, inside the app.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const TAURI = join(__dirname, '..', '..', 'src-tauri');
const args = (file: string): string => {
    const cfg = JSON.parse(readFileSync(join(TAURI, file), 'utf8'));
    return String(cfg.app.windows[0].additionalBrowserArgs ?? '');
};

/** Chromium keeps only the LAST --disable-features on a command line, so the
 *  flag must sit in the one list, not in a second switch that would drop the
 *  first list's features (or be dropped by it). */
function disabledFeatures(a: string): string[][] {
    return [...a.matchAll(/--disable-features=(\S+)/g)].map(m => m[1].split(','));
}

describe.each(['tauri.conf.json', 'tauri.lite.conf.json'])('%s', (file) => {
    it('stops WebView2 from changing the Windows microphone level', () => {
        const lists = disabledFeatures(args(file));
        expect(lists).toHaveLength(1);
        expect(lists[0]).toContain('WebRtcAllowInputVolumeAdjustment');
    });

    it('keeps the features it already disabled', () => {
        expect(disabledFeatures(args(file))[0]).toEqual(expect.arrayContaining(['msWebOOUI', 'msPdfOOUI']));
    });
});

it('Full and Lite start WebView2 with the same arguments', () => {
    expect(args('tauri.lite.conf.json')).toBe(args('tauri.conf.json'));
});

it('positive control: the reader sees the real switch', () => {
    expect(args('tauri.conf.json')).toContain('--autoplay-policy=no-user-gesture-required');
    expect(disabledFeatures('--disable-features=A,B --x --disable-features=C')).toEqual([['A', 'B'], ['C']]);
});
