package com.sovereign.app;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * The keys a live remote-control session offers as buttons on its
 * notification ("Device session active"), and what a press on one may do.
 *
 * Pure Java, no Android imports, for the reason {@link KeepAliveReasons} and
 * {@link PushGate} are: the whole decision then runs under plain JUnit. The
 * service draws what {@link #shown} returns and asks {@link #decide} on every
 * press; the receiver only reads the keyguard and passes it in.
 *
 * <h3>Who decides</h3>
 *
 * The page (frontend/src/api/devices/shadeKeys.ts) is the authority on WHICH
 * keys: it pushes the complete list — or none — whenever the session, the
 * pause or the pins change. This class only refuses to show them unless the
 * CONTROL keep-alive reason holds, so a session that ends takes its buttons
 * with it even when the page never got to say so (the WebView died, the task
 * was swiped away).
 *
 * <h3>A press is an id, never a key</h3>
 *
 * A button carries the pin's id. The page looks the id up in the pins it
 * holds now; nothing here holds a key code that could be replayed.
 *
 * <h3>Locked phone</h3>
 *
 * A press is decided only once the keyguard is down, and refused if it stays
 * up ({@link #keepWaiting}): on every Android version a phone that stays
 * locked never types. On 12+ the button is also marked authentication-
 * required, so Android asks for the unlock and delivers the press after it;
 * on older versions the refusal is the only gate, and the status line says
 * to unlock first.
 */
final class ShadeKeys {

    /** A standard notification shows at most three action buttons. */
    static final int MAX = 3;
    /** Three buttons share one row; "Ctrl+Alt+Del" is the longest label the
     *  page makes for the usual keys, a chord of all four modifiers longer. */
    static final int MAX_LABEL = 24;
    static final int MAX_STATUS = 64;

    /** The page's pin ids (pinnedKeys.ts ID_RE). Anything else is dropped. */
    private static final Pattern ID = Pattern.compile("[a-z0-9]{1,24}");

    static final String STATUS_LOCKED = "Not sent: unlock the phone first";

    /**
     * How long a press that arrives with the keyguard up waits for it to go.
     * Measured on the Android 16 emulator: a button pressed on the lock
     * screen raises Android's PIN bouncer, and once the PIN is entered
     * Android delivers the press — while the keyguard is still being
     * dismissed, so read at that instant the phone is "locked" and the press
     * the person just unlocked for was refused. The press waits for the
     * keyguard to go, and is refused if it does not: a phone that STAYS
     * locked never types.
     */
    static final long UNLOCK_GRACE_MS = 2000;
    static final long UNLOCK_POLL_MS = 100;

    /** Keep waiting for the unlock? Only while locked and inside the grace. */
    static boolean keepWaiting(boolean keyguardLocked, long waitedMs) {
        return keyguardLocked && waitedMs < UNLOCK_GRACE_MS;
    }

    static final ShadeKeys NONE = new ShadeKeys(Collections.<Key>emptyList(), null);

    static final class Key {
        final String id;
        final String label;

        Key(String id, String label) {
            this.id = id;
            this.label = label;
        }
    }

    /** What a press on a button does. */
    enum Outcome {
        /** Hand the id to the page, which sends the key. */
        SEND,
        /** The phone is locked: send nothing, say to unlock. */
        LOCKED,
        /** No control session (or none this variant may have): send nothing,
         *  and the buttons should not be there — draw again without them. */
        NOT_LIVE,
        /** An id that is not among the current buttons (a stale button from
         *  a moment ago): send nothing. */
        UNKNOWN,
    }

    final List<Key> keys;
    /** One line under the title: what the last press did. Null = none. */
    final String status;

    private ShadeKeys(List<Key> keys, String status) {
        this.keys = Collections.unmodifiableList(keys);
        this.status = status;
    }

    /**
     * The page's list, made safe. Parallel lists because that is what a
     * PluginCall's JSON array reads into without org.json here. A bad id, an
     * empty label, a duplicate id or anything past {@link #MAX} is DROPPED,
     * never repaired: the page is the authority, and a button it did not mean
     * must not appear.
     */
    static ShadeKeys from(List<String> ids, List<String> labels, String status) {
        List<Key> out = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        int n = ids == null || labels == null ? 0 : Math.min(ids.size(), labels.size());
        for (int i = 0; i < n && out.size() < MAX; i++) {
            String id = ids.get(i);
            String label = clean(labels.get(i), MAX_LABEL);
            if (id == null || !ID.matcher(id).matches() || label == null || !seen.add(id)) continue;
            out.add(new Key(id, label));
        }
        return new ShadeKeys(out, clean(status, MAX_STATUS));
    }

    /** No control characters (a label is one line on a button), trimmed,
     *  capped; null when nothing is left. */
    static String clean(String s, int max) {
        if (s == null) return null;
        StringBuilder b = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (Character.isISOControl(c)) continue;
            b.append(c);
        }
        String t = b.toString().trim();
        if (t.isEmpty()) return null;
        if (t.length() > max) {
            // Never split a surrogate pair at the cut.
            int end = max;
            if (Character.isHighSurrogate(t.charAt(end - 1))) end--;
            t = t.substring(0, end);
        }
        return t;
    }

    /** The buttons to draw: none unless a control session is live, and never
     *  in Lite, whose build has no remote control to press keys through. */
    List<Key> shown(boolean controlLive, boolean lite) {
        return controlLive && !lite ? keys : Collections.<Key>emptyList();
    }

    /** The status line goes with the buttons: none without them. */
    String statusShown(boolean controlLive, boolean lite) {
        return shown(controlLive, lite).isEmpty() ? null : status;
    }

    /**
     * A press on the button carrying {@code id}. The order is the order of
     * what the person must be told: no session means no buttons at all; a
     * locked phone sends nothing whatever the id; only then is the id
     * checked against the buttons drawn now.
     */
    Outcome decide(String id, boolean controlLive, boolean keyguardLocked, boolean lite) {
        List<Key> drawn = shown(controlLive, lite);
        if (drawn.isEmpty()) return Outcome.NOT_LIVE;
        if (keyguardLocked) return Outcome.LOCKED;
        if (id == null) return Outcome.UNKNOWN;
        for (Key k : drawn) {
            if (k.id.equals(id)) return Outcome.SEND;
        }
        return Outcome.UNKNOWN;
    }

    /** The same buttons, with a new status line. */
    ShadeKeys withStatus(String next) {
        return new ShadeKeys(new ArrayList<>(keys), clean(next, MAX_STATUS));
    }

    /** No buttons: the page that would have sent their keys is gone. */
    ShadeKeys withoutKeys() {
        return NONE;
    }

    /** Index i's PendingIntent request code: one per button slot, clear of
     *  the 0 and 1 the service's other PendingIntents use. */
    static int requestCode(int index) {
        return 4800 + index;
    }
}
