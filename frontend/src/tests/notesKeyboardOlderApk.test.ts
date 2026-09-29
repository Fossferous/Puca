/**
 * raiseNativeKeyboard against the REAL @capacitor/core, with the plugin
 * header an Android app hands the page — the path an installed APK takes,
 * which the faked-plugin tests (notesNative.test.ts) cannot show.
 *
 * The keyboard arrives with a NEW APK, but the web layer that calls it rides
 * an OTA to every installed one, including the Notes APKs from before the
 * method. There, Capacitor's proxy finds no `showKeyboard` in the plugin's
 * header and REJECTS the call ("not implemented"); the page must read that
 * as "no keyboard" and carry on. The method list is read from the Java
 * source itself, so an APK's header here is the one that APK really has:
 * this tree's methods (the new APK) and the same list without showKeyboard
 * (every APK up to 0.9.826).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PLUGIN_JAVA = readFileSync(
    join(FRONTEND, 'notes-app', 'android', 'app', 'src', 'main', 'java', 'com', 'sovereign', 'notes', 'NotesNativePlugin.java'),
    'utf8',
);
/** Every @PluginMethod the Java plugin declares: what its header lists. */
const JAVA_METHODS = [...PLUGIN_JAVA.matchAll(/@PluginMethod\s+public\s+void\s+(\w+)\s*\(/g)].map(m => m[1]);

type Win = typeof globalThis & { androidBridge?: unknown; Capacitor?: Record<string, unknown> };
const win = globalThis as Win;
const nativePromise = vi.fn(async (_plugin: string, method: string) => (method === 'showKeyboard' ? { shown: true } : {}));

// What Capacitor's Android bridge puts on the page before any app script
// runs: the bridge object (it is what makes getPlatform() say 'android') and
// the plugin headers. @capacitor/core reads both when it loads, and a
// registered plugin keeps THIS header object, reading its `methods` at call
// time — so one page can be shown as either APK by swapping the list.
const HEADER = { name: 'NotesNative', methods: [] as { name: string; rtype: string }[] };
win.androidBridge = { postMessage() {} };
win.Capacitor = { PluginHeaders: [HEADER], nativePromise };
const nn = await import('../notes/native/notesNative');
const { registerPlugin } = await import('@capacitor/core');

/** The page, inside an APK whose plugin header lists `methods`. */
function apkWith(methods: string[]) {
    HEADER.methods = methods.map(name => ({ name, rtype: 'promise' }));
}

beforeEach(() => { nativePromise.mockClear(); });

describe('the method is really there, by that name, on both sides', () => {
    it('NotesNativePlugin.java declares showKeyboard, and it is the name the page calls', () => {
        expect(JAVA_METHODS.length).toBeGreaterThan(10);
        expect(JAVA_METHODS).toContain('showKeyboard');
        const page = readFileSync(join(FRONTEND, 'src', 'notes', 'native', 'notesNative.ts'), 'utf8');
        expect(page).toMatch(/Native\.showKeyboard\(\)/);
        // Feature-detectable too: the info() list and its level say so.
        expect(PLUGIN_JAVA).toMatch(/"transcribe", "keyboard"/);
        expect(PLUGIN_JAVA).toMatch(/API_LEVEL = 3;/);
    });
});

describe('raiseNativeKeyboard through the real Capacitor proxy', () => {
    it('POSITIVE CONTROL — this APK: the call crosses the bridge, content-free, and answers shown', async () => {
        apkWith(JAVA_METHODS);
        expect(nn.notesNativeAvailable()).toBe(true);
        await expect(nn.raiseNativeKeyboard()).resolves.toBe(true);
        const calls = nativePromise.mock.calls.filter(c => c[1] === 'showKeyboard');
        expect(calls).toHaveLength(1);
        expect(calls[0][0]).toBe('NotesNative');
    });

    it('an APK from before the method: Capacitor rejects it, the page gets false, and nothing throws', async () => {
        apkWith(JAVA_METHODS.filter(m => m !== 'showKeyboard'));
        expect(nn.notesNativeAvailable(), 'the plugin itself is there — only the method is not').toBe(true);
        const unhandled = vi.fn();
        process.on('unhandledRejection', unhandled);
        try {
            await expect(nn.raiseNativeKeyboard()).resolves.toBe(false);
            await new Promise(r => setTimeout(r, 0));
        } finally {
            process.off('unhandledRejection', unhandled);
        }
        expect(unhandled).not.toHaveBeenCalled();
        expect(nativePromise.mock.calls.filter(c => c[1] === 'showKeyboard'), 'nothing reached the bridge').toHaveLength(0);
    });

    it('…and the rejection it swallows is Capacitor’s own "not implemented" (the case is real, not assumed)', async () => {
        apkWith(JAVA_METHODS.filter(m => m !== 'showKeyboard'));
        // The same proxy notesNative.ts registered (a second registration
        // hands it back), so this is exactly the call the page makes.
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const raw = registerPlugin<{ showKeyboard(): Promise<unknown> }>('NotesNative');
        warn.mockRestore();
        await expect(raw.showKeyboard()).rejects.toMatchObject({ code: 'UNIMPLEMENTED' });
    });
});
