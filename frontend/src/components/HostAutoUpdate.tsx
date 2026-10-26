/**
 * The runner for api/devices/hostUpdate.ts: on a PC set up for remote control,
 * install a newer Púca by itself while nobody is connected, and say what it
 * decided in puca.log.
 *
 * Renders nothing. Mounted from RcGlobals only, so a Lite build — which has no
 * remote control and is never a host — does not contain it at all
 * (vite.shared.ts lists it with the other remote-control components).
 *
 * WHAT IT WATCHES, and why each one:
 *  - the server's /app-version, every 10 minutes (the update banner's own
 *    cadence; the banner still offers the same update to anyone who is here);
 *  - whether this PC is a host, re-read from the machine at the same moments,
 *    since either switch can be turned off from Devices at any time;
 *  - every device session on this PC, either role and any phase but ended,
 *    the voice call, and a DM's direct file transfer: each resets the settle
 *    clock, so a session that came and went between two looks is still seen;
 *  - this app (re)connecting to its server, and the PC waking from sleep
 *    (a look that comes far later than its timer asked): someone who woke
 *    the PC to reach it is about to connect, so those start a settle too;
 *  - the last keyboard or mouse input on this PC (the OS probe on Windows,
 *    this window's own input elsewhere), and the shell's notification state,
 *    which knows what idleness cannot: a film, a game on a controller, a
 *    presentation (hostUpdate.ts `nobodyWatching`);
 *  - an attachment or a Clip uploading from here, and a message written in
 *    the composer but not sent (workInFlight.ts): a restart would lose both.
 * Everything is re-judged every 2 s while the update downloads, and once more
 * before the installer runs: a session that starts meanwhile STOPS the
 * download (the shell's task is aborted, so it does not share the link with
 * the session) and the update waits for the next quiet spell.
 *
 * THE INSTALL IS THE SHELL'S (frontend/src-tauri/src/host_update.rs): NSIS
 * run silently, so nothing appears on the screen; the attempt written to disk
 * before the installer starts; and the relaunched app kept hidden, whatever
 * arguments it had. The update banner's own installs (appVersion.ts) are not
 * this path and stay as they were.
 */
import { useEffect } from 'react';
import { checkForNewVersion } from '../api/appVersion';
import { isTauri } from '../api/platform';
import { activeSessions, subscribeSessions } from '../api/devices/session';
import { unattendedState } from '../api/devices/unattendedHost';
import { lockScreenState } from '../api/devices/lockScreen';
import {
    HOST_UPDATE_STALL_MS,
    decideHostUpdate,
    hostUpdateFailureText,
    hostUpdateLogLine,
    hostUpdateReason,
    isRemoteControlHost,
    parseHostUpdateRecord,
    type HostUpdateAttempt,
    type HostUpdateFacts,
} from '../api/devices/hostUpdate';
import { fileTransferManager, type TransferView } from '../api/fileTransferManager';
import { hasUnsent, uploadsInFlight } from '../api/workInFlight';
import { isSelfInVoice, subscribeSelfInVoice } from './voiceState';
import { loadSettings } from './settingsStore';

/** The first look waits for startup to settle (the banners look at 8 and 12 s). */
const FIRST_CHECK_MS = 60_000;
/** How often the server and the host switches are asked. */
const CHECK_EVERY_MS = 10 * 60_000;
/** How often the cheap facts (sessions, call, idle) are judged. */
const TICK_MS = 30_000;
/** A look this much later than the last one means the PC slept (or the page
 *  was frozen): treated as waking up. */
const WOKE_GAP_MS = 4 * TICK_MS;

/** A direct transfer that a restart would cut off or lose: being read and
 *  digested to offer, offered and waiting for an answer, being connected, or
 *  moving bytes (review 2026-10-26: the first two were not counted). */
const transferIsLive = (t: TransferView) =>
    t.state === 'preparing' || t.state === 'offered' || t.state === 'connecting' || t.state === 'transferring';
