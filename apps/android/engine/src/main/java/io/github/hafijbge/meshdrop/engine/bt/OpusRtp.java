package io.github.hafijbge.meshdrop.engine.bt;

import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.List;

/**
 * Live sound over a Bluetooth link (M14). Raw PCM (192 kB/s stereo) does not fit an RFCOMM link, so
 * sound there goes as Opus in RTP, framed per RFC 4571 (u16 length + RTP packet; payload type 96,
 * 48 kHz clock, 20 ms frames): the same stream the PC's GStreamer reads and writes. The codec is the
 * platform's (MediaCodec on the phone); this class cuts PCM into frames and does the RTP.
 */
public final class OpusRtp {
    public static final int PT = 96;
    /** 20 ms at 48 kHz. */
    public static final int FRAME_SAMPLES = 960;
    public static final String NO_CODEC = "Sound over Bluetooth needs an Opus codec, which this device does not have.";

    private OpusRtp() {}

    public static String contentType(int channels) {
        return "audio/opus-rtp; channels=" + channels;
    }

    /** Bit rates from the design: stereo sound 96 kbit/s, a mono microphone 32 kbit/s. */
    public static int bitrate(int channels) {
        return channels == 2 ? 96_000 : 32_000;
    }

    /** A codec step: one unit in, whatever the codec has ready out (codecs lag a frame or two). */
    public interface Codec extends java.io.Closeable {
        /** Encoder: 20 ms of s16le 48 kHz PCM in, Opus packets out. Decoder: one Opus packet in, s16le PCM out. */
        List<byte[]> process(byte[] in) throws IOException;

        @Override
        void close();
    }

    /** PCM (s16le 48 kHz, `channels`) written here goes to `rtp` as RFC 4571 Opus RTP. Closing closes both. */
    public static OutputStream encoding(OutputStream rtp, Codec enc, int channels) {
        return new Encoding(rtp, enc, channels);
    }

    /** RFC 4571 Opus RTP from `rtp`, read back as s16le PCM. Closing closes both. */
    public static InputStream decoding(InputStream rtp, Codec dec) {
        return new Decoding(rtp, dec);
    }

    /** An RTP v2 packet: 12-byte header, no CSRCs or extension. */
    static byte[] packet(int seq, long ts, int ssrc, boolean marker, byte[] payload) {
        byte[] p = new byte[12 + payload.length];
        p[0] = (byte) 0x80;
        p[1] = (byte) ((marker ? 0x80 : 0) | PT);
        p[2] = (byte) (seq >> 8);
        p[3] = (byte) seq;
        for (int i = 0; i < 4; i++) p[4 + i] = (byte) (ts >> (24 - 8 * i));
        for (int i = 0; i < 4; i++) p[8 + i] = (byte) (ssrc >> (24 - 8 * i));
        System.arraycopy(payload, 0, p, 12, payload.length);
        return p;
    }

    /** One RFC 4571 frame (the RTP packet), or null at a clean end of the stream. */
    static byte[] readFrame(DataInputStream in) throws IOException {
        int hi = in.read();
        if (hi < 0) return null;
        int lo = in.read();
        if (lo < 0) throw new EOFException();
        byte[] p = new byte[(hi << 8) | lo];
        in.readFully(p);
        return p;
    }

    /** The Opus payload of an RTP packet (past CSRCs, extension and padding), or null for anything else. */
    static byte[] payload(byte[] p) {
        if (p.length < 12 || (p[0] & 0xc0) != 0x80 || (p[1] & 0x7f) != PT) return null;
        int off = 12 + 4 * (p[0] & 0x0f);
        if ((p[0] & 0x10) != 0) {
            if (p.length < off + 4) return null;
            off += 4 + 4 * (((p[off + 2] & 0xff) << 8) | (p[off + 3] & 0xff));
        }
        int end = p.length;
        if ((p[0] & 0x20) != 0 && end > 0) end -= p[end - 1] & 0xff;
        if (end <= off) return null;
        byte[] out = new byte[end - off];
        System.arraycopy(p, off, out, 0, out.length);
        return out;
    }

