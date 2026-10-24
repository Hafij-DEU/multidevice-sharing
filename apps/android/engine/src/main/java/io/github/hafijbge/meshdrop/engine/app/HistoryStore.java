package io.github.hafijbge.meshdrop.engine.app;

import io.github.hafijbge.meshdrop.engine.util.Atomic;
import io.github.hafijbge.meshdrop.engine.util.Json;
import io.github.hafijbge.meshdrop.engine.util.Io;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
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

    @SuppressWarnings("unchecked")
    public HistoryStore(File file, int cap) {
        this.file = file;
        this.cap = cap;
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
        Map<String, Object> r = new LinkedHashMap<>();
        r.put("at", at);
        r.put("from", from);
        r.put("alias", alias);
        r.put("files", new ArrayList<Object>(files));
        if (text != null) r.put("text", text);
        if (clipboard) r.put("clipboard", true);
        records.add(0, r);
        while (records.size() > cap) records.remove(records.size() - 1);
        Atomic.write(file, Json.stringify(records).getBytes(StandardCharsets.UTF_8));
    }

    public synchronized List<Map<String, Object>> received() {
        List<Map<String, Object>> out = new ArrayList<>();
        for (Map<String, Object> r : records) out.add(new LinkedHashMap<>(r));
        return out;
    }
}
