// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * What reaches the notification layer when a conversation is going on, through
 * the REAL notifyNewMessage (api/desktopNotify.ts), with the desktop shell and
 * the browser's Notification replaced by recorders that keep a model of the
 * notification centre by the platforms' documented rules: a notification with
 * a tag replaces the one with that tag, one without adds an entry.
 *
 * Before this change every message reached the desktop app's plugin as a
 * notification of its own with no tag (toasts.rs says how that was measured on
 * Windows), and the web app tagged by the title, which differs per author. The
 * first describe block is the owner's report as a test; each of its cases
 * fails on that code.
 */

const env = vi.hoisted(() => ({
    tauri: true,
    mobile: false,
    mobileNative: false,
    foreground: false,
    settings: {} as Record<string, unknown>,
    invokes: [] as { cmd: string; args: Record<string, unknown> | undefined }[],
    failCommands: new Set<string>(),
    pluginShown: [] as { title: string; body?: string }[],
    toastClick: null as null | ((e: { payload: string }) => void),
    androidPosted: [] as unknown[][],
}));

vi.mock('../api/platform', async (orig) => ({
    ...(await orig<typeof import('../api/platform')>()),
    isTauri: () => env.tauri,
    isMobile: () => env.mobile,
    appIsForeground: () => env.foreground,
}));
vi.mock('../api/mobileApp', async (orig) => ({
    ...(await orig<typeof import('../api/mobileApp')>()),
    mobileAppAvailable: () => env.mobileNative,
    postMobileNotification: async (...a: unknown[]) => { env.androidPosted.push(a); },
}));
vi.mock('../components/settingsStore', async (orig) => {
    const real = await orig<typeof import('../components/settingsStore')>();
    return { ...real, loadSettings: () => ({ ...real.defaultSettings, ...env.settings }), saveSettings: vi.fn() };
});
vi.mock('@tauri-apps/api/core', () => ({
    invoke: async (cmd: string, args?: Record<string, unknown>) => {
        env.invokes.push({ cmd, args });
        if (env.failCommands.has(cmd)) throw new Error(`Command ${cmd} not found`);
        return null;
    },
}));
vi.mock('@tauri-apps/api/event', () => ({
    listen: async (event: string, handler: (e: { payload: string }) => void) => {
        if (event === 'toast-activated') env.toastClick = handler;
        return () => { };
    },
}));
vi.mock('@tauri-apps/plugin-notification', () => ({
    isPermissionGranted: async () => true,
    requestPermission: async () => 'granted',
    sendNotification: (n: { title: string; body?: string }) => { env.pluginShown.push(n); },
}));

const notify = await import('../api/desktopNotify');
const { consumePendingNav } = await import('../api/mobileApp');
// Loaded once here: several first dynamic imports of a mocked module in
// flight at once can be handed the real one (seen with five at once).
await import('@tauri-apps/plugin-notification');
await import('@tauri-apps/api/core');

/** Let the async halves (dynamic imports, the one-at-a-time queue) finish. */
async function settle() {
    for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0));
}

/** The desktop shell's notification centre, by toasts.rs's contract: a show
 *  replaces its key's entry, a quiet one adds none on screen, an update needs
 *  the entry. Pop-ups counted separately. */
function windowsModel() {
    const centre = new Map<string, { title: string; body: string }>();
    let popups = 0;
    for (const { cmd, args } of env.invokes) {
        if (cmd === 'toast_show') {
            const a = args as { key: string; title: string; body: string; popup: boolean };
            centre.set(a.key, { title: a.title, body: a.body });
            if (a.popup) popups++;
        } else if (cmd === 'toast_clear') {
            centre.delete((args as { key: string }).key);
        } else if (cmd === 'toast_clear_all') {
            centre.clear();
        }
    }
    // The plugin's toasts have no tag: each is an entry, and a pop-up.
    env.pluginShown.forEach((n, i) => { centre.set(`untagged#${i}`, { title: n.title, body: n.body ?? '' }); popups++; });
    return { centre, popups };
}

