/**
 * Clip crypto — two independent layers, deliberately kept apart:
 *
 *  RING (in-process only). Every closed GOP unit is AES-256-GCM sealed under a
 *  key generated with `extractable: false`, so the key material never exists in
 *  the JavaScript heap at all — only inside the browser's crypto module — and
 *  it is destroyed on disarm. Nonce = 4 zero bytes || u64BE(counter), counter
 *  monotonic per arm. AAD is a single version byte. The ring never leaves the
 *  process, so no further binding is needed; the version byte stops a future
 *  format change from silently mis-parsing.
 *
 *  PARTS (leave the process). The sealed clip is split into ≤ 24 MiB parts;
 *  each is sealed under a fresh 32-byte CLIP KEY that travels inside the E2EE
 *  message body (same trust model as `sovereign-enc:`). Wire format:
 *
 *      "SVCP" | ver=1 | u16BE(index) | nonce(12) | AES-GCM ciphertext‖tag
 *
 *  nonce = noncePrefix(8, random per clip) ‖ u32BE(index) — unique by
 *  construction, not by probability. AAD = clipId(16) ‖ ver ‖ u16BE(index),
 *  which binds each part to ITS clip and ITS position: reordering parts,
 *  splicing a part from another clip, or replaying an old part fails
 *  authentication instead of producing a subtly wrong video.
 */

export const RING_AAD = new Uint8Array([0x01]);
export const PART_MAGIC = 0x53564350; // "SVCP"
export const PART_VERSION = 1;
export const PART_HEADER_BYTES = 4 + 1 + 2 + 12; // 19
export const PART_TAG_BYTES = 16;
/** Plaintext budget per part: 24 MiB. +19 header +16 tag = 25 165 859 B, under
 *  the server's 25 MiB check and axum's 28 MiB body limit. */
export const PART_MAX_PLAINTEXT = 24 * 1024 * 1024;

const subtle = (): SubtleCrypto => {
    const s = globalThis.crypto?.subtle;
    if (!s) throw new Error('WebCrypto is unavailable in this context');
    return s;
};

// ---- ring -----------------------------------------------------------------

/** AES-GCM-256, NON-extractable. The single strongest property of the ring. */
export function newRingKey(): Promise<CryptoKey> {
    return subtle().generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** 4 zero bytes || u64BE(counter). Throws past 2^53 (unreachable in practice). */
export function ringNonce(counter: number): Uint8Array {
    if (!Number.isSafeInteger(counter) || counter < 0) throw new Error('ring nonce counter out of range');
    const n = new Uint8Array(12);
    new DataView(n.buffer).setBigUint64(4, BigInt(counter));
    return n;
}

export async function sealGop(key: CryptoKey, counter: number, plain: Uint8Array): Promise<Uint8Array> {
    const ct = await subtle().encrypt({ name: 'AES-GCM', iv: ringNonce(counter) as BufferSource, additionalData: RING_AAD as BufferSource }, key, plain as BufferSource);
    return new Uint8Array(ct);
}

export async function openGop(key: CryptoKey, counter: number, ct: Uint8Array): Promise<Uint8Array> {
    const pt = await subtle().decrypt({ name: 'AES-GCM', iv: ringNonce(counter) as BufferSource, additionalData: RING_AAD as BufferSource }, key, ct as BufferSource);
    return new Uint8Array(pt);
}

// ---- parts ----------------------------------------------------------------

export interface ClipSecrets {
    /** 32 random bytes — the clip content key. */
    key: Uint8Array;
    /** 8 random bytes — nonce prefix; the part index supplies the other 4. */
    noncePrefix: Uint8Array;
    /** 16 raw UUID bytes — the AAD binding. */
    clipId: Uint8Array;
}

/** Parse a canonical UUID string into 16 bytes (throws on anything else). */
export function uuidToBytes(uuid: string): Uint8Array {
    const hex = uuid.replace(/-/g, '');
    if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new Error('not a UUID: ' + uuid);
    const out = new Uint8Array(16);
    for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
}

export function bytesToUuid(b: Uint8Array): string {
    if (b.byteLength !== 16) throw new Error('uuid bytes must be 16 long');
    const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Fresh secrets for one clip. `clipId` is the proposal id (UUID v4). */
export function newClipSecrets(clipId: string): ClipSecrets {
    const key = new Uint8Array(32);
    const noncePrefix = new Uint8Array(8);
    globalThis.crypto.getRandomValues(key);
    globalThis.crypto.getRandomValues(noncePrefix);
    return { key, noncePrefix, clipId: uuidToBytes(clipId) };
}

function partNonce(s: ClipSecrets, index: number): Uint8Array {
    const n = new Uint8Array(12);
    n.set(s.noncePrefix, 0);
    new DataView(n.buffer).setUint32(8, index);
    return n;
}

function partAad(s: ClipSecrets, index: number): Uint8Array {
    const a = new Uint8Array(16 + 1 + 2);
    a.set(s.clipId, 0);
    a[16] = PART_VERSION;
    new DataView(a.buffer).setUint16(17, index);
    return a;
}

async function importPartKey(s: ClipSecrets, usage: KeyUsage): Promise<CryptoKey> {
    return subtle().importKey('raw', s.key as BufferSource, { name: 'AES-GCM' }, false, [usage]);
}

/** Seal one part → wire bytes (header || ciphertext‖tag). */
export async function sealPart(s: ClipSecrets, index: number, plain: Uint8Array): Promise<Uint8Array> {
    if (index < 0 || index > 0xffff) throw new Error('part index out of range');
    if (plain.byteLength > PART_MAX_PLAINTEXT) throw new Error(`part ${index} exceeds PART_MAX_PLAINTEXT`);
    const key = await importPartKey(s, 'encrypt');
    const nonce = partNonce(s, index);
    const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: nonce as BufferSource, additionalData: partAad(s, index) as BufferSource }, key, plain as BufferSource));
    const out = new Uint8Array(PART_HEADER_BYTES + ct.byteLength);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, PART_MAGIC);
    out[4] = PART_VERSION;
    dv.setUint16(5, index);
    out.set(nonce, 7);
    out.set(ct, PART_HEADER_BYTES);
    return out;
}

/** Open one part. Rejects (throws) on any tamper: header, index, clip, bytes. */
export async function openPart(s: ClipSecrets, index: number, wire: Uint8Array): Promise<Uint8Array> {
    if (wire.byteLength < PART_HEADER_BYTES + PART_TAG_BYTES) throw new Error('part too short');
    const dv = new DataView(wire.buffer, wire.byteOffset, wire.byteLength);
    if (dv.getUint32(0) !== PART_MAGIC) throw new Error('not a clip part');
    if (wire[4] !== PART_VERSION) throw new Error('unsupported part version');
    const idx = dv.getUint16(5);
    if (idx !== index) throw new Error(`part index mismatch: header says ${idx}, expected ${index}`);
    const nonce = wire.subarray(7, 7 + 12);
    const expected = partNonce(s, index);
    for (let i = 0; i < 12; i++) if (nonce[i] !== expected[i]) throw new Error('part nonce mismatch');
    const key = await importPartKey(s, 'decrypt');
    const pt = await subtle().decrypt({ name: 'AES-GCM', iv: expected as BufferSource, additionalData: partAad(s, index) as BufferSource }, key, wire.subarray(PART_HEADER_BYTES) as BufferSource);
    return new Uint8Array(pt);
}
