package io.github.hafijbge.meshdrop.engine.mesh;

import io.github.hafijbge.meshdrop.engine.net.TrustSource;
import io.github.hafijbge.meshdrop.engine.net.TrustStore;
import io.github.hafijbge.meshdrop.engine.util.Atomic;
import io.github.hafijbge.meshdrop.engine.util.Io;
import io.github.hafijbge.meshdrop.engine.util.Json;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.PublicKey;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * This device's copy of the mesh: <home>/mesh/anchor.pem (the root public key) and mesh/membership.json
 * ({list, sig}), the same files as the Node engine. Accepts only lists that verify against the anchor;
 * a lower version is stale, the same version with other content is a fork.
 */
public final class MembershipStore implements TrustSource {
    public final PublicKey anchor;
    private final File file;
    private Map<String, Object> signed;
    private Membership.ListView list;

    private MembershipStore(File file, PublicKey anchor, Map<String, Object> signed, Membership.ListView list) {
        this.file = file;
        this.anchor = anchor;
        this.signed = signed;
        this.list = list;
    }

    static File dir(File home) {
        return new File(home, "mesh");
    }

    /** The stored mesh, or null if this device is in none. Half a mesh state is an error. */
    @SuppressWarnings("unchecked")
    public static MembershipStore load(File home) throws IOException {
        File a = new File(dir(home), "anchor.pem");
        File m = new File(dir(home), "membership.json");
        if (!a.exists() && !m.exists()) return null;
        if (!a.exists() || !m.exists()) throw new IOException("incomplete mesh state: anchor.pem and membership.json must both exist");
        PublicKey anchor = parseAnchor(Io.readString(a.toPath()));
        Object s;
        try {
            s = Json.parse(Io.readString(m.toPath()));
        } catch (RuntimeException e) {
            throw new IOException("corrupt membership.json");
        }
        Membership.ListView l = Membership.verify(s, anchor);
        return new MembershipStore(m, anchor, (Map<String, Object>) s, l);
    }

    public static PublicKey parseAnchor(String pem) {
        return Membership.canonicalPem(pem, "anchor");
    }

    @SuppressWarnings("unchecked")
    public static MembershipStore init(File home, PublicKey anchor, Map<String, Object> s) throws IOException {
        Membership.ListView l = Membership.verify(s, anchor);
        File d = dir(home);
        if (new File(d, "anchor.pem").exists() && new File(d, "membership.json").exists()) throw new Membership.MembershipError("mesh state already exists");
        Atomic.write(new File(d, "anchor.pem"), TrustStore.pem(anchor).getBytes(StandardCharsets.UTF_8));
        File m = new File(d, "membership.json");
        Map<String, Object> clean = clean(s);
        Atomic.write(m, (Json.stringify(clean) + "\n").getBytes(StandardCharsets.UTF_8));
        return new MembershipStore(m, anchor, clean, l);
    }

    private static Map<String, Object> clean(Map<String, Object> s) {
        Map<String, Object> c = new LinkedHashMap<>();
        c.put("list", s.get("list"));
        c.put("sig", s.get("sig"));
        return c;
    }

    /** {list, sig} as stored (a copy). */
    @SuppressWarnings("unchecked")
    public synchronized Map<String, Object> current() {
        return (Map<String, Object>) Json.parse(Json.stringify(signed));
    }

    public synchronized Membership.ListView list() {
        return list;
    }

    /** "updated" | "same" | "stale"; throws MembershipError for a fork or a list that does not verify. */
    @SuppressWarnings("unchecked")
    public synchronized String accept(Map<String, Object> s) throws IOException {
        Membership.ListView l = Membership.verify(s, anchor);
        if (l.version < list.version) return "stale";
        if (l.version == list.version) {
            if (s.get("sig").equals(signed.get("sig")) && Canonical.json(l.raw).equals(Canonical.json(list.raw))) return "same";
            throw new Membership.MembershipError("fork");
        }
        Map<String, Object> c = clean(s);
        Atomic.write(file, (Json.stringify(c) + "\n").getBytes(StandardCharsets.UTF_8));
        signed = c;
        list = l;
        return "updated";
    }

    @Override
    public synchronized boolean isTrusted(String deviceId) {
        return list.member(deviceId) != null;
    }

    @Override
    public synchronized TrustStore.Device get(String deviceId) {
        Membership.Member m = list.member(deviceId);
        return m == null ? null : m.asDevice();
    }

    public synchronized boolean isRevoked(String deviceId) {
        return list.revoked.contains(deviceId);
    }

    /** Deletes the mesh state (revocation): the identity stays. */
    public static void drop(File home) {
        File d = dir(home);
        File[] fs = d.listFiles();
        if (fs != null) for (File f : fs) f.delete();
        d.delete();
    }
}
