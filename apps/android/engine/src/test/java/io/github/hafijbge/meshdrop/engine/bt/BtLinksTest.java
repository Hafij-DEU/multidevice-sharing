package io.github.hafijbge.meshdrop.engine.bt;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import io.github.hafijbge.meshdrop.engine.Engine;
import io.github.hafijbge.meshdrop.engine.EngineConfig;
import io.github.hafijbge.meshdrop.engine.EngineDevice;
import io.github.hafijbge.meshdrop.engine.EngineEvent;
import io.github.hafijbge.meshdrop.engine.identity.PlainKeyVault;
import io.github.hafijbge.meshdrop.engine.net.TrustStore;
import io.github.hafijbge.meshdrop.engine.recv.DirectorySink;
import io.github.hafijbge.meshdrop.engine.recv.MeshServer;
import io.github.hafijbge.meshdrop.engine.send.PathSource;
import io.github.hafijbge.meshdrop.engine.send.SendItem;
import io.github.hafijbge.meshdrop.engine.send.SendResult;
import io.github.hafijbge.meshdrop.engine.util.Json;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BooleanSupplier;
import org.junit.After;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

/** Bluetooth links (M14): the link manager and two engines whose RFCOMM sockets are loopback TCP pairs. */
public class BtLinksTest {
    @Rule public TemporaryFolder tmp = new TemporaryFolder();
    final List<Engine> engines = new ArrayList<>();
    final List<BtLinks> managers = new ArrayList<>();

    @After
    public void tearDown() {
        for (Engine e : engines) e.stop();
        for (BtLinks l : managers) l.stop();
    }

    static void until(BooleanSupplier c, long ms) throws InterruptedException {
        long end = System.currentTimeMillis() + ms;
        while (!c.getAsBoolean()) {
            if (System.currentTimeMillis() > end) throw new AssertionError("condition not met in time");
            Thread.sleep(20);
        }
    }

    /** Radios in range of each other. */
    static final class Air {
        final Map<String, FakeRadio> radios = new ConcurrentHashMap<>();
        final AtomicInteger dials = new AtomicInteger();
    }

    static final class SocketConn implements BtPlatform.Conn {
        final Socket s;

        SocketConn(Socket s) {
            this.s = s;
        }

        @Override
        public InputStream in() throws IOException {
            return s.getInputStream();
        }

        @Override
        public OutputStream out() throws IOException {
            return s.getOutputStream();
        }

        @Override
        public void close() throws IOException {
            s.close();
        }
    }

    static final class FakeRadio implements BtPlatform {
        final Air air;
        final String address;
        volatile Acceptor onConn;
        volatile boolean away;

        FakeRadio(Air air, String address) {
            this.air = air;
            this.address = address;
            air.radios.put(address, this);
        }

        @Override
        public List<Bonded> bonded() {
            List<Bonded> out = new ArrayList<>();
            for (String a : air.radios.keySet()) if (!a.equals(address)) out.add(new Bonded(a, a));
            Collections.sort(out, (x, y) -> x.address.compareTo(y.address));
            return out;
        }

        @Override
        public Conn dial(String to) throws IOException {
            air.dials.incrementAndGet();
            FakeRadio far = air.radios.get(to);
            Acceptor acc = far == null ? null : far.onConn;
            if (far == null || far.away || acc == null || away) throw new IOException("host is down");
            try (ServerSocket ss = new ServerSocket(0, 1, InetAddress.getLoopbackAddress())) {
                Socket x = new Socket(InetAddress.getLoopbackAddress(), ss.getLocalPort());
                Socket y = ss.accept();
                acc.accept(new SocketConn(y), address);
                return new SocketConn(x);
            }
        }

        @Override
        public void listen(Acceptor a) {
            onConn = a;
        }

        @Override
        public void stop() {
            onConn = null;
        }
    }

    static final class Side {
        Engine e;
        File inbox;
        File home;
        FakeRadio radio;
        final List<EngineEvent> events = new CopyOnWriteArrayList<>();
    }

    /** Engines that trust each other but never see each other on the LAN. */
    Side[] pair(LinkPolicy policy) throws Exception {
        Air air = new Air();
        Side[] s = {new Side(), new Side()};
        String[] addrs = {"AA:AA:AA:AA:AA:AA", "BB:BB:BB:BB:BB:BB"};
        for (int i = 0; i < 2; i++) {
            s[i].home = tmp.newFolder();
            s[i].inbox = new File(s[i].home, "inbox");
            s[i].radio = new FakeRadio(air, addrs[i]);
            EngineConfig c = new EngineConfig(s[i].home, new PlainKeyVault(), new DirectorySink(s[i].inbox));
            c.port = 0;
            c.discovery = false;
            c.autoResume = false;
            c.alias = i == 0 ? "ay" : "bee";
            c.bt = s[i].radio;
            c.btTickMs = 0;
            if (policy != null) c.btPolicy = policy;
            s[i].e = Engine.create(c);
            s[i].e.addListener(s[i].events::add);
            engines.add(s[i].e);
        }
        for (int i = 0; i < 2; i++) {
            Engine other = s[1 - i].e;
            s[i].e.trust().add(other.identity().deviceId(), other.alias(), TrustStore.pem(other.identity().keyPair().getPublic()));
        }
        return s;
    }

