/**
 * Reconnect catch-up: after a socket gap, reconnecting while hidden must
 * notify for what arrived during the gap — and ONLY that. The backend has no
 * queue or replay, so before this module every gap was silent loss; the tests
 * drive the real window events (wsClosed/wsConnected) against the real module
 * instance, exactly as production wires it.
 *
 * The module is a singleton with rolling baselines, so these tests use ONE
 * import (like the app does) and reset its state the way production does:
 * a successful visible reconnect rebases every baseline.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

interface Conv {
    id: string;
    other_user_id: number;
    other_username: string;
    other_display_name: string | null;
    last_message: string | null;
    last_message_at: string | null;
    created_at: string;
}

const h = vi.hoisted(() => ({
    hidden: false,
    servers: [] as Array<{
        server_id: string; unread_count: number;
        channels?: Array<{ channel_id: number; unread_count: number }>;
    }>,
    convs: [] as Array<{
        id: string; other_user_id: number; other_username: string;
        other_display_name: string | null; last_message: string | null;
        last_message_at: string | null; created_at: string;
    }>,
    tails: new Map<string, { sender_id: number }>(),
    /** When set, getDMMessages parks on this promise — lets a test interleave
     *  a live frame into the middle of a catch-up run. */
    tailGate: null as Promise<void> | null,
    quiet: new Set<string>(),
    mutedChannels: new Set<number>(),
    blocked: new Set<number>(),
    railSnapshot: new Map<string, number>() as Map<string, number> | null,
    railChannelSnapshot: null as Map<number, number> | null,
    notifies: [] as Array<Record<string, unknown>>,
    wsHandlers: new Map<string, (msg: { type: string; payload?: unknown }) => void>(),
}));

vi.mock('../api/platform', () => ({ isAndroidApp: () => true }));
vi.mock('../api/servers', () => ({
    getAllUnreadCounts: async () => ({ servers: h.servers }),
}));
vi.mock('../api/dms', () => ({
    listDMConversations: async () => h.convs,
    getDMMessages: async (id: string) => {
        if (h.tailGate) await h.tailGate;
        const tail = h.tails.get(id);
        return tail ? [tail] : [];
    },
}));
vi.mock('../api/auth', () => ({
    getToken: () => 'token',
    decodeJwtPayload: () => ({ sub: 7 }),
}));
vi.mock('../api/desktopNotify', () => ({
    notifyNewMessage: (opts: Record<string, unknown>) => {
        h.notifies.push(opts);
        return { fire: true };
    },
}));
vi.mock('../api/websocket', () => ({
    wsClient: {
        on: (type: string, handler: (msg: { type: string; payload?: unknown }) => void) => {
            h.wsHandlers.set(type, handler);
        },
    },
}));
vi.mock('../components/unreadStore', () => ({
    snapshotServerUnread: () => (h.railSnapshot === null ? null : new Map(h.railSnapshot)),
    snapshotChannelUnread: () => (h.railChannelSnapshot === null ? null : new Map(h.railChannelSnapshot)),
}));
vi.mock('../components/mutedServersStore', () => ({
    isServerQuiet: (id: string) => h.quiet.has(id),
}));
vi.mock('../components/mutedChannelsStore', () => ({
    isChannelMuted: (id: number) => h.mutedChannels.has(id),
}));
vi.mock('../components/blockStore', () => ({
    isBlocked: (id: number) => h.blocked.has(id),
}));

function conv(id: string, at: string | null, name = 'Sam'): Conv {
    return {
        id, other_user_id: 42, other_username: name, other_display_name: null,
        last_message: null, last_message_at: at, created_at: '2026-08-01T00:00:00Z',
    };
}

async function settle(): Promise<void> {
    for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0));
}

async function fire(name: 'wsClosed' | 'wsConnected'): Promise<void> {
    window.dispatchEvent(new Event(name));
    await settle();
}

