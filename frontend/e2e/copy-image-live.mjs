// Copy Image, in a real browser, against the real module.
//
// The unit tests cover the decisions (which menu items appear, how failures
// are classified) but they run in jsdom, which has NO canvas, NO
// createImageBitmap and NO ClipboardItem. The entire re-encode path — the part
// that actually turns a JPEG attachment into something the OS clipboard will
// take — is therefore untested by them. This suite exercises it for real.
//
// It imports the ACTUAL module through Vite's dev server rather than
// reimplementing it, so it cannot drift from the shipped code.
//
// THE CONTROL THAT MATTERS: asserting "the clipboard contains an image/png"
// passes just as well when the canvas produced a blank rectangle — which is
// exactly what a tainted canvas or a mis-sized draw would yield. So every
// success case also decodes what came back and checks its DIMENSIONS and that
// it is not uniformly transparent.
//
// Prereqs: vite dev server on :5173 (no backend, no login needed).
//   cd frontend && npm run dev
// Usage: node e2e/copy-image-live.mjs
import { chromium } from '@playwright/test';

const ORIGIN = process.env.APP_ORIGIN || 'http://localhost:5173';

let failures = 0;
const check = (n, ok, d) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`);
    if (!ok) failures++;
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
const page = await ctx.newPage();
page.on('pageerror', e => console.log('PAGEERROR:', String(e).slice(0, 200)));

try {
    await page.goto(ORIGIN, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Sanity: the module must actually load. Without this, every later failure
    // looks like a clipboard problem when it is really a 404 on the import.
    const loaded = await page.evaluate(async () => {
        const m = await import('/src/api/copyImage.ts');
        return typeof m.copyImageToClipboard === 'function' && typeof m.canCopyImages === 'function';
    });
    check('the real copyImage module loads', loaded);

    check('this browser reports image-copy support',
        await page.evaluate(async () => (await import('/src/api/copyImage.ts')).canCopyImages()));

    // --- A JPEG attachment: the case that REQUIRES canvas re-encoding --------
    const jpeg = await page.evaluate(async () => {
        const m = await import('/src/api/copyImage.ts');

        // Build a real JPEG with a known size and a known non-transparent
        // colour, then hand it over as a blob: URL exactly like a decrypted
        // attachment would be.
        const c = document.createElement('canvas');
        c.width = 123; c.height = 45;
        const cx = c.getContext('2d');
        cx.fillStyle = '#ff0000';
        cx.fillRect(0, 0, 123, 45);
        const srcBlob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9));
        const url = URL.createObjectURL(srcBlob);

        const outcome = await m.copyImageToClipboard(url);

        // Read the clipboard back and DECODE it — the actual proof.
        const items = await navigator.clipboard.read();
        const types = items.flatMap(i => i.types);
        let width = 0, height = 0, opaquePixels = 0, red = null;
        if (types.includes('image/png')) {
            const blob = await items[0].getType('image/png');
            const bmp = await createImageBitmap(blob);
            width = bmp.width; height = bmp.height;
            const oc = document.createElement('canvas');
            oc.width = width; oc.height = height;
            const ocx = oc.getContext('2d');
            ocx.drawImage(bmp, 0, 0);
            const data = ocx.getImageData(0, 0, width, height).data;
            for (let i = 3; i < data.length; i += 4) if (data[i] > 0) opaquePixels++;
            red = [data[0], data[1], data[2]];
        }
        URL.revokeObjectURL(url);
        return { outcome, types, width, height, opaquePixels, red, srcType: srcBlob.type };
    });

    check('source really was a JPEG (so re-encoding was required)', jpeg.srcType === 'image/jpeg', jpeg.srcType);
    check('copying a JPEG blob reports success', jpeg.outcome?.ok === true, JSON.stringify(jpeg.outcome));
    check('the clipboard holds an image/png', jpeg.types.includes('image/png'), JSON.stringify(jpeg.types));
    // CONTROL: a blank/tainted canvas would still be a valid image/png.
    check('the copied PNG has the SOURCE dimensions',
        jpeg.width === 123 && jpeg.height === 45, `${jpeg.width}x${jpeg.height}`);
    check('the copied PNG is not a blank transparent rectangle',
        jpeg.opaquePixels === 123 * 45, `${jpeg.opaquePixels} of ${123 * 45} px opaque`);
    check('the copied PNG carries the source colour (red)',
        jpeg.red && jpeg.red[0] > 200 && jpeg.red[1] < 60 && jpeg.red[2] < 60, JSON.stringify(jpeg.red));

    // --- A source that is ALREADY a PNG -------------------------------------
    // There is no passthrough: the blob type is attacker-controlled for E2EE
    // attachments (it comes from the sender's `m=` parameter), so everything is
    // decoded and re-encoded. This proves that still round-trips correctly.
    const png = await page.evaluate(async () => {
        const m = await import('/src/api/copyImage.ts');
        const c = document.createElement('canvas');
        c.width = 20; c.height = 10;
        const cx = c.getContext('2d');
        cx.fillStyle = '#0000ff';
        cx.fillRect(0, 0, 20, 10);
        const srcBlob = await new Promise(r => c.toBlob(r, 'image/png'));
        const url = URL.createObjectURL(srcBlob);
        const outcome = await m.copyImageToClipboard(url);
        const items = await navigator.clipboard.read();
        const blob = await items[0].getType('image/png');
        const bmp = await createImageBitmap(blob);
        URL.revokeObjectURL(url);
        return { outcome, w: bmp.width, h: bmp.height };
    });
    check('copying a PNG-typed blob reports success', png.outcome?.ok === true, JSON.stringify(png.outcome));
    check('a PNG source is re-encoded and keeps its dimensions', png.w === 20 && png.h === 10, `${png.w}x${png.h}`);

    // --- A host that refuses CORS ------------------------------------------
    // Must be reported as fetch-failed, NOT as a clipboard denial — the two get
    // different messages, and blaming the clipboard for a CORS refusal sends the
    // user looking in the wrong place. In a real browser the engine WRAPS the
    // rejection in its own DOMException, which is exactly what jsdom cannot
    // reproduce and what the first implementation got wrong.
    const cors = await page.evaluate(async () => {
        const m = await import('/src/api/copyImage.ts');
        return m.copyImageToClipboard('https://puca-copy-image-nonexistent.invalid/x.png');
    });
    check('an unreachable cross-origin image reports fetch-failed',
        cors?.ok === false && cors.reason === 'fetch-failed', JSON.stringify(cors));

    // --- Non-image bytes ----------------------------------------------------
    const junk = await page.evaluate(async () => {
        const m = await import('/src/api/copyImage.ts');
        const url = URL.createObjectURL(new Blob(['not an image at all'], { type: 'text/plain' }));
        const outcome = await m.copyImageToClipboard(url);
        URL.revokeObjectURL(url);
        return outcome;
    });
    check('undecodable bytes report decode-failed',
        junk?.ok === false && junk.reason === 'decode-failed', JSON.stringify(junk));

    // --- The link guard, in the real engine ---------------------------------
    const guards = await page.evaluate(async () => {
        const m = await import('/src/api/copyImage.ts');
        const url = URL.createObjectURL(new Blob(['x']));
        const r = { blob: m.canCopyImageLink(url), remote: m.canCopyImageLink('https://example.com/a.png') };
        URL.revokeObjectURL(url);
        return r;
    });
    check('no Copy Image Link for a real blob: URL', guards.blob === false);
    check('Copy Image Link offered for a remote URL', guards.remote === true);

    // --- The Toast at 390x844, coarse pointer -------------------------------
    // DESIGN_PHILOSOPHY §5: "A UI change is not done until it has been seen at
    // 390x844 with a coarse pointer." The Toast is the only genuinely new UI
    // here. Mounted in isolation so this needs no backend or login.
    const mob = await ctx.browser().newContext({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
    });
    const mp = await mob.newPage();
    await mp.goto(ORIGIN, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const toast = await mp.evaluate(async () => {
        // Bare specifiers ('react') are rewritten by Vite at TRANSFORM time and
        // do not resolve in a runtime import() from page.evaluate. Resolve the
        // pre-bundled files through Vite's own metadata rather than hardcoding
        // names that change when deps are re-optimized.
        const meta = await (await fetch('/node_modules/.vite/deps/_metadata.json')).json();
        const dep = n => '/node_modules/.vite/deps/' + meta.optimized[n].file;
        const [reactMod, domMod, mod] = await Promise.all([
            import(dep('react')), import(dep('react-dom/client')), import('/src/components/Toast.tsx'),
        ]);
        // Vite's CJS interop puts the real namespace on .default for some deps.
        const React = reactMod.createElement ? reactMod : reactMod.default;
        const ReactDOM = domMod.createRoot ? domMod : domMod.default;
        const root = document.createElement('div');
        document.body.appendChild(root);
        ReactDOM.createRoot(root).render(
            React.createElement(mod.Toast, {
                message: 'Couldn’t load that image to copy it — try Copy Image Link.',
                onDismiss: () => {},
                duration: 999999,
            }),
        );
        await new Promise(r => setTimeout(r, 250));
        const el = document.querySelector('.app-toast');
        if (!el) return { mounted: false };
        const r = el.getBoundingClientRect();
        const btn = el.querySelector('.app-toast-close').getBoundingClientRect();
        const cs = getComputedStyle(el);
        return {
            mounted: true,
            right: r.right, left: r.left, bottom: r.bottom, top: r.top,
            btnW: Math.round(btn.width), btnH: Math.round(btn.height),
            vw: window.innerWidth, vh: window.innerHeight,
            position: cs.position, zIndex: cs.zIndex,
        };
    });
    check('the toast mounts on mobile', toast.mounted === true);
    // Without this, every geometry check below is satisfied by an UNSTYLED
    // block-level div in normal flow (left 0, top ~0) — i.e. they would all
    // pass with Toast.css missing entirely, which is the state where the toast
    // renders off-view behind the app chrome.
    check('the toast is actually positioned by its stylesheet',
        toast.position === 'fixed' && Number(toast.zIndex) >= 10000,
        `position ${toast.position}, z-index ${toast.zIndex}`);
    check('the toast does not bleed off-screen horizontally',
        toast.left >= 0 && toast.right <= toast.vw, `left ${toast.left}, right ${toast.right}, vw ${toast.vw}`);
    check('the toast is fully on-screen vertically',
        toast.top >= 0 && toast.bottom <= toast.vh, `top ${toast.top}, bottom ${toast.bottom}, vh ${toast.vh}`);
    // THE REAL REQUIREMENT, and the bug this caught: mobile stacks a 60px nav
    // and a ~60px composer at the bottom, so anything below 120px covers the
    // message box and swallows taps meant for it. "On-screen" was true at 88px
    // and still wrong.
    const MOBILE_CHROME_PX = 120;
    check('the toast clears the mobile nav AND the composer',
        toast.bottom <= toast.vh - MOBILE_CHROME_PX,
        `bottom edge ${Math.round(toast.vh - toast.bottom)}px above the viewport floor, need >= ${MOBILE_CHROME_PX}`);
    // mobile.css inflates every <button> to 44px under coarse pointer, so this
    // passes on the global rule rather than on anything in Toast.css. Kept as a
    // check that the toast is INSIDE that media query's scope, not as evidence
    // that Toast.css sizes the button.
    check('the dismiss button meets the 44px touch minimum',
        toast.btnH >= 44 && toast.btnW >= 44, `${toast.btnW}x${toast.btnH}`);
    await mob.close();
} catch (e) {
    console.log('EXCEPTION:', String(e).split('\n').slice(0, 3).join(' | '));
    failures++;
} finally {
    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
    await browser.close();
    process.exit(failures === 0 ? 0 : 1);
}
