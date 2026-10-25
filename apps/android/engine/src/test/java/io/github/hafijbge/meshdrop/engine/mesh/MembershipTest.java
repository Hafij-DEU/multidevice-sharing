package io.github.hafijbge.meshdrop.engine.mesh;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import io.github.hafijbge.meshdrop.engine.crypto.P256;
import io.github.hafijbge.meshdrop.engine.net.TrustStore;
import io.github.hafijbge.meshdrop.engine.util.Hex;
import io.github.hafijbge.meshdrop.engine.util.Io;
import io.github.hafijbge.meshdrop.engine.util.Json;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Paths;
import java.security.KeyPair;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class MembershipTest {
    @Rule public TemporaryFolder tmp = new TemporaryFolder();

    @SuppressWarnings("unchecked")
    static Map<String, Object> vector() throws Exception {
        return (Map<String, Object>) Json.parse(Io.readString(Paths.get(System.getProperty("meshdrop.repo"), "protocol/vectors/membership-v1.json")));
    }

    static KeyPair root(Map<String, Object> v) {
        return new KeyPair(P256.publicFromSpki(Hex.parse((String) v.get("rootSpkiDerHex"))), P256.privateFromScalar(Hex.parse((String) v.get("rootPrivateKeyScalarHex"))));
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> copy(Object o) {
        return (Map<String, Object>) Json.parse(Json.stringify(o));
    }

    static Map<String, Object> signed(Map<String, Object> list, KeyPair root) {
        Map<String, Object> s = new LinkedHashMap<>();
        s.put("list", list);
        s.put("sig", Canonical.sign(Membership.DOMAIN, Canonical.json(list).getBytes(StandardCharsets.UTF_8), root.getPrivate()));
        return s;
    }

    @Test
    @SuppressWarnings("unchecked")
    public void theVectorCanonicalisesAndVerifies() throws Exception {
        Map<String, Object> v = vector();
        assertEquals(v.get("canonical"), Canonical.json(v.get("list")));
        KeyPair root = root(v);
        assertEquals(v.get("meshId"), Canonical.spkiSha256(root.getPublic()));
        Map<String, Object> s = new LinkedHashMap<>();
        s.put("list", v.get("list"));
        s.put("sig", v.get("signatureB64"));
        Membership.ListView l = Membership.verify(s, root.getPublic());
        assertEquals(v.get("meshId"), l.mesh);
        assertEquals(1, l.members.stream().filter(m -> m.role.equals("hub")).count());
        assertThrows(Membership.MembershipError.class, () -> Membership.verify(s, P256.generate().getPublic()));
    }

    @Test
    @SuppressWarnings("unchecked")
    public void malformedListsAreRefused() throws Exception {
        Map<String, Object> v = vector();
        Map<String, Object> extra = copy(v.get("list"));
        extra.put("bonus", 1);
        assertThrows(Membership.MembershipError.class, () -> Membership.validate(extra));
        Map<String, Object> twoHubs = copy(v.get("list"));
        for (Object m : (List<Object>) twoHubs.get("members")) ((Map<String, Object>) m).put("role", "hub");
        assertThrows(Membership.MembershipError.class, () -> Membership.validate(twoHubs));
        Map<String, Object> dup = copy(v.get("list"));
        List<Object> ms = (List<Object>) dup.get("members");
        ms.add(copy(ms.get(ms.size() - 1)));
        assertThrows(Membership.MembershipError.class, () -> Membership.validate(dup));
        Map<String, Object> revokedMember = copy(v.get("list"));
        Map<String, Object> r = new LinkedHashMap<>();
        r.put("deviceId", ((Map<String, Object>) ((List<Object>) revokedMember.get("members")).get(0)).get("deviceId"));
        r.put("revokedAt", 1L);
        ((List<Object>) revokedMember.get("revoked")).add(r);
        assertThrows(Membership.MembershipError.class, () -> Membership.validate(revokedMember));
        Map<String, Object> many = copy(v.get("list"));
        List<Object> lots = (List<Object>) many.get("members");
        Map<String, Object> proto = (Map<String, Object>) lots.get(lots.size() - 1);
        for (int i = 0; i < 257; i++) {
            Map<String, Object> m = copy(proto);
            m.put("deviceId", String.format("%064x", i + 1000));
            m.put("role", "member");
            lots.add(m);
        }
        assertThrows(Membership.MembershipError.class, () -> Membership.validate(many));
    }

    @Test
    @SuppressWarnings("unchecked")
    public void theStoreAcceptsNewerIgnoresOlderAndRefusesForks() throws Exception {
        Map<String, Object> v = vector();
        KeyPair root = root(v);
        File home = tmp.newFolder();
        Map<String, Object> v1 = copy(v.get("list"));
        MembershipStore st = MembershipStore.init(home, root.getPublic(), signed(v1, root));
        assertEquals(st.list().version, MembershipStore.load(home).list().version);
        Map<String, Object> v2 = copy(v1);
        v2.put("version", ((Long) v1.get("version")) + 1);
        assertEquals("updated", st.accept(signed(v2, root)));
        assertEquals("stale", st.accept(signed(v1, root)));
        Map<String, Object> fork = copy(v2);
        fork.put("issuedAt", 42L);
        assertThrows(Membership.MembershipError.class, () -> st.accept(signed(fork, root)));
        assertThrows(Membership.MembershipError.class, () -> st.accept(signed(copy(v2), keyPair())));
        assertEquals((long) v2.get("version"), MembershipStore.load(home).list().version);
        assertThrows(Membership.MembershipError.class, () -> MembershipStore.init(home, root.getPublic(), signed(v2, root)));
        assertNull(MembershipStore.load(tmp.newFolder()));
    }

    static KeyPair keyPair() {
        return P256.generate();
    }

    @Test
    @SuppressWarnings("unchecked")
    public void aRevokedDeviceIsNeverTrustedEvenIfPairedManually() throws Exception {
        Map<String, Object> v = vector();
        KeyPair root = root(v);
        File home = tmp.newFolder();
        Map<String, Object> l = copy(v.get("list"));
        KeyPair stranger = P256.generate();
        String revokedId = String.format("%064x", 77);
        Map<String, Object> r = new LinkedHashMap<>();
        r.put("deviceId", revokedId);
        r.put("revokedAt", 5L);
        ((List<Object>) l.get("revoked")).add(r);
        MembershipStore st = MembershipStore.init(home, root.getPublic(), signed(l, root));
        TrustStore manual = new TrustStore(new File(home, "trust.json"));
        manual.add(revokedId, "old phone", TrustStore.pem(stranger.getPublic()));
        String manualOnly = String.format("%064x", 78);
        manual.add(manualOnly, "friend", TrustStore.pem(P256.generate().getPublic()));
        CompositeTrust t = new CompositeTrust(st, manual);
        assertFalse(t.isTrusted(revokedId));
        assertNull(t.get(revokedId));
        assertTrue(t.isTrusted(manualOnly));
        String memberId = (String) ((Map<String, Object>) ((List<Object>) l.get("members")).get(0)).get("deviceId");
        assertTrue(t.isTrusted(memberId));
        assertEquals(memberId, t.get(memberId).deviceId);
    }
}
