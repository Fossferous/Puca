import { describe, it, expect } from 'vitest';
import { CLIP_PREFIX, MAX_CLIP_PARTS, MAX_HREF_CHARS, clipLabel, decodeClipRef, encodeClipRef, isClipRef, partIndexForTime, partStartMs, type ClipManifest } from '../api/clips/clipRef';

const uuid = (i: number) => `${i.toString(16).padStart(8, '0')}-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;
function manifest(parts: number, overrides: Partial<ClipManifest> = {}): ClipManifest {
    const key = new Uint8Array(32); key.fill(0xab);
    const noncePrefix = new Uint8Array(8); noncePrefix.fill(0xcd);
    return {
        key, noncePrefix,
        clipId: '9f2c1e0a-1234-4abc-8def-0123456789ab',
        videoCodec: 'avc1.640029',
        audioCodec: 'mp4a.40.2',
        durationMs: 124_000, width: 1920, height: 1080, totalCipherBytes: 184_000_000,
        parts: Array.from({ length: parts }, (_, i) => uuid(i + 1)),
        partDurMs: Array.from({ length: parts }, (_, i) => (i === 0 ? 0 : 20_000)),
        ...overrides,
    };
}

describe('clipRef — packed manifest', () => {
    it('round-trips every field', () => {
        const m = manifest(7, { audioCodec: 'opus' });
        const href = encodeClipRef(m);
        expect(isClipRef(href)).toBe(true);
        const d = decodeClipRef(href)!;
        expect(d).not.toBeNull();
        expect(Array.from(d.key)).toEqual(Array.from(m.key));
        expect(Array.from(d.noncePrefix)).toEqual(Array.from(m.noncePrefix));
        expect(d.clipId).toBe(m.clipId);
        expect(d.videoCodec).toBe('avc1.640029');
        expect(d.audioCodec).toBe('opus');
        expect(d.durationMs).toBe(124_000);
        expect(d.width).toBe(1920); expect(d.height).toBe(1080);
        expect(d.totalCipherBytes).toBe(184_000_000);
        expect(d.parts).toEqual(m.parts);
        expect(d.partDurMs).toEqual(m.partDurMs);
    });
    it('64 parts stays under the 2048-char href cap of the message parser', () => {
        const href = encodeClipRef(manifest(MAX_CLIP_PARTS));
        expect(href.length).toBeLessThan(MAX_HREF_CHARS);
        expect(href.length).toBe(1653); // 74 + 18·64 = 1226 B → 1635 b64url chars + 18 prefix ('sovereign-clip:v1?'.length)
        expect(decodeClipRef(href)!.parts.length).toBe(64);
    });
    it('refuses a non-avc video codec', () => {
        expect(() => encodeClipRef(manifest(2, { videoCodec: 'vp09.00.10.08' }))).toThrow(/avc1/);
    });
    it('refuses 65 parts and 0 parts', () => {
        expect(() => encodeClipRef(manifest(65))).toThrow(/part count/);
        expect(() => encodeClipRef(manifest(0))).toThrow(/part count/);
    });
    it('returns null (never throws) on version, length, count and charset violations', () => {
        const href = encodeClipRef(manifest(3));
        const body = href.slice(CLIP_PREFIX.length);
        expect(decodeClipRef('sovereign-enc:abc?k=1')).toBeNull();
        expect(decodeClipRef(CLIP_PREFIX + body.slice(0, 20))).toBeNull();     // truncated
        expect(decodeClipRef(CLIP_PREFIX + body + 'AAAA')).toBeNull();          // trailing garbage
        expect(decodeClipRef(CLIP_PREFIX + '!!!' + body)).toBeNull();           // bad charset
        // flip the version byte (first byte → base64url first char)
        const bytes = Uint8Array.from(atob(body.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - body.length % 4) % 4)), c => c.charCodeAt(0));
        bytes[0] = 2;
        const bad = CLIP_PREFIX + btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        expect(decodeClipRef(bad)).toBeNull();
        expect(isClipRef(null)).toBe(false);
        expect(isClipRef('sovereign-clip:v2?abc')).toBe(false);
    });
    it('quantises part durations to 10 ms and keeps the init part at 0', () => {
        const d = decodeClipRef(encodeClipRef(manifest(3, { partDurMs: [0, 20_005, 1_234] })))!;
        expect(d.partDurMs).toEqual([0, 20_010, 1_230]);
    });
    it('maps playback time to the part that contains it, skipping the init part', () => {
        const m = manifest(4, { partDurMs: [0, 20_000, 20_000, 5_000] });
        expect(partIndexForTime(m, 0)).toBe(1);
        expect(partIndexForTime(m, 19_999)).toBe(1);
        expect(partIndexForTime(m, 20_000)).toBe(2);
        expect(partIndexForTime(m, 44_999)).toBe(3);
        expect(partIndexForTime(m, 999_999)).toBe(3); // past the end clamps to the last part
        expect(partStartMs(m, 1)).toBe(0);
        expect(partStartMs(m, 3)).toBe(40_000);
    });
    it('labels durations mm:ss', () => {
        expect(clipLabel(124_000)).toBe('Clip 2:04');
        expect(clipLabel(59_400)).toBe('Clip 0:59');
    });
});

describe('the scheme is allow-listed for the renderer (Phase 2)', () => {
    it('parseMessage yields ONE link node for a clip ref (red if sovereign-clip is not in SAFE_URL_SCHEMES)', async () => {
        const { parseMessage } = await import('../utils/messageParser');
        const m: ClipManifest = {
            key: new Uint8Array(32).fill(1), noncePrefix: new Uint8Array(8).fill(2), clipId: '0f5b4b1a-6a1c-4d5e-8f2b-1c3d4e5f6a7b',
            videoCodec: 'avc1.640029', audioCodec: 'mp4a.40.2', durationMs: 5000, width: 1920, height: 1080, totalCipherBytes: 1234,
            parts: ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'], partDurMs: [0, 5000],
        };
        const href = encodeClipRef(m);
        const nodes = parseMessage(`[Clip 0:05](${href})`);
        const links = nodes.filter(n => n.type === 'link');
        expect(links).toHaveLength(1);
        expect((links[0] as { href: string }).href).toBe(href);
    });
});
