"""Sharing the Deck's screen, without a Deck: python -m unittest discover -s tests

puca_share.py splits the hardware encoder's H.264 into access units, decides
which go to the page, and holds each one back long enough that a pause can
still take it back. main.py answers the page and keeps one share at a time.
Nothing here starts a process: the capture's pipe is a list of byte strings.
"""
import asyncio
import os
import sys
import types
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "py_modules"))
sys.path.insert(0, os.path.join(HERE, ".."))

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

import puca_share as sh  # noqa: E402

AUD4 = b"\x00\x00\x00\x01\x09\xf0"
AUD3 = b"\x00\x00\x01\x09\xf0"
SPS = b"\x00\x00\x00\x01\x67\x64\x0c\x20\xac\x2b"
PPS = b"\x00\x00\x00\x01\x68\xee\x3c\xb0"
SEI = b"\x00\x00\x01\x06\x05\x10"
IDR = b"\x00\x00\x01\x65\x88\x84\x00\x33\xff"
SLICE = b"\x00\x00\x01\x41\x9a\x02\x03"


def key_unit(n=0):
    return AUD4 + SPS + PPS + SEI + IDR + bytes([n])


def delta_unit(n=0, aud=AUD4):
    return aud + SEI + SLICE + bytes([n])


class CommandTests(unittest.TestCase):
    def test_the_capture_waits_for_our_link_and_says_nothing_down_the_pipe(self):
        argv = sh.capture_argv("puca-share-1-1")
        self.assertEqual(argv[:2], ["gst-launch-1.0", "-q"], "-v would put gst's chatter into the picture")
        self.assertIn("autoconnect=false", argv, "WirePlumber's linking fails here: the backend links it")
        self.assertIn("client-name=puca-share-1-1", argv)
        self.assertIn("video/x-raw,framerate=30/1", argv)
        self.assertIn("video/x-raw,format=NV12,width=1280,height=800", argv)
        self.assertEqual(argv[-2:], ["fdsink", "fd=1"])

    def test_the_encoder_is_the_decks_own_and_marks_every_unit(self):
        argv = sh.encode_argv()
        joined = " ".join(argv)
        for want in ("-c:v h264_vaapi", "-vaapi_device /dev/dri/renderD128", "-aud 1", "-bf 0", f"-g {sh.FPS}",
                     "-s 1280x800", "-pix_fmt nv12", "-flush_packets 1", "-f h264 pipe:1", "-i pipe:0"):
            self.assertIn(want, joined)
        self.assertEqual(sh.GOP, sh.FPS, "a keyframe every second: the longest a viewer waits after a pause")

    def test_each_share_gets_a_pipewire_name_of_its_own(self):
        a, b = sh.client_name(), sh.client_name()
        self.assertNotEqual(a, b)
        self.assertTrue(a.startswith(f"puca-share-{os.getpid()}-"))

    def test_finds_the_feed_and_our_own_input_only(self):
        outputs = "alsa_input.pci:capture_FL\ngamescope:capture_1\n"
        inputs = "puca-share-9-1:input_1\npuca-share-9-12:input_1\nalsa_output:playback_FL\n"
        self.assertEqual(sh.find_ports(outputs, inputs, "puca-share-9-1"), ("gamescope:capture_1", "puca-share-9-1:input_1"))
        self.assertEqual(sh.find_ports(outputs, inputs, "puca-share-9-12"), ("gamescope:capture_1", "puca-share-9-12:input_1"))
        self.assertIsNone(sh.find_ports("alsa_input.pci:capture_FL\n", inputs, "puca-share-9-1"), "no feed outside Game Mode")
        self.assertIsNone(sh.find_ports(outputs, "puca-share-9-2:input_1\n", "puca-share-9-1"), "another share's port is not ours")
        self.assertIsNone(sh.find_ports("gamescope-other:capture_1\n", inputs, "puca-share-9-1"))

    def test_system_tools_get_the_systems_libraries_not_deckys(self):
        bundled = {"LD_LIBRARY_PATH": "/tmp/_MEIxyz", "LD_LIBRARY_PATH_ORIG": "/usr/lib/extra", "XDG_RUNTIME_DIR": "/run/user/1000"}
        env = sh.tool_env(bundled)
        self.assertEqual(env["LD_LIBRARY_PATH"], "/usr/lib/extra")
        self.assertNotIn("LD_LIBRARY_PATH_ORIG", env)
        env = sh.tool_env({"LD_LIBRARY_PATH": "/tmp/_MEIxyz"})
        self.assertNotIn("LD_LIBRARY_PATH", env, "PyInstaller had none to save: the system default")
        if hasattr(os, "getuid"):
            self.assertEqual(env["XDG_RUNTIME_DIR"], f"/run/user/{os.getuid()}")
        self.assertEqual(bundled["LD_LIBRARY_PATH"], "/tmp/_MEIxyz", "the caller's dict is left alone")


