/**
 * The hidden Steam browser view that runs the Púca web client.
 *
 * Game Mode's main window can host "browser views": separate Chromium pages
 * drawn over it, the same machinery as Steam's own store and web browser.
 * One is created when the plugin loads and lives as long as it does, invisible
 * until the full Púca view (the /puca route) shows it over its own area. It is
 * a Steam view, so it gets Steam's on-screen keyboard and touch input.
 *
 * Measured on the Deck (2026-10-22): a hidden view reports itself visible and
 * focused, so Chromium does not throttle it as a background tab; calls and
 * notifications keep running while a game is in front.
 */
import { Router } from '@decky/ui';

/** The native view (SteamClient.BrowserView): only what this plugin uses. */
interface NativeBrowserView {
    LoadURL(url: string): void;
    SetBounds(x: number, y: number, width: number, height: number): void;
    SetVisible(visible: boolean): void;
    SetFocus(focus: boolean): void;
    NotifyUserActivation?(): void;
}

/** Steam's wrapper around it (CreateBrowserView), with keyboard and gamepad glue. */
interface BrowserViewWrapper {
    m_browserView: NativeBrowserView;
    Destroy(): void;
}

interface MainWindow {
    CreateBrowserView(name: string, options?: Record<string, unknown>): BrowserViewWrapper;
}

/** Where a fresh view starts, so the backend can find it among Steam's pages. */
export function markerUrl(marker: string): string {
    return `data:text/plain,${marker}`;
}

export class PucaBrowserView {
    private wrapper: BrowserViewWrapper | null = null;

    /** Create the view on Game Mode's main window, showing `marker` until the
     *  backend has attached and navigates it to Púca. False outside Game Mode. */
    create(marker: string): boolean {
        this.destroy();
        const win = Router.WindowStore?.GamepadUIMainWindowInstance as unknown as MainWindow | undefined;
        if (!win || typeof win.CreateBrowserView !== 'function') return false;
        this.wrapper = win.CreateBrowserView('Puca', { bPreventCloseFromJavascript: true });
        const v = this.wrapper.m_browserView;
        v.SetVisible(false);
        v.LoadURL(markerUrl(marker));
        return true;
    }

    get exists(): boolean {
        return this.wrapper !== null;
    }

    /** Show the view over `rect` (CSS pixels of the main window) and give it input. */
    show(rect: { x: number; y: number; width: number; height: number }): void {
        const v = this.wrapper?.m_browserView;
        if (!v) return;
        v.SetBounds(Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height));
        v.SetVisible(true);
        v.SetFocus(true);
    }

    hide(): void {
        const v = this.wrapper?.m_browserView;
        if (!v) return;
        v.SetVisible(false);
        v.SetFocus(false);
    }

    /** Count what follows as the person's own action (Chromium's user
     *  activation): it lets the page start audio, as a click would. */
    activate(): void {
        try { this.wrapper?.m_browserView.NotifyUserActivation?.(); } catch { /* older client */ }
    }

    destroy(): void {
        if (!this.wrapper) return;
        try {
            this.wrapper.m_browserView.SetVisible(false);
            this.wrapper.Destroy();
        } catch { /* the window went first */ }
        this.wrapper = null;
    }
}
