/**
 * "This invite is for another server" — the desktop app's answer to a
 * `puca://` invite link whose `?host=` names a web app that is not this
 * server's (api/deepLink.ts). This app talks to one server, so the code is
 * NOT looked up here: a code looked up on the wrong server could name a
 * different server entirely. Mounted once, beside App's routes, so it shows
 * over the sign-in screen and over Chat alike.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { dismissDeepLinkNotice, getDeepLinkNotice, subscribeDeepLinkNotice } from '../api/deepLink';
import { isAuthenticated } from '../api/auth';
import { CloseIcon } from './Icons';
import './Modal.css';
import './DeepLinkNotice.css';

export function DeepLinkNotice() {
    const notice = useSyncExternalStore(subscribeDeepLinkNotice, getDeepLinkNotice, getDeepLinkNotice);

    // Escape closes THIS, and only this: it is on top of whatever was open
    // (Settings, a call's dialogs), and one press must not close those too.
    useEffect(() => {
        if (!notice) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            e.preventDefault();
            e.stopImmediatePropagation();
            dismissDeepLinkNotice();
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [notice]);

    if (!notice) return null;
    return (
        <div className="modal-overlay deep-link-notice-overlay" onClick={dismissDeepLinkNotice}>
            <div
                className="modal-content deep-link-notice"
                role="alertdialog"
                aria-modal="true"
                aria-labelledby="deep-link-notice-title"
                aria-describedby="deep-link-notice-body"
                onClick={e => e.stopPropagation()}
            >
                <div className="modal-header">
                    <h2 id="deep-link-notice-title">An invite for another server</h2>
                    <button className="close-button" onClick={dismissDeepLinkNotice} aria-label="Close">
                        <CloseIcon size={18} />
                    </button>
                </div>
                <p id="deep-link-notice-body" className="deep-link-notice-body">
                    This invite is for <strong>{notice.host}</strong>, not the server this
                    app {isAuthenticated() ? 'is signed in to' : 'signs in to'}.
                </p>
                <p className="deep-link-notice-hint">
                    Nothing was looked up or joined. To accept it, open the invite link in your
                    web browser, or in a Púca app that uses that server.
                </p>
                <div className="modal-actions">
                    <button className="primary-button" onClick={dismissDeepLinkNotice} autoFocus>OK</button>
                </div>
            </div>
        </div>
    );
}
