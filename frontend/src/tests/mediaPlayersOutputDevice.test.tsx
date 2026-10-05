/**
 * The media players a user starts by hand follow Settings > Output Device.
 *
 * a8ae8634 routed voice, watched streams, notification sounds and the
 * profile clip preview. The players were left on the OS default: video
 * attachments in chat, Tasks' video/audio attachments, and Púca Notes' voice
 * notes (the attachment player, the recorder's review preview and the
 * composer's kept clip). On the web, Notes lives at /notes/ on Púca's origin
 * and shares its settings, so it follows the device chosen in Púca — the
 * owner's call (2026-09-28). The Android Notes app has no such setting, so
 * it stays on the default there.
 *
 * Each player gets `followOutputDeviceRef` (or `useOutputDeviceRef` where the
 * component also reads the element): routed on mount, re-routed on
 * settingsChanged and devicechange, released on unmount. The clip players are
 * in clipPlayersOutputDevice.test.tsx.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
    installDeviceChangeEvents, installElementSinks, memoryLocalStorage,
} from './fixtures/fakeSink';

vi.mock('../api/attachments', async (orig) => ({
    ...(await orig<typeof import('../api/attachments')>()),
    // Messages, Tasks and Notes all hold their URL.
    acquireAttachmentUrl: async (id: string) => ({ url: `blob:decrypted-${id}`, release: () => {} }),
}));
vi.mock('../notes/model/transcribe', () => ({
    transcribeClip: async () => ({ text: null, reason: null }),
}));

import {
    followOutputDevice, followOutputDeviceRef, loadSettings, saveSettings,
} from '../components/settingsStore';
import { useOutputDeviceRef } from '../hooks/useOutputDeviceRef';
import { MessageContent } from '../components/MessageContent';
import { TaskAttachments } from '../components/TaskAttachments';
import { NoteImages } from '../components/NoteImages';
import { AudioRecorder } from '../notes/components/AudioRecorder';
import { QuickAdd } from '../notes/components/QuickAdd';

const devices = new Set<string>();
let sinks: ReturnType<typeof installElementSinks>;
let deviceEvents: ReturnType<typeof installDeviceChangeEvents>;
let container: HTMLDivElement;
let root: Root;

function choose(outputDeviceId: string) {
    saveSettings({ ...loadSettings(), outputDeviceId });
}
const settle = async () => {
    await act(async () => { for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0)); });
};

// --- a fake microphone, the shape notesAudioUi.test.tsx installs -------------
let recorders: FakeRecorder[] = [];
class FakeRecorder {
    static isTypeSupported = (m: string) => m === 'audio/webm;codecs=opus';
    state = 'inactive';
    ondataavailable: ((e: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    opts: { mimeType: string };
    constructor(_stream: unknown, opts: { mimeType: string }) { this.opts = opts; recorders.push(this); }
    start() { this.state = 'recording'; }
    stop() {
        this.state = 'inactive';
        this.ondataavailable?.({ data: new Blob([new Uint8Array(64)], { type: this.opts.mimeType }) });
        this.onstop?.();
    }
}

beforeEach(() => {
    vi.stubGlobal('localStorage', memoryLocalStorage());
    devices.clear();
    devices.add('headset-1');
    devices.add('speakers-2');
    sinks = installElementSinks(devices);
    deviceEvents = installDeviceChangeEvents();
    recorders = [];
    (globalThis as unknown as { MediaRecorder: unknown }).MediaRecorder = FakeRecorder;
    navigator.mediaDevices.getUserMedia = vi.fn(async () => ({
        getTracks: () => [{ stop() {} }],
    }) as unknown as MediaStream) as unknown as typeof navigator.mediaDevices.getUserMedia;
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    choose('headset-1');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});

afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
    sinks.uninstall();
    deviceEvents.uninstall();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

/** Routed on mount, and still following: a Settings change reaches it. */
async function expectFollows(el: HTMLMediaElement | null) {
    expect(el, 'the player was never rendered').not.toBeNull();
    const sink = sinks.sinkOf(el!);
    expect(sink.calls).toEqual(['headset-1']);
    await act(async () => { await sink.settle(); });
    expect(sink.sinkId).toBe('headset-1');
    act(() => { choose('speakers-2'); });
    expect(sink.calls).toEqual(['headset-1', 'speakers-2']);
    await act(async () => { await sink.settle(); });
    expect(sink.sinkId).toBe('speakers-2');
}

describe('followOutputDevice', () => {
    it('routes at once, follows Settings, chases a returning device, and stops when told', async () => {
        const el = document.createElement('audio');
        const sink = sinks.sinkOf(el);
        devices.delete('headset-1');
        const stop = followOutputDevice(el);
        expect(sink.calls).toEqual(['headset-1']);
        await sink.settle();
        expect(sink.sinkId).toBe(''); // gone: fell back to the default

        devices.add('headset-1');
        deviceEvents.fire();
        await sink.settle();
        expect(sink.sinkId).toBe('headset-1');

        choose('speakers-2');
        await sink.settle();
        expect(sink.sinkId).toBe('speakers-2');

        stop();
        const before = sink.calls.length;
        choose('headset-1');
        deviceEvents.fire();
        expect(sink.calls).toHaveLength(before);
    });

    it('positive control: an element nobody follows is never routed', async () => {
        await act(async () => { root.render(<audio src="blob:x" controls />); });
        choose('speakers-2');
        expect(sinks.sinkOf(container.querySelector('audio')!).calls).toEqual([]);
    });
});

