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
        pickers = new Pickers(this, core.platform);
        bridge = new Bridge(this, core, pickers);
        web = WebUi.create(this, bridge, null);
        setContentView(web);
        handleShare(getIntent());
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
