/**
 * Settings › Voice & Video › Clips. Rendered by SettingsModal inside the voice
 * section; the keybind control is passed in so this stays one list with the
 * other rebindable fields (BIND_FIELDS drives collisions and the Keybinds tab).
 *
 * Not gated out on phones/browsers — a setting that silently does not exist is
 * how users conclude a feature is broken; there it renders one honest line.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { isTauri } from '../api/platform';
import { CLIP_PRESETS, clipPreset, estimateRing, formatClock, formatMB, maxRingBytesForBudget, memoryBudgetBytes, MIB, presetMbPerMinute } from '../api/clips/clipPresets';
import { setClipMicGain } from '../api/clips/replayBuffer';
import { getClipUsage, type ClipUsage } from '../api/clips/clipUpload';
import { useServers } from '../hooks/queries';
import { API_BASE_URL } from '../api/config';
import { getToken } from '../api/auth';
import type { Settings } from './settingsStore';

/** The buffer lengths on offer. 30 s exists for tiny-RAM machines; the long
 *  tail (10/15 min) is what "that thing five minutes ago" actually needs, and
 *  each option prices itself in MB so the cost is visible where the choice is
 *  made, not discovered at the memory-limit readout below. */
const BUFFER_LENGTH_OPTIONS = [30, 60, 120, 180, 300, 600, 900];

const lengthLabel = (s: number) =>
    s < 60 ? `${s} seconds` : `${s / 60} minute${s > 60 ? 's' : ''}`;

interface Props {
    settings: Settings;
    updateSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
    /** SettingsModal's bindControl('saveClipBinding'). */
    bindControl: ReactNode;
}

