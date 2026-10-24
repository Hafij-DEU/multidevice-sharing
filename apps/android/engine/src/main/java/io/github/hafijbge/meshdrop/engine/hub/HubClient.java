package io.github.hafijbge.meshdrop.engine.hub;

import io.github.hafijbge.meshdrop.engine.identity.Identity;
import io.github.hafijbge.meshdrop.engine.mesh.Canonical;
import io.github.hafijbge.meshdrop.engine.mesh.Membership;
import io.github.hafijbge.meshdrop.engine.mesh.MembershipStore;
import io.github.hafijbge.meshdrop.engine.net.Tls;
import io.github.hafijbge.meshdrop.engine.net.TrustStore;
import io.github.hafijbge.meshdrop.engine.net.WebSocket;
import io.github.hafijbge.meshdrop.engine.util.B64;
import io.github.hafijbge.meshdrop.engine.util.Json;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.PublicKey;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;
import java.util.regex.Pattern;

/**
 * Device side of the hub link (protocol v1), ported from hub/client.ts: connects (the hub's LAN
 * address first, pinned to its device id; then the list's hub URLs), authenticates, keeps the link
 * alive, applies pushed membership lists. A revoked device stops for good; a device the hub turns
 * away without proof of revocation is "refused" (the link stops, the mesh state stays).
 *
 * Handshake: hub → {t:'hello', hub, nonce, hv}; device → {t:'auth', deviceId, cert, nonce, sig, lan, mv}
 * with sig over hub‖0‖deviceId‖0‖hubNonce; hub → {t:'welcome', sig, membership?, directory} with sig
 * over "hub"‖0‖deviceId‖0‖deviceNonce by the hub's member key.
 */
public final class HubClient {
    public static final String AUTH_DOMAIN = "meshdrop-hub-auth-v1";
    public static final String PATH = "/mesh/v1/hub";
    public static final int CLOSE_AUTH = 4401;
    public static final int CLOSE_REVOKED = 4403;
    public static final int CLOSE_REPLACED = 4409;
    public static final long[] DEFAULT_BACKOFF_MS = {1000, 2000, 5000, 10000, 30000, 60000};
    public static final long DEFAULT_PING_MS = 240_000;
    /** An online link that lasts this long resets the backoff. */
    public static final long STABLE_LINK_MS = 60_000;
    static final int HANDSHAKE_TIMEOUT_MS = 15_000;
    private static final Pattern HEX64 = Pattern.compile("^[0-9a-f]{64}$");
    private static final SecureRandom RANDOM = new SecureRandom();

    public enum State {
        IDLE, CONNECTING, ONLINE, REVOKED, REFUSED;

        @Override
        public String toString() {
            return name().toLowerCase(Locale.ROOT);
        }
    }

    public static final class LanAddr {
        public final String host;
        public final int port;

        public LanAddr(String host, int port) {
            this.host = host;
            this.port = port;
        }

        Map<String, Object> toJson() {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("host", host);
            m.put("port", (long) port);
            return m;
        }

        @Override
        public String toString() {
            return host + ":" + port;
        }
    }

    public static final class DirectoryEntry {
        public final String deviceId;
        public final boolean online;
        public final long lastSeen;
        public final List<LanAddr> lanAddrs;

        DirectoryEntry(String deviceId, boolean online, long lastSeen, List<LanAddr> lanAddrs) {
            this.deviceId = deviceId;
            this.online = online;
            this.lastSeen = lastSeen;
            this.lanAddrs = Collections.unmodifiableList(lanAddrs);
        }

        @Override
        public String toString() {
            return deviceId.substring(0, 8) + (online ? " online " : " offline ") + lanAddrs;
        }
    }

    /** Called on the link thread; keep it short. */
    public interface Listener {
        default void onState(State s) {}

        /** A newer list was accepted (signed {list, sig}). */
        default void onMembership(Map<String, Object> signed) {}

        default void onDirectory(List<DirectoryEntry> devices) {}

        /** `held-delivered` / `held-failed` notices from the hub. */
        default void onHeld(String type, Map<String, Object> m) {}

