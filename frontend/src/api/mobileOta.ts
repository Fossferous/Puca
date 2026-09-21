/**
 * The mobile OTA engine — check, refuse, download, verify, apply — shared by
 * Púca's UpdateGate (channels 'full' and 'lite') and Púca Notes'
 * NotesUpdateGate (channel 'notes').
 *
 * This is UpdateGate's former checkCapacitorUpdates moved here unchanged; the
 * only new inputs are the channel (which query string to ask and which
 * manifest tag to accept), the failure text (which names the app), a log tag,
 * and an optional hook that sees an accepted manifest before anything is
 * downloaded. src/tests/updateGateOtaPins.test.tsx pinned Púca's behaviour
 * against the inline version before the move and still passes against this.
 *
 * The one invariant, inherited: it may DELAY the app, it may never HOLD it.
 * Every phase is bounded and every failure ends in `upToDate` (the app runs on
 * the bundle it has) or `error` (a screen with a control).
 *
 * Three independent layers keep one app's bundle out of the other:
 *   1. the channel tag, checked HERE, client-side (otaChannelMatches) — an old
 *      server answers `?variant=notes` with Púca's full manifest;
 *   2. the signing key: Notes' APK embeds a different RSA public key, so a
 *      Púca bundle cannot even decrypt inside Notes, whatever the manifest says;
 *   3. publish-side: deploy/mobile/encrypt-bundle.mjs refuses a bundle whose
 *      version.json names the other app, and dual-ship.sh demands the tag.
 */
import { otaChannelMatches, isTrustedBundleUrl, shouldApplyOtaVersion, bundleLabelDisagrees, type OtaChannel } from '../components/updateGate.utils';
import { updateCheckBases } from './updateCheckBases';

export type { OtaChannel } from '../components/updateGate.utils';

/** Per-base bound on the update-check fetch. Without one, a HUNG connection
 *  (stalled TLS, captive portal, mid-handover radio — normal phone states)
 *  held the gate forever, and worse: the fallback-base loop only advances on
 *  a THROW, so a hung PRIMARY meant the hardcoded production fallback — the
 *  whole 0.8.24/25 self-healing mechanism — was never even tried. */
export const CHECK_FETCH_TIMEOUT_MS = 8_000;
/** Hard deadline on the whole CHECK phase. The gate's one invariant: it may
 *  delay the app, it may never hold it — past this, we continue on the
 *  bundle we already have and let the next launch try again. */
export const CHECKING_DEADLINE_MS = 15_000;
/** A download whose progress hasn't ADVANCED for this long is stalled. Real
 *  downloads on slow links can legitimately take minutes — bounding total
 *  time would break them; bounding silence doesn't. */
export const DOWNLOAD_STALL_MS = 45_000;

/** fetch bounded by an AbortController (AbortSignal.timeout is missing from
 *  some WebViews and from the test runtime). */
export async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
        return await fetch(url, { signal: ctrl.signal });
    } finally {
        clearTimeout(timer);
    }
}

export type OtaStatus = 'checking' | 'downloading' | 'ready' | 'error' | 'upToDate';

export interface OtaUiState {
    status: OtaStatus;
    progress: number;
    version: string | null;
    error: string | null;
}

export type OtaSetState = (update: (s: OtaUiState) => OtaUiState) => void;

/** What /api/mobile-updates/check answers. Unsigned: every field is a claim
 *  until the plugin verifies the bundle bytes against the APK's key. */
export interface OtaManifest {
    version?: string;
    url?: string;
    checksum?: string;
    sessionKey?: string;
    /** Which build this bundle is for. Absent means the full build,
     *  because every manifest published before lite existed omits it. */
    variant?: string;
    /** Notes only: the APK the bundle expects. `min` = the oldest APK that
     *  can run it (it needs a native plugin older ones lack); `version` = the
     *  newest APK on the download page. */
    native?: { version?: string; min?: string; download_url?: string };
}

export interface OtaManifestContext {
    /** The update-check base that answered — the only base a URL in the
     *  manifest may be trusted against. */
    answeringBase: string;
    /** The version the running bytes were built as. */
    runningVersion: string;
    /** The APK's own versionName, from the plugin; null if it did not say. */
    nativeVersion: string | null;
}

