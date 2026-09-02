import { WS_URL } from './config';
import { onPaintResumed } from './pagePainting';

// The authoritative wire-protocol definition lives in the Rust backend
// (src/ws.rs); payloads arrive as untyped JSON and are cast at use sites.

// --- Main ServerMessage Interface ---

export interface ServerMessage {
    type: string;
    payload?: Record<string, unknown>;
}

export type MessageHandler = (message: ServerMessage) => void;

/** Outcome of an announce-then-publish request (see awaitAnnouncement). */
export type AnnounceResult = { ok: true } | { ok: false; message: string };

class WebSocketClient {
    private ws: WebSocket | null = null;
    private token: string | null = null;
    private handlers: Map<string, MessageHandler[]> = new Map();
    // Rooms we're currently in. Server room membership lives in the WS session,
    // so after a reconnect we must re-join them or real-time messages/presence
    // silently stop (only the REST poll catches up).
    private joinedRooms: Set<string> = new Set();
    // Consecutive short-lived/failed connections. Grows the backoff delay
    // (capped — see attemptReconnect); reset once a connection proves stable.
    private reconnectAttempts = 0;
    // Sticky across connect() calls: have we EVER connected in this session?
    // Drives reconnect-on-close. Reset only by disconnect() (intentional teardown)
    // so a failed reconnection still schedules the next attempt.
    private everConnected = false;
    private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
    private lastPongTime = 0;
    // When the current socket opened; lets onclose judge whether the
    // connection was stable long enough to reset the backoff.
    private connectedAt = 0;
    // The single pending reconnect timer. There must never be more than one:
    // overlapping timers each call connect(), which kills the healthy socket
    // the previous timer just opened — whose onclose schedules yet another
    // timer. One seed disconnect then self-sustains a kill/reconnect chain
    // forever (connection lifetimes exactly tracking the backoff sequence).
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    constructor() {
        // Coming back to the app is the moment the user most wants the
        // connection, and it is exactly when a reconnect is likeliest to be
        // parked on a long backoff (the socket died while backgrounded, the
        // early retries burned while frozen). Fire the pending attempt NOW
        // rather than making them watch out the rest of a 30s delay. Only a
        // parked retry is touched — a healthy socket or an idle client sees
        // nothing — so this cannot seed a second reconnect chain. The attempt
        // COUNT is deliberately kept: zeroing it here made every foreground
        // restart the backoff from 1s, defeating the guard that keeps an
        // accept-then-drop server from being hammered.
        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState !== 'visible') return;
                this.healOnResume();
            });
        }
        // Belt and braces, and the half that actually survives a long lock:
        // frames restarting after a gap proves the app is back even when
        // `visibilitychange` was never delivered. Both routes converge on the
        // same idempotent heal, so a resume that fires both costs one probe.
        onPaintResumed(() => this.healOnResume());
    }

    /**
     * Coming back to the app: make the connection real again, whatever state
     * it was left in.
     *
     * This used to do nothing unless a reconnect was ALREADY scheduled
     * (`if (!this.reconnectTimer) return`), which quietly assumed a dead
     * socket always reports itself. It does not. After a long screen-lock the
     * transport dies without a close frame ever being delivered, so `onclose`
     * never fires, no retry is ever scheduled, and `readyState` sits at OPEN
     * over a socket that will never carry another byte. Resuming then healed
     * nothing and the only recovery was force-quitting the app — which is
     * exactly what was reported.
     *
     * Three cases, all handled here:
     *  - a retry is parked on a long backoff  -> fire it now rather than making
     *    the user watch out the rest of a 30s delay;
     *  - no socket, or one that is not OPEN   -> start a reconnect;
     *  - a socket that CLAIMS to be open      -> probe it immediately instead
     *    of waiting up to 30s for the next heartbeat tick, and back-date the
     *    pong evidence so a zombie is closed on that tick rather than two.
     */
    private healOnResume(): void {
        if (!this.token || !this.everConnected) return;

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
            this.attemptReconnect(true);
            return;
        }

        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            this.attemptReconnect(true);
            return;
        }

        // Same arithmetic as the heartbeat's suspended-timer branch: give the
        // probe a full interval to be answered, but no more, so a socket that
        // is open in name only is closed on the next tick and the ordinary
        // reconnect path takes over.
        this.lastPongTime = Date.now() - 16_000;
        this.lastHeartbeatTick = Date.now();
        this.send({ type: 'Ping' });
    }

    connect(token: string): Promise<void> {
        // A deliberate connect supersedes any pending reconnect.
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        // Close any existing connection first — with its handlers DETACHED. A
        // replaced socket firing onclose must not schedule a reconnect; that
        // was the second head of the self-sustaining chain above. Its onclose
        // side effect (wsClosed → remote-control teardown) is preserved by
        // dispatching manually: the relay is gone either way and no held key
        // may be stranded.
        if (this.ws) {
            this.ws.onopen = null;
            this.ws.onmessage = null;
            this.ws.onerror = null;
            this.ws.onclose = null;
            this.ws.close();
            this.ws = null;
            if (typeof window !== 'undefined') {
                window.dispatchEvent(new CustomEvent('wsClosed'));
            }
        }

        this.token = token;
        // Per-socket: did THIS socket reach onopen? Decides whether the
        // connect() promise rejects (initial attempt) vs. is swallowed (retry).
        let opened = false;

        return new Promise((resolve, reject) => {
            // The token rides Sec-WebSocket-Protocol, NOT the query string.
            //
            // A query string is written verbatim into the access log of every
            // proxy and web server on the path — the Caddy in front of this one
            // included — so `?token=<jwt>` deposited a live session credential
            // into log files that rotate, ship off-box and get backed up, by
            // software with no idea it was handling one. Browsers cannot set an
            // Authorization header on a WebSocket (the constructor takes only a
            // URL and a subprotocol list); the subprotocol header is the
            // standard way round that, and nothing on this path logs it.
            //
            // Two values by convention: the marker, then the credential. The
            // server echoes back only "bearer" — it must echo something or the
            // browser fails the connection, and echoing the token would put it
            // in a response header and undo the point.
            //
            // The backend accepts both forms and ships BEFORE this, so a client
            // can never meet a server that understands neither.
            const socket = new WebSocket(WS_URL, ['bearer', token]);
            this.ws = socket;

            socket.onopen = () => {
                console.log('WebSocket connected');
                opened = true;
                this.everConnected = true; // Sticky: enables reconnect-on-close
                this.connectedAt = Date.now();
                this.lastPongTime = Date.now();
                this.startHeartbeat();
                // Re-establish room memberships lost with the previous socket.
                if (this.joinedRooms.size > 0) {
                    console.log(`[WS] Re-joining ${this.joinedRooms.size} room(s) after (re)connect`);
                    for (const room of this.joinedRooms) {
                        this.send({ type: 'JoinRoom', payload: { room_id: room } });
                    }
                }
                // Event-driven presence lost during a socket gap is gone for
                // good — listeners (Chat) refetch the voice-occupancy snapshot
                // on every (re)connect so a fresh/mobile device shows who's
                // actually in voice right now.
                if (typeof window !== 'undefined') {
                    window.dispatchEvent(new CustomEvent('wsConnected'));
                }
                resolve();
            };

            socket.onmessage = (event) => {
                try {
                    const message: ServerMessage = JSON.parse(event.data);
                    // ANY delivered frame proves the connection is alive, not
                    // just Pong: the server's Pong rides a bounded per-conn
                    // queue (try_send, drop-on-full), so under event bursts a
                    // busy-but-healthy socket could miss 45s of Pongs and get
                    // force-closed MID-CALL by the staleness watchdog — whose
                    // reconnect then armed the permanent-SFU-audio-loss chain.
                    this.lastPongTime = Date.now();
                    if (message.type === 'Pong') {
                        return; // Don't dispatch to handlers
                    }
                    this.handleMessage(message);
                } catch (e) {
                    console.error('Failed to parse WS message:', e);
                }
            };

            socket.onclose = (event) => {
                // Stale-socket safety net: if this socket was replaced (its
                // handlers should be detached, but belt-and-braces), it must
                // not touch shared state or schedule reconnects.
                if (this.ws !== socket) {
                    return;
                }
                // Code + reason distinguish a server/proxy-initiated close (real
                // Close frame) from an abnormal drop (1006: process died, TCP
                // cut) — essential when diagnosing reconnect loops in the field.
                console.log(`WebSocket closed (code=${event.code}${event.reason ? `, reason=${event.reason}` : ''}, clean=${event.wasClean})`);
                this.stopHeartbeat();
                // Reset the backoff only when the connection proved STABLE.
                // Resetting on every open turned an accept-then-drop server
                // (deploy window, crash loop) into an infinite full-speed
                // reconnect loop that logged "reconnect 1/5" forever.
                if (opened && Date.now() - this.connectedAt >= 10_000) {
                    this.reconnectAttempts = 0;
                }
                // Let remote-control end any live session + release held input:
                // no relay means no more input, and we must not strand a key down.
                if (typeof window !== 'undefined') {
                    window.dispatchEvent(new CustomEvent('wsClosed'));
                }
                // Reconnect only if we ever established a connection (prevents an
                // infinite loop on initial connection failure) and weren't
                // intentionally disconnected (disconnect() clears the token).
                // Uses the sticky everConnected — NOT the per-socket `opened`,
                // which would kill the retry chain after one failed attempt.
                if (this.everConnected && this.token) {
                    this.attemptReconnect();
                }
            };

            socket.onerror = (error) => {
                console.error('WebSocket error:', error);
                // Only reject if this is the initial connection
                if (!opened) {
                    reject(error);
                }
            };
        });
    }

    private attemptReconnect(immediate = false) {
        if (!this.token) {
            return; // Intentional disconnect — stay down.
        }
        // A visibly-expired JWT will never reconnect — every attempt is doomed
        // (this loop used to park at 30s backoff hammering a dead token
        // forever, with no signal to the user). Surface expiry instead; the
        // App tears the session down and shows the login screen. Deferred
        // import avoids an api/auth <-> api/websocket cycle at module init.
        import('./auth').then(({ getToken, isTokenExpired }) => {
            // Adopt the freshest STORED token before judging expiry. `this.token`
            // is whatever this socket was opened with, and a sliding-session
            // renewal may have replaced it hours ago — the live socket is never
            // re-opened just because a renewal landed. Judging the stale copy
            // declared a still-valid session dead at exactly the 24h mark and
            // then had softExpireSession DELETE the good renewed token, which
            // defeated the whole point of renewing.
            const current = getToken() ?? this.token;
            if (!current) return;
            this.token = current;
            if (isTokenExpired(current)) {
                this.token = null;
                import('./client').then(({ signalAuthExpired }) => signalAuthExpired());
            }
        }).catch(() => { /* keep normal reconnect on any import hiccup */ });
        if (this.reconnectTimer) {
            return; // A reconnect is already scheduled — never run two chains.
        }
        // Never give up permanently: a hard attempt cap stranded clients
        // offline forever when a deploy window outlasted the backoff (five
        // sub-10s connections burned the whole budget in ~30s). Instead the
        // delay grows exponentially and parks at 30s until the server returns.
        this.reconnectAttempts++;
        // `immediate` (the foreground kick) collapses only THIS delay; the
        // counter above still advanced, so a failing server sees the backoff
        // resume where it left off on the attempt after this one.
        const delay = immediate
            ? 1000
            : Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 30_000);
        console.log(`Attempting reconnect ${this.reconnectAttempts} in ${delay}ms`);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            // Reconnect with the FRESHEST token, not the one captured when this
            // socket was first opened: a sliding-session renewal may have
            // replaced it since, and reconnecting with the superseded token
            // would fail once the old one expires. Deferred import avoids the
            // api/auth <-> api/websocket cycle at module init.
            import('./auth').then(({ getToken }) => {
                const token = getToken() ?? this.token;
                if (!token) return;
                this.token = token;
                // everConnected stays true across this connect(), so if the socket
                // fails to open again, onclose will schedule the next attempt.
                this.connect(token).catch(console.error);
            }).catch(() => {
                if (this.token) this.connect(this.token).catch(console.error);
            });
        }, delay);
    }

    private handleMessage(message: ServerMessage) {
        // A server-forced eviction (voice exclusivity: this user joined voice
        // from another device) must also leave the reconnect list. Otherwise a
        // socket gap later re-sends JoinRoom for the OLD voice room in onopen,
        // which evicts the newer device — "steal-back" inverting newest-wins.
        if (message.type === 'RoomLeft') {
            const roomId = (message.payload as { room_id?: string } | undefined)?.room_id;
            if (roomId) this.joinedRooms.delete(roomId);
        }
        // A moderator move carries NO RoomLeft (that would race the client's own
        // channel switch — see ws::SelfNotice), so the room it took us out of
        // has to be dropped from the rejoin list here or the exact same
        // steal-back applies: a later socket gap re-sends JoinRoom for the room
        // we were moved OUT of, which evicts us from the one we were moved to.
        if (message.type === 'VoiceMoved') {
            const from = (message.payload as { from_channel_id?: number } | undefined)?.from_channel_id;
            if (typeof from === 'number') this.joinedRooms.delete(`voice_${from}`);
        }
        const handlers = this.handlers.get(message.type) || [];
        handlers.forEach(handler => handler(message));
    }

    /** When the heartbeat last actually ticked. The watchdog below compares
     *  wall-clock time, and a phone that backgrounds the app FREEZES timers:
     *  on resume the first tick used to see a 45s+ pong gap and close a
     *  perfectly healthy socket — so returning to the app was what killed the
     *  connection. A tick that arrives far later than its 30s interval proves
     *  the timers were suspended, not that the server went quiet. */
    private lastHeartbeatTick = 0;

    private startHeartbeat() {
        this.stopHeartbeat(); // Clear any existing
        this.lastHeartbeatTick = Date.now();
        // Send ping every 30 seconds
        this.heartbeatInterval = setInterval(() => {
            const now = Date.now();
            const sinceLastTick = now - this.lastHeartbeatTick;
            this.lastHeartbeatTick = now;
            if (this.ws?.readyState === WebSocket.OPEN) {
                // A tick that is very late means the JS timers were frozen (the
                // app was backgrounded) — the pong gap measures OUR suspension,
                // not the server's health. Probe with a fresh ping and judge on
                // the NEXT tick. The back-dating arithmetic is what makes that
                // true: the next tick is 30s out and the staleness bar is 45s,
                // so evidence set to `now` would take TWO more ticks to go
                // stale — a zombie socket (OPEN, transport dead: the usual
                // outcome of a mobile network change) would survive 60s. Set
                // to now-16s, the probe's pong has 30s to arrive and a silent
                // socket is closed on the very next tick.
                if (sinceLastTick > 40_000) {
                    console.log('[WS] Timers were suspended; probing the socket instead of closing it.');
                    this.lastPongTime = now - 16_000;
                    this.send({ type: 'Ping' });
                    return;
                }
                // Check if we've received a pong recently (within 45 seconds)
                const timeSinceLastPong = now - this.lastPongTime;
                if (timeSinceLastPong > 45000) {
                    console.warn('[WS] No pong received in 45s, connection may be stale. Forcing reconnect.');
                    this.ws?.close();
                    return;
                }
                // Send ping
                this.send({ type: 'Ping' });
            }
        }, 30000);
    }

    private stopHeartbeat() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    }

    on(type: string, handler: MessageHandler) {
        if (!this.handlers.has(type)) this.handlers.set(type, []);
        this.handlers.get(type)!.push(handler);
    }

    off(type: string, handler: MessageHandler) {
        const handlers = this.handlers.get(type);
        if (handlers) {
            const idx = handlers.indexOf(handler);
            if (idx !== -1) handlers.splice(idx, 1);
        }
    }

    /**
     * Send if the socket is open. Returns whether the frame was actually
     * handed to the socket — `false` means it was DROPPED, not queued.
     *
     * The return value exists because "fire and forget" was a real defect for
     * the one frame a person sends deliberately and then waits three minutes
     * on: a Wake pressed on a backgrounded/reconnecting Android socket was
     * silently discarded here, reported upstream as "relayed", and the card
     * counted down 180 s for a request that never left the phone. Most
     * callers still ignore this — chat and presence are retried by other
     * means — but a caller that promises the user something must check.
     */
    send(message: object): boolean {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(message));
            return true;
        }
        return false;
    }

    /** Bytes sitting in the socket's send buffer, unsent (0 when closed).
     *  The input paths use this as backpressure: motion queued behind a
     *  stalled uplink is not "in flight", it is a backlog that will replay
     *  late, and the right treatment for stale motion is the bin. */
    bufferedAmount(): number {
        return this.ws?.bufferedAmount ?? 0;
    }

    joinRoom(roomId: string) {
        this.joinedRooms.add(roomId);
        this.send({ type: 'JoinRoom', payload: { room_id: roomId } });
    }

    leaveRoom(roomId: string) {
        this.joinedRooms.delete(roomId);
        this.send({ type: 'LeaveRoom', payload: { room_id: roomId } });
    }

    sendChatMessage(roomId: string, content: string) {
        this.send({ type: 'ChatMessage', payload: { room_id: roomId, content } });
    }

    // WebRTC Signaling Methods
    sendOffer(targetUser: number, sdp: string) {
        this.send({ type: 'Offer', payload: { target_user: targetUser, sdp } });
    }

    sendAnswer(targetUser: number, sdp: string) {
        this.send({ type: 'Answer', payload: { target_user: targetUser, sdp } });
    }

    sendIceCandidate(targetUser: number, candidate: string) {
        this.send({ type: 'IceCandidate', payload: { target_user: targetUser, candidate } });
    }

    startStream(roomId: string) {
        this.send({ type: 'StartStream', payload: { room_id: roomId } });
    }

    stopStream(roomId: string) {
        this.send({ type: 'StopStream', payload: { room_id: roomId } });
    }

    sendDirectMessage(toUserId: number, content: string) {
        this.send({ type: 'DirectMessage', payload: { to_user_id: toUserId, content } });
    }

    startScreenShare(roomId: string, streamId?: string) {
        // stream_id lets mesh peers classify the arriving video by IDENTITY
        // instead of by elimination (see rtc/manager.ts classifyRemoteVideo).
        // Optional: an old server ignores the extra field, and peers then
        // keep the old heuristic.
        return this.send({ type: 'ScreenShareStart', payload: { room_id: roomId, stream_id: streamId ?? null } });
    }

    stopScreenShare(roomId: string) {
        this.send({ type: 'ScreenShareStop', payload: { room_id: roomId } });
    }

    startCamera(roomId: string) {
        return this.send({ type: 'CameraStart', payload: { room_id: roomId } });
    }

    /**
     * Announce-then-publish (B7). The server enforces the VIDEO / STREAM role
     * bits on the ANNOUNCEMENT and broadcasts an accepted one to every member,
     * sender included — that echo is the ack, and only then does the caller
     * put a track on the wire. An Error frame while we wait is the refusal
     * (the server's own wording, shown to the user). Silence counts as a
     * refusal too: publishing on a guess is exactly what this replaces.
     */
    private awaitAnnouncement(
        type: 'ScreenShareStarted' | 'CameraStarted',
        roomId: string,
        me: number,
        fire: () => boolean,
        timeoutMs = 8000,
    ): Promise<AnnounceResult> {
        return new Promise((resolve) => {
            let timer: ReturnType<typeof setTimeout> | null = null;
            const finish = (r: AnnounceResult) => {
                if (timer !== null) clearTimeout(timer);
                this.off(type, onAck);
                this.off('Error', onErr);
                resolve(r);
            };
            const onAck = (msg: ServerMessage) => {
                const p = msg.payload as { room_id?: string; streamer?: { id: number }; user?: { id: number } } | undefined;
                const who = p?.streamer?.id ?? p?.user?.id;
                if (p?.room_id === roomId && who === me) finish({ ok: true });
            };
            const onErr = (msg: ServerMessage) => {
                const text = (msg.payload as { message?: string } | undefined)?.message ?? 'The server refused that.';
                finish({ ok: false, message: text });
            };
            this.on(type, onAck);
            this.on('Error', onErr);
            if (!fire()) {
                finish({ ok: false, message: 'Not connected to the server — try again in a moment.' });
                return;
            }
            timer = setTimeout(() => finish({ ok: false, message: 'No answer from the server — try again.' }), timeoutMs);
        });
    }

    /** Announce a screen share and resolve once the server has accepted it. */
    startScreenShareAcked(roomId: string, streamId: string | undefined, me: number): Promise<AnnounceResult> {
        return this.awaitAnnouncement('ScreenShareStarted', roomId, me, () => this.startScreenShare(roomId, streamId));
    }

    /** Announce the camera and resolve once the server has accepted it. */
    startCameraAcked(roomId: string, me: number): Promise<AnnounceResult> {
        return this.awaitAnnouncement('CameraStarted', roomId, me, () => this.startCamera(roomId));
    }

    stopCamera(roomId: string) {
        this.send({ type: 'CameraStop', payload: { room_id: roomId } });
    }

    sendTyping(roomId: string) {
        this.send({ type: 'Typing', payload: { room_id: roomId } });
    }

    /**
     * Drop the socket so the normal reconnect path brings a fresh one up.
     *
     * NOT disconnect(): that clears the token, which is how this class tells an
     * intentional teardown from a dropped connection, so the socket would stay
     * down. Closing without clearing it reconnects — which is the point, because
     * a fresh connection is the only way to get a new DeviceChallenge, and
     * therefore the only way to attest a device id that changed mid-connection.
     */
    forceReconnect() {
        this.ws?.close();
    }

    disconnect() {
        this.token = null;
        this.everConnected = false; // Intentional teardown: stop reconnecting
        this.reconnectAttempts = 0;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.ws) {
            // Detach before closing — see connect(): a torn-down socket's
            // onclose must never schedule a reconnect.
            this.ws.onopen = null;
            this.ws.onmessage = null;
            this.ws.onerror = null;
            this.ws.onclose = null;
            this.ws.close();
            this.ws = null;
            if (typeof window !== 'undefined') {
                // DELIBERATE: sign-out and session expiry come through here.
                // Device sessions grace an accidental drop for a reconnect,
                // but a deliberate close must end them NOW — nothing is
                // coming back, and a host would otherwise keep capturing for
                // the whole grace window after its person logged out.
                window.dispatchEvent(new CustomEvent('wsClosed', { detail: { deliberate: true } }));
            }
        }
    }

    get isConnected(): boolean {
        return this.ws?.readyState === WebSocket.OPEN;
    }
}

export const wsClient = new WebSocketClient();
