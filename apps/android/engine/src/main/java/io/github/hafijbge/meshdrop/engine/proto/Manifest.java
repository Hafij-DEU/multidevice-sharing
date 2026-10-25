package io.github.hafijbge.meshdrop.engine.proto;

import io.github.hafijbge.meshdrop.engine.util.Json;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/** The session manifest (HPKE plaintext at seq 0), serialized with the fixed key order of docs/protocol.md. */
public final class Manifest {
    public static final int MAX_FILES = 100_000;
    public static final int MAX_DIRS = 100_000;
    public static final int MAX_TEXT_BYTES = 1024 * 1024;
    public static final Pattern DEVICE_ID = Pattern.compile("^[0-9a-f]{64}$");
    static final Pattern SHA256_HEX = Pattern.compile("^[0-9a-f]{64}$");
    private static final long U32_MAX = 0xffffffffL;
    private static final long MAX_SAFE = 9007199254740991L;

    public static final class FileEntry {
        public final long fileId;
        public final String path;
        public final long size;
        public final String mime;
        public final String sha256;

        public FileEntry(long fileId, String path, long size, String mime, String sha256) {
            this.fileId = fileId;
            this.path = path;
            this.size = size;
            this.mime = mime;
            this.sha256 = sha256;
        }
    }

    public int v = 1;
    public String sessionId;
    public String from;
    public String to;
    public long createdAt;
    public final List<FileEntry> files = new ArrayList<>();
    /** Empty directories (paths). */
    public final List<String> dirs = new ArrayList<>();
    public String text;
    public boolean clipboard;
    /** Photo backup (M8b): the receiver files it in its backup folder, not the inbox. */
    public boolean backup;
    /** Copied files or an image: the receiver puts them (saved in its inbox) on its clipboard. */
    public boolean clipboardFiles;
    /** M11 burn after reading: the receiver deletes the files a few minutes after they are first opened. */
    public boolean burn;
    /** M11: the receiver prints the files (if it allows printing for the sender). */
    public boolean print;

