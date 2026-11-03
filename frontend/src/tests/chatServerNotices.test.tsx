/**
 * What the chat view says when nobody just pressed anything. A native alert()
 * takes the focus and stops the page's JavaScript until it is answered, which is
 * no way to reach someone in a call or a game, and a toast expires behind whatever
 * they went to. So these two are notices that wait: a generic `Error` frame off the
 * socket (the server sends one in answer to ANY frame the client sent, background
 * ones included), and the send that gives up ten seconds after the person pressed
 * Enter, which also gives them back what they wrote. Through the real Chat, with
 * the same stand-ins as chatHeicComposer.test.tsx.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { mountAppDialogs } from './appDialogsHost';

const ME = 1;

const h = vi.hoisted(() => ({
    send: null as null | (() => Promise<unknown>),
    pin: null as null | (() => Promise<unknown>),
    dms: [] as unknown[],
    discarded: [] as string[],
    /** Whose session is in storage now. */
    sessionOf: 1 as number | null,
    /** Sealing a DM, when a test holds it. */
    seal: null as null | (() => Promise<string>),
}));

vi.mock('../api/servers', async importOriginal => ({
    ...(await importOriginal<typeof import('../api/servers')>()),
    markChannelRead: async () => {},
    getMessages: async () => [],
    decryptChannelMessages: async (_ch: number, raw: unknown[]) => raw,
    listPinnedMessages: async () => [],
    sendChannelMessageEncrypted: () => h.send!(),
    pinMessage: () => h.pin!(),
}));
vi.mock('../api/dms', async importOriginal => ({
    ...(await importOriginal<typeof import('../api/dms')>()),
    encryptDMContent: async () => (h.seal ? h.seal() : 'sealed'),
}));
vi.mock('../api/attachments', async importOriginal => ({
    ...(await importOriginal<typeof import('../api/attachments')>()),
    encryptAndUploadRef: async (file: File) => ({ name: file.name, href: `sovereign-enc:up-${file.name}?k=key&m=text/plain` }),
}));
vi.mock('../api/uploads', async importOriginal => ({
    ...(await importOriginal<typeof import('../api/uploads')>()),
    discardUpload: (id: string) => { h.discarded.push(id); },
}));
vi.mock('../api/auth', async importOriginal => ({
    ...(await importOriginal<typeof import('../api/auth')>()),
    getToken: () => `h.${btoa(JSON.stringify({ sub: ME, username: 'me' })).replace(/=+$/, '')}.s`,
    currentUserIdFromToken: () => h.sessionOf,
}));
vi.mock('../utils/audioFeedback', async importOriginal => ({
    ...(await importOriginal<typeof import('../utils/audioFeedback')>()),
    playMessageSound: () => {},
    playMentionSound: () => {},
}));

Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
});
if (!Element.prototype.scrollTo) Element.prototype.scrollTo = function scrollTo() {};
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = function scrollIntoView() {};
class NoObserver { observe() {} unobserve() {} disconnect() {} }
vi.stubGlobal('ResizeObserver', NoObserver);
vi.stubGlobal('IntersectionObserver', NoObserver);

const reply = (status: number, body: unknown) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return { ok: status < 400, status, json: async () => JSON.parse(text), text: async () => text, headers: new Headers() } as unknown as Response;
};
vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    if (/\/config$/.test(u)) return reply(200, { app_url: 'https://app.example.com', registration_invite_required: false, srp_version: 2 });
    if (/\/servers$/.test(u)) return reply(200, [{ id: 's1', name: 'Srv', owner_id: ME, created_at: '2026-10-01T00:00:00Z' }]);
    if (/\/servers\/s1\/channels$/.test(u)) return reply(200, [
        { id: 10, name: 'general', channel_type: 0, server_id: 's1', my_permissions: 0x7fffffff },
        { id: 11, name: 'random', channel_type: 0, server_id: 's1', my_permissions: 0x7fffffff },
    ]);
    if (/\/servers\/[^/]+\/unread$/.test(u)) return reply(200, { channels: [] });
    if (/\/dms$/.test(u)) return reply(200, h.dms);
    return reply(200, /ice|features|version|keys|me$|settings|unread/.test(u) ? {} : []);
}));

const { Chat } = await import('../components/Chat');
const { wsClient } = await import('../api/websocket');

type Frame = { type: string; payload: unknown };

