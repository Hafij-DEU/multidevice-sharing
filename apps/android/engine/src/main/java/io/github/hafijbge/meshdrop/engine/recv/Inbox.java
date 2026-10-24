package io.github.hafijbge.meshdrop.engine.recv;

import io.github.hafijbge.meshdrop.engine.proto.Chunks;
import io.github.hafijbge.meshdrop.engine.proto.Manifest;
import io.github.hafijbge.meshdrop.engine.proto.Offer;
import io.github.hafijbge.meshdrop.engine.proto.Sanitize;
import io.github.hafijbge.meshdrop.engine.util.Atomic;
import io.github.hafijbge.meshdrop.engine.util.Hex;
import io.github.hafijbge.meshdrop.engine.util.Json;
import io.github.hafijbge.meshdrop.engine.util.Io;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardOpenOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;

/**
 * The receiver's resumable session store, ported from packages/core/src/inbox.ts. Per session:
 * <state>/<sessionId>/state.json (manifest, ctx secrets, top-folder mapping), an append-only
 * progress.log ({c}, {p}, {d}, {x} records, compacted, a torn last line ignored) and <fileId>.part
 * files written by position. Finished files go to an InboxSink; tombstones live in <state>/.finished.
 */
public final class Inbox {
    public static final long FINISHED_TTL_MS = 7L * 24 * 3600 * 1000;
    public static final long PARTIAL_TTL_MS = 30L * 24 * 3600 * 1000;
    private static final String LOG = "progress.log";
    private static final String FINISHED_DIR = ".finished";
    private static final int LOG_SLACK = 4;
    private static final int LOG_MIN_LINES = 1024;
    private static final int HASH_BUF = 1024 * 1024;

    public static final class IntegrityError extends RuntimeException {
        IntegrityError(String m) {
            super(m);
        }
    }

    public static final class ChunkRange extends RuntimeException {
        ChunkRange(String m) {
            super(m);
        }
    }

    public static final class UnknownSession extends RuntimeException {
        UnknownSession(String m) {
            super(m);
        }
    }

    public static final class Incomplete extends RuntimeException {
        Incomplete(String m) {
            super(m);
        }
    }

    public static final class Loaded {
        public final Manifest manifest;
        public final String ctxExport;

        Loaded(Manifest manifest, String ctxExport) {
            this.manifest = manifest;
            this.ctxExport = ctxExport;
        }
    }

    public static final class Tombstone {
        public final String from;
        public final List<String> files;

        Tombstone(String from, List<String> files) {
            this.from = from;
            this.files = files;
        }
    }

    private static final class Session {
        final Manifest manifest;
        String ctxExport;
        final Map<String, String> tops;
        final Map<Long, Manifest.FileEntry> files = new HashMap<>();
        final Map<Long, Set<Long>> have = new HashMap<>();
        final Map<Long, String> done = new LinkedHashMap<>();
        final Map<Long, String> pending = new LinkedHashMap<>();
        final Map<Long, Object> fileLocks = new HashMap<>();
        int logLines;
        int live;

        Session(Manifest m, String ctxExport, Map<String, String> tops) {
            this.manifest = m;
            this.ctxExport = ctxExport;
            this.tops = tops;
            for (Manifest.FileEntry f : m.files) files.put(f.fileId, f);
        }

        synchronized Object fileLock(long id) {
            return fileLocks.computeIfAbsent(id, k -> new Object());
        }
    }

    private final File state;
    private final InboxSink sink;
    private final Map<String, Session> sessions = new HashMap<>();

    public Inbox(File stateDir, InboxSink sink) {
        this.state = stateDir;
        this.sink = sink;
    }

    // ---- paths ----------------------------------------------------------------------------------

    private File sessionDir(String sid) {
        if (sid == null || !Offer.SESSION_ID.matcher(sid).matches()) throw new Sanitize.UnsafePath("invalid sessionId");
        return new File(state, sid);
    }

    private static List<String> relParts(String p) {
        String rel = Sanitize.safeRelPath(p);
        if (rel.isEmpty()) throw new Sanitize.UnsafePath("empty path");
        return new ArrayList<>(Arrays.asList(rel.split("/")));
    }

    private static List<String> destParts(Session s, String p, boolean isDir) {
        List<String> parts = relParts(p);
        if ((parts.size() > 1 || isDir) && s.tops.containsKey(parts.get(0))) parts.set(0, s.tops.get(parts.get(0)));
        return parts;
    }

    // ---- log ------------------------------------------------------------------------------------

