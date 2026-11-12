/**
 * The desktop app's Discord entry (api/discordWindow.ts; the window itself is
 * src-tauri/src/discord_window.rs): offered only in the Windows desktop app, in
 * the full build AND the Lite build, only once Settings turns it on, live with
 * no reload; a press asks the shell for `discord_window_open` and nothing else;
 * the Settings checkbox is where it is said to be, says plainly what Púca can and
 * cannot see, and nowhere on the web; "Sign out of Discord and clear its data on
 * this PC" asks first, then asks the shell for `discord_window_clear_data` and says
 * how it went; turning the switch off offers it too.
 *
 * Mounted with raw `react-dom/client` + `act`, as the repo's other component
 * tests are.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const env = vi.hoisted(() => ({
    tauri: true,
    mobile: false,
    rc: true,
    invoke: vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => undefined),
    /** The in-page question's answer, and what it was asked. */
    confirm: true,
    asked: [] as string[],
}));

vi.mock('../api/platform', async (importOriginal) => {
    const real = await importOriginal<typeof import('../api/platform')>();
    return {
        ...real,
        isTauri: () => env.tauri,
        isMobile: () => env.mobile,
        get RC_ENABLED() { return env.rc; },
    };
});
vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@tauri-apps/api/core')>()),
    invoke: (cmd: string, args?: unknown) => env.invoke(cmd, args),
}));
vi.mock('../api/appDialogs', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../api/appDialogs')>()),
    askConfirm: async (message: string) => { env.asked.push(message); return env.confirm; },
}));
vi.mock('../hooks/queries', () => ({
    useServers: () => ({ data: [{ id: 's1', name: 'Mine', owner_id: 9, created_at: '' }], isLoading: false }),
}));
vi.mock('../api/authedMedia', () => ({ fetchFileUrl: async () => '' }));
// What SettingsModal fetches when it opens.
vi.mock('../api/profile', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../api/profile')>()),
    getProfile: async () => ({ id: 1, username: 'me', display_name: null, email: null }),
}));
vi.mock('../components/blockStore', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../components/blockStore')>()),
    fetchBlockedUsers: async () => [],
}));
vi.mock('../api/client', async (importOriginal) => {
    const real = await importOriginal<typeof import('../api/client')>();
    return { ...real, apiClient: { ...real.apiClient, get: async () => ({}) } };
});

const { discordEntryShown, discordWindowAvailable } = await import('../api/discordWindow');
const { useDiscordEntry } = await import('../components/useDiscordEntry');
const { ServerList } = await import('../components/ServerList');
const { SettingsModal } = await import('../components/SettingsModal');
const { loadSettings, saveSettings } = await import('../components/settingsStore');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0';
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const LINUX_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36';

function setUserAgent(ua: string) {
    Object.defineProperty(window.navigator, 'userAgent', { value: ua, configurable: true });
}

let container: HTMLDivElement;
let root: Root;
const settle = async () => { await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };

const errors: string[] = [];
function Rail() {
    const onOpenDiscord = useDiscordEntry((text) => errors.push(text));
    return (
        <ServerList
            currentServerId="s1"
            onSelectServer={() => {}}
            onCreateServer={() => {}}
            onJoinServer={() => {}}
            onOpenDiscord={onOpenDiscord}
            currentUserId={1}
        />
    );
}
const discordButton = () => container.querySelector<HTMLElement>('.server-icon.discord-window');

function setEntry(on: boolean) {
    act(() => { saveSettings({ ...loadSettings(), showDiscordEntry: on }); });
}

// setup.ts replaces localStorage with bare vi.fn()s that store nothing; the
// setting has to survive from the switch to the rail, so give it a real store.
const store = new Map<string, string>();

beforeEach(() => {
    store.clear();
    vi.mocked(localStorage.getItem).mockImplementation((k: string) => store.get(k) ?? null);
    vi.mocked(localStorage.setItem).mockImplementation((k: string, v: string) => { store.set(k, String(v)); });
    vi.mocked(localStorage.removeItem).mockImplementation((k: string) => { store.delete(k); });
    env.tauri = true;
    env.mobile = false;
    env.rc = true;
    env.invoke.mockReset();
    env.invoke.mockImplementation(async (cmd: string) => (cmd === 'discord_window_clear_data' ? 'cleared' : undefined));
    env.confirm = true;
    env.asked.length = 0;
    errors.length = 0;
    setUserAgent(WINDOWS_UA);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
});

