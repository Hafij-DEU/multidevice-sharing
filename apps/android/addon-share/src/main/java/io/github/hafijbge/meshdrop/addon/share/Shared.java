package io.github.hafijbge.meshdrop.addon.share;

import android.content.ContentResolver;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.webkit.MimeTypeMap;

/** One file handed to the add-on by another app's share sheet (or picked in it). */
final class Shared {
    final Uri uri;
    final String name;
    final long size;
    final String mime;

    private Shared(Uri uri, String name, long size, String mime) {
        this.uri = uri;
        this.name = name;
        this.size = size;
        this.mime = mime;
    }

    /** Shared text, kept as a small file in the cache folder (ShareMe moves files, not snippets). */
    static Shared text(java.io.File f) {
        return new Shared(Uri.fromFile(f), f.getName(), f.length(), "text/plain");
    }

    /** A file chosen in PickerActivity, which already knows its name, size and type. */
    static Shared picked(Uri uri, String name, long size, String mime) {
        return new Shared(uri, name.replace('/', '_').replace('\\', '_'), size, mime != null ? mime : "application/octet-stream");
    }

    /** Reads the name and size the providing app reports; null when it cannot be read or has no size. */
    static Shared of(ContentResolver cr, Uri uri) {
        String name = null;
        long size = -1;
        try (Cursor c = cr.query(uri, new String[] {OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                if (!c.isNull(0)) name = c.getString(0);
                if (!c.isNull(1)) size = c.getLong(1);
            }
        } catch (RuntimeException e) {
            return null;
        }
        if (size < 0) return null;
        if (name == null || name.isEmpty()) name = uri.getLastPathSegment() != null ? uri.getLastPathSegment() : "file";
        name = name.replace('/', '_').replace('\\', '_');
        String mime = cr.getType(uri);
        if (mime == null) {
            int dot = name.lastIndexOf('.');
            String ext = dot < 0 ? null : name.substring(dot + 1).toLowerCase(java.util.Locale.ROOT);
            mime = ext == null ? null : MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
        }
        return new Shared(uri, name, size, mime != null ? mime : "application/octet-stream");
    }
}
