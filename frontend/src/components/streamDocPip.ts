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
import { osWindowsSupported } from './streamOsWindows';

/** 'windows' = Púca's own pop-out windows (the desktop shell, one window per
 *  stream, streamOsWindows.ts); 'docpip' = the one-window grid; the rest are
 *  the single-video engines. */
export type PopoutMode = 'windows' | 'docpip' | PipEngine;

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
 * Which popout the button drives here. On the desktop shell, Púca's own
 * windows ('windows': any size, one per stream) once the shell has answered
 * the probe; otherwise 'docpip' where it exists — EXCEPT on the Android app,
 * whose native PipActivity (the Java side floating the whole WebView) stays
 * exactly as it is: the grid is a desktop/browser feature and the phone's OS
 * PiP is already right. The web never gets 'windows' (no shell to ask).
 */
export function popoutMode(): PopoutMode | null {
    const engine = pipEngine();
    if (engine === 'native') return 'native';
    if (osWindowsSupported()) return 'windows';
    if (docPipSupported()) return 'docpip';
    return engine;
}

/**
 * The popped set after clicking `id`'s button. Multi (windows, docpip):
 * membership toggles. Single (legacy engines): the newest pick REPLACES the
 * old one, because those engines can only show one. `max` caps a multi set
 * (the shell's window limit): at the cap the OLDEST pop goes back.
 */
export function togglePopped(list: number[], id: number, multi: boolean, max = Infinity): number[] {
    if (list.includes(id)) return list.filter(x => x !== id);
    if (!multi) return [id];
    const next = [...list, id];
    return next.length > max ? next.slice(next.length - max) : next;
}

/** What the in-app float (StreamPip) shows while streams are popped out. */
export interface InAppPipPlan {
    /** The stream the float binds and names; null = none (nothing watched,
     *  or every watched stream is in the OS window). */
    show: number | null;
    /** Keep the float MOUNTED but invisible. */
    hidden: boolean;
}

/**
 * The float never shows a stream that is in the OS window — on every engine
 * that puts the stream in a SEPARATE window: the Doc-PiP grid, element PiP
 * ('standard') and Safari's 'webkit'. It shows the first watched stream that
 * is NOT popped, and hides only when every watched stream is popped.
 *
 * Before this the rule was `usingDocPip && popped.length > 0`: the single-
 * video engines never hid the float (the same stream on screen twice), and
 * the grid hid it as soon as ANY stream was popped — so a watched stream that
 * was NOT popped was on screen nowhere.
 *
 * 'native' (the Android app) is left as it was: PipActivity floats the whole
 * WebView with a full-viewport host over the page, so the docked strip is
 * never what that window shows. null (no PiP at all) cannot have pops.
 */
export function inAppPipPlan(
    selected: readonly number[],
    popped: readonly number[],
    mode: PopoutMode | null,
): InAppPipPlan {
    if (selected.length === 0) return { show: null, hidden: false };
    if (mode === 'native' || mode === null) return { show: selected[0], hidden: false };
    const free = selected.find(id => !popped.includes(id));
    return free === undefined ? { show: null, hidden: true } : { show: free, hidden: false };
}

/**
 * The float's "+N more" badge: the OTHER watched streams it could show, i.e.
 * not the one it shows and not the ones in the OS window (same engine rules
 * as inAppPipPlan). It used to be selected.length - 1, so a popped stream
 * the float deliberately no longer shows was still counted as "more".
 */
export function inAppPipMore(
    selected: readonly number[],
    popped: readonly number[],
    mode: PopoutMode | null,
): number {
    const { show } = inAppPipPlan(selected, popped, mode);
    if (show === null) return 0;
    const ignoresPops = mode === 'native' || mode === null;
    return selected.filter(id => id !== show && (ignoresPops || !popped.includes(id))).length;
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
