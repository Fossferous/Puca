// @vitest-environment jsdom
/**
 * Settings must be reachable from the overlay views. The Friends/Tasks
 * dashboard is a fixed z-100 overlay that covers the channel sidebar — and
 * with it the app's only settings cog — so it carries its own via the
 * onOpenSettings prop. Both header branches (Friends and Tasks) get one; the
 * prop absent renders none (the panel is also mounted in contexts that own no
 * settings modal).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../api/friends', () => ({
    listFriends: async () => [],
    listIncomingRequests: async () => [],
    listOutgoingRequests: async () => [],
    acceptFriendRequest: async () => { /* noop */ },
    rejectFriendRequest: async () => { /* noop */ },
    removeFriend: async () => { /* noop */ },
    sendFriendRequest: async () => { /* noop */ },
}));
vi.mock('../api/dms', () => ({
    startDMConversation: async () => null,
    listDMConversations: async () => [],
    searchUsers: async () => [],
}));
vi.mock('../components/TasksView', () => ({ TasksView: () => <div data-testid="tasks-view" /> }));
vi.mock('../components/HomeSidebar', () => ({ HomeSidebar: () => <div data-testid="home-sidebar" /> }));

const { FriendsPanel } = await import('../components/FriendsPanel');

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    host?.remove();
    root = null;
    host = null;
});

async function mount(props: { onOpenSettings?: () => void; initialTab?: 'online' | 'tasks' }) {
    await act(async () => {
        root!.render(
            <FriendsPanel
                onStartDM={() => { /* noop */ }}
                onClose={() => { /* noop */ }}
                {...props}
            />,
        );
    });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}

const cog = () => host!.querySelector<HTMLButtonElement>('.header-cog');

describe('the overlay views carry their own settings cog', () => {
    it('Friends header: renders the cog and fires the callback', async () => {
        const open = vi.fn();
        await mount({ onOpenSettings: open });
        expect(cog(), 'the Friends header must offer Settings').toBeTruthy();
        await act(async () => cog()!.click());
        expect(open).toHaveBeenCalledTimes(1);
    });

    it('Tasks header: same affordance on the other branch', async () => {
        const open = vi.fn();
        await mount({ onOpenSettings: open, initialTab: 'tasks' });
        expect(host!.querySelector('[data-testid="tasks-view"]'), 'the Tasks branch is up').toBeTruthy();
        expect(cog(), 'the Tasks header must offer Settings').toBeTruthy();
        await act(async () => cog()!.click());
        expect(open).toHaveBeenCalledTimes(1);
    });

    it('POSITIVE CONTROL: without the prop, no cog renders', async () => {
        await mount({});
        expect(cog()).toBeNull();
    });
});
