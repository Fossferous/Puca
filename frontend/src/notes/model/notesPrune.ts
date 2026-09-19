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
 * not hold it either (the caller confirms that; see useNoteCards).
 */

export const PRUNE_GRACE_MS = 60_000;

export interface PruneState {
    /** Key -> the fetch generation and time it was first seen missing. */
    strikes: Map<string, { gen: number; at: number }>;
}

export function newPruneState(): PruneState {
    return { strikes: new Map() };
}

export interface PruneGens {
    /** When the personal lists were last fetched (react-query dataUpdatedAt). */
    list: number;
    /** When the checklist channels were last fetched (the newest of them). */
    channel: number;
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
    for (const k of stored) {
        if (present.has(k)) continue;
        const gen = k.startsWith('channel:') ? gens.channel : gens.list;
        const strike = state.strikes.get(k);
        if (!strike) {
            state.strikes.set(k, { gen, at: now });
        } else if (strike.gen !== gen && now - strike.at >= graceMs) {
            out.push(k);
        }
    }
    return out;
}
