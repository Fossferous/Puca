// Which groups of the channel sidebar this device has folded away (localStorage), per server,
// like mutedChannelsStore's Hide Muted Channels: a view choice of THIS person on THIS device,
// never sent to the server and never changing what another member sees.
//
// A group is the Text Channels section ('text'), the Voice Channels section ('voice') or one
// collection ('c<channelId>'). The member list's "Active in your servers" panel keeps its own fold
// here too, under the pseudo-server ALL_SERVERS, since it belongs to no one server.
import { useMemo, useSyncExternalStore } from 'react';

const COLLAPSED_KEY = 'puca_sidebar_collapsed';
const CHANGED = 'sidebarCollapseChanged';

/** The pseudo-server the member list's panel is filed under. */
export const ALL_SERVERS = '*';

export type CollapseKey = 'text' | 'voice' | 'active' | `c${number}`;

type Folded = Record<string, string[]>;

// What could not be written: quota full, blocked site data, a private window. The fold then lasts until
// reload, held here, and is what every read answers with.
let unsaved: string | null = null;

function stored(): string | null {
    if (unsaved !== null) return unsaved;
    try { return localStorage.getItem(COLLAPSED_KEY); } catch { return null; }
}

function read(): Folded {
    try {
        const stored_ = stored();
        const parsed: unknown = stored_ ? JSON.parse(stored_) : {};
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const out: Folded = {};
        for (const [serverId, keys] of Object.entries(parsed as Record<string, unknown>)) {
            if (Array.isArray(keys)) out[serverId] = keys.filter((k): k is string => typeof k === 'string');
        }
        return out;
    } catch {
        return {};
    }
}

/** The folded keys of one server, from the stored text (a pure read, for the tests and the hook). */
export function foldedFrom(raw: string | null, serverId: string): ReadonlySet<string> {
    try {
        const parsed: unknown = raw ? JSON.parse(raw) : {};
        const keys = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)[serverId] : undefined;
        return new Set(Array.isArray(keys) ? keys.filter((k): k is string => typeof k === 'string') : []);
    } catch {
        return new Set();
    }
}

export function isCollapsed(serverId: string, key: CollapseKey): boolean {
    return read()[serverId]?.includes(key) === true;
}

/** Fold or unfold one group; returns whether it is folded now. */
export function toggleCollapsed(serverId: string, key: CollapseKey): boolean {
    const all = read();
    const keys = new Set(all[serverId] ?? []);
    const next = !keys.has(key);
    if (next) keys.add(key); else keys.delete(key);
    if (keys.size > 0) all[serverId] = [...keys]; else delete all[serverId];
    const raw = JSON.stringify(all);
    try { localStorage.setItem(COLLAPSED_KEY, raw); unsaved = null; } catch { unsaved = raw; }
    window.dispatchEvent(new CustomEvent(CHANGED, { detail: { serverId, key, collapsed: next } }));
    return next;
}

function subscribe(callback: () => void): () => void {
    const onStorage = (e: StorageEvent) => { if (e.key === null || e.key === COLLAPSED_KEY) callback(); };
    window.addEventListener(CHANGED, callback);
    window.addEventListener('storage', onStorage);
    return () => {
        window.removeEventListener(CHANGED, callback);
        window.removeEventListener('storage', onStorage);
    };
}

function snapshot(): string {
    return stored() ?? '';
}

/** The folded keys of one server, live: another tab's fold and this tab's both re-render the caller. */
export function useCollapsed(serverId: string | null | undefined): ReadonlySet<string> {
    const raw = useSyncExternalStore(subscribe, snapshot, () => '');
    return useMemo(() => foldedFrom(raw || null, serverId ?? ''), [raw, serverId]);
}

/** The collections folded among a server's keys. */
export function foldedCollections(keys: ReadonlySet<string>): Set<number> {
    const out = new Set<number>();
    for (const k of keys) {
        const m = /^c(\d+)$/.exec(k);
        if (m) out.add(Number(m[1]));
    }
    return out;
}