beforeAll(async () => {
    Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => (h.hidden ? 'hidden' : 'visible'),
    });
    const m = await import('../api/reconnectCatchup');
    m.installReconnectCatchup();
});

beforeEach(async () => {
    h.hidden = false;
    h.servers = [];
    h.convs = [conv('c1', '2026-08-11T10:00:00Z')];
    h.tails.clear();
    h.tailGate = null;
    h.quiet.clear();
    h.mutedChannels.clear();
    h.blocked.clear();
    h.railSnapshot = new Map();
    h.railChannelSnapshot = null;
    // Production reset: a deliberate close (= logout) drops every baseline —
    // necessary because tests move fictional time BACKWARDS between cases,
    // and the module's merge-newer discipline (correct in production, where
    // server time only advances) would otherwise carry a previous test's
    // future into this one. Then a visible reconnect rebases from scratch.
    window.dispatchEvent(new CustomEvent('wsClosed', { detail: { deliberate: true } }));
    await settle();
    await fire('wsConnected');
    h.notifies.length = 0;
});

describe('server catch-up', () => {
    it('a gap in which a server grew notifies with the live path key', async () => {
        h.railSnapshot = new Map([['s1', 2]]);
        await fire('wsClosed');
        h.servers = [{ server_id: 's1', unread_count: 5 }];
        h.hidden = true;
        await fire('wsConnected');
        expect(h.notifies).toEqual([
            expect.objectContaining({ notifyKey: 'chan:s1', nav: 'server:s1' }),
        ]);
    });

    it('reconnecting VISIBLE posts nothing for the same growth', async () => {
        h.railSnapshot = new Map([['s1', 2]]);
        await fire('wsClosed');
        h.servers = [{ server_id: 's1', unread_count: 5 }];
        h.hidden = false;
        await fire('wsConnected');
        expect(h.notifies, 'the user is looking at the in-app unread state').toEqual([]);
    });

    it('no growth means no notification (the twin above proves the rig fires)', async () => {
        h.railSnapshot = new Map([['s1', 5]]);
        await fire('wsClosed');
        h.servers = [{ server_id: 's1', unread_count: 5 }];
        h.hidden = true;
        await fire('wsConnected');
        expect(h.notifies).toEqual([]);
    });

    it('a quiet server never pings; the same growth unquieted does', async () => {
        h.railSnapshot = new Map();
        h.quiet.add('s1');
        await fire('wsClosed');
        h.servers = [{ server_id: 's1', unread_count: 3 }];
        h.hidden = true;
        await fire('wsConnected');
        expect(h.notifies, 'muted stays silent').toEqual([]);

        h.quiet.delete('s1');
        await fire('wsClosed');
        await fire('wsConnected');
        expect(h.notifies, 'POSITIVE CONTROL: unmuted, the same state fires').toEqual([
            expect.objectContaining({ notifyKey: 'chan:s1' }),
        ]);
    });

    it('a connect with NO preceding gap posts nothing, whatever is unread', async () => {
        h.servers = [{ server_id: 's1', unread_count: 9 }];
        h.hidden = true;
        await fire('wsConnected');
        expect(h.notifies, 'standing unread is not a gap diff').toEqual([]);
    });
});

