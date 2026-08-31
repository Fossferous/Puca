import { isTauri } from '../api/platform';
import { setIconStyle, type IconStyle } from './iconStyle';
// App settings persisted in localStorage. Extracted from SettingsModal so that
// component file only exports a component (keeps React Fast Refresh working).

// Settings storage keys
const SETTINGS_KEY = 'sovereign_settings';

/**
 * A captured hotkey: Windows virtual-key code (KeyboardEvent.keyCode in
 * WebView2/Chromium) + required modifiers + a human label. One shape for every
 * binding — the screen-control kill switch, push-to-talk and push-to-mute —
 * so capture UI and matchers are shared.
 */
export type KeyBinding = {
    keyCode: number;
    ctrl: boolean;
    alt: boolean;
    shift: boolean;
    label: string;
};

// Default settings
export const defaultSettings = {
    // Appearance
    theme: 'dark',
    compactMode: false,
    animationsEnabled: true,
    /**
     * 'modern' = the drawn icon set (src/components/Icons.tsx).
     * 'classic' = the emoji and glyphs it replaced, for anyone who preferred
     * them. See docs/ICON_LANGUAGE.md for what 'classic' gives up: emoji come
     * from the host font, so they differ per platform, ignore all eight themes
     * and the contrast boost, and do not optically align.
     */
    iconStyle: 'modern' as IconStyle,

    // Accessibility
    /** UI text scale in percent (rem-based sizes follow the root font size). */
    fontScale: 100,
    /** Boost text/border contrast beyond the theme's normal palette. */
    highContrast: false,
    /** Always underline links in messages (don't rely on colour alone). */
    underlineLinks: false,

    // Notifications
    desktopNotifications: true,
    /** Android: OS notifications for messages, fired locally from this
     *  device's own WebSocket while the app is running (foreground app =
     *  suppressed, like desktop). There is no push service — nothing can
     *  arrive once the app is fully closed. */
    mobileNotifications: true,
    /** Android: hold a foreground service (and the WebSocket under it) after
     *  leaving the app, so messages keep arriving until the app is swiped
     *  away — the phone's equivalent of the desktop tray.
     *
     *  ON by default, because OFF made the notification setting above a lie.
     *  A notification needs a frame to arrive AND the app to be unfocused;
     *  with no service Android freezes the process the moment you leave, so
     *  no frame ever arrives — and while you are IN the app every
     *  notification is correctly suppressed as "you are looking at it". The
     *  two defaults together left exactly no window in which any notification
     *  could ever fire, which is precisely what was reported: nothing but the
     *  session notification, ever. The cost (a permanent notification, an
     *  open socket) is what Android charges for message delivery without a
     *  push service; turning notifications off turns this off with it. */
    mobileBackgroundDelivery: true,
    /** Android: publish the most recent DM conversations as launcher
     *  long-press shortcuts. Contact names become visible on the launcher
     *  without unlocking the app — which is why this can be turned off. */
    launcherConversationShortcuts: true,
    /** Android: fire a reminder when this phone arrives at a place the user
     *  saved on it for a task (taskPlaces.ts). OFF by default and opt-in per
     *  device, deliberately: it needs "Allow all the time" location — the
     *  most sensitive permission this app can hold — and the OS will
     *  periodically tell the user Puca used location in the background.
     *  Places and coordinates are DEVICE-LOCAL (localStorage + the APK's own
     *  storage); nothing is uploaded, and the notification is content-free.
     *  Gated behind mobileNotifications like everything that posts. */
    locationReminders: false,
    /** In-app toast stack for messages arriving while the window IS focused
     *  but the conversation is not on screen (the OS notification's
     *  complement — desktopNotify fires only unfocused). */
    messageToasts: true,
    soundsEnabled: true,        // master toggle for all notification sounds
    messageSound: true,         // blip when a message lands in a non-muted channel/DM
    joinLeaveSound: true,       // chime when someone joins/leaves your voice channel
    // Other users' UPLOADED join/leave clips (falls back to the synth chime
    // when off or when a clip fails). Subordinate to joinLeaveSound.
    customJoinLeaveSounds: true,
    mentionSound: true,
    streamSound: true,          // sounds when someone starts/stops streaming
    // SPOKEN "X joined/left the channel" via the browser's local TTS. Opt-in
    // (off) — it gets chatty in a busy channel; the join/leave chime stays on.
    voiceTTS: false,

    // Privacy — NOTE the DM-consent and online-status toggles are deliberately
    // NOT here: they are server-enforced profile fields (PATCH /profile). Their
    // old localStorage twins (allowDMsFromServerMembers / showOnlineStatus)
    // were written by the checkboxes and read by nothing.
    // When true, voice/video/screen media is only exchanged with peers where
    // end-to-end encryption is active — a peer that can't do media E2EE (or a
    // connection that fails verification) is muted rather than carried over the
    // server in a form it could access. Fail-closed. Safe default for the
    // desktop app (Chromium/WebView2 supports media E2EE); may block calls with
    // Safari/iOS/Firefox participants.
    // DEFAULT ON since the 0.8.130 security pass. The frame-encryption layer
    // itself was already correct and tamper-evident (the capability tag is MAC'd
    // under the static pairwise key, so a server that strips or rewrites the
    // ephemeral fails verification), but with enforcement OFF that verification
    // failure downgraded the call to transport-only instead of refusing it —
    // and transport-only means the server decrypts and re-encrypts every frame.
    // A server that wanted to listen simply had to break the handshake it was
    // already relaying. Off-by-default made that the shipped behaviour.
    // The cost is real and deliberate: a peer whose browser has no Insertable
    // Streams (iOS/Safari, Firefox) is now MUTED rather than carried in the
    // clear, and the per-peer indicator names the reason. Users who would rather
    // connect than encrypt can turn this off.
    requireMediaE2ee: true,
    // When true, force all call media through the server's TURN relay
    // (iceTransportPolicy: 'relay') so other participants never see your real IP.
    // No effect if no relay is available; the operator running TURN can still see
    // the relayed connections.
    forceRelayOnly: false,
    // When true, images hosted on OTHER sites load automatically in messages.
    // Off by default: the URL is chosen by whoever SENT the message, so the
    // fetch hands that host your IP address, your user agent and the moment you
    // read it — a working read receipt and locator for anyone who can post in a
    // channel you read or send you a DM. With this off such an image becomes a
    // click-to-load placeholder. Attachments on your own server are unaffected;
    // they are not third-party.
    loadRemoteImages: false,
    // When true, hide Windows' own "… is sharing your screen" bar during a
    // capture. OFF by default: the app used to do this unconditionally, and
    // re-hide the bar every 700 ms for the whole capture, which suppressed the
    // strongest indicator the user had that their screen was being recorded —
    // along with its in-band "Stop sharing" button. Kept as an option because
    // the bar genuinely does sit on top of a fullscreen game. The tray icon
    // badges amber while any capture runs whether or not this is on.
    hideOsCaptureBar: false,

    // --- Screen-control (remote control of your shared screen) kill switches ---
    // Custom kill-switch hotkey. Enforced by the native low-level hook so it
    // works even when a controlled game has focus (an in-app listener can't).
    // keyCode = Windows virtual-key (from KeyboardEvent.keyCode in WebView2);
    // mods select required Ctrl/Alt/Shift. Default: Esc, no modifiers.
    // Bound by default. It is a safety control: while someone is driving your
    // screen, a key you can hit blind matters more than a clean slate. The
    // only other defaults are mute/deafen (see the App shortcuts block);
    // everything else starts unbound (null) so the app never quietly claims a
    // key you wanted for something else.
    remoteControlKillKey: { keyCode: 27, ctrl: false, alt: false, shift: false, label: 'Esc' } as KeyBinding | null,
    // When true, ANY physical mouse/keyboard input on the host revokes control.
    // OFF by default: an AFK host keeping a friend's game running shouldn't kick
    // them out just by nudging the mouse. The hotkey + Stop button always work.
    remoteControlAnyInputKill: false,

    // Voice
    inputDeviceId: 'default',
    outputDeviceId: 'default',
    inputVolume: 100,
    outputVolume: 100,
    noiseSuppression: true,
    echoCancellation: true,
    autoGainControl: true,
    manualGain: 100, // 0-200%, used when autoGainControl is false

    /**
     * How the mic opens in a call:
     *  - 'open'        : voice activity — the mic transmits unless muted.
     *  - 'pushToTalk'  : mic transmits ONLY while the PTT key is held.
     *  - 'pushToMute'  : mic transmits EXCEPT while the PTM key is held.
     * An explicit mute (button/deafen/AFK) always wins over either hold key.
     *
     * NOTE the legacy `pushToTalk`/`pushToTalkKey` fields are deliberately
     * abandoned (not migrated): they never gated anything — the toggle wrote
     * localStorage and no code read it — so no user has working state to keep,
     * and reusing `pushToTalkKey` would collide with its old string shape in
     * stored blobs.
     */
    voiceInputMode: 'open' as 'open' | 'pushToTalk' | 'pushToMute',
    pttBinding: null as KeyBinding | null,
    ptmBinding: null as KeyBinding | null,

    // App shortcuts (press actions; see api/hotkeys.ts). Mute/deafen ship
    // BOUND (Ctrl+Shift+M / Ctrl+Shift+D — the combination most chat apps use): "toggle mute
    // doesn't work" was a field report, and the cause was that nothing was
    // bound and nobody knew. Modifier combos so they fire from the composer
    // too; both remain clearable in Settings › Keybinds (a cleared binding is
    // a choice — see migrateDefaultVoiceKeybinds).
    toggleMuteBinding: { keyCode: 77, ctrl: true, alt: false, shift: true, label: 'M' } as KeyBinding | null,
    toggleDeafenBinding: { keyCode: 68, ctrl: true, alt: false, shift: true, label: 'D' } as KeyBinding | null,
    openSettingsBinding: null as KeyBinding | null,
    searchBinding: null as KeyBinding | null,

    // --- Clips (desktop replay buffer; api/clips/) --------------------------
    /** Seconds kept in the ring while armed. The SERVER caps how long a CLIP may
     *  be; this caps how much is BUFFERED. */
    clipBufferSeconds: 300,
    /** Encoder preset id — see api/clips/clipPresets.ts. */
    clipQuality: '1080p30' as string,
    /** Hard ceiling on the ring, MiB. Whichever of this and clipBufferSeconds
     *  binds first wins, so a busy 1440p60 scene keeps fewer seconds rather than
     *  eating the machine. The Settings slider max is derived from the memory
     *  budget (clipPresets.ts) so this can never exceed what the clamp allows. */
    clipMemoryCapMB: 1024,
    /** Your own mic level inside the clip, 0–200 %. System audio stays at 100 %:
     *  the clip hears your mic post-processing at SEND level while the game is
     *  at PLAYBACK level, so this is the one that needs adjusting. */
    clipMicGain: 100,
    /** What happens when I join a voice channel that allows clips:
     *  'off' — nothing; 'prompt' — highlight the Arm button for a few seconds;
     *  'auto' — start recording with NO popup (ClipControls.tsx → armNative):
     *  native DXGI capture of whichever monitor a fullscreen app is filling,
     *  else the primary monitor, plus WASAPI desktop-audio loopback — the
     *  same no-gesture primitive the remote-desktop agent uses, because
     *  getDisplayMedia can never be made picker-free from JS. One attempt
     *  per room; a failure falls back to the 'prompt' nudge. */
    clipArmOnJoin: 'off' as 'off' | 'prompt' | 'auto',
    /** @deprecated Superseded by clipArmOnJoin; a stored `true` is read ONCE
     *  by loadSettings and mapped to 'prompt'. Kept so old profiles still type. */
    clipArmPromptOnJoin: false,
    /** Press action: seal the last N seconds (api/hotkeys.ts). Unbound by
     *  default like every binding except the kill switch. */
    saveClipBinding: null as KeyBinding | null,

    // Language
    language: 'en',

    // Desktop window behaviour
    /**
     * Closing the window hides to the tray instead of quitting.
     *
     * Default ON, because it is what makes notifications arrive after you close
     * the window — with it off, closing ends the process and nothing can reach
     * you until you reopen the app. Quit is always available from the tray
     * menu, so this can never trap someone in an app they cannot exit.
     */
    closeToTray: true,
    /**
     * Install a newer desktop release automatically at startup — BEFORE the
     * app loads (UpdateGate reads this pre-render via loadSettings()), never
     * mid-session. Default OFF: automatic installation is opt-in. Off means
     * the update banner PROMPTS and installs only on a click; the old
     * behaviour of installing ~8 s after the chat UI appeared (mid-channel,
     * mid-call) is gone either way.
     */
    autoInstallUpdates: false,

    // Developer
    developerMode: false,

    // --- Experimental -------------------------------------------------------
    // Direct peer-to-peer file transfer (docs/P2P_FILE_TRANSFER_PLAN.md).
    // OFF by default and deliberately opt-in per user: the code is implemented
    // and unit-tested, and it has moved bytes over a real data channel in a
    // loopback harness, but it has never run between two separate machines.
    // A runtime switch (rather than a build constant) is what lets two people
    // try it on a released build without shipping it to everyone, and lets
    // them turn it off again without waiting for another release.
    experimentalP2PTransfers: false,

    /**
     * Clips — the desktop replay buffer (api/clips/). OFF by default while the
     * consent/post half is built out: this gate controls ARMING only (Arm/Save
     * buttons in the voice bar); approving a clip request and watching a posted
     * clip stay unconditional, exactly like P2P transfers gate SENDING only.
     */
    experimentalClips: false,

    /**
     * DeepFilterNet noise suppression (the "max quality" tier). OFF by default:
     * the first implementation shipped audibly crackly (main-thread inference),
     * so the rebuilt off-thread pipeline (deepFilter.ts) earns its way back as
     * an explicit opt-in. The gate controls whether the "DeepFilter (Max)"
     * option APPEARS in the voice noise-suppression picker — the picker itself
     * still chooses the mode. Ungating while saved on it falls back to RNNoise.
     */
    experimentalDeepFilter: false,

    /**
     * DeepFilter perceptual post filter (upstream's anti-musical-noise gain
     * reshaping, beta in dfTuning.ts). OFF by default and opt-in per user: it
     * targets the field-reported "static/warbly background" texture (musical
     * noise, 2026-08-11), but its documented tradeoff is extra attenuation of
     * noisy sections — so the person hearing the artifact can A/B it live in
     * their real room instead of everyone's audio being silently re-tuned.
     * Only meaningful while the DeepFilter mode itself is active.
     */
    deepFilterPostFilter: false,

    /**
     * Largest transfer allowed when the peers CANNOT connect directly, in MB.
     *
     * A relayed transfer is not peer-to-peer: every byte goes up to the TURN
     * server and back down, so an 800 MB file costs ~1.6 GB on the host's home
     * connection. 100 MB is a sane default guard, but refusing outright looks
     * broken to someone deliberately sending something large — so it is theirs
     * to raise. A DIRECT transfer ignores this entirely and stays uncapped.
     */
    relayTransferMaxMB: 100,
};

