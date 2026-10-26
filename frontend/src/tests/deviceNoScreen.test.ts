/**
 * "THAT PC'S SCREEN IS OFF" — the codes, the sentences, and the agent's reply.
 *
 * A laptop with its lid shut has no screen switched on, and remote control
 * used to end in "could not connect to the device", which sent the owner to
 * look at the network (2026-10-21). The host now asks its agent first
 * (`prepare_screen`) and either ends the session with a CODE the phone turns
 * into a sentence naming the PC, or tells the phone a virtual screen is
 * starting.
 *
 * Two contracts cross a process boundary here, and both fail silently when
 * broken, so both are pinned on both sides:
 *  - the DeviceEnd codes (`no-screen:lid`, `no-screen:virtual-failed`): the
 *    agent spells them for the sign-in-screen path, and its own test reads
 *    noScreen.ts;
 *  - the `prepare_screen` frame and its reply, pinned against the agent's
 *    protocol.rs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
    invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
}));

import {
    noScreenMessage, noScreenEndReason, virtualStartingMessage, LID_CLOSED_OPTION,
    NO_SCREEN_LID_REASON, NO_SCREEN_VIRTUAL_FAILED_REASON, NO_SCREEN_NO_FRAME_REASON,
    NO_SCREEN_SHARED_OFF_REASON, NO_SCREEN_CHANGED_REASON, noScreenCodeForShared,
    noScreenCodeForStreamEnd, AGENT_STREAM_END_NO_FRAME,
} from '../api/devices/noScreen';
import { agentAnswerOffer, agentPrepareScreen } from '../api/devices/hostAgent';

// agentAnswerOffer asks for ICE servers first; none needed to read its frame.
vi.mock('../api/iceConfig', () => ({ fetchIceConfig: async () => ({ iceServers: [] }) }));

describe('what the phone says when that PC has no screen on', () => {
    it('the lid reason names the PC, asks about the lid, and names the option to turn on', () => {
        const m = noScreenMessage(NO_SCREEN_LID_REASON, 'Work Laptop')!;
        expect(m).toBe('Work Laptop’s screen is off — is its lid closed? '
            + 'Turn on “Allow remote control with the lid closed” on that PC.');
        // The option's name is the settings card's own label, not a paraphrase
        // the person then cannot find.
        expect(m).toContain(LID_CLOSED_OPTION);
    });

    it('a virtual screen that did not start is a different sentence', () => {
        const m = noScreenMessage(NO_SCREEN_VIRTUAL_FAILED_REASON, 'Work Laptop')!;
        expect(m).toMatch(/^Work Laptop’s screen is off, and its virtual screen did not start/);
        expect(m).not.toContain(LID_CLOSED_OPTION);
    });

    it('a PC with no known name is "That PC", never an empty possessive', () => {
        expect(noScreenMessage(NO_SCREEN_LID_REASON, null)).toMatch(/^That PC’s screen is off/);
        expect(noScreenMessage(NO_SCREEN_LID_REASON, '   ')).toMatch(/^That PC’s screen is off/);
        expect(virtualStartingMessage(undefined)).toBe('That PC’s screen is off — starting a virtual screen…');
        expect(virtualStartingMessage('Work Laptop')).toBe('Work Laptop’s screen is off — starting a virtual screen…');
    });

    it('the host sends the code AND a sentence, and both forms are recognised', () => {
        for (const code of [NO_SCREEN_LID_REASON, NO_SCREEN_VIRTUAL_FAILED_REASON, NO_SCREEN_NO_FRAME_REASON]) {
            const wire = noScreenEndReason(code);
            expect(wire.startsWith(`${code} — that PC’s screen`)).toBe(true);
            // What a phone that knows the code shows is the same either way.
            expect(noScreenMessage(wire, 'Work Laptop')).toBe(noScreenMessage(code, 'Work Laptop'));
            // An OLDER phone shows it as it comes: it must fit what one shows
            // (200 characters) and what the server relays (512 bytes, ws.rs).
            expect(wire.length).toBeLessThanOrEqual(200);
            expect(new TextEncoder().encode(wire).length).toBeLessThan(512);
        }
        // The lid sentence names the option even in the fallback.
        expect(noScreenEndReason(NO_SCREEN_LID_REASON)).toContain(LID_CLOSED_OPTION);
        // A code this build does not know passes through untouched.
        expect(noScreenEndReason('something-else')).toBe('something-else');
    });

    it('a stream that never showed a picture names the PC and both likely causes', () => {
        const m = noScreenMessage(NO_SCREEN_NO_FRAME_REASON, 'Work Laptop')!;
        expect(m).toBe('Work Laptop’s screen did not show anything — it may be asleep, or its lid closed. '
            + 'Try again, or move its mouse.');
        expect(noScreenMessage(noScreenEndReason(NO_SCREEN_NO_FRAME_REASON), 'Work Laptop')).toBe(m);
    });

    it('NEGATIVE CONTROL: any other reason is not rewritten', () => {
        // A longer word that merely starts like a code is not the code.
        expect(noScreenMessage('no-screen:lidded', 'Work Laptop')).toBeNull();
        expect(noScreenMessage('the person at that device declined', 'Work Laptop')).toBeNull();
        expect(noScreenMessage('no-screen', 'Work Laptop')).toBeNull();
        expect(noScreenMessage('', 'Work Laptop')).toBeNull();
    });

    // REVIEW 2026-10-26: a session whose person shared ONE screen is not let
    // follow a lid, so its lid end means "the screen they shared is behind
    // the lid" — and the lid code's advice (turn on the lid option, usually on
    // already by then) would send the viewer to fix the wrong thing.
    it('the shared screen going dark is its own sentence, with the fix that works', () => {
        const m = noScreenMessage(NO_SCREEN_SHARED_OFF_REASON, 'Work Laptop')!;
        expect(m).toBe('Work Laptop’s shared screen went dark — is its lid closed? '
            + 'Only that screen was shared, so the picture could not move to another. '
            + 'Connect again with the lid open, or share another screen.');
        expect(m).not.toContain(LID_CLOSED_OPTION);
        expect(noScreenMessage(NO_SCREEN_SHARED_OFF_REASON, null)).toMatch(/^That PC’s shared screen/);
        const wire = noScreenEndReason(NO_SCREEN_SHARED_OFF_REASON);
        expect(wire.startsWith(`${NO_SCREEN_SHARED_OFF_REASON} — that PC’s shared screen`)).toBe(true);
        expect(noScreenMessage(wire, 'Work Laptop')).toBe(m);
        expect(wire.length).toBeLessThanOrEqual(200);
        expect(new TextEncoder().encode(wire).length).toBeLessThan(512);
    });

    // A stream pinned to the one shared screen whose capture shows another
    // (Windows renumbered the screens, or that one went away): ended, never
    // restarted, because a restart by index could land on a screen nobody
    // shared.
    it('the shared screen changing is its own sentence, and both forms are recognised', () => {
        const m = noScreenMessage(NO_SCREEN_CHANGED_REASON, 'Work Laptop')!;
        expect(m).toBe('Work Laptop’s shared screen changed or was turned off. Connect again to choose a screen.');
        expect(noScreenMessage(NO_SCREEN_CHANGED_REASON, null)).toMatch(/^That PC’s shared screen changed/);
        const wire = noScreenEndReason(NO_SCREEN_CHANGED_REASON);
        expect(wire.startsWith(`${NO_SCREEN_CHANGED_REASON} — that PC’s shared screen`)).toBe(true);
        expect(noScreenMessage(wire, 'Work Laptop')).toBe(m);
        expect(wire.length).toBeLessThanOrEqual(200);
        expect(noScreenCodeForShared(NO_SCREEN_CHANGED_REASON, false), 'its own words, not shared-off').toBe(NO_SCREEN_CHANGED_REASON);
    });

    it('a lid end is said as shared-off ONLY for a session that shared one screen', () => {
        expect(noScreenCodeForShared(NO_SCREEN_LID_REASON, false)).toBe(NO_SCREEN_SHARED_OFF_REASON);
        // CONTROLS: every screen shared, the lid code (and its advice) stands;
        // the other codes are never rewritten.
        expect(noScreenCodeForShared(NO_SCREEN_LID_REASON, true)).toBe(NO_SCREEN_LID_REASON);
        for (const code of [NO_SCREEN_VIRTUAL_FAILED_REASON, NO_SCREEN_NO_FRAME_REASON]) {
            expect(noScreenCodeForShared(code, false)).toBe(code);
            expect(noScreenCodeForShared(code, true)).toBe(code);
        }
    });

    it('the codes are the exact strings the agent ends a sign-in-screen session with', () => {
        // A DIFFERENT file from this one, so the scan cannot match itself.
        const agent = readFileSync(resolve(process.cwd(), '../crates/puca-agent/src/virtual_screen.rs'), 'utf8');
        expect(agent).toContain(`pub const NO_SCREEN_LID: &str = "${NO_SCREEN_LID_REASON}";`);
        expect(agent).toContain(`pub const NO_SCREEN_VIRTUAL_FAILED: &str = "${NO_SCREEN_VIRTUAL_FAILED_REASON}";`);
    });
});

/**
 * The agent's `stream_end` (its status poll) → the code a HOST ends with.
 * Since the agent follows a lid shut mid-session, a LIVE stream can end with
 * the session-start codes themselves, and a host that restarted those got the
 * same code back a round trip later.
 */
