/**
 * Attended remote control takes the DIRECT input channel, not the relay.
 *
 * THE BUG THIS PINS, measured from the author's own `agent.log` on 2026-09-08:
 * fifteen consecutive My Devices sessions over a fortnight, every one logging
 *
 *   [stream] input channel opened but this session cannot serve it — no hello
 *   sent, so the controller keeps input on its existing path
 *
 * and not one logging the opposite. The agent only ever held a key for a
 * session IT opened — the service's lock-screen path — so for an ordinary
 * attended session it could not seal a hello, sent none, and every keystroke
 * went controller → server → host app → pipe → agent while the VIDEO for the
 * same session went straight across the LAN. Two metres, via another country.
 *
 * The fix hands the agent an input-ONLY subkey. These are the three decisions
 * that makes safe, each pure so it can be checked without a peer connection:
 * what the host is willing to authorise, which key a hello names, and that the
 * subkey really is confined to input.
 */
import { describe, it, expect, vi } from 'vitest';

// session.ts opens a WebSocket subscription at import; the device tests all
// stub it the same way. Nothing here sends or receives.
vi.mock('../api/websocket', () => ({
    wsClient: { isConnected: true, on: () => {}, send: () => {} },
}));

import {
    attendedInputGrant,
    inputHelloKeyChoice,
    inputTakesTheRelay,
    inputUsesTheChannel,
    RELAY_QUIET_MS,
} from '../api/devices/session';
import { deriveDeviceInputKey, openControl, sealControl } from '../api/e2ee';

const base = {
    filesOnly: false,
    hasKey: true,
    shareCapabilities: null as string[] | null,
    uaRequired: false,
    uaVerified: false,
};

describe('what the host authorises the agent to serve', () => {
    it('grants control on your own device, which has no share', () => {
        expect(attendedInputGrant(base)).toEqual({ granted: true, ua_ok: true });
    });

    it('refuses a view-only share, exactly as the relay injector does', () => {
        // A share without `control` establishes an ordinary session — it needs
        // one for signalling and media — and must not be able to type. Before
        // R4 that rule lived only in the app, which simply never injected;
        // handing the agent a key without it would turn a latency fix into a
        // privilege escalation.
        expect(attendedInputGrant({ ...base, shareCapabilities: ['view'] }))
            .toEqual({ granted: false, ua_ok: true });
        expect(attendedInputGrant({ ...base, shareCapabilities: ['view', 'control'] }))
            .toEqual({ granted: true, ua_ok: true });
    });

    it('does not answer the passphrase question for the user', () => {
        const armed = { ...base, uaRequired: true };
        expect(attendedInputGrant(armed)).toEqual({ granted: true, ua_ok: false });
        expect(attendedInputGrant({ ...armed, uaVerified: true }))
            .toEqual({ granted: true, ua_ok: true });
    });

    it('offers nothing at all for a file browse, or before the key exists', () => {
        // A files-only session opens no screen. The agent refuses a data-only
        // input channel on its own side too — both halves, because either one
        // alone is a promise resting on the other end's good manners.
        expect(attendedInputGrant({ ...base, filesOnly: true })).toBeNull();
        expect(attendedInputGrant({ ...base, hasKey: false })).toBeNull();
    });
});

describe('which key a hello names', () => {
    it('reads an absent selector as the session key', () => {
        // What a sealed session sends, and what every agent built before the
        // field existed sends. Both must keep working.
        expect(inputHelloKeyChoice(undefined)).toBe('session');
        expect(inputHelloKeyChoice(null)).toBe('session');
    });

    it('reads 2 as the app-derived input subkey', () => {
        expect(inputHelloKeyChoice(2)).toBe('subkey');
    });

    it('refuses to guess at a selector it does not know', () => {
        // NOT 'session'. A future agent naming a key this build cannot derive
        // must leave the controller on the relay: guessing would seal every
        // frame under a key the far end is not holding, and input would vanish
        // into a channel whose hello had just promised it works.
        for (const v of [1, 3, 99, '2', true, {}]) {
            expect(inputHelloKeyChoice(v)).toBe('unknown');
        }
    });
});

