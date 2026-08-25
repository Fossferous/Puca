/**
 * Document PiP (W4): the pure mode/toggle rules, the stylesheet copy, and
 * the window component against a stubbed requestWindow — tiles render into
 * the (fake) PiP document, the user closing the window closes every tile,
 * and a rejection falls back rather than dying.
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../components/voiceState', () => ({
    getStreamData: (id: number) => ({ username: `user-${id}`, stream: null }),
    subscribeToStreamState: () => () => {},
}));
vi.mock('../components/deviceStageResume', () => ({
    installBackgroundResumeAll: () => () => {},
}));

import { docPipSupported, popoutMode, togglePopped, copyStyleSheetsInto } from '../components/streamDocPip';
import { StreamDocPipWindow } from '../components/StreamDocPipWindow';

type AnyWindow = Window & { documentPictureInPicture?: unknown };

afterEach(() => {
    delete (window as AnyWindow).documentPictureInPicture;
});

describe('togglePopped — grid vs single-engine semantics', () => {
    it('multi (docpip): membership toggles, any number', () => {
        expect(togglePopped([], 7, true)).toEqual([7]);
        expect(togglePopped([7], 9, true)).toEqual([7, 9]);
        expect(togglePopped([7, 9], 7, true)).toEqual([9]);
    });
    it('single (legacy): the newest pick replaces; re-click closes', () => {
        expect(togglePopped([], 7, false)).toEqual([7]);
        expect(togglePopped([7], 9, false)).toEqual([9]);
        expect(togglePopped([9], 9, false)).toEqual([]);
    });
});

describe('popoutMode', () => {
    it('jsdom has no PiP API at all: null; a stubbed Doc-PiP flips it to docpip', () => {
        expect(docPipSupported()).toBe(false);
        expect(popoutMode()).toBeNull();
        (window as AnyWindow).documentPictureInPicture = { requestWindow: async () => window };
        expect(docPipSupported()).toBe(true);
        expect(popoutMode()).toBe('docpip');
    });
});

describe('copyStyleSheetsInto', () => {
    it('clones styles and stylesheet links, not scripts', () => {
        const style = document.createElement('style');
        style.textContent = '.x{color:red}';
        document.head.appendChild(style);
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = '/app.css';
        document.head.appendChild(link);

        const target = document.implementation.createHTMLDocument('pip');
        copyStyleSheetsInto(target);
        expect(target.head.querySelectorAll('style')).toHaveLength(1);
        expect(target.head.querySelectorAll('link[rel="stylesheet"]')).toHaveLength(1);
        expect(target.head.querySelectorAll('script')).toHaveLength(0);
        style.remove();
        link.remove();
    });
});

describe('StreamDocPipWindow', () => {
    let container: HTMLDivElement;
    let root: Root;
    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });
    afterEach(() => { act(() => root.unmount()); container.remove(); });

    function fakePipWindow() {
        const doc = document.implementation.createHTMLDocument('pip');
        const listeners = new Map<string, () => void>();
        const win = {
            document: doc,
            close: vi.fn(),
            addEventListener: (name: string, cb: () => void) => listeners.set(name, cb),
        } as unknown as Window;
        return { win, doc, listeners };
    }

    it('renders a tile per popped stream into the PiP document; pagehide closes all', async () => {
        const { win, doc, listeners } = fakePipWindow();
        (window as AnyWindow).documentPictureInPicture = { requestWindow: vi.fn(async () => win) };
        const onCloseAll = vi.fn();
        const onCloseOne = vi.fn();
        await act(async () => {
            root.render(
                <StreamDocPipWindow
                    userIds={[7, 9]}
                    onCloseOne={onCloseOne}
                    onCloseAll={onCloseAll}
                    onFallback={() => { throw new Error('must not fall back when the API works'); }}
                />,
            );
        });
        const tiles = doc.querySelectorAll('.doc-pip-tile');
        expect(tiles).toHaveLength(2);
        expect(doc.body.textContent).toContain('user-7');
        expect(doc.body.textContent).toContain('user-9');
        // Every tile's video is hard-muted — the audio path stays elsewhere.
        for (const v of Array.from(doc.querySelectorAll('video'))) {
            expect((v as HTMLVideoElement).muted).toBe(true);
        }
        // Per-tile close reaches the right stream.
        await act(async () => {
            (doc.querySelector('.doc-pip-tile-close') as HTMLButtonElement).click();
        });
        expect(onCloseOne).toHaveBeenCalledWith(7);
        // The USER closes the OS window: every tile closes.
        act(() => { listeners.get('pagehide')?.(); });
        expect(onCloseAll).toHaveBeenCalled();
    });

    it('a rejected requestWindow falls back instead of rendering nothing forever', async () => {
        (window as AnyWindow).documentPictureInPicture = {
            requestWindow: vi.fn(async () => { throw new Error('no activation'); }),
        };
        const onFallback = vi.fn();
        await act(async () => {
            root.render(
                <StreamDocPipWindow userIds={[7]} onCloseOne={() => {}} onCloseAll={() => {}} onFallback={onFallback} />,
            );
        });
        expect(onFallback).toHaveBeenCalledTimes(1);
    });

    it('unmounting closes the OS window (navigation must not leak it)', async () => {
        const { win } = fakePipWindow();
        (window as AnyWindow).documentPictureInPicture = { requestWindow: vi.fn(async () => win) };
        await act(async () => {
            root.render(
                <StreamDocPipWindow userIds={[7]} onCloseOne={() => {}} onCloseAll={() => {}} onFallback={() => {}} />,
            );
        });
        act(() => root.unmount());
        expect(win.close).toHaveBeenCalled();
    });
});
