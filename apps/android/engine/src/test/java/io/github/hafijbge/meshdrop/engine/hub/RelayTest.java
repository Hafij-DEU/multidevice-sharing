package io.github.hafijbge.meshdrop.engine.hub;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import io.github.hafijbge.meshdrop.engine.Engine;
import io.github.hafijbge.meshdrop.engine.EngineConfig;
import io.github.hafijbge.meshdrop.engine.identity.Identity;
import io.github.hafijbge.meshdrop.engine.identity.PlainKeyVault;
import io.github.hafijbge.meshdrop.engine.mesh.Envelope;
import io.github.hafijbge.meshdrop.engine.mesh.MembershipStore;
import io.github.hafijbge.meshdrop.engine.recv.DirectorySink;
import io.github.hafijbge.meshdrop.engine.recv.MeshServer;
import io.github.hafijbge.meshdrop.engine.send.PathSource;
import io.github.hafijbge.meshdrop.engine.send.SendItem;
import io.github.hafijbge.meshdrop.engine.send.SendResult;
import io.github.hafijbge.meshdrop.engine.testutil.Node;
import io.github.hafijbge.meshdrop.engine.testutil.NodeListen;
import io.github.hafijbge.meshdrop.engine.testutil.NodeMesh;
import io.github.hafijbge.meshdrop.engine.util.B64;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BooleanSupplier;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

/** Sends through the Node hub: live relay both ways, held for an offline member, replay and forgery. */
public class RelayTest {
    @Rule public TemporaryFolder tmp = new TemporaryFolder();

    static final String INGRESS = "ws://127.0.0.1:53319/mesh/v1/hub";

    static void until(String what, BooleanSupplier ok, long ms) throws InterruptedException {
        long end = System.currentTimeMillis() + ms;
        while (!ok.getAsBoolean()) {
            if (System.currentTimeMillis() > end) throw new AssertionError("timed out waiting for " + what);
            Thread.sleep(50);
        }
    }

    static boolean online(Engine e, String id) {
        for (HubClient.DirectoryEntry d : e.directory()) if (d.deviceId.equals(id)) return d.online;
        return false;
    }

    File file(String name, int size) throws Exception {
        File f = new File(tmp.getRoot(), name);
        byte[] b = new byte[size];
        new java.util.Random(size).nextBytes(b);
        Files.write(f.toPath(), b);
        return f;
    }

    @Test
    public void sendsThroughTheHubBothWaysAndHoldsForAnOfflineMember() throws Exception {
        File hubHome = tmp.newFolder("hub");
        File bHome = tmp.newFolder("b");
        File jHome = tmp.newFolder("phone");
        NodeMesh.hubInit(hubHome);
        Identity jId = Identity.loadOrCreate(jHome, new PlainKeyVault());
        NodeMesh.addMember(hubHome, jId, jHome, "phone", INGRESS);
        String bId = NodeMesh.addNodeMember(hubHome, bHome, "b", INGRESS);

        EngineConfig c = new EngineConfig(jHome, new PlainKeyVault(), new DirectorySink(new File(jHome, "inbox")));
        c.port = 0;
        c.alias = "phone";
        c.discovery = false;
        c.lanAddrs = Collections::emptyList; // not on the LAN for B: everything goes through the hub
        c.probeDirectoryAddrs = false;
        c.hubBackoffMs = new long[] {50, 200};
        NodeListen hub = NodeListen.start(hubHome);
        NodeListen b = NodeListen.start(bHome);
        Engine j = Engine.create(c);
        try {
            j.start();
            until("hub link", () -> j.hubState() == HubClient.State.ONLINE, 15_000);
            until("B online in the directory", () -> online(j, bId), 15_000);

            // Java -> B, live relay.
            File one = file("one.bin", 300_000);
            List<SendResult> r1 = j.send(Arrays.asList(bId.substring(0, 8)), Arrays.asList(SendItem.file(PathSource.file(one.toPath()))), null).get(120, TimeUnit.SECONDS);
            assertEquals(r1.toString(), "done", r1.get(0).status);
            assertArrayEquals(Files.readAllBytes(one.toPath()), Files.readAllBytes(new File(b.inbox, "one.bin").toPath()));

            // Java -> B while B is offline: held on the hub, delivered when B comes back.
            b.close();
            until("B offline in the directory", () -> !online(j, bId), 15_000);
            File two = file("two.bin", 200_000);
            List<SendResult> r2 = j.send(Arrays.asList(bId.substring(0, 8)), Arrays.asList(SendItem.file(PathSource.file(two.toPath()))), null).get(120, TimeUnit.SECONDS);
            assertEquals(r2.toString(), "held", r2.get(0).status);
            b = NodeListen.start(bHome);
            File got = new File(b.inbox, "two.bin");
            until("held file delivered", got::exists, 30_000);
            until("held file complete", () -> got.length() == two.length(), 10_000);
            assertArrayEquals(Files.readAllBytes(two.toPath()), Files.readAllBytes(got.toPath()));

            // B -> Java: B's CLI send runs its own hub link (no listener on B's home).
            b.close();
            File three = file("three.bin", 100_000);
            Node.Result s = Node.run(120, "send", jId.deviceId().substring(0, 8), three.getPath(), "--home", bHome.getPath());
            assertEquals(s.out, 0, s.code);
            File in = new File(jHome, "inbox/three.bin");
            until("relayed file received", in::exists, 10_000);
            assertArrayEquals(Files.readAllBytes(three.toPath()), Files.readAllBytes(in.toPath()));
        } finally {
            j.stop();
            b.close();
            hub.close();
        }
    }

