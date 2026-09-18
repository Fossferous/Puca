/**
 * Is the server refusing this computer's sign-in-screen link — persistently?
 *
 * WHY THIS EXISTS. "Reach this computer after it restarts" reads as ON from
 * files on this machine alone, and for ten days it showed ticked while the
 * server refused the machine's own key on every attempt. The service now keeps
 * a record of what the server said (`crates/puca-service/src/link.rs`,
 * `LinkHealth`) and reports it through `lock_screen_state`.
 *
 * PERSISTENT, NOT ONE REFUSAL. The same refusal comes back for a revoked
 * device row and for a server database fault, and one refusal on its own can
 * be a blip the next attempt clears. So nothing is shown, and nothing changes
 * behaviour, until there have been at least {@link LINK_REFUSAL_MIN_COUNT}
 * refusals at least {@link LINK_REFUSAL_MIN_SPAN_SECS} apart with no success
 * between them (a success clears the record). The service retries a refusal
 * every 15 minutes, so a real one crosses this line on its second attempt.
 *
 * ONE RULE, TWO READERS: the warning in DevicesView and the lock-handover gate
 * in session.ts (`handleConsoleLock`). A separate module, not lockScreen.ts, so
 * the session tests that mock lockScreen still exercise the real rule.
 */

/** Refusals needed before the warning shows. */
export const LINK_REFUSAL_MIN_COUNT = 2;
/** And the first and latest of them must be at least this far apart (seconds). */
export const LINK_REFUSAL_MIN_SPAN_SECS = 10 * 60;

/** The link-health half of `UnattendedAccessState`. Optional throughout: an
 *  older service, or a caller that never asked, has nothing to say. */
export interface LinkHealthFacts {
    linkRefusedFirst?: number | null;
    linkRefusedLast?: number | null;
    linkRefusedCount?: number | null;
}

export function linkRefusalPersistent(s: LinkHealthFacts | null | undefined): boolean {
    if (!s) return false;
    const { linkRefusedFirst: first, linkRefusedLast: last, linkRefusedCount: count } = s;
    if (typeof first !== 'number' || typeof last !== 'number' || typeof count !== 'number') {
        return false;
    }
    return count >= LINK_REFUSAL_MIN_COUNT && last - first >= LINK_REFUSAL_MIN_SPAN_SECS;
}
