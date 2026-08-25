/**
 * The Document Picture-in-Picture GRID (W4): one always-on-top OS window,
 * every popped stream a tile inside it. Same JS realm as the app — the
 * portal renders into the PiP document, so MediaStreams and voiceState
 * subscriptions just work; nothing is serialized or re-negotiated.
 *
 * AUDIO OWNERSHIP IS UNCHANGED: every tile's <video> is hard-MUTED. The
 * chat-view audio path is StreamPip's element (kept mounted, hidden, by
 * Chat) and the stream view's is StreamStage's graph — a second audible
 * element here would double every stream's audio.
 *
 * Lifecycle: `requestWindow` runs in the mount effect — inside the click's
 * transient-activation window, which is why Chat mounts this synchronously
 * from the toggle. A rejection (no user activation left, policy, an
 * embedder that lies about support) calls `onFallback`, and Chat drops to
 * the legacy single-video engine for the rest of the session. The user
 * closing the window (pagehide) closes every tile; unmounting closes the
 * window.
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { getStreamData, subscribeToStreamState } from './voiceState';
import { copyStyleSheetsInto } from './streamDocPip';
import { CloseIcon } from './Icons';
import { installBackgroundResumeAll } from './deviceStageResume';

interface DocPipWindowApi {
    documentPictureInPicture?: {
        requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
    };
}

interface StreamDocPipWindowProps {
    userIds: number[];
    onCloseOne: (userId: number) => void;
    onCloseAll: () => void;
    /** requestWindow rejected or the API vanished: the caller falls back to
     *  the legacy popout. */
    onFallback: () => void;
}

function DocPipTile({ userId, onClose }: { userId: number; onClose: () => void }) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const [, setTick] = useState(0);
    // Re-render on stream state changes so a stream that starts after the
    // tile (or swaps its MediaStream) still binds.
    useEffect(() => subscribeToStreamState(() => setTick(t => t + 1)), []);
    const data = getStreamData(userId);
    useEffect(() => {
        const v = videoRef.current;
        if (v && data?.stream && v.srcObject !== data.stream) {
            v.srcObject = data.stream;
            v.play().catch(() => { /* autoplay policy; the tile stays bound */ });
        }
    });
    useEffect(() => installBackgroundResumeAll(() => [videoRef.current]), []);
    return (
        <div className="doc-pip-tile">
            <div className="doc-pip-tile-bar">
                <span className="doc-pip-tile-name">{data?.username ?? `User ${userId}`}</span>
                <button className="doc-pip-tile-close" onClick={onClose} title="Close this tile">
                    <CloseIcon />
                </button>
            </div>
            {/* MUTED, always — see the header. */}
            <video ref={videoRef} autoPlay playsInline muted className="doc-pip-tile-video" />
        </div>
    );
}

export function StreamDocPipWindow({ userIds, onCloseOne, onCloseAll, onFallback }: StreamDocPipWindowProps) {
    const [pipWin, setPipWin] = useState<Window | null>(null);
    // Latest callbacks without re-running the open effect (one window per mount).
    const cbRef = useRef({ onCloseAll, onFallback });
    useEffect(() => { cbRef.current = { onCloseAll, onFallback }; });

    // ONE requestWindow per mounted component, StrictMode included. Dev
    // StrictMode runs effect → cleanup → effect synchronously; a second
    // requestWindow call there either rejects (transient activation is
    // CONSUMED by the first) or replaces the window — and the rejection used
    // to latch docPipFailed for the whole session, in dev, on the very first
    // pop-out (review W4-UI-1). Refs survive the double-invoke: the second
    // run reuses the first's promise.
    const winPromiseRef = useRef<Promise<Window> | null>(null);
    // Whether the component is REALLY mounted — StrictMode's simulated
    // unmount flips this false and immediately back; the deferred check in
    // the close effect sees true again and leaves the window alone.
    const aliveRef = useRef(true);

    useEffect(() => {
        let cancelled = false;
        const api = (window as DocPipWindowApi).documentPictureInPicture;
        if (!api?.requestWindow) {
            cbRef.current.onFallback();
            return;
        }
        if (!winPromiseRef.current) {
            winPromiseRef.current = api.requestWindow({ width: 520, height: 340 });
        }
        winPromiseRef.current
            .then(w => {
                if (cancelled) return;
                copyStyleSheetsInto(w.document);
                w.document.body.classList.add('doc-pip-body');
                // The USER closing the window is "close every tile" — the
                // toggle state must not claim streams are popped into a
                // window that no longer exists.
                w.addEventListener('pagehide', () => cbRef.current.onCloseAll());
                setPipWin(w);
            })
            .catch(() => {
                if (!cancelled) cbRef.current.onFallback();
            });
        return () => { cancelled = true; };
    }, []);

    useEffect(() => {
        aliveRef.current = true;
        return () => {
            aliveRef.current = false;
            // Deferred so StrictMode's synchronous remount can veto: by the
            // microtask, aliveRef is true again for a simulated unmount and
            // still false for a real one.
            queueMicrotask(() => {
                if (!aliveRef.current) {
                    winPromiseRef.current?.then(w => w.close()).catch(() => undefined);
                }
            });
        };
    }, []);

    if (!pipWin) return null;
    return createPortal(
        <div className="doc-pip-grid">
            {userIds.map(id => (
                <DocPipTile key={id} userId={id} onClose={() => onCloseOne(id)} />
            ))}
        </div>,
        pipWin.document.body,
    );
}
