/**
 * Púca Icon System
 *
 * One outline set, drawn to one grid, in one colour. See
 * `docs/ICON_LANGUAGE.md` for the construction rules and the reasoning; the
 * short version:
 *
 *   - 24x24 canvas, 20x20 live area (2 inset — the round caps need it)
 *   - 1.75 stroke, currentColor, round caps and joins, fill: none
 *   - default box is 1.2em so icons inherit the font-size of their wrapper
 *   - numeric `size` gets optical stroke compensation (see `strokeFor`)
 *   - dots are zero-length paths, never <circle>, so they scale with the stroke
 *
 * currentColor is the whole theming story: an icon is the colour of the text
 * beside it, so all eight themes in styles/theme.css and the high-contrast
 * modifier are handled with no per-theme work.
 */

import React from 'react';
import { getIconStyle, subscribeIconStyle, type IconStyle } from './iconStyle';
import './Icons.css';

/* ==================================================================== */
/* Icon style — the escape hatch back to the old glyphs                 */
/* ==================================================================== */

/*
 * Deliberately NOT re-exported from here: `react-refresh/only-export-components`
 * fails a .tsx file that exports non-components, and that rule is a required
 * gate. Import setIconStyle/getIconStyle from './iconStyle' directly.
 */

/*
 * `classic` renders the emoji/glyph each icon replaced, for anyone who
 * preferred them. Settings → Appearance → Icon Style; persisted by
 * settingsStore and applied in `applyAppearance`, same as the theme.
 *
 * The store is a plain module (./iconStyle), not a React context, so Icons.tsx
 * stays a leaf nobody has to wire a provider for — icons render correctly
 * wherever they mount, including the Login screen and the crash boundary,
 * neither of which sits under the app's providers.
 */

// getServerSnapshot returns the default: SSR/prerender has no user setting, and
// returning the live value there would risk a hydration mismatch.
const useIconStyle = () => React.useSyncExternalStore(
    subscribeIconStyle,
    getIconStyle,
    () => 'modern' as IconStyle,
);

/**
 * What each icon looked like before the migration, keyed by component name.
 *
 * This is the ONLY place emoji are allowed as chrome, and only because the user
 * has asked for them: `classic` renders these instead of the drawn icon. Every
 * caveat in docs/ICON_LANGUAGE.md still applies to them — they are the host
 * font's, they ignore the theme, and they do not optically align. That is the
 * point; someone choosing this wants what they had.
 *
 * An icon missing from this map always draws (Home, Channels, Chat,
 * CameraOff, FlipCamera, Disconnect were SVGs before the migration too, so
 * there is no older glyph to go back to).
 */
// icon-lint:allow-emoji — the opt-in `classic` icon style; see Settings → Appearance
const LEGACY_GLYPHS: Record<string, string> = {
    // navigation & structure
    HashIcon: '#', CompassIcon: '🧭', MessageIcon: '💬', NoteIcon: '🗒️',
    MembersIcon: '👥', UserIcon: '👤', UserAddIcon: '➕', UserRemoveIcon: '👢',
    UserCheckIcon: '✅', CrownIcon: '👑', TasksIcon: '✅', ChecklistIcon: '📋',
    FolderIcon: '📂', FolderOpenIcon: '📂', BoardIcon: '🗂️',
    ServerAddIcon: '🏰', DisbandIcon: '💣',

    // audio / voice
    MicIcon: '🎤', MicOffIcon: '🔇', HeadphonesIcon: '🎧', HeadphonesOffIcon: '🔕',
    SpeakerIcon: '🔊', SpeakerLowIcon: '🔉', SpeakerOffIcon: '🔇', MegaphoneIcon: '📢',
    BellIcon: '🔔', BellOffIcon: '🔕', MoonIcon: '💤', SignalIcon: '📶',
    SlidersIcon: '🎚️', MusicIcon: '🎵',

    // video / screen
    CameraIcon: '📹', ScreenShareIcon: '🖥️', MonitorIcon: '🖥️', ScreenIcon: '📺',
    LaptopIcon: '💻', PhoneIcon: '📱', TerminalIcon: '🐧', GlobeIcon: '🌐',
    GridIcon: '🪟', FullscreenIcon: '⛶', StopIcon: '🛑', StopSharingIcon: '⬛',
    LiveDotIcon: '🔴', CrosshairIcon: '🎯', PlayIcon: '▶',

    // input / gestures
    GamepadIcon: '🎮', MouseIcon: '🖱️', KeyboardIcon: '⌨️', TouchIcon: '👆',
    TapIcon: '👆', TapLongIcon: '👆', TapDoubleIcon: '👆👆', HandIcon: '🖐️',
    TwoFingerIcon: '✌️', PinchIcon: '🤏',

    // message actions
    SmileIcon: '😀', ReplyIcon: '↩️', ForwardIcon: '↪️', PencilIcon: '✏️',
    PinIcon: '📌', TrashIcon: '🗑️', PaperclipIcon: '📎', CopyIcon: '📋',
    ImageIcon: '🖼️', LinkIcon: '🔗', SearchIcon: '🔍', SendIcon: '➤',

    // security
    LockIcon: '🔒', LockOpenIcon: '🔓', ShieldCheckIcon: '🔐', KeyIcon: '🔑',
    BanIcon: '🚫', GavelIcon: '🔨', EyeIcon: '👁️', EyeOffIcon: '🙈', TagIcon: '🏷️',

    // files & transfer
    FileIcon: '📄', FileTextIcon: '📝', DownloadIcon: '⬇️', UploadIcon: '⬆️',
    InboxIcon: '📥', OutboxIcon: '📤', MailIcon: '✉️', MailOpenIcon: '📨',

    // status
    CheckIcon: '✓', CheckCircleIcon: '✅', CloseIcon: '✕', CloseCircleIcon: '❌',
    WarningIcon: '⚠️', AlertIcon: '⚠️', InfoIcon: 'ℹ️', HelpIcon: '❔',
    PendingIcon: '⏳', SadFaceIcon: '😞', SparkleIcon: '🎉', HeartIcon: '❤️',

    // controls
    PlusIcon: '➕', MinusIcon: '➖', SettingsIcon: '⚙️', LogoutIcon: '🚪',
    RefreshIcon: '🔄', ChevronDownIcon: '▼', ChevronUpIcon: '▲',
    ChevronRightIcon: '▶', ArrowLeftIcon: '←', ArrowUpCircleIcon: '🚀',
    CheckboxIcon: '☐', CheckboxCheckedIcon: '☑', MoreIcon: '⋯', MoreVerticalIcon: '⋮',

    // settings sections, templates, emoji-picker categories
    PaletteIcon: '🎨', AccessibilityIcon: '♿', BookIcon: '📚', WrenchIcon: '🛠️',
    LightbulbIcon: '💡', ClockIcon: '🕐', LeafIcon: '🐶', FoodIcon: '🍔',
    ActivityIcon: '⚽', CarIcon: '🚗', FlagIcon: '🏳️',
};
// icon-lint:end

type SvgBase = Omit<React.SVGAttributes<SVGSVGElement>, 'title' | 'strokeWidth' | 'children'>;

export interface IconProps extends SvgBase {
    /** Box size. Omitted → `1.2em` (inherits font-size). A number is px. */
    size?: number | string;
    /** Override the optical stroke. Only with a reason you can state. */
    strokeWidth?: number;
    /** Standalone icons only — switches to role="img". Labelled controls must NOT set this. */
    title?: string;
}

/**
 * Optical stroke compensation. A stroke that scales linearly with the icon
 * looks like a hairline at 14px and like a marker at 64px, so the nominal 1.75
 * is only correct in the middle of the range.
 *
 * Only applies to numeric sizes — an em-sized icon has no idea what it will
 * rasterise to, so it takes the nominal weight.
 */
function strokeFor(size: number | string | undefined, override: number | undefined): number {
    if (override !== undefined) return override;
    if (typeof size !== 'number') return 1.75;
    if (size <= 16) return 2;
    if (size >= 40) return 1.4;
    return 1.75;
}

