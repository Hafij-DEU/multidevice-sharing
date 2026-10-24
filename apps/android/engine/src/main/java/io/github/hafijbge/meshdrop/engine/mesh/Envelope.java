package io.github.hafijbge.meshdrop.engine.mesh;

import io.github.hafijbge.meshdrop.engine.util.Hex;
import io.github.hafijbge.meshdrop.engine.util.Json;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.util.Arrays;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;
import java.util.regex.Pattern;

/**
 * Relay envelopes (protocol v1), ported from mesh/envelope.ts: one receiver-API request or response
 * carried over the hub link. The sender signs the header, which binds the body by its SHA-256.
 *   sig   = sign('meshdrop-envelope-v1', canonicalJson(header without sig))
 *   frame = u32be(len(H)) || H || body,  H = utf8(canonicalJson(header))
 */
public final class Envelope {
    public static final String DOMAIN = "meshdrop-envelope-v1";
    public static final int MAX_HEADER_BYTES = 16384;
    private static final Pattern ID = Pattern.compile("^[A-Za-z0-9_-]{22}$");
    private static final Pattern HEX64 = Pattern.compile("^[0-9a-f]{64}$");
    /** Segments are [A-Za-z0-9_-]+ only: no dots (so no '..'), no query, no encoding tricks. */
    private static final Pattern PATH = Pattern.compile("^/mesh/v1/[A-Za-z0-9_-]+(/[A-Za-z0-9_-]+)*$");
    private static final Pattern CONTENT_TYPE = Pattern.compile("^[\\x21-\\x7e][\\x20-\\x7e]{0,127}$");
    private static final Pattern B64 = Pattern.compile("^[A-Za-z0-9+/]+={0,2}$");
    private static final Set<String> METHODS = new HashSet<>(Arrays.asList("GET", "POST", "PUT"));
    private static final Set<String> KEYS = new HashSet<>(Arrays.asList(
            "v", "kind", "id", "from", "to", "method", "path", "status", "contentType", "bodySha256", "holdBytes", "sig"));

    public static final class EnvelopeError extends IllegalArgumentException {
        public EnvelopeError(String m) {
            super(m);
        }
    }

    private static EnvelopeError bad(String why) {
        return new EnvelopeError("invalid envelope: " + why);
    }

    public static final class Header {
        public String kind;
        /** 16 random bytes, base64url without padding; a res repeats its req's id. */
        public String id;
        public String from;
        public String to;
        public String method;
        public String path;
        public Integer status;
        public String contentType;
        public String bodySha256;
        /** Held delivery only: the total bytes the sender will upload for the session. */
        public Long holdBytes;
        public String sig;

        public static Header req(String id, String from, String to, String method, String path) {
            Header h = new Header();
            h.kind = "req";
            h.id = id;
            h.from = from;
            h.to = to;
            h.method = method;
            h.path = path;
            return h;
        }

        public static Header res(String id, String from, String to, int status) {
            Header h = new Header();
            h.kind = "res";
            h.id = id;
            h.from = from;
            h.to = to;
            h.status = status;
            return h;
        }

        Header copy() {
            Header h = new Header();
            h.kind = kind;
            h.id = id;
            h.from = from;
            h.to = to;
            h.method = method;
            h.path = path;
            h.status = status;
            h.contentType = contentType;
            h.bodySha256 = bodySha256;
            h.holdBytes = holdBytes;
            h.sig = sig;
            return h;
        }

        public Map<String, Object> toMap(boolean withSig) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("v", 1L);
            m.put("kind", kind);
            m.put("id", id);
            m.put("from", from);
            m.put("to", to);
            if (method != null) m.put("method", method);
            if (path != null) m.put("path", path);
            if (status != null) m.put("status", (long) status);
            if (contentType != null) m.put("contentType", contentType);
            if (bodySha256 != null) m.put("bodySha256", bodySha256);
            if (holdBytes != null) m.put("holdBytes", holdBytes);
            if (withSig && sig != null) m.put("sig", sig);
            return m;
        }

        /** Validates every field; `sig` is required when `signed`, forbidden otherwise. */
        void check(boolean signed) {
            if (!"req".equals(kind) && !"res".equals(kind)) throw bad("kind");
            if (id == null || !ID.matcher(id).matches()) throw bad("id");
            if (from == null || !HEX64.matcher(from).matches()) throw bad("from");
            if (to == null || !HEX64.matcher(to).matches()) throw bad("to");
            if (bodySha256 == null || !HEX64.matcher(bodySha256).matches()) throw bad("bodySha256");
            if (contentType != null && !CONTENT_TYPE.matcher(contentType).matches()) throw bad("contentType");
            if (holdBytes != null && (holdBytes < 0 || holdBytes > 9007199254740991L)) throw bad("holdBytes");
            if (kind.equals("req")) {
                if (method == null || !METHODS.contains(method)) throw bad("method");
                if (path == null || !PATH.matcher(path).matches()) throw bad("path");
                if (status != null) throw bad("status on a req");
            } else {
                if (status == null || status < 100 || status > 599) throw bad("status");
                if (method != null || path != null || holdBytes != null) throw bad("req fields on a res");
            }
            if (signed) {
                if (sig == null || !B64.matcher(sig).matches() || sig.length() > 200) throw bad("sig");
            } else if (sig != null) {
                throw bad("sig");
            }
        }