export type Settings = typeof defaultSettings;

// Load settings from localStorage
/**
 * One-time reset of the three mic-processing toggles.
 *
 * Until v0.7.0 these affected ONLY the settings-panel mic test — real calls
 * used hardcoded constraints (`echoCancellation: true, autoGainControl: true`
 * for the ML modes). v0.7.0 correctly made them apply to calls, but that
 * silently activated whatever was in storage, and those values had been set at
 * a time when flipping them visibly did nothing. Anyone who had toggled one
 * while experimenting lost auto-gain or echo cancellation on real calls with no
 * indication, having never meaningfully chosen it.
 *
 * Runs once. A value set AFTER this migration is a real choice and is kept —
 * the marker is what distinguishes the two, so it must never be cleared.
 */
const MIC_TOGGLES_MIGRATION_KEY = 'micProcessingTogglesReset_v1';

function migrateMicProcessingToggles(parsed: Partial<Settings> | null): Partial<Settings> {
    if (localStorage.getItem(MIC_TOGGLES_MIGRATION_KEY)) return parsed ?? {};
    // Marked done even when NOTHING is stored yet. Skipping that case looks
    // harmless — there is nothing to migrate — but it leaves the migration
    // armed, so a user whose first-ever save turns one of these off gets it
    // reset on the very next load. Their deliberate choice, silently undone by
    // the code meant to stop exactly that. (Caught by inputGain.test.ts.)
    const changed = parsed
        ? (['echoCancellation', 'autoGainControl', 'noiseSuppression'] as const)
            .filter(k => parsed[k] === false)
        : [];
    const next = { ...(parsed ?? {}) };
    for (const k of changed) next[k] = defaultSettings[k];
    try {
        localStorage.setItem(MIC_TOGGLES_MIGRATION_KEY, '1');
        if (changed.length > 0) {
            localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...defaultSettings, ...next }));
            console.log('[Settings] Reset mic processing toggles that predate them affecting calls:', changed);
        }
    } catch { /* storage full or blocked — the in-memory reset below still applies */ }
    return next;
}

