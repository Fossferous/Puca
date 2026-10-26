/**
 * The runner (components/HostAutoUpdate.tsx) on a PC set up for remote
 * control: it installs a newer Púca by itself only while nobody is connected,
 * says what it decided in puca.log, and re-judges everything at the last
 * moment before the installer runs.
 *
 * Nothing real is installed or invoked: the shell's host-update commands
 * (host_update.rs: download, status, cancel, install, record), the server's
 * version check, the host switches, the idle probe, the transfer manager and
 * puca.log are fakes; the decision, the voice state and the settings store
 * are the real modules. Every "it must not install" has the quiet host that
 * does install as its control, in the same file and rig.
 *
 * The clock: the first look is a minute after mount, and the socket has just
 * connected at mount (the app mounts this once it has), so the first install
 * a quiet host can make is at the two-minute tick.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

type Snapshot = { id: string; role: string; phase: string };
type Transfer = { id: string; state: string };
const h = vi.hoisted(() => ({
    storage: new Map<string, string>(),
    available: '0.9.851' as string | null,
    armed: true,
    serviceInstalled: false,
    /** The OS idle probe's answer, seconds. */
    idle: 3_600,
    /** host_presence's notification state: 1 = locked / nobody in front. */
    presence: 1 as number | null,
    sessions: [] as Snapshot[],
    sessionListeners: new Set<(s: Snapshot[]) => void>(),
    transfers: [] as Transfer[],
    transferListeners: new Set<(t: Transfer[]) => void>(),
    logged: [] as string[],
    versionChecks: 0,
    commands: [] as string[],
    /** The fake shell's host update (host_update.rs), driven by the tests. */
    shell: {
        /** What the updater manifest offers; null = nothing newer yet. */
        offers: '0.9.851' as string | null,
        phase: 'idle' as 'idle' | 'checking' | 'downloading' | 'ready' | 'failed',
        version: null as string | null,
        error: null as string | null,
        /** A download that the test finishes (finishDownload) rather than one
         *  that is done by the first poll. */
        holdDownload: false,
        /** The next download fails with this. */
        downloadFails: null as string | null,
        /** host_update_install throws this (the installer never started). */
        installFails: null as string | null,
        /** host_update_note_seen cannot write its record. */
        noteSeenFails: false,
        /** What host_update_status says has arrived. */
        bytes: 0,
        /** host_update_offer fails this way (as the shell's bounded look
         *  does once a request hangs past its 30 s), while set. */
        offerFails: null as string | null,
        offerLooks: 0,
        downloads: 0,
        cancels: 0,
        installs: 0,
        record: {} as {
            attempt?: { version: string; at: number };
            seen?: { version: string; at: number };
            behind?: { version: string; at: number };
        },
        /** The version this build runs, as the shell knows it. */
        running: '0.9.850',
    },
}));

