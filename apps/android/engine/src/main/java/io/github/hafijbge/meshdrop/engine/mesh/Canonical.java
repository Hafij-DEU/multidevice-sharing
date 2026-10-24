package io.github.hafijbge.meshdrop.engine.mesh;

import io.github.hafijbge.meshdrop.engine.crypto.P256;
import io.github.hafijbge.meshdrop.engine.util.Hex;
import io.github.hafijbge.meshdrop.engine.util.Json;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.Signature;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * Canonical JSON and domain-separated signatures (docs/protocol.md "Canonical JSON and signatures"),
 * ported from packages/core/src/mesh/canonical.ts: keys sorted by UTF-16 code unit, no whitespace,
 * JSON.stringify string escaping, safe integers only. A signature is ECDSA P-256 / SHA-256 (DER,
 * base64) over utf8(domain) ‖ 0x00 ‖ payload.
 */
public final class Canonical {
    public static final int MAX_DEPTH = 64;
    private static final long MAX_SAFE = 9007199254740991L;

    public static final class CanonicalError extends IllegalArgumentException {
        CanonicalError(String m) {
            super(m);
        }
    }

    private Canonical() {}

    public static String json(Object v) {
        StringBuilder b = new StringBuilder();
        write(b, v, 0);
        return b.toString();
    }

    @SuppressWarnings("unchecked")
    private static void write(StringBuilder b, Object v, int depth) {
        if (depth > MAX_DEPTH) throw new CanonicalError("too deep");
        if (v == null) {
            b.append("null");
        } else if (v instanceof String) {
            Json.quote(b, (String) v);
        } else if (v instanceof Boolean) {
            b.append(((Boolean) v) ? "true" : "false");
        } else if (v instanceof Long || v instanceof Integer || v instanceof Short || v instanceof Byte) {
            long n = ((Number) v).longValue();
            if (Math.abs(n) > MAX_SAFE) throw new CanonicalError("unsafe integer");
            b.append(n);
        } else if (v instanceof Double || v instanceof Float) {
            double d = ((Number) v).doubleValue();
            if (d != Math.rint(d) || Math.abs(d) > MAX_SAFE) throw new CanonicalError("only safe integers");
            b.append((long) d); // -0 → 0
        } else if (v instanceof Map) {
            TreeMap<String, Object> sorted = new TreeMap<>(); // String.compareTo = UTF-16 code unit order
            for (Map.Entry<String, Object> e : ((Map<String, Object>) v).entrySet()) {
                if (e.getKey() == null) throw new CanonicalError("null key");
                sorted.put(e.getKey(), e.getValue());
            }
            b.append('{');
            boolean first = true;
            for (Map.Entry<String, Object> e : sorted.entrySet()) {
                if (!first) b.append(',');
                first = false;
                Json.quote(b, e.getKey());
                b.append(':');
                write(b, e.getValue(), depth + 1);
            }
            b.append('}');
        } else if (v instanceof List) {
            b.append('[');
            boolean first = true;
            for (Object x : (List<Object>) v) {
                if (!first) b.append(',');
                first = false;
                write(b, x, depth + 1);
            }
            b.append(']');
        } else {
            throw new CanonicalError("cannot canonicalize " + v.getClass().getSimpleName());
        }
    }

    private static boolean validDomain(String domain) {
        if (domain == null || domain.isEmpty()) return false;
        for (int i = 0; i < domain.length(); i++) {
            char c = domain.charAt(i);
            if (c < 0x21 || c > 0x7e) return false;
        }
        return true;
    }

    /** utf8(domain) ‖ 0x00 ‖ payload. */
    public static byte[] message(String domain, byte[] payload) {
        if (!validDomain(domain)) throw new IllegalArgumentException("invalid signature domain");
        byte[] d = domain.getBytes(StandardCharsets.US_ASCII);
        byte[] m = new byte[d.length + 1 + payload.length];
        System.arraycopy(d, 0, m, 0, d.length);
        System.arraycopy(payload, 0, m, d.length + 1, payload.length);
        return m;
    }

    public static String sign(String domain, byte[] payload, PrivateKey key) {
        try {
            Signature s = Signature.getInstance("SHA256withECDSA");
            s.initSign(key);
            s.update(message(domain, payload));
            return Base64.getEncoder().encodeToString(s.sign());
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }

    /** False (never throws) unless the domain, the base64 DER signature and the P-256 key are all valid and it verifies. */
    public static boolean verify(String domain, byte[] payload, String sigB64, PublicKey key) {
        try {
            if (!validDomain(domain) || sigB64 == null || sigB64.isEmpty() || key == null || !P256.isP256(key)) return false;
            byte[] sig = Base64.getDecoder().decode(sigB64);
            if (!Base64.getEncoder().encodeToString(sig).equals(sigB64)) return false;
            Signature s = Signature.getInstance("SHA256withECDSA");
            s.initVerify(key);
            s.update(message(domain, payload));
            return s.verify(sig);
        } catch (GeneralSecurityException | RuntimeException e) {
            return false;
        }
    }

    public static String spkiSha256(PublicKey pub) {
        try {
            return Hex.of(MessageDigest.getInstance("SHA-256").digest(P256.spki(pub)));
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }
}
