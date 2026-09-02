// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    eventMatchesBinding,
    matchesRegisteredHotkey,
    registerHold,
    unregisterHold,
    registerPress,
    resetHotkeysForTest,
    nativeKeyEvent,
    setNativeFeedStateForTest,
    handleNativeHotkeyPayload,
    captureBlocker,
    onCaptureBlockerChange,
    setCaptureBlockerForTest,
} from '../api/hotkeys';
import type { KeyBinding } from '../components/settingsStore';

const SPACE: KeyBinding = { keyCode: 32, ctrl: false, alt: false, shift: false, label: 'Space' };
const CTRL_M: KeyBinding = { keyCode: 77, ctrl: true, alt: false, shift: false, label: 'M' };

function key(type: 'keydown' | 'keyup', keyCode: number, opts: Partial<KeyboardEventInit> & { repeat?: boolean } = {}) {
    const e = new KeyboardEvent(type, { bubbles: true, ...opts });
    // KeyboardEventInit has no keyCode; jsdom stores what we define.
    Object.defineProperty(e, 'keyCode', { value: keyCode });
    if (opts.repeat) Object.defineProperty(e, 'repeat', { value: true });
    window.dispatchEvent(e);
}

describe('eventMatchesBinding', () => {
    it('requires the exact modifier set (press actions)', () => {
        expect(eventMatchesBinding({ keyCode: 77, ctrlKey: true, altKey: false, shiftKey: false }, CTRL_M)).toBe(true);
        expect(eventMatchesBinding({ keyCode: 77, ctrlKey: false, altKey: false, shiftKey: false }, CTRL_M)).toBe(false);
        expect(eventMatchesBinding({ keyCode: 77, ctrlKey: true, altKey: true, shiftKey: false }, CTRL_M)).toBe(false);
        expect(eventMatchesBinding({ keyCode: 32, ctrlKey: true, altKey: false, shiftKey: false }, CTRL_M)).toBe(false);
    });

    it('subset mode tolerates extra modifiers (hold actions in games)', () => {
        // Holding PTT (Space) while sprinting with Shift must still transmit.
        expect(eventMatchesBinding({ keyCode: 32, ctrlKey: false, altKey: false, shiftKey: true }, SPACE, 'subset')).toBe(true);
        expect(eventMatchesBinding({ keyCode: 32, ctrlKey: true, altKey: true, shiftKey: true }, SPACE, 'subset')).toBe(true);
        // …but the binding's OWN modifiers are still required.
        expect(eventMatchesBinding({ keyCode: 77, ctrlKey: false, altKey: false, shiftKey: false }, CTRL_M, 'subset')).toBe(false);
        expect(eventMatchesBinding({ keyCode: 77, ctrlKey: true, altKey: false, shiftKey: true }, CTRL_M, 'subset')).toBe(true);
        // Wrong key never matches.
        expect(eventMatchesBinding({ keyCode: 65, ctrlKey: false, altKey: false, shiftKey: true }, SPACE, 'subset')).toBe(false);
    });
});

describe('matchesRegisteredHotkey', () => {
    afterEach(() => resetHotkeysForTest());

    it('matches EXACTLY for both kinds — deliberately narrower than hold dispatch', () => {
        registerPress('t.press', () => CTRL_M, () => { /* noop */ });
        registerHold('t.hold', () => SPACE, { onDown: () => { /* noop */ }, onUp: () => { /* noop */ } });

        // Press: exact modifiers only.
        expect(matchesRegisteredHotkey({ keyCode: 77, ctrlKey: true, altKey: false, shiftKey: false })).toBe(true);
        expect(matchesRegisteredHotkey({ keyCode: 77, ctrlKey: true, altKey: false, shiftKey: true }),
            'extra Shift must NOT claim a press binding — dispatch would not fire it').toBe(false);
        // Hold: the bare binding matches…
        expect(matchesRegisteredHotkey({ keyCode: 32, ctrlKey: false, altKey: false, shiftKey: false })).toBe(true);
        // …but extra modifiers do NOT, even though hold DISPATCH subset-
        // matches them: a PTT on bare V must not swallow Ctrl+V from the
        // remote-control stage (paste would silently stop reaching the host).
        expect(matchesRegisteredHotkey({ keyCode: 32, ctrlKey: false, altKey: false, shiftKey: true })).toBe(false);
        // Unrelated key (positive control that false is reachable).
        expect(matchesRegisteredHotkey({ keyCode: 65, ctrlKey: false, altKey: false, shiftKey: false })).toBe(false);
    });

    it('matches nothing when nothing is registered', () => {
        expect(matchesRegisteredHotkey({ keyCode: 77, ctrlKey: true, altKey: false, shiftKey: false })).toBe(false);
    });
});

