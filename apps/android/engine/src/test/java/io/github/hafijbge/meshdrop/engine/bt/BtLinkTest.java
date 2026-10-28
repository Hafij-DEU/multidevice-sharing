package io.github.hafijbge.meshdrop.engine.bt;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import io.github.hafijbge.meshdrop.engine.util.Hex;
import io.github.hafijbge.meshdrop.engine.util.Json;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;
import org.junit.After;
import org.junit.Test;

public class BtLinkTest {
    static final String A = "a".repeat(64);
    static final String B = "b".repeat(64);
    final List<AutoCloseable> open = new ArrayList<>();

    @After
    public void tearDown() throws Exception {
        for (AutoCloseable c : open) c.close();
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> vectors() throws IOException {
        Path p = Path.of(System.getProperty("meshdrop.repo"), "protocol/vectors/btmux-v1.json");
        return (Map<String, Object>) Json.parse(Files.readString(p));
    }

    @Test
    @SuppressWarnings("unchecked")
    public void encodesAndDecodesTheVectors() throws Exception {
        Map<String, Object> v = vectors();
        List<Object> frames = (List<Object>) v.get("frames");
        for (Object o : frames) {
            Map<String, Object> f = (Map<String, Object>) o;
            byte[] got = BtMux.encode(((Number) f.get("type")).intValue(), ((Number) f.get("stream")).longValue(), Hex.parse((String) f.get("payloadHex")));
            assertEquals((String) f.get("name"), f.get("frameHex"), Hex.of(got));
        }
        byte[] all = Hex.parse((String) v.get("concatHex"));
        for (int step : new int[] {1, 2, 7, 9, 64, all.length}) {
            BtMux.Reader r = new BtMux.Reader();
            List<BtMux.Frame> got = new ArrayList<>();
            for (int o = 0; o < all.length; o += step) {
                byte[] piece = new byte[Math.min(step, all.length - o)];
                System.arraycopy(all, o, piece, 0, piece.length);
                got.addAll(r.push(piece));
            }
            assertEquals(frames.size(), got.size());
            for (int i = 0; i < got.size(); i++) {
                Map<String, Object> f = (Map<String, Object>) frames.get(i);
                assertEquals(((Number) f.get("type")).intValue(), got.get(i).type);
                assertEquals(((Number) f.get("stream")).longValue(), got.get(i).stream);
                assertEquals(f.get("payloadHex"), Hex.of(got.get(i).payload));
            }
        }
        for (Object o : (List<Object>) v.get("invalid")) {
            byte[] bad = Hex.parse((String) ((Map<String, Object>) o).get("frameHex"));
            assertThrows(IOException.class, () -> new BtMux.Reader().push(bad));
            assertThrows(IOException.class, () -> BtMux.read(BtMux.data(new java.io.ByteArrayInputStream(bad))));
        }
        assertThrows(IllegalArgumentException.class, () -> BtMux.encode(BtMux.DATA, 1, new byte[BtMux.MAX_PAYLOAD + 1]));
    }

    /** A TCP server standing in for a mesh port. */
    int meshStub(Consumer<Socket> handler) throws IOException {
        ServerSocket s = new ServerSocket(0, 16, InetAddress.getLoopbackAddress());
        open.add(s);
        Thread t = new Thread(() -> {
            while (!s.isClosed()) {
                try {
                    Socket c = s.accept();
                    open.add(c);
                    new Thread(() -> handler.accept(c)).start();
                } catch (IOException e) {
                    return;
                }
            }
        });
        t.setDaemon(true);
        t.start();
        return s.getLocalPort();
    }

    static final BtLink.Listener QUIET = new BtLink.Listener() {
        @Override
        public void onReady(BtLink link, String peerId) {}

        @Override
        public void onClosed(BtLink link, Exception why) {}
    };

    /** Two links over a loopback TCP connection standing in for RFCOMM. */
    BtLink[] pair(int meshA, int meshB) throws Exception {
        ServerSocket ss = new ServerSocket(0, 1, InetAddress.getLoopbackAddress());
        Socket x = new Socket(InetAddress.getLoopbackAddress(), ss.getLocalPort());
        Socket y = ss.accept();
        ss.close();
        BtLink a = new BtLink(x.getInputStream(), x.getOutputStream(), x, true, A, () -> meshA, 15_000, QUIET);
        BtLink b = new BtLink(y.getInputStream(), y.getOutputStream(), y, false, B, () -> meshB, 15_000, QUIET);
        open.add(a);
        open.add(b);
        a.start();
        b.start();
        assertTrue(a.awaitReady(5000));
        assertTrue(b.awaitReady(5000));
        assertEquals(B, a.peerId());
        assertEquals(A, b.peerId());
        return new BtLink[] {a, b};
    }

    static void echo(Socket s) {
        try {
            InputStream i = s.getInputStream();
            OutputStream o = s.getOutputStream();
            byte[] b = new byte[8192];
            int n;
            while ((n = i.read(b)) > 0) o.write(b, 0, n);
            s.shutdownOutput();
        } catch (IOException ignored) {
        }
    }

    static byte[] readAll(InputStream i) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] b = new byte[8192];
        int n;
        while ((n = i.read(b)) > 0) out.write(b, 0, n);
        return out.toByteArray();
    }

    @Test(timeout = 20_000)
    public void tunnelsBothWaysWithHalfClose() throws Exception {
        int echo = meshStub(BtLinkTest::echo);
        BtLink[] l = pair(echo, echo);
        for (BtLink side : l) {
            try (Socket s = new Socket(InetAddress.getLoopbackAddress(), side.normalPort())) {
                s.getOutputStream().write("hello over bluetooth".getBytes(StandardCharsets.UTF_8));
                s.shutdownOutput();
                assertEquals("hello over bluetooth", new String(readAll(s.getInputStream()), StandardCharsets.UTF_8));
            }
        }
        for (int i = 0; i < 100 && (l[0].streams() > 0 || l[1].streams() > 0); i++) Thread.sleep(10);
        assertEquals(0, l[0].streams());
        assertEquals(0, l[1].streams());
    }

    @Test(timeout = 30_000)
    public void movesFourMegabytesIntactUnderFlowControl() throws Exception {
        byte[] data = new byte[4 * 1024 * 1024];
        new SecureRandom().nextBytes(data);
        int echo = meshStub(BtLinkTest::echo);
        BtLink[] l = pair(1, echo);
        try (Socket s = new Socket(InetAddress.getLoopbackAddress(), l[0].priorityPort())) {
            CompletableFuture<byte[]> back = CompletableFuture.supplyAsync(() -> {
                try {
                    return readAll(s.getInputStream());
                } catch (IOException e) {
                    throw new RuntimeException(e);
                }
            });
            OutputStream o = s.getOutputStream();
            o.write(data);
            s.shutdownOutput();
            byte[] got = back.get(25, TimeUnit.SECONDS);
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            assertArrayEquals(md.digest(data), MessageDigest.getInstance("SHA-256").digest(got));
        }
    }

    @Test(timeout = 20_000)
    public void aLocalAbortResetsOnlyThatStream() throws Exception {
        AtomicInteger closed = new AtomicInteger();
        CountDownLatch two = new CountDownLatch(2);
        int stub = meshStub(s -> {
            two.countDown();
            try {
                readAll(s.getInputStream());
            } catch (IOException ignored) {
            }
            closed.incrementAndGet();
        });
        BtLink[] l = pair(1, stub);
        Socket s1 = new Socket(InetAddress.getLoopbackAddress(), l[0].normalPort());
        Socket s2 = new Socket(InetAddress.getLoopbackAddress(), l[0].normalPort());
        open.add(s2);
        s1.getOutputStream().write('x');
        s2.getOutputStream().write('y');
        assertTrue(two.await(5, TimeUnit.SECONDS));
        s1.setSoLinger(true, 0);
        s1.close();
        for (int i = 0; i < 200 && closed.get() < 1; i++) Thread.sleep(10);
        assertEquals(1, closed.get());
        assertEquals(1, l[0].streams());
    }

    @Test(timeout = 10_000)
    public void closesALinkThatFallsSilent() throws Exception {
        ServerSocket ss = new ServerSocket(0, 1, InetAddress.getLoopbackAddress());
        Socket x = new Socket(InetAddress.getLoopbackAddress(), ss.getLocalPort());
        Socket y = ss.accept();
        open.add(y);
        ss.close();
        AtomicReference<Exception> why = new AtomicReference<>();
        CountDownLatch done = new CountDownLatch(1);
        BtLink a = new BtLink(x.getInputStream(), x.getOutputStream(), x, true, A, () -> 1, 30, new BtLink.Listener() {
            @Override
            public void onReady(BtLink link, String peerId) {}

            @Override
            public void onClosed(BtLink link, Exception e) {
                why.set(e);
                done.countDown();
            }
        });
        a.start();
        assertTrue(done.await(5, TimeUnit.SECONDS));
        assertNotNull(why.get());
        assertTrue(why.get().getMessage(), why.get().getMessage().contains("silent"));
    }

    @Test(timeout = 10_000)
    public void rejectsBadHelloAndWrongParity() throws Exception {
        byte[][] firsts = {
            BtMux.encode(BtMux.HELLO, 0, "{\"v\":1,\"id\":\"nope\"}".getBytes(StandardCharsets.UTF_8)),
            BtMux.encode(BtMux.OPEN, 2, new byte[] {0}),
            concat(BtMux.encode(BtMux.HELLO, 0, ("{\"v\":1,\"id\":\"" + B + "\"}").getBytes(StandardCharsets.UTF_8)), BtMux.encode(BtMux.OPEN, 3, new byte[] {0})),
        };
        String[] want = {"HELLO", "HELLO", "bad OPEN"};
        for (int i = 0; i < firsts.length; i++) {
            ServerSocket ss = new ServerSocket(0, 1, InetAddress.getLoopbackAddress());
            Socket x = new Socket(InetAddress.getLoopbackAddress(), ss.getLocalPort());
            Socket y = ss.accept();
            open.add(y);
            ss.close();
            AtomicReference<Exception> why = new AtomicReference<>();
            CountDownLatch done = new CountDownLatch(1);
            BtLink a = new BtLink(x.getInputStream(), x.getOutputStream(), x, true, A, () -> 1, 15_000, new BtLink.Listener() {
                @Override
                public void onReady(BtLink link, String peerId) {}

                @Override
                public void onClosed(BtLink link, Exception e) {
                    why.set(e);
                    done.countDown();
                }
            });
            a.start();
            y.getOutputStream().write(firsts[i]);
            assertTrue(done.await(5, TimeUnit.SECONDS));
            assertTrue(why.get().getMessage(), why.get().getMessage().contains(want[i]));
        }
    }

    static byte[] concat(byte[] a, byte[] b) {
        byte[] r = new byte[a.length + b.length];
        System.arraycopy(a, 0, r, 0, a.length);
        System.arraycopy(b, 0, r, a.length, b.length);
        return r;
    }
}
