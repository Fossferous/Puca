/**
 * The desktop stage's live stats, refreshed once a second while on — the
 * polling half of liveStats.ts, apart so the maths can be tested without a
 * session module (and its socket) behind it.
 */
import { useEffect, useState } from 'react';
import { deviceStatsSample, type DeviceStatsSample } from './session';
import { liveStatsFrom, type LiveStats } from './liveStats';

/** The stage's live stats, refreshed once a second while `on`. */
export function useDeviceLiveStats(sessionId: string | null, on: boolean): LiveStats | null {
    // Keyed by session, so a reading of the last session is never shown as
    // this one's while the first window of the new one fills.
    const [state, setState] = useState<{ id: string; stats: LiveStats } | null>(null);
    useEffect(() => {
        if (!sessionId || !on) return;
        let alive = true;
        let prev: DeviceStatsSample | null = null;
        const tick = async () => {
            const next = await deviceStatsSample(sessionId).catch(() => null);
            if (!alive) return;
            if (next && prev) setState({ id: sessionId, stats: liveStatsFrom(prev, next) });
            if (next) prev = next;
        };
        void tick();
        const timer = window.setInterval(() => { void tick(); }, 1000);
        return () => {
            alive = false;
            window.clearInterval(timer);
        };
    }, [sessionId, on]);
    return on && state && state.id === sessionId ? state.stats : null;
}
