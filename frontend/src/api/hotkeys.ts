/**
 * In-app hotkey registry.
 *
 * One capture-phase keydown/keyup pair on `window` dispatches to registered
 * actions, instead of every feature adding its own listener. Two action kinds:
 *
 *  - HOLD actions (push-to-talk, push-to-mute): onDown fires on the first
 *    keydown (repeats ignored), onUp on keyup. A window `blur` releases every
 *    held action — alt-tabbing away with the PTT key down must not leave the
 *    mic stuck open (or stuck muted).
 *  - PRESS actions (toggle mute, open settings, …): fire once per keydown.
 *
 * Hold actions deliberately keep working while an input/textarea has focus —
 * you hold PTT *while typing* — and never preventDefault there, so the key still
 * types. Anywhere else a hold on Space or Enter does (swallowsHoldKey): those
 * two press whatever has the focus. Press actions are suppressed in editable
 * targets unless the binding carries a modifier (Ctrl+M in the composer is a
 * command; plain M is typing).
 *
 * Bindings are read through a getter on every event, not captured at register
 * time, so a rebind in Settings applies immediately without re-registering. A
 * hold in progress is the exception: it ends when the key that STARTED it comes
 * up, whatever the binding says by then, and a save that moves its binding to
 * another key ends it on the spot.
 *
 * Two feeds, one registry:
 *  - the in-app window keydown/keyup pair below (always on), and
 *  - the NATIVE feed (desktop only): the Rust hooks plus key-state poll in
 *    src-tauri/src/hotkeys.rs report watched-key transitions system-wide, so
 *    push-to-talk keeps working while a fullscreen game has focus.
 *    startNativeFeed()/stopNativeFeed() manage it.
 *
 * Who owns what while the native feed is LIVE. It sees every transition of
 * a watched key, including the ones typed into this window, so:
 *  - PRESS actions it covers are dispatched from the native feed ONLY; the
 *    in-app listener still swallows the keystroke (preventDefault) but does
 *    not fire the action. One owner, so a toggle can never fire twice for
 *    one keystroke — and no focus test decides anything. The previous rule
 *    dropped native events while `document.hasFocus()` was true, an answer
 *    the WebView gives from its own bookkeeping (forced true under a
 *    debugger, not the OS's view of the foreground window); whenever it was
 *    wrong, every hotkey was dead in the game. The native event now carries
 *    `foreground` from GetForegroundWindow, used only for the editable-
 *    target rule (a plain key typed into the composer is typing).
 *  - HOLD actions are dispatched by both feeds; `held` makes that
 *    idempotent, and a release is honoured from whichever feed sees it
 *    (press in the game, release after alt-tabbing back, or the reverse).
 *    One release is not taken at its word: with a window in front that hides
 *    every key the native side cannot tell up from unknown, and marks what it
 *    sends. An action whose hold is the safe state keeps holding through that
 *    (HoldOptions); the real answer follows once the keys can be read.
 *
 * The native feed also reports when capture is IMPOSSIBLE: the foreground
 * window belongs to a process running above ours (a game launched "as
 * administrator"), whose input Windows routes to no lower process by any
 * method. captureBlocker()/onCaptureBlockerChange() expose that to the UI.
 */
import type { KeyBinding } from '../components/settingsStore';
import { isTauri } from './platform';
import { BUTTON_TO_VK, VK_LBUTTON, isMouseVk } from './inputCodes';

type HoldHandler = {
    onDown: () => void;
    onUp: () => void;
};

type HoldEntry = {
    getBinding: () => KeyBinding | null;
    handler: HoldHandler;
    held: boolean;
    /** The key or button that took it down: the one whose release ends it. The
     *  binding can change while it is held, and matching a release against the
     *  binding as it is NOW left a hold with no release at all. Unset for a
     *  host's hold, which has no key. */
    heldKey?: number;
    /** Held by an embedding host's own button (holdFromHost), not a key: a
     *  window blur does not release it, the host's lease does (embedApi.ts).
     *  Cleared by every release, whichever feed delivers it. */
    byHost?: boolean;
    keepOnBlockedRelease: boolean;
};

export type HoldOptions = {
    /**
     * Holding is the safe state, so a release nobody can vouch for does not end
     * it: push-to-mute, where letting go opens the microphone. Such a release
     * comes from the native feed while a window hides every key, when the key may
     * well still be down (hotkeys.rs, "A blank table is not a release"). The
     * native side sends the real one once the keys can be read again. Push-to-talk
     * leaves this off: there, closing at once costs nothing.
     */
    keepOnBlockedRelease?: boolean;
};

type PressEntry = {
    getBinding: () => KeyBinding | null;
    onPress: () => void;
};

const holdActions = new Map<string, HoldEntry>();
const pressActions = new Map<string, PressEntry>();

function pressHold(entry: HoldEntry, key: number): void {
    entry.held = true;
    entry.heldKey = key;
    entry.handler.onDown();
}

function releaseHold(entry: HoldEntry): void {
    entry.held = false;
    entry.byHost = false;
    entry.heldKey = undefined;
    entry.handler.onUp();
}

/** Is this key going up the end of this hold? On the KEY alone, ignoring
 *  modifier state: the user may have let go of Shift before the main key, and a
 *  hold must never stick. A host's hold has no key of its own, and the bound
 *  key's release ends it too, as every release does. */
function endsHold(entry: HoldEntry, key: number): boolean {
    return entry.held && key === (entry.heldKey ?? entry.getBinding()?.keyCode);
}

