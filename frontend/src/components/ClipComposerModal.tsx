/**
 * Clip composer — pick how much of the buffer to keep, seal it, ask everyone,
 * review + trim once they said yes, then post.
 *
 * Phases: choose → sealing → sealed → proposing → pending → approved →
 * uploading → posting → done, with `failed` (seal/upload/post) and the
 * terminal outcomes the server hands back (declined / expired / cancelled).
 * Every hook is above the `isOpen` guard — a hook below an early return is
 * the v0.7.7 React #310 crash class.
 *
 * WHEN the clipper may see the footage — the rule this file enforces:
 *   - Before `outgoing.status === 'approved'` (phases sealed/proposing/
 *     pending): metadata ONLY (duration, resolution, size). No <video>, no
 *     preview, no frame. Watching it before everyone agreed to be watched is
 *     exactly the gap the consent model exists to close (docs/CLIPS.md).
 *   - Once approved (phase `approved`): a preview plays from the worker-side
 *     MediaSource, and the clipper may TRIM it. Trim only narrows the window
 *     that was already approved — it can remove footage, never add any
 *     outside what approvers were told — so posting a trimmed clip needs no
 *     new consent. "Post" then uploads whatever is left. Solo clips (nobody
 *     else to ask) come back approved immediately and land here directly.
 *   clipNoPreview.test.ts pins that the <video>/attachPreview only ever
 *   appears inside the `phase === 'approved'` branch.
 *
 * What this component NEVER does: upload before `outgoing.status === 'approved'`
 * (the server refuses the bytes anyway — upload_handlers.rs runs the gate
 * before reading a body), decide an outcome locally, or keep a sealed clip
 * around after a non-approved outcome (the protocol module's discard handoff
 * wipes it; this just renders the copy).
 *
 * Portaled to document.body by the caller (a fixed element inside the
 * transformed voice panel would be trapped in it — docs/DESIGN_PHILOSOPHY.md §6).
 * z-index 2060: above Settings/ScreenShare (2000) because the save-clip hotkey
 * can fire while Settings is open, below the approval prompt (2090) and the
 * live-connection consent pair (2100).
 */
import { useEffect, useRef, useState } from 'react';
import { attachPreview, discardSeal, getReplayState, subscribeReplay, trimSeal, undoTrim, uploadAndBuild, type ReplayState } from '../api/clips/replayBuffer';
import type { SealedInfo } from '../api/clips/clipTypes';
import { CLIP_PAD_MS } from '../api/clips/clipParticipants';
import { formatClock, formatMB } from '../api/clips/clipPresets';
import { CHIP_SECONDS, durationChips, outcomeCopy, resolveClipTarget } from '../api/clips/clipComposerLogic';
import type { ClipPolicy } from '../api/clips/clipsUiState';
import { clipLabel } from '../api/clips/clipRef';
import { TRIM_MAX_CIPHER_BYTES, TRIM_MIN_CLIP_MS } from '../api/clips/clipTrim';
import {
    cancelClip, clearOutgoingClip, ClipProposeError, getClipProposalState, proposeClip, subscribeClipProposals,
    type ClipProposalState, type OutgoingProposal,
} from '../api/clips/clipProposals';
import { listChannels, sendChannelMessageEncrypted, type Channel } from '../api/servers';
import { API_BASE_URL } from '../api/config';
import { getToken } from '../api/auth';
import { CloseIcon, ClipIcon, ShieldCheckIcon, WarningIcon } from './Icons';
import './ClipComposerModal.css';

type ComposerPhase = 'choose' | 'sealing' | 'sealed' | 'proposing' | 'pending' | 'approved' | 'uploading' | 'posting' | 'done' | 'failed';

export interface ClipComposerModalProps {
    isOpen: boolean;
    onClose: () => void;
    /** Live seconds in the ring. */
    bufferedSeconds: number;
    /** Longest clip allowed: min(server policy, buffer length). */
    maxSeconds: number;
    onSeal: (seconds: number) => Promise<SealedInfo>;
    /** No posting path (pre-Clips server / server has clips off): seal + Discard only. */
    localOnly: boolean;
    /** Voice channel id (`voice_<id>` room). */
    voiceChannelId: number | null;
    policy: ClipPolicy;
    /** Everyone this client saw in the room whose presence overlaps the clip's
     *  window (D1 union input; api/clips/clipParticipants.ts). */
    getDeclaredParticipants: (windowStartMs: number, windowEndMs: number) => number[];
}

