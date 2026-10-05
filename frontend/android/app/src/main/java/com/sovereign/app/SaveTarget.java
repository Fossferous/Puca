package com.sovereign.app;

import java.nio.charset.StandardCharsets;
import java.util.Locale;

/**
 * Where a downloaded file goes and what it is called. Pure Java (JUnit).
 *
 * <p>THE TYPE COMES FROM THE BYTES. An attachment's MIME ({@code m=} in its
 * ref) and its name are chosen by whoever SENT it, so neither may decide
 * whether a file lands in the gallery. The first plaintext bytes are sniffed
 * against a short allow-list of media formats; only a match makes a file an
 * image, a video or a piece of audio — and then it gets that format's MIME and
 * extension, whatever it was called. Everything else is a plain download:
 * Download/Puca, with a MIME taken from its (sanitised) extension only when
 * that extension does NOT claim to be media — a {@code .mp4} whose bytes are
 * not an MP4 is {@code application/octet-stream}, never {@code video/mp4}.
 *
 * <p>THE NAME MUST NOT CLAIM IT EITHER. Once a MediaStore item is published,
 * the system's scanner types it by its EXTENSION, not by the MIME it was
 * created with: an HTML file saved as {@code fake-video.mp4} with
 * {@code application/octet-stream} came back as {@code video/mp4},
 * media_type VIDEO, listed in the video collection every gallery reads
 * (measured on the emulator, 2026-10-05). So a file whose bytes are not one
 * of the formats below while its name says picture, video or sound is saved
 * as {@code <name>.bin}.
 *
 * <p>The sender's MIME is used for exactly one thing: telling an audio-only
 * MP4/WebM (which sniffs as a container, not as "audio") from a video, so a
 * song posted as {@code .m4a} lands in Music rather than Movies.
 *
 * <p>FOLDERS: Movies/Puca, Pictures/Puca, Music/Puca, Download/Puca — the
 * collections Android's own apps read (Google Photos shows Movies and
 * Pictures; music players index Music). ASCII "Puca" for the same reason
 * Documents/Puca is ASCII (saveToDevice.ts): it is typed and searched for in
 * file managers, and it is the folder earlier releases already wrote.
 */
final class SaveTarget {

    enum Collection { VIDEO, IMAGE, AUDIO, DOWNLOAD }

    // hygiene-lint:allow-product-spelling — an on-disk folder name, ASCII on purpose (see above)
    static final String FOLDER = "Puca";

    final Collection collection;
    final String mime;
    final String displayName;

    private SaveTarget(Collection collection, String mime, String displayName) {
        this.collection = collection;
        this.mime = mime;
        this.displayName = displayName;
    }

    /** The public directory under which {@link #FOLDER} lives (Environment.DIRECTORY_*). */
    String topDirectory() {
        switch (collection) {
            case VIDEO: return "Movies";
            case IMAGE: return "Pictures";
            case AUDIO: return "Music";
            default: return "Download";
        }
    }

    String relativePath() {
        return topDirectory() + "/" + FOLDER + "/";
    }

    /** Maps a lower-case extension to a MIME (android.webkit.MimeTypeMap in the app). */
    interface ExtensionMimes {
        String mimeFor(String extension);
    }

    /**
     * Decide the target for a file whose first bytes are {@code head[0..len)}.
     *
     * @param senderName  the name from the message (untrusted)
     * @param senderMime  the MIME from the ref (untrusted; a hint only)
     */
    static SaveTarget decide(byte[] head, int len, String senderName, String senderMime, ExtensionMimes extMimes) {
        Sniffed s = sniff(head, len, senderMime);
        String name = sanitize(senderName);
        if (s != null) {
            return new SaveTarget(s.collection, s.mime, withExtension(name, s.extensions));
        }
        String ext = extensionOf(name);
        String mime = ext.isEmpty() || extMimes == null ? null : extMimes.mimeFor(ext);
        if (mime != null && isMediaMime(mime)) {
            // The name claims media the bytes are not (see the class comment).
            return new SaveTarget(Collection.DOWNLOAD, "application/octet-stream", capLength(name + ".bin"));
        }
        if (mime == null || mime.isEmpty() || !mime.matches("^[a-z0-9][a-z0-9.+-]*/[a-z0-9][a-z0-9.+-]*$")) {
            mime = "application/octet-stream";
        }
        return new SaveTarget(Collection.DOWNLOAD, mime, name);
    }

    static boolean isMediaMime(String mime) {
        String m = mime.toLowerCase(Locale.ROOT);
        return m.startsWith("image/") || m.startsWith("video/") || m.startsWith("audio/");
    }

    // ---- sniffing ---------------------------------------------------------