let root: Root | null = null;
let host: HTMLElement | null = null;
let alertSpy: ReturnType<typeof vi.spyOn>;
let confirmSpy: ReturnType<typeof vi.spyOn>;
let frameListeners: ((m: Frame) => void)[] = [];
let dmListeners: ((m: Frame) => void)[] = [];
let dialogs: ReturnType<typeof mountAppDialogs>;

beforeEach(() => {
    dialogs = mountAppDialogs();
    alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const on = wsClient.on.bind(wsClient);
    vi.spyOn(wsClient, 'on').mockImplementation((type, handler) => {
        if (type === 'Error') frameListeners.push(handler as unknown as (m: Frame) => void);
        if (type === 'DirectMessage') dmListeners.push(handler as unknown as (m: Frame) => void);
        return on(type, handler);
    });
});
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null; host = null;
    h.send = null;
    h.pin = null;
    h.dms = [];
    h.discarded = [];
    h.sessionOf = ME;
    h.seal = null;
    frameListeners = [];
    dmListeners = [];
    dialogs.unmount();
    vi.restoreAllMocks();
});

const settle = (ms = 30) => act(async () => { await new Promise(r => setTimeout(r, ms)); });
const composer = () => document.querySelector<HTMLTextAreaElement>('textarea.message-textarea')!;

/** The grace is the code's own 10 s, not worth waiting for. A toast's 5 s goes too,
 *  so a notice that expired like one would be gone by the next look. */
function shortenTheGrace() {
    const realTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number, ...rest: []) =>
        realTimeout(fn, ms === 10_000 || ms === 5_000 ? 0 : ms, ...rest)) as typeof setTimeout);
}

/** The grace held until `fire`: what has happened by the time it runs. */
function holdTheGrace() {
    const realTimeout = globalThis.setTimeout;
    const held: (() => void)[] = [];
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number, ...rest: []) => {
        if (ms !== 10_000) return realTimeout(fn, ms, ...rest);
        held.push(fn);
        return 0;
    }) as typeof setTimeout);
    return async () => {
        await act(async () => { for (const fn of held.splice(0)) fn(); });
        await settle(50);
    };
}

async function mountChat() {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
        root!.render(<QueryClientProvider client={qc}><MemoryRouter><Chat onLogout={() => {}} /></MemoryRouter></QueryClientProvider>);
    });
    for (let i = 0; i < 40 && !document.querySelector('.chat-header')?.textContent?.includes('general'); i++) await settle();
    expect(document.querySelector('.chat-header')?.textContent, 'the channel opened').toContain('general');
    await settle();
}

