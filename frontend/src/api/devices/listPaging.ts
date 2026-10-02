/**
 * Following a host's folder pages without losing entries when the folder
 * changes between pages. Pure, so the rules are testable without a session.
 *
 * A host's `next` is a POSITION in its own enumeration of the folder (the
 * agent's `read_dir`, a phone's `readdir`). Positions shift when the folder
 * changes: a file created before the cursor repeats an entry (harmless — the
 * browser shows each name once), but a file DELETED before the cursor moves
 * every later entry back one place, so resuming at the bare cursor never sends
 * the first entry of the next page, and the last page still reads as complete.
 * A browser's temp download vanishing from a busy Downloads folder is enough.
 *
 * So a further page is asked for a little EARLY — it re-sends the last name the
 * browser already holds (the anchor) and up to `LIST_PAGE_OVERLAP` before it —
 * and the browser keeps only what comes after the anchor. Wherever the anchor
 * now sits in that window, everything after it is the exact continuation,
 * whatever was created or deleted before it. When the anchor is not in the
 * window at all (it was deleted itself, or the folder shifted further than the
 * overlap) entries may have been skipped, and the browser must SAY so: a
 * partial folder announces itself rather than look complete.
 *
 * No wire change: the host still pages by position, and a host from before
 * paging never names a `next`, so none of this runs against it.
 */
import type { FsEntry } from './fileTransfer';

/** How many entries before the anchor a further page re-sends, at most. A
 *  real page is hundreds to thousands of entries (2,000 or 96 KiB of names),
 *  so 16 is noise on the wire and absorbs that many deletions exactly. */
export const LIST_PAGE_OVERLAP = 16;

/** Where a paged folder continues: the host's `next`, the last name of the
 *  page it came with (in the HOST's order, not the sorted display order), and
 *  that page's length. */
export interface ListContinuation {
    next: number;
    last: string;
    size: number;
}

/** A page as `listDir` returns it. */
export interface ListPage {
    entries: FsEntry[];
    truncated: boolean;
    next: number | null;
}

/** The continuation a first page offers, or null when the folder is complete
 *  (or the host predates paging, or sent a `next` with nothing to anchor it). */
export function firstContinuation(page: ListPage): ListContinuation | null {
    const last = page.entries.at(-1);
    if (page.next === null || last === undefined) return null;
    return { next: page.next, last: last.name, size: page.entries.length };
}

/** The cursor to ask a further page from: the anchor's position, less an
 *  overlap that never exceeds half the previous page — so the page that comes
 *  back still reaches past `next` even if the host's pages are tiny. */
export function continuationCursor(c: ListContinuation): number {
    const overlap = Math.min(LIST_PAGE_OVERLAP, Math.max(0, Math.floor(c.size / 2) - 1));
    return Math.max(0, c.next - 1 - overlap);
}

/** What a further page adds, and where the folder goes on from there. */
export interface ContinuedPage {
    /** Entries after the anchor (or the whole page when the anchor is gone). */
    entries: FsEntry[];
    truncated: boolean;
    more: ListContinuation | null;
    /** The anchor was not where the folder could be resumed from: entries
     *  between the pages may be missing, and only a fresh listing is exact. */
    gap: boolean;
}

/** Resume a folder after its anchor, given the page fetched from
 *  `continuationCursor(c)`. */
export function continuePage(c: ListContinuation, page: ListPage): ContinuedPage {
    const at = page.entries.findIndex(e => e.name === c.last);
    const entries = at >= 0 ? page.entries.slice(at + 1) : page.entries;
    const last = page.entries.at(-1);
    // The folder goes on only if the host's next moves PAST the previous one —
    // otherwise Load more would fetch the same window for ever. A host that
    // names such a next still cut the folder, so it reads as cut.
    const advances = page.next !== null && page.next > c.next && last !== undefined;
    return {
        entries,
        truncated: page.truncated || (page.next !== null && !advances),
        more: advances ? { next: page.next!, last: last!.name, size: page.entries.length } : null,
        gap: at < 0,
    };
}

/** The list scroll offset that keeps the row at the top of the viewport where
 *  it is after `after` replaced `before` (both in display order, unique
 *  names). Rows sorted in above it would otherwise push what the user was
 *  reading down out of view, and Load more would look as if it did nothing.
 *  At the very top the top stays the top, so rows sorted in there are seen. */
export function scrollKeepingTopRow(before: FsEntry[], after: FsEntry[], scrollTop: number, rowH: number): number {
    if (scrollTop <= 0 || rowH <= 0) return scrollTop;
    const i = Math.floor(scrollTop / rowH);
    const name = before[i]?.name;
    if (name === undefined) return scrollTop;
    const j = after.findIndex(e => e.name === name);
    return j < 0 ? scrollTop : scrollTop + (j - i) * rowH;
}