describe('hold actions', () => {
    let downs = 0;
    let ups = 0;

    beforeEach(() => {
        downs = 0; ups = 0;
        registerHold('t.hold', () => SPACE, {
            onDown: () => { downs++; },
            onUp: () => { ups++; },
        });
    });
    afterEach(() => resetHotkeysForTest());

    it('fires onDown once per press and onUp on release', () => {
        key('keydown', 32);
        key('keydown', 32, { repeat: true }); // OS auto-repeat
        key('keydown', 32, { repeat: true });
        expect(downs).toBe(1);
        expect(ups).toBe(0);
        key('keyup', 32);
        expect(ups).toBe(1);
    });

    it('releases the key on keyup even if modifiers changed mid-hold', () => {
        key('keydown', 32);
        key('keyup', 32, { shiftKey: true }); // let go of Space after pressing Shift
        expect(ups).toBe(1);
    });

    it('releases on window blur — never a stuck mic across alt-tab', () => {
        key('keydown', 32);
        window.dispatchEvent(new Event('blur'));
        expect(ups).toBe(1);
        // A later keyup for the already-released key must not double-fire.
        key('keyup', 32);
        expect(ups).toBe(1);
    });

    it('unregister releases a held key', () => {
        key('keydown', 32);
        unregisterHold('t.hold');
        expect(ups).toBe(1);
    });

    it('ignores non-matching keys', () => {
        key('keydown', 65);
        expect(downs).toBe(0);
    });

    it('fires a plain-key hold even while a game modifier is held', () => {
        // Regression: exact modifier matching meant Space+Shift (sprinting)
        // silently failed to open the mic — exactly when you are talking.
        key('keydown', 32, { shiftKey: true });
        expect(downs).toBe(1);
        key('keyup', 32, { shiftKey: true });
        expect(ups).toBe(1);
    });

    it('accepts native hook events through the same registry', () => {
        nativeKeyEvent('down', { keyCode: 32, ctrlKey: false, altKey: false, shiftKey: false });
        expect(downs).toBe(1);
        nativeKeyEvent('up', { keyCode: 32, ctrlKey: false, altKey: false, shiftKey: false });
        expect(ups).toBe(1);
    });

    it('native PRESS actions fire despite extra game modifiers (crouch/sprint)', () => {
        // Regression (reported as "mic hotkeys sometimes work, sometimes
        // don't"): toggle-mute via the GLOBAL hook was exact-matched, so a
        // Ctrl held to crouch — or Shift to sprint — at the moment the combo
        // was pressed silently vetoed it. On the native feed the app has no
        // focus by definition (nobody is typing in it), so the in-app
        // typing-protection rationale for exact matching does not apply.
        let toggles = 0;
        registerPress('t.gametoggle',
            () => ({ keyCode: 77, ctrl: false, alt: false, shift: false, label: 'M' }),
            () => { toggles++; });
        // Plain M bound; pressed with Ctrl held (crouching): must still fire.
        nativeKeyEvent('down', { keyCode: 77, ctrlKey: true, altKey: false, shiftKey: false });
        expect(toggles).toBe(1);
        // And with Shift (sprinting).
        nativeKeyEvent('down', { keyCode: 77, ctrlKey: false, altKey: false, shiftKey: true });
        expect(toggles).toBe(2);
        // A binding WITH modifiers still requires its own: bare M must not
        // fire a Ctrl+Shift+M binding.
        let combo = 0;
        registerPress('t.gamecombo',
            () => ({ keyCode: 68, ctrl: true, alt: false, shift: true, label: 'D' }),
            () => { combo++; });
        nativeKeyEvent('down', { keyCode: 68, ctrlKey: false, altKey: false, shiftKey: false });
        expect(combo).toBe(0);
        nativeKeyEvent('down', { keyCode: 68, ctrlKey: true, altKey: false, shiftKey: true });
        expect(combo).toBe(1);
        // The IN-APP path keeps exact matching — Ctrl+M while a plain-M
        // binding exists is typing/another command, not this hotkey.
        key('keydown', 77, { ctrlKey: true });
        expect(toggles).toBe(2);
    });

    it('scopes native dispatch to the allowed actions only', () => {
        // The native feed is restricted to voice actions — a global keypress
        // must not trigger unrelated actions sharing the same key.
        nativeKeyEvent('down', { keyCode: 32, ctrlKey: false, altKey: false, shiftKey: false },
            new Set(['some.other.action']));
        expect(downs).toBe(0);
        nativeKeyEvent('down', { keyCode: 32, ctrlKey: false, altKey: false, shiftKey: false },
            new Set(['t.hold']));
        expect(downs).toBe(1);
    });

    it('reads the binding per event, so a rebind applies live', () => {
        let binding = SPACE;
        registerHold('t.rebind', () => binding, {
            onDown: () => { downs += 10; },
            onUp: () => { /* not asserted */ },
        });
        binding = { keyCode: 66, ctrl: false, alt: false, shift: false, label: 'B' };
        key('keydown', 32); // old key: matches t.hold (downs+1) but not t.rebind
        key('keydown', 66); // new key: t.rebind only
        expect(downs).toBe(11);
    });
});

