/**
 * Wires this device into NATIVE background delivery — the self-hosted
 * replacement for the FCM integration that was built and then removed on
 * principle (a privacy product must not route who-messaged-whom metadata
 * through Google, even opt-in).
 *
 * The native socket (NativeDelivery, in KeepAliveService) connects to OUR
 * server as a second authenticated session and posts notifications from Java,
 * immune to the WebView throttling that killed the original in-app socket.
 * It needs three things from JS, none of which Java can reach itself:
 *
 *  1. CREDENTIALS — the WS URL and the session JWT (WebView storage). Synced
 *     on login and on every sliding-session renewal ('authTokenRenewed'),
 *     or the native copy expires ~24h after login and delivery silently dies.
 *  2. GATES — mutes, blocks, the master toggle — mirrored into PushPrefs on
 *     every change. The native handler reads ONLY the mirror; stale means
 *     push stops honouring mutes, which is worse than no push.
 *  3. THE ACCOUNT — so a frame from a stale socket can never surface after
 *     this phone switches users.
 *
 * Everything degrades to exactly today's behaviour on an old APK, off
 * Android, or signed out.
 */
import { WS_URL } from './config';
import { apiClient } from './client';
import { getToken, decodeJwtPayload } from './auth';
import { loadSettings } from '../components/settingsStore';
import { getMutedServers } from '../components/mutedServersStore';
import { getMutedChannels } from '../components/mutedChannelsStore';
import { getBlockedIds } from '../components/blockStore';
import {
    getMobileWakeToken,
    disableMobileWake,
    setMobileNativeDelivery,
    setMobilePushAccount,
    syncMobilePushGates,
} from './mobileApp';
import { thisDeviceId } from './thisDevice';
import { isMobile } from './platform';

let teardownEvents: (() => void) | null = null;

function currentUserId(): number | null {
    const t = getToken();
    if (!t) return null;
    const claims = decodeJwtPayload(t);
    const sub = claims?.sub;
    return typeof sub === 'number' ? sub : null;
}

/** Push the CURRENT gate state into the native mirror. Cheap and idempotent. */
async function syncGates(): Promise<void> {
    await syncMobilePushGates({
        mutedServers: getMutedServers(),
        mutedChannels: getMutedChannels(),
        blockedIds: [...getBlockedIds()],
        // The master mobile-notifications toggle governs the native path too:
        // one switch, both paths, no state where they disagree.
        pushEnabled: loadSettings().mobileNotifications !== false,
        // Mirrored SEPARATELY from pushEnabled (which PushGate reads as the
        // master switch) so the wake service can refuse a doorbell on the
        // device itself. Belt to the credential teardown's braces: a lost
        // unregister, or a server still holding the row, then cannot
        // resurrect delivery against the user's choice.
        backgroundDelivery: loadSettings().mobileBackgroundDelivery !== false,
    });
}

/**
 * Hand the native socket the current URL + token, plus this device's id so
 * "sign out this device" can hang the socket up server-side (a kill-only
 * claim; the socket never attests).
 *
 * This ALWAYS crosses the bridge. Deciding whether the credentials actually
 * changed — and therefore whether to drop and redial the socket — belongs to
 * the native side (DeliveryCreds), which is the only half that knows what the
 * socket currently holds. A JS-side "have we already synced this?" cache is
 * wrong here even though it looks like a free saving: the native credentials
 * can be cleared without JS ever hearing about it (NativeDelivery.authDead
 * wipes them on a 401), and a cache would then suppress the very re-sync that
 * recovers from it, leaving delivery dead until the next token renewal or app
 * restart. The bridge call is cheap; the redial it guards is not.
 */
async function syncDeliveryCreds(): Promise<void> {
    const token = getToken();
    if (!token) return;
    // The user's background-delivery opt-out is absolute: an opted-out phone
    // hands the native socket nothing and registers no doorbell address — it
    // is not addressable at all, not merely quiet.
    const s = loadSettings();
    if (s.mobileBackgroundDelivery === false || s.mobileNotifications === false) {
        await setMobileNativeDelivery(null);
        return;
    }
    await setMobileNativeDelivery({ wsUrl: WS_URL, token, deviceId: thisDeviceId() });
}

/**
 * Make the whole delivery stack agree with the current settings — credentials
 * AND the doorbell address, in both directions.
 *
 * This is what a settings change runs. Before it existed, `settingsChanged`
 * only refreshed the gate mirror: turning "deliver in the background" OFF left
 * the native credentials in place and the wake token registered, so the phone
 * stayed addressable and kept being woken against the user's explicit choice.
 * The teardown the wake service's own comment described was never implemented
 * on this side.
 */
async function reconcileDelivery(): Promise<void> {
    await syncDeliveryCreds();
    const s = loadSettings();
    if (s.mobileBackgroundDelivery === false || s.mobileNotifications === false) {
        await unregisterWakeToken();
        // ...and stop registering with Google at all. Dropping only the server
        // row left the phone registered with FCM after the user switched
        // background delivery off — the setting stopped the doorbell RINGING
        // while the registration it exists for stayed live, which is not what
        // "off" means to the person who chose it. Safe to await, unlike
        // getMobileWakeToken: disableWake resolves without waiting on a
        // Firebase Task, so it cannot hang a no-Play-Services build.
        await disableMobileWake();
    } else {
        // Unawaited for the same reason as at init: this can sit on a Firebase
        // promise that never settles.
        void registerWakeToken();
    }
}

