package io.github.hafijbge.meshdrop.engine.identity;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import io.github.hafijbge.meshdrop.engine.crypto.P256;
import io.github.hafijbge.meshdrop.engine.util.Hex;
import io.github.hafijbge.meshdrop.engine.util.Json;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyPair;
import java.security.Signature;
import java.util.Base64;
import java.util.Map;
import org.junit.Test;

public class X509Test {
    @Test
    @SuppressWarnings("unchecked")
    public void tbsMatchesTheNodeProfileVector() throws Exception {
        Map<String, Object> v = (Map<String, Object>) Json.parse(Files.readString(Path.of(System.getProperty("meshdrop.repo"), "protocol/vectors/x509-v1.json")));
        String pem = ((String) v.get("privateKeyPem")).replaceAll("-----[A-Z ]+-----|\\s", "");
        java.security.interfaces.ECPrivateKey sk = P256.privateFromPkcs8(Base64.getDecoder().decode(pem));
        KeyPair kp = new KeyPair(P256.publicFromSpki(Hex.parse((String) v.get("publicKeySpkiHex"))), sk);
        byte[] tbs = X509.tbs(kp.getPublic(), Hex.parse((String) v.get("serialHex")), (String) v.get("commonName"));
        assertEquals(v.get("tbsHex"), Hex.of(tbs));
    }

    @Test
    public void selfSignedVerifiesAndParses() throws Exception {
        KeyPair kp = P256.generate();
        byte[] der = X509.selfSigned(kp, new byte[] {(byte) 0x80, 1, 2}, "meshdrop-test");
        java.security.cert.X509Certificate c = X509.parse(der);
        c.verify(kp.getPublic());
        assertArrayEquals(P256.sec1(kp.getPublic()), P256.sec1(X509.publicKey(der)));
        Signature s = Signature.getInstance("SHA256withECDSA");
        s.initVerify(kp.getPublic());
        assertTrue(c.getSigAlgName().toUpperCase().contains("ECDSA"));
    }
}
