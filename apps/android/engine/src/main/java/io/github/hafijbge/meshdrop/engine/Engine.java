package io.github.hafijbge.meshdrop.engine;

import io.github.hafijbge.meshdrop.engine.disc.Discovery;
import io.github.hafijbge.meshdrop.engine.identity.Identity;
import io.github.hafijbge.meshdrop.engine.net.Tls;
import io.github.hafijbge.meshdrop.engine.net.TrustStore;
import io.github.hafijbge.meshdrop.engine.recv.Inbox;
import io.github.hafijbge.meshdrop.engine.recv.MeshServer;
import io.github.hafijbge.meshdrop.engine.send.MultiSend;
import io.github.hafijbge.meshdrop.engine.send.Outbox;
import io.github.hafijbge.meshdrop.engine.send.Prepared;
import io.github.hafijbge.meshdrop.engine.send.SendItem;
import io.github.hafijbge.meshdrop.engine.send.SendResult;
import io.github.hafijbge.meshdrop.engine.send.Sender;
import io.github.hafijbge.meshdrop.engine.util.Atomic;
import io.github.hafijbge.meshdrop.engine.util.Json;
import java.io.File;
import java.io.IOException;
import java.net.Inet4Address;
import java.net.NetworkInterface;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Semaphore;
import java.util.concurrent.atomic.AtomicInteger;
import javax.net.ssl.SSLSocket;

/**
 * This device's engine on the LAN: receiver server, discovery, manual pairing, sends with an outbox
 * and auto-resume. The Java counterpart of packages/core/src/engine.ts without the mesh (M4b).
 */
public final class Engine {
    private static final int PAIR_TIMEOUT_MS = 5000;
    private static final int REPROBE_TIMEOUT_MS = 2000;
    private static final long AUTO_RESUME_INTERVAL_MS = 30_000;
    private static final java.util.regex.Pattern PREFIX = java.util.regex.Pattern.compile("^[0-9a-f]{4,64}$");

    /** A target prefix that is malformed, unknown, or matches several trusted devices. */
    public static final class UnknownDevice extends IllegalArgumentException {
        public final String reason;

        UnknownDevice(String query, String reason) {
            super(reason.equals("invalid") ? "\"" + query + "\" is not a device id prefix (at least 4 hex characters)"
                    : reason.equals("unknown") ? "no trusted device matches \"" + query + "\"" : "\"" + query + "\" matches several devices");
            this.reason = reason;
        }
    }

    /** An unfinished send waiting in the outbox. */
    public static final class OutboxItem {
        public final String sessionId;
        public final String deviceId;
        public final String alias;
        public final long createdAt;
        public final int files;
        public final long bytes;
        public final boolean text;

        OutboxItem(Outbox.Entry e, String alias) {
            this.sessionId = e.sessionId;
            this.deviceId = e.targetId;
            this.alias = alias;
            this.createdAt = e.createdAt;
            this.files = e.manifest.files.size();
            long b = 0;
            for (io.github.hafijbge.meshdrop.engine.proto.Manifest.FileEntry f : e.manifest.files) b += f.size;
            this.bytes = b;
            this.text = e.manifest.text != null;
        }
    }

    private final EngineConfig cfg;
    private final Identity identity;
    private final TrustStore trust;
    private final Inbox inbox;
    private final Outbox outbox;
    private final File manualFile;
    private final List<EngineListener> listeners = new CopyOnWriteArrayList<>();
    private final Set<Sender.Control> controls = ConcurrentHashMap.newKeySet();
    private final Map<String, Long> lastAutoResume = new ConcurrentHashMap<>();
    private final Map<String, Boolean> autoResuming = new ConcurrentHashMap<>();
    private volatile boolean accepting = true;
    private volatile MeshServer server;
    private volatile Discovery discovery;
    private volatile ExecutorService exec;
    private volatile int port;

    private Engine(EngineConfig cfg, Identity identity) throws IOException {
        this.cfg = cfg;
        this.identity = identity;
        this.trust = new TrustStore(new File(cfg.home, "trust.json"));
        this.inbox = new Inbox(new File(cfg.home, "inbox-state"), cfg.sink);
        this.outbox = new Outbox(new File(cfg.home, "outbox"));
        this.manualFile = new File(cfg.home, "manual-peers.json");
        this.port = cfg.port;
    }

