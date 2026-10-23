"""The Deck's controls (push to talk, presence, choosing a button), without a
Deck: python -m unittest discover -s tests

The messages are built from the Linux driver's table (drivers/hid/hid-steam.c,
steam_deck_button_mappings), restated here on its own rather than read from
puca_buttons, so a wrong bit there cannot pass by agreeing with itself.
"""
import asyncio
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "py_modules"))

import puca_buttons as pb  # noqa: E402

# hid-steam.c: { BTN_GRIPL, 13, 1 }, { BTN_GRIPR, 13, 2 }, { BTN_GRIPL2, 9, 7 }, { BTN_GRIPR2, 10, 0 }
GRIPS = {"L4": (13, 1), "R4": (13, 2), "L5": (9, 7), "R5": (10, 0)}
# Some of the others: A 8.7, B 8.5, menu 9.6, left/right joystick touched 13.6 / 13.7.
OTHERS = [(8, 7), (8, 5), (9, 6), (13, 6), (13, 7)]


def deck_report(*pressed: str, extra=(), kind: int = 0x09) -> bytes:
    """One 64-byte controller message with the given grips (and other bits) down."""
    r = bytearray(64)
    r[0], r[1], r[2], r[3] = 0x01, 0x00, kind, 0x38
    for byte, bit in [GRIPS[name] for name in pressed] + list(extra):
        r[byte] |= 1 << bit
    return bytes(r)


class ReportTests(unittest.TestCase):
    def test_each_grip_is_read_from_the_drivers_layout(self):
        for name in GRIPS:
            report = deck_report(name)
            for other in GRIPS:
                self.assertEqual(pb.button_held(report, other), other == name, f"{name} down, asked about {other}")

    def test_no_other_button_or_touch_counts(self):
        # Thumbs resting on the sticks set 13.6 / 13.7, next to R4's 13.2.
        self.assertFalse(pb.button_held(deck_report(extra=OTHERS), "R4"))
        everything_but_r4 = bytearray(deck_report())
        for i in range(4, 64):
            everything_but_r4[i] = 0xFF
        everything_but_r4[13] &= ~(1 << 2) & 0xFF
        self.assertFalse(pb.button_held(bytes(everything_but_r4), "R4"))
        self.assertTrue(pb.button_held(deck_report("R4", extra=OTHERS), "R4"))

    def test_only_the_decks_input_state_counts(self):
        self.assertIsNone(pb.button_held(deck_report("R4", kind=0x01), "R4"))  # a Steam Controller's state
        self.assertIsNone(pb.button_held(deck_report("R4", kind=0x04), "R4"))  # battery
        self.assertIsNone(pb.button_held(deck_report("R4")[:63], "R4"))
        self.assertIsNone(pb.button_held(deck_report("R4") + b"\0", "R4"))
        bad = bytearray(deck_report("R4"))
        bad[0] = 0x02
        self.assertIsNone(pb.button_held(bytes(bad), "R4"))

    def test_finds_only_the_decks_controller(self):
        with tempfile.TemporaryDirectory() as root:
            def node(name, uevent):
                os.makedirs(os.path.join(root, name, "device"))
                if uevent is not None:
                    with open(os.path.join(root, name, "device", "uevent"), "w", encoding="utf-8") as f:
                        f.write(uevent)
            node("hidraw0", "DRIVER=steam\nHID_ID=0003:000028DE:00001205\nHID_NAME=Valve Software Steam Controller\n")
            node("hidraw2", "HID_ID=0003:000028de:00001205\n")  # case does not matter
            node("hidraw3", "HID_ID=0018:00002808:00001015\nHID_NAME=FTS3528:00 2808:1015\n")  # the touchscreen
            node("hidraw4", None)  # no uevent at all
            self.assertEqual(pb.deck_controller_nodes(root, "/dev"),
                             [os.path.join("/dev", "hidraw0"), os.path.join("/dev", "hidraw2")])
        self.assertEqual(pb.deck_controller_nodes(os.path.join(HERE, "no-such-directory"), "/dev"), [])

    def test_an_unknown_button_is_refused(self):
        with self.assertRaises(ValueError):
            pb.InputWatch("A", lambda name, held: None, io=FakeIO())