class AccessUnitTests(unittest.TestCase):
    def test_splits_at_each_delimiter_whatever_the_reads(self):
        stream = key_unit(1) + delta_unit(2) + delta_unit(3, aud=AUD3) + key_unit(4)
        for size in (1, 3, 7, 64, len(stream)):
            units = sh.AccessUnits()
            got = []
            for i in range(0, len(stream), size):
                got += [au for au, _ in units.feed(stream[i:i + size])]
            self.assertEqual(got, [key_unit(1), delta_unit(2), delta_unit(3, aud=AUD3)], f"reads of {size}")
            self.assertEqual(bytes(units.buf), key_unit(4), "the last unit waits for the next delimiter")

    def test_what_comes_before_the_first_delimiter_is_dropped(self):
        units = sh.AccessUnits()
        self.assertEqual([au for au, _ in units.feed(SLICE + key_unit(1) + delta_unit(2))], [key_unit(1)])

    def test_a_unit_keeps_the_time_it_began_however_long_it_waits(self):
        """A still screen sends no next frame: the unit before is completed
        only when the screen changes, maybe after a pause came and went."""
        units = sh.AccessUnits()
        self.assertEqual(units.feed(key_unit(1), 10.0), [])
        self.assertEqual(units.feed(delta_unit(2)[:3], 50.0), [], "half a delimiter completes nothing")
        self.assertEqual(units.feed(delta_unit(2)[3:] + delta_unit(3), 60.0),
                         [(key_unit(1), 10.0), (delta_unit(2), 60.0)])
        self.assertEqual(units.feed(key_unit(4), 70.0), [(delta_unit(3), 60.0)])

    def test_a_stream_with_no_delimiters_is_not_kept_forever(self):
        units = sh.AccessUnits(limit=100)
        self.assertEqual(units.feed(b"\x11" * 150), [])
        self.assertEqual(len(units.buf), 0)

    def test_a_keyframe_is_an_idr_with_its_parameter_sets(self):
        self.assertEqual(sh.nal_types(key_unit()), [9, 7, 8, 6, 5])
        self.assertTrue(sh.is_keyframe(key_unit()))
        self.assertFalse(sh.is_keyframe(delta_unit()))
        self.assertFalse(sh.is_keyframe(AUD4 + IDR), "an IDR a fresh decoder cannot start from")


class Patched:
    """puca_share's timing constants, changed for one test."""

    def __init__(self, **values):
        self.values = values
        self.old = {}

    def __enter__(self):
        for k, v in self.values.items():
            self.old[k] = getattr(sh, k)
            setattr(sh, k, v)

    def __exit__(self, *exc):
        for k, v in self.old.items():
            setattr(sh, k, v)


