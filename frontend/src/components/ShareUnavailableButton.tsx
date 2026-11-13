/**
 * Where Share Screen sits in the voice bar, on a device that cannot share:
 * a button that says so instead of one that fails, or of nothing at all (a
 * phone user looking for Share found no trace of it, and no reason). Pressing
 * it explains why and, where the Púca app for Android is the answer, links to
 * the download page. The rules are shareAvailability.ts.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { ScreenShareIcon, CloseIcon } from './Icons';
import { shareUnavailableWords, type ShareUnavailableReason } from './shareAvailability';
import { API_BASE_URL } from '../api/config';
import { openDownloadPage } from '../api/appVersion';
import { useBackClose } from '../hooks/useBackClose';
import './ShareUnavailableButton.css';

/** The server's download page (its /app-version), or null when it has none. */
async function downloadUrl(): Promise<string | null> {
    try {
        const res = await fetch(`${API_BASE_URL}/app-version`, { cache: 'no-store' });
        if (!res.ok) return null;
        const info = (await res.json()) as { download_url?: unknown } | null;
        const url = typeof info?.download_url === 'string' ? info.download_url : '';
        return /^https:\/\//i.test(url) ? url : null;
    } catch {
        return null;
    }
}

export function ShareUnavailableButton({ reason }: { reason: ShareUnavailableReason }) {
    const [open, setOpen] = useState(false);
    const [noPage, setNoPage] = useState(false);
    const box = useRef<HTMLDivElement>(null);
    const button = useRef<HTMLButtonElement>(null);
    const titleId = useId();
    const words = shareUnavailableWords(reason);
    // Android's BACK closes the card as Escape does (the Android app shows it
    // where the app cannot share: reason 'android-app').
    useBackClose(() => { setOpen(false); button.current?.focus(); }, open);

    useEffect(() => {
        if (!open) return;
        const onDown = (e: PointerEvent) => {
            const t = e.target as Node | null;
            if (t && (box.current?.contains(t) || button.current?.contains(t))) return;
            setOpen(false);
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                setOpen(false);
                button.current?.focus();
            }
        };
        document.addEventListener('pointerdown', onDown, true);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('pointerdown', onDown, true);
            document.removeEventListener('keydown', onKey);
        };
    }, [open]);

    return (
        <>
            <button
                ref={button}
                className="voice-btn vp-screenshare vp-share-unavailable"
                data-testid="screenshare-unavailable"
                onClick={() => setOpen(o => !o)}
                title="Share Screen isn't available on this device"
                aria-label="Share Screen: not available on this device"
                aria-haspopup="dialog"
                aria-expanded={open}
            >
                <ScreenShareIcon size={18} />
            </button>
            {open && (
                <div ref={box} className="share-unavailable-card" role="dialog" aria-labelledby={titleId} data-testid="screenshare-unavailable-card">
                    <div className="share-unavailable-head">
                        <strong id={titleId}>{words.title}</strong>
                        <button
                            className="share-unavailable-close"
                            onClick={() => { setOpen(false); button.current?.focus(); }}
                            aria-label="Close"
                            title="Close"
                        >
                            <CloseIcon size={16} />
                        </button>
                    </div>
                    <p>{words.body}</p>
                    {words.getApp && (
                        <button
                            className="share-unavailable-get"
                            onClick={() => {
                                void downloadUrl().then((url) => {
                                    if (url) void openDownloadPage(url);
                                    else setNoPage(true);
                                });
                            }}
                        >
                            Get the Púca app for Android
                        </button>
                    )}
                    {noPage && (
                        <p className="share-unavailable-note">This server doesn't publish a download page. Ask the person who runs it for the app.</p>
                    )}
                </div>
            )}
        </>
    );
}