/** A line for puca.log (and the console): action names only, never a key. */
function logHotkeyNote(line: string): void {
    console.log(line);
    if (!isTauri()) return;
    void import('@tauri-apps/api/core')
        .then(({ invoke }) => invoke('log_stream_diag', { line }))
        .catch(() => { /* best effort: a missing line is not worth an error */ });
}

/**
 * Does this event match the binding?
 *
 * PRESS actions demand the exact modifier set, so Ctrl+Shift+K can't fire a
 * plain-K binding. HOLD actions (push-to-talk / push-to-mute) require only
 * that the binding's OWN modifiers are held, ignoring extras: you hold PTT
 * while sprinting with Shift, or strafing with Ctrl, and the mic must open.
 * Exact matching there meant a Space binding silently failed the moment any
 * game modifier was down — precisely when you're talking.
 */
export function eventMatchesBinding(
    e: { keyCode: number; ctrlKey: boolean; altKey: boolean; shiftKey: boolean },
    b: KeyBinding | null | undefined,
    mode: 'exact' | 'subset' = 'exact',
): boolean {
    // Unbound (null) matches NOTHING. Bindings are unset by default and can be
    // cleared from Settings, so every matcher has to tolerate absence rather
    // than assume a keyCode exists.
    if (!b) return false;
    if (e.keyCode !== b.keyCode) return false;
    if (mode === 'subset') {
        // Every modifier the binding requires must be held; extras are fine.
        return (!b.ctrl || e.ctrlKey) && (!b.alt || e.altKey) && (!b.shift || e.shiftKey);
    }
    return e.ctrlKey === b.ctrl && e.altKey === b.alt && e.shiftKey === b.shift;
}

/**
 * Is a key typed here typing, not a command? An input, a textarea, editable
 * text — or anything inside `[data-owns-keys]`: a question that took the
 * focus off the field a paste went into, so that a reflexive Enter answers
 * nothing (components/PastedLinesDialog.tsx). The keys were typing a moment
 * ago and still are not commands — not a bare-key press here, nor Notes'
 * single-key shortcuts or its Ctrl+A over the page behind the question.
 */
export function isEditableTarget(t: EventTarget | null): boolean {
    if (!(t instanceof HTMLElement)) return false;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return true;
    return t.isContentEditable || t.closest('[data-owns-keys]') !== null;
}

/** The <input>s that Space or Enter press. Every other kind is a field. */
const PRESSED_INPUT_TYPES = new Set(['button', 'checkbox', 'color', 'file', 'image', 'radio', 'reset', 'submit']);
const VK_RETURN = 13;
const VK_SPACE = 32;
const pressesControls = (e: KeyboardEvent) => e.keyCode === VK_SPACE || e.keyCode === VK_RETURN;

/**
 * Must this keydown of a hold's key be kept from what has the focus?
 *
 * Space and Enter press a focused control, so a push-to-talk on one clicked it
 * on every press, anywhere in the app: the Mute button, a checkbox, and through
 * the mode selector (a click no pointer counted, which reads as a key's) its menu,
 * then Off, then the question's OK. So they are swallowed, except where they type.
 * That is narrower than isEditableTarget, which is about what is a command: to it
 * a checkbox and a button inside [data-owns-keys] are typing, and these keys press
 * both. Any other key's default stays, a Tab or an Escape bound as a hold among them.
 *
 * Every keydown of it, the repeats too, and the keydown is all it takes. Measured
 * in Edge, Firefox and WebKit (e2e/user-menu-move-to-real-browser.mjs): a prevented
 * keydown brings no keypress, which is Enter's click, and leaves no button armed for
 * Space's click at the key-up. One repeat let through arms it, or clicks. A handler
 * of a control's own has to ask e.defaultPrevented: this stops the browser, not them.
 */
function swallowsHoldKey(e: KeyboardEvent): boolean {
    if (!pressesControls(e)) return false;
    const t = e.target;
    if (t instanceof HTMLTextAreaElement) return false;
    if (t instanceof HTMLInputElement) return PRESSED_INPUT_TYPES.has(t.type);
    return !(t instanceof HTMLElement && t.isContentEditable);
}

/**
 * Would this key event fire a REGISTERED action right now?
 *
 * For the remote-control stage, which forwards every injectable key to the
 * controlled machine: a bound hotkey must act locally exactly once, not also
 * be typed into the remote PC (toggle mute both muting you AND typing M into
 * the game was the reported "hotkeys are janky").
 *
 * DELIBERATELY NARROWER than dispatch for hold actions: dispatch subset-
 * matches them (PTT on V must open the mic even with Shift held for sprint),
 * but suppression here uses EXACT matching for both kinds — with the subset
 * rule, a PTT bound to bare V swallowed Ctrl+V, so pasting into the remote
 * machine silently did nothing. Exact means bare V is suppressed (the PTT key
 * is not typed remotely) while Ctrl+V still reaches the host; the mic also
 * opening on Ctrl+V is dispatch's long-standing subset behaviour, unchanged.
 */
export function matchesRegisteredHotkey(
    e: { keyCode: number; ctrlKey: boolean; altKey: boolean; shiftKey: boolean },
): boolean {
    if (captureMode) return false;
    for (const entry of holdActions.values()) {
        if (eventMatchesBinding(e, entry.getBinding())) return true;
    }
    for (const entry of pressActions.values()) {
        if (eventMatchesBinding(e, entry.getBinding())) return true;
    }
    return false;
}

/**
 * While Settings is capturing a new binding, dispatch is suspended.
 *
 * stopPropagation in the capture handler cannot achieve this: the registry's
 * listeners go on `window` in the capture phase at app start, BEFORE the
 * modal's, and stopPropagation never suppresses a listener already registered
 * on the same target and phase. So pressing Ctrl+D to rebind Toggle Deafen
 * actually deafened you mid-call, and pressing Space pulsed the mic open.
 */
