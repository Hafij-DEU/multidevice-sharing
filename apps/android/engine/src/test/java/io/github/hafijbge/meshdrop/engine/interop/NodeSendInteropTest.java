package io.github.hafijbge.meshdrop.engine.interop;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import io.github.hafijbge.meshdrop.engine.crypto.P256;
import io.github.hafijbge.meshdrop.engine.identity.X509;
import io.github.hafijbge.meshdrop.engine.send.MultiSend;
import io.github.hafijbge.meshdrop.engine.send.Outbox;
import io.github.hafijbge.meshdrop.engine.send.PathSource;
import io.github.hafijbge.meshdrop.engine.send.Prepared;
import io.github.hafijbge.meshdrop.engine.send.SendItem;
import io.github.hafijbge.meshdrop.engine.send.SendResult;
import io.github.hafijbge.meshdrop.engine.send.Sender;
import io.github.hafijbge.meshdrop.engine.testutil.Node;
import io.github.hafijbge.meshdrop.engine.testutil.NodeListen;
import io.github.hafijbge.meshdrop.engine.testutil.Peers;
import io.github.hafijbge.meshdrop.engine.util.Hex;
import java.io.File;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.Random;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

/** Java sends to the Node engine (`meshdrop listen`). */
public class NodeSendInteropTest {
    @Rule public TemporaryFolder tmp = new TemporaryFolder();

    /** A Java device paired both ways with a Node listener. */
    Peers.Receiver phone;

    Sender.Target pair(NodeListen pc) throws Exception {
        if (phone == null) phone = Peers.receiver(tmp.newFolder());
        Node.Result r = Node.run("pair", "127.0.0.1:" + phone.port, "phone", "--home", pc.home.getPath());
        assertEquals(r.out, 0, r.code);
        phone.trustHome(pc.home, "pc");
        byte[] der = Files.readAllBytes(new File(pc.home, "identity/cert.der").toPath());
        return new Sender.Target(pc.deviceId, "127.0.0.1", pc.port, X509.publicKey(der));
    }

    Sender.Options opts(Outbox outbox) {
        Sender.Options o = new Sender.Options();
        o.outbox = outbox;
        o.resolver = PathSource.RESOLVER;
        return o;
    }

