package io.github.hafijbge.meshdrop;

import android.app.Activity;
import android.content.Intent;
import android.media.projection.MediaProjectionManager;
import android.os.Bundle;

/**
 * Asks Android once for "MeshDrop will capture what plays" (the screen-capture consent, which also
 * covers sound) and hands the answer to MediaCast. No screen of its own: the system dialog, then gone.
 */
public final class SoundConsentActivity extends Activity {
    private static final int ASK = 7;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        MediaProjectionManager m = getSystemService(MediaProjectionManager.class);
        try {
            startActivityForResult(m.createScreenCaptureIntent(), ASK);
        } catch (RuntimeException e) {
            MediaCast.consent(RESULT_CANCELED, null);
            finish();
        }
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        MediaCast.consent(result, data);
        finish();
    }
}
