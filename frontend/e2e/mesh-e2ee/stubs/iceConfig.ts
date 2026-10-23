// Stand-in for api/iceConfig: host candidates only (both pages are on this machine).
export async function fetchIceConfig(): Promise<{ iceServers: RTCIceServer[]; iceTransportPolicy: RTCIceTransportPolicy }> {
    return { iceServers: [], iceTransportPolicy: 'all' };
}
export function withRelayOnlyIfRequested(c: RTCConfiguration): RTCConfiguration {
    return c;
}
