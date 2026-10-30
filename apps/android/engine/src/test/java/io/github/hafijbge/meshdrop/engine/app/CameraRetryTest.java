package io.github.hafijbge.meshdrop.engine.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Test;

public class CameraRetryTest {
    @Test
    public void reopensTheCameraAfterFaceUnlockTakesIt() throws IOException {
        // face unlock evicts the webcam when the phone wakes, then gives the camera back
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        AtomicInteger runs = new AtomicInteger();
        CameraRetry.keep(out, () -> false, o -> {
            int n = runs.incrementAndGet();
            o.write(("frame" + n).getBytes());
            if (n < 3) throw new CameraTakenException();
        }, 10_000, 1);
        assertEquals(3, runs.get());
        assertEquals("frame1frame2frame3", out.toString());
    }

    @Test
    public void waitsWhileTheCameraIsBusy() throws IOException {
        // still held by another app: opening fails without a frame, a few times in a row
        AtomicInteger runs = new AtomicInteger();
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        CameraRetry.keep(out, () -> false, o -> {
            if (runs.incrementAndGet() < 4) throw new CameraTakenException();
            o.write(1);
        }, 10_000, 1);
        assertEquals(4, runs.get());
        assertEquals(1, out.size());
    }

    @Test
    public void givesUpWhenTheCameraNeverComesBack() {
        AtomicInteger runs = new AtomicInteger();
        long start = System.currentTimeMillis();
        try {
            CameraRetry.keep(new ByteArrayOutputStream(), () -> false, o -> {
                runs.incrementAndGet();
                throw new CameraTakenException();
            }, 200, 20);
            fail("kept waiting");
        } catch (CameraTakenException expected) {
            // the stream ends with what happened
        } catch (IOException e) {
            fail(e.toString());
        }
        assertTrue(runs.get() > 1);
        assertTrue(System.currentTimeMillis() - start < 2_000);
    }

    @Test
    public void stopsRetryingOnceTheStreamIsStopped() throws IOException {
        AtomicInteger runs = new AtomicInteger();
        CameraRetry.keep(new ByteArrayOutputStream(), () -> runs.get() >= 2, o -> {
            runs.incrementAndGet();
            throw new CameraTakenException();
        }, 10_000, 1);
        assertEquals(2, runs.get());
    }

    @Test
    public void otherFailuresEndTheStream() {
        AtomicInteger runs = new AtomicInteger();
        try {
            CameraRetry.keep(new ByteArrayOutputStream(), () -> false, o -> {
                runs.incrementAndGet();
                throw new IOException("This device has no camera.");
            }, 10_000, 1);
            fail("retried");
        } catch (IOException e) {
            assertEquals("This device has no camera.", e.getMessage());
        }
        assertEquals(1, runs.get());
    }
}
