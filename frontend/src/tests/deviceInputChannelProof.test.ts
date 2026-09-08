/**
 * P2P INPUT (R4): the controller must not leave the relay until the agent
 * says it will serve the channel.
 *
 * THE BUG THIS PINS, which reached production in v0.8.121 and broke remote
 * control outright. The controller opened an `input` data channel and started
 * sending on it the moment `readyState === 'open'`. But str0m opens a data
 * channel by LABEL whatever the far end intends to do with it, so `onopen`
 * fires against every host — one that predates R4, a webview host with no
 * agent at all, and the ordinary case where the session's key lives in the
 * app rather than the agent. The agent logged "input keeps its existing path"
 * and dropped every frame; the controller had already left that path. Result:
 * the cursor moved on the phone and NOTHING happened on the PC, with no error
 * anywhere, because from the sender's point of view every send succeeded.
 *
 * The sibling mesh transport (rtc/controlDc.ts) states the rule in its header
 * — "the capability gate is an app-level HELLO, never dc.readyState" — and
 * R4 shipped doing exactly what that forbids. So the property under test is
 * not "the hello works", it is: WITHOUT A HELLO, INPUT STILL REACHES THE
 * HOST. That is the half that was broken, and it is the half that has to keep
 * working against every host version that will ever exist.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sent: Array<{ type: string; payload?: Record<string, unknown> }> = [];
type Handler = (m: unknown) => void;
const handlers = new Map<string, Handler>();

vi.mock('../api/websocket', () => ({
    wsClient: {
        isConnected: true,
        on: (t: string, h: Handler) => { handlers.set(t, h); },
        send: (m: { type: string; payload?: Record<string, unknown> }) => { sent.push(m); },
        // The coalescer's motion backpressure reads this. Absent, a test that
        // sends a MOVE dies inside the gate rather than in an assertion.
        bufferedAmount: () => 0,
    },
}));

// Seal/open stubbed, but NOT key-blind. The first version of this stub
// ignored the key argument, which was fine while there was one key and became
// a hole the moment there were two: a frame sealed under the wrong key would
// have opened here and the test would have passed a controller that could not
// talk to its own agent. `sealed@<tag>:` carries the key it was sealed with;
// the plain `sealed:` form is accepted under any key, so every test written
// before the subkey existed still means what it did.
const { seals, keyTag } = vi.hoisted(() => ({
    seals: [] as Array<{ key: Uint8Array; plain: string }>,
    keyTag: (k: Uint8Array) => Array.from(k.slice(0, 4)).join('.'),
}));
vi.mock('../api/e2ee', async (importOriginal) => {
    const real = await importOriginal<typeof import('../api/e2ee')>();
    return {
        ...real,
        sealControl: async (key: Uint8Array, plain: string) => {
            seals.push({ key, plain });
            return `sealed:${plain}`;
        },
        openControl: async (key: Uint8Array, blob: string) => {
            if (blob.startsWith('sealed@')) {
                const i = blob.indexOf(':');
                return i > 0 && blob.slice('sealed@'.length, i) === keyTag(key)
                    ? blob.slice(i + 1)
                    : null;
            }
            return blob.startsWith('sealed:') ? blob.slice('sealed:'.length) : null;
        },
    };
});

// The clipboard's own read, so `sendClipboard` can be driven without a real
// one. Everything else in that module stays real.
vi.mock('../api/devices/clipboard', async (importOriginal) => {
    const real = await importOriginal<typeof import('../api/devices/clipboard')>();
    return {
        ...real,
        readLocalClipboardDetailed: async () => ({ ok: true as const, text: 'from the controller' }),
        writeLocalClipboard: async () => true,
    };
});

vi.mock('../api/devices/hostBackend', () => ({
    getHostBackend: async () => ({
        kind: 'agent',
        async capabilities() {
            return {
                capture: true, unattended: true, input: true, elevated: false,
                clipboard: false, files: false, monitors: [],
            };
        },
        startSession: async () => ({ kind: 'agent-pc' }),
        stopSession: async () => {},
        listMonitors: async () => [],
        setMonitor: async () => {},
        injectEvent: async () => {},
    }),
}));
vi.mock('../api/iceConfig', () => ({ withRelayOnlyIfRequested: (c: unknown) => c, fetchIceConfig: async () => ({ iceServers: [] }) }));
vi.mock('../api/devices/tunnel', () => ({ attachTunnelChannel: () => {}, closeTunnels: () => {} }));
vi.mock('../api/devices/deviceKeyRc', () => ({
    deviceKeyDh: async () => new Uint8Array(32).fill(3),
}));
vi.mock('../api/devices/peerKeys', () => ({ deviceStaticPubFor: async () => 'x25519:' + btoa('k') }));
vi.mock('../api/thisDevice', () => ({
    thisDeviceId: () => 'dev-me',
}));
vi.mock('../api/devices/hostConsent', () => ({ requestHostConsent: async () => ({ monitor: 0 }) }));
vi.mock('../api/devices/unattendedHost', () => ({
    issueUaChallenge: async () => null,
    verifyUaResponse: async () => false,
    unattendedState: async () => ({ armed: false }),
}));
vi.mock('../api/devices/clipboard', () => ({
    buildClipboardEvent: (text: string) => ({ t: 'clip', data: text }),
    isClipboardEvent: (e: unknown) => (e as { t?: string })?.t === 'clip',
    readLocalClipboard: async () => 'clipboard text',
    readLocalClipboardDetailed: async () => ({ ok: true, text: 'clipboard text' }),
    MAX_CLIPBOARD_BYTES: 6000,
    writeLocalClipboard: async () => {},
}));

/** A data channel the test can drive: open it, read what was written, and
 *  deliver a message as the far end would. */
