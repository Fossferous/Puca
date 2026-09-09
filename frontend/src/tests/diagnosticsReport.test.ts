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

import { buildDiagnosticsReport, copyDiagnostics, environmentLines } from '../api/diagnosticsReport';

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
});