class FakeHandle:
    def __init__(self):
        self.cancelled = False

    def cancel(self):
        self.cancelled = True


class FakeIO:
    """hidraw nodes and a clock under the test's control."""

    def __init__(self, nodes=("/dev/hidraw0", "/dev/hidraw2")):
        self.node_list = list(nodes)
        self.denied = set()
        self.fds = {}
        self.queues = {}
        self.readers = {}
        self.closed = []
        self.timers = []
        self.t = 100.0
        self._next_fd = 3

    # The ButtonWatch side.
    def nodes(self):
        return list(self.node_list)

    def open(self, path):
        if path in self.denied:
            raise PermissionError(path)
        fd = self._next_fd
        self._next_fd += 1
        self.fds[path] = fd
        self.queues[fd] = []
        return fd

    def watch(self, fd, on_readable):
        self.readers[fd] = on_readable

    def unwatch(self, fd):
        self.readers.pop(fd, None)

    def read(self, fd):
        q = self.queues[fd]
        if not q:
            return None
        item = q.pop(0)
        if isinstance(item, BaseException):
            raise item
        return item

    def close(self, fd):
        self.closed.append(fd)

    def later(self, delay, fn):
        handle = FakeHandle()
        self.timers.append((self.t + delay, len(self.timers), fn, handle))
        return handle

    def now(self):
        return self.t

    # The test side.
    def deliver(self, path, *items):
        fd = self.fds[path]
        self.queues[fd].extend(items)
        self.readers[fd]()

    def advance(self, seconds):
        """Move the clock, firing what comes due, in order."""
        end = self.t + seconds
        while True:
            due = sorted(t for t in self.timers if not t[3].cancelled and t[0] <= end)
            if not due:
                break
            when, _, fn, handle = due[0]
            handle.cancelled = True  # fired
            self.t = when
            fn()
        self.t = end

    def pending(self):
        return [t for t in self.timers if not t[3].cancelled]


