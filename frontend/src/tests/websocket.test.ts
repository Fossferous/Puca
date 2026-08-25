/**
 * WebSocket client — the send path's failure mode.
 *
 * This file previously asserted `typeof wsClient === 'object'`, that three
 * methods existed, and that a handler it never fired had not been called. All
 * three pass against any object and would survive `send()` being deleted, so
 * the module was effectively untested. It is now tested for the one property
 * that has actually caused data loss.
 *
 * THE HAZARD. `send()` checks `readyState === OPEN` and otherwise does nothing.
 * It does not throw, does not queue, and returns void, so a caller cannot tell
 * a delivered message from a dropped one. DMs persist ONLY through this path —
 * there is no REST fallback and nothing is replayed on reconnect (`onopen`
 * re-sends JoinRoom for tracked rooms and nothing else). So a DM composed
 * during a reconnect window was encrypted, handed to a no-op, and lost, while
 * the optimistic bubble stayed on screen with no error.
 *
 * Callers must therefore gate on `isConnected` themselves. These tests pin both
 * halves: that the drop really is silent (so the guard is necessary), and that
 * `isConnected` reports it (so the guard is sufficient).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { wsClient } from '../api/websocket';

/** Minimal stand-in for the socket, with a settable readyState. */
function fakeSocket(readyState: number) {
    return { readyState, send: vi.fn(), close: vi.fn() };
}

/** The client owns its socket privately; tests drive it directly. */
function setSocket(sock: unknown) {
    (wsClient as unknown as { ws: unknown }).ws = sock;
}

describe('wsClient.send is a silent no-op unless the socket is OPEN', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setSocket(null);
    });

    it('delivers when OPEN', () => {
        const sock = fakeSocket(WebSocket.OPEN);
        setSocket(sock);

        wsClient.send({ type: 'Ping' });

        expect(sock.send).toHaveBeenCalledTimes(1);
        expect(JSON.parse(sock.send.mock.calls[0][0] as string)).toEqual({ type: 'Ping' });
    });

    /**
     * The core of it: CONNECTING is the reconnect window a user types into, and
     * the message is dropped with no throw and no return value to inspect.
     */
    it.each([
        ['CONNECTING', WebSocket.CONNECTING],
        ['CLOSING', WebSocket.CLOSING],
        ['CLOSED', WebSocket.CLOSED],
    ])('drops the message when %s — without throwing', (_label, state) => {
        const sock = fakeSocket(state);
        setSocket(sock);

        expect(() => wsClient.send({ type: 'Ping' })).not.toThrow();
        expect(sock.send).not.toHaveBeenCalled();
    });

    it('drops the message when there is no socket at all', () => {
        setSocket(null);
        expect(() => wsClient.send({ type: 'Ping' })).not.toThrow();
    });

    /**
     * `sendDirectMessage` is the path that loses user data, so pin it directly
     * rather than trusting that it still routes through `send()`.
     */
    it('sendDirectMessage silently drops a DM while reconnecting', () => {
        const sock = fakeSocket(WebSocket.CONNECTING);
        setSocket(sock);

        expect(() => wsClient.sendDirectMessage(42, 'ciphertext')).not.toThrow();
        expect(sock.send).not.toHaveBeenCalled();
    });

    it('sendDirectMessage delivers when OPEN', () => {
        const sock = fakeSocket(WebSocket.OPEN);
        setSocket(sock);

        wsClient.sendDirectMessage(42, 'ciphertext');

        expect(sock.send).toHaveBeenCalledTimes(1);
        const sent = JSON.parse(sock.send.mock.calls[0][0] as string);
        expect(sent.payload.to_user_id).toBe(42);
        expect(sent.payload.content).toBe('ciphertext');
    });
});

describe('wsClient.isConnected is what callers must gate on', () => {
    beforeEach(() => setSocket(null));

    it('is true only for OPEN', () => {
        setSocket(fakeSocket(WebSocket.OPEN));
        expect(wsClient.isConnected).toBe(true);

        for (const state of [WebSocket.CONNECTING, WebSocket.CLOSING, WebSocket.CLOSED]) {
            setSocket(fakeSocket(state));
            expect(wsClient.isConnected).toBe(false);
        }
    });

    it('is false with no socket', () => {
        setSocket(null);
        expect(wsClient.isConnected).toBe(false);
    });

    /**
     * The guard is only trustworthy if it agrees with what send() will do.
     * If these ever diverge, a caller that checks isConnected still loses data.
     */
    it('agrees with send() in every readyState', () => {
        for (const state of [WebSocket.CONNECTING, WebSocket.OPEN, WebSocket.CLOSING, WebSocket.CLOSED]) {
            const sock = fakeSocket(state);
            setSocket(sock);
            const claimed = wsClient.isConnected;
            wsClient.send({ type: 'Ping' });
            const delivered = sock.send.mock.calls.length > 0;
            expect(claimed).toBe(delivered);
        }
    });
});
