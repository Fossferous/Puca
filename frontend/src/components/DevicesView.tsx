/**
 * Devices — a first-class view, not a settings popup.
 *
 * This replaces DevicesModal + DevicesSettings. The machine list was buried
 * under five this-device setup cards inside a modal, which made the app's
 * remote-desktop feature read as an account setting. It is a destination:
 * the rail button now opens this full dashboard (the FriendsPanel pattern —
 * same fixed-overlay slot on desktop, same mobile panel citizenship).
 *
 * Two tabs, because the content answers two different questions:
 *
 *   - MY DEVICES: every machine on the account, as cards. Connect/Files/Wake
 *     live here. This is the tab you come for, so it is the default.
 *   - THIS DEVICE: how the machine you are sitting at behaves as a host —
 *     key custody, capture diagnosis, autostart, port forwarding, unattended
 *     arming, phone file sharing. Device-local facts, deliberately separated
 *     so they stop reading as settings for whichever device you had in mind
 *     (that confusion shipped once: see the unattended card's comment).
 *
 * Carried over unchanged from DevicesSettings, because they are the point:
 *
 *  1. VERIFICATION STATE. Every row is checked against the account signing key
 *     this client derives from its own seed. A row that fails is shown with a
 *     warning instead of being dropped — "the server returned a device you
 *     never enrolled" is precisely what a user needs to be told.
 *  2. KEY CUSTODY. Desktop keeps the device key in an OS-protected store;
 *     web/mobile keeps it in browser storage. That difference decides whether
 *     a device may ever act as an unattended host, so it is stated plainly.
 *
 * WAKE & CONNECT. The chain that was missing for three releases is now
 * complete: `lan.rs` collects this machine's MAC/IP/broadcast from the
 * physical adapter, `lanInfo.ts` seals it and PATCHes it on every device
 * attestation, `planWake` picks a waker that is online, on the same subnet and
 * actually CAPABLE of broadcasting, and `wakeSession.ts` waits for the target
 * to reappear before opening the session.
 *
 * The button is offered ONLY on an offline device, and every reason it can
 * fail is stated rather than hidden — because a magic packet is
 * unacknowledged, so "nothing happened" is otherwise indistinguishable from
 * "not supported here". The load-bearing honesty:
 *   - waking needs a SECOND machine already awake on that subnet;
 *   - a phone or browser tab can press the button but cannot be the waker;
 *   - autostart fires at USER SIGN-IN, not at boot, so a machine that was
 *     fully shut down stops at the Windows sign-in screen with Puca not
 *     running — resume-from-sleep is the case that works end to end;
 *   - nobody at the keyboard means unattended access must already be armed on
 *     that machine.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
    listDevices,
    renameDevice,
    revokeDevice,
    isThisDeviceRevoked,
    resetThisDeviceIdentity,
    currentUserId,
    thisDeviceId,
    type VerifiedDevice,
} from '../api/devices';
import { deviceKeyCustody } from '../api/devices/deviceKey';
import { warmPeerKeys } from '../api/devices/peerKeys';
import { fetchIceConfig } from '../api/iceConfig';
import { agentDiagnosis } from '../api/devices/hostAgent';
import { connectToDevice, subscribeSessions } from '../api/devices/session';
import {
    wakeAndConnect,
    cancelWake,
    subscribeWakes,
    wakePhaseIsLive,
    type WakeState,
} from '../api/devices/wakeSession';
import { usePullToRefresh } from '../hooks/usePullToRefresh';
import { isMobile } from '../api/platform';
import { forgetHostBackendChoice } from '../api/devices/hostBackend';
import { autostartSupported, isAutostartEnabled, setAutostart } from '../api/devices/autostart';
import { pairWaker, parseWakerKeys, type WakerBootstrap } from '../api/devices/waker';
import { groupIntoMachines, machineOf, ungrouped, type Machine } from '../api/devices/machines';
import {
    lockScreenSupported,
    lockScreenState,
    enableLockScreenAccess,
    disableLockScreenAccess,
    type LockScreenState,
    unattendedAccessState,
    enrolLockScreenAccess,
    unenrolLockScreenAccess,
    armLockScreenAccess,
    disarmLockScreenAccess,
    serviceNeedsUpdate,
    bundledServiceFingerprint,
    updateLockScreenService,
    type UnattendedAccessState,
} from '../api/devices/lockScreen';
import { getTunnelPolicy, setTunnelForwarding, tunnelSupported } from '../api/devices/tunnel';
import {
    armUnattended,
    disarmUnattended,
    unattendedState,
    unattendedSupported,
} from '../api/devices/unattendedHost';
import {
    listIncomingShares,
    respondShare,
    deleteShare,
    type IncomingShare,
} from '../api/devices/shares';
import { wsClient } from '../api/websocket';
import { DeviceShareModal } from './DeviceShareModal';
import { BanIcon, CloseIcon, Icon, MonitorIcon, SettingsIcon, ShieldCheckIcon, TrashIcon, WarningIcon, type IconName } from './Icons';
import './DevicesView.css';

/** How often the list re-checks presence while the view is open. Same cadence
 *  as FriendsPanel, for the same reason: online/offline flips have no WS push
 *  to this surface, so without it the Control button only appears on reopen. */
const PRESENCE_REFRESH_MS = 15_000;

/**
 * The pre-grant surface for "browse this phone's files from another device".
 *
 * All-files access is a system Settings TOGGLE, not a runtime dialog — so it
 * cannot be granted inside the 30-second consent prompt without the deadline
 * auto-denying behind the user's back. This card is where it happens instead,
 * once, ahead of time; the consent prompt still decides per session and per
 * folder. Re-checks when the app returns to the foreground, because that is
 * exactly the moment someone comes back from the Settings screen.
 */
function PhoneFileSharingCard() {
    // THREE states, not two. `null` alone conflated "still asking the plugin"
    // with "there is no plugin", so the card painted "update the app on this
    // phone" for the whole of a bridge round trip on a perfectly capable
    // build — an error message as the first thing the user sees, for a
    // condition that is usually false.
    const [status, setStatus] = useState<{ hasAllFilesAccess: boolean; sdk: number } | null | 'loading'>('loading');
    /** WHY it is unavailable, when it is. See filesDiagnostics(). */
    const [diag, setDiag] = useState<import('../api/devices/hostCapacitor').FilesDiagnostics | null>(null);
    /** The module itself failed to load — distinct from the plugin missing. */
    const [loadError, setLoadError] = useState<string | null>(null);

    useEffect(() => {
        let live = true;
        const check = () => {
            void import('../api/devices/hostCapacitor').then(async m => {
                const [st, d] = await Promise.all([m.allFilesAccessStatus(), m.filesDiagnostics()]);
                if (!live) return;
                setStatus(st);
                setDiag(d);
            }).catch(e => {
                if (!live) return;
                setStatus(null);
                setLoadError(e instanceof Error ? e.message : String(e));
            });
        };
        check();
        const vis = () => { if (document.visibilityState === 'visible') check(); };
        document.addEventListener('visibilitychange', vis);
        return () => { live = false; document.removeEventListener('visibilitychange', vis); };
    }, []);

    const requestAccess = () => {
        void import('../api/devices/hostCapacitor').then(m => m.requestAllFilesAccess());
    };

    return (
        <div className="dv-card">
            <div className="device-option">
                <div className="option-info">
                    <label>File sharing from this phone</label>
                    <span className="option-hint">
                        {status === 'loading'
                            ? 'Checking…'
                            : status === null
                                ? 'File sharing is unavailable on this phone.'
                                : status.sdk < 30
                                    ? `Sharing files needs Android 11 or newer (this phone reports API ${status.sdk}).`
                                    : status.hasAllFilesAccess
                                        ? 'Ready. When another of your devices asks to browse files, '
                                          + 'a prompt on this phone picks the folder and answers.'
                                        : 'Lets your other devices browse a folder on this phone, after '
                                          + 'a prompt here approves each session. Needs the system '
                                          + '"All files access" permission, granted on a Settings screen.'}
                    </span>
                    {/* THE DIAGNOSIS, not a guess. "Update the app" was one
                        message standing in for four different causes, and the
                        failing step is on the handset where nobody can read a
                        log. Shown only when something is actually wrong. */}
                    {status === null && (
                        <span className="option-hint option-hint-dim">
                            {loadError
                                ? `Diagnostic: the file-sharing module failed to load — ${loadError}`
                                : diag && !diag.pluginVisible
                                    ? `Diagnostic: platform "${diag.platform}", but the native file plugin is `
                                      + 'not registered. This build of the APK does not carry it — install the '
                                      + 'latest APK from download.example.com (an over-the-air update cannot add it).'
                                    : diag?.error
                                        ? `Diagnostic: the plugin is present but returned an error — ${diag.error}`
                                        : 'Diagnostic: unavailable for an unknown reason.'}
                        </span>
                    )}
                </div>
                {status !== null && status !== 'loading' && status.sdk >= 30 && !status.hasAllFilesAccess && (
                    <button type="button" className="device-btn" onClick={requestAccess}>
                        Open Settings
                    </button>
                )}
            </div>
        </div>
    );
}

const PLATFORM_ICON: Record<string, IconName> = {
    windows: 'monitor',
    linux: 'terminal',
    macos: 'laptop',
    android: 'phone',
    ios: 'phone',
    web: 'globe',
};