class WatchTests(unittest.TestCase):
    def make(self, button="R4", **kw):
        io = FakeIO(**kw)
        got = []
        return io, got, pb.InputWatch(button, lambda name, held: got.append(held), io=io)

    def test_down_then_a_heartbeat_every_half_second_then_up(self):
        io, got, w = self.make()
        self.assertIsNone(w.start())
        io.deliver("/dev/hidraw2", deck_report())
        self.assertEqual(got, [])
        io.deliver("/dev/hidraw2", deck_report("R4"))
        self.assertEqual(got, [True])
        for _ in range(8):  # held for 2 s while the controller keeps reporting
            io.advance(0.25)
            io.deliver("/dev/hidraw2", deck_report("R4"))
        self.assertEqual(got, [True] * 5)
        io.deliver("/dev/hidraw2", deck_report())
        self.assertEqual(got, [True] * 5 + [False])
        io.advance(5)
        self.assertEqual(got, [True] * 5 + [False], "nothing after the release")

    def test_other_buttons_never_talk(self):
        io, got, w = self.make("R4")
        w.start()
        io.deliver("/dev/hidraw2", deck_report("L4"), deck_report("R5"), deck_report("L5"), deck_report(extra=OTHERS))
        self.assertEqual(got, [])
        io.deliver("/dev/hidraw2", deck_report("R4"))
        self.assertEqual(got, [True])

    def test_a_controller_that_stops_reporting_is_not_a_held_button(self):
        io, got, w = self.make()
        w.start()
        io.deliver("/dev/hidraw2", deck_report("R4"))
        io.advance(1.0)  # silence: two heartbeats are still inside the 1 s grace
        self.assertEqual(got, [True, True, True])
        io.advance(0.5)
        self.assertEqual(got, [True, True, True, False])
        io.advance(5)
        self.assertEqual(got, [True, True, True, False])

    def test_a_node_that_goes_away_lets_go_and_is_found_again(self):
        io, got, w = self.make()
        w.start()
        first = io.fds["/dev/hidraw2"]
        io.deliver("/dev/hidraw2", deck_report("R4"))
        io.deliver("/dev/hidraw2", OSError(19, "No such device"))
        self.assertEqual(got, [True, False])
        self.assertIn(first, io.closed)
        io.advance(2.0)  # the rescan opens it again
        self.assertNotEqual(io.fds["/dev/hidraw2"], first)
        io.deliver("/dev/hidraw2", deck_report("R4"))
        self.assertEqual(got, [True, False, True])

    def test_end_of_file_lets_go(self):
        io, got, w = self.make()
        w.start()
        io.deliver("/dev/hidraw2", deck_report("R4"))
        io.deliver("/dev/hidraw2", b"")
        self.assertEqual(got, [True, False])

    def test_quiet_open_nodes_are_reopened(self):
        # Over a suspend the streaming node can be replaced while the silent
        # ones stay open: no input state for over a second starts over.
        io, got, w = self.make()
        w.start()
        old = dict(io.fds)
        io.deliver("/dev/hidraw2", deck_report())
        io.advance(2.0)
        self.assertEqual(sorted(io.closed), sorted(old.values()))
        self.assertTrue(all(io.fds[p] != old[p] for p in old))
        io.deliver("/dev/hidraw2", deck_report("R4"))
        self.assertEqual(got, [True])

    def test_stop_lets_go_closes_everything_and_leaves_no_timer(self):
        io, got, w = self.make()
        w.start()
        io.deliver("/dev/hidraw2", deck_report("R4"))
        w.stop()
        self.assertEqual(got, [True, False])
        self.assertEqual(sorted(io.closed), sorted(io.fds.values()))
        self.assertEqual(io.readers, {})
        self.assertEqual(io.pending(), [])
        io.advance(10)
        self.assertEqual(got, [True, False])

    def test_no_controller_is_said_and_it_is_found_later(self):
        io, got, w = self.make(nodes=())
        self.assertEqual(w.start(), "no-controller")
        io.node_list = ["/dev/hidraw2"]
        io.advance(2.0)
        io.deliver("/dev/hidraw2", deck_report("R4"))
        self.assertEqual(got, [True])

    def test_no_access_is_said_and_it_keeps_trying(self):
        io, got, w = self.make(nodes=("/dev/hidraw2",))
        io.denied = {"/dev/hidraw2"}
        self.assertEqual(w.start(), "no-access")
        io.advance(2.0)
        self.assertNotIn("/dev/hidraw2", io.fds)
        io.denied = set()
        io.advance(2.0)
        io.deliver("/dev/hidraw2", deck_report("R4"))
        self.assertEqual(got, [True])


class SeveralGripsTests(unittest.TestCase):
    """Push to talk, mute and deafen can each have a back grip: each is
    followed on its own, and says its own name."""

    def make(self, buttons=("R5", "L4")):
        io = FakeIO()
        got = []
        return io, got, pb.InputWatch(buttons, lambda name, held: got.append((name, held)), io=io)

    def test_each_grip_on_its_own(self):
        io, got, w = self.make()
        w.start()
        io.deliver("/dev/hidraw2", deck_report("R5"))
        self.assertEqual(got, [("R5", True)])
        io.deliver("/dev/hidraw2", deck_report("R5", "L4"))
        self.assertEqual(got, [("R5", True), ("L4", True)])
        io.advance(0.5)  # a heartbeat each, while both stay down
        io.deliver("/dev/hidraw2", deck_report("R5", "L4"))
        self.assertEqual(sorted(got[2:]), [("L4", True), ("R5", True)])
        del got[:]
        io.deliver("/dev/hidraw2", deck_report("L4"))
        self.assertEqual(got, [("R5", False)], "R5 let go; L4 still down says nothing new")
        io.deliver("/dev/hidraw2", deck_report())
        self.assertEqual(got, [("R5", False), ("L4", False)])

    def test_a_grip_without_a_job_says_nothing(self):
        io, got, w = self.make(("R5",))
        w.start()
        io.deliver("/dev/hidraw2", deck_report("L4"), deck_report("R4"), deck_report("L5"))
        self.assertEqual(got, [])

    def test_silence_and_stop_let_every_held_grip_go(self):
        io, got, w = self.make()
        w.start()
        io.deliver("/dev/hidraw2", deck_report("R5", "L4"))
        io.advance(1.5)  # the controller stopped reporting
        self.assertIn(("R5", False), got)
        self.assertIn(("L4", False), got)
        del got[:]
        io.deliver("/dev/hidraw2", deck_report("R5"))
        w.stop()
        self.assertEqual(got, [("R5", True), ("R5", False)])
        self.assertEqual(io.pending(), [])

    def test_a_name_twice_is_one_grip_and_an_unknown_one_is_refused(self):
        io, got, w = self.make(("R5", "R5"))
        self.assertEqual(w.buttons, ("R5",))
        with self.assertRaises(ValueError):
            pb.InputWatch(("R5", "X9"), lambda name, held: None, io=FakeIO())


