/**
 * A PC set up for remote control installs a newer Púca by itself while nobody
 * is connected (api/devices/hostUpdate.ts) — the owner's decision of
 * 2026-10-26, after a laptop host sat on 0.9.844 for days with nobody at it to
 * click the banner.
 *
 * Every condition has its own NEGATIVE CONTROL against the same quiet host
 * that installs (the positive control first): not a host, a session live, a
 * call, a direct file transfer, the settle after one, a connection to the
 * server (or a wake) moments ago, someone at the keyboard, the switch off, an
 * install that already did not take, and a build that could not say it is a
 * host (a Lite build has no host switches at all).
 */
import { describe, it, expect } from 'vitest';
import {
    HOST_UPDATE_IDLE_SECS,
    HOST_UPDATE_RETRY_MS,
    HOST_UPDATE_SETTLE_MS,
    HOST_UPDATE_BEHIND_MS,
    HOST_UPDATE_FRESH_MS,
    decideHostUpdate,
    nobodyWatching,
    hostUpdateFailureText,
    hostUpdateLogLine,
    hostUpdateReason,
    isRemoteControlHost,
    parseHostUpdateRecord,
    type HostUpdateFacts,
} from '../api/devices/hostUpdate';

const NOW = Date.UTC(2026, 9, 26, 12, 0, 0);

/** A quiet host with an update: the one case that installs. */
function quiet(over: Partial<HostUpdateFacts> = {}): HostUpdateFacts {
    return {
        enabled: true,
        host: true,
        available: '0.9.851',
        // latest.json agrees with /app-version.
        offered: '0.9.851',
        // Behind for a day, and this version out as long: the soak is over.
        seenAt: NOW - HOST_UPDATE_BEHIND_MS,
        behindSince: NOW - HOST_UPDATE_BEHIND_MS,
        sessionLive: false,
        inCall: false,
        transferLive: false,
        uploading: false,
        unsent: false,
        // Locked, or nobody in front of it: how a PC nobody is at sits.
        notificationState: 1,
        quietForMs: Number.MAX_SAFE_INTEGER,
        onlineForMs: Number.MAX_SAFE_INTEGER,
        idleSecs: 3_600,
        lastAttempt: null,
        now: NOW,
        ...over,
    };
}

