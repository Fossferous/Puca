import type { CapacitorConfig } from '@capacitor/cli';

// LITE VARIANT. `npm run cap:build:android:lite` sets PUCA_LITE=1.
//
// appId is deliberately SHARED with the full build: on Android that is app
// identity, so a lite APK installs over a full one as an ordinary update —
// replacing it (the variants are mutually exclusive) while KEEPING its data,
// which is what carries your session across the switch. It must therefore stay
// in step with android/app/build.gradle, which hardcodes the same value.
//
// Only the LABEL differs, so an installed app says which variant it is.
const LITE = process.env.PUCA_LITE === '1';

const config: CapacitorConfig = {
    appId: 'com.sovereign.app',
    appName: LITE ? 'Púca Lite' : 'Púca',
    webDir: 'dist',
    server: {
        // For development: uncomment to connect to local dev server
        // url: 'http://YOUR_LOCAL_IP:5173',
        // cleartext: true,
        androidScheme: 'https',
    },
    plugins: {
        // Self-hosted OTA: UpdateGate drives the manual download/set flow
        // against /api/mobile-updates/check — autoUpdate must stay false or
        // the plugin also polls Capgo's cloud (unconfigured) and conflicts.
        CapacitorUpdater: {
            autoUpdate: false,
            // Even in manual mode the plugin reports install stats (device
            // UUID + app id) to Capgo's cloud — wrong default for an E2EE
            // app. Empty string disables telemetry entirely.
            statsUrl: '',
            // OTA bundle authenticity: bundles are AES-encrypted and the SHA-256
            // is RSA-signed with a private key kept OFF-server (see
            // deploy/mobile/). The plugin verifies against this embedded public
            // key and REJECTS any bundle that isn't validly signed — so a
            // compromised download host can't push a forged update. With this
            // set, every OTA bundle MUST be produced by deploy/mobile/encrypt-
            // bundle.mjs (a plain bundle is refused). Public key = safe to ship.
            publicKey:
                '-----BEGIN RSA PUBLIC KEY-----\n' +
                'MIIBCgKCAQEA8Jj7CahnCj+ZZrJZNzpKR6QYV37su97gQ6M1+62sXWjTAnbfsY1r\n' +
                'Lrc7Ys1X401DzEwBRWHnYLo3DK/u2yiVpOTv1bpmK7MyYHwEli9k4neNLL/9NzgH\n' +
                '/TqMXBcEIszNzRQc2TE+zFlZjb+F6VPaLow9ApJ6Dwyfx5hcePdP9md/f0Ha5gsf\n' +
                'L4YLJDjyxqR7J5WKtH+n8zNyplU/qh4pu4tvlDSye9v1qg44VXeN94GaW9qNhUqm\n' +
                'zK09f/3g/yQVqbqBgLtIb4I1UEnEkcoYPT3Y23XJd5v2dPLBdSZzXDOt51uM5djt\n' +
                'V0MRKNRM23pSEK185Zd8WIgMpAULBUqVWwIDAQAB\n' +
                '-----END RSA PUBLIC KEY-----',
            appReadyTimeout: 10000,
            responseTimeout: 20,
            autoDeleteFailed: true,
            autoDeletePrevious: true,
            resetWhenUpdate: true,
        },
        // NO PushNotifications stanza, deliberately. Data rides no relay at
        // all: FCM was integrated once and removed on principle (metadata
        // through Google). Background delivery is the native in-app socket
        // (NativeDelivery) to the user's own server.
    },
    ios: {
        contentInset: 'automatic',
        // Enable background audio for voice chat
        backgroundColor: '#1a1a2e',
    },
    android: {
        backgroundColor: '#1a1a2e',
        // buildOptions: {
        //   keystorePath: 'path/to/keystore',
        //   keystoreAlias: 'alias',
        // },
    },
};

export default config;
