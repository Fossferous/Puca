package com.sovereign.app;

import org.json.JSONObject;

import java.util.HashMap;
import java.util.Map;

/**
 * Turns a server WebSocket frame into the flat data-map the notification gate
 * (PushGate) and notifier consume — or null for frames that are not
 * notification-worthy.
 *
 * This is the native twin of the JS handlers in Chat.tsx (and, for the clip
 * doorbells, api/clips/clipProposals.ts): same events, same collapse keys
 * ("chan:&lt;serverId&gt;" / "dm:&lt;conversationId&gt;" / "clip:&lt;clipId&gt;"),
 * same content-free titles. The keys MUST stay byte-identical to the JS side's
 * notifyKey — both paths hash the key into the notification id, which is what
 * makes a native-posted and a JS-posted notification for the same conversation
 * replace each other instead of stacking.
 *
 * CONTENT-FREE BY RULE: a DirectMessage frame carries `content` (ciphertext —
 * and even if it were readable, a notification survives on a lock screen).
 * This class never reads that field. The body is always the fixed string
 * "New message". The clip doorbells go further: their title and body are
 * CONSTANTS, so a stolen phone's lock screen learns neither who proposed the
 * clip nor which channel or call it came from.
 *
 * Kept free of Android imports so it runs under plain JUnit with a real
 * org.json on the test classpath (see PushFramesTest).
 */
public final class PushFrames {

    private PushFrames() {}

    /** The literal body of every message notification. Never content-derived. */
    static final String GENERIC_BODY = "New message";

    /** Clip consent prompt, title and body. Byte-identical to the strings the
     *  JS path posts (clipProposals.ts) — same notification, whichever side
     *  happens to be alive when the doorbell rings, so the shared key really
     *  does replace rather than stack. Both are CONSTANTS on purpose: no
     *  proposer, no channel, no call — a lock screen learns nothing.
     *  src/protocol.rs pins these four strings across all three languages. */
    static final String CLIP_TITLE = "Approval needed";
    // Spelled without the fada ON PURPOSE: src/protocol.rs pins this literal
    // byte-for-byte across PushFrames.java, clipProposals.ts and its own test,
    // so the two delivery paths share one notification body. Rename all three
    // together or not at all.
    static final String CONSENT_BODY = "Open Púca to approve or decline";

    /** Author id for a frame that names nobody — the same "-1" the author-ful
     *  frames fall back to when an id is missing (optLong's default). PushGate
     *  compares it as a string against the account id and the block list; it
     *  matches neither, so an author-less frame is gated on nothing else. */
    static final String UNKNOWN_AUTHOR = "-1";

    /**
     * Parse one wire frame. Returns the gate/notifier data map, or null when
     * the frame is not something the shade should ever show (Pong, roster
     * events, typing, everything else).
     */
    public static Map<String, String> toData(String rawFrame) {
        try {
            JSONObject frame = new JSONObject(rawFrame);
            String type = frame.optString("type", "");
            JSONObject p = frame.optJSONObject("payload");
            if (p == null) return null;

            if ("MessageNotification".equals(type)) {
                // Cross-channel ping for a server channel. Content-free at the
                // SOURCE — this frame carries no message body at all.
                JSONObject author = p.optJSONObject("author");
                String serverId = p.optString("server_id", "");
                if (author == null || serverId.isEmpty()) return null;
                String username = author.optString("username", "Someone");
                Map<String, String> d = new HashMap<>();
                d.put("kind", "chan");
                d.put("key", "chan:" + serverId);
                d.put("title", username + " sent a message");
                d.put("body", GENERIC_BODY);
                d.put("nav", "server:" + serverId);
                d.put("server_id", serverId);
                d.put("channel_id", String.valueOf(p.optLong("channel_id", -1)));
                d.put("author_id", String.valueOf(author.optLong("id", -1)));
                return d;
            }

            if ("DirectMessage".equals(type)) {
                JSONObject sender = p.optJSONObject("sender");
                String convId = p.optString("conversation_id", "");
                if (sender == null || convId.isEmpty()) return null;
                String username = sender.optString("username", "Someone");
                Map<String, String> d = new HashMap<>();
                d.put("kind", "dm");
                d.put("key", "dm:" + convId);
                d.put("title", username + " sent you a message");
                d.put("body", GENERIC_BODY); // p.content is NEVER read
                d.put("nav", "dm:" + convId);
                d.put("author_id", String.valueOf(sender.optLong("id", -1)));
                return d;
            }

            if ("ClipProposed".equals(type) || "ClipPending".equals(type)) {
                // Two doorbells, one prompt: ClipProposed is the live one,
                // ClipPending is what the server parked for this delivery
                // socket while the phone was offline. Neither carries anything
                // but the clip id (and, on ClipProposed, a TTL) — the app
                // hydrates the real proposal from the server once it is open,
                // so nothing here is ever read from the frame except the id.
                //
                // ONLY the id is read. Any other field the frame may grow —
                // a proposer, a channel name — must stay out of the shade:
                // the whole point of a doorbell is that a phone someone else
                // is holding learns that an answer is wanted, and nothing more.
                String clipId = p.optString("clip_id", "");
                if (clipId.isEmpty()) return null;
                Map<String, String> d = new HashMap<>();
                d.put("kind", "clip");
                d.put("key", "clip:" + clipId);   // = JS notifyKey, byte for byte
                d.put("title", CLIP_TITLE);
                d.put("body", CONSENT_BODY);
                d.put("nav", "clip:" + clipId);
                // The frame names no proposer, by design (src/protocol.rs
                // asserts the doorbell has no `proposer` key). Stamp the
                // author-less sentinel rather than leaving the field out, so
                // the gate's author checks see a value and simply do not match.
                d.put("author_id", UNKNOWN_AUTHOR);
                return d;
            }

            return null; // every other frame type: not notification-worthy
        } catch (Exception e) {
            return null; // malformed frame — drop, never crash the socket
        }
    }
}