describe('decideHostUpdate', () => {
    it('POSITIVE CONTROL: a quiet host installs, and says so', () => {
        const d = decideHostUpdate(quiet());
        expect(d).toEqual({ act: 'install', version: '0.9.851' });
        expect(hostUpdateLogLine(d)).toBe('installing 0.9.851: nobody connected');
    });

    it('not a host: nothing, and no line (every other PC is the banner\'s)', () => {
        const d = decideHostUpdate(quiet({ host: false }));
        expect(d).toEqual({ act: 'none', why: 'not-a-host' });
        expect(hostUpdateLogLine(d)).toBeNull();
    });

    it('could not tell whether it is a host (a Lite build has neither switch): never a yes', () => {
        expect(decideHostUpdate(quiet({ host: null })).act).toBe('none');
    });

    it('a session live: waits, and the line says why', () => {
        const d = decideHostUpdate(quiet({ sessionLive: true }));
        expect(d).toMatchObject({ act: 'wait', why: 'session', version: '0.9.851' });
        expect(hostUpdateLogLine(d)).toBe('update 0.9.851 available, waiting: a session is live');
    });

    it('a call active here: waits, so a call is never dropped', () => {
        const d = decideHostUpdate(quiet({ inCall: true }));
        expect(d).toMatchObject({ act: 'wait', why: 'call' });
        expect(hostUpdateLogLine(d)).toBe('update 0.9.851 available, waiting: a call is active here');
    });

    it('a DM\'s direct file transfer running: waits, so it is not cut off', () => {
        const d = decideHostUpdate(quiet({ transferLive: true }));
        expect(d).toMatchObject({ act: 'wait', why: 'transfer' });
        expect(hostUpdateLogLine(d)).toBe('update 0.9.851 available, waiting: a file transfer is running');
    });

    it('a session or call that ended moments ago: waits for the settle, then installs', () => {
        expect(decideHostUpdate(quiet({ quietForMs: HOST_UPDATE_SETTLE_MS - 1 }))).toMatchObject({ act: 'wait', why: 'settling' });
        expect(decideHostUpdate(quiet({ quietForMs: HOST_UPDATE_SETTLE_MS })).act).toBe('install');
    });

    it('just (re)connected to the server, or woken from sleep: waits the same settle — someone may be about to connect', () => {
        const d = decideHostUpdate(quiet({ onlineForMs: HOST_UPDATE_SETTLE_MS - 1 }));
        expect(d).toMatchObject({ act: 'wait', why: 'reconnected' });
        expect(hostUpdateLogLine(d)).toBe('update 0.9.851 available, waiting: this PC connected to the server, or woke up, less than 2 minutes ago');
        expect(decideHostUpdate(quiet({ onlineForMs: HOST_UPDATE_SETTLE_MS })).act).toBe('install');
    });

    it('someone used the keyboard or mouse recently: waits', () => {
        const d = decideHostUpdate(quiet({ idleSecs: HOST_UPDATE_IDLE_SECS - 1 }));
        expect(d).toMatchObject({ act: 'wait', why: 'someone-here' });
        expect(hostUpdateLogLine(d)).toContain("keyboard or mouse was used in the last 10 minutes");
        expect(decideHostUpdate(quiet({ idleSecs: HOST_UPDATE_IDLE_SECS })).act).toBe('install');
    });

    it('a NaN anywhere is never read as quiet', () => {
        expect(decideHostUpdate(quiet({ idleSecs: Number.NaN })).act).toBe('wait');
        expect(decideHostUpdate(quiet({ quietForMs: Number.NaN })).act).toBe('wait');
        expect(decideHostUpdate(quiet({ onlineForMs: Number.NaN })).act).toBe('wait');
    });

    it('the switch off: nothing installs, and a host says once that it is off', () => {
        const d = decideHostUpdate(quiet({ enabled: false }));
        expect(d).toEqual({ act: 'none', why: 'off', version: '0.9.851' });
        expect(hostUpdateLogLine(d)).toBe('update 0.9.851 available; this PC does not install updates by itself (turned off in Devices, This device)');
    });

    it('nothing newer: nothing, and no line', () => {
        const d = decideHostUpdate(quiet({ available: null }));
        expect(d).toEqual({ act: 'none', why: 'up-to-date' });
        expect(hostUpdateLogLine(d)).toBeNull();
    });

    it('an install of this version that did not take: waits a day, then tries once more', () => {
        const at = NOW - 60 * 60_000;
        const lastAttempt = { version: '0.9.851', at };
        const d = decideHostUpdate(quiet({ lastAttempt }));
        expect(d).toEqual({ act: 'wait', why: 'tried', version: '0.9.851', retryAt: at + HOST_UPDATE_RETRY_MS });
        expect(hostUpdateLogLine(d, lastAttempt)).toBe(
            `update 0.9.851 available, waiting: installing it here at ${new Date(at).toISOString()} did not take; `
            + `trying again after ${new Date(at + HOST_UPDATE_RETRY_MS).toISOString()}`,
        );
        expect(decideHostUpdate(quiet({ lastAttempt: { version: '0.9.851', at: NOW - HOST_UPDATE_RETRY_MS } })).act).toBe('install');
        // A DIFFERENT version is a fresh start: the guard is per version.
        expect(decideHostUpdate(quiet({ lastAttempt: { version: '0.9.850', at } })).act).toBe('install');
    });

    // Review 2026-10-26, reshaped in round 3: a bad release must not take
    // down every PC nobody is at the moment it ships, and a burst of releases
    // must not keep a host behind. Behind a day, AND the version out 2 hours.
    it('behind for less than a day: waits for the day, however old the version on offer', () => {
        const behindSince = NOW - 3 * 3_600_000;
        const d = decideHostUpdate(quiet({ behindSince, seenAt: behindSince }));
        expect(d).toEqual({ act: 'wait', why: 'soaking', version: '0.9.851', retryAt: behindSince + HOST_UPDATE_BEHIND_MS });
        expect(hostUpdateLogLine(d)).toBe('update 0.9.851 available, waiting: a PC set up for remote control installs once it '
            + 'has been behind for 24 hours and the version on offer has been out for 2 hours; '
            + `not before ${new Date(behindSince + HOST_UPDATE_BEHIND_MS).toISOString()}`);
        expect(decideHostUpdate(quiet({ behindSince: NOW - HOST_UPDATE_BEHIND_MS + 1 })).act, 'a millisecond short').toBe('wait');
        expect(decideHostUpdate(quiet({ behindSince: NOW - HOST_UPDATE_BEHIND_MS })).act, 'CONTROL: a day').toBe('install');
    });

    it('a burst of releases: behind for a day, the newest one just out waits only its 2 hours, not a day', () => {
        const seenAt = NOW - 30 * 60_000;
        const d = decideHostUpdate(quiet({ available: '0.9.853', offered: '0.9.853', seenAt }));
        expect(d).toEqual({ act: 'wait', why: 'soaking', version: '0.9.853', retryAt: seenAt + HOST_UPDATE_FRESH_MS });
        expect(decideHostUpdate(quiet({ seenAt: NOW - HOST_UPDATE_FRESH_MS + 1 })).act, 'a millisecond short of 2 h').toBe('wait');
        expect(decideHostUpdate(quiet({ seenAt: NOW - HOST_UPDATE_FRESH_MS })).act, 'CONTROL: 2 hours, behind a day').toBe('install');
    });

    it('not known yet when it fell behind or when the version came out: waits, never reads that as long ago', () => {
        expect(decideHostUpdate(quiet({ seenAt: null }))).toEqual({ act: 'wait', why: 'soaking', version: '0.9.851' });
        expect(decideHostUpdate(quiet({ behindSince: null }))).toEqual({ act: 'wait', why: 'soaking', version: '0.9.851' });
        expect(decideHostUpdate(quiet({ seenAt: Number.NaN })).act).toBe('wait');
        expect(decideHostUpdate(quiet({ behindSince: Number.NaN }))).toEqual({ act: 'wait', why: 'soaking', version: '0.9.851' });
    });

    // Review 2026-10-26: keyboard-and-mouse idleness is not "nobody here".
    it('a film, a game on a controller, a presentation: waits, though nobody touched the keyboard', () => {
        for (const state of [2, 3, 4, 6, 7]) {
            const d = decideHostUpdate(quiet({ notificationState: state }));
            expect(d, String(state)).toEqual({ act: 'wait', why: 'in-use', version: '0.9.851' });
        }
        expect(hostUpdateLogLine(decideHostUpdate(quiet({ notificationState: 3 }))))
            .toBe("update 0.9.851 available, waiting: something is on this PC's screen full screen or presented (a film, a game, slides)");
    });

    it('CONTROL: locked or switched away, or nothing full screen, installs; unreadable is no reason to wait', () => {
        for (const state of [1, 5, null]) {
            expect(decideHostUpdate(quiet({ notificationState: state })).act, String(state)).toBe('install');
        }
        expect(nobodyWatching(1) && nobodyWatching(5) && nobodyWatching(null)).toBe(true);
        expect(nobodyWatching(0), 'a value Windows does not give is not a yes').toBe(false);
    });

    it('an upload on its way, or a message written and not sent: waits, so neither is lost', () => {
        expect(decideHostUpdate(quiet({ uploading: true }))).toEqual({ act: 'wait', why: 'upload', version: '0.9.851' });
        expect(decideHostUpdate(quiet({ unsent: true }))).toEqual({ act: 'wait', why: 'unsent', version: '0.9.851' });
        expect(hostUpdateLogLine(decideHostUpdate(quiet({ unsent: true }))))
            .toBe('update 0.9.851 available, waiting: a message is being written here and has not been sent');
    });

    // Coordinator, round 3: what installs is latest.json's version; the
    // server's /app-version must agree, and the soak and guard key on it.
    it('the updater offering nothing (yet): waits, and says so', () => {
        const d = decideHostUpdate(quiet({ offered: null }));
        expect(d).toEqual({ act: 'wait', why: 'not-offered', version: '0.9.851' });
        expect(hostUpdateLogLine(d)).toBe('update 0.9.851 available, waiting: the updater does not offer it yet');
    });

    it('the server and the updater naming different versions (a ship in progress): waits until they agree', () => {
        const d = decideHostUpdate(quiet({ offered: '0.9.852' }));
        expect(d).toEqual({ act: 'wait', why: 'disagree', version: '0.9.851', offered: '0.9.852' });
        expect(hostUpdateLogLine(d)).toBe('update 0.9.851 available, waiting: the server announces it but the '
            + 'updater offers 0.9.852; waiting until the two agree');
        expect(decideHostUpdate(quiet({ available: '0.9.851.0', offered: '0.9.851' })).act, 'CONTROL: one version, two spellings').toBe('install');
    });

    it('the loop guard keys on the version that installs', () => {
        const at = NOW - 60 * 60_000;
        const d = decideHostUpdate(quiet({ available: '0.9.851.0', lastAttempt: { version: '0.9.851', at } }));
        expect(d).toMatchObject({ act: 'wait', why: 'tried', version: '0.9.851' });
    });

    it('the soak is what a line names first: it is the longest wait', () => {
        expect(decideHostUpdate(quiet({ seenAt: NOW, sessionLive: true, idleSecs: 0 }))).toMatchObject({ why: 'soaking' });
    });

    it('the order a line names: what is live first, then what just ended, then the keyboard', () => {
        const all = { sessionLive: true, inCall: true, transferLive: true, quietForMs: 0, onlineForMs: 0, idleSecs: 0 };
        expect(decideHostUpdate(quiet(all))).toMatchObject({ why: 'session' });
        expect(decideHostUpdate(quiet({ ...all, sessionLive: false }))).toMatchObject({ why: 'call' });
        expect(decideHostUpdate(quiet({ ...all, sessionLive: false, inCall: false }))).toMatchObject({ why: 'transfer' });
        expect(decideHostUpdate(quiet({ quietForMs: 0, onlineForMs: 0, idleSecs: 0 }))).toMatchObject({ why: 'settling' });
        expect(decideHostUpdate(quiet({ onlineForMs: 0, idleSecs: 0 }))).toMatchObject({ why: 'reconnected' });
        expect(decideHostUpdate(quiet({ idleSecs: 0 }))).toMatchObject({ why: 'someone-here' });
    });
});

