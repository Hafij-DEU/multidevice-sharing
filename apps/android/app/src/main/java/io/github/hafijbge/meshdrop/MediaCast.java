package io.github.hafijbge.meshdrop;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.graphics.ImageFormat;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.params.OutputConfiguration;
import android.hardware.camera2.params.SessionConfiguration;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioPlaybackCaptureConfiguration;
import android.media.AudioRecord;
import android.media.AudioTrack;
import android.media.Image;
import android.media.ImageReader;
import android.media.MediaRecorder;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Handler;
import android.os.HandlerThread;
import io.github.hafijbge.meshdrop.engine.app.CameraTakenException;
import io.github.hafijbge.meshdrop.engine.app.LiveTrim;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.util.Collections;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;

/**
 * M10b on the phone: plays a PC's sound (AudioTrack), and streams the front camera as JPEG frames and
 * the microphone as PCM to a PC, which shows them as a webcam and a microphone for video calls; and
 * what the phone plays (Android 10 playback capture, after the system's consent) to a PC's speakers.
 */
final class MediaCast {
    static final int RATE = 48_000;
    private static final int WIDTH = 1280;
    private static final int HEIGHT = 720;
    private static final int JPEG_QUALITY = 70;
    private final Context ctx;
    /** Kinds running now (counted: a restart's new session starts before the old one ends), for the service's foreground types. */
    private final java.util.Map<String, Integer> running = new java.util.concurrent.ConcurrentHashMap<>();
    /** The system's answer to "capture what plays" (SoundConsentActivity): {resultCode, data}. */
    private static final ArrayBlockingQueue<Object[]> ANSWERS = new ArrayBlockingQueue<>(1);
    private volatile MediaProjection projection;
    /** One camera session at a time: a new one waits until the last has really let the camera go. */
    private static final java.util.concurrent.Semaphore CAMERA = new java.util.concurrent.Semaphore(1);

    static void consent(int result, Intent data) {
        ANSWERS.clear();
        ANSWERS.offer(new Object[] {result, data});
    }

    MediaCast(Context ctx) {
        this.ctx = ctx;
    }

    private void need(String perm, String what) throws IOException {
        if (ctx.checkSelfPermission(perm) == PackageManager.PERMISSION_GRANTED) return;
        Activity a = MainActivity.current;
        if (a != null) a.runOnUiThread(() -> a.requestPermissions(new String[] {perm}, 11));
        throw new IOException("Allow MeshDrop to use the " + what + ", then tap again.");
    }

    void starting(String kind) throws IOException {
        if (kind.equals("camera")) need(Manifest.permission.CAMERA, "camera");
        if (kind.equals("mic") || kind.equals("sound")) need(Manifest.permission.RECORD_AUDIO, kind.equals("mic") ? "microphone" : "phone's sound (Android files it under the microphone)");
        if (!kind.equals("audio") && !MainActivity.resumed) throw new IOException("Open MeshDrop on the phone to start the camera, microphone or sound.");
        Object[] answer = kind.equals("sound") ? askToCapture() : null;
        running.merge(kind, 1, Integer::sum);
        applyTypes();
        if (answer != null) {
            // Android 14+: the service must run as mediaProjection (applyTypes) before the projection is made
            try {
                MediaProjection old = projection;
                if (old != null) old.stop(); // a restart: the last capture ends with it
                MediaProjection p = ctx.getSystemService(MediaProjectionManager.class).getMediaProjection((Integer) answer[0], (Intent) answer[1]);
                if (p == null) throw new IOException("Android did not allow capturing the sound.");
                p.registerCallback(new MediaProjection.Callback() {
                    @Override
                    public void onStop() {
                        if (projection == p) projection = null; // not a newer one that replaced it
                    }
                }, new Handler(ctx.getMainLooper()));
                projection = p;
            } catch (SecurityException | IllegalStateException e) {
                stopped(kind);
                throw new IOException("Android did not allow capturing the sound.");
            }
        }
    }

