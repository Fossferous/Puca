package com.sovereign.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertNotNull;

import org.junit.Test;

import java.util.Map;

/**
 * Wire frame -> notification data, under plain JUnit (real org.json on the
 * test classpath — the android.jar stub throws).
 *
 * Two properties carry the weight:
 *  - the collapse keys are byte-identical to the JS side's notifyKey, which
 *    is what makes a native-posted and a JS-posted notification for the same
 *    conversation REPLACE each other instead of stacking;
 *  - a DM frame's `content` (ciphertext) never reaches the output. The body
 *    is the fixed string "New message", always.
 */
public class PushFramesTest {

    @Test
    public void aChannelPingBecomesAContentFreeNotification() {
        Map<String, String> d = PushFrames.toData(
                "{\"type\":\"MessageNotification\",\"payload\":{" +
                "\"server_id\":\"srv-abc\",\"channel_id\":42,\"message_id\":\"m1\"," +
                "\"author\":{\"id\":7,\"username\":\"alice\"}}}");
        assertNotNull(d);
        assertEquals("chan", d.get("kind"));
        assertEquals("chan:srv-abc", d.get("key")); // = JS notifyKey, byte for byte
        assertEquals("alice sent a message", d.get("title"));
        assertEquals("New message", d.get("body"));
        assertEquals("server:srv-abc", d.get("nav"));
        assertEquals("7", d.get("author_id"));
        assertEquals("42", d.get("channel_id"));
    }

    @Test
    public void aDmBecomesANotificationWithoutItsContent() {
        String secret = "ciphertext-that-must-never-surface";
        Map<String, String> d = PushFrames.toData(
                "{\"type\":\"DirectMessage\",\"payload\":{" +
                "\"message_id\":\"m2\",\"conversation_id\":\"conv-9\"," +
                "\"sender\":{\"id\":7,\"username\":\"bob\"}," +
                "\"content\":\"" + secret + "\",\"timestamp\":123}}");
        assertNotNull(d);
        assertEquals("dm:conv-9", d.get("key"));
        assertEquals("bob sent you a message", d.get("title"));
        assertEquals("New message", d.get("body"));
        // THE guard: no value in the map carries the content.
        for (String v : d.values()) assertFalse(v.contains(secret));
    }

    @Test
    public void theDmMappingIsPinnedFieldForField() {
        // REGRESSION PIN for the frame that shipped first: adding new frame
        // types must not shift a single key or character of this one. Asserts
        // the WHOLE map, so an extra key is a failure too (an added field is
        // how content leaks back in).
        Map<String, String> d = PushFrames.toData(
                "{\"type\":\"DirectMessage\",\"payload\":{" +
                "\"message_id\":\"m2\",\"conversation_id\":\"conv-9\"," +
                "\"sender\":{\"id\":7,\"username\":\"bob\"}," +
                "\"content\":\"secret\",\"timestamp\":123}}");
        assertNotNull(d);
        Map<String, String> expected = new java.util.HashMap<>();
        expected.put("kind", "dm");
        expected.put("key", "dm:conv-9");
        expected.put("title", "bob sent you a message");
        expected.put("body", "New message");
        expected.put("nav", "dm:conv-9");
        expected.put("author_id", "7");
        assertEquals(expected, d);
    }

    @Test
    public void bothClipDoorbellsBecomeTheSameContentFreePrompt() {
        // ClipProposed (live) and ClipPending (parked for this socket while the
        // phone was offline) are the same prompt: identical key, so whichever
        // arrives second REPLACES the first instead of stacking a duplicate.
        String[] frames = {
            "{\"type\":\"ClipProposed\",\"payload\":{\"clip_id\":\"c-42\",\"expires_in_ms\":1800000}}",
            "{\"type\":\"ClipPending\",\"payload\":{\"clip_id\":\"c-42\"}}",
        };
        for (String f : frames) {
            Map<String, String> d = PushFrames.toData(f);
            assertNotNull(f, d);
            assertEquals("clip", d.get("kind"));
            assertEquals("clip:c-42", d.get("key")); // = JS notifyKey, byte for byte
            assertEquals("clip:c-42", d.get("nav"));
            // The exact strings clipProposals.ts posts — spelled out here, not
            // read from the constant, so a "clearer wording" edit on either
            // side has to come through this test.
            assertEquals("Approval needed", d.get("title"));
            assertEquals("Open Puca to approve or decline", d.get("body"));
            // Names nobody: the frame carries no proposer, and the gate's
            // author checks must see the author-less sentinel.
            assertEquals("-1", d.get("author_id"));
            // No channel surface at all — nothing for a mute to match on.
            assertNull(d.get("server_id"));
            assertNull(d.get("channel_id"));
        }
    }

