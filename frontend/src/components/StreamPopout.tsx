/**
 * StreamPopout — puts a watched stream into the OS picture-in-picture window,
 * so it stays on top of everything when Puca is tabbed out or minimised
 * (desktop), or when the phone goes to another app (mobile).
 *
 * WHY A SEPARATE HOST ELEMENT. The in-app tile <video>s do not survive
 * navigation: StreamStage and StreamPip are never mounted together, and each
 * destroys its <video> on unmount (Chat swaps them on every chat ↔ stream
 * change). Chromium closes the PiP window when the PiP element leaves the
 * document, so a PiP started on a tile would die the moment you clicked a
 * channel. This host owns ONE <video> of its own, mounted at Chat level as a
 * sibling of the stream views and OUTSIDE every viewMode gate, bound to the
 * same MediaStream from voiceState. It survives every navigation; that is the
 * whole point of it.
 *
 * THREE ENGINES, ONE COMPONENT (streamPopout.utils.ts says which runtime gets
 * which):
 *  - standard: requestPictureInPicture on this element (desktop shell,
 *    Chromium browsers incl. Android Chrome). Element stays 1x1 hidden.
 *  - webkit: webkitSetPresentationMode('picture-in-picture') (Safari / iOS).
 *    Same hidden element.
 *  - native (Android APP): the Java side floats the WHOLE WebView in an OS
 *    PiP window (PipActivity), sized to the video's aspect ratio. What that
 *    window shows is whatever the page renders — so this element becomes
 *    FULL-VIEWPORT, black-backed, above everything, BEFORE the request goes
 *    out, and the shrunk page is the video. Leaving PiP (expand, swipe-away,
 *    refusal, exitPip) arrives as one plugin event; that clears the state and
 *    the page is itself again.
 *
 * MUTED, ALWAYS. Audio keeps flowing on the existing paths (StreamStage's Web
 * Audio graph in the stream view, StreamPip's element in chat view). This
 * element is video-only; unmuting it would play every stream twice.
 *
 * HIDDEN, BUT RENDERED (standard/webkit). 1x1 and transparent, never
 * display:none — an unrendered element is the classic way
 * requestPictureInPicture starts being refused, and a hidden one may not
 * decode.
 *
 * USER ACTIVATION. requestPictureInPicture must run inside the click's
 * transient activation (~5 s in Chromium). We wait for loadedmetadata (a
 * freshly bound MediaStream normally has it immediately) with a short bail so
 * a stuck bind turns into "the button snaps back", never a stranded host.
 *
 * Why not Document PiP: same JS realm too, but a bigger surface (portal +
 * stylesheet cloning + re-installing the background-resume hook against a
 * foreign document) for the same user-visible result. Why not a second Tauri
 * window: separate WebView2 = separate JS realm, and a MediaStream cannot
 * cross it.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { getSelectedStreams, getStreamData, subscribeToStreamState } from './voiceState';
import { pipEngine, PIP_METADATA_TIMEOUT_MS, PIP_NATIVE_CONFIRM_TIMEOUT_MS, type WebKitVideo } from './streamPopout.utils';
import { enterNativePip, exitNativePip, onNativePipChange } from '../api/mobileApp';

interface StreamPopoutProps {
    /** The stream to pop out (pinned — a floating window that silently
     *  changes subject reads as a bug; switching tiles remounts via `key`). */
    userId: number;
    /** The OS window closed, the stream ended / stopped being watched, or PiP
     *  was refused. The parent clears its state; nothing else to do. */
    onClose: () => void;
}

