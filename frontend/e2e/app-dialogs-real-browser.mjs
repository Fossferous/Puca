// The desktop app's questions (components/AppDialogs.tsx) with REAL keys, a REAL mouse and
// a real top layer, under a fake Tauri shell.
//
// WHY THIS EXISTS. On the desktop a question is in the page, because a native dialog stops
// the page's JavaScript, and the release that closes a push-to-talk microphone is page
// JavaScript (api/appDialogs.ts has the whole story). That gives up what a browser did for
// nothing, and jsdom, which turns no key into a click and has no top layer, can show none
// of it:
//  - Enter in a field whose keydown handler asks (TaskTree's commit) is a keydown and then
//    a keypress, and the keypress goes to whatever has the focus by then, which is OK: the
//    question would answer itself yes, with nobody seeing it;
//  - the page's own listeners hear what a native dialog kept from them: Cancel on "Discard
//    this note?" is a press outside QuickAdd's root, which saves and closes the composer;
//  - a question has to be over everything, a fullscreen element included, with no list of
//    the app's z-indexes to keep in step;
//  - a message of several lines needs a field that can hold them: Enter there is a new line
//    until something says otherwise, and what an IME does with Enter is the IME's.
//
// It bundles the REAL AppDialogs, api/appDialogs, api/hotkeys and theme.css (esbuild). Each
// guard has a control: this browser does deliver that keypress to a newly focused button,
// the outside-press listener does fire with no question open, a native confirm does stop
// the page, a z-index does not get over a fullscreen element. And the NEGATIVE CONTROLS,
// which must fail the same check the real path passes: the old plugin's window.confirm,
// run verbatim, and askConfirm with its await left off.
//
// SILENT and headless: no media at all. Nothing is ever fetched from outside.
//
//   cd frontend && node e2e/app-dialogs-real-browser.mjs [outdir]
//
// No server and no build needed. With an outdir, one screenshot per theme.
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = process.argv[2] ?? null;
if (outDir) mkdirSync(outDir, { recursive: true });

/** A message of several lines, as Edit hands it to the question. */
const LINES = 'first line\nsecond line\n```\nfn main() {}\n```';

