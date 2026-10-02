/**
 * Two presence surfaces the first pass left untested:
 *
 *  - usePresenceKey: a list re-renders when one of ITS users changes, and
 *    not when anybody else's presence does. The member list lives in the
 *    ~6000-line Chat view; subscribing it to every change of everyone (the
 *    first pass's usePresenceVersion) re-rendered the whole root view for
 *    each UserStatus of any user on any server.
 *  - The DM search ("Find or start a conversation"): a result someone can
 *    already see through a shared server or a friendship shows the store's
 *    idle / away; the search endpoint itself only says online / offline.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const api = vi.hoisted(() => ({
    results: [] as Array<{ id: number; username: string; is_online: boolean }>,
}));
vi.mock('../api/dms', () => ({
    searchUsers: async () => api.results,
}));

const { HomeSidebar } = await import('../components/HomeSidebar');
const { applyPresenceFrame, usePresenceKey, __resetPresenceForTests } = await import('../api/presenceStore');

let container: HTMLDivElement;
let root: Root;
const push = async (type: string, payload: object) => {
    await act(async () => { applyPresenceFrame({ type, payload: payload as Record<string, unknown> }); });
};

beforeEach(() => {
    __resetPresenceForTests();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe('usePresenceKey re-renders a list only for its own users', () => {
    it('ignores a change of someone not in the list, follows one who is', async () => {
        let renders = 0;
        const members = [{ id: 10, is_online: true }, { id: 11, is_online: false }];
        function List() {
            usePresenceKey(members);
            renders++;
            return null;
        }
        await act(async () => { root.render(<List />); });
        const base = renders;

        // Someone on another server goes idle: not this list's business.
        await push('UserStatus', { user_id: 99, status: 'idle' });
        await push('UserOffline', { user_id: 98 });
        expect(renders).toBe(base);

        // A member goes idle, another comes online: each re-renders it.
        await push('UserStatus', { user_id: 10, status: 'idle' });
        expect(renders).toBe(base + 1);
        await push('UserOnline', { user: { id: 11, username: 'x' } });
        expect(renders).toBe(base + 2);
        // The same status again is no change at all.
        await push('UserStatus', { user_id: 10, status: 'idle' });
        expect(renders).toBe(base + 2);
    });
});

describe('DM search results show the store’s idle / away', () => {
    it('a visible result shows the zz badge; an offline one shows no dot', async () => {
        api.results = [
            { id: 5, username: 'bob', is_online: true },
            { id: 6, username: 'eve', is_online: false },
        ];
        await act(async () => {
            root.render(
                <HomeSidebar
                    dmConversations={[]}
                    friendsActive={false}
                    tasksActive={false}
                    searchQuery="b"
                    onSearchQueryChange={() => {}}
                    onNavFriends={() => {}}
                    onNavTasks={() => {}}
                    onSelectDM={() => {}}
                    onStartUserDM={() => {}}
                />,
            );
        });
        // The search is debounced by 300 ms.
        await act(async () => { await new Promise(r => setTimeout(r, 350)); });
        const row = (name: string) =>
            Array.from(container.querySelectorAll('.search-result')).find(r => r.textContent?.includes(name))!;
        expect(row('bob').querySelector('.presence-dot.is-online')).not.toBeNull();
        expect(row('eve').querySelector('.presence-dot')).toBeNull();

        await push('UserStatus', { user_id: 5, status: 'away' });
        const dot = row('bob').querySelector('.presence-dot')!;
        expect(dot.classList.contains('is-away')).toBe(true);
        expect(dot.getAttribute('aria-label')).toBe('Away');
        expect(dot.querySelector('svg')).not.toBeNull();
    });
});
