// Stand-in for api/websocket: signalling goes through the test runner, which
// relays each frame to the other page as the server would (and may rewrite
// it on the way, as a server could).
type Msg = { type: string; payload: unknown };
type Handler = (msg: Msg) => void;
const handlers = new Map<string, Set<Handler>>();
const relay = (to: number, type: string, data: string) =>
    (window as unknown as { __relay: (to: number, type: string, data: string) => Promise<void> }).__relay(to, type, data);

export const wsClient = {
    on(type: string, h: Handler) {
        if (!handlers.has(type)) handlers.set(type, new Set());
        handlers.get(type)!.add(h);
    },
    off(type: string, h: Handler) { handlers.get(type)?.delete(h); },
    sendOffer(to: number, sdp: string) { void relay(to, 'Offer', sdp); },
    sendAnswer(to: number, sdp: string) { void relay(to, 'Answer', sdp); },
    sendIceCandidate(to: number, candidate: string) { void relay(to, 'IceCandidate', candidate); },
};

(window as unknown as Record<string, unknown>).__deliver = (type: string, payload: unknown) => {
    handlers.get(type)?.forEach((h) => h({ type, payload }));
};
