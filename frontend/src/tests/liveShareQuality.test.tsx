/**
 * Stream quality while live: change a RUNNING share's resolution and frame
 * rate, up or down, without the picker and without dropping anyone.
 *
 * Before, a live share could only be LOWERED, and only by the struggling-
 * machine offer (applyShareQuality, reduce-only). The browser capability is
 * proven by e2e/share-quality-live-real-browser.mjs (a real capture going
 * 720p15 -> 1080p30 -> 480p10 with a loopback encoder following); these pin
 * the code around it: the helper, the transport rules, the panel, and the
 * two ways in (the arrow beside Stop Sharing, right-click your own stream).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { memoryLocalStorage } from './fixtures/fakeSink';
import { recapDisplayTrack, capWouldReduce } from '../api/rtc/shareHealth';

describe('recapDisplayTrack', () => {
    function track(after: MediaTrackSettings, refuse = false) {
        return {
            applyConstraints: vi.fn(async () => { if (refuse) throw new DOMException('no', 'OverconstrainedError'); }),
            getSettings: () => after,
        } as unknown as MediaStreamTrack & { applyConstraints: ReturnType<typeof vi.fn> };
    }

    it('may RAISE the cap — unlike the step-down, which only lowers', async () => {
        const t = track({ width: 1920, height: 1080, frameRate: 59.94 });
        const got = await recapDisplayTrack(t, 1920, 1080, 60);
        expect(t.applyConstraints).toHaveBeenCalledWith({ width: { max: 1920 }, height: { max: 1080 }, frameRate: { max: 60 } });
        expect(got).toEqual({ width: 1920, height: 1080, fps: 60 });
        // The step-down's guard would have refused exactly this:
        expect(capWouldReduce({ width: 1280, height: 720, frameRate: 30 }, 1920, 1080, 60)).toBe(false);
    });

    it('reports what the track produces, not what was asked for', async () => {
        const got = await recapDisplayTrack(track({ width: 1280, height: 720, frameRate: 30 }), 2560, 1440, 60);
        expect(got).toEqual({ width: 1280, height: 720, fps: 30 });
    });

    it('a refusal is null, never a size', async () => {
        await expect(recapDisplayTrack(track({ width: 1, height: 1 }, true), 1280, 720, 30)).resolves.toBeNull();
    });
});

describe('MediaManager.setShareQuality', () => {
    it('re-sizes the live share track, and is null when nothing is shared', async () => {
        const { MediaManager } = await import('../api/rtc/media');
        const m = new MediaManager();
        await expect(m.setShareQuality(1920, 1080, 60)).resolves.toBeNull();
        const applyConstraints = vi.fn(async () => {});
        const track = { applyConstraints, getSettings: () => ({ width: 1920, height: 1080, frameRate: 60 }) };
        (m as unknown as { screenShareStream: unknown }).screenShareStream = { getVideoTracks: () => [track] };
        await expect(m.setShareQuality(1920, 1080, 60)).resolves.toEqual({ width: 1920, height: 1080, fps: 60 });
        expect(applyConstraints).toHaveBeenCalledWith({ width: { max: 1920 }, height: { max: 1080 }, frameRate: { max: 60 } });
    });
});

describe('changeLiveShareQuality', () => {
    const live = vi.hoisted(() => ({
        size: { width: 1280, height: 720 } as { width: number; height: number } | null,
        ladder: false,
        result: null as { width: number; height: number; fps: number } | null,
        calls: [] as unknown[][],
    }));
    vi.mock('../api/webrtc', () => ({
        webrtcManager: {
            shareCaptureSize: () => live.size,
            setShareQuality: async (...a: unknown[]) => { live.calls.push(a); return live.result; },
            applyShareQuality: async () => false,
        },
    }));
    vi.mock('../api/rtc/sfuManager', () => ({ sfuManager: { shareHasLadder: () => live.ladder } }));

    // The REAL module (this file mocks it for the panel below), with the
    // transports under it mocked.
    const real = () => vi.importActual<typeof import('../api/rtc/shareHealthLive')>('../api/rtc/shareHealthLive');

    beforeEach(() => {
        live.size = { width: 1280, height: 720 };
        live.ladder = false;
        live.result = { width: 1920, height: 1080, fps: 60 };
        live.calls = [];
    });

    it('applies the chosen size to the running capture', async () => {
        const { changeLiveShareQuality } = await real();
        await expect(changeLiveShareQuality({ resolution: '1080', fps: 60 }))
            .resolves.toEqual({ kind: 'applied', capture: { width: 1920, height: 1080, fps: 60 } });
        expect(live.calls).toEqual([[1920, 1080, 60]]);
    });

    it('leaves a share with quality layers alone (each layer is a ratio fixed at publish)', async () => {
        live.ladder = true;
        const { changeLiveShareQuality } = await real();
        await expect(changeLiveShareQuality({ resolution: '1440', fps: 60 })).resolves.toEqual({ kind: 'ladder' });
        expect(live.calls).toEqual([]);
    });

    it('says so when nothing is shared, or the browser refused', async () => {
        const { changeLiveShareQuality } = await real();
        live.size = null;
        await expect(changeLiveShareQuality({ resolution: '720', fps: 30 })).resolves.toEqual({ kind: 'no-share' });
        live.size = { width: 1280, height: 720 };
        live.result = null;
        await expect(changeLiveShareQuality({ resolution: '720', fps: 30 })).resolves.toEqual({ kind: 'refused' });
    });
});

describe('the Stream quality panel', () => {
    const panel = vi.hoisted(() => ({
        outcome: { kind: 'applied', capture: { width: 1920, height: 1080, fps: 60 } } as unknown,
        asked: [] as unknown[],
        pending: null as null | (() => void),
    }));
    vi.mock('../api/rtc/shareHealthLive', async (orig) => ({
        ...(await orig<typeof import('../api/rtc/shareHealthLive')>()),
        shareCaptureSize: () => ({ width: 1280, height: 720 }),
        changeLiveShareQuality: (q: unknown) => {
            panel.asked.push(q);
            return new Promise((res) => {
                if (panel.pending === null) res(panel.outcome);
                else panel.pending = () => res(panel.outcome);
            });
        },
    }));

    let container: HTMLDivElement;
    let root: Root;
    beforeEach(() => {
        vi.stubGlobal('localStorage', memoryLocalStorage());
        panel.asked = [];
        panel.pending = null;
        panel.outcome = { kind: 'applied', capture: { width: 1920, height: 1080, fps: 60 } };
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });
    afterEach(() => {
        act(() => root.unmount());
        container.remove();
        vi.unstubAllGlobals();
    });

    async function open() {
        const { saveSettings, loadSettings } = await import('../components/settingsStore');
        saveSettings({ ...loadSettings(), shareResolution: '720', shareFps: 30 });
        const { LiveShareQualityModal } = await import('../components/LiveShareQualityModal');
        await act(async () => { root.render(<LiveShareQualityModal isOpen onClose={() => {}} />); });
        return loadSettings;
    }
    const button = (label: string) =>
        [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === label) as HTMLButtonElement;
    const text = () => container.textContent ?? '';

    it('opens on the remembered choice and what is live now', async () => {
        await open();
        expect(button('720p').className).toContain('selected');
        expect(button('30 fps').className).toContain('selected');
        expect(text()).toContain('Capturing 1280×720 now.');
    });

    it('a click applies to the running share at once, and is remembered for the next', async () => {
        const loadSettings = await open();
        await act(async () => { button('1080p').click(); });
        expect(panel.asked).toEqual([{ resolution: '1080', fps: 30 }]);
        expect(loadSettings().shareResolution).toBe('1080');
        expect(text()).toContain('Now capturing 1920×1080 at 60 fps.');
        await act(async () => { button('60 fps').click(); });
        expect(panel.asked[1]).toEqual({ resolution: '1080', fps: 60 });
        expect(loadSettings().shareFps).toBe(60);
    });

    it('says when the shared window is smaller than asked, instead of looking broken', async () => {
        panel.outcome = { kind: 'applied', capture: { width: 1600, height: 900, fps: 60 } };
        await open();
        await act(async () => { button('1440p').click(); });
        expect(text()).toContain('as large as what you are sharing goes');
    });

    it('explains a share sent at several sizes, and a refusal — both saved for next time', async () => {
        panel.outcome = { kind: 'ladder' };
        const loadSettings = await open();
        await act(async () => { button('1440p').click(); });
        expect(text()).toContain('sent at several sizes');
        expect(loadSettings().shareResolution).toBe('1440');
        panel.outcome = { kind: 'refused' };
        await act(async () => { button('Source').click(); });
        expect(text()).toContain('would not change the running capture');
    });

    it('one change at a time', async () => {
        panel.pending = () => {};
        await open();
        await act(async () => { button('1080p').click(); });
        expect(button('1440p').disabled).toBe(true);
        await act(async () => { panel.pending!(); await Promise.resolve(); });
        expect(button('1440p').disabled).toBe(false);
    });
});

describe('the ways in (VoicePanel is not mountable under vitest)', () => {
    const vp = readFileSync(join(__dirname, '..', 'components', 'VoicePanel.tsx'), 'utf8');
    const stage = readFileSync(join(__dirname, '..', 'components', 'StreamStage.tsx'), 'utf8');

    it('the arrow beside Share stays while live and opens the live panel then', () => {
        expect(vp).toMatch(/\{!isMobile && \(\s*<button\s+className="voice-btn vp-share-options"/);
        expect(vp).toMatch(/if \(isScreenSharing\) \{ setShowLiveQuality\(true\); return; \}/);
        expect(vp).toMatch(/<LiveShareQualityModal\s+isOpen=\{showLiveQuality && isScreenSharing\}/);
    });

    it('right-click your own stream → Stream Quality opens it by event', () => {
        expect(stage).toMatch(/requestShareQualityPanel\(\); \}\}\s*>\s*Stream Quality/);
        expect(vp).toMatch(/window\.addEventListener\(OPEN_SHARE_QUALITY_EVENT, open\)/);
    });

    it('stopping the share closes it', () => {
        expect(vp).toMatch(/setShowStreamAudio\(false\);\s*setShowLiveQuality\(false\);/);
    });

    it('positive control: the patterns are anchored in the real files', () => {
        expect(vp).toContain('LiveShareQualityModal');
        expect(stage).toContain('requestShareQualityPanel');
    });
});