describe('DM catch-up', () => {
    it("a DM that arrived during the gap pings with the sender's name", async () => {
        await fire('wsClosed');
        h.convs = [conv('c1', '2026-08-11T10:05:00Z')];
        h.tails.set('c1', { sender_id: 42 });
        h.hidden = true;
        await fire('wsConnected');
        expect(h.notifies).toEqual([
            expect.objectContaining({
                title: 'Sam sent you a message',
                notifyKey: 'dm:c1',
                nav: 'dm:c1',
            }),
        ]);
    });

    it('your OWN message sent from another device does not ping your phone', async () => {
        await fire('wsClosed');
        h.convs = [conv('c1', '2026-08-11T10:05:00Z')];
        h.tails.set('c1', { sender_id: 7 });   // = the mocked JWT sub
        h.hidden = true;
        await fire('wsConnected');
        expect(h.notifies).toEqual([]);
    });

    it('a blocked sender cannot use the catch-up as a way around the block', async () => {
        h.blocked.add(42);
        await fire('wsClosed');
        h.convs = [conv('c1', '2026-08-11T10:05:00Z')];
        h.tails.set('c1', { sender_id: 42 });
        h.hidden = true;
        await fire('wsConnected');
        expect(h.notifies).toEqual([]);
    });

    it('a live DirectMessage frame advances the baseline, so the gap does not re-announce it', async () => {
        // The message lands WHILE CONNECTED (frame seen), then the socket dies.
        const handler = h.wsHandlers.get('DirectMessage');
        expect(handler, 'the module subscribes to DirectMessage').toBeTruthy();
        const t2 = Date.parse('2026-08-11T10:05:00Z');
        handler!({ type: 'DirectMessage', payload: { conversation_id: 'c1', timestamp: t2 / 1000 } });
        await fire('wsClosed');
        h.convs = [conv('c1', '2026-08-11T10:05:00Z')];
        h.tails.set('c1', { sender_id: 42 });
        h.hidden = true;
        await fire('wsConnected');
        expect(h.notifies, 'already seen through the live path').toEqual([]);
    });

    it('a live DM frame during the catch-up awaits is not rolled back and re-announced', async () => {
        // Gap 1: c1 advanced during the gap, and getDMMessages is parked so a
        // LIVE frame lands between the conversations fetch and the baseline
        // write — the exact window where an unmerged assignment would roll
        // the baseline back past a message the live path already delivered.
        await fire('wsClosed');
        h.convs = [conv('c1', '2026-08-11T10:05:00Z')];
        h.tails.set('c1', { sender_id: 42 });
        h.hidden = true;
        let release!: () => void;
        h.tailGate = new Promise<void>(r => { release = r; });
        window.dispatchEvent(new Event('wsConnected'));
        await settle();   // runCatchup is parked on the gated tail lookup

        const t3 = Date.parse('2026-08-11T10:07:00Z');
        h.wsHandlers.get('DirectMessage')!({
            type: 'DirectMessage',
            payload: { conversation_id: 'c1', timestamp: t3 / 1000 },
        });
        release();
        await settle();
        h.notifies.length = 0;   // gap 1's own catch-up ping is expected

        // Gap 2: nothing newer than the live frame.
        await fire('wsClosed');
        h.convs = [conv('c1', new Date(t3).toISOString())];
        await fire('wsConnected');
        expect(h.notifies, 'the live-path message must not be announced twice').toEqual([]);
    });

    it('overflow beyond the lookup cap collapses into one summary', async () => {
        await fire('wsClosed');
        h.convs = [
            conv('c1', '2026-08-11T10:05:00Z', 'A'),
            conv('c2', '2026-08-11T10:06:00Z', 'B'),
            conv('c3', '2026-08-11T10:07:00Z', 'C'),
            conv('c4', '2026-08-11T10:08:00Z', 'D'),
        ];
        for (const id of ['c1', 'c2', 'c3', 'c4']) h.tails.set(id, { sender_id: 42 });
        h.hidden = true;
        await fire('wsConnected');
        const keys = h.notifies.map(n => n.notifyKey);
        // Distinct from the server summary key — the two summaries must
        // stack, not silently replace each other.
        expect(keys).toContain('catchup:dms');
        expect(keys.filter(k => String(k).startsWith('dm:')).length).toBe(3);
    });
});

