/**
 * Púca's own pop-out windows (desktop shell): one always-on-top, freely
 * resizable OS window per popped stream. The mechanism and why it exists are
 * in streamOsWindows.ts and src-tauri/src/popout.rs.
 *
 * Each window is an about:blank document this realm owns; React portals its
 * content into it, so the <video> binds the SAME MediaStream the app already
 * decodes (as the Doc-PiP grid does). AUDIO OWNERSHIP IS UNCHANGED: the video
 * is hard-MUTED — StreamStage's graph or StreamAudioHost is the one audible
 * path (streamAudioRouting.ts); a second one here would double every stream.
 *
 * Lifecycle, per stream:
 *  - mount opens the window (once — StrictMode's double effect reuses it);
 *  - the USER closing it (title-bar X, Alt+F4) fires pagehide → onCloseOne,
 *    and the stream comes back to the app;
 *  - the APP removing the stream (Bring back, the stream ending, leaving the
 *    call) unmounts it → `popout_close` through the shell;
 *  - a refused window.open → onRefused, never a toggle pointing at nothing.
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { getStreamData, subscribeToStreamState } from './voiceState';
import { copyStyleSheetsInto } from './streamDocPip';
import {
    assignSlots, closeOsWindow, noteOsWindowOpened, openOsWindow, osWindowPin, sameSlots,
} from './streamOsWindows';
import { CloseIcon, PinIcon } from './Icons';
import { installBackgroundResumeAll } from './deviceStageResume';
import { logPipDiag } from '../api/pipDiag';

interface StreamPopoutWindowsProps {
    userIds: number[];
    /** The user closed that stream's window, or pressed its Back button. */
    onCloseOne: (userId: number) => void;
    /** The shell refused that stream's window. */
    onRefused: (userId: number) => void;
}

export function StreamPopoutWindows({ userIds, onCloseOne, onRefused }: StreamPopoutWindowsProps) {
    // Slot per stream, derived from the previous assignment (stable slots are
    // what the shell's remembered size/place hang off). Updated during render
    // — React's "adjusting state when a prop changes" pattern; it converges
    // because assignSlots of its own output is a fixed point.
    const [slots, setSlots] = useState<Map<number, number>>(() => new Map());
    const next = assignSlots(slots, userIds);
    if (!sameSlots(next, slots)) setSlots(next);
    return (
        <>
            {[...next].map(([id, slot]) => (
                <StreamOsWindow key={id} userId={id} slot={slot} onClose={onCloseOne} onRefused={onRefused} />
            ))}
        </>
    );
}

interface StreamOsWindowProps {
    userId: number;
    slot: number;
    onClose: (userId: number) => void;
    onRefused: (userId: number) => void;
}

