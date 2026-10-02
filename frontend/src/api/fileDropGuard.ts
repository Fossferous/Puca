/**
 * Refuse a FILE or LINK dropped anywhere that is not a drop zone.
 *
 * A browser answers a file dropped on a page that did not claim it by
 * navigating to the file, and a link dropped from another app on a
 * non-editable area by loading the link. In a browser tab that loses your
 * place; in the desktop app it would replace Púca itself with the file or the
 * web page, with no back button. The desktop app used to be shielded by
 * Tauri's native drag-drop handler, which swallowed EVERY external drop —
 * including the chat's own (`.messages-container` in Chat.tsx), so dropping a
 * file on the chat did nothing at all. With that handler off
 * (`dragDropEnabled: false` in tauri.conf.json and tauri.lite.conf.json),
 * wry no longer calls `SetAllowExternalDrop(false)`, WebView2 hands every
 * drop to the page like any browser, and this guard is what keeps a near-miss
 * from becoming a navigation.
 *
 * Bubble-phase listeners on the window run AFTER every element's own
 * handlers, so `defaultPrevented` already says whether a real drop zone
 * accepted the drag; only unclaimed drags are refused (`dropEffect = 'none'`
 * shows the no-drop cursor, and the drop itself is cancelled).
 *
 * - Files: refused everywhere unclaimed, text boxes included (Chromium opens
 *   a file dropped on a textarea too).
 * - Links (`text/uri-list`): refused unless the target is editable, so a link
 *   can still be dropped into the composer or a note as its text.
 * - Plain text: left alone; dropped on a plain area it does nothing anyway.
 */
function dragTypes(e: Event): string[] {
    const types = (e as DragEvent).dataTransfer?.types;
    return types ? Array.from(types) : [];
}

/** Where Chromium inserts a dropped link as text instead of loading it: an
 *  enabled, writable text box or rich editor. A disabled box (the composer
 *  where sending is denied), a checkbox or a button is not one. */
const EDITABLE = [
    'textarea:not([disabled]):not([readonly])',
    'input:not([disabled]):not([readonly])' + ['checkbox', 'radio', 'file', 'button', 'submit', 'reset', 'image', 'range', 'color', 'hidden']
        .map(t => `:not([type="${t}"])`).join(''),
    '[contenteditable]:not([contenteditable="false"])',
].join(', ');

function isEditable(target: EventTarget | null): boolean {
    return target instanceof Element && !!target.closest(EDITABLE);
}

function shouldRefuse(e: Event): boolean {
    if (e.defaultPrevented) return false; // a real drop zone took it
    const types = dragTypes(e);
    if (types.includes('Files')) return true;
    return types.includes('text/uri-list') && !isEditable(e.target);
}

export function installFileDropGuard(target: Window): () => void {
    const onDragOver = (e: Event) => {
        if (!shouldRefuse(e)) return;
        e.preventDefault();
        (e as DragEvent).dataTransfer!.dropEffect = 'none';
    };
    const onDrop = (e: Event) => {
        if (!shouldRefuse(e)) return;
        e.preventDefault();
    };
    target.addEventListener('dragover', onDragOver);
    target.addEventListener('drop', onDrop);
    return () => {
        target.removeEventListener('dragover', onDragOver);
        target.removeEventListener('drop', onDrop);
    };
}