const shows = () => env.invokes.filter(c => c.cmd === 'toast_show').map(c => c.args as { key: string; title: string; body: string; popup: boolean });

function channelMessage(author: string, id: string, channel = 7, extra: Partial<Parameters<typeof notify.notifyNewMessage>[0]> = {}) {
    return notify.notifyNewMessage({
        title: `${author} sent a message`,
        isOwn: false,
        isMuted: false,
        notifyKey: 'chan:s1',
        onActivate: extra.onActivate,
        group: { key: `chan:s1:${channel}`, kind: 'channel', where: channel === 7 ? '#general · Lads' : '#random · Lads', author, messageId: id },
        ...extra,
    });
}

/** A web Notification that keeps a model of the browser's list: the same
 *  tag replaces (no close event, as the spec says), renotify or a new tag pops. */
class FakeNotification {
    static permission: NotificationPermission = 'granted';
    static list = new Map<string, FakeNotification>();
    static made: { title: string; tag?: string; renotify?: boolean; silent?: boolean; body?: string }[] = [];
    static popups = 0;
    onclick: (() => void) | null = null;
    onclose: (() => void) | null = null;
    closed = false;
    title: string;
    tag: string;
    constructor(title: string, opts: { tag?: string; renotify?: boolean; silent?: boolean; body?: string } = {}) {
        if (opts.renotify && !opts.tag) throw new TypeError('renotify needs a tag');
        this.title = title;
        this.tag = opts.tag ?? `untagged#${FakeNotification.made.length}`;
        FakeNotification.made.push({ title, ...opts });
        const replacing = FakeNotification.list.has(this.tag);
        if (!replacing || opts.renotify) FakeNotification.popups++;
        FakeNotification.list.set(this.tag, this);
    }
    close() {
        this.closed = true;
        if (FakeNotification.list.get(this.tag) === this) FakeNotification.list.delete(this.tag);
        this.onclose?.();
    }
    static reset() { FakeNotification.list.clear(); FakeNotification.made = []; FakeNotification.popups = 0; }
}

beforeEach(() => {
    env.tauri = true;
    env.mobile = false;
    env.mobileNative = false;
    env.foreground = false;
    env.settings = {};
    env.invokes = [];
    env.failCommands = new Set();
    env.pluginShown = [];
    env.androidPosted = [];
    notify.resetConversationNotificationsForTests();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-12T20:00:00Z'));
});

afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as { Notification?: unknown }).Notification;
});

