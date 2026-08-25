import { describe, it, expect, vi } from 'vitest';
import { uploadParts, discardParts, ClipUploadError } from '../api/clips/clipUpload';

const part = (index: number, size = 100) => ({ index, wire: new Uint8Array(size).fill(index + 1) });
const okJson = (id: string) => ({ ok: true, status: 200, json: async () => ({ id }) }) as unknown as Response;
const httpErr = (status: number) => ({ ok: false, status, json: async () => ({}) }) as unknown as Response;
const opts = (fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) => ({ baseUrl: 'https://x', token: 'T', clipId: '9f2c1e0a-1234-4abc-8def-0123456789ab', fetchImpl, retryDelaysMs: [1, 1, 1], ...extra });

/** Read the multipart field names in order (jsdom FormData is iterable). */
function fieldOrder(init: RequestInit | undefined): string[] {
    const fd = init?.body as FormData;
    return [...fd.keys()];
}

describe('clipUpload', () => {
    it('sends kind, clip_id, part_index BEFORE the file, with the bearer token', async () => {
        const calls: { url: string; init: RequestInit | undefined }[] = [];
        const f = vi.fn(async (url: string, init?: RequestInit) => { calls.push({ url, init }); return okJson('id-' + fieldOrder(init).length); }) as unknown as typeof fetch;
        const ids = await uploadParts([part(0), part(1)], opts(f, { concurrency: 1 }));
        expect(ids.size).toBe(2);
        expect(calls[0].url).toBe('https://x/upload');
        expect(fieldOrder(calls[0].init)).toEqual(['kind', 'clip_id', 'part_index', 'file']);
        const fd = calls[0].init!.body as FormData;
        expect(fd.get('kind')).toBe('clip');
        expect(fd.get('part_index')).toBe('0');
        expect((calls[0].init!.headers as Record<string, string>).Authorization).toBe('Bearer T');
    });
    it('retries a transient failure and returns ids in order; skips parts already uploaded', async () => {
        let attempt = 0;
        const f = vi.fn(async (_url: string, init?: RequestInit) => {
            const idx = (init!.body as FormData).get('part_index');
            if (idx === '1' && attempt++ < 2) return httpErr(502);
            return okJson('id-' + idx);
        }) as unknown as typeof fetch;
        const progress: number[] = [];
        const ids = await uploadParts([part(0), part(1), part(2)], opts(f, { already: new Map([[0, 'had-0']]), onProgress: (d) => progress.push(d) }));
        expect([...ids.entries()].sort((a, b) => a[0] - b[0])).toEqual([[0, 'had-0'], [1, 'id-1'], [2, 'id-2']]);
        expect(attempt).toBe(3); // two 502s then success
        expect(progress[0]).toBe(1); // starts at the already-uploaded count
        expect(progress[progress.length - 1]).toBe(3);
        // part 0 was never re-sent
        const sentIdx = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls.map(c => (c[1].body as FormData).get('part_index'));
        expect(sentIdx).not.toContain('0');
    });
    it('does NOT retry 507/413/403 and reports what landed', async () => {
        let n507 = 0;
        const f = vi.fn(async (_url: string, init?: RequestInit) => {
            const idx = (init!.body as FormData).get('part_index');
            if (idx === '1') { n507++; return httpErr(507); }
            return okJson('id-' + idx);
        }) as unknown as typeof fetch;
        const err = await uploadParts([part(0), part(1), part(2)], opts(f, { concurrency: 1 })).catch(e => e);
        expect(err).toBeInstanceOf(ClipUploadError);
        expect((err as ClipUploadError).status).toBe(507);
        expect(n507).toBe(1);
        expect((err as ClipUploadError).uploaded.get(0)).toBe('id-0');
        expect((err as ClipUploadError).failedIdx).toContain(1);
        for (const s of [413, 403]) {
            const g = vi.fn(async () => httpErr(s)) as unknown as typeof fetch;
            const e2 = await uploadParts([part(0)], opts(g)).catch(e => e);
            expect((e2 as ClipUploadError).status).toBe(s);
            expect((g as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(1);
        }
    });
    it('a permanent network failure exhausts the retry ladder then rejects', async () => {
        const f = vi.fn(async () => { throw new TypeError('network'); }) as unknown as typeof fetch;
        const err = await uploadParts([part(0)], opts(f)).catch(e => e);
        expect(err).toBeInstanceOf(ClipUploadError);
        expect((f as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(4); // 1 + 3 retries
    });
    it('discardParts issues a DELETE per id (best effort)', () => {
        const f = vi.fn(async () => okJson('x')) as unknown as typeof fetch;
        discardParts(['a', 'b'], { baseUrl: 'https://x', token: 'T', fetchImpl: f });
        const calls = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls;
        expect(calls.map(c => c[0])).toEqual(['https://x/files/a', 'https://x/files/b']);
        expect(calls[0][1].method).toBe('DELETE');
    });
});