function formatSeen(device: VerifiedDevice): string {
    if (device.online) return 'Online now';
    if (!device.last_seen_at) return 'Never connected';
    const seen = new Date(device.last_seen_at);
    if (Number.isNaN(seen.getTime())) return 'Last seen: unknown';
    return `Last seen ${seen.toLocaleString()}`;
}

interface DevicesViewProps {
    onClose: () => void;
    /** Open app Settings. This view is a fixed overlay that covers the
     *  sidebar (and with it the only settings cog), so it carries its own. */
    onOpenSettings?: () => void;
}

export function DevicesView({ onClose, onOpenSettings }: DevicesViewProps) {
    const [tab, setTab] = useState<'devices' | 'this'>('devices');
    const [devices, setDevices] = useState<VerifiedDevice[] | null>(null);
    /** An ACTION's failure (rename, revoke, arm, a toggle). Survives the poll. */
    const [error, setError] = useState<string | null>(null);
    // Pairing an always-on waker. Kept in this component rather than a store:
    // it is a one-time operator action with no state worth surviving a
    // navigation, and the result is deliberately transient — it contains a
    // session token and should not linger anywhere it could be read later.
    const [wakerPaste, setWakerPaste] = useState('');
    const [wakerOut, setWakerOut] = useState<WakerBootstrap | null>(null);
    // The REAL state, re-read from Windows rather than remembered. The service
    // can be removed with `sc delete` or by another administrator without this
    // app ever seeing it, and a stored boolean would then show a switch that is
    // on while nothing is installed.
    const [lockScreen, setLockScreen] = useState<LockScreenState | null>(null);
    // The two switches BEHIND the install: reachable at all, and armed with a
    // passphrase. Both are required, and both are read from the machine.
    const [signIn, setSignIn] = useState<UnattendedAccessState | null>(null);
    const [signInPassphrase, setSignInPassphrase] = useState('');
    const [signInError, setSignInError] = useState<string | null>(null);
    /** Fingerprint of the service+agent pair bundled with THIS app build. */
    const [bundledHash, setBundledHash] = useState<string | null>(null);
    /** Set only when the bundled pair SHOULD have been readable and was not —
     *  see `BundledFingerprint`. Surfaced so a real problem here is reportable
     *  instead of looking identical to "already up to date". */
    const [bundledError, setBundledError] = useState<string | null>(null);
    /** The LIST's own failure. Cleared by the next successful load; kept apart
     *  from `error` so a 15s poll cannot erase what the user just did wrong. */
    const [loadError, setLoadError] = useState<string | null>(null);
    /** Newest-wins guard for concurrent refreshes — see refresh(). */
    const refreshSeq = useRef(0);
    /** Mirrors `devices` for use inside refresh without making it a dependency
     *  (refresh is a stable useCallback that the poll effect depends on). */
    const devicesRef = useRef<VerifiedDevice[] | null>(null);
    /**
     * The device rows folded into physical machines — ONE CARD PER COMPUTER.
     *
     * A PC with sign-in-screen access enrolled has two rows (the app's and the
     * LocalSystem service's, each with its own keypair because neither may hold
     * the other's), and it used to list as two computers. Worse than untidy:
     * the row you can reach while it is locked had no MAC and could never be
     * woken, while the row that could be woken is offline exactly then. Rows
     * that share a MAC are one machine — see `machines.ts`.
     *
     * Derived asynchronously because the MAC lives inside the client-encrypted
     * `lan_info`, so grouping means decrypting. Held in state rather than
     * computed in render for the same reason.
     */
    const [machines, setMachines] = useState<Machine[]>([]);
    const [busyId, setBusyId] = useState<string | null>(null);
    /** Live wake/boot/connect progress, keyed by device id. Owned by
     *  wakeSession so it survives this view unmounting mid-wait (the user can
     *  navigate away during a three-minute boot and come back to it). */
    const [wakes, setWakes] = useState<ReadonlyMap<string, WakeState>>(new Map());
    const [editingId, setEditingId] = useState<string | null>(null);
    const [draftName, setDraftName] = useState('');
    const [confirmId, setConfirmId] = useState<string | null>(null);
    const [autostart, setAutostartState] = useState<boolean | null>(null);
    const [forwarding, setForwardingState] = useState<boolean | null>(null);
    const [unattended, setUnattendedState] = useState<boolean | null>(null);
    const [uaPass, setUaPass] = useState('');
    const [uaOpen, setUaOpen] = useState(false);
    // Whether the server has told this machine it was signed out. Read on every
    // refresh rather than held only at the moment of the 403, so it survives the
    // user opening this view later.
    const [signedOut, setSignedOut] = useState(false);
    /** The device whose sharing is being managed, or null. */
    const [shareDeviceId, setShareDeviceId] = useState<string | null>(null);
    /** Shares OFFERED TO ME — pending invites and accepted access. */
    const [incoming, setIncoming] = useState<IncomingShare[] | null>(null);
    /** Two-step confirm for walking away from a share, like device revoke. */
    const [removeShareId, setRemoveShareId] = useState<number | null>(null);
    /** Why direct screen capture is or is not working on this machine. Null on a
     *  build that predates the agent, and on mobile/web where it cannot apply. */
    const [captureInfo, setCaptureInfo] = useState<string | null>(null);

    /** What this machine is called in the list, so a device-local setting can
     *  name the device it applies to instead of saying "this computer" beside a
     *  list of every other one. Null until the list loads. */
    const thisDeviceName = devices?.find(
        d => d.isThisDevice || d.id === thisDeviceId(),
    )?.name ?? null;

    // Re-fold whenever the list changes. Cancelled on replacement so a slow
    // decrypt from an earlier poll cannot overwrite a newer grouping.
    //
    // NEVER AN EMPTY GRID WHILE THE FOLD RUNS. The fold decrypts and is async;
    // between `devices` landing and the fold resolving, this used to render
    // zero cards — no spinner, no empty-state message, because `devices` was a
    // real array. On every entry to the view. The synchronous ungrouped view is
    // painted first (exactly the pre-merge picture) and the fold replaces it.
    useEffect(() => {
        if (!devices) {
            setMachines([]);
            return;
        }
        setMachines(prev => (prev.length === 0 ? ungrouped(devices) : prev));
        let live = true;
        void groupIntoMachines(devices).then(m => {
            if (live) setMachines(m);
        });
        return () => { live = false; };
    }, [devices]);

    /**
     * Reload the list. Resolves to the list it painted, or null when it did
     * not paint one (failed, or a newer refresh won) — so a caller that needs
     * the FRESH picture right now (Control, deciding which row to open) can
     * read it without waiting for state to round-trip through React.
     */
    const refresh = useCallback(async (background = false): Promise<VerifiedDevice[] | null> => {
        const userId = currentUserId();
        if (userId == null) {
            setError('Sign in to manage your devices.');
            setDevices([]);
            return null;
        }
        // SEQUENCE NUMBER, not a bare await. The 15s poll now runs concurrently
        // with every mutation, and `listDevices` has no ordering guarantee — a
        // poll issued BEFORE a revoke can land AFTER it and paint the revoked
        // machine back into the grid with live Control/Files buttons. Only the
        // newest request may write state.
        const seq = ++refreshSeq.current;
        try {
            const list = await listDevices(userId);
            if (seq !== refreshSeq.current) return null; // a newer refresh won
            setDevices(list);
            // CONNECT-TIME: the first Control click otherwise pays another full
            // GET /devices before key agreement can start, for data we are
            // holding right here. Only verified records are cached (the same
            // rule as the on-demand path), so this changes latency, not trust.
            warmPeerKeys(list);
            // Clear ONLY a load error. `error` is the single slot every action
            // failure writes to ("Rename failed", "permission denied", a failed
            // arm), and clearing it on every successful poll wiped the user's
            // explanation within 15 seconds of them causing it — often before
            // it could be read.
            setLoadError(null);
            setSignedOut(isThisDeviceRevoked());
            // Incoming shares ride the same refresh; their failure must not
            // wipe the device list, so it is separate and best-effort — and
            // NOT awaited before the list is handed back: a Control click
            // waits on this function for the row to open, and a second round
            // trip for data that click does not use is latency for nothing.
            void listIncomingShares()
                .then(inc => { if (seq === refreshSeq.current) setIncoming(inc); })
                .catch(() => { /* keep whatever incoming list is already shown */ });
            return list;
        } catch (e) {
            if (seq !== refreshSeq.current) return null;
            // A failed poll keeps the list it already has: wiping known devices
            // over a blip turns transient network noise into "all my machines
            // vanished". That applies to the mutation-triggered refreshes too —
            // they are foreground only in that they report, not in that they
            // should destroy the grid. Only the very first load, which has
            // nothing to keep, empties it.
            setLoadError(e instanceof Error ? e.message : 'Could not load your devices.');
            if (!background && devicesRef.current === null) setDevices([]);
            return null;
        }
    }, []);

    useEffect(() => {
        devicesRef.current = devices;
    }, [devices]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    // Presence poll. Background flag keeps a blip from wiping the list.
    useEffect(() => {
        const timer = setInterval(() => void refresh(true), PRESENCE_REFRESH_MS);
        return () => clearInterval(timer);
    }, [refresh]);

    // THE MOMENTS THE LIST IS MOST LIKELY STALE, refreshed on the spot rather
    // than up to 15 s later. Every one of these is a time the user is about
    // to look at a card and press Control on it, and every one used to show
    // whatever the last poll saw — a sign-in row still "online" after the
    // console was unlocked, an app row not yet up after a boot:
    //  - the app coming back to the foreground (a phone that was in a session
    //    on this machine, then locked, then opened again);
    //  - our own socket reconnecting (`wsConnected` is a WINDOW event from
    //    websocket.ts, not a frame type — wsClient.on would never fire);
    //  - a device session of ours ENDING, however it ended: the natural next
    //    move is to reconnect, and the row that answers may have changed
    //    (that is exactly what the unlock handover does).
    useEffect(() => {
        const onVisible = () => { if (document.visibilityState === 'visible') void refresh(true); };
        const onFocus = () => void refresh(true);
        const onReconnect = () => void refresh(true);
        document.addEventListener('visibilitychange', onVisible);
        window.addEventListener('focus', onFocus);
        window.addEventListener('wsConnected', onReconnect);
        return () => {
            document.removeEventListener('visibilitychange', onVisible);
            window.removeEventListener('focus', onFocus);
            window.removeEventListener('wsConnected', onReconnect);
        };
    }, [refresh]);

    useEffect(() => {
        // Ids of OUR controller sessions that were live at the last emit; a
        // session leaving that set has ended (deliberately, by failure, or by
        // handover) and the list may have moved under it.
        let live = new Set<string>();
        return subscribeSessions(next => {
            const now = new Set(
                next.filter(s => s.role === 'controller' && s.phase !== 'ended').map(s => s.id),
            );
            let ended = false;
            for (const id of live) if (!now.has(id)) ended = true;
            live = now;
            if (ended) void refresh(true);
        });
    }, [refresh]);

    // The server says one of this account's devices attested or dropped off.
    // Cheap to act on — one refresh — and it is what makes the card flip
    // within a second of the machine coming up, instead of on the next poll.
    // Harmless against a server that does not send it yet: nothing arrives,
    // the poll still runs.
    //
    // COALESCED. A device on a flapping link re-attests repeatedly, one
    // DevicePresence per attempt, and one list refresh per frame would turn
    // that into a refresh storm on every other device of the account. A short
    // trailing debounce collapses a burst into a single reload — the list
    // only needs the final state, and a second's delay on a machine that is
    // busy reconnecting is invisible.
    useEffect(() => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const onPresence = () => {
            if (timer) return;
            timer = setTimeout(() => { timer = null; void refresh(true); }, 800);
        };
        wsClient.on('DevicePresence', onPresence);
        return () => {
            if (timer) clearTimeout(timer);
            wsClient.off('DevicePresence', onPresence);
        };
    }, [refresh]);

    /** A refresh the user asked for by hand (the button, or a pull on a
     *  touch screen). Foreground: it reports, and its failure is shown. The
     *  flag drives the spinner on the button. */
    const [refreshing, setRefreshing] = useState(false);
    const manualRefresh = useCallback(async () => {
        setRefreshing(true);
        try {
            await refresh();
        } finally {
            setRefreshing(false);
        }
    }, [refresh]);
    const pull = usePullToRefresh({ onRefresh: manualRefresh });

    // Wake progress. Only SUBSCRIBES — the waits themselves live in
    // wakeSession, so unmounting this view (or navigating away on mobile
    // during a three-minute boot) does not abandon them.
    useEffect(() => subscribeWakes(setWakes), []);

    // Live share updates: an invite arriving, being answered, becoming
    // connectable, or being revoked all repaint this view without waiting for
    // the 15s poll.
    useEffect(() => {
        const onShareEvent = () => void refresh(true);
        const types = [
            'DeviceShareInvited',
            'DeviceShareAnswered',
            'DeviceShareReady',
            'DeviceShareRevoked',
        ];
        for (const t of types) wsClient.on(t, onShareEvent);
        return () => { for (const t of types) wsClient.off(t, onShareEvent); };
    }, [refresh]);

    // Async, so this is not a synchronous setState in an effect — the rule that
    // caught a real React #310 crash in v0.7.7 stays satisfied.
    useEffect(() => {
        // Drop any cached host-backend choice first. getHostBackend() caches for
        // the whole page load and never re-probed, so ONE failed probe — an
        // agent still starting, a pipe briefly held by the previous build —
        // pinned this machine to the browser's screen picker until the app was
        // restarted. This screen is where someone lands after seeing a picker
        // they did not expect, so it is the right place to let them retry.
        forgetHostBackendChoice();
        void agentDiagnosis().then(setCaptureInfo).catch(() => setCaptureInfo(null));
        // CONNECT-TIME: warm the ICE config (STUN/TURN credentials) while the
        // user is still reading the list. It is a 2-hour cache behind a fetch
        // with a 6s timeout, and connectToDevice awaits it on the critical
        // path — so paying for it here is a round trip the click does not.
        // Failure is deliberately ignored: this is a prefetch, and the real
        // call re-fetches and reports properly.
        void fetchIceConfig().catch(() => {});
    }, []);

    useEffect(() => {
        if (autostartSupported()) void isAutostartEnabled().then(setAutostartState);
        if (lockScreenSupported()) {
            void lockScreenState().then(setLockScreen);
            void unattendedAccessState().then(setSignIn);
            // The "what this app ships" half of the service-update check; the
            // "what is installed" half arrives inside unattendedAccessState.
            void bundledServiceFingerprint().then(f => {
                setBundledHash(f.hash);
                setBundledError(f.error);
            });
        }
    }, []);

    const toggleAutostart = async (next: boolean) => {
        const err = await setAutostart(next);
        if (err) {
            setError(err);
            return;
        }
        // Read BACK rather than trusting the write: this touches the registry,
        // where a write can be reverted by security software after it returns.
        setAutostartState(await isAutostartEnabled());
    };

    useEffect(() => {
        if (tunnelSupported()) void getTunnelPolicy().then(p => setForwardingState(p.enabled));
    }, []);

    useEffect(() => {
        if (unattendedSupported()) void unattendedState().then(u => setUnattendedState(u.armed));
    }, []);

    const submitUnattended = async () => {
        const err = await armUnattended(uaPass);
        if (err) {
            setError(err);
            return;
        }
        setUaPass('');
        setUaOpen(false);
        // Read back: the record is stored outside the webview on purpose, so a
        // successful-looking call is not proof it landed.
        setUnattendedState((await unattendedState()).armed);
    };

    const removeUnattended = async () => {
        const err = await disarmUnattended();
        if (err) {
            setError(err);
            return;
        }
        setUnattendedState((await unattendedState()).armed);
    };

    const toggleForwarding = async (next: boolean) => {
        const err = await setTunnelForwarding(next);
        if (err) {
            setError(err);
            return;
        }
        // Read BACK, same discipline as autostart: this decision is stored on
        // disk outside the webview precisely so JS is not the authority on it,
        // so JS must not assume its own write took either.
        setForwardingState((await getTunnelPolicy()).enabled);
    };

    const submitRename = async (id: string) => {
        const name = draftName.trim();
        // An empty name would be rejected by the server anyway; treat it as a
        // cancel so the user is not stuck in an edit box they cannot leave.
        if (!name) {
            setEditingId(null);
            return;
        }
        setBusyId(id);
        try {
            await renameDevice(id, name);
            // Only close the box if it is STILL this device's. The rename is a
            // real network PATCH, and blur-to-commit means the user can have
            // opened another card's box while it was in flight — clearing the
            // id unconditionally shut the new box and discarded what they had
            // typed into it.
            setEditingId(cur => (cur === id ? null : cur));
            await refresh();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Rename failed.');
        } finally {
            setBusyId(null);
        }
    };

    /** Re-read both switches from the machine after anything changes them. */
    const refreshSignIn = async () => setSignIn(await unattendedAccessState());

    const toggleEnrolled = async (on: boolean) => {
        setBusyId('sign-in-enrol');
        setSignInError(null);
        const err = on ? await enrolLockScreenAccess() : await unenrolLockScreenAccess();
        if (err) setSignInError(err);
        await refreshSignIn();
        // The device LIST changed too — enrolling adds this machine's sign-in
        // row (and retires its predecessor), unenrolling removes one. Without
        // this the change only appears on the next 15s poll, which reads as
        // the toggle having done nothing.
        await refresh();
        setBusyId(null);
    };

    const setSignInPass = async () => {
        setBusyId('sign-in-arm');
        setSignInError(null);
        const err = await armLockScreenAccess(signInPassphrase);
        if (err) setSignInError(err);
        // Cleared whatever happened: it is the one secret with no recovery, and
        // leaving it sitting in an input is how it ends up in a screenshot.
        setSignInPassphrase('');
        await refreshSignIn();
        setBusyId(null);
    };

    const clearSignInPass = async () => {
        setBusyId('sign-in-arm');
        setSignInError(null);
        const err = await disarmLockScreenAccess();
        if (err) setSignInError(err);
        await refreshSignIn();
        setBusyId(null);
    };

    /**
     * Replace the installed service binaries with this build's.
     *
     * The app auto-updates; the service does not — nothing but enrolment day
     * ever touched it. The skew is invisible (the pipe still answers, minus
     * whatever fields the newer app relies on), which is exactly how 0.8.82's
     * one-card-per-PC merge silently never engaged. One elevation prompt;
     * registration, enrolment and the passphrase all survive.
     */
    const doServiceUpdate = async () => {
        setBusyId('service-update');
        setSignInError(null);
        const err = await updateLockScreenService();
        if (err) setSignInError(err);
        // Re-read from the machine: the restarted service reports its NEW
        // fingerprint, which is what clears the prompt — not our return value.
        await refreshSignIn();
        setLockScreen(await lockScreenState());
        const f = await bundledServiceFingerprint();
        setBundledHash(f.hash);
        setBundledError(f.error);
        setBusyId(null);
    };

    const toggleLockScreen = async (on: boolean) => {
        setBusyId('lock-screen');
        setError(null);
        const err = on ? await enableLockScreenAccess() : await disableLockScreenAccess();
        if (err) setError(err);
        // Re-read REGARDLESS of what the call reported. If the user declined the
        // elevation prompt the switch must go back on its own, and if the helper
        // half-succeeded the truth is on the machine, not in our return value.
        setLockScreen(await lockScreenState());
        setBusyId(null);
    };

    const doPairWaker = async () => {
        const userId = currentUserId();
        if (userId == null) return;
        const keys = parseWakerKeys(wakerPaste);
        if (!keys) {
            setError(
                'That does not look like the output of `puca-waker init`. Copy all three lines ' +
                '(device_id, device_pub, sign_pub) exactly as they were printed.',
            );
            return;
        }
        setBusyId('pair-waker');
        setError(null);
        try {
            const out = await pairWaker(userId, keys, {});
            setWakerOut(out);
            setWakerPaste('');
            await refresh();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not pair that waker.');
        } finally {
            setBusyId(null);
        }
    };

    const doResetIdentity = async () => {
        const userId = currentUserId();
        if (userId == null) return;
        setBusyId('reset-identity');
        try {
            await resetThisDeviceIdentity(userId);
            setSignedOut(false);
            await refresh();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not re-add this device.');
        } finally {
            setBusyId(null);
        }
    };

    /**
     * Revoke a machine — meaning EVERY row it enrolled, not just the one named
     * on the card.
     *
     * A PC with sign-in-screen access has two device rows behind one card.
     * Revoking only the named one would leave the other still enrolled and
     * still reachable — and, because the card it was hiding behind is gone, it
     * would reappear in the list as a computer of its own. Someone revoking a
     * machine means "this can no longer reach my account", and leaving the
     * half that answers at the LOGIN SCREEN is the worst half to leave.
     */
    const doRevoke = async (id: string) => {
        setBusyId(id);
        try {
            const machine = machines.find(m => m.rows.some(r => r.id === id));
            // THIS DEVICE LAST. Revoking the row you are signed in on ends the
            // session, so doing it first would abandon the other half of the
            // machine still enrolled — the sign-in-screen half, which is the
            // one it matters most not to leave behind.
            const rows = machine?.rows ?? [{ id } as { id: string }];
            const ordered = [
                ...rows.filter(r => r.id !== thisDeviceId()),
                ...rows.filter(r => r.id === thisDeviceId()),
            ];
            for (const row of ordered) {
                await revokeDevice(row.id);
            }
            setConfirmId(null);
            await refresh();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Revoke failed.');
        } finally {
            setBusyId(null);
        }
    };

    /**
     * Wake a powered-off machine, then open the session when it comes back.
     *
     * Everything interesting happens AFTER this resolves — the packet is
     * unacknowledged, so the only proof it worked is the target reconnecting.
     * Progress and every failure branch are reported through `wakes`.
     */
    const startWake = async (device: VerifiedDevice) => {
        const userId = currentUserId();
        if (userId == null || !devices) return;
        await wakeAndConnect(device, devices, thisDeviceId(), userId);
    };

    /**
     * WHICH ROW TO OPEN, decided from a list fetched NOW — not from the one
     * the card was painted from, which can be 15 s old.
     *
     * A machine with sign-in-screen access is two rows and only one is the
     * right one at any moment: the sign-in row while the console is locked,
     * the app row once somebody signs in (`machines.ts`). Both flip at exactly
     * the times a user reaches for Control — right after they typed their
     * PIN, right after a boot — and the stale card sent the connect to the row
     * that had just gone away. The server refused it in a second ("that
     * device isn't online"), and the user was left to wait for the next poll
     * before the button did what it said. So: re-read, re-fold, then choose.
     *
     * FETCHES ITS OWN LIST rather than piggy-backing on refresh(). refresh()
     * carries a newest-wins seq guard and returns null when a CONCURRENT
     * refresh supersedes it — and this view now fires refreshes from five
     * places (the 15 s poll, focus, visibility, a DevicePresence frame, a
     * session ending), so a background one landing during the click would rob
     * the click of its answer and drop it back onto the stale card row, which
     * is the exact race this exists to close. A dedicated listDevices cannot
     * be superseded. A background refresh(true) still runs so the grid
     * repaints; the click does not wait on it. Only a genuine fetch failure
     * falls back to the painted row — better than nothing, as before.
     */
    const freshOnlineRow = async (machine: Machine): Promise<VerifiedDevice | null> => {
        const userId = currentUserId();
        if (userId == null) return machine.onlineRow;
        void refresh(true); // repaint the grid; not on the critical path
        try {
            const list = await listDevices(userId);
            const fresh = machineOf(await groupIntoMachines(list), machine.primary.id);
            return fresh ? fresh.onlineRow : machine.onlineRow;
        } catch {
            return machine.onlineRow;
        }
    };

    const startControl = async (machine: Machine, filesOnly = false) => {
        const key = machine.primary.id;
        setBusyId(key);
        try {
            const row = await freshOnlineRow(machine);
            if (!row) {
                // Honest, and immediate: the list just repainted, so the card
                // now shows the machine offline too, with Wake where it applies.
                setError(`${machine.primary.name} is not reachable right now.`);
                return;
            }
            await connectToDevice(row.id, filesOnly ? { filesOnly: true } : undefined);
            // The stage takes over the screen from here (it mounts at the app
            // root, above this view); nothing to close.
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not connect to that device.');
        } finally {
            setBusyId(null);
        }
    };

    /**
     * Browse that machine's files without opening its screen.
     *
     * The same session as Control, negotiated identically, except the host never
     * captures and this side mounts the file browser instead of the stage. On a
     * device ARMED for unattended access the grant needs no prompt over there —
     * the passphrase is the gate — which is the case this exists for: reaching
     * your own machine when nobody is sitting at it.
     *
     * Whether the target is armed and has the agent cannot be known from here:
     * both are deliberately device-local facts, and publishing armedness through
     * presence to light this button up would leak to the server the one thing
     * the arming record is kept off the server to protect. So the button is
     * offered on the same terms as Control and the host's own reply decides —
     * the file browser then says specifically why, rather than failing vaguely.
     */
    const startFileBrowse = (machine: Machine) => startControl(machine, true);

    /** Answer an incoming invite, or walk away from an accepted one. */
    const answerShare = async (id: number, accept: boolean) => {
        setBusyId(`share-${id}`);
        try {
            await respondShare(id, accept);
            await refresh();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not answer the invite.');
        } finally {
            setBusyId(null);
        }
    };

    const removeShare = async (id: number) => {
        setBusyId(`share-${id}`);
        try {
            await deleteShare(id);
            setRemoveShareId(null);
            await refresh();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not remove your access.');
        } finally {
            setBusyId(null);
        }
    };

    /** Connect to a FRIEND's shared device. The share context is what lets the
     *  session layer resolve and verify a foreign device's key. */
    const startShared = async (sh: IncomingShare, filesOnly: boolean) => {
        setBusyId(`share-${sh.id}`);
        try {
            await connectToDevice(sh.host_device, {
                filesOnly,
                share: {
                    inviteId: sh.id,
                    ownerUser: sh.owner_user,
                    ownerUsername: sh.owner_username,
                    capabilities: sh.capabilities,
                },
            });
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not connect to that device.');
        } finally {
            setBusyId(null);
        }
    };

    const custody = deviceKeyCustody();
    // COUNTS MACHINES, not rows: a PC with sign-in-screen access enrolled is
    // two rows, and reporting "3 devices" for two computers and a phone was the
    // same double-count the list itself used to show.
    const deviceCount = machines.length;
    const pendingInvites = incoming?.filter(s => s.status === 'pending') ?? [];
    const acceptedShares = incoming?.filter(s => s.status === 'accepted') ?? [];

    return (
        <div className="devices-dashboard">
            {/* Title, tabs and close are SIBLINGS on purpose: at 390px the
                three do not fit on one line, and the flex `order` that moves
                the tabs to their own row only works between siblings. Nesting
                the tabs under a wrapper left the second tab half-hidden behind
                the close button — a control that reads as broken rather than
                scrollable. */}
            <header className="devices-header-bar">
                <span className="devices-title">
                    <span aria-hidden="true"><MonitorIcon /></span> Devices
                </span>
                <nav className="devices-tabs" role="tablist" aria-label="Devices sections">
                    <button
                        role="tab"
                        aria-selected={tab === 'devices'}
                        className={`devices-tab ${tab === 'devices' ? 'active' : ''}`}
                        onClick={() => setTab('devices')}
                    >
                        My devices{deviceCount > 0 ? ` — ${deviceCount}` : ''}
                    </button>
                    <button
                        role="tab"
                        aria-selected={tab === 'this'}
                        className={`devices-tab ${tab === 'this' ? 'active' : ''}`}
                        onClick={() => setTab('this')}
                    >
                        This device
                    </button>
                </nav>
                {/* By hand, now — the presence poll is 15 s and the moment
                    somebody wants a fresh list is usually the moment a machine
                    just came up. On a touch screen a pull on the list does the
                    same thing; this is the fine-pointer way in, and the
                    spinner is shared. */}
                <button
                    type="button"
                    className={`devices-refresh${refreshing ? ' devices-refresh-busy' : ''}`}
                    onClick={() => void manualRefresh()}
                    disabled={refreshing}
                    aria-label="Refresh the device list"
                    title="Refresh"
                >
                    <span className="devices-refresh-glyph" aria-hidden="true"><Icon name="refresh" size={18} /></span>
                </button>
                {onOpenSettings && (
                    <button
                        type="button"
                        className="devices-refresh"
                        onClick={onOpenSettings}
                        aria-label="Open settings"
                        title="Settings"
                    >
                        <span className="devices-refresh-glyph" aria-hidden="true"><SettingsIcon size={18} /></span>
                    </button>
                )}
                <button className="devices-close" onClick={onClose} aria-label="Close devices">
                    <CloseIcon size={18} />
                </button>
            </header>

            <div className="devices-main" {...pull.handlers}>
                {/* PULL TO REFRESH (touch). A spacer, not a transform: its
                    height is the pull, so the content moves down with the
                    finger and snaps back on release, and nothing here fights
                    the browser's own scroll (see usePullToRefresh). Present at
                    zero height when idle so the layout does not jump. */}
                <div
                    className={
                        `devices-pull${pull.state.armed ? ' devices-pull-armed' : ''}`
                        + `${pull.state.refreshing ? ' devices-pull-refreshing' : ''}`
                        + `${pull.state.distance > 0 && !pull.state.refreshing ? ' devices-pull-live' : ''}`
                    }
                    style={{ height: pull.state.distance }}
                    role={pull.state.refreshing ? 'status' : undefined}
                    aria-hidden={pull.state.distance === 0}
                >
                    <span className="devices-pull-glyph" aria-hidden="true">
                        <Icon name="refresh" size={18} />
                    </span>
                    <span className="devices-pull-text">
                        {pull.state.refreshing
                            ? 'Refreshing…'
                            : pull.state.armed ? 'Release to refresh' : 'Pull to refresh'}
                    </span>
                </div>
                {error && <div className="device-error" role="alert">{error}</div>}
                {loadError && <div className="device-error" role="alert">{loadError}</div>}

                {/* Shown on BOTH tabs: it is about this machine, but it is the
                    one state in this view the user must act on deliberately. */}
                {signedOut && (
                    <div className="dv-card device-signed-out">
                        <span className="device-custody-icon" aria-hidden="true"><BanIcon /></span>
                        <div>
                            <strong>This device was signed out.</strong>
                            <p className="option-hint">
                                It stays signed out — that is what makes revoking a lost machine
                                worth doing. Nothing here will bring it back on its own.
                            </p>
                            <p className="option-hint">
                                If you signed it out by mistake, adding it again gives this
                                computer a brand-new key and a new entry in the list below. The
                                old entry stays revoked, and anything that had this device's old
                                key cannot use it.
                            </p>
                            <button
                                type="button"
                                className="device-btn device-btn-danger"
                                disabled={busyId === 'reset-identity'}
                                onClick={() => void doResetIdentity()}
                            >
                                {busyId === 'reset-identity' ? 'Adding…' : 'Add this device again'}
                            </button>
                        </div>
                    </div>
                )}

                {tab === 'devices' ? (
                    <>
                        {devices === null && <div className="device-empty">Loading…</div>}
                        {devices?.length === 0 && !error && (
                            <div className="devices-empty-state">
                                <span className="devices-empty-icon" aria-hidden="true"><MonitorIcon size={40} /></span>
                                <strong>No devices enrolled yet.</strong>
                                <p>
                                    Sign in to Puca on another computer or phone and it will
                                    appear here — each device gets its own key, so you can revoke
                                    one without touching the others.
                                </p>
                            </div>
                        )}

                        <div className="devices-grid">
                            {machines.map(machine => {
                                // ONE CARD PER MACHINE. `device` is the row the
                                // card is named after and that rename/share/
                                // revoke act on; reachability and waking are
                                // decided for the MACHINE, which may be up on
                                // its other row.
                                const device = machine.primary;
                                const isThis = machine.rows.some(
                                    r => r.isThisDevice || r.id === thisDeviceId(),
                                );
                                const canReach = !isThis && device.verified && machine.online;
                                const wake = wakes.get(device.id);
                                // Any live wait on this card — a wake, or the
                                // follow after somebody signed in at its
                                // sign-in screen — gets the Stop button.
                                const waking = wakePhaseIsLive(wake?.phase);
                                // Offline is the ONLY state where waking means
                                // anything. An online machine is already
                                // reachable, and this device cannot wake itself.
                                //
                                // A MAC IS ALSO REQUIRED. Without one `planWake`
                                // can only dead-end on "Puca has not
                                // recorded its network details yet", so the
                                // button was offered on rows where it could
                                // never do anything — which is exactly what the
                                // sign-in-screen row used to be.
                                const canWake = !isThis
                                    && device.verified
                                    && !machine.online
                                    && machine.mac !== null;
                                return (
                                    <div
                                        key={device.id}
                                        className={`device-card device-row${device.verified ? '' : ' device-row-unverified'}`}
                                    >
                                        <div className="device-card-top">
                                            <span className="device-icon" aria-hidden="true">
                                                <Icon name={PLATFORM_ICON[device.platform] ?? 'help'} />
                                            </span>

                                            <div className="device-main">
                                                {editingId === device.id ? (
                                                    <input
                                                        className="device-name-input"
                                                        value={draftName}
                                                        autoFocus
                                                        maxLength={64}
                                                        aria-label="Device name"
                                                        onChange={e => setDraftName(e.target.value)}
                                                        onKeyDown={e => {
                                                            if (e.key === 'Enter') void submitRename(device.id);
                                                            if (e.key === 'Escape') setEditingId(null);
                                                        }}
                                                        onBlur={() => void submitRename(device.id)}
                                                    />
                                                ) : (
                                                    <div className="device-name">
                                                        {device.name}
                                                        {isThis && <span className="device-badge">This device</span>}
                                                        {/* Only THIS row can show it: armed state
                                                            lives on each machine's own disk and is
                                                            never reported to the server, so no
                                                            other row's state is knowable from
                                                            here. Saying nothing on the others is
                                                            honest; guessing would not be. */}
                                                        {isThis && unattended === true && (
                                                            <span className="device-badge">Armed</span>
                                                        )}
                                                        {/* WHICH WAY IN YOU HAVE RIGHT NOW. The
                                                            card is one machine but two transports,
                                                            and they are not equivalent: at the
                                                            sign-in screen nobody is logged in, so
                                                            you get the login screen and a keyboard,
                                                            not somebody's desktop. Saying so beats
                                                            a card that silently means something
                                                            different depending on the hour. */}
                                                        {machine.atSignInScreen && (
                                                            <span className="device-badge">Sign-in screen</span>
                                                        )}
                                                    </div>
                                                )}
                                                <div className="device-meta">
                                                    <span
                                                        className={`device-dot ${machine.online ? 'device-dot-on' : ''}`}
                                                        aria-hidden="true"
                                                    />
                                                    {formatSeen(machine.onlineRow ?? device)}
                                                </div>
                                            </div>
                                        </div>

                                        {!device.verified && (
                                            <div className="device-warning">
                                                Could not verify this device was enrolled by you. Revoke it
                                                unless you recognise it.
                                            </div>
                                        )}

                                        <div className="device-actions">
                                            {/* Only an ONLINE, VERIFIED device that is not
                                                this one can be controlled. Offering the
                                                button otherwise produces a connection that
                                                fails after the user has committed to it. */}
                                            {canReach && editingId !== device.id && (
                                                <button
                                                    className="device-btn device-btn-primary"
                                                    disabled={busyId === device.id}
                                                    onClick={() => void startControl(machine)}
                                                >
                                                    Control
                                                </button>
                                            )}
                                            {/* Wake, then connect. Only for an OFFLINE
                                                device: a magic packet is a LAN broadcast
                                                sent by ANOTHER of your machines, so this
                                                can fail for reasons that are worth stating
                                                rather than hiding — the status line below
                                                carries them. */}
                                            {canWake && editingId !== device.id && !waking && (
                                                <button
                                                    className="device-btn device-btn-primary"
                                                    disabled={busyId === device.id}
                                                    onClick={() => void startWake(device)}
                                                    title={`Send a wake signal to ${device.name}, then open a session when it starts up`}
                                                >
                                                    <Icon name="power" />
                                                    Wake &amp; connect
                                                </button>
                                            )}
                                            {waking && (
                                                <button
                                                    className="device-btn"
                                                    onClick={() => cancelWake(device.id)}
                                                >
                                                    Stop waiting
                                                </button>
                                            )}
                                            {/* A failure explanation is long and
                                                permanent-looking; without this it sits on
                                                the card for the rest of the session with
                                                no way to clear it. */}
                                            {wake?.phase === 'failed' && (
                                                <button
                                                    className="device-btn"
                                                    onClick={() => cancelWake(device.id)}
                                                >
                                                    Dismiss
                                                </button>
                                            )}
                                            {/* Same conditions as Control: this opens the
                                                same session, just without the picture. */}
                                            {canReach && editingId !== device.id && (
                                                <button
                                                    className="device-btn"
                                                    disabled={busyId === device.id}
                                                    onClick={() => void startFileBrowse(machine)}
                                                    title="Browse this device's files without opening its screen"
                                                >
                                                    Files
                                                </button>
                                            )}
                                            {editingId !== device.id && (
                                                <button
                                                    className="device-btn"
                                                    disabled={busyId === device.id}
                                                    onClick={() => {
                                                        setDraftName(device.name);
                                                        setEditingId(device.id);
                                                    }}
                                                >
                                                    Rename
                                                </button>
                                            )}
                                            {/* Sharing needs a VERIFIED device — a grant
                                                over a row this client cannot verify would
                                                certify something it never checked. */}
                                            {device.verified && editingId !== device.id && (
                                                <button
                                                    className="device-btn"
                                                    disabled={busyId === device.id}
                                                    onClick={() => setShareDeviceId(device.id)}
                                                    title="Give a friend standing access to this device"
                                                >
                                                    Share
                                                </button>
                                            )}
                                            {confirmId === device.id ? (
                                                <>
                                                    <button
                                                        className="device-btn device-btn-danger"
                                                        disabled={busyId === device.id}
                                                        onClick={() => void doRevoke(device.id)}
                                                    >
                                                        {isThis ? 'Sign this device out' : 'Confirm revoke'}
                                                    </button>
                                                    <button className="device-btn" onClick={() => setConfirmId(null)}>
                                                        Cancel
                                                    </button>
                                                </>
                                            ) : (
                                                // A small trash can, not a red slab — the
                                                // words live in the confirm step above. The
                                                // sr-only text keeps the accessible name
                                                // AND the tests' exact textContent match.
                                                <button
                                                    className="device-btn device-btn-danger device-btn-icon"
                                                    disabled={busyId === device.id}
                                                    onClick={() => setConfirmId(device.id)}
                                                    title="Revoke this device"
                                                >
                                                    <span className="device-btn-icon-glyph" aria-hidden="true"><TrashIcon size={16} /></span>
                                                    <span className="sr-only">Revoke</span>
                                                </button>
                                            )}
                                        </div>

                                        {/* Wake progress and, more importantly, wake
                                            FAILURE. A magic packet is unacknowledged, so
                                            every one of these outcomes is a thing the user
                                            can only learn by being told. */}
                                        {wake && (
                                            <div
                                                className={`device-wake-status${wake.phase === 'failed' ? ' device-wake-status-failed' : ''}`}
                                                role="status"
                                            >
                                                {wake.message}
                                                {(wake.phase === 'waiting' || wake.phase === 'following') && wake.secondsLeft !== undefined && (
                                                    <span className="device-wake-countdown">
                                                        {' '}Still waiting — {wake.secondsLeft}s left.
                                                    </span>
                                                )}
                                            </div>
                                        )}

                                        {confirmId === device.id && isThis && (
                                            <div className="device-warning device-warning-standalone">
                                                This is the device you are using. Revoking it will disconnect you here.
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>

                        {/* Shared with me — friends' devices this account may
                            reach. Pending invites first (they need an answer),
                            then live access. Hidden entirely when there is
                            nothing, so the common no-shares case pays no UI. */}
                        {(pendingInvites.length > 0 || acceptedShares.length > 0) && (
                            <>
                                <h3 className="devices-shared-heading">Shared with me</h3>
                                <div className="devices-grid">
                                    {pendingInvites.map(sh => (
                                        <div key={sh.id} className="device-card device-row">
                                            <div className="device-card-top">
                                                <span className="device-icon" aria-hidden="true">
                                                    <Icon name={PLATFORM_ICON[sh.host_platform] ?? 'help'} />
                                                </span>
                                                <div className="device-main">
                                                    <div className="device-name">{sh.host_device_name}</div>
                                                    <div className="device-meta">
                                                        <strong>{sh.owner_username}</strong> is offering you{' '}
                                                        {sh.capabilities.includes('control')
                                                            ? 'full control'
                                                            : sh.capabilities.includes('view_only')
                                                                ? 'view-only screen access'
                                                                : 'file browsing'}
                                                        {sh.capabilities.includes('files')
                                                            && (sh.capabilities.includes('control') || sh.capabilities.includes('view_only'))
                                                            ? ' and file browsing' : ''}
                                                    </div>
                                                </div>
                                            </div>
                                            <div className="device-actions">
                                                <button
                                                    className="device-btn device-btn-primary"
                                                    disabled={busyId === `share-${sh.id}`}
                                                    onClick={() => void answerShare(sh.id, true)}
                                                >
                                                    Accept
                                                </button>
                                                <button
                                                    className="device-btn"
                                                    disabled={busyId === `share-${sh.id}`}
                                                    onClick={() => void answerShare(sh.id, false)}
                                                >
                                                    Decline
                                                </button>
                                            </div>
                                        </div>
                                    ))}
                                    {acceptedShares.map(sh => {
                                        const canScreen = sh.capabilities.includes('control')
                                            || sh.capabilities.includes('view_only');
                                        const canFiles = sh.capabilities.includes('files');
                                        const reachable = sh.ready && sh.online;
                                        return (
                                            <div key={sh.id} className="device-card device-row">
                                                <div className="device-card-top">
                                                    <span className="device-icon" aria-hidden="true">
                                                        <Icon name={PLATFORM_ICON[sh.host_platform] ?? 'help'} />
                                                    </span>
                                                    <div className="device-main">
                                                        <div className="device-name">
                                                            {sh.host_device_name}
                                                            <span className="device-badge">{sh.owner_username}'s</span>
                                                        </div>
                                                        <div className="device-meta">
                                                            <span
                                                                className={`device-dot ${sh.online ? 'device-dot-on' : ''}`}
                                                                aria-hidden="true"
                                                            />
                                                            {!sh.ready
                                                                ? 'Waiting for that device to confirm the share'
                                                                : sh.online ? 'Online now' : 'Offline'}
                                                        </div>
                                                    </div>
                                                </div>
                                                <div className="device-actions">
                                                    {reachable && canScreen && (
                                                        <button
                                                            className="device-btn device-btn-primary"
                                                            disabled={busyId === `share-${sh.id}`}
                                                            onClick={() => void startShared(sh, false)}
                                                        >
                                                            {sh.capabilities.includes('control') ? 'Control' : 'View'}
                                                        </button>
                                                    )}
                                                    {reachable && canFiles && (
                                                        <button
                                                            className="device-btn"
                                                            disabled={busyId === `share-${sh.id}`}
                                                            onClick={() => void startShared(sh, true)}
                                                        >
                                                            Files
                                                        </button>
                                                    )}
                                                    {removeShareId === sh.id ? (
                                                        <>
                                                            <button
                                                                className="device-btn device-btn-danger"
                                                                disabled={busyId === `share-${sh.id}`}
                                                                onClick={() => void removeShare(sh.id)}
                                                            >
                                                                Confirm remove
                                                            </button>
                                                            <button
                                                                className="device-btn"
                                                                onClick={() => setRemoveShareId(null)}
                                                            >
                                                                Cancel
                                                            </button>
                                                        </>
                                                    ) : (
                                                        <button
                                                            className="device-btn device-btn-danger device-btn-icon"
                                                            disabled={busyId === `share-${sh.id}`}
                                                            onClick={() => setRemoveShareId(sh.id)}
                                                            title="Give up your access to this device"
                                                        >
                                                            <span className="device-btn-icon-glyph" aria-hidden="true"><TrashIcon size={16} /></span>
                                                            <span className="sr-only">Remove my access</span>
                                                        </button>
                                                    )}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </>
                        )}
                    </>
                ) : (
                    <div className="devices-setup">
                        {isMobile() && <PhoneFileSharingCard />}

                        <div className="dv-card device-custody">
                            <span className="device-custody-icon" aria-hidden="true">
                                {custody === 'os-protected' ? <ShieldCheckIcon /> : <WarningIcon />}
                            </span>
                            <span>
                                {custody === 'os-protected'
                                    ? "This device's key is held by the operating system's protected store."
                                    : "This device's key is held in browser storage, which is weaker than the desktop app's. Browser devices can control other machines, but cannot be controlled themselves."}
                            </span>
                        </div>

                        {/* Whether this machine can share its screen WITHOUT asking someone to
                            pick a window, and if not, why.
                            Worth its own line because the failure is otherwise invisible: the
                            only symptom is the browser's screen picker appearing, which looks
                            like a feature rather than a fault, and the process that knows the
                            reason used to discard it. */}
                        {captureInfo && (
                            <div className="dv-card device-custody">
                                <span className="device-custody-icon" aria-hidden="true">
                                    {captureInfo.startsWith('Direct capture ready') ? <MonitorIcon /> : <WarningIcon />}
                                </span>
                                <span>{captureInfo}</span>
                            </div>
                        )}

                        {autostartSupported() && (
                            <div className="dv-card device-option">
                                <div className="option-info">
                                    {/* SIGN IN, not "starts". The label used to promise boot
                                        while the note further down admitted it fires at sign-in —
                                        a contradiction on one screen, where the wrong half is the
                                        one in the larger type. What it actually writes is
                                        HKCU\...\Run, which by construction cannot run before
                                        somebody signs in to that account. */}
                                    <label htmlFor="device-autostart">Start Puca when you sign in to this computer</label>
                                    <span className="option-hint">
                                        Required for this device to be reachable without someone opening
                                        Puca first. It starts minimised to the tray, and the tray icon
                                        shows whenever a session is active. It does not run at boot &mdash;
                                        see &ldquo;to reach this computer after a restart&rdquo; below.
                                    </span>
                                </div>
                                <input
                                    id="device-autostart"
                                    type="checkbox"
                                    checked={autostart ?? false}
                                    disabled={autostart === null}
                                    onChange={e => void toggleAutostart(e.target.checked)}
                                />
                            </div>
                        )}

                        {/* What "Wake &amp; connect" needs on the TARGET machine.
                            Stated once, here, rather than repeated on every
                            failure: these are one-time settings on the machine
                            being woken, and none of them can be checked or
                            changed remotely — a wake that fails because of any
                            of them looks identical to one that was never sent. */}
                        {autostartSupported() && (
                            <div className="dv-card device-wake-note">
                                <strong>To wake this computer from another device</strong>
                                <br />
                                Turn on Wake-on-LAN in its BIOS/UEFI, and in Windows enable
                                &ldquo;Wake on Magic Packet&rdquo; and &ldquo;Allow this device to wake
                                the computer&rdquo; on the network adapter. Turn Windows Fast Startup
                                OFF &mdash; it makes &ldquo;Shut down&rdquo; a hybrid hibernate that
                                usually cannot be woken. Wired Ethernet only; Wi-Fi almost never
                                works.
                                <br /><br />
                                Waking needs another of your computers switched on and on the same
                                network &mdash; a magic packet is a local broadcast, and a machine
                                that is off has no internet connection to receive anything. A phone
                                can press the button but cannot send the signal.
                                <br /><br />
                                Waking from sleep is the case that works unattended &mdash; and with
                                nobody at the keyboard, unattended access below must already be
                                armed on this machine.
                            </div>
                        )}

                        {/* THE COLD-BOOT GAP, stated where someone can act on it.
                            Autostart writes HKCU\...\Run, so it cannot fire before a
                            sign-in; a fully shut-down machine therefore sits at the
                            sign-in screen with Puca not running, and no amount of
                            waking changes that. The two settings below close it by
                            leaving the machine SIGNED IN; the lock-screen option further
                            down closes it while the machine stays LOCKED, which is why
                            this card now points at it rather than claiming no such
                            feature exists. Both settings here are Windows settings rather
                            than anything this app can set, and both have the same real cost.
                            Naming that cost here is the point: an instruction that
                            hides its tradeoff gets followed by people who would have
                            declined it. */}
                        {autostartSupported() && (
                            <div className="dv-card device-wake-note">
                                <strong>To reach this computer after a restart</strong>
                                <br />
                                Puca starts when you sign in, so a computer that was fully shut
                                down waits at the Windows sign-in screen with nothing running. Two
                                Windows settings close that gap, and neither can be changed from
                                here:
                                <br /><br />
                                <strong>Waking from sleep.</strong> In Settings &rsaquo; Accounts
                                &rsaquo; Sign-in options, set &ldquo;If you&rsquo;ve been away, when
                                should Windows require you to sign in again?&rdquo; to
                                <em> Never</em>. The machine then resumes straight into your
                                already-running session, which together with Wake-on-LAN above covers
                                everything except a full shutdown or a power cut.
                                <br /><br />
                                <strong>After a full shutdown.</strong> Turn on Windows automatic
                                sign-in (run <code>netplwiz</code> and untick &ldquo;Users must enter
                                a user name and password&rdquo;). Windows then signs in by itself at
                                boot and Puca starts with it.
                                <br /><br />
                                <strong>What both of these cost.</strong> The computer ends up sitting
                                at an unlocked desktop, so anyone who can physically reach it has your
                                account without needing the password &mdash; and automatic sign-in
                                additionally stores that password on the machine, where an
                                administrator can recover it. Reasonable for a computer somewhere only
                                you go; not for one strangers can walk up to. If you would rather the
                                computer stayed LOCKED, that is what the lock-screen option below
                                does &mdash; you reach the lock or sign-in screen and type your PIN
                                remotely, and then you need neither of these two settings.
                            </div>
                        )}

                        {/* LOCK-SCREEN ACCESS — the opt-in.
                            Nothing about this feature exists on a machine until
                            this switch is turned on. Installing Puca
                            registers no service, writes nothing to Program
                            Files, and raises no elevation prompt.

                            The card states what it installs BEFORE it is turned
                            on, not after, because a LocalSystem service is the
                            most privileged thing on Windows and consent given
                            without knowing that is not consent. */}
                        {lockScreenSupported() && (
                            <div className="dv-card device-option">
                                <div className="option-info">
                                    <label htmlFor="device-lockscreen">
                                        Let me reach this computer&rsquo;s lock screen
                                    </label>
                                    <span className="option-hint">
                                        Normally Puca cannot see the Windows lock screen,
                                        the sign-in screen, or administrator prompts &mdash; Windows
                                        puts those out of reach of ordinary programs, deliberately.
                                        Turning this on installs a small Windows service that can,
                                        so you can unlock this computer remotely by typing your PIN
                                        or password.
                                        <br /><br />
                                        <strong>What it installs:</strong> two files in
                                        {' '}<code>C:\Program Files\Sovereign\service</code>, and a
                                        Windows service called <code>SovereignRemote</code> that runs
                                        as the system account and starts with Windows. It runs a
                                        capture agent ONLY while this computer is locked or nobody is
                                        signed in, and stops it again the moment you unlock. Windows
                                        will ask your permission once.
                                        <br /><br />
                                        Turning it off removes the service and those files. You can
                                        also check or remove it yourself in Services
                                        (<code>services.msc</code>), without this app.
                                        {lockScreen?.problem && (
                                            <>
                                                <br /><br />
                                                <strong>{lockScreen.problem}</strong>
                                            </>
                                        )}
                                        {lockScreen?.installed && !lockScreen.running && (
                                            <>
                                                <br /><br />
                                                <strong>
                                                    Installed, but not running. Check
                                                    {' '}<code>services.msc</code> for
                                                    {' '}<code>SovereignRemote</code>.
                                                </strong>
                                            </>
                                        )}
                                    </span>
                                </div>
                                <input
                                    id="device-lockscreen"
                                    type="checkbox"
                                    checked={lockScreen?.installed ?? false}
                                    disabled={
                                        lockScreen === null
                                        || !lockScreen.available
                                        || busyId === 'lock-screen'
                                    }
                                    onChange={e => void toggleLockScreen(e.target.checked)}
                                />
                            </div>
                        )}

                        {/* THE TWO SWITCHES BEHIND THE SERVICE.
                            Installing the service gives this computer the
                            ability. These decide whether it is used, and they
                            are separate on purpose: turning the passphrase off
                            has to be possible without also removing the
                            connection you would need in order to set a new one.

                            Shown only once the service exists, because until
                            then neither can do anything and a dead control is
                            worse than an absent one. */}
                        {lockScreenSupported() && lockScreen?.installed && (
                            <div className="dv-card device-option">
                                <div className="option-info">
                                    <label htmlFor="device-signin-enrol">
                                        Reach this computer after it restarts
                                    </label>
                                    <span className="option-hint">
                                        Lets this computer be reached at its Windows sign-in
                                        screen even when nobody is signed in &mdash; after a
                                        restart, or after you wake it from being switched off.
                                        It connects on its own, using its own key, and only
                                        while the screen is locked or signed out. The moment
                                        somebody signs in, it disconnects and the app takes
                                        over.
                                        <br /><br />
                                        Turning this off removes its key, its connection
                                        details and the passphrase below.
                                        {signIn?.error && (
                                            <>
                                                <br /><br />
                                                <strong>{signIn.error}</strong>
                                            </>
                                        )}
                                    </span>
                                </div>
                                <input
                                    id="device-signin-enrol"
                                    type="checkbox"
                                    checked={signIn?.enrolled ?? false}
                                    disabled={signIn === null || busyId === 'sign-in-enrol'}
                                    onChange={e => void toggleEnrolled(e.target.checked)}
                                />
                            </div>
                        )}

                        {/* THE SERVICE DOES NOT AUTO-UPDATE — only the app does.
                            When the running service's fingerprint differs from
                            the pair this build ships, everything still LOOKS
                            fine while newer features quietly cannot work (the
                            0.8.82 one-card merge never engaged this way). So
                            the mismatch gets a loud card, not a hint.

                            GATED ON `lockScreen?.installed`, NOT
                            `signIn?.serviceInstalled` — the latter comes from a
                            control-pipe round trip fetched ONCE on mount with no
                            retry (`unattendedAccessState()`, line ~438), so a
                            single transient pipe hiccup at startup leaves it
                            stuck false for the rest of the session with nothing
                            to correct it. `lockScreen.installed` is a direct SCM
                            query (`service_state`) and is what every sibling
                            card in this file already keys "is the service here
                            at all" on — this card was the one place that used
                            the weaker signal instead, and it was the reported
                            cause of the card never appearing on a real machine
                            where the service was demonstrably running. */}
                        {/* THE FAILURE MODE THIS WAS ADDED TO CLOSE: reading the
                            bundled pair can fail on a real install (permissions,
                            an update caught mid-write, a layout this build's
                            service_path()/agent_path() do not expect), and that
                            used to be indistinguishable from "no update needed"
                            — `serviceNeedsUpdate` treats a null bundled hash as
                            nothing to compare against. Shown whenever there is
                            something to report, independent of whether the
                            update card itself can render. */}
                        {lockScreenSupported() && lockScreen?.installed && bundledError && (
                            <div className="dv-card device-option">
                                <div className="option-info">
                                    <label>Could not check for a service update</label>
                                    <span className="option-hint">
                                        <strong>{bundledError}</strong>
                                    </span>
                                </div>
                            </div>
                        )}

                        {lockScreenSupported() && lockScreen?.installed
                            && serviceNeedsUpdate(signIn?.binsHash ?? null, bundledHash) && (
                            <div className="dv-card device-option">
                                <div className="option-info">
                                    <label>Sign-in-screen service update</label>
                                    <span className="option-hint">
                                        This computer&rsquo;s sign-in-screen service is from an
                                        older version of Puca than the app. Some newer
                                        features &mdash; like showing this PC as one device
                                        instead of two, and waking it from fully off &mdash;
                                        need them to match. Updating keeps the connection,
                                        the enrolment and the passphrase; Windows will ask
                                        for permission once.
                                    </span>
                                </div>
                                <button
                                    type="button"
                                    className="device-btn device-btn-primary"
                                    disabled={busyId === 'service-update'}
                                    onClick={() => void doServiceUpdate()}
                                >
                                    {busyId === 'service-update' ? 'Updating…' : 'Update the service'}
                                </button>
                            </div>
                        )}

                        {lockScreenSupported() && lockScreen?.installed && signIn?.enrolled && (
                            <div className="dv-card device-option device-option-stacked">
                                <div className="option-info">
                                    <label htmlFor="device-signin-pass">
                                        Passphrase for the sign-in screen
                                    </label>
                                    <span className="option-hint">
                                        Nobody is at the computer to approve a connection to
                                        its sign-in screen, so this passphrase takes that
                                        place. You will be asked for it on the device you
                                        connect FROM, every time.
                                        <br /><br />
                                        It is not your Windows password and not your Puca
                                        password. It never leaves the device you type it on
                                        &mdash; this computer only stores enough to check it.
                                        There is no way to recover it: if you forget it, set a
                                        new one from here.
                                        <br /><br />
                                        <strong>
                                            Until this is set, this computer refuses every
                                            connection to its sign-in screen.
                                        </strong>
                                        {signInError && (
                                            <>
                                                <br /><br />
                                                <strong>{signInError}</strong>
                                            </>
                                        )}
                                    </span>
                                </div>
                                <div className="device-unattended-form">
                                    <input
                                        id="device-signin-pass"
                                        type="password"
                                        autoComplete="new-password"
                                        placeholder={
                                            signIn?.armed
                                                ? 'Set a new passphrase'
                                                : 'At least 8 characters'
                                        }
                                        value={signInPassphrase}
                                        disabled={busyId === 'sign-in-arm'}
                                        onChange={e => setSignInPassphrase(e.target.value)}
                                    />
                                    <button
                                        type="button"
                                        className="device-btn"
                                        disabled={
                                            signInPassphrase.length < 8
                                            || busyId === 'sign-in-arm'
                                        }
                                        onClick={() => void setSignInPass()}
                                    >
                                        {signIn?.armed ? 'Replace' : 'Set'}
                                    </button>
                                    {signIn?.armed && (
                                        <button
                                            type="button"
                                            className="device-btn device-btn-danger"
                                            disabled={busyId === 'sign-in-arm'}
                                            onClick={() => void clearSignInPass()}
                                        >
                                            Remove
                                        </button>
                                    )}
                                </div>
                            </div>
                        )}

                        {/* PAIRING AN ALWAYS-ON WAKER.
                            A machine that is fully powered off cannot wake
                            itself, and a magic packet is a subnet broadcast —
                            so something already awake, on the same wire, has to
                            send it. A phone qualifies only while it is at home,
                            which is exactly when the power button is in reach.
                            This is where a small always-on Linux box is vouched
                            for so it can be that sender.

                            Signing has to happen HERE because planWake ignores
                            unverified devices and only this machine has the
                            account key unlocked. The waker mints its own
                            keypair and never receives the seed. */}
                        {autostartSupported() && (
                            <div className="dv-card device-wake-note">
                                <strong>Add an always-on waker</strong>
                                <br />
                                To turn a computer on remotely, another machine that is already
                                switched on has to be on the same network to send the signal &mdash;
                                a phone can press the button but cannot send it unless it is at home.
                                Run <code>puca-waker init</code> on a small always-on Linux box,
                                then paste all three lines it prints here.
                                <br /><br />
                                <textarea
                                    className="waker-paste"
                                    rows={4}
                                    value={wakerPaste}
                                    onChange={e => setWakerPaste(e.target.value)}
                                    placeholder={'device_id  ...\ndevice_pub x25519:...\nsign_pub   ed25519:...'}
                                    aria-label="Output of puca-waker init"
                                />
                                <br />
                                <button
                                    className="dv-btn"
                                    disabled={busyId === 'pair-waker' || wakerPaste.trim().length === 0}
                                    onClick={() => void doPairWaker()}
                                >
                                    {busyId === 'pair-waker' ? 'Pairing...' : 'Pair this waker'}
                                </button>
                                {wakerOut && (
                                    <>
                                        <br /><br />
                                        <strong>Paired as {wakerOut.deviceId}.</strong> One command
                                        left, on the waker itself:
                                        <pre className="waker-blob">{`puca-waker pair ${wakerOut.userId} ${wakerOut.token}`}</pre>
                                        Then <code>systemctl enable --now puca-waker</code>.
                                        <br /><br />
                                        That token is a sign-in for your account, so treat the command
                                        like a password: it lands in a 0600 file on that machine and
                                        renews itself for as long as you sign in here every 30 days.
                                    </>
                                )}
                            </div>
                        )}

                        {tunnelSupported() && (
                            <div className="dv-card device-option">
                                <div className="option-info">
                                    <label htmlFor="device-forwarding">Allow port forwarding to this computer</label>
                                    <span className="option-hint">
                                        Lets a device you are signed in on reach services running on THIS
                                        computer &mdash; for example forwarding Remote Desktop so you can
                                        connect to it. Limited to this computer itself; it does not open
                                        anything on your home or office network. Off unless you turn it on,
                                        and only ever active while a session is running.
                                    </span>
                                </div>
                                <input
                                    id="device-forwarding"
                                    type="checkbox"
                                    checked={forwarding ?? false}
                                    disabled={forwarding === null}
                                    onChange={e => void toggleForwarding(e.target.checked)}
                                />
                            </div>
                        )}

                        {unattendedSupported() && (
                            <div className="dv-card device-unattended">
                                <div className="option-info">
                                    {/* NAMES THE MACHINE. Arming is device-local — the record
                                        is written to this computer's disk and nothing can
                                        arm another device remotely — but the card sat
                                        unlabelled above the list of ALL devices, so it read
                                        as a setting for whichever one you had in mind. Someone
                                        who armed their laptop and then tried to reach their
                                        desktop got no prompt and no explanation, because the
                                        desktop was never armed at all. */}
                                    <label>
                                        Unattended access on {thisDeviceName ?? 'this computer'}
                                    </label>
                                    <span className="option-hint">
                                        {unattended
                                            ? 'Armed. This computer can be controlled with nobody sitting at it, after you enter the unattended passphrase.'
                                            : 'Off. Turning this on lets you control this computer with nobody sitting at it. It is protected by a separate passphrase, not your account password, and the server never sees it.'}
                                    </span>
                                    <span className="option-hint">
                                        This arms <strong>this computer only</strong>. Every device you want to
                                        reach unattended has to be armed while you are sitting at it.
                                    </span>
                                    <span className="option-hint device-unattended-warning">
                                        There is no way to recover this passphrase remotely. If you forget it,
                                        the only fix is to come back to this computer and turn unattended
                                        access off here.
                                    </span>
                                </div>
                                {unattended ? (
                                    <button
                                        className="device-btn device-btn-danger"
                                        disabled={unattended === null}
                                        onClick={() => void removeUnattended()}
                                    >
                                        Turn off
                                    </button>
                                ) : uaOpen ? (
                                    <div className="device-unattended-form">
                                        <input
                                            id="device-ua-pass"
                                            type="password"
                                            autoComplete="new-password"
                                            placeholder="Unattended passphrase"
                                            value={uaPass}
                                            onChange={e => setUaPass(e.target.value)}
                                        />
                                        <button className="device-btn" onClick={() => void submitUnattended()}>
                                            Arm
                                        </button>
                                        <button
                                            className="device-btn"
                                            onClick={() => { setUaOpen(false); setUaPass(''); }}
                                        >
                                            Cancel
                                        </button>
                                    </div>
                                ) : (
                                    <button
                                        className="device-btn"
                                        disabled={unattended === null}
                                        onClick={() => setUaOpen(true)}
                                    >
                                        Set up
                                    </button>
                                )}
                            </div>
                        )}
                    </div>
                )}
            </div>

            {shareDeviceId && (() => {
                const d = devices?.find(x => x.id === shareDeviceId);
                return d ? (
                    <DeviceShareModal device={d} onClose={() => setShareDeviceId(null)} />
                ) : null;
            })()}
        </div>
    );
}
