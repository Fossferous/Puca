// Shared blocked-users store.
//
// The server enforces blocks on every DM path, but SERVER-CHANNEL messages
// and voice are E2EE fan-outs the server can't police per-recipient — hiding
// a blocked member's messages and muting their voice is the client's job.
// Until this store existed, listBlocked() was only ever called inside the
// Settings panel, so nothing else in the app knew who was blocked and blocks
// visibly "didn't work" outside DMs.
//
// Module-level cache + CustomEvent fan-out, same shape as avatarPrefs. Loaded
// once after login (Chat mount) and updated optimistically by the block/
// unblock call sites; a Settings re-list refreshes it wholesale.
import { useEffect, useState } from 'react';
import { listBlocked, type BlockedUser } from '../api/blocking';
import { setLocalUserMute } from './userVolumeStore';

let blockedIds = new Set<number>();
let loaded = false;

function emit() {
    window.dispatchEvent(new CustomEvent('blockedUsersChanged'));
}

/** Fetch the authoritative list AND sync the shared set. Throws on failure so
 *  callers with a UI (Settings) can show the error — the in-memory set keeps
 *  its previous value, because an error must not masquerade as "nobody is
 *  blocked". */
export async function fetchBlockedUsers(): Promise<BlockedUser[]> {
    const list = await listBlocked();
    blockedIds = new Set(list.map(b => b.user_id));
    loaded = true;
    // One-time migration: blocks made before the voice tie-in existed never
    // got their local mute. Run once per ACCOUNT — the guard used to be a
    // single device-global key, so on a shared device only the first account
    // to sign in ever got its backfill. After that first run the mute store is
    // left alone: someone who deliberately unmutes a person they blocked must
    // not be re-muted on every app start.
    try {
        const key = `sovereign_block_mute_backfill_v1:${currentAccountKey()}`;
        if (!localStorage.getItem(key)) {
            for (const id of blockedIds) setLocalUserMute(id, true);
            localStorage.setItem(key, 'done');
        }
    } catch { /* storage unavailable — new blocks still mute at block time */ }
    emit();
    return list;
}

/** Identify the signed-in account for per-account localStorage keys. Falls
 *  back to a constant when no token is readable — worst case the backfill
 *  behaves as it did before (device-global). Exported for other per-account
 *  stores (hiddenMessagesStore) so the key convention stays single-sourced. */
export function currentAccountKey(): string {
    try {
        const token = localStorage.getItem('auth_token');
        if (!token) return 'anon';
        const claims = JSON.parse(atob(token.split('.')[1] ?? ''));
        return String(claims?.sub ?? 'anon');
    } catch {
        return 'anon';
    }
}

/** Fire-and-forget variant for app start / reconnect. Retries a few times:
 *  a single failed load used to leave `blockedIds` empty for the whole
 *  session, silently disabling message hiding, notification suppression and
 *  the voice mute — blocking would look completely broken until reload. */
export async function loadBlockedUsers(attempt = 0): Promise<void> {
    try {
        await fetchBlockedUsers();
    } catch {
        if (attempt < 4) {
            const delay = 2000 * 2 ** attempt; // 2s, 4s, 8s, 16s
            setTimeout(() => { void loadBlockedUsers(attempt + 1); }, delay);
        } else {
            console.error('[blockStore] could not load the blocked list; block enforcement is inactive until reload');
        }
    }
}

/**
 * Drop all block state. MUST be called on logout: this is module-level state
 * and logout does not reload the page, so without it the next account to sign
 * in on the same running app inherits the previous account's blocked ids —
 * hiding messages from people they never blocked.
 */
export function clearBlockedUsers(): void {
    blockedIds = new Set();
    loaded = false;
    emit();
}

export function isBlocked(userId: number): boolean {
    return blockedIds.has(userId);
}

export function getBlockedIds(): ReadonlySet<number> {
    return blockedIds;
}

export function blockedListLoaded(): boolean {
    return loaded;
}

/**
 * Optimistic local update after a successful block/unblock API call. Also
 * drives the voice tie-in: blocking someone mutes their audio locally (both
 * mesh and SFU honour the local mute store), unblocking restores it.
 */
export function setBlockedLocal(userId: number, blocked: boolean): void {
    const next = new Set(blockedIds);
    if (blocked) next.add(userId); else next.delete(userId);
    blockedIds = next;
    setLocalUserMute(userId, blocked);
    emit();
}

/** React view of the blocked set; re-renders on any change. */
export function useBlockedUsers(): ReadonlySet<number> {
    const [ids, setIds] = useState<ReadonlySet<number>>(blockedIds);
    useEffect(() => {
        const sync = () => setIds(blockedIds);
        window.addEventListener('blockedUsersChanged', sync);
        // The set may have loaded between render and effect — resync once.
        sync();
        return () => window.removeEventListener('blockedUsersChanged', sync);
    }, []);
    return ids;
}
