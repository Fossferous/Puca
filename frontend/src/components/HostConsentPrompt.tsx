/**
 * The dialog shown at the HOST when another of your devices asks to control it
 * and this machine is NOT armed for unattended access.
 *
 * It replaces the browser's "Choose what to share" picker, which until 0.8.4 was
 * the only thing standing between an incoming session and this screen — not by
 * design, but because the agent was never bundled so every host fell back to
 * getDisplayMedia. That picker was unusable for the actual feature (it needs
 * someone at the keyboard, and cannot always be presented on a window minimised
 * to the tray) and it named the requester "http://tauri.localhost", which tells
 * the user nothing about who is asking.
 *
 * This asks the question the picker was accidentally asking, but properly: which
 * of YOUR devices wants in, and which screen it gets.
 *
 * Mounted globally, because the request arrives from the session layer before
 * any device UI exists. Registers with the `hostConsent` bridge, which denies
 * when nothing is mounted — absence is a closed door, not a hang.
 */
import { useEffect, useState } from 'react';
import { setHostConsentHandler, type ConsentRequest } from '../api/devices/hostConsent';
import { ALL_DISPLAYS } from '../api/devices/session';
import './HostConsentPrompt.css';

/** Describe, honestly, what a cross-user share connect is asking for — the
 *  consent surface must not claim "control the mouse and keyboard" for a
 *  view-only or files-only share. Falls back to the full-control wording when
 *  capabilities are absent (an older peer, or same-account). */
function describeShareAsk(caps?: string[]): string {
    const c = caps ?? [];
    const parts: string[] = [];
    if (c.includes('control')) parts.push('see this screen and control the mouse and keyboard');
    else if (c.includes('view_only')) parts.push('see this screen');
    if (c.includes('files')) parts.push("browse this device's files");
    if (parts.length === 0) return 'see this screen and control the mouse and keyboard';
    return parts.join(', and ');
}

export function HostConsentPrompt() {
    const [request, setRequest] = useState<ConsentRequest | null>(null);
    const [monitor, setMonitor] = useState(0);

    // The default screen is chosen as the request ARRIVES, not in a second
    // effect reacting to it. Same result, no cascading render — and it keeps
    // `react-hooks/set-state-in-effect` genuinely clean rather than suppressed.
    // Chosen fresh each time rather than remembering a choice made for a
    // different session on a different day.
    //
    // EVERY SCREEN BY DEFAULT on a multi-monitor machine, the same default an
    // armed host applies for itself (session.ts, before startSession): the
    // composite shows what the machine has, and the viewer can narrow it to
    // one screen from its own picker. The person here can still pick one
    // screen — the selector below offers each — which the viewer's
    // every-screen default then never overrides (it is gated on `unattended`).
    // Only an agent host offers a list at all, and only the agent can capture
    // the composite, so 255 is always honourable here.
    useEffect(() => setHostConsentHandler(req => {
        setMonitor(req.monitors.length > 1 ? ALL_DISPLAYS : (req.monitors[0]?.id ?? 0));
        setRequest(req);
    }), []);

    if (!request) return null;

    const answer = (value: { monitor: number } | null) => {
        request.resolve(value);
        setRequest(null);
    };

    return (
        <div
            className="host-consent-backdrop"
            role="dialog"
            aria-modal="true"
            aria-label="Allow remote control"
            onKeyDown={e => {
                // Escape DENIES rather than dismissing: something is waiting on
                // an answer, and "no answer" is not one of the options.
                if (e.key === 'Escape') answer(null);
            }}
        >
            <div className="host-consent">
                <h2>Let this device be controlled?</h2>
                {/* fromUsername is present only for a cross-user share, and it
                    is server-stamped from the requester's authenticated claims
                    — a peer cannot type a name into this prompt. The
                    same-account copy must not claim a friend's device is "one
                    of your own". */}
                {request.fromUsername ? (
                    <p className="host-consent-body">
                        <strong>{request.fromUsername}</strong> — a friend you shared this
                        device with — is asking to {describeShareAsk(request.capabilities)}.
                    </p>
                ) : (
                    <p className="host-consent-body">
                        <strong>{request.peerDevice}</strong> — one of your own devices — is asking
                        to see this screen and control the mouse and keyboard.
                    </p>
                )}

                {request.monitors.length > 1 && (
                    <label className="host-consent-monitor">
                        Screen to share
                        <select
                            value={monitor}
                            onChange={e => setMonitor(Number(e.target.value))}
                        >
                            <option value={ALL_DISPLAYS}>All displays</option>
                            {request.monitors.map(m => (
                                <option key={m.id} value={m.id}>{m.label}</option>
                            ))}
                        </select>
                    </label>
                )}

                {request.fromUsername ? (
                    <p className="host-consent-hint">
                        You are asked each time because this computer is not armed for
                        unattended access. You can withdraw their access entirely from the
                        Devices view, under Sharing.
                    </p>
                ) : (
                    <p className="host-consent-hint">
                        You are being asked because this computer has no unattended passphrase
                        set. Set one in the Devices view — the Devices button in the left rail,
                        under This device — and it will connect without asking. That is what
                        unattended access means.
                    </p>
                )}

                <div className="host-consent-actions">
                    {/* Focus DENY, not Allow.
                        This dialog appears unprompted, so whatever has focus can
                        be triggered by a Space or Enter the user was aiming at
                        something else — and on this dialog that keypress hands
                        over their screen and input. Neither sibling prompt
                        autofocuses anything; the CSS here already says a mis-tap
                        on Allow is not an acceptable failure mode, so the focus
                        should not sit there either. */}
                    <button
                        type="button"
                        className="host-consent-deny"
                        autoFocus
                        onClick={() => answer(null)}
                    >
                        Deny
                    </button>
                    <button
                        type="button"
                        className="host-consent-allow"
                        onClick={() => answer({ monitor })}
                    >
                        Allow
                    </button>
                </div>
            </div>
        </div>
    );
}
