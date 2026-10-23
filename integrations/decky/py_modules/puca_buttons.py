"""The Deck's own controls, read directly: push to talk, presence, and choosing
the push-to-talk button by pressing it.

Steam's button feed for its own interface (SteamClient.Input's
RegisterForControllerInputMessages) cannot be counted on for this. In tests on
a Deck in Game Mode (2026-10-22/23, Steam client 1791918634) it reported the
lower right grip (its button 33) in most rounds, and nothing at all for the
same button in one round while another app was in front. Push to talk matters
most while a game is in front. Reading the controller directly caught every
hold in those tests, with an app in front or not.

So the backend reads the controller itself, from /dev/hidraw, which SteamOS
lets the signed-in user read (the seat's ACL; no root). It reads only while
the frontend asks:

- in a call: the back grips the person gave a job (push to talk, mute,
  deafen), held or not; and whether ANY control is being touched or pressed,
  never which, so that Púca's AFK move does not take a player out of the
  call mid-game (docs/EMBEDDING.md, idleSeconds);
- while the person chooses a push-to-talk button: which back grip they press
  next.

Nothing leaves this module but a grip's name with "held" or "released",
"in use", and a grip's name.

The layout is the Linux driver's (drivers/hid/hid-steam.c,
steam_deck_button_mappings). Every message is 64 bytes and starts 01 00, with
its type in byte 2; type 0x09 is the Deck's input state, where the grips are

    L4 (left top)    byte 13 bit 1        R4 (right top)    byte 13 bit 2
    L5 (left lower)  byte  9 bit 7        R5 (right lower)  byte 10 bit 0

and "in use" means any button that table names, or the capacitive touch of a
stick or a trackpad (a player's thumbs rest there). Bits it lists as unknown
are left out.

The controller streams that state 250 times a second, held or not (measured:
one node of the three, a frame counter stepping by 1). hidraw gives every
reader its own copy, so this takes nothing from Steam, and it keeps arriving
while a game has focus, which is what "push to talk, in games too" needs.
"""
from __future__ import annotations

import asyncio
import inspect
import os
import time
from typing import Any, Callable

DECK_HID_ID = "0003:000028DE:00001205"  # USB, Valve, the Deck's built-in controller
REPORT_SIZE = 64
DECK_STATE = 0x09
BUTTON_BITS = {"L4": (13, 1), "R4": (13, 2), "L5": (9, 7), "R5": (10, 0)}
BUTTONS = tuple(BUTTON_BITS)
# (byte, mask) of every control counted as "in use". hid-steam.c names all of
# byte 8 (the triggers' clicks, the bumpers, A B X Y) and byte 9 (the d-pad,
# View, Steam, Menu, L5); in byte 10 R5, both pad clicks, both pad touches and
# L3 (bits 5 and 7 unknown); in byte 11 R3; in byte 13 L4, R4 and both stick
# touches; in byte 14 the Quick Access button.
CONTROL_MASKS = ((8, 0xFF), (9, 0xFF), (10, 0x5F), (11, 0x04), (13, 0xC6), (14, 0x04))

HEARTBEAT_S = 0.5   # "still held", while held: Púca lets go 1.5 s after the last one
STALE_S = 1.0       # no state for this long (the stream runs every 4 ms): the controller is gone
RESCAN_S = 2.0      # look for the controller again this often while running (a suspend replaces it)
PRESENCE_S = 10.0   # "in use", at most this often while it goes on


def deck_state(report: bytes) -> bool:
    """Is this message the Deck's input state?"""
    return len(report) == REPORT_SIZE and report[0] == 0x01 and report[1] == 0x00 and report[2] == DECK_STATE


def button_held(report: bytes, button: str) -> bool | None:
    """The chosen grip in one controller message: True or False for the
    Deck's input state, None for any other message."""
    if not deck_state(report):
        return None
    byte, bit = BUTTON_BITS[button]
    return bool(report[byte] >> bit & 1)


def grips_held(report: bytes) -> frozenset[str] | None:
    """The back grips held in one message, None for any other message."""
    if not deck_state(report):
        return None
    return frozenset(name for name, (byte, bit) in BUTTON_BITS.items() if report[byte] >> bit & 1)


def controls_in_use(report: bytes) -> bool | None:
    """Is any control touched or pressed? (Which one is not kept.) None for
    any other message."""
    if not deck_state(report):
        return None
    return any(report[byte] & mask for byte, mask in CONTROL_MASKS)


