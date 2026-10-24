package io.github.hafijbge.meshdrop.engine.send;

import io.github.hafijbge.meshdrop.engine.identity.Identity;
import io.github.hafijbge.meshdrop.engine.net.TrustStore;
import io.github.hafijbge.meshdrop.engine.proto.Chunks;
import io.github.hafijbge.meshdrop.engine.proto.Manifest;
import io.github.hafijbge.meshdrop.engine.proto.Offer;
import io.github.hafijbge.meshdrop.engine.util.Atomic;
import io.github.hafijbge.meshdrop.engine.util.Json;
import io.github.hafijbge.meshdrop.engine.util.Io;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.function.Function;

/**
 * Unfinished sends, one owner-only JSON file per session (<home>/outbox/<sessionId>.json): the
 * byte-identical offer, the manifest, the sources (ref, size, mtime, chunk hashes) and the HPKE
 * context, so a send resumes after a pause, a failure or a restart.
 */
public final class Outbox {
    public static final class SourceRec {
        public final long fileId;
        public final String ref;
        public final long size;
        public final long mtime;
        public final List<String> chunks;

        SourceRec(long fileId, String ref, long size, long mtime, List<String> chunks) {
            this.fileId = fileId;
            this.ref = ref;
            this.size = size;
            this.mtime = mtime;
            this.chunks = chunks;
        }
    }

    public static final class Entry {
        public String sessionId;
        public long createdAt;
        public String targetId;
        public String targetHost;
        public int targetPort;
        public String targetKeyPem;
        public String itemsKey;
        public String offerJson;
        public Manifest manifest;
        public final List<SourceRec> sources = new ArrayList<>();
        public String ctxExport;
        public String lastError;

        Map<String, Object> toMap() {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("v", 1L);
            m.put("sessionId", sessionId);
            m.put("createdAt", createdAt);
            Map<String, Object> t = new LinkedHashMap<>();
            t.put("deviceId", targetId);
            if (targetHost != null) {
                t.put("host", targetHost);
                t.put("port", (long) targetPort);
            }
            t.put("publicKeyPem", targetKeyPem);
            m.put("target", t);
            m.put("itemsKey", itemsKey);
            m.put("offer", Json.parse(offerJson));
            m.put("manifest", manifest.toMap());
            List<Object> ss = new ArrayList<>();
            for (SourceRec s : sources) {
                Map<String, Object> x = new LinkedHashMap<>();
                x.put("fileId", s.fileId);
                x.put("ref", s.ref);
                x.put("size", s.size);
                x.put("mtimeMs", s.mtime);
                x.put("chunks", new ArrayList<Object>(s.chunks));
                ss.add(x);
            }
            m.put("sources", ss);
            m.put("ctxExport", ctxExport);
            if (lastError != null) m.put("lastError", lastError);
            return m;
        }

        @SuppressWarnings("unchecked")
        static Entry fromMap(Map<String, Object> m, String sessionId) {
            if (!Long.valueOf(1).equals(m.get("v")) || !sessionId.equals(m.get("sessionId"))) return null;
            Entry e = new Entry();
            e.sessionId = sessionId;
            e.createdAt = ((Number) m.get("createdAt")).longValue();
            Map<String, Object> t = (Map<String, Object>) m.get("target");
            e.targetId = (String) t.get("deviceId");
            if (t.get("host") instanceof String) {
                e.targetHost = (String) t.get("host");
                e.targetPort = ((Number) t.get("port")).intValue();
            }
            e.targetKeyPem = (String) t.get("publicKeyPem");
            e.itemsKey = (String) m.get("itemsKey");
            e.offerJson = Json.stringify(m.get("offer"));
            e.manifest = Manifest.fromJson(m.get("manifest"));
            if (!sessionId.equals(e.manifest.sessionId)) return null;
            for (Object o : (List<Object>) m.get("sources")) {
                Map<String, Object> s = (Map<String, Object>) o;
                List<String> chunks = new ArrayList<>();
                for (Object c : (List<Object>) s.get("chunks")) chunks.add((String) c);
                long size = ((Number) s.get("size")).longValue();
                if (chunks.size() != Chunks.count(size)) return null;
                e.sources.add(new SourceRec(((Number) s.get("fileId")).longValue(), (String) s.get("ref"), size, ((Number) s.get("mtimeMs")).longValue(), chunks));
            }
            e.ctxExport = (String) m.get("ctxExport");
            e.lastError = (String) m.get("lastError");
            return e;
        }
    }

