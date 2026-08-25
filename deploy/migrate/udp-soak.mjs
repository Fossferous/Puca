#!/usr/bin/env node
/**
 * UDP soak driver — runs on YOUR machine, against udp-sink.mjs on a candidate
 * VPS. This is the test that decides which host to buy.
 *
 * It sends at a realistic media rate and reports per-window loss in BOTH
 * directions (the sink echoes). What you are looking for is not the average —
 * it is a CLIFF: a window where loss jumps from ~0% to most of the traffic and
 * stays there. That is a DDoS scrubber deciding your voice call is an attack,
 * and it is the failure mode that no amount of terms-of-service reading can
 * rule out. A provider whose mitigation is mandatory and undisableable (OVH)
 * cannot be talked out of it afterwards, so find out for £8 before migrating.
 *
 * Run it for at least 30 minutes. Mitigation is usually triggered by sustained
 * rate over time, so a 60-second test proves nothing.
 *
 * Usage:
 *   node udp-soak.mjs <host> [port] [mbps] [minutes] [packet-bytes]
 *   node udp-soak.mjs 51.x.x.x 7882 4.5 30
 *   node udp-soak.mjs 51.x.x.x 7882 4.5 30 200    # same rate, 6x the pps
 *
 * 4.5 Mbps is one screen share — the heaviest single stream Puca sends.
 * Try 15 for "several people in a call with a share".
 *
 * Run it at least twice: once at 1200 bytes (video-like) and once at 200, since
 * packets-per-second limits and bitrate limits are separate guards and a host
 * can pass one while failing the other.
 */
import dgram from 'node:dgram';

const HOST = process.argv[2];
const PORT = Number(process.argv[3] || 7882);
const MBPS = Number(process.argv[4] || 4.5);
const MINUTES = Number(process.argv[5] || 30);

if (!HOST) {
    console.error('usage: node udp-soak.mjs <host> [port] [mbps] [minutes] [packet-bytes]');
    process.exit(2);
}

/** Default is near the MTU, like real video RTP. */
const PACKET_BYTES = Number(process.argv[6] || 1200);
const WINDOW_MS = 10_000;
const pps = Math.max(1, Math.round((MBPS * 1_000_000) / 8 / PACKET_BYTES));

/**
 * Send in small bursts on a coarse tick rather than one packet per timer fire.
 *
 * A timer per packet does not work: 4.5 Mbps needs a 2.1 ms interval, and the
 * Windows timer granularity is ~15.6 ms, so setInterval delivers ~64 ticks/sec
 * no matter what you ask for. The first version of this script did exactly
 * that — it sent 0.62 Mbps while reporting 4.5, and printed PASS. A soak that
 * quietly sends a seventh of the requested rate cannot trip a DDoS scrubber,
 * so it would have passed on every host and proved nothing.
 *
 * 20 ms bursts are fine for the purpose; real video is bursty per frame too.
 */
const TICK_MS = 20;

const sock = dgram.createSocket('udp4');
const payload = Buffer.alloc(PACKET_BYTES);

let seq = 0;
let sentWindow = 0;
let echoedWindow = 0;
let sentTotal = 0;
let echoedTotal = 0;
let dropped = 0;
let worstLoss = 0;
let cliffAt = null;
const windows = [];
const achievedMbps = [];

sock.on('message', () => { echoedWindow++; echoedTotal++; });
sock.on('error', (e) => { console.error('socket error:', e.message); process.exit(1); });

console.log(`Soaking ${HOST}:${PORT} at ${MBPS} Mbps (${pps} pkt/s of ${PACKET_BYTES}B) for ${MINUTES} min.`);
console.log('Watch for a WINDOW where loss jumps and stays high — that is a scrubber, not jitter.\n');

const started = Date.now();
const endAt = started + MINUTES * 60_000;

let lastReport = started;

