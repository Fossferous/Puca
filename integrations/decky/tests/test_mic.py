"""The Deck's microphone switched on for calls (py_modules/puca_mic.py),
against a stand-in for wpctl: python -m unittest discover -s tests
"""
import asyncio
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "py_modules"))

import puca_mic as pm  # noqa: E402


class FakeWpctl:
    """The default source's volume and mute, as wpctl would show and change them."""

    def __init__(self, volume=0.08, muted=True, fail=()):
        self.volume, self.muted = volume, muted
        self.calls = []
        self.fail = set(fail)

    async def __call__(self, args):
        self.calls.append(list(args))
        if args[0] in self.fail:
            return 1, "failed"
        if args[0] == "get-volume":
            return 0, f"Volume: {self.volume:.2f}{' [MUTED]' if self.muted else ''}\n"
        if args[0] == "set-mute":
            self.muted = args[2] == "1"
            return 0, ""
        if args[0] == "set-volume":
            self.volume = float(args[2])
            return 0, ""
        return 1, "unknown"


def run(coro):
    return asyncio.run(coro)


class ParseTests(unittest.TestCase):
    def test_wpctl_output(self):
        self.assertEqual(pm.parse_volume("Volume: 0.08 [MUTED]\n"), (0.08, True))
        self.assertEqual(pm.parse_volume("Volume: 1.00"), (1.0, False))
        for bad in ("", "nothing", "Volume: loud", "Volume: 0.5 [MUTED] extra"):
            self.assertIsNone(pm.parse_volume(bad), bad)

    def test_the_plan_changes_only_what_is_off(self):
        self.assertEqual(pm.plan_for_call(0.8, False), {})
        self.assertEqual(pm.plan_for_call(0.02, False), {}, "unmuted, however quiet: the person chose it")
        self.assertEqual(pm.plan_for_call(0.08, True), {"muted": True})
        self.assertEqual(pm.plan_for_call(0.0, True), {"muted": True, "volume": 0.0})


class CallTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()

    def test_muted_is_switched_on_for_the_call_and_muted_again_after(self):
        w = FakeWpctl(0.08, True)
        m = pm.MicForCalls(self.dir, w)
        self.assertEqual(run(m.turn_on()), {"changed": True, "volume": 0.08})
        self.assertEqual((w.volume, w.muted), (0.08, False))
        self.assertTrue(os.path.exists(m.path), "the change is written down before the call goes on")
        self.assertTrue(run(m.put_back()))
        self.assertEqual((w.volume, w.muted), (0.08, True))
        self.assertFalse(os.path.exists(m.path))

    def test_a_microphone_at_the_bottom_is_raised_and_lowered_again(self):
        w = FakeWpctl(0.0, True)
        m = pm.MicForCalls(self.dir, w)
        self.assertEqual(run(m.turn_on()), {"changed": True, "volume": pm.CALL_VOLUME})
        self.assertEqual((w.volume, w.muted), (pm.CALL_VOLUME, False))
        run(m.put_back())
        self.assertEqual((w.volume, w.muted), (0.0, True))

    def test_one_that_is_on_is_left_alone_both_ways(self):
        w = FakeWpctl(0.6, False)
        m = pm.MicForCalls(self.dir, w)
        self.assertEqual(run(m.turn_on()), {"changed": False})
        self.assertFalse(run(m.put_back()))
        self.assertEqual((w.volume, w.muted), (0.6, False))
        self.assertEqual([c[0] for c in w.calls], ["get-volume"], "nothing but a look")

    def test_a_change_the_person_made_during_the_call_is_kept(self):
        w = FakeWpctl(0.0, True)
        m = pm.MicForCalls(self.dir, w)
        run(m.turn_on())
        w.volume = 0.7  # turned to their liking mid-call
        self.assertFalse(run(m.put_back()))
        self.assertEqual((w.volume, w.muted), (0.7, False))
        w2 = FakeWpctl(0.08, True)
        m2 = pm.MicForCalls(self.dir, w2)
        run(m2.turn_on())
        w2.muted = True  # muted it again themselves
        self.assertFalse(run(m2.put_back()))
        self.assertTrue(w2.muted)

    def test_switching_on_twice_in_one_call_changes_nothing_more(self):
        w = FakeWpctl(0.08, True)
        m = pm.MicForCalls(self.dir, w)
        run(m.turn_on())
        before = list(w.calls)
        self.assertEqual(run(m.turn_on()), {"changed": True})
        self.assertEqual(w.calls, before)

    def test_a_plugin_that_died_mid_call_puts_it_back_next_time(self):
        w = FakeWpctl(0.08, True)
        run(pm.MicForCalls(self.dir, w).turn_on())  # ... and the process dies here
        self.assertFalse(w.muted)
        fresh = pm.MicForCalls(self.dir, w)  # the next start
        self.assertTrue(run(fresh.put_back()))
        self.assertTrue(w.muted)
        self.assertFalse(os.path.exists(fresh.path))

    def test_a_damaged_note_changes_nothing(self):
        with open(os.path.join(self.dir, pm.RESTORE_FILE), "w") as f:
            f.write("{not json")
        w = FakeWpctl(0.5, False)
        self.assertFalse(run(pm.MicForCalls(self.dir, w).put_back()))
        self.assertEqual((w.volume, w.muted), (0.5, False))

    def test_wpctl_that_cannot_be_read_or_set_is_an_error_not_a_guess(self):
        m = pm.MicForCalls(self.dir, FakeWpctl(fail={"get-volume"}))
        with self.assertRaises(RuntimeError):
            run(m.turn_on())
        w = FakeWpctl(0.08, True, fail={"set-mute"})
        m = pm.MicForCalls(self.dir, w)
        with self.assertRaises(RuntimeError):
            run(m.turn_on())
        self.assertTrue(os.path.exists(m.path), "written down first, so a later put_back still knows")


if __name__ == "__main__":
    unittest.main()
