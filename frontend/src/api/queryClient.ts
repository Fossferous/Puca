import { QueryClient } from '@tanstack/react-query';
import { registerLogoutCleanup } from './logoutHooks';

export const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            staleTime: 1000 * 60 * 5, // 5 minutes
            gcTime: 1000 * 60 * 30, // 30 minutes
            retry: 1,
            refetchOnWindowFocus: false,
        },
    },
});

// Everything cached here was read as the account that signs out: its servers, every server's
// channel list (the names "Active in your servers" goes by), members, roles. A sign-out reloads
// nothing, so the next account signed in on this running app was drawn the last one's lists, fresh
// for five minutes, until each was read again.
registerLogoutCleanup(() => queryClient.clear());
