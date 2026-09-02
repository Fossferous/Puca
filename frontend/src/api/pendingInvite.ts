/**
 * Invite links: building them, reading them back, and carrying one across the
 * sign-in / sign-up detour.
 *
 * A link is `<appUrl>/invite/<code>`, where appUrl is the web app's PUBLIC
 * address from `GET /config` — never `window.location.origin`, which in the
 * desktop app is `http://tauri.localhost` and in the Android app
 * `https://localhost`. Until 0.9.2 every client copied exactly that, so the
 * owner's first invite was a link nobody could open. When the operator has
 * not configured APP_URL there is no link to build; the bare code is what
 * gets shared, and "Join a Server" accepts it as-is.
 *
 * Opening `/invite/<code>` in the web app lands on InviteLanding, which
 * stashes the code here and sends the visitor to sign in (or register). Chat
 * consumes it on its first render and opens the join flow with the code
 * already looked up. sessionStorage on purpose: it survives the reloads a
 * registration round-trip involves, and dies with the tab, so a code cannot
 * resurface days later for a different account on a shared browser.
 */

const KEY = 'puca_pending_invite_v1';

/** Server-issued codes are short and URL-safe; anything else is not a code. */
const CODE = /^[A-Za-z0-9_-]{4,64}$/;

/** Build the shareable link, or null when the web app's address is unknown. */
export function inviteLink(code: string, appUrl: string | null): string | null {
    if (!appUrl) return null;
    return `${appUrl.replace(/\/+$/, '')}/invite/${encodeURIComponent(code)}`;
}

/**
 * The code inside whatever the user pasted: a full link (any host — links
 * copied from a pre-0.9.2 desktop carry tauri.localhost and must still
 * work), a bare code, or junk (⇒ null). Trailing slashes and query strings
 * are tolerated because chat apps and phones add them.
 */
export function parseInviteCode(input: string): string | null {
    let s = input.trim();
    if (!s) return null;
    const at = s.toLowerCase().lastIndexOf('/invite/');
    if (at >= 0) s = s.slice(at + '/invite/'.length);
    s = s.split(/[?#]/)[0].replace(/\/+$/, '');
    try { s = decodeURIComponent(s); } catch { /* keep as typed */ }
    return CODE.test(s) ? s : null;
}

export function stashPendingInvite(code: string): void {
    try { sessionStorage.setItem(KEY, code); } catch { /* storage unavailable */ }
}

export function peekPendingInvite(): string | null {
    try { return sessionStorage.getItem(KEY); } catch { return null; }
}

/** One-shot read: the consumer that acts on it clears it. */
export function consumePendingInvite(): string | null {
    const c = peekPendingInvite();
    if (c !== null) {
        try { sessionStorage.removeItem(KEY); } catch { /* storage unavailable */ }
    }
    return c;
}