class StubDc {
    readyState = 'connecting';
    written: string[] = [];
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onmessage: ((e: { data: unknown }) => void) | null = null;
    send(b: string) {
        if (this.readyState !== 'open') throw new Error('not open');
        this.written.push(b);
    }
    close() { this.readyState = 'closed'; this.onclose?.(); }
    /** SCTP came up. Note this says nothing about the far end's intentions —
     *  which is the entire point of this file. */
    open() { this.readyState = 'open'; this.onopen?.(); }
    deliver(data: unknown) { this.onmessage?.({ data }); }
}

const channels = new Map<string, StubDc>();

class StubPc {
    localDescription: unknown = null;
    remoteDescription: unknown = null;
    onicecandidate: ((e: { candidate: unknown }) => void) | null = null;
    ontrack: ((e: unknown) => void) | null = null;
    onconnectionstatechange: (() => void) | null = null;
    oniceconnectionstatechange: (() => void) | null = null;
    connectionState = 'new';
    iceConnectionState = 'new';
    createDataChannel(label: string) {
        const dc = new StubDc();
        channels.set(label, dc);
        return dc;
    }
    addTransceiver() {
        return { receiver: { track: { onunmute: null, kind: 'video', stop() {} } } };
    }
    async createOffer() { return { type: 'offer', sdp: 'v=0\r\n' }; }
    async createAnswer() { return { type: 'answer', sdp: 'v=0\r\n' }; }
    async setLocalDescription(d: unknown) { this.localDescription = d; }
    async setRemoteDescription(d: unknown) { this.remoteDescription = d; }
    async addIceCandidate() {}
    addTrack() { return {}; }
    close() {}
}
Object.defineProperty(window, 'RTCPeerConnection', {
    value: StubPc, configurable: true, writable: true,
});

async function settle(rounds = 30): Promise<void> {
    for (let i = 0; i < rounds; i++) await new Promise(r => setTimeout(r, 0));
}