def deck_controller_nodes(sys_class: str = "/sys/class/hidraw", dev: str = "/dev") -> list[str]:
    """The hidraw nodes of the Deck's built-in controller. It has three
    interfaces; which one carries the input state is not assumed."""
    found = []
    try:
        names = sorted(os.listdir(sys_class))
    except OSError:
        return found
    for name in names:
        try:
            with open(os.path.join(sys_class, name, "device", "uevent"), "r", encoding="utf-8") as f:
                lines = {line.strip().upper() for line in f}
        except OSError:
            continue
        if f"HID_ID={DECK_HID_ID}" in lines:
            found.append(os.path.join(dev, name))
    return found


def _deliver(fn: Callable[..., Any], *args: Any) -> None:
    """Call a callback that may be a coroutine function (decky.emit is)."""
    result = fn(*args)
    if inspect.isawaitable(result):
        # A frontend that is not listening is not an error here.
        asyncio.ensure_future(result).add_done_callback(lambda t: t.cancelled() or t.exception())


class HidrawIO:
    """The real thing: hidraw nodes, read on the running asyncio loop."""

    def nodes(self) -> list[str]:
        return deck_controller_nodes()

    def open(self, path: str) -> Any:
        return os.open(path, os.O_RDONLY | os.O_NONBLOCK)

    def watch(self, fd: Any, on_readable: Callable[[], None]) -> None:
        asyncio.get_running_loop().add_reader(fd, on_readable)

    def unwatch(self, fd: Any) -> None:
        asyncio.get_running_loop().remove_reader(fd)

    def read(self, fd: Any) -> bytes | None:
        """One message, or None when there is none waiting."""
        try:
            return os.read(fd, REPORT_SIZE)
        except BlockingIOError:
            return None

    def close(self, fd: Any) -> None:
        os.close(fd)

    def later(self, delay: float, fn: Callable[[], None]) -> Any:
        return asyncio.get_running_loop().call_later(delay, fn)

    def now(self) -> float:
        return time.monotonic()


class InputWatch:
    """The Deck's controls during a call, followed on every node of its
    controller.

    - The back grips with a job (`buttons`: names, one name, or None for
      none), each on its own: emit_button(name, True) when it goes down and
      every HEARTBEAT_S while it stays down; emit_button(name, False) when it
      comes up, when the controller stops reporting, and on stop(). For push
      to talk the frontend lets go by itself when the heartbeat stops, so no
      failure here can leave a microphone transmitting.
    - Presence: emit_presence() when any control is in use, at once and then
      at most every PRESENCE_S while it goes on.
    """

    def __init__(self, buttons: Any, emit_button: Callable[[str, bool], Any],
                 emit_presence: Callable[[], Any] | None = None, io: Any = None,
                 heartbeat_s: float = HEARTBEAT_S, stale_s: float = STALE_S,
                 rescan_s: float = RESCAN_S, presence_s: float = PRESENCE_S) -> None:
        names = (buttons,) if isinstance(buttons, str) else tuple(buttons or ())
        for name in names:
            if name not in BUTTON_BITS:
                raise ValueError(f"unknown button {name!r}")
        self.buttons = tuple(dict.fromkeys(names))
        self._emit = emit_button
        self._emit_presence = emit_presence
        self.io = io if io is not None else HidrawIO()
        self.heartbeat_s, self.stale_s = heartbeat_s, stale_s
        self.rescan_s, self.presence_s = rescan_s, presence_s
        self._fds: dict[str, Any] = {}
        # Per grip, the nodes that last reported it down.
        self._held: dict[str, set[str]] = {name: set() for name in self.buttons}
        self._beats: dict[str, Any] = {}
        self._last_state = 0.0
        self._presence_at: float | None = None
        self._rescan: Any = None
        self.running = False

    @property
    def held(self) -> bool:
        return any(self._held.values())

    def start(self) -> str | None:
        """Open the controller. Returns what the panel can say when it could
        not ("no-controller", "no-access"), or None; either way it keeps
        looking while running."""
        self.running = True
        return self._scan()

    def stop(self) -> None:
        self.running = False
        if self._rescan is not None:
            self._rescan.cancel()
        self._rescan = None
        for path in list(self._fds):
            self._drop(path)
        for beat in self._beats.values():
            beat.cancel()
        self._beats.clear()

    # ---- Nodes -----------------------------------------------------------------

    def _scan(self) -> str | None:
        """Runs every RESCAN_S while the watch does."""
        self._rescan = None
        if not self.running:
            return None
        if self._fds and self.io.now() - self._last_state > self.stale_s:
            # Open, but no input state lately: the stream's node went away
            # over a suspend while the silent ones stayed, or it never was
            # on these. Start over.
            for path in list(self._fds):
                self._drop(path)
        denied = False
        for path in self.io.nodes():
            if path in self._fds:
                continue
            try:
                fd = self.io.open(path)
            except PermissionError:
                denied = True
                continue
            except OSError:
                continue
            self._fds[path] = fd
            self.io.watch(fd, lambda p=path: self._readable(p))
        self._rescan = self.io.later(self.rescan_s, self._scan)
        if self._fds:
            return None
        return "no-access" if denied else "no-controller"

    def _drop(self, path: str) -> None:
        fd = self._fds.pop(path, None)
        if fd is not None:
            self.io.unwatch(fd)
            try:
                self.io.close(fd)
            except OSError:
                pass
        for name in self.buttons:
            self._set(path, name, False)

    def _readable(self, path: str) -> None:
        fd = self._fds.get(path)
        if fd is None:
            return
        seen = False
        states: dict[str, bool] = {}
        in_use = False
        while True:
            try:
                report = self.io.read(fd)
            except OSError:  # ENODEV and friends: the controller went away
                self._drop(path)
                return
            if report is None:
                break
            if not report:
                self._drop(path)
                return
            if not deck_state(report):
                continue
            seen = True
            for name in self.buttons:
                states[name] = bool(button_held(report, name))
            if controls_in_use(report):
                in_use = True
        if not seen:
            return
        self._last_state = self.io.now()
        for name, held in states.items():
            self._set(path, name, held)
        if in_use:
            self._presence()

    # ---- Held / released, in use -------------------------------------------------

    def _set(self, path: str, name: str, held: bool) -> None:
        paths = self._held[name]
        was = bool(paths)
        if held:
            paths.add(path)
        else:
            paths.discard(path)
        if paths and not was:
            _deliver(self._emit, name, True)
            self._beats[name] = self.io.later(self.heartbeat_s, lambda: self._tick(name))
        elif was and not paths:
            beat = self._beats.pop(name, None)
            if beat is not None:
                beat.cancel()
            _deliver(self._emit, name, False)

    def _tick(self, name: str) -> None:
        self._beats.pop(name, None)
        if not self._held[name] or not self.running:
            return
        if self.io.now() - self._last_state > self.stale_s:
            # Held, then silence: a controller that stopped reporting is not
            # a button still held.
            for path in list(self._held[name]):
                self._set(path, name, False)
            return
        _deliver(self._emit, name, True)
        self._beats[name] = self.io.later(self.heartbeat_s, lambda: self._tick(name))

    def _presence(self) -> None:
        if self._emit_presence is None:
            return
        now = self.io.now()
        if self._presence_at is not None and now - self._presence_at < self.presence_s:
            return
        self._presence_at = now
        _deliver(self._emit_presence)


