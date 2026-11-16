/**
 * Where a click on a note's drawn text lands in the TEXT
 * (components/NoteFormattedText.tsx tags every run with `data-at`). A .ts
 * file of its own: a .tsx that exports anything but components fails
 * react-refresh/only-export-components, a required lint gate.
 */
/**
 * The offset in the TEXT of the point (x, y) inside `root`, a container
 * NoteFormattedText drew: the run under the point says where it starts
 * (`data-at`) and the browser says how far into it. Null when the browser
 * cannot say (older WebViews) — the caller then puts the caret at the end.
 */
export function textOffsetAt(root: HTMLElement | null, x: number, y: number): number | null {
    if (!root) return null;
    const doc = root.ownerDocument;
    const api = doc as Document & {
        caretRangeFromPoint?: (x: number, y: number) => Range | null;
        caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    };
    let node: Node | null = null;
    let offset = 0;
    if (typeof api.caretRangeFromPoint === 'function') {
        const r = api.caretRangeFromPoint(x, y);
        if (r) { node = r.startContainer; offset = r.startOffset; }
    } else if (typeof api.caretPositionFromPoint === 'function') {
        const p = api.caretPositionFromPoint(x, y);
        if (p) { node = p.offsetNode; offset = p.offset; }
    }
    if (!node || !root.contains(node)) return null;
    return offsetOfNode(node, offset);
}

/** The text offset of (`node`, `offset`) inside a NoteFormattedText. */
export function offsetOfNode(node: Node, offset: number): number | null {
    // A text node inside a run: the run's start plus how far into it — the
    // run's own text nodes counted, since a search's marks split it up.
    const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node as Element;
    const run = el?.closest('[data-at]');
    if (!run) return null;
    const at = Number(run.getAttribute('data-at'));
    if (!Number.isFinite(at)) return null;
    if (run.classList.contains('nf-bullet')) return at + 2;
    if (node.nodeType !== Node.TEXT_NODE) return at;
    const walker = run.ownerDocument.createTreeWalker(run, NodeFilter.SHOW_TEXT);
    let before = 0;
    while (walker.nextNode()) {
        if (walker.currentNode === node) return at + before + offset;
        before += walker.currentNode.textContent?.length ?? 0;
    }
    return at;
}