    @Test
    public void aReplayedRequestRunsOnceAndAForgedOneNever() throws Exception {
        File hubHome = tmp.newFolder("hub");
        File aHome = tmp.newFolder("a");
        File kHome = tmp.newFolder("k");
        NodeMesh.hubInit(hubHome);
        Identity a = Identity.loadOrCreate(aHome, new PlainKeyVault());
        Identity k = Identity.loadOrCreate(kHome, new PlainKeyVault());
        MembershipStore as = NodeMesh.addMember(hubHome, a, aHome, "a", INGRESS);
        MembershipStore ks = NodeMesh.addMember(hubHome, k, kHome, "k", INGRESS);
        AtomicInteger runs = new AtomicInteger();
        HubClient.Options ao = new HubClient.Options(a, () -> as);
        ao.handler = (peer, method, path, ct, body) -> {
            runs.incrementAndGet();
            return new MeshServer.Reply(200, ("{\"peer\":\"" + peer + "\"}").getBytes(StandardCharsets.UTF_8));
        };
        HubClient ac = new HubClient(ao);
        HubClient kc = new HubClient(new HubClient.Options(k, () -> ks));
        try (NodeListen hub = NodeListen.start(hubHome)) {
            ac.start();
            kc.start();
            until("both online", () -> ac.state() == HubClient.State.ONLINE && kc.state() == HubClient.State.ONLINE, 15_000);
            until("a knows k", () -> as.isTrusted(k.deviceId()), 10_000);
            byte[] id = new byte[16];
            new java.security.SecureRandom().nextBytes(id);
            Envelope.Header h = Envelope.Header.req(B64.url(id), k.deviceId(), a.deviceId(), "POST", "/mesh/v1/cancel/x");
            Envelope req = Envelope.seal(h, new byte[0], k.keyPair().getPrivate());
            Envelope r1 = kc.request(req, 10_000, null);
            Envelope r2 = kc.request(req, 10_000, null);
            assertEquals(Integer.valueOf(200), r1.header.status);
            assertEquals(a.deviceId(), r2.header.from);
            assertArrayEquals(r1.body, r2.body);
            assertEquals("a replayed id is answered from the cache", 1, runs.get());

            byte[] id2 = new byte[16];
            new java.security.SecureRandom().nextBytes(id2);
            Envelope ok = Envelope.seal(Envelope.Header.req(B64.url(id2), k.deviceId(), a.deviceId(), "POST", "/mesh/v1/cancel/y"), "x".getBytes(StandardCharsets.UTF_8), k.keyPair().getPrivate());
            Envelope forged = new Envelope(ok.header, "y".getBytes(StandardCharsets.UTF_8));
            Envelope r3 = kc.request(forged, 10_000, null);
            assertEquals(Integer.valueOf(400), r3.header.status);
            assertEquals(as.list().hubId, r3.header.from);
            Thread.sleep(300);
            assertEquals("a forged request never reaches the handler", 1, runs.get());
        } finally {
            ac.shutdown();
            kc.shutdown();
        }
    }
}