class GateTests(unittest.TestCase):
    def test_starts_paused_and_settles_on_the_first_showing_look(self):
        g = sh.ShowGate()
        self.assertFalse(g.admit(True, 0.0), "nobody has looked yet")
        self.assertEqual(g.look(True, 1.0), (None, True))
        self.assertTrue(g.showing)
        self.assertFalse(g.admit(True, 1.0 + sh.SETTLE_S - 0.01), "the panel is still sliding away")
        self.assertFalse(g.admit(False, 1.0 + sh.SETTLE_S), "not mid-group")
        self.assertTrue(g.admit(True, 1.0 + sh.SETTLE_S))
        self.assertTrue(g.admit(False, 1.0 + sh.SETTLE_S + 0.03))

    def test_two_close_looks_vouch_for_what_lies_between(self):
        g = sh.ShowGate()
        g.look(True, 1.0)
        vouched, drop = g.look(True, 1.1)
        self.assertAlmostEqual(vouched, 1.1 - sh.LAG_S)
        self.assertFalse(drop)

    def test_a_gap_between_looks_vouches_for_nothing(self):
        g = sh.ShowGate()
        g.look(True, 1.0)
        g.look(True, 1.1)
        g.need_key = False
        self.assertEqual(g.look(True, 1.1 + sh.MAX_GAP_S + 0.01), (None, True), "a lost look, or Steam too busy to look")
        self.assertTrue(g.need_key)
        vouched, drop = g.look(True, 1.1 + sh.MAX_GAP_S + 0.11)
        self.assertFalse(drop)
        self.assertIsNotNone(vouched, "the next close look vouches again")

    def test_a_paused_look_drops_what_waits_however_late_it_comes(self):
        g = sh.ShowGate()
        g.look(True, 1.0)
        g.look(True, 1.1)
        self.assertEqual(g.look(False, 0.5), (None, True))
        self.assertFalse(g.showing)
        self.assertFalse(g.admit(True, 1.2))
        self.assertEqual(g.look(True, 1.3), (None, True), "and showing again settles first")

    def test_an_overtaken_showing_look_says_nothing(self):
        g = sh.ShowGate()
        g.look(True, 1.0)
        g.look(True, 1.2)
        self.assertEqual(g.look(True, 1.1), (None, False))
        self.assertEqual(g.look(True, 1.2), (None, False), "nor does the same look twice")

    def test_behind_drops_until_the_next_keyframe(self):
        g = sh.ShowGate()
        g.look(True, 0.0)
        t = sh.SETTLE_S
        g.admit(True, t)
        self.assertFalse(g.admit(False, t, behind=True))
        self.assertFalse(g.admit(False, t), "the next delta needs the one that was dropped")
        self.assertTrue(g.admit(True, t, behind=True), "a keyframe always helps")
        self.assertTrue(g.admit(False, t))

    def test_one_lost_look_is_borne_and_no_more(self):
        with open(os.path.join(HERE, "..", "src", "share.ts"), encoding="utf-8") as f:
            src = f.read()
        poll_ms = int(src.split("export const SHARE_POLL_MS = ")[1].split(";")[0])
        self.assertGreaterEqual(sh.MAX_GAP_S * 1000, 2 * poll_ms, "one late look must not freeze the picture")
        self.assertLessEqual(sh.MAX_GAP_S * 1000, 3 * poll_ms, "a long gap vouches for a moment nobody saw")


class HoldLineTests(unittest.TestCase):
    def test_lets_go_in_order_only_what_was_vouched_for(self):
        line = sh.HoldLine()
        line.put(1.00, b"a", True)
        line.put(1.03, b"b", False)
        line.put(1.06, b"c", False)
        self.assertEqual(line.take(1.07), ([], False))
        line.vouch(1.04)
        self.assertEqual(line.take(1.10), ([(b"a", True), (b"b", False)], False))
        self.assertEqual(line.head_began(), 1.06)

    def test_what_waits_too_long_goes_with_everything_behind_it(self):
        line = sh.HoldLine()
        line.put(1.0, b"a", True)
        line.put(1.1, b"b", False)
        self.assertEqual(line.take(1.0 + sh.MAX_HOLD_S + 0.01), ([], True))
        self.assertEqual(len(line), 0)

    def test_a_vouch_never_goes_back(self):
        line = sh.HoldLine()
        line.vouch(2.0)
        line.vouch(1.0)
        line.put(1.5, b"a", True)
        self.assertEqual(line.take(1.6), ([(b"a", True)], False))