/**
 * One-time enable of Android background delivery.
 *
 * `mobileBackgroundDelivery` shipped defaulting OFF while `mobileNotifications`
 * defaulted ON, and the pair left no window in which a notification could ever
 * fire: foregrounded, every notification is (correctly) suppressed as "you are
 * looking at it"; backgrounded WITHOUT the foreground service, Android freezes
 * the process, so no message frame ever arrives to notify about. Reported as
 * "the only notification that works is the one saying there is a session" —
 * that one comes from the device-session service, which is held for a
 * different reason and so was never affected.
 *
 * Changing the default alone fixes nobody: every existing profile has `false`
 * written, and stored values win over defaults. So flip it once, for anyone
 * who still wants notifications at all.
 *
 * Same contract as the mic migration: it runs once, the marker is what makes
 * a later `false` a real choice, and it must never be cleared.
 */
const BG_DELIVERY_MIGRATION_KEY = 'mobileBackgroundDeliveryEnabled_v1';

function migrateBackgroundDelivery(parsed: Partial<Settings> | null): Partial<Settings> {
    if (localStorage.getItem(BG_DELIVERY_MIGRATION_KEY)) return parsed ?? {};
    const next = { ...(parsed ?? {}) };
    // Only for people who still want notifications: someone who turned
    // notifications off is asking for silence, and starting a foreground
    // service for them would be the opposite.
    const wantsNotifications = next.mobileNotifications !== false;
    const changed = parsed != null && wantsNotifications && next.mobileBackgroundDelivery === false;
    if (changed) next.mobileBackgroundDelivery = true;
    try {
        // Marked done even with nothing stored, for the same reason as the mic
        // migration: an armed migration would undo the first deliberate "off".
        localStorage.setItem(BG_DELIVERY_MIGRATION_KEY, '1');
        if (changed) {
            localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...defaultSettings, ...next }));
            console.log('[Settings] Enabled background delivery so notifications can actually arrive');
        }
    } catch { /* storage full or blocked — the in-memory value below still applies */ }
    return next;
}

