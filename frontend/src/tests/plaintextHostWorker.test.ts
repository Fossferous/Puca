// @vitest-environment jsdom
/**
 * The plaintext host worker itself (api/plaintextHost.worker.ts), loaded
 * under a stand-in worker scope: it registers what the page hands it, takes
 * a URL back on `drop`, and on `collect` makes its own isolate collect its
 * garbage. That last one is what lets a small file go from the disk while
 * others in the same shared worker are still shown: the worker's received
 * copy of the Blob is garbage it does not collect while it idles, and it
 * keeps the file (measured on a real disk, with this worker's `collect`
 * made a no-op as the NEGATIVE CONTROL: e2e/plaintext-disk-real-browser.mjs,
 * small files let go of beside others still shown).
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

const nudges = vi.hoisted(() => ({ n: 0 }));
vi.mock('../api/collectGarbage', () => ({ nudgeCollection: () => { nudges.n++; } }));

const posted: unknown[] = [];
const made: Blob[] = [];
const revoked: string[] = [];
const origCreate = URL.createObjectURL;
const origRevoke = URL.revokeObjectURL;
let deliver: (data: unknown) => void;

beforeAll(async () => {
    vi.spyOn(window, 'postMessage').mockImplementation(((m: unknown) => { posted.push(m); }) as typeof window.postMessage);
    URL.createObjectURL = ((b: Blob) => { made.push(b); return `blob:worker-${made.length}`; }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = ((u: string) => { revoked.push(u); }) as typeof URL.revokeObjectURL;
    await import('../api/plaintextHost.worker');
    const handler = window.onmessage as unknown as (e: { data: unknown }) => void;
    deliver = (data) => handler({ data });
});

afterAll(() => {
    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;
    vi.restoreAllMocks();
});

describe('the plaintext host worker', () => {
    it('says it started, registers a Blob it is handed, and takes the URL back on drop', () => {
        expect(posted[0]).toEqual({ ready: true });
        const blob = new Blob(['x'], { type: 'image/png' });
        deliver({ op: 'host', id: 7, blob });
        expect(made).toEqual([blob]);
        expect(posted.at(-1)).toEqual({ id: 7, url: 'blob:worker-1' });
        deliver({ op: 'drop', id: 7 });
        expect(revoked).toEqual(['blob:worker-1']);
        // A drop is not a collection: that waits for the page's word, once a burst has settled.
        expect(nudges.n).toBe(0);
    });

    it('collects its own garbage when the page says so', () => {
        deliver({ op: 'collect' });
        expect(nudges.n).toBe(1);
        deliver({ op: 'collect' });
        expect(nudges.n).toBe(2);
        // and answers nothing for it
        expect(posted.at(-1)).toEqual({ id: 7, url: 'blob:worker-1' });
    });
});
