/**
 * The shared speed gauge, driven at PRODUCTION cadence.
 *
 * The hook shipped with a bug this file exists to keep dead: it advanced its
 * sample anchor on every render before the 250 ms minimum-window check, so
 * with progress events a few milliseconds apart (one per 16 KiB chunk — every
 * realistic transfer) dt never reached the window and the gauge stayed '—'
 * forever. The first test drives samples 50 ms apart and demands a reading:
 * it fails against that implementation.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useTransferSpeed, formatSpeed } from '../components/useTransferSpeed';

function Probe({ bytes, active }: { bytes: number; active: boolean }) {
    const rate = useTransferSpeed('probe', bytes, active);
    return <div>{rate === null ? 'no-rate' : formatSpeed(rate)}</div>;
}

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

const show = (bytes: number, active: boolean) =>
    act(() => root.render(<Probe bytes={bytes} active={active} />));

describe('useTransferSpeed', () => {
    it('produces a reading from samples arriving FASTER than the window', () => {
        const now = vi.spyOn(Date, 'now');
        now.mockReturnValue(1_000_000);
        show(0, true);
        // Five samples 50 ms apart, 64 KiB each — the per-chunk cadence of a
        // real ~1.3 MB/s transfer. The anchor must be RETAINED across the
        // sub-window samples so the fifth one spans a full 250 ms.
        for (let k = 1; k <= 5; k++) {
            now.mockReturnValue(1_000_000 + 50 * k);
            show(65536 * k, true);
        }
        expect(container.textContent).toContain('MB/s'); // ~1.3 MB/s, not 'no-rate'
    });

    it('resets to null the moment the transfer stops being active', () => {
        const now = vi.spyOn(Date, 'now');
        now.mockReturnValue(2_000_000);
        show(0, true);
        now.mockReturnValue(2_000_300);
        show(1024 * 1024, true);
        expect(container.textContent).toContain('MB/s');   // positive control

        show(1024 * 1024, false);
        expect(container.textContent).toBe('no-rate');
    });
});
