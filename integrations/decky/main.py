"""Púca for Steam Deck: the plugin's backend (docs/STEAM_DECK.md).

The frontend (src/) creates a hidden Steam browser view; this side attaches to
it over Steam's local DevTools endpoint, puts the page shim in before Púca's
own scripts, opens the configured Púca address, and relays between the two
(docs/EMBEDDING.md is the page's half of the contract):

  page -> frontend   "puca_page" events: what the page's shim reports, only
                     from Púca's own main-frame page (puca_cdp.PucaPage);
  frontend -> page   page_call / mic_answer / set_foreground below.

The Deck's controls are read here too (puca_buttons.py), because Steam's own
button feed cannot be counted on while a game is in front. During a call this
side sends "puca_button" events for the push-to-talk button, and tells the
page when any control is in use, never which, so Púca's AFK move does not take
a player out of the call. In Settings it reports which back button the person
presses, to choose push to talk by pressing it.

It keeps the plugin's four settings and nothing else. No account data, no
message content and no audio pass through here: the microphone goes from one
Steam page to the other over WebRTC, and only its connection setup (SDP)
crosses this process.
"""
from __future__ import annotations

import asyncio
import json
import os
import secrets
from typing import Any

import decky

from puca_buttons import BUTTONS, GripLearner, InputWatch
from puca_cdp import CdpError, PucaPage, find_target
from puca_settings import (MARKER, PAGE_METHODS, check_mic_answer, load_settings,
                           normalize_app_url, save_settings)


def _settings_path() -> str:
    return os.path.join(decky.DECKY_PLUGIN_SETTINGS_DIR, "settings.json")


def _shim_source() -> str:
    with open(os.path.join(decky.DECKY_PLUGIN_DIR, "dist", "page-shim.js"), "r", encoding="utf-8") as f:
        return f.read()