        static String str(Map<?, ?> o, String k) {
            Object v = o.get(k);
            if (v == null) return null;
            if (!(v instanceof String)) throw bad(k);
            return (String) v;
        }

        static Header fromJson(Object o) {
            if (!(o instanceof Map)) throw bad("header is not an object");
            Map<?, ?> m = (Map<?, ?>) o;
            for (Object k : m.keySet()) if (!KEYS.contains(k)) throw bad("unknown field");
            if (!Long.valueOf(1).equals(m.get("v"))) throw bad("v");
            Header h = new Header();
            h.kind = str(m, "kind");
            h.id = str(m, "id");
            h.from = str(m, "from");
            h.to = str(m, "to");
            h.method = str(m, "method");
            h.path = str(m, "path");
            h.contentType = str(m, "contentType");
            h.bodySha256 = str(m, "bodySha256");
            h.sig = str(m, "sig");
            Object st = m.get("status");
            if (st != null) {
                if (!(st instanceof Long) || (Long) st < 100 || (Long) st > 599) throw bad("status");
                h.status = (int) (long) (Long) st;
            }
            Object hb = m.get("holdBytes");
            if (hb != null) {
                if (!(hb instanceof Long)) throw bad("holdBytes");
                h.holdBytes = (Long) hb;
            }
            h.check(true);
            return h;
        }
    }

    public final Header header;
    public final byte[] body;

    public Envelope(Header header, byte[] body) {
        this.header = header;
        this.body = body;
    }

    static String sha256(byte[] b) {
        try {
            return Hex.of(MessageDigest.getInstance("SHA-256").digest(b));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    /** Signs `h` (its bodySha256 and sig are set here) over `body`. */
    public static Envelope seal(Header h, byte[] body, PrivateKey key) {
        Header u = h.copy();
        u.sig = null;
        u.bodySha256 = sha256(body);
        u.check(false);
        u.sig = Canonical.sign(DOMAIN, Canonical.json(u.toMap(false)).getBytes(StandardCharsets.UTF_8), key);
        return new Envelope(u, body);
    }

    /** Verifies the envelope and returns its header; throws EnvelopeError on anything wrong. */
    public static Header open(Envelope e, Function<String, PublicKey> pubOf) {
        e.header.check(true);
        PublicKey pub = pubOf.apply(e.header.from);
        if (pub == null) throw bad("unknown sender");
        byte[] payload = Canonical.json(e.header.toMap(false)).getBytes(StandardCharsets.UTF_8);
        if (!Canonical.verify(DOMAIN, payload, e.header.sig, pub)) throw bad("bad signature");
        if (!sha256(e.body).equals(e.header.bodySha256)) throw bad("body hash mismatch");
        return e.header;
    }

    public byte[] encode() {
        byte[] head = Canonical.json(header.toMap(true)).getBytes(StandardCharsets.UTF_8);
        if (head.length > MAX_HEADER_BYTES) throw bad("header too long");
        byte[] out = new byte[4 + head.length + body.length];
        out[0] = (byte) (head.length >>> 24);
        out[1] = (byte) (head.length >>> 16);
        out[2] = (byte) (head.length >>> 8);
        out[3] = (byte) head.length;
        System.arraycopy(head, 0, out, 4, head.length);
        System.arraycopy(body, 0, out, 4 + head.length, body.length);
        return out;
    }

    /** Parses a frame; the header is shape-checked here and must still go through open(). */
    public static Envelope decode(byte[] buf) {
        if (buf.length < 4) throw bad("truncated frame");
        long len = ((buf[0] & 0xffL) << 24) | ((buf[1] & 0xff) << 16) | ((buf[2] & 0xff) << 8) | (buf[3] & 0xff);
        if (len > MAX_HEADER_BYTES) throw bad("header too long");
        if (buf.length < 4 + len) throw bad("truncated frame");
        Object parsed;
        try {
            parsed = Json.parse(new String(buf, 4, (int) len, StandardCharsets.UTF_8));
        } catch (RuntimeException ex) {
            throw bad("header is not JSON");
        }
        return new Envelope(Header.fromJson(parsed), Arrays.copyOfRange(buf, 4 + (int) len, buf.length));
    }
}