    static final class Sniffed {
        final Collection collection;
        final String mime;
        /** Acceptable extensions, the canonical one first. */
        final String[] extensions;

        Sniffed(Collection collection, String mime, String... extensions) {
            this.collection = collection;
            this.mime = mime;
            this.extensions = extensions;
        }
    }

    /** The media format these bytes ARE, or null when they are none we place in a gallery. */
    static Sniffed sniff(byte[] b, int len, String senderMime) {
        boolean saysAudio = senderMime != null && senderMime.toLowerCase(Locale.ROOT).trim().startsWith("audio/");
        if (len >= 12 && ascii(b, 4, "ftyp")) {
            String brand = new String(b, 8, 4, StandardCharsets.ISO_8859_1);
            switch (brand) {
                case "qt  ":
                    return new Sniffed(Collection.VIDEO, "video/quicktime", "mov");
                case "M4A ":
                case "M4B ":
                    return new Sniffed(Collection.AUDIO, "audio/mp4", "m4a", "m4b");
                case "heic": case "heix": case "heim": case "heis": case "mif1": case "msf1":
                    return new Sniffed(Collection.IMAGE, "image/heic", "heic", "heif");
                case "avif": case "avis":
                    return new Sniffed(Collection.IMAGE, "image/avif", "avif");
                case "3gp4": case "3gp5": case "3gp6": case "3gg6": case "3ge6":
                    return new Sniffed(Collection.VIDEO, "video/3gpp", "3gp");
                case "crx ":
                    // Canon CR3 raw: ISO BMFF, but a photograph
                    return new Sniffed(Collection.IMAGE, "image/x-canon-cr3", "cr3");
                default:
                    if (saysAudio) return new Sniffed(Collection.AUDIO, "audio/mp4", "m4a", "mp4");
                    return new Sniffed(Collection.VIDEO, "video/mp4", "mp4", "m4v");
            }
        }
        if (len >= 4 && (b[0] & 0xff) == 0x1a && (b[1] & 0xff) == 0x45 && (b[2] & 0xff) == 0xdf && (b[3] & 0xff) == 0xa3) {
            // EBML: the DocType says WebM or Matroska, within the first few dozen bytes.
            boolean webm = contains(b, Math.min(len, 64), "webm");
            if (webm) {
                if (saysAudio) return new Sniffed(Collection.AUDIO, "audio/webm", "weba", "webm");
                return new Sniffed(Collection.VIDEO, "video/webm", "webm");
            }
            if (contains(b, Math.min(len, 64), "matroska")) {
                return new Sniffed(Collection.VIDEO, "video/x-matroska", "mkv");
            }
            return null;
        }
        if (len >= 3 && (b[0] & 0xff) == 0xff && (b[1] & 0xff) == 0xd8 && (b[2] & 0xff) == 0xff) {
            return new Sniffed(Collection.IMAGE, "image/jpeg", "jpg", "jpeg");
        }
        if (len >= 8 && (b[0] & 0xff) == 0x89 && ascii(b, 1, "PNG") && b[4] == 0x0d && b[5] == 0x0a && b[6] == 0x1a && b[7] == 0x0a) {
            return new Sniffed(Collection.IMAGE, "image/png", "png");
        }
        if (len >= 6 && (ascii(b, 0, "GIF87a") || ascii(b, 0, "GIF89a"))) {
            return new Sniffed(Collection.IMAGE, "image/gif", "gif");
        }
        if (len >= 12 && ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP")) {
            return new Sniffed(Collection.IMAGE, "image/webp", "webp");
        }
        if (len >= 12 && ascii(b, 0, "RIFF") && ascii(b, 8, "WAVE")) {
            return new Sniffed(Collection.AUDIO, "audio/wav", "wav");
        }
        if (len >= 12 && ascii(b, 0, "RIFF") && ascii(b, 8, "AVI ")) {
            return new Sniffed(Collection.VIDEO, "video/x-msvideo", "avi");
        }
        if (len >= 4 && ascii(b, 0, "OggS")) {
            // Theora's identification header follows the first page header.
            if (contains(b, Math.min(len, 128), "theora")) return new Sniffed(Collection.VIDEO, "video/ogg", "ogv", "ogg");
            return new Sniffed(Collection.AUDIO, "audio/ogg", "ogg", "opus", "oga");
        }
        if (len >= 16 && (b[0] & 0xff) == 0x30 && (b[1] & 0xff) == 0x26 && (b[2] & 0xff) == 0xb2 && (b[3] & 0xff) == 0x75
                && (b[4] & 0xff) == 0x8e && (b[5] & 0xff) == 0x66 && (b[6] & 0xff) == 0xcf && (b[7] & 0xff) == 0x11) {
            // ASF (Windows Media): the header object's GUID; audio-only only by the sender's word, like MP4
            if (saysAudio) return new Sniffed(Collection.AUDIO, "audio/x-ms-wma", "wma", "asf");
            return new Sniffed(Collection.VIDEO, "video/x-ms-wmv", "wmv", "asf");
        }
        if (len >= 4 && b[0] == 0 && b[1] == 0 && b[2] == 1 && ((b[3] & 0xff) == 0xba || (b[3] & 0xff) == 0xb3)) {
            // MPEG program stream pack header, or an MPEG-1/2 video sequence header
            return new Sniffed(Collection.VIDEO, "video/mpeg", "mpg", "mpeg", "m2p", "vob", "m1v", "m2v");
        }
        if (isTransportStream(b, len)) {
            return new Sniffed(Collection.VIDEO, "video/mp2t", "ts", "m2ts", "mts", "m2t");
        }
        if (len >= 4 && ascii(b, 0, "FLV") && b[3] == 1) {
            return new Sniffed(Collection.VIDEO, "video/x-flv", "flv");
        }
        if (len >= 12 && ascii(b, 0, "FORM") && (ascii(b, 8, "AIFF") || ascii(b, 8, "AIFC"))) {
            return new Sniffed(Collection.AUDIO, "audio/aiff", "aiff", "aif", "aifc");
        }
        if (len >= 9 && ascii(b, 0, "#!AMR-WB\n")) {
            return new Sniffed(Collection.AUDIO, "audio/amr-wb", "awb", "amr");
        }
        if (len >= 6 && ascii(b, 0, "#!AMR\n")) {
            return new Sniffed(Collection.AUDIO, "audio/amr", "amr", "3ga");
        }
        if (len >= 8 && ascii(b, 0, "MThd") && b[4] == 0 && b[5] == 0 && b[6] == 0 && b[7] == 6) {
            return new Sniffed(Collection.AUDIO, "audio/midi", "mid", "midi");
        }
        if (len >= 18 && b[0] == 'B' && b[1] == 'M' && b[6] == 0 && b[7] == 0 && b[8] == 0 && b[9] == 0) {
            // BMP: reserved words zero and a known DIB header size
            int dib = (b[14] & 0xff) | ((b[15] & 0xff) << 8) | ((b[16] & 0xff) << 16) | ((b[17] & 0xff) << 24);
            if (dib == 12 || dib == 40 || dib == 52 || dib == 56 || dib == 64 || dib == 108 || dib == 124) {
                return new Sniffed(Collection.IMAGE, "image/bmp", "bmp", "dib");
            }
        }
        if (len >= 4 && ((b[0] == 'I' && b[1] == 'I' && b[2] == 42 && b[3] == 0) || (b[0] == 'M' && b[1] == 'M' && b[2] == 0 && b[3] == 42))) {
            // TIFF, and the camera raw formats built on it
            return new Sniffed(Collection.IMAGE, "image/tiff", "tif", "tiff", "dng", "nef", "cr2", "arw", "orf", "rw2", "pef", "srw");
        }
        if (len >= 22 && b[0] == 0 && b[1] == 0 && b[2] == 1 && b[3] == 0 && b[5] == 0 && b[4] != 0 && b[9] == 0) {
            // ICO: an image count, then a first directory entry whose reserved byte is 0
            return new Sniffed(Collection.IMAGE, "image/x-icon", "ico");
        }
        if (len >= 4 && ascii(b, 0, "fLaC")) {
            return new Sniffed(Collection.AUDIO, "audio/flac", "flac");
        }
        if (len >= 3 && ascii(b, 0, "ID3")) {
            return new Sniffed(Collection.AUDIO, "audio/mpeg", "mp3");
        }
        if (len >= 3 && (b[0] & 0xff) == 0xff && (b[1] & 0xe0) == 0xe0) {
            // A bare frame header is only 11 sync bits, so the rest of it must
            // be plausible too: ADTS (AAC) is layer 0; MPEG audio needs a real
            // version, layer, bitrate and sample rate.
            int layer = (b[1] >> 1) & 0x3;
            if (layer == 0 && (b[1] & 0xf6) == 0xf0) return new Sniffed(Collection.AUDIO, "audio/aac", "aac");
            int version = (b[1] >> 3) & 0x3;
            int bitrate = (b[2] >> 4) & 0xf;
            int rate = (b[2] >> 2) & 0x3;
            if (layer != 0 && version != 1 && bitrate != 0xf && rate != 3) return new Sniffed(Collection.AUDIO, "audio/mpeg", "mp3");
        }
        return null;
    }

