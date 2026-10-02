/**
 * Dropping a file onto the chat in the WINDOWS desktop app.
 *
 * The chat's drop zone is plain HTML5 (`onDragOver`/`onDrop` on
 * `.messages-container`, Chat.tsx), the same path the web app uses. Tauri 2
 * enables its NATIVE drag-drop handler on every window unless the window says
 * `dragDropEnabled: false`, and on Windows that handler is exclusive: wry
 * (webview2/mod.rs) calls `ICoreWebView2Controller4::SetAllowExternalDrop(false)`
 * and registers its own IDropTarget on the window, so WebView2 never delivers
 * a file drop to the page. tauri-utils' own doc for the key: "Disabling it is
 * required to use HTML5 drag and drop on the frontend on Windows." Nothing in
 * this codebase listens for Tauri's native drop event (no onDragDropEvent, no
 * tauri://drag-*), so the native handler swallowed every drop for nobody.
 *
 * Turning it off hands file drops back to the page — including drops OUTSIDE
 * the chat's drop zone, which a browser answers by navigating to the file. In
 * the desktop app that would replace Púca with the file. installFileDropGuard
 * refuses those, and leaves every real drop zone alone.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { installFileDropGuard } from '../api/fileDropGuard';

const TAURI = join(__dirname, '..', '..', 'src-tauri');
const mainWindow = (file: string) => JSON.parse(readFileSync(join(TAURI, file), 'utf8')).app.windows[0];

describe.each(['tauri.conf.json', 'tauri.lite.conf.json'])('%s', (file) => {
    it('turns Tauri\'s native drag-drop handler off, so HTML5 file drop reaches the page', () => {
        expect(mainWindow(file).dragDropEnabled).toBe(false);
    });
});

it('positive control: the reader sees the real window', () => {
    expect(mainWindow('tauri.conf.json').title).toBe('Puca');
    expect(mainWindow('tauri.lite.conf.json').title).toBe('Puca Lite');
});

/** A drag event as Chromium builds one: cancelable, bubbling, with a DataTransfer. */
function dragEvent(type: 'dragover' | 'drop', types: string[]) {
    const dt = { types, dropEffect: 'copy' as string };
    const e = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'dataTransfer', { value: dt });
    return { e, dt };
}

let uninstall: (() => void) | null = null;
const cleanup: Element[] = [];
afterEach(() => {
    uninstall?.();
    uninstall = null;
    cleanup.splice(0).forEach(el => el.remove());
});

function plainArea() {
    const el = document.createElement('div');
    document.body.appendChild(el);
    cleanup.push(el);
    return el;
}

function dropZone() {
    const el = plainArea();
    const seen: string[] = [];
    el.addEventListener('dragover', (e) => { e.preventDefault(); seen.push('dragover'); });
    el.addEventListener('drop', (e) => { e.preventDefault(); seen.push('drop'); });
    return { el, seen };
}

describe('installFileDropGuard', () => {
    it('a file dropped OUTSIDE any drop zone is refused, not opened', () => {
        uninstall = installFileDropGuard(window);
        const area = plainArea();
        const over = dragEvent('dragover', ['Files']);
        area.dispatchEvent(over.e);
        expect(over.e.defaultPrevented).toBe(true);
        expect(over.dt.dropEffect).toBe('none');
        const drop = dragEvent('drop', ['Files']);
        area.dispatchEvent(drop.e);
        expect(drop.e.defaultPrevented).toBe(true);
    });

    it('negative control: without the guard, nothing stops the browser default', () => {
        const area = plainArea();
        const drop = dragEvent('drop', ['Files']);
        area.dispatchEvent(drop.e);
        expect(drop.e.defaultPrevented).toBe(false);
    });

    it('a real drop zone (the chat) still gets the file, with its own drop effect', () => {
        uninstall = installFileDropGuard(window);
        const zone = dropZone();
        const over = dragEvent('dragover', ['Files']);
        zone.el.dispatchEvent(over.e);
        expect(over.dt.dropEffect).toBe('copy');
        const drop = dragEvent('drop', ['Files']);
        zone.el.dispatchEvent(drop.e);
        expect(zone.seen).toEqual(['dragover', 'drop']);
    });

    it('drags that are not files (text, links, in-page reorders) are left alone', () => {
        uninstall = installFileDropGuard(window);
        const area = plainArea();
        const over = dragEvent('dragover', ['text/plain']);
        area.dispatchEvent(over.e);
        expect(over.e.defaultPrevented).toBe(false);
        expect(over.dt.dropEffect).toBe('copy');
    });

    it('uninstalls cleanly', () => {
        installFileDropGuard(window)();
        const area = plainArea();
        const drop = dragEvent('drop', ['Files']);
        area.dispatchEvent(drop.e);
        expect(drop.e.defaultPrevented).toBe(false);
    });
});
