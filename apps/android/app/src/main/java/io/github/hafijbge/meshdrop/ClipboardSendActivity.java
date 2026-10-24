package io.github.hafijbge.meshdrop;

import android.app.Activity;
import android.os.Bundle;
import android.webkit.WebView;

/**
 * The small "Send clipboard" window (notification action, quick-settings tile). Android 10+ lets
 * only the focused app read the clipboard, so the read happens here, while this window has focus.
 */
public final class ClipboardSendActivity extends Activity {
    private WebView web;
    private Bridge bridge;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        Core core = ((MeshApp) getApplication()).core();
        bridge = new Bridge(this, core, new Pickers(this, core.platform));
        web = WebUi.create(this, bridge, "picker");
        setContentView(web);
        MeshService.start(this);
    }

    @Override
    protected void onDestroy() {
        bridge.destroy();
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
