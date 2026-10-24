package io.github.hafijbge.meshdrop.engine.hub;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import io.github.hafijbge.meshdrop.engine.identity.Identity;
import io.github.hafijbge.meshdrop.engine.identity.PlainKeyVault;
import io.github.hafijbge.meshdrop.engine.mesh.MembershipStore;
import io.github.hafijbge.meshdrop.engine.testutil.NodeListen;
import io.github.hafijbge.meshdrop.engine.testutil.NodeMesh;
import java.io.File;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

/** The Java member's hub link against the Node hub (`hub init` + `listen`). */
public class HubClientTest {
    @Rule public TemporaryFolder tmp = new TemporaryFolder();

    static final String INGRESS = "ws://127.0.0.1:53319/mesh/v1/hub";

    final List<String> events = Collections.synchronizedList(new ArrayList<>());

    HubClient.Options opts(Identity id, MembershipStore ms) {
        HubClient.Options o = new HubClient.Options(id, () -> ms);
        o.backoffMs = new long[] {50, 100};
        o.listener = new HubClient.Listener() {
            @Override
            public void onState(HubClient.State s) {
                events.add(s.toString());
            }

            @Override
            public void onLinkClosed(int code) {
                events.add("closed " + code);
            }
        };
        return o;
    }

    static void await(String what, java.util.function.BooleanSupplier ok, long ms) throws InterruptedException {
        long end = System.currentTimeMillis() + ms;
        while (!ok.getAsBoolean()) {
            if (System.currentTimeMillis() > end) throw new AssertionError("timed out waiting for " + what);
            Thread.sleep(20);
        }
    }

    @Test
    public void goesOnlineOverThePinnedLanLinkAndRelinksAfterAHubRestart() throws Exception {
        File hubHome = tmp.newFolder("hub");
        File phoneHome = tmp.newFolder("phone");
        NodeMesh.hubInit(hubHome);
        Identity phone = Identity.loadOrCreate(phoneHome, new PlainKeyVault());
        MembershipStore ms = NodeMesh.addMember(hubHome, phone, phoneHome, "phone", INGRESS);
        NodeListen hub = NodeListen.start(hubHome);
        int port = hub.port;
        HubClient.Options o = opts(phone, ms);
        o.hubLan = () -> new HubClient.LanAddr("127.0.0.1", port);
        HubClient c = new HubClient(o);
        try {
            c.start();
            await("online", () -> c.state() == HubClient.State.ONLINE, 15_000);
            boolean listed = false;
            for (HubClient.DirectoryEntry d : c.directory()) if (d.deviceId.equals(phone.deviceId()) && d.online) listed = true;
            assertTrue("hub directory lists the phone online: " + c.directory(), listed);

            hub.kill();
            await("link lost", () -> c.state() != HubClient.State.ONLINE, 15_000);
            hub = NodeListen.start(hubHome, port);
            long t0 = System.currentTimeMillis();
            await("online again", () -> c.state() == HubClient.State.ONLINE, 5_000);
            assertTrue(System.currentTimeMillis() - t0 < 5_000);
            Thread.sleep(500);
            assertEquals(HubClient.State.ONLINE, c.state());
            assertEquals(events.toString(), 2, Collections.frequency(events, "online"));
            assertFalse("a second link replaced the first: " + events, events.contains("closed 4409"));
        } finally {
            c.stop();
            hub.close();
        }
        assertEquals(HubClient.State.IDLE, c.state());
    }

    @Test
    public void reachesTheHubThroughItsUrlWithoutALanAddress() throws Exception {
        File hubHome = tmp.newFolder("hub");
        File phoneHome = tmp.newFolder("phone");
        NodeMesh.hubInit(hubHome);
        Identity phone = Identity.loadOrCreate(phoneHome, new PlainKeyVault());
        MembershipStore ms = NodeMesh.addMember(hubHome, phone, phoneHome, "phone", INGRESS);
        try (NodeListen hub = NodeListen.start(hubHome)) {
            HubClient c = new HubClient(opts(phone, ms));
            try {
                c.start();
                await("online", () -> c.state() == HubClient.State.ONLINE, 15_000);
                assertTrue(hub.isAlive());
            } finally {
                c.stop();
            }
        }
    }

    @Test
    public void aDeviceThatIsNotAMemberIsRefused() throws Exception {
        File hubHome = tmp.newFolder("hub");
        File phoneHome = tmp.newFolder("phone");
        File otherHub = tmp.newFolder("other");
        NodeMesh.hubInit(hubHome);
        NodeMesh.hubInit(otherHub);
        Identity phone = Identity.loadOrCreate(phoneHome, new PlainKeyVault());
        // A member of another mesh with the same hub URL: the hub turns it away with 4403.
        MembershipStore ms = NodeMesh.addMember(otherHub, phone, phoneHome, "phone", INGRESS);
        try (NodeListen hub = NodeListen.start(hubHome)) {
            HubClient c = new HubClient(opts(phone, ms));
            try {
                c.start();
                await("refused", () -> c.state() == HubClient.State.REFUSED, 15_000);
                assertTrue(new File(phoneHome, "mesh/membership.json").exists());
            } finally {
                c.stop();
            }
        }
    }
}
