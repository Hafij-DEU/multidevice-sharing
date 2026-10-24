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

    /** One synced folder: the name that matches it on the partners, where it is, and who it syncs with. */
    public static final class FolderConfig {
        public final String name;
        /** A path, or a picked folder's content URI. */
        public final String folder;
        public final List<String> partners;

        public FolderConfig(String name, String folder, List<String> partners) {
            this.name = name;
            this.folder = folder;
            this.partners = partners;
        }
    }

    public static final int MAX_FOLDERS = 16;
    private static final Pattern DEVICE_ID = Pattern.compile("^[0-9a-f]{64}$");
    private static final Pattern BAD_NAME = Pattern.compile("[\\u0000-\\u001f\\u007f/\\\\]");
    private final File dir;

    public SyncState(File home) {
        this.dir = new File(home, "sync");
    }

    /** A folder name: 1–64 characters, no control characters, no slash. */
    public static boolean validName(String n) {
        return n != null && n.trim().equals(n) && !n.isEmpty() && n.length() <= 64 && !BAD_NAME.matcher(n).find();
    }

    /** A default name for a path or picked folder URI: its last segment. */
    public static String defaultName(String folder) {
        String f = folder.replaceAll("/+$", "");
        try {
            f = java.net.URLDecoder.decode(f.replace("+", "%2B"), "UTF-8");
        } catch (IOException | IllegalArgumentException ignored) {
            // keep it encoded
        }
        String last = f.substring(Math.max(f.lastIndexOf('/'), f.lastIndexOf(':')) + 1).trim();
        String n = BAD_NAME.matcher(last).replaceAll("_");
        if (n.length() > 64) n = n.substring(0, 64).trim();
        return n.isEmpty() ? "Sync" : n;
    }

    private static String keyOf(String name) {
        try {
            return Hex.of(MessageDigest.getInstance("SHA-256").digest(name.getBytes(StandardCharsets.UTF_8))).substring(0, 16);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
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
    private static List<String> partnersOf(Object x) {
        List<String> out = new ArrayList<>();
        if (x instanceof List) for (Object p : (List<Object>) x) if (p instanceof String && DEVICE_ID.matcher((String) p).matches()) out.add((String) p);
        return out;
    }

    /** True while config.json is still the 0.3.0 one-folder {folder, partners}. */
    @SuppressWarnings("unchecked")
    private boolean legacy() {
        Object j = read("config.json");
        return j instanceof Map && ((Map<String, Object>) j).get("folder") instanceof String;
    }

    @SuppressWarnings("unchecked")
    public List<FolderConfig> folders() {
        Object j = read("config.json");
        List<FolderConfig> out = new ArrayList<>();
        if (!(j instanceof Map)) return out;
        Map<String, Object> m = (Map<String, Object>) j;
        if (m.get("folder") instanceof String) {
            String f = (String) m.get("folder");
            if (!f.isEmpty()) out.add(new FolderConfig(defaultName(f), f, partnersOf(m.get("partners"))));
            return out;
        }
        if (m.get("folders") instanceof List) {
            for (Object o : (List<Object>) m.get("folders")) {
                if (!(o instanceof Map)) continue;
                Map<String, Object> f = (Map<String, Object>) o;
                Object name = f.get("name");
                Object folder = f.get("folder");
                if (!(name instanceof String) || !validName((String) name) || !(folder instanceof String) || ((String) folder).isEmpty()) continue;
                boolean dup = false;
                for (FolderConfig x : out) dup |= x.name.equals(name);
                if (!dup) out.add(new FolderConfig((String) name, (String) folder, partnersOf(f.get("partners"))));
            }
        }
        return out;
    }

    public void setFolders(List<FolderConfig> folders) throws IOException {
        if (legacy()) {
            List<FolderConfig> cur = folders();
            if (!cur.isEmpty()) {
                Map<String, Object> l = new LinkedHashMap<>();
                l.put("name", cur.get(0).name);
                write("legacy.json", l);
            }
        }
        List<Object> list = new ArrayList<>();
        for (FolderConfig f : folders) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("name", f.name);
            m.put("folder", f.folder);
            m.put("partners", new ArrayList<Object>(f.partners));
            list.add(m);
        }
        Map<String, Object> root = new LinkedHashMap<>();
        root.put("folders", list);
        write("config.json", root);
    }

    /** The folder that took over the 0.3.0 files (its old cache and bases are still read). */
    @SuppressWarnings("unchecked")
    private String legacyName() {
        if (legacy()) {
            List<FolderConfig> f = folders();
            return f.isEmpty() ? null : f.get(0).name;
        }
        Object j = read("legacy.json");
        return j instanceof Map && ((Map<String, Object>) j).get("name") instanceof String ? (String) ((Map<String, Object>) j).get("name") : null;
    }

    @SuppressWarnings("unchecked")
    public Map<String, FileState> cache(String name) {
        Map<String, FileState> out = new LinkedHashMap<>();
        Object j = read("index-" + keyOf(name) + ".json");
        if (j == null && name.equals(legacyName())) j = read("index.json");
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

    public void setCache(String name, Map<String, FileState> m) throws IOException {
        List<Object> l = new ArrayList<>();
        for (FileState f : m.values()) l.add(f.toMap());
        write("index-" + keyOf(name) + ".json", l);
    }

    @SuppressWarnings("unchecked")
    public Map<String, String> base(String name, String partner) {
        if (!DEVICE_ID.matcher(partner).matches()) throw new IllegalArgumentException("invalid device id");
        Map<String, String> out = new LinkedHashMap<>();
        Object j = read("base-" + keyOf(name) + "-" + partner + ".json");
        if (j == null && name.equals(legacyName())) j = read("base-" + partner + ".json");
        if (j instanceof Map) for (Map.Entry<String, Object> e : ((Map<String, Object>) j).entrySet()) if (e.getValue() instanceof String) out.put(e.getKey(), (String) e.getValue());
        return out;
    }

    public void setBase(String name, String partner, Map<String, String> m) throws IOException {
        if (!DEVICE_ID.matcher(partner).matches()) throw new IllegalArgumentException("invalid device id");
        write("base-" + keyOf(name) + "-" + partner + ".json", new LinkedHashMap<String, Object>(m));
    }

    /** Forgets a folder's cache and bases (it was removed or renamed; its files stay). */
    public void forget(String name) {
        String k = keyOf(name);
        File[] files = dir.listFiles();
        if (files != null) for (File f : files) if (f.getName().equals("index-" + k + ".json") || f.getName().startsWith("base-" + k + "-")) f.delete();
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
