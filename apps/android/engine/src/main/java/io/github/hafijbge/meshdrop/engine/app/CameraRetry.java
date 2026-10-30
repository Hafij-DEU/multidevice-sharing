package io.github.hafijbge.meshdrop.engine.app;

import java.io.FilterOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.util.function.BooleanSupplier;

/**
 * Keeps a webcam stream open while another app borrows the camera: face unlock takes it each time the
 * phone wakes, then gives it back a second or two later. The PC sees the last picture meanwhile.
 */
final class CameraRetry {
    private CameraRetry() {}

    interface Session {
        void run(OutputStream out) throws IOException;
    }

    /**
     * Runs `session` again after each {@link CameraTakenException}, `waitMs` apart, until `stop` says so;
     * gives up (rethrows) once the camera stayed away for `giveUpMs` with no frame sent.
     */
    static void keep(OutputStream out, BooleanSupplier stop, Session session, long giveUpMs, long waitMs) throws IOException {
        long[] sent = new long[1];
        OutputStream counted = new FilterOutputStream(out) {
            @Override
            public void write(byte[] b, int off, int len) throws IOException {
                out.write(b, off, len);
                sent[0] += len;
            }

            @Override
            public void write(int b) throws IOException {
                out.write(b);
                sent[0]++;
            }
        };
        long lost = System.currentTimeMillis();
        while (true) {
            long before = sent[0];
            try {
                session.run(counted);
                return;
            } catch (CameraTakenException x) {
                if (stop.getAsBoolean()) return;
                long now = System.currentTimeMillis();
                if (sent[0] > before) lost = now; // it streamed: the wait starts over
                if (now - lost >= giveUpMs) throw x;
                try {
                    Thread.sleep(waitMs);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return;
                }
                if (stop.getAsBoolean()) return;
            }
        }
    }
}
