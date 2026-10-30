package io.github.hafijbge.meshdrop.engine.app;

import io.github.hafijbge.meshdrop.engine.util.Atomic;
import io.github.hafijbge.meshdrop.engine.util.Json;
import io.github.hafijbge.meshdrop.engine.util.Io;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** What this device received, newest first, capped (same JSON as the desktop's desktop-history.json). */
public final class HistoryStore {
    private final File file;
    private final int cap;
    private final List<Map<String, Object>> records = new ArrayList<>();

    public HistoryStore(File file) {
        this(file, 500);
    }

    /** Reads nothing yet: the file is parsed on first use, so building the store on Android's main thread does no disk I/O. */
    public HistoryStore(File file, int cap) {
        this.file = file;
        this.cap = cap;
    }

    private boolean loaded;

    @SuppressWarnings("unchecked")
    private void ensureLoaded() {
        if (loaded) return;
        loaded = true;
        try {
            Object j = Json.parse(Io.readString(file.toPath()));
            if (j instanceof List) {
                for (Object o : (List<Object>) j) {
                    if (!(o instanceof Map)) continue;
                    Map<String, Object> r = (Map<String, Object>) o;
                    if (r.get("at") instanceof Long && r.get("from") instanceof String && r.get("alias") instanceof String && r.get("files") instanceof List) {
                        records.add(r);
                    }
                    if (records.size() >= cap) break;
                }
            }
        } catch (IOException | RuntimeException e) {
            // missing or damaged: empty
        }
    }

    public synchronized void addReceived(long at, String from, String alias, List<String> files, String text, boolean clipboard) throws IOException {
        addReceived(at, from, alias, files, text, clipboard, null, false);
    }

    /** The folder the history lives in (M11: the time capsule keeps its list next to it). */
    public File dir() {
        return file.getParentFile();
    }

    /** M11: the first open of `ref` (the records it was in, with their changes), or none. */
    public synchronized List<Map<String, Object>> opened(String ref, long now, long burnAfterMs) throws IOException {
        ensureLoaded();
        List<Map<String, Object>> hit = new ArrayList<>();
        for (Map<String, Object> r : records) {
            if (r.get("openedAt") != null || !(r.get("files") instanceof List) || !((List<?>) r.get("files")).contains(ref)) continue;
            r.put("openedAt", now);
            if (Boolean.TRUE.equals(r.get("burn"))) r.put("burnAt", now + burnAfterMs);
            hit.add(new LinkedHashMap<>(r));
        }
        if (!hit.isEmpty()) Atomic.write(file, Json.stringify(records).getBytes(StandardCharsets.UTF_8));
        return hit;
    }

    /** M11: burn-after-reading records whose time came; they are marked burned and their files returned. */
    @SuppressWarnings("unchecked")
    public synchronized List<String> burnDue(long now, long unopenedMs) throws IOException {
        ensureLoaded();
        List<String> out = new ArrayList<>();
        for (Map<String, Object> r : records) {
            if (!Boolean.TRUE.equals(r.get("burn")) || Boolean.TRUE.equals(r.get("burned"))) continue;
            Object b = r.get("burnAt");
            long at = r.get("at") instanceof Long ? (Long) r.get("at") : 0;
            if (!((b instanceof Long && (Long) b <= now) || at + unopenedMs <= now)) continue;
            for (Object f : (List<Object>) r.get("files")) out.add(String.valueOf(f));
            r.put("files", new ArrayList<>());
            r.remove("text");
            r.put("burned", true);
        }
        if (!out.isEmpty()) Atomic.write(file, Json.stringify(records).getBytes(StandardCharsets.UTF_8));
        return out;
    }

    public synchronized void addReceived(long at, String from, String alias, List<String> files, String text, boolean clipboard, String sessionId, boolean burn) throws IOException {
        ensureLoaded();
        Map<String, Object> r = new LinkedHashMap<>();
        r.put("at", at);
        r.put("from", from);
        r.put("alias", alias);
        r.put("files", new ArrayList<Object>(files));
        if (text != null) r.put("text", text);
        if (clipboard) r.put("clipboard", true);
        if (sessionId != null) r.put("sessionId", sessionId);
        if (burn) r.put("burn", true);
        records.add(0, r);
        while (records.size() > cap) records.remove(records.size() - 1);
        Atomic.write(file, Json.stringify(records).getBytes(StandardCharsets.UTF_8));
    }

    public synchronized List<Map<String, Object>> received() {
        ensureLoaded();
        List<Map<String, Object>> out = new ArrayList<>();
        for (Map<String, Object> r : records) out.add(new LinkedHashMap<>(r));
        return out;
    }
}
