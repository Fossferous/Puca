"""The Deck's own microphone, switched on for a call and put back after.

A muted microphone in Steam's settings sends silence into a call that
otherwise works perfectly: the owner's Deck was found like that in testing
(muted at 8%, 2026-10-23). With "Turn the microphone on for calls" set, the
backend switches the Deck's default input on when a call starts and puts
back what it changed when the call ends.

- Only the default input: on the Deck the page has no device choice, so that
  is the one the plugin captures.
- Only when it is off. If it is muted, it is unmuted. If its volume is also
  nearly zero (Steam's slider at the bottom), the volume is raised for the
  call too.
- Put back exactly what was changed, and only while it is still what this
  set. Someone who changes the microphone during a call keeps their change.
- Survives the plugin dying mid-call. The change is written to a small file
  first, and the next start puts it back (a call cannot be running then).

wpctl (WirePlumber) does the work, on the user's own PipeWire session.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
from typing import Any, Awaitable, Callable

WPCTL = "/usr/bin/wpctl"
SOURCE = "@DEFAULT_AUDIO_SOURCE@"
NEARLY_SILENT = 0.05   # below this a microphone is as good as off
CALL_VOLUME = 1.0      # what a microphone at the bottom is raised to for the call
RESTORE_FILE = "mic-restore.json"

Run = Callable[[list[str]], Awaitable[tuple[int, str]]]

_VOLUME = re.compile(r"^\s*Volume:\s*([0-9]+(?:\.[0-9]+)?)\s*(\[MUTED\])?\s*$")


def parse_volume(text: str) -> tuple[float, bool] | None:
    """`wpctl get-volume` -> (volume, muted), or None for anything else."""
    m = _VOLUME.match(text.strip().splitlines()[0] if text.strip() else "")
    if not m:
        return None
    return float(m.group(1)), m.group(2) is not None


def plan_for_call(volume: float, muted: bool) -> dict:
    """What to change so the microphone is on: {} when it already is."""
    change: dict[str, Any] = {}
    if muted:
        change["muted"] = True  # was muted: unmute now, mute again after
        if volume < NEARLY_SILENT:
            change["volume"] = volume  # was at the bottom: raise now, lower again after
    return change


async def wpctl(args: list[str]) -> tuple[int, str]:
    """Run wpctl on this user's PipeWire session."""
    env = dict(os.environ)
    env.setdefault("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}")
    proc = await asyncio.create_subprocess_exec(
        WPCTL, *args, env=env, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), 5)
    except asyncio.TimeoutError:
        proc.kill()
        return 1, "wpctl did not answer"
    return proc.returncode or 0, out.decode("utf-8", "replace")


async def read_state(run: Run = wpctl) -> tuple[float, bool] | None:
    code, out = await run(["get-volume", SOURCE])
    return parse_volume(out) if code == 0 else None


class MicForCalls:
    """The microphone switched on for one call at a time, and put back."""

    def __init__(self, runtime_dir: str, run: Run = wpctl) -> None:
        self.path = os.path.join(runtime_dir, RESTORE_FILE)
        self.run = run
        self.change: dict | None = None  # what this call changed: {"muted": True, "volume": 0.0}

    async def turn_on(self) -> dict:
        """Switch it on if it is off. The answer says what was done:
        {"changed": False} or {"changed": True, "volume": <now>}."""
        if self.change is not None:
            return {"changed": bool(self.change)}
        state = await read_state(self.run)
        if state is None:
            raise RuntimeError("could not read the Deck's microphone")
        volume, muted = state
        change = plan_for_call(volume, muted)
        if not change:
            self.change = {}
            return {"changed": False}
        self._remember(change)
        if "volume" in change:
            await self._check(await self.run(["set-volume", SOURCE, f"{CALL_VOLUME:.2f}"]))
        await self._check(await self.run(["set-mute", SOURCE, "0"]))
        self.change = change
        return {"changed": True, "volume": CALL_VOLUME if "volume" in change else volume}

    async def put_back(self) -> bool:
        """Undo what turn_on changed, if the microphone is still as it left
        it. True when something was put back."""
        change = self.change if self.change is not None else self._remembered()
        self.change = None
        if not change:
            self._forget()
            return False
        state = await read_state(self.run)
        undone = False
        if state is not None:
            volume, muted = state
            still_ours = not muted and ("volume" not in change or abs(volume - CALL_VOLUME) < 0.01)
            if still_ours:
                if "volume" in change:
                    await self.run(["set-volume", SOURCE, f"{float(change['volume']):.2f}"])
                await self.run(["set-mute", SOURCE, "1"])
                undone = True
        self._forget()
        return undone

    # ---- The note that survives a crash ------------------------------------

    def _remember(self, change: dict) -> None:
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        tmp = self.path + ".part"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(change, f)
        os.replace(tmp, self.path)

    def _remembered(self) -> dict | None:
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                change = json.load(f)
        except (OSError, ValueError):
            return None
        if not isinstance(change, dict):
            return None
        clean: dict[str, Any] = {}
        if change.get("muted") is True:
            clean["muted"] = True
        if isinstance(change.get("volume"), (int, float)) and 0 <= change["volume"] <= 1.5:
            clean["volume"] = float(change["volume"])
        return clean or None

    def _forget(self) -> None:
        try:
            os.remove(self.path)
        except OSError:
            pass

    @staticmethod
    async def _check(result: tuple[int, str]) -> None:
        code, out = result
        if code != 0:
            raise RuntimeError(out.strip()[:200] or "wpctl failed")
