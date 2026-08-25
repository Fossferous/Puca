import { useEffect, useState } from 'react';
import {
    fileTransferManager,
    type TransferView,
} from '../api/fileTransferManager';
import { formatFileSize } from '../api/uploads';
import { isMobile } from '../api/platform';
import { CloseIcon, InboxIcon, OutboxIcon } from './Icons';
import { useTransferSpeed, formatSpeed } from './useTransferSpeed';
import './FileTransfers.css';

/**
 * Throughput cap for one transfer.
 *
 * A transfer saturates whichever link is slower, which on a home connection
 * means everything else on it — a call, a stream, someone else's browsing —
 * degrades until the file is done. This gives that back.
 *
 * The steps are geometric rather than linear: the difference between 128 KB/s
 * and 1 MB/s matters, the difference between 40 and 41 MB/s does not, so a
 * linear slider would spend most of its travel on values nobody wants.
 * Right-most is Unlimited, which is the default and the common case.
 */
const SPEED_STEPS: (number | null)[] = [
    64 * 1024, 128 * 1024, 256 * 1024, 512 * 1024,
    1024 * 1024, 2 * 1024 * 1024, 5 * 1024 * 1024, 10 * 1024 * 1024,
    25 * 1024 * 1024, null,
];

function speedLabel(v: number | null): string {
    if (v === null) return 'Unlimited';
    return v >= 1024 * 1024 ? `${(v / (1024 * 1024)).toFixed(v % (1024 * 1024) ? 1 : 0)} MB/s`
        : `${Math.round(v / 1024)} KB/s`;
}

function SpeedLimiter({ transfer }: { transfer: TransferView }) {
    const current = transfer.rateLimit ?? null;
    // Index of the active step; unlimited (null) is the last one.
    const idx = Math.max(0, SPEED_STEPS.findIndex(v => v === current));
    return (
        <label className="xfer-speed">
            <span className="xfer-speed-label">
                {transfer.direction === 'receive' ? 'Download limit' : 'Upload limit'}
            </span>
            <input
                type="range"
                min={0}
                max={SPEED_STEPS.length - 1}
                step={1}
                value={idx === -1 ? SPEED_STEPS.length - 1 : idx}
                onChange={e => fileTransferManager.setRateLimit(
                    transfer.id, SPEED_STEPS[Number(e.target.value)],
                )}
            />
            <span className="xfer-speed-value">{speedLabel(current)}</span>
        </label>
    );
}

/**
 * Live peer-to-peer transfers for the conversation on screen.
 *
 * Deliberately looks different from an attachment. A transfer is a live
 * handshake between two running apps, not something that sits in history: both
 * people must be online, the sender must stay open, and nothing is stored on
 * the server. Presenting it as just another attachment would set exactly the
 * wrong expectation. See docs/P2P_FILE_TRANSFER_PLAN.md §7.
 */
/**
 * Live transfers.
 *
 * `peerId` scopes the list to one conversation; OMIT it for the app-wide tray.
 *
 * The tray exists because scoping was the whole bug: this used to render only
 * inside an open DM, so an offer arriving while the recipient was in a server
 * channel, on the Friends panel, or in a DIFFERENT DM had no Accept button
 * anywhere in the app. They were never told, and the sender sat on "Waiting
 * for them to accept…" until the offer TTL reaped it. The manager always
 * listened globally; only the UI was conditional.
 */
export function FileTransfers({ peerId }: { peerId?: number }) {
    const [transfers, setTransfers] = useState<TransferView[]>([]);

    // Display only. Wiring lives in Chat so an offer is captured even when no
    // DM is open — a component that unmounts must never own a subscription the
    // feature depends on.
    useEffect(() => fileTransferManager.subscribe(setTransfers), []);

    const mine = peerId === undefined ? transfers : transfers.filter(t => t.peerId === peerId);
    if (mine.length === 0) return null;

    const anyFinished = mine.some(t => t.state === 'complete' || t.state === 'failed' || t.state === 'cancelled');
    return (
        <div className={peerId === undefined ? 'file-transfers file-transfers-tray' : 'file-transfers'}>
            {peerId === undefined && (
                <div className="xfer-tray-head">
                    <span>File transfers</span>
                    {anyFinished && (
                        <button
                            className="xfer-clear-finished"
                            onClick={() => fileTransferManager.clearFinished()}
                        >
                            Clear finished
                        </button>
                    )}
                </div>
            )}
            {mine.map(t => <TransferCard key={t.id} t={t} />)}
        </div>
    );
}

