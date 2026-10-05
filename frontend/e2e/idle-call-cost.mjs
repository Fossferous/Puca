// What does it cost just to SIT in a voice call?
//
// Measured 2026-09-25 on the owner's machine: in a 6-person call, not sharing
// and not watching anything, the desktop app's WebView held ~1 CPU core and
// 15-30% of the integrated GPU for hours. This rig reproduces that setting on
// a THROWAWAY stack (never a live server, never real people) and measures ONE
// client, so a change to the call UI has a before/after number:
//
//   renderer / GPU-process CPU   Chromium's own per-process cpuTime (CDP
//                                SystemInfo.getProcessInfo), in cores
//   GPU engines                  the GPU process's per-engine utilisation
//                                (Windows GPU Engine counters), by adapter
//   React commits/s              React's devtools hook (onCommitFiberRoot),
//                                which every build calls — no app changes
//                                needed, so an OLD build measures the same way
//   style recalcs / layouts /s   CDP Performance.getMetrics
//
// Setting: N clients (default 6) join one mesh voice channel with Chromium's
// fake microphone — a repeating beep, so every client's speaking ring turns
// on and off about once a second, like a lively call. SHARE=1 has client 2
// screen-share (fake capture) so the measured client shows the LIVE badge and
// the "Live Stream — Click to Watch" button without watching.
//
// The measured client runs in its OWN browser so its processes are its own.
// Everything is headless and muted: nothing opens on the desktop, nothing plays.
//
// DEEPFILTER (added 2026-10-04 for the pause-when-nobody-hears change):
//   DF=1        the measured client runs DeepFilter (the others stay on the
//               default suppressor, so only one DFN3 Worker is in the rig)
//   STATES=open,muted,alone
//               measure REPS windows in each state, in this order: `open` =
//               unmuted with the others in the call, `muted` = the measured
//               client clicks Mute, `alone` = it unmutes and every other
//               client clicks Disconnect. Default `open` (the original rig).
//   THREADS=1   also report CPU per renderer THREAD over each window (Windows
//               GetThreadTimes + the thread's own name, read-only), so the
//               DeepFilter Worker ("DedicatedWorker thread") and the audio
//               thread are separated from the rest of the renderer. Each
//               window also records the worklet's own counters (hops sent,
//               paused) from __pucaVoiceDiag(), so a number can be tied to
//               what the pipeline was doing.
// CPU TIME over a fixed window, not a % snapshot: the work a thread did does
// not depend on how busy the rest of the machine was.
//
// Prereqs: a throwaway backend (APP_API, CORS allowing APP) and Postgres (PGPORT
// / PGDB / PGPASSWORD, default postgres), and the built client served at APP
// (`PORT=… node e2e/serve-dist.mjs`).
// Usage: APP=http://127.0.0.1:5181 PGPORT=55433 PGDB=puca_rig node e2e/idle-call-cost.mjs [out.json]
//        DF=1 N=2 STATES=open,muted,alone THREADS=1 REPS=1 APP=… node e2e/idle-call-cost.mjs out.json
import { chromium } from '@playwright/test';
import { execFileSync, execFile } from 'node:child_process';
import fs from 'node:fs';

const APP = process.env.APP || 'http://127.0.0.1:5173';
const N = Number(process.env.N || 6);
const WARM_MS = Number(process.env.WARM_MS || 25_000);
const MEASURE_MS = Number(process.env.MEASURE_MS || 60_000);
const REPS = Number(process.env.REPS || 3);
const SHARE = process.env.SHARE === '1';
const CHANNEL = process.env.CHANNEL || 'msedge';
/** Pin the measured browser's GPU process to this adapter (the owner's app is
 *  pinned to the integrated GPU). `0,0x...` as --use-adapter-luid takes it. */
