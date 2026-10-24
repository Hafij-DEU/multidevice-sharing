package io.github.hafijbge.meshdrop;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.webkit.WebView;
import java.io.IOException;

/** The main window: the shared UI in a WebView, plus "Share → MeshDrop". */
public final class MainActivity extends Activity {
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
        ((MeshApp) getApplication()).core().controller.refresh(); // a keep-alive step may have changed
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
