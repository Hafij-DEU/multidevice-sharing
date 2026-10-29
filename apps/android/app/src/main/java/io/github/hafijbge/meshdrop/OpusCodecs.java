package io.github.hafijbge.meshdrop;

import android.media.MediaCodec;
import android.media.MediaCodecList;
import android.media.MediaFormat;
import io.github.hafijbge.meshdrop.engine.bt.OpusRtp;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.List;

/**
 * Opus through the system codecs (M14: sound over a Bluetooth link). Android has an Opus decoder
 * since 5.0 and an encoder since 10 (minSdk 29); a phone whose vendor dropped one gets
 * {@link OpusRtp#NO_CODEC} and Bluetooth sound is refused with that message.
 */
final class OpusCodecs {
    private static final String MIME = MediaFormat.MIMETYPE_AUDIO_OPUS;
    private static final int RATE = 48_000;
    /** The encoder's lookahead: 3.75 ms at 48 kHz (what libopus reports for 20 ms frames). */
    private static final int PRE_SKIP = 312;
    private static final long WAIT_US = 20_000;

    private OpusCodecs() {}

    static OpusRtp.Codec encoder(int channels, int bitrate) throws IOException {
        MediaFormat f = MediaFormat.createAudioFormat(MIME, RATE, channels);
        f.setInteger(MediaFormat.KEY_BIT_RATE, bitrate);
        f.setInteger(MediaFormat.KEY_PCM_ENCODING, android.media.AudioFormat.ENCODING_PCM_16BIT);
        return new Step(open(f, true), channels);
    }

    static OpusRtp.Codec decoder(int channels) throws IOException {
        MediaFormat f = MediaFormat.createAudioFormat(MIME, RATE, channels);
        f.setByteBuffer("csd-0", ByteBuffer.wrap(opusHead(channels)));
        f.setByteBuffer("csd-1", nanos(PRE_SKIP * 1_000_000_000L / RATE));
        f.setByteBuffer("csd-2", nanos(80_000_000L)); // seek pre-roll: 80 ms, as RFC 7845 says
        return new Step(open(f, false), channels);
    }

    private static MediaCodec open(MediaFormat f, boolean encode) throws IOException {
        MediaCodecList all = new MediaCodecList(MediaCodecList.REGULAR_CODECS);
        String name = encode ? all.findEncoderForFormat(f) : all.findDecoderForFormat(f);
        if (name == null) throw new IOException(OpusRtp.NO_CODEC);
        MediaCodec c = null;
        try {
            c = MediaCodec.createByCodecName(name);
            c.configure(f, null, null, encode ? MediaCodec.CONFIGURE_FLAG_ENCODE : 0);
            c.start();
            return c;
        } catch (IOException | RuntimeException e) {
            if (c != null) c.release();
            throw new IOException(OpusRtp.NO_CODEC, e);
        }
    }

    /** The RFC 7845 identification header the decoder takes as csd-0. */
    private static byte[] opusHead(int channels) {
        ByteBuffer h = ByteBuffer.allocate(19).order(ByteOrder.LITTLE_ENDIAN);
        h.put("OpusHead".getBytes(java.nio.charset.StandardCharsets.US_ASCII));
        h.put((byte) 1); // version
        h.put((byte) channels);
        h.putShort((short) PRE_SKIP);
        h.putInt(RATE);
        h.putShort((short) 0); // output gain
        h.put((byte) 0); // channel mapping family 0: mono or stereo
        return h.array();
    }

    private static ByteBuffer nanos(long ns) {
        ByteBuffer v = ByteBuffer.allocate(8).order(ByteOrder.LITTLE_ENDIAN);
        v.putLong(ns);
        v.rewind();
        return v;
    }

    /** One synchronous step through a started codec: queue the input, take what is ready. */
    private static final class Step implements OpusRtp.Codec {
        private final MediaCodec c;
        private final int bytesPerSample;
        private final MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
        private long samples;
        private boolean closed;

        Step(MediaCodec c, int channels) {
            this.c = c;
            this.bytesPerSample = 2 * channels;
        }

        @Override
        public synchronized List<byte[]> process(byte[] in) throws IOException {
            if (closed) throw new IOException("closed");
            List<byte[]> out = new ArrayList<>();
            try {
                int i = c.dequeueInputBuffer(WAIT_US);
                if (i >= 0) {
                    ByteBuffer ib = c.getInputBuffer(i);
                    int n = ib == null ? 0 : Math.min(in.length, ib.remaining());
                    if (ib != null) ib.put(in, 0, n);
                    c.queueInputBuffer(i, 0, n, samples * 1_000_000L / RATE, 0);
                    samples += OpusRtp.FRAME_SAMPLES; // a packet is 20 ms either way
                }
                // else the codec is behind: this unit is dropped, live sound stays live
                for (int o; (o = c.dequeueOutputBuffer(info, 0)) >= 0 || o == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED; ) {
                    if (o < 0) continue;
                    ByteBuffer ob = c.getOutputBuffer(o);
                    boolean config = (info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0; // the encoder's OpusHead: RTP has none
                    if (ob != null && info.size > 0 && !config) {
                        byte[] got = new byte[info.size];
                        ob.position(info.offset);
                        ob.get(got);
                        out.add(got);
                    }
                    c.releaseOutputBuffer(o, false);
                }
            } catch (IllegalStateException e) {
                throw new IOException("The Opus codec stopped.", e);
            }
            return out;
        }

        @Override
        public synchronized void close() {
            if (closed) return;
            closed = true;
            try {
                c.stop();
            } catch (RuntimeException ignored) {
                // already stopped
            }
            c.release();
        }
    }
}
