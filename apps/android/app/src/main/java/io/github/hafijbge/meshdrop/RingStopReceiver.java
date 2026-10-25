package io.github.hafijbge.meshdrop;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import java.util.Collections;

/** The Stop button (or swiping away) of the Find my device notification. */
public final class RingStopReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        try {
            ((MeshApp) ctx.getApplicationContext()).core().controller.call("ringStop", Collections.emptyList());
        } catch (Exception ignored) {
            // nothing is ringing
        }
    }
}
