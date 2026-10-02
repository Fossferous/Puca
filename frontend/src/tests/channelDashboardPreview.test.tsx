/**
 * The collection-channel feed (ChannelDashboard) printed each message's full
 * decrypted text in `.feed-content` — for an attachment that is the raw
 * `![name](sovereign-enc:<id>?k=<file key>&c=<capability>…)`, key on screen,
 * no length cap. It must show the same compact label every other preview does.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const KEY = 'y8PY2ErUIKyijmVzroOm6CWv9rqH0iHqDybKo1r3Gi8';
const CAP = 'CaPaBiLiTyToKeN42';
const IMG = `![photo.png](sovereign-enc:746bbec3?k=${KEY}&m=image%2Fpng&c=${CAP})`;

vi.mock('../api/servers', async importOriginal => ({
    ...(await importOriginal<typeof import('../api/servers')>()),
    getChannelFeed: async () => ({
        children: [{
            id: 2, name: 'photos',
            messages: [
                { id: 'm1', channel_id: 2, user_id: 1, username: 'ann', display_name: null, content: 'ENV1', created_at: '2026-10-01T10:00:00Z' },
                { id: 'm2', channel_id: 2, user_id: 1, username: 'ann', display_name: null, content: 'ENV2', created_at: '2026-10-01T10:01:00Z' },
            ],
        }],
    }),
    // The feed serves envelopes; "decrypting" them yields the message text.
    decryptChannelContent: async (_ch: number, content: string) =>
        content === 'ENV1' ? `look at this ${IMG}` : 'plain words only',
}));

const { ChannelDashboard } = await import('../components/ChannelDashboard');

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null; host = null;
});

describe('ChannelDashboard feed', () => {
    it('shows an attachment as its name, never the ref or its key', async () => {
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        const channel = { id: 1, name: 'col', channel_type: 2 } as unknown as Parameters<typeof ChannelDashboard>[0]['channel'];
        await act(async () => {
            root!.render(<QueryClientProvider client={qc}><ChannelDashboard channel={channel} /></QueryClientProvider>);
        });
        await act(async () => { await new Promise(r => setTimeout(r, 30)); });
        const rows = Array.from(host.querySelectorAll('.feed-content')).map(e => e.textContent ?? '');
        expect(rows).toHaveLength(2);
        // Positive control: the plain row really rendered decrypted text.
        expect(rows[1]).toBe('plain words only');
        expect(rows[0]).toContain('look at this');
        expect(rows[0]).toContain('photo.png');
        expect(rows[0]).not.toMatch(/sovereign-enc/i);
        expect(rows[0]).not.toContain(KEY.slice(0, 10));
        expect(rows[0]).not.toContain(CAP);
    });
});
