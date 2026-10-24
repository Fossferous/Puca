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
//   3. the picture ending while the server answers: not live, taken back, and the panel says why;
//   4. two starts at once: the second is refused, 'already starting';
//   5. control: a start left alone goes live, and a Stop in the very next step (before React has
//      rendered) is not lost: stopShare() is true and the share ends.
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
                host.tracks.push({ gen, timer });
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
    await sleep(1500);
    for (let i = 0; i < 3; i++) {
        const later = page.getByRole('button', { name: 'Later', exact: true });
        if (await later.count()) await later.first().click().catch(() => {});
        if (await page.locator('.welcome-popup-close').count()) await page.locator('.welcome-popup-close').first().click().catch(() => {});
        await sleep(300);
    }
    const api = (mod, fn, args = []) => page.evaluate(async ({ mod, fn, args }) => (await import(mod))[fn](...args), { mod, fn, args });
    const srv = await api('/src/api/servers.ts', 'createServer', ['Share window']);
    const lounge = await api('/src/api/servers.ts', 'createChannel', [srv.id, 'Lounge', 1]);
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

    // 3. The picture ending while the server answers.
    frames.length = 0;
    const r3 = await page.evaluate(async () => {
        // The source gone (as a closed window's capture is): the track ends.
        window.__onAnnounce = () => window.__shareHost.tracks.at(-1).gen.stop();
        return window.pucaEmbed.startShare();
    });
    await settle();
    check('3. the picture ending while it starts: not live', r3?.ok === false && r3.error === 'the picture ended before the share went live' && (await sharing()) === false, JSON.stringify(r3));
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

    await page.evaluate(() => window.pucaEmbed.leaveVoice()).catch(() => {});
} catch (e) {
    check('the run itself', false, e?.stack || String(e));
} finally {
    await browser.close().catch(() => {});
}
console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