vi.mock('../api/platform', async (importOriginal) => {
    const real = await importOriginal<typeof import('../api/platform')>();
    return { ...real, isTauri: () => true };
});
vi.mock('@tauri-apps/api/core', () => ({
    invoke: async (cmd: string, args?: { line?: string; version?: string; expected?: string }) => {
        h.commands.push(cmd);
        if (cmd === 'get_idle_seconds') return h.idle;
        if (cmd === 'host_presence') return h.presence === null ? {} : { notificationState: h.presence };
        if (cmd === 'log_stream_diag') { h.logged.push(args?.line ?? ''); return undefined; }
        const sh = h.shell;
        if (cmd === 'host_update_offer') {
            sh.offerLooks++;
            if (sh.offerFails) throw new Error(sh.offerFails);
            // As host_update.rs: a look that finds nothing newer clears the
            // soak's clocks (a pulled release leaves none running).
            if (!sh.offers) sh.record = { ...(sh.record.attempt ? { attempt: sh.record.attempt } : {}) };
            return sh.offers;
        }
        if (cmd === 'host_update_download') {
            // A new request REPLACES whatever an earlier one left, as the
            // shell's begin() does (a page reloaded mid-download leaves one).
            sh.phase = 'checking';
            sh.version = null;
            sh.error = null;
            if (!sh.offers) { sh.phase = 'idle'; return null; }
            // Only the version the page judged (host_update.rs). A runner
            // that names none gets whatever is offered, as the shell before
            // the check did.
            if (args?.expected !== undefined && args.expected !== sh.offers) {
                sh.phase = 'idle';
                throw new Error(`the updater offers ${sh.offers} now, not ${args.expected}`);
            }
            sh.downloads++;
            sh.version = sh.offers;
            if (sh.downloadFails) { sh.phase = 'failed'; sh.error = sh.downloadFails; return sh.version; }
            sh.phase = sh.holdDownload ? 'downloading' : 'ready';
            return sh.version;
        }
        if (cmd === 'host_update_status') {
            return {
                phase: sh.phase, ...(sh.version ? { version: sh.version } : {}), ...(sh.error ? { error: sh.error } : {}),
                ...(sh.phase === 'downloading' || sh.phase === 'ready' ? { bytes: sh.bytes } : {}),
            };
        }
        if (cmd === 'host_update_cancel') { sh.cancels++; sh.phase = 'idle'; sh.version = null; return undefined; }
        if (cmd === 'host_update_install') {
            if (sh.phase !== 'ready') throw new Error('no downloaded update to install');
            if (sh.installFails) { sh.phase = 'idle'; throw new Error(sh.installFails); }
            sh.installs++;
            sh.record = { ...sh.record, attempt: { version: sh.version!, at: Date.now() } };
            sh.phase = 'idle';
            return undefined;
        }
        if (cmd === 'host_update_record') return sh.record;
        if (cmd === 'host_update_note_seen') {
            const version = (args as { version?: string } | undefined)?.version ?? '';
            if (sh.noteSeenFails) throw new Error('the disk is full');
            // As host_update.rs note_seen: behind since the first newer
            // version while the running one stays the same; the offered
            // version's own sighting per version.
            if (sh.record.behind?.version !== sh.running) sh.record = { ...sh.record, behind: { version: sh.running, at: Date.now() } };
            if (sh.record.seen?.version !== version) sh.record = { ...sh.record, seen: { version, at: Date.now() } };
            return { seenAt: sh.record.seen!.at, behindSince: sh.record.behind!.at };
        }
        throw new Error(`the rig does not know ${cmd}`);
    },
}));
/** The banner's in-place install (appVersion.ts): a host's own install must
 *  never take it, since it runs the installer in passive mode, on screen. */
const bannerInstall = vi.fn();
vi.mock('../api/appVersion', () => ({
    checkForNewVersion: async () => {
        h.versionChecks++;
        return h.available ? { version: h.available, download_url: 'https://downloads.invalid/' } : null;
    },
    installUpdateInPlace: (...a: unknown[]) => bannerInstall(...a),
}));
vi.mock('../api/devices/session', () => ({
    activeSessions: () => h.sessions,
    subscribeSessions: (l: (s: Snapshot[]) => void) => {
        h.sessionListeners.add(l);
        l(h.sessions);
        return () => { h.sessionListeners.delete(l); };
    },
}));
vi.mock('../api/devices/unattendedHost', () => ({
    unattendedState: async () => ({ armed: h.armed, salt: null }),
}));
vi.mock('../api/devices/lockScreen', () => ({
    lockScreenState: async () => ({ installed: h.serviceInstalled, running: h.serviceInstalled, available: true, problem: null }),
}));
vi.mock('../api/fileTransferManager', () => ({
    fileTransferManager: {
        list: () => h.transfers,
        subscribe: (fn: (t: Transfer[]) => void) => {
            h.transferListeners.add(fn);
            fn(h.transfers);
            return () => { h.transferListeners.delete(fn); };
        },
    },
}));

const { HostAutoUpdate } = await import('../components/HostAutoUpdate');
const { setSelfInVoice } = await import('../components/voiceState');
const { trackUpload, noteUnsent } = await import('../api/workInFlight');

/** The first tick a quiet host may install at, plus a little. */
const QUIET = 121_000;
const INSTALLING = 'installing 0.9.851: nobody connected';
const INSTALLING_NOW = 'installing 0.9.851 now: quietly, and Púca starts again in the tray';
const JUST_CONNECTED = 'update 0.9.851 available, waiting: this PC connected to the server, or woke up, less than 2 minutes ago';
const SETTLING = 'update 0.9.851 available, waiting: a session, call or file transfer ended less than 2 minutes ago';

/** How many installs the shell ran (each would replace this process). */
const installs = () => h.shell.installs;
/** The held download arrives, verified. */
const finishDownload = () => { if (h.shell.phase === 'downloading') h.shell.phase = 'ready'; };

