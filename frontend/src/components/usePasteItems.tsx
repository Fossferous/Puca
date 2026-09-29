/**
 * A multi-line paste into an add-item field, asked about first and then
 * created in order — the one path Púca's Tasks view (its "Add a task…" and
 * "New list" fields, ChecklistBody's "Add an item…") and Púca Notes' open
 * note share.
 *
 * The contract every paste path keeps (PastedLinesDialog's header): nothing
 * is created until the person answers "Add N items" or "Add as one item",
 * Cancel creates nothing, and a single line pastes as the browser would.
 * What the paste becomes is readPastedItems' business (notes/model/
 * noteContent.ts): a checklist from elsewhere — an assistant's answer —
 * reads as one, anything else splits by line, and both are capped.
 *
 * WHERE the items go is decided at PASTE time, not at the answer: the
 * caller's callbacks close over the list or channel the field belonged to.
 * These fields commit or close on blur, and the question takes the focus
 * (PastedLinesDialog), so reading the target when the answer comes would
 * read whatever the view shows by then.
 *
 * While the question is open the field underneath does not act on Enter
 * (`asking`): its form would otherwise add what is typed there behind the
 * question, or — in "New list" — make a list that the answer then makes a
 * second time.
 *
 * The creates run one after another, paced (icsImport's PACE_MS, well under
 * the server's per-IP limit), and never two batches at once: a second paste
 * confirmed while the first is still landing waits its turn, so the two
 * lists do not interleave. A run that stops at a refusal says how many
 * landed; the refusal itself is explained by the create that failed.
 */
import { useRef, useState } from 'react';
import { PastedLinesDialog } from './PastedLinesDialog';
import { pushMessageToast } from './messageToastBus';
import { PACE_MS } from '../api/icsImport';
import { MAX_ITEM_LENGTH } from '../notes/model/notesModel';
import { pasteAsOneLine, readPastedItems, type PastedItems } from '../notes/model/noteContent';

const sleep = (ms: number) => new Promise<void>(r => { setTimeout(r, ms); });

export type PasteAnswer = 'separate' | 'one' | 'cancel';

/** What the two answers do, bound to the target the paste was aimed at.
 *  Each is handed the paste as it was read: its items, in order, and the
 *  checklist's own title when it read as one. */
export interface PasteAnswers {
    /** "Add N items". */
    separate: (read: PastedItems) => void;
    /** "Add as one item": the whole paste on one line, cut to fit a field. */
    one: (line: string, read: PastedItems) => void;
    /** What an answer does BESIDES adding items — makes a list, names the
     *  note — said in the question, because the question is the only place
     *  the person agrees to it. Null says nothing more. */
    detail?: (read: PastedItems) => string | null;
    /** After any answer, Cancel included (put the focus back). */
    after?: (answer: PasteAnswer) => void;
}

/**
 * Create `items` one at a time through `create`, stopping at the first it
 * refuses (false). Resolves to how many landed, and says so when that is
 * not all of them: the create's own message explains the refusal, not how
 * much of the list arrived.
 */
export async function createInOrder(items: string[], create: (text: string) => Promise<boolean>): Promise<number> {
    let made = 0;
    for (const item of items) {
        if (made > 0) await sleep(PACE_MS);
        if (!await create(item)) break;
        made++;
    }
    if (made < items.length) pushMessageToast({ title: `Added ${made} of ${items.length} items` });
    return made;
}

/** The text of an input that a paste would NOT replace: everything outside
 *  its selection. Blank means the paste is the field's whole content, which
 *  is when a pasted checklist may name what the field names. */
export function textOutsideSelection(input: HTMLInputElement): string {
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    return input.value.slice(0, start) + input.value.slice(end);
}

export function usePasteItems() {
    const [asking, setAsking] = useState<{ read: PastedItems; text: string; answers: PasteAnswers; detail: string | null } | null>(null);
    // The batches, in the order they were confirmed.
    const queue = useRef<Promise<unknown>>(Promise.resolve());

    /**
     * A paste into an add-item field: when it holds more than one item,
     * stop the browser pasting it and ask. `checklistOnly` is for a NAME
     * field (a list's, a note's title), which takes only a real checklist
     * and pastes anything else as a name. True when the paste was taken.
     */
    const onPaste = (e: React.ClipboardEvent<HTMLInputElement>, answers: PasteAnswers, opts: { checklistOnly?: boolean } = {}): boolean => {
        const text = e.clipboardData?.getData('text') ?? '';
        const read = readPastedItems(text, opts);
        if (!read) return false;                // one line pastes as normal
        e.preventDefault();
        // "As one item" of a name-field paste is the clean steps, not the
        // Markdown they came in: that field never showed the raw text.
        setAsking({ read, text: opts.checklistOnly ? read.items.join('\n') : text, answers, detail: answers.detail?.(read) ?? null });
        return true;
    };

    /** Create items in order after any batch still landing (createInOrder). */
    const addInOrder = (items: string[], create: (text: string) => Promise<boolean>): Promise<number> => {
        const run = queue.current.then(() => createInOrder(items, create));
        queue.current = run.catch(() => {});
        return run;
    };

    const dialog = asking ? (
        <PastedLinesDialog
            lines={asking.read.items}
            total={asking.read.total}
            detail={asking.detail}
            onAddSeparate={() => {
                setAsking(null);
                asking.answers.separate(asking.read);
                asking.answers.after?.('separate');
            }}
            onAddOne={() => {
                setAsking(null);
                asking.answers.one(pasteAsOneLine(asking.text).slice(0, MAX_ITEM_LENGTH), asking.read);
                asking.answers.after?.('one');
            }}
            onCancel={() => { setAsking(null); asking.answers.after?.('cancel'); }}
        />
    ) : null;

    return { onPaste, addInOrder, dialog, asking: asking !== null };
}