describe('press actions', () => {
    afterEach(() => resetHotkeysForTest());

    it('suppresses plain keys in editable targets but allows modified ones', () => {
        let plain = 0;
        let modified = 0;
        registerPress('t.plain', () => ({ keyCode: 75, ctrl: false, alt: false, shift: false, label: 'K' }), () => { plain++; });
        registerPress('t.mod', () => CTRL_M, () => { modified++; });

        const input = document.createElement('input');
        document.body.appendChild(input);
        const onInput = (type: 'keydown', keyCode: number, init: KeyboardEventInit) => {
            const e = new KeyboardEvent(type, { bubbles: true, ...init });
            Object.defineProperty(e, 'keyCode', { value: keyCode });
            input.dispatchEvent(e);
        };
        onInput('keydown', 75, {});                  // typing "k" in the input
        onInput('keydown', 77, { ctrlKey: true });   // Ctrl+M in the input
        expect(plain).toBe(0);
        expect(modified).toBe(1);
        key('keydown', 75); // outside an input, plain fires
        expect(plain).toBe(1);
        input.remove();
    });
});

/**
 * Bindings are UNSET by default now and every one can be cleared with the
 * trash control, so "no binding" is the common case rather than an edge case.
 * An unbound action must match nothing at all — and must not throw, which
 * matters because loadSettings() spreads a JSON.parse and its `any` hides
 * these dereferences from the typechecker.
 */
describe('unbound keybinds', () => {
    beforeEach(() => resetHotkeysForTest());
    afterEach(() => resetHotkeysForTest());

    it('matches no event', () => {
        expect(eventMatchesBinding({ keyCode: 32, ctrlKey: false, altKey: false, shiftKey: false }, null)).toBe(false);
        expect(eventMatchesBinding({ keyCode: 0, ctrlKey: false, altKey: false, shiftKey: false }, null)).toBe(false);
        expect(eventMatchesBinding({ keyCode: 32, ctrlKey: false, altKey: false, shiftKey: false }, undefined)).toBe(false);
    });

    it('never fires a hold action, and keyup does not throw', () => {
        let downs = 0, ups = 0;
        registerHold('test.unbound', () => null, { onDown: () => downs++, onUp: () => ups++ });
        key('keydown', 32);
        key('keyup', 32);
        expect(downs).toBe(0);
        expect(ups).toBe(0);
        unregisterHold('test.unbound');
    });

    it('never fires a press action', () => {
        let presses = 0;
        registerPress('test.unboundPress', () => null, () => presses++);
        key('keydown', 77, { ctrlKey: true });
        expect(presses).toBe(0);
    });

    it('ignores the native feed for an unbound action', () => {
        let downs = 0;
        registerHold('test.unboundNative', () => null, { onDown: () => downs++, onUp: () => { } });
        // (Was called with the wrong signature — one object — which routed
        // to the 'up' branch and could never have fired anything.)
        nativeKeyEvent('down', { keyCode: 32, ctrlKey: false, altKey: false, shiftKey: false });
        expect(downs).toBe(0);
        unregisterHold('test.unboundNative');
    });
});