describe('noScreenCodeForStreamEnd', () => {
    it('no_frame and both lid codes end the session, each with its own code', () => {
        expect(noScreenCodeForStreamEnd('no_frame')).toBe(NO_SCREEN_NO_FRAME_REASON);
        expect(noScreenCodeForStreamEnd(NO_SCREEN_LID_REASON)).toBe(NO_SCREEN_LID_REASON);
        expect(noScreenCodeForStreamEnd(NO_SCREEN_VIRTUAL_FAILED_REASON)).toBe(NO_SCREEN_VIRTUAL_FAILED_REASON);
    });

    // A host app must END on every no-screen:* code the agent can send, and
    // restart on none (protocol: "an app from before it restarts on any code
    // it does not know, and a restart by index lands on whatever screen has
    // that index now"). Read from the agent, so a code added there without
    // this side knowing it fails here.
    it('every no-screen:* code the agent defines is an end, never a restart', () => {
        const agent = readFileSync(resolve(process.cwd(), '../crates/puca-agent/src/virtual_screen.rs'), 'utf8');
        const codes = [...agent.matchAll(/pub const NO_SCREEN_[A-Z_]+: &str = "(no-screen:[a-z-]+)";/g)].map(m => m[1]);
        expect(codes.sort(), 'the codes the agent spells today').toEqual(['no-screen:changed', 'no-screen:lid', 'no-screen:virtual-failed']);
        for (const code of codes) expect(noScreenCodeForStreamEnd(code), code).toBe(code);
    });

    it('so does a pinned stream whose screen changed under it: no restart by index', () => {
        expect(noScreenCodeForStreamEnd('no-screen:changed')).toBe(NO_SCREEN_CHANGED_REASON);
        expect(noScreenCodeForStreamEnd('no-screen:changed (index 1)'), 'literal, like the rest').toBeNull();
    });

    it('NEGATIVE CONTROL: anything else is restarted, not named (literal match only)', () => {
        for (const other of [undefined, null, '', 'exited', 'the encoder failed', 'no-screen', 'no-screen:lid (and more)', 'NO_FRAME', NO_SCREEN_NO_FRAME_REASON]) {
            expect(noScreenCodeForStreamEnd(other), String(other)).toBeNull();
        }
    });

    it('the capture ends the lid can cause, which a restart CAN fix, are restarted', () => {
        // stream.rs ends a stream with these when the screen it showed went
        // away or its capture showed another; session.rs stream_end_code
        // reports none of them, and should one ever reach stream_end, it is
        // still a restart, never a "screen is off" end. (A PINNED stream
        // whose capture shows another screen ends with no-screen:changed
        // instead, above; a steering one keeps this restartable end.)
        for (const restartable of [
            'capture: the screen this stream showed is gone',
            'capture: the capture is showing another screen than this stream\'s',
            'capture: no screen for 20 s after the lid changed the displays',
        ]) {
            expect(noScreenCodeForStreamEnd(restartable), restartable).toBeNull();
        }
        // The agent's one builder of these ends (stream.rs capture_failed_end):
        // "capture: …" for a restart, a no-screen code when it may not be.
        const stream = readFileSync(resolve(process.cwd(), '../crates/puca-agent/src/stream.rs'), 'utf8');
        expect(stream).toContain('format!("capture: {error}")');
    });

    it('the agent writes exactly these into stream_end (protocol.rs, its own pins)', () => {
        const protocol = readFileSync(resolve(process.cwd(), '../crates/puca-agent/src/protocol.rs'), 'utf8');
        expect(protocol).toContain(`"stream_end":"${AGENT_STREAM_END_NO_FRAME}"`);
        expect(protocol).toContain(`"stream_end":"${NO_SCREEN_LID_REASON}"`);
    });
});

