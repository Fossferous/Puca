/**
 * WHAT AUTOMATIC ARMING REALLY RECORDS. Native capture (armNative) never
 * scales frames: it records the monitor at its own resolution and
 * clip_capture.rs::effective_encode_settings folds the extra pixels into a
 * LOWER frame rate and a rescaled bitrate. Settings priced every preset at its
 * label, so "720p 60 fps" read 60 fps while a 1080p monitor recorded 24.
 *
 * clipPresets.ts nativeEncodeEstimate is a TS port of that function. The
 * expected values live in ONE fixture that clip_capture.rs's own test reads
 * too (`the_native_estimate_table_matches_the_frontend_fixture`), so the port
 * and the Rust cannot drift apart without one side going red.
 */
import { describe, it, expect } from 'vitest';
import table from './fixtures/clip-native-encode-table.json';
import { CLIP_PRESETS, clipPreset, effectiveEncodeSettings, nativeEncodeEstimate, scaleBitrate, type ClipPresetId } from '../api/clips/clipPresets';

interface Row { preset: string; fps: number; bitrate: number; assumedW: number; assumedH: number; monitorW: number; monitorH: number; expectFps: number; expectBitrate: number }
const rows = (table as { rows: Row[] }).rows;

describe('nativeEncodeEstimate — the TS port of effective_encode_settings', () => {
    it('the fixture covers every preset and its preset numbers are the ones the app ships', () => {
        expect(new Set(rows.map(r => r.preset))).toEqual(new Set(CLIP_PRESETS.map(p => p.id)));
        for (const r of rows) {
            const p = clipPreset(r.preset);
            expect(p.id).toBe(r.preset as ClipPresetId);
            // replayBuffer.armNative passes exactly these to start_clip_video_capture.
            expect([p.fps, p.videoBitrate, p.maxWidth, p.maxHeight]).toEqual([r.fps, r.bitrate, r.assumedW, r.assumedH]);
        }
    });

    it.each(rows.map(r => [`${r.preset} on ${r.monitorW}x${r.monitorH}`, r] as const))('%s', (_name, r) => {
        const e = nativeEncodeEstimate(clipPreset(r.preset), r.monitorW, r.monitorH);
        expect({ fps: e.fps, videoBitrate: e.videoBitrate }).toEqual({ fps: r.expectFps, videoBitrate: r.expectBitrate });
        expect([e.width, e.height]).toEqual([r.monitorW, r.monitorH]);
        expect(e.reducedFps).toBe(r.expectFps < r.fps);
    });

    it('the measured case clip_capture.rs pins: 1080p60 on 2560x1440 records 30 fps at 8 Mbps', () => {
        expect(effectiveEncodeSettings(60, 9_000_000, 1920 * 1080, 2560 * 1440)).toEqual({ fps: 30, bitrate: 8_000_000 });
    });

    it('the skeptic’s case: the 720p60 preset records at 24 fps on an ordinary 1080p monitor', () => {
        const e = nativeEncodeEstimate(clipPreset('720p60'), 1920, 1080);
        expect(e.fps).toBe(24);
        expect(e.reducedFps).toBe(true);
    });

    it('bytesPerSecond is the effective video plus the preset audio', () => {
        const p = clipPreset('1080p30');
        const e = nativeEncodeEstimate(p, 2560, 1440);
        expect(e.bytesPerSecond).toBe((e.videoBitrate + p.audioBitrate) / 8);
    });

    it('scaleBitrate clamps both ends and survives a zero assumption (same cases as the Rust test)', () => {
        const assumed = 1920 * 1080;
        expect(scaleBitrate(6_000_000, assumed, assumed)).toBe(6_000_000);
        expect(scaleBitrate(4_000_000, assumed, 3840 * 2160)).toBe(16_000_000);
        expect(scaleBitrate(10_000_000, assumed, 3840 * 2160)).toBe(20_000_000);
        expect(scaleBitrate(6_000_000, assumed, 1024 * 768)).toBe(2_275_555);
        expect(scaleBitrate(3_000_000, assumed, 640 * 480)).toBe(1_500_000);
        expect(scaleBitrate(6_000_000, 0, assumed)).toBe(6_000_000);
        expect(scaleBitrate(500_000, 0, assumed)).toBe(1_500_000);
    });

    it('degenerate inputs do not change the cadence (Rust: effective_settings_survive_degenerate_inputs)', () => {
        expect(effectiveEncodeSettings(0, 9_000_000, 1, 4).fps).toBe(0);
        expect(effectiveEncodeSettings(60, 9_000_000, 0, 4).fps).toBe(60);
        // An unknown monitor size (0x0) is not a reason to invent a smaller one.
        const e = nativeEncodeEstimate(clipPreset('1080p30'), 0, 0);
        expect(e.fps).toBe(30);
    });
});