/** Type into the real composer and press Enter. */
async function pressSend(text: string) {
    const box = composer();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, text);
    await act(async () => { box.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => { box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
}

/** Drop a file on the message list, and wait for its chip to be ready to send. */
async function dropReadyFile() {
    const dt = { types: ['Files'], files: [new File(['hello'], 'notes.txt', { type: 'text/plain' })], dropEffect: 'copy' };
    const zone = document.querySelector('.messages-container')!;
    for (const type of ['dragover', 'drop']) {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'dataTransfer', { value: dt });
        await act(async () => { zone.dispatchEvent(event); });
    }
    for (let i = 0; i < 40 && !document.querySelector('.composer-chip-ready'); i++) await settle();
    expect(document.querySelector('.composer-chip-ready'), 'the chip is ready').not.toBeNull();
}

async function moveToRandom() {
    const random = [...document.querySelectorAll<HTMLElement>('.channel-item, .channel-name, [data-channel-id]')].find(el => el.textContent?.includes('random'));
    await act(async () => { random!.click(); });
    await settle(50);
    expect(document.querySelector('.chat-header')?.textContent, 'moved').toContain('random');
}

describe('the chat view, when nobody just pressed anything', () => {
    it('a generic Error frame is a notice with the server\'s words, and no modal', async () => {
        await mountChat();
        expect(frameListeners, 'Chat listens for the frame').toHaveLength(1);
        await act(async () => { frameListeners[0]({ type: 'Error', payload: { message: 'Not in this room' } }); });
        expect(dialogs.notices()).toEqual(['Not in this room']);
        expect(alertSpy).not.toHaveBeenCalled();
        expect(confirmSpy).not.toHaveBeenCalled();
    });

    it('an Error frame with no message still says something', async () => {
        await mountChat();
        await act(async () => { frameListeners[0]({ type: 'Error', payload: {} }); });
        expect(dialogs.notices()).toEqual(['The server rejected that action.']);
    });

    it('the send that gives up, ten seconds after the press, says so until it is read, and takes the bubble down', async () => {
        shortenTheGrace();
        h.send = async () => { throw new TypeError('Failed to fetch'); };
        await mountChat();
        await pressSend('hello there');
        await settle(50);
        expect(dialogs.notices()).toEqual(['Message failed to send. Check your connection and try again.']);
        expect(alertSpy).not.toHaveBeenCalled();
        expect(document.querySelector('.messages-container')?.textContent).not.toContain('hello there');
        // A toast's own 5 s would have run out by now (shortenTheGrace): the person
        // may have been in a game for all of it.
        await settle(50);
        expect(dialogs.notices()).toHaveLength(1);
    });

    it('and what they wrote is back in the composer, ready to send again', async () => {
        shortenTheGrace();
        let release: (reason: unknown) => void = () => {};
        h.send = () => new Promise((_, reject) => { release = reject; });
        await mountChat();
        await pressSend('hello there');
        expect(composer().value, 'the send cleared it, as a send does').toBe('');
        await act(async () => { release(new TypeError('Failed to fetch')); });
        await settle(50);
        expect(composer().value).toBe('hello there');
        // CONTROL: the words are in the composer, not in the notice as well.
        expect(dialogs.notices()).toEqual(['Message failed to send. Check your connection and try again.']);
    });

    it('anything typed while it was failing stays, after what comes back', async () => {
        shortenTheGrace();
        let release: (reason: unknown) => void = () => {};
        h.send = () => new Promise((_, reject) => { release = reject; });
        await mountChat();
        await pressSend('first');
        const box = composer();
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'second');
        await act(async () => { box.dispatchEvent(new Event('input', { bubbles: true })); });
        await act(async () => { release(new TypeError('Failed to fetch')); });
        await settle(50);
        expect(composer().value).toBe('first\nsecond');
    });

    it('having moved to another channel, the words go in the notice and not in that composer', async () => {
        shortenTheGrace();
        let release: (reason: unknown) => void = () => {};
        h.send = () => new Promise((_, reject) => { release = reject; });
        await mountChat();
        await pressSend('hello there');
        const random = [...document.querySelectorAll<HTMLElement>('.channel-item, .channel-name, [data-channel-id]')].find(el => el.textContent?.includes('random'));
        expect(random, 'the other channel is in the sidebar').toBeTruthy();
        await act(async () => { random!.click(); });
        await settle(50);
        expect(document.querySelector('.chat-header')?.textContent, 'moved').toContain('random');
        await act(async () => { release(new TypeError('Failed to fetch')); });
        await settle(50);
        expect(composer().value, 'one Enter from going to the wrong people').toBe('');
        const [said] = dialogs.notices();
        expect(said).toContain('Message failed to send');
        expect(said).toContain('#general');
        expect(said).toContain('hello there');
    });

    describe('when Chat has gone by the time it gives up', () => {
        async function leftWithASendUnconfirmed() {
            const fire = holdTheGrace();
            h.send = async () => { throw new TypeError('Failed to fetch'); };
            await mountChat();
            await pressSend('hello there');
            await settle(50);
            await moveToRandom();
            return fire;
        }
        const chatGoes = () => { act(() => root?.unmount()); root = null; };

        it('signed out, their words do not wait on the login screen for the next person', async () => {
            const fire = await leftWithASendUnconfirmed();
            // logout(): the token goes, then the page does.
            h.sessionOf = null;
            chatGoes();
            await fire();
            expect(dialogs.notices()).toEqual([]);
        });

        it('nor do they reach another account that signed in meanwhile', async () => {
            const fire = await leftWithASendUnconfirmed();
            h.sessionOf = ME + 1;
            chatGoes();
            await fire();
            expect(dialogs.notices()).toEqual([]);
        });

        it('CONTROL: still signed in (an invite link replaced Chat), this is the only copy, and it is said', async () => {
            const fire = await leftWithASendUnconfirmed();
            chatGoes();
            await fire();
            const [said] = dialogs.notices();
            expect(said).toContain('Message failed to send');
            expect(said).toContain('hello there');
        });

        // The same words by the two other ways out. A press's answer is an alert off the desktop.
        describe('a channel send refused', () => {
            async function refusedAfter(signedOut: boolean) {
                let release: (reason: unknown) => void = () => {};
                h.send = () => new Promise((_, reject) => { release = reject; });
                await mountChat();
                await pressSend('hello there');
                await moveToRandom();
                if (signedOut) h.sessionOf = null;
                chatGoes();
                await act(async () => { release(new Error('the server refused it')); });
                await settle(50);
            }

            it('says nothing after a sign-out', async () => {
                await refusedAfter(true);
                expect(alertSpy).not.toHaveBeenCalled();
                expect(dialogs.notices()).toEqual([]);
            });

            it('CONTROL: still signed in, it is said, with the words', async () => {
                await refusedAfter(false);
                expect(String(alertSpy.mock.calls[0]?.[0])).toContain('hello there');
            });
        });

        describe('a DM that could not be sealed or sent', () => {
            async function failedAfter(signedOut: boolean) {
                h.dms = [
                    { id: 'd1', other_user_id: 2, other_username: 'bob', other_display_name: null, last_message: null, last_message_at: null, created_at: '2026-09-01' },
                    { id: 'd2', other_user_id: 3, other_username: 'carol', other_display_name: null, last_message: null, last_message_at: null, created_at: '2026-09-01' },
                ];
                vi.spyOn(wsClient, 'isConnected', 'get').mockReturnValue(true);
                vi.spyOn(wsClient, 'sendDirectMessage').mockImplementation(() => {});
                let release: (reason: unknown) => void = () => {};
                h.seal = () => new Promise((_, reject) => { release = reject; });
                await mountChat();
                await act(async () => { document.querySelector<HTMLElement>('.server-icon.home-button')!.click(); });
                await settle();
                await act(async () => { [...document.querySelectorAll<HTMLElement>('.dm-item')].find(el => el.textContent?.includes('bob'))!.click(); });
                await settle(50);
                await pressSend('hi bob');
                await act(async () => { document.querySelector<HTMLElement>('.back-to-server-btn')!.click(); });
                await settle();
                await act(async () => { [...document.querySelectorAll<HTMLElement>('.dm-item')].find(el => el.textContent?.includes('carol'))!.click(); });
                await settle(50);
                if (signedOut) h.sessionOf = null;
                chatGoes();
                await act(async () => { release(new Error('no key for them')); });
                await settle(50);
            }

            it('says nothing after a sign-out', async () => {
                await failedAfter(true);
                expect(alertSpy).not.toHaveBeenCalled();
                expect(dialogs.notices()).toEqual([]);
            });

            it('CONTROL: still signed in, it is said, with the words', async () => {
                await failedAfter(false);
                expect(String(alertSpy.mock.calls[0]?.[0])).toContain('hi bob');
            });
        });
    });

    it('POSITIVE CONTROL: a refusal the moment the person pressed Send stays what it was, a dialog they answer', async () => {
        h.send = async () => { throw new Error('the server refused it'); };
        await mountChat();
        await pressSend('hello there');
        await settle(50);
        expect(alertSpy).toHaveBeenCalledTimes(1);
        expect(dialogs.notices()).toEqual([]);
        expect(composer().value, 'and that gives it back too').toBe('hello there');
    });

    it('a send that gave up brings its attachment back too, and removing the chip then deletes nothing', async () => {
        shortenTheGrace();
        let release: (reason: unknown) => void = () => {};
        h.send = () => new Promise((_, reject) => { release = reject; });
        await mountChat();
        await dropReadyFile();
        await pressSend('with a file');
        expect(document.querySelector('.composer-chip'), 'the send took it').toBeNull();
        await act(async () => { release(new TypeError('Failed to fetch')); });
        await settle(50);
        expect(composer().value).toBe('with a file');
        expect(document.querySelector('.composer-chip-ready .composer-chip-name')?.textContent).toBe('notes.txt');
        // The answer was lost, so the message may have landed with this file in it.
        const remove = [...document.querySelectorAll<HTMLElement>('.composer-chip-btn')].find(b => /remove/i.test(`${b.getAttribute('aria-label')} ${b.title}`));
        await act(async () => { remove!.click(); });
        expect(document.querySelector('.composer-chip')).toBeNull();
        expect(h.discarded).toEqual([]);
    });

    it('a send refused after they moved on frees its upload, which nothing can name now', async () => {
        let release: (reason: unknown) => void = () => {};
        h.send = () => new Promise((_, reject) => { release = reject; });
        await mountChat();
        await dropReadyFile();
        await pressSend('with a file');
        await moveToRandom();
        await act(async () => { release(new Error('the server refused it')); });
        await settle(50);
        expect(h.discarded).toEqual(['up-notes.txt']);
        expect(document.querySelector('.composer-chip'), 'and it stays out of this composer').toBeNull();
    });

    it('CONTROL: lost after they moved on, it may have landed, so the upload stays', async () => {
        shortenTheGrace();
        let release: (reason: unknown) => void = () => {};
        h.send = () => new Promise((_, reject) => { release = reject; });
        await mountChat();
        await dropReadyFile();
        await pressSend('with a file');
        await moveToRandom();
        await act(async () => { release(new TypeError('Failed to fetch')); });
        await settle(50);
        expect(dialogs.notices()[0]).toContain('with a file');
        expect(h.discarded).toEqual([]);
    });

    it('a DM refused by an Error frame comes back to the box it was written in', async () => {
        h.dms = [{ id: 'd1', other_user_id: 2, other_username: 'bob', other_display_name: null, last_message: null, last_message_at: null, created_at: '2026-09-01' }];
        vi.spyOn(wsClient, 'isConnected', 'get').mockReturnValue(true);
        const sent = vi.spyOn(wsClient, 'sendDirectMessage').mockImplementation(() => {});
        await mountChat();
        await act(async () => { document.querySelector<HTMLElement>('.server-icon.home-button')!.click(); });
        await settle();
        await act(async () => { document.querySelector<HTMLElement>('.friends-dashboard .dm-item')!.click(); });
        await settle(50);
        await pressSend('hi bob');
        await settle(50);
        expect(sent, 'it went').toHaveBeenCalledTimes(1);
        expect(composer().value).toBe('');
        await act(async () => { frameListeners[0]({ type: 'Error', payload: { message: 'They only accept messages from friends' } }); });
        await settle(50);
        expect(composer().value).toBe('hi bob');
        expect(dialogs.notices()).toEqual(['They only accept messages from friends']);
    });

    describe('a DM after the person has moved on', () => {
        const REFUSED = 'This user only accepts direct messages from friends';
        const TWO_DMS = [
            { id: 'd1', other_user_id: 2, other_username: 'bob', other_display_name: null, last_message: null, last_message_at: null, created_at: '2026-09-01' },
            { id: 'd2', other_user_id: 3, other_username: 'carol', other_display_name: null, last_message: null, last_message_at: null, created_at: '2026-09-01' },
        ];
        const openDm = async (name: string) => {
            const item = [...document.querySelectorAll<HTMLElement>('.friends-dashboard .dm-item, .dm-item')].find(el => el.textContent?.includes(name));
            expect(item, `${name}'s conversation is listed`).toBeTruthy();
            await act(async () => { item!.click(); });
            await settle(50);
            expect(document.querySelector('.chat-header')?.textContent, `${name}'s is open`).toContain(name);
        };
        const backToTheList = async () => {
            await act(async () => { document.querySelector<HTMLElement>('.back-to-server-btn')!.click(); });
            await settle();
        };
        /** "hi bob" sent and on the socket, and the person now in carol's conversation. */
        async function sentThenMovedOn() {
            h.dms = TWO_DMS;
            vi.spyOn(wsClient, 'isConnected', 'get').mockReturnValue(true);
            vi.spyOn(wsClient, 'sendDirectMessage').mockImplementation(() => {});
            await mountChat();
            await act(async () => { document.querySelector<HTMLElement>('.server-icon.home-button')!.click(); });
            await settle();
            await openDm('bob');
            await pressSend('hi bob');
            await settle(50);
            await backToTheList();
            await openDm('carol');
        }
        const refused = (message = REFUSED) => act(async () => { frameListeners[0]({ type: 'Error', payload: { message } }); });
        const echo = (over: Record<string, unknown> = {}) => act(async () => {
            for (const listen of dmListeners) {
                listen({
                    type: 'DirectMessage',
                    payload: { message_id: 'm1', conversation_id: 'd1', sender: { id: ME, username: 'me' }, content: 'sealed', timestamp: 1, ...over },
                });
            }
        });

        it('refused, the notice carries the words and who they were for, as the changelog says', async () => {
            await sentThenMovedOn();
            await refused();
            await settle(50);
            const [said] = dialogs.notices();
            expect(said).toContain(REFUSED);
            expect(said).toContain('your conversation with bob');
            expect(said).toContain('hi bob');
            expect(composer().value, 'one Enter from going to carol').toBe('');
        });

        it('having come back, the words go back in the box instead', async () => {
            await sentThenMovedOn();
            await backToTheList();
            await openDm('bob');
            await refused();
            await settle(50);
            expect(composer().value).toBe('hi bob');
            expect(dialogs.notices()).toEqual([REFUSED]);
        });

        it('its echo says it landed: a later Error, about anything, does not print its words', async () => {
            await sentThenMovedOn();
            await echo();
            await refused('Slow down');
            await settle(50);
            expect(dialogs.notices()).toEqual(['Slow down']);
        });

        it('CONTROL: the echo of what this account sent from another device leaves this one alone', async () => {
            await sentThenMovedOn();
            await echo({ content: 'sealed on the phone' });
            await refused();
            await settle(50);
            expect(dialogs.notices()[0]).toContain('hi bob');
        });

        it('CONTROL: nor does what someone else sent, with the same words on the wire', async () => {
            await sentThenMovedOn();
            await echo({ sender: { id: 2, username: 'bob' } });
            await refused();
            await settle(50);
            expect(dialogs.notices()[0]).toContain('hi bob');
        });

        it('long after it went, an Error is about something else', async () => {
            await sentThenMovedOn();
            const later = Date.now() + 11_000;
            vi.spyOn(Date, 'now').mockReturnValue(later);
            await refused('Slow down');
            await settle(50);
            expect(dialogs.notices()).toEqual(['Slow down']);
        });

        it('given back once: the next Error has nothing left to print', async () => {
            await sentThenMovedOn();
            await refused();
            await settle(50);
            await refused('Slow down');
            await settle(50);
            expect(dialogs.notices()[1]).toBe('Slow down');
        });
    });

    it('a later Error frame gives nothing back: that bubble was already gone', async () => {
        h.dms = [{ id: 'd1', other_user_id: 2, other_username: 'bob', other_display_name: null, last_message: null, last_message_at: null, created_at: '2026-09-01' }];
        vi.spyOn(wsClient, 'isConnected', 'get').mockReturnValue(true);
        vi.spyOn(wsClient, 'sendDirectMessage').mockImplementation(() => {});
        await mountChat();
        await act(async () => { document.querySelector<HTMLElement>('.server-icon.home-button')!.click(); });
        await settle();
        await act(async () => { document.querySelector<HTMLElement>('.friends-dashboard .dm-item')!.click(); });
        await settle(50);
        await pressSend('hi bob');
        await settle(50);
        await act(async () => { frameListeners[0]({ type: 'Error', payload: { message: 'first' } }); });
        await settle(50);
        const box = composer();
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, '');
        await act(async () => { box.dispatchEvent(new Event('input', { bubbles: true })); });
        await act(async () => { frameListeners[0]({ type: 'Error', payload: { message: 'second' } }); });
        await settle(50);
        expect(composer().value).toBe('');
    });
});

