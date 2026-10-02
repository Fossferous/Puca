/**
 * StreamAudioHost — plays EVERY watched stream's audio whenever the stream
 * stage is not mounted, wherever the user is in the app.
 *
 * Mounted once, at Chat level, OUTSIDE every viewMode gate (like the OS
 * popout host). One hidden <audio> per watched stream, bound to an
 * audio-only MediaStream of that stream's tracks — nothing here ever touches
 * video. streamAudioRouting.ts holds the rules:
 *
 *  - stage mounted → every element here is MUTED (the stage's Web Audio
 *    graph is the one path); the stage's claim mutes them synchronously, in
 *    the stage's own commit, before its graph can reach the speakers;
 *  - otherwise each stream plays at its own volume × the master Output
 *    Volume (capped at 100% — boost is the stage graph's), unless muted per
 *    stream; your own share never plays back to you;
 *  - Output Device: each element is routed when it appears and re-routed on
 *    settingsChanged / devicechange, and stays muted until ITS first routing
 *    has landed — an autoplaying element starts on the OS default, and
 *    unmuting before the switch would play the start of the stream there.
 *
 * Before this, the chat-view path was the float's single <video>, bound to
 * the FIRST watched stream only: every other watched stream was silent in
 * chat view, and the voice view with the float up mounted neither the stage
 * nor the float, so no stream had audio at all.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
    getCurrentStreamingUserId,
    getSelectedStreams,
    getStreamData,
    subscribeToStreamState,
} from './voiceState';
import { DEFAULT_STREAM_VOLUME, getStreamMutes, getStreamVolumes } from './streamVolumeStore';
import { applyOutputDevice, outputGain } from './settingsStore';
import { stageOwnsStreamAudio, streamAudioPlan, subscribeStageAudio } from './streamAudioRouting';
import { installBackgroundResumeAll } from './deviceStageResume';

function currentPlan() {
    return streamAudioPlan({
        selected: getSelectedStreams(),
        ownId: getCurrentStreamingUserId(),
        stageOwns: stageOwnsStreamAudio(),
        mutes: getStreamMutes(),
        volumes: getStreamVolumes(),
        master: outputGain(),
        defaultVolume: DEFAULT_STREAM_VOLUME,
    });
}

const sameIds = (a: readonly number[], b: readonly number[]) =>
    a.length === b.length && a.every((x, i) => x === b[i]);

/** Bind exactly the source stream's audio tracks; rebind only on a change
 *  (a fresh srcObject restarts playback, so never on every pass). */
function syncTracks(el: HTMLAudioElement, source: MediaStream | null | undefined): boolean {
    const want = source?.getAudioTracks?.() ?? [];
    const bound = el.srcObject as MediaStream | null;
    const have = bound?.getAudioTracks?.() ?? [];
    if (have.length === want.length && want.every(t => have.includes(t))) return false;
    if (want.length === 0) {
        el.srcObject = null;
        return true;
    }
    const audioOnly = new MediaStream();
    for (const t of want) audioOnly.addTrack(t);
    el.srcObject = audioOnly;
    return true;
}

/**
 * The host's imperative core, one per mounted host. Everything that decides
 * muted/volume/binding lives here — synchronous on purpose: the stage's
 * claim must silence these elements within the same task, not after a React
 * render.
 */
