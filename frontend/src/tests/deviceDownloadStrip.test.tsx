/**
 * The in-panel download strip — the surface that fixes "nothing comes up
 * until you leave the interface" (the app-wide tray at z 1500 paints under
 * the file browser overlay at z 2050).
 *
 * What must hold: the strip shows exactly ITS session's downloads (the store
 * is global and downloads deliberately outlive their panel, so without the
 * filter a session would show another device's transfers — and with a broken
 * filter it would show nothing, silently restoring the original bug), and
 * new rows render above older ones (the strip is height-capped; a fresh
 * download appended below the fold of undismissed finished rows would be
 * invisible, which is the exact failure the strip exists to fix).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../api/devices/fileTransfer', () => ({
    downloadFileTo: async (
        _sessionId: string,
        _path: string,
        size: number,
        write: (b: Uint8Array) => void | Promise<void>,
        onProgress?: (done: number, total: number) => void,
    ) => {
        const b = new Uint8Array(16);
        await write(b);
        onProgress?.(size, size);
        return size;
    },
}));

vi.mock('../api/transferSinks', () => ({
    prepareSink: async () => ({
        resumeFrom: 0,
        describeDestination: () => '/Downloads/Puca',
        abort: async () => { /* not exercised */ },
        sink: {
            write: async () => { /* discard */ },
            close: async () => { /* no-op */ },
        },
    }),
}));

vi.mock('../api/mobileTransferService', () => ({
    ensureTransferNotificationPermission: async () => { /* no-op */ },
    beginBackgroundTransfer: async () => { /* no-op */ },
    updateBackgroundTransfer: async () => { /* no-op */ },
    endBackgroundTransfer: async () => { /* no-op */ },
}));

import { startDeviceDownload } from '../api/devices/deviceDownloads';
import { DeviceDownloadStrip } from '../components/DeviceDownloads';

const settle = () => act(() => new Promise<void>(r => setTimeout(r, 0)));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

describe('DeviceDownloadStrip', () => {
    it('renders only its own session, newest first; nothing for a stranger session', async () => {
        startDeviceDownload('sess-A', 'C:\\a.bin', 'alpha.bin', 16);
        startDeviceDownload('sess-B', 'C:\\b.bin', 'beta.bin', 16);
        startDeviceDownload('sess-A', 'C:\\c.bin', 'gamma.bin', 16);
        await settle();

        await act(async () => root.render(<DeviceDownloadStrip sessionId="sess-A" />));
        const rows = [...container.querySelectorAll('.dd-row')];
        expect(rows.length).toBe(2);
        expect(container.textContent).toContain('alpha.bin');
        expect(container.textContent).toContain('gamma.bin');
        // The OTHER session's download must not bleed into this panel.
        expect(container.textContent).not.toContain('beta.bin');
        // Newest first: gamma started after alpha, so it renders on top.
        expect(rows[0].textContent).toContain('gamma.bin');

        // A session with no downloads renders nothing at all.
        await act(async () => root.render(<DeviceDownloadStrip sessionId="sess-C" />));
        expect(container.querySelector('.dd-strip')).toBeNull();
    });
});
