package com.sovereign.app;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * Everything the page passes the native download path, validated as the
 * hostile input it may be: it comes out of a message someone else wrote.
 */
public class DownloadInputsTest {

    @Test
    public void fileIdsMustBeUuidsAndNothingElse() {
        assertTrue(DownloadInputs.isUuid("5f243cae-0b1d-4c2e-9a7f-30e62651d0f5"));
        assertTrue(DownloadInputs.isUuid("5F243CAE-0B1D-4C2E-9A7F-30E62651D0F5"));
        assertFalse(DownloadInputs.isUuid("../../auth/me"));
        assertFalse(DownloadInputs.isUuid("5f243cae-0b1d-4c2e-9a7f-30e62651d0f5/../x"));
        assertFalse(DownloadInputs.isUuid("5f243cae-0b1d-4c2e-9a7f-30e62651d0f5?x=1"));
        assertFalse(DownloadInputs.isUuid("@evil.example/5f243cae-0b1d-4c2e-9a7f-30e62651d0f5"));
        assertFalse(DownloadInputs.isUuid("5f243cae0b1d4c2e9a7f30e62651d0f5"));
        assertFalse(DownloadInputs.isUuid(" 5f243cae-0b1d-4c2e-9a7f-30e62651d0f5"));
        assertFalse(DownloadInputs.isUuid(null));
        // 36 characters, like a UUID, and still not one: a check that only
        // counted characters (or dropped the character classes) passes these
        assertFalse(DownloadInputs.isUuid("../../../../../../../../../../../../"));
        assertFalse(DownloadInputs.isUuid("5f243cae-0b1d-4c2e-9a7f-30e62651d0g5"));
        assertFalse(DownloadInputs.isUuid("5f243cae-0b1d-4c2e-9a7f/30e62651d0f5"));
        assertFalse(DownloadInputs.isUuid("5f243cae0-b1d-4c2e-9a7f-30e62651d0f5"));
        assertFalse(DownloadInputs.isUuid("@evil.example/aaaaaaaaaaaaaaaaaaaaaa"));
        assertArrayEquals(new byte[] { 0x00, (byte) 0xff, 0x10, (byte) 0xee, 0x22, 0x33, 0x44, 0x55, (byte) 0x88, (byte) 0x99, (byte) 0xaa, (byte) 0xbb, (byte) 0xcc, (byte) 0xdd, (byte) 0xee, (byte) 0xff },
                DownloadInputs.uuidBytes("00ff10ee-2233-4455-8899-aabbccddeeff"));
    }

    @Test
    public void capabilitiesAreAPlainHeaderToken() {
        assertTrue(DownloadInputs.isCap("abc-DEF_123.~+/="));
        assertFalse(DownloadInputs.isCap("abc\r\nX-Evil: 1"));
        assertFalse(DownloadInputs.isCap("abc def"));
        assertFalse(DownloadInputs.isCap(""));
        StringBuilder long_ = new StringBuilder();
        for (int i = 0; i < 513; i++) long_.append('a');
        assertFalse(DownloadInputs.isCap(long_.toString()));
    }

    @Test
    public void base64AcceptsBothAlphabetsAndOptionalPaddingOnly() {
        assertArrayEquals(new byte[] { (byte) 0xfb, (byte) 0xff }, DownloadInputs.base64("-_8"));
        assertArrayEquals(new byte[] { (byte) 0xfb, (byte) 0xff }, DownloadInputs.base64("+/8="));
        assertArrayEquals(new byte[] { 'h', 'i' }, DownloadInputs.base64("aGk"));
        assertArrayEquals(new byte[] { 'h', 'i' }, DownloadInputs.base64("aGk="));
        assertArrayEquals(new byte[0], DownloadInputs.base64(""));
        assertNull(DownloadInputs.base64("aGk==="));
        assertNull(DownloadInputs.base64("a"));
        assertNull(DownloadInputs.base64("aG k"));
        assertNull(DownloadInputs.base64("aG*k"));
        assertNull("non-canonical trailing bits", DownloadInputs.base64("aGl"));
        assertNull(DownloadInputs.base64(null));
        assertEquals(32, DownloadInputs.key32("-__7__v_-__7__v_-__7__v_-__7__v_-__7__v_-_8").length);
        assertNull("a key must be exactly 32 bytes", DownloadInputs.key32("aGk"));
    }

    @Test
    public void theApiBaseIsHttpsOriginOrPathOnly() {
        assertEquals("https://chat.example.com", DownloadInputs.normalizeApiBase("https://chat.example.com/", false));
        assertEquals("https://chat.example.com/api", DownloadInputs.normalizeApiBase(" https://chat.example.com/api// ", false));
        assertEquals("https://chat.example.com:8443", DownloadInputs.normalizeApiBase("https://chat.example.com:8443", false));
        assertNull("no cleartext in a release", DownloadInputs.normalizeApiBase("http://10.0.2.2:6011", false));
        assertEquals("http://10.0.2.2:6011", DownloadInputs.normalizeApiBase("http://10.0.2.2:6011", true));
        assertNull(DownloadInputs.normalizeApiBase("https://user:pw@chat.example.com", false));
        assertNull(DownloadInputs.normalizeApiBase("https://chat.example.com/?x=1", false));
        assertNull(DownloadInputs.normalizeApiBase("https://chat.example.com/#f", false));
        assertNull(DownloadInputs.normalizeApiBase("https://chat.example.com/a/../b", false));
        assertNull(DownloadInputs.normalizeApiBase("ftp://chat.example.com", true));
        assertNull(DownloadInputs.normalizeApiBase("chat.example.com", false));
        assertNull(DownloadInputs.normalizeApiBase("", false));
        assertNull(DownloadInputs.normalizeApiBase(null, false));
    }

    @Test
    public void jobIdsAreShortTokens() {
        assertTrue(DownloadInputs.isJobId("dl-1a2b_3"));
        assertFalse(DownloadInputs.isJobId("a b"));
        assertFalse(DownloadInputs.isJobId(""));
    }
}
