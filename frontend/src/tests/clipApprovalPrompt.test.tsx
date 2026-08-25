/**
 * ClipApprovalPrompt (docs/CLIPS.md §2.10) — the approver's dialog.
 *
 * Driven through the REAL protocol module (api/clips/clipProposals.ts) with the
 * wire mocked, so what is asserted is what a real doorbell produces:
 *  - nothing renders with no request (positive control for every "renders" case);
 *  - Decline owns focus, Escape declines, Approve/Decline POST the vote;
 *  - EXPIRY SENDS NOTHING — the dialog turns into "expired" + Close;
 *  - a resolution while open disables the buttons briefly, then shows Close;
 *  - the "It includes …" clause follows the server's flags;
 *  - unmounting votes nothing;
 *  - the queue chip counts, and the second request's buttons are held off.
 *
 * Mounted with raw react-dom/client + act (the repo's component-test pattern —
 * @testing-library/react is not a dependency here).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

type Handler = (msg: { type: string; payload: unknown }) => void;
const handlers = new Map<string, Handler[]>();
const get = vi.fn();
const post = vi.fn();

vi.mock('../api/client', async (importOriginal) => {
    const real = await importOriginal<typeof import('../api/client')>();
    return { ...real, apiClient: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a), delete: vi.fn() } };
});
vi.mock('../api/websocket', () => ({
    wsClient: { on: (type: string, h: Handler) => { handlers.set(type, [...(handlers.get(type) ?? []), h]); }, off: () => {} },
}));
vi.mock('../api/platform', async (importOriginal) => ({ ...(await importOriginal<typeof import('../api/platform')>()), isTauri: () => false, isAndroidApp: () => false, appIsForeground: () => true }));
vi.mock('../api/mobileApp', () => ({ postMobileNotification: vi.fn(async () => {}) }));

const mod = await import('../api/clips/clipProposals');
const { ClipApprovalPrompt } = await import('../components/ClipApprovalPrompt');

const fire = (type: string, payload: unknown) => { for (const h of handlers.get(type) ?? []) h({ type, payload }); };
const settle = async () => { await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };
const tick = async (ms: number) => { await act(async () => { await new Promise(r => setTimeout(r, ms)); }); };

function view(over: Record<string, unknown> = {}) {
    return {
        clip_id: 'c1', proposer: { id: 7, username: 'ann' }, server_id: 's', voice_channel_id: 5, voice_channel_name: 'General Voice',
        target_channel_id: 9, target_channel_name: 'clips', duration_ms: 64_000, ended_ago_ms: 120_000, expires_in_ms: 1_800_000,
        approver_count: 3, approved_count: 0, solo: false, resolved: false, approved: false,
        my_vote: 'pending', you: { had_camera: false, had_share: false, still_in_call: true },
        ...over,
    };
}
async function ring(v: ReturnType<typeof view>) {
    get.mockResolvedValueOnce(v);
    await act(async () => { fire('ClipProposed', { clip_id: v.clip_id, expires_in_ms: v.expires_in_ms }); });
    await settle();
}
const dialog = () => document.body.querySelector<HTMLElement>('.clip-approval');
const btn = (label: string) => Array.from(document.body.querySelectorAll<HTMLButtonElement>('.clip-approval button')).find(b => b.textContent === label) ?? null;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
    handlers.clear();
    get.mockReset(); post.mockReset();
    mod.__resetClipProposalsForTests();
    mod.wireClipProposals();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
});

describe('ClipApprovalPrompt', () => {
    it('renders nothing when there is no request (positive control), and a full dialog once a doorbell hydrates', async () => {
        await act(async () => root.render(<ClipApprovalPrompt />));
        expect(dialog()).toBeNull();
        await ring(view());
        const d = dialog();
        expect(d).not.toBeNull();
        expect(d!.textContent).toContain('ann wants to post a clip of this call');
        expect(d!.textContent).toContain('1:04');
        expect(d!.textContent).toContain('#General Voice');
        expect(d!.textContent).toContain('#clips');
        expect(d!.textContent).toContain('It includes your voice — and anything else');
        expect(d!.textContent).toContain('Nothing has been uploaded');
        expect(d!.textContent).toContain('Your answer is final');
        expect(d!.textContent).toMatch(/Expires in 3[01] min/);
        expect(d!.querySelector('.clip-approval-queue')).toBeNull(); // one request: no chip
    });

    it('Decline has focus; Escape declines (POST approve:false); the prompt goes away', async () => {
        await act(async () => root.render(<ClipApprovalPrompt />));
        await ring(view());
        await tick(500); // past the 400 ms hold-off (+ the focus tick)
        expect(document.activeElement).toBe(btn('Decline'));
        post.mockResolvedValueOnce({ clip_id: 'c1', state: 'declined', approved_count: 0, total: 3 });
        await act(async () => { dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
        await settle();
        expect(post).toHaveBeenCalledWith('/clips/c1/vote', { approve: false });
        expect(dialog()).toBeNull();
    });

    it('Approve POSTs approve:true and the prompt moves on', async () => {
        await act(async () => root.render(<ClipApprovalPrompt />));
        await ring(view());
        await tick(450);
        post.mockResolvedValueOnce({ clip_id: 'c1', state: 'pending', approved_count: 1, total: 3 });
        await act(async () => { btn('Approve')!.click(); });
        await settle();
        expect(post).toHaveBeenCalledWith('/clips/c1/vote', { approve: true });
        expect(dialog()).toBeNull();
    });

    it('buttons are dead during the 400 ms hold-off (a double-tap for the previous dialog cannot answer this one)', async () => {
        await act(async () => root.render(<ClipApprovalPrompt />));
        await ring(view());
        expect(btn('Approve')!.disabled).toBe(true);
        expect(btn('Decline')!.disabled).toBe(true);
        await act(async () => { btn('Approve')!.click(); });
        expect(post).not.toHaveBeenCalled();
        await tick(450);
        expect(btn('Approve')!.disabled).toBe(false);
    });

    it('EXPIRY sends nothing: the dialog says expired and offers Close', async () => {
        await act(async () => root.render(<ClipApprovalPrompt />));
        await ring(view({ expires_in_ms: 300 }));
        await tick(450);
        // The protocol module's 5 s tick marks a past-deadline request 'expired'
        // and re-fetches /clips/pending; a REAL server no longer lists it — the
        // terminal card must survive that reconcile until Close (review #5).
        get.mockResolvedValue({ proposals: [] });
        await tick(5_200);
        const d = dialog();
        expect(d).not.toBeNull();
        expect(d!.textContent).toContain('This request expired');
        expect(btn('Approve')).toBeNull();
        expect(post).not.toHaveBeenCalled();
        await tick(700); // the 600 ms resolve-lock
        await act(async () => { btn('Close')!.click(); });
        expect(dialog()).toBeNull();
    }, 20_000);

    it('a resolution while open locks the buttons, then shows the terminal copy + Close; nothing is voted', async () => {
        await act(async () => root.render(<ClipApprovalPrompt />));
        await ring(view());
        await tick(450);
        await act(async () => { fire('ClipResolved', { clip_id: 'c1', outcome: 'closed' }); });
        expect(dialog()!.textContent).toContain('This request was closed');
        expect(btn('Close')!.disabled).toBe(true);
        await tick(650);
        expect(btn('Close')!.disabled).toBe(false);
        expect(post).not.toHaveBeenCalled();
        await act(async () => { btn('Close')!.click(); });
        expect(dialog()).toBeNull();
    });

    it('camera / share clauses render per the SERVER flags, and "you were in that call" when no longer in it', async () => {
        await act(async () => root.render(<ClipApprovalPrompt />));
        await ring(view({ you: { had_camera: true, had_share: true, still_in_call: false } }));
        const t = dialog()!.textContent ?? '';
        expect(t).toContain('It includes your voice, your camera, and the screen you were sharing');
        expect(t).toContain('You were in that call at the time.');
    });

    it('two requests: the OLDER shows first with a "1 of 2" chip; answering it slides the next in, held off again', async () => {
        await act(async () => root.render(<ClipApprovalPrompt />));
        await ring(view({ clip_id: 'first' }));
        await ring(view({ clip_id: 'second', proposer: { id: 8, username: 'bob' } }));
        expect(dialog()!.dataset.clipId).toBe('first');
        expect(dialog()!.querySelector('.clip-approval-queue')!.textContent).toBe('1 of 2 requests');
        await tick(450);
        post.mockResolvedValueOnce({ clip_id: 'first', state: 'declined', approved_count: 0, total: 3 });
        await act(async () => { btn('Decline')!.click(); });
        await settle();
        expect(dialog()!.dataset.clipId).toBe('second');
        expect(dialog()!.textContent).toContain('bob wants to post');
        expect(btn('Approve')!.disabled).toBe(true); // held off again
        await tick(450);
        expect(btn('Approve')!.disabled).toBe(false);
    });

    it('unmounting mid-request votes nothing', async () => {
        await act(async () => root.render(<ClipApprovalPrompt />));
        await ring(view());
        await tick(450);
        await act(async () => root.unmount());
        root = createRoot(container); // afterEach unmounts again; keep it valid
        expect(post).not.toHaveBeenCalled();
    });
});

describe('an APPROVED resolution auto-closes; other outcomes still need a click', () => {
    it('auto-dismisses ~1.4s after "Approved — it will be posted." — no click required', async () => {
        await act(async () => root.render(<ClipApprovalPrompt />));
        await ring(view());
        await tick(450);
        // Simulates the real race: the WS ClipResolved broadcast can land before
        // this approver's own vote POST response — the entry is still
        // myVote:'pending' locally when resolution arrives, so it stays on screen.
        await act(async () => { fire('ClipResolved', { clip_id: 'c1', outcome: 'approved' }); });
        expect(dialog()!.textContent).toContain('Approved — it will be posted.');
        expect(post).not.toHaveBeenCalled();
        await tick(1500);
        expect(dialog()).toBeNull();
    });

    it('a DECLINED/closed resolution does NOT auto-close — Close still requires a click', async () => {
        await act(async () => root.render(<ClipApprovalPrompt />));
        await ring(view());
        await tick(450);
        await act(async () => { fire('ClipResolved', { clip_id: 'c1', outcome: 'closed' }); });
        expect(dialog()!.textContent).toContain('This request was closed');
        await tick(1500);
        expect(dialog()).not.toBeNull(); // still there — no auto-close for a non-approval outcome
        await act(async () => { btn('Close')!.click(); });
        expect(dialog()).toBeNull();
    });

    it('clicking Close manually before the auto-close timer fires does not double-dismiss or error', async () => {
        await act(async () => root.render(<ClipApprovalPrompt />));
        await ring(view());
        await tick(450);
        await act(async () => { fire('ClipResolved', { clip_id: 'c1', outcome: 'approved' }); });
        await tick(650); // past the resolve-lock so Close is enabled
        await act(async () => { btn('Close')!.click(); });
        expect(dialog()).toBeNull();
        // The auto-close timer for this (now-dismissed) id must not throw or resurrect anything.
        await tick(1500);
        expect(dialog()).toBeNull();
    });
});
