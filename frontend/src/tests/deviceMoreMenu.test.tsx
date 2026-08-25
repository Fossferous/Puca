/**
 * The remote-control "..." (More) menu on a phone.
 *
 * The header comment on this menu says a control that silently does nothing
 * is worse than a missing one — and "Insert Ctrl + Alt + Del" was exactly
 * that for months: three injected keystrokes Windows ignores for the Secure
 * Attention Sequence, reported as success. It now sends ONE `{t:'sas'}` frame
 * that the host routes to the system service. Shut down is the one entry that
 * needs a confirmation; nothing may leave the phone until the red button.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const h = vi.hoisted(() => ({
    sendInput: vi.fn(() => true),
    sendPowerAction: vi.fn(() => true),
    sendClipboard: vi.fn(async () => null as string | null),
}));

vi.mock('../api/devices/session', async (importOriginal) => {
    const real = await importOriginal<typeof import('../api/devices/session')>();
    return {
        ...real,
        sendInput: (...a: unknown[]) => h.sendInput(...a),
        sendPowerAction: (...a: unknown[]) => h.sendPowerAction(...a),
        sendClipboard: (...a: unknown[]) => h.sendClipboard(...a),
        requestMonitor: vi.fn(),
        setPrivacyMode: vi.fn(),
    };
});

const { MoreMenu } = await import('../components/DeviceStageMobileMenus');

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const onClose = vi.fn();
const onOpenFiles = vi.fn();
const onNotice = vi.fn();
const session = { id: 'sess-1', role: 'controller', phase: 'active' } as unknown as
    import('../api/devices/session').DeviceControlSession;

async function mount(over: { viewOnly?: boolean; controlEnabled?: boolean } = {}) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const s = { ...session, viewOnly: over.viewOnly ?? false } as typeof session;
    await act(async () => {
        root!.render(<MoreMenu session={s} onClose={onClose} onOpenFiles={onOpenFiles} onNotice={onNotice} controlEnabled={over.controlEnabled} />);
    });
}
const labels = () => [...host!.querySelectorAll('.device-stage-mobile-menu-item .label')].map(e => e.textContent);
const item = (label: string) => {
    const el = [...host!.querySelectorAll('.device-stage-mobile-menu-item')].find(e => e.textContent?.includes(label));
    expect(el, `no menu item "${label}"`).toBeTruthy();
    return el as HTMLElement;
};
const button = (label: string) => {
    const el = [...host!.querySelectorAll('button')].find(b => b.textContent?.trim() === label);
    expect(el, `no button "${label}"`).toBeTruthy();
    return el as HTMLButtonElement;
};

beforeEach(() => {
    h.sendInput.mockReset().mockReturnValue(true);
    h.sendPowerAction.mockReset().mockReturnValue(true);
    h.sendClipboard.mockReset().mockResolvedValue(null);
    onClose.mockReset(); onOpenFiles.mockReset(); onNotice.mockReset();
});
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
});

describe('More menu', () => {
    it('lists every entry, and only entries that do something', async () => {
        await mount();
        expect(labels()).toEqual([
            'Browse files', 'Send clipboard', 'Insert Ctrl + Alt + Del', 'Alt + Tab', 'Alt + F4', 'Lock', 'Shut down…',
        ]);
    });

    it('a VIEW-ONLY share is offered no input affordance at all — files only', async () => {
        // session.viewOnly's own contract: "the UI hides input affordances".
        // Offering them and then saying "Not connected" (which the first
        // version did) misdiagnosed a refused capability as a dead link, over
        // a session that was visibly streaming.
        await mount({ viewOnly: true });
        expect(labels()).toEqual(['Browse files']);
    });

    it('a PAUSED session (Pause control) offers no input affordance either', async () => {
        // "A control that says it is off has to be off" — the keyboard overlay
        // honours the pause; these entries must not walk past it.
        await mount({ controlEnabled: false });
        expect(labels()).toEqual(['Browse files']);
    });

    it('Ctrl+Alt+Del sends ONE sas frame and ZERO key frames', async () => {
        await mount();
        await act(async () => { item('Ctrl + Alt + Del').click(); });
        expect(h.sendInput).toHaveBeenCalledTimes(1);
        expect(h.sendInput).toHaveBeenCalledWith('sess-1', { t: 'sas' });
        expect(h.sendInput.mock.calls.some(c => (c[1] as { t?: string })?.t === 'key')).toBe(false);
        expect(onNotice).toHaveBeenCalledWith('Ctrl+Alt+Del sent');
        expect(onClose).toHaveBeenCalled();
    });

    it('a frame that could not be queued is NOT reported as sent (Ctrl+Alt+Del, Alt+Tab, Alt+F4)', async () => {
        // sendInput refuses silently for a view-only share or a socket that is
        // down; the note must not claim success over a frame that never left
        // the phone — that was the whole class of bug this menu removed.
        h.sendInput.mockReturnValue(false);
        await mount();
        await act(async () => { item('Ctrl + Alt + Del').click(); });
        expect(onNotice).toHaveBeenCalledWith(expect.stringMatching(/Not connected/));
        expect(onNotice).not.toHaveBeenCalledWith('Ctrl+Alt+Del sent');
        onNotice.mockReset();
        await mount();
        await act(async () => { item('Alt + Tab').click(); });
        expect(onNotice).toHaveBeenCalledWith(expect.stringMatching(/Not connected.*Alt\+Tab/));
        onNotice.mockReset();
        await mount();
        await act(async () => { item('Alt + F4').click(); });
        expect(onNotice).toHaveBeenCalledWith(expect.stringMatching(/Not connected.*Alt\+F4/));
    });

    it('Alt+Tab and Alt+F4 are proper chords: modifier down, key down/up, modifier up', async () => {
        await mount();
        await act(async () => { item('Alt + Tab').click(); });
        expect(h.sendInput.mock.calls.map(c => c[1])).toEqual([
            { t: 'key', code: 'AltLeft', down: true },
            { t: 'key', code: 'Tab', down: true },
            { t: 'key', code: 'Tab', down: false },
            { t: 'key', code: 'AltLeft', down: false },
        ]);
        h.sendInput.mockReset();
        await mount();
        await act(async () => { item('Alt + F4').click(); });
        expect(h.sendInput.mock.calls.map(c => (c[1] as { code?: string }).code)).toEqual(['AltLeft', 'F4', 'F4', 'AltLeft']);
    });

    it('Lock sends the power signal at once (reversible: the session follows the machine to its sign-in screen)', async () => {
        await mount();
        await act(async () => { item('Lock').click(); });
        expect(h.sendPowerAction).toHaveBeenCalledWith('sess-1', 'lock');
        expect(onNotice).toHaveBeenCalledWith(expect.stringMatching(/Locking/));
        expect(onClose).toHaveBeenCalled();
    });

    it('Shut down… asks first and sends NOTHING until confirmed; Cancel sends nothing at all', async () => {
        await mount();
        await act(async () => { item('Shut down').click(); });
        expect(h.sendPowerAction).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled(); // the menu became the confirmation
        // Named as the REMOTE machine: "this device" is the phone in hand.
        expect(host!.textContent).toContain('Shut down the device you are controlling?');
        expect(host!.textContent).not.toContain('this device');

        await act(async () => { button('Cancel').click(); });
        expect(h.sendPowerAction).not.toHaveBeenCalled();
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('confirming Shut down sends the power signal exactly once, and says so', async () => {
        await mount();
        await act(async () => { item('Shut down').click(); });
        await act(async () => { button('Shut down').click(); });
        expect(h.sendPowerAction).toHaveBeenCalledTimes(1);
        expect(h.sendPowerAction).toHaveBeenCalledWith('sess-1', 'shutdown');
        expect(onNotice).toHaveBeenCalledWith(expect.stringMatching(/Shutting down/));
        expect(onClose).toHaveBeenCalled();
    });

    it('a confirmed Shut down with no live session says so — never "Shutting down…"', async () => {
        h.sendPowerAction.mockReturnValue(false);
        await mount();
        await act(async () => { item('Shut down').click(); });
        await act(async () => { button('Shut down').click(); });
        expect(onNotice).toHaveBeenCalledWith(expect.stringMatching(/Not connected/));
        expect(onNotice).not.toHaveBeenCalledWith(expect.stringMatching(/Shutting down/));
    });

    it('a power action with no live session says so instead of pretending', async () => {
        h.sendPowerAction.mockReturnValue(false);
        await mount();
        await act(async () => { item('Lock').click(); });
        expect(onNotice).toHaveBeenCalledWith(expect.stringMatching(/Not connected/));
    });
});