N2 = "/dev/hidraw2"


class ControlsTests(unittest.TestCase):
    def test_grips_held_names_every_grip_down(self):
        self.assertEqual(pb.grips_held(deck_report()), frozenset())
        self.assertEqual(pb.grips_held(deck_report("R5", "L4")), frozenset({"R5", "L4"}))
        self.assertIsNone(pb.grips_held(deck_report("R5", kind=0x01)))

    def test_in_use_means_a_control_the_driver_names_or_a_touch(self):
        self.assertFalse(pb.controls_in_use(deck_report()))
        # A, B, d-pad up, Menu, both pad touches, L3, R3, both stick touches, Quick Access.
        for byte, bit in [(8, 7), (8, 5), (9, 0), (9, 6), (10, 3), (10, 4), (10, 6), (11, 2), (13, 6), (13, 7), (14, 2)]:
            self.assertTrue(pb.controls_in_use(deck_report(extra=[(byte, bit)])), (byte, bit))
        for name in GRIPS:
            self.assertTrue(pb.controls_in_use(deck_report(name)), name)
        # Bits the driver lists as unknown, and the motion/analogue bytes, are not.
        for byte, bit in [(10, 5), (10, 7), (11, 0), (12, 3), (13, 0), (13, 3), (14, 0), (20, 1), (40, 0)]:
            self.assertFalse(pb.controls_in_use(deck_report(extra=[(byte, bit)])), (byte, bit))
        self.assertIsNone(pb.controls_in_use(deck_report(kind=0x04)))


class PresenceTests(unittest.TestCase):
    def make(self, button=None):
        io = FakeIO()
        got, seen = [], []
        return io, got, seen, pb.InputWatch(button, lambda name, held: got.append(held), lambda: seen.append(io.t), io=io)

    def test_in_use_is_said_at_once_then_at_most_every_ten_seconds(self):
        io, got, seen, w = self.make()
        w.start()
        io.deliver(N2, deck_report())
        self.assertEqual(seen, [], "nothing touched")
        thumb = deck_report(extra=[(13, 6)])  # a thumb resting on the left stick
        io.deliver(N2, thumb)
        self.assertEqual(seen, [100.0])
        for _ in range(20):  # five seconds of play
            io.advance(0.25)
            io.deliver(N2, thumb)
        self.assertEqual(seen, [100.0])
        for _ in range(24):  # six more
            io.advance(0.25)
            io.deliver(N2, thumb)
        self.assertEqual(len(seen), 2)
        self.assertGreaterEqual(seen[1] - seen[0], 10.0)
        self.assertEqual(got, [], "no push-to-talk button chosen: nothing is ever held")

    def test_untouched_controls_say_nothing(self):
        io, got, seen, w = self.make()
        w.start()
        for _ in range(40):
            io.advance(0.25)
            io.deliver(N2, deck_report())
        self.assertEqual(seen, [])

    def test_without_push_to_talk_the_stream_still_counts_as_the_controller_being_there(self):
        # The input state, not a button, is what proves the node is alive:
        # a presence-only watch must not reopen its nodes every two seconds.
        io, got, seen, w = self.make()
        w.start()
        old = dict(io.fds)
        for _ in range(16):
            io.advance(0.25)
            io.deliver(N2, deck_report())
        self.assertEqual(io.closed, [])
        self.assertEqual(io.fds, old)

    def test_push_to_talk_and_presence_together(self):
        io, got, seen, w = self.make("R5")
        w.start()
        io.deliver(N2, deck_report("R5"))
        self.assertEqual(got, [True])
        self.assertEqual(seen, [100.0], "the grip held is a control in use too")
        io.deliver(N2, deck_report())
        self.assertEqual(got, [True, False])

    def test_a_watch_with_no_presence_callback_is_fine(self):
        io = FakeIO()
        got = []
        w = pb.InputWatch("R5", lambda name, held: got.append(held), io=io)
        w.start()
        io.deliver(N2, deck_report("R5", extra=[(13, 6)]))
        self.assertEqual(got, [True])


