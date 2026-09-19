package com.sovereign.notes;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;

/**
 * Reading the two public claims the background refresh needs from a session
 * token — who it belongs to (`sub`) and when it dies (`exp`) — with no
 * verification (the server is the authority) and no android.* (so JUnit runs
 * it). Hand-rolled base64url because java.util.Base64 needs API 26.
 *
 * Two copies of one session exist once Notes refreshes in the background:
 * the WebView's (localStorage) and this app's (ReminderStore), and either
 * may be renewed by the server while the other is not. {@link #newer} is the
 * one rule both directions use, so neither holder ever swaps a fresher token
 * for a staler one.
 */
public final class JwtClaims {

    private JwtClaims() {}

    /** The token's payload as JSON, or null when it is not a readable JWT. */
    static JSONObject payload(String jwt) {
        if (jwt == null) return null;
        String[] parts = jwt.split("\\.");
        if (parts.length < 2) return null;
        byte[] raw = base64UrlDecode(parts[1]);
        if (raw == null) return null;
        try {
            return new JSONObject(new String(raw, StandardCharsets.UTF_8));
        } catch (Exception e) {
            return null;
        }
    }

    /** `exp` in epoch ms, or -1 when absent/unreadable. */
    public static long expMs(String jwt) {
        JSONObject p = payload(jwt);
        if (p == null || !p.has("exp")) return -1;
        long exp = p.optLong("exp", -1);
        return exp <= 0 ? -1 : exp * 1000L;
    }

    /** `sub` as a string, or null. The account id the app keys its store on. */
    public static String sub(String jwt) {
        JSONObject p = payload(jwt);
        if (p == null || !p.has("sub") || p.isNull("sub")) return null;
        Object v = p.opt("sub");
        if (v instanceof Number) return Long.toString(((Number) v).longValue());
        return String.valueOf(v);
    }

    /**
     * Which of two tokens to keep. The candidate wins unless the current one
     * is for the SAME account and lives strictly longer — a renewal the other
     * holder has not seen yet. A different account always takes the
     * candidate: the sender decides which account is signed in.
     */
    public static String newer(String current, String candidate) {
        if (candidate == null || candidate.isEmpty()) return current;
        if (current == null || current.isEmpty()) return candidate;
        String a = sub(current);
        String b = sub(candidate);
        if (a == null || !a.equals(b)) return candidate;
        return expMs(current) > expMs(candidate) ? current : candidate;
    }

    static byte[] base64UrlDecode(String s) {
        int len = s.length();
        byte[] out = new byte[len * 3 / 4 + 3];
        int buf = 0;
        int bits = 0;
        int n = 0;
        for (int i = 0; i < len; i++) {
            char c = s.charAt(i);
            int v;
            if (c >= 'A' && c <= 'Z') v = c - 'A';
            else if (c >= 'a' && c <= 'z') v = c - 'a' + 26;
            else if (c >= '0' && c <= '9') v = c - '0' + 52;
            else if (c == '-' || c == '+') v = 62;
            else if (c == '_' || c == '/') v = 63;
            else if (c == '=') break;
            else return null;
            buf = ((buf << 6) | v) & 0xffff; // only the low bits+8 are ever read
            bits += 6;
            if (bits >= 8) {
                bits -= 8;
                out[n++] = (byte) ((buf >> bits) & 0xff);
            }
        }
        byte[] exact = new byte[n];
        System.arraycopy(out, 0, exact, 0, n);
        return exact;
    }
}