let captureMode = false;

/**
 * Suspend (or resume) hotkey dispatch. Entering capture releases every held
 * action first: dispatch is suspended from here on, so a key held now would
 * come up unheard and the mic would stay open.
 */
export function setHotkeyCaptureMode(on: boolean): void {
    if (captureMode === on) return;
    captureMode = on;
    if (on) releaseAll();
}

/**
 * Keys pressed to BE a binding, until they come up: key -> when to stop waiting.
 *
 * Capture ends the moment the bind is saved, and that save starts watching the
 * key. A press normally lasts longer than the 40 ms the poll takes to notice a
 * watched key that is down, so the same keystroke arrived as a press the hook
 * missed, with capture over: rebinding Toggle Mute unmuted a muted member. The
 * native side cannot tell, and must not try: a key that joins the list while
 * someone really is holding it to talk should reach the page. Only this file
 * knows that this one was already spent on being captured.
 */
const spentKeys = new Map<number, number>();
/** Only for a key-up nobody hears (released with an elevated window in front). A
 *  hold outlasting this is still fine: the poll's press comes once, early on. */
const SPENT_KEY_MAX_MS = 5_000;
/** The in-app key-up can overtake the native feed's press for the same keystroke,
 *  which is already on its way. The native key-up cannot: that channel is ordered. */
const SPENT_KEY_AFTER_IN_APP_UP_MS = 150;

/** This key ended a capture. Called before the save that starts watching it. */
export function markKeySpentByCapture(key: number): void {
    spentKeys.set(key, Date.now() + SPENT_KEY_MAX_MS);
}

function keyIsSpent(key: number): boolean {
    const until = spentKeys.get(key);
    if (until === undefined) return false;
    if (Date.now() < until) return true;
    spentKeys.delete(key);
    return false;
}

function spentKeyUpInApp(key: number): void {
    if (spentKeys.has(key)) spentKeys.set(key, Date.now() + SPENT_KEY_AFTER_IN_APP_UP_MS);
}

function onKeyDown(e: KeyboardEvent): void {
    if (captureMode) return;
    // A first press in this window (not a repeat) is a new keystroke, whatever
    // happened to the last one's key-up.
    if (!e.repeat) spentKeys.delete(e.keyCode);
    // A repeat acts on nothing. These two are heard only to keep them from what has the focus.
    if (e.repeat && !pressesControls(e)) return;
    for (const entry of holdActions.values()) {
        if (!eventMatchesBinding(e, entry.getBinding(), 'subset')) continue;
        if (swallowsHoldKey(e)) e.preventDefault();
        // Repeats keep arriving while held — only the first press transitions.
        if (entry.held || e.repeat) continue;
        pressHold(entry, e.keyCode);
    }
    for (const [id, entry] of pressActions) {
        const b = entry.getBinding();
        // eventMatchesBinding already rejects an unbound action, so b is real
        // past this point — but narrow it explicitly rather than assert.
        if (!b || !eventMatchesBinding(e, b)) continue;
        // DELIBERATELY excludes Shift: Shift+M in a composer is typing a
        // capital M, not a command — only Ctrl/Alt make a combo commandlike
        // enough to fire from an editable field.
        const hasModifier = b.ctrl || b.alt;
        if (isEditableTarget(e.target) && !hasModifier) continue;
        e.preventDefault();
        // Only swallowed: held down, Space or Enter would press a focused button
        // with their repeats, though the first keydown was swallowed.
        if (e.repeat) continue;
        // The keystroke is still swallowed above; the ACTION belongs to the
        // native feed when it is live, which saw this very key-down through
        // the hook. Firing here too would toggle twice.
        if (nativeOwnsPress(id)) continue;
        entry.onPress();
    }
}

/**
 * Whether a live native feed dispatches this press action — in which case
 * the in-app listeners must not, or one keystroke fires it twice.
 *
 * `nativeAllow` is the set the native side has CONFIRMED it is watching, not
 * the set we asked for: a start widens it only once the hook is really
 * looking at those keys, so the in-app feed keeps a press it would otherwise
 * hand to a hook that has not been told about it yet.
 */
function nativeOwnsPress(id: string): boolean {
    const owned = nativeFeedActive && nativeAllow !== null && nativeAllow.has(id);
    if (owned) ownershipDeferrals++;
    return owned;
}

/**
 * Presses the in-app feed stood down from, and presses the native feed
 * actually dispatched. In the diag side by side: if the first climbs while
 * the second does not, the native side has gone silent and the ownership
 * rule is eating keystrokes — the one failure this design can have.
 */
let ownershipDeferrals = 0;
let nativeDispatches = 0;

function onKeyUp(e: KeyboardEvent): void {
    spentKeyUpInApp(e.keyCode);
    if (captureMode) return;
    for (const entry of holdActions.values()) {
        if (endsHold(entry, e.keyCode)) releaseHold(entry);
    }
}

/** Whether any registered hold/press action is currently bound to this VK. */
function vkIsBound(vk: number): boolean {
    for (const entry of holdActions.values()) {
        if (entry.getBinding()?.keyCode === vk) return true;
    }
    for (const entry of pressActions.values()) {
        if (entry.getBinding()?.keyCode === vk) return true;
    }
    return false;
}