export function StreamPopout({ userId, onClose }: StreamPopoutProps) {
    const videoRef = useRef<HTMLVideoElement>(null);
    // Decided ONCE per mount (lazy state, not a ref read during render): the
    // runtime does not change under a component.
    const [engine] = useState(pipEngine);
    const native = engine === 'native';
    // Held in a ref so the effects below can stay [] / [userId] and Chat's
    // constant re-renders never re-enter PiP.
    const onCloseRef = useRef(onClose);
    useLayoutEffect(() => { onCloseRef.current = onClose; }, [onClose]);
    // Native only. `requested`: the plugin accepted our request (the window is
    // now the OS's to open — asynchronously). `active`: the OS confirmed it.
    // An unmount in the gap between the two must STILL take the window down
    // (the plugin's exit cancels a not-yet-created window too); latching on
    // the confirmation alone left a floating window with the app's only
    // WebView borrowed and nothing in JS that knew. Refs, not state: nothing
    // renders from them.
    const nativeRequestedRef = useRef(false);
    const nativeActiveRef = useRef(false);
    // The plugin subscription must be up BEFORE the request goes out — the
    // OS can confirm faster than an addListener round-trip, and events are
    // not retained. Set by the listener effect, awaited by the enter effect
    // (declared after it for that reason).
    const nativeSubReadyRef = useRef<Promise<unknown>>(Promise.resolve());

    // Bind the stream (and follow it): the same subscription shape as
    // StreamPip. Losing the stream — deselected, sharer stopped — closes us.
    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;
        const bind = () => {
            if (!getSelectedStreams().includes(userId)) { onCloseRef.current(); return; }
            const data = getStreamData(userId);
            if (!data) { onCloseRef.current(); return; }
            if (data.stream && video.srcObject !== data.stream) {
                video.srcObject = data.stream;
                video.play().catch(err => console.warn('[StreamPopout] play failed:', err));
            }
        };
        bind();
        return subscribeToStreamState(bind);
    }, [userId]);

    // The user closed the OS window (or another video took PiP): we're done.
    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;
        if (engine === 'standard') {
            const onLeave = () => onCloseRef.current();
            video.addEventListener('leavepictureinpicture', onLeave);
            return () => video.removeEventListener('leavepictureinpicture', onLeave);
        }
        if (engine === 'webkit') {
            // One event for every mode change; only leaving PiP is ours. The
            // first change after mount is the entry itself.
            const onMode = () => {
                if ((video as WebKitVideo).webkitPresentationMode !== 'picture-in-picture') onCloseRef.current();
            };
            video.addEventListener('webkitpresentationmodechanged', onMode);
            return () => video.removeEventListener('webkitpresentationmodechanged', onMode);
        }
        if (engine === 'native') {
            let cancelled = false;
            const sub = onNativePipChange(({ active }) => {
                if (cancelled) return;
                nativeActiveRef.current = active;
                // Every way out — expand, swipe-away, refusal, exitPip — is
                // this one event. Never our doing while it says active.
                if (!active) onCloseRef.current();
            });
            nativeSubReadyRef.current = sub;
            return () => {
                cancelled = true;
                void sub.then(h => h?.remove());
            };
        }
        return undefined;
    }, [engine]);

    // Enter PiP once the element has metadata; give up (and tell the parent)
    // if it never arrives inside the activation window.
    useEffect(() => {
        const video = videoRef.current;
        if (!video || !engine) { onCloseRef.current(); return; }
        let done = false;
        let unmounted = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let confirmTimer: ReturnType<typeof setTimeout> | null = null;
        const fail = (why: unknown) => {
            console.warn('[StreamPopout] picture-in-picture refused:', why);
            onCloseRef.current();
        };
        const enter = () => {
            if (done) return;
            done = true;
            if (timer !== null) clearTimeout(timer);
            if (engine === 'standard') {
                video.requestPictureInPicture().catch(fail);
            } else if (engine === 'webkit') {
                const wk = video as WebKitVideo;
                if (wk.webkitSupportsPresentationMode?.('picture-in-picture') && wk.webkitSetPresentationMode) {
                    try { wk.webkitSetPresentationMode('picture-in-picture'); } catch (e) { fail(e); }
                } else {
                    fail('this video cannot enter presentation mode');
                }
            } else {
                // The window is shaped like the video, so give it the real
                // dimensions; a stream without them yet gets 16:9 and the OS
                // keeps that shape (it does not re-fit later). Listener first
                // (see nativeSubReadyRef), then the request; then a WATCHDOG —
                // ok:true means "the OS was asked", and an activity that never
                // gains focus never asks the OS and never answers, which would
                // leave a full-viewport black host over the app for ever.
                void nativeSubReadyRef.current.then(() => {
                    if (unmounted) return;
                    return enterNativePip(video.videoWidth || 16, video.videoHeight || 9).then(ok => {
                        if (unmounted) return;
                        if (!ok) { fail('the app could not open the floating window'); return; }
                        nativeRequestedRef.current = true;
                        confirmTimer = setTimeout(() => {
                            if (unmounted || nativeActiveRef.current) return;
                            fail('the floating window never opened');
                        }, PIP_NATIVE_CONFIRM_TIMEOUT_MS);
                    });
                }).catch(fail);
            }
        };
        if (video.readyState >= 1) {
            enter();
        } else {
            video.addEventListener('loadedmetadata', enter, { once: true });
            timer = setTimeout(() => {
                if (done) return;
                done = true;
                console.warn('[StreamPopout] no metadata within the activation window — not popping out');
                onCloseRef.current();
            }, PIP_METADATA_TIMEOUT_MS);
        }
        return () => {
            done = true;
            unmounted = true;
            if (timer !== null) clearTimeout(timer);
            if (confirmTimer !== null) clearTimeout(confirmTimer);
            video.removeEventListener('loadedmetadata', enter);
        };
    }, [engine]);

    // Unmount (Bring back, stream gone, Chat gone): take the window down with us.
    useEffect(() => {
        const video = videoRef.current;
        return () => {
            if (engine === 'standard') {
                if (video && document.pictureInPictureElement === video) {
                    document.exitPictureInPicture().catch(() => { /* already gone */ });
                }
            } else if (engine === 'webkit') {
                const wk = video as WebKitVideo | null;
                if (wk?.webkitPresentationMode === 'picture-in-picture' && wk.webkitSetPresentationMode) {
                    try { wk.webkitSetPresentationMode('inline'); } catch { /* already gone */ }
                }
            } else if (engine === 'native' && (nativeRequestedRef.current || nativeActiveRef.current)) {
                // Requested OR confirmed — the plugin's exit withdraws a window
                // the OS has not opened yet as well as one it has. Deliberately
                // does NOT bring the app forward: if the user is in another app
                // when the stream ends, the video just goes.
                void exitNativePip();
            }
        };
    }, [engine]);

    return (
        <video
            ref={videoRef}
            className={`stream-popout-host${native ? ' stream-popout-host--native' : ''}`}
            muted
            playsInline
            autoPlay
            aria-hidden="true"
            tabIndex={-1}
            style={native
                ? {
                    // Full-viewport, above everything: the OS PiP window
                    // renders the whole (shrunk) page, and the page must BE
                    // the video. Set BEFORE the request goes out — the OS
                    // captures the first frame for its animation.
                    position: 'fixed',
                    inset: 0,
                    width: '100%',
                    height: '100%',
                    background: '#000',
                    objectFit: 'contain',
                    zIndex: 100000,
                    pointerEvents: 'none',
                }
                : {
                    position: 'fixed',
                    left: 0,
                    bottom: 0,
                    width: 1,
                    height: 1,
                    opacity: 0,
                    pointerEvents: 'none',
                }}
        />
    );
}
