/**
 * The card table's pure parts: where each seat sits around the oval
 * (api/games/tableLayout.ts), what each frame of events sounds like and when
 * each board card turns over (api/games/gameTimeline.ts), and the sound
 * player's gates (api/games/gameSounds.ts): the setting, deafen, the master
 * volume and the Output Device.
 *
 * NOTHING HERE IS AUDIBLE. jsdom has no Web Audio; the player is driven
 * against a fake AudioContext that records what would have been scheduled.
 * The synthesis itself is rendered OFFLINE in a real browser by
 * e2e/game-sounds-offline-real-browser.mjs (OfflineAudioContext, never a
 * speaker).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import holdemEvents from './fixtures/games/holdem-events.json';
import blackjackEvents from './fixtures/games/blackjack-events.json';
import { parseGameFrame, type BlackjackEvent, type HoldemEvent } from '../api/games/protocol';
import { seatSpots } from '../api/games/tableLayout';
import { blackjackTimeline, holdemTimeline } from '../api/games/gameTimeline';
import { GAME_SOUND_LEVEL, playGameCues, resetGameSoundsForTests } from '../api/games/gameSounds';
import { defaultSettings, saveSettings } from '../components/settingsStore';
import { setSelfDeafened } from '../components/voiceState';
import { myTurnKey } from '../components/games/useGameSounds';

const holdemFrame = (i: number): HoldemEvent[] => {
    const f = parseGameFrame(holdemEvents[i] as { type: string; payload: unknown });
    if (!f || f.type !== 'GameEvents' || f.view.game !== 'holdem') throw new Error('fixture');
    return f.events as HoldemEvent[];
};
const blackjackFrame = (i: number): BlackjackEvent[] => {
    const f = parseGameFrame(blackjackEvents[i] as { type: string; payload: unknown });
    if (!f || f.type !== 'GameEvents' || f.view.game !== 'blackjack') throw new Error('fixture');
    return f.events as BlackjackEvent[];
};
const kinds = (t: { cues: { cue: string }[] }) => t.cues.map(c => c.cue);

describe('seats sit around the oval, the viewer at the bottom', () => {
    it('six seats: the viewer at the bottom, the next seat clockwise on their left, the opposite seat on top', () => {
        const spots = seatSpots(6, 2);
        expect(spots.map(s => s.seat)).toEqual([0, 1, 2, 3, 4, 5]);
        const at = (seat: number) => spots.find(s => s.seat === seat)!;
        expect(at(2).side).toBe('bottom');
        expect(at(2).x).toBeCloseTo(50);
        expect(at(2).y).toBeGreaterThan(85);
        expect(at(5).side).toBe('top');
        expect(at(5).y).toBeLessThan(15);
        // Clockwise is the next seat number: on screen, to the viewer's left.
        expect(at(3).side).toBe('left');
        expect(at(3).y).toBeGreaterThan(50);
        expect(at(4).side).toBe('left');
        expect(at(4).y).toBeLessThan(50);
        expect(at(0).side).toBe('right');
        expect(at(1).side).toBe('right');
        expect(at(1).y).toBeGreaterThan(50);
        // Six distinct places, all on the table.
        expect(new Set(spots.map(s => `${s.x.toFixed(1)},${s.y.toFixed(1)}`)).size).toBe(6);
        for (const s of spots) {
            expect(s.x).toBeGreaterThanOrEqual(0);
            expect(s.x).toBeLessThanOrEqual(100);
            expect(s.y).toBeGreaterThanOrEqual(0);
            expect(s.y).toBeLessThanOrEqual(100);
        }
    });

    it('a spectator sees seat 1 at the bottom; two seats face each other', () => {
        expect(seatSpots(6, null).find(s => s.side === 'bottom')!.seat).toBe(0);
        const two = seatSpots(2, 1);
        expect(two.find(s => s.seat === 1)!.side).toBe('bottom');
        expect(two.find(s => s.seat === 0)!.side).toBe('top');
    });
});

describe('what a frame of Hold\'em events sounds like, and when the board turns over', () => {
    it('a deal: one card sound per player dealt in (at most four), then the blinds\' chips once', () => {
        expect(kinds(holdemTimeline(holdemFrame(1), 0))).toEqual(['deal', 'deal', 'deal', 'chips']);
    });

    it('the flop: the check, then the three cards turn one after another, each with its own sound', () => {
        const t = holdemTimeline(holdemFrame(2), 0);
        expect(kinds(t)).toEqual(['check', 'flip', 'flip', 'flip']);
        const [a, b, c] = ['3d', 'Ah', '2d'].map(code => t.reveals[code]);
        expect(a).toBeGreaterThan(0); // after the check
        expect(b).toBeGreaterThan(a);
        expect(c).toBeGreaterThan(b);
        // The sound of each card is the moment it turns.
        expect(t.cues.filter(q => q.cue === 'flip').map(q => q.at)).toEqual([a, b, c]);
    });

    it('a showdown: the hands turn over, then the winner hears the win and everyone else the chips moving', () => {
        // Seats 2 and 0 split the pot in the fixture.
        expect(kinds(holdemTimeline(holdemFrame(3), 0))).toEqual(['check', 'flip', 'win']);
        expect(kinds(holdemTimeline(holdemFrame(3), 4))).toEqual(['check', 'flip', 'chips']);
        expect(kinds(holdemTimeline(holdemFrame(3), null))).toEqual(['check', 'flip', 'chips']);
        const t = holdemTimeline(holdemFrame(3), 0);
        expect(t.cues[2].at).toBeGreaterThan(t.cues[1].at);
    });

    it('a board run out in one frame turns street by street, with a pause between streets', () => {
        const events: HoldemEvent[] = [
            { type: 'acted', seat: 1, kind: 'call', added: 500, street_commit: 900, all_in: true, reason: 'player' },
            { type: 'board_dealt', street: 'flop', cards: ['2c', '3c', '4c'] },
            { type: 'board_dealt', street: 'turn', cards: ['5d'] },
            { type: 'board_dealt', street: 'river', cards: ['9h'] },
        ];
        const t = holdemTimeline(events, 1);
        expect(kinds(t)).toEqual(['chips', 'flip', 'flip', 'flip', 'flip', 'flip']);
        const r = ['2c', '3c', '4c', '5d', '9h'].map(c => t.reveals[c]);
        for (let i = 1; i < r.length; i++) expect(r[i]).toBeGreaterThan(r[i - 1]);
        const inStreet = r[1] - r[0];
        expect(r[3] - r[2]).toBeGreaterThan(inStreet);
        expect(r[4] - r[3]).toBeGreaterThan(inStreet);
    });

    it('folds, calls, bets and raises each have their sound; seating has none', () => {
        const ev: HoldemEvent[] = [
            { type: 'player_sat', seat: 3, user_id: 9, stack: 1000 },
            { type: 'acted', seat: 0, kind: 'fold', added: 0, street_commit: 0, all_in: false, reason: 'player' },
            { type: 'acted', seat: 1, kind: 'raise', added: 30, street_commit: 30, all_in: false, reason: 'player' },
            { type: 'acted', seat: 2, kind: 'call', added: 20, street_commit: 30, all_in: false, reason: 'player' },
        ];
        expect(kinds(holdemTimeline(ev, 0))).toEqual(['fold', 'chips', 'chips']);
        expect(holdemTimeline([], 0).cues).toEqual([]);
    });
});

describe('the turn chime is for a NEW decision of yours', () => {
    const holdem = parseGameFrame(holdemEvents[2] as { type: string; payload: unknown })!;
    it('Hold\'em: each decision; Blackjack: each hand of yours, not each hit on it', () => {
        if (holdem.type !== 'GameEvents' || holdem.view.game !== 'holdem') throw new Error('fixture');
        const v = holdem.view;
        const mine = { ...v, to_act: v.viewer_seat, turn: { hand_no: 1, turn_seq: 4 }, legal: { to_call: 0, can_check: true, call_amount: 0, can_raise: true, min_raise_to: 10, max_raise_to: 990 } };
        expect(myTurnKey(mine)).toBe('1:4');
        expect(myTurnKey({ ...mine, turn: { hand_no: 1, turn_seq: 5 } })).toBe('1:5');
        expect(myTurnKey({ ...mine, legal: null })).toBe('');
        const bjFrame = parseGameFrame(blackjackEvents[2] as { type: string; payload: unknown })!;
        if (bjFrame.type !== 'GameEvents' || bjFrame.view.game !== 'blackjack') throw new Error('fixture');
        const bj = { ...bjFrame.view, viewer_seat: 0, to_act: { seat: 0, hand: 0 }, turn: { hand_no: 1, turn_seq: 2 }, legal: { can_hit: true, can_stand: true, can_double: false, can_split: false } };
        expect(myTurnKey(bj)).toBe(myTurnKey({ ...bj, turn: { hand_no: 1, turn_seq: 3 } }));
        expect(myTurnKey(bj)).not.toBe(myTurnKey({ ...bj, to_act: { seat: 0, hand: 1 } }));
        expect(myTurnKey({ ...bj, to_act: { seat: 1, hand: 0 } })).toBe('');
    });
});

describe('Blackjack sounds', () => {
    it('the deal is a card sound per card, the hole card included, at most six', () => {
        expect(kinds(blackjackTimeline(blackjackFrame(1), 0))).toEqual(['deal', 'deal', 'deal', 'deal', 'deal', 'deal']);
    });

    it('a bet is chips; a stand knocks; the dealer turning the hole card is a flip; a loss is silent', () => {
        expect(kinds(blackjackTimeline(blackjackFrame(0), 0))).toEqual(['chips']);
        // The fixture: seat 1 hits, its card, it loses (silent), the reveal.
        const t = kinds(blackjackTimeline(blackjackFrame(3), 0));
        expect(t).toContain('flip');
        expect(t).not.toContain('win');
    });

    it('the viewer\'s own win sounds as a win; someone else\'s does not', () => {
        const ev: BlackjackEvent[] = [{ type: 'hand_settled', seat: 0, hand: 0, outcome: 'blackjack', bet: 10, returned: 25 }];
        expect(kinds(blackjackTimeline(ev, 0))).toEqual(['win']);
        expect(kinds(blackjackTimeline(ev, 1))).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// The player, against a fake AudioContext that records instead of sounding.

interface Recorded {
    created: number;
    sinkCalls: string[];
    /** Every value a gain param was set or ramped to. */
    gains: number[];
    /** Every source started (oscillator or buffer), with the order index of
     *  the first setSinkId call when it started. */
    starts: { when: number; sinkCallsBefore: number }[];
}
let rec: Recorded;