async function controllerSession(): Promise<string> {
    const { installDeviceSessions, connectToDevice, endAllSessions, activeSessions } =
        await import('../api/devices/session');
    const { generateControlEphemeral } = await import('../api/e2ee');
    installDeviceSessions();
    endAllSessions('test reset');
    channels.clear();
    sent.length = 0;

    const sid = await connectToDevice('dev-host');
    const hostEph = generateControlEphemeral();
    handlers.get('DeviceConnectAnswered')!({
        payload: { session_id: sid, accepted: true, eph: hostEph.pubEncoded },
    });
    await settle();
    expect(activeSessions().find(x => x.id === sid)?.phase).toBe('active');
    sent.length = 0;
    return sid;
}

const inputDc = () => channels.get('input')!;
/** Input frames that took the RELAY. */
const onRelay = () => sent.filter(m => m.type === 'DeviceInput');
/** Input frames that took the CHANNEL. */
const onChannel = () => inputDc().written;

/** The hello an up-to-date agent sends: sealed under the session key, naming
 *  the session. Mirrors input_wire::InputHello / HELLO_PLAINTEXT. */
const agentHello = (sid: string) => JSON.stringify({ sid, hello: 'sealed:{"hello":1}' });

beforeEach(() => {
    sent.length = 0;
    seals.length = 0;
    channels.clear();
});

describe('the input channel is unproved until the agent says otherwise', () => {
    it('AN OPEN CHANNEL ALONE CHANGES NOTHING — input still reaches the host', async () => {
        // THE REGRESSION. Every host that opens the channel and ignores it
        // lands here: an agent predating R4, a webview host, and an ordinary
        // session whose key lives in the app. In 0.8.121 this case sent every
        // event into the channel and the machine never moved.
        const { sendInput } = await import('../api/devices/session');
        const id = await controllerSession();
        inputDc().open();
        await settle();

        sendInput(id, { t: 'down', button: 0 });
        sendInput(id, { t: 'up', button: 0 });
        await settle();

        expect(onChannel(), 'nothing may be sent to a far end that never claimed it').toEqual([]);
        expect(onRelay(), 'and the events must still reach the host').toHaveLength(2);
    });

    it('after the agent HELLOs, input rides the channel and the relay goes quiet', async () => {
        const { sendInput } = await import('../api/devices/session');
        const id = await controllerSession();
        inputDc().open();
        inputDc().deliver(agentHello(id));
        await settle();
        sent.length = 0;

        sendInput(id, { t: 'down', button: 0 });
        await settle();

        expect(onChannel(), 'the whole point of R4').toHaveLength(1);
        expect(onRelay(), 'and it must not be sent twice').toHaveLength(0);
        const frame = JSON.parse(onChannel()[0]) as { sid: string; payload: string };
        expect(frame.sid).toBe(id);
        expect(JSON.parse(frame.payload.slice('sealed:'.length)))
            .toMatchObject({ e: { t: 'down', button: 0 } });
    });

    it('a hello that does not OPEN under the session key proves nothing', async () => {
        const { sendInput } = await import('../api/devices/session');
        const id = await controllerSession();
        inputDc().open();
        // Unsealed, wrongly sealed, wrong shape, and not even JSON. A relay
        // that can strand input on a dead transport by writing on this
        // channel would be a denial of service against the whole feature.
        inputDc().deliver(JSON.stringify({ sid: id, hello: 'not-sealed' }));
        inputDc().deliver(JSON.stringify({ sid: id, hello: 'sealed:{"hello":0}' }));
        inputDc().deliver(JSON.stringify({ sid: id, hello: 'sealed:garbage' }));
        inputDc().deliver(JSON.stringify({ sid: id }));
        inputDc().deliver('not json at all');
        inputDc().deliver(new ArrayBuffer(8));
        await settle();
        sent.length = 0;

        sendInput(id, { t: 'down', button: 0 });
        await settle();
        expect(onChannel()).toEqual([]);
        expect(onRelay(), 'input must survive every one of those').toHaveLength(1);
    });

    it('a hello for ANOTHER session does not arm this one', async () => {
        const { sendInput } = await import('../api/devices/session');
        const id = await controllerSession();
        inputDc().open();
        inputDc().deliver(agentHello('some-other-session'));
        await settle();
        sent.length = 0;

        sendInput(id, { t: 'down', button: 0 });
        await settle();
        expect(onChannel()).toEqual([]);
        expect(onRelay()).toHaveLength(1);
    });

    it('a channel that CLOSES takes its proof with it', async () => {
        const { sendInput } = await import('../api/devices/session');
        const id = await controllerSession();
        const dc = inputDc();
        dc.open();
        dc.deliver(agentHello(id));
        await settle();
        sendInput(id, { t: 'down', button: 0 });
        await settle();
        expect(dc.written, 'precondition: it was proved and in use').toHaveLength(1);

        dc.close();
        sent.length = 0;
        sendInput(id, { t: 'up', button: 0 });
        await settle();
        expect(
            onRelay(),
            'the release cannot be lost with the channel — an unmatched down leaves '
            + 'a button held on the far machine',
        ).toHaveLength(1);
        expect(dc.written, 'and nothing more went to the dead channel').toHaveLength(1);
    });
});

