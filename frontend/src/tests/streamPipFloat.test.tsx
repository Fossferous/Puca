/**
 * The in-app stream float (StreamPip) while streams are popped out to the OS
 * window: it shows the first watched stream that is NOT popped, hides only
 * when every watched stream is out there, and is picture only — audio is the
 * always-mounted StreamAudioHost's (streamAudioHost.test.tsx).
 *
 * The rule applies to every engine that puts the stream in a SEPARATE OS
 * window — the Doc-PiP grid, element PiP ('standard') and Safari's 'webkit'
 * — and not to the Android app's 'native' engine, which floats the whole
 * WebView with a full-viewport host over the page (the strip is never what
 * that window shows).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

let selected: number[] = [];
const STREAMS = new Map<number, { username: string; stream: MediaStream | null }>();
const subscribers = new Set<() => void>();

vi.mock('../components/voiceState', () => ({
    subscribeToStreamState: (cb: () => void) => { subscribers.add(cb); return () => { subscribers.delete(cb); }; },
    getSelectedStreams: () => [...selected],
    getStreamData: (id: number) => STREAMS.get(id) ?? undefined,
    getCurrentStreamingUserId: () => null,
}));
vi.mock('../api/remoteControl', () => ({
    requestControl: vi.fn(),
    stopControlling: vi.fn(),
    subscribeControl: () => () => {},
    getControlState: () => ({ controlling: null, hosting: null }),
}));

import { StreamPip } from '../components/StreamPip';
import type { PopoutMode } from '../components/streamDocPip';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
    Object.defineProperty(document, 'pictureInPictureEnabled', { value: true, configurable: true });
    Object.defineProperty(HTMLVideoElement.prototype, 'requestPictureInPicture', {
        value: () => Promise.resolve({}), configurable: true, writable: true,
    });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
    STREAMS.clear();
    STREAMS.set(1, { username: 'alice', stream: new MediaStream() });
    STREAMS.set(2, { username: 'bob', stream: new MediaStream() });
    selected = [1, 2];
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete (document as unknown as Record<string, unknown>).pictureInPictureEnabled;
    delete (HTMLVideoElement.prototype as unknown as Record<string, unknown>).requestPictureInPicture;
    vi.restoreAllMocks();
});

const pip = () => container.querySelector<HTMLElement>('.stream-pip')!;
const video = () => pip().querySelector('video')!;
const streamer = () => pip().querySelector('.pip-streamer')!.textContent;
const popButton = () => [...pip().querySelectorAll<HTMLButtonElement>('button')].find(b => /Pop out|Bring back/.test(b.title))!;

function render(popped: number[], mode: PopoutMode | null, opts: { docked?: boolean; toggle?: (id: number) => void } = {}) {
    act(() => {
        root.render(
            <StreamPip
                onExpand={() => {}}
                onClose={() => {}}
                docked={opts.docked}
                poppedStreams={popped}
                popoutMode={mode}
                onTogglePopout={opts.toggle ?? (() => {})}
            />,
        );
    });
}

describe('which stream the float shows', () => {
    it('nothing popped: the first watched stream, visible (positive control)', () => {
        render([], 'standard');
        expect(streamer()).toBe('alice');
        expect(video().srcObject).toBe(STREAMS.get(1)!.stream);
        expect(pip().style.visibility).not.toBe('hidden');
    });

    for (const mode of ['standard', 'webkit', 'docpip'] as const) {
        it(`${mode}: the stream in the OS window is never also in the float — it shows the next one`, () => {
            render([1], mode);
            expect(streamer()).toBe('bob');
            expect(video().srcObject).toBe(STREAMS.get(2)!.stream);
            expect(pip().style.visibility).not.toBe('hidden');
        });

        it(`${mode}: every watched stream popped hides the float, and unbinds its picture`, () => {
            selected = [1];
            render([1], mode);
            expect(pip().style.visibility).toBe('hidden');
            expect(video().srcObject ?? null).toBeNull();
        });

        it(`${mode}: the DOCKED strip hides with its row-collapsing class`, () => {
            selected = [1];
            render([1], mode, { docked: true });
            expect(pip().classList.contains('is-hidden')).toBe(true);
            expect(pip().getAttribute('style')).toBeNull();
        });
    }

    it('the grid: a stream that is not popped stays in the float even when another is', () => {
        render([2], 'docpip');
        expect(streamer()).toBe('alice');
        expect(pip().style.visibility).not.toBe('hidden');
    });

    it('closing the OS window (popped list empties) brings the stream back to the float', () => {
        selected = [1];
        render([1], 'standard');
        expect(pip().style.visibility).toBe('hidden');
        render([], 'standard');
        expect(pip().style.visibility).not.toBe('hidden');
        expect(video().srcObject).toBe(STREAMS.get(1)!.stream);
    });

    it('the Android app (native) is unchanged: the strip keeps its stream under the full-viewport host', () => {
        render([1], 'native', { docked: true });
        expect(streamer()).toBe('alice');
        expect(pip().classList.contains('is-hidden')).toBe(false);
    });

    it('the "+N more" badge counts only streams the float could still show, not the popped ones', () => {
        const badge = () => pip().querySelector('.pip-stream-count')?.textContent ?? null;
        STREAMS.set(3, { username: 'carol', stream: new MediaStream() });
        selected = [1, 2, 3];
        render([], 'docpip');
        expect(badge()).toBe('+2 more'); // positive control: the badge is there
        render([1], 'docpip');
        expect(streamer()).toBe('bob');
        expect(badge()).toBe('+1 more'); // carol; alice is in the OS window
        render([1, 3], 'docpip');
        expect(badge()).toBeNull(); // only bob is left, and he is the one shown
    });

    it('its Pop out pops the stream it SHOWS', () => {
        const toggle = vi.fn();
        render([1], 'docpip', { toggle });
        act(() => { popButton().click(); });
        expect(toggle).toHaveBeenCalledWith(2);
    });
});

describe('the float is picture only', () => {
    it('its <video> is muted, always — the audio host plays every stream', async () => {
        render([], 'standard');
        // Past any output-device routing: the old float unmuted itself once
        // its element had been routed, so an immediate read proves nothing.
        await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });
        expect(video().muted).toBe(true);
        render([1], 'docpip');
        await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });
        expect(video().muted).toBe(true);
    });
});