describe('a conversation going on while you are away (desktop app)', () => {
    it('is ONE toast that popped once and keeps count, not one per message', async () => {
        const authors = ['alice', 'bob', 'carol'];
        for (let i = 0; i < 20; i++) {
            channelMessage(authors[i % 3], `m${i}`);
            vi.advanceTimersByTime(4_000);
        }
        await settle();
        const { centre, popups } = windowsModel();
        expect(centre.size).toBe(1);
        expect(popups).toBe(1);
        expect(env.pluginShown).toHaveLength(0);
        expect([...centre.values()][0]).toEqual({ title: '#general · Lads', body: 'bob and 2 others: 20 new messages' });
        // Every update carries the same key, in the order the messages came.
        expect(new Set(shows().map(s => s.key))).toEqual(new Set(['chan:s1:7']));
        expect(shows().map(s => s.popup)).toEqual([true, ...Array(19).fill(false)]);
        expect(shows().map(s => s.body).slice(-2)).toEqual(['alice and 2 others: 19 new messages', 'bob and 2 others: 20 new messages']);
    });

    it('tells the caller an update was quiet, so it plays no sound for it', () => {
        expect(channelMessage('alice', 'a')).toEqual({ fire: true });
        vi.advanceTimersByTime(2_000);
        expect(channelMessage('bob', 'b')).toEqual({ fire: true, quiet: true });
    });

    it('is one toast per conversation: two channels and a DM are three', async () => {
        channelMessage('alice', 'a', 7);
        channelMessage('bob', 'b', 8);
        notify.notifyNewMessage({
            title: 'Alice sent you a message', isOwn: false, isMuted: false, notifyKey: 'dm:c1', nav: 'dm:c1',
            group: { key: 'dm:c1', kind: 'dm', where: 'Alice', author: 'Alice', messageId: 'd1' },
        });
        channelMessage('carol', 'c', 7);
        await settle();
        const { centre, popups } = windowsModel();
        expect([...centre.keys()].sort()).toEqual(['chan:s1:7', 'chan:s1:8', 'dm:c1']);
        expect(popups).toBe(3);
    });

    it('pops the same toast again when the conversation starts again after a quiet minute', async () => {
        channelMessage('alice', 'a');
        vi.advanceTimersByTime(61_000);
        expect(channelMessage('bob', 'b')).toEqual({ fire: true });
        await settle();
        expect(shows().map(s => [s.key, s.popup])).toEqual([['chan:s1:7', true], ['chan:s1:7', true]]);
        expect(windowsModel().centre.size).toBe(1);
    });

    it('lets a mention in the open channel pop mid-burst, counted once with its other report', async () => {
        channelMessage('alice', 'a');
        vi.advanceTimersByTime(3_000);
        expect(channelMessage('bob', 'm1')).toEqual({ fire: true, quiet: true });
        // The open channel's own report of the same message, which found your name.
        const decision = notify.notifyNewMessage({
            title: 'bob sent a message', isOwn: false, isMuted: false, notifyKey: 'chan:s1', onlyIfGrouped: true,
            group: { key: 'chan:s1:7', kind: 'channel', where: '#general · Lads', author: 'bob', messageId: 'm1', important: true },
        });
        expect(decision).toEqual({ fire: true });
        await settle();
        expect(shows().map(s => s.popup)).toEqual([true, false, true]);
        expect(shows().at(-1)?.body).toBe('bob and alice: 2 new messages');
    });

    it('shows nothing at all while you are looking at the app', async () => {
        env.foreground = true;
        for (let i = 0; i < 5; i++) expect(channelMessage('alice', `m${i}`)).toEqual({ fire: false, reason: 'focused' });
        await settle();
        expect(env.invokes.filter(c => c.cmd === 'toast_show')).toHaveLength(0);
        expect(env.pluginShown).toHaveLength(0);
    });

    it('keeps the mute rule', async () => {
        expect(channelMessage('alice', 'a', 7, { isMuted: true })).toEqual({ fire: false, reason: 'muted' });
        await settle();
        expect(shows()).toHaveLength(0);
    });

    it('takes the toast away when the conversation is read, and the next message pops afresh', async () => {
        channelMessage('alice', 'a');
        vi.advanceTimersByTime(1_000);
        channelMessage('bob', 'b');
        notify.seeConversation('chan:s1:7');
        vi.advanceTimersByTime(1_000);
        channelMessage('carol', 'c');
        await settle();
        expect(env.invokes.map(c => c.cmd)).toEqual(['toast_show', 'toast_show', 'toast_clear', 'toast_show']);
        expect(shows().at(-1)).toMatchObject({ popup: true, body: 'carol sent a message' });
    });

    it('a click opens the conversation and starts its count again', async () => {
        const opened = vi.fn();
        channelMessage('alice', 'a', 7, { onActivate: opened });
        await settle();
        expect(env.toastClick).toBeTypeOf('function');
        env.toastClick!({ payload: 'chan:s1:7' });
        await settle();
        expect(opened).toHaveBeenCalledTimes(1);
        expect(env.invokes.at(-1)).toEqual({ cmd: 'toast_clear', args: { key: 'chan:s1:7' } });
        channelMessage('bob', 'b');
        await settle();
        expect(shows().at(-1)).toMatchObject({ popup: true, body: 'bob sent a message' });
    });

    it('a click on a toast left from before a reload opens the place its key names', () => {
        consumePendingNav();
        const heard = vi.fn();
        window.addEventListener('sovereign-navigate', heard);
        env.toastClick!({ payload: 'dm:c9' });
        window.removeEventListener('sovereign-navigate', heard);
        expect(heard).toHaveBeenCalledTimes(1);
        expect(consumePendingNav()).toBe('dm:c9');
    });

    it('a shell without its own toasts (not Windows): the plugin pops once per burst, never per message', async () => {
        env.failCommands.add('toast_show');
        channelMessage('alice', 'm0');
        await settle();
        for (let i = 1; i < 10; i++) {
            vi.advanceTimersByTime(2_000);
            // Nothing shows for these, so they are not quiet to the caller:
            // the app's own sound still says each one arrived.
            expect(channelMessage('alice', `m${i}`)).toEqual({ fire: true });
        }
        await settle();
        expect(env.pluginShown).toEqual([{ title: '#general · Lads', body: 'alice sent a message' }]);
        // It asked once, and believed the answer.
        expect(env.invokes.filter(c => c.cmd === 'toast_show')).toHaveLength(1);
        // The next burst pops through the plugin again.
        vi.advanceTimersByTime(61_000);
        channelMessage('bob', 'm10');
        await settle();
        expect(env.pluginShown).toHaveLength(2);
    });

    it('with the setting off it is one notification per message, as before', async () => {
        env.settings = { groupNotifications: false };
        for (let i = 0; i < 5; i++) {
            channelMessage('alice', `m${i}`);
            await settle();
        }
        expect(shows()).toHaveLength(0);
        expect(env.pluginShown).toHaveLength(5);
        expect(env.pluginShown[0]).toEqual({ title: 'alice sent a message', body: 'New message' });
    });

    it('coming back to the window ends the burst: the next DM after you leave again pops', async () => {
        const dm = (id: string) => notify.notifyNewMessage({
            title: 'Bob sent you a message', isOwn: false, isMuted: false, notifyKey: 'dm:c1', nav: 'dm:c1',
            group: { key: 'dm:c1', kind: 'dm', where: 'Bob', author: 'Bob', messageId: id },
        });
        expect(dm('d1')).toEqual({ fire: true });
        await settle();
        vi.advanceTimersByTime(15_000);
        notify.endConversationBursts();
        vi.advanceTimersByTime(25_000);
        expect(dm('d2')).toEqual({ fire: true });
        await settle();
        expect(shows().map(s => s.popup)).toEqual([true, true]);
    });

    it('signing out takes every message toast away', async () => {
        channelMessage('alice', 'a');
        notify.clearAllConversationNotifications();
        await settle();
        expect(env.invokes.at(-1)).toEqual({ cmd: 'toast_clear_all', args: undefined });
        channelMessage('bob', 'b');
        await settle();
        expect(shows().at(-1)).toMatchObject({ popup: true, body: 'bob sent a message' });
    });

    it('the test notification replaces itself rather than stacking', async () => {
        await notify.sendTestNotification();
        await notify.sendTestNotification();
        await settle();
        expect(shows().map(s => [s.key, s.popup])).toEqual([['test', true], ['test', true]]);
        expect(windowsModel().centre.size).toBe(1);
        expect(env.pluginShown).toHaveLength(0);
    });

    it('records each decision in the diagnostics, by id and count only', async () => {
        channelMessage('alice', 'a');
        channelMessage('bob', 'b');
        channelMessage('bob', 'b');
        const diag = notify.notifyDiag();
        expect(diag.recent.slice(-3).map(e => [e.key, e.outcome])).toEqual([
            ['chan:s1:7', 'fired'], ['chan:s1:7', 'updated'], ['chan:s1:7', 'duplicate'],
        ]);
        expect(diag.live.groups).toEqual([{ key: 'chan:s1:7', count: 2 }]);
        // Names stay out of the console.
        expect(JSON.stringify(diag.live)).not.toMatch(/alice|bob/);
    });
});

