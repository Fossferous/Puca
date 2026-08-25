import { describe, it, expect } from 'vitest';
import { isNewerVersion, isTrustedBundleUrl } from '../components/updateGate.utils';

describe('OTA anti-rollback (isNewerVersion)', () => {
    it('applies a strictly newer version', () => {
        expect(isNewerVersion('0.5.54', '0.5.53')).toBe(true);
        expect(isNewerVersion('0.6.0', '0.5.99')).toBe(true);
        expect(isNewerVersion('1.0.0', '0.9.9')).toBe(true);
    });
    it('REFUSES an equal or older version (the rollback defense)', () => {
        expect(isNewerVersion('0.5.53', '0.5.53')).toBe(false); // equal
        expect(isNewerVersion('0.5.52', '0.5.53')).toBe(false); // older patch
        expect(isNewerVersion('0.4.99', '0.5.0')).toBe(false);  // older minor
        expect(isNewerVersion('0.5.9', '0.5.10')).toBe(false);  // numeric, not string, ordering
    });
    it('treats the builtin placeholder as oldest, so the first real OTA applies', () => {
        expect(isNewerVersion('0.5.54', 'builtin')).toBe(true);
        expect(isNewerVersion('0.0.1', 'builtin')).toBe(true);
    });
});

describe('OTA bundle-URL trust (isTrustedBundleUrl)', () => {
    it('rejects plaintext HTTP', () => {
        expect(isTrustedBundleUrl('http://download.example.com/mobile/x.enc.zip', 'https://chat.example.com')).toBe(false);
    });
    it('accepts HTTPS on the same registrable site as the API', () => {
        expect(isTrustedBundleUrl('https://download.example.com/mobile/x.enc.zip', 'https://chat.example.com')).toBe(true);
    });
    it('rejects HTTPS on a different site than the API', () => {
        // Deliberately NOT another *.example.com host: that shares a
        // registrable site with the API base below, so it would pass the
        // same-site check and defeat the point of this test. attacker.test
        // is an IANA-reserved test TLD, guaranteed unrelated.
        expect(isTrustedBundleUrl('https://evil.attacker.test/x.enc.zip', 'https://chat.example.com')).toBe(false);
    });
    it('rejects a malformed URL', () => {
        expect(isTrustedBundleUrl('not a url', 'https://chat.example.com')).toBe(false);
        expect(isTrustedBundleUrl('', 'https://chat.example.com')).toBe(false);
    });
    it('fails CLOSED when the API base is unknown (no VITE_API_URL)', () => {
        // Previously returned true for any HTTPS host — an unconfigured build
        // would trust an attacker-named bundle. Must refuse.
        expect(isTrustedBundleUrl('https://download.example.com/mobile/x.enc.zip', '')).toBe(false);
        expect(isTrustedBundleUrl('https://evil.example.com/x.enc.zip', '')).toBe(false);
    });
});