    /** Shows the system's "start capturing?" dialog and waits for the answer (a minute at most). */
    private Object[] askToCapture() throws IOException {
        ANSWERS.clear();
        Activity a = MainActivity.current;
        Intent i = new Intent(ctx, SoundConsentActivity.class);
        if (a != null) a.runOnUiThread(() -> a.startActivity(i));
        else ctx.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        try {
            Object[] r = ANSWERS.poll(60, TimeUnit.SECONDS);
            if (r == null || (Integer) r[0] != Activity.RESULT_OK || r[1] == null) throw new IOException("Sharing the phone's sound was not allowed.");
            return r;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IOException("Stopped.");
        }
    }

    void stopped(String kind) {
        running.computeIfPresent(kind, (k, n) -> n > 1 ? n - 1 : null);
        if (kind.equals("sound") && !running.containsKey("sound")) {
            MediaProjection p = projection;
            projection = null;
            if (p != null) p.stop();
        }
        applyTypes();
    }

    private void applyTypes() {
        int t = 0;
        if (running.containsKey("camera")) t |= ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA;
        if (running.containsKey("mic") || running.containsKey("sound")) t |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
        if (running.containsKey("sound")) t |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION;
        try {
            MeshService.setMediaTypes(t);
        } catch (RuntimeException ignored) {
            // not allowed now (in the background): the capture itself then fails and says so
        }
    }

