/**
 * ImageLightbox — full-screen view of a decrypted image attachment.
 *
 * Clicking an image used to call openAttachmentBlob, which does
 * `window.open(blobUrl)`. That is a NO-OP in both shells we actually ship:
 * the Tauri WebView registers no shell/opener plugin, and Capacitor's Android
 * WebView blocks blob: URLs — so clicking a picture simply did nothing. In a
 * plain browser it "worked" by navigating away to a bare tab, which is not an
 * enlargement either.
 *
 * Portaled to <body> deliberately: attachments render inside checklist/sidebar
 * containers that are overflow:hidden, and the mobile sidebar carries a CSS
 * transform, which would trap a position:fixed child inside it.
 *
 * SECURITY: rendering through <img> is also strictly safer than the old
 * top-level open. A blob: URL opened as a document inherits this app's origin,
 * so a malicious SVG attachment (the MIME is attacker-controlled — it rides in
 * the ref) could have run script in-origin and read localStorage. Browsers
 * never execute script in SVG loaded via <img>, so no MIME allowlist is needed
 * here; the download link cannot execute anything either.
 *
 * ZOOM. The picture sits on a transformed CANVAS inside an untransformed
 * SURFACE that owns the gestures (the same shape as DeviceStage): double-tap /
 * double-click toggles fit ↔ 2.5x anchored at the tap, two fingers pinch, one
 * finger pans while zoomed, ctrl+wheel zooms on desktop. The pan is clamped to
 * the PICTURE (never the letterbox bars) with the shared clampPanTo. Pointer
 * events only — one code path for mouse and touch — and the wheel listener is
 * a NATIVE non-passive one, because React's onWheel is passive and a passive
 * preventDefault is a no-op, so ctrl+wheel would zoom the whole app.
 *
 * Tap-to-close: at 1x a tap on the backdrop closes (as before) and a tap on the
 * picture does nothing (as before). While zoomed a single tap does NOTHING —
 * "reset on backdrop tap" would make the first tap of a double-tap undo the
 * second. Escape, the close button and a double-tap all still leave the
 * zoomed state.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { canCopyImages, copyImageToClipboard, describeCopyFailure } from '../api/copyImage';
import { CheckIcon, CloseIcon } from './Icons';
import { clampPanTo } from './deviceZoomFollow';
import {
    zoomAt, isDoubleTap,
    DOUBLE_TAP_SCALE, TAP_SLOP_PX,
    type Transform, type Box, type Picture, type TapMark,
} from './imageZoom';
import './ImageLightbox.css';

interface ImageLightboxProps {
    url: string;
    name?: string;
    onClose: () => void;
}

/**
 * Save the blob without ever exposing its URL to a top-level navigation.
 *
 * A persistent `<a href={blobUrl} download>` looks safe, but Chrome's
 * "Open link in new tab" IGNORES the download attribute — and a blob: document
 * inherits this app's origin, so an SVG attachment (the MIME rides in the
 * attacker-supplied ref) could run script in-origin and read the token/E2EE
 * seed. A transient, programmatically-clicked anchor is not right-clickable, so
 * that route simply doesn't exist.
 */
function downloadBlob(url: string, name?: string) {
    const a = document.createElement('a');
    a.href = url;
    a.download = name || 'image';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
}

const FIT: Transform = { scale: 1, x: 0, y: 0 };
/** ctrl+wheel: multiplicative per event. A mouse notch (deltaY ±100) is
 *  ~1.22x; trackpad pinch deltas are single digits and stay smooth. */
const WHEEL_ZOOM_RATE = 0.002;

/** The first contact of the current gesture — what a tap is judged from. */
interface DownInfo { x: number; y: number; onPicture: boolean; moved: boolean }

