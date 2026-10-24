package io.github.hafijbge.meshdrop.engine.crypto;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import io.github.hafijbge.meshdrop.engine.util.Hex;
import io.github.hafijbge.meshdrop.engine.util.Json;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyPair;
import java.util.List;
import java.util.Map;
import javax.crypto.AEADBadTagException;
import org.junit.Test;

public class HpkeTest {
    @SuppressWarnings("unchecked")
    static List<Object> vectors() throws Exception {
        Path p = Path.of(System.getProperty("meshdrop.repo"), "protocol/vectors/hpke-auth-p256.json");
        return (List<Object>) Json.parse(Files.readString(p));
    }

    static byte[] h(Map<String, Object> m, String k) {
        return Hex.parse((String) m.get(k));
    }

    static KeyPair pair(Map<String, Object> v, String sk, String pk) throws Exception {
        return new KeyPair(P256.publicFromSec1(h(v, pk)), P256.privateFromScalar(h(v, sk)));
    }

    @Test
    @SuppressWarnings("unchecked")
    public void reproducesRfc9180AuthVectors() throws Exception {
        List<Object> vs = vectors();
        assertEquals(2, vs.size());
        for (Object o : vs) {
            Map<String, Object> v = (Map<String, Object>) o;
            assertEquals(2L, v.get("mode"));
            Hpke.Aead aead = ((Long) v.get("aead_id")) == 1L ? Hpke.Aead.AES_128_GCM : Hpke.Aead.AES_256_GCM;
            KeyPair e = pair(v, "skEm", "pkEm");
            KeyPair r = pair(v, "skRm", "pkRm");
            KeyPair s = pair(v, "skSm", "pkSm");
            byte[] info = h(v, "info");

            Hpke.Sender snd = Hpke.setupAuthS(r.getPublic(), info, s, e, aead);
            assertArrayEquals(h(v, "enc"), snd.enc);
            assertArrayEquals(h(v, "shared_secret"), snd.sharedSecret);
            assertArrayEquals(h(v, "key"), snd.ctx.key());
            assertArrayEquals(h(v, "base_nonce"), snd.ctx.baseNonce());
            assertArrayEquals(h(v, "exporter_secret"), snd.ctx.exporterSecret());

            Hpke.Context rcv = Hpke.setupAuthR(snd.enc, r, info, s.getPublic(), aead);
            assertArrayEquals(h(v, "key"), rcv.key());

            List<Object> encs = (List<Object>) v.get("encryptions");
            for (int i = 0; i < encs.size(); i++) {
                Map<String, Object> x = (Map<String, Object>) encs.get(i);
                byte[] ct = snd.ctx.seal(i, h(x, "aad"), h(x, "pt"));
                assertArrayEquals("seq " + i, h(x, "ct"), ct);
                assertArrayEquals(h(x, "pt"), rcv.open(i, h(x, "aad"), ct));
            }
        }
    }

    @Test
    @SuppressWarnings("unchecked")
    public void openRejectsTamperingAndWrongSeq() throws Exception {
        Map<String, Object> v = (Map<String, Object>) vectors().get(1);
        KeyPair r = pair(v, "skRm", "pkRm");
        KeyPair s = pair(v, "skSm", "pkSm");
        Hpke.Sender snd = Hpke.setupAuthS(r.getPublic(), new byte[] {1}, s, null, Hpke.Aead.AES_256_GCM);
        Hpke.Context rcv = Hpke.setupAuthR(snd.enc, r, new byte[] {1}, s.getPublic(), Hpke.Aead.AES_256_GCM);
        byte[] ct = snd.ctx.seal(5, new byte[0], "hello".getBytes());
        byte[] bad = ct.clone();
        bad[bad.length - 1] ^= 1;
        assertThrows(AEADBadTagException.class, () -> rcv.open(5, new byte[0], bad));
        assertThrows(AEADBadTagException.class, () -> rcv.open(6, new byte[0], ct));
        assertArrayEquals("hello".getBytes(), rcv.open(5, new byte[0], ct));
        // A different sender key is a different context.
        KeyPair other = P256.generate();
        Hpke.Context wrong = Hpke.setupAuthR(snd.enc, r, new byte[] {1}, other.getPublic(), Hpke.Aead.AES_256_GCM);
        assertThrows(AEADBadTagException.class, () -> wrong.open(5, new byte[0], ct));
    }

    @Test
    public void p256EncodingsRoundTripAndRejectBadPoints() throws Exception {
        KeyPair kp = P256.generate();
        byte[] sec1 = P256.sec1(kp.getPublic());
        assertEquals(65, sec1.length);
        assertArrayEquals(sec1, P256.sec1(P256.publicFromSec1(sec1)));
        assertArrayEquals(sec1, P256.sec1(P256.publicFromSpki(P256.spki(kp.getPublic()))));
        assertArrayEquals(P256.pkcs8(kp.getPrivate()), P256.pkcs8(P256.privateFromPkcs8(P256.pkcs8(kp.getPrivate()))));
        byte[] off = sec1.clone();
        off[64] ^= 1; // y no longer on the curve
        assertThrows(IllegalArgumentException.class, () -> P256.publicFromSec1(off));
        assertThrows(IllegalArgumentException.class, () -> P256.publicFromSec1(new byte[64]));
        KeyPair b = P256.generate();
        assertArrayEquals(P256.ecdh(kp.getPrivate(), b.getPublic()), P256.ecdh(b.getPrivate(), kp.getPublic()));
    }
}