let root: Root | null = null;
let host: HTMLDivElement | null = null;
async function mount() {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(<HostAutoUpdate />); });
}
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const lines = () => h.logged.map(l => l.replace(/^\[host-update\] /, ''));
const emitSessions = (list: Snapshot[]) => act(async () => {
    for (const l of h.sessionListeners) l(list);
});
const emitTransfers = (list: Transfer[]) => act(async () => {
    h.transfers = list;
    for (const l of h.transferListeners) l(list);
});
/** What the shell has on disk as the last install committed to. */
const attempt = () => h.shell.record.attempt ?? null;
function settings(over: Record<string, unknown>) {
    h.storage.set('sovereign_settings', JSON.stringify(over));
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 26, 12, 0, 0)));
    h.storage.clear();
    vi.mocked(localStorage.getItem).mockImplementation((k: string) => h.storage.get(k) ?? null);
    vi.mocked(localStorage.setItem).mockImplementation((k: string, v: string) => { h.storage.set(k, v); });
    h.available = '0.9.851';
    h.armed = true;
    h.serviceInstalled = false;
    h.idle = 3_600;
    h.presence = 1;
    h.sessions = [];
    h.sessionListeners.clear();
    h.transfers = [];
    h.transferListeners.clear();
    h.logged = [];
    h.versionChecks = 0;
    h.commands = [];
    bannerInstall.mockReset();
    h.shell = {
        offers: '0.9.851', phase: 'idle', version: null, error: null,
        holdDownload: false, downloadFails: null, installFails: null, noteSeenFails: false, bytes: 0,
        offerFails: null, offerLooks: 0,
        downloads: 0, cancels: 0, installs: 0, running: '0.9.850',
        // Behind for a day already, and this version out as long, so the soak
        // is over: every test below about the MOMENT starts from a version
        // the host may install.
        record: {
            seen: { version: '0.9.851', at: Date.now() - 25 * 3_600_000 },
            behind: { version: '0.9.850', at: Date.now() - 25 * 3_600_000 },
        },
    };
});
afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    host?.remove();
    root = null;
    host = null;
    setSelfInVoice(false);
    vi.useRealTimers();
});

describe('a PC set up for remote control, nobody connected', () => {
    it('POSITIVE CONTROL: installs once the connection has settled, says so, and remembers the attempt', async () => {
        await mount();
        await advance(61_000);
        expect(installs(), 'the socket connected a minute ago: someone may be on the way').toBe(0);
        expect(lines()).toEqual([JUST_CONNECTED]);
        await advance(QUIET - 61_000);
        expect(installs()).toBe(1);
        expect(lines()).toEqual([JUST_CONNECTED, INSTALLING, INSTALLING_NOW]);
        expect(attempt()).toMatchObject({ version: '0.9.851' });
        // The installer has taken over and this process is being replaced:
        // nothing more is decided, said or installed by it.
        await advance(15 * 60_000);
        expect(installs()).toBe(1);
        expect(lines()).toEqual([JUST_CONNECTED, INSTALLING, INSTALLING_NOW]);
    });

    // Review 2026-10-26: the banner's in-place install runs NSIS in passive
    // mode, a progress window on the screen of a PC nobody chose to update.
    it("installs through the shell (silent, back in the tray), never the banner's on-screen install", async () => {
        await mount();
        await advance(QUIET);
        expect(installs()).toBe(1);
        expect(h.commands).toContain('host_update_install');
        expect(bannerInstall, 'the passive, on-screen path').not.toHaveBeenCalled();
    });

    // Review 2026-10-26: the attempt was a localStorage write milliseconds
    // before the process exited, never shown to have been flushed.
    it("the attempt is the shell's record on disk, and every line is written before the installer", async () => {
        await mount();
        await advance(QUIET);
        expect(attempt(), 'the shell recorded it').toMatchObject({ version: '0.9.851' });
        expect(vi.mocked(localStorage.setItem).mock.calls.map(c => c[0]), "nothing of it in the webview's storage")
            .not.toContain('puca_host_update_attempt');
        const lastLog = h.commands.lastIndexOf('log_stream_diag');
        expect(lastLog, 'the line before the installer reached the log').toBeLessThan(h.commands.indexOf('host_update_install'));
        expect(h.logged.at(-1)).toBe(`[host-update] ${INSTALLING_NOW}`);
    });

    it('lock-screen access alone makes it a host too', async () => {
        h.armed = false;
        h.serviceInstalled = true;
        await mount();
        await advance(QUIET);
        expect(installs()).toBe(1);
    });
});

