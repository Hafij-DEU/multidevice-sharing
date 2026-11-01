package io.github.hafijbge.meshdrop;

import android.content.ContentResolver;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.webkit.MimeTypeMap;

/** One file offered to a Xiaomi phone: a content or file URI with its name, size and type. */
final class QrShareItem {
    final Uri uri;
    final String name;
    final long size;
    final String mime;

    private QrShareItem(Uri uri, String name, long size, String mime) {
        this.uri = uri;
        this.name = name;
        this.size = size;
        this.mime = mime;
    }

    /** Shared text, kept as a small file in the cache folder (the protocol moves files, not snippets). */
    static QrShareItem text(java.io.File f) {
        return new QrShareItem(Uri.fromFile(f), f.getName(), f.length(), "text/plain");
    }

    /** A plain file path (a picked app's base.apk, say), named as the user chose. */
    static QrShareItem file(java.io.File f, String name) {
        String n = (name == null || name.isEmpty() ? f.getName() : name).replace('/', '_').replace('\\', '_');
        return new QrShareItem(Uri.fromFile(f), n, f.length(), mimeOf(n));
    }

    /** Reads the name and size the providing app reports; null when it cannot be read or has no size. */
    static QrShareItem of(ContentResolver cr, Uri uri) {
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
        return new QrShareItem(uri, name, size, mime != null ? mime : mimeOf(name));
    }

    static String mimeOf(String name) {
        int dot = name.lastIndexOf('.');
        String ext = dot < 0 ? null : name.substring(dot + 1).toLowerCase(java.util.Locale.ROOT);
        String mime = ext == null ? null : MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
        return mime != null ? mime : "application/octet-stream";
    }
}
