package io.github.hafijbge.meshdrop.engine.net;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import io.github.hafijbge.meshdrop.engine.identity.Identity;
import io.github.hafijbge.meshdrop.engine.identity.PlainKeyVault;
import io.github.hafijbge.meshdrop.engine.recv.MeshServer;
import io.github.hafijbge.meshdrop.engine.testutil.Peers;
import io.github.hafijbge.meshdrop.engine.util.Json;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import javax.net.ssl.SSLSocket;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class HttpTest {
    @Rule public TemporaryFolder tmp = new TemporaryFolder();

    static String readAll(SSLSocket s) throws Exception {
        s.setSoTimeout(5000);
        InputStream in = s.getInputStream();
        return new String(in.readAllBytes(), StandardCharsets.UTF_8);
    }

    @Test
    public void oversizedHeaderBlockIs431AndClosed() throws Exception {
        try (Peers.Receiver r = Peers.receiver(tmp.newFolder())) {
            SSLSocket s = Tls.connect(Tls.probeClient(), "127.0.0.1", r.port, 3000);
            OutputStream out = s.getOutputStream();
            out.write(("GET /mesh/v1/info HTTP/1.1\r\nHost: x\r\nX-Big: " + "a".repeat(17 * 1024) + "\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
            out.flush();
            String resp = readAll(s); // readAll returns only when the server closes
            assertTrue(resp, resp.startsWith("HTTP/1.1 431 "));
        }
    }

    @Test
    public void hugeContentLengthIs413BeforeTheBodyIsRead() throws Exception {
        try (Peers.Receiver r = Peers.receiver(tmp.newFolder())) {
            Identity client = Identity.loadOrCreate(tmp.newFolder(), new PlainKeyVault());
            r.trust.add(client.deviceId(), "c", TrustStore.pem(client.keyPair().getPublic()));
            SSLSocket s = Tls.connect(Tls.pinnedClient(client, r.id.deviceId()), "127.0.0.1", r.port, 3000);
            s.getOutputStream().write("POST /mesh/v1/offer HTTP/1.1\r\nHost: x\r\nContent-Length: 99999999999\r\n\r\n{".getBytes(StandardCharsets.US_ASCII));
            Http.Response resp = Http.readResponse(s.getInputStream(), 1 << 16);
            assertEquals(413, resp.status);
            assertEquals("too-large", ((Map<?, ?>) Json.parse(resp.text())).get("error"));
        }
    }

    @Test
    public void anIdleClientIsDroppedWhileOthersAreServed() throws Exception {
        MeshServer.Options o = new MeshServer.Options();
        o.idleTimeoutMs = 300;
        try (Peers.Receiver r = Peers.receiver(tmp.newFolder(), o)) {
            SSLSocket idle = Tls.connect(Tls.probeClient(), "127.0.0.1", r.port, 3000);
            Http.Response info = Http.request(Tls.connect(Tls.probeClient(), "127.0.0.1", r.port, 3000), "GET", "/mesh/v1/info", null, null, 4096);
            assertEquals(200, info.status);
            idle.setSoTimeout(5000);
            long t0 = System.nanoTime();
            int b;
            try {
                b = idle.getInputStream().read();
            } catch (SocketTimeoutException e) {
                throw new AssertionError("idle connection was not closed");
            } catch (java.io.IOException closed) {
                b = -1;
            }
            assertEquals(-1, b);
            assertTrue((System.nanoTime() - t0) / 1_000_000 < 4000);
        }
    }

    @Test
    public void chunkedBodiesAreDecoded() throws Exception {
        try (Peers.Receiver r = Peers.receiver(tmp.newFolder())) {
            Identity client = Identity.loadOrCreate(tmp.newFolder(), new PlainKeyVault());
            r.trust.add(client.deviceId(), "c", TrustStore.pem(client.keyPair().getPublic()));
            SSLSocket s = Tls.connect(Tls.pinnedClient(client, r.id.deviceId()), "127.0.0.1", r.port, 3000);
            s.getOutputStream().write("POST /mesh/v1/offer HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n1\r\n{\r\n0\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
            Http.Response resp = Http.readResponse(s.getInputStream(), 1 << 16);
            assertEquals(400, resp.status); // the body "{" reached the JSON parser
            assertEquals("bad-json", ((Map<?, ?>) Json.parse(resp.text())).get("error"));
        }
    }
}
