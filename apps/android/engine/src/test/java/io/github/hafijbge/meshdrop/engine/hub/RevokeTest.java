package io.github.hafijbge.meshdrop.engine.hub;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import io.github.hafijbge.meshdrop.engine.Engine;
import io.github.hafijbge.meshdrop.engine.EngineConfig;
import io.github.hafijbge.meshdrop.engine.EngineEvent;
import io.github.hafijbge.meshdrop.engine.identity.Identity;
import io.github.hafijbge.meshdrop.engine.identity.PlainKeyVault;
import io.github.hafijbge.meshdrop.engine.recv.DirectorySink;
import io.github.hafijbge.meshdrop.engine.testutil.Node;
import io.github.hafijbge.meshdrop.engine.testutil.NodeListen;
import io.github.hafijbge.meshdrop.engine.testutil.NodeMesh;
import java.io.File;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.function.BooleanSupplier;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

/** Revocation (only on proof) and LAN propagation of a newer list. */
public class RevokeTest {
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

    boolean saw(String source, String type) {
        synchronized (events) {
            for (EngineEvent e : events) if (e.source.equals(source) && e.type.equals(type)) return true;
        }
        return false;
    }

    Engine engine(File home) throws Exception {
        EngineConfig c = new EngineConfig(home, new PlainKeyVault(), new DirectorySink(new File(home, "inbox")));
        c.port = 0;
        c.alias = "phone";
        c.discovery = false;
        c.lanAddrs = Collections::emptyList;
        c.hubBackoffMs = new long[] {50, 200};
        Engine e = Engine.create(c);
        e.addListener(events::add);
        return e;
    }

    @Test
    public void aVerifiedRevocationDropsTheMeshAndKeepsTheIdentity() throws Exception {
        File hubHome = tmp.newFolder("hub");
        File jHome = tmp.newFolder("phone");
        NodeMesh.hubInit(hubHome);
        Identity id = Identity.loadOrCreate(jHome, new PlainKeyVault());
        NodeMesh.addMember(hubHome, id, jHome, "phone", INGRESS);
        Engine j = engine(jHome);
        try (NodeListen hub = NodeListen.start(hubHome)) {
            j.start();
            until("hub link", () -> j.hubState() == HubClient.State.ONLINE, 15_000);
            Node.Result r = Node.run("hub", "revoke", id.deviceId().substring(0, 12), "--home", hubHome.getPath());
            assertEquals(r.out, 0, r.code);
            until("revoked", () -> saw("mesh", "revoked"), 15_000);
            assertNull(j.mesh());
            assertFalse(new File(jHome, "mesh").exists());
            assertEquals(id.deviceId(), Identity.loadOrCreate(jHome, new PlainKeyVault()).deviceId());
            assertEquals(HubClient.State.IDLE, j.hubState());
        } finally {
            j.stop();
        }
    }

    @Test
    public void aRefusalWithoutProofKeepsTheMesh() throws Exception {
        File hubHome = tmp.newFolder("hub");
        File otherHub = tmp.newFolder("other");
        File jHome = tmp.newFolder("phone");
        NodeMesh.hubInit(hubHome);
        NodeMesh.hubInit(otherHub);
        Identity id = Identity.loadOrCreate(jHome, new PlainKeyVault());
        // In another mesh whose hub URL is this hub's: turned away with a list we cannot verify.
        NodeMesh.addMember(otherHub, id, jHome, "phone", INGRESS);
        Engine j = engine(jHome);
        try (NodeListen hub = NodeListen.start(hubHome)) {
            j.start();
            until("refused", () -> j.hubState() == HubClient.State.REFUSED, 15_000);
            assertFalse(saw("mesh", "revoked"));
            assertNotNull(j.mesh());
            assertTrue(new File(jHome, "mesh/membership.json").exists());
        } finally {
            j.stop();
        }
    }

    @Test
    public void aNewerListIsPulledFromAMemberOnTheLanWhileTheHubIsDown() throws Exception {
        File hubHome = tmp.newFolder("hub");
        File bHome = tmp.newFolder("b");
        File jHome = tmp.newFolder("phone");
        NodeMesh.hubInit(hubHome);
        Identity id = Identity.loadOrCreate(jHome, new PlainKeyVault());
        NodeMesh.addMember(hubHome, id, jHome, "phone", INGRESS); // list v2
        NodeMesh.addNodeMember(hubHome, bHome, "b", INGRESS); // list v3, which B holds
        Engine j = engine(jHome);
        try (NodeListen b = NodeListen.start(bHome)) {
            j.start();
            assertEquals(2, j.mesh().list().version);
            j.addNearby("127.0.0.1", b.port);
            until("list pulled", () -> j.mesh().list().version == 3, 15_000);
            assertTrue(saw("mesh", "membership"));
        } finally {
            j.stop();
        }
    }
}
