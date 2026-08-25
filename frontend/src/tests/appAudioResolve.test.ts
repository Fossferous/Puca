/**
 * Tests for the "game only" stream-audio auto-detect (resolveAppAudio).
 *
 * Background: WebView2 usually reports a generic surface id instead of the
 * shared window's title, so title matching (`matchedPid`) rarely fires. The
 * field-diagnosed 0.5.89 bug had the old "last app" fallback resolving to
 * Puca itself. The current logic adds the audio-activity signal
 * (has_active_audio = the app's process tree audibly playing sound), which is
 * what actually identifies the game in practice.
 */
import { describe, it, expect } from 'vitest';
import { resolveAppAudio, appLabel, type CaptureApp } from '../api/appAudio';

const app = (pid: number, name: string, title: string | null, active = false): CaptureApp =>
    ({ pid, name, window_title: title, has_active_audio: active });

describe('resolveAppAudio', () => {
    it('returns undefined for an empty app list', () => {
        expect(resolveAppAudio([], null, null)).toBeUndefined();
    });

    it('window-title match wins over everything and is confident', () => {
        const apps = [app(10, 'game', 'Elden Ring', false), app(20, 'music', 'Spotify', true)];
        const r = resolveAppAudio(apps, 10, 'music');
        expect(r).toEqual({ pid: 10, name: 'Elden Ring', confident: true });
    });

    it('a single audible app is picked, not confident (never persisted)', () => {
        const apps = [app(10, 'game', 'Elden Ring', true), app(20, 'idle', 'Notepad', false)];
        const r = resolveAppAudio(apps, null, null);
        expect(r).toEqual({ pid: 10, name: 'Elden Ring', confident: false });
    });

    it('remembered app wins among several audible apps', () => {
        const apps = [app(10, 'game', 'Elden Ring', true), app(20, 'music', 'Spotify', true)];
        const r = resolveAppAudio(apps, null, 'game');
        expect(r?.pid).toBe(10);
        expect(r?.confident).toBe(false);
    });

    it('a stale remembered app is IGNORED when something else is audible', () => {
        // The old behavior returned the saved app unconditionally — that is how
        // a poisoned value hijacked every future stream.
        const apps = [app(10, 'game', 'Elden Ring', true), app(30, 'stale', 'Old Game', false)];
        const r = resolveAppAudio(apps, null, 'stale');
        expect(r?.pid).toBe(10); // the audible app, not the remembered one
    });

    it('multiple audible apps with only one windowed picks the windowed one', () => {
        const apps = [app(10, 'game', 'Elden Ring', true), app(20, 'svc-player', null, true)];
        const r = resolveAppAudio(apps, null, null);
        expect(r?.pid).toBe(10);
    });

    it('multiple audible windowed apps with no history broadens (undefined)', () => {
        const apps = [app(10, 'game', 'Elden Ring', true), app(20, 'music', 'Spotify', true)];
        expect(resolveAppAudio(apps, null, null)).toBeUndefined();
    });

    it('nothing audible falls back to the remembered app (silent game menu)', () => {
        const apps = [app(10, 'game', 'Elden Ring', false), app(20, 'idle', 'Notepad', false)];
        const r = resolveAppAudio(apps, null, 'game');
        expect(r?.pid).toBe(10);
        expect(r?.confident).toBe(false);
    });

    it('nothing audible and nothing remembered broadens (undefined)', () => {
        const apps = [app(10, 'game', 'Elden Ring', false)];
        expect(resolveAppAudio(apps, null, null)).toBeUndefined();
    });

    it('remembered-name matching accepts window title as well as process name', () => {
        const apps = [app(10, 'eldenring', 'Elden Ring', true)];
        expect(resolveAppAudio(apps, null, 'Elden Ring')?.pid).toBe(10);
    });

    it('tolerates apps missing the has_active_audio field (older payloads)', () => {
        const legacy = { pid: 10, name: 'game', window_title: 'Elden Ring' } as CaptureApp;
        expect(resolveAppAudio([legacy], null, null)).toBeUndefined(); // no signal → broaden
        expect(resolveAppAudio([legacy], 10, null)?.confident).toBe(true); // title match still works
    });
});

describe('appLabel', () => {
    it('prefers a non-empty window title, falls back to process name', () => {
        expect(appLabel(app(1, 'proc', 'Window'))).toBe('Window');
        expect(appLabel(app(1, 'proc', '  '))).toBe('proc');
        expect(appLabel(app(1, 'proc', null))).toBe('proc');
    });
});