/** While an update downloads, how often the download is asked about and
 *  everything re-judged (the idle probe is read as often), so a session that
 *  starts stops it within this, and the last check before the installer is
 *  never judged on a stale probe. */
const RUN_POLL_MS = 2_000;
/** After a download or install that failed, the wait before trying again. */
const FAILURE_BACKOFF_MS = 30 * 60_000;

/** The Tauri core module, imported once and shared, as session.ts does: a
 *  run that goes on to install makes a dozen calls in a row, and one import
 *  awaited by all keeps each later call a resolved promise away. */
let tauriCoreModule: Promise<typeof import('@tauri-apps/api/core')> | null = null;
function tauriCore(): Promise<typeof import('@tauri-apps/api/core')> {
    if (!tauriCoreModule) tauriCoreModule = import('@tauri-apps/api/core');
    return tauriCoreModule;
}

async function shell<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    const { invoke } = await tauriCore();
    return invoke<T>(cmd, args);
}

/** Writes in order: each line waits for the one before it, as connectLog's
 *  do — the first dynamic import resolves later than the next ones, so
 *  unchained, "failed" could land in the log above the "installing" it ends. */
let logChain: Promise<void> = Promise.resolve();

/** One `[host-update]` line in puca.log (desktop) and the console. Resolves
 *  once the line (and every one before it) is written: awaited before the
 *  installer, which ends this process. */
function logHostUpdate(line: string): Promise<void> {
    const full = `[host-update] ${line}`;
    console.info(full);
    if (!isTauri()) return logChain;
    logChain = logChain.then(async () => {
        try {
            await shell('log_stream_diag', { line: full });
        } catch { /* best effort: a missing line is not worth an error */ }
    });
    return logChain;
}

/** What host_update_status answers (host_update.rs `HostUpdateStatus`). */
interface ShellUpdateStatus {
    phase: 'idle' | 'checking' | 'downloading' | 'ready' | 'failed';
    version?: string;
    error?: string;
    /** Bytes received so far (downloading, ready). */
    bytes?: number;
}

/** Seconds since the last keyboard or mouse input anywhere on this PC, or
 *  null where the shell has no such probe (it answers -1 off Windows). */
async function osIdleSeconds(): Promise<number | null> {
    try {
        const secs = await shell<number>('get_idle_seconds');
        return typeof secs === 'number' && secs >= 0 ? secs : null;
    } catch {
        return null;
    }
}

/** The shell's notification state for this session (host_update.rs
 *  `host_presence`), or null where it cannot be read. */
async function osNotificationState(): Promise<number | null> {
    try {
        const p = await shell<{ notificationState?: unknown }>('host_presence');
        return typeof p?.notificationState === 'number' ? p.notificationState : null;
    } catch {
        return null;
    }
}

/** The version latest.json offers this build (the shell's host_update_offer),
 *  or null for nothing newer, or when it cannot be asked. */
async function offeredVersion(): Promise<{ offered: string | null; failed: unknown }> {
    try {
        const v = await shell<unknown>('host_update_offer');
        return { offered: typeof v === 'string' && v ? v : null, failed: null };
    } catch (e) {
        // A look that failed (the shell bounds it: a hung request ends at its
        // OFFER_CHECK_TIMEOUT as an error) is said, and the next look asks again.
        return { offered: null, failed: e ?? 'no answer' };
    }
}

async function readHost(): Promise<boolean | null> {
    const [ua, ls] = await Promise.allSettled([unattendedState(), lockScreenState()]);
    return isRemoteControlHost(
        ua.status === 'fulfilled' ? ua.value.armed : null,
        // lockScreenState reports a failure as `installed: false` with a
        // problem; a problem is "could not tell", not "no".
        ls.status === 'fulfilled' && !ls.value.problem ? ls.value.installed : null,
    );
}

/** The last install this PC committed to, as the shell recorded it on disk
 *  (null when it cannot say: the 30-minute failure back-off still spaces
 *  attempts out). */
