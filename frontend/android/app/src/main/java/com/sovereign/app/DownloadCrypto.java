package com.sovereign.app;

import java.nio.ByteBuffer;
import java.security.GeneralSecurityException;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * Opening what the native download path fetches — byte-exact with the two
 * formats the web app seals. Pure Java (javax.crypto, no Android imports), so
 * the JUnit suite proves it against vectors the REAL JS encryption produced
 * (src/test/resources/download-vectors.json, regenerated and checked by
 * frontend/src/tests/downloadVectors.test.ts).
 *
 * <p>A CLIP PART (frontend/src/api/clips/clipCrypto.ts, sealPart/openPart):
 * <pre>
 *   "SVCP" | ver=1 | u16BE(index) | nonce(12) | AES-256-GCM ciphertext‖tag(16)
 *   nonce = noncePrefix(8) ‖ u32BE(index)
 *   AAD   = clipId(16) ‖ ver ‖ u16BE(index)
 * </pre>
 * Every header field is checked BEFORE decrypting, exactly as openPart does:
 * a part from another position, another clip, or with a nonce that is not
 * the one this index must use is refused rather than decrypted.
 *
 * <p>AN ATTACHMENT (frontend/src/api/attachments.ts, sealFileForUpload):
 * {@code nonce(12) ‖ AES-256-GCM ciphertext‖tag(16)}, no AAD.
 *
 * <p>GCM releases nothing until the tag verifies, so a part is held whole:
 * the caller's buffers bound memory at about one part, whatever the clip's
 * length. Direct ByteBuffers on purpose — Conscrypt then opens straight from
 * the buffers' memory instead of copying the part into a Java array first.
 */
final class DownloadCrypto {

    static final int PART_MAGIC = 0x53564350; // "SVCP"
    static final int PART_VERSION = 1;
    static final int PART_HEADER_BYTES = 4 + 1 + 2 + 12; // 19
    static final int TAG_BYTES = 16;
    static final int NONCE_BYTES = 12;
    /** clipCrypto.ts PART_MAX_PLAINTEXT. */
    static final int PART_MAX_PLAINTEXT = 24 * 1024 * 1024;

    private DownloadCrypto() {}

    /** The bytes are not what they claim to be (tampered, wrong key, wrong part). */
    static final class DecryptException extends Exception {
        DecryptException(String message) { super(message); }
        DecryptException(String message, Throwable cause) { super(message, cause); }
    }

    /**
     * Open clip part {@code index}: {@code wire} from position to limit, the
     * plaintext written into {@code out} from its position (which advances).
     * Returns the plaintext length.
     */
    static int openClipPart(byte[] key, byte[] noncePrefix, byte[] clipId, int index,
                            ByteBuffer wire, ByteBuffer out) throws DecryptException {
        if (key == null || key.length != 32) throw new DecryptException("clip key must be 32 bytes");
        if (noncePrefix == null || noncePrefix.length != 8) throw new DecryptException("nonce prefix must be 8 bytes");
        if (clipId == null || clipId.length != 16) throw new DecryptException("clip id must be 16 bytes");
        if (index < 0 || index > 0xffff) throw new DecryptException("part index out of range");
        int start = wire.position();
        int len = wire.remaining();
        if (len < PART_HEADER_BYTES + TAG_BYTES) throw new DecryptException("part too short");
        if (wire.getInt(start) != PART_MAGIC) throw new DecryptException("not a clip part");
        if ((wire.get(start + 4) & 0xff) != PART_VERSION) throw new DecryptException("unsupported part version");
        int idx = wire.getShort(start + 5) & 0xffff;
        if (idx != index) throw new DecryptException("part index mismatch: header says " + idx + ", expected " + index);
        byte[] nonce = partNonce(noncePrefix, index);
        for (int i = 0; i < NONCE_BYTES; i++) {
            if (wire.get(start + 7 + i) != nonce[i]) throw new DecryptException("part nonce mismatch");
        }
        byte[] aad = partAad(clipId, index);
        ByteBuffer body = wire.duplicate();
        body.position(start + PART_HEADER_BYTES);
        int n = gcmOpen(key, nonce, aad, body, out);
        wire.position(wire.limit());
        return n;
    }

    /** Open an attachment blob: {@code nonce(12) ‖ ciphertext‖tag}. */
    static int openAttachment(byte[] key, ByteBuffer wire, ByteBuffer out) throws DecryptException {
        if (key == null || key.length != 32) throw new DecryptException("attachment key must be 32 bytes");
        int start = wire.position();
        if (wire.remaining() < NONCE_BYTES + TAG_BYTES) throw new DecryptException("attachment too short");
        byte[] nonce = new byte[NONCE_BYTES];
        for (int i = 0; i < NONCE_BYTES; i++) nonce[i] = wire.get(start + i);
        ByteBuffer body = wire.duplicate();
        body.position(start + NONCE_BYTES);
        int n = gcmOpen(key, nonce, null, body, out);
        wire.position(wire.limit());
        return n;
    }

    static byte[] partNonce(byte[] noncePrefix, int index) {
        byte[] n = new byte[NONCE_BYTES];
        System.arraycopy(noncePrefix, 0, n, 0, 8);
        n[8] = (byte) (index >>> 24);
        n[9] = (byte) (index >>> 16);
        n[10] = (byte) (index >>> 8);
        n[11] = (byte) index;
        return n;
    }

    static byte[] partAad(byte[] clipId, int index) {
        byte[] a = new byte[16 + 1 + 2];
        System.arraycopy(clipId, 0, a, 0, 16);
        a[16] = (byte) PART_VERSION;
        a[17] = (byte) (index >>> 8);
        a[18] = (byte) index;
        return a;
    }

    private static int gcmOpen(byte[] key, byte[] nonce, byte[] aad, ByteBuffer body, ByteBuffer out)
            throws DecryptException {
        int plainLen = body.remaining() - TAG_BYTES;
        if (out.remaining() < plainLen) throw new DecryptException("output buffer too small");
        try {
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(TAG_BYTES * 8, nonce));
            if (aad != null) c.updateAAD(aad);
            return c.doFinal(body, out);
        } catch (GeneralSecurityException e) {
            // AEADBadTagException lands here: the bytes are not what was sealed.
            throw new DecryptException("could not decrypt: " + e.getClass().getSimpleName(), e);
        }
    }
}
