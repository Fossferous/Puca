// @vitest-environment jsdom
/**
 * The phone's prompt (components/RemoteControlOverlay.tsx) when Allow cannot
 * start control because the accessibility service is not bound. Two cases,
 * told apart by the person's switch in Android's Accessibility settings
 * (ControlGate.beginRefusal, pinned by ControlGateTest's
 * atAllowTheSwitchOnWithTheServiceNotBoundIsNotTheSwitchOff):
 *
 *   - the switch OFF (SERVICE_DISABLED): the prompt says to turn it on and
 *     has the way there;
 *   - the switch ON, the service not bound (SERVICE_SUSPENDED: an automation
 *     or testing app's UiAutomation holding it): the prompt says Android has
 *     stopped it for now and it is still switched on, with no way to a switch
 *     nobody needs to touch.
 *
 * 0.9.862's review: the second case answered 'service-off', which the prompt
 * drew as the first, so the person was sent to turn on a switch that was on.
 *
 * The refusals are read from the Java by name, as phoneControlEndReasons does.
 * What would have to break for it to go red: PhoneControl.beginRefusal not
 * going through ControlGate.beginRefusal (so the JUnit no longer covers what
 * the plugin answers); either constant gone or renamed; the switch-on words
 * missing or saying it is off; the prompt offering the settings for it; or
 * (the control) the switch really off no longer offering them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ControlState } from '../api/remoteControl';

const dir = resolve(__dirname, '../../android/phone-control/src/main/java/com/sovereign/app/control');

/** Java source with its comments taken out (string literals kept). */
function code(src: string): string {
    return src.replace(/"(?:[^"\\]|\\.)*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m) => (m.startsWith('"') ? m : ' '));
}
const java = (cls: string) => code(readFileSync(resolve(dir, `${cls}.java`), 'utf8'));

function constant(cls: string, name: string): string {
    const m = new RegExp(`\\bstatic\\s+final\\s+String\\s+${name}\\s*=\\s*"([^"]*)"\\s*;`).exec(java(cls));
    if (!m) throw new Error(`${cls}.java has no String constant ${name}`);
    return m[1];
}

/** The body of `static String <name>(...)` in `src`. */
function body(src: string, name: string): string {
    const at = src.search(new RegExp(`\\bstatic\\s+String\\s+${name}\\s*\\(`));
    if (at < 0) throw new Error(`no static String ${name}(...)`);
    const open = src.indexOf('{', at);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return src.slice(open + 1, i);
    }
    throw new Error(`${name}: no closing brace`);
}

const h = vi.hoisted(() => ({
    push: (() => {}) as (s: ControlState) => void,
    refusal: null as string | null,
    opened: [] as string[],
}));
vi.mock('../api/remoteControl', () => ({
    subscribeControl: (fn: (s: ControlState) => void) => { h.push = fn; return () => {}; },
    respondToControlRequest: () => {},
    revokeControl: () => {},
    acceptControlOffer: () => {},
    declineControlOffer: () => {},
    clearNotice: () => {},
    initRemoteControl: () => {},
    extendControlPrompt: () => {},
}));
vi.mock('../api/phoneControl', async () => {
    const real = await vi.importActual<typeof import('../api/phoneControl')>('../api/phoneControl');
    return {
        refusalWords: real.refusalWords,
        onPhoneControlStatusChanged: () => () => {},
        openPhoneControlSettings: async (page: string) => { h.opened.push(page); return true; },
        phoneControlStatus: async () => ({ enabled: true, connected: false, active: false, refusal: h.refusal, sdk: 34 }),
        phoneHostPossible: () => true,
    };
});
vi.mock('../components/settingsStore', () => ({
    loadSettings: () => ({ remoteControlKillKey: null, remoteControlAnyInputKill: false }),
}));

import { RemoteControlOverlay } from '../components/RemoteControlOverlay';
import { refusalWords } from '../api/phoneControl';

/** Read when a test runs, so an old ControlGate fails the test that names it. */
const SWITCH_OFF = () => constant('ControlGate', 'SERVICE_DISABLED');
const SWITCH_ON_NOT_BOUND = () => constant('ControlGate', 'SERVICE_SUSPENDED');

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    h.opened = [];
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

async function promptFor(refusal: string) {
    h.refusal = refusal;
    act(() => root.render(createElement(RemoteControlOverlay)));
    act(() => h.push({ incomingRequest: { userId: 42, username: 'Aoife' }, controlledBy: null, controlling: null, offer: null, notice: null }));
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    const prompt = host.querySelector('[data-testid="rc-phone-prompt"]');
    expect(prompt, 'the phone\'s prompt is up').toBeTruthy();
    return {
        words: prompt!.textContent ?? '',
        setup: host.querySelector('[data-testid="rc-phone-setup"]'),
        openSettings: host.querySelector<HTMLButtonElement>('[data-testid="rc-phone-open-settings"]'),
        note: host.querySelector('[data-testid="rc-phone-refusal"]')?.textContent ?? null,
        allow: host.querySelector<HTMLButtonElement>('[data-testid="rc-phone-allow"]'),
    };
}

describe('Allow with the service not bound', () => {
    it('the plugin answers what ControlGate.beginRefusal says, and the two cases have names of their own', () => {
        const pc = body(java('PhoneControl'), 'beginRefusal');
        expect(pc, 'PhoneControl.beginRefusal goes through ControlGate.beginRefusal').toMatch(/return\s+ControlGate\.beginRefusal\s*\(/);
        // No mapping of its own on top: the JUnit covers what the page is told.
        expect(pc).not.toMatch(/SERVICE_(OFF|SUSPENDED|DISABLED)|"service-/);
        expect(SWITCH_OFF()).toBe('service-disabled');
        expect(SWITCH_ON_NOT_BOUND()).toBe('service-suspended');
        expect(SWITCH_ON_NOT_BOUND()).not.toBe(constant('ControlGate', 'SERVICE_OFF'));
    });

    it('switched on, not bound: Android has stopped it for now, it is still on, and no way to the switch', async () => {
        const p = await promptFor(SWITCH_ON_NOT_BOUND());
        expect(p.setup, 'no "turn it on" section').toBeNull();
        expect(p.openSettings, 'no Open Accessibility settings').toBeNull();
        expect(p.words).not.toMatch(/turn on/i);
        expect(p.note).toBe(refusalWords(SWITCH_ON_NOT_BOUND()));
        expect(p.note).toMatch(/Android has stopped Púca remote control for now/);
        expect(p.note).toMatch(/still switched on/);
        expect(p.note).not.toMatch(/\bis off\b|switched off/);
        expect(p.allow?.disabled, 'Allow cannot be pressed').toBe(true);
    });

    it('CONTROL: switched off, the prompt says to turn it on and has the way there', async () => {
        const p = await promptFor(SWITCH_OFF());
        expect(p.setup).toBeTruthy();
        expect(p.words).toMatch(/First turn on Púca remote control in Android's Accessibility\s+settings/);
        expect(p.openSettings).toBeTruthy();
        act(() => { p.openSettings!.click(); });
        expect(h.opened).toEqual(['accessibility']);
        expect(p.note, 'the setup says it, not a second line').toBeNull();
        expect(p.allow?.disabled).toBe(true);
        // The two never read the same.
        expect(refusalWords(SWITCH_OFF())).not.toBe(refusalWords(SWITCH_ON_NOT_BOUND()));
    });
});
