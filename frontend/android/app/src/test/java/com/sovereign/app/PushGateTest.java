package com.sovereign.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

/**
 * The push suppression matrix, under plain JUnit — no device, no Firebase.
 *
 * These gates are the entire reason the server sends data messages instead of
 * letting the system tray render `notification` messages: if any of them stops
 * firing, muted servers buzz and blocked people reach lock screens. So each
 * suppression has a sibling positive control proving the rig can also say yes.
 */
public class PushGateTest {

    private static Map<String, String> chan(String recipient, String author, String server, String channel) {
        Map<String, String> d = new HashMap<>();
        d.put("kind", "chan");
        d.put("recipient_id", recipient);
        d.put("author_id", author);
        d.put("server_id", server);
        d.put("channel_id", channel);
        return d;
    }

    private static Map<String, String> dm(String recipient, String author) {
        Map<String, String> d = new HashMap<>();
        d.put("kind", "dm");
        d.put("recipient_id", recipient);
        d.put("author_id", author);
        return d;
    }

    /** A clip consent doorbell as PushFrames emits it: no server, no channel,
     *  and the author-less sentinel where an author id would be. */
    private static Map<String, String> clip(String recipient) {
        Map<String, String> d = new HashMap<>();
        d.put("kind", "clip");
        d.put("recipient_id", recipient);
        d.put("author_id", "-1");
        return d;
    }

    private static final Map<String, String> NO_MUTES = new HashMap<>();
    private static final Set<String> NONE = new HashSet<>();

    @Test
    public void anUngatedChannelMessageShows() {
        // POSITIVE CONTROL for everything below.
        assertNull(PushGate.suppressReason("9", true, NO_MUTES, NONE, NONE, chan("9", "7", "srv", "42")));
    }

    @Test
    public void aPushForAnotherAccountIsDropped() {
        // An in-flight push landing after an account switch must not put the
        // previous user's conversations on this account's lock screen.
        assertEquals("wrong-account",
                PushGate.suppressReason("9", true, NO_MUTES, NONE, NONE, chan("5", "7", "srv", "42")));
    }

    @Test
    public void noSignedInAccountDropsEverything() {
        assertEquals("wrong-account",
                PushGate.suppressReason(null, true, NO_MUTES, NONE, NONE, chan("9", "7", "srv", "42")));
    }

    @Test
    public void theMasterSwitchWins() {
        assertEquals("push-disabled",
                PushGate.suppressReason("9", false, NO_MUTES, NONE, NONE, chan("9", "7", "srv", "42")));
    }

    @Test
    public void yourOwnEchoNeverNotifiesYou() {
        // The server echoes every sent DM back to its sender; the delivery
        // socket receives that echo like any frame. Without this gate the
        // sender's own phone buzzed "you sent yourself a message".
        assertEquals("self-authored",
                PushGate.suppressReason("9", true, NO_MUTES, NONE, NONE, dm("9", "9")));
        // Positive control: someone ELSE's message still shows.
        assertNull(PushGate.suppressReason("9", true, NO_MUTES, NONE, NONE, dm("9", "7")));
    }

    @Test
    public void aBlockedAuthorNeverReachesTheShade() {
        Set<String> blocked = new HashSet<>();
        blocked.add("7");
        assertEquals("blocked-author",
                PushGate.suppressReason("9", true, NO_MUTES, NONE, blocked, dm("9", "7")));
        // Positive control: a different author still shows.
        assertNull(PushGate.suppressReason("9", true, NO_MUTES, NONE, blocked, dm("9", "8")));
    }

    @Test
    public void aFullyMutedServerIsSilent() {
        Map<String, String> muted = new HashMap<>();
        muted.put("srv", "nothing");
        assertEquals("muted-server",
                PushGate.suppressReason("9", true, muted, NONE, NONE, chan("9", "7", "srv", "42")));
    }

