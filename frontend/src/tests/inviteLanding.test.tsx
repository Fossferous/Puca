/**
 * `/invite/:code` (components/InviteLanding.tsx): the route that did not exist.
 *
 * Until 0.9.2 App's `*` route sent an invite link to `/`, discarding the code.
 * Now the code is stashed and the visitor is routed to sign in (signed out)
 * or to /chat (signed in), where Chat opens the join flow with it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

const authed = vi.hoisted(() => ({ value: false }));
vi.mock('../api/auth', () => ({ isAuthenticated: () => authed.value }));

const { InviteLanding } = await import('../components/InviteLanding');
const { peekPendingInvite } = await import('../api/pendingInvite');

function Probe() {
    const loc = useLocation();
    return <div data-testid="where">{loc.pathname}</div>;
}

let container: HTMLDivElement;
let root: Root;

async function mountAt(path: string) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
        root.render(
            <MemoryRouter initialEntries={[path]}>
                <Routes>
                    <Route path="/invite/:code" element={<InviteLanding />} />
                    <Route path="*" element={<Probe />} />
                </Routes>
            </MemoryRouter>,
        );
    });
    return container.querySelector('[data-testid="where"]')?.textContent;
}

beforeEach(() => { sessionStorage.clear(); authed.value = false; });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe('InviteLanding', () => {
    it('signed out: stashes the code and goes to /login', async () => {
        expect(await mountAt('/invite/aBc123Xy')).toBe('/login');
        expect(peekPendingInvite()).toBe('aBc123Xy');
    });

    it('signed in: stashes the code and goes to /chat', async () => {
        authed.value = true;
        expect(await mountAt('/invite/aBc123Xy')).toBe('/chat');
        expect(peekPendingInvite()).toBe('aBc123Xy');
    });

    it('a malformed code stashes nothing and falls through to the landing route', async () => {
        expect(await mountAt('/invite/no%20such%20code')).toBe('/');
        expect(peekPendingInvite()).toBeNull();
    });
});