describe('it never installs', () => {
    it('on a PC that is not set up for remote control — and does not even ask the server', async () => {
        h.armed = false;
        h.serviceInstalled = false;
        await mount();
        await advance(25 * 60_000);
        expect(installs()).toBe(0);
        expect(h.versionChecks, 'every other PC is the banner\'s').toBe(0);
        expect(lines()).toEqual([]);
        expect(h.commands, 'nor read the idle probe every half minute').not.toContain('get_idle_seconds');
    });

    it('while a session is live; after it ends, only once the settle is over', async () => {
        h.sessions = [{ id: 'ds-1', role: 'host', phase: 'active' }];
        await mount();
        await advance(QUIET);
        expect(installs()).toBe(0);
        expect(lines()).toEqual(['update 0.9.851 available, waiting: a session is live']);
        await advance(10 * 60_000 + 25_000);
        expect(installs(), 'a long session is waited out').toBe(0);
        expect(lines(), 'and said once, not every tick').toHaveLength(1);
        // It ends 26 s after the last look saw it (746 s): the ended session
        // is emitted, then it is gone. The settle runs from THAT moment, not
        // from the last look that saw it live.
        await emitSessions([{ id: 'ds-1', role: 'host', phase: 'ended' }]);
        h.sessions = [];
        await emitSessions([]);
        await advance(30_000);
        expect(installs()).toBe(0);
        expect(lines().at(-1)).toBe(SETTLING);
        await advance(70_000);
        expect(installs(), '2 min from the last look that saw it, but not from its end').toBe(0);
        await advance(30_000);
        expect(installs()).toBe(1);
        expect(lines().slice(-2)).toEqual([INSTALLING, INSTALLING_NOW]);
    });

    it('while a session is STARTING (connecting) too', async () => {
        h.sessions = [{ id: 'ds-2', role: 'host', phase: 'connecting' }];
        await mount();
        await advance(5 * 60_000);
        expect(installs()).toBe(0);
    });

    it('while this PC controls another one (a controller session is a session)', async () => {
        h.sessions = [{ id: 'ds-3', role: 'controller', phase: 'active' }];
        await mount();
        await advance(5 * 60_000);
        expect(installs()).toBe(0);
    });

    it('during a call, so a call is never dropped', async () => {
        await mount();
        act(() => { setSelfInVoice(true); });
        await advance(QUIET);
        expect(installs()).toBe(0);
        expect(lines()).toEqual(['update 0.9.851 available, waiting: a call is active here']);
        // The call ends at 146 s, 26 s after the last look saw it.
        await advance(25_000);
        act(() => { setSelfInVoice(false); });
        await advance(60_000);
        expect(installs(), 'the settle after the call').toBe(0);
        await advance(39_000);
        expect(installs(), '2 min from the last look that saw it, but not from its end').toBe(0);
        await advance(30_000);
        expect(installs()).toBe(1);
    });

    it('while a DM\'s direct file transfer runs, nor until the settle after it', async () => {
        await emitTransfers([{ id: 't1', state: 'transferring' }]);
        await mount();
        await advance(QUIET);
        expect(installs()).toBe(0);
        expect(lines()).toEqual(['update 0.9.851 available, waiting: a file transfer is running']);
        // It finishes at 149 s, 29 s after the last look saw it running: the
        // settle runs from its end.
        await advance(28_000);
        await emitTransfers([{ id: 't1', state: 'complete' }]);
        await advance(30_000);
        expect(installs(), 'the settle after it').toBe(0);
        expect(lines().at(-1)).toBe(SETTLING);
        await advance(66_000);
        expect(installs(), '2 min from the last look that saw it, but not from its end').toBe(0);
        await advance(30_000);
        expect(installs()).toBe(1);
    });

    it('CONTROL: a transfer that finished before is no reason to wait', async () => {
        await emitTransfers([{ id: 't0', state: 'complete' }, { id: 't9', state: 'failed' }]);
        await mount();
        await advance(QUIET);
        expect(installs()).toBe(1);
    });

    it('while someone uses the keyboard or mouse', async () => {
        h.idle = 30;
        await mount();
        await advance(QUIET);
        expect(installs()).toBe(0);
        expect(lines().at(-1)).toBe("update 0.9.851 available, waiting: this PC's keyboard or mouse was used in the last 10 minutes");
        h.idle = 700;
        await advance(30_000);
        expect(installs()).toBe(1);
    });

    it('with the switch turned off, and says so once', async () => {
        settings({ hostAutoUpdate: false });
        await mount();
        await advance(15 * 60_000);
        expect(installs()).toBe(0);
        expect(lines()).toEqual(['update 0.9.851 available; this PC does not install updates by itself (turned off in Devices, This device)']);
    });

    it('with nothing newer published', async () => {
        h.available = null;
        await mount();
        await advance(15 * 60_000);
        expect(installs()).toBe(0);
        expect(lines()).toEqual([]);
    });

    it('a version whose install here did not take, until a day has passed', async () => {
        const at = Date.now() - 60 * 60_000;
        h.shell.record = { ...h.shell.record, attempt: { version: '0.9.851', at } };
        await mount();
        await advance(QUIET);
        expect(installs()).toBe(0);
        expect(lines().at(-1)).toMatch(/^update 0\.9\.851 available, waiting: installing it here at .* did not take; trying again after /);
    });
});

