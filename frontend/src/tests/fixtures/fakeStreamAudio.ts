/**
 * A recording Web Audio for the stream-audio tests: every context the stage
 * (StreamStage) or the small player (StreamAudioHost's engine) builds, every
 * gain node in it, what each gain was sent, which tracks feed it, and when it
 * joined the speakers. Asserted as values, never as sound.
 *
 * Which component built a context is read from the call site (the stack),
 * not from anything the code under test could arrange to look like: the
 * stage and the small player run the same `new AudioContext()`.
 *
 * A gain's tracks are known where the source's MediaStream was built with
 * addTrack (the small player does); the shared setup's MediaStream drops
 * constructor arguments, so a stage graph's tracks read as unknown and the
 * stage's gains are told apart by the order they were built in (tile order).
 */
import { FakeSink } from './fakeSink';

/** An AudioParam that remembers every value it was sent, in order, and
 *  how: set at once (`value`) or ramped toward (setTargetAtTime). */
export class RecordingParam {
    sent: number[] = [];
    events: Array<{ how: 'set' | 'ramp'; to: number }> = [];
    private v = 1;
    get value() { return this.v; }
    set value(x: number) { this.v = x; this.sent.push(x); this.events.push({ how: 'set', to: x }); }
    setTargetAtTime(target: number) { this.sent.push(target); this.events.push({ how: 'ramp', to: target }); }
    cancelScheduledValues() { /* nothing scheduled to cancel in a recording */ }
    /** Where it ends up: events in one task share a currentTime, where the
     *  last one inserted wins. */
    get effective() { return this.sent[this.sent.length - 1]; }
}

export interface FakeGainNode {
    gain: RecordingParam;
    ctx: FakeStreamAudioContext;
    /** Track ids of the sources connected into it (where knowable). */
    tracks: string[];
    /** The sink the context was on when this gain joined the speakers, or
     *  null while it has not. */
    speakersAt: string | null;
    disconnected: boolean;
    connect: (dest: unknown) => void;
    disconnect: () => void;
}

export type ContextOwner = 'host' | 'stage' | 'other';

const ownerOf = (stack: string): ContextOwner =>
    /streamAudioHostCore/.test(stack) ? 'host' : /StreamStage/.test(stack) ? 'stage' : 'other';

/** Shared across instances; reset with resetFakeStreamAudio() in beforeEach. */
const registry = {
    contexts: [] as FakeStreamAudioContext[],
    devices: new Set<string>(),
    /** The state a NEW context is born in. */
    bornIn: 'running' as AudioContextState,
    /** Make `new AudioContext()` throw: no Web Audio in this engine. */
    unavailable: false,
    /** Make createMediaStreamSource throw. */
    sourcesFail: false,
    /** False: contexts have NO setSinkId, as in Firefox and Safari (an
     *  <audio> can be routed there, a context cannot). */
    contextSinkId: true,
};

export function resetFakeStreamAudio(opts: { devices?: string[] } = {}) {
    registry.contexts = [];
    registry.devices.clear();
    for (const d of opts.devices ?? []) registry.devices.add(d);
    registry.bornIn = 'running';
    registry.unavailable = false;
    registry.sourcesFail = false;
    registry.contextSinkId = true;
}

export const fakeAudio = {
    get contexts() { return registry.contexts; },
    get devices() { return registry.devices; },
    set bornIn(s: AudioContextState) { registry.bornIn = s; },
    set unavailable(v: boolean) { registry.unavailable = v; },
    set sourcesFail(v: boolean) { registry.sourcesFail = v; },
    set contextSinkId(v: boolean) { registry.contextSinkId = v; },
    /** The contexts one component built, oldest first. */
    of(owner: ContextOwner) { return registry.contexts.filter(c => c.owner === owner); },
    /** The live (not closed) context of one component. */
    liveOf(owner: ContextOwner) { return this.of(owner).filter(c => c.state !== 'closed').at(-1) ?? null; },
    /** Every gain node one component built, oldest first. */
    gainsOf(owner: ContextOwner) { return this.of(owner).flatMap(c => c.gains); },
    /** The small player's gain node carrying `trackId` now (not disconnected). */
    hostGainFor(trackId: string) {
        return this.gainsOf('host').filter(g => !g.disconnected && g.tracks.includes(trackId)).at(-1) ?? null;
    },
};

export class FakeStreamAudioContext extends FakeSink {
    state: AudioContextState;
    currentTime = 0;
    destination = { speakers: true };
    owner: ContextOwner;
    gains: FakeGainNode[] = [];
    onstatechange: (() => void) | null = null;
    resumes = 0;

    constructor() {
        super(registry.devices);
        if (registry.unavailable) throw new Error('no Web Audio in this engine');
        // Firefox and Safari: the context has no setSinkId at all.
        if (!registry.contextSinkId) Object.defineProperty(this, 'setSinkId', { value: undefined, configurable: true });
        this.owner = ownerOf(new Error().stack ?? '');
        this.state = registry.bornIn;
        registry.contexts.push(this);
    }

    /** Move the context to `state` and tell its listener, as the engine does. */
    become(state: AudioContextState) {
        this.state = state;
        this.onstatechange?.();
    }

    resume = async () => {
        this.resumes++;
        // A test decides whether a resume is allowed (become('running')).
    };
    close = async () => { this.state = 'closed'; };

    createMediaStreamSource(stream: MediaStream) {
        if (registry.sourcesFail) throw new Error('cannot read this track into Web Audio');
        const ids = (stream.getAudioTracks?.() ?? []).map(t => t.id);
        let into: FakeGainNode | null = null;
        return {
            connect: (dest: unknown) => {
                into = this.gains.find(x => x === dest) ?? null;
                into?.tracks.push(...ids);
            },
            disconnect: () => {
                // A source taken off its gain: that gain no longer carries it.
                if (into) into.tracks = into.tracks.filter(id => !ids.includes(id));
                into = null;
            },
        };
    }

    createGain(): FakeGainNode {
        const node: FakeGainNode = {
            gain: new RecordingParam(),
            ctx: this,
            tracks: [],
            speakersAt: null,
            disconnected: false,
            connect: (dest: unknown) => {
                if (dest === this.destination) node.speakersAt = this.sinkId || 'default';
            },
            disconnect: () => { node.disconnected = true; },
        };
        this.gains.push(node);
        return node;
    }
}
