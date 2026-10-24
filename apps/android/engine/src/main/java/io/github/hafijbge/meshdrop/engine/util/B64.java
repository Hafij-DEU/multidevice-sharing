package io.github.hafijbge.meshdrop.engine.util;

import java.util.Base64;

/** Base64 as the protocol uses it: standard padded (strict) and base64url without padding. */
public final class B64 {
    private B64() {}

    public static String std(byte[] b) {
        return Base64.getEncoder().encodeToString(b);
    }

    /** Strict: padded standard alphabet only, and it must re-encode to the same text. */
    public static byte[] stdDecode(String s) {
        if (s.length() % 4 != 0) throw new IllegalArgumentException("base64 length");
        byte[] out = Base64.getDecoder().decode(s);
        if (!std(out).equals(s)) throw new IllegalArgumentException("non-canonical base64");
        return out;
    }

    public static String url(byte[] b) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(b);
    }

    public static byte[] urlDecode(String s) {
        if (s.indexOf('=') >= 0) throw new IllegalArgumentException("padded base64url");
        byte[] out = Base64.getUrlDecoder().decode(s);
        if (!url(out).equals(s)) throw new IllegalArgumentException("non-canonical base64url");
        return out;
    }
}
