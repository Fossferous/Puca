package com.sovereign.notes;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;

import org.junit.Test;

import java.nio.charset.StandardCharsets;

/** JVM tests for the token-holder rule the WebView and the refresh job share. */
public class JwtClaimsTest {

    private static String b64url(String s) {
        String std = java.util.Base64.getEncoder().encodeToString(s.getBytes(StandardCharsets.UTF_8));
        return std.replace('+', '-').replace('/', '_').replace("=", "");
    }

    private static String jwt(String payloadJson) {
        return b64url("{\"alg\":\"HS256\"}") + "." + b64url(payloadJson) + ".sig";
    }

    @Test
    public void readsSubAndExp() {
        String t = jwt("{\"sub\":42,\"username\":\"Brónach?>\",\"exp\":1800000000}");
        assertEquals("42", JwtClaims.sub(t));
        assertEquals(1_800_000_000_000L, JwtClaims.expMs(t));
    }

    @Test
    public void unreadableTokensAreUnknownNotZero() {
        assertNull(JwtClaims.sub("not-a-jwt"));
        assertEquals(-1, JwtClaims.expMs("a.%%%.c"));
        assertNull(JwtClaims.sub(null));
    }

    @Test
    public void newerKeepsTheLongerLivedTokenOfTheSameAccount() {
        String older = jwt("{\"sub\":42,\"exp\":1800000000}");
        String renewed = jwt("{\"sub\":42,\"exp\":1800086400}");
        assertSame("the page must not downgrade a renewal the job made", renewed, JwtClaims.newer(renewed, older));
        assertSame(renewed, JwtClaims.newer(older, renewed));
    }

    @Test
    public void aDifferentAccountAlwaysTakesTheCandidate() {
        String a = jwt("{\"sub\":1,\"exp\":1900000000}");
        String b = jwt("{\"sub\":2,\"exp\":1800000000}");
        assertSame(b, JwtClaims.newer(a, b));
    }

    @Test
    public void missingSidesResolveToTheOther() {
        String a = jwt("{\"sub\":1,\"exp\":1900000000}");
        assertSame(a, JwtClaims.newer(null, a));
        assertSame(a, JwtClaims.newer(a, null));
        assertSame(a, JwtClaims.newer(a, ""));
    }
}