const entry = `
import './styles/theme.css';
import { createRoot } from 'react-dom/client';
import { AppDialogs } from './components/AppDialogs';
import { askConfirm, askText, leaveNotice } from './api/appDialogs';
import { handleNativeHotkeyPayload, registerHold, registerPress, setNativeFeedStateForTest } from './api/hotkeys';
const log = window.__log = { answers: [], outside: 0, shortcut: 0, ticks: 0, destroyed: 0, plainClicked: 0, mic: false, muteToggles: 0 };
setInterval(() => { log.ticks++; }, 10);
// The real hold and press, as VoicePanel registers them. Holding V opens the microphone.
const bind = (keyCode, label) => () => ({ keyCode, ctrl: false, alt: false, shift: false, label });
registerHold('voice.ptt', bind(86, 'V'), { onDown: () => { log.mic = true; }, onUp: () => { log.mic = false; } });
registerPress('voice.mute', bind(77, 'M'), () => { log.muteToggles++; });
window.__nativeFeed = () => setNativeFeedStateForTest(true, ['voice.ptt']);
window.__nativeKey = down => handleNativeHotkeyPayload({ keyCode: 86, ctrlKey: false, altKey: false, shiftKey: false, down });
// What useNotesShortcuts is: behind a question, none of these keys are for it.
window.addEventListener('keydown', () => { log.shortcut++; });
// What the page was told about a key, ahead of everything: is this rig showing what it says?
window.addEventListener('keydown', e => { log.lastKey = { key: e.key, isComposing: e.isComposing, keyCode: e.keyCode }; }, true);
// What QuickAdd's outside press is.
document.addEventListener('pointerdown', e => {
    if (!document.getElementById('composer').contains(e.target)) log.outside++;
});
window.__ask = message => { void askConfirm(message).then(a => log.answers.push(a)); };
window.__askText = (message, first) => { void askText(message, first).then(a => log.answers.push(a)); };
window.__notice = leaveNotice;
// A destructive handler, as it is now, and the two ways it has been or could be wrong.
window.__site = async () => { if (!await askConfirm('Disband this server?')) return; log.destroyed++; };
window.__oldSite = () => { if (!window.confirm('Disband this server?')) return; log.destroyed++; };
window.__unawaitedSite = () => { if (!askConfirm('Disband this server?')) return; log.destroyed++; };
function App() {
    return (
        <div id="composer" style={{ padding: 16, boxSizing: 'border-box', maxWidth: '100%' }}>
            <input id="field" onKeyDown={e => { if (e.key === 'Enter') window.__ask('Turn it into a heading?'); }} />
            <input id="edit-field" onKeyDown={e => { if (e.key === 'Enter') window.__askText('Edit message:', ${JSON.stringify(LINES)}); }} />
            <button id="edit" onClick={() => window.__askText('Edit message:', ${JSON.stringify(LINES)})}>Edit</button>
            <input id="plain-field" onKeyDown={e => { if (e.key === 'Enter') document.getElementById('plain-button').focus(); }} />
            <button id="plain-button" onClick={() => { log.plainClicked++; }}>plain</button>
            <button id="delete" onClick={() => void window.__site()}>Delete</button>
            <button id="go-fullscreen" onClick={() => document.getElementById('stage').requestFullscreen()}>Fullscreen</button>
            <div id="stage" style={{ width: 200, height: 100, background: '#123' }}>the stage</div>
            <div id="ordinary-top" style={{ position: 'fixed', inset: 0, zIndex: 2147483000, pointerEvents: 'auto', background: 'transparent', display: 'none' }} />
        </div>
    );
}
createRoot(document.getElementById('root')).render(<><AppDialogs /><App /></>);
`;
const bundle = await build({
    stdin: { contents: entry, resolveDir: join(here, '..', 'src'), loader: 'tsx', sourcefile: 'entry.tsx' },
    bundle: true,
    write: false,
    outdir: 'out',
    format: 'iife',
    platform: 'browser',
    jsx: 'automatic',
    loader: { '.png': 'dataurl', '.svg': 'dataurl', '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl', '.wasm': 'dataurl' },
    define: {
        'process.env.NODE_ENV': '"development"',
        'import.meta.env': '{"DEV":false,"PROD":true,"MODE":"test"}',
        __APP_VERSION__: '"0.0.0"',
        __RC_ENABLED__: 'true',
    },
    logLevel: 'warning',
});
const appJs = bundle.outputFiles.find(f => f.path.endsWith('.js')).text;
const appCss = bundle.outputFiles.find(f => f.path.endsWith('.css')).text;

// The plugin's own script, verbatim, from where the test that explains it keeps it.
const pluginScript = readFileSync(join(here, '..', 'src', 'tests', 'desktopScriptDialogs.test.ts'), 'utf8')
    .match(/const PLUGIN_INIT_SCRIPT = '(.*)';/)?.[1];
if (!pluginScript) throw new Error('the plugin script is not where this reads it from');

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
    if (ok) pass++; else fail++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = await chromium.launch({ headless: true, args: ['--mute-audio'] });
async function open(viewport = { width: 1280, height: 800 }, { plugin = false, touch = false } = {}) {
    const context = await browser.newContext({ viewport, hasTouch: touch, isMobile: touch });
    const page = await context.newPage();
    // The shell, as api/platform.ts asks about it. Nothing here needs an answer from it.
    await page.addInitScript(() => { window.__TAURI_INTERNALS__ = { invoke: async () => undefined }; });
    if (plugin) await page.addInitScript(pluginScript);
    page.on('pageerror', e => check('no uncaught page error', false, e.message.slice(0, 200)));
    // A real origin (the app's modules read localStorage), and nothing on the network.
    await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>' });
        if (url.pathname === '/app.js') return route.fulfill({ contentType: 'text/javascript', body: appJs });
        if (url.pathname === '/app.css') return route.fulfill({ contentType: 'text/css', body: appCss });
        return route.abort();
    });
    await page.goto('http://app.test/');
    await page.waitForSelector('#composer');
    return { page, close: () => context.close() };
}
const log = page => page.evaluate(() => window.__log);
const questionOpen = page => page.locator('dialog.app-question').count().then(n => n === 1);
const settle = page => page.waitForTimeout(150);
/** Is this element on the screen, and is it (or what is drawn inside it) what is hit? */
const hitsItself = (page, selector) => page.evaluate(sel => {
    const el = document.querySelector(sel);
    const r = el.getBoundingClientRect();
    const onScreen = r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
    return onScreen && el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
}, selector);
/** Does this handler do nothing until someone has answered? */
async function holdsUntilAnswered(page, site) {
    const before = (await log(page)).destroyed;
    await page.evaluate(s => { void window[s](); }, site);
    await page.waitForTimeout(250);
    return (await log(page)).destroyed === before;
}

