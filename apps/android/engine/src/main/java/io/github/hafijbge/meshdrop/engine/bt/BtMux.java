package io.github.hafijbge.meshdrop.engine.bt;

import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;

/**
 * The btmux v1 frame codec (docs/protocol.md, Bluetooth links): {@code u8 type | u32 stream | u32 len |
 * payload}, big-endian, len <= 16384. Shared with the Node engine through protocol/vectors/btmux-v1.json.
 */
public final class BtMux {
    public static final int HELLO = 0, OPEN = 1, DATA = 2, END = 3, CREDIT = 4, PING = 5, PONG = 6, RESET = 7;
    public static final int MAX_PAYLOAD = 16 * 1024;
    /** DATA frames carry at most this much, so live sound interleaves with a running file transfer. */
    public static final int DATA_SLICE = 4 * 1024;
    /** Unacknowledged bytes a stream may have in flight before its sender pauses. */
    public static final int STREAM_WINDOW = 256 * 1024;
    static final int HEADER = 9;

    private BtMux() {}

    public static final class Frame {
        public final int type;
        /** Unsigned 32-bit stream id, held in a long so ids above 2^31 compare correctly. */
        public final long stream;
        public final byte[] payload;

        public Frame(int type, long stream, byte[] payload) {
            this.type = type;
            this.stream = stream;
            this.payload = payload;
        }
    }

    public static byte[] encode(int type, long stream, byte[] payload, int off, int len) {
        if (len > MAX_PAYLOAD) throw new IllegalArgumentException("btmux: payload too large");
        byte[] b = new byte[HEADER + len];
        b[0] = (byte) type;
        putU32(b, 1, stream);
        putU32(b, 5, len);
        System.arraycopy(payload, off, b, HEADER, len);
        return b;
    }

    public static byte[] encode(int type, long stream, byte[] payload) {
        return encode(type, stream, payload, 0, payload.length);
    }

    public static byte[] encode(int type, long stream) {
        return encode(type, stream, new byte[0], 0, 0);
    }

    /** Reads one frame; throws EOFException at a clean end and IOException on a malformed frame. */
    public static Frame read(DataInputStream in) throws IOException {
        int type = in.read();
        if (type < 0) throw new EOFException();
        long stream = in.readInt() & 0xffffffffL;
        long len = in.readInt() & 0xffffffffL;
        if (type > RESET) throw new IOException("btmux: unknown frame type " + type);
        if (len > MAX_PAYLOAD) throw new IOException("btmux: frame too large");
        byte[] p = new byte[(int) len];
        in.readFully(p);
        return new Frame(type, stream, p);
    }

    /** Push-style reader for tests and callers that get bytes in arbitrary pieces. */
    public static final class Reader {
        private final ByteArrayOutputStream pending = new ByteArrayOutputStream();

        public java.util.List<Frame> push(byte[] chunk) throws IOException {
            pending.write(chunk, 0, chunk.length);
            byte[] all = pending.toByteArray();
            java.util.List<Frame> out = new java.util.ArrayList<>();
            int at = 0;
            while (all.length - at >= HEADER) {
                int type = all[at] & 0xff;
                long len = u32(all, at + 5);
                if (type > RESET) throw new IOException("btmux: unknown frame type " + type);
                if (len > MAX_PAYLOAD) throw new IOException("btmux: frame too large");
                if (all.length - at < HEADER + len) break;
                byte[] p = new byte[(int) len];
                System.arraycopy(all, at + HEADER, p, 0, (int) len);
                out.add(new Frame(type, u32(all, at + 1), p));
                at += HEADER + (int) len;
            }
            pending.reset();
            pending.write(all, at, all.length - at);
            return out;
        }
    }

    static void putU32(byte[] b, int at, long v) {
        b[at] = (byte) (v >>> 24);
        b[at + 1] = (byte) (v >>> 16);
        b[at + 2] = (byte) (v >>> 8);
        b[at + 3] = (byte) v;
    }

    static long u32(byte[] b, int at) {
        return ((b[at] & 0xffL) << 24) | ((b[at + 1] & 0xffL) << 16) | ((b[at + 2] & 0xffL) << 8) | (b[at + 3] & 0xffL);
    }

    static DataInputStream data(InputStream in) {
        return in instanceof DataInputStream ? (DataInputStream) in : new DataInputStream(new java.io.BufferedInputStream(in, 32 * 1024));
    }
}
