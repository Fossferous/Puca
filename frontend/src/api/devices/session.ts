/**
 * One device-control session: handshake, transport, sealed input.
 *
 * This owns its OWN RTCPeerConnection rather than extending rtc/manager.ts.
 * That manager is 1300+ lines of room / voice / SFU / requireMediaE2ee shape,
 * and routing device sessions through it would re-couple this feature to voice
 * rooms — which is precisely what Phase 2 built a separate path to escape.
 * Modelled instead on fileTransferManager, which owns a per-transfer pc for the
 * same reason.
 *
 * Two properties hold throughout:
 *
 *  - FAIL CLOSED. No session key means no input, in both directions. There is
 *    no plaintext fallback anywhere in this file, because the fallback is what
 *    an attacker would aim for.
 *  - The HOST is the authoritative gate. The server relays; it never decides
 *    whether a session may exist. What makes that true is establishKey: the
 *    peer's static key comes from peerKeys.ts, which returns a key only for a
 *    device record whose enrolment signature verified under the account signing
 *    key this client derived from the password. A server cannot forge such a
 *    record, so it cannot introduce a device — and since 0.8.1 every signalling
 *    frame is sealed under that key too, so it cannot sit in the middle of one
 *    either.
 *
 * NOT true, despite what this comment claimed until 0.8.1: "a host checks the
 * grant itself before accepting". The grant chain in grants.ts
 * (buildGrantRecord / grantAuthorises / grantControl) has NO production caller —
 * only nine tests, all passing, all proving a function nothing invokes. What
 * actually authorises a session is the enrolment check above, which is why the
 * absence was not exploitable by a stranger; what is genuinely missing is the
 * per-pair, time-bounded, host-revocable capability the grant was meant to add.
 * Wiring it needs a UI for issuing grants, so it is a feature, not a fix — but
 * until it exists, ANY device enrolled to the account can control any other, and
 * device revocation is enforced by the SERVER rather than cryptographically.
 */
import { fetchIceConfig, withRelayOnlyIfRequested } from '../iceConfig';
import { wsClient } from '../websocket';
import { setControlKeepAlive } from '../mobileApp';
import { minimiseJitterBuffer } from '../rtc/receiverLatency';
import { MediaLiveness, INPUT_RECENT_MS } from './mediaLiveness';
import { debounce } from 'lodash-es';
import {
    deriveDeviceControlKey,
    generateControlEphemeral,
    openControl,
    sealControl,
    type ControlEphemeral,
} from '../e2ee';
import { deviceKeyDh } from './deviceKeyRc';
import { buildClipboardEvent, isClipboardEvent, readLocalClipboardDetailed, writeLocalClipboard, MAX_CLIPBOARD_BYTES } from './clipboard';
import { getHostBackend } from './hostBackend';
import { attachTunnelChannel, closeTunnels } from './tunnel';
import { SerialQueue } from './serialQueue';
import { InputCoalescer } from './inputCoalescer';
import { issueUaChallenge, unattendedState, verifyUaResponse } from './unattendedHost';
import {
    confirmUaSeed,
    deriveUaSeed,
    forgetUaSeed,
    rememberUaSeed,
    rememberedUaSeed,
    signUaChallengeSeed,
} from './unattended';
import { requestUnattendedPassphrase } from './unattendedPrompt';
import {
    armControlGuard,
    noteControlActivity,
    releaseControlGuard,
    DEVICE_CONTROL_IDLE_MS,
} from './controlGuard';
import { appIsBackgrounded } from '../pagePainting';

/** How long a controller has to answer the unattended challenge before the
 *  session is torn down. Generous, because a human is typing a passphrase on a
 *  phone — but finite, because silence must not be a way in.
 *
 *  MUST stay comfortably below puca-ua's DEFAULT_TTL_MS, or the two
 *  disagree and the loser is the honest user: this was 120s against a 60s nonce
 *  TTL, so anyone who took 61-120s to type the CORRECT passphrase got
 *  UaError::Expired, which verifyUaResponse flattens to false, which tears the
 *  session down saying the passphrase was rejected. The TTL is now 180s so this
 *  deadline fits inside it with room for relay latency. */
const UA_RESPONSE_DEADLINE_MS = 120_000;

/** How long a controller waits for the server to answer DeviceConnect. The
 *  failure this bounds is SILENT: a DeviceConnect swallowed by a closed
 *  socket, dropped by a rate limiter, or answered with a generic error none
 *  of the device handlers see left the session in 'connecting' forever — a
 *  zombie that wore the stage and, server-side, held the one-session-per-host
 *  slot against every retry until the app was force-killed. */
const CONNECT_DEADLINE_MS = 20_000;

/** How long a live session may sit in pc connectionState 'disconnected'
 *  before it is ended honestly. 'disconnected' self-heals after a routing
 *  blip, and browsers can take minutes to escalate it to 'failed' — minutes
 *  the user spends staring at a frozen frame with input going nowhere, over a
 *  session whose corpse then refuses the next connect. Long enough for a
 *  Wi-Fi handoff; short enough that "it froze" has an ending. */
const PC_DISCONNECT_GRACE_MS = 15_000;

/** How long a CONTROLLER waits for the first video frame before giving up and
 *  saying why.
 *
 *  "Waiting for the device's screen…" with no end and no explanation is the
 *  single worst failure this feature has produced, and it has now had three
 *  separate causes: an unanswered screen picker, a host holding the offer for an
 *  unattended passphrase, and a peer on a version whose signalling this build
 *  drops. The symptom was identical every time and pointed at none of them.
 *
 *  So the controller now stops waiting and names the likeliest cause. Long
 *  enough to cover a slow TURN relay and a cold capture; short enough that
 *  nobody sits staring at it. */
const MEDIA_DEADLINE_MS = 30_000;

/** How long a session survives OUR OWN socket dropping before it is ended.
 *
 *  Phones drop their socket the moment the app backgrounds, and ending every
 *  session on the first `wsClosed` made a brief app switch fatal. The
 *  WebSocket layer reconnects by itself; this window is what it gets to come
 *  back and DeviceReattach. MUST match the server's
 *  DEVICE_SESSION_DETACH_GRACE_SECS (ws.rs) — the server is holding the same
 *  session for the same reason, and whichever end gives up first decides. */
const TRANSPORT_GRACE_MS = 60_000;

/** Longest peer-supplied end reason this side will keep.
 *
 *  These strings arrive through the relay and are now DISPLAYED, so their
 *  length is chosen by something this side does not trust. A reason is a
 *  sentence; a megabyte of text is a way to paint over the app. */
const MAX_REASON_LEN = 200;

/**
 * The end-reason that means "somebody signed in here", not "something broke".
 *
 * ONE WIRE CONTRACT, TWO COMPILED HALVES. The other half is `HANDOVER_REASON`
 * in `crates/puca-service/src/link.rs`, which sends it when the console
 * is unlocked and its sign-in-screen agent stands down. Nothing but a test on
 * each side couples these literals, and a mismatch does not error anywhere —
 * it silently restores the freeze this exists to remove.
 */
export const HANDOVER_REASON = 'console-unlocked-handover';

/**
 * The end-reason that means "the controller asked me to LOCK, and I did" —
 * the mirror of `HANDOVER_REASON`. Sent by the ATTENDED host (this file, the
 * `power` arm) after LockWorkStation: a user-token agent cannot capture the
 * secure desktop, so the picture moves to the machine's sign-in-screen row
 * (the SYSTEM service) and the controller follows it there instead of being
 * left with a frozen session. Only this file spells it (both halves are TS),
 * pinned by a test all the same.
 */
export const LOCK_HANDOVER_REASON = 'console-locked-handover';

/** The end-reason the host sends BEFORE shutting down on request. */
export const SHUTDOWN_REASON = 'the device is shutting down';

/** Events per second over a rolling window, for the diagnostics. */
class RateCounter {
    private times: number[] = [];
    tick(): void {
        const now = Date.now();
        this.times.push(now);
        if (this.times.length > 512) this.times.splice(0, this.times.length - 512);
        while (this.times.length && now - this.times[0] > 1000) this.times.shift();
    }
    rate(): number {
        const now = Date.now();
        return this.times.filter(t => now - t <= 1000).length;
    }
}

/** The monitor index meaning "every display stitched into one surface".
 *
 *  A sentinel, not an index. The agent names it too
 *  (`crates/puca-agent/src/composite.rs`), and its comment says the point
 *  of naming it is that the two paths cannot disagree about what 255 means —
 *  so the frontend, which had it as a bare literal in the mobile menu, gets a
 *  name as well. */
export const ALL_DISPLAYS = 255;
import { currentUserId } from './index';
import { thisDeviceId } from '../thisDevice';

export type SessionRole = 'controller' | 'host';
export type SessionPhase = 'connecting' | 'active' | 'ended';

export interface DeviceControlSession {
    id: string;
    role: SessionRole;
    /** The OTHER device. */
    peerDevice: string;
    phase: SessionPhase;
    /** Set once the peer's media arrives (controller side). */
    stream: MediaStream | null;
    /** Host's capture size, so pointer mapping matches what was captured
     *  rather than what WebRTC happened to downscale to. */
    captureSize: { w: number; h: number } | null;
    error: string | null;
    /** CONTROLLER: the host's screens, sent once the session is up so the viewer
     *  can switch without reconnecting. Empty until it arrives, and on a host
     *  that cannot enumerate them. The desktop-space rect is present when the
     *  host could measure it (agent hosts) — it is what lets zoom-follow tell
     *  which screen of the All-Displays composite the viewport is over. */
    monitors: { id: number; label: string; left?: number; top?: number; width?: number; height?: number }[];
    /** CONTROLLER: which screen the host CONFIRMED is showing. Not what was
     *  asked for, because that might be refused, and a viewer must not be left
     *  lying about what it is watching. */
    activeMonitor: number | null;
    /** CONTROLLER: the host is ARMED and this session went through the
     *  unattended challenge — nobody at that machine was asked anything, so
     *  its starting screen is a default and not a person's choice. What lets
     *  the stage ask an older host for every screen without ever overriding a
     *  screen someone sitting there picked in the consent prompt. */
    unattended: boolean;
    /** The WebRTC data channel for file transfers (if connected). */
    filesChannel: RTCDataChannel | null;
    /** The single folder the host allowed to be browsed, or null for "not
     *  allowed" — which is the state every session starts and ends in. The
     *  file UI is unavailable until this is set. */
    fileRoot: string | null;
    /** How file access was granted, or null for "not allowed".
     *
     *  Separate from `fileRoot` because the unattended grant has NO single
     *  folder: it is the whole machine minus the system and secret-bearing
     *  paths, so there is no path to show and nothing for `fileRoot` to hold.
     *  The file UI gates on THIS rather than on `fileRoot`, or a policy grant
     *  would look identical to no grant at all. */
    fileScopeKind: 'folder' | 'policy' | null;
    /** This session exists to browse files, not to watch a screen.
     *
     *  Set on the controller when it opens the session and carried to the host
     *  in the offer, because the host is the side that has to NOT capture. The
     *  transport is otherwise identical — same offer, same data channels, same
     *  recvonly video m-line — so nothing about the negotiation changes.
     *
     *  Public rather than internal because the UI splits on it: DeviceStage
     *  ignores these sessions (there is no picture to show) and the standalone
     *  file browser claims them. It also suppresses the media deadline, whose
     *  whole job is to complain that no video arrived — here that is the point. */
    filesOnly: boolean;
    /** CONTROLLER: whether the host reports its screen blanked. Driven by the
     *  host's ack, never set optimistically — a toggle that lies about this is
     *  worse than one that is slow. */
    privacyActive: boolean;
    /** CONTROLLER: the host has confirmed it STOPPED drawing its own pointer,
     *  so this end owns the cursor and must draw one.
     *
     *  Driven exclusively by the host's ack — never optimistically. The whole
     *  point is that exactly one cursor is on screen: setting this true before
     *  the host has actually stopped puts two on, and an old host that ignores
     *  the request never acks, which correctly leaves this false forever. */
    cursorOwned: boolean;
    /** The relay is interrupted — OUR socket dropped and is reconnecting, or
     *  the server says the PEER's did. The session is being held, not ended:
     *  the UI should say "reconnecting", keep the last picture, and stop
     *  treating taps as deliverable. Cleared when the reattach completes;
     *  a grace timer ends the session if it never does. */
    reconnecting: boolean;
    /** CONTROLLER: connected, but no video frame has arrived yet — the
     *  "Waiting for the device's screen…" state. `stream` cannot carry this
     *  meaning: it is attached eagerly at connect (Safari refuses to start
     *  the pipeline otherwise), so on Chromium the old `!stream` overlay
     *  condition never fired and a host with sleeping screens was a silent
     *  black stage. Cleared by the first RTP (track unmute). */
    awaitingMedia: boolean;
    /** CONTROLLER: the media path was judged dead (the liveness ladder's
     *  probes went unanswered, or the host reported its stream died) and a
     *  fresh transport is being negotiated under the SAME session. The stage
     *  should say "Reconnecting the stream…" — the session, keys, grants and
     *  passphrase proof all survive; only the picture's transport is being
     *  rebuilt. Cleared by the restarted stream's first RTP. */
    mediaRestarting: boolean;
    /** The OTHER ACCOUNT on a cross-user session (a device share), or null
     *  for the ordinary same-account case. Host side: the friend driving.
     *  Controller side: the friend whose machine this is. The username is
     *  server-stamped, never client-supplied — the UI renders it in consent
     *  prompts and the live "connected" banner. */
    shareUser: { id: number; username: string } | null;
    /** A view-only share: the screen may be watched but no input may flow.
     *  The UI hides input affordances; BOTH the host client and the server
     *  relay enforce it regardless. Always false for same-account sessions. */
    viewOnly: boolean;
    /** A Windows security screen — a UAC prompt, the lock screen or the
     *  sign-in screen — currently owns the host's display, and the host's agent
     *  cannot follow it there.
     *
     *  HOST: polled from the agent (`sessionStatus`). CONTROLLER: driven by the
     *  host's `secure-desktop` notice, never guessed locally — the controller
     *  cannot tell a security prompt from any other reason frames stopped.
     *
     *  Why it is worth carrying at all: without it the picture simply freezes
     *  and nothing on screen explains why, which is indistinguishable from a
     *  crash. Approving such a prompt remotely needs SYSTEM (see
     *  `docs/REMOTE_CONTROL.md`), so the honest answer is to say what is
     *  happening rather than to appear broken. It also PINS the liveness ladder:
     *  no frames arrive while a secure desktop is up, and restarting the media
     *  transport cannot fix that. */
    secureDesktop: boolean;
    /** A ClipCursor region on the host — a fullscreen game, typically — is
     *  holding the pointer entirely off the streamed monitor, so injected
     *  clicks get clamped somewhere the viewer cannot see, with no error from
     *  the injection itself. Same trust rule as `secureDesktop`: HOST polled
     *  from the agent, CONTROLLER only ever told by the host's
     *  `cursor-clipped` notice, never guessed. Absent machinery (webview host,
     *  old agent) leaves it false — the pre-feature behaviour. */
    cursorClipped: boolean;
    /** CONTROLLER: transient display-power outcome line ("Turned off 2 of
     *  3; ...", the no-response timeout, a DDC refusal). Auto-clears; never
     *  a session error. */
    powerNotice: string | null;
}

interface Internal extends DeviceControlSession {
    /** Cross-user session state (a device share), or null for same-account.
     *  Set only after the ENTIRE verification chain passed on this side —
     *  pinned account signing key, verified device record, and (host side)
     *  the host's own grant signature over exactly these capabilities — so
     *  `share !== null` MEANS verified, and every capability gate reads it. */
    share: {
        inviteId: number;
        peerUser: number;
        peerUsername: string;
        capabilities: string[];
    } | null;
    /** HOST side: this machine is armed for unattended access. For a share
     *  session the GRANT stands in for the passphrase (a friend never holds
     *  the owner's unattended secret), so armed + verified share = no prompt;
     *  unarmed keeps the live consent prompt exactly like same-account. */
    hostArmed: boolean;
    /** HOST side: the agent has a live stream for this session, so remote
     *  candidates can be handed to it directly instead of queued.
     *
     *  Says HOST because only `agentAnswerOffer` sets it, and that runs on the
     *  answering side. It was documented as CONTROLLER state and then used as
     *  a controller-side readiness test, which is a condition no session can
     *  satisfy — the reconnect quality re-query behind it never once ran. */
    agentStreamStarted: boolean;
    /** CONTROLLER side: did we query quality on reconnect yet? */
    agentStreamQualityQueried: boolean;
    /** HOST side: the person at this machine withdrew file access for this
     *  session, so it must not be granted again.
     *
     *  Without this the tray's "Stop file access" is decorative: the grant is
     *  withdrawn, the peer sends another file-access-request, and an armed host
     *  hands it straight back with no prompt — because the gate only asks whether
     *  the passphrase was proved, which it still was. A revoke has to outlive the
     *  request that follows it.
     *
     *  Scoped to the SESSION, which is the scope file access already had ("access
     *  ends when the session does"). Reconnecting is a new session and can be
     *  granted again — and on a machine armed for unattended access that is not a
     *  hole, because the same peer can already drive the desktop by injecting
     *  input. What this stops is the withdrawal being undone behind the back of
     *  the person who just made it. */
    fileAccessRevoked: boolean;
    /** HOST side: a file-access-request arrived before the passphrase was proved,
     *  so it is held to be replayed once it is.
     *
     *  Exactly the same reasoning as `pendingOffer`: a file-only session asks for
     *  access the moment it goes active, which on an armed host is before the
     *  challenge has been answered. Dropping it left the controller having asked
     *  and never answered, with no way to know it should ask again. */
    pendingFileRequest: boolean;
    /** HOST side: the controller has proved the unattended passphrase. */
    uaVerified: boolean;
    /** HOST side: this machine is armed, so a challenge WAS issued and must be
     *  answered before anything is injected.
     *
     *  Both flags are needed. `uaVerified` alone cannot gate anything, because
     *  an unarmed host never sets it either — so a check on `!uaVerified` would
     *  break every ordinary session. The pair says "proof was demanded AND
     *  proof arrived", which is the actual condition. */
    uaRequired: boolean;
    /** HOST side: an offer that arrived before the passphrase was proved.
     *
     *  Held rather than dropped, so proving the passphrase resumes the session
     *  instead of requiring the controller to renegotiate — the controller has
     *  no way to know it must. */
    pendingOffer: string | null;
    /** CONTROLLER: fires if no video arrives. Cleared by the first track, and
     *  paused while the user is being asked for the unattended passphrase. */
    mediaTimer: ReturnType<typeof setTimeout> | null;
    /** CONTROLLER: the passphrase dialog is open, so the media deadline must
     *  stay down however it is reached.
     *
     *  A FLAG RATHER THAN A CLEAR, because clearing only works if the timer has
     *  already been armed. Now that a challenge held back before the key exists
     *  is replayed the moment the key lands, it can be processed BEFORE
     *  `DeviceConnectAnswered` finishes arming that timer — so the clear ran
     *  against nothing, the timer was armed a moment later, and the session died
     *  after 30 seconds while the user was still typing. */
    awaitingUaPassphrase: boolean;
    /** CONTROLLER: the lifecycle of the remembered unattended seed this
     *  session signed with. 'used' = signed, verdict unknown; 'confirmed' =
     *  the host answered something only a verified controller receives.
     *  Teardown FORGETS a still-'used' seed — the one observable a rejection
     *  produces is the teardown itself, so keeping the seed then would replay
     *  the same refusal promptless forever. */
    uaCache: 'used' | 'confirmed' | null;
    /** HOST: this machine cannot capture at all (a phone). Stashed at accept
     *  time because the offer handler needs it later without re-probing: a
     *  screen request against such a host is torn down naming the limitation,
     *  and the screen-consent dialog is skipped — there is no screen to
     *  consent to, and the FileAccessPrompt is the consent moment. */
    hostCaptureless: boolean;
    /** OUR socket dropped and the reconnect has not reattached yet. Drives the
     *  local grace timer below; `reconnecting` (public) is the OR of this and
     *  `peerReconnecting`, maintained wherever either changes. */
    transportDown: boolean;
    /** The server said the PEER's socket dropped and may come back. No local
     *  timer for this one — the server's own detach grace decides, and its
     *  verdict arrives as DevicePeerReconnected or DeviceEnded. */
    peerReconnecting: boolean;
    /** Ends the session if our transport never comes back. */
    transportGraceTimer: ReturnType<typeof setTimeout> | null;
    /** HOST: what the controller was last successfully TOLD about the secure
     *  desktop, which is not the same question as `secureDesktop` (what is
     *  true here). `null` = "it has not been told, or may have missed it".
     *
     *  The two must be separate or the notice becomes a one-way latch: relay
     *  drops while a UAC prompt is up, the prompt closes, the `up:false` goes
     *  nowhere, and an edge-trigger comparing against local truth never fires
     *  again — leaving a banner claiming the machine is unreachable pinned over
     *  a working picture for the rest of the session. Reset to `null` on any
     *  relay interruption so the next tick re-asserts whatever is true then. */
    secureDesktopSent: boolean | null;
    /** HOST: what the controller was last successfully TOLD about the cursor
     *  clip — the exact `secureDesktopSent` pattern, for the exact same
     *  one-way-latch reason. Reset to `null` on any relay interruption. */
    cursorClippedSent: boolean | null;
    /** CONTROLLER: when `secureDesktop` last became true (Date.now()), null
     *  while it is false. The locked-follow poller needs an AGE, not a flag:
     *  it deliberately waits out the host-side unsolicited-lock handover
     *  (which fires on the Windows lock EVENT and is instant when it can
     *  fire) before concluding the session STARTED on an already-locked
     *  machine — the case no event will ever announce. */
    secureDesktopSince: number | null;
    /** CONTROLLER: bounds phase 'connecting' — see CONNECT_DEADLINE_MS. */
    connectTimer: ReturnType<typeof setTimeout> | null;
    /** CONTROLLER: the display-power ack wait (POWER_ACK_TIMEOUT_MS). */
    pendingPowerAckTimer: ReturnType<typeof setTimeout> | null;
    /** Auto-clear for `powerNotice`. */
    powerNoticeTimer: ReturnType<typeof setTimeout> | null;
    /** CONTROLLER: a cursor-ownership request made before this session could
     *  send one, replayed on activation. null = nothing owed. */
    pendingCursorOwner: boolean | null;
    /** CONTROLLER: the 'input' data channel to an AGENT host, or null until
     *  it opens (R4). When open, sealed input frames go straight to the
     *  agent — no relay, no host webview, no Tauri IPC, no named pipe (the
     *  hop that wedged for 46s in the field). Null at any moment means the
     *  next frame takes the relay. */
    inputChannel: RTCDataChannel | null;
    /** CONTROLLER: has the agent PROVED it will serve the input channel?
     *
     *  AN OPEN CHANNEL IS NOT A CAPABILITY, and this field is what finally
     *  makes that true here rather than merely asserted in a comment. str0m
     *  opens a data channel by label whatever the far end intends to do with
     *  it, so `onopen` fires against every host: one that predates R4, a
     *  webview host with no agent at all, and — the case that broke the field
     *  in 0.8.121 — an agent whose session has no agent-held key, which logs
     *  "input keeps its existing path" and drops every frame. The controller
     *  had already LEFT that path, so all input died silently while the
     *  cursor kept moving locally.
     *
     *  The proof is a HELLO sealed under the session key, which only the
     *  agent holding that key can produce, sent only once it has an armed
     *  InputChannel. Until it arrives every frame takes the relay — exactly
     *  what shipped and worked before R4. */
    inputProved: boolean;
    /** CONTROLLER: sequence namespace for the input CHANNEL — separate from
     *  `sendSeq` (the relay's), because the agent tracks the two separately
     *  and a shared counter would let a channel frame invalidate a relayed
     *  one still in flight. */
    inputDcSeq: number;
    /** CONTROLLER: the viewer-opened 'caret' data channel, or null until it
     *  opens.
     *
     *  Deliberately NOT on DeviceControlSession: a public field means emit(),
     *  and emit() rebuilds a snapshot of every session, calls every listener (a
     *  React setState among them), pokes the tray indicator (a Tauri invoke)
     *  and pushes the Android keep-alive state — ten times a second while
     *  someone types is exactly the bridge flood this design exists to avoid. */
    caretChannel: RTCDataChannel | null;
    /** CONTROLLER: does the stage want caret reports? The INTENT, not the send —
     *  it must survive restartMedia rebuilding the pc (and with it the channel),
     *  and a request made before the channel ever opened. Same reasoning as
     *  pendingCursorOwner above. */
    caretTracking: boolean;
    /** CONTROLLER, diagnostics only: a caret frame has ARRIVED at least once.
     *  The only evidence the peer speaks caret — dc.onopen is not, because
     *  str0m opens the SCTP stream whether or not the agent recognises the
     *  label, so every old agent's channel opens too and then stays silent. */
    caretCapable: boolean;
    /** CONTROLLER, diagnostics only: how many frames parsed, and how many were
     *  dropped as malformed. */
    caretReports: number;
    caretDroppedMalformed: number;
    /** CONTROLLER, diagnostics only: the last report and when it landed. */
    caretLast: { r: CaretReport; at: number } | null;
    /** Bounds pc 'disconnected' — see PC_DISCONNECT_GRACE_MS. */
    pcDisconnectTimer: ReturnType<typeof setTimeout> | null;
    /** CONTROLLER: when input was last SENT (Date.now(), 0 = never). The
     *  media-liveness ladder's gate: a still desktop legitimately produces no
     *  frames, but no frames while the user is actively driving is a stall. */
    lastInputAt: number;
    /** CONTROLLER: the per-session stall ladder (mediaLiveness.ts), created by
     *  the 1Hz poll on first use and dying with the session. */
    liveness: MediaLiveness | null;
    /** CONTROLLER: when the last media restart was ATTEMPTED. A second stall
     *  inside RESTART_COOLDOWN_MS means restarting does not fix this path, and
     *  the session ends honestly instead of looping. null = never. */
    mediaRestartAt: number | null;
    /** HOST: when 'stream-died' was last sent (Date.now(), 0 = never). A
     *  30s throttle rather than a one-shot latch, deliberately: a latch was
     *  burned by injects failing during a restart's own stop→start gap, and
     *  wasted entirely when the sealed frame was handed to a below-OPEN
     *  socket (sendSignal cannot report that) — after which a REAL death was
     *  never reported again. While injects keep failing, the report simply
     *  repeats every 30s until one lands. */
    streamDiedAt: number;
    /** HOST: which screen to capture, chosen at consent time. */
    monitor: number | null;
    /** HOST: `monitor` was not chosen by anyone — it is the every-screen
     *  default this side applied for an armed multi-monitor agent host. What
     *  licenses answerOffer to fall back to output 0 if the composite cannot
     *  start; a screen a person picked is never silently swapped. */
    monitorDefaulted: boolean;
    pc: RTCPeerConnection | null;
    eph: ControlEphemeral;
    /** RAW 32-byte session key — sealControl/openControl take bytes. */
    key: Uint8Array | null;
    sendSeq: number;
    recvSeq: number;
    /** Signalling has its OWN pair. Input and signalling are separate ordered
     *  streams, so sharing a counter would make each drop the other's frames. */
    sendSigSeq: number;
    recvSigSeq: number;
    /** Serialises signal sends. The counter is useless if the frames carrying
     *  it can overtake each other on the way out. */
    sigQueue: SerialQueue;
    /** Serialises INPUT sends, so the sequence number a frame carries and the
     *  order it leaves in are the same order.
     *
     *  Separate from `sigQueue` on purpose: input and signalling have separate
     *  counters and separate receivers, so sharing one queue would make a slow
     *  SDP seal hold up the mouse. */
    inQueue: SerialQueue;
    /** Serialises input RECEIPT — the mirror, and required for the same reason
     *  the signalling side needs one: decrypt completions do not preserve
     *  arrival order, so the check-and-set on the sequence number would run out
     *  of order and drop legitimate events. */
    recvInQueue: SerialQueue;
    /** HOST: serialises INJECTION, separately from receipt. When injects ran
     *  on `recvInQueue` itself, every event's decrypt waited out the previous
     *  event's full backend round trip (Tauri IPC + the agent pipe) — a
     *  pipeline stall of a few ms per event at 60-125 events/s. Two serial
     *  queues make a two-stage pipeline: decrypts overlap the inject in
     *  flight, while each stage alone preserves order (emits enter this queue
     *  in sequence-number order, and the queue keeps them that way). */
    injectQueue: SerialQueue;
    /** CONTROLLER: how many input events a second are actually going out, for
     *  the diagnostic. Counted rather than guessed, because "it feels laggy"
     *  and "we are sending 120 events a second" are different problems. */
    inputRate: RateCounter;
    /** CONTROLLER: collapses outgoing pointer motion. Created on first input. */
    sendCoalescer: InputCoalescer | null;
    /** HOST: collapses motion that survived the network, before it reaches the
     *  agent's one-at-a-time pipe. */
    recvCoalescer: InputCoalescer | null;
    /** Serialises signal RECEIPT, and it is not optional for the same reason.
     *
     *  Frames arrive ordered on one WebSocket, but the handler hands each to
     *  WebCrypto on its own promise chain, so the check-and-set on `n` runs in
     *  DECRYPT-COMPLETION order rather than arrival order. A small ICE frame
     *  decrypts faster than a multi-KB SDP, retires the counter past it, and the
     *  SDP is then dropped as a replay.
     *
     *  Separate from sigQueue because the receive handler calls sendSignal — one
     *  queue for both would deadlock on the answer. */
    recvSigQueue: SerialQueue;
    /** Queued remote ICE — candidates routinely arrive before the answer is
     *  applied, and addIceCandidate throws if there is no remote description. */
    pendingIce: RTCIceCandidateInit[];
    /** Sealed signal frames that arrived before the session key existed.
     *
     *  THIS IS WHY ARMED UNATTENDED ACCESS NEVER WORKED. An armed host sends
     *  `ua-challenge` the instant it accepts, while the controller only has a
     *  key after an async peer-key lookup and a Diffie-Hellman over IPC. The
     *  challenge therefore landed while `s.key` was still null, `openSignal`
     *  dropped it, and nothing ever re-sent it: no passphrase prompt appeared,
     *  the host sat holding the offer, and the session died at the 30s media
     *  deadline with a message about "an older version" that was never
     *  displayed. Attended sessions were immune only because the host's first
     *  frame there is the answer, which cannot precede the controller's offer.
     *
     *  Buffered rather than dropped, and replayed in arrival order once the key
     *  is established. Bounded, because the relay chooses how many frames to
     *  deliver before then. */
    preKeyFrames: string[];
    /** HOST side: the captured screen, published when the controller's offer
     *  arrives. Captured at ACCEPT time rather than at offer time, so the user
     *  picks their screen once, while they are looking at the prompt. */
    hostStream: MediaStream | null;
    /** HOST side: the native agent owns the RTCPeerConnection, so this side
     *  must not create one — it only relays SDP between the peer and the agent. */
    agentOwnsTransport: boolean;
}

