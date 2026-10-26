/**
 * A PC set up for remote control keeps ITSELF up to date, while nobody is
 * connected to it.
 *
 * WHY. Desktop updates install on a click (UpdateBanner) or, opted in, at
 * launch (UpdateGate). A host nobody sits at gets neither: one laptop,
 * reached only from the owner's other machines, ran 0.9.844 for days after
 * 0.9.847 had shipped the host half of the pointer-shape and latency work, and
 * every session to it was the old, laggy one (2026-10-26). The owner chose the
 * fix that day: only PCs set up for remote control, only while no session is
 * live, and Púca restarts itself after updating. Other PCs work as before.
 *
 * WHAT A HOST IS — read from the machine, never guessed. One of the two
 * switches in Devices, This device, that let this PC be controlled with nobody
 * at it: unattended access armed (`unattended_state`), or lock-screen access
 * installed (the SovereignRemote service, `service_state`). Device enrolment is
 * not it (every desktop enrols, push needs it), and neither is the agent (every
 * full desktop build ships one). A PC controlled only with someone clicking
 * Allow has someone there to click Update as well.
 *
 * SEVERAL WINDOWS ACCOUNTS (review 2026-10-26, decided as is): `armed` is this
 * account's (its own %LOCALAPPDATA%), but the service is the machine's, so on
 * a PC with lock-screen access EVERY account's Púca counts as a host. That is
 * right. A remote sign-in through the lock screen lands in whichever account
 * signs in, and the session then runs on THAT account's Púca and agent, the
 * very copy that must not be the old one. Each account's update is its own
 * per-user install, touching no other account (the installer closes this
 * user's Púca.exe only); it is judged in that account's own session, where a
 * switched-away session reads as "not present", so it installs unseen by the
 * person at the console; and each account has the switch in its own Devices.
 * The one cost: a switched-away account cannot see the console's film or
 * game, so its download and install may share the PC with them.
 *
 * WHAT IT UPDATES. The app, with the agent beside it — the Tauri updater's
 * per-user NSIS install (currentUser mode, %LOCALAPPDATA%), which raises no
 * elevation prompt. NOT the sign-in-screen service: its binaries sit in an
 * administrator-only folder under Program Files and `service_update` runs
 * `puca-service.exe update` through the `runas` verb, a UAC prompt every time.
 * Nobody is there to answer one, so it is never attempted from here; the
 * service's own banner (ServiceUpdateBanner) waits for someone at the PC.
 *
 * HOW, unseen: the shell runs that installer SILENTLY and brings the app back
 * hidden in the tray, and writes the attempt to disk before the installer
 * starts (frontend/src-tauri/src/host_update.rs). Nothing appears on the
 * screen of a PC whose owner may be watching a film on it.
 *
 * Pure: the runner (components/HostAutoUpdate.tsx) reads the machine and the
 * clock and feeds them in, so every condition has its own negative control in
 * src/tests/hostUpdate.test.ts.
 */
import { sameVersion } from '../../components/updateGate.utils';

/** Nothing may have been live here (no device session, call or transfer)
 *  for this long: someone who disconnects to reconnect a moment later must
 *  not find the PC restarting. And as long again after this PC's Púca
 *  connects to its server or the PC wakes: that is when someone who woke it
 *  to reach it (Wake & connect) is about to connect. */
export const HOST_UPDATE_SETTLE_MS = 2 * 60_000;

/** Nobody may have used this PC's keyboard or mouse for this long: a host is
 *  often somebody's own computer too, and a restart under a person typing is
 *  the thing the opt-in at launch exists to avoid. Input from a remote
 *  session counts — it is injected through the same queue — so this also
 *  outlasts the end of one. */
export const HOST_UPDATE_IDLE_SECS = 10 * 60;

/** An install that did not take (the app came back on the old version) is
 *  tried again only after this long, so a broken update cannot restart the
 *  PC in a loop. */
export const HOST_UPDATE_RETRY_MS = 24 * 60 * 60_000;

/** A download that receives nothing for this long is stopped, and tried
 *  again after the usual back-off: the updater has no timeout of its own, so
 *  a stalled connection used to hold a host's update for ever. */
export const HOST_UPDATE_STALL_MS = 2 * 60_000;

