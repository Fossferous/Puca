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
    NO_SCREEN_LID_REASON, NO_SCREEN_VIRTUAL_FAILED_REASON,
} from '../api/devices/noScreen';
import { agentPrepareScreen } from '../api/devices/hostAgent';

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
        for (const code of [NO_SCREEN_LID_REASON, NO_SCREEN_VIRTUAL_FAILED_REASON]) {
            const wire = noScreenEndReason(code);
            expect(wire.startsWith(`${code} — that PC’s screen is off`)).toBe(true);
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

    it('NEGATIVE CONTROL: any other reason is not rewritten', () => {
        // A longer word that merely starts like a code is not the code.
        expect(noScreenMessage('no-screen:lidded', 'Work Laptop')).toBeNull();
        expect(noScreenMessage('the person at that device declined', 'Work Laptop')).toBeNull();
        expect(noScreenMessage('no-screen', 'Work Laptop')).toBeNull();
        expect(noScreenMessage('', 'Work Laptop')).toBeNull();
    });

    it('the codes are the exact strings the agent ends a sign-in-screen session with', () => {
        // A DIFFERENT file from this one, so the scan cannot match itself.
        const agent = readFileSync(resolve(process.cwd(), '../crates/puca-agent/src/virtual_screen.rs'), 'utf8');
        expect(agent).toContain(`pub const NO_SCREEN_LID: &str = "${NO_SCREEN_LID_REASON}";`);
        expect(agent).toContain(`pub const NO_SCREEN_VIRTUAL_FAILED: &str = "${NO_SCREEN_VIRTUAL_FAILED_REASON}";`);
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
