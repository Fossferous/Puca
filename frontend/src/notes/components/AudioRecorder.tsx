/**
 * The voice-note recorder sheet: a prominent disclosure, then the microphone,
 * then Stop, then a preview you can play before you keep it.
 *
 * RULES THIS COMPONENT KEEPS, all of them load-bearing:
 *  - The DISCLOSURE comes BEFORE the microphone is asked for, the way
 *    native/NotesLocationSettings.tsx does it for location. Dismissing it
 *    never touches the mic.
 *  - FOREGROUND ONLY. Exactly one getUserMedia stream, stopped on Stop, on
 *    Discard, on unmount, and on `visibilitychange`/`pagehide` — nothing here
 *    can record with the app off the screen, and there is no service behind
 *    it (docs/NOTES.md, "The Android app").
 *  - NOTHING PLAYS BY ITSELF. The preview is an <audio controls> with no
 *    autoplay and no call to play(); sound happens because someone pressed
 *    play, never because a recording finished.
 *  - The clip stops itself at MAX_CLIP_MS, so a forgotten recorder cannot
 *    fill the upload budget.
 *
 * The recorded clip is handed back as a File; the caller seals and uploads it
 * through api/noteMedia.ts exactly as it would a photo.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CloseIcon, MicIcon, StopIcon, TrashIcon } from '../../components/Icons';
import { MAX_CLIP_MS, assertClipUploadable, extForMime, formatClipTime, pickAudioMime } from '../model/audioNote';
import '../noteContent.css';

export const MIC_DISCLOSURE =
    'Púca Notes will use this phone’s microphone to record a voice note, only while this recorder is open '
    + 'and only while the app is on screen. The recording is encrypted on this device and stored like a '
    + 'photo — it is never sent anywhere to be listened to or written down. Continue?';

export interface RecordedClip {
    file: File;
    /** How long the recorder ran, in ms (what transcribe.ts budgets on). */
    durationMs: number;
    /** An on-device preview URL the CALLER now owns and must revoke. */
    url: string;
}

interface Props {
    /** Keep this clip. Resolving false leaves the sheet open with the take. */
    onSave: (clip: RecordedClip) => Promise<boolean> | boolean;
    onCancel: () => void;
}

type Phase = 'asking' | 'recording' | 'review' | 'refused';

