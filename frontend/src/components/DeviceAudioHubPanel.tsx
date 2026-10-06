/**
 * Audio Hub on the owner's own PC, from its card in My Devices.
 *
 * Audio Hub is the owner's tray app for their AirPods and Sony XM6; its
 * "hand-over" lets a headset go so the phone can take it, or takes it back.
 * This panel reaches it through the same device session as Control and Files
 * (api/devices/audioHub.ts has the contract and the security model): it rides
 * a session already open to that PC, or opens a files-only one of its own and
 * ends it when the panel closes.
 *
 * Availability is asked, not advertised. Whether Audio Hub runs is a fact on
 * that PC; publishing it through presence would tell the server something it
 * has no need to know and cost a poll on every host for a panel almost nobody
 * opens. So the panel asks once when it opens (and on Refresh), and shows the
 * controls only when the PC says Audio Hub answered.
 *
 * Phone first: one column at 390 px, 44 px targets on a coarse pointer, theme
 * tokens only, icons from Icons.tsx.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
    activeSessions,
    audioHubSessionFor,
    connectToDevice,
    endSession,
    sendAudioHubRequest,
    subscribeSessions,
} from '../api/devices/session';
import {
    AUDIO_HUB_IDLE_CLOSE_MS,
    AUDIO_HUB_REREAD_MS,
    isToPhone,
    type AudioHubOp,
    type AudioHubOutcome,
    type AudioHubStatus,
} from '../api/devices/audioHub';
import { openBluetoothSettings } from '../api/mobileApp';
import { isAndroidApp } from '../api/platform';
import { CloseIcon, HeadphonesIcon, RefreshIcon } from './Icons';
import './DeviceAudioHubPanel.css';

type View =
    | { k: 'connecting' }
    | { k: 'checking' }
    | { k: 'ready'; status: AudioHubStatus }
    /** Not running, unsupported, or no usable status: one sentence, no controls. */
    | { k: 'unavailable'; message: string };

interface Notice {
    tone: 'ok' | 'error';
    text: string;
}


/** Has the headset `op` moved got where it was sent? Only a definite answer
 *  counts: an XM6 whose place Audio Hub cannot tell (null) keeps the
 *  re-reads going until they run out. */
function arrived(op: AudioHubOp, st: AudioHubStatus): boolean {
    switch (op) {
        case 'airpods-phone': return st.airpods.onPc === false;
        case 'airpods-pc': return st.airpods.onPc === true;
        case 'xm6-phone': return st.xm6.onPc === false;
        case 'xm6-pc': return st.xm6.onPc === true;
        default: return true;
    }
}

/** Where a headset is, in words, when Audio Hub says. */
function whereIs(headset: 'airpods' | 'xm6', st: AudioHubStatus): string | null {
    if (headset === 'airpods') {
        if (st.airpods.onPc === true) return 'On the PC';
        if (st.airpods.handedToPhone) return 'Handed to the phone';
        if (st.airpods.onPc === false) return 'Not on the PC';
        return null;
    }
    if (st.xm6.onPc === true) return 'On the PC';
    if (st.xm6.onPc === false) return 'Not on the PC';
    return null;
}

/** The button for where the headset already is: still pressable (Audio Hub
 *  decides), just played down. */
function alreadyThere(op: AudioHubOp, st: AudioHubStatus): boolean {
    switch (op) {
        case 'airpods-pc': return st.airpods.onPc === true;
        case 'airpods-phone': return st.airpods.handedToPhone;
        case 'xm6-pc': return st.xm6.onPc === true;
        default: return false;
    }
}


const ACTIONS: { op: AudioHubOp; label: string; headset: 'airpods' | 'xm6' }[] = [
    { op: 'airpods-phone', label: 'To phone', headset: 'airpods' },
    { op: 'airpods-pc', label: 'To PC', headset: 'airpods' },
    { op: 'xm6-phone', label: 'To phone', headset: 'xm6' },
    { op: 'xm6-pc', label: 'To PC', headset: 'xm6' },
];