{
    console.log('NEGATIVE CONTROLS: what must fail the check the real path passes');
    {
        const { page, close } = await open({ width: 1280, height: 800 }, { plugin: true });
        check('the plugin\'s script is on this page: window.confirm answers with a Promise',
            await page.evaluate(() => window.confirm('x') instanceof Promise));
        check('the old plugin\'s confirm FAILS "nothing happens until OK": it went ahead, unasked',
            await holdsUntilAnswered(page, '__oldSite') === false, `destroyed ${(await log(page)).destroyed}`);
        check('and showed no question at all', !await questionOpen(page));
        await close();
    }
    {
        const { page, close } = await open();
        check('askConfirm with its await left off FAILS it too', await holdsUntilAnswered(page, '__unawaitedSite') === false);
        await close();
    }
    {
        const { page, close } = await open();
        check('the real path passes it', await holdsUntilAnswered(page, '__site') === true);
        await close();
    }
}

{
    console.log('CONTROLS: what the guards guard against is real in this browser');
    const { page, close } = await open();
    await page.focus('#plain-field');
    await page.keyboard.press('Enter');
    await settle(page);
    check('an Enter\'s keypress reaches a button focused during its keydown, and clicks it',
        (await log(page)).plainClicked === 1, 'or this rig could not see a question answering itself');
    await page.mouse.click(1200, 700);
    check('a press off the composer fires its outside-press listener', (await log(page)).outside === 1);
    const before = (await log(page)).shortcut;
    await page.keyboard.press('x');
    check('with no question open the page\'s key listeners hear a key', (await log(page)).shortcut === before + 1);

    // A native dialog, and a push-to-talk let go behind it.
    await page.evaluate(() => { window.__nativeFeed(); window.__nativeKey(true); });
    check('the push-to-talk is held: the microphone is open', (await log(page)).mic === true);
    const shown = new Promise(resolve => page.once('dialog', resolve));
    const native = page.evaluate(() => window.confirm('native')).catch(() => {});
    const dialog = await shown;
    const release = page.evaluate(() => { window.__nativeKey(false); return window.__log.mic; });
    const during = await Promise.race([release, sleep(500).then(() => 'blocked')]);
    check('behind a NATIVE dialog the release cannot run: the microphone stays open', during === 'blocked', String(during));
    await dialog.accept();
    await native;
    await release;
    check('until it is answered', (await log(page)).mic === false);
    await close();
}

{
    console.log('the page goes on running behind a question');
    const { page, close } = await open();
    await page.evaluate(() => { window.__nativeFeed(); window.__nativeKey(true); });
    await page.evaluate(() => window.__ask('Kick them?'));
    await page.waitForSelector('dialog.app-question');
    const a = (await log(page)).ticks;
    await page.waitForTimeout(400);
    const b = (await log(page)).ticks;
    check('a page timer keeps ticking', b - a > 10, `${b - a} ticks in 400 ms`);
    const closed = await page.evaluate(() => { window.__nativeKey(false); return window.__log.mic; });
    check('a released push-to-talk from the native feed closes the microphone, the question still open',
        closed === false && await questionOpen(page));
    await page.keyboard.press('Escape');
    await close();
}
{
    const { page, close } = await open();
    await page.keyboard.down('v');
    check('the in-app push-to-talk is held', (await log(page)).mic === true);
    await page.evaluate(() => window.__ask('Kick them?'));
    await page.waitForSelector('dialog.app-question');
    await page.keyboard.up('v');
    check('a real key-up reaches hotkeys.ts behind the question, and closes it', (await log(page)).mic === false && await questionOpen(page));
    const before = (await log(page)).muteToggles;
    await page.keyboard.press('m');
    check('a real press of a mute key still mutes', (await log(page)).muteToggles === before + 1);
    await close();
}

