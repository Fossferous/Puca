// A conversation going on while you are away reaches the notification layer
// as ONE notification per conversation that updates in place, in a REAL
// browser, for the web app and for the desktop app's shell.
//
// WHY THIS EXISTS. The owner's report: "windows notifications are spammed if
// theres a conversation happening - they should be more seamless". Every
// message raised its own Windows toast. vitest (desktopNotifyGroups.test.ts)
// pins the decisions under jsdom, which has no Notification at all, so only a
// real browser can say that Chromium takes the options the web path now
// passes (a tag, `renotify`, `silent` together; Chromium throws a TypeError on
// some combinations, and the module swallows construction errors, so a
// refused option would read as silence), that each notification really shows
// (its `show` event fires) and that reading the conversation really closes it.
// The desktop half runs the real module under a stand-in shell
// (window.__TAURI_INTERNALS__, recording every command) with the real
// @tauri-apps/api event plumbing, and a click is the shell's real event
// shape (toasts.rs emits `toast-activated` with the key).
//
// What the notification layer then holds is judged by the platforms'
// documented rules (toasts.rs quotes Microsoft's): a notification with the
// same tag replaces the one before it, one without a tag is an entry of its
// own and a pop-up of its own.
//
// The desktop app's TASK REMINDER goes the same way since 0.9.863: its toast
// asks for Windows' default sound (the plugin's were silent, so a reminder
// made no sound), and a click, the shell's own `toast-activated` event with
// the key `tasks-due`, opens the Reminders view with the due ids; a click on
// one left from before a reload lands on the 'reminders' target. The sound
// is judged from the recorded command, never played.
//
// Which browsers pop a same-tag replacement up only when asked (`renotify`)
// decides what the web path does with a quiet update, so the run also asks
// Firefox and WebKit whether `renotify` is on Notification.prototype, a read
// that constructs no notification (FIREFOX=0 / WEBKIT=0 skip them).
//
// NEGATIVE CONTROL: the same conversation through the module as it was at
// 0.9.860 (src/tests/fixtures/desktopNotifyAt860.ts) must FAIL the same
// checks: one notification per message on both paths, and a reminder with no
// sound that a click does not open.
//
// SAFE ON THE OWNER'S DESKTOP: headless FULL Chromium (Playwright's headless
// shell refuses notifications) with NativeNotifications and
// SystemNotifications switched off, so nothing is ever handed to Windows'
// own toasts (web-push-real-browser.mjs measured that); no window, no focus
// taken, no sound (--mute-audio, and every notification is silent). The
// desktop half never reaches an OS at all: its shell is a recorder. Focus is
// the one thing stubbed: `document.hasFocus()` answers false, as it does with
// the window behind a game, since a headless page cannot be unfocused.
// Firefox and WebKit are headless and muted too, and only read a property.
//
//   cd frontend && node e2e/notify-coalesce-real-browser.mjs
//
// No server and no build needed (esbuild bundles the modules; ~20 s).
import { chromium } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', 'src');

async function bundle(entry, globalName) {
    const out = await build({
        stdin: { contents: entry, resolveDir: src, loader: 'ts', sourcefile: `${globalName}.ts` },
        bundle: true,
        write: false,
        format: 'iife',
        globalName,
        platform: 'browser',
        define: {
            'process.env.NODE_ENV': '"production"',
            'import.meta.env': '{"DEV":false,"PROD":true,"MODE":"test"}',
            __APP_VERSION__: '"0.0.0"',
            __RC_ENABLED__: 'true',
        },
        // Modules this bundle never runs (a worker URL) warn about import.meta.
        logLevel: 'error',
    });
    return out.outputFiles[0].text;
}

const NOW = await bundle(
    "export * from './api/desktopNotify'; export { consumePendingNav } from './api/mobileApp';",
    'Notify',
);
const AT_860 = await bundle(
    "export * from './tests/fixtures/desktopNotifyAt860'; export { consumePendingNav } from './api/mobileApp';",
    'Notify',
);