    @SuppressWarnings("unchecked")
    private static boolean apply(Session s, Object r) {
        if (!(r instanceof Map)) return false;
        Map<String, Object> o = (Map<String, Object>) r;
        if (o.get("c") instanceof List) {
            List<Object> c = (List<Object>) o.get("c");
            if (c.size() != 2 || !isId(s, c.get(0)) || !(c.get(1) instanceof Long)) return false;
            long id = (Long) c.get(0), i = (Long) c.get(1);
            if (s.done.containsKey(id)) return true;
            if (s.have.computeIfAbsent(id, k -> new TreeSet<>()).add(i)) s.live++;
            return true;
        }
        if (o.get("p") instanceof List) {
            List<Object> p = (List<Object>) o.get("p");
            if (p.size() != 2 || !isId(s, p.get(0)) || !(p.get(1) instanceof String)) return false;
            long id = (Long) p.get(0);
            if (s.done.containsKey(id)) return true;
            if (!s.pending.containsKey(id)) s.live++;
            s.pending.put(id, (String) p.get(1));
            return true;
        }
        if (o.get("d") instanceof List) {
            List<Object> d = (List<Object>) o.get("d");
            if (d.size() != 2 || !isId(s, d.get(0)) || !(d.get(1) instanceof String)) return false;
            long id = (Long) d.get(0);
            forget(s, id);
            if (!s.done.containsKey(id)) s.live++;
            s.done.put(id, (String) d.get(1));
            return true;
        }
        if (isId(s, o.get("x"))) {
            forget(s, (Long) o.get("x"));
            return true;
        }
        return false;
    }

    private static boolean isId(Session s, Object v) {
        return v instanceof Long && s.files.containsKey(v);
    }

    private static void forget(Session s, long id) {
        Set<Long> h = s.have.remove(id);
        s.live -= (h == null ? 0 : h.size()) + (s.pending.remove(id) != null ? 1 : 0);
    }

