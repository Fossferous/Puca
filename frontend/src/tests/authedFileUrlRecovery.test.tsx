/**
 * A picture whose fetch failed once is not initials for the rest of the
 * session (field report 2026-11-19; api/authedMedia.ts's header). Through the
 * REAL SmartAvatar, useAuthedFileUrl and authedMedia, with only fetch, the
 * token and the speaking/hidden stores standing in:
 *   - a 503 then a 200 shows the picture with no new file id and no remount
 *     (the member-list row, keyed by member id, stays mounted);
 *   - after the job has given up, `online`, the page shown again or the socket
 *     connecting again asks once more, once per event and one request per id
 *     however many avatars show it, and an avatar that resolved is not asked
 *     for again;
 *   - another component loading the same file brings it to the one showing
 *     initials, with no request of its own;
 *   - a definite refusal and a signed-out viewer ask nothing on those events;
 *   - unmounted, nothing retries, and every listener it led to is gone.
 * The job's own schedule: authedMediaRetry.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const h = vi.hoisted(() => ({ token: 'tok' as string | null }));
vi.mock('../api/auth', async (orig) => ({ ...(await orig<typeof import('../api/auth')>()), getToken: () => h.token }));
vi.mock('../components/voiceState', () => ({ isUserSpeaking: () => false, useUserSpeaking: () => false }));
vi.mock('../components/avatarPrefs', () => ({ isAvatarHidden: () => false }));

import { SmartAvatar } from '../components/SmartAvatar';
import { AuthedImg } from '../components/AuthedImg';
import { clearFileCache } from '../api/authedMedia';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
/** An answer: a 200 PNG, a thrown fetch, a status, or a status with Retry-After. */
type Spec = 'ok' | 'net' | number | [number, string];
/** Per file id: the answers to give, in order; the last one repeats. */
let answers: Record<string, Spec[]> = {};
let calls: string[] = [];
let container: HTMLDivElement;
let root: Root;
/** Each test starts after the previous one ended (a per-minute line limit). */
let clock = new Date('2026-11-20T12:00:00Z').getTime();

function respond(spec: Spec): Response {
    if (spec === 'net') throw new TypeError('Failed to fetch');
    if (spec === 'ok') return new Response(PNG.slice(), { headers: { 'Content-Type': 'image/png' } });
    const [code, retryAfter] = typeof spec === 'number' ? [spec, undefined] : spec;
    return new Response('nope', { status: code, headers: retryAfter ? { 'Retry-After': retryAfter } : {} });
}
const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setImmediate(r)); }); };
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); await settle(); };
const requests = (id: string) => calls.filter((u) => u.endsWith(`/files/${id}`)).length;
const fire = async (target: EventTarget, e: Event) => { await act(async () => { target.dispatchEvent(e); }); await settle(); };
/** A server down for the job's whole schedule (2+4+8+16+30 s, six tries). */
const giveUp = () => advance(5 * 60_000);

function Avatar({ id, fileId }: { id: number; fileId: string | null }) {
    return <span data-row={id}><SmartAvatar userId={id} fileId={fileId} className="av" fallback={<span className="initials">MI</span>} /></span>;
}
const row = (id: number) => container.querySelector(`[data-row="${id}"]`)!;
const showsPicture = (id: number) => row(id).querySelector('img')?.getAttribute('src')?.startsWith('data:image/png;base64,') === true;
const showsInitials = (id: number) => row(id).querySelector('.initials') !== null && row(id).querySelector('img') === null;

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(clock);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.spyOn(console, 'info').mockImplementation(() => {});
    h.token = 'tok';
    answers = {};
    calls = [];
    clearFileCache();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = String(input);
        calls.push(url);
        const list = answers[url.split('/files/')[1]] ?? ['ok'];
        return respond(list.length > 1 ? list.shift()! : list[0]);
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    clearFileCache();
    clock = Date.now() + 120_000;
    vi.useRealTimers();
    vi.restoreAllMocks();
});

const mount = async (ui: React.ReactNode) => {
    await act(async () => { root.render(ui); });
    await settle();
};

