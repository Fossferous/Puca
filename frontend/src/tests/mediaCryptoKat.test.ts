/**
 * S4 — cross-language known-answer tests for the media frame AEAD.
 *
 * WHY THIS EXISTS: the native host agent (Phase 6) must produce and consume
 * byte-identical frames to `mediaCrypto.ts`, or the webview host and the agent
 * host silently diverge and it presents as "video is broken" rather than "the
 * crypto disagrees". This fixture is the contract, asserted from BOTH sides:
 * this file (vitest) and `tests/media_aead_kat.rs` (cargo test).
 *
 * The fixture pins the real `encryptFrame`/`decryptFrame` — not a
 * reimplementation. A KAT that tests a copy of the code proves nothing.
 * Determinism comes from stubbing `crypto.getRandomValues` (the ONLY source of
 * nondeterminism in encryptFrame: the 12-byte IV).
 *
 * Regenerate after a DELIBERATE format change:
 *   WRITE_KAT=1 npx vitest run src/tests/mediaCryptoKat.test.ts
 * Then re-run `cargo test --test media_aead_kat` and expect it to FAIL until the
 * Rust side is updated to match. That failure is the point.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    encryptFrame,
    decryptFrame,
    importMediaKey,
    type MediaCryptoState,
    type EncodedFrameLike,
} from '../api/rtc/mediaCrypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixtures', 'media-aead-kat.json');

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const unhex = (s: string) => new Uint8Array(Buffer.from(s, 'hex'));

/** Inputs are hand-written; ciphertexts are produced by the real encryptFrame. */
interface KatInput {
    name: string;
    /** undefined => audio (1-byte clear header) */
    frameType?: 'key' | 'delta';
    keyHex: string;
    ivHex: string;
    plaintextHex: string;
    note: string;
}

const KEY_A = '00112233445566778899aabbccddeeff102132435465768798a9bacbdcedfe0f';
const KEY_B = 'ffeeddccbbaa99887766554433221100f0edecdbcab9a897867564534231201f';
const IV_A = '000102030405060708090a0b';
const IV_B = 'fedcba9876543210deadbeef';

const INPUTS: KatInput[] = [
    {
        name: 'video-key-10-byte-header',
        frameType: 'key',
        keyHex: KEY_A,
        ivHex: IV_A,
        // 10-byte clear header + 16-byte body
        plaintextHex: '00010203040506070809' + '101112131415161718191a1b1c1d1e1f',
        note: 'Ordinary keyframe. Header (10B) is AAD, body is encrypted.',
    },
    {
        name: 'video-delta-3-byte-header',
        frameType: 'delta',
        keyHex: KEY_A,
        ivHex: IV_B,
        plaintextHex: 'aabbcc' + '000102030405060708090a0b0c0d0e0f1011',
        note: 'Ordinary delta frame. Header is 3 bytes, not 10.',
    },
    {
        name: 'audio-1-byte-header',
        keyHex: KEY_B,
        ivHex: IV_A,
        plaintextHex: '5a' + 'cafebabedeadbeef0badf00d',
        note: 'Audio frames carry no `type`; clear header is 1 byte.',
    },
    {
        name: 'video-key-frame-SHORTER-than-its-header',
        frameType: 'key',
        keyHex: KEY_A,
        ivHex: IV_A,
        plaintextHex: '00010203',
        note:
            'EDGE CASE. A 4-byte keyframe is shorter than the 10-byte clear header. ' +
            'encryptFrame does Math.min(headerLen, data.length), so n=4 and the body ' +
            'is EMPTY — output is header + bare 16-byte GCM tag + iv + magic. A Rust ' +
            'port that slices [10..] here would panic or produce garbage.',
    },
    {
        name: 'audio-header-only-empty-body',
        keyHex: KEY_B,
        ivHex: IV_B,
        plaintextHex: '7f',
        note: 'EDGE CASE. 1-byte audio frame: n=1, body empty, ciphertext is the tag alone.',
    },
    {
        name: 'video-delta-exactly-header-length',
        frameType: 'delta',
        keyHex: KEY_B,
        ivHex: IV_A,
        plaintextHex: 'ddeeff',
        note: 'EDGE CASE. Body boundary lands exactly at the header length.',
    },
];

interface KatVector extends KatInput {
    ciphertextHex: string;
}

/** Pin the IV so the real encryptFrame becomes deterministic. */
function withStubbedIv<T>(ivHex: string, fn: () => Promise<T>): Promise<T> {
    const iv = unhex(ivHex);
    const real = crypto.getRandomValues.bind(crypto);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (crypto as any).getRandomValues = (arr: Uint8Array) => {
        if (arr.length !== iv.length) return real(arr); // not the IV draw
        arr.set(iv);
        return arr;
    };
    return fn().finally(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (crypto as any).getRandomValues = real;
    });
}

async function stateFor(keyHex: string): Promise<MediaCryptoState> {
    return { key: await importMediaKey(unhex(keyHex)), enabled: true, requireE2ee: false };
}

function frameOf(v: KatInput): EncodedFrameLike {
    return { data: unhex(v.plaintextHex).buffer as ArrayBuffer, type: v.frameType };
}

