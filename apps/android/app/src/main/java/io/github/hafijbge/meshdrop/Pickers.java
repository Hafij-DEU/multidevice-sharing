package io.github.hafijbge.meshdrop;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

/** The system file/folder pickers, awaited from a bridge thread; MainActivity forwards the results. */
final class Pickers {
    static final int PICK_FILES = 41;
    static final int PICK_TREE = 42;
    private final Activity activity;
    private final AndroidPlatform platform;
    private volatile CompletableFuture<List<Object>> waiting;

    Pickers(Activity activity, AndroidPlatform platform) {
        this.activity = activity;
        this.platform = platform;
    }

    List<Object> pick(boolean folder) throws Exception {
        CompletableFuture<List<Object>> f = new CompletableFuture<>();
        CompletableFuture<List<Object>> prev = waiting;
        if (prev != null) prev.complete(new ArrayList<>());
        waiting = f;
        activity.runOnUiThread(() -> {
            Intent i;
            if (folder) {
                i = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
            } else {
                i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            }
            activity.startActivityForResult(i, folder ? PICK_TREE : PICK_FILES);
        });
        return f.get(30, TimeUnit.MINUTES);
    }

    /** From MainActivity.onActivityResult. */
    boolean onResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != PICK_FILES && requestCode != PICK_TREE) return false;
        CompletableFuture<List<Object>> f = waiting;
        waiting = null;
        List<Object> out = new ArrayList<>();
        if (resultCode == Activity.RESULT_OK && data != null) {
            List<Uri> uris = new ArrayList<>();
            if (data.getClipData() != null) {
                for (int k = 0; k < data.getClipData().getItemCount(); k++) uris.add(data.getClipData().getItemAt(k).getUri());
            } else if (data.getData() != null) {
                uris.add(data.getData());
            }
            for (Uri u : uris) out.add(platform.describe(u, requestCode == PICK_TREE));
        }
        if (f != null) f.complete(out);
        return true;
    }
}
