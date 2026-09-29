/**
 * Checklist HEADINGS — "## Before you start" inside a list of steps: a
 * section title, not one more box to tick.
 *
 * A heading is an ordinary item (a task row) whose text is a Markdown
 * heading. That is the whole storage format: task text is sealed E2EE, so
 * the server never learns which rows are headings, and nothing about a
 * heading needed a column, a migration or a route. An older client shows the
 * row as an item that reads "## Before you start", which is the honest
 * degradation. Written as "## " + label; read from any "#".."######" and a
 * space, so "# Setup" typed into an add row or pasted from elsewhere is a
 * heading too.
 *
 * A heading is a TOP-LEVEL row. Sections are what a list is split into; a
 * "## x" nested under another item (only an older client can put one
 * there) is an ordinary sub-item that happens to start with hashes, and the
 * server's completion sweep treats it as one. Keeping the rule here means
 * nothing inside an item's subtree is ever un-tickable, and the drag and
 * the menus only ever have to refuse the one move that would nest a heading
 * (api/tasks.ts planDropTarget).
 *
 * This file is the ONLY place the rule lives. Every surface that renders,
 * counts, ticks, reminds or exports items asks it: Púca's TaskTree (the
 * Tasks view, channel checklists, the side panel, the All-checklists board),
 * Púca Notes' cards, editor, composer and exports, the reminders and the
 * calendars. Never re-implement the regex in a component.
 */
import { isUndecryptable } from './decryptMarkers';

/** Up to three spaces of indent, one to six "#", white space, the label,
 *  and an optional closing run of "#" (which Markdown allows only after a
 *  space, so "C#" keeps its hash). */
const HEADING = /^[ \t]{0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;

/** The label of heading text, or null when the text is not a heading (no
 *  space after the hashes, "#hashtag"; nothing after them, "## "; or more
 *  than one line). */
export function headingLabelOf(text: string): string | null {
    const m = HEADING.exec(text);
    if (!m) return null;
    const label = m[1].trim();
    return label === '' ? null : label;
}

/** Does this text read as a heading? */
export function isHeadingText(text: string): boolean {
    return headingLabelOf(text) !== null;
}

/** What a heading shows: its label without the marks. Anything that is not
 *  heading text comes back as it is, so this is safe on every item. */
export function headingLabel(text: string): string {
    return headingLabelOf(text) ?? text;
}

/** The stored form of a heading with this label ("## label"). A label that
 *  already carries marks ("# Setup", "### Setup") is normalised rather than
 *  doubled up. */
export function asHeadingText(label: string): string {
    return `## ${headingLabel(label.trim()).trim()}`;
}

/** What an add row stores for what was typed: a heading in the one form a
 *  heading is written ("# x" and "### x" become "## x"), anything else as
 *  it is. */
export function asItemText(text: string): string {
    return isHeadingText(text) ? asHeadingText(text) : text;
}

/** The fields of a row this rule reads — structural, so a Task, a feed row
 *  or a test's plain object all qualify. */
export interface HeadingLike {
    description: string;
    parent_id: number | null;
}

/** Is this row a heading: top level, readable, and heading text? A row
 *  this device cannot decrypt is never a heading (its text is a marker). */
export function isHeadingTask(t: HeadingLike): boolean {
    return t.parent_id === null && !isUndecryptable(t.description) && isHeadingText(t.description);
}

/** The progress a list shows ("3/10"): headings are not steps, so they are
 *  neither done nor to do. A heading an older client ticked is not counted
 *  as done either. */
export function countItems(tasks: ReadonlyArray<HeadingLike & { is_completed: boolean }>): { total: number; completed: number } {
    let total = 0;
    let completed = 0;
    for (const t of tasks) {
        if (isHeadingTask(t)) continue;
        total++;
        if (t.is_completed) completed++;
    }
    return { total, completed };
}

/** How many of these rows are headings, and how many of those an older
 *  client ticked: what a server's row count ("total_tasks") holds beyond
 *  countItems. */
export function countHeadings(tasks: ReadonlyArray<HeadingLike & { is_completed: boolean }>): { total: number; completed: number } {
    let total = 0;
    let completed = 0;
    for (const t of tasks) {
        if (!isHeadingTask(t)) continue;
        total++;
        if (t.is_completed) completed++;
    }
    return { total, completed };
}

/** How many of these item TEXTS are headings, and how many are items — for
 *  a question asked before a paste or a share creates them. */
export function countHeadingTexts(texts: readonly string[]): { items: number; headings: number } {
    let headings = 0;
    for (const t of texts) if (isHeadingText(t)) headings++;
    return { items: texts.length - headings, headings };
}

/** What the paste question's "Add" button says it will make
 *  (components/PastedLinesDialog.tsx). Headings are named apart from items:
 *  "Add 12 items" for a list whose four section titles were never going to
 *  be boxes would promise the wrong thing. With none, the wording is the
 *  one it always was. */
export function addItemsLabel(texts: readonly string[]): string {
    const { items, headings } = countHeadingTexts(texts);
    const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
    if (headings === 0) return `Add ${items} items`;
    if (items === 0) return `Add ${plural(headings, 'heading')}`;
    return `Add ${plural(items, 'item')} and ${plural(headings, 'heading')}`;
}