/** THE SOAK (review 2026-10-26, reshaped by the coordinator in round 3): a
 *  bad release must not take down every PC nobody is at the moment it ships,
 *  and a burst of releases must not keep a host behind. So a host installs
 *  once it has been BEHIND this long, counted from the first time it saw ANY
 *  version newer than the one it runs (the clock restarts only once it has
 *  updated), ... */
export const HOST_UPDATE_BEHIND_MS = 24 * 60 * 60_000;

/** ... and the version it installs has been on offer at least this long,
 *  so the people who update by hand meet a bad release first. Staleness
 *  stays around a day and two hours, even when releases come hours apart
 *  (the old rule, a day per version, held a host back for as long as the
 *  burst lasted). Both times are on disk (the shell's record), so a restart
 *  does not restart either clock. */
export const HOST_UPDATE_FRESH_MS = 2 * 60 * 60_000;

/** A version, and when (ms): the last automatic install this PC committed
 *  to, or when a version was first seen offered. The SHELL keeps both, on
 *  disk (host_update.rs `Record`): the attempt is written at the point of no
 *  return, so a download that failed does not count as one, and before the
 *  installer runs, so a broken update cannot loop the PC. It was localStorage
 *  until the review of 2026-10-26, written milliseconds before the process
 *  exited, with no proof that WebView2 had flushed it. */
export interface HostUpdateAttempt {
    version: string;
    at: number;
}

/** What the shell remembers (host_update_record). */
export interface HostUpdateRecord {
    attempt: HostUpdateAttempt | null;
    seen: HostUpdateAttempt | null;
}

export interface HostUpdateFacts {
    /** The owner's switch, "Keep Púca up to date on this computer while nobody
     *  is connected" (Devices, This device). On unless turned off. */
    enabled: boolean;
    /** This PC is set up for remote control: `isRemoteControlHost`. null =
     *  could not tell, which is never treated as yes. */
    host: boolean | null;
    /** A strictly newer version the server publishes (/app-version), or null. */
    available: string | null;
    /** The version latest.json offers this build (the shell's
     *  host_update_offer): what would actually install. null = nothing newer
     *  there, or it could not be asked. */
    offered: string | null;
    /** When the version on offer was first seen offered here (ms), or null
     *  while that is not known yet. */
    seenAt: number | null;
    /** Since when this PC has been behind: when it first saw any version
     *  newer than the one it runs (ms), or null while that is not known. */
    behindSince: number | null;
    /** A device session here, either role, in any phase but ended. */
    sessionLive: boolean;
    /** Púca on this PC is in a voice call. */
    inCall: boolean;
    /** A direct (peer-to-peer) file transfer of a DM is being prepared,
     *  offered, connecting or moving bytes here: not a device session, and
     *  just as dead after a restart. */
    transferLive: boolean;
    /** An attachment or a Clip is on its way to the server from here
     *  (workInFlight.ts): cut off, the message carrying it never goes. */
    uploading: boolean;
    /** A composer here holds a message not sent yet, which lives only in the
     *  page and would not survive the restart. */
    unsent: boolean;
    /** `SHQueryUserNotificationState` for this session (the shell's
     *  `host_presence`), or null where it cannot be read. Idleness misses a
     *  film, a game on a controller, a presentation: this does not. */
    notificationState: number | null;
    /** Milliseconds since a device session, a call or a transfer was last
     *  live here. */
    quietForMs: number;
    /** Milliseconds since this PC's Púca last (re)connected to its server or
     *  woke from sleep: the moment someone reaching it by Wake & connect, or
     *  after a network drop, is about to connect. */
    onlineForMs: number;
    /** Seconds since anyone last used this PC's keyboard or mouse. */
    idleSecs: number;
    /** The last automatic install committed to here, if any. */
    lastAttempt: HostUpdateAttempt | null;
    /** Date.now(), for the retry rule. */
    now: number;
}

export type HostUpdateWait =
    | 'not-offered' | 'disagree'
    | 'soaking' | 'session' | 'call' | 'transfer' | 'upload' | 'unsent' | 'settling' | 'reconnected'
    | 'someone-here' | 'in-use' | 'tried';

