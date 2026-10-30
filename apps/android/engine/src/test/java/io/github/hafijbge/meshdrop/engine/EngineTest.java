package io.github.hafijbge.meshdrop.engine;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

import io.github.hafijbge.meshdrop.engine.identity.PlainKeyVault;
import io.github.hafijbge.meshdrop.engine.recv.DirectorySink;
import io.github.hafijbge.meshdrop.engine.send.PathSource;
import io.github.hafijbge.meshdrop.engine.send.SendItem;
import io.github.hafijbge.meshdrop.engine.send.SendResult;
import io.github.hafijbge.meshdrop.engine.testutil.Node;
import io.github.hafijbge.meshdrop.engine.testutil.NodeListen;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Random;
import java.util.concurrent.TimeUnit;
import org.junit.After;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class EngineTest {
    @Rule public TemporaryFolder tmp = new TemporaryFolder();
    final List<Engine> engines = new ArrayList<>();

    @After
    public void stopAll() {
        for (Engine e : engines) e.stop();
    }

    Engine engine(List<EngineEvent> events) throws Exception {
        File home = tmp.newFolder();
        EngineConfig c = new EngineConfig(home, new PlainKeyVault(), new DirectorySink(new File(home, "inbox")));
        c.port = 0;
        c.alias = "phone";
        c.discovery = false;
        Engine e = Engine.create(c);
        if (events != null) e.addListener(events::add);
        e.start();
        engines.add(e);
        return e;
    }

    static void until(java.util.function.BooleanSupplier c, long ms) throws InterruptedException {
        long end = System.currentTimeMillis() + ms;
        while (!c.getAsBoolean()) {
            if (System.currentTimeMillis() > end) throw new AssertionError("condition not met in time");
            Thread.sleep(25);
        }
    }

    void pairBoth(Engine e, NodeListen pc) throws Exception {
        e.pairManual("127.0.0.1", pc.port, "pc");
        Node.Result r = Node.run("pair", "127.0.0.1:" + e.port(), "phone", "--home", pc.home.getPath());
        assertEquals(r.out, 0, r.code);
    }

    @Test
    public void pairsWithNodeAndSendsToAPrefix() throws Exception {
        Engine e = engine(null);
        try (NodeListen pc = NodeListen.start(tmp.newFolder())) {
            pairBoth(e, pc);
            EngineDevice d = e.devices().stream().filter(x -> x.deviceId.equals(pc.deviceId)).findFirst().get();
            assertEquals("paired", d.role);
            assertEquals("lan", d.reach);
            assertEquals("pc", d.alias);
            File f = new File(tmp.getRoot(), "hello.txt");
            Files.write(f.toPath(), "hello pc".getBytes(StandardCharsets.UTF_8));
            List<SendResult> rs = e.send(List.of(pc.deviceId.substring(0, 6)), List.of(SendItem.file(PathSource.file(f.toPath()))), "t1").get(60, TimeUnit.SECONDS);
            assertEquals("done", rs.get(0).status);
            assertEquals("hello pc", Files.readString(new File(pc.inbox, "hello.txt").toPath()));
        }
    }

    @Test
    public void pairingCodeMatchesTheNodeEngine() {
        // vectors from packages/core pairingCode()
        assertEquals("719 208", io.github.hafijbge.meshdrop.engine.net.TrustStore.pairingCode("a".repeat(52), "b".repeat(52)));
        assertEquals("719 208", io.github.hafijbge.meshdrop.engine.net.TrustStore.pairingCode("b".repeat(52), "a".repeat(52)));
        assertEquals("017 909", io.github.hafijbge.meshdrop.engine.net.TrustStore.pairingCode("zz9", "aa1"));
    }

    @Test
    public void pairProbeTrustsNothingAndAnotherDeviceAnsweringIsRefused() throws Exception {
        Engine e = engine(null);
        try (NodeListen pc = NodeListen.start(tmp.newFolder())) {
            Engine.PairProbe p = e.pairProbe("127.0.0.1", pc.port);
            assertEquals(pc.deviceId, p.deviceId);
            assertEquals(e.pairingCode(pc.deviceId), p.code);
            assertTrue(e.devices().stream().noneMatch(x -> x.deviceId.equals(pc.deviceId) && x.trusted));
            try {
                e.pairManual("127.0.0.1", pc.port, "pc", "someone-else");
                throw new AssertionError("paired with an unexpected device");
            } catch (java.io.IOException expected) {
                assertTrue(expected.getMessage().contains("another device"));
            }
            assertTrue(e.devices().stream().noneMatch(x -> x.deviceId.equals(pc.deviceId) && x.trusted));
            e.pairManual("127.0.0.1", pc.port, "pc", p.deviceId);
            assertTrue(e.devices().stream().anyMatch(x -> x.deviceId.equals(pc.deviceId) && x.trusted));
        }
    }

    @Test
    public void unpairForgetsTheDeviceAndPairReTrustsIt() throws Exception {
        Engine e = engine(null);
        try (NodeListen pc = NodeListen.start(tmp.newFolder())) {
            pairBoth(e, pc);
            e.unpair(pc.deviceId.substring(0, 8));
            EngineDevice d = e.devices().stream().filter(x -> x.deviceId.equals(pc.deviceId)).findFirst().get();
            assertEquals("nearby", d.role);
            assertTrue(!d.trusted);
            e.pairManual("127.0.0.1", pc.port, "pc again");
            d = e.devices().stream().filter(x -> x.deviceId.equals(pc.deviceId)).findFirst().get();
            assertEquals("paired", d.role);
            assertEquals("pc again", d.alias);
        }
    }

    @Test
    public void aBurstOfSightingsAfterARestartAutoResumesOnce() throws Exception {
        List<EngineEvent> events = Collections.synchronizedList(new ArrayList<>());
        Engine e = engine(events);
        File pcHome = tmp.newFolder();
        NodeListen pc = NodeListen.start(pcHome);
        try {
            pairBoth(e, pc);
            File big = new File(tmp.getRoot(), "video.bin");
            byte[] data = new byte[64 * 1024 * 1024];
            new Random(1).nextBytes(data);
            Files.write(big.toPath(), data);
            NodeListen dying = pc;
            e.addListener(ev -> {
                if (ev.type.equals("progress") && ev.source.equals("sender") && dying.isAlive()) {
                    try {
                        dying.kill();
                    } catch (InterruptedException x) {
                        Thread.currentThread().interrupt();
                    }
                }
            });
            List<SendResult> rs = e.send(List.of(pc.deviceId), List.of(SendItem.file(PathSource.file(big.toPath()))), null).get(120, TimeUnit.SECONDS);
            assertNotEquals("done", rs.get(0).status);
            pc = NodeListen.start(pcHome, pc.port);
            events.clear();
            NodeListen up = pc;
            Thread[] ts = new Thread[3];
            for (int i = 0; i < 3; i++) {
                ts[i] = new Thread(() -> {
                    try {
                        e.addNearby("127.0.0.1", up.port);
                    } catch (Exception x) {
                        throw new RuntimeException(x);
                    }
                });
                ts[i].start();
            }
            for (Thread t : ts) t.join();
            until(() -> events.stream().anyMatch(x -> x.type.equals("result") && "done".equals(x.data.get("status"))), 60_000);
            Thread.sleep(300);
            assertEquals(1, events.stream().filter(x -> x.source.equals("sender") && x.type.equals("result")).count());
            assertArrayEquals(data, Files.readAllBytes(new File(pc.inbox, "video.bin").toPath()));
        } finally {
            pc.close();
        }
    }

    @Test
    public void aSendToADeviceThatIsAwayWaitsAndGoesOutWhenItIsSeen() throws Exception {
        List<EngineEvent> events = Collections.synchronizedList(new ArrayList<>());
        Engine e = engine(events);
        File pcHome = tmp.newFolder();
        NodeListen pc = NodeListen.start(pcHome);
        try {
            pairBoth(e, pc);
            pc.kill();
            e.forgetPeer(pc.deviceId);
            List<SendResult> rs = e.send(List.of(pc.deviceId), List.of(SendItem.text("later")), null).get(60, TimeUnit.SECONDS);
            assertEquals("failed", rs.get(0).status);
            assertEquals("offline", rs.get(0).error);
            List<Engine.OutboxItem> ob = e.listOutbox();
            assertEquals(1, ob.size());
            assertEquals(rs.get(0).sessionId, ob.get(0).sessionId);
            assertTrue(ob.get(0).waiting);
            pc = NodeListen.start(pcHome, pc.port);
            e.addNearby("127.0.0.1", pc.port);
            until(() -> events.stream().anyMatch(x -> x.type.equals("result") && "done".equals(x.data.get("status"))), 60_000);
            assertEquals(0, e.listOutbox().size());
        } finally {
            pc.close();
        }
    }

    @Test
    public void pausedReceivingRefusesNodeSends() throws Exception {
        Engine e = engine(null);
        try (NodeListen pc = NodeListen.start(tmp.newFolder())) {
            pairBoth(e, pc);
            e.setReceiving(false);
            assertTrue(!e.receiving());
            File f = new File(tmp.getRoot(), "x.txt");
            Files.write(f.toPath(), "x".getBytes(StandardCharsets.UTF_8));
            Node.Result r = Node.run(60, "send", e.identity().deviceId().substring(0, 8), f.getPath(), "--home", pc.home.getPath());
            assertNotEquals(0, r.code);
            assertTrue(r.out, r.out.contains("503"));
            e.setReceiving(true);
            assertEquals(0, Node.run(60, "send", e.identity().deviceId().substring(0, 8), f.getPath(), "--home", pc.home.getPath()).code);
        }
    }

    @Test
    public void unknownOrAmbiguousTargetsAreRefusedBeforeAnythingIsSent() throws Exception {
        Engine e = engine(null);
        try {
            e.send(List.of("zzzz"), List.of(SendItem.text("x")), null);
            throw new AssertionError("expected UnknownDevice");
        } catch (Engine.UnknownDevice expected) {
            // invalid prefix
        }
    }

    @Test
    public void aManualPeerComesBackAfterANetworkRestartWhileItWasDown() throws Exception {
        File home = tmp.newFolder();
        EngineConfig c = new EngineConfig(home, new PlainKeyVault(), new DirectorySink(new File(home, "inbox")));
        c.port = 0;
        c.discovery = true; // restartNetworking then really re-binds discovery
        c.discoveryPort = 47000 + (int) (Math.random() * 900);
        c.manualReprobeMs = 300;
        Engine e = Engine.create(c);
        e.start();
        engines.add(e);
        File pcHome = tmp.newFolder();
        NodeListen pc = NodeListen.start(pcHome);
        try {
            pairBoth(e, pc);
            int port = pc.port;
            pc.kill();
            e.restartNetworking();
            pc = NodeListen.start(pcHome, port);
            String id = pc.deviceId;
            until(() -> e.devices().stream().anyMatch(d -> d.deviceId.equals(id) && d.reach.equals("lan")), 10_000);
        } finally {
            pc.close();
        }
    }

    @Test
    public void reportsWhenTransfersAreActiveForWakeLocks() throws Exception {
        List<Boolean> busy = Collections.synchronizedList(new ArrayList<>());
        File home = tmp.newFolder();
        EngineConfig c = new EngineConfig(home, new PlainKeyVault(), new DirectorySink(new File(home, "inbox")));
        c.port = 0;
        c.discovery = false;
        c.activityIdleMs = 300;
        c.activity = busy::add;
        Engine e = Engine.create(c);
        e.start();
        engines.add(e);
        try (NodeListen pc = NodeListen.start(tmp.newFolder())) {
            pairBoth(e, pc);
            File f = new File(tmp.getRoot(), "w.bin");
            Files.write(f.toPath(), new byte[1 << 20]);
            e.send(List.of(pc.deviceId), List.of(SendItem.file(PathSource.file(f.toPath()))), null).get(60, TimeUnit.SECONDS);
            assertEquals(Boolean.TRUE, busy.get(0));
            until(() -> busy.size() >= 2 && !busy.get(busy.size() - 1), 5_000);
            File g = new File(tmp.getRoot(), "in.txt");
            Files.write(g.toPath(), "in".getBytes(StandardCharsets.UTF_8));
            int before = busy.size();
            assertEquals(0, Node.run(60, "send", e.identity().deviceId().substring(0, 8), g.getPath(), "--home", pc.home.getPath()).code);
            until(() -> busy.size() > before && busy.subList(before, busy.size()).contains(Boolean.TRUE), 5_000);
        }
    }
}
