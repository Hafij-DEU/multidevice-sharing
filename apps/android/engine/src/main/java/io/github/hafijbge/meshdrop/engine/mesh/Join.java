package io.github.hafijbge.meshdrop.engine.mesh;

import io.github.hafijbge.meshdrop.engine.hub.HubClient;
import io.github.hafijbge.meshdrop.engine.identity.Identity;
import io.github.hafijbge.meshdrop.engine.net.Http;
import io.github.hafijbge.meshdrop.engine.net.Tls;
import io.github.hafijbge.meshdrop.engine.net.TrustStore;
import io.github.hafijbge.meshdrop.engine.net.WebSocket;
import io.github.hafijbge.meshdrop.engine.util.Atomic;
import io.github.hafijbge.meshdrop.engine.util.B64;
import io.github.hafijbge.meshdrop.engine.util.Io;
import io.github.hafijbge.meshdrop.engine.util.Json;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.PublicKey;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;
import javax.net.ssl.SSLSocket;

/**
 * Redeeming a QR invite (protocol v1), ported from mesh/join.ts and Engine.join.
 *
 * LAN: POST {deviceId, alias, cert, proof} to the inviter's /mesh/v1/join over TLS pinned to the
 * invite's inviter id → {status:'member', anchorPem, membership} or {status:'provisional', anchorPem,
 * inviterKeyPem}; a provisional join completes later from the inviter's GET /mesh/v1/membership.
 * Hub: the first message on the hub link is {t:'join', …} instead of {t:'auth'}.
 * Nothing is stored until the anchor hashes to the invite's mesh id and the signed list verifies and
 * lists this device.
 */
public final class Join {
    public static final String PENDING_FILE = "mesh-pending.json";
    public static final String HUB_ADDR_FILE = "hub-addr.json";
    static final int TIMEOUT_MS = 15_000;
    private static final Pattern HEX64 = Pattern.compile("^[0-9a-f]{64}$");
    private static final SecureRandom RANDOM = new SecureRandom();

    public static final class JoinError extends IOException {
        public JoinError(String m) {
            super(m);
        }
    }

    private Join() {}

    /** Redeems `uri`: over the LAN if it has addresses, else (or if that fails) through the hub. */
    public static String join(Identity id, String uri, String alias, File home) throws IOException {
        if (MembershipStore.load(home) != null) throw new JoinError("this device is already in a mesh");
        Invite inv;
        try {
            inv = Invite.parse(uri);
        } catch (Invite.InviteError e) {
            throw new JoinError(e.getMessage());
        }
        try {
            if (inv.lan.isEmpty()) throw new JoinError("no LAN address");
            String status = viaLan(id, inv, alias, home);
            if (status.equals("member")) {
                MembershipStore ms = MembershipStore.load(home);
                // The inviter answered at this address; if it is the hub, remember where it lives.
                if (ms != null && ms.list().hubId.equals(inv.inviter)) writeHubAddr(home, inv.inviter, inv.lan.get(0));
            }
            return status;
        } catch (IOException e) {
            if (inv.hubUrls.isEmpty() || isRefusal(e)) throw e;
            viaHub(id, inv, alias, home);
            return "member";
        }
    }

    static boolean isRefusal(IOException e) {
        return e instanceof JoinError && e.getMessage() != null && e.getMessage().startsWith("join refused");
    }

    public static boolean pending(File home) {
        return new File(home, PENDING_FILE).exists();
    }

    static void writeHubAddr(File home, String deviceId, Invite.Addr a) throws IOException {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("deviceId", deviceId);
        m.put("host", a.host);
        m.put("port", (long) a.port);
        Atomic.write(new File(home, HUB_ADDR_FILE), Json.stringify(m).getBytes(StandardCharsets.UTF_8));
    }