describe('followOutputDeviceRef', () => {
    function Player({ label }: { label: string }) {
        return <audio ref={followOutputDeviceRef} aria-label={label} controls />;
    }

    it('attaches ONCE per element: re-rendering does not re-route', async () => {
        await act(async () => { root.render(<Player label="a" />); });
        const el = container.querySelector('audio')!;
        await act(async () => { root.render(<Player label="b" />); });
        await act(async () => { root.render(<Player label="c" />); });
        expect(container.querySelector('audio')).toBe(el);
        expect(sinks.sinkOf(el).calls).toEqual(['headset-1']);
    });

    it('stops following when the element unmounts', async () => {
        await act(async () => { root.render(<Player label="a" />); });
        const el = container.querySelector('audio')!;
        await act(async () => { root.render(<div />); });
        choose('speakers-2');
        deviceEvents.fire();
        expect(sinks.sinkOf(el).calls).toEqual(['headset-1']);
    });
});

describe('useOutputDeviceRef', () => {
    /** What the component's own code saw in its RefObject (read in a click
     *  handler, the way ClipAttachment's play() reads it). */
    let seen: Array<HTMLVideoElement | null> = [];
    function Player({ show, tick }: { show: boolean; tick: number }) {
        const ref = useRef<HTMLVideoElement | null>(null);
        const sinkRef = useOutputDeviceRef(ref);
        return (
            <>
                <button type="button" onClick={() => { seen.push(ref.current); }}>peek {tick}</button>
                {show && <video ref={sinkRef} controls />}
            </>
        );
    }

    it('fills the RefObject, routes the element, and clears both on unmount', async () => {
        seen = [];
        await act(async () => { root.render(<Player show tick={0} />); });
        const el = container.querySelector('video')!;
        await act(async () => { container.querySelector('button')!.click(); });
        expect(seen).toEqual([el]); // the component can read its element
        expect(sinks.sinkOf(el).calls).toEqual(['headset-1']);
        // Stable across renders: a re-render must not detach and re-route.
        await act(async () => { root.render(<Player show tick={1} />); });
        expect(container.querySelector('video')).toBe(el);
        expect(sinks.sinkOf(el).calls).toEqual(['headset-1']);

        await act(async () => { root.render(<Player show={false} tick={2} />); });
        seen = [];
        await act(async () => { container.querySelector('button')!.click(); });
        expect(seen).toEqual([null]);
        choose('speakers-2');
        expect(sinks.sinkOf(el).calls).toEqual(['headset-1']);
    });
});

describe('every hand-started player follows the chosen Output Device', () => {
    it('a video attachment in chat', async () => {
        const href = 'sovereign-enc:vid1?k=KEY&m=video%2Fmp4';
        await act(async () => { root.render(<MessageContent content={`[clip.mp4](${href})`} members={[]} />); });
        await settle();
        await expectFollows(container.querySelector('.message-video video'));
    });

    it('an audio attachment in chat', async () => {
        const href = 'sovereign-enc:aud1?k=KEY&m=audio%2Fmpeg';
        await act(async () => { root.render(<MessageContent content={`[m83-midnight-city.mp3](${href})`} members={[]} />); });
        await settle();
        await expectFollows(container.querySelector('.message-audio audio'));
    });

    it("a Task's video attachment", async () => {
        await act(async () => {
            root.render(<TaskAttachments refs={[{ href: 'sovereign-enc:v1?k=KEY&m=video%2Fmp4', name: 'walkthrough.mp4' }]} canEdit={false} onRemove={() => {}} />);
        });
        await settle();
        await expectFollows(container.querySelector('video.ta-video'));
    });

    it("a Task's audio attachment", async () => {
        await act(async () => {
            root.render(<TaskAttachments refs={[{ href: 'sovereign-enc:a1?k=KEY&m=audio%2Fmpeg', name: 'memo.mp3' }]} canEdit={false} onRemove={() => {}} />);
        });
        await settle();
        await expectFollows(container.querySelector('audio.ta-audio'));
    });

    it('a voice note in a list or note (NoteImages, shared by Tasks and Notes)', async () => {
        const opened = JSON.stringify([{ href: 'sovereign-enc:clip1?k=KEY&m=audio%2Fwebm%3Bcodecs%3Dopus', name: 'voice-1.webm' }]);
        await act(async () => { root.render(<NoteImages opened={opened} editable={false} />); });
        await settle();
        await expectFollows(container.querySelector('.ni-audio audio'));
    });

    it("the Notes recorder's review preview", async () => {
        await act(async () => { root.render(<AudioRecorder onSave={() => true} onCancel={() => {}} />); });
        await settle();
        expect(recorders, 'the recorder never took the microphone').toHaveLength(1);
        await act(async () => { recorders[0].stop(); });
        await settle();
        await expectFollows(document.querySelector('audio.notes-recorder-preview'));
    });

    it("the Notes composer's kept clip", async () => {
        await act(async () => {
            root.render(<QuickAdd onCreate={async () => true} content={{ text: true, pictures: true }} openSignal={1} />);
        });
        await settle();
        await act(async () => { (document.querySelector('button[aria-label="Voice note"]') as HTMLButtonElement).click(); });
        await settle();
        expect(recorders, 'the recorder never took the microphone').toHaveLength(1);
        await act(async () => { recorders[0].stop(); });
        await settle();
        const keep = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Keep');
        expect(keep, 'there was no take to keep').toBeTruthy();
        await act(async () => { keep!.click(); });
        await settle();
        await expectFollows(document.querySelector('.qa-clip audio'));
    });
});
