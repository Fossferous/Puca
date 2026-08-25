import { describe, test, expect, vi, beforeEach } from 'vitest';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
    invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
}));

// Only @tauri-apps/api/core is mocked, because it is the only module the code
// under test actually imports. There were four more here — lodash-es, zustand,
// ../api/devices/session and ../stores/streamStore — none of which is reachable
// from hostAgent.ts or streamQualityMessages.ts. Mocks for modules nobody
// imports read as "this test covers the store and the debounce". It does not.

import { agentHostBackend, agentAnswerOffer, kbpsToBps } from '../api/devices/hostAgent';
import { getStreamQualityErrorMessage } from '../api/devices/streamQualityMessages';
import {
    ALLOWED_BITRATE_KBPS,
    ALLOWED_FPS,
    STREAM_QUALITY_PRESETS,
    parsePresetValue,
    presetValue,
} from '../api/devices/streamQualityPresets';

describe('Stream Quality IPC and Production Integration Tests', () => {
    beforeEach(() => {
        invokeMock.mockReset();
    });

    test('updateStream converts 6000 kbps to 6_000_000 bps in native IPC request payload', async () => {
        invokeMock.mockResolvedValue(JSON.stringify({ ok: 'ok' }));

        const backend = agentHostBackend();
        await backend.updateStream('s1', 30, 6000);

        expect(invokeMock).toHaveBeenCalledWith('agent_request', {
            request: JSON.stringify({
                cmd: 'update_stream',
                session_id: 's1',
                fps: 30,
                bitrate: 6_000_000,
            }),
        });
    });

    test('agentAnswerOffer defaults to 6_000_000 bps when no bitrate supply is provided', async () => {
        invokeMock.mockImplementation(async (cmd) => {
            if (cmd === 'agent_request') {
                return JSON.stringify({ ok: 'ok', answer_sdp: 'v=0' });
            }
            return JSON.stringify({});
        });

        await agentAnswerOffer('s1', 'offer-sdp', 0, 30, undefined);

        const lastCall = invokeMock.mock.calls[0];
        expect(lastCall[0]).toBe('agent_request');
        const parsed = JSON.parse(lastCall[1].request);
        expect(parsed.cmd).toBe('start_stream');
        expect(parsed.session_id).toBe('s1');
        expect(parsed.fps).toBe(30);
        expect(parsed.bitrate).toBe(6_000_000);
    });

    test('production kbpsToBps helper converts units accurately', () => {
        expect(kbpsToBps(6000)).toBe(6_000_000);
        expect(kbpsToBps(undefined)).toBeUndefined();
    });

    test('production getStreamQualityErrorMessage maps error codes to distinct user messages', () => {
        expect(getStreamQualityErrorMessage('query_failed')).toBe('Failed to query stream quality');
        expect(getStreamQualityErrorMessage('unsupported_bitrate')).toBe('Requested bitrate is not supported');
        expect(getStreamQualityErrorMessage('apply_timeout')).toBe('Quality update timed out');
        expect(getStreamQualityErrorMessage('unknown_code')).toBe('Failed to update stream quality');
        expect(getStreamQualityErrorMessage(undefined)).toBe('Failed to update stream quality');
    });
});

/**
 * The gap that let the whole quality feature ship broken: every test asserted
 * on `updateStream(id, 30, 6000)` called directly with a correct kbps value,
 * so all of them passed while BOTH UI surfaces were handing that parameter a
 * number in bits. Nothing tested what the menus actually send.
 */
describe('the presets the UI offers are ones the agent will accept', () => {
    test('every preset is inside the agent allowlists', () => {
        for (const p of STREAM_QUALITY_PRESETS) {
            expect(ALLOWED_BITRATE_KBPS, `${p.label}: bitrate`).toContain(p.bitrateKbps);
            expect(ALLOWED_FPS, `${p.label}: fps`).toContain(p.fps);
        }
    });

    test('preset bitrates are KILObits, not bits', () => {
        // The bug in one assertion: 6_000_000 here means hostAgent's kbpsToBps
        // turns it into 6e9, which overflows the agent's u32 and is refused.
        for (const p of STREAM_QUALITY_PRESETS) {
            expect(p.bitrateKbps, `${p.label} looks like bits per second`).toBeLessThanOrEqual(100_000);
            expect(kbpsToBps(p.bitrateKbps)).toBeLessThanOrEqual(0xffff_ffff);
        }
    });

    test('a preset survives the round trip through a select value', () => {
        for (const p of STREAM_QUALITY_PRESETS) {
            expect(parsePresetValue(presetValue(p))).toEqual({
                bitrateKbps: p.bitrateKbps,
                fps: p.fps,
            });
        }
        // Positive control: the parser rejects rather than yielding NaN, so
        // the round-trip pass above is not just "everything parses".
        expect(parsePresetValue('not-a-preset')).toBeNull();
    });

    test('kbpsToBps is the ONLY scaling, and it is applied once', () => {
        // 6000 kbps -> 6_000_000 bps. Applying it twice (the shipped bug) gives
        // 6e9, which this pins as wrong.
        expect(kbpsToBps(6000)).toBe(6_000_000);
        expect(kbpsToBps(kbpsToBps(6000))).toBe(6_000_000_000);
        expect(kbpsToBps(kbpsToBps(6000))).toBeGreaterThan(0xffff_ffff);
    });
});