    /** `pcAddress`: over Bluetooth, the PC's address, for {@link A2dpKeepAlive}; else null. */
    void play(InputStream in, BooleanSupplier stop, boolean bluetooth, String pcAddress) throws IOException {
        // live: once playing, sound queued beyond what the trim allows (a burst after a stall) is dropped,
        // or the stall's delay would last for the rest of the stream
        LiveTrim trim = bluetooth ? LiveTrim.bluetooth() : LiveTrim.lan();
        int min = AudioTrack.getMinBufferSize(RATE, AudioFormat.CHANNEL_OUT_STEREO, AudioFormat.ENCODING_PCM_16BIT);
        AudioTrack t = new AudioTrack.Builder()
                .setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build())
                .setAudioFormat(new AudioFormat.Builder().setSampleRate(RATE).setEncoding(AudioFormat.ENCODING_PCM_16BIT).setChannelMask(AudioFormat.CHANNEL_OUT_STEREO).build())
                .setBufferSizeInBytes(Math.max(min, (trim.highFrames() + RATE * 30 / 1000) * 4)) // a little over the most the trim keeps
                .setTransferMode(AudioTrack.MODE_STREAM)
                .build();
        java.util.logging.Logger log = java.util.logging.Logger.getLogger("MeshDropBt");
        A2dpKeepAlive keep = bluetooth && pcAddress != null ? new A2dpKeepAlive(ctx, pcAddress, t) : null;
        try {
            t.play();
            byte[] buf = new byte[4096];
            int carry = 0;
            int written = 0, lastHead = 0;
            long headMoved = -1000, received = 0, statsAt = android.os.SystemClock.uptimeMillis();
            while (!stop.getAsBoolean()) {
                int n = in.read(buf, carry, buf.length - carry);
                if (n < 0) break;
                n += carry;
                int whole = n - n % 4; // whole stereo frames only
                received += whole / 4;
                int from = 0;
                int head = t.getPlaybackHeadPosition();
                long now = android.os.SystemClock.uptimeMillis();
                if (head != lastHead) {
                    lastHead = head;
                    headMoved = now;
                }
                if (now - headMoved < 300) { // playing (a starting or refilling track must fill up first)
                    from = whole - trim.keep(whole / 4, Math.max(0, written - head)) * 4;
                }
                if (whole > from) {
                    int w = t.write(buf, from, whole - from);
                    if (w > 0) written += w / 4;
                }
                carry = n - whole;
                if (carry > 0) System.arraycopy(buf, whole, buf, 0, carry);
                if (bluetooth && now - statsAt >= 10_000) { // for tuning the link: how much came, was dropped, ran dry
                    statsAt = now;
                    log.info("sound over bt: received " + received * 1000 / RATE + " ms, dropped " + trim.dropped() * 1000 / RATE
                            + " ms, queued " + Math.max(0, written - head) * 1000 / RATE + " ms, underruns " + t.getUnderrunCount());
                }
            }
        } finally {
            if (bluetooth) log.info("sound over bt ended: dropped " + trim.dropped() * 1000 / RATE + " ms, underruns " + t.getUnderrunCount());
            if (keep != null) keep.close();
            t.stop();
            t.release();
        }
    }

    @android.annotation.SuppressLint("MissingPermission") // checked in starting()
    void mic(OutputStream out, BooleanSupplier stop) throws IOException {
        int min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        AudioRecord r = new AudioRecord(MediaRecorder.AudioSource.VOICE_COMMUNICATION, RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(min, RATE / 5));
        if (r.getState() != AudioRecord.STATE_INITIALIZED) {
            r.release();
            throw new IOException("The microphone is busy.");
        }
        try {
            r.startRecording();
            byte[] buf = new byte[RATE / 50 * 2]; // 20 ms
            while (!stop.getAsBoolean()) {
                int n = r.read(buf, 0, buf.length);
                if (n < 0) throw new IOException("microphone error " + n);
                out.write(buf, 0, n);
            }
        } finally {
            r.stop();
            r.release();
        }
    }

    /** What the phone plays (music, videos, games; apps that forbid capture stay silent) as s16le 48 kHz stereo. */
    @android.annotation.SuppressLint("MissingPermission") // checked in starting()
    void sound(OutputStream out, BooleanSupplier stop) throws IOException {
        MediaProjection p = projection;
        if (p == null) throw new IOException("Sharing the phone's sound was not allowed.");
        AudioPlaybackCaptureConfiguration cfg = new AudioPlaybackCaptureConfiguration.Builder(p)
                .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
                .addMatchingUsage(AudioAttributes.USAGE_GAME)
                .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
                .build();
        AudioFormat fmt = new AudioFormat.Builder().setSampleRate(RATE).setEncoding(AudioFormat.ENCODING_PCM_16BIT).setChannelMask(AudioFormat.CHANNEL_IN_STEREO).build();
        int min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_STEREO, AudioFormat.ENCODING_PCM_16BIT);
        AudioRecord r = new AudioRecord.Builder().setAudioPlaybackCaptureConfig(cfg).setAudioFormat(fmt).setBufferSizeInBytes(Math.max(min, RATE * 4 / 5)).build();
        if (r.getState() != AudioRecord.STATE_INITIALIZED) {
            r.release();
            throw new IOException("The phone's sound cannot be captured now.");
        }
        try {
            r.startRecording();
            byte[] buf = new byte[RATE / 50 * 4]; // 20 ms of stereo
            while (!stop.getAsBoolean() && projection != null) {
                int n = r.read(buf, 0, buf.length);
                if (n < 0) throw new IOException("sound capture error " + n);
                out.write(buf, 0, n);
            }
        } finally {
            r.stop();
            r.release();
        }
    }

    /**
     * The front camera (or the back one; the other if the phone lacks it) as JPEG frames; frames the
     * network cannot keep up with are dropped. Starting again right after a stop used to find the camera
     * still busy (closing is asynchronous): sessions now take turns.
     */
    void camera(OutputStream out, BooleanSupplier stop, boolean back) throws IOException {
        try {
            if (!CAMERA.tryAcquire(8, TimeUnit.SECONDS)) throw new IOException("The camera is still busy: tap again in a moment.");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IOException("Stopped.");
        }
        try {
            cameraSession(out, stop, back);
        } finally {
            try {
                Thread.sleep(400); // the camera service frees the device a moment after close()
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            CAMERA.release();
        }
    }

    @android.annotation.SuppressLint("MissingPermission") // checked in starting()
    private void cameraSession(OutputStream out, BooleanSupplier stop, boolean back) throws IOException {
        CameraManager cm = ctx.getSystemService(CameraManager.class);
        int want = back ? CameraCharacteristics.LENS_FACING_BACK : CameraCharacteristics.LENS_FACING_FRONT;
        String id = null;
        try {
            for (String c : cm.getCameraIdList()) {
                Integer f = cm.getCameraCharacteristics(c).get(CameraCharacteristics.LENS_FACING);
                if (id == null || (f != null && f == want)) id = c;
                if (f != null && f == want) break;
            }
        } catch (android.hardware.camera2.CameraAccessException e) {
            throw new IOException("The camera is not available.");
        }
        if (id == null) throw new IOException("This device has no camera.");
        HandlerThread ht = new HandlerThread("cast-camera");
        ht.start();
        Handler h = new Handler(ht.getLooper());
        ImageReader reader = ImageReader.newInstance(WIDTH, HEIGHT, ImageFormat.JPEG, 3);
        ArrayBlockingQueue<byte[]> frames = new ArrayBlockingQueue<>(2);
        reader.setOnImageAvailableListener(r -> {
            try (Image img = r.acquireLatestImage()) {
                if (img == null) return;
                ByteBuffer b = img.getPlanes()[0].getBuffer();
                byte[] jpeg = new byte[b.remaining()];
                b.get(jpeg);
                if (!frames.offer(jpeg)) {
                    frames.poll(); // drop the oldest: the PC sees the newest picture
                    frames.offer(jpeg);
                }
            } catch (RuntimeException ignored) {
                // a frame lost
            }
        }, h);
        CameraDevice[] dev = new CameraDevice[1];
        IOException[] fail = new IOException[1];
        java.util.concurrent.CountDownLatch opened = new java.util.concurrent.CountDownLatch(1);
        try {
            cm.openCamera(id, new CameraDevice.StateCallback() {
                @Override
                public void onOpened(CameraDevice d) {
                    dev[0] = d;
                    try {
                        CaptureRequest.Builder rb = d.createCaptureRequest(CameraDevice.TEMPLATE_RECORD);
                        rb.addTarget(reader.getSurface());
                        rb.set(CaptureRequest.JPEG_QUALITY, (byte) JPEG_QUALITY);
                        d.createCaptureSession(new SessionConfiguration(SessionConfiguration.SESSION_REGULAR,
                                Collections.singletonList(new OutputConfiguration(reader.getSurface())), ctx.getMainExecutor(),
                                new CameraCaptureSession.StateCallback() {
                                    @Override
                                    public void onConfigured(CameraCaptureSession s) {
                                        try {
                                            s.setRepeatingRequest(rb.build(), null, h);
                                        } catch (android.hardware.camera2.CameraAccessException | RuntimeException e) {
                                            fail[0] = new IOException("The camera stopped.");
                                        }
                                        opened.countDown();
                                    }

                                    @Override
                                    public void onConfigureFailed(CameraCaptureSession s) {
                                        fail[0] = new IOException("The camera could not start.");
                                        opened.countDown();
                                    }
                                }));
                    } catch (android.hardware.camera2.CameraAccessException | RuntimeException e) {
                        fail[0] = new IOException("The camera could not start.");
                        opened.countDown();
                    }
                }

                @Override
                public void onDisconnected(CameraDevice d) {
                    d.close();
                    fail[0] = new CameraTakenException(); // face unlock takes it when the phone wakes: tried again
                    opened.countDown();
                }

                @Override
                public void onError(CameraDevice d, int error) {
                    d.close();
                    fail[0] = error == ERROR_CAMERA_IN_USE || error == ERROR_MAX_CAMERAS_IN_USE
                            ? new CameraTakenException() : new IOException("The camera is not available (" + error + ").");
                    opened.countDown();
                }
            }, h);
            if (!opened.await(10, TimeUnit.SECONDS)) throw new IOException("The camera did not start.");
            if (fail[0] != null) throw fail[0];
            while (!stop.getAsBoolean() && fail[0] == null) {
                byte[] f = frames.poll(500, TimeUnit.MILLISECONDS);
                if (f != null) {
                    out.write(f);
                    out.flush();
                }
            }
            if (fail[0] != null) throw fail[0];
        } catch (android.hardware.camera2.CameraAccessException e) {
            int r = e.getReason();
            if (r == android.hardware.camera2.CameraAccessException.CAMERA_IN_USE || r == android.hardware.camera2.CameraAccessException.MAX_CAMERAS_IN_USE
                    || r == android.hardware.camera2.CameraAccessException.CAMERA_DISCONNECTED) throw new CameraTakenException();
            throw new IOException("The camera is not available.");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } finally {
            if (dev[0] != null) dev[0].close();
            reader.close();
            ht.quitSafely();
        }
    }
}
