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

    /**
     * WHICH PASSPHRASE. A PC with lock-screen access has two (Devices, This
     * device on it): the one under "Unattended access", checked by its desktop
     * app, and "Passphrase for the sign-in screen", checked by its lock-screen
     * service, each its own record. A locked PC answers as the second. The
     * dialog used to say "Unattended passphrase" for both, so someone whose
     * two passphrases differ typed the wrong one at every locked PC, was
     * refused, and was asked again next time (review of work/poweroff-locked,
     * 2026-11-20).
     */
    it('THE FINDING: a PC at its sign-in screen asks for THAT passphrase, by its setting\'s name, naming the PC', async () => {
        await mount();
        await act(async () => {
            void requestUnattendedPassphrase('pc-signin', { peerName: 'Desk-PC', signIn: true });
        });
        const dialog = q('.ua-prompt-backdrop')!;
        expect(dialog.getAttribute('aria-label')).toBe('Passphrase for the sign-in screen');
        expect(q('h2')?.textContent).toBe('Passphrase for the sign-in screen');
        const input = q<HTMLInputElement>('input')!;
        expect(input.getAttribute('aria-label')).toBe('Passphrase for the sign-in screen');
        expect(input.placeholder).toBe('Passphrase for the sign-in screen');
        const body = q('.ua-prompt-body')?.textContent ?? '';
        expect(body).toContain('Desk-PC is locked or at its sign-in screen');
        // Says it is the OTHER one, so a person with two knows which to type.
        expect(body).toMatch(/not its unattended access passphrase/);
        expect(body).toMatch(/not your Windows password/);
        expect(dialog.textContent).not.toMatch(/Unattended passphrase|set up for unattended access/);
    });

    it('CONTROL: the desktop row asks for the unattended passphrase, naming the PC and the setting', async () => {
        await mount();
        await act(async () => {
            void requestUnattendedPassphrase('pc', { peerName: 'Desk-PC', signIn: false });
        });
        expect(q('.ua-prompt-backdrop')!.getAttribute('aria-label')).toBe('Unattended passphrase');
        expect(q('h2')?.textContent).toBe('Unattended passphrase');
        expect(q<HTMLInputElement>('input')!.getAttribute('aria-label')).toBe('Unattended passphrase');
        const body = q('.ua-prompt-body')?.textContent ?? '';
        expect(body).toContain('Desk-PC is set up for unattended access');
        expect(body).toContain('Unattended access');
        expect(body).not.toMatch(/sign-in screen/i);
    });

    it('a caller that did not name the PC gets "This device", and the unattended wording', async () => {
        await mount();
        await act(async () => { void requestUnattendedPassphrase('pc'); });
        expect(q('h2')?.textContent).toBe('Unattended passphrase');
        expect(q('.ua-prompt-body')?.textContent ?? '').toContain('This device is set up for unattended access');
    });

    it('unmounting stops it answering, so the bridge refuses instead', async () => {
        await mount();
        act(() => root?.unmount());
        root = null;
        await expect(requestUnattendedPassphrase('Zeus-PC')).resolves.toBeNull();
    });
});
