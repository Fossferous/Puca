/**
 * PINNED KEYS: keys (or chords) the user chose to keep on the remote-control
 * stage as buttons, like the virtual mouse's L / M / R — and up to three of
 * them as buttons in the Android notification while a session is live
 * (shadeKeys.ts).
 *
 * WHAT CAN BE PINNED IS WHAT THE HOST CAN TYPE. Every code here must pass
 * `isInjectableKey` (pointerMapping.ts) AND be mapped by `code_to_vk` in
 * crates/puca-input: a code that fails either travels the whole way and is
 * dropped at the far end with nothing shown to the user. pinnedKeys.test.ts
 * checks the catalogue against both. That rules out, today:
 *
 *   - media and volume keys (play/pause, next, mute, volume): the host maps
 *     no VK_MEDIA_* / VK_VOLUME_* code, so offering them would be offering a
 *     button that does nothing. They need a change to Púca on the computer
 *     (crates/puca-input), not just here;
 *   - F25 and up (the host maps F1-F24), Fn (keyboard firmware, no key code);
 *   - Pause / Break: the Windows host maps it and then refuses it ("no scan
 *     code for Pause" — its make code is three scan codes long, and the
 *     crate's own test asserts the refusal), so it would be a dead button.
 *
 * A LINUX host maps fewer keys still (linux_impl.rs code_to_keysym has no
 * Print Screen, Scroll Lock, Num Lock or Menu); the editor says so rather
 * than hide keys a Windows host types.
 *
 * TWO CHORDS WINDOWS KEEPS FOR ITSELF. Ctrl + Alt + Delete chosen as a key
 * with modifiers becomes the Secure Attention pin below (as three injected
 * keys it does nothing). Win + L is refused: Windows does not lock for an
 * injected Win + L (remote-desktop hosts call LockWorkStation instead), and
 * the More menu's Lock is that call.
 *
 * CTRL+ALT+DEL IS ITS OWN PIN. Windows ignores injected keys for the Secure
 * Attention Sequence by design, so the chord Ctrl + Alt + Delete would press
 * three keys and do nothing. The pin sends the `{t:'sas'}` frame instead —
 * the one the More menu sends — which the host hands to the Púca system
 * service. (A refusal comes back as the session's own error line.)
 *
 * STORED LIKE THE MOUSE PAD: one list in localStorage for this browser, not
 * per computer — `device-stage-virtual-mouse` and the pad positions are
 * global the same way, and a key you reach for on one PC (F5, Ctrl+Alt+Del)
 * is usually the key you reach for on the next.
 */

export type PinMod = 'win' | 'ctrl' | 'alt' | 'shift';

/** A pinned key. `code` is a `KeyboardEvent.code` from KEY_CATALOG, or
 *  SAS_CODE. `mods` are held around the key (ignored for SAS). `shade` puts
 *  it in the Android notification. `id` is stable for the pin's life — the
 *  notification's buttons carry it, never the key itself. */
export interface PinnedKey {
    id: string;
    code: string;
    mods: PinMod[];
    shade: boolean;
}

/** Ctrl+Alt+Del, sent as the host's Secure Attention frame. */
export const SAS_CODE = 'SecureAttention';

/** A row of 46 px buttons wraps at ~6 on a phone; twelve is two rows, which is
 *  as much of the remote screen as a cluster should cover. */
export const MAX_PINS = 12;
/** A standard Android notification shows at most three action buttons. */
export const MAX_SHADE = 3;

export const PINS_STORE_KEY = 'device-stage-pinned-keys';
export const PINS_SHOW_KEY = 'device-stage-pinned-keys-show';

/** Modifier order: the order they are pressed in and the order they are
 *  written ("Win + Shift + S", "Ctrl + Alt + T"), Windows' own convention. */
export const MOD_ORDER: readonly PinMod[] = ['win', 'ctrl', 'alt', 'shift'];
export const MOD_CODE: Readonly<Record<PinMod, string>> = {
    win: 'MetaLeft', ctrl: 'ControlLeft', alt: 'AltLeft', shift: 'ShiftLeft',
};
export const MOD_LABEL: Readonly<Record<PinMod, string>> = {
    win: 'Win', ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift',
};

