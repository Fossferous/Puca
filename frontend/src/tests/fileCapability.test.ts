/**
 * Per-file capabilities (migrations/054_file_capabilities.sql): an attachment
 * upload asks the server for a capability, carries it inside the encrypted
 * message beside the file key, and presents it on fetch — so the server can
 * refuse a blob to someone who merely learned its id, without ever learning
 * which channel the file belongs to. Older refs have no capability and keep
 * working; an older server returns none and the ref simply omits it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const posted = vi.hoisted(() => ({ calls: [] as Array<{ endpoint: string; options: unknown }>, reply: {} as Record<string, unknown> }));
vi.mock('../api/client', () => ({
    apiClient: {
        post: vi.fn(async (endpoint: string, _body: unknown, options?: unknown) => {
            posted.calls.push({ endpoint, options });
            return posted.reply;
        }),
    },
}));
vi.mock('../api/auth', async (orig) => ({ ...(await orig<typeof import('../api/auth')>()), getToken: () => 'tok' }));

import { uploadFile } from '../api/uploads';
import { encryptAndUploadRef, parseEncAttachment, decryptToBlobUrl } from '../api/attachments';

/** jsdom's File has no arrayBuffer(); the encrypt path reads the file through it. */
function fileOf(bytes: number[], name: string, type?: string): File {
    const u8 = new Uint8Array(bytes);
    const f = new File([u8], name, type ? { type } : undefined);
    Object.defineProperty(f, 'arrayBuffer', { value: async () => u8.buffer.slice(0) });
    return f;
}

beforeEach(() => {
    posted.calls.length = 0;
    posted.reply = { id: 'f1', original_name: 'attachment.enc', mime_type: 'application/octet-stream', size_bytes: 3, url: '/files/f1' };
});

describe('asking for a capability', () => {
    it('is a header, so an older server ignores it instead of eating it as the file', async () => {
        await uploadFile(fileOf([1], 'a.bin'), { wantCap: true });
        expect(posted.calls[0].options).toEqual({ headers: { 'X-Puca-Want-Cap': '1' } });
        await uploadFile(fileOf([1], 'a.bin'));
        expect(posted.calls[1].options).toBeUndefined();
    });

    it('an attachment upload asks, and the capability lands in the ref only when the server minted one', async () => {
        posted.reply = { ...posted.reply, cap: 'CAP_abc-123' };
        const withCap = await encryptAndUploadRef(fileOf([1, 2, 3], 'pic.png', 'image/png'));
        expect(posted.calls[0].options).toEqual({ headers: { 'X-Puca-Want-Cap': '1' } });
        expect(withCap.href).toMatch(/&c=CAP_abc-123$/);
        expect(parseEncAttachment(withCap.href)?.cap).toBe('CAP_abc-123');

        delete posted.reply.cap; // an older server
        const without = await encryptAndUploadRef(fileOf([1], 'pic.png', 'image/png'));
        expect(without.href).not.toContain('&c=');
        expect(parseEncAttachment(without.href)?.cap).toBeUndefined();
    });
});

describe('presenting a capability', () => {
    async function sealed(): Promise<{ key: string; bytes: Uint8Array }> {
        const raw = crypto.getRandomValues(new Uint8Array(32));
        const nonce = crypto.getRandomValues(new Uint8Array(12));
        const k = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
        const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, k, new TextEncoder().encode('secret bytes')));
        const b64url = Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const bytes = new Uint8Array(nonce.length + ct.length);
        bytes.set(nonce); bytes.set(ct, nonce.length);
        return { key: b64url, bytes };
    }

    it('rides in a header on fetch when the ref carries one, and is absent otherwise', async () => {
        const { key, bytes } = await sealed();
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(bytes)); // a fresh body per call
        globalThis.URL.createObjectURL = vi.fn(() => 'blob:x') as never;

        await decryptToBlobUrl('id-with-cap', key, 'image/png', 'CAP1');
        const first = fetchSpy.mock.calls[0][1] as { headers: Record<string, string> };
        expect(first.headers['X-Puca-File-Cap']).toBe('CAP1');
        expect(first.headers.Authorization).toBe('Bearer tok');
        expect(String(fetchSpy.mock.calls[0][0])).not.toContain('CAP1'); // never in the URL

        await decryptToBlobUrl('id-without-cap', key, 'image/png');
        const second = fetchSpy.mock.calls[1][1] as { headers: Record<string, string> };
        expect(second.headers['X-Puca-File-Cap']).toBeUndefined();
        fetchSpy.mockRestore();
    });
});
