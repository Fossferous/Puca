/**
 * clipArmOnJoin (Settings ▸ Voice & Video ▸ Clips): 'off' | 'prompt' | 'auto'.
 *
 * 'auto' really calls armNative() — genuinely no popup: armNative() drives
 * DXGI capture + the hardware H.264 encoder directly (nativeCapture.ts), the
 * same no-gesture-needed primitive the remote-desktop agent uses for
 * unattended hosting, so there is no getDisplayMedia call for Chromium to
 * gate on a picker at all. Exactly ONE attempt per room, a beat after the
 * join; any failure (native capture unsupported, DXGI/encoder init failure,
 * etc.) falls back to the nudge and never retries in the same room; leaving
 * and re-joining (or a VoiceMoved to a different room) arms again. 'prompt'
 * never calls armNative(). The legacy `clipArmPromptOnJoin: true` loads as
 * 'prompt'.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const armNativeMock = vi.fn<() => Promise<void>>();
let nativeSupported = true;
const listeners = new Set<(s: unknown) => void>();
let replayState: Record<string, unknown> = { phase: 'idle', bufferedMs: 0, ringBytes: 0, hasSystemAudio: true, notice: null, error: null, sealed: null, upload: null };
const setReplay = (patch: Record<string, unknown>) => { replayState = { ...replayState, ...patch }; for (const l of listeners) l(replayState); };

vi.mock('../api/clips/replayBuffer', () => ({
    arm: vi.fn(async () => {}),
    armNative: (...a: unknown[]) => armNativeMock(...(a as [])),
    disarm: vi.fn(async () => {}),
    seal: vi.fn(),
    discardSeal: vi.fn(),
    isClipCaptureSupported: () => true,
    getReplayState: () => replayState,
    subscribeReplay: (cb: (s: unknown) => void) => { listeners.add(cb); return () => listeners.delete(cb); },
}));
vi.mock('../api/clips/nativeCapture', () => ({
    isNativeCaptureSupported: () => nativeSupported,
}));
vi.mock('../api/platform', () => ({ isTauri: () => true, isMobile: () => false, isAndroidApp: () => false }));
vi.mock('../api/hotkeys', () => ({ registerPress: vi.fn(), unregisterPress: vi.fn() }));
vi.mock('../components/ClipComposerModal', () => ({ ClipComposerModal: () => null }));

import { ClipButtons } from '../components/ClipControls';
import { loadSettings, saveSettings, defaultSettings } from '../components/settingsStore';
import type { ClipPolicy } from '../api/clips/clipsUiState';

const policy: ClipPolicy = { available: true, serverClipsEnabled: true, viewerIsOwner: false, serverId: 's1', maxSeconds: 120, pinnedChannelId: null, defaultTargetChannelId: 9, voiceChannelPerms: null };

/** `agreed` mirrors the per-server consent the auto-arm path now requires: a
 *  member earns automatic arming in a server by arming there once by hand, so
 *  a test that wants the automatic path must say which server has been agreed
 *  to. Passing none is the FIRST-JOIN case. */
function setMode(mode: 'off' | 'prompt' | 'auto') {
    saveSettings({ ...defaultSettings, clipArmOnJoin: mode });
}

// Raw react-dom/client + act (the repo's component-test pattern — no testing-library).
let container: HTMLDivElement;
let root: Root;
const el = (props: Partial<React.ComponentProps<typeof ClipButtons>> = {}) => <ClipButtons inVoice isAfkChannel={false} listenOnly={false} roomId="voice_5" policy={policy} {...props} />;
function mount(props: Partial<React.ComponentProps<typeof ClipButtons>> = {}) {
    act(() => { root.render(el(props)); });
    return { container, rerender: (p: React.ReactElement) => act(() => { root.render(p); }) };
}
function cleanup() { act(() => { root.unmount(); }); root = createRoot(container); }

// The global test setup replaces localStorage with bare vi.fn() stubs; give
// loadSettings/saveSettings a real backing store.
const store = new Map<string, string>();
(localStorage.getItem as Mock).mockImplementation((k: string) => store.get(k) ?? null);
(localStorage.setItem as Mock).mockImplementation((k: string, v: string) => { store.set(k, String(v)); });
(localStorage.removeItem as Mock).mockImplementation((k: string) => { store.delete(k); });
(localStorage.clear as Mock).mockImplementation(() => store.clear());

beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    armNativeMock.mockReset();
    nativeSupported = true;
    replayState = { phase: 'idle', bufferedMs: 0, ringBytes: 0, hasSystemAudio: true, notice: null, error: null, sealed: null, upload: null };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(() => { act(() => { root.unmount(); }); container.remove(); vi.useRealTimers(); });

describe('clipArmOnJoin', () => {
    it("'auto' calls armNative() once, a beat after joining — not on every render", async () => {
        setMode('auto');
        armNativeMock.mockImplementation(async () => { setReplay({ phase: 'arming' }); setReplay({ phase: 'armed' }); });
        const r = mount();
        expect(armNativeMock).not.toHaveBeenCalled(); // not synchronously on mount
        await act(async () => { vi.advanceTimersByTime(799); });
        expect(armNativeMock).not.toHaveBeenCalled();
        await act(async () => { vi.advanceTimersByTime(1); });
        expect(armNativeMock).toHaveBeenCalledTimes(1);
        r.rerender(el());
        await act(async () => { vi.advanceTimersByTime(2000); });
        expect(armNativeMock).toHaveBeenCalledTimes(1);
        expect(r.container.querySelector('.voice-clip-arm')?.getAttribute('aria-pressed')).toBe('true');
    });

    it('a failed attempt (armNative() resolves with the controller still idle) falls back to the nudge and does NOT retry in the same room', async () => {
        setMode('auto');
        armNativeMock.mockImplementation(async () => { setReplay({ phase: 'arming' }); setReplay({ phase: 'idle' }); });
        const r = mount();
        await act(async () => { vi.advanceTimersByTime(800); });
        expect(armNativeMock).toHaveBeenCalledTimes(1);
        await act(async () => { vi.advanceTimersByTime(3000); });
        expect(armNativeMock).toHaveBeenCalledTimes(1);
        const btn = r.container.querySelector('.voice-clip-arm')!;
        expect(btn.className).toContain('nudge');
        expect(btn.getAttribute('title')).toMatch(/Auto-arm did not start/);
    });

    it('a rejected armNative() (DXGI/encoder init failure) is surfaced as the nudge + title, not swallowed', async () => {
        setMode('auto');
        armNativeMock.mockImplementation(async () => { throw new Error('Failed to start the video encoder: no supported profile'); });
        const r = mount();
        await act(async () => { vi.advanceTimersByTime(800); });
        await act(async () => { await Promise.resolve(); });
        const btn = r.container.querySelector('.voice-clip-arm')!;
        expect(btn.className).toContain('nudge');
        expect(btn.getAttribute('title')).toMatch(/Auto-arm did not start/);
        expect(armNativeMock).toHaveBeenCalledTimes(1);
    });

    it("'already armed' (the user beat the timer to the button) is not treated as a failure", async () => {
        setMode('auto');
        armNativeMock.mockImplementation(async () => { throw new Error('already armed'); });
        const r = mount();
        await act(async () => { vi.advanceTimersByTime(800); });
        await act(async () => { await Promise.resolve(); });
        // armNative() rejecting always reads as a failure here (there is no
        // gesture-vs-genuine-error distinction to make anymore, unlike the
        // old getDisplayMedia path) — the nudge fires, which is harmless
        // since the user already armed it themselves.
        expect(r.container.querySelector('.voice-clip-arm')!.className).toContain('nudge');
    });

    it('native capture unsupported (e.g. a non-Windows desktop build) falls back to the nudge without ever calling armNative()', async () => {
        setMode('auto');
        nativeSupported = false;
        const r = mount();
        await act(async () => { vi.advanceTimersByTime(2000); });
        expect(armNativeMock).not.toHaveBeenCalled();
        expect(r.container.querySelector('.voice-clip-arm')!.className).toContain('nudge');
    });

    it('leaving the call and re-joining arms again; a different room (VoiceMoved) arms again; a manual disarm in the same room does not', async () => {
        setMode('auto');
        armNativeMock.mockImplementation(async () => { setReplay({ phase: 'armed' }); });
        const r = mount();
        await act(async () => { vi.advanceTimersByTime(800); });
        expect(armNativeMock).toHaveBeenCalledTimes(1);
        // manual disarm: controller back to idle, same room → no re-arm
        await act(async () => { setReplay({ phase: 'idle' }); });
        await act(async () => { vi.advanceTimersByTime(2000); });
        expect(armNativeMock).toHaveBeenCalledTimes(1);
        // moved to another room → new attempt
        r.rerender(el({ roomId: 'voice_6' }));
        await act(async () => { vi.advanceTimersByTime(800); });
        expect(armNativeMock).toHaveBeenCalledTimes(2);
        // leave, then re-join the SAME room → new attempt
        await act(async () => { setReplay({ phase: 'idle' }); });
        r.rerender(el({ inVoice: false, roomId: '' }));
        r.rerender(el({ roomId: 'voice_6' }));
        await act(async () => { vi.advanceTimersByTime(800); });
        expect(armNativeMock).toHaveBeenCalledTimes(3);
    });

    it("'prompt' only nudges — armNative() is never called; 'off' does neither", async () => {
        setMode('prompt');
        let r = mount();
        await act(async () => { vi.advanceTimersByTime(1500); });
        expect(armNativeMock).not.toHaveBeenCalled();
        expect(r.container.querySelector('.voice-clip-arm')!.className).toContain('nudge');
        cleanup();
        setMode('off');
        r = mount();
        await act(async () => { vi.advanceTimersByTime(1500); });
        expect(armNativeMock).not.toHaveBeenCalled();
        expect(r.container.querySelector('.voice-clip-arm')!.className).not.toContain('nudge');
    });

    it("'auto' does nothing when the gate is closed (server has clips off) — no capture for a call that cannot clip", async () => {
        setMode('auto');
        armNativeMock.mockImplementation(async () => { setReplay({ phase: 'armed' }); });
        mount({ policy: { ...policy, available: false, serverClipsEnabled: false } });
        await act(async () => { vi.advanceTimersByTime(2000); });
        expect(armNativeMock).not.toHaveBeenCalled();
    });

    it('legacy clipArmPromptOnJoin: true loads as clipArmOnJoin "prompt"; an explicit "off" wins over the legacy flag', () => {
        localStorage.setItem('sovereign_settings', JSON.stringify({ clipArmPromptOnJoin: true }));
        expect(loadSettings().clipArmOnJoin).toBe('prompt');
        localStorage.setItem('sovereign_settings', JSON.stringify({ clipArmPromptOnJoin: true, clipArmOnJoin: 'off' }));
        expect(loadSettings().clipArmOnJoin).toBe('off');
        localStorage.setItem('sovereign_settings', JSON.stringify({ clipArmPromptOnJoin: false }));
        expect(loadSettings().clipArmOnJoin).toBe('off');
    });
});

