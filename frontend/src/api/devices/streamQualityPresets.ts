/**
 * The quality presets both device-control surfaces offer.
 *
 * ONE list, because there were two — the desktop `<select>` and the mobile
 * radio menu each carried their own copy, both in the wrong unit, and a fix to
 * either would have left the other broken. `docs`-worthy detail: the values are
 * KILObits per second, matching the `update-stream` wire field and
 * `sendStreamQuality`. The single conversion to bits happens at the agent IPC
 * boundary in hostAgent.ts (`kbpsToBps`). Putting bits here means it gets
 * multiplied by 1000 twice and the agent refuses every one of them.
 *
 * Every value must exist in the agent's allowlists — `ALLOWED_FPS` and
 * `ALLOWED_BITRATE_BPS` in crates/puca-agent/src/protocol.rs. A preset the
 * agent does not accept is a menu entry that always fails, which is how "Ultra"
 * shipped: offered by the UI, absent from the allowlist.
 */

export interface StreamQualityPreset {
    label: string;
    /** Kilobits per second. */
    bitrateKbps: number;
    fps: number;
}

/** Mirrors ALLOWED_BITRATE_BPS in the agent, expressed in kbps. 15M landed
 *  in the agent one release BEFORE this preset (receiver-first), so a
 *  same-version pair always works; this preset against a v0.8.116- host gets
 *  the existing snap-back + stream-quality-error, which is honest. */
export const ALLOWED_BITRATE_KBPS = [1000, 3000, 6000, 10000, 15000] as const;

/** Mirrors ALLOWED_FPS in the agent. */
export const ALLOWED_FPS = [15, 30, 60] as const;

export const STREAM_QUALITY_PRESETS: StreamQualityPreset[] = [
    { label: 'Low (1Mbps, 15fps)', bitrateKbps: 1000, fps: 15 },
    { label: 'Medium (3Mbps, 30fps)', bitrateKbps: 3000, fps: 30 },
    { label: 'High (6Mbps, 30fps)', bitrateKbps: 6000, fps: 30 },
    { label: 'Ultra (10Mbps, 60fps)', bitrateKbps: 10000, fps: 60 },
    // The tier that exists for TEXT on the all-displays composite: 6-10M
    // across a near-4K surface of text is why the default reads soft.
    { label: 'Max (15Mbps, 60fps)', bitrateKbps: 15000, fps: 60 },
];

/** Shorter wording for the mobile menu, same values. */
export const MOBILE_PRESET_LABELS: Record<number, string> = {
    15000: 'Best image quality',
    10000: 'Good image quality',
    6000: 'Balanced',
    3000: 'Optimize reaction time',
    1000: 'Low bandwidth',
};

/** `"<kbps>,<fps>"` — the value a `<select>`/radio carries. */
export function presetValue(p: StreamQualityPreset): string {
    return `${p.bitrateKbps},${p.fps}`;
}

export function parsePresetValue(value: string): { bitrateKbps: number; fps: number } | null {
    const [kbps, fps] = value.split(',').map(Number);
    if (!Number.isFinite(kbps) || !Number.isFinite(fps)) return null;
    return { bitrateKbps: kbps, fps };
}
