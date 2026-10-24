package io.github.hafijbge.meshdrop.engine.proto;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;

import io.github.hafijbge.meshdrop.engine.crypto.Hpke;
import io.github.hafijbge.meshdrop.engine.crypto.P256;
import io.github.hafijbge.meshdrop.engine.util.B64;
import io.github.hafijbge.meshdrop.engine.util.Hex;
import io.github.hafijbge.meshdrop.engine.util.Json;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyPair;
import java.util.Map;
import org.junit.Test;

public class ChunksTest {
    @SuppressWarnings("unchecked")
    static Map<String, Object> vector() throws Exception {
        return (Map<String, Object>) Json.parse(Files.readString(Path.of(System.getProperty("meshdrop.repo"), "protocol/vectors/chunk-v1.json")));
    }

    static byte[] h(Map<String, Object> m, String k) {
        return Hex.parse((String) m.get(k));
    }

    @Test
    @SuppressWarnings("unchecked")
    public void reproducesChunkVectorByteForByte() throws Exception {
        Map<String, Object> v = vector();
        Map<String, Object> in = (Map<String, Object>) v.get("inputs");
        KeyPair snd = new KeyPair(P256.publicFromSec1(h(in, "senderPublicKeyHex")), P256.privateFromScalar(h(in, "senderPrivateKeyScalarHex")));
        KeyPair rcv = new KeyPair(P256.publicFromSec1(h(in, "receiverPublicKeyHex")), P256.privateFromScalar(h(in, "receiverPrivateKeyScalarHex")));
        KeyPair eph = new KeyPair(P256.publicFromSec1(h(in, "skEPublicKeyHex")), P256.privateFromScalar(h(in, "skEScalarHex")));

        Manifest m = Manifest.fromJson(v.get("manifest"));
        assertEquals(v.get("manifestJson"), m.toJson());
        assertArrayEquals(h(v, "manifestJsonHex"), m.toJson().getBytes(StandardCharsets.UTF_8));
        assertArrayEquals(h(v, "infoHex"), Chunks.info(m.sessionId));
        assertArrayEquals(h(v, "manifestAadHex"), Chunks.manifestAad(m.sessionId));

        Offer.Created c = Offer.create(snd, (String) in.get("fromDeviceId"), rcv.getPublic(), m, eph);
        assertArrayEquals(h(v, "encHex"), B64.stdDecode(c.offer.enc));
        assertArrayEquals(h(v, "keyHex"), c.ctx.key());
        assertArrayEquals(h(v, "baseNonceHex"), c.ctx.baseNonce());
        assertArrayEquals(h(v, "exporterSecretHex"), c.ctx.exporterSecret());
        assertArrayEquals(h(v, "sealedManifestHex"), B64.stdDecode(c.offer.sealedManifest));
        assertEquals(Json.stringify(v.get("offer")), c.offer.toJson());

        Map<String, Object> ch = (Map<String, Object>) v.get("chunk");
        int fileId = ((Long) ch.get("fileId")).intValue();
        int index = ((Long) ch.get("index")).intValue();
        assertEquals(Long.parseLong((String) ch.get("seq")), Chunks.seq(fileId, index));
        assertArrayEquals(h(ch, "aadHex"), Chunks.aad(m.sessionId, fileId, index));
        byte[] sealed = Chunks.seal(c.ctx, m.sessionId, fileId, index, h(ch, "plaintextHex"));
        assertArrayEquals(h(ch, "sealedHex"), sealed);

        // Receiver side: open the offer with the sender key from the trust store.
        Offer.Opened o = Offer.open(c.offer.toJson().getBytes(StandardCharsets.UTF_8), rcv, (String) in.get("toDeviceId"),
                (String) in.get("fromDeviceId"), snd.getPublic());
        assertEquals(m.toJson(), o.manifest.toJson());
        assertArrayEquals(h(ch, "plaintextHex"), Chunks.open(o.ctx, m.sessionId, fileId, index, sealed));
    }

    @Test
    public void chunkCountsAndSeq() {
        assertEquals(0, Chunks.count(0));
        assertEquals(1, Chunks.count(1));
        assertEquals(1, Chunks.count(Chunks.CHUNK_SIZE));
        assertEquals(2, Chunks.count(Chunks.CHUNK_SIZE + 1L));
        assertEquals((2L << 32) | 7, Chunks.seq(1, 7));
        assertEquals(22, Offer.newSessionId().length());
        assertEquals(true, Offer.SESSION_ID.matcher(Offer.newSessionId()).matches());
    }

    @Test
    public void ctxSecretsRoundTrip() throws Exception {
        KeyPair a = P256.generate(), b = P256.generate();
        Hpke.Context ctx = Hpke.setupAuthS(b.getPublic(), new byte[] {1}, a, null).ctx;
        Hpke.Context back = Chunks.importCtx(Chunks.exportCtx(ctx));
        assertArrayEquals(ctx.key(), back.key());
        assertArrayEquals(ctx.baseNonce(), back.baseNonce());
        assertArrayEquals(ctx.exporterSecret(), back.exporterSecret());
    }
}
