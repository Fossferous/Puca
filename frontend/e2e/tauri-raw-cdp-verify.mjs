// Full raw-CDP verifier (NO Playwright => no focus emulation => hasFocus()
// stays honest). Reloads, rejoins voice, asserts the feed, tails console.
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const targets = await (await fetch('http://localhost:9222/json')).json();
const page = targets.find(t => t.type === 'page' && t.url.includes('localhost:5173'));
if (!page) { console.error('no page target'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const call = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
});
const evaluate = async (expr) => {
    const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? ''));
    return r.result?.value;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
        return;
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
        const text = (msg.params.args || []).map(a => a.value ?? a.description ?? '').join(' ');
        if (/\[hotkeys\]|\[VoicePanel\]/.test(text)) log('C', msg.params.type, text);
    }
};
await new Promise(r => { ws.onopen = r; });
await call('Runtime.enable');
log('attached raw');

await evaluate('location.reload()').catch(() => { /* nav kills the eval */ });
await sleep(6000);
await evaluate(`document.querySelector('.voice-channel')?.click(), 'clicked'`);
log('clicked voice channel');
await sleep(9000);

const state = await evaluate(`JSON.stringify({
    voiceBtns: document.querySelectorAll('.voice-btn').length,
    feed: window.__pucaHotkeysDebug?.nativeFeedActive() ?? 'no-handle',
    hasFocus: document.hasFocus(),
})`);
log('STATE:', state);
const s = JSON.parse(state);
if (!s.voiceBtns || s.feed !== true) { log('NOT READY'); process.exit(1); }
log(`READY — honest hasFocus=${s.hasFocus}. Tailing console for 240s: press the keys.`);
await sleep(240000);
log('done');
process.exit(0);
