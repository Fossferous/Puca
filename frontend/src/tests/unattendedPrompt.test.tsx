/**
 * The unattended passphrase dialog.
 *
 * It interrupts a connection attempt and the session layer is BLOCKED on its
 * answer, so the cases that matter are about answering exactly once, correctly,
 * and never leaving the caller waiting: cancel and Escape must resolve (with
 * null) rather than dismiss silently, and the passphrase must not survive the
 * dialog.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { requestUnattendedPassphrase, resetUnattendedPassphraseHandler } from '../api/devices/unattendedPrompt';
import { UnattendedPassphrasePrompt } from '../components/UnattendedPassphrasePrompt';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function mount() {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(<UnattendedPassphrasePrompt />); });
}

const q = <T extends Element>(sel: string) => host?.querySelector<T>(sel) ?? null;

function buttonWith(text: string): HTMLButtonElement | undefined {
    return [...(host?.querySelectorAll('button') ?? [])].find(
        b => (b.textContent ?? '').trim() === text,
    ) as HTMLButtonElement | undefined;
}

/** React installs its own value setter; a raw assignment fires no onChange. */
function typeInto(el: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
}

beforeEach(() => resetUnattendedPassphraseHandler());

afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
    resetUnattendedPassphraseHandler();
});

describe('unattended passphrase dialog', () => {
    it('renders nothing until a request arrives', async () => {
        await mount();
        expect(q('.ua-prompt-backdrop')).toBeNull();
    });

    it('appears on a request and resolves with the typed passphrase', async () => {
        await mount();
        let answer: string | null | undefined;
        await act(async () => {
            void requestUnattendedPassphrase('Zeus-PC').then(v => { answer = v; });
        });
        expect(q('.ua-prompt-backdrop')).toBeTruthy();

        await act(async () => { typeInto(q<HTMLInputElement>('input')!, 'let me in'); });
        await act(async () => { buttonWith('Connect')!.click(); });
        await act(async () => { await Promise.resolve(); });

        expect(answer).toBe('let me in');
    });

    it('cancel resolves NULL rather than leaving the session waiting', async () => {
        // The session layer is awaiting this promise. A dialog that just
        // disappeared would hang the connection attempt forever.
        await mount();
        let answer: string | null | undefined;
        let settled = false;
        await act(async () => {
            void requestUnattendedPassphrase('Zeus-PC').then(v => { answer = v; settled = true; });
        });
        await act(async () => { buttonWith('Cancel')!.click(); });
        await act(async () => { await Promise.resolve(); });

        expect(settled).toBe(true);
        expect(answer).toBeNull();
    });

    it('Escape refuses rather than dismissing silently', async () => {
        await mount();
        let answer: string | null | undefined;
        let settled = false;
        await act(async () => {
            void requestUnattendedPassphrase('Zeus-PC').then(v => { answer = v; settled = true; });
        });
        await act(async () => {
            q('.ua-prompt-backdrop')!.dispatchEvent(
                new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
            );
        });
        await act(async () => { await Promise.resolve(); });

        expect(settled).toBe(true);
        expect(answer).toBeNull();
    });

    it('clears the passphrase and closes after answering', async () => {
        // It must not linger in the DOM or in state for a later request to
        // inherit — this is a secret with no remote recovery.
        await mount();
        await act(async () => { void requestUnattendedPassphrase('Zeus-PC'); });
        await act(async () => { typeInto(q<HTMLInputElement>('input')!, 'secret words'); });
        await act(async () => { buttonWith('Connect')!.click(); });
        await act(async () => { await Promise.resolve(); });

        expect(q('.ua-prompt-backdrop')).toBeNull();
        expect(host?.textContent ?? '').not.toContain('secret words');

        // A SECOND request must start empty, not pre-filled with the last one.
        await act(async () => { void requestUnattendedPassphrase('Other-PC'); });
        expect(q<HTMLInputElement>('input')!.value).toBe('');
    });

    it('will not submit an empty passphrase', async () => {
        // An empty string would be signed and rejected as "wrong passphrase",
        // which misreports a user who simply pressed the button too early.
        await mount();
        await act(async () => { void requestUnattendedPassphrase('Zeus-PC'); });
        expect(buttonWith('Connect')!.disabled).toBe(true);
    });

    it('unmounting stops it answering, so the bridge refuses instead', async () => {
        await mount();
        act(() => root?.unmount());
        root = null;
        await expect(requestUnattendedPassphrase('Zeus-PC')).resolves.toBeNull();
    });
});