async function encryptToHex(v: KatInput): Promise<string> {
    const st = await stateFor(v.keyHex);
    const f = frameOf(v);
    const kept = await withStubbedIv(v.ivHex, () => encryptFrame(f, st));
    expect(kept, `${v.name}: encryptFrame must keep the frame`).toBe(true);
    return hex(new Uint8Array(f.data));
}

let fixture: { version: number; vectors: KatVector[] };

beforeAll(async () => {
    if (process.env.WRITE_KAT) {
        const vectors: KatVector[] = [];
        for (const v of INPUTS) vectors.push({ ...v, ciphertextHex: await encryptToHex(v) });
        mkdirSync(dirname(FIXTURE), { recursive: true });
        writeFileSync(
            FIXTURE,
            JSON.stringify(
                {
                    _comment:
                        'Generated by frontend/src/tests/mediaCryptoKat.test.ts with WRITE_KAT=1. ' +
                        'Cross-language contract for the media frame AEAD: asserted by vitest AND ' +
                        'by tests/media_aead_kat.rs. Do not hand-edit.',
                    _wireFormat: '[clear header (AAD) | AES-256-GCM ciphertext+tag | iv(12) | magic "SVRN"(4)]',
                    _clearHeaderLen: { key: 10, delta: 3, audio: 1 },
                    version: 1,
                    vectors,
                },
                null,
                2,
            ) + '\n',
        );
    }
    fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'));
});

describe('media frame AEAD — known-answer vectors (cross-language contract)', () => {
    it('the fixture covers every declared input', () => {
        expect(fixture.vectors.map(v => v.name)).toEqual(INPUTS.map(v => v.name));
    });

    for (const input of INPUTS) {
        it(`encrypts ${input.name} to the pinned bytes`, async () => {
            const v = fixture.vectors.find(x => x.name === input.name)!;
            expect(v, `no fixture vector named ${input.name}`).toBeTruthy();
            // Guard against a fixture that drifted from the declared inputs.
            expect(v.plaintextHex).toBe(input.plaintextHex);
            expect(v.keyHex).toBe(input.keyHex);
            expect(v.ivHex).toBe(input.ivHex);
            expect(await encryptToHex(input)).toBe(v.ciphertextHex);
        });

        it(`decrypts ${input.name} back to the original frame`, async () => {
            const v = fixture.vectors.find(x => x.name === input.name)!;
            const st = await stateFor(v.keyHex);
            const f: EncodedFrameLike = {
                data: unhex(v.ciphertextHex).buffer as ArrayBuffer,
                type: v.frameType,
            };
            expect(await decryptFrame(f, st), `${v.name}: must decrypt`).toBe(true);
            expect(hex(new Uint8Array(f.data))).toBe(v.plaintextHex);
        });
    }

    it('rejects a frame whose clear header (AAD) was tampered with', async () => {
        const v = fixture.vectors.find(x => x.name === 'video-key-10-byte-header')!;
        const bytes = unhex(v.ciphertextHex);
        bytes[0] ^= 0xff; // flip a bit inside the AAD-bound header
        const st = await stateFor(v.keyHex);
        const f: EncodedFrameLike = { data: bytes.buffer as ArrayBuffer, type: v.frameType };
        // false === dropped. This is what proves the header is genuinely bound.
        expect(await decryptFrame(f, st)).toBe(false);
    });

    it('rejects a frame encrypted under a different key', async () => {
        const v = fixture.vectors.find(x => x.name === 'video-key-10-byte-header')!;
        const st = await stateFor(KEY_B); // wrong key
        const f: EncodedFrameLike = {
            data: unhex(v.ciphertextHex).buffer as ArrayBuffer,
            type: v.frameType,
        };
        expect(await decryptFrame(f, st)).toBe(false);
    });

    // A frame too short to be one of ours, that nonetheless ends in "SVRN".
    // It must be treated like any other UNMARKED frame — which means require-E2EE
    // still drops it. Returning a bare `true` here would render plaintext while
    // the user had enforcement on.
    describe('frame too short to be ours but ending in the magic', () => {
        // 20 bytes: below MIN_ENCRYPTED_LEN (32), ends with the magic.
        const shortMagic = () =>
            unhex('00112233445566778899aabbccccdddd' + '5356524e');

        it('passes through when enforcement is off', async () => {
            const st = await stateFor(KEY_A);
            const f: EncodedFrameLike = { data: shortMagic().buffer as ArrayBuffer, type: 'delta' };
            expect(await decryptFrame(f, st)).toBe(true);
            // ...and is handed on untouched.
            expect(hex(new Uint8Array(f.data))).toBe(hex(shortMagic()));
        });

        it('is DROPPED when require-E2EE is on', async () => {
            const st = { ...(await stateFor(KEY_A)), requireE2ee: true };
            const f: EncodedFrameLike = { data: shortMagic().buffer as ArrayBuffer, type: 'delta' };
            expect(await decryptFrame(f, st)).toBe(false);
        });
    });

    it('every vector carries the SVRN trailer at the expected offset', () => {
        for (const v of fixture.vectors) {
            const ct = unhex(v.ciphertextHex);
            expect(hex(ct.subarray(ct.length - 4)), v.name).toBe('5356524e'); // "SVRN"
            const ivAt = ct.length - 16;
            expect(hex(ct.subarray(ivAt, ivAt + 12)), `${v.name} iv`).toBe(v.ivHex);
        }
    });
});
