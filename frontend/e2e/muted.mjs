/**
 * WebKit, muted. Chromium takes --mute-audio and Firefox media.volume_scale 0; WebKit has
 * no switch for it, so a script that launches it wraps the browser:
 *
 *     import { muteWebkit } from './muted.mjs';
 *     const wk = muteWebkit(await webkit.launch());
 *
 * and every context and page made from it gets silencePage() before any of the page's own
 * script. scripts/check-e2e-muted.mjs (npm run lint) fails a webkit.launch() not wrapped so.
 *
 * What silencePage() does, in the page:
 *   - every <audio> and <video> is muted at the element, whatever the page sets: the page
 *     reads back the muted it set (so an app that unmutes, and a test reading el.muted, see
 *     what they would have), while the element underneath stays muted. It is muted before
 *     play() or load(), when it is given a src, srcObject or autoplay (as a property or an
 *     attribute), as the parser puts it in the page (autoplay in the page's own HTML), and
 *     on loadstart / play / playing;
 *   - Web Audio: whatever is connected to a real AudioContext's destination goes through a
 *     gain at 0 instead (analysers and everything before the destination are untouched; an
 *     OfflineAudioContext renders to a buffer, not a speaker, so it is left alone).
 * It does not touch speechSynthesis: no script turns the app's spoken announcements on
 * without replacing it (the lint checks that too).
 *
 * src/tests/e2eMuted.test.ts runs silencePage() on a page's prototypes and shows each of
 * these holding.
 */

/** Runs in the page, before its scripts. Self-contained: Playwright sends its source. */
export function silencePage() {
    const P = globalThis.HTMLMediaElement && HTMLMediaElement.prototype;
    const muted = P && Object.getOwnPropertyDescriptor(P, 'muted');
    if (!muted || !muted.get || !muted.set || P.__pucaSilenced) return;
    Object.defineProperty(P, '__pucaSilenced', { value: true });
    /** What the page set, which is what it reads back; the element itself stays muted. */
    const asked = new WeakMap();
    const hush = (el) => {
        if (!asked.has(el)) asked.set(el, muted.get.call(el));
        muted.set.call(el, true);
    };
    Object.defineProperty(P, 'muted', {
        configurable: true,
        enumerable: muted.enumerable,
        get() { return asked.has(this) ? asked.get(this) : muted.get.call(this); },
        set(value) { asked.set(this, Boolean(value)); muted.set.call(this, true); },
    });
    const play = P.play;
    P.play = function (...args) { hush(this); return play.apply(this, args); };
    const load = P.load;
    P.load = function (...args) { hush(this); return load.apply(this, args); };
    // Given something to play, or told to play it by itself: muted first.
    for (const name of ['src', 'srcObject', 'autoplay']) {
        const d = Object.getOwnPropertyDescriptor(P, name);
        if (d && d.set) Object.defineProperty(P, name, { ...d, set(value) { hush(this); d.set.call(this, value); } });
    }
    const setAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (...args) {
        if (this instanceof HTMLMediaElement) hush(this);
        return setAttribute.apply(this, args);
    };
    // An element the parser makes (the page's own HTML, innerHTML, document.write) goes
    // through none of the above, and can start by itself (autoplay): muted as it is put in
    // the page. A mutation callback runs long before any of its media could have loaded.
    // Not an event listener: document.open() (Playwright's setContent) erases those.
    const hushTree = (node) => {
        if (node instanceof HTMLMediaElement) hush(node);
        else if (node.querySelectorAll) node.querySelectorAll('audio, video').forEach(hush);
    };
    new MutationObserver((records) => {
        for (const r of records) r.addedNodes.forEach(hushTree);
    }).observe(document, { childList: true, subtree: true });
    for (const type of ['loadstart', 'loadedmetadata', 'play', 'playing']) {
        // Media events do not bubble; a capturing listener on the window still hears them.
        addEventListener(type, (e) => { if (e.target instanceof HTMLMediaElement) hush(e.target); }, true);
    }

    if (typeof AudioNode === 'undefined' || typeof AudioDestinationNode === 'undefined') return;
    const N = AudioNode.prototype;
    const connect = N.connect;
    const disconnect = N.disconnect;
    const Offline = typeof OfflineAudioContext === 'undefined' ? null : OfflineAudioContext;
    /** Per context, a gain at 0 standing in front of its destination. */
    const standIns = new WeakMap();
    const standInFor = (destination) => {
        const ctx = destination.context;
        if (Offline && ctx instanceof Offline) return destination;
        let gain = standIns.get(ctx);
        if (!gain) {
            gain = ctx.createGain();
            gain.gain.value = 0;
            connect.call(gain, destination);
            standIns.set(ctx, gain);
        }
        return gain;
    };
    N.connect = function (target, ...rest) {
        if (target instanceof AudioDestinationNode) {
            connect.call(this, standInFor(target), ...rest);
            return target; // what connect() returns, for chaining
        }
        return connect.call(this, target, ...rest);
    };
    N.disconnect = function (...args) {
        if (args[0] instanceof AudioDestinationNode) args[0] = standInFor(args[0]);
        return disconnect.apply(this, args);
    };
}

/**
 * The same WebKit browser, every context of it (and every page made straight from it)
 * silenced before the page's own script runs. Returns the browser it was given.
 */
export function muteWebkit(browser) {
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async (...args) => {
        const context = await newContext(...args);
        await context.addInitScript(silencePage);
        return context;
    };
    // browser.newPage() makes a context of its own; make it here so it is silenced first,
    // and close it with the page, as Playwright's own does.
    browser.newPage = async (...args) => {
        const context = await browser.newContext(...args);
        const page = await context.newPage();
        const close = page.close.bind(page);
        page.close = async (...a) => { await close(...a); await context.close(); };
        return page;
    };
    return browser;
}
