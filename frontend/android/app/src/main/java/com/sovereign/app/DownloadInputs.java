package com.sovereign.app;

import java.util.regex.Pattern;

/**
 * Validation of everything the page hands the native download path. Pure
 * Java, so JUnit covers it.
 *
 * <p>Every value here ultimately comes from a MESSAGE someone else wrote: a
 * clip manifest or an attachment ref ({@code sovereign-enc:<id>?k=…&c=…}).
 * The download path builds exactly one kind of URL — {@code <the APK's own
 * API base>/files/<uuid>} — so a file id must be a UUID and nothing else
 * (no "../", no "@host", no query); a key must decode to exactly 32 bytes;
 * and the file capability, which rides in a header, must be a plain token.
 */
final class DownloadInputs {

    private DownloadInputs() {}

    private static final Pattern UUID_RE =
            Pattern.compile("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$");
    /** The capability the server minted (base64url in practice); a header
     *  value, so never a CR, LF or anything outside this set. */
    private static final Pattern CAP_RE = Pattern.compile("^[A-Za-z0-9._~+/=-]{1,512}$");
    /** A download id the page chose, echoed back in progress events. */
    private static final Pattern JOB_ID_RE = Pattern.compile("^[A-Za-z0-9_-]{1,64}$");

    static boolean isUuid(String s) {
        return s != null && UUID_RE.matcher(s).matches();
    }

    static boolean isCap(String s) {
        return s != null && CAP_RE.matcher(s).matches();
    }

    static boolean isJobId(String s) {
        return s != null && JOB_ID_RE.matcher(s).matches();
    }

    /** 16 raw bytes of a canonical UUID string; null if it is not one. */
    static byte[] uuidBytes(String s) {
        if (!isUuid(s)) return null;
        String hex = s.replace("-", "");
        byte[] out = new byte[16];
        for (int i = 0; i < 16; i++) {
            out[i] = (byte) Integer.parseInt(hex.substring(i * 2, i * 2 + 2), 16);
        }
        return out;
    }

    /**
     * Base64 in either alphabet (url-safe {@code -_} or standard {@code +/}),
     * padding optional — what attachments.ts {@code fromB64url} accepts.
     * null on any other character or an impossible length. Own decoder
     * because java.util.Base64 is API 26+ and android.util.Base64 does not
     * exist under JUnit.
     */
    static byte[] base64(String s) {
        if (s == null) return null;
        int end = s.length();
        while (end > 0 && s.charAt(end - 1) == '=') end--;
        if (s.length() - end > 2) return null;
        if (end % 4 == 1) return null;
        int outLen = (end * 6) / 8;
        byte[] out = new byte[outLen];
        int acc = 0, bits = 0, o = 0;
        for (int i = 0; i < end; i++) {
            int v = sextet(s.charAt(i));
            if (v < 0) return null;
            acc = (acc << 6) | v;
            bits += 6;
            if (bits >= 8) {
                bits -= 8;
                out[o++] = (byte) (acc >> bits);
                acc &= (1 << bits) - 1;
            }
        }
        // Leftover bits must be zero (a canonical encoding), as atob demands
        // nothing here but a stricter check costs nothing.
        if (acc != 0) return null;
        return out;
    }

    /** A 32-byte key, or null. */
    static byte[] key32(String s) {
        byte[] k = base64(s);
        return k != null && k.length == 32 ? k : null;
    }

    private static int sextet(char c) {
        if (c >= 'A' && c <= 'Z') return c - 'A';
        if (c >= 'a' && c <= 'z') return c - 'a' + 26;
        if (c >= '0' && c <= '9') return c - '0' + 52;
        if (c == '+' || c == '-') return 62;
        if (c == '/' || c == '_') return 63;
        return -1;
    }

    /**
     * The API base the APK was built for, normalised: scheme://host[:port][/path]
     * without a trailing slash, query, fragment or user info. null when it is
     * not one. {@code allowHttp} only for debug builds — a release WebView
     * cannot reach an http:// API anyway (mixed content), and credentials
     * never travel in the clear.
     */
    static String normalizeApiBase(String raw, boolean allowHttp) {
        if (raw == null) return null;
        String s = raw.trim();
        while (s.endsWith("/")) s = s.substring(0, s.length() - 1);
        java.net.URI u;
        try {
            u = new java.net.URI(s);
        } catch (java.net.URISyntaxException e) {
            return null;
        }
        String scheme = u.getScheme();
        if (scheme == null) return null;
        scheme = scheme.toLowerCase(java.util.Locale.ROOT);
        if (!scheme.equals("https") && !(allowHttp && scheme.equals("http"))) return null;
        if (u.getHost() == null || u.getHost().isEmpty()) return null;
        if (u.getRawUserInfo() != null || u.getRawQuery() != null || u.getRawFragment() != null) return null;
        String path = u.getRawPath() == null ? "" : u.getRawPath();
        if (path.contains("..") || path.contains("//")) return null;
        return s;
    }
}