/** The token this session registered, so logout can unregister exactly it. */
let registeredWakeToken: string | null = null;

/**
 * Register the wake-doorbell address with the server. The token is the only
 * fact about this phone that ever reaches Google — the signal it addresses is
 * a constant. Best-effort at every step: no Firebase in the build, an old
 * APK, or an old server all degrade to socket-only delivery.
 */
async function registerWakeToken(): Promise<void> {
    const optedOut = () => {
        const s = loadSettings();
        return s.mobileBackgroundDelivery === false || s.mobileNotifications === false;
    };
    if (optedOut()) return;
    // Already registered: the only thing that would change the address is a
    // token rotation, and onNewToken parks those for the next app start. Skip
    // BEFORE the bridge call — `settingsChanged` fires for every setting in
    // the app (theme, font size), and getMobileWakeToken can sit forever on a
    // Firebase promise that never settles on a no-Play-Services build.
    if (registeredWakeToken) return;
    const token = await getMobileWakeToken();
    if (!token || token === registeredWakeToken) return;
    // Re-check AFTER the await: the user can opt out while the token call is
    // in flight, and an unregister that ran during that window found nothing
    // to unregister. Without this, opt-out then leaves the phone addressable.
    if (optedOut()) return;
    try {
        await apiClient.post('/device/register', {
            token,
            platform: 'android',
            device_name: 'Android',
        });
        registeredWakeToken = token;
    } catch (err) {
        // Old server or offline: retry rides the next app start.
        console.warn('[wake] token registration failed:', err);
    }
}

/**
 * Stop the doorbell addressing this phone, and RELEASE the registration latch
 * so a later opt-in can register again.
 *
 * The latch is released whatever the request does: leaving it set after a
 * failed unregister would make the next opt-in a silent no-op — the exact
 * one-way-latch shape that has bitten this codebase before. Re-registering a
 * token the server still holds is idempotent, so releasing early is the safe
 * direction to be wrong in.
 */
async function unregisterWakeToken(): Promise<void> {
    const token = registeredWakeToken;
    if (!token) return;
    registeredWakeToken = null;
    try {
        await apiClient.delete('/device/unregister', {
            body: JSON.stringify({ token, platform: 'android' }),
        });
    } catch {
        // The server's dead-token pruning is the backstop.
    }
}

/**
 * Start native delivery for the signed-in account. Idempotent; safe to call
 * on every login and app start. No-op off Android.
 */
export async function initPushRegistration(): Promise<void> {
    if (!isMobile()) return;
    const userId = currentUserId();
    if (userId === null) return;

    await setMobilePushAccount(userId);
    await syncGates();
    await syncDeliveryCreds();
    // Fire-and-forget, and deliberately LAST-and-unawaited: this call can sit
    // on a Firebase promise that never settles (no Play Services variants),
    // and awaiting it would leave the mute/block listeners below uninstalled
    // for the whole session — a stale gate mirror over a wedged doorbell.
    void registerWakeToken();

    // Keep the mirror fresh. Every store already announces its writes on
    // window events, so subscribing here needs no store changes.
    if (!teardownEvents) {
        const onGateChange = () => { void syncGates(); };
        // A settings change can flip background delivery itself, which the
        // gate mirror alone cannot act on: the credentials and the doorbell
        // address have to follow, in both directions.
        const onSettingsChange = () => { void syncGates(); void reconcileDelivery(); };
        const onTokenRenewed = () => { void syncDeliveryCreds(); };
        // Attestation is when thisDeviceId() becomes real — usually AFTER the
        // first credential sync, which therefore carried no device claim. This
        // re-sync is what makes "sign out this device" able to reach the
        // delivery socket; without it the claim was null on nearly every boot.
        const onAttested = () => { void syncDeliveryCreds(); };
        window.addEventListener('deviceAttested', onAttested);
        window.addEventListener('serverMuteChanged', onGateChange);
        window.addEventListener('channelMuteChanged', onGateChange);
        window.addEventListener('blockedUsersChanged', onGateChange);
        window.addEventListener('settingsChanged', onSettingsChange);
        window.addEventListener('authTokenRenewed', onTokenRenewed);
        teardownEvents = () => {
            window.removeEventListener('serverMuteChanged', onGateChange);
            window.removeEventListener('channelMuteChanged', onGateChange);
            window.removeEventListener('blockedUsersChanged', onGateChange);
            window.removeEventListener('settingsChanged', onSettingsChange);
            window.removeEventListener('authTokenRenewed', onTokenRenewed);
            window.removeEventListener('deviceAttested', onAttested);
        };
    }
}

/**
 * Stop native delivery: clear the credentials and the account binding so the
 * socket idles and nothing can surface for an account that signed out. The
 * next account inherits neither gates nor token.
 */
export async function teardownPushRegistration(): Promise<void> {
    if (!isMobile()) return;
    teardownEvents?.();
    teardownEvents = null;
    // BEFORE the JWT drops (the caller sequences this): the doorbell must stop
    // addressing a phone whose account signed out.
    await unregisterWakeToken();
    // And stop this device registering with Google at all. The consent gate was
    // one-way — wakeToken() enabled Firebase auto-init and nothing ever turned
    // it off — so a phone stayed registered with FCM after sign-out or after
    // background delivery was switched off. Consent granted once and never
    // revocable is not consent. See [[one-way-latch]] in this repo's history:
    // the same shape has bitten it before.
    await disableMobileWake();
    await setMobileNativeDelivery(null);
    await setMobilePushAccount(null);
}
