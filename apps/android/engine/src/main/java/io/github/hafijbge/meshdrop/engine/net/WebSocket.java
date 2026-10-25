package io.github.hafijbge.meshdrop.engine.net;

import io.github.hafijbge.meshdrop.engine.util.B64;
import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Socket;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Locale;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * A minimal RFC 6455 client for the hub link: masked client frames, fragmented messages, 64-bit
 * lengths up to `maxMessage`, ping/pong and the close handshake. The caller opens the socket (plain
 * for ws:// on loopback, TLS otherwise); one reader thread delivers events to the Listener.
 */
public final class WebSocket {
    /** The hub's own frame limit (MAX_OFFER_BODY + 64 KiB): a relayed offer can be that large. */
    public static final int DEFAULT_MAX_MESSAGE = 64 * 1024 * 1024 + 64 * 1024;
    private static final String GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    private static final int OP_CONT = 0, OP_TEXT = 1, OP_BINARY = 2, OP_CLOSE = 8, OP_PING = 9, OP_PONG = 10;
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final ScheduledExecutorService TIMERS = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "ws-timers");
        t.setDaemon(true);
        return t;
    });

    public interface Listener {
        void onText(String text);

        void onBinary(byte[] data);

        /** Exactly once: the peer's close code (1005 if none), or 1006 when the connection just died. */
        void onClose(int code, String reason);

        default void onPong(byte[] data) {}
    }

    private static final class ProtocolError extends IOException {
        final int code;

        ProtocolError(int code, String m) {
            super(m);
            this.code = code;
        }
    }

    private final Socket socket;
    private final InputStream in;
    private final OutputStream out;
    private final Listener listener;
    private final int maxMessage;
    private final Object writeLock = new Object();
    private final AtomicBoolean closed = new AtomicBoolean();
    private volatile boolean closeSent;

    private WebSocket(Socket socket, InputStream in, OutputStream out, Listener listener, int maxMessage) {
        this.socket = socket;
        this.in = in;
        this.out = out;
        this.listener = listener;
        this.maxMessage = maxMessage;
    }

    /** Upgrades the connected socket (10 s for the handshake) and starts reading. */
    public static WebSocket connect(Socket s, String hostHeader, String path, Listener listener, int maxMessage) throws IOException {
        byte[] nonce = new byte[16];
        RANDOM.nextBytes(nonce);
        String key = B64.std(nonce);
        int oldTimeout = s.getSoTimeout();
        s.setSoTimeout(10_000);
        InputStream in = new BufferedInputStream(s.getInputStream(), 64 * 1024);
        OutputStream out = new BufferedOutputStream(s.getOutputStream(), 64 * 1024);
        String req = "GET " + path + " HTTP/1.1\r\nHost: " + hostHeader + "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                + "Sec-WebSocket-Key: " + key + "\r\nSec-WebSocket-Version: 13\r\n\r\n";
        out.write(req.getBytes(StandardCharsets.US_ASCII));
        out.flush();
        String head = readHead(in);
        String[] lines = head.split("\r\n");
        String[] status = lines[0].split(" ", 3);
        if (status.length < 2 || !status[0].startsWith("HTTP/1.1") || !status[1].equals("101")) {
            throw new IOException("websocket upgrade refused: " + lines[0]);
        }
        String accept = null;
        boolean upgrade = false;
        for (int i = 1; i < lines.length; i++) {
            int c = lines[i].indexOf(':');
            if (c <= 0) continue;
            String name = lines[i].substring(0, c).trim().toLowerCase(Locale.ROOT);
            String value = lines[i].substring(c + 1).trim();
            if (name.equals("sec-websocket-accept")) accept = value;
            if (name.equals("upgrade") && value.equalsIgnoreCase("websocket")) upgrade = true;
        }
        if (!upgrade || !expectedAccept(key).equals(accept)) throw new IOException("bad websocket upgrade response");
        s.setSoTimeout(oldTimeout);
        WebSocket ws = new WebSocket(s, in, out, listener, maxMessage);
        Thread t = new Thread(ws::readLoop, "ws-reader");
        t.setDaemon(true);
        t.start();
        return ws;
    }

    static String expectedAccept(String key) {
        try {
            return B64.std(MessageDigest.getInstance("SHA-1").digest((key + GUID).getBytes(StandardCharsets.US_ASCII)));
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    private static String readHead(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        int state = 0;
        while (state < 4) {
            int c = in.read();
            if (c < 0) throw new EOFException("connection closed during websocket upgrade");
            b.write(c);
            if (b.size() > 8192) throw new IOException("websocket upgrade response too long");
            state = (c == '\r' && (state == 0 || state == 2)) || (c == '\n' && (state == 1 || state == 3)) ? state + 1 : (c == '\r' ? 1 : 0);
        }
        return new String(b.toByteArray(), StandardCharsets.ISO_8859_1);
    }

    public void sendText(String text) throws IOException {
        send(OP_TEXT, text.getBytes(StandardCharsets.UTF_8));
    }

    public void sendBinary(byte[] data) throws IOException {
        send(OP_BINARY, data);
    }

    public void ping(byte[] data) throws IOException {
        if (data.length > 125) throw new IllegalArgumentException("ping payload > 125 bytes");
        send(OP_PING, data);
    }

    /** Starts the close handshake; the socket is dropped if the peer has not answered within 5 s. */
    public void close(int code, String reason) {
        if (closed.get()) return;
        try {
            sendClose(code, reason);
        } catch (IOException e) {
            abort();
            return;
        }
        TIMERS.schedule(this::abort, 5, TimeUnit.SECONDS);
    }

    /** Drops the connection now; the listener sees 1006 if it has not seen a close yet. */
    public void abort() {
        try {
            socket.close();
        } catch (IOException ignored) {
            // already closed
        }
        fireClose(1006, "");
    }

    private void sendClose(int code, String reason) throws IOException {
        byte[] r = reason.getBytes(StandardCharsets.UTF_8);
        byte[] p = new byte[2 + Math.min(r.length, 123)];
        p[0] = (byte) (code >> 8);
        p[1] = (byte) code;
        System.arraycopy(r, 0, p, 2, p.length - 2);
        synchronized (writeLock) {
            if (closeSent) return;
            closeSent = true;
            writeFrame(OP_CLOSE, p);
        }
    }

    private void send(int op, byte[] data) throws IOException {
        synchronized (writeLock) {
            if (closeSent || closed.get()) throw new IOException("websocket is closed");
            writeFrame(op, data);
        }
    }

    /** One final frame, masked (client to server). Caller holds writeLock. */
    private void writeFrame(int op, byte[] data) throws IOException {
        int n = data.length;
        byte[] head = new byte[14];
        int h = 0;
        head[h++] = (byte) (0x80 | op);
        if (n < 126) {
            head[h++] = (byte) (0x80 | n);
        } else if (n < 65536) {
            head[h++] = (byte) (0x80 | 126);
            head[h++] = (byte) (n >> 8);
            head[h++] = (byte) n;
        } else {
            head[h++] = (byte) (0x80 | 127);
            for (int i = 7; i >= 0; i--) head[h++] = (byte) (i >= 4 ? 0 : n >>> (8 * i));
        }
        byte[] mask = new byte[4];
        RANDOM.nextBytes(mask);
        System.arraycopy(mask, 0, head, h, 4);
        out.write(head, 0, h + 4);
        byte[] buf = new byte[Math.min(n, 64 * 1024)];
        for (int off = 0; off < n; off += buf.length) {
            int len = Math.min(buf.length, n - off);
            for (int i = 0; i < len; i++) buf[i] = (byte) (data[off + i] ^ mask[(off + i) & 3]);
            out.write(buf, 0, len);
        }
        out.flush();
    }

    private void fireClose(int code, String reason) {
        if (closed.compareAndSet(false, true)) {
            try {
                listener.onClose(code, reason);
            } catch (RuntimeException ignored) {
                // a listener bug must not kill the reader
            }
        }
    }

    private void readFully(byte[] b) throws IOException {
        for (int off = 0; off < b.length; ) {
            int r = in.read(b, off, b.length - off);
            if (r < 0) throw new EOFException();
            off += r;
        }
    }

    private int read1() throws IOException {
        int c = in.read();
        if (c < 0) throw new EOFException();
        return c;
    }

    private void readLoop() {
        ByteArrayOutputStream msg = null;
        int msgOp = 0;
        try {
            for (;;) {
                int b0 = read1();
                int b1 = read1();
                boolean fin = (b0 & 0x80) != 0;
                int op = b0 & 0x0f;
                if ((b0 & 0x70) != 0) throw new ProtocolError(1002, "reserved bits set");
                if ((b1 & 0x80) != 0) throw new ProtocolError(1002, "masked server frame");
                long len = b1 & 0x7f;
                if (len == 126) {
                    len = (read1() << 8) | read1();
                } else if (len == 127) {
                    len = 0;
                    for (int i = 0; i < 8; i++) len = (len << 8) | read1();
                    if (len < 0) throw new ProtocolError(1002, "bad length");
                }
                if (op >= 8) {
                    if (!fin || len > 125) throw new ProtocolError(1002, "bad control frame");
                    byte[] p = new byte[(int) len];
                    readFully(p);
                    if (op == OP_PING) {
                        synchronized (writeLock) {
                            if (!closeSent) writeFrame(OP_PONG, p);
                        }
                    } else if (op == OP_PONG) {
                        listener.onPong(p);
                    } else if (op == OP_CLOSE) {
                        onCloseFrame(p);
                        return;
                    } else {
                        throw new ProtocolError(1002, "unknown opcode");
                    }
                    continue;
                }
                if (op == OP_CONT) {
                    if (msg == null) throw new ProtocolError(1002, "unexpected continuation");
                } else if (op == OP_TEXT || op == OP_BINARY) {
                    if (msg != null) throw new ProtocolError(1002, "expected continuation");
                    msg = new ByteArrayOutputStream();
                    msgOp = op;
                } else {
                    throw new ProtocolError(1002, "unknown opcode");
                }
                if (msg.size() + len > maxMessage) throw new ProtocolError(1009, "message too big");
                byte[] p = new byte[(int) len];
                readFully(p);
                msg.write(p, 0, p.length);
                if (!fin) continue;
                byte[] data = msg.toByteArray();
                msg = null;
                if (msgOp == OP_TEXT) listener.onText(utf8(data));
                else listener.onBinary(data);
            }
        } catch (ProtocolError e) {
            failWith(e.code, e.getMessage());
        } catch (IOException | RuntimeException e) {
            abort();
        }
    }

    private static String utf8(byte[] b) throws ProtocolError {
        try {
            return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(b)).toString();
        } catch (CharacterCodingException e) {
            throw new ProtocolError(1007, "invalid utf-8");
        }
    }

    private void onCloseFrame(byte[] p) throws IOException {
        int code = 1005;
        String reason = "";
        if (p.length == 1) throw new ProtocolError(1002, "bad close frame");
        if (p.length >= 2) {
            code = ((p[0] & 0xff) << 8) | (p[1] & 0xff);
            byte[] r = new byte[p.length - 2];
            System.arraycopy(p, 2, r, 0, r.length);
            reason = utf8(r);
        }
        if (!closeSent) {
            try {
                if (code == 1005) sendClose(1000, "");
                else sendClose(code, reason);
            } catch (IOException ignored) {
                // the peer is going away anyway
            }
        }
        try {
            socket.close();
        } catch (IOException ignored) {
            // closed
        }
        fireClose(code, reason);
    }

    /** We fail the connection: tell the peer why, drain until it closes (a reset would lose the code). */
    private void failWith(int code, String reason) {
        fireClose(code, reason);
        try {
            sendClose(code, reason);
            socket.setSoTimeout(2000);
            byte[] sink = new byte[64 * 1024];
            while (in.read(sink) >= 0) {
                // discard until the peer's close
            }
        } catch (IOException ignored) {
            // timed out or reset
        }
        try {
            socket.close();
        } catch (IOException ignored) {
            // closed
        }
    }
}