        /** Any other control message. */
        default void onControl(Map<String, Object> m) {}

        default void onLinkClosed(int code) {}

        /** Verified proof that this device is out of the mesh. */
        default void onRevoked() {}
    }

    public static final class Options {
        public final Identity id;
        /** The mesh state; read on every use (accept() moves it). */
        public final Supplier<MembershipStore> members;
        /** This device's LAN addresses, reported to the hub's directory. */
        public Supplier<List<LanAddr>> lanAddrs = Collections::emptyList;
        /** The hub's LAN address if known (tried first, pinned to the hub's device id). */
        public Supplier<LanAddr> hubLan = () -> null;
        public long[] backoffMs = DEFAULT_BACKOFF_MS;
        public long pingMs = DEFAULT_PING_MS;
        public Listener listener = new Listener() {};

        public Options(Identity id, Supplier<MembershipStore> members) {
            this.id = id;
            this.members = members;
        }
    }

    private static final class Target {
        final String host;
        final int port;
        final String hostHeader;
        final String path;
        /** "pinned" (LAN, mutual TLS to the hub's id), "wss" (CA-validated), "ws" (loopback only). */
        final String kind;

        Target(String host, int port, String hostHeader, String path, String kind) {
            this.host = host;
            this.port = port;
            this.hostHeader = hostHeader;
            this.path = path;
            this.kind = kind;
        }
    }

    private static final class Closed {
        final int code;

        Closed(int code) {
            this.code = code;
        }
    }

    /** One WebSocket link. Until authenticated its messages queue for the handshake; then they go to the link thread. */
    final class Link implements WebSocket.Listener {
        volatile WebSocket ws;
        private boolean authed;
        private final List<Object> pre = new ArrayList<>();

        @Override
        public void onText(String text) {
            deliver(text);
        }

        @Override
        public void onBinary(byte[] data) {
            deliver(data);
        }

        @Override
        public void onPong(byte[] data) {
            lastRx = System.currentTimeMillis();
        }

        @Override
        public void onClose(int code, String reason) {
            deliver(new Closed(code));
        }

        private void deliver(Object m) {
            lastRx = System.currentTimeMillis();
            synchronized (this) {
                if (!authed) {
                    pre.add(m);
                    notifyAll();
                    return;
                }
            }
            exec.execute(() -> onMessage(this, m));
        }

        synchronized Object next(long deadline) throws InterruptedException {
            while (pre.isEmpty()) {
                long w = deadline - System.currentTimeMillis();
                if (w <= 0) return null;
                wait(w);
            }
            return pre.remove(0);
        }

        /** Switches delivery to the link thread; returns what arrived meanwhile, in order. */
        synchronized List<Object> authed() {
            authed = true;
            List<Object> rest = new ArrayList<>(pre);
            pre.clear();
            return rest;
        }

        void abort() {
            WebSocket w = ws;
            if (w != null) w.abort();
        }

        boolean send(Map<String, Object> m) {
            WebSocket w = ws;
            if (w == null) return false;
            try {
                w.sendText(Json.stringify(m));
                return true;
            } catch (IOException e) {
                w.abort();
                return false;
            }
        }
    }

    private final Options o;
    final ScheduledThreadPoolExecutor exec;
    private final Map<String, PublicKey> keys = new ConcurrentHashMap<>();
    private volatile State state = State.IDLE;
    private boolean stopped = true;
    private int attempt;
    private Link link;
    private Link trying;
    private Socket tryingSocket;
    private ScheduledFuture<?> retry;
    private ScheduledFuture<?> ping;
    private ScheduledFuture<?> stable;
    volatile long lastRx;
    private volatile List<DirectoryEntry> directory = Collections.emptyList();

    public HubClient(Options o) {
        this.o = o;
        exec = new ScheduledThreadPoolExecutor(1, r -> {
            Thread t = new Thread(r, "hub-link");
            t.setDaemon(true);
            return t;
        });
        exec.setRemoveOnCancelPolicy(true);
    }

    public State state() {
        return state;
    }