describe('gap lifecycle', () => {
    it('a deliberate close (logout) drops every baseline instead of freezing a gap', async () => {
        // Account A's world is on the baselines. A logs out; B signs in on
        // the same running app with standing unread and days-old DMs.
        h.railSnapshot = new Map();   // A's rail had nothing unread
        window.dispatchEvent(new CustomEvent('wsClosed', { detail: { deliberate: true } }));
        await settle();

        h.servers = [{ server_id: 'b1', unread_count: 7 }];
        h.convs = [conv('bconv', '2026-08-01T09:00:00Z', 'Bea')];
        h.tails.set('bconv', { sender_id: 42 });
        h.hidden = true;
        await fire('wsConnected');
        expect(
            h.notifies,
            "B's standing unread is not a gap — announcing it would ping days-old, read messages",
        ).toEqual([]);
    });

    it('POSITIVE CONTROL: the same state after a NETWORK close does notify', async () => {
        h.railSnapshot = new Map();
        await fire('wsClosed');       // no detail.deliberate — a real drop
        h.servers = [{ server_id: 'b1', unread_count: 7 }];
        h.convs = [conv('c1', '2026-08-11T10:05:00Z')];
        h.tails.set('c1', { sender_id: 42 });
        h.hidden = true;
        await fire('wsConnected');
        expect(h.notifies.length, 'the rig CAN see the storm the reset prevents').toBeGreaterThan(0);
    });

    it('a mid-gap retry close cannot re-freeze the baseline', async () => {
        h.railSnapshot = new Map([['s1', 2]]);
        await fire('wsClosed');                    // gap opens, baseline = 2
        h.railSnapshot = new Map([['s1', 6]]);     // a 60s REST poll lands mid-gap
        await fire('wsClosed');                    // a failed reconnect attempt
        h.servers = [{ server_id: 's1', unread_count: 6 }];
        h.hidden = true;
        await fire('wsConnected');
        expect(h.notifies, 'diffed against the FIRST close, not the re-poll').toEqual([
            expect.objectContaining({ notifyKey: 'chan:s1' }),
        ]);
    });

    it('a never-hydrated rail is ignorance, not an all-zero baseline', async () => {
        // Boot -> socket dies before the first unread hydrate completes. An
        // empty-map baseline would classify ALL standing unread as growth.
        h.railSnapshot = null;
        await fire('wsClosed');
        h.servers = [{ server_id: 's1', unread_count: 9 }];
        h.hidden = true;
        await fire('wsConnected');
        expect(h.notifies).toEqual([]);
    });
});

describe('channel-granular catch-up (0.8.58 backend)', () => {
    it('growth confined to a muted channel stays silent; the live path parity case fires', async () => {
        h.railSnapshot = new Map([['s1', 2]]);
        h.railChannelSnapshot = new Map([[10, 2]]);
        h.mutedChannels.add(10);
        await fire('wsClosed');
        h.servers = [{ server_id: 's1', unread_count: 5, channels: [{ channel_id: 10, unread_count: 5 }] }];
        h.hidden = true;
        await fire('wsConnected');
        expect(h.notifies, 'a muted channel must not find another way to speak').toEqual([]);

        // POSITIVE CONTROL: identical growth in an unmuted channel pings.
        h.railChannelSnapshot = new Map([[10, 2]]);
        await fire('wsClosed');
        h.mutedChannels.clear();
        await fire('wsConnected');
        expect(h.notifies).toEqual([
            expect.objectContaining({ notifyKey: 'chan:s1' }),
        ]);
    });

    it('falls back to server totals when the backend sends no channel rows', async () => {
        h.railSnapshot = new Map([['s1', 2]]);
        h.railChannelSnapshot = new Map([[10, 2]]);   // baseline exists...
        h.mutedChannels.add(10);
        await fire('wsClosed');
        // ...but this backend (pre-0.8.58) sends totals only: the muted
        // channel cannot be distinguished, so the total-growth ping fires —
        // the pre-channel-rows behaviour, not silence.
        h.servers = [{ server_id: 's1', unread_count: 5 }];
        h.hidden = true;
        await fire('wsConnected');
        expect(h.notifies).toEqual([
            expect.objectContaining({ notifyKey: 'chan:s1' }),
        ]);
    });
});
