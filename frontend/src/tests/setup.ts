/**
 * Vitest Test Setup
 * 
 * This file runs before each test file.
 */

import '@testing-library/jest-dom';
import { vi } from 'vitest';

// React 19 requires this flag before act() will run without warnings in jsdom.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Mock localStorage
const localStorageMock = {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
    clear: vi.fn(),
};
Object.defineProperty(window, 'localStorage', { value: localStorageMock });

// Mock WebSocket
class MockWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    readyState = MockWebSocket.CONNECTING;
    url: string;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: ((error: Event) => void) | null = null;

    constructor(url: string) {
        this.url = url;
        setTimeout(() => {
            this.readyState = MockWebSocket.OPEN;
            this.onopen?.();
        }, 0);
    }

    send(_data: string) {
        // Can be spied on in tests
    }

    close() {
        this.readyState = MockWebSocket.CLOSED;
        this.onclose?.();
    }
}
Object.defineProperty(window, 'WebSocket', { value: MockWebSocket });

// Mock RTCPeerConnection
class MockRTCPeerConnection {
    localDescription: RTCSessionDescription | null = null;
    remoteDescription: RTCSessionDescription | null = null;
    onicecandidate: ((event: { candidate: RTCIceCandidate | null }) => void) | null = null;
    ontrack: ((event: RTCTrackEvent) => void) | null = null;
    onconnectionstatechange: (() => void) | null = null;

    async createOffer() {
        return { type: 'offer', sdp: 'mock-sdp' };
    }

    async createAnswer() {
        return { type: 'answer', sdp: 'mock-sdp' };
    }

    async setLocalDescription(desc: RTCSessionDescription) {
        this.localDescription = desc;
    }

    async setRemoteDescription(desc: RTCSessionDescription) {
        this.remoteDescription = desc;
    }

    addIceCandidate(_candidate: RTCIceCandidate) {
        return Promise.resolve();
    }

    addTrack(_track: MediaStreamTrack, _stream: MediaStream) {
        return { track: _track };
    }

    close() { }
}
Object.defineProperty(window, 'RTCPeerConnection', { value: MockRTCPeerConnection, configurable: true, writable: true });

// Mock MediaStream
class MockMediaStream {
    id = 'mock-stream-id';
    tracks: MediaStreamTrack[] = [];

    getTracks() { return this.tracks; }
    getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio'); }
    getVideoTracks() { return this.tracks.filter(t => t.kind === 'video'); }
    addTrack(track: MediaStreamTrack) { this.tracks.push(track); }
    removeTrack(track: MediaStreamTrack) {
        const idx = this.tracks.indexOf(track);
        if (idx > -1) this.tracks.splice(idx, 1);
    }
}
Object.defineProperty(window, 'MediaStream', { value: MockMediaStream });

// Mock navigator.mediaDevices
Object.defineProperty(navigator, 'mediaDevices', {
    value: {
        getUserMedia: vi.fn().mockResolvedValue(new MockMediaStream()),
        getDisplayMedia: vi.fn().mockResolvedValue(new MockMediaStream()),
        enumerateDevices: vi.fn().mockResolvedValue([]),
    },
});

// Mock AudioContext
class MockAudioContext {
    state = 'running';
    sampleRate = 48000;

    createMediaStreamSource(_stream: MediaStream) {
        return { connect: vi.fn(), disconnect: vi.fn() };
    }

    createMediaStreamDestination() {
        return { stream: new MockMediaStream() };
    }

    createBiquadFilter() {
        return { connect: vi.fn(), disconnect: vi.fn(), frequency: { value: 0 }, Q: { value: 0 }, type: 'lowpass' };
    }

    createDynamicsCompressor() {
        return {
            connect: vi.fn(),
            disconnect: vi.fn(),
            threshold: { value: 0 },
            knee: { value: 0 },
            ratio: { value: 0 },
            attack: { value: 0 },
            release: { value: 0 },
        };
    }

    close() { this.state = 'closed'; }
}
// configurable/writable so an individual test can vi.stubGlobal a richer fake
// (this base mock has no buffer-source/decode surface). Without it stubGlobal
// throws "Cannot redefine property".
Object.defineProperty(window, 'AudioContext', {
    value: MockAudioContext,
    configurable: true,
    writable: true,
});
