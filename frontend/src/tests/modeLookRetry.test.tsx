/**
 * A mode's picture whose download fell over (components/modes/useModeLook.ts). The accent is
 * there, everyone else has the picture, and the refetch after a reconnect answers the same
 * file id, so nothing in the hook's inputs changes and nothing would ask for it again. Through
 * the real hook and the real fetchFileUrl; only the canvas half of the look stands in, which
 * jsdom does not have and e2e/modes-look-real-browser.mjs drives for real.
 *
 * Since the download's job tries a passing failure again by itself (api/authedMedia.ts; its
 * schedule in authedMediaRetry.test.ts), a reconnect while it waits cuts its wait short, and
 * the hook's own go per reconnect is for after the job gave up: 'after the job gave up' below,
 * on the fake clock the schedule needs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ServerMode } from '../api/serverModes';

const h = vi.hoisted(() => ({
    /** What mapPicture was handed, in order. */
    decodes: [] as string[],
    /** Can the picture be read? */
    readable: true,
}));

vi.mock('../api/auth', async (orig) => ({ ...(await orig<typeof import('../api/auth')>()), getToken: () => 'tok' }));
vi.mock('../api/modeLook', async (orig) => ({
    ...(await orig<typeof import('../api/modeLook')>()),
    readThemeColor: () => null,
    readPictureTheme: () => ({
        limit: { kind: 'ceiling', luminance: 0.1 },
        text: {},
        composer: '', hover: '', active: '', mention: '', mentionHover: '', halo: '',
    }),
    mapPicture: async (url: string) => {
        h.decodes.push(url);
        return h.readable ? { url: 'data:image/jpeg;base64,bWFwcGVk', plan: {}, detail: 0, keep: 1 } : null;
    },
}));

const { useModeLook } = await import('../components/modes/useModeLook');
const { clearFileCache } = await import('../api/authedMedia');

const nightMode: ServerMode = {
    id: 3,
    name: 'Game night',
    background_file_id: 'pic-1',
    accent_color: null,
    home_channel_id: null,
    auto_off: false,
    channel_ids: [],
};

function Chat({ mode }: { mode: ServerMode | null }) {
    const look = useModeLook(mode);
    return <main data-picture={look ? 'on' : 'off'} />;
}

let container: HTMLDivElement;
let root: Root;
let fetchSpy: ReturnType<typeof vi.spyOn>;

const served = () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/jpeg' } });
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 5)); });
const picture = () => container.querySelector('main')!.dataset.picture;
const reconnect = async () => {
    await act(async () => { window.dispatchEvent(new CustomEvent('wsConnected')); });
    await settle();
};

