// @vitest-environment jsdom
/**
 * A sign-out empties the app's query cache and the shared voice roster.
 *
 * A sign-out reloads nothing (api/auth.ts logout, App.tsx handleLogout), so
 * what is cached in the running app outlives the account that read it. Two
 * caches were left behind (0.9.859 review, sidebar lows): the TanStack query
 * client (every server's channel list, the names "Active in your servers"
 * goes by; members; roles), fresh for five minutes, and voiceState's
 * globalVoiceUsers, which activeServers.ts fills for servers that are not
 * open. The next account signed in on this running app was drawn the last
 * one's lists and calls. Both now register a sign-out cleanup
 * (api/logoutHooks.ts), which logout() runs; this goes through logout().
 */
import { describe, it, expect, vi } from 'vitest';
import { logout } from '../api/auth';
import { queryClient } from '../api/queryClient';
import { keys } from '../hooks/queries';
import { globalVoiceUsers, subscribeToVoiceUsers, type VoiceUserStatus } from '../components/voiceState';

describe('a sign-out', () => {
    it("empties the query cache: no server's channel list is left for the next account", () => {
        queryClient.setQueryData(keys.channels('s2'), [{ id: 20, name: 'Arena', channel_type: 1, server_id: 's2' }]);
        queryClient.setQueryData(['servers'], [{ id: 's2', name: 'Theirs' }]);
        // Positive control: they really are cached before.
        expect(queryClient.getQueryData(keys.channels('s2'))).toBeTruthy();
        logout();
        expect(queryClient.getQueryData(keys.channels('s2'))).toBeUndefined();
        expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    });

    it("empties the shared voice roster (other servers' calls too), and tells whoever draws it", () => {
        globalVoiceUsers.set('voice_20', new Map([[5, { id: 5, username: 'dee' } as VoiceUserStatus]]));
        globalVoiceUsers.set('voice_31', new Map([[6, { id: 6, username: 'eve' } as VoiceUserStatus]]));
        const heard = vi.fn();
        const off = subscribeToVoiceUsers(heard);
        expect(globalVoiceUsers.size, 'positive control').toBe(2);
        logout();
        off();
        expect(globalVoiceUsers.size).toBe(0);
        expect(heard).toHaveBeenCalled();
    });
});