describe('Android is left as it was', () => {
    it('posts by its own key, title and content-free body, every time', async () => {
        env.tauri = false;
        env.mobile = true;
        env.mobileNative = true;
        env.settings = { mobileNotifications: true };
        channelMessage('alice', 'a');
        channelMessage('bob', 'b');
        await settle();
        expect(env.androidPosted).toEqual([
            ['chan:s1', 'alice sent a message', 'New message', undefined],
            ['chan:s1', 'bob sent a message', 'New message', undefined],
        ]);
        expect(env.invokes).toHaveLength(0);
    });

    it("a mention's second report adds nothing there", async () => {
        env.tauri = false;
        env.mobile = true;
        env.mobileNative = true;
        // The ring is capped, so compare its newest entry, not its length.
        const before = notify.notifyDiag().recent.at(-1);
        const d = notify.notifyNewMessage({
            title: 'bob sent a message', isOwn: false, isMuted: false, notifyKey: 'chan:s1', onlyIfGrouped: true,
            group: { key: 'chan:s1:7', kind: 'channel', where: '#general', author: 'bob', messageId: 'm1', important: true },
        });
        await settle();
        expect(d).toEqual({ fire: true, quiet: true });
        expect(env.androidPosted).toHaveLength(0);
        // Nor to the diagnostics: the plain report of the same message is the one there.
        expect(notify.notifyDiag().recent.at(-1)).toEqual(before);
    });
});