class LookTimeTests(unittest.TestCase):
    def test_the_frontends_clock_on_the_event_loops(self):
        self.assertAlmostEqual(sh.look_time(999_900, 50.0, 1000.0), 49.9)
        self.assertEqual(sh.look_time(1_000_500, 50.0, 1000.0), 50.0, "a hair in the future is now")
        for bad in (None, "999900", True, float("nan"), float("inf"), 980_000, 1_005_000):
            self.assertIsNone(sh.look_time(bad, 50.0, 1000.0), bad)


class FakeStdout:
    """The encoder's stdout: what is pushed, then EOF on close()."""

    def __init__(self):
        self.queue = asyncio.Queue()

    def push(self, data):
        self.queue.put_nowait(data)

    def close(self):
        self.queue.put_nowait(b"")

    async def read(self, _n):
        return await self.queue.get()


class FakeProc:
    """An encoder process that has already exited: stop() has nothing to kill."""

    returncode = 0

    def __init__(self):
        self.stdout = FakeStdout()

    async def wait(self):
        return 0


class PumpTests(unittest.TestCase):
    """The capture's two tasks with a fake encoder and looks given by hand:
    what reaches the page, and when."""

    def setUp(self):
        self.loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self.loop)
        self.delivered = []
        self.ended = []
        self.fail = False

    def tearDown(self):
        self.loop.close()

    def capture(self):
        async def deliver(au, key):
            if self.fail:
                raise RuntimeError("page gone")
            self.delivered.append((au, key))

        cap = sh.ScreenCapture(deliver, self.ended.append)
        cap.ff = FakeProc()
        return cap

    def wait(self, coro):
        return self.loop.run_until_complete(coro)

    def test_a_unit_goes_only_once_looks_either_side_saw_the_game(self):
        async def go():
            now = asyncio.get_running_loop().time
            cap = self.capture()
            cap.begin()
            cap.look(True, now())
            await asyncio.sleep(0.01)
            cap.ff.stdout.push(key_unit(1) + delta_unit(2) + delta_unit(3))
            await asyncio.sleep(0.06)
            before = list(self.delivered)
            cap.look(True, now())  # the look after them
            await asyncio.sleep(0.02)
            await cap.stop()
            return before

        with Patched(SETTLE_S=0.0):
            before = self.wait(go())
        self.assertEqual(before, [], "nobody has looked since they began")
        self.assertEqual(self.delivered, [(key_unit(1), True), (delta_unit(2), False)], "3 waits for the next delimiter")
        self.assertEqual(self.ended, [], "a stop is not an ending to report")

    def test_a_paused_look_takes_back_what_is_waiting(self):
        async def go():
            now = asyncio.get_running_loop().time
            cap = self.capture()
            cap.begin()
            cap.look(True, now())
            await asyncio.sleep(0.01)
            cap.ff.stdout.push(key_unit(1) + delta_unit(2) + delta_unit(3))
            await asyncio.sleep(0.06)
            cap.look(False, now())  # the menu opened while these waited
            await asyncio.sleep(0.02)
            cap.look(True, now())
            await asyncio.sleep(0.02)
            cap.look(True, now())
            await asyncio.sleep(0.02)
            await cap.stop()

        with Patched(SETTLE_S=0.0):
            self.wait(go())
        self.assertEqual(self.delivered, [], "captured before the pause was seen: never shown")

    def test_a_gap_in_the_looks_takes_back_what_it_covered(self):
        async def go():
            now = asyncio.get_running_loop().time
            cap = self.capture()
            cap.begin()
            cap.look(True, now())
            await asyncio.sleep(0.01)
            cap.ff.stdout.push(key_unit(1) + delta_unit(2) + delta_unit(3))
            await asyncio.sleep(0.12)  # longer than MAX_GAP_S here: a look went missing
            cap.look(True, now())
            await asyncio.sleep(0.02)
            await cap.stop()

        with Patched(SETTLE_S=0.0, MAX_GAP_S=0.1):
            self.wait(go())
        self.assertEqual(self.delivered, [])

    def test_no_looks_no_picture(self):
        async def go():
            now = asyncio.get_running_loop().time
            cap = self.capture()
            cap.begin()
            cap.look(True, now())
            await asyncio.sleep(0.01)
            cap.ff.stdout.push(key_unit(1) + delta_unit(2) + delta_unit(3))
            await asyncio.sleep(0.15)  # Steam too busy to look: they wait, then go
            held = len(cap.line)
            cap.look(True, now())
            await asyncio.sleep(0.02)
            await cap.stop()
            return held

        with Patched(SETTLE_S=0.0, MAX_HOLD_S=0.05, MAX_GAP_S=1.0):
            held = self.wait(go())
        self.assertEqual(held, 0, "nothing waits past MAX_HOLD_S")
        self.assertEqual(self.delivered, [])

    def test_after_a_pause_the_picture_comes_back_at_a_keyframe(self):
        async def go():
            now = asyncio.get_running_loop().time
            cap = self.capture()
            cap.begin()
            cap.look(True, now())
            await asyncio.sleep(0.01)
            cap.ff.stdout.push(key_unit(1) + delta_unit(2))
            await asyncio.sleep(0.06)
            cap.look(True, now())
            await asyncio.sleep(0.02)
            cap.look(False, now())
            await asyncio.sleep(0.01)
            cap.look(True, now())
            await asyncio.sleep(0.01)
            cap.ff.stdout.push(delta_unit(3) + delta_unit(4) + key_unit(5) + delta_unit(6) + key_unit(7))
            await asyncio.sleep(0.06)
            cap.look(True, now())
            await asyncio.sleep(0.02)
            await cap.stop()

        with Patched(SETTLE_S=0.0):
            self.wait(go())
        # 2 began before the pause and 3 and 4 need it, so they are dropped; 7
        # waits for a delimiter that never comes.
        self.assertEqual([au for au, _ in self.delivered], [key_unit(1), key_unit(5), delta_unit(6)])

    def test_a_page_that_keeps_refusing_ends_the_share_once(self):
        async def go():
            now = asyncio.get_running_loop().time
            cap = self.capture()
            cap.begin()
            self.fail = True
            cap.look(True, now())
            for i in range(8):
                cap.ff.stdout.push(key_unit(i) + delta_unit(i))
                await asyncio.sleep(0.02)
                cap.look(True, now())
            await asyncio.sleep(0.05)
            cap.ff.stdout.close()  # and then the feed goes too, before anyone stops it
            await asyncio.sleep(0.02)
            await cap.stop()

        with Patched(SETTLE_S=0.0, PAGE_GONE_S=0.05, LAG_S=0.0):
            self.wait(go())
        self.assertEqual(len(self.ended), 1)
        self.assertIn("stopped taking the picture", self.ended[0])

    def test_the_feed_ending_is_reported(self):
        async def go():
            cap = self.capture()
            cap.begin()
            cap.ff.stdout.close()
            await asyncio.sleep(0.02)
            await cap.stop()

        self.wait(go())
        self.assertEqual(self.ended, ["the screen feed stopped"])


