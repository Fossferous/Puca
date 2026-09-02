/**
 * `/invite/:code` — where an invite link lands.
 *
 * Nothing renders here. The code is stashed (api/pendingInvite) and the
 * visitor is sent on: signed in, straight to /chat, which opens the join
 * flow with the code looked up; signed out, to /login, which mentions the
 * waiting invite and hands it on after sign-in or registration. A malformed
 * code falls through to the ordinary landing route.
 */
import { useEffect } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { isAuthenticated } from '../api/auth';
import { parseInviteCode, stashPendingInvite } from '../api/pendingInvite';

export function InviteLanding() {
    const { code: raw } = useParams<{ code: string }>();
    const code = parseInviteCode(raw ?? '');
    // Stash in an effect, not during render: React may render this twice
    // (StrictMode) and rendering must stay side-effect free.
    useEffect(() => {
        if (code) stashPendingInvite(code);
    }, [code]);
    if (!code) return <Navigate to="/" replace />;
    return <Navigate to={isAuthenticated() ? '/chat' : '/login'} replace />;
}