export function ImageLightbox({ url, name, onClose }: ImageLightboxProps) {
    const [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied' | 'error'>('idle');
    const [copyError, setCopyError] = useState('');
    const [t, setT] = useState<Transform>(FIT);
    // The gesture handlers read the committed transform through this ref
    // (they run between renders); kept in sync by effect, not during render.
    const tRef = useRef(t);
    useEffect(() => { tRef.current = t; }, [t]);

    const surfaceRef = useRef<HTMLDivElement>(null);
    const imgRef = useRef<HTMLImageElement>(null);
    /** Live contacts, by pointerId, at their LAST seen surface position. */
    const pointers = useRef<Map<number, { x: number; y: number }>>(new Map());
    const lastPinch = useRef<{ dist: number; cx: number; cy: number } | null>(null);
    const lastTap = useRef<TapMark | null>(null);
    const down = useRef<DownInfo | null>(null);

    /** Surface box + the picture's letterbox inside it, in CSS px. offset*
     *  are layout values, unaffected by the canvas transform, and the canvas
     *  is inset:0 in the surface, so canvas origin == surface origin. Null
     *  picture (no layout yet) falls back to canvas bounds in clampPanTo. */
    const geom = useCallback((): { box: Box; pict: Picture | null; ox: number; oy: number } => {
        const s = surfaceRef.current;
        const img = imgRef.current;
        const r = s?.getBoundingClientRect();
        const box = { w: r?.width ?? 0, h: r?.height ?? 0 };
        const pict = img && img.offsetWidth > 0 && img.offsetHeight > 0
            ? { offX: img.offsetLeft, offY: img.offsetTop, dispW: img.offsetWidth, dispH: img.offsetHeight }
            : null;
        return { box, pict, ox: r?.left ?? 0, oy: r?.top ?? 0 };
    }, []);

    // Revert the confirmation so the button reads as usable again. Without it
    // the "Copied" confirmation sticks for as long as the lightbox is open,
    // which looks like a disabled control rather than a completed action.
    useEffect(() => {
        if (copyState !== 'copied') return;
        const t = setTimeout(() => setCopyState('idle'), 2000);
        return () => clearTimeout(t);
    }, [copyState]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            // Capture + stop: Escape is also the remote-control kill switch and
            // closes other overlays — the topmost one should win.
            e.stopPropagation();
            onClose();
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [onClose]);

    // ctrl+wheel zoom. NATIVE and non-passive on purpose (see the header).
    useEffect(() => {
        const s = surfaceRef.current;
        if (!s) return;
        const onWheel = (e: WheelEvent) => {
            if (!e.ctrlKey) return; // plain wheel: nothing to scroll here, leave it alone
            e.preventDefault();
            const { box, pict, ox, oy } = geom();
            // deltaY is in PIXELS in Chromium/WebView2 but in LINES in Firefox
            // (deltaMode 1) — un-normalised, a Firefox notch of ±3 would be a
            // 0.6% zoom, i.e. a no-op. Pages (deltaMode 2) are treated as ~a
            // screenful.
            const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
            const focal = { x: e.clientX - ox, y: e.clientY - oy };
            // Functional update: wheel events can land faster than React
            // commits, and the ref only refreshes in a passive effect — a
            // value-form setT would apply each event to a stale base and
            // drop increments (DeviceStage documents the same trap).
            setT(cur => zoomAt(cur, focal, cur.scale * Math.exp(-dy * WHEEL_ZOOM_RATE), box, pict));
        };
        s.addEventListener('wheel', onWheel, { passive: false });
        return () => s.removeEventListener('wheel', onWheel);
    }, [geom]);

    // Orientation change / soft keyboard: re-clamp so the picture is never
    // stranded out of bounds.
    useEffect(() => {
        const onResize = () => {
            const { box, pict } = geom();
            setT(cur => (cur.scale === 1 ? cur : clampPanTo(box, pict, cur.scale, cur.x, cur.y)));
        };
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, [geom]);

    /** (Re)measure the pinch baseline from the CURRENT two contacts. Called
     *  whenever the contact set becomes exactly two — on the second finger's
     *  down, and when a third finger lifts back to two — so the next move
     *  measures against these fingers, not whichever pair started it. */
    const seedPinch = () => {
        const [a, b] = [...pointers.current.values()];
        lastPinch.current = { dist: Math.hypot(b.x - a.x, b.y - a.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
    };

    const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        const s = surfaceRef.current;
        if (!s) return;
        // Right/middle mouse buttons are not taps: a right-click on the
        // backdrop must open the context menu, not close the viewer.
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        // Prune contacts the browser dropped without a pointerup (guarded:
        // jsdom has neither method, which is what makes the DOM test possible).
        if (typeof s.hasPointerCapture === 'function') {
            for (const id of [...pointers.current.keys()]) {
                if (id !== e.pointerId && !s.hasPointerCapture(id)) pointers.current.delete(id);
            }
        }
        pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        s.setPointerCapture?.(e.pointerId);
        if (pointers.current.size === 1) {
            // `onPicture` MUST be captured now: with pointer capture active,
            // pointerup retargets to the surface and can no longer say where
            // the tap landed.
            down.current = { x: e.clientX, y: e.clientY, onPicture: e.target === imgRef.current, moved: false };
            lastPinch.current = null;
        } else {
            // Two fingers: pinch from here. Three or more: the pinch pauses
            // (no baseline) until the set is two again — see endPointer.
            if (pointers.current.size === 2) seedPinch(); else lastPinch.current = null;
            if (down.current) down.current.moved = true; // a pinch is never a tap
        }
    };

    const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
        const prev = pointers.current.get(e.pointerId);
        if (!prev) return;
        pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const d = down.current;
        if (d && !d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) > TAP_SLOP_PX) d.moved = true;

        if (pointers.current.size >= 2) {
            if (pointers.current.size !== 2 || !lastPinch.current) return; // three+ fingers: hold
            const [a, b] = [...pointers.current.values()];
            const dist = Math.hypot(b.x - a.x, b.y - a.y);
            const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
            const lp = lastPinch.current;
            lastPinch.current = { dist, cx, cy };
            if (lp.dist <= 0) return;
            const { box, pict, ox, oy } = geom();
            const ratio = dist / lp.dist;
            const dcx = cx - lp.cx, dcy = cy - lp.cy;
            const focal = { x: cx - ox, y: cy - oy };
            // Functional update (see the wheel handler): two fingers emit two
            // moves per frame, and both must accumulate. Two-finger PAN (the
            // midpoint moved) then zoom about the new midpoint — algebraically
            // DeviceStage's focal formula.
            setT(cur => {
                const panned: Transform = { scale: cur.scale, x: cur.x + dcx, y: cur.y + dcy };
                const next = zoomAt(panned, focal, cur.scale * ratio, box, pict);
                return next.scale === 1 ? FIT : clampPanTo(box, pict, next.scale, next.x, next.y);
            });
            return;
        }

        if (pointers.current.size === 1 && tRef.current.scale > 1) {
            const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
            const { box, pict } = geom();
            setT(cur => clampPanTo(box, pict, cur.scale, cur.x + dx, cur.y + dy));
        }
    };

    const endPointer = (e: React.PointerEvent<HTMLDivElement>, cancelled: boolean) => {
        const s = surfaceRef.current;
        const wasTracked = pointers.current.delete(e.pointerId);
        if (!wasTracked) return; // a button we ignored on the way down, or a stray up
        try { s?.releasePointerCapture?.(e.pointerId); } catch { /* not captured */ }
        // Back to exactly two fingers: re-baseline the pinch on the SURVIVORS —
        // measuring against the pair that started it would jump the zoom.
        if (pointers.current.size === 2) seedPinch(); else lastPinch.current = null;
        if (pointers.current.size > 0) return; // gesture continues on the remaining finger(s)
        const d = down.current;
        down.current = null;
        if (cancelled || !d || d.moved) return; // a drag / pinch / cancelled contact is not a tap

        const now = Date.now();
        const pt = { x: e.clientX, y: e.clientY };
        const cur = tRef.current;
        if (isDoubleTap(lastTap.current, now, pt)) {
            lastTap.current = null;
            const { box, pict, ox, oy } = geom();
            const focal = { x: pt.x - ox, y: pt.y - oy };
            setT(cur.scale > 1 ? FIT : zoomAt(cur, focal, DOUBLE_TAP_SCALE, box, pict));
            return;
        }
        lastTap.current = { at: now, ...pt };
        // Backdrop tap at fit closes (today's behaviour). On the picture, or
        // while zoomed, a single tap does nothing.
        if (cur.scale === 1 && !d.onPicture) onClose();
    };

    // React portals propagate synthetic events through the REACT tree, so
    // touches inside this overlay reach .chat-container's panel swipe (a
    // horizontal swipe over an open lightbox changed the mobile panel behind
    // it, and pan-while-zoomed would do it constantly). touch-action:none does
    // not help — only stopping the synthetic propagation does.
    const swallowTouch = (e: React.TouchEvent) => e.stopPropagation();

    return createPortal(
        <div
            className="image-lightbox"
            onClick={onClose}
            onTouchStart={swallowTouch}
            onTouchMove={swallowTouch}
            onTouchEnd={swallowTouch}
            role="dialog"
            aria-modal="true"
            aria-label={name || 'Image'}
        >
            <div
                ref={surfaceRef}
                className={`image-lightbox-surface${t.scale > 1 ? ' zoomed' : ''}`}
                onClick={e => e.stopPropagation()}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={e => endPointer(e, false)}
                onPointerCancel={e => endPointer(e, true)}
            >
                <div
                    className="image-lightbox-canvas"
                    style={{ transform: `translate(${t.x}px, ${t.y}px) scale(${t.scale})`, transformOrigin: '0 0' }}
                >
                    <img ref={imgRef} src={url} alt={name || ''} draggable={false} />
                </div>
            </div>
            <div className="image-lightbox-bar" onClick={e => e.stopPropagation()}>
                {name && <span className="image-lightbox-name">{name}</span>}
                {/* Inline state rather than a toast: the button is right here,
                    which is the same idiom AttachmentDownload uses. */}
                {canCopyImages() && (
                    <button
                        className="image-lightbox-dl"
                        disabled={copyState === 'copying'}
                        onClick={async () => {
                            setCopyState('copying');
                            const r = await copyImageToClipboard(url);
                            setCopyState(r.ok ? 'copied' : 'error');
                            setCopyError(r.ok ? '' : describeCopyFailure(r.reason));
                        }}
                    >
                        {copyState === 'copying' ? 'Copying…'
                            : copyState === 'copied' ? <>Copied <CheckIcon /></>
                                : copyState === 'error' ? 'Copy failed'
                                    : 'Copy'}
                    </button>
                )}
                <button className="image-lightbox-dl" onClick={() => downloadBlob(url, name)}>
                    Download
                </button>
            </div>
            {copyState === 'error' && copyError && (
                <div className="image-lightbox-error" onClick={e => e.stopPropagation()}>{copyError}</div>
            )}
            <button className="image-lightbox-close" onClick={onClose} aria-label="Close"><CloseIcon size={18} /></button>
        </div>,
        document.body,
    );
}
