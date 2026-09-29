/**
 * Rows a view CREATED while a read of the same list was out — kept so the
 * read's answer cannot take them off the screen.
 *
 * A read is a snapshot of the moment the server answered it, and it can
 * arrive after rows it does not hold are already shown: a pasted checklist
 * lands item by item for as long as it takes (usePasteItems — ten seconds
 * and more for a long one), and the list is read again meanwhile, opened
 * again after a switch away or re-read because another member changed it.
 * Putting that snapshot on screen as it was dropped every item that landed
 * while it was out, until the list was opened again (18 rows shown of the
 * 20 the server held, in review).
 *
 * So a create that answers while a read is out is noted here, and that
 * read's answer gets back the ones it lacks. Only while a read is out: a
 * create that answered with none out is in every later snapshot anyway (the
 * server wrote it before it answered), so nothing is kept for long.
 */
import type { Task } from '../api/tasks';

export interface ReadInFlight {
    /** The read's answer, plus what landed here while it was out and it
     *  does not hold. */
    merge: (fetched: Task[]) => Task[];
    /** The read is over: answered, failed or no longer wanted. */
    done: () => void;
}

export function createdWhileReading() {
    let out = 0;
    let seq = 0;
    let landed: Array<{ scope: string; task: Task; seq: number }> = [];
    return {
        /** A read of `scope` (whatever names the list: `list:4`, `channel:9`)
         *  goes out now. */
        reading(scope: string): ReadInFlight {
            out++;
            const since = seq;
            let open = true;
            return {
                merge: fetched => {
                    const have = new Set(fetched.map(t => t.id));
                    const late = landed
                        .filter(l => l.scope === scope && l.seq > since && !have.has(l.task.id))
                        .map(l => l.task);
                    return late.length > 0 ? [...fetched, ...late] : fetched;
                },
                done: () => {
                    if (!open) return;
                    open = false;
                    if (--out === 0) landed = [];
                },
            };
        },
        /** A create in `scope` answered with `task`. */
        created(scope: string, task: Task) {
            seq++;
            if (out > 0) landed.push({ scope, task, seq });
        },
        /** Deleted here: a read still out must not bring these back. */
        forget(ids: ReadonlySet<number>) {
            landed = landed.filter(l => !ids.has(l.task.id));
        },
    };
}
