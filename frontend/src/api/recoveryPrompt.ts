/**
 * One-shot hand-off for a freshly-generated recovery code.
 *
 * register() and Settings' "Regenerate recovery code" generate a recovery
 * phrase that must be shown to the user exactly once. They stash it here; the
 * authed layout's RecoveryCodeModal consumes and displays it. Deliberately NOT
 * persisted — the whole point is that the user writes it down, not that the
 * device keeps it.
 *
 * What IS persisted is whether the user ever CONFIRMED saving one. The phrase
 * lived only in this variable, so a reload before the modal's checkbox — a
 * refresh, an Android WebView restart, a failed auto-login straight after
 * registering — destroyed it with no second chance, and nothing ever said so.
 * The marker below survives that reload; RecoveryCodeModal then points the
 * user at Settings, where a new code can be generated (0.9.2).
 *
 * The phrase belongs to ONE account, and only that account's session is shown
 * it. A registration whose automatic sign-in failed left it here with the
 * sign-in form on screen, and whoever signed in next on that form, as anybody,
 * was shown it: the code that unlocks the first account's keys. And a sign-out
 * (which reloads nothing) takes it away.
 */
import { registerLogoutCleanup } from './logoutHooks';

let pending: { code: string; owner: string | null } | null = null;

const UNACKED_KEY = 'recovery_code_unacked_v1';
/** Per-tab "later" so the reminder is not a nag on every navigation. */
const SNOOZED_KEY = 'recovery_code_snoozed_v1';

/** Usernames compare as the server compares them: without case. */
function ownerOf(account: string | null | undefined): string | null {
    const a = account?.trim().toLowerCase();
    return a ? a : null;
}

/** register(): the code of the account `account` (its username), shown only
 *  to a session signed in as that account. */
export function setPendingRecoveryCode(code: string, account?: string): void {
    pending = { code, owner: ownerOf(account) };
}

/** Same hand-off, from Settings: show this code through the modal. */
export function showRecoveryCode(code: string, account?: string): void {
    pending = { code, owner: ownerOf(account) };
    markRecoveryCodeUnacknowledged();
}

/**
 * The code waiting for `account` (the signed-in username), once. A code made
 * for another account is not handed over, and stays for its own account's
 * sign-in; one made without an account goes to whoever asks.
 */
export function consumePendingRecoveryCode(account?: string | null): string | null {
    if (!pending) return null;
    if (pending.owner !== null && pending.owner !== ownerOf(account)) return null;
    const c = pending.code;
    pending = null;
    return c;
}

registerLogoutCleanup(() => { pending = null; });

export function markRecoveryCodeUnacknowledged(): void {
    try { localStorage.setItem(UNACKED_KEY, '1'); } catch { /* private mode */ }
    try { sessionStorage.removeItem(SNOOZED_KEY); } catch { /* storage unavailable */ }
}

/** The user confirmed they saved it (or explicitly said they have one). */
export function acknowledgeRecoveryCode(): void {
    try { localStorage.removeItem(UNACKED_KEY); } catch { /* private mode */ }
    try { sessionStorage.removeItem(SNOOZED_KEY); } catch { /* storage unavailable */ }
}

/** Not now — ask again in a fresh tab/session, not on the next render. */
export function snoozeRecoveryCodeReminder(): void {
    try { sessionStorage.setItem(SNOOZED_KEY, '1'); } catch { /* storage unavailable */ }
}

/** A code was generated on this device and never confirmed as saved. */
export function recoveryCodeReminderDue(): boolean {
    try {
        return localStorage.getItem(UNACKED_KEY) === '1' && sessionStorage.getItem(SNOOZED_KEY) !== '1';
    } catch {
        return false;
    }
}
