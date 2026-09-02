/**
 * Host backend backed by the native agent.
 *
 * This is the payoff for the seam in hostBackend.ts: identity, pairing, grants,
 * authorization, signalling and UI are all unchanged between here and the
 * webview host. The only difference is who captures and who owns the peer
 * connection — which is exactly the split the interface was drawn along.
 *
 * The agent reports `unattended: true`, and that is the whole reason it exists.
 * `getDisplayMedia` requires transient user activation, so the webview host
 * cannot begin a capture after a reboot with nobody present; the agent has no
 * webview, no gesture and no picker.
 */
import { invoke } from '@tauri-apps/api/core';
import type {
    HostBackend, HostCapabilities, HostTransport, MonitorInfo, StartSessionOptions,
} from './hostBackend';
import { shellPowerAction } from './hostBackend';

/** One output as `list_monitors` describes it. */
interface AgentMonitor {
    index: number;
    left: number;
    top: number;
    width: number;
    height: number;
    primary: boolean;
}

interface AgentReply {
    ok: string;
    message?: string;
    capture?: boolean;
    unattended?: boolean;
    input?: boolean;
    elevated?: boolean;
    /** `capabilities` reports a COUNT. */
    monitors?: number | AgentMonitor[];
    count?: number;
    answer_sdp?: string;
    session_id?: string;
    fps?: number;
    bitrate_kbps?: number;
    /** `session_state`: a Windows security screen owns the display and this
     *  agent cannot follow it there. See `sessionStatus` below. */
    secure_desktop?: boolean;
    /** `session_state`: a ClipCursor region (a fullscreen game) is holding the
     *  pointer entirely off the streamed monitor, so injected clicks get
     *  clamped elsewhere. Absent on agents older than this field. */
    cursor_clipped?: boolean;
}

/**
 * Describe the host's screens for the picker.
 *
 * Prefers what the agent MEASURED. The fallback — numbering a bare count and
 * calling the first one "Main display" — is what an older agent leaves us with,
 * and it is a guess: DXGI does not promise output 0 is primary, so on a
 * three-screen desktop those labels could name a different panel from the one
 * that appeared. Resolutions are included because "Display 2" is not something
 * a person can check against, and "1440x2560" is.
 */
function describeMonitors(reply: AgentReply): MonitorInfo[] {
    const measured = Array.isArray(reply.monitors) ? reply.monitors : null;
    if (measured) {
        // Numbered by the agent's own index, not by position in this array: the
        // agent omits an output it could not describe rather than renumbering
        // the rest, so a label counted off the array would name a screen the id
        // beside it does not select.
        return measured.map((m, i) => {
            const id = m.index ?? i;
            return {
                id,
                label: `${m.primary ? 'Main display' : `Display ${id + 1}`} (${m.width}x${m.height})`,
                width: m.width ?? 0,
                height: m.height ?? 0,
                primary: m.primary ?? false,
                // Geometry rides along for the controller's zoom-follow: the
                // agent measures it from the same enumeration as `index`, so
                // the rectangle always describes the screen the id selects.
                ...(typeof m.left === 'number' && typeof m.top === 'number'
                    ? { left: m.left, top: m.top } : {}),
            };
        });
    }
    const count = reply.count ?? (typeof reply.monitors === 'number' ? reply.monitors : 0);
    return Array.from({ length: count }, (_, i) => ({
        id: i,
        label: i === 0 ? 'Main display' : `Display ${i + 1}`,
        width: 0,
        height: 0,
        primary: i === 0,
    }));
}

/** One request/response over the local pipe. Throws on an agent-side error. */
async function request(cmd: Record<string, unknown>): Promise<AgentReply> {
    const raw = await invoke<string>('agent_request', { request: JSON.stringify(cmd) });
    let reply: AgentReply;
    try {
        reply = JSON.parse(raw) as AgentReply;
    } catch {
        throw new Error(`the agent sent a malformed reply: ${raw.slice(0, 200)}`);
    }
    if (reply.ok === 'error') {
        throw new Error(reply.message ?? 'the agent refused the request');
    }
    return reply;
}

