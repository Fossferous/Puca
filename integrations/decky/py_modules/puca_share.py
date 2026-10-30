"""Sharing the Deck's screen (docs/STEAM_DECK.md, *Sharing your screen*).

Game Mode's compositor publishes the screen as a PipeWire video source named
`gamescope`. This reads it, thins it to 30 fps and encodes H.264 on the
Deck's own video engine (VA-API), with tools SteamOS already has:

    gst-launch-1.0 pipewiresrc ... ! videorate ! videoconvert ! fdsink
      | ffmpeg ... -c:v h264_vaapi ... -f h264 pipe:1

Measured on a Deck (2026-10-23): reading the feed at 30 fps costs about
0.05 W; the conversion and the hardware encode about 0.02 W more, with the
CPU unchanged.

WirePlumber's own linking fails on this SteamOS (0.5.14: every video stream
is "target not found"), so the capture does not connect by itself: this makes
the link with pw-link.

The encoder starts every access unit with a delimiter (AUD). Units are split
here and handed to Púca's page (main.py), which decodes them and shares the
picture like any other (src/shim/pageShim.ts, getDisplayMedia). Nothing is
recorded: the picture exists only on its way to the page.

The feed is the whole screen, Steam's menus included. The frontend looks at
the screen every 100 ms while sharing (src/share.ts) and says what it saw: the
game alone, or something else as well. A unit goes only once looks on both
sides of it, close together, said "the game alone" (ShowGate): a look that is
late, lost, or held up by a busy Steam holds the picture back, never lets it
out.
"""
from __future__ import annotations

import asyncio
import itertools
import math
import os
import re
import time
from collections import deque
from typing import Awaitable, Callable, Optional

WIDTH, HEIGHT, FPS = 1280, 800, 30
BITRATE, MAXRATE = "4M", "6M"
GOP = FPS              # a keyframe every second: the longest a viewer waits after a pause or a drop
FEED = "gamescope"
VA_DEVICE = "/dev/dri/renderD128"
MAX_PENDING_BYTES = 4 * 1024 * 1024
LINK_WAIT_S = 5.0
MAX_GAP_S = 0.25       # two looks further apart than this vouch for nothing between them (the frontend looks every 0.1 s)
LAG_S = 0.03           # a look vouches only for what began this long before it
MAX_HOLD_S = 0.6       # a unit nobody vouched for by then is dropped
SETTLE_S = 0.5         # after a pause: menus slide away, toasts fade
PAGE_GONE_S = 3.0      # the page refusing the picture this long ends the share
FEED_CHECK_S = 2.0     # how often a running share checks that Steam's recorder has not taken the feed
# Steam's Game Recording, set to Record in Background, reads the same feed while a
# game runs, and then this capture gets no frames at all (measured on a Deck,
# 2026-10-30: 0 frames with Steam's recorder linked, ~30 fps with it off).
RECORDER = "steam"
RECORDER_TAKES_FEED = ("Steam's background recording is using the screen. Turn off Record in Background "
                       "in Steam's Settings > Game Recording, then share again.")
_names = itertools.count(1)

# What the page's shim is called with (puca_cdp.call_function): values, never script text.
SHARE_ANSWER = "function (id, ok, error, refused) { window.__pucaDeckyShim.shareAnswer(id, ok, error, refused); }"
SHARE_CHUNK = "function (id, data, key) { return window.__pucaDeckyShim.shareChunk(id, data, key); }"
SHARE_PAUSED = "function (id, on) { window.__pucaDeckyShim.sharePaused(id, on); }"
SHARE_ENDED = "function (id, why) { window.__pucaDeckyShim.shareEnded(id, why); }"


def client_name() -> str:
    """A PipeWire name of our own per share, so a link can only ever reach this capture."""
    return f"puca-share-{os.getpid()}-{next(_names)}"


