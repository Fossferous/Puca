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
 *     attribute), as the parser puts it in the page or in a shadow root (autoplay in the
 *     page's own HTML), and on loadstart / play / playing. Unmuted from outside script
 *     (its own controls), it reads unmuted, as it would, and is muted again underneath;
 *   - Web Audio: whatever is connected to a real AudioContext's destination goes through a
 *     gain at 0 instead (an OfflineAudioContext renders to a buffer, not a speaker, so it
 *     is left alone). Playwright's Windows WebKit has no Web Audio at all.
 * What a page can tell: a muted element plays silence into anything that reads it
 * (createMediaElementSource, captureStream), and play() is always a muted play, so an
 * autoplay policy that refuses unmuted playback never refuses here. Not covered: an
 * element the parser makes in a tree never put in the page (or a declarative shadow
 * root) that then plays by itself, and a src or autoplay attribute given through
 * element.attributes (setNamedItem) or an Attr's value. speechSynthesis is not touched: no script turns the
 * app's spoken announcements on without replacing it (the lint checks that).
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
    const watched = new WeakSet();
    const watch = (el) => {
        if (watched.has(el)) return;
        watched.add(el);
        // Unmuted by something other than script (the element's own controls): the page
        // reads it unmuted, as it would, and underneath it is muted again at once.
        el.addEventListener('volumechange', () => {
            if (!muted.get.call(el)) { asked.set(el, false); muted.set.call(el, true); }
        });
    };
    const hush = (el) => {
        if (!asked.has(el)) asked.set(el, muted.get.call(el));
        muted.set.call(el, true);
        watch(el);
    };
    Object.defineProperty(P, 'muted', {
        configurable: true,
        enumerable: muted.enumerable,
        // Unmuted underneath can only be someone else's doing (this setter never does it):
        // that is the truth, so it is what the page reads.
        get() { return muted.get.call(this) && (asked.has(this) ? asked.get(this) : true); },
        set(value) { asked.set(this, Boolean(value)); muted.set.call(this, true); watch(this); },
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
    for (const name of ['setAttribute', 'setAttributeNS', 'toggleAttribute']) {
        const original = Element.prototype[name];
        if (!original) continue;
        Element.prototype[name] = function (...args) {
            if (this instanceof HTMLMediaElement) hush(this);
            return original.apply(this, args);
        };
    }
    // new Audio(url) sets its src without the setter: muted as it is made.
    const NativeAudio = globalThis.Audio;
    if (typeof NativeAudio === 'function') {
        const Audio = function Audio(...args) {
            const el = new NativeAudio(...args);
            hush(el);
            return el;
        };
        Audio.prototype = NativeAudio.prototype;
        globalThis.Audio = Audio;
    }
    // An element the parser makes (the page's own HTML, innerHTML, document.write) goes
    // through none of the above, and can start by itself (autoplay): muted as it is put in
    // the page. A mutation callback runs long before any of its media could have loaded.
    // Not an event listener: document.open() (Playwright's setContent) erases those.
    const hushTree = (node) => {
        if (node instanceof HTMLMediaElement) hush(node);
        else if (node.querySelectorAll) node.querySelectorAll('audio, video').forEach(hush);
    };
    const inserted = new MutationObserver((records) => {
        for (const r of records) r.addedNodes.forEach(hushTree);
    });
    const tree = { childList: true, subtree: true };
    inserted.observe(document, tree);
    // A shadow root is a tree of its own, which observing the document does not reach.
    const attachShadow = Element.prototype.attachShadow;
    if (attachShadow) {
        Element.prototype.attachShadow = function (...args) {
            const root = attachShadow.apply(this, args);
            inserted.observe(root, tree);
            return root;
        };
    }
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