class GripLearner:
    """Which back grip the person presses next: for choosing the push-to-talk
    button by pressing it instead of by its name. R4 and R5 are easy to mix
    up; in testing, "R4" was R5 every time. A grip already held when this
    starts does not count until it is let go and pressed again.
    on_learned(name) is called once."""

    def __init__(self, on_learned: Callable[[str], Any], io: Any = None) -> None:
        self._on_learned = on_learned
        self.io = io if io is not None else HidrawIO()
        self._fds: dict[str, Any] = {}
        self._before: dict[str, frozenset[str]] = {}
        self.done = False

    def start(self) -> str | None:
        """Open the controller: None, or what the panel can say
        ("no-controller", "no-access")."""
        denied = False
        for path in self.io.nodes():
            try:
                fd = self.io.open(path)
            except PermissionError:
                denied = True
                continue
            except OSError:
                continue
            self._fds[path] = fd
            self.io.watch(fd, lambda p=path: self._readable(p))
        if self._fds:
            return None
        return "no-access" if denied else "no-controller"

    def stop(self) -> None:
        for path in list(self._fds):
            self._drop(path)

    def _drop(self, path: str) -> None:
        fd = self._fds.pop(path, None)
        if fd is None:
            return
        self.io.unwatch(fd)
        try:
            self.io.close(fd)
        except OSError:
            pass

    def _readable(self, path: str) -> None:
        fd = self._fds.get(path)
        if fd is None:
            return
        while not self.done:
            try:
                report = self.io.read(fd)
            except OSError:
                self._drop(path)
                return
            if report is None:
                return
            if not report:
                self._drop(path)
                return
            held = grips_held(report)
            if held is None:
                continue
            before = self._before.get(path)
            self._before[path] = held
            if before is None:
                continue  # the first state is where it starts from
            pressed = held - before
            if pressed:
                self.done = True
                _deliver(self._on_learned, sorted(pressed)[0])