/**
 * One-time application of the default mute/deafen bindings to existing
 * profiles.
 *
 * The defaults changed from null to Ctrl+Shift+M / Ctrl+Shift+D, but every
 * stored profile has an explicit `null` written and stored values win over
 * defaults — so without this, only fresh installs would get the bindings.
 * Same contract as the other migrations: runs once, the marker is what makes
 * a later cleared binding a real choice, and the marker must never be
 * cleared. A custom binding already stored is always preserved.
 *
 * Known accepted edge: someone who deliberately cleared the binding BEFORE
 * this shipped is indistinguishable from never-set and gets the default back
 * (reversible in Settings › Keybinds).
 */
const VOICE_KEYBIND_MIGRATION_KEY = 'voiceKeybindDefaults_v1';

function migrateDefaultVoiceKeybinds(parsed: Partial<Settings> | null): Partial<Settings> | null {
    if (localStorage.getItem(VOICE_KEYBIND_MIGRATION_KEY)) return parsed;
    const next = { ...(parsed ?? {}) };
    let changed = false;
    for (const field of ['toggleMuteBinding', 'toggleDeafenBinding'] as const) {
        // STRICTLY null: an ABSENT key already inherits the new default via
        // the `{...defaultSettings, ...stored}` spread (and absent is what a
        // fresh profile looks like by the time this runs — writing anything
        // for it would freeze today's defaults into storage). Only a stored
        // explicit null shadows the default and needs rewriting.
        if (next[field] === null) {
            next[field] = defaultSettings[field];
            changed = true;
        }
    }
    try {
        // Marked done even with nothing stored, for the same reason as the
        // other migrations: an armed migration would undo the first
        // deliberate clear.
        localStorage.setItem(VOICE_KEYBIND_MIGRATION_KEY, '1');
        if (changed) {
            localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...defaultSettings, ...next }));
            console.log('[Settings] Applied default mute/deafen keybinds (Ctrl+Shift+M / Ctrl+Shift+D)');
        }
    } catch { /* storage full or blocked — the in-memory value below still applies */ }
    return parsed == null ? parsed : next;
}