// tauri-plugin-notification 2.4.0's own init script (src/init-iife.js,
// Apache-2.0/MIT), verbatim but for its template flag, which Tauri sets on
// Windows: it is what turns the plugin's `sendNotification` into the
// `plugin:notification|notify` command the 0.9.860 desktop path sent.
const NOTIFICATION_PLUGIN_INIT = '!function(){"use strict";async function i(i,n={},t){return window.__TAURI_INTERNALS__.invoke(i,n,t)}"function"==typeof SuppressedError&&SuppressedError,function(){let n=!1,t="default";function o(i){n=!0,window.Notification.permission=i,n=!1}window.Notification=function(n,t){const o=t||{};!async function(n){"object"==typeof n&&Object.freeze(n),await i("plugin:notification|notify",{options:"string"==typeof n?{title:n}:n})}(Object.assign(o,{title:n}))},window.Notification.requestPermission=async function(){return await i("plugin:notification|request_permission").then(i=>(o("prompt"===i||"prompt-with-rationale"===i?"default":i),i))},Object.defineProperty(window.Notification,"permission",{enumerable:!0,get:()=>t,set:i=>{if(!n)throw new Error("Readonly property");t=i}}),async function(){return"default"!==window.Notification.permission||true?await Promise.resolve("granted"===window.Notification.permission):await i("plugin:notification|is_permission_granted")}().then(function(i){o(null===i?"default":i?"granted":"denied")})}()}();';

/** A recording desktop shell: every command, and the listeners the page
 *  registers, so the run can play the shell's own events back. */
const FAKE_SHELL = `(() => {
    const shell = window.__shell = { calls: [], listeners: [] };
    window.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main', windowLabel: 'main' } },
        plugins: {},
        transformCallback(cb, once) {
            const id = Math.floor(Math.random() * 1e9);
            window['_' + id] = (r) => { if (once) delete window['_' + id]; return cb && cb(r); };
            return id;
        },
        unregisterCallback(id) { delete window['_' + id]; },
        async invoke(cmd, args) {
            shell.calls.push({ cmd, args: args === undefined ? undefined : JSON.parse(JSON.stringify(args)) });
            if (cmd === 'plugin:event|listen') {
                const id = Math.floor(Math.random() * 1e9);
                shell.listeners.push({ id, event: args.event, handler: args.handler });
                return id;
            }
            if (cmd === 'plugin:notification|is_permission_granted') return true;
            if (cmd === 'plugin:notification|request_permission') return 'granted';
            return null;
        },
    };
    shell.emit = (event, payload) => {
        let heard = 0;
        for (const l of shell.listeners) {
            const cb = l.event === event && window['_' + l.handler];
            if (cb) { cb({ event, id: l.id, payload }); heard++; }
        }
        return heard;
    };
})();`;

/** The browser's own Notification, recorded: what was asked for, and what
 *  Chromium then did with each one (show, error, close). */
const RECORD_NOTIFICATIONS = `(() => {
    const Real = window.Notification;
    const log = window.__notes = [];
    class Recorded extends Real {
        constructor(title, options = {}) {
            const entry = { title, body: options.body, tag: options.tag, renotify: options.renotify === true, silent: options.silent === true, shown: false, errored: false, closed: false, threw: null };
            log.push(entry);
            try { super(title, options); } catch (e) { entry.threw = String(e); throw e; }
            this.addEventListener('show', () => { entry.shown = true; });
            this.addEventListener('error', () => { entry.errored = true; });
            this.addEventListener('close', () => { entry.closed = true; });
        }
    }
    window.Notification = Recorded;
})();`;

/** The page's clock, so a minute's lull takes no minute. */
const CLOCK = `(() => {
    const realNow = Date.now.bind(Date);
    let offset = 0;
    Date.now = () => realNow() + offset;
    window.__advance = (ms) => { offset += ms; };
    // Away from the window, as with a game in front of it.
    Document.prototype.hasFocus = () => false;
})();`;

/** The conversation, in the shapes Chat.tsx sends: #general busy with three
 *  people, a DM exchange, a few in #random, a lull, #general again. Every
 *  4 s, as a chat goes. The 0.9.860 module ignores `group`. */
async function playConversation(page) {
    return page.evaluate(async () => {
        const N = window.Notify;
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const chan = (author, id, channel, where) => N.notifyNewMessage({
            title: `${author} sent a message`, isOwn: false, isMuted: false,
            notifyKey: 'chan:s1', nav: 'server:s1',
            group: { key: `chan:s1:${channel}`, kind: 'channel', where, author, messageId: id },
        });
        const dm = (id) => N.notifyNewMessage({
            title: 'dave sent you a message', isOwn: false, isMuted: false,
            notifyKey: 'dm:c1', nav: 'dm:c1',
            group: { key: 'dm:c1', kind: 'dm', where: 'dave', author: 'dave', messageId: id },
        });
        let messages = 0;
        const people = ['alice', 'bob', 'carol'];
        for (let i = 0; i < 18; i++) {
            chan(people[i % 3], `g${i}`, 7, '#general · Lads'); messages++;
            if (i % 3 === 1) { dm(`d${i}`); messages++; }
            if (i % 6 === 5) { chan('erin', `r${i}`, 8, '#random · Lads'); messages++; }
            window.__advance(4_000);
            await sleep(5);
        }
        // A lull, then #general starts again: the same notification pops again.
        window.__advance(90_000);
        chan('alice', 'g-after', 7, '#general · Lads'); messages++;
        await sleep(200);
        return messages;
    });
}