function makeIcon(displayName: string, body: React.ReactNode) {
    const Component: React.FC<IconProps> = ({ size, strokeWidth, title, className, ...rest }) => {
        // Read unconditionally — a hook may not sit behind the early return below.
        const style = useIconStyle();
        const legacy = LEGACY_GLYPHS[displayName];

        if (style === 'classic' && legacy) {
            return (
                <span
                    className={className ? `svrn-icon-legacy ${className}` : 'svrn-icon-legacy'}
                    role={title ? 'img' : undefined}
                    aria-label={title}
                    aria-hidden={title ? undefined : true}
                    // Emoji fill their em box, so the box IS the size here — no
                    // 1.2em correction, unlike the SVG path.
                    style={typeof size === 'number' ? { fontSize: `${size}px` } : undefined}
                >
                    {legacy}
                </span>
            );
        }

        return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width={size ?? '1.2em'}
            height={size ?? '1.2em'}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={strokeFor(size, strokeWidth)}
            strokeLinecap="round"
            strokeLinejoin="round"
            className={className ? `svrn-icon ${className}` : 'svrn-icon'}
            role={title ? 'img' : undefined}
            aria-hidden={title ? undefined : true}
            focusable="false"
            {...rest}
        >
            {title ? <title>{title}</title> : null}
            {body}
        </svg>
        );
    };
    Component.displayName = displayName;
    return Component;
}

/* ==================================================================== */
/* Navigation & structure                                               */
/* ==================================================================== */

export const HomeIcon = makeIcon('HomeIcon', <>
    <path d="M3.5 9.5 12 3l8.5 6.5v9.25a1.75 1.75 0 0 1-1.75 1.75H5.25A1.75 1.75 0 0 1 3.5 18.75Z" />
    <path d="M9.5 20.5v-6.25h5v6.25" />
</>);

export const HashIcon = makeIcon('HashIcon', <>
    <path d="M10 3.5 8 20.5" />
    <path d="M16 3.5 14 20.5" />
    <path d="M4 9.25h16" />
    <path d="M3.5 14.75h16" />
</>);

export const CompassIcon = makeIcon('CompassIcon', <>
    <circle cx="12" cy="12" r="9" />
    <path d="m15.75 8.25-2.15 5.35-5.35 2.15 2.15-5.35Z" />
</>);

/** The channel list. Kept from the original set. */
export const ChannelsIcon = makeIcon('ChannelsIcon', <>
    <path d="M8.25 6.25h12.25" />
    <path d="M8.25 12h12.25" />
    <path d="M8.25 17.75h12.25" />
    <path d="M3.5 6.25h.01" />
    <path d="M3.5 12h.01" />
    <path d="M3.5 17.75h.01" />
</>);

export const ChatIcon = makeIcon('ChatIcon', <>
    <path d="M20.75 14.75A1.75 1.75 0 0 1 19 16.5H7.5l-4.25 4V5.25A1.75 1.75 0 0 1 5 3.5h14a1.75 1.75 0 0 1 1.75 1.75Z" />
</>);

export const MessageIcon = makeIcon('MessageIcon', <>
    <path d="M20.75 12.25a8 8 0 0 1-8.6 7.97 8.4 8.4 0 0 1-2.9-.7l-5.5 1.23 1.23-5.5a8.4 8.4 0 0 1-.7-2.9 8 8 0 0 1 7.97-8.6 8 8 0 0 1 8.5 8.5Z" />
</>);

export const NoteIcon = makeIcon('NoteIcon', <>
    <rect x="4.75" y="4.75" width="14.5" height="16" rx="1.75" />
    <path d="M8.5 2.75v3.5" />
    <path d="M15.5 2.75v3.5" />
    <path d="M8.75 11.25h6.5" />
    <path d="M8.75 14.75h4.5" />
</>);

export const MembersIcon = makeIcon('MembersIcon', <>
    <path d="M16.25 20.5v-1.75a3.75 3.75 0 0 0-3.75-3.75H6.25A3.75 3.75 0 0 0 2.5 18.75v1.75" />
    <circle cx="9.375" cy="7.75" r="3.75" />
    <path d="M21.5 20.5v-1.75a3.75 3.75 0 0 0-2.8-3.63" />
    <path d="M15.75 4.12a3.75 3.75 0 0 1 0 7.26" />
</>);

export const UserIcon = makeIcon('UserIcon', <>
    <circle cx="12" cy="8" r="3.75" />
    <path d="M4.75 20.5v-.75a5.25 5.25 0 0 1 5.25-5.25h4a5.25 5.25 0 0 1 5.25 5.25v.75" />
</>);

export const UserAddIcon = makeIcon('UserAddIcon', <>
    <circle cx="9.25" cy="8" r="3.75" />
    <path d="M2.75 20.5v-.75a5.25 5.25 0 0 1 5.25-5.25h2.5a5.25 5.25 0 0 1 5.25 5.25v.75" />
    <path d="M19.25 8.25v5.5" />
    <path d="M22 11h-5.5" />
</>);

export const UserRemoveIcon = makeIcon('UserRemoveIcon', <>
    <circle cx="9.25" cy="8" r="3.75" />
    <path d="M2.75 20.5v-.75a5.25 5.25 0 0 1 5.25-5.25h2.5a5.25 5.25 0 0 1 5.25 5.25v.75" />
    <path d="M22 11h-5.5" />
</>);

export const UserCheckIcon = makeIcon('UserCheckIcon', <>
    <circle cx="9.25" cy="8" r="3.75" />
    <path d="M2.75 20.5v-.75a5.25 5.25 0 0 1 5.25-5.25h2.5a5.25 5.25 0 0 1 5.25 5.25v.75" />
    <path d="m16.75 11.25 1.75 1.75 3.5-3.5" />
</>);

export const CrownIcon = makeIcon('CrownIcon', <>
    <path d="M3.75 18.5h16.5" />
    <path d="M3.4 15.5 2.25 6.75 7.9 10.6 12 4.25l4.1 6.35 5.65-3.85-1.15 8.75Z" />
</>);

export const TasksIcon = makeIcon('TasksIcon', <>
    <path d="M9.25 2.75h5.5a1 1 0 0 1 1 1v1a1 1 0 0 1-1 1h-5.5a1 1 0 0 1-1-1v-1a1 1 0 0 1 1-1Z" />
    <path d="M15.75 4.5h2.5a1.75 1.75 0 0 1 1.75 1.75v13a1.75 1.75 0 0 1-1.75 1.75H5.75A1.75 1.75 0 0 1 4 19.25v-13A1.75 1.75 0 0 1 5.75 4.5h2.5" />
    <path d="m9 13.25 2 2 4-4" />
</>);

export const ChecklistIcon = makeIcon('ChecklistIcon', <>
    <path d="m3.25 6.5 1.75 1.75 3-3" />
    <path d="m3.25 15.5 1.75 1.75 3-3" />
    <path d="M11.25 7h9.5" />
    <path d="M11.25 16h9.5" />
</>);

export const FolderIcon = makeIcon('FolderIcon', <>
    <path d="M3.25 18.25V6.5A1.5 1.5 0 0 1 4.75 5h4.19a1.5 1.5 0 0 1 1.2.6l1.12 1.5a1.5 1.5 0 0 0 1.2.6h6.79a1.5 1.5 0 0 1 1.5 1.5v9.05a1.5 1.5 0 0 1-1.5 1.5H4.75a1.5 1.5 0 0 1-1.5-1.5Z" />
</>);

export const FolderOpenIcon = makeIcon('FolderOpenIcon', <>
    <path d="M3.25 17.5V6.5A1.5 1.5 0 0 1 4.75 5h4.19a1.5 1.5 0 0 1 1.2.6l1.12 1.5a1.5 1.5 0 0 0 1.2.6h6.79a1.5 1.5 0 0 1 1.5 1.5v1.55" />
    <path d="m3.4 18.9 2.3-6.65a1.5 1.5 0 0 1 1.42-1.01h13.3a1.5 1.5 0 0 1 1.42 1.99l-1.97 5.67a1.5 1.5 0 0 1-1.42 1.1H4.75a1.5 1.5 0 0 1-1.35-1.1Z" />
</>);

