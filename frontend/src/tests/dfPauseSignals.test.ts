/**
 * The signals dfPause.ts listens to, at their sources. The pause decision is
 * only as good as the events that re-run it: a mic gate, a peer connection
 * or an SFU participant that changes WITHOUT telling anyone leaves DeepFilter
 * paused while somebody can hear (the dangerous direction). So:
 *  - WebRTCManager.setAudioEnabled announces every gate change (mute, PTT,
 *    PTM, deafen, AFK all go through it);
 *  - the mesh peers map announces every peer added or removed, whichever
 *    path adds or removes it (callUser, closePeer, closeAll);
 *  - SfuManager announces participants connecting and leaving, and the room
 *    connecting, reconnecting and dropping.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../api/iceConfig', () => ({
    withRelayOnlyIfRequested: (c: unknown) => c,
    fetchIceConfig: vi.fn(async () => ({ iceServers: [], iceTransportPolicy: 'all' })),
}));

import { WebRTCManager } from '../api/rtc/manager';
import { SfuManager } from '../api/rtc/sfuManager';
import { RoomEvent, ConnectionState } from 'livekit-client';

class FakePc {
    onicecandidate: unknown = null;
    onnegotiationneeded: unknown = null;
    ontrack: unknown = null;
    onconnectionstatechange: unknown = null;
    connectionState = 'new';
    getSenders() { return []; }
    close() { /* no-op */ }
}

beforeEach(() => { vi.stubGlobal('RTCPeerConnection', FakePc); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('WebRTCManager: the mic gate', () => {
    it('announces every setAudioEnabled, with the new state, and the track carries it', () => {
        const mgr = new WebRTCManager();
        const track = { enabled: true };
        mgr.media.getLocalStreamSync = () => ({ getAudioTracks: () => [track] }) as unknown as MediaStream;
        const heard: boolean[] = [];
        const off = mgr.onMicGateChange((open) => heard.push(open));
        mgr.setAudioEnabled(false);
        expect(track.enabled).toBe(false);
        mgr.setAudioEnabled(true);
        mgr.setAudioEnabled(true);
        expect(heard).toEqual([false, true, true]);
        off();
        mgr.setAudioEnabled(false);
        expect(heard).toEqual([false, true, true]);
    });

    it('a listener that throws does not stop the gate or the other listeners', () => {
        const mgr = new WebRTCManager();
        const track = { enabled: true };
        mgr.media.getLocalStreamSync = () => ({ getAudioTracks: () => [track] }) as unknown as MediaStream;
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => { });
        const heard: boolean[] = [];
        mgr.onMicGateChange(() => { throw new Error('boom'); });
        mgr.onMicGateChange((open) => heard.push(open));
        mgr.setAudioEnabled(false);
        expect(track.enabled).toBe(false);
        expect(heard).toEqual([false]);
        warn.mockRestore();
    });
});

describe('WebRTCManager: mesh peers', () => {
    it('announces a peer appearing (callUser) and going (closePeer), and lists them', async () => {
        const mgr = new WebRTCManager();
        mgr.setLocalUserId(1);
        let n = 0;
        mgr.onPeersChanged(() => n++);
        await mgr.callUser(2);
        expect(mgr.peerUserIds()).toEqual([2]);
        expect(n).toBe(1);
        await mgr.callUser(2); // the same peer again: no membership change
        expect(n).toBe(1);
        await mgr.callUser(3);
        expect(n).toBe(2);
        mgr.closePeer(2);
        expect(mgr.peerUserIds()).toEqual([3]);
        expect(n).toBe(3);
        mgr.closePeer(2); // already gone: nothing changed
        expect(n).toBe(3);
    });

    it('announces closeAll once, and not at all when there was nobody', async () => {
        const mgr = new WebRTCManager();
        mgr.setLocalUserId(1);
        await mgr.callUser(2);
        await mgr.callUser(3);
        let n = 0;
        const off = mgr.onPeersChanged(() => n++);
        mgr.closeAll();
        expect(n).toBe(1);
        expect(mgr.peerUserIds()).toEqual([]);
        mgr.closeAll();
        expect(n).toBe(1);
        off();
    });
});

describe('SfuManager: participants', () => {
    /** A room whose `on` really registers, so the events can be fired. */
    function managerWithRoom() {
        const handlers = new Map<string, Array<(...a: unknown[]) => void>>();
        const room = {
            state: ConnectionState.Connected,
            remoteParticipants: new Map<string, { identity: string; trackPublications: Map<string, unknown> }>(),
            localParticipant: { on() { return this; }, identity: 'u1#me' },
            on(ev: string, fn: (...a: unknown[]) => void) {
                handlers.set(ev, [...(handlers.get(ev) ?? []), fn]);
                return room;
            },
            removeAllListeners() { handlers.clear(); return room; },
            async disconnect() { /* fake */ },
        };
        const m = new SfuManager();
        (m as unknown as { wireRoomEvents(r: unknown): void }).wireRoomEvents(room);
        (m as unknown as { room: unknown }).room = room;
        const fire = (ev: string, ...args: unknown[]) => (handlers.get(ev) ?? []).forEach(fn => fn(...args));
        return { m, room, fire };
    }

    it('announces a participant connecting and leaving, and the room changing state', () => {
        const { m, room, fire } = managerWithRoom();
        let n = 0;
        m.onParticipantsChanged(() => n++);
        room.remoteParticipants.set('u2#a', { identity: 'u2#a', trackPublications: new Map() });
        fire(RoomEvent.ParticipantConnected, room.remoteParticipants.get('u2#a'));
        expect(n).toBe(1);
        expect(m.participantUserIds()).toEqual([2]);
        room.remoteParticipants.delete('u2#a');
        fire(RoomEvent.ParticipantDisconnected, { identity: 'u2#a' });
        expect(n).toBe(2);
        fire(RoomEvent.ConnectionStateChanged, ConnectionState.Reconnecting);
        expect(n).toBe(3);
    });

    it('announces the room going away on disconnect', async () => {
        const { m } = managerWithRoom();
        let n = 0;
        m.onParticipantsChanged(() => n++);
        await m.disconnect();
        expect(n).toBe(1);
        expect(m.connected).toBe(false);
        await m.disconnect(); // no room: nothing to announce
        expect(n).toBe(1);
    });
});