type Listener = (sessions: DeviceControlSession[]) => void;

const sessions = new Map<string, Internal>();
const listeners = new Set<Listener>();

/**
 * Keep the tray in step with whether this machine is being controlled.
 *
 * Driven by the SESSION, not by a mounted component: the whole point of an
 * always-on host is that no window need be open, and an indicator that only
 * exists while some UI is rendered would be absent exactly when it matters.
 */
function updateTrayIndicator(): void {
    const hosting = [...sessions.values()].find(s => s.role === 'host' && s.phase === 'active');
    void (async () => {
        try {
            const { isTauri } = await import('../platform');
            if (!isTauri()) return;
            const { invoke } = await import('@tauri-apps/api/core');
            // Forwarding is reported to the tray too, because it is the ONE
            // thing happening on a host that the screen does not show: a remote
            // party reaching services on this machine leaves no visible trace.
            // The tray is the host's only always-present indicator, so if it
            // does not say this, nothing does.
            let forwarding = 0;
            if (hosting) {
                try {
                    const { tunnelStatus } = await import('./tunnel');
                    forwarding = (await tunnelStatus(hosting.id)).inbound_streams;
                } catch {
                    // Unknown is reported as none rather than blocking the
                    // indicator; the session state itself still shows.
                }
            }
            await invoke('set_device_session_indicator', {
                active: !!hosting,
                peer: hosting?.peerDevice ?? null,
                forwarding,
                // A file grant is the other thing that leaves no trace on
                // screen, and on an ARMED host it now leaves no dialog either —
                // that prompt was the notification, and skipping it is the
                // feature. So the tray has to carry it, or nothing does.
                files: !!hosting?.fileScopeKind,
            });
        } catch {
            // The indicator is best-effort; failing to set it must not affect
            // the session itself.
        }
    })();
}

function emit(): void {
    // An explicit projection, not a spread: Internal carries session keys and
    // pending offers, and handing those to every subscriber would put secrets in
    // React state. The cost is that a new PUBLIC field must be added here too —
    // which the typechecker enforces, and did.
    const snapshot: DeviceControlSession[] = [...sessions.values()].map(s => ({
        id: s.id, role: s.role, peerDevice: s.peerDevice, phase: s.phase,
        stream: s.stream, captureSize: s.captureSize, error: s.error,
        monitors: s.monitors, activeMonitor: s.activeMonitor,
        filesChannel: s.filesChannel,
        fileRoot: s.fileRoot, fileScopeKind: s.fileScopeKind, filesOnly: s.filesOnly,
        privacyActive: s.privacyActive,
        cursorOwned: s.cursorOwned,
        reconnecting: s.reconnecting,
        awaitingMedia: s.awaitingMedia,
        mediaRestarting: s.mediaRestarting,
        secureDesktop: s.secureDesktop,
        cursorClipped: s.cursorClipped,
        powerNotice: s.powerNotice,
        shareUser: s.share ? { id: s.share.peerUser, username: s.share.peerUsername } : null,
        viewOnly: s.share ? !s.share.capabilities.includes('control') : false,
        unattended: s.unattended,
    }));
    listeners.forEach(l => l(snapshot));
    updateTrayIndicator();
    // Android: a session that is active OR STILL CONNECTING (either role)
    // must keep the process out of the cached freezer, or backgrounding the
    // app kills everything above. 'connecting' matters because the handshake
    // is human-paced — the person at the other machine has to click Allow —
    // and the natural move is to switch apps while they do; the service
    // starts while we are still foregrounded (the tap that started the
    // connect), which is exactly when Android permits it. Same pattern as
    // the tray call above: emit() is the one place every state change passes
    // through. No-ops everywhere but Android; degrades silently on an APK
    // without the plugin.
    setControlKeepAlive([...sessions.values()].some(s => s.phase !== 'ended'));
}

export function subscribeSessions(l: Listener): () => void {
    listeners.add(l);
    l([...sessions.values()]);
    return () => { listeners.delete(l); };
}

export function activeSessions(): DeviceControlSession[] {
    return [...sessions.values()];
}

function newId(): string {
    // Matches the server's valid_transfer_id charset (alphanumeric + '-').
    return 'ds' + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
}

/** How many sealed frames to hold while the key is still being agreed.
 *
 *  One is the realistic number (an armed host's `ua-challenge`, occasionally
 *  with a `monitors` frame behind it). The cap exists because the RELAY decides
 *  how many frames to deliver in that window, and an unbounded buffer fed by
 *  something we do not trust is a memory hole. */
const MAX_PRE_KEY_FRAMES = 32;

/** Hold a frame that arrived before the key existed, in arrival order. */
function bufferPreKeyFrame(s: Internal, blob: string): void {
    if (s.preKeyFrames.length >= MAX_PRE_KEY_FRAMES) {
        // The OLDEST is the one worth keeping — the challenge that starts the
        // handshake arrives first, and a flood after it is what we would rather
        // lose.
        console.warn('[device-session] too many signals before the key; dropping one');
        return;
    }
    s.preKeyFrames.push(blob);
}

/**
 * Replay everything held back, now that there is a key to open it with.
 *
 * Enqueued onto the SAME serial queue the live path uses, and drained
 * synchronously the moment the key lands, so a frame that arrives mid-drain
 * still ends up behind the ones that preceded it. Order matters here beyond
 * tidiness: `openSignal` enforces a strictly increasing counter, so a replay
 * out of order would be discarded as forgery.
 */
function drainPreKeyFrames(s: Internal): void {
    const held = s.preKeyFrames.splice(0);
    // Not into a session that has ended or no longer owns its id — the same
    // guard answerOffer and the deferred-offer path use, and for the same
    // reason: acting for a dead session reaches into whatever holds that id
    // now. Taken AFTER the splice so a dead session is emptied either way.
    if (s.phase === 'ended' || sessions.get(s.id) !== s) return;
    for (const blob of held) {
        void s.recvSigQueue.run(() => handleSignalFrame(s, blob));
    }
}

/**
 * HOST: tell the controller which screens it can switch between.
 *
 * Sealed like every other signal, so the relay learns nothing about this
 * machine's display layout.
 *
 * A FUNCTION, not the inline block it used to be, because it has TWO callers.
 * An armed host must not send this before the passphrase is proved — the labels
 * are this machine's display names and an unauthenticated controller has no
 * business reading them — and the only send site sat behind exactly that check
 * with nothing to run it afterwards. So every armed session, on every
 * multi-monitor machine, came up with no screen switcher at all: the one
 * configuration where remote control most needs one.
 */
async function announceMonitors(s: Internal, opts?: { evenIfSingle?: boolean }): Promise<void> {
    if (s.phase === 'ended' || sessions.get(s.id) !== s) return;
    try {
        const backend = await getHostBackend();
        const monitors = await backend.listMonitors();
        // A single-screen machine normally offers no switcher at all — but
        // after a TOPOLOGY change the controller is holding a list of screens
        // that no longer exist, and the one-entry announce is what retires it
        // (the switcher, the edge-hop chips and the zoom-follow maths all
        // read that list).
        if (monitors.length > 1 || (opts?.evenIfSingle && monitors.length === 1)) {
            await sendSignal(s, {
                kind: 'monitors',
                monitors: monitors.map((m, i) => ({
                    id: m.id ?? i,
                    label: m.label ?? `Screen ${i + 1}`,
                    // Desktop-space geometry, when the backend measured it
                    // (the agent always does). The controller's
                    // zoom-follows-monitor needs the layout to know which
                    // screen the viewport is over; a peer that predates the
                    // fields ignores them.
                    ...(typeof m.left === 'number' && typeof m.top === 'number'
                        ? { left: m.left, top: m.top, width: m.width, height: m.height }
                        : {}),
                })),
                active: s.monitor ?? 0,
            });
        }
    } catch { /* a host that cannot enumerate simply offers no switcher */ }
}

/** Derive the session key once both ephemerals are known. */
async function establishKey(s: Internal, peerDevicePub: string, peerEph: string): Promise<boolean> {
    try {
        const staticSs = await deviceKeyDh(peerDevicePub);
        const raw = deriveDeviceControlKey(staticSs, s.eph.priv, peerEph);
        if (!raw) return false;
        s.key = raw;
        // Immediately, and from HERE rather than from each caller: both roles
        // agree their key through this function, and a peer is free to send the
        // moment it has one of its own. Doing it in one caller only is the
        // half-a-pair mistake this codebase keeps paying for.
        drainPreKeyFrames(s);
        return true;
    } catch (e) {
        console.warn('[device-session] key agreement failed:', e);
        return false;
    }
}

/**
 * Send a signalling message SEALED under the session key.
 *
 * Every DeviceSignal must go through here. Until 0.8.1 the SDP and ICE were
 * relayed as plain JSON while a comment three lines away claimed the server
 * "relays them without being able to read or influence them". It could read all
 * of it, and — the part that matters — it could REWRITE it.
 *
 * An SDP carries the DTLS-SRTP fingerprint. Substitute the fingerprint in each
 * direction and the server terminates DTLS itself: it holds both media keys and
 * watches your screen in cleartext, while both ends show a connected session.
 * Nothing about the picture looks wrong, because from each end's point of view
 * nothing IS wrong — they negotiated with whoever the server said was there.
 *
 * Sealing costs nothing here because the key already exists: both sides run
 * establishKey BEFORE the first offer, against a device public key that is only
 * accepted if its enrolment record verified under the account signing key this
 * client derived from the password. The server cannot forge that record, so it
 * cannot obtain this key — and now cannot forge the fingerprint that would let
 * it skip needing it.
 */
async function sendSignal(s: Internal, obj: Record<string, unknown>): Promise<void> {
    // No key means no authenticated channel, and an unsealed fallback would
    // No key means no authenticated channel, and an unsealed fallback would
    // hand back exactly the downgrade this closes.
    if (!s.key) return;

    // SERIALISED, one frame at a time per session.
    //
    // Assigning the counter is synchronous but sealControl is not, so two
    // concurrent callers take n=0 and n=1 and then race through WebCrypto. If
    // n=1 seals first it goes out first, and the receiver — which requires
    // strictly increasing n — drops the perfectly legitimate n=0 frame as a
    // replay. Not hypothetical: setLocalDescription starts ICE gathering, so
    // onicecandidate fires while the answer is still being sealed, and the two
    // race in every session.
    //
    // The lock is taken BEFORE the counter is read, so the number a frame
    // carries and the order it leaves in are the same order.
    //
    // openSignal is serialised too, on its own queue. Doing only this half is
    // the bug that shipped for an hour: a guard that leaves its mirror image
    // open is not a guard.
    await s.sigQueue.run(async () => {
        const sealed = await sealControl(s.key!, JSON.stringify({ ...obj, sid: s.id, n: s.sendSigSeq++ }));
        wsClient.send({ type: 'DeviceSignal', payload: { session_id: s.id, payload: sealed } });
    });
}

/** Open a sealed signal; null if it was forged, replayed cross-session, or clear. */
async function openSignal(s: Internal, blob: string): Promise<Record<string, unknown> | null> {
    if (!s.key) return null;
    const plain = await openControl(s.key, blob);
    if (plain === null) return null;
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(plain); } catch { return null; }
    // Bind to THIS session. Without it a server holding a sealed frame from one
    // session could splice it into another between the same two devices.
    if (obj.sid !== s.id) return null;
    // STRICTLY INCREASING, so the relay cannot replay a frame it already passed
    // on. Sealing alone does not stop that: a sealed frame stays valid forever,
    // and the same key opens it every time. Input frames have had this since the
    // feature shipped; signalling did not, so a server could re-deliver a
    // captured ua-challenge and make the controller prompt for the passphrase
    // again, or re-deliver an offer to force renegotiation at will.
    //
    // Safe against a legitimate reorder ONLY because callers run this inside
    // s.recvSigQueue. The WebSocket delivers frames in order, but each is handed
    // to WebCrypto on its own promise chain, so decrypt completions do NOT
    // preserve that order — a small ICE frame beats a multi-KB SDP and retires
    // the counter past it, after which the SDP is dropped as a replay and the
    // session dies showing a black tile.
    //
    // "The socket is ordered, so frames cannot overtake each other" is what this
    // comment used to say. It is true of the wire and false of the client, and
    // believing it is why the receive side went unserialised while the send side
    // was being fixed for the identical reason.
    if (typeof obj.n !== 'number' || !Number.isInteger(obj.n) || obj.n <= s.recvSigSeq) return null;
    s.recvSigSeq = obj.n;
    return obj;
}

/**
 * Answer an SDP offer. THIS is the moment the screen starts leaving the machine,
 * so every caller must have cleared the unattended gate first.
 */
async function answerOffer(
    s: Internal,
    sdp: string,
    /** Rates to start the new stream at — only a media RESTART passes this,
     *  carrying forward what the controller had applied so the rebuilt stream
     *  does not silently reset to defaults. */
    quality?: { fps: number; bitrate_kbps: number },
): Promise<void> {
    // Never answer for a session that has ended or no longer owns its id.
    //
    // Checked HERE rather than only at the call sites, because on the agent
    // transport answering sends start_stream: a capture thread that outlives its
    // session runs until a matching StopStream or the agent exits, and DXGI
    // duplication is exclusive per output — so one stray stream makes every
    // later session on that monitor fail until the agent is restarted.
    if (s.phase === 'ended' || sessions.get(s.id) !== s) return;
    if (s.agentOwnsTransport) {
        // The agent owns the peer connection. This side must not build one: two
        // connections answering the same offer would both send, and the
        // controller would render whichever won.
        const { agentAnswerOffer } = await import('./hostAgent');
        // s.monitor is what the person at this machine picked in the consent
        // dialog — or, for an armed host with more than one screen, the
        // every-screen default applied before startSession. Passing null here
        // — as this did until the dialog existed — means the agent captures
        // output 0 whatever they chose, so a host that deliberately selected
        // Display 2 shares Display 1 while BOTH ends display "Display 2".
        const opts = { dataOnly: s.filesOnly, fps: quality?.fps, bitrateKbps: quality?.bitrate_kbps };
        let answerSdp: string;
        try {
            answerSdp = await agentAnswerOffer(s.id, sdp, s.monitor, opts);
        } catch (e) {
            // THE COMPOSITE IS ALL-OR-NOTHING on the agent: it reserves every
            // output, and one of them being held by something else (another
            // app's desktop duplication, a raw capture) refuses the whole
            // start. A machine that streamed its first screen yesterday must
            // not fail to connect today because this side defaulted it to
            // every screen — so a DEFAULTED composite that the agent refuses
            // falls back to output 0, once, exactly as before the default
            // existed. A refused StartStream leaves no stream and no
            // reservation behind (session.rs releases them on the error path),
            // so the retry is clean. A screen a PERSON chose is never swapped.
            if (!(s.monitorDefaulted && s.monitor === ALL_DISPLAYS)) throw e;
            // (The cast: TS narrowed `phase` at the top of this function and
            // cannot see the await between.)
            if ((s.phase as SessionPhase) === 'ended' || sessions.get(s.id) !== s) throw e;
            console.warn('[Devices] the agent refused the every-screen default; falling back to the first screen:', e);
            s.monitor = 0;
            s.monitorDefaulted = false;
            answerSdp = await agentAnswerOffer(s.id, sdp, 0, opts);
            // announceMonitors already said `active: 255`. Correct it the way a
            // confirmed switch does, so the viewer's picker, its caret filter
            // and its every-screen fallback all see the screen it is really
            // getting. After the answer below? No — ordering on the sealed
            // channel is by sequence, and this must land with the answer's
            // picture, not behind it.
            void sendSignal(s, { kind: 'monitor-active', active: 0 });
        }
        // The stream exists from here, so queued candidates have somewhere to
        // go. Set BEFORE draining: a candidate arriving during the drain must
        // take the direct path rather than being appended to a list nobody will
        // read again.
        s.agentStreamStarted = true;
        const queued = s.pendingIce.splice(0);
        if (queued.length) {
            const { agentAddRemoteCandidate } = await import('./hostAgent');
            for (const c of queued) {
                if (c.candidate) await agentAddRemoteCandidate(s.id, c.candidate);
            }
        }
        // Acknowledge data-only so the controller can REQUIRE it rather than
        // assume it: an older host ignores the request and captures, and the
        // controller has no other way to tell.
        await sendSignal(s, { kind: 'answer', sdp: answerSdp, dataOnly: s.filesOnly });
        // Drain a file request that was held only because the agent had no
        // stream to grant against (see serveFileAccessRequest); it has one
        // now. The serve re-checks every gate — armed proof, revocation —
        // when it runs, so nothing is granted here that was not already
        // earned.
        if (s.pendingFileRequest && s.phase === 'active' && sessions.get(s.id) === s) {
            s.pendingFileRequest = false;
            void serveFileAccessRequest(s);
        }
        return;
    }
    if (!s.pc) attachPc(s, new RTCPeerConnection(withRelayOnlyIfRequested(await fetchIceConfig())));
    // THE OTHER HALF of data-only, and it was missing.
    //
    // Only the agent branch above honoured `filesOnly`; this one published the
    // screen regardless. So opening "Files" against a webview host — any host
    // without the native agent — captured and streamed that machine's display
    // for a session the user opened to browse files, and then failed the file
    // request anyway because hostWebview has no setFileAccess. Capturing MORE
    // than asked while delivering less is the worst pairing available.
    //
    // The capture is released rather than merely left unpublished: it was
    // started before the offer arrived, so `filesOnly` was not yet knowable, and
    // a live getDisplayMedia track keeps the browser's "sharing" indicator up
    // over a session that shows nobody anything.
    if (s.role === 'host' && s.filesOnly && s.hostStream) {
        s.hostStream.getTracks().forEach(t => t.stop());
        s.hostStream = null;
    }
    // Publish the capture BEFORE answering: tracks added after
    // setLocalDescription need a second negotiation round, and the controller
    // would sit on a black tile until it landed.
    if (s.role === 'host' && s.hostStream) {
        for (const track of s.hostStream.getTracks()) {
            s.pc!.addTrack(track, s.hostStream);
        }
    }
    await s.pc!.setRemoteDescription({ type: 'offer', sdp });
    await applyPendingIce(s);
    const answer = await s.pc!.createAnswer();
    await s.pc!.setLocalDescription(answer);
    await sendSignal(s, { kind: 'answer', sdp: answer.sdp, dataOnly: s.filesOnly });
}

// minimiseJitterBuffer lives in rtc/receiverLatency.ts now, shared with the
// in-server remote-control path — the rationale and the inverse are there.
// Device sessions exist only to be driven, so this side applies it
// unconditionally at connect and never restores.

/** Start (or restart) the controller's wait-for-video deadline.
 *
 *  `message` overrides the default no-first-frame explanation for callers
 *  whose silence means something else — a media RESTART that produced nothing
 *  is a dead path or a host too old to understand the restart signal, not a
 *  sleeping screen, and telling the user to move the mouse would be a lie. */
/**
 * Ceiling on how long ANY watchdog may keep deferring itself.
 *
 * The deferrals below are individually correct — a frozen WebView must not be
 * read as evidence against the remote machine — but each one re-armed without
 * limit, so a visibility signal stuck at 'hidden' disarmed every safety net in
 * this file permanently. A session then sat on "Waiting for the device's
 * screen…" for as long as the user was willing to look at it, and the honest
 * error that exists for exactly this case could never be reached.
 *
 * Five minutes is far past any window in which deferring can still pay off:
 * the SERVER ends a session whose side has been detached for 60s
 * (DEVICE_SESSION_DETACH_GRACE_SECS) and reaps a quiet one at 180s, so there
 * is nothing left to resume to long before this fires. It is a backstop that
 * turns "hangs for ever" into "says what happened", not a new timeout — in
 * every case that used to work, it is never reached.
 */
const MAX_WATCHDOG_DEFER_MS = 5 * 60_000;

function armMediaDeadline(s: Internal, message?: string, deferredMs = 0): void {
    if (s.role !== 'controller') return;
    clearMediaDeadline(s);
    // Never for a file-only session: no video is coming, by design, and this
    // timer exists to complain that none did.
    //
    // The guard belongs HERE rather than at the call site. It was first written
    // as a branch around the call in the connect flow, which left the OTHER
    // caller — the renegotiation path — arming a 30s clock that every file
    // session was then guaranteed to lose. Putting it in the function covers
    // both halves and any caller added later, which is the point.
    if (s.filesOnly) return;
    // Never while a passphrase dialog is open. Typing takes as long as it
    // takes, and the HOST's own 120s deadline is what bounds it; a 30s clock
    // running underneath would end the session mid-keystroke.
    if (s.awaitingUaPassphrase) return;
    // The stage overlay runs off THIS flag, not off `s.stream` — the stream
    // is attached eagerly (Safari needs it on a playing <video> before it
    // will start the pipeline), so its existence stopped meaning "video
    // arrived" long ago and the overlay it gated never showed on Chromium.
    s.awaitingMedia = true;
    const armedAt = Date.now();
    s.mediaTimer = setTimeout(() => {
        // Do NOT bail on `s.stream` here: the stream is attached EAGERLY at
        // connect time (Safari/WKWebView won't start the media pipeline until
        // the MediaStream is on a playing <video>), so its existence no longer
        // means video arrived. Every path that really receives video —
        // ontrack, the receiver track's onunmute — clears this timer
        // explicitly. If we are still running, nothing arrived.
        if (s.phase !== 'active' || sessions.get(s.id) !== s) return;
        // If this clock ran while the app was hidden or the relay was down,
        // it measured a frozen WebView, not the device: a suspended timer
        // fires on thaw with its 30s "elapsed" in an instant, and blaming the
        // device for a screen that could not possibly have arrived tore down
        // sessions that were about to resume. Wait out a fresh, watched
        // window instead.
        // `appIsBackgrounded` rather than the raw flag: a WebView that reports
        // 'hidden' while it is still painting frames is lying, and believing it
        // is what let this clock re-arm for ever instead of ever reporting.
        // The MAX_WATCHDOG_DEFER_MS ceiling is the backstop for every other way
        // this could stall.
        const deferred = deferredMs + (Date.now() - armedAt);
        if ((appIsBackgrounded() || s.transportDown) && deferred < MAX_WATCHDOG_DEFER_MS) {
            armMediaDeadline(s, message, deferred);
            return;
        }
        // Name the causes, because the symptom cannot distinguish them and the
        // user has no other way to tell them apart.
        teardown(
            s,
            message
            ?? ('No screen arrived from that device. Its screens may be asleep '
            + 'and unable to wake (try again — or move its mouse), it may be '
            + 'waiting for someone to approve screen sharing on it, or it may '
            + 'be running an older version of Púca.'),
            true,
        );
    }, MEDIA_DEADLINE_MS);
}

function clearMediaDeadline(s: Internal): void {
    if (s.mediaTimer) { clearTimeout(s.mediaTimer); s.mediaTimer = null; }
}

/** Real media arrived on the receive track — clear everything that was
 *  waiting for it.
 *
 *  ONE function, used by BOTH unmute paths (buildControllerPc's onunmute and
 *  attachPc's ontrack fallback), because they write to the SAME track object:
 *  Chrome non-compliantly fires ontrack for the locally-created recvonly
 *  transceiver and its handler used to REASSIGN track.onunmute — clobbering
 *  the buildControllerPc handler, which was the only place `mediaRestarting`
 *  was cleared. On Chromium the first media restart then latched
 *  mediaRestarting forever and every later stall went undetected. Identical
 *  handlers make the overwrite harmless. */
function markMediaArrived(s: Internal): void {
    clearMediaDeadline(s);
    s.awaitingMedia = false;
    if (s.mediaRestarting) {
        s.mediaRestarting = false;
        // The rebuilt stream may be running at the host's defaults (a restart
        // after the agent reaped its stream cannot read the dead stream's
        // rates) — re-query so the quality UI describes what is actually
        // running rather than what the old stream was set to.
        void sendSignal(s, { kind: 'query_stream_quality' }).catch(() => undefined);
    }
    emit();
}

/** Bound phase 'connecting': a DeviceConnect nobody answers must become a
 *  named failure, not a zombie. Frozen-webview discipline as armMediaDeadline:
 *  a deadline that ran while the app was hidden or the socket was down
 *  measured a suspended webview, not the server, so it re-arms and waits out
 *  a fresh watched window instead of blaming anyone. */
function armConnectDeadline(s: Internal, deferredMs = 0): void {
    clearConnectDeadline(s);
    const armedAt = Date.now();
    s.connectTimer = setTimeout(() => {
        s.connectTimer = null;
        if (s.phase !== 'connecting' || sessions.get(s.id) !== s) return;
        const deferred = deferredMs + (Date.now() - armedAt);
        if ((appIsBackgrounded() || !wsClient.isConnected) && deferred < MAX_WATCHDOG_DEFER_MS) {
            armConnectDeadline(s, deferred);
            return;
        }
        // tellPeer: if the server DID create the session (and the host simply
        // never answered), this DeviceEnd releases its slot; if it never saw
        // the connect, ending an unknown session is a no-op there.
        teardown(s, 'no answer from that device — check the connection and try again', true);
    }, CONNECT_DEADLINE_MS);
}

function clearConnectDeadline(s: Internal): void {
    if (s.connectTimer) { clearTimeout(s.connectTimer); s.connectTimer = null; }
}

/** Arm (once) the bounded 'disconnected' countdown. Frozen-webview rule as
 *  ever: a countdown that ran while hidden or while the transport was down
 *  measured the freezer, so it re-arms for a fresh watched window. */
function armPcDisconnectWatchdog(s: Internal, pc: RTCPeerConnection, deferredMs = 0): void {
    if (s.pcDisconnectTimer) return;
    const armedAt = Date.now();
    s.pcDisconnectTimer = setTimeout(() => {
        s.pcDisconnectTimer = null;
        if (sessions.get(s.id) !== s || s.phase === 'ended' || s.pc !== pc) return;
        const deferred = deferredMs + (Date.now() - armedAt);
        if ((appIsBackgrounded() || s.transportDown || s.peerReconnecting)
            && deferred < MAX_WATCHDOG_DEFER_MS) {
            armPcDisconnectWatchdog(s, pc, deferred);
            return;
        }
        if (pc.connectionState !== 'disconnected' && pc.connectionState !== 'failed') return;
        s.error = 'the connection to that device was lost';
        teardown(s, s.error, true);
    }, PC_DISCONNECT_GRACE_MS);
}

/**
 * End a session.
 *
 * `deliberate` means somebody MEANT this — the user pressed Disconnect, the peer
 * closed its side normally, the account signed out. It is not a synonym for
 * "clean": the reason is still sent to the peer and still recorded. It only says
 * the controller must not be shown a red banner about it, because "you
 * disconnected" is not news to the person who clicked Disconnect.
 */