export const BoardIcon = makeIcon('BoardIcon', <>
    <rect x="3.25" y="3.75" width="17.5" height="16.5" rx="2" />
    <path d="M8.5 8.25v8" />
    <path d="M13 8.25v4.5" />
    <path d="M17.5 8.25v6.25" />
</>);

export const ServerAddIcon = makeIcon('ServerAddIcon', <>
    <rect x="2.75" y="4" width="18.5" height="6" rx="1.75" />
    <path d="M21.25 14.75v-.75A1.75 1.75 0 0 0 19.5 12.25h-15A1.75 1.75 0 0 0 2.75 14v4.25A1.75 1.75 0 0 0 4.5 20h8.25" />
    <path d="M6.25 7h.01" />
    <path d="M6.25 16.25h.01" />
    <path d="M18 15.5v5.5" />
    <path d="M20.75 18.25h-5.5" />
</>);

/** Disband a server. The slash is the set's standard negation, not a joke. */
export const DisbandIcon = makeIcon('DisbandIcon', <>
    <path d="M21.25 8.25V5.75A1.75 1.75 0 0 0 19.5 4h-15A1.75 1.75 0 0 0 2.75 5.75v2.5A1.75 1.75 0 0 0 4.5 10h6.75" />
    <path d="M13.25 20h-8.75A1.75 1.75 0 0 1 2.75 18.25v-2.5A1.75 1.75 0 0 1 4.5 14h4.75" />
    <path d="M6.25 7h.01" />
    <path d="m14.5 13.5 7 7" />
    <path d="m21.5 13.5-7 7" />
</>);

/* ==================================================================== */
/* Audio / voice                                                        */
/* ==================================================================== */

export const MicIcon = makeIcon('MicIcon', <>
    <rect x="9" y="2.75" width="6" height="11.5" rx="3" />
    <path d="M5.5 11.25v1a6.5 6.5 0 0 0 13 0v-1" />
    <path d="M12 18.75v2.5" />
</>);

export const MicOffIcon = makeIcon('MicOffIcon', <>
    <path d="M15 4.25a3 3 0 0 0-6-.5v5.5" />
    <path d="M9 12.5a3 3 0 0 0 5.13 1.87" />
    <path d="M5.5 11.25v1a6.5 6.5 0 0 0 10.4 5.2" />
    <path d="M18.5 12.25v-1" />
    <path d="M12 18.75v2.5" />
    <path d="m3.5 3.5 17 17" />
</>);

export const HeadphonesIcon = makeIcon('HeadphonesIcon', <>
    <path d="M3.5 17.5v-5.25a8.5 8.5 0 0 1 17 0v5.25" />
    <path d="M20.5 18.25a2 2 0 0 1-2 2h-.75a1.75 1.75 0 0 1-1.75-1.75v-2.75a1.75 1.75 0 0 1 1.75-1.75h2.75Z" />
    <path d="M3.5 18.25a2 2 0 0 0 2 2h.75a1.75 1.75 0 0 0 1.75-1.75v-2.75a1.75 1.75 0 0 0-1.75-1.75H3.5Z" />
</>);

export const HeadphonesOffIcon = makeIcon('HeadphonesOffIcon', <>
    <path d="M4.25 12.5A8.5 8.5 0 0 1 17.4 5.4" />
    <path d="M20.5 13.75v3.75" />
    <path d="M3.5 14v4.25a2 2 0 0 0 2 2h.75a1.75 1.75 0 0 0 1.75-1.75v-2.75a1.75 1.75 0 0 0-1.75-1.75H4.5" />
    <path d="M20.5 15.25v3a2 2 0 0 1-2 2h-.75a1.75 1.75 0 0 1-1.75-1.75v-2.75a1.75 1.75 0 0 1 1.75-1.75h1.5" />
    <path d="m3.5 3.5 17 17" />
</>);

export const SpeakerIcon = makeIcon('SpeakerIcon', <>
    <path d="M11.5 4.5 6.6 8.5H3.5a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1h3.1l4.9 4Z" />
    <path d="M15.5 9.5a3.5 3.5 0 0 1 0 5" />
    <path d="M18.4 6.6a7.5 7.5 0 0 1 0 10.8" />
</>);

export const SpeakerLowIcon = makeIcon('SpeakerLowIcon', <>
    <path d="M11.5 4.5 6.6 8.5H3.5a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1h3.1l4.9 4Z" />
    <path d="M15.5 9.5a3.5 3.5 0 0 1 0 5" />
</>);

export const SpeakerOffIcon = makeIcon('SpeakerOffIcon', <>
    <path d="M11.5 4.5 6.6 8.5H3.5a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1h3.1l4.9 4Z" />
    <path d="m16 9.75 5 4.5" />
    <path d="m21 9.75-5 4.5" />
</>);

export const MegaphoneIcon = makeIcon('MegaphoneIcon', <>
    <path d="M3.25 10.25v3.5A1.75 1.75 0 0 0 5 15.5h1.5l9.75 4.25V4.25L6.5 8.5H5a1.75 1.75 0 0 0-1.75 1.75Z" />
    <path d="M7 15.75v3a1.75 1.75 0 0 0 3.5 0v-1.75" />
    <path d="M19.5 9.5a3.5 3.5 0 0 1 0 5" />
</>);

export const BellIcon = makeIcon('BellIcon', <>
    <path d="M18 9a6 6 0 0 0-12 0c0 5.75-2.5 7.25-2.5 7.25h17S18 14.75 18 9Z" />
    <path d="M13.85 19.75a2.15 2.15 0 0 1-3.7 0" />
</>);

export const BellOffIcon = makeIcon('BellOffIcon', <>
    <path d="M17.9 10.25V9a6 6 0 0 0-8.3-5.55" />
    <path d="M6.2 6.4A6 6 0 0 0 6 9c0 5.75-2.5 7.25-2.5 7.25h13.25" />
    <path d="M13.85 19.75a2.15 2.15 0 0 1-3.7 0" />
    <path d="m3.5 3.5 17 17" />
</>);

export const MoonIcon = makeIcon('MoonIcon', <>
    <path d="M20.5 14.4A8.75 8.75 0 1 1 9.6 3.5a7 7 0 0 0 10.9 10.9Z" />
</>);

export const SignalIcon = makeIcon('SignalIcon', <>
    <path d="M3.5 19.5v-2.75" />
    <path d="M8.5 19.5v-6.5" />
    <path d="M13.5 19.5v-10.5" />
    <path d="M18.5 19.5v-15" />
</>);

export const SlidersIcon = makeIcon('SlidersIcon', <>
    <path d="M3.5 7.25h11" />
    <path d="M18.5 7.25h2" />
    <path d="M3.5 16.75h2" />
    <path d="M9.5 16.75h11" />
    <circle cx="16.5" cy="7.25" r="2.25" />
    <circle cx="7.5" cy="16.75" r="2.25" />
</>);

export const MusicIcon = makeIcon('MusicIcon', <>
    <path d="M8.75 18V5.75l10.5-2v12.5" />
    <circle cx="6.5" cy="18" r="2.5" />
    <circle cx="17" cy="16.25" r="2.5" />
</>);

/* ==================================================================== */
/* Video / screen                                                       */
/* ==================================================================== */

export const CameraIcon = makeIcon('CameraIcon', <>
    <path d="M21.25 7.75 15.75 12l5.5 4.25Z" />
    <rect x="2.75" y="5.5" width="13" height="13" rx="2" />
</>);

export const CameraOffIcon = makeIcon('CameraOffIcon', <>
    <path d="M21.25 7.75 15.75 12v2.5" />
    <path d="M15.75 9.5v-2a2 2 0 0 0-2-2H8.5" />
    <path d="M5.25 5.5H4.75a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-.5" />
    <path d="m3.5 3.5 17 17" />
</>);

export const ScreenShareIcon = makeIcon('ScreenShareIcon', <>
    <rect x="2.5" y="3.75" width="19" height="13" rx="2" />
    <path d="M8.5 20.25h7" />
    <path d="M12 16.75v3.5" />
    <path d="m12 12.75-.01-5" />
    <path d="m9.5 10 2.5-2.25L14.5 10" />
</>);

