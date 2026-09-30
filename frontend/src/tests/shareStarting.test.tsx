/**
 * The Share button shows the share as on from the click, because WebView2
 * holds a window capture for up to 5 s waiting for its first frame (owner,
 * 2026-09-30: "it just has to look like it's done so that users aren't waiting
 * around on it"). useShareStarting.ts has the why.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { useShareStarting, SHARE_STARTING_MAX_MS } from '../components/useShareStarting';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Api = ReturnType<typeof useShareStarting>;
let api: Api;
let host: HTMLDivElement;
let root: Root;

function Probe({ live, onApi }: { live: boolean; onApi: (a: Api) => void }) {
    onApi(useShareStarting(live));
    return null;
}
const show = (live: boolean) => act(() => { root.render(<Probe live={live} onApi={a => { api = a; }} />); });

describe('useShareStarting', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        host = document.createElement('div');
        root = createRoot(host);
    });
    afterEach(() => {
        act(() => root.unmount());
        vi.useRealTimers();
    });

    it('shows from the click until the share is live', () => {
        show(false);
        expect(api.showing).toBe(false);
        act(() => api.begin());
        expect(api.showing).toBe(true);
        act(() => { vi.advanceTimersByTime(4300); }); // the measured WebView2 wait
        expect(api.showing).toBe(true);
        show(true);
        expect(api.showing).toBe(false);
    });

    it('end() clears it: a cancelled picker, a failed go-live, the dialog closing', () => {
        show(false);
        act(() => api.begin());
        act(() => api.end());
        expect(api.showing).toBe(false);
    });

    it('a capture that never answers cannot leave the button stuck', () => {
        show(false);
        act(() => api.begin());
        act(() => { vi.advanceTimersByTime(SHARE_STARTING_MAX_MS - 1); });
        expect(api.showing).toBe(true);
        act(() => { vi.advanceTimersByTime(1); });
        expect(api.showing).toBe(false);
    });

    it('the backstop stays out of a share that went live', () => {
        show(false);
        act(() => api.begin());
        show(true);
        act(() => { vi.advanceTimersByTime(SHARE_STARTING_MAX_MS * 2); });
        // Live, then stopped later: the old click must not come back as "starting".
        show(false);
        expect(api.showing).toBe(false);
    });

    it('never shows "starting" over a share that is already live', () => {
        show(true);
        act(() => api.begin());
        expect(api.showing).toBe(false);
    });

    it('going live finishes the start: stopping the share never shows "starting" again', () => {
        show(false);
        act(() => api.begin());
        show(true);
        show(false); // stopped, with no end() call in between
        expect(api.showing).toBe(false);
    });

    it('the backstop outlasts the capture wait it covers', () => {
        expect(SHARE_STARTING_MAX_MS).toBeGreaterThan(5000);
    });
});

describe('VoicePanel wiring (VoicePanel is not mountable under vitest)', () => {
    const vp = readFileSync(join(__dirname, '..', 'components', 'VoicePanel.tsx'), 'utf8');
    const shareButton = vp.slice(vp.indexOf('vp-screenshare'), vp.indexOf('vp-share-options'));
    const capture = vp.slice(vp.indexOf('onCaptureScreen={async'), vp.indexOf('onGoLive={async'));

    it('the button looks on, busy and "starting" while it starts, and ignores a second click', () => {
        expect(shareButton).toMatch(/isScreenSharing \|\| shareStarting\.showing \? 'active screen-share'/);
        expect(shareButton).toMatch(/shareStarting\.showing \? ' starting'/);
        expect(shareButton).toMatch(/aria-busy=\{shareStarting\.showing\}/);
        expect(shareButton).toMatch(/onClick=\{async \(\) => \{\s*\/\/[^\n]*\n\s*if \(shareStarting\.showing\) return;/);
        expect(shareButton).toContain("shareStarting.showing ? 'Starting your stream…'");
    });

    it('starts BEFORE the picker is awaited, and ends on a cancelled picker', () => {
        const begin = capture.indexOf('shareStarting.begin()');
        expect(begin).toBeGreaterThan(-1);
        expect(begin).toBeLessThan(capture.indexOf('await webrtcManager.getScreenShareStream('));
        expect(capture).toMatch(/goLiveEnd\('cancelled'\);\s*shareStarting\.end\(\);/);
    });

    it('ends when the dialog closes (every go-live outcome closes it) and on a cancel after capture', () => {
        expect(vp).toMatch(/onClose=\{\(\) => \{ setShowStreamSettings\(false\); shareStarting\.end\(\); \}\}/);
        expect(vp).toMatch(/onCancelAfterCapture=\{\(\) => \{[^}]*shareStarting\.end\(\);/);
    });

    it('positive control: the slices are anchored in the real file', () => {
        expect(shareButton.length).toBeGreaterThan(100);
        expect(capture.length).toBeGreaterThan(100);
    });
});

describe('the look', () => {
    const css = readFileSync(join(__dirname, '..', 'components', 'VoicePanel.css'), 'utf8');
    it('pulses a few times, never forever', () => {
        const rule = css.slice(css.indexOf('.voice-btn.vp-screenshare.starting'));
        const body = rule.slice(0, rule.indexOf('}'));
        expect(body).toMatch(/animation: pulse-live [\d.]+s ease-in-out \d+;/);
        expect(body).not.toContain('infinite');
    });
});
