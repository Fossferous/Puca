/**
 * Settings › Privacy & Safety › "Show when I'm idle or away".
 *
 * A setting needs its UI, and the UI has three states that matter:
 *  - ABSENT against an older server (its GET /profile has no
 *    show_idle_status): a switch that does nothing must not be offered;
 *  - DISABLED while "Show online status" is off: nothing is shared then, so
 *    there is nothing for this switch to change;
 *  - otherwise it PATCHes show_idle_status, and nothing else.
 *
 * Mounted with raw `react-dom/client` + `act`, as the repo's other component
 * tests are.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const api = vi.hoisted(() => ({
    profile: {} as Record<string, unknown>,
    updateProfile: vi.fn(async (_u: Record<string, unknown>) => {}),
}));
vi.mock('../api/profile', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../api/profile')>()),
    getProfile: async () => api.profile,
    updateProfile: (u: Record<string, unknown>) => api.updateProfile(u),
}));
vi.mock('../components/blockStore', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../components/blockStore')>()),
    fetchBlockedUsers: async () => [],
}));
vi.mock('../api/client', async (importOriginal) => {
    const real = await importOriginal<typeof import('../api/client')>();
    return { ...real, apiClient: { ...real.apiClient, get: async () => ({}) } };
});

const { SettingsModal } = await import('../components/SettingsModal');

let container: HTMLDivElement;
let root: Root;
const settle = async () => { await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };

beforeEach(() => {
    api.updateProfile.mockClear();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });

async function openPrivacy(profile: Record<string, unknown>) {
    api.profile = {
        id: 1, username: 'me', display_name: null, email: null,
        allow_dms_from_server_members: true, show_online_status: true,
        ...profile,
    };
    await act(async () => { root.render(<SettingsModal isOpen onClose={() => {}} onLogout={() => {}} />); });
    await settle();
    const nav = Array.from(container.querySelectorAll('.settings-nav-item'))
        .find(b => b.textContent?.includes('Privacy'));
    expect(nav, 'the Privacy & Safety section exists').toBeTruthy();
    await act(async () => { nav!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await settle();
    // Positive control: the privacy flags loaded (the online switch is there).
    expect(container.querySelector('h3')?.textContent).toContain('Privacy');
    return () => container.querySelector<HTMLInputElement>('#privacy-show-idle');
}

describe('"Show when I\'m idle or away"', () => {
    it('is not offered by an older server (no show_idle_status in the profile)', async () => {
        const idle = await openPrivacy({});
        expect(container.textContent).toContain('Show online status');
        expect(idle()).toBeNull();
    });

    it('is disabled while "Show online status" is off', async () => {
        const idle = await openPrivacy({ show_online_status: false, show_idle_status: true });
        expect(idle()).not.toBeNull();
        expect(idle()!.disabled).toBe(true);
        expect(container.textContent).toContain('Nothing is shared while "Show online status" is off.');
    });

    it('PATCHes show_idle_status, and only that', async () => {
        const idle = await openPrivacy({ show_online_status: true, show_idle_status: true });
        expect(idle()!.disabled).toBe(false);
        expect(idle()!.checked).toBe(true);
        await act(async () => { idle()!.click(); });
        await settle();
        expect(api.updateProfile).toHaveBeenCalledTimes(1);
        expect(api.updateProfile).toHaveBeenCalledWith({ show_idle_status: false });
        expect(idle()!.checked).toBe(false);
    });
});
