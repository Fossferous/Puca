import React, { useEffect, useEffectEvent, useRef, useState } from 'react';
import { isTauri } from '../api/platform';
import { goLiveMark } from '../api/goLiveTiming';
import { appLabel, defaultMixerSelection, loadSavedSelection, saveSelection, withOwner } from '../api/appAudio';
import type { CaptureApp, SelectedApp, WindowOwner } from '../api/appAudio';
import { CloseIcon, InfoIcon, SpeakerIcon } from './Icons';
import { loadSettings, rememberedShareAudio, saveSettings, type ShareAudioMode } from './settingsStore';
import { FPS_OPTIONS, RESOLUTION_OPTIONS, rememberedQuality } from '../api/rtc/shareHealth';
import { AppMixerList, type MixerRowState } from './AppMixerList';
import './ScreenShareModal.css';

// 'browser' is the WEB build's marker for "the picker's own Share-audio
// toggle was ticked". The old desktop 'system' mode ("all audio except
// Púca") is GONE: WASAPI's exclude-mode loopback only filters sessions
// created after the client initialises, and Púca's own voice call always
// predates it — so the mode echoed the call back into the stream and could
// not be fixed from our side. Renamed rather than reusing 'system' so a
// desktop system-audio path is unrepresentable, not merely unreachable.
type StreamAudioChoice = 'app' | 'browser' | 'none';

/** Result of capturing the screen surface (before choosing audio). */
interface CaptureResult {
    /** Desktop window share: the capturable app that owns the shared window
     *  (found from the window's handle — exact, not a guess), or null. */
    windowOwner: WindowOwner | null;
    /** Every running app whose audio we could capture (desktop only). A
     *  function, because only the app step needs it: a window share with a
     *  known owner goes live without the ~0.5 s scan. */
    loadApps: () => Promise<CaptureApp[]>;
    /** True when a full screen/monitor was shared (no window to go by). */
    isScreenShare: boolean;
    /** Web only: whether the browser share included an audio track. */
    hasBrowserAudio: boolean;
}

interface ScreenShareModalProps {
    isOpen: boolean;
    /** 'quick' — the Share button: straight to the picker with the
     *  remembered settings, no dialog unless the app step is needed.
     *  'settings' — the arrow beside Share: resolution, frame rate and audio
     *  first. */
    launch?: 'quick' | 'settings';
    onClose: () => void;
    /** Runs getDisplayMedia (the OS picker) + app detection. Returns null if the
     *  user cancelled the picker. `prefetchApps`: start the app scan while the
     *  picker is open, because the app step will certainly want it. */
    onCaptureScreen: (opts: { resolution: string; fps: number; prefetchApps: boolean }) => Promise<CaptureResult | null>;
    /** Finalize the share with the chosen audio mode; `apps` carries the mixer
     *  selection (which apps + volumes) when audio === 'app'. */
    onGoLive: (audio: StreamAudioChoice, apps?: SelectedApp[]) => Promise<void>;
    /** User backed out after the surface was captured — tear the capture down. */
    onCancelAfterCapture: () => void;
}

// The resolution / frame-rate choices come from shareHealth.ts (RESOLUTION_OPTIONS,
// FPS_OPTIONS), shared with the live Stream quality panel.

const AUDIO_OPTIONS: { value: ShareAudioMode; label: string }[] = [
    { value: 'auto', label: "The shared window's app — found automatically" },
    { value: 'pick', label: 'Choose apps after picking the window' },
    { value: 'none', label: 'No audio' },
];

/** A remembered volume for the owner, when the app step once saved one for
 *  an app of that name. */
function savedGainFor(owner: WindowOwner): number | undefined {
    const label = owner.window_title?.trim() ? owner.window_title : owner.name;
    return loadSavedSelection().find(s => s.name === owner.name || s.name === label)?.gainPercent;
}

