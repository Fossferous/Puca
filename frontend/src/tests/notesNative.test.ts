/**
 * Púca Notes' native bridge (notes/native/notesNative.ts): it must never
 * throw, it must degrade to today's behaviour where there is no plugin (the
 * browser, an older Notes APK), and the token hand-back from the background
 * job must only ever move a session FORWARD — same account, longer life —
 * never resurrect a signed-out page or swap in another account.
 *
 * The plugin is a fake behind a mocked @capacitor/core; `pluginPresent`
 * flips between "Android app with NotesNative" and "no plugin", which is
 * each test's positive/negative control against the other.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let pluginPresent = true;
const fake = {
    info: vi.fn(async () => ({ api: 1, features: ['reminders'] })),
    syncReminders: vi.fn(async () => ({ count: 0 })),
    clearAll: vi.fn(async () => undefined),
    setBackgroundRefresh: vi.fn(async () => ({ scheduled: true })),
    takeRenewedToken: vi.fn(async (): Promise<{ token: string | null; account: string | null }> => ({ token: null, account: null })),
    shareText: vi.fn(async () => ({ ok: true })),
    addToPhoneCalendar: vi.fn(async (): Promise<{ ok: boolean; reason?: string }> => ({ ok: true })),
    consumeLaunchNav: vi.fn(async () => ({ target: 'reminders' })),
    notificationStatus: vi.fn(async () => ({ granted: false, needsRequest: true, blocked: false })),
};

vi.mock('@capacitor/core', () => ({
    Capacitor: {
        getPlatform: () => (pluginPresent ? 'android' : 'web'),
        isPluginAvailable: (name: string) => pluginPresent && name === 'NotesNative',
        isNativePlatform: () => pluginPresent,
    },
    registerPlugin: () => fake,
}));

const nn = await import('../notes/native/notesNative');

function b64url(s: string): string {
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function jwt(payload: Record<string, unknown>): string {
    return `${b64url('{"alg":"HS256"}')}.${b64url(JSON.stringify(payload))}.sig`;
}

beforeEach(() => {
    pluginPresent = true;
    for (const f of Object.values(fake)) f.mockClear();
});

describe('pickAdoptableToken', () => {
    const cur = jwt({ sub: 7, exp: 1_800_000_000 });
    it('adopts a renewal of the same account that lives longer (positive control)', () => {
        const renewed = jwt({ sub: 7, exp: 1_800_086_400 });
        expect(nn.pickAdoptableToken(cur, renewed)).toBe(renewed);
    });
    it('never takes a staler token of the same account', () => {
        expect(nn.pickAdoptableToken(cur, jwt({ sub: 7, exp: 1_700_000_000 }))).toBeNull();
    });
    it('never takes another account', () => {
        expect(nn.pickAdoptableToken(cur, jwt({ sub: 8, exp: 1_900_000_000 }))).toBeNull();
    });
    it('never signs a signed-out page back in', () => {
        expect(nn.pickAdoptableToken(null, jwt({ sub: 7, exp: 1_900_000_000 }))).toBeNull();
    });
    it('ignores garbage', () => {
        expect(nn.pickAdoptableToken(cur, 'not-a-token')).toBeNull();
    });
});

describe('adoptNativeRenewedToken', () => {
    it('hands a longer-lived token of the same account to the store', async () => {
        const cur = jwt({ sub: 7, exp: 1_800_000_000 });
        const renewed = jwt({ sub: 7, exp: 1_800_086_400 });
        fake.takeRenewedToken.mockResolvedValueOnce({ token: renewed, account: '7' });
        const store = vi.fn();
        await expect(nn.adoptNativeRenewedToken(() => cur, store)).resolves.toBe(true);
        expect(store).toHaveBeenCalledWith(cur, renewed);
    });
    it('does nothing without the plugin', async () => {
        pluginPresent = false;
        const store = vi.fn();
        await expect(nn.adoptNativeRenewedToken(() => 'x', store)).resolves.toBe(false);
        expect(fake.takeRenewedToken).not.toHaveBeenCalled();
        expect(store).not.toHaveBeenCalled();
    });
    it('does nothing when the plugin call rejects (older APK)', async () => {
        fake.takeRenewedToken.mockRejectedValueOnce(new Error('not implemented'));
        const store = vi.fn();
        await expect(nn.adoptNativeRenewedToken(() => jwt({ sub: 7, exp: 1 }), store)).resolves.toBe(false);
        expect(store).not.toHaveBeenCalled();
    });
});

describe('degrading without the plugin', () => {
    it('answers unsupported instead of throwing', async () => {
        pluginPresent = false;
        await expect(nn.syncNativeReminders('7', [{ id: 1, at: 1, mark: 'm' }])).resolves.toEqual({ ok: false, reason: 'unsupported' });
        await expect(nn.shareText({ filename: 'a.md', mime: 'text/plain', text: 'x' })).resolves.toEqual({ ok: false, reason: 'unsupported' });
        await expect(nn.addToPhoneCalendar({ title: 't', beginMs: 1 })).resolves.toEqual({ ok: false, reason: 'unsupported' });
        await expect(nn.nativeNotificationStatus()).resolves.toBeNull();
        await expect(nn.consumeNativeLaunchNav()).resolves.toBeNull();
        await expect(nn.clearNativeSession()).resolves.toBeUndefined();
        expect(nn.notesNativeAvailable()).toBe(false);
        for (const f of Object.values(fake)) expect(f).not.toHaveBeenCalled();
    });

    it('with the plugin, the same calls reach it (positive control)', async () => {
        await expect(nn.syncNativeReminders('7', [{ id: 1, at: 1, mark: 'm' }])).resolves.toEqual({ ok: true });
        expect(fake.syncReminders).toHaveBeenCalledWith({ account: '7', entries: [{ id: 1, at: 1, mark: 'm' }] });
        await expect(nn.consumeNativeLaunchNav()).resolves.toBe('reminders');
        await nn.clearNativeSession();
        expect(fake.clearAll).toHaveBeenCalledTimes(1);
    });

    it('a rejecting method (older APK) is a failure answer, not a throw', async () => {
        fake.addToPhoneCalendar.mockRejectedValueOnce(new Error('method not implemented'));
        await expect(nn.addToPhoneCalendar({ title: 't', beginMs: 1 })).resolves.toEqual({ ok: false, reason: 'unsupported' });
        fake.addToPhoneCalendar.mockResolvedValueOnce({ ok: false, reason: 'no calendar app on this phone' });
        await expect(nn.addToPhoneCalendar({ title: 't', beginMs: 1 })).resolves.toEqual({ ok: false, reason: 'no calendar app on this phone' });
    });

    it('clearing the background refresh sends nulls, not a stale token', async () => {
        await nn.setNativeBackgroundRefresh(null);
        expect(fake.setBackgroundRefresh).toHaveBeenCalledWith({ apiBase: null, token: null, account: null });
    });
});
