/**
 * THE WAY BACK to a remote-control session minimised to the app (the phone
 * toolbar's Chat, the desktop's "Back to Púca (keep the session)"): one
 * button, "Return to <the PC's name>", in a strip of its own.
 *
 * WHERE IT IS, AND WHY THERE. It was a pill fixed 20 px from the bottom-right
 * corner over everything (z 10000), naming the session by its raw id. That
 * corner is the composer's: on a phone with the soft keyboard up it covered
 * the message box and Send (the owner's report, 2026-11-22: "Blocks
 * textbox"), with the keyboard down it sat on the bottom bar's tabs and ate
 * the tap meant for Chat, and on a 1280x800 desktop it covered Send and the
 * emoji button (e2e/return-pill-live.mjs measures all of it). No corner of a
 * chat app is free of controls, so it no longer floats over one: it is a bar
 * that the layout makes room for, the way the voice bar is (DeviceStageMobile.css):
 *  - on a phone, a persistent bar above the bottom bar (and above the voice
 *    bar or the own-call banner when one is up), in the voice bar's z band,
 *    with every panel ending above its MEASURED height, so the composer sits
 *    over it and nothing sits under it. While the soft keyboard is up it
 *    steps aside with the bottom bar (api/keyboardUp.ts): the way back to a
 *    screen you are not looking at is no use mid-sentence, and sideways the
 *    keyboard leaves too little room to spare a row for it;
 *  - on a desktop, a strip along the bottom of the window, with the app's
 *    columns (and the Friends, Devices and Notes views) ending above it, so
 *    it is on screen in every view and over nothing.
 *
 * Its height is published as `--device-return-h` on <html> for those
 * reservations, measured like the voice bar's (VoicePanel.tsx): 0 while it is
 * hidden, gone when the stage comes back.
 *
 * DRAWN INSIDE CHAT'S ROOT (chatRoot.ts), though it is mounted beside Chat
 * (RcGlobals): on a phone `.chat-container` is a stacking context holding
 * every dialog Chat opens, and a strip outside it at z 250 was drawn over all
 * of them (the member profile sheet's foot, Edit Channel's, a band of
 * Settings, Create Channel's backdrop), so a tap meant for a dialog brought
 * the remote screen back. Inside it, the strip is under every dialog and
 * backdrop, as the persistent bars' row in docs/DESIGN_PHILOSOPHY.md's table
 * says. With no Chat on the page it is drawn where it is mounted.
 */
import { useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { LiveDotIcon } from './Icons';
import { useChatRoot } from './chatRoot';

/** The words on it: the computer's name as the session layer knows it, never
 *  the session's id (a string like "ds7babefb5bd2042d38d9c" means nothing to
 *  anyone). */
function returnLabel(peerName: string | null | undefined): string {
    const name = peerName?.trim();
    return `Return to ${name || 'the remote computer'}`;
}

const HEIGHT_VAR = '--device-return-h';

export function DeviceStageReturn({ peerName, onReturn }: {
    peerName: string | null | undefined;
    onReturn: () => void;
}) {
    const stripRef = useRef<HTMLDivElement>(null);
    const chatRoot = useChatRoot();

    // Keyed on the root: moving into it (or out of it, when Chat goes) draws
    // a new element, and the measurement must follow the one on the page.
    useLayoutEffect(() => {
        const el = stripRef.current;
        const rootStyle = document.documentElement.style;
        if (!el) return;
        const write = () => rootStyle.setProperty(HEIGHT_VAR, `${Math.ceil(el.getBoundingClientRect().height)}px`);
        write();
        if (typeof ResizeObserver === 'undefined') return () => rootStyle.removeProperty(HEIGHT_VAR);
        const ro = new ResizeObserver(write);
        ro.observe(el);
        return () => {
            ro.disconnect();
            rootStyle.removeProperty(HEIGHT_VAR);
        };
    }, [chatRoot]);

    const label = returnLabel(peerName);
    const strip = (
        <div ref={stripRef} className="device-stage-minimized-strip">
            {/* A real button: Tab reaches it, Enter and Space press it, and its
                words are its name. The title shows a long name that the
                ellipsis cut. */}
            <button type="button" className="device-stage-minimized" onClick={onReturn} title={label}>
                <span className="device-stage-minimized-dot" aria-hidden="true"><LiveDotIcon /></span>
                <span className="device-stage-minimized-label">{label}</span>
            </button>
        </div>
    );
    return chatRoot ? createPortal(strip, chatRoot) : strip;
}
