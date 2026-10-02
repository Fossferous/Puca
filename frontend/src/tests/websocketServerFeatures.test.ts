/**
 * The presence capability handshake, client side.
 *
 * WHY A HANDSHAKE AT ALL. An older server answers any ClientMessage variant it
 * does not know with an `Error` frame ("unknown variant ..."), and the chat
 * view turns every Error frame into a blocking alert() — a native modal in the
 * desktop app. Reproduced against a 0.9.830 backend during triage. So the new
 * `SetActivity` frame may only ever be sent to a server that has SAID it
 * understands it, on THIS socket: a reconnect can land on an older rollback
 * host, so the answer is latched per socket and forgotten when it closes.
 *
 * The client announces itself in the URL (`presence` in the one
 * `?caps=own_voice,presence` list, CLIENT_CAPS): a query parameter an older
 * server's WsQuery simply ignores, so announcing costs nothing there.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { wsClient } from '../api/websocket';

type Sock = { url: string; onmessage: ((e: { data: string }) => void) | null; onopen: (() => void) | null };
const sock = () => (wsClient as unknown as { ws: Sock | null }).ws!;
const deliver = (frame: object) => sock().onmessage!({ data: JSON.stringify(frame) });

beforeEach(() => {
    wsClient.disconnect();
});

describe('the presence capability is announced and latched per socket', () => {
    it('the socket URL announces caps=presence', async () => {
        await wsClient.connect('tok');
        const url = new URL(sock().url, 'http://x');
        expect(url.pathname.endsWith('/ws')).toBe(true);
        expect(url.searchParams.get('caps')?.split(',')).toContain('presence');
        expect(url.searchParams.getAll('caps')).toHaveLength(1);
        // The token never rides the URL (it is in the subprotocol).
        expect(sock().url).not.toContain('tok');
    });

    it('no feature until the server says so; ServerFeatures latches it', async () => {
        await wsClient.connect('tok');
        expect(wsClient.hasServerFeature('presence')).toBe(false);
        deliver({ type: 'ServerFeatures', payload: { features: ['presence', 'something-newer'] } });
        expect(wsClient.hasServerFeature('presence')).toBe(true);
        // A feature the server did not list is still absent.
        expect(wsClient.hasServerFeature('games')).toBe(false);
    });

    it('a new socket forgets the previous socket\'s features (a reconnect may reach an older host)', async () => {
        await wsClient.connect('tok');
        deliver({ type: 'ServerFeatures', payload: { features: ['presence'] } });
        expect(wsClient.hasServerFeature('presence')).toBe(true);
        await wsClient.connect('tok'); // replaces the socket
        expect(wsClient.hasServerFeature('presence')).toBe(false);
    });

    it('a malformed ServerFeatures grants nothing', async () => {
        await wsClient.connect('tok');
        deliver({ type: 'ServerFeatures', payload: { features: 'presence' } });
        expect(wsClient.hasServerFeature('presence')).toBe(false);
        deliver({ type: 'ServerFeatures' });
        expect(wsClient.hasServerFeature('presence')).toBe(false);
    });
});
