package io.github.hafijbge.meshdrop.engine.bt;

import io.github.hafijbge.meshdrop.engine.util.Json;
import java.io.BufferedOutputStream;
import java.io.Closeable;
import java.io.DataInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.function.IntSupplier;
import java.util.regex.Pattern;

/**
 * One Bluetooth link to one device (btmux v1, docs/protocol.md). Two local listeners on 127.0.0.1 (normal
 * and priority) turn each accepted connection into a stream to the far side's mesh port; a stream the far
 * side opens is connected to this device's mesh port. The link only carries bytes: identity is proven by
 * the pinned mTLS inside each stream, so the HELLO id only maps a Bluetooth address to a device.
 */
public final class BtLink implements Closeable {
    public interface Listener {
        void onReady(BtLink link, String peerId);

        void onClosed(BtLink link, Exception why);
    }

    /**
     * The phone is the Bluetooth central: the far side only gets send slots when the phone transmits, so a
     * phone that only listens got 21-27% of real-time sound. While a stream has received DATA in the last
     * FILL_FOR_MS, the writer sends a frame at least every FILL_MS (an empty CREDIT on stream 0, which a
     * peer ignores as a frame for an unknown stream).
     */
    static final long FILL_MS = 10;
    static final long FILL_FOR_MS = 5000;
    private static final byte[] FILL = BtMux.encode(BtMux.CREDIT, 0, new byte[4]);
    /** Logcat tag MeshDropBt: why links and streams end, for field reports. */
    static final java.util.logging.Logger LOG = java.util.logging.Logger.getLogger("MeshDropBt");
    /** Streams are dialled at 127.0.0.1 (see Engine.Route.bt); Android's getLoopbackAddress() is ::1, which refuses them. */
    private static final InetAddress LOOPBACK = loopback();
    private static final Pattern DEVICE_ID = Pattern.compile("[0-9a-f]{64}");
    private static final Object END_MARK = new Object();
    private static final byte[] ABORT = new byte[0];
    private static final byte[] END_IN = new byte[0];

    public final boolean dialer;
    public final long createdAt = System.currentTimeMillis();
    private final DataInputStream in;
    private final OutputStream out;
    private final Closeable conn;
    private final String selfId;
    private final IntSupplier meshPort;
    private final long pingMs;
    private final Listener listener;
    private final CountDownLatch ready = new CountDownLatch(1);

    private final Object lock = new Object();
    private final ArrayDeque<byte[]> control = new ArrayDeque<>();
    private final ArrayDeque<Long> ring = new ArrayDeque<>();
    private final Map<Long, Pipe> pipes = new HashMap<>();
    private long nextId;
    private boolean closed;
    private volatile String peerId;
    private volatile long lastRx = System.currentTimeMillis();
    private volatile long lastActive = System.currentTimeMillis();
    private volatile long lastDataIn;
    private ServerSocket normal, priority;

    private final class Pipe {
        final long id;
        final boolean priority;
        volatile Socket sock;
        final ArrayDeque<Object> outq = new ArrayDeque<>(); // guarded by lock
        final LinkedBlockingQueue<byte[]> inq = new LinkedBlockingQueue<>();
        long inFlight; // guarded by this
        boolean localEnded, remoteEnded, endSent; // guarded by lock

        Pipe(long id, boolean priority, Socket sock) {
            this.id = id;
            this.priority = priority;
            this.sock = sock;
        }
    }

    public BtLink(InputStream in, OutputStream out, Closeable conn, boolean dialer, String selfId, IntSupplier meshPort, long pingMs, Listener listener) {
        this.in = BtMux.data(in);
        this.out = new BufferedOutputStream(out, 32 * 1024);
        this.conn = conn;
        this.dialer = dialer;
        this.selfId = selfId;
        this.meshPort = meshPort;
        this.pingMs = pingMs;
        this.listener = listener;
        this.nextId = dialer ? 1 : 2;
    }

    public void start() {
        Map<String, Object> hello = new LinkedHashMap<>();
        hello.put("v", 1L);
        hello.put("id", selfId);
        sendControl(BtMux.encode(BtMux.HELLO, 0, Json.stringify(hello).getBytes(StandardCharsets.UTF_8)));
        thread(this::readLoop, "bt-rx");
        thread(this::writeLoop, "bt-tx");
    }