describe('isRemoteControlHost', () => {
    it('one switch on is enough; both off is no; an unknown is never promoted to yes', () => {
        expect(isRemoteControlHost(true, false)).toBe(true);
        expect(isRemoteControlHost(false, true)).toBe(true);
        expect(isRemoteControlHost(true, null)).toBe(true);
        expect(isRemoteControlHost(null, true)).toBe(true);
        expect(isRemoteControlHost(false, false)).toBe(false);
        expect(isRemoteControlHost(false, null)).toBeNull();
        expect(isRemoteControlHost(null, null)).toBeNull();
    });
});

describe('hostUpdateReason', () => {
    it('words every non-install, which the last check before the installer logs', () => {
        expect(hostUpdateReason({ act: 'install', version: '1.0.0' })).toBeNull();
        expect(hostUpdateReason({ act: 'wait', why: 'session', version: '1.0.0' })).toBe('a session is live');
        expect(hostUpdateReason({ act: 'none', why: 'off', version: '1.0.0' })).toContain('turned off');
        expect(hostUpdateReason({ act: 'none', why: 'not-a-host' })).toBe('this PC is not set up for remote control');
    });
});

describe('parseHostUpdateRecord', () => {
    it('reads what the shell answers (host_update.rs Record), and nothing else', () => {
        expect(parseHostUpdateRecord({ attempt: { version: '0.9.851', at: 5 }, seen: { version: '0.9.852', at: 7 } }))
            .toEqual({ attempt: { version: '0.9.851', at: 5 }, seen: { version: '0.9.852', at: 7 } });
        expect(parseHostUpdateRecord({}), 'nothing recorded yet').toEqual({ attempt: null, seen: null });
        for (const bad of [null, undefined, '', 'x', 7, { attempt: {} }, { attempt: { version: '', at: 1 } },
            { attempt: { version: '1.0.0', at: 'x' } }, { attempt: { version: 1, at: 1 } }, { seen: null }]) {
            expect(parseHostUpdateRecord(bad), JSON.stringify(bad)).toEqual({ attempt: null, seen: null });
        }
    });
});

describe('hostUpdateFailureText', () => {
    it('one bounded line, with no user profile folder in it', () => {
        const t = hostUpdateFailureText(new Error('could not run C:\\Users\\someone\\AppData\\Local\\Temp\\Puca_setup.exe\nline two'));
        expect(t).toBe('could not run %USERPROFILE%\\AppData\\Local\\Temp\\Puca_setup.exe line two');
        expect(hostUpdateFailureText('x'.repeat(500)).length).toBe(200);
    });
});
