/**
 * Every recorded video a person plays in Púca gets Púca's own player
 * (VideoPlayer: volume, speed and fullscreen at every width), not the
 * engine's controls: a chat or DM attachment, a posted clip, the approved
 * clip's preview and a Task's video. Each one's volume composes with
 * Settings > Output Volume; a chat video under an unrevealed spoiler is
 * inert; a Task video the engine cannot open is its download button.
 *
 * The player itself is videoPlayer.test.tsx; holding a fullscreen video's
 * copy and player is attachmentAutoload.test.tsx; the clip preview's gate is
 * clipNoPreview.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { memoryLocalStorage } from './fixtures/fakeSink';

vi.mock('../api/attachments', async (orig) => ({
    ...(await orig<typeof import('../api/attachments')>()),
    acquireAttachmentUrl: async (id: string) => ({ url: `blob:decrypted-${id}`, release: () => {} }),
}));
const clip = vi.hoisted(() => ({ attach: vi.fn(async (_el: HTMLVideoElement) => {}) }));
vi.mock('../api/clips/clipPlayback', () => ({
    CLIP_DOWNLOAD_MAX_BYTES: 1e12,
    createClipPlayer: () => ({ mode: 'mse', attach: clip.attach, destroy: () => {} }),
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

import { MessageContent } from '../components/MessageContent';
import { TaskAttachments } from '../components/TaskAttachments';
import { ClipAttachment } from '../components/ClipAttachment';
import { ClipComposerModal } from '../components/ClipComposerModal';
import { encodeClipRef } from '../api/clips/clipRef';
import { loadSettings, saveSettings } from '../components/settingsStore';
import { __resetVideoPlayerMemory } from '../components/videoPlayerModel';
import type { SealedInfo } from '../api/clips/clipTypes';
import type { ClipPolicy } from '../api/clips/clipsUiState';

let container: HTMLDivElement;
let root: Root;
const settle = async () => {
    await act(async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); });
};
const labels = (frame: Element) => [...frame.querySelectorAll('.vpl-bar button')].map((b) => b.getAttribute('aria-label'));

/** Púca's player around this element, with the three controls the owner
 *  asked for, and the engine's controls nowhere. */
function expectPucaPlayer(video: HTMLVideoElement | null) {
    expect(video, 'no player rendered').not.toBeNull();
    expect(video!.hasAttribute('controls')).toBe(false);
    expect(video!.hasAttribute('autoplay')).toBe(false);
    const frame = video!.closest('.vpl');
    expect(frame, 'the video is not inside VideoPlayer').not.toBeNull();
    const l = labels(frame!);
    expect(l.some((x) => /^Volume, /.test(x ?? '') || x === 'Mute'), `volume in ${l}`).toBe(true);
    expect(l.some((x) => /^Playback speed, /.test(x ?? '')), `speed in ${l}`).toBe(true);
    expect(l).toContain('Full screen');
    expect(document.querySelectorAll('video[controls]')).toHaveLength(0);
    return frame as HTMLElement;
}

beforeEach(() => {
    vi.stubGlobal('localStorage', memoryLocalStorage());
    __resetVideoPlayerMemory();
    saveSettings({ ...loadSettings(), outputVolume: 50 });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
    clip.attach.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});

afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

const chatVideo = '[portrait.mp4](sovereign-enc:vid1?k=KEY&m=video%2Fmp4)';

describe('a video attachment in a chat or DM', () => {
    it("is Púca's player, at the Output Volume", async () => {
        await act(async () => { root.render(<MessageContent content={chatVideo} members={[]} />); });
        await settle();
        const video = container.querySelector<HTMLVideoElement>('.message-video video');
        const frame = expectPucaPlayer(video);
        expect(video!.getAttribute('src')).toBe('blob:decrypted-vid1');
        expect(frame.getAttribute('aria-label')).toBe('Video player: portrait.mp4');
        expect(video!.volume).toBeCloseTo(0.5, 5);
        // The download chip stays under it.
        expect(container.querySelector('.message-video button.message-attachment')?.textContent).toContain('portrait.mp4');
    });

    it('under a spoiler not yet revealed it is inert; revealed, it can be used', async () => {
        await act(async () => { root.render(<MessageContent content={`||${chatVideo}||`} members={[]} />); });
        await settle();
        const frame = container.querySelector<HTMLElement>('.spoiler .vpl')!;
        expect(frame).not.toBeNull();
        expect(frame.hasAttribute('inert')).toBe(true);
        expect(frame.tabIndex).toBe(-1);
        await act(async () => { container.querySelector<HTMLElement>('.spoiler')!.click(); });
        expect(container.querySelector('.spoiler.revealed')).not.toBeNull();
        expect(frame.hasAttribute('inert')).toBe(false);
        expect(frame.tabIndex).toBe(0);
        // Pressing the player does not hide the spoiler again.
        await act(async () => { frame.querySelector<HTMLButtonElement>('.vpl-center')!.click(); });
        expect(container.querySelector('.spoiler.revealed')).not.toBeNull();
    });

    it('positive control: a plain (unspoilered) video is not inert', async () => {
        await act(async () => { root.render(<MessageContent content={chatVideo} members={[]} />); });
        await settle();
        expect(container.querySelector('.vpl')!.hasAttribute('inert')).toBe(false);
    });
});