function teardown(s: Internal, reason: string, tellPeer: boolean, deliberate = false): void {
    // Does this object still OWN its id? Everything keyed by id rather than by
    // object — closing tunnels, stopping the host backend, the map delete — must
    // be skipped when it does not, or a stale session tearing down late (the UA
    // deadline timer, a 'failed' connection state) reaches into whichever
    // session holds that id now and closes ITS ports and capture.
    const owns = sessions.get(s.id) === s;
    // Before anything that can fail: a kill-switch hook and an idle timer that
    // outlive their session would fire into whatever holds that id next, and
    // the hook is a low-level input hook — not a thing to leave running for a
    // session that has ended. Keyed by id, so a superseded object tearing down
    // late must not release the live session's guard.
    if (owns) releaseControlGuard(s.id);
    if (tellPeer && s.phase !== 'ended') {
        // Silently a no-op when the socket is down — and that is fine, not a
        // leak. A down socket is one whose server-side close marks this
        // session detached (drop_device_sessions_for_conn), after which the
        // reaper or the next DeviceConnect's supersede path frees the slot.
        // Do NOT be tempted to park-and-replay this frame on the next socket:
        // end_device_session only honours a conn the session records
        // (opposite_conn), and a fresh conn is a stranger to it — a replayed
        // DeviceEnd is refused, by policy the server's tests pin.
        wsClient.send({ type: 'DeviceEnd', payload: { session_id: s.id, reason } });
    }
    // A remembered unattended seed this session signed with but the host never
    // demonstrably accepted is dropped. Rejection produces no signal of its
    // own — the host just tears the session down — so "still 'used' at
    // teardown" IS the rejection observable, and keeping the seed would replay
    // the same refusal promptless on every future connect. The cost of the
    // conservative direction (a session that died before the host's first
    // post-proof frame re-prompts next time) is one typed passphrase.
    if (s.role === 'controller' && s.uaCache === 'used') {
        s.uaCache = null;
        forgetUaSeed(s.peerDevice);
    }
    // The session is ending for real; a pending transport-grace countdown has
    // nothing left to end. Same for the connect deadline and the
    // 'disconnected' watchdog — timers that outlive their session fire into
    // whatever holds the id next.
    if (s.transportGraceTimer) {
        clearTimeout(s.transportGraceTimer);
        s.transportGraceTimer = null;
    }
    if (s.pendingPowerAckTimer) { clearTimeout(s.pendingPowerAckTimer); s.pendingPowerAckTimer = null; }
    if (s.powerNoticeTimer) { clearTimeout(s.powerNoticeTimer); s.powerNoticeTimer = null; }
    // Display power STAYS AS SET (user decision, display_power.rs): the host
    // only stops the keep-off ticker so the next physical input at the
    // machine wakes its panels — no relight rides the teardown. `owns`, like
    // every other host-side effect here: the ticker is PROCESS-global, and a
    // superseded session's late teardown must not disengage the ticker the
    // live session is holding (review W4-N3). Best-effort: on a phone the
    // invoke does not exist and the catch answers it.
    if (s.role === 'host' && owns) {
        // The topology restore is for the LAST host session out: one viewer
        // dropping must not re-extend the desktop under another session that
        // is still working on it. Counted here, at the teardown, because the
        // shell cannot see the session map.
        const otherHostLive = [...sessions.values()].some(o =>
            o !== s && o.role === 'host' && o.phase !== 'ended');
        void import('./hostBackend')
            .then(m => m.shellDisplayPowerSessionEnd(!otherHostLive))
            .catch(() => undefined);
    }
    clearConnectDeadline(s);
    if (s.pcDisconnectTimer) {
        clearTimeout(s.pcDisconnectTimer);
        s.pcDisconnectTimer = null;
    }
    // Close forwarded ports FIRST, while the session is still coherent. An
    // in-flight socket that outlives its session is a route into this machine's
    // network with nothing left authorising it -- the failure the whole
    // allowlist exists to prevent, arriving by the back door.
    if (owns) void closeTunnels(s.id);
    // Revoke file access on the same principle, and before anything else can
    // fail: the agent outlives the session, so a root left armed is a folder
    // still reachable by whatever opens the next data channel. Best-effort --
    // stopSession below tears the stream down regardless, which drops the
    // grant with it; this is the belt to that pair of braces.
    // Gated on the SCOPE, not on fileRoot: a policy grant has no folder, so
    // `s.fileRoot` stays null for it and a check on that alone would skip the
    // revoke for exactly the grant that reaches the most.
    if (owns && s.role === 'host' && s.fileScopeKind) {
        void getHostBackend()
            .then(b => b.setFileAccess?.(s.id, null))
            .catch(() => { /* the stream is going away anyway */ });
    }
    s.fileRoot = null;
    s.fileScopeKind = null;
    s.privacyActive = false;
    // The host's capture dies with the session and is born drawing its own
    // pointer again, so ownership cannot outlive this object.
    s.cursorOwned = false;
    try { s.pc?.close(); } catch { /* already closed */ }
    s.stream?.getTracks().forEach(t => t.stop());
    s.hostStream?.getTracks().forEach(t => t.stop());
    s.hostStream = null;
    s.pc = null;
    s.key = null;
    // Drop anything held for a passphrase that will now never arrive.
    s.pendingOffer = null;
    // And anything held for a key that will now never be agreed. A dead session
    // must carry nothing replayable: teardown nulls the key, but if one were
    // ever agreed afterwards this buffer would be drained into a session that
    // has already released its capture and closed its ports.
    s.preKeyFrames.length = 0;
    // Pending motion goes with it — a timer that outlives its session would
    // fire a move at whatever holds that id next.
    s.sendCoalescer?.dispose();
    s.recvCoalescer?.dispose();
    // And the keyframe-request budget, keyed by an id the next session may
    // reuse. Same for the caret subscribers: a subscription left behind would
    // deliver the NEXT session's frames to a dead stage.
    if (owns) {
        lastKeyframeReq.delete(s.id);
        caretSubs.delete(s.id);
    }
    s.caretTracking = false;
    s.caretChannel = null;
    clearMediaDeadline(s);
    s.phase = 'ended';
    // A deliberate end must not LEAVE an error either: a transient one latched
    // earlier in the session (a refused monitor switch, a privacy toggle that
    // failed) would otherwise be presented as the reason the session ended,
    // minutes after the user had already read and moved past it.
    s.error = deliberate ? null : (s.error ?? reason);
    if (owns) {
        clearStreamQualityTimeout(s.id);
        import('../../stores/streamStore').then(({ useStreamStore }) => {
            useStreamStore.getState().clearPendingQuality(s.id);
        }).catch(() => undefined);
        void getHostBackend().then(b => b.stopSession(s.id)).catch(() => { /* nothing to stop */ });
        // EMIT THE ENDED SESSION BEFORE DELETING IT.
        //
        // The delete came first, so subscribers only ever saw the session
        // vanish — and every carefully worded reason ('unattended passphrase
        // rejected', 'the person at that device declined', 'that device is
        // already in a session') was written onto an object no one could still
        // read. From the user's seat the remote-desktop window simply closed,
        // which is why an armed session that failed for four different reasons
        // was indistinguishable from one that failed for any of the others.
        emit();
        sessions.delete(s.id);
    }
    emit();
}

/** End a session locally and tell the peer. */
/**
 * Ask the HOST to show a different screen.
 *
 * Fire-and-forget by design: the host confirms with `monitor-active` once the
 * capture has actually changed, or reports `monitor-failed`. Updating the picker
 * optimistically here would show the wrong screen as selected whenever the
 * switch was refused — which is exactly what a webview host does, since its
 * source was fixed when the picker was answered.
 */
export function requestMonitor(sessionId: string, monitor: number): void {
    const s = sessions.get(sessionId);
    if (!s || s.role !== 'controller' || s.phase !== 'active') return;
    void sendSignal(s, { kind: 'set-monitor', monitor });
}

/** One shared budget for every keyframe trigger (foreground return, transport
 *  reattach, the stall watchdog): three triggers coalescing on one resume
 *  must cost one IDR, not three. Cleared in teardown with the session. */
const lastKeyframeReq = new Map<string, number>();
const KEYFRAME_MIN_INTERVAL_MS = 3_000;

/**
 * Ask the host to force an IDR. The agent's GOP is infinite — keyframes exist
 * only on demand — so a controller whose decoder lost reference state (the
 * canonical case: Android froze this app mid-session and the stage came back
 * a still image) recovers ONLY if something asks. The peer's own PLI is
 * supposed to be that something; on Android after a thaw it demonstrably
 * is not always. Old hosts ignore the signal (unknown kinds fall through
 * handleSignalFrame with no else) and old agents answer "bad request", which
 * the host swallows — so against any peer this degrades to a no-op, never an
 * error.
 */
export function requestKeyframe(sessionId: string): boolean {
    const s = sessions.get(sessionId);
    if (!s || s.role !== 'controller' || s.phase !== 'active' || s.filesOnly) return false;
    // A downed transport drops the frame silently in wsClient.send — and a
    // budget stamped for a request that never left SUPPRESSED the reattach
    // trigger that fires seconds later, which was the one reliable trigger.
    // No stamp without a live socket; the reattach handler retries.
    //
    // Same for a detached PEER: the server relays a DeviceSignal by conn id
    // and silently drops one aimed at a conn that is gone, so a request sent
    // while the host is mid detach-grace is guaranteed lost — and stamping
    // the budget for it suppressed the retry DevicePeerReconnected now fires.
    if (s.transportDown || s.peerReconnecting) return false;
    const now = Date.now();
    if (now - (lastKeyframeReq.get(sessionId) ?? 0) < KEYFRAME_MIN_INTERVAL_MS) return false;
    lastKeyframeReq.set(sessionId, now);
    void sendSignal(s, { kind: 'request-keyframe' }).catch(() => undefined);
    return true;
}

// --- Media liveness: the mid-session picture watchdog -----------------------

/** A second stall inside this window after a restart means restarting does
 *  not fix this path (the network is gone, or dies every time) — the session
 *  ends honestly instead of looping restarts forever. */
const RESTART_COOLDOWN_MS = 120_000;

/** How soon after a restart was ATTEMPTED a host 'stream-died' is believed.
 *  Inside this window the report describes the restart's own stop→start gap
 *  (an inject in flight when StopStream landed) or the stream the restart
 *  already replaced — acting on it tore down sessions whose picture had just
 *  come back. The restart's own media deadline owns this window; a REAL
 *  death of the new stream re-reports after the host's 30s throttle. */
const RESTART_STREAM_DIED_MUTE_MS = 15_000;

/** HOST: minimum gap between 'stream-died' reports — see streamDiedAt. */
const STREAM_DIED_RESEND_MS = 30_000;

const RESTART_FAILED_MSG =
    'the video stream was lost and could not be re-established — reconnect to the device';

/** Build the controller's receive side: files channel, recvonly video
 *  transceiver, jitter floor, eager stream attach. ONE function for first
 *  connect and media restart, so the two cannot drift.
 *
 *  The transceiver is captured explicitly: Safari / WKWebView (the Capacitor
 *  mobile app) strictly follows the WebRTC spec and does NOT fire `ontrack`
 *  for transceivers created locally via addTransceiver(). Chrome
 *  non-compliantly fires it anyway, which is why the desktop path always
 *  worked. attachPc's ontrack stays as belt-and-suspenders for Chrome; the
 *  real signal is the receiver track's `onunmute`, which fires on ALL
 *  platforms at the first RTP packet. The stream is attached to `s.stream`
 *  IMMEDIATELY because WKWebView will not start the media pipeline (or fire
 *  onunmute) until the MediaStream sits on a playing <video>. */
async function buildControllerPc(s: Internal): Promise<RTCPeerConnection> {
    const pc = new RTCPeerConnection(withRelayOnlyIfRequested(await fetchIceConfig()));
    attachPc(s, pc);

    const filesDc = pc.createDataChannel('files', { negotiated: false });
    filesDc.onopen = () => {
        s.filesChannel = filesDc;
        emit();
    };
    filesDc.onclose = () => {
        if (s.filesChannel === filesDc) s.filesChannel = null;
        emit();
    };

    // THE CARET CHANNEL. Same options as `files` above, deliberately: an
    // unreliable/unordered channel is the theoretically better shape for a
    // position stream, but nothing here has ever negotiated one against str0m,
    // and a channel type it mishandles faults the SCTP association `files` and
    // `tunnel` share. The cost of ordering is one frame of staleness at 10Hz,
    // which the solver's dead zone absorbs.
    //
    // Created for EVERY controller session, desktop included: this is the shared
    // first-connect/restart transport builder, an idle channel costs one SCTP
    // stream and zero bytes (the agent sends nothing until it is asked), and
    // `isMobile` is runtime-mutable — a channel cannot be added later without
    // renegotiation, so gating creation would make a desktop that becomes touch
    // permanently caretless. Traffic is gated in the stage instead.
    //
    // AN OPEN CHANNEL IS NOT A CAPABILITY. An agent that predates this logs the
    // ChannelOpen and drops every byte; a JS host ignores an unknown label. Both
    // are silence, and silence is handled by the viewer's own fallback timer,
    // never by waiting on channel state.
    // P2P INPUT (R4). RELIABLE + ORDERED, and one lane only — unlike the mesh
    // pair (rtc/controlDc.ts), where absolute moves ride an unreliable lane.
    // The unreliable split is deferred here on purpose: this channel shares
    // an SCTP association with `files`, `caret` and the tunnel, and a
    // mishandled channel type can fault the whole association in str0m — a
    // latency nicety is not worth risking the file transfer that is running
    // over it. Measure the pump first (R4.5).
    //
    // Created at pc construction like every other channel: adding one later
    // renegotiates.
    //
    // AN OPEN CHANNEL IS NOT A CAPABILITY — and unlike the first cut of this,
    // that is now enforced rather than asserted. The old comment here reasoned
    // that the agent "refuses input on a session it was not told holds a
    // control grant", and treated that refusal as sufficient. It is sufficient
    // for SAFETY and useless for LIVENESS: the agent's refusal is silent, so a
    // controller that had already switched to this channel simply lost every
    // event. In the field (0.8.121) that was total — cursor moving on the
    // phone, nothing happening on the PC — because an ordinary session's key
    // lives in the app, not the agent, and the agent logs exactly that before
    // dropping the frame.
    //
    // So the channel starts UNPROVED and input keeps taking the relay until
    // the agent sends a hello sealed under the session key. No hello, no
    // change in behaviour from before R4 existed.
    const inputDc = pc.createDataChannel('input', { negotiated: false });
    inputDc.onopen = () => { s.inputChannel = inputDc; s.inputProved = false; };
    inputDc.onmessage = e => { void handleInputHello(s, inputDc, e.data); };
    inputDc.onclose = () => {
        if (s.inputChannel === inputDc) {
            s.inputChannel = null;
            // The proof belonged to THAT channel. A rebuilt one has to earn
            // it again, or a reconnect would inherit a capability its new far
            // end never claimed.
            s.inputProved = false;
        }
    };

    const caretDc = pc.createDataChannel('caret', { negotiated: false });
    caretDc.onopen = () => {
        s.caretChannel = caretDc;
        // Covers both ask-before-open and the media-restart rebuild.
        if (s.caretTracking) writeCaretTrack(caretDc, true);
    };
    caretDc.onclose = () => {
        if (s.caretChannel === caretDc) s.caretChannel = null;
    };
    caretDc.onmessage = e => handleCaretMessage(s, e.data);
    // No emit() in any of these, unlike filesDc: filesChannel is public and the
    // file UI gates on it. Nothing renders from this one.

    // Receive-only: the controller sends input over the sealed WS channel,
    // never media.
    const tc = pc.addTransceiver('video', { direction: 'recvonly' });
    const recvTrack = tc.receiver.track;
    minimiseJitterBuffer(tc.receiver);
    s.stream = new MediaStream([recvTrack]);
    // A restarted stream's first RTP is also the proof the restart worked —
    // markMediaArrived clears mediaRestarting alongside the deadline.
    recvTrack.onunmute = () => markMediaArrived(s);
    return pc;
}

/**
 * Rebuild a live session's MEDIA transport in place.
 *
 * The session — key, sequence counters, grants, passphrase proof, monitor
 * choice — all survive; only the WebRTC leg is torn down and renegotiated.
 * This is the recovery for every "the picture died but nothing else did"
 * state: neither end has ICE-restart machinery (str0m 0.21 no-ops it), the
 * agent cannot re-gather for a live stream, and a TURN allocation lost to a
 * NAT rebind is unrecoverable on the old socket — so the honest fix is a
 * fresh offer, a fresh gather and a fresh allocation under the same session.
 *
 * The host side handles `restart-offer` by stopping its stream and answering
 * like a first offer (skipping consent — the session was already authorised).
 * An OLD host ignores the unknown signal kind entirely; the media deadline
 * armed below then ends the session with an honest message instead of the
 * frozen frame it would otherwise wear forever.
 */
async function restartMedia(s: Internal): Promise<void> {
    if (s.role !== 'controller' || s.phase !== 'active' || s.filesOnly) return;
    if (s.mediaRestarting) return;
    // A restart is a sealed signal over the relay; while either half of the
    // relay is down it is guaranteed lost (the server drops frames for a
    // detached conn silently). The liveness ladder simply re-escalates after
    // the reattach if the picture is still dead.
    if (s.transportDown || s.peerReconnecting) return;
    s.mediaRestarting = true;
    s.mediaRestartAt = Date.now();
    try {
        // The old pc must not narrate its own death into the session the new
        // pc is about to carry: handlers off BEFORE close, or a late 'failed'
        // tears down a session that is mid-recovery.
        const old = s.pc;
        if (old) {
            old.onconnectionstatechange = null;
            old.onicecandidate = null;
            old.ontrack = null;
            try { old.close(); } catch { /* already closed */ }
        }
        if (s.pcDisconnectTimer) {
            clearTimeout(s.pcDisconnectTimer);
            s.pcDisconnectTimer = null;
        }
        s.pc = null;
        // Stale ICE from the dead negotiation must not poison the new one.
        s.pendingIce = [];
        s.stream?.getTracks().forEach(t => t.stop());
        // Forwarded ports rode the old pc's tunnel channel and died with it —
        // close their local ends coherently rather than leaving half-open
        // listeners pointing into a closed channel. Awaited so the close
        // cannot race the fresh tunnel channel attachPc is about to create.
        await closeTunnels(s.id).catch(() => undefined);
        s.filesChannel = null;
        // The channel died with the pc; `caretTracking` deliberately does NOT —
        // it is the intent this rebuild must preserve, and the fresh channel's
        // onopen re-asserts it. Missing this would make caret-follow silently
        // die after any network blip: the "worked yesterday" class of bug.
        s.caretChannel = null;

        // Host-acked state describes the OLD stream: the fresh capture is
        // born compositing its own cursor and unblanked. Remember what the
        // user had, drop the acks, and re-assert after the offer — the host
        // serialises signal receipt, so these apply to the NEW stream.
        const wantedCursor = s.cursorOwned || s.pendingCursorOwner === true;
        const wantedPrivacy = s.privacyActive;
        s.cursorOwned = false;
        s.privacyActive = false;

        const pc = await buildControllerPc(s);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        // Privacy rides IN the offer rather than as a follow-up set-privacy:
        // the host's StopStream un-blanks unconditionally, so the host must
        // re-blank in the same handler that starts the new stream — a
        // separate frame could be dropped by the same network event that
        // caused this restart, leaving a deliberately-blanked host machine
        // showing its desktop with the controller's toggle reading "on".
        await sendSignal(s, {
            kind: 'restart-offer', sdp: offer.sdp, filesOnly: s.filesOnly,
            privacy: wantedPrivacy,
        });
        if (wantedCursor) {
            s.pendingCursorOwner = true;
            flushPendingCursorOwner(s);
        }
        armMediaDeadline(s, RESTART_FAILED_MSG);
        emit();
    } catch (e) {
        s.mediaRestarting = false;
        teardown(s, `could not re-establish the stream: ${e instanceof Error ? e.message : String(e)}`, true);
    }
}

/**
 * The liveness ladder's terminal verdict: probes went unanswered (or the
 * host said its stream died). Restart once; a path that dies AGAIN within
 * the cooldown is not going to be fixed by a third negotiation — end it
 * with a reason instead of cycling the waiting overlay forever.
 */
function handleMediaStalled(s: Internal): void {
    if (s.role !== 'controller' || s.phase !== 'active' || s.filesOnly) return;
    if (s.mediaRestarting) return;
    const now = Date.now();
    if (s.mediaRestartAt !== null && now - s.mediaRestartAt < RESTART_COOLDOWN_MS) {
        teardown(s, RESTART_FAILED_MSG, true);
        return;
    }
    void restartMedia(s);
}

/** inbound-rtp video framesDecoded, or null when it cannot be read. */
async function readFramesDecoded(pc: RTCPeerConnection): Promise<number | null> {
    try {
        const stats = await pc.getStats();
        let out: number | null = null;
        stats.forEach(r => {
            if (r.type === 'inbound-rtp' && (r as { kind?: string }).kind === 'video') {
                const n = Number((r as { framesDecoded?: number }).framesDecoded);
                if (Number.isFinite(n)) out = n;
            }
        });
        return out;
    } catch {
        return null;
    }
}

/** One pass of the 1Hz liveness poll — see mediaLiveness.ts for the ladder
 *  itself. Kept re-entrancy-safe: getStats is async and a slow tick must not
 *  stack behind itself. */
let livenessPollBusy = false;
async function pollMediaLiveness(): Promise<void> {
    // The interval runs for the life of the tab; this is what makes a tick
    // with no device work cost a map-size read and nothing else.
    if (sessions.size === 0) return;
    if (livenessPollBusy) return;
    livenessPollBusy = true;
    try {
        for (const s of [...sessions.values()]) {
            if (s.role !== 'controller' || s.phase !== 'active' || s.filesOnly) continue;
            // `!appIsBackgrounded()` rather than a raw 'visible' check: a
            // WebView reporting 'hidden' while it is still painting would
            // otherwise disable the whole freeze-recovery ladder for a user
            // who is watching a frozen picture — the one moment it exists for.
            // `!s.secureDesktop` PINS the ladder while a UAC prompt, the lock
            // screen or the sign-in screen owns the host's display. No frames
            // arrive then — by design, the host is holding the last one — so
            // the ladder would climb to `escalate` and renegotiate the whole
            // media transport against a host that is not sending anything and
            // will not until the prompt closes. Ineligible is exactly the right
            // treatment: it pins the progress clock rather than judging on
            // evidence that cannot exist. This is also the tick where the user
            // is most likely to be jabbing at the screen, which is what the
            // input gate below keys on.
            const eligible = !s.transportDown && !s.peerReconnecting
                && !s.awaitingMedia && !s.mediaRestarting
                && !s.secureDesktop
                && !!s.pc
                && !appIsBackgrounded();
            // getStats is only worth its round trip while the ladder could
            // act on the answer — and it only acts under recent input. A
            // session merely being WATCHED skips the read entirely (null
            // pins the ladder's progress clock, which is the same "cannot
            // judge" treatment ineligible ticks get).
            const inputRecent = Date.now() - s.lastInputAt <= INPUT_RECENT_MS;
            const frames = eligible && inputRecent && s.pc ? await readFramesDecoded(s.pc) : null;
            const ladder = (s.liveness ??= new MediaLiveness());
            const now = Date.now();
            const verdict = ladder.sample({
                now,
                framesDecoded: frames,
                lastInputAt: s.lastInputAt,
                eligible,
            });
            if (verdict === 'probe') {
                // Only a request that actually went out climbs the ladder — one
                // suppressed by the shared budget retries on the next tick.
                if (requestKeyframe(s.id)) ladder.probeSent(now);
            } else if (verdict === 'escalate') {
                ladder.reset(now);
                handleMediaStalled(s);
            }
        }
    } finally {
        livenessPollBusy = false;
    }
}

/** One pass of the 1Hz secure-desktop poll, HOST side.
 *
 *  Why a poll rather than a push: the agent raises its flag on a capture
 *  failure, and the pipe is request/response — the agent has no way to call the
 *  app. 1Hz is the same cadence the liveness poll already runs at, one small
 *  pipe round trip per active agent-hosted session, and only while one exists.
 *
 *  EDGE-TRIGGERED. Only a CHANGE is relayed, so an unchanged answer costs the
 *  round trip and nothing on the wire — a per-second signal would burn the
 *  relay's rate budget and the controller's replay counter for no new fact.
 */
/**
 * THE CONTROLLER'S HALF of the locked-machine story: follow to the sign-in
 * row when the session is stuck on a secure desktop that turns out to be a
 * LOCK — the case the host-side unsolicited-lock handover cannot see.
 *
 * That handover (handleConsoleLock, below) fires on the Windows lock EVENT,
 * deliberately: the `secureDesktop` flag alone cannot tell a lock from a UAC
 * prompt, and a UAC prompt has no sign-in row to follow to. But an event
 * only helps when it fires DURING a session. A machine that was ALREADY
 * locked when the session started — above all the ARSO cold boot, where
 * Windows auto-signs-in and locks at boot, so the phone's wake-connect finds
 * the desktop row online and lands on it — shows the banner forever, with
 * the lock event long in the past (field report 2026-08-20: woke the PC,
 * connected at ~140s, could not enter the PIN, had to reconnect by hand).
 *
 * The LEVEL signal that breaks the tie: the SYSTEM service keeps the
 * sign-in row's socket open ONLY while the console is locked or logged off
 * ("the console is in use — dropping the socket"). So `secureDesktop` PLUS
 * that machine's sign-in row online can only mean a real lock — a UAC
 * prompt implies a signed-in console, which implies that row is offline.
 *
 * Patience is load-bearing twice over: LOCKED_FOLLOW_AFTER_MS keeps this
 * from racing the host-side handover when the event DID fire (that path is
 * near-instant; this one is the fallback), and the ROW-ONLINE gate keeps a
 * non-enrolled machine's frozen-banner session alive — followToSignIn's
 * no-row branch would END it, and ending a session this poller was not
 * asked to end is worse than the freeze it would cure.
 *
 * Exported for its test; driven by a 5s interval in installDeviceSessions.
 */
export const LOCKED_FOLLOW_AFTER_MS = 8_000;
/** After the first minute of a secure episode, look only every 4th tick
 *  (~20s): the row usually appears within seconds of the lock, but the one
 *  real cold boot this exists for took MINUTES (the sign-in service was
 *  retrying a server 500), and giving up entirely would strand exactly the
 *  case this was built from. listDevices verifies a signature per device,
 *  so the slow lane is not free — but it is bounded to banner-visible time. */
const LOCKED_FOLLOW_SLOW_AFTER_MS = 60_000;
let lockedFollowBusy = false;
let lockedFollowTick = 0;
export async function pollLockedFollow(): Promise<void> {
    if (lockedFollowBusy) return;
    lockedFollowTick++;
    const now = Date.now();
    const eligible = [...sessions.values()].filter(s =>
        s.role === 'controller' && s.phase === 'active'
        && !s.filesOnly && !s.share && !s.reconnecting
        && s.secureDesktop && s.secureDesktopSince !== null
        && now - s.secureDesktopSince >= LOCKED_FOLLOW_AFTER_MS
        && (now - s.secureDesktopSince < LOCKED_FOLLOW_SLOW_AFTER_MS
            || lockedFollowTick % 4 === 0));
    if (eligible.length === 0) return;
    const userId = currentUserId();
    if (userId == null) return;
    lockedFollowBusy = true;
    try {
        // Dynamic, like every other wakeSession/machines reach-in from this
        // module: those files import session.ts, and a static import back
        // would be a cycle.
        const { listDevices } = await import('./index');
        const { groupIntoMachines, machineOf } = await import('./machines');
        const machines = await groupIntoMachines(await listDevices(userId));
        for (const s of eligible) {
            // Re-check under the awaits — the session can have ended, been
            // replaced, or unlocked while the list was fetched.
            if (sessions.get(s.id) !== s || s.phase === 'ended' || !s.secureDesktop
                || s.reconnecting) continue;
            const machine = machineOf(machines, s.peerDevice);
            const signIn = machine?.signInRow ?? null;
            // No row: not enrolled — leave the freeze-and-resume behaviour
            // alone. Same row: this session IS the sign-in session (its host
            // never reports secureDesktop, but belt over braces).
            if (!signIn || signIn.id === s.peerDevice) continue;
            if (!signIn.online || !signIn.verified) continue;
            // Exactly the shape of the handover the controller already knows:
            // deliberate (no red banner), and tellPeer TRUE — unlike the
            // DeviceEnded-driven branch (where the host already ended), HERE
            // the controller initiates while the desktop app still holds a
            // live session and its one-session slot; without the DeviceEnd it
            // would refuse the very follow this enables with "already in a
            // session". followToSignIn re-lists and re-checks for itself.
            teardown(s, 'that machine is locked — moving to its sign-in screen', true, true);
            followMachineToSignIn(s.peerDevice);
        }
    } catch {
        // A failed device-list read must not disturb the session; the next
        // tick tries again.
    } finally {
        lockedFollowBusy = false;
    }
}

let secureDesktopPollBusy = false;
/** An out-of-band nudge (the unlock event) that landed while a pass was in
 *  flight. Dropped, it would silently degrade back to the next-tick latency
 *  the event exists to remove; queued, the finishing pass re-runs once. */
