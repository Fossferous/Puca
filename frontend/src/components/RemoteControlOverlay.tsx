/**
 * Host-side remote-control UI (global overlay):
 * - approval prompt when a viewer requests control,
 * - a persistent "X is controlling your screen" banner with a Stop kill switch,
 * - a transient notice toast (denials, anti-cheat blocks, session ended).
 *
 * The viewer-side "Request control / Controlling…" UI lives on the stream tile
 * in StreamStage. This component also wires the control manager on mount.
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
    type ControlState,
} from '../api/remoteControl';
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
            {/* Approval prompt (host) */}
            {ctrl.incomingRequest && (
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
                <div className="rc-banner" role="status">
                    <span className="rc-banner-dot" />
                    <span className="rc-banner-text">
                        <strong>{ctrl.controlledBy.username}</strong> is controlling your screen
                        <span className="rc-banner-hint">{killSwitchHint()}</span>
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