export function ClipComposerModal({ isOpen, onClose, bufferedSeconds, maxSeconds, onSeal, localOnly, voiceChannelId, policy, getDeclaredParticipants }: ClipComposerModalProps) {
    const [phase, setPhase] = useState<ComposerPhase>('choose');
    const [chosenRaw, setChosen] = useState<number | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [sealed, setSealed] = useState<SealedInfo | null>(null);
    const [replay, setReplay] = useState<ReplayState>(getReplayState());
    const [proposals, setProposals] = useState<ClipProposalState>(getClipProposalState());
    const [channels, setChannels] = useState<Channel[] | 'load-failed' | null>(null);
    /** Bumped by the retry link after a failed channel fetch. */
    const [channelsFetchSeq, setChannelsFetchSeq] = useState(0);
    const [postedTo, setPostedTo] = useState<string | null>(null);
    const [uploadRetryable, setUploadRetryable] = useState(false);
    const [now, setNow] = useState(() => Date.now());
    // Post-approval preview + trim. All of this is unreachable before
    // `phase === 'approved'` (see the file header).
    const [previewState, setPreviewState] = useState<'loading' | 'ready' | 'failed'>('loading');
    const [trimStartMs, setTrimStartMs] = useState(0);
    const [trimEndMs, setTrimEndMs] = useState<number | null>(null);
    const [trimming, setTrimming] = useState(false);
    const [trimGen, setTrimGen] = useState(0);
    const [trimNote, setTrimNote] = useState<string | null>(null);
    const [trimError, setTrimError] = useState<string | null>(null);
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const detachRef = useRef<(() => void) | null>(null);
    // The clip id this composer is driving; guards the async chain against a
    // stale continuation after a cancel/close.
    const activeClipRef = useRef<string | null>(null);
    const chips = durationChips(maxSeconds, bufferedSeconds);
    // Default chip: the longest available (what a "clip that" impulse wants) —
    // derived, not synced through an effect.
    const chosen = chosenRaw !== null && chips.includes(chosenRaw) ? chosenRaw : (chips.length ? chips[chips.length - 1] : null);
    // NO PICKER, no fallback chain. The pinned clips channel is the only
    // destination — everyone who approved knew where it would land — and each
    // way that can fail renders its own explanation (resolveClipTarget).
    const resolution = resolveClipTarget(policy, channels);
    const target = resolution.kind === 'ok' ? resolution.channel.id : null;
    const outgoing = proposals.outgoing;

    useEffect(() => subscribeReplay(setReplay), []);
    useEffect(() => subscribeClipProposals(setProposals), []);
    useEffect(() => { const t = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(t); }, []);

    // Text channels of the VOICE server (it may not be the viewed one).
    // A FAILED fetch is its own state, never an empty list: an empty list
    // reads as 'pin-unpostable', which told a user with a network blip they
    // lacked permission on a channel they can post in fine.
    useEffect(() => {
        if (!isOpen || localOnly || !policy.serverId) return;
        let alive = true;
        listChannels(policy.serverId)
            .then(list => { if (alive) setChannels(list); })
            .catch(() => { if (alive) setChannels('load-failed'); });
        return () => { alive = false; };
    }, [isOpen, localOnly, policy.serverId, channelsFetchSeq]);

    // Escape closes — a sealed clip must never linger unseen. While a request
    // is pending, Escape does nothing: closing must be a deliberate Cancel.
    useEffect(() => {
        if (!isOpen) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            e.preventDefault();
            // `approved` too: everyone said yes — leaving must be a deliberate
            // Discard (which withdraws the approval), not an accidental Escape.
            if (phase === 'pending' || phase === 'approved' || phase === 'uploading' || phase === 'posting' || phase === 'proposing') return;
            onClose();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [isOpen, onClose, phase]);

    // The ONLY place a preview is ever attached, and it is keyed on the
    // `approved` phase — which is itself only reachable once the server has
    // said every participant approved (see the pending→approved effect). Runs
    // again after every applied trim (trimGen) so the preview reflects the
    // narrowed clip — keyed on a counter, not on partCount, because a re-mux
    // can keep the part count while the footage changed.
    useEffect(() => {
        if (phase !== 'approved' || !videoRef.current) return;
        setPreviewState('loading');
        const { ready, detach } = attachPreview(videoRef.current);
        detachRef.current = detach;
        // A superseded attach (StrictMode double-effect, a re-attach after a
        // trim) is rejected by the bus; its verdict must not paint over the
        // live one.
        let live = true;
        ready.then(() => { if (live) setPreviewState('ready'); }).catch(() => { if (live) setPreviewState('failed'); });
        return () => { live = false; detach(); detachRef.current = null; };
    }, [phase, trimGen]);

    // Plain functions (not useCallback): `chosen` is derived from a fresh chips
    // array every render, so a memo here could never be preserved anyway.
    const doSeal = async () => {
        if (chosen === null) return;
        setPhase('sealing'); setError(null);
        try {
            const info = await onSeal(chosen);
            setSealed(info);
            setPhase('sealed');
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setPhase('failed');
        }
    };

    const discard = () => {
        detachRef.current?.();
        // With the token the worker also DELETEs any parts a partial upload
        // already landed — otherwise they sit against the quota until the sweep.
        const token = getToken();
        discardSeal(token ? { token, baseUrl: API_BASE_URL } : undefined);
        activeClipRef.current = null;
        clearOutgoingClip();
        onClose();
    };

    // Narrow the approved clip to the chosen [start, end]. Only ever reachable
    // from the `approved` phase. The worker re-muxes the kept range (snapping
    // outward to keyframes, ~2 s) — on failure the existing seal is untouched
    // and still postable as-is (the worker never replaces it unless the whole
    // re-mux + re-seal succeeded), so we just surface the message.
    const applyTrim = async () => {
        if (!sealed || trimming) return;
        const before = sealed.durationMs;
        const end = trimEndMs ?? before;
        if (trimStartMs <= 0 && end >= before) return; // nothing to trim
        setTrimming(true); setTrimError(null); setTrimNote(null);
        detachRef.current?.(); // stop feeding the old preview before the parts change
        try {
            // With the token the worker also DELETEs parts a failed upload of
            // the pre-trim clip already landed — nothing will reference them.
            const token = getToken();
            const info = await trimSeal(trimStartMs, end, token ? { token, baseUrl: API_BASE_URL } : undefined);
            setSealed(info);
            setTrimStartMs(0);
            setTrimEndMs(null);
            setTrimNote(info.durationMs < before
                ? `Trimmed to ${formatClock(info.durationMs / 1000)} (was ${formatClock(before / 1000)}). Check the preview, then post.`
                : 'Nothing was cut — both cut points snapped back to the whole clip. Drag further in to trim.');
            setTrimGen(g => g + 1); // the preview effect re-attaches to the new footage
        } catch (e) {
            setTrimError(`Trim failed: ${e instanceof Error ? e.message : String(e)}`);
            setTrimGen(g => g + 1); // the old preview was detached above; bring it back
        } finally {
            setTrimming(false);
        }
    };

    // Undo the LAST applied trim (one level, not a full history — the worker
    // only ever keeps one step back). O(1): the worker never retired the
    // pre-trim ciphertext/key, so this is a pointer swap, not a re-mux — cut
    // too much, and this is the way back that never existed before. Shares
    // `trimming` with applyTrim: both reshape `sealed` and must not overlap
    // (Post/Discard/Apply/Reset are all gated on the same flag already).
    const doUndo = async () => {
        if (!sealed?.canUndo || trimming) return;
        const before = sealed.durationMs;
        setTrimming(true); setTrimError(null); setTrimNote(null);
        detachRef.current?.();
        try {
            const info = await undoTrim();
            setSealed(info);
            // Any pending (un-applied) slider adjustment was an offset into
            // the now-superseded, shorter timeline — it no longer means
            // anything against the restored one.
            setTrimStartMs(0);
            setTrimEndMs(null);
            setTrimNote(`Restored to ${formatClock(info.durationMs / 1000)} (undid the trim to ${formatClock(before / 1000)}).`);
            setTrimGen(g => g + 1);
        } catch (e) {
            setTrimError(`Undo failed: ${e instanceof Error ? e.message : String(e)}`);
            setTrimGen(g => g + 1);
        } finally {
            setTrimming(false);
        }
    };

    const uploadAndPost = async (clipId: string, onlyMissing: boolean) => {
        const token = getToken();
        if (!token) { setError('You are signed out.'); setPhase('failed'); return; }
        // THE APPROVED DESTINATION WINS. `target` is derived from the LIVE
        // pin, which the owner can move between propose and post — and the
        // approvers were told (and the server recorded) the channel at
        // propose time. Posting to the live pin instead made the server
        // reject an already-uploaded, fully-approved clip with "approved for
        // a different channel", burning the approvals. The proposal carries
        // the server-blessed id; the live resolution is only the fallback
        // for the states where no proposal exists.
        const approved = outgoing && outgoing.clipId === clipId ? outgoing : null;
        const targetId = approved?.targetChannelId ?? target;
        const targetName = approved?.targetChannelName
            || (resolution.kind === 'ok' ? resolution.channel.name : '');
        if (targetId === null) { setError('No channel to post to.'); setPhase('failed'); return; }
        detachRef.current?.(); // the preview <video> unmounts with the phase change
        setPhase('uploading'); setError(null); setUploadRetryable(false);
        let href: string;
        try {
            ({ href } = await uploadAndBuild(token, API_BASE_URL, clipId, onlyMissing));
        } catch (e) {
            if (activeClipRef.current !== clipId) return;
            const msg = e instanceof Error ? e.message : String(e);
            const status = (e as { status?: number })?.status;
            const sealGone = /nothing sealed|disarmed/i.test(msg);
            setError(status === 507
                ? 'Your clip storage is full — delete older clips, then try again.'
                : sealGone ? 'The clip is no longer in memory (the buffer was disarmed), so it cannot be uploaded.'
                : `Upload failed — the clip is still in memory. ${msg}`);
            setUploadRetryable(status !== 507 && !sealGone);
            setPhase('failed');
            return;
        }
        if (activeClipRef.current !== clipId) return;
        setPhase('posting');
        try {
            await sendChannelMessageEncrypted(targetId, `[${clipLabel(sealed?.durationMs ?? 0)}](${href})`, undefined, false, clipId);
        } catch (e) {
            if (activeClipRef.current !== clipId) return;
            // The approvals may be spent (409) or the server may have refused;
            // either way the uploaded parts are unreferenced ciphertext — delete them.
            discardSeal({ token, baseUrl: API_BASE_URL });
            setError(`Could not post the clip: ${e instanceof Error ? e.message : String(e)}`);
            setUploadRetryable(false);
            setPhase('failed');
            return;
        }
        if (activeClipRef.current !== clipId) return;
        setPostedTo(targetName);
        setPhase('done');
        // The sealed copy has done its job; the ring keeps running. The
        // proposal was consumed by the post — forget it here too, so a later
        // disarm does not try to withdraw it.
        discardSeal();
        activeClipRef.current = null;
        clearOutgoingClip();
    };

    const requestApproval = async () => {
        if (!sealed || voiceChannelId === null || target === null) return;
        const sealedAt = getReplayState().sealedAt ?? Date.now();
        setPhase('proposing'); setError(null);
        let out: OutgoingProposal;
        try {
            out = await proposeClip(voiceChannelId, {
                targetChannelId: target,
                durationMs: sealed.durationMs,
                endedAgoMs: Math.max(0, Date.now() - sealedAt),
                // The same window the server computes from duration_ms +
                // ended_ago_ms (start padded by 2 s, end not padded), on this
                // client's clock — so the declared list covers the footage,
                // not everyone seen since arming.
                declaredParticipants: getDeclaredParticipants(sealedAt - sealed.durationMs - CLIP_PAD_MS, sealedAt),
            });
        } catch (e) {
            if (e instanceof ClipProposeError) {
                if (e.code === 'window_predates_log' && typeof e.earliestMs === 'number') {
                    // How much of the sealed clip the server can vouch for: from its
                    // earliest record to the clip's end (minus the 2 s pad).
                    const endMs = Date.now() - Math.max(0, Date.now() - sealedAt);
                    const allowedS = Math.max(0, Math.floor((endMs - e.earliestMs) / 1000) - 2);
                    setError(allowedS >= 5
                        ? `The server can only vouch for who was in the call for the last ${formatClock(allowedS)} — discard this and clip a shorter window.`
                        : 'The server has no record of this call window yet — try again in a moment with a shorter clip.');
                } else if (e.code === 'rate_limited') {
                    const s = Math.ceil((e.retryAfterMs ?? 0) / 1000);
                    setError(s > 0 ? `Too many clip requests — try again in ${formatClock(s)}.` : 'Too many clip requests — try again shortly.');
                } else {
                    setError(e.message);
                }
            } else {
                setError(e instanceof Error ? e.message : String(e));
            }
            setPhase('sealed');
            return;
        }
        activeClipRef.current = out.clipId;
        if (out.status === 'approved') {
            // Solo (log-attested): nobody else to ask — straight to review + trim.
            setPhase('approved');
        } else {
            setPhase('pending');
        }
    };

    // Pending → the server's word arrives on the bus. An approval moves to the
    // review/trim step (the clipper posts from there); NOT straight to upload.
    const outgoingStatus = outgoing?.clipId === activeClipRef.current ? outgoing.status : null;
    useEffect(() => {
        if (phase !== 'pending' || !activeClipRef.current || outgoingStatus === null) return;
        if (outgoingStatus === 'approved') setPhase('approved');
        // Non-approved outcomes are rendered from `outgoing.status` below; the
        // discard handoff already wiped the seal.
    }, [outgoingStatus, phase]);

    const cancelRequest = async () => {
        const id = activeClipRef.current;
        if (!id) return;
        try { await cancelClip(id); } catch { /* the bus reflects whatever the server did */ }
    };

    if (!isOpen) return null;

    const nonApproved = (phase === 'pending' || phase === 'approved') && outgoingStatus !== null && outgoingStatus !== 'pending' && outgoingStatus !== 'approved' ? outcomeCopy(outgoingStatus) : null;
    // After the final approval the server gives a bounded window to post (it
    // re-reads expires_in_ms on ClipResolved{approved}); past it, the upload
    // is refused, so say so here instead of letting Post fail.
    const postDeadlineMs = phase === 'approved' && outgoing?.clipId === activeClipRef.current ? outgoing.expiresAt : null;
    const postWindowPassed = postDeadlineMs !== null && postDeadlineMs <= now;
    const canRequest = !localOnly && policy.available && voiceChannelId !== null && target !== null && (channels !== null);

    return (
        <div className="clip-composer-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget && phase !== 'pending' && phase !== 'approved' && phase !== 'uploading' && phase !== 'posting' && phase !== 'proposing') onClose(); }}>
            <div className="clip-composer" role="dialog" aria-modal="true" aria-labelledby="clip-composer-title">
                <header className="clip-composer-header">
                    <h2 id="clip-composer-title"><span className="clip-composer-icon"><ClipIcon /></span> Save a clip</h2>
                    {phase !== 'pending' && phase !== 'approved' && phase !== 'uploading' && phase !== 'posting' && phase !== 'proposing' && (
                        <button className="clip-composer-close" onClick={onClose} aria-label="Close"><CloseIcon /></button>
                    )}
                </header>
                <p className="clip-composer-standing">
                    {phase === 'approved'
                        ? (outgoing?.solo
                            ? 'No one else was in the call, so nothing needed approval. Review it, trim it if you like, then post.'
                            : 'Everyone approved. Review it, trim it if you like, then post — trimming can only shorten what they agreed to, never add to it.')
                        : <>Nothing leaves your PC until everyone in the clip approves — not even to you. You won't be able to watch it either until then.{localOnly ? ' Clips are not enabled on this server, so this stays local — there is no server to post it to.' : ''}</>}
                </p>

                {phase === 'choose' && (
                    <>
                        <div className="clip-composer-section">
                            <div className="clip-composer-label">How much of the buffer?</div>
                            {chips.length === 0 ? (
                                <p className="clip-composer-hint">Not enough buffered yet — keep the buffer armed a few more seconds.</p>
                            ) : (
                                <div className="clip-duration-chips" role="radiogroup" aria-label="Clip length">
                                    {chips.map(c => (
                                        <button
                                            key={c}
                                            role="radio"
                                            aria-checked={chosen === c}
                                            className={`clip-duration-chip ${chosen === c ? 'selected' : ''}`}
                                            onClick={() => setChosen(c)}
                                        >
                                            {formatClock(c)}{c === chips[chips.length - 1] && !CHIP_SECONDS.includes(c) ? ' (all)' : ''}
                                        </button>
                                    ))}
                                </div>
                            )}
                            <p className="clip-composer-hint">
                                Buffered {formatClock(bufferedSeconds)} · you can clip up to {formatClock(maxSeconds)}
                                {!replay.hasSystemAudio && <><br /><WarningIcon size={13} /> This buffer has no system audio — only your microphone.</>}
                            </p>
                            {/* The dead end, announced BEFORE the seal is paid for
                                (a seal doubles peak memory by design): a user who
                                reads "no clips channel" only on the post screen
                                already spent it. Same copy as the sealed phase. */}
                            {!localOnly && policy.available && resolution.kind === 'pin-missing' && (
                                <p className="clip-composer-hint"><WarningIcon size={13} /> This server has no clips channel yet — you can prepare a clip, but it cannot be posted until the owner picks one in Server Settings.</p>
                            )}
                            {!localOnly && policy.available && resolution.kind === 'pin-unpostable' && (
                                <p className="clip-composer-hint"><WarningIcon size={13} /> You cannot post in this server&rsquo;s clips channel, so a prepared clip could not be posted.</p>
                            )}
                        </div>
                        <div className="clip-composer-actions">
                            <button className="clip-btn secondary" onClick={onClose}>Cancel</button>
                            <button className="clip-btn primary" onClick={() => void doSeal()} disabled={chosen === null || chips.length === 0}>Prepare clip</button>
                        </div>
                    </>
                )}

                {phase === 'sealing' && (
                    <div className="clip-composer-section clip-composer-busy" aria-live="polite">Preparing clip…</div>
                )}
                {phase === 'proposing' && (
                    <div className="clip-composer-section clip-composer-busy" aria-live="polite">Asking everyone who was in the call…</div>
                )}

                {phase === 'failed' && (
                    <>
                        <div className="clip-composer-section clip-composer-error"><WarningIcon size={16} /> {error ?? 'Something went wrong.'}</div>
                        <div className="clip-composer-actions">
                            <button className="clip-btn secondary" onClick={sealed ? discard : onClose}>{sealed ? 'Discard' : 'Close'}</button>
                            {!sealed && <button className="clip-btn primary" onClick={() => setPhase('choose')}>Try again</button>}
                            {sealed && uploadRetryable && activeClipRef.current && (outgoing?.expiresAt ?? 0) > now && (
                                <button className="clip-btn primary" onClick={() => void uploadAndPost(activeClipRef.current!, true)}>Try again</button>
                            )}
                        </div>
                    </>
                )}

                {phase === 'sealed' && sealed && (
                    <>
                        <div className="clip-composer-section">
                            {/* No video here, on purpose — nobody watches this, including you,
                                until every participant has approved (docs/CLIPS.md). Decide from
                                the metadata alone: does the length/size look right for what you
                                meant to grab? If not, discard and try a different window. */}
                            <p className="clip-composer-hint clip-composer-sealed-summary">
                                {formatClock(sealed.durationMs / 1000)} · {sealed.width}×{sealed.height} · {formatMB(sealed.totalCipherBytes)} in {sealed.partCount} encrypted part{sealed.partCount === 1 ? '' : 's'}
                                {sealed.leadInMs > 0 && <> · starts {Math.round(sealed.leadInMs / 100) / 10} s earlier than asked (clips start on a keyframe)</>}
                                {sealed.lostMs > 0 && <><br /><WarningIcon size={13} /> {Math.round(sealed.lostMs / 1000)} s recorded before a size change could not be included.</>}
                            </p>
                        </div>
                        {!localOnly && policy.available && (
                            <div className="clip-composer-section">
                                <label className="clip-composer-label" htmlFor="clip-target">Post to</label>
                                {resolution.kind === 'ok' ? (
                                    <p className="clip-composer-hint" id="clip-target">#{resolution.channel.name} <span className="clip-composer-muted">(this server posts all clips to one channel)</span></p>
                                ) : resolution.kind === 'loading' ? (
                                    <p className="clip-composer-hint" id="clip-target">Loading channels…</p>
                                ) : resolution.kind === 'load-failed' ? (
                                    <p className="clip-composer-hint" id="clip-target">
                                        <WarningIcon size={13} /> Could not load this server&rsquo;s channels — check your connection.{' '}
                                        <button className="clip-btn secondary" onClick={() => { setChannels(null); setChannelsFetchSeq(n => n + 1); }}>Retry</button>
                                    </p>
                                ) : resolution.kind === 'pin-missing' ? (
                                    <p className="clip-composer-hint" id="clip-target"><WarningIcon size={13} /> This server has no clips channel yet — the owner needs to pick one in Server Settings before clips can be posted. The clip stays in memory; Discard deletes it.</p>
                                ) : (
                                    <p className="clip-composer-hint" id="clip-target"><WarningIcon size={13} /> You cannot post in this server&rsquo;s clips channel, so this clip cannot be posted. It stays in memory; Discard deletes it.</p>
                                )}
                            </div>
                        )}
                        {error && <div className="clip-composer-section clip-composer-error"><WarningIcon size={16} /> {error}</div>}
                        <div className="clip-composer-actions">
                            {localOnly || !policy.available ? (
                                <>
                                    <span className="clip-composer-hint">This clip lives only in memory. Discard deletes it.</span>
                                    <button className="clip-btn primary" onClick={discard}>Discard</button>
                                </>
                            ) : (
                                <>
                                    <button className="clip-btn secondary" onClick={discard}>Discard</button>
                                    <button
                                        className="clip-btn primary"
                                        onClick={() => void requestApproval()}
                                        disabled={!canRequest}
                                        // The explanation is a section above; a
                                        // dead button still owes a reason to a
                                        // hover that never scrolled past it.
                                        title={canRequest ? undefined
                                            : resolution.kind === 'pin-missing' ? 'This server has no clips channel yet.'
                                            : resolution.kind === 'pin-unpostable' ? 'You cannot post in this server’s clips channel.'
                                            : resolution.kind === 'load-failed' ? 'The channel list could not be loaded.'
                                            : 'Waiting for the channel list…'}
                                    >Request approval</button>
                                </>
                            )}
                        </div>
                    </>
                )}

                {phase === 'approved' && sealed && nonApproved && (
                    <>
                        <div className="clip-composer-section">
                            <p className="clip-composer-outcome"><WarningIcon size={16} /> {nonApproved}</p>
                        </div>
                        <div className="clip-composer-actions">
                            <button className="clip-btn primary" onClick={() => { detachRef.current?.(); clearOutgoingClip(); onClose(); }}>Close</button>
                        </div>
                    </>
                )}

                {phase === 'approved' && sealed && !nonApproved && (() => {
                    const durMs = sealed.durationMs;
                    const endMs = trimEndMs ?? durMs;
                    const isTrimmed = trimStartMs > 0 || endMs < durMs;
                    const step = 500;
                    // The sliders are the user's INTENT; the worker re-muxes the
                    // kept range and snaps OUTWARD to the nearest keyframes (one
                    // GOP ≈ 2 s), so the result is never shorter than what was
                    // asked for. A clip of one GOP has nothing to trim to, and a
                    // very large clip is refused (the re-mux holds ~3× the clip).
                    const tooLargeToTrim = sealed.totalCipherBytes > TRIM_MAX_CIPHER_BYTES;
                    const canTrim = durMs >= TRIM_MIN_CLIP_MS && !tooLargeToTrim;
                    const keepMs = Math.max(0, endMs - trimStartMs);
                    const minutesLeft = postDeadlineMs !== null ? Math.max(0, Math.ceil((postDeadlineMs - now) / 60_000)) : null;
                    return (
                        <>
                            <div className="clip-composer-section">
                                <video ref={videoRef} className="clip-preview-video" controls playsInline muted={false} />
                                {previewState === 'loading' && <p className="clip-composer-hint">Loading preview…</p>}
                                {previewState === 'failed' && <p className="clip-composer-hint"><WarningIcon size={13} /> Preview could not play here — the clip itself is intact and will still post.</p>}
                                <p className="clip-composer-hint clip-composer-sealed-summary">
                                    {formatClock(durMs / 1000)} · {sealed.width}×{sealed.height} · {formatMB(sealed.totalCipherBytes)} in {sealed.partCount} encrypted part{sealed.partCount === 1 ? '' : 's'}
                                </p>
                            </div>
                            <div className="clip-composer-section clip-trim">
                                <div className="clip-composer-label">
                                    Trim <span className="clip-composer-muted">(optional — cuts snap outward to the nearest keyframe, about 2 s)</span>
                                </div>
                                {trimError && <p className="clip-composer-error"><WarningIcon size={13} /> {trimError}. The clip is unchanged — you can still post it as-is.</p>}
                                {sealed.canUndo && (
                                    <div className="clip-composer-actions clip-trim-actions">
                                        <span className="clip-composer-hint">Cut too much? Undo restores exactly what the last trim removed.</span>
                                        <button className="clip-btn secondary" onClick={() => void doUndo()} disabled={trimming || postWindowPassed}>
                                            {trimming ? 'Working…' : 'Undo last trim'}
                                        </button>
                                    </div>
                                )}
                                {!canTrim ? (
                                    <p className="clip-composer-hint">{tooLargeToTrim ? 'This clip is too large to trim here — post it as-is.' : 'This clip is too short to trim — post it as-is.'}</p>
                                ) : (
                                    <>
                                        <label className="clip-trim-row">
                                            <span className="clip-trim-label">Start</span>
                                            <input
                                                type="range" min={0} max={Math.max(0, endMs - step)} step={step} value={Math.min(trimStartMs, Math.max(0, endMs - step))}
                                                onChange={e => setTrimStartMs(Math.min(Number(e.target.value), Math.max(0, endMs - step)))}
                                                disabled={trimming || postWindowPassed} aria-label="Trim start" aria-valuetext={`${formatClock(trimStartMs / 1000)} in`}
                                            />
                                            <span className="clip-trim-value">{formatClock(trimStartMs / 1000)}</span>
                                        </label>
                                        <label className="clip-trim-row">
                                            <span className="clip-trim-label">End</span>
                                            <input
                                                type="range" min={Math.min(durMs, trimStartMs + step)} max={durMs} step={step} value={endMs}
                                                onChange={e => setTrimEndMs(Math.max(Number(e.target.value), Math.min(durMs, trimStartMs + step)))}
                                                disabled={trimming || postWindowPassed} aria-label="Trim end" aria-valuetext={`${formatClock(endMs / 1000)}`}
                                            />
                                            <span className="clip-trim-value">{formatClock(endMs / 1000)}</span>
                                        </label>
                                        <p className="clip-composer-hint" aria-live="polite">
                                            {!isTrimmed
                                                ? (trimNote ?? <>Whole clip ({formatClock(durMs / 1000)}). Drag the handles to trim, or just post as-is.</>)
                                                : <>Will keep about <strong>{formatClock(trimStartMs / 1000)} – {formatClock(endMs / 1000)}</strong> ({formatClock(keepMs / 1000)}), widened to the nearest keyframes. Apply, then check the preview before posting.</>}
                                        </p>
                                        {isTrimmed && (
                                            <div className="clip-composer-actions clip-trim-actions">
                                                <button className="clip-btn secondary" onClick={() => { setTrimStartMs(0); setTrimEndMs(null); setTrimError(null); }} disabled={trimming}>Reset</button>
                                                <button className="clip-btn secondary" onClick={() => void applyTrim()} disabled={trimming || postWindowPassed || previewState === 'loading'} title={previewState === 'loading' ? 'Wait for the preview to load' : undefined}>{trimming ? 'Trimming…' : 'Apply trim'}</button>
                                            </div>
                                        )}
                                    </>
                                )}
                            </div>
                            {postWindowPassed ? (
                                <p className="clip-composer-error"><WarningIcon size={13} /> The window to post this clip has passed — the server no longer accepts it. Discard it, and ask again if you still want to post it.</p>
                            ) : minutesLeft !== null && (
                                <p className="clip-composer-hint"><ShieldCheckIcon size={13} /> Post within {Math.max(1, minutesLeft)} min — after that the approval lapses and the clip is discarded.</p>
                            )}
                            <div className="clip-composer-actions">
                                <button className="clip-btn secondary" onClick={discard} disabled={trimming}>Discard</button>
                                <button
                                    className="clip-btn primary"
                                    onClick={() => { if (activeClipRef.current) void uploadAndPost(activeClipRef.current, false); }}
                                    disabled={trimming || isTrimmed || postWindowPassed}
                                    title={isTrimmed ? 'Apply or reset the trim first' : postWindowPassed ? 'The window to post has passed' : undefined}
                                >
                                    Post
                                </button>
                            </div>
                        </>
                    );
                })()}

                {phase === 'pending' && outgoing && (
                    <>
                        <div className="clip-composer-section">
                            {nonApproved ? (
                                <p className="clip-composer-outcome"><WarningIcon size={16} /> {nonApproved}</p>
                            ) : (
                                <>
                                    <div className="clip-composer-label">Waiting for approval — {outgoing.approvedCount} of {outgoing.total} approved</div>
                                    <ul className="clip-approver-list" aria-label="People who must approve">
                                        {outgoing.approvers.map(a => (
                                            <li key={a.id} className="clip-approver">
                                                <span className={`clip-approver-dot ${a.online ? 'online' : ''}`} aria-hidden="true" />
                                                <span className="clip-approver-name">{a.username}</span>
                                                <span className="clip-composer-muted">
                                                    {a.online ? 'online' : 'offline — they can answer from any device'}
                                                    {a.in_window === false && ' · the server did not see them in the call during this clip; your app did'}
                                                </span>
                                            </li>
                                        ))}
                                    </ul>
                                    <p className="clip-composer-hint">Votes are anonymous: you will see the count, and whether someone declined — not who.</p>
                                    <p className="clip-composer-hint"><ShieldCheckIcon size={13} /> Nothing has left your PC. Expires in {Math.max(1, Math.ceil((outgoing.expiresAt - now) / 60_000))} min.</p>
                                </>
                            )}
                        </div>
                        <div className="clip-composer-actions">
                            {nonApproved ? (
                                <button className="clip-btn primary" onClick={() => { clearOutgoingClip(); onClose(); }}>Close</button>
                            ) : (
                                <button className="clip-btn secondary" onClick={() => void cancelRequest()}>Cancel request</button>
                            )}
                        </div>
                    </>
                )}

                {(phase === 'uploading' || phase === 'posting') && (
                    <div className="clip-composer-section clip-composer-busy" aria-live="polite">
                        {phase === 'uploading'
                            ? (replay.upload ? `Everyone approved — uploading ${Math.min(replay.upload.done + 1, replay.upload.total)} of ${replay.upload.total}${sealed ? ` · ${Math.round(100 * replay.upload.bytesDone / Math.max(1, sealed.totalCipherBytes))}%` : ''}` : 'Everyone approved — uploading…')
                            : 'Posting…'}
                    </div>
                )}

                {phase === 'done' && (
                    <>
                        <div className="clip-composer-section clip-composer-outcome"><ShieldCheckIcon size={16} /> Posted to #{postedTo}.</div>
                        <div className="clip-composer-actions">
                            <button className="clip-btn primary" onClick={() => { clearOutgoingClip(); onClose(); }}>Close</button>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