const FULL_LABEL: Record<AudioHubOp, string> = {
    status: 'Refresh',
    'airpods-phone': 'AirPods to phone',
    'airpods-pc': 'AirPods to PC',
    'xm6-phone': 'XM6 to phone',
    'xm6-pc': 'XM6 to PC',
};

export interface DeviceAudioHubPanelProps {
    /** The PC's APP row — the Púca desktop app, which is what talks to Audio
     *  Hub. Never the sign-in-screen row. */
    hostDevice: string;
    machineName: string;
    onClose: () => void;
}

export function DeviceAudioHubPanel({ hostDevice, machineName, onClose }: DeviceAudioHubPanelProps) {
    const [view, setView] = useState<View>({ k: 'connecting' });
    const [busy, setBusy] = useState<AudioHubOp | null>(null);
    const [notice, setNotice] = useState<Notice | null>(null);
    /** The session this panel OPENED (and so must end), if it opened one. */
    const ownSession = useRef<string | null>(null);
    /** The session requests go out on — ours or one already open. */
    const sessionId = useRef<string | null>(null);
    const mounted = useRef(true);
    const rereadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    /** A status read is outstanding — keeps a session update from sending a
     *  second one, and Refresh from stacking them. */
    const reading = useRef(false);
    /** The session this panel opened has not gone live yet; read the status
     *  the moment it does. */
    const pendingRead = useRef(false);

    /** Something was pressed: restart the idle clock. */
    const touch = useCallback((): void => {
        if (idleTimer.current) clearTimeout(idleTimer.current);
        idleTimer.current = setTimeout(() => {
            idleTimer.current = null;
            const own = ownSession.current;
            if (!own || !mounted.current) return;
            ownSession.current = null;
            sessionId.current = null;
            pendingRead.current = false;
            endSession(own, 'Audio Hub idle');
            setBusy(null);
            setView({ k: 'unavailable', message: 'Disconnected after 5 minutes without use. Refresh to reconnect.' });
        }, AUDIO_HUB_IDLE_CLOSE_MS);
    }, []);

    const applyOutcome = useCallback((o: AudioHubOutcome): void => {
        if (!mounted.current) return;
        if (o.kind === 'status') setView({ k: 'ready', status: o.status });
        else if (o.kind === 'not-running' || o.kind === 'unsupported') setView({ k: 'unavailable', message: o.message });
        else if (o.kind === 'error') setView({ k: 'unavailable', message: o.message });
    }, []);

    /** Read and show the status; the outcome, or null when no read went out
     *  (no session, or one already in flight). */
    const readStatus = useCallback(async (): Promise<AudioHubOutcome | null> => {
        const id = sessionId.current;
        if (!id || reading.current) return null;
        reading.current = true;
        try {
            const o = await sendAudioHubRequest(id, 'status');
            applyOutcome(o);
            return o;
        } finally {
            reading.current = false;
        }
    }, [applyOutcome]);

    /** Follow a queued hand-over with the re-reads above. */
    const followHandOver = useCallback((op: AudioHubOp): void => {
        if (rereadTimer.current) clearTimeout(rereadTimer.current);
        const step = (i: number, at: number): void => {
            if (i >= AUDIO_HUB_REREAD_MS.length) return;
            rereadTimer.current = setTimeout(() => {
                rereadTimer.current = null;
                if (!mounted.current) return;
                void readStatus().then(o => {
                    if (!mounted.current || rereadTimer.current) return;
                    // Settled, or no longer anything to read: stop.
                    if (o && o.kind !== 'status') return;
                    if (o?.kind === 'status' && arrived(op, o.status)) return;
                    step(i + 1, AUDIO_HUB_REREAD_MS[i]);
                });
            }, AUDIO_HUB_REREAD_MS[i] - at);
        };
        step(0, 0);
    }, [readStatus]);

    /** Find or open the session, then read the status once it is live. */
    const connect = useCallback(async (): Promise<void> => {
        touch();
        const existing = audioHubSessionFor(hostDevice);
        if (existing) {
            sessionId.current = existing;
            if (mounted.current) setView({ k: 'checking' });
            await readStatus();
            return;
        }
        if (mounted.current) setView({ k: 'connecting' });
        try {
            pendingRead.current = true;
            const id = await connectToDevice(hostDevice, { audioHub: true });
            ownSession.current = id;
            sessionId.current = id;
            // The status read goes out from the session subscription below,
            // once this session reports 'active'. A connect that failed on the
            // spot (no server connection) ended before its id was known here,
            // so the subscription never saw it: say so now.
            const s = activeSessions().find(x => x.id === id);
            if (!s || s.phase === 'ended') {
                sessionId.current = null;
                ownSession.current = null;
                pendingRead.current = false;
                if (mounted.current) {
                    setView({ k: 'unavailable', message: s?.error ?? 'Could not connect to that PC — check your connection.' });
                }
            } else if (s.phase === 'active' && pendingRead.current) {
                pendingRead.current = false;
                if (mounted.current) setView({ k: 'checking' });
                await readStatus();
            }
        } catch (e) {
            if (mounted.current) {
                setView({ k: 'unavailable', message: e instanceof Error ? e.message : 'Could not connect to that PC.' });
            }
        }
    }, [hostDevice, readStatus, touch]);

    // Follow the session: read the status when it goes live; say why when it
    // ends. `readStatus` is stable (its only dependency is), so this
    // subscribes once.
    useEffect(() => subscribeSessions(all => {
        const id = sessionId.current;
        if (!id) return;
        const s = all.find(x => x.id === id);
        if (!s || s.phase === 'ended') {
            sessionId.current = null;
            pendingRead.current = false;
            if (ownSession.current === id) ownSession.current = null;
            if (!mounted.current) return;
            setBusy(null);
            setView({ k: 'unavailable', message: s?.error ?? 'The connection to that PC ended.' });
            return;
        }
        if (s.phase === 'active' && pendingRead.current) {
            pendingRead.current = false;
            setView({ k: 'checking' });
            void readStatus();
        }
    }), [readStatus]);

    useEffect(() => {
        mounted.current = true;
        void connect();
        return () => {
            mounted.current = false;
            if (rereadTimer.current) clearTimeout(rereadTimer.current);
            if (idleTimer.current) clearTimeout(idleTimer.current);
            // End only what this panel opened. A Control or Files session the
            // owner already had stays exactly as it was.
            const own = ownSession.current;
            ownSession.current = null;
            if (own) endSession(own, 'closed Audio Hub');
        };
    }, [connect]);

    const refresh = (): void => {
        touch();
        setNotice(null);
        if (!sessionId.current) {
            void connect();
            return;
        }
        setView({ k: 'checking' });
        void readStatus();
    };

    const act = async (op: AudioHubOp): Promise<void> => {
        const id = sessionId.current;
        if (!id || busy) return;
        touch();
        setBusy(op);
        setNotice(null);
        const o = await sendAudioHubRequest(id, op);
        if (!mounted.current) return;
        setBusy(null);
        if (o.kind === 'action') {
            if (!o.ok) {
                setNotice({ tone: 'error', text: o.error ?? 'Audio Hub refused that.' });
                return;
            }
            let text = o.message ?? 'Done.';
            if (isToPhone(op) && isAndroidApp()) {
                // Android lets no ordinary app connect a headset: the person
                // taps it in Bluetooth settings. Opened ONLY after Audio Hub
                // said the PC let go — never on a refusal or a timeout.
                const opened = await openBluetoothSettings();
                if (!opened) text += ' Open Bluetooth settings on this phone to connect it.';
            }
            if (!mounted.current) return;
            setNotice({ tone: 'ok', text });
            followHandOver(op);
            return;
        }
        if (o.kind === 'error') {
            setNotice({ tone: 'error', text: o.message });
            return;
        }
        // Audio Hub stopped, or the PC cannot do this after all: the controls
        // go, and the sentence says why.
        applyOutcome(o);
    };

    const title = `Audio Hub on ${machineName}`;

    return (
        <section className="audio-hub-panel" aria-label={title}>
            <div className="audio-hub-head">
                <span className="audio-hub-title">
                    <span className="audio-hub-title-icon" aria-hidden="true"><HeadphonesIcon /></span>
                    Audio Hub
                </span>
                <button
                    type="button"
                    className="device-btn device-btn-icon audio-hub-icon-btn"
                    onClick={refresh}
                    disabled={busy !== null || view.k === 'connecting' || view.k === 'checking'}
                    title="Refresh"
                >
                    <span className="device-btn-icon-glyph" aria-hidden="true"><RefreshIcon size={16} /></span>
                    <span className="sr-only">Refresh Audio Hub</span>
                </button>
                <button
                    type="button"
                    className="device-btn device-btn-icon audio-hub-icon-btn"
                    onClick={onClose}
                    title="Close Audio Hub"
                >
                    <span className="device-btn-icon-glyph" aria-hidden="true"><CloseIcon size={16} /></span>
                    <span className="sr-only">Close Audio Hub</span>
                </button>
            </div>

            {view.k === 'connecting' && <div className="audio-hub-note" role="status">Connecting to {machineName}…</div>}
            {view.k === 'checking' && <div className="audio-hub-note" role="status">Asking {machineName} about Audio Hub…</div>}
            {view.k === 'unavailable' && <div className="audio-hub-note" role="status">{view.message}</div>}

            {view.k === 'ready' && (
                <>
                    {(['airpods', 'xm6'] as const).map(headset => {
                        const st = view.status;
                        const where = whereIs(headset, st);
                        // Both XM6 hand-overs go through FlooCast; without it
                        // Audio Hub can only answer 503, so say that instead.
                        const blocked = headset === 'xm6' && !st.xm6.available;
                        return (
                            <div key={headset} className="audio-hub-headset">
                                <div className="audio-hub-line">{st[headset].line}</div>
                                {where && <div className="audio-hub-where">{where}</div>}
                                {blocked ? (
                                    <div className="audio-hub-note">
                                        FlooCast isn't running on that PC, so the XM6 can't be handed over.
                                    </div>
                                ) : (
                                    <>
                                        <div className="audio-hub-actions">
                                            {ACTIONS.filter(a => a.headset === headset).map(a => (
                                                <button
                                                    key={a.op}
                                                    type="button"
                                                    className={`device-btn${alreadyThere(a.op, st) ? ' audio-hub-btn-here' : ''}`}
                                                    disabled={busy !== null}
                                                    aria-busy={busy === a.op}
                                                    aria-label={FULL_LABEL[a.op]}
                                                    onClick={() => void act(a.op)}
                                                >
                                                    {busy === a.op ? 'Working…' : a.label}
                                                </button>
                                            ))}
                                        </div>
                                        {headset === 'xm6' && (
                                            <div className="audio-hub-hint">
                                                To bring it back to the PC, disconnect it on the phone first.
                                            </div>
                                        )}
                                    </>
                                )}
                            </div>
                        );
                    })}
                    {view.status.devices && <div className="audio-hub-devices">{view.status.devices}</div>}
                </>
            )}

            {notice && (
                <div
                    className={`audio-hub-notice${notice.tone === 'error' ? ' audio-hub-notice-error' : ''}`}
                    role={notice.tone === 'error' ? 'alert' : 'status'}
                >
                    {notice.text}
                </div>
            )}
        </section>
    );
}