function TransferCard({ t }: { t: TransferView }) {
    const pct = t.size ? Math.min(100, Math.round((t.bytes / t.size) * 100)) : 0;
    // During 'preparing' the byte counter tracks the pre-offer hash pass, so
    // the same gauge reads as "how fast the file is being read".
    const speed = useTransferSpeed(t.id, t.bytes, t.state === 'transferring' || t.state === 'preparing');
    const incoming = t.direction === 'receive';
    // Which action the dismiss button maps to. NEVER route a finished card to
    // cancel():
    // its registry slot is gone server-side, and the resulting "Unknown
    // transfer" error alert also wipes optimistic DM bubbles (see Chat.tsx's
    // Error handler). A live incoming offer goes through Decline instead, so
    // the sender is told rather than left waiting for the offer TTL.
    const live = t.state === 'preparing' || t.state === 'offered' || t.state === 'connecting' || t.state === 'transferring';
    const closeCard = () => {
        if (!live) { fileTransferManager.dismiss(t.id); return; }
        if (incoming && t.state === 'offered') fileTransferManager.reject(t.id);
        else fileTransferManager.cancel(t.id);
    };

    return (
        <div className={`xfer-card xfer-${t.state}`}>
            <div className="xfer-head">
                <span className="xfer-icon">{incoming ? <InboxIcon /> : <OutboxIcon />}</span>
                <span className="xfer-name" title={t.name}>{t.name}</span>
                <span className="xfer-size">{formatFileSize(t.size)}</span>
                <button
                    className="xfer-x"
                    aria-label={live ? 'Cancel this transfer' : 'Dismiss'}
                    title={live ? 'Cancel this transfer' : 'Dismiss'}
                    onClick={closeCard}
                >
                    <CloseIcon />
                </button>
            </div>

            <div className="xfer-line">
                {t.state === 'preparing' && (
                    // Reading + digesting the file so the offer can carry its
                    // hash. Saying "waiting for the peer" here — which this
                    // card used to do — blamed the receiver for time spent
                    // entirely on this machine.
                    <span>Preparing — reading the file… ({pct}%)</span>
                )}
                {t.state === 'offered' && (
                    incoming
                        ? <span>{t.peerName} wants to send you this file</span>
                        : t.parkedReason
                            // The server is HOLDING the offer — the target has
                            // no live socket (a backgrounded phone looks
                            // exactly like offline). Server-worded, and it
                            // already distinguishes self-transfer / named
                            // device / another person.
                            ? <span>{t.parkedReason}</span>
                            : <span>Waiting for {t.peerName} to accept…</span>
                )}
                {t.state === 'connecting' && <span>Connecting to {t.peerName}…</span>}
                {t.state === 'transferring' && (
                    <span>
                        {formatFileSize(t.bytes)} of {formatFileSize(t.size)} ({pct}%)
                        {t.relayed && ' · relayed'}
                    </span>
                )}
                {t.state === 'complete' && <span className="xfer-ok">Complete</span>}
                {t.state === 'failed' && <span className="xfer-bad">{t.error ?? 'Failed'}</span>}
                {t.state === 'cancelled' && <span className="xfer-bad">{t.error ?? 'Cancelled'}</span>}
            </div>

            {(t.state === 'transferring' || t.state === 'connecting' || t.state === 'preparing') && (
                <div className="xfer-bar-row">
                    <div className="xfer-bar"><div className="xfer-fill" style={{ width: `${pct}%` }} /></div>
                    <span className="xfer-speed-now">
                        {speed === null ? '—' : formatSpeed(speed)}
                    </span>
                </div>
            )}

            {t.state === 'transferring' && <SpeedLimiter transfer={t} />}

            {(t.state === 'transferring' || t.state === 'connecting') && (
                <div className="xfer-warning" role="status">
                    {isMobile()
                        // Blunter on a phone because the failure is likelier and
                        // less obvious: the webview is suspended on screen lock,
                        // which stalls the transfer with no visible cause.
                        ? 'Keep Puca open and your screen on — locking the phone or switching apps pauses the transfer, and closing the app loses it.'
                        : 'Keep Puca open until this finishes — there is no server copy, so closing the app loses the transfer.'}
                </div>
            )}

            <div className="xfer-actions">
                {t.state === 'offered' && incoming && (
                    <>
                        <button
                            className="xfer-btn xfer-accept"
                            onClick={() => void fileTransferManager.accept(t.id)}
                        >
                            Accept
                        </button>
                        <button
                            className="xfer-btn"
                            onClick={() => fileTransferManager.reject(t.id)}
                        >
                            Decline
                        </button>
                    </>
                )}
                {live && !(incoming && t.state === 'offered') && (
                    <button className="xfer-btn" onClick={() => fileTransferManager.cancel(t.id)}>
                        Cancel
                    </button>
                )}
            </div>
        </div>
    );
}
