package io.github.hafijbge.meshdrop.engine.mesh;

import io.github.hafijbge.meshdrop.engine.net.TrustStore;
import java.nio.charset.StandardCharsets;
import java.security.PublicKey;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * The signed membership list (docs/protocol.md "Membership list"), ported from mesh/membership.ts:
 * strict validation (exact keys, one hub, no duplicates, a revoked id is never a member, at most 256
 * members) and verification against the mesh root key (the anchor).
 */
public final class Membership {
    public static final String DOMAIN = "meshdrop-membership-v1";
    public static final int MAX_MEMBERS = 256;
    private static final Pattern HEX_ID = Pattern.compile("^[0-9a-f]{64}$");
    private static final long MIN_SAFE = -9007199254740991L;

    public static final class MembershipError extends IllegalArgumentException {
        public MembershipError(String m) {
            super(m);
        }
    }

    public static final class Member {
        public final String deviceId;
        public final String alias;
        public final String publicKeyPem;
        public final String role;
        public final long addedAt;
        public final PublicKey key;

        Member(String deviceId, String alias, String publicKeyPem, String role, long addedAt, PublicKey key) {
            this.deviceId = deviceId;
            this.alias = alias;
            this.publicKeyPem = publicKeyPem;
            this.role = role;
            this.addedAt = addedAt;
            this.key = key;
        }

        public TrustStore.Device asDevice() {
            return new TrustStore.Device(deviceId, alias, publicKeyPem, addedAt);
        }
    }

    /** A validated list; `raw` is the list object as signed. */
    public static final class ListView {
        public final Map<String, Object> raw;
        public final String mesh;
        public final long version;
        public final long issuedAt;
        public final String hubId;
        public final List<String> urls;
        public final List<Member> members;
        public final Set<String> revoked;

        ListView(Map<String, Object> raw, String mesh, long version, long issuedAt, String hubId, List<String> urls, List<Member> members, Set<String> revoked) {
            this.raw = raw;
            this.mesh = mesh;
            this.version = version;
            this.issuedAt = issuedAt;
            this.hubId = hubId;
            this.urls = Collections.unmodifiableList(urls);
            this.members = Collections.unmodifiableList(members);
            this.revoked = Collections.unmodifiableSet(revoked);
        }

        public Member member(String deviceId) {
            for (Member m : members) if (m.deviceId.equals(deviceId)) return m;
            return null;
        }
    }

    private Membership() {}

    private static Map<String, Object> obj(Object o, String where) {
        if (!(o instanceof Map)) throw new MembershipError("invalid list: " + where + " must be an object");
        @SuppressWarnings("unchecked")
        Map<String, Object> m = (Map<String, Object>) o;
        return m;
    }

    private static void exactKeys(Map<String, Object> o, List<String> keys, String where) {
        if (!new HashSet<>(keys).equals(o.keySet())) throw new MembershipError("invalid list: " + where + " has unexpected or missing fields");
    }

    private static String hexId(Object v, String where) {
        if (!(v instanceof String) || !HEX_ID.matcher((String) v).matches()) throw new MembershipError("invalid list: " + where + " must be 64 lowercase hex");
        return (String) v;
    }

    private static long integer(Object v, String where, long min) {
        if (!(v instanceof Long) || (Long) v < min) throw new MembershipError("invalid list: " + where + " must be an integer >= " + min);
        return (Long) v;
    }

    /** A P-256 SPKI PEM in the canonical form (as Node exports it); anything else is refused. */
    static PublicKey canonicalPem(String pem, String where) {
        try {
            PublicKey k = TrustStore.parsePem(pem);
            if (!TrustStore.pem(k).trim().equals(pem.replace("\r\n", "\n").trim())) throw new IllegalArgumentException("not canonical");
            return k;
        } catch (RuntimeException e) {
            throw new MembershipError("invalid list: " + where + " is not an EC P-256 SPKI PEM");
        }
    }

