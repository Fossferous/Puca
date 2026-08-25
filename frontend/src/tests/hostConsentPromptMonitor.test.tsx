/**
 * THE CONSENT PROMPT'S SCREEN DEFAULT. An attended multi-monitor machine now
 * offers "All displays" and selects it by default — the same default an armed
 * host applies for itself — while the person at the machine can still narrow
 * it to one screen, and that narrowing is what the host then captures. With
 * one screen there is no selector and the answer is that screen, as before.
 *
 * The prompt is mounted for real against the hostConsent bridge, so what is
 * asserted is the VALUE the session layer receives, not the option markup.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../api/devices/session', () => ({ ALL_DISPLAYS: 255 }));

const { HostConsentPrompt } = await import('../components/HostConsentPrompt');
const { requestHostConsent } = await import('../api/devices/hostConsent');

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function mount() {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(<HostConsentPrompt />); });
}
afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    host?.remove();
    root = null;
    host = null;
});

const THREE = [
    { id: 0, label: 'Main display' },
    { id: 1, label: 'Display 2' },
    { id: 2, label: 'Display 3' },
];

function allowButton(): HTMLButtonElement {
    const b = [...host!.querySelectorAll('button')].find(x => x.textContent?.trim() === 'Allow');
    expect(b, 'the Allow button').toBeTruthy();
    return b!;
}

describe('the consent prompt\'s screen default', () => {
    it('offers "All displays", selected by default, on a multi-monitor machine — and Allow answers 255', async () => {
        await mount();
        let answer: Promise<{ monitor: number } | null>;
        await act(async () => { answer = requestHostConsent('dev-peer', THREE); });
        const select = host!.querySelector<HTMLSelectElement>('select');
        expect(select, 'a multi-monitor machine gets a selector').toBeTruthy();
        expect(select!.value).toBe('255');
        expect([...select!.options].map(o => o.textContent)).toEqual(['All displays', 'Main display', 'Display 2', 'Display 3']);
        await act(async () => { allowButton().click(); });
        expect(await answer!).toEqual({ monitor: 255 });
    });

    it('a screen the person picks is what is answered', async () => {
        await mount();
        let answer: Promise<{ monitor: number } | null>;
        await act(async () => { answer = requestHostConsent('dev-peer', THREE); });
        const select = host!.querySelector<HTMLSelectElement>('select')!;
        await act(async () => {
            select.value = '1';
            select.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await act(async () => { allowButton().click(); });
        expect(await answer!).toEqual({ monitor: 1 });
    });

    it('one screen: no selector, and Allow answers that screen', async () => {
        await mount();
        let answer: Promise<{ monitor: number } | null>;
        await act(async () => { answer = requestHostConsent('dev-peer', [{ id: 0, label: 'Main display' }]); });
        expect(host!.querySelector('select')).toBeNull();
        await act(async () => { allowButton().click(); });
        expect(await answer!).toEqual({ monitor: 0 });
    });
});
