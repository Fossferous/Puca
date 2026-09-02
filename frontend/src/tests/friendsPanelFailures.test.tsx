/**
 * FriendsPanel: failures are VISIBLE, and the Pending search box works.
 *
 *  - "already friends" (409) used to be dead code: the branch read
 *    `err.response.status`, the axios shape, so every duplicate request
 *    showed the generic "Failed to send friend request." — positive control:
 *    the first test fails on the old component;
 *  - Accept / Decline / Remove swallowed their errors into console.error, so
 *    a tap did nothing and the row came back 15 s later unexplained;
 *  - the Pending tab's search input was uncontrolled and wired to nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ApiError } from '../api/client';

const api = vi.hoisted(() => ({
    friends: [] as Array<{ id: number; username: string; is_online: boolean }>,
    incoming: [] as Array<{ id: number; sender_id: number; sender_username: string; created_at: string }>,
    outgoing: [] as Array<{ id: number; receiver_id: number; receiver_username: string; created_at: string }>,
    sendError: null as unknown,
    acceptError: null as unknown,
}));
vi.mock('../api/friends', () => ({
    listFriends: async () => api.friends,
    listIncomingRequests: async () => api.incoming,
    listOutgoingRequests: async () => api.outgoing,
    sendFriendRequest: async () => { if (api.sendError) throw api.sendError; },
    acceptFriendRequest: async () => { if (api.acceptError) throw api.acceptError; },
    rejectFriendRequest: async () => {},
    removeFriend: async () => {},
}));
vi.mock('../api/dms', () => ({
    listDMConversations: async () => [],
    startDMConversation: async () => ({ id: 1 }),
    searchUsers: async (q: string) => [{ id: 42, username: q }],
}));
vi.mock('../components/TasksView', () => ({ TasksView: () => null }));
vi.mock('../components/HomeSidebar', () => ({ HomeSidebar: () => null }));

const { FriendsPanel } = await import('../components/FriendsPanel');

let container: HTMLDivElement;
let root: Root;
const settle = async () => { await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };
const tab = (label: string) => Array.from(container.querySelectorAll<HTMLButtonElement>('.header-tab')).find(b => b.textContent?.startsWith(label))!;
const setInput = async (el: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
        setter.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
    });
};

beforeEach(async () => {
    api.friends = [{ id: 2, username: 'ann', is_online: true }, { id: 3, username: 'bob', is_online: false }];
    api.incoming = [
        { id: 10, sender_id: 4, sender_username: 'carol', created_at: '2026-09-01T00:00:00Z' },
        { id: 11, sender_id: 5, sender_username: 'dave', created_at: '2026-09-01T00:00:00Z' },
    ];
    api.outgoing = [{ id: 12, receiver_id: 6, receiver_username: 'erin', created_at: '2026-09-01T00:00:00Z' }];
    api.sendError = null;
    api.acceptError = null;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root.render(<FriendsPanel onStartDM={() => {}} onClose={() => {}} />); });
    await settle();
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });

describe('FriendsPanel', () => {
    it('a 409 on Add Friend says "already friends", not the generic failure', async () => {
        api.sendError = new ApiError('Already friends', 409);
        await act(async () => { tab('Add Friend').click(); });
        const input = container.querySelector<HTMLInputElement>('.add-friend-form input')!;
        await setInput(input, 'ann');
        await act(async () => { container.querySelector<HTMLFormElement>('.add-friend-form')!.requestSubmit(); });
        await settle();
        const status = container.querySelector('.add-status.error')?.textContent ?? '';
        expect(status).toMatch(/already friends/i);
        expect(status).not.toBe('Failed to send friend request.');
    });

    it('a failed Accept is shown to the user, not only logged', async () => {
        api.acceptError = new ApiError('Request not found', 404);
        await act(async () => { tab('Pending').click(); });
        const accept = container.querySelector<HTMLButtonElement>('.action-accept')!;
        await act(async () => { accept.click(); });
        await settle();
        const status = container.querySelector('.friends-panel-status')?.textContent ?? '';
        expect(status).toMatch(/Couldn't accept/);
        expect(status).toMatch(/no longer exists/);
        expect(console.error).toHaveBeenCalled();   // the old path still logs; it just no longer ONLY logs
    });

    it('an offline Accept says so', async () => {
        api.acceptError = new TypeError('Failed to fetch');
        await act(async () => { tab('Pending').click(); });
        await act(async () => { container.querySelector<HTMLButtonElement>('.action-accept')!.click(); });
        await settle();
        expect(container.querySelector('.friends-panel-status')?.textContent).toMatch(/offline/i);
    });

    it('the Pending search box filters both directions', async () => {
        // Positive control on the harness: the All tab's search shrinks its list.
        await act(async () => { tab('All').click(); });
        expect(container.querySelectorAll('.friend-row')).toHaveLength(2);
        await setInput(container.querySelector<HTMLInputElement>('.search-bar input')!, 'an');
        expect(container.querySelectorAll('.friend-row')).toHaveLength(1);

        await act(async () => { tab('Pending').click(); });
        expect(container.querySelectorAll('.friend-row')).toHaveLength(3);
        await setInput(container.querySelector<HTMLInputElement>('.pending-section .search-bar input')!, 'da');
        const rows = Array.from(container.querySelectorAll('.friend-row .friend-name')).map(n => n.textContent);
        expect(rows).toEqual(['dave']);
        await setInput(container.querySelector<HTMLInputElement>('.pending-section .search-bar input')!, 'zzz');
        expect(container.querySelector('.empty-state')?.textContent).toMatch(/match/);
    });
});
