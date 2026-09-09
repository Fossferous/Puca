/**
 * The share dialog must show the remembered quality EVERY TIME IT OPENS.
 *
 * THE DEFECT THIS PINS, which shipped in 0.9.805 and defeated the feature it
 * was part of. The dialog read the stored resolution in a `useState`
 * initialiser, and VoicePanel renders it unconditionally (it returns null when
 * closed), so the read happened once per voice channel joined and never again.
 * A comment beside it claimed "this dialog is the only thing that writes them"
 * — false in the same release, which added the CPU-limited offer's "Lower it".
 *
 * So the exact sequence the feature exists for was broken: share at 1080p,
 * machine can't keep up, click Lower it, share again — and the dialog offered
 * 1080p and captured 1080p, with the stored 720p ignored for the rest of the
 * call.
 *
 * The sibling suite (shareQualityMemory.test.ts) covers the pure validator.
 * This one covers the half that was actually wrong: the dialog reading it.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

vi.mock('../api/platform', () => ({ isTauri: () => false }));

import ScreenShareModal from '../components/ScreenShareModal';
import { loadSettings, saveSettings } from '../components/settingsStore';

// A REAL localStorage for this file. The shared setup (src/tests/setup.ts)
// installs `{ getItem: vi.fn(), setItem: vi.fn(), ... }` — a store that
// remembers nothing — so any test of "is this value remembered?" would pass
// against an app that never wrote it. That is exactly the class of test this
// project's notes warn about: one that cannot fail for the thing it names.
const realStorage = () => {
    const map = new Map<string, string>();
    return {
        getItem: (k: string) => map.get(k) ?? null,
        setItem: (k: string, v: string) => { map.set(k, String(v)); },
        removeItem: (k: string) => { map.delete(k); },
        clear: () => map.clear(),
        key: (i: number) => [...map.keys()][i] ?? null,
        get length() { return map.size; },
    };
};

const props = {
    onClose: () => {},
    onCaptureScreen: async () => null,
    onGoLive: async () => {},
    onCancelAfterCapture: () => {},
};

/** The label of whichever resolution button is currently selected. */
function selected(div: HTMLElement): string | undefined {
    const groups = [...div.querySelectorAll('.stream-setting-group')];
    const res = groups.find(g => /resolution/i.test(g.querySelector('label')?.textContent ?? ''));
    return res?.querySelector('.stream-option.selected')?.textContent?.trim();
}

describe('the share dialog and the remembered quality', () => {
    beforeEach(() => {
        Object.defineProperty(window, 'localStorage', { value: realStorage(), configurable: true });
        // PROVE THE STORE STORES, with a value that is NOT the default.
        // Asserting '1080' here proved nothing: it is defaultSettings'
        // shareResolution, so a store that remembers nothing returns it too and
        // the guard passed against exactly the storeless mock it exists to
        // catch. '1440' can only come back if something really kept it.
        saveSettings({ ...loadSettings(), shareResolution: '1440', shareFps: 60 });
        expect(loadSettings().shareResolution, 'localStorage is not storing').toBe('1440');
        expect(loadSettings().shareFps).toBe(60);
        saveSettings({ ...loadSettings(), shareResolution: '1080', shareFps: 30 });
    });
    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('picks up a resolution written while it was closed', async () => {
        const div = document.createElement('div');
        document.body.appendChild(div);
        const root = createRoot(div);

        // Mounted CLOSED, as VoicePanel mounts it.
        await act(async () => { root.render(<ScreenShareModal isOpen={false} {...props} />); });
        await act(async () => { root.render(<ScreenShareModal isOpen={true} {...props} />); });
        expect(selected(div), 'opens on the stored default').toBe('1080p');

        // Close it, and let something else lower the quality — which is
        // precisely what "Lower it" does from the voice panel.
        await act(async () => { root.render(<ScreenShareModal isOpen={false} {...props} />); });
        saveSettings({ ...loadSettings(), shareResolution: '720', shareFps: 30 });

        // Re-open. Without the on-open re-read this still says 1080p, and the
        // next capture is 1920x1080 on a machine that just told us it cannot
        // encode it.
        await act(async () => { root.render(<ScreenShareModal isOpen={true} {...props} />); });
        expect(selected(div), 'must reflect the write that happened while closed').toBe('720p');

        await act(async () => root.unmount());
    });

    it('writes the choice as it is made, not on go-live', async () => {
        // POSITIVE CONTROL for the read above, and a defect in its own right:
        // somebody who turns the quality down and then backs out of the OS
        // picker has still told us something about their machine.
        const div = document.createElement('div');
        document.body.appendChild(div);
        const root = createRoot(div);
        await act(async () => { root.render(<ScreenShareModal isOpen={true} {...props} />); });

        const btn = [...div.querySelectorAll('.stream-option')]
            .find(b => b.textContent?.trim() === '720p') as HTMLButtonElement;
        expect(btn, 'the dialog offers 720p').toBeTruthy();
        await act(async () => { btn.click(); });

        expect(loadSettings().shareResolution).toBe('720');
        expect(selected(div)).toBe('720p');
        await act(async () => root.unmount());
    });
});