export const MonitorIcon = makeIcon('MonitorIcon', <>
    <rect x="2.5" y="3.75" width="19" height="13" rx="2" />
    <path d="M8.5 20.25h7" />
    <path d="M12 16.75v3.5" />
</>);

export const ScreenIcon = makeIcon('ScreenIcon', <>
    <rect x="2.5" y="5.75" width="19" height="13.5" rx="2" />
    <path d="m8.75 2.75 3.25 3 3.25-3" />
</>);

/* Picture-in-picture: the landscape keyline with a small child screen tucked
   in its bottom-right corner (the pop-out target). */
export const PopOutIcon = makeIcon('PopOutIcon', <>
    <rect x="2.5" y="5.75" width="19" height="13.5" rx="2" />
    <rect x="12.75" y="11.5" width="6.75" height="5.25" rx="1.5" />
</>);

export const LaptopIcon = makeIcon('LaptopIcon', <>
    <path d="M5.25 15.25V6.25A1.5 1.5 0 0 1 6.75 4.75h10.5a1.5 1.5 0 0 1 1.5 1.5v9" />
    <path d="M2.75 18.5a1.5 1.5 0 0 0 1.4.9h15.7a1.5 1.5 0 0 0 1.4-.9l-1.5-3.25H4.25Z" />
</>);

export const PhoneIcon = makeIcon('PhoneIcon', <>
    <rect x="6.25" y="2.25" width="11.5" height="19.5" rx="2.5" />
    <path d="M10.75 18.5h2.5" />
</>);

export const TerminalIcon = makeIcon('TerminalIcon', <>
    <rect x="2.5" y="3.75" width="19" height="16.5" rx="2" />
    <path d="m6.75 9.5 2.75 2.75-2.75 2.75" />
    <path d="M12.75 15.5h4.5" />
</>);

export const GlobeIcon = makeIcon('GlobeIcon', <>
    <circle cx="12" cy="12" r="9" />
    <path d="M3.25 12h17.5" />
    <path d="M12 3a13.5 13.5 0 0 1 0 18 13.5 13.5 0 0 1 0-18Z" />
</>);

export const GridIcon = makeIcon('GridIcon', <>
    <rect x="3.25" y="3.25" width="7.5" height="7.5" rx="1.5" />
    <rect x="13.25" y="3.25" width="7.5" height="7.5" rx="1.5" />
    <rect x="3.25" y="13.25" width="7.5" height="7.5" rx="1.5" />
    <rect x="13.25" y="13.25" width="7.5" height="7.5" rx="1.5" />
</>);

export const FlipCameraIcon = makeIcon('FlipCameraIcon', <>
    <path d="M10.75 19.25H4.75a1.75 1.75 0 0 1-1.75-1.75v-11A1.75 1.75 0 0 1 4.75 4.75h4.5" />
    <path d="M13.25 4.75h6a1.75 1.75 0 0 1 1.75 1.75v11a1.75 1.75 0 0 1-1.75 1.75h-4.5" />
    <circle cx="12" cy="12" r="2.75" />
    <path d="m17.25 21.75-2.5-2.5 2.5-2.5" />
    <path d="m6.75 2.25 2.5 2.5-2.5 2.5" />
</>);

export const FullscreenIcon = makeIcon('FullscreenIcon', <>
    <path d="M8.75 3.25H5.5a2.25 2.25 0 0 0-2.25 2.25v3.25" />
    <path d="M20.75 8.75V5.5a2.25 2.25 0 0 0-2.25-2.25h-3.25" />
    <path d="M15.25 20.75h3.25a2.25 2.25 0 0 0 2.25-2.25v-3.25" />
    <path d="M3.25 15.25v3.25a2.25 2.25 0 0 0 2.25 2.25h3.25" />
</>);

export const DisconnectIcon = makeIcon('DisconnectIcon', <>
    <path d="M10.7 13.3a15.5 15.5 0 0 0 3.4 2.6l1.25-1.25a1.9 1.9 0 0 1 2-.43 12.4 12.4 0 0 0 2.7.68 1.9 1.9 0 0 1 1.65 1.9v2.9a1.9 1.9 0 0 1-2.07 1.9 19.2 19.2 0 0 1-8.35-2.97 18.8 18.8 0 0 1-3.2-2.58" />
    <path d="M5.65 12.9a19.2 19.2 0 0 1-2.9-8.3A1.9 1.9 0 0 1 4.65 2.5h2.9a1.9 1.9 0 0 1 1.9 1.65 12.4 12.4 0 0 0 .68 2.7 1.9 1.9 0 0 1-.43 2L8.4 10.1" />
    <path d="m21.5 2.5-19 19" />
</>);

export const StopIcon = makeIcon('StopIcon', <>
    <circle cx="12" cy="12" r="9" />
    <rect x="9" y="9" width="6" height="6" rx="1.25" />
</>);

/** Solid inner dot — the universal "record" mark; an outlined one reads as a target. */
export const RecordIcon = makeIcon('RecordIcon', <>
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" />
</>);

/** The clip replay buffer: a landscape frame with a rewind arrow — "the last
 *  bit of this". Distinct from RecordIcon (live recording to a file), which is
 *  a different promise; reusing it would be the one-meaning-two-icons rot
 *  docs/ICON_LANGUAGE.md warns about. No LEGACY_GLYPHS entry: a brand-new icon
 *  has no classic form. */
export const ClipIcon = makeIcon('ClipIcon', <>
    <rect x="2.5" y="5.75" width="19" height="13.5" rx="2.5" />
    <path d="M15.75 12.5H9.5" />
    <path d="m12.25 9.75-2.75 2.75 2.75 2.75" />
</>);

/** Buffer OFF: the same frame with the single negation slash. */
export const ClipOffIcon = makeIcon('ClipOffIcon', <>
    <rect x="2.5" y="5.75" width="19" height="13.5" rx="2.5" />
    <path d="M15.75 12.5H9.5" />
    <path d="M3.5 3.5 20.5 20.5" />
</>);

/** Solid inner square — an outlined one reads as an empty box, not "stop". */
export const StopSharingIcon = makeIcon('StopSharingIcon', <>
    <rect x="3.75" y="3.75" width="16.5" height="16.5" rx="2.5" />
    <rect x="8.5" y="8.5" width="7" height="7" rx="1" fill="currentColor" stroke="none" />
</>);

/** Solid — a live indicator is a light, not a diagram. */
export const LiveDotIcon = makeIcon('LiveDotIcon', <>
    <circle cx="12" cy="12" r="5" fill="currentColor" stroke="none" />
    <path d="M18.4 5.6a9 9 0 0 1 0 12.8" />
    <path d="M5.6 18.4a9 9 0 0 1 0-12.8" />
</>);

export const CrosshairIcon = makeIcon('CrosshairIcon', <>
    <circle cx="12" cy="12" r="8" />
    <path d="M12 2.25v3.5" />
    <path d="M12 18.25v3.5" />
    <path d="M21.75 12h-3.5" />
    <path d="M5.75 12h-3.5" />
</>);

export const PlayIcon = makeIcon('PlayIcon', <>
    <path d="M7.5 4.75 19.25 12 7.5 19.25Z" />
</>);

/* ==================================================================== */
/* Input devices / gestures                                             */
/* ==================================================================== */

export const GamepadIcon = makeIcon('GamepadIcon', <>
    <rect x="2.25" y="6.75" width="19.5" height="10.5" rx="4.25" />
    <path d="M7.5 10.75v3.5" />
    <path d="M5.75 12.5h3.5" />
    <path d="M15.75 11.25h.01" />
    <path d="M18.25 13.75h.01" />
</>);

export const MouseIcon = makeIcon('MouseIcon', <>
    <rect x="6.25" y="2.75" width="11.5" height="18.5" rx="5.75" />
    <path d="M12 6.75v3.5" />
</>);

