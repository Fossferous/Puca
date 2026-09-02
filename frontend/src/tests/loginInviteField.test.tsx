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