/** `clipArmPromptOnJoin: true` (pre-0.8.106 checkbox) becomes the 'prompt'
 *  mode of clipArmOnJoin. Pure: nothing is written — every load derives the
 *  same answer until the user's next save persists it. An explicit
 *  clipArmOnJoin always wins, so choosing 'off' later is not undone. */
function migrateClipArmOnJoin(parsed: Partial<Settings> | null): Partial<Settings> | null {
    if (!parsed || parsed.clipArmOnJoin !== undefined || parsed.clipArmPromptOnJoin !== true) return parsed;
    return { ...parsed, clipArmOnJoin: 'prompt' };
}

export function loadSettings(): Settings {
    try {
        const stored = localStorage.getItem(SETTINGS_KEY);
        const parsed = stored ? (JSON.parse(stored) as Partial<Settings>) : null;
        // Called even for `null` so the migration disarms itself on a fresh
        // profile — see the note inside.
        const migrated = migrateDefaultVoiceKeybinds(
            migrateBackgroundDelivery(migrateMicProcessingToggles(migrateClipArmOnJoin(parsed)) as Partial<Settings>),
        );
        if (parsed) return { ...defaultSettings, ...migrated };
    } catch (e) {
        console.error('Failed to load settings:', e);
    }
    return defaultSettings;
}

