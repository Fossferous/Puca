/**
 * The page's side of the native clip desktop-audio wire
 * (clip_audio_wire.rs audio_frame / AudioBatcher): one raw binary IPC message
 * per ~100 ms of WASAPI loopback audio — a fixed little-endian header, a table
 * of the WASAPI packets it holds (their frames, and how long before the send
 * each was read), then the samples PLANAR, or no samples at all for a run of
 * packets Windows flagged silent. See the Rust module for the layout and why
 * it replaced a base64 JSON event per 10 ms packet.
 *
 * Tested against the same bytes as the Rust encoder
 * (src/tests/fixtures/clip-audio-wire.json, read by src/tests/audioWire.test.ts).
 */
import { asBuffer } from './chunkWire';

export const AUDIO_WIRE_VERSION = 1;
/** The fixed part of the header; the packet table follows it. */
export const AUDIO_HEADER_LEN = 24;
export const AUDIO_PACKET_ENTRY_LEN = 8;
const FLAG_SILENT = 1;
/** Bounds a well-formed message stays inside. A header outside them is a
 *  message this reader does not understand, dropped whole. createBuffer
 *  supports at least 32 channels and 3-768 kHz; ten seconds and 1000
 *  packets are far past any batch the shell sends (~100 ms, ~10 packets). */
const MAX_CHANNELS = 32;
const MIN_RATE = 3000, MAX_RATE = 768_000;
const MAX_SECONDS = 10;
const MAX_PACKETS = 1000;

export interface AudioPacket {
    /** Frames (per channel) of this WASAPI packet, in capture order. */
    frames: number;
    /** µs between the shell reading this packet and sending the message. */
    ageUs: number;
}

export interface AudioFrame {
    /** A run of WASAPI-silent packets: no samples, `frames` of silence. */
    silent: boolean;
    generation: number;
    sampleRate: number;
    channels: number;
    /** Frames (per channel) this message stands for — sound or silence. */
    frames: number;
    /** The WASAPI packets it holds, in order; their frames sum to `frames`. */
    packets: AudioPacket[];
    /** One view per channel, `frames` long (null when silent). Views of the
     *  message itself on a little-endian host, so copyToChannel copies once. */
    planar: Float32Array<ArrayBuffer>[] | null;
}

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/** Null for anything that is not a well-formed message of this version — a
 *  malformed message is dropped, never half-read. */
export function readAudioFrame(msg: unknown): AudioFrame | null {
    const buf = asBuffer(msg);
    if (!buf || buf.byteLength < AUDIO_HEADER_LEN) return null;
    const v = new DataView(buf);
    if (v.getUint8(0) !== AUDIO_WIRE_VERSION) return null;
    const silent = (v.getUint8(1) & FLAG_SILENT) !== 0;
    const sampleRate = v.getUint32(10, true);
    const channels = v.getUint16(14, true);
    const frames = v.getUint32(16, true);
    const n = v.getUint32(20, true);
    if (channels < 1 || channels > MAX_CHANNELS) return null;
    if (sampleRate < MIN_RATE || sampleRate > MAX_RATE) return null;
    if (frames < 1 || frames > sampleRate * MAX_SECONDS) return null;
    if (n < 1 || n > MAX_PACKETS || n > frames) return null;
    const at = AUDIO_HEADER_LEN + AUDIO_PACKET_ENTRY_LEN * n;
    const payload = silent ? 0 : channels * frames * 4;
    if (buf.byteLength !== at + payload) return null;
    const packets: AudioPacket[] = [];
    let sum = 0;
    for (let k = 0; k < n; k++) {
        const pf = v.getUint32(AUDIO_HEADER_LEN + AUDIO_PACKET_ENTRY_LEN * k, true);
        if (pf < 1) return null;
        sum += pf;
        packets.push({ frames: pf, ageUs: v.getUint32(AUDIO_HEADER_LEN + AUDIO_PACKET_ENTRY_LEN * k + 4, true) });
    }
    if (sum !== frames) return null;
    let planar: Float32Array<ArrayBuffer>[] | null = null;
    if (!silent) {
        planar = [];
        for (let ch = 0; ch < channels; ch++) {
            const off = at + ch * frames * 4;
            if (LITTLE_ENDIAN) {
                planar.push(new Float32Array(buf, off, frames));
            } else {
                const plane = new Float32Array(frames);
                for (let i = 0; i < frames; i++) plane[i] = v.getFloat32(off + i * 4, true);
                planar.push(plane);
            }
        }
    }
    return {
        silent,
        generation: Number(v.getBigUint64(2, true)),
        sampleRate,
        channels,
        frames,
        packets,
        planar,
    };
}