export function ClipSettings({ settings, updateSetting, bindControl }: Props) {
    // Per-server caps + the storage quota. Both hooks run unconditionally
    // (above the isTauri return — the v0.7.7 hook-below-early-return class).
    const { data: servers = [] } = useServers();
    const [usage, setUsage] = useState<ClipUsage | null>(null);
    useEffect(() => {
        const token = getToken();
        if (!token) return;
        let alive = true;
        // null on any failure INCLUDING the 404 of a server without the
        // route yet — the readout renders nothing, so this is
        // order-independent of the server release that adds it.
        void getClipUsage({ baseUrl: API_BASE_URL, token }).then(u => { if (alive) setUsage(u); });
        return () => { alive = false; };
    }, []);
    const serverCaps = servers
        .filter(s => s.clips_enabled === true && typeof s.clip_max_seconds === 'number')
        .map(s => ({ id: s.id, name: s.name, maxSeconds: s.clip_max_seconds as number }));
    if (!isTauri()) {
        return (
            <div className="settings-card">
                <p className="settings-description">
                    Clips are recorded on the desktop app. On this device you can watch clips and answer approval requests.
                </p>
            </div>
        );
    }
    const preset = clipPreset(settings.clipQuality);
    const budget = memoryBudgetBytes((navigator as Navigator & { deviceMemory?: number }).deviceMemory);
    // The slider can never offer a value the ring clamp would reject.
    const sliderMaxMB = Math.max(256, Math.floor(maxRingBytesForBudget(budget) / MIB / 256) * 256);
    const capMB = Math.min(settings.clipMemoryCapMB ?? 1024, sliderMaxMB);
    const est = estimateRing(preset, settings.clipBufferSeconds ?? 300, capMB * MIB);
    return (
        <div className="settings-card">
            <div className="settings-option">
                <label>Quality</label>
                <select value={preset.id} onChange={(e) => updateSetting('clipQuality', e.target.value)}>
                    {CLIP_PRESETS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                </select>
            </div>
            <div className="settings-option">
                <div className="option-info">
                    <label>Buffer length</label>
                    <span className="option-hint">
                        How much is kept, rolling. Each server caps how long a posted clip may be
                        {serverCaps.length > 0 && <>: {
                            // Bounded — a hint, not a directory. Someone in
                            // fifteen servers gets the first few and a count.
                            serverCaps.slice(0, 4).map(c => `${c.name} ${formatClock(c.maxSeconds)}`).join(' · ')
                        }{serverCaps.length > 4 && ` · +${serverCaps.length - 4} more`}</>}.
                    </span>
                </div>
                <select value={settings.clipBufferSeconds ?? 300} onChange={(e) => updateSetting('clipBufferSeconds', parseInt(e.target.value))}>
                    {BUFFER_LENGTH_OPTIONS.map(s => (
                        <option key={s} value={s}>
                            {lengthLabel(s)} (≈ {formatMB((s / 60) * presetMbPerMinute(preset) * MIB)})
                        </option>
                    ))}
                </select>
            </div>
            <div className="settings-option">
                <div className="option-info">
                    <label>Memory limit</label>
                    <span className="option-hint">
                        {est.boundBy === 'seconds'
                            ? <>At {preset.id} this holds about <strong>{formatClock(est.seconds)}</strong> (≈ {formatMB(est.bytes)}).</>
                            : <>Your {formatClock(settings.clipBufferSeconds ?? 300)} buffer would need {formatMB(est.wantBytes)} — at this limit it keeps about <strong>{formatClock(est.seconds)}</strong>.</>}
                        {' '}An auto-armed capture of a monitor larger than this preset uses a proportionally higher bitrate, so it keeps less than the estimate.
                    </span>
                </div>
                <div className="slider-row">
                    <input type="range" min={256} max={sliderMaxMB} step={256} value={capMB} onChange={(e) => updateSetting('clipMemoryCapMB', parseInt(e.target.value))} />
                    <span className="volume-value">{capMB} MB</span>
                </div>
            </div>
            <div className="settings-option">
                <div className="option-info">
                    <label>My mic level in clips</label>
                    <span className="option-hint">System audio stays at 100 %; your mic is recorded at send level, so this is the one to adjust.</span>
                </div>
                <div className="slider-row">
                    <input type="range" min={0} max={200} value={settings.clipMicGain ?? 100} onChange={(e) => { const v = parseInt(e.target.value); updateSetting('clipMicGain', v); setClipMicGain(v); }} />
                    <span className="volume-value">{settings.clipMicGain ?? 100}%</span>
                </div>
            </div>
            <div className="settings-option">
                <div className="option-info">
                    <label htmlFor="clip-arm-on-join">When I join a voice call</label>
                    <span className="option-hint">
                        {settings.clipArmOnJoin === 'auto'
                            ? 'Recording starts by itself when you join a call that allows clips — no popup. It captures the monitor your fullscreen game is on (otherwise your primary monitor), plus system audio and your mic. Everyone in the call sees the buffering marker, and nothing is ever posted without everyone\u2019s approval.'
                            : settings.clipArmOnJoin === 'prompt'
                                ? 'Highlights the Arm button for a few seconds after you join a call that allows clips.'
                                : 'Arm the clip buffer yourself from the call controls.'}
                    </span>
                </div>
                <select id="clip-arm-on-join" value={settings.clipArmOnJoin ?? 'off'} onChange={(e) => updateSetting('clipArmOnJoin', e.target.value as 'off' | 'prompt' | 'auto')}>
                    <option value="off">Do nothing</option>
                    <option value="prompt">Remind me to arm</option>
                    <option value="auto">Arm automatically (no popup)</option>
                </select>
            </div>
            <div className="settings-option">
                <div className="option-info">
                    <label>Save clip</label>
                    <span className="option-hint">Works while the buffer is armed, even when a game has focus.</span>
                </div>
                {bindControl}
            </div>
            {usage !== null && usage.quotaBytes > 0 && (
                <div className="settings-option">
                    <div className="option-info">
                        <label>Clip storage on your server</label>
                        <span className="option-hint">
                            {formatMB(usage.usedBytes)} of {formatMB(usage.quotaBytes)} used by posted clips.
                            Deleting a clip message frees its share.
                            {usage.retentionDays === null ? null
                                : usage.retentionDays === 0 ? ' Posted clips are kept until someone deletes them.'
                                : ` Posted clips are deleted after ${usage.retentionDays} day${usage.retentionDays === 1 ? '' : 's'}.`}
                        </span>
                    </div>
                    <div className="slider-row" aria-hidden="true">
                        <progress max={usage.quotaBytes} value={Math.min(usage.usedBytes, usage.quotaBytes)} />
                    </div>
                </div>
            )}
            <p className="settings-description">
                While the buffer is armed, everyone in the call sees a marker next to your name. The buffer lives in this app’s memory, encrypted, and is never written to disk. Closing Puca, disarming, leaving the call, or the system locking or sleeping erases it. Nothing is uploaded until every person in the clip approves.
            </p>
        </div>
    );
}