    static int seq(byte[] p) {
        return ((p[2] & 0xff) << 8) | (p[3] & 0xff);
    }

    static long timestamp(byte[] p) {
        return ((long) (p[4] & 0xff) << 24) | ((p[5] & 0xff) << 16) | ((p[6] & 0xff) << 8) | (p[7] & 0xff);
    }

    private static final class Encoding extends OutputStream {
        private final OutputStream rtp;
        private final Codec enc;
        private final byte[] frame;
        private final int ssrc = java.util.concurrent.ThreadLocalRandom.current().nextInt();
        private int fill;
        private int seq = java.util.concurrent.ThreadLocalRandom.current().nextInt(0x10000);
        private long ts = java.util.concurrent.ThreadLocalRandom.current().nextInt() & 0xffffffffL;
        private boolean first = true;

        Encoding(OutputStream rtp, Codec enc, int channels) {
            this.rtp = rtp;
            this.enc = enc;
            this.frame = new byte[FRAME_SAMPLES * 2 * channels];
        }

        @Override
        public void write(int b) throws IOException {
            write(new byte[] {(byte) b}, 0, 1);
        }

        @Override
        public void write(byte[] b, int off, int len) throws IOException {
            while (len > 0) {
                int n = Math.min(len, frame.length - fill);
                System.arraycopy(b, off, frame, fill, n);
                fill += n;
                off += n;
                len -= n;
                if (fill == frame.length) {
                    fill = 0;
                    for (byte[] opus : enc.process(frame.clone())) send(opus);
                }
            }
        }

        private void send(byte[] opus) throws IOException {
            byte[] p = packet(seq, ts, ssrc, first, opus);
            first = false;
            seq = (seq + 1) & 0xffff;
            ts = (ts + FRAME_SAMPLES) & 0xffffffffL;
            byte[] f = new byte[2 + p.length];
            f[0] = (byte) (p.length >> 8);
            f[1] = (byte) p.length;
            System.arraycopy(p, 0, f, 2, p.length);
            rtp.write(f); // one write per packet: the link sends it as one piece
        }

        @Override
        public void flush() throws IOException {
            rtp.flush();
        }

        @Override
        public void close() throws IOException {
            enc.close();
            rtp.close();
        }
    }

    private static final class Decoding extends InputStream {
        private final DataInputStream rtp;
        private final Codec dec;
        private byte[] pcm = new byte[0];
        private int pos;

        Decoding(InputStream rtp, Codec dec) {
            this.rtp = new DataInputStream(rtp);
            this.dec = dec;
        }

        /** False at the end of the stream. */
        private boolean more() throws IOException {
            while (pos >= pcm.length) {
                byte[] p = readFrame(rtp);
                if (p == null) return false;
                byte[] opus = payload(p);
                if (opus == null) continue;
                List<byte[]> out = dec.process(opus);
                if (out.size() == 1) {
                    pcm = out.get(0);
                } else {
                    ByteArrayOutputStream all = new ByteArrayOutputStream();
                    for (byte[] o : out) all.write(o, 0, o.length);
                    pcm = all.toByteArray();
                }
                pos = 0;
            }
            return true;
        }

        @Override
        public int read() throws IOException {
            return more() ? pcm[pos++] & 0xff : -1;
        }

        @Override
        public int read(byte[] b, int off, int len) throws IOException {
            if (len == 0) return 0;
            if (!more()) return -1;
            int n = Math.min(len, pcm.length - pos);
            System.arraycopy(pcm, pos, b, off, n);
            pos += n;
            return n;
        }

        @Override
        public int available() {
            return pcm.length - pos;
        }

        @Override
        public void close() throws IOException {
            dec.close();
            rtp.close();
        }
    }
}