export const KeyboardIcon = makeIcon('KeyboardIcon', <>
    <rect x="2.25" y="5.75" width="19.5" height="12.5" rx="2" />
    <path d="M6.25 9.75h.01" />
    <path d="M9.75 9.75h.01" />
    <path d="M13.25 9.75h.01" />
    <path d="M16.75 9.75h.01" />
    <path d="M6.25 13h.01" />
    <path d="M9.75 13h.01" />
    <path d="M13.25 13h.01" />
    <path d="M16.75 13h.01" />
    <path d="M8.5 16.25h7" />
</>);

export const TouchIcon = makeIcon('TouchIcon', <>
    <path d="M9 11.5V5.5a1.75 1.75 0 0 1 3.5 0v5.75" />
    <path d="M12.5 11.5V9.75a1.6 1.6 0 0 1 3.2 0v1.75" />
    <path d="M15.7 11.75v-1a1.6 1.6 0 0 1 3.2 0v5.4a4.6 4.6 0 0 1-4.6 4.6h-2.05a4.4 4.4 0 0 1-3.4-1.6l-3-3.6a1.7 1.7 0 0 1 2.45-2.35L9 14.9" />
</>);

/* The contact point is solid on all three — a fingertip on glass. An outlined
   ring there reads as a target instead, and an arc above a dot reads as a
   face. Both were tried. */
export const TapIcon = makeIcon('TapIcon', <>
    <circle cx="12" cy="12" r="2.75" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="7.75" />
</>);

/** Dot, ring, and an all-but-closed sweep — the ring is "still being held". */
export const TapLongIcon = makeIcon('TapLongIcon', <>
    <circle cx="12" cy="12" r="2.75" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="6.25" />
    <path d="M12 2.5a9.5 9.5 0 1 1-6.72 2.78" />
</>);

/** Two ripples out from one contact point = two taps in the same place. */
export const TapDoubleIcon = makeIcon('TapDoubleIcon', <>
    <circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="6" />
    <circle cx="12" cy="12" r="9.5" />
</>);

export const HandIcon = makeIcon('HandIcon', <>
    <path d="M6.5 13V6.25a1.6 1.6 0 0 1 3.2 0v5" />
    <path d="M9.7 11.25V4.5a1.6 1.6 0 0 1 3.2 0v6.75" />
    <path d="M12.9 11.25V5.5a1.6 1.6 0 0 1 3.2 0v5.75" />
    <path d="M16.1 12v-1.75a1.6 1.6 0 0 1 3.2 0v5.5a5.25 5.25 0 0 1-5.25 5.25h-2.4a4.5 4.5 0 0 1-3.35-1.5l-3.55-3.95a1.6 1.6 0 0 1 2.35-2.15L6.5 13" />
</>);

export const TwoFingerIcon = makeIcon('TwoFingerIcon', <>
    <path d="M9.5 12.25V4.75a1.75 1.75 0 0 0-3.5 0v10.5" />
    <path d="M13 12.25V6.25a1.75 1.75 0 0 1 3.5 0v6" />
    <path d="M6 15.25v1.25a5.25 5.25 0 0 0 5.25 5.25h1a5.25 5.25 0 0 0 5.25-5.25v-4.25" />
</>);

export const PinchIcon = makeIcon('PinchIcon', <>
    <path d="M9.75 9.75 4.5 4.5" />
    <path d="M4.5 9.5v-5h5" />
    <path d="m14.25 14.25 5.25 5.25" />
    <path d="M19.5 14.5v5h-5" />
</>);

/* ==================================================================== */
/* Message actions                                                      */
/* ==================================================================== */

export const SmileIcon = makeIcon('SmileIcon', <>
    <circle cx="12" cy="12" r="9" />
    <path d="M8.25 14a4.5 4.5 0 0 0 7.5 0" />
    <path d="M9.25 9.5h.01" />
    <path d="M14.75 9.5h.01" />
</>);

export const ReplyIcon = makeIcon('ReplyIcon', <>
    <path d="m9.25 7.75-5 4.75 5 4.75" />
    <path d="M4.25 12.5h9.5a6 6 0 0 1 6 6v1.25" />
</>);

export const ForwardIcon = makeIcon('ForwardIcon', <>
    <path d="m14.75 7.75 5 4.75-5 4.75" />
    <path d="M19.75 12.5h-9.5a6 6 0 0 0-6 6v1.25" />
</>);

export const PencilIcon = makeIcon('PencilIcon', <>
    <path d="M16.4 3.85a2.25 2.25 0 0 1 3.18 3.18L8.1 18.5l-4.35 1.17 1.17-4.35Z" />
    <path d="m14.75 5.5 3.75 3.75" />
</>);

export const PinIcon = makeIcon('PinIcon', <>
    <path d="M9.25 3.25h5.5l-.85 5.6 3.6 3.15v1.75H6.5V12l3.6-3.15Z" />
    <path d="M12 13.75v7" />
</>);

export const TrashIcon = makeIcon('TrashIcon', <>
    <path d="M3.75 6.5h16.5" />
    <path d="M8.75 6.5V4.75a1.5 1.5 0 0 1 1.5-1.5h3.5a1.5 1.5 0 0 1 1.5 1.5V6.5" />
    <path d="M5.75 6.5v12.75a1.5 1.5 0 0 0 1.5 1.5h9.5a1.5 1.5 0 0 0 1.5-1.5V6.5" />
    <path d="M10 10.75v6" />
    <path d="M14 10.75v6" />
</>);

export const PaperclipIcon = makeIcon('PaperclipIcon', <>
    <path d="M20 11.25 12.2 19.05a4.6 4.6 0 0 1-6.5-6.5l8-8a3.07 3.07 0 0 1 4.34 4.34l-7.9 7.9a1.53 1.53 0 0 1-2.17-2.17l7.1-7.1" />
</>);

/** The composer's mobile send affordance (desktop shows the "Send" text).
 *  Replaced a raw U+27A4 arrowhead drawn by CSS `content`, which ignored
 *  the themes. */
export const SendIcon = makeIcon('SendIcon', <>
    <path d="M20.5 3.5 13.75 20.5l-3.25-7.25L3.5 10Z" />
    <path d="M20.5 3.5 10.5 13.25" />
</>);

export const CopyIcon = makeIcon('CopyIcon', <>
    <rect x="8.75" y="8.75" width="12" height="12" rx="2" />
    <path d="M5.25 15.25h-.5a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v.5" />
</>);

export const ImageIcon = makeIcon('ImageIcon', <>
    <rect x="2.75" y="3.75" width="18.5" height="16.5" rx="2.25" />
    <path d="M8.75 9.5h.01" />
    <path d="m3 17.25 4.6-4.6a2 2 0 0 1 2.83 0l3.32 3.32" />
    <path d="m13.5 15.25 1.6-1.6a2 2 0 0 1 2.83 0l3.07 3.07" />
</>);

export const LinkIcon = makeIcon('LinkIcon', <>
    <path d="M10 13.25a4.5 4.5 0 0 0 6.8.5l2.7-2.7a4.5 4.5 0 0 0-6.36-6.36l-1.55 1.54" />
    <path d="M14 10.75a4.5 4.5 0 0 0-6.8-.5l-2.7 2.7a4.5 4.5 0 0 0 6.36 6.36l1.54-1.54" />
</>);

export const SearchIcon = makeIcon('SearchIcon', <>
    <circle cx="10.75" cy="10.75" r="7" />
    <path d="m20.25 20.25-4.55-4.55" />
</>);

/* ==================================================================== */
/* Security                                                             */
/* ==================================================================== */

export const LockIcon = makeIcon('LockIcon', <>
    <rect x="4.25" y="10.25" width="15.5" height="10.5" rx="2" />
    <path d="M7.75 10.25V7a4.25 4.25 0 0 1 8.5 0v3.25" />
</>);

export const LockOpenIcon = makeIcon('LockOpenIcon', <>
    <rect x="4.25" y="10.25" width="15.5" height="10.5" rx="2" />
    <path d="M7.75 10.25V7a4.25 4.25 0 0 1 8.28-1.4" />
</>);

export const ShieldCheckIcon = makeIcon('ShieldCheckIcon', <>
    <path d="M12 2.75 20 5.75v5.6c0 4.9-3.35 7.9-8 9.9-4.65-2-8-5-8-9.9V5.75Z" />
    <path d="m8.75 11.75 2.25 2.25 4.25-4.5" />
</>);

