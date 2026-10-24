package io.github.hafijbge.meshdrop.engine.identity;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.assertThrows;

import io.github.hafijbge.meshdrop.engine.crypto.P256;
import io.github.hafijbge.meshdrop.engine.testutil.Node;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Base64;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class IdentityTest {
    @Rule public TemporaryFolder tmp = new TemporaryFolder();

    @Test
    public void createsOnceAndReloadsTheSameId() throws Exception {
        File home = tmp.newFolder();
        Identity a = Identity.loadOrCreate(home, new PlainKeyVault());
        Identity b = Identity.loadOrCreate(home, new PlainKeyVault());
        assertEquals(a.deviceId(), b.deviceId());
        assertTrue(a.deviceId().matches("[0-9a-f]{64}"));
        assertEquals(a.deviceId().substring(0, 8), a.shortId());
        assertTrue(X509.parse(a.certDer()).getSubjectX500Principal().getName().startsWith("CN=meshdrop-"));
    }

    @Test
    public void refusesHalfAnIdentity() throws Exception {
        File home = tmp.newFolder();
        Identity.loadOrCreate(home, new PlainKeyVault());
        assertTrue(new File(home, "identity/key.bin").delete());
        IOException e = assertThrows(IOException.class, () -> Identity.loadOrCreate(home, new PlainKeyVault()));
        assertTrue(e.getMessage(), e.getMessage().contains("identity/key.bin"));
    }

    @Test
    public void vaultSealsTheKey() throws Exception {
        File home = tmp.newFolder();
        KeyVault xor = new KeyVault() {
            public byte[] seal(byte[] b) {
                byte[] o = b.clone();
                for (int i = 0; i < o.length; i++) o[i] ^= 0x5a;
                return o;
            }

            public byte[] open(byte[] b) {
                return seal(b);
            }
        };
        Identity a = Identity.loadOrCreate(home, xor);
        assertEquals(a.deviceId(), Identity.loadOrCreate(home, xor).deviceId());
        assertThrows(IOException.class, () -> Identity.loadOrCreate(home, new PlainKeyVault()));
    }

    @Test
    public void nodeAcceptsOurCertificate() throws Exception {
        File home = tmp.newFolder();
        Identity id = Identity.loadOrCreate(home, new PlainKeyVault());
        File nodeHome = tmp.newFolder();
        File dir = new File(nodeHome, "identity");
        assertTrue(dir.mkdirs());
        Files.write(new File(dir, "cert.der").toPath(), id.certDer());
        String pem = "-----BEGIN PRIVATE KEY-----\n" + Base64.getMimeEncoder(64, "\n".getBytes()).encodeToString(P256.pkcs8(id.keyPair().getPrivate()))
                + "\n-----END PRIVATE KEY-----\n";
        Files.write(new File(dir, "key.pem").toPath(), pem.getBytes(StandardCharsets.US_ASCII));
        Node.Result r = Node.run("id", "--home", nodeHome.getPath());
        assertEquals(r.out, 0, r.code);
        assertTrue(r.out, r.out.contains("device id: " + id.deviceId()));
    }
}