describe('an ATTENDED agent names its own key, and gets frames sealed with it', () => {
    /** The hello an attended host's agent sends: sealed under the input
     *  SUBKEY, and saying so. Mirrors input_wire::InputHello with
     *  v = HELLO_KEY_INPUT_SUBKEY. */
    const attendedHello = (sid: string, tag: string, v: unknown = 2) =>
        JSON.stringify({ sid, hello: `sealed@${tag}:{"hello":1}`, v });

    /** The session key this controller ended up with, learned from a frame it
     *  sealed rather than reached for inside the module. A `move` is used on
     *  purpose: it is not stateful, so it does not defer the switch. */
    async function sessionKeyOf(id: string, sendInput: (i: string, e: unknown) => boolean) {
        seals.length = 0;
        sendInput(id, { t: 'move', x: 0.5, y: 0.5 });
        await settle();
        expect(seals.length, 'precondition: the relay frame was sealed').toBeGreaterThan(0);
        return seals[0].key;
    }

    it('opens the hello with the SUBKEY and seals its input with it', async () => {
        // The end-to-end shape of the fix: the agent holds only the derived
        // key, says so, and the controller must follow it there. A controller
        // that kept using the session key would have every frame refused by an
        // agent that cannot open them — input dead on a channel that just
        // announced itself working.
        const { sendInput } = await import('../api/devices/session');
        const { deriveDeviceInputKey } = await vi.importActual<typeof import('../api/e2ee')>('../api/e2ee');
        const id = await controllerSession();
        inputDc().open();
        const sessionKey = await sessionKeyOf(id, sendInput);
        const subkey = deriveDeviceInputKey(sessionKey);
        expect(keyTag(subkey), 'precondition: the two keys are distinguishable')
            .not.toBe(keyTag(sessionKey));

        inputDc().deliver(attendedHello(id, keyTag(subkey)));
        await settle();
        seals.length = 0;
        sent.length = 0;

        sendInput(id, { t: 'down', button: 0 });
        await settle();

        expect(onChannel(), 'the frame took the channel').toHaveLength(1);
        expect(onRelay(), 'and not the relay as well').toHaveLength(0);
        // The INPUT frame's seal, chosen by content rather than by position:
        // sending over the channel also emits the `input-alive` signal, which
        // is sealed under the session key right behind it, and `seals.at(-1)`
        // quietly meant that one instead.
        const inputSeal = seals.find(x => x.plain.includes('"t":"down"'));
        expect(inputSeal, 'the input frame was sealed').toBeTruthy();
        expect(keyTag(inputSeal!.key), 'under the key the agent named, not the session key')
            .toBe(keyTag(subkey));
        expect(keyTag(inputSeal!.key)).not.toBe(keyTag(sessionKey));

        // AND THE HOST WAS TOLD SOMEBODY IS DRIVING. Its idle revoke is fed
        // only by input arriving over the relay, so a session that moved off
        // the relay would be torn down mid-use half an hour later.
        expect(
            sent.filter(m => m.type === 'DeviceSignal'),
            'the direct channel is invisible to the host; this is what replaces it',
        ).not.toHaveLength(0);
    });

    it('is not armed by a hello that names the subkey but is sealed with the session key', async () => {
        // The negative that proves the positive. If the controller opened the
        // hello with `s.key` regardless of `v`, this would arm — and every
        // frame after it would be sealed under a key the agent is not holding.
        const { sendInput } = await import('../api/devices/session');
        const id = await controllerSession();
        inputDc().open();
        const sessionKey = await sessionKeyOf(id, sendInput);

        inputDc().deliver(attendedHello(id, keyTag(sessionKey)));
        await settle();
        sent.length = 0;

        sendInput(id, { t: 'down', button: 0 });
        await settle();
        expect(onChannel(), 'nothing may ride a channel proved with the wrong key').toEqual([]);
        expect(onRelay()).toHaveLength(1);
    });

    it('ignores a hello naming a key selector it does not know', async () => {
        const { sendInput } = await import('../api/devices/session');
        const { deriveDeviceInputKey } = await vi.importActual<typeof import('../api/e2ee')>('../api/e2ee');
        const id = await controllerSession();
        inputDc().open();
        const sessionKey = await sessionKeyOf(id, sendInput);

        // A future agent, a key this build cannot derive. Staying on the relay
        // is the only safe answer; guessing the session key would be input
        // sealed for nobody.
        inputDc().deliver(attendedHello(id, keyTag(deriveDeviceInputKey(sessionKey)), 99));
        await settle();
        sent.length = 0;

        sendInput(id, { t: 'down', button: 0 });
        await settle();
        expect(onChannel()).toEqual([]);
        expect(onRelay()).toHaveLength(1);
    });
});