describe('press ownership while the native feed is live', () => {
    afterEach(() => resetHotkeysForTest());

    it('positive control: without a native feed, the in-app keydown fires a press', () => {
        let presses = 0;
        registerPress('voice.toggleMute', () => CTRL_M, () => presses++);
        key('keydown', 77, { ctrlKey: true });
        expect(presses).toBe(1);
    });

    it('the in-app keydown swallows the key but leaves the ACTION to the native feed', () => {
        let presses = 0;
        registerPress('voice.toggleMute', () => CTRL_M, () => presses++);
        setNativeFeedStateForTest(true, ['voice.toggleMute']);
        const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ctrlKey: true });
        Object.defineProperty(e, 'keyCode', { value: 77 });
        window.dispatchEvent(e);
        expect(presses, 'one keystroke must not toggle twice: native owns it').toBe(0);
        expect(e.defaultPrevented, 'the keystroke is still swallowed in-app').toBe(true);
        // The native feed then delivers the same key-down: exactly one fire.
        nativeKeyEvent('down', { keyCode: 77, ctrlKey: true, altKey: false, shiftKey: false },
            new Set(['voice.toggleMute']), { foreground: true });
        expect(presses).toBe(1);
    });

    it('a press the native feed does NOT cover still fires in-app', () => {
        let presses = 0;
        registerPress('app.other', () => CTRL_M, () => presses++);
        setNativeFeedStateForTest(true, ['voice.toggleMute']);
        key('keydown', 77, { ctrlKey: true });
        expect(presses).toBe(1);
    });

    it('holds are dispatched by both feeds and stay idempotent', () => {
        let downs = 0, ups = 0;
        registerHold('voice.ptt', () => SPACE, { onDown: () => downs++, onUp: () => ups++ });
        setNativeFeedStateForTest(true, ['voice.ptt']);
        key('keydown', 32);                       // in-app sees the press first
        nativeKeyEvent('down', { keyCode: 32, ctrlKey: false, altKey: false, shiftKey: false },
            new Set(['voice.ptt']), { foreground: true });
        expect(downs).toBe(1);
        // Released after alt-tabbing away: only the native feed sees it.
        nativeKeyEvent('up', { keyCode: 32, ctrlKey: false, altKey: false, shiftKey: false },
            new Set(['voice.ptt']), { foreground: false });
        expect(ups).toBe(1);
        key('keyup', 32);                         // a late in-app keyup is harmless
        expect(ups).toBe(1);
    });

    it('a native press is NEVER dropped for the app being in front (the old focus rule)', () => {
        let presses = 0;
        registerPress('voice.toggleMute', () => CTRL_M, () => presses++);
        nativeKeyEvent('down', { keyCode: 77, ctrlKey: true, altKey: false, shiftKey: false },
            undefined, { foreground: true });
        nativeKeyEvent('down', { keyCode: 77, ctrlKey: true, altKey: false, shiftKey: false },
            undefined, { foreground: false });
        expect(presses).toBe(2);
    });

    it('in front with the caret in an editable field, a PLAIN bound key is typing', () => {
        const M: KeyBinding = { keyCode: 77, ctrl: false, alt: false, shift: false, label: 'M' };
        let presses = 0;
        registerPress('voice.toggleMute', () => M, () => presses++);
        const input = document.createElement('input');
        document.body.appendChild(input);
        input.focus();
        expect(document.activeElement).toBe(input);
        nativeKeyEvent('down', { keyCode: 77, ctrlKey: false, altKey: false, shiftKey: false },
            undefined, { foreground: true });
        expect(presses, 'typing an M into the composer must not toggle the mic').toBe(0);
        // The same key from a game (not in front) is the hotkey.
        nativeKeyEvent('down', { keyCode: 77, ctrlKey: false, altKey: false, shiftKey: false },
            undefined, { foreground: false });
        expect(presses).toBe(1);
        // And a Ctrl combo fires even from the composer, as in-app.
        registerPress('voice.toggleDeafen', () => CTRL_M, () => presses++);
        nativeKeyEvent('down', { keyCode: 77, ctrlKey: true, altKey: false, shiftKey: false },
            undefined, { foreground: true });
        expect(presses).toBe(2);
        input.remove();
    });
});

