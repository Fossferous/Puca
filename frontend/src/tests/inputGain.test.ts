// @vitest-environment jsdom
import { describe, it, expect, beforeEach, type Mock } from 'vitest';
import { inputGain, loadSettings, saveSettings } from '../components/settingsStore';
import { getMicConstraints, setNoiseSuppressionMode } from '../api/noiseFilter';

function setVoice(fields: Partial<ReturnType<typeof loadSettings>>) {
    saveSettings({ ...loadSettings(), ...fields });
}

// The global test setup replaces localStorage with bare vi.fn() stubs that
// store nothing — back them with a real map so settings round-trip.
const store = new Map<string, string>();
beforeEach(() => {
    store.clear();
    (localStorage.getItem as Mock).mockImplementation((k: string) => store.get(k) ?? null);
    (localStorage.setItem as Mock).mockImplementation((k: string, v: string) => { store.set(k, String(v)); });
    (localStorage.clear as Mock).mockImplementation(() => store.clear());
});

describe('inputGain', () => {
    it('is 1.0 at defaults — the zero-cost path', () => {
        expect(inputGain()).toBe(1);
    });

    it('scales with Input Volume', () => {
        setVoice({ inputVolume: 50 });
        expect(inputGain()).toBe(0.5);
        setVoice({ inputVolume: 200 });
        expect(inputGain()).toBe(2);
    });

    it('applies Manual Gain only when auto-gain is OFF', () => {
        setVoice({ inputVolume: 100, manualGain: 200, autoGainControl: true });
        expect(inputGain()).toBe(1); // AGC on: manual boost would just be fought
        setVoice({ autoGainControl: false });
        expect(inputGain()).toBe(2);
    });

    it('composes multiplicatively and clamps to [0, 4]', () => {
        setVoice({ inputVolume: 200, manualGain: 200, autoGainControl: false });
        expect(inputGain()).toBe(4);
        setVoice({ inputVolume: 0 });
        expect(inputGain()).toBe(0);
    });
});

describe('getMicConstraints honours the Settings toggles', () => {
    it('passes EC/AGC through in every mode', () => {
        setVoice({ echoCancellation: false, autoGainControl: false, noiseSuppression: true });
        for (const mode of ['off', 'standard', 'rnnoise'] as const) {
            const c = getMicConstraints(mode);
            expect(c.echoCancellation).toBe(false);
            expect(c.autoGainControl).toBe(false);
        }
    });

    it('native NS only in standard mode AND when the toggle is on', () => {
        setVoice({ noiseSuppression: true });
        expect(getMicConstraints('standard').noiseSuppression).toBe(true);
        expect(getMicConstraints('off').noiseSuppression).toBe(false);
        expect(getMicConstraints('rnnoise').noiseSuppression).toBe(false); // RNNoise replaces it
        setVoice({ noiseSuppression: false });
        expect(getMicConstraints('standard').noiseSuppression).toBe(false);
    });

    it('keeps voice mono', () => {
        expect(getMicConstraints('standard').channelCount).toBe(1);
    });

    it('defaults to the current mode', () => {
        setNoiseSuppressionMode('standard', false);
        setVoice({ noiseSuppression: true });
        expect(getMicConstraints().noiseSuppression).toBe(true);
    });
});
