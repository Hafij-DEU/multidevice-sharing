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
    static final int SCAN_QR = 43;
    static final int SCAN_DOC = 44;
    private volatile CompletableFuture<Boolean> photo;
    private final Activity activity;
    private final AndroidPlatform platform;
    private volatile CompletableFuture<List<Object>> waiting;
    private volatile CompletableFuture<String> scanning;

    /** Opens the camera scanner; the QR text, or null when cancelled. */
    String scanQr() throws Exception {
        CompletableFuture<String> f = new CompletableFuture<>();
        CompletableFuture<String> prev = scanning;
        if (prev != null) prev.complete(null);
        scanning = f;
        activity.runOnUiThread(() -> activity.startActivityForResult(new Intent(activity, ScannerActivity.class), SCAN_QR));
        return f.get(30, TimeUnit.MINUTES);
    }

    /**
     * M11 "phone as scanner": the camera app takes a photo of the page, which becomes a one-page PDF
     * here; returns it as an item to send ({kind:'file', path, name}), or null when cancelled.
     */
    java.util.Map<String, Object> scanDocument() throws Exception {
        android.content.ContentResolver cr = activity.getContentResolver();
        android.content.ContentValues v = new android.content.ContentValues();
        v.put(android.provider.MediaStore.MediaColumns.DISPLAY_NAME, "meshdrop-scan-" + System.currentTimeMillis() + ".jpg");
        v.put(android.provider.MediaStore.MediaColumns.MIME_TYPE, "image/jpeg");
        v.put(android.provider.MediaStore.MediaColumns.RELATIVE_PATH, "Pictures/MeshDrop");
        v.put(android.provider.MediaStore.MediaColumns.IS_PENDING, 1);
        Uri shot = cr.insert(android.provider.MediaStore.Images.Media.getContentUri(android.provider.MediaStore.VOLUME_EXTERNAL_PRIMARY), v);
        if (shot == null) throw new java.io.IOException("Cannot make room for the photo.");
        try {
            CompletableFuture<Boolean> f = new CompletableFuture<>();
            CompletableFuture<Boolean> prev = photo;
            if (prev != null) prev.complete(false);
            photo = f;
            activity.runOnUiThread(() -> {
                Intent i = new Intent(android.provider.MediaStore.ACTION_IMAGE_CAPTURE)
                        .putExtra(android.provider.MediaStore.EXTRA_OUTPUT, shot)
                        .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
                i.setClipData(android.content.ClipData.newRawUri("photo", shot));
                try {
                    activity.startActivityForResult(i, SCAN_DOC);
                } catch (RuntimeException e) {
                    f.completeExceptionally(new java.io.IOException("No camera app found."));
                }
            });
            if (!f.get(30, TimeUnit.MINUTES)) return null;
            byte[] jpeg;
            try (java.io.InputStream in = cr.openInputStream(shot)) {
                if (in == null) return null;
                java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
                byte[] buf = new byte[64 * 1024];
                for (int n; (n = in.read(buf)) > 0; ) bo.write(buf, 0, n); // readAllBytes needs API 33
                jpeg = bo.toByteArray();
            }
            if (jpeg.length == 0) return null;
            String name = "Scan " + new java.text.SimpleDateFormat("yyyy-MM-dd HH-mm-ss", java.util.Locale.ROOT).format(new java.util.Date()) + ".pdf";
            java.io.File dir = new java.io.File(activity.getCacheDir(), "scans");
            if (!dir.isDirectory() && !dir.mkdirs()) throw new java.io.IOException("Cannot save the scan.");
            java.io.File pdf = new java.io.File(dir, name);
            java.nio.file.Files.write(pdf.toPath(), io.github.hafijbge.meshdrop.engine.util.JpegPdf.fromJpeg(jpeg));
            java.util.Map<String, Object> m = new java.util.LinkedHashMap<>();
            m.put("kind", "file");
            m.put("path", pdf.getPath());
            m.put("name", name);
            return m;
        } finally {
            cr.delete(shot, null, null); // the photo was only the scan's source
        }
    }

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
        if (requestCode == SCAN_DOC) {
            CompletableFuture<Boolean> f = photo;
            photo = null;
            if (f != null) f.complete(resultCode == Activity.RESULT_OK);
            return true;
        }
        if (requestCode == SCAN_QR) {
            CompletableFuture<String> f = scanning;
            scanning = null;
            if (f != null) f.complete(resultCode == Activity.RESULT_OK && data != null ? data.getStringExtra(ScannerActivity.EXTRA_TEXT) : null);
            return true;
        }
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