{
    console.log('on the screen, over everything, at 1280x800');
    const { page, close } = await open();
    await page.evaluate(() => { document.getElementById('ordinary-top').style.display = 'block'; });
    await page.evaluate(() => window.__ask('Delete it?'));
    await page.waitForSelector('dialog.app-question');
    check('OK is on the screen and is what is hit, under a 2147483000 z-index', await hitsItself(page, '.app-question-ok'));
    check('Cancel too', await hitsItself(page, '.app-question-btn:not(.app-question-ok)'));
    check('it is modal: what is behind it is inert', await page.evaluate(() => document.querySelector('dialog.app-question').matches(':modal')));
    await page.keyboard.press('Escape');
    await close();
}
{
    console.log('over an element in fullscreen');
    const { page, close } = await open();
    await page.click('#go-fullscreen');
    await page.waitForFunction(() => document.fullscreenElement?.id === 'stage', null, { timeout: 5000 });
    check('CONTROL: a 2147483000 z-index does not get over it', await page.evaluate(() => {
        const top = document.getElementById('ordinary-top');
        top.style.display = 'block';
        const hit = document.elementFromPoint(640, 400);
        top.style.display = 'none';
        return hit !== top;
    }));
    await page.evaluate(() => window.__ask('Delete it?'));
    await page.waitForSelector('dialog.app-question');
    check('the stage is still fullscreen', await page.evaluate(() => document.fullscreenElement?.id === 'stage'));
    check('OK is on the screen and is what is hit', await hitsItself(page, '.app-question-ok'));
    await page.locator('.app-question-btn', { hasText: 'Cancel' }).click();
    await settle(page);
    check('and Cancel answers it, with the stage still fullscreen',
        JSON.stringify((await log(page)).answers) === '[false]' && await page.evaluate(() => document.fullscreenElement?.id === 'stage'));
    await close();
}

{
    console.log('nothing happens until OK');
    const { page, close } = await open();
    check('the question holds the handler back', await holdsUntilAnswered(page, '__site'));
    await page.locator('.app-question-btn', { hasText: 'Cancel' }).click();
    await settle(page);
    check('Cancel refuses', (await log(page)).destroyed === 0 && !await questionOpen(page));
    await page.evaluate(() => { void window.__site(); });
    await page.waitForSelector('dialog.app-question');
    await page.keyboard.press('Escape');
    await settle(page);
    check('Escape refuses', (await log(page)).destroyed === 0 && !await questionOpen(page));
    await page.evaluate(() => { void window.__site(); });
    await page.waitForSelector('dialog.app-question');
    await page.locator('.app-question-ok').click();
    await settle(page);
    check('OK does it, once', (await log(page)).destroyed === 1 && !await questionOpen(page));

    // Two presses before an answer: both would go on to the same yes.
    await page.evaluate(() => { void window.__site(); void window.__site(); });
    await page.waitForSelector('dialog.app-question');
    await page.locator('.app-question-ok').click();
    await settle(page);
    check('a second press before the answer cannot run it twice', (await log(page)).destroyed === 2 && !await questionOpen(page), `destroyed ${(await log(page)).destroyed}`);
    await page.dblclick('#delete');
    await page.waitForSelector('dialog.app-question');
    await page.locator('.app-question-ok').click();
    await settle(page);
    check('nor can a real double click on the button', (await log(page)).destroyed === 3 && !await questionOpen(page), `destroyed ${(await log(page)).destroyed}`);
    await close();
}

{
    console.log('the Enter that asked is no answer');
    const { page, close } = await open();
    await page.focus('#field');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    check('Enter in a field whose keydown asks leaves the question open', await questionOpen(page));
    check('and unanswered', (await log(page)).answers.length === 0, JSON.stringify((await log(page)).answers));
    check('OK has the focus', await page.evaluate(() => document.activeElement?.classList.contains('app-question-ok')));
    await page.keyboard.press('Enter');
    await settle(page);
    check('a new Enter is the answer', JSON.stringify((await log(page)).answers) === '[true]', JSON.stringify((await log(page)).answers));
    check('and the focus goes back to the field', await page.evaluate(() => document.activeElement?.id === 'field'));
    await close();
}