export interface CatalogKey { code: string; label: string; name: string }
export interface CatalogGroup { group: string; keys: CatalogKey[] }

const k = (code: string, label: string, name = label): CatalogKey => ({ code, label, name });

/**
 * Every key that can be pinned, grouped for the picker. `label` is what the
 * button and the notification say (short: the notification has three narrow
 * buttons); `name` is what the picker lists and what a screen reader hears.
 */
export const KEY_CATALOG: readonly CatalogGroup[] = [
    { group: 'Letters', keys: [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map(c => k('Key' + c, c)) },
    { group: 'Digits', keys: [...'0123456789'].map(c => k('Digit' + c, c)) },
    { group: 'Function keys', keys: Array.from({ length: 24 }, (_, i) => k('F' + (i + 1), 'F' + (i + 1))) },
    {
        group: 'Arrows and navigation', keys: [
            k('ArrowUp', 'Up', 'Up arrow'), k('ArrowDown', 'Down', 'Down arrow'),
            k('ArrowLeft', 'Left', 'Left arrow'), k('ArrowRight', 'Right', 'Right arrow'),
            k('Home', 'Home'), k('End', 'End'), k('PageUp', 'PgUp', 'Page Up'), k('PageDown', 'PgDn', 'Page Down'),
        ],
    },
    {
        group: 'Editing', keys: [
            k('Enter', 'Enter'), k('Escape', 'Esc', 'Escape'), k('Tab', 'Tab'), k('Space', 'Space'),
            k('Backspace', 'Bksp', 'Backspace'), k('Delete', 'Del', 'Delete'), k('Insert', 'Ins', 'Insert'),
        ],
    },
    {
        group: 'Modifiers on their own', keys: [
            k('MetaLeft', 'Win', 'Windows key'), k('ControlLeft', 'Ctrl', 'Ctrl'), k('AltLeft', 'Alt', 'Alt'),
            k('ShiftLeft', 'Shift', 'Shift'), k('ControlRight', 'RCtrl', 'Right Ctrl'), k('AltRight', 'RAlt', 'Right Alt (AltGr)'),
            k('ShiftRight', 'RShift', 'Right Shift'), k('MetaRight', 'RWin', 'Right Windows key'),
        ],
    },
    {
        group: 'Symbols (US keyboard positions)', keys: [
            k('Minus', '-', 'Minus'), k('Equal', '=', 'Equals'), k('BracketLeft', '[', 'Left bracket'),
            k('BracketRight', ']', 'Right bracket'), k('Backslash', '\\', 'Backslash'), k('Semicolon', ';', 'Semicolon'),
            k('Quote', "'", 'Quote'), k('Backquote', '`', 'Backquote'), k('Comma', ',', 'Comma'),
            k('Period', '.', 'Period'), k('Slash', '/', 'Slash'),
        ],
    },
    {
        group: 'Number pad', keys: [
            ...[...'0123456789'].map(c => k('Numpad' + c, 'Num' + c, 'Number pad ' + c)),
            k('NumpadAdd', 'Num+', 'Number pad +'), k('NumpadSubtract', 'Num-', 'Number pad -'),
            k('NumpadMultiply', 'Num*', 'Number pad *'), k('NumpadDivide', 'Num/', 'Number pad /'),
            k('NumpadDecimal', 'Num.', 'Number pad .'), k('NumpadEnter', 'NumEnter', 'Number pad Enter'),
        ],
    },
    {
        group: 'System', keys: [
            k('PrintScreen', 'PrtSc', 'Print Screen'), k('ContextMenu', 'Menu', 'Menu (right-click key)'),
            k('CapsLock', 'Caps', 'Caps Lock'), k('NumLock', 'NumLk', 'Num Lock'),
            k('ScrollLock', 'ScrLk', 'Scroll Lock'),
            k(SAS_CODE, 'Ctrl+Alt+Del', 'Ctrl + Alt + Del (through the Púca service)'),
        ],
    },
];

const BY_CODE = new Map<string, CatalogKey>(KEY_CATALOG.flatMap(g => g.keys.map(x => [x.code, x] as const)));

/** Is this a code the picker offers (and so the host can type)? */
export function isPinnableCode(code: string): boolean {
    return BY_CODE.has(code);
}

/** The modifiers in press/label order, de-duplicated, unknown ones dropped. */
export function normalizeMods(mods: readonly string[]): PinMod[] {
    return MOD_ORDER.filter(m => mods.includes(m));
}

/**
 * The pin a key and its modifiers really are. Ctrl + Alt + Delete (with or
 * without more modifiers held, and with the number pad's Del too) is the
 * Secure Attention pin, because that is the only form of it Windows acts on.
 */
export function canonicalPin(code: string, mods: readonly string[]): { code: string; mods: PinMod[] } {
    const m = normalizeMods(mods);
    if ((code === 'Delete' || code === 'NumpadDecimal') && m.includes('ctrl') && m.includes('alt')) return { code: SAS_CODE, mods: [] };
    if (code === SAS_CODE) return { code, mods: [] };
    return { code, mods: m };
}

/** Why this chord cannot be pinned, or null when it can. */
export function refusedChord(code: string, mods: readonly string[]): string | null {
    const m = normalizeMods(mods);
    if (code === 'KeyL' && m.includes('win')) {
        return 'Windows does not lock for a Win + L sent from another device. Use Lock in the More menu.';
    }
    return null;
}

/** What the button and the notification say: "Ctrl+C", "F5", "Win+Shift+S". */
export function pinLabel(pin: Pick<PinnedKey, 'code' | 'mods'>): string {
    const key = BY_CODE.get(pin.code);
    if (!key) return pin.code;
    if (pin.code === SAS_CODE) return key.label;
    // A modifier pinned with itself held ("Ctrl" + Ctrl) says it once.
    const mods = normalizeMods(pin.mods).filter(m => MOD_CODE[m] !== pin.code);
    return [...mods.map(m => MOD_LABEL[m]), key.label].join('+');
}

/** The long form, for a screen reader and the editor's list. */
export function pinName(pin: Pick<PinnedKey, 'code' | 'mods'>): string {
    const key = BY_CODE.get(pin.code);
    if (!key) return pin.code;
    if (pin.code === SAS_CODE) return 'Ctrl + Alt + Del';
    const mods = normalizeMods(pin.mods).filter(m => MOD_CODE[m] !== pin.code);
    return [...mods.map(m => MOD_LABEL[m]), key.name].join(' + ');
}

/** Same key with the same modifiers = the same pin. */
export function samePin(a: Pick<PinnedKey, 'code' | 'mods'>, b: Pick<PinnedKey, 'code' | 'mods'>): boolean {
    a = canonicalPin(a.code, a.mods);
    b = canonicalPin(b.code, b.mods);
    if (a.code !== b.code) return false;
    if (a.code === SAS_CODE) return true;
    const am = normalizeMods(a.mods).filter(m => MOD_CODE[m] !== a.code).join(',');
    const bm = normalizeMods(b.mods).filter(m => MOD_CODE[m] !== b.code).join(',');
    return am === bm;
}

/**
 * The key codes a press holds, in PRESS order: the modifiers, then the key.
 * Released in the reverse order. Null for SAS, which is a frame, not keys.
 */
export function pinCodes(pin: Pick<PinnedKey, 'code' | 'mods'>): string[] | null {
    if (pin.code === SAS_CODE) return null;
    const mods = normalizeMods(pin.mods).map(m => MOD_CODE[m]).filter(c => c !== pin.code);
    return [...mods, pin.code];
}

/** One complete tap (the notification's press): every frame, in order. */
export function pinTapFrames(pin: Pick<PinnedKey, 'code' | 'mods'>): Array<Record<string, unknown>> {
    const codes = pinCodes(pin);
    if (codes === null) return [{ t: 'sas' }];
    return [
        ...codes.map(code => ({ t: 'key', code, down: true })),
        ...[...codes].reverse().map(code => ({ t: 'key', code, down: false })),
    ];
}

const ID_RE = /^[a-z0-9]{1,24}$/;

function newId(taken: ReadonlySet<string>): string {
    for (;;) {
        const id = Math.random().toString(36).slice(2, 10) || 'k';
        if (ID_RE.test(id) && !taken.has(id)) return id;
    }
}

/** A new pin for `code` + `mods`, with an id none of `existing` uses. */
export function makePin(code: string, mods: readonly string[], existing: readonly PinnedKey[]): PinnedKey {
    const c = canonicalPin(code, mods);
    return { id: newId(new Set(existing.map(p => p.id))), code: c.code, mods: c.mods, shade: false };
}

/**
 * Whatever is in storage, made safe: unknown keys, bad ids, duplicates and
 * anything past the limits are dropped, and at most MAX_SHADE keep their
 * notification flag (the first ones, in the user's order). Storage is
 * per-origin and survives app updates, so a list written by a later version
 * — or by hand — must not be able to put an unsendable key on screen.
 */
export function sanitizePins(raw: unknown): PinnedKey[] {
    if (!Array.isArray(raw)) return [];
    const out: PinnedKey[] = [];
    const ids = new Set<string>();
    let shade = 0;
    for (const item of raw) {
        if (out.length >= MAX_PINS) break;
        if (!item || typeof item !== 'object') continue;
        const r = item as Record<string, unknown>;
        if (typeof r.id !== 'string' || !ID_RE.test(r.id) || ids.has(r.id)) continue;
        if (typeof r.code !== 'string' || !isPinnableCode(r.code)) continue;
        const mods = Array.isArray(r.mods) ? r.mods.filter((m): m is string => typeof m === 'string') : [];
        if (refusedChord(r.code, mods)) continue;
        const c = canonicalPin(r.code, mods);
        const pin: PinnedKey = { id: r.id, code: c.code, mods: c.mods, shade: false };
        if (out.some(p => samePin(p, pin))) continue;
        if (r.shade === true && shade < MAX_SHADE) { pin.shade = true; shade++; }
        ids.add(pin.id);
        out.push(pin);
    }
    return out;
}

export function readPins(): PinnedKey[] {
    try {
        const raw = localStorage.getItem(PINS_STORE_KEY);
        return raw ? sanitizePins(JSON.parse(raw)) : [];
    } catch {
        return [];
    }
}

export function writePins(pins: readonly PinnedKey[]): void {
    try {
        localStorage.setItem(PINS_STORE_KEY, JSON.stringify(sanitizePins(pins)));
    } catch {
        // Storage unavailable: the pins still hold for this session.
    }
}

/** "Show pinned keys" — ON unless the user turned it off. */
export function readShowPins(): boolean {
    try {
        return localStorage.getItem(PINS_SHOW_KEY) !== '0';
    } catch {
        return true;
    }
}

export function writeShowPins(on: boolean): void {
    try {
        localStorage.setItem(PINS_SHOW_KEY, on ? '1' : '0');
    } catch {
        // as above
    }
}

/** Move the pin at `from` one place up (-1) or down (+1). */
export function movePin(pins: readonly PinnedKey[], from: number, dir: -1 | 1): PinnedKey[] {
    const to = from + dir;
    if (from < 0 || from >= pins.length || to < 0 || to >= pins.length) return [...pins];
    const next = [...pins];
    [next[from], next[to]] = [next[to], next[from]];
    return next;
}

/** Turn a pin's notification flag on or off; refused (unchanged) past MAX_SHADE. */
export function setShade(pins: readonly PinnedKey[], id: string, on: boolean): PinnedKey[] {
    const count = pins.filter(p => p.shade && p.id !== id).length;
    if (on && count >= MAX_SHADE) return [...pins];
    return pins.map(p => (p.id === id ? { ...p, shade: on } : p));
}