function StreamOsWindow({ userId, slot, onClose, onRefused }: StreamOsWindowProps) {
    const [win, setWin] = useState<Window | null>(null);
    const cbRef = useRef({ onClose, onRefused });
    useEffect(() => { cbRef.current = { onClose, onRefused }; });
    // The window, opened exactly once per mounted component. StrictMode runs
    // effect → cleanup → effect; the second run must reuse, not reopen.
    const openedRef = useRef<{ w: Window | null } | null>(null);
    // Really mounted? StrictMode's simulated unmount flips this and back
    // before the deferred close checks it (as StreamDocPipWindow does).
    const aliveRef = useRef(true);

    useEffect(() => {
        if (!openedRef.current) {
            const w = openOsWindow(slot);
            openedRef.current = { w };
            if (w) {
                noteOsWindowOpened();
                copyStyleSheetsInto(w.document);
                // Theme and contrast live as data-* attributes on the app's
                // <html>; without them the copied sheets resolve the default.
                for (const a of Array.from(document.documentElement.attributes)) {
                    if (a.name.startsWith('data-')) w.document.documentElement.setAttribute(a.name, a.value);
                }
                w.document.body.classList.add('os-pop-body');
                logPipDiag(`[pop-out] window ${slot} opened`);
            } else {
                logPipDiag(`[pop-out] window ${slot} refused by the shell`);
            }
        }
        const w = openedRef.current.w;
        if (!w) {
            cbRef.current.onRefused(userId);
            return;
        }
        let gone = false;
        const closedByUser = () => {
            if (gone) return;
            gone = true;
            cbRef.current.onClose(userId);
        };
        w.addEventListener('pagehide', closedByUser);
        // Belt and braces: pagehide fires for the title-bar close (measured),
        // but a window that went away by any other road must not leave the
        // toggle saying "popped" for ever.
        const poll = window.setInterval(() => { if (w.closed) closedByUser(); }, 1000);
        // The window exists only once this effect has opened it (window.open
        // must not run during render); the portal needs it as state.
        setWin(w);
        return () => {
            w.removeEventListener('pagehide', closedByUser);
            window.clearInterval(poll);
        };
    }, [userId, slot]);

    useEffect(() => {
        aliveRef.current = true;
        return () => {
            aliveRef.current = false;
            queueMicrotask(() => {
                if (aliveRef.current) return;
                const w = openedRef.current?.w ?? null;
                if (w && !w.closed) closeOsWindow(slot, w);
            });
        };
    }, [slot]);

    if (!win) return null;
    return createPortal(
        <OsWindowContent userId={userId} slot={slot} onBack={() => onClose(userId)} />,
        win.document.body,
    );
}

function OsWindowContent({ userId, slot, onBack }: { userId: number; slot: number; onBack: () => void }) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const [, setTick] = useState(0);
    // Re-render on stream state changes, so a stream that swaps its
    // MediaStream (or a name that arrives late) still binds.
    useEffect(() => subscribeToStreamState(() => setTick(t => t + 1)), []);
    const data = getStreamData(userId);
    const name = data?.username ?? `User ${userId}`;
    // The window's title bar: the shell copies the document title. The
    // video lives in the pop-out's own document, so that is the one named.
    useEffect(() => {
        const d = videoRef.current?.ownerDocument;
        if (d) d.title = name;
    }, [name]);
    useEffect(() => {
        const v = videoRef.current;
        if (v && data?.stream && v.srcObject !== data.stream) {
            v.srcObject = data.stream;
            // (jsdom's play() returns nothing; a browser's returns a promise.)
            Promise.resolve().then(() => v.play()).catch(() => { /* autoplay policy; stays bound */ });
        }
    });
    useEffect(() => installBackgroundResumeAll(() => [videoRef.current]), []);

    // Always-on-top, per window, remembered by the shell per slot.
    const [pinned, setPinned] = useState(true);
    useEffect(() => {
        let live = true;
        osWindowPin(slot).then(p => { if (live) setPinned(p); }, () => { /* keep the default */ });
        return () => { live = false; };
    }, [slot]);
    const togglePin = () => {
        const want = !pinned;
        setPinned(want);
        osWindowPin(slot, want).then(setPinned, () => setPinned(!want));
    };

    return (
        <div className="os-pop">
            {/* MUTED, always — see the header. */}
            <video ref={videoRef} autoPlay playsInline muted className="os-pop-video" />
            <div className="os-pop-bar">
                <span className="os-pop-name">{name}</span>
                <button
                    type="button"
                    className={`os-pop-btn${pinned ? ' is-on' : ''}`}
                    data-testid="os-pop-pin"
                    aria-pressed={pinned}
                    aria-label="Keep on top"
                    title={pinned ? 'Kept on top — click to let other windows cover it' : 'Keep on top of other windows'}
                    onClick={togglePin}
                >
                    <PinIcon />
                </button>
                <button
                    type="button"
                    className="os-pop-btn"
                    data-testid="os-pop-back"
                    aria-label="Back to Púca"
                    title="Back to Púca"
                    onClick={onBack}
                >
                    <CloseIcon />
                </button>
            </div>
        </div>
    );
}