// Review 2026-10-26, reshaped in round 3: a bad release must not take down
// every PC nobody is at the moment it ships, and a burst of releases must not
// keep a host behind. Behind a day, and the version out 2 hours; both times
// are the shell's, on disk.
describe('a version just released', () => {
    const DAY = 24 * 3_600_000;

    it('waits a day after the PC falls behind, says until when, then installs', async () => {
        h.shell.record = {};
        await mount();
        await advance(QUIET);
        expect(installs()).toBe(0);
        expect(h.shell.record.seen, 'the first sighting is recorded by the shell').toMatchObject({ version: '0.9.851' });
        expect(h.shell.record.behind, 'and since when it is behind').toMatchObject({ version: '0.9.850' });
        expect(lines().at(-1)).toMatch(/^update 0\.9\.851 available, waiting: a PC set up for remote control installs once it has been behind for 24 hours and the version on offer has been out for 2 hours; not before /);
        await advance(DAY - QUIET - 60_000);
        expect(installs(), 'a minute short of the day').toBe(0);
        await advance(11 * 60_000);
        expect(installs()).toBe(1);
    });

    it('a restart does not restart the clock: both times are on disk', async () => {
        const at = Date.now() - (DAY - 30 * 60_000);
        h.shell.record = { seen: { version: '0.9.851', at }, behind: { version: '0.9.850', at } };
        await mount();
        await advance(QUIET);
        expect(installs(), 'seen 23.5 h ago, before this run').toBe(0);
        await advance(40 * 60_000);
        expect(installs()).toBe(1);
    });

    // The coordinator's case: during a burst the old rule (a day per
    // version) never caught up. Behind a day, the newest waits only 2 hours.
    it('a burst of releases does not hold it back: behind a day, the newest installs 2 hours after it is out', async () => {
        h.available = '0.9.852';
        h.shell.offers = '0.9.852';
        await mount();
        await advance(QUIET);
        expect(installs(), '0.9.852 just out').toBe(0);
        expect(h.shell.record.seen).toMatchObject({ version: '0.9.852' });
        expect(h.shell.record.behind!.at, 'still behind since the first newer version').toBeLessThan(Date.now() - DAY);
        await advance(2 * 3_600_000 - QUIET - 60_000);
        expect(installs(), 'a minute short of 2 hours').toBe(0);
        await advance(11 * 60_000);
        expect(installs()).toBe(1);
    });

    // Coordinator, round 3: behind was never cleared while nothing newer was
    // offered, so V seen and then pulled left its clock running, and a V'
    // weeks later got only the 2 h soak.
    it('a pulled release leaves no clock running: the next version waits its full day', async () => {
        // 0.9.851 was seen 25 h ago (the default record), then pulled: a look
        // finds nothing newer anywhere.
        h.available = null;
        h.shell.offers = null;
        await mount();
        await advance(QUIET);
        expect(h.shell.record.behind, 'nothing newer: not behind').toBeUndefined();
        // 0.9.852 ships.
        h.available = '0.9.852';
        h.shell.offers = '0.9.852';
        await advance(10 * 60_000);
        expect(h.shell.record.behind).toBeDefined();
        await advance(3 * 3_600_000);
        expect(installs(), 'not 2 h after it: a day from it').toBe(0);
        await advance(DAY);
        expect(installs()).toBe(1);
    });

    it('CONTROL: updated, it is behind again only from the next newer version', async () => {
        h.shell.running = '0.9.851';
        h.available = '0.9.852';
        h.shell.offers = '0.9.852';
        await mount();
        await advance(QUIET);
        expect(h.shell.record.behind).toMatchObject({ version: '0.9.851' });
        expect(installs()).toBe(0);
        await advance(3 * 3_600_000);
        expect(installs(), 'a new day from the update').toBe(0);
    });

    it('if the shell cannot record it, the day counts from this run, never less', async () => {
        h.shell.record = {};
        h.shell.noteSeenFails = true;
        await mount();
        await advance(QUIET);
        expect(installs()).toBe(0);
        await advance(DAY);
        expect(installs()).toBe(1);
    });
});

