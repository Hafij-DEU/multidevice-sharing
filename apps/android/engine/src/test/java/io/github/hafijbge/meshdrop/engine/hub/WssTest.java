package io.github.hafijbge.meshdrop.engine.hub;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNotNull;

import io.github.hafijbge.meshdrop.engine.identity.Identity;
import io.github.hafijbge.meshdrop.engine.identity.PlainKeyVault;
import io.github.hafijbge.meshdrop.engine.mesh.MembershipStore;
import io.github.hafijbge.meshdrop.engine.testutil.NodeListen;
import io.github.hafijbge.meshdrop.engine.testutil.NodeMesh;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.KeyStore;
import java.security.cert.CertificateFactory;
import java.util.concurrent.TimeUnit;
import javax.net.ssl.TrustManagerFactory;
import javax.net.ssl.X509TrustManager;
import org.junit.After;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

/**
 * wss:// hub URLs (a tunnel in front of the hub's loopback ingress): CA-validated TLS with the host
 * name checked. A TLS proxy with a certificate from a test CA for "localhost" stands in for the tunnel.
 */
public class WssTest {
    @Rule public TemporaryFolder tmp = new TemporaryFolder();

    static final String PROXY = String.join("\n",
            "const tls = require('node:tls'); const net = require('node:net'); const fs = require('node:fs');",
            "const [key, cert] = process.argv.slice(2);",
            "const s = tls.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert), minVersion: 'TLSv1.3' }, (c) => {",
            "  const u = net.connect(53319, '127.0.0.1'); c.pipe(u); u.pipe(c);",
            "  c.on('error', () => u.destroy()); u.on('error', () => c.destroy());",
            "});",
            "s.listen(0, '127.0.0.1', () => console.log('PORT ' + s.address().port));");

    Process proxy;
    int port;
    X509TrustManager testCa;

    static void sh(File dir, String... cmd) throws Exception {
        Process p = new ProcessBuilder(cmd).directory(dir).redirectErrorStream(true).start();
        String out = new String(p.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        if (!p.waitFor(60, TimeUnit.SECONDS) || p.exitValue() != 0) throw new AssertionError(String.join(" ", cmd) + ": " + out);
    }

    @Before
    public void start() throws Exception {
        File d = tmp.newFolder("pki");
        sh(d, "openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-subj", "/CN=MeshDrop test CA", "-days", "2");
        sh(d, "openssl", "req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", "srv.key", "-out", "srv.csr", "-subj", "/CN=localhost");
        Files.write(new File(d, "ext.cnf").toPath(), "subjectAltName=DNS:localhost\n".getBytes(StandardCharsets.UTF_8));
        sh(d, "openssl", "x509", "-req", "-in", "srv.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "srv.pem", "-days", "2", "-extfile", "ext.cnf");
        KeyStore ks = KeyStore.getInstance(KeyStore.getDefaultType());
        ks.load(null, null);
        try (FileInputStream in = new FileInputStream(new File(d, "ca.pem"))) {
            ks.setCertificateEntry("ca", CertificateFactory.getInstance("X.509").generateCertificate(in));
        }
        TrustManagerFactory f = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
        f.init(ks);
        testCa = (X509TrustManager) f.getTrustManagers()[0];
        File js = new File(d, "proxy.cjs");
        Files.write(js.toPath(), PROXY.getBytes(StandardCharsets.UTF_8));
        proxy = new ProcessBuilder("node", js.getPath(), new File(d, "srv.key").getPath(), new File(d, "srv.pem").getPath()).redirectErrorStream(true).start();
        String line = new BufferedReader(new InputStreamReader(proxy.getInputStream(), StandardCharsets.UTF_8)).readLine();
        assertNotNull(line);
        port = Integer.parseInt(line.replace("PORT ", "").trim());
    }

    @After
    public void stop() {
        if (proxy != null) proxy.destroyForcibly();
    }

    HubClient client(String url) throws Exception {
        File hubHome = tmp.newFolder("hub");
        File phoneHome = tmp.newFolder("phone");
        NodeMesh.hubInit(hubHome);
        Identity phone = Identity.loadOrCreate(phoneHome, new PlainKeyVault());
        MembershipStore ms = NodeMesh.addMember(hubHome, phone, phoneHome, "phone", url);
        hub = NodeListen.start(hubHome);
        HubClient.Options o = new HubClient.Options(phone, () -> ms);
        o.caTrust = testCa;
        o.backoffMs = new long[] {100};
        return new HubClient(o);
    }

    NodeListen hub;

    @Test
    public void linksThroughATunnelWhoseCertificateNamesTheHost() throws Exception {
        HubClient c = client("wss://localhost:" + port + "/mesh/v1/hub");
        try {
            c.start();
            long end = System.currentTimeMillis() + 15_000;
            while (c.state() != HubClient.State.ONLINE && System.currentTimeMillis() < end) Thread.sleep(50);
            assertEquals(HubClient.State.ONLINE, c.state());
        } finally {
            c.shutdown();
            hub.close();
        }
    }

    @Test
    public void refusesACertificateForAnotherHostName() throws Exception {
        // Same proxy and CA, reached as 127.0.0.1: the certificate names only "localhost".
        HubClient c = client("wss://127.0.0.1:" + port + "/mesh/v1/hub");
        try {
            c.start();
            Thread.sleep(3000);
            assertNotEquals(HubClient.State.ONLINE, c.state());
        } finally {
            c.shutdown();
            hub.close();
        }
    }
}
