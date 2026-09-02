/**
 * The DTLS pin for mesh calls (api/rtc/mediaCrypto.ts advertiseDtlsPin /
 * verifyDtlsPin): a description carries a MAC, under the static pairwise media
 * key, over the DTLS fingerprint it presents. A relaying server that answers
 * with a connection of its own presents its own certificate and cannot re-mint
 * the MAC. Independent of frame encryption, so every engine pins.
 */
import { describe, it, expect } from 'vitest';
import { advertiseDtlsPin, verifyDtlsPin, sdpSoleFingerprint, advertiseE2ee } from '../api/rtc/mediaCrypto';
import { dtlsPinTag } from '../api/e2ee';

const KEY = new Uint8Array(32).fill(7);
const OTHER_KEY = new Uint8Array(32).fill(9);
const HEX = 'AB:'.repeat(31) + 'AB';
const MITM = 'FF:'.repeat(31) + 'FF';
const sdp = (fpLine: string | null, extra: string[] = []) => [
    'v=0', 'o=- 1 1 IN IP4 127.0.0.1', 's=-', ...extra,
    'm=audio 9 UDP/TLS/RTP/SAVPF 111',
    ...(fpLine ? [fpLine] : []),
    'a=setup:actpass',
].join('\r\n');

describe('advertiseDtlsPin', () => {
    it('adds one session-level pin over the description\'s own fingerprint, before the first m= line', () => {
        const out = advertiseDtlsPin(sdp(`a=fingerprint:sha-256 ${HEX}`), KEY);
        const lines = out.split('\r\n');
        const pinIdx = lines.findIndex(l => l.startsWith('a=sovereign-dtls:'));
        const mIdx = lines.findIndex(l => l.startsWith('m='));
        expect(pinIdx).toBeGreaterThan(-1);
        expect(pinIdx).toBeLessThan(mIdx);
        expect(lines[pinIdx]).toBe('a=sovereign-dtls:' + dtlsPinTag(KEY, `sha-256 ${HEX}`));
        expect(advertiseDtlsPin(out, KEY)).toBe(out); // idempotent
    });
    it('is a no-op without a key or without a fingerprint', () => {
        const plain = sdp(`a=fingerprint:sha-256 ${HEX}`);
        expect(advertiseDtlsPin(plain, null)).toBe(plain);
        expect(advertiseDtlsPin(sdp(null), KEY)).toBe(sdp(null));
    });
    it('composes with the media-E2EE capability attribute', () => {
        const both = advertiseDtlsPin(advertiseE2ee(sdp(`a=fingerprint:sha-256 ${HEX}`), 'TAG', 'x25519:AAAA'), KEY);
        expect(both).toContain('a=sovereign-e2ee:');
        expect(both).toContain('a=sovereign-dtls:');
    });
});

describe('verifyDtlsPin', () => {
    const honest = advertiseDtlsPin(sdp(`a=fingerprint:sha-256 ${HEX}`), KEY);

    it('binds an honest description', () => {
        expect(verifyDtlsPin(honest, KEY)).toBe('bound');
        expect(verifyDtlsPin(honest.replace(HEX, HEX.toLowerCase()), KEY)).toBe('bound'); // case is canonicalised
    });
    it('a connection substituted on the path presents another certificate: mismatch', () => {
        expect(verifyDtlsPin(honest.replace(HEX, MITM), KEY)).toBe('mismatch');
    });
    it('the pin cannot be re-minted without the pairwise key', () => {
        const forged = advertiseDtlsPin(sdp(`a=fingerprint:sha-256 ${MITM}`), OTHER_KEY);
        expect(verifyDtlsPin(forged, KEY)).toBe('mismatch');
    });
    it('an older peer that advertises no pin is unbound, never refused', () => {
        expect(verifyDtlsPin(sdp(`a=fingerprint:sha-256 ${HEX}`), KEY)).toBe('unbound');
    });
    it('a second, different fingerprint is a mismatch, not a choice', () => {
        const two = honest.replace('a=setup:actpass', `a=fingerprint:sha-1 AA:BB:CC\r\na=setup:actpass`);
        expect(verifyDtlsPin(two, KEY)).toBe('mismatch');
        expect(sdpSoleFingerprint(two)).toBeNull();
    });
    it('a pinned description that then loses its fingerprint is a mismatch', () => {
        expect(verifyDtlsPin(honest.replace(`a=fingerprint:sha-256 ${HEX}\r\n`, ''), KEY)).toBe('mismatch');
    });
});
