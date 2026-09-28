/**
 * Both clip players follow Settings > Output Device (see
 * mediaPlayersOutputDevice.test.tsx for the rest).
 *
 *   - ClipAttachment (a clip posted in chat). Its play() is the COMPONENT's,
 *     not a click on the native controls: it runs as soon as the clip is
 *     playable. So it waits for routing to land first, or the start of the
 *     clip plays on the OS default.
 *   - ClipComposerModal's review preview. It exists only once every
 *     participant approved (clipNoPreview.test.ts), so the test drives the
 *     real flow: choose, seal, request, approved.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { installElementSinks, memoryLocalStorage } from './fixtures/fakeSink';

const player = vi.hoisted(() => ({
    attach: vi.fn(async (_el: HTMLVideoElement) => {}),
    destroy: vi.fn(),
}));
vi.mock('../api/clips/clipPlayback', () => ({
    CLIP_DOWNLOAD_MAX_BYTES: 1e12,
    createClipPlayer: () => ({ mode: 'mse', attach: player.attach, destroy: player.destroy }),
    downloadClipBytes: vi.fn(),
}));

vi.mock('../api/clips/replayBuffer', () => ({
    attachPreview: () => ({ ready: new Promise<number>(() => {}), detach: () => {} }),
    discardSeal: vi.fn(),
    getReplayState: () => ({ sealedAt: Date.now() }),
    subscribeReplay: () => () => {},
    trimSeal: vi.fn(),
    undoTrim: vi.fn(),
    uploadAndBuild: vi.fn(),
}));
vi.mock('../api/clips/clipProposals', () => ({
    cancelClip: vi.fn(),
    clearOutgoingClip: vi.fn(),
    ClipProposeError: class extends Error {},
    getClipProposalState: () => ({ outgoing: null, incoming: [], notice: null }),
    // Solo (log-attested): the server answers approved at once.
    proposeClip: vi.fn(async () => ({ clipId: 'clip-1', status: 'approved' })),
    subscribeClipProposals: () => () => {},
}));
vi.mock('../api/clips/clipComposerLogic', async (orig) => ({
    ...(await orig<typeof import('../api/clips/clipComposerLogic')>()),
    resolveClipTarget: () => ({ kind: 'ok', channel: { id: 5, name: 'clips' } }),
}));
vi.mock('../api/servers', async (orig) => ({
    ...(await orig<typeof import('../api/servers')>()),
    listChannels: vi.fn(async () => []),
}));

import { ClipAttachment } from '../components/ClipAttachment';
import { ClipComposerModal } from '../components/ClipComposerModal';
import { encodeClipRef } from '../api/clips/clipRef';
import { loadSettings, saveSettings } from '../components/settingsStore';
import type { SealedInfo } from '../api/clips/clipTypes';
import type { ClipPolicy } from '../api/clips/clipsUiState';

const devices = new Set(['headset-1', 'speakers-2']);
let sinks: ReturnType<typeof installElementSinks>;
let container: HTMLDivElement;
let root: Root;
/** The sink each play() started on. */
let playedOn: string[] = [];

function choose(outputDeviceId: string) {
    saveSettings({ ...loadSettings(), outputDeviceId });
}
const settle = async () => {
    await act(async () => { for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0)); });
};
const button = (text: string) =>
    [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === text) as HTMLButtonElement | undefined;

beforeEach(() => {
    vi.stubGlobal('localStorage', memoryLocalStorage());
    sinks = installElementSinks(devices);
    playedOn = [];
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
        playedOn.push(sinks.sinkOf(this).sinkId || 'default');
        return Promise.resolve();
    });
    player.attach.mockClear();
    choose('headset-1');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});

afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
    sinks.uninstall();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

