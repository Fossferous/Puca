/**
 * "Someone wants to post a clip of this call" — the approver's dialog
 * (docs/CLIPS.md §Phase 2). Mounted globally in App.tsx next to
 * HostConsentPrompt: the request arrives on the socket, on any device, in any
 * view, including from a call you already left.
 *
 * Rules that are not negotiable here:
 *  - NOTHING is decided by this component. Approve/Decline POST a vote and the
 *    server owns the outcome; expiry NEVER auto-approves — the dialog just
 *    turns into "This request expired." A vote is final (the server says 409
 *    the second time), and the copy says so.
 *  - Decline has focus when the dialog appears (an Enter aimed at something
 *    else must not hand out your voice), Escape declines, focus stays inside.
 *  - Only the OLDEST unanswered request is shown; the rest wait behind a
 *    "1 of N" chip. When the next one slides in, its buttons are dead for
 *    400 ms so a double-tap meant for the previous dialog cannot answer it.
 *  - The copy is rendered from the `you` flags the server computed (had
 *    camera / had share / still in the call) — never from what the proposer
 *    typed. Names of other approvers do not exist here.
 *  - z 2090 (docs/DESIGN_PHILOSOPHY.md z-registry): above the clip composer
 *    (2060), below the remote-control consent pair (2100).
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
    dismissClipProposal, getClipProposalState, subscribeClipProposals, voteOnClip,
    type ClipProposalState,
} from '../api/clips/clipProposals';
import { endedAgoText, expiresInText, includesClause, pickShown } from '../api/clips/clipPromptLogic';
import { formatClock } from '../api/clips/clipPresets';
import { ClipIcon, ShieldCheckIcon, WarningIcon } from './Icons';
import './ClipApprovalPrompt.css';

const HOLD_OFF_MS = 400;
const RESOLVE_LOCK_MS = 600;
/** How long "Approved — it will be posted." stays up before auto-closing.
 *  An approval needs no acknowledgment — only a decline/expiry/closure does,
 *  since those are the outcomes worth reading before dismissing. */
const AUTO_CLOSE_APPROVED_MS = 1400;

