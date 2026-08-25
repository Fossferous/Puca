import { useEffect, useRef, useState } from 'react';
import { listRoots, listDir, uploadFile, type FsEntry } from '../api/devices/fileTransfer';
import { activeSessions, requestFileAccess, subscribeSessions } from '../api/devices/session';
import { startDeviceDownload } from '../api/devices/deviceDownloads';
import { CloseIcon, DownloadIcon, FileIcon, FolderIcon } from './Icons';
import './DeviceFileManager.css';

/** Fixed row heights — a CONTRACT with `.dfm-entry` in DeviceFileManager.css,
 *  which pins `height` (and single-line ellipsis on the name) to exactly these
 *  values per pointer mode. The windowed list below multiplies by them; a row
 *  that wraps or grows breaks the window math silently, so the height lives in
 *  CSS as `height`, not padding. */
export const DFM_ROW_H_DESKTOP = 32;
export const DFM_ROW_H_COARSE = 48;
/** Rows rendered above/below the viewport so fast scrolling never shows a gap. */
const DFM_OVERSCAN = 8;

export function DeviceFileManager({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
    const [path, setPath] = useState<string>('');
    const [entries, setEntries] = useState<FsEntry[]>([]);
    // The host capped a very large directory; show only what it sent, and say so.
    const [truncated, setTruncated] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [progress, setProgress] = useState<string | null>(null);
    /** HOW the host granted access, or null for "not allowed (yet)" — where
     *  every session starts.
     *
     *  Gated on the SCOPE rather than on a folder path, because the unattended
     *  grant has no single folder: an armed host grants its fixed drives minus
     *  the system locations, so `fileRoot` stays null and a check on that alone
     *  would show the "not shared" gate over a live grant. */
    const [scope, setScope] = useState<'folder' | 'policy' | null>(
        () => activeSessions().find(s => s.id === sessionId)?.fileScopeKind ?? null,
    );
    const [fileRoot, setFileRoot] = useState<string | null>(
        () => activeSessions().find(s => s.id === sessionId)?.fileRoot ?? null,
    );
    /** The 'files' data channel is OPEN. Session.ts only publishes the channel
     *  once it opens, so presence is readiness. Listing before this rejected
     *  with "File transfer is not connected": the grant arrives over the
     *  sealed WebSocket one round trip after the answer, while the channel
     *  still has ICE+DTLS+SCTP to finish — so the automatic first listing
     *  lost the race on every fresh session and the user had to press
     *  Refresh, or read it as broken and give up. */
    const [channelReady, setChannelReady] = useState<boolean>(
        () => Boolean(activeSessions().find(s => s.id === sessionId)?.filesChannel),
    );
    const [asking, setAsking] = useState(false);
    /** Mirror of `asking` readable from the long-lived subscription below. */
    const askingRef = useRef(false);
    /** Windowed-list state: only the rows near the viewport are in the DOM.
     *  A capped listing is still 5000 rows, and mounting 5000 divs with
     *  per-row buttons froze the panel for seconds on a phone. */
    const listRef = useRef<HTMLDivElement | null>(null);
    const [scrollTop, setScrollTop] = useState(0);
    // Default before the ResizeObserver reports (and in jsdom, which never
    // does): the desktop panel's full height, so short lists render whole.
    const [viewH, setViewH] = useState(500);
    const [rowH] = useState(() =>
        typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches
            ? DFM_ROW_H_COARSE
            : DFM_ROW_H_DESKTOP,
    );

    useEffect(() => {
        const el = listRef.current;
        if (!el || typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver(() => {
            if (el.clientHeight > 0) setViewH(el.clientHeight);
        });
        ro.observe(el);
        if (el.clientHeight > 0) setViewH(el.clientHeight);
        return () => ro.disconnect();
        // The list element only exists once a scope is granted.
    }, [scope]);
    /** The session error already latched when the ask went out. The session's
     *  error field is a shared surface (screen-switch failures, privacy
     *  failures, old teardowns all write it and little clears it), so only an
     *  error that CHANGES while we are waiting can be about our request —
     *  treating any latched value as the file answer showed "could not switch
     *  screens" as the reason files were refused. */
    const errorAtAsk = useRef<string | null>(null);

    useEffect(() => subscribeSessions(all => {
        const mine = all.find(s => s.id === sessionId);
        setScope(mine?.fileScopeKind ?? null);
        setFileRoot(mine?.fileRoot ?? null);
        setChannelReady(Boolean(mine?.filesChannel));
        if (mine?.fileScopeKind) {
            askingRef.current = false;
            setAsking(false);
        } else if (
            askingRef.current
            && mine?.error
            && mine.error !== errorAtAsk.current
        ) {
            // A refusal never sets a scope — it arrives as a NEW session
            // error while we wait. Only the grant used to clear `asking`, so
            // one denial left the button on "Waiting for them to answer…"
            // forever. Show why and re-arm it instead.
            askingRef.current = false;
            setAsking(false);
            setError(mine.error);
        }
    }), [sessionId]);

    const loadPath = async (p: string) => {
        setLoading(true);
        setError(null);
        try {
            if (p === '') {
                const roots = await listRoots(sessionId);
                setEntries(roots.map(r => ({ name: r, is_dir: true, size: 0 })));
                setTruncated(false);
            } else {
                const { entries: list, truncated: cut } = await listDir(sessionId, p);
                setEntries(list.sort((a, b) => {
                    if (a.is_dir === b.is_dir) return a.name.localeCompare(b.name);
                    return a.is_dir ? -1 : 1;
                }));
                setTruncated(cut);
            }
            setPath(p);
            // A new folder starts at its top; a stale scroll offset would
            // window the wrong slice of the fresh listing.
            listRef.current?.scrollTo?.(0, 0);
            setScrollTop(0);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
        setLoading(false);
    };

    // Only browse once access has been granted AND the channel is open —
    // both arrive asynchronously, in either order, and a listing sent before
    // either one is a rejection, not a retry.
    useEffect(() => {
        if (!scope || !channelReady) return;
        void loadPath('');
        // loadPath is recreated every render and only closes over sessionId,
        // which is already a dependency.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sessionId, scope, channelReady]);

    const ask = () => {
        errorAtAsk.current = activeSessions().find(s => s.id === sessionId)?.error ?? null;
        askingRef.current = true;
        setAsking(true);
        setError(null);
        requestFileAccess(sessionId);
    };

    const navigateUp = () => {
        if (!path) return;
        // Simple heuristic for parent dir
        const parts = path.split(/[/\\]/).filter(Boolean);
        if (parts.length <= 1) {
            void loadPath('');
        } else {
            parts.pop();
            // Try to guess separator
            const sep = path.includes('\\') ? '\\' : '/';
            void loadPath(parts.join(sep) + (parts.length === 1 && sep === '\\' ? '\\' : ''));
        }
    };

    const joinPath = (name: string) => {
        const sep = path.endsWith('\\') || path.endsWith('/') ? '' : (path.includes('\\') ? '\\' : '/');
        return path + sep + name;
    };

    /**
     * Hand the download to the module-level manager and return immediately.
     *
     * This used to await the whole transfer inside the component, so closing
     * this panel — or toggling Files on the remote-control stage — left the
     * loop writing into a dead React tree with no progress, no cancel and no
     * result. The manager owns it now; progress shows app-wide, and unmounting
     * this panel cannot orphan anything.
     */
    const handleDownload = (entry: FsEntry) => {
        setError(null);
        startDeviceDownload(sessionId, joinPath(entry.name), entry.name, entry.size);
    };

    const handleUpload = () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.onchange = async (e: Event) => {
            const file = (e.target as HTMLInputElement).files?.[0];
            if (!file) return;
            setLoading(true);
            setError(null);
            try {
                // Chunked, and the last chunk truncates: writing a small file
                // over a larger one used to leave the old tail in place.
                await uploadFile(
                    sessionId,
                    joinPath(file.name),
                    file,
                    (done, total) => setProgress(total ? `Uploading ${Math.round((done / total) * 100)}%` : null),
                );
                await loadPath(path);
            } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
            } finally {
                setProgress(null);
                setLoading(false);
            }
        };
        input.click();
    };

    return (
        <div className="device-file-manager">
            <div className="dfm-header">
                <h3>
                    Files: {scope
                        ? (path || (scope === 'policy' ? 'This device' : (fileRoot ?? 'Shared folder')))
                        : 'Not shared'}
                </h3>
                <button onClick={onClose} className="dfm-close" aria-label="Close the file browser"><CloseIcon size={18} /></button>
            </div>

            {!scope ? (
                <div className="dfm-gate">
                    <p>
                        This computer has not shared any files yet. Sharing a screen does
                        not include files — someone at the other computer has to choose a
                        folder, unless it is set up for unattended access.
                    </p>
                    <button onClick={ask} disabled={asking}>
                        {asking ? 'Waiting for them to answer…' : 'Ask to browse files'}
                    </button>
                    {error && <div className="dfm-error">{error}</div>}
                </div>
            ) : (
                <>
                    <div className="dfm-toolbar">
                        <button onClick={navigateUp} disabled={!path}>Up</button>
                        <button onClick={() => void loadPath(path)}>Refresh</button>
                        <button onClick={handleUpload} disabled={!path || loading}>Upload Here</button>
                    </div>

                    {error && <div className="dfm-error">{error}</div>}
                    {progress && <div className="dfm-loading">{progress}</div>}
                    {loading && !progress && <div className="dfm-loading">Loading...</div>}
                    {/* The grant can land a round trip before the data channel
                        finishes ICE+DTLS+SCTP; without this line that window
                        read as "Empty directory" — a wrong answer, not a wait. */}
                    {!channelReady && <div className="dfm-loading">Connecting to the other device…</div>}

                    {truncated && (
                        <div className="dfm-truncated" role="status">
                            This folder has more items than can be shown at once — the first {entries.length.toLocaleString()} are listed. Open a subfolder to narrow it down.
                        </div>
                    )}
                    <div
                        className="dfm-list"
                        ref={listRef}
                        onScroll={ev => setScrollTop((ev.target as HTMLElement).scrollTop)}
                    >
                        {!loading && channelReady && entries.length === 0 && <div className="dfm-empty">Empty directory</div>}
                        {(() => {
                            // Window: render only the rows near the viewport,
                            // with spacer padding standing in for the rest.
                            const first = Math.max(0, Math.floor(scrollTop / rowH) - DFM_OVERSCAN);
                            const count = Math.ceil(viewH / rowH) + DFM_OVERSCAN * 2;
                            const slice = entries.slice(first, first + count);
                            const padTop = first * rowH;
                            const padBottom = Math.max(0, (entries.length - (first + slice.length)) * rowH);
                            return (
                                <div style={{ paddingTop: padTop, paddingBottom: padBottom }}>
                                    {slice.map(e => (
                                        // Height INLINE from the same constant the window
                                        // math multiplies by. It lived in CSS first, where
                                        // the cascade silently defeated it: the coarse-
                                        // pointer 48px rule sat above the base 32px rule,
                                        // so touch rows were 32px while the math assumed
                                        // 48 — a permanently blank strip and unreachable
                                        // tail rows on every phone.
                                        <div key={e.name} className="dfm-entry" style={{ height: rowH }} onClick={() => {
                                            if (e.is_dir) {
                                                const sep = path.includes('\\') || !path ? '\\' : '/';
                                                const newPath = path ? (path.endsWith(sep) ? path + e.name : path + sep + e.name) : e.name;
                                                void loadPath(newPath);
                                            }
                                        }}>
                                            <span className="dfm-icon">{e.is_dir ? <FolderIcon /> : <FileIcon />}</span>
                                            <span className="dfm-name">{e.name}</span>
                                            {/* No longer disabled while the listing loads:
                                                the download does not belong to this panel
                                                any more, so a refresh must not block one. */}
                                            {!e.is_dir && (
                                                <button className="dfm-download" aria-label={`Download ${e.name}`} onClick={(ev) => {
                                                    ev.stopPropagation();
                                                    handleDownload(e);
                                                }}><DownloadIcon /></button>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            );
                        })()}
                    </div>
                </>
            )}
        </div>
    );
}
