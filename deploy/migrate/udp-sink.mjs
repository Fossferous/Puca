#!/usr/bin/env node
/**
 * UDP soak target — runs ON the candidate VPS, before anything else is
 * installed. Pair with udp-soak.mjs on your own machine.
 *
 * WHY THIS EXISTS. The decision between hosts is not really about price or
 * included traffic; it is about whether the provider's DDoS mitigation will
 * survive a voice call. A TURN relay plus an SFU is sustained UDP arriving on
 * a high port from several sources — structurally indistinguishable from a UDP
 * flood to an automatic scrubber. OVH's mitigation in particular is mandatory
 * and cannot be disabled, and its throttle ("we may restrict to 1 Mbit/s for
 * excessive use") has no published numeric threshold, so there is no limit you
 * can engineer against. No amount of terms-of-service reading settles it. A
 * half-hour of real traffic does.
 *
 * It echoes every packet straight back, so one run measures BOTH directions —
 * inbound scrubbing and outbound shaping — and reports per-window counts so a
 * mitigation kicking in mid-run shows up as a cliff rather than an average.
 *
 * Usage on the VPS:
 *   sudo ufw allow 7882/udp
 *   node udp-sink.mjs [port]        # default 7882, the media port
 */
import dgram from 'node:dgram';

const PORT = Number(process.argv[2] || 7882);
const WINDOW_MS = 10_000;

const sock = dgram.createSocket('udp4');
let win = { packets: 0, bytes: 0, first: null, last: null };
let total = 0;

function flush() {
    if (win.packets === 0) {
        console.log(`${new Date().toISOString()}  window: NOTHING RECEIVED`);
    } else {
        const gaps = win.last - win.first + 1 - win.packets;
        console.log(
            `${new Date().toISOString()}  window: ${win.packets} pkts, `
            + `${(win.bytes * 8 / WINDOW_MS / 1000).toFixed(2)} Mbps, `
            + `seq ${win.first}..${win.last}, missing ${gaps > 0 ? gaps : 0}`
        );
    }
    win = { packets: 0, bytes: 0, first: null, last: null };
}

sock.on('message', (buf, rinfo) => {
    total++;
    // First 4 bytes are a sequence number written by the sender.
    const seq = buf.length >= 4 ? buf.readUInt32BE(0) : 0;
    if (win.first === null) win.first = seq;
    win.last = seq;
    win.packets++;
    win.bytes += buf.length;
    // Echo back so the sender can measure the RETURN path too — outbound
    // shaping is the half a receive-only test would miss.
    sock.send(buf, rinfo.port, rinfo.address, () => {});
});

sock.on('error', (e) => { console.error('sink error:', e.message); process.exit(1); });

sock.bind(PORT, () => {
    console.log(`UDP sink listening on ${PORT}, echoing. Windows every ${WINDOW_MS / 1000}s.`);
    console.log('Leave this running for the whole soak; Ctrl-C when done.');
    setInterval(flush, WINDOW_MS);
});

process.on('SIGINT', () => {
    flush();
    console.log(`\ntotal packets received: ${total}`);
    process.exit(0);
});