    @Test
    public void mentionsOnlyAlsoSilencesPush() {
        // A push is a generic ping; the server cannot see an @mention inside
        // encrypted content, so 'mentions' must degrade to silence — matching
        // what isServerQuiet already does for the in-app blip.
        Map<String, String> muted = new HashMap<>();
        muted.put("srv", "mentions");
        assertEquals("muted-server",
                PushGate.suppressReason("9", true, muted, NONE, NONE, chan("9", "7", "srv", "42")));
    }

    @Test
    public void aMutedChannelIsSilentWithoutMutingItsServer() {
        Set<String> mutedCh = new HashSet<>();
        mutedCh.add("42");
        assertEquals("muted-channel",
                PushGate.suppressReason("9", true, NO_MUTES, mutedCh, NONE, chan("9", "7", "srv", "42")));
        // Positive control: a sibling channel on the same server still shows.
        assertNull(PushGate.suppressReason("9", true, NO_MUTES, mutedCh, NONE, chan("9", "7", "srv", "43")));
    }

    @Test
    public void aBlockedProposerStillGetsToAskForConsent() {
        // THE carve-out. A clip prompt is a question ABOUT the recipient, not
        // a message from the proposer; swallowing it would answer "may I post
        // a recording of you" by silence, and the recipient could never
        // decline a prompt they were never shown.
        Set<String> blocked = new HashSet<>();
        blocked.add("7");
        Map<String, String> d = clip("9");
        d.put("author_id", "7"); // as if a future frame did name the proposer
        assertNull(PushGate.suppressReason("9", true, NO_MUTES, NONE, blocked, d));
        // POSITIVE CONTROL: the gate itself still works — the same blocked
        // author on an ordinary message is still suppressed, so the test above
        // is measuring the carve-out and not a broken block list.
        assertEquals("blocked-author",
                PushGate.suppressReason("9", true, NO_MUTES, NONE, blocked, dm("9", "7")));
        assertEquals("blocked-author",
                PushGate.suppressReason("9", true, NO_MUTES, NONE, blocked, chan("9", "7", "srv", "42")));
    }

    @Test
    public void aClipPromptIsStillSubjectToEveryOtherGate() {
        // The carve-out is exactly one rule wide. Account and master switch
        // still bite — a consent prompt for SOMEONE ELSE'S account on this
        // phone would be a leak of its own.
        assertEquals("wrong-account",
                PushGate.suppressReason("9", true, NO_MUTES, NONE, NONE, clip("5")));
        assertEquals("push-disabled",
                PushGate.suppressReason("9", false, NO_MUTES, NONE, NONE, clip("9")));
        // POSITIVE CONTROL: the ordinary case shows.
        assertNull(PushGate.suppressReason("9", true, NO_MUTES, NONE, NONE, clip("9")));
    }

    @Test
    public void mutesNeverSuppressAClipPrompt() {
        // There is no channel on a clip doorbell to match a mute against, and
        // a mute is not consent to be recorded: muting a noisy server must not
        // silently sign you up for a clip posted in it.
        Map<String, String> muted = new HashMap<>();
        muted.put("srv", "nothing");
        Set<String> mutedCh = new HashSet<>();
        mutedCh.add("42");
        assertNull(PushGate.suppressReason("9", true, muted, mutedCh, NONE, clip("9")));
        // Foreground is NOT tested here because it is not this class's rule:
        // NativeDelivery.onMessage returns early on PushPrefs.appVisible before
        // ever calling the gate, so an on-screen app gets the in-app prompt
        // (clipProposals.ts) and no shade entry, clips included.
    }

    @Test
    public void serverMutesNeverSuppressDms() {
        // DMs carry no server; muting a noisy server must not eat a direct
        // message from a friend who happens to share it.
        Map<String, String> muted = new HashMap<>();
        muted.put("srv", "nothing");
        assertNull(PushGate.suppressReason("9", true, muted, NONE, NONE, dm("9", "7")));
    }
}
