package io.github.hafijbge.meshdrop.engine.disc;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assume.assumeTrue;

import io.github.hafijbge.meshdrop.engine.testutil.NodeListen;
import io.github.hafijbge.meshdrop.engine.testutil.Peers;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class DiscoveryTest {
    @Rule public TemporaryFolder tmp = new TemporaryFolder();

    static Discovery.Options opts(String id, String alias, int udpPort, int meshPort) {
        Discovery.Options o = new Discovery.Options(id, alias, "mobile", meshPort);
        o.port = udpPort;
        o.intervalMs = 100;
        o.ttlMs = 1500;
        return o;
    }

    static void until(java.util.function.BooleanSupplier c, long ms) throws InterruptedException {
        long end = System.currentTimeMillis() + ms;
        while (!c.getAsBoolean()) {
            if (System.currentTimeMillis() > end) throw new AssertionError("condition not met in time");
            Thread.sleep(50);
        }
    }

    @Test
    public void twoJavaPeersFindEachOtherAndExpire() throws Exception {
        assumeTrue("needs a non-loopback IPv4 interface", !Discovery.interfaceAddrs().isEmpty());
        int port = 46000 + (int) (Math.random() * 900);
        Discovery a = new Discovery(opts("a".repeat(64), "A", port, 1111));
        Discovery b = new Discovery(opts("b".repeat(64), "B", port, 2222));
        List<String> lost = Collections.synchronizedList(new ArrayList<>());
        a.addListener(new Discovery.Listener() {
            public void onPeer(Discovery.PeerInfo p) {}

            public void onLost(Discovery.PeerInfo p) {
                lost.add(p.deviceId);
            }
        });
        a.start();
        b.start();
        try {
            until(() -> a.peers().stream().anyMatch(p -> p.deviceId.equals("b".repeat(64)) && p.port == 2222), 5000);
            assertFalse(a.peers().stream().anyMatch(p -> p.deviceId.equals("a".repeat(64)))); // never ourselves
            b.stop();
            until(() -> lost.contains("b".repeat(64)), 5000);
        } finally {
            a.stop();
            b.stop();
        }
    }

    @Test
    public void listenOnlyDoesNotAnnounce() throws Exception {
        assumeTrue(!Discovery.interfaceAddrs().isEmpty());
        int port = 46000 + (int) (Math.random() * 900);
        Discovery.Options qo = opts("c".repeat(64), "C", port, 3333);
        qo.announce = false;
        Discovery quiet = new Discovery(qo);
        Discovery loud = new Discovery(opts("d".repeat(64), "D", port, 4444));
        quiet.start();
        loud.start();
        try {
            until(() -> !quiet.peers().isEmpty(), 5000);
            Thread.sleep(400);
            assertTrue(loud.peers().isEmpty());
        } finally {
            quiet.stop();
            loud.stop();
        }
    }

    @Test
    public void nodeAndJavaSeeEachOther() throws Exception {
        assumeTrue(!Discovery.interfaceAddrs().isEmpty());
        String alias = "java-" + Long.toHexString(System.nanoTime());
        try (Peers.Receiver phone = Peers.receiver(tmp.newFolder())) {
            Discovery.Options o = new Discovery.Options(phone.id.deviceId(), alias, "mobile", phone.port);
            o.intervalMs = 300;
            Discovery d = new Discovery(o);
            d.start();
            // `listen` without --no-discovery: multicast on the default port 53318.
            NodeListen pc = NodeListen.startWithDiscovery(tmp.newFolder());
            try {
                until(() -> pc.output().contains("peer   " + alias), 15000);
                until(() -> d.peers().stream().anyMatch(p -> p.deviceId.equals(pc.deviceId)), 15000);
                assertEquals(pc.port, d.peers().stream().filter(p -> p.deviceId.equals(pc.deviceId)).findFirst().get().port);
            } finally {
                pc.close();
                d.stop();
            }
        }
    }

    @Test
    public void probeTakesTheIdFromTheCertificateAndKeepsManualPeers() throws Exception {
        try (Peers.Receiver phone = Peers.receiver(tmp.newFolder())) {
            Discovery.Options o = opts("e".repeat(64), "E", 46999, 1);
            o.ttlMs = 100;
            Discovery d = new Discovery(o); // never started: probes still work
            Discovery.PeerInfo p = d.probe("127.0.0.1", phone.port, 3000);
            assertEquals(phone.id.deviceId(), p.deviceId);
            assertTrue(p.manual);
            Thread.sleep(300);
            assertEquals(1, d.peers().size()); // manual peers do not expire
            d.forget(p.deviceId);
            assertTrue(d.peers().isEmpty());
            try {
                d.probe("127.0.0.1", 1, 1000);
                throw new AssertionError("probe of a closed port must fail");
            } catch (java.io.IOException expected) {
                // nothing listening
            }
        }
    }
}
