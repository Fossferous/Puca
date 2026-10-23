/**
 * Push-to-talk on a back button, from the plugin's backend.
 *
 * Steam's button feed for its own interface
 * (SteamClient.Input.RegisterForControllerInputMessages) cannot be counted on
 * for this. In tests on a Deck it missed the back grip entirely while another
 * app was in front, and that is when push to talk matters. So the backend
 * reads the chosen button from the controller itself
 * (py_modules/puca_buttons.py). It sends "puca_button": true when the button
 * goes down and every half second while it stays down, false when it comes up.
 *
 * HoldFollower turns those into Púca's hold, and lets go by itself when the
 * "still held" stops arriving: a lost release, or a backend that died
 * mid-hold, can never leave the microphone transmitting.
 */

/** No "still held" for this long ends the hold. Púca's own lease is the same
 *  (docs/EMBEDDING.md), so the plugin and the page let go together. */
export const HOLD_STALE_MS = 1500;

export interface HoldCallbacks {
    /** The button went down: start talking. */
    down(): void;
    /** Still held: renew Púca's lease. */
    renew(): void;
    /** Released, gone quiet, or reset: stop talking. */
    up(): void;
}

export class HoldFollower {
    private timer: ReturnType<typeof setTimeout> | null = null;
    private holding = false;
    private readonly on: HoldCallbacks;
    private readonly staleMs: number;

    constructor(on: HoldCallbacks, staleMs: number = HOLD_STALE_MS) {
        this.on = on;
        this.staleMs = staleMs;
    }

    get held(): boolean {
        return this.holding;
    }

    /** One "puca_button" event. Anything but a boolean is ignored. */
    signal(held: unknown): void {
        if (held === true) {
            this.arm();
            if (this.holding) {
                this.on.renew();
            } else {
                this.holding = true;
                this.on.down();
            }
        } else if (held === false) {
            this.reset();
        }
    }

    /** Let go now, if holding: the button changed, the call ended, the plugin unloads. */
    reset(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        if (!this.holding) return;
        this.holding = false;
        this.on.up();
    }

    private arm(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = null;
            this.reset();
        }, this.staleMs);
    }
}

/**
 * Mute and deafen on a back button: one press, one toggle, however long the
 * button stays down (the backend repeats "held" every half second while it
 * does).
 */
export class PressFollower {
    private down = new Set<string>();

    /** One "puca_button" event for a toggle's button: true for a new press. */
    signal(button: string, held: boolean): boolean {
        if (!held) {
            this.down.delete(button);
            return false;
        }
        if (this.down.has(button)) return false;
        this.down.add(button);
        return true;
    }

    reset(): void {
        this.down.clear();
    }
}
