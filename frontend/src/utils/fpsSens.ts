/**
 * Game-mode (relative mouse / pointer lock) preferences, shared by BOTH remote
 * viewers — the in-call StreamStage and the My Devices DeviceStage. One module
 * so the two cannot drift: the sensitivity is a property of the person's mouse
 * and hand, not of which path the pixels arrived over.
 */

const FPS_SENS_KEY = 'sovereign-fps-sens';
export const FPS_SENS_MIN = 0.25;
export const FPS_SENS_MAX = 4;
export const FPS_SENS_STEP = 0.25;

export function loadFpsSens(): number {
    try {
        const raw = localStorage.getItem(FPS_SENS_KEY);
        if (raw) {
            const v = Number(raw);
            if (Number.isFinite(v)) {
                const snapped = Math.round(v / FPS_SENS_STEP) * FPS_SENS_STEP;
                return Math.min(FPS_SENS_MAX, Math.max(FPS_SENS_MIN, snapped));
            }
        }
    } catch { /* no persistence this run */ }
    return 1;
}

export function saveFpsSens(v: number): void {
    try { localStorage.setItem(FPS_SENS_KEY, String(v)); } catch { /* best effort */ }
}

/** "1.0x" / "0.25x" — one decimal when it's enough, two for quarter steps. */
export const fmtSens = (s: number) => `${s % 0.5 === 0 ? s.toFixed(1) : s.toFixed(2)}x`;

/**
 * The Game-mode toggle itself, persisted so someone who plays through this
 * regularly doesn't rediscover the button every session. Deliberately one key
 * for both viewers.
 */
const FPS_MODE_KEY = 'sovereign-fps-mode';

export function loadFpsMode(): boolean {
    try { return localStorage.getItem(FPS_MODE_KEY) === 'on'; } catch { return false; }
}

export function saveFpsMode(on: boolean): void {
    try { localStorage.setItem(FPS_MODE_KEY, on ? 'on' : 'off'); } catch { /* best effort */ }
}
