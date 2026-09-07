/**
 * One live camera bound to one <video>. Shared by every surface that shows a
 * face: the voice stage's grid tiles and the stream stage's camera rail.
 *
 * It lives in its own file because there are now two callers and a camera
 * <video> has three non-obvious requirements that must not be re-derived
 * independently in each of them:
 *
 *  - `srcObject` cannot be set declaratively, so binding is an effect keyed on
 *    stream identity;
 *  - `muted` is LOAD-BEARING. The sender's microphone already plays through
 *    the per-user <audio> elements, so an unmuted tile would double every
 *    voice and bypass deafen entirely;
 *  - Android and iOS pause a <video> when the app backgrounds and never
 *    un-pause it, and the bind effect above only fires on a new stream — so
 *    each tile keeps its own resume listener.
 *
 * It must also be rendered inside a KEYED parent that never moves between JSX
 * parents: a reparented <video> pauses and paints a black frame over live
 * video, which is the "tile went black after moving around the UI" bug the
 * stream grid's own comment warns about at length.
 */
import { useEffect, useRef } from 'react';

import { installBackgroundResumeAll } from './deviceStageResume';

export function CameraVideo({
    stream,
    mirrored = false,
    className = 'vs-camera-video',
}: {
    stream: MediaStream;
    /** Your OWN camera is mirrored, because that is what a mirror does and
     *  every other product does it too. Never mirror somebody else's. */
    mirrored?: boolean;
    className?: string;
}) {
    const ref = useRef<HTMLVideoElement>(null);
    useEffect(() => {
        const el = ref.current;
        if (el && el.srcObject !== stream) {
            el.srcObject = stream;
            // autoplay is not reliable when srcObject lands after mount —
            // kick playback explicitly (muted video is always allowed).
            void el.play().catch(() => { /* transient; retried on next bind */ });
        }
    }, [stream]);
    useEffect(() => installBackgroundResumeAll(() => [ref.current]), []);
    return (
        <video
            ref={ref}
            className={`${className}${mirrored ? ' mirrored' : ''}`}
            autoPlay
            playsInline
            muted
        />
    );
}
