package io.github.hafijbge.meshdrop.engine.hub;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;

import io.github.hafijbge.meshdrop.engine.Engine;
import io.github.hafijbge.meshdrop.engine.EngineConfig;
import io.github.hafijbge.meshdrop.engine.identity.Identity;
import io.github.hafijbge.meshdrop.engine.identity.PlainKeyVault;
import io.github.hafijbge.meshdrop.engine.recv.DirectorySink;
import io.github.hafijbge.meshdrop.engine.send.PathSource;
import io.github.hafijbge.meshdrop.engine.send.SendItem;
import io.github.hafijbge.meshdrop.engine.send.SendResult;
import io.github.hafijbge.meshdrop.engine.testutil.Node;
import io.github.hafijbge.meshdrop.engine.testutil.NodeListen;
import io.github.hafijbge.meshdrop.engine.testutil.NodeMesh;
import java.io.File;
import java.net.ServerSocket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.TimeUnit;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

/** M9: a Java phone fails over to a Node relay hub while the Node main hub is off, and moves back. */
public class RelayHubTest {
    @Rule public TemporaryFolder tmp = new TemporaryFolder();

    static int freePort() throws Exception {
        try (ServerSocket s = new ServerSocket(0)) {
            return s.getLocalPort();
        }
    }

    @Test
    public void aPhoneUsesTheRelayHubWhileTheMainHubIsOff() throws Exception {
        int hubIngress = freePort();
        int relayIngress = freePort();
        String hubUrl = "ws://127.0.0.1:" + hubIngress + "/mesh/v1/hub";
        String relayUrl = "ws://127.0.0.1:" + relayIngress + "/mesh/v1/hub";
        File hubHome = tmp.newFolder("hub");
        File rHome = tmp.newFolder("vps");
        File bHome = tmp.newFolder("b");
        File jHome = tmp.newFolder("phone");
        NodeMesh.hubInit(hubHome);
        Identity jId = Identity.loadOrCreate(jHome, new PlainKeyVault());
        NodeMesh.addMember(hubHome, jId, jHome, "phone", hubUrl);
        String rId = NodeMesh.addNodeMember(hubHome, rHome, "vps", hubUrl);
        String bId = NodeMesh.addNodeMember(hubHome, bHome, "b", hubUrl);
        Node.Result set = Node.run("hub", "relays", rId.substring(0, 8) + "=" + relayUrl, "--home", hubHome.getPath());
        assertEquals(set.out, 0, set.code);

        EngineConfig c = new EngineConfig(jHome, new PlainKeyVault(), new DirectorySink(new File(jHome, "inbox")));
        c.port = 0;
        c.alias = "phone";
        c.discovery = false;
        c.lanAddrs = Collections::emptyList;
        c.probeDirectoryAddrs = false;
        c.hubBackoffMs = new long[] {50, 200};
        c.hubFailbackMs = 500;
        NodeListen hub = NodeListen.startWith(hubHome, "--ingress-port", String.valueOf(hubIngress));
        NodeListen relay = NodeListen.startWith(rHome, "--ingress-port", String.valueOf(relayIngress));
        NodeListen b = NodeListen.startWith(bHome, "--ingress-port", String.valueOf(freePort()));
        Engine j = Engine.create(c);
        try {
            j.start();
            RelayTest.until("linked to the main hub", () -> "main".equals(j.linkedTo()), 15_000);
            RelayTest.until("relay list", () -> j.relayList() != null, 15_000);
            assertEquals(rId, j.relayList().relays.get(0).deviceId);
            RelayTest.until("relay hub up", () -> relay.output().contains("relay hubs updated"), 15_000);

            hub.close();
            RelayTest.until("on the relay", () -> "relay".equals(j.linkedTo()), 30_000);
            RelayTest.until("B on the relay", () -> RelayTest.online(j, bId), 30_000);
            File f = new File(tmp.getRoot(), "via-relay.txt");
            Files.write(f.toPath(), "through the relay".getBytes(StandardCharsets.UTF_8));
            List<SendResult> r = j.send(Arrays.asList(bId.substring(0, 8)), Arrays.asList(SendItem.file(PathSource.file(f.toPath()))), null).get(60, TimeUnit.SECONDS);
            assertEquals(r.toString(), "done", r.get(0).status);
            assertEquals("through the relay", new String(Files.readAllBytes(new File(b.inbox, "via-relay.txt").toPath()), StandardCharsets.UTF_8));

            try (NodeListen hub2 = NodeListen.startWith(hubHome, "--ingress-port", String.valueOf(hubIngress))) {
                assertNotNull(hub2);
                RelayTest.until("back on the main hub", () -> "main".equals(j.linkedTo()), 30_000);
            }
        } finally {
            j.stop();
            b.close();
            relay.close();
            hub.close();
        }
    }
}