    @Test
    public void aClipDoorbellLeaksNothingEvenIfTheFrameGrowsFields() {
        // A server (or a tampered frame) that starts naming names must not put
        // any of it on a lock screen: this parser reads clip_id and nothing
        // else. A stolen phone learns that an answer is wanted, full stop.
        Map<String, String> d = PushFrames.toData(
                "{\"type\":\"ClipProposed\",\"payload\":{\"clip_id\":\"c-7\"," +
                "\"expires_in_ms\":1800000," +
                "\"proposer\":{\"id\":7,\"username\":\"mallory\"}," +
                "\"voice_channel_name\":\"Late Night\",\"server_name\":\"Secret Guild\"," +
                "\"title\":\"mallory wants to post a clip of you\"," +
                "\"body\":\"from Late Night\"}}");
        assertNotNull(d);
        assertEquals("Approval needed", d.get("title"));
        assertEquals("Open Puca to approve or decline", d.get("body"));
        assertEquals("clip:c-7", d.get("key"));
        assertEquals("clip:c-7", d.get("nav"));
        for (String leak : new String[] { "mallory", "Late Night", "Secret Guild" }) {
            for (String v : d.values()) assertFalse(leak + " leaked into " + v, v.contains(leak));
        }
    }

    @Test
    public void aClipDoorbellWithoutAnIdIsDropped() {
        // Nothing to hydrate and nothing to navigate to: a prompt the user
        // cannot answer is worse than no prompt.
        assertNull(PushFrames.toData("{\"type\":\"ClipProposed\",\"payload\":{\"expires_in_ms\":1800000}}"));
        assertNull(PushFrames.toData("{\"type\":\"ClipProposed\",\"payload\":{\"clip_id\":\"\"}}"));
        assertNull(PushFrames.toData("{\"type\":\"ClipPending\",\"payload\":{}}"));
        assertNull(PushFrames.toData("{\"type\":\"ClipPending\"}")); // no payload
    }

    @Test
    public void aClipPromptSurvivesTheGateAndAnEnvelopeFromABlockedProposer() {
        // The full native path in miniature for a consent prompt, including
        // the carve-out: a block must not answer the question by silence.
        Map<String, String> d = PushFrames.toData(
                "{\"type\":\"ClipProposed\",\"payload\":{\"clip_id\":\"c-1\",\"expires_in_ms\":1800000}}");
        assertNotNull(d);
        d.put("recipient_id", "9"); // stamped by NativeDelivery from its auth
        java.util.Set<String> blocked = new java.util.HashSet<>();
        blocked.add("7");
        assertNull(PushGate.suppressReason("9", true,
                new java.util.HashMap<>(), new java.util.HashSet<>(), blocked, d));
    }

    @Test
    public void everyOtherFrameTypeIsIgnored() {
        assertNull(PushFrames.toData("{\"type\":\"Pong\"}"));
        assertNull(PushFrames.toData(
                "{\"type\":\"StreamStarted\",\"payload\":{\"room_id\":\"voice_1\"," +
                "\"streamer\":{\"id\":1,\"username\":\"a\"}}}"));
        assertNull(PushFrames.toData(
                "{\"type\":\"Typing\",\"payload\":{\"room_id\":\"channel_1\"}}"));
        // The other two clip frames are progress reports for an app that is
        // already open, not doorbells. Buzzing a pocket for "1 of 3 approved"
        // or for a resolution nobody is waiting on is noise.
        assertNull(PushFrames.toData(
                "{\"type\":\"ClipVoteUpdate\",\"payload\":{\"clip_id\":\"c1\"," +
                "\"approved_count\":1,\"total\":3}}"));
        assertNull(PushFrames.toData(
                "{\"type\":\"ClipResolved\",\"payload\":{\"clip_id\":\"c1\",\"outcome\":\"approved\"}}"));
    }

    @Test
    public void malformedFramesDropInsteadOfCrashingTheSocket() {
        assertNull(PushFrames.toData("not json at all"));
        assertNull(PushFrames.toData("{\"type\":\"DirectMessage\"}")); // no payload
        assertNull(PushFrames.toData(
                "{\"type\":\"MessageNotification\",\"payload\":{\"channel_id\":1}}")); // no server/author
    }

    @Test
    public void gateAndFramesComposeEndToEnd() {
        // The full native path in miniature: frame -> data -> PushGate verdict.
        Map<String, String> d = PushFrames.toData(
                "{\"type\":\"DirectMessage\",\"payload\":{" +
                "\"message_id\":\"m3\",\"conversation_id\":\"conv-1\"," +
                "\"sender\":{\"id\":7,\"username\":\"bob\"},\"content\":\"x\",\"timestamp\":1}}");
        assertNotNull(d);
        d.put("recipient_id", "9"); // stamped by NativeDelivery from its auth
        assertNull(PushGate.suppressReason("9", true,
                new java.util.HashMap<>(), new java.util.HashSet<>(),
                new java.util.HashSet<>(), d));
        // And the account gate still bites on a stale socket after a switch.
        assertEquals("wrong-account", PushGate.suppressReason("5", true,
                new java.util.HashMap<>(), new java.util.HashSet<>(),
                new java.util.HashSet<>(), d));
    }
}