const ADAPTER_LUID = process.env.ADAPTER_LUID || '';
const OUT = process.argv[2] || '';
const DF = process.env.DF === '1';
const STATES = String(process.env.STATES || 'open').split(',').filter(Boolean);
const THREADS = process.env.THREADS === '1';
for (const s of STATES) if (!['open', 'muted', 'alone'].includes(s)) throw new Error(`unknown state ${s}`);
const PSQL = process.env.PSQL || 'C:/Program Files/PostgreSQL/16/bin/psql.exe';
const PASS = 'Password123!';
const stamp = Date.now().toString(36);
const psql = (sql) => execFileSync(PSQL, ['-U', 'postgres', '-h', '127.0.0.1', '-p', process.env.PGPORT || '5432', '-d', process.env.PGDB || 'puca', '-t', '-A', '-c', sql],
    { env: { ...process.env, PGPASSWORD: process.env.PGPASSWORD || 'postgres' } }).toString().trim();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const baseArgs = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--mute-audio',
    '--disable-features=WebRtcHideLocalIpsWithMdns', '--auto-select-desktop-capture-source=Entire screen',
    '--autoplay-policy=no-user-gesture-required'];

// React calls this hook on every commit in every build, so counting commits
// needs no instrumentation in the app itself.
const commitHook = () => {
    window.__rigCommits = 0;
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
        supportsFiber: true, renderers: new Map(), checkDCE() {},
        inject() { return 1; }, onScheduleFiberRoot() {}, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {},
        onCommitFiberRoot() { window.__rigCommits++; },
    };
};

// DeepFilter on the measured client, before any app script reads the
// settings: the Experimental gate, then the mode itself (noiseFilter.ts reads
// both at module init).
const dfInit = () => {
    try {
        const KEY = 'sovereign_settings';
        const s = JSON.parse(localStorage.getItem(KEY) || '{}');
        s.experimentalDeepFilter = true;
        localStorage.setItem(KEY, JSON.stringify(s));
        localStorage.setItem('noiseSuppressionMode', 'deepfilter');
    } catch { /* storage unavailable: the run's dfMode check reports it */ }
};

/** CPU time (seconds) per thread of `pids`, keyed `pid:tid`, with the thread's
 *  own name (Chromium names its threads: CrRendererMain, DedicatedWorker
 *  thread, ...). Windows only, read-only: OpenThread with
 *  THREAD_QUERY_LIMITED_INFORMATION, GetThreadTimes, GetThreadDescription. */
const THREAD_PS = `param([string]$Pids)
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Diagnostics; using System.Text;
public static class RigThreads {
  [DllImport("kernel32.dll")] static extern IntPtr OpenThread(uint a, bool i, uint t);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool GetThreadTimes(IntPtr h, out long c, out long e, out long k, out long u);
  [DllImport("kernel32.dll")] static extern int GetThreadDescription(IntPtr h, out IntPtr d);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
  public static string Dump(int pid) {
    var sb = new StringBuilder(); Process p;
    try { p = Process.GetProcessById(pid); } catch { return ""; }
    foreach (ProcessThread t in p.Threads) {
      IntPtr h = OpenThread(0x0800, false, (uint)t.Id); if (h == IntPtr.Zero) continue;
      long c, e, k, u; string desc = "";
      if (GetThreadTimes(h, out c, out e, out k, out u)) {
        IntPtr d; if (GetThreadDescription(h, out d) >= 0 && d != IntPtr.Zero) { desc = Marshal.PtrToStringUni(d) ?? ""; LocalFree(d); }
        sb.Append(pid).Append('\\t').Append(t.Id).Append('\\t').Append(desc).Append('\\t').Append(k + u).Append('\\n');
      }
      CloseHandle(h);
    }
    return sb.ToString();
  }
}
"@
foreach ($p in $Pids.Split(',')) { if ($p) { [Console]::Out.Write([RigThreads]::Dump([int]$p)) } }
`;
const threadPsPath = (() => {
    if (!THREADS) return null;
    const p = `${process.env.TEMP || '.'}/idle-call-cost-threads-${process.pid}.ps1`;
    fs.writeFileSync(p, THREAD_PS);
    return p;
})();
function threadTimes(pids) {
    const out = execFileSync('pwsh', ['-NoProfile', '-File', threadPsPath, '-Pids', pids.join(',')], { timeout: 60_000 }).toString();
    const m = new Map();
    for (const line of out.split(/\r?\n/)) {
        const [pid, tid, name, t100ns] = line.split('\t');
        if (!tid) continue;
        m.set(`${pid}:${tid}`, { name: name || '(unnamed)', s: Number(t100ns) / 1e7 });
    }
    return m;
}
/** Per-thread cores over a window: the busiest threads by name, plus every
 *  DedicatedWorker and audio thread individually (the DeepFilter Worker is
 *  one of them; it is the only DFN3 inference in the client). */