const ScreenShareModal: React.FC<ScreenShareModalProps> = ({ isOpen, launch = 'settings', onClose, onCaptureScreen, onGoLive, onCancelAfterCapture }) => {
    const desktop = isTauri();
    // One object rather than two fields: they are always read and written
    // together, and it keeps the effect below to a single setState call.
    const [{ resolution: selectedRes, fps: selectedFps, audio }, setChoices] =
        useState(() => ({ ...rememberedQuality(loadSettings()), audio: rememberedShareAudio(loadSettings()) }));

    // RE-READ ON EVERY OPEN, not once at mount.
    //
    // The initialisers above run once, and this dialog is rendered
    // unconditionally by VoicePanel (it returns null when closed), so "once"
    // means once per voice channel joined. An earlier version relied on that
    // with the note "this dialog is the only thing that writes them" — which
    // was false in the same release that added it: the CPU-limited offer's
    // "Lower it" writes shareResolution/shareFps too (VoicePanel). So the
    // sequence the feature exists for — share, machine struggles, lower it,
    // share again — reopened the dialog on the OLD resolution and captured it,
    // which is precisely the thing the setting is meant to stop.
    useEffect(() => {
        if (!isOpen) return;
        const s = loadSettings();
        // ONE call, not two. `set-state-in-effect` reports at the setState call
        // site and `eslint-disable-next-line` covers exactly one line, so a
        // directive above the first of two setters silences nothing on the
        // second and is itself reported as an unused directive — which is what
        // the first version of this did.
        // The store is written by another component; the open edge is when
        // this dialog has to catch up with it. The directive below must be the
        // LAST line before the call — it applies to the next LINE, so leading
        // a multi-line comment block with it lands it on another comment and
        // silences nothing (which is what the version before this did).
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setChoices({ ...rememberedQuality(s), audio: rememberedShareAudio(s) });
    }, [isOpen]);

    /** Remember the choice as it is made rather than on go-live: somebody who
     *  turns the quality down because their last share hurt, then backs out of
     *  the OS picker, has still told us something. */
    const chooseRes = (value: string) => {
        setChoices(c => ({ ...c, resolution: value }));
        saveSettings({ ...loadSettings(), shareResolution: value });
    };
    const chooseFps = (value: number) => {
        setChoices(c => ({ ...c, fps: value }));
        saveSettings({ ...loadSettings(), shareFps: value });
    };
    const chooseAudio = (value: ShareAudioMode) => {
        setChoices(c => ({ ...c, audio: value }));
        saveSettings({ ...loadSettings(), shareAudio: value });
    };
    const [busy, setBusy] = useState(false);
    // App step: non-null after the surface is captured when the stream's
    // apps have to be chosen (mode 'pick', or 'auto' with no window to go by).
    const [mixerApps, setMixerApps] = useState<CaptureApp[] | null>(null);
    const [mixerSel, setMixerSel] = useState<Map<number, MixerRowState>>(new Map());
    // A quick launch opens the picker exactly once per open. A ref, not
    // state: StrictMode runs the effect twice, and two pickers would open.
    const quickStarted = useRef(false);

    const reset = () => { setBusy(false); setMixerApps(null); setMixerSel(new Map()); };

    const handleSelectScreen = async () => {
        setBusy(true);
        let captured = false;
        // Read the remembered values, not state, for a quick launch: it runs
        // from the open effect, before the re-read above has re-rendered.
        const s = loadSettings();
        const q = launch === 'quick' ? rememberedQuality(s) : { resolution: selectedRes, fps: selectedFps };
        const mode = launch === 'quick' ? rememberedShareAudio(s) : audio;
        try {
            const result = await onCaptureScreen({ ...q, prefetchApps: desktop && mode === 'pick' });
            if (!result) {
                // Picker cancelled. From the dialog, stay on it; a quick launch
                // had nothing on screen but the picker, so it is simply over.
                setBusy(false);
                if (launch === 'quick') onClose();
                return;
            }
            captured = true;

            if (desktop && mode !== 'none') {
                const owner = result.windowOwner;
                if (mode === 'auto' && owner) {
                    // The shared window's own app: exact, so no question to ask.
                    // Anything else can be added from Audio sources while live.
                    const label = owner.window_title?.trim() ? owner.window_title : owner.name;
                    await onGoLive('app', [{ pid: owner.pid, name: label, gainPercent: savedGainFor(owner) ?? 100 }]);
                    reset();
                    onClose();
                    return;
                }
                // App step: the list, the shared window's app pre-ticked (when
                // there is one) alongside the saved selection. Go-live happens
                // from its own button.
                const apps = withOwner(await result.loadApps(), owner);
                // Third arg (legacy single-app name) is gone: nothing has written
                // that key for several releases, so the read could only ever
                // return null on any current install.
                const defaults = defaultMixerSelection(apps, owner?.pid ?? null, null, loadSavedSelection());
                if (owner && !defaults.has(owner.pid)) defaults.set(owner.pid, savedGainFor(owner) ?? 100);
                const sel = new Map<number, MixerRowState>();
                for (const a of apps) {
                    const gain = defaults.get(a.pid);
                    sel.set(a.pid, { on: gain != null, gainPercent: gain ?? 100 });
                }
                // The shared window's app first, then audible, then windowed,
                // then name — the game floats up.
                apps.sort((a, b) =>
                    Number(b.pid === owner?.pid) - Number(a.pid === owner?.pid)
                    || Number(b.has_active_audio === true) - Number(a.has_active_audio === true)
                    || Number(!!b.window_title?.trim()) - Number(!!a.window_title?.trim())
                    || a.name.localeCompare(b.name));
                setMixerApps(apps);
                setMixerSel(sel);
                setBusy(false);
                return; // stay open on the app step
            }

            let effAudio: StreamAudioChoice = desktop ? 'none' : 'browser';
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
            if (launch === 'quick') { reset(); onClose(); }
        }
    };

    // The Share button's quick launch: open the picker at once. Runs from
    // the click's own commit, well inside the picker's user-activation window.
    // An effect EVENT, because the open edge is the only trigger: the
    // handler is recreated every render and must not re-run the effect.
    const startQuickLaunch = useEffectEvent(() => { void handleSelectScreen(); });
    useEffect(() => {
        if (!isOpen) { quickStarted.current = false; return; }
        if (launch !== 'quick' || quickStarted.current) return;
        quickStarted.current = true;
        startQuickLaunch();
    }, [isOpen, launch]);

    if (!isOpen) return null;

    /** Go live from the app step with exactly the ticked apps. */
    const handleMixerGoLive = async () => {
        if (!mixerApps) return;
        // The app step was the person choosing: close it as its own step so
        // the go-live line does not charge it to the audio start.
        goLiveMark('app-step');
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
        // Cancelling from the app step abandons an already-captured surface.
        if (mixerApps) onCancelAfterCapture();
        reset();
        onClose();
    };

    // A quick launch shows nothing but the picker — and then, only if the
    // stream's apps must be chosen, the app step. While it works, a small
    // status line instead of a dialog nobody needs to read.
    if (launch === 'quick' && !mixerApps) {
        return busy
            ? <div className="stream-quick-status" role="status">Starting your stream — it goes live in a few seconds…</div>
            : null;
    }

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
                                <AppMixerList
                                    apps={mixerApps}
                                    rows={mixerSel}
                                    onToggle={(a, on) => {
                                        const next = new Map(mixerSel);
                                        next.set(a.pid, { ...(mixerSel.get(a.pid) ?? { on: false, gainPercent: 100 }), on });
                                        setMixerSel(next);
                                    }}
                                    onGain={(a, gainPercent) => {
                                        const next = new Map(mixerSel);
                                        next.set(a.pid, { ...(mixerSel.get(a.pid) ?? { on: false, gainPercent: 100 }), gainPercent });
                                        setMixerSel(next);
                                    }}
                                />
                            </div>
                            <div className="stream-quality-hint">
                                <span className="info-icon"><InfoIcon /></span>
                                <span>
                                    {/* This icon is the SUBJECT of the sentence, not decoration —
                                        it needs a name or the instruction loses its noun. */}
                                    Only ticked apps are heard — <SpeakerIcon title="the speaker mark" /> marks apps currently playing sound.
                                    Nothing ticked streams video only. You can add or remove apps while live.
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
                            {RESOLUTION_OPTIONS.map((res) => (
                                <button
                                    key={res.value}
                                    className={`stream-option ${selectedRes === res.value ? 'selected' : ''}`}
                                    onClick={() => chooseRes(res.value)}
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
                                    onClick={() => chooseFps(fps)}
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
                                onChange={(e) => chooseAudio(e.target.value as ShareAudioMode)}
                            >
                                {AUDIO_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                            </select>
                        </div>
                    )}

                    <div className="stream-quality-hint">
                        <span className="info-icon"><InfoIcon /></span>
                        <span>
                            {desktop
                                ? (audio === 'auto'
                                    ? "Next you'll pick the window or screen — then you're live with that window's audio. Share a whole screen and you'll tick which apps are heard. Add more apps any time from Audio sources."
                                    : audio === 'pick'
                                        ? "Next you'll pick the window or screen, then tick exactly which apps' audio the stream carries."
                                        : "Next you'll pick the window or screen — then you're live, video only.")
                                : "Next you'll pick the window, screen, or tab — then you're live. To include sound, tick “Share audio” in that picker."}
                            {' '}These settings are remembered: the Share button goes straight to the picker next time.
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