def capture_argv(client: str) -> list[str]:
    """The feed at 30 fps, NV12 at the Deck's own size (letterboxed if it is
    another shape), raw on stdout. It waits for the link.

    do-timestamp: gamescope's feed is variable-rate and its own buffer times
    are no use to videorate, which then passed the first frame and dropped
    every one after it, a black share (measured on a Deck, 2026-10-30: one
    frame in 3 s with a game in front; ~30 fps once stamped on arrival)."""
    return [
        "gst-launch-1.0", "-q",  # -q: its chatter would go down the pipe with the picture
        "pipewiresrc", "autoconnect=false", f"client-name={client}", "do-timestamp=true",
        "!", "videorate", "drop-only=true", "!", f"video/x-raw,framerate={FPS}/1",
        "!", "videoconvert", "!", "videoscale",
        "!", f"video/x-raw,format=NV12,width={WIDTH},height={HEIGHT}",
        "!", "fdsink", "fd=1",
    ]


def encode_argv() -> list[str]:
    """Raw NV12 in, hardware H.264 out, each access unit flushed as soon as it
    is encoded: no B-frames and one frame in flight, for the least delay."""
    return [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
        "-f", "rawvideo", "-pix_fmt", "nv12", "-s", f"{WIDTH}x{HEIGHT}", "-r", str(FPS), "-i", "pipe:0",
        "-vaapi_device", VA_DEVICE, "-vf", "hwupload", "-c:v", "h264_vaapi",
        "-rc_mode", "VBR", "-b:v", BITRATE, "-maxrate", MAXRATE, "-g", str(GOP), "-bf", "0",
        "-async_depth", "1", "-aud", "1",
        "-flush_packets", "1", "-f", "h264", "pipe:1",
    ]


def find_ports(outputs: str, inputs: str, client: str, feed: str = FEED) -> Optional[tuple[str, str]]:
    """The feed's output port and our stream's input port, from `pw-link -o` and `pw-link -i`."""
    out = next((l.strip() for l in outputs.splitlines() if l.strip().startswith(f"{feed}:")), None)
    inp = next((l.strip() for l in inputs.splitlines() if l.strip().startswith(f"{client}:")), None)
    return (out, inp) if out and inp else None


def feed_taken(links: str, feed: str = FEED, recorder: str = RECORDER) -> bool:
    """Whether Steam's own recorder reads the feed, from `pw-link -l`: each
    output port, then one "  |-> node:port" line per input it feeds."""
    port: Optional[str] = None
    for line in links.splitlines():
        if line and not line[0].isspace():
            port = line.strip()
            continue
        target = line.strip()
        if port and port.startswith(f"{feed}:") and target.startswith("|->"):
            if target[3:].strip().split(":", 1)[0] == recorder:
                return True
    return False


def tool_env(base: Optional[dict] = None) -> dict:
    """The environment for system tools: this user's PipeWire session, and the
    system's own libraries. Decky's Python is a PyInstaller bundle that points
    LD_LIBRARY_PATH at its own copies, which GStreamer and ffmpeg must not load."""
    env = dict(os.environ if base is None else base)
    if "XDG_RUNTIME_DIR" not in env and hasattr(os, "getuid"):
        env["XDG_RUNTIME_DIR"] = f"/run/user/{os.getuid()}"
    original = env.pop("LD_LIBRARY_PATH_ORIG", None)
    if original:
        env["LD_LIBRARY_PATH"] = original
    else:
        env.pop("LD_LIBRARY_PATH", None)
    return env


# An access unit delimiter: a start code and NAL type 9 (its header byte is exactly 0x09).
_AUD = re.compile(rb"(?:\x00\x00\x00\x01|\x00\x00\x01)\x09")
_NAL = re.compile(rb"\x00\x00\x01(.)", re.DOTALL)