describe('the input subkey', () => {
    const sessionKey = new Uint8Array(32).fill(9);

    it('is a stable 32 bytes that is not the session key', () => {
        const a = deriveDeviceInputKey(sessionKey);
        const b = deriveDeviceInputKey(sessionKey);
        expect(a).toHaveLength(32);
        expect([...a]).toEqual([...b]);
        expect([...a]).not.toEqual([...sessionKey]);
    });

    it('is different for a different session', () => {
        const other = new Uint8Array(32).fill(10);
        expect([...deriveDeviceInputKey(sessionKey)])
            .not.toEqual([...deriveDeviceInputKey(other)]);
    });

    it('opens input and NOTHING else', async () => {
        // The whole security argument for handing it down. An agent holding
        // this can read the frames it is about to inject — which it already
        // receives in plaintext over the pipe — and cannot read or forge a
        // signalling frame, a clipboard push, or anything else sealed under
        // the session key.
        const subkey = deriveDeviceInputKey(sessionKey);
        const signalling = await sealControl(sessionKey, '{"kind":"monitor-active"}');
        expect(await openControl(subkey, signalling)).toBeNull();

        // POSITIVE CONTROL, both ways: the rig can see a frame open when the
        // keys DO match, so the null above is about the key and not about a
        // helper that always fails.
        expect(await openControl(sessionKey, signalling)).toBe('{"kind":"monitor-active"}');
        const input = await sealControl(subkey, '{"s":1,"e":{"t":"move"}}');
        expect(await openControl(subkey, input)).toBe('{"s":1,"e":{"t":"move"}}');
        expect(await openControl(sessionKey, input)).toBeNull();
    });
});

describe('which transport an event takes', () => {
    const armed = { proved: true, open: true, relayForced: false, lastRelayInputAt: 0, now: 10_000 };

    it('keeps the clipboard and Ctrl+Alt+Del on the relay', () => {
        // Neither is a control input. The clipboard is opened and applied by
        // the host APP; the agent has no clipboard concept, so on the channel
        // it would pass every authorisation check, fail to parse, and be
        // dropped while the sender was told it worked. Ctrl+Alt+Del the agent
        // CAN inject, but it cannot push a refusal back, and that refusal is
        // the only reason the button is not a decoration.
        expect(inputTakesTheRelay({ t: 'clip', mime: 'text/plain', data: 'hello' })).toBe(true);
        expect(inputTakesTheRelay({ t: 'sas' })).toBe(true);
    });

    it('sends ordinary input on the channel', () => {
        for (const e of [
            { t: 'move', x: 0.5, y: 0.5 },
            { t: 'down', button: 0 },
            { t: 'up', button: 0 },
            { t: 'key', code: 'KeyA', down: true },
            { t: 'text', text: 'a' },
            { t: 'wheel', dy: 1 },
        ]) {
            expect(inputTakesTheRelay(e), JSON.stringify(e)).toBe(false);
        }
    });

    it('needs the channel proved AND open, not merely one of them', () => {
        expect(inputUsesTheChannel(armed)).toBe(true);
        expect(inputUsesTheChannel({ ...armed, proved: false })).toBe(false);
        expect(inputUsesTheChannel({ ...armed, open: false })).toBe(false);
        expect(inputUsesTheChannel({ ...armed, relayForced: true })).toBe(false);
    });

    it('waits out a stateful event that took the relay before switching', () => {
        // The switch is the hazard, in both directions. A `down` still
        // crossing the relay while its `up` takes the channel lands INVERTED,
        // and an inverted pair leaves a button held on the far machine. The
        // fallback direction has always guarded this; arming had no guard at
        // all, and the hello can land between two queued sends.
        const justSent = { ...armed, lastRelayInputAt: 10_000, now: 10_000 };
        expect(inputUsesTheChannel(justSent)).toBe(false);
        expect(inputUsesTheChannel({ ...justSent, now: 10_000 + RELAY_QUIET_MS - 1 })).toBe(false);
        expect(inputUsesTheChannel({ ...justSent, now: 10_000 + RELAY_QUIET_MS })).toBe(true);
        // Never sent one: nothing is in flight and there is nothing to wait for.
        expect(inputUsesTheChannel({ ...armed, lastRelayInputAt: 0 })).toBe(true);
    });
});
