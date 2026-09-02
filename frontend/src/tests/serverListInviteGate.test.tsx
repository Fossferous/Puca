/**
 * "Invite People" in the server rail's context menu follows what the client
 * knows about CREATE_INVITE. Positive control first: with the permission
 * (or unknown), the item is there — proving the query finds the real node —
 * then with it known-denied, it is gone.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../hooks/queries', () => ({
    useServers: () => ({ data: [{ id: 's1', name: 'Mine', owner_id: 9, created_at: '' }], isLoading: false }),
}));
vi.mock('../api/authedMedia', () => ({ fetchFileUrl: async () => '' }));
vi.mock('../components/settingsStore', async (orig) => ({
    ...(await orig<typeof import('../components/settingsStore')>()),
}));

const { ServerList } = await import('../components/ServerList');

let container: HTMLDivElement;
let root: Root;

async function mountAndOpenMenu(canInviteCurrent: boolean | undefined) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
        root.render(
            <ServerList
                currentServerId="s1"
                onSelectServer={() => {}}
                onCreateServer={() => {}}
                onJoinServer={() => {}}
                onInviteToServer={() => {}}
                canInviteCurrent={canInviteCurrent}
                currentUserId={1}
            />,
        );
    });
    // The server's own tile (the rail also has home/discover tiles).
    const icon = container.querySelector<HTMLElement>('.server-icon[title="Mine"]');
    expect(icon).not.toBeNull();
    await act(async () => {
        icon!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));
    });
    return Array.from(container.querySelectorAll('.context-menu-item')).map(n => n.textContent?.trim());
}
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe('ServerList: Invite People', () => {
    it('is offered when the permission is held', async () => {
        expect(await mountAndOpenMenu(true)).toContain('Invite People');
    });
    it('is offered when the client cannot tell (the server stays the authority)', async () => {
        expect(await mountAndOpenMenu(undefined)).toContain('Invite People');
    });
    it('is NOT offered when CREATE_INVITE is known to be missing', async () => {
        const items = await mountAndOpenMenu(false);
        expect(items).not.toContain('Invite People');
        expect(items.length).toBeGreaterThan(0);   // the rest of the menu is intact
    });
});
