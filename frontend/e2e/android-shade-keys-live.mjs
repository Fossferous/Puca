// LIVE: keys in the Android notification while a remote-control session is
// live (api/devices/shadeKeys.ts; ShadeKeys.java, ShadeKeyReceiver.java,
// KeepAliveService.java), pressed from the REAL notification shade of a
// HEADLESS emulator, reaching the session as the right key-down and key-up.
//
// The phone is a DEBUG APK of this tree whose page is the remote-control
// stage harness (the real DeviceStage against the stand-in host,
// e2e/device-stage/fakeSession.ts) — no backend, no PC: the stand-in records
// every frame the stage sends, so nothing types on any real computer. Build it:
//
//   node node_modules/vite/bin/vite.js build --config vite.stageharness.config.ts
//   rm -rf dist && cp -r e2e-artifacts/device-stage-dist dist && npx cap sync android
//   cd android && ./gradlew assembleDebug          (JAVA_HOME = a JDK 21)
//
// THAT LEAVES THE HARNESS IN dist/ AND IN THE ANDROID PROJECT'S ASSETS. Put
// the real app back before anything else is built from this checkout:
// `npm run build && npx cap sync android`. Never ship an APK built this way.
// The stand-in declares the CONTROL keep-alive as session.ts does, so the
// real KeepAliveService puts up "Device session active".
//
// What it proves, each read back from Android (dumpsys, uiautomator) and
// from the stand-in host:
//   1. pins marked "In the notification" in the stage's editor (one stored,
//      one ticked in the real editor) are buttons on the session's
//      notification, on its silent DEFAULT channel, visible when the shade
//      is pulled down (not folded away in "Silent");
//   2. a button pressed in the shade with the app in front sends that key's
//      tap: F5 down, F5 up; the notification then says "Last sent: F5";
//   3. with the app in the BACKGROUND (Home), Ctrl+C from the shade arrives
//      as ControlLeft down, KeyC down, KeyC up, ControlLeft up — and Púca
//      stays in the background (no activity opened);
//   4. "Pause control" takes the buttons off the notification; resuming
//      puts them back;
//   5. LOCKED (a PIN set for the run, cleared after), under both lock-screen
//      settings: with all content shown the button is there and a press
//      sends nothing while the phone stays locked (Android's PIN bouncer
//      comes up instead), and once the PIN is entered Android delivers that
//      press and it goes; with sensitive content hidden the lock screen
//      shows the public copy, no button, and unlocking sends nothing;
//   6. a press when the page is no longer listening (an OTA reload in
//      flight) sends nothing and takes the buttons down; the session ending
//      takes the notification away, with no key button left anywhere in the
//      shade;
//   7. swiped away, the keys come back when Púca is opened again.
//
// NOT covered here: the activity and its WebView destroyed while the service
// lives on (Back from the root on Android 11 and older, a reclaimed activity;
// SovereignShadeKeysPlugin.handleOnDestroy). "Don't keep activities" written
// with `settings put` does not take effect (Android applies it only through
// its own developer-options call), and nothing else here destroys the activity
// without ending the process.
//
// Usage: SERIAL=emulator-5590 [APK=path] node e2e/android-shade-keys-live.mjs
// Only an emulator-NNNN serial is accepted. Silent (the emulator runs
// -no-audio; nothing here plays sound).
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('..', import.meta.url));
const SERIAL = process.env.SERIAL || '';
const APK = process.env.APK || path.join(here, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
const PKG = 'com.sovereign.app';
const CDP_PORT = Number(process.env.CDP_PORT || 9351);
const PIN = '4826';
if (!/^emulator-\d+$/.test(SERIAL)) {
    console.error('SERIAL must name an emulator (emulator-NNNN); refusing to touch any other device.');
    process.exit(2);
}
const ADB = process.env.ADB || path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk', 'platform-tools', 'adb.exe');
const adb = (...a) => execFileSync(ADB, ['-s', SERIAL, ...a], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
const sh = cmd => adb('shell', cmd).toString('utf8');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 15000, step = 300) {
    const t0 = Date.now(); let last;
    while (Date.now() - t0 < ms) { try { last = await fn(); if (last) return last; } catch { /* retry */ } await sleep(step); }
    return last;
}
let failed = 0;
const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`);
    if (!ok) failed++;
    return ok;
};

function uiNodes() {
    sh('uiautomator dump /sdcard/puca-ui.xml >/dev/null 2>&1');
    const xml = sh('cat /sdcard/puca-ui.xml');
    const nodes = [];
    for (const m of xml.matchAll(/<node [^>]*>/g)) {
        const a = k => (new RegExp(`${k}="([^"]*)"`).exec(m[0]) || [])[1] || '';
        const b = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(a('bounds'));
        if (!b) continue;
        nodes.push({ text: a('text'), desc: a('content-desc'), id: a('resource-id'), pkg: a('package'), x: (+b[1] + +b[3]) >> 1, y: (+b[2] + +b[4]) >> 1 });
    }
    return nodes;
}
/** A node in Android's own UI (the shade, the lock screen), never in the app. */
const sysNode = re => uiNodes().find(n => n.pkg !== PKG && (re.test(n.text) || re.test(n.desc)));
const tapAt = n => sh(`input tap ${n.x} ${n.y}`);

