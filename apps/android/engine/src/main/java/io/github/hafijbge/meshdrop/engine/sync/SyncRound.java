package io.github.hafijbge.meshdrop.engine.sync;

import io.github.hafijbge.meshdrop.engine.net.Http;
import io.github.hafijbge.meshdrop.engine.proto.Sanitize;
import io.github.hafijbge.meshdrop.engine.send.Transport;
import io.github.hafijbge.meshdrop.engine.util.Json;
import java.io.IOException;
import java.io.OutputStream;
import java.net.URLEncoder;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TreeSet;
import java.util.function.BooleanSupplier;
import java.util.regex.Pattern;

/**
 * Folder sync: one pull round against one partner (sync/client.ts). Nothing is destroyed: replaced
 * and deleted files go to .meshdrop-trash/<round>/ for 30 days; a lost conflict is kept as a copy.
 */
public final class SyncRound {
    public static final String TRASH_DIR = ".meshdrop-trash";
    public static final String PARTIAL_DIR = ".meshdrop-partial";
    public static final int SLICE = 4 * 1024 * 1024;
    public static final long TRASH_MS = 30L * 24 * 3600 * 1000;
    private static final int TIMEOUT_MS = 60_000;
    private static final Pattern HASH = Pattern.compile("^[0-9a-f]{64}$");

    public static final class Result {
        public int pulled;
        public int deleted;
        public int conflicts;
        /** The scan found local changes since the last one (the partner should pull: poke it). */
        public boolean localChanged;
        public final List<String> errors = new ArrayList<>();
    }

    private SyncRound() {}

    private static String stamp(long ms) {
        Calendar c = Calendar.getInstance();
        c.setTimeInMillis(ms);
        return String.format(Locale.ROOT, "%04d-%02d-%02d_%02d-%02d-%02d", c.get(Calendar.YEAR), c.get(Calendar.MONTH) + 1, c.get(Calendar.DAY_OF_MONTH),
                c.get(Calendar.HOUR_OF_DAY), c.get(Calendar.MINUTE), c.get(Calendar.SECOND));
    }

    private static Http.Response get(Transport t, String path, BooleanSupplier aborted) throws IOException {
        return t.request("GET", path, null, null, TIMEOUT_MS, null, aborted);
    }

    @SuppressWarnings("unchecked")
    private static Map<String, SyncState.FileState> parseIndex(Object j) throws IOException {
        Map<String, SyncState.FileState> out = new LinkedHashMap<>();
        if (!(j instanceof Map) || !(((Map<String, Object>) j).get("files") instanceof List)) throw new IOException("bad sync index");
        for (Object o : (List<Object>) ((Map<String, Object>) j).get("files")) {
            if (!(o instanceof Map)) continue;
            Map<String, Object> m = (Map<String, Object>) o;
            if (!(m.get("rel") instanceof String) || !(m.get("hash") instanceof String) || !(m.get("size") instanceof Long)) continue;
            if (!(m.get("mtime") instanceof Long) && !(m.get("mtime") instanceof Double)) continue;
            String rel = (String) m.get("rel");
            String hash = (String) m.get("hash");
            long size = (Long) m.get("size");
            if (!HASH.matcher(hash).matches() || size < 0) continue;
            try {
                if (!Sanitize.safeRelPath(rel).equals(rel) || rel.isEmpty() || SyncIgnore.ignored(rel)) continue;
            } catch (RuntimeException e) {
                continue;
            }
            out.put(rel, new SyncState.FileState(rel, size, ((Number) m.get("mtime")).longValue(), hash));
        }
        return out;
    }

    private static String free(SyncFolder f, String dir, String name) throws IOException {
        IOException[] err = new IOException[1];
        String n = Sanitize.uniqueName(name, c -> {
            try {
                return f.exists(dir.isEmpty() ? c : dir + "/" + c);
            } catch (IOException e) {
                err[0] = e;
                return false;
            }
        });
        if (err[0] != null) throw err[0];
        return dir.isEmpty() ? n : dir + "/" + n;
    }

    private static String dirOf(String rel) {
        int i = rel.lastIndexOf('/');
        return i < 0 ? "" : rel.substring(0, i);
    }

    private static String nameOf(String rel) {
        return rel.substring(rel.lastIndexOf('/') + 1);
    }

