/**
 * Púca Notes — forgetting the colour and labels of notes that are really gone.
 *
 * A note deleted OUTSIDE Notes (Púca's Tasks view, a removed checklist
 * channel, a server left) never passes through Notes' own delete, so its
 * colour, labels and archive flag would sit in the account's sealed document
 * forever and walk it toward the 256 KiB cap. But one device's momentary view
 * is not proof a note is gone: a note created elsewhere a second ago, a
 * channel query that failed, or a note moved to the trash all look "missing".
 *
 * So a key is forgotten only once it has been missing from TWO settled,
 * complete fetches of the kind that would list it (a personal list from two
 * list fetches, a checklist from two channel fetches), at least a grace
 * period apart — a fetch that began before a note existed cannot count
 * twice — and, for a personal list, once the trash has been asked and does
 * not hold it either (the caller confirms that; see useNoteCards). Only
 * fetches made during this page's lifetime count: a view built from the
 * device cache (notesCache.ts hydrates it with its OLD fetch time) is never
 * a strike, so the first strike is always a fresh fetch.
 */

export const PRUNE_GRACE_MS = 60_000;

export interface PruneState {
    /** Key -> the fetch generation and time it was first seen missing. */
    strikes: Map<string, { gen: number; at: number }>;
    /** When this page started (or the account changed): a view whose data
     *  was fetched before this — the hydrated device cache — strikes nothing. */
    since: number;
}

export function newPruneState(since: number = Date.now()): PruneState {
    return { strikes: new Map(), since };
}

export interface PruneGens {
    /** When the personal lists were last fetched (react-query dataUpdatedAt). */
    list: number;
    /** When the checklist channels were last fetched (the newest of them). */
    channel: number;
    /** The OLDEST fetch behind the checklist view (servers and every
     *  channel query): the view is this page's own only once this is. */
    channelOldest?: number;
}

/**
 * Record this settled, complete view and return the keys that have now been
 * missing across two fetches, a grace period apart. Mutates `state`.
 */
export function pruneStep(
    state: PruneState,
    gens: PruneGens,
    now: number,
    present: ReadonlySet<string>,
    stored: ReadonlySet<string>,
    graceMs: number = PRUNE_GRACE_MS,
): string[] {
    for (const k of [...state.strikes.keys()]) {
        if (!stored.has(k) || present.has(k)) state.strikes.delete(k);
    }
    const out: string[] = [];
    const fresh = {
        list: gens.list >= state.since,
        channel: (gens.channelOldest ?? gens.channel) >= state.since,
    };
    for (const k of stored) {
        if (present.has(k)) continue;
        const isChannel = k.startsWith('channel:');
        if (!fresh[isChannel ? 'channel' : 'list']) continue;   // cached, not fetched here
        const gen = isChannel ? gens.channel : gens.list;
        const strike = state.strikes.get(k);
        if (!strike) {
            state.strikes.set(k, { gen, at: now });
        } else if (strike.gen !== gen && now - strike.at >= graceMs) {
            out.push(k);
        }
    }
    return out;
}