    static String sha(File f) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        try (java.io.InputStream in = new java.io.FileInputStream(f)) {
            byte[] b = new byte[1 << 20];
            for (int n; (n = in.read(b)) > 0; ) md.update(b, 0, n);
        }
        return Hex.of(md.digest());
    }

    @Test
    public void sendsToNode() throws Exception {
        try (NodeListen pc = NodeListen.start(tmp.newFolder("pc"))) {
            Sender.Target t = pair(pc);
            File dir = tmp.newFolder("album");
            assertTrue(new File(dir, "empty").mkdir());
            Files.write(new File(dir, "zero.bin").toPath(), new byte[0]);
            byte[] exact = new byte[2 * 4 * 1024 * 1024];
            new Random(3).nextBytes(exact);
            Files.write(new File(dir, "exact.bin").toPath(), exact);
            Prepared p = Prepared.of(List.of(SendItem.dir(PathSource.tree(dir.toPath())), SendItem.text("from java")), null);
            SendResult r = Sender.sendTo(phone.id, t, p, opts(new Outbox(tmp.newFolder("outbox"))));
            assertEquals(r.error, "done", r.status);
            assertArrayEquals(exact, Files.readAllBytes(new File(pc.inbox, "album/exact.bin").toPath()));
            assertEquals(0, new File(pc.inbox, "album/zero.bin").length());
            assertTrue(new File(pc.inbox, "album/empty").isDirectory());
            assertTrue(pc.output(), pc.output().contains("from java"));
        } finally {
            if (phone != null) phone.close();
        }
    }

    @Test
    public void resumesAfterReceiverRestart() throws Exception {
        File pcHome = tmp.newFolder("pc");
        NodeListen pc = NodeListen.start(pcHome);
        try {
            Sender.Target t = pair(pc);
            File big = new File(tmp.getRoot(), "video.bin");
            byte[] data = new byte[64 * 1024 * 1024];
            new Random(9).nextBytes(data);
            Files.write(big.toPath(), data);
            Outbox outbox = new Outbox(tmp.newFolder("outbox"));
            Sender.Options o = opts(outbox);
            NodeListen dying = pc;
            AtomicBoolean killed = new AtomicBoolean();
            o.progress = (dev, sid, fileId, sent, total) -> {
                if (killed.compareAndSet(false, true)) {
                    try {
                        dying.kill();
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    }
                }
            };
            SendResult r = Sender.sendTo(phone.id, t, Prepared.of(List.of(SendItem.file(PathSource.file(big.toPath()))), null), o);
            assertEquals("failed", r.status);
            List<Outbox.Entry> left = outbox.list();
            assertEquals(1, left.size());
            assertTrue(left.get(0).lastError, Sender.isTransientError(left.get(0).lastError));

            pc = NodeListen.start(pcHome, t.port);
            List<SendResult> again = outbox.resumeAll(phone.id, dev -> t, opts(outbox));
            assertEquals(again.get(0).error, "done", again.get(0).status);
            assertArrayEquals(data, Files.readAllBytes(new File(pc.inbox, "video.bin").toPath()));
            assertEquals(0, outbox.list().size());
        } finally {
            pc.close();
            if (phone != null) phone.close();
        }
    }

    @Test
    public void aSourceChangedInPlaceFailsAndCancelsTheReceiverSession() throws Exception {
        try (NodeListen pc = NodeListen.start(tmp.newFolder("pc"))) {
            Sender.Target t = pair(pc);
            File f = new File(tmp.getRoot(), "doc.bin");
            byte[] data = new byte[40 * 1024 * 1024];
            new Random(5).nextBytes(data);
            Files.write(f.toPath(), data);
            long mtime = f.lastModified();
            Sender.Options o = opts(new Outbox(tmp.newFolder("outbox")));
            o.concurrency = 1;
            AtomicBoolean changed = new AtomicBoolean();
            o.progress = (dev, sid, fileId, sent, total) -> {
                if (changed.compareAndSet(false, true)) {
                    try (RandomAccessFile raf = new RandomAccessFile(f, "rw")) {
                        raf.seek(20 * 1024 * 1024);
                        raf.write(new byte[16]);
                    } catch (java.io.IOException e) {
                        throw new RuntimeException(e);
                    }
                    f.setLastModified(mtime);
                }
            };
            SendResult r = Sender.sendTo(phone.id, t, Prepared.of(List.of(SendItem.file(PathSource.file(f.toPath()))), null), o);
            assertEquals("failed", r.status);
            assertEquals("source-changed", r.error);
            File partial = new File(pc.inbox, ".meshdrop-partial/" + r.sessionId);
            for (int i = 0; i < 100 && partial.exists(); i++) Thread.sleep(50);
            assertFalse("the receiver dropped the session after cancel", partial.exists());
        } finally {
            if (phone != null) phone.close();
        }
    }

    @Test
    public void bigFileLowMemory() throws Exception {
        try (NodeListen pc = NodeListen.start(tmp.newFolder("pc"))) {
            pair(pc);
            File big = new File(tmp.getRoot(), "huge.bin");
            try (RandomAccessFile raf = new RandomAccessFile(big, "rw")) {
                raf.setLength(1L << 30); // sparse 1 GiB
                raf.seek(123_456_789);
                raf.write("needle".getBytes(StandardCharsets.UTF_8));
            }
            List<String> cmd = new ArrayList<>(List.of(System.getProperty("java.home") + "/bin/java", "-Xmx96m", "-cp", System.getProperty("java.class.path"),
                    BigSendMain.class.getName(), phone.home.getPath(), pc.deviceId, String.valueOf(pc.port), new File(pc.home, "identity/cert.der").getPath(), big.getPath()));
            Process p = new ProcessBuilder(cmd).redirectErrorStream(true).start();
            assertTrue("big send finished", p.waitFor(240, TimeUnit.SECONDS));
            String out = new String(p.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
            assertEquals(out, 0, p.exitValue());
            assertEquals(sha(big), sha(new File(pc.inbox, "huge.bin")));
        } finally {
            if (phone != null) phone.close();
        }
    }

    @Test
    public void multiSendOneFailsTheOtherIsDone() throws Exception {
        try (NodeListen a = NodeListen.start(tmp.newFolder("a")); NodeListen b = NodeListen.start(tmp.newFolder("b"))) {
            Sender.Target ta = pair(a);
            Sender.Target tb = pair(b);
            b.kill();
            File f = new File(tmp.getRoot(), "note.txt");
            Files.write(f.toPath(), "x".getBytes(StandardCharsets.UTF_8));
            Prepared p = Prepared.of(List.of(SendItem.file(PathSource.file(f.toPath()))), null);
            Sender.Options o = opts(new Outbox(tmp.newFolder("outbox")));
            o.retryDelaysMs = new int[] {50};
            List<SendResult> rs = MultiSend.send(phone.id, List.of(tb, ta), p, o);
            assertEquals(tb.deviceId, rs.get(0).deviceId);
            assertEquals("failed", rs.get(0).status);
            assertEquals("done", rs.get(1).status);
            assertNotNull(Files.readString(new File(a.inbox, "note.txt").toPath()));
        } finally {
            if (phone != null) phone.close();
        }
    }
}
