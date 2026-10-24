package io.github.hafijbge.meshdrop.engine.mesh;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import io.github.hafijbge.meshdrop.engine.crypto.P256;
import io.github.hafijbge.meshdrop.engine.util.Hex;
import io.github.hafijbge.meshdrop.engine.util.Io;
import io.github.hafijbge.meshdrop.engine.util.Json;
import java.nio.charset.StandardCharsets;
import java.nio.file.Paths;
import java.security.KeyPair;
import java.security.PublicKey;
import java.util.List;
import java.util.Map;
import org.junit.Test;

public class CanonicalTest {
    @SuppressWarnings("unchecked")
    static Map<String, Object> vector() throws Exception {
        return (Map<String, Object>) Json.parse(Io.readString(Paths.get(System.getProperty("meshdrop.repo"), "protocol/vectors/canonical-v1.json")));
    }

    @Test
    @SuppressWarnings("unchecked")
    public void everyCanonicalCaseIsByteExact() throws Exception {
        for (Object o : (List<Object>) vector().get("cases")) {
            Map<String, Object> c = (Map<String, Object>) o;
            String got = Canonical.json(c.get("input"));
            assertEquals((String) c.get("name"), c.get("canonical"), got);
            assertArrayEquals(Hex.parse((String) c.get("canonicalHex")), got.getBytes(StandardCharsets.UTF_8));
        }
    }

    @Test
    @SuppressWarnings("unchecked")
    public void theStoredSignatureVerifiesAndTamperingFails() throws Exception {
        Map<String, Object> s = (Map<String, Object>) vector().get("signing");
        PublicKey pub = P256.publicFromSpki(Hex.parse((String) s.get("spkiDerHex")));
        String payload = Canonical.json(s.get("payloadValue"));
        assertEquals(s.get("payload"), payload);
        String domain = (String) s.get("domain");
        assertArrayEquals(Hex.parse((String) s.get("signedMessageHex")), Canonical.message(domain, payload.getBytes(StandardCharsets.UTF_8)));
        String sig = (String) s.get("signatureB64");
        assertTrue(Canonical.verify(domain, payload.getBytes(StandardCharsets.UTF_8), sig, pub));
        assertEquals(s.get("spkiSha256Hex"), Canonical.spkiSha256(pub));
        assertFalse(Canonical.verify(domain, (payload + " ").getBytes(StandardCharsets.UTF_8), sig, pub));
        assertFalse(Canonical.verify(domain + "x", payload.getBytes(StandardCharsets.UTF_8), sig, pub));
        assertFalse(Canonical.verify(domain, payload.getBytes(StandardCharsets.UTF_8), "", pub));
        assertFalse(Canonical.verify(domain, payload.getBytes(StandardCharsets.UTF_8), "not base64!", pub));
        assertFalse(Canonical.verify("bad\u0000domain", payload.getBytes(StandardCharsets.UTF_8), sig, pub));
        assertFalse(Canonical.verify(domain, payload.getBytes(StandardCharsets.UTF_8), sig, P256.generate().getPublic()));
    }

    @Test
    public void signAndVerifyRoundTripAndRejectNonCanonicalValues() {
        KeyPair kp = P256.generate();
        String sig = Canonical.sign("meshdrop-membership-v1", "x".getBytes(StandardCharsets.UTF_8), kp.getPrivate());
        assertTrue(Canonical.verify("meshdrop-membership-v1", "x".getBytes(StandardCharsets.UTF_8), sig, kp.getPublic()));
        assertThrows(IllegalArgumentException.class, () -> Canonical.sign("", new byte[0], kp.getPrivate()));
        assertThrows(Canonical.CanonicalError.class, () -> Canonical.json(1.5));
        assertThrows(Canonical.CanonicalError.class, () -> Canonical.json(9007199254740993.0));
        assertEquals("0", Canonical.json(-0.0));
        assertEquals("{\"a\":1,\"b\":2}", Canonical.json(Json.parse("{\"b\":2,\"a\":1}")));
    }
}
