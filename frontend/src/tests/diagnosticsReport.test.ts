/**
 * "Copy diagnostics" has to survive the moment it is used.
 *
 * It is offered to somebody whose call is already going wrong, from a
 * right-click menu, at the request of whoever is helping them. If it throws,
 * they get nothing and try once. So the contract is: always return a sentence,
 * never raise — and if one section cannot be gathered, say which and keep the
 * rest, because a partial report still names the encoder.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { voiceDiagnostics, meshDiagnostics, currentAppVersion, writeText } = vi.hoisted(() => ({
    voiceDiagnostics: vi.fn(),
    meshDiagnostics: vi.fn(),
    currentAppVersion: vi.fn(),
    writeText: vi.fn(),
}));

vi.mock('../api/rtc/sfuManager', () => ({ sfuManager: { voiceDiagnostics } }));
vi.mock('../api/webrtc', () => ({ webrtcManager: { meshDiagnostics } }));
vi.mock('../api/appVersion', () => ({ currentAppVersion }));

import { buildDiagnosticsReport, copyDiagnostics, environmentLines, encodingSupportLines } from '../api/diagnosticsReport';

beforeEach(() => {
    voiceDiagnostics.mockReset().mockResolvedValue({ connected: true, remoteRtp: [] });
    meshDiagnostics.mockReset().mockResolvedValue([]);
    currentAppVersion.mockReset().mockResolvedValue('0.9.805');
    writeText.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});

describe('the diagnostics report', () => {
    it('leads with what the app IS, before what it is doing', () => {
        // A report from a build we did not expect is worth knowing about
        // before anything measured in it is believed.
        const lines = environmentLines('2026-09-09T00:00:00Z', '0.9.805');
        expect(lines[0]).toContain('2026-09-09T00:00:00Z');
        expect(lines.join('\n')).toContain('0.9.805');
    });

    it('gathers both transports and says when one is empty', async () => {
        const text = await buildDiagnosticsReport();
        expect(voiceDiagnostics).toHaveBeenCalled();
        expect(meshDiagnostics).toHaveBeenCalled();
        expect(text).toContain('no peer-to-peer connections');
    });

    it('keeps the rest of the report when one section fails', async () => {
        // The section that broke is itself a fact. Losing the encoder because
        // the mesh manager threw would be the report failing at its one job.
        meshDiagnostics.mockRejectedValue(new Error('no manager'));
        voiceDiagnostics.mockResolvedValue({ encoder: 'OpenH264' });
        const text = await buildDiagnosticsReport();
        expect(text).toContain('OpenH264');
        expect(text).toContain('mesh unavailable');
    });

    it('returns a sentence rather than throwing when the clipboard refuses', async () => {
        writeText.mockRejectedValue(new Error('not focused'));
        const note = await copyDiagnostics();
        expect(note).toMatch(/clipboard/i);
        // POSITIVE CONTROL: it really does say something different when it works.
        writeText.mockResolvedValue(undefined);
        expect(await copyDiagnostics()).toMatch(/copied/i);
    });

    it('never throws even when everything fails at once', async () => {
        currentAppVersion.mockRejectedValue(new Error('no shell'));
        voiceDiagnostics.mockRejectedValue(new Error('no room'));
        meshDiagnostics.mockRejectedValue(new Error('no manager'));
        writeText.mockRejectedValue(new Error('denied'));
        await expect(copyDiagnostics()).resolves.toEqual(expect.any(String));
    });

    it('puts the encoder section IN the report, not just in a function', async () => {
        // THE GAP THIS CLOSES. Every other case here calls
        // encodingSupportLines() directly, so the whole section could be
        // dropped from buildDiagnosticsReport and every test would stay green
        // — and that section is the entire point of the change that added it:
        // it is how the machine that is actually struggling answers the
        // hardware question about itself.
        const isConfigSupported = vi.fn().mockResolvedValue({ supported: true });
        Object.defineProperty(globalThis, 'VideoEncoder', { value: { isConfigSupported }, configurable: true });
        const text = await buildDiagnosticsReport();
        expect(text).toContain('video encoding this machine can offer');
        expect(text).toContain('H.264 High');
        expect(text).toContain('hardware=');
        expect(isConfigSupported).toHaveBeenCalled();
    });

    it('asks WebCodecs whether a codec can be encoded in hardware, not mediaCapabilities', async () => {
        // THE BUG THIS PINS. The first version of this asked
        // `mediaCapabilities.encodingInfo({type:'webrtc'})`. Measured on an
        // RTX 4080 SUPER, that returned powerEfficient=false at the exact
        // moment outbound-rtp reported the NVIDIA H.264 Encoder MFT with
        // powerEfficientEncoder=true, in the same renderer. A diagnostic that
        // is confidently wrong is worse than none, because it ends the
        // investigation. WebCodecs `isConfigSupported` with
        // 'prefer-hardware' answered correctly on the same machine.
        const encodingInfo = vi.fn().mockResolvedValue({ supported: true, smooth: true, powerEfficient: false });
        Object.defineProperty(navigator, 'mediaCapabilities', { value: { encodingInfo }, configurable: true });
        const isConfigSupported = vi.fn().mockResolvedValue({ supported: true });
        Object.defineProperty(globalThis, 'VideoEncoder', { value: { isConfigSupported }, configurable: true });

        const lines = (await encodingSupportLines()).join('\n');
        expect(lines).toContain('H.264 High');
        expect(lines).toContain('hardware=true');
        expect(isConfigSupported).toHaveBeenCalled();
        // The whole point: the lying API must not be consulted at all.
        expect(encodingInfo).not.toHaveBeenCalled();
    });

    it('asks for hardware specifically, at the sizes a share uses', async () => {
        // 'prefer-hardware' is the entire question. Without it the answer is
        // "can this be encoded", which is yes on every machine ever made and
        // tells nobody anything.
        const isConfigSupported = vi.fn().mockResolvedValue({ supported: true });
        Object.defineProperty(globalThis, 'VideoEncoder', { value: { isConfigSupported }, configurable: true });
        await encodingSupportLines();
        for (const call of isConfigSupported.mock.calls) {
            expect(call[0].hardwareAcceleration).toBe('prefer-hardware');
            expect(call[0].width).toBeGreaterThanOrEqual(1920);
        }
    });

    it('reports a refusal as a refusal, and never as hardware', async () => {
        // POSITIVE CONTROL for the assertion above: a machine that says no
        // must read as no, or 'hardware=true' proves nothing.
        const isConfigSupported = vi.fn().mockResolvedValue({ supported: false });
        Object.defineProperty(globalThis, 'VideoEncoder', { value: { isConfigSupported }, configurable: true });
        expect((await encodingSupportLines()).join('\n')).toContain('hardware=false');

        // A throw is not a "no" — it is a question that could not be asked,
        // and the report says which.
        isConfigSupported.mockRejectedValue(new Error('bad codec string'));
        const thrown = (await encodingSupportLines()).join('\n');
        expect(thrown).toContain('asked and refused');
        expect(thrown).not.toContain('hardware=false');
    });

    it('survives a browser with no WebCodecs at all', async () => {
        Object.defineProperty(globalThis, 'VideoEncoder', { value: undefined, configurable: true });
        expect((await encodingSupportLines()).join('\n')).toContain('WebCodecs unavailable');
    });

    it('warns about the floor that makes hardware support irrelevant', async () => {
        // Chromium encodes anything under 360 lines in SOFTWARE on purpose,
        // whatever the card can do. Measured: 640x360 hardware, 576x324
        // software, flag flipped as a positive control. Somebody reading a
        // report full of hardware=true while their bottom simulcast rung is
        // 480x270 needs this sentence.
        const isConfigSupported = vi.fn().mockResolvedValue({ supported: true });
        Object.defineProperty(globalThis, 'VideoEncoder', { value: { isConfigSupported }, configurable: true });
        expect((await encodingSupportLines()).join('\n')).toContain('360 lines');
    });
});
