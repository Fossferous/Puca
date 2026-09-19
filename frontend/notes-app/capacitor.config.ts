import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Púca Notes as its own Android app.
 *
 * A SEPARATE Capacitor project from ../ (the Púca app), on purpose:
 *   - its own applicationId, so it installs BESIDE Púca rather than replacing
 *     it (applicationId is app identity on Android — see ../android/app/
 *     build.gradle for why Púca and Púca Lite share theirs);
 *   - its own WebView origin (https://localhost, but a different app's
 *     storage), so it has its own sign-in — Notes' login form takes the same
 *     Púca account;
 *   - none of Púca's native plugins (notifications, keep-alive, geofences,
 *     FCM): Notes is a notes surface, and the web code degrades to "not
 *     available" where it asks for them;
 *   - its OWN over-the-air updates (the CapacitorUpdater block below), signed
 *     with its OWN key: a Púca bundle cannot verify here, nor a Notes bundle
 *     in Púca, whatever an unsigned manifest claims.
 *
 * The web bundle is the Notes page built in NATIVE mode
 * (`NOTES_TARGET=native vite build --config vite.notes.config.ts`, base '/'
 * instead of '/notes/'), written to ../dist-notes-app. scripts/build-notes-app.mjs
 * runs the whole chain, CSP meta included.
 */
/**
 * NOTES_ALLOW_HTTP_API=1 is for a TEST build against a plain-http backend
 * (an emulator talking to a throwaway server on the host at 10.0.2.2). The
 * page normally lives at https://localhost, so an http API is mixed content
 * and Chromium blocks the fetch before CSP is consulted — `allowMixedContent`
 * did not lift that for fetch() when tried. Serving the page from
 * http://localhost instead makes the API same-scheme. The origin changes
 * with the scheme (separate storage), and the backend's CORS_ORIGINS must
 * list http://localhost. Never set this for a build anyone installs for real.
 */
const ALLOW_HTTP_API = process.env.NOTES_ALLOW_HTTP_API === '1';

const config: CapacitorConfig = {
    appId: 'com.sovereign.notes',
    appName: 'Púca Notes',
    webDir: '../dist-notes-app',
    server: {
        androidScheme: ALLOW_HTTP_API ? 'http' : 'https',
    },
    plugins: {
        // Self-hosted OTA for the Notes app (frontend/src/notes/components/
        // NotesUpdateGate.tsx drives it against /api/mobile-updates/check?
        // variant=notes). Mirrors Púca's block (../capacitor.config.ts — read
        // the comments there) with ONE deliberate difference: publicKey is the
        // NOTES key, not Púca's. That is what makes a Púca bundle unusable in
        // this app even if a server served one: it cannot decrypt or verify.
        // The private half is kept off-server (deploy/mobile/README.md, "Púca
        // Notes"); scripts/check-lite-identity.mjs fails the build if this key
        // ever equals Púca's, if autoUpdate or telemetry come back on, or if
        // allowNavigation appears (the download prompt relies on a foreign
        // host opening in the system browser).
        CapacitorUpdater: {
            autoUpdate: false,
            statsUrl: '',
            publicKey:
                '-----BEGIN RSA PUBLIC KEY-----\n' +
                'MIIBCgKCAQEAxz85nTp28dw3jy4SG/RXxHGNp4J6b+oCc/XHVNGO8hR6FEnIJXyE\n' +
                'xuaKVdy+LWp3XmPZkCq949rfMYgvfczlZggL4ScdrzB54UyleuD2zTft+nbePLNt\n' +
                'V9dAKVJk++vGGJQScYs7dPjxXo+Uq7AJUq6fJrt1seDwQrp7iHwmEjHcLenjWEJh\n' +
                '49/fLLiqsjcfMeh6H1fjF2wEI5r4mf0Rb6Zxg7Mq5aSZQwAMgEaoIxyJDl8uZiOf\n' +
                '3bE8l+P1HGJf1G1/iY69rYZUMWd0BnRwxMQ94z4uZIYu45hvXS1qxl8GjXUHHH0b\n' +
                'odWSEoVdR+30Cad6zcUDW4o0QxxAAtq2qwIDAQAB\n' +
                '-----END RSA PUBLIC KEY-----',
            appReadyTimeout: 10000,
            responseTimeout: 20,
            autoDeleteFailed: true,
            autoDeletePrevious: true,
            resetWhenUpdate: true,
        },
    },
    android: {
        backgroundColor: '#18191c',
    },
};

export default config;
