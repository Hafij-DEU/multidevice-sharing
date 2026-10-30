package io.github.hafijbge.meshdrop.engine.bt;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import org.junit.Test;

public class OpusRtpTest {
    /** Passes each unit through, so the framing can be checked without a real codec. */
    private static final class Same implements OpusRtp.Codec {
        boolean closed;

        @Override
        public List<byte[]> process(byte[] in) {
            return Collections.singletonList(in);
        }

        @Override
        public void close() {
            closed = true;
        }
    }

    private static List<byte[]> frames(byte[] rfc4571) throws IOException {
        DataInputStream in = new DataInputStream(new ByteArrayInputStream(rfc4571));
        List<byte[]> out = new ArrayList<>();
        for (byte[] p; (p = OpusRtp.readFrame(in)) != null; ) out.add(p);
        return out;
    }

    @Test
    public void contentTypesMatchThePc() {
        assertEquals("audio/opus-rtp; channels=2", OpusRtp.contentType(2));
        assertEquals("audio/opus-rtp; channels=1", OpusRtp.contentType(1));
        // stereo sound and a mono microphone go at the one rate from Settings
        assertEquals(8_000, OpusRtp.bitrate(8));
        assertEquals(32_000, OpusRtp.bitrate(32));
    }

    @Test
    public void pcmGoesOutIn20msFramesAsRtpAndComesBack() throws IOException {
        int frame = OpusRtp.FRAME_SAMPLES * 2 * 2;
        byte[] pcm = new byte[frame * 5 / 2];
        new java.util.Random(7).nextBytes(pcm);
        ByteArrayOutputStream wire = new ByteArrayOutputStream();
        Same enc = new Same();
        OutputStream o = OpusRtp.encoding(wire, enc, 2);
        o.write(pcm, 0, 100);
        o.write(pcm, 100, pcm.length - 100);
        o.close();
        assertTrue(enc.closed);

        List<byte[]> packets = frames(wire.toByteArray());
        assertEquals(2, packets.size()); // the half frame left over is not sent
        for (int i = 0; i < packets.size(); i++) {
            byte[] p = packets.get(i);
            assertEquals(0x80, p[0] & 0xff);
            assertEquals(OpusRtp.PT, p[1] & 0x7f);
            assertEquals(i == 0, (p[1] & 0x80) != 0); // marker on the first packet only
            assertEquals(frame, p.length - 12);
        }
        assertEquals((seq(packets.get(0)) + 1) & 0xffff, seq(packets.get(1)));
        assertEquals((timestamp(packets.get(0)) + 960) & 0xffffffffL, timestamp(packets.get(1)));

        Same dec = new Same();
        InputStream in = OpusRtp.decoding(new ByteArrayInputStream(wire.toByteArray()), dec);
        ByteArrayOutputStream back = new ByteArrayOutputStream();
        byte[] chunk = new byte[1000];
        for (int n; (n = in.read(chunk, 0, chunk.length)) != -1; ) back.write(chunk, 0, n);
        in.close();
        assertTrue(dec.closed);
        byte[] want = new byte[frame * 2];
        System.arraycopy(pcm, 0, want, 0, want.length);
        assertArrayEquals(want, back.toByteArray());
    }

    @Test
    public void dropsAFrameThatWouldQueueTooMuchAndKeepsTheClock() throws IOException {
        int frame = OpusRtp.FRAME_SAMPLES * 2; // mono
        long[] backlog = {0};
        ByteArrayOutputStream wire = new ByteArrayOutputStream();
        OutputStream o = OpusRtp.encoding(wire, new Same(), 1, () -> backlog[0], 3000);
        o.write(new byte[frame]);
        backlog[0] = 2000; // 2000 + a 1934-byte frame is over 3000: this one goes
        o.write(new byte[frame]);
        backlog[0] = 0;
        o.write(new byte[frame]);
        o.close();
        List<byte[]> packets = frames(wire.toByteArray());
        assertEquals(2, packets.size());
        assertEquals((seq(packets.get(0)) + 2) & 0xffff, seq(packets.get(1)));
        assertEquals((timestamp(packets.get(0)) + 2 * 960) & 0xffffffffL, timestamp(packets.get(1)));
        assertEquals(1000 + 2500, OpusRtp.liveBytes(8_000));
        assertEquals(4000 + 2500, OpusRtp.liveBytes(32_000));
    }

    @Test
    public void readsWhatGstreamerWrites() throws IOException {
        // 1 s of stereo sine through: opusenc frame-size=20 ! rtpopuspay pt=96 ! rtpstreampay
        byte[] wire;
        try (InputStream r = getClass().getResourceAsStream("/opus/gst-sine-stereo.rtp")) {
            assertNotNull(r);
            ByteArrayOutputStream all = new ByteArrayOutputStream();
            byte[] chunk = new byte[4096];
            for (int n; (n = r.read(chunk)) != -1; ) all.write(chunk, 0, n);
            wire = all.toByteArray();
        }
        List<byte[]> packets = frames(wire);
        assertTrue("about 50 packets, got " + packets.size(), packets.size() >= 48 && packets.size() <= 52);
        for (int i = 0; i < packets.size(); i++) {
            byte[] opus = OpusRtp.payload(packets.get(i));
            assertNotNull(opus);
            assertTrue(opus.length > 0);
            if (i >= 2) {
                assertEquals((seq(packets.get(i - 1)) + 1) & 0xffff, seq(packets.get(i)));
                assertEquals((timestamp(packets.get(i - 1)) + 960) & 0xffffffffL, timestamp(packets.get(i)));
            }
        }
    }

    @Test
    public void skipsCsrcsExtensionAndPaddingAndRejectsOtherPayloads() {
        byte[] p = {
            (byte) 0xb1, 96, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, // v2, padding, extension, 1 CSRC
            1, 2, 3, 4, // the CSRC
            0, 0, 0, 1, 9, 9, 9, 9, // the extension: 1 word
            42, 43, // the payload
            0, 0, 3, // 3 bytes of padding, the last one says how many
        };
        assertArrayEquals(new byte[] {42, 43}, OpusRtp.payload(p));
        byte[] other = OpusRtp.packet(1, 0, 0, false, new byte[] {1});
        other[1] = 0; // PT 0
        assertNull(OpusRtp.payload(other));
        assertNull(OpusRtp.payload(new byte[5]));
    }

    // RTP header fields (RFC 3550), read only by these tests.
    private static int seq(byte[] p) {
        return ((p[2] & 0xff) << 8) | (p[3] & 0xff);
    }

    private static long timestamp(byte[] p) {
        return ((long) (p[4] & 0xff) << 24) | ((p[5] & 0xff) << 16) | ((p[6] & 0xff) << 8) | (p[7] & 0xff);
    }
}
