/**
 * Púca Notes' update gate — the Android app's over-the-air updates.
 *
 * In the browser it renders its children at once and never touches the
 * network: the server always serves the latest page there. In the Notes
 * Android app (com.sovereign.notes) it runs the shared OTA engine
 * (api/mobileOta.ts) on the 'notes' channel before the app loads, with Púca's
 * rule: it may DELAY the app, it may never HOLD it — every phase is bounded
 * and every failure ends in the app or in a screen with a control.
 *
 * What it accepts is narrower than Púca's gate: only a manifest tagged
 * exactly "variant": "notes" (an old server answers ?variant=notes with Púca's
 * full manifest), and only a bundle signed with the Notes key the APK embeds
 * (notes-app/capacitor.config.ts) — a Púca bundle cannot verify here.
 *
 * The manifest's `native` block (model/notesUpdate.ts) decides the APK
 * prompts: a bundle that needs a newer APK is NOT applied and a dismissable
 * "install the new app" screen says why; a newer APK on the download page is
 * a one-per-version strip.
 *
 * The strip is rendered IN FLOW, below Notes' top bar, by NotesShell placing
 * <NotesUpdateStripSlot /> — the gate owns its state and hands it down by
 * context. It used to be position:fixed over the top of the app, where it
 * covered the top bar and with it the account button, the only way to "Check
 * for updates"; a 'required' strip returns for every new version.
 *
 * The account menu's "Check for updates" re-runs the same check through
 * registerNotesUpdateRunner. Once the app has been shown it stays mounted: a
 * later download/error screen covers it rather than replacing it, so an open
 * note is not thrown away by asking.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { isMobile } from '../../api/platform';
import { runCapacitorOta, type OtaOutcome, type OtaUiState } from '../../api/mobileOta';
import {
    clearNudgeDismissal, dismissNudgeFor, downloadPage, getNativePrompt, nativePromptFor, readNudgeDismissal,
    registerNotesUpdateRunner, setNativePrompt, subscribeNativePrompt,
} from '../model/notesUpdate';
import { CheckCircleIcon, CloseIcon, DownloadIcon, NoteIcon, WarningIcon } from '../../components/Icons';
import './NotesUpdateGate.css';

/** Shown when a download fails verification. Names the real cause: the key
 *  is baked into the APK, so reinstalling the SAME APK changes nothing. */
const VERIFY_FAILED = 'This update could not be verified or installed. Púca Notes only applies updates signed with the key built into this app, so this usually means the server is publishing Notes updates signed with a different key — or the download was corrupted. Retry once; if it keeps happening, install Púca Notes again from your server’s download page.';

interface NotesUpdateGateProps {
    children: ReactNode;
    /** Defaults to "running inside the Notes Android app". */
    native?: boolean;
}