let secureDesktopPollAgain = false;
async function pollSecureDesktop(): Promise<void> {
    if (sessions.size === 0) return;
    if (secureDesktopPollBusy) { secureDesktopPollAgain = true; return; }
    secureDesktopPollBusy = true;
    try {
        const hosts = [...sessions.values()].filter(
            s => s.role === 'host' && s.phase === 'active' && !s.filesOnly,
        );
        if (hosts.length === 0) return;
        // WRAPPED, even though it resolves a cached singleton and swallows its
        // own probe failures: this runs once a second forever, and an escaped
        // rejection here would be an unhandled-rejection storm rather than one
        // bad tick. Everything below it already answers rather than throws.
        let backend;
        try {
            backend = await getHostBackend();
        } catch {
            return;
        }
        // Absent on a webview host and on mobile: they cannot tell, and
        // "cannot tell" must stay silent rather than assert a negative.
        if (!backend.sessionStatus) return;
        for (const s of hosts) {
            // A RELAY INTERRUPTION FORGETS WHAT THE CONTROLLER KNOWS. Nothing
            // sent now would arrive, and worse, an edge-trigger that kept
            // believing the controller had been told would never re-assert —
            // see `secureDesktopSent`. Skip, forget, re-assert on recovery.
            if (s.transportDown || s.peerReconnecting) {
                s.secureDesktopSent = null;
                s.cursorClippedSent = null;
                continue;
            }
            let up = false;
            let clipped = false;
            try {
                const status = await backend.sessionStatus(s.id);
                up = status.secureDesktop;
                clipped = status.cursorClipped === true;
            } catch {
                // sessionStatus swallows its own errors; this is belt and
                // braces so one bad tick can never reach the caller.
                continue;
            }
            if (up !== s.secureDesktop) {
                s.secureDesktop = up;
                emit();
            }
            if (clipped !== s.cursorClipped) {
                s.cursorClipped = clipped;
                emit();
            }
            // Compared against what the CONTROLLER was told, not against what
            // is true here, so a notice lost to a dropped relay is re-sent.
            if (up !== s.secureDesktopSent) {
                s.secureDesktopSent = up;
                void sendSignal(s, { kind: 'secure-desktop', up }).catch(() => undefined);
            }
            if (clipped !== s.cursorClippedSent) {
                s.cursorClippedSent = clipped;
                void sendSignal(s, { kind: 'cursor-clipped', clipped }).catch(() => undefined);
            }
        }
    } finally {
        secureDesktopPollBusy = false;
        if (secureDesktopPollAgain) {
            secureDesktopPollAgain = false;
            void pollSecureDesktop();
        }
    }
}

const pendingTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

export function clearStreamQualityTimeout(sessionId: string) {
    const existing = pendingTimeouts.get(sessionId);
    if (existing) {
        clearTimeout(existing);
        pendingTimeouts.delete(sessionId);
    }
}

export const sendStreamQuality = debounce(
    (sessionId: string, fps: number, bitrateKbps: number) => {
        const s = sessions.get(sessionId);
        if (!s || s.role !== 'controller') return;

        import('../../stores/streamStore').then(({ useStreamStore }) => {
            useStreamStore.getState().setPendingQuality(sessionId, { fps, bitrate: bitrateKbps });
        });

        clearStreamQualityTimeout(sessionId);
        pendingTimeouts.set(sessionId, setTimeout(() => {
            pendingTimeouts.delete(sessionId);
            import('../../stores/streamStore').then(({ useStreamStore }) => {
                const store = useStreamStore.getState();
                if (store.pendingQualities[sessionId]) {
                    store.clearPendingQuality(sessionId);
                    window.dispatchEvent(new CustomEvent('stream-quality-failed', { detail: { sessionId, code: 'apply_timeout' } }));
                }
            });
        }, 5000));

        // Same reasoning as the query below: a send that rejects is a known
        // failure, so report it now instead of making the user wait out the
        // full 5s timeout for news we already have.
        void sendSignal(s, { kind: 'update-stream', fps, bitrate: bitrateKbps }).catch(() => {
            clearStreamQualityTimeout(sessionId);
            import('../../stores/streamStore').then(({ useStreamStore }) => {
                useStreamStore.getState().clearPendingQuality(sessionId);
            }).catch(() => undefined);
            window.dispatchEvent(new CustomEvent('stream-quality-failed', {
                detail: { sessionId, code: 'update_failed' },
            }));
        });
    },
    500,
    { leading: false, trailing: true }
);

export function queryStreamQuality(sessionId: string): void {
    const s = sessions.get(sessionId);
    if (!s || s.role !== 'controller') return;
    // A QUERY NEEDS A DEADLINE TOO. Only the UPDATE path was timed, so a host
    // that went silent after `query_stream_quality` left the controller
    // waiting forever with nothing on screen to say the query had failed —
    // the one case a user cannot distinguish from "the quality really is
    // whatever is showing". Reuses the update path's timer map and failure
    // event, so a reply of either kind cancels it (both call
    // clearStreamQualityTimeout) and the UI needs no new code.
    clearStreamQualityTimeout(sessionId);
    pendingTimeouts.set(sessionId, setTimeout(() => {
        pendingTimeouts.delete(sessionId);
        window.dispatchEvent(new CustomEvent('stream-quality-failed', {
            detail: { sessionId, code: 'query_failed' },
        }));
    }, 5000));
    // Catch a send that rejects outright rather than waiting out the 5s: the
    // failure is already known, and `void` alone would swallow it.
    void sendSignal(s, { kind: 'query_stream_quality' }).catch(() => {
        clearStreamQualityTimeout(sessionId);
        window.dispatchEvent(new CustomEvent('stream-quality-failed', {
            detail: { sessionId, code: 'query_failed' },
        }));
    });
}


export function setPrivacyMode(sessionId: string, enabled: boolean): void {
    const s = sessions.get(sessionId);
    if (!s || s.role !== 'controller' || s.phase !== 'active') return;
    void sendSignal(s, { kind: 'set-privacy', enabled });
}

/** What a controller may ask the host to do to the machine itself. The
 *  display trio (W4) and the topology pair spell snake_case on the wire —
 *  pinned on both Rust receiving ends (power.rs serde test, agent parse
 *  test). The topology pair DETACHES the non-primary displays from the
 *  desktop (windows re-arrange onto the primary; the pointer cannot leave
 *  it) rather than darkening panels; the host restores on reattach, session
 *  end, and app start. */
export type PowerAction =
    | 'lock' | 'shutdown'
    | 'displays_off' | 'displays_off_keep_primary' | 'displays_on'
    | 'displays_detach_others' | 'displays_reattach';

export const DISPLAY_POWER_ACTIONS: readonly PowerAction[] =
    ['displays_off', 'displays_off_keep_primary', 'displays_on',
        'displays_detach_others', 'displays_reattach'];

/** The pair that changes the desktop TOPOLOGY — the host must rebuild the
 *  agent's captures and re-announce its screens after these. */
export const TOPOLOGY_POWER_ACTIONS: readonly PowerAction[] =
    ['displays_detach_others', 'displays_reattach'];

/** How long a display action may go unanswered before the controller says
 *  so. Display actions are the one power set the controller WAITS on: lock
 *  and shutdown announce themselves through the session ending, but panels
 *  going dark on a machine you cannot see produce no signal at all — and an
 *  old host ignores unknown actions silently, which without this deadline
 *  would be indistinguishable from success. */
export const POWER_ACK_TIMEOUT_MS = 5_000;

/** Auto-clear for the transient power notice line. */
const POWER_NOTICE_MS = 6_000;

function setPowerNotice(s: Internal, text: string | null): void {
    if (s.powerNoticeTimer) { clearTimeout(s.powerNoticeTimer); s.powerNoticeTimer = null; }
    s.powerNotice = text;
    emit();
    if (text !== null) {
        s.powerNoticeTimer = setTimeout(() => {
            if (sessions.get(s.id) !== s) return;
            s.powerNoticeTimer = null;
            s.powerNotice = null;
            emit();
        }, POWER_NOTICE_MS);
    }
}

/**
 * Ask the host to lock its console, shut the machine down, or change display
 * power. Sealed like every other signal; the host applies the same
 * unattended-access gate as input, and the CONTROLLER UI puts a confirmation
 * in front of shutdown. Returns false when there is no active controller
 * session to send on (the UI says so).
 */
export function sendPowerAction(sessionId: string, action: PowerAction): boolean {
    const s = sessions.get(sessionId);
    if (!s || s.role !== 'controller' || s.phase !== 'active') return false;
    // A view-only share may not lock or power off the owner's machine — the
    // same line sendInput draws, and the host draws it again on its side.
    if (s.share && !s.share.capabilities.includes('control')) return false;
    if (s.transportDown) return false;
    void sendSignal(s, { kind: 'power', action });
    if (DISPLAY_POWER_ACTIONS.includes(action)) {
        if (s.pendingPowerAckTimer) clearTimeout(s.pendingPowerAckTimer);
        s.pendingPowerAckTimer = setTimeout(() => {
            if (sessions.get(s.id) !== s) return;
            s.pendingPowerAckTimer = null;
            // Honest about the likeliest cause: an old host drops unknown
            // power kinds on the floor by design.
            setPowerNotice(s, 'That device did not respond to the display request — it may need updating.');
        }, POWER_ACK_TIMEOUT_MS);
    }
    return true;
}

/**
 * Ask the host to hand over the cursor — or hand it back.
 *
 * Why this exists: the host composites its pointer INTO the video, so the
 * cursor the viewer sees is a round trip behind their finger. A camera that
 * follows the finger therefore always runs ahead of the visible pointer, and
 * no amount of timing on this end can close a gap made of network latency.
 * Drawing the cursor here instead — from the same coordinates that drive the
 * camera — makes the two move together by construction, which is how
 * this is what makes it feel exact.
 *
 * Fire-and-forget, and deliberately WITHOUT a deadline: silence from a host
 * that does not understand the request is already the correct terminal state
 * (it keeps drawing, this end keeps not drawing). Only the ack flips
 * ownership, so every mixed-version pair still shows exactly one cursor.
 */
export function setCursorOwned(sessionId: string, owned: boolean): void {
    const s = sessions.get(sessionId);
    if (!s || s.role !== 'controller') return;
    if (s.phase !== 'active') {
        // NOT dropped: the stage mounts and asks for the cursor as soon as it
        // has a session id, which is normally BEFORE the handshake finishes —
        // so the send window and the request raced, and on the losing side the
        // request vanished with nothing to retry it. The host kept compositing,
        // this end kept not drawing, and the whole feature silently did nothing
        // while every part of it tested green in isolation. Hold the intent;
        // going active replays it.
        s.pendingCursorOwner = owned;
        return;
    }
    void sendSignal(s, { kind: 'set-cursor-owner', owned });
}

/** Replay an ownership request that was made before the session could send. */
function flushPendingCursorOwner(s: Internal): void {
    if (s.pendingCursorOwner === null) return;
    const owned = s.pendingCursorOwner;
    s.pendingCursorOwner = null;
    void sendSignal(s, { kind: 'set-cursor-owner', owned });
}

// --- THE CARET CHANNEL ----------------------------------------------------
//
// Where the remote TEXT CARET is, so a phone can zoom the picture to it while
// the soft keyboard covers the bottom half of the screen.
//
// NOT a DeviceSignal kind, and that is load-bearing: DeviceSignal rides the
// server's GENERAL rate bucket (CAPACITY 100, REFILL 50/s — src/ws.rs; only
// DeviceInput gets the 300/s bucket) and over-budget frames are dropped
// SILENTLY. It also shares one strictly-increasing `n` and one sigQueue with SDP
// and ICE, so a 10Hz caret stream would compete with negotiation for ordering.
// A data channel is peer-to-peer, unmetered by the relay, and dies with the pc.

/** Agent → viewer, on the caret channel.
 *
 *  Fractions 0..1 of the CURRENTLY CAPTURED SURFACE (one monitor, or the
 *  All-Displays composite), never desktop pixels — fractions are the one
 *  representation a monitor or resolution switch cannot make stale, and they are
 *  the convention the input path already uses.
 *
 *  `mon` is the agent's active monitor (or ALL_DISPLAYS) and `surf` a generation
 *  bumped on every capture rebuild: the data channel is DIRECT while
 *  `monitor-active` rides the RELAY, so their arrival orders are unrelated and a
 *  frame sampled on the surface before a switch has to be recognisable. */
export interface CaretReport {
    vis: boolean;
    x: number; y: number; w: number; h: number;
    /** 'win32' | 'msaa' | 'uia' | 'field' — which tier answered. 'field' means
     *  the focused element's box, not a real caret, and is placed differently. */
    src: string | null;
    mon: number | null;
    surf: number | null;
    seq: number | null;
}

/** Viewer → agent. */
function writeCaretTrack(dc: RTCDataChannel, on: boolean): void {
    if (dc.readyState !== 'open') return;
    try {
        dc.send(JSON.stringify({ t: 'track', on }));
    } catch {
        // The channel died between the readyState read and the send. The stage
        // re-asserts on the next open; there is nothing to report here.
    }
}

/**
 * TYPEOF, NOT TRUTHINESS — the rule the cursor-owner ack learned the hard way.
 * This shape is what the peer SENT, not what it promised.
 *
 * A fraction outside 0..1 is a broken coordinate map on the other side; acting
 * on it would pan the picture out of the viewport, so it is DROPPED, not clamped
 * — a wrong caret silently obeyed is worse than no caret at all.
 */
export function parseCaretFrame(raw: unknown): CaretReport | null {
    // A peer can send anything; a report is ~110 bytes.
    if (typeof raw !== 'string' || raw.length > 512) return null;
    let v: unknown;
    try {
        v = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!v || typeof v !== 'object') return null;
    const o = v as Record<string, unknown>;
    // The tag is `t`, matching the agent's serde `#[serde(tag = "t")]` — and
    // deliberately NOT `kind`, which is the sealed-signal vocabulary: the two
    // must stay tag-disjoint so a frame from one path can never be read as the
    // other. The agent's own test reads this file and asserts both spellings.
    const isCaretFrame = o.t === 'caret';
    if (!isCaretFrame || typeof o.vis !== 'boolean') return null;
    const num = (k: unknown) => (typeof k === 'number' && Number.isFinite(k) ? k : null);
    if (!o.vis) {
        // A hidden report still carries mon/surf/seq — it is the agent's "no
        // caret on this surface" and the viewer counts it as proof the peer
        // speaks caret at all.
        return {
            vis: false, x: 0, y: 0, w: 0, h: 0, src: null,
            mon: num(o.mon), surf: num(o.surf), seq: num(o.seq),
        };
    }
    const q = [num(o.x), num(o.y), num(o.w), num(o.h)];
    if (q.some(n => n === null)) return null;
    const [x, y, w, h] = q as number[];
    if (x < 0 || x > 1 || y < 0 || y > 1 || w < 0 || w > 1 || h < 0 || h > 1) return null;
    const mon = num(o.mon);
    const surf = num(o.surf);
    // A visible caret with no surface identity cannot be placed safely: the
    // whole point of mon/surf is that a frame from the wrong surface is
    // recognisable, and a missing one is indistinguishable from a matching one.
    if (mon === null || surf === null) return null;
    return {
        vis: true, x, y, w, h,
        src: typeof o.src === 'string' ? o.src : null,
        mon, surf, seq: num(o.seq),
    };
}

/** Caret subscribers, per session.
 *
 *  DELIBERATELY NOT emit() — see the caretChannel field. The caret has exactly
 *  one consumer, so it gets exactly one channel to it. Keyed by id rather than
 *  by session object so a subscriber can arrive before, or outlive, the session
 *  lookup. */
const caretSubs = new Map<string, Set<(r: CaretReport) => void>>();

export function subscribeCaret(sessionId: string, cb: (r: CaretReport) => void): () => void {
    let set = caretSubs.get(sessionId);
    if (!set) {
        set = new Set();
        caretSubs.set(sessionId, set);
    }
    set.add(cb);
    return () => {
        const live = caretSubs.get(sessionId);
        if (!live) return;
        live.delete(cb);
        if (live.size === 0) caretSubs.delete(sessionId);
    };
}

/**
 * The agent's HELLO on the input channel — the only thing that lets input
 * leave the relay (R4).
 *
 * SEALED UNDER THE SESSION KEY, and that is the whole security argument: the
 * channel carries input to a machine, so "this end will serve you" must come
 * from the holder of the key and from nobody else. A bare marker byte would
 * let anything that can write on the channel — a compromised relay steering a
 * peer connection, a host that opens the label for other reasons — talk this
 * controller off a working transport onto a dead one, which is a denial of
 * service against the one feature the session exists for.
 *
 * Anything unparseable, wrongly sealed, or for another session is IGNORED
 * rather than treated as a refusal: staying on the relay is already the safe
 * state, so there is nothing a bad frame can win here.
 */
async function handleInputHello(s: Internal, dc: RTCDataChannel, raw: unknown): Promise<void> {
    if (s.inputChannel !== dc || !s.key) return;
    if (typeof raw !== 'string') return;
    let sid: unknown;
    let hello: unknown;
    try {
        const parsed = JSON.parse(raw) as { sid?: unknown; hello?: unknown };
        sid = parsed.sid;
        hello = parsed.hello;
    } catch {
        return;
    }
    if (sid !== s.id || typeof hello !== 'string') return;
    let plain: string | null = null;
    try {
        plain = await openControl(s.key, hello);
    } catch {
        return;
    }
    if (plain === null) return;
    let ok = false;
    try {
        ok = (JSON.parse(plain) as { hello?: unknown }).hello === 1;
    } catch {
        return;
    }
    if (!ok) return;
    // The session may have been torn down or the channel rebuilt while the
    // open was in flight; proving a channel this end no longer holds would
    // arm a transport nobody is listening on.
    if (s.inputChannel !== dc) return;
    s.inputProved = true;
    console.info(`[p2p-input] session ${s.id}: the agent serves the input channel`);
}

function handleCaretMessage(s: Internal, raw: unknown): void {
    const r = parseCaretFrame(raw);
    if (!r) {
        s.caretDroppedMalformed++;
        return;
    }
    s.caretCapable = true;
    s.caretReports++;
    s.caretLast = { r, at: Date.now() };
    const subs = caretSubs.get(s.id);
    if (!subs) return;
    // A throwing subscriber must not kill the channel. This deliberately does
    // NOT run inside handleSignalFrame's try/catch, whose catch TEARS THE
    // SESSION DOWN — one more reason the caret is not a signal kind.
    for (const cb of [...subs]) {
        try {
            cb(r);
        } catch {
            // The subscriber's problem, and only its own.
        }
    }
}

/**
 * Ask the host to report where the remote text caret is — or to stop.
 *
 * Fire-and-forget with NO ack pair, unlike set-cursor-owner. There is nothing to
 * hand over and nothing to get wrong: an unanswered request costs one 24-byte
 * datagram, and the viewer's own 500ms fallback already covers silence. The ack
 * pattern earns its keep when the two ends must agree on who DRAWS a cursor;
 * here they need not agree on anything.
 */
export function setCaretTracking(sessionId: string, on: boolean): void {
    const s = sessions.get(sessionId);
    if (!s || s.role !== 'controller') return;
    if (s.caretTracking === on) return;   // the stage re-asks on every band change
    s.caretTracking = on;
    // No channel yet? The intent is recorded and the channel's onopen replays
    // it — the same race that shipped as 0.8.51 on the cursor path: the stage
    // asks as soon as it has a session id, which is before the transport exists.
    if (s.caretChannel) writeCaretTrack(s.caretChannel, on);
}

/**
 * Ask the person at the host to allow browsing one folder.
 *
 * Deliberately a request and not a setting: the answer comes back as
 * `file-access-granted`/`file-access-denied` and lands on `session.fileRoot`,
 * so the UI reflects what the HOST allowed rather than what we asked for.
 */
export function requestFileAccess(sessionId: string): void {
    const s = sessions.get(sessionId);
    if (!s || s.role !== 'controller' || s.phase !== 'active') return;
    void sendSignal(s, { kind: 'file-access-request' });
}

/**
 * Withdraw every file grant this machine is currently handing out.
 *
 * The kill switch behind the tray's "Stop file access". It does NOT end the
 * sessions: someone watching a screen should not lose the screen because the
 * disk was withdrawn, and someone browsing files should be told they no longer
 * may rather than simply dropped.
 *
 * Takes effect on the peer's NEXT request. The agent re-reads the scope on every
 * one rather than caching it at grant time, which is what makes revocation
 * immediate instead of "after a reconnect".
 *
 * Returns how many grants were withdrawn, so a caller can say nothing was live.
 */
export function revokeAllFileAccess(): number {
    // Every HOST session, not only the ones currently granted. A session with no
    // grant yet still gets the sticky flag, so pressing this pre-emptively means
    // "not this session" rather than "nothing right now, ask again in a second".
    const hosting = [...sessions.values()].filter(s => s.role === 'host');
    const granted = hosting.filter(s => s.fileScopeKind);
    for (const s of hosting) {
        s.fileAccessRevoked = true;
    }
    for (const s of granted) {
        s.fileRoot = null;
        s.fileScopeKind = null;
        void getHostBackend()
            .then(b => b.setFileAccess?.(s.id, null))
            .catch(() => { /* best effort; the local state is already cleared */ });
        void sendSignal(s, { kind: 'file-access-revoked' }).catch(() => undefined);
    }
    if (hosting.length) emit();
    return granted.length;
}

/**
 * What a live device session is actually doing, right now.
 *
 * Latency is transient and invisible after the fact, so the numbers have to be
 * readable AT THE MOMENT it feels slow, from the user's own device, without a
 * build and without a second person. Same reasoning and shape as the voice
 * path's `__pucaVoiceDiag`.
 *
 * The field that usually answers "why does it feel behind" is
 * `jitterBufferMs`: the browser's own buffer, which defaults to a value tuned
 * for watching video rather than pointing at things. `decodeMsPerFrame` is the
 * next suspect — a phone software-decoding an oversized composite shows up
 * there and nowhere else.
 */
/**
 * The same numbers, measured across a WINDOW of real use.
 *
 * The one-shot reading above is taken at the worst possible moment: to reach
 * the button the user must stop dragging, and a still desktop deliberately
 * stops producing frames (the pump re-sends the last picture instead), so
 * `framesPerSecond` collapses to near zero for reasons that have nothing to
 * do with the complaint. Two field captures both showed 3fps alongside
 * `inputSentPerSecond: 0` — the instrument was reporting the pause, not the
 * problem.
 *
 * This samples the cumulative counters twice and reports the DELTAS, so the
 * caller can keep using the stage across the window and get the frame rate,
 * bandwidth and freezes that actually occurred while they were driving.
 */
export async function deviceDiagnosticsWindow(ms = 5_000): Promise<Record<string, unknown>[]> {
    const raw = async () => {
        const out = new Map<string, { frames: number; bytes: number; freezes: number; decodeS: number; at: number }>();
        for (const s of sessions.values()) {
            if (s.role !== 'controller' || !s.pc) continue;
            try {
                const stats = await s.pc.getStats();
                stats.forEach(r => {
                    if (r.type !== 'inbound-rtp' || r.kind !== 'video') return;
                    out.set(s.id, {
                        frames: Number(r.framesDecoded) || 0,
                        bytes: Number(r.bytesReceived) || 0,
                        freezes: Number(r.freezeCount) || 0,
                        decodeS: Number(r.totalDecodeTime) || 0,
                        at: Date.now(),
                    });
                });
            } catch { /* a session without stats simply has no window row */ }
        }
        return out;
    };

    const before = await raw();
    await new Promise(r => setTimeout(r, ms));
    const after = await raw();
    const rows = await deviceDiagnostics();

    return rows.map(row => {
        const id = String(row.id);
        const a = before.get(id);
        const b = after.get(id);
        if (!a || !b) return row;
        const secs = (b.at - a.at) / 1000;
        if (secs <= 0) return row;
        const frames = b.frames - a.frames;
        return {
            ...row,
            windowSeconds: Math.round(secs * 10) / 10,
            // What the user actually experienced while driving.
            windowFps: Math.round((frames / secs) * 10) / 10,
            windowKbps: Math.round(((b.bytes - a.bytes) * 8) / 1000 / secs),
            windowFreezes: b.freezes - a.freezes,
            windowDecodeMsPerFrame: frames > 0
                ? Math.round(((b.decodeS - a.decodeS) / frames) * 1000 * 10) / 10
                : null,
        };
    });
}

export async function deviceDiagnostics(): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    for (const s of sessions.values()) {
        if (s.role !== 'controller') continue;
        const row: Record<string, unknown> = {
            id: s.id,
            peer: s.peerDevice,
            phase: s.phase,
            monitor: s.activeMonitor,
            captureSize: s.captureSize,
            inputSentPerSecond: s.inputRate.rate(),
            // THE CARET PATH, in one line each. `caretChannel: 'open'` with
            // `caretCapable: false` is the whole old-agent story: the SCTP
            // stream opened and nothing ever came back, so the stage is running
            // on its pointer fallback. This row is reachable from the phone
            // through MouseMenu's "Copy diagnostics", which is the only console
            // a signed release APK has.
            caretChannel: s.caretChannel ? s.caretChannel.readyState : null,
            caretTracking: s.caretTracking,
            caretCapable: s.caretCapable,
            caretReports: s.caretReports,
            caretDropped: { malformed: s.caretDroppedMalformed },
            caretLast: s.caretLast
                ? {
                    vis: s.caretLast.r.vis,
                    x: s.caretLast.r.x, y: s.caretLast.r.y, h: s.caretLast.r.h,
                    src: s.caretLast.r.src, mon: s.caretLast.r.mon, surf: s.caretLast.r.surf,
                    ageMs: Date.now() - s.caretLast.at,
                }
                : null,
        };
        try {
            const stats = await s.pc?.getStats();
            // WHICH PATH the media is actually taking. The single most
            // valuable field here and it was missing: "3 fps with freezes"
            // reads completely differently over a TURN relay (bandwidth
            // starvation — coturn caps an allocation at 1.25 MB/s) than over
            // a direct LAN link (decode or keyframe stalling). Without it the
            // two are indistinguishable from the numbers alone.
            stats?.forEach(r => {
                if (r.type === 'transport' && r.selectedCandidatePairId) {
                    const pair = stats.get(r.selectedCandidatePairId as string);
                    if (!pair) return;
                    const local = stats.get(pair.localCandidateId as string);
                    const remote = stats.get(pair.remoteCandidateId as string);
                    row.path = local?.candidateType === 'relay' || remote?.candidateType === 'relay'
                        ? 'RELAY (via TURN)'
                        : `direct (${local?.candidateType ?? '?'}/${remote?.candidateType ?? '?'})`;
                    row.rttMs = typeof pair.currentRoundTripTime === 'number'
                        ? Math.round(pair.currentRoundTripTime * 1000)
                        : null;
                    row.availableIncomingKbps = typeof pair.availableIncomingBitrate === 'number'
                        ? Math.round(pair.availableIncomingBitrate / 1000)
                        : null;
                }
            });
            stats?.forEach(r => {
                if (r.type !== 'inbound-rtp' || r.kind !== 'video') return;
                // Loss and recovery traffic: an infinite-GOP stream that keeps
                // losing packets stalls until the next IDR, which shows up as
                // freezes and a frame rate far under target while every other
                // number looks healthy.
                row.packetsLost = r.packetsLost ?? null;
                row.packetsReceived = r.packetsReceived ?? null;
                row.pliCount = r.pliCount ?? null;
                row.nackCount = r.nackCount ?? null;
                row.keyFramesDecoded = r.keyFramesDecoded ?? null;
                row.receivedKbps = typeof r.bytesReceived === 'number'
                    ? Math.round((r.bytesReceived * 8) / 1000)
                    : null;
                const emitted = Number(r.jitterBufferEmittedCount) || 0;
                const delay = Number(r.jitterBufferDelay) || 0;
                const decoded = Number(r.framesDecoded) || 0;
                row.jitterBufferMs = emitted > 0 ? Math.round((delay / emitted) * 1000) : null;
                row.decodeMsPerFrame = decoded > 0
                    ? Math.round(((Number(r.totalDecodeTime) || 0) / decoded) * 1000 * 10) / 10
                    : null;
                row.framesDecoded = decoded;
                row.framesPerSecond = r.framesPerSecond ?? null;
                row.freezeCount = r.freezeCount ?? null;
                row.frameSize = r.frameWidth ? `${r.frameWidth}x${r.frameHeight}` : null;
            });
        } catch {
            row.stats = 'unavailable';
        }
        out.push(row);
    }
    return out;
}

if (typeof window !== 'undefined') {
    (window as unknown as Record<string, unknown>).__pucaDeviceDiag =
        () => deviceDiagnostics();
}

export function endSession(sessionId: string, reason = 'ended'): void {
    const s = sessions.get(sessionId);
    // DELIBERATE: this is only reached from a control the user pressed.
    if (s) teardown(s, reason, true, true);
}

