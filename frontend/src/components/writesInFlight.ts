/**
 * The writes a task view has out, so a Refresh the person asks for cannot
 * put an older copy of a list over what they have just done.
 *
 * Every change in these views is optimistic: the row changes on screen
 * first and the request follows — sealed first, so it can leave AFTER a read
 * that was asked for later. A read that races one answers with the server's
 * copy from before it, and putting that on screen quietly undoes the change
 * (the tick comes back, an edited item gets its old words) until the list
 * is read again. Refresh straight after editing an item is the ordinary way
 * to get there: the tap takes the focus out of the item, which saves it, and
 * the read goes out behind the save.
 *
 * So a refresh waits for the writes that are out (`settled`) and then reads,
 * and its answer is dropped if another write started while it was out
 * (`since`): what is on screen is newer than that answer. Púca Notes keeps
 * the same rule through its query cache (notes/model/notesQueries.ts,
 * `snapshot`, which cancels a read in flight when a write starts).
 *
 * Creates count too: an item that lands after an answer that already holds
 * it would be added to the screen a second time.
 *
 * The wait is BOUNDED (`SAVE_WAIT_MS`). Nothing here times a request out, so
 * a save on a connection that has gone quiet can stay out for minutes, and a
 * refresh that waited for it would hold its button disabled all that time.
 */
export interface WritesInFlight {
    /** Run `write` now, counted as a write until its promise settles. Call
     *  it from the handler, not around it: wrapping a handler during render
     *  hands the React Compiler a function it must assume is called there. */
    run<R>(write: () => Promise<R>): Promise<R>;
    /** True once no write is out, including any that start meanwhile; false
     *  if some are still out after `limitMs`. Never rejects: a write that
     *  fails has already said so. */
    settled(limitMs: number): Promise<boolean>;
    /** Where the count stands now, to ask `since` about later. */
    mark(): number;
    /** A write started after `mark`, or one is still out. */
    since(mark: number): boolean;
}

/** How long a refresh waits for the saves before it: well past an ordinary
 *  save, short enough that a stuck one does not keep Refresh spinning. */
export const SAVE_WAIT_MS = 15_000;

export function writesInFlight(): WritesInFlight {
    const out = new Set<Promise<unknown>>();
    let started = 0;
    return {
        run: write => {
            started++;
            const p = write();
            out.add(p);
            const done = () => { out.delete(p); };
            p.then(done, done);
            return p;
        },
        settled: async limitMs => {
            const deadline = Date.now() + limitMs;
            while (out.size > 0) {
                const left = deadline - Date.now();
                if (left <= 0) return false;
                let timer: ReturnType<typeof setTimeout> | undefined;
                const late = await Promise.race([
                    Promise.allSettled([...out]).then(() => false),
                    new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(true), left); }),
                ]);
                clearTimeout(timer);
                if (late) return false;
            }
            return true;
        },
        mark: () => started,
        since: mark => started !== mark || out.size > 0,
    };
}