// Review 2026-10-26: idle is not "nobody here", and a restart loses what
// is on its way or written and not sent.
describe('what idleness cannot see', () => {
    it('a film or a game full screen (no keyboard for an hour) keeps it waiting', async () => {
        h.presence = 2; // busy: something full screen
        await mount();
        await advance(QUIET);
        expect(installs()).toBe(0);
        expect(lines().at(-1)).toBe("update 0.9.851 available, waiting: something is on this PC's screen full screen or presented (a film, a game, slides)");
        h.presence = 5; // CONTROL: nothing full screen any more
        await advance(30_000);
        expect(installs()).toBe(1);
    });

    it('a DM file being prepared or offered keeps it waiting, not only one being sent', async () => {
        await emitTransfers([{ id: 't1', state: 'preparing' }]);
        await mount();
        await advance(QUIET);
        expect(installs()).toBe(0);
        expect(lines().at(-1)).toBe('update 0.9.851 available, waiting: a file transfer is running');
        await emitTransfers([{ id: 't1', state: 'offered' }]);
        await advance(5 * 60_000);
        expect(installs(), 'an offer waiting for its answer').toBe(0);
        await emitTransfers([{ id: 't1', state: 'cancelled' }]);
        await advance(3 * 60_000);
        expect(installs(), 'CONTROL: once it is over, after the settle').toBe(1);
    });

    it('an attachment or a Clip on its way to the server keeps it waiting', async () => {
        let done: () => void = () => { /* set below */ };
        const upload = trackUpload(new Promise<void>(r => { done = r; }));
        await mount();
        await advance(QUIET);
        expect(installs()).toBe(0);
        expect(lines().at(-1)).toBe('update 0.9.851 available, waiting: a file is being uploaded from here');
        await act(async () => { done(); await upload; });
        await advance(30_000);
        expect(installs(), 'CONTROL: uploaded').toBe(1);
    });

    it('a message written in the composer and not sent keeps it waiting', async () => {
        noteUnsent('chat-composer', true);
        try {
            await mount();
            await advance(QUIET);
            expect(installs()).toBe(0);
            expect(lines().at(-1)).toBe('update 0.9.851 available, waiting: a message is being written here and has not been sent');
        } finally {
            noteUnsent('chat-composer', false);
        }
        await advance(30_000);
        expect(installs(), 'CONTROL: sent, or cleared').toBe(1);
    });
});

describe('someone may be about to connect', () => {
    it('the socket reconnecting (a network drop, a wake) starts the settle again', async () => {
        await mount();
        await advance(100_000);
        act(() => { window.dispatchEvent(new CustomEvent('wsConnected')); });
        await advance(30_000);
        expect(installs(), 'reconnected 30 s ago').toBe(0);
        expect(lines().at(-1)).toBe(JUST_CONNECTED);
        await advance(80_000);
        expect(installs(), 'still inside the settle (110 s)').toBe(0);
        await advance(40_000);
        expect(installs()).toBe(1);
    });

    it('waking from sleep (a look far later than its timer asked) starts it too', async () => {
        await mount();
        await advance(90_000);
        // Asleep for ten minutes: the clock jumps, no timer fired meanwhile.
        vi.setSystemTime(new Date(Date.now() + 10 * 60_000));
        await advance(30_000);
        expect(installs(), 'just woke').toBe(0);
        expect(lines().at(-1)).toBe(JUST_CONNECTED);
        await advance(120_000);
        expect(installs()).toBe(1);
    });
});

