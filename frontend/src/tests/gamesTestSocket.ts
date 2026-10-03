/**
 * A stand-in for wsClient in the games tests: records what is sent, and
 * dispatches server messages the way wsClient does — latching ServerFeatures
 * BEFORE the handlers run, so a handler asking hasServerFeature is right.
 */
import type { GamesSocket } from '../api/games/gamesStore';

type Msg = { type: string; payload?: Record<string, unknown> };

export class FakeGamesSocket implements GamesSocket {
    sent: { type: string; payload: Record<string, unknown> }[] = [];
    features = new Set<string>();
    open = true;
    private handlers = new Map<string, ((m: Msg) => void)[]>();

    on(type: string, h: (m: Msg) => void) {
        this.handlers.set(type, [...(this.handlers.get(type) ?? []), h]);
    }
    off(type: string, h: (m: Msg) => void) {
        this.handlers.set(type, (this.handlers.get(type) ?? []).filter(x => x !== h));
    }
    send(message: object): boolean {
        if (!this.open) return false;
        this.sent.push(JSON.parse(JSON.stringify(message)));
        return true;
    }
    hasServerFeature(name: string): boolean {
        return this.features.has(name);
    }
    /** A server frame arriving. */
    deliver(msg: unknown) {
        const m = JSON.parse(JSON.stringify(msg)) as Msg;
        if (m.type === 'ServerFeatures') {
            const f = (m.payload as { features?: unknown } | undefined)?.features;
            this.features = new Set(Array.isArray(f) ? f.filter((x): x is string => typeof x === 'string') : []);
        }
        for (const h of this.handlers.get(m.type) ?? []) h(m);
    }
    /** The frames of one type sent so far. */
    sentOf(type: string) {
        return this.sent.filter(f => f.type === type);
    }
}

/** A deep copy of a fixture frame with its version replaced. */
export function withVersion<T>(frame: T, version: number): T {
    const f = JSON.parse(JSON.stringify(frame)) as { payload: { version: number } };
    f.payload.version = version;
    return f as T;
}
