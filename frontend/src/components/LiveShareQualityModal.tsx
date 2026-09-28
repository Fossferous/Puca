/**
 * Stream quality while live: change the resolution and frame rate of the
 * share that is ALREADY running, up or down, without the picker, without
 * ending the share and without dropping anyone watching. Opened from the
 * arrow beside Stop Sharing, or right-click your own stream → Stream
 * Quality. Before going live the same arrow opens the full settings dialog.
 *
 * Each choice applies at once and is remembered, so the next share starts
 * there too (the same settings the dialog writes).
 */
import { useEffect, useState } from 'react';
import { FPS_OPTIONS, RESOLUTION_OPTIONS, rememberedQuality, shareDimensions, type LiveCapture } from '../api/rtc/shareHealth';
import { changeLiveShareQuality, shareCaptureSize, type LiveQualityOutcome } from '../api/rtc/shareHealthLive';
import { loadSettings, saveSettings } from './settingsStore';
import { CloseIcon, InfoIcon } from './Icons';
import './ScreenShareModal.css';

interface Props {
    isOpen: boolean;
    onClose: () => void;
}

/** The status line after a change. */
function outcomeText(o: LiveQualityOutcome, asked: { width: number; height: number; fps: number }): string {
    switch (o.kind) {
        case 'applied': {
            const c: LiveCapture = o.capture;
            const base = `Now capturing ${c.width}×${c.height} at ${c.fps} fps.`;
            // A window or screen is never scaled past its own size: say so
            // rather than let a smaller result read as a failure.
            return c.height > 0 && c.height < asked.height && c.width < asked.width
                ? `${base} That is as large as what you are sharing goes.`
                : base;
        }
        case 'ladder':
            return 'This share is sent at several sizes (Settings → Advanced → Screen sharing), and each size is fixed when the share starts, so it cannot change while live. Your choice is saved for your next share.';
        case 'refused':
            return 'The browser would not change the running capture. Your choice is saved for your next share.';
        case 'no-share':
            return 'You are not sharing right now.';
    }
}

/** What the capture produces now, for the header line. */
function currentText(): string | null {
    const size = shareCaptureSize();
    return size && size.width > 0 ? `Capturing ${size.width}×${size.height} now.` : null;
}

export function LiveShareQualityModal({ isOpen, onClose }: Props) {
    const [{ resolution, fps }, setQuality] = useState(() => rememberedQuality(loadSettings()));
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState<string | null>(null);
    const [current, setCurrent] = useState<string | null>(null);

    // Every open starts from what is remembered and what is live NOW.
    useEffect(() => {
        if (!isOpen) return;
        // The open edge is when the panel must catch up with the settings
        // (the dialog or the step-down offer may have written them).
        setQuality(rememberedQuality(loadSettings()));
        setStatus(null);
        setCurrent(currentText());
    }, [isOpen]);

    if (!isOpen) return null;

    const apply = async (next: { resolution: string; fps: number }) => {
        setQuality(next);
        // Remembered as it is chosen, whatever the live outcome: the next
        // share starts here either way.
        saveSettings({ ...loadSettings(), shareResolution: next.resolution, shareFps: next.fps });
        setBusy(true);
        setStatus(null);
        try {
            const outcome = await changeLiveShareQuality(next);
            setStatus(outcomeText(outcome, { ...shareDimensions(next.resolution), fps: next.fps }));
            setCurrent(currentText());
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="stream-modal-overlay">
            <div className="stream-modal" role="dialog" aria-label="Stream quality">
                <div className="stream-modal-header">
                    <h3>Stream quality</h3>
                    <button className="stream-modal-close" onClick={onClose} aria-label="Close"><CloseIcon size={18} /></button>
                </div>
                <div className="stream-modal-content">
                    {current && <p className="stream-live-current">{current}</p>}
                    <div className="stream-setting-group">
                        <label>Resolution</label>
                        <div className="stream-options-grid">
                            {RESOLUTION_OPTIONS.map((res) => (
                                <button
                                    key={res.value}
                                    className={`stream-option ${resolution === res.value ? 'selected' : ''}`}
                                    disabled={busy}
                                    onClick={() => void apply({ resolution: res.value, fps })}
                                >
                                    {res.label}
                                </button>
                            ))}
                        </div>
                    </div>
                    <div className="stream-setting-group">
                        <label>Frame Rate</label>
                        <div className="stream-options-grid">
                            {FPS_OPTIONS.map((f) => (
                                <button
                                    key={f}
                                    className={`stream-option ${fps === f ? 'selected' : ''}`}
                                    disabled={busy}
                                    onClick={() => void apply({ resolution, fps: f })}
                                >
                                    {f} fps
                                </button>
                            ))}
                        </div>
                    </div>
                    {status && <p className="stream-live-status" role="status">{status}</p>}
                    <div className="stream-quality-hint">
                        <span className="info-icon"><InfoIcon /></span>
                        <span>
                            Changes apply to the stream straight away; nobody watching is dropped. At high
                            frame rates the stream may be sent smaller to fit the connection: right-click
                            your stream → Show Stream Stats shows what viewers get.
                        </span>
                    </div>
                </div>
                <div className="stream-modal-footer">
                    <button className="stream-btn-primary" onClick={onClose}>Done</button>
                </div>
            </div>
        </div>
    );
}
