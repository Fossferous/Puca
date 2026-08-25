/**
 * Document Picture-in-Picture (W4): ONE always-on-top OS window holding a
 * GRID of popped streams — Chromium allows a single Doc-PiP window per
 * document, so "pop out several streams" cannot be several windows.
 *
 * Pure helpers, split from the component for the same fast-refresh reason as
 * streamPopout.utils. The RUNTIME question — does this embedder implement
 * `documentPictureInPicture`? — is answered by feature detection at click
 * time plus a `[doc-pip]` startup log line, because it genuinely varies:
 * Chrome/Edge browser tabs have it; whether the WebView2 shell does is
 * unverifiable from documentation (nothing published either way) and the
 * log is the field's answer. Everything degrades through `popoutMode()` to
 * the single-video engines when it is absent or `requestWindow` rejects.
 */
import { pipEngine, type PipEngine } from './streamPopout.utils';

export type PopoutMode = 'docpip' | PipEngine;

/** Window with the Doc-PiP entry point, where the runtime has it. */
interface DocPipWindow extends Window {
    documentPictureInPicture?: {
        requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
    };
}

export function docPipSupported(): boolean {
    return typeof window !== 'undefined'
        && typeof (window as DocPipWindow).documentPictureInPicture?.requestWindow === 'function';
}

/**
 * Which popout the button drives here. 'docpip' wins where it exists —
 * EXCEPT on the Android app, whose native PipActivity (the Java side
 * floating the whole WebView) stays exactly as it is: the grid is a
 * desktop/browser feature and the phone's OS PiP is already right.
 */
export function popoutMode(): PopoutMode | null {
    const engine = pipEngine();
    if (engine === 'native') return 'native';
    if (docPipSupported()) return 'docpip';
    return engine;
}

/**
 * The popped set after clicking `id`'s button. Multi (docpip): membership
 * toggles — the grid holds any number. Single (legacy engines): the newest
 * pick REPLACES the old one, because those engines can only show one.
 */
export function togglePopped(list: number[], id: number, multi: boolean): number[] {
    if (list.includes(id)) return list.filter(x => x !== id);
    return multi ? [...list, id] : [id];
}

/**
 * Give the Doc-PiP document the app's styling: clone every <style> and
 * stylesheet <link> into its head. The window is same-origin and same-realm,
 * but starts with an EMPTY document — without this the grid renders unstyled
 * Times New Roman over white.
 */
export function copyStyleSheetsInto(doc: Document): void {
    const nodes = document.querySelectorAll('style, link[rel="stylesheet"]');
    for (const node of Array.from(nodes)) {
        doc.head.appendChild(doc.importNode(node, true));
    }
}