    static String sha(byte[] b) throws Exception {
        StringBuilder out = new StringBuilder();
        for (byte x : MessageDigest.getInstance("SHA-256").digest(b)) out.append(String.format("%02x", x));
        return out.toString();
    }

    @Test(timeout = 60_000)
    public void withNoLanPathFilesAndAppMessagesGoOverBluetooth() throws Exception {
        Side[] s = pair(null);
        Side a = s[0];
        Side b = s[1];
        a.e.start();
        b.e.start();
        String bId = b.e.identity().deviceId();
        String aId = a.e.identity().deviceId();
        until(() -> a.e.btLinked().contains(bId) && b.e.btLinked().contains(aId), 15_000);
        // Both sides dialled at start: one link survives on each side.
        Thread.sleep(100);
        assertEquals(Arrays.asList(bId), a.e.btLinked());
        EngineDevice d = a.e.devices().stream().filter(x -> x.deviceId.equals(bId)).findFirst().get();
        assertEquals("bt", d.reach);
        assertTrue(a.e.viaBluetooth(bId));

        byte[] data = new byte[600 * 1024];
        new SecureRandom().nextBytes(data);
        File src = new File(tmp.newFolder(), "over-bt.bin");
        Files.write(src.toPath(), data);
        List<SendResult> res = a.e.send(Arrays.asList(bId), Arrays.asList(SendItem.file(PathSource.file(src.toPath()))), null).get(30, TimeUnit.SECONDS);
        assertEquals(res.get(0).error, "done", res.get(0).status);
        assertEquals(sha(data), sha(Files.readAllBytes(new File(b.inbox, "over-bt.bin").toPath())));

        b.e.setAppHandler((peer, msg) -> {
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("peer", peer);
            body.put("msg", msg);
            return new MeshServer.Reply(200, Json.stringify(body).getBytes(StandardCharsets.UTF_8));
        });
        Map<String, Object> key = new LinkedHashMap<>();
        key.put("kind", "key");
        key.put("key", "play");
        Map<String, Object> reply = a.e.appSend(bId, key, 5000);
        assertEquals(200L, reply.get("status"));
        assertEquals(aId, ((Map<?, ?>) reply.get("body")).get("peer"));

        // The camera stays on Wi-Fi.
        try {
            a.e.streamTo(bId, "camera", "video/x-jpeg-frames");
            throw new AssertionError("camera over Bluetooth");
        } catch (IOException e) {
            assertTrue(e.getMessage(), e.getMessage().contains("Camera needs Wi-Fi"));
        }

        Object peers = Json.parse(new String(Files.readAllBytes(new File(a.home, "bt-peers.json").toPath()), StandardCharsets.UTF_8));
        assertEquals(bId, ((Map<?, ?>) peers).get("BB:BB:BB:BB:BB:BB"));
        assertTrue(a.events.stream().anyMatch(x -> x.source.equals("bt") && x.type.equals("up") && bId.equals(x.data.get("deviceId"))));
        List<SendResult> all = a.e.send(null, Arrays.asList(SendItem.text("to all")), null).get(30, TimeUnit.SECONDS);
        assertEquals(1, all.size());
        assertEquals(bId, all.get(0).deviceId);
        assertEquals("done", all.get(0).status);
    }

    @Test(timeout = 60_000)
    public void wifiOnlyNeverUsesBluetoothAndOffClosesLinks() throws Exception {
        Side[] s = pair(null);
        Side a = s[0];
        a.e.start();
        s[1].e.start();
        String bId = s[1].e.identity().deviceId();
        until(() -> a.e.btLinked().contains(bId), 15_000);
        Map<String, String> links = new LinkedHashMap<>();
        links.put(bId, LinkPolicy.WIFI);
        a.e.setLinkPolicy(new LinkPolicy(true, false, links));
        until(() -> !a.e.btLinked().contains(bId), 10_000);
        assertEquals("offline", a.e.devices().stream().filter(x -> x.deviceId.equals(bId)).findFirst().get().reach);
        SendResult r = a.e.send(Arrays.asList(bId), Arrays.asList(SendItem.text("x")), null).get(30, TimeUnit.SECONDS).get(0);
        assertEquals("failed", r.status);
        assertEquals("offline", r.error);
        a.e.setLinkPolicy(new LinkPolicy(false, true, Collections.<String, String>emptyMap()));
        assertEquals(LinkPolicy.WIFI, a.e.linkMode(bId));
    }

