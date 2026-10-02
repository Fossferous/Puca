/**
 * The banner a device shows while the ACCOUNT's call is on another device:
 * "You're in Lounge on your PC", with Leave (ends it there) and Move here
 * (ends it there and joins here). It reads the own-voice store, which only a
 * server that sent OwnVoiceState on this socket ever fills — so against an old
 * server it never appears, and neither of its buttons can send a frame that
 * server would answer with an alert().
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import fixture from './fixtures/ownVoiceState.json';
import { OwnVoiceBanner } from '../components/OwnVoiceBanner';
import { applyOwnVoiceFrame, resetOwnVoice } from '../api/ownVoice';

type Frame = { type: string; payload?: Record<string, unknown> };
const [ELSEWHERE, NONE] = fixture as Frame[];

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const onLeave = vi.fn();
const onMoveHere = vi.fn();

async function mount(inCallHere = false) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
        root!.render(<OwnVoiceBanner inCallHere={inCallHere} onLeave={onLeave} onMoveHere={onMoveHere} />);
    });
}
const banner = () => host?.querySelector('.own-voice-banner') ?? null;
const buttonNamed = (label: string) =>
    Array.from(host?.querySelectorAll('button') ?? []).find(b => b.textContent?.trim() === label) as HTMLButtonElement | undefined;

beforeEach(() => {
    resetOwnVoice();
    onLeave.mockReset();
    onMoveHere.mockReset();
});

afterEach(async () => {
    await act(async () => { root?.unmount(); });
    host?.remove();
    root = null;
    host = null;
});

describe('OwnVoiceBanner', () => {
    it('is absent against a server that never sent OwnVoiceState (an old server)', async () => {
        await mount();
        expect(banner()).toBeNull();
        expect(host!.querySelectorAll('button')).toHaveLength(0);
    });

    it('names the channel, the server and the device, with Leave and Move here', async () => {
        await mount();
        await act(async () => { applyOwnVoiceFrame(ELSEWHERE.payload); });
        expect(banner()).not.toBeNull();
        expect(banner()!.textContent).toContain("You're in Lounge on your PC");
        expect(banner()!.textContent).toContain('Friends');
        const leave = buttonNamed('Leave');
        const move = buttonNamed('Move here');
        expect(leave).toBeDefined();
        expect(move).toBeDefined();
        // Icons come from Icons.tsx (SVG), never an emoji glyph.
        expect(leave!.querySelector('svg')).not.toBeNull();
        expect(move!.querySelector('svg')).not.toBeNull();
        expect(banner()!.getAttribute('role')).toBe('status');
    });

    it('Leave and Move here hand the call to their handlers, once per press', async () => {
        await mount();
        await act(async () => { applyOwnVoiceFrame(ELSEWHERE.payload); });
        await act(async () => { buttonNamed('Move here')!.click(); });
        expect(onMoveHere).toHaveBeenCalledTimes(1);
        expect(onMoveHere.mock.calls[0][0]).toMatchObject({ roomId: 'voice_42', channelId: 42, serverId: ELSEWHERE.payload!.server_id });
        // Busy until the server says something new: a double tap sends once.
        expect(buttonNamed('Move here')!.disabled).toBe(true);
        expect(buttonNamed('Leave')!.disabled).toBe(true);
        await act(async () => { buttonNamed('Leave')!.click(); });
        expect(onLeave).not.toHaveBeenCalled();
        // The server's next word (still elsewhere: say the move was refused).
        await act(async () => { applyOwnVoiceFrame(ELSEWHERE.payload); });
        expect(buttonNamed('Leave')!.disabled).toBe(false);
        await act(async () => { buttonNamed('Leave')!.click(); });
        expect(onLeave).toHaveBeenCalledTimes(1);
        expect(onLeave.mock.calls[0][0]).toMatchObject({ roomId: 'voice_42' });
    });

    it('goes away when the call ends, when it is here, and while this device is in a call', async () => {
        await mount();
        await act(async () => { applyOwnVoiceFrame(ELSEWHERE.payload); });
        expect(banner()).not.toBeNull();
        await act(async () => { applyOwnVoiceFrame({ ...ELSEWHERE.payload, here: true }); });
        expect(banner()).toBeNull();
        await act(async () => { applyOwnVoiceFrame(ELSEWHERE.payload); });
        expect(banner()).not.toBeNull();
        await act(async () => { applyOwnVoiceFrame(NONE.payload); });
        expect(banner()).toBeNull();

        await act(async () => { root!.unmount(); });
        host!.remove();
        await act(async () => { applyOwnVoiceFrame(ELSEWHERE.payload); });
        await mount(true);
        expect(banner()).toBeNull();
    });
});
