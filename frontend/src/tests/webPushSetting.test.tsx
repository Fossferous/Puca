import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * Settings → Notifications → "Notifications while Púca is closed". A setting
 * needs its UI (CLAUDE.md), and this one needs it to TELL THE TRUTH: where Web
 * Push cannot work the row says why instead of offering a switch that does
 * nothing, and in the desktop and Android apps it is not there at all.
 *
 * Raw react-dom/client + act, as the repo's other component tests.
 */

// A real localStorage (the shared setup's stubs store nothing): the row reads
// the setting back after the switch flips it.
const backing = new Map<string, string>();
Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
        getItem: (k: string) => (backing.has(k) ? backing.get(k)! : null),
        setItem: (k: string, v: string) => { backing.set(k, String(v)); },
        removeItem: (k: string) => { backing.delete(k); },
        clear: () => { backing.clear(); },
    },
});

const wp = vi.hoisted(() => ({
    env: 'ok' as string,
    key: 'KEY' as string | null,
    enable: vi.fn(),
    disable: vi.fn(),
    test: vi.fn(),
}));
vi.mock('../api/webPush', () => ({
    webPushEnvironment: () => wp.env,
    fetchServerKey: async () => wp.key,
    enableWebPush: wp.enable,
    disableWebPush: wp.disable,
    sendTestPush: wp.test,
}));

const { default: WebPushSetting } = await import('../components/WebPushSetting');
const { saveSettings, loadSettings } = await import('../components/settingsStore');

const notification = { permission: 'default' as NotificationPermission };
let host: HTMLDivElement;
let root: Root;

async function mount() {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root.render(<WebPushSetting />); });
    await act(async () => { await Promise.resolve(); }); // the key lookup
}

const checkbox = () => host.querySelector<HTMLInputElement>('input[type="checkbox"]');
const button = (name: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === name);

beforeEach(() => {
    wp.env = 'ok';
    wp.key = 'KEY';
    wp.enable.mockReset().mockResolvedValue({ ok: true });
    wp.disable.mockReset().mockResolvedValue(undefined);
    wp.test.mockReset().mockResolvedValue(undefined);
    notification.permission = 'default';
    Object.defineProperty(window, 'Notification', { configurable: true, value: notification });
});

afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
});

describe('WebPushSetting', () => {
    it.each(['native-app', 'embedded'])('renders nothing in %s', async (env) => {
        wp.env = env;
        await mount();
        expect(host.innerHTML).toBe('');
    });

    it('in an iPhone Safari tab, says to add Púca to the Home Screen, with no switch', async () => {
        wp.env = 'ios-needs-home-screen';
        await mount();
        expect(host.textContent).toMatch(/only Púca on your Home Screen can get notifications/);
        expect(host.textContent).toMatch(/Add to Home Screen/);
        expect(checkbox()).toBeNull();
    });

    it('says when the server has not set it up', async () => {
        wp.key = null;
        await mount();
        expect(host.textContent).toMatch(/has not set up push notifications/);
        expect(checkbox()).toBeNull();
    });

    it('says when the browser blocked notifications', async () => {
        notification.permission = 'denied';
        await mount();
        expect(host.textContent).toMatch(/blocked for this site/);
        expect(checkbox()).toBeNull();
    });

    it('says what the push service learns, next to the switch', async () => {
        await mount();
        expect(checkbox()).not.toBeNull();
        expect(host.textContent).toMatch(/learns only that something arrived and when/);
    });

    it('the switch turns it on (the tap is what asks), and then offers a test', async () => {
        await mount();
        expect(wp.enable).not.toHaveBeenCalled(); // nothing asks before the tap
        wp.enable.mockImplementation(async () => {
            saveSettings({ ...loadSettings(), webPushEnabled: true });
            return { ok: true };
        });
        await act(async () => { checkbox()!.click(); });
        expect(wp.enable).toHaveBeenCalledTimes(1);
        await vi.waitFor(() => expect(button('Send a test')).toBeTruthy());
        await act(async () => { button('Send a test')!.click(); });
        expect(wp.test).toHaveBeenCalledTimes(1);
        await vi.waitFor(() => expect(host.textContent).toMatch(/Sent\./));
        // And off again.
        await act(async () => { checkbox()!.click(); });
        expect(wp.disable).toHaveBeenCalledTimes(1);
        saveSettings({ ...loadSettings(), webPushEnabled: false });
    });

    it('a refusal is reported in words', async () => {
        wp.enable.mockResolvedValue({ ok: false, reason: 'denied' });
        await mount();
        await act(async () => { checkbox()!.click(); });
        await vi.waitFor(() => expect(host.textContent).toMatch(/The browser did not allow notifications\./));
    });
});
