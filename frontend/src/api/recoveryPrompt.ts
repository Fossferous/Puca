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
 * The marker is the account's too, kept per username like the code's owner.
 * One marker for the whole device told whoever signed in next that THEIR code
 * was never saved, whenever no code of their own turned up, and their "I
 * already saved it" removed the warning of the account it was for. That
 * account's code was being kept from them on purpose (below), so exactly when
 * the code was right to stay hidden the reminder went to the wrong person.
 * It outlives a sign-out, as before: it is that account's only warning until
 * it signs in again.
 *
 * The phrase belongs to ONE account, and only that account's session is shown
 * it. A registration whose automatic sign-in failed left it here with the
 * sign-in form on screen, and whoever signed in next on that form, as anybody,
 * was shown it: the code that unlocks the first account's keys. And a sign-out
 * (which reloads nothing) takes it away.
 */
import { registerLogoutCleanup } from './logoutHooks';

let pending: { code: string; owner: string | null } | null = null;

/** The accounts (as ownerOf spells them) with a code generated on this device
 *  and never confirmed saved: a JSON array in localStorage. */
const UNACKED_KEY = 'recovery_code_unacked_v2';
/** The device-wide marker before it had an owner ('1'). The first account
 *  asked about takes it over (recoveryCodeReminderDue), as it was then shown
 *  to whoever signed in. */
const LEGACY_UNACKED_KEY = 'recovery_code_unacked_v1';
/** Per-tab "later", per account, so the reminder is not a nag on every
 *  navigation: a JSON array in sessionStorage. (The device-wide
 *  'recovery_code_snoozed_v1' dies with its tab, and is not read.) */
const SNOOZED_KEY = 'recovery_code_snoozed_v2';

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
    markRecoveryCodeUnacknowledged(account);
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

// A sign-out takes it. Somebody else signing in after a session ran out
// (api/logoutHooks.ts, 'account-change') takes only one bound to no account,
// which was made in the last account's session: one bound to an account is
// handed to nobody else, and that sign-in may be the very one that follows the
// registration it was made for.
registerLogoutCleanup((reason) => {
    if (reason === 'sign-out' || pending?.owner === null) pending = null;
});

function readOwners(storage: Storage, key: string): string[] {
    const raw = storage.getItem(key);
    if (!raw) return [];
    try {
        const v: unknown = JSON.parse(raw);
        return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    } catch {
        return [];
    }
}

function addOwner(storage: Storage, key: string, owner: string): void {
    const list = readOwners(storage, key);
    if (!list.includes(owner)) storage.setItem(key, JSON.stringify([...list, owner]));
}

function removeOwner(storage: Storage, key: string, owner: string): void {
    const list = readOwners(storage, key);
    if (!list.includes(owner)) return;
    const rest = list.filter(o => o !== owner);
    if (rest.length) storage.setItem(key, JSON.stringify(rest));
    else storage.removeItem(key);
}

/** A code was just made for `account` and has not been confirmed saved yet.
 *  Without an account it is the device-wide marker, which goes to the first
 *  account asked about, as a code made without one goes to whoever asks. */
export function markRecoveryCodeUnacknowledged(account?: string | null): void {
    const owner = ownerOf(account);
    try {
        if (owner) addOwner(localStorage, UNACKED_KEY, owner);
        else localStorage.setItem(LEGACY_UNACKED_KEY, '1');
    } catch { /* private mode */ }
    if (owner) {
        try { removeOwner(sessionStorage, SNOOZED_KEY, owner); } catch { /* storage unavailable */ }
    }
}

/** `account` confirmed they saved it (or explicitly said they have one).
 *  Another account's marker stays. */
export function acknowledgeRecoveryCode(account?: string | null): void {
    const owner = ownerOf(account);
    if (!owner) return;
    try { removeOwner(localStorage, UNACKED_KEY, owner); } catch { /* private mode */ }
    try { removeOwner(sessionStorage, SNOOZED_KEY, owner); } catch { /* storage unavailable */ }
}

/** Not now, for `account`: ask again in a fresh tab/session, not on the next render. */
export function snoozeRecoveryCodeReminder(account?: string | null): void {
    const owner = ownerOf(account);
    if (!owner) return;
    try { addOwner(sessionStorage, SNOOZED_KEY, owner); } catch { /* storage unavailable */ }
}

/** A code was generated on this device for `account` (the signed-in
 *  username) and never confirmed as saved. Nobody signed in is owed nothing. */
export function recoveryCodeReminderDue(account?: string | null): boolean {
    const owner = ownerOf(account);
    if (!owner) return false;
    try {
        if (localStorage.getItem(LEGACY_UNACKED_KEY) === '1') {
            addOwner(localStorage, UNACKED_KEY, owner);
            localStorage.removeItem(LEGACY_UNACKED_KEY);
        }
        return readOwners(localStorage, UNACKED_KEY).includes(owner)
            && !readOwners(sessionStorage, SNOOZED_KEY).includes(owner);
    } catch {
        return false;
    }
}
