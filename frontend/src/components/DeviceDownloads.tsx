/**
 * Progress for device-file downloads, rendered in two places off one store:
 *
 * - <DeviceDownloads />: the app-wide tray, mounted at the root next to the
 *   consent prompts, deliberately outside every view condition — a transfer
 *   started in the file browser must stay visible after that panel is closed,
 *   from whatever screen you happen to be on.
 * - <DeviceDownloadStrip sessionId />: the same rows docked INSIDE the file
 *   browser panel. The tray alone was not enough: the standalone browser is a
 *   full-viewport overlay at z 2050 while the tray sits at 1500, so during
 *   exactly the phase the user is watching — they just pressed Download —
 *   every sign of progress was painted underneath the panel, and the transfer
 *   only "appeared" on closing it.
 *
 * Both render nothing when there is nothing to report.
 */
import { useEffect, useState } from 'react';
import {
    subscribeDeviceDownloads,
    cancelDeviceDownload,
    clearDeviceDownload,
    type DeviceDownload,
} from '../api/devices/deviceDownloads';
import { formatFileSize } from '../api/uploads';
import { useTransferSpeed, formatSpeed } from './useTransferSpeed';
import './DeviceDownloads.css';

function line(d: DeviceDownload): string {
    if (d.state === 'running') {
        // Zero bytes means the sink is still being prepared (on the web that
        // is a Save As dialog) — the button must not read as dead meanwhile.
        if (d.bytes === 0) return 'Starting…';
        return d.size > 0
            ? `${formatFileSize(d.bytes)} of ${formatFileSize(d.size)}`
            : formatFileSize(d.bytes);
    }
    if (d.state === 'complete') return d.destination ? `Saved to ${d.destination}` : 'Saved';
    if (d.state === 'cancelled') return 'Cancelled';
    return d.error ?? 'Failed';
}

export function DeviceDownloadRow({ d }: { d: DeviceDownload }) {
    const pct = d.size > 0 ? Math.min(100, Math.round((d.bytes / d.size) * 100)) : 0;
    const speed = useTransferSpeed(d.id, d.bytes, d.state === 'running' && d.bytes > 0);
    return (
        <div className={`dd-row dd-${d.state}`}>
            <div className="dd-text">
                <span className="dd-name" title={d.name}>{d.name}</span>
                <span className="dd-sub">
                    {line(d)}
                    {d.state === 'running' && speed !== null && (
                        <span className="dd-speed"> · {formatSpeed(speed)}</span>
                    )}
                </span>
            </div>
            {d.state === 'running' && (
                <div className="dd-track" aria-hidden="true">
                    <div className="dd-fill" style={{ width: `${pct}%` }} />
                </div>
            )}
            {d.state === 'running' ? (
                <button
                    type="button"
                    className="dd-btn"
                    onClick={() => cancelDeviceDownload(d.id)}
                >
                    Cancel
                </button>
            ) : (
                <button
                    type="button"
                    className="dd-btn"
                    onClick={() => clearDeviceDownload(d.id)}
                >
                    Dismiss
                </button>
            )}
        </div>
    );
}

export function DeviceDownloads() {
    const [list, setList] = useState<DeviceDownload[]>([]);
    useEffect(() => subscribeDeviceDownloads(setList), []);

    if (list.length === 0) return null;

    return (
        <div className="device-downloads" role="status" aria-live="polite">
            {list.map(d => <DeviceDownloadRow key={d.id} d={d} />)}
        </div>
    );
}

/**
 * The same rows, docked inside the file browser for one session — in normal
 * flow, not fixed — so a download shows progress in the very panel whose
 * Download button started it.
 */
export function DeviceDownloadStrip({ sessionId }: { sessionId: string }) {
    const [list, setList] = useState<DeviceDownload[]>([]);
    useEffect(() => subscribeDeviceDownloads(setList), []);

    // Newest FIRST: the strip is height-capped and scrolls, and undismissed
    // finished rows accumulate above the fold in store order — appending the
    // freshly started download at the bottom put it below the fold, invisible,
    // which is the exact failure this strip exists to fix. (filter() returns a
    // fresh array, so reversing never touches the store's order or the tray.)
    const mine = list.filter(d => d.sessionId === sessionId).reverse();
    if (mine.length === 0) return null;

    return (
        <div className="dd-strip" role="status" aria-live="polite">
            {mine.map(d => <DeviceDownloadRow key={d.id} d={d} />)}
        </div>
    );
}
