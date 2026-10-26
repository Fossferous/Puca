/**
 * Work a restart would lose (api/workInFlight.ts), which a PC set up for
 * remote control waits for before it updates itself (review 2026-10-26):
 * uploads on their way to the server, and a composer holding a message that
 * has not been sent. Counted while it lasts, whichever way it ends, and
 * nothing about WHAT it is.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const post = vi.fn();
vi.mock('../api/client', () => ({ apiClient: { post: (...a: unknown[]) => post(...a), delete: async () => undefined } }));
vi.mock('../api/config', () => ({ API_BASE_URL: 'https://chat.invalid' }));
vi.mock('../api/imageMetadata', () => ({ stripFileMetadata: async (f: File) => f }));

const { trackUpload, uploadsInFlight, noteUnsent, hasUnsent } = await import('../api/workInFlight');
const { uploadFile } = await import('../api/uploads');

describe('uploads in flight', () => {
    it('counted until they settle, whether they land or fail', async () => {
        let land: () => void = () => { /* set below */ };
        let fail: (e: Error) => void = () => { /* set below */ };
        const a = trackUpload(new Promise<void>(r => { land = r; }));
        const b = trackUpload(new Promise<void>((_, rej) => { fail = rej; }));
        expect(uploadsInFlight()).toBe(2);
        land();
        await a;
        expect(uploadsInFlight()).toBe(1);
        fail(new Error('network down'));
        await expect(b).rejects.toThrow('network down');
        expect(uploadsInFlight(), 'a failed upload is not on its way any more').toBe(0);
    });

    it('every upload through uploads.ts is counted: attachments, task and note media, avatars', async () => {
        let answer: (v: unknown) => void = () => { /* set below */ };
        post.mockImplementation(() => new Promise(r => { answer = r; }));
        const p = uploadFile(new File(['x'], 'a.txt', { type: 'text/plain' }));
        expect(uploadsInFlight()).toBe(1);
        // Let the metadata step run, so the post is the one being waited on.
        await new Promise(r => setTimeout(r, 0));
        expect(post).toHaveBeenCalledTimes(1);
        expect(uploadsInFlight()).toBe(1);
        answer({ id: 'f1' });
        await p;
        expect(uploadsInFlight()).toBe(0);
    });

    it('a Clip is counted on the page, where the host update can see it (its parts upload in a worker)', () => {
        const src = readFileSync(resolve(process.cwd(), 'src/api/clips/replayBuffer.ts'), 'utf8');
        const fn = src.split('export function uploadAndBuild(')[1]?.split('\nexport ')[0] ?? '';
        expect(fn).toContain('return trackUpload(new Promise(');
    });
});

describe('a message written and not sent', () => {
    it('held per composer, let go when it is sent or cleared', () => {
        expect(hasUnsent()).toBe(false);
        noteUnsent('chat-composer', true);
        noteUnsent('chat-composer', true);
        expect(hasUnsent()).toBe(true);
        noteUnsent('another', true);
        noteUnsent('chat-composer', false);
        expect(hasUnsent(), 'another composer still holds one').toBe(true);
        noteUnsent('another', false);
        expect(hasUnsent()).toBe(false);
    });

    it('the chat composer says so: its text, or attachments waiting to go', () => {
        const chat = readFileSync(resolve(process.cwd(), 'src/components/Chat.tsx'), 'utf8');
        expect(chat).toContain("useUnsentWork('chat-composer', input.trim().length > 0 || pendingAttachments.length > 0);");
    });
});
