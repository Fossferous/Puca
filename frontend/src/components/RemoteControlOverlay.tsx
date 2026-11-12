/**
 * Host-side remote-control UI (global overlay):
 * - approval prompt when a viewer requests control,
 * - a persistent "X is controlling your screen" banner with a Stop kill switch,
 * - a transient notice toast (denials, anti-cheat blocks, session ended).
 *
 * The viewer-side "Request control / Controlling…" UI lives on the stream tile
 * in StreamStage. This component also wires the control manager on mount.
 *
 * A PHONE host (the Android app sharing its whole screen, phoneControl.ts) gets
 * its own words: what control of a phone means, and the Accessibility switch
 * Android needs before Allow can do anything (with a way there, and back).
 */
import { useEffect, useState } from 'react';
import {
    subscribeControl,
    respondToControlRequest,
    revokeControl,
    acceptControlOffer,
    declineControlOffer,
    clearNotice,
    initRemoteControl,
    extendControlPrompt,
    type ControlState,
} from '../api/remoteControl';
import {
    onPhoneControlStatusChanged,
    openPhoneControlSettings,
    phoneControlStatus,
    phoneHostPossible,
    refusalWords,
    type PhoneControlStatus,
} from '../api/phoneControl';
import { loadSettings } from './settingsStore';
import { GamepadIcon, StopIcon } from './Icons';
import './RemoteControlOverlay.css';

/** Kill-switch reminder line, reflecting the user's configured hotkey + whether
 *  the revoke-on-any-input option is on. */
function killSwitchHint(): string {
    const s = loadSettings();
    // The kill switch is clearable like any other binding; with none set, Esc
    // (handled by the overlay itself) is still the way out.
    const k = s.remoteControlKillKey;
    const combo = k
        ? [k.ctrl && 'Ctrl', k.alt && 'Alt', k.shift && 'Shift', k.label].filter(Boolean).join('+')
        : 'Esc';
    const base = combo === 'Esc' ? 'Esc' : `${combo} or Esc`;
    return s.remoteControlAnyInputKill
        ? `${base} — or any touch of your mouse/keyboard — stops it instantly`
        : `${base} stops it instantly`;
}

/** How often an open phone prompt asks the phone whether Allow can work yet
 *  (the person may be switching the service on in Android's settings). */
const PHONE_STATUS_POLL_MS = 1500;

/** The phone's answer while its prompt is open: null until it has answered. */
function usePhoneStatus(open: boolean): PhoneControlStatus | null {
    const [status, setStatus] = useState<PhoneControlStatus | null>(null);
    useEffect(() => {
        if (!open) return;
        let live = true;
        const ask = () => { void phoneControlStatus().then((s) => { if (live) setStatus(s); }); };
        ask();
        const timer = setInterval(ask, PHONE_STATUS_POLL_MS);
        const onVisible = () => { if (document.visibilityState === 'visible') ask(); };
        document.addEventListener('visibilitychange', onVisible);
        const offStatus = onPhoneControlStatusChanged(ask);
        return () => {
            live = false;
            clearInterval(timer);
            document.removeEventListener('visibilitychange', onVisible);
            offStatus();
        };
    }, [open]);
    return open ? status : null;
}

function PhoneControlPrompt({ username }: { username: string }) {
    const status = usePhoneStatus(true);
    const refusal = status?.refusal ?? null;
    const serviceOff = refusal === 'service-disabled' || refusal === 'service-off';
    // Android 13+ keeps an APK from outside an app store away from this switch
    // until "Allow restricted settings" in its App info.
    const restricted = serviceOff && (status?.sdk ?? 0) >= 33;
    const ready = !!status && refusal === null;
    return (
        <div className="rc-prompt" role="dialog" aria-modal="true" aria-labelledby="rc-phone-title" data-testid="rc-phone-prompt">
            <div className="rc-prompt-icon"><GamepadIcon size={40} /></div>
            <h3 id="rc-phone-title">Allow control of this phone?</h3>
            <p>
                <strong>{username}</strong> is asking to control this phone: to tap, swipe and type on
                whatever is on your screen, and press Back, Home and Recents.
            </p>
            <p className="rc-prompt-warn">
                They can do anything you could do with this phone unlocked. Only allow someone you
                trust. Stop it any time: Stop at the top of the screen, Stop control in the
                notification, or lock the phone.
            </p>
            {serviceOff && (
                <div className="rc-prompt-setup" data-testid="rc-phone-setup">
                    <p>
                        First turn on <strong>Púca remote control</strong> in Android's Accessibility
                        settings. Android lets Púca tap and type in other apps only with that switch on,
                        and Púca uses it only while you have allowed someone. You can switch it off there
                        again at any time.
                    </p>
                    <button
                        className="rc-btn rc-setup"
                        data-testid="rc-phone-open-settings"
                        onClick={() => { extendControlPrompt(); void openPhoneControlSettings('accessibility'); }}
                    >
                        Open Accessibility settings
                    </button>
                    {restricted && (
                        <>
                            <p className="rc-prompt-note">
                                If Android says it is a restricted setting: open Púca's App info, tap the
                                menu at the top right, choose Allow restricted settings, then try the switch
                                again.
                            </p>
                            <button
                                className="rc-btn rc-setup"
                                onClick={() => { extendControlPrompt(); void openPhoneControlSettings('app'); }}
                            >
                                Open App info
                            </button>
                        </>
                    )}
                </div>
            )}
            {!serviceOff && refusal && (
                <p className="rc-prompt-note" data-testid="rc-phone-refusal">{refusalWords(refusal)}</p>
            )}
            <div className="rc-prompt-actions">
                <button className="rc-btn rc-deny" onClick={() => respondToControlRequest(false)}>
                    Deny
                </button>
                <button
                    className="rc-btn rc-allow"
                    data-testid="rc-phone-allow"
                    disabled={!ready}
                    onClick={() => respondToControlRequest(true)}
                >
                    Allow control
                </button>
            </div>
        </div>
    );
}

