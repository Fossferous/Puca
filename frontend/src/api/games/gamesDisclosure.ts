/**
 * "Chips are free and worth nothing. This server deals the cards and its
 * operator could see them." — shown before a person's FIRST GameSit
 * (docs/GAMES.md, *Trust*). The server does not track it; this device
 * remembers that it was acknowledged, per account and per server, because
 * "its operator" is a different operator on every server.
 */
const KEY = 'puca.games.disclosure.v1';

function read(): Record<string, true> {
    try {
        const raw = localStorage.getItem(KEY);
        const v = raw ? JSON.parse(raw) : {};
        return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch {
        return {};
    }
}

const id = (userId: number, serverId: string) => `${userId}:${serverId}`;

export function disclosureSeen(userId: number, serverId: string): boolean {
    return read()[id(userId, serverId)] === true;
}

export function markDisclosureSeen(userId: number, serverId: string): void {
    try {
        const all = read();
        all[id(userId, serverId)] = true;
        localStorage.setItem(KEY, JSON.stringify(all));
    } catch {
        // Storage refused (private mode, quota): the disclosure simply shows
        // again next time, which errs the right way.
    }
}