/**
 * May the agent move the picture to another screen when a lid shuts on the
 * one it shows? Only a session whose consent covers every screen says yes
 * (session.ts consentCoversEveryScreen); this is the field that says it.
 * ALWAYS written, false included: it is a privacy boundary, and its meaning
 * must not hang on the agent's default staying false.
 */
describe('start_stream says whether a lid may move the picture', () => {
    beforeEach(() => {
        invokeMock.mockReset();
        invokeMock.mockResolvedValue(JSON.stringify({ ok: 'streaming', answer_sdp: 'v=0' }));
    });
    const frame = () => JSON.parse((invokeMock.mock.calls.at(-1)![1] as { request: string }).request) as Record<string, unknown>;

    it('steer_on_lid: true only when the session says every screen was shared', async () => {
        await agentAnswerOffer('s1', 'offer', 255, { steerOnLid: true });
        expect(frame().cmd).toBe('start_stream');
        expect(frame().steer_on_lid).toBe(true);
    });

    it('false is SENT, not left out — and so is an omitted option', async () => {
        await agentAnswerOffer('s1', 'offer', 0, { steerOnLid: false });
        expect(frame().steer_on_lid).toBe(false);
        await agentAnswerOffer('s1', 'offer', 0);
        expect('steer_on_lid' in frame()).toBe(true);
        expect(frame().steer_on_lid).toBe(false);
    });

    it('is the field the agent parses, with the default the absence means (protocol.rs pins both)', () => {
        const protocol = readFileSync(resolve(process.cwd(), '../crates/puca-agent/src/protocol.rs'), 'utf8');
        // The field, defaulted: absent (any app before it) is PINNED.
        expect(protocol).toMatch(/#\[serde\(default\)\]\s+steer_on_lid: bool,/);
        // And the frame its own test parses as "may steer".
        expect(protocol).toContain('"steer_on_lid":true}');
    });
});

describe('the prepare_screen poll', () => {
    beforeEach(() => { invokeMock.mockReset(); });

    const answer = async (reply: Record<string, unknown>) => {
        invokeMock.mockResolvedValue(JSON.stringify(reply));
        return agentPrepareScreen('s1');
    };

    it('sends EXACTLY the frame the Rust agent parses', async () => {
        await answer({ ok: 'screen', state: 'ready' });
        expect(invokeMock).toHaveBeenCalledWith('agent_request', {
            request: JSON.stringify({ cmd: 'prepare_screen', session_id: 's1' }),
        });
        // protocol.rs pins the same frame on its side.
        const protocol = readFileSync(resolve(process.cwd(), '../crates/puca-agent/src/protocol.rs'), 'utf8');
        expect(protocol).toContain('{"cmd":"prepare_screen","session_id":"s1"}');
    });

    it('every state the agent answers arrives as that state', async () => {
        expect(await answer({ ok: 'screen', state: 'ready' })).toEqual({ state: 'ready' });
        expect(await answer({ ok: 'screen', state: 'waking' })).toEqual({ state: 'waking' });
        expect(await answer({ ok: 'screen', state: 'starting' })).toEqual({ state: 'starting' });
        expect(await answer({ ok: 'screen', state: 'off', reason: NO_SCREEN_VIRTUAL_FAILED_REASON }))
            .toEqual({ state: 'off', reason: NO_SCREEN_VIRTUAL_FAILED_REASON });
    });

    it('"off" with no reason is still off, with the lid reason', async () => {
        expect(await answer({ ok: 'screen', state: 'off' })).toEqual({ state: 'off', reason: NO_SCREEN_LID_REASON });
    });

    it('an agent older than the command reads as ready — answer the offer, as before', async () => {
        // What a pre-PrepareScreen agent really sends.
        expect(await answer({ ok: 'error', message: 'bad request: prepare_screen' })).toEqual({ state: 'ready' });
        // A dead pipe, and a state this build has never heard of.
        invokeMock.mockRejectedValue(new Error('pipe closed'));
        expect(await agentPrepareScreen('s1')).toEqual({ state: 'ready' });
        expect(await answer({ ok: 'screen', state: 'dancing' })).toEqual({ state: 'ready' });
    });
});