class AccessUnits:
    """Annex B H.264 in, whole access units out, split at each AUD, each with
    the time its delimiter arrived: when it was encoded, near enough.

    A unit is complete only when the next one's delimiter arrives, a frame
    (33 ms) later while the screen changes, and not at all while it does not.
    Its own time, not the time it came out, is what the pause rules judge."""

    def __init__(self, limit: int = MAX_PENDING_BYTES) -> None:
        self.buf = bytearray()
        self.limit = limit
        self.head_t: Optional[float] = None  # when the unit at the start of buf began

    def feed(self, data: bytes, now: float = 0.0) -> list[tuple[bytes, float]]:
        self.buf += data
        starts = [m.start() for m in _AUD.finditer(self.buf)]
        if not starts:
            if len(self.buf) > self.limit:
                self.buf.clear()  # no delimiter in megabytes: not this encoder's output
                self.head_t = None
            return []
        # buf always begins at the last delimiter found: that one is the held unit.
        times = [self.head_t if i == 0 and s == 0 and self.head_t is not None else now
                 for i, s in enumerate(starts)]
        out = [(bytes(self.buf[a:b]), t) for a, b, t in zip(starts, starts[1:], times)]
        del self.buf[:starts[-1]]  # anything before the first delimiter is not a whole unit
        self.head_t = times[-1]
        return out


def nal_types(au: bytes) -> list[int]:
    return [m.group(1)[0] & 0x1F for m in _NAL.finditer(au)]


def is_keyframe(au: bytes) -> bool:
    """An IDR picture (NAL type 5) with the parameter sets it needs (7, 8) in
    the same unit: a decoder can start here. The Deck's encoder sends them with
    every IDR (measured: AUD, SPS, PPS, SEI, IDR every GOP frames)."""
    types = nal_types(au)
    return 5 in types and 7 in types and 8 in types


class ShowGate:
    """Which access units may go on to the page, from the frontend's looks.

    A look says what was on screen when the frontend looked (src/share.ts):
    the game alone ("showing"), or something else as well. A unit is vouched
    for once two "showing" looks lie either side of when it began, no further
    apart than MAX_GAP_S. So nothing goes that nobody saw was safe:

    - a "paused" look drops everything waiting, and so does a gap between
      looks (a lost one, or Steam too busy to look);
    - after a pause, nothing that began within SETTLE_S of the first
      "showing" look goes: menus slide away, toasts fade out;
    - from a keyframe only, after any unit was dropped: a decoder cannot pick
      up in the middle of a group of pictures;
    - when the page is behind, units that need the ones before them are
      dropped rather than queued, so the picture stays live.

    It starts paused: the first "showing" look settles like any other.
    """

    def __init__(self) -> None:
        self.showing = False
        self.last_look: Optional[float] = None  # the latest look of an unbroken "showing" run
        self.not_before = 0.0
        self.need_key = True

    def look(self, showing: bool, at: float) -> tuple[Optional[float], bool]:
        """A look taken at `at`. Returns (vouched_until, drop_waiting): what
        began up to vouched_until may go; drop_waiting, what waits may not.
        A "paused" look always counts, however late it comes."""
        if not showing:
            self.showing = False
            self.last_look = None
            self.need_key = True
            return None, True
        if self.last_look is not None and at <= self.last_look:
            return None, False  # overtaken by a newer look: it says nothing new
        if not self.showing:
            self.showing = True
            self.last_look = at
            self.not_before = at + SETTLE_S
            self.need_key = True
            return None, True
        gap = at - self.last_look
        self.last_look = at
        if gap > MAX_GAP_S:
            self.need_key = True
            return None, True
        return at - LAG_S, False

    def admit(self, key: bool, began: float, behind: bool = False) -> bool:
        """Whether a unit fresh from the encoder may wait for its looks."""
        if not self.showing or began < self.not_before:
            return False
        if behind and not key:
            self.need_key = True
            return False
        if self.need_key:
            if not key:
                return False
            self.need_key = False
        return True


