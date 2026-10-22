// @vitest-environment jsdom
/**
 * Which voice hotkeys the desktop-global hook watches (api/hotkeyScope.ts).
 *
 * The regression this pins: a mute/deafen bind the user CHOSE that happens to
 * equal the shipped default was treated as untouched and left in-app only, so
 * the feed watched nothing. From outside: hotkeys work while Púca is focused
 * and die the moment another window has focus; hotkey_diag reads
 * active:false. Provenance is now recorded (`voiceBindsUserSet`); the value
 * comparison survives only as the fallback for older profiles.
 */
import { describe, it, expect } from 'vitest';
import { defaultSettings, type Settings } from '../components/settingsStore';
import { computeNativeWatch, voiceBindScope, markVoiceBindProvenance, isVoiceBindGlobal } from '../api/hotkeyScope';

const DEF_MUTE = defaultSettings.toggleMuteBinding!;
const DEF_DEAFEN = defaultSettings.toggleDeafenBinding!;
const F10 = { keyCode: 121, ctrl: false, alt: true, shift: false, label: 'F10' };
const F9 = { keyCode: 120, ctrl: false, alt: false, shift: false, label: 'F9' };
const settings = (over: Partial<Settings>): Settings => ({ ...defaultSettings, ...over });
const inCall = { afk: false, speakDenied: false, listenOnly: false, voiceInputMode: 'open' as const, clipArmed: false };

