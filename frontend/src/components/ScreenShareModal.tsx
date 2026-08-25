import React, { useState } from 'react';
import { isTauri } from '../api/platform';
import { appLabel, defaultMixerSelection, loadSavedSelection, saveSelection } from '../api/appAudio';
import type { CaptureApp, SelectedApp } from '../api/appAudio';
import { CloseIcon, InfoIcon, SpeakerIcon } from './Icons';
import './ScreenShareModal.css';

// 'browser' is the WEB build's marker for "the picker's own Share-audio
// toggle was ticked". The old desktop 'system' mode ("all audio except
// Puca") is GONE: WASAPI's exclude-mode loopback only filters sessions
// created after the client initialises, and Puca's own voice call always
// predates it — so the mode echoed the call back into the stream and could
// not be fixed from our side. Renamed rather than reusing 'system' so a
// desktop system-audio path is unrepresentable, not merely unreachable.
type StreamAudioChoice = 'app' | 'browser' | 'none';

/** Result of capturing the screen surface (before choosing audio). */
interface CaptureResult {
    /** Name of the app auto-matched to the shared window, or null (no match). */
    appName: string | null;
    /** PID of the auto-matched app, or null. */
    appPid: number | null;
    /** Every running app whose audio we could capture (desktop only). */
    apps: CaptureApp[];
    /** True when a full screen/monitor was shared (no window to match). */
    isScreenShare: boolean;
    /** Web only: whether the browser share included an audio track. */
    hasBrowserAudio: boolean;
}

interface ScreenShareModalProps {
    isOpen: boolean;
    onClose: () => void;
    /** Runs getDisplayMedia (the OS picker) + app detection. Returns null if the
     *  user cancelled the picker. */
    onCaptureScreen: (opts: { resolution: string; fps: number }) => Promise<CaptureResult | null>;
    /** Finalize the share with the chosen audio mode; `apps` carries the mixer
     *  selection (which apps + volumes) when audio === 'app'. */
    onGoLive: (audio: StreamAudioChoice, apps?: SelectedApp[]) => Promise<void>;
    /** User backed out after the surface was captured — tear the capture down. */
    onCancelAfterCapture: () => void;
}

const RESOLUTIONS = [
    { label: '720p', value: '720' },
    { label: '1080p', value: '1080' },
    { label: '1440p', value: '1440' },
    { label: 'Source', value: 'source' },
];

const FPS_OPTIONS = [15, 30, 60];

// App resolution itself lives in api/appAudio.ts (resolveAppAudio) so it's
// unit-testable: window-title match first, then audio-session activity (the
// app audibly playing sound right now — the signal that actually works under
// WebView2's generic surface labels), then the remembered last app.

/** Per-row mixer state: ticked + volume slider. */
interface MixerRowState { on: boolean; gainPercent: number }