describe.each([
    ['the full build', true],
    ['the Lite build', false],
])('where the Discord entry is offered, in %s', (_build, rc) => {
    beforeEach(() => { env.rc = rc; });

    it('the Windows desktop app: only once it is switched on', () => {
        expect(discordWindowAvailable()).toBe(true);
        expect(discordEntryShown({ showDiscordEntry: false })).toBe(false);
        expect(discordEntryShown({})).toBe(false);
        expect(discordEntryShown({ showDiscordEntry: true })).toBe(true);
    });

    it('off by default', () => {
        expect(loadSettings().showDiscordEntry).toBe(false);
        expect(discordEntryShown(loadSettings())).toBe(false);
    });

    it('never in the web app, on a phone, or in a desktop app the window cannot run on', () => {
        env.tauri = false;
        expect(discordEntryShown({ showDiscordEntry: true }), 'web app on Windows').toBe(false);
        env.tauri = true;
        env.mobile = true;
        setUserAgent(ANDROID_UA);
        expect(discordEntryShown({ showDiscordEntry: true }), 'phone app').toBe(false);
        env.mobile = false;
        for (const ua of [MAC_UA, LINUX_UA]) {
            setUserAgent(ua);
            expect(discordEntryShown({ showDiscordEntry: true }), ua).toBe(false);
        }
    });

    it('the rail shows it when Settings turns it on, with no reload, and takes it away again', async () => {
        await act(async () => { root.render(<Rail />); });
        await settle();
        expect(discordButton(), 'off by default').toBeNull();
        // CONTROL: the rail did render (its other actions are there).
        expect(container.querySelector('.server-icon.discover-server')).not.toBeNull();

        setEntry(true);
        await settle();
        expect(discordButton(), 'switched on').not.toBeNull();

        setEntry(false);
        await settle();
        expect(discordButton(), 'switched off').toBeNull();
    });

    it('a press asks the shell to open the window, and nothing else', async () => {
        setEntry(true);
        await act(async () => { root.render(<Rail />); });
        await settle();
        // Saving any setting tells the shell about close-to-tray; only the
        // press itself counts here.
        env.invoke.mockClear();
        await act(async () => { discordButton()!.click(); });
        await settle();
        expect(env.invoke.mock.calls).toEqual([['discord_window_open', undefined]]);
        expect(errors).toEqual([]);
    });

    it("the shell's refusal reaches the person", async () => {
        env.invoke.mockImplementation(async () => { throw 'Could not open the Discord window: denied'; });
        setEntry(true);
        await act(async () => { root.render(<Rail />); });
        await settle();
        await act(async () => { discordButton()!.click(); });
        await settle();
        expect(errors).toEqual(['Could not open the Discord window: denied']);
    });

    it('not on the web even when the setting is on (a setting carried over from elsewhere)', async () => {
        env.tauri = false;
        setEntry(true);
        await act(async () => { root.render(<Rail />); });
        await settle();
        expect(discordButton()).toBeNull();
        // CONTROL: the setting really is on, so the absence is the platform's doing.
        expect(loadSettings().showDiscordEntry).toBe(true);
        expect(env.invoke).not.toHaveBeenCalled();
    });
});