export function ClipApprovalPrompt() {
    const [state, setState] = useState<ClipProposalState>(getClipProposalState());
    const [shownId, setShownId] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [heldOff, setHeldOff] = useState(false);
    const [netError, setNetError] = useState<string | null>(null);
    const [now, setNow] = useState(() => Date.now());
    const declineRef = useRef<HTMLButtonElement | null>(null);
    const closeRef = useRef<HTMLButtonElement | null>(null);
    const dialogRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => subscribeClipProposals(setState), []);
    // Coarse clock for the "expires in" / "ending N minutes ago" copy.
    useEffect(() => { const t = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(t); }, []);

    const shown = pickShown(state, shownId);
    const shownClipId = shown?.clipId ?? null;

    // Track which request is on screen (so a resolution can keep it up for its
    // terminal copy). Keyed on the shown id ONLY — keying on `shownId` too made
    // the effect re-run after its own setState and clear the hold-off timer.
    useEffect(() => { setShownId(shownClipId); setNetError(null); }, [shownClipId]);
    // A NEW request gets the hold-off: its buttons are dead for 400 ms.
    useEffect(() => {
        if (!shownClipId) return;
        setHeldOff(true);
        const t = setTimeout(() => setHeldOff(false), HOLD_OFF_MS);
        return () => clearTimeout(t);
    }, [shownClipId]);
    // A resolution while open: lock the buttons briefly, then show terminal copy + Close.
    const resolved = shown?.resolution ?? null;
    const expired = !!shown && shown.expiresAt <= now && resolved === null;
    const [resolveLocked, setResolveLocked] = useState(false);
    useEffect(() => {
        if (!resolved) return;
        setResolveLocked(true);
        const t = setTimeout(() => setResolveLocked(false), RESOLVE_LOCK_MS);
        return () => clearTimeout(t);
    }, [resolved, shownClipId]);
    // An approval is good news, not a decision the approver still needs to act
    // on — close it on its own after a beat so approving never costs a second
    // click. Decline/closed/expired keep the manual Close: those are outcomes
    // worth reading before dismissing.
    useEffect(() => {
        if (resolved !== 'approved' || !shownClipId) return;
        const id = shownClipId;
        const t = setTimeout(() => dismissClipProposal(id), AUTO_CLOSE_APPROVED_MS);
        return () => clearTimeout(t);
    }, [resolved, shownClipId]);

    // Focus, after commit (a disabled button cannot take focus, so the timer
    // callbacks are too early): Decline once the hold-off lifts (never
    // Approve); Close once the resolve-lock lifts — otherwise focus falls to
    // <body> and the Tab trap stops cycling inside the dialog.
    const isTerminal = resolved !== null || expired;
    useEffect(() => {
        if (!shownClipId) return;
        if (isTerminal) { if (!resolveLocked) closeRef.current?.focus(); return; }
        if (!heldOff) declineRef.current?.focus();
    }, [shownClipId, heldOff, isTerminal, resolveLocked]);

    if (!shown) return null;

    const pendingCount = state.incoming.filter(p => p.myVote === 'pending' && p.resolution === null).length;
    const terminal = resolved !== null || expired;
    const disabled = busy || heldOff || terminal;

    const vote = async (approve: boolean) => {
        if (disabled) return;
        setBusy(true); setNetError(null);
        try {
            await voteOnClip(shown.clipId, approve);
            // An approve leaves the entry (myVote=approved) so a later
            // resolution does not re-prompt; the prompt simply moves on.
        } catch {
            setNetError("Couldn't reach the server — nothing was sent. Try again.");
        } finally {
            setBusy(false);
        }
    };
    const close = () => dismissClipProposal(shown.clipId);

    const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            if (terminal) close(); else void vote(false);
            return;
        }
        if (e.key === 'Tab' && dialogRef.current) {
            // Minimal focus trap: cycle inside the dialog.
            const focusables = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'));
            if (focusables.length === 0) return;
            const first = focusables[0], last = focusables[focusables.length - 1];
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
    };

    const who = shown.proposer.username;
    const terminalCopy = resolved === 'approved'
        ? 'Approved — it will be posted.'
        : resolved === 'closed' ? 'This request was closed.'
        : (resolved === 'expired' || expired) ? 'This request expired. Nothing was posted.' : null;

    return createPortal(
        <div className="clip-approval-backdrop" role="presentation">
            <div
                ref={dialogRef}
                className="clip-approval"
                role="dialog"
                aria-modal="true"
                aria-labelledby="clip-approval-title"
                aria-describedby="clip-approval-body"
                onKeyDown={onKeyDown}
                data-clip-id={shown.clipId}
            >
                <header className="clip-approval-header">
                    <h2 id="clip-approval-title"><span className="clip-approval-icon"><ClipIcon size={20} /></span> {who} wants to post a clip of this call</h2>
                    {pendingCount > 1 && <span className="clip-approval-queue">1 of {pendingCount} requests</span>}
                </header>

                <div id="clip-approval-body" className="clip-approval-body">
                    <p>
                        The clip is <strong>{formatClock(shown.durationMs / 1000)}</strong> from <strong>#{shown.voiceChannelName}</strong>, {endedAgoText(shown, now)}.
                    </p>
                    <p>
                        <strong>It records {who}'s whole screen plus the call audio.</strong> It includes {includesClause(shown.you)} — and anything else that was visible on {who}'s screen.
                        {!shown.you.stillInCall && (shown.you.inWindow
                            ? <> You were in that call at the time.</>
                            : <> The server did not see you in that call during the clip; {who}'s app listed you as there.</>)}
                    </p>
                    <p>If everyone approves it will be posted to <strong>#{shown.targetChannelName}</strong>.</p>
                    <p className="clip-approval-standing">
                        <ShieldCheckIcon size={13} /> Nothing has been uploaded. The clip is only on {who}'s PC, and Puca deletes it there the moment anyone declines.
                    </p>
                    <details className="clip-approval-details">
                        <summary>Can I watch it first?</summary>
                        <p>No — showing it to you would mean uploading it before you agreed. You are approving the window, not the footage.</p>
                    </details>
                    <p className="clip-approval-expiry" aria-live="polite">{terminalCopy ?? `${expiresInText(shown.expiresAt, now)} · Your answer is final.`}</p>
                    {netError && <p className="clip-approval-error"><WarningIcon size={13} /> {netError}</p>}
                </div>

                <div className="clip-approval-actions">
                    {terminal ? (
                        <button ref={closeRef} type="button" className="clip-approval-decline" onClick={close} disabled={resolveLocked}>Close</button>
                    ) : (
                        <>
                            <button ref={declineRef} type="button" className="clip-approval-decline" onClick={() => void vote(false)} disabled={disabled}>Decline</button>
                            <button type="button" className="clip-approval-approve" onClick={() => void vote(true)} disabled={disabled}>Approve</button>
                        </>
                    )}
                </div>
            </div>
        </div>,
        document.body,
    );
}
