import { describe, it, expect } from 'vitest';
import { isNewerVersion, isTrustedBundleUrl, bundleVariantMatches, otaChannelMatches, shouldApplyOtaVersion, sameVersion, bundleLabelDisagrees } from '../components/updateGate.utils';

describe('OTA anti-rollback compares against the running BYTES (0.9.810 audit, C-04)', () => {
    // The plugin's bundle.version is whatever the manifest SAID. Recording it
    // as "what I am running" meant one mislabelled manifest (replay or typo)
    // locked the phone out of every genuine later release.
    it('on an OTA bundle, applies only a version strictly newer than the build', () => {
        expect(shouldApplyOtaVersion('0.9.812', '0.9.811', false)).toBe(true);
        expect(shouldApplyOtaVersion('0.9.811', '0.9.811', false)).toBe(false); // equal
        expect(shouldApplyOtaVersion('0.9.500', '0.9.811', false)).toBe(false); // the replay
    });
    it('the label the manifest gave the running bundle plays no part', () => {
        // Bytes built as 0.9.811, labelled 9.9.9 by a replayed manifest. The
        // old gate compared against 9.9.9 and refused 0.9.812 forever.
        expect(shouldApplyOtaVersion('0.9.812', '0.9.811', false)).toBe(true);
    });
    it('on the APK builtin bundle, accepts the SAME version (a fresh install pulls the published bundle)', () => {
        expect(shouldApplyOtaVersion('0.9.811', '0.9.811', true)).toBe(true);
        expect(shouldApplyOtaVersion('0.9.812', '0.9.811', true)).toBe(true);
    });
    it('on the APK builtin bundle, REFUSES anything older than the builtin bytes', () => {
        // The old 'builtin' placeholder parsed as the oldest version of all, so
        // a fresh install had NO anti-rollback: any signed bundle applied.
        expect(shouldApplyOtaVersion('0.9.500', '0.9.811', true)).toBe(false);
        expect(shouldApplyOtaVersion('0.0.1', '0.9.811', true)).toBe(false);
    });
    it('sameVersion compares parsed tuples, not strings', () => {
        expect(sameVersion('0.9.811', '0.9.811')).toBe(true);
        expect(sameVersion('v0.9.811', '0.9.811')).toBe(false); // parseVersion rejects the prefix: unequal, not a crash
        expect(sameVersion('0.9.811 ', '0.9.811')).toBe(true);
        expect(sameVersion('0.9.811.1', '0.9.811')).toBe(true);
        expect(sameVersion('builtin', 'builtin')).toBe(false); // unparseable is never equal
    });
    it('bundleLabelDisagrees flags a label that names another version, and nothing else', () => {
        expect(bundleLabelDisagrees('9.9.9', '0.9.811')).toBe(true);   // the replay / typo
        expect(bundleLabelDisagrees('0.9.811', '0.9.811')).toBe(false); // honest
        expect(bundleLabelDisagrees('0.9.811.1', '0.9.811')).toBe(false); // a build suffix is not a lie
        expect(bundleLabelDisagrees('builtin', '0.9.811')).toBe(false); // not a label
        expect(bundleLabelDisagrees('', '0.9.811')).toBe(false);
        expect(bundleLabelDisagrees(undefined, '0.9.811')).toBe(false);
        expect(bundleLabelDisagrees('garbage', '0.9.811')).toBe(false); // unknown, not a lie
    });
});

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
    it('trusts the API host\'s parent domain, not the last two labels', () => {
        // co.uk is not a site. The old rule accepted anything under it.
        expect(isTrustedBundleUrl('https://download.puca.co.uk/x.enc.zip', 'https://chat.puca.co.uk')).toBe(true);
        expect(isTrustedBundleUrl('https://evil.co.uk/x.enc.zip', 'https://chat.puca.co.uk')).toBe(false);
        expect(isTrustedBundleUrl('https://attacker.com.au/x.enc.zip', 'https://chat.puca.com.au')).toBe(false);
        // The exact API host always passes; an apex API host trusts only itself.
        expect(isTrustedBundleUrl('https://chat.example.com/x.enc.zip', 'https://chat.example.com')).toBe(true);
        expect(isTrustedBundleUrl('https://example.com/x.enc.zip', 'https://example.com')).toBe(true);
        expect(isTrustedBundleUrl('https://other.com/x.enc.zip', 'https://example.com')).toBe(false);
        // A trailing dot or upper case does not slip past.
        expect(isTrustedBundleUrl('https://DOWNLOAD.Example.com./x.enc.zip', 'https://chat.example.com')).toBe(true);
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

describe('OTA build-variant gate (bundleVariantMatches)', () => {
    // The threat this closes: an OTA pushes a JS bundle into an installed APK,
    // so a lite install handed the full manifest would silently gain the whole
    // remote-control frontend after shipping. No build-time check can see it.
    it('lets each build apply its OWN variant', () => {
        expect(bundleVariantMatches('full', true)).toBe(true);
        expect(bundleVariantMatches('lite', false)).toBe(true);
    });

    it('REFUSES a full bundle on a lite install (the whole point)', () => {
        expect(bundleVariantMatches('full', false)).toBe(false);
    });

    it('refuses a lite bundle on a full install, so lite never downgrades a full app', () => {
        expect(bundleVariantMatches('lite', true)).toBe(false);
    });

    it('treats an ABSENT variant as full, so a server that ignores ?variant=lite cannot feed a lite app', () => {
        // This is the case the gate exists for. Every manifest published
        // before the lite build existed omits the field, and all of them are
        // full bundles — so absent must NOT mean "matches anything", or an
        // un-updated server defeats the control entirely.
        expect(bundleVariantMatches(undefined, false)).toBe(false);
        expect(bundleVariantMatches(null, false)).toBe(false);
        // ...and the same absence is correct for a full install.
        expect(bundleVariantMatches(undefined, true)).toBe(true);
    });

    it('refuses an unrecognised variant rather than guessing', () => {
        expect(bundleVariantMatches('beta', false)).toBe(false);
        expect(bundleVariantMatches('beta', true)).toBe(false);
        expect(bundleVariantMatches('', false)).toBe(false);
    });
});

describe('OTA channel gate (otaChannelMatches) — Púca Notes is a different app, not a variant', () => {
    // The server that predates the notes manifest answers ?variant=notes with
    // Púca's FULL manifest (untagged, or tagged "full"). Accepting that would
    // install Púca into the Notes app; Púca's own entry point then blesses it
    // with notifyAppReady, so Capgo would never roll it back.
    it('notes accepts exactly "notes"', () => {
        expect(otaChannelMatches('notes', 'notes')).toBe(true);
    });

    it.each([undefined, null, 'full', 'lite', 'Notes', 'notes ', '', 'notes2'])(
        'notes REFUSES %j (absent does NOT mean notes)', (v) => {
            expect(otaChannelMatches(v as string | null | undefined, 'notes')).toBe(false);
        },
    );

    it('full and lite refuse a notes manifest', () => {
        expect(otaChannelMatches('notes', 'full')).toBe(false);
        expect(otaChannelMatches('notes', 'lite')).toBe(false);
        expect(bundleVariantMatches('notes', true)).toBe(false);
        expect(bundleVariantMatches('notes', false)).toBe(false);
    });

    it('full and lite keep their rule: absent means full (positive control for the wrapper)', () => {
        expect(otaChannelMatches(undefined, 'full')).toBe(true);
        expect(otaChannelMatches(null, 'full')).toBe(true);
        expect(otaChannelMatches(undefined, 'lite')).toBe(false);
        expect(otaChannelMatches('lite', 'lite')).toBe(true);
        expect(otaChannelMatches('full', 'full')).toBe(true);
    });
});
