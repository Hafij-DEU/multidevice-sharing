package io.github.hafijbge.meshdrop.engine.mesh;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import io.github.hafijbge.meshdrop.engine.crypto.P256;
import io.github.hafijbge.meshdrop.engine.crypto.TestKeys;
import io.github.hafijbge.meshdrop.engine.util.Hex;
import io.github.hafijbge.meshdrop.engine.util.Io;
import io.github.hafijbge.meshdrop.engine.util.Json;
import java.nio.charset.StandardCharsets;
import java.nio.file.Paths;
import java.security.KeyPair;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.util.Arrays;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.Test;

public class EnvelopeTest {
    static final String A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    static final String B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    @SuppressWarnings("unchecked")
    static Map<String, Object> vector() throws Exception {
        return (Map<String, Object>) Json.parse(Io.readString(Paths.get(System.getProperty("meshdrop.repo"), "protocol/vectors/envelope-v1.json")));
    }

    @Test
    @SuppressWarnings("unchecked")
    public void theVectorIsByteExactAndVerifies() throws Exception {
        Map<String, Object> v = vector();
        PublicKey pub = P256.publicFromSpki(Hex.parse((String) v.get("senderSpkiDerHex")));
        PrivateKey key = TestKeys.privateFromScalar(Hex.parse((String) v.get("senderScalarHex")));
        byte[] body = Hex.parse((String) v.get("bodyHex"));
        byte[] frame = Hex.parse((String) v.get("frameHex"));

        Envelope e = Envelope.decode(frame);
        assertArrayEquals(body, e.body);
        assertEquals(((Map<String, Object>) v.get("header")).get("sig"), e.header.sig);
        assertEquals(v.get("unsignedHeaderCanonical"), Canonical.json(e.header.toMap(false)));
        assertEquals(A, Envelope.open(e, id -> A.equals(id) ? pub : null).from);
        assertArrayEquals(frame, e.encode());

        Envelope.Header h = Envelope.Header.req("AAAAAAAAAAAAAAAAAAAAAA", A, B, "PUT", "/mesh/v1/chunk/AAAAAAAAAAAAAAAAAAAAAA/0/1");
        h.contentType = "application/octet-stream";
        Envelope sealed = Envelope.seal(h, body, key);
        assertEquals(v.get("unsignedHeaderCanonical"), Canonical.json(sealed.header.toMap(false)));
        Envelope.open(Envelope.decode(sealed.encode()), id -> pub);
    }

    @Test
    public void tamperingAndBadHeadersAreRefused() throws Exception {
        Map<String, Object> v = vector();
        PublicKey pub = P256.publicFromSpki(Hex.parse((String) v.get("senderSpkiDerHex")));
        byte[] frame = Hex.parse((String) v.get("frameHex"));
        byte[] flipped = frame.clone();
        flipped[flipped.length - 1] ^= 1;
        assertThrows(Envelope.EnvelopeError.class, () -> Envelope.open(Envelope.decode(flipped), id -> pub));
        assertThrows(Envelope.EnvelopeError.class, () -> Envelope.open(Envelope.decode(frame), id -> null));
        KeyPair other = P256.generate();
        assertThrows(Envelope.EnvelopeError.class, () -> Envelope.open(Envelope.decode(frame), id -> other.getPublic()));
        assertThrows(Envelope.EnvelopeError.class, () -> Envelope.decode(Arrays.copyOf(frame, 3)));
        assertThrows(Envelope.EnvelopeError.class, () -> Envelope.decode(Arrays.copyOf(frame, 100)));

        String head = new String(frame, 4, ((frame[2] & 0xff) << 8) | (frame[3] & 0xff), StandardCharsets.UTF_8);
        for (String bad : Arrays.asList(
                head.replace("\"v\":1", "\"v\":1,\"x\":1"),
                head.replace("/mesh/v1/chunk/", "/mesh/v1/../"),
                head.replace("/mesh/v1/chunk/", "/other/"),
                head.replace("\"PUT\"", "\"DELETE\""),
                head.replace("\"req\"", "\"res\""),
                head.replace("\"id\":\"AAAAAAAAAAAAAAAAAAAAAA\"", "\"id\":\"short\""),
                "[]", "{")) {
            assertThrows(bad, Envelope.EnvelopeError.class, () -> Envelope.decode(frame(bad, new byte[0])));
        }
        byte[] huge = new byte[8];
        huge[1] = 1; // 65536 > 16384
        assertThrows(Envelope.EnvelopeError.class, () -> Envelope.decode(huge));

        KeyPair k = P256.generate();
        Envelope.Header h = Envelope.Header.req("AAAAAAAAAAAAAAAAAAAAAA", A, B, "POST", "/mesh/v1/offer");
        h.contentType = "x/" + new String(new char[140]).replace('\0', 'y');
        assertThrows(Envelope.EnvelopeError.class, () -> Envelope.seal(h, new byte[0], k.getPrivate()));
        Envelope.Header res = Envelope.Header.res("AAAAAAAAAAAAAAAAAAAAAA", B, A, 200);
        Envelope ok = Envelope.seal(res, "{}".getBytes(StandardCharsets.UTF_8), k.getPrivate());
        assertEquals(Long.valueOf(200), (Long) ok.header.toMap(true).get("status"));
        Envelope.Header big = Envelope.Header.res("AAAAAAAAAAAAAAAAAAAAAA", B, A, 600);
        assertThrows(Envelope.EnvelopeError.class, () -> Envelope.seal(big, new byte[0], k.getPrivate()));
    }

    static byte[] frame(String head, byte[] body) {
        byte[] h = head.getBytes(StandardCharsets.UTF_8);
        byte[] out = new byte[4 + h.length + body.length];
        out[2] = (byte) (h.length >> 8);
        out[3] = (byte) h.length;
        System.arraycopy(h, 0, out, 4, h.length);
        System.arraycopy(body, 0, out, 4 + h.length, body.length);
        return out;
    }

    @Test
    public void theReplayGuardRemembersIdsAndAnswersWithinItsTtl() {
        AtomicLong now = new AtomicLong(1000);
        ReplayGuard g = new ReplayGuard(2, 600_000, now::get);
        assertFalse(g.seen("a"));
        assertTrue(g.seen("a"));
        g.answer("a", new byte[] {1});
        assertArrayEquals(new byte[] {1}, g.cached("a"));
        assertFalse(g.seen("b"));
        assertFalse(g.seen("c")); // evicts "a" (max 2)
        assertFalse(g.seen("a"));
        assertEquals(null, g.cached("a"));
        now.addAndGet(600_001);
        assertFalse(g.seen("c"));
    }
}
