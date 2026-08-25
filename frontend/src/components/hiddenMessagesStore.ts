/**
 * "Delete for Me" — messages hidden locally, for THIS account on THIS device.
 *
 * Deliberately not server-state: hiding is a personal view preference over
 * content that still exists for everyone else (the WhatsApp model). It works
 * on ANY message — yours, someone else's, channel or DM — because it deletes
 * nothing; "delete for everyone" is the separate, permission-gated path.
 *
 * Per-ACCOUNT key (unlike the muted stores): two accounts sharing a device
 * must not inherit each other's hidden messages — a hidden message is
 * invisible in a way a muted channel is not, and "someone else's hide"
 * would read as data loss.
 *
 * Same module shape as mutedChannelsStore: localStorage + guarded parse +
 * CustomEvent fan-out, consumers re-read at render time.
 */

import { currentAccountKey } from './blockStore';

const BASE_KEY = 'sovereign_hidden_messages';

// The account key is derived by base64+JSON-parsing the JWT; doing that once
// per message per render defeats the point of the blob cache below. Keyed on
// the RAW token string, so login/logout/account-switch (a different string)
// re-derives — memoizing on anything less would leak one account's hidden
// set into the next session's view.
let keyCache: { token: string | null; key: string } | null = null;

function storageKey(): string {
    let token: string | null = null;
    try { token = localStorage.getItem('auth_token'); } catch { /* unreadable = anon */ }
    if (keyCache && keyCache.token === token) return keyCache.key;
    const key = `${BASE_KEY}:${currentAccountKey()}`;
    keyCache = { token, key };
    return key;
}

// Parsed-blob cache: isMessageHidden runs once per message per render, and a
// JSON.parse per call would tax every paint of a 50-message page. Keyed on the
// storage key so an account switch naturally misses.
let cache: { key: string; map: Record<string, true> } | null = null;

function readHidden(): Record<string, true> {
    const key = storageKey();
    if (cache?.key === key) return cache.map;
    let map: Record<string, true> = {};
    try {
        const raw = localStorage.getItem(key);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                map = parsed as Record<string, true>;
            }
        }
    } catch {
        // Unreadable blob: treat as nothing hidden rather than crash a render.
    }
    cache = { key, map };
    return map;
}

function writeHidden(map: Record<string, true>, changedId: string, hidden: boolean): void {
    cache = { key: storageKey(), map };
    try {
        localStorage.setItem(storageKey(), JSON.stringify(map));
    } catch {
        // Storage unavailable; the change still applies for this session via
        // the cache + the event below.
    }
    window.dispatchEvent(new CustomEvent('hiddenMessagesChanged', {
        detail: { messageId: changedId, hidden },
    }));
}

// Another TAB of the same account hid/unhid something: drop the cache and
// re-render. (The `storage` event only fires in OTHER tabs.)
if (typeof window !== 'undefined') {
    window.addEventListener('storage', (e) => {
        if (e.key !== null && !e.key.startsWith(BASE_KEY)) return;
        cache = null;
        window.dispatchEvent(new CustomEvent('hiddenMessagesChanged', {
            detail: { messageId: null, hidden: null },
        }));
    });
}

/** Tests wipe localStorage between cases; the caches must go with it. */
export function _resetHiddenMessagesCacheForTests(): void {
    cache = null;
    keyCache = null;
}

export function isMessageHidden(messageId: string): boolean {
    return readHidden()[String(messageId)] === true;
}

/** How many messages this account has hidden on this device. */
export function hiddenMessageCount(): number {
    return Object.keys(readHidden()).length;
}

/** The durable escape hatch: the Undo toast is transient (and evictable by
 *  newer toasts), so Settings offers restore-all — an irreversible-feeling
 *  action must have a recovery path that outlives a 6-second window. */
export function clearAllHiddenMessages(): number {
    const count = Object.keys(readHidden()).length;
    if (count === 0) return 0;
    writeHidden({}, '*', false);
    return count;
}

export function hideMessage(messageId: string): void {
    const map = readHidden();
    map[String(messageId)] = true;
    writeHidden(map, String(messageId), true);
}

/** The Undo path. Absent ids are a no-op. */
export function unhideMessage(messageId: string): void {
    const map = readHidden();
    if (!(String(messageId) in map)) return;
    delete map[String(messageId)];
    writeHidden(map, String(messageId), false);
}
