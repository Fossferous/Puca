import { useEffect, useState } from 'react';
import { gamesNow } from '../../api/games/gamesStore';

/**
 * Seconds left on a relative clock (`clock_ms` / `next_deal_in_ms`, counted
 * from when the view arrived — relative, so clock skew cannot shift it),
 * re-rendered four times a second while it runs.
 */
export function useCountdown(ms: number | null, receivedAt: number): number | null {
    const [, tick] = useState(0);
    useEffect(() => {
        if (ms === null) return;
        const id = setInterval(() => tick(n => n + 1), 250);
        return () => clearInterval(id);
    }, [ms, receivedAt]);
    if (ms === null) return null;
    return Math.max(0, ms - (gamesNow() - receivedAt));
}
