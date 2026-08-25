import { describe, it, expect } from 'vitest';
import { shouldNotify, type NotifyInput } from '../api/desktopNotify';

/**
 * `desktopNotifications` requested browser permission and then nothing ever
 * called `new Notification()` — the toggle, and the permission the user
 * granted, did nothing.
 *
 * Every suppression rule lives in a pure function so it can be tested without a
 * browser, and so the REASON a notification did not appear is inspectable
 * rather than being a silent early return.
 */

const base: NotifyInput = {
    isOwn: false,
    isMuted: false,
    hasFocus: false,
    permission: 'granted',
    setting: true,
    mobile: false,
    mobileNative: false,
};

describe('desktop notification rules', () => {
    it('fires for someone else\'s message while the window is unfocused', () => {
        expect(shouldNotify(base)).toEqual({ fire: true });
    });

    it('stays quiet while you are looking at the app', () => {
        // The in-app sound and unread state already cover this; an OS toast
        // over the window you are using is just noise.
        expect(shouldNotify({ ...base, hasFocus: true })).toEqual({ fire: false, reason: 'focused' });
    });

    it('respects the setting being off', () => {
        expect(shouldNotify({ ...base, setting: false })).toEqual({ fire: false, reason: 'setting-off' });
    });

    it('never fires without permission', () => {
        expect(shouldNotify({ ...base, permission: 'denied' })).toEqual({ fire: false, reason: 'no-permission' });
        expect(shouldNotify({ ...base, permission: 'default' })).toEqual({ fire: false, reason: 'no-permission' });
        expect(shouldNotify({ ...base, permission: 'unsupported' })).toEqual({ fire: false, reason: 'no-permission' });
    });

    it('never notifies you about your own message', () => {
        expect(shouldNotify({ ...base, isOwn: true })).toEqual({ fire: false, reason: 'own-message' });
    });

    it('respects a muted server or channel', () => {
        expect(shouldNotify({ ...base, isMuted: true })).toEqual({ fire: false, reason: 'muted' });
    });

    it('never fires on mobile WITHOUT a native path (iOS, web, an old APK)', () => {
        expect(shouldNotify({ ...base, mobile: true })).toEqual({ fire: false, reason: 'mobile' });
    });

    it('fires on mobile WITH the native path, under the same gates', () => {
        const native = { ...base, mobile: true, mobileNative: true };
        expect(shouldNotify(native)).toEqual({ fire: true });
        // The native path does not bypass a single suppression rule.
        expect(shouldNotify({ ...native, hasFocus: true })).toEqual({ fire: false, reason: 'focused' });
        expect(shouldNotify({ ...native, isMuted: true })).toEqual({ fire: false, reason: 'muted' });
        expect(shouldNotify({ ...native, setting: false })).toEqual({ fire: false, reason: 'setting-off' });
        expect(shouldNotify({ ...native, isOwn: true })).toEqual({ fire: false, reason: 'own-message' });
    });

    it('mobileNative on a NON-mobile platform changes nothing', () => {
        expect(shouldNotify({ ...base, mobileNative: true })).toEqual({ fire: true });
    });

    /**
     * Order matters for diagnosis, not just behaviour: a user who has the
     * setting off AND no permission should be told the setting is off, because
     * that is the one they can act on first.
     */
    it('reports the most actionable reason when several apply', () => {
        const decision = shouldNotify({
            ...base, mobile: false, setting: false, permission: 'denied', isOwn: true,
        });
        expect(decision).toEqual({ fire: false, reason: 'setting-off' });
    });

    it('suppresses on focus even when everything else would allow it', () => {
        // The regression that matters: focus is read fresh at fire time. If a
        // future change caches it, this is the case that should start failing.
        expect(shouldNotify({ ...base, hasFocus: true, isMuted: false, setting: true }))
            .toEqual({ fire: false, reason: 'focused' });
    });
});