{
    console.log('a held Enter does not answer');
    const { page, close } = await open();
    await page.focus('#delete');
    await page.keyboard.down('Enter'); // its keypress clicks Delete, which asks
    await page.waitForSelector('dialog.app-question');
    await page.keyboard.down('Enter'); // auto-repeat, onto OK
    await page.keyboard.down('Enter');
    await settle(page);
    check('a repeat of the Enter that pressed Delete does not press OK', await questionOpen(page) && (await log(page)).destroyed === 0);
    // Another key in between is a key that went down here, so it is the repeat rule
    // alone that says this Enter is still the old one.
    await page.keyboard.press('Shift');
    await page.keyboard.down('Enter');
    await settle(page);
    check('nor does one with another key tapped in between', await questionOpen(page) && (await log(page)).destroyed === 0);
    await page.keyboard.up('Enter');
    await settle(page);
    check('nor does letting go of it', await questionOpen(page) && (await log(page)).destroyed === 0);
    await page.keyboard.press('Enter');
    await settle(page);
    check('a fresh Enter does', (await log(page)).destroyed === 1);
    await close();
}

{
    console.log('the keyboard, inside a question');
    const { page, close } = await open();
    await page.evaluate(() => window.__ask('Delete it?'));
    await page.waitForSelector('dialog.app-question');
    const before = await log(page);
    await page.keyboard.press('Shift+Tab');
    check('Tab moves between its buttons', await page.evaluate(() => document.activeElement?.textContent === 'Cancel'));
    await page.keyboard.press('x');
    const after = await log(page);
    check('no key reaches what is behind the question', after.shortcut === before.shortcut, `${after.shortcut - before.shortcut} heard`);
    await page.keyboard.press('Space');
    await settle(page);
    check('Space on Cancel is no', JSON.stringify((await log(page)).answers) === '[false]', JSON.stringify((await log(page)).answers));

    await page.evaluate(() => window.__askText('Edit message:', 'first'));
    await page.waitForSelector('dialog.app-question input');
    check('a text question\'s field has the focus, its text selected',
        await page.evaluate(() => { const i = document.activeElement; return i?.tagName === 'INPUT' && i.selectionStart === 0 && i.selectionEnd === 5; }));
    await page.keyboard.type('typed words');
    check('typing reaches the field', await page.inputValue('dialog.app-question input') === 'typed words');
    await page.keyboard.press('Enter');
    await settle(page);
    check('and a new Enter answers it', (await log(page)).answers.at(-1) === 'typed words', JSON.stringify((await log(page)).answers));
    await close();
}