describe('a picture that failed once', () => {
    it('a 503 (Retry-After: 2) and then a 200 shows the picture in the same mounted row', async () => {
        answers.owner = [[503, '2'], 'ok'];
        await mount(<Avatar id={1} fileId="owner" />);
        expect(showsInitials(1)).toBe(true);
        expect(requests('owner')).toBe(1);
        await advance(2000);
        expect(requests('owner')).toBe(2);
        expect(showsPicture(1)).toBe(true);
    });

    it('a network error, then the server coming back, through AuthedImg (emoji, server icons) too', async () => {
        answers.icon = ['net', 'ok'];
        await mount(<span data-row={9}><AuthedImg fileId="icon" alt="" /></span>);
        expect(row(9).querySelector('img')).toBeNull();
        await advance(2000);
        expect(row(9).querySelector('img')?.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
    });
});

describe('after the job gave up', () => {
    it.each([
        ['online', () => fire(window, new Event('online'))],
        ['the socket connecting again', () => fire(window, new CustomEvent('wsConnected'))],
        ['the page shown again', async () => {
            Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
            try { await fire(document, new Event('visibilitychange')); } finally { delete (document as { visibilityState?: unknown }).visibilityState; }
        }],
    ])('%s asks again, and the picture shows', async (_name, chance) => {
        answers.owner = [503];
        await mount(<Avatar id={1} fileId="owner" />);
        await giveUp();
        expect(requests('owner')).toBe(6);
        expect(showsInitials(1)).toBe(true);
        await advance(10 * 60_000);
        expect(requests('owner'), 'control: nothing asks by itself after giving up').toBe(6);
        answers.owner = ['ok'];
        await chance();
        expect(requests('owner')).toBe(7);
        expect(showsPicture(1)).toBe(true);
    });

    it('a page going hidden asks nothing', async () => {
        answers.owner = [503];
        await mount(<Avatar id={1} fileId="owner" />);
        await giveUp();
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        try { await fire(document, new Event('visibilitychange')); } finally { delete (document as { visibilityState?: unknown }).visibilityState; }
        expect(requests('owner')).toBe(6);
    });

    it('once per event, and ONE request per id however many avatars show it', async () => {
        answers.owner = [503];
        await mount(<>{[1, 2, 3].map((i) => <Avatar key={i} id={i} fileId="owner" />)}</>);
        await giveUp();
        expect(requests('owner'), 'three avatars, one job').toBe(6);
        answers.owner = [503];
        await fire(window, new Event('online'));
        expect(requests('owner')).toBe(7);
        await advance(1000);
        expect(requests('owner'), 'that event asked once; the new job has its own schedule').toBe(7);
        await giveUp();
        expect(requests('owner')).toBe(12);
        answers.owner = ['ok'];
        await fire(window, new Event('online'));
        expect(requests('owner')).toBe(13);
        expect([1, 2, 3].every(showsPicture)).toBe(true);
    });

    it('an avatar that resolved is not asked for again', async () => {
        answers.down = [503];
        await mount(<><Avatar id={1} fileId="up" /><Avatar id={2} fileId="down" /></>);
        await giveUp();
        expect(showsPicture(1)).toBe(true);
        expect(requests('up')).toBe(1);
        answers.down = ['ok'];
        await fire(window, new Event('online'));
        await fire(window, new CustomEvent('wsConnected'));
        expect(requests('up')).toBe(1);
        expect(requests('down')).toBe(7);
        expect(showsPicture(2)).toBe(true);
    });

    it('another component loading the same file brings it to the row showing initials, with no request of its own', async () => {
        answers.owner = [503];
        await mount(<Avatar id={1} fileId="owner" />);
        await giveUp();
        answers.owner = ['ok'];
        // The DM view opening: a second avatar of the same person mounts.
        await mount(<><Avatar id={1} fileId="owner" /><Avatar id={2} fileId="owner" /></>);
        expect(requests('owner')).toBe(7);
        expect(showsPicture(2)).toBe(true);
        expect(showsPicture(1)).toBe(true);
    });

    it('a definite refusal asks nothing on those events', async () => {
        answers.gone = [404];
        await mount(<Avatar id={1} fileId="gone" />);
        expect(requests('gone')).toBe(1);
        await fire(window, new Event('online'));
        await fire(window, new CustomEvent('wsConnected'));
        expect(requests('gone')).toBe(1);
        expect(showsInitials(1)).toBe(true);
    });

    it('a signed-out viewer makes no request at all', async () => {
        h.token = null;
        await mount(<Avatar id={1} fileId="owner" />);
        await fire(window, new Event('online'));
        await advance(60_000);
        expect(calls).toEqual([]);
        expect(showsInitials(1)).toBe(true);
    });
});

describe('unmounted', () => {
    it('during the wait: nothing retries', async () => {
        answers.owner = [503];
        await mount(<Avatar id={1} fileId="owner" />);
        expect(requests('owner')).toBe(1);
        await mount(<></>);
        await advance(5 * 60_000);
        await fire(window, new Event('online'));
        expect(requests('owner')).toBe(1);
    });

    it('after giving up: the events ask nothing', async () => {
        answers.owner = [503];
        await mount(<Avatar id={1} fileId="owner" />);
        await giveUp();
        await mount(<></>);
        await fire(window, new Event('online'));
        await fire(window, new CustomEvent('wsConnected'));
        expect(requests('owner')).toBe(6);
    });

    it('a row replaced by another for the same file in one commit keeps the one job', async () => {
        answers.owner = [[503, '2'], 'ok'];
        await mount(<Avatar key="a" id={1} fileId="owner" />);
        await mount(<Avatar key="b" id={1} fileId="owner" />);
        expect(requests('owner'), 'the new row joined the waiting job rather than start its own').toBe(1);
        await advance(2000);
        expect(requests('owner')).toBe(2);
        expect(showsPicture(1)).toBe(true);
    });

    it('removes every listener it led to', async () => {
        const live = new Map<string, number>();
        const watched = new Set(['online', 'wsConnected', 'visibilitychange']);
        for (const target of [window, document] as EventTarget[]) {
            const add = target.addEventListener.bind(target);
            const remove = target.removeEventListener.bind(target);
            vi.spyOn(target, 'addEventListener').mockImplementation((type, fn, o) => {
                if (watched.has(type)) live.set(type, (live.get(type) ?? 0) + 1);
                add(type, fn, o);
            });
            vi.spyOn(target, 'removeEventListener').mockImplementation((type, fn, o) => {
                if (watched.has(type)) live.set(type, (live.get(type) ?? 0) - 1);
                remove(type, fn, o);
            });
        }
        answers.owner = [503];
        answers.other = [503];
        await mount(<>{[1, 2, 3].map((i) => <Avatar key={i} id={i} fileId={i === 3 ? 'other' : 'owner'} />)}</>);
        expect([...live.values()].some((n) => n > 0), 'listening while the jobs run').toBe(true);
        await giveUp();
        expect([...live.values()].every((n) => n === 1), 'one listener per event however many avatars wait for a chance').toBe(true);
        await fire(window, new Event('online'));
        await giveUp();
        await mount(<></>);
        expect(Object.fromEntries(live)).toEqual({ online: 0, wsConnected: 0, visibilitychange: 0 });
    });
});