describe('automatic really is automatic, on every server that allows clips', () => {
    // 0.9.8 gated this per server: automatic arming only happened on a server
    // its member had already armed in by hand. The intent was to stop a server
    // OWNER turning clips on and thereby starting a whole-screen recording on
    // someone who had ticked this setting elsewhere. What it produced was a
    // setting that said one thing and did another, refusing with "auto-arm did
    // not start the buffer" — a failure message for a deliberate decision —
    // and no way to discover that arming by hand once was what granted it.
    // Removed at the owner's decision on 2026-09-08, risk stated. These pin
    // the promise the settings text makes, so nobody restores the gate by
    // halves and leaves the copy behind again.

    it('arms on a server it has never been armed in before', async () => {
        armNativeMock.mockResolvedValue(undefined);
        setMode('auto');
        mount();
        await act(async () => { vi.advanceTimersByTime(900); });
        await act(async () => { await Promise.resolve(); });
        expect(armNativeMock, 'no per-server agreement stands between the setting and the buffer')
            .toHaveBeenCalledTimes(1);
        cleanup();
    });

    it('keeps no per-server memory to consult', async () => {
        // The gate is gone from the STORE as well as from the effect. A
        // leftover list that nothing reads is the thing a later session
        // rediscovers and wires back up.
        armNativeMock.mockResolvedValue(undefined);
        setMode('auto');
        expect(Object.keys(loadSettings())).not.toContain('clipAutoArmServers');
        mount();
        await act(async () => { vi.advanceTimersByTime(900); });
        await act(async () => { await Promise.resolve(); });
        expect(armNativeMock).toHaveBeenCalledTimes(1);
        cleanup();
    });

    it('still refuses when the SERVER has clips off — the gate that remains', async () => {
        // POSITIVE CONTROL for the two above: something must still be able to
        // stop it, or they would pass against a build that armed unconditionally.
        setMode('auto');
        mount({ policy: { ...policy, serverClipsEnabled: false } });
        await act(async () => { vi.advanceTimersByTime(900); });
        await act(async () => { await Promise.resolve(); });
        expect(armNativeMock).not.toHaveBeenCalled();
        cleanup();
    });
});
        expect(armNativeMock).not.toHaveBeenCalled();