    public List<DirectoryEntry> directory() {
        return directory;
    }

    private Identity me() {
        return o.id;
    }

    private MembershipStore members() {
        return o.members.get();
    }

    private void setState(State s) {
        State prev;
        synchronized (this) {
            prev = state;
            state = s;
        }
        if (prev != s) o.listener.onState(s);
    }

    public void start() {
        synchronized (this) {
            if (state == State.REVOKED || !stopped || members() == null) return;
            stopped = false;
        }
        exec.execute(this::connect);
    }

    public void stop() {
        Link l;
        Link t;
        Socket ts;
        synchronized (this) {
            stopped = true;
            clearTimers();
            l = link;
            t = trying;
            ts = tryingSocket;
            link = null;
            trying = null;
            tryingSocket = null;
        }
        if (l != null) l.abort();
        if (t != null) t.abort();
        closeQuietly(ts);
        if (state != State.REVOKED) setState(State.IDLE);
    }

    /** Ends the link thread for good (the client cannot be started again). */
    public void shutdown() {
        stop();
        exec.shutdownNow();
    }

    /** Sends a JSON control message to the hub; false if not online. */
    public boolean sendControl(Map<String, Object> m) {
        Link l;
        synchronized (this) {
            l = state == State.ONLINE ? link : null;
        }
        return l != null && l.send(m);
    }

    // ---- connection ---------------------------------------------------------------------------

    private List<Target> targets() {
        List<Target> out = new ArrayList<>();
        MembershipStore ms = members();
        if (ms == null) return out;
        LanAddr lan = o.hubLan.get();
        if (lan != null) {
            String h = lan.host.contains(":") ? "[" + lan.host + "]" : lan.host;
            out.add(new Target(lan.host, lan.port, h + ":" + lan.port, PATH, "pinned"));
        }
        for (String u : ms.list().urls) {
            try {
                URI p = new URI(u);
                String host = p.getHost();
                if (host == null) continue;
                boolean loopback = host.equals("127.0.0.1") || host.equals("localhost") || host.equals("[::1]");
                String scheme = p.getScheme();
                // Public URLs use standard CA validation; plain ws:// only to a local ingress (dev, tests).
                if (!"wss".equals(scheme) && !("ws".equals(scheme) && loopback)) continue;
                int port = p.getPort() > 0 ? p.getPort() : ("wss".equals(scheme) ? 443 : 80);
                String path = (p.getRawPath() == null || p.getRawPath().isEmpty() ? "/" : p.getRawPath()) + (p.getRawQuery() == null ? "" : "?" + p.getRawQuery());
                String bare = host.startsWith("[") ? host.substring(1, host.length() - 1) : host;
                out.add(new Target(bare, port, p.getPort() > 0 ? host + ":" + port : host, path, scheme));
            } catch (Exception ignored) {
                // skip malformed
            }
        }
        return out;
    }

    private void connect() {
        synchronized (this) {
            if (stopped || state == State.REVOKED) return;
        }
        setState(State.CONNECTING);
        for (Target t : targets()) {
            synchronized (this) {
                if (stopped) return;
            }
            if (tryTarget(t)) return;
            synchronized (this) {
                if (stopped || state == State.REVOKED || state == State.REFUSED) return;
            }
        }
        scheduleRetry();
    }

    private void scheduleRetry() {
        synchronized (this) {
            if (stopped || state == State.REVOKED) return;
            long[] b = o.backoffMs;
            long delay = b.length == 0 ? 60_000 : b[Math.min(attempt, b.length - 1)];
            attempt++;
            retry = exec.schedule(this::connect, delay, TimeUnit.MILLISECONDS);
        }
        setState(State.CONNECTING);
    }

    private static void closeQuietly(Socket s) {
        if (s == null) return;
        try {
            s.close();
        } catch (IOException ignored) {
            // closed
        }
    }

