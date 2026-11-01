package io.github.hafijbge.meshdrop;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import io.github.hafijbge.meshdrop.picker.PickerActivity;
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
    static final int CHOOSE = 45;
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

    /**
     * The categorised "Choose what to send" screen (Recent, Videos, Photos, Audio, Apps, APK files,
     * Files); returns the ticked items as {kind:'file', path, name}, or none when cancelled.
     */
    List<Object> choose() throws Exception {
        CompletableFuture<List<Object>> f = new CompletableFuture<>();
        CompletableFuture<List<Object>> prev = waiting;
        if (prev != null) prev.complete(new ArrayList<>());
        waiting = f;
        activity.runOnUiThread(() -> activity.startActivityForResult(new Intent(activity, PickerActivity.class), CHOOSE));
        return f.get(30, TimeUnit.MINUTES);
    }

    /**
     * A chosen file's path for the send list. The engine names a file by its path, so a file sent
     * under another name (an installed app's base.apk as "<Label>.apk") goes through a symlink with
     * that name in the cache folder.
     */
    private String chosenPath(Uri uri, String name) throws java.io.IOException {
        String path = uri.getPath();
        if (path == null || new java.io.File(path).getName().equals(name)) return path;
        java.io.File root = new java.io.File(activity.getCacheDir(), "picked");
        java.io.File dir = new java.io.File(root, Long.toString(System.nanoTime()));
        if (!dir.mkdirs()) throw new java.io.IOException("Cannot prepare " + name);
        java.nio.file.Path link = new java.io.File(dir, name).toPath();
        java.nio.file.Files.createSymbolicLink(link, java.nio.file.Paths.get(path));
        return link.toString();
    }

    /** Clears the links of earlier choices once they are a day old (a send can resume a while later). */
    private void prunePicked() {
        java.io.File[] old = new java.io.File(activity.getCacheDir(), "picked").listFiles();
        if (old == null) return;
        long cutoff = System.currentTimeMillis() - TimeUnit.DAYS.toMillis(1);
        for (java.io.File d : old) {
            if (d.lastModified() >= cutoff) continue;
            java.io.File[] links = d.listFiles();
            if (links != null) for (java.io.File l : links) l.delete(); // deletes the link, not its target
            d.delete();
        }
    }

    /** From MainActivity.onActivityResult. */
    boolean onResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == CHOOSE) {
            CompletableFuture<List<Object>> f = waiting;
            waiting = null;
            List<Object> out = new ArrayList<>();
            if (resultCode == Activity.RESULT_OK && data != null) {
                prunePicked();
                @SuppressWarnings("deprecation") // the typed overload needs API 33
                ArrayList<Uri> uris = data.getParcelableArrayListExtra(PickerActivity.EXTRA_URIS);
                ArrayList<String> names = data.getStringArrayListExtra(PickerActivity.EXTRA_NAMES);
                for (int k = 0; uris != null && names != null && k < uris.size() && k < names.size(); k++) {
                    Uri u = uris.get(k);
                    java.util.Map<String, Object> m = new java.util.LinkedHashMap<>();
                    m.put("kind", "file");
                    try {
                        m.put("path", "file".equals(u.getScheme()) ? chosenPath(u, names.get(k)) : u.toString());
                    } catch (java.io.IOException | RuntimeException e) {
                        continue; // that one file cannot be offered; the rest still can
                    }
                    m.put("name", names.get(k));
                    out.add(m);
                }
            }
            if (f != null) f.complete(out);
            return true;
        }
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