describe("a Task's video", () => {
    const refs = [{ href: 'sovereign-enc:tv1?k=KEY&m=video%2Fmp4', name: 'walkthrough.mp4' }];

    it("is Púca's player in a 240x160 tile, at the Output Volume", async () => {
        await act(async () => { root.render(<TaskAttachments refs={refs} canEdit={false} onRemove={() => {}} />); });
        await settle();
        const video = container.querySelector<HTMLVideoElement>('video.ta-video');
        const frame = expectPucaPlayer(video);
        expect(frame.classList.contains('ta-video-frame')).toBe(true);
        expect(video!.volume).toBeCloseTo(0.5, 5);
    });

    it('one the engine cannot open becomes its download button, not an empty player', async () => {
        await act(async () => { root.render(<TaskAttachments refs={refs} canEdit={false} onRemove={() => {}} />); });
        await settle();
        await act(async () => { container.querySelector('video.ta-video')!.dispatchEvent(new Event('error')); });
        expect(container.querySelector('video')).toBeNull();
        expect(container.querySelector('button.ta-file')?.textContent).toContain('walkthrough.mp4');
    });
});

const clipHref = encodeClipRef({
    key: new Uint8Array(32).fill(1), noncePrefix: new Uint8Array(8).fill(2), clipId: '0f5b4b1a-6a1c-4d5e-8f2b-1c3d4e5f6a7b',
    videoCodec: 'avc1.640029', audioCodec: 'mp4a.40.2', durationMs: 65_000, width: 1920, height: 1080, totalCipherBytes: 1234,
    parts: ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'], partDurMs: [0, 65_000],
});

describe('a posted clip', () => {
    it("plays in Púca's player on its MediaSource, knowing its length before MSE does", async () => {
        await act(async () => { root.render(<ClipAttachment href={clipHref} />); });
        await act(async () => { container.querySelector<HTMLButtonElement>('.clip-attachment-play')!.click(); });
        await settle();
        const video = container.querySelector<HTMLVideoElement>('video.clip-attachment-video');
        const frame = expectPucaPlayer(video);
        expect(frame.classList.contains('clip-attachment-player')).toBe(true);
        expect(clip.attach).toHaveBeenCalledWith(video);
        expect(video!.getAttribute('preload')).toBe('none');
        // jsdom's element has no duration (NaN): the manifest's 1:05 is shown.
        expect(frame.querySelector('.vpl-time')?.textContent).toBe('0:00 / 1:05');
        expect(frame.querySelector('[role="slider"][aria-label="Seek"]')?.getAttribute('aria-valuemax')).toBe('65');
        expect(video!.volume).toBeCloseTo(0.5, 5);
    });
});

describe("the approved clip's preview", () => {
    it("is Púca's player, only once everyone approved", async () => {
        const sealedInfo = {
            clipId: 'clip-1', durationMs: 30_000, leadInMs: 0, lostMs: 0, width: 1920, height: 1080,
            partCount: 2, totalCipherBytes: 4_000_000, videoCodec: 'avc1.640029', audioCodec: null, partDurMs: [0, 30_000],
        } as SealedInfo;
        const policy = {
            available: true, serverClipsEnabled: true, viewerIsOwner: false, serverId: 's1', maxSeconds: 60,
            pinnedChannelId: 5, defaultTargetChannelId: 5, voiceChannelPerms: null,
        } as ClipPolicy;
        await act(async () => {
            root.render(<ClipComposerModal
                isOpen onClose={() => {}} bufferedSeconds={60} maxSeconds={60}
                onSeal={async () => sealedInfo} localOnly={false} voiceChannelId={7}
                policy={policy} getDeclaredParticipants={() => []}
            />);
        });
        await settle();
        expect(document.querySelector('video')).toBeNull();
        const button = (text: string) => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as HTMLButtonElement;
        await act(async () => { button('Prepare clip').click(); });
        await settle();
        expect(document.querySelector('video')).toBeNull();
        await act(async () => { button('Request approval').click(); });
        await settle();
        const video = document.querySelector<HTMLVideoElement>('video.clip-preview-video');
        const frame = expectPucaPlayer(video);
        expect(frame.classList.contains('clip-preview-player')).toBe(true);
        expect(frame.querySelector('.vpl-time')?.textContent).toBe('0:00 / 0:30');
        expect(video!.volume).toBeCloseTo(0.5, 5);
    });
});
