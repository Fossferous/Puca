import { fetchIceConfig } from '../iceConfig';

// Fallback config used before backend fetch completes
const FALLBACK_STUN_SERVERS: RTCIceServer[] = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
];

// Cached ICE configuration from backend
let cachedRtcConfig: RTCConfiguration = {
    iceServers: FALLBACK_STUN_SERVERS,
    iceTransportPolicy: 'all',
    iceCandidatePoolSize: 10,
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
};

// Promise that resolves when ICE config is loaded
let iceConfigResolve: () => void;
const iceConfigReady = new Promise<void>((resolve) => {
    iceConfigResolve = resolve;
});

// Initialize ICE config from backend
async function loadIceConfig(): Promise<void> {
    try {
        const config = await fetchIceConfig();
        cachedRtcConfig = {
            iceServers: config.iceServers,
            iceTransportPolicy: config.iceTransportPolicy as RTCIceTransportPolicy,
            iceCandidatePoolSize: 10,
            bundlePolicy: 'max-bundle',
            rtcpMuxPolicy: 'require',
        };
        console.log('[WebRTC] Loaded ICE config from backend:', config.iceServers.length, 'servers');

        // Log TURN servers specifically for debugging
        const hasTurn = config.iceServers.some(s => s.urls.some((u: string) => u.startsWith('turn:')));
        console.log('[WebRTC] TURN servers available:', hasTurn);
    } catch (error) {
        console.warn('[WebRTC] Failed to load ICE config from backend, using fallback', error);
    } finally {
        iceConfigResolve(); // Always resolve so connections can proceed
    }
}

// Load ICE config on module initialization
loadIceConfig();

// Ensure config is ready before returning. Re-runs the fetch each call:
// fetchIceConfig's own 12h cache makes this free, but it upgrades the config
// once (module init happens before login, so the first snapshot has no
// self-hosted TURN credentials — a post-login refetch does).
export async function getRtcConfigAsync(): Promise<RTCConfiguration> {
    await iceConfigReady;
    await loadIceConfig();
    return cachedRtcConfig;
}