    @Test(timeout = 60_000)
    public void aSendDialsOnDemand() throws Exception {
        Side[] s = pair(null);
        s[1].radio.away = true;
        s[1].e.start();
        s[0].e.start();
        String bId = s[1].e.identity().deviceId();
        Thread.sleep(200);
        assertEquals(Collections.emptyList(), s[0].e.btLinked());
        s[1].radio.away = false;
        int before = s[0].radio.air.dials.get();
        SendResult r = s[0].e.send(Arrays.asList(bId), Arrays.asList(SendItem.text("dial me")), null).get(30, TimeUnit.SECONDS).get(0);
        assertEquals(r.error, "done", r.status);
        assertTrue(s[0].radio.air.dials.get() > before);
    }

    @Test(timeout = 30_000)
    public void closesALinkWhoseHelloNamesAnUntrustedDevice() throws Exception {
        Side[] s = pair(null);
        s[0].e.start();
        try (ServerSocket ss = new ServerSocket(0, 1, InetAddress.getLoopbackAddress())) {
            Socket x = new Socket(InetAddress.getLoopbackAddress(), ss.getLocalPort());
            Socket y = ss.accept();
            BtLink l = new BtLink(x.getInputStream(), x.getOutputStream(), x, true, "c".repeat(64), () -> 1, 15_000, BtLinkTest.QUIET);
            l.start();
            s[0].radio.onConn.accept(new SocketConn(y), "CC:CC:CC:CC:CC:CC");
            assertTrue(l.awaitReady(5000) || l.closed());
            until(l::closed, 10_000);
        }
        assertEquals(Collections.emptyList(), s[0].e.btLinked());
    }

    @Test
    public void modesFollowTheSwitches() {
        Map<String, String> m = new LinkedHashMap<>();
        m.put("b", "bt");
        m.put("w", "wifi");
        m.put("x", "bogus");
        LinkPolicy p = new LinkPolicy(true, false, m);
        assertEquals(Arrays.asList("auto", "bt", "wifi", "auto"), Arrays.asList(p.mode("y"), p.mode("b"), p.mode("w"), p.mode("x")));
        assertEquals("bt", new LinkPolicy(true, true, m).mode("w"));
        assertEquals("wifi", new LinkPolicy(false, true, m).mode("b"));
    }

    BtLinks manager(Air air, int i, String[] ids, boolean[] lan, long idleMs) {
        BtLinks.Options o = new BtLinks.Options();
        o.platform = new FakeRadio(air, "R" + i);
        o.selfId = ids[i];
        o.meshPort = () -> 1;
        o.isTrusted = id -> id.equals(ids[1 - i]);
        o.trustedIds = () -> Arrays.asList(ids[1 - i]);
        o.onLan = id -> lan[0];
        o.tickMs = 0;
        o.idleMs = idleMs;
        BtLinks l = new BtLinks(o);
        managers.add(l);
        return l;
    }

    @Test(timeout = 30_000)
    public void autoClosesAnIdleLinkBackOnTheLanAndBtModeKeepsIt() throws Exception {
        Air air = new Air();
        String[] ids = {"a".repeat(64), "b".repeat(64)};
        boolean[] lan = {false};
        BtLinks a = manager(air, 0, ids, lan, 30);
        BtLinks b = manager(air, 1, ids, lan, 30);
        b.start();
        a.start();
        until(() -> a.linked().size() == 1, 10_000);
        lan[0] = true;
        a.tick();
        assertEquals(1, a.linked().size()); // not idle long enough yet
        Thread.sleep(60);
        a.tick();
        assertEquals(0, a.linked().size());
        lan[0] = false;
        Map<String, String> m = new LinkedHashMap<>();
        m.put(ids[1], LinkPolicy.BT);
        a.setPolicy(new LinkPolicy(true, false, m));
        until(() -> a.linked().size() == 1, 10_000);
        lan[0] = true;
        Thread.sleep(60);
        a.tick();
        assertEquals(1, a.linked().size());
    }

    @Test(timeout = 30_000)
    public void backsOffAfterAFailedDial() throws Exception {
        Air air = new Air();
        new FakeRadio(air, "R1").away = true;
        BtLinks.Options o = new BtLinks.Options();
        o.platform = new FakeRadio(air, "R0");
        o.selfId = "a".repeat(64);
        o.meshPort = () -> 1;
        o.isTrusted = id -> true;
        o.trustedIds = () -> Arrays.asList("b".repeat(64));
        o.onLan = id -> false;
        o.tickMs = 0;
        BtLinks links = new BtLinks(o);
        managers.add(links);
        links.start(); // start-up pass probes the unmapped radio once
        until(() -> air.dials.get() >= 1, 5000);
        Thread.sleep(100);
        assertNull(links.ensure("b".repeat(64), 2000));
        int n = air.dials.get();
        assertEquals(2, n);
        assertNull(links.ensure("b".repeat(64), 2000));
        links.tick();
        assertEquals(n, air.dials.get());
    }
}