    public String peerId() {
        return peerId;
    }

    public boolean awaitReady(long ms) throws InterruptedException {
        return ready.await(ms, TimeUnit.MILLISECONDS) && !closed();
    }

    public int normalPort() {
        return normal == null ? 0 : normal.getLocalPort();
    }

    public int priorityPort() {
        return priority == null ? 0 : priority.getLocalPort();
    }

    public long lastActive() {
        return lastActive;
    }

    public int streams() {
        synchronized (lock) {
            return pipes.size();
        }
    }

    public boolean closed() {
        synchronized (lock) {
            return closed;
        }
    }

    @Override
    public void close() {
        closeWith(null);
    }

    private void closeWith(Exception why) {
        List<Pipe> all;
        synchronized (lock) {
            if (closed) return;
            closed = true;
            all = new ArrayList<>(pipes.values());
            pipes.clear();
            lock.notifyAll();
        }
        quiet(conn);
        quiet(normal);
        quiet(priority);
        for (Pipe p : all) abortSocket(p);
        ready.countDown();
        LOG.info("link closed peer=" + peerId + " dialer=" + dialer + " streams=" + all.size() + " why=" + why);
        listener.onClosed(this, why);
    }

    // ---- frames in

    private void readLoop() {
        try {
            while (true) {
                BtMux.Frame f = BtMux.read(in);
                lastRx = System.currentTimeMillis();
                if (peerId == null && f.type != BtMux.HELLO) throw new IOException("btmux: frame before HELLO");
                switch (f.type) {
                    case BtMux.HELLO: onHello(f.payload); break;
                    case BtMux.OPEN: onOpen(f.stream, f.payload.length > 0 && (f.payload[0] & 1) == 1); break;
                    case BtMux.DATA: {
                        Pipe p = pipe(f.stream);
                        if (p != null) {
                            lastActive = lastDataIn = System.currentTimeMillis();
                            p.inq.add(f.payload);
                        }
                        break;
                    }
                    case BtMux.END: {
                        Pipe p = pipe(f.stream);
                        if (p != null) p.inq.add(END_IN);
                        break;
                    }
                    case BtMux.RESET: drop(f.stream, true); break;
                    case BtMux.CREDIT: {
                        Pipe p = pipe(f.stream);
                        if (p != null && f.payload.length == 4) {
                            synchronized (p) {
                                p.inFlight = Math.max(0, p.inFlight - BtMux.u32(f.payload, 0));
                                p.notifyAll();
                            }
                        }
                        break;
                    }
                    case BtMux.PING: sendControl(BtMux.encode(BtMux.PONG, 0)); break;
                    default: break;
                }
            }
        } catch (IOException e) {
            closeWith(e);
        } catch (RuntimeException e) {
            closeWith(new IOException(e));
        }
    }

    private void onHello(byte[] payload) throws IOException {
        Object id = null;
        try {
            Object h = Json.parse(new String(payload, StandardCharsets.UTF_8));
            if (h instanceof Map) {
                Map<?, ?> m = (Map<?, ?>) h;
                Object v = m.get("v");
                if (v instanceof Number && ((Number) v).longValue() == 1) id = m.get("id");
            }
        } catch (RuntimeException e) {
            id = null;
        }
        if (!(id instanceof String) || !DEVICE_ID.matcher((String) id).matches() || peerId != null) throw new IOException("btmux: bad HELLO");
        normal = listen(false);
        priority = listen(true);
        peerId = (String) id;
        ready.countDown();
        listener.onReady(this, peerId);
    }

    private ServerSocket listen(boolean prio) throws IOException {
        ServerSocket s = new ServerSocket();
        s.bind(new InetSocketAddress(LOOPBACK, 0), 16);
        thread(() -> acceptLoop(s, prio), "bt-accept");
        return s;
    }