describe('capture blocker (elevated foreground process)', () => {
    afterEach(() => resetHotkeysForTest());

    it('reports the process, notifies on change only, and clears', () => {
        const seen: string[] = [];
        const off = onCaptureBlockerChange(p => seen.push(p));
        expect(captureBlocker()).toBe('');
        setCaptureBlockerForTest('game.exe');
        setCaptureBlockerForTest('game.exe'); // same answer: no second notification
        expect(captureBlocker()).toBe('game.exe');
        setCaptureBlockerForTest('');
        expect(captureBlocker()).toBe('');
        expect(seen).toEqual(['game.exe', '']);
        off();
        setCaptureBlockerForTest('other.exe');
        expect(seen, 'unsubscribed').toEqual(['game.exe', '']);
    });
});

// The two rules above, exercised through the PAYLOAD HANDLER the Tauri
// listener actually calls, and on MOUSE bindings — the two places where the
// suite could previously go green over a broken feed. The old focus gate
// lived inside the listener callback, not in nativeKeyEvent, so a test that
// called nativeKeyEvent directly could not see it come back.
describe('the native payload handler (what the Tauri listener calls)', () => {
    afterEach(() => resetHotkeysForTest());

    const payload = (over: Partial<{ keyCode: number; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; down: boolean; foreground: boolean }> = {}) => ({
        keyCode: 77, ctrlKey: true, altKey: false, shiftKey: false, down: true, foreground: false, ...over,
    });

    it('dispatches whether or not Púca is the foreground window', () => {
        let presses = 0;
        registerPress('voice.toggleMute', () => CTRL_M, () => presses++);
        setNativeFeedStateForTest(true, ['voice.toggleMute']);
        handleNativeHotkeyPayload(payload({ foreground: false }));
        handleNativeHotkeyPayload(payload({ foreground: true }));
        expect(presses, 'a focus test here is exactly what killed hotkeys in a game').toBe(2);
    });

    it('drops everything while the feed is not live', () => {
        let presses = 0;
        registerPress('voice.toggleMute', () => CTRL_M, () => presses++);
        setNativeFeedStateForTest(false, ['voice.toggleMute']);
        handleNativeHotkeyPayload(payload());
        expect(presses).toBe(0);
    });

    it('drops everything before a start is acknowledged (no allow-list)', () => {
        // nativeAllow null with the feed live would dispatch to EVERY
        // registered action — including in-app-only ones this feed must
        // never touch.
        let presses = 0;
        registerPress('app.openSettings', () => CTRL_M, () => presses++);
        setNativeFeedStateForTest(true, null);
        handleNativeHotkeyPayload(payload());
        expect(presses).toBe(0);
    });

    it('only fires the actions the feed covers', () => {
        let mine = 0, theirs = 0;
        registerPress('voice.toggleMute', () => CTRL_M, () => mine++);
        registerPress('app.openSettings', () => CTRL_M, () => theirs++);
        setNativeFeedStateForTest(true, ['voice.toggleMute']);
        handleNativeHotkeyPayload(payload());
        expect(mine).toBe(1);
        expect(theirs, 'an in-app-only action must never fire from the global hook').toBe(0);
    });
});

