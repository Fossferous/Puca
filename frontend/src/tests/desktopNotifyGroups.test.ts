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
    /** Refused once, then answered: a one-off failure. */
    failOnce: new Set<string>(),
    /** What a command answers (toasts.rs's toast_show: 'popped', 'updated',
     *  're-added', 'off', 'failed'); null when unset, as before it answered. */
    answers: {} as Record<string, unknown>,
    pluginGranted: true,
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
        if (env.failOnce.delete(cmd)) throw new Error('IPC refused');
        if (env.failCommands.has(cmd)) throw new Error(`Command ${cmd} not found`);
        return env.answers[cmd] ?? null;
    },
}));
vi.mock('@tauri-apps/api/event', () => ({
    listen: async (event: string, handler: (e: { payload: string }) => void) => {
        if (event === 'toast-activated') env.toastClick = handler;
        return () => { };
    },
}));
vi.mock('@tauri-apps/plugin-notification', () => ({
    isPermissionGranted: async () => env.pluginGranted,
    requestPermission: async () => (env.pluginGranted ? 'granted' : 'denied'),
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

/** A web Notification that keeps a model of the browser's list.
 *
 *  Chromium-shaped (`renotify` on its prototype, as Chromium exposes it): the
 *  same tag replaces (no close event, as the spec says); renotify or a new
 *  tag pops. Firefox-shaped (no `renotify` anywhere, as in Firefox and
 *  Safari): every replacement pops, because Firefox closes the old toast and
 *  shows a new one (widget/windows/ToastNotification.cpp,
 *  ShowAlertWithCallbacks), and the old one hears its close. Safari-shaped
 *  (`replacesSameTag` false): no renotify, and a same-tag notification shows
 *  at once BESIDE the old one (WebKit bug 258922, iOS). */
function makeFakeNotification(renotifySupported: boolean, replacesSameTag = true) {
    class Fake {
        static permission: NotificationPermission = 'granted';
        static list = new Map<string, Fake>();
        static made: { title: string; tag?: string; renotify?: boolean; silent?: boolean; body?: string }[] = [];
        static instances: Fake[] = [];
        static popups = 0;
        onclick: (() => void) | null = null;
        onclose: (() => void) | null = null;
        onerror: (() => void) | null = null;
        closed = false;
        title: string;
        tag: string;
        constructor(title: string, opts: { tag?: string; renotify?: boolean; silent?: boolean; body?: string } = {}) {
            if (renotifySupported && opts.renotify && !opts.tag) throw new TypeError('renotify needs a tag');
            this.title = title;
            this.tag = opts.tag ?? `untagged#${Fake.made.length}`;
            Fake.made.push({ title, ...opts });
            Fake.instances.push(this);
            const old = Fake.list.get(this.tag);
            if (!old || opts.renotify || !renotifySupported) Fake.popups++;
            Fake.list.set(this.tag, this);
            if (old && !renotifySupported && replacesSameTag) { old.closed = true; old.onclose?.(); }
        }
        close() {
            this.closed = true;
            if (Fake.list.get(this.tag) === this) Fake.list.delete(this.tag);
            this.onclose?.();
        }
        static open() { return Fake.instances.filter(n => !n.closed); }
        static reset() { Fake.list.clear(); Fake.made = []; Fake.instances = []; Fake.popups = 0; }
    }
    if (renotifySupported) {
        Object.defineProperty(Fake.prototype, 'renotify', { get() { return false; }, configurable: true });
    }
    return Fake;
}
const FakeNotification = makeFakeNotification(true);
const FirefoxNotification = makeFakeNotification(false);
const SafariNotification = makeFakeNotification(false, false);

beforeEach(() => {
    env.tauri = true;
    env.mobile = false;
    env.mobileNative = false;
    env.foreground = false;
    env.settings = {};
    env.invokes = [];
    env.failCommands = new Set();
    env.failOnce = new Set();
    env.answers = {};
    env.pluginGranted = true;
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

    it('a click on a toast left from before a reload opens the place its key names', async () => {
        // A reload is a FRESH module: nothing counted, no click actions, no
        // toast shown yet, so only the listener it registers as it loads can
        // hear the click. The listener earlier tests left behind belongs to
        // the module before the "reload"; it is put back afterwards.
        const before = env.toastClick;
        env.toastClick = null;
        vi.resetModules();
        try {
            // Loaded first, one at a time, as at the top of the file: the
            // reset made every mocked module's next import a first one again.
            await import('@tauri-apps/api/event');
            await import('@tauri-apps/api/core');
            await import('@tauri-apps/plugin-notification');
            await import('../api/desktopNotify');
            const freshNav = await import('../api/mobileApp');
            await settle();
            expect(env.invokes.filter(c => c.cmd === 'toast_show')).toHaveLength(0);
            expect(env.toastClick, 'the reloaded page listens for clicks before any toast').toBeTypeOf('function');
            freshNav.consumePendingNav();
            const heard = vi.fn();
            window.addEventListener('sovereign-navigate', heard);
            try {
                env.toastClick!({ payload: 'dm:c9' });
                expect(freshNav.consumePendingNav()).toBe('dm:c9');
                // The task reminder's toast: the Reminders tab.
                env.toastClick!({ payload: 'tasks-due' });
                expect(freshNav.consumePendingNav()).toBe('reminders');
            } finally {
                window.removeEventListener('sovereign-navigate', heard);
            }
            expect(heard).toHaveBeenCalledTimes(2);
        } finally {
            env.toastClick = before;
        }
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
        // It asked once in the burst: an update has nothing to change.
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

describe('the desktop app when Windows shows nothing (review lows 1, 2, 3, 7)', () => {
    it("with Púca's notifications turned off in Windows, no message is quiet: the app's sound says each one arrived", async () => {
        env.answers.toast_show = 'off';
        expect(channelMessage('alice', 'a')).toEqual({ fire: true });
        await settle();
        for (let i = 0; i < 4; i++) {
            vi.advanceTimersByTime(2_000);
            expect(channelMessage('bob', `b${i}`)).toEqual({ fire: true });
            await settle();
        }
        // The plugin's toasts go through the same Windows switch: none tried.
        expect(env.pluginShown).toHaveLength(0);
        expect(notify.notifyDiag().live.nativeToasts).toBe('off');
    });

    it('turned back on, it is quiet again at once: asked every time, never remembered', async () => {
        env.answers.toast_show = 'off';
        channelMessage('alice', 'a');
        await settle();
        env.answers.toast_show = 'updated';
        vi.advanceTimersByTime(2_000);
        // Decided before this one's answer: the last said "off".
        expect(channelMessage('bob', 'b')).toEqual({ fire: true });
        await settle();
        vi.advanceTimersByTime(2_000);
        expect(channelMessage('carol', 'c')).toEqual({ fire: true, quiet: true });
    });

    it('a toast Windows refused is not one to update quietly', async () => {
        env.answers.toast_show = 'failed';
        channelMessage('alice', 'a');
        await settle();
        vi.advanceTimersByTime(2_000);
        expect(channelMessage('bob', 'b')).toEqual({ fire: true });
    });

    it('Send test says when Windows has them turned off, or refused it', async () => {
        env.answers.toast_show = 'off';
        const off = await notify.sendTestNotification();
        expect(off.ok).toBe(false);
        expect(off.reason).toMatch(/turned off/);
        env.answers.toast_show = 'failed';
        expect((await notify.sendTestNotification()).ok).toBe(false);
        env.answers.toast_show = 'popped';
        expect(await notify.sendTestNotification()).toEqual({ ok: true });
        expect(env.pluginShown).toHaveLength(0);
    });

    it('one refusal is not for good: the next burst asks for the replacing toast again', async () => {
        env.failOnce.add('toast_show');
        channelMessage('alice', 'a');
        await settle();
        // Refused, so the plugin carried the pop-up.
        expect(env.pluginShown).toHaveLength(1);
        vi.advanceTimersByTime(61_000);
        expect(channelMessage('bob', 'b')).toEqual({ fire: true });
        await settle();
        // Asked again, answered: no second untagged toast.
        expect(env.pluginShown).toHaveLength(1);
        expect(shows().map(s => s.popup)).toEqual([true, true]);
        vi.advanceTimersByTime(2_000);
        expect(channelMessage('carol', 'c')).toEqual({ fire: true, quiet: true });
        await settle();
        expect(windowsModel().centre.get('chan:s1:7')?.body).toBe('carol and 2 others: 3 new messages');
    });

    it("the plugin's toast, where the shell has none of its own, asks for permission first", async () => {
        env.failCommands.add('toast_show');
        env.pluginGranted = false;
        channelMessage('alice', 'a');
        notify.notifyTasksDue(1, [{ id: 5, mark: 'm' }]);
        await settle();
        expect(env.pluginShown).toHaveLength(0);
        env.pluginGranted = true;
        vi.advanceTimersByTime(61_000);
        channelMessage('bob', 'b');
        await settle();
        expect(env.pluginShown).toEqual([{ title: '#general · Lads', body: 'bob and alice: 2 new messages' }]);
    });
});

describe('task reminders in the desktop app', () => {
    it("ring with Windows' default sound: the reminder's toast asks for it, a message's does not", async () => {
        notify.notifyTasksDue(1, [{ id: 5, mark: 'm5' }]);
        channelMessage('alice', 'a');
        await settle();
        expect(shows()).toEqual([
            { key: 'tasks-due', title: 'Púca Tasks', body: 'A task is due', popup: true, sound: true },
            { key: 'chan:s1:7', title: '#general · Lads', body: 'alice sent a message', popup: true, sound: false },
        ]);
        // Not through the plugin, which has neither a sound nor a click.
        expect(env.pluginShown).toHaveLength(0);
    });

    it('each new one replaces the last, and pops again', async () => {
        notify.notifyTasksDue(1, [{ id: 5, mark: 'm5' }]);
        vi.advanceTimersByTime(2_000);
        notify.notifyTasksDue(2, [{ id: 6, mark: 'm6' }, { id: 7, mark: 'm7' }]);
        await settle();
        const { centre, popups } = windowsModel();
        expect([...centre.keys()]).toEqual(['tasks-due']);
        expect(centre.get('tasks-due')?.body).toBe('2 tasks are due');
        expect(popups).toBe(2);
    });

    it('a click opens Reminders with the due ids, and takes the toast away', async () => {
        notify.notifyTasksDue(2, [{ id: 5, mark: 'a' }, { id: 6, mark: 'b' }]);
        await settle();
        const opened: unknown[] = [];
        const onOpen = (e: Event) => opened.push((e as CustomEvent).detail);
        window.addEventListener('sovereign:open-reminders', onOpen);
        try {
            env.toastClick!({ payload: 'tasks-due' });
            await settle();
        } finally {
            window.removeEventListener('sovereign:open-reminders', onOpen);
        }
        expect(opened).toEqual([{ ids: [5, 6] }]);
        expect(env.invokes.at(-1)).toEqual({ cmd: 'toast_clear', args: { key: 'tasks-due' } });
    });

    it('a click on a conversation never opens Reminders, nor the reverse', async () => {
        const conversation = vi.fn();
        notify.notifyTasksDue(1, [{ id: 5, mark: 'a' }]);
        channelMessage('alice', 'a', 7, { onActivate: conversation });
        await settle();
        const reminders = vi.fn();
        window.addEventListener('sovereign:open-reminders', reminders);
        try {
            env.toastClick!({ payload: 'chan:s1:7' });
            expect(reminders).not.toHaveBeenCalled();
            expect(conversation).toHaveBeenCalledTimes(1);
            env.toastClick!({ payload: 'tasks-due' });
            expect(reminders).toHaveBeenCalledTimes(1);
            expect(conversation).toHaveBeenCalledTimes(1);
        } finally {
            window.removeEventListener('sovereign:open-reminders', reminders);
        }
    });

    it('rings whatever the message grouping setting says', async () => {
        env.settings = { groupNotifications: false };
        notify.notifyTasksDue(1, [{ id: 5, mark: 'a' }]);
        await settle();
        expect(shows()).toEqual([{ key: 'tasks-due', title: 'Púca Tasks', body: 'A task is due', popup: true, sound: true }]);
    });

    it("a shell without its own toasts (not Windows) still shows the plugin's", async () => {
        env.failCommands.add('toast_show');
        notify.notifyTasksDue(3, []);
        await settle();
        expect(env.pluginShown).toEqual([{ title: 'Púca Tasks', body: '3 tasks are due' }]);
    });

    it('rides the same setting as messages, and is not held back by focus', async () => {
        env.foreground = true;
        notify.notifyTasksDue(1, [{ id: 5, mark: 'a' }]);
        await settle();
        expect(shows()).toHaveLength(1);
        env.settings = { desktopNotifications: false };
        notify.notifyTasksDue(1, [{ id: 6, mark: 'b' }]);
        await settle();
        expect(shows()).toHaveLength(1);
    });

    it('signing out takes it away with the rest', async () => {
        notify.notifyTasksDue(1, [{ id: 5, mark: 'a' }]);
        notify.clearAllConversationNotifications();
        await settle();
        expect(env.invokes.at(-1)).toEqual({ cmd: 'toast_clear_all', args: undefined });
        // Its click action went with it: a click now goes by the key alone.
        consumePendingNav();
        env.toastClick!({ payload: 'tasks-due' });
        expect(consumePendingNav()).toBe('reminders');
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

    it('a notification the browser failed to show is not one to update quietly', () => {
        channelMessage('alice', 'a');
        const n = FakeNotification.list.get('chan:s1:7')!;
        n.onerror!();   // the browser's own refusal, after construction
        vi.advanceTimersByTime(2_000);
        // Nothing to update: shown nothing, and not quiet to the caller.
        expect(channelMessage('bob', 'b')).toEqual({ fire: true });
        expect(FakeNotification.made).toHaveLength(1);
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

describe('the web app in a browser with no renotify (Firefox, Safari): review low 5', () => {
    beforeEach(() => {
        env.tauri = false;
        FirefoxNotification.reset();
        (globalThis as { Notification?: unknown }).Notification = FirefoxNotification;
    });

    it('the control: Chromium has renotify on its prototype, these browsers do not', () => {
        expect('renotify' in FakeNotification.prototype).toBe(true);
        expect('renotify' in FirefoxNotification.prototype).toBe(false);
    });

    it('a conversation going on pops once there too: a quiet update makes no notification, since each would pop', () => {
        const decisions: ReturnType<typeof notify.notifyNewMessage>[] = [];
        for (let i = 0; i < 12; i++) {
            decisions.push(channelMessage(['alice', 'bob'][i % 2], `m${i}`));
            vi.advanceTimersByTime(3_000);
        }
        expect(FirefoxNotification.popups).toBe(1);
        expect(FirefoxNotification.made).toHaveLength(1);
        expect(FirefoxNotification.made[0]).toMatchObject({ title: '#general · Lads', body: 'alice sent a message', tag: 'chan:s1:7', silent: true });
        // No renotify handed to a browser that has none.
        expect('renotify' in FirefoxNotification.made[0]).toBe(false);
        // The notification is still there, so the rest are quiet: no blip.
        expect(decisions.slice(1).every(d => d.fire && 'quiet' in d && d.quiet)).toBe(true);
    });

    it('the next burst pops it again with the whole count, as one notification', () => {
        channelMessage('alice', 'a');
        for (let i = 0; i < 4; i++) {
            vi.advanceTimersByTime(3_000);
            channelMessage('bob', `b${i}`);
        }
        vi.advanceTimersByTime(61_000);
        expect(channelMessage('carol', 'c')).toEqual({ fire: true });
        expect(FirefoxNotification.made).toHaveLength(2);
        expect(FirefoxNotification.popups).toBe(2);
        expect(FirefoxNotification.list.size).toBe(1);
        expect(FirefoxNotification.made.at(-1)).toMatchObject({ body: 'carol and 2 others: 6 new messages' });
        // The one before it was closed first, so this one pops whatever the
        // browser does with a replacement.
        expect([...FirefoxNotification.list.values()][0].closed).toBe(false);
    });

    it('closed by the user, the next message is not quiet: nothing shows it', () => {
        channelMessage('alice', 'a');
        FirefoxNotification.list.get('chan:s1:7')!.close();
        vi.advanceTimersByTime(2_000);
        expect(channelMessage('bob', 'b')).toEqual({ fire: true });
        expect(FirefoxNotification.made).toHaveLength(1);
    });

    it('a click still opens the conversation', () => {
        vi.spyOn(window, 'focus').mockImplementation(() => { });
        const opened = vi.fn();
        channelMessage('alice', 'a', 7, { onActivate: opened });
        FirefoxNotification.list.get('chan:s1:7')!.onclick!();
        expect(opened).toHaveBeenCalledTimes(1);
    });
});

describe('the web app in Safari, where a same-tag notification shows beside the old one (review round 1, finding 4)', () => {
    beforeEach(() => {
        env.tauri = false;
        SafariNotification.reset();
        (globalThis as { Notification?: unknown }).Notification = SafariNotification;
    });

    it('the next burst closes the old notification before its new one: one on screen, not two', () => {
        channelMessage('alice', 'a');
        for (let i = 0; i < 3; i++) {
            vi.advanceTimersByTime(3_000);
            channelMessage('bob', `b${i}`);
        }
        vi.advanceTimersByTime(61_000);
        channelMessage('carol', 'c');
        expect(SafariNotification.instances).toHaveLength(2);
        expect(SafariNotification.instances[0].closed).toBe(true);
        expect(SafariNotification.open()).toHaveLength(1);
        expect(SafariNotification.made.at(-1)).toMatchObject({ body: 'carol and 2 others: 5 new messages' });
    });
});

describe('review round 1: a refusal is about its own toast, and a refused reminder still shows', () => {
    it('another conversation shown does not make a refused one look shown (finding 3)', async () => {
        env.answers.toast_show = 'failed';
        channelMessage('alice', 'a', 7);
        await settle();
        env.answers.toast_show = 'popped';
        channelMessage('bob', 'b', 8);
        await settle();
        vi.advanceTimersByTime(2_000);
        // #general's toast was refused: its update is not quiet.
        expect(channelMessage('carol', 'c', 7)).toEqual({ fire: true });
        await settle();
        // #random's was shown: its update is.
        vi.advanceTimersByTime(1_000);
        env.answers.toast_show = 'updated';
        expect(channelMessage('dave', 'd', 8)).toEqual({ fire: true, quiet: true });
        await settle();
        // #general's re-add was answered: shown again, so quiet again.
        vi.advanceTimersByTime(1_000);
        expect(channelMessage('erin', 'e', 7)).toEqual({ fire: true, quiet: true });
        expect(notify.notifyDiag().live.refusedToasts).toEqual([]);
    });

    it('reading a refused conversation forgets the refusal', async () => {
        env.answers.toast_show = 'failed';
        channelMessage('alice', 'a');
        await settle();
        expect(notify.notifyDiag().live.refusedToasts).toEqual(['chan:s1:7']);
        notify.seeConversation('chan:s1:7');
        expect(notify.notifyDiag().live.refusedToasts).toEqual([]);
    });

    it("a reminder Windows refused falls back to the plugin's, and says so in the diagnostics (finding 5)", async () => {
        env.answers.toast_show = 'failed';
        notify.notifyTasksDue(1, [{ id: 5, mark: 'a' }]);
        await settle();
        expect(env.pluginShown).toEqual([{ title: 'Púca Tasks', body: 'A task is due' }]);
        expect(notify.notifyDiag().recent.at(-1)).toMatchObject({ kind: 'task', outcome: 'fired-plugin (failed)' });
    });

    it('with Windows notifications off, the reminder tries nothing else (they would not show either)', async () => {
        env.answers.toast_show = 'off';
        notify.notifyTasksDue(1, [{ id: 5, mark: 'a' }]);
        await settle();
        expect(env.pluginShown).toHaveLength(0);
        expect(notify.notifyDiag().recent.at(-1)).toMatchObject({ kind: 'task', outcome: 'windows-off' });
    });

    it('a shown reminder is one diagnostics entry, fired, once Windows answered', async () => {
        // The ring is capped, so compare its newest entry, not its length.
        channelMessage('alice', 'a');
        const before = notify.notifyDiag().recent.at(-1);
        notify.notifyTasksDue(1, [{ id: 5, mark: 'a' }]);
        expect(notify.notifyDiag().recent.at(-1)).toBe(before);
        await settle();
        expect(notify.notifyDiag().recent.at(-1)).toMatchObject({ kind: 'task', outcome: 'fired' });
    });
});

describe('review round 2', () => {
    it('one refused command does not keep the clears from being sent: nothing is left behind at sign-out (finding 1)', async () => {
        channelMessage('alice', 'a', 7);
        await settle();
        env.failOnce.add('toast_show');
        channelMessage('bob', 'b', 8);
        await settle();
        expect(notify.notifyDiag().live.nativeToasts).toBe('no');
        notify.seeConversation('chan:s1:7');
        notify.clearAllConversationNotifications();
        await settle();
        expect(env.invokes.slice(-2)).toEqual([
            { cmd: 'toast_clear', args: { key: 'chan:s1:7' } },
            { cmd: 'toast_clear_all', args: undefined },
        ]);
    });

    it('an answer Windows did not give in time: Send test does not call it a success; a reminder is not shown twice (finding 5)', async () => {
        env.answers.toast_show = 'queued';
        const r = await notify.sendTestNotification();
        expect(r.ok).toBe(false);
        expect(r.reason).toMatch(/too long/);
        notify.notifyTasksDue(1, [{ id: 5, mark: 'a' }]);
        await settle();
        expect(env.pluginShown).toHaveLength(0);
        expect(notify.notifyDiag().recent.at(-1)).toMatchObject({ kind: 'task', outcome: 'fired (unanswered)' });
        // Most likely shown: a message's update after it stays quiet.
        channelMessage('alice', 'a');
        await settle();
        vi.advanceTimersByTime(2_000);
        expect(channelMessage('bob', 'b')).toEqual({ fire: true, quiet: true });
    });

    describe('the web app: a reminder after one still in the list pops and sounds again (finding 2)', () => {
        beforeEach(() => { env.tauri = false; });

        it('in Chromium, with renotify', () => {
            FakeNotification.reset();
            (globalThis as { Notification?: unknown }).Notification = FakeNotification;
            notify.notifyTasksDue(1, [{ id: 5, mark: 'a' }]);
            vi.advanceTimersByTime(60_000);
            notify.notifyTasksDue(1, [{ id: 6, mark: 'b' }]);
            expect(FakeNotification.popups).toBe(2);
            expect(FakeNotification.made.map(n => [n.tag, n.renotify, n.silent])).toEqual([
                ['tasks-due', true, undefined], ['tasks-due', true, undefined],
            ]);
            expect(FakeNotification.list.size).toBe(1);
        });

        it('in Safari, by closing the old one first: one on screen', () => {
            SafariNotification.reset();
            (globalThis as { Notification?: unknown }).Notification = SafariNotification;
            notify.notifyTasksDue(1, [{ id: 5, mark: 'a' }]);
            notify.notifyTasksDue(2, [{ id: 6, mark: 'b' }, { id: 7, mark: 'c' }]);
            expect(SafariNotification.popups).toBe(2);
            expect(SafariNotification.instances[0].closed).toBe(true);
            expect(SafariNotification.open()).toHaveLength(1);
            expect('renotify' in SafariNotification.made[1]).toBe(false);
        });

        it('a click still opens Reminders with its ids', () => {
            FakeNotification.reset();
            (globalThis as { Notification?: unknown }).Notification = FakeNotification;
            vi.spyOn(window, 'focus').mockImplementation(() => { });
            notify.notifyTasksDue(1, [{ id: 9, mark: 'z' }]);
            const opened: unknown[] = [];
            const onOpen = (e: Event) => opened.push((e as CustomEvent).detail);
            window.addEventListener('sovereign:open-reminders', onOpen);
            try {
                FakeNotification.list.get('tasks-due')!.onclick!();
            } finally {
                window.removeEventListener('sovereign:open-reminders', onOpen);
            }
            expect(opened).toEqual([{ ids: [9] }]);
        });
    });
});
