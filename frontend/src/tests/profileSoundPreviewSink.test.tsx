/**
 * The own-clip preview in Profile > Join / Leave Sounds plays on the Output
 * Device chosen in Settings, and starts only once it is routed there — a new
 * Audio() is born on the OS default, so play() before the switch lands would
 * put the start of the clip on the wrong device. (Found in the 2026-09-28
 * sweep for audio that ignored Output Device.)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushMicrotasks, installElementSinks, memoryLocalStorage } from './fixtures/fakeSink';

vi.mock('../api/profile', () => ({
    getProfile: async () => ({
        id: 1, username: 'someone', display_name: null,
        avatar_url: null, allow_dms_from_server_members: true, show_online_status: true,
        join_sound_file_id: 'clip-1', leave_sound_file_id: null,
    }),
    updateProfile: async () => {},
    updateAvatar: async () => {},
}));
vi.mock('../api/uploads', () => ({
    uploadFile: async () => ({ id: 'f1' }),
    getFileUrl: (id: string) => 'http://x/files/' + id,
    discardUpload: () => {},
    isAudioType: (m: string) => m.startsWith('audio/'),
    MAX_SOUND_BYTES: 1024 * 1024,
    formatFileSize: (n: number) => `${n} B`,
}));
vi.mock('../api/authedMedia', () => ({
    fetchFileUrl: async () => 'blob:clip-1',
    cachedFileUrl: () => null,
    clearFileCache: () => {},
}));

import { UserProfileSettings } from '../components/UserProfileSettings';
import { loadSettings, saveSettings } from '../components/settingsStore';

const RealAudio = window.Audio;
let container: HTMLDivElement;
let root: Root;
let sinks: ReturnType<typeof installElementSinks>;
/** Every Audio() the component built — the preview is never in the DOM. */
let built: HTMLAudioElement[] = [];
/** The sink each play() started on. */
let playedOn: string[] = [];

beforeEach(() => {
    vi.stubGlobal('localStorage', memoryLocalStorage());
    sinks = installElementSinks(new Set(['headset-1']));
    built = [];
    playedOn = [];
    vi.stubGlobal('Audio', function (src?: string) {
        const el = new RealAudio(src);
        built.push(el);
        return el;
    });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
        playedOn.push(sinks.sinkOf(this).sinkId || 'default');
        return Promise.resolve();
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    sinks.uninstall();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

async function openAndClickPlay() {
    await act(async () => {
        root.render(<UserProfileSettings isOpen={true} onClose={() => {}} />);
        await flushMicrotasks();
    });
    const play = [...container.querySelectorAll('button')].find(b => /Play/.test(b.textContent ?? ''));
    expect(play).toBeTruthy();
    await act(async () => { play!.click(); await flushMicrotasks(); });
}

describe('profile clip preview', () => {
    it('plays on the chosen device, and not before it is routed there', async () => {
        saveSettings({ ...loadSettings(), outputDeviceId: 'headset-1' });
        await openAndClickPlay();
        expect(built).toHaveLength(1);
        expect(sinks.sinkOf(built[0]).calls).toEqual(['headset-1']);
        expect(playedOn).toEqual([]); // the switch has not landed yet
        await act(async () => { await sinks.sinkOf(built[0]).settle(); await flushMicrotasks(); });
        expect(playedOn).toEqual(['headset-1']);
    });

    it('on the default device it plays at once', async () => {
        await openAndClickPlay();
        expect(playedOn).toEqual(['default']);
    });
});