class FakeParam {
    private sink: number[] | null;
    constructor(sink: number[] | null) { this.sink = sink; }
    value = 0;
    setValueAtTime(v: number) { this.sink?.push(v); return this; }
    linearRampToValueAtTime(v: number) { this.sink?.push(v); return this; }
    exponentialRampToValueAtTime(v: number) { this.sink?.push(v); return this; }
    setTargetAtTime(v: number) { this.sink?.push(v); return this; }
    cancelScheduledValues() { return this; }
}
class FakeNode {
    connect() { return this; }
    disconnect() {}
}
class FakeSource extends FakeNode {
    frequency = new FakeParam(null);
    detune = new FakeParam(null);
    playbackRate = new FakeParam(null);
    type = 'sine';
    buffer: unknown = null;
    start(when = 0) { rec.starts.push({ when, sinkCallsBefore: rec.sinkCalls.length }); }
    stop() {}
}
class FakeAudioContext {
    state: 'running' | 'suspended' | 'closed' = 'running';
    currentTime = 10;
    sampleRate = 48000;
    destination = new FakeNode();
    constructor() { rec.created++; }
    resume() { this.state = 'running'; return Promise.resolve(); }
    setSinkId(id: string) { rec.sinkCalls.push(id); return Promise.resolve(); }
    createGain() { const n = new FakeNode() as FakeNode & { gain: FakeParam }; n.gain = new FakeParam(rec.gains); return n; }
    createOscillator() { return new FakeSource(); }
    createBufferSource() { return new FakeSource(); }
    createBiquadFilter() { const n = new FakeNode() as FakeNode & { frequency: FakeParam; Q: FakeParam; type: string }; n.frequency = new FakeParam(null); n.Q = new FakeParam(null); n.type = 'lowpass'; return n; }
    createBuffer(_c: number, len: number) { return { getChannelData: () => new Float32Array(len), length: len }; }
}