    private void acceptLoop(ServerSocket s, boolean prio) {
        while (!s.isClosed()) {
            Socket sock;
            try {
                sock = s.accept();
            } catch (IOException e) {
                return;
            }
            long id;
            Pipe p;
            synchronized (lock) {
                if (closed) {
                    quiet(sock);
                    return;
                }
                id = nextId;
                nextId += 2;
                p = new Pipe(id, prio, sock);
                pipes.put(id, p);
                control.add(BtMux.encode(BtMux.OPEN, id, new byte[] {(byte) (prio ? 1 : 0)}));
                lock.notifyAll();
            }
            LOG.info("stream opened here id=" + id + " prio=" + prio);
            startPipe(p);
        }
    }

    private void onOpen(long id, boolean prio) throws IOException {
        // The far side's ids have the other parity; anything else is a protocol error.
        Pipe p;
        synchronized (lock) {
            if (id == 0 || ((id % 2) == 1) == dialer || pipes.containsKey(id)) throw new IOException("btmux: bad OPEN");
            p = new Pipe(id, prio, null);
            pipes.put(id, p);
        }
        LOG.info("stream open id=" + id + " prio=" + prio);
        // Connecting may block; it runs on the stream's own writer thread, which buffers early DATA.
        thread(() -> {
            try {
                Socket s = new Socket();
                s.connect(new InetSocketAddress(LOOPBACK, meshPort.getAsInt()), 5000);
                p.sock = s;
            } catch (IOException e) {
                LOG.info("stream " + id + " local connect failed: " + e);
                drop(id, false);
                return;
            }
            if (pipe(id) == null) {
                abortSocket(p);
                return;
            }
            thread(() -> pumpOut(p), "bt-stream-out");
            pumpIn(p);
        }, "bt-stream-in");
    }

    private void startPipe(Pipe p) {
        try {
            p.sock.setTcpNoDelay(true);
        } catch (IOException ignored) {
        }
        thread(() -> pumpOut(p), "bt-stream-out");
        thread(() -> pumpIn(p), "bt-stream-in");
    }