async function readAttempt(): Promise<HostUpdateAttempt | null> {
    try {
        return parseHostUpdateRecord(await shell<unknown>('host_update_record')).attempt;
    } catch {
        return null;
    }
}

export function HostAutoUpdate() {
    useEffect(() => {
        if (!isTauri()) return;
        let alive = true;
        /** When a session, the call or a transfer was last seen live, or
         *  ending. 0 = not this run. */
        let lastBusyAt = 0;
        /** When this app last connected to its server, or the PC woke. This
         *  mounts once the socket is up, so: now. */
        let lastOnlineAt = Date.now();
        let lastTickAt = Date.now();
        let transferWasLive = false;
        /** This window's own last input: the idle probe where the OS has none.
         *  Starts at the launch, which a person may just have made. */
        let lastInAppInput = Date.now();
        /** The OS probe's last answer (null = no probe on this platform). */
        let osIdle: number | null = null;
        /** And the shell's notification state with it (null = unreadable). */
        let notificationState: number | null = null;
        let available: string | null = null;
        /** What latest.json offers: what would install. */
        let offered: string | null = null;
        let host: boolean | null = null;
        /** The shell's record of the last install committed to, read at each
         *  check and after a failure. */
        let attempt: HostUpdateAttempt | null = null;
        /** When the version on offer was first seen offered here, and since
         *  when this PC has been behind: the shell's record, else the first
         *  times THIS run saw them (a PC that stays up still updates; one that
         *  restarts waits longer, never less). */
        let seenAt: number | null = null;
        let behindSince: number | null = null;
        let behindThisRun: number | null = null;
        const seenThisRun = new Map<string, number>();
        const noteSeen = async (version: string): Promise<{ seenAt: number; behindSince: number }> => {
            const now = Date.now();
            if (behindThisRun === null) behindThisRun = now;
            if (!seenThisRun.has(version)) seenThisRun.set(version, now);
            try {
                const t = await shell<{ seenAt?: unknown; behindSince?: unknown }>('host_update_note_seen', { version });
                if (typeof t?.seenAt === 'number' && Number.isFinite(t.seenAt)
                    && typeof t.behindSince === 'number' && Number.isFinite(t.behindSince)) {
                    return { seenAt: t.seenAt, behindSince: t.behindSince };
                }
            } catch { /* the in-run times below */ }
            return { seenAt: seenThisRun.get(version) ?? now, behindSince: behindThisRun };
        };
        let checking = false;
        /** The last failed look's line, so a look that keeps failing is said once. */
        let lastLookFailure: string | null = null;
        let running = false;
        /** The installer is running: this process is being replaced, and
         *  nothing it decides from here could be true. */
        let committed = false;
        let nextRunAt = 0;
        let lastLine: string | null = null;

        const noteBusy = () => { lastBusyAt = Date.now(); };
        const noteOnline = () => { lastOnlineAt = Date.now(); };
        const facts = (): HostUpdateFacts => {
            const now = Date.now();
            const live = activeSessions().some(s => s.phase !== 'ended');
            const inCall = isSelfInVoice();
            const transferLive = fileTransferManager.list().some(transferIsLive);
            if (live || inCall || transferLive) lastBusyAt = now;
            return {
                enabled: loadSettings().hostAutoUpdate !== false,
                host,
                available,
                offered,
                seenAt,
                behindSince,
                sessionLive: live,
                inCall,
                transferLive,
                uploading: uploadsInFlight() > 0,
                unsent: hasUnsent(),
                notificationState,
                quietForMs: now - lastBusyAt,
                onlineForMs: now - lastOnlineAt,
                // The OS probe is system-wide, so it already counts input in
                // this window — and a launch is not input. Not extrapolated
                // past the sample: a probe a moment old can only make this PC
                // look busier than it is.
                idleSecs: osIdle ?? Math.max(0, (now - lastInAppInput) / 1000),
                lastAttempt: attempt,
                now,
            };
        };
        const say = (line: string | null) => {
            if (line && line !== lastLine) void logHostUpdate(line);
            lastLine = line;
        };
        const sampleIdle = async () => {
            osIdle = await osIdleSeconds();
            notificationState = await osNotificationState();
        };
        const failed = async (what: string, e: unknown) => {
            void logHostUpdate(`${what} failed: ${hostUpdateFailureText(e)}`);
            lastLine = null;
            nextRunAt = Date.now() + FAILURE_BACKOFF_MS;
            attempt = await readAttempt();
        };
        /** Judged again; false (said once, download stopped) when it is no
         *  longer an install. */
        const stillInstall = async (version: string): Promise<boolean> => {
            if (!alive) {
                // Unmounted mid-download: nothing will install what it holds.
                await shell('host_update_cancel').catch(() => undefined);
                return false;
            }
            const f = facts();
            const d = decideHostUpdate(f);
            if (d.act === 'install') return true;
            await shell('host_update_cancel').catch(() => undefined);
            void logHostUpdate(`not installing ${version} after all: ${hostUpdateReason(d, f.lastAttempt)}; the download was stopped`);
            lastLine = null;
            return false;
        };

        const install = async (version: string) => {
            running = true;
            const sampler = setInterval(() => { void sampleIdle(); }, RUN_POLL_MS);
            try {
                let fetching: string | null;
                try {
                    // Only the version just judged: the shell refuses another.
                    fetching = await shell<string | null>('host_update_download', { expected: version });
                } catch (e) {
                    await failed(`downloading ${version}`, e);
                    return;
                }
                if (!fetching) {
                    // The server announces a version the updater does not
                    // offer yet (its manifest lags the release): later.
                    void logHostUpdate(`update ${version} available, waiting: the updater does not offer it yet`);
                    lastLine = null;
                    nextRunAt = Date.now() + FAILURE_BACKOFF_MS;
                    return;
                }
                // Downloading: judged again on every poll, so whatever starts
                // meanwhile (a session, a call, someone at the keyboard) stops it.
                // And bounded: nothing received for HOST_UPDATE_STALL_MS stops
                // it too, as a failure (the updater has no timeout of its own).
                let received = -1;
                let progressAt = Date.now();
                for (;;) {
                    if (!(await stillInstall(fetching))) return;
                    let status: ShellUpdateStatus;
                    try {
                        status = await shell<ShellUpdateStatus>('host_update_status');
                    } catch (e) {
                        await shell('host_update_cancel').catch(() => undefined);
                        await failed(`downloading ${fetching}`, e);
                        return;
                    }
                    if (status.phase === 'ready') break;
                    if (status.phase === 'failed') {
                        await failed(`downloading ${fetching}`, status.error ?? 'the download did not finish');
                        return;
                    }
                    // 'idle' or 'checking': something else stopped it; the next
                    // quiet spell starts over.
                    if (status.phase !== 'downloading') return;
                    const got = typeof status.bytes === 'number' ? status.bytes : 0;
                    if (got > received) {
                        received = got;
                        progressAt = Date.now();
                    } else if (Date.now() - progressAt >= HOST_UPDATE_STALL_MS) {
                        await shell('host_update_cancel').catch(() => undefined);
                        await failed(`downloading ${fetching}`, `nothing arrived for ${HOST_UPDATE_STALL_MS / 60_000} minutes`);
                        return;
                    }
                    await new Promise(r => setTimeout(r, RUN_POLL_MS));
                }
                // The point of no return: one more look, on facts at most a
                // couple of seconds old.
                await sampleIdle();
                if (!(await stillInstall(fetching))) return;
                committed = true;
                // Every line so far is written before this process is replaced.
                await logHostUpdate(`installing ${fetching} now: quietly, and Púca starts again in the tray`);
                // On Windows this does not return: the installer replaces this
                // process. The attempt is on disk first, so if Púca comes back
                // on the OLD version that run reads it, and waits a day.
                await shell('host_update_install');
            } catch (e) {
                // The installer did not start: this process is not being
                // replaced, and what the shell recorded keeps the retry a day off.
                committed = false;
                await failed(`installing ${version}`, e);
            } finally {
                clearInterval(sampler);
                running = false;
            }
        };

        const tick = async () => {
            // Woken from sleep (or a frozen page): this look comes far later
            // than its timer asked. Counted before anything returns early.
            const at = Date.now();
            if (at - lastTickAt > WOKE_GAP_MS) noteOnline();
            lastTickAt = at;
            if (!alive || running || checking || committed) return;
            // Not a host, or nothing newer: nothing to judge, and no probe to
            // read every half minute on every other PC.
            if (host !== true || !available) { lastLine = null; return; }
            await sampleIdle();
            if (!alive || running) return;
            const f = facts();
            const d = decideHostUpdate(f);
            if (d.act === 'install') {
                // Backing off after a failure: its line says what happened.
                if (Date.now() < nextRunAt) return;
                say(hostUpdateLogLine(d, f.lastAttempt));
                await install(d.version);
                return;
            }
            say(hostUpdateLogLine(d, f.lastAttempt));
        };

        const check = async () => {
            if (!alive || checking || running || committed) return;
            checking = true;
            try {
                host = await readHost();
                // Only a host asks the server: every other PC is the banner's.
                available = host === true ? ((await checkForNewVersion())?.version ?? null) : null;
                // And what latest.json offers, which is what installs: the
                // soak and the guard key on it (the decision waits while the
                // two disagree). Asked at every look a host makes, even with
                // nothing announced: a look that finds nothing newer is what
                // tells the shell this PC is not behind any more, so a pulled
                // release leaves no clock running for the next (host_update.rs).
                const look = host === true ? await offeredVersion() : { offered: null, failed: null };
                offered = look.offered;
                if (look.failed !== null) {
                    const line = `asking the updater what it offers failed: ${hostUpdateFailureText(look.failed)}; `
                        + 'asking again at the next look';
                    // Said once while it keeps failing the same way.
                    if (line !== lastLookFailure) void logHostUpdate(line);
                    lastLookFailure = line;
                } else {
                    lastLookFailure = null;
                }
                if (available) attempt = await readAttempt();
                if (offered) {
                    const t = await noteSeen(offered);
                    seenAt = t.seenAt;
                    behindSince = t.behindSince;
                } else {
                    seenAt = null;
                    behindSince = null;
                }
            } catch {
                // An unreachable server answers nothing; the next look retries.
            } finally {
                checking = false;
            }
            await tick();
        };

        const unsubSessions = subscribeSessions(list => { if (list.length > 0) noteBusy(); });
        const unsubVoice = subscribeSelfInVoice(noteBusy);
        // A transfer's end counts as well as its life: the settle runs from it.
        const unsubTransfers = fileTransferManager.subscribe(list => {
            const live = list.some(transferIsLive);
            if (live || transferWasLive) noteBusy();
            transferWasLive = live;
        });
        // The socket (re)connected: after a network drop, or the PC waking.
        window.addEventListener('wsConnected', noteOnline);
        const onInput = () => { lastInAppInput = Date.now(); };
        const INPUT = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const;
        for (const t of INPUT) window.addEventListener(t, onInput, { passive: true, capture: true });
        const first = setTimeout(() => { void check(); }, FIRST_CHECK_MS);
        const checks = setInterval(() => { void check(); }, CHECK_EVERY_MS);
        const ticks = setInterval(() => { void tick(); }, TICK_MS);
        return () => {
            alive = false;
            clearTimeout(first);
            clearInterval(checks);
            clearInterval(ticks);
            unsubSessions();
            unsubVoice();
            unsubTransfers();
            window.removeEventListener('wsConnected', noteOnline);
            for (const t of INPUT) window.removeEventListener(t, onInput, { capture: true });
        };
    }, []);
    return null;
}
