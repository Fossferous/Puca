/**
 * "Who is in this voice channel", on a hover or a keyboard focus.
 *
 * The sidebar already lists a voice room's occupants under its row, but an EMPTY room shows
 * nothing at all, which reads the same as "not loaded", and the member list's "Active in your
 * servers" panel is too small to name everyone. Rest a mouse on the row, or Tab to it, and this
 * says so either way: "Nobody is here", or the whole roster with who is muted, deafened or live.
 *
 * It is a tooltip, never a control, so it takes no pointer events and leaves the row's own click
 * (join), drag and menu exactly as they were. There is no hover on a touch screen, so a finger,
 * and a pen, open nothing here: a phone has the occupants under the row, and the panel's rows are
 * buttons that go to the server. A press on the row closes the card, since a press joins.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { HeadphonesOffIcon, MicOffIcon, NoMicIcon, ScreenShareIcon } from './Icons';
import './VoiceRosterCard.css';

export interface RosterPerson {
    id: number;
    name: string;
    muted?: boolean;
    deafened?: boolean;
    noMic?: boolean;
    live?: boolean;
}

/** How long the mouse rests on a row before the card opens: a pass over the list opens none. */
export const ROSTER_CARD_DELAY_MS = 350;

/** Whether the focus came from the keyboard (a click that focuses a row opens nothing). */
function focusFromKeyboard(el: Element): boolean {
    try {
        return el.matches(':focus-visible');
    } catch {
        return true; // an engine without :focus-visible
    }
}

export function VoiceRosterTip({ title, people, hereLabel = 'in this channel' }: {
    /** The channel's name. */
    title: string;
    people: readonly RosterPerson[];
    hereLabel?: string;
}) {
    const anchor = useRef<HTMLSpanElement>(null);
    const card = useRef<HTMLDivElement>(null);
    const id = useId();
    const [open, setOpen] = useState(false);
    const [at, setAt] = useState<{ left: number; top: number } | null>(null);
    const [rect, setRect] = useState<DOMRect | null>(null);

    // The card belongs to the element it sits in, so it is attached to that element: the row's own
    // markup, which is shared with drag and the context menu, takes no handlers for it.
    useEffect(() => {
        const host = anchor.current?.parentElement;
        if (!host) return;
        let timer: number | undefined;
        const show = () => {
            window.clearTimeout(timer);
            timer = window.setTimeout(() => { setRect(host.getBoundingClientRect()); setOpen(true); }, ROSTER_CARD_DELAY_MS);
        };
        const showNow = () => { window.clearTimeout(timer); setRect(host.getBoundingClientRect()); setOpen(true); };
        const hide = () => { window.clearTimeout(timer); setOpen(false); setAt(null); };
        const onEnter = (e: PointerEvent) => { if (e.pointerType === 'mouse') show(); };
        const onFocus = () => { if (focusFromKeyboard(host)) showNow(); };
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') hide(); };
        host.addEventListener('pointerenter', onEnter);
        host.addEventListener('pointerleave', hide);
        host.addEventListener('pointerdown', hide);
        host.addEventListener('focus', onFocus);
        host.addEventListener('blur', hide);
        host.addEventListener('keydown', onKey);
        // A scroll of the list moves the row from under a card placed where it was.
        window.addEventListener('scroll', hide, true);
        host.setAttribute('data-roster-card', id);
        return () => {
            window.clearTimeout(timer);
            host.removeEventListener('pointerenter', onEnter);
            host.removeEventListener('pointerleave', hide);
            host.removeEventListener('pointerdown', hide);
            host.removeEventListener('focus', onFocus);
            host.removeEventListener('blur', hide);
            host.removeEventListener('keydown', onKey);
            window.removeEventListener('scroll', hide, true);
            host.removeAttribute('data-roster-card');
            host.removeAttribute('aria-describedby');
        };
    }, [id]);

    useEffect(() => {
        const host = anchor.current?.parentElement;
        if (!host) return;
        if (open) host.setAttribute('aria-describedby', id); else host.removeAttribute('aria-describedby');
    }, [open, id]);

    // Beside the row, on the side with room, and inside the window.
    useLayoutEffect(() => {
        if (!open || !rect || !card.current) return;
        const w = card.current.offsetWidth;
        const h = card.current.offsetHeight;
        const gap = 8;
        let left = rect.right + gap;
        if (left + w > window.innerWidth - gap) left = Math.max(gap, rect.left - gap - w);
        let top = rect.top;
        if (top + h > window.innerHeight - gap) top = Math.max(gap, window.innerHeight - gap - h);
        // eslint-disable-next-line react-hooks/set-state-in-effect -- measured placement: the card's size is known only after it is drawn
        setAt({ left, top });
    }, [open, rect, people.length]);

    const count = people.length;
    return (
        <>
            <span ref={anchor} className="roster-tip-anchor" aria-hidden="true" />
            {open && createPortal(
                <div
                    ref={card}
                    id={id}
                    role="tooltip"
                    className="roster-card"
                    data-testid="roster-card"
                    style={at ? { left: at.left, top: at.top } : { left: 0, top: 0, visibility: 'hidden' }}
                >
                    <div className="roster-card-title">{title}</div>
                    <div className="roster-card-count">
                        {count === 0 ? 'Nobody is here' : `${count} ${hereLabel}`}
                    </div>
                    {count > 0 && (
                        <ul className="roster-card-list">
                            {people.map(p => (
                                <li key={p.id} className="roster-card-person">
                                    <span className="roster-card-name">{p.name}</span>
                                    {p.live && <span className="roster-card-live">LIVE <ScreenShareIcon /></span>}
                                    {p.noMic
                                        ? <span className="roster-card-flag" title="No microphone" aria-label="No microphone"><NoMicIcon /></span>
                                        : p.muted && <span className="roster-card-flag" title="Muted" aria-label="Muted"><MicOffIcon /></span>}
                                    {p.deafened && <span className="roster-card-flag" title="Deafened" aria-label="Deafened"><HeadphonesOffIcon /></span>}
                                </li>
                            ))}
                        </ul>
                    )}
                </div>,
                document.body,
            )}
        </>
    );
}
