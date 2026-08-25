// S1 only, with the REAL picker: inject the probe, call getDisplayMedia under a
// CDP gesture, then drive the picker with pick-screen.ps1 (dump first, then pick).
//   node e2e/spike-clips/s1-manual.mjs "Screen 3"
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const PICK = process.argv[2] || 'Screen 3';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const targets = await (await fetch('http://localhost:9222/json')).json();
const page = targets.find(t => t.type === 'page' && /localhost:5173/.test(t.url));
if (!page) { console.error('no page'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const call = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { const { res, rej } = pending.get(msg.id); pending.delete(msg.id); msg.error ? rej(new Error(msg.error.message)) : res(msg.result); } else if (msg.method === 'Runtime.consoleAPICalled') { const t = (msg.params.args || []).map(a => a.value ?? a.description ?? '').join(' '); if (/clip-spike/.test(t)) console.log('  C>', t.slice(0, 400)); } };
await new Promise(r => { ws.onopen = r; });
await call('Runtime.enable');
const evaluate = async (expression, gesture = false) => { const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: gesture }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? '')); return r.result?.value; };
console.log('install:', await evaluate(fs.readFileSync(path.join(here, 'probe.js'), 'utf8')));
const psRun = (args) => new Promise(res => execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(here, 'pick-screen.ps1'), ...args], { windowsHide: true, timeout: 90000 }, (e, out, err) => res({ out: String(out || ''), err: String(err || ''), e: e ? e.message : null })));
const s1p = evaluate('window.__clipSpike.s1({levelMs: 4000})', true);
await sleep(2500);
console.log('--- picker dump ---');
const dump = await psRun(['-Dump', '-WaitSeconds', '20']);
console.log(dump.out.slice(0, 6000), dump.err.slice(0, 500), dump.e || '');
console.log('--- pick', PICK, '---');
const pick = await psRun(['-Pick', PICK, '-WaitSeconds', '20']);
console.log(pick.out.slice(0, 3000), pick.err.slice(0, 500), pick.e || '');
const r = await Promise.race([s1p, sleep(60000).then(() => ({ timeout: true }))]);
console.log('S1 result:', JSON.stringify(r).slice(0, 1500));
if (r && !r.error && !r.timeout) {
    // keep the stream: run S3 + a short S4 to see audio through the mux
    const mb = fs.readFileSync(path.join(here, '..', '..', 'node_modules', 'mediabunny', 'dist', 'bundles', 'mediabunny.mjs'), 'utf8');
    console.log('mb:', await evaluate(`window.__clipSpike.loadMediabunny(${JSON.stringify(mb)})`));
    console.log('S3:', JSON.stringify(await evaluate('window.__clipSpike.s3()')));
}
process.exit(0);