    /** MPEG-TS: a 0x47 sync byte every 188 bytes (or every 192 after a 4-byte
     *  timestamp, M2TS), three packets running. */
    private static boolean isTransportStream(byte[] b, int len) {
        for (int start : new int[] { 0, 4 }) {
            int step = start == 0 ? 188 : 192;
            if (len > start + 2 * step && b[start] == 0x47 && b[start + step] == 0x47 && b[start + 2 * step] == 0x47) return true;
        }
        return false;
    }

    /** Bytes {@link #sniff} wants from the start of a file. */
    static final int SNIFF_BYTES = 512;

    private static boolean ascii(byte[] b, int off, String s) {
        if (off + s.length() > b.length) return false;
        for (int i = 0; i < s.length(); i++) if (b[off + i] != (byte) s.charAt(i)) return false;
        return true;
    }

    private static boolean contains(byte[] b, int len, String s) {
        for (int i = 0; i + s.length() <= len; i++) if (ascii(b, i, s)) return true;
        return false;
    }

    // ---- names ------------------------------------------------------------

    /** UTF-8 bytes a display name may take: the file system's 255, minus room
     *  for MediaStore's own " (12)" on a collision. */
    static final int MAX_NAME_UTF8 = 200;
    /** Characters, as saveToDevice.ts safeDeviceFileName caps them. */
    static final int MAX_NAME_CHARS = 120;