function threadDelta(t0, t1, secs) {
    const rows = [];
    for (const [k, v] of t1) {
        const b = t0.get(k);
        if (!b) continue;
        rows.push({ thread: `${v.name}#${k.split(':')[1]}`, name: v.name, cores: (v.s - b.s) / secs });
    }
    rows.sort((a, b) => b.cores - a.cores);
    const round = (x) => Math.round(x * 10000) / 10000;
    const byName = {};
    for (const r of rows) byName[r.name] = round((byName[r.name] || 0) + r.cores);
    return {
        byName,
        workers: rows.filter(r => /DedicatedWorker/i.test(r.name)).map(r => ({ thread: r.thread, cores: round(r.cores) })),
        audio: rows.filter(r => /audio/i.test(r.name)).map(r => ({ thread: r.thread, cores: round(r.cores) })),
        top: rows.slice(0, 8).map(r => ({ thread: r.thread, cores: round(r.cores) })),
    };
}

/** The measured client's DeepFilter worklet counters (latest ~2 s report). */
const dfStats = (p) => p.evaluate(async () => {
    const d = await window.__pucaVoiceDiag?.();
    const w = d?.noise?.deepFilter?.worklet;
    return {
        mode: d?.noise?.mode ?? null,
        hopsSent: w?.hopsSent ?? null, emitted: w?.emittedSamples ?? null,
        paused: w?.paused ?? null, bridgeSamples: w?.bridgeSamples ?? null,
        processedSamples: w?.processedSamples ?? null,
    };
});
const clickTitle = (p, title) => p.evaluate((t) => {
    const b = [...document.querySelectorAll('button')].find(x => x.getAttribute('title') === t && !x.disabled);
    if (b) { b.click(); return true; }
    return false;
}, title);

async function register(ctx, u) {
    const p = await ctx.newPage();
    await p.goto(APP + '/login');
    await p.waitForSelector('#username', { timeout: 30_000 });
    await p.click('.toggle-mode');
    await p.fill('#username', u); await p.fill('#password', PASS); await p.click('button[type="submit"]');
    await p.waitForURL('**/chat', { timeout: 60_000 }); await p.waitForTimeout(1200);
    try { await p.check('.recovery-confirm input[type=checkbox]', { timeout: 4000 }); await p.click('.recovery-done-btn'); } catch { /* none */ }
    try { await p.click('.welcome-popup-close', { timeout: 2000 }); } catch { /* none */ }
    return p;
}

async function createServer(page, name) {
    await page.locator('.server-icon.add-server').click({ timeout: 5000 });
    await page.waitForTimeout(500);
    await page.locator('.template-card').first().click({ timeout: 4000 });
    await page.waitForTimeout(300);
    await page.locator('.audience-card').first().click({ timeout: 4000 });
    await page.waitForTimeout(300);
    await page.locator('.server-name-input input').fill(name);
    await page.locator('.wizard-actions .create-btn').click();
    await page.waitForTimeout(2500);
}