describe('mouse-bound press actions and the native feed', () => {
    afterEach(() => resetHotkeysForTest());

    const MOUSE4: KeyBinding = { keyCode: 5, ctrl: false, alt: false, shift: false, label: 'Mouse 4' };
    const clickMouse4 = () => {
        const e = new MouseEvent('mousedown', { button: 3, bubbles: true, cancelable: true });
        window.dispatchEvent(e);
        return e;
    };

    it('positive control: with no native feed, a click fires the press', () => {
        let presses = 0;
        registerPress('voice.toggleMute', () => MOUSE4, () => presses++);
        clickMouse4();
        expect(presses).toBe(1);
    });

    it('one click does not toggle twice while the feed is live', () => {
        let presses = 0;
        registerPress('voice.toggleMute', () => MOUSE4, () => presses++);
        setNativeFeedStateForTest(true, ['voice.toggleMute']);
        const e = clickMouse4();
        expect(presses, 'the in-app path must leave the action to the native feed').toBe(0);
        expect(e.defaultPrevented, 'the button must still not double as UI input').toBe(true);
        handleNativeHotkeyPayload({ keyCode: 5, ctrlKey: false, altKey: false, shiftKey: false, down: true, foreground: true });
        expect(presses).toBe(1);
    });

    it('fires with the caret in the composer — a button is not typing', () => {
        // The editable-target rule is about a letter that would be typed.
        // Applied to a mouse button it made the bind dead: in-app deferred
        // to the native feed, and the native feed vetoed it as typing.
        let presses = 0;
        registerPress('voice.toggleMute', () => MOUSE4, () => presses++);
        setNativeFeedStateForTest(true, ['voice.toggleMute']);
        const input = document.createElement('input');
        document.body.appendChild(input);
        input.focus();
        expect(document.activeElement).toBe(input);
        clickMouse4();
        handleNativeHotkeyPayload({ keyCode: 5, ctrlKey: false, altKey: false, shiftKey: false, down: true, foreground: true });
        expect(presses, 'a mouse hotkey must work while the composer has focus').toBe(1);
        input.remove();
    });
});

describe('modifier matching depends on who is in front', () => {
    afterEach(() => resetHotkeysForTest());

    const D: KeyBinding = { keyCode: 68, ctrl: false, alt: false, shift: false, label: 'D' };
    const CTRL_SHIFT_D: KeyBinding = { keyCode: 68, ctrl: true, alt: false, shift: true, label: 'D' };

    it('in front, a modified keystroke does not also fire the plain-key action', () => {
        let mute = 0, deafen = 0;
        registerPress('voice.toggleMute', () => D, () => mute++);
        registerPress('voice.toggleDeafen', () => CTRL_SHIFT_D, () => deafen++);
        setNativeFeedStateForTest(true, ['voice.toggleMute', 'voice.toggleDeafen']);
        handleNativeHotkeyPayload({ keyCode: 68, ctrlKey: true, altKey: false, shiftKey: true, down: true, foreground: true });
        expect(deafen).toBe(1);
        expect(mute, 'one keystroke must not run two commands').toBe(0);
    });

    it('in a game, extra modifiers still do not veto a plain binding', () => {
        // The whole reason the native path subset-matches: crouch on Ctrl,
        // sprint on Shift, and the toggle must still work.
        let mute = 0;
        registerPress('voice.toggleMute', () => D, () => mute++);
        setNativeFeedStateForTest(true, ['voice.toggleMute']);
        handleNativeHotkeyPayload({ keyCode: 68, ctrlKey: true, altKey: false, shiftKey: true, down: true, foreground: false });
        expect(mute).toBe(1);
    });

    it('holds keep subset matching whoever is in front', () => {
        let downs = 0;
        registerHold('voice.ptt', () => SPACE, { onDown: () => downs++, onUp: () => { } });
        setNativeFeedStateForTest(true, ['voice.ptt']);
        handleNativeHotkeyPayload({ keyCode: 32, ctrlKey: true, altKey: false, shiftKey: true, down: true, foreground: true });
        expect(downs, 'push-to-talk must never need bare modifiers').toBe(1);
    });
});
