package io.github.hafijbge.meshdrop.engine.util;

import java.security.GeneralSecurityException;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/** scrypt (RFC 7914), for link password records the Node hub checks with crypto.scrypt. */
public final class Scrypt {
    private Scrypt() {}

    public static byte[] derive(byte[] password, byte[] salt, int n, int r, int p, int dkLen) throws GeneralSecurityException {
        if (n < 2 || (n & (n - 1)) != 0) throw new IllegalArgumentException("N must be a power of 2");
        byte[] b = pbkdf2(password, salt, p * 128 * r);
        int[] xy = new int[64 * r];
        int[] v = new int[32 * r * n];
        for (int i = 0; i < p; i++) roMix(b, i * 128 * r, r, n, v, xy);
        return pbkdf2(password, b, dkLen);
    }

    /** PBKDF2-HMAC-SHA256 with one iteration. */
    private static byte[] pbkdf2(byte[] password, byte[] salt, int len) throws GeneralSecurityException {
        Mac mac = Mac.getInstance("HmacSHA256");
        // SecretKeySpec refuses an empty key; HMAC zero-pads keys, so one zero byte is the same key.
        mac.init(new SecretKeySpec(password.length == 0 ? new byte[1] : password, "HmacSHA256"));
        byte[] out = new byte[len];
        int blocks = (len + 31) / 32;
        for (int i = 1; i <= blocks; i++) {
            mac.update(salt);
            mac.update(new byte[] {(byte) (i >>> 24), (byte) (i >>> 16), (byte) (i >>> 8), (byte) i});
            byte[] t = mac.doFinal();
            System.arraycopy(t, 0, out, (i - 1) * 32, Math.min(32, len - (i - 1) * 32));
        }
        return out;
    }

    private static void roMix(byte[] b, int off, int r, int n, int[] v, int[] xy) {
        int words = 32 * r;
        int[] x = new int[words];
        for (int i = 0; i < words; i++) {
            int j = off + i * 4;
            x[i] = (b[j] & 0xff) | (b[j + 1] & 0xff) << 8 | (b[j + 2] & 0xff) << 16 | (b[j + 3] & 0xff) << 24;
        }
        for (int i = 0; i < n; i++) {
            System.arraycopy(x, 0, v, i * words, words);
            blockMix(x, r, xy);
        }
        for (int i = 0; i < n; i++) {
            int j = x[(2 * r - 1) * 16] & (n - 1);
            for (int k = 0; k < words; k++) x[k] ^= v[j * words + k];
            blockMix(x, r, xy);
        }
        for (int i = 0; i < words; i++) {
            int j = off + i * 4;
            b[j] = (byte) x[i];
            b[j + 1] = (byte) (x[i] >>> 8);
            b[j + 2] = (byte) (x[i] >>> 16);
            b[j + 3] = (byte) (x[i] >>> 24);
        }
    }

    private static void blockMix(int[] b, int r, int[] y) {
        int[] x = new int[16];
        System.arraycopy(b, (2 * r - 1) * 16, x, 0, 16);
        for (int i = 0; i < 2 * r; i++) {
            for (int k = 0; k < 16; k++) x[k] ^= b[i * 16 + k];
            salsa8(x);
            System.arraycopy(x, 0, y, i * 16, 16);
        }
        for (int i = 0; i < r; i++) System.arraycopy(y, (2 * i) * 16, b, i * 16, 16);
        for (int i = 0; i < r; i++) System.arraycopy(y, (2 * i + 1) * 16, b, (r + i) * 16, 16);
    }

    private static void salsa8(int[] b) {
        int[] x = b.clone();
        for (int i = 0; i < 8; i += 2) {
            x[4] ^= Integer.rotateLeft(x[0] + x[12], 7);
            x[8] ^= Integer.rotateLeft(x[4] + x[0], 9);
            x[12] ^= Integer.rotateLeft(x[8] + x[4], 13);
            x[0] ^= Integer.rotateLeft(x[12] + x[8], 18);
            x[9] ^= Integer.rotateLeft(x[5] + x[1], 7);
            x[13] ^= Integer.rotateLeft(x[9] + x[5], 9);
            x[1] ^= Integer.rotateLeft(x[13] + x[9], 13);
            x[5] ^= Integer.rotateLeft(x[1] + x[13], 18);
            x[14] ^= Integer.rotateLeft(x[10] + x[6], 7);
            x[2] ^= Integer.rotateLeft(x[14] + x[10], 9);
            x[6] ^= Integer.rotateLeft(x[2] + x[14], 13);
            x[10] ^= Integer.rotateLeft(x[6] + x[2], 18);
            x[3] ^= Integer.rotateLeft(x[15] + x[11], 7);
            x[7] ^= Integer.rotateLeft(x[3] + x[15], 9);
            x[11] ^= Integer.rotateLeft(x[7] + x[3], 13);
            x[15] ^= Integer.rotateLeft(x[11] + x[7], 18);
            x[1] ^= Integer.rotateLeft(x[0] + x[3], 7);
            x[2] ^= Integer.rotateLeft(x[1] + x[0], 9);
            x[3] ^= Integer.rotateLeft(x[2] + x[1], 13);
            x[0] ^= Integer.rotateLeft(x[3] + x[2], 18);
            x[6] ^= Integer.rotateLeft(x[5] + x[4], 7);
            x[7] ^= Integer.rotateLeft(x[6] + x[5], 9);
            x[4] ^= Integer.rotateLeft(x[7] + x[6], 13);
            x[5] ^= Integer.rotateLeft(x[4] + x[7], 18);
            x[11] ^= Integer.rotateLeft(x[10] + x[9], 7);
            x[8] ^= Integer.rotateLeft(x[11] + x[10], 9);
            x[9] ^= Integer.rotateLeft(x[8] + x[11], 13);
            x[10] ^= Integer.rotateLeft(x[9] + x[8], 18);
            x[12] ^= Integer.rotateLeft(x[15] + x[14], 7);
            x[13] ^= Integer.rotateLeft(x[12] + x[15], 9);
            x[14] ^= Integer.rotateLeft(x[13] + x[12], 13);
            x[15] ^= Integer.rotateLeft(x[14] + x[13], 18);
        }
        for (int i = 0; i < 16; i++) b[i] += x[i];
    }
}