    private static void toTrash(SyncFolder f, String rel, String round) throws IOException {
        String dir = TRASH_DIR + "/" + round + (dirOf(rel).isEmpty() ? "" : "/" + dirOf(rel));
        f.move(rel, free(f, dir, nameOf(rel)));
    }

    private static void download(SyncFolder f, Transport t, SyncState.FileState r, BooleanSupplier aborted) throws IOException {
        String part = r.hash;
        long have = f.partialSize(part);
        if (have > r.size) {
            f.deletePartial(part);
            have = -1;
        }
        try (OutputStream out = f.writePartial(part, have > 0)) {
            if (have < 0) have = 0;
            while (have < r.size) {
                long len = Math.min(SLICE, r.size - have);
                String q = "rel=" + URLEncoder.encode(r.rel, "UTF-8") + "&hash=" + r.hash + "&offset=" + have + "&len=" + len;
                Http.Response res = get(t, "/mesh/v1/sync/file?" + q, aborted);
                if (res.status == 409) throw new IOException("changed on the partner");
                if (res.status != 200 || res.body.length == 0) throw new IOException("http-" + res.status);
                out.write(res.body);
                have += res.body.length;
            }
        }
        if (!SyncState.hash(f.openPartial(part)).equals(r.hash)) {
            f.deletePartial(part);
            throw new IOException("integrity");
        }
    }

    private static boolean eq(String a, String b) {
        return a == null ? b == null : a.equals(b);
    }

    public static Result run(SyncFolder f, SyncState st, Transport t, String self, String partner, String partnerAlias, BooleanSupplier aborted, long now)
            throws IOException {
        String round = stamp(now);
        Map<String, SyncState.FileState> cache = st.cache();
        Map<String, SyncState.FileState> local = SyncState.scan(f, cache);
        boolean changed = local.size() != cache.size();
        for (SyncState.FileState s : local.values()) if (changed || !cache.containsKey(s.rel) || !cache.get(s.rel).hash.equals(s.hash)) changed = true;
        Http.Response res = get(t, "/mesh/v1/sync/index", aborted);
        if (res.status != 200) throw new IOException("sync: the partner answered " + res.status);
        Map<String, SyncState.FileState> remote;
        try {
            remote = parseIndex(Json.parse(res.text()));
        } catch (RuntimeException e) {
            throw new IOException("bad sync index");
        }
        Map<String, String> base = st.base(partner);
        Result out = new Result();
        out.localChanged = changed;
        TreeSet<String> rels = new TreeSet<>(local.keySet());
        rels.addAll(remote.keySet());
        rels.addAll(base.keySet());
        for (String rel : rels) {
            if (aborted != null && aborted.getAsBoolean()) break;
            SyncState.FileState l = local.get(rel);
            SyncState.FileState r = remote.get(rel);
            SyncMerge.Decision d = SyncMerge.decide(l == null ? null : l.hash, l == null ? 0 : l.mtime, r == null ? null : r.hash, r == null ? 0 : r.mtime,
                    base.get(rel), self, partner);
            try {
                if (d.kind == SyncMerge.Kind.KEEP) continue;
                if (d.kind != SyncMerge.Kind.AGREE) {
                    SyncState.FileState cur = SyncState.fileState(f, rel, cache);
                    if (!eq(cur == null ? null : cur.hash, l == null ? null : l.hash)) continue; // changed meanwhile: next round
                    if (d.kind == SyncMerge.Kind.CONFLICT_TAKE && l != null) {
                        f.move(rel, free(f, dirOf(rel), SyncMerge.conflictName(nameOf(rel), partnerAlias, now)));
                        local.remove(rel);
                        out.conflicts++;
                    }
                    if (r != null) {
                        download(f, t, r, aborted);
                        if (d.kind == SyncMerge.Kind.TAKE && l != null) toTrash(f, rel, round);
                        f.commitPartial(r.hash, rel, r.mtime);
                        local.put(rel, r);
                        out.pulled++;
                    } else if (l != null) {
                        toTrash(f, rel, round);
                        local.remove(rel);
                        out.deleted++;
                    }
                }
                if (d.base == null) base.remove(rel);
                else base.put(rel, d.base);
            } catch (IOException | RuntimeException e) {
                out.errors.add(rel + ": " + e.getMessage());
            }
        }
        st.setCache(local);
        st.setBase(partner, base);
        try {
            f.pruneTrash(now - TRASH_MS);
        } catch (IOException ignored) {
            // housekeeping
        }
        return out;
    }
}
