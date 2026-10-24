// Shared by e2e/iphone-stream-real-browser.mjs (the harness gate) and
// e2e/iphone-stream-live.mjs (the real app on a throwaway stack): what is
// measured, and the page states the negative controls put back.
import { devices } from '@playwright/test';

export const IPHONE_UA = devices['iPhone 15'].userAgent;
export const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
/** An iPhone's engine: no element fullscreen at all. */
export const IPHONE_FULLSCREEN = () => {
    for (const proto of [Element.prototype, HTMLElement.prototype]) {
        try { Object.defineProperty(proto, 'requestFullscreen', { configurable: true, value: undefined }); } catch { /* engine-specific */ }
        try { Object.defineProperty(proto, 'webkitRequestFullscreen', { configurable: true, value: undefined }); } catch { /* engine-specific */ }
    }
    Object.defineProperty(Document.prototype, 'fullscreenEnabled', { configurable: true, get: () => false });
    Object.defineProperty(Document.prototype, 'webkitFullscreenEnabled', { configurable: true, get: () => false });
};
/** Records (and still makes) every element fullscreen request. */
export const RECORD_FULLSCREEN = () => {
    window.__fsCalls = [];
    const orig = Element.prototype.requestFullscreen;
    Element.prototype.requestFullscreen = function (...a) {
        window.__fsCalls.push(this.className);
        return orig ? orig.apply(this, a) : Promise.resolve();
    };
};

/** Delete every rule this change added: what the page looked like before it. */
export const OLD_LAYOUT = () => {
    const marks = ['data-stream-takeover', 'data-stream-chrome', 'data-media-fullscreen', '(max-height: 500px)', 'watch-streams'];
    const strip = (list) => {
        for (let i = list.cssRules.length - 1; i >= 0; i--) {
            const r = list.cssRules[i];
            const head = r.selectorText ?? r.conditionText ?? r.media?.mediaText ?? '';
            // The old file had ONE landscape rule set, StreamStage.css's
            // (max-height: 500px) block: it stays.
            const isOldStageBlock = (r.conditionText ?? r.media?.mediaText ?? '').includes('max-height: 500px') && r.cssText.includes('.stream-grid.grid-1');
            if (!isOldStageBlock && marks.some(m => head.includes(m) || (r.cssText.startsWith('@media') ? false : r.cssText.includes(m)))) { list.deleteRule(i); continue; }
            if (r.cssRules && !isOldStageBlock) strip(r);
        }
    };
    for (const sh of document.styleSheets) strip(sh);
    // And the attribute itself, so nothing keyed on it can match.
    new MutationObserver(() => {
        delete document.documentElement.dataset.streamTakeover;
        delete document.documentElement.dataset.streamChrome;
    }).observe(document.documentElement, { attributes: true });
    delete document.documentElement.dataset.streamTakeover;
};

/** Everything a check needs, measured in the page. */
export const measure = (page) => page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; };
    const hits = (el, x, y) => { const h = document.elementFromPoint(x, y); return !!h && (h === el || el.contains(h)); };
    const centreHit = (el) => { const r = el?.getBoundingClientRect(); return !!r && r.width > 0 && hits(el, r.left + r.width / 2, r.top + r.height / 2); };
    const shown = (el) => { if (!el) return false; const cs = getComputedStyle(el); return cs.visibility === 'visible' && cs.display !== 'none' && Number(cs.opacity) > 0.5 && el.getBoundingClientRect().width > 0; };
    const stage = document.querySelector('.stream-stage');
    const video = document.querySelector('.stream-stage video, .stream-pip video');
    let picture = rect(video);
    if (video && video.videoWidth > 0 && picture) {
        const s = Math.min(picture.w / video.videoWidth, picture.h / video.videoHeight);
        const w = video.videoWidth * s, h = video.videoHeight * s;
        picture = { l: picture.l + (picture.w - w) / 2, t: picture.t + (picture.h - h) / 2, w, h, r: picture.l + (picture.w + w) / 2, b: picture.t + (picture.h + h) / 2, live: true };
    }
    const buttons = [...document.querySelectorAll('.stream-stage-header button, .stream-tile-header button, .voice-panel-compact button, .stream-pip button')]
        .filter((b) => { let e = b; while (e && e !== document.body) { if (!shown(e)) return false; e = e.parentElement; } return true; })
        .map((b) => ({ label: b.getAttribute('aria-label') || b.title || b.textContent.trim().slice(0, 20), ...rect(b), hit: centreHit(b) }));
    const parts = Object.fromEntries(['.chat-header', '.message-form', '.voice-panel-compact', '.mobile-bottom-nav', '.messages-container', '.stream-pip'].map((s) => {
        const el = document.querySelector(s);
        return [s, el ? { ...rect(el), shown: shown(el), hit: centreHit(el) } : null];
    }));
    const navBtns = [...document.querySelectorAll('.mobile-nav-btn')].map((b) => rect(b));
    return {
        vw, vh, sw: document.documentElement.scrollWidth,
        takeover: document.documentElement.dataset.streamTakeover ?? null,
        chrome: document.documentElement.dataset.streamChrome ?? null,
        stage: rect(stage), picture, liveFrames: !!video && video.videoWidth > 0,
        pictureCentreHit: picture ? (() => { const h = document.elementFromPoint(picture.l + picture.w / 2, picture.t + picture.h / 2); return !!h && !!h.closest('.stream-tile, .stream-pip'); })() : false,
        buttons, parts, navBtns,
        mute: (() => { const m = document.querySelector('.voice-panel-compact .voice-btn[title="Mute"], .voice-panel-compact .voice-btn[title="Unmute"]'); return m ? { ...rect(m), hit: centreHit(m) } : null; })(),
    };
});

export const overlap = (a, b) => Math.max(0, Math.min(a.r, b.r) - Math.max(a.l, b.l)) * Math.max(0, Math.min(a.b, b.b) - Math.max(a.t, b.t));
export const insets = (page, s) => page.evaluate((s) => {
    for (const [k, v] of Object.entries(s)) document.documentElement.style.setProperty(`--safe-area-${k}`, `${v}px`);
}, s);