describe('what the direct channel must NOT carry', () => {
    const armed = async (id: string) => {
        inputDc().open();
        inputDc().deliver(agentHello(id));
        await settle();
        sent.length = 0;
    };

    it('sends the CLIPBOARD by relay even with the channel armed', async () => {
        // THE REGRESSION THIS TEST EXISTS FOR. A clipboard push shares the
        // input queue but is not a control input: the agent has no clipboard
        // concept at all, so on the channel it passes every authorisation
        // check, fails to parse, and is dropped — while `sendClipboard`
        // returns success and the controller is told "Clipboard sent". Arming
        // the channel for attended sessions would have broken clipboard
        // sharing for exactly the sessions the change was written for.
        const { sendClipboard } = await import('../api/devices/session');
        const id = await controllerSession();
        await armed(id);

        const err = await sendClipboard(id);

        expect(err, 'it reports success').toBeNull();
        expect(onChannel(), 'and it must not have gone to the agent').toEqual([]);
        expect(onRelay(), 'it goes to the app, which is what applies it').toHaveLength(1);
    });

    it('sends CTRL+ALT+DEL by relay, so a refusal can come back', async () => {
        // The agent can inject a SAS but cannot push, so a refusal — no system
        // service, policy unset — has no way back from there. The relay path
        // turns the same refusal into an `input-failed` signal, which is the
        // only reason that button is not a decoration.
        const { sendInput } = await import('../api/devices/session');
        const id = await controllerSession();
        await armed(id);

        sendInput(id, { t: 'sas' });
        await settle();

        expect(onChannel()).toEqual([]);
        expect(onRelay()).toHaveLength(1);
    });

    it('POSITIVE CONTROL: ordinary input on the same armed session takes the channel', async () => {
        // Without this the two tests above would pass against a session that
        // never armed at all.
        const { sendInput } = await import('../api/devices/session');
        const id = await controllerSession();
        await armed(id);

        sendInput(id, { t: 'down', button: 0 });
        await settle();

        expect(onChannel()).toHaveLength(1);
        expect(onRelay()).toEqual([]);
    });
});