{
    console.log('a text of several lines');
    const { page, close } = await open();
    const FIELD = 'dialog.app-question textarea';
    const answers = async () => (await log(page)).answers;
    check('CONTROL: this browser\'s one-line field takes the line breaks out, or none of this is needed',
        await page.evaluate(v => { const i = document.createElement('input'); i.type = 'text'; i.value = v; return i.value === v.replaceAll('\n', ''); }, LINES));

    await page.evaluate(v => window.__askText('Edit message:', v), LINES);
    await page.waitForSelector(FIELD);
    check('the field holds the lines as they are', await page.inputValue(FIELD) === LINES);
    check('and has the focus, its text selected', await page.evaluate(n => {
        const f = document.activeElement;
        return f?.tagName === 'TEXTAREA' && f.selectionStart === 0 && f.selectionEnd === n;
    }, LINES.length));
    check('OK is on the screen and is what is hit', await hitsItself(page, '.app-question-ok'));
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' edited');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('third');
    const typed = `${LINES} edited\nthird`;
    check('a real edit keeps every line, and Shift+Enter is one more', await page.inputValue(FIELD) === typed, JSON.stringify(await page.inputValue(FIELD)));
    check('and no answer', await questionOpen(page) && (await answers()).length === 0);
    await page.keyboard.press('Enter');
    await settle(page);
    check('Enter answers, with the lines in the answer', (await answers()).at(-1) === typed && !await questionOpen(page), JSON.stringify((await answers()).at(-1)));

    // Held from the press that asked, as "a held Enter does not answer" is for yes and no.
    await page.focus('#edit');
    await page.keyboard.down('Enter');
    await page.waitForSelector(FIELD);
    await page.keyboard.down('Enter');
    await page.keyboard.down('Enter');
    await settle(page);
    check('a held Enter is no answer', await questionOpen(page) && (await answers()).length === 1);
    check('and types nothing over the selected text', await page.inputValue(FIELD) === LINES, JSON.stringify(await page.inputValue(FIELD)));
    await page.keyboard.up('Enter');
    await settle(page);
    check('nor is letting go of it', await questionOpen(page));
    await page.keyboard.press('Control+End');
    await page.keyboard.down('Shift');
    await page.keyboard.down('Enter');
    await page.keyboard.down('Enter');
    await page.keyboard.up('Enter');
    await page.keyboard.up('Shift');
    await settle(page);
    check('a held Shift+Enter is more lines, and no answer', await questionOpen(page) && await page.inputValue(FIELD) === `${LINES}\n\n`, JSON.stringify(await page.inputValue(FIELD)));
    await page.keyboard.press('Escape');
    await settle(page);
    check('Escape is Cancel', (await answers()).at(-1) === null && !await questionOpen(page));

    await page.focus('#edit-field');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    check('the Enter that asked is no answer', await questionOpen(page) && (await answers()).length === 2);
    check('and no new line: its keypress reached the field', await page.inputValue(FIELD) === LINES, JSON.stringify(await page.inputValue(FIELD)));

    // An IME, through the browser's own composition (a real one needs a real IME; this is
    // the state the browser is in while one is at work).
    const cdp = await page.context().newCDPSession(page);
    await page.keyboard.press('Control+End');
    await cdp.send('Input.imeSetComposition', { text: 'か', selectionStart: 1, selectionEnd: 1 });
    await page.keyboard.press('Enter');
    await settle(page);
    check('CONTROL: that Enter reached the page as a composing one, or this proves nothing', (await log(page)).lastKey.isComposing === true, JSON.stringify((await log(page)).lastKey));
    check('an Enter an IME is using is no answer', await questionOpen(page) && (await answers()).length === 2);
    await page.keyboard.press('Escape');
    await settle(page);
    check('nor is its Escape', (await log(page)).lastKey.isComposing === true && await questionOpen(page), JSON.stringify((await log(page)).lastKey));
    await cdp.send('Input.insertText', { text: 'か' });
    await settle(page);
    // WebKit's Enter that ends a composition: not composing any more, and keyCode 229.
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 229 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 229 });
    await settle(page);
    check('CONTROL: that one says 229 and not composing', JSON.stringify((await log(page)).lastKey) === '{"key":"Enter","isComposing":false,"keyCode":229}', JSON.stringify((await log(page)).lastKey));
    check('and is no answer either', await questionOpen(page) && (await answers()).length === 2);
    await page.keyboard.press('Enter');
    await settle(page);
    check('CONTROL: the same key with nothing composing answers', (await answers()).length === 3 && !await questionOpen(page), JSON.stringify(await answers()));

    await page.evaluate(() => window.__askText('Name?', 'one line'));
    await page.waitForSelector('dialog.app-question input');
    check('a question of one line stays the field it was', await page.locator(FIELD).count() === 0);
    await page.keyboard.press('Enter');
    await settle(page);
    check('and Enter answers it as a browser does', (await answers()).at(-1) === 'one line', JSON.stringify((await answers()).at(-1)));
    await close();
}

{
    console.log('a press on a notice, over a half-written note');
    const { page, close } = await open();
    await page.evaluate(() => window.__notice('Message failed to send.\n\nWhat you wrote in #general:\nthe words of it'));
    await page.waitForSelector('.app-notice');
    await page.focus('#field');
    const before = (await log(page)).outside;
    const box = sel => page.locator(sel).boundingBox();

    const words = await box('.app-notice-text');
    await page.mouse.move(words.x + 2, words.y + 6);
    await page.mouse.down();
    await page.mouse.move(words.x + words.width - 2, words.y + words.height - 4, { steps: 4 });
    await page.mouse.up();
    check('its words can be selected with a drag', await page.evaluate(() => getSelection().toString().includes('Message failed')), JSON.stringify(await page.evaluate(() => getSelection().toString().slice(0, 40))));
    check('and that is no press outside the composer', (await log(page)).outside === before, `${(await log(page)).outside - before} heard`);

    await page.focus('#field');
    await page.keyboard.type('half a no');
    const dismiss = await box('.app-notice-close');
    await page.mouse.move(dismiss.x + dismiss.width / 2, dismiss.y + dismiss.height / 2);
    await page.mouse.down();
    check('a press on its X leaves the focus in the field', await page.evaluate(() => document.activeElement?.id === 'field'), await page.evaluate(() => document.activeElement?.tagName));
    await page.mouse.up();
    await settle(page);
    check('the X dismisses it', await page.locator('.app-notice').count() === 0);
    check('and is no press outside the composer', (await log(page)).outside === before, `${(await log(page)).outside - before} heard`);
    await page.keyboard.type('te');
    check('and typing goes on where it was', await page.inputValue('#field') === 'half a note', await page.inputValue('#field'));

    // Tab still reaches it: a mouse press is all that keeps the focus away.
    await page.evaluate(() => window.__notice('Slow down.'));
    await page.waitForSelector('.app-notice');
    await page.evaluate(() => document.querySelector('.app-notice-close').focus());
    await page.keyboard.press('Enter');
    await settle(page);
    check('Enter on a focused X dismisses it too', await page.locator('.app-notice').count() === 0);

    await page.mouse.click(1200, 700);
    check('CONTROL: a press off the notice and off the composer is one', (await log(page)).outside === before + 1, `${(await log(page)).outside - before} heard`);
    await close();
}