    /** Loads (or creates) the identity under cfg.home. Opens no sockets: call start(). */
    public static Engine create(EngineConfig cfg) throws IOException {
        if (cfg.port < 0 || cfg.port > 65535) throw new IllegalArgumentException("invalid port " + cfg.port);
        if (!cfg.home.isDirectory() && !cfg.home.mkdirs()) throw new IOException("cannot create " + cfg.home);
        return new Engine(cfg, Identity.loadOrCreate(cfg.home, cfg.vault));
    }

    public Identity identity() {
        return identity;
    }

    public TrustStore trust() {
        return trust;
    }

    public String alias() {
        return cfg.alias;
    }

    /** The bound port once started, else the configured one. */
    public int port() {
        return port;
    }

    public boolean started() {
        return server != null;
    }

    public void addListener(EngineListener l) {
        listeners.add(l);
    }

    public void removeListener(EngineListener l) {
        listeners.remove(l);
    }

    private void emit(String source, String type, Map<String, Object> data) {
        EngineEvent e = new EngineEvent(source, type, data);
        for (EngineListener l : listeners) {
            try {
                l.onEvent(e);
            } catch (RuntimeException ignored) {
                // a throwing listener must not break the server, a send or discovery
            }
        }
    }

    // ---- lifecycle ------------------------------------------------------------------------------

    public synchronized void start() throws IOException {
        if (server != null) return;
        exec = Executors.newCachedThreadPool(r -> {
            Thread t = new Thread(r, "meshdrop-engine");
            t.setDaemon(true);
            return t;
        });
        MeshServer.Options so = new MeshServer.Options();
        so.port = cfg.port;
        so.alias = cfg.alias;
        so.deviceType = cfg.deviceType;
        so.accepting = () -> accepting;
        MeshServer s = new MeshServer(identity, trust, inbox, ev -> {
            Map<String, Object> d = new LinkedHashMap<>(ev);
            String type = (String) d.remove("type");
            emit("receiver", type, d);
        }, so);
        port = s.start();
        server = s;
        discovery = makeDiscovery();
        if (cfg.discovery) {
            if (cfg.multicastHooks != null) cfg.multicastHooks.acquire();
            discovery.start();
        }
        exec.execute(() -> {
            try {
                inbox.prune(cfg.partialMaxAgeMs);
            } catch (IOException ignored) {
                // housekeeping never blocks receiving
            }
        });
        exec.execute(this::reprobeManual);
    }

    private Discovery makeDiscovery() {
        Discovery.Options o = new Discovery.Options(identity.deviceId(), truncate(cfg.alias), cfg.deviceType, port);
        if (cfg.discoveryPort != null) o.port = cfg.discoveryPort;
        o.intervalMs = cfg.discoveryIntervalMs;
        o.isTrusted = trust::isTrusted;
        Discovery d = new Discovery(o);
        d.addListener(new Discovery.Listener() {
            @Override
            public void onPeer(Discovery.PeerInfo p) {
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("peer", p.toMap());
                emit("discovery", "peer", m);
                maybeAutoResume(p.deviceId);
            }

            @Override
            public void onLost(Discovery.PeerInfo p) {
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("peer", p.toMap());
                emit("discovery", "lost", m);
            }
        });
        return d;
    }

