/**
 * Clip UI gate — PURE. Decides whether the Arm/Save controls render, whether
 * they are enabled, and which reason string explains a disabled state.
 *
 * A gate expressed as nested `&&` in JSX is a gate nobody tests; this one has
 * its own suite. Rules are evaluated in order; the first that fires wins.
 */
import { hasPerm, PERM } from '../permissionBits';

export type ClipDisabledReason =
    | 'not-desktop'      // capture is a WebView2/Tauri feature; phones and browsers approve + watch only
    | 'flag-off'         // experimentalClips is off (Phases 1–2)
    | 'old-server'       // the server predates Clips (no clips fields in GET /servers) — hidden
    | 'server-off'       // owner has not enabled Clips
    | 'no-permission'    // CREATE_CLIPS missing on the voice channel
    | 'afk-channel'      // nobody talks in the AFK channel; arming there is meaningless
    | 'not-in-voice'
    | 'buffer-too-short';

export interface ClipUiInput {
    isDesktop: boolean;
    inVoice: boolean;
    isAfkChannel: boolean;
    /** No mic track (listen-only / no device): arming is ALLOWED, the clip carries system audio only. */
    listenOnly: boolean;
    /** undefined ⇒ the server predates Clips. Ignored in `localOnly` mode. */
    serverClipsEnabled: boolean | undefined;
    /** channel.my_permissions for the voice channel (null/undefined ⇒ pre-migration server: allowed). */
    voiceChannelPerms: number | null | undefined;
    experimentalOn: boolean;
    armed: boolean;
    bufferedSeconds: number;
    /** Phase 1: no server support exists yet — arm/seal/preview locally, never propose. */
    localOnly: boolean;
}

export interface ClipUiState {
    /** Render the controls at all. */
    visible: boolean;
    armEnabled: boolean;
    clipEnabled: boolean;
    /** Why something is disabled/hidden (null when everything is enabled). */
    reason: ClipDisabledReason | null;
    /** Copy note for the pill when arming is allowed but the clip will have no mic. */
    noMic: boolean;
}

/** Below this, "Clip" would produce a sub-GOP nothing. */
export const MIN_CLIP_SECONDS = 5;

export function clipUiState(i: ClipUiInput): ClipUiState {
    const hidden = (reason: ClipDisabledReason): ClipUiState => ({ visible: false, armEnabled: false, clipEnabled: false, reason, noMic: i.listenOnly });
    const disabled = (reason: ClipDisabledReason): ClipUiState => ({ visible: true, armEnabled: false, clipEnabled: false, reason, noMic: i.listenOnly });
    if (!i.isDesktop) return hidden('not-desktop');
    if (!i.experimentalOn) return hidden('flag-off');
    if (!i.localOnly) {
        if (i.serverClipsEnabled === undefined) return hidden('old-server');
        if (i.serverClipsEnabled !== true) return disabled('server-off');
        if (!hasPerm(i.voiceChannelPerms, PERM.CREATE_CLIPS)) return disabled('no-permission');
    }
    if (!i.inVoice) return disabled('not-in-voice');
    if (i.isAfkChannel) return disabled('afk-channel');
    if (i.armed && i.bufferedSeconds < MIN_CLIP_SECONDS) {
        return { visible: true, armEnabled: true, clipEnabled: false, reason: 'buffer-too-short', noMic: i.listenOnly };
    }
    return { visible: true, armEnabled: true, clipEnabled: i.armed, reason: null, noMic: i.listenOnly };
}

/** Title/help copy per reason — one map, used by both buttons and the pill. */
export function clipReasonCopy(reason: ClipDisabledReason | null): string {
    switch (reason) {
        case 'server-off': return 'Clips are turned off in this server.';
        case 'no-permission': return "You don't have permission to create clips in this channel.";
        case 'afk-channel': return 'Clips are not available in the AFK channel.';
        case 'not-in-voice': return 'Join a voice channel to arm the clip buffer.';
        case 'buffer-too-short': return 'Keep the buffer armed for a few more seconds.';
        case 'not-desktop': return 'Clips are recorded on the desktop app.';
        case 'flag-off': return 'Clips are an experimental feature — enable them in Settings › Advanced.';
        case 'old-server': return 'This server is running an older version of Puca — clips are not available here.';
        default: return '';
    }
}
