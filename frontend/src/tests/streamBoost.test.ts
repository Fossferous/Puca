/**
 * Holder lifecycle of the streaming priority boost (api/streamBoost.ts).
 *
 * The contract under test: the Rust side is told "on" exactly when the FIRST
 * holder appears and "off" exactly when the LAST one releases — never per
 * holder, never for a holder that was not held, and never at all outside the
 * Tauri shell. A double "on" would be survivable (the command is idempotent);
 * a missed "off" would leave the user's game deprioritised after the share
 * ends, which is the bug class the holder set exists to prevent.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({
    invokeMock: vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>()
        .mockResolvedValue(0),
}));
// Only @tauri-apps/api/core is mocked — it is the only module streamBoost.ts
// touches that cannot exist under jsdom.
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import {
    holdStreamBoost,
    releaseStreamBoost,
    streamBoostHolders,
    streamBoostSettled,
} from '../api/streamBoost';

function boostCalls(): Array<{ active: boolean }> {
    return invokeMock.mock.calls
        .filter(([cmd]) => cmd === 'set_stream_boost')
        .map(([, args]) => args as { active: boolean });
}

beforeEach(async () => {
    // The module keeps state across tests in this file: drain any holders a
    // previous test left, then start counting from zero.
    for (const h of streamBoostHolders()) releaseStreamBoost(h);
    await streamBoostSettled();
    invokeMock.mockClear();
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
});

describe('streamBoost holder lifecycle', () => {
    it('first holder turns the boost on; further holders do not re-send', async () => {
        holdStreamBoost('voice-share');
        holdStreamBoost('device-host');
        holdStreamBoost('voice-share'); // idempotent per holder
        await streamBoostSettled();
        // Positive control for every "was not called" assertion in this file:
        // the rig CAN observe the invoke when it happens.
        expect(boostCalls()).toEqual([{ active: true }]);
        expect(streamBoostHolders().sort()).toEqual(['device-host', 'voice-share']);
    });

    it('boost drops only when the LAST holder releases', async () => {
        holdStreamBoost('voice-share');
        holdStreamBoost('device-host');
        releaseStreamBoost('voice-share');
        await streamBoostSettled();
        expect(boostCalls()).toEqual([{ active: true }]); // still held
        releaseStreamBoost('device-host');
        await streamBoostSettled();
        expect(boostCalls()).toEqual([{ active: true }, { active: false }]);
        expect(streamBoostHolders()).toEqual([]);
    });

    it('releasing a holder that was never held sends nothing', async () => {
        releaseStreamBoost('voice-share');
        await streamBoostSettled();
        expect(boostCalls()).toEqual([]);
    });

    it('on/off arrive in order under a rapid share start-stop', async () => {
        holdStreamBoost('voice-share');
        releaseStreamBoost('voice-share');
        holdStreamBoost('voice-share');
        releaseStreamBoost('voice-share');
        await streamBoostSettled();
        expect(boostCalls()).toEqual([
            { active: true }, { active: false },
            { active: true }, { active: false },
        ]);
    });

    it('does nothing outside the Tauri shell (browser / mobile)', async () => {
        delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
        holdStreamBoost('voice-share');
        await streamBoostSettled();
        expect(boostCalls()).toEqual([]);
        expect(streamBoostHolders()).toEqual([]);
    });
});