/** How a run ended, for callers that report it (Notes' "Check for updates").
 *  Púca's gate ignores it — its screen is driven entirely by setState. */
export type OtaOutcome =
    | 'unreachable'   // no base answered, or the answer was not a manifest
    | 'deadline'      // the check phase ran out of time
    | 'nothing'       // nothing published, or not newer than what runs
    | 'refused'       // a manifest that failed a safety check
    | 'held'          // the caller's onManifest hook declined it
    | 'applying'      // set() was called: the app is reloading
    | 'failed';       // download/verify/apply failed, or stalled

export interface RunCapacitorOtaOptions {
    channel: OtaChannel;
    setState: OtaSetState;
    /** The error-screen text when a download fails verification or install. */
    verifyFailedMessage: string;
    /** Console prefix, so a log says which app's gate spoke. */
    logTag?: string;
    /** Sees a manifest that passed the channel check, BEFORE the version
     *  comparison. Return false to stop here without downloading. */
    onManifest?: (manifest: OtaManifest, ctx: OtaManifestContext) => boolean;
}

export async function runCapacitorOta(opts: RunCapacitorOtaOptions): Promise<OtaOutcome> {
    const { channel, setState, verifyFailedMessage, onManifest } = opts;
    const tag = opts.logTag ?? '[UpdateGate]';
    const { CapacitorUpdater } = await import('@capgo/capacitor-updater');

    // The gate's invariant: it may DELAY the app, it may never HOLD it.
    // Whatever phase 1 is stuck in when this fires — a native call that
    // never answers, a fetch a stalled connection keeps open — the app
    // proceeds on the bundle it already has. `gaveUp` makes the stuck
    // work a no-op if it ever does finish.
    const gaveUp = { value: false };
    const checkingDeadline = setTimeout(() => {
        gaveUp.value = true;
        console.warn(`${tag} check exceeded its deadline — continuing on the current bundle`);
        setState(s => (s.status === 'checking' ? { ...s, status: 'upToDate' } : s));
    }, CHECKING_DEADLINE_MS);

    // Phase 1 — the CHECK. Any failure here (offline, server down, bad
    // response) is non-fatal: keep the current bundle and load the app.
    let updateInfo: OtaManifest;
    let currentVersion: string;
    /** Running the bundle baked into the APK (no OTA has applied). */
    let runningBuiltin = true;
    /** The APK's versionName as the plugin reports it. */
    let nativeVersion: string | null = null;
    /** The update-check base that actually answered — the only base the
     *  bundle URL may be trusted against. '' until one answers. */
    let answeringBase = '';
    try {
        // Blessed at the entry point too (main.tsx — see the comment
        // there: the native appReadyTimeout rollback must not wait for
        // this component). Idempotent, kept for the retry path.
        await CapacitorUpdater.notifyAppReady();
        const currentBundle = await CapacitorUpdater.current();
        const bundleLabel = currentBundle?.bundle?.version || '';
        const nativeLabel = (currentBundle as { native?: unknown } | undefined)?.native;
        nativeVersion = typeof nativeLabel === 'string' && nativeLabel ? nativeLabel : null;
        // The builtin bundle is identified by its ID, never by the version
        // label: the plugin also reports the literal "builtin" as the
        // version of any bundle whose stored version is null (BundleInfo's
        // getVersionName fallback), so keying on the label would treat an
        // OTA bundle with lost metadata as the APK's own. An unexpected
        // shape (no id) therefore reads as NOT builtin, which fails closed:
        // only a strictly newer manifest applies.
        runningBuiltin = currentBundle?.bundle?.id === 'builtin';
        // The version the running BYTES were built as — never the label the
        // manifest gave them. The plugin's `bundle.version` is whatever the
        // manifest said, and the manifest is unsigned: recording it as "what
        // I am running" meant one mislabelled manifest (a replayed old bundle
        // under a higher number, or a typo in dual-ship.sh) made every genuine
        // later release read as "<= current" until an APK reinstall
        // (0.9.810 audit, C-04). See shouldApplyOtaVersion for what this
        // does and does not buy.
        currentVersion = __APP_VERSION__;
        if (bundleLabelDisagrees(bundleLabel, __APP_VERSION__)) {
            console.error(
                `${tag} MISLABELLED OTA: the running bundle was labelled ${bundleLabel} by its manifest `
                + `but was built as ${__APP_VERSION__}. A replayed or mistyped manifest; comparing future `
                + 'updates against the bytes, not the label.',
            );
        }
        console.log(`${tag} Running`, currentVersion, runningBuiltin ? '(APK builtin bundle)' : `(OTA bundle labelled ${bundleLabel})`);

        // Configured base first, then the hardcoded production fallback: a
        // bundle built without .env.production points at localhost and
        // would otherwise NEVER see the fixed OTA (the 0.8.24/25
        // stranding — notifyAppReady above already blessed the broken
        // bundle, so Capgo won't roll back either). Safe here because the
        // bundle is RSA-verified against the key baked into the APK.
        // Each attempt is TIME-BOUND: an abort advances the loop exactly
        // like a refusal, so a hung base can no longer mask the fallback.
        const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3000';
        let checkResponse: Response | null = null;
        for (const base of updateCheckBases(API_BASE)) {
            try {
                // The OTA pushes a JS BUNDLE into an installed APK, so a
                // lite install served the full manifest would receive the
                // whole remote-control frontend over the air and the
                // guarantee would evaporate after shipping. Ask for this
                // build's channel; the refusal below is what enforces it,
                // since an older server ignores the parameter.
                const checkUrl = `${base}/api/mobile-updates/check`
                    + (channel === 'full' ? '' : `?variant=${channel}`);
                const res = await fetchWithTimeout(checkUrl, CHECK_FETCH_TIMEOUT_MS);
                // A 404 (nothing published) or 204 is a real answer from a
                // server that serves this route, and it is final. Any OTHER
                // non-2xx means whatever answered is not serving manifests
                // — a proxy's 502, an origin lock's 403, or, in the exact
                // mis-build this loop exists for, whatever happens to be
                // listening on localhost:3000 — so it must not end the
                // search: treat it like an unreachable base and move on.
                if (!res.ok && res.status !== 404 && res.status !== 204) {
                    console.warn(`${tag} check via ${base} answered ${res.status} — trying the next base`);
                    continue;
                }
                checkResponse = res;
                // The base that ANSWERED is the one the bundle URL is held
                // against below. Holding it against the configured base
                // instead refused every manifest the fallback ever fetched:
                // the fallback only runs when the configured base is wrong
                // or absent, and an absent base fails the trust check
                // closed — so the recovery path could fetch a manifest and
                // then never apply it.
                answeringBase = base;
                break;
            } catch (err) {
                console.warn(`${tag} check via ${base} unreachable:`, err);
            }
        }
        if (!checkResponse || !checkResponse.ok) {
            setState(s => ({ ...s, status: 'upToDate' }));
            return checkResponse ? 'nothing' : 'unreachable';
        }
        updateInfo = await checkResponse.json();
    } catch (error) {
        console.warn(`${tag} Update check failed (continuing on current bundle):`, error);
        setState(s => ({ ...s, status: 'upToDate' }));
        return 'unreachable';
    } finally {
        clearTimeout(checkingDeadline);
    }

    // The deadline already waved the app through — applying an update
    // UNDER the running app now would yank a live session through a
    // reload. The next launch gets a fresh, faster attempt.
    if (gaveUp.value) return 'deadline';

    if (!updateInfo || !updateInfo.url || !updateInfo.version) {
        setState(s => ({ ...s, status: 'upToDate' }));
        return 'nothing';
    }

    // CHANNEL MUST MATCH, and this is checked CLIENT-SIDE on purpose.
    //
    // Requesting ?variant=lite (or =notes) protects nothing by itself: a
    // server that predates the variant ignores the parameter and answers with
    // the ordinary manifest, which would install the full remote-control
    // bundle into a lite app — or Púca itself into Púca Notes. So the client
    // refuses anything that is not its own channel.
    //
    // Absent means FULL — every manifest published before lite existed has
    // no variant field, and those are full bundles. That asymmetry is why
    // the comparison is written against the expected value rather than by
    // testing for the string 'lite'; and why 'notes' must match EXACTLY.
    if (!otaChannelMatches(updateInfo.variant, channel)) {
        console.warn(
            `${tag} Refusing a "${updateInfo.variant ?? 'full'}" bundle: this is the `
            + `"${channel}" build. Publish a matching manifest for this channel.`,
        );
        setState(s => ({ ...s, status: 'upToDate' }));
        return 'refused';
    }

    if (onManifest && !onManifest(updateInfo, { answeringBase, runningVersion: currentVersion, nativeVersion })) {
        setState(s => ({ ...s, status: 'upToDate' }));
        return 'held';
    }

    // Anti-rollback against the RUNNING BYTES' own version: strictly newer,
    // or the same version when we are still on the APK's builtin bundle.
    // The Capgo signature authenticates the bundle bytes but NOT the
    // advertised version, so a lower-numbered manifest must never apply;
    // and the previous 'builtin' placeholder parsed as the oldest version
    // of all, so a fresh install accepted ANY signed bundle, however old.
    if (!shouldApplyOtaVersion(updateInfo.version, currentVersion, runningBuiltin)) {
        console.log(`${tag} Manifest version`, updateInfo.version, 'is not newer than the running build', currentVersion, '- not applying');
        setState(s => ({ ...s, status: 'upToDate' }));
        return 'nothing';
    }

    // The bundle URL must be HTTPS and on the same site as the base that
    // answered the check — never follow a manifest that points the download
    // at an arbitrary/plaintext host. The same-site rule still means
    // something with the fallback: that base is operator-set build-time
    // config, not something the manifest chose. Only the answering base
    // is passed, never a default: an unknown base fails closed in
    // isTrustedBundleUrl, and that branch is right for a base nobody
    // configured.
    if (!isTrustedBundleUrl(updateInfo.url, answeringBase)) {
        console.error(`${tag} Refusing untrusted bundle URL ${updateInfo.url} (manifest came from ${answeringBase || 'an unknown base'})`);
        setState(s => ({ ...s, status: 'upToDate' }));
        return 'refused';
    }

    // SIGNATURE IS MANDATORY. Our capacitor.config ships an updater
    // publicKey, so every legitimate bundle is AES-encrypted with an
    // RSA-wrapped session key AND carries an RSA-signed SHA-256. The Capgo
    // plugin only RUNS the RSA checksum verification inside its `sessionKey`
    // branch (CapgoUpdater.download): a manifest that supplies a plain
    // checksum and OMITS sessionKey is installed with NO signature check at
    // all. A compromised/malicious manifest server could exploit that to
    // ship an UNSIGNED bundle — remote code execution on every client. So
    // refuse to download unless BOTH the RSA-wrapped session key and the
    // signed checksum are present, and forward them UNCONDITIONALLY below so
    // the plugin can only ever take its verifying path. Our release pipeline
    // (dual-ship.sh) always emits both; a manifest lacking either is not one
    // we produced.
    if (!updateInfo.sessionKey || !updateInfo.checksum) {
        console.error(`${tag} Refusing UNSIGNED OTA bundle — missing sessionKey/checksum`);
        setState(s => ({ ...s, status: 'upToDate' }));
        return 'refused';
    }

    // Phase 2 — the APPLY. A failure here means an update WAS advertised but
    // couldn't be downloaded/verified/installed. Unlike a check failure this
    // is surfaced (not silently swallowed): most commonly it's an old APK
    // that lacks the signing key and can't consume signed bundles — which
    // only a reinstall fixes. The app still loads via "Continue Anyway".
    let dlListener: { remove: () => Promise<void> } | undefined;
    // Silence detector, not a total-time cap: a slow link may legitimately
    // take minutes, but its progress events keep arriving. A transfer
    // whose LAST advance is DOWNLOAD_STALL_MS ago is wedged, and without
    // this it pinned the gate at N% forever with no control on screen.
    let lastAdvanceAt = Date.now();
    let lastPct = -1;
    let stalled = false;
    const stallWatchdog = setInterval(() => {
        if (Date.now() - lastAdvanceAt < DOWNLOAD_STALL_MS) return;
        stalled = true;
        clearInterval(stallWatchdog);
        console.error(`${tag} download stalled — surfacing instead of holding the gate`);
        setState(s => ({
            ...s,
            status: 'error',
            error: 'The update download stalled. Check your connection and retry, or continue on the current version — the update will be offered again next launch.',
        }));
    }, 5_000);
    try {
        console.log(`${tag} Updating from`, currentVersion, 'to', updateInfo.version);
        setState(s => ({ ...s, status: 'downloading', version: updateInfo.version!, progress: 0 }));

        // Reflect real download progress on the screen — without a listener the
        // bar sits at 0% for the whole download.
        //
        // Capacitor delivers EVERY download's events to EVERY listener, so a
        // download this run did not start (one an abandoned run left going
        // after a stall and Retry) reaches this listener too. Each event names
        // its bundle, and one labelled with another version is not ours, so
        // it is dropped. One of the SAME version cannot be told apart: its
        // bundle id is random and only known once download() resolves, so an
        // abandoned download of this version still moves this bar and feeds
        // this run's stall watchdog (a device check in docs/NOTES.md). A
        // missing label, or the plugin's 'builtin' fallback for a null one,
        // is let through: dropping this run's own events would fake a stall.
        //
        // A label is usable more often than the plugin's fallback suggests:
        // Android commits the bundle's info, real version string included,
        // before it sends the first progress event (CapgoUpdater.java's
        // download: saveBundleInfo, then notifyDownload), so a live run's
        // events do carry the version and this filter really drops another
        // version's events on a device. getBundleInfo(id) answers 'builtin'
        // only for an id with no stored info (the built-in bundle, one whose
        // entry was deleted, an unknown id), and some payloads carry no label
        // at all: both are let through, because dropping this run's own
        // events would fake a stall. Never narrow that escape hatch on the
        // strength of the unit tests; the device check is what covers it.
        const wanted = updateInfo.version;
        dlListener = await CapacitorUpdater.addListener('download', (info: { percent?: number; bundle?: { version?: unknown } }) => {
            const label = info.bundle?.version;
            if (typeof label === 'string' && label && label !== 'builtin' && label !== wanted) return;
            if (typeof info.percent === 'number') {
                const pct = Math.min(100, Math.max(0, Math.round(info.percent)));
                // Monotonic: the abandoned same-version download (above) can
                // report a lower figure than this run's, and a bar that goes
                // backwards reads as a second failure.
                if (pct > lastPct) {
                    lastPct = pct;
                    lastAdvanceAt = Date.now();
                    setState(s => ({ ...s, progress: pct }));
                }
            }
        });

        // Authenticated OTA: with an embedded public key (capacitor.config),
        // bundles are AES-encrypted and the SHA-256 is RSA-signed off-server.
        // `sessionKey` carries the (RSA-wrapped) AES key + IV so the plugin
        // decrypts; `checksum` is the RSA-signed hash it verifies against the
        // decrypted zip. Both are guaranteed present by the mandatory-signature
        // gate above and are forwarded UNCONDITIONALLY, so the plugin always
        // takes its verifying path — a forged/tampered/unsigned bundle fails
        // → throws here → surfaced below.
        const result = await CapacitorUpdater.download({
            url: updateInfo.url,
            version: updateInfo.version,
            checksum: updateInfo.checksum,
            sessionKey: updateInfo.sessionKey,
        });

        // The watchdog already handed control to the user — a completion
        // arriving AFTER that must not yank whatever they chose into a
        // surprise reload. The bundle is on disk; the next launch's check
        // applies it in a fraction of the time.
        if (stalled) return 'failed';

        if (result && result.version) {
            // Visible truth while the native side swaps bundles: without
            // this the bar just froze at 100% until the reload landed.
            setState(s => ({ ...s, status: 'ready' }));
            await CapacitorUpdater.set(result); // reloads into the new bundle
            return 'applying';
        }
        setState(s => ({ ...s, status: 'upToDate' }));
        return 'nothing';
    } catch (error) {
        if (stalled) return 'failed'; // the stall UI is already up; keep its message
        console.error(`${tag} Update download/verify/apply failed:`, error);
        setState(s => ({ ...s, status: 'error', error: verifyFailedMessage }));
        return 'failed';
    } finally {
        clearInterval(stallWatchdog);
        await dlListener?.remove();
    }
}
