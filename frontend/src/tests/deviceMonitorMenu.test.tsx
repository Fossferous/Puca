/**
 * The mobile monitor menu must show what the HOST is doing, not what was last
 * tapped.
 *
 * It kept its own selection state and set it optimistically, so a switch the
 * host refused still moved the highlight — which is exactly how "All Displays"
 * looked like it worked for the whole time it was impossible (the composite
 * collided with the live capture and every switch failed). The desktop picker
 * has always derived from the host's confirmation; this brings the phone into
 * line and fixes the layout that made three screens plus "All" unreadable at
 * 390px.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DeviceControlSession } from '../api/devices/session';

const requestMonitor = vi.fn();
const sendStreamQuality = vi.fn();
vi.mock('../api/devices/session', async (importOriginal) => {
    const real = await importOriginal<typeof import('../api/devices/session')>();
    return {
        ...real,
        requestMonitor: (...a: unknown[]) => requestMonitor(...a),
        sendStreamQuality: (...a: unknown[]) => sendStreamQuality(...a),
        setPrivacyMode: vi.fn(),
        sendInput: vi.fn(),
    };
});

const { MonitorMenu } = await import('../components/DeviceStageMobileMenus');
const { useStreamStore } = await import('../stores/streamStore');

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function session(over: Partial<DeviceControlSession> = {}): DeviceControlSession {
    return {
        id: 'ds-1',
        role: 'controller',
        peerDevice: 'dev-host',
        phase: 'active',
        stream: null,
        captureSize: null,
        error: null,
        monitors: [
            { id: 0, label: 'Main display (2560x1440)' },
            { id: 1, label: 'Display 2 (1440x2560)' },
            { id: 2, label: 'Display 3 (1440x2560)' },
        ],
        activeMonitor: 0,
        filesChannel: null,
        fileRoot: null,
        privacyActive: false,
        ...over,
    } as DeviceControlSession;
}

async function mount(s: DeviceControlSession) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(<MonitorMenu session={s} onClose={() => {}} />); });
}

function tabs(): HTMLButtonElement[] {
    return [...(host?.querySelectorAll<HTMLButtonElement>('.device-stage-mobile-menu-tab') ?? [])];
}

beforeEach(() => {
    vi.clearAllMocks();
    useStreamStore.setState({ qualities: {}, pendingQualities: {} });
});

afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    host?.remove();
    root = null;
    host = null;
});

describe('which screen is shown as selected', () => {
    it('follows the host, not the tap', async () => {
        await mount(session({ activeMonitor: 0 }));
        // Ask for screen 2. The host has not confirmed anything.
        await act(async () => { tabs()[1].click(); });

        expect(requestMonitor).toHaveBeenCalledWith('ds-1', 1);
        const active = tabs().filter(t => t.className.includes('active'));
        expect(active).toHaveLength(1);
        expect(active[0].textContent).toContain('Main display');
    });

    it('moves once the host confirms', async () => {
        await mount(session({ activeMonitor: 1 }));
        const active = tabs().filter(t => t.className.includes('active'));
        expect(active[0].textContent).toContain('Display 2');
    });
});

describe('All Displays', () => {
    it('is a tab like the others and asks for the sentinel', async () => {
        await mount(session());
        const all = tabs().find(t => t.textContent?.includes('All'))!;
        expect(all, 'All Displays must be in the tab strip').toBeTruthy();
        await act(async () => { all.click(); });
        expect(requestMonitor).toHaveBeenCalledWith('ds-1', 255);
    });

    it('shows as selected only when the host is actually composited', async () => {
        await mount(session({ activeMonitor: 255 }));
        const all = tabs().find(t => t.textContent?.includes('All'))!;
        expect(all.className).toContain('active');
        // ...and nothing else is.
        expect(tabs().filter(t => t.className.includes('active'))).toHaveLength(1);
    });
});

describe('labels on a phone', () => {
    it('drops the resolution suffix that will not fit', async () => {
        await mount(session());
        const text = tabs().map(t => t.textContent ?? '');
        expect(text.some(t => t.includes('Main display'))).toBe(true);
        expect(text.join(' ')).not.toContain('2560x1440');
    });
});

describe('quality radios', () => {
    it('reflect the host-confirmed quality rather than the last tap', async () => {
        useStreamStore.setState({ qualities: { 'ds-1': { fps: 15, bitrate: 1000 } }, pendingQualities: {} });
        await mount(session());
        const checked = [...host!.querySelectorAll<HTMLInputElement>('input[type=radio]')]
            .filter(r => r.checked);
        expect(checked).toHaveLength(1);
        expect(checked[0].closest('label')?.textContent).toContain('Low bandwidth');
    });

    it('are disabled while a change is in flight', async () => {
        useStreamStore.setState({ qualities: {}, pendingQualities: { 'ds-1': { fps: 60, bitrate: 10000 } } });
        await mount(session());
        const radios = [...host!.querySelectorAll<HTMLInputElement>('input[type=radio]')];
        expect(radios.every(r => r.disabled)).toBe(true);
    });
});