async function joinVoice(p) {
    await p.reload(); await p.waitForTimeout(2000);
    await p.evaluate(() => {
        const i = [...document.querySelectorAll('.server-icon')].find(x => !/direct message|add server|join server|notes|tasks/i.test((x.getAttribute('title') || '') + ' ' + (x.className || '')));
        i?.click();
    });
    await p.waitForTimeout(1500);
    // Open the text channel too: the message list is part of what re-renders.
    await p.evaluate(() => { document.querySelector('.channel-item:not(.voice-channel)')?.click(); });
    await p.waitForTimeout(500);
    const ok = await p.evaluate(() => {
        const el = [...document.querySelectorAll('.voice-channel-list .voice-channel')].find(n => !n.classList.contains('afk'));
        if (el) { el.click(); return true; } return false;
    });
    await p.waitForTimeout(3000);
    return ok;
}

async function startShare(p) {
    const opened = await p.evaluate(() => {
        const btn = [...document.querySelectorAll('button')].find(b =>
            /share|screen/i.test((b.getAttribute('title') || '') + ' ' + b.className) && !/stop/i.test(b.textContent));
        if (btn) { btn.click(); return true; } return false;
    });
    if (!opened) return false;
    await p.waitForTimeout(800);
    const live = await p.evaluate(() => {
        const b = [...document.querySelectorAll('button')].find(x => /go live|select screen/i.test(x.textContent));
        if (b) { b.click(); return true; } return false;
    });
    await p.waitForTimeout(4000);
    return live;
}

/** Average GPU-engine utilisation of `pid` over `ms`, summed per engine type
 *  and adapter (Windows performance counters; read-only). */
function gpuEngines(pid, ms) {
    const samples = Math.max(2, Math.round(ms / 2000));
    const ps = `$s = Get-Counter '\\GPU Engine(pid_${pid}_*)\\Utilization Percentage' -SampleInterval 2 -MaxSamples ${samples} -ErrorAction SilentlyContinue;` +
        `$acc=@{}; foreach ($x in $s) { foreach ($c in $x.CounterSamples) { if ($c.InstanceName -match 'luid_(0x[0-9a-f]+_0x[0-9a-f]+)_phys_\\d+_eng_\\d+_engtype_(.+)$') { $k = $matches[1] + ' ' + $matches[2]; $acc[$k] = ($acc[$k] ?? 0) + $c.CookedValue } } };` +
        `$acc.GetEnumerator() | ForEach-Object { '{0}={1:N2}' -f $_.Key, ($_.Value / ${samples}) }`;
    return new Promise((resolve) => {
        execFile('pwsh', ['-NoProfile', '-Command', ps], { timeout: ms + 30_000 }, (err, stdout) => {
            const out = {};
            for (const line of String(stdout || '').split(/\r?\n/)) {
                const m = line.match(/^(\S+ \S+)=([\d.]+)$/);
                if (m && Number(m[2]) > 0) out[m[1]] = Number(m[2]);
            }
            resolve(out);
        });
    });
}

// EXTRA_ARGS: more Chromium flags for BOTH browsers (e.g. --disable-gpu, to
// keep the rig off a GPU the machine's owner is using).
const extraArgs = String(process.env.EXTRA_ARGS || '').split(' ').filter(Boolean);
const measuredArgs = [...baseArgs, ...extraArgs, ...(ADAPTER_LUID ? [`--use-adapter-luid=${ADAPTER_LUID}`] : [])];
const measured = await chromium.launch({ channel: CHANNEL === 'bundled' ? undefined : CHANNEL, args: measuredArgs });
const others = await chromium.launch({ channel: CHANNEL === 'bundled' ? undefined : CHANNEL, args: [...baseArgs, ...extraArgs] });
const users = Array.from({ length: N }, (_, i) => `ic${i}_${stamp}`);
const result = { app: APP, n: N, share: SHARE, df: DF, states: STATES, warmMs: WARM_MS, measureMs: MEASURE_MS, adapter: ADAPTER_LUID || 'default', reps: [] };

