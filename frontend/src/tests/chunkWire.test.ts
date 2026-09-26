/**
 * The page reads exactly what the shell writes. The hex below is the same as
 * clip_capture.rs `a_keyframe_is_the_documented_bytes` / `a_delta_carries_no_codec`:
 * change the layout on one side only and one of the two suites goes red.
 */
import { describe, it, expect } from 'vitest';
import { readChunkFrame, CHUNK_HEADER_LEN } from '../api/clips/chunkWire';

const hex = (s: string) => {
    const h = s.replace(/\s+/g, '');
    const out = new Uint8Array(h.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
    return out.buffer;
};

describe('the clip chunk wire', () => {
    it('reads a keyframe with its codec string', () => {
        const f = readChunkFrame(hex(
            '01 01 0300000000000000 0201000000000000 3582000000000000 000A0000 A0050000 0B'
            + ' 617663312e363430303333 00000001 65AA',
        ))!;
        expect(f).toMatchObject({ keyframe: true, generation: 3, tsUs: 0x0102, durUs: 33_333, width: 2560, height: 1440, codec: 'avc1.640033' });
        expect([...new Uint8Array(f.data)]).toEqual([0, 0, 0, 1, 0x65, 0xaa]);
    });

    it('reads a delta with no codec', () => {
        const f = readChunkFrame(hex('01 00 0900000000000000 0100000000000000 0200000000000000 80070000 38040000 00 00000141'))!;
        expect(f).toMatchObject({ keyframe: false, generation: 9, tsUs: 1, durUs: 2, width: 1920, height: 1080 });
        expect(f.codec).toBeUndefined();
        expect([...new Uint8Array(f.data)]).toEqual([0, 0, 1, 0x41]);
    });

    it('drops a message it cannot read rather than half-reading it', () => {
        expect(readChunkFrame(new ArrayBuffer(CHUNK_HEADER_LEN - 1))).toBeNull();
        const wrongVersion = new Uint8Array(hex('01 00 0900000000000000 0100000000000000 0200000000000000 80070000 38040000 00 00000141'));
        wrongVersion[0] = 2;
        expect(readChunkFrame(wrongVersion.buffer)).toBeNull();
        // A codec length that runs past the end.
        const short = new Uint8Array(CHUNK_HEADER_LEN); short[0] = 1; short[34] = 20;
        expect(readChunkFrame(short.buffer)).toBeNull();
        expect(readChunkFrame('not bytes')).toBeNull();
    });

    it('accepts a byte view as well as an ArrayBuffer', () => {
        const bytes = new Uint8Array(hex('01 00 0900000000000000 0100000000000000 0200000000000000 80070000 38040000 00 00000141'));
        expect(readChunkFrame(bytes)?.generation).toBe(9);
        expect(readChunkFrame([...bytes])?.generation).toBe(9);
    });
});
