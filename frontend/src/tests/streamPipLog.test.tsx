/**
 * Every popout outcome reaches puca.log on the desktop.
 *
 * The open question "does the desktop shell (WebView2) have Document PiP,
 * and does requestWindow work there?" was meant to be answered by a
 * `[doc-pip]` console line — but a release build keeps no WebView console:
 * only invoke('log_stream_diag') reaches the log file (lib.rs). The triage
 * grepped every puca*.log on the owner's machine: zero popout lines, ever.
 * The element-PiP refusals were console-only too. Each outcome now goes
 * through the shell as well, one line per attempt.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const h = vi.hoisted(() => ({ tauri: true, lines: [] as string[] }));

vi.mock('../api/platform', async importOriginal => ({
    ...(await importOriginal<typeof import('../api/platform')>()),
    isTauri: () => h.tauri,
}));
vi.mock('@tauri-apps/api/core', () => ({
    invoke: async (cmd: string, args?: { line?: string }) => {
        if (cmd === 'log_stream_diag' && args?.line) h.lines.push(args.line);
        return null;
    },
}));
vi.mock('../components/voiceState', () => ({
    subscribeToStreamState: () => () => {},
    getSelectedStreams: () => [1],
    getStreamData: () => ({ username: 'alice', stream: new MediaStream() }),
}));
vi.mock('../components/deviceStageResume', () => ({
    installBackgroundResumeAll: () => () => {},
}));
vi.mock('../api/mobileApp', () => ({
    nativePipSupported: async () => false,
    nativePipKnownSupported: () => false,
    enterNativePip: async () => false,
    exitNativePip: async () => {},
    onNativePipChange: async () => ({ remove() {} }),
}));

import { StreamDocPipWindow } from '../components/StreamDocPipWindow';
import { StreamPopout } from '../components/StreamPopout';
import { PIP_METADATA_TIMEOUT_MS } from '../components/streamPopout.utils';

type AnyWindow = Window & { documentPictureInPicture?: unknown };
let container: HTMLDivElement;
let root: Root;

/** Let the dynamic import + invoke chain land. */
async function flush() {
    await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); await new Promise(r => setTimeout(r, 0)); });
}

beforeEach(() => {
    h.tauri = true;
    h.lines = [];
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete (window as AnyWindow).documentPictureInPicture;
    delete (document as unknown as Record<string, unknown>).pictureInPictureEnabled;
    delete (HTMLVideoElement.prototype as unknown as Record<string, unknown>).requestPictureInPicture;
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('Doc PiP: the requestWindow outcome', () => {
    function mountGrid(requestWindow: () => Promise<Window>) {
        (window as AnyWindow).documentPictureInPicture = { requestWindow };
        act(() => {
            root.render(<StreamDocPipWindow userIds={[1]} onCloseOne={() => {}} onCloseAll={() => {}} onFallback={() => {}} />);
        });
    }

    it('a window that opened is logged as ok', async () => {
        const pipDoc = document.implementation.createHTMLDocument('pip');
        const fakeWin = { document: pipDoc, addEventListener() {}, close() {} } as unknown as Window;
        mountGrid(async () => fakeWin);
        await flush();
        expect(h.lines).toEqual(['[doc-pip] requestWindow ok']);
    });

    it('a refusal is logged with its reason — the case where the API exists but does not work', async () => {
        mountGrid(() => Promise.reject(new DOMException('needs a user gesture', 'NotAllowedError')));
        await flush();
        expect(h.lines).toHaveLength(1);
        expect(h.lines[0]).toMatch(/^\[doc-pip\] requestWindow rejected: NotAllowedError: needs a user gesture/);
    });

    it('web: the console only, nothing sent to a shell that is not there', async () => {
        h.tauri = false;
        mountGrid(() => Promise.reject(new DOMException('no', 'NotAllowedError')));
        await flush();
        expect(h.lines).toEqual([]);
    });
});

describe('element PiP: the outcome of every attempt', () => {
    function installElementPip(request: () => Promise<unknown>) {
        Object.defineProperty(document, 'pictureInPictureEnabled', { value: true, configurable: true });
        Object.defineProperty(HTMLVideoElement.prototype, 'requestPictureInPicture', {
            value: request, configurable: true, writable: true,
        });
    }
    const mountPopout = () => act(() => { root.render(<StreamPopout userId={1} onClose={() => {}} />); });
    const metadata = () => act(() => {
        container.querySelector('video')!.dispatchEvent(new Event('loadedmetadata'));
    });

    it('a refusal is logged with the engine and the reason', async () => {
        installElementPip(() => Promise.reject(new DOMException('disabled by policy', 'NotSupportedError')));
        mountPopout();
        metadata();
        await flush();
        expect(h.lines).toHaveLength(1);
        expect(h.lines[0]).toMatch(/^\[pip\] standard refused: NotSupportedError: disabled by policy/);
    });

    it('a window that opened is logged too (positive control for the refusal line)', async () => {
        installElementPip(() => Promise.resolve({}));
        mountPopout();
        metadata();
        await flush();
        expect(h.lines).toEqual(['[pip] standard entered']);
    });

    it('no metadata inside the activation window is logged', async () => {
        vi.useFakeTimers();
        installElementPip(() => Promise.resolve({}));
        mountPopout();
        act(() => { vi.advanceTimersByTime(PIP_METADATA_TIMEOUT_MS + 1); });
        vi.useRealTimers();
        await flush();
        expect(h.lines).toHaveLength(1);
        expect(h.lines[0]).toMatch(/^\[pip\] standard: no metadata within/);
    });
});