describe('a pin', () => {
    async function pinOwnMessage() {
        h.send = async () => ({ id: 'm1' });
        h.pin = h.pin ?? (async () => {});
        await pressSend('pin me');
        await settle(50);
        const pin = document.querySelector<HTMLElement>('.msg-action-btn[title="Pin Message"]');
        expect(pin, 'the pin button of the sent message').not.toBeNull();
        await act(async () => { pin!.click(); });
        await settle(50);
    }

    // On the web and Android too: nobody should have to answer every pin.
    it('says so in a notice that goes by itself, and is never a dialog', async () => {
        await mountChat();
        await pinOwnMessage();
        expect(alertSpy).not.toHaveBeenCalled();
        expect(dialogs.notices()).toEqual(['Message pinned.']);
    });

    it('that goes by itself', async () => {
        shortenTheGrace();
        await mountChat();
        await pinOwnMessage();
        expect(alertSpy).not.toHaveBeenCalled();
        expect(dialogs.notices(), 'the 5 s, shortened here').toEqual([]);
    });

    it('CONTROL: a pin refused is still said, to whoever pressed it', async () => {
        h.pin = async () => { throw new Error('no'); };
        await mountChat();
        await pinOwnMessage();
        expect(alertSpy).toHaveBeenCalledWith('Could not pin that message. You may not have permission.');
    });
});
