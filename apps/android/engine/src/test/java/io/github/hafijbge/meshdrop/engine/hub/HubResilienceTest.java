package io.github.hafijbge.meshdrop.engine.hub;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import io.github.hafijbge.meshdrop.engine.Engine;
import io.github.hafijbge.meshdrop.engine.EngineConfig;
import io.github.hafijbge.meshdrop.engine.EngineEvent;
import io.github.hafijbge.meshdrop.engine.identity.Identity;
import io.github.hafijbge.meshdrop.engine.identity.PlainKeyVault;
import io.github.hafijbge.meshdrop.engine.recv.DirectorySink;
import io.github.hafijbge.meshdrop.engine.send.PathSource;
import io.github.hafijbge.meshdrop.engine.send.SendItem;
import io.github.hafijbge.meshdrop.engine.send.SendResult;
import io.github.hafijbge.meshdrop.engine.testutil.NodeListen;
import io.github.hafijbge.meshdrop.engine.testutil.NodeMesh;
import java.io.File;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

/** The phone's hub link across network changes, a moved hub, and a link that flapped mid-send. */
public class HubResilienceTest {
    @Rule public TemporaryFolder tmp = new TemporaryFolder();

    static final String INGRESS = "ws://127.0.0.1:53319/mesh/v1/hub";

    final List<EngineEvent> events = Collections.synchronizedList(new ArrayList<>());

    static void until(String what, BooleanSupplier ok, long ms) throws InterruptedException {
        long end = System.currentTimeMillis() + ms;
        while (!ok.getAsBoolean()) {
            if (System.currentTimeMillis() > end) throw new AssertionError("timed out waiting for " + what);
            Thread.sleep(50);
        }
    }

    long onlineEvents() {
        synchronized (events) {
            return events.stream().filter(e -> e.source.equals("hub") && e.type.equals("state") && "online".equals(e.data.get("state"))).count();
        }
    }

    Engine engine(File home, long[] backoff) throws Exception {
        EngineConfig c = new EngineConfig(home, new PlainKeyVault(), new DirectorySink(new File(home, "inbox")));
        c.port = 0;
        c.alias = "phone";
        c.discovery = false;
        c.lanAddrs = Collections::emptyList;
        c.probeDirectoryAddrs = false;
        c.hubBackoffMs = backoff;
        Engine e = Engine.create(c);
        e.addListener(events::add);
        return e;
    }

    @Test
    public void aLanOnlyMeshFindsItsHubThroughDiscoveryAndRelinksOnANetworkChange() throws Exception {
        File hubHome = tmp.newFolder("hub");
        File jHome = tmp.newFolder("phone");
        NodeMesh.hubInit(hubHome); // no hub URLs: LAN only
        Identity id = Identity.loadOrCreate(jHome, new PlainKeyVault());
        NodeMesh.addMember(hubHome, id, jHome, "phone"); // no hub-addr.json either
        Engine j = engine(jHome, new long[] {50, 200});
        try (NodeListen hub = NodeListen.start(hubHome)) {
            j.start();
            j.addNearby("127.0.0.1", hub.port);
            until("hub link through the discovered address", () -> j.hubState() == HubClient.State.ONLINE, 15_000);
            assertTrue("the hub's address is remembered", new File(jHome, "hub-addr.json").exists());
            assertEquals(1, onlineEvents());

            j.restartNetworking(); // Wi-Fi changed: the old link may be half-open
            until("relinked", () -> onlineEvents() == 2, 5_000);
            assertEquals(HubClient.State.ONLINE, j.hubState());
        } finally {
            j.stop();
        }
    }

    @Test
    public void aSendCutByTheLinkResumesOnceTheLinkIsBack() throws Exception {
        File hubHome = tmp.newFolder("hub");
        File bHome = tmp.newFolder("b");
        File jHome = tmp.newFolder("phone");
        NodeMesh.hubInit(hubHome);
        Identity id = Identity.loadOrCreate(jHome, new PlainKeyVault());
        NodeMesh.addMember(hubHome, id, jHome, "phone", INGRESS);
        String bId = NodeMesh.addNodeMember(hubHome, bHome, "b", INGRESS);
        // The phone relinks after B, so B is already in the welcome's directory and no later push names it.
        Engine j = engine(jHome, new long[] {50, 12_000});
        NodeListen hub = NodeListen.start(hubHome);
        int port = hub.port;
        NodeListen b = NodeListen.start(bHome);
        try {
            j.start();
            until("hub link", () -> j.hubState() == HubClient.State.ONLINE, 15_000);
            until("B online", () -> j.directory().stream().anyMatch(d -> d.deviceId.equals(bId) && d.online), 15_000);
            File big = new File(tmp.getRoot(), "big.bin");
            byte[] data = new byte[48 << 20];
            new java.util.Random(7).nextBytes(data);
            Files.write(big.toPath(), data);
            CompletableFuture<List<SendResult>> f = j.send(Arrays.asList(bId), Arrays.asList(SendItem.file(PathSource.file(big.toPath()))), null);
            until("first chunk relayed", () -> {
                synchronized (events) {
                    return events.stream().anyMatch(e -> e.source.equals("sender") && e.type.equals("progress"));
                }
            }, 60_000);
            hub.kill();
            List<SendResult> r = f.get(120, TimeUnit.SECONDS);
            assertEquals(r.toString(), "failed", r.get(0).status);
            hub = NodeListen.start(hubHome, port);
            NodeListen bb = b;
            until("B relinked first", () -> bb.output().split("hub    linked", -1).length - 1 >= 2, 20_000);
            assertTrue("the phone is still waiting to relink", j.hubState() != HubClient.State.ONLINE);
            File got = new File(b.inbox, "big.bin");
            until("resumed and delivered", () -> got.length() == data.length, 90_000);
            assertArrayEquals(data, Files.readAllBytes(got.toPath()));
        } finally {
            j.stop();
            b.close();
            hub.close();
        }
    }
}
