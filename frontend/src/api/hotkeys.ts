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
 * you hold PTT *while typing* — and never preventDefault, so the key still
 * types. Press actions are suppressed in editable targets unless the binding
 * carries a modifier (Ctrl+M in the composer is a command; plain M is typing).
 *
 * Bindings are read through a getter on every event, not captured at register
 * time, so a rebind in Settings applies immediately without re-registering.
 *
 * Two feeds, one registry:
 *  - the in-app window keydown/keyup pair below (always on), and
 *  - the NATIVE feed (desktop only): a Rust WH_KEYBOARD_LL hook that reports
 *    watched-key transitions system-wide, so push-to-talk keeps working while
 *    a fullscreen game has focus. startNativeFeed()/stopNativeFeed() manage
 *    it; events are dropped while Puca has focus (the in-app listener
 *    already saw the same physical keys — processing both would double-fire).
 */
import type { KeyBinding } from '../components/settingsStore';
import { isTauri } from './platform';
import { BUTTON_TO_VK, VK_LBUTTON } from './inputCodes';

type HoldHandler = {
    onDown: () => void;
    onUp: () => void;
};

type HoldEntry = {
    getBinding: () => KeyBinding | null;
    handler: HoldHandler;
    held: boolean;
};

type PressEntry = {
    getBinding: () => KeyBinding | null;
    onPress: () => void;
};

const holdActions = new Map<string, HoldEntry>();
const pressActions = new Map<string, PressEntry>();

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