/** Two tasks come due, then the shell reports a click on the reminder's
 *  toast. What the shell was asked for, and what the page did. */
async function playReminder(page) {
    return page.evaluate(async () => {
        const opened = [];
        window.addEventListener('sovereign:open-reminders', e => opened.push(e.detail ?? null));
        const before = window.__shell.calls.length;
        window.Notify.notifyTasksDue(2, [{ id: 5, mark: 'a' }, { id: 6, mark: 'b' }]);
        await new Promise(r => setTimeout(r, 150));
        const mine = window.__shell.calls.slice(before);
        const shows = mine.filter(c => c.cmd === 'toast_show').map(c => c.args);
        const plugin = mine.find(c => c.cmd === 'plugin:notification|notify');
        const heard = window.__shell.emit('toast-activated', 'tasks-due');
        await new Promise(r => setTimeout(r, 100));
        return { shows, viaPlugin: plugin ? plugin.args.options : null, heard, opened, last: window.__shell.calls.at(-1) };
    });
}

let pass = 0, fail = 0;
const ck = (cond, label, extra = '') => {
    if (cond) { pass++; console.log('PASS', label, extra); }
    else { fail++; console.log('FAIL', label, extra); }
};

const CHANNEL = process.env.CHANNEL || 'chromium';
const browser = await chromium.launch({
    headless: true,
    ...(CHANNEL === 'bundled' ? {} : { channel: CHANNEL }),
    args: ['--mute-audio', '--disable-features=NativeNotifications,SystemNotifications'],
});
const ORIGIN = 'http://127.0.0.1:9/';

async function openPage({ module, shell }) {
    const context = await browser.newContext();
    await context.grantPermissions(['notifications'], { origin: ORIGIN });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    // A real origin (the modules read localStorage and Notification needs a
    // secure-enough context); nothing reaches the network.
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset=utf-8><title>notify</title><body>rig</body>' }));
    await page.addInitScript(CLOCK);
    if (shell) {
        await page.addInitScript(FAKE_SHELL);
        await page.addInitScript(NOTIFICATION_PLUGIN_INIT);
    } else {
        await page.addInitScript(RECORD_NOTIFICATIONS);
    }
    await page.goto(ORIGIN);
    await page.addScriptTag({ content: module });
    // Let the module's start-up (the click listener) settle.
    await page.waitForTimeout(100);
    return { page, context, errors };
}

/** What the notification layer holds after a run, by the documented rules. */
function judgeShell(calls) {
    const centre = new Map();
    let popups = 0, untagged = 0;
    for (const { cmd, args } of calls) {
        if (cmd === 'toast_show') {
            centre.set(args.key, args);
            if (args.popup) popups++;
        } else if (cmd === 'toast_clear') centre.delete(args.key);
        else if (cmd === 'toast_clear_all') centre.clear();
        else if (cmd === 'plugin:notification|notify') {
            // The plugin's toast: no tag reaches Windows (toasts.rs).
            centre.set(`untagged#${untagged++}`, args.options);
            popups++;
        }
    }
    return { centre, popups };
}

function judgeWeb(notes) {
    const live = new Map();
    let popups = 0;
    for (const n of notes) {
        if (n.threw) continue;
        if (!live.has(n.tag) || n.renotify) popups++;
        live.set(n.tag, n);
    }
    return { live, popups };
}

const CONVERSATIONS = 3; // #general, the DM, #random
// The pop-ups the rules allow (api/notifyGroups.ts): #general's first and
// again after the lull; the DM's first and again a minute later (a DM pops at
// most once a minute while it goes on: its lines are 12 s apart); #random's
// first. Every other message only updated its conversation's notification.
const BURSTS = 5;

// ---- the desktop app ---------------------------------------------------------