    private Socket open(Target t) throws IOException {
        String hubId = members().list().hubId;
        switch (t.kind) {
            case "pinned":
                return Tls.connect(Tls.pinnedClient(me(), hubId), t.host, t.port, HANDSHAKE_TIMEOUT_MS);
            case "wss":
                return Tls.connectVerified(Tls.caClient(me()), t.host, t.port, HANDSHAKE_TIMEOUT_MS);
            default:
                Socket s = new Socket();
                try {
                    s.connect(new InetSocketAddress(t.host, t.port), HANDSHAKE_TIMEOUT_MS);
                } catch (IOException e) {
                    s.close();
                    throw e;
                }
                return s;
        }
    }

    /** The next handshake message as JSON, or null when the link failed (it is aborted then). */
    @SuppressWarnings("unchecked")
    private Map<String, Object> nextJson(Link l, long deadline) throws InterruptedException {
        Object m = l.next(deadline);
        if (m instanceof Closed) {
            int code = ((Closed) m).code;
            o.listener.onLinkClosed(code);
            if (code == CLOSE_REVOKED && state != State.REVOKED) refused();
            return null;
        }
        Object j = null;
        if (m instanceof String) {
            try {
                j = Json.parse((String) m);
            } catch (RuntimeException ignored) {
                // not JSON
            }
        }
        if (!(j instanceof Map)) {
            l.abort();
            return null;
        }
        return (Map<String, Object>) j;
    }

    /** True once the link is online; false if this target failed before that. */
    @SuppressWarnings("unchecked")
    private boolean tryTarget(Target t) {
        Link l = new Link();
        MembershipStore ms = members();
        if (ms == null) return false;
        String hubId = ms.list().hubId;
        String myId = me().deviceId();
        Socket s = null;
        try {
            long deadline = System.currentTimeMillis() + HANDSHAKE_TIMEOUT_MS;
            synchronized (this) {
                if (stopped) return false;
                trying = l;
            }
            s = open(t);
            synchronized (this) {
                if (stopped) {
                    closeQuietly(s);
                    return false;
                }
                tryingSocket = s;
            }
            s.setSoTimeout(0);
            l.ws = WebSocket.connect(s, t.hostHeader, t.path, l, WebSocket.DEFAULT_MAX_MESSAGE);

            Map<String, Object> hello = nextJson(l, deadline);
            if (hello == null) return false;
            if (!"hello".equals(hello.get("t")) || !(hello.get("hub") instanceof String) || !HEX64.matcher((String) hello.get("hub")).matches()
                    || !(hello.get("nonce") instanceof String)) {
                l.abort();
                return false;
            }
            String helloHub = (String) hello.get("hub");
            // The pinned link already proved the cert is the list's hub; a different hub id is only
            // possible after a recovery, and then the hub must hand us a newer list naming it.
            if (t.kind.equals("pinned") && !helloHub.equals(hubId)) {
                l.abort();
                return false;
            }
            byte[] nonce = new byte[32];
            RANDOM.nextBytes(nonce);
            String myNonce = B64.std(nonce);
            Map<String, Object> auth = new LinkedHashMap<>();
            auth.put("t", "auth");
            auth.put("deviceId", myId);
            auth.put("cert", B64.std(me().certDer()));
            auth.put("nonce", myNonce);
            auth.put("sig", Canonical.sign(AUTH_DOMAIN, (helloHub + "\0" + myId + "\0" + hello.get("nonce")).getBytes(StandardCharsets.UTF_8), me().keyPair().getPrivate()));
            List<Object> lan = new ArrayList<>();
            for (LanAddr a : o.lanAddrs.get()) lan.add(a.toJson());
            auth.put("lan", lan);
            auth.put("mv", ms.list().version);
            // Our list is at least as new as the hub's: hand it over (a hub restored from an older export adopts it).
            if (hello.get("hv") instanceof Long && ms.list().version >= (Long) hello.get("hv")) auth.put("membership", ms.current());
            if (!l.send(auth)) return false;

            Map<String, Object> w = nextJson(l, deadline);
            if (w == null) return false;
            if ("revoked".equals(w.get("t"))) {
                onRevokedNotice(w.get("s"));
                l.abort();
                return false;
            }
            if (!"welcome".equals(w.get("t"))) {
                l.abort();
                return false;
            }
            if (!helloHub.equals(hubId)) {
                if (!(w.get("membership") instanceof Map)) {
                    l.abort();
                    return false;
                }
                try {
                    ms.accept((Map<String, Object>) w.get("membership"));
                } catch (Exception e) {
                    l.abort();
                    return false;
                }
                if (!ms.list().hubId.equals(helloHub)) {
                    l.abort();
                    return false;
                }
                keys.clear();
                o.listener.onMembership(ms.current());
            }
            PublicKey hubPub = pubOf(helloHub);
            if (hubPub == null || !(w.get("sig") instanceof String)
                    || !Canonical.verify(AUTH_DOMAIN, ("hub\0" + myId + "\0" + myNonce).getBytes(StandardCharsets.UTF_8), (String) w.get("sig"), hubPub)) {
                l.abort();
                return false;
            }
            List<Object> early = l.authed();
            synchronized (this) {
                trying = null;
                tryingSocket = null;
                if (stopped) {
                    l.abort();
                    return false;
                }
            }
            if (w.get("membership") instanceof Map) applyMembership(w.get("membership"));
            if (w.get("directory") instanceof List) directory = parseDirectory((List<Object>) w.get("directory"));
            online(l);
            for (Object m : early) onMessage(l, m);
            return true;
        } catch (IOException | RuntimeException e) {
            l.abort();
            closeQuietly(s);
            return false;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            l.abort();
            closeQuietly(s);
            return false;
        } finally {
            synchronized (this) {
                if (trying == l) {
                    trying = null;
                    tryingSocket = null;
                }
            }
        }
    }

