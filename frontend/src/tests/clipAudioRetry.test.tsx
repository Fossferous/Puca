/**
 * THE SYSTEM-AUDIO RECOVERY ROUTING — which button a broken-audio clip
 * session offers, and what it calls.
 *
 * Three sessions can lose system audio, and each has a DIFFERENT correct
 * recovery. A native session with an audio graph gets "Retry system audio"
 * (retrySystemAudio splices a fresh loopback in, keeping all footage); a
 * native session armed with no audio rail at all gets "Restart buffer" with
 * footage-lost copy (there is nothing to splice into); a picker session keeps
 * "Pick again" (its one recovery, and re-running the dialog on a NATIVE
 * session would be wrong twice — it destroys the footage AND switches the
 * capture mode under the user).
 *
 * Harness: clipAutoArm.test.tsx's pattern — replayBuffer fully mocked, state
 * driven by hand, raw react-dom/client + act.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const retryMock = vi.fn<() => Promise<void>>(async () => {});
const armMock = vi.fn(async () => {});
const armNativeMock = vi.fn(async () => {});
const disarmMock = vi.fn(async () => {});
const listeners = new Set<(s: unknown) => void>();
let replayState: Record<string, unknown> = {};
const baseArmed = () => ({
    phase: 'armed', bufferedMs: 30_000, ringBytes: 1 << 20, droppedFrames: 0, fps: 30, kbps: 6000,
    presetId: '1080p30', width: 1920, height: 1080,
    hasSystemAudio: false, systemAudioLost: 'died', systemAudioDevice: null, hasMic: true,
    videoCodec: 'avc1', audioCodec: 'mp4a.40.2', captureReason: 'primary',
    notice: 'System audio capture ended: device invalidated', error: null,
    sealed: null, sealedAt: null, upload: null,
});

vi.mock('../api/clips/replayBuffer', () => ({
    arm: (...a: unknown[]) => armMock(...(a as [])),
    armNative: () => armNativeMock(),
    disarm: (...a: unknown[]) => disarmMock(...(a as [])),
    seal: vi.fn(),
    discardSeal: vi.fn(),
    retrySystemAudio: () => retryMock(),
    isClipCaptureSupported: () => true,
    getReplayState: () => replayState,
    subscribeReplay: (cb: (s: unknown) => void) => { listeners.add(cb); return () => listeners.delete(cb); },
}));
vi.mock('../api/clips/nativeCapture', () => ({ isNativeCaptureSupported: () => true }));
vi.mock('../api/platform', () => ({ isTauri: () => true, isMobile: () => false, isAndroidApp: () => false }));
vi.mock('../api/hotkeys', () => ({ registerPress: vi.fn(), unregisterPress: vi.fn() }));
vi.mock('../components/ClipComposerModal', () => ({ ClipComposerModal: () => null }));

import { ClipStatusRow } from '../components/ClipControls';

let container: HTMLDivElement;
let root: Root;
function mount() {
    act(() => { root.render(<ClipStatusRow />); });
}
function buttons(): string[] {
    return [...container.querySelectorAll('button')].map(b => b.textContent ?? '');
}

beforeEach(() => {
    retryMock.mockClear();
    armMock.mockClear();
    armNativeMock.mockClear();
    disarmMock.mockClear();
    replayState = baseArmed();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(() => { act(() => { root.unmount(); }); container.remove(); });

describe('the broken-system-audio recovery routing', () => {
    it('a native session with a mic offers Retry, and Retry calls retrySystemAudio', async () => {
        mount();
        expect(buttons()).toContain('Retry system audio');
        expect(buttons()).not.toContain('Pick again');
        const btn = [...container.querySelectorAll('button')]
            .find(b => b.textContent === 'Retry system audio')!;
        await act(async () => { btn.click(); });
        expect(retryMock).toHaveBeenCalledTimes(1);
        expect(armMock, 'must NOT open the picker on a native session').not.toHaveBeenCalled();
        expect(disarmMock, 'must NOT destroy the footage').not.toHaveBeenCalled();
    });

    it('a native session with NO audio rail offers only the honest restart', async () => {
        replayState = { ...baseArmed(), hasMic: false, systemAudioLost: 'start-failed', notice: 'No system audio' };
        mount();
        const labels = buttons();
        expect(labels.some(l => l.startsWith('Restart buffer'))).toBe(true);
        expect(labels).not.toContain('Retry system audio');
        const btn = [...container.querySelectorAll('button')]
            .find(b => (b.textContent ?? '').startsWith('Restart buffer'))!;
        await act(async () => { btn.click(); });
        expect(disarmMock).toHaveBeenCalledTimes(1);
        expect(armNativeMock).toHaveBeenCalledTimes(1);
        expect(retryMock, 'retry cannot work without a graph and must not be offered or fired').not.toHaveBeenCalled();
    });

    it('a picker session keeps Pick again — the control that was always its recovery', async () => {
        replayState = { ...baseArmed(), captureReason: null, systemAudioLost: null, notice: 'No system audio — pick again' };
        mount();
        expect(buttons()).toContain('Pick again');
        expect(buttons()).not.toContain('Retry system audio');
        const btn = [...container.querySelectorAll('button')].find(b => b.textContent === 'Pick again')!;
        await act(async () => { btn.click(); });
        expect(armMock).toHaveBeenCalledWith({ repick: true });
        expect(retryMock).not.toHaveBeenCalled();
    });

    it('POSITIVE CONTROL: healthy system audio shows no recovery control at all', () => {
        replayState = { ...baseArmed(), hasSystemAudio: true, systemAudioLost: null, notice: null };
        mount();
        expect(buttons()).toEqual([]);
    });
});