/**
 * Does the shell's notification state say nobody is using this session's
 * screen? Two answers do: "accepts notifications" (5, nothing full screen,
 * no presentation, no game) and "not present" (1: the PC is locked, the
 * screen saver is on, or this Windows session is switched away), the
 * clearest "nobody here" there is, and how a PC nobody is at usually sits.
 * Every other answer is someone watching or playing: busy, full screen or
 * presentation settings (2), a full-screen Direct3D game (3), presentation
 * mode (4), quiet time (6), a Store app in front (7). The review asked for
 * "accepts notifications" alone; that would never update a locked PC, which
 * is what a PC set up for remote control is most of the time.
 *
 * Unreadable (null) is not a reason to wait: off Windows there is no such
 * state, and idleness still applies.
 */
export function nobodyWatching(state: number | null): boolean {
    return state === null || state === 1 || state === 5;
}

export type HostUpdateDecision =
    /** Nothing to do: not a host, nothing newer, or no version to name. */
    | { act: 'none'; why: 'not-a-host' | 'up-to-date' }
    /** A host with an update whose owner turned this off. */
    | { act: 'none'; why: 'off'; version: string }
    | { act: 'wait'; why: HostUpdateWait; version: string; retryAt?: number; offered?: string }
    | { act: 'install'; version: string };

/**
 * Is this PC set up for remote control? Unattended access armed, or the
 * lock-screen service installed. `null` for either means it could not be read
 * (the command failed, or a build without it); a single `true` is enough, and
 * an unknown is never promoted to one.
 */
export function isRemoteControlHost(armed: boolean | null, serviceInstalled: boolean | null): boolean | null {
    if (armed === true || serviceInstalled === true) return true;
    if (armed === false && serviceInstalled === false) return false;
    return null;
}

/** What AUTO-INSTALL needs to be true, in the order a log line names them. */
export function decideHostUpdate(f: HostUpdateFacts): HostUpdateDecision {
    if (f.host !== true) return { act: 'none', why: 'not-a-host' };
    if (!f.available) return { act: 'none', why: 'up-to-date' };
    const announced = f.available;
    if (!f.enabled) return { act: 'none', why: 'off', version: announced };
    // WHAT INSTALLS is latest.json's version, so the soak and the loop guard
    // key on it, and the server's /app-version must agree: during a ship to
    // several boxes the two can differ, and keyed on /app-version's while
    // latest.json's installed, a version that did not take was retried every
    // few minutes, for as long as they differed (coordinator, round 3).
    if (!f.offered) return { act: 'wait', why: 'not-offered', version: announced };
    if (!sameVersion(f.offered, announced)) {
        return { act: 'wait', why: 'disagree', version: announced, offered: f.offered };
    }
    const version = f.offered;
    // The soak first: it decides the longest wait, and it is what the log
    // should say while it lasts. Behind a day, AND this version out two hours.
    const behindReady = f.behindSince === null ? Number.NaN : f.behindSince + HOST_UPDATE_BEHIND_MS;
    const freshReady = f.seenAt === null ? Number.NaN : f.seenAt + HOST_UPDATE_FRESH_MS;
    if (!(f.now >= behindReady) || !(f.now >= freshReady)) {
        const retryAt = Math.max(behindReady, freshReady);
        return { act: 'wait', why: 'soaking', version, ...(Number.isFinite(retryAt) ? { retryAt } : {}) };
    }
    if (f.sessionLive) return { act: 'wait', why: 'session', version };
    if (f.inCall) return { act: 'wait', why: 'call', version };
    if (f.transferLive) return { act: 'wait', why: 'transfer', version };
    if (f.uploading) return { act: 'wait', why: 'upload', version };
    if (f.unsent) return { act: 'wait', why: 'unsent', version };
    if (!(f.quietForMs >= HOST_UPDATE_SETTLE_MS)) return { act: 'wait', why: 'settling', version };
    if (!(f.onlineForMs >= HOST_UPDATE_SETTLE_MS)) return { act: 'wait', why: 'reconnected', version };
    if (!(f.idleSecs >= HOST_UPDATE_IDLE_SECS)) return { act: 'wait', why: 'someone-here', version };
    if (!nobodyWatching(f.notificationState)) return { act: 'wait', why: 'in-use', version };
    const tried = f.lastAttempt;
    if (tried && sameVersion(tried.version, version) && f.now - tried.at < HOST_UPDATE_RETRY_MS) {
        return { act: 'wait', why: 'tried', version, retryAt: tried.at + HOST_UPDATE_RETRY_MS };
    }
    return { act: 'install', version };
}