    /** Far side to local socket: write each DATA, then return its credit. */
    private void pumpIn(Pipe p) {
        try {
            OutputStream o = p.sock.getOutputStream();
            while (true) {
                byte[] b = p.inq.take();
                if (b == ABORT) return;
                if (b == END_IN) {
                    p.sock.shutdownOutput();
                    synchronized (lock) {
                        p.remoteEnded = true;
                        maybeDone(p);
                    }
                    return;
                }
                o.write(b);
                o.flush();
                byte[] n = new byte[4];
                BtMux.putU32(n, 0, b.length);
                synchronized (lock) {
                    if (pipes.get(p.id) == p) {
                        control.add(BtMux.encode(BtMux.CREDIT, p.id, n));
                        lock.notifyAll();
                    }
                }
            }
        } catch (IOException e) {
            drop(p.id, false);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    /** Local socket to far side, at most STREAM_WINDOW unacknowledged. */
    private void pumpOut(Pipe p) {
        byte[] buf = new byte[BtMux.DATA_SLICE];
        try {
            InputStream i = p.sock.getInputStream();
            while (true) {
                synchronized (p) {
                    while (p.inFlight >= BtMux.STREAM_WINDOW && pipe(p.id) == p) p.wait(1000);
                }
                if (pipe(p.id) != p) return;
                int n = i.read(buf);
                if (n < 0) {
                    synchronized (lock) {
                        if (pipes.get(p.id) != p) return;
                        p.outq.add(END_MARK);
                        p.localEnded = true;
                        ready(p);
                    }
                    return;
                }
                lastActive = System.currentTimeMillis();
                byte[] chunk = new byte[n];
                System.arraycopy(buf, 0, chunk, 0, n);
                synchronized (p) {
                    p.inFlight += n;
                }
                synchronized (lock) {
                    if (pipes.get(p.id) != p) return;
                    p.outq.add(chunk);
                    ready(p);
                }
            }
        } catch (IOException e) {
            drop(p.id, false);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    // ---- frames out

    private void ready(Pipe p) { // holds lock
        if (!ring.contains(p.id)) ring.addLast(p.id);
        lock.notifyAll();
    }

    private void sendControl(byte[] frame) {
        synchronized (lock) {
            if (closed) return;
            control.add(frame);
            lock.notifyAll();
        }
    }

    /** Control frames first, then priority streams, then the rest round-robin. Holds lock. */
    private byte[] next() {
        byte[] c = control.poll();
        if (c != null) return c;
        while (!ring.isEmpty()) {
            Long pick = null;
            for (Long id : ring) {
                Pipe p = pipes.get(id);
                if (p != null && p.priority) {
                    pick = id;
                    break;
                }
            }
            if (pick == null) pick = ring.peekFirst();
            ring.remove(pick);
            Pipe p = pipes.get(pick);
            if (p == null) continue;
            Object head = p.outq.poll();
            if (!p.outq.isEmpty()) ring.addLast(pick);
            if (head == null) continue;
            if (head == END_MARK) {
                p.endSent = true;
                maybeDone(p);
                return BtMux.encode(BtMux.END, pick);
            }
            return BtMux.encode(BtMux.DATA, pick, (byte[]) head);
        }
        return null;
    }

    private void writeLoop() {
        long lastPing = System.currentTimeMillis();
        long lastTx = lastPing;
        try {
            while (true) {
                byte[] f = null;
                boolean idle, fill = false;
                synchronized (lock) {
                    while (!closed) {
                        f = next();
                        if (f != null) break;
                        long now = System.currentTimeMillis();
                        if (now - lastPing >= pingMs) break;
                        long wait = pingMs - (now - lastPing);
                        if (now - lastDataIn < FILL_FOR_MS) {
                            long due = FILL_MS - (now - lastTx);
                            if (due <= 0) {
                                fill = true;
                                break;
                            }
                            wait = Math.min(wait, due);
                        }
                        lock.wait(Math.max(1, wait));
                    }
                    if (closed) return;
                }
                long now = System.currentTimeMillis();
                if (fill) {
                    f = FILL;
                } else if (f == null) {
                    if (now - lastRx > pingMs * 3) throw new IOException("btmux: link silent");
                    lastPing = now;
                    f = BtMux.encode(BtMux.PING, 0);
                }
                out.write(f);
                lastTx = now;
                synchronized (lock) {
                    idle = control.isEmpty() && ring.isEmpty();
                }
                // No I/O under the lock: a blocked flush must not stop the reader from taking credits.
                if (idle) out.flush();
            }
        } catch (IOException e) {
            closeWith(e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    // ---- stream lifecycle

    private Pipe pipe(long id) {
        synchronized (lock) {
            return pipes.get(id);
        }
    }

    /** Forgets a stream once both sides ended and its END frame has gone out. Holds lock. */
    private void maybeDone(Pipe p) {
        if (p.localEnded && p.remoteEnded && p.endSent && pipes.get(p.id) == p) {
            pipes.remove(p.id);
            quiet(p.sock);
        }
    }

    /** Aborts a stream: {@code remote} when the far side reset it (no RESET goes back). */
    private void drop(long id, boolean remote) {
        Pipe p;
        synchronized (lock) {
            p = pipes.remove(id);
            if (p == null) return;
            LOG.info("stream reset id=" + id + " byPeer=" + remote);
            if (!remote && !closed) {
                control.add(BtMux.encode(BtMux.RESET, id));
                lock.notifyAll();
            }
        }
        abortSocket(p);
    }

    private static void abortSocket(Pipe p) {
        p.inq.add(ABORT);
        synchronized (p) {
            p.notifyAll();
        }
        Socket s = p.sock;
        if (s == null) return;
        try {
            // An abort, not a half-close: the local end sees a reset, as on a dropped TCP connection.
            s.setSoLinger(true, 0);
        } catch (IOException ignored) {
        }
        quiet(s);
    }

    private static InetAddress loopback() {
        try {
            return InetAddress.getByAddress(new byte[] {127, 0, 0, 1});
        } catch (java.net.UnknownHostException e) {
            throw new IllegalStateException(e);
        }
    }

    private static void quiet(Closeable c) {
        if (c == null) return;
        try {
            c.close();
        } catch (IOException ignored) {
        }
    }

    private static void thread(Runnable r, String name) {
        Thread t = new Thread(r, name);
        t.setDaemon(true);
        t.start();
    }
}