# ---- main.py's share calls, with a stand-in for Decky -------------------------------

def _decky_stub():
    d = types.ModuleType("decky")
    d.emitted = []

    async def emit(event, *args):
        d.emitted.append((event, *args))

    d.emit = emit
    d.logger = types.SimpleNamespace(info=lambda *a, **k: None, warning=lambda *a, **k: None,
                                     exception=lambda *a, **k: None)
    d.DECKY_PLUGIN_SETTINGS_DIR = d.DECKY_PLUGIN_RUNTIME_DIR = d.DECKY_PLUGIN_DIR = HERE
    d.DECKY_PLUGIN_VERSION = "0.0.0"
    return d


EVENTS = []


class FakePage:
    def __init__(self):
        self.calls = []

    async def call_function(self, declaration, args, timeout=15.0, user_gesture=True):
        self.calls.append((declaration, list(args), user_gesture))
        EVENTS.append(("page", declaration))
        return True

    async def detach(self):
        pass


class FakeCapture:
    problem = None
    made = []

    def __init__(self, deliver, ended):
        self.deliver, self.ended = deliver, ended
        self.looks = []
        self.showing = False
        self.began = False
        self.stopped = False
        FakeCapture.made.append(self)

    def look_now(self, showing, at):
        self.looks.append((showing, at))
        changed = showing != self.showing
        self.showing = showing
        return changed

    async def start(self):
        return FakeCapture.problem

    def begin(self):
        self.began = True
        EVENTS.append(("begin", None))

    async def stop(self):
        self.stopped = True


