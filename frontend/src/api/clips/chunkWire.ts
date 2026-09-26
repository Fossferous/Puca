/**
 * The page's side of the native clip chunk wire (clip_capture.rs chunk_frame):
 * one raw binary IPC message per encoded access unit, fixed little-endian
 * header then the Annex-B bytes. See the Rust comment for the layout and why
 * it replaced a base64 JSON event.
 *
 * Tested against the same bytes as the Rust encoder (src/tests/chunkWire.test.ts).
 */
export const CHUNK_WIRE_VERSION = 1;
export const CHUNK_HEADER_LEN = 35;

export interface ChunkFrame {
    keyframe: boolean;
    generation: number;
    tsUs: number;
    durUs: number;
    width: number;
    height: number;
    /** The SPS-derived `avc1.PPCCLL` string; present on keyframes. */
    codec?: string;
    /** The Annex-B access unit, in its own buffer (transferable). */
    data: ArrayBuffer;
}

/** Tauri hands a raw message over as an ArrayBuffer (or, for a small one on
 *  some paths, a byte array); accept both. */
function asBuffer(msg: unknown): ArrayBuffer | null {
    if (msg instanceof ArrayBuffer) return msg;
    if (ArrayBuffer.isView(msg)) return msg.buffer.slice(msg.byteOffset, msg.byteOffset + msg.byteLength) as ArrayBuffer;
    if (Array.isArray(msg)) return new Uint8Array(msg as number[]).buffer;
    return null;
}

/** Null for anything that is not a well-formed frame of this version — a
 *  malformed message is dropped, never half-read. */
export function readChunkFrame(msg: unknown): ChunkFrame | null {
    const buf = asBuffer(msg);
    if (!buf || buf.byteLength < CHUNK_HEADER_LEN) return null;
    const v = new DataView(buf);
    if (v.getUint8(0) !== CHUNK_WIRE_VERSION) return null;
    const codecLen = v.getUint8(34);
    const start = CHUNK_HEADER_LEN + codecLen;
    if (buf.byteLength < start) return null;
    const codec = codecLen > 0
        ? String.fromCharCode(...new Uint8Array(buf, CHUNK_HEADER_LEN, codecLen))
        : undefined;
    return {
        keyframe: (v.getUint8(1) & 1) === 1,
        generation: Number(v.getBigUint64(2, true)),
        tsUs: Number(v.getBigUint64(10, true)),
        durUs: Number(v.getBigUint64(18, true)),
        width: v.getUint32(26, true),
        height: v.getUint32(30, true),
        codec,
        data: buf.slice(start),
    };
}