for (const [name, module] of [['now', NOW], ['0.9.860 (control)', AT_860]]) {
    const { page, context, errors } = await openPage({ module, shell: true });
    const sent = await playConversation(page);
    const calls = await page.evaluate(() => window.__shell.calls);
    const notifyCalls = calls.filter(c => c.cmd === 'toast_show' || c.cmd === 'plugin:notification|notify');
    const { centre, popups } = judgeShell(calls);
    console.log(`\n[desktop, ${name}] ${sent} messages -> ${notifyCalls.length} notification commands, ${centre.size} in the notification centre, ${popups} pop-ups`);
    const isNow = name === 'now';
    const onePerConversation = centre.size === CONVERSATIONS && popups === BURSTS;
    if (isNow) {
        ck(onePerConversation, 'desktop: one toast per conversation, popping once per burst', `(${centre.size} entries, ${popups} pop-ups)`);
        ck(calls.every(c => c.cmd !== 'plugin:notification|notify'), 'desktop: nothing went through the plugin, which cannot replace');
        const keys = new Set(calls.filter(c => c.cmd === 'toast_show').map(c => c.args.key));
        ck(keys.size === CONVERSATIONS && keys.has('chan:s1:7') && keys.has('dm:c1') && keys.has('chan:s1:8'), 'desktop: one key per conversation', [...keys].join(' '));
        const general = centre.get('chan:s1:7');
        ck(general && general.title === '#general · Lads' && /^alice and 2 others: 19 new messages$/.test(general.body),
            'desktop: #general says who and how many, no message text', general && `${general.title} / ${general.body}`);
        const dm = centre.get('dm:c1');
        ck(dm && dm.title === 'dave' && dm.body === '6 new messages', 'desktop: the DM keeps count', dm && `${dm.title} / ${dm.body}`);
        // The order the shell heard them in is the order they were made: the
        // quiet updates never overtook their pop-up.
        const generalShows = calls.filter(c => c.cmd === 'toast_show' && c.args.key === 'chan:s1:7').map(c => c.args.body);
        const counts = generalShows.map(b => Number((b.match(/(\d+) new messages/) || [0, 1])[1]));
        ck(counts.every((n, i) => i === 0 || n > counts[i - 1]), 'desktop: every update reached the shell in order', counts.join(','));

        // A click: the shell's own event, through the real event plumbing.
        await page.evaluate(() => { window.__nav = []; window.addEventListener('sovereign-navigate', () => window.__nav.push(window.Notify.consumePendingNav())); });
        const heard = await page.evaluate(() => window.__shell.emit('toast-activated', 'dm:c1'));
        await page.waitForTimeout(100);
        const after = await page.evaluate(() => ({ nav: window.__nav, last: window.__shell.calls.at(-1) }));
        ck(heard === 1 && after.nav[0] === 'dm:c1', 'desktop: a click on the DM toast opens that DM', JSON.stringify(after.nav));
        ck(after.last && after.last.cmd === 'toast_clear' && after.last.args.key === 'dm:c1', 'desktop: and takes it out of the notification centre');
        // Reading #general in the app.
        await page.evaluate(() => window.Notify.seeConversation('chan:s1:7'));
        await page.waitForTimeout(100);
        const cleared = await page.evaluate(() => window.__shell.calls.at(-1));
        ck(cleared.cmd === 'toast_clear' && cleared.args.key === 'chan:s1:7', 'desktop: reading a conversation takes its toast away');
        ck(calls.filter(c => c.cmd === 'toast_show').every(c => c.args.sound === false), 'desktop: every message toast is silent (the app plays its own sound)');
    }

    // A task reminder, then a click on it: the shell's own event, through
    // the real event plumbing.
    const reminder = await playReminder(page);
    if (isNow) {
        ck(reminder.shows.length === 1 && reminder.shows[0].sound === true && reminder.shows[0].popup === true
            && reminder.shows[0].title === 'Púca Tasks' && reminder.shows[0].body === '2 tasks are due',
        "desktop: a task reminder's toast asks for Windows' default sound", JSON.stringify(reminder.shows));
        ck(!reminder.viaPlugin, 'desktop: and not through the plugin, whose toasts are silent');
        ck(reminder.heard === 1 && JSON.stringify(reminder.opened) === JSON.stringify([{ ids: [5, 6] }]),
            'desktop: a click on the reminder opens Reminders with the due ids', JSON.stringify(reminder.opened));
        ck(reminder.last && reminder.last.cmd === 'toast_clear' && reminder.last.args.key === 'tasks-due', 'desktop: and takes the reminder out of the notification centre');
        ck(errors.length === 0, 'desktop: no page error', errors.join(' | '));
    } else {
        ck(!onePerConversation && popups === sent && centre.size === sent,
            'NEGATIVE CONTROL desktop: 0.9.860 raised one untagged toast per message, so it fails', `(${centre.size} entries, ${popups} pop-ups for ${sent} messages)`);
        const silent = reminder.viaPlugin && !('sound' in reminder.viaPlugin);
        ck(silent && reminder.opened.length === 0,
            "NEGATIVE CONTROL desktop: 0.9.860's reminder went through the plugin with no sound, and a click opened nothing, so it fails",
            `(${JSON.stringify(reminder.viaPlugin)}, ${reminder.heard} listeners, opened ${JSON.stringify(reminder.opened)})`);
    }
    await context.close();
}