class PluginShareTests(unittest.TestCase):
    def setUp(self):
        self.loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self.loop)
        sys.modules["decky"] = self.decky = _decky_stub()
        sys.modules.pop("main", None)
        import main  # noqa: E402
        self.main = main
        main.ScreenCapture = FakeCapture
        FakeCapture.problem = None
        FakeCapture.made = []
        EVENTS.clear()
        self.plugin = main.Plugin()
        self.page = FakePage()
        self.plugin.page = self.page

    def tearDown(self):
        self.loop.close()
        sys.modules.pop("main", None)

    def wait(self, coro):
        return self.loop.run_until_complete(coro)

    def declarations(self):
        return [d for d, _, _ in self.page.calls]

    def test_refuses_a_bad_id_and_a_missing_page(self):
        self.assertFalse(self.wait(self.plugin.share_start("../x"))["ok"])
        self.plugin.page = None
        self.assertFalse(self.wait(self.plugin.share_start("s1"))["ok"])
        self.assertEqual(FakeCapture.made, [])

    def test_answers_the_page_then_hands_over_the_picture(self):
        r = self.wait(self.plugin.share_start("s1"))
        self.assertEqual(r, {"ok": True, "value": None})
        cap = FakeCapture.made[0]
        self.assertTrue(cap.began)
        self.assertEqual(self.page.calls, [(sh.SHARE_ANSWER, ["s1", True, None, False], False)])
        self.assertEqual(EVENTS, [("page", sh.SHARE_ANSWER), ("begin", None)], "the page has its track before any picture")
        self.assertEqual(self.plugin.share_id, "s1")

    def test_a_capture_that_cannot_start_is_the_pages_answer(self):
        FakeCapture.problem = "no screen to share (the Deck must be in Game Mode)"
        r = self.wait(self.plugin.share_start("s1"))
        self.assertEqual(r, {"ok": False, "error": FakeCapture.problem})
        self.assertEqual(self.page.calls, [(sh.SHARE_ANSWER, ["s1", False, FakeCapture.problem, False], False)])
        self.assertFalse(FakeCapture.made[0].began)
        self.assertIsNone(self.plugin.share)

    def test_one_share_at_a_time(self):
        self.wait(self.plugin.share_start("s1"))
        self.wait(self.plugin.share_start("s2"))
        first, second = FakeCapture.made
        self.assertTrue(first.stopped)
        self.assertIn((sh.SHARE_ENDED, ["s1", "stopped"], False), self.page.calls)
        self.assertEqual(self.plugin.share_id, "s2")
        self.assertFalse(second.stopped)

    def test_the_pages_release_stops_only_its_own_share_and_is_not_echoed(self):
        self.wait(self.plugin.share_start("s1"))
        self.wait(self.plugin.share_stop("s9"))
        self.assertFalse(FakeCapture.made[0].stopped)
        self.page.calls.clear()
        self.wait(self.plugin.share_stop("s1"))
        self.assertTrue(FakeCapture.made[0].stopped)
        self.assertEqual(self.page.calls, [], "the page let go: nothing to tell it")

    def test_the_frontends_stop_tells_the_page(self):
        self.wait(self.plugin.share_start("s1"))
        self.wait(self.plugin.share_stop())
        self.assertTrue(FakeCapture.made[0].stopped)
        self.assertEqual(self.page.calls[-1], (sh.SHARE_ENDED, ["s1", "stopped"], False))

    def test_every_look_reaches_the_capture_and_the_page_hears_only_changes(self):
        self.wait(self.plugin.share_start("s1"))
        cap = FakeCapture.made[0]
        self.page.calls.clear()
        for showing in (False, True, True, "yes", False):
            self.wait(self.plugin.share_seen(showing, 1_700_000_000_000))
        self.assertEqual([s for s, _ in cap.looks], [False, True, True, False, False], "only True is the game alone")
        self.assertEqual(self.page.calls, [(sh.SHARE_PAUSED, ["s1", False], False), (sh.SHARE_PAUSED, ["s1", True], False)])

    def test_looks_with_no_share_do_nothing(self):
        self.wait(self.plugin.share_seen(True, 1_700_000_000_000))
        self.assertEqual(self.page.calls, [])

    def test_a_refusal_is_plain_short_text(self):
        self.wait(self.plugin.share_refuse("s1", "no\x00\n" + "x" * 300))
        decl, args, gesture = self.page.calls[0]
        self.assertEqual((decl, args[:2], args[3], gesture), (sh.SHARE_ANSWER, ["s1", False], True, False), "refused: the person's no")
        self.assertTrue(len(args[2]) <= 200 and "\x00" not in args[2] and "\n" not in args[2])
        self.wait(self.plugin.share_refuse("s2", None))
        self.assertEqual(self.page.calls[-1][1][2], "not allowed")

    def test_the_picture_goes_as_base64_and_never_as_a_persons_action(self):
        self.wait(self.plugin.share_start("s1"))
        self.wait(FakeCapture.made[0].deliver(b"\x00\x00\x01\x09\xf0", True))
        self.assertEqual(self.page.calls[-1], (sh.SHARE_CHUNK, ["s1", "AAABCfA=", True], False))
        self.assertTrue(all(gesture is False for _, _, gesture in self.page.calls))

    def test_a_page_without_the_share_makes_delivery_fail(self):
        self.wait(self.plugin.share_start("s1"))

        async def nothing(*_a, **_k):
            return None

        self.page.call_function = nothing
        with self.assertRaises(Exception):
            self.wait(FakeCapture.made[0].deliver(b"x", False))

    def test_a_share_that_ends_by_itself_is_told_to_the_page_and_the_frontend(self):
        self.wait(self.plugin.share_start("s1"))
        cap = FakeCapture.made[0]
        cap.ended("the screen feed stopped")
        self.wait(asyncio.sleep(0.01))
        self.assertTrue(cap.stopped)
        self.assertIsNone(self.plugin.share)
        self.assertIn((sh.SHARE_ENDED, ["s1", "the screen feed stopped"], False), self.page.calls)
        self.assertIn(("puca_share", {"type": "ended", "id": "s1", "why": "the screen feed stopped"}), self.decky.emitted)

    def test_a_release_while_the_share_starts_still_stops_it(self):
        started = asyncio.Event()
        go_on = asyncio.Event()

        class SlowCapture(FakeCapture):
            async def start(self):
                started.set()
                await go_on.wait()
                return None

        self.main.ScreenCapture = SlowCapture

        async def scene():
            starting = asyncio.ensure_future(self.plugin.share_start("s1"))
            await started.wait()
            stopping = asyncio.ensure_future(self.plugin.share_stop("s1"))  # the page let go meanwhile
            await asyncio.sleep(0.01)
            go_on.set()
            await starting
            await stopping

        self.wait(scene())
        self.assertTrue(FakeCapture.made[0].stopped, "a capture nobody will take must not run on")
        self.assertIsNone(self.plugin.share)

    def test_detaching_the_page_ends_the_share(self):
        self.wait(self.plugin.share_start("s1"))
        self.wait(self.plugin.detach())
        self.assertTrue(FakeCapture.made[0].stopped)
        self.assertIsNone(self.plugin.share)
        self.assertIsNone(self.plugin.page)


if __name__ == "__main__":
    unittest.main()
