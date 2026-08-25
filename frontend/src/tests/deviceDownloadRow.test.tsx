/**
 * First React-level coverage of a transfer progress row: the speed gauge must
 * actually render a rate once bytes tick, and the pre-transfer window must
 * read as "Starting…" rather than a dead button.
 *
 * Time is driven with a mocked clock because useTransferSpeed ignores samples
 * closer together than 250 ms — real renders in a test happen in microseconds
 * and would never produce a reading.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DeviceDownloadRow } from '../components/DeviceDownloads';
import type { DeviceDownload } from '../api/devices/deviceDownloads';

const base: DeviceDownload = {
    id: 'dd-1', sessionId: 's-1', path: 'C:\\big.iso', name: 'big.iso',
    size: 10 * 1024 * 1024, bytes: 0, state: 'running',
};

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
    vi.restoreAllMocks();
});

const show = (d: DeviceDownload) => act(() => root.render(<DeviceDownloadRow d={d} />));

describe('DeviceDownloadRow', () => {
    it('shows Starting… while the sink is being prepared (zero bytes)', () => {
        show({ ...base });
        expect(container.textContent).toContain('Starting…');
    });

    it('renders a byte-rate once progress ticks across a sample window', () => {
        const now = vi.spyOn(Date, 'now');
        now.mockReturnValue(1_000_000);
        show({ ...base, bytes: 1024 * 1024 });

        // One second later, one more megabyte: 1.0 MB/s.
        now.mockReturnValue(1_001_000);
        show({ ...base, bytes: 2 * 1024 * 1024 });

        expect(container.textContent).toContain('1.0 MB/s');
        // And the ordinary progress line is still there beside it.
        expect(container.textContent).toContain('of 10.0 MB');
    });

    it('drops the gauge on completion instead of freezing a stale rate', () => {
        const now = vi.spyOn(Date, 'now');
        now.mockReturnValue(2_000_000);
        show({ ...base, bytes: 1024 * 1024 });
        now.mockReturnValue(2_001_000);
        show({ ...base, bytes: 2 * 1024 * 1024 });
        expect(container.textContent).toContain('MB/s');

        show({ ...base, bytes: base.size, state: 'complete', destination: 'Downloads' });
        expect(container.textContent).not.toContain('MB/s');
        expect(container.textContent).toContain('Saved to Downloads');
    });
});