export function isEditableTarget(t: EventTarget | null): boolean {
    if (!(t instanceof HTMLElement)) return false;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return true;
    return t.isContentEditable;
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
 * action first — otherwise a PTT key held while it is rebound has no release
 * path at all: keyup matches against the NEW binding's keyCode, and on desktop
 * the native hook has already swapped its watch list, so the mic stays open.
 */
export function setHotkeyCaptureMode(on: boolean): void {
    if (captureMode === on) return;
    captureMode = on;
    if (on) releaseAll();
}

function onKeyDown(e: KeyboardEvent): void {
    if (captureMode) return;
    for (const entry of holdActions.values()) {
        // Repeats keep arriving while held — only the first press transitions.
        if (entry.held || e.repeat) continue;
        if (eventMatchesBinding(e, entry.getBinding(), 'subset')) {
            entry.held = true;
            entry.handler.onDown();
        }
    }
    if (e.repeat) return;
    for (const entry of pressActions.values()) {
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
        entry.onPress();
    }
}

function onKeyUp(e: KeyboardEvent): void {
    if (captureMode) return;
    for (const entry of holdActions.values()) {
        // Release on the KEY alone, ignoring modifier state: the user may have
        // let go of Shift before the main key, and a hold must never stick.
        if (entry.held && e.keyCode === entry.getBinding()?.keyCode) {
            entry.held = false;
            entry.handler.onUp();
        }
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
    if (!vkIsBound(vk)) return;
    const evt = { keyCode: vk, ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey };
    let matched = false;
    for (const entry of holdActions.values()) {
        if (entry.held) continue;
        if (eventMatchesBinding(evt, entry.getBinding(), 'subset')) {
            entry.held = true;
            entry.handler.onDown();
            matched = true;
        }
    }
    for (const entry of pressActions.values()) {
        if (eventMatchesBinding(evt, entry.getBinding())) {
            entry.onPress();
            matched = true;
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
    if (captureMode) return;
    const vk = BUTTON_TO_VK[e.button];
    if (vk === undefined || vk === VK_LBUTTON) return;
    let wasHeld = false;
    for (const entry of holdActions.values()) {
        if (entry.held && vk === entry.getBinding()?.keyCode) {
            entry.held = false;
            entry.handler.onUp();
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

/** Release everything held — no stuck mic when no feed can see the keyup. */
function releaseAll(): void {
    for (const entry of holdActions.values()) {
        if (entry.held) {
            entry.held = false;
            entry.handler.onUp();
        }
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
export function registerHold(id: string, getBinding: () => KeyBinding | null, handler: HoldHandler): void {
    ensureListeners();
    unregisterHold(id);
    holdActions.set(id, { getBinding, handler, held: false });
}

/** Unregister a hold action, releasing it if currently held. */
export function unregisterHold(id: string): void {
    const entry = holdActions.get(id);
    if (entry?.held) {
        entry.held = false;
        entry.handler.onUp();
    }
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
}, only?: Set<string>): void {
    // Same suspension as the in-app feed: a key pressed to BE a binding must
    // not also run the action it is replacing.
    if (captureMode) return;
    if (kind === 'down') {
        for (const [id, entry] of holdActions) {
            if (only && !only.has(id)) continue;
            if (!entry.held && eventMatchesBinding(key, entry.getBinding(), 'subset')) {
                entry.held = true;
                entry.handler.onDown();
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
            if (eventMatchesBinding(key, entry.getBinding(), 'subset')) entry.onPress();
        }
    } else {
        for (const [id, entry] of holdActions) {
            if (only && !only.has(id)) continue;
            if (entry.held && key.keyCode === entry.getBinding()?.keyCode) {
                entry.held = false;
                entry.handler.onUp();
            }
        }
    }
}

// --- Native (desktop-global) feed ------------------------------------------

let nativeFeedActive = false;
let nativeUnlisten: (() => void) | null = null;
let nativeAllow: Set<string> | null = null;
/** In-flight start, so overlapping calls can't double-register a listener. */
let nativeStartInFlight: Promise<void> | null = null;
/** Bumped per start; a call superseded while awaiting the previous one bails. */
let nativeFeedGeneration = 0;

/**
 * Start (or reconfigure) the desktop-global key feed: the Rust hook watches
 * exactly `watchedKeys` (VK codes) and reports their transitions; matching
 * events dispatch to the actions in `actionIds` only. Safe to call again with
 * new lists — a rebind mid-call just swaps the watch list. No-op on web.
 */
export async function startNativeFeed(actionIds: string[], watchedKeys: number[]): Promise<void> {
    if (!isTauri()) return;
    nativeAllow = new Set(actionIds);
    // Serialize overlapping starts. A settings save can fire start #1 while a
    // React effect re-run fires stop + start #2 in the same task, and both
    // would see nativeUnlisten === null across their awaits and register a
    // SECOND listener — every native key then dispatched twice (a PTT release
    // could arrive after a re-press and cut the mic mid-sentence).
    const gen = ++nativeFeedGeneration;
    if (nativeStartInFlight) await nativeStartInFlight.catch(() => { /* prior attempt failed */ });
    if (gen !== nativeFeedGeneration) return; // superseded while we waited
    nativeStartInFlight = (async () => {
        const { invoke } = await import('@tauri-apps/api/core');
        // TRUE only when a hook is really watching (non-Windows desktop and a
        // refused hook both report false) — believing otherwise would disable
        // the blur safety net and leave push-to-talk stuck open on alt-tab.
        const hooked = await invoke<boolean>('start_hotkey_listener', { keys: watchedKeys.filter(k => k > 0) });
        if (!hooked) {
            console.warn('[hotkeys] no global hook on this platform — keys work while focused');
            nativeFeedActive = false;
            return;
        }
        if (!nativeUnlisten) {
            const { listen } = await import('@tauri-apps/api/event');
            nativeUnlisten = await listen<{
                keyCode: number; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; down: boolean;
            }>('global-hotkey', (e) => {
                if (!nativeFeedActive) return;
                // Log BEFORE the focus gate (low-volume by construction:
                // watched keys only, edges only). This is the observable a live
                // verification needs — and note a CDP-attached debugger
                // (Playwright) force-emulates focus, which makes hasFocus()
                // lie `true`; keep that in mind when reading these lines.
                const suppressed = document.hasFocus();
                console.log('[hotkeys] native', e.payload.down ? 'down' : 'up', e.payload.keyCode,
                    suppressed ? '(suppressed: app focused)' : '');
                // Focus dedupe: while Puca has focus the in-app listener
                // saw the same physical key — process each press exactly once.
                if (suppressed) return;
                nativeKeyEvent(e.payload.down ? 'down' : 'up', e.payload, nativeAllow ?? undefined);
            });
        }
        nativeFeedActive = true;
        console.log('[hotkeys] native feed watching VKs:', watchedKeys.filter(k => k > 0).join(','));
    })();
    try {
        await nativeStartInFlight;
    } catch (err) {
        // Best-effort, like the kill-switch guard: without the hook, hotkeys
        // still work while the app has focus. nativeFeedActive stays false so
        // the blur handler keeps its release-on-focus-loss safety net.
        nativeFeedActive = false;
        console.warn('[hotkeys] native feed unavailable:', err);
    } finally {
        if (gen === nativeFeedGeneration) nativeStartInFlight = null;
    }
}

/** Stop the desktop-global feed and release anything it held. No-op on web. */
export async function stopNativeFeed(): Promise<void> {
    if (!isTauri()) return;
    nativeFeedGeneration++; // cancel any start still waiting its turn
    nativeStartInFlight = null;
    nativeFeedActive = false;
    nativeAllow = null;
    if (nativeUnlisten) {
        nativeUnlisten();
        nativeUnlisten = null;
    }
    // No feed can see further keyups — never leave a hold stuck.
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
}

// Read-only diagnostics for live verification (devtools/CDP): whether the
// desktop-global feed runs, which actions it feeds, and what's registered.
if (typeof window !== 'undefined') {
    (window as unknown as Record<string, unknown>).__pucaHotkeysDebug = {
        nativeFeedActive: () => nativeFeedActive,
        allowedActions: () => (nativeAllow ? [...nativeAllow] : null),
        registered: () => ({ hold: [...holdActions.keys()], press: [...pressActions.keys()] }),
    };
}