class LearnTests(unittest.TestCase):
    def make(self, nodes=("/dev/hidraw0", N2)):
        io = FakeIO(nodes)
        got = []
        return io, got, pb.GripLearner(got.append, io=io)

    def test_the_first_grip_pressed_is_the_answer_once(self):
        io, got, learner = self.make()
        self.assertIsNone(learner.start())
        io.deliver(N2, deck_report())
        io.deliver(N2, deck_report(extra=OTHERS))
        self.assertEqual(got, [], "A, B, Menu and stick touches are not back grips")
        io.deliver(N2, deck_report("R5"))
        self.assertEqual(got, ["R5"])
        io.deliver(N2, deck_report())
        io.deliver(N2, deck_report("R4"))
        self.assertEqual(got, ["R5"])

    def test_a_grip_already_held_counts_only_when_pressed_again(self):
        io, got, learner = self.make()
        learner.start()
        io.deliver(N2, deck_report("L4"))
        io.deliver(N2, deck_report("L4"))
        self.assertEqual(got, [])
        io.deliver(N2, deck_report())
        io.deliver(N2, deck_report("L4"))
        self.assertEqual(got, ["L4"])

    def test_two_grips_at_once_answer_the_same_one_every_time(self):
        io, got, learner = self.make()
        learner.start()
        io.deliver(N2, deck_report())
        io.deliver(N2, deck_report("R5", "L5"))
        self.assertEqual(got, ["L5"])

    def test_it_says_why_it_cannot_read(self):
        _, _, learner = self.make(nodes=())
        self.assertEqual(learner.start(), "no-controller")
        io, _, learner = self.make(nodes=(N2,))
        io.denied = {N2}
        self.assertEqual(learner.start(), "no-access")

    def test_stop_closes_everything(self):
        io, _, learner = self.make()
        learner.start()
        learner.stop()
        self.assertEqual(sorted(io.closed), sorted(io.fds.values()))
        self.assertEqual(io.readers, {})

    def test_a_node_that_goes_away_is_dropped(self):
        io, got, learner = self.make()
        learner.start()
        gone = io.fds[N2]
        io.deliver(N2, deck_report())
        io.deliver(N2, OSError(19, "No such device"))
        self.assertIn(gone, io.closed)
        self.assertEqual(got, [])


@unittest.skipUnless(sys.platform.startswith("linux"), "reads a file descriptor on the asyncio loop, as on the Deck (Linux)")
class RunningLoopTests(unittest.TestCase):
    def test_reads_on_the_running_loop(self):
        async def scenario():
            r, w = os.pipe()
            os.set_blocking(r, False)

            class PipeIO(pb.HidrawIO):
                def nodes(self):
                    return ["pipe"]

                def open(self, path):
                    return r

            got = []
            watch = pb.InputWatch("R4", lambda name, held: got.append(held), io=PipeIO(), heartbeat_s=0.05)
            self.assertIsNone(watch.start())
            os.write(w, deck_report("R4"))
            await asyncio.sleep(0.3)
            os.write(w, deck_report())
            await asyncio.sleep(0.1)
            watch.stop()
            os.close(w)
            return got

        got = asyncio.run(scenario())
        self.assertEqual(got[0], True)
        self.assertGreaterEqual(got.count(True), 2, "at least one heartbeat while held")
        self.assertEqual(got[-1], False)
        self.assertEqual(got.count(False), 1)


if __name__ == "__main__":
    unittest.main()