    private static Map<String, Object> rec(String k, Object v) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put(k, v);
        return m;
    }

    private void compact(String sid, Session s) throws IOException {
        StringBuilder b = new StringBuilder();
        int n = 0;
        for (Map.Entry<Long, Set<Long>> e : new TreeMap<>(s.have).entrySet()) {
            for (Long i : e.getValue()) {
                b.append(Json.stringify(rec("c", java.util.Arrays.asList(e.getKey(), i)))).append('\n');
                n++;
            }
        }
        for (Map.Entry<Long, String> e : s.pending.entrySet()) {
            b.append(Json.stringify(rec("p", java.util.Arrays.asList(e.getKey(), e.getValue())))).append('\n');
            n++;
        }
        for (Map.Entry<Long, String> e : s.done.entrySet()) {
            b.append(Json.stringify(rec("d", java.util.Arrays.asList(e.getKey(), e.getValue())))).append('\n');
            n++;
        }
        Atomic.write(new File(sessionDir(sid), LOG), b.toString().getBytes(StandardCharsets.UTF_8));
        s.logLines = s.live = n;
    }

    /** Appends one record (fsync'd) and applies it. Caller holds the session lock. */
    private void append(String sid, Session s, Map<String, Object> r) throws IOException {
        File log = new File(sessionDir(sid), LOG);
        try (FileOutputStream out = new FileOutputStream(log, true)) {
            out.write((Json.stringify(r) + "\n").getBytes(StandardCharsets.UTF_8));
            out.getFD().sync();
        }
        apply(s, r);
        s.logLines++;
        if (s.logLines > LOG_SLACK * s.live + LOG_MIN_LINES) compact(sid, s);
    }

    private void record(String sid, Session s, Map<String, Object> r) throws IOException {
        synchronized (s) {
            append(sid, s, r);
        }
    }

    // ---- sessions -------------------------------------------------------------------------------

    @SuppressWarnings("unchecked")
    private Session loadSession(String sid) throws IOException {
        File dir = sessionDir(sid);
        File st = new File(dir, "state.json");
        if (!st.isFile()) return null;
        Map<String, Object> j = (Map<String, Object>) Json.parse(Io.readString(st.toPath()));
        Map<String, String> tops = new LinkedHashMap<>();
        if (j.get("tops") instanceof Map) {
            for (Map.Entry<String, Object> e : ((Map<String, Object>) j.get("tops")).entrySet()) {
                if (e.getValue() instanceof String) tops.put(e.getKey(), (String) e.getValue());
            }
        }
        Session s = new Session(Manifest.fromJson(j.get("manifest")), (String) j.get("ctxExport"), tops);
        File log = new File(dir, LOG);
        if (!log.isFile()) return s;
        String text = Io.readString(log.toPath());
        int lines = 0, bad = 0;
        for (String line : text.split("\n", -1)) {
            if (line.isEmpty()) continue;
            lines++;
            try {
                if (!apply(s, Json.parse(line))) bad++;
            } catch (Json.JsonException e) {
                bad++;
            }
        }
        s.logLines = lines;
        if (bad > 0 || !text.endsWith("\n") && !text.isEmpty() || lines > s.live) compact(sid, s);
        return s;
    }

    private Session getSession(String sid) throws IOException {
        synchronized (sessions) {
            Session s = sessions.get(sid);
            if (s == null) {
                s = loadSession(sid);
                if (s != null) sessions.put(sid, s);
            }
            return s;
        }
    }

    private Session require(String sid) throws IOException {
        Session s = getSession(sid);
        if (s == null) throw new UnknownSession("unknown session");
        return s;
    }

    private void writeState(String sid, Session s) throws IOException {
        Map<String, Object> j = new LinkedHashMap<>();
        j.put("manifest", s.manifest.toMap());
        j.put("ctxExport", s.ctxExport);
        j.put("tops", new LinkedHashMap<String, Object>(s.tops));
        Atomic.write(new File(sessionDir(sid), "state.json"), Json.stringify(j).getBytes(StandardCharsets.UTF_8));
    }

    private Map<String, String> mapTops(Manifest m) throws IOException {
        Set<String> folders = new LinkedHashSet<>();
        for (Manifest.FileEntry f : m.files) {
            List<String> parts = relParts(f.path);
            if (parts.size() > 1) folders.add(parts.get(0));
        }
        for (String d : m.dirs) folders.add(relParts(d).get(0));
        Map<String, String> tops = new LinkedHashMap<>();
        for (String name : folders) {
            InboxSink.Kind k = sink.kind(name);
            if (k != InboxSink.Kind.NONE && k != InboxSink.Kind.DIR) {
                sink.mkdirs("");
                tops.put(name, Sanitize.uniqueName(name, this::taken));
            }
        }
        return tops;
    }

    private boolean taken(String rel) {
        try {
            return sink.kind(rel) != InboxSink.Kind.NONE;
        } catch (IOException e) {
            return true;
        }
    }

    /**
     * Starts (or re-attaches to) a session. The same manifest keeps its progress (the ctx secrets
     * are updated); a different one wipes it. Any unsafe path rejects the whole manifest first.
     */
    public void begin(String sid, Manifest m, String ctxExport) throws IOException {
        File dir = sessionDir(sid);
        for (Manifest.FileEntry f : m.files) relParts(f.path);
        for (String d : m.dirs) relParts(d);
        Session existing = getSession(sid);
        if (existing != null) {
            synchronized (existing) {
                if (existing.manifest.toJson().equals(m.toJson())) {
                    existing.ctxExport = ctxExport;
                    writeState(sid, existing);
                    compact(sid, existing);
                    return;
                }
            }
        }
        synchronized (sessions) {
            sessions.remove(sid);
            deleteTree(dir);
            if (!dir.mkdirs()) throw new IOException("cannot create " + dir);
            Session s = new Session(m, ctxExport, mapTops(m));
            writeState(sid, s);
            sessions.put(sid, s);
        }
    }

    public Loaded load(String sid) throws IOException {
        Session s = getSession(sid);
        return s == null ? null : new Loaded(s.manifest, s.ctxExport);
    }

    /** The have map: fileId → sorted chunk indices already stored (all chunks for finalized files). */
    public Map<Long, List<Long>> have(String sid) throws IOException {
        Session s = getSession(sid);
        Map<Long, List<Long>> out = new TreeMap<>();
        if (s == null) return out;
        synchronized (s) {
            for (Map.Entry<Long, Set<Long>> e : s.have.entrySet()) if (!e.getValue().isEmpty()) out.put(e.getKey(), new ArrayList<>(e.getValue()));
            for (Long id : s.done.keySet()) {
                long n = Chunks.count(s.files.get(id).size);
                if (n > 0) {
                    List<Long> all = new ArrayList<>();
                    for (long i = 0; i < n; i++) all.add(i);
                    out.put(id, all);
                }
            }
        }
        return out;
    }

    /** Chunks stored for one file (for progress events). */
    public long haveCount(String sid, long fileId) throws IOException {
        Session s = getSession(sid);
        if (s == null) return 0;
        synchronized (s) {
            Manifest.FileEntry f = s.files.get(fileId);
            if (f != null && s.done.containsKey(fileId)) return Chunks.count(f.size);
            Set<Long> h = s.have.get(fileId);
            return h == null ? 0 : h.size();
        }
    }

    public void writeChunk(String sid, long fileId, long index, byte[] plain) throws IOException {
        Session s = require(sid);
        Manifest.FileEntry f = s.files.get(fileId);
        if (f == null) throw new ChunkRange("unknown fileId " + fileId);
        long count = Chunks.count(f.size);
        if (index < 0 || index >= count) throw new ChunkRange("chunk index " + index + " out of range");
        long expected = index == count - 1 ? f.size - index * Chunks.CHUNK_SIZE : Chunks.CHUNK_SIZE;
        if (plain.length != expected) throw new ChunkRange("chunk " + index + " must be " + expected + " bytes, got " + plain.length);
        synchronized (s) {
            if (s.done.containsKey(fileId)) return;
        }
        File part = new File(sessionDir(sid), fileId + ".part");
        try (FileChannel ch = FileChannel.open(part.toPath(), StandardOpenOption.CREATE, StandardOpenOption.WRITE)) {
            ByteBuffer buf = ByteBuffer.wrap(plain);
            long pos = index * Chunks.CHUNK_SIZE;
            while (buf.hasRemaining()) pos += ch.write(buf, pos);
            ch.force(true);
        }
        synchronized (s) {
            Set<Long> h = s.have.get(fileId);
            if (s.done.containsKey(fileId) || (h != null && h.contains(index))) return;
            append(sid, s, rec("c", java.util.Arrays.asList(fileId, index)));
        }
    }

    private void resetFile(String sid, Session s, long fileId) throws IOException {
        record(sid, s, rec("x", fileId));
        Files.deleteIfExists(new File(sessionDir(sid), fileId + ".part").toPath());
    }

    private static String hash(InputStream in, long size) throws IOException {
        MessageDigest md;
        try {
            md = MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
        byte[] buf = new byte[HASH_BUF];
        long total = 0;
        for (int n; (n = in.read(buf)) > 0; ) {
            md.update(buf, 0, n);
            total += n;
        }
        return total == size ? Hex.of(md.digest()) : "size-mismatch";
    }

    /** A crash after a file landed but before "done" was recorded: accept it if its content matches. */
    private String recover(String sid, Session s, Manifest.FileEntry f, String rel) throws IOException {
        File part = new File(sessionDir(sid), f.fileId + ".part");
        if (part.exists()) return null; // not moved yet: finalize normally
        try (InputStream in = sink.open(rel)) {
            if (in == null || !hash(in, f.size).equals(f.sha256)) return null;
        }
        record(sid, s, rec("d", java.util.Arrays.asList(f.fileId, rel)));
        return rel;
    }

    /** Verifies the file's SHA-256 and lands it; returns its inbox-relative path. Idempotent. */
    public String finalize(String sid, long fileId) throws IOException {
        Session s = require(sid);
        Manifest.FileEntry f = s.files.get(fileId);
        if (f == null) throw new ChunkRange("unknown fileId " + fileId);
        synchronized (s.fileLock(fileId)) {
            String pendingRel;
            synchronized (s) {
                String done = s.done.get(fileId);
                if (done != null) return done;
                pendingRel = s.pending.get(fileId);
                long count = Chunks.count(f.size);
                Set<Long> h = s.have.get(fileId);
                if (pendingRel == null) {
                    for (long i = 0; i < count; i++) if (h == null || !h.contains(i)) throw new Incomplete("file " + fileId + " is missing chunk " + i);
                }
            }
            if (pendingRel != null) {
                String r = recover(sid, s, f, pendingRel);
                if (r != null) return r;
                synchronized (s) {
                    Set<Long> h = s.have.get(fileId);
                    for (long i = 0; i < Chunks.count(f.size); i++) if (h == null || !h.contains(i)) throw new Incomplete("file " + fileId + " is missing chunk " + i);
                }
            }
            File part = new File(sessionDir(sid), fileId + ".part");
            if (f.size == 0 && !part.exists()) new RandomAccessFile(part, "rw").close();
            String actual;
            try (InputStream in = new FileInputStream(part)) {
                actual = hash(in, f.size);
            } catch (java.io.FileNotFoundException e) {
                resetFile(sid, s, fileId);
                throw new Incomplete("file " + fileId + ": partial data is missing");
            }
            if (!actual.equals(f.sha256)) {
                resetFile(sid, s, fileId);
                throw new IntegrityError("sha256 mismatch for file " + fileId);
            }
            List<String> parts = destParts(s, f.path, false);
            String base = parts.remove(parts.size() - 1);
            String dir = String.join("/", parts);
            sink.mkdirs(dir);
            for (;;) {
                String name = Sanitize.uniqueName(base, n -> taken(dir.isEmpty() ? n : dir + "/" + n));
                String rel = dir.isEmpty() ? name : dir + "/" + name;
                record(sid, s, rec("p", java.util.Arrays.asList(fileId, rel)));
                String landed = sink.publishAs(rel, part, f.mime);
                if (landed == null) continue; // lost a race for this name; pick the next
                record(sid, s, rec("d", java.util.Arrays.asList(fileId, landed)));
                Files.deleteIfExists(part.toPath());
                return landed;
            }
        }
    }

    /** Creates the manifest's empty directories. */
    public void finalizeDirs(String sid) throws IOException {
        Session s = require(sid);
        for (String d : s.manifest.dirs) sink.mkdirs(String.join("/", destParts(s, d, true)));
    }

    public List<Long> completed(String sid) throws IOException {
        Session s = require(sid);
        synchronized (s) {
            List<Long> out = new ArrayList<>(s.done.keySet());
            out.sort(null);
            return out;
        }
    }

    /** Landed path of a finalized file, or null. */
    public String landed(String sid, long fileId) throws IOException {
        Session s = require(sid);
        synchronized (s) {
            return s.done.get(fileId);
        }
    }

    /** The local reference for a landed file (see InboxSink.locate). */
    public String locate(String rel) {
        return sink.locate(rel);
    }

    // ---- tombstones, pruning, cancel -------------------------------------------------------------

    public void markFinished(String sid, String from, List<String> files) throws IOException {
        sessionDir(sid);
        Map<String, Object> j = new LinkedHashMap<>();
        j.put("from", from);
        j.put("files", new ArrayList<Object>(files));
        Atomic.write(new File(new File(state, FINISHED_DIR), sid + ".json"), Json.stringify(j).getBytes(StandardCharsets.UTF_8));
        pruneTombstones();
    }

    @SuppressWarnings("unchecked")
    public Tombstone finished(String sid) throws IOException {
        sessionDir(sid);
        File f = new File(new File(state, FINISHED_DIR), sid + ".json");
        if (!f.isFile()) return null;
        try {
            Map<String, Object> j = (Map<String, Object>) Json.parse(Io.readString(f.toPath()));
            if (!(j.get("from") instanceof String) || !(j.get("files") instanceof List)) return null;
            List<String> files = new ArrayList<>();
            for (Object o : (List<Object>) j.get("files")) {
                if (!(o instanceof String)) return null;
                files.add((String) o);
            }
            return new Tombstone((String) j.get("from"), files);
        } catch (RuntimeException e) {
            return null;
        }
    }

    private void pruneTombstones() {
        File dir = new File(state, FINISHED_DIR);
        File[] list = dir.listFiles();
        if (list == null) return;
        long cutoff = System.currentTimeMillis() - FINISHED_TTL_MS;
        for (File f : list) if (f.getName().endsWith(".json") && f.lastModified() < cutoff) f.delete();
    }

    /** Deletes partial sessions untouched for `maxAgeMs` and stale tombstones; returns the pruned ids. */
    public List<String> prune(long maxAgeMs) throws IOException {
        List<String> pruned = new ArrayList<>();
        String[] names = state.list();
        if (names != null) {
            Arrays.sort(names);
            long cutoff = System.currentTimeMillis() - maxAgeMs;
            for (String name : names) {
                if (!Offer.SESSION_ID.matcher(name).matches()) continue;
                File dir = new File(state, name);
                long newest = Long.MIN_VALUE;
                for (File p : new File[] {dir, new File(dir, "state.json"), new File(dir, LOG)}) if (p.exists()) newest = Math.max(newest, p.lastModified());
                if (newest == Long.MIN_VALUE || newest >= cutoff) continue;
                drop(name);
                pruned.add(name);
            }
        }
        pruneTombstones();
        return pruned;
    }

    /** Drops a session and its partial data (cancel). */
    public void drop(String sid) throws IOException {
        File dir = sessionDir(sid);
        synchronized (sessions) {
            sessions.remove(sid);
            deleteTree(dir);
        }
    }

    private static void deleteTree(File f) throws IOException {
        if (!f.exists() && !Files.isSymbolicLink(f.toPath())) return;
        if (f.isDirectory() && !Files.isSymbolicLink(f.toPath())) {
            File[] kids = f.listFiles();
            if (kids != null) for (File k : kids) deleteTree(k);
        }
        Files.deleteIfExists(f.toPath());
    }
}
