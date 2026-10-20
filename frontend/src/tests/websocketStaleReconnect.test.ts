/**
 * A socket the heartbeat finds dead is REPLACED, even if its close never
 * completes.
 *
 * After a phone changes network the old TCP connection is gone without a
 * close frame. The heartbeat notices (no pong in 45 s) and calls close(),
 * but that only starts the closing handshake: onclose can wait as long as
 * the browser takes to give up. The reconnect used to be scheduled ONLY from
 * onclose, so for that whole time the socket sat CLOSING, isConnected was
 * false, and every remote-control tap failed "not connected to the server".
 *
 * The fake socket here never fires onclose on close(), which is that case.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../api/auth', () => ({
    getToken: () => 'tok',
    isTokenExpired: () => false,
}));

class DeadEndSocket {
    static instances: DeadEndSocket[] = [];
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readyState = DeadEndSocket.CONNECTING;
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onclose: ((e: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    sent: string[] = [];
    constructor() { DeadEndSocket.instances.push(this); }
    send(data: string) { this.sent.push(data); }
    /** The transport is dead: closing starts and never finishes. */
    close() { this.readyState = DeadEndSocket.CLOSING; }
    open() { this.readyState = DeadEndSocket.OPEN; this.onopen?.(); }
}

beforeEach(() => {
    DeadEndSocket.instances = [];
    vi.stubGlobal('WebSocket', DeadEndSocket);
    vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

async function waitFor(cond: () => boolean, what: string) {
    for (let i = 0; i < 200; i++) {
        if (cond()) return;
        await vi.advanceTimersByTimeAsync(50);
    }
    throw new Error(`timed out waiting for: ${what}`);
}

describe('the heartbeat replaces a socket whose close never completes', () => {
    it('opens a new socket without waiting for onclose', async () => {
        vi.resetModules();
        const { wsClient } = await import('../api/websocket');
        const connected = wsClient.connect('tok');
        const first = DeadEndSocket.instances[0];
        first.open();
        await connected;
        expect(wsClient.isConnected).toBe(true);

        // Two heartbeat ticks with no pong: the second finds it stale.
        await vi.advanceTimersByTimeAsync(30_000);
        expect(DeadEndSocket.instances).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(first.readyState, 'the heartbeat closed it').toBe(DeadEndSocket.CLOSING);
        expect(wsClient.isConnected).toBe(false);

        await waitFor(() => DeadEndSocket.instances.length === 2, 'a replacement socket');
        expect(first.onclose, 'the dead socket is detached, so a late onclose changes nothing').toBeNull();

        DeadEndSocket.instances[1].open();
        expect(wsClient.isConnected).toBe(true);
        wsClient.disconnect();
    });

    it('control: a socket answering its pings is kept', async () => {
        vi.resetModules();
        const { wsClient } = await import('../api/websocket');
        const connected = wsClient.connect('tok');
        const first = DeadEndSocket.instances[0];
        first.open();
        await connected;
        for (let i = 0; i < 4; i++) {
            await vi.advanceTimersByTimeAsync(30_000);
            first.onmessage?.({ data: JSON.stringify({ type: 'Pong' }) });
        }
        expect(DeadEndSocket.instances).toHaveLength(1);
        expect(first.readyState).toBe(DeadEndSocket.OPEN);
        wsClient.disconnect();
    });
});
