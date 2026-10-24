package io.github.hafijbge.meshdrop.engine.recv;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import io.github.hafijbge.meshdrop.engine.identity.Identity;
import io.github.hafijbge.meshdrop.engine.identity.PlainKeyVault;
import io.github.hafijbge.meshdrop.engine.net.Http;
import io.github.hafijbge.meshdrop.engine.net.Tls;
import io.github.hafijbge.meshdrop.engine.net.TrustStore;
import io.github.hafijbge.meshdrop.engine.testutil.Peers;
import io.github.hafijbge.meshdrop.engine.util.Json;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class MeshServerTest {
    @Rule public TemporaryFolder tmp = new TemporaryFolder();

    static Map<?, ?> json(Http.Response r) {
        return (Map<?, ?>) Json.parse(r.text());
    }

    @Test
    public void infoIsOpenToAnyPeer() throws Exception {
        MeshServer.Options o = new MeshServer.Options();
        o.alias = "Pixel";
        try (Peers.Receiver r = Peers.receiver(tmp.newFolder(), o)) {
            Http.Response resp = Http.request(Tls.connect(Tls.probeClient(), "127.0.0.1", r.port, 3000), "GET", "/mesh/v1/info", null, null, 4096);
            assertEquals(200, resp.status);
            Map<?, ?> j = json(resp);
            assertEquals(1L, j.get("v"));
            assertEquals(r.id.deviceId(), j.get("deviceId"));
            assertEquals("Pixel", j.get("alias"));
            assertEquals("mobile", j.get("deviceType"));
            assertEquals(0L, j.get("mv"));
        }
    }

    @Test
    public void anUntrustedPeerGets403AndUnknownRoutes404() throws Exception {
        try (Peers.Receiver r = Peers.receiver(tmp.newFolder())) {
            Identity stranger = Identity.loadOrCreate(tmp.newFolder(), new PlainKeyVault());
            Http.Response resp = Http.request(Tls.connect(Tls.pinnedClient(stranger, r.id.deviceId()), "127.0.0.1", r.port, 3000),
                    "POST", "/mesh/v1/offer", null, "{}".getBytes(StandardCharsets.UTF_8), 4096);
            assertEquals(403, resp.status);
            assertEquals("untrusted", json(resp).get("error"));
            Http.Response nf = Http.request(Tls.connect(Tls.probeClient(), "127.0.0.1", r.port, 3000), "GET", "/nope", null, null, 4096);
            assertEquals(404, nf.status);
        }
    }

    @Test
    public void pausedReceivingAnswers503() throws Exception {
        MeshServer.Options o = new MeshServer.Options();
        o.accepting = () -> false;
        try (Peers.Receiver r = Peers.receiver(tmp.newFolder(), o)) {
            Identity c = Identity.loadOrCreate(tmp.newFolder(), new PlainKeyVault());
            r.trust.add(c.deviceId(), "c", TrustStore.pem(c.keyPair().getPublic()));
            Http.Response resp = Http.request(Tls.connect(Tls.pinnedClient(c, r.id.deviceId()), "127.0.0.1", r.port, 3000),
                    "POST", "/mesh/v1/offer", null, "{}".getBytes(StandardCharsets.UTF_8), 4096);
            assertEquals(503, resp.status);
            assertEquals("paused", json(resp).get("error"));
        }
    }

    @Test
    public void thePinnedClientRefusesTheWrongServer() throws Exception {
        try (Peers.Receiver r = Peers.receiver(tmp.newFolder())) {
            Identity c = Identity.loadOrCreate(tmp.newFolder(), new PlainKeyVault());
            assertThrows(java.io.IOException.class, () -> Tls.connect(Tls.pinnedClient(c, "0".repeat(64)), "127.0.0.1", r.port, 3000));
        }
    }
}
