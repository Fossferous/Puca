import React, { useEffect, useRef, useState } from 'react';
import { type DeviceControlSession, requestMonitor, setPrivacyMode, sendStreamQuality, sendClipboard, sendInput, sendPowerAction, ALL_DISPLAYS } from '../api/devices/session';
import { STREAM_QUALITY_PRESETS, MOBILE_PRESET_LABELS, presetValue } from '../api/devices/streamQualityPresets';
import { sendChord } from '../api/devices/chords';
import { useStreamStore } from '../stores/streamStore';
import {
    GridIcon,
    HandIcon,
    Icon,
    MouseIcon,
    PinchIcon,
    TapDoubleIcon,
    TapIcon,
    TapLongIcon,
    TwoFingerIcon,
    type IconName,
} from './Icons';

export function MoreMenu({ session, onClose, onOpenFiles, onNotice, controlEnabled = true }: {
    session: DeviceControlSession,
    onClose: () => void,
    onOpenFiles: () => void,
    /** Report an action's outcome — the menu closes immediately, so an action
     *  that reports failure as a returned string has nowhere else to say it. */
    onNotice: (message: string) => void,
    /** The stage's "Pause control" state. A paused session must refuse these
     *  the same way it refuses the keyboard overlay — "a control that says it
     *  is off has to be off" — so the entries that inject are not offered. */
    controlEnabled?: boolean,
}) {
    // WHICH ENTRIES INJECT. A view-only share (`session.viewOnly`, whose own
    // contract is "the UI hides input affordances") and a paused session get
    // Browse files only: every other entry would be refused on this side and
    // dropped by the host, and the first version offered them anyway and then
    // said "Not connected" — over a session that was visibly streaming.
    const canControl = controlEnabled && !session.viewOnly;

    // "Shut down…" is the one entry that must not fire on a single tap: the
    // menu turns into a two-button confirmation for it, in place, and a tap
    // anywhere else (the backdrop) simply closes the menu — the same as
    // cancelling. Nothing is sent until the red button is tapped.
    const [confirmShutdown, setConfirmShutdown] = useState(false);
    // The stage knows the peer only by id, so the destructive dialog names the
    // REMOTE machine the way the rest of this surface does ("the device you
    // are controlling") — never "this device", which is the phone in hand.
    const name = 'the device you are controlling';

    // ONLY actions that do something.
    //
    // This menu shipped eleven items of which one worked; the other ten were
    // `() => {/* Stub */}` and closed the menu as if they had. A control that
    // silently does nothing is worse than a missing one — the user believes
    // they locked the remote machine, or blocked its input, and they did not.
    // Add each back with its implementation, not before it.
    type MenuItem = { label: string; icon: IconName; action: () => void; danger?: boolean; input?: boolean };
    const allActions: MenuItem[] = [
        {
            // The desktop bar's Files button is behind `!isMobile`, so a phone
            // mid-session had NO route to the file browser at all — files-only
            // sessions from the Devices list worked while "I'm already looking
            // at the screen" did not.
            label: 'Browse files',
            icon: 'folder',
            action: () => {
                onOpenFiles();
                onClose();
            }
        },
        {
            // Same feature as the desktop bar's button, which had no caller at
            // all until now. Phones are where this earns its keep: typing a
            // long password onto a remote machine with a touch keyboard is the
            // case people give up on.
            label: 'Send clipboard',
            icon: 'copy',
            input: true,
            action: () => {
                void sendClipboard(session.id)
                    .then(err => onNotice(err ?? 'Clipboard sent'))
                    .catch(() => onNotice('Could not send the clipboard'));
                onClose();
            }
        },
        {
            // ONE frame, `{t:'sas'}`, not three keystrokes. Windows will not
            // raise the Secure Attention Sequence for injected keys; the host
            // asks the Puca system service (LocalSystem) to call SendSAS,
            // and a refusal comes back as a visible notice (input-failed).
            label: 'Insert Ctrl + Alt + Del',
            icon: 'keyboard',
            input: true,
            action: () => {
                // "sent" only when it was QUEUED: sendInput refuses silently
                // for a view-only share or a socket that is down, and a note
                // claiming success over a frame that never left the phone is
                // the exact defect the header above says this menu removed.
                // What the HOST could not do arrives later as input-failed.
                if (!sendInput(session.id, { t: 'sas' })) onNotice('Not connected — Ctrl+Alt+Del was not sent');
                else onNotice('Ctrl+Alt+Del sent');
                onClose();
            }
        },
        {
            label: 'Alt + Tab',
            icon: 'keyboard',
            input: true,
            action: () => {
                if (!sendChord(session.id, ['AltLeft'], 'Tab')) onNotice('Not connected — Alt+Tab was not sent');
                onClose();
            }
        },
        {
            label: 'Alt + F4',
            icon: 'keyboard',
            input: true,
            action: () => {
                if (!sendChord(session.id, ['AltLeft'], 'F4')) onNotice('Not connected — Alt+F4 was not sent');
                onClose();
            }
        },
        {
            // DISPLAY POWER (W4). No confirmation on any of the three — undo
            // is one tap away and nothing is lost. The outcome arrives as the
            // host's power-ack / power-failed and renders through the stage's
            // powerNotice line (with per-monitor DDC honesty for
            // keep-primary), or as the 5s "did not respond" for an old host.
            label: 'Turn displays off',
            icon: 'monitor',
            input: true,
            action: () => {
                if (!sendPowerAction(session.id, 'displays_off')) onNotice('Not connected — displays unchanged');
                else onNotice('Turning displays off…');
                onClose();
            }
        },
        {
            label: 'Displays off, keep primary',
            icon: 'monitor',
            input: true,
            action: () => {
                if (!sendPowerAction(session.id, 'displays_off_keep_primary')) onNotice('Not connected — displays unchanged');
                else onNotice('Turning other displays off…');
                onClose();
            }
        },
        {
            label: 'Turn displays on',
            icon: 'monitor',
            input: true,
            action: () => {
                if (!sendPowerAction(session.id, 'displays_on')) onNotice('Not connected — displays unchanged');
                else onNotice('Turning displays on…');
                onClose();
            }
        },
        {
            // TOPOLOGY, not panel power: the non-primary displays are removed
            // from the desktop entirely — windows re-arrange onto the primary
            // and the pointer cannot wander onto a dark screen. The host
            // restores on "Re-enable", on session end, and on its next start,
            // so nothing here can strand the machine.
            label: 'Disable other displays',
            icon: 'monitor',
            input: true,
            action: () => {
                if (!sendPowerAction(session.id, 'displays_detach_others')) onNotice('Not connected — displays unchanged');
                else onNotice('Disabling other displays…');
                onClose();
            }
        },
        {
            label: 'Re-enable displays',
            icon: 'monitor',
            input: true,
            action: () => {
                if (!sendPowerAction(session.id, 'displays_reattach')) onNotice('Not connected — displays unchanged');
                else onNotice('Re-enabling displays…');
                onClose();
            }
        },
        {
            // No confirmation: nothing is lost by a lock, and on a machine
            // with sign-in-screen access the session simply follows it there.
            // Without that access the follow gives up with a message saying
            // so, and the picture is gone until someone unlocks — annoying,
            // never destructive, which is the line "Shut down…" is on the
            // other side of.
            label: 'Lock',
            icon: 'lock',
            input: true,
            action: () => {
                if (!sendPowerAction(session.id, 'lock')) onNotice('Not connected — could not lock');
                else onNotice(`Locking ${name}…`);
                onClose();
            }
        },
        {
            label: 'Shut down…',
            icon: 'power',
            danger: true,
            input: true,
            action: () => setConfirmShutdown(true),
        },
    ];
    const actions = allActions.filter(item => canControl || !item.input);

    if (confirmShutdown) {
        return (
            <div className="device-stage-mobile-menu device-stage-mobile-confirm" role="alertdialog" aria-labelledby="dsm-confirm-title">
                <div className="device-stage-mobile-confirm-text">
                    <strong id="dsm-confirm-title">Shut down {name}?</strong>
                    <span>It will power off and this session will end. Anything unsaved on it may be lost.</span>
                </div>
                <div className="device-stage-mobile-confirm-actions">
                    <button type="button" className="device-stage-mobile-confirm-btn" onClick={() => { setConfirmShutdown(false); onClose(); }}>
                        Cancel
                    </button>
                    <button
                        type="button"
                        className="device-stage-mobile-confirm-btn danger"
                        onClick={() => {
                            if (!sendPowerAction(session.id, 'shutdown')) onNotice('Not connected — could not shut down');
                            else onNotice('Shutting down…');
                            setConfirmShutdown(false);
                            onClose();
                        }}
                    >
                        Shut down
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className="device-stage-mobile-menu">
            {actions.map((item, i) => (
                <div key={i} className={`device-stage-mobile-menu-item${item.danger ? ' danger' : ''}`} onClick={item.action}>
                    <span className="label">{item.label}</span>
                    <span className="icon"><Icon name={item.icon} /></span>
                </div>
            ))}
        </div>
    );
}

/** Drop the "(2560x1440)" the desktop picker wants — there is no room for it on
 *  a phone, and the tab is already the smallest thing that identifies a screen. */
function shortLabel(label: string): string {
    return label.replace(/\s*\(\d+\s*[x×]\s*\d+\)\s*$/i, '');
}

export function MonitorMenu({ session, onClose }: { session: DeviceControlSession, onClose: () => void }) {
    // SELECTION COMES FROM THE HOST, never from the click.
    //
    // This kept its own `tab` state and set it optimistically, so a switch the
    // host REFUSED still moved the highlight — which is precisely how "All
    // Displays" looked like it worked for as long as it was broken. The desktop
    // picker has always derived from `activeMonitor` for exactly this reason.
    const active = session.activeMonitor ?? session.monitors[0]?.id;

    // CLOSE ONCE THE SCREEN HAS ACTUALLY SWITCHED — and `onClose` was being
    // dropped entirely: the prop was declared in the type and then not
    // destructured, so picking a screen left the sheet sitting over the very
    // picture it had just changed.
    //
    // Waiting for the host's confirmation rather than closing on the tap is
    // the same rule as the highlight above. A switch can be refused (a screen
    // that vanished, a deadline missed); closing optimistically would hide the
    // menu AND the fact that nothing moved, leaving the user looking at the
    // old screen wondering what they did wrong. Refused means the sheet stays
    // open with the old tab still highlighted, which is the honest answer.
    const requested = useRef<number | null>(null);
    const pick = (id: number) => {
        requested.current = id;
        requestMonitor(session.id, id);
    };
    useEffect(() => {
        if (requested.current !== null && active === requested.current) {
            requested.current = null;
            onClose();
        }
    }, [active, onClose]);

    // Same construction as the desktop select (DeviceStage): show the pending
    // change if one is in flight, else what the host confirmed, else the
    // default the session starts on.
    const confirmedQuality = useStreamStore(s => s.qualities[session.id]);
    const pendingQuality = useStreamStore(s => s.pendingQualities[session.id]);
    const shown = pendingQuality ?? confirmedQuality;
    const quality = shown ? `${shown.bitrate},${shown.fps}` : '6000,30';

    return (
        <div className="device-stage-mobile-menu menu-center" style={{ height: '70vh' }}>
            {session.monitors.length > 1 && (
                <div className="device-stage-mobile-menu-tabs">
                    {session.monitors.map(m => (
                        <button
                            key={m.id}
                            className={`device-stage-mobile-menu-tab ${active === m.id ? 'active' : ''}`}
                            onClick={() => pick(m.id)}
                        >
                            {shortLabel(m.label)}
                        </button>
                    ))}
                    {/* The SAME class as its siblings. It used to be a
                        full-width list-row class dropped into a flex strip,
                        which is a good part of why nothing fitted — and it had
                        no active style at all, so it could never show as
                        selected even once the switch worked. */}
                    <button
                        className={`device-stage-mobile-menu-tab ${active === ALL_DISPLAYS ? 'active' : ''}`}
                        onClick={() => pick(ALL_DISPLAYS)}
                    >
                        <GridIcon /> All
                    </button>
                </div>
            )}
            
            <div style={{ padding: '16px' }}>
                <div style={{ marginBottom: '16px' }}>
                    {/* Same presets as the desktop control, from one list.
                        They used to be a second hand-written copy, in bits
                        rather than kilobits, so both surfaces asked for 1000x
                        their label and the agent refused every option. */}
                    {[...STREAM_QUALITY_PRESETS].reverse().map(p => {
                        const val = presetValue(p);
                        return (
                            <label key={val} style={{ display: 'flex', alignItems: 'center', marginBottom: '12px' }}>
                                {/* CONTROLLED off the store, like the desktop
                                    select: it shows what the host confirmed
                                    rather than what was last tapped, so a
                                    refused change snaps back instead of lying. */}
                                <input
                                    type="radio"
                                    className="device-stage-mobile-menu-radio"
                                    checked={quality === val}
                                    disabled={pendingQuality !== undefined}
                                    onChange={() => sendStreamQuality(session.id, p.fps, p.bitrateKbps)}
                                />
                                {MOBILE_PRESET_LABELS[p.bitrateKbps] ?? p.label}
                            </label>
                        );
                    })}
                </div>

                {/* The codec radios (VP8/VP9/AV1/H264/H265) lived here and set
                    nothing but their own highlight — the agent encodes H.264
                    and has no codec request in its protocol. Removed rather
                    than left as a menu that appears to choose an encoder.
                    Bring them back alongside a codec field on StartStream. */}

                {/* Privacy mode is the ONE toggle here that reaches the host.
                    It sat in a list of eleven, ten of which only moved their
                    own checkbox — including "Disable clipboard" and "Lock after
                    session end", which a user would reasonably read as security
                    controls and rely on. Its state comes from the host's ack
                    (session.privacyActive), never from the click, so a host
                    that cannot blank its screen does not show as blanked. */}
                <div style={{ borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: '16px' }}>
                    <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
                        Privacy mode (blank their screen)
                        <input
                            type="checkbox"
                            className="device-stage-mobile-menu-checkbox"
                            checked={session.privacyActive}
                            onChange={() => setPrivacyMode(session.id, !session.privacyActive)}
                        />
                    </label>
                </div>
            </div>
        </div>
    );
}

export function MouseMenu({ 
    isMouseMode,
    setMouseMode,
    showVirtualMouse,
    setShowVirtualMouse,
    followCursor,
    setFollowCursor,
    followCaret,
    setFollowCaret,
    autoKeyboard,
    setAutoKeyboard,
    onCopyDiagnostics,
}: {
    isMouseMode: boolean,
    setMouseMode: (v: boolean) => void,
    showVirtualMouse: boolean,
    setShowVirtualMouse: (v: boolean) => void,
    followCursor: boolean,
    setFollowCursor: (v: boolean) => void,
    followCaret: boolean,
    setFollowCaret: (v: boolean) => void,
    autoKeyboard: boolean,
    setAutoKeyboard: (v: boolean) => void,
    onCopyDiagnostics: () => void,
}) {
    return (
        <div className="device-stage-mobile-menu menu-center" style={{ bottom: '120px' }}>
            <div className="mouse-mode-selector">
                <button 
                    className={`mouse-mode-btn ${isMouseMode ? 'active' : 'inactive'}`}
                    onClick={() => setMouseMode(true)}
                >
                    <MouseIcon /> Mouse mode
                </button>
                <button 
                    className={`mouse-mode-btn ${!isMouseMode ? 'active' : 'inactive'}`}
                    onClick={() => setMouseMode(false)}
                >
                    <TapIcon /> Touch mode
                </button>
            </div>

            <label style={{ display: 'flex', alignItems: 'center', padding: '0 16px 16px 16px' }}>
                <input 
                    type="checkbox" 
                    className="device-stage-mobile-menu-checkbox" 
                    style={{ marginRight: '12px', marginLeft: 0 }}
                    checked={showVirtualMouse}
                    onChange={(e) => setShowVirtualMouse(e.target.checked)}
                />
                Show virtual mouse
            </label>

            <label style={{ display: 'flex', alignItems: 'center', padding: '0 16px 16px 16px' }}>
                <input
                    type="checkbox"
                    className="device-stage-mobile-menu-checkbox"
                    style={{ marginRight: '12px', marginLeft: 0 }}
                    checked={followCursor}
                    onChange={(e) => setFollowCursor(e.target.checked)}
                />
                Follow the cursor while zoomed
            </label>

            {/* A KEYBOARD setting in the MOUSE sheet, deliberately. It cannot live
                in the keyboard overlay: every control there must call keepFocus
                (or re-focus the hidden field) or Android closes the soft keyboard
                the moment it is touched, and a checkbox that dismisses the
                keyboard is worse than a slightly misfiled one. This sheet is also
                where the other camera setting already is. */}
            <label style={{ display: 'flex', alignItems: 'center', padding: '0 16px 16px 16px' }}>
                <input
                    type="checkbox"
                    className="device-stage-mobile-menu-checkbox"
                    style={{ marginRight: '12px', marginLeft: 0 }}
                    checked={followCaret}
                    onChange={(e) => setFollowCaret(e.target.checked)}
                />
                Zoom to the text cursor while typing
            </label>

            {/* The other keyboard setting that cannot live in the keyboard
                overlay, for the same reason. Decided by deviceAutoKeyboard.ts
                from the remote caret; a heuristic with no off switch is a bug
                report waiting to happen. */}
            <label style={{ display: 'flex', alignItems: 'center', padding: '0 16px 16px 16px' }}>
                <input
                    type="checkbox"
                    className="device-stage-mobile-menu-checkbox"
                    style={{ marginRight: '12px', marginLeft: 0 }}
                    checked={autoKeyboard}
                    onChange={(e) => setAutoKeyboard(e.target.checked)}
                />
                Open the keyboard when a text box is tapped
            </label>

            <label style={{ display: 'flex', alignItems: 'center', padding: '0 16px 16px 16px' }}>
                <input
                    type="checkbox"
                    className="device-stage-mobile-menu-checkbox"
                    style={{ marginRight: '12px', marginLeft: 0 }}
                    disabled
                />
                <span style={{ color: '#949ba4' }}>Show virtual joystick (Not Implemented)</span>
            </label>

            {/* The numbers that explain "why does this feel behind" — jitter
                buffer, decode time, fps, input rate — are only meaningful WHILE
                it is happening, and a release APK has WebView debugging off, so
                there is no console to read them from. This is the phone's only
                route to them. */}
            <button
                className="device-stage-mobile-menu-item"
                style={{ padding: '0 16px 16px 16px', background: 'none', border: 'none', color: 'inherit', font: 'inherit', textAlign: 'left', width: '100%', cursor: 'pointer' }}
                onClick={onCopyDiagnostics}
            >
                Copy diagnostics
            </button>

            <div className="mouse-gesture-grid" style={{ borderTop: '1px solid rgba(255,255,255,0.1)' }}>
                <div className="mouse-gesture-item">
                    <span className="icon"><TapIcon /></span>
                    <span>One-finger tap</span>
                    <span className="title">Left mouse</span>
                </div>
                <div className="mouse-gesture-item">
                    <span className="icon"><TapLongIcon /></span>
                    <span>One-long tap</span>
                    <span className="title">Right mouse</span>
                </div>
                <div className="mouse-gesture-item">
                    <span className="icon"><TapDoubleIcon /></span>
                    <span>Double tap & move</span>
                    <span className="title">Mouse drag</span>
                </div>
                <div className="mouse-gesture-item">
                    <span className="icon"><HandIcon /></span>
                    <span>Three-finger vertically</span>
                    <span className="title">Mouse wheel</span>
                </div>
                <div className="mouse-gesture-item">
                    <span className="icon"><TwoFingerIcon /></span>
                    <span>Two-finger move</span>
                    <span className="title">Canvas move</span>
                </div>
                <div className="mouse-gesture-item">
                    <span className="icon"><PinchIcon /></span>
                    <span>Pinch to zoom</span>
                    <span className="title">Canvas zoom</span>
                </div>
            </div>
        </div>
    );
}
