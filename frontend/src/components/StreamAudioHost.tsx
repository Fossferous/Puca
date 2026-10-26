/**
 * StreamAudioHost — plays EVERY watched stream's audio whenever the stream
 * stage is not mounted, wherever the user is in the app.
 *
 * Mounted once, at Chat level, OUTSIDE every viewMode gate (like the OS
 * popout host). One hidden <audio> per watched stream, bound to an
 * audio-only MediaStream of that stream's tracks — nothing here ever touches
 * video. streamAudioRouting.ts holds the rules, streamAudioHostCore.ts the
 * engine:
 *
 *  - stage mounted → nothing here sounds (the stage's Web Audio graph is the
 *    one path); the stage's claim silences it synchronously, in the stage's
 *    own commit, before its graph can reach the speakers;
 *  - otherwise each stream sounds through its OWN Web Audio gain, as on the
 *    stage: its level on the loudness curve × the master Output Volume (a
 *    boost above 100% included), ducked by Stream Attenuation while anyone
 *    talks, unless muted per stream; the <audio> is the muted sink Chromium
 *    needs to feed a remote track into Web Audio. Where Web Audio cannot play
 *    yet (or at all) the <audio> itself plays it, as it always did: capped
 *    at 100%, no ducking. Your own share never plays back to you;
 *  - Output Device: the context and each element are routed when they
 *    appear and re-routed on settingsChanged / devicechange; neither sounds
 *    before its own first routing has landed — an autoplaying element and a
 *    new context both start on the OS default.
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
    globalSpeakingUsers,
    subscribeToSpeaking,
    subscribeToStreamState,
} from './voiceState';
import {
    DEFAULT_STREAM_VOLUME, getAttenuation, getStreamMutes, getStreamVolumes, seedStreamVolumes,
} from './streamVolumeStore';
import { applyOutputDevice, applyOutputDeviceToContext, outputGain } from './settingsStore';
import { stageOwnsStreamAudio, streamAudioPlan, subscribeStageAudio } from './streamAudioRouting';
import { createHostController } from './streamAudioHostCore';
import { installBackgroundResumeAll } from './deviceStageResume';
import { onUserGesture } from '../utils/onUserGesture';

function currentPlan() {
    const selected = getSelectedStreams();
    // Nothing watched: skip the storage reads (mutes, volumes, settings).
    if (selected.length === 0) return [];
    return streamAudioPlan({
        selected,
        ownId: getCurrentStreamingUserId(),
        stageOwns: stageOwnsStreamAudio(),
        mutes: getStreamMutes(),
        volumes: getStreamVolumes(),
        master: outputGain(),
        defaultVolume: DEFAULT_STREAM_VOLUME,
    });
}

/** A person watched for the first time gets their first level now: the last
 *  level set on any stream (streamVolumeStore). Never your own share. */
function seedWatched() {
    const own = getCurrentStreamingUserId();
    seedStreamVolumes(getSelectedStreams().filter(id => id !== own));
}

const sameIds = (a: readonly number[], b: readonly number[]) =>
    a.length === b.length && a.every((x, i) => x === b[i]);

export function StreamAudioHost() {
    const [ids, setIds] = useState<number[]>(() => currentPlan().map(e => e.userId));
    const containerRef = useRef<HTMLDivElement>(null);
    const [host] = useState(() => createHostController({
        plan: currentPlan,
        sourceOf: (userId) => getStreamData(userId)?.stream,
        watched: getSelectedStreams,
        routeElement: applyOutputDevice,
        routeContext: applyOutputDeviceToContext,
        createContext: () => new AudioContext(),
        attenuation: getAttenuation,
    }));

    // Only when the ELEMENT SET changes (or the container mounts/unmounts
    // with it): this is an unmemoized child of Chat, which re-renders on
    // every voice-user bump, and every other input to the plan already has
    // its own subscription below (stream bus, stage claim, settingsChanged,
    // devicechange, speaking). Running on every render redid the whole
    // reconcile, storage reads included, for nothing.
    useLayoutEffect(() => {
        host.attach(containerRef.current);
        host.adopt();
    }, [ids, host]);

    useEffect(() => {
        const onStreams = () => {
            seedWatched();
            const next = currentPlan().map(e => e.userId);
            setIds(prev => (sameIds(prev, next) ? prev : next));
            host.followSources();
            host.reconcile();
        };
        const onSettings = () => {
            host.rerouteAll();
            host.reconcile(); // master Output Volume
        };
        // Stream Attenuation: the same trigger as the stage's (anyone in the
        // call talking). The speaking store emits on every flip; the host
        // re-aims only when the answer changes, and reads no storage for it.
        const onSpeaking = () => host.setSpeaking(globalSpeakingUsers.size > 0);
        // Back from the background: a context the platform suspended is
        // resumed on this pass (and the streams wait on their elements).
        const onVisible = () => { if (document.visibilityState === 'visible') host.reconcile(); };
        onStreams();
        onSpeaking();
        const unsubStreams = subscribeToStreamState(onStreams);
        const unsubStage = subscribeStageAudio(host.reconcile);
        const unsubSpeaking = subscribeToSpeaking(onSpeaking);
        window.addEventListener('settingsChanged', onSettings);
        navigator.mediaDevices?.addEventListener?.('devicechange', host.rerouteAll);
        document.addEventListener('visibilitychange', onVisible);
        // Android pauses media elements when the app backgrounds and never
        // un-pauses them; the stage and the float re-play theirs the same way.
        const unsubResume = installBackgroundResumeAll(host.elements);
        // A stream started without a click (auto-watch) may have had its
        // play() refused, or its context left suspended, by the autoplay
        // policy: retry at the next gesture (a pass resumes the context).
        const unsubGesture = onUserGesture(host.reconcile);
        return () => {
            unsubGesture();
            unsubStreams();
            unsubStage();
            unsubSpeaking();
            unsubResume();
            window.removeEventListener('settingsChanged', onSettings);
            navigator.mediaDevices?.removeEventListener?.('devicechange', host.rerouteAll);
            document.removeEventListener('visibilitychange', onVisible);
            host.dispose();
        };
    }, [host]);

    if (ids.length === 0) return null;
    return (
        <div ref={containerRef} className="stream-audio-host" hidden aria-hidden="true">
            {ids.map(id => (
                // Born MUTED: only the engine unmutes one, and only where the
                // element itself must play (the fallback), once routed.
                <audio key={id} data-stream-audio={id} autoPlay muted />
            ))}
        </div>
    );
}