export const KeyIcon = makeIcon('KeyIcon', <>
    <circle cx="7.75" cy="16.25" r="3.5" />
    <path d="m10.25 13.75 8.25-8.25" />
    <path d="m15.5 8.5 2.25 2.25" />
    <path d="m18.5 5.5 2.25 2.25" />
</>);

export const BanIcon = makeIcon('BanIcon', <>
    <circle cx="12" cy="12" r="9" />
    <path d="m5.65 5.65 12.7 12.7" />
</>);

export const GavelIcon = makeIcon('GavelIcon', <>
    <path d="M14.9 3.1a1.75 1.75 0 0 1 2.47 0l3.53 3.53a1.75 1.75 0 0 1 0 2.47l-1.77 1.77a1.75 1.75 0 0 1-2.47 0l-3.53-3.53a1.75 1.75 0 0 1 0-2.47Z" />
    <path d="m13.25 9-7.5 7.5" />
    <path d="M3.25 20.75h8.5" />
</>);

export const EyeIcon = makeIcon('EyeIcon', <>
    <path d="M2.25 12S6.1 5.25 12 5.25 21.75 12 21.75 12 17.9 18.75 12 18.75 2.25 12 2.25 12Z" />
    <circle cx="12" cy="12" r="3" />
</>);

export const EyeOffIcon = makeIcon('EyeOffIcon', <>
    <path d="M9.9 5.55A8.9 8.9 0 0 1 12 5.25c5.9 0 9.75 6.75 9.75 6.75a17.9 17.9 0 0 1-2.85 3.85" />
    <path d="M6.4 7.4A17.6 17.6 0 0 0 2.25 12S6.1 18.75 12 18.75a8.9 8.9 0 0 0 3.85-.9" />
    <path d="M14.1 14.1a3 3 0 1 1-4.2-4.2" />
    <path d="m3.5 3.5 17 17" />
</>);

export const TagIcon = makeIcon('TagIcon', <>
    <path d="M11.6 3.25H5.5A2.25 2.25 0 0 0 3.25 5.5v6.1a2 2 0 0 0 .59 1.42l7.14 7.14a2 2 0 0 0 2.83 0l6.1-6.1a2 2 0 0 0 0-2.83L12.77 3.84a2 2 0 0 0-1.17-.59Z" />
    <path d="M7.75 7.75h.01" />
</>);

/* ==================================================================== */
/* Files & transfer                                                     */
/* ==================================================================== */

export const FileIcon = makeIcon('FileIcon', <>
    <path d="M13.75 2.75H6.75A1.75 1.75 0 0 0 5 4.5v15a1.75 1.75 0 0 0 1.75 1.75h10.5A1.75 1.75 0 0 0 19 19.5V8Z" />
    <path d="M13.75 2.75V8H19" />
</>);

export const FileTextIcon = makeIcon('FileTextIcon', <>
    <path d="M13.75 2.75H6.75A1.75 1.75 0 0 0 5 4.5v15a1.75 1.75 0 0 0 1.75 1.75h10.5A1.75 1.75 0 0 0 19 19.5V8Z" />
    <path d="M13.75 2.75V8H19" />
    <path d="M8.5 12.75h7" />
    <path d="M8.5 16.25h4.5" />
</>);

export const DownloadIcon = makeIcon('DownloadIcon', <>
    <path d="M12 3.75v11.5" />
    <path d="m7.25 10.5 4.75 4.75 4.75-4.75" />
    <path d="M3.75 20.25h16.5" />
</>);

export const UploadIcon = makeIcon('UploadIcon', <>
    <path d="M12 15.25V3.75" />
    <path d="m7.25 8.5 4.75-4.75 4.75 4.75" />
    <path d="M3.75 20.25h16.5" />
</>);

export const InboxIcon = makeIcon('InboxIcon', <>
    <path d="M12 3.75v9.5" />
    <path d="m8.25 9.5 3.75 3.75 3.75-3.75" />
    <path d="M3.5 14.25h4.25l1.25 2.5h6l1.25-2.5h4.25v4.25a1.75 1.75 0 0 1-1.75 1.75H5.25a1.75 1.75 0 0 1-1.75-1.75Z" />
</>);

export const OutboxIcon = makeIcon('OutboxIcon', <>
    <path d="M12 13.25v-9.5" />
    <path d="m8.25 7.5 3.75-3.75 3.75 3.75" />
    <path d="M3.5 14.25h4.25l1.25 2.5h6l1.25-2.5h4.25v4.25a1.75 1.75 0 0 1-1.75 1.75H5.25a1.75 1.75 0 0 1-1.75-1.75Z" />
</>);

/* ==================================================================== */
/* Mail                                                                 */
/* ==================================================================== */

export const MailIcon = makeIcon('MailIcon', <>
    <rect x="2.5" y="4.75" width="19" height="14.5" rx="2" />
    <path d="m3.25 6.5 7.63 5.33a2 2 0 0 0 2.24 0L20.75 6.5" />
</>);

export const MailOpenIcon = makeIcon('MailOpenIcon', <>
    <path d="M2.5 10.5 12 4l9.5 6.5v7.75a1.75 1.75 0 0 1-1.75 1.75H4.25a1.75 1.75 0 0 1-1.75-1.75Z" />
    <path d="m2.5 10.5 8.38 5.58a2 2 0 0 0 2.24 0L21.5 10.5" />
</>);

/* ==================================================================== */
/* Status & feedback                                                    */
/* ==================================================================== */

export const CheckIcon = makeIcon('CheckIcon', <>
    <path d="m4.75 12.5 4.75 4.75L19.25 7.25" />
</>);

export const CheckCircleIcon = makeIcon('CheckCircleIcon', <>
    <circle cx="12" cy="12" r="9" />
    <path d="m8 12.25 2.75 2.75L16.25 9.5" />
</>);

export const CloseIcon = makeIcon('CloseIcon', <>
    <path d="m5.75 5.75 12.5 12.5" />
    <path d="m18.25 5.75-12.5 12.5" />
</>);

export const CloseCircleIcon = makeIcon('CloseCircleIcon', <>
    <circle cx="12" cy="12" r="9" />
    <path d="m9 9 6 6" />
    <path d="m15 9-6 6" />
</>);

export const WarningIcon = makeIcon('WarningIcon', <>
    <path d="M10.55 4.1 2.72 17.25A1.7 1.7 0 0 0 4.17 19.8h15.66a1.7 1.7 0 0 0 1.45-2.55L13.45 4.1a1.7 1.7 0 0 0-2.9 0Z" />
    <path d="M12 9.5v4" />
    <path d="M12 16.75h.01" />
</>);

export const AlertIcon = makeIcon('AlertIcon', <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7.75v4.75" />
    <path d="M12 16.25h.01" />
</>);

export const InfoIcon = makeIcon('InfoIcon', <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 16.25v-4.75" />
    <path d="M12 7.75h.01" />
</>);

export const HelpIcon = makeIcon('HelpIcon', <>
    <circle cx="12" cy="12" r="9" />
    <path d="M9.5 9.4a2.6 2.6 0 0 1 5.05.85c0 1.73-2.55 2.6-2.55 2.6v1.15" />
    <path d="M12 17h.01" />
</>);

/** The IEC 5009 "standby" mark, which is what every power button on every
 *  machine already looks like — the one glyph a user does not have to be
 *  taught for "turn this on". */
export const PowerIcon = makeIcon('PowerIcon', <>
    <path d="M12 3.75v7.5" />
    <path d="M17.66 6.34a8 8 0 1 1-11.32 0" />
</>);

export const PendingIcon = makeIcon('PendingIcon', <>
    <path d="M6.5 3.25h11" />
    <path d="M6.5 20.75h11" />
    <path d="M7.75 3.25v3.9a3 3 0 0 0 .9 2.14L12 12.5l-3.35 3.2a3 3 0 0 0-.9 2.15v3.9" />
    <path d="M16.25 3.25v3.9a3 3 0 0 1-.9 2.14L12 12.5l3.35 3.2a3 3 0 0 1 .9 2.15v3.9" />
</>);