{
    console.log('the mouse, inside a question');
    const { page, close } = await open();
    await page.evaluate(() => window.__ask('Discard this note?'));
    await page.waitForSelector('dialog.app-question');
    const outsideBefore = (await log(page)).outside;
    const cancel = await page.locator('.app-question-btn', { hasText: 'Cancel' }).boundingBox();
    await page.mouse.click(cancel.x + cancel.width / 2, cancel.y + cancel.height / 2);
    await settle(page);
    check('Cancel answers no', JSON.stringify((await log(page)).answers) === '[false]');
    check('and is no press outside the composer', (await log(page)).outside === outsideBefore, `${(await log(page)).outside - outsideBefore} heard`);

    await page.evaluate(() => window.__ask('Again?'));
    await page.waitForSelector('dialog.app-question');
    await page.mouse.click(5, 5);
    await settle(page);
    check('a press on the backdrop answers nothing', await questionOpen(page) && (await log(page)).answers.length === 1);
    check('and is no press outside the composer either', (await log(page)).outside === outsideBefore);

    const ok = await page.locator('.app-question-ok').boundingBox();
    await page.mouse.move(ok.x + ok.width / 2, ok.y + ok.height / 2);
    await page.mouse.down({ clickCount: 2 });
    await page.mouse.up({ clickCount: 2 });
    await settle(page);
    check('the second click of a double click, landing on OK, is no answer', await questionOpen(page));
    await page.mouse.down();
    await page.mouse.up();
    await settle(page);
    check('a click on OK is', (await log(page)).answers.at(-1) === true, JSON.stringify((await log(page)).answers));
    await close();
}