const href = encodeClipRef({
    key: new Uint8Array(32).fill(1), noncePrefix: new Uint8Array(8).fill(2), clipId: '0f5b4b1a-6a1c-4d5e-8f2b-1c3d4e5f6a7b',
    videoCodec: 'avc1.640029', audioCodec: 'mp4a.40.2', durationMs: 5000, width: 1920, height: 1080, totalCipherBytes: 1234,
    parts: ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'], partDurMs: [0, 5000],
});

describe('a clip posted in chat (ClipAttachment)', () => {
    it('is routed as its player mounts, and starts only once it is on the chosen device', async () => {
        await act(async () => { root.render(<ClipAttachment href={href} />); });
        await act(async () => { (container.querySelector('.clip-attachment-play') as HTMLButtonElement).click(); });
        await settle();
        const video = container.querySelector('video.clip-attachment-video') as HTMLVideoElement;
        expect(video, 'the player never mounted').not.toBeNull();
        expect(player.attach).toHaveBeenCalledWith(video);
        const sink = sinks.sinkOf(video);
        expect(sink.calls[0]).toBe('headset-1'); // the mount routed it
        // attach() resolved, but the switch has not landed: play() must wait.
        expect(playedOn).toEqual([]);
        await act(async () => { await sink.settle(); });
        await settle();
        expect(playedOn).toEqual(['headset-1']);
    });

    it('follows a Settings change while it is up', async () => {
        await act(async () => { root.render(<ClipAttachment href={href} />); });
        await act(async () => { (container.querySelector('.clip-attachment-play') as HTMLButtonElement).click(); });
        await settle();
        const video = container.querySelector('video.clip-attachment-video') as HTMLVideoElement;
        const sink = sinks.sinkOf(video);
        await act(async () => { await sink.settle(); });
        await settle();
        const before = sink.calls.length;
        act(() => { choose('speakers-2'); });
        expect(sink.calls.slice(before)).toEqual(['speakers-2']);
        await act(async () => { await sink.settle(); });
        expect(sink.sinkId).toBe('speakers-2');
    });
});

describe("the clip composer's review preview (ClipComposerModal)", () => {
    const sealedInfo: SealedInfo = {
        clipId: 'clip-1', durationMs: 30_000, leadInMs: 0, lostMs: 0, width: 1920, height: 1080,
        partCount: 2, totalCipherBytes: 4_000_000, videoCodec: 'avc1.640029', audioCodec: null, partDurMs: [0, 30_000],
    } as SealedInfo;
    const policy = {
        available: true, serverClipsEnabled: true, viewerIsOwner: false, serverId: 's1', maxSeconds: 60,
        pinnedChannelId: 5, defaultTargetChannelId: 5, voiceChannelPerms: null,
    } as ClipPolicy;

    it('is routed when it appears after approval, and follows a Settings change', async () => {
        await act(async () => {
            root.render(<ClipComposerModal
                isOpen onClose={() => {}} bufferedSeconds={60} maxSeconds={60}
                onSeal={async () => sealedInfo} localOnly={false} voiceChannelId={7}
                policy={policy} getDeclaredParticipants={() => []}
            />);
        });
        await settle();
        expect(document.querySelector('video'), 'a preview before approval is the regression clipNoPreview guards').toBeNull();
        await act(async () => { button('Prepare clip')!.click(); });
        await settle();
        const request = button('Request approval');
        expect(request, 'never reached the sealed step').toBeTruthy();
        expect(request!.disabled).toBe(false);
        await act(async () => { request!.click(); });
        await settle();
        const video = document.querySelector('video.clip-preview-video') as HTMLVideoElement;
        expect(video, 'never reached the approved preview').not.toBeNull();
        const sink = sinks.sinkOf(video);
        expect(sink.calls).toEqual(['headset-1']);
        await act(async () => { await sink.settle(); });
        act(() => { choose('speakers-2'); });
        expect(sink.calls).toEqual(['headset-1', 'speakers-2']);
        await act(async () => { await sink.settle(); });
        expect(sink.sinkId).toBe('speakers-2');
    });
});