// Save settings to localStorage
export function saveSettings(settings: Settings) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    // Push window behaviour down to the native shell. The Rust side owns the
    // close handler, so a setting the shell never hears about is a setting that
    // does nothing — the exact failure the settings audit kept finding.
    syncCloseToTray(settings.closeToTray);
    // Re-apply document-level appearance so every save takes visual effect
    // immediately — one authority instead of scattered per-component effects.
    applyAppearance(settings);
    // Dispatch event for other components
    window.dispatchEvent(new CustomEvent('settingsChanged', { detail: settings }));
}

/** Tell the Tauri shell whether closing should hide to the tray. No-op on web. */
export function syncCloseToTray(enabled: boolean): void {
    if (!isTauri()) return;
    void import('@tauri-apps/api/core')
        .then(({ invoke }) => invoke('set_close_to_tray', { enabled }))
        .catch(err => console.warn('[settings] could not sync close-to-tray:', err));
}

/**
 * Apply the chosen theme to the document.
 *
 * Lives here (not in SettingsModal) because the modal only mounts inside Chat —
 * so the Login screen rendered before the theme was ever applied, and a
 * Light-theme user got a dark login plus a dark flash on every launch. Called
 * from the main.tsx bootstrap and from the Theme select's change handler.
 */
export function applyTheme(theme: string): void {
    document.documentElement.setAttribute('data-theme', theme);
    // Also update body class for compatibility
    document.body.className = document.body.className
        .replace(/theme-\w+/g, '')
        .trim() + ` theme-${theme}`;
}

/**
 * Apply every document-level appearance/accessibility setting: theme, compact
 * spacing, animations, text scale, contrast boost, link underlines. Called at
 * startup (main.tsx) and by saveSettings on every change — the CSS reads these
 * root attributes/vars, so a setting that never lands here does nothing.
 */
export function applyAppearance(s: Settings = loadSettings()): void {
    const root = document.documentElement;
    applyTheme(s.theme);
    root.setAttribute('data-compact', String(!!s.compactMode));
    root.setAttribute('data-animations', String(s.animationsEnabled !== false));
    root.setAttribute('data-contrast', s.highContrast ? 'high' : 'normal');
    root.setAttribute('data-underline-links', String(!!s.underlineLinks));
    // Icons subscribe to this store rather than reading a root attribute — CSS
    // can hide an element but cannot swap an <svg> for an emoji.
    setIconStyle(s.iconStyle === 'classic' ? 'classic' : 'modern');
    const scale = typeof s.fontScale === 'number'
        ? Math.max(80, Math.min(130, s.fontScale)) : 100;
    root.style.setProperty('--font-scale', String(scale));
}

/**
 * Single source of truth for developer mode: the typed settings field.
 *
 * The toggle used to write a second key (`sovereign_dev_mode`) and consumers
 * read ONLY that mirror — so the typed field was dead weight and the two could
 * desync. The mirror is still read as a fallback (and written on toggle) for
 * one release so existing installs keep their state, then it goes away.
 */
export function isDeveloperMode(): boolean {
    return loadSettings().developerMode
        || localStorage.getItem('sovereign_dev_mode') === 'true';
}