/** Is a native agent installed and reachable on this machine? */
export async function agentAvailable(): Promise<boolean> {
    try {
        return await invoke<boolean>('agent_probe');
    } catch {
        // A machine with no agent is the normal case, not an error — the
        // webview host is the fallback.
        return false;
    }
}

/**
 * WHY direct capture is or is not working, in words the user can act on.
 *
 * agentAvailable() answers yes/no, which is all the code needs and useless to a
 * person looking at a screen picker that should not be there. Older shells do
 * not have this command at all, so a rejection means "this build predates the
 * agent" rather than an error worth showing.
 */
export async function agentDiagnosis(): Promise<string | null> {
    try {
        return await invoke<string>('agent_diagnose');
    } catch {
        return null;
    }
}

/**
 * The agent's SDP answer for the session, produced when the controller's offer
 * is handed over. Kept here because `startSession` returns a transport, and the
 * SDP has to reach session.ts's signalling path separately.
 */
const answers = new Map<string, string>();

/** The answer the agent produced for `sessionId`, if it has one yet. */
export function agentAnswerFor(sessionId: string): string | null {
    return answers.get(sessionId) ?? null;
}

export function kbpsToBps(kbps?: number): number | undefined {
    return kbps !== undefined ? kbps * 1000 : undefined;
}

/** Hand the controller's offer to the agent and keep its answer. */
export async function agentAnswerOffer(
    sessionId: string,
    offerSdp: string,
    monitor: number | null,
    /** An options bag rather than a tail of positional arguments: `dataOnly` is
     *  the third optional in a row, and `(id, sdp, monitor, undefined, undefined,
     *  true)` is exactly the shape that ends up with a boolean in the bitrate
     *  slot one refactor later. */
    opts?: {
        fps?: number;
        bitrateKbps?: number;
        /** Answer and open the data channels, but never capture — how files are
         *  browsed without opening this machine's screen. */
        dataOnly?: boolean;
    },
): Promise<string> {
    const { fps, bitrateKbps, dataOnly } = opts ?? {};
    // THE AGENT CANNOT FETCH THESE ITSELF — it holds no account token and never
    // speaks to the Púca server, which is the property that makes it safe
    // to run headless. So the app has to hand them over, and until 0.8.6 it did
    // not: the webview host built its RTCPeerConnection from fetchIceConfig()
    // and the agent path was simply never told, so it offered host candidates
    // only. That worked on one LAN segment and nowhere else, and the symptom
    // was the controller waiting forever with no error on either side.
    //
    // Not fatal if it fails: a stream over host candidates still works on a
    // local network, and refusing to start would turn a degraded session into
    // no session at all. The agent reports what it actually gathered.
    let iceServers: unknown[] = [];
    try {
        const { fetchIceConfig } = await import('../iceConfig');
        iceServers = (await fetchIceConfig()).iceServers ?? [];
    } catch (err) {
        console.warn('[Devices] no ICE servers for the agent; host candidates only:', err);
    }

    const bitrate = kbpsToBps(bitrateKbps) ?? 6_000_000;
    const reply = await request({
        cmd: 'start_stream',
        session_id: sessionId,
        monitor: monitor ?? 0,
        offer_sdp: offerSdp,
        fps: fps ?? 30,
        bitrate,
        ice_servers: iceServers,
        data_only: dataOnly === true,
    });
    const answer = reply.answer_sdp;
    if (!answer) throw new Error('the agent started a stream but returned no answer');
    answers.set(sessionId, answer);
    return answer;
}

/**
 * Hand the agent one candidate the controller trickled.
 *
 * The browser sends most of its candidates AFTER the offer, and session.ts
 * routed them to `s.pc` — which is deliberately null on this transport, so they
 * were queued into `pendingIce` and applied to nothing. The agent's str0m
 * therefore had NO remote candidates and ICE could only ever reach `Checking`,
 * while the host cheerfully encoded and "sent" frames into a connection that
 * was never established. That is what the owner's agent.log showed:
 *
 *   [stream] ice state -> Checking
 *   [stream] frames sent: 180
 *
 * Never throws: a candidate that arrives before the stream exists, or one the
 * agent cannot parse (Chrome's mDNS .local names), must not take the session
 * down — the srflx and relay candidates alongside it are the ones that connect.
 */
