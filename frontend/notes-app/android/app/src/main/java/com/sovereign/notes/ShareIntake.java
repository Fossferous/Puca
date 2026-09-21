package com.sovereign.notes;

/**
 * The decisions behind "share into Púca Notes": what a shared payload becomes
 * before the composer ever sees it.
 *
 * Pure Java (no android.*, no org.json) so it runs under plain JUnit like
 * ReminderPlan / GeofenceEngine / ShareCache — the intake itself
 * (NotesNativePlugin.takeShare) is a handful of ContentResolver calls around
 * these rules, which is where every judgement worth testing lives.
 *
 * The payload comes from an ARBITRARY other app, so everything here is a cap
 * or a refusal: a title no longer than the composer's own limit, a mime we
 * resolved ourselves rather than one the sender claimed, a file count that
 * matches what a note can hold, and a name with no path in it.
 *
 * It holds nothing. The text it shapes is decrypted note content the moment
 * it arrives, and the contract of this app is that native code never keeps
 * that: it lives in one static field and one cache file until the page takes
 * it (docs/NOTES.md, "The Android app").
 */
final class ShareIntake {

    /** Mirrors MAX_TASK_ATTACHMENTS (frontend/src/api/tasks.ts): more than
     *  this and the upload would be refused after the user pressed Done. */
    static final int MAX_FILES = 12;

    /** Per file. The picture pipeline shrinks before sealing
     *  (api/imagePrep.ts), but the copy into cache happens first, so a
     *  200 MB "image/*" from another app must not land on disk. */
    static final long MAX_FILE_BYTES = 32L * 1024 * 1024;

    /** Mirrors MAX_TITLE_LENGTH (frontend/src/notes/model/notesModel.ts). */
    static final int MAX_TITLE = 100;

    private ShareIntake() {}

    /**
     * What the composer can take: plain text, and pictures. Everything else
     * is refused — a PDF or a text/html clipping has nowhere to go in a note,
     * and accepting it would put Púca Notes in share sheets it cannot serve.
     * The mime must be one WE resolved (ContentResolver.getType), never the
     * sender's claim.
     */
    static boolean acceptsMime(String mime) {
        String m = normalMime(mime);
        return m.equals("text/plain") || m.startsWith("image/");
    }

    /** Lower-cased, trimmed, without the ";charset=…" tail. */
    static String normalMime(String mime) {
        if (mime == null) return "";
        int semi = mime.indexOf(';');
        return (semi >= 0 ? mime.substring(0, semi) : mime).trim().toLowerCase(java.util.Locale.ROOT);
    }

    /**
     * The note's title: the sender's subject when there is one, else the
     * first line of the shared text — but only when that line reads like a
     * title. A first line longer than the composer's own limit is body text,
     * not a heading, so it is left where it is and the note opens untitled.
     */
    static String titleFrom(String subject, String text) {
        String s = subject == null ? "" : subject.trim();
        if (!s.isEmpty()) return trunc(s);
        String first = firstLine(text);
        if (first.isEmpty() || first.length() > MAX_TITLE) return "";
        return first;
    }

    /**
     * The note's body: the shared text, minus the line that became the title
     * (so a two-line share does not say the same thing twice). With a subject
     * the whole text is body, because the subject was never part of it.
     */
    static String bodyFrom(String subject, String text) {
        if (text == null) return "";
        String s = subject == null ? "" : subject.trim();
        if (!s.isEmpty()) return text.trim();
        String first = firstLine(text);
        if (first.isEmpty() || first.length() > MAX_TITLE) return text.trim();
        // Drop exactly the borrowed line, then the blank lines under it.
        int nl = text.indexOf('\n');
        if (nl < 0) return "";
        return stripLeadingBlank(text.substring(nl + 1)).trim();
    }

    /** How many of `wanted` files a note may actually take. */
    static int cap(int wanted) {
        if (wanted <= 0) return 0;
        return Math.min(wanted, MAX_FILES);
    }

    /**
     * A file name with no path in it, for a name that came from another app.
     * `index` and `mime` supply one when the sender gave nothing usable.
     */
    static String safeName(String raw, int index, String mime) {
        String ext = extensionFor(mime);
        String fallback = "shared-" + Math.max(0, index) + ext;
        String s = clean(raw, fallback);
        if (s.indexOf('.') < 0) s = s + ext;
        // clean() caps the NAME; re-cap once the extension is on, keeping the
        // extension rather than the tail of a very long base - a file called
        // ".png" and one called "nnn...n" (no extension) both confuse pickers.
        if (s.length() > MAX_NAME) {
            int dot = s.lastIndexOf('.');
            String tail = dot > 0 && s.length() - dot <= 8 ? s.substring(dot) : ext;
            s = s.substring(0, Math.max(1, MAX_NAME - tail.length())) + tail;
        }
        return s;
    }

    /**
     * The shared sanitiser: no separators, no control characters, no leading
     * dots (a name starting with one hides the file and, on some pickers,
     * reads as a relative path), and short enough for any filesystem.
     * NotesNativePlugin.safeFileName is this, for names the page chose.
     */
    static String clean(String name, String fallback) {
        if (name == null) return fallback;
        String s = name.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]+", "_").trim();
        while (s.startsWith(".")) s = s.substring(1);
        s = s.trim();
        if (s.isEmpty()) return fallback;
        return s.length() > MAX_NAME ? s.substring(0, MAX_NAME) : s;
    }

    /** As long a file name as any filesystem here will take without fuss. */
    static final int MAX_NAME = 120;

    /** A plausible extension from the mime we resolved, never from a name. */
    static String extensionFor(String mime) {
        String m = normalMime(mime);
        if (m.equals("text/plain")) return ".txt";
        if (m.equals("image/jpeg")) return ".jpg";
        if (m.equals("image/png")) return ".png";
        if (m.equals("image/webp")) return ".webp";
        if (m.equals("image/gif")) return ".gif";
        if (m.equals("image/heic") || m.equals("image/heif")) return ".heic";
        if (m.startsWith("image/")) return ".img";
        return ".bin";
    }

    private static String firstLine(String text) {
        if (text == null) return "";
        int nl = text.indexOf('\n');
        return (nl < 0 ? text : text.substring(0, nl)).trim();
    }

    private static String stripLeadingBlank(String s) {
        int i = 0;
        while (i < s.length() && (s.charAt(i) == '\n' || s.charAt(i) == '\r')) i++;
        return s.substring(i);
    }

    private static String trunc(String s) {
        return s.length() > MAX_TITLE ? s.substring(0, MAX_TITLE).trim() : s;
    }
}