describe('computeNativeWatch — what the desktop-global hook is asked to watch', () => {
    it('THE BUG: a bind the user chose that equals the shipped default is watched system-wide', () => {
        const s = settings({ toggleMuteBinding: { ...DEF_MUTE }, voiceBindsUserSet: { toggleMuteBinding: true } });
        const w = computeNativeWatch(s, inCall);
        expect(w.ids).toContain('voice.toggleMute');
        expect(w.keys[w.ids.indexOf('voice.toggleMute')]).toBe(DEF_MUTE.keyCode);
        expect(voiceBindScope(s, 'toggleMuteBinding')).toBe('global:user-set');
    });

    it('an untouched shipped default stays in-app only (Ctrl+Shift+M/D belong to other apps too)', () => {
        const s = settings({});
        expect(computeNativeWatch(s, inCall)).toEqual({ ids: [], keys: [] });
        expect(voiceBindScope(s, 'toggleMuteBinding')).toBe('in-app:default');
    });

    it('the "from other apps" switch makes both defaults system-wide', () => {
        const s = settings({ globalVoiceHotkeys: true });
        expect(computeNativeWatch(s, inCall).ids).toEqual(['voice.toggleMute', 'voice.toggleDeafen']);
        expect(voiceBindScope(s, 'toggleDeafenBinding')).toBe('global:switch');
    });

    it('a stored bind that differs from the default is watched even without a record (profiles from before it existed)', () => {
        const s = settings({ toggleMuteBinding: F10 });
        expect(computeNativeWatch(s, inCall).ids).toEqual(['voice.toggleMute']);
        expect(voiceBindScope(s, 'toggleMuteBinding')).toBe('global:inferred');
    });

    it('Reset records the shipped default as not chosen: in-app only again', () => {
        const chosen = settings({ toggleMuteBinding: F10, voiceBindsUserSet: { toggleMuteBinding: true } });
        const reset = { ...markVoiceBindProvenance(chosen, 'toggleMuteBinding', false), toggleMuteBinding: { ...DEF_MUTE } };
        expect(isVoiceBindGlobal(reset, 'toggleMuteBinding')).toBe(false);
        expect(voiceBindScope(reset, 'toggleMuteBinding')).toBe('in-app:reset');
    });

    it('an unbound key is never watched, whatever the record or the switch says', () => {
        const s = settings({ toggleMuteBinding: null, voiceBindsUserSet: { toggleMuteBinding: true }, globalVoiceHotkeys: true });
        expect(computeNativeWatch(s, inCall).ids).toEqual(['voice.toggleDeafen']);
        expect(voiceBindScope(s, 'toggleMuteBinding')).toBe('unbound');
    });

    it('no mic keys in an AFK channel, or without SPEAK; the clip key still rides while armed', () => {
        const s = settings({ globalVoiceHotkeys: true, saveClipBinding: F9, pttBinding: F10 });
        for (const host of [{ afk: true, speakDenied: false, listenOnly: false }, { afk: false, speakDenied: true, listenOnly: true }]) {
            expect(computeNativeWatch(s, { ...host, voiceInputMode: 'pushToTalk', clipArmed: false }))
                .toEqual({ ids: [], keys: [] });
            expect(computeNativeWatch(s, { ...host, voiceInputMode: 'pushToTalk', clipArmed: true }))
                .toEqual({ ids: ['voice.saveClip'], keys: [F9.keyCode] });
        }
    });

    it('no microphone right now (listen-only): Toggle Mute and Toggle Deafen stay watched, the hold keys go', () => {
        // Mute decides whether the member comes back muted when a microphone
        // returns (VoicePanel toggleMute), from a game too; push-to-talk and
        // push-to-mute have no track to gate until one does.
        const s = settings({ globalVoiceHotkeys: true, pttBinding: F10, ptmBinding: F9 });
        const lo = { ...inCall, listenOnly: true };
        expect(computeNativeWatch(s, { ...lo, voiceInputMode: 'pushToTalk' }))
            .toEqual({ ids: ['voice.toggleMute', 'voice.toggleDeafen'], keys: [DEF_MUTE.keyCode, DEF_DEAFEN.keyCode] });
        expect(computeNativeWatch(s, { ...lo, voiceInputMode: 'pushToMute' }).ids).toEqual(['voice.toggleMute', 'voice.toggleDeafen']);
        // Control: the same call with a microphone watches the hold key too.
        expect(computeNativeWatch(s, { ...inCall, voiceInputMode: 'pushToTalk' }).ids).toEqual(['voice.toggleMute', 'voice.toggleDeafen', 'voice.ptt']);
        // A default left in-app stays in-app while listen-only as well.
        expect(computeNativeWatch(settings({}), lo)).toEqual({ ids: [], keys: [] });
    });

    it('push-to-talk / push-to-mute keys ride only in their own input mode', () => {
        const s = settings({ pttBinding: F10, ptmBinding: F9 });
        expect(computeNativeWatch(s, { ...inCall, voiceInputMode: 'open' }).ids).toEqual([]);
        expect(computeNativeWatch(s, { ...inCall, voiceInputMode: 'pushToTalk' })).toEqual({ ids: ['voice.ptt'], keys: [F10.keyCode] });
        expect(computeNativeWatch(s, { ...inCall, voiceInputMode: 'pushToMute' })).toEqual({ ids: ['voice.ptm'], keys: [F9.keyCode] });
    });

    it('ids and keys stay parallel (the Rust side is handed keys by index)', () => {
        const s = settings({ globalVoiceHotkeys: true, pttBinding: F10, saveClipBinding: F9 });
        const w = computeNativeWatch(s, { ...inCall, voiceInputMode: 'pushToTalk', clipArmed: true });
        expect(w.ids).toEqual(['voice.toggleMute', 'voice.toggleDeafen', 'voice.ptt', 'voice.saveClip']);
        expect(w.keys).toEqual([DEF_MUTE.keyCode, DEF_DEAFEN.keyCode, F10.keyCode, F9.keyCode]);
    });
});

describe('markVoiceBindProvenance', () => {
    it('records the field it is given and leaves the sibling alone', () => {
        const s = markVoiceBindProvenance(settings({ voiceBindsUserSet: { toggleDeafenBinding: true } }), 'toggleMuteBinding', true);
        expect(s.voiceBindsUserSet).toEqual({ toggleDeafenBinding: true, toggleMuteBinding: true });
    });

    it('is a no-op for binds whose scope does not depend on provenance', () => {
        const s = settings({});
        expect(markVoiceBindProvenance(s, 'pttBinding', true)).toBe(s);
    });
});