try {
    const mctx = await measured.newContext({ permissions: ['microphone', 'camera'], viewport: { width: 1600, height: 1000 } });
    await mctx.addInitScript(commitHook);
    if (DF) await mctx.addInitScript(dfInit);
    const pages = [await register(mctx, users[0])];
    for (let i = 1; i < N; i++) {
        const ctx = await others.newContext({ permissions: ['microphone', 'camera'], viewport: { width: 1280, height: 800 } });
        pages.push(await register(ctx, users[i]));
    }
    const serverName = 'IdleCost_' + stamp;
    await createServer(pages[0], serverName);
    const serverId = psql(`SELECT id FROM servers WHERE name='${serverName}'`);
    for (let i = 1; i < N; i++) {
        const uid = psql(`SELECT id FROM users WHERE username='${users[i]}'`);
        psql(`INSERT INTO server_members (server_id, user_id) VALUES ('${serverId}', ${uid}) ON CONFLICT DO NOTHING`);
    }
    for (const p of pages) {
        if (!await joinVoice(p)) throw new Error('could not find the voice channel to join');
    }

    // PRECONDITIONS: the measured client really is in a live call with the
    // others, and hears them (a fake-mic beep lights their speaking rings).
    await sleep(8000);
    const pre = await pages[0].evaluate(() => ({
        voiceUsers: document.querySelectorAll('.voice-user-item, .voice-user').length,
        audioEls: document.querySelectorAll('audio').length,
        speakingSeen: false,
    }));
    let speakingSeen = false;
    for (let i = 0; i < 40 && !speakingSeen; i++) {
        speakingSeen = await pages[0].evaluate(() => document.querySelectorAll('.voice-user-item.speaking, .voice-user.speaking, .speaking').length > 0);
        if (!speakingSeen) await sleep(250);
    }
    pre.speakingSeen = speakingSeen;
    // Whatever is animating right now, by name and element: an animation that
    // never ends is a frame (and usually a style recalc) every vsync.
    pre.animations = await pages[0].evaluate(() => document.getAnimations().map(a => ({
        name: a.animationName ?? a.constructor.name,
        el: (a.effect?.target?.className && String(a.effect.target.className).slice(0, 60)) || a.effect?.target?.tagName || '?',
        state: a.playState,
        iterations: a.effect?.getTiming?.().iterations,
    })));
    if (SHARE) {
        // The LIVE badge must appear on the measured client, which is not
        // watching. It once depended on speaking flips re-rendering the whole
        // app; a build where it never shows is a regression, not a cheaper
        // number, so this run stops here. The stream starts only once the
        // call has SETTLED (no joins still re-rendering the roster), and the
        // badge gets 5 s: the case a missing stream-state subscription breaks.
        await sleep(10_000);
        result.shareStarted = await startShare(pages[1]);
        let live = false;
        for (let i = 0; i < 20 && !live; i++) {
            live = await pages[0].evaluate(() => !!document.querySelector('.live-badge-mini'));
            if (!live) await sleep(250);
        }
        pre.liveBadge = live;
        if (!live) {
            console.log('FAIL: a stream is live but the measured client never showed its LIVE badge');
            process.exitCode = 1;
        }
    }
    result.pre = pre;
    console.log('pre', JSON.stringify(pre));
    if (pre.audioEls < N - 1 || !speakingSeen) console.log('WARNING: the call is not fully up; numbers below are not comparable');

    await sleep(WARM_MS);
    const bcdp = await measured.newBrowserCDPSession();
    const pcdp = await mctx.newCDPSession(pages[0]);
    await pcdp.send('Performance.enable');
    const metric = async () => Object.fromEntries((await pcdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
    const procs = async () => (await bcdp.send('SystemInfo.getProcessInfo')).processInfo;

    if (DF) {
        result.dfAtStart = await dfStats(pages[0]);
        console.log('df', JSON.stringify(result.dfAtStart));
        if (result.dfAtStart.mode !== 'deepfilter' || result.dfAtStart.hopsSent === null) {
            console.log('FAIL: DF=1 but the measured client is not running a DeepFilter graph');
            process.exitCode = 1;
        }
    }
    const rendererPids = async () => (await procs()).filter(p => p.type === 'renderer').map(p => p.id);

    for (const [si, state] of STATES.entries()) {
        // Transitions, each followed by a settle so the window measures the
        // state rather than the change (a pause takes effect after its hold;
        // leaving a mesh call tears down peer connections).
        if (state === 'muted') {
            if (!await clickTitle(pages[0], 'Mute')) throw new Error('no Mute button on the measured client');
        } else if (state === 'alone') {
            await clickTitle(pages[0], 'Unmute');
            for (let i = 1; i < N; i++) {
                if (!await clickTitle(pages[i], 'Disconnect')) throw new Error(`client ${i} could not disconnect`);
            }
        }
        if (si > 0 || state !== 'open') await sleep(Number(process.env.SETTLE_MS || 8000));
        const audioEls = await pages[0].evaluate(() => document.querySelectorAll('audio[id^="audio-"]').length);
        for (let r = 0; r < REPS; r++) {
            const pids = THREADS ? await rendererPids() : [];
            const t0 = THREADS ? threadTimes(pids) : null;
            const d0 = DF ? await dfStats(pages[0]) : null;
            const p0 = await procs(); const m0 = await metric(); const c0 = await pages[0].evaluate(() => window.__rigCommits);
            const gpuPid = p0.find(p => p.type === 'GPU')?.id;
            const gpuP = gpuPid && process.env.NOGPU !== '1' ? gpuEngines(gpuPid, MEASURE_MS) : Promise.resolve({});
            await sleep(MEASURE_MS);
            const p1 = await procs(); const m1 = await metric(); const c1 = await pages[0].evaluate(() => window.__rigCommits);
            const t1 = THREADS ? threadTimes(pids) : null;
            const d1 = DF ? await dfStats(pages[0]) : null;
            const gpu = await gpuP;
            const secs = MEASURE_MS / 1000;
            const byType = {};
            for (const q of p1) {
                const before = p0.find(x => x.id === q.id);
                if (!before) continue;
                byType[q.type] = (byType[q.type] || 0) + (q.cpuTime - before.cpuTime) / secs;
            }
            const rep = {
                state,
                cpuCores: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, Math.round(v * 1000) / 1000])),
                commitsPerSec: Math.round(((c1 - c0) / secs) * 10) / 10,
                recalcPerSec: Math.round(((m1.RecalcStyleCount - m0.RecalcStyleCount) / secs) * 10) / 10,
                layoutPerSec: Math.round(((m1.LayoutCount - m0.LayoutCount) / secs) * 10) / 10,
                scriptMsPerSec: Math.round(((m1.ScriptDuration - m0.ScriptDuration) * 1000 / secs) * 10) / 10,
                taskMsPerSec: Math.round(((m1.TaskDuration - m0.TaskDuration) * 1000 / secs) * 10) / 10,
                gpuEnginesPct: gpu,
                remoteAudioEls: audioEls,
                ...(THREADS ? { threads: threadDelta(t0, t1, secs) } : {}),
                // The worklet reports every ~2 s, so these deltas are +-1 report.
                ...(DF ? { df: { hopsPerSec: d0?.hopsSent != null && d1?.hopsSent != null ? Math.round((d1.hopsSent - d0.hopsSent) / secs * 10) / 10 : null, paused: d1?.paused ?? null } } : {}),
            };
            result.reps.push(rep);
            console.log(`${state} rep ${r + 1}`, JSON.stringify(rep));
        }
    }
} finally {
    await measured.close().catch(() => {});
    await others.close().catch(() => {});
}
if (threadPsPath) { try { fs.unlinkSync(threadPsPath); } catch { /* already gone */ } }
if (OUT) fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
console.log('DONE');
