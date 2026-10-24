package io.github.hafijbge.meshdrop;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.ImageFormat;
import android.graphics.SurfaceTexture;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CaptureRequest;
import android.media.Image;
import android.media.ImageReader;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.view.Gravity;
import android.view.Surface;
import android.view.TextureView;
import android.widget.FrameLayout;
import android.widget.TextView;
import com.google.zxing.BarcodeFormat;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.DecodeHintType;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.Result;
import com.google.zxing.common.HybridBinarizer;
import com.google.zxing.qrcode.QRCodeReader;
import java.nio.ByteBuffer;
import java.util.Arrays;
import java.util.EnumMap;
import java.util.Map;

/** Scans a QR code with the back camera (Camera2 + ZXing) and returns its text as EXTRA_TEXT. */
public final class ScannerActivity extends Activity {
    static final String EXTRA_TEXT = "text";
    private static final int ASK_CAMERA = 9;
    private static final int W = 1280;
    private static final int H = 720;

    private TextureView preview;
    private HandlerThread thread;
    private Handler handler;
    private CameraDevice camera;
    private CameraCaptureSession session;
    private ImageReader reader;
    private final QRCodeReader qr = new QRCodeReader();
    private final Map<DecodeHintType, Object> hints = new EnumMap<>(DecodeHintType.class);
    private volatile boolean done;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        hints.put(DecodeHintType.POSSIBLE_FORMATS, Arrays.asList(BarcodeFormat.QR_CODE));
        hints.put(DecodeHintType.TRY_HARDER, Boolean.TRUE);
        FrameLayout root = new FrameLayout(this);
        preview = new TextureView(this);
        root.addView(preview, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        TextView hint = new TextView(this);
        hint.setText("Point at the QR code on your PC (MeshDrop → Mesh → Invite a device)");
        hint.setTextColor(0xffffffff);
        hint.setBackgroundColor(0x99000000);
        hint.setPadding(32, 24, 32, 24);
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM);
        root.addView(hint, lp);
        setContentView(root);
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] {Manifest.permission.CAMERA}, ASK_CAMERA);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        if (requestCode != ASK_CAMERA) return;
        if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) startWhenReady();
        else finish();
    }

    @Override
    protected void onResume() {
        super.onResume();
        thread = new HandlerThread("qr-scan");
        thread.start();
        handler = new Handler(thread.getLooper());
        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) startWhenReady();
    }

    @Override
    protected void onPause() {
        stopCamera();
        if (thread != null) thread.quitSafely();
        thread = null;
        super.onPause();
    }

    private void startWhenReady() {
        if (preview.isAvailable()) {
            openCamera();
            return;
        }
        preview.setSurfaceTextureListener(new TextureView.SurfaceTextureListener() {
            @Override
            public void onSurfaceTextureAvailable(SurfaceTexture s, int w, int h) {
                openCamera();
            }

            @Override
            public void onSurfaceTextureSizeChanged(SurfaceTexture s, int w, int h) {}

            @Override
            public boolean onSurfaceTextureDestroyed(SurfaceTexture s) {
                return true;
            }

            @Override
            public void onSurfaceTextureUpdated(SurfaceTexture s) {}
        });
    }

    private void openCamera() {
        if (camera != null || handler == null) return;
        CameraManager cm = getSystemService(CameraManager.class);
        try {
            String id = null;
            for (String c : cm.getCameraIdList()) {
                Integer facing = cm.getCameraCharacteristics(c).get(CameraCharacteristics.LENS_FACING);
                if (facing != null && facing == CameraCharacteristics.LENS_FACING_BACK) {
                    id = c;
                    break;
                }
            }
            if (id == null && cm.getCameraIdList().length > 0) id = cm.getCameraIdList()[0];
            if (id == null) {
                finish();
                return;
            }
            reader = ImageReader.newInstance(W, H, ImageFormat.YUV_420_888, 2);
            reader.setOnImageAvailableListener(this::onFrame, handler);
            cm.openCamera(id, new CameraDevice.StateCallback() {
                @Override
                public void onOpened(CameraDevice d) {
                    camera = d;
                    startSession();
                }

                @Override
                public void onDisconnected(CameraDevice d) {
                    d.close();
                    camera = null;
                }

                @Override
                public void onError(CameraDevice d, int error) {
                    d.close();
                    camera = null;
                    finish();
                }
            }, handler);
        } catch (CameraAccessException | SecurityException e) {
            finish();
        }
    }

    @SuppressWarnings("deprecation") // the SessionConfiguration overload is API 28+, fine, but this one keeps the code short
    private void startSession() {
        try {
            SurfaceTexture st = preview.getSurfaceTexture();
            st.setDefaultBufferSize(W, H);
            Surface view = new Surface(st);
            CaptureRequest.Builder b = camera.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW);
            b.addTarget(view);
            b.addTarget(reader.getSurface());
            b.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE);
            camera.createCaptureSession(Arrays.asList(view, reader.getSurface()), new CameraCaptureSession.StateCallback() {
                @Override
                public void onConfigured(CameraCaptureSession s) {
                    session = s;
                    try {
                        s.setRepeatingRequest(b.build(), null, handler);
                    } catch (CameraAccessException | IllegalStateException e) {
                        finish();
                    }
                }

                @Override
                public void onConfigureFailed(CameraCaptureSession s) {
                    finish();
                }
            }, handler);
        } catch (CameraAccessException | IllegalStateException e) {
            finish();
        }
    }

    private void onFrame(ImageReader r) {
        Image img = r.acquireLatestImage();
        if (img == null) return;
        try {
            if (done) return;
            Image.Plane y = img.getPlanes()[0];
            ByteBuffer buf = y.getBuffer();
            int rowStride = y.getRowStride();
            int w = img.getWidth();
            int h = img.getHeight();
            byte[] data = new byte[rowStride * h];
            buf.get(data, 0, Math.min(data.length, buf.remaining()));
            PlanarYUVLuminanceSource src = new PlanarYUVLuminanceSource(data, rowStride, h, 0, 0, w, h, false);
            Result res;
            try {
                res = qr.decode(new BinaryBitmap(new HybridBinarizer(src)), hints);
            } catch (Exception notYet) {
                return;
            } finally {
                qr.reset();
            }
            done = true;
            String text = res.getText();
            runOnUiThread(() -> {
                setResult(RESULT_OK, new Intent().putExtra(EXTRA_TEXT, text));
                finish();
            });
        } finally {
            img.close();
        }
    }

    private void stopCamera() {
        if (session != null) session.close();
        session = null;
        if (camera != null) camera.close();
        camera = null;
        if (reader != null) reader.close();
        reader = null;
    }
}
