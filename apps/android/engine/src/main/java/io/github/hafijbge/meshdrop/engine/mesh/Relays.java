package io.github.hafijbge.meshdrop.engine.mesh;

import io.github.hafijbge.meshdrop.engine.util.Atomic;
import io.github.hafijbge.meshdrop.engine.util.Json;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.PublicKey;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Relay hubs (M9a), same as packages/core/src/mesh/relays.ts: the main hub names members that also
 * run a hub server, in a list of its own signed by the mesh root (domain meshdrop-relays-v1):
 * {v:1, mesh, version, issuedAt, relays:[{deviceId, urls:[wss://…]}]}, sent as {sig, list}.
 */
public final class Relays {
    public static final String DOMAIN = "meshdrop-relays-v1";
    public static final int MAX_RELAYS = 8;
    private static final Pattern HEX64 = Pattern.compile("^[0-9a-f]{64}$");

    private Relays() {}

    public static final class Relay {
        public final String deviceId;
        public final List<String> urls;

        public Relay(String deviceId, List<String> urls) {
            this.deviceId = deviceId;
            this.urls = Collections.unmodifiableList(new ArrayList<>(urls));
        }
    }

    public static final class ListView {
        public final String mesh;
        public final long version;
        public final List<Relay> relays;

        ListView(String mesh, long version, List<Relay> relays) {
            this.mesh = mesh;
            this.version = version;
            this.relays = Collections.unmodifiableList(relays);
        }
    }

    public static final class RelayListError extends IllegalArgumentException {
        public RelayListError(String m) {
            super(m);
        }
    }

    /** The validated list in the exact shape the main hub signed (same keys and order as the Node engine). */
    @SuppressWarnings("unchecked")
    static Map<String, Object> normalize(Object o) {
        if (!(o instanceof Map)) throw new RelayListError("invalid relay list");
        Map<String, Object> x = (Map<String, Object>) o;
        if (!Long.valueOf(1).equals(x.get("v"))) throw new RelayListError("invalid relay list");
        if (!(x.get("mesh") instanceof String) || ((String) x.get("mesh")).isEmpty()) throw new RelayListError("invalid relay list: mesh");
        if (!(x.get("version") instanceof Long) || (Long) x.get("version") < 1) throw new RelayListError("invalid relay list: version");
        if (!(x.get("issuedAt") instanceof Long) || (Long) x.get("issuedAt") < 0) throw new RelayListError("invalid relay list: issuedAt");
        if (!(x.get("relays") instanceof List) || ((List<Object>) x.get("relays")).size() > MAX_RELAYS) throw new RelayListError("invalid relay list: relays");
        List<Object> relays = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (Object r : (List<Object>) x.get("relays")) {
            if (!(r instanceof Map)) throw new RelayListError("invalid relay list: relay");
            Map<String, Object> rm = (Map<String, Object>) r;
            Object id = rm.get("deviceId");
            if (!(id instanceof String) || !HEX64.matcher((String) id).matches() || !seen.add((String) id)) throw new RelayListError("invalid relay list: relay");
            if (!(rm.get("urls") instanceof List) || ((List<Object>) rm.get("urls")).size() > 4) throw new RelayListError("invalid relay list: urls");
            List<Object> urls = new ArrayList<>();
            for (Object u : (List<Object>) rm.get("urls")) {
                if (!(u instanceof String) || ((String) u).length() > 512) throw new RelayListError("invalid relay list: url");
                String s = (String) u;
                if (!s.startsWith("wss://") && !s.startsWith("ws://")) throw new RelayListError("invalid relay list: url must be wss://");
                urls.add(s);
            }
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("deviceId", id);
            out.put("urls", urls);
            relays.add(out);
        }
        Map<String, Object> n = new LinkedHashMap<>();
        n.put("v", 1L);
        n.put("mesh", x.get("mesh"));
        n.put("version", x.get("version"));
        n.put("issuedAt", x.get("issuedAt"));
        n.put("relays", relays);
        return n;
    }

    /** The list, if `signed` is a relay list for `mesh` signed by the mesh root `anchor`. */
    @SuppressWarnings("unchecked")
    public static ListView verify(Object signed, PublicKey anchor, String mesh) {
        if (!(signed instanceof Map) || !(((Map<String, Object>) signed).get("sig") instanceof String)) throw new RelayListError("malformed signed relay list");
        Map<String, Object> s = (Map<String, Object>) signed;
        Map<String, Object> list = normalize(s.get("list"));
        if (!mesh.equals(list.get("mesh"))) throw new RelayListError("relay list for another mesh");
        byte[] payload = Canonical.json(list).getBytes(StandardCharsets.UTF_8);
        if (!Canonical.verify(DOMAIN, payload, (String) s.get("sig"), anchor)) throw new RelayListError("relay list signature does not verify");
        List<Relay> relays = new ArrayList<>();
        for (Object r : (List<Object>) list.get("relays")) {
            Map<String, Object> rm = (Map<String, Object>) r;
            List<String> urls = new ArrayList<>();
            for (Object u : (List<Object>) rm.get("urls")) urls.add((String) u);
            relays.add(new Relay((String) rm.get("deviceId"), urls));
        }
        return new ListView(mesh, (Long) list.get("version"), relays);
    }

    /** The newest verified relay list this device has seen ({@code <home>/relays.json}). */
    public static final class Store {
        private final File file;
        private Object signed;

        public Store(File home) {
            file = new File(home, "relays.json");
            try {
                signed = Json.parse(new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8));
            } catch (IOException | RuntimeException e) {
                signed = null;
            }
        }

        /** Verified against the mesh: a stored list that no longer verifies counts as none. */
        public synchronized ListView list(PublicKey anchor, String mesh) {
            if (signed == null) return null;
            try {
                return verify(signed, anchor, mesh);
            } catch (RuntimeException e) {
                return null;
            }
        }

        /** Keeps `s` if it verifies and is newer: "updated", "same" or "stale". */
        public synchronized String accept(Object s, PublicKey anchor, String mesh) throws IOException {
            ListView l = verify(s, anchor, mesh);
            ListView cur = list(anchor, mesh);
            if (cur != null && cur.version > l.version) return "stale";
            if (cur != null && cur.version == l.version) return "same";
            signed = s;
            Atomic.write(file, Json.stringify(s).getBytes(StandardCharsets.UTF_8));
            return "updated";
        }
    }
}
