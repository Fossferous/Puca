"""The backend's checks, without a Deck: python -m unittest discover -s tests

puca_cdp imports aiohttp, which Decky Loader bundles; a stand-in is put in its
place here when it is not installed, since nothing below opens a connection.
"""
import asyncio
import json
import os
import sys
import tempfile
import types
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "py_modules"))

try:
    import aiohttp  # noqa: F401
except ImportError:
    stub = types.ModuleType("aiohttp")
    stub.ClientSession = object
    stub.ClientWebSocketResponse = object
    stub.ClientError = Exception
    stub.ClientTimeout = lambda **_: None
    stub.WSMsgType = types.SimpleNamespace(TEXT=1)
    sys.modules["aiohttp"] = stub

import puca_settings as ps  # noqa: E402
from puca_cdp import PucaPage  # noqa: E402


class AddressTests(unittest.TestCase):
    def test_typed_address_becomes_https(self):
        self.assertEqual(ps.normalize_app_url("chat.example.com"), ("https://chat.example.com/", "https://chat.example.com"))
        self.assertEqual(ps.normalize_app_url(" HTTPS://Chat.Example.com "), ("https://chat.example.com/", "https://chat.example.com"))
        self.assertEqual(ps.normalize_app_url("chat.example.com:8443/puca"),
                         ("https://chat.example.com:8443/puca/", "https://chat.example.com:8443"))
        self.assertEqual(ps.normalize_app_url("https://chat.example.com:443/"), ("https://chat.example.com/", "https://chat.example.com"))
        # http only on the loopback, which browsers treat as a secure context too.
        self.assertEqual(ps.normalize_app_url("http://127.0.0.1:5173"), ("http://127.0.0.1:5173/", "http://127.0.0.1:5173"))
        self.assertEqual(ps.normalize_app_url("http://localhost"), ("http://localhost/", "http://localhost"))

    def test_refuses_what_it_should(self):
        for bad in ("http://chat.example.com", "http://127.0.0.2", "https://u:p@chat.example.com", "", "intranet",
                    "https://chat.example.com:99999", "https://bad host.example", None, 42,
                    "javascript:alert(1)", "file:///etc/passwd"):
            self.assertIsNone(ps.normalize_app_url(bad), bad)


class SettingsTests(unittest.TestCase):
    def test_defaults_and_cleaning(self):
        self.assertEqual(ps.read_settings(None), ps.DEFAULTS)
        self.assertEqual(ps.read_settings({"appUrl": "http://x.example", "pushToTalk": "R9", "notifications": "yes"}), ps.DEFAULTS)
        self.assertEqual(ps.read_settings({"appUrl": "chat.example.com", "pushToTalk": "R4", "notifications": False}),
                         {"appUrl": "https://chat.example.com/", "pushToTalk": "R4", "muteButton": "off", "deafenButton": "off",
                          "micForCalls": True, "notifications": False, "notificationSound": True})

    def test_a_back_grip_has_one_job(self):
        s = ps.read_settings({"pushToTalk": "R5", "muteButton": "R5", "deafenButton": "L4", "micForCalls": False})
        self.assertEqual((s["pushToTalk"], s["muteButton"], s["deafenButton"], s["micForCalls"]), ("R5", "off", "L4", False))
        s = ps.read_settings({"muteButton": "L5", "deafenButton": "L5"})
        self.assertEqual((s["muteButton"], s["deafenButton"]), ("L5", "off"))
        s = ps.read_settings({"pushToTalk": "off", "muteButton": "off", "deafenButton": "R4"})
        self.assertEqual(s["deafenButton"], "R4", "two jobs switched off do not count as sharing a grip")

    def test_round_trip_through_the_file(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "sub", "settings.json")
            self.assertEqual(ps.load_settings(path), ps.DEFAULTS)
            saved = ps.save_settings(path, {"appUrl": "chat.example.com", "pushToTalk": "L5", "evil": 1})
            self.assertNotIn("evil", saved)
            self.assertEqual(ps.load_settings(path), saved)
            with open(path, "w") as f:
                f.write("{not json")
            self.assertEqual(ps.load_settings(path), ps.DEFAULTS)


