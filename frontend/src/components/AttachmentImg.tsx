/**
 * An attachment's picture, or `fallback` where this device cannot show it.
 *
 * A picture that cannot be displayed must never be a broken-image icon (the
 * owner's IMG20261023012318.heic, 2026-10-23: a HEIC from an Android phone in
 * a text channel, a broken picture in the Windows app). Two ways it cannot:
 *  - its type is one this engine is known not to decode (HEIC/HEIF outside
 *    WebKit: api/heif.ts). Then the <img> is never mounted, so not even one
 *    frame of the broken icon paints; while the engine has not been asked yet
 *    it is neither (nothing, for the few milliseconds the probe takes);
 *  - anything else that fails to decode (a corrupt file, a type that lied):
 *    the <img>'s own error turns it into the fallback.
 * `type` is what the URL's bytes are (useHeldAttachmentUrl / an
 * AttachmentHold's `type`), not what the ref says: a HEIC the device decoded
 * for display is an image/jpeg.
 */
import { useEffect, useState, type ImgHTMLAttributes, type ReactNode } from 'react';
import { engineDecodesHeif, engineShowsType } from '../api/heif';

function useEngineShowsType(type: string | null | undefined): boolean | null {
    const [, setAsked] = useState(0);
    const shows = engineShowsType(type);
    useEffect(() => {
        if (shows !== null) return;
        let alive = true;
        void engineDecodesHeif().then(() => { if (alive) setAsked(n => n + 1); });
        return () => { alive = false; };
    }, [shows]);
    return shows;
}

interface AttachmentImgProps extends ImgHTMLAttributes<HTMLImageElement> {
    src: string;
    type: string | null | undefined;
    fallback: ReactNode;
    /** Shown while it is not known yet whether the engine decodes `type`. */
    pending?: ReactNode;
    /** What the <img> sits in (a button that opens it), when it is shown. */
    wrap?: (img: ReactNode) => ReactNode;
}

export function AttachmentImg({ src, type, fallback, pending = null, wrap, onError, ...img }: AttachmentImgProps) {
    const shows = useEngineShowsType(type);
    const [failedSrc, setFailedSrc] = useState<string | null>(null);
    if (shows === false || failedSrc === src) return <>{fallback}</>;
    if (shows === null) return <>{pending}</>;
    const el = (
        <img
            {...img}
            src={src}
            onError={(e) => {
                setFailedSrc(src);
                onError?.(e);
            }}
        />
    );
    return <>{wrap ? wrap(el) : el}</>;
}
