/**
 * Shared throughput gauge for anything that moves bytes and renders progress:
 * the chat P2P transfer cards and the My Devices download rows both drive it
 * from the byte counter their own subscription already delivers.
 */
import { useEffect, useRef, useState } from 'react';

/**
 * Live throughput for one transfer, smoothed.
 *
 * Sampled from the byte counter rather than reported by the engine: progress
 * already flows through the same subscription, so this needs no new plumbing.
 * Exponentially smoothed because raw per-tick deltas swing wildly with chunk
 * timing and read like a broken gauge.
 */
export function useTransferSpeed(id: string, bytes: number, active: boolean): number | null {
    const last = useRef<{ at: number; bytes: number } | null>(null);
    const [rate, setRate] = useState<number | null>(null);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- reset the gauge when the transfer stops; one extra render on a terminal transition is fine
        if (!active) { last.current = null; setRate(null); return; }
        const now = Date.now();
        const prev = last.current;
        if (!prev) { last.current = { at: now, bytes }; return; }
        const dt = (now - prev.at) / 1000;
        // KEEP the anchor until a full window has accumulated. Advancing it on
        // every sample meant dt was always the gap between two consecutive
        // progress events — one per 16 KiB chunk, a few milliseconds — so the
        // guard below rejected every sample and the gauge never left '—' on
        // any link faster than ~64 KB/s. The window must span many samples.
        if (dt < 0.25) return;                       // too short to be meaningful
        last.current = { at: now, bytes };
        const instant = Math.max(0, (bytes - prev.bytes) / dt);
        setRate(r => (r === null ? instant : r * 0.7 + instant * 0.3));
    }, [id, bytes, active]);

    return rate;
}

export function formatSpeed(bytesPerSecond: number): string {
    if (bytesPerSecond >= 1024 * 1024) return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
    if (bytesPerSecond >= 1024) return `${Math.round(bytesPerSecond / 1024)} KB/s`;
    return `${Math.round(bytesPerSecond)} B/s`;
}
