package io.github.hafijbge.meshdrop;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Starts the service after boot and after an app update, so the phone stays reachable. */
public final class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        String a = intent.getAction();
        // QUICKBOOT_POWERON: some ROMs (Xiaomi, HTC) send it instead of BOOT_COMPLETED after a fast reboot.
        if (Intent.ACTION_BOOT_COMPLETED.equals(a) || Intent.ACTION_MY_PACKAGE_REPLACED.equals(a) || "android.intent.action.QUICKBOOT_POWERON".equals(a)
                || "com.htc.intent.action.QUICKBOOT_POWERON".equals(a)) {
            MeshService.start(ctx);
        }
    }
}