class HoldLine:
    """Units waiting for the looks that vouch for them, in order."""

    def __init__(self) -> None:
        self.items: deque = deque()  # (began, au, key)
        self.vouched_until = -math.inf

    def put(self, began: float, au: bytes, key: bool) -> None:
        self.items.append((began, au, key))

    def vouch(self, until: float) -> None:
        self.vouched_until = max(self.vouched_until, until)

    def take(self, now: float) -> tuple[list[tuple[bytes, bool]], bool]:
        """(the units that may go now, whether one waited past MAX_HOLD_S and
        was dropped, with everything behind it)."""
        out: list[tuple[bytes, bool]] = []
        while self.items and self.items[0][0] <= self.vouched_until:
            _, au, key = self.items.popleft()
            out.append((au, key))
        if self.items and now - self.items[0][0] > MAX_HOLD_S:
            self.items.clear()
            return out, True
        return out, False

    def head_began(self) -> Optional[float]:
        return self.items[0][0] if self.items else None

    def clear(self) -> int:
        n = len(self.items)
        self.items.clear()
        return n

    def __len__(self) -> int:
        return len(self.items)


def look_time(at_ms: object, loop_now: float, wall_now: float) -> Optional[float]:
    """The frontend's look time (Date.now(), ms) on the event loop's clock.
    Both read this machine's own clock. None for anything implausible."""
    if isinstance(at_ms, bool) or not isinstance(at_ms, (int, float)) or not math.isfinite(at_ms):
        return None
    age = wall_now - at_ms / 1000.0
    if age < -1.0 or age > 10.0:
        return None
    return loop_now - max(0.0, age)


Deliver = Callable[[bytes, bool], Awaitable[None]]
Ended = Callable[[str], None]


