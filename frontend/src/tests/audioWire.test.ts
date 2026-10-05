/**
 * The page reads exactly what the shell writes. Every message in
 * fixtures/clip-audio-wire.json is READ here and must give its fields;
 * clip_audio_wire.rs `every_message_in_the_shared_fixture_is_its_documented_bytes`
 * BUILDS the same messages from those fields and must give the same bytes.
 * The hex came from an independent encoder, so changing the layout on one
 * side only turns that side's suite red.
 */
import { describe, it, expect } from 'vitest';
import { readAudioFrame, AUDIO_HEADER_LEN, AUDIO_PACKET_ENTRY_LEN, AUDIO_WIRE_VERSION } from '../api/clips/audioWire';
import fixture from './fixtures/clip-audio-wire.json';

const hex = (s: string) => {
    const h = s.replace(/\s+/g, '');
    const out = new Uint8Array(h.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
    return out.buffer;
};

const caseNamed = (start: string) => {
    const c = fixture.cases.find(x => x.name.startsWith(start));
    if (!c) throw new Error(`no fixture case "${start}"`);
    return c;
};
const STEREO = caseNamed('stereo').hex;

/** A message as the shell builds one (clip_audio_wire.rs audio_frame).
 *  `packets` defaults to one packet holding every frame; `frames` overrides
 *  the header's total (to build a table that does not add up). */
function frame(o: { generation?: number; rate: number; channels: number; packets: { frames: number; ageUs?: number }[]; frames?: number; silent?: boolean; sample?: (ch: number, i: number) => number }): ArrayBuffer {
    const frames = o.frames ?? o.packets.reduce((s, p) => s + p.frames, 0);
    const at = AUDIO_HEADER_LEN + AUDIO_PACKET_ENTRY_LEN * o.packets.length;
    const b = new ArrayBuffer(at + (o.silent ? 0 : o.channels * frames * 4));
    const v = new DataView(b);
    v.setUint8(0, 1); v.setUint8(1, o.silent ? 1 : 0);
    v.setBigUint64(2, BigInt(o.generation ?? 1), true);
    v.setUint32(10, o.rate, true); v.setUint16(14, o.channels, true);
    v.setUint32(16, frames, true); v.setUint32(20, o.packets.length, true);
    o.packets.forEach((p, k) => { v.setUint32(AUDIO_HEADER_LEN + 8 * k, p.frames, true); v.setUint32(AUDIO_HEADER_LEN + 8 * k + 4, p.ageUs ?? 0, true); });
    if (!o.silent) for (let ch = 0; ch < o.channels; ch++) for (let i = 0; i < frames; i++) v.setFloat32(at + (ch * frames + i) * 4, o.sample ? o.sample(ch, i) : 0, true);
    return b;
}

describe('the clip desktop-audio wire', () => {
    it('reads every message in the shared fixture as the fields it was built from', () => {
        expect([AUDIO_WIRE_VERSION, AUDIO_HEADER_LEN, AUDIO_PACKET_ENTRY_LEN]).toEqual([fixture.version, fixture.headerLen, fixture.packetEntryLen]);
        let sound = 0, silent = 0;
        for (const c of fixture.cases) {
            const f = readAudioFrame(hex(c.hex));
            expect(f, c.name).not.toBeNull();
            expect(f, c.name).toMatchObject({
                silent: c.planar === null, generation: c.generation, sampleRate: c.sampleRate,
                channels: c.channels, frames: c.frames, packets: c.packets,
            });
            if (c.planar === null) { silent++; expect(f!.planar, c.name).toBeNull(); }
            else { sound++; expect(f!.planar!.map(p => [...p]), c.name).toEqual(c.planar); }
        }
        // Positive control on the table itself: it must hold both kinds.
        expect([sound >= 2, silent >= 1]).toEqual([true, true]);
    });

    /** WASAPI's autoconvert makes the shell's capture 48 kHz stereo, but no
     *  part of the page may depend on that: whatever rate and channel count a
     *  message names is what it is read as. */
    it('reads 44.1 kHz, 5.1 and 7.1 with every channel in its own plane', () => {
        for (const [rate, channels] of [[44_100, 2], [48_000, 6], [44_100, 8], [96_000, 1]] as const) {
            const packet = Math.round(rate / 100);
            const packets = [0, 1, 2, 3].map(k => ({ frames: packet, ageUs: (3 - k) * 10_000 }));
            const frames = packet * 4;
            const f = readAudioFrame(frame({ rate, channels, packets, sample: (ch, i) => ch * 1000 + i }))!;
            expect(f, `${rate} Hz x${channels}`).toMatchObject({ sampleRate: rate, channels, frames, packets });
            expect(f.planar).toHaveLength(channels);
            for (let ch = 0; ch < channels; ch++) {
                expect(f.planar![ch]).toHaveLength(frames);
                expect([f.planar![ch][0], f.planar![ch][frames - 1]]).toEqual([ch * 1000, ch * 1000 + frames - 1]);
            }
        }
    });

    it('drops a message it cannot read rather than half-reading it', () => {
        const ok = { rate: 48_000, channels: 2, packets: [{ frames: 240 }, { frames: 240 }], silent: true };
        expect(readAudioFrame(new ArrayBuffer(AUDIO_HEADER_LEN - 1))).toBeNull();
        expect(readAudioFrame('not bytes')).toBeNull();
        const wrongVersion = new Uint8Array(hex(STEREO)); wrongVersion[0] = 2;
        expect(readAudioFrame(wrongVersion.buffer)).toBeNull();
        // A payload one sample short of what the header promises, or one over.
        const stereo = hex(STEREO);
        expect(readAudioFrame(stereo.slice(0, stereo.byteLength - 4))).toBeNull();
        const over = new Uint8Array(stereo.byteLength + 4); over.set(new Uint8Array(stereo));
        expect(readAudioFrame(over.buffer)).toBeNull();
        // A packet table cut short.
        expect(readAudioFrame(frame(ok).slice(0, AUDIO_HEADER_LEN + 4))).toBeNull();
        const silentWithPayload = new Uint8Array(hex(STEREO)); silentWithPayload[1] = 1;
        expect(readAudioFrame(silentWithPayload.buffer), 'a silent run carries no samples').toBeNull();
        expect(readAudioFrame(frame({ ...ok, channels: 0 })), 'no channels').toBeNull();
        expect(readAudioFrame(frame({ ...ok, channels: 33 })), 'more channels than createBuffer promises').toBeNull();
        expect(readAudioFrame(frame({ ...ok, rate: 0 })), 'no rate').toBeNull();
        expect(readAudioFrame(frame({ ...ok, packets: [], frames: 480 })), 'no packets').toBeNull();
        expect(readAudioFrame(frame({ ...ok, packets: [{ frames: 480 }, { frames: 0 }] })), 'an empty packet').toBeNull();
        expect(readAudioFrame(frame({ ...ok, frames: 481 })), 'a table that does not add up to the header').toBeNull();
        expect(readAudioFrame(frame({ ...ok, frames: 479 })), 'nor under it').toBeNull();
        // Positive control: the same shapes, well-formed, are read.
        expect(readAudioFrame(frame(ok))).not.toBeNull();
        expect(readAudioFrame(frame({ ...ok, channels: 32 }))).not.toBeNull();
        expect(readAudioFrame(frame({ ...ok, silent: false }))).not.toBeNull();
    });

    it('accepts a byte view and a byte array as well as an ArrayBuffer', () => {
        const bytes = new Uint8Array(hex(STEREO));
        // A view at an odd offset into a bigger buffer: the reader copies it
        // out, so its float views are aligned.
        const padded = new Uint8Array(bytes.length + 3); padded.set(bytes, 3);
        expect(readAudioFrame(padded.subarray(3))?.planar?.map(p => [...p])).toEqual(caseNamed('stereo').planar);
        expect(readAudioFrame([...bytes])?.generation).toBe(caseNamed('stereo').generation);
    });
});