const ScreenShareModal: React.FC<ScreenShareModalProps> = ({ isOpen, onClose, onCaptureScreen, onGoLive, onCancelAfterCapture }) => {
    const desktop = isTauri();
    const [selectedRes, setSelectedRes] = useState('1080');
    const [selectedFps, setSelectedFps] = useState(30);
    const [busy, setBusy] = useState(false);
    // Audio is chosen HERE, up front. "Selected apps" adds one mixer step
    // after the OS picker (that's when the running-app list is known).
    const [audio, setAudio] = useState<StreamAudioChoice>(desktop ? 'app' : 'browser');
    // Mixer step: non-null after the surface is captured with audio === 'app'.
    const [mixerApps, setMixerApps] = useState<CaptureApp[] | null>(null);
    const [mixerSel, setMixerSel] = useState<Map<number, MixerRowState>>(new Map());

    if (!isOpen) return null;

    const reset = () => { setBusy(false); setMixerApps(null); setMixerSel(new Map()); };

    const handleSelectScreen = async () => {
        setBusy(true);
        let captured = false;
        try {
            const result = await onCaptureScreen({ resolution: selectedRes, fps: selectedFps });
            if (!result) { setBusy(false); return; } // picker cancelled — stay open
            captured = true;

            if (desktop && audio === 'app') {
                // Mixer step: show the app list, pre-ticked by the saved
                // selection or the auto-detect suggestion. Go-live happens
                // from the mixer's own button.
                const apps = result.apps ?? [];
                // Third arg (legacy single-app name) is gone: nothing has written
                // that key for several releases, so the read could only ever
                // return null on any current install.
                const defaults = defaultMixerSelection(apps, result.appPid, null, loadSavedSelection());
                const sel = new Map<number, MixerRowState>();
                for (const a of apps) {
                    const gain = defaults.get(a.pid);
                    sel.set(a.pid, { on: gain != null, gainPercent: gain ?? 100 });
                }
                // Audible-first, then windowed, then name — the game floats up.
                apps.sort((a, b) =>
                    Number(b.has_active_audio === true) - Number(a.has_active_audio === true)
                    || Number(!!b.window_title?.trim()) - Number(!!a.window_title?.trim())
                    || a.name.localeCompare(b.name));
                setMixerApps(apps);
                setMixerSel(sel);
                setBusy(false);
                return; // stay open on the mixer step
            }

            let effAudio: StreamAudioChoice = audio;
            if (!desktop) {
                // Web: audio comes from the browser picker's own "share audio" toggle.
                effAudio = result.hasBrowserAudio ? 'browser' : 'none';
            }

            await onGoLive(effAudio);
            reset();
            onClose();
        } catch (e) {
            console.error('[ScreenShare] capture/go-live failed:', e);
            if (captured) onCancelAfterCapture(); // tear the surface down on a failed go-live
            setBusy(false);
        }
    };

    /** Go live from the mixer step with exactly the ticked apps. */
    const handleMixerGoLive = async () => {
        if (!mixerApps) return;
        setBusy(true);
        try {
            const chosen: SelectedApp[] = mixerApps
                .filter(a => mixerSel.get(a.pid)?.on)
                .map(a => ({ pid: a.pid, name: appLabel(a), gainPercent: mixerSel.get(a.pid)?.gainPercent ?? 100 }));
            saveSelection(chosen.map(c => ({ name: c.name, gainPercent: c.gainPercent ?? 100 })));
            // Nothing ticked = deliberate video-only stream.
            await onGoLive(chosen.length > 0 ? 'app' : 'none', chosen.length > 0 ? chosen : undefined);
            reset();
            onClose();
        } catch (e) {
            console.error('[ScreenShare] mixer go-live failed:', e);
            onCancelAfterCapture();
            reset();
        }
    };

    const handleCancel = () => {
        // Cancelling from the mixer step abandons an already-captured surface.
        if (mixerApps) onCancelAfterCapture();
        reset();
        onClose();
    };

    return (
        <div className="stream-modal-overlay">
            <div className="stream-modal">
                <div className="stream-modal-header">
                    <h3>Screen Share</h3>
                    <button className="stream-modal-close" onClick={handleCancel} aria-label="Close"><CloseIcon size={18} /></button>
                </div>

                {mixerApps ? (
                    <>
                        <div className="stream-modal-content">
                            <div className="stream-setting-group">
                                <label>Which apps' audio should the stream carry?</label>
                                <div className="app-mixer-list">
                                    {mixerApps.map((a) => {
                                        const row = mixerSel.get(a.pid) ?? { on: false, gainPercent: 100 };
                                        return (
                                            <div key={a.pid} className={`app-mixer-row ${row.on ? 'on' : ''}`}>
                                                <label className="app-mixer-name">
                                                    <input
                                                        type="checkbox"
                                                        checked={row.on}
                                                        onChange={(e) => {
                                                            const next = new Map(mixerSel);
                                                            next.set(a.pid, { ...row, on: e.target.checked });
                                                            setMixerSel(next);
                                                        }}
                                                    />
                                                    {a.icon ? (
                                                        <img
                                                            src={a.icon}
                                                            className="app-mixer-icon"
                                                            alt=""
                                                            onError={(e) => {
                                                                // Handle corrupted base64 or missing transparency by hiding the broken image
                                                                e.currentTarget.style.display = 'none';
                                                            }}
                                                        />
                                                    ) : (
                                                        <div className="app-mixer-icon-placeholder" />
                                                    )}
                                                    <span className="app-mixer-title">
                                                        {a.has_active_audio ? <><SpeakerIcon />{' '}</> : ''}{appLabel(a)}
                                                    </span>
                                                </label>
                                                <input
                                                    type="range"
                                                    className="app-mixer-slider"
                                                    min={0}
                                                    max={200}
                                                    step={5}
                                                    value={row.gainPercent}
                                                    disabled={!row.on}
                                                    onChange={(e) => {
                                                        const next = new Map(mixerSel);
                                                        next.set(a.pid, { ...row, gainPercent: Number(e.target.value) });
                                                        setMixerSel(next);
                                                    }}
                                                />
                                                <span className="app-mixer-volume">{row.gainPercent}%</span>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                            <div className="stream-quality-hint">
                                <span className="info-icon"><InfoIcon /></span>
                                <span>
                                    {/* This icon is the SUBJECT of the sentence, not decoration —
                                        it needs a name or the instruction loses its noun. */}
                                    Only ticked apps are heard — <SpeakerIcon title="the speaker mark" /> marks apps currently playing sound.
                                    Nothing ticked streams video only.
                                </span>
                            </div>
                        </div>
                        <div className="stream-modal-footer">
                            <button className="stream-btn-secondary" onClick={handleCancel} disabled={busy}>
                                Cancel
                            </button>
                            <button className="stream-btn-primary" onClick={handleMixerGoLive} disabled={busy}>
                                {busy ? 'Starting…' : 'Go Live →'}
                            </button>
                        </div>
                    </>
                ) : (
                <>
                <div className="stream-modal-content">
                    <div className="stream-setting-group">
                        <label>Resolution</label>
                        <div className="stream-options-grid">
                            {RESOLUTIONS.map((res) => (
                                <button
                                    key={res.value}
                                    className={`stream-option ${selectedRes === res.value ? 'selected' : ''}`}
                                    onClick={() => setSelectedRes(res.value)}
                                >
                                    {res.label}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className="stream-setting-group">
                        <label>Frame Rate</label>
                        <div className="stream-options-grid">
                            {FPS_OPTIONS.map((fps) => (
                                <button
                                    key={fps}
                                    className={`stream-option ${selectedFps === fps ? 'selected' : ''}`}
                                    onClick={() => setSelectedFps(fps)}
                                >
                                    {fps} fps
                                </button>
                            ))}
                        </div>
                    </div>

                    {desktop && (
                        <div className="stream-setting-group">
                            <label>Audio to share</label>
                            <select
                                className="app-select"
                                value={audio}
                                onChange={(e) => setAudio(e.target.value as StreamAudioChoice)}
                            >
                                <option value="app">Selected apps — pick exactly which apps are heard</option>
                                <option value="none">No audio</option>
                            </select>
                        </div>
                    )}

                    <div className="stream-quality-hint">
                        <span className="info-icon"><InfoIcon /></span>
                        <span>
                            {desktop
                                ? (audio === 'app'
                                    ? "Next you'll pick the window or screen, then tick exactly which apps' audio the stream carries."
                                    : "Next you'll pick the window or screen — then you're live.")
                                : "Next you'll pick the window, screen, or tab — then you're live. To include sound, tick “Share audio” in that picker."}
                        </span>
                    </div>
                </div>

                <div className="stream-modal-footer">
                    <button className="stream-btn-secondary" onClick={handleCancel} disabled={busy}>
                        Cancel
                    </button>
                    <button className="stream-btn-primary" onClick={handleSelectScreen} disabled={busy}>
                        {busy ? 'Opening picker…' : 'Select Screen & Go Live →'}
                    </button>
                </div>
                </>
                )}
            </div>
        </div>
    );
};

export default ScreenShareModal;