export async function agentAddRemoteCandidate(
    sessionId: string,
    candidate: string,
): Promise<void> {
    try {
        await request({ cmd: 'add_remote_candidate', session_id: sessionId, candidate });
    } catch (err) {
        console.warn('[Devices] the agent refused an ICE candidate:', err);
    }
}

export function agentHostBackend(): HostBackend {
    return {
        kind: 'agent',

        async capabilities(): Promise<HostCapabilities> {
            const reply = await request({ cmd: 'capabilities' });
            // From the COUNT this reply carries — `describeMonitors`'s
            // no-geometry fallback, since `Response::Capabilities.monitors`
            // is a bare `usize`, not the `Vec<MonitorDesc>` `list_monitors`
            // answers with. That distinction is what makes this field SAFE to
            // read for a count-only decision (session.ts's every-screen
            // default: `caps.monitors.length > 1`) but wrong to read for
            // anything geometry-shaped — the picker and the consent prompt
            // still call `listMonitors` for the real per-screen rectangles.
            // Reusing this rather than a second blocking pipe request in the
            // connect path is deliberate: the agent's IPC is one connection
            // behind one mutex with no read timeout, so a second request there
            // queues behind whatever the agent is doing and was measured
            // costing the controller's whole 20s connect deadline on a slow
            // or wedged agent.
            const monitors = describeMonitors(reply);
            return {
                capture: reply.capture ?? false,
                unattended: reply.unattended ?? false,
                input: reply.input ?? false,
                elevated: reply.elevated ?? false,
                clipboard: false,
                files: false,
                monitors,
                limitation: reply.elevated
                    ? undefined
                    : 'This device can be controlled while it is running, but not through ' +
                      'UAC prompts or the lock screen — that needs the system service.',
            };
        },

        async startSession(opts: StartSessionOptions): Promise<HostTransport> {
            // The agent owns its own peer connection, so session.ts must NOT
            // build one. Returning 'agent-pc' is what tells it that.
            void opts;
            return { kind: 'agent-pc' };
        },

        async stopSession(sessionId: string): Promise<void> {
            answers.delete(sessionId);
            try {
                await request({ cmd: 'stop_stream', session_id: sessionId });
            } catch {
                // Already gone, or the agent died. Either way there is nothing
                // left to stop, and throwing here would block teardown.
            }
            try {
                await request({ cmd: 'release_input' });
            } catch { /* best effort */ }
        },

        async injectEvent(sessionId: string, event: string): Promise<void> {
            let parsed: unknown;
            try {
                parsed = JSON.parse(event);
            } catch {
                return; // session.ts already validated; a malformed event is dropped
            }
            // INSTRUMENTATION for the "right-clicking the tray freezes the
            // remote mouse" report. Hypothesis: the tray context menu's modal
            // message loop runs on the host's main thread, which is also what
            // dispatches every Tauri invoke — so injection stalls until the
            // menu closes. A healthy inject round trip is ~1 ms; a burst of
            // slow ones stamped across a menu-open window is the confirmation
            // this line exists to capture (in agent.log, next to the agent's
            // own lines). Remove once the mechanism is confirmed and fixed.
            const t0 = performance.now();
            await request({ cmd: 'inject', session_id: sessionId, event: parsed });
            const ms = Math.round(performance.now() - t0);
            if (ms > 250) {
                console.warn(`[inject] agent_request took ${ms}ms`);
                void invoke('agent_log', { line: `[inject-slow] agent_request round trip ${ms}ms` })
                    .catch(() => { /* diagnostics only */ });
            }
        },

        async releaseInput(): Promise<void> {
            await request({ cmd: 'release_input' });
        },

        async setMonitor(sessionId: string, monitor: number): Promise<void> {
            // The agent swaps the capture under the running encoder, so the peer
            // connection and video track survive — no renegotiation, and no
            // visible drop for the viewer beyond the picture changing.
            await request({ cmd: 'set_monitor', session_id: sessionId, monitor });
        },

        async listMonitors(): Promise<MonitorInfo[]> {
            return describeMonitors(await request({ cmd: 'list_monitors' }));
        },

        async updateStream(sessionId: string, fps?: number, bitrateKbps?: number): Promise<void> {
            const bitrate = kbpsToBps(bitrateKbps);
            await request({ cmd: 'update_stream', session_id: sessionId, fps, bitrate });
        },

        async setPrivacyMode(sessionId: string, enabled: boolean): Promise<void> {
            await request({ cmd: 'set_privacy_mode', session_id: sessionId, enabled });
        },

        /** A SHELL capability, not an agent one — see shellPowerAction. */
        powerAction: shellPowerAction,

        async displayTopologyChanged(): Promise<void> {
            // The agent rebuilds every live capture against the new output
            // enumeration and re-aims input (Request::DisplayTopologyChanged).
            await request({ cmd: 'display_topology_changed' });
        },

        /** Deliberately NOT wrapped in the error swallow requestKeyframe uses:
         *  a swallowed failure would let the host ack a change that never
         *  happened, and the controller would draw a second cursor over the
         *  host's — the exact two-pointer state this feature removes. An older
         *  agent answers "bad request" and the throw becomes an honest
         *  cursor-owner-failed. */
        async setDrawCursor(sessionId: string, enabled: boolean): Promise<void> {
            await request({ cmd: 'set_draw_cursor', session_id: sessionId, enabled });
        },

        async setFileAccess(
            sessionId: string,
            scope: import('./hostBackend').FileScopeRequest | null,
        ): Promise<void> {
            // Never both: the agent refuses a request carrying a folder AND the
            // policy flag rather than resolving the ambiguity by taking the
            // wider of the two, so do not hand it one.
            await request({
                cmd: 'set_file_access',
                session_id: sessionId,
                root: scope?.kind === 'folder' ? scope.root : null,
                policy: scope?.kind === 'policy',
            });
        },

        async getStreamQuality(sessionId: string): Promise<{ fps: number; bitrate_kbps: number }> {
            const reply = await request({ cmd: 'query_stream_quality', session_id: sessionId });
            return {
                fps: reply.fps as number,
                bitrate_kbps: reply.bitrate_kbps as number,
            };
        },

        async requestKeyframe(sessionId: string): Promise<void> {
            // The swallow is LOAD-BEARING. An agent older than this command
            // answers {"ok":"error","message":"bad request: …"}, request()
            // turns that into a throw, and an escaped rejection here would
            // reach handleSignalFrame's catch — which tears the session down.
            // A host that cannot refresh must stay indistinguishable from one
            // that silently did; the controller's stall watchdog measures the
            // only truth that matters (frames arriving again).
            try {
                await request({ cmd: 'request_keyframe', session_id: sessionId });
            } catch {
                /* pre-keyframe agent: nothing to do */
            }
        },

        /** Is a Windows security screen (a UAC prompt, the lock or sign-in
         *  screen) currently blocking this session's capture?
         *
         *  The swallow is load-bearing for the same reason as requestKeyframe's,
         *  and more so: this is POLLED. An agent older than the command answers
         *  "bad request", request() throws, and an escaped rejection once per
         *  second would be a session-killing error storm. "Could not ask" reads
         *  as false — which is exactly the behaviour every build had before this
         *  existed: the picture freezes and nothing explains it. */
        async sessionStatus(
            sessionId: string,
        ): Promise<{ secureDesktop: boolean; cursorClipped: boolean }> {
            try {
                const reply = await request({ cmd: 'session_status', session_id: sessionId });
                // `=== true`, not truthiness — a malformed reply must not be
                // able to put a "security prompt is open" banner over a working
                // session, and an OLD agent that never writes `cursor_clipped`
                // must read as "not clipped" rather than anything louder.
                return {
                    secureDesktop: reply.secure_desktop === true,
                    cursorClipped: reply.cursor_clipped === true,
                };
            } catch {
                return { secureDesktop: false, cursorClipped: false };
            }
        },
    };
}
