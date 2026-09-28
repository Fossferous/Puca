/**
 * The list of apps whose audio a stream can carry: tick an app, set its
 * volume. ONE component for both places it appears, so they cannot drift:
 * the Share flow's app step (ScreenShareModal, before going live) and the
 * Audio sources panel while live (StreamAudioSourcesModal).
 */
import { appLabel, type CaptureApp } from '../api/appAudio';
import { SpeakerIcon } from './Icons';

/** Per-row state: ticked + volume slider (100 = unity, 0–200). */
export interface MixerRowState { on: boolean; gainPercent: number }

interface AppMixerListProps {
    apps: CaptureApp[];
    rows: Map<number, MixerRowState>;
    onToggle: (app: CaptureApp, on: boolean) => void;
    onGain: (app: CaptureApp, gainPercent: number) => void;
    /** Rows whose tick is being applied (live add/remove in flight). */
    pending?: Set<number>;
}

export function AppMixerList({ apps, rows, onToggle, onGain, pending }: AppMixerListProps) {
    return (
        <div className="app-mixer-list">
            {apps.map((a) => {
                const row = rows.get(a.pid) ?? { on: false, gainPercent: 100 };
                const busy = pending?.has(a.pid) ?? false;
                return (
                    <div key={a.pid} className={`app-mixer-row ${row.on ? 'on' : ''}`}>
                        <label className="app-mixer-name">
                            <input
                                type="checkbox"
                                checked={row.on}
                                disabled={busy}
                                onChange={(e) => onToggle(a, e.target.checked)}
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
                            disabled={!row.on || busy}
                            aria-label={`${appLabel(a)} volume`}
                            onChange={(e) => onGain(a, Number(e.target.value))}
                        />
                        <span className="app-mixer-volume">{row.gainPercent}%</span>
                    </div>
                );
            })}
        </div>
    );
}
