/**
 * THE SECURE-DESKTOP STATUS POLL — the cross-process wire contract.
 *
 * `sessionStatus` is one half of a name agreed between two binaries that share
 * no types: this file sends `{"cmd":"session_status"}`, and Rust's
 * `Request::SessionStatus` (serde tag "cmd", snake_case) is what receives it.
 * A guessed cross-process identifier does not fail loudly — it just stops
 * working, and a poll that silently answers "no" forever looks exactly like a
 * machine that never shows a UAC prompt. So the literal is pinned here, and its
 * twin is pinned in `crates/puca-agent/src/protocol.rs`.
 *
 * The other property under test is that this call CANNOT THROW. It runs once a
 * second for the life of a hosted session; an agent older than the command
 * answers `{"ok":"error"}`, which `request()` turns into a throw, and an
 * escaped rejection at 1Hz would be a session-killing error storm.
 *
 * `cursor_clipped` rides the same reply and the same rules: `=== true` at the
 * parse, absence reads as false (that is the OLD-agent skew case, and the Rust
 * pin explicitly delegates it to this file — Response is Serialize-only there,
 * so this parser is the only place the promise can be tested).
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
    invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
}));

// Only @tauri-apps/api/core is mocked — the same reasoning as
// streamQuality.test.ts: it is the only module hostAgent.ts actually imports
// on this path, and a mock for anything else would be decoration.
import { agentHostBackend } from '../api/devices/hostAgent';

describe('the secure-desktop status poll', () => {
    beforeEach(() => { invokeMock.mockReset(); });

    test('sends EXACTLY the frame the Rust agent parses', async () => {
        invokeMock.mockResolvedValue(JSON.stringify({ ok: 'session_state', secure_desktop: false }));
        await agentHostBackend().sessionStatus!('s1');
        expect(invokeMock).toHaveBeenCalledWith('agent_request', {
            request: JSON.stringify({ cmd: 'session_status', session_id: 's1' }),
        });
    });

    test('POSITIVE CONTROL: a blocked agent is reported as blocked', async () => {
        invokeMock.mockResolvedValue(JSON.stringify({ ok: 'session_state', secure_desktop: true }));
        expect(await agentHostBackend().sessionStatus!('s1'))
            .toEqual({ secureDesktop: true, cursorClipped: false });
    });

    test('an unblocked agent is reported as unblocked', async () => {
        invokeMock.mockResolvedValue(JSON.stringify({ ok: 'session_state', secure_desktop: false }));
        expect(await agentHostBackend().sessionStatus!('s1'))
            .toEqual({ secureDesktop: false, cursorClipped: false });
    });

    test('POSITIVE CONTROL: a clip conflict is reported as one', async () => {
        invokeMock.mockResolvedValue(JSON.stringify({
            ok: 'session_state', secure_desktop: false, cursor_clipped: true,
        }));
        expect(await agentHostBackend().sessionStatus!('s1'))
            .toEqual({ secureDesktop: false, cursorClipped: true });
    });

    test('an agent that predates cursor_clipped reads as "not clipped"', async () => {
        // THE SKEW PIN protocol.rs delegates here: an old agent omits the
        // field entirely, and absence must read as false — never as an error,
        // never as a banner.
        invokeMock.mockResolvedValue(JSON.stringify({ ok: 'session_state', secure_desktop: true }));
        expect(await agentHostBackend().sessionStatus!('s1'))
            .toEqual({ secureDesktop: true, cursorClipped: false });
    });

    test('an agent older than the command answers false rather than throwing', async () => {
        // What a pre-SessionStatus agent really sends: pipe.rs answers rather
        // than dropping, so the caller gets a refusal, not a dead pipe.
        invokeMock.mockResolvedValue(JSON.stringify({ ok: 'error', message: 'bad request: session_status' }));
        await expect(agentHostBackend().sessionStatus!('s1'))
            .resolves.toEqual({ secureDesktop: false, cursorClipped: false });
    });

    test('a dead pipe answers false rather than throwing', async () => {
        invokeMock.mockRejectedValue(new Error('pipe closed'));
        await expect(agentHostBackend().sessionStatus!('s1'))
            .resolves.toEqual({ secureDesktop: false, cursorClipped: false });
    });

    test('a reply with no field, or a non-boolean one, is not a security prompt', async () => {
        // typeof, not truthiness. A banner telling the user their machine is
        // unreachable must need a real boolean behind it.
        invokeMock.mockResolvedValue(JSON.stringify({ ok: 'session_state' }));
        expect(await agentHostBackend().sessionStatus!('s1'))
            .toEqual({ secureDesktop: false, cursorClipped: false });

        invokeMock.mockResolvedValue(JSON.stringify({
            ok: 'session_state', secure_desktop: 'yes', cursor_clipped: 'yes',
        }));
        expect(await agentHostBackend().sessionStatus!('s1'))
            .toEqual({ secureDesktop: false, cursorClipped: false });
    });
});
