/**
 * The sign-up form's invite-code field follows the SERVER's registration
 * gate (GET /config), instead of appearing on every server labelled
 * "Required to sign up".
 *
 * Positive control: the `false` case fails against the pre-0.9.2 component,
 * which rendered the field unconditionally — so the query below is proven to
 * find the real field.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';

const cfg = vi.hoisted(() => ({ gate: null as boolean | null, appUrl: null as string | null }));
vi.mock('../api/publicConfig', () => ({
    fetchPublicConfig: async () => ({ appUrl: cfg.appUrl, registrationInviteRequired: cfg.gate }),
}));
vi.mock('../api/auth', () => ({
    login: vi.fn(), register: vi.fn(), resetPasswordMigration: vi.fn(), REMEMBER_ME_KEY: 'sovereign_remember',
}));
vi.mock('../api/websocket', () => ({ wsClient: { connect: vi.fn() } }));
vi.mock('../api/platform', () => ({ isTauri: () => true, isMobile: () => false }));

const { Login } = await import('../components/Login');

let container: HTMLDivElement;
let root: Root;
const settle = async () => { await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };

async function mountRegistering() {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
        root.render(<MemoryRouter><Login onLoginSuccess={() => {}} /></MemoryRouter>);
    });
    // Flip to "Create Account".
    const toggle = Array.from(container.querySelectorAll('button')).find(b => /Register/.test(b.textContent ?? ''));
    expect(toggle).toBeTruthy();
    await act(async () => { toggle!.click(); });
    await settle();
}
const field = () => container.querySelector<HTMLInputElement>('#inviteCode');

beforeEach(() => { sessionStorage.clear(); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe('Login: the invite-code field follows /config', () => {
    it('open registration: no invite field at all', async () => {
        cfg.gate = false;
        await mountRegistering();
        expect(field()).toBeNull();
        expect(container.textContent).not.toMatch(/invite code/i);
    });

    it('gated registration: the field is present, required, and says where the code comes from', async () => {
        cfg.gate = true;
        await mountRegistering();
        const f = field();
        expect(f).not.toBeNull();
        expect(f!.required).toBe(true);
        expect(f!.placeholder).not.toBe('Required to sign up');
        expect(container.textContent).toMatch(/Invite code/);
    });

    it('probe failed (old server): fail closed — the field is shown, but optional and honestly labelled', async () => {
        cfg.gate = null;
        await mountRegistering();
        const f = field();
        expect(f).not.toBeNull();
        expect(f!.required).toBe(false);
        expect(container.textContent).toMatch(/only if this server requires one/i);
    });

    it('an invite link that led here is mentioned', async () => {
        cfg.gate = false;
        sessionStorage.setItem('puca_pending_invite_v1', 'aBc123Xy');
        await mountRegistering();
        expect(container.textContent).toMatch(/invited to a server/i);
    });
});

/**
 * Two different things used to be called "invite code" on this screen: the
 * code in a shared invite LINK (joins a server once you have an account) and
 * the operator's SIGN-UP gate string (needed to create the account at all).
 * A stranger who arrived by link, on a server with the gate on, pasted the
 * link's code into a field labelled "Invite code", got a 403, and was told to
 * check it for typos. The wording changes ONLY when both are in play.
 */
const LINK_CODE = 'aBc123Xy';
const label = () => container.querySelector<HTMLLabelElement>('label[for="inviteCode"]')?.textContent ?? '';

// React tracks the input's value through its own setter; set the prototype's
// and fire `input` so the controlled component sees the change.
function typeInto(el: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
}

async function submitRegistration(code: string) {
    const { register } = await import('../api/auth');
    const rejected = Object.assign(new Error('Forbidden'), { status: 403 });
    vi.mocked(register).mockRejectedValueOnce(rejected);
    await act(async () => {
        typeInto(container.querySelector<HTMLInputElement>('#username')!, 'newcomer');
        typeInto(container.querySelector<HTMLInputElement>('#password')!, 'longenough1');
        typeInto(field()!, code);
    });
    const form = container.querySelector('form')!;
    await act(async () => {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await settle();
    expect(register).toHaveBeenCalled();
    return container.querySelector('.error-message')?.textContent ?? '';
}

describe('Login: an invite link plus a sign-up gate are two different codes', () => {
    it('link + gate: the field is relabelled so it cannot be mistaken for the link, with an explanation', async () => {
        cfg.gate = true;
        sessionStorage.setItem('puca_pending_invite_v1', LINK_CODE);
        await mountRegistering();
        expect(label()).toMatch(/sign-up code/i);
        expect(label()).toMatch(/not the invite link/i);
        expect(field()!.required).toBe(true);
        expect(container.textContent).toMatch(/separate sign-up code/i);
    });

    it('gate without a link: today\'s plain label, no sign-up-code talk (positive control for the relabel)', async () => {
        cfg.gate = true;
        await mountRegistering();
        expect(label()).toBe('Invite code');
        expect(container.textContent).not.toMatch(/sign-up code/i);
    });

    it('link without a known gate (probe failed): today\'s hedged label, not the relabel', async () => {
        cfg.gate = null;
        sessionStorage.setItem('puca_pending_invite_v1', LINK_CODE);
        await mountRegistering();
        expect(label()).toMatch(/only if this server requires one/i);
        expect(label()).not.toMatch(/sign-up code/i);
    });

    it('403 with a link: the link is fine, a separate sign-up code is what is missing — no "typos"', async () => {
        cfg.gate = true;
        sessionStorage.setItem('puca_pending_invite_v1', LINK_CODE);
        await mountRegistering();
        const msg = await submitRegistration('operator-gate-string');
        expect(msg).toMatch(/invite link is fine/i);
        expect(msg).toMatch(/separate sign-up code/i);
        expect(msg).not.toMatch(/typos/i);
    });

    it('403 after pasting the LINK\'s own code into the field: says that is the wrong code, by name', async () => {
        cfg.gate = true;
        sessionStorage.setItem('puca_pending_invite_v1', LINK_CODE);
        await mountRegistering();
        const msg = await submitRegistration(`https://app.example/invite/${LINK_CODE}`);
        expect(msg).toMatch(/code from your invite link/i);
        expect(msg).toMatch(/not the sign-up code/i);
        expect(msg).not.toMatch(/typos/i);
    });

    it('403 without a link: today\'s message, typos and all (positive control for the branch)', async () => {
        cfg.gate = true;
        await mountRegistering();
        const msg = await submitRegistration('wrong');
        expect(msg).toMatch(/invite code wasn't accepted/i);
        expect(msg).toMatch(/typos/i);
        expect(msg).not.toMatch(/sign-up code/i);
    });
});