    /** The hub's LAN address remembered from a join (or later from the directory), or null. */
    @SuppressWarnings("unchecked")
    public static HubClient.LanAddr readHubAddr(File home, String hubId) {
        try {
            Map<String, Object> m = (Map<String, Object>) Json.parse(Io.readString(new File(home, HUB_ADDR_FILE).toPath()));
            if (!hubId.equals(m.get("deviceId")) || !(m.get("host") instanceof String) || !(m.get("port") instanceof Long)) return null;
            return new HubClient.LanAddr((String) m.get("host"), (int) (long) (Long) m.get("port"));
        } catch (IOException | RuntimeException e) {
            return null;
        }
    }

    /** Checks the anchor against the mesh id, verifies the list and that it lists `id`, then stores it. */
    @SuppressWarnings("unchecked")
    static MembershipStore adopt(Identity id, File home, String mesh, Object anchorPem, Object signed) throws IOException {
        if (!(anchorPem instanceof String)) throw new JoinError("no anchor in reply");
        PublicKey anchor;
        try {
            anchor = MembershipStore.parseAnchor((String) anchorPem);
        } catch (RuntimeException e) {
            throw new JoinError("invalid anchor");
        }
        if (!Canonical.spkiSha256(anchor).equals(mesh)) throw new JoinError("anchor does not match the invite mesh id");
        Membership.ListView l;
        try {
            l = Membership.verify(signed, anchor);
        } catch (RuntimeException e) {
            throw new JoinError("membership does not verify: " + e.getMessage());
        }
        if (l.member(id.deviceId()) == null) throw new JoinError("the signed list does not include this device");
        return MembershipStore.init(home, anchor, (Map<String, Object>) signed);
    }

    private static byte[] body(Map<String, Object> m) {
        return Json.stringify(m).getBytes(StandardCharsets.UTF_8);
    }