describe('the web app', () => {
    beforeEach(() => {
        env.tauri = false;
        FakeNotification.reset();
        (globalThis as { Notification?: unknown }).Notification = FakeNotification;
    });

    it('tags by conversation, so a busy channel is one notification, popping once', () => {
        for (let i = 0; i < 12; i++) {
            channelMessage(['alice', 'bob'][i % 2], `m${i}`);
            vi.advanceTimersByTime(3_000);
        }
        expect(FakeNotification.list.size).toBe(1);
        expect(FakeNotification.popups).toBe(1);
        expect(new Set(FakeNotification.made.map(n => n.tag))).toEqual(new Set(['chan:s1:7']));
        expect(FakeNotification.made.map(n => n.renotify)).toEqual([true, ...Array(11).fill(false)]);
        expect(FakeNotification.made.every(n => n.silent === true)).toBe(true);
        expect(FakeNotification.made.at(-1)).toMatchObject({ title: '#general · Lads', body: 'bob and alice: 12 new messages' });
    });

    it('a quiet update after you closed it shows nothing; the next burst pops', () => {
        channelMessage('alice', 'a');
        vi.advanceTimersByTime(1_000);
        // Still there: an update, quiet to the caller (no blip).
        expect(channelMessage('bob', 'a2')).toEqual({ fire: true, quiet: true });
        FakeNotification.list.get('chan:s1:7')!.close();
        vi.advanceTimersByTime(2_000);
        // Closed: nothing is shown, so the caller is NOT told to keep quiet,
        // and the app's own sound still says a message arrived.
        expect(channelMessage('bob', 'b')).toEqual({ fire: true });
        expect(FakeNotification.made).toHaveLength(2);
        vi.advanceTimersByTime(61_000);
        channelMessage('carol', 'c');
        expect(FakeNotification.made).toHaveLength(3);
        expect(FakeNotification.popups).toBe(2);
    });

    it('a click focuses the app, opens the conversation and closes it', () => {
        const focus = vi.spyOn(window, 'focus').mockImplementation(() => { });
        const opened = vi.fn();
        channelMessage('alice', 'a', 7, { onActivate: opened });
        const n = FakeNotification.list.get('chan:s1:7')!;
        n.onclick!();
        expect(focus).toHaveBeenCalled();
        expect(opened).toHaveBeenCalledTimes(1);
        expect(n.closed).toBe(true);
    });

    it('reading the conversation closes its notification', () => {
        channelMessage('alice', 'a');
        notify.seeConversation('chan:s1:7');
        expect(FakeNotification.list.size).toBe(0);
    });

    it('with the setting off it tags by title, as before', () => {
        env.settings = { groupNotifications: false };
        channelMessage('alice', 'a');
        channelMessage('bob', 'b');
        expect(FakeNotification.made.map(n => n.tag)).toEqual(['alice sent a message', 'bob sent a message']);
    });
});
