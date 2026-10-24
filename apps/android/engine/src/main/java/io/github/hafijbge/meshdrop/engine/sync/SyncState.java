package io.github.hafijbge.meshdrop.engine.sync;

import io.github.hafijbge.meshdrop.engine.util.Atomic;
import io.github.hafijbge.meshdrop.engine.util.Hex;
import io.github.hafijbge.meshdrop.engine.util.Json;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Folder sync: what is kept between rounds under <home>/sync/ (sync/store.ts): config.json {folder,
 * partners}, index.json (the hash cache) and base-<id>.json per partner {rel: hash}. Plus the scan.
 */
public final class SyncState {
    public static final class FileState {
        public final String rel;
        public final long size;
        public final long mtime;
        public final String hash;

        public FileState(String rel, long size, long mtime, String hash) {
            this.rel = rel;
            this.size = size;
            this.mtime = mtime;
            this.hash = hash;
        }

        Map<String, Object> toMap() {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("rel", rel);
            m.put("size", size);
            m.put("mtime", mtime);
            m.put("hash", hash);
            return m;
        }
    }

    public static final class Config {
        /** A path or content URI; "" while sync is off. */
        public final String folder;
        public final List<String> partners;

        public Config(String folder, List<String> partners) {
            this.folder = folder;
            this.partners = partners;
        }
    }

    private static final Pattern DEVICE_ID = Pattern.compile("^[0-9a-f]{64}$");
    private final File dir;

    public SyncState(File home) {
        this.dir = new File(home, "sync");
    }

    private Object read(String name) {
        try {
            return Json.parse(new String(Files.readAllBytes(new File(dir, name).toPath()), StandardCharsets.UTF_8));
        } catch (IOException | RuntimeException e) {
            return null;
        }
    }

    private synchronized void write(String name, Object v) throws IOException {
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("cannot create " + dir);
        Atomic.write(new File(dir, name), Json.stringify(v).getBytes(StandardCharsets.UTF_8));
    }

    @SuppressWarnings("unchecked")
    public Config config() {
        Object j = read("config.json");
        String folder = "";
        List<String> partners = new ArrayList<>();
        if (j instanceof Map) {
            Map<String, Object> m = (Map<String, Object>) j;
            if (m.get("folder") instanceof String) folder = (String) m.get("folder");
            if (m.get("partners") instanceof List) for (Object p : (List<Object>) m.get("partners")) if (p instanceof String && DEVICE_ID.matcher((String) p).matches()) partners.add((String) p);
        }
        return new Config(folder, partners);
    }

    public void setConfig(Config c) throws IOException {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("folder", c.folder);
        m.put("partners", new ArrayList<Object>(c.partners));
        write("config.json", m);
    }

    @SuppressWarnings("unchecked")
    public Map<String, FileState> cache() {
        Map<String, FileState> out = new LinkedHashMap<>();
        Object j = read("index.json");
        if (j instanceof List) {
            for (Object o : (List<Object>) j) {
                if (!(o instanceof Map)) continue;
                Map<String, Object> m = (Map<String, Object>) o;
                if (m.get("rel") instanceof String && m.get("hash") instanceof String && m.get("size") instanceof Long && m.get("mtime") instanceof Long) {
                    out.put((String) m.get("rel"), new FileState((String) m.get("rel"), (Long) m.get("size"), (Long) m.get("mtime"), (String) m.get("hash")));
                }
            }
        }
        return out;
    }

    public void setCache(Map<String, FileState> m) throws IOException {
        List<Object> l = new ArrayList<>();
        for (FileState f : m.values()) l.add(f.toMap());
        write("index.json", l);
    }

    @SuppressWarnings("unchecked")
    public Map<String, String> base(String partner) {
        if (!DEVICE_ID.matcher(partner).matches()) throw new IllegalArgumentException("invalid device id");
        Map<String, String> out = new LinkedHashMap<>();
        Object j = read("base-" + partner + ".json");
        if (j instanceof Map) for (Map.Entry<String, Object> e : ((Map<String, Object>) j).entrySet()) if (e.getValue() instanceof String) out.put(e.getKey(), (String) e.getValue());
        return out;
    }

    public void setBase(String partner, Map<String, String> m) throws IOException {
        if (!DEVICE_ID.matcher(partner).matches()) throw new IllegalArgumentException("invalid device id");
        write("base-" + partner + ".json", new LinkedHashMap<String, Object>(m));
    }

    // ---- scanning -------------------------------------------------------------------------------

    public static String hash(InputStream in) throws IOException {
        MessageDigest d;
        try {
            d = MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
        byte[] buf = new byte[64 * 1024];
        try (InputStream i = in) {
            for (int n; (n = i.read(buf)) > 0; ) d.update(buf, 0, n);
        }
        return Hex.of(d.digest());
    }

    /** Every syncable file with its hash; cached hashes are reused when size and mtime match. */
    public static Map<String, FileState> scan(SyncFolder f, Map<String, FileState> cache) throws IOException {
        Map<String, FileState> out = new LinkedHashMap<>();
        for (SyncFolder.Entry e : f.list(SyncIgnore::ignored)) {
            if (SyncIgnore.ignored(e.rel)) continue;
            FileState c = cache.get(e.rel);
            if (c != null && c.size == e.size && c.mtime == e.mtime) {
                out.put(e.rel, c);
                continue;
            }
            try {
                out.put(e.rel, new FileState(e.rel, e.size, e.mtime, hash(f.open(e.rel))));
            } catch (IOException x) {
                // gone or unreadable meanwhile: next scan
            }
        }
        return out;
    }

    /** One file's current state, or null. */
    public static FileState fileState(SyncFolder f, String rel, Map<String, FileState> cache) throws IOException {
        SyncFolder.Entry e = f.stat(rel);
        if (e == null) return null;
        FileState c = cache.get(rel);
        if (c != null && c.size == e.size && c.mtime == e.mtime) return c;
        return new FileState(rel, e.size, e.mtime, hash(f.open(rel)));
    }
}
