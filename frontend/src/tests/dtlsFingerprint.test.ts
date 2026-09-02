/**
 * The DTLS-fingerprint binding for P2P transfers (api/dtlsFingerprint.ts): the
 * remote description must present exactly the fingerprint the peer
 * authenticated, and nothing but one data channel.
 */
import { describe, it, expect } from 'vitest';
import { normalizeFingerprint, parseFingerprint, sdpFingerprints, sdpBoundTo, certificateFingerprint } from '../api/dtlsFingerprint';

const HEX = 'ab:cd:ef:01:23:45:67:89:ab:cd:ef:01:23:45:67:89:ab:cd:ef:01:23:45:67:89:ab:cd:ef:01:23:45:67:89';
const FP = `sha-256 ${HEX.toUpperCase()}`;
const sdp = (lines: string[]) => ['v=0', 'o=- 1 1 IN IP4 127.0.0.1', 's=-', ...lines].join('\r\n');

describe('canonical form', () => {
    it('lower-cases the algorithm and upper-cases the hex', () => {
        expect(normalizeFingerprint('SHA-256', HEX)).toBe(FP);
        expect(parseFingerprint(`SHA-256 ${HEX}`)).toBe(FP);
        expect(parseFingerprint(FP)).toBe(FP);
    });
    it('refuses anything that is not a fingerprint', () => {
        expect(normalizeFingerprint('sha 256', HEX)).toBeNull();
        expect(normalizeFingerprint('sha-256', 'ABCD')).toBeNull();
        expect(normalizeFingerprint('sha-256', 'AB:CD:')).toBeNull();
        expect(normalizeFingerprint('sha-256', 'ZZ:ZZ')).toBeNull();
        expect(parseFingerprint('sha-256')).toBeNull();
        expect(parseFingerprint('')).toBeNull();
    });
});

describe('sdpBoundTo', () => {
    const ok = sdp(['m=application 9 UDP/DTLS/SCTP webrtc-datachannel', `a=fingerprint:sha-256 ${HEX}`]);
    it('accepts a single data channel presenting the fingerprint, in any case', () => {
        expect(sdpBoundTo(ok, FP)).toBe(true);
        expect(sdpBoundTo(ok, `SHA-256 ${HEX}`)).toBe(true);
    });
    it('refuses a different fingerprint, a missing one, or a second one under another hash', () => {
        const other = HEX.replace('ab', 'ff');
        expect(sdpBoundTo(sdp(['m=application 9 UDP/DTLS/SCTP webrtc-datachannel', `a=fingerprint:sha-256 ${other}`]), FP)).toBe(false);
        expect(sdpBoundTo(sdp(['m=application 9 UDP/DTLS/SCTP webrtc-datachannel']), FP)).toBe(false);
        expect(sdpBoundTo(sdp(['m=application 9 UDP/DTLS/SCTP webrtc-datachannel', `a=fingerprint:sha-256 ${HEX}`, `a=fingerprint:sha-1 AA:BB:CC`]), FP)).toBe(false);
        expect(sdpBoundTo(sdp(['m=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'a=fingerprint:garbage']), FP)).toBe(false);
    });
    it('refuses anything but exactly one application section', () => {
        expect(sdpBoundTo(sdp(['m=audio 9 UDP/TLS/RTP/SAVPF 111', `a=fingerprint:sha-256 ${HEX}`]), FP)).toBe(false);
        expect(sdpBoundTo(sdp(['m=application 9 UDP/DTLS/SCTP webrtc-datachannel', `a=fingerprint:sha-256 ${HEX}`, 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', `a=fingerprint:sha-256 ${HEX}`]), FP)).toBe(false);
        expect(sdpBoundTo(sdp([`a=fingerprint:sha-256 ${HEX}`]), FP)).toBe(false);
    });
    it('a malformed expected fingerprint never matches', () => {
        expect(sdpBoundTo(ok, 'nonsense')).toBe(false);
    });
    it('reads every fingerprint line', () => {
        expect(sdpFingerprints(ok)).toEqual([FP]);
        expect(sdpFingerprints('a=fingerprint:broken')).toEqual([null]);
    });
});

describe('certificateFingerprint', () => {
    it('uses getFingerprints() when the engine has it and canonicalises the result', async () => {
        const cert = { getFingerprints: () => [{ algorithm: 'SHA-256', value: HEX }] } as unknown as RTCCertificate;
        expect(await certificateFingerprint(cert)).toBe(FP);
    });
    it('is null when the engine reports nothing usable', async () => {
        const cert = { getFingerprints: () => [{ algorithm: 'sha-256', value: 'nope' }] } as unknown as RTCCertificate;
        expect(await certificateFingerprint(cert)).toBeNull();
    });
});
