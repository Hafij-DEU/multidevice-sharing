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
    /** Kinds running now, for the service's foreground types. */
    private final java.util.Set<String> running = java.util.concurrent.ConcurrentHashMap.newKeySet();
    /** The system's answer to "capture what plays" (SoundConsentActivity): {resultCode, data}. */
    private static final ArrayBlockingQueue<Object[]> ANSWERS = new ArrayBlockingQueue<>(1);
    private volatile MediaProjection projection;

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
        running.add(kind);
        applyTypes();
        if (answer != null) {
            // Android 14+: the service must run as mediaProjection (applyTypes) before the projection is made
            try {
                MediaProjection p = ctx.getSystemService(MediaProjectionManager.class).getMediaProjection((Integer) answer[0], (Intent) answer[1]);
                if (p == null) throw new IOException("Android did not allow capturing the sound.");
                p.registerCallback(new MediaProjection.Callback() {
                    @Override
                    public void onStop() {
                        projection = null;
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
        running.remove(kind);
        if (kind.equals("sound")) {
            MediaProjection p = projection;
            projection = null;
            if (p != null) p.stop();
        }
        applyTypes();
    }

    private void applyTypes() {
        int t = 0;
        if (running.contains("camera")) t |= ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA;
        if (running.contains("mic") || running.contains("sound")) t |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
        if (running.contains("sound")) t |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION;
        try {
            MeshService.setMediaTypes(t);
        } catch (RuntimeException ignored) {
            // not allowed now (in the background): the capture itself then fails and says so
        }
    }

    void play(InputStream in, BooleanSupplier stop) throws IOException {
        int min = AudioTrack.getMinBufferSize(RATE, AudioFormat.CHANNEL_OUT_STEREO, AudioFormat.ENCODING_PCM_16BIT);
        AudioTrack t = new AudioTrack.Builder()
                .setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build())
                .setAudioFormat(new AudioFormat.Builder().setSampleRate(RATE).setEncoding(AudioFormat.ENCODING_PCM_16BIT).setChannelMask(AudioFormat.CHANNEL_OUT_STEREO).build())
                .setBufferSizeInBytes(Math.max(min, RATE * 4 / 5)) // 200 ms
                .setTransferMode(AudioTrack.MODE_STREAM)
                .build();
        try {
            t.play();
            byte[] buf = new byte[4096];
            int carry = 0;
            while (!stop.getAsBoolean()) {
                int n = in.read(buf, carry, buf.length - carry);
                if (n < 0) break;
                n += carry;
                int whole = n - n % 4; // whole stereo frames only
                if (whole > 0) t.write(buf, 0, whole);
                carry = n - whole;
                if (carry > 0) System.arraycopy(buf, whole, buf, 0, carry);
            }
        } finally {
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

    /** The front camera (the back one if there is none) as JPEG frames; frames the network cannot keep up with are dropped. */
    @android.annotation.SuppressLint("MissingPermission") // checked in starting()
    void camera(OutputStream out, BooleanSupplier stop) throws IOException {
        CameraManager cm = ctx.getSystemService(CameraManager.class);
        String id = null;
        try {
            for (String c : cm.getCameraIdList()) {
                Integer f = cm.getCameraCharacteristics(c).get(CameraCharacteristics.LENS_FACING);
                if (id == null || (f != null && f == CameraCharacteristics.LENS_FACING_FRONT)) id = c;
                if (f != null && f == CameraCharacteristics.LENS_FACING_FRONT) break;
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
                    fail[0] = new IOException("Another app took the camera.");
                    opened.countDown();
                }

                @Override
                public void onError(CameraDevice d, int error) {
                    d.close();
                    fail[0] = new IOException("The camera is not available (" + error + ").");
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