/**
 * May this image URL be fetched automatically?
 *
 * True when the user opted in, OR when the host is somewhere the client already
 * talks to anyway — its own origin or the configured API host. Those are not
 * third parties: the server already knows your IP because you are connected to
 * it, so gating them would cost usability and buy nothing.
 *
 * Everything else is a host chosen by whoever sent the message, and fetching it
 * discloses the reader's IP, user agent and read time to them.
 */
export function remoteImagesAllowed(url: string): boolean {
    if (loadSettings().loadRemoteImages) return true;
    try {
        const host = new URL(url, window.location.href).host;
        if (host === window.location.host) return true;
        const api = import.meta.env.VITE_API_URL;
        if (api && host === new URL(api).host) return true;
    } catch {
        /* unparseable URL — treat as remote */
    }
    return false;
}

/** Notification-sound categories, gated on the master `soundsEnabled` toggle. */
export type NotifSoundCategory = 'message' | 'mention' | 'voiceChime' | 'customSounds' | 'voiceTTS' | 'stream';

/** True when the master sound toggle is on AND the given category is enabled. */
export function notifEnabled(category: NotifSoundCategory): boolean {
    const s = loadSettings();
    if (!s.soundsEnabled) return false;
    switch (category) {
        case 'message': return s.messageSound;
        case 'mention': return s.mentionSound;
        case 'voiceChime': return s.joinLeaveSound;
        case 'customSounds': return s.customJoinLeaveSounds;
        case 'voiceTTS': return s.voiceTTS;
        case 'stream': return s.streamSound;
    }
}

/* ==========================================================================
   Output routing — the master volume and device the user picked in Settings.

   These exist because "Output volume" and "Output device" were applied ONLY to
   the settings panel's own test sound: real call audio read the per-user volume
   store and nothing else, so both controls were cosmetic in an actual call.
   Every place that sets a voice/stream element's volume multiplies by
   `outputGain()`, and every element that plays call audio is routed with
   `applyOutputDevice()`.
   ========================================================================== */

/** Master output multiplier, 0..1. Composes with per-user volume and deafen. */
export function outputGain(): number {
    const v = loadSettings().outputVolume;
    return Math.max(0, Math.min(1, (typeof v === 'number' ? v : 100) / 100));
}

/**
 * Microphone send multiplier, 0..4. Input Volume (0–200%) times Manual Gain
 * (0–200%, only when Auto Gain Control is off — AGC would just fight a static
 * boost). 1.0 means "leave the mic alone", and callers skip building a gain
 * stage entirely in that case.
 *
 * Exists because both sliders were cosmetic: Input Volume only scaled the
 * settings panel's own level-meter math and Manual Gain was read by nothing —
 * the same disease outputGain() was written to cure on the output side.
 */
export function inputGain(): number {
    const s = loadSettings();
    const vol = typeof s.inputVolume === 'number' ? s.inputVolume : 100;
    const manual = !s.autoGainControl && typeof s.manualGain === 'number' ? s.manualGain : 100;
    return Math.max(0, Math.min(4, (vol / 100) * (manual / 100)));
}

/**
 * Route one element to the chosen output device.
 *
 * `setSinkId` is Chromium-only (our desktop shell and the web target) and
 * rejects if the device has gone away — a stale id must fall back to the
 * default EXPLICITLY (setSinkId('')), both so the element keeps playing
 * somewhere and so a later re-apply (devicechange, Settings) starts clean.
 * The same explicitness covers the other direction: switching Settings back
 * to Default used to early-return here, leaving every live element stuck on
 * the previously chosen device.
 */
export function applyOutputDevice(el: HTMLMediaElement): void {
    const id = loadSettings().outputDeviceId;
    const sinkable = el as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void>; sinkId?: string };
    if (typeof sinkable.setSinkId !== 'function') return;
    if (!id || id === 'default') {
        // Only elements actually routed elsewhere need the reset call.
        if (sinkable.sinkId) {
            void sinkable.setSinkId('').catch(() => { /* already unroutable */ });
        }
        return;
    }
    void sinkable.setSinkId(id).catch(() => {
        // Device unplugged or permission withdrawn: fall back to the default
        // sink rather than leaving the element pointed at a corpse.
        void sinkable.setSinkId!('').catch(() => { /* keep whatever still plays */ });
    });
}
