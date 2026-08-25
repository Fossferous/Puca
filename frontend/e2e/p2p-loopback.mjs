// Peer-to-peer transfer, end to end, over a REAL WebRTC data channel.
//
// Everything else about this feature is unit-tested against a fake channel.
// This is the only thing that exercises the actual stack: SCTP over DTLS, real
// bufferedAmount backpressure, real ordering, real chunk delivery — the parts
// that a fake cannot be wrong about in the same way the network is.
//
// It runs BOTH peers inside one Chromium page and wires the signalling directly
// between them, so it needs no second machine, no server and no TURN. What it
// therefore does NOT cover: the WS control plane, the DM authorization, the
// relay policy (there is no relay in a loopback), and the desktop disk sink.
// Those are covered by unit tests and, eventually, by two real clients.
//
// Usage: node e2e/p2p-loopback.mjs
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

let fail = 0;
const ck = (name, ok, extra = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
    if (!ok) fail++;
};

// Bundle the real engine for the browser. esbuild ships with vite, so this
// needs no extra dependency.
const outfile = path.resolve('e2e/.p2p-bundle.js');
await build({
    entryPoints: [path.resolve('e2e/p2p-loopback-entry.ts')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome110',
    outfile,
    logLevel: 'error',
});
const bundle = fs.readFileSync(outfile, 'utf8');

// A hang must FAIL, not wait forever: `await incoming` lives inside
// page.evaluate, which Playwright does not bound.
const watchdog = setTimeout(() => {
    console.log('FAIL  harness timed out — a transfer never completed');
    process.exit(1);
}, 120000);
watchdog.unref?.();

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('console', m => {
    if (m.type() === 'error') console.log('[page error]', m.text().slice(0, 300));
});
// about:blank has an opaque origin; a real page origin keeps crypto.subtle
// available (the engine hashes with it in one path).
await page.goto(pathToFileURL(path.resolve('e2e/p2p-loopback.html')).href);
await page.addScriptTag({ content: bundle });

const sizes = [
    { label: 'small (under one chunk)', bytes: 5000 },
    { label: 'exact chunk multiple', bytes: 16 * 1024 * 4 },
    { label: 'unaligned, spans many chunks', bytes: 16 * 1024 * 37 + 123 },
    { label: 'large enough to hit backpressure', bytes: 6 * 1024 * 1024 },
];

for (const { label, bytes } of sizes) {
    const result = await page.evaluate(async ({ size, tamper }) => {
        const { sendFile, sha256OfBlob, TransferReceiver, HIGH_WATER } = window.P2P;

        // Payload and digest FIRST: ondatachannel fires as soon as negotiation
        // completes, and the receiver needs the expected hash at construction.
        const data = new Uint8Array(size);
        for (let i = 0; i < size; i++) data[i] = (i * 7 + (i >> 8)) & 0xff;
        const file = new Blob([data]);
        const expectedHash = await sha256OfBlob(file);

        // Two real peer connections, signalling wired straight between them.
        const a = new RTCPeerConnection();
        const b = new RTCPeerConnection();
        a.onicecandidate = e => e.candidate && b.addIceCandidate(e.candidate);
        b.onicecandidate = e => e.candidate && a.addIceCandidate(e.candidate);

        const channel = a.createDataChannel('file', { ordered: true });
        channel.binaryType = 'arraybuffer';

        const received = [];
        let receiver = null;
        let peakBuffered = 0;
        let outOfOrder = false;

        const incoming = new Promise(resolve => {
            b.ondatachannel = ev => {
                const ch = ev.channel;
                ch.binaryType = 'arraybuffer';
                const sink = {
                    write(chunk) {
                        const copy = new Uint8Array(chunk);
                        // `tamper` flips one byte of the first chunk, to prove
                        // this harness can actually DETECT a corrupt transfer.
                        if (tamper && received.length === 0 && copy.length) copy[0] ^= 0xff;
                        received.push(copy);
                    },
                    close() { },
                };
                receiver = new TransferReceiver(sink, {
                    expectedSha256: expectedHash,
                    total: size,
                });
                // Serialized exactly as fileTransferManager does it: onmessage
                // fires faster than the sink resolves.
                let chain = Promise.resolve();
                ch.onmessage = e => {
                    const frame = e.data;
                    chain = chain
                        .then(() => receiver.accept(frame))
                        .then(() => {
                            if (receiver.offset >= size) resolve();
                        })
                        .catch(err => { outOfOrder = true; resolve(err.message); });
                };
            };
        });

        await a.setLocalDescription(await a.createOffer());
        await b.setRemoteDescription(a.localDescription);
        await b.setLocalDescription(await b.createAnswer());
        await a.setRemoteDescription(b.localDescription);

        await new Promise(res => { channel.onopen = res; });

        const started = performance.now();
        const watch = setInterval(() => {
            peakBuffered = Math.max(peakBuffered, channel.bufferedAmount);
        }, 1);

        await sendFile(channel, file, {
            onProgress: () => {
                peakBuffered = Math.max(peakBuffered, channel.bufferedAmount);
            },
        });
        const err = await incoming;
        clearInterval(watch);

        // Reassemble what the receiver wrote and compare byte for byte.
        const total = received.reduce((n, c) => n + c.byteLength, 0);
        const joined = new Uint8Array(total);
        let at = 0;
        for (const c of received) { joined.set(c, at); at += c.byteLength; }

        let identical = joined.byteLength === data.byteLength;
        if (identical) {
            for (let i = 0; i < data.byteLength; i++) {
                if (joined[i] !== data[i]) { identical = false; break; }
            }
        }

        let hashOk = false;
        try {
            await receiver.finish();   // verifies the digest internally
            hashOk = true;
        } catch { hashOk = false; }

        a.close(); b.close();
        return {
            identical, hashOk, outOfOrder, err: typeof err === 'string' ? err : null,
            bytesReceived: total, peakBuffered, highWater: HIGH_WATER,
            ms: Math.round(performance.now() - started),
        };
    }, { size: bytes, tamper: false });

    console.log(`\n--- ${label} (${bytes.toLocaleString()} bytes, ${result.ms} ms) ---`);
    ck(`${label}: every byte arrived`, result.bytesReceived === bytes,
        `got ${result.bytesReceived}`);
    ck(`${label}: contents identical`, result.identical);
    ck(`${label}: digest verified by the receiver`, result.hashOk);
    ck(`${label}: no out-of-order chunk`, !result.outOfOrder, result.err ?? '');
    // The real proof that backpressure works against a genuine SCTP channel.
    ck(`${label}: send buffer stayed bounded`,
        result.peakBuffered <= result.highWater + 64 * 1024,
        `peak ${Math.round(result.peakBuffered / 1024)} KiB vs high-water ${Math.round(result.highWater / 1024)} KiB`);
    // An upper bound alone passes trivially on a transfer that never filled the
    // buffer — it would report "backpressure works" having never exercised it.
    // Only the big case is guaranteed to push past the low-water mark.
    if (bytes >= 4 * 1024 * 1024) {
        ck(`${label}: backpressure was actually exercised`,
            result.peakBuffered >= 256 * 1024,
            `peak only ${Math.round(result.peakBuffered / 1024)} KiB — the send loop never filled the buffer, so the bound above proves nothing`);
    }
}

// ANTI-VACUITY: prove the digest check above can actually fail. Without this,
// four green "digest verified" lines could mean the check never ran.
{
    const tampered = await page.evaluate(async ({ size, tamper }) => {
        const { sendFile, sha256OfBlob, TransferReceiver } = window.P2P;
        const data = new Uint8Array(size);
        for (let i = 0; i < size; i++) data[i] = (i * 7) & 0xff;
        const file = new Blob([data]);
        const expectedHash = await sha256OfBlob(file);

        const a = new RTCPeerConnection();
        const b = new RTCPeerConnection();
        a.onicecandidate = e => e.candidate && b.addIceCandidate(e.candidate);
        b.onicecandidate = e => e.candidate && a.addIceCandidate(e.candidate);
        const channel = a.createDataChannel('file', { ordered: true });
        channel.binaryType = 'arraybuffer';

        let receiver = null;
        let seen = 0;
        const done = new Promise(resolve => {
            b.ondatachannel = ev => {
                const ch = ev.channel;
                ch.binaryType = 'arraybuffer';
                receiver = new TransferReceiver({
                    write() { seen++; },
                    close() { },
                }, { expectedSha256: expectedHash, total: size });
                let chain = Promise.resolve();
                ch.onmessage = e => {
                    // Corrupt IN TRANSIT — after the wire, before the receiver.
                    // The running digest covers the bytes that ARRIVED, so
                    // tampering inside the sink would prove nothing: the
                    // receiver never sees what the sink chose to write.
                    const frame = e.data;
                    if (tamper && seen === 0 && frame.byteLength > 8) {
                        const view = new Uint8Array(frame);
                        view[view.length - 1] ^= 0xff;
                    }
                    chain = chain.then(() => receiver.accept(frame))
                        .then(() => { if (receiver.offset >= size) resolve(); })
                        .catch(() => resolve());
                };
            };
        });

        await a.setLocalDescription(await a.createOffer());
        await b.setRemoteDescription(a.localDescription);
        await b.setLocalDescription(await b.createAnswer());
        await a.setRemoteDescription(b.localDescription);
        await new Promise(res => { channel.onopen = res; });
        await sendFile(channel, file);
        await done;

        let threw = false;
        let code = '';
        try { await receiver.finish(); } catch (e) { threw = true; code = e.code || ''; }
        a.close(); b.close();
        return { threw, code };
    }, { size: 40000, tamper: true });

    console.log('\n--- corruption detection ---');
    ck('a single flipped byte fails the digest', tampered.threw,
        tampered.threw ? `code=${tampered.code}` : 'finish() accepted corrupt data');
    ck('and it fails as a hash mismatch', tampered.code === 'hash-mismatch', tampered.code);
}

clearTimeout(watchdog);
await browser.close();
fs.rmSync(outfile, { force: true });
console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILURE(S)`);
process.exit(fail === 0 ? 0 : 1);