describe('while the update downloads, and the last check before the installer', () => {
    // Review 2026-10-26: the download used to run to its end whatever
    // started meanwhile, and be thrown away only at the last check.
    it('a session that starts while the update downloads STOPS the download, and keeps the PC as it is', async () => {
        h.shell.holdDownload = true;
        await mount();
        await advance(QUIET);
        expect(h.shell.downloads).toBe(1);
        expect(h.shell.phase).toBe('downloading');
        // Someone connects mid-download.
        h.sessions = [{ id: 'ds-4', role: 'host', phase: 'connecting' }];
        await advance(2_100);
        expect(lines().at(-1)).toBe('not installing 0.9.851 after all: a session is live; the download was stopped');
        expect(h.shell.cancels, "the shell's download task was aborted").toBe(1);
        expect(h.shell.phase).toBe('idle');
        expect(installs()).toBe(0);
        expect(attempt(), 'nothing committed, so nothing counted against the version').toBeNull();
        // And it waits for the next quiet spell rather than retrying at once.
        await advance(30_000);
        expect(h.shell.downloads).toBe(1);
        expect(lines().at(-1)).toBe('update 0.9.851 available, waiting: a session is live');
    });

    it('CONTROL: left alone, the same download goes on to install', async () => {
        h.shell.holdDownload = true;
        await mount();
        await advance(QUIET);
        await advance(4_000);
        expect(installs(), 'still downloading').toBe(0);
        finishDownload();
        await advance(2_100);
        expect(lines().some(l => l.startsWith('not installing'))).toBe(false);
        expect(h.shell.cancels).toBe(0);
        expect(installs()).toBe(1);
        expect(attempt()).toMatchObject({ version: '0.9.851' });
    });

    // Coordinator, round 3: a reload mid-download left the shell downloading
    // or holding, with nobody to cancel it, and every later request was
    // refused until Púca restarted. The shell now replaces it (begin()).
    it('a download an earlier page left behind (a reload mid-download) does not stop this one', async () => {
        h.shell.phase = 'ready';
        h.shell.version = '0.9.850';
        await mount();
        await advance(QUIET);
        expect(installs()).toBe(1);
        expect(attempt()).toMatchObject({ version: '0.9.851' });
    });

    // Coordinator, round 3: the updater has no timeout, so a stalled
    // connection held a host's update for ever.
    it('a download that receives nothing for 2 minutes is stopped, and tried again after the back-off', async () => {
        h.shell.holdDownload = true;
        await mount();
        await advance(QUIET);
        expect(h.shell.phase).toBe('downloading');
        await advance(2 * 60_000 - 5_000);
        expect(h.shell.cancels, 'still inside the 2 minutes').toBe(0);
        await advance(10_000);
        expect(h.shell.cancels).toBe(1);
        expect(lines().at(-1)).toBe('downloading 0.9.851 failed: nothing arrived for 2 minutes');
        h.shell.holdDownload = false;
        await advance(25 * 60_000);
        expect(h.shell.downloads, 'not again inside the back-off').toBe(1);
        await advance(6 * 60_000);
        expect(installs()).toBe(1);
    });

    it('CONTROL: a slow download that keeps receiving is left to finish', async () => {
        h.shell.holdDownload = true;
        await mount();
        await advance(QUIET);
        for (let i = 0; i < 150; i++) {   // five minutes of 2 s polls
            h.shell.bytes += 1_000;
            await advance(2_000);
        }
        expect(h.shell.cancels).toBe(0);
        expect(h.shell.phase).toBe('downloading');
        finishDownload();
        await advance(2_100);
        expect(installs()).toBe(1);
    });

    // Coordinator, round 3: a look at latest.json that hung kept the look
    // busy, and with it every later one, until Púca restarted. The shell now
    // ends it at its bound as a failed look.
    it('a look the updater does not answer is a failed look, said once, and the next look runs', async () => {
        h.shell.offerFails = 'the updater did not answer within 30 s';
        await mount();
        await advance(QUIET);
        expect(installs()).toBe(0);
        const failed = 'asking the updater what it offers failed: the updater did not answer within 30 s; asking again at the next look';
        expect(lines()).toContain(failed);
        await advance(10 * 60_000);
        expect(h.shell.offerLooks, 'the next look ran').toBeGreaterThanOrEqual(2);
        expect(lines().filter(l => l === failed), 'said once while it fails the same way').toHaveLength(1);
        h.shell.offerFails = null;
        await advance(10 * 60_000);
        expect(installs(), 'answered at a later look, it installs').toBe(1);
    });

    it('Púca closing mid-download (the runner unmounted) drops the download, so nothing is left held', async () => {
        h.shell.holdDownload = true;
        await mount();
        await advance(QUIET);
        expect(h.shell.phase).toBe('downloading');
        await act(async () => root!.unmount());
        root = null;
        await advance(2_100);
        expect(h.shell.cancels).toBe(1);
        expect(h.shell.phase).toBe('idle');
        expect(installs()).toBe(0);
    });

    it('someone at the keyboard during the download stops it too (probed every 2 s meanwhile)', async () => {
        h.shell.holdDownload = true;
        await mount();
        await advance(QUIET);
        h.idle = 1;
        await advance(4_500);
        expect(lines().at(-1)).toBe("not installing 0.9.851 after all: this PC's keyboard or mouse was used in the last 10 minutes; the download was stopped");
        expect(h.shell.cancels).toBe(1);
        expect(attempt()).toBeNull();
    });

    it("the updater offering nothing yet (its manifest behind the server): said once, and installed once it does and the soak is over", async () => {
        h.shell.offers = null;
        await mount();
        await advance(QUIET);
        expect(installs()).toBe(0);
        expect(h.shell.downloads, 'nothing is downloaded while nothing is offered').toBe(0);
        expect(lines().at(-1)).toBe('update 0.9.851 available, waiting: the updater does not offer it yet');
        // Per what installs, this PC was not behind: its day starts when the
        // updater offers the version (round 3: a look with nothing newer clears
        // the soak's clocks).
        h.shell.offers = '0.9.851';
        await advance(10 * 60_000);
        expect(installs(), 'a day from when it is offered, not at once').toBe(0);
        expect(lines().filter(l => l.endsWith('the updater does not offer it yet'))).toHaveLength(1);
        await advance(24 * 3_600_000);
        expect(installs()).toBe(1);
    });

    // Coordinator, round 3: keyed on /app-version's version while
    // latest.json's installed, a version that did not take was never matched
    // by the 24 h guard while the two disagreed, and was installed again on
    // every run.
    it('the server and the updater disagreeing for good never loops: nothing downloads, nothing installs', async () => {
        h.available = '0.9.851';
        h.shell.offers = '0.9.852';
        h.shell.record = { ...h.shell.record, seen: { version: '0.9.852', at: Date.now() - 25 * 3_600_000 } };
        // Three runs of Púca, each coming back on the same old version.
        for (let run = 0; run < 3; run++) {
            await mount();
            await advance(30 * 60_000);
            await act(async () => root!.unmount());
            root = null;
        }
        expect(h.shell.downloads).toBe(0);
        expect(installs()).toBe(0);
        const said = lines().filter(l => l.includes('updater offers 0.9.852'));
        expect(said, 'said once a run').toHaveLength(3);
        expect(said[0]).toBe('update 0.9.851 available, waiting: the server announces it but the updater offers 0.9.852; waiting until the two agree');
    });
});

describe('a failure', () => {
    it('of the download is logged without the user folder, and retried only after the back-off', async () => {
        h.shell.downloadFails = 'could not reach C:\\Users\\someone\\AppData\\x: network down';
        await mount();
        await advance(QUIET);
        expect(h.shell.downloads).toBe(1);
        expect(lines().at(-1)).toBe('downloading 0.9.851 failed: could not reach %USERPROFILE%\\AppData\\x: network down');
        await advance(29 * 60_000);
        expect(h.shell.downloads, 'not hammered every tick').toBe(1);
        h.shell.downloadFails = null;
        await advance(2 * 60_000);
        expect(h.shell.downloads).toBe(2);
        expect(installs()).toBe(1);
    });

    it('of the installer (it never started) is logged, and backed off the same way', async () => {
        h.shell.installFails = 'could not run the installer';
        await mount();
        await advance(QUIET);
        expect(installs()).toBe(0);
        expect(lines().at(-1)).toBe('installing 0.9.851 failed: could not run the installer');
        await advance(29 * 60_000);
        expect(h.shell.downloads).toBe(1);
        h.shell.installFails = null;
        await advance(2 * 60_000);
        expect(installs()).toBe(1);
    });
});
