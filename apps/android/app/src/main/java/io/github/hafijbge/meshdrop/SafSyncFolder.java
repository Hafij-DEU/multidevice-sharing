package io.github.hafijbge.meshdrop;

import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.provider.DocumentsContract.Document;
import android.webkit.MimeTypeMap;
import io.github.hafijbge.meshdrop.engine.sync.SyncFolder;
import io.github.hafijbge.meshdrop.engine.sync.SyncRound;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.text.ParseException;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.function.Predicate;

/**
 * The synced folder on Android: a folder the user picked with the system picker (a SAF tree, with a
 * persistable read/write grant). Partial downloads live in the app's cache and are copied into a new
 * document when complete. SAF cannot set a file's modification time, so a pulled file carries the
 * time it arrived (only conflict tie-breaks use times; hashes decide everything else).
 */
final class SafSyncFolder implements SyncFolder {
    private static final String[] COLS = {Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE, Document.COLUMN_SIZE,
        Document.COLUMN_LAST_MODIFIED};
    private final Context ctx;
    private final ContentResolver cr;
    private final Uri tree;
    private final String rootId;
    private final File partials;

    SafSyncFolder(Context ctx, Uri tree) throws IOException {
        this.ctx = ctx;
        this.cr = ctx.getContentResolver();
        this.tree = tree;
        try {
            cr.takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        } catch (SecurityException e) {
            // already persisted earlier, or never granted: listing below tells
        }
        this.rootId = DocumentsContract.getTreeDocumentId(tree);
        this.partials = new File(ctx.getCacheDir(), "sync-partial");
        children(rootId); // fails now if the grant is gone
    }

    private Uri doc(String id) {
        return DocumentsContract.buildDocumentUriUsingTree(tree, id);
    }

    private static final class Kid {
        final String id;
        final String name;
        final boolean dir;
        final long size;
        final long mtime;

        Kid(String id, String name, boolean dir, long size, long mtime) {
            this.id = id;
            this.name = name;
            this.dir = dir;
            this.size = size;
            this.mtime = mtime;
        }
    }

    private List<Kid> children(String id) throws IOException {
        List<Kid> out = new ArrayList<>();
        try (Cursor c = cr.query(DocumentsContract.buildChildDocumentsUriUsingTree(tree, id), COLS, null, null, null)) {
            if (c == null) throw new IOException("cannot list the sync folder");
            while (c.moveToNext()) {
                out.add(new Kid(c.getString(0), c.getString(1), Document.MIME_TYPE_DIR.equals(c.getString(2)), c.isNull(3) ? 0 : c.getLong(3),
                        c.isNull(4) ? 0 : c.getLong(4)));
            }
        } catch (SecurityException e) {
            throw new IOException("MeshDrop lost access to the sync folder: choose it again", e);
        }
        return out;
    }

    private Kid child(String parentId, String name) throws IOException {
        for (Kid k : children(parentId)) if (k.name.equals(name)) return k;
        return null;
    }

    /** The document at `rel`, or null. */
    private Kid find(String rel) throws IOException {
        String id = rootId;
        Kid k = null;
        for (String seg : rel.split("/")) {
            k = child(id, seg);
            if (k == null) return null;
            id = k.id;
        }
        return k;
    }

    /** The folder `relDir` ("" = root), created as needed; refuses a file in the way. */
    private String dirId(String relDir) throws IOException {
        String id = rootId;
        if (relDir.isEmpty()) return id;
        for (String seg : relDir.split("/")) {
            Kid k = child(id, seg);
            if (k != null && !k.dir) throw new IOException("not a folder: " + seg);
            if (k == null) {
                Uri made = DocumentsContract.createDocument(cr, doc(id), Document.MIME_TYPE_DIR, seg);
                if (made == null) throw new IOException("cannot create folder " + seg);
                id = DocumentsContract.getDocumentId(made);
            } else {
                id = k.id;
            }
        }
        return id;
    }

    private static String dirOf(String rel) {
        int i = rel.lastIndexOf('/');
        return i < 0 ? "" : rel.substring(0, i);
    }

    private static String nameOf(String rel) {
        return rel.substring(rel.lastIndexOf('/') + 1);
    }

