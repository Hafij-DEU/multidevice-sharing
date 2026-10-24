package io.github.hafijbge.meshdrop.engine.mesh;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import io.github.hafijbge.meshdrop.engine.identity.Identity;
import io.github.hafijbge.meshdrop.engine.identity.PlainKeyVault;
import io.github.hafijbge.meshdrop.engine.testutil.Node;
import io.github.hafijbge.meshdrop.engine.testutil.NodeListen;
import io.github.hafijbge.meshdrop.engine.testutil.NodeMesh;
import io.github.hafijbge.meshdrop.engine.util.B64;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.Collections;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

/** Redeeming invites made by the Node engine, over its LAN port and through the hub. */
public class JoinTest {
    @Rule public TemporaryFolder tmp = new TemporaryFolder();

    static final String INGRESS = "ws://127.0.0.1:53319/mesh/v1/hub";

    Identity device(File home) throws Exception {
        return Identity.loadOrCreate(home, new PlainKeyVault());
    }

    static String meshOf(File home) throws Exception {
        return MembershipStore.load(home).list().mesh;
    }

    /** Writes the inviter's invite.json (as `meshdrop invite` does) and returns its URI. */
    static String invite(NodeListen inviter, String mesh, long ttlMs, boolean lan, String... hubUrls) throws Exception {
        byte[] secret = new byte[16];
        new SecureRandom().nextBytes(secret);
        long expiresAt = System.currentTimeMillis() + ttlMs;
        String json = "{\"secret\":\"" + B64.url(secret) + "\",\"expiresAt\":" + expiresAt + ",\"used\":false}";
        File tmpFile = new File(inviter.home, "invite.json.tmp");
        Files.write(tmpFile.toPath(), json.getBytes(StandardCharsets.UTF_8));
        Files.move(tmpFile.toPath(), new File(inviter.home, "invite.json").toPath(), java.nio.file.StandardCopyOption.ATOMIC_MOVE);
        return new Invite(secret, inviter.deviceId, mesh,
                lan ? Collections.singletonList(new Invite.Addr("127.0.0.1", inviter.port)) : Collections.emptyList(),
                Arrays.asList(hubUrls), expiresAt).uri();
    }

    static void refused(Identity id, String uri, File home, String why) throws Exception {
        try {
            Join.join(id, uri, "x", home);
            fail("join should be refused: " + why);
        } catch (Join.JoinError e) {
            assertTrue(e.getMessage(), e.getMessage().contains(why));
        }
        assertFalse("nothing stored after " + why, new File(home, "mesh").exists());
        assertFalse(new File(home, "mesh-pending.json").exists());
    }

    @Test
    public void joinsOverTheLanFromACliInvite() throws Exception {
        File hubHome = tmp.newFolder("hub");
        File phoneHome = tmp.newFolder("phone");
        NodeMesh.hubInit(hubHome);
        try (NodeListen hub = NodeListen.start(hubHome)) {
            Node.Result inv = Node.run("invite", "--home", hubHome.getPath());
            assertEquals(inv.out, 0, inv.code);
            String uri = inv.out.split("\n")[0].trim();
            Identity phone = device(phoneHome);
            assertEquals("member", Join.join(phone, uri, "phone", phoneHome));
            MembershipStore ms = MembershipStore.load(phoneHome);
            assertNotNull(ms.list().member(phone.deviceId()));
            assertEquals(hub.deviceId, ms.list().hubId);
            assertTrue("the hub's LAN address is remembered", new File(phoneHome, "hub-addr.json").exists());
            Node.Result members = Node.run("members", "--home", hubHome.getPath());
            assertTrue(members.out, members.out.contains("phone"));
            try {
                Join.join(phone, uri, "phone", phoneHome);
                fail("a second join must be refused");
            } catch (Join.JoinError e) {
                assertTrue(e.getMessage(), e.getMessage().contains("already in a mesh"));
            }
            assertEquals(ms.list().version, MembershipStore.load(phoneHome).list().version);
        }
    }

    @Test
    public void joinsThroughTheHubUrl() throws Exception {
        File hubHome = tmp.newFolder("hub");
        File phoneHome = tmp.newFolder("phone");
        NodeMesh.hubInit(hubHome);
        try (NodeListen hub = NodeListen.start(hubHome)) {
            String uri = invite(hub, meshOf(hubHome), 300_000, false, INGRESS);
            Thread.sleep(1500); // the listener picks invite.json up once a second
            Identity phone = device(phoneHome);
            assertEquals("member", Join.join(phone, uri, "phone", phoneHome));
            assertNotNull(MembershipStore.load(phoneHome).list().member(phone.deviceId()));
            Node.Result members = Node.run("members", "--home", hubHome.getPath());
            assertTrue(members.out, members.out.contains("phone"));
        }
    }

    @Test
    public void expiredUsedAndForgedInvitesStoreNothing() throws Exception {
        File hubHome = tmp.newFolder("hub");
        NodeMesh.hubInit(hubHome);
        try (NodeListen hub = NodeListen.start(hubHome)) {
            String mesh = meshOf(hubHome);
            String shortLived = invite(hub, mesh, 2500, true);
            Thread.sleep(3500); // registered by the listener's poll, then expired on its clock
            File a = tmp.newFolder("a");
            refused(device(a), shortLived, a, "expired");

            String uri = invite(hub, mesh, 300_000, true);
            Thread.sleep(1500);
            Invite good = Invite.parse(uri);
            byte[] wrong = good.secret.clone();
            wrong[0] ^= 1;
            String forged = new Invite(wrong, good.inviter, good.mesh, good.lan, good.hubUrls, good.expiresAt).uri();
            File b = tmp.newFolder("b");
            refused(device(b), forged, b, "bad-proof");

            File c = tmp.newFolder("c");
            assertEquals("member", Join.join(device(c), uri, "c", c));
            File d = tmp.newFolder("d");
            refused(device(d), uri, d, "used");
        }
    }

    @Test
    public void aProvisionalJoinCompletesOnceTheHubSignsTheDeviceIn() throws Exception {
        File hubHome = tmp.newFolder("hub");
        File memberHome = tmp.newFolder("member");
        File phoneHome = tmp.newFolder("phone");
        NodeMesh.hubInit(hubHome);
        NodeListen hub = NodeListen.start(hubHome);
        int hubPort = hub.port;
        Node.Result inv = Node.run("invite", "--home", hubHome.getPath());
        Node.Result j = Node.run("join", inv.out.split("\n")[0].trim(), "--home", memberHome.getPath(), "--alias", "member");
        assertEquals(j.out, 0, j.code);
        hub.close();
        try (NodeListen member = NodeListen.start(memberHome)) {
            String uri = invite(member, meshOf(memberHome), 300_000, true);
            Identity phone = device(phoneHome);
            assertEquals("provisional", Join.join(phone, uri, "phone", phoneHome));
            assertFalse(new File(phoneHome, "mesh").exists());
            assertTrue(Join.pending(phoneHome));
            hub = NodeListen.start(hubHome, hubPort);
            MembershipStore ms = null;
            long end = System.currentTimeMillis() + 60_000;
            while (ms == null) {
                try {
                    ms = Join.complete(phone, phoneHome);
                } catch (Join.JoinError e) {
                    if (System.currentTimeMillis() > end) throw e;
                    Thread.sleep(500);
                }
            }
            assertNotNull(ms.list().member(phone.deviceId()));
            assertFalse(Join.pending(phoneHome));
        } finally {
            hub.close();
        }
    }
}
