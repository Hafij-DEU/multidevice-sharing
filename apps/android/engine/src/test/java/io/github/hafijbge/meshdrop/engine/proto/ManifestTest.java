package io.github.hafijbge.meshdrop.engine.proto;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import io.github.hafijbge.meshdrop.engine.crypto.P256;
import io.github.hafijbge.meshdrop.engine.util.Json;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.util.ArrayList;
import java.util.List;
import org.junit.Test;

public class ManifestTest {
    static final String A = "a".repeat(64);
    static final String B = "b".repeat(64);

    static Manifest base() {
        Manifest m = new Manifest();
        m.sessionId = Offer.newSessionId();
        m.from = A;
        m.to = B;
        m.createdAt = 1;
        return m;
    }

    static byte[] offerJson(KeyPair snd, KeyPair rcv, Manifest m) {
        return Offer.create(snd, A, rcv.getPublic(), m, null).offer.toJson().getBytes(StandardCharsets.UTF_8);
    }

    @Test
    public void clipboardTextRoundTripsAndKeyOrderIsFixed() {
        Manifest m = base();
        m.text = "copy me";
        m.clipboard = true;
        String j = m.toJson();
        assertTrue(j.endsWith(",\"files\":[],\"dirs\":[],\"text\":\"copy me\",\"clipboard\":true}"));
        assertEquals(j, Manifest.parse(j.getBytes(StandardCharsets.UTF_8)).toJson());
    }

    @Test
    public void clipboardWithFilesIsRefused() {
        Manifest m = base();
        m.text = "x";
        m.clipboard = true;
        m.files.add(new Manifest.FileEntry(0, "a.txt", 1, "text/plain", "0".repeat(64)));
        Offer.BadOffer e = assertThrows(Offer.BadOffer.class, () -> Manifest.parse(m.toJson().getBytes(StandardCharsets.UTF_8)));
        assertEquals(422, e.status);
    }

    @Test
    public void tooManyFilesAndDuplicateIds() {
        Manifest m = base();
        List<Manifest.FileEntry> f = new ArrayList<>();
        for (int i = 0; i <= 100_000; i++) f.add(new Manifest.FileEntry(i, "f" + i, 0, "x", "0".repeat(64)));
        m.files.addAll(f);
        assertEquals(422, assertThrows(Offer.BadOffer.class, () -> Manifest.parse(m.toJson().getBytes(StandardCharsets.UTF_8))).status);
        Manifest d = base();
        d.files.add(new Manifest.FileEntry(0, "a", 0, "x", "0".repeat(64)));
        d.files.add(new Manifest.FileEntry(0, "b", 0, "x", "0".repeat(64)));
        assertEquals(422, assertThrows(Offer.BadOffer.class, () -> Manifest.parse(d.toJson().getBytes(StandardCharsets.UTF_8))).status);
    }

    @Test
    public void offerChecksPeerAddresseeAndSenderKey() {
        KeyPair snd = P256.generate(), rcv = P256.generate();
        byte[] o = offerJson(snd, rcv, base());
        assertEquals(B, Offer.open(o, rcv, B, A, snd.getPublic()).manifest.to);
        // offer.from is not the TLS peer → 403 forbidden
        Offer.BadOffer f = assertThrows(Offer.BadOffer.class, () -> Offer.open(o, rcv, B, "c".repeat(64), snd.getPublic()));
        assertEquals(403, f.status);
        assertEquals("forbidden", f.code);
        // a JSON object without from is 403 too (checked right after parsing)
        assertEquals(403, assertThrows(Offer.BadOffer.class, () -> Offer.open("{\"v\":1}".getBytes(), rcv, B, A, snd.getPublic())).status);
        // not addressed to us → 422
        assertEquals(422, assertThrows(Offer.BadOffer.class, () -> Offer.open(o, rcv, "c".repeat(64), A, snd.getPublic())).status);
        // wrong sender key (decrypt fails) → 422
        assertEquals(422, assertThrows(Offer.BadOffer.class, () -> Offer.open(o, rcv, B, A, P256.generate().getPublic())).status);
        // non-object / bad session id → 422
        assertEquals(422, assertThrows(Offer.BadOffer.class, () -> Offer.open("[1]".getBytes(), rcv, B, A, snd.getPublic())).status);
        assertEquals(422, assertThrows(Offer.BadOffer.class,
                () -> Offer.open(("{\"v\":1,\"from\":\"" + A + "\",\"sessionId\":\"x\"}").getBytes(), rcv, B, A, snd.getPublic())).status);
        // invalid JSON → 400 bad-json
        assertEquals(400, assertThrows(Offer.BadOffer.class, () -> Offer.open("{".getBytes(), rcv, B, A, snd.getPublic())).status);
    }

    @Test
    public void numbersOutsideTheSchemaAreRefused() {
        Manifest m = base();
        String j = m.toJson().replace("\"createdAt\":1", "\"createdAt\":1.5");
        assertEquals(422, assertThrows(Offer.BadOffer.class, () -> Manifest.parse(j.getBytes(StandardCharsets.UTF_8))).status);
        assertTrue(Json.parse(j) != null);
    }
}