    public Map<String, Object> toMap() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("v", (long) v);
        m.put("sessionId", sessionId);
        m.put("from", from);
        m.put("to", to);
        m.put("createdAt", createdAt);
        List<Object> fs = new ArrayList<>(files.size());
        for (FileEntry f : files) {
            Map<String, Object> e = new LinkedHashMap<>();
            e.put("fileId", f.fileId);
            e.put("path", f.path);
            e.put("size", f.size);
            e.put("mime", f.mime);
            e.put("sha256", f.sha256);
            fs.add(e);
        }
        m.put("files", fs);
        List<Object> ds = new ArrayList<>(dirs.size());
        for (String d : dirs) {
            Map<String, Object> e = new LinkedHashMap<>();
            e.put("path", d);
            ds.add(e);
        }
        m.put("dirs", ds);
        if (text != null) m.put("text", text);
        if (clipboard) m.put("clipboard", true);
        if (backup) m.put("backup", true);
        if (clipboardFiles) m.put("clipboardFiles", true);
        if (burn) m.put("burn", true);
        if (print) m.put("print", true);
        return m;
    }

    public String toJson() {
        return Json.stringify(toMap());
    }

    public FileEntry file(long fileId) {
        for (FileEntry f : files) if (f.fileId == fileId) return f;
        return null;
    }

    /** Parses and validates manifest bytes (422 bad-offer on anything malformed). */
    public static Manifest parse(byte[] utf8) {
        Object x;
        try {
            x = Json.parse(new String(utf8, StandardCharsets.UTF_8));
        } catch (Json.JsonException e) {
            throw Offer.BadOffer.badOffer("manifest json");
        }
        return fromJson(x);
    }

    private static Offer.BadOffer bad(String what) {
        return Offer.BadOffer.badOffer("invalid manifest: " + what);
    }

    private static long integer(Object o, long min, long max, String what) {
        if (!(o instanceof Long)) throw bad(what);
        long v = (Long) o;
        if (v < min || v > max) throw bad(what);
        return v;
    }

    @SuppressWarnings("unchecked")
    public static Manifest fromJson(Object x) {
        if (!(x instanceof Map)) throw bad("not an object");
        Map<String, Object> o = (Map<String, Object>) x;
        if (!Long.valueOf(1).equals(o.get("v"))) throw bad("v must be 1");
        Manifest m = new Manifest();
        Object sid = o.get("sessionId"), from = o.get("from"), to = o.get("to");
        if (!(sid instanceof String) || !Offer.SESSION_ID.matcher((String) sid).matches()) throw bad("sessionId");
        if (!(from instanceof String) || !DEVICE_ID.matcher((String) from).matches()) throw bad("from");
        if (!(to instanceof String) || !DEVICE_ID.matcher((String) to).matches()) throw bad("to");
        m.sessionId = (String) sid;
        m.from = (String) from;
        m.to = (String) to;
        m.createdAt = integer(o.get("createdAt"), 0, MAX_SAFE, "createdAt");
        if (!(o.get("files") instanceof List)) throw bad("files");
        if (!(o.get("dirs") instanceof List)) throw bad("dirs");
        List<Object> files = (List<Object>) o.get("files");
        List<Object> dirs = (List<Object>) o.get("dirs");
        Object text = o.get("text");
        if (o.containsKey("text") && !(text instanceof String)) throw bad("text");
        if (files.size() > MAX_FILES) throw bad("too many files");
        if (dirs.size() > MAX_DIRS) throw bad("too many dirs");
        if (text != null && ((String) text).getBytes(StandardCharsets.UTF_8).length > MAX_TEXT_BYTES) throw bad("text too large");
        if (o.containsKey("clipboard")) {
            if (!Boolean.TRUE.equals(o.get("clipboard")) || text == null || !files.isEmpty() || !dirs.isEmpty()) throw bad("clipboard");
            m.clipboard = true;
        }
        if (o.containsKey("backup")) {
            if (!Boolean.TRUE.equals(o.get("backup"))) throw bad("backup");
            m.backup = true;
        }
        if (o.containsKey("clipboardFiles")) {
            if (!Boolean.TRUE.equals(o.get("clipboardFiles")) || files.isEmpty()) throw bad("clipboardFiles");
            m.clipboardFiles = true;
        }
        if (o.containsKey("burn")) {
            if (!Boolean.TRUE.equals(o.get("burn"))) throw bad("burn");
            m.burn = true;
        }
        if (o.containsKey("print")) {
            if (!Boolean.TRUE.equals(o.get("print")) || files.isEmpty()) throw bad("print");
            m.print = true;
        }
        Set<Long> ids = new HashSet<>();
        for (Object fo : files) {
            if (!(fo instanceof Map)) throw bad("file entry");
            Map<String, Object> f = (Map<String, Object>) fo;
            long id = integer(f.get("fileId"), 0, U32_MAX, "fileId");
            if (!ids.add(id)) throw bad("duplicate fileId");
            if (!(f.get("path") instanceof String)) throw bad("file path");
            long size = integer(f.get("size"), 0, MAX_SAFE, "file size");
            if (!(f.get("mime") instanceof String)) throw bad("file mime");
            Object sha = f.get("sha256");
            if (!(sha instanceof String) || !SHA256_HEX.matcher((String) sha).matches()) throw bad("file sha256");
            m.files.add(new FileEntry(id, (String) f.get("path"), size, (String) f.get("mime"), (String) sha));
        }
        for (Object d : dirs) {
            if (!(d instanceof Map) || !(((Map<String, Object>) d).get("path") instanceof String)) throw bad("dir entry");
            m.dirs.add((String) ((Map<String, Object>) d).get("path"));
        }
        m.text = (String) text;
        return m;
    }
}
