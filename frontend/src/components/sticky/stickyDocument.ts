/**
 * Dressing a sticky window's blank document so the note drawn into it looks
 * and behaves like the app (docs/STICKY_NOTES.md): Púca's stylesheets, its
 * theme and contrast, the link router, and the window-level keys.
 *
 * The document is a same-origin `about:blank` popup this realm scripts
 * (stickyShell.ts). It has no styles, no theme and no listeners of its own,
 * and it keeps none it is not given here; every one given here is taken back
 * by the disposer this returns.
 */
import { routeLinkClick } from '../../api/linkRouter';

/**
 * Copy every stylesheet the app has into `doc`, and keep copying the ones it
 * gains later (a lazily loaded chunk's CSS arrives after the window opened),
 * and mirror the theme: Púca's theme and contrast are data-* attributes on
 * <html>, and a change of theme must reach the sticky notes already open.
 */
function mirrorLook(doc: Document): () => void {
    const copy = (node: Node) => {
        if (node instanceof HTMLStyleElement || (node instanceof HTMLLinkElement && node.rel === 'stylesheet')) {
            doc.head.appendChild(doc.importNode(node, true));
        }
    };
    for (const node of Array.from(document.querySelectorAll('style, link[rel="stylesheet"]'))) copy(node);
    const theme = () => {
        const src = document.documentElement;
        const dst = doc.documentElement;
        for (const a of Array.from(dst.attributes)) if (a.name.startsWith('data-') && !src.hasAttribute(a.name)) dst.removeAttribute(a.name);
        for (const a of Array.from(src.attributes)) if (a.name.startsWith('data-')) dst.setAttribute(a.name, a.value);
        if (src.lang) dst.lang = src.lang;
    };
    theme();
    const heads = new MutationObserver(records => {
        for (const r of records) for (const n of Array.from(r.addedNodes)) copy(n);
    });
    heads.observe(document.head, { childList: true });
    const html = new MutationObserver(theme);
    html.observe(document.documentElement, { attributes: true });
    return () => { heads.disconnect(); html.disconnect(); };
}

export interface StickyKeys {
    newNote: () => void;
    close: () => void;
    openNotes: (search: boolean) => void;
    cycle: (dir: 1 | -1) => void;
}

/**
 * The keys of Microsoft's table that belong to the WINDOW (Ctrl+N, Ctrl+W,
 * Ctrl+H, Ctrl+F, Ctrl+Tab); the text field takes the formatting keys itself
 * (NoteBodyField) and the view takes Ctrl+D. Only in this window: a key
 * pressed anywhere else never reaches these.
 */
export function stickyKeyHandler(keys: StickyKeys): (e: KeyboardEvent) => void {
    return (e: KeyboardEvent) => {
        if (e.defaultPrevented || e.altKey || !(e.ctrlKey || e.metaKey)) return;
        if (e.key === 'Tab') {
            e.preventDefault();
            keys.cycle(e.shiftKey ? -1 : 1);
            return;
        }
        if (e.shiftKey) return;
        switch (e.key.toLowerCase()) {
            case 'n': e.preventDefault(); keys.newNote(); break;
            case 'w': e.preventDefault(); keys.close(); break;
            case 'h': e.preventDefault(); keys.openNotes(false); break;
            case 'f': e.preventDefault(); keys.openNotes(true); break;
            default: break;
        }
    };
}

/** Make `w` ready for a note: its look, its links, its keys. */
export function prepareStickyWindow(w: Window, keys: () => StickyKeys): () => void {
    const doc = w.document;
    doc.body.classList.add('sticky-doc');
    const unmirror = mirrorLook(doc);
    // A link in a note leaves through the router the main page uses — the
    // system browser, or Púca's own Join a Server for an invite to here. The
    // popup's own window.open is refused by the shell, so a link left to the
    // browser would do nothing at all.
    const onClick = (e: MouseEvent) => routeLinkClick(e);
    doc.addEventListener('click', onClick, true);
    doc.addEventListener('auxclick', onClick, true);
    const onKey = (e: KeyboardEvent) => stickyKeyHandler(keys())(e);
    doc.addEventListener('keydown', onKey);
    return () => {
        unmirror();
        doc.removeEventListener('click', onClick, true);
        doc.removeEventListener('auxclick', onClick, true);
        doc.removeEventListener('keydown', onKey);
    };
}