// --- Mouse-button feed (in-app / web path; the native hook covers unfocused
// desktop). A button rides the same VK space as keys (BUTTON_TO_VK), so the
// hold/press machinery is reused via a synthesized structural event.
//
// Swallowing is gated on a MATCH, not on "the button appears in some
// binding": a button bound WITH modifiers must keep behaving like a plain
// button when clicked WITHOUT them (a bare swallow made it dead in both
// roles). The follow-up gestures (auxclick; contextmenu — unreachable today
// since right can't be captured, kept for safety) are swallowed only within
// a short window after a matched press.
const recentMouseMatch = new Map<number, number>(); // vk -> ts of last match
const MOUSE_FOLLOWUP_WINDOW_MS = 700;

function onMouseDown(e: MouseEvent): void {
    if (captureMode) return;
    const vk = BUTTON_TO_VK[e.button];
    if (vk === undefined || vk === VK_LBUTTON) return; // left is never a hotkey
    spentKeys.delete(vk); // a new press, as in onKeyDown
    if (!vkIsBound(vk)) return;
    const evt = { keyCode: vk, ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey };
    let matched = false;
    for (const entry of holdActions.values()) {
        if (entry.held) continue;
        if (eventMatchesBinding(evt, entry.getBinding(), 'subset')) {
            pressHold(entry, vk);
            matched = true;
        }
    }
    for (const [id, entry] of pressActions) {
        if (eventMatchesBinding(evt, entry.getBinding())) {
            matched = true; // swallowed either way; fired by ONE owner
            if (!nativeOwnsPress(id)) entry.onPress();
        }
    }
    if (!matched) {
        // The follow-up window belongs to the LAST press: an unmatched press
        // (modifier-bound button clicked bare) must not have its auxclick
        // eaten by an earlier matched press's window.
        recentMouseMatch.delete(vk);
        return;
    }
    recentMouseMatch.set(vk, Date.now());
    // A button acting as a hotkey must not double as UI input: X buttons
    // trigger history back/forward in the webview, and document-level
    // "click outside" closers would dismiss menus on every PTT press.
    e.preventDefault();
    e.stopPropagation();
}

function onMouseUp(e: MouseEvent): void {
    const vk = BUTTON_TO_VK[e.button];
    if (vk === undefined || vk === VK_LBUTTON) return;
    spentKeyUpInApp(vk);
    if (captureMode) return;
    let wasHeld = false;
    for (const entry of holdActions.values()) {
        if (endsHold(entry, vk)) {
            releaseHold(entry);
            wasHeld = true;
        }
    }
    if (wasHeld) {
        recentMouseMatch.set(vk, Date.now());
        e.preventDefault();
        e.stopPropagation();
    }
}

/** Swallow the follow-up gestures of a press that ACTED as a hotkey. */
function onMouseAux(e: MouseEvent): void {
    if (captureMode) return;
    const vk = BUTTON_TO_VK[e.button];
    if (vk === undefined || vk === VK_LBUTTON) return;
    const ts = recentMouseMatch.get(vk);
    if (ts !== undefined && Date.now() - ts < MOUSE_FOLLOWUP_WINDOW_MS) {
        e.preventDefault();
        e.stopPropagation();
    }
}

/** Release everything held — no stuck mic when no feed can see the keyup.
 *  Not a host's hold: no key is involved, and its lease ends it. */
function releaseAll(): void {
    for (const entry of holdActions.values()) {
        if (entry.held && !entry.byHost) releaseHold(entry);
    }
}

/**
 * A save took the key out from under a hold: the trash button or Reset on the
 * Keybinds tab while it is down (neither goes through capture). That key no
 * longer means this action, so the hold ends now. With the binding cleared
 * nothing else could ever have ended it: no press can reach an unbound action.
 * A change of modifiers alone leaves the same key to come up, and it will.
 */
function releaseHoldsWhoseKeyChanged(): void {
    for (const [id, entry] of holdActions) {
        if (!entry.held || entry.byHost || entry.getBinding()?.keyCode === entry.heldKey) continue;
        logHotkeyNote(`[hotkeys] ${id} released: its keybind changed while it was held`);
        releaseHold(entry);
    }
}

let listenersInstalled = false;
function ensureListeners(): void {
    if (listenersInstalled || typeof window === 'undefined') return;
    listenersInstalled = true;
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('mousedown', onMouseDown, true);
    window.addEventListener('mouseup', onMouseUp, true);
    window.addEventListener('auxclick', onMouseAux, true);
    window.addEventListener('contextmenu', onMouseAux, true);
    window.addEventListener('settingsChanged', releaseHoldsWhoseKeyChanged);
    // Blur releases held keys ONLY while the in-app listener is the sole feed:
    // without the native hook, alt-tabbing away means we'd never see the
    // keyup. With the native feed running, the global hook still sees it —
    // releasing on blur there would break exactly the "hold PTT while the
    // game has focus" case the native feed exists for.
    window.addEventListener('blur', () => {
        if (!nativeFeedActive) releaseAll();
    });
}

/**
 * Register a hold action. `getBinding` is consulted per event so rebinds in
 * Settings take effect live. Re-registering an id replaces the old entry
 * (releasing it first if held).
 */
export function registerHold(id: string, getBinding: () => KeyBinding | null, handler: HoldHandler, options: HoldOptions = {}): void {
    ensureListeners();
    unregisterHold(id);
    holdActions.set(id, { getBinding, handler, held: false, keepOnBlockedRelease: options.keepOnBlockedRelease === true });
}

/** Unregister a hold action, releasing it if currently held. */
export function unregisterHold(id: string): void {
    const entry = holdActions.get(id);
    if (entry?.held) releaseHold(entry);
    holdActions.delete(id);
}

/** Register a press (fire-once) action. Re-registering an id replaces it. */
export function registerPress(id: string, getBinding: () => KeyBinding | null, onPress: () => void): void {
    ensureListeners();
    pressActions.set(id, { getBinding, onPress });
}

