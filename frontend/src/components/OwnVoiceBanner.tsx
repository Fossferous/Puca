/**
 * "You're in Lounge on your PC" — Leave / Move here.
 *
 * Shown on any device of the account while the account's voice call is on
 * ANOTHER device and this one is in no call. Leave ends the call there; Move
 * here ends it there and joins here. Both act through the parent (Chat), which
 * owns the voice panel and the toast.
 *
 * It reads the own-voice store (api/ownVoice.ts), which only a server that sent
 * OwnVoiceState on this socket ever fills: against an older server there is
 * no banner, so neither button can send a frame that server would refuse.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { DisconnectIcon, LaptopIcon, PhoneIcon } from './Icons';
import { callOnOtherDevice, ownVoiceBannerText, useOwnVoice, type OwnVoiceState } from '../api/ownVoice';
import './OwnVoiceBanner.css';

interface Props {
    /** This device is itself in a voice call: no banner (the call is here). */
    inCallHere: boolean;
    onLeave: (call: OwnVoiceState) => void;
    onMoveHere: (call: OwnVoiceState) => void;
    /** Which icon means "here" on Move here: this device. */
    hereIsPhone?: boolean;
}

/** How long a pressed button stays busy if no new state arrives to settle it. */
const PENDING_MS = 6000;

export function OwnVoiceBanner({ inCallHere, onLeave, onMoveHere, hereIsPhone = false }: Props) {
    const snap = useOwnVoice();
    const call = inCallHere ? null : callOnOtherDevice(snap);
    // A press is "pending" until the server's next word about the call (any
    // new state object) or a timeout - so a double tap cannot send twice.
    const [pending, setPending] = useState<{ state: OwnVoiceState; action: 'leave' | 'move' } | null>(null);
    const barRef = useRef<HTMLDivElement | null>(null);
    const busy = pending !== null && pending.state === snap.state;

    useEffect(() => {
        if (!pending) return;
        const t = setTimeout(() => setPending(null), PENDING_MS);
        return () => clearTimeout(t);
    }, [pending]);

    // Publish the bar's height for mobile.css's reservations (the composer
    // and the panels must not sit under it). Measured, like the voice panel.
    useLayoutEffect(() => {
        const el = barRef.current;
        const rootStyle = document.documentElement.style;
        if (!el) {
            rootStyle.removeProperty('--own-voice-banner-h');
            return;
        }
        const write = () => rootStyle.setProperty('--own-voice-banner-h', `${Math.ceil(el.getBoundingClientRect().height)}px`);
        write();
        if (typeof ResizeObserver === 'undefined') return () => rootStyle.removeProperty('--own-voice-banner-h');
        const ro = new ResizeObserver(write);
        ro.observe(el);
        return () => {
            ro.disconnect();
            rootStyle.removeProperty('--own-voice-banner-h');
        };
    }, [call]);

    if (!call) return null;

    const press = (action: 'leave' | 'move') => {
        if (busy) return;
        setPending({ state: snap.state!, action });
        if (action === 'leave') onLeave(call);
        else onMoveHere(call);
    };
    const DeviceIcon = call.device === 'mobile' ? PhoneIcon : LaptopIcon;
    const HereIcon = hereIsPhone ? PhoneIcon : LaptopIcon;

    return (
        <div className="own-voice-banner" role="status" aria-live="polite" ref={barRef}>
            <span className="own-voice-banner-icon" aria-hidden="true"><DeviceIcon size={18} /></span>
            <div className="own-voice-banner-text">
                <span className="own-voice-banner-title">{ownVoiceBannerText(call)}</span>
                {call.serverName && <span className="own-voice-banner-sub">{call.serverName}</span>}
            </div>
            <div className="own-voice-banner-actions">
                <button
                    type="button"
                    className="own-voice-banner-btn leave"
                    onClick={() => press('leave')}
                    disabled={busy}
                    title="End the call on the other device"
                >
                    <span className="own-voice-banner-btn-icon" aria-hidden="true"><DisconnectIcon size={16} /></span>
                    <span>Leave</span>
                </button>
                <button
                    type="button"
                    className="own-voice-banner-btn move"
                    onClick={() => press('move')}
                    disabled={busy}
                    title="End the call there and join it on this device"
                >
                    <span className="own-voice-banner-btn-icon" aria-hidden="true"><HereIcon size={16} /></span>
                    <span>Move here</span>
                </button>
            </div>
        </div>
    );
}
