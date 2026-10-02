/**
 * Refuse a FILE dropped anywhere that is not a drop zone.
 *
 * A browser answers a file dropped on a page that did not claim it by
 * navigating to the file. In a browser tab that loses your place; in the
 * desktop app it would replace Púca itself with the file. The desktop app
 * used to be shielded by Tauri's native drag-drop handler, which swallowed
 * EVERY file drop — including the chat's own (`.messages-container` in
 * Chat.tsx), so dropping a file on the chat did nothing at all. With that
 * handler off (`dragDropEnabled: false` in tauri.conf.json and
 * tauri.lite.conf.json), WebView2 hands drops to the page like any browser,
 * and this guard is what keeps a near-miss from becoming a navigation.
 *
 * Bubble-phase listeners on the window run AFTER every element's own
 * handlers, so `defaultPrevented` already says whether a real drop zone
 * accepted the drag; only unclaimed file drags are refused (`dropEffect =
 * 'none'` shows the no-drop cursor, and the drop itself is cancelled). Text,
 * link and in-page drags carry no 'Files' type and are never touched.
 */
function carriesFiles(e: Event): e is DragEvent {
    const types = (e as DragEvent).dataTransfer?.types;
    return !!types && Array.from(types).includes('Files');
}

export function installFileDropGuard(target: Window): () => void {
    const onDragOver = (e: Event) => {
        if (!carriesFiles(e) || e.defaultPrevented) return;
        e.preventDefault();
        e.dataTransfer!.dropEffect = 'none';
    };
    const onDrop = (e: Event) => {
        if (!carriesFiles(e) || e.defaultPrevented) return;
        e.preventDefault();
    };
    target.addEventListener('dragover', onDragOver);
    target.addEventListener('drop', onDrop);
    return () => {
        target.removeEventListener('dragover', onDragOver);
        target.removeEventListener('drop', onDrop);
    };
}
