/**
 * InviteModal expiry (r2-6-L6-01) and attribution (r2-6-L6-02).
 *
 * Since 0.9.5 the server treats an OMITTED `expires_in_hours` as its 7-day
 * default and an explicit 0 as "never expires". The dialog therefore must
 * ALWAYS send the field, preselect 7 days, and send 0 (not omit) for Never —
 * a client that still omitted it would silently mint 7-day codes when the
 * user chose Never, and a client that sent `undefined` would be the old
 * "eternal by default" behaviour against an old backend.
 *
 * Mounted with raw react-dom/client + act (the repo's component-test pattern —
 * @testing-library/react is not a dependency here).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const get = vi.fn();
const post = vi.fn();

vi.mock('../api/client', async (importOriginal) => {
    const real = await importOriginal<typeof import('../api/client')>();
    return {
        ...real,
        apiClient: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a), delete: vi.fn() },
    };
});
vi.mock('../api/publicConfig', () => ({ fetchPublicConfig: vi.fn(async () => ({ appUrl: null })) }));

const { InviteModal } = await import('../components/InviteModal');
const { INVITE_NEVER_EXPIRES, INVITE_DEFAULT_EXPIRY_HOURS, INVITE_EXPIRY_CHOICES } = await import('../api/servers');

const settle = async () => { await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };

function invite(over: Record<string, unknown> = {}) {
    return {
        code: 'AbCdEfGh', server_id: 's1', server_name: 'S', uses: 0, max_uses: null,
        expires_at: null, created_at: '2026-09-06T00:00:00Z', ...over,
    };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
    get.mockReset();
    post.mockReset();
    // The dialog copies a fresh code to the clipboard; jsdom has neither
    // navigator.clipboard nor document.execCommand, and the fallback path
    // would reject an un-awaited promise and fail the test for the wrong reason.
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => {}) }, configurable: true });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
});

async function mount(list: unknown[] = []) {
    get.mockResolvedValueOnce(list);
    await act(async () => {
        root.render(<InviteModal isOpen onClose={() => {}} serverId="s1" serverName="S" />);
    });
    await settle();
}

const select = () => container.querySelector<HTMLSelectElement>('#invite-expiry')!;
const generate = () => Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(b => b.textContent === 'Generate Invite Link')!;

async function choose(hours: number) {
    await act(async () => {
        const el = select();
        el.value = String(hours);
        el.dispatchEvent(new Event('change', { bubbles: true }));
    });
}
async function clickGenerate() {
    post.mockResolvedValueOnce(invite({ expires_at: '2026-09-13T00:00:00Z' }));
    await act(async () => { generate().click(); });
    await settle();
}

describe('InviteModal expiry', () => {
    it('preselects the 7-day default and offers exactly the shared choices, Never last', async () => {
        await mount();
        expect(Number(select().value)).toBe(INVITE_DEFAULT_EXPIRY_HOURS);
        expect(INVITE_DEFAULT_EXPIRY_HOURS).toBe(168);
        const options = Array.from(select().options).map(o => Number(o.value));
        expect(options).toEqual(INVITE_EXPIRY_CHOICES.map(c => c.hours));
        expect(options.at(-1)).toBe(INVITE_NEVER_EXPIRES);
        expect(options).toContain(720); // 30 days
        expect(options).toContain(24);  // 1 day
    });

    it('sends the 7-day default explicitly when nothing is changed', async () => {
        await mount();
        await clickGenerate();
        expect(post).toHaveBeenCalledTimes(1);
        const [path, body] = post.mock.calls[0] as [string, { expires_in_hours?: number; max_uses?: number }];
        expect(path).toBe('/servers/s1/invites');
        expect(body.expires_in_hours).toBe(168);
        expect('expires_in_hours' in body).toBe(true);
    });

    it('sends an explicit 0 for Never — never omits the field', async () => {
        await mount();
        await choose(INVITE_NEVER_EXPIRES);
        await clickGenerate();
        const [, body] = post.mock.calls[0] as [string, { expires_in_hours?: number }];
        expect(body.expires_in_hours).toBe(0);
        expect(Object.prototype.hasOwnProperty.call(body, 'expires_in_hours')).toBe(true);
    });

    it('positive control: a chosen lifetime is what gets sent', async () => {
        await mount();
        await choose(720);
        await clickGenerate();
        const [, body] = post.mock.calls[0] as [string, { expires_in_hours?: number }];
        expect(body.expires_in_hours).toBe(720);
    });
});

describe('InviteModal attribution', () => {
    it('shows who minted each listed code when the backend says', async () => {
        await mount([invite({ creator_id: 42, creator_username: 'mallory' })]);
        const creator = container.querySelector('.invite-creator');
        expect(creator?.textContent).toBe('by mallory');
    });

    it('positive control: an older backend with no creator renders the row without one', async () => {
        await mount([invite()]);
        expect(container.querySelector('.invite-item')).not.toBeNull();
        expect(container.querySelector('.invite-creator')).toBeNull();
    });
});