function createHostController() {
    // The rendered container, handed over after every commit (attach).
    let container: HTMLDivElement | null = null;
    // Elements whose first Output Device routing has LANDED (may unmute).
    const routed = new WeakSet<HTMLAudioElement>();
    // Elements already handed to routing (a re-render must not re-route).
    const known = new WeakSet<HTMLAudioElement>();
    // addtrack/removetrack listeners per source stream (mesh remote streams
    // fire these; the SFU path re-emits through the stream bus instead).
    const sources = new Map<number, MediaStream>();

    const elements = () => [
        ...(container?.querySelectorAll<HTMLAudioElement>('audio[data-stream-audio]') ?? []),
    ];

    const reconcile = () => {
        const plan = new Map(currentPlan().map(e => [e.userId, e]));
        for (const el of elements()) {
            const userId = Number(el.dataset.streamAudio);
            const entry = plan.get(userId);
            const rebound = syncTracks(el, getStreamData(userId)?.stream);
            const muted = !entry || !entry.audible || !routed.has(el);
            el.muted = muted;
            if (entry) el.volume = entry.volume;
            if (el.srcObject && (rebound || (!muted && el.paused))) {
                el.play().catch(() => { /* autoplay policy: retried on the next pass */ });
            }
        }
    };

    const route = (el: HTMLAudioElement) => {
        void applyOutputDevice(el).then(() => {
            routed.add(el);
            reconcile();
        });
    };

    const onTracks = () => reconcile();
    const unfollow = (src: MediaStream) => {
        src.removeEventListener?.('addtrack', onTracks);
        src.removeEventListener?.('removetrack', onTracks);
    };
    const followSources = () => {
        for (const [id, src] of sources) {
            if (getStreamData(id)?.stream === src && getSelectedStreams().includes(id)) continue;
            unfollow(src);
            sources.delete(id);
        }
        for (const id of getSelectedStreams()) {
            const src = getStreamData(id)?.stream;
            if (!src || sources.get(id) === src) continue;
            src.addEventListener?.('addtrack', onTracks);
            src.addEventListener?.('removetrack', onTracks);
            sources.set(id, src);
        }
    };

    return {
        attach: (el: HTMLDivElement | null) => { container = el; },
        elements,
        reconcile,
        followSources,
        /** After a commit: route elements that just appeared (they stay
         *  muted until routed), then apply the plan to all of them. */
        adopt: () => {
            for (const el of elements()) {
                if (known.has(el)) continue;
                known.add(el);
                el.muted = true;
                route(el);
            }
            reconcile();
        },
        rerouteAll: () => { for (const el of elements()) route(el); },
        dispose: () => {
            for (const src of sources.values()) unfollow(src);
            sources.clear();
        },
    };
}

export function StreamAudioHost() {
    const [ids, setIds] = useState<number[]>(() => currentPlan().map(e => e.userId));
    const containerRef = useRef<HTMLDivElement>(null);
    const [host] = useState(createHostController);

    useLayoutEffect(() => {
        host.attach(containerRef.current);
        host.adopt();
    });

    useEffect(() => {
        const onStreams = () => {
            const next = currentPlan().map(e => e.userId);
            setIds(prev => (sameIds(prev, next) ? prev : next));
            host.followSources();
            host.reconcile();
        };
        const onSettings = () => {
            host.rerouteAll();
            host.reconcile(); // master Output Volume
        };
        onStreams();
        const unsubStreams = subscribeToStreamState(onStreams);
        const unsubStage = subscribeStageAudio(host.reconcile);
        window.addEventListener('settingsChanged', onSettings);
        navigator.mediaDevices?.addEventListener?.('devicechange', host.rerouteAll);
        // Android pauses media elements when the app backgrounds and never
        // un-pauses them; the stage and the float re-play theirs the same way.
        const unsubResume = installBackgroundResumeAll(host.elements);
        return () => {
            unsubStreams();
            unsubStage();
            unsubResume();
            window.removeEventListener('settingsChanged', onSettings);
            navigator.mediaDevices?.removeEventListener?.('devicechange', host.rerouteAll);
            host.dispose();
        };
    }, [host]);

    if (ids.length === 0) return null;
    return (
        <div ref={containerRef} className="stream-audio-host" hidden aria-hidden="true">
            {ids.map(id => (
                // Born MUTED: only reconcile unmutes, and only once routed.
                <audio key={id} data-stream-audio={id} autoPlay muted />
            ))}
        </div>
    );
}