const WAITING: Record<Exclude<HostUpdateWait, 'tried' | 'soaking' | 'disagree'>, string> = {
    'not-offered': 'the updater does not offer it yet',
    session: 'a session is live',
    call: 'a call is active here',
    transfer: 'a file transfer is running',
    upload: 'a file is being uploaded from here',
    unsent: 'a message is being written here and has not been sent',
    settling: `a session, call or file transfer ended less than ${HOST_UPDATE_SETTLE_MS / 60_000} minutes ago`,
    reconnected: `this PC connected to the server, or woke up, less than ${HOST_UPDATE_SETTLE_MS / 60_000} minutes ago`,
    'someone-here': `this PC's keyboard or mouse was used in the last ${HOST_UPDATE_IDLE_SECS / 60} minutes`,
    'in-use': 'something is on this PC\'s screen full screen or presented (a film, a game, slides)',
};

/** Why a decision is not an install, in a few words; null for an install. */
export function hostUpdateReason(d: HostUpdateDecision, lastAttempt: HostUpdateAttempt | null = null): string | null {
    if (d.act === 'install') return null;
    if (d.act === 'none') {
        if (d.why === 'off') return 'this PC does not install updates by itself (turned off in Devices, This device)';
        return d.why === 'not-a-host' ? 'this PC is not set up for remote control' : 'nothing newer to install';
    }
    if (d.why === 'tried') {
        const at = lastAttempt ? new Date(lastAttempt.at).toISOString() : 'earlier';
        const again = d.retryAt ? new Date(d.retryAt).toISOString() : 'a day later';
        return `installing it here at ${at} did not take; trying again after ${again}`;
    }
    if (d.why === 'disagree') {
        return `the server announces it but the updater offers ${d.offered ?? 'another version'}; `
            + 'waiting until the two agree';
    }
    if (d.why === 'soaking') {
        const rule = `a PC set up for remote control installs once it has been behind for ${HOST_UPDATE_BEHIND_MS / 3_600_000} hours `
            + `and the version on offer has been out for ${HOST_UPDATE_FRESH_MS / 3_600_000} hours`;
        return d.retryAt ? `${rule}; not before ${new Date(d.retryAt).toISOString()}` : rule;
    }
    return WAITING[d.why];
}

/**
 * The puca.log line for a decision, or null when there is nothing worth a
 * line (not a host, nothing newer). The runner writes a line only when it
 * differs from the last one, so a host waiting out a long session says so
 * once, not every tick.
 */
export function hostUpdateLogLine(d: HostUpdateDecision, lastAttempt: HostUpdateAttempt | null = null): string | null {
    if (d.act === 'install') return `installing ${d.version}: nobody connected`;
    if (d.act === 'none') {
        return d.why === 'off' ? `update ${d.version} available; ${hostUpdateReason(d)}` : null;
    }
    return `update ${d.version} available, waiting: ${hostUpdateReason(d, lastAttempt)}`;
}

/** One stamp of the shell's record, or null for anything that is not one. */
function parseStamp(v: unknown): HostUpdateAttempt | null {
    const o = v as { version?: unknown; at?: unknown } | null;
    if (!o || typeof o !== 'object') return null;
    if (typeof o.version !== 'string' || !o.version) return null;
    if (typeof o.at !== 'number' || !Number.isFinite(o.at)) return null;
    return { version: o.version, at: o.at };
}

/** The shell's record as it answered (`{attempt?, seen?}`), with anything
 *  that is not a stamp read as none. */
export function parseHostUpdateRecord(raw: unknown): HostUpdateRecord {
    const o = raw && typeof raw === 'object' ? raw as { attempt?: unknown; seen?: unknown } : {};
    return { attempt: parseStamp(o.attempt), seen: parseStamp(o.seen) };
}

/** A failure's words for puca.log: one line, bounded, and with the user
 *  profile's folder name taken out of any path in it. */
export function hostUpdateFailureText(e: unknown): string {
    const msg = e instanceof Error ? e.message : String(e);
    return msg
        .replace(/[\r\n]+/g, ' ')
        .replace(/[A-Za-z]:[\\/]Users[\\/][^\\/\s]+/gi, '%USERPROFILE%')
        .slice(0, 200);
}