export function AudioRecorder({ onSave, onCancel }: Props) {
    const [phase, setPhase] = useState<Phase>('asking');
    const [error, setError] = useState<string | null>(null);
    const [elapsed, setElapsed] = useState(0);
    const [level, setLevel] = useState(0);
    const [take, setTake] = useState<RecordedClip | null>(null);
    const [saving, setSaving] = useState(false);

    const streamRef = useRef<MediaStream | null>(null);
    const recorderRef = useRef<MediaRecorder | null>(null);
    const ctxRef = useRef<AudioContext | null>(null);
    const startedAt = useRef(0);
    const takeRef = useRef<RecordedClip | null>(null);
    const keptRef = useRef(false);
    useEffect(() => { takeRef.current = take; });

    /** Every way out of holding the microphone. Safe to call twice. */
    const release = useCallback(() => {
        try {
            if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
        } catch { /* already stopped */ }
        recorderRef.current = null;
        for (const t of streamRef.current?.getTracks() ?? []) {
            try { t.stop(); } catch { /* already stopped */ }
        }
        streamRef.current = null;
        const ctx = ctxRef.current;
        ctxRef.current = null;
        // Older engines' close() returns undefined rather than a promise, so
        // never chain .catch on it directly.
        if (ctx) { try { void Promise.resolve(ctx.close()).catch(() => {}); } catch { /* already closed */ } }
    }, []);

    // Off the screen = off the microphone, and the take so far is kept.
    useEffect(() => {
        const leave = () => { if (document.visibilityState === 'hidden') release(); };
        document.addEventListener('visibilitychange', leave);
        window.addEventListener('pagehide', release);
        return () => {
            document.removeEventListener('visibilitychange', leave);
            window.removeEventListener('pagehide', release);
        };
    }, [release]);

    // Unmount: the microphone goes, and a take nobody kept is freed.
    useEffect(() => () => {
        release();
        if (takeRef.current && !keptRef.current) URL.revokeObjectURL(takeRef.current.url);
    }, [release]);

    const stop = useCallback(() => {
        try {
            if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
            else release();
        } catch {
            release();
        }
    }, [release]);

    const begin = useCallback(async () => {
        const mime = pickAudioMime();
        if (!mime) { setError('This device can’t record audio.'); setPhase('refused'); return; }
        // The disclosure FIRST — before a single call that could prompt.
        if (!window.confirm(MIC_DISCLOSURE)) { onCancel(); return; }
        let stream: MediaStream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch {
            setError('Púca Notes can’t use the microphone. Allow it for this app, then try again.');
            setPhase('refused');
            return;
        }
        streamRef.current = stream;
        let rec: MediaRecorder;
        try {
            rec = new MediaRecorder(stream, { mimeType: mime });
        } catch {
            release();
            setError('This device can’t record in a format Púca Notes can store.');
            setPhase('refused');
            return;
        }
        recorderRef.current = rec;
        const chunks: Blob[] = [];
        rec.ondataavailable = e => { if (e.data && e.data.size > 0) chunks.push(e.data); };
        rec.onstop = () => {
            const durationMs = Date.now() - startedAt.current;
            release();
            const blob = new Blob(chunks, { type: mime });
            if (blob.size === 0) { setError('Nothing was recorded.'); setPhase('refused'); return; }
            const file = new File([blob], `voice.${extForMime(mime)}`, { type: mime });
            try {
                assertClipUploadable(file.size);
            } catch (err) {
                setError(err instanceof Error ? err.message : 'That recording is too large.');
                setPhase('refused');
                return;
            }
            setTake({ file, durationMs, url: URL.createObjectURL(blob) });
            setPhase('review');
        };
        startedAt.current = Date.now();
        // A live level meter, on the SAME stream — never a second capture
        // client, which Android's concurrent-capture policy can refuse.
        try {
            const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
            if (Ctor) {
                const ctx = new Ctor();
                ctxRef.current = ctx;
                const analyser = ctx.createAnalyser();
                analyser.fftSize = 512;
                ctx.createMediaStreamSource(stream).connect(analyser);
                const buf = new Uint8Array(analyser.frequencyBinCount);
                const tick = () => {
                    if (ctxRef.current !== ctx) return;
                    analyser.getByteTimeDomainData(buf);
                    let peak = 0;
                    for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
                    setLevel(Math.min(1, peak / 96));
                    requestAnimationFrame(tick);
                };
                requestAnimationFrame(tick);
            }
        } catch {
            // No meter is a cosmetic loss; recording carries on.
        }
        rec.start();
        setPhase('recording');
    }, [onCancel, release]);

    // The one shot at asking, on mount.
    const asked = useRef(false);
    useEffect(() => {
        if (asked.current) return;
        asked.current = true;
        void begin();
    }, [begin]);

    // Elapsed time, and the cap that stops the recorder for you.
    useEffect(() => {
        if (phase !== 'recording') return;
        const id = window.setInterval(() => {
            const ms = Date.now() - startedAt.current;
            setElapsed(ms);
            if (ms >= MAX_CLIP_MS) stop();
        }, 200);
        return () => window.clearInterval(id);
    }, [phase, stop]);

    const discard = () => {
        release();
        if (take) URL.revokeObjectURL(take.url);
        setTake(null);
        onCancel();
    };

    const keep = async () => {
        if (!take || saving) return;
        setSaving(true);
        // Marked kept BEFORE the call: onSave routinely closes the sheet, and
        // this component's unmount cleanup would otherwise revoke the very URL
        // the caller just took ownership of. Unmarked again if it declines.
        keptRef.current = true;
        try {
            const ok = await onSave(take);
            if (!ok) keptRef.current = false;
        } catch {
            keptRef.current = false;
        } finally {
            setSaving(false);
        }
    };

    return createPortal(
        <div className="notes-editor-backdrop" role="presentation">
            <div className="notes-recorder" role="dialog" aria-label="Voice note" aria-modal="true">
                <div className="notes-recorder-head">
                    <span className="notes-recorder-title"><MicIcon /> Voice note</span>
                    <button type="button" className="notes-iconbtn small" aria-label="Close" title="Close" onClick={discard}>
                        <CloseIcon size={16} />
                    </button>
                </div>

                {phase === 'recording' && (
                    <>
                        <div className="notes-recorder-time" role="status" aria-live="off">{formatClipTime(elapsed)}</div>
                        <div className="notes-recorder-level" aria-hidden="true">
                            <span style={{ width: `${Math.round(level * 100)}%` }} />
                        </div>
                        <p className="notes-recorder-hint">
                            Recording on this device. It stops on its own after {formatClipTime(MAX_CLIP_MS)}, and when
                            Púca Notes leaves the screen.
                        </p>
                        <div className="notes-recorder-foot">
                            <button type="button" className="ni-action primary" aria-label="Stop recording" onClick={stop}>
                                <StopIcon /> Stop
                            </button>
                        </div>
                    </>
                )}

                {phase === 'review' && take && (
                    <>
                        <div className="notes-recorder-time">{formatClipTime(take.durationMs)}</div>
                        <audio className="notes-recorder-preview" src={take.url} controls preload="metadata" aria-label="Recording preview" />
                        <div className="notes-recorder-foot">
                            <button type="button" className="ni-action" aria-label="Discard recording" onClick={discard}>
                                <TrashIcon /> Discard
                            </button>
                            <button type="button" className="ni-action primary" disabled={saving} onClick={() => void keep()}>
                                {saving ? 'Saving…' : 'Keep'}
                            </button>
                        </div>
                    </>
                )}

                {phase === 'refused' && (
                    <>
                        <p className="notes-recorder-hint warn" role="alert">{error}</p>
                        <div className="notes-recorder-foot">
                            <button type="button" className="ni-action" onClick={discard}>Close</button>
                        </div>
                    </>
                )}

                {phase === 'asking' && <p className="notes-recorder-hint">Getting the microphone ready…</p>}
            </div>
        </div>,
        document.body,
    );
}