/** The app's notification 4712 as dumpsys tells it, or null. */
function ourNotification() {
    const d = sh('dumpsys notification --noredact');
    const recs = d.split(/\n(?=\s*NotificationRecord\()/);
    const rec = recs.find(r => r.includes(`pkg=${PKG}`) && /\bid=4712\b/.test(r));
    if (!rec) return null;
    const actions = [...rec.matchAll(/\[\d+\] "([^"]*)" -> PendingIntent/g)].map(m => m[1]);
    const channel = (/channel=([\w.]+)/.exec(rec) || [])[1] || '';
    const sub = (/android\.subText=\w+ \(([^)]*)\)/.exec(rec) || [])[1] || null;
    return { actions, channel, sub };
}
const topActivity = () => (/(?:topResumedActivity|mResumedActivity)[=:][^\n]*/.exec(sh('dumpsys activity activities')) || [''])[0];

let forwarded = false;
let pinSet = false;
let browser = null;
try {
    const attached = execFileSync(ADB, ['devices'], { encoding: 'utf8' });
    if (!attached.split('\n').some(l => l.trim().startsWith(SERIAL) && /\bdevice\b/.test(l))) throw new Error(`${SERIAL} is not attached`);
    console.log(`--    installing ${path.basename(APK)} on ${SERIAL}`);
    try { adb('install', '-r', APK); } catch { sh(`pm uninstall ${PKG}`); adb('install', APK); }
    sh(`pm clear ${PKG}`);
    sh(`pm grant ${PKG} android.permission.POST_NOTIFICATIONS`);
    // A PIN an interrupted run left behind would stop the lock step below.
    try { sh(`locksettings clear --old ${PIN}`); } catch { /* none set: the usual case */ }
    sh('input keyevent KEYCODE_WAKEUP');
    sh('wm dismiss-keyguard');
    sh('cmd statusbar collapse');
    sh(`am start -W -n ${PKG}/.MainActivity`);
    const pid = (await until(() => sh(`pidof ${PKG}`).trim(), 30000)) || '';
    await until(() => sh('cat /proc/net/unix').includes(`webview_devtools_remote_${pid}`), 30000);
    adb('forward', `tcp:${CDP_PORT}`, `localabstract:webview_devtools_remote_${pid}`);
    forwarded = true;
    browser = await until(() => chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`), 30000, 1000);
    /** The app's page. Found again after every reload: the WebView's
     *  DevTools target can be replaced by one. */
    const findPage = async () => {
        const p = await until(() => browser.contexts().flatMap(c => c.pages()).find(x => x.url().startsWith('https://localhost') && !x.isClosed()), 30000);
        if (!p) throw new Error('the app page did not appear');
        await until(() => p.evaluate(() => !!window.__stage && !!document.querySelector('.device-stage-surface')), 20000);
        return p;
    };
    const reload = async () => {
        try { await P.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }); } catch { /* the target went with it */ }
        await sleep(1500);
        P = await findPage();
    };
    let P = await findPage();

    // 1. One pin stored for the notification, one ticked in the real editor.
    await P.evaluate(() => localStorage.setItem('device-stage-pinned-keys', JSON.stringify([
        { id: 'f5', code: 'F5', mods: [], shade: true },
        { id: 'cc', code: 'KeyC', mods: ['ctrl'], shade: false },
        { id: 'tb', code: 'Tab', mods: ['alt'], shade: false },
    ])));
    await reload();
    await until(() => P.evaluate(() => !!document.querySelector('[data-testid="pinned-keys"]')), 20000);
    await P.click('button[title="More"]');
    await P.click('text=Pinned keys…');
    const boxes = await P.evaluate(() => [...document.querySelectorAll('.dspk-row')].map(r => !!r.querySelector('.dspk-shade input')));
    check('the editor offers "In the notification" in the app', boxes.length === 3 && boxes.every(Boolean), JSON.stringify(boxes));
    await P.locator('.dspk-row', { hasText: 'Ctrl + C' }).locator('.dspk-shade input').click();
    await P.click('text=Done');
    const n1 = await until(() => { const n = ourNotification(); return n && n.actions.length === 2 ? n : null; }, 10000);
    check('the session notification carries the two keys marked for it, in order', !!n1 && JSON.stringify(n1.actions) === JSON.stringify(['F5', 'Ctrl+C']), JSON.stringify(n1));
    check('…on the silent DEFAULT keys channel', !!n1 && n1.channel === 'sovereign_control_keys', n1?.channel);
    sh('cmd statusbar expand-notifications');
    await sleep(1200);
    const f5Btn = await until(() => sysNode(/^F5$/), 6000, 500);
    check('pulling the shade down shows the F5 button without expanding anything', !!f5Btn);

    // 2. Pressed with the app in front.
    await P.evaluate(() => { window.__stage.inputs.length = 0; });
    if (f5Btn) tapAt(f5Btn);
    const keys = () => P.evaluate(() => window.__stage.inputs.filter(f => f.t === 'key').map(f => `${f.code}${f.down ? '↓' : '↑'}`));
    const got = await until(async () => { const k = await keys(); return k.length >= 2 ? k : null; }, 6000);
    check('F5 from the shade arrives as F5 down, F5 up', JSON.stringify(got) === JSON.stringify(['F5↓', 'F5↑']), JSON.stringify(got));
    const n2 = await until(() => { const n = ourNotification(); return n?.sub ? n : null; }, 6000);
    check('…and the notification says so', n2?.sub === 'Last sent: F5', n2?.sub);
    sh('cmd statusbar collapse');

    // 3. In the background.
    sh('input keyevent KEYCODE_HOME');
    await sleep(1500);
    check('Púca is in the background', !topActivity().includes(PKG), topActivity());
    await P.evaluate(() => { window.__stage.inputs.length = 0; });
    sh('cmd statusbar expand-notifications');
    await sleep(1200);
    const ccBtn = await until(() => sysNode(/^Ctrl\+C$/), 6000, 500);
    if (ccBtn) tapAt(ccBtn);
    const got3 = await until(async () => { const k = await keys(); return k.length >= 4 ? k : null; }, 6000);
    check('Ctrl+C from the shade, app in the background: ControlLeft down, KeyC down, KeyC up, ControlLeft up', JSON.stringify(got3) === JSON.stringify(['ControlLeft↓', 'KeyC↓', 'KeyC↑', 'ControlLeft↑']), JSON.stringify(got3));
    sh('cmd statusbar collapse');
    await sleep(800);
    check('…and Púca stayed in the background (no activity was opened)', !topActivity().includes(PKG), topActivity());

    // 4. Pause control takes them off; resume puts them back.
    await P.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Home', key: 'Home', ctrlKey: true, altKey: true, bubbles: true, cancelable: true })));
    const paused = await until(() => { const n = ourNotification(); return n && n.actions.length === 0 ? n : null; }, 6000);
    check('pausing control takes the keys off the notification (the notification stays)', !!paused, JSON.stringify(ourNotification()));
    await P.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Home', key: 'Home', ctrlKey: true, altKey: true, bubbles: true, cancelable: true })));
    const resumed = await until(() => { const n = ourNotification(); return n && n.actions.length === 2 ? n : null; }, 6000);
    check('resuming puts them back', !!resumed, JSON.stringify(ourNotification()));

    // 5. Locked, under BOTH lock-screen settings: "show all notification
    // content" (the buttons can be on the lock screen, so a press there must
    // be refused) and "hide sensitive content" (the public copy: no buttons).
    // The person's own settings are put back afterwards.
    const savedPrivate = sh('settings get secure lock_screen_allow_private_notifications').trim();
    const savedShow = sh('settings get secure lock_screen_show_notifications').trim();
    sh(`locksettings set-pin ${PIN}`);
    pinSet = true;
    for (const showAll of [true, false]) {
        const what = showAll ? 'all content shown' : 'sensitive content hidden';
        sh('settings put secure lock_screen_show_notifications 1');
        sh(`settings put secure lock_screen_allow_private_notifications ${showAll ? 1 : 0}`);
        sh('input keyevent KEYCODE_SLEEP');
        await sleep(1500);
        sh('input keyevent KEYCODE_WAKEUP');
        await sleep(1500);
        await P.evaluate(() => { window.__stage.inputs.length = 0; });
        const locked = /mKeyguardShowing=true|isKeyguardShowing=true|showing=true/.test(sh('dumpsys window policy') + sh('dumpsys activity activities | grep -i keyguard'));
        check(`[${what}] the phone is locked (a PIN, the lock screen up)`, locked);
        sh('cmd statusbar expand-notifications');
        await sleep(1500);
        let lockBtn = sysNode(/^F5$/);
        if (!lockBtn) {
            // Over the lock screen the notification is drawn folded; its
            // buttons are behind Android's own Expand, which needs no unlock.
            const expand = sysNode(/^Expand$/);
            if (expand) { tapAt(expand); await sleep(1200); lockBtn = sysNode(/^F5$/); }
        }
        if (showAll) {
            check(`[${what}] the F5 button IS on the lock screen (so the press below is a real attempt)`, !!lockBtn,
                uiNodes().filter(n => n.pkg !== PKG && (n.text || n.desc)).map(n => n.text || n.desc).slice(0, 25).join(' | '));
            if (lockBtn) {
                tapAt(lockBtn);
                // Past the receiver's 2 s unlock grace: a press that reached
                // it while locked would be decided (refused) by now.
                await sleep(3500);
                check(`[${what}] pressing it on the LOCK SCREEN sends nothing while the phone stays locked`, (await keys()).length === 0, JSON.stringify(await keys()));
                const bouncer = uiNodes().find(n => n.pkg !== PKG && (/keyguard_pin_view|bouncer_primary_message_area/.test(n.id) || /^Enter PIN$/.test(n.text)));
                check(`[${what}] …Android asks for the PIN instead (its bouncer is up)`, !!bouncer, bouncer ? `${bouncer.id} ${bouncer.text}` : '');
                // The PIN, into that same bouncer: Android then delivers the
                // press, and the person who unlocked to send it gets it sent.
                sh(`input text ${PIN}`);
                sh('input keyevent KEYCODE_ENTER');
                const sent = await until(async () => { const k = await keys(); return k.length >= 2 ? k : null; }, 6000);
                check(`[${what}] …and once unlocked with the PIN, that press goes: F5 down, F5 up`, JSON.stringify(sent) === JSON.stringify(['F5↓', 'F5↑']), JSON.stringify(sent));
                check(`[${what}] the phone is unlocked now`, /deviceLocked=0/.test(sh('dumpsys trust')));
            }
        } else {
            check(`[${what}] the lock screen shows no key button (the public copy)`, !lockBtn);
            check(`[${what}] …and nothing was sent`, (await keys()).length === 0);
            // Unlock, with no press pending: nothing may arrive.
            sh('input keyevent KEYCODE_WAKEUP');
            sh('wm dismiss-keyguard');
            await sleep(800);
            sh(`input text ${PIN}`);
            sh('input keyevent KEYCODE_ENTER');
            await sleep(3000);
            check(`[${what}] unlocking sends nothing by itself`, (await keys()).length === 0, JSON.stringify(await keys()));
        }
        sh('cmd statusbar collapse');
    }
    sh(`locksettings clear --old ${PIN}`);
    pinSet = false;
    sh(`settings put secure lock_screen_allow_private_notifications ${savedPrivate === 'null' ? 1 : savedPrivate}`);
    sh(`settings put secure lock_screen_show_notifications ${savedShow === 'null' ? 1 : savedShow}`);

    // 5b. The page stops listening (a WebView that died, an OTA reload in
    // flight) while the notification still shows its keys: a press then
    // sends nothing, and takes the buttons down rather than leave buttons
    // that go nowhere.
    sh(`am start -W -n ${PKG}/.MainActivity`);
    await sleep(800);
    await until(() => { const n = ourNotification(); return n && n.actions.length === 2 ? n : null; }, 6000);
    await P.evaluate(() => window.Capacitor.Plugins.SovereignShadeKeys.removeAllListeners());
    await P.evaluate(() => { window.__stage.inputs.length = 0; });
    sh('cmd statusbar expand-notifications');
    await sleep(1200);
    const deadBtn = await until(() => sysNode(/^F5$/), 6000, 500);
    if (deadBtn) tapAt(deadBtn);
    const dropped = await until(() => { const n = ourNotification(); return n && n.actions.length === 0 ? n : null; }, 6000);
    check('with nothing listening in the page, a press sends nothing', !!deadBtn && (await keys()).length === 0, JSON.stringify(await keys()));
    check('…and the buttons come down instead of staying as buttons that go nowhere', !!dropped, JSON.stringify(ourNotification()));
    sh('cmd statusbar collapse');
    await reload();
    const relisten = await until(() => { const n = ourNotification(); return n && n.actions.length === 2 ? n : null; }, 15000);
    check('the page listening again puts them back', !!relisten, JSON.stringify(ourNotification()));

    // 6. The session ends.
    sh(`am start -W -n ${PKG}/.MainActivity`);
    await sleep(800);
    await P.evaluate(() => window.__stage.end('the other side ended the session'));
    const gone = await until(() => ourNotification() === null, 8000);
    check('the session ending takes the notification away', !!gone, JSON.stringify(ourNotification()));
    sh('cmd statusbar expand-notifications');
    await sleep(1200);
    check('…no key button is left anywhere in the shade', !sysNode(/^(F5|Ctrl\+C)$/));
    sh('cmd statusbar collapse');

    // A fresh session, so there is one to lose below.
    await reload();
    const back = await until(() => { const n = ourNotification(); return n && n.actions.length === 2 ? n : null; }, 15000);
    check('a new session brings the keys back', !!back, JSON.stringify(ourNotification()));

    // 7. Swiped away (Android 14+ lets a person dismiss even a foreground
    // service's notification): the keys come back when Púca does.
    // DevTools let go of first: an attached client keeps the page "visible"
    // through Home, so the page's return-to-foreground re-post never fires
    // (measured: attached, nothing came back in 10 s; detached, it did).
    try { await browser.close(); } catch { /* already gone */ }
    browser = null;
    sh('cmd statusbar expand-notifications');
    await sleep(1200);
    const card = sysNode(/^Device session active$/);
    if (card) sh(`input swipe ${card.x} ${card.y} ${card.x + 700} ${card.y} 250`);
    await sleep(1500);
    const afterSwipe = ourNotification();
    check('a swipe in the shade takes the notification away (Android 14+ lets it)', !!card && afterSwipe === null, afterSwipe ? JSON.stringify(afterSwipe) : (card ? '' : 'no "Device session active" card found'));
    sh('cmd statusbar collapse');
    sh('input keyevent KEYCODE_HOME');
    await sleep(1200);
    sh(`am start -W -n ${PKG}/.MainActivity`);
    const returned = await until(() => { const n = ourNotification(); return n && n.actions.length === 2 ? n : null; }, 10000);
    check('after a swipe-away, opening Púca again puts the keys back on the notification', !!returned, JSON.stringify(ourNotification()));

} catch (e) {
    console.error('ERROR', e);
    failed++;
} finally {
    if (pinSet) { try { sh(`locksettings clear --old ${PIN}`); } catch { /* best effort */ } }
    try { sh('cmd statusbar collapse'); } catch { /* gone */ }
    if (browser) { try { await browser.close(); } catch { /* gone */ } }
    if (forwarded) { try { adb('forward', '--remove', `tcp:${CDP_PORT}`); } catch { /* gone */ } }
}
console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
process.exit(failed ? 1 : 0);
