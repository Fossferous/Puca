/**
 * `/invite/:code` — where an invite link lands.
 *
 * Mostly nothing renders here. The code is stashed (api/pendingInvite) and
 * the visitor is sent on: signed in, straight to /chat, which opens the join
 * flow with the code looked up; signed out, to /login, which mentions the
 * waiting invite and hands it on after sign-in or registration. A malformed
 * code falls through to the ordinary landing route.
 *
 * In a desktop browser on Windows it first OFFERS the desktop app: an invite
 * clicked in another program (a browser, a game launcher, a chat app) always
 * opens here, because Windows cannot give an https link to a desktop app.
 * "Open in the Púca app" is a `puca://invite/<code>?host=<this host>` link,
 * which the desktop installer registers (api/deepLink.ts); "Continue in the
 * browser" is the flow above. "Always open invites in the app" remembers the
 * choice in this browser, and later visits then try the app link ONCE by
 * themselves — never without that choice, because some browsers answer a
 * scheme nothing has registered with an error. The browser flow stays one
 * click away either way.
 */
import { useEffect, useRef, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { isAuthenticated } from '../api/auth';
import { parseInviteCode, stashPendingInvite } from '../api/pendingInvite';
import {
    appInviteLink, appLauncher, fetchDesktopDownloadUrl, offersDesktopAppLink,
    remembersOpenInApp, setRemembersOpenInApp,
} from '../api/deepLink';
import './Login.css';
import './InviteLanding.css';

export function InviteLanding() {
    const { code: raw } = useParams<{ code: string }>();
    const code = parseInviteCode(raw ?? '');
    if (!code) return <Navigate to="/" replace />;
    // null when this is not a Windows desktop browser, or this page's host
    // cannot be carried in the link (an IPv6 literal, say).
    const appLink = offersDesktopAppLink() ? appInviteLink(code, window.location.hostname) : null;
    if (!appLink) return <ContinueInBrowser code={code} />;
    return <OfferDesktopApp code={code} appLink={appLink} />;
}

/** The web flow: stash the code, then sign in or go straight to Chat. */
function ContinueInBrowser({ code }: { code: string }) {
    // Stash in an effect, not during render: React may render this twice
    // (StrictMode) and rendering must stay side-effect free.
    useEffect(() => {
        stashPendingInvite(code);
    }, [code]);
    return <Navigate to={isAuthenticated() ? '/chat' : '/login'} replace />;
}

function OfferDesktopApp({ code, appLink }: { code: string; appLink: string }) {
    const navigate = useNavigate();
    const [remember, setRemember] = useState(remembersOpenInApp);
    // Whether the app link has been tried, by a click or by the remembered
    // choice on arrival — then say what to do if nothing opened.
    const [tried, setTried] = useState(remembersOpenInApp);
    const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
    const autoOpened = useRef(false);

    // The remembered choice: the app link, once per visit. The ref, not only
    // the dependency list: StrictMode runs this effect twice on mount.
    useEffect(() => {
        if (autoOpened.current || !remembersOpenInApp()) return;
        autoOpened.current = true;
        appLauncher.open(appLink);
    }, [appLink]);

    // Where to get the app, from the release file the desktop app itself
    // reads (GET /app-version). Only once there is a reason to ask.
    useEffect(() => {
        if (!tried) return;
        let live = true;
        void fetchDesktopDownloadUrl().then(url => { if (live) setDownloadUrl(url); });
        return () => { live = false; };
    }, [tried]);

    const continueInBrowser = () => {
        stashPendingInvite(code);
        navigate(isAuthenticated() ? '/chat' : '/login', { replace: true });
    };

    return (
        <div className="login-container">
            <div className="login-card invite-landing">
                <h1 className="login-title">Púca</h1>
                <p className="login-subtitle">You've been invited to a server</p>

                <div className="invite-landing-actions">
                    {/* A real link, so the browser itself asks the system for
                        the app — and a middle click or "copy link" still works. */}
                    <a className="login-button invite-landing-open" href={appLink} onClick={() => setTried(true)}>
                        Open in the Púca app
                    </a>
                    <button type="button" className="invite-landing-browser" onClick={continueInBrowser}>
                        Continue in the browser
                    </button>
                </div>

                <label className="checkbox-label invite-landing-remember">
                    <input
                        type="checkbox"
                        checked={remember}
                        onChange={e => {
                            setRemember(e.target.checked);
                            setRemembersOpenInApp(e.target.checked);
                        }}
                    />
                    <span className="checkbox-text">Always open invites in the app</span>
                </label>

                {tried && (
                    <p className="invite-landing-help" role="status">
                        Nothing opened? The Púca desktop app may not be installed on this computer.{' '}
                        {downloadUrl ? (
                            <>
                                <a href={downloadUrl} target="_blank" rel="noopener noreferrer">Get the desktop app</a>
                                , or continue in the browser.
                            </>
                        ) : 'Install it, or continue in the browser.'}
                    </p>
                )}
            </div>
        </div>
    );
}
