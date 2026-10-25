package io.github.hafijbge.meshdrop;

import android.app.Activity;
import android.content.Intent;
import io.github.hafijbge.meshdrop.engine.app.AppController;
import android.os.Bundle;
import android.webkit.WebView;
import java.io.IOException;

/** The main window: the shared UI in a WebView, plus "Share → MeshDrop". */
public final class MainActivity extends Activity {
    /** The UI is in front (Android lets an app open a page by itself only then). */
    static volatile boolean resumed;
    /** The activity in front (permission prompts from the app layer), or null. */
    static volatile android.app.Activity current;

    private WebView web;
    private Bridge bridge;
    private Pickers pickers;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        Core core = ((MeshApp) getApplication()).core();
        new Thread(() -> {
            try {
                core.ensureStarted();
                core.controller.refresh();
            } catch (IOException e) {
                // the UI shows "Starting…" and retries through getState
            }
        }, "meshdrop-start").start();
        MeshService.start(this);
        if (android.os.Build.VERSION.SDK_INT >= 33 && checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] {android.Manifest.permission.POST_NOTIFICATIONS}, 7);
        }
        pickers = new Pickers(this, core.platform);
        bridge = new Bridge(this, core, pickers);
        web = WebUi.create(this, bridge, null);
        // Edge-to-edge (Android 15+, some ROMs earlier): keep the page out from under the status bar,
        // the gesture bar and a camera cutout.
        android.widget.FrameLayout root = new android.widget.FrameLayout(this);
        root.addView(web);
        root.setOnApplyWindowInsetsListener((v, in) -> {
            int l, t, r, b;
            if (android.os.Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets i = in.getInsets(android.view.WindowInsets.Type.systemBars() | android.view.WindowInsets.Type.displayCutout());
                l = i.left;
                t = i.top;
                r = i.right;
                b = i.bottom;
            } else {
                l = in.getSystemWindowInsetLeft();
                t = in.getSystemWindowInsetTop();
                r = in.getSystemWindowInsetRight();
                b = in.getSystemWindowInsetBottom();
            }
            v.setPadding(l, t, r, b);
            return in;
        });
        setContentView(root);
        handleShare(getIntent());
    }

    /** Back steps back inside the page first; on its first page the app goes to the background (it keeps receiving). */
    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (web == null) {
            super.onBackPressed();
            return;
        }
        web.evaluateJavascript("(window.__mdBack && window.__mdBack()) ? 'y' : 'n'", r -> {
            if (!"\"y\"".equals(r)) moveTaskToBack(true);
        });
    }

    @Override
    protected void onResume() {
        super.onResume();
        resumed = true;
        current = this;
        AppController c = ((MeshApp) getApplication()).core().controller;
        c.refresh(); // a keep-alive step may have changed
        c.setForeground(true);
        android.hardware.SensorManager sm = getSystemService(android.hardware.SensorManager.class);
        android.hardware.Sensor acc = sm == null ? null : sm.getDefaultSensor(android.hardware.Sensor.TYPE_ACCELEROMETER);
        if (acc != null) sm.registerListener(shake, acc, android.hardware.SensorManager.SENSOR_DELAY_UI);
    }

    /** M11: shake the phone (while MeshDrop is open) to grab what is copied on the PC. */
    private final android.hardware.SensorEventListener shake = new android.hardware.SensorEventListener() {
        private long firstAt;
        private long lastGrab;

        @Override
        public void onSensorChanged(android.hardware.SensorEvent e) {
            float x = e.values[0], y = e.values[1], z = e.values[2];
            double g = Math.sqrt(x * x + y * y + z * z) / android.hardware.SensorManager.GRAVITY_EARTH;
            if (g < 2.7) return;
            long now = System.currentTimeMillis();
            if (now - firstAt > 700) {
                firstAt = now; // the first jolt; a second one soon after is a shake
                return;
            }
            if (now - lastGrab < 3000) return;
            lastGrab = now;
            AppController c = ((MeshApp) getApplication()).core().controller;
            new Thread(() -> {
                String msg = c.grabClipboard();
                runOnUiThread(() -> android.widget.Toast.makeText(MainActivity.this, msg, android.widget.Toast.LENGTH_SHORT).show());
            }, "shake-grab").start();
        }

        @Override
        public void onAccuracyChanged(android.hardware.Sensor s, int accuracy) {}
    };

    @Override
    protected void onPause() {
        android.hardware.SensorManager sm = getSystemService(android.hardware.SensorManager.class);
        if (sm != null) sm.unregisterListener(shake);
        resumed = false;
        if (current == this) current = null;
        ((MeshApp) getApplication()).core().controller.setForeground(false);
        super.onPause();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleShare(intent);
    }

    private void handleShare(Intent intent) {
        ((MeshApp) getApplication()).core().platform.acceptShare(this, intent);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (!pickers.onResult(requestCode, resultCode, data)) super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    protected void onDestroy() {
        bridge.destroy();
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