export function NotesUpdateGate({ children, native = isMobile() }: NotesUpdateGateProps) {
    const [ota, setOta] = useState<OtaUiState>(() => ({
        status: native ? 'checking' : 'upToDate', progress: 0, version: null, error: null,
    }));
    /** The app has been shown once; from then on it stays mounted. */
    const [launchDone, setLaunchDone] = useState(!native);
    const [requiredDismissed, setRequiredDismissed] = useState(false);
    const [nudgeDismissed, setNudgeDismissed] = useState<string | null>(readNudgeDismissal);
    const prompt = useSyncExternalStore(subscribeNativePrompt, getNativePrompt, getNativePrompt);
    const inFlight = useRef<{ promise: Promise<OtaOutcome>; abandon: () => void } | null>(null);

    /**
     * Let go of the run in flight: its later state changes, its onManifest
     * and its outcome are all ignored from here on, and whoever awaits it
     * (the menu's "Check for updates") is answered 'failed' now.
     *
     * Only the error screen's buttons call this, and they are only on screen
     * once the engine has handed control to the user — a failed verify (the
     * run already ended) or a STALL, where the download promise is still
     * pending and may never settle. Sharing that run, as the one-at-a-time
     * rule below otherwise would, left Retry on "Checking for updates…" with
     * no control for good, and every later menu check with it.
     */
    const abandonRun = useCallback(() => {
        const cur = inFlight.current;
        inFlight.current = null;
        cur?.abandon();
    }, []);

    const run = useCallback((): Promise<OtaOutcome> => {
        // One run at a time: StrictMode's double mount, or a menu click while
        // the launch check is still going, shares the run already in flight.
        if (inFlight.current) return inFlight.current.promise;
        let live = true;
        let answerAbandoned: (o: OtaOutcome) => void = () => {};
        const abandoned = new Promise<OtaOutcome>(resolve => { answerAbandoned = resolve; });
        const engine = runCapacitorOta({
            channel: 'notes',
            setState: update => { if (live) setOta(update); },
            verifyFailedMessage: VERIFY_FAILED,
            logTag: '[NotesUpdate]',
            onManifest: (manifest, ctx) => {
                if (!live) return false;
                const next = nativePromptFor(manifest.native, ctx.nativeVersion, ctx.answeringBase);
                setNativePrompt(next);
                if (next?.kind === 'required') {
                    console.warn(`[NotesUpdate] Not applying ${manifest.version}: it needs the Púca Notes app ${next.need} or newer (installed: ${next.have ?? 'unknown'})`);
                    setRequiredDismissed(false);
                    return false;
                }
                return true;
            },
        }).then(outcome => {
            // A failed apply leaves its error screen up (Continue shows the
            // app); an applying one is about to reload. Everything else
            // ends in the app.
            if (live && outcome !== 'failed' && outcome !== 'applying') setLaunchDone(true);
            return outcome;
        }, (err: unknown) => {
            // The engine bounds everything after its first line; this is the
            // import of the plugin's JS itself failing. Never hold the app.
            console.error('[NotesUpdate] update check could not start:', err);
            if (live) {
                setOta(s => ({ ...s, status: 'upToDate' }));
                setLaunchDone(true);
            }
            return 'unreachable' as OtaOutcome;
        });
        const entry = {
            promise: Promise.race([engine, abandoned]).finally(() => {
                if (inFlight.current === entry) inFlight.current = null;
            }),
            abandon: () => { live = false; answerAbandoned('failed'); },
        };
        inFlight.current = entry;
        return entry.promise;
    }, []);

    useEffect(() => {
        if (!native) return;
        void run();
        const manual = () => {
            // Asking again is asking to be told again.
            clearNudgeDismissal();
            setNudgeDismissed(null);
            return run();
        };
        registerNotesUpdateRunner(manual);
        return () => registerNotesUpdateRunner(null);
    }, [native, run]);

    const retry = () => {
        abandonRun();
        setOta({ status: launchDone ? 'upToDate' : 'checking', progress: 0, version: null, error: null });
        void run();
    };
    const continueAnyway = () => {
        abandonRun();
        setOta(s => ({ ...s, status: 'upToDate' }));
        setLaunchDone(true);
    };
    const openDownload = (url: string) => downloadPage.open(url);

    const showApp = launchDone || ota.status === 'upToDate';

    let screen: ReactNode = null;
    if (ota.status === 'checking' && !showApp) {
        screen = (
            <GateScreen icon={<NoteIcon size={56} />} title="Púca Notes">
                <div className="notes-update-spinner" aria-hidden="true" />
                <p>Checking for updates…</p>
            </GateScreen>
        );
    } else if (ota.status === 'downloading') {
        screen = (
            <GateScreen icon={<DownloadIcon size={56} />} title={`Updating to v${ota.version}`}>
                <div className="notes-update-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={ota.progress}>
                    <div className="notes-update-progress-bar" style={{ width: `${ota.progress}%` }} />
                </div>
                <p>{ota.progress}% downloaded</p>
            </GateScreen>
        );
    } else if (ota.status === 'ready') {
        screen = (
            <GateScreen icon={<CheckCircleIcon size={56} />} title="Update ready">
                <p>Restarting with v{ota.version}…</p>
                <div className="notes-update-spinner" aria-hidden="true" />
            </GateScreen>
        );
    } else if (ota.status === 'error') {
        screen = (
            <GateScreen icon={<WarningIcon size={56} />} title="Update failed">
                <p className="notes-update-error">{ota.error}</p>
                <div className="notes-update-actions">
                    <button type="button" className="notes-update-btn primary" onClick={retry}>Retry</button>
                    <button type="button" className="notes-update-btn" onClick={continueAnyway}>Continue anyway</button>
                </div>
            </GateScreen>
        );
    } else if (native && prompt?.kind === 'required' && !requiredDismissed) {
        screen = (
            <GateScreen icon={<DownloadIcon size={56} />} title="Install the new Púca Notes app">
                <p>
                    The latest update needs version {prompt.need} of the Púca Notes app or newer
                    {prompt.have ? <> (this one is {prompt.have})</> : null}. Install it over this
                    one from your server&rsquo;s download page — your notes live on your account, so
                    nothing is lost. Until then this app keeps running the version it has.
                </p>
                <div className="notes-update-actions">
                    {prompt.downloadUrl && (
                        <button type="button" className="notes-update-btn primary" onClick={() => openDownload(prompt.downloadUrl!)}>
                            <DownloadIcon /> Download
                        </button>
                    )}
                    <button type="button" className="notes-update-btn" onClick={() => setRequiredDismissed(true)}>Continue</button>
                </div>
            </GateScreen>
        );
    }

    const nudgeVersion = prompt?.kind === 'required' ? prompt.need : prompt?.version;
    const strip = native && showApp && !screen && prompt && nudgeVersion && nudgeDismissed !== nudgeVersion ? (
        <div className="notes-update-strip" role="status">
            <span className="notes-update-strip-text">
                {prompt.kind === 'required'
                    ? `The latest update needs Púca Notes ${prompt.need}. Install it from the download page.`
                    : `A new Púca Notes app (${prompt.version}) is available.`}
            </span>
            {prompt.downloadUrl && (
                <button type="button" className="notes-update-strip-btn" onClick={() => openDownload(prompt.downloadUrl!)}>Download</button>
            )}
            <button
                type="button"
                className="notes-update-strip-close"
                aria-label="Dismiss"
                onClick={() => { dismissNudgeFor(nudgeVersion); setNudgeDismissed(nudgeVersion); }}
            >
                <CloseIcon size={16} />
            </button>
        </div>
    ) : null;

    if (!showApp) return <>{screen}</>;
    return (
        <StripContext.Provider value={strip}>
            {children}
            {screen}
        </StripContext.Provider>
    );
}

/** The strip the gate wants shown, or null. Only the gate provides it. */
const StripContext = createContext<ReactNode>(null);

/**
 * Where the "new app" strip goes: NotesShell renders this right below its top
 * bar, so the strip takes its own row in the page instead of lying over the
 * top bar's account button. Renders nothing in the browser, and nothing
 * outside a gate.
 */
export function NotesUpdateStripSlot() {
    return <>{useContext(StripContext)}</>;
}

function GateScreen({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
    return (
        <div className="notes-update-gate" role="dialog" aria-modal="true" aria-label={title}>
            <div className="notes-update-gate-content">
                <div className="notes-update-logo">{icon}</div>
                <h2>{title}</h2>
                {children}
            </div>
        </div>
    );
}