describe('the sound player: muted by the setting and by deafen, at the master volume, on the Output Device', () => {
    const mem = new Map<string, string>();
    const settle = () => new Promise(r => setTimeout(r, 0));

    beforeEach(() => {
        mem.clear();
        vi.mocked(localStorage.getItem).mockImplementation((k: string) => mem.get(k) ?? null);
        vi.mocked(localStorage.setItem).mockImplementation((k: string, v: string) => { mem.set(k, String(v)); });
        rec = { created: 0, sinkCalls: [], gains: [], starts: [] };
        vi.stubGlobal('AudioContext', FakeAudioContext);
        resetGameSoundsForTests();
        setSelfDeafened(false);
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        setSelfDeafened(false);
        resetGameSoundsForTests();
    });

    const all = ['deal', 'flip', 'chips', 'check', 'fold', 'win', 'turn'] as const;
    const cues = all.map((cue, i) => ({ cue, at: i * 0.2 }));

    it('positive control: with sounds on, every cue schedules sound, routed to the chosen device FIRST', async () => {
        saveSettings({ ...defaultSettings, outputDeviceId: 'headset-1' });
        expect(playGameCues(cues)).toBe(true);
        await settle();
        expect(rec.created).toBe(1);
        expect(rec.sinkCalls).toEqual(['headset-1']);
        expect(rec.starts.length).toBeGreaterThanOrEqual(all.length);
        expect(rec.starts.every(s => s.sinkCallsBefore === 1)).toBe(true);
        // Never louder than the game level at full master volume.
        expect(Math.max(...rec.gains)).toBeGreaterThan(0);
        expect(Math.max(...rec.gains)).toBeLessThanOrEqual(GAME_SOUND_LEVEL + 1e-9);
    });

    it('the master Output Volume scales every sound', async () => {
        saveSettings({ ...defaultSettings, outputVolume: 50 });
        playGameCues(cues);
        await settle();
        expect(Math.max(...rec.gains)).toBeLessThanOrEqual(GAME_SOUND_LEVEL / 2 + 1e-9);
        expect(Math.max(...rec.gains)).toBeGreaterThan(GAME_SOUND_LEVEL / 4);
    });

    it('nothing is even created with game sounds off, with all sounds off, at volume 0, or deafened', async () => {
        for (const s of [
            { ...defaultSettings, gameSounds: false },
            { ...defaultSettings, soundsEnabled: false },
            { ...defaultSettings, outputVolume: 0 },
        ]) {
            saveSettings(s);
            expect(playGameCues(cues)).toBe(false);
        }
        saveSettings({ ...defaultSettings });
        setSelfDeafened(true);
        expect(playGameCues(cues)).toBe(false);
        await settle();
        expect(rec.created).toBe(0);
        expect(rec.starts).toEqual([]);
    });

    it('a device switch that never finishes plays nothing - not even late, never on the old device', async () => {
        vi.useFakeTimers();
        try {
            class HangingContext extends FakeAudioContext {
                setSinkId(id: string) { rec.sinkCalls.push(id); return new Promise<void>(() => {}); }
            }
            vi.stubGlobal('AudioContext', HangingContext);
            resetGameSoundsForTests();
            saveSettings({ ...defaultSettings, outputDeviceId: 'headset-1' });
            expect(playGameCues(cues)).toBe(true);
            await vi.advanceTimersByTimeAsync(5000);
            expect(rec.sinkCalls).toEqual(['headset-1']);
            expect(rec.starts).toEqual([]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('deafening between the request and the schedule still silences it', async () => {
        saveSettings({ ...defaultSettings });
        expect(playGameCues(cues)).toBe(true);
        setSelfDeafened(true);
        await settle();
        expect(rec.starts).toEqual([]);
    });
});
