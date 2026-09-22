/**
 * How many search marks are REALLY in the DOM under an element.
 *
 * The open note's "n of m" bar steps through `mark.notes-hl` nodes
 * imperatively, so the count beside it has to be a count of the same nodes.
 * Deriving it from the model instead (sum of findRanges over the note's
 * items) agrees on the first render and then drifts: TaskTree's "Completed"
 * section unmounts its rows when it is collapsed, taking their marks with it,
 * and the bar went on saying "3 of 9" over a list of four.
 *
 * A MutationObserver, not a render-time count, because that collapse is
 * TaskTree's OWN state — it re-renders the tree without re-rendering the
 * editor, so nothing else tells us the marks have gone.
 */
import { useLayoutEffect, useState, type RefObject } from 'react';

/** The mark `Highlight` emits, and the one the stepper walks. */
export const MARK_SELECTOR = 'mark.notes-hl';

export function useMarkCount(ref: RefObject<HTMLElement | null>, active: boolean): number {
    const [count, setCount] = useState(0);
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el || !active) {
            // Measuring the DOM is exactly what this effect is for; the state
            // is the measurement, and nothing renders it before it is taken
            // (useLayoutEffect runs before paint).
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setCount(0);
            return;
        }
        const recount = () => setCount(el.querySelectorAll(MARK_SELECTOR).length);
        recount();
        if (typeof MutationObserver === 'undefined') return;
        const mo = new MutationObserver(recount);
        mo.observe(el, { childList: true, subtree: true, characterData: true });
        return () => mo.disconnect();
    }, [ref, active]);
    return count;
}