export function unregisterPress(id: string): void {
    pressActions.delete(id);
}

/**
 * An embedding host's own button holding a hold action (docs/EMBEDDING.md):
 * Púca for Steam Deck's push-to-talk on a back button. By action id, not by
 * key: the host has no key, and must reach only the action it names. Returns
 * false when that action is not registered (no call, another input mode), so
 * nothing is held. embedApi.ts leases the hold, since no window event can
 * release it.
 */
export function holdFromHost(id: string, down: boolean): boolean {
    const entry = holdActions.get(id);
    if (!entry) return false;
    if (down && !entry.held) {
        entry.held = true;
        entry.byHost = true;
        entry.handler.onDown();
    } else if (!down && entry.held && entry.byHost) {
        releaseHold(entry);
    }
    return true;
}

/**
 * Entry point for the desktop native hook (global hotkeys while a game has
 * focus). The Rust side reports raw down/up transitions; repeats are already
 * collapsed there. Editable-target suppression doesn't apply — by definition
 * the app doesn't have focus. `only` limits dispatch to the named actions:
 * the native feed is scoped to VOICE actions, so a global keypress can never
 * trigger in-app-only shortcuts (opening Settings from inside a game would
 * just be confusing) even if they share a key with a voice binding.
 */
export function nativeKeyEvent(kind: 'down' | 'up', key: {
    keyCode: number; ctrlKey: boolean; altKey: boolean; shiftKey: boolean;
}, only?: Set<string>, opts?: {
    /** Our window was the OS foreground window when the edge was delivered. */
    foreground?: boolean;
    /** A release made while a window hides every key: see HoldOptions. */
    blocked?: boolean;
}): void {
    if (kind === 'up') spentKeys.delete(key.keyCode);
    // Same suspension as the in-app feed: a key pressed to BE a binding must
    // not also run the action it is replacing. That covers the whole keystroke,
    // and capture is usually over before it is (spentKeys).
    if (captureMode) return;
    if (kind === 'down') {
        if (keyIsSpent(key.keyCode)) return;
        for (const [id, entry] of holdActions) {
            if (only && !only.has(id)) continue;
            if (!entry.held && eventMatchesBinding(key, entry.getBinding(), 'subset')) {
                pressHold(entry, key.keyCode);
            }
        }
        for (const [id, entry] of pressActions) {
            if (only && !only.has(id)) continue;
            // SUBSET here, unlike the in-app feed's exact match. Exact
            // matching exists to keep a plain-M binding from firing on Ctrl+M
            // while TYPING in the app — but on this feed the app does not
            // have focus by definition: the user is in a game, holding Ctrl
            // to crouch or Shift to sprint, and pressing their toggle-mute
            // combo. Exact matching silently vetoed the press whenever any
            // extra game modifier happened to be down — the field report was
            // "hotkeys sometimes work, sometimes don't". Same rationale as
            // the hold actions' long-standing subset rule, applied to the
            // same situation.
            const b = entry.getBinding();
            // SUBSET only when the app is NOT in front. Subset exists for the
            // game case above; applied while Púca is the foreground window it
            // makes this feed fire bindings the in-app listener would have
            // rejected — press Ctrl+Shift+D for a Ctrl+Shift+D action and a
            // bare-D action fires too, so one keystroke runs two commands.
            // In front, match exactly what the in-app listener would.
            if (!b || !eventMatchesBinding(key, b, opts?.foreground ? 'exact' : 'subset')) continue;
            // The in-app listener's editable-target rule, decided from the
            // OS's answer about the foreground window rather than from the
            // WebView's idea of focus: with Púca in front and the caret in
            // the composer, a plain bound letter is typing, not a command.
            // Ctrl/Alt combos fire regardless, exactly as in-app.
            //
            // MOUSE BUTTONS ARE EXEMPT. A button never types a character, so
            // the rule has nothing to say about it — and the in-app mouse
            // path has no such rule either. Applying it here made a
            // mouse-bound toggle dead whenever the caret sat in the
            // composer: in-app deferred to this feed, and this feed vetoed
            // it as "typing", so neither owner fired.
            if (opts?.foreground && !isMouseVk(b.keyCode) && typeof document !== 'undefined'
                && isEditableTarget(document.activeElement) && !(b.ctrl || b.alt)) continue;
            nativeDispatches++;
            entry.onPress();
        }
    } else {
        // `only` does not apply: it keeps a global key from STARTING an action
        // the feed does not cover, and a release starts nothing. It has to get
        // through, because a save narrows the list before it re-registers, and
        // the release the native side owes for a key it stops watching arrives
        // after that (hotkeys.rs, rewrite_watch).
        for (const entry of holdActions.values()) {
            if (opts?.blocked && entry.keepOnBlockedRelease) continue;
            if (endsHold(entry, key.keyCode)) releaseHold(entry);
        }
    }
}

// --- Native (desktop-global) feed ------------------------------------------

let nativeFeedActive = false;
let nativeUnlisten: (() => void) | null = null;
let blockedUnlisten: (() => void) | null = null;
let nativeAllow: Set<string> | null = null;

// --- Capture blocker (UIPI) --------------------------------------------------
//
// The native side polls the foreground process while the feed is live and
// reports the executable name when that process runs ABOVE our integrity
// level (launched "as administrator"). Windows routes none of its input to
// a lower process — hooks, raw input and the key-state table are all blind
// — so voice hotkeys cannot work while it is in front, and nothing here can
// change that. The UI shows it (HotkeyBlockedBanner) so the user learns the
// cause the moment they come back to Púca asking why the mic stayed shut.