    private static Http.Response pinned(Identity id, String inviter, Invite.Addr a, String method, String path, byte[] body) throws IOException {
        SSLSocket s = Tls.connect(Tls.pinnedClient(id, inviter), a.host, a.port, 5000);
        s.setSoTimeout(TIMEOUT_MS);
        Map<String, String> h = new LinkedHashMap<>();
        if (body != null) h.put("content-type", "application/json");
        return Http.request(s, method, path, h, body, 1 << 20);
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> jsonOf(Http.Response r) {
        try {
            Object j = Json.parse(r.text());
            return j instanceof Map ? (Map<String, Object>) j : null;
        } catch (RuntimeException e) {
            return null;
        }
    }

    /** Redeems over the LAN: "member", or "provisional" (call complete() once the hub has signed it in). */
    static String viaLan(Identity id, Invite inv, String alias, File home) throws IOException {
        Map<String, Object> req = new LinkedHashMap<>();
        req.put("deviceId", id.deviceId());
        req.put("alias", alias);
        req.put("cert", B64.std(id.certDer()));
        req.put("proof", Invite.proof(inv.secret, id.deviceId(), inv.inviter));
        IOException last = new JoinError("no LAN address answered");
        for (Invite.Addr a : inv.lan) {
            Http.Response res;
            try {
                res = pinned(id, inv.inviter, a, "POST", "/mesh/v1/join", body(req));
            } catch (IOException e) {
                last = e;
                continue;
            }
            Map<String, Object> j = jsonOf(res);
            if (res.status != 200 || j == null) {
                Object err = j == null ? null : j.get("error");
                throw new JoinError("join refused: " + (err instanceof String ? err : String.valueOf(res.status)));
            }
            if ("member".equals(j.get("status"))) {
                adopt(id, home, inv.mesh, j.get("anchorPem"), j.get("membership"));
                return "member";
            }
            if ("provisional".equals(j.get("status"))) {
                PublicKey anchor;
                try {
                    anchor = MembershipStore.parseAnchor((String) j.get("anchorPem"));
                } catch (RuntimeException e) {
                    throw new JoinError("invalid anchor");
                }
                if (!Canonical.spkiSha256(anchor).equals(inv.mesh)) throw new JoinError("anchor does not match the invite mesh id");
                if (!(j.get("inviterKeyPem") instanceof String)) throw new JoinError("bad reply");
                PublicKey inviterKey;
                try {
                    inviterKey = TrustStore.parsePem((String) j.get("inviterKeyPem"));
                } catch (RuntimeException e) {
                    throw new JoinError("bad reply");
                }
                // The inviter is the device we pinned by id; keep trusting it until the mesh list arrives.
                new TrustStore(new File(home, "trust.json")).add(inv.inviter, "inviter", TrustStore.pem(inviterKey));
                Map<String, Object> p = new LinkedHashMap<>();
                p.put("anchorPem", j.get("anchorPem"));
                p.put("mesh", inv.mesh);
                p.put("inviter", inv.inviter);
                List<Object> lan = new ArrayList<>();
                for (Invite.Addr x : inv.lan) {
                    Map<String, Object> am = new LinkedHashMap<>();
                    am.put("host", x.host);
                    am.put("port", (long) x.port);
                    lan.add(am);
                }
                p.put("lan", lan);
                Atomic.write(new File(home, PENDING_FILE), Json.stringify(p).getBytes(StandardCharsets.UTF_8));
                return "provisional";
            }
            throw new JoinError("bad reply");
        }
        throw last;
    }

    /** Finishes a provisional join: fetches the signed list from the inviter once it includes us. */
    @SuppressWarnings("unchecked")
    public static MembershipStore complete(Identity id, File home) throws IOException {
        Map<String, Object> p;
        try {
            p = (Map<String, Object>) Json.parse(Io.readString(new File(home, PENDING_FILE).toPath()));
        } catch (IOException | RuntimeException e) {
            throw new JoinError("no pending join");
        }
        Object inviter = p.get("inviter");
        if (!(inviter instanceof String) || !HEX64.matcher((String) inviter).matches() || !(p.get("mesh") instanceof String) || !(p.get("lan") instanceof List)) {
            throw new JoinError("bad pending join");
        }
        IOException last = new JoinError("inviter unreachable");
        for (Object o : (List<Object>) p.get("lan")) {
            if (!(o instanceof Map)) continue;
            Map<String, Object> a = (Map<String, Object>) o;
            if (!(a.get("host") instanceof String) || !(a.get("port") instanceof Long)) continue;
            try {
                Http.Response res = pinned(id, (String) inviter, new Invite.Addr((String) a.get("host"), (int) (long) (Long) a.get("port")), "GET", "/mesh/v1/membership", null);
                if (res.status != 200) throw new JoinError("membership unavailable (" + res.status + ")");
                MembershipStore ms = adopt(id, home, (String) p.get("mesh"), p.get("anchorPem"), jsonOf(res));
                new File(home, PENDING_FILE).delete();
                return ms;
            } catch (IOException e) {
                last = e;
            }
        }
        throw last;
    }

    /** Redeems through the hub's URLs (no LAN needed). */
    static void viaHub(Identity id, Invite inv, String alias, File home) throws IOException {
        if (inv.hubUrls.isEmpty()) throw new JoinError("the invite has no hub URL");
        IOException last = new JoinError("no hub URL answered");
        for (String url : inv.hubUrls) {
            HubClient.Endpoint ep = HubClient.Endpoint.url(url);
            if (ep == null) continue;
            try {
                joinOnce(id, inv, alias, home, ep);
                return;
            } catch (IOException e) {
                last = e;
                if (isRefusal(e)) throw e;
            }
        }
        throw last;
    }

    private static final class Queue implements WebSocket.Listener {
        final LinkedBlockingQueue<Object> q = new LinkedBlockingQueue<>();

        @Override
        public void onText(String text) {
            q.add(text);
        }

        @Override
        public void onBinary(byte[] data) {}

        @Override
        public void onClose(int code, String reason) {
            q.add(Integer.valueOf(code));
        }

        @SuppressWarnings("unchecked")
        Map<String, Object> next(long deadline) throws IOException {
            Object m;
            try {
                m = q.poll(Math.max(0, deadline - System.currentTimeMillis()), TimeUnit.MILLISECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new JoinError("interrupted");
            }
            if (m == null) throw new JoinError("hub did not answer");
            if (m instanceof Integer) throw new JoinError("hub closed the link");
            try {
                Object j = Json.parse((String) m);
                if (j instanceof Map) return (Map<String, Object>) j;
            } catch (RuntimeException ignored) {
                // fall through
            }
            throw new JoinError("bad hub message");
        }
    }

    @SuppressWarnings("unchecked")
    private static void joinOnce(Identity id, Invite inv, String alias, File home, HubClient.Endpoint ep) throws IOException {
        Queue q = new Queue();
        long deadline = System.currentTimeMillis() + TIMEOUT_MS;
        WebSocket ws = ep.connect(id, null, TIMEOUT_MS, q);
        try {
            Map<String, Object> hello = q.next(deadline);
            if (!"hello".equals(hello.get("t")) || !(hello.get("hub") instanceof String) || !HEX64.matcher((String) hello.get("hub")).matches()
                    || !(hello.get("nonce") instanceof String)) {
                throw new JoinError("bad hello");
            }
            String hubId = (String) hello.get("hub");
            byte[] n = new byte[32];
            RANDOM.nextBytes(n);
            String myNonce = B64.std(n);
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("t", "join");
            m.put("deviceId", id.deviceId());
            m.put("cert", B64.std(id.certDer()));
            m.put("alias", alias);
            m.put("inviter", inv.inviter);
            m.put("nonce", myNonce);
            m.put("lan", Collections.emptyList());
            m.put("proof", Invite.proof(inv.secret, id.deviceId(), inv.inviter));
            m.put("sig", Canonical.sign(HubClient.AUTH_DOMAIN, (hubId + "\0" + id.deviceId() + "\0" + hello.get("nonce")).getBytes(StandardCharsets.UTF_8), id.keyPair().getPrivate()));
            ws.sendText(Json.stringify(m));
            for (;;) {
                Map<String, Object> r = q.next(deadline);
                if ("join-failed".equals(r.get("t"))) {
                    Object err = r.get("error");
                    throw new JoinError("join refused: " + (err instanceof String ? err : "refused"));
                }
                if (!"welcome".equals(r.get("t"))) continue;
                // Verify everything before storing: anchor = invite mesh, list signed and listing us,
                // and the hub that answered is the hub that list names.
                if (!(r.get("anchorPem") instanceof String)) throw new JoinError("no anchor in reply");
                PublicKey anchor;
                Membership.ListView l;
                try {
                    anchor = MembershipStore.parseAnchor((String) r.get("anchorPem"));
                    if (!Canonical.spkiSha256(anchor).equals(inv.mesh)) throw new JoinError("anchor does not match the invite mesh id");
                    l = Membership.verify(r.get("membership"), anchor);
                } catch (RuntimeException e) {
                    throw new JoinError("membership does not verify");
                }
                Membership.Member hub = l.member(l.hubId);
                if (!l.hubId.equals(hubId) || hub == null) throw new JoinError("unexpected hub");
                if (!(r.get("sig") instanceof String)
                        || !Canonical.verify(HubClient.AUTH_DOMAIN, ("hub\0" + id.deviceId() + "\0" + myNonce).getBytes(StandardCharsets.UTF_8), (String) r.get("sig"), hub.key)) {
                    throw new JoinError("hub signature does not verify");
                }
                adopt(id, home, inv.mesh, r.get("anchorPem"), r.get("membership"));
                return;
            }
        } finally {
            ws.close(1000, "");
        }
    }
}