export const SadFaceIcon = makeIcon('SadFaceIcon', <>
    <circle cx="12" cy="12" r="9" />
    <path d="M8.25 15.75a4.5 4.5 0 0 1 7.5 0" />
    <path d="M9.25 9.5h.01" />
    <path d="M14.75 9.5h.01" />
</>);

export const SparkleIcon = makeIcon('SparkleIcon', <>
    <path d="m12 3 2.1 5.4 5.4 2.1-5.4 2.1L12 18l-2.1-5.4L4.5 10.5l5.4-2.1Z" />
    <path d="M18.75 16.25 19.5 18l1.75.75-1.75.75-.75 1.75-.75-1.75-1.75-.75 1.75-.75Z" />
</>);

export const HeartIcon = makeIcon('HeartIcon', <>
    <path d="M12 20.25S3.25 15 3.25 9.13A4.63 4.63 0 0 1 12 6.87a4.63 4.63 0 0 1 8.75 2.26C20.75 15 12 20.25 12 20.25Z" />
</>);

/** Favourite marker (task-list tabs). Fill via CSS (`fill: currentColor`)
    when the favourite is active; the outline reads as the inactive state. */
export const StarIcon = makeIcon('StarIcon', <>
    <path d="m12 3.75 2.47 5.01 5.53.8-4 3.9.94 5.5L12 16.36l-4.94 2.6.94-5.5-4-3.9 5.53-.8Z" />
</>);

/* ==================================================================== */
/* Controls                                                             */
/* ==================================================================== */

export const PlusIcon = makeIcon('PlusIcon', <>
    <path d="M12 4.75v14.5" />
    <path d="M4.75 12h14.5" />
</>);

export const MinusIcon = makeIcon('MinusIcon', <>
    <path d="M4.75 12h14.5" />
</>);

export const SettingsIcon = makeIcon('SettingsIcon', <>
    <circle cx="12" cy="12" r="3.25" />
    <path d="M19.05 14.62a1.55 1.55 0 0 0 .31 1.71l.06.06a1.88 1.88 0 1 1-2.66 2.66l-.06-.06a1.55 1.55 0 0 0-1.71-.31 1.55 1.55 0 0 0-.94 1.42v.17a1.88 1.88 0 0 1-3.76 0v-.09a1.55 1.55 0 0 0-1-1.42 1.55 1.55 0 0 0-1.71.31l-.06.06a1.88 1.88 0 1 1-2.66-2.66l.06-.06a1.55 1.55 0 0 0 .31-1.71 1.55 1.55 0 0 0-1.42-.94h-.17a1.88 1.88 0 0 1 0-3.76h.09a1.55 1.55 0 0 0 1.42-1 1.55 1.55 0 0 0-.31-1.71l-.06-.06a1.88 1.88 0 1 1 2.66-2.66l.06.06a1.55 1.55 0 0 0 1.71.31h.07a1.55 1.55 0 0 0 .94-1.42v-.17a1.88 1.88 0 0 1 3.76 0v.09a1.55 1.55 0 0 0 .94 1.42 1.55 1.55 0 0 0 1.71-.31l.06-.06a1.88 1.88 0 1 1 2.66 2.66l-.06.06a1.55 1.55 0 0 0-.31 1.71v.07a1.55 1.55 0 0 0 1.42.94h.17a1.88 1.88 0 0 1 0 3.76h-.09a1.55 1.55 0 0 0-1.42.94Z" />
</>);

export const LogoutIcon = makeIcon('LogoutIcon', <>
    <path d="M9.5 20.25H5.25a1.75 1.75 0 0 1-1.75-1.75V5.5a1.75 1.75 0 0 1 1.75-1.75H9.5" />
    <path d="m15.5 16.5 4.5-4.5-4.5-4.5" />
    <path d="M20 12H9.25" />
</>);

export const RefreshIcon = makeIcon('RefreshIcon', <>
    <path d="M20.25 12a8.25 8.25 0 0 1-14.1 5.83L3.75 15.5" />
    <path d="M3.75 12a8.25 8.25 0 0 1 14.1-5.83l2.4 2.33" />
    <path d="M20.25 4.25v4.25H16" />
    <path d="M3.75 19.75V15.5H8" />
</>);

export const ChevronDownIcon = makeIcon('ChevronDownIcon', <>
    <path d="m5.75 9.25 6.25 6.25 6.25-6.25" />
</>);

export const ChevronUpIcon = makeIcon('ChevronUpIcon', <>
    <path d="m5.75 14.75 6.25-6.25 6.25 6.25" />
</>);

export const ArrowLeftIcon = makeIcon('ArrowLeftIcon', <>
    <path d="M19.25 12H4.75" />
    <path d="m10.5 5.75-5.75 6.25 5.75 6.25" />
</>);

export const ChevronRightIcon = makeIcon('ChevronRightIcon', <>
    <path d="m9.25 5.75 6.25 6.25-6.25 6.25" />
</>);

export const ArrowUpCircleIcon = makeIcon('ArrowUpCircleIcon', <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 16.25v-8.5" />
    <path d="m8.5 11.25 3.5-3.5 3.5 3.5" />
</>);

export const CheckboxIcon = makeIcon('CheckboxIcon', <>
    <rect x="3.75" y="3.75" width="16.5" height="16.5" rx="3" />
</>);

export const CheckboxCheckedIcon = makeIcon('CheckboxCheckedIcon', <>
    <rect x="3.75" y="3.75" width="16.5" height="16.5" rx="3" />
    <path d="m7.75 12.25 2.75 2.75 5.75-6" />
</>);

export const MoreIcon = makeIcon('MoreIcon', <>
    <path d="M5.25 12h.01" />
    <path d="M12 12h.01" />
    <path d="M18.75 12h.01" />
</>);

/** Vertical overflow — for action clusters in a row, where horizontal dots
    read as continuing the row rather than opening a menu. */
export const MoreVerticalIcon = makeIcon('MoreVerticalIcon', <>
    <path d="M12 5.25h.01" />
    <path d="M12 12h.01" />
    <path d="M12 18.75h.01" />
</>);

/** Drag handle (two dot columns) — grab affordance for reorderable rows. */
export const GripIcon = makeIcon('GripIcon', <>
    <path d="M9.25 6.5h.01" />
    <path d="M9.25 12h.01" />
    <path d="M9.25 17.5h.01" />
    <path d="M14.75 6.5h.01" />
    <path d="M14.75 12h.01" />
    <path d="M14.75 17.5h.01" />
</>);

/* ==================================================================== */
/* Settings sections & templates                                        */
/* ==================================================================== */

export const PaletteIcon = makeIcon('PaletteIcon', <>
    <path d="M12 3.25a8.75 8.75 0 0 0 0 17.5 2 2 0 0 0 1.55-3.27 2 2 0 0 1 1.55-3.27h1.9a4.25 4.25 0 0 0 4.25-4.25c0-3.7-4.15-6.71-9.25-6.71Z" />
    <path d="M7.25 10h.01" />
    <path d="M10.5 7h.01" />
    <path d="M15 7.75h.01" />
    <path d="M6.75 14.25h.01" />
</>);

export const AccessibilityIcon = makeIcon('AccessibilityIcon', <>
    <circle cx="12" cy="4.75" r="1.75" />
    <path d="M4.75 9.25c2.4.9 4.83 1.35 7.25 1.35s4.85-.45 7.25-1.35" />
    <path d="M12 10.6v4.15" />
    <path d="m12 14.75-3 5.5" />
    <path d="m12 14.75 3 5.5" />
</>);

export const BookIcon = makeIcon('BookIcon', <>
    <path d="M12 6.75S10.25 4.5 6 4.5H3.75v13.25H6c4.25 0 6 2.25 6 2.25Z" />
    <path d="M12 6.75S13.75 4.5 18 4.5h2.25v13.25H18c-4.25 0-6 2.25-6 2.25Z" />
    <path d="M12 6.75V20" />
</>);

export const WrenchIcon = makeIcon('WrenchIcon', <>
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94Z" />
</>);