export function RemoteControlOverlay() {
    const [ctrl, setCtrl] = useState<ControlState | null>(null);

    useEffect(() => {
        initRemoteControl();
        return subscribeControl(setCtrl);
    }, []);

    // Auto-dismiss the notice toast after a few seconds.
    useEffect(() => {
        if (ctrl?.notice) {
            const t = setTimeout(clearNotice, 5000);
            return () => clearTimeout(t);
        }
    }, [ctrl?.notice]);

    if (!ctrl) return null;

    return (
        <>
            {/* Approval prompt (host): a phone's own, or the desktop's */}
            {ctrl.incomingRequest && phoneHostPossible() && (
                <div className="rc-prompt-backdrop">
                    <PhoneControlPrompt username={ctrl.incomingRequest.username} />
                </div>
            )}
            {ctrl.incomingRequest && !phoneHostPossible() && (
                <div className="rc-prompt-backdrop">
                    <div className="rc-prompt" role="dialog" aria-modal="true">
                        <div className="rc-prompt-icon"><GamepadIcon size={40} /></div>
                        <h3>Allow remote control?</h3>
                        <p>
                            <strong>{ctrl.incomingRequest.username}</strong> is asking to control your
                            shared screen with their mouse and keyboard.
                        </p>
                        <p className="rc-prompt-warn">
                            They'll be able to act on your computer as if sitting at it. Only allow
                            someone you trust — stop anytime with the button, Esc, or by touching
                            your own mouse/keyboard.
                        </p>
                        <p className="rc-prompt-note">
                            Works for ordinary desktop apps and many games. It can't drive
                            administrator/UAC prompts, and some games ignore or restrict remote
                            input — anti-cheat titles are blocked and may still ban injected input.
                        </p>
                        <div className="rc-prompt-actions">
                            <button className="rc-btn rc-deny" onClick={() => respondToControlRequest(false)}>
                                Deny
                            </button>
                            <button className="rc-btn rc-allow" onClick={() => respondToControlRequest(true)}>
                                Allow control
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Offer prompt (viewer): a host is handing me control */}
            {ctrl.offer && (
                <div className="rc-prompt-backdrop">
                    <div className="rc-prompt" role="dialog" aria-modal="true">
                        <div className="rc-prompt-icon"><GamepadIcon size={40} /></div>
                        <h3>Take control?</h3>
                        <p>
                            <strong>{ctrl.offer.username}</strong> is offering you control of their shared
                            screen — you'd drive their mouse and keyboard.
                        </p>
                        <div className="rc-prompt-actions">
                            <button className="rc-btn rc-deny" onClick={declineControlOffer}>
                                No thanks
                            </button>
                            <button className="rc-btn rc-allow" onClick={acceptControlOffer}>
                                Take control
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Persistent banner while being controlled (host) */}
            {ctrl.controlledBy && (
                <div className="rc-banner" role="status" data-testid="rc-banner">
                    <span className="rc-banner-dot" />
                    <span className="rc-banner-text">
                        <strong>{ctrl.controlledBy.username}</strong>
                        {phoneHostPossible() ? ' is controlling this phone' : ' is controlling your screen'}
                        <span className="rc-banner-hint">
                            {phoneHostPossible()
                                ? 'Stop it here, at the top of the screen, from the notification, or by locking the phone'
                                : killSwitchHint()}
                        </span>
                    </span>
                    <button className="rc-btn rc-stop" onClick={revokeControl}>
                        <StopIcon /> Stop control
                    </button>
                </div>
            )}

            {/* Transient notice toast (both roles) */}
            {ctrl.notice && (
                <div className="rc-toast" role="alert" onClick={clearNotice}>
                    {ctrl.notice}
                </div>
            )}
        </>
    );
}
