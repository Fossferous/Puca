// An embedding host's screen share through the REAL voice panel, in a real browser, against a
// throwaway backend: the window while a share is starting (docs/EMBEDDING.md, startShare; the review
// of the Steam Deck share, 2026-10-23, found a Stop in that window dropped and the share going live
// with a dead track, an empty tile on everyone's screen; components/shareStarts.ts).
//
//   APP=http://localhost:5174 API=http://127.0.0.1:3000 node e2e/host-share-start-live.mjs
//
// APP is a vite dev server of this tree (it serves /src modules, used to make the fixture), API the
// throwaway backend it talks to (VITE_API_URL). Never a real server: it signs up an account.
//
//   1. a Stop while the host is still supplying the picture: startShare answers 'stopped', nothing is
//      announced, and the picture is let go of;
//   2. a Stop while the server is answering the announcement: not live, and the announcement taken back;
//   3. the picture ending while the server answers, the way it does in production: the source closes
//      and the browser fires `ended` (the server's answer is held until it has): not live, taken back,
//      the answer says the picture ended (not 'stopped', though the end cancels the start too), and the
//      panel says why;
//   4. two starts at once: the second is refused, 'already starting';
//   5. control: a start left alone goes live, and a Stop in the very next step (before React has
//      rendered) is not lost: stopShare() is true and the share ends.
//   The Share dialog's own start, through the real dialog (review of 2026-10-24):
//   6. while it starts, its X is disabled and a host's Share is refused; left alone, it goes live;
//   7. a host's Stop while it starts: it does not go live, nothing is announced, the dialog closes;
//   8. the dialog left open while a host's share goes live: its Select Screen captures nothing over
//      that share, whose picture stays live;
//   9. a hang-up while the server answers: a quiet 'left the call', never 'the picture ended'.
//
// Silent: no microphone (joinWithoutMic), Output Volume 0, sounds off, a muted browser; the picture is a
// drawn canvas from a stand-in host, no screen is captured.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('@playwright/test');
const APP = process.env.APP || 'http://localhost:5174';
const PASS = 'Password123!pw'; // a test value for the throwaway backend only
const name = 'sharewin_' + Date.now().toString(36).slice(-6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (what, ok, extra = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${extra ? '  -- ' + String(extra).slice(0, 300) : ''}`);
    if (!ok) failures++;
};

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--mute-audio'] });
try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.addInitScript(() => {
        const k = 'sovereign_settings';
        const s = JSON.parse(localStorage.getItem(k) || '{}');
        Object.assign(s, { joinWithoutMic: true, outputVolume: 0, soundsEnabled: false, joinLeaveSound: false, voiceTTS: false, streamSound: false });
        localStorage.setItem(k, JSON.stringify(s));
        // `__onAnnounce` runs once, the moment the page announces a share (ScreenShareStart goes out):
        // what it does lands while the server is answering, whatever the server's speed.
        const send = WebSocket.prototype.send;
        WebSocket.prototype.send = function (data) {
            const r = send.call(this, data);
            if (typeof data === 'string' && data.includes('"type":"ScreenShareStart"') && window.__onAnnounce) {
                const f = window.__onAnnounce;
                window.__onAnnounce = null;
                f();
            }
            return r;
        };
        // `__holdIncoming` (a promise): what the server sends waits for it, in order, so something the
        // browser does asynchronously (a track's `ended`) lands before the page hears the answer.
        const om = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'onmessage');
        Object.defineProperty(WebSocket.prototype, 'onmessage', {
            configurable: true,
            get() { return om.get.call(this); },
            set(fn) {
                om.set.call(this, typeof fn !== 'function' ? fn : function (ev) {
                    const hold = window.__holdIncoming;
                    if (hold) hold.then(() => fn.call(this, ev)); else fn.call(this, ev);
                });
            },
        });
        // The stand-in host: a drawn picture, after `delayMs`.
        const host = { delayMs: 0, tracks: [] };
        window.__shareHost = host;
        window.__PUCA_EMBED_HOST__ = {
            apiVersion: 1,
            name: 'Share window test',
            async getDisplayMedia() {
                await new Promise((r) => setTimeout(r, host.delayMs));
                const gen = new MediaStreamTrackGenerator({ kind: 'video' });
                const writer = gen.writable.getWriter();
                const canvas = new OffscreenCanvas(640, 400);
                const x = canvas.getContext('2d');
                let n = 0;
                const frame = () => {
                    x.fillStyle = `hsl(${(n++ * 15) % 360} 60% 40%)`;
                    x.fillRect(0, 0, 640, 400);
                    return new VideoFrame(canvas, { timestamp: Math.round(performance.now() * 1000) });
                };
                writer.write(frame()).catch(() => {});
                const timer = setInterval(() => { if (gen.readyState === 'live') writer.write(frame()).catch(() => {}); else clearInterval(timer); }, 100);
                host.tracks.push({ gen, writer, timer });
                return new MediaStream([gen]);
            },
        };
    });
    const page = await ctx.newPage();
    const frames = [];
    page.on('websocket', (ws) => ws.on('framesent', (f) => {
        const d = String(f.payload || '');
        const m = /"type":"(ScreenShareStart|ScreenShareStop)"/.exec(d);
        if (m) frames.push(m[1]);
    }));
    await page.goto(APP + '/login', { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.getByPlaceholder('Enter username').waitFor({ timeout: 90000 });
    await page.locator('.toggle-mode').click();
    await page.getByPlaceholder('Enter username').fill(name);
    await page.getByPlaceholder('Choose a password (min 8 characters)').fill(PASS);
    await page.locator('button.login-button[type="submit"]').click();
    await page.waitForURL('**/chat', { timeout: 90000 });
    // A new account is shown its recovery code, then the welcome, over the page a while after sign-up:
    // both dealt with as a person would, until nothing has covered the page for a moment.
    const covers = '.recovery-modal-overlay, .welcome-popup-overlay';
    const uncover = async () => {
        for (let i = 0, clear = 0; i < 60 && clear < 4; i++) {
            if (!(await page.locator(covers).count())) { clear++; await sleep(250); continue; }
            clear = 0;
            if (await page.locator('.recovery-confirm input').count()) {
                await page.locator('.recovery-confirm input').check().catch(() => {});
                await page.locator('.recovery-done-btn').click().catch(() => {});
            } else if (await page.getByRole('button', { name: 'I already saved it' }).count()) {
                await page.getByRole('button', { name: 'I already saved it' }).click().catch(() => {});
            } else if (await page.locator('.welcome-popup-close').count()) {
                await page.locator('.welcome-popup-close').first().click().catch(() => {});
            }
            await sleep(250);
        }
        const later = page.getByRole('button', { name: 'Later', exact: true });
        if (await later.count()) await later.first().click().catch(() => {});
        return (await page.locator(covers).count()) === 0;
    };
    await sleep(1500);
    await uncover();
    const api = (mod, fn, args = []) => page.evaluate(async ({ mod, fn, args }) => (await import(mod))[fn](...args), { mod, fn, args });
    const srv = await api('/src/api/servers.ts', 'createServer', ['Share window']);
    const lounge = await api('/src/api/servers.ts', 'createChannel', [srv.id, 'Lounge', 1]);
    // The server on screen, as a person would have it: the voice panel lives in its sidebar, and the
    // dialog's cases click it. One reload, BEFORE the call (the app lists servers at start); none after.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('.server-icon[title="Share window"]').waitFor({ timeout: 60000 });
    await uncover();
    await page.locator('.server-icon[title="Share window"]').click();
    await sleep(800);
    const joined = await page.evaluate(({ s, c }) => window.pucaEmbed.joinVoice(s, c), { s: srv.id, c: lounge.id });
    let state = null;
    for (let i = 0; i < 40 && !state?.call?.connected; i++) { await sleep(250); state = await page.evaluate(() => window.pucaEmbed.getState()); }
    check('fixture: in a call, without a microphone, and the page can share', joined?.ok === true && state?.call?.connected && state.call.noMicrophone && state.features.includes('share'),
        JSON.stringify({ joined, call: state?.call && { connected: state.call.connected, noMicrophone: state.call.noMicrophone }, features: state?.features }));

    const sharing = () => page.evaluate(() => window.pucaEmbed.getState().call?.sharing ?? null);
    const settle = async () => { for (let i = 0; i < 20; i++) { if ((await sharing()) === false) return; await sleep(100); } };
    const lastTrackState = () => page.evaluate(() => window.__shareHost.tracks.at(-1)?.gen.readyState ?? null);

    // 1. A Stop while the host is still supplying the picture.
    frames.length = 0;
    const r1 = await page.evaluate(async () => {
        window.__shareHost.delayMs = 300;
        const p = window.pucaEmbed.startShare();
        await new Promise((r) => setTimeout(r, 100));
        const stopped = window.pucaEmbed.stopShare();
        return { stopped, result: await p };
    });
    await settle();
    check('1. a Stop while the host supplies the picture is taken', r1.stopped === true, JSON.stringify(r1));
    check('...the start answers stopped, and nothing went live', r1.result?.ok === false && r1.result.error === 'stopped' && (await sharing()) === false, JSON.stringify(r1.result));
    check('...nothing was announced', !frames.includes('ScreenShareStart'), JSON.stringify(frames));
    check('...and the picture was let go of', (await lastTrackState()) === 'ended');

    // 2. A Stop while the server answers the announcement.
    frames.length = 0;
    const r2 = await page.evaluate(async () => {
        window.__shareHost.delayMs = 0;
        window.__onAnnounce = () => { window.__stop2 = window.pucaEmbed.stopShare(); };
        return window.pucaEmbed.startShare();
    });
    await settle();
    check('2. a Stop while the server answers: not live', r2?.ok === false && r2.error === 'stopped' && (await sharing()) === false, JSON.stringify(r2));
    check('...the Stop was taken, not dropped', (await page.evaluate(() => window.__stop2)) === true);
    check('...and the announcement was taken back', frames.indexOf('ScreenShareStart') >= 0 && frames.indexOf('ScreenShareStop') > frames.indexOf('ScreenShareStart'), JSON.stringify(frames));

    // 3. The picture ending while the server answers, as it does in production: the source closes
    //    (the Deck's page closes its writer; a shared window closing ends its capture) and the
    //    browser fires `ended`, which also cancels the start (stopMyScreenShare).
    frames.length = 0;
    const r3 = await page.evaluate(async () => {
        window.__onAnnounce = () => {
            const t = window.__shareHost.tracks.at(-1);
            window.__endedSeen = false;
            window.__holdIncoming = Promise.race([
                new Promise((r) => t.gen.addEventListener('ended', () => { window.__endedSeen = true; r(); }, { once: true })),
                new Promise((r) => setTimeout(r, 3000)),
            ]);
            t.writer.close().catch(() => {});
        };
        try { return await window.pucaEmbed.startShare(); } finally { window.__holdIncoming = null; }
    });
    await settle();
    check('3. the source closing fires a real `ended` before the server answers', (await page.evaluate(() => window.__endedSeen)) === true);
    check('...not live, and the answer says the picture ended, not "stopped"', r3?.ok === false && r3.error === 'the picture ended before the share went live' && (await sharing()) === false, JSON.stringify(r3));
    check('...taken back', frames.indexOf('ScreenShareStop') > frames.indexOf('ScreenShareStart') && frames.includes('ScreenShareStart'), JSON.stringify(frames));
    check('...and the panel says why', (await page.locator('text=The picture ended before the stream started.').count()) > 0);

    // 4. Two starts at once.
    const r4 = await page.evaluate(async () => {
        window.__shareHost.delayMs = 200;
        const a = window.pucaEmbed.startShare();
        const b = window.pucaEmbed.startShare();
        const second = await b;
        window.pucaEmbed.stopShare();
        return { second, first: await a };
    });
    await settle();
    check('4. a second start while one runs is refused', r4.second?.ok === false && r4.second.error === 'already starting', JSON.stringify(r4));
    check('...and the first, stopped, did not go live', r4.first?.ok === false && (await sharing()) === false, JSON.stringify(r4.first));

    // 5. Control: left alone, it goes live; a Stop in the very next step is not lost.
    frames.length = 0;
    const r5 = await page.evaluate(async () => {
        window.__shareHost.delayMs = 0;
        const result = await window.pucaEmbed.startShare();
        const stoppedAtOnce = window.pucaEmbed.stopShare();
        return { result, stoppedAtOnce };
    });
    check('5. control: a start left alone goes live', r5.result?.ok === true && frames.includes('ScreenShareStart'), JSON.stringify(r5));
    check('...and a Stop straight after is taken, before React has rendered', r5.stoppedAtOnce === true, JSON.stringify(r5));
    await settle();
    check('...and the share ends', (await sharing()) === false && frames.includes('ScreenShareStop'), JSON.stringify(frames));

    // The Share dialog's own start, through the real dialog (the arrow beside Share opens it).
    check('fixture: nothing covers the voice panel', await uncover());
    const dialogOpen = () => page.locator('.stream-modal').count();
    const openDialog = async () => {
        const arrow = page.locator('.vp-share-options');
        try {
            await arrow.click({ timeout: 5000 });
        } catch (e) {
            const why = await arrow.evaluate((b) => {
                const r = b.getBoundingClientRect();
                const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
                return { box: [r.x, r.y, r.width, r.height].map(Math.round), viewport: [innerWidth, innerHeight], hit: top ? `${top.tagName}.${top.className}` : null, disabled: b.disabled };
            });
            if (process.env.OUT) await page.screenshot({ path: `${process.env.OUT}/share-arrow-covered.png` }).catch(() => {});
            throw new Error(`the Share options arrow could not be clicked: ${JSON.stringify(why)}`);
        }
        await page.getByTestId('share-go-live').waitFor({ timeout: 5000 });
    };
    const until = async (cond) => { for (let i = 0; i < 50; i++) { if (await cond()) return true; await sleep(100); } return false; };

    // 6. While the dialog's share starts.
    frames.length = 0;
    await page.evaluate(() => { window.__shareHost.delayMs = 1500; });
    await openDialog();
    await page.getByTestId('share-go-live').click();
    await sleep(300);
    const xDisabled = await page.locator('.stream-modal-close').isDisabled();
    const r6 = await page.evaluate(() => window.pucaEmbed.startShare());
    check("6. while the dialog's share starts, its X is disabled", xDisabled === true);
    check("...and a host's Share meanwhile is refused: one start at a time", r6?.ok === false && r6.error === 'already starting', JSON.stringify(r6));
    check("...left alone, the dialog's share goes live and the dialog closes",
        (await until(async () => (await sharing()) === true && (await dialogOpen()) === 0)) && frames.includes('ScreenShareStart'), JSON.stringify(frames));
    await page.evaluate(() => window.pucaEmbed.stopShare());
    await settle();

    // 7. A host's Stop while the dialog's share starts.
    frames.length = 0;
    await page.evaluate(() => { window.__shareHost.delayMs = 800; });
    await openDialog();
    await page.getByTestId('share-go-live').click();
    await sleep(200);
    const stop7 = await page.evaluate(() => window.pucaEmbed.stopShare());
    check("7. a host's Stop while the dialog's share starts is taken", stop7 === true);
    check("...the dialog closes with nothing live", await until(async () => (await dialogOpen()) === 0 && (await sharing()) === false));
    check('...nothing was announced, and its picture was let go of', !frames.includes('ScreenShareStart') && (await lastTrackState()) === 'ended', JSON.stringify(frames));

    // 8. The dialog left open while a host's share goes live.
    await page.evaluate(() => { window.__shareHost.delayMs = 0; });
    await openDialog();
    const r8 = await page.evaluate(() => window.pucaEmbed.startShare());
    const captures = await page.evaluate(() => window.__shareHost.tracks.length);
    await page.getByTestId('share-go-live').click();
    await sleep(800);
    check("8. a host's share goes live with the dialog open", r8?.ok === true && (await sharing()) === true, JSON.stringify(r8));
    check("...the dialog's Select Screen captures nothing over it", (await page.evaluate(() => window.__shareHost.tracks.length)) === captures);
    // ITS picture, not the newest one: a capture over it would make the newest a live track too.
    const hostPicture = await page.evaluate((i) => window.__shareHost.tracks[i]?.gen.readyState ?? null, captures - 1);
    check("...that share's own picture stays live, the share stays on, and the dialog closes",
        hostPicture === 'live' && (await sharing()) === true && (await dialogOpen()) === 0, JSON.stringify({ hostPicture }));
    await page.evaluate(() => window.pucaEmbed.stopShare());
    await settle();

    // 9. A hang-up while the server answers (last: it leaves the call).
    const r9 = await page.evaluate(async () => {
        window.__onAnnounce = () => { window.pucaEmbed.leaveVoice(); };
        return window.pucaEmbed.startShare();
    });
    check("9. a hang-up while the server answers: a quiet 'left the call', never 'the picture ended'", r9?.ok === false && r9.error === 'left the call', JSON.stringify(r9));

    await page.evaluate(() => window.pucaEmbed.leaveVoice()).catch(() => {});
} catch (e) {
    check('the run itself', false, e?.stack || String(e));
} finally {
    await browser.close().catch(() => {});
}
console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
