package io.github.hafijbge.meshdrop;

import android.content.ContentResolver;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;
import io.github.hafijbge.meshdrop.engine.send.PathSource;
import io.github.hafijbge.meshdrop.engine.send.Source;
import java.io.FileInputStream;
import java.io.IOException;
import java.nio.channels.FileChannel;
import java.nio.channels.SeekableByteChannel;
import java.util.ArrayList;
import java.util.List;

/**
 * A picked or shared content URI as a Source: read by position through the descriptor's FileChannel,
 * never whole. Folders are SAF trees walked like the Node sender (sorted, empty folders listed).
 */
final class UriSource implements Source {
    private final Context ctx;
    private final Uri uri;
    private String name;

    UriSource(Context ctx, Uri uri) {
        this.ctx = ctx;
        this.uri = uri;
    }

    static Source.Resolver resolver(Context ctx) {
        return ref -> ref.startsWith("content://") ? new UriSource(ctx, Uri.parse(ref)) : PathSource.RESOLVER.resolve(ref);
    }

    private String[] query(String... cols) throws IOException {
        try (Cursor c = ctx.getContentResolver().query(uri, cols, null, null, null)) {
            if (c == null || !c.moveToFirst()) throw new IOException("cannot read " + uri);
            String[] out = new String[cols.length];
            for (int i = 0; i < cols.length; i++) {
                int k = c.getColumnIndex(cols[i]);
                out[i] = k < 0 || c.isNull(k) ? null : c.getString(k);
            }
            return out;
        } catch (SecurityException | IllegalArgumentException e) {
            throw new IOException("no access to " + uri, e);
        }
    }

    @Override
    public String name() {
        if (name == null) {
            try {
                String n = query(OpenableColumns.DISPLAY_NAME)[0];
                name = n != null ? n : String.valueOf(uri.getLastPathSegment());
            } catch (IOException e) {
                name = String.valueOf(uri.getLastPathSegment());
            }
        }
        return name;
    }

    @Override
    public long size() throws IOException {
        try (ParcelFileDescriptor pfd = ctx.getContentResolver().openFileDescriptor(uri, "r")) {
            if (pfd == null) throw new IOException("cannot open " + uri);
            long s = pfd.getStatSize();
            if (s >= 0) return s;
        } catch (SecurityException | IllegalArgumentException e) {
            throw new IOException("no access to " + uri, e);
        }
        String s = query(OpenableColumns.SIZE)[0];
        if (s == null) throw new IOException("unknown size: " + uri);
        return Long.parseLong(s);
    }

    @Override
    public long lastModified() {
        try {
            String m = query(DocumentsContract.Document.COLUMN_LAST_MODIFIED)[0];
            return m == null ? 0 : Long.parseLong(m);
        } catch (IOException | RuntimeException e) {
            return 0; // then only the per-chunk hashes guard against changes
        }
    }

    @Override
    public SeekableByteChannel open() throws IOException {
        ParcelFileDescriptor pfd;
        try {
            pfd = ctx.getContentResolver().openFileDescriptor(uri, "r");
        } catch (SecurityException | IllegalArgumentException e) {
            throw new IOException("no access to " + uri, e);
        }
        if (pfd == null) throw new IOException("cannot open " + uri);
        FileInputStream in = new ParcelFileDescriptor.AutoCloseInputStream(pfd);
        FileChannel ch = in.getChannel();
        return ch;
    }

    @Override
    public String mime() {
        String t = ctx.getContentResolver().getType(uri);
        return t != null ? t : PathSource.mimeOf(name());
    }

    @Override
    public String ref() {
        return uri.toString();
    }

    /** A SAF folder (ACTION_OPEN_DOCUMENT_TREE). */
    static Source.Tree tree(Context ctx, Uri treeUri) {
        String rootId = DocumentsContract.getTreeDocumentId(treeUri);
        return new Source.Tree() {
            @Override
            public String name() {
                return displayName(ctx, DocumentsContract.buildDocumentUriUsingTree(treeUri, rootId));
            }

            @Override
            public String ref() {
                return treeUri.toString();
            }

            @Override
            public List<Source.Entry> files() throws IOException {
                List<Source.Entry> out = new ArrayList<>();
                walk(ctx, treeUri, rootId, "", out, new ArrayList<>());
                return out;
            }

            @Override
            public List<String> emptyDirs() throws IOException {
                List<String> dirs = new ArrayList<>();
                walk(ctx, treeUri, rootId, "", new ArrayList<>(), dirs);
                return dirs;
            }
        };
    }

    static String displayName(Context ctx, Uri doc) {
        try (Cursor c = ctx.getContentResolver().query(doc, new String[] {DocumentsContract.Document.COLUMN_DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst() && !c.isNull(0)) return c.getString(0);
        } catch (RuntimeException ignored) {
            // fall through
        }
        return "folder";
    }

    private static void walk(Context ctx, Uri tree, String docId, String rel, List<Source.Entry> files, List<String> empty) throws IOException {
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, docId);
        List<String[]> kids = new ArrayList<>();
        ContentResolver cr = ctx.getContentResolver();
        try (Cursor c = cr.query(children, new String[] {DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE}, null, null, null)) {
            if (c == null) throw new IOException("cannot list " + tree);
            while (c.moveToNext()) kids.add(new String[] {c.getString(0), c.getString(1), c.getString(2)});
        } catch (SecurityException e) {
            throw new IOException("no access to " + tree, e);
        }
        kids.sort((a, b) -> a[1].compareTo(b[1]));
        int emitted = 0;
        for (String[] k : kids) {
            String childRel = rel.isEmpty() ? k[1] : rel + "/" + k[1];
            if (DocumentsContract.Document.MIME_TYPE_DIR.equals(k[2])) {
                walk(ctx, tree, k[0], childRel, files, empty);
            } else {
                files.add(new Source.Entry(childRel, new UriSource(ctx, DocumentsContract.buildDocumentUriUsingTree(tree, k[0]))));
            }
            emitted++;
        }
        if (emitted == 0) empty.add(rel);
    }
}
