/**
 * Audio sources while live: add an app to the stream audio (music alongside
 * the game), drop one, or change its volume — without restarting the share.
 * Opened from the Audio sources button that appears while sharing on the
 * desktop app. Going live takes the shared window's own app; this is where
 * the streamer adds anything else.
 */
import { useEffect, useState } from 'react';
import {
    addLiveAudioSource, appLabel, getLiveAudioSources, listCaptureApps, liveMixerRunning,
    removeLiveAudioSource, setAppCaptureGain, subscribeLiveAudioSources,
    type CaptureApp, type SelectedApp,
} from '../api/appAudio';
import { AppMixerList, type MixerRowState } from './AppMixerList';
import { CloseIcon, InfoIcon, SpeakerIcon } from './Icons';
import './ScreenShareModal.css';

interface Props {
    isOpen: boolean;
    onClose: () => void;
}

/** The running apps, with every live source in the list even when the scan
 *  missed it (one process per exe name) or it has since stopped appearing. */
function listWithLive(apps: CaptureApp[], live: SelectedApp[]): CaptureApp[] {
    const missing = live.filter(s => !apps.some(a => a.pid === s.pid));
    return [
        ...missing.map(s => ({ pid: s.pid, name: s.name, window_title: null, icon: null })),
        ...apps,
    ];
}

export function StreamAudioSourcesModal({ isOpen, onClose }: Props) {
    const [live, setLive] = useState<SelectedApp[]>(getLiveAudioSources);
    const [apps, setApps] = useState<CaptureApp[] | null>(null);
    /** Volumes for apps not (yet) in the stream, so ticking one uses them. */
    const [offGains, setOffGains] = useState<Map<number, number>>(new Map());
    const [pending, setPending] = useState<Set<number>>(new Set());
    const [error, setError] = useState<string | null>(null);

    useEffect(() => subscribeLiveAudioSources(() => setLive(getLiveAudioSources())), []);

    // A fresh scan on every open: apps start and quit between visits.
    useEffect(() => {
        if (!isOpen) return;
        let alive = true;
        // Opening is the moment the panel must show what is live NOW and
        // forget the previous visit's scan and error.
        setLive(getLiveAudioSources());
        setApps(null);
        setError(null);
        void listCaptureApps().then(list => {
            if (!alive) return;
            // Playing sound first, then windowed, then by name.
            setApps([...list].sort((a, b) =>
                Number(b.has_active_audio === true) - Number(a.has_active_audio === true)
                || Number(!!b.window_title?.trim()) - Number(!!a.window_title?.trim())
                || a.name.localeCompare(b.name)));
        });
        return () => { alive = false; };
    }, [isOpen]);

    if (!isOpen) return null;

    const running = liveMixerRunning();
    const shown = apps ? listWithLive(apps, live) : null;
    const rows = new Map<number, MixerRowState>();
    for (const a of shown ?? []) {
        const on = live.find(s => s.pid === a.pid);
        rows.set(a.pid, on
            ? { on: true, gainPercent: on.gainPercent ?? 100 }
            : { on: false, gainPercent: offGains.get(a.pid) ?? 100 });
    }

    const busy = (pid: number, v: boolean) => setPending(p => {
        const n = new Set(p);
        if (v) n.add(pid); else n.delete(pid);
        return n;
    });

    const toggle = async (a: CaptureApp, on: boolean) => {
        setError(null);
        busy(a.pid, true);
        try {
            if (on) {
                await addLiveAudioSource({ pid: a.pid, name: appLabel(a), gainPercent: offGains.get(a.pid) ?? 100 });
            } else {
                await removeLiveAudioSource(a.pid);
            }
        } catch (e) {
            setError(`${on ? "Couldn't add" : "Couldn't remove"} ${appLabel(a)}: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            busy(a.pid, false);
        }
    };

    const gain = (a: CaptureApp, gainPercent: number) => {
        if (live.some(s => s.pid === a.pid)) {
            void setAppCaptureGain(a.pid, gainPercent);
        } else {
            setOffGains(g => new Map(g).set(a.pid, gainPercent));
        }
    };

    return (
        <div className="stream-modal-overlay">
            <div className="stream-modal" role="dialog" aria-label="Stream audio sources">
                <div className="stream-modal-header">
                    <h3>Stream audio</h3>
                    <button className="stream-modal-close" onClick={onClose} aria-label="Close"><CloseIcon size={18} /></button>
                </div>
                <div className="stream-modal-content">
                    {!running ? (
                        <div className="stream-quality-hint">
                            <span className="info-icon"><InfoIcon /></span>
                            <span>
                                This stream went live without app audio, so there is nothing to add to.
                                Stop sharing and share again with audio to add apps.
                            </span>
                        </div>
                    ) : (
                        <>
                            <div className="stream-setting-group">
                                <label>Which apps' audio does the stream carry?</label>
                                {shown ? (
                                    <AppMixerList
                                        apps={shown}
                                        rows={rows}
                                        pending={pending}
                                        onToggle={(a, on) => { void toggle(a, on); }}
                                        onGain={gain}
                                    />
                                ) : (
                                    <p className="stream-audio-loading">Finding apps…</p>
                                )}
                            </div>
                            {error && <p className="stream-audio-error" role="alert">{error}</p>}
                            <div className="stream-quality-hint">
                                <span className="info-icon"><InfoIcon /></span>
                                <span>
                                    Changes apply straight away — the stream keeps running.{' '}
                                    <SpeakerIcon title="the speaker mark" /> marks apps playing sound right now.
                                </span>
                            </div>
                        </>
                    )}
                </div>
                <div className="stream-modal-footer">
                    <button className="stream-btn-primary" onClick={onClose}>Done</button>
                </div>
            </div>
        </div>
    );
}
