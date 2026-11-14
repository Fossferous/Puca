/**
 * Tells the server, on each socket, when THIS page cannot show a notification
 * by itself, so that this browser is sent a Web Push instead
 * (`SetPushAway`, src/wake/sender.rs).
 *
 * THE BUG IT ENDS. A browser that turned Web Push on is pushed only while it
 * is AWAY, and that is judged per browser (the desktop app in the tray must
 * not silence the phone): until now, away meant "no live socket". An iPhone's
 * or iPad's Home Screen app sent to the background is frozen by iOS within
 * seconds, but its socket stays up until the server's idle reaper takes it,
 * 75 s later. For that minute the server counted the browser open and pushed
 * nothing, and the frozen page showed nothing either: every message in about
 * the first minute after leaving the app went unannounced. Android's browsers
 * do the same, and Chrome there cannot raise a notification from a page at
 * all (`new Notification()` throws), so they heard nothing until the reaper.
 *
 * WHICH PAGES SAY SO, and only once this account has turned Web Push on in
 * this browser (there is nothing to wake otherwise):
 *  - the web app on an iPhone, iPad or Android device while it is hidden;
 *  - any web page being left (`pagehide`): it will show nothing more.
 * NOT a hidden tab or a minimised window of a desktop browser: that page keeps
 * running and shows its own notification for each conversation
 * (desktopNotify.ts), and a push besides would be every message twice. Not
 * the desktop or Android apps, nor an embedding host: they have their own
 * paths and never use Web Push (webPushEnvironment).
 *
 * While it has said so, the page raises no message notification of its own
 * (desktopNotify.ts asks `pageToldAwayForPush`): the push IS that message's
 * notification, shown by the service worker (public/sw.js). Back on screen it
 * says so, and the server stops pushing: the open page shows what arrives.
 *
 * Never sent unless THIS socket's server confirmed `push_away` in
 * ServerFeatures: an older server answers an unknown frame with an Error,
 * which the chat view shows as a notice. With an older server everything
 * stays as it was (pushed once the socket is gone). A fresh connection is
 * present on the server, so a socket that confirms it while the page is away
 * is told at once, as `carried` when the page has been away without a break
 * since it last said so (a phone that reconnected in the background): the
 * server keeps the moment it really left. Transitions only; the push itself
 * still carries nothing but the constant {"w":"1"}.
 */
import { wsClient } from './websocket';
import { isAppleTouchDevice, OPT_IN_EVENT, webPushEnabledHere, webPushEnvironment } from './webPush';
import { setPageToldAwayForPush } from './webPushLocal';

/** The capability, in the one `caps=` list (CLIENT_CAPS) and ServerFeatures. */
export const PUSH_AWAY_FEATURE = 'push_away';

export interface AwayInputs {
    /** Web Push applies here and this account turned it on in this browser. */
    pushOn: boolean;
    /** A hidden page here cannot show its own notification (iOS, Android). */
    hiddenCannotNotify: boolean;
    /** document.visibilityState is 'hidden'. */
    hidden: boolean;
    /** pagehide, with no pageshow or return to the screen since. */
    leaving: boolean;
}

/** The rule: true = tell the server this page cannot notify by itself. */
export function decideAway(i: AwayInputs): boolean {
    if (!i.pushOn) return false;
    return i.leaving || (i.hidden && i.hiddenCannotNotify);
}

/** Does a hidden page on this device stop being able to notify by itself?
 *  iPhone and iPad (iOS freezes a page in the background, the Home Screen
 *  app included; an iPad asking for the desktop site says "Macintosh") and
 *  Android (Chrome there has no page notifications at all, and freezes a
 *  backgrounded page). A desktop browser's hidden page keeps running. */
export function hiddenPageCannotNotify(userAgent: string, maxTouchPoints: number): boolean {
    return isAppleTouchDevice(userAgent, maxTouchPoints) || /Android/i.test(userAgent);
}

export interface AwayReporterOptions {
    /** Override "Web Push is on here" (tests). */
    pushOn?: () => boolean;
    /** Override the device rule (tests). */
    hiddenCannotNotify?: () => boolean;
}

/** Start reporting; returns the stop function. One per signed-in session. */
export function startWebPushAwayReporter(opts: AwayReporterOptions = {}): () => void {
    const pushOn = opts.pushOn ?? (() => webPushEnvironment() === 'ok' && webPushEnabledHere());
    const cannotNotify = opts.hiddenCannotNotify
        ?? (() => hiddenPageCannotNotify(navigator.userAgent ?? '', navigator.maxTouchPoints ?? 0));
    // What THIS socket's server was last told. A connection starts present.
    let told = false;
    // Away without a break since the last "away" this page sent, on any
    // socket? Only then may a new socket's first "away" be `carried`: a page
    // that was on screen in between (with no socket up to hear it) came
    // back, and the server must hear a new departure, or the answer to a
    // reply sent from there is held back as part of the old burst.
    let awayUnbroken = false;
    let leaving = false;
    let stopped = false;

    const hidden = () => document.visibilityState === 'hidden';
    const tell = (away: boolean, carried = false) => {
        if (stopped || !wsClient.hasServerFeature(PUSH_AWAY_FEATURE)) return;
        if (away === told) return; // transitions only
        const payload = away && carried && awayUnbroken ? { away, carried: true } : { away };
        if (wsClient.send({ type: 'SetPushAway', payload })) {
            told = away;
            setPageToldAwayForPush(away);
            if (away) awayUnbroken = true;
        }
    };
    /** The rule, now; a page that is not away has broken any away stretch. */
    const decideNow = () => {
        const away = decideAway({ pushOn: pushOn(), hiddenCannotNotify: cannotNotify(), hidden: hidden(), leaving });
        if (!away) awayUnbroken = false;
        return away;
    };
    const evaluate = () => {
        tell(decideNow());
    };

    const onVisibility = () => {
        // A page on screen is not being left, whatever came before: iOS can
        // fire pagehide for a Home Screen app going to the background and
        // only visibilitychange when it comes back.
        if (!hidden()) leaving = false;
        evaluate();
    };
    const onPageHide = () => {
        leaving = true;
        evaluate();
    };
    const onPageShow = () => {
        leaving = false;
        evaluate();
    };
    const onFeatures = () => {
        // A new server session: it holds this connection present. A page
        // that has been away without a break since it last said so (a
        // reconnect in the background, a network change) says `carried`, so
        // the server keeps the moment the page really left and names what
        // came since; one that was on screen in between says a plain `away`.
        told = false;
        setPageToldAwayForPush(false);
        tell(decideNow(), true);
    };
    const onClosed = () => {
        told = false;
        setPageToldAwayForPush(false);
    };

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener(OPT_IN_EVENT, evaluate);
    window.addEventListener('wsClosed', onClosed);
    wsClient.on('ServerFeatures', onFeatures);

    // The socket may have confirmed the capability before this started.
    evaluate();

    return () => {
        // Leave the server as a fresh connection would find it, so whatever
        // starts next on this socket begins from the truth.
        if (told) tell(false);
        stopped = true;
        setPageToldAwayForPush(false);
        document.removeEventListener('visibilitychange', onVisibility);
        window.removeEventListener('pagehide', onPageHide);
        window.removeEventListener('pageshow', onPageShow);
        window.removeEventListener(OPT_IN_EVENT, evaluate);
        window.removeEventListener('wsClosed', onClosed);
        wsClient.off('ServerFeatures', onFeatures);
    };
}