    private static String mime(String name) {
        int dot = name.lastIndexOf('.');
        String m = dot > 0 ? MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substring(dot + 1).toLowerCase(Locale.ROOT)) : null;
        return m != null ? m : "application/octet-stream";
    }

    @Override
    public List<Entry> list(Predicate<String> skip) throws IOException {
        List<Entry> out = new ArrayList<>();
        walk(rootId, "", skip, out);
        return out;
    }

    private void walk(String id, String prefix, Predicate<String> skip, List<Entry> out) throws IOException {
        for (Kid k : children(id)) {
            String rel = prefix.isEmpty() ? k.name : prefix + "/" + k.name;
            if (skip.test(rel)) continue;
            if (k.dir) walk(k.id, rel, skip, out);
            else out.add(new Entry(rel, k.size, k.mtime));
        }
    }

    @Override
    public Entry stat(String rel) throws IOException {
        Kid k = find(rel);
        return k == null || k.dir ? null : new Entry(rel, k.size, k.mtime);
    }

    @Override
    public InputStream open(String rel) throws IOException {
        Kid k = find(rel);
        if (k == null || k.dir) throw new FileNotFoundException(rel);
        InputStream in = cr.openInputStream(doc(k.id));
        if (in == null) throw new IOException("cannot open " + rel);
        return in;
    }

    private File partial(String name) {
        return new File(partials, name);
    }

    @Override
    public long partialSize(String name) {
        File f = partial(name);
        return f.isFile() ? f.length() : -1;
    }

    @Override
    public OutputStream writePartial(String name, boolean append) throws IOException {
        if (!partials.isDirectory() && !partials.mkdirs()) throw new IOException("cannot create " + partials);
        return new FileOutputStream(partial(name), append);
    }

    @Override
    public InputStream openPartial(String name) throws IOException {
        return new FileInputStream(partial(name));
    }

    @Override
    public void deletePartial(String name) {
        partial(name).delete();
    }

    @Override
    public void commitPartial(String name, String rel, long mtime) throws IOException {
        String parent = dirId(dirOf(rel));
        if (child(parent, nameOf(rel)) != null) throw new IOException("taken: " + rel);
        Uri made = DocumentsContract.createDocument(cr, doc(parent), mime(nameOf(rel)), nameOf(rel));
        if (made == null) throw new IOException("cannot create " + rel);
        try (InputStream in = openPartial(name); OutputStream out = cr.openOutputStream(made, "w")) {
            if (out == null) throw new IOException("cannot write " + rel);
            byte[] buf = new byte[64 * 1024];
            for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
        } catch (IOException | RuntimeException e) {
            try {
                DocumentsContract.deleteDocument(cr, made);
            } catch (FileNotFoundException | RuntimeException ignored) {
                // best effort
            }
            throw e instanceof IOException ? (IOException) e : new IOException(e);
        }
        deletePartial(name);
    }

    @Override
    public void move(String rel, String dest) throws IOException {
        Kid k = find(rel);
        if (k == null) throw new FileNotFoundException(rel);
        String fromDir = dirOf(rel);
        String toDir = dirOf(dest);
        String srcParent = dirId(fromDir);
        String dstParent = dirId(toDir);
        if (child(dstParent, nameOf(dest)) != null) throw new IOException("taken: " + dest);
        Uri moved = doc(k.id);
        if (!fromDir.equals(toDir)) {
            moved = DocumentsContract.moveDocument(cr, moved, doc(srcParent), doc(dstParent));
            if (moved == null) throw new IOException("cannot move " + rel);
        }
        if (!nameOf(rel).equals(nameOf(dest)) && DocumentsContract.renameDocument(cr, moved, nameOf(dest)) == null) throw new IOException("cannot rename " + rel);
    }

    @Override
    public boolean exists(String rel) throws IOException {
        return find(rel) != null;
    }

    @Override
    public void pruneTrash(long cutoffMs) throws IOException {
        Kid trash = child(rootId, SyncRound.TRASH_DIR);
        if (trash == null || !trash.dir) return;
        SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd_HH-mm-ss", Locale.ROOT);
        for (Kid k : children(trash.id)) {
            try {
                if (f.parse(k.name).getTime() < cutoffMs) DocumentsContract.deleteDocument(cr, doc(k.id));
            } catch (ParseException | RuntimeException ignored) {
                // not one of our rounds
            }
        }
    }

    @Override
    public String ref() {
        return tree.toString();
    }
}
