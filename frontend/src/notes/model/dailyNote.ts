/**
 * Today's note — what "New note" opens when it is asked to start writing now.
 *
 * The launcher's New note shortcut, the quick tile, the widget, an app
 * sending the same intent (MacroDroid, Tasker) and "Open Púca Notes to: New
 * note" all ask for a text note READY TO TYPE (ComposeIntent.readyToType).
 * That request is a daily log: the note is titled with today's date, and
 * asking again on the same day opens THAT note, with the caret at the end of
 * its text, instead of starting another one. A share, a list, a drawing, a
 * photo and every click on the page are untouched.
 *
 * The title is one fixed, locale-aware long date in the device's language
 * ("Sunday 12 October 2026" on en-GB, "Sunday, October 12, 2026" on en-US).
 * Matching is by that exact title for the LOCAL calendar date, so a note
 * renamed to anything else stops being today's note, and a phone whose
 * language changes simply starts a new one.
 *
 * Pure: the shell hands in its live cards and the clock.
 */

/**
 * How long New note waits for the notes to arrive before it decides there
 * is no note for today. A cold start reads the shortcut in milliseconds and
 * the list over the network; deciding before it lands would start a second
 * note for a day that has one. Bounded, so offline with nothing cached the
 * composer still opens — a little longer than a share waits (SHARE_ASK_MS),
 * because a wrong answer here costs a duplicate note, not a dropped picture.
 */
export const DAILY_WAIT_MS = 4000;

/** The long form: weekday, day, month and year, in the device's own order. */
const LONG_DATE: Intl.DateTimeFormatOptions = { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' };

/** Today's title for `now`, on the local calendar (local midnight is the
 *  boundary). `locale` is for tests; the app passes none, which is the
 *  device's own. */
export function dailyTitle(now: Date, locale?: string | string[]): string {
    return new Intl.DateTimeFormat(locale, LONG_DATE).format(now);
}

/** What the match reads of a note. NotesShell's cards fit it as they are. */
export interface DailyCandidate {
    title: string;
    /** A channel's checklist is named after the channel and is never a
     *  daily note. */
    ref: { kind: string };
    /** In the trash. The shell's cards are live notes already; this is the
     *  belt to that brace. */
    trashed?: boolean;
    updatedAt?: string;
    createdAt?: string;
}

const editedAt = (c: DailyCandidate): number => {
    const t = Date.parse(c.updatedAt ?? c.createdAt ?? '');
    return Number.isNaN(t) ? -Infinity : t;
};

/**
 * Today's note among `notes`, or null: a personal note, not in the trash,
 * whose title is exactly today's date. If several are, the one edited most
 * recently (an archived one counts — it is still the person's note for the
 * day).
 */
export function findDailyNote<T extends DailyCandidate>(notes: readonly T[], now: Date, locale?: string | string[]): T | null {
    const want = dailyTitle(now, locale);
    let best: T | null = null;
    for (const n of notes) {
        if (n.trashed || n.ref.kind !== 'list' || n.title.trim() !== want) continue;
        if (best === null || editedAt(n) > editedAt(best)) best = n;
    }
    return best;
}