let captureBlockerName = '';
/** How many times one has come to the front since this page loaded. The name
 *  clears on an ordinary click or at the end of the call; a report is often made
 *  after both, about something that happened during them. */
let captureBlockerSeen = 0;
const blockerListeners = new Set<(process: string) => void>();

function setCaptureBlocker(process: string): void {
    if (process === captureBlockerName) return;
    captureBlockerName = process;
    if (process) {
        captureBlockerSeen++;
        console.warn(`[hotkeys] ${process} runs above our integrity level: Windows hides its input from every capture method; voice hotkeys cannot work while it is in front`);
    } else {
        console.log('[hotkeys] foreground input reachable again');
    }
    for (const cb of blockerListeners) cb(process);
}

/**
 * What the `global-hotkey` listener does with one payload — a named function
 * so the rule can be tested without a Tauri runtime. The old focus gate lived
 * exactly here (`if (document.hasFocus()) return;`), where no test could see
 * it; that is why every hotkey could die in a game with the suite green.
 *
 * Nothing is dropped for focus. Events are dropped only when the feed is not
 * live, or before a start has been confirmed — `nativeAllow === null` there,
 * and dispatching with no allow-list would fire EVERY registered action,
 * including the in-app-only ones this feed must never touch.
 */
export function handleNativeHotkeyPayload(payload: {
    keyCode: number; ctrlKey: boolean; altKey: boolean; shiftKey: boolean;
    down: boolean; foreground?: boolean; blocked?: boolean;
}): void {
    if (!nativeFeedActive || nativeAllow === null) return;
    // Low-volume by construction (watched keys only, edges only): this line
    // is the observable a live verification reads.
    console.log('[hotkeys] native', payload.down ? 'down' : 'up', payload.keyCode,
        payload.foreground ? '(app in front)' : '', payload.blocked ? '(keys hidden)' : '');
    nativeKeyEvent(payload.down ? 'down' : 'up', payload, nativeAllow,
        { foreground: payload.foreground === true, blocked: payload.blocked === true });
}

/** The foreground process whose input is invisible to us (runs elevated), or ''. */
export function captureBlocker(): string {
    return captureBlockerName;
}

/** Subscribe to blocker changes; returns the unsubscribe. */
export function onCaptureBlockerChange(cb: (process: string) => void): () => void {
    blockerListeners.add(cb);
    return () => { blockerListeners.delete(cb); };
}
/** In-flight start, so overlapping calls can't double-register a listener. */
let nativeStartInFlight: Promise<void> | null = null;
/** Bumped per start; a call superseded while awaiting the previous one bails. */
let nativeFeedGeneration = 0;

/**
 * What the feed was last ASKED to watch, whether or not that start went
 * through — a superseded or refused start leaves nativeAllow describing a
 * feed that never installed, so the two are reported side by side.
 */
let lastRequested: { ids: string[]; keys: number[] } | null = null;

/**
 * The last few start/stop calls with their reasons. Exists because the feed
 * used to stop SILENTLY: "never started" and "started, then stopped" produced
 * the same console (nothing), and that fork is exactly what could not be
 * answered when the report was "hotkeys work in Púca and die when another
 * window has focus".
 */
type FeedLogEntry = {
    at: number; kind: 'start' | 'stop'; reason: string;
    ids: string[] | null; keys: number[] | null; result: string;
};
const FEED_LOG_MAX = 40;
const feedLog: FeedLogEntry[] = [];
function recordFeed(kind: FeedLogEntry['kind'], reason: string, watch: { ids: string[]; keys: number[] } | null, result: string): void {
    feedLog.push({
        at: Math.round(performance.now()), kind, reason,
        ids: watch ? [...watch.ids] : null, keys: watch ? [...watch.keys] : null, result,
    });
    if (feedLog.length > FEED_LOG_MAX) feedLog.splice(0, feedLog.length - FEED_LOG_MAX);
}

/**
 * The host (VoicePanel) lends the diag the inputs its feed decision is made
 * from — in-call state, bindings, the last computed watch list. A provider
 * callback rather than an import: VoicePanel imports this module, not the
 * other way round.
 */
export type NativeFeedHostSnapshot = Record<string, unknown>;
let hostProvider: (() => NativeFeedHostSnapshot) | null = null;
export function setNativeFeedHost(provider: (() => NativeFeedHostSnapshot) | null): void {
    hostProvider = provider;
}

/**
 * A re-registration failed while the feed was live: no native key-up can come
 * from here on, and the app may not have focus for the in-app one. The blur
 * safety net cannot cover it, since that blur already happened with the feed
 * live. Same reasoning as a stop. With no live feed nothing changed, and the
 * in-app listeners still own whatever they hold.
 */
function nativeFeedFell(): void {
    const wasLive = nativeFeedActive;
    nativeFeedActive = false;
    if (wasLive && [...holdActions.values()].some(e => e.held && !e.byHost)) {
        logHotkeyNote('[hotkeys] released what was held: the native feed could not be re-registered');
        releaseAll();
    }
}

/**
 * Start (or reconfigure) the desktop-global key feed: the Rust hook watches
 * exactly `watchedKeys` (VK codes) and reports their transitions; matching
 * events dispatch to the actions in `actionIds` only. Safe to call again with
 * new lists — a rebind mid-call just swaps the watch list. No-op on web.
 */
