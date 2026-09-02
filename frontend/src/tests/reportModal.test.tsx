/**
 * ReportModal: the client half of POST /servers/:id/reports, which had no
 * caller anywhere before 0.9.2 (the moderation queue could only ever be
 * empty). Asserts the wire body matches the server's allow-list and bound,
 * and that the throttle (429) is explained rather than swallowed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ApiError } from '../api/client';

const wire = vi.hoisted(() => ({
    posts: [] as Array<{ url: string; body: Record<string, unknown> }>,
    fail: null as null | ApiError,
}));
vi.mock('../api/client', async (orig) => {
    const real = await orig<typeof import('../api/client')>();
    return {
        ...real,
        apiClient: {
            post: vi.fn(async (url: string, body: Record<string, unknown>) => {
                if (wire.fail) throw wire.fail;
                wire.posts.push({ url, body });
                return { id: 1 };
            }),
            get: vi.fn(), delete: vi.fn(), patch: vi.fn(),
        },
    };
});

const { ReportModal } = await import('../components/ReportModal');
const { REPORT_REASON_MAX } = await import('../api/servers');

let container: HTMLDivElement;
let root: Root;
const onClose = vi.fn();
const settle = async () => { await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };
const btn = (label: string) => Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(b => b.textContent === label)!;
const typeReason = async (text: string) => {
    const ta = container.querySelector<HTMLTextAreaElement>('#report-reason')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(ta, text); ta.dispatchEvent(new Event('input', { bubbles: true })); });
};

beforeEach(async () => {
    wire.posts.length = 0;
    wire.fail = null;
    onClose.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
        root.render(<ReportModal target={{ serverId: 'srv-1', userId: 7, username: 'ann', messageId: 'm-42' }} onClose={onClose} />);
    });
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe('ReportModal', () => {
    it('posts a server-valid report_type, the reason, and both targets', async () => {
        expect(btn('Send report').disabled).toBe(true);                 // empty reason: nothing to send
        await act(async () => { container.querySelector<HTMLInputElement>('input[value="spam"]')!.click(); });
        await typeReason('  posted the same link nine times  ');
        expect(btn('Send report').disabled).toBe(false);
        await act(async () => { btn('Send report').click(); });
        await settle();
        expect(wire.posts).toEqual([{
            url: '/servers/srv-1/reports',
            body: { report_type: 'spam', reason: 'posted the same link nine times', reported_user_id: 7, reported_message_id: 'm-42' },
        }]);
        expect(container.textContent).toMatch(/Sent to this server's moderators/);
        expect(container.textContent).toMatch(/is not told/);
    });

    it('bounds the reason where the server does', async () => {
        const ta = container.querySelector<HTMLTextAreaElement>('#report-reason')!;
        expect(ta.maxLength).toBe(REPORT_REASON_MAX);
        expect(REPORT_REASON_MAX).toBe(1000);
    });

    it('a 429 from the throttle is explained, not a generic failure', async () => {
        wire.fail = new ApiError('Too many reports; please try again later', 429);
        await typeReason('spam');
        await act(async () => { btn('Send report').click(); });
        await settle();
        expect(container.querySelector('.report-error')?.textContent).toMatch(/reported a lot recently/);
        expect(wire.posts).toEqual([]);
    });

    it('a 403 says only members can report', async () => {
        wire.fail = new ApiError('Not a member of this server', 403);
        await typeReason('spam');
        await act(async () => { btn('Send report').click(); });
        await settle();
        expect(container.querySelector('.report-error')?.textContent).toMatch(/Only members/);
    });

    it('Escape closes', async () => {
        await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
        expect(onClose).toHaveBeenCalled();
    });
});
