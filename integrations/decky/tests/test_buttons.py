"""The back-button reader (push-to-talk), without a Deck:
python -m unittest discover -s tests

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
            pb.ButtonWatch("A", lambda held: None, io=FakeIO())


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
        return io, got, pb.ButtonWatch(button, got.append, io=io)

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
            watch = pb.ButtonWatch("R4", got.append, io=PipeIO(), heartbeat_s=0.05)
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
