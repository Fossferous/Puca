/**
 * Avatar that only ANIMATES while its owner is speaking.
 *
 * Animated GIF avatars are distracting, so the image is shown frozen (a
 * canvas snapshot of its current frame) unless the user is currently
 * speaking in voice — then the live <img> is shown and a GIF plays. Static
 * avatars look identical in both states, so no animated-format detection is
 * needed. The <img> stays mounted (display:none) while frozen so the browser
 * keeps the resource warm and un-freezing is instant.
 *
 * Canvas note: drawImage of a cross-origin image merely TAINTS the canvas —
 * it still displays. We never read pixels back, so no crossOrigin attribute
 * is needed (setting one would make avatar loads depend on CORS for no
 * benefit).
 *
 * Also honors the local "Hide Profile Picture" preference (avatarPrefs):
 * hidden users render the caller-supplied fallback (initials) instead.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { isUserSpeaking } from './voiceState';
import { isAvatarHidden } from './avatarPrefs';
import { useAuthedFileUrl } from '../hooks/useAuthedFileUrl';

// One shared poll for every mounted avatar (mirrors VoiceStage's 300ms
// cadence — VAD flips don't reliably emit an event). Each subscriber's
// setState no-ops when the value is unchanged, so idle cost is negligible.
const speakChecks = new Set<() => void>();
let speakTimer: number | null = null;

function useIsSpeaking(userId: number): boolean {
    const [speaking, setSpeaking] = useState(() => isUserSpeaking(userId));
    useEffect(() => {
        const check = () => setSpeaking(isUserSpeaking(userId));
        check();
        speakChecks.add(check);
        if (speakTimer === null) {
            speakTimer = window.setInterval(() => speakChecks.forEach((f) => f()), 300);
        }
        return () => {
            speakChecks.delete(check);
            if (speakChecks.size === 0 && speakTimer !== null) {
                clearInterval(speakTimer);
                speakTimer = null;
            }
        };
    }, [userId]);
    return speaking;
}

function useAvatarHidden(userId: number): boolean {
    const [hidden, setHidden] = useState(() => isAvatarHidden(userId));
    useEffect(() => {
        // Deliberate: this is an external-store read, not derived state. The
        // useState initialiser runs only on mount, so without this resync a
        // recycled row rendering a DIFFERENT user keeps the previous user's
        // hidden flag until they happen to toggle it.
        // eslint-disable-next-line react-hooks/set-state-in-effect -- see above
        setHidden(isAvatarHidden(userId));
        const onChange = (e: Event) => {
            const detail = (e as CustomEvent<{ userId: number; hidden: boolean }>).detail;
            if (detail?.userId === userId) setHidden(detail.hidden);
        };
        window.addEventListener('avatarPrefsChanged', onChange);
        return () => window.removeEventListener('avatarPrefsChanged', onChange);
    }, [userId]);
    return hidden;
}

/** Cap snapshot resolution — avatars render at ≤80px; a 4K GIF frame would
 *  waste memory in a 50-message list. */
const SNAPSHOT_MAX = 128;

export function SmartAvatar({ userId, fileId, alt = '', className, fallback }: {
    userId: number;
    /** Uploaded-file id. Resolved to an authenticated object URL internally —
     *  `/files/:id` needs a bearer token now and `<img>` cannot send one. */
    fileId: string | null | undefined;
    alt?: string;
    /** Applied to the <img> AND the frozen <canvas> so site CSS works on both. */
    className?: string;
    /** Rendered when there is no avatar, it failed to load, or the viewer hid it. */
    fallback: ReactNode;
}) {
    const hidden = useAvatarHidden(userId);
    const speaking = useIsSpeaking(userId);
    // null while the authenticated fetch is in flight, and if it fails — both
    // land on the caller's fallback rather than a broken image.
    const src = useAuthedFileUrl(hidden ? null : fileId);
    const [failed, setFailed] = useState(false);
    const [loaded, setLoaded] = useState(false);
    const imgRef = useRef<HTMLImageElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);

    // A new src is a new load cycle — and so is coming back from hidden, which
    // unmounts the <img> and <canvas> entirely. Without the `hidden` dep,
    // un-hiding remounted a BRAND NEW canvas while `loaded` was still true and
    // `animate`/`src` were unchanged, so the snapshot effect never re-ran and
    // the avatar came back as an empty 300x150 canvas.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate reset, see above
    useEffect(() => { setFailed(false); setLoaded(false); }, [src, hidden]);

    // Catch an image that was already complete before React attached onLoad
    // (memory-cached src on a freshly mounted element). Without this, resetting
    // `loaded` above could strand a cached avatar at "never loaded" — no load
    // event is coming, because the browser already had it.
    // Intentionally has NO dependency array: it must re-check after every
    // render, because `complete` flips on the DOM node without notifying React.
    // The `!loaded` guard is what stops it looping — once set, the condition is
    // false forever for this src, and resetting `loaded` above is gated on src.
    useEffect(() => {
        const img = imgRef.current;
        // The directive goes on the setState CALL, not on the useEffect: this
        // rule reports at the call site, so a directive above the hook lands on
        // the wrong line and is flagged as unused while the error persists.
        // eslint-disable-next-line react-hooks/set-state-in-effect -- see above
        if (!loaded && img?.complete && img.naturalWidth) setLoaded(true);
    });

    const animate = speaking && !hidden;

    // (Re)take the snapshot whenever we freeze — the frozen frame is
    // whatever the animation showed at that moment.
    useEffect(() => {
        if (animate || !loaded) return;
        const img = imgRef.current;
        const canvas = canvasRef.current;
        if (!img || !canvas || !img.naturalWidth) return;
        const scale = Math.min(1, SNAPSHOT_MAX / Math.max(img.naturalWidth, img.naturalHeight));
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
        try {
            canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height);
        } catch { /* decode hiccup — the hidden img simply stays hidden */ }
    }, [animate, loaded, src]);

    if (!src || hidden || failed) return <>{fallback}</>;

    return (
        <>
            {/* NO loading="lazy" here. A lazily-loaded image that is
                display:none has no layout box, so it never intersects the
                viewport and the browser NEVER fetches it — the load event
                never fires, the snapshot is never taken, and the avatar
                renders as an empty circle until its owner happens to speak.
                Avatars are a few KB and the canvas replaces the <img>
                visually anyway, so there is nothing to defer. */}
            <img
                ref={imgRef}
                src={src}
                alt={alt}
                className={className}
                style={animate ? undefined : { display: 'none' }}
                onLoad={() => setLoaded(true)}
                onError={() => setFailed(true)}
            />
            {!animate && loaded && <canvas ref={canvasRef} className={className} aria-hidden />}
        </>
    );
}