    /**
     * A display name that is safe as a single file name: no path separators
     * or characters a file system reserves, no control or bidirectional
     * formatting characters (a right-to-left override makes "evil‮4pm.exe"
     * read as "evilexe.mp4"), no leading dots (a hidden file), no trailing dots
     * or spaces, never empty, and capped in length with its extension kept.
     */
    static String sanitize(String raw) {
        StringBuilder sb = new StringBuilder();
        String in = raw == null ? "" : raw;
        for (int i = 0; i < in.length(); ) {
            int cp = in.codePointAt(i);
            i += Character.charCount(cp);
            if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) continue;         // C0, DEL, C1
            if (cp == 0x061c || cp == 0x200b || cp == 0x200e || cp == 0x200f || cp == 0xfeff) continue;
            if ((cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)) continue; // bidi embeddings/isolates
            if (cp == 0xfffe || cp == 0xffff || Character.getType(cp) == Character.SURROGATE) continue;
            if ("\\/:*?\"<>|".indexOf(cp) >= 0) { sb.append('_'); continue; }
            if (Character.isWhitespace(cp) || Character.isSpaceChar(cp)) {
                if (sb.length() > 0 && sb.charAt(sb.length() - 1) != ' ') sb.append(' ');
                continue;
            }
            sb.appendCodePoint(cp);
        }
        String s = sb.toString();
        int a = 0;
        while (a < s.length() && (s.charAt(a) == '.' || s.charAt(a) == ' ')) a++;
        int z = s.length();
        while (z > a && (s.charAt(z - 1) == '.' || s.charAt(z - 1) == ' ')) z--;
        s = s.substring(a, z);
        if (s.isEmpty()) s = "file";
        return capLength(s);
    }

    /** {@code name} if its extension is one of {@code exts}; otherwise with the first appended. */
    static String withExtension(String name, String[] exts) {
        String ext = extensionOf(name);
        for (String e : exts) if (e.equals(ext)) return name;
        return capLength(name + "." + exts[0]);
    }

    /** Lower-case extension (without the dot), or "" when there is none. */
    static String extensionOf(String name) {
        int dot = name.lastIndexOf('.');
        if (dot <= 0 || dot == name.length() - 1) return "";
        String ext = name.substring(dot + 1);
        if (ext.length() > 10) return "";
        return ext.toLowerCase(Locale.ROOT);
    }

    private static String capLength(String s) {
        if (s.length() <= MAX_NAME_CHARS && utf8Len(s) <= MAX_NAME_UTF8) return s;
        String ext = extensionOf(s);
        String suffix = ext.isEmpty() ? "" : "." + s.substring(s.length() - ext.length());
        String stem = s.substring(0, s.length() - suffix.length());
        while (!stem.isEmpty() && (stem.length() + suffix.length() > MAX_NAME_CHARS || utf8Len(stem + suffix) > MAX_NAME_UTF8)) {
            int cut = stem.length() - 1;
            // never split a surrogate pair
            if (cut > 0 && Character.isLowSurrogate(stem.charAt(cut)) && Character.isHighSurrogate(stem.charAt(cut - 1))) cut--;
            stem = stem.substring(0, cut);
        }
        stem = stem.trim();
        if (stem.isEmpty()) stem = "file";
        return stem + suffix;
    }

    private static int utf8Len(String s) {
        return s.getBytes(StandardCharsets.UTF_8).length;
    }
}
