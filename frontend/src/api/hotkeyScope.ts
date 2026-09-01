/**
 * Which voice hotkeys the desktop-global hook watches — ONE predicate, read by
 * the feed (VoicePanel) and by the Keybinds tab, so the row's promise and the
 * hook's behaviour cannot drift apart.
 *
 * The rule: a mute/deafen bind is watched system-wide when the user asked for
 * that — either with the "Use Mute and Deafen from other apps" switch, or by
 * choosing the bind themselves (recorded in `voiceBindsUserSet` at capture
 * time). An untouched shipped default stays in-app only: Ctrl+Shift+M and
 * Ctrl+Shift+D are VS Code's Problems panel and Run-and-Debug view, and
 * claiming them system-wide muted alt-tabbed users with no visible cause.
 *
 * WHY THIS IS A MODULE AND NOT THREE LINES IN VoicePanel. The previous rule
 * inferred "chosen" from the VALUE (bind differs from the shipped default). It
 * silently classed a deliberate choice as untouched whenever the chosen
 * combination equalled the shipped one, and the default-restoring migration
 * produced the same state from a cleared bind. From outside both looked
 * identical: hotkeys work while Púca is focused and die the instant focus
 * leaves, and `hotkey_diag` reads active:false because nothing ever asked for
 * a hook. Three earlier fixes for that report each addressed a different
 * theory; the diag finally showed the watch list had simply been empty.
 * Provenance is now RECORDED, and the value comparison survives only as the
 * fallback for profiles that predate the record (settingsStore's
 * migrateVoiceBindProvenance converts it into a record once).
 *
 * Push-to-talk / push-to-mute are watched in their input mode, the clip key
 * while the buffer is armed — the whole point of those is a game with focus.
 */
import {
    defaultSettings, sameCombo, VOICE_BIND_FIELDS,
    type KeyBinding, type Settings, type VoiceBindField,
} from '../components/settingsStore';

export { sameCombo };
export type { VoiceBindField };

export function isVoiceBindField(field: string): field is VoiceBindField {
    return (VOICE_BIND_FIELDS as readonly string[]).includes(field);
}

/** Where a voice bind works, and why — the row badge and the diag both show this. */
export type VoiceBindScope =
    | 'unbound'
    | 'global:switch'     // the "from other apps" switch is on
    | 'global:user-set'   // captured by the user (recorded)
    | 'global:inferred'   // differs from the shipped default; profile predates the record
    | 'in-app:default'    // the shipped default, never chosen
    | 'in-app:reset';     // put back to the default with Reset

export function voiceBindScope(s: Settings, field: VoiceBindField): VoiceBindScope {
    const b = s[field];
    if (!b) return 'unbound';
    if (s.globalVoiceHotkeys === true) return 'global:switch';
    const userSet = s.voiceBindsUserSet?.[field];
    if (userSet === true) return 'global:user-set';
    if (userSet === false) return 'in-app:reset';
    return sameCombo(b, defaultSettings[field]) ? 'in-app:default' : 'global:inferred';
}

export function isVoiceBindGlobal(s: Settings, field: VoiceBindField): boolean {
    return voiceBindScope(s, field).startsWith('global:');
}

/**
 * Record who set a bind. Called by the Keybinds tab at capture (`true`) and
 * Reset (`false`); fields whose scope does not depend on provenance pass
 * through untouched.
 */
export function markVoiceBindProvenance(s: Settings, field: string, userSet: boolean): Settings {
    if (!isVoiceBindField(field)) return s;
    return { ...s, voiceBindsUserSet: { ...(s.voiceBindsUserSet ?? {}), [field]: userSet } };
}

/** The call-time inputs the feed decision depends on besides settings. */
export type NativeWatchHost = {
    /** False in an AFK channel or listen-only: no mic, so no mic hotkeys. */
    micKeys: boolean;
    voiceInputMode: 'open' | 'pushToTalk' | 'pushToMute';
    /** Clip replay buffer armed on this machine. */
    clipArmed: boolean;
};

/** Parallel arrays: `keys[i]` is the virtual-key the hook watches for `ids[i]`. */
export type NativeWatch = { ids: string[]; keys: number[] };

export function computeNativeWatch(s: Settings, host: NativeWatchHost): NativeWatch {
    const ids: string[] = [];
    const keys: number[] = [];
    const watch = (id: string, b: KeyBinding | null | undefined) => {
        if (!b) return; // bindings are nullable — unset, or cleared in Settings
        ids.push(id);
        keys.push(b.keyCode);
    };
    if (host.micKeys) {
        if (isVoiceBindGlobal(s, 'toggleMuteBinding')) watch('voice.toggleMute', s.toggleMuteBinding);
        if (isVoiceBindGlobal(s, 'toggleDeafenBinding')) watch('voice.toggleDeafen', s.toggleDeafenBinding);
        if (host.voiceInputMode === 'pushToTalk') watch('voice.ptt', s.pttBinding);
        else if (host.voiceInputMode === 'pushToMute') watch('voice.ptm', s.ptmBinding);
    }
    if (host.clipArmed) watch('voice.saveClip', s.saveClipBinding);
    return { ids, keys };
}
