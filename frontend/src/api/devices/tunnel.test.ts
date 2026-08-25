import { describe, it, expect } from 'vitest';
import { base64ToBytes, bytesToBase64, loopbackOnlyPolicy } from './tunnel';

describe('tunnel frame base64 bridge', () => {
    // These helpers carry every forwarded byte across the Tauri command
    // boundary. They must be exactly lossless: a single wrong byte corrupts
    // someone's RDP or SSH stream in a way that looks like a network fault.

    it('round-trips an empty frame', () => {
        expect(base64ToBytes(bytesToBase64(new Uint8Array(0)))).toEqual(new Uint8Array(0));
    });

    it('round-trips every possible byte value', () => {
        // 0x00 and 0xFF are where naive string conversions lose data.
        const all = new Uint8Array(256);
        for (let i = 0; i < 256; i++) all[i] = i;
        expect(base64ToBytes(bytesToBase64(all))).toEqual(all);
    });

    it('round-trips a full-size pump frame', () => {
        // A frame one byte past the internal chunk boundary, so the seam between
        // chunks is exercised rather than only whole chunks.
        //
        // HONEST SCOPE: this does NOT prove the chunking is necessary. A naive
        // String.fromCharCode(...bytes) spread passes every test here, because
        // V8's argument limit is above the pump's 32 KiB frame size. The
        // chunking is defensive for engines with a lower limit (WebKitGTK on
        // Linux); this test proves LOSSLESSNESS at realistic sizes, which is a
        // different and still worthwhile claim.
        const size = 32 * 1024 + 1;
        const frame = new Uint8Array(size);
        for (let i = 0; i < size; i++) frame[i] = (i * 31 + 7) & 0xff;
        const back = base64ToBytes(bytesToBase64(frame));
        expect(back.length).toBe(size);
        expect(back).toEqual(frame);
    });

    it('round-trips a payload spanning several internal chunks', () => {
        const size = 0x8000 * 3 + 123; // three CHUNKs plus a remainder
        const frame = new Uint8Array(size);
        for (let i = 0; i < size; i++) frame[i] = (i % 251) & 0xff;
        expect(base64ToBytes(bytesToBase64(frame))).toEqual(frame);
    });

    it('produces standard base64 the Rust side decodes', () => {
        // Pinned against a known vector so an encoder change that is
        // self-consistent (encode/decode agree) but NOT standard base64 still
        // fails — Rust decodes with the STANDARD engine.
        expect(bytesToBase64(new Uint8Array([0x01, 0x02, 0x03]))).toBe('AQID');
        expect(bytesToBase64(new Uint8Array([0xff, 0xfe]))).toBe('//4=');
        expect(Array.from(base64ToBytes('AQID'))).toEqual([1, 2, 3]);
    });
});

describe('tunnel policy defaults', () => {
    it('the loopback-only policy grants nothing beyond loopback', () => {
        // The UI hands this to the host when forwarding is switched on. If it
        // ever widened, enabling "forward a port" would silently also expose the
        // host's LAN — the exact thing the allowlist exists to prevent.
        const p = loopbackOnlyPolicy();
        expect(p.enabled).toBe(true);
        expect(p.allowed).toHaveLength(2);
        expect(p.allowed.map((r) => r.base).sort()).toEqual(['127.0.0.0', '::1']);
        const v4 = p.allowed.find((r) => r.base === '127.0.0.0');
        expect(v4?.prefix).toBe(8);
        const v6 = p.allowed.find((r) => r.base === '::1');
        expect(v6?.prefix).toBe(128);
        // Not armed for an elevated host: that takes a second, separate decision.
        expect(p.armed_for_elevated).toBeUndefined();
    });
});
