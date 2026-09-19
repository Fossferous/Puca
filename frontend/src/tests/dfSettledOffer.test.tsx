/**
 * The voice panel's settled-DeepFilter offer (useDfSettledOffer): shown when
 * the call's DeepFilter settles on its RNNoise bridge, with the sentence for
 * the reason, and answered by any noise-mode change. The Try-again button
 * re-applies the mode; that path is the ordinary mode apply, not new code.
 */
import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { DF_GRAPH_LIVE_EVENT, DF_SETTLED_EVENT, dfSettledText, useDfSettledOffer } from '../components/useDfSettledOffer';
import { NOISE_MODE_EVENT, setNoiseSuppressionMode } from '../api/noiseFilter';

let root: Root | null = null;
let div: HTMLDivElement | null = null;

function Probe() {
    const [offer] = useDfSettledOffer();
    return <span data-testid="offer">{offer ?? ''}</span>;
}

function mount() {
    div = document.createElement('div');
    document.body.appendChild(div);
    root = createRoot(div);
    act(() => { root!.render(<Probe />); });
    return () => div!.querySelector('[data-testid="offer"]')!.textContent;
}

const settle = (reason: string) => act(() => {
    window.dispatchEvent(new CustomEvent(DF_SETTLED_EVENT, { detail: { reason } }));
});

afterEach(() => {
    act(() => root?.unmount());
    div?.remove();
    root = null;
    div = null;
});

describe('the settled-DeepFilter offer', () => {
    it('appears with the sentence for the reason', () => {
        setNoiseSuppressionMode('deepfilter', false);
        const text = mount();
        expect(text()).toBe('');
        settle('sustained');
        expect(text()).toBe(dfSettledText('sustained'));
        settle('repeated');
        expect(text()).toBe(dfSettledText('repeated'));
        // POSITIVE CONTROL: the two sentences differ, so the checks above can fail.
        expect(dfSettledText('sustained')).not.toBe(dfSettledText('repeated'));
    });

    it('any noise-mode change answers it', () => {
        setNoiseSuppressionMode('deepfilter', false);
        const text = mount();
        settle('sustained');
        expect(text()).not.toBe('');
        act(() => {
            window.dispatchEvent(new CustomEvent(NOISE_MODE_EVENT, { detail: { mode: 'rnnoise', apply: true } }));
        });
        expect(text()).toBe('');
    });

    it('a fresh DeepFilter graph (a mic restart) answers it: DeepFilter is back', () => {
        setNoiseSuppressionMode('deepfilter', false);
        const text = mount();
        settle('repeated');
        expect(text()).not.toBe('');
        act(() => { window.dispatchEvent(new CustomEvent(DF_GRAPH_LIVE_EVENT)); });
        expect(text()).toBe('');
    });

    it('a graph that settles after the member left DeepFilter is ignored', () => {
        setNoiseSuppressionMode('rnnoise', false);
        const text = mount();
        settle('sustained');
        expect(text()).toBe('');
    });
});
