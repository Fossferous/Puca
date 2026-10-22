"""Push-to-talk on a back button: the Deck's own controller, read directly.

Steam's interface never hears the back grips. Measured on a Deck in Game Mode
(2026-10-22, Steam client 1791918634): SteamClient.Input's
RegisterForControllerInputMessages delivered B, and nothing at all for two
3-second holds of R4. So the backend reads the controller itself, from
/dev/hidraw, which SteamOS lets the signed-in user read (the seat's ACL; no
root). Only one bit of one message type is looked at, only while the frontend
asks for it (a button is chosen and Púca is in a call), and nothing leaves
this module but "held" and "released".

The layout is the Linux driver's (drivers/hid/hid-steam.c,
steam_deck_button_mappings). Every message is 64 bytes and starts 01 00, with
its type in byte 2; type 0x09 is the Deck's input state, where the grips are

    L4 (left top)    byte 13 bit 1        R4 (right top)    byte 13 bit 2
    L5 (left lower)  byte  9 bit 7        R5 (right lower)  byte 10 bit 0

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

HEARTBEAT_S = 0.5  # "still held", while held: Púca lets go 1.5 s after the last one
STALE_S = 1.0      # no state for this long (the stream runs every 4 ms): the controller is gone
RESCAN_S = 2.0     # look for the controller again this often while running (a suspend replaces it)


def button_held(report: bytes, button: str) -> bool | None:
    """The chosen button in one controller message: True or False for the
    Deck's input state, None for any other message."""
    if len(report) != REPORT_SIZE or report[0] != 0x01 or report[1] != 0x00 or report[2] != DECK_STATE:
        return None
    byte, bit = BUTTON_BITS[button]
    return bool(report[byte] >> bit & 1)


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


class ButtonWatch:
    """One back button, followed on every node of the Deck's controller.

    emit(True) when it goes down and every HEARTBEAT_S while it stays down;
    emit(False) when it comes up, when the controller stops reporting, and on
    stop(). The frontend lets go by itself when the heartbeat stops, so no
    failure here can leave a microphone transmitting."""

    def __init__(self, button: str, emit: Callable[[bool], Any], io: Any = None,
                 heartbeat_s: float = HEARTBEAT_S, stale_s: float = STALE_S, rescan_s: float = RESCAN_S) -> None:
        if button not in BUTTON_BITS:
            raise ValueError(f"unknown button {button!r}")
        self.button = button
        self._emit = emit
        self.io = io if io is not None else HidrawIO()
        self.heartbeat_s, self.stale_s, self.rescan_s = heartbeat_s, stale_s, rescan_s
        self._fds: dict[str, Any] = {}
        self._held: set[str] = set()
        self._last_state = 0.0
        self._beat: Any = None
        self._rescan: Any = None
        self.running = False

    @property
    def held(self) -> bool:
        return bool(self._held)

    def start(self) -> str | None:
        """Open the controller. Returns what the panel can say when it could
        not ("no-controller", "no-access"), or None; either way it keeps
        looking while running."""
        self.running = True
        return self._scan()

    def stop(self) -> None:
        self.running = False
        for handle in (self._beat, self._rescan):
            if handle is not None:
                handle.cancel()
        self._beat = self._rescan = None
        for path in list(self._fds):
            self._drop(path)

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
        self._set(path, False)

    def _readable(self, path: str) -> None:
        fd = self._fds.get(path)
        if fd is None:
            return
        state = None
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
            held = button_held(report, self.button)
            if held is not None:
                state = held
        if state is not None:
            self._last_state = self.io.now()
            self._set(path, state)

    # ---- Held / released ---------------------------------------------------------

    def _set(self, path: str, held: bool) -> None:
        was = bool(self._held)
        if held:
            self._held.add(path)
        else:
            self._held.discard(path)
        if self._held and not was:
            self._send(True)
            self._beat = self.io.later(self.heartbeat_s, self._tick)
        elif was and not self._held:
            if self._beat is not None:
                self._beat.cancel()
                self._beat = None
            self._send(False)

    def _tick(self) -> None:
        self._beat = None
        if not self._held or not self.running:
            return
        if self.io.now() - self._last_state > self.stale_s:
            # Held, then silence: a controller that stopped reporting is not
            # a button still held.
            for path in list(self._held):
                self._set(path, False)
            return
        self._send(True)
        self._beat = self.io.later(self.heartbeat_s, self._tick)

    def _send(self, held: bool) -> None:
        result = self._emit(held)
        if inspect.isawaitable(result):
            # A frontend that is not listening is not an error here.
            asyncio.ensure_future(result).add_done_callback(lambda t: t.cancelled() or t.exception())
