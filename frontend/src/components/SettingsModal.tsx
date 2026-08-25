import { useState, useEffect, useRef, useCallback } from 'react';
import { getProfile, updateProfile } from '../api/profile';
import { unblockUser, type BlockedUser } from '../api/blocking';
import { fetchBlockedUsers, setBlockedLocal } from './blockStore';
import { clearAllHiddenMessages, hiddenMessageCount } from './hiddenMessagesStore';
import { changePassword, deleteAccount, requestEmailChange } from '../api/auth';
import { currentAppVersion } from '../api/appVersion';
import './SettingsModal.css';
import { parseServerTimestamp } from '../utils/serverTime';
import { type Settings, type KeyBinding, defaultSettings, loadSettings, saveSettings, inputGain } from './settingsStore';
import {
    type NoiseSuppressionMode, type MicTestGraph, NOISE_MODE_EVENT,
    getNoiseSuppressionMode, changeNoiseModeLive, getMicConstraints, buildMicTestGraph,
} from '../api/noiseFilter';
import { setHotkeyCaptureMode } from '../api/hotkeys';
import { ClipSettings } from './ClipSettings';
import { BUTTON_TO_VK, VK_LBUTTON, VK_RBUTTON, mouseVkLabel } from '../api/inputCodes';
import { isAndroidApp, isMobile, isTauri } from '../api/platform';
import { sendTestNotification } from '../api/desktopNotify';
import {
    mobileBatteryStatus, mobileNotificationStatus, openMobileNotificationSettings,
    requestIgnoreBatteryOptimizations, requestMobileNotificationPermission,
} from '../api/mobileApp';
import { requestBackgroundLocation, requestForegroundLocation } from '../api/mobileLocation';
import { clearAllPlaces, listPlaces, syncTaskPlacesToNative } from '../api/taskPlaces';
import {
    CheckIcon, CloseIcon, GlobeIcon, HeadphonesIcon, HeartIcon, Icon, LogoutIcon,
    MicIcon, PlayIcon, RecordIcon, StopIcon, TrashIcon, WarningIcon, type IconName,
} from './Icons';

/** Human label for a captured combo. Null = unbound, which is the default for
 *  every binding except the screen-control kill switch. */
function killKeyLabel(k: { ctrl: boolean; alt: boolean; shift: boolean; label: string } | null | undefined): string {
    if (!k) return 'Not set';
    return [k.ctrl && 'Ctrl', k.alt && 'Alt', k.shift && 'Shift', k.label].filter(Boolean).join(' + ');
}

/**
 * Display label for a captured key.
 *
 * `e.key` for whitespace and a few others is the character itself, which
 * renders as nothing: Space arrives as ' ' (length 1, so the old
 * `toUpperCase()` branch kept it verbatim) and `filter(Boolean)` happily keeps
 * a non-empty space string — so a Space binding drew an empty button and looked
 * unset, even though keyCode 32 was stored and working.
 */
function keyLabel(e: KeyboardEvent): string {
    switch (e.key) {
        case ' ': return 'Space';
        case 'Tab': return 'Tab';
        case 'Enter': return 'Enter';
        case 'Backspace': return 'Backspace';
        case 'Delete': return 'Del';
        default: return e.key.length === 1 ? e.key.toUpperCase() : e.key;
    }
}

import { BIND_FIELDS, KEYBIND_TAB_ROWS, type BindField } from './keybindFields';

function sameCombo(a: KeyBinding | null | undefined, b: KeyBinding | null | undefined): boolean {
    if (!a || !b) return a === b || (!a && !b);   // both unbound counts as same
    return a.keyCode === b.keyCode && a.ctrl === b.ctrl && a.alt === b.alt && a.shift === b.shift;
}

/**
 * Selectable themes. The colour themes (styles/theme.css) tint every surface
 * from one hue, so the swatch previews the theme's chat background beside its
 * brand colour — enough to tell them apart at a glance.
 */
const THEMES: Array<{ id: string; label: string; swatch: string }> = [
    { id: 'dark', label: 'Dark', swatch: 'linear-gradient(135deg, #18191c 60%, #5865f2 60%)' },
    { id: 'light', label: 'Light', swatch: 'linear-gradient(135deg, #f2f3f5 60%, #5865f2 60%)' },
    { id: 'amoled', label: 'AMOLED', swatch: 'linear-gradient(135deg, #000000 60%, #5865f2 60%)' },
    { id: 'pink', label: 'Pink', swatch: 'linear-gradient(135deg, #231520 60%, #d63384 60%)' },
    { id: 'purple', label: 'Purple', swatch: 'linear-gradient(135deg, #1a1424 60%, #8b5cf6 60%)' },
    { id: 'green', label: 'Green', swatch: 'linear-gradient(135deg, #12211a 60%, #23a55a 60%)' },
    { id: 'orange', label: 'Orange', swatch: 'linear-gradient(135deg, #241a12 60%, #e8590c 60%)' },
    { id: 'yellow', label: 'Yellow', swatch: 'linear-gradient(135deg, #211d13 60%, #c28e0e 60%)' },
];

/**
 * The two Android states that silently kill notifications, made visible.
 *
 * Both used to be invisible: a denied POST_NOTIFICATIONS grant drops every
 * post OS-side while the app reports success (after two denials Android makes
 * re-asking a silent no-op — only the system settings screen can recover it),
 * and battery optimisation lets Doze starve the WebSocket that IS the
 * delivery path, no matter that the foreground service keeps the process
 * alive. Field reports of "notifications just don't work" were these two
 * states plus nothing on screen saying so.
 *
 * Renders nothing while everything is healthy, off Android, or on an APK too
 * old to report (status calls return null there — no row beats a wrong row).
 */
function AndroidNotificationHealth({ wantsNotifications, backgroundDelivery }: {
    wantsNotifications: boolean;
    backgroundDelivery: boolean;
}) {
    const [osStatus, setOsStatus] =
        useState<{ granted: boolean; needsRequest: boolean; blocked?: boolean } | null>(null);
    const [batteryIgnoring, setBatteryIgnoring] = useState<boolean | null>(null);
    const [linkFailed, setLinkFailed] = useState(false);
    const [batteryAskFailed, setBatteryAskFailed] = useState(false);

    useEffect(() => {
        let live = true;
        const refresh = () => {
            void mobileNotificationStatus().then(s => { if (live) setOsStatus(s); });
            void mobileBatteryStatus().then(b => { if (live) setBatteryIgnoring(b === null ? null : b.ignoring); });
        };
        refresh();
        // Both fix paths detour through system UI; re-read the truth on the
        // way back rather than trusting what we hoped the user chose.
        const onVis = () => { if (document.visibilityState === 'visible') refresh(); };
        document.addEventListener('visibilitychange', onVis);
        window.addEventListener('sovereign-notif-health-refresh', refresh);
        return () => {
            live = false;
            document.removeEventListener('visibilitychange', onVis);
            window.removeEventListener('sovereign-notif-health-refresh', refresh);
        };
    }, []);

    if (!wantsNotifications) return null;
    // `blocked` covers all three OS-side kill states: the runtime grant
    // denied, notifications off for the whole app, or the Messages channel
    // silenced (the latter two via the 0.8.58 APK's `blocked` field — a
    // granted permission cannot see them).
    const blocked = osStatus !== null && (!osStatus.granted || osStatus.blocked === true);
    // Never-asked is recoverable with the normal system prompt — offer that
    // before sending anyone spelunking through Android settings.
    const canPrompt = blocked && osStatus !== null && osStatus.needsRequest && osStatus.blocked !== true;
    // Battery only matters once delivery is possible at all, and only when
    // the APK can report it.
    const throttled = !blocked && backgroundDelivery && batteryIgnoring === false;
    if (!blocked && !throttled) return null;

    return (
        <div className="settings-option notif-health">
            <div className="option-info">
                {blocked ? (
                    <>
                        <label><WarningIcon /> Android is blocking notifications</label>
                        <span className="option-hint">
                            {canPrompt
                                ? 'Android has not been asked for permission yet, or the ask was dismissed.'
                                : 'Notifications are turned off for Puca at the system level, so nothing it posts is shown. Android stops asking after two refusals — it can only be re-enabled from the system settings screen.'}
                            {linkFailed && ' Open Android Settings → Apps → Puca → Notifications and allow them.'}
                        </span>
                    </>
                ) : (
                    <>
                        <label><WarningIcon /> Battery optimization limits delivery</label>
                        <span className="option-hint">
                            With the screen off, Android pauses this app's network to
                            save battery — the connection that delivers notifications
                            starves exactly when you'd need it. Exempting Puca is
                            what makes screen-off delivery reliable.
                            {batteryAskFailed && ' This phone hides that dialog: open Android Settings → Apps → Puca → Battery and choose Unrestricted.'}
                        </span>
                    </>
                )}
            </div>
            <button
                className="secondary-btn"
                onClick={() => {
                    if (canPrompt) {
                        void requestMobileNotificationPermission().then(() => {
                            window.dispatchEvent(new CustomEvent('sovereign-notif-health-refresh'));
                        });
                    } else if (blocked) {
                        void openMobileNotificationSettings().then(ok => { if (!ok) setLinkFailed(true); });
                    } else {
                        void requestIgnoreBatteryOptimizations().then(ok => { if (!ok) setBatteryAskFailed(true); });
                    }
                }}
            >
                {canPrompt ? 'Allow notifications' : blocked ? 'Open Android settings' : 'Allow background use'}
            </button>
        </div>
    );
}

/** How long a mic-test take records before it stops itself and plays back. */
const MIC_TEST_RECORD_MS = 6000;
/** A take stopped sooner than this is discarded — nothing worth hearing, and
 *  a sub-timeslice stop can leave MediaRecorder with an empty blob. */
const MIC_TEST_MIN_TAKE_MS = 500;

/** User-facing names of the noise-suppression modes (same words as the voice panel's dropdown). */
const NOISE_MODE_LABELS: Record<NoiseSuppressionMode, string> = {
    off: 'No suppression',
    standard: 'Standard',
    rnnoise: 'RNNoise (ML)',
    deepfilter: 'DeepFilter (Max)',
};
const labelForMode = (m: NoiseSuppressionMode) => NOISE_MODE_LABELS[m] ?? m;

interface SettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
    onLogout?: () => void;
}

