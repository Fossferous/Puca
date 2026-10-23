/**
 * Sharing the Deck's screen into a call (docs/STEAM_DECK.md, Sharing your
 * screen): when the page may have the screen, and when the picture pauses.
 *
 * What the backend captures is the whole screen (gamescope's feed), Steam's
 * own menus included, so neither is left to the page:
 *
 *  - A share starts only from a press in the Quick Access panel: its Share
 *    screen, or its answer to a request the page made by itself (Púca's own
 *    Share button, in the full view). The page's request for the screen
 *    (its host's getDisplayMedia) is otherwise refused.
 *  - The picture pauses while anything but the game is on screen: the Quick
 *    Access menu or the Steam menu, the on-screen keyboard (a password typed
 *    on it would show), a notification (a message's preview), Púca's own full
 *    view, or Steam itself in front (no game, or Steam's pages over one).
 *
 * A signal that cannot be read counts as on screen: a Steam update that moves
 * one pauses the share instead of showing what it should not. And the backend
 * shows a picture only once looks on both sides of it saw the game alone, so
 * a look that never arrives pauses it too (py_modules/puca_share.py).
 */

export type PauseReason = 'puca' | 'menu' | 'keyboard' | 'notification' | 'steam';

/** Steam's own app id: its interface, in front whenever a game is not. */
export const STEAM_APPID = 769;

/** How often the screen is looked at while sharing. The backend shows only
 *  what lies between two looks that saw the game alone, no further apart than
 *  puca_share.MAX_GAP_S: a look that is late or lost holds the picture back. */
export const SHARE_POLL_MS = 100;

/** How long after the panel's Share screen the page's request counts as that press. */
export const ARM_MS = 20_000;

/** How long a request the page made by itself waits for an answer in the panel. */
export const ASK_MS = 50_000;

export interface ScreenSignals {
    /** Púca's full view is open. */
    viewOpen: boolean;
    /** Steam's open side menu: 0 for none, else the Steam menu or Quick Access. */
    sideMenu: number | null;
    keyboard: boolean | null;
    notification: boolean | null;
    /** The app gamescope shows in front. */
    focusedAppId: number | null;
}

/** Why the picture must pause now, or null when the game is what is on screen. */
export function pauseReason(s: ScreenSignals): PauseReason | null {
    if (s.viewOpen) return 'puca';
    if (s.sideMenu !== 0) return 'menu';
    if (s.keyboard !== false) return 'keyboard';
    if (s.notification !== false) return 'notification';
    if (s.focusedAppId === null || s.focusedAppId === STEAM_APPID) return 'steam';
    return null;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' ? v as Obj : null);

/** An observable value of Steam's (Value getter, Subscribe): its value, or
 *  undefined when it is not one. */
function observed(v: unknown): unknown {
    const o = obj(v);
    return o && 'Value' in o ? o.Value : undefined;
}

/**
 * Steam's own state, read from Game Mode's main window and its notification
 * store, as SteamOS had them in October 2026 (all read-only):
 *  - MenuStore.m_eOpenSideMenu: 0, or which side menu is open;
 *  - VirtualKeyboardManager.m_bIsVirtualKeyboardShowing: an observable boolean;
 *  - m_CompositionStateStore.m_currentlyFocusedAppid: an observable app id;
 *  - NotificationStore.m_valueCurrentToast: an observable toast, null for none.
 * Anything not found comes back null: "cannot tell".
 */
export function readScreenSignals(mainWindow: unknown, notificationStore: unknown, viewOpen: boolean): ScreenSignals {
    const w = obj(mainWindow);
    const menu = obj(w?.MenuStore ?? w?.m_MenuStore)?.m_eOpenSideMenu;
    const keyboard = observed(obj(w?.VirtualKeyboardManager ?? w?.m_VirtualKeyboardManager)?.m_bIsVirtualKeyboardShowing);
    const focused = observed(obj(w?.m_CompositionStateStore)?.m_currentlyFocusedAppid);
    const toast = observed(obj(notificationStore)?.m_valueCurrentToast);
    return {
        viewOpen,
        sideMenu: typeof menu === 'number' ? menu : null,
        keyboard: typeof keyboard === 'boolean' ? keyboard : null,
        notification: toast === undefined ? null : toast !== null,
        focusedAppId: typeof focused === 'number' ? focused : null,
    };
}

/**
 * Whose press a share request is. The panel's Share screen arms it for the
 * page's next request; a request that arrives unarmed is put to the person
 * in the panel, one at a time.
 */
export class ShareArming {
    private armedUntil = 0;
    private asking: { id: string; until: number } | null = null;

    /** The panel's Share screen was pressed: the page's next request is that press. */
    arm(now: number): void {
        this.armedUntil = now + ARM_MS;
    }

    disarm(): void {
        this.armedUntil = 0;
    }

    /** A request from the page: start it when the panel asked for it;
     *  otherwise ask the person, refusing the request this one replaces. */
    request(id: string, now: number): { start: string } | { ask: string; refuse: string | null } {
        if (now < this.armedUntil) {
            this.armedUntil = 0;
            return { start: id };
        }
        const refuse = this.asking && this.asking.id !== id ? this.asking.id : null;
        this.asking = { id, until: now + ASK_MS };
        return { ask: id, refuse };
    }

    /** The request waiting for the person's answer, if it has not run out. */
    pending(now: number): string | null {
        return this.asking && now < this.asking.until ? this.asking.id : null;
    }

    /** The person answered: the request they answered, if it is still waiting. */
    take(now: number): string | null {
        const id = this.pending(now);
        this.asking = null;
        return id;
    }

    /** A request that has waited too long, to refuse; null when none has. */
    expire(now: number): string | null {
        if (!this.asking || now < this.asking.until) return null;
        const id = this.asking.id;
        this.asking = null;
        return id;
    }

    /** The page gave up on request `id`: true when it was the one waiting. */
    withdraw(id: string): boolean {
        if (this.asking?.id !== id) return false;
        this.asking = null;
        return true;
    }
}
