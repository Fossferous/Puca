/**
 * The lite stand-in for rtc/controlDc must export exactly what the voice code
 * imports from the real module, with the same kinds — vite.config.ts swaps it
 * in for lite builds, and a missing binding there is a load-time failure in a
 * bundle nothing else type-checks against.
 */
import { describe, it, expect } from 'vitest';
import * as real from '../api/rtc/controlDc';
import * as lite from '../api/rtc/controlDc.lite';

// The names the mesh manager, the SFU manager and VoicePanel import.
const USED = ['CTL_STATE_LABEL', 'CTL_SFU_TOPIC', 'registerControlChannel', 'forgetControlChannels', 'deliverSfuControlFrame', 'setSfuControlSender'] as const;

describe('rtc/controlDc.lite', () => {
    it('exports every symbol the voice code imports, of the same kind and with the same constants', () => {
        for (const name of USED) {
            expect(typeof (lite as Record<string, unknown>)[name], name).toBe(typeof (real as Record<string, unknown>)[name]);
        }
        expect(lite.CTL_STATE_LABEL).toBe(real.CTL_STATE_LABEL);
        expect(lite.CTL_SFU_TOPIC).toBe(real.CTL_SFU_TOPIC);
    });
    it('is inert: registering, delivering and forgetting do nothing and throw nothing', () => {
        expect(() => lite.registerControlChannel(1, {} as RTCDataChannel)).not.toThrow();
        expect(() => lite.deliverSfuControlFrame(1, new Uint8Array([1, 2, 3]))).not.toThrow();
        expect(() => lite.setSfuControlSender(() => true)).not.toThrow();
        expect(() => lite.forgetControlChannels(1)).not.toThrow();
    });
});
