/**
 * History-merge rule shared by the channel and DM reconnect catch-up in Chat.tsx.
 *
 * Extracted so the rule itself is assertable: it is the part of the catch-up
 * with real decisions in it, and getting it wrong deletes user messages rather
 * than merely failing to add one.
 */

/**
 * Fold freshly-fetched history into what is already on screen, ADDITIVELY: rows
 * whose id is already present are left exactly as they are, and nothing is ever
 * removed.
 *
 * Purely additive is the whole point, not laziness. Replacing state with the
 * fetched page would delete three things that legitimately are not in it:
 *
 *  - the unacked `local_` bubble for a message sent while the socket was down,
 *  - older pages the user loaded by scrolling back (the channel loader appends
 *    beyond the 50-row window it initially fetches),
 *  - anything that arrived over the socket while this fetch was in flight.
 *
 * Being additive also means a catch-up can never resurrect a message deleted
 * server-side, because deletion is expressed by ABSENCE from the fetched page
 * and absence is never acted on here.
 *
 * Returns `prev` by reference when nothing is missing, so a catch-up that finds
 * no gap does not re-render the message list.
 */
export function mergeMissing<T>(
    prev: T[],
    fetched: T[],
    idOf: (m: T) => string,
    sortKey: (m: T) => number,
): T[] {
    const have = new Set(prev.map(idOf));
    const missing = fetched.filter(m => !have.has(idOf(m)));
    if (missing.length === 0) return prev;
    return [...prev, ...missing].sort((a, b) => sortKey(a) - sortKey(b));
}
