package io.github.hafijbge.meshdrop.engine.util;

/** Lower-case hex (java.util.HexFormat is API 34+, so not used). */
public final class Hex {
    private static final char[] DIGITS = "0123456789abcdef".toCharArray();

    private Hex() {}

    public static String of(byte[] b) {
        char[] c = new char[b.length * 2];
        for (int i = 0; i < b.length; i++) {
            c[2 * i] = DIGITS[(b[i] >> 4) & 0xf];
            c[2 * i + 1] = DIGITS[b[i] & 0xf];
        }
        return new String(c);
    }

    public static byte[] parse(String s) {
        if (s.length() % 2 != 0) throw new IllegalArgumentException("odd hex length");
        byte[] out = new byte[s.length() / 2];
        for (int i = 0; i < out.length; i++) {
            int hi = Character.digit(s.charAt(2 * i), 16);
            int lo = Character.digit(s.charAt(2 * i + 1), 16);
            if (hi < 0 || lo < 0) throw new IllegalArgumentException("bad hex digit");
            out[i] = (byte) ((hi << 4) | lo);
        }
        return out;
    }
}
