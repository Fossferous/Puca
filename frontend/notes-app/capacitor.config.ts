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
 *   - none of Púca's native plugins (keep-alive, FCM, the OTA updater). Its
 *     own small ones live in android/app/src/main/java/com/sovereign/notes
 *     (due-reminder alarms, the hourly refresh, location reminders, share)
 *     and every native dependency is listed in THIS folder's package.json,
 *     never in ../package.json, which would link it into Púca's APK.
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
    android: {
        backgroundColor: '#18191c',
    },
};

export default config;