    @SuppressWarnings("unchecked")
    public static ListView validate(Object o) {
        Map<String, Object> l = obj(o, "list");
        exactKeys(l, java.util.Arrays.asList("v", "mesh", "version", "issuedAt", "hub", "members", "revoked"), "list");
        if (!Long.valueOf(1).equals(l.get("v"))) throw new MembershipError("invalid list: unsupported v");
        String mesh = hexId(l.get("mesh"), "mesh");
        long version = integer(l.get("version"), "version", 1);
        long issuedAt = integer(l.get("issuedAt"), "issuedAt", MIN_SAFE);
        Map<String, Object> hub = obj(l.get("hub"), "hub");
        exactKeys(hub, java.util.Arrays.asList("deviceId", "urls"), "hub");
        String hubId = hexId(hub.get("deviceId"), "hub.deviceId");
        if (!(hub.get("urls") instanceof List)) throw new MembershipError("invalid list: hub.urls must be an array of strings");
        List<String> urls = new ArrayList<>();
        for (Object u : (List<Object>) hub.get("urls")) {
            if (!(u instanceof String)) throw new MembershipError("invalid list: hub.urls must be an array of strings");
            urls.add((String) u);
        }
        if (!(l.get("members") instanceof List)) throw new MembershipError("invalid list: members must be an array");
        List<Object> ms = (List<Object>) l.get("members");
        if (ms.size() > MAX_MEMBERS) throw new MembershipError("invalid list: more than " + MAX_MEMBERS + " members");
        Set<String> seen = new HashSet<>();
        List<Member> members = new ArrayList<>();
        int hubs = 0;
        for (int i = 0; i < ms.size(); i++) {
            String at = "members[" + i + "]";
            Map<String, Object> m = obj(ms.get(i), at);
            exactKeys(m, java.util.Arrays.asList("deviceId", "alias", "publicKeyPem", "role", "addedAt"), at);
            String id = hexId(m.get("deviceId"), at + ".deviceId");
            if (!seen.add(id)) throw new MembershipError("invalid list: duplicate deviceId " + at);
            if (!(m.get("alias") instanceof String)) throw new MembershipError("invalid list: " + at + ".alias must be a string");
            Object role = m.get("role");
            if (!"hub".equals(role) && !"member".equals(role)) throw new MembershipError("invalid list: " + at + ".role must be \"hub\" or \"member\"");
            if (!(m.get("publicKeyPem") instanceof String)) throw new MembershipError("invalid list: " + at + ".publicKeyPem must be a string");
            PublicKey key = canonicalPem((String) m.get("publicKeyPem"), at + ".publicKeyPem");
            long addedAt = integer(m.get("addedAt"), at + ".addedAt", MIN_SAFE);
            if ("hub".equals(role)) {
                hubs++;
                if (!id.equals(hubId)) throw new MembershipError("invalid list: hub-role member is not hub.deviceId");
            }
            members.add(new Member(id, (String) m.get("alias"), (String) m.get("publicKeyPem"), (String) role, addedAt, key));
        }
        if (hubs != 1) throw new MembershipError("invalid list: exactly one member must have role \"hub\"");
        if (!(l.get("revoked") instanceof List)) throw new MembershipError("invalid list: revoked must be an array");
        Set<String> revoked = new HashSet<>();
        List<Object> rs = (List<Object>) l.get("revoked");
        for (int i = 0; i < rs.size(); i++) {
            String at = "revoked[" + i + "]";
            Map<String, Object> r = obj(rs.get(i), at);
            exactKeys(r, java.util.Arrays.asList("deviceId", "revokedAt"), at);
            String id = hexId(r.get("deviceId"), at + ".deviceId");
            if (seen.contains(id)) throw new MembershipError("invalid list: " + at + " is also a member");
            if (!revoked.add(id)) throw new MembershipError("invalid list: duplicate " + at);
            integer(r.get("revokedAt"), at + ".revokedAt", MIN_SAFE);
        }
        return new ListView(l, mesh, version, issuedAt, hubId, urls, members, revoked);
    }

    /** Verifies {list, sig} against the anchor and the mesh id, then validates the list. */
    public static ListView verify(Object signed, PublicKey anchor) {
        if (!(signed instanceof Map)) throw new MembershipError("malformed signed membership");
        Map<?, ?> s = (Map<?, ?>) signed;
        if (!(s.get("list") instanceof Map) || !(s.get("sig") instanceof String) || ((String) s.get("sig")).isEmpty()) {
            throw new MembershipError("malformed signed membership");
        }
        String payload;
        try {
            payload = Canonical.json(s.get("list"));
        } catch (RuntimeException e) {
            throw new MembershipError("malformed signed membership: " + e.getMessage());
        }
        if (!Canonical.verify(DOMAIN, payload.getBytes(StandardCharsets.UTF_8), (String) s.get("sig"), anchor)) throw new MembershipError("bad signature");
        if (!Canonical.spkiSha256(anchor).equals(((Map<?, ?>) s.get("list")).get("mesh"))) throw new MembershipError("list is for a different mesh");
        return validate(s.get("list"));
    }
}