const sender = setInterval(() => {
    // Self-correcting against the clock rather than trusting the timer to fire
    // when asked. Sending a fixed count per tick still under-delivers, because
    // a nominal 20 ms interval actually fires at ~30 ms under load on Windows —
    // that alone cost 38% of the requested rate. Deriving the count from
    // elapsed wall-clock time makes the average rate correct no matter how
    // badly the timer drifts.
    const due = Math.floor(((Date.now() - started) / 1000) * pps) - dropped;
    let n = due - sentTotal;
    if (n <= 0) return;
    // If the loop stalled, drop the backlog instead of firing a huge catch-up
    // burst — a multi-second burst is itself scrubber bait and would produce a
    // false FAIL. Real media drops late frames too. `dropped` advances the
    // baseline permanently, so the backlog is abandoned rather than chased.
    if (n > pps) { dropped += n - pps; n = pps; }
    for (let i = 0; i < n; i++) {
        payload.writeUInt32BE(seq++ >>> 0, 0);
        sock.send(payload, PORT, HOST, () => {});
        sentWindow++;
        sentTotal++;
    }
}, TICK_MS);

const reporter = setInterval(() => {
    // Echoes for the tail of a window can arrive in the next one; a whole
    // window of slack keeps that from reading as loss.
    const loss = sentWindow === 0 ? 0 : Math.max(0, (1 - echoedWindow / sentWindow) * 100);
    windows.push(loss);
    if (loss > worstLoss) worstLoss = loss;
    if (loss > 60 && cliffAt === null && windows.length > 2) {
        cliffAt = Math.round((Date.now() - started) / 1000);
    }
    const now = Date.now();
    // Report the rate ACTUALLY achieved, not the one that was requested — the
    // gap between them is the whole reason this line exists.
    const achieved = (sentWindow * PACKET_BYTES * 8) / (now - lastReport) / 1000;
    achievedMbps.push(achieved);
    lastReport = now;
    const mins = ((now - started) / 60000).toFixed(1);
    console.log(
        `t+${mins}m  sent ${sentWindow} (${achieved.toFixed(1)} Mbps)  echoed ${echoedWindow}  `
        + `round-trip loss ${loss.toFixed(1)}%${loss > 60 ? '   <-- SUSPECT' : ''}`
    );
    sentWindow = 0;
    echoedWindow = 0;
}, WINDOW_MS);

function finish() {
    clearInterval(sender);
    clearInterval(reporter);
    const overall = sentTotal === 0 ? 0 : (1 - echoedTotal / sentTotal) * 100;
    const elapsedS = (Date.now() - started) / 1000;
    const meanMbps = (sentTotal * PACKET_BYTES * 8) / elapsedS / 1_000_000;
    console.log('\n--- verdict ---');
    console.log(`sent ${sentTotal}, echoed ${echoedTotal}, overall round-trip loss ${overall.toFixed(2)}%`);
    console.log(`worst 10s window: ${worstLoss.toFixed(1)}%`);
    console.log(`rate: requested ${MBPS} Mbps, actually sent ${meanMbps.toFixed(2)} Mbps`);

    // Anti-vacuity control. A soak that did not achieve the requested rate
    // cannot have tested anything — no scrubber is provoked by traffic that
    // was never sent — so it must not be allowed to report PASS. This is not
    // hypothetical: the first version of this script sent a seventh of the
    // requested rate and cheerfully passed.
    if (meanMbps < MBPS * 0.8) {
        console.log(`\nINVALID — only ${(meanMbps / MBPS * 100).toFixed(0)}% of the requested rate was sent.`);
        console.log('This run proves nothing about the host. Likely causes: your own uplink is the');
        console.log('bottleneck (check it before blaming the VPS), or the sender could not keep up.');
        console.log('Re-run at a rate your connection can actually deliver.');
        process.exit(2);
    }

    if (cliffAt !== null) {
        console.log(`\nFAIL — traffic collapsed ${cliffAt}s in and did not recover in that window.`);
        console.log('That is the signature of automatic DDoS mitigation. This host will drop voice calls.');
    } else if (overall > 5) {
        console.log('\nMARGINAL — sustained loss above 5%. Voice would be audibly rough; investigate before committing.');
    } else {
        console.log('\nPASS — no scrubber interference at this rate. Re-run at a higher rate and with small');
        console.log('packets (200B) before deciding, since pps limits and bitrate limits are different guards.');
    }
    process.exit(cliffAt !== null ? 1 : 0);
}

setTimeout(finish, MINUTES * 60_000 + 2000);
process.on('SIGINT', finish);
void endAt;
