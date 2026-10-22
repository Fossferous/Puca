/**
 * Push-to-talk on a back button.
 *
 * Steam reports controller buttons to its own UI through
 * SteamClient.Input.RegisterForControllerInputMessages. The callback's shape
 * depends on the client: the build measured on 2026-10-22 (1791918634) calls
 * it with (controllerIndex, button, pressed, x, y), as its own gamepad
 * navigation does; older clients passed one array of { nA: button, bS:
 * pressed }. Both are read here.
 *
 * Button ids are Steam's EGamepadButton values from the same build: the Deck's
 * L4/R4 are the UPPER back grips, L5/R5 the lower ones.
 */
import type { PushToTalkButton } from './settings';

export const BACK_BUTTON_IDS: Readonly<Record<Exclude<PushToTalkButton, 'off'>, number>> = {
    L5: 32, // GAMEPAD_BUTTON_LBACK
    R5: 33, // GAMEPAD_BUTTON_RBACK
    L4: 44, // GAMEPAD_BUTTON_LBACK_UPPER
    R4: 45, // GAMEPAD_BUTTON_RBACK_UPPER
};

export interface ButtonEvent {
    controller: number;
    button: number;
    pressed: boolean;
}

/** The button events in one callback, in either of Steam's shapes. */
export function readButtonEvents(args: readonly unknown[]): ButtonEvent[] {
    const first = args[0];
    if (Array.isArray(first)) {
        const out: ButtonEvent[] = [];
        for (const e of first) {
            if (!e || typeof e !== 'object') continue;
            const o = e as Record<string, unknown>;
            if (typeof o.nA !== 'number') continue;
            out.push({ controller: typeof o.nC === 'number' ? o.nC : 0, button: o.nA, pressed: !!o.bS });
        }
        return out;
    }
    if (typeof first === 'number' && typeof args[1] === 'number') {
        return [{ controller: first, button: args[1], pressed: !!args[2] }];
    }
    return [];
}

/**
 * Whether the chosen button is held, across controllers (a Deck with a pad
 * plugged in has two). `onChange` fires on the edges only.
 */
export class PushToTalkTracker {
    private holding = new Set<number>();

    constructor(private button: number, private onChange: (held: boolean) => void) {}

    get held(): boolean {
        return this.holding.size > 0;
    }

    feed(events: readonly ButtonEvent[]): void {
        for (const e of events) {
            if (e.button !== this.button) continue;
            const was = this.held;
            if (e.pressed) this.holding.add(e.controller);
            else this.holding.delete(e.controller);
            if (this.held !== was) this.onChange(this.held);
        }
    }

    /** Let go of everything (the button was changed, or the plugin unloads). */
    reset(): void {
        const was = this.held;
        this.holding.clear();
        if (was) this.onChange(false);
    }
}