    private void online(Link l) {
        synchronized (this) {
            link = l;
            lastRx = System.currentTimeMillis();
            ping = exec.scheduleAtFixedRate(() -> pingTick(l), o.pingMs, o.pingMs, TimeUnit.MILLISECONDS);
            stable = exec.schedule(() -> {
                synchronized (this) {
                    attempt = 0;
                }
            }, STABLE_LINK_MS, TimeUnit.MILLISECONDS);
        }
        setState(State.ONLINE);
    }

    private void pingTick(Link l) {
        synchronized (this) {
            if (link != l) return;
        }
        // Nothing from the hub (not even a pong) for two ping periods: the link is dead (half-open
        // after a network change); drop it so we relink instead of believing we are online.
        if (System.currentTimeMillis() - lastRx > 2 * o.pingMs) {
            l.abort();
            return;
        }
        Map<String, Object> p = new LinkedHashMap<>();
        p.put("t", "ping");
        l.send(p);
    }

    private void offline(Link l) {
        synchronized (this) {
            if (link != l) return;
            link = null;
            clearTimers();
            if (state == State.REVOKED) return;
        }
        setState(stopped ? State.IDLE : State.CONNECTING);
        scheduleRetry();
    }

    private void clearTimers() {
        for (ScheduledFuture<?> f : new ScheduledFuture<?>[] {retry, ping, stable}) if (f != null) f.cancel(false);
        retry = ping = stable = null;
    }

    private void endLink(State s) {
        Link l;
        Link t;
        Socket ts;
        synchronized (this) {
            if (state == State.REVOKED || (s == State.REFUSED && state == State.REFUSED)) return;
            stopped = true;
            clearTimers();
            l = link;
            t = trying;
            ts = tryingSocket;
            link = null;
        }
        setState(s);
        if (l != null) l.abort();
        if (t != null && t != l) t.abort();
        if (t != null) closeQuietly(ts);
    }

    private void revoked() {
        if (state == State.REVOKED) return;
        endLink(State.REVOKED);
        o.listener.onRevoked();
    }

    private void refused() {
        endLink(State.REFUSED);
    }