class Plugin:
    page: PucaPage | None = None
    controls: InputWatch | None = None
    learning: asyncio.Future | None = None

    async def _main(self):
        decky.logger.info("Púca for Steam Deck backend started")

    async def _unload(self):
        await self.cancel_learn()
        await self.unwatch_input()
        await self.detach()

    async def _uninstall(self):
        await self.cancel_learn()
        await self.unwatch_input()
        await self.detach()

    # ---- Settings ---------------------------------------------------------

    async def get_settings(self) -> dict:
        return load_settings(_settings_path())

    async def set_settings(self, values: Any) -> dict:
        current = load_settings(_settings_path())
        if isinstance(values, dict):
            current.update({k: v for k, v in values.items() if k in current})
        return save_settings(_settings_path(), current)

    # ---- The page ---------------------------------------------------------

    async def attach(self, marker: str, app_url: str) -> dict:
        """Take over the view the frontend just created and open Púca in it."""
        if not isinstance(marker, str) or not MARKER.match(marker):
            return {"ok": False, "error": "bad view marker"}
        url = normalize_app_url(app_url)
        if url is None:
            return {"ok": False, "error": "that is not an https address"}
        await self.detach()
        try:
            target = await find_target(f"data:text/plain,{marker}")
            # A fresh, unguessable binding name per attach: the shim takes it
            # off the page's global before Púca's scripts run.
            page = PucaPage(url[1], f"__pucaDecky_{secrets.token_hex(8)}", decky.emit)
            self.page = page
            await page.attach(target, _shim_source(), url[0])
        except (CdpError, OSError) as e:
            decky.logger.warning("attaching to the Púca view failed: %s", e)
            await self.detach()
            return {"ok": False, "error": str(e)}
        except Exception as e:  # aiohttp and timeouts: report, never crash the plugin
            decky.logger.exception("attaching to the Púca view failed")
            await self.detach()
            return {"ok": False, "error": type(e).__name__}
        decky.logger.info("Púca view attached, opening %s", url[1])
        return {"ok": True, "value": None}

    async def detach(self) -> None:
        page, self.page = self.page, None
        if page is not None:
            await page.detach()

    async def page_call(self, method: str, args: Any = None) -> dict:
        """One of window.pucaEmbed's commands, as the person's own action."""
        if method not in PAGE_METHODS:
            return {"ok": False, "error": "not allowed"}
        if args is None:
            args = []
        if not isinstance(args, list):
            return {"ok": False, "error": "bad arguments"}
        if self.page is None:
            return {"ok": False, "error": "Púca is not running"}
        expression = f"window.__pucaDeckyShim.call({json.dumps(method)}, {json.dumps(args)})"
        try:
            result = await self.page.evaluate(expression)
        except CdpError as e:
            return {"ok": False, "error": str(e)}
        except Exception as e:
            return {"ok": False, "error": type(e).__name__}
        if isinstance(result, dict) and isinstance(result.get("ok"), bool):
            return result
        return {"ok": False, "error": "no answer"}

    async def mic_answer(self, request_id: Any, answer: Any = None, error: Any = None) -> None:
        checked = check_mic_answer(request_id, answer, error)
        if checked is None or self.page is None:
            return
        rid, clean_answer, clean_error = checked
        try:
            await self.page.evaluate(
                f"window.__pucaDeckyShim.micAnswer({json.dumps(rid)}, {json.dumps(clean_answer)}, {json.dumps(clean_error)})")
        except Exception as e:
            decky.logger.info("microphone answer not delivered: %s", e)

    async def set_foreground(self, on: Any) -> None:
        if self.page is None:
            return
        try:
            await self.page.evaluate(f"window.__pucaDeckyShim.setForeground({json.dumps(on is True)})")
        except Exception:
            pass

    # ---- The Deck's controls -------------------------------------------------

    async def watch_input(self, button: Any = None) -> dict:
        """Follow the Deck's controls during a call, until unwatch_input.

        - `button` (or None): the push-to-talk grip. "puca_button" events say
          True when it goes down and again every half second while it stays
          down, and False when it comes up.
        - Presence, always: the page hears when any control is in use, for
          Púca's AFK move.

        The value is why the controller cannot be read yet ("no-controller",
        "no-access"), or None; it keeps looking either way."""
        await self.unwatch_input()
        if button is not None and button not in BUTTONS:
            return {"ok": False, "error": "unknown button"}
        watch = InputWatch(button, lambda held: decky.emit("puca_button", held), self._controls_in_use)
        self.controls = watch
        problem = watch.start()
        if problem is None:
            # Joining was the person's own doing: present from here.
            self._controls_in_use()
        return {"ok": True, "value": problem}

    async def unwatch_input(self) -> None:
        watch, self.controls = self.controls, None
        if watch is not None:
            watch.stop()
            await self._page_eval("window.__pucaDeckyShim.clearInput()")

    def _controls_in_use(self) -> None:
        asyncio.ensure_future(self._page_eval("window.__pucaDeckyShim.noteInput()"))

    async def _page_eval(self, expression: str) -> None:
        page = self.page
        if page is None:
            return
        try:
            await page.evaluate(expression)
        except Exception:
            pass  # a page that is reloading learns it again on the next note

    async def learn_button(self, timeout_s: Any = 15) -> dict:
        """The back grip the person presses next, within timeout_s (at most
        30): {"ok": True, "value": "R5"}, value None when nothing was pressed
        in time or the frontend cancelled; ok False when the controller cannot
        be read."""
        await self.cancel_learn()
        loop = asyncio.get_running_loop()
        got = loop.create_future()
        self.learning = got
        learner = GripLearner(lambda name: got.done() or got.set_result(name))
        problem = learner.start()
        try:
            if problem is not None:
                return {"ok": False, "error": problem}
            try:
                seconds = min(max(float(timeout_s), 1.0), 30.0)
            except (TypeError, ValueError):
                seconds = 15.0
            try:
                return {"ok": True, "value": await asyncio.wait_for(asyncio.shield(got), seconds)}
            except asyncio.TimeoutError:
                return {"ok": True, "value": None}
        finally:
            learner.stop()
            if self.learning is got:
                self.learning = None
            if not got.done():
                got.cancel()

    async def cancel_learn(self) -> None:
        got, self.learning = self.learning, None
        if got is not None and not got.done():
            got.set_result(None)