    public final File dir;

    public Outbox(File dir) {
        this.dir = dir;
    }

    private File file(String sid) {
        if (!Offer.SESSION_ID.matcher(sid).matches()) throw new IllegalArgumentException("invalid sessionId");
        return new File(dir, sid + ".json");
    }

    public synchronized void save(Entry e) throws IOException {
        Atomic.write(file(e.sessionId), Json.stringify(e.toMap()).getBytes(StandardCharsets.UTF_8));
    }

    @SuppressWarnings("unchecked")
    public synchronized Entry load(String sid) {
        File f = file(sid);
        if (!f.isFile()) return null;
        try {
            return Entry.fromMap((Map<String, Object>) Json.parse(Io.readString(f.toPath())), sid);
        } catch (IOException | RuntimeException e) {
            return null;
        }
    }

    public synchronized void remove(String sid) throws IOException {
        Files.deleteIfExists(file(sid).toPath());
    }

    /** Valid entries, oldest first. */
    public List<Entry> list() {
        String[] names = dir.list();
        List<Entry> out = new ArrayList<>();
        if (names == null) return out;
        Arrays.sort(names);
        for (String n : names) {
            if (!n.endsWith(".json")) continue;
            String sid = n.substring(0, n.length() - 5);
            if (!Offer.SESSION_ID.matcher(sid).matches()) continue;
            Entry e = load(sid);
            if (e != null) out.add(e);
        }
        out.sort((a, b) -> Long.compare(a.createdAt, b.createdAt));
        return out;
    }

    public Entry findMatch(String deviceId, String itemsKey) {
        Entry hit = null;
        for (Entry e : list()) if (e.targetId.equals(deviceId) && e.itemsKey.equals(itemsKey)) hit = e;
        return hit;
    }

    public SendResult resumeEntry(Identity id, String sessionId, Sender.Target t, Sender.Options opts) {
        Entry e = load(sessionId);
        if (e == null) return new SendResult(t.deviceId, "failed", sessionId, "unknown-entry");
        return Sender.runSession(id, t, e, opts.withOutbox(this));
    }

    /** Resumes every entry concurrently; entries whose device cannot be resolved stay and fail 'target-unresolved'. */
    public List<SendResult> resumeAll(Identity id, Function<String, Sender.Target> resolve, Sender.Options opts) {
        List<Entry> entries = list();
        ExecutorService pool = Executors.newCachedThreadPool();
        try {
            List<Future<SendResult>> fs = new ArrayList<>();
            for (Entry e : entries) {
                fs.add(pool.submit(() -> {
                    Sender.Target t;
                    try {
                        t = resolve.apply(e.targetId);
                    } catch (RuntimeException x) {
                        t = null;
                    }
                    if (t == null) return new SendResult(e.targetId, "failed", e.sessionId, "target-unresolved");
                    return Sender.runSession(id, t, e, opts.withOutbox(this));
                }));
            }
            List<SendResult> out = new ArrayList<>();
            for (Future<SendResult> f : fs) {
                try {
                    out.add(f.get());
                } catch (InterruptedException | ExecutionException x) {
                    Thread.currentThread().interrupt();
                }
            }
            return out;
        } finally {
            pool.shutdown();
        }
    }

    static String pem(java.security.PublicKey k) {
        return TrustStore.pem(k);
    }
}