export const LightbulbIcon = makeIcon('LightbulbIcon', <>
    <path d="M9.25 17.25a6 6 0 1 1 5.5 0" />
    <path d="M9.75 20.25h4.5" />
    <path d="M9.25 17.25h5.5" />
</>);

export const ClockIcon = makeIcon('ClockIcon', <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 6.75V12l3.5 2" />
</>);

/** Location reminders (task place chip/picker). The map-pin teardrop, not the
 *  pushpin — PinIcon already means "pinned message". */
export const MapPinIcon = makeIcon('MapPinIcon', <>
    <path d="M12 21.25S5.25 15.4 5.25 10.5a6.75 6.75 0 0 1 13.5 0c0 4.9-6.75 10.75-6.75 10.75Z" />
    <circle cx="12" cy="10.5" r="2.5" />
</>);

export const LeafIcon = makeIcon('LeafIcon', <>
    <path d="M20.25 4.25c0 8.5-4.35 12.75-10.25 12.75a5.75 5.75 0 0 1-1.9-11.2c3.5-1.3 8.15-1.55 12.15-1.55Z" />
    <path d="M14.75 9.75c-4.25 1.5-7.5 4.75-10.5 10.5" />
</>);

/* Fork keeps its centre tine — without it the outline is a "Y", and the pair
   read as the letters "Y 0" rather than as cutlery. */
export const FoodIcon = makeIcon('FoodIcon', <>
    <path d="M5.25 3.25v5.25a2.75 2.75 0 0 0 5.5 0V3.25" />
    <path d="M8 3.25v5.25" />
    <path d="M8 11.25v9.5" />
    <path d="M18.75 20.75V3.25c-2 1.05-3.1 3.4-3.1 6.25 0 2.35.95 3.9 3.1 4.25" />
</>);

export const ActivityIcon = makeIcon('ActivityIcon', <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 3.25 8.5 8.5l2 6.25h3l2-6.25Z" />
    <path d="m8.5 8.5-5.15-1.6" />
    <path d="m15.5 8.5 5.15-1.6" />
    <path d="m10.5 14.75-3.6 4.9" />
    <path d="m13.5 14.75 3.6 4.9" />
</>);

export const CarIcon = makeIcon('CarIcon', <>
    <path d="M4 15.25 5.6 8.9A2 2 0 0 1 7.55 7.4h8.9a2 2 0 0 1 1.95 1.5l1.6 6.35" />
    <path d="M3.25 15.25h17.5v3.5h-3v-1.25H6.25v1.25h-3Z" />
    <path d="M6.75 12.25h10.5" />
</>);

export const FlagIcon = makeIcon('FlagIcon', <>
    <path d="M5 21V3.75" />
    <path d="M5 4.75c4.5-2 8.5 2 13 0v9.5c-4.5 2-8.5-2-13 0Z" />
</>);

/* ==================================================================== */
/* Registry                                                             */
/* ==================================================================== */

/**
 * Name → component, for data-driven menus (`ContextMenuItem.icon`, settings
 * sections, server templates). Keeps typos a compile error, which `icon?:
 * string` never did.
 */
export const ICONS = {
    // navigation & structure
    home: HomeIcon,
    hash: HashIcon,
    compass: CompassIcon,
    channels: ChannelsIcon,
    chat: ChatIcon,
    message: MessageIcon,
    note: NoteIcon,
    members: MembersIcon,
    user: UserIcon,
    'user-add': UserAddIcon,
    'user-remove': UserRemoveIcon,
    'user-check': UserCheckIcon,
    crown: CrownIcon,
    tasks: TasksIcon,
    checklist: ChecklistIcon,
    folder: FolderIcon,
    'folder-open': FolderOpenIcon,
    board: BoardIcon,
    'server-add': ServerAddIcon,
    disband: DisbandIcon,

    // audio / voice
    mic: MicIcon,
    'mic-off': MicOffIcon,
    headphones: HeadphonesIcon,
    'headphones-off': HeadphonesOffIcon,
    speaker: SpeakerIcon,
    'speaker-low': SpeakerLowIcon,
    'speaker-off': SpeakerOffIcon,
    megaphone: MegaphoneIcon,
    bell: BellIcon,
    'bell-off': BellOffIcon,
    moon: MoonIcon,
    signal: SignalIcon,
    sliders: SlidersIcon,
    music: MusicIcon,

    // video / screen
    camera: CameraIcon,
    'camera-off': CameraOffIcon,
    'screen-share': ScreenShareIcon,
    monitor: MonitorIcon,
    screen: ScreenIcon,
    laptop: LaptopIcon,
    phone: PhoneIcon,
    terminal: TerminalIcon,
    globe: GlobeIcon,
    grid: GridIcon,
    'flip-camera': FlipCameraIcon,
    fullscreen: FullscreenIcon,
    disconnect: DisconnectIcon,
    stop: StopIcon,
    record: RecordIcon,
    clip: ClipIcon,
    'clip-off': ClipOffIcon,
    'stop-sharing': StopSharingIcon,
    'live-dot': LiveDotIcon,
    crosshair: CrosshairIcon,
    play: PlayIcon,

    // input / gestures
    gamepad: GamepadIcon,
    mouse: MouseIcon,
    keyboard: KeyboardIcon,
    touch: TouchIcon,
    tap: TapIcon,
    'tap-long': TapLongIcon,
    'tap-double': TapDoubleIcon,
    hand: HandIcon,
    'two-finger': TwoFingerIcon,
    pinch: PinchIcon,

    // message actions
    smile: SmileIcon,
    reply: ReplyIcon,
    forward: ForwardIcon,
    pencil: PencilIcon,
    pin: PinIcon,
    trash: TrashIcon,
    paperclip: PaperclipIcon,
    copy: CopyIcon,
    image: ImageIcon,
    link: LinkIcon,
    search: SearchIcon,
    send: SendIcon,

    // security
    lock: LockIcon,
    'lock-open': LockOpenIcon,
    'shield-check': ShieldCheckIcon,
    key: KeyIcon,
    ban: BanIcon,
    gavel: GavelIcon,
    eye: EyeIcon,
    'eye-off': EyeOffIcon,
    tag: TagIcon,

    // files & transfer
    file: FileIcon,
    'file-text': FileTextIcon,
    download: DownloadIcon,
    upload: UploadIcon,
    inbox: InboxIcon,
    outbox: OutboxIcon,
    mail: MailIcon,
    'mail-open': MailOpenIcon,

    // status
    check: CheckIcon,
    'check-circle': CheckCircleIcon,
    close: CloseIcon,
    'close-circle': CloseCircleIcon,
    warning: WarningIcon,
    alert: AlertIcon,
    info: InfoIcon,
    help: HelpIcon,
    power: PowerIcon,
    pending: PendingIcon,
    'sad-face': SadFaceIcon,
    sparkle: SparkleIcon,
    heart: HeartIcon,
    star: StarIcon,

    // controls
    plus: PlusIcon,
    minus: MinusIcon,
    settings: SettingsIcon,
    logout: LogoutIcon,
    refresh: RefreshIcon,
    'chevron-down': ChevronDownIcon,
    'chevron-up': ChevronUpIcon,
    'chevron-right': ChevronRightIcon,
    'arrow-left': ArrowLeftIcon,
    'arrow-up-circle': ArrowUpCircleIcon,
    checkbox: CheckboxIcon,
    'checkbox-checked': CheckboxCheckedIcon,
    more: MoreIcon,
    'more-vertical': MoreVerticalIcon,
    grip: GripIcon,

    // settings sections, templates, emoji-picker categories
    palette: PaletteIcon,
    accessibility: AccessibilityIcon,
    book: BookIcon,
    wrench: WrenchIcon,
    lightbulb: LightbulbIcon,
    clock: ClockIcon,
    'map-pin': MapPinIcon,
    leaf: LeafIcon,
    food: FoodIcon,
    activity: ActivityIcon,
    car: CarIcon,
    flag: FlagIcon,
} as const;

export type IconName = keyof typeof ICONS;

/** Render an icon by registry name. For data-driven menus. */
export const Icon: React.FC<IconProps & { name: IconName }> = ({ name, ...rest }) => {
    const Cmp = ICONS[name];
    return <Cmp {...rest} />;
};
