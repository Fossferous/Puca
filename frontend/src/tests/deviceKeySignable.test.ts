/**
 * The desktop device key signs exactly three transcripts (frontend/src-tauri/
 * src/device_key.rs `is_signable`): the connection attestation, the device
 * grant, and the device share. That allowlist is Rust; this pins, from the
 * TypeScript side, that every transcript the client actually signs is one of
 * them — so the NEXT transcript someone adds fails here rather than on a
 * user's button (the share record was missing from the allowlist for a while,
 * and "Confirm & activate" silently did nothing on desktop).
 */
import { describe, it, expect } from 'vitest';
import { attestationMessage } from '../api/deviceIdentity/identity';
import { DEVICE_GRANT_TYPE } from '../api/devices/grants';
import { buildShareRecord, DEVICE_SHARE_TYPE } from '../api/devices/shares';
import { canonicalJson } from '../api/e2ee';

/** A faithful mirror of device_key.rs `is_signable` (keep in step). */
function isSignable(message: string): boolean {
    if (!message || message.length > 4096) return false;
    if (message.startsWith('sovereign-device-attest-v1|')) return true;
    try {
        const typ = (JSON.parse(message) as { typ?: unknown }).typ;
        return typ === DEVICE_GRANT_TYPE || typ === DEVICE_SHARE_TYPE;
    } catch {
        return false;
    }
}

describe('every transcript the client signs with the device key is on the native allowlist', () => {
    it('the connection attestation', () => {
        expect(isSignable(attestationMessage('bm9uY2U=', 42))).toBe(true);
    });
    it('the device grant record', () => {
        const canonical = canonicalJson({ typ: DEVICE_GRANT_TYPE, v: 1, host: 'host-dev', ctl: 'ctl-dev', exp: null, ts: 1786000000 });
        expect(isSignable(canonical)).toBe(true);
    });
    it('the device share record — byte-for-byte what buildShareRecord emits', () => {
        const { canonical } = buildShareRecord({ hostDevice: 'host-dev', ownerUser: 42, granteeUser: 7, capabilities: [], timestamp: 1786000000 });
        expect(canonical).toBe('{"caps":[],"grantee":7,"host":"host-dev","owner":42,"ts":1786000000,"typ":"sovereign-device-share-v1","v":1}');
        expect(isSignable(canonical)).toBe(true);
    });
    it('the constants themselves are the strings the allowlist names', () => {
        expect(DEVICE_GRANT_TYPE).toBe('sovereign-device-grant-v1');
        expect(DEVICE_SHARE_TYPE).toBe('sovereign-device-share-v1');
    });
    it('anything else is refused by the mirror (a near-miss version, a token, bulk data)', () => {
        expect(isSignable(canonicalJson({ typ: 'sovereign-device-share-v2', v: 1 }))).toBe(false);
        expect(isSignable('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOjF9')).toBe(false);
        expect(isSignable('a'.repeat(4097))).toBe(false);
    });
});
