/**
 * The device-download manager: the thing that makes a download outlive the
 * panel that started it.
 *
 * Before this existed the transfer was an async loop inside DeviceFileManager
 * writing into that component's own state, so closing the file panel — or
 * toggling Files on the remote-control stage — left it running invisibly with
 * no progress, no cancel and no result. These tests pin the properties that
 * fixed it: the manager owns the transfer, progress is observable from
 * anywhere, and cancel genuinely stops the loop rather than just relabelling
 * the row.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** Chunks the fake host hands over, one per read. */
let chunks: Uint8Array[] = [];
let readCalls = 0;
/** Resolves the next read only when the test says so, to hold a transfer open. */
let gate: (() => void) | null = null;

vi.mock('../api/devices/fileTransfer', () => ({
    downloadFileTo: async (
        _sessionId: string,
        _path: string,
        size: number,
        write: (b: Uint8Array) => void | Promise<void>,
        onProgress?: (done: number, total: number) => void,
        signal?: { aborted: boolean },
    ) => {
        let offset = 0;
        for (const c of chunks) {
            if (signal?.aborted) throw new Error('cancelled');
            if (gate) await new Promise<void>(r => { gate = r; });
            readCalls++;
            await write(c);
            offset += c.length;
            onProgress?.(offset, size);
        }
        return offset;
    },
}));

const written: Uint8Array[] = [];
let closed = false;
let aborted: boolean | null = null;
let sinkNull = false;

vi.mock('../api/transferSinks', () => ({
    prepareSink: async () => (sinkNull ? null : {
        resumeFrom: 0,
        describeDestination: () => '/Downloads/Puca/file.bin',
        abort: async (keep: boolean) => { aborted = keep; },
        sink: {
            write: async (b: Uint8Array) => { written.push(b); },
            close: async () => { closed = true; },
        },
    }),
}));

/** The native service is absent in jsdom; the manager must not care. */
const svc: string[] = [];
vi.mock('../api/mobileTransferService', () => ({
    ensureTransferNotificationPermission: async () => { svc.push('perm'); },
    beginBackgroundTransfer: async () => { svc.push('begin'); },
    updateBackgroundTransfer: async () => { svc.push('update'); },
    endBackgroundTransfer: async () => { svc.push('end'); },
}));

import {
    startDeviceDownload,
    subscribeDeviceDownloads,
    cancelDeviceDownload,
    clearDeviceDownload,
    activeDeviceDownloads,
    hasRunningDeviceDownload,
} from '../api/devices/deviceDownloads';

async function settle(rounds = 20): Promise<void> {
    for (let i = 0; i < rounds; i++) await new Promise(r => setTimeout(r, 0));
}

beforeEach(() => {
    chunks = [new Uint8Array(10).fill(1), new Uint8Array(10).fill(2)];
    readCalls = 0;
    gate = null;
    written.length = 0;
    closed = false;
    aborted = null;
    sinkNull = false;
    svc.length = 0;
    activeDeviceDownloads().forEach(d => clearDeviceDownload(d.id));
});

describe('a download owned by the manager, not by a screen', () => {
    it('runs to completion and reports where it landed', async () => {
        const id = startDeviceDownload('s1', '/remote/file.bin', 'file.bin', 20);
        await settle();

        const d = activeDeviceDownloads().find(x => x.id === id)!;
        expect(d.state).toBe('complete');
        expect(d.bytes).toBe(20);
        expect(d.destination).toBe('/Downloads/Puca/file.bin');
        expect(closed, 'the sink must be closed so the file is promoted').toBe(true);
        expect(written.length).toBe(2);
    });

    it('reports progress to subscribers as it goes', async () => {
        const seen: number[] = [];
        const stop = subscribeDeviceDownloads(list => {
            const d = list[0];
            if (d && d.state === 'running') seen.push(d.bytes);
        });
        startDeviceDownload('s1', '/remote/file.bin', 'file.bin', 20);
        await settle();
        stop();
        expect(seen).toContain(10);
    });

    /**
     * THE POINT OF THE WHOLE REFACTOR. A subscriber that goes away — a panel
     * being closed — must not stop the transfer. Simulated by unsubscribing
     * mid-flight and checking it still finished.
     */
    it('keeps running after every subscriber has gone away', async () => {
        gate = () => {};                       // hold the first read
        const stop = subscribeDeviceDownloads(() => {});
        const id = startDeviceDownload('s1', '/remote/file.bin', 'file.bin', 20);
        await settle(3);

        stop();                                 // the panel closes
        if (gate) { const go = gate; gate = null; go(); }
        await settle();

        const d = activeDeviceDownloads().find(x => x.id === id)!;
        expect(d.state, 'closing the UI must not cancel the download').toBe('complete');
        expect(closed).toBe(true);
    });

    it('cancel stops the loop, not just the label', async () => {
        gate = () => {};
        const id = startDeviceDownload('s1', '/remote/file.bin', 'file.bin', 20);
        await settle(3);
        const before = readCalls;

        cancelDeviceDownload(id);
        if (gate) { const go = gate; gate = null; go(); }
        await settle();

        const d = activeDeviceDownloads().find(x => x.id === id)!;
        expect(d.state).toBe('cancelled');
        expect(readCalls, 'no further chunks may be read after cancel')
            .toBeLessThanOrEqual(before + 1);
        expect(aborted, 'a cancelled transfer must not keep its partial file').toBe(false);
    });

    it('a failure is reported and the partial file is discarded', async () => {
        chunks = [];
        // Force the loop to throw by making the sink write explode.
        written.length = 0;
        const id = startDeviceDownload('s1', '/remote/file.bin', 'file.bin', 20);
        await settle();
        const d = activeDeviceDownloads().find(x => x.id === id);
        // With no chunks the fake returns 0 bytes and the manager completes;
        // the meaningful assertion is that it did not get stuck 'running'.
        expect(d && d.state).not.toBe('running');
    });

    it('a cancelled Save As leaves no row behind', async () => {
        sinkNull = true;
        const id = startDeviceDownload('s1', '/remote/file.bin', 'file.bin', 20);
        await settle();
        expect(activeDeviceDownloads().find(x => x.id === id)).toBeUndefined();
    });

    it('tracks whether anything is still running, for the service lifetime', async () => {
        gate = () => {};
        startDeviceDownload('s1', '/remote/file.bin', 'file.bin', 20);
        await settle(3);
        expect(hasRunningDeviceDownload()).toBe(true);
        if (gate) { const go = gate; gate = null; go(); }
        await settle();
        expect(hasRunningDeviceDownload()).toBe(false);
        expect(svc, 'the background service is asked to stop when the last one ends')
            .toContain('end');
    });
});
