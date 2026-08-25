package com.sovereign.app;

import java.util.Map;
import java.util.Set;

/**
 * Should a received push become a visible notification?
 *
 * Pure — plain Maps and Sets in, verdict out, no Android types — so the whole
 * matrix runs under plain JUnit (see PushGateTest), the same pattern as
 * GeofenceEngine. The FCM service parses its inputs and delegates here; this
 * class must never grow an Android import.
 */
public final class PushGate {

    private PushGate() {}

    /** Why a push was dropped, or null to show it. Returned rather than logged
     *  so the service can log it and the test can assert on it. */
    public static String suppressReason(
            String accountUserId,
            boolean pushEnabled,
            Map<String, String> mutedServers,   // server id -> "nothing"|"mentions"
            Set<String> mutedChannels,
            Set<String> blockedIds,
            Map<String, String> data) {

        // Wrong account: an in-flight push can land after this phone switched
        // users, and showing it would put someone else's conversation title on
        // this account's lock screen.
        String recipient = data.get("recipient_id");
        if (accountUserId == null || recipient == null || !accountUserId.equals(recipient)) {
            return "wrong-account";
        }

        if (!pushEnabled) return "push-disabled";

        String author = data.get("author_id");
        String kind = data.get("kind");
        // Your own message must never notify you. The server echoes every
        // sent DM back to its sender (that echo is how the sending client
        // confirms), and the delivery socket receives it like any session —
        // shipping without this check put "Alice sent you a message" on
        // Alice's own phone. Checked HERE rather than in the frame parser so
        // it covers every frame type, present and future, under JUnit.
        if (author != null && author.equals(accountUserId)) return "self-authored";
        // BLOCKING DOES NOT SILENCE A CONSENT REQUEST. A clip prompt is not a
        // message FROM the proposer, it is a question ABOUT the recipient —
        // "may your camera and voice be posted?". Letting a block swallow it
        // would answer that question by silence, and the recording would go up
        // with the recipient in it and no say in the matter. Declining is how
        // you say no; you cannot decline a prompt you were never shown. The JS
        // path makes the same carve-out (clipProposals.ts, hydrateAndPrompt).
        // The prompt itself names nobody, so this exempts no CONTENT from the
        // block — only the fact that an answer is wanted.
        boolean isClip = "clip".equals(kind);
        if (author != null && !isClip && blockedIds.contains(author)) return "blocked-author";

        if ("chan".equals(kind)) {
            // 'mentions' suppresses too: a push is a generic ping, and the
            // server cannot detect an @mention inside encrypted content — so
            // "mentions only" degrades to silence for push, matching what
            // isServerQuiet already does for the in-app blip.
            String server = data.get("server_id");
            if (server != null && mutedServers.containsKey(server)) return "muted-server";
            String channel = data.get("channel_id");
            if (channel != null && mutedChannels.contains(channel)) return "muted-channel";
        }
        // DMs and the test probe carry no mute surface — DMs are not mutable
        // in this app (blocking is the tool for that, handled above).
        //
        // Clip prompts carry no mute surface either, and deliberately: the
        // frame names no channel (server_id/channel_id are absent), so there
        // is nothing a per-server or per-channel mute could match. A mute
        // silences other people's chatter; it is not consent to be recorded.
        // Foreground suppression DOES still apply to clips — it is enforced
        // one level up, by NativeDelivery's PushPrefs.appVisible check before
        // this gate is consulted, and an on-screen app shows the real in-app
        // prompt instead (clipProposals.ts posts a notification only when
        // !appIsForeground()).

        return null;
    }
}
