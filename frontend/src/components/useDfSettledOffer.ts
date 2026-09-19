/**
 * The voice panel's "DeepFilter settled on RNNoise" offer.
 *
 * deepFilter.ts fires 'sovereign:df-settled' when a call's DeepFilter has
 * fallen behind for long enough, or often enough, that the RNNoise bridge now
 * carries the call (dfOverloadPolicy.ts). The mic is already
 * filtered; nothing needs rebuilding. What the member needs is to KNOW, and a
 * way back ("Try DeepFilter again" re-applies the mode, which builds a fresh
 * graph).
 *
 * Any noise-mode change answers the offer: a pick builds a new graph, and an
 * automatic downgrade has moved past it. So does any NEW DeepFilter graph for
 * the call (a mic restart rebuilds one), which is DeepFilter back. The panel
 * also clears it on leave and when a graph dies.
 */
import { useEffect, useState } from 'react';
import { NOISE_MODE_EVENT, getNoiseSuppressionMode } from '../api/noiseFilter';

export const DF_SETTLED_EVENT = 'sovereign:df-settled';
export const DF_GRAPH_LIVE_EVENT = 'sovereign:df-graph-live';

export function dfSettledText(reason: string | undefined): string {
    return reason === 'repeated'
        ? 'DeepFilter kept falling behind, so RNNoise is filtering your mic instead.'
        : 'DeepFilter couldn’t keep up, so RNNoise is filtering your mic instead.';
}

export function useDfSettledOffer(): [string | null, (text: string | null) => void] {
    const [offer, setOffer] = useState<string | null>(null);
    useEffect(() => {
        const onSettled = (e: Event) => {
            // A graph that settles after the member switched away is stale.
            if (getNoiseSuppressionMode() !== 'deepfilter') return;
            setOffer(dfSettledText((e as CustomEvent<{ reason?: string } | null>).detail?.reason));
        };
        const clear = () => setOffer(null);
        window.addEventListener(DF_SETTLED_EVENT, onSettled);
        window.addEventListener(NOISE_MODE_EVENT, clear);
        window.addEventListener(DF_GRAPH_LIVE_EVENT, clear);
        return () => {
            window.removeEventListener(DF_SETTLED_EVENT, onSettled);
            window.removeEventListener(NOISE_MODE_EVENT, clear);
            window.removeEventListener(DF_GRAPH_LIVE_EVENT, clear);
        };
    }, []);
    return [offer, setOffer];
}