class ScreenCapture:
    """The capture and encoder processes, the link between gamescope and them,
    and the pump that hands each vouched-for access unit to `deliver`."""

    def __init__(self, deliver: Deliver, ended: Ended, pending_max: int = 12) -> None:
        self.deliver = deliver
        self.ended = ended
        self.gate = ShowGate()
        self.line = HoldLine()
        self.pending_max = pending_max  # units wait about 3 at 30 fps for their look: past this the page is behind
        self.client = client_name()
        self.gst: Optional[asyncio.subprocess.Process] = None
        self.ff: Optional[asyncio.subprocess.Process] = None
        self.tasks: list[asyncio.Task] = []
        self.wake = asyncio.Event()
        self.stopping = False
        self.failing_since: Optional[float] = None
        self._ended_told = False

    async def start(self) -> Optional[str]:
        """Run the processes and link the feed: None when it is linked,
        otherwise why not. Nothing is handed on until begin()."""
        env = tool_env()
        read_fd, write_fd = os.pipe()
        try:
            self.gst = await asyncio.create_subprocess_exec(
                *capture_argv(self.client), stdout=write_fd, stdin=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL, env=env)
            self.ff = await asyncio.create_subprocess_exec(
                *encode_argv(), stdin=read_fd, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL, env=env)
        except OSError as e:
            await self.stop()
            return f"cannot start the capture ({e.strerror or type(e).__name__})"
        finally:
            os.close(read_fd)
            os.close(write_fd)
        problem = await self._link(env)
        if problem is not None:
            await self.stop()
        return problem

    def begin(self) -> None:
        self.tasks = [asyncio.ensure_future(self._read()), asyncio.ensure_future(self._send()),
                      asyncio.ensure_future(self._watch_feed())]

    async def _link(self, env: dict) -> Optional[str]:
        loop = asyncio.get_running_loop()
        until = loop.time() + LINK_WAIT_S
        while loop.time() < until:
            if self.gst is None or self.gst.returncode is not None:
                return "the screen feed could not be read"
            if self.ff is None or self.ff.returncode is not None:
                return "the Deck's video encoder could not be used"
            ports = find_ports((await _run(["pw-link", "-o"], env))[1], (await _run(["pw-link", "-i"], env))[1], self.client)
            if ports is not None and (await _run(["pw-link", ports[0], ports[1]], env))[0] == 0:
                return RECORDER_TAKES_FEED if feed_taken((await _run(["pw-link", "-l"], env))[1]) else None
            await asyncio.sleep(0.25)
        return "no screen to share (the Deck must be in Game Mode)"

    async def _watch_feed(self) -> None:
        """Steam's recorder starts when a game does, so a share started on
        Steam's own screen can lose the feed later: end it, saying why,
        rather than send nothing."""
        env = tool_env()
        while True:
            await asyncio.sleep(FEED_CHECK_S)
            if feed_taken((await _run(["pw-link", "-l"], env))[1]):
                self._end(RECORDER_TAKES_FEED)
                return

    async def _read(self) -> None:
        loop = asyncio.get_running_loop()
        units = AccessUnits()
        why = "the screen feed stopped"
        try:
            assert self.ff is not None and self.ff.stdout is not None
            while True:
                data = await self.ff.stdout.read(64 * 1024)
                if not data:
                    break
                for au, began in units.feed(data, loop.time()):
                    key = is_keyframe(au)
                    if self.gate.admit(key, began, behind=len(self.line) >= self.pending_max):
                        self.line.put(began, au, key)
                        self.wake.set()
        except asyncio.CancelledError:
            raise
        except Exception as e:
            why = f"the screen feed failed ({type(e).__name__})"
        self._end(why)

    async def _send(self) -> None:
        loop = asyncio.get_running_loop()
        while True:
            self.wake.clear()  # before looking, so a unit or a look that comes meanwhile wakes the wait below
            ready, dropped = self.line.take(loop.time())
            if dropped:
                self.gate.need_key = True  # nobody vouched for it in time (no looks: Steam busy, or gone)
            for au, key in ready:
                try:
                    await self.deliver(au, key)
                    self.failing_since = None
                except asyncio.CancelledError:
                    raise
                except Exception:
                    # The page missed one: start again at a keyframe. A page
                    # that keeps refusing has gone (a reload): end the share.
                    self.gate.need_key = True
                    self.line.clear()
                    now = loop.time()
                    if self.failing_since is None:
                        self.failing_since = now
                    elif now - self.failing_since > PAGE_GONE_S:
                        self._end("Púca's page stopped taking the picture")
                        return
                    break
            if ready or dropped:
                continue
            head = self.line.head_began()
            wait = None if head is None else max(0.0, head + MAX_HOLD_S - loop.time()) + 0.005
            try:
                await asyncio.wait_for(self.wake.wait(), wait)
            except asyncio.TimeoutError:
                pass

    def look(self, showing: bool, at: float) -> bool:
        """What the frontend saw on screen at `at` (event-loop time). True
        when that changed whether the share is showing or paused."""
        was = self.gate.showing
        vouched, drop = self.gate.look(showing, at)
        if drop:
            self.line.clear()  # nobody saw it was safe: never shown
        if vouched is not None:
            self.line.vouch(vouched)
        self.wake.set()
        return self.gate.showing != was

    @property
    def showing(self) -> bool:
        return self.gate.showing

    def look_now(self, showing: bool, at_ms: object) -> Optional[bool]:
        """look(), with the frontend's own Date.now() as the time; None when
        that time is implausible and the look is ignored."""
        at = look_time(at_ms, asyncio.get_running_loop().time(), time.time())
        return None if at is None else self.look(showing, at)

    def _end(self, why: str) -> None:
        if not self.stopping and not self._ended_told:
            self._ended_told = True
            self.ended(why)

    async def stop(self) -> None:
        self.stopping = True
        tasks, self.tasks = self.tasks, []
        for t in tasks:
            t.cancel()
        self.line.clear()
        # Killed, not asked: neither keeps anything worth saving, and ffmpeg
        # would otherwise try to flush into a pipe nobody reads.
        for proc in (self.gst, self.ff):
            if proc is not None and proc.returncode is None:
                try:
                    proc.kill()
                except ProcessLookupError:
                    pass
        for proc in (self.gst, self.ff):
            if proc is not None:
                try:
                    await asyncio.wait_for(proc.wait(), 3)
                except asyncio.TimeoutError:
                    pass
        self.gst = self.ff = None


async def _run(argv: list[str], env: dict) -> tuple[int, str]:
    try:
        proc = await asyncio.create_subprocess_exec(
            *argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            stdin=asyncio.subprocess.DEVNULL, env=env)
    except OSError:
        return 127, ""
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), 5)
    except asyncio.TimeoutError:
        proc.kill()
        return 1, ""
    return proc.returncode or 0, out.decode("utf-8", "replace")