    private static String truncate(String alias) {
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < alias.length(); ) {
            int cp = alias.codePointAt(i);
            int n = Character.charCount(cp);
            if (b.length() + n > 64) break;
            b.appendCodePoint(cp);
            i += n;
        }
        return b.toString();
    }

    /** Closes the server and discovery; in-flight sends end 'cancelled' and stay in the outbox. Idempotent. */
    public synchronized void stop() {
        MeshServer s = server;
        server = null;
        for (Sender.Control c : controls) c.pause();
        if (s != null) s.stop();
        Discovery d = discovery;
        discovery = null;
        if (d != null) {
            d.stop();
            if (cfg.discovery && cfg.multicastHooks != null) cfg.multicastHooks.release();
        }
        ExecutorService e = exec;
        exec = null;
        if (e != null) e.shutdown();
    }

    /** After a network change: re-bind discovery on the current interfaces, re-probe manual peers, re-check auto-resume. */
    public void restartNetworking() {
        Discovery d = discovery;
        ExecutorService e = exec;
        if (d == null || e == null) return;
        if (cfg.discovery) {
            d.stop();
            d.start();
        }
        e.execute(this::reprobeManual);
    }

    private Discovery requireRunning() {
        Discovery d = discovery;
        if (d == null || server == null) throw new IllegalStateException("engine not started");
        return d;
    }

    // ---- receiving ------------------------------------------------------------------------------

    public boolean receiving() {
        return accepting;
    }

    /** Pauses or resumes receiving: offers get 503 'paused'; the server and discovery keep running. */
    public void setReceiving(boolean on) {
        accepting = on;
    }

    // ---- devices, pairing -----------------------------------------------------------------------

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> readManual() {
        try {
            Object j = Json.parse(Files.readString(manualFile.toPath()));
            Object peers = j instanceof Map ? ((Map<String, Object>) j).get("peers") : null;
            List<Map<String, Object>> out = new ArrayList<>();
            if (peers instanceof List) {
                for (Object p : (List<Object>) peers) {
                    if (p instanceof Map && ((Map<String, Object>) p).get("deviceId") instanceof String && ((Map<String, Object>) p).get("host") instanceof String
                            && ((Map<String, Object>) p).get("port") instanceof Long) {
                        out.add((Map<String, Object>) p);
                    }
                }
            }
            return out;
        } catch (IOException | RuntimeException e) {
            return new ArrayList<>();
        }
    }

    private void writeManual(List<Map<String, Object>> peers) throws IOException {
        Map<String, Object> root = new LinkedHashMap<>();
        root.put("peers", new ArrayList<Object>(peers));
        Atomic.write(manualFile, (Json.stringify(root) + "\n").getBytes(StandardCharsets.UTF_8));
    }

    private void reprobeManual() {
        Discovery d = discovery;
        if (d == null) return;
        List<Thread> ts = new ArrayList<>();
        for (Map<String, Object> m : readManual()) {
            if (!trust.isTrusted((String) m.get("deviceId"))) continue;
            Thread t = new Thread(() -> {
                try {
                    Discovery.PeerInfo p = d.probe((String) m.get("host"), ((Long) m.get("port")).intValue(), REPROBE_TIMEOUT_MS);
                    maybeAutoResume(p.deviceId);
                } catch (IOException ignored) {
                    // not reachable right now
                }
            });
            t.setDaemon(true);
            t.start();
            ts.add(t);
        }
        for (Thread t : ts) {
            try {
                t.join();
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            }
        }
    }

    /**
     * Trusts the device at host:port by the certificate it presents (trust on first use; the other side
     * must pair back). The address is kept in manual-peers.json and re-probed on every start.
     */
    public TrustStore.Device pairManual(String host, int port, String alias) throws IOException {
        Discovery d = requireRunning();
        if (port < 1 || port > 65535) throw new IOException("pair: invalid port " + port);
        SSLSocket s = Tls.connect(Tls.probeClient(), host, port, PAIR_TIMEOUT_MS);
        byte[] der;
        try {
            der = Tls.peerCertDer(s);
        } finally {
            s.close();
        }
        String deviceId = Identity.deviceIdOf(der);
        if (deviceId.equals(identity.deviceId())) throw new IOException("pair: that is this device; you cannot pair with yourself");
        String pem;
        try {
            pem = TrustStore.pem(io.github.hafijbge.meshdrop.engine.identity.X509.publicKey(der));
        } catch (java.security.GeneralSecurityException e) {
            throw new IOException("pair: the device presented an unusable certificate");
        }
        Discovery.PeerInfo p = d.probe(host, port, PAIR_TIMEOUT_MS);
        if (!p.deviceId.equals(deviceId) || !p.host.equals(host) || p.port != port) {
            throw new IOException("pair: " + host + ":" + port + " presented a different certificate on the second connection");
        }
        TrustStore.Device dev = trust.add(deviceId, truncate(alias), pem);
        List<Map<String, Object>> manual = readManual();
        manual.removeIf(m -> deviceId.equals(m.get("deviceId")));
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("deviceId", deviceId);
        m.put("host", host);
        m.put("port", (long) port);
        manual.add(m);
        writeManual(manual);
        return dev;
    }

    /** Looks for a MeshDrop device at host:port (nearby until paired); a known device that answers may auto-resume. */
    public void addNearby(String host, int port) throws IOException {
        Discovery.PeerInfo p = requireRunning().probe(host, port, PAIR_TIMEOUT_MS);
        maybeAutoResume(p.deviceId);
    }

    public void forgetPeer(String deviceId) {
        Discovery d = discovery;
        if (d != null) d.forget(deviceId);
    }

    /** Paired devices (on the LAN or offline) and untrusted LAN peers; never this device. */
    public List<EngineDevice> devices() {
        Discovery d = discovery;
        Map<String, Discovery.PeerInfo> peers = new LinkedHashMap<>();
        if (d != null) for (Discovery.PeerInfo p : d.peers()) peers.put(p.deviceId, p);
        List<EngineDevice> out = new ArrayList<>();
        Set<String> seen = new LinkedHashSet<>();
        for (TrustStore.Device t : trust.list()) {
            if (t.deviceId.equals(identity.deviceId())) continue;
            Discovery.PeerInfo p = peers.get(t.deviceId);
            out.add(new EngineDevice(t.deviceId, t.alias, "paired", true, p != null ? "lan" : "offline", p != null ? p.deviceType : null, p != null ? p.lastSeen : 0));
            seen.add(t.deviceId);
        }
        for (Discovery.PeerInfo p : peers.values()) {
            if (seen.contains(p.deviceId) || p.deviceId.equals(identity.deviceId())) continue;
            out.add(new EngineDevice(p.deviceId, p.alias, "nearby", false, "lan", p.deviceType, p.lastSeen));
        }
        return out;
    }

    /**
     * Probes every address of this device's /24 networks (or `cidrs`, at most 512 addresses) on the
     * given ports and returns how many devices it found that were not known before.
     */
    public int scanSubnet(List<String> cidrs, List<Integer> ports, int timeoutMs, int concurrency) throws InterruptedException {
        Discovery d = requireRunning();
        List<String> hosts = new ArrayList<>();
        for (String c : cidrs != null ? cidrs : ownSubnets()) hosts.addAll(expand(c, 512 - hosts.size()));
        List<Integer> ps = ports != null ? ports : new ArrayList<>(new LinkedHashSet<>(List.of(53318, port)));
        Set<String> before = new java.util.HashSet<>();
        for (Discovery.PeerInfo p : d.peers()) before.add(p.deviceId);
        Semaphore slots = new Semaphore(Math.max(1, concurrency));
        AtomicInteger found = new AtomicInteger();
        Set<String> foundIds = ConcurrentHashMap.newKeySet();
        List<Thread> ts = new ArrayList<>();
        for (String h : hosts) {
            for (int p : ps) {
                slots.acquire();
                Thread t = new Thread(() -> {
                    try {
                        Discovery.PeerInfo info = d.probe(h, p, timeoutMs);
                        if (!before.contains(info.deviceId) && foundIds.add(info.deviceId)) found.incrementAndGet();
                    } catch (IOException | RuntimeException ignored) {
                        // nothing there
                    } finally {
                        slots.release();
                    }
                });
                t.setDaemon(true);
                t.start();
                ts.add(t);
            }
        }
        for (Thread t : ts) t.join();
        return found.get();
    }

    private static List<String> ownSubnets() {
        Set<String> out = new LinkedHashSet<>();
        for (Map.Entry<NetworkInterface, Inet4Address> a : Discovery.interfaceAddrs()) {
            byte[] b = a.getValue().getAddress();
            out.add((b[0] & 0xff) + "." + (b[1] & 0xff) + "." + (b[2] & 0xff) + ".0/24");
        }
        return new ArrayList<>(out);
    }

    private static List<String> expand(String cidr, int max) {
        List<String> out = new ArrayList<>();
        String[] p = cidr.split("/");
        String[] o = p[0].split("\\.");
        int bits = p.length > 1 ? Integer.parseInt(p[1]) : 32;
        if (o.length != 4 || bits < 23 || bits > 32) return out;
        long base = 0;
        for (String x : o) base = (base << 8) | Integer.parseInt(x);
        long size = 1L << (32 - bits);
        base &= ~(size - 1);
        for (long i = 0; i < size && out.size() < max; i++) {
            if (size > 2 && (i == 0 || i == size - 1)) continue; // network and broadcast addresses
            long a = base + i;
            out.add(((a >> 24) & 0xff) + "." + ((a >> 16) & 0xff) + "." + ((a >> 8) & 0xff) + "." + (a & 0xff));
        }
        return out;
    }

    // ---- sending --------------------------------------------------------------------------------

    /** Resolves a unique prefix (at least 4 hex characters) of a trusted device id. */
    public String resolveDeviceId(String query) {
        String q = query.toLowerCase(java.util.Locale.ROOT);
        if (!PREFIX.matcher(q).matches()) throw new UnknownDevice(query, "invalid");
        List<String> hits = new ArrayList<>();
        for (TrustStore.Device d : trust.list()) if (d.deviceId.startsWith(q)) hits.add(d.deviceId);
        if (hits.isEmpty()) throw new UnknownDevice(query, "unknown");
        if (hits.size() > 1) throw new UnknownDevice(query, "ambiguous");
        return hits.get(0);
    }

    private Sender.Target target(String deviceId) {
        Discovery d = discovery;
        Discovery.PeerInfo p = d == null ? null : d.peer(deviceId);
        TrustStore.Device t = trust.get(deviceId);
        if (p == null || t == null) return null;
        return new Sender.Target(deviceId, p.host, p.port, t.key);
    }

    private Sender.Options sendOptions(String tag, Sender.Control control) {
        Sender.Options o = new Sender.Options();
        o.outbox = outbox;
        o.resolver = cfg.resolver;
        o.control = control;
        o.progress = (dev, sid, fileId, sent, total) -> {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("deviceId", dev);
            m.put("sessionId", sid);
            m.put("fileId", fileId);
            m.put("sent", sent);
            m.put("total", total);
            if (tag != null) m.put("tag", tag);
            emit("sender", "progress", m);
        };
        return o;
    }

    private void emitResult(SendResult r, String tag) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("deviceId", r.deviceId);
        m.put("status", r.status);
        m.put("sessionId", r.sessionId);
        if (r.error != null) m.put("error", r.error);
        if (tag != null) m.put("tag", tag);
        emit("sender", "result", m);
    }

    /**
     * Sends to each device (unique trusted id prefixes), or to every trusted device present when
     * `ids` is null ("all"). Bad prefixes throw UnknownDevice before anything is sent. A trusted
     * device that is not present fails 'offline'. Progress and result events carry `tag`.
     */
    public CompletableFuture<List<SendResult>> send(List<String> ids, List<SendItem> items, String tag) {
        Discovery d = requireRunning();
        List<String> targets = new ArrayList<>();
        if (ids == null) {
            for (TrustStore.Device t : trust.list()) if (d.peer(t.deviceId) != null) targets.add(t.deviceId);
        } else {
            for (String q : ids) {
                String id = resolveDeviceId(q);
                if (!targets.contains(id)) targets.add(id);
            }
        }
        ExecutorService e = exec;
        Sender.Control control = new Sender.Control();
        controls.add(control);
        CompletableFuture<List<SendResult>> f = new CompletableFuture<>();
        e.execute(() -> {
            try {
                List<SendResult> out = new ArrayList<>();
                if (!targets.isEmpty()) {
                    Prepared p;
                    try {
                        p = Prepared.of(items, control.pausedFlag());
                    } catch (IOException | RuntimeException x) {
                        for (String id : targets) out.add(new SendResult(id, control.paused() ? "cancelled" : "failed", "", control.paused() ? null : String.valueOf(x.getMessage())));
                        for (SendResult r : out) emitResult(r, tag);
                        f.complete(out);
                        return;
                    }
                    List<Sender.Target> present = new ArrayList<>();
                    for (String id : targets) {
                        Sender.Target t = target(id);
                        if (t != null) present.add(t);
                    }
                    List<SendResult> sent = MultiSend.send(identity, present, p, sendOptions(tag, control));
                    Map<String, SendResult> byId = new LinkedHashMap<>();
                    for (SendResult r : sent) byId.put(r.deviceId, r);
                    for (String id : targets) out.add(byId.containsKey(id) ? byId.get(id) : new SendResult(id, "failed", "", "offline"));
                }
                for (SendResult r : out) emitResult(r, tag);
                f.complete(out);
            } catch (Throwable x) {
                f.completeExceptionally(x);
            } finally {
                controls.remove(control);
            }
        });
        return f;
    }

    public CompletableFuture<List<SendResult>> sendClipboard(List<String> ids, String text, String tag) {
        return send(ids, List.of(SendItem.clipboard(text)), tag);
    }

    /** Resumes every unfinished send whose device is trusted and present. */
    public CompletableFuture<List<SendResult>> resumePending() {
        requireRunning();
        Sender.Control control = new Sender.Control();
        controls.add(control);
        CompletableFuture<List<SendResult>> f = new CompletableFuture<>();
        exec.execute(() -> {
            try {
                List<SendResult> rs = outbox.resumeAll(identity, this::target, sendOptions(null, control));
                for (SendResult r : rs) emitResult(r, null);
                f.complete(rs);
            } catch (Throwable x) {
                f.completeExceptionally(x);
            } finally {
                controls.remove(control);
            }
        });
        return f;
    }

    public List<OutboxItem> listOutbox() {
        List<OutboxItem> out = new ArrayList<>();
        for (Outbox.Entry e : outbox.list()) {
            TrustStore.Device d = trust.get(e.targetId);
            out.add(new OutboxItem(e, d == null ? null : d.alias));
        }
        return out;
    }

    /** Drops an unfinished send (unique session id prefix) and tells its receiver to discard it. */
    public boolean removeOutbox(String prefix) throws IOException {
        List<Outbox.Entry> hits = new ArrayList<>();
        for (Outbox.Entry e : outbox.list()) {
            if (e.sessionId.equals(prefix)) {
                hits.clear();
                hits.add(e);
                break;
            }
            if (!prefix.isEmpty() && e.sessionId.startsWith(prefix)) hits.add(e);
        }
        if (hits.isEmpty()) throw new IllegalArgumentException("no outbox entry matches \"" + prefix + "\"");
        if (hits.size() > 1) throw new IllegalArgumentException("\"" + prefix + "\" matches " + hits.size() + " outbox entries");
        Outbox.Entry e = hits.get(0);
        if (Sender.isSessionActive(e.sessionId)) throw new IOException("outbox entry " + e.sessionId + " is being sent right now; stop that send first");
        outbox.remove(e.sessionId);
        Sender.Target t = target(e.targetId);
        if (t == null && e.targetHost != null) {
            TrustStore.Device d = trust.get(e.targetId);
            if (d != null) t = new Sender.Target(e.targetId, e.targetHost, e.targetPort, d.key);
        }
        return t != null && Sender.postCancel(identity, t, e.sessionId);
    }

    // ---- auto-resume ----------------------------------------------------------------------------

    /**
     * A device showed up: resume its unfinished sends that ended by a pause or a transient failure.
     * One check per burst of sightings; the 30 s gate is stamped only once a resume actually starts.
     */
    void maybeAutoResume(String deviceId) {
        if (!cfg.autoResume || server == null) return;
        Long last = lastAutoResume.get(deviceId);
        if (last != null && System.currentTimeMillis() - last < AUTO_RESUME_INTERVAL_MS) return;
        if (autoResuming.putIfAbsent(deviceId, false) != null) {
            autoResuming.put(deviceId, true); // check again when the running pass found nothing
            return;
        }
        ExecutorService e = exec;
        if (e == null) {
            autoResuming.remove(deviceId);
            return;
        }
        e.execute(() -> {
            try {
                boolean resumed;
                do {
                    autoResuming.put(deviceId, false);
                    resumed = autoResume(deviceId);
                } while (!resumed && Boolean.TRUE.equals(autoResuming.get(deviceId)) && server != null);
            } finally {
                autoResuming.remove(deviceId);
            }
        });
    }

    private boolean autoResume(String deviceId) {
        List<Outbox.Entry> entries = new ArrayList<>();
        for (Outbox.Entry en : outbox.list()) {
            if (en.targetId.equals(deviceId) && !Sender.isSessionActive(en.sessionId) && en.lastError != null
                    && (en.lastError.equals("cancelled") || Sender.isTransientError(en.lastError))) {
                entries.add(en);
            }
        }
        if (entries.isEmpty()) return false;
        Sender.Target t = target(deviceId);
        if (t == null) return false;
        lastAutoResume.put(deviceId, System.currentTimeMillis());
        Sender.Control control = new Sender.Control();
        controls.add(control);
        try {
            for (Outbox.Entry en : entries) {
                SendResult r = outbox.resumeEntry(identity, en.sessionId, t, sendOptions(null, control));
                emitResult(r, null);
            }
        } finally {
            controls.remove(control);
        }
        return true;
    }
}
