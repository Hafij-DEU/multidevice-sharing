package io.github.hafijbge.meshdrop.engine.send;

import static org.junit.Assert.assertEquals;

import io.github.hafijbge.meshdrop.engine.identity.Identity;
import io.github.hafijbge.meshdrop.engine.identity.PlainKeyVault;
import io.github.hafijbge.meshdrop.engine.net.Http;
import io.github.hafijbge.meshdrop.engine.net.Tls;
import java.io.BufferedInputStream;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Arrays;
import java.util.concurrent.atomic.AtomicInteger;
import javax.net.ssl.SSLServerSocket;
import javax.net.ssl.SSLSocket;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

/** Replies bigger than 1 MiB (a finish for a big folder lists every landed path) are fine up to 16 MiB. */
public class SenderReplyTest {
    @Rule public TemporaryFolder tmp = new TemporaryFolder();

    /** A fake receiver: answers offer {have:{}}, chunks 204, complete 200, finish with a `finishBytes` reply. */
    static int fake(Identity id, int finishBytes, AtomicInteger finishes) throws Exception {
        SSLServerSocket ss = (SSLServerSocket) Tls.serverContext(id).getServerSocketFactory().createServerSocket(0);
        ss.setEnabledProtocols(Tls.PROTOCOLS);
        ss.setWantClientAuth(true);
        Thread t = new Thread(() -> {
            while (!ss.isClosed()) {
                try (SSLSocket s = (SSLSocket) ss.accept()) {
                    Http.Request req = Http.readRequest(new BufferedInputStream(s.getInputStream()));
                    req.body(8 << 20);
                    byte[] body;
                    int status = 200;
                    if (req.path.contains("/offer")) body = "{\"have\":{}}".getBytes(StandardCharsets.UTF_8);
                    else if (req.path.contains("/chunk/")) {
                        status = 204;
                        body = null;
                    } else if (req.path.contains("/finish/")) {
                        finishes.incrementAndGet();
                        char[] pad = new char[finishBytes];
                        Arrays.fill(pad, 'x');
                        body = ("{\"files\":[\"" + new String(pad) + "\"]}").getBytes(StandardCharsets.UTF_8);
                    } else body = "{\"path\":\"a.txt\"}".getBytes(StandardCharsets.UTF_8);
                    Http.writeResponse(s.getOutputStream(), status, body, "application/json");
                } catch (Exception e) {
                    // next connection
                }
            }
        });
        t.setDaemon(true);
        t.start();
        return ss.getLocalPort();
    }

    Sender.Options opts() throws Exception {
        Sender.Options o = new Sender.Options();
        o.outbox = new Outbox(tmp.newFolder());
        o.retryDelaysMs = new int[] {10, 10, 10};
        return o;
    }

    @Test
    public void aTwoMiBFinishReplyCompletesTheSend() throws Exception {
        Identity me = Identity.loadOrCreate(tmp.newFolder(), new PlainKeyVault());
        Identity peer = Identity.loadOrCreate(tmp.newFolder(), new PlainKeyVault());
        AtomicInteger finishes = new AtomicInteger();
        int port = fake(peer, 2 << 20, finishes);
        File f = new File(tmp.getRoot(), "a.txt");
        Files.write(f.toPath(), new byte[] {1});
        SendResult r = Sender.sendTo(me, new Sender.Target(peer.deviceId(), "127.0.0.1", port, peer.keyPair().getPublic()),
                Prepared.of(Arrays.asList(SendItem.file(PathSource.file(f.toPath()))), null), opts());
        assertEquals(r.error, "done", r.status);
    }

    @Test
    public void anOversizedReplyIsABadResponseNotRetried() throws Exception {
        Identity me = Identity.loadOrCreate(tmp.newFolder(), new PlainKeyVault());
        Identity peer = Identity.loadOrCreate(tmp.newFolder(), new PlainKeyVault());
        AtomicInteger finishes = new AtomicInteger();
        int port = fake(peer, 17 << 20, finishes);
        File f = new File(tmp.getRoot(), "a.txt");
        Files.write(f.toPath(), new byte[] {1});
        SendResult r = Sender.sendTo(me, new Sender.Target(peer.deviceId(), "127.0.0.1", port, peer.keyPair().getPublic()),
                Prepared.of(Arrays.asList(SendItem.file(PathSource.file(f.toPath()))), null), opts());
        assertEquals("failed", r.status);
        assertEquals("bad-response", r.error);
        assertEquals(1, finishes.get());
    }

    @Test
    public void aDeletedSourceIsSourceChangedNotTransient() throws Exception {
        Identity me = Identity.loadOrCreate(tmp.newFolder(), new PlainKeyVault());
        Identity peer = Identity.loadOrCreate(tmp.newFolder(), new PlainKeyVault());
        File f = new File(tmp.getRoot(), "gone.txt");
        Files.write(f.toPath(), new byte[] {1, 2, 3});
        Sender.Options o = opts();
        // Nothing listens on port 1: the send fails transiently and stays in the outbox.
        Sender.Target t = new Sender.Target(peer.deviceId(), "127.0.0.1", 1, peer.keyPair().getPublic());
        SendResult first = Sender.sendTo(me, t, Prepared.of(Arrays.asList(SendItem.file(PathSource.file(f.toPath()))), null), o);
        assertEquals("failed", first.status);
        Files.delete(f.toPath());
        SendResult again = o.outbox.resumeEntry(me, first.sessionId, t, o);
        assertEquals("source-changed", again.error);
    }
}