export async function startNativeFeed(actionIds: string[], watchedKeys: number[]): Promise<void> {
    if (!isTauri()) return;
    lastRequested = { ids: [...actionIds], keys: [...watchedKeys] };
    // NARROW now, WIDEN on acknowledgement. An action that is no longer
    // covered must return to the in-app feed immediately; one that is newly
    // covered must stay with the in-app feed until the hook has actually
    // been told to watch its key, or the in-app listener stands down for a
    // press nothing else is listening for (the clip key gaining coverage
    // mid-call, a rebind, a reconfigure — all real paths).
    const wanted = new Set(actionIds);
    if (nativeAllow) nativeAllow = new Set([...nativeAllow].filter(id => wanted.has(id)));
    // Serialize overlapping starts. A settings save can fire start #1 while a
    // React effect re-run fires stop + start #2 in the same task, and both
    // would see nativeUnlisten === null across their awaits and register a
    // SECOND listener — every native key then dispatched twice (a PTT release
    // could arrive after a re-press and cut the mic mid-sentence).
    const gen = ++nativeFeedGeneration;
    if (nativeStartInFlight) await nativeStartInFlight.catch(() => { /* prior attempt failed */ });
    if (gen !== nativeFeedGeneration) {
        // A newer start, or a stop, took over while we waited: nothing was
        // invoked for THIS request.
        recordFeed('start', 'superseded while waiting', { ids: actionIds, keys: watchedKeys }, 'skipped');
        return;
    }
    nativeStartInFlight = (async () => {
        const { invoke } = await import('@tauri-apps/api/core');
        // TRUE only when a hook is really watching (non-Windows desktop and a
        // refused hook both report false) — believing otherwise would disable
        // the blur safety net and leave push-to-talk stuck open on alt-tab.
        const hooked = await invoke<boolean>('start_hotkey_listener', { keys: watchedKeys.filter(k => k > 0) });
        if (!hooked) {
            console.warn('[hotkeys] no global hook on this platform — keys work while focused');
            recordFeed('start', 'sync', { ids: actionIds, keys: watchedKeys }, 'refused: no hook');
            nativeFeedFell();
            return;
        }
        // Superseded while the command was in flight (a stop, or a newer
        // start): this request owns nothing. Without this the IIFE ran on
        // past its own stop — resurrecting nativeFeedActive over a torn-down
        // hook, and registering a listener nothing could ever remove.
        if (gen !== nativeFeedGeneration) {
            recordFeed('start', 'superseded after invoke', { ids: actionIds, keys: watchedKeys }, 'skipped');
            return;
        }
        if (!nativeUnlisten || !blockedUnlisten) {
            const { listen } = await import('@tauri-apps/api/event');
            if (!nativeUnlisten) {
                const un = await listen<{
                    keyCode: number; ctrlKey: boolean; altKey: boolean; shiftKey: boolean;
                    down: boolean; foreground: boolean; blocked: boolean;
                }>('global-hotkey', (e) => handleNativeHotkeyPayload(e.payload));
                // Never overwrite a live handle: the overwritten one stays
                // subscribed and unreachable, and every key is then
                // dispatched twice — a toggle mutes and instantly unmutes.
                if (gen !== nativeFeedGeneration || nativeUnlisten) un();
                else nativeUnlisten = un;
            }
            if (!blockedUnlisten) {
                const un = await listen<{ process: string }>('global-hotkey-blocked', (e) => {
                    setCaptureBlocker(typeof e.payload?.process === 'string' ? e.payload.process : '');
                });
                if (gen !== nativeFeedGeneration || blockedUnlisten) un();
                else blockedUnlisten = un;
            }
            if (gen !== nativeFeedGeneration) {
                recordFeed('start', 'superseded while subscribing', { ids: actionIds, keys: watchedKeys }, 'skipped');
                return;
            }
        }
        // Acknowledged: the hook is watching these keys, so the native feed
        // may now own their press actions.
        nativeAllow = wanted;
        nativeFeedActive = true;
        // Pairs, not bare VKs: the reader wants to know WHICH action a key is for.
        console.log('[hotkeys] native feed watching:', actionIds.map((id, i) => `${id}=${watchedKeys[i]}`).join(' '));
        recordFeed('start', 'sync', { ids: actionIds, keys: watchedKeys }, 'hooked');
    })();
    try {
        await nativeStartInFlight;
    } catch (err) {
        // Best-effort, like the kill-switch guard: without the hook, hotkeys
        // still work while the app has focus. nativeFeedActive stays false so
        // the blur handler keeps its release-on-focus-loss safety net.
        nativeFeedFell();
        console.warn('[hotkeys] native feed unavailable:', err);
        recordFeed('start', 'sync', { ids: actionIds, keys: watchedKeys }, 'error: ' + String(err));
    } finally {
        if (gen === nativeFeedGeneration) nativeStartInFlight = null;
    }
}

/** Stop the desktop-global feed and release anything it held. No-op on web. */
export async function stopNativeFeed(reason = 'unspecified'): Promise<void> {
    if (!isTauri()) return;
    // Logged on the SUCCESS path too. A stop used to be silent, which left
    // "the feed never started" and "it started and something stopped it"
    // with the same console output: none.
    console.log('[hotkeys] native feed stop:', reason, nativeFeedActive ? '(was live)' : '(was not live)');
    recordFeed('stop', reason, lastRequested, nativeFeedActive ? 'was live' : 'was not live');
    nativeFeedGeneration++; // cancel any start still waiting its turn
    nativeStartInFlight = null;
    nativeFeedActive = false;
    nativeAllow = null;
    if (nativeUnlisten) {
        nativeUnlisten();
        nativeUnlisten = null;
    }
    if (blockedUnlisten) {
        blockedUnlisten();
        blockedUnlisten = null;
    }
    // The native side forgets the blocker with the feed; so do we, or the
    // banner would outlive the call it was about.
    setCaptureBlocker('');
    // No feed can see further keyups — never leave a hold stuck. hotkeys.rs
    // stop() clears its bits without a word, relying on exactly this.
    releaseAll();
    try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('stop_hotkey_listener');
    } catch (err) {
        console.warn('[hotkeys] stopping native feed failed:', err);
    }
}

