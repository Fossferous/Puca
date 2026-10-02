/**
 * Every status render reads the presence store, and shows idle and away.
 *
 *  - PresenceDot: online green, idle the idle token, away the zzz badge in the
 *    same colour; each with a spoken name ("Idle", "Away"), because colour
 *    alone says nothing to a screen reader or a colour-blind eye.
 *  - FriendsPanel had NO live presence before the store (a 15 s poll only):
 *    a pushed UserStatus / UserOffline must repaint it at once — positive
 *    control: the first assertion fails on the old component.
 *  - UserProfilePopup is opened with a SNAPSHOT of the member row; its status
 *    line must follow the store, not that snapshot.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const api = vi.hoisted(() => ({
    friends: [] as Array<{ id: number; username: string; is_online: boolean; status?: string; since: string }>,
}));
vi.mock('../api/friends', () => ({
    listFriends: async () => api.friends,
    listIncomingRequests: async () => [],
    listOutgoingRequests: async () => [],
    sendFriendRequest: async () => {},
    acceptFriendRequest: async () => {},
    rejectFriendRequest: async () => {},
    removeFriend: async () => {},
    getFriendshipStatus: async () => ({ is_friend: true, request_sent: false, request_received: false, request_id: null }),
}));
vi.mock('../api/dms', () => ({
    listDMConversations: async () => [],
    startDMConversation: async () => ({ id: 1 }),
    searchUsers: async () => [],
    getCachedPublicKey: async () => null,
}));
vi.mock('../api/servers', () => ({
    listRoles: async () => [],
    assignRole: async () => {},
    removeRole: async () => {},
    kickMember: async () => {},
    banMember: async () => {},
}));
vi.mock('../api/keyVerification', () => ({ getVerificationState: async () => 'unverified' }));
vi.mock('../components/TasksView', () => ({ TasksView: () => null }));
vi.mock('../components/HomeSidebar', () => ({ HomeSidebar: () => null }));

const { FriendsPanel } = await import('../components/FriendsPanel');
const { PresenceDot } = await import('../components/PresenceDot');
const { UserProfilePopup } = await import('../components/UserProfilePopup');
const { applyPresenceFrame, __resetPresenceForTests } = await import('../api/presenceStore');

let container: HTMLDivElement;
let root: Root;
const settle = async () => { await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };
const push = async (type: string, payload: object) => {
    await act(async () => { applyPresenceFrame({ type, payload: payload as Record<string, unknown> }); });
};

beforeEach(() => {
    __resetPresenceForTests();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });

describe('PresenceDot', () => {
    it.each([
        ['online', 'Online', false],
        ['idle', 'Idle', false],
        ['away', 'Away', true],
        ['offline', 'Offline', false],
    ] as const)('%s: class, spoken name, and the zzz badge only for away', async (status, label, badge) => {
        await act(async () => { root.render(<PresenceDot status={status} />); });
        const el = container.querySelector('.presence-dot')!;
        expect(el.classList.contains(`is-${status}`)).toBe(true);
        expect(el.getAttribute('aria-label')).toBe(label);
        expect(el.getAttribute('title')).toBe(label);
        expect(el.querySelector('svg') !== null).toBe(badge);
    });
});

describe('FriendsPanel follows pushed presence live', () => {
    beforeEach(async () => {
        api.friends = [
            { id: 2, username: 'ann', is_online: true, since: '' },
            { id: 3, username: 'bob', is_online: true, status: 'away', since: '' },
        ];
        await act(async () => { root.render(<FriendsPanel onStartDM={() => {}} onClose={() => {}} />); });
        await settle();
    });

    const row = (name: string) =>
        Array.from(container.querySelectorAll('.friend-row')).find(r => r.textContent?.includes(name)) ?? null;

    it('shows the REST status first (bob away), then a pushed idle for ann', async () => {
        expect(row('bob')!.querySelector('.friend-status')!.textContent).toBe('Away');
        expect(row('bob')!.querySelector('.presence-dot.is-away')).not.toBeNull();
        expect(row('ann')!.querySelector('.friend-status')!.textContent).toBe('Online');

        await push('UserStatus', { user_id: 2, status: 'idle' });
        expect(row('ann')!.querySelector('.friend-status')!.textContent).toBe('Idle');
        expect(row('ann')!.querySelector('.presence-dot.is-idle')).not.toBeNull();
    });

    it('a pushed UserOffline drops the friend from Online at once, no poll needed', async () => {
        await push('UserOffline', { user_id: 2 });
        expect(row('ann')).toBeNull();
        expect(container.querySelector('.section-header')!.textContent).toContain('1');
        await push('UserOnline', { user: { id: 2, username: 'ann' } });
        expect(row('ann')).not.toBeNull();
    });
});

describe('UserProfilePopup reads the store, not its snapshot', () => {
    it('says Away when the store says away, though the row it was opened with said online', async () => {
        const member = {
            id: 4, username: 'cat', is_online: true, roles: [], top_role_color: '#fff', is_owner: false,
            custom_sounds_disabled: false,
        };
        await act(async () => {
            root.render(
                <UserProfilePopup
                    member={member}
                    serverId="s"
                    isOwner={false}
                    currentUserId={1}
                    position={{ x: 0, y: 0 }}
                    onClose={() => {}}
                    onRolesUpdated={() => {}}
                    onStartDM={() => {}}
                />,
            );
        });
        await settle();
        const status = () => container.querySelector('.upp-status')!;
        expect(status().textContent).toBe('Online');
        await push('UserStatus', { user_id: 4, status: 'away' });
        expect(status().textContent).toBe('Away');
        expect(status().classList.contains('away')).toBe(true);
        await push('UserOffline', { user_id: 4 });
        expect(status().textContent).toBe('Offline');
    });
});
