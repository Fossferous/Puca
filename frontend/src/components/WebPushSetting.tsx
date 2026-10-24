/**
 * Settings → Notifications → "Notifications while Púca is closed", for the
 * web app (api/webPush.ts). Renders nothing in the desktop and Android apps
 * and inside an embedding host: each notifies its own way, and a second
 * switch there would only double every notification.
 *
 * The switch asks the browser for permission from the tap itself — iOS
 * refuses a prompt that did not come from one. Where Web Push cannot work,
 * the row says why instead of offering a switch that would do nothing: an
 * iPhone Safari tab (only a Home Screen app has it), an old browser, a server
 * whose operator has not set it up, or a permission the user blocked.
 */
import { useEffect, useState, type ReactNode } from 'react';
import {
    disableWebPush,
    enableWebPush,
    fetchServerKey,
    sendTestPush,
    webPushEnvironment,
    type WebPushEnvironment,
} from '../api/webPush';
import { loadSettings } from './settingsStore';

const LABEL = 'Notifications while Púca is closed';
const PRIVACY =
    'Your browser’s push service (Apple, Google, Mozilla or Microsoft) learns only that something ' +
    'arrived and when — never who or what. A notification names the sender, never the message.';

function permissionNow(): NotificationPermission | null {
    try {
        return typeof Notification === 'undefined' ? null : Notification.permission;
    } catch {
        return null;
    }
}

export default function WebPushSetting() {
    const [env] = useState<WebPushEnvironment>(() => webPushEnvironment());
    // undefined = still asking the server; null = it has no key.
    const [serverKey, setServerKey] = useState<string | null | undefined>(undefined);
    const [enabled, setEnabled] = useState(() => loadSettings().webPushEnabled);
    const [permission, setPermission] = useState(permissionNow);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState<string | null>(null);

    useEffect(() => {
        if (env !== 'ok') return;
        let live = true;
        void fetchServerKey().then((k) => { if (live) setServerKey(k); });
        const onSettings = () => setEnabled(loadSettings().webPushEnabled);
        window.addEventListener('settingsChanged', onSettings);
        return () => {
            live = false;
            window.removeEventListener('settingsChanged', onSettings);
        };
    }, [env]);

    if (env === 'native-app' || env === 'embedded') return null;

    const row = (hint: string, control?: ReactNode) => (
        <div className="settings-option" data-testid="web-push-setting">
            <div className="option-info">
                <label>{LABEL}</label>
                <span className="option-hint">{hint}</span>
            </div>
            {control}
        </div>
    );

    if (env === 'ios-needs-home-screen') {
        return row(
            'On iPhone and iPad, only Púca on your Home Screen can get notifications — not a Safari tab. ' +
            'In Safari, tap Share, then Add to Home Screen, open Púca from the new icon, and turn this on there.',
        );
    }
    if (env === 'unsupported') {
        return row(
            'This browser cannot get notifications while Púca is closed. On iPhone and iPad this needs ' +
            'iOS 16.4 or later; elsewhere, use a current Chrome, Edge, Firefox or Safari.',
        );
    }
    if (serverKey === undefined) return row('Checking whether your server supports this…');
    if (serverKey === null) {
        return row(
            'Your server has not set up push notifications yet. Its operator turns them on with a VAPID key ' +
            '(see the server’s configuration guide).',
        );
    }
    if (permission === 'denied') {
        return row(
            'Notifications are blocked for this site in your browser. Allow them in the browser’s site ' +
            'settings (on iPhone: Settings → Notifications → Púca), then come back here.',
        );
    }

    const onToggle = (want: boolean) => {
        setMessage(null);
        setBusy(true);
        const done = (msg: string | null) => {
            setBusy(false);
            setMessage(msg);
            setPermission(permissionNow());
            setEnabled(loadSettings().webPushEnabled);
        };
        if (!want) {
            void disableWebPush().then(() => done(null), () => done(null));
            return;
        }
        // enableWebPush asks for permission FIRST, inside this tap.
        void enableWebPush().then(
            (r) => {
                if (r.ok) done(null);
                else if (r.reason === 'denied') done('The browser did not allow notifications.');
                else if (r.reason === 'not-configured') done('Your server has not set up push notifications.');
                else done(`Could not turn notifications on${r.detail ? `: ${r.detail}` : '.'}`);
            },
            () => done('Could not turn notifications on.'),
        );
    };

    return (
        <>
            {row(
                `Get a notification when something arrives while Púca is closed on this device. ${PRIVACY}`,
                <input
                    type="checkbox"
                    aria-label={LABEL}
                    checked={enabled}
                    disabled={busy}
                    onChange={(e) => onToggle(e.target.checked)}
                />,
            )}
            {enabled && (
                <div className="settings-option">
                    <div className="option-info">
                        <label>Test notification</label>
                        <span className="option-hint" role="status">
                            {message ?? 'Sends one to this device now. If Púca is on screen, look in your notifications.'}
                        </span>
                    </div>
                    <button
                        className="secondary-btn"
                        disabled={busy}
                        onClick={() => {
                            setBusy(true);
                            setMessage(null);
                            void sendTestPush().then(
                                () => { setBusy(false); setMessage('Sent. It should appear in a few seconds.'); },
                                (err: unknown) => {
                                    setBusy(false);
                                    setMessage(err instanceof Error ? err.message : 'The test could not be sent.');
                                },
                            );
                        }}
                    >
                        Send a test
                    </button>
                </div>
            )}
            {!enabled && message && (
                <div className="settings-option">
                    <span className="option-hint" role="status">{message}</span>
                </div>
            )}
        </>
    );
}
