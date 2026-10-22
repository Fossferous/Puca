"""Steam's DevTools endpoint, from the plugin's side.

Steam's browser listens for DevTools on 127.0.0.1:8080 (Decky Loader turns
this on; it is bound to the loopback only). The plugin uses it for the ONE
page it created, the hidden Púca view: to find it, to put the page shim in
before Púca's own scripts, and to relay between the page and the plugin.
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Awaitable, Callable, Dict, Optional

import aiohttp

from puca_settings import origin_of, read_page_message

CDP_HTTP = "http://127.0.0.1:8080"
log = logging.getLogger("puca")


class CdpError(Exception):
    pass


async def list_targets() -> list:
    timeout = aiohttp.ClientTimeout(total=3)
    async with aiohttp.ClientSession(timeout=timeout) as http:
        async with http.get(f"{CDP_HTTP}/json") as res:
            if res.status != 200:
                raise CdpError(f"/json answered {res.status}")
            return await res.json(content_type=None)


async def find_target(url: str, wait_s: float = 15.0) -> dict:
    """The page target whose URL is exactly `url` (the frontend's marker)."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + wait_s
    while True:
        try:
            for t in await list_targets():
                if t.get("type") == "page" and t.get("url") == url and t.get("webSocketDebuggerUrl"):
                    return t
        except (aiohttp.ClientError, asyncio.TimeoutError, CdpError, ValueError) as e:
            log.debug("listing targets failed: %s", e)
        if loop.time() > deadline:
            raise CdpError("the Púca view never appeared")
        await asyncio.sleep(0.25)


class CdpConnection:
    """One DevTools websocket: commands by id, events to a callback."""

    def __init__(self, ws_url: str, on_event: Callable[[str, dict], None], on_close: Callable[[], None]):
        self._ws_url = ws_url
        self._on_event = on_event
        self._on_close = on_close
        self._http: Optional[aiohttp.ClientSession] = None
        self._ws: Optional[aiohttp.ClientWebSocketResponse] = None
        self._reader: Optional[asyncio.Task] = None
        self._next_id = 0
        self._pending: Dict[int, asyncio.Future] = {}
        self._closed = False

    async def open(self) -> None:
        self._http = aiohttp.ClientSession()
        self._ws = await self._http.ws_connect(self._ws_url, max_msg_size=16 * 1024 * 1024)
        self._reader = asyncio.ensure_future(self._read())

    async def _read(self) -> None:
        try:
            async for msg in self._ws:
                if msg.type != aiohttp.WSMsgType.TEXT:
                    continue
                try:
                    data = json.loads(msg.data)
                except ValueError:
                    continue
                if "id" in data:
                    fut = self._pending.pop(data["id"], None)
                    if fut and not fut.done():
                        fut.set_result(data)
                elif "method" in data:
                    try:
                        self._on_event(data["method"], data.get("params") or {})
                    except Exception:  # an event handler must not end the connection
                        log.exception("event handler failed for %s", data.get("method"))
        except Exception as e:
            log.info("DevTools connection ended: %s", e)
        finally:
            await self._finish()

    async def _finish(self) -> None:
        if self._closed:
            return
        self._closed = True
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(CdpError("connection closed"))
        self._pending.clear()
        try:
            if self._ws is not None:
                await self._ws.close()
        finally:
            if self._http is not None:
                await self._http.close()
        self._on_close()

    @property
    def closed(self) -> bool:
        return self._closed

    async def send(self, method: str, params: Optional[dict] = None, timeout: float = 10.0) -> dict:
        if self._closed or self._ws is None:
            raise CdpError("not connected")
        self._next_id += 1
        cmd_id = self._next_id
        fut = asyncio.get_running_loop().create_future()
        self._pending[cmd_id] = fut
        await self._ws.send_str(json.dumps({"id": cmd_id, "method": method, "params": params or {}}))
        try:
            res = await asyncio.wait_for(fut, timeout)
        finally:
            self._pending.pop(cmd_id, None)
        if "error" in res:
            raise CdpError(f"{method}: {res['error'].get('message', res['error'])}")
        return res.get("result") or {}

    async def close(self) -> None:
        if self._reader is not None:
            self._reader.cancel()
        await self._finish()


class PucaPage:
    """The hidden Púca view: attached, shimmed, and relayed.

    Messages from the page count only when they come from the MAIN frame's
    own page world on the configured Púca origin: the binding is visible to
    every frame of the target, and a page that navigated elsewhere (a link)
    must not speak for Púca.
    """

    def __init__(self, origin: str, binding: str,
                 emit: Callable[[str, Any], Awaitable[None]]):
        self.origin = origin
        self.binding = binding
        self._emit = emit
        self._conn: Optional[CdpConnection] = None
        self._main_frame: Optional[str] = None
        self._main_context: Optional[int] = None
        self._main_context_origin: Optional[str] = None
        self._detached_reported = False

    @property
    def attached(self) -> bool:
        return self._conn is not None and not self._conn.closed

    async def attach(self, target: dict, shim_source: str, app_url: str) -> None:
        self._conn = CdpConnection(target["webSocketDebuggerUrl"], self._on_event, self._on_close)
        await self._conn.open()
        await self._conn.send("Page.enable")
        tree = await self._conn.send("Page.getFrameTree")
        self._main_frame = tree.get("frameTree", {}).get("frame", {}).get("id")
        await self._conn.send("Runtime.enable")
        await self._conn.send("Runtime.addBinding", {"name": self.binding})
        config = {"origin": self.origin, "binding": self.binding, "hostName": "Púca for Steam Deck"}
        await self._conn.send("Page.addScriptToEvaluateOnNewDocument", {
            "source": f"globalThis.__pucaDeckyShimConfig = {json.dumps(config)};\n{shim_source}",
        })
        res = await self._conn.send("Page.navigate", {"url": app_url}, timeout=30.0)
        if res.get("errorText"):
            await self._emit("puca_status", {"type": "load-failed", "host": self.origin, "error": res["errorText"]})

    async def detach(self) -> None:
        conn, self._conn = self._conn, None
        self._detached_reported = True
        if conn is not None:
            await conn.close()

    def _schedule(self, coro: Awaitable[None]) -> None:
        asyncio.ensure_future(coro)

    def _on_close(self) -> None:
        if not self._detached_reported:
            self._detached_reported = True
            self._schedule(self._emit("puca_status", {"type": "detached"}))

    def _on_event(self, method: str, params: dict) -> None:
        if method == "Runtime.executionContextCreated":
            ctx = params.get("context") or {}
            aux = ctx.get("auxData") or {}
            if aux.get("isDefault") and aux.get("frameId") == self._main_frame:
                self._main_context = ctx.get("id")
                self._main_context_origin = ctx.get("origin")
        elif method == "Runtime.executionContextDestroyed":
            if params.get("executionContextId") == self._main_context:
                self._main_context = None
        elif method == "Runtime.executionContextsCleared":
            self._main_context = None
        elif method == "Runtime.bindingCalled":
            if (params.get("name") == self.binding
                    and self._main_context is not None
                    and params.get("executionContextId") == self._main_context
                    and self._main_context_origin == self.origin):
                msg = read_page_message(params.get("payload"))
                if msg is not None:
                    self._schedule(self._emit("puca_page", msg))
        elif method == "Page.frameNavigated":
            frame = params.get("frame") or {}
            if not frame.get("parentId"):
                self._main_frame = frame.get("id")
                on_app = origin_of(frame.get("url")) == self.origin
                self._schedule(self._emit("puca_status", {"type": "navigated", "onApp": on_app}))
        elif method in ("Inspector.targetCrashed", "Inspector.detached"):
            kind = "crashed" if method == "Inspector.targetCrashed" else "detached"
            self._detached_reported = True
            self._schedule(self._emit("puca_status", {"type": kind}))

    async def evaluate(self, expression: str, timeout: float = 15.0) -> Any:
        """Evaluate in Púca's own page world and return the value, as a person's action."""
        if not self.attached:
            raise CdpError("not attached")
        if self._main_context is None or self._main_context_origin != self.origin:
            raise CdpError("Púca is not loaded")
        res = await self._conn.send("Runtime.evaluate", {
            "expression": expression,
            "contextId": self._main_context,
            "awaitPromise": True,
            "returnByValue": True,
            # Joining a call starts audio: Chromium allows that only after a
            # user action, and this is one, relayed from the Quick Access panel.
            "userGesture": True,
        }, timeout=timeout)
        if res.get("exceptionDetails"):
            text = res["exceptionDetails"].get("exception", {}).get("description") or res["exceptionDetails"].get("text")
            raise CdpError(str(text)[:200])
        return (res.get("result") or {}).get("value")
