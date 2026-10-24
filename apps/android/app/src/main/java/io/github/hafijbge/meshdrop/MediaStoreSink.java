package io.github.hafijbge.meshdrop;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.Environment;
import android.provider.MediaStore;
import io.github.hafijbge.meshdrop.engine.recv.InboxSink;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;

/**
 * Finished files land in MediaStore Download/MeshDrop/<relative path> (no storage permission needed).
 * The Inbox chooses "name (n).ext" itself; if MediaStore still renames (another app's file of that
 * name it cannot see), the landed name is read back and reported.
 */
final class MediaStoreSink implements InboxSink {
    static final String ROOT = Environment.DIRECTORY_DOWNLOADS + "/MeshDrop";
    private final Context ctx;

    MediaStoreSink(Context ctx) {
        this.ctx = ctx;
    }

    private static Uri collection() {
        return MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
    }

    private static String dirOf(String rel) {
        int slash = rel.lastIndexOf('/');
        return slash < 0 ? "" : rel.substring(0, slash);
    }

    private static String nameOf(String rel) {
        return rel.substring(rel.lastIndexOf('/') + 1);
    }

    private static String relativePath(String dir) {
        return ROOT + "/" + (dir.isEmpty() ? "" : dir + "/");
    }

    /** The MediaStore item for an inbox-relative path, or null. */
    Uri find(String rel) {
        ContentResolver cr = ctx.getContentResolver();
        try (Cursor c = cr.query(collection(), new String[] {MediaStore.MediaColumns._ID},
                MediaStore.MediaColumns.RELATIVE_PATH + "=? AND " + MediaStore.MediaColumns.DISPLAY_NAME + "=?",
                new String[] {relativePath(dirOf(rel)), nameOf(rel)}, null)) {
            if (c != null && c.moveToFirst()) return Uri.withAppendedPath(collection(), String.valueOf(c.getLong(0)));
        }
        return null;
    }

    private File publicFile(String rel) {
        return new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "MeshDrop/" + rel);
    }

    @Override
    public Kind kind(String rel) {
        if (find(rel) != null) return Kind.FILE;
        try (Cursor c = ctx.getContentResolver().query(collection(), new String[] {MediaStore.MediaColumns._ID},
                MediaStore.MediaColumns.RELATIVE_PATH + " LIKE ?", new String[] {relativePath(rel) + "%"}, null)) {
            if (c != null && c.moveToFirst()) return Kind.DIR;
        }
        File f = publicFile(rel);
        if (f.isDirectory()) return Kind.DIR;
        return f.exists() ? Kind.OTHER : Kind.NONE;
    }

    @Override
    public void mkdirs(String relDir) {
        // MediaStore creates folders for the files in them; an empty folder is made through the file
        // API where the platform allows it (Android 11+), otherwise it is skipped.
        if (!relDir.isEmpty()) publicFile(relDir).mkdirs();
    }

    @Override
    public String publishAs(String rel, File data, String mime) throws IOException {
        if (find(rel) != null) return null;
        ContentResolver cr = ctx.getContentResolver();
        ContentValues v = new ContentValues();
        v.put(MediaStore.MediaColumns.DISPLAY_NAME, nameOf(rel));
        v.put(MediaStore.MediaColumns.MIME_TYPE, mime == null || mime.isEmpty() ? "application/octet-stream" : mime);
        v.put(MediaStore.MediaColumns.RELATIVE_PATH, relativePath(dirOf(rel)));
        v.put(MediaStore.MediaColumns.IS_PENDING, 1);
        Uri item = cr.insert(collection(), v);
        if (item == null) throw new IOException("MediaStore refused " + rel);
        try (InputStream in = new FileInputStream(data); OutputStream out = cr.openOutputStream(item, "w")) {
            if (out == null) throw new IOException("cannot write " + rel);
            byte[] buf = new byte[1 << 20];
            for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
        } catch (IOException | RuntimeException e) {
            cr.delete(item, null, null);
            throw e instanceof IOException ? (IOException) e : new IOException(e);
        }
        ContentValues done = new ContentValues();
        done.put(MediaStore.MediaColumns.IS_PENDING, 0);
        cr.update(item, done, null, null);
        String landed = rel;
        try (Cursor c = cr.query(item, new String[] {MediaStore.MediaColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst() && !c.isNull(0)) {
                String dir = dirOf(rel);
                landed = dir.isEmpty() ? c.getString(0) : dir + "/" + c.getString(0);
            }
        }
        Files.deleteIfExists(data.toPath());
        return landed;
    }

    @Override
    public InputStream open(String rel) throws IOException {
        Uri u = find(rel);
        return u == null ? null : ctx.getContentResolver().openInputStream(u);
    }

    @Override
    public String locate(String rel) {
        return publicFile(rel).getPath();
    }

    /** The MediaStore item behind a located path (for opening it), or null. */
    Uri uriForLocated(String path) {
        String base = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS).getPath() + "/MeshDrop/";
        return path.startsWith(base) ? find(path.substring(base.length())) : null;
    }
}
