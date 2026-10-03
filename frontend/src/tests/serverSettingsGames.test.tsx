/**
 * Server Settings › Overview › "Allow games in voice calls" — the owner's
 * per-server switch for docs/GAMES.md (servers.games_enabled, migration 073,
 * ON by default since 2026-10-03), next to Clips. A setting ships with its UI:
 *
 *  - it reflects the server's value and saves `games_enabled` both ways;
 *  - only the owner can change it (disabled, and Save absent, otherwise);
 *  - a server that predates games (the field absent) renders it disabled
 *    with a note, and the key is NEVER sent — an older backend would drop
 *    the write silently and the owner would believe it saved.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const updateServerSettings = vi.fn(async () => {});
vi.mock('../api/servers', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../api/servers')>()),
    updateServerSettings: (...a: unknown[]) => updateServerSettings(...(a as [])),
    listChannels: async () => [],
}));
vi.mock('../api/authedMedia', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../api/authedMedia')>()),
    fetchFileUrl: async () => null,
}));

const { ServerSettingsModal } = await import('../components/ServerSettingsModal');

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

type Props = Parameters<typeof ServerSettingsModal>[0];
async function open(over: Partial<Props> = {}) {
    await act(async () => {
        root.render(<ServerSettingsModal isOpen onClose={() => {}} serverId="s1" serverName="Test Server" isOwner {...over} />);
    });
}
const toggle = () => container.querySelector<HTMLInputElement>('input[aria-label="Allow games in voice calls"]');
const saveBtn = () => [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Save Changes');
async function save() {
    await act(async () => { saveBtn()!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}
const body = () => (updateServerSettings.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];

describe('ServerSettingsModal — Games', () => {
    it("sits next to Clips and reflects the server's value (here: off)", async () => {
        await open({ initialGamesEnabled: false });
        expect(toggle()).toBeTruthy();
        expect(toggle()!.checked).toBe(false);
        expect(toggle()!.disabled).toBe(false);
        // The very next group after Clips'.
        const clips = toggle()!.closest('.form-group')!.previousElementSibling;
        expect(clips?.textContent).toContain('Allow clips');
        // Says who can see the cards, as GAMES.md's trust section does.
        expect(toggle()!.closest('.form-group')!.textContent).toContain('whoever runs it could see them');
    });

    it('turning it on saves games_enabled: true; off saves false', async () => {
        await open({ initialGamesEnabled: false });
        await act(async () => { toggle()!.click(); });
        expect(toggle()!.checked).toBe(true);
        await save();
        expect(body()).toMatchObject({ games_enabled: true });

        updateServerSettings.mockClear();
        await act(async () => { toggle()!.click(); });
        await save();
        expect(body()).toMatchObject({ games_enabled: false });
    });

    it('a server that predates games: disabled with a note, and the key is never sent', async () => {
        await open({ initialGamesEnabled: undefined });
        expect(toggle()!.disabled).toBe(true);
        expect(container.textContent).toContain('This server runs an older version without games.');
        await save();
        expect(updateServerSettings).toHaveBeenCalledTimes(1);
        expect(body()).not.toHaveProperty('games_enabled');
    });

    it('only the owner can change it', async () => {
        await open({ initialGamesEnabled: true, isOwner: false });
        expect(toggle()!.checked).toBe(true);
        expect(toggle()!.disabled).toBe(true);
        expect(saveBtn()).toBeUndefined();
    });
});