beforeEach(() => {
    h.decodes = [];
    h.readable = true;
    clearFileCache();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(() => {
    act(() => root.unmount());
    container.remove();
    fetchSpy.mockRestore();
});

const mount = async () => {
    await act(async () => { root.render(<Chat mode={nightMode} />); });
    await settle();
};

describe('a mode\'s picture on a connection that drops', () => {
    it("a download that fell over comes back at the next reconnect, without waiting out the job's backoff", async () => {
        fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
        await mount();
        expect(picture()).toBe('off');
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        await settle();
        expect(fetchSpy, "control: nothing asks again within the job's first wait (2 s)").toHaveBeenCalledTimes(1);

        fetchSpy.mockImplementation(async () => served());
        await reconnect();
        expect(fetchSpy).toHaveBeenCalledTimes(2);
        expect(picture()).toBe('on');
    });

    it('one attempt for each reconnect while the job waits, however long it stays down', async () => {
        fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
        await mount();
        await reconnect();
        expect(fetchSpy).toHaveBeenCalledTimes(2);
        await reconnect();
        expect(fetchSpy).toHaveBeenCalledTimes(3);
        expect(picture()).toBe('off');
    });

    it('a reconnect while the download is still running does not start a second one, and takes its answer', async () => {
        let answer: (r: Response) => void = () => {};
        fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>(r => { answer = r; }));
        await mount();
        await reconnect();
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        await act(async () => { answer(served()); });
        await settle();
        expect(picture()).toBe('on');
        expect(h.decodes, 'mapped once, by the attempt that is still current').toHaveLength(1);
    });

    describe('a reconnect while the download hangs, which then falls over', () => {
        /** The picture's GET stalled, and the socket's heartbeat noticing first. */
        async function hangThenReconnect() {
            let fail: (e: Error) => void = () => {};
            fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>((_, reject) => { fail = reject; }));
            await mount();
            await reconnect();
            expect(fetchSpy, 'nothing second while it runs').toHaveBeenCalledTimes(1);
            return async () => {
                await act(async () => { fail(new TypeError('Failed to fetch')); });
                await settle();
            };
        }

        it('asks once more: the reconnect\'s one go went on that download, and nothing else would ask', async () => {
            const fallsOver = await hangThenReconnect();
            fetchSpy.mockImplementation(async () => served());
            await fallsOver();
            expect(fetchSpy).toHaveBeenCalledTimes(2);
            expect(picture()).toBe('on');
        });

        it('only once, if the connection is no better, and the next reconnect has its own', async () => {
            const fallsOver = await hangThenReconnect();
            fetchSpy.mockRejectedValue(new TypeError('Failed to fetch'));
            await fallsOver();
            expect(fetchSpy).toHaveBeenCalledTimes(2);
            await settle();
            expect(fetchSpy, "control: nothing asks again within the job's wait").toHaveBeenCalledTimes(2);
            expect(picture()).toBe('off');
            await reconnect();
            expect(fetchSpy).toHaveBeenCalledTimes(3);
        });
    });

    it('a picture that is up is not fetched or mapped again', async () => {
        fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => served());
        await mount();
        expect(picture()).toBe('on');
        await reconnect();
        expect(picture()).toBe('on');
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(h.decodes).toHaveLength(1);
    });

    it('a file that downloads and cannot be read gets one try per reconnect too, with no second download', async () => {
        h.readable = false;
        fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => served());
        await mount();
        expect(picture()).toBe('off');
        expect(h.decodes).toHaveLength(1);
        await settle();
        expect(h.decodes, 'control: not over and over by itself').toHaveLength(1);
        await reconnect();
        expect(h.decodes).toHaveLength(2);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(picture()).toBe('off');
    });
});

describe('after the job gave up (on the fake clock its schedule needs)', () => {
    const tick = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setImmediate(r)); }); };
    const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); await tick(); };
    const reconnectNow = async () => { await act(async () => { window.dispatchEvent(new CustomEvent('wsConnected')); }); await tick(); };
    const mountNow = async () => { await act(async () => { root.render(<Chat mode={nightMode} />); }); await tick(); };
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        vi.spyOn(Math, 'random').mockReturnValue(0);
        vi.spyOn(console, 'info').mockImplementation(() => {});
    });
    afterEach(() => {
        clearFileCache();
        vi.useRealTimers();
        vi.mocked(Math.random).mockRestore();
        vi.mocked(console.info).mockRestore();
    });

    it('the job tries again by itself, with no reconnect', async () => {
        fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('Failed to fetch')).mockImplementation(async () => served());
        await mountNow();
        expect(picture()).toBe('off');
        await advance(2000);
        expect(fetchSpy).toHaveBeenCalledTimes(2);
        expect(picture()).toBe('on');
    });

    it('nothing asks after the give-up until the next reconnect, which asks once', async () => {
        fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
        await mountNow();
        await advance(5 * 60_000);
        expect(fetchSpy).toHaveBeenCalledTimes(6);
        await advance(10 * 60_000);
        expect(fetchSpy, 'control: nothing by itself after giving up').toHaveBeenCalledTimes(6);
        fetchSpy.mockImplementation(async () => served());
        await reconnectNow();
        expect(fetchSpy).toHaveBeenCalledTimes(7);
        expect(picture()).toBe('on');
    });

    it('a reconnect during the job is one schedule of tries, not a second one after it gives up', async () => {
        fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
        await mountNow();
        await advance(500);
        await reconnectNow();
        expect(fetchSpy, 'the reconnect cut the wait short').toHaveBeenCalledTimes(2);
        await advance(10 * 60_000);
        expect(fetchSpy).toHaveBeenCalledTimes(6);
        expect(picture()).toBe('off');
    });
});