describe('the setting', () => {
    async function openAdvanced() {
        await act(async () => { root.render(<SettingsModal isOpen onClose={() => {}} onLogout={() => {}} />); });
        await settle();
        const nav = [...container.querySelectorAll('.settings-nav-item')].find(b => b.textContent?.includes('Advanced'));
        expect(nav, 'the Advanced section exists').toBeTruthy();
        await act(async () => { nav!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
        await settle();
        return container.querySelector<HTMLInputElement>('#settings-show-discord');
    }

    it.each([
        ['the full build', true],
        ['the Lite build', false],
    ])('is in Settings > Advanced > Desktop App in %s, and switches the entry', async (_build, rc) => {
        env.rc = rc;
        const box = await openAdvanced();
        expect(box, 'the checkbox is there').not.toBeNull();
        expect(box!.closest('.settings-card')?.textContent).toContain('Keep running in the tray when closed');
        expect(box!.checked).toBe(false);
        await act(async () => { box!.click(); });
        expect(loadSettings().showDiscordEntry).toBe(true);
        expect(discordEntryShown(loadSettings())).toBe(true);
        await act(async () => { box!.click(); });
        expect(loadSettings().showDiscordEntry).toBe(false);
    });

    it('says plainly what Púca can and cannot see', async () => {
        const box = await openAdvanced();
        const hint = box!.closest('.settings-option')!.textContent!.replace(/\s+/g, ' ');
        for (const claim of [
            "Púca's code never runs in that window",
            'Púca cannot read the page, your messages or your Discord sign-in',
            'Your Púca server never sees any of it: the window talks to Discord directly',
            'Your Discord sign-in is kept in a separate store on this PC',
            'Off by default',
        ]) {
            expect(hint, claim).toContain(claim);
        }
    });

    const clearCalls = () => env.invoke.mock.calls.filter(([cmd]) => cmd === 'discord_window_clear_data');
    const clearButton = () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Sign out and clear');
    const statusText = () => container.querySelector('.discord-clear-status')?.textContent ?? '';

    it.each([
        ['the full build', true],
        ['the Lite build', false],
    ])('"Sign out of Discord and clear its data on this PC" asks, clears and says so, in %s', async (_build, rc) => {
        env.rc = rc;
        await openAdvanced();
        expect(container.textContent).toContain('Sign out of Discord and clear its data on this PC');
        const button = clearButton();
        expect(button, 'the button is there, beside the switch').toBeTruthy();
        expect(button!.closest('.settings-card')?.querySelector('#settings-show-discord')).not.toBeNull();

        // Asked first, and Cancel clears nothing.
        env.confirm = false;
        await act(async () => { button!.click(); });
        await settle();
        expect(env.asked).toHaveLength(1);
        expect(env.asked[0]).toMatch(/Sign out of Discord and clear its data on this PC\?/);
        expect(env.asked[0]).toMatch(/Your Discord account itself is not touched/);
        expect(clearCalls()).toHaveLength(0);

        // OK clears, and says so.
        env.confirm = true;
        await act(async () => { button!.click(); });
        await settle();
        expect(clearCalls()).toEqual([['discord_window_clear_data', undefined]]);
        expect(statusText()).toMatch(/signed out on this PC/);

        // Nothing stored, and a refusal, are said too.
        env.invoke.mockImplementation(async () => 'nothing');
        await act(async () => { button!.click(); });
        await settle();
        expect(statusText()).toMatch(/had nothing stored/);
        env.invoke.mockImplementation(async () => { throw 'The Discord window did not close. Close it, then try again.'; });
        await act(async () => { button!.click(); });
        await settle();
        expect(statusText()).toBe('The Discord window did not close. Close it, then try again.');
    });

    it('turning the switch off offers the way out, and only then', async () => {
        const box = await openAdvanced();
        // On: no question.
        await act(async () => { box!.click(); });
        await settle();
        expect(loadSettings().showDiscordEntry).toBe(true);
        expect(env.asked).toHaveLength(0);
        // Off, declined: the switch is off and nothing is cleared.
        env.confirm = false;
        await act(async () => { box!.click(); });
        await settle();
        expect(loadSettings().showDiscordEntry).toBe(false);
        expect(env.asked).toHaveLength(1);
        expect(clearCalls()).toHaveLength(0);
        // Off, accepted: cleared.
        await act(async () => { box!.click(); });
        env.confirm = true;
        await act(async () => { box!.click(); });
        await settle();
        expect(env.asked).toHaveLength(2);
        expect(clearCalls()).toHaveLength(1);
    });

    it('is not offered in the web app', async () => {
        env.tauri = false;
        const box = await openAdvanced();
        expect(box).toBeNull();
        expect(container.textContent).not.toContain('Sign out of Discord');
        // CONTROL: the section did render.
        expect(container.textContent).toContain('Developer Mode');
    });
});

describe('the Lite build keeps it', () => {
    const FRONTEND = join(__dirname, '..', '..');
    const SRC = join(FRONTEND, 'src');

    /** Which of these module ids the Lite build's remote-control guard refuses. */
    function refused(ids: string[]): boolean[] {
        const script = "const m = await import('./vite.shared.ts');"
            + ` const ids = ${JSON.stringify(ids)};`
            + ' process.stdout.write(JSON.stringify(ids.map(id => m.RC_MODULE_PATTERNS.some(re => re.test(id)))));';
        const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', script], { cwd: FRONTEND, encoding: 'utf8' });
        expect(r.status, r.stderr).toBe(0);
        return JSON.parse(r.stdout) as boolean[];
    }

    it('none of its modules is remote-control code the Lite build would strip', () => {
        const [api, hook, settingsRows, control] = refused([
            join(SRC, 'api', 'discordWindow.ts'),
            join(SRC, 'components', 'useDiscordEntry.ts'),
            join(SRC, 'components', 'DiscordWindowSettings.tsx'),
            // CONTROL: the guard does refuse remote-control code.
            join(SRC, 'components', 'RcGlobals.tsx'),
        ]);
        expect(api).toBe(false);
        expect(hook).toBe(false);
        expect(settingsRows).toBe(false);
        expect(control).toBe(true);
    }, 30_000);

    it('and neither reads the remote-control switch', () => {
        for (const rel of ['api/discordWindow.ts', 'components/useDiscordEntry.ts', 'components/DiscordWindowSettings.tsx']) {
            const text = readFileSync(join(SRC, rel), 'utf8');
            expect(text, rel).not.toMatch(/RC_ENABLED|__RC_ENABLED__|remoteControl/);
        }
    });
});
