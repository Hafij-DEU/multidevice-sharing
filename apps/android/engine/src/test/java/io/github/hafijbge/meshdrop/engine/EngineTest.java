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
    public void pausedReceivingRefusesNodeSends() throws Exception {
        Engine e = engine(null);
        try (NodeListen pc = NodeListen.start(tmp.newFolder())) {
            pairBoth(e, pc);
            e.setReceiving(false);
            assertTrue(!e.receiving());
            File f = new File(tmp.getRoot(), "x.txt");
            Files.write(f.toPath(), "x".getBytes(StandardCharsets.UTF_8));
            Node.Result r = Node.run(60, "send", e.identity().shortId(), f.getPath(), "--home", pc.home.getPath());
            assertNotEquals(0, r.code);
            assertTrue(r.out, r.out.contains("503"));
            e.setReceiving(true);
            assertEquals(0, Node.run(60, "send", e.identity().shortId(), f.getPath(), "--home", pc.home.getPath()).code);
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
}