export function SettingsModal({ isOpen, onClose, onLogout }: SettingsModalProps) {
    const [activeSection, setActiveSection] = useState('account');
    const [settings, setSettings] = useState<Settings>(loadSettings);
    const [audioDevices, setAudioDevices] = useState<{ inputs: MediaDeviceInfo[]; outputs: MediaDeviceInfo[] }>({
        inputs: [],
        outputs: [],
    });
    const [username, setUsername] = useState('');
    const [displayName, setDisplayName] = useState('');
    const [email, setEmail] = useState('');
    const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
    const [appVersion, setAppVersion] = useState<string>('');
    // Server-side privacy flags (PATCH /profile) — unlike the rest of this
    // modal these are NOT localStorage: a privacy control the server never
    // hears about protects nothing. null = not loaded yet.
    const [privacy, setPrivacy] = useState<{ allowDMs: boolean; showOnline: boolean } | null>(null);
    // Blocked users (GET /blocked). null = not loaded yet.
    const [blocked, setBlocked] = useState<BlockedUser[] | null>(null);
    const [unblocking, setUnblocking] = useState<number | null>(null);
    // Visible failure text for the blocked-users card. A silent failure here is
    // indistinguishable from a dead button / an empty list — and this card is
    // the primary unblock affordance.
    const [blockedError, setBlockedError] = useState<string | null>(null);
    // Capturing a hotkey: while set, the next non-modifier keypress becomes the
    // binding for that settings field (keyCode = Windows VK in WebView2). One
    // capture flow shared by the kill switch, push-to-talk and push-to-mute.
    const [capturingBind, setCapturingBind] = useState<BindField | null>(null);
    // Set when a captured combo is already taken by another action; shown next
    // to the button being edited, which stays in capture so the user can just
    // press something else.
    const [bindConflict, setBindConflict] = useState<string | null>(null);
    // In-app password change
    const [pwCurrent, setPwCurrent] = useState('');
    const [pwNew, setPwNew] = useState('');
    const [pwConfirm, setPwConfirm] = useState('');
    const [pwStatus, setPwStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
    const [pwError, setPwError] = useState('');

    // Change-email state
    const [emailEditing, setEmailEditing] = useState(false);
    const [emailStatus, setEmailStatus] = useState<string | null>(null);
    // Delete-account state (two-step: reveal, then password + retyped username)
    const [deleteArmed, setDeleteArmed] = useState(false);
    const [deletePassword, setDeletePassword] = useState('');
    const [deleteConfirmName, setDeleteConfirmName] = useState('');
    const [deleteStatus, setDeleteStatus] = useState<'idle' | 'working' | 'error'>('idle');
    const [deleteError, setDeleteError] = useState('');

    const handleDeleteAccount = async () => {
        setDeleteError('');
        if (deleteConfirmName.trim() !== username) {
            setDeleteError('Type your username exactly to confirm.');
            setDeleteStatus('error');
            return;
        }
        setDeleteStatus('working');
        try {
            await deleteAccount(username, deletePassword);
            // Every session is dead server-side; scrub this device and restart.
            localStorage.clear();
            window.location.reload();
        } catch (err) {
            setDeleteError(err instanceof Error ? err.message : 'Failed to delete account.');
            setDeleteStatus('error');
        }
    };

    const handleChangePassword = async (e: React.FormEvent) => {
        e.preventDefault();
        setPwError('');
        if (pwNew.length < 8) { setPwError('New password must be at least 8 characters.'); setPwStatus('error'); return; }
        if (pwNew !== pwConfirm) { setPwError('New passwords do not match.'); setPwStatus('error'); return; }
        if (pwNew === pwCurrent) { setPwError('New password must differ from the current one.'); setPwStatus('error'); return; }
        setPwStatus('saving');
        try {
            await changePassword(username, pwCurrent, pwNew);
            setPwStatus('saved');
            setPwCurrent(''); setPwNew(''); setPwConfirm('');
            setTimeout(() => setPwStatus('idle'), 4000);
        } catch (err) {
            setPwError(err instanceof Error ? err.message : 'Failed to change password.');
            setPwStatus('error');
        }
    };

    // Mic testing state — RECORD the RAW mic, then LOOP it through the CURRENT
    // voice settings (the Logitech G HUB / Blue VO!CE workflow). The take is
    // captured unprocessed for MIC_TEST_RECORD_MS, the mic is released, and the
    // take loops through a private processing graph (buildMicTestGraph: the
    // selected noise-suppression mode, then the mic gain) into your output
    // device — so flipping the mode, toggling the DeepFilter post filter or
    // dragging Input Volume changes what you hear, on the SAME take, live.
    // Echo cancellation, auto gain and the browser's own noise suppression are
    // applied INSIDE capture, so they are baked into the take: the UI says
    // what the take was captured with and invites a re-record for those.
    // No live monitoring: nothing plays while you record.
    type MicTestPhase = 'idle' | 'starting' | 'recording' | 'stopping' | 'ready' | 'playing';
    type MicTake = {
        buffer: AudioBuffer;
        durationMs: number;
        capture: { mode: NoiseSuppressionMode; echo: boolean; agc: boolean; browserNs: boolean };
    };
    const [micTestPhase, setMicTestPhase] = useState<MicTestPhase>('idle');
    const micTestPhaseRef = useRef<MicTestPhase>(micTestPhase);
    micTestPhaseRef.current = micTestPhase;
    const [micLevel, setMicLevel] = useState(0); // input level while recording, processed level while playing
    const [micRecProgress, setMicRecProgress] = useState(0); // 0..1 through the take
    const [micPlayProgress, setMicPlayProgress] = useState(0); // 0..1 through the current loop
    const [micTake, setMicTake] = useState<MicTake | null>(null);
    // While playing: the mode the loop is actually running through (a
    // DeepFilter build that fails cascades to RNNoise, then to plain); null
    // while a graph is being (re)built.
    const [micPlayMode, setMicPlayMode] = useState<NoiseSuppressionMode | null>(null);
    const [micTestNotice, setMicTestNotice] = useState<string | null>(null);
    // Capture side.
    const micMeterCtxRef = useRef<AudioContext | null>(null);
    const micStreamRef = useRef<MediaStream | null>(null);
    const micRecorderRef = useRef<MediaRecorder | null>(null);
    const micRecTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const micRecTickRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const micRecAnimRef = useRef<number | null>(null);
    // Generation counter: a start that is superseded (stop, or a restart on a
    // settings change) while its awaits are in flight must release what it
    // built instead of installing it — otherwise a fast toggle leaks a hot mic.
    const micTestGenRef = useRef(0);
    // Playback side (the loop player): a private context that loops the
    // take's AudioBuffer into a MediaStream, which the processing graph eats
    // like a mic. Rebuilding the graph on a settings change leaves the loop
    // running — only the processing changes.
    const micPlayerRef = useRef<{ ctx: AudioContext; source: AudioBufferSourceNode; stream: MediaStream; startedAt: number; durationS: number; started: boolean } | null>(null);
    const micPlayGraphRef = useRef<MicTestGraph | null>(null);
    const micAudioRef = useRef<HTMLAudioElement | null>(null);
    const micPlayTickRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const micPlayAnimRef = useRef<number | null>(null);
    const micPlayGenRef = useRef(0); // player lifetime
    const micGraphBuildRef = useRef(0); // graph (re)builds within a player lifetime

    // Noise-suppression mode picker (also lives in the voice panel; one source
    // of truth in noiseFilter, synced through NOISE_MODE_EVENT).
    const [noiseMode, setNoiseMode] = useState<NoiseSuppressionMode>(() => getNoiseSuppressionMode());
    useEffect(() => {
        const sync = () => setNoiseMode(getNoiseSuppressionMode());
        window.addEventListener(NOISE_MODE_EVENT, sync);
        return () => window.removeEventListener(NOISE_MODE_EVENT, sync);
    }, []);
    // Does the take's capture-time processing match what a call would use RIGHT
    // NOW? Only then is the loop an exact "what others would hear".
    const micTakeCaptureMatchesNow = !!micTake
        && micTake.capture.echo === !!settings.echoCancellation
        && micTake.capture.agc === !!settings.autoGainControl
        && micTake.capture.browserNs === (noiseMode === 'standard' && !!settings.noiseSuppression);

    // Load user profile
    useEffect(() => {
        if (isOpen) {
            getProfile().then(profile => {
                setUsername(profile.username);
                setDisplayName(profile.display_name || '');
                setEmail(profile.email || '');
                setPrivacy({
                    allowDMs: profile.allow_dms_from_server_members ?? true,
                    showOnline: profile.show_online_status ?? true,
                });
            }).catch(console.error);

            // Fetch app version from Tauri
            currentAppVersion().then(setAppVersion).catch(() => setAppVersion('Unknown'));
        }
    }, [isOpen]);

    // "Delete for Me" count, refreshed when the privacy tab opens — the
    // durable recovery surface for hides whose Undo toast is long gone.
    const [hiddenCount, setHiddenCount] = useState(0);

    // Load the blocked list when the privacy tab opens (and refresh on re-entry
    // — a block made from a context menu while the modal was open must show).
    useEffect(() => {
        if (isOpen && activeSection === 'privacy') {
            setHiddenCount(hiddenMessageCount());
            setBlockedError(null);
            // fetchBlockedUsers also syncs the app-wide block store (message
            // hiding / notification suppression) with what the server says.
            fetchBlockedUsers().then(setBlocked).catch(err => {
                console.error('Failed to load blocked users:', err);
                // NOT an empty list: "you haven't blocked anyone" while a block
                // is live would leave the block unremovable from the UI.
                setBlocked(null);
                setBlockedError('Could not load your blocked users — retry from the Privacy tab.');
            });
        }
    }, [isOpen, activeSection]);

    /** Flip a server-side privacy flag: optimistic, reverts on failure. */
    const setPrivacyFlag = (key: 'allowDMs' | 'showOnline', value: boolean) => {
        const prev = privacy;
        if (!prev) return; // not loaded — the control is disabled anyway
        setPrivacy({ ...prev, [key]: value });
        const field = key === 'allowDMs' ? 'allow_dms_from_server_members' : 'show_online_status';
        updateProfile({ [field]: value }).catch(err => {
            console.error('Failed to update privacy setting:', err);
            setPrivacy(prev);
        });
    };

    const handleUnblock = (userId: number) => {
        setUnblocking(userId);
        setBlockedError(null);
        unblockUser(userId)
            .then(() => {
                setBlocked(prev => prev?.filter(b => b.user_id !== userId) ?? prev);
                setBlockedLocal(userId, false); // un-hide messages + lift the local voice mute
            })
            .catch(err => {
                console.error('Failed to unblock:', err);
                setBlockedError('Unblock failed — check your connection and try again.');
            })
            .finally(() => setUnblocking(null));
    };

    // The header renders an "ESC" hint — make Escape actually close the modal.
    useEffect(() => {
        if (!isOpen) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [isOpen, onClose]);

    // Closing the modal (the close button or overlay click) must also end an
    // in-progress key capture: the component stays mounted
    // (`if (!isOpen) return null`), so without this the capture effect below
    // never cleans up — its window listener and the registry-wide
    // setHotkeyCaptureMode(true) leak, every hotkey (PTT included) stays
    // suspended app-wide, and the first key pressed after refocusing is
    // swallowed and silently bound to the abandoned field.
    useEffect(() => {
        if (!isOpen && capturingBind) {
            setCapturingBind(null);
            setBindConflict(null);
        }
    }, [isOpen, capturingBind]);

    // Capture the next non-modifier keypress as the binding being edited.
    useEffect(() => {
        if (!capturingBind) return;
        const field = capturingBind;
        // Suspend the hotkey registry for the duration. Its window listeners
        // were installed at app start, so they run BEFORE this one and
        // stopPropagation cannot reach them — without this, pressing Ctrl+D to
        // rebind Toggle Deafen deafened you as a side effect of rebinding it.
        // Entering capture also releases any held action, which is what gives a
        // PTT key rebound while physically held a release path at all.
        setHotkeyCaptureMode(true);
        const onKey = (e: KeyboardEvent) => {
            e.preventDefault();
            e.stopPropagation();
            // Escape cancels — but ONLY on its own. Esc is the default
            // screen-control kill switch, so with no way to type it there was
            // no route back to that default short of wiping local storage.
            // Ctrl/Alt/Shift+Esc binds normally, and every row has a Reset.
            if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey) {
                setCapturingBind(null);
                setBindConflict(null);
                return;
            }
            if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return; // wait for a real key
            // Some synthetic/exotic input sources deliver keyCode 0 — storing
            // that would create a binding no real keypress can ever match.
            if (!e.keyCode) return;
            const next: KeyBinding = {
                keyCode: e.keyCode, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey,
                label: keyLabel(e),
            };
            // Refuse a combo already taken by another action. Both would fire
            // on every press — a PTT key that also toggles mute reads as
            // "push-to-talk randomly stopped working", with nothing in the UI
            // pointing at the duplicate.
            const clash = BIND_FIELDS.find(([f]) => f !== field && sameCombo(settings[f], next));
            if (clash) {
                setBindConflict(`${killKeyLabel(next)} is already bound to ${clash[1]}.`);
                return; // stay in capture so the next press can be a different key
            }
            setBindConflict(null);
            setSettings(prev => { const s = { ...prev, [field]: next }; saveSettings(s); return s; });
            setCapturingBind(null);
        };
        // MOUSE buttons are bindable too (not for the kill switch — its
        // enforcement path is the keyboard-only low-level hook). Left click
        // stays a click: it must keep operating Reset/Cancel/close. The
        // trailing click/auxclick/contextmenu of a captured button are
        // swallowed for the capture's duration so the overlay's
        // click-to-close and the bind button's own toggle don't react.
        const mouseAllowed = field !== 'remoteControlKillKey';
        const onMouseCapture = (e: MouseEvent) => {
            if (!mouseAllowed) return;
            const vk = BUTTON_TO_VK[e.button];
            if (vk === undefined || vk === VK_LBUTTON) return;
            e.preventDefault();
            e.stopPropagation();
            if (e.type !== 'mousedown') return; // swallow the follow-ups only
            // Right click can't be a hotkey: making it one would swallow
            // EVERY context menu app-wide (message menus, moderation menus).
            if (vk === VK_RBUTTON) {
                setBindConflict("Right click can't be a hotkey — it opens menus. Try Mouse 3/4/5.");
                return;
            }
            const next: KeyBinding = {
                keyCode: vk, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey,
                label: mouseVkLabel(vk),
            };
            const clash = BIND_FIELDS.find(([f]) => f !== field && sameCombo(settings[f], next));
            if (clash) {
                setBindConflict(`${killKeyLabel(next)} is already bound to ${clash[1]}.`);
                return;
            }
            setBindConflict(null);
            setSettings(prev => { const s = { ...prev, [field]: next }; saveSettings(s); return s; });
            setCapturingBind(null);
        };
        window.addEventListener('keydown', onKey, true);
        window.addEventListener('mousedown', onMouseCapture, true);
        window.addEventListener('mouseup', onMouseCapture, true);
        window.addEventListener('auxclick', onMouseCapture, true);
        window.addEventListener('contextmenu', onMouseCapture, true);
        return () => {
            window.removeEventListener('keydown', onKey, true);
            window.removeEventListener('mousedown', onMouseCapture, true);
            window.removeEventListener('mouseup', onMouseCapture, true);
            window.removeEventListener('auxclick', onMouseCapture, true);
            window.removeEventListener('contextmenu', onMouseCapture, true);
            setHotkeyCaptureMode(false);
        };
    }, [capturingBind, settings]);

    /** Put one binding back to its shipped default. */
    const resetBind = (field: BindField) => {
        setBindConflict(null);
        setCapturingBind(null);
        setSettings(prev => {
            const s = { ...prev, [field]: defaultSettings[field] };
            saveSettings(s);
            return s;
        });
    };

    /**
     * The rebind control: current combo, a Reset to the shipped default, and
     * the conflict notice when a captured combo is already taken. Shared by
     * every site that edits a binding so they can't drift apart.
     */
    const bindControl = (field: BindField, title?: string) => (
        <span className="keybind-controls">
            {capturingBind === field && bindConflict && (
                <span className="keybind-conflict">{bindConflict}</span>
            )}
            <button
                className="keybind-btn"
                title={title ?? 'Click, then press the combination you want'}
                onClick={() => {
                    setBindConflict(null);
                    setCapturingBind(v => (v === field ? null : field));
                }}
            >
                {capturingBind === field
                    ? (field === 'remoteControlKillKey'
                        ? 'Press a key… (Esc to cancel)'
                        : 'Press a key or mouse button… (Esc to cancel)')
                    : killKeyLabel(settings[field])}
            </button>
            <button
                className="keybind-clear"
                onClick={() => updateSetting(field, null)}
                disabled={!settings[field]}
                title="Remove this keybind"
                aria-label="Remove this keybind"
            >
                <TrashIcon />
            </button>
            <button
                className="keybind-reset"
                onClick={() => resetBind(field)}
                disabled={sameCombo(settings[field], defaultSettings[field])}
                title={defaultSettings[field]
                    ? `Reset to ${killKeyLabel(defaultSettings[field])}`
                    : 'Reset to unbound'}
            >
                Reset
            </button>
        </span>
    );

    // Enumerate audio devices - request permission first to get labels
    useEffect(() => {
        if (isOpen && activeSection === 'voice') {
            // Request mic permission first to get device labels
            navigator.mediaDevices.getUserMedia({ audio: true })
                .then(stream => {
                    // Stop the stream immediately, we just needed permission
                    stream.getTracks().forEach(track => track.stop());
                    // Now enumerate devices (labels will be visible)
                    return navigator.mediaDevices.enumerateDevices();
                })
                .then(devices => {
                    setAudioDevices({
                        inputs: devices.filter(d => d.kind === 'audioinput'),
                        outputs: devices.filter(d => d.kind === 'audiooutput'),
                    });
                })
                .catch(console.error);
        }
    }, [isOpen, activeSection]);

    /** rAF meter loop on an analyser: average byte magnitude → 0..100. */
    const runMeter = (analyser: AnalyserNode, animRef: { current: number | null }, live: () => boolean) => {
        const data = new Uint8Array(analyser.frequencyBinCount);
        const step = () => {
            if (!live()) return;
            analyser.getByteFrequencyData(data);
            let sum = 0;
            for (let i = 0; i < data.length; i++) sum += data[i];
            setMicLevel(Math.min(100, (sum / data.length / 255) * 100));
            animRef.current = requestAnimationFrame(step);
        };
        step();
    };

    // Let go of the capture RESOURCES — timers, meter, mic — without voiding
    // the generation. Used when a recording finishes normally (its onstop
    // still owns the take) and by releaseMicCapture below.
    const releaseMicResources = useCallback(() => {
        if (micRecAnimRef.current) { cancelAnimationFrame(micRecAnimRef.current); micRecAnimRef.current = null; }
        if (micRecTimerRef.current) { clearTimeout(micRecTimerRef.current); micRecTimerRef.current = null; }
        if (micRecTickRef.current) { clearInterval(micRecTickRef.current); micRecTickRef.current = null; }
        micRecorderRef.current = null;
        if (micMeterCtxRef.current) { micMeterCtxRef.current.close().catch(() => { /* closed */ }); micMeterCtxRef.current = null; }
        if (micStreamRef.current) {
            micStreamRef.current.getTracks().forEach(track => track.stop());
            micStreamRef.current = null;
        }
        setMicRecProgress(0);
        setMicLevel(0);
    }, []);

    // Release the CAPTURE side — abort the recorder, drop the resources — and
    // void any in-flight start. Leaves the take (and its playback) alone.
    const releaseMicCapture = useCallback(() => {
        micTestGenRef.current++;
        const rec = micRecorderRef.current;
        if (rec && rec.state !== 'inactive') {
            // Detach first: a stop() from here is an ABORT, not a take.
            rec.ondataavailable = null;
            rec.onstop = null;
            try { rec.stop(); } catch { /* already stopping */ }
        }
        releaseMicResources();
    }, [releaseMicResources]);

    // Stop the loop player, its processing graph and the playback element
    // (keeps the take).
    const stopMicPlayback = useCallback(() => {
        micPlayGenRef.current++;
        micGraphBuildRef.current++;
        if (micPlayAnimRef.current) { cancelAnimationFrame(micPlayAnimRef.current); micPlayAnimRef.current = null; }
        if (micPlayTickRef.current) { clearInterval(micPlayTickRef.current); micPlayTickRef.current = null; }
        const audio = micAudioRef.current;
        if (audio) {
            audio.pause();
            audio.srcObject = null;
            micAudioRef.current = null;
        }
        if (micPlayGraphRef.current) { micPlayGraphRef.current.destroy(); micPlayGraphRef.current = null; }
        const player = micPlayerRef.current;
        if (player) {
            try { player.source.stop(); } catch { /* not started */ }
            try { player.source.disconnect(); } catch { /* gone */ }
            player.ctx.close().catch(() => { /* already closed */ });
            micPlayerRef.current = null;
        }
        setMicPlayMode(null);
        setMicPlayProgress(0);
        setMicLevel(0);
    }, []);

    // Full stop: capture, playback, take, notice — used when the section or
    // the modal goes away (the modal never unmounts, so state must be reset
    // by hand or a stale take/notice greets the next visit).
    const stopMicTest = useCallback(() => {
        releaseMicCapture();
        stopMicPlayback();
        setMicTake(null);
        setMicTestPhase('idle');
        setMicTestNotice(null);
        setMicLevel(0);
    }, [releaseMicCapture, stopMicPlayback]);

    // Leaving the Voice section stops capture and playback but KEEPS the
    // take (enabling DeepFilter lives under Advanced — the A/B must survive
    // that round trip); closing the modal drops everything.
    const micTakeRef = useRef<MicTake | null>(null);
    micTakeRef.current = micTake;
    useEffect(() => {
        if (!isOpen) {
            stopMicTest();
        } else if (activeSection !== 'voice') {
            releaseMicCapture();
            stopMicPlayback();
            setMicTestPhase(micTakeRef.current ? 'ready' : 'idle');
            setMicTestNotice(null);
        }
    }, [isOpen, activeSection, stopMicTest, releaseMicCapture, stopMicPlayback]);
    const stopMicTestRef = useRef(stopMicTest);
    stopMicTestRef.current = stopMicTest;
    useEffect(() => () => stopMicTestRef.current(), []);

    /**
     * Build (or rebuild) the processing graph on the loop player's stream in
     * `mode` and route the playback element to it. Build-before-teardown: the
     * previous graph keeps sounding until the new one is ready, and the loop
     * itself never stops — only the processing changes. If the requested tier
     * cannot be built the graph says what it fell back to.
     */
    const buildPlaybackGraph = useCallback(async (mode: NoiseSuppressionMode) => {
        const player = micPlayerRef.current;
        if (!player) return;
        const playGen = micPlayGenRef.current;
        const buildId = ++micGraphBuildRef.current;
        const stale = () => playGen !== micPlayGenRef.current || buildId !== micGraphBuildRef.current;
        setMicPlayMode(null);
        let fallbackNote: string | null = null;
        let graph: MicTestGraph | null = null;
        try {
            graph = await buildMicTestGraph(player.stream, mode, {
                onDead: (why) => {
                    if (stale()) return;
                    setMicTestNotice(`${labelForMode(mode)} stopped working during playback (${why}). ` +
                        'In a call you would be switched down a tier automatically.');
                },
                onFallback: (from, to, why) => {
                    fallbackNote = `${labelForMode(from)} couldn’t start here (${why}) — playing through ${labelForMode(to)} instead.`;
                },
            });
        } catch (err) {
            if (stale()) return;
            // Nothing can play: do not sit on "Setting up…" forever.
            stopMicPlayback();
            setMicTestPhase('ready');
            setMicTestNotice('Couldn’t set up playback: ' + (err instanceof Error ? err.message : String(err)));
            return;
        }
        if (stale()) { graph.destroy(); return; }
        const old = micPlayGraphRef.current;
        micPlayGraphRef.current = graph;
        // The build snapshots the gain when it starts; a slider dragged during
        // a (long, DeepFilter) build would otherwise be lost on the swap.
        graph.setGain(inputGain());
        // Route the element to the new graph's output, then drop the old one.
        const audio = micAudioRef.current;
        if (audio) {
            audio.srcObject = graph.output;
            audio.play().catch(err => {
                // A pending play() is rejected with AbortError whenever a NEWER
                // action pauses/reloads this element: not a failure of this take.
                if (micAudioRef.current !== audio) return;
                if (err instanceof DOMException && err.name === 'AbortError') return;
                console.warn('[MicTest] playback blocked:', err);
                setMicTestNotice('Playback was blocked by the browser — press Play.');
            });
        }
        old?.destroy();
        // The loop starts with the FIRST graph that lands — whichever build that
        // is. (Waiting for the build playMicTake happened to await would leave a
        // mode switch made during a slow first DeepFilter build in silence until
        // that superseded build finally timed out.)
        if (!player.started) {
            player.source.start();
            player.startedAt = player.ctx.currentTime;
            player.started = true;
            micPlayTickRef.current = setInterval(() => {
                const p = micPlayerRef.current;
                if (!p || playGen !== micPlayGenRef.current) return;
                const t = (p.ctx.currentTime - p.startedAt) % p.durationS;
                setMicPlayProgress(p.durationS > 0 ? t / p.durationS : 0);
            }, 100);
        }
        // Meter what the room would hear: the processed, gained loop.
        if (micPlayAnimRef.current) { cancelAnimationFrame(micPlayAnimRef.current); micPlayAnimRef.current = null; }
        const analyser = graph.context.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.3;
        graph.meterNode.connect(analyser);
        runMeter(analyser, micPlayAnimRef, () => !stale());
        setMicPlayMode(graph.mode);
        setMicTestNotice(fallbackNote);
    }, [stopMicPlayback]);

    /** Start looping the current take through the current settings. */
    const playMicTake = useCallback(async () => {
        const take = micTake;
        if (!take) return;
        stopMicPlayback();
        const playGen = ++micPlayGenRef.current;
        const ctx = new AudioContext({ sampleRate: 48000 });
        const source = ctx.createBufferSource();
        source.buffer = take.buffer;
        source.loop = true;
        const msDest = ctx.createMediaStreamDestination();
        msDest.channelCount = 1;
        source.connect(msDest);
        const audio = new Audio();
        audio.volume = settings.outputVolume / 100;
        if (settings.outputDeviceId !== 'default' && 'setSinkId' in audio) {
            (audio as HTMLAudioElement & { setSinkId: (id: string) => Promise<void> })
                .setSinkId(settings.outputDeviceId)
                .catch(err => console.warn('[MicTest] setSinkId failed:', err));
        }
        micAudioRef.current = audio;
        micPlayerRef.current = { ctx, source, stream: msDest.stream, startedAt: 0, durationS: take.buffer.duration, started: false };
        setMicTestPhase('playing');
        setMicPlayProgress(0);
        try { if (ctx.state === 'suspended') await ctx.resume(); } catch { /* the graph has its own guard */ }
        if (playGen !== micPlayGenRef.current) return;
        // The graph build starts the loop when it lands (see buildPlaybackGraph),
        // so the first pass is heard from the top through real processing.
        await buildPlaybackGraph(getNoiseSuppressionMode());
    }, [micTake, stopMicPlayback, buildPlaybackGraph, settings.outputDeviceId, settings.outputVolume]);
    const playMicTakeRef = useRef(playMicTake);
    useEffect(() => { playMicTakeRef.current = playMicTake; }, [playMicTake]);
    // A fresh take starts looping by itself (the record click was the gesture).
    const micTakeAutoplayRef = useRef<MicTake | null>(null);
    useEffect(() => {
        if (micTake && micTakeAutoplayRef.current !== micTake) {
            micTakeAutoplayRef.current = micTake;
            void playMicTakeRef.current();
        }
    }, [micTake]);

    /**
     * Record a RAW take: capture the mic with the constraints a call would use
     * for the current mode (device; echo/AGC toggles; the browser's noise
     * suppression only in Standard), meter it and record it for
     * MIC_TEST_RECORD_MS, release the mic, decode the take, then loop it
     * through the current settings.
     */
    const startMicRecording = useCallback(async (notice: string | null = null) => {
        releaseMicCapture();
        stopMicPlayback();
        const gen = ++micTestGenRef.current;
        const mode = getNoiseSuppressionMode();
        const s = loadSettings();
        setMicTestNotice(notice);
        setMicTestPhase('starting');
        setMicPlayMode(null);
        let stream: MediaStream | null = null;
        const stale = () => gen !== micTestGenRef.current;
        try {
            if (typeof MediaRecorder === 'undefined') throw new Error('this browser cannot record audio (no MediaRecorder)');
            stream = await navigator.mediaDevices.getUserMedia({ audio: getMicConstraints(mode) });
            if (stale()) { stream.getTracks().forEach(t => t.stop()); return; }
            micStreamRef.current = stream;

            // Input meter (raw mic) — the processing is heard on playback.
            const meterCtx = new AudioContext({ sampleRate: 48000 });
            micMeterCtxRef.current = meterCtx;
            const analyser = meterCtx.createAnalyser();
            analyser.fftSize = 256;
            // Responsive meter: the default 0.8 makes the bar lag well behind the
            // voice; 0.3 tracks it closely while staying smooth enough not to jitter.
            analyser.smoothingTimeConstant = 0.3;
            meterCtx.createMediaStreamSource(stream).connect(analyser);
            try { if (meterCtx.state === 'suspended') await meterCtx.resume(); } catch { /* meter only */ }
            if (stale()) return;

            // Record the RAW mic. Opus at 128 kb/s in WebM (mp4 where WebM is
            // unsupported); 250 ms timeslices so an early Stop yields a take
            // promptly. Decoded back to PCM for the loop player.
            const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
                .find(t => MediaRecorder.isTypeSupported(t));
            const rec = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 128_000 });
            const chunks: Blob[] = [];
            const startedAt = performance.now();
            const capture = { mode, echo: !!s.echoCancellation, agc: !!s.autoGainControl, browserNs: mode === 'standard' && !!s.noiseSuppression };
            rec.ondataavailable = (e: BlobEvent) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
            rec.onstop = async () => {
                if (stale()) return; // aborted (stop/settings change) — not a take
                // Also reached when the recorder stops ITSELF (the device was
                // unplugged / permission revoked): the take is still good.
                setMicTestPhase('stopping');
                const durationMs = Math.min(MIC_TEST_RECORD_MS, Math.round(performance.now() - startedAt));
                const blob = new Blob(chunks, { type: rec.mimeType || mimeType || 'audio/webm' });
                // The mic is done: release it BEFORE playback, so the test never
                // holds the microphone while you listen. Resources only — the
                // generation stays ours until the take is installed.
                releaseMicResources();
                if (durationMs < MIC_TEST_MIN_TAKE_MS || blob.size === 0) {
                    setMicTestPhase(micTake ? 'ready' : 'idle');
                    setMicTestNotice(`That was too short to play back — record for at least ${MIC_TEST_MIN_TAKE_MS / 1000} s.`);
                    return;
                }
                try {
                    const dctx = new AudioContext({ sampleRate: 48000 });
                    let buffer: AudioBuffer;
                    try {
                        buffer = await dctx.decodeAudioData(await blob.arrayBuffer());
                    } finally {
                        dctx.close().catch(() => { /* closed */ });
                    }
                    // A newer start/stop/section change while decoding bumped the
                    // generation and owns the state now.
                    if (stale()) return;
                    setMicTake({ buffer, durationMs: Math.round(buffer.duration * 1000), capture });
                    setMicTestPhase('ready');
                } catch (err) {
                    if (stale()) return;
                    console.error('[MicTest] decode failed:', err);
                    setMicTestPhase(micTake ? 'ready' : 'idle');
                    setMicTestNotice('Couldn’t decode the recording: ' + (err instanceof Error ? err.message : String(err)));
                }
            };
            micRecorderRef.current = rec;
            rec.start(250);
            micRecTimerRef.current = setTimeout(() => {
                micRecTimerRef.current = null;
                if (micRecorderRef.current === rec && rec.state === 'recording') { setMicTestPhase('stopping'); rec.stop(); }
            }, MIC_TEST_RECORD_MS);
            // Countdown on a timer, not rAF: rAF pauses whenever the window is
            // not being painted, and a frozen "6.0 s" over a recording that IS
            // running would be a lie.
            const tick = setInterval(() => {
                if (stale()) { clearInterval(tick); return; }
                setMicRecProgress(Math.min(1, (performance.now() - startedAt) / MIC_TEST_RECORD_MS));
            }, 100);
            micRecTickRef.current = tick;

            setMicTestPhase('recording');
            runMeter(analyser, micRecAnimRef, () => !stale());
        } catch (err) {
            console.error('Failed to start mic test:', err);
            stream?.getTracks().forEach(t => t.stop());
            if (!stale()) {
                micStreamRef.current = null;
                setMicTestPhase(micTake ? 'ready' : 'idle');
                setMicTestNotice('Couldn’t start the mic test: ' + (err instanceof Error ? err.message : String(err)));
            }
        }
    }, [releaseMicCapture, releaseMicResources, stopMicPlayback, micTake]);

    /** Stop a recording early: what was captured becomes the take (onstop
     *  discards it only if it is too short to play). A click during the
     *  recorder's flush — state already 'inactive', onstop still pending — is
     *  a no-op, NOT an abort: aborting there would throw the take away. */
    const finishMicRecording = useCallback(() => {
        // Flushing or decoding: the take is on its way — never abort it here.
        if (micTestPhaseRef.current === 'stopping') return;
        const rec = micRecorderRef.current;
        if (rec) {
            if (rec.state === 'recording') {
                if (micRecTimerRef.current) { clearTimeout(micRecTimerRef.current); micRecTimerRef.current = null; }
                setMicTestPhase('stopping');
                rec.stop();
            }
            return;
        }
        // Still starting (no recorder yet): abort.
        releaseMicCapture();
        setMicTestPhase(micTake ? 'ready' : 'idle');
    }, [releaseMicCapture, micTake]);

    // Capture-time settings (device, echo, AGC, browser NS via the mode)
    // changed while STARTING or RECORDING: restart the take in the new
    // configuration. A finished take is left alone — its capture settings are
    // shown under it.
    const micCaptureSigRef = useRef('');
    useEffect(() => {
        const sig = JSON.stringify([noiseMode, settings.inputDeviceId, settings.echoCancellation,
            settings.autoGainControl, settings.noiseSuppression]);
        const changed = micCaptureSigRef.current !== '' && sig !== micCaptureSigRef.current;
        micCaptureSigRef.current = sig;
        const p = micTestPhaseRef.current;
        if (changed && (p === 'starting' || p === 'recording')) void startMicRecording();
    }, [noiseMode, settings.inputDeviceId, settings.echoCancellation, settings.autoGainControl,
        settings.noiseSuppression, startMicRecording]);
    // Processing settings changed while PLAYING: rebuild the graph on the
    // running loop — the mode, and the DeepFilter post filter (a worker
    // constructor argument). Input Volume / Manual Gain adjust the live gain
    // stage below, no rebuild.
    const micPlaySigRef = useRef('');
    useEffect(() => {
        const sig = JSON.stringify([noiseMode, settings.deepFilterPostFilter]);
        const changed = micPlaySigRef.current !== '' && sig !== micPlaySigRef.current;
        micPlaySigRef.current = sig;
        if (changed && micTestPhaseRef.current === 'playing' && micPlayerRef.current) void buildPlaybackGraph(noiseMode);
    }, [noiseMode, settings.deepFilterPostFilter, buildPlaybackGraph]);
    useEffect(() => {
        micPlayGraphRef.current?.setGain(inputGain());
        const audio = micAudioRef.current;
        if (audio) {
            audio.volume = settings.outputVolume / 100;
            if ('setSinkId' in audio) {
                (audio as HTMLAudioElement & { setSinkId: (id: string) => Promise<void> })
                    .setSinkId(settings.outputDeviceId === 'default' ? '' : settings.outputDeviceId)
                    .catch(err => console.warn('[MicTest] setSinkId failed:', err));
            }
        }
    }, [settings.inputVolume, settings.manualGain, settings.autoGainControl, settings.outputVolume, settings.outputDeviceId]);

    // Appearance (theme/compact/animations/scale/contrast) is applied by
    // saveSettings itself and by the main.tsx bootstrap — no effect needed here.

    if (!isOpen) return null;

    const updateSetting = <K extends keyof Settings>(key: K, value: Settings[K]) => {
        const newSettings = { ...settings, [key]: value };
        setSettings(newSettings);
        saveSettings(newSettings);
    };

    const handleSaveProfile = async () => {
        setSaveStatus('saving');
        try {
            await updateProfile({ display_name: displayName });
            setSaveStatus('saved');
            setTimeout(() => setSaveStatus('idle'), 2000);
        } catch (e) {
            console.error('Failed to save profile:', e);
            setSaveStatus('error');
        }
    };

    const sections: Array<{ id: string; label: string; icon: IconName }> = [
        { id: 'account', label: 'My Account', icon: 'user' },
        { id: 'privacy', label: 'Privacy & Safety', icon: 'lock' },
        { id: 'appearance', label: 'Appearance', icon: 'palette' },
        { id: 'accessibility', label: 'Accessibility', icon: 'accessibility' },
        { id: 'notifications', label: 'Notifications', icon: 'bell' },
        { id: 'voice', label: 'Voice & Video', icon: 'mic' },
        { id: 'keybinds', label: 'Keybinds', icon: 'keyboard' },
        { id: 'language', label: 'Language', icon: 'globe' },
        { id: 'advanced', label: 'Advanced', icon: 'settings' },
    ];

    return (
        <div className="settings-modal-overlay" onClick={onClose}>
            <div className="settings-modal" onClick={e => e.stopPropagation()}>
                {/* Settings Sidebar */}
                <div className="settings-sidebar">
                    <div className="settings-nav">
                        <div className="settings-nav-section">
                            <div className="settings-nav-header">User Settings</div>
                            {sections.map(section => (
                                <button
                                    key={section.id}
                                    className={`settings-nav-item ${activeSection === section.id ? 'active' : ''}`}
                                    onClick={() => setActiveSection(section.id)}
                                >
                                    <span className="nav-icon"><Icon name={section.icon} /></span>
                                    {section.label}
                                </button>
                            ))}
                        </div>
                        <div className="settings-nav-divider" />
                        {onLogout && (
                            <button className="settings-nav-item logout" onClick={onLogout}>
                                <span className="nav-icon"><LogoutIcon /></span>
                                Log Out
                            </button>
                        )}
                    </div>
                </div>

                {/* Settings Content */}
                <div className="settings-content">
                    <div className="settings-header">
                        <h2>{sections.find(s => s.id === activeSection)?.label}</h2>
                        <button className="settings-close" onClick={onClose} aria-label="Close settings">
                            <span>ESC</span>
                            <CloseIcon />
                        </button>
                    </div>

                    <div className="settings-body">
                        {/* My Account */}
                        {activeSection === 'account' && (
                            <div className="settings-section">
                                <h3>My Account</h3>
                                <p className="settings-description">
                                    Manage your account settings and profile information.
                                </p>
                                <div className="settings-card">
                                    <div className="settings-option">
                                        <label>Username</label>
                                        <input
                                            type="text"
                                            value={username}
                                            disabled
                                            title="Username cannot be changed"
                                            placeholder="Username"
                                        />
                                        <span className="settings-hint">Username cannot be changed</span>
                                    </div>
                                    <div className="settings-option">
                                        <label>Display Name</label>
                                        <input
                                            type="text"
                                            value={displayName}
                                            onChange={(e) => setDisplayName(e.target.value)}
                                            placeholder="Your display name (nickname)"
                                            maxLength={32}
                                        />
                                        <span className="settings-hint">This is how others will see you</span>
                                    </div>
                                    <div className="settings-option">
                                        <label>Email</label>
                                        <input
                                            type="email"
                                            value={email}
                                            disabled={!emailEditing}
                                            onChange={(e) => setEmail(e.target.value)}
                                            placeholder="Add an email for account recovery"
                                        />
                                        <button
                                            className="secondary-btn"
                                            onClick={() => {
                                                if (!emailEditing) { setEmailEditing(true); setEmailStatus(null); return; }
                                                requestEmailChange(email.trim())
                                                    .then(msg => { setEmailStatus(msg); setEmailEditing(false); })
                                                    .catch(err => setEmailStatus(err instanceof Error ? err.message
                                                        : 'Could not send the verification email.'));
                                            }}
                                        >
                                            {emailEditing ? 'Send verification' : 'Change'}
                                        </button>
                                        {emailStatus && <span className="settings-hint">{emailStatus}</span>}
                                    </div>
                                    <div className="settings-actions">
                                        <button
                                            className="save-btn"
                                            onClick={handleSaveProfile}
                                            disabled={saveStatus === 'saving'}
                                        >
                                            {saveStatus === 'saving' ? 'Saving...' :
                                                saveStatus === 'saved' ? <><CheckIcon /> Saved!</> :
                                                    saveStatus === 'error' ? 'Error' : 'Save Changes'}
                                        </button>
                                    </div>
                                </div>

                                <h3>Password</h3>
                                <div className="settings-card">
                                    <p className="settings-hint">
                                        Changing your password keeps your message history and does not
                                        change your recovery code. You'll stay logged in on this device.
                                    </p>
                                    <form className="password-change-form" onSubmit={handleChangePassword} autoComplete="off">
                                        <input
                                            type="password"
                                            placeholder="Current password"
                                            value={pwCurrent}
                                            onChange={e => setPwCurrent(e.target.value)}
                                            autoComplete="current-password"
                                            required
                                        />
                                        <input
                                            type="password"
                                            placeholder="New password (min 8 chars)"
                                            value={pwNew}
                                            onChange={e => setPwNew(e.target.value)}
                                            autoComplete="new-password"
                                            required
                                        />
                                        <input
                                            type="password"
                                            placeholder="Confirm new password"
                                            value={pwConfirm}
                                            onChange={e => setPwConfirm(e.target.value)}
                                            autoComplete="new-password"
                                            required
                                        />
                                        <button type="submit" disabled={pwStatus === 'saving'}>
                                            {pwStatus === 'saving' ? 'Changing…'
                                                : pwStatus === 'saved' ? <>Password changed <CheckIcon /></>
                                                : 'Change Password'}
                                        </button>
                                        {pwStatus === 'error' && pwError && (
                                            <div className="password-change-error">{pwError}</div>
                                        )}
                                    </form>
                                </div>

                                <h3>Account Removal</h3>
                                <div className="settings-card danger">
                                    <p className="settings-hint">
                                        Deleting your account is irreversible: your profile is erased,
                                        every session is signed out, and your encrypted message history
                                        becomes permanently unreadable. Servers you own must be
                                        disbanded or transferred first.
                                    </p>
                                    {!deleteArmed ? (
                                        <button className="danger-btn" onClick={() => setDeleteArmed(true)}>
                                            Delete Account
                                        </button>
                                    ) : (
                                        <div className="delete-account-form">
                                            <input
                                                type="password"
                                                placeholder="Current password"
                                                value={deletePassword}
                                                onChange={e => setDeletePassword(e.target.value)}
                                                autoComplete="current-password"
                                            />
                                            <input
                                                type="text"
                                                placeholder={`Type "${username}" to confirm`}
                                                value={deleteConfirmName}
                                                onChange={e => setDeleteConfirmName(e.target.value)}
                                                autoComplete="off"
                                            />
                                            {deleteStatus === 'error' && deleteError && (
                                                <div className="password-change-error">{deleteError}</div>
                                            )}
                                            <div className="settings-actions">
                                                <button
                                                    className="secondary-btn"
                                                    onClick={() => {
                                                        setDeleteArmed(false);
                                                        setDeletePassword('');
                                                        setDeleteConfirmName('');
                                                        setDeleteStatus('idle');
                                                    }}
                                                >
                                                    Cancel
                                                </button>
                                                <button
                                                    className="danger-btn"
                                                    disabled={deleteStatus === 'working' || !deletePassword || !deleteConfirmName}
                                                    onClick={handleDeleteAccount}
                                                >
                                                    {deleteStatus === 'working' ? 'Deleting…' : 'Permanently delete my account'}
                                                </button>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>
                        )}

                        {/* Privacy & Safety */}
                        {activeSection === 'privacy' && (
                            <div className="settings-section">
                                <h3>Privacy & Safety</h3>
                                <p className="settings-description">
                                    Control your privacy and safety settings.
                                </p>
                                <div className="settings-card">
                                    <div className="settings-option">
                                        <div className="option-info">
                                            <label>Allow DMs from server members</label>
                                            <span className="option-hint">
                                                When off, only your friends — and anyone you have messaged
                                                yourself — can message you or send you files. Enforced by the
                                                server, and it applies to existing conversations too. It does
                                                not limit who you can message.
                                            </span>
                                        </div>
                                        <input
                                            type="checkbox"
                                            checked={privacy?.allowDMs ?? true}
                                            disabled={!privacy}
                                            onChange={(e) => setPrivacyFlag('allowDMs', e.target.checked)}
                                        />
                                    </div>
                                    <div className="settings-option">
                                        <div className="option-info">
                                            <label>Show online status</label>
                                            <span className="option-hint">
                                                When off, you appear offline to everyone (including friends).
                                                Joining a voice channel still shows you in that channel.
                                            </span>
                                        </div>
                                        <input
                                            type="checkbox"
                                            checked={privacy?.showOnline ?? true}
                                            disabled={!privacy}
                                            onChange={(e) => setPrivacyFlag('showOnline', e.target.checked)}
                                        />
                                    </div>
                                    <div className="settings-option">
                                        <div className="option-info">
                                            <label>Hidden messages</label>
                                            <span className="option-hint">
                                                Messages you removed with "Delete for Me" are hidden only for
                                                you, on this device. Restore brings all of them back. ({hiddenCount}
                                                {' '}hidden)
                                            </span>
                                        </div>
                                        <button
                                            className="secondary-btn"
                                            disabled={hiddenCount === 0}
                                            onClick={() => {
                                                const restored = clearAllHiddenMessages();
                                                setHiddenCount(0);
                                                if (restored > 0) alert(`${restored} hidden message${restored !== 1 ? 's' : ''} restored.`);
                                            }}
                                        >
                                            Restore all
                                        </button>
                                    </div>
                                </div>

                                <h3>Call Encryption</h3>
                                <div className="settings-card">
                                    <div className="settings-option">
                                        <div className="option-info">
                                            <label>Require encryption for calls</label>
                                            <span className="option-hint">
                                                Only exchange voice, video and screen share with people whose media is
                                                end-to-end encrypted. Anyone who can’t be encrypted is muted instead of
                                                relayed through the server. The desktop app supports this; Safari, iOS
                                                and Firefox participants will be blocked while it’s on.
                                            </span>
                                        </div>
                                        <input
                                            type="checkbox"
                                            checked={settings.requireMediaE2ee}
                                            onChange={(e) => updateSetting('requireMediaE2ee', e.target.checked)}
                                        />
                                    </div>
                                    <div className="settings-option">
                                        <div className="option-info">
                                            <label>Hide my IP in calls (relay only)</label>
                                            <span className="option-hint">
                                                Route your voice, video and screen share through the server's TURN relay
                                                so other participants never see your IP address. Uses more relay bandwidth
                                                and may reduce quality; has no effect if no relay is available, and the
                                                server operator can still see the relayed connections.
                                            </span>
                                        </div>
                                        <input
                                            type="checkbox"
                                            checked={settings.forceRelayOnly}
                                            onChange={(e) => updateSetting('forceRelayOnly', e.target.checked)}
                                        />
                                    </div>
                                </div>

                                <h3>Screen control</h3>
                                <div className="settings-card">
                                    <p className="settings-hint">
                                        When you let someone control your shared screen, these stop it instantly.
                                        The Stop button on the on-screen banner always works too.
                                    </p>
                                    <div className="settings-option">
                                        <div className="option-info">
                                            <label>Kill-switch hotkey</label>
                                            <span className="option-hint">
                                                Press this anytime to take back control — it works even while a
                                                controlled game has focus{isTauri() ? '' : ' (desktop app only)'}. Esc also
                                                works whenever the Puca window is focused.
                                            </span>
                                        </div>
                                        {bindControl('remoteControlKillKey', 'Click, then press the key combo you want')}
                                    </div>
                                    <div className="settings-option">
                                        <div className="option-info">
                                            <label>Stop when I touch my mouse or keyboard</label>
                                            <span className="option-hint">
                                                Any physical input on your machine ends control immediately. Leave this
                                                OFF if you want a friend to keep playing while you're away — otherwise
                                                a stray mouse nudge kicks them out. Off by default.
                                            </span>
                                        </div>
                                        <input
                                            type="checkbox"
                                            checked={settings.remoteControlAnyInputKill}
                                            onChange={(e) => updateSetting('remoteControlAnyInputKill', e.target.checked)}
                                        />
                                    </div>
                                </div>

                                <h3>Blocked Users</h3>
                                <div className="settings-card">
                                    {blockedError && (
                                        <p className="settings-hint" style={{ color: 'var(--danger, #f38ba8)' }}>
                                            <WarningIcon /> {blockedError}
                                        </p>
                                    )}
                                    {blocked === null ? (
                                        !blockedError && <p className="settings-hint">Loading…</p>
                                    ) : blocked.length === 0 ? (
                                        <p className="settings-hint">
                                            You haven't blocked anyone. Block someone from their
                                            right-click menu; blocked users can't message you.
                                        </p>
                                    ) : (
                                        blocked.map(b => (
                                            <div className="settings-option" key={b.user_id}>
                                                <div className="option-info">
                                                    <label>{b.username}</label>
                                                    <span className="option-hint">
                                                        Blocked {new Date(parseServerTimestamp(b.blocked_at)).toLocaleDateString()}
                                                    </span>
                                                </div>
                                                <button
                                                    className="secondary-btn"
                                                    disabled={unblocking === b.user_id}
                                                    onClick={() => handleUnblock(b.user_id)}
                                                >
                                                    {unblocking === b.user_id ? 'Unblocking…' : 'Unblock'}
                                                </button>
                                            </div>
                                        ))
                                    )}
                                </div>
                            </div>
                        )}

                        {/* Appearance */}
                        {activeSection === 'appearance' && (
                            <div className="settings-section">
                                <h3>Appearance</h3>
                                <p className="settings-description">
                                    Customize how Puca looks.
                                </p>
                                <div className="settings-card">
                                    <div className="settings-option theme-picker-option">
                                        <div className="option-info">
                                            <label>Theme</label>
                                            <span className="option-hint">
                                                Colour themes tint the whole app — every surface, not just accents.
                                            </span>
                                        </div>
                                        <div className="theme-picker" role="radiogroup" aria-label="Theme">
                                            {THEMES.map(t => (
                                                <button
                                                    key={t.id}
                                                    role="radio"
                                                    aria-checked={settings.theme === t.id}
                                                    className={`theme-swatch ${settings.theme === t.id ? 'selected' : ''}`}
                                                    title={t.label}
                                                    onClick={() => updateSetting('theme', t.id)}
                                                >
                                                    <span className="theme-swatch-chip" style={{ background: t.swatch }}>
                                                        {settings.theme === t.id ? <CheckIcon /> : null}
                                                    </span>
                                                    <span className="theme-swatch-label">{t.label}</span>
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                    <div className="settings-option">
                                        <div className="option-info">
                                            <label htmlFor="icon-style-select">Icon Style</label>
                                            <span className="option-hint">
                                                Classic restores the emoji the icons replaced. They come from your
                                                system's font, so they look different on each platform and keep
                                                their own colours whichever theme you pick.
                                            </span>
                                        </div>
                                        <select
                                            id="icon-style-select"
                                            value={settings.iconStyle}
                                            onChange={(e) => updateSetting('iconStyle', e.target.value as 'modern' | 'classic')}
                                        >
                                            <option value="modern">Modern (drawn icons)</option>
                                            <option value="classic">Classic (emoji)</option>
                                        </select>
                                    </div>
                                    <div className="settings-option">
                                        <div className="option-info">
                                            <label>Compact Mode</label>
                                            <span className="option-hint">Reduce spacing between messages</span>
                                        </div>
                                        <input
                                            type="checkbox"
                                            checked={settings.compactMode}
                                            onChange={(e) => updateSetting('compactMode', e.target.checked)}
                                        />
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* Accessibility */}
                        {activeSection === 'accessibility' && (
                            <div className="settings-section">
                                <h3>Accessibility</h3>
                                <p className="settings-description">
                                    Make Puca easier to see, read and use.
                                </p>
                                <div className="settings-card">
                                    <div className="settings-option">
                                        <div className="option-info">
                                            <label>Text Size</label>
                                            <span className="option-hint">
                                                Scales all text and most controls. 100% is the default.
                                            </span>
                                        </div>
                                        <div className="slider-row">
                                            <input
                                                type="range"
                                                min="80"
                                                max="130"
                                                step="5"
                                                value={settings.fontScale}
                                                onChange={(e) => updateSetting('fontScale', parseInt(e.target.value))}
                                            />
                                            <span className="volume-value">{settings.fontScale}%</span>
                                        </div>
                                    </div>
                                    <div className="settings-option">
                                        <div className="option-info">
                                            <label>High Contrast</label>
                                            <span className="option-hint">
                                                Stronger text and border contrast on top of any theme.
                                            </span>
                                        </div>
                                        <input
                                            type="checkbox"
                                            checked={settings.highContrast}
                                            onChange={(e) => updateSetting('highContrast', e.target.checked)}
                                        />
                                    </div>
                                    <div className="settings-option">
                                        <div className="option-info">
                                            <label>Underline Links</label>
                                            <span className="option-hint">
                                                Always underline links instead of relying on colour alone.
                                            </span>
                                        </div>
                                        <input
                                            type="checkbox"
                                            checked={settings.underlineLinks}
                                            onChange={(e) => updateSetting('underlineLinks', e.target.checked)}
                                        />
                                    </div>
                                    <div className="settings-option">
                                        <div className="option-info">
                                            <label>Enable Animations</label>
                                            <span className="option-hint">
                                                Turn off to stop all animated effects and transitions.
                                                Puca also honours your system's reduced-motion setting.
                                            </span>
                                        </div>
                                        <input
                                            type="checkbox"
                                            checked={settings.animationsEnabled}
                                            onChange={(e) => updateSetting('animationsEnabled', e.target.checked)}
                                        />
                                    </div>
                                    <div className="settings-option">
                                        <div className="option-info">
                                            <label>Spoken Announcements</label>
                                            <span className="option-hint">
                                                Voice-channel join/leave announcements via your device's
                                                text-to-speech — the toggle lives in Notifications → Speak Join/Leave.
                                            </span>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* Notifications */}
                        {activeSection === 'notifications' && (
                            <div className="settings-section">
                                <h3>Notifications</h3>
                                <p className="settings-description">
                                    Configure your notification preferences.
                                </p>
                                <div className="settings-card">
                                    {!isMobile() && (
                                    <div className="settings-option">
                                        <div className="option-info">
                                            <label>Enable Desktop Notifications</label>
                                            <span className="option-hint">Show system notifications for new messages</span>
                                        </div>
                                        <input
                                            type="checkbox"
                                            checked={settings.desktopNotifications}
                                            onChange={(e) => {
                                                if (!e.target.checked) {
                                                    updateSetting('desktopNotifications', false);
                                                    return;
                                                }
                                                // On desktop ask the OS through Tauri, NOT the webview.
                                                // WebView2 can refuse or ignore Notification.requestPermission,
                                                // which left this toggle impossible to switch on — and with it
                                                // off, nothing else in the notification path ever runs.
                                                if (isTauri()) {
                                                    void (async () => {
                                                        try {
                                                            const { isPermissionGranted, requestPermission } =
                                                                await import('@tauri-apps/plugin-notification');
                                                            const ok = (await isPermissionGranted())
                                                                || (await requestPermission()) === 'granted';
                                                            updateSetting('desktopNotifications', ok);
                                                        } catch {
                                                            // Plugin unavailable: still let them enable it
                                                            // rather than silently refusing.
                                                            updateSetting('desktopNotifications', true);
                                                        }
                                                    })();
                                                    return;
                                                }
                                                Notification.requestPermission().then(perm => {
                                                    updateSetting('desktopNotifications', perm === 'granted');
                                                });
                                            }}
                                        />
                                    </div>
                                    )}
                                    {isAndroidApp() && (
                                    <div className="settings-option">
                                        <div className="option-info">
                                            <label>Notifications</label>
                                            <span className="option-hint">
                                                Notify for messages arriving while Puca is open in
                                                the background. Fired by this phone's own connection —
                                                nothing arrives once the app is closed.
                                            </span>
                                        </div>
                                        <input
                                            type="checkbox"
                                            checked={settings.mobileNotifications}
                                            onChange={(e) => {
                                                if (!e.target.checked) {
                                                    // ONE save carrying BOTH keys (updateSetting
                                                    // spreads the stale closure, so two calls drop
                                                    // one). Background delivery exists only to
                                                    // deliver notifications, and its checkbox goes
                                                    // disabled the moment this is off — left ON, the
                                                    // service kept running with no control able to
                                                    // stop it.
                                                    const next = {
                                                        ...settings,
                                                        mobileNotifications: false,
                                                        mobileBackgroundDelivery: false,
                                                    };
                                                    setSettings(next);
                                                    saveSettings(next);
                                                    return;
                                                }
                                                // The toggle records INTENT; the OS grant is shown
                                                // separately (AndroidNotificationHealth below).
                                                // Writing the grant back here was the trap: under
                                                // Android's two-denial lockout the request silently
                                                // returns false, so trying to turn notifications ON
                                                // wrote the setting OFF — which also disabled the
                                                // boot-time re-ask and read as a deliberate choice
                                                // of silence. Unrecoverable from this UI, and the
                                                // health row (which says how to actually fix it)
                                                // only renders while the intent is on.
                                                updateSetting('mobileNotifications', true);
                                                void requestMobileNotificationPermission().then(() => {
                                                    window.dispatchEvent(new CustomEvent('sovereign-notif-health-refresh'));
                                                });
                                            }}
                                        />
                                    </div>
                                    )}
                                    {isAndroidApp() && (
                                    <AndroidNotificationHealth
                                        wantsNotifications={settings.mobileNotifications}
                                        backgroundDelivery={settings.mobileBackgroundDelivery}
                                    />
                                    )}
                                    {isAndroidApp() && (
                                    <div className="settings-option">
                                        <div className="option-info">
                                            <label>Deliver in the background</label>
                                            <span className="option-hint">
                                                Keep Puca's own connection alive after you leave
                                                the app, so messages still come through. Shows a
                                                "Connected" notification and uses some battery. Needs
                                                the current APK. Everything you receive travels over
                                                this connection to your server — if your server has
                                                wake signals set up, a content-free ping (it carries
                                                the constant "1", nothing else) revives the connection
                                                when the phone dozes off.
                                                <strong> Turning this off means no notifications at
                                                all while you are outside the app</strong> — this
                                                connection is what delivers them.
                                            </span>
                                        </div>
                                        <input
                                            type="checkbox"
                                            checked={settings.mobileBackgroundDelivery}
                                            onChange={(e) => updateSetting('mobileBackgroundDelivery', e.target.checked)}
                                            disabled={!settings.mobileNotifications}
                                        />
                                    </div>
                                    )}
                                    {isAndroidApp() && (
                                    <div className="settings-option">
                                        <div className="option-info">
                                            <label>Location reminders (this phone)</label>
                                            <span className="option-hint">
                                                Remind about a task when this phone arrives at a place
                                                you save on it (the map-pin button on a task). Places and
                                                coordinates <strong>stay on this device</strong> — nothing
                                                is uploaded or synced, and the reminder never names the
                                                task or the place. Needs precise location set to
                                                "Allow all the time" and location on; a quiet "Location
                                                reminders active" notification shows while this phone
                                                watches, and Android will periodically note that
                                                Puca used location in the background. Needs the
                                                current APK.
                                            </span>
                                        </div>
                                        <input
                                            type="checkbox"
                                            checked={settings.locationReminders}
                                            disabled={!settings.mobileNotifications}
                                            onChange={(e) => {
                                                // Records INTENT, like the notifications toggle
                                                // above: the OS grants are asked for here but never
                                                // written back — under Android's silent denial
                                                // lockout that write-back turns "trying to enable"
                                                // into "stored off", unrecoverable from this UI.
                                                updateSetting('locationReminders', e.target.checked);
                                                if (e.target.checked) {
                                                    // Two-step by Android's rule: foreground first;
                                                    // background is a separate ask that bounces
                                                    // through the system settings page on 11+.
                                                    void (async () => {
                                                        const fg = await requestForegroundLocation();
                                                        if (fg) await requestBackgroundLocation();
                                                        // FORCED: the settingsChanged listener already
                                                        // synced this exact fence set while the
                                                        // permission dialog was still up, so a plain
                                                        // sync would dedupe to nothing — and the
                                                        // service would keep running under its
                                                        // pre-grant FGS type with no location watch.
                                                        void syncTaskPlacesToNative({ force: true });
                                                    })();
                                                }
                                                // The settingsChanged listener (main.tsx) reconciles
                                                // the native fence set for the off path too.
                                            }}
                                        />
                                    </div>
                                    )}
                                    {/* Visible whenever places EXIST, not only while the
                                        toggle is on: turning the feature off must never
                                        hide the only control that deletes its data. */}
                                    {isAndroidApp() && (settings.locationReminders || listPlaces().length > 0) && (
                                    <div className="settings-option">
                                        <div className="option-info">
                                            <label>Saved places on this device</label>
                                            <span className="option-hint">
                                                The one-tap answer to "what does this phone know about
                                                where I go": deletes every saved place and place
                                                reminder from this device and stops watching.
                                            </span>
                                        </div>
                                        <button
                                            className="secondary-btn"
                                            onClick={() => {
                                                const n = listPlaces().length;
                                                if (n === 0) { alert('No places are saved on this device.'); return; }
                                                if (confirm(`Delete all ${n} saved place${n === 1 ? '' : 's'} and their reminders from this phone?`)) {
                                                    clearAllPlaces();
                                                }
                                            }}
                                        >
                                            Delete all
                                        </button>
                                    </div>
                                    )}
                                    {isAndroidApp() && (
                                    <div className="settings-option">
                                        <div className="option-info">
                                            <label>Recent chats on the app icon</label>
                                            <span className="option-hint">
                                                Long-pressing Puca's icon lists your most recent
                                                conversations. Their names are visible on the launcher
                                                without opening the app — turn this off to show only
                                                the fixed shortcuts. Needs the current APK.
                                            </span>
                                        </div>
                                        <input
                                            type="checkbox"
                                            checked={settings.launcherConversationShortcuts}
                                            onChange={(e) => updateSetting('launcherConversationShortcuts', e.target.checked)}
                                        />
                                    </div>
                                    )}
                                    <div className="settings-option">
                                        <div className="option-info">
                                            <label>In-app message pop-ups</label>
                                            <span className="option-hint">
                                                Show a small card for messages arriving in other
                                                channels or DMs while you're using the app
                                            </span>
                                        </div>
                                        <input
                                            type="checkbox"
                                            checked={settings.messageToasts}
                                            onChange={(e) => updateSetting('messageToasts', e.target.checked)}
                                        />
                                    </div>
                                    {(isTauri() || isAndroidApp()) && (
                                        <div className="settings-option">
                                            <div className="option-info">
                                                <label>Test notification</label>
                                                <span className="option-hint">
                                                    Fires one now, so you can check notifications work
                                                    without needing someone to message you. Notifications
                                                    only arrive while Puca is running{isTauri()
                                                        ? ' — see Advanced → Desktop App for tray behaviour.'
                                                        : '.'}
                                                </span>
                                            </div>
                                            <button
                                                className="secondary-btn"
                                                onClick={() => void sendTestNotification().then(r => {
                                                    if (!r.ok) {
                                                        alert(`Test notification failed: ${r.reason ?? 'unknown'}. `
                                                            + (isMobile()
                                                                ? 'Check Android notification settings for Púca.'
                                                                : 'Check Windows notification settings for Púca.'));
                                                    }
                                                })}
                                            >
                                                Send test
                                            </button>
                                        </div>
                                    )}
                                    <div className="settings-option">
                                        <div className="option-info">
                                            <label>Enable Sounds</label>
                                            <span className="option-hint">Play sounds for notifications</span>
                                        </div>
                                        <input
                                            type="checkbox"
                                            checked={settings.soundsEnabled}
                                            onChange={(e) => updateSetting('soundsEnabled', e.target.checked)}
                                        />
                                    </div>
                                </div>

                                <h3>Sound Settings</h3>
                                <div className="settings-card">
                                    <div className="settings-option">
                                        <label>Message Sound</label>
                                        <input
                                            type="checkbox"
                                            checked={settings.messageSound}
                                            onChange={(e) => updateSetting('messageSound', e.target.checked)}
                                            disabled={!settings.soundsEnabled}
                                        />
                                    </div>
                                    <div className="settings-option">
                                        <label>Join/Leave Sounds</label>
                                        <input
                                            type="checkbox"
                                            checked={settings.joinLeaveSound}
                                            onChange={(e) => updateSetting('joinLeaveSound', e.target.checked)}
                                            disabled={!settings.soundsEnabled}
                                        />
                                    </div>
                                    <div className="settings-option">
                                        <label title="Play clips other users uploaded as their join/leave sound. Off = the standard chime instead.">Custom User Sounds</label>
                                        <input
                                            type="checkbox"
                                            checked={settings.customJoinLeaveSounds}
                                            onChange={(e) => updateSetting('customJoinLeaveSounds', e.target.checked)}
                                            disabled={!settings.soundsEnabled || !settings.joinLeaveSound}
                                        />
                                    </div>
                                    <div className="settings-option">
                                        <label>Mention Sound</label>
                                        <input
                                            type="checkbox"
                                            checked={settings.mentionSound}
                                            onChange={(e) => updateSetting('mentionSound', e.target.checked)}
                                            disabled={!settings.soundsEnabled}
                                        />
                                    </div>
                                    <div className="settings-option">
                                        <div className="option-info">
                                            <label>Streaming Sounds</label>
                                            <span className="option-hint">Distinct sounds when someone starts or stops streaming</span>
                                        </div>
                                        <input
                                            type="checkbox"
                                            checked={settings.streamSound}
                                            onChange={(e) => updateSetting('streamSound', e.target.checked)}
                                            disabled={!settings.soundsEnabled}
                                        />
                                    </div>
                                    <div className="settings-option">
                                        <div className="option-info">
                                            <label>Speak Join/Leave (TTS)</label>
                                            <span className="option-hint">Announce “X joined/left the channel” aloud using your device's voice</span>
                                        </div>
                                        <input
                                            type="checkbox"
                                            checked={settings.voiceTTS}
                                            onChange={(e) => updateSetting('voiceTTS', e.target.checked)}
                                            disabled={!settings.soundsEnabled}
                                        />
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* Voice & Video */}
                        {activeSection === 'voice' && (
                            <div className="settings-section">
                                <h3>Voice Settings</h3>
                                <p className="settings-description">
                                    Adjust your voice and video settings.
                                </p>
                                <div className="settings-card">
                                    <div className="settings-option">
                                        <label>Input Device</label>
                                        <select
                                            value={settings.inputDeviceId}
                                            onChange={(e) => updateSetting('inputDeviceId', e.target.value)}
                                        >
                                            <option value="default">Default</option>
                                            {audioDevices.inputs.map(device => (
                                                <option key={device.deviceId} value={device.deviceId}>
                                                    {device.label || `Microphone ${device.deviceId.slice(0, 8)}`}
                                                </option>
                                            ))}
                                        </select>
                                    </div>
                                    <div className="settings-option">
                                        <label>Output Device</label>
                                        <select
                                            value={settings.outputDeviceId}
                                            onChange={(e) => updateSetting('outputDeviceId', e.target.value)}
                                        >
                                            <option value="default">Default</option>
                                            {audioDevices.outputs.map(device => (
                                                <option key={device.deviceId} value={device.deviceId}>
                                                    {device.label || `Speaker ${device.deviceId.slice(0, 8)}`}
                                                </option>
                                            ))}
                                        </select>
                                    </div>
                                    <div className="settings-option">
                                        <label>Input Volume</label>
                                        <div className="slider-row">
                                            <input
                                                type="range"
                                                min="0"
                                                max="200"
                                                value={settings.inputVolume}
                                                onChange={(e) => updateSetting('inputVolume', parseInt(e.target.value))}
                                            />
                                            <span className="volume-value">{settings.inputVolume}%</span>
                                        </div>
                                    </div>
                                    <div className="settings-option">
                                        <label>Output Volume</label>
                                        <div className="slider-row">
                                            <input
                                                type="range"
                                                min="0"
                                                max="100"
                                                value={settings.outputVolume}
                                                onChange={(e) => updateSetting('outputVolume', parseInt(e.target.value))}
                                            />
                                            <span className="volume-value">{settings.outputVolume}%</span>
                                        </div>
                                    </div>
                                </div>

                                <h3>Mic Test</h3>
                                <div className="settings-card">
                                    <p className="settings-hint" style={{ marginBottom: '12px' }}>
                                        Record a few seconds, and it loops back through the noise-suppression
                                        mode and input volume below — change them while it plays and hear the
                                        difference on the same take. Nothing plays while you record.
                                    </p>
                                    <div className="mic-test-row">
                                        <button
                                            className={`secondary-btn ${(micTestPhase === 'starting' || micTestPhase === 'recording' || micTestPhase === 'stopping') ? 'active' : ''}`}
                                            onClick={() => (micTestPhase === 'starting' || micTestPhase === 'recording' || micTestPhase === 'stopping')
                                                ? finishMicRecording()
                                                : void startMicRecording()}
                                            aria-busy={micTestPhase === 'starting' || micTestPhase === 'stopping'}
                                        >
                                            {(micTestPhase === 'recording' || micTestPhase === 'stopping') ? <><StopIcon /> Stop</>
                                                : micTestPhase === 'starting' ? <><StopIcon /> Starting…</>
                                                : micTake ? <><RecordIcon /> Record again</>
                                                : <><RecordIcon /> Record {MIC_TEST_RECORD_MS / 1000} s</>}
                                        </button>
                                        <div
                                            className="mic-level-container"
                                            role="progressbar"
                                            aria-label={micTestPhase === 'recording' ? 'Recording time left' : micTestPhase === 'playing' ? 'Playback level' : 'Microphone level'}
                                            aria-valuemin={0}
                                            aria-valuemax={100}
                                            aria-valuenow={micTestPhase === 'recording' ? Math.round((1 - micRecProgress) * 100) : Math.round(micLevel)}
                                        >
                                            <div
                                                className="mic-level-bar"
                                                style={{ width: `${micLevel}%` }}
                                            />
                                        </div>
                                        <span className="mic-level-value">
                                            {micTestPhase === 'recording'
                                                ? `${Math.max(0, (MIC_TEST_RECORD_MS / 1000) * (1 - micRecProgress)).toFixed(1)} s`
                                                : `${Math.round(micLevel)}%`}
                                        </span>
                                    </div>
                                    {micTestPhase === 'starting' && (
                                        <p className="settings-hint" style={{ marginTop: '8px' }} role="status">
                                            Waiting for the microphone…
                                        </p>
                                    )}
                                    {micTestPhase === 'recording' && (
                                        <p className="settings-hint" style={{ marginTop: '8px', color: '#a6e3a1' }} role="status">
                                            <MicIcon /> Recording — speak normally. It stops by itself.
                                        </p>
                                    )}
                                    {micTake && (
                                        <>
                                            <div className="mic-test-row" style={{ marginTop: '10px' }}>
                                                <button
                                                    className={`secondary-btn ${micTestPhase === 'playing' ? 'active' : ''}`}
                                                    onClick={() => {
                                                        if (micTestPhase === 'playing') { stopMicPlayback(); setMicTestPhase('ready'); }
                                                        else void playMicTake();
                                                    }}
                                                    disabled={micTestPhase === 'starting' || micTestPhase === 'recording' || micTestPhase === 'stopping'}
                                                >
                                                    {micTestPhase === 'playing' ? <><StopIcon /> Stop</> : <><PlayIcon /> Play</>}
                                                </button>
                                                <div
                                                    className="mic-level-container mic-playback-progress"
                                                    role="progressbar"
                                                    aria-label="Position in the loop"
                                                    aria-valuemin={0}
                                                    aria-valuemax={100}
                                                    aria-valuenow={Math.round(micPlayProgress * 100)}
                                                >
                                                    <div
                                                        className="mic-level-bar"
                                                        style={{ width: `${micPlayProgress * 100}%` }}
                                                    />
                                                </div>
                                                <span className="mic-level-value">{(micTake.durationMs / 1000).toFixed(1)} s</span>
                                            </div>
                                            {micTestPhase === 'playing' && !micPlayMode && (
                                                <p className="settings-hint" style={{ marginTop: '8px' }} role="status">
                                                    Setting up {labelForMode(noiseMode)}…
                                                    {noiseMode === 'deepfilter' && ' (the first use downloads ~14 MB, so this can take a moment)'}
                                                </p>
                                            )}
                                            {micTestPhase === 'playing' && micPlayMode && (
                                                <p className="settings-hint" style={{ marginTop: '8px', color: '#a6e3a1' }}>
                                                    <HeadphonesIcon /> Looping through <strong>{labelForMode(micPlayMode)}</strong> at
                                                    your input volume
                                                    {(micPlayMode === 'standard' || micPlayMode === 'off') && (
                                                        <> (no extra processing — {micPlayMode === 'standard' ? 'Standard’s' : 'this mode’s'} filtering happens at capture)</>
                                                    )}
                                                    {micTakeCaptureMatchesNow ? ' — this is what others would hear.' : '.'}
                                                    {' '}Change the mode or Input Volume below and listen.
                                                </p>
                                            )}
                                            <p className="settings-hint" style={{ marginTop: '6px' }}>
                                                Captured with echo cancellation <strong>{micTake.capture.echo ? 'on' : 'off'}</strong>,
                                                auto gain <strong>{micTake.capture.agc ? 'on' : 'off'}</strong>,
                                                browser noise suppression <strong>{micTake.capture.browserNs ? 'on' : 'off'}</strong>
                                                {' '}— those are applied inside the microphone capture, so record again to hear them change.
                                                {!micTakeCaptureMatchesNow && (
                                                    <> <strong>They differ from your current settings — record again for an exact preview.</strong></>
                                                )}
                                            </p>
                                        </>
                                    )}
                                    {micTestNotice && (
                                        <p className="settings-hint" style={{ marginTop: '8px' }} role="status">
                                            {micTestNotice}
                                        </p>
                                    )}
                                </div>

                                <h3>Voice Processing</h3>
                                <p className="settings-description">
                                    Applied to your microphone in real calls and in the mic test above.
                                    Changes take effect live, even mid-call.
                                </p>
                                <div className="settings-card">
                                    <div className="settings-option">
                                        <div className="option-info">
                                            <label>Noise Suppression Mode</label>
                                            <span className="option-hint">
                                                What removes background noise from your voice. <strong>Standard</strong> is
                                                the browser's built-in filter (free, works everywhere).
                                                <strong> RNNoise</strong> is a small ML model — better on keyboards, fans
                                                and background voices, ~10 ms of delay. <strong>DeepFilter</strong> is
                                                the heaviest ML model — best quality, real CPU cost, ~60 ms of delay;
                                                it appears after enabling it under Advanced → Experimental. The same
                                                picker sits in the voice panel; either changes it live, mid-call.
                                            </span>
                                        </div>
                                        <select
                                            value={noiseMode}
                                            onChange={(e) => changeNoiseModeLive(e.target.value as NoiseSuppressionMode)}
                                            aria-label="Noise suppression mode"
                                        >
                                            <option value="off">{NOISE_MODE_LABELS.off}</option>
                                            <option value="standard">{NOISE_MODE_LABELS.standard}</option>
                                            <option value="rnnoise">{NOISE_MODE_LABELS.rnnoise}</option>
                                            {/* Same gate + phantom-value rule as the voice panel: shown while
                                                the Experimental toggle is on, and while ACTIVE with it off so the
                                                select never shows a value it has no option for. */}
                                            {(settings.experimentalDeepFilter || noiseMode === 'deepfilter') && (
                                                <option value="deepfilter">{NOISE_MODE_LABELS.deepfilter}</option>
                                            )}
                                        </select>
                                    </div>
                                    <div className="settings-option">
                                        <div className="option-info">
                                            <label>Browser Noise Suppression</label>
                                            <span className="option-hint">
                                                The browser's built-in noise removal (fans, keyboard clicks, ambient
                                                sounds). Used only while the mode above is Standard — the ML modes
                                                replace it with their own filtering.
                                            </span>
                                        </div>
                                        <input
                                            type="checkbox"
                                            checked={settings.noiseSuppression}
                                            onChange={(e) => updateSetting('noiseSuppression', e.target.checked)}
                                        />
                                    </div>
                                    <div className="settings-option">
                                        <div className="option-info">
                                            <label>Echo Cancellation</label>
                                            <span className="option-hint">
                                                Removes audio feedback when your speakers play back into your microphone,
                                                preventing others from hearing themselves echo.
                                            </span>
                                        </div>
                                        <input
                                            type="checkbox"
                                            checked={settings.echoCancellation}
                                            onChange={(e) => updateSetting('echoCancellation', e.target.checked)}
                                        />
                                    </div>
                                    <div className="settings-option">
                                        <div className="option-info">
                                            <label>Auto Gain Control</label>
                                            <span className="option-hint">
                                                Automatically adjusts your microphone volume - increases gain when
                                                you're quiet, decreases when you're loud. Disable for manual control.
                                            </span>
                                        </div>
                                        <input
                                            type="checkbox"
                                            checked={settings.autoGainControl}
                                            onChange={(e) => updateSetting('autoGainControl', e.target.checked)}
                                        />
                                    </div>
                                    {!settings.autoGainControl && (
                                        <div className="settings-option manual-gain-section">
                                            <div className="option-info">
                                                <label>Manual Gain</label>
                                                <span className="option-hint">
                                                    Adjust your microphone amplification manually. Use the mic test above
                                                    to find the right level.
                                                </span>
                                            </div>
                                            <div className="slider-row">
                                                <input
                                                    type="range"
                                                    min="0"
                                                    max="200"
                                                    value={settings.manualGain}
                                                    onChange={(e) => updateSetting('manualGain', parseInt(e.target.value))}
                                                />
                                                <span className="volume-value">{settings.manualGain}%</span>
                                            </div>
                                        </div>
                                    )}
                                </div>

                                <h3>Input Mode</h3>
                                <div className="settings-card">
                                    <div className="settings-option">
                                        <div className="option-info">
                                            <label>Input Mode</label>
                                            <span className="option-hint">
                                                Voice activity transmits whenever you speak. Push to talk
                                                transmits only while you hold the key; push to mute is the
                                                inverse — you transmit until you hold the key. The mute
                                                button always wins. On the desktop app the keys work
                                                system-wide during a call — even while a game has focus;
                                                in the browser they work while Puca is focused.
                                            </span>
                                        </div>
                                        <select
                                            value={settings.voiceInputMode}
                                            onChange={(e) => updateSetting('voiceInputMode',
                                                e.target.value as Settings['voiceInputMode'])}
                                        >
                                            <option value="open">Voice activity</option>
                                            <option value="pushToTalk">Push to talk</option>
                                            <option value="pushToMute">Push to mute</option>
                                        </select>
                                    </div>
                                    {settings.voiceInputMode === 'pushToTalk' && (
                                        <div className="settings-option">
                                            <label>Push to Talk Key</label>
                                            {bindControl('pttBinding', 'Click, then press the key you want to hold')}
                                        </div>
                                    )}
                                    {settings.voiceInputMode === 'pushToMute' && (
                                        <div className="settings-option">
                                            <label>Push to Mute Key</label>
                                            {bindControl('ptmBinding', 'Click, then press the key you want to hold')}
                                        </div>
                                    )}
                                </div>

                                {/* Clips — the desktop replay buffer (api/clips/). Shown
                                    even while the experimental gate is off so the settings
                                    exist before the buttons do; the gate lives in Advanced. */}
                                <h3>Clips</h3>
                                <ClipSettings
                                    settings={settings}
                                    updateSetting={updateSetting}
                                    bindControl={bindControl('saveClipBinding', 'Click, then press the key that saves a clip')}
                                />
                            </div>
                        )}

                        {/* Keybinds */}
                        {activeSection === 'keybinds' && (
                            <div className="settings-section">
                                <h3>Keybinds</h3>
                                <p className="settings-description">
                                    Click a key to rebind it, then press the combination you want.
                                    The same bindings appear next to their features in
                                    Voice &amp; Video and Privacy &amp; Safety.
                                    Mute and Deafen come bound to Ctrl+Shift+M / Ctrl+Shift+D and
                                    work while Púca is focused; rebind them to a combination
                                    of your own to make them work system-wide during a call.
                                </p>
                                {/* Only REAL bindings are listed. This tab used to advertise
                                    five shortcuts (Ctrl+M, Ctrl+D, …) that had no handler
                                    anywhere in the app. */}
                                <div className="settings-card">
                                    {KEYBIND_TAB_ROWS.map(([field, label]) => {
                                        // Push-to-talk and push-to-mute keys do NOTHING unless the
                                        // voice input mode matches — VoicePanel only registers the
                                        // hold for the selected mode. Setting the key here and
                                        // nothing happening is the "push to mute doesn't work"
                                        // report: the key was fine, the mode was never switched.
                                        const needsMode = field === 'pttBinding' ? 'pushToTalk'
                                            : field === 'ptmBinding' ? 'pushToMute' : null;
                                        const inert = needsMode !== null
                                            && settings.voiceInputMode !== needsMode
                                            && !!settings[field];
                                        return (
                                            <div className="keybind-row" key={field}>
                                                <span>{label}</span>
                                                {bindControl(field)}
                                                {inert && (
                                                    <span className="keybind-inert">
                                                        Inactive — input mode is
                                                        {' '}{settings.voiceInputMode === 'open'
                                                            ? 'Voice activity'
                                                            : settings.voiceInputMode === 'pushToTalk'
                                                                ? 'Push to talk' : 'Push to mute'}.
                                                        <button
                                                            className="keybind-activate"
                                                            onClick={() => updateSetting('voiceInputMode', needsMode)}
                                                        >
                                                            Switch to {needsMode === 'pushToTalk' ? 'Push to talk' : 'Push to mute'}
                                                        </button>
                                                    </span>
                                                )}
                                            </div>
                                        );
                                    })}
                                    <div className="keybind-row">
                                        <span>Close dialogs</span>
                                        <span className="keybind">Esc</span>
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* Language */}
                        {activeSection === 'language' && (
                            <div className="settings-section">
                                <h3>Language</h3>
                                <p className="settings-description">
                                    Choose your preferred language.
                                </p>
                                <div className="settings-card">
                                    <div className="coming-soon-notice" style={{
                                        textAlign: 'center',
                                        padding: '2rem',
                                        color: '#a6adc8',
                                    }}>
                                        <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}><GlobeIcon size={32} /></div>
                                        <h4 style={{ color: '#cdd6f4', marginBottom: '0.5rem' }}>Coming Soon</h4>
                                        <p style={{ fontSize: '0.9rem' }}>
                                            Language customization is on the way! For now, the app is in English.
                                        </p>
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* Advanced */}
                        {activeSection === 'advanced' && (
                            <div className="settings-section">
                                <h3>Advanced</h3>
                                <p className="settings-description">
                                    Advanced settings for power users.
                                </p>
                                {isTauri() && (
                                    <>
                                        <h3>Desktop App</h3>
                                        <div className="settings-card">
                                            <div className="settings-option">
                                                <div className="option-info">
                                                    <label>Keep running in the tray when closed</label>
                                                    <span className="option-hint">
                                                        Notifications only reach you while Puca is running.
                                                        Turn this off and closing the window quits completely.
                                                        Quit is always available from the tray icon.
                                                    </span>
                                                </div>
                                                <input
                                                    type="checkbox"
                                                    checked={settings.closeToTray}
                                                    onChange={(e) => updateSetting('closeToTray', e.target.checked)}
                                                />
                                            </div>
                                            <div className="settings-option">
                                                <div className="option-info">
                                                    <label>Install updates automatically</label>
                                                    <span className="option-hint">
                                                        When a new version is out, Puca installs it while it
                                                        starts up — before you sign in — then opens on the new
                                                        version. Off by default: with this off you get a banner
                                                        instead, and an update never interrupts a call or a
                                                        conversation.
                                                    </span>
                                                </div>
                                                <input
                                                    type="checkbox"
                                                    checked={settings.autoInstallUpdates}
                                                    onChange={(e) => updateSetting('autoInstallUpdates', e.target.checked)}
                                                />
                                            </div>
                                        </div>
                                    </>
                                )}
                                <div className="settings-card">
                                    <div className="settings-option">
                                        <div className="option-info">
                                            <label>Developer Mode</label>
                                            <span className="option-hint">Show IDs and enable developer features</span>
                                        </div>
                                        <input
                                            type="checkbox"
                                            checked={settings.developerMode}
                                            onChange={(e) => {
                                                updateSetting('developerMode', e.target.checked);
                                                localStorage.setItem('sovereign_dev_mode', e.target.checked.toString());
                                            }}
                                        />
                                    </div>
                                </div>

                                <h3>Experimental</h3>
                                <div className="settings-card">
                                    <div className="settings-option">
                                        <div className="option-info">
                                            <label>Direct file transfer (peer-to-peer)</label>
                                            <span className="option-hint">
                                                Send files of any size straight to the other person in a DM,
                                                without a size limit and without storing anything on the server.
                                                This switch controls SENDING from this device; receiving works
                                                everywhere without it (a phone can receive up to 100 MB). Both
                                                ends must be online at the same time, and the sender must stay
                                                open until it finishes. Untested between two machines — turn it
                                                off if it misbehaves.
                                            </span>
                                        </div>
                                        <input
                                            type="checkbox"
                                            checked={settings.experimentalP2PTransfers}
                                            onChange={(e) => updateSetting('experimentalP2PTransfers', e.target.checked)}
                                        />
                                    </div>
                                    <div className="settings-option">
                                        <div className="option-info">
                                            <label>Clips (replay buffer)</label>
                                            <span className="option-hint">
                                                Adds Arm and Save buttons to the voice panel on desktop: keep the
                                                last few minutes of a call (screen, system audio, your mic) in
                                                encrypted memory and save a clip of it. Nothing is written to disk
                                                and nothing leaves your PC in this build — the posting half, which
                                                needs everyone in the call to approve, is not finished yet.
                                                Everyone in the call sees a marker next to your name while it is on.
                                            </span>
                                        </div>
                                        <input
                                            type="checkbox"
                                            checked={settings.experimentalClips === true}
                                            onChange={(e) => updateSetting('experimentalClips', e.target.checked)}
                                        />
                                    </div>
                                    <div className="settings-option">
                                        <div className="option-info">
                                            <label>DeepFilterNet noise suppression</label>
                                            <span className="option-hint">
                                                Adds a “DeepFilter (Max)” option to the Noise Suppression Mode
                                                picker (Voice settings and the voice panel) — heavier ML
                                                suppression than RNNoise, run in a background thread. Costs
                                                real CPU and ~14 MB on first use; if this device can’t keep up
                                                it falls back automatically mid-call. Try it with the mic test
                                                in Voice settings after enabling.
                                            </span>
                                        </div>
                                        <input
                                            type="checkbox"
                                            checked={settings.experimentalDeepFilter}
                                            onChange={(e) => updateSetting('experimentalDeepFilter', e.target.checked)}
                                        />
                                    </div>
                                    {settings.experimentalDeepFilter && (
                                        <div className="settings-option">
                                            <div className="option-info">
                                                <label>DeepFilter background smoothing</label>
                                                <span className="option-hint">
                                                    If DeepFilter leaves a watery or warbly “static” texture in
                                                    steady background noise, this extra pass smooths it out by
                                                    suppressing those left-over tones harder. The trade-off:
                                                    noisy moments can come through slightly quieter. While
                                                    DeepFilter is your active noise suppression it applies
                                                    immediately, even mid-call — toggle it while listening and
                                                    keep whichever sounds better.
                                                </span>
                                            </div>
                                            <input
                                                type="checkbox"
                                                checked={settings.deepFilterPostFilter}
                                                onChange={(e) => updateSetting('deepFilterPostFilter', e.target.checked)}
                                            />
                                        </div>
                                    )}
                                    {settings.experimentalP2PTransfers && (
                                        <div className="settings-option">
                                            <div className="option-info">
                                                <label>Relay transfer limit (MB)</label>
                                                <span className="option-hint">
                                                    When you and the other person can't connect directly, files
                                                    travel through your server twice. Direct transfers ignore this
                                                    and have no limit.
                                                </span>
                                            </div>
                                            <input
                                                type="number"
                                                min={1}
                                                max={100000}
                                                value={settings.relayTransferMaxMB}
                                                onChange={(e) => updateSetting(
                                                    'relayTransferMaxMB',
                                                    Math.max(1, Number(e.target.value) || 1),
                                                )}
                                            />
                                        </div>
                                    )}
                                </div>

                                <h3>Debug</h3>
                                <div className="settings-card">
                                    <button
                                        className="secondary-btn"
                                        onClick={() => {
                                            localStorage.clear();
                                            window.location.reload();
                                        }}
                                    >
                                        Clear Local Storage & Reload
                                    </button>
                                </div>

                                <h3>App Info</h3>
                                <div className="settings-card">
                                    <div className="app-info-row">
                                        <span>Version</span>
                                        <span className="app-version">{appVersion || 'Loading...'}</span>
                                    </div>
                                    <p className="settings-hint" style={{ marginTop: '8px' }}>
                                        © 2025 Puca • Built with <HeartIcon title="love" />
                                    </p>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