// ---- a click on a reminder left from before a reload --------------------------

for (const [name, module] of [['now', NOW], ['0.9.860 (control)', AT_860]]) {
    // A fresh page is the reload: no notification shown yet, no click action
    // kept, only the listener the module registers as it loads.
    const { page, context, errors } = await openPage({ module, shell: true });
    const nav = await page.evaluate(async () => {
        const got = [];
        window.addEventListener('sovereign-navigate', () => got.push(window.Notify.consumePendingNav()));
        const heard = window.__shell.emit('toast-activated', 'tasks-due');
        await new Promise(r => setTimeout(r, 50));
        return { heard, got };
    });
    if (name === 'now') {
        ck(nav.heard === 1 && JSON.stringify(nav.got) === JSON.stringify(['reminders']),
            "desktop: after a reload, a click on the reminder goes to the Reminders tab ('reminders')", JSON.stringify(nav));
        ck(errors.length === 0, 'desktop reload: no page error', errors.join(' | '));
    } else {
        ck(nav.got.length === 0, 'NEGATIVE CONTROL desktop reload: 0.9.860 opened nothing, so it fails', JSON.stringify(nav));
    }
    await context.close();
}

// ---- the web app ---------------------------------------------------------------

for (const [name, module] of [['now', NOW], ['0.9.860 (control)', AT_860]]) {
    const { page, context, errors } = await openPage({ module, shell: false });
    const sent = await playConversation(page);
    await page.waitForTimeout(300);
    const notes = await page.evaluate(() => window.__notes);
    const { live, popups } = judgeWeb(notes);
    console.log(`\n[web, ${name}] ${sent} messages -> ${notes.length} Notifications made, ${live.size} tags, ${popups} pop-ups`);
    const isNow = name === 'now';
    if (isNow) {
        ck(notes.every(n => !n.threw), 'web: Chromium took every option set (tag, renotify, silent)', notes.find(n => n.threw)?.threw ?? '');
        ck(notes.every(n => n.shown && !n.errored), 'web: every one really showed (its show event fired)', `${notes.filter(n => n.shown).length}/${notes.length}`);
        ck(live.size === CONVERSATIONS && popups === BURSTS, 'web: one notification per conversation, popping once per burst', `(${live.size} tags, ${popups} pop-ups)`);
        ck(notes.every(n => n.silent), 'web: all silent (the app plays its own sound)');
        ck(await page.evaluate(() => 'renotify' in Notification.prototype), 'web: Chromium has renotify on Notification.prototype, so it takes the renotify path');
        ck(notes.filter(n => n.renotify).length === BURSTS, 'web: renotify only on the pops');
        // Reading #general closes the one Chromium holds for it.
        await page.evaluate(() => window.Notify.seeConversation('chan:s1:7'));
        await page.waitForTimeout(300);
        const closed = await page.evaluate(() => window.__notes.filter(n => n.tag === 'chan:s1:7').at(-1).closed);
        ck(closed, 'web: reading the conversation closed its notification (close event)');
        ck(errors.length === 0, 'web: no page error', errors.join(' | '));
    } else {
        const tags = new Set(notes.map(n => n.tag));
        ck(!(live.size === CONVERSATIONS && popups === BURSTS) && notes.length === sent && tags.size > CONVERSATIONS,
            'NEGATIVE CONTROL web: 0.9.860 made one per message, tagged by title (one per author), so it fails',
            `(${notes.length} made, ${tags.size} tags: ${[...tags].join(' | ')})`);
    }
    await context.close();
}

await browser.close();

// ---- browsers with no renotify -------------------------------------------------
// The web path keeps a quiet update off the screen where a replacement would
// pop (desktopNotify.ts, browserRenotifies; vitest models what follows). Firefox
// and WebKit are asked only whether `renotify` is on Notification.prototype, in
// a child process: this file grants notifications to Chromium, and
// scripts/check-e2e-muted.mjs allows no Firefox or WebKit launch beside that.
{
    const probe = join(here, 'notify-renotify-probe.mjs');
    const r = spawnSync(process.execPath, [probe], { encoding: 'utf8', env: process.env, timeout: 180_000 });
    process.stdout.write(r.stdout || '');
    if (r.stderr) process.stderr.write(r.stderr);
    ck(r.status === 0, 'Firefox and WebKit: no renotify on Notification.prototype (notify-renotify-probe.mjs)', `(exit ${r.status}${r.error ? ', ' + r.error.message : ''})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