class MessageTests(unittest.TestCase):
    def test_mic_answer(self):
        self.assertEqual(ps.check_mic_answer("m1", {"type": "answer", "sdp": "v=0"}, None),
                         ("m1", {"type": "answer", "sdp": "v=0"}, None))
        self.assertIsNone(ps.check_mic_answer("../x", {"type": "answer", "sdp": "v=0"}, None))
        self.assertIsNone(ps.check_mic_answer("m1", {"type": "offer", "sdp": "v=0"}, None))
        self.assertIsNone(ps.check_mic_answer("m1", {"type": "answer", "sdp": "x" * (70 * 1024)}, None))
        # An error name is passed on only if it is a plain word (it becomes a DOMException name).
        self.assertEqual(ps.check_mic_answer("m1", None, {"name": "NotAllowedError", "message": "no"})[2],
                         {"name": "NotAllowedError", "message": "no"})
        self.assertEqual(ps.check_mic_answer("m1", None, {"name": "x'); alert(1); ('", "message": 5})[2],
                         {"name": "NotReadableError", "message": ""})
        self.assertEqual(ps.check_mic_answer("m1", None, None)[2]["name"], "NotReadableError")

    def test_page_message(self):
        self.assertEqual(ps.read_page_message('{"type":"state","state":{}}'), {"type": "state", "state": {}})
        self.assertIsNone(ps.read_page_message("[1,2]"))
        self.assertIsNone(ps.read_page_message('{"no":"type"}'))
        self.assertIsNone(ps.read_page_message("x" * (300 * 1024)))
        self.assertIsNone(ps.read_page_message(None))

    def test_page_methods_are_the_embedding_commands_only(self):
        self.assertIn("joinVoice", ps.PAGE_METHODS)
        self.assertNotIn("eval", ps.PAGE_METHODS)
        self.assertNotIn("constructor", ps.PAGE_METHODS)


class BindingFilterTests(unittest.TestCase):
    """Only Púca's own main-frame page may speak to the plugin."""

    def setUp(self):
        self.loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self.loop)
        self.emitted = []

        async def emit(event, payload):
            self.emitted.append((event, payload))

        self.page = PucaPage("https://chat.example.com", "__pucaDecky_test", emit)
        self.page._main_frame = "MAIN"

    def tearDown(self):
        self.loop.close()

    def drain(self):
        self.loop.run_until_complete(asyncio.sleep(0))

    def context(self, ctx_id, frame, origin, default=True):
        self.page._on_event("Runtime.executionContextCreated", {
            "context": {"id": ctx_id, "origin": origin, "auxData": {"isDefault": default, "frameId": frame}},
        })

    def call(self, ctx_id, payload, name="__pucaDecky_test"):
        self.page._on_event("Runtime.bindingCalled", {"name": name, "executionContextId": ctx_id, "payload": payload})
        self.drain()

    def test_accepts_the_main_page_on_puca(self):
        self.context(5, "MAIN", "https://chat.example.com")
        self.call(5, json.dumps({"type": "ready", "apiVersion": 1}))
        self.assertEqual(self.emitted, [("puca_page", {"type": "ready", "apiVersion": 1})])

    def test_refuses_everything_else(self):
        self.context(5, "MAIN", "https://chat.example.com")
        self.context(6, "IFRAME", "https://chat.example.com")         # a frame inside it
        self.context(7, "MAIN", "https://chat.example.com", False)    # an extension/isolated world
        self.call(6, '{"type":"ready"}')
        self.call(7, '{"type":"ready"}')
        self.call(5, '{"type":"ready"}', name="other")                  # another binding
        self.call(5, "not json")
        self.assertEqual(self.emitted, [])

    def test_a_page_that_left_puca_is_not_heard(self):
        self.context(5, "MAIN", "https://chat.example.com")
        self.page._on_event("Runtime.executionContextsCleared", {})
        self.context(9, "MAIN", "https://evil.example")
        self.call(9, '{"type":"ready"}')
        self.assertEqual(self.emitted, [])
        self.page._on_event("Page.frameNavigated", {"frame": {"id": "MAIN", "url": "https://evil.example/"}})
        self.drain()
        self.assertEqual(self.emitted, [("puca_status", {"type": "navigated", "onApp": False})])

    def test_evaluate_refuses_before_puca_has_loaded(self):
        self.page._conn = types.SimpleNamespace(closed=False)
        with self.assertRaises(Exception):
            self.loop.run_until_complete(self.page.evaluate("1"))
        self.context(9, "MAIN", "https://evil.example")
        with self.assertRaises(Exception):
            self.loop.run_until_complete(self.page.evaluate("1"))


if __name__ == "__main__":
    unittest.main()
