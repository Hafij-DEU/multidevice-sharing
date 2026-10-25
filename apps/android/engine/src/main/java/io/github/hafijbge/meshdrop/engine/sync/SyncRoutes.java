package io.github.hafijbge.meshdrop.engine.sync;

import io.github.hafijbge.meshdrop.engine.proto.Sanitize;
import io.github.hafijbge.meshdrop.engine.recv.MeshServer;
import io.github.hafijbge.meshdrop.engine.util.Json;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Folder sync routes (mesh/v1/sync/..., LAN only, partners ticked here only), as sync/server.ts:
 *   GET  sync/index                          {v:1, files:[{rel,size,mtime,hash}]}
 *   GET  sync/file?rel=&hash=&offset=&len=   raw bytes (len <= 4 MiB); 409 'changed' if the hash differs
 *   POST sync/poke                           the partner pulls soon (204)
 */
public final class SyncRoutes implements MeshServer.SyncHandler {
    private final SyncState state;
    /** The opened folder for a sync name, or null. */
    private final java.util.function.Function<String, SyncFolder> folder;
    /** The partner asked us to pull: (peer, folder name or null for all shared folders). */
    private final java.util.function.BiConsumer<String, String> onPoke;

    public SyncRoutes(SyncState state, java.util.function.Function<String, SyncFolder> folder, java.util.function.BiConsumer<String, String> onPoke) {
        this.state = state;
        this.folder = folder;
        this.onPoke = onPoke;
    }

    private static MeshServer.Reply json(int status, Object v) {
        return new MeshServer.Reply(status, v == null ? null : Json.stringify(v).getBytes(StandardCharsets.UTF_8));
    }

    private static MeshServer.Reply err(int status, String code) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("error", code);
        return json(status, m);
    }

    @Override
    public MeshServer.Reply handle(String peer, String method, String[] seg, Map<String, String> q) throws IOException {
        // ?f=<name> picks the folder; without it (a 0.3.0 partner) the first folder shared with the peer.
        String f = q.get("f");
        SyncState.FolderConfig cfg = null;
        boolean any = false;
        for (SyncState.FolderConfig c : state.folders()) {
            if (c.partners.contains(peer)) any = true;
            if (f == null ? cfg == null && c.partners.contains(peer) : c.name.equals(f)) cfg = c;
        }
        if (method.equals("POST") && seg.length == 1 && seg[0].equals("poke")) {
            if (!any) return err(403, "not-a-sync-partner");
            onPoke.accept(peer, f);
            return json(204, null);
        }
        if (cfg == null) return err(404, "no-such-folder");
        if (!cfg.partners.contains(peer)) return err(403, "not-a-sync-partner");
        SyncFolder sf = folder.apply(cfg.name);
        if (sf == null) return err(404, "no-such-folder");
        String name = cfg.name;
        if (method.equals("GET") && seg.length == 1 && seg[0].equals("index")) {
            Map<String, SyncState.FileState> files = SyncState.scan(sf, state.cache(name));
            state.setCache(name, files);
            List<Object> l = new ArrayList<>();
            for (SyncState.FileState st : files.values()) l.add(st.toMap());
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("v", 1L);
            m.put("files", l);
            return json(200, m);
        }
        if (method.equals("GET") && seg.length == 1 && seg[0].equals("file")) {
            String rel;
            long offset;
            long len;
            try {
                rel = Sanitize.safeRelPath(q.containsKey("rel") ? q.get("rel") : "");
                offset = Long.parseLong(q.containsKey("offset") ? q.get("offset") : "0");
                len = Long.parseLong(q.containsKey("len") ? q.get("len") : String.valueOf(SyncRound.SLICE));
            } catch (RuntimeException e) {
                return err(400, "bad-request");
            }
            if (rel.isEmpty() || SyncIgnore.ignored(rel) || offset < 0 || len < 1 || len > SyncRound.SLICE) return err(400, "bad-request");
            SyncState.FileState st = SyncState.fileState(sf, rel, state.cache(name));
            if (st == null) return err(404, "not-found");
            if (!st.hash.equals(q.get("hash"))) return err(409, "changed");
            int n = (int) Math.max(0, Math.min(len, st.size - offset));
            byte[] buf = new byte[n];
            int off = 0;
            try (InputStream in = sf.open(rel)) {
                long skipped = 0;
                while (skipped < offset) {
                    long k = in.skip(offset - skipped);
                    if (k <= 0) break;
                    skipped += k;
                }
                while (off < n) {
                    int k = in.read(buf, off, n - off);
                    if (k < 0) break;
                    off += k;
                }
            }
            byte[] out = off == n ? buf : java.util.Arrays.copyOf(buf, off);
            return new MeshServer.Reply(200, out, "application/octet-stream");
        }
        return err(404, "not-found");
    }
}