{
    console.log('all eight themes, with and without high contrast');
    const { page, close } = await open();
    const themes = ['dark', 'light', 'amoled', 'pink', 'purple', 'green', 'orange', 'yellow'];
    const poor = [];
    let measured = 0;
    let offScreen = 0;
    await page.evaluate(() => window.__notice('Message failed to send. Check your connection and try again.'));
    await page.evaluate(() => window.__askText('Edit message:', 'first'));
    await page.waitForSelector('dialog.app-question input');
    for (const theme of themes) {
        for (const contrast of ['normal', 'high']) {
            await page.evaluate(([t, c]) => {
                document.documentElement.setAttribute('data-theme', t);
                document.documentElement.setAttribute('data-contrast', c);
            }, [theme, contrast]);
            await page.waitForTimeout(250); // past any colour transition
            const pairs = await page.evaluate(() => {
                const parts = c => c.match(/[\d.]+/g).map(Number);
                // Translucent layers composited down to the first opaque one.
                const paint = el => {
                    const layers = [];
                    for (let e = el; e; e = e.parentElement) {
                        const [r, g, b, a = 1] = parts(getComputedStyle(e).backgroundColor);
                        if (a === 0) continue;
                        layers.push([r, g, b, a]);
                        if (a >= 1) break;
                    }
                    let [r, g, b] = layers.length && layers[layers.length - 1][3] >= 1 ? layers.pop() : [255, 255, 255];
                    for (const [lr, lg, lb, la] of layers.reverse()) {
                        r = lr * la + r * (1 - la); g = lg * la + g * (1 - la); b = lb * la + b * (1 - la);
                    }
                    return [r, g, b];
                };
                const lum = rgb => {
                    const [r, g, b] = rgb.slice(0, 3).map(v => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
                    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
                };
                const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
                const q = s => document.querySelector(s);
                const text = (name, el, need) => [name, ratio(parts(getComputedStyle(el).color), paint(el)), need];
                return [
                    text('message', q('.app-question-message'), 4.5),
                    text('field', q('.app-question-input'), 4.5),
                    text('Cancel', q('.app-question-btn:not(.app-question-ok)'), 4.5),
                    text('OK', q('.app-question-ok'), 4.5),
                    ['OK\'s border', ratio(parts(getComputedStyle(q('.app-question-ok')).borderTopColor), paint(q('.app-question'))), 3],
                    text('notice', q('.app-notice-text'), 4.5),
                    text('notice\'s Dismiss', q('.app-notice-close'), 3),
                ];
            });
            for (const [name, value, need] of pairs) {
                measured++;
                if (value < need) poor.push(`${theme}/${contrast} ${name} ${value.toFixed(2)}:1`);
            }
            if (!await hitsItself(page, '.app-question-ok')) offScreen++;
            if (outDir) await page.screenshot({ path: join(outDir, `${theme}-${contrast}.png`) });
        }
    }
    check('every text 4.5:1 and every mark 3:1, in each of 16 looks', poor.length === 0 && measured === 16 * 7, poor.join('; ') || `${measured} measured`);
    check('and OK is what is hit in each', offScreen === 0, `${offScreen} missed`);
    await close();
}

{
    console.log('at 390x844 on a touchscreen, and a notice');
    const { page, close } = await open({ width: 390, height: 844 }, { touch: true });
    check('CONTROL: this is a coarse pointer, or the 44 px below prove nothing', await page.evaluate(() => matchMedia('(pointer: coarse)').matches));
    await page.evaluate(() => window.__ask('A question long enough to need more than one line on a phone, and then some more of it.'));
    await page.waitForSelector('dialog.app-question');
    const box = await page.locator('dialog.app-question').boundingBox();
    check('the question is inside the window', box.x >= 0 && box.x + box.width <= 390 && box.y >= 0 && box.y + box.height <= 844, JSON.stringify(box));
    for (const name of ['Cancel', 'OK']) {
        const button = await page.locator('.app-question-btn', { hasText: name }).boundingBox();
        check(`${name} is a 44 px target`, button.height >= 44 && button.width >= 44, JSON.stringify(button));
    }
    await page.keyboard.press('Escape');
    await page.evaluate(n => window.__askText('Edit message:', Array.from({ length: n }, (_, i) => `line ${i}`).join('\n')), 80);
    await page.waitForSelector('dialog.app-question textarea');
    const tall = await page.locator('dialog.app-question').boundingBox();
    check('a very long message stays inside the window', tall.y >= 0 && tall.y + tall.height <= 844, JSON.stringify(tall));
    check('with OK on the screen and hit', await hitsItself(page, '.app-question-ok'));
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.__notice('Message failed to send. Check your connection and try again.'));
    await page.waitForSelector('.app-notice');
    const notice = await page.locator('.app-notice').boundingBox();
    check('a notice is inside the window', notice.x >= 0 && notice.x + notice.width <= 390, JSON.stringify(notice));
    check('and took no focus', await page.evaluate(() => !document.activeElement?.closest('.app-notice')));
    await page.waitForTimeout(6500);
    check('it outlasts every toast', await page.locator('.app-notice').count() === 1);
    check('its Dismiss is what is hit', await hitsItself(page, '.app-notice-close'));
    const dismiss = await page.locator('.app-notice-close').boundingBox();
    check('and a 44 px target', dismiss.height >= 44 && dismiss.width >= 44, JSON.stringify(dismiss));
    await page.locator('.app-notice-close').tap();
    check('and it dismisses it', await page.locator('.app-notice').count() === 0);
    await page.evaluate(() => window.__notice('Message pinned.', { brief: true }));
    await page.waitForSelector('.app-notice');
    await page.waitForTimeout(5400);
    check('a brief one goes by itself', await page.locator('.app-notice').count() === 0);
    await close();
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