    /**
     * A revocation counts only with proof: a list signed by the mesh root, at least as new as ours,
     * without this device. Anything else (no list, a foreign or older list) only stops the link.
     */
    @SuppressWarnings("unchecked")
    private void onRevokedNotice(Object s) {
        MembershipStore ms = members();
        try {
            Membership.ListView l = Membership.verify(s, ms.anchor);
            if (l.version >= ms.list().version && l.member(me().deviceId()) == null) {
                try {
                    ms.accept((Map<String, Object>) s);
                } catch (Exception ignored) {
                    // same version, other content: still proof that we are out
                }
                revoked();
                return;
            }
        } catch (RuntimeException ignored) {
            // not proof
        }
        refused();
    }

    // ---- messages -----------------------------------------------------------------------------

    @SuppressWarnings("unchecked")
    void onMessage(Link l, Object m) {
        if (m instanceof Closed) {
            int code = ((Closed) m).code;
            o.listener.onLinkClosed(code);
            if (code == CLOSE_REVOKED && state != State.REVOKED) refused();
            offline(l);
            return;
        }
        if (m instanceof byte[]) {
            onFrame(l, (byte[]) m);
            return;
        }
        Object j;
        try {
            j = Json.parse((String) m);
        } catch (RuntimeException e) {
            return;
        }
        if (!(j instanceof Map)) return;
        Map<String, Object> c = (Map<String, Object>) j;
        Object t = c.get("t");
        if ("membership".equals(t)) {
            applyMembership(c.get("s"));
        } else if ("directory".equals(t)) {
            if (c.get("devices") instanceof List) {
                directory = parseDirectory((List<Object>) c.get("devices"));
                o.listener.onDirectory(directory);
            }
        } else if ("revoked".equals(t)) {
            onRevokedNotice(c.get("s"));
        } else if ("held-delivered".equals(t) || "held-failed".equals(t)) {
            o.listener.onHeld((String) t, c);
        } else if (!"pong".equals(t)) {
            o.listener.onControl(c);
        }
    }

    /** Relayed envelopes; see RelayTransport (M4b Task 7). */
    void onFrame(Link l, byte[] frame) {}

    @SuppressWarnings("unchecked")
    private void applyMembership(Object s) {
        MembershipStore ms = members();
        if (ms == null || !(s instanceof Map)) return;
        try {
            if ("updated".equals(ms.accept((Map<String, Object>) s))) {
                keys.clear();
                o.listener.onMembership(ms.current());
                if (ms.isRevoked(me().deviceId())) revoked();
            }
        } catch (Exception ignored) {
            // stale, foreign or forked lists are ignored; the current list stands
        }
    }

    PublicKey pubOf(String deviceId) {
        PublicKey k = keys.get(deviceId);
        if (k != null) return k;
        MembershipStore ms = members();
        TrustStore.Device d = ms == null ? null : ms.get(deviceId);
        if (d == null) return null;
        try {
            k = TrustStore.parsePem(d.publicKeyPem);
        } catch (RuntimeException e) {
            return null;
        }
        keys.put(deviceId, k);
        return k;
    }

    @SuppressWarnings("unchecked")
    static List<DirectoryEntry> parseDirectory(List<Object> raw) {
        List<DirectoryEntry> out = new ArrayList<>();
        for (Object o : raw) {
            if (!(o instanceof Map)) continue;
            Map<String, Object> m = (Map<String, Object>) o;
            if (!(m.get("deviceId") instanceof String) || !HEX64.matcher((String) m.get("deviceId")).matches()) continue;
            List<LanAddr> lan = new ArrayList<>();
            if (m.get("lanAddrs") instanceof List) {
                for (Object a : (List<Object>) m.get("lanAddrs")) {
                    if (!(a instanceof Map)) continue;
                    Map<String, Object> am = (Map<String, Object>) a;
                    if (am.get("host") instanceof String && am.get("port") instanceof Long) lan.add(new LanAddr((String) am.get("host"), (int) (long) (Long) am.get("port")));
                }
            }
            long seen = m.get("lastSeen") instanceof Long ? (Long) m.get("lastSeen") : 0;
            out.add(new DirectoryEntry((String) m.get("deviceId"), Boolean.TRUE.equals(m.get("online")), seen, lan));
        }
        return Collections.unmodifiableList(out);
    }
}
