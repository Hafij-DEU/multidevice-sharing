package io.github.hafijbge.meshdrop;

import android.content.BroadcastReceiver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.provider.MediaStore;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Debug builds only (src/debug): `adb shell am broadcast -n io.github.hafijbge.meshdrop/.DebugCommands
 * -a io.github.hafijbge.meshdrop.debug.PAIR|SEND|JOIN|STATE …`. Results are appended to
 * <external files>/debug.log, which the e2e script reads.
 */
public final class DebugCommands extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        PendingResult pending = goAsync();
        Core core = ((MeshApp) ctx.getApplicationContext()).core();
        new Thread(() -> {
            try {
                core.ensureStarted();
                String a = String.valueOf(intent.getAction());
                if (a.endsWith(".PAIR")) {
                    core.controller.addByAddress(intent.getStringExtra("host"), intent.getIntExtra("port", 53318), intent.getStringExtra("alias"));
                    log(ctx, "paired " + core.controller.state().get("devices"));
                } else if (a.endsWith(".SEND")) {
                    Uri u = toMediaStore(ctx, new File(ctx.getExternalFilesDir(null), intent.getStringExtra("file")));
                    Map<String, Object> item = new LinkedHashMap<>();
                    item.put("kind", "file");
                    item.put("path", u.toString());
                    List<Map<String, Object>> items = new ArrayList<>();
                    items.add(item);
                    List<Object> to = new ArrayList<>();
                    to.add(intent.getStringExtra("to"));
                    core.controller.send(to, items);
                    log(ctx, "sending " + u);
                } else if (a.endsWith(".JOIN")) {
                    // Confirms the join box as the user would: the link the app was opened with.
                    Object link = core.controller.state().get("joinLink");
                    if (link == null) throw new IllegalStateException("no meshdrop://join link pending");
                    log(ctx, "join " + core.controller.join((String) link));
                } else if (a.endsWith(".STATE")) {
                    log(ctx, core.controller.stateJson());
                }
            } catch (Exception e) {
                log(ctx, "error " + e);
            } finally {
                pending.finish();
            }
        }).start();
    }

    /** Copies a file into MediaStore Downloads (as this app's own item) so it is sent by content URI. */
    private static Uri toMediaStore(Context ctx, File f) throws Exception {
        ContentValues v = new ContentValues();
        v.put(MediaStore.MediaColumns.DISPLAY_NAME, f.getName());
        v.put(MediaStore.MediaColumns.RELATIVE_PATH, "Download/MeshDrop-test/" + System.currentTimeMillis() + "/"); // never an older run's name
        Uri u = ctx.getContentResolver().insert(MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), v);
        try (InputStream in = new FileInputStream(f); OutputStream out = ctx.getContentResolver().openOutputStream(u, "w")) {
            byte[] b = new byte[1 << 20];
            for (int n; (n = in.read(b)) > 0; ) out.write(b, 0, n);
        }
        return u;
    }

    private static synchronized void log(Context ctx, String line) {
        try (FileOutputStream out = new FileOutputStream(new File(ctx.getExternalFilesDir(null), "debug.log"), true)) {
            out.write((line + "\n").getBytes(StandardCharsets.UTF_8));
        } catch (Exception ignored) {
            // nothing to do
        }
    }
}
