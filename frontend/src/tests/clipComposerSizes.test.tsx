/**
 * The composer's duration chips say what each length COSTS before the seal is
 * paid for: a size per chip, priced from what this buffer has actually been
 * recording (ring bytes over buffered seconds) once there is enough of it, and
 * from the preset before that. A length past the app's download/trim limits
 * says so while it can still be changed.
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

let replayState: Record<string, unknown> = {};
vi.mock('../api/clips/replayBuffer', () => ({
    attachPreview: vi.fn(), discardSeal: vi.fn(), trimSeal: vi.fn(), undoTrim: vi.fn(), uploadAndBuild: vi.fn(),
    getReplayState: () => replayState,
    subscribeReplay: () => () => { },
}));
vi.mock('../api/platform', async (importOriginal) => ({ ...(await importOriginal<typeof import('../api/platform')>()), isTauri: () => true, isMobile: () => false, isAndroidApp: () => false }));

const { ClipComposerModal } = await import('../components/ClipComposerModal');
const { NO_CLIP_POLICY } = await import('../api/clips/clipsUiState');
const { clipBytesPerSecond } = await import('../api/clips/clipComposerLogic');

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
    replayState = { phase: 'armed', bufferedMs: 0, ringBytes: 0, kbps: 0, fps: 0, presetId: '1080p30', hasSystemAudio: true, sealed: null, upload: null, notice: null, error: null };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

async function open(bufferedSeconds: number, maxSeconds: number) {
    await act(async () => {
        root.render(<ClipComposerModal isOpen onClose={() => { }} bufferedSeconds={bufferedSeconds} maxSeconds={maxSeconds}
            onSeal={async () => { throw new Error('not in this test'); }} localOnly voiceChannelId={null} policy={NO_CLIP_POLICY}
            getDeclaredParticipants={() => []} />);
    });
}
const chipTexts = () => [...container.querySelectorAll('.clip-duration-chip')].map(c => c.textContent);

describe('composer chips carry their size', () => {
    it('prices from the preset before the buffer has a measured rate', () => {
        expect(clipBytesPerSecond({ ringBytes: 0, bufferedMs: 0, presetId: '1080p30' })).toBe((6_000_000 + 128_000) / 8);
        // Too little footage to trust (a keyframe dominates the first seconds).
        expect(clipBytesPerSecond({ ringBytes: 5_000_000, bufferedMs: 4_000, presetId: '1080p30' })).toBe((6_000_000 + 128_000) / 8);
    });

    it('prices from what the buffer has actually recorded once there is enough of it', () => {
        // 60 s holding 60 MB = 1 MB/s, whatever the preset claimed.
        expect(clipBytesPerSecond({ ringBytes: 60_000_000, bufferedMs: 60_000, presetId: '720p30' })).toBe(1_000_000);
    });

    it('each chip shows its approximate size', async () => {
        replayState = { ...replayState, bufferedMs: 300_000, ringBytes: 300 * 765_000 };
        await open(300, 120);
        // 765 000 B/s: 30 s ≈ 22 MB, 1:00 ≈ 44 MB, 2:00 ≈ 88 MB.
        expect(chipTexts()).toEqual(['0:30≈ 22 MB', '1:00≈ 44 MB', '2:00≈ 88 MB']);
    });

    it('a length past the in-app download and trim limits says so before the seal', async () => {
        // 4K-ish: 2.27 MB/s × 600 s ≈ 1.27 GiB.
        replayState = { ...replayState, bufferedMs: 600_000, ringBytes: 600 * 2_270_000 };
        await open(600, 600);
        expect(container.textContent).toMatch(/too large to download or trim in the app/);
    });

    it('positive control: a clip within the limits carries no such warning', async () => {
        replayState = { ...replayState, bufferedMs: 120_000, ringBytes: 120 * 765_000 };
        await open(120, 120);
        expect(container.textContent).not.toMatch(/too large to/);
    });
});