export function endAllSessions(reason = 'signed out'): void {
    // Also deliberate — signing out, or a test resetting state. Neither is a
    // failure worth reporting back to whoever signed out.
    [...sessions.values()].forEach(s => teardown(s, reason, true, true));
}

function attachPc(s: Internal, pc: RTCPeerConnection): void {
    s.pc = pc;
    pc.onicecandidate = e => {
        // Sealed like everything else: a rewritten candidate list steers the
        // media through a relay of the server's choosing.
        if (e.candidate) void sendSignal(s, { kind: 'ice', candidate: e.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') {
            // Recovered — a running 'disconnected' countdown is stale.
            if (s.pcDisconnectTimer) {
                clearTimeout(s.pcDisconnectTimer);
                s.pcDisconnectTimer = null;
            }
            return;
        }
        if (pc.connectionState === 'disconnected') {
            // Bounded, not instant: 'disconnected' self-heals after a routing
            // blip, and the browser's own escalation to 'failed' can take
            // minutes it spends showing a frozen frame over a session whose
            // corpse then refuses the next connect. While OUR transport is
            // down the grace owns the verdict (as for 'failed' below), so the
            // watchdog only runs when the socket is fine and the media path
            // alone died — the ungraceful-host-drop case.
            // Neither when OUR transport is down (the local grace owns the
            // verdict) nor when the PEER's is (DevicePeerReconnecting — the
            // server's 60s grace owns THAT verdict, and a 15s local timer
            // would overrule it and end sessions the peer was seconds from
            // reclaiming).
            if (!s.transportDown && !s.peerReconnecting) armPcDisconnectWatchdog(s, pc);
            return;
        }
        if (pc.connectionState === 'failed') {
            // While OUR transport is down — the phone backgrounded and the
            // socket dropped — the media path failing is a CONSEQUENCE, not
            // news, and tearing down here bypassed the whole transport grace:
            // the session died the instant the app thawed, before reattach
            // could even be tried. The grace owns the verdict; a session that
            // reattaches onto a dead pc is ended honestly there instead.
            if (s.transportDown) return;
            s.error = 'could not connect to the device';
            teardown(s, s.error, true);
        }
    };
    pc.ontrack = e => {
        s.stream = e.streams[0] ?? new MediaStream([e.track]);
        // Chromium fires ontrack at NEGOTIATION — the answer arriving — not
        // at first media (the controller creates its own recvonly
        // transceiver, and Chrome non-compliantly fires ontrack for it
        // anyway). Clearing the wait-for-video deadline here meant a host
        // whose screens never produced a frame (asleep, and before 0.8.44
        // nothing woke them) hung a BLACK stage forever with no message on
        // every Chromium controller. Only proven media clears it: a track
        // already unmuted, or the unmute that marks the first RTP packet.
        if (!e.track.muted) {
            markMediaArrived(s);
        } else {
            // This may be the SAME track buildControllerPc already put a
            // handler on (Chrome fires ontrack for local transceivers), and
            // this assignment replaces it — which is safe only because both
            // point at the same function. Keep it that way.
            e.track.onunmute = () => markMediaArrived(s);
        }
        emit();
    };

    // Port forwarding rides its OWN data channel, negotiated here so both roles
    // agree on it without a further round trip. Creating the channel does NOT
    // enable forwarding: the host still has to arm a policy (see tunnel.ts
    // armHost), and until it does, an Open from the peer finds no host half and
    // is ignored. A channel with nothing armed simply carries nothing.
    //
    // The controller creates it; the host receives it via ondatachannel. Both
    // then hand it to the same relay.
    if (s.role === 'controller') {
        try {
            const dc = pc.createDataChannel('tunnel', { ordered: true });
            void attachTunnelChannel(s.id, dc);
        } catch {
            // A peer connection that refuses a data channel still supports
            // screen and input; forwarding is the optional extra, so this must
            // not take the session down.
        }
    } else {
        pc.ondatachannel = e => {
            if (e.channel.label === 'tunnel') {
                void attachTunnelChannel(s.id, e.channel);
            } else if (e.channel.label === 'files') {
                // The controller always creates this channel; on a JS-pc host
                // it lands here. Serving it is gated PER REQUEST on the scope
                // granted through serveFileAccessRequest — an unanswered or
                // revoked grant makes every request an error, never a file.
                void attachFilesToHost(s, e.channel);
            }
        };
    }
}

/** Wire the phone-side file server onto the controller's `files` channel.
 *
 *  Dynamic imports so no Capacitor module loads on platforms that never host
 *  files; a backend without `getGrantedRoot` (the desktop webview) leaves the
 *  channel unserved, exactly as before this existed — its file requests are
 *  refused by serveFileAccessRequest's missing-setFileAccess throw instead. */
async function attachFilesToHost(s: Internal, dc: RTCDataChannel): Promise<void> {
    try {
        const { isMobile } = await import('../platform');
        if (!isMobile()) return;
        const { getGrantedRoot, capacitorFsProvider } = await import('./hostCapacitor');
        const { attachFilesServer } = await import('./hostFsServer');
        attachFilesServer(dc, () => getGrantedRoot(s.id), capacitorFsProvider());
    } catch (e) {
        console.warn('[device-session] files server unavailable:', e);
    }
}

/** Queue a candidate for later, with a ceiling.
 *
 *  An armed host holds the offer for as long as someone takes to type a
 *  passphrase, and the peer trickles throughout — so this list is fed by the
 *  network on a timer the peer controls. A real browser emits a handful of
 *  candidates; 128 is far above that and far below anything that matters, and
 *  it matches the cap the agent already applies to its own queue. Dropping the
 *  overflow is right: the useful candidates arrive first, by ICE priority.
 */
function queueIce(s: Internal, c: RTCIceCandidateInit): void {
    if (s.pendingIce.length >= 128) return;
    s.pendingIce.push(c);
}

async function applyPendingIce(s: Internal): Promise<void> {
    const queued = s.pendingIce.splice(0);
    for (const c of queued) {
        try { await s.pc?.addIceCandidate(c); } catch { /* a stale candidate is not fatal */ }
    }
}

// --- Controller side --------------------------------------------------------

/**
 * Follow a machine from its sign-in screen to its signed-in desktop.
 *
 * Called when the host ended the session with `HANDOVER_REASON` — somebody
 * signed in, so the sign-in-screen agent stood down and the picture now lives
 * on that machine's OTHER device row, the desktop app's. Before this, the
 * session just went quiet: the user typed their PIN, Windows unlocked, and
 * the phone froze until they reconnected by hand.
 *
 * The wait itself lives in `wakeSession.followToDesktop`, beside the wake
 * wait it is a twin of: reported on the machine's card with a countdown and
 * a Stop button, two minutes long. The first version of this was a silent
 * ten-second loop here, which was fine for unlocking a running desktop and
 * gave up — with no message — inside the first cold sign-in after a boot,
 * where the app has to start from nothing. Imported lazily: wakeSession
 * imports `connectToDevice` from this file, and a static import back would
 * make the two modules a cycle.
 */
function followMachineToDesktop(signInRowId: string): void {
    const userId = currentUserId();
    if (userId == null) return;
    void import('./wakeSession')
        .then(m => m.followToDesktop(signInRowId, userId))
        .catch(() => { /* the user is back at the list and can reconnect */ });
}

/** The mirror: after a Lock we asked for, follow the machine to its sign-in
 *  screen row (see `LOCK_HANDOVER_REASON` and wakeSession.followToSignIn). */
function followMachineToSignIn(appRowId: string): void {
    const userId = currentUserId();
    if (userId == null) return;
    void import('./wakeSession')
        .then(m => m.followToSignIn(appRowId, userId))
        .catch(() => { /* the user is back at the list and can reconnect */ });
}

/**
 * Ask to control one of your own devices.
 *
 * `proof` is opaque to the server and verified by the HOST: it carries this
 * controller's device id so the host can look up the grant it signed.
 */
export async function connectToDevice(
    hostDevice: string,
    opts?: {
        filesOnly?: boolean;
        /** Present when connecting to a FRIEND's device under an accepted
         *  share. The host verifies everything independently; this side uses
         *  it to resolve and verify the host's key (a foreign device is not
         *  in this account's device list) and to hide what the share does
         *  not allow. */
        share?: {
            inviteId: number;
            ownerUser: number;
            ownerUsername: string;
            capabilities: string[];
        };
    },
): Promise<string> {
    const myDevice = thisDeviceId();
    if (!myDevice) throw new Error('this device has not enrolled yet');
    if (hostDevice === myDevice) throw new Error('a device cannot control itself');

    const id = newId();
    const s: Internal = {
        filesOnly: opts?.filesOnly === true,
        share: opts?.share
            ? {
                inviteId: opts.share.inviteId,
                peerUser: opts.share.ownerUser,
                peerUsername: opts.share.ownerUsername,
                capabilities: opts.share.capabilities,
            }
            : null,
        hostArmed: false, shareUser: null, viewOnly: false,
        id, role: 'controller', peerDevice: hostDevice, phase: 'connecting',
        hostCaptureless: false,
        stream: null, captureSize: null, error: null,
        pc: null, eph: generateControlEphemeral(), key: null,
        sendSeq: 0, recvSeq: -1, sendSigSeq: 0, recvSigSeq: -1, sigQueue: new SerialQueue(), recvSigQueue: new SerialQueue(), inQueue: new SerialQueue(), recvInQueue: new SerialQueue(), injectQueue: new SerialQueue(), sendCoalescer: null, recvCoalescer: null, inputRate: new RateCounter(), pendingIce: [], preKeyFrames: [], hostStream: null,
        agentOwnsTransport: false, agentStreamStarted: false, agentStreamQualityQueried: false, uaVerified: false, uaRequired: false, uaCache: null, reconnecting: false, transportDown: false, peerReconnecting: false, transportGraceTimer: null, connectTimer: null, pendingCursorOwner: null, pcDisconnectTimer: null, pendingOffer: null, mediaTimer: null, awaitingMedia: false, awaitingUaPassphrase: false, monitor: null, monitorDefaulted: false, monitors: [], activeMonitor: null,
        lastInputAt: 0, liveness: null, mediaRestarting: false, mediaRestartAt: null, streamDiedAt: 0,
        filesChannel: null,
        inputChannel: null, inputProved: false, inputDcSeq: 0,
        caretChannel: null, caretTracking: false, caretCapable: false,
        caretReports: 0, caretDroppedMalformed: 0, caretLast: null, unattended: false,
        fileRoot: null,
        fileScopeKind: null,
        fileAccessRevoked: false,
        pendingFileRequest: false,
        privacyActive: false,
        cursorOwned: false,
        secureDesktop: false,
        secureDesktopSince: null,
        secureDesktopSent: null,
        cursorClipped: false,
        cursorClippedSent: null,
        powerNotice: null, pendingPowerAckTimer: null, powerNoticeTimer: null,
    };
    sessions.set(id, s);
    emit();

    // FAIL FAST when the transport is down: wsClient.send below is a silent
    // no-op on a closed socket, and a DeviceConnect that was never sent has
    // no answer coming — without this the session sat in 'connecting'
    // forever, wearing the stage. BEFORE the supersede loop, deliberately: a
    // prior session to this host may be sitting in its transport grace,
    // seconds from reattaching, and a tap that cannot connect anything must
    // not destroy the session it cannot replace.
    if (!wsClient.isConnected) {
        teardown(s, 'not connected to the server — check your connection and try again', false);
        return id;
    }

    // ONE session per host — the server enforces it — so a lingering local
    // session OF THE SAME KIND to this host (a frozen stage over a dead media
    // path, an attempt still 'connecting') would get this connect refused as
    // "already handling a session". The user asking to connect again IS the
    // verdict on that old session: end it, telling the server, and in-order
    // delivery on the same socket frees the slot before the DeviceConnect
    // below arrives. A session of the OTHER kind is left alone: pressing
    // Files must not silently kill a live Control session (or vice versa) —
    // the server refuses the new connect with a reason the stage shows,
    // which is the long-standing, explained behaviour.
    for (const old of [...sessions.values()]) {
        if (old.role === 'controller' && old.peerDevice === hostDevice && old.phase !== 'ended'
            && old.id !== id && old.filesOnly === s.filesOnly) {
            teardown(old, 'replaced by a new connection to that device', true, true);
        }
    }
    armConnectDeadline(s);

    wsClient.send({
        type: 'DeviceConnect',
        payload: {
            host_device: hostDevice,
            session_id: id,
            eph: s.eph.pubEncoded,
            proof: JSON.stringify({ v: 1, ctl: myDevice }),
        },
    });
    return id;
}

/**
 * Send one input event to the host.
 *
 * Sealed under the session key with a monotonic sequence inside the payload, so
 * the relay cannot read, forge or replay it. Silently drops when there is no
 * key — never falls back to plaintext. Returns whether the event was QUEUED,
 * so a one-shot control (Ctrl+Alt+Del, a chord from a menu) can say "not
 * connected" instead of claiming it sent a frame that never left this device;
 * the pointer/keyboard paths ignore the value, as they always have.
 */
export function sendInput(sessionId: string, event: unknown): boolean {
    const s = sessions.get(sessionId);
    if (!s || s.role !== 'controller' || s.phase !== 'active' || !s.key) return false;
    // A view-only share sends no input. The host and the server both drop it
    // anyway; not sending is what keeps the liveness ladder honest too — a
    // lastInputAt stamped for input that can never be injected would read as
    // "driving with no frames back" and restart a perfectly healthy stream.
    if (s.share && !s.share.capabilities.includes('control')) return false;
    // While the socket is down (a backgrounded phone), sealing and "sending"
    // just burns sequence numbers into a void — wsClient.send drops silently
    // below OPEN. The reattach handler restores flow; input typed meanwhile
    // is better lost now than replayed as a burst of stale motion later.
    if (s.transportDown) return false;
    // The liveness ladder's gate. Stamped for every event that will actually
    // be sent — including held motion — because "the user is driving and no
    // frames are coming back" is the one signal that separates a dead media
    // path from a legitimately still desktop.
    s.lastInputAt = Date.now();
    sendCoalescer(s).push(event);
    return true;
}

/** Above this many unsent bytes on the socket, MOTION is HELD in the
 *  coalescer (still superseding/summing) rather than queued onto a stalled
 *  socket. Held, never dropped: the first version DROPPED it in the emit
 *  callback, which binned the positioning move a click depends on — the
 *  exact click-teleport the coalescer's ordering rule exists to prevent.
 *  State events (down/up/key/wheel) always pass. */
const WS_MOTION_HIGH_WATER_BYTES = 64 * 1024;

/** The send-side coalescer for a session, created on first use. */
function sendCoalescer(s: Internal): InputCoalescer {
    if (!s.sendCoalescer) {
        // Emitting onto the SAME serial queue the direct path uses is what
        // keeps a timer-driven move from overtaking the click that flushed it:
        // flush() emits move-then-click synchronously, and the queue preserves
        // that order across the async seal.
        s.sendCoalescer = new InputCoalescer(
            event => { void sealAndSendInput(s, event); },
            undefined,
            () => wsClient.bufferedAmount() <= WS_MOTION_HIGH_WATER_BYTES,
        );
    }
    return s.sendCoalescer;
}

/**
 * Seal one input event and put it on the wire, ONE AT A TIME.
 *
 * The counter is read INSIDE the queue, which is the whole point. It used to be
 * incremented synchronously and then sealed asynchronously, so two overlapping
 * calls took s=0 and s=1 and raced through WebCrypto — and if s=1 sealed first
 * it went out first, whereupon the receiver's strictly-increasing check DROPPED
 * the perfectly legitimate s=0 as a replay. At pointer-event rates overlapping
 * seals are not a corner case, they are the steady state, so input was being
 * quietly thrown away and felt like stutter.
 *
 * This is the same fix, and the same helper, that `sendSignal` already uses for
 * signalling — where the comment ends "a guard that leaves its mirror image
 * open is not a guard". Both mirrors are closed here too: the receive side is
 * serialised in the DeviceInputted handler.
 */
async function sealAndSendInput(s: Internal, event: unknown): Promise<boolean> {
    return await s.inQueue.run(async () => {
        if (!s.key) return false;
        // P2P FIRST (R4): straight to the agent when its channel is open,
        // else the relay — which stays the permanent fallback and the only
        // path that always exists (a webview host has no agent at all). The
        // transport picks the SEQUENCE NAMESPACE with it.
        const dc = s.inputChannel;
        // PROVED, not merely open — see `inputProved`. This is the one line
        // that decides whether input reaches the machine at all against a
        // host that opens the channel and ignores it.
        const viaDc = !!dc && dc.readyState === 'open' && s.inputProved;
        try {
            if (viaDc) {
                const sealed = await sealControl(
                    s.key, JSON.stringify({ s: s.inputDcSeq, e: event }),
                );
                try {
                    dc!.send(JSON.stringify({ sid: s.id, payload: sealed }));
                    s.inputDcSeq++;
                    s.inputRate.tick();
                    return true;
                } catch {
                    // The channel died between the check and the send: fall
                    // through to the relay rather than dropping the event —
                    // but RE-SEAL for it. The frame just built carries the
                    // CHANNEL's sequence number, and replaying that onto the
                    // relay (whose counter is separate and behind) would be
                    // refused by the host as stale. The DC's number is not
                    // consumed, so its namespace stays gap-free.
                    //
                    // AND STAY ON THE RELAY for the rest of the session. Two
                    // transports carrying one input stream have no relative
                    // ordering: a `down` still travelling the slow path
                    // (relay → service → pipe) while an `up` takes the direct
                    // channel lands INVERTED, and an inverted pair leaves a
                    // mouse button held down on the far machine. One
                    // transport at a time; a fallback is one-way.
                    s.inputChannel = null;
                    s.inputProved = false;
                }
            }
            const relaySealed = await sealControl(
                s.key, JSON.stringify({ s: s.sendSeq++, e: event }),
            );
            s.inputRate.tick();
            wsClient.send({ type: 'DeviceInput', payload: { session_id: s.id, event: relaySealed } });
            return true;
        } catch {
            // A crypto failure must not degrade to sending plaintext.
            return false;
        }
    });
}

/**
 * Push this device's clipboard to the device being controlled.
 *
 * Explicit, one-shot, user-initiated — never an automatic mirror. Password
 * managers put secrets on the clipboard, so a session that silently synced
 * every change would stream them to the other machine.
 *
 * Returns why it failed, or null on success, so the caller can say something
 * useful instead of a silent no-op.
 */
export async function sendClipboard(sessionId: string): Promise<string | null> {
    const s = sessions.get(sessionId);
    if (!s || s.phase !== 'active' || !s.key) return 'the session is not connected';
    // Same guard as sendInput: below OPEN wsClient.send drops silently, and
    // this used to report "Clipboard sent" for a frame that went nowhere.
    if (s.transportDown) return 'this device is reconnecting — try again in a moment';

    const read = await readLocalClipboardDetailed();
    if (!read.ok) {
        return read.why === 'unsupported'
            ? 'this app build cannot read the clipboard — update the app'
            : "could not read this device's clipboard";
    }
    const text = read.text;
    if (!text) return 'your clipboard is empty';

    const event = buildClipboardEvent(text);
    if (!event) return `that is too much text to send (the limit is about ${Math.floor(MAX_CLIPBOARD_BYTES / 1000)} KB)`;

    // Only a controller may push, for the same reason input is one-way: a
    // compromised host must not be able to write into its controller's
    // clipboard, which is a paste away from being executed.
    if (s.role !== 'controller') return 'only the controlling device can send its clipboard';
    // A view-only share: the host drops the clip with the rest of the input
    // (its share gate sits in front of the clipboard arm), so sending it and
    // saying "Clipboard sent" — which this did — was a lie.
    if (s.share && !s.share.capabilities.includes('control')) return 'this share is view-only — the clipboard cannot be sent';

    // Through the SAME queue as input: it shares `sendSeq`, so sealing it
    // outside would race the input path and burn a sequence number out of
    // order — which the receiver drops, silently, taking the clipboard with it.
    //
    // The OUTCOME comes back rather than an exception: the queued send swallows
    // its own errors (it must never fall back to plaintext), so a `try/catch`
    // here would report success for a clipboard that was never sent.
    return (await sealAndSendInput(s, event))
        ? null
        : 'could not encrypt the clipboard for that device';
}

// `updateSessionQuality` lived here: a second way to send `update-stream` that
// skipped the debounce, the pending-quality state and the 5s failure timer.
// Both UI call sites used it, so those three things were unreachable and the
// quality UI had no way to report a refusal. Use `sendStreamQuality` — one
// path, in kbps, that tracks what it asked for.

// --- Wiring -----------------------------------------------------------------

let installed = false;

/**
 * Register the session handlers. Idempotent, and registered at startup so a
 * request that arrives before any UI has mounted is still answered.
 */
/**
 * The UNSOLICITED-lock handover.
 *
 * The controller-initiated Lock button already hands the session to the
 * machine's sign-in-screen row (the `power` arm sends `LOCK_HANDOVER_REASON`).
 * A lock the operator did NOT ask for — an idle timeout, someone pressing
 * Win+L at the machine, a fast-user-switch — never went through that path, so
 * the session just froze: the `secureDesktop` banner explains why, but the
 * picture is gone until someone unlocks. This makes an unsolicited lock do what
 * the button does, so a locked machine follows itself to its sign-in screen and
 * the operator can type their PIN remotely.
 *
 * WHY THE LOCK EVENT AND NOT THE `secureDesktop` FLAG. That flag is raised for
 * ANY secure desktop, a UAC prompt included — and a UAC prompt has no sign-in
 * row to follow to (the machine is still signed in). A UAC prompt does not
 * raise `WTS_SESSION_LOCK`; a real lock does. So the Windows lock event
 * (session_events.rs -> `system-suspend-or-lock` reason "lock") is the only
 * signal that means "locked" rather than "some secure screen is up", which is
 * exactly the distinction this handover needs.
 *
 * GATED ON ENROLMENT, and that gate is the whole difference from the manual
 * button. The button is a deliberate act, so ending the session is its expected
 * cost even on a machine with nowhere to follow to. An unsolicited lock is not
 * a request to end anything: on a machine that is NOT enrolled for sign-in-
 * screen access there is no row to move to, and tearing down would trade
 * today's freeze-and-resume — the picture comes back by itself on unlock — for
 * a session that ended on its own. So a non-enrolled machine keeps exactly
 * today's behaviour; only an enrolled one gains the follow.
 *
 * Exported for the listener wiring below and for its test.
 */
let consoleLockBusy = false;
export async function handleConsoleLock(): Promise<void> {
    if (consoleLockBusy) return;
    const live = [...sessions.values()].filter(
        // OWN host sessions only. A share grantee cannot follow to THIS
        // machine's sign-in row — it is the owner's, and the controller-side
        // LOCK_HANDOVER branch just ends a share with "reconnect once
        // unlocked". So handing over a share session would trade its
        // freeze-and-resume for an ended session and give the friend nothing;
        // leaving it frozen is strictly friendlier. filesOnly has no screen a
        // lock can take, so it is untouched too.
        s => s.role === 'host' && s.phase === 'active' && !s.filesOnly && !s.share,
    );
    if (live.length === 0) return;
    consoleLockBusy = true;
    try {
        // Queried per lock (they are rare) rather than cached: enrolment can be
        // turned on or off between one lock and the next, and a stale "enrolled"
        // would hand a session to a row that no longer exists.
        let enrolled = false;
        try {
            const { unattendedAccessState } = await import('./lockScreen');
            enrolled = (await unattendedAccessState()).enrolled;
        } catch {
            // Could not read it — leave the freeze-and-resume path alone rather
            // than end a session on a guess.
            return;
        }
        if (!enrolled) return;
        for (const s of live) {
            // Re-check under the await: a session can end while the state query
            // is in flight, and teardown keys everything by id — acting on a
            // stale object would reach into whoever holds that id now.
            if (sessions.get(s.id) !== s || s.phase === 'ended') continue;
            // Exactly the manual Lock button's handover. Idempotent with it:
            // when the operator used the button, its own 1.5s timeout may also
            // fire this, and whichever lands first wins — the other finds the
            // session already ended.
            teardown(s, LOCK_HANDOVER_REASON, true, true);
        }
    } finally {
        consoleLockBusy = false;
    }
}

export function installDeviceSessions(): void {
    if (installed) return;
    installed = true;

    // The mid-session picture watchdog. Lives HERE rather than in the stage
    // component for the same reason the transport grace does: the session
    // machinery must not depend on which UI happens to be mounted, and the
    // stage's own stall watchdog is deliberately dormant outside a
    // foreground-return window. 1Hz, no-ops in a tick with no active
    // controller session (getStats is only read for eligible ones).
    setInterval(() => { void pollMediaLiveness(); }, 1_000);

    // The HOST half of the same watchdog, and it lives here for the same
    // reason: a UAC prompt can steal the display with no Devices UI mounted on
    // this machine at all — the person is at the OTHER end.
    setInterval(() => { void pollSecureDesktop(); }, 1_000);

    // The controller's locked-follow fallback (see pollLockedFollow). 5s, and
    // it exits on the first line unless a session is actually sitting on a
    // secure-desktop banner, so the idle cost is a filter over the (tiny)
    // session map.
    setInterval(() => { void pollLockedFollow(); }, 5_000);

    // The unsolicited-lock handover. Windows-only (the event fires nowhere
    // else); a non-Tauri or older shell simply never calls it, and the
    // secureDesktop banner still explains a lock — it just will not auto-follow.
    void (async () => {
        try {
            const { isTauri } = await import('../platform');
            if (!isTauri()) return;
            const { listen } = await import('@tauri-apps/api/event');
            await listen('system-suspend-or-lock', (e: { payload?: { reason?: string } }) => {
                // ONLY "lock". A "suspend" is the machine going to sleep, not a
                // sign-in screen coming up; its return is the wake path's job.
                if (e?.payload?.reason === 'lock') void handleConsoleLock();
            });
            // The unlock twin (session_events.rs UNLOCK_EVENT, pinned by a
            // test there). Purely a latency nudge: the poll below already
            // runs at 1 Hz and is edge-triggered + busy-guarded, so calling
            // it out of band is free — but it is the difference between the
            // controller's secure-desktop banner clearing the instant the
            // PIN lands and clearing on the next tick.
            await listen('system-session-unlock', () => {
                void pollSecureDesktop();
            });
        } catch {
            // Not Tauri, or the event API is unavailable.
        }
    })();

    // The tray's "Stop file access". Wired HERE, not in a component: the whole
    // point is that it works on a machine with no window open, which is also the
    // machine most likely to be sharing files unattended.
    void (async () => {
        try {
            const { isTauri } = await import('../platform');
            if (!isTauri()) return;
            const { listen } = await import('@tauri-apps/api/event');
            await listen('sovereign://revoke-file-access', () => {
                const n = revokeAllFileAccess();
                console.info(`[device-session] tray revoked file access on ${n} session(s)`);
            });
        } catch {
            // Not Tauri, or the event API is unavailable. The grant still ends
            // with the session either way.
        }
    })();

    // --- host side: someone wants to control this machine ---
    wsClient.on('DeviceConnectRequested', (msg: { payload?: { session_id?: string; from_device?: string; eph?: string; proof?: string; from_user?: number; from_username?: string; capabilities?: string[] } }) => {
        void (async () => {
            const p = msg?.payload;
            if (!p?.session_id || !p.from_device || !p.eph) return;
            const refuse = (reason: string) => wsClient.send({
                type: 'DeviceConnectResponse',
                payload: { session_id: p.session_id, accepted: false, reason },
            });

            const backend = await getHostBackend();
            const caps = await backend.capabilities();
            // Refuse early only when this host can serve NEITHER a screen nor
            // files. Whether the controller wants files-only is not knowable
            // yet — it arrives in the sealed offer — so a files-capable,
            // capture-less host (a phone) accepts here and the offer handler
            // below tears down a screen request with the limitation named.
            if (!caps.capture && !caps.files) {
                refuse(caps.limitation ?? 'this device cannot be controlled');
                return;
            }
            // One at a time. A second concurrent controller on one machine is
            // not a feature, it is two people fighting over a mouse.
            if ([...sessions.values()].some(x => x.role === 'host' && x.phase !== 'ended')) {
                refuse('that device is already in a session');
                return;
            }

            // The session id comes from the SERVER, and the guard above only
            // looks at HOST sessions. A colliding id would replace a live
            // CONTROLLER session in the map, orphaning an object that still owns
            // a peer connection, a capture and forwarded sockets — and whose
            // later teardown would then evict whoever holds the id by then.
            if (sessions.has(p.session_id)) {
                refuse('session id already in use');
                return;
            }

            const s: Internal = {
                // Learned from the offer, not guessed here: the controller is
                // the side that knows what it opened the session for.
                filesOnly: false,
                hostCaptureless: !caps.capture,
                // Set below only after the share verification chain passes;
                // the public shareUser/viewOnly are derived from it in emit().
                share: null, hostArmed: false, shareUser: null, viewOnly: false,
                id: p.session_id, role: 'host', peerDevice: p.from_device, phase: 'connecting',
                stream: null, captureSize: null, error: null,
                pc: null, eph: generateControlEphemeral(), key: null,
                sendSeq: 0, recvSeq: -1, sendSigSeq: 0, recvSigSeq: -1, sigQueue: new SerialQueue(), recvSigQueue: new SerialQueue(), inQueue: new SerialQueue(), recvInQueue: new SerialQueue(), injectQueue: new SerialQueue(), sendCoalescer: null, recvCoalescer: null, inputRate: new RateCounter(), pendingIce: [], preKeyFrames: [], hostStream: null,
                agentOwnsTransport: false, agentStreamStarted: false, agentStreamQualityQueried: false, uaVerified: false, uaRequired: false, uaCache: null, reconnecting: false, transportDown: false, peerReconnecting: false, transportGraceTimer: null, connectTimer: null, pendingCursorOwner: null, pcDisconnectTimer: null, pendingOffer: null, mediaTimer: null, awaitingMedia: false, awaitingUaPassphrase: false, monitor: null, monitorDefaulted: false, monitors: [], activeMonitor: null,
                lastInputAt: 0, liveness: null, mediaRestarting: false, mediaRestartAt: null, streamDiedAt: 0,
                filesChannel: null,
                inputChannel: null, inputProved: false, inputDcSeq: 0,
        caretChannel: null, caretTracking: false, caretCapable: false,
                caretReports: 0, caretDroppedMalformed: 0, caretLast: null, unattended: false,
                fileRoot: null,
        fileScopeKind: null,
        fileAccessRevoked: false,
        pendingFileRequest: false,
                privacyActive: false,
                cursorOwned: false,
                secureDesktop: false,
                secureDesktopSince: null,
                secureDesktopSent: null,
                cursorClipped: false,
                cursorClippedSent: null,
                powerNotice: null, pendingPowerAckTimer: null, powerNoticeTimer: null,
            };
            sessions.set(s.id, s);
            emit();

            // The controller's device PUBLIC key is needed for the static half.
            // Phase 3 keeps the plumbing honest by refusing rather than
            // guessing: without it there is no authenticated key agreement.
            //
            // `from_user` present means the SERVER routed this under a device
            // share. It is a routing hint, not an authorization: everything is
            // re-verified here — the share row, this host's OWN grant
            // signature over exactly those capabilities, the grantee's pinned
            // account signing key, and the connecting device's enrolment
            // record under it. Any miss refuses. (A server stamping from_user
            // onto a same-account request just fails this chain — no share
            // row — and a server OMITTING it on a real cross-user connect
            // sends us down the same-account path, where a foreign device is
            // not in this account's list and key resolution fails. Closed
            // both ways.)
            let peerPub: string | null = null;
            const fromUser = typeof p.from_user === 'number' ? p.from_user : null;
            if (fromUser != null) {
                const myDevice = thisDeviceId();
                const { currentUserId } = await import('./index');
                const myUser = currentUserId();
                if (!myDevice || myUser == null || fromUser === myUser) {
                    refuse('no active share allows that device');
                    teardown(s, 'share verification failed', false);
                    return;
                }
                const { shareForGrantee, shareAuthorises, verifiedSharePeerDevice } =
                    await import('./shares');
                const invite = await shareForGrantee(myDevice, fromUser);
                if (!invite?.grant_record || !invite.grant_sig) {
                    refuse('no active share allows that device');
                    teardown(s, 'share verification failed', false);
                    return;
                }
                const { ensureDeviceKey } = await import('../deviceIdentity/deviceKey');
                const { verifyWithAccountKey } = await import('../e2ee');
                const myKeys = await ensureDeviceKey();
                const grantOk = await shareAuthorises(
                    { grant_record: invite.grant_record, grant_sig: invite.grant_sig },
                    {
                        hostDevice: myDevice,
                        ownerUser: myUser,
                        granteeUser: fromUser,
                        capabilities: invite.capabilities,
                    },
                    (record, sig) => verifyWithAccountKey(myKeys.sign_pub, record, sig),
                );
                if (!grantOk) {
                    refuse('no active share allows that device');
                    teardown(s, 'share verification failed', false);
                    return;
                }
                const peerRow = await verifiedSharePeerDevice(invite.id, p.from_device, fromUser);
                if (!peerRow) {
                    refuse('could not verify that device');
                    teardown(s, 'share verification failed', false);
                    return;
                }
                peerPub = peerRow.device_pub;
                s.share = {
                    inviteId: invite.id,
                    peerUser: fromUser,
                    // Server-stamped from the controller's authenticated
                    // claims; a missing field on an old server renders as a
                    // generic label, never as something the peer chose.
                    peerUsername: p.from_username ?? 'a friend',
                    capabilities: invite.capabilities,
                };
            } else {
                const { deviceStaticPubFor } = await import('./peerKeys');
                peerPub = await deviceStaticPubFor(p.from_device);
            }
            if (!peerPub || !(await establishKey(s, peerPub, p.eph))) {
                refuse('could not agree a key with that device');
                teardown(s, 'key agreement failed', false);
                return;
            }

            // Decide NOW — before capture starts and before the session goes
            // active — whether this machine will demand proof.
            //
            // The 0.8.1 gate set uaRequired AFTER `phase = 'active'`, across an
            // await into a Tauri IPC. For the length of that IPC the gate read
            // `false && ...` and every capability was open. Deciding here removes
            // the window instead of narrowing it.

            // Ask the person sitting at THIS machine. `fromUsername` names a
            // friend connecting under a share; absent, the same-account copy
            // renders. Returns false on decline/timeout — the caller refuses.
            const askPersonHere = async (
                fromUsername?: string,
                shareCaps?: string[],
            ): Promise<boolean> => {
                // Only the AGENT can honour a screen choice. The webview
                // host re-opens getDisplayMedia, which asks again in its own
                // picker — so offering a selector here would have the user
                // choose a screen twice and the first choice count for
                // nothing. Empty list => the prompt shows no selector.
                const monitors = backend.kind === 'agent'
                    ? await backend.listMonitors().catch(() => [])
                    : [];
                // BRING THE WINDOW UP FIRST — but SURFACE it, don't steal
                // focus.
                //
                // The deployment this whole release exists for is autostart
                // + --hidden + close-to-tray, where the webview keeps running
                // (so the dialog renders and the handler is registered) but
                // nobody can see it. Without this the prompt is answered by
                // no one, the host never replies, and the controller sits on
                // "Waiting for the device's screen…". "surface" makes the
                // hidden window visible on top WITHOUT activating it: the
                // old raise:true was a forced foreground steal that tabbed
                // a borderless-windowed game out on every connect request.
                // requestHostConsent already auto-denies on its own
                // deadline, so an unseen prompt still resolves.
                try {
                    const { invoke } = await import('@tauri-apps/api/core');
                    await invoke('attention_main_window', { mode: 'surface' });
                } catch { /* not Tauri, or the window is already up */ }
                void (async () => {
                    try {
                        const { isPermissionGranted, sendNotification } =
                            await import('@tauri-apps/plugin-notification');
                        if (await isPermissionGranted()) {
                            sendNotification({
                                title: fromUsername
                                    ? `${fromUsername} wants to connect to this screen`
                                    : 'A device wants to connect to this screen',
                                body: 'Switch to Puca to allow or deny.',
                            });
                        }
                    } catch { /* notification is best-effort */ }
                })();
                const { requestHostConsent } = await import('./hostConsent');
                const consent = await requestHostConsent(
                    s.peerDevice,
                    monitors.map((m, i) => ({ id: m.id ?? i, label: m.label ?? `Screen ${i + 1}` })),
                    fromUsername,
                    shareCaps,
                );
                // Prompt answered (or its deadline fired): stop sitting on
                // top of whatever the person at this machine is doing.
                void import('@tauri-apps/api/core')
                    .then(({ invoke }) => invoke('release_attention_topmost'))
                    .catch(() => { /* not Tauri / older build */ });
                if (!consent) return false;
                s.monitor = consent.monitor;
                return true;
            };

            let challenge: { nonce: string; salt: string } | null = null;
            try {
                if (s.share) {
                    // A SHARE session never issues the unattended challenge.
                    // The passphrase is the OWNER's secret — demanding it of a
                    // friend would mean sharing it, which grants far more than
                    // any single share does. The verified, host-signed,
                    // instantly-revocable grant IS the standing authorization
                    // here; on an ARMED machine that means walk-up access with
                    // no prompt (the point of "permanent"), and on an UNARMED
                    // machine the person sitting at it still gets asked, by
                    // name, exactly like any other attended connect.
                    const { armed } = await unattendedState();
                    s.hostArmed = armed;
                    if (!armed && !s.hostCaptureless) {
                        if (!(await askPersonHere(s.share.peerUsername, s.share.capabilities))) {
                            refuse('the person at that device declined');
                            teardown(s, 'declined', false);
                            return;
                        }
                    }
                } else {
                    challenge = await issueUaChallenge();
                    if (challenge) s.uaRequired = true;
                    // NOT armed => ask the person sitting here.
                    //
                    // Until 0.8.4 the browser's screen picker was doing this by
                    // accident: somebody had to click Share. The agent captures
                    // with no prompt at all, so without this an unarmed machine
                    // would silently start streaming to any device on the
                    // account.
                    //
                    // Armed machines deliberately do NOT prompt — that is what
                    // unattended means, and the passphrase is the gate.
                    //
                    // A CAPTURE-LESS host (a phone) skips the SCREEN consent
                    // too: there is no screen to consent to, and accepting
                    // exposes nothing by itself — no capture, no input, and
                    // file access still behind serveFileAccessRequest's own
                    // prompt, which IS this host's consent moment.
                    if (!challenge && !s.hostCaptureless) {
                        if (!(await askPersonHere())) {
                            refuse('the person at that device declined');
                            teardown(s, 'declined', false);
                            return;
                        }
                    }
                }
            } catch {
                if (s.share) {
                    // Could not even determine this machine's armed state —
                    // for a cross-user session nothing may proceed on a guess.
                    refuse('could not verify this share');
                    teardown(s, 'could not verify this share', false);
                    return;
                }
                // Failing to CHALLENGE must not fail open. If this machine is
                // armed and we cannot ask, refuse rather than serve it
                // unauthenticated.
                const { armed } = await unattendedState();
                if (armed) {
                    refuse('could not verify unattended access');
                    teardown(s, 'could not verify unattended access', false);
                    return;
                }
            }

            // Wake this machine's displays before the capture starts. A panel
            // in DPMS-off presents nothing (DXGI duplicates it "successfully"
            // and no frame ever comes; getDisplayMedia is no better), so the
            // controller of a sleeping machine got a black stage forever.
            // Synthetic input is the wake — two opposite 1px deltas net to
            // zero. Placed HERE and not in answerOffer, deliberately: this
            // point is past the consent dialog (or the standing consent of an
            // armed host), so an unapproved connect request can never light
            // the target's screen; and it is fire-and-forget, so it adds no
            // await between any guard and start_stream. The agent backend
            // also wakes itself (display_wake.rs); this covers the webview
            // host, where no native wake exists.
            if (!s.filesOnly) {
                void (async () => {
                    try {
                        const { invoke } = await import('@tauri-apps/api/core');
                        await invoke('inject_input', { event: { t: 'rmove', dx: 1, dy: 0 } });
                        await invoke('inject_input', { event: { t: 'rmove', dx: -1, dy: 0 } });
                    } catch { /* not a Tauri host — nothing to wake with */ }
                })();
            }
            // EVERY SCREEN BY DEFAULT. `s.monitor` is still null here whenever
            // nobody chose a screen — an armed host, which never prompts — and
            // null resolved to output 0 all the way down (`monitor ?? 0` in
            // agentAnswerOffer), so a three-monitor machine opened on one
            // screen with no hint that the others existed until the viewer
            // found the switcher. The composite is the honest default: it
            // shows what the machine has, and on a phone the zoom-follows-
            // monitor feature takes the viewer to a single screen at native
            // resolution the moment they zoom into one. Only the AGENT can
            // capture the composite (composite.rs); the webview host's source
            // is whatever getDisplayMedia was answered with, and a phone host
            // has no screen at all. A one-screen machine stays on its one
            // screen, where 255 would be a pointless rebuild path.
            //
            // FROM `caps`, ALREADY FETCHED — never a fresh `listMonitors()`
            // call here. This first version DID call it, and it was wrong: the
            // agent's IPC pipe is ONE connection behind ONE mutex, `exchange()`
            // blocks on a plain `read_line` with NO read timeout anywhere in
            // agent_ipc.rs, and every request — this one included — therefore
            // queues behind whatever the agent is doing (a slow display-wake,
            // a previous session's teardown, or worse, a genuinely wedged
            // agent, which then wedges EVERY later request on the same stuck
            // connection, not just this one). That sat squarely inside the
            // controller's 20s CONNECT_DEADLINE_MS, on every single armed
            // connect attempt to a multi-monitor host — exactly the "grey
            // screen, then back to the devices list, then Control does nothing
            // either" report. `capabilities()` above already asked the agent
            // this exact question (`Response::Capabilities.monitors` is a bare
            // count) at zero extra cost; `caps.monitors` is that count,
            // reshaped to an array by `describeMonitors`'s no-geometry
            // fallback. Its `.length` is all this decision needs.
            if (s.monitor === null && backend.kind === 'agent' && !s.filesOnly && caps.monitors.length > 1) {
                s.monitor = ALL_DISPLAYS;
                s.monitorDefaulted = true;
            }
            try {
                const transport = await backend.startSession({
                    sessionId: s.id,
                    controllerDevice: p.from_device,
                    sessionKey: new Uint8Array(),
                    monitor: s.monitor,
                });
                if (transport.kind === 'webview-pc') {
                    s.hostStream = transport.stream;
                    s.captureSize = { w: transport.width, h: transport.height };
                } else if (transport.kind === 'agent-pc') {
                    // The AGENT owns the peer connection. This side must not
                    // build one: two connections answering the same offer would
                    // both send, and the controller would render whichever won.
                    s.agentOwnsTransport = true;
                }
                // 'data-pc' (a phone hosting files): neither — answerOffer
                // builds the JS pc, publishes no tracks, and acks data-only.
            } catch (e) {
                refuse(e instanceof Error ? e.message : 'this device cannot host yet');
                teardown(s, 'host backend refused', false);
                return;
            }

            wsClient.send({
                type: 'DeviceConnectResponse',
                payload: {
                    session_id: s.id, accepted: true, eph: s.eph.pubEncoded,
                    cap_w: s.captureSize?.w, cap_h: s.captureSize?.h,
                },
            });
            // Three awaits sit between the session being created and here
            // (peer key lookup, backend.startSession, issueUaChallenge). Any of
            // them can be outlived by a teardown — the peer ending it, the
            // socket closing, the user cancelling. Setting 'active' regardless
            // would resurrect a dead session and arm a stray deadline timer
            // against it.
            if (s.phase === 'ended' || sessions.get(s.id) !== s) {
                // Teardown ran while startSession was in flight, so it saw
                // s.hostStream === null and had nothing to stop. The capture it
                // could not see is ours to clean up, or the screen stays
                // captured with no session and no way to reach it.
                s.hostStream?.getTracks().forEach(t => t.stop());
                s.hostStream = null;
                if (sessions.get(s.id) === s) {
                    void getHostBackend().then(b => b.stopSession(s.id)).catch(() => { });
                }
                return;
            }
            s.phase = 'active';
            emit();

            // Ask for the proof, over the same sealed signal channel the SDP
            // uses. uaRequired is already true by now, so nothing is reachable
            // in the gap between going active and this send.
            // Tell the controller what it can switch between. Sealed like every
            // other signal, so the relay learns nothing about this machine's
            // display layout.
            //
            // NOT on an armed host until the passphrase is proved: the labels are
            // this machine's display names, and a controller that has not yet
            // authenticated has no business reading them. Released with the held
            // offer instead, on the same event.
            if (!(s.uaRequired && !s.uaVerified)) void announceMonitors(s);

            if (challenge) {
                // Silence must not be a way through. Without a deadline an
                // attacker simply never answers and keeps the session.
                setTimeout(() => {
                    if (s.uaRequired && !s.uaVerified && s.phase !== 'ended') {
                        teardown(s, 'unattended passphrase not provided', true);
                    }
                }, UA_RESPONSE_DEADLINE_MS);
                await sendSignal(s, {
                    kind: 'ua-challenge',
                    nonce: challenge.nonce,
                    salt: challenge.salt,
                });
            }
        })();
    });

    // --- controller side: the host answered ---
    wsClient.on('DeviceConnectAnswered', (msg: { payload?: { session_id?: string; accepted?: boolean; eph?: string; reason?: string; cap_w?: number; cap_h?: number } }) => {
        void (async () => {
            const p = msg?.payload;
            const s = p?.session_id ? sessions.get(p.session_id) : null;
            if (!s || s.role !== 'controller') return;
            // Answered — accepted or not — is what the connect deadline was
            // waiting to hear; from here the media deadline owns the clock.
            clearConnectDeadline(s);

            try {
                if (!p?.accepted || !p.eph) {
                    // Same trust boundary as DeviceEnded: the host wrote this
                    // and the server relayed it, and it is now rendered.
                    s.error = (p?.reason ?? 'the device refused').slice(0, MAX_REASON_LEN);
                    teardown(s, s.error, false);
                    return;
                }
                // A shared host is a FOREIGN device: it is not in this
                // account's list, so its key resolves through the share's
                // narrow lookup and verifies against the OWNER's pinned
                // account signing key instead. Both paths fail closed on null.
                let peerPub: string | null;
                if (s.share) {
                    const { verifiedSharePeerDevice } = await import('./shares');
                    const row = await verifiedSharePeerDevice(
                        s.share.inviteId, s.peerDevice, s.share.peerUser,
                    );
                    peerPub = row?.device_pub ?? null;
                } else {
                    const { deviceStaticPubFor } = await import('./peerKeys');
                    peerPub = await deviceStaticPubFor(s.peerDevice);
                }
                if (!peerPub || !(await establishKey(s, peerPub, p.eph))) {
                    s.error = 'could not agree a key with that device';
                    teardown(s, s.error, true);
                    return;
                }
                if (p.cap_w && p.cap_h) s.captureSize = { w: p.cap_w, h: p.cap_h };

                // The receive side — files channel, recvonly transceiver, the
                // WKWebView eager-attach dance — is shared with restartMedia;
                // the whys live on buildControllerPc.
                const pc = await buildControllerPc(s);
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                await sendSignal(s, { kind: 'offer', sdp: offer.sdp, filesOnly: s.filesOnly });
                s.phase = 'active';
                // Any cursor-ownership request the stage made while this was
                // still connecting goes out now that it can.
                flushPendingCursorOwner(s);
                // From here the user is looking at "Waiting for the device's
                // screen…". If nothing arrives, say why rather than waiting
                // forever. Unconditional: armMediaDeadline itself declines for a
                // file-only session, so both callers get that for free.
                armMediaDeadline(s);
                if (s.filesOnly) {
                    // Ask for file access straight away. On an armed host this is
                    // answered without a prompt, so the round trip is the only
                    // thing between opening this and seeing a listing; making the
                    // user press "Ask to browse files" first would be asking them
                    // to request the thing they just clicked a button to get.
                    void sendSignal(s, { kind: 'file-access-request' }).catch(() => undefined);
                }
                emit();
            } catch (e) {
                console.error('[device-session] DeviceConnectAnswered failed:', e);
                teardown(s, `Connection failed: ${e instanceof Error ? e.message : String(e)}`, true);
            }
        })();
    });

    // --- both sides: WebRTC signalling ---
    wsClient.on('DeviceSignalled', (msg: { payload?: { session_id?: string; payload?: string } }) => {
        const p = msg?.payload;
        const s = p?.session_id ? sessions.get(p.session_id) : null;
        if (!s || !p?.payload) return;
        const blob = p.payload;
        // ONE FRAME AT A TIME, in arrival order.
        //
        // The listener is dispatched synchronously per WebSocket message, so
        // without this each frame races the others through crypto.subtle and the
        // replay check runs in whatever order the decrypts happen to finish.
        // Before the counter existed an out-of-order frame was harmless — that
        // is exactly what pendingIce is for — so this queue is what keeps the
        // counter from turning a tolerated reorder into a dead session.
        void s.recvSigQueue.run(async () => {
            // NO KEY YET means the peer got its key before we got ours, not
            // that the frame is junk. Hold it — establishKey replays it.
            if (!s.key) {
                bufferPreKeyFrame(s, blob);
                return;
            }
            await handleSignalFrame(s, blob);
        });
    });

    // --- host side: an input event arrived ---
    wsClient.on('DeviceInputted', (msg: { payload?: { session_id?: string; event?: string } }) => {
        const p = msg?.payload;
        const s = p?.session_id ? sessions.get(p.session_id) : null;
        if (!s || !p?.event) return;
        const event = p.event;
        // ONE AT A TIME, in arrival order — the mirror of the send queue.
        //
        // The WebSocket delivers these in order, but each was handed to
        // WebCrypto on its own promise chain, so the strictly-increasing check
        // below ran in DECRYPT-COMPLETION order. A small move decrypting faster
        // than the one before it retired the counter past it, and the earlier
        // event was then dropped as a replay — input silently lost, which is
        // felt as stutter rather than seen as an error.
        void s.recvInQueue.run(async () => {
            // Only a HOST injects, only while active, only with a key. Any of
            // these missing means drop — never inject unauthenticated input.
            if (s.role !== 'host' || s.phase !== 'active' || !s.key) return;

            // AND, on an armed machine, only after the unattended passphrase has
            // actually been proved.
            //
            // This line was missing in 0.8.0. The challenge was issued, the
            // response verified, and `uaVerified` set — but nothing ever read it,
            // so ignoring the challenge entirely was a complete bypass. A secret
            // that is checked and then not consulted is worse than no secret,
            // because it is advertised as protection.
            if (s.uaRequired && !s.uaVerified) return;

            // A share without 'control' takes NO input. Enforced here as well
            // as at the server relay: the server gates DeviceInput frames, but
            // any input path that does not cross that relay (a P2P data
            // channel) still ends at this injector — the host is the last and
            // authoritative gate on what touches its own desktop.
            if (s.share && !s.share.capabilities.includes('control')) return;

            // AUTHORISED input is what resets the inactivity clock — below
            // every gate above, so a peer that is being refused cannot keep an
            // abandoned unattended session alive by hammering the channel.
            noteControlActivity(s.id);

            // A CAPTURE-LESS HOST TAKES NO INPUT OF ANY KIND — including the
            // clipboard, which is neither capture nor input and therefore sits
            // outside every other guard here.
            //
            // Such a host (a phone) skips the screen-consent dialog on the way
            // to 'active', because there is no screen to consent to and file
            // access has its own prompt. That reasoning holds ONLY if nothing
            // else is reachable from an accepted-but-unprompted session — and
            // clipboard writes were: any enrolled device could silently
            // overwrite the phone's clipboard with no dialog, no banner and
            // nothing on screen. The backend refuses injection anyway
            // (capabilities().input is false); this refuses it before the
            // sealed payload is even opened, so the skip's promise is true by
            // construction rather than by the backend's good manners.
            if (s.hostCaptureless) return;

            let opened: string | null;
            try { opened = await openControl(s.key, event); } catch { return; }
            if (!opened) return;

            let obj: { s?: number; e?: unknown };
            try { obj = JSON.parse(opened); } catch { return; }
            // Strictly increasing sequence: an intra-session replay or reorder
            // is dropped rather than injected twice.
            if (typeof obj.s !== 'number' || !Number.isInteger(obj.s) || obj.s <= s.recvSeq) return;
            s.recvSeq = obj.s;

            // Clipboard events share the sealed channel but are NOT input.
            // Handing one to the injector would try to parse it as a mouse or
            // key event; handling it here keeps the injector's contract narrow.
            if (isClipboardEvent(obj.e)) {
                await writeLocalClipboard(obj.e.data);
                return;
            }

            // Coalesce AGAIN on this side. The network delivers whatever
            // survived the controller's own coalescing, and each event past
            // here costs a blocking round trip to the agent under a
            // process-global lock — so a burst that arrives together must
            // collapse before it reaches that pipe, not after.
            if (!s.recvCoalescer) {
                s.recvCoalescer = new InputCoalescer(ev => {
                    // Onto the INJECT queue — not back onto recvInQueue. On
                    // one queue, every decrypt waited out the previous
                    // event's whole backend round trip; two serial stages
                    // pipeline instead. Order still holds: emits happen in
                    // seq order (the decrypt stage is serial and a flush is
                    // synchronous inside it), and this queue preserves it —
                    // a timer-driven flush still cannot overtake the click
                    // that flushed it, because both land here in order.
                    void s.injectQueue.run(async () => {
                        // The session may have ended between enqueue and here
                        // — teardown releases every held key, and an inject
                        // draining afterwards would re-stick the very key the
                        // release just lifted.
                        if (sessions.get(s.id) !== s || s.phase === 'ended') return;
                        try {
                            const backend = await getHostBackend();
                            await backend.injectEvent(s.id, JSON.stringify(ev));
                        } catch (e) {
                            // An injection failure must not tear the session
                            // down; the user can still see the screen and end
                            // it themselves. ONE failure shape is news though:
                            // the agent answering "no such capture session"
                            // means it reaped the stream out from under a live
                            // session (encoder fatal, capture fatal) — the
                            // agent never pushes, so an inject error is the
                            // only way this side ever learns. Tell the
                            // controller once; it restarts the media or ends
                            // the session honestly instead of wearing a frozen
                            // frame with input still landing.
                            const msg = e instanceof Error ? e.message : String(e);
                            if (/no such capture session/i.test(msg)
                                && Date.now() - s.streamDiedAt > STREAM_DIED_RESEND_MS) {
                                s.streamDiedAt = Date.now();
                                void sendSignal(s, { kind: 'stream-died' }).catch(() => undefined);
                            }
                            // Ctrl+Alt+Del is the one input the user presses
                            // ONCE and expects a visible answer to. It can only
                            // be raised by the Puca system service, so a
                            // refusal ("service not installed", "policy not
                            // set") must reach the controller — silently
                            // dropping it is how this control shipped for
                            // months as a no-op that reported success.
                            if ((ev as { t?: unknown })?.t === 'sas') {
                                void sendSignal(s, {
                                    kind: 'input-failed',
                                    t: 'sas',
                                    reason: msg.slice(0, MAX_REASON_LEN),
                                }).catch(() => undefined);
                            }
                        }
                    });
                });
            }
            s.recvCoalescer.push(obj.e);
        });
    });

    // --- either side: it ended ---
    wsClient.on('DeviceEnded', (msg: { payload?: { session_id?: string; reason?: string } }) => {
        const p = msg?.payload;
        const s = p?.session_id ? sessions.get(p.session_id) : null;
        if (!s) return;

        // SOMEBODY SIGNED IN AT THAT MACHINE — this is a handover, not a
        // failure. The sign-in-screen service stops the instant the console is
        // unlocked (by design; the desktop app owns the screen from then on),
        // so the picture has not gone away, it has MOVED to the other device
        // row of the same machine. Reconnecting there is what the user would
        // do by hand, and used to have to: before the service sent this
        // reason, the session simply went quiet and the phone sat frozen.
        if (p?.reason === HANDOVER_REASON && s.role === 'controller') {
            const host = s.peerDevice;
            teardown(s, 'the console was unlocked', false, true);
            followMachineToDesktop(host);
            return;
        }
        // WE ASKED THAT MACHINE TO LOCK, AND IT DID — the mirror handover: the
        // desktop app can no longer show the (secure) desktop, so follow the
        // machine to its sign-in-screen row, where the SYSTEM service is now
        // the host. Not a failure, not a red banner.
        if (p?.reason === LOCK_HANDOVER_REASON && s.role === 'controller') {
            // A SHARE grantee cannot follow: the owner's machine is not in
            // their device list, and its sign-in-screen row is the owner's to
            // reach. Say so — the first version tore down deliberately (no
            // banner) and then gave up silently in the follow, so the friend
            // who tapped Lock watched the stage vanish with no explanation.
            if (s.share) {
                teardown(s, 'that machine is now locked — reconnect once it is unlocked', false);
                return;
            }
            const host = s.peerDevice;
            teardown(s, 'the console was locked', false, true);
            followMachineToSignIn(host);
            return;
        }
        // TRUNCATED: this string is chosen by the peer and RELAYED BY THE
        // SERVER, and it is now rendered in the app's own chrome. A reason is a
        // sentence; anything longer is not one, and there is no length this
        // side can otherwise rely on.
        const reason = (p?.reason ?? 'the session ended').slice(0, MAX_REASON_LEN);
        // The peer hanging up normally is not a failure to report. A reason it
        // took the trouble to send IS worth showing — that is how "the person
        // at that device declined" and "unattended passphrase rejected" reach
        // the person who needs them.
        const deliberate = !p?.reason || reason === 'the session ended';
        s.error = deliberate ? null : reason;
        teardown(s, reason, false, deliberate);
    });

    // Our own reattach after a socket drop succeeded: our half of the relay
    // is whole, so stop the countdown. Whether to stop saying "reconnecting"
    // is the SERVER's call via peer_connected — when both sides dropped
    // together, the DevicePeerReconnecting notice went to our dead conn, so
    // this ack is the first we hear that the peer is still gone; trusting our
    // own stale peerReconnecting here cleared the banner over a session whose
    // other half was down, and every tap went silently into the void.
    wsClient.on('DeviceReattached', (msg: { payload?: { session_id?: string; peer_connected?: boolean } }) => {
        const s = msg?.payload?.session_id ? sessions.get(msg.payload.session_id) : null;
        if (!s) {
            // The server just rebound a session this device no longer holds —
            // the local half died while the reattach claim was in flight (a
            // thawed grace timer, a teardown whose DeviceEnd could not send).
            // Left alone that orphan sits Active on a live conn, reprieved
            // indefinitely, refusing every new connect to its host. It is
            // bound to THIS device, so this device gets to end it.
            const sid = msg?.payload?.session_id;
            if (sid) {
                wsClient.send({
                    type: 'DeviceEnd',
                    payload: { session_id: sid, reason: 'this device no longer holds that session' },
                });
            }
            return;
        }
        if (!s.transportDown) return;
        if (s.transportGraceTimer) {
            clearTimeout(s.transportGraceTimer);
            s.transportGraceTimer = null;
        }
        s.transportDown = false;
        // The relay is whole again — but if the pc died while the transport
        // was down (its 'failed' was deliberately ignored then; see
        // attachPc), this session is signalling wrapped around a dead
        // transport. WebRTC does not come back from 'failed' by itself, the
        // host's end was reaped with it, and there is no renegotiation path —
        // so end it honestly rather than leave a live-looking corpse. This
        // includes files-only sessions: they carry no MEDIA, but the files
        // data channel rides the same pc, so a dead pc is a file browser
        // whose every click errors under a session that claims to be fine
        // (and whose keep-alive pins the foreground service meanwhile).
        const pcDead = s.pc && (s.pc.connectionState === 'failed' || s.pc.connectionState === 'closed');
        if (pcDead) {
            s.error = 'the connection did not survive the time in the background — reconnect to the device';
            teardown(s, s.error, true);
            return;
        }
        // 'disconnected' is not dead yet — but if the transition happened
        // while transportDown swallowed it, nothing armed the watchdog, and
        // no further statechange will fire for a state that has not changed.
        // Give the reattached session the same bounded countdown as a fresh
        // one instead of waiting out the browser's minutes-long escalation.
        if (s.pc && s.pc.connectionState === 'disconnected') {
            armPcDisconnectWatchdog(s, s.pc);
        }
        s.peerReconnecting = msg.payload?.peer_connected === false;
        s.reconnecting = s.peerReconnecting;
        // The pc survived the background but the DECODER may not have — with
        // the agent's infinite GOP that is a still image until an IDR
        // arrives. The visibility-triggered request often fires while the
        // socket is still reconnecting (wsClient.send drops below OPEN), so
        // THIS is the reliable trigger: the relay is provably whole again.
        // The shared rate limit inside requestKeyframe makes overlap with
        // the visibility trigger cost nothing. (When the PEER is still
        // detached the request is suppressed un-stamped — the server would
        // drop it silently — and DevicePeerReconnected below retries it.)
        if (s.role === 'controller' && !s.filesOnly) {
            requestKeyframe(s.id);
            // The stage's stall watchdog only measures inside a window, and
            // its foreground window has usually expired by the time the
            // reattach lands — reopen it so an unanswered request escalates
            // instead of ending the ladder.
            window.dispatchEvent(new CustomEvent('device-media-reattached', { detail: { sessionId: s.id } }));
        }
        emit();
    });

    // The PEER's socket dropped and the server is holding the session for it.
    // Show it, and let the SERVER's grace decide the outcome — its verdict
    // arrives as DevicePeerReconnected or DeviceEnded, so no local timer.
    wsClient.on('DevicePeerReconnecting', (msg: { payload?: { session_id?: string } }) => {
        const s = msg?.payload?.session_id ? sessions.get(msg.payload.session_id) : null;
        if (!s || s.phase !== 'active') return;
        s.peerReconnecting = true;
        s.reconnecting = true;
        emit();
    });

    wsClient.on('DevicePeerReconnected', (msg: { payload?: { session_id?: string } }) => {
        const s = msg?.payload?.session_id ? sessions.get(msg.payload.session_id) : null;
        if (!s || !s.peerReconnecting) return;
        s.peerReconnecting = false;
        s.reconnecting = s.transportDown;
        // Anything that broke WHILE the peer was away was deliberately
        // unwatched: a pc that went 'disconnected' then never armed its 15s
        // countdown (the statechange handler skips it under peerReconnecting)
        // and no further statechange will fire for a state that has not
        // changed. This handler used to clear the banner and re-arm NOTHING —
        // the field-reported forever-freeze. Give the recovered session the
        // same bounded countdown a fresh transition gets, and ask for the
        // IDR the reattach-time request lost to the detached conn.
        if (!s.transportDown && s.pc && s.pc.connectionState === 'disconnected') {
            armPcDisconnectWatchdog(s, s.pc);
        }
        if (s.role === 'controller' && s.phase === 'active' && !s.filesOnly) {
            requestKeyframe(s.id);
            window.dispatchEvent(new CustomEvent('device-media-reattached', { detail: { sessionId: s.id } }));
        }
        emit();
    });

    // The host stopping the share from the OS bar must END the session, not
    // leave the controller clicking into a frozen frame.
    window.addEventListener('device-capture-ended', (e: Event) => {
        const id = (e as CustomEvent<{ sessionId?: string }>).detail?.sessionId;
        const s = id ? sessions.get(id) : null;
        if (s) teardown(s, 'the other device stopped sharing', true);
    });

    // A dropped socket is NOT the end of the session any more. Phones drop
    // their socket the moment the app backgrounds, and tearing everything
    // down here made a brief app switch fatal — the WS layer's own reconnect
    // came back seconds later to nothing. The session is flagged and given
    // TRANSPORT_GRACE_MS to reattach (the server holds its side for the same
    // window). Two duties cannot wait for that: anything a HOST is holding
    // down must release NOW — no relay means no key-up is coming — and a
    // mid-handshake session still dies, exactly as the server treats it.
    //
    // A DELIBERATE close — sign-out, session expiry — still ends everything
    // immediately. The grace exists for a transport that failed under a
    // session the user still wants; a user who signed out wants the opposite,
    // and holding it would keep a host CAPTURING for a minute after its
    // person pressed "log out" (the WebRTC media does not ride the socket
    // that just closed, so nothing else would stop it).
    window.addEventListener('wsClosed', (e: Event) => {
        const deliberate = (e as CustomEvent<{ deliberate?: boolean }>).detail?.deliberate === true;
        for (const s of [...sessions.values()]) {
            if (deliberate || s.phase !== 'active') {
                teardown(s, 'the connection dropped', false);
                continue;
            }
            if (s.role === 'host') {
                void getHostBackend()
                    .then(b => b.releaseInput?.())
                    .catch(() => { /* best effort; teardown releases again */ });
            }
            if (s.transportDown) continue; // already counting down
            s.transportDown = true;
            s.reconnecting = true;
            s.transportGraceTimer = setTimeout(() => {
                s.transportGraceTimer = null;
                // tellPeer TRUE for the race this thawed timer loses: the
                // deviceAttested reattach claim may have already REBOUND this
                // session to the current socket, and a rebound session nobody
                // ends refuses every new connect to its host until the app is
                // force-killed. When the socket is back, this DeviceEnd is
                // from a party conn and lands; when it is still down, the
                // send is a no-op and the socket's own death has marked the
                // session detached server-side — the supersede path covers it.
                teardown(s, 'the connection dropped', true);
            }, TRANSPORT_GRACE_MS);
        }
        emit();
    });

    // Claim held sessions back once the reconnected socket has ATTESTED —
    // not on `wsConnected`. The server matches a reattach against the
    // (user, attested device) recorded on the session and refuses an
    // unattested one, and `wsConnected` fires from `onopen`, before the
    // DeviceChallenge/DeviceAttest exchange has run: sent from there, every
    // claim lost the race and the grace expired as if the feature did not
    // exist. `deviceAttested` fires immediately after DeviceAttest goes out
    // on the SAME socket, and in-order delivery does the rest. The grace
    // timer keeps running until DeviceReattached — a claim that reaches a
    // server which already reaped the session gets DeviceEnded back, and a
    // failed claim must not disarm the countdown.
    window.addEventListener('deviceAttested', () => {
        for (const s of sessions.values()) {
            if (s.transportDown && s.phase === 'active') {
                wsClient.send({ type: 'DeviceReattach', payload: { session_id: s.id } });
            }
        }
    });

    window.addEventListener('wsConnected', () => {
        for (const s of sessions.values()) {
            // No agentStreamStarted here: that flag is only ever set on the
            // HOST, so requiring it on a controller made this whole branch
            // unreachable. An active controller session is the readiness test.
            if (s.role === 'controller' && s.phase === 'active' && !s.agentStreamQualityQueried) {
                s.agentStreamQualityQueried = true;
                void sendSignal(s, { kind: 'query_stream_quality' });
            }
        }
    });
}

/**
 * Arm the host's kill switch (and, for an unattended session, its inactivity
 * revoke) for a session that is now capable of being controlled.
 *
 * CALLED AFTER answerOffer, not at `phase = 'active'`, because `filesOnly` is
 * only known once the offer arrives — arming a file-browsing session would put
 * a kill-switch hook on a session that never touches the screen or the pointer.
 *
 * The hazard here is over-triggering, not under-: the ANY-INPUT half of the
 * guard is read from the user's own setting and is off by default (a stray
 * mouse nudge must not kick out a friend mid-game), so arming this for device
 * sessions respects that default exactly. The hotkey half is always on.
 */
function armHostControlGuard(s: Internal): void {
    if (s.role !== 'host' || s.filesOnly) return;
    // A share that grants no control cannot be driven, so the host is not
    // trapped behind somebody else's pointer and needs no physical escape.
    if (s.share && !s.share.capabilities.includes('control')) return;
    // The idle revoke bounds "armed and forgotten" — an UNATTENDED session,
    // where nobody is at this machine to press Stop. An ATTENDED one had a
    // human consent to it at this keyboard, and cutting that off after half an
    // hour would disconnect a friend who is watching rather than typing.
    armControlGuard(
        s.id,
        (reason, deliberate) => {
            const live = sessions.get(s.id);
            if (live) teardown(live, reason, true, deliberate);
        },
        s.uaRequired ? DEVICE_CONTROL_IDLE_MS : null,
    );
}

/**
 * Act on ONE sealed signal frame.
 *
 * Named rather than inline so a frame held back before the key existed is
 * replayed through exactly this code rather than a second implementation of
 * it. Always invoked on `s.recvSigQueue`, which is what makes the
 * strictly-increasing counter in `openSignal` safe.
 */
/**
 * Answer a controller's request to browse this machine's files.
 *
 * Extracted because TWO paths reach it: the signal handler, and the replay that
 * runs once an armed host's passphrase is finally proved. Inlining the second
 * copy is how the two drift apart, and this is the function that decides whether
 * a remote peer gets the disk.
 */
async function serveFileAccessRequest(s: Internal): Promise<void> {
    // Only a HOST answers this - it exposes THIS machine's disk.
    if (s.role !== 'host') return;
    // A share without 'files' refuses BEFORE any other consideration — no
    // prompt, no policy grant, no re-sync of a scope that must not exist.
    if (s.share && !s.share.capabilities.includes('files')) {
        await sendSignal(s, {
            kind: 'file-access-denied',
            reason: 'This share does not allow file browsing.',
        }).catch(() => undefined);
        return;
    }
    // Unproven: HOLD the request instead of dropping it.
    //
    // Dropping it silently was a dead end for the case this feature is for. A
    // file-only session asks for access as soon as it goes active, which on an
    // armed host is BEFORE the controller has answered the challenge - so the
    // request was discarded, nothing replayed it, and the user sat looking at
    // "Ask to browse files" having already asked. Same shape as pendingOffer:
    // held rather than dropped, because the far end cannot know to ask again.
    if (s.uaRequired && !s.uaVerified) {
        s.pendingFileRequest = true;
        return;
    }
    // Same treatment when the agent has no stream yet: the grant is an IPC
    // against the stream that answerOffer's start_stream creates, so granting
    // now gets "no live stream for that session" back and the controller is
    // told the host declined. Held rather than raced, and drained by
    // answerOffer the moment the stream exists — which also makes the grant
    // correct whatever order the offer and the file request arrive in.
    if (s.agentOwnsTransport && !s.agentStreamStarted) {
        s.pendingFileRequest = true;
        return;
    }
    // Already granted: re-send what is in force rather than starting over.
    //
    // A second request is a re-sync (a reconnect, or a controller that lost the
    // reply), not a new decision. Re-running the branch below would show the
    // person at an unarmed machine a second folder dialog for access they had
    // already granted, and a Deny there would revoke something they never meant
    // to touch.
    if (s.fileScopeKind) {
        await sendSignal(s, s.fileScopeKind === 'policy'
            ? { kind: 'file-access-granted', scope: 'policy' }
            : { kind: 'file-access-granted', root: s.fileRoot ?? undefined },
        ).catch(() => undefined);
        return;
    }
    // A withdrawal outlives the next request. Checked HERE, before the armed
    // branch below, because that branch grants without asking anyone - so
    // without this the peer undoes the tray's kill switch by simply asking
    // again, and the person who pressed it is never told.
    if (s.fileAccessRevoked) {
        await sendSignal(s, {
            kind: 'file-access-denied',
            reason: 'The person at that device stopped file sharing for this session.',
        }).catch(() => undefined);
        return;
    }
    try {
        const backend = await getHostBackend();
        if (!backend.setFileAccess) {
            throw new Error('this host cannot share files');
        }
        // AN ARMED HOST DOES NOT PROMPT - and this is where that rule was
        // missing.
        //
        // The same decision was made for the SCREEN in 0.8.4 (see
        // hostConsent.ts): armed means the passphrase is the gate, and there is
        // nobody at the keyboard to answer a dialog, which is the entire point
        // of unattended access. File access never got the other half of that
        // pair, so an armed machine still sat waiting for a human to pick a
        // folder - the one case the feature exists for was the one case it
        // could not serve.
        //
        // THE GATE HERE IS POSITIVE, and it has to be. The guard above is
        // `uaRequired && !uaVerified`, which is right for dropping unproven
        // requests but PASSES for an unarmed host - an unarmed host never sets
        // uaVerified either. So "not blocked" is not "proved", and only the pair
        // `uaRequired && uaVerified` means "proof was demanded AND proof
        // arrived". Reading it the other way round would hand whole-machine,
        // no-prompt access to every UNARMED host on the account.
        // A SHARE session on an armed machine earns the same promptless
        // policy grant: the grant (verified before `s.share` was ever set,
        // 'files' capability checked above) stands in for the passphrase a
        // friend never holds, and armed is the owner's declaration that this
        // machine serves with nobody at the keyboard. An UNARMED host still
        // prompts the person sitting at it, share or not.
        const armedAndProven = (s.uaRequired && s.uaVerified) || (s.share !== null && s.hostArmed);
        if (armedAndProven) {
            await backend.setFileAccess(s.id, { kind: 'policy' });
            s.fileScopeKind = 'policy';
            emit();
            await sendSignal(s, { kind: 'file-access-granted', scope: 'policy' });
            return;
        }

        const { requestFileAccessConsent } = await import('./fileAccessConsent');
        const consent = await requestFileAccessConsent(s.peerDevice);
        if (!consent) {
            await sendSignal(s, { kind: 'file-access-denied' });
            return;
        }
        // Arm the agent BEFORE telling the controller it may browse, or its
        // first listing races the grant and comes back "not allowed".
        await backend.setFileAccess(s.id, { kind: 'folder', root: consent.root });
        s.fileRoot = consent.root;
        s.fileScopeKind = 'folder';
        emit();
        await sendSignal(s, { kind: 'file-access-granted', root: consent.root });
    } catch (e) {
        console.warn('[device-session] file access refused', e);
        await sendSignal(s, { kind: 'file-access-denied' }).catch(() => undefined);
    }
}

/** The host sent something only a VERIFIED controller receives (its monitor
 *  list, an answer, a file grant), so the seed that signed this session's
 *  challenge is known-good: mark it and slide its expiry. A no-op for the
 *  prompt-free unarmed path, where no challenge was ever signed. */
function uaProofAccepted(s: Internal): void {
    if (s.role !== 'controller' || s.uaCache !== 'used') return;
    s.uaCache = 'confirmed';
    confirmUaSeed(s.peerDevice);
}

async function handleSignalFrame(s: Internal, blob: string): Promise<void> {
    // Sealed under the session key, so the server genuinely cannot read
    // or influence any of it — SDP, ICE and the unattended challenge
    // alike. That claim was made here before it was true; it is enforced
    // now by openSignal returning null on anything the peer did not seal.
    const data = (await openSignal(s, blob)) as {
        kind?: string;
        sdp?: string;
        candidate?: RTCIceCandidateInit;
        nonce?: string;
        salt?: string;
        sig?: string;
        monitors?: { id: number; label?: string; left?: number; top?: number; width?: number; height?: number }[];
        monitor?: number;
        active?: number;
        reason?: string;
        fps?: number;
        bitrate?: number;
        bitrate_kbps?: number;
        /** set-privacy / privacy-active */
        enabled?: boolean;
        /** file-access-granted: the folder the host actually shared,
         *  which is not necessarily one the controller suggested. */
        root?: string;
        /** file-access-granted: 'policy' when an ARMED host granted its
         *  unattended scope instead of a folder. There is no path in that case,
         *  so `root` is absent and this is the only thing distinguishing a real
         *  grant from no grant at all. */
        scope?: string;
        /** offer: the controller opened this session to browse files, not to
         *  watch a screen, so the host must answer WITHOUT capturing. */
        filesOnly?: boolean;
        /** answer: the host confirms it answered without capturing. Required
         *  rather than assumed — a host that predates `filesOnly` ignores it and
         *  streams, and the controller cannot tell from the SDP alone. */
        dataOnly?: boolean;
        /** set-cursor-owner / cursor-owner-active: does the CONTROLLER draw
         *  the pointer? Validated with typeof at the ack — this shape is what
         *  the peer sent, not what it promised. */
        owned?: boolean;
        /** restart-offer: re-blank the host as part of starting the new
         *  stream. Rides in the offer because StopStream un-blanks and a
         *  separate set-privacy frame could be lost to the same network event
         *  that caused the restart. */
        privacy?: boolean;
        /** power: the PowerAction spelling — validated at the host, not assumed. */
        action?: string;
        /** power-ack: optional human detail (per-monitor DDC honesty). */
        detail?: string;
        /** input-failed: which input kind the host could not perform (only
         *  'sas' is ever reported — everything else is fire-and-forget). */
        t?: string;
        /** secure-desktop: a Windows security screen took the host's display
         *  (true) or gave it back (false). Validated with typeof at the
         *  handler, like `owned`. */
        up?: boolean;
        /** cursor-clipped: a ClipCursor region on the host is holding the
         *  pointer entirely off the streamed monitor (true), or released it
         *  (false). Validated with typeof at the handler, like `up`. */
        clipped?: boolean;
    } | null;
    if (!data) return;

    try {
        if (data.kind === 'ua-challenge' && data.nonce && data.salt) {
            // Only a CONTROLLER answers a challenge.
            //
            // Without this an armed HOST processes a challenge sent TO
            // it: it prompts its own user for the unattended passphrase,
            // derives with an ATTACKER-CHOSEN salt, signs an
            // ATTACKER-CHOSEN nonce and hands back the signature. That
            // is both a phishing prompt on the victim's screen and a
            // signing oracle over attacker-supplied input.
            if (s.role !== 'controller') return;
            const chalNonce = data.nonce;
            const chalSalt = data.salt;
            // Remembered as a fact about the session, not just acted on:
            // only an ARMED host issues this, and "nobody at that machine
            // chose a screen" is what the stage's every-screen default
            // needs to know. Published once the proof has gone out (below),
            // not here: an emit() before the prompt adds work — the tray
            // indicator's first dynamic import among it — between the
            // challenge and the answer, and the stage only needs the flag by
            // the time the picture arrives, which is several emits later.
            s.unattended = true;
            // CONTROLLER: the host is armed for unattended access and
            // wants proof. Sign with the remembered seed if this device
            // proved it recently; otherwise ask for the passphrase,
            // derive, sign, reply — and remember the SEED (never the
            // passphrase) so the next connect inside the window skips
            // the prompt. Either way the passphrase never leaves this
            // side.
            void (async () => {
                const salt = Uint8Array.from(atob(chalSalt), c => c.charCodeAt(0));
                const nonce = Uint8Array.from(atob(chalNonce), c => c.charCodeAt(0));
                let seed = await rememberedUaSeed(s.peerDevice, chalSalt);
                if (!seed) {
                    // The user is about to be asked for a passphrase, which
                    // takes as long as typing takes. The host's own deadline
                    // bounds that; ours must not fire while they type — and
                    // must not be armed behind our back either, which is
                    // possible now that this can run before the connect
                    // handler has finished setting the session up.
                    s.awaitingUaPassphrase = true;
                    clearMediaDeadline(s);
                    const pass = await requestUnattendedPassphrase(s.peerDevice);
                    s.awaitingUaPassphrase = false;
                    if (pass == null) {
                        teardown(s, 'unattended passphrase not entered', true);
                        return;
                    }
                    // Typing takes as long as it takes, and the session can
                    // have died under the open prompt (the host's own 120s
                    // deadline, a DeviceEnd, the user closing the stage).
                    // Teardown has already run for it then — with uaCache
                    // still null — so a seed remembered PAST this point would
                    // never be judged and never be forgotten. Do nothing.
                    if (s.phase === 'ended' || sessions.get(s.id) !== s) return;
                    seed = deriveUaSeed(pass, salt);
                    // Only the native shells remember: their storage belongs
                    // to the app. In a shared BROWSER a later user of the
                    // same profile could lift the seed, so the webapp asks
                    // every time (see the store's own comment).
                    const { isTauri, isMobile } = await import('../platform');
                    if (isTauri() || isMobile()) {
                        rememberUaSeed(s.peerDevice, chalSalt, seed);
                    }
                }
                // 'used' until the host demonstrably accepts it: teardown
                // forgets a still-'used' seed, so a typo (or a stale cache
                // the host now refuses) costs one failed session, not a
                // wedged prompt-free loop of rejections.
                s.uaCache = 'used';
                const sig = signUaChallengeSeed(seed, s.id, nonce);
                let b = '';
                for (const x of sig) b += String.fromCharCode(x);
                await sendSignal(s, { kind: 'ua-response', nonce: chalNonce, sig: btoa(b) });
                // Proof sent — the screen should follow. Resume the clock
                // so a host that never answers is still reported.
                armMediaDeadline(s);
                // And say so: `unattended` was set when the challenge
                // arrived; this is where it becomes visible to the stage.
                emit();
            })();
            return;
        }
        if (data.kind === 'ua-response' && data.nonce && data.sig) {
            // Only a HOST verifies a response; it is the only side
            // holding a verifier, and reflection must not reach it.
            if (s.role !== 'host') return;
            // Captured before the async closure: TypeScript's narrowing
            // does not survive into it, and a non-null assertion would
            // hide a genuine "the peer omitted a field" case.
            const respNonce = data.nonce;
            const respSig = data.sig;
            // HOST: verify locally. The server is not consulted and
            // cannot influence the outcome — that is the whole point of
            // a passphrase separate from the account.
            void (async () => {
                const ok = await verifyUaResponse(respNonce, s.id, respSig);
                if (!ok) {
                    // The peer is told only that it failed. Which of
                    // "unknown nonce", "expired" or "wrong passphrase"
                    // it was stays here; telling them would build an
                    // oracle.
                    teardown(s, 'unattended passphrase rejected', true);
                    return;
                }
                s.uaVerified = true;
                emit();
                // The screen list was withheld until exactly now — an
                // unauthenticated controller must not read this machine's
                // display names. This is the ONLY place it can be released,
                // and its absence left every armed multi-monitor session
                // with no way to switch screens at all.
                void announceMonitors(s);
                // Release whatever was held back, so proving the
                // passphrase resumes the session rather than leaving the
                // controller on a black tile waiting for a renegotiation
                // it has no reason to start.
                const held = s.pendingOffer;
                s.pendingOffer = null;
                // Only if the session is still alive AND still owns its
                // id. Verification is async, so the session can have been
                // torn down while it ran — by the deadline timer, by the
                // peer, or by the user — and answering then would start a
                // capture and an RTP stream that no session object owns
                // and no teardown path can stop.
                if (held && s.phase === 'active' && sessions.get(s.id) === s) {
                    try { await answerOffer(s, held); } catch (e) {
                        console.warn('[device-session] deferred offer failed:', e);
                        teardown(s, `Deferred offer failed: ${e instanceof Error ? e.message : String(e)}`, true);
                    }
                }
                // A file request held back for the same reason gets the same
                // treatment, and it runs AFTER the held offer, not before.
                // On the agent transport the grant is an IPC against the
                // stream that answerOffer's start_stream creates; replayed
                // first (as it was until v0.8.26) the agent answered "no live
                // stream for that session" and the controller was told the
                // host DECLINED — every time, on exactly the armed no-prompt
                // path this feature exists for. Replayed through
                // serveFileAccessRequest rather than by duplicating the grant
                // logic here: there is one place that decides what file access
                // means, and a second copy of it is how the two drift apart.
                if (s.pendingFileRequest && s.phase === 'active' && sessions.get(s.id) === s) {
                    s.pendingFileRequest = false;
                    void serveFileAccessRequest(s);
                }
            })();
            return;
        }
        if (data.kind === 'monitors' && Array.isArray(data.monitors)) {
            // Only a CONTROLLER consumes this; a host receiving it would
            // be looking at a reflected frame.
            if (s.role !== 'controller') return;
            uaProofAccepted(s);
            s.monitors = data.monitors
                .filter(m => typeof m?.id === 'number')
                .map(m => ({
                    id: m.id,
                    label: String(m.label ?? `Screen ${m.id + 1}`),
                    // Geometry is all-or-nothing per monitor: a partial rect
                    // is useless to the zoom-follow math, so it is dropped
                    // whole rather than half-kept.
                    ...(typeof m.left === 'number' && typeof m.top === 'number'
                        && typeof m.width === 'number' && typeof m.height === 'number'
                        && m.width > 0 && m.height > 0
                        ? { left: m.left, top: m.top, width: m.width, height: m.height }
                        : {}),
                }));
            s.activeMonitor = typeof data.active === 'number' ? data.active : null;
            emit();
            return;
        }
        if (data.kind === 'set-monitor' && typeof data.monitor === 'number') {
            // Only a HOST acts on this — it changes what is captured.
            if (s.role !== 'host') return;
            // Same gate as input and privacy: an armed host does nothing for
            // a controller that never proved the passphrase.
            if (s.uaRequired && !s.uaVerified) return;
            const wanted = data.monitor;
            void (async () => {
                try {
                    const backend = await getHostBackend();
                    await backend.setMonitor(s.id, wanted);
                    s.monitor = wanted;
                    // CONFIRMED, since the agent's switch_monitor_sync:
                    // setMonitor blocks (2s deadline) until the capture
                    // thread has actually swapped to the new monitor, and
                    // a failed rebuild rejects — landing in the catch
                    // below as monitor-failed. This comment previously
                    // (correctly, then) said the ack only meant ACCEPTED;
                    // if the agent's blocking handshake ever changes,
                    // this claim changes with it.
                    //
                    // A switch that succeeds just after the deadline is
                    // reported as success too, not as a failure: the agent
                    // answers CommittedLate for that case precisely so this
                    // side does not tell the viewer a switch failed while the
                    // picture is already showing the new screen.
                    await sendSignal(s, { kind: 'monitor-active', active: wanted });
                } catch (e) {
                    await sendSignal(s, {
                        kind: 'monitor-failed',
                        reason: e instanceof Error ? e.message : 'could not switch screens',
                    });
                }
            })();
            return;
        }
        if (data.kind === 'update-stream') {
            if (s.role !== 'host') return;
            // Same gate as input and privacy: an armed host does nothing for
            // a controller that never proved the passphrase.
            if (s.uaRequired && !s.uaVerified) return;
            void (async () => {
                try {
                    const backend = await getHostBackend();
                    if (!backend.updateStream) {
                        throw new Error('this host cannot change stream quality');
                    }
                    // `data.bitrate` is KILObits; the agent backend is
                    // the only thing that converts to bps, and it does
                    // it once at the IPC boundary.
                    await backend.updateStream(s.id, data.fps as number | undefined, data.bitrate as number | undefined);
                    await sendSignal(s, { kind: 'stream-quality-ack', fps: data.fps, bitrate_kbps: data.bitrate, applied: true });
                } catch (e) {
                    // TELL THE CONTROLLER. Swallowing this into a
                    // console.warn left the requester's pending state
                    // to rot until its 5s timeout, reported as a
                    // generic timeout rather than the real reason —
                    // and on a host that cannot do it at all, every
                    // single change looked like a network problem.
                    console.warn('[device-session] failed to update stream quality', e);
                    const message = e instanceof Error ? e.message : String(e);
                    await sendSignal(s, {
                        kind: 'stream-quality-error',
                        code: /not supported|cannot change/i.test(message)
                            ? 'unsupported'
                            : 'apply_failed',
                    }).catch(() => undefined);
                }
            })();
            return;
        }
        if (data.kind === 'request-keyframe') {
            // Only a HOST acts on this — it pokes THIS machine's encoder.
            if (s.role !== 'host') return;
            // Same gate as input and privacy: an armed host does nothing for
            // a controller that never proved the passphrase.
            if (s.uaRequired && !s.uaVerified) return;
            void (async () => {
                try {
                    const backend = await getHostBackend();
                    // Optional by design: a webview host's browser encoder
                    // answers PLI itself and has no lever to pull here.
                    await backend.requestKeyframe?.(s.id);
                } catch (e) {
                    // No error signal back, deliberately. Silence keeps an
                    // old host indistinguishable from one that cannot do it,
                    // and the controller's evidence of success is frames
                    // arriving — which its stall watchdog already measures.
                    console.warn('[device-session] keyframe request failed', e);
                }
            })();
            return;
        }
        if (data.kind === 'set-privacy') {
            // Only a HOST acts on this — it blanks THIS machine.
            if (s.role !== 'host') return;
            // An armed host must not blank its screen for a peer that
            // never proved the passphrase; same gate as input.
            if (s.uaRequired && !s.uaVerified) return;
            void (async () => {
                const enabled = data.enabled === true;
                try {
                    const backend = await getHostBackend();
                    if (!backend.setPrivacyMode) {
                        throw new Error('this host cannot blank its screen');
                    }
                    await backend.setPrivacyMode(s.id, enabled);
                    await sendSignal(s, { kind: 'privacy-active', enabled });
                } catch (e) {
                    console.warn('[device-session] privacy mode failed', e);
                    await sendSignal(s, {
                        kind: 'privacy-failed',
                        reason: e instanceof Error ? e.message : 'could not change privacy mode',
                    }).catch(() => undefined);
                }
            })();
            return;
        }
        // POWER — lock the console, or shut the machine down. Only a HOST
        // acts (it is THIS machine), behind the same unattended-access gate as
        // input; the controller side confirms shutdown before sending. Both
        // are irreversible from the controller's point of view, so the
        // session is ended with a REASON rather than left to time out:
        //  - shutdown: "the device is shutting down" beats "connection lost";
        //    the DeviceEnd goes out right after the OS call is accepted, so a
        //    refused call still has a live session to report through;
        //  - lock: a user-token host cannot capture the secure desktop, so
        //    the picture MOVES to the sign-in-screen row; LOCK_HANDOVER_REASON
        //    tells the controller to follow it there (mirror of the unlock
        //    handover the service sends).
        if (data.kind === 'power') {
            if (s.role !== 'host') return;
            if (s.uaRequired && !s.uaVerified) return;
            // A share without 'control' may not lock or power off this machine
            // — the same gate as the input injector below, for the same
            // reason: this host is the last and authoritative gate on itself.
            if (s.share && !s.share.capabilities.includes('control')) return;
            const action = data.action === 'lock' || data.action === 'shutdown'
                || (typeof data.action === 'string' && (DISPLAY_POWER_ACTIONS as readonly string[]).includes(data.action))
                ? data.action as PowerAction : null;
            if (!action) return;
            void (async () => {
                try {
                    const backend = await getHostBackend();
                    if (!backend.powerAction) {
                        throw new Error('this host cannot lock or shut down from here');
                    }
                    if (DISPLAY_POWER_ACTIONS.includes(action)) {
                        // Display power: no teardown — the session continues
                        // over dark panels (DXGI keeps serving; whether the
                        // picture freezes is a panel question the controller
                        // can see for itself). ACKED, because the controller
                        // waits 5s to distinguish "done" from "old host
                        // ignored it": success produces no other signal.
                        const detail = await backend.powerAction(action);
                        // The ack goes FIRST for the topology pair: the agent
                        // rebuild below spends up to 5s per stream — the exact
                        // length of the controller's POWER_ACK_TIMEOUT_MS — so
                        // acking after it guaranteed the false "did not
                        // respond" line about an action that succeeded.
                        await sendSignal(s, {
                            kind: 'power-ack', action,
                            ...(typeof detail === 'string' && detail ? { detail } : {}),
                        });
                        if (TOPOLOGY_POWER_ACTIONS.includes(action)) {
                            // The desktop just changed shape under every live
                            // capture: the agent rebuilds (fresh duplication,
                            // fresh composite union, input re-aimed — neither
                            // its per-tick rebuild nor its blockage escalation
                            // covers a topology change unprompted), and only
                            // then is the new screen list announced. An old
                            // agent answers "bad request" to the poke; it
                            // heals slowly instead, and the announce is still
                            // honest.
                            try {
                                await backend.displayTopologyChanged?.();
                            } catch (e) {
                                console.warn('[device-session] topology poke failed (old agent?)', e);
                            }
                            // The session record must follow the agent's own
                            // remap rule: a single monitor that no longer
                            // exists lands on output 0; All Displays stays.
                            // MEMBERSHIP of the announced ids, not the list
                            // LENGTH: the agent's enumeration can have gaps
                            // (an undescribable output is omitted without
                            // renumbering), so an id can be valid past the
                            // length and vice versa.
                            try {
                                const fresh = await backend.listMonitors();
                                if (s.monitor !== null && s.monitor !== ALL_DISPLAYS
                                    && !fresh.some((m, i) => (m.id ?? i) === s.monitor)) {
                                    s.monitor = 0;
                                }
                            } catch { /* the announce below degrades the same way */ }
                            void announceMonitors(s, { evenIfSingle: true });
                        }
                        return;
                    }
                    if (action === 'shutdown') {
                        // The OS call FIRST, the goodbye second. ExitWindowsEx
                        // returns as soon as the shutdown is initiated, and
                        // Windows then asks every window to close — the
                        // DeviceEnd below still leaves ahead of that. Doing it
                        // the other way round (teardown, then the call) meant a
                        // shutdown that FAILED could never be reported: teardown
                        // drops the session key, and sendSignal drops anything
                        // without one — so the controller was told "the device
                        // is shutting down" about a machine that stayed up.
                        await backend.powerAction('shutdown');
                        teardown(s, SHUTDOWN_REASON, true, true);
                        return;
                    }
                    await backend.powerAction('lock');
                    // LockWorkStation returns before the console is actually
                    // locked; give Windows a beat, then hand over. The service
                    // needs the lock to have landed to bring the sign-in row up.
                    setTimeout(() => {
                        if (sessions.get(s.id) === s && s.phase !== 'ended') {
                            teardown(s, LOCK_HANDOVER_REASON, true, true);
                        }
                    }, 1500);
                } catch (e) {
                    console.warn('[device-session] power action failed', e);
                    await sendSignal(s, {
                        kind: 'power-failed',
                        action,
                        reason: e instanceof Error ? e.message : 'the power action failed',
                    }).catch(() => undefined);
                }
            })();
            return;
        }
        // CURSOR OWNERSHIP — the host stops drawing its pointer so the
        // controller can draw one that moves with the finger instead of a
        // round trip behind it. Shaped exactly like set-privacy, UA gate
        // included: it changes what a watching stranger can see.
        if (data.kind === 'set-cursor-owner') {
            if (s.role !== 'host') return;
            if (s.uaRequired && !s.uaVerified) return;
            void (async () => {
                const owned = data.owned === true;
                try {
                    const backend = await getHostBackend();
                    if (!backend.setDrawCursor) {
                        throw new Error('this host cannot hide its pointer');
                    }
                    // enabled = "keep drawing it", the inverse of who owns it.
                    await backend.setDrawCursor(s.id, !owned);
                    await sendSignal(s, { kind: 'cursor-owner-active', owned });
                } catch (e) {
                    console.warn('[device-session] cursor ownership failed', e);
                    await sendSignal(s, {
                        kind: 'cursor-owner-failed',
                        reason: e instanceof Error ? e.message : 'could not change cursor ownership',
                    }).catch(() => undefined);
                }
            })();
            return;
        }
        if (data.kind === 'cursor-owner-active') {
            if (s.role !== 'controller') return;
            // typeof, not truthiness: a malformed ack must change nothing
            // rather than coerce its way into drawing a second cursor (the
            // lesson stream-quality-ack's `as number` taught).
            if (typeof data.owned !== 'boolean') return;
            s.cursorOwned = data.owned;
            emit();
            return;
        }
        if (data.kind === 'secure-desktop') {
            if (s.role !== 'controller') return;
            // typeof, not truthiness — same lesson as cursor-owner-active. A
            // malformed frame must not be able to paste a "security prompt is
            // open" banner over a perfectly good session.
            if (typeof data.up !== 'boolean') return;
            // The transition times the locked-follow poller's patience; a
            // repeated `true` (a re-assert after a transport reattach) must
            // not restart the clock.
            if (data.up && !s.secureDesktop) s.secureDesktopSince = Date.now();
            if (!data.up) s.secureDesktopSince = null;
            s.secureDesktop = data.up;
            emit();
            return;
        }
        if (data.kind === 'cursor-clipped') {
            if (s.role !== 'controller') return;
            // typeof, not truthiness — same lesson as secure-desktop: a
            // malformed frame must not paste a "your clicks aren't landing"
            // banner over a working session.
            if (typeof data.clipped !== 'boolean') return;
            s.cursorClipped = data.clipped;
            emit();
            return;
        }
        if (data.kind === 'cursor-owner-failed') {
            if (s.role !== 'controller') return;
            // Leave cursorOwned alone — false is the safe state and it is
            // already there. Not surfaced as s.error: an older host refusing
            // an optional nicety is not a session failure, and a red banner
            // over a working session would be the wrong story.
            console.info('[device-session] host kept its cursor:', data.reason);
            return;
        }
        if (data.kind === 'file-access-request') {
            void serveFileAccessRequest(s);
            return;
        }
        if (data.kind === 'file-access-granted') {
            if (s.role !== 'controller') return;
            uaProofAccepted(s);
            // A policy grant carries no root, so trust the SCOPE it declares
            // rather than inferring "no root means no grant" — that inference
            // would silently drop the unattended grant on the floor and leave
            // the browser showing its "not shared" gate over a live grant.
            if (data.scope === 'policy') {
                s.fileRoot = null;
                s.fileScopeKind = 'policy';
            } else {
                const root = typeof data.root === 'string' ? data.root : null;
                s.fileRoot = root;
                s.fileScopeKind = root ? 'folder' : null;
            }
            emit();
            return;
        }
        if (data.kind === 'file-access-denied') {
            if (s.role !== 'controller') return;
            s.fileRoot = null;
            s.fileScopeKind = null;
            // Say WHY when the host bothered to explain. Without this a refusal
            // after a revoke is indistinguishable from a refusal because nobody
            // was there — the user sees the same "Ask to browse files" gate and
            // presses it again forever.
            // Always say something. A bare denial and a denial with a reason
            // looked identical to the user: the same gate, no explanation, and
            // the natural response is to press the button again.
            s.error = (typeof data.reason === 'string' && data.reason)
                || 'That device declined the file request.';
            emit();
            return;
        }
        if (data.kind === 'file-access-revoked') {
            // The host pulled the grant mid-session. Say so rather than letting
            // the browser sit on a stale listing and fail every click with
            // "file access has not been allowed" — which is true, and reads like
            // a bug rather than a decision somebody made.
            if (s.role !== 'controller') return;
            s.fileRoot = null;
            s.fileScopeKind = null;
            s.error = 'That device stopped sharing its files.';
            emit();
            return;
        }
        if (data.kind === 'privacy-active') {
            if (s.role !== 'controller') return;
            s.privacyActive = data.enabled === true;
            emit();
            return;
        }
        if (data.kind === 'privacy-failed') {
            if (s.role !== 'controller') return;
            // Leave privacyActive where it was: the host's screen did
            // not change, so neither should our picture of it.
            s.error = typeof data.reason === 'string' ? data.reason : 'could not change privacy mode';
            emit();
            return;
        }
        if (data.kind === 'input-failed') {
            if (s.role !== 'controller') return;
            if (data.t !== 'sas') return; // only the one input that asks for an answer
            const why = typeof data.reason === 'string' ? data.reason.slice(0, MAX_REASON_LEN) : 'the host refused';
            s.error = `Ctrl+Alt+Del could not be sent: ${why}`;
            emit();
            return;
        }
        if (data.kind === 'power-failed') {
            if (s.role !== 'controller') return;
            const why = typeof data.reason === 'string' ? data.reason.slice(0, MAX_REASON_LEN) : 'the host refused';
            if (typeof data.action === 'string' && (DISPLAY_POWER_ACTIONS as readonly string[]).includes(data.action)) {
                // A refused display action is a NOTICE, not a session error:
                // the session is fine — the red banner is for a machine that
                // could not be locked or shut down, not for a monitor that
                // ignored DDC.
                if (s.pendingPowerAckTimer) { clearTimeout(s.pendingPowerAckTimer); s.pendingPowerAckTimer = null; }
                setPowerNotice(s, `Displays: ${why}`);
                return;
            }
            const what = data.action === 'shutdown' ? 'shut down' : 'lock';
            s.error = `could not ${what} that device: ${why}`;
            emit();
            return;
        }
        if (data.kind === 'power-ack') {
            if (s.role !== 'controller') return;
            // ONLY display acks mean anything here: an ack for any other
            // action must not cancel a display action's pending deadline or
            // blank the notice with a null (review W4-N-nit — a stray
            // {action:'lock'} ack used to silently cancel the "did not
            // respond" warning).
            if (typeof data.action !== 'string'
                || !(DISPLAY_POWER_ACTIONS as readonly string[]).includes(data.action)) return;
            if (s.pendingPowerAckTimer) { clearTimeout(s.pendingPowerAckTimer); s.pendingPowerAckTimer = null; }
            const friendly = data.action === 'displays_off' ? 'Displays turned off'
                : data.action === 'displays_on' ? 'Displays turned on'
                : data.action === 'displays_detach_others' ? 'Other displays disabled'
                : data.action === 'displays_reattach' ? 'Displays restored'
                : 'Other displays turned off';
            const detail = typeof data.detail === 'string' ? data.detail.slice(0, MAX_REASON_LEN) : null;
            // The detail (per-monitor DDC honesty) beats the generic line.
            setPowerNotice(s, detail ?? friendly);
            return;
        }
        if (data.kind === 'query_stream_quality') {
            if (s.role !== 'host') return;
            // Same gate as input and privacy: an armed host does nothing for
            // a controller that never proved the passphrase.
            if (s.uaRequired && !s.uaVerified) return;
            void (async () => {
                try {
                    const backend = await getHostBackend();
                    if (!backend.getStreamQuality) {
                        throw new Error('Host backend does not support stream-quality queries');
                    }
                    const { fps, bitrate_kbps } = await backend.getStreamQuality(s.id);
                    if (!Number.isFinite(fps) || !Number.isFinite(bitrate_kbps)) {
                        throw new Error('Invalid stream-quality response from host backend');
                    }
                    await sendSignal(s, { kind: 'stream-quality-ack', fps, bitrate_kbps });
                } catch (error) {
                    console.error('[stream-quality] host query failed', { sessionId: s.id, error });
                    await sendSignal(s, { kind: 'stream-quality-error', code: 'query_failed' }).catch(() => undefined);
                }
            })();
            return;
        }
        if (data.kind === 'stream-quality-ack') {
            if (s.role !== 'controller') return;
            // VALIDATE BEFORE STORING. `data` comes off the wire through a bare
            // type assertion — openSignal proves the frame was sealed by the
            // peer, not that its fields are numbers. The casts here used to be
            // `as number`, so an ack with a missing or non-numeric field wrote
            // `undefined`/`NaN` into the store AND cleared the pending state:
            // the UI then displayed a quality nobody is running, with no error,
            // and the 5s timeout that would have reported the real failure had
            // already been cancelled. A malformed ack now changes nothing and
            // is left to time out honestly.
            const ackFps = typeof data.fps === 'number' && Number.isFinite(data.fps)
                ? data.fps : null;
            const ackBitrate = typeof data.bitrate_kbps === 'number' && Number.isFinite(data.bitrate_kbps)
                ? data.bitrate_kbps : null;
            if (ackFps === null || ackBitrate === null) {
                console.warn('[stream-quality] ignoring a malformed ack', {
                    sessionId: s.id, fps: data.fps, bitrate_kbps: data.bitrate_kbps,
                });
                return;
            }
            clearStreamQualityTimeout(s.id);
            import('../../stores/streamStore').then(({ useStreamStore }) => {
                const store = useStreamStore.getState();
                store.clearPendingQuality(s.id);
                store.setStreamQuality(s.id, { fps: ackFps, bitrate: ackBitrate });
            }).catch(console.error);
            return;
        }
        if (data.kind === 'stream-quality-error') {
            if (s.role !== 'controller') return;
            clearStreamQualityTimeout(s.id);
            import('../../stores/streamStore').then(({ useStreamStore }) => {
                const store = useStreamStore.getState();
                store.clearPendingQuality(s.id);
                window.dispatchEvent(new CustomEvent('stream-quality-failed', { detail: { sessionId: s.id, code: (data as Record<string, unknown>).code } }));
            }).catch(console.error);
            return;
        }
        if (data.kind === 'monitor-active' && typeof data.active === 'number') {
            if (s.role !== 'controller') return;
            s.activeMonitor = data.active;
            s.error = null;
            emit();
            return;
        }
        if (data.kind === 'monitor-failed') {
            if (s.role !== 'controller') return;
            // Surfaced, not swallowed: the viewer pressed a button and
            // the picture did not change, so they need to know why.
            s.error = typeof data.reason === 'string'
                ? data.reason
                : 'That computer could not switch screens.';
            emit();
            return;
        }
        if (data.kind === 'restart-offer' && typeof data.sdp === 'string') {
            // Only a HOST answers — same reflection rule as 'offer' below.
            if (s.role !== 'host') return;
            // Media never re-opens ahead of the passphrase. Unreachable for a
            // live session (the original offer was already held on this gate),
            // kept because the cost is one line and the failure is the screen.
            if (s.uaRequired && !s.uaVerified) return;
            // The session KIND is fixed at connect: a restart renegotiates the
            // transport of the session that exists. It must not turn Files
            // into Control past a consent that never ran, so data.filesOnly is
            // deliberately ignored and s.filesOnly (set by the original offer)
            // decides whether the new stream captures.
            try {
                let quality: { fps: number; bitrate_kbps: number } | null = null;
                if (s.agentOwnsTransport) {
                    const backend = await getHostBackend();
                    // Preserve the quality the controller had applied — the
                    // fresh stream would otherwise silently reset to defaults.
                    // Read BEFORE the stop; the stream carries the answer.
                    try {
                        quality = (await backend.getStreamQuality?.(s.id)) ?? null;
                    } catch { /* an old agent: defaults are what it had */ }
                    // The agent refuses a second stream for a live session id,
                    // so the dead one goes first. Candidates trickling
                    // meanwhile queue against agentStreamStarted and drain
                    // once answerOffer has started the new stream.
                    s.agentStreamStarted = false;
                    await backend.stopSession(s.id);
                } else {
                    // Webview host: the capture (s.hostStream) survives — only
                    // the peer connection is rebuilt, and answerOffer
                    // republishes the same tracks on the new pc. Handlers off
                    // before close, so the old pc's death is not narrated into
                    // the session the new one carries.
                    const old = s.pc;
                    if (old) {
                        old.onconnectionstatechange = null;
                        old.onicecandidate = null;
                        try { old.close(); } catch { /* already closed */ }
                    }
                    s.pc = null;
                    s.pendingIce = [];
                }
                // The old pc's 'disconnected' countdown dies with it. The
                // watchdog slot is single-occupancy and its callback bails on
                // `s.pc !== pc` WITHOUT re-arming — a stale timer left here
                // blocked the new pc's countdown and then vanished, leaving a
                // later dead connection unwatched forever.
                if (s.pcDisconnectTimer) {
                    clearTimeout(s.pcDisconnectTimer);
                    s.pcDisconnectTimer = null;
                }
                await answerOffer(s, data.sdp, quality ?? undefined);
                // Re-establish what StopStream destroyed alongside the stream.
                //
                // PRIVACY, first and unconditionally-awaited: stop_stream ran
                // privacy::set_enabled(false), so a deliberately blanked host
                // machine has been showing its desktop since the stop. The
                // controller's wish rides in the sealed offer precisely so
                // this handler can re-blank without depending on a separate
                // frame surviving the same network event that caused the
                // restart. Acked with the standard privacy-active so the
                // controller's toggle reflects what actually happened.
                if (data.privacy === true && !s.filesOnly) {
                    try {
                        const backend = await getHostBackend();
                        if (!backend.setPrivacyMode) throw new Error('this host cannot blank its screen');
                        await backend.setPrivacyMode(s.id, true);
                        await sendSignal(s, { kind: 'privacy-active', enabled: true });
                    } catch (e) {
                        await sendSignal(s, {
                            kind: 'privacy-failed',
                            reason: e instanceof Error ? e.message : 'could not restore privacy mode',
                        }).catch(() => undefined);
                    }
                }
                // FILE SCOPE: the agent kept it on the Stream object, so the
                // new stream has none — while this side still holds
                // fileScopeKind, and serveFileAccessRequest deliberately
                // short-circuits on it (a re-request is a re-sync, not a new
                // decision), so no controller action could ever repair it.
                // Re-applying the scope this session already earned is a
                // restore, not a new grant: every consent gate that produced
                // fileScopeKind has already run. On failure, make the truth
                // visible on both ends rather than leaving a granted-looking
                // grant whose every operation errors.
                if (s.agentOwnsTransport && s.fileScopeKind) {
                    try {
                        const backend = await getHostBackend();
                        const scope: import('./hostBackend').FileScopeRequest =
                            s.fileScopeKind === 'policy'
                                ? { kind: 'policy' }
                                : { kind: 'folder', root: s.fileRoot ?? '' };
                        if (!backend.setFileAccess || (scope.kind === 'folder' && !scope.root)) {
                            throw new Error('no scope to restore');
                        }
                        await backend.setFileAccess(s.id, scope);
                    } catch {
                        s.fileRoot = null;
                        s.fileScopeKind = null;
                        void sendSignal(s, { kind: 'file-access-revoked' }).catch(() => undefined);
                        emit();
                    }
                }
            } catch (e) {
                teardown(s, `could not restart the stream: ${e instanceof Error ? e.message : String(e)}`, true);
            }
            return;
        }
        if (data.kind === 'stream-died') {
            // The HOST's agent reaped its stream out from under a live session
            // (encoder fatal, capture device removed) — without this the
            // controller wears the last frame while input keeps landing. Same
            // terminal as unanswered probes: restart once, then honesty.
            if (s.role !== 'controller' || s.filesOnly) return;
            // A report landing right after a restart describes the stream the
            // restart already replaced (or its stop→start gap), not the new
            // one — acting on it converted a completed recovery into a
            // cooldown teardown of a live session.
            if (s.mediaRestartAt !== null
                && Date.now() - s.mediaRestartAt < RESTART_STREAM_DIED_MUTE_MS) return;
            handleMediaStalled(s);
            return;
        }
        if (data.kind === 'offer' && data.sdp) {
            // Only a HOST answers an offer. Without this, a frame can be
            // reflected back at its own sender — both peers seal under
            // the same key, so a sealed frame is valid in both
            // directions and only the role distinguishes them.
            if (s.role !== 'host') return;

            // Recorded BEFORE answering, because answerOffer is what decides
            // whether to capture. It arrives in the sealed signal rather than in
            // the server-visible DeviceConnect payload: whether somebody is
            // browsing files or watching a screen is not the server's business.
            s.filesOnly = data.filesOnly === true;

            // THE DEFERRED SCREEN REFUSAL. A capture-less host accepted the
            // connect without knowing what the controller wanted — filesOnly
            // only exists from the line above. A screen request lands here
            // instead of at accept, one round trip later, with the limitation
            // named rather than a black tile.
            if (!s.filesOnly && s.hostCaptureless) {
                teardown(
                    s,
                    'This device can share its files but not its screen — use Files instead of Control.',
                    true,
                );
                return;
            }

            // Same moment, same shape, for a files-only SHARE: the screen is
            // capturable but this friend was never granted it. Refused before
            // any capture starts, with the limitation named.
            if (!s.filesOnly && s.share
                && !s.share.capabilities.includes('control')
                && !s.share.capabilities.includes('view_only')) {
                teardown(
                    s,
                    'This share only allows file browsing — use Files instead of Control.',
                    true,
                );
                return;
            }

            // NOT BEFORE THE PASSPHRASE.
            //
            // The 0.8.1 gate covered input and clipboard only, which
            // left the thing the passphrase most obviously protects —
            // the screen — completely open: a controller that ignored
            // the challenge still got live video for the full deadline,
            // and could reconnect for another window indefinitely. Four
            // independent reviewers found this before any user did.
            //
            // Held, not dropped: the controller cannot know it needs to
            // renegotiate, so proving the passphrase resumes the offer.
            if (s.uaRequired && !s.uaVerified) {
              s.pendingOffer = data.sdp;
              return;
          }
          try {
              await answerOffer(s, data.sdp);
              armHostControlGuard(s);
          } catch (e) {
              console.warn('[device-session] offer failed:', e);
              teardown(s, `Offer failed: ${e instanceof Error ? e.message : String(e)}`, true);
          }
        } else if (data.kind === 'answer' && data.sdp) {
            // Only a CONTROLLER consumes an answer, same reflection
            // reasoning as the offer branch.
            if (s.role !== 'controller') return;
            uaProofAccepted(s);

            // REQUIRE the host to say it honoured data-only, rather than assuming
            // it did because we asked.
            //
            // filesOnly is an optional field in a sealed signal, so a host that
            // predates it parses the offer fine and simply ignores it — and then
            // captures. The failure is silent and points the wrong way: the user
            // asked for files and that machine's screen got shared, with nothing
            // on either end saying so. An explicit acknowledgement turns a silent
            // over-capture into a refusal that names itself.
            if (s.filesOnly && data.dataOnly !== true) {
                teardown(
                    s,
                    'That device is running an older version that cannot browse files without sharing its screen. Update it, or use Control instead.',
                    true,
                );
                return;
            }

            try {
                // Some WebRTC implementations (like Safari on iOS) strictly follow SDP RFCs 
                // and reject candidates containing 'ufrag' inside the candidate line.
                // str0m emits these, so we strip them to prevent setRemoteDescription from throwing.
                // Use [^\s]+ to handle all valid ufrag chars (including hyphens, underscores).
                const safeSdp = data.sdp.replace(/ ufrag [^\s]+/g, '');
                await s.pc?.setRemoteDescription({ type: 'answer', sdp: safeSdp });
                await applyPendingIce(s);
            } catch (e) {
                console.error('[device-session] setRemoteDescription failed:', e);
                teardown(s, `SDP Answer Error: ${e instanceof Error ? e.message : String(e)}`, true);
            }
        } else if (data.kind === 'ice' && data.candidate) {
            // THE AGENT OWNS THE CONNECTION, so its str0m is what needs
            // these — `s.pc` is null on that transport and the queue
            // below would swallow them forever. Missing this is why a
            // host with a working relay sat in ICE `Checking` while
            // sending frames nowhere.
            if (s.agentOwnsTransport) {
                // Not until start_stream has run. An ARMED host holds
                // the offer until the passphrase is proved, and the
                // controller trickles throughout that wait — so without
                // this queue every candidate is answered "no such
                // stream", dropped, and never re-sent. The session then
                // sits in ICE `Checking` forever, which is exactly what
                // "armed hangs on Waiting for the device's screen" was.
                // Same reasoning as pendingIce below, different
                // readiness test.
                if (!s.agentStreamStarted) {
                    queueIce(s, data.candidate);
                    return;
                }
                const line = (data.candidate as RTCIceCandidateInit).candidate;
                if (line) {
                    const { agentAddRemoteCandidate } = await import('./hostAgent');
                    await agentAddRemoteCandidate(s.id, line);
                }
                return;
            }
            // Queue until there IS a remote description, or
            // addIceCandidate throws and the candidate is lost.
            if (s.pc?.remoteDescription) {
                try {
                    await s.pc.addIceCandidate(data.candidate);
                } catch (e) {
                    console.warn('[device-session] addIceCandidate failed:', e);
                }
            }
            else queueIce(s, data.candidate);
        }
    } catch (e) {
        console.error('[device-session] signalling error:', e);
        teardown(s, `Signalling Error: ${e instanceof Error ? e.message : String(e)}`, true);
    }
}