/** Test hook: clear all registrations and held state. */
export function resetHotkeysForTest(): void {
    releaseAll();
    holdActions.clear();
    pressActions.clear();
    nativeFeedActive = false;
    nativeAllow = null;
    captureMode = false;
    setCaptureBlocker('');
    captureBlockerSeen = 0;
    // Module state that outlived a reset and leaked between tests: a
    // subscriber for an unmounted banner, a mouse follow-up window, a
    // start still in flight.
    blockerListeners.clear();
    recentMouseMatch.clear();
    spentKeys.clear();
    nativeStartInFlight = null;
    lastRequested = null;
    feedLog.length = 0;
    ownershipDeferrals = 0;
    nativeDispatches = 0;
}

/**
 * Test hook: pretend the native feed is live for these action ids (or not),
 * without a Tauri runtime. What startNativeFeed() sets on success.
 */
export function setNativeFeedStateForTest(active: boolean, allow: string[] | null): void {
    nativeFeedActive = active;
    nativeAllow = allow ? new Set(allow) : null;
}

/** Test hook: what the `global-hotkey-blocked` listener does with a payload. */
export function setCaptureBlockerForTest(process: string): void {
    setCaptureBlocker(process);
}

// Read-only diagnostics for live verification (devtools/CDP): whether the
// desktop-global feed runs, which actions it feeds, and what's registered.
//
//   await __pucaHotkeysDebug.snapshot()      (DevTools; in a call or not)
//
// ONE call, both halves. Reading it:
//   host: null                     -> the voice panel is not mounted at all
//   host.isInVoice false           -> not in a call; the feed is call-scoped
//                                     by design, so this is the healthy idle
//   host.lastComputed.ids empty    -> in a call, but no bind qualified for
//                                     system-wide: look at host.bindings,
//                                     host.voiceBindsUserSet and
//                                     host.globalVoiceHotkeys (the rule is
//                                     api/hotkeyScope.ts); listenOnly or
//                                     isAfkChannel true drops the mic keys
//   log                            -> the start/stop sequence with reasons:
//                                     separates "never started" from
//                                     "started, then stopped"
//   native.starts / native.stops   -> the same fork from the Rust side, so a
//                                     start that never reached IPC shows
//   native.hook_live false         -> asked for, but SetWindowsHookExW failed
//   native.watching missing a VK   -> the bind never reached the native side
//   native.events_seen stuck at 0  -> installed but receiving nothing
//   native.events_seen rising      -> the hook sees the key; a later stage
//                                     drops it (a different bug)
//   native.rearms                  -> times the watchdog re-installed the hook
//   feed.held with native.down_bits 0 and native.releases_owed 0
//                                  -> the page holds a key the native side
//                                     does not: a release nothing will send
//
// Reached through this object, not window.__TAURI__: withGlobalTauri is off
// on purpose (it would hand full IPC to any injected script), so `invoke`
// only exists in module code like this. On a build without snapshot(),
// `await window.__TAURI_INTERNALS__.invoke('hotkey_diag')` gives the native
// half alone.
export async function nativeDiag(): Promise<unknown> {
    if (!isTauri()) return { platform: 'web', note: 'no native hook in a browser' };
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke('hotkey_diag');
}

/**
 * What the registry and the feed believe right now, for the debug snapshot and
 * for the diagnostics report (hotkeyReport.ts). Action names, the keys the person
 * bound, counts: nothing in this file ever records any other key, so nothing here
 * can hand one on.
 */
export function hotkeyFeedState() {
    let host: NativeFeedHostSnapshot | null = null;
    try {
        host = hostProvider ? hostProvider() : null;
    } catch (err) {
        host = { error: String(err) };
    }
    return {
        // On the same clock as `log[].at`, which means nothing without it.
        now: Math.round(performance.now()),
        host,
        active: nativeFeedActive,
        requested: lastRequested,
        allowed: nativeAllow ? [...nativeAllow] : null,
        registered: { hold: [...holdActions.keys()], press: [...pressActions.keys()] },
        // Held right now, by action. Beside native.down_bits it says which side
        // believes what: held with no bit down is the page waiting on a release
        // nothing is going to send.
        held: [...holdActions].filter(([, e]) => e.held).map(([id]) => id),
        // Non-empty: the app in front runs elevated; no capture method can see
        // its keys. Not a fault in the feed.
        blocker: captureBlockerName,
        // How many times one has come to the front since the page loaded.
        blockerSeen: captureBlockerSeen,
        // Presses the in-app feed handed to the native feed, and presses the
        // native feed actually fired. The first climbing alone means the native
        // side went quiet.
        ownershipDeferrals,
        nativeDispatches,
        log: [...feedLog],
    };
}

export type HotkeyFeedState = ReturnType<typeof hotkeyFeedState>;

if (typeof window !== 'undefined') {
    (window as unknown as Record<string, unknown>).__pucaHotkeysDebug = {
        nativeFeedActive: () => nativeFeedActive,
        allowedActions: () => (nativeAllow ? [...nativeAllow] : null),
        registered: () => ({ hold: [...holdActions.keys()], press: [...pressActions.keys()] }),
        /** The native half alone — what the low-level hook itself believes. */
        native: nativeDiag,
        /** Everything, in one call. See the reading guide above. */
        snapshot: async () => {
            const { host, log, ...feed } = hotkeyFeedState();
            return { host, feed, log, native: await nativeDiag() };
        },
    };
}
