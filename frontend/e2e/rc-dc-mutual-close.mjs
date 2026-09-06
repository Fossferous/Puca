// Do two in-band data channels with the same label, created on BOTH ends and
// each end closing the one that ARRIVES, annihilate each other?
//
// YES — measured 2026-09-06 (Playwright Chromium, loopback): with
// closeArrivals=true both LOCAL channels end 'closed' within a second of
// opening; with closeArrivals=false all four ends stay 'open'. This is the
// mechanism that kept the mesh remote-control lane (rtc/controlDc.ts) on
// the WebSocket relay for its whole life before the lane became a single
// NEGOTIATED channel (CTL_STREAM_ID). Kept as the reproduction: a unit test
// with one fake channel per side cannot show it, because closing an arrived
// channel closes the SAME channel at the peer that created it.
//
// Prereqs: vite on :5173 (any secure loopback page works — mediaDevices
// needs a secure context, which about:blank is not). Usage (from frontend/):
//   node e2e/rc-dc-mutual-close.mjs
import { chromium } from '@playwright/test';

const browser = await chromium.launch({ args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] });
const page = await browser.newPage();
await page.goto('http://127.0.0.1:5173/login', { waitUntil: 'domcontentloaded' });
const res = await page.evaluate(async () => {
    const run = async (closeArrivals) => {
        const a = new RTCPeerConnection({ bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
        const b = new RTCPeerConnection({ bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
        const log = [];
        const states = { aLocal: null, bLocal: null, aArrived: null, bArrived: null };
        const la = a.createDataChannel('sov-ctl-s', { ordered: true });
        const lb = b.createDataChannel('sov-ctl-s', { ordered: true });
        la.onopen = () => log.push('A local open'); la.onclose = () => log.push('A local CLOSED');
        lb.onopen = () => log.push('B local open'); lb.onclose = () => log.push('B local CLOSED');
        a.ondatachannel = (ev) => { log.push('A got ' + ev.channel.label); states.aArrived = ev.channel; if (closeArrivals) ev.channel.close(); };
        b.ondatachannel = (ev) => { log.push('B got ' + ev.channel.label); states.bArrived = ev.channel; if (closeArrivals) ev.channel.close(); };
        a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate);
        b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
        await a.setLocalDescription(await a.createOffer());
        await b.setRemoteDescription(a.localDescription);
        await b.setLocalDescription(await b.createAnswer());
        await a.setRemoteDescription(b.localDescription);
        await new Promise(r => setTimeout(r, 2500));
        const out = { closeArrivals, aLocal: la.readyState, bLocal: lb.readyState, aArrived: states.aArrived && states.aArrived.readyState, bArrived: states.bArrived && states.bArrived.readyState, ids: { la: la.id, lb: lb.id }, log };
        a.close(); b.close();
        return out;
    };
    return [await run(true), await run(false)];
});
console.log(JSON.stringify(res, null, 1));
await browser.close();
