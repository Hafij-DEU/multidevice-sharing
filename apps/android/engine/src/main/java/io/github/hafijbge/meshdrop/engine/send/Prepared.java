package io.github.hafijbge.meshdrop.engine.send;

import io.github.hafijbge.meshdrop.engine.proto.Chunks;
import io.github.hafijbge.meshdrop.engine.proto.Manifest;
import io.github.hafijbge.meshdrop.engine.proto.Sanitize;
import io.github.hafijbge.meshdrop.engine.util.Hex;
import io.github.hafijbge.meshdrop.engine.util.Json;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.SeekableByteChannel;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Items walked and hashed once (Sender algorithm step 1): file entries, empty dirs, text, the
 * per-chunk plaintext hashes (sender-side only) and each source's size and mtime.
 */
public final class Prepared {
    private static final int HASH_BUF = 1024 * 1024;

    public final List<Manifest.FileEntry> files = new ArrayList<>();
    public final List<String> dirs = new ArrayList<>();
    public String text;
    public boolean clipboard;
    /** Photo backup: set by the engine before sending. */
    public boolean backup;
    /** Copied files: set by the engine before sending (manifest clipboardFiles). */
    public boolean clipboardFiles;
    /** M11: burn after reading / print on the receiver. */
    public boolean burn;
    public boolean print;
    public String itemsKey;
    final Map<Long, Source> sources = new HashMap<>();
    final Map<Long, long[]> stats = new HashMap<>(); // size, mtime
    final Map<Long, List<String>> chunkHashes = new HashMap<>();

    private Prepared() {}

    public List<String> paths() {
        List<String> out = new ArrayList<>();
        for (Manifest.FileEntry f : files) out.add(f.path);
        return out;
    }


    public static Prepared of(List<SendItem> items, AtomicBoolean cancel) throws IOException {
        if (items == null || items.isEmpty()) throw new IllegalArgumentException("nothing to send");
        Prepared p = new Prepared();
        List<Object> keyParts = new ArrayList<>();
        for (SendItem it : items) {
            if (cancel != null && cancel.get()) throw new Sender.Aborted();
            List<Object> k = new ArrayList<>();
            k.add(it.kind.name().toLowerCase());
            switch (it.kind) {
                case TEXT:
                    if (it.text == null) throw new IllegalArgumentException("text item without text");
                    if (p.text != null) throw new IllegalArgumentException("only one text item per send");
                    p.text = it.text;
                    if (it.clipboard) p.clipboard = true;
                    k.add(null);
                    k.add(it.text);
                    break;
                case FILE:
                    p.add(it.source, it.source.name(), cancel);
                    k.add(it.source.ref());
                    k.add(null);
                    break;
                case DIR:
                    String base = it.tree.name();
                    for (Source.Entry e : it.tree.files()) p.add(e.source, base + "/" + e.relPath, cancel);
                    for (String d : it.tree.emptyDirs()) p.dirs.add(d.isEmpty() ? base : base + "/" + d);
                    k.add(it.tree.ref());
                    k.add(null);
                    break;
                default:
                    throw new IllegalArgumentException("invalid item");
            }
            k.add(it.clipboard);
            keyParts.add(k);
        }
        List<String> all = new ArrayList<>(p.paths());
        all.addAll(p.dirs);
        for (String path : all) {
            String safe;
            try {
                safe = Sanitize.safeRelPath(path);
            } catch (Sanitize.UnsafePath e) {
                throw new Sender.LocalPathError(path, e.getMessage());
            }
            if (!safe.equals(path)) throw new Sender.LocalPathError(path, "the receiver would rename it");
        }
        if (p.clipboard && (!p.files.isEmpty() || !p.dirs.isEmpty())) throw new IllegalArgumentException("clipboard text cannot be sent with files");
        p.itemsKey = sha256Hex(Json.stringify(keyParts).getBytes(StandardCharsets.UTF_8));
        return p;
    }

    private void add(Source s, String rel, AtomicBoolean cancel) throws IOException {
        long size = s.size();
        long mtime = s.lastModified();
        MessageDigest whole = sha();
        MessageDigest chunk = sha();
        List<String> chunks = new ArrayList<>();
        ByteBuffer buf = ByteBuffer.allocate((int) Math.min(HASH_BUF, Math.max(size, 1)));
        try (SeekableByteChannel ch = s.open()) {
            long pos = 0;
            while (pos < size) {
                if (cancel != null && cancel.get()) throw new Sender.Aborted();
                java.nio.Buffer b = buf; // Buffer's clear()/limit(): ByteBuffer's covariant ones are Java 9+
                b.clear();
                b.limit((int) Math.min(buf.capacity(), Math.min(size - pos, Chunks.CHUNK_SIZE - (pos % Chunks.CHUNK_SIZE))));
                ch.position(pos);
                int n = ch.read(buf);
                if (n <= 0) throw new Sender.SourceChanged(s.ref());
                whole.update(buf.array(), 0, n);
                chunk.update(buf.array(), 0, n);
                pos += n;
                if (pos % Chunks.CHUNK_SIZE == 0 || pos == size) chunks.add(Hex.of(chunk.digest()));
            }
        }
        if (s.size() != size || s.lastModified() != mtime) throw new Sender.SourceChanged(s.ref());
        long fileId = files.size();
        files.add(new Manifest.FileEntry(fileId, rel, size, s.mime(), Hex.of(whole.digest())));
        sources.put(fileId, s);
        stats.put(fileId, new long[] {size, mtime});
        chunkHashes.put(fileId, chunks);
    }

    static MessageDigest sha() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    static String sha256Hex(byte[] b) {
        return Hex.of(sha().digest(b));
    }

    Manifest manifest(String from, String to, String sessionId) {
        Manifest m = new Manifest();
        m.sessionId = sessionId;
        m.from = from;
        m.to = to;
        m.createdAt = System.currentTimeMillis();
        m.files.addAll(files);
        m.dirs.addAll(dirs);
        m.text = text;
        m.clipboard = clipboard;
        m.backup = backup;
        m.clipboardFiles = clipboardFiles && !files.isEmpty();
        m.burn = burn;
        m.print = print && !files.isEmpty();
        return m;
    }
}
