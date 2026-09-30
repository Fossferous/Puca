/**
 * Why a `puca://` invite link was NOT looked up — the desktop app's answer
 * when a link's `?host=` is not confirmed as this server's web app
 * (api/deepLink.ts `checkInviteHost`). This app talks to one server, so the
 * code is only looked up there when the link is known to be for it: a code
 * looked up on the wrong server could name a different server entirely.
 *
 * Three reasons, each said as what it is:
 *  - another-server: the server named its web address, and it is not this;
 *  - unreachable: the server could not be asked (offline, restarting) —
 *    Try again asks once more, and on a yes Join a Server opens;
 *  - unconfirmed: the server answered but names no web address, so there is
 *    nothing to compare with.
 * A failure to check is never reported as "another server".
 *
 * Mounted once, beside App's routes, so it shows over the sign-in screen and
 * over Chat alike.
 */
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { dismissDeepLinkNotice, getDeepLinkNotice, retryDeepLinkNotice, subscribeDeepLinkNotice } from '../api/deepLink';
import { isAuthenticated } from '../api/auth';
import { CloseIcon } from './Icons';
import './Modal.css';
import './DeepLinkNotice.css';

export function DeepLinkNotice() {
    const notice = useSyncExternalStore(subscribeDeepLinkNotice, getDeepLinkNotice, getDeepLinkNotice);
    const [checking, setChecking] = useState(false);

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
    const server = isAuthenticated() ? 'the server this app is signed in to' : 'the server this app signs in to';
    const host = <strong>{notice.host}</strong>;
    const tryAgain = () => {
        setChecking(true);
        void retryDeepLinkNotice().finally(() => setChecking(false));
    };

    let title: string;
    let body: ReactNode;
    let hint: string;
    switch (notice.kind) {
        case 'another-server':
            title = 'An invite for another server';
            body = <>This invite is for {host}, not {server}.</>;
            hint = 'Nothing was looked up or joined. To accept it, open the invite link in your web '
                + 'browser, or in a Púca app that uses that server.';
            break;
        case 'unreachable':
            title = 'Could not check this invite';
            body = <>This invite link comes from {host}, and Púca could not get an answer from {server},
                so it cannot check that it is the same server.</>;
            hint = 'Nothing was looked up or joined. Try again in a moment, or open the invite link in '
                + 'your web browser.';
            break;
        case 'unconfirmed':
            title = 'Could not check this invite';
            body = <>This invite link comes from {host}, but {server} does not say what its web address
                is, so Púca cannot check that it is the same server.</>;
            hint = 'Nothing was looked up or joined. Open the invite link in your web browser instead.';
            break;
    }

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
                    <h2 id="deep-link-notice-title">{title}</h2>
                    <button className="close-button" onClick={dismissDeepLinkNotice} aria-label="Close">
                        <CloseIcon size={18} />
                    </button>
                </div>
                <p id="deep-link-notice-body" className="deep-link-notice-body">{body}</p>
                <p className="deep-link-notice-hint">{hint}</p>
                <div className="modal-actions">
                    {notice.kind === 'unreachable' ? (
                        <>
                            <button className="secondary-button" onClick={dismissDeepLinkNotice}>Close</button>
                            <button className="primary-button" onClick={tryAgain} disabled={checking} autoFocus>
                                {checking ? 'Checking…' : 'Try again'}
                            </button>
                        </>
                    ) : (
                        <button className="primary-button" onClick={dismissDeepLinkNotice} autoFocus>OK</button>
                    )}
                </div>
            </div>
        </div>
    );
}
