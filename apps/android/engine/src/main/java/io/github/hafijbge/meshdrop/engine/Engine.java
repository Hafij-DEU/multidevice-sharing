package io.github.hafijbge.meshdrop.engine;

import io.github.hafijbge.meshdrop.engine.bt.LinkPolicy;
import io.github.hafijbge.meshdrop.engine.disc.Discovery;
import io.github.hafijbge.meshdrop.engine.hub.HubClient;
import io.github.hafijbge.meshdrop.engine.identity.Identity;
import io.github.hafijbge.meshdrop.engine.mesh.CompositeTrust;
import io.github.hafijbge.meshdrop.engine.mesh.Join;
import io.github.hafijbge.meshdrop.engine.mesh.MembershipStore;
import io.github.hafijbge.meshdrop.engine.net.Http;
import io.github.hafijbge.meshdrop.engine.net.Tls;
import io.github.hafijbge.meshdrop.engine.net.TrustStore;
import io.github.hafijbge.meshdrop.engine.recv.Inbox;
import io.github.hafijbge.meshdrop.engine.recv.MeshServer;
import io.github.hafijbge.meshdrop.engine.send.LanTransport;
import io.github.hafijbge.meshdrop.engine.send.MultiSend;
import io.github.hafijbge.meshdrop.engine.send.Outbox;
import io.github.hafijbge.meshdrop.engine.send.Prepared;
import io.github.hafijbge.meshdrop.engine.send.RelayTransport;
import io.github.hafijbge.meshdrop.engine.send.SendItem;
import io.github.hafijbge.meshdrop.engine.send.SendResult;
import io.github.hafijbge.meshdrop.engine.send.Sender;
import io.github.hafijbge.meshdrop.engine.send.Transport;
import io.github.hafijbge.meshdrop.engine.util.B64;
import io.github.hafijbge.meshdrop.engine.util.Atomic;
import io.github.hafijbge.meshdrop.engine.util.Json;
import io.github.hafijbge.meshdrop.engine.util.Io;
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
    private static final java.security.SecureRandom RANDOM = new java.security.SecureRandom();
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
        /** How the last attempt ended ("offline": the device was away); null before the first try. */
        public final String lastError;
        /** Auto-resume sends it when the device is seen again (a pause or a transient failure). */
        public final boolean waiting;

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
            this.lastError = e.lastError;
            this.waiting = "cancelled".equals(e.lastError) || Sender.isTransientError(e.lastError);
        }
    }

    private final EngineConfig cfg;
    private final Identity identity;
    private final TrustStore trust;
    private final Inbox inbox;
    private final Outbox outbox;
    private final File manualFile;
    /** The root-signed list of relay hubs (M9). */
    private final io.github.hafijbge.meshdrop.engine.mesh.Relays.Store relayStore;
    /** Mesh members first, then manually paired devices; never a revoked one. */
    private final CompositeTrust trustSource;
    private volatile MembershipStore mesh;
    private volatile HubClient hub;
    private final List<EngineListener> listeners = new CopyOnWriteArrayList<>();
    private final Set<Sender.Control> controls = ConcurrentHashMap.newKeySet();
    private final Map<String, Long> lastAutoResume = new ConcurrentHashMap<>();
    private final Map<String, Boolean> autoResuming = new ConcurrentHashMap<>();
    private volatile boolean accepting = true;
    private volatile MeshServer server;
    private volatile Discovery discovery;
    private volatile ExecutorService exec;
    private volatile int port;
    private volatile java.util.concurrent.ScheduledExecutorService ticker;
    // LAN guests (the desktop's M5a): a one-time QR link for a browser on this network.
    private final io.github.hafijbge.meshdrop.engine.guest.GuestBook guestBook = new io.github.hafijbge.meshdrop.engine.guest.GuestBook();
    private volatile io.github.hafijbge.meshdrop.engine.guest.GuestServer guestServer;
    private volatile int guestPort;
    private volatile io.github.hafijbge.meshdrop.engine.guest.GuestUploads guestUploads;
    private volatile List<io.github.hafijbge.meshdrop.engine.guest.GuestServer.SharedFile> guestShared = new ArrayList<>();
    private volatile String guestUrl;
    private volatile java.util.concurrent.ScheduledFuture<?> guestTimer;
    /** Transfer activity, for wake/Wi-Fi locks: active sends, the last send/receive event, and the reported state. */
    private final Object act = new Object();
    private int activeSends;
    private long lastActivity;
    private boolean busy;

    private Engine(EngineConfig cfg, Identity identity) throws IOException {
        this.cfg = cfg;
        this.relayStore = new io.github.hafijbge.meshdrop.engine.mesh.Relays.Store(cfg.home);
        this.identity = identity;
        this.trust = new TrustStore(new File(cfg.home, "trust.json"));
        this.inbox = new Inbox(new File(cfg.home, "inbox-state"), cfg.sink);
        this.outbox = new Outbox(new File(cfg.home, "outbox"));
        this.syncState = new io.github.hafijbge.meshdrop.engine.sync.SyncState(cfg.home);
        this.manualFile = new File(cfg.home, "manual-peers.json");
        this.port = cfg.port;
        this.trustSource = new CompositeTrust(() -> mesh, trust);
        try {
            this.mesh = MembershipStore.load(cfg.home);
        } catch (IOException | RuntimeException e) {
            this.mesh = null; // an unreadable mesh state must not stop LAN transfers; joining again replaces it
        }
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

    /** This device's mesh state, or null if it is in none. */
    public MembershipStore mesh() {
        return mesh;
    }

    /** The hub link's state ("idle" without a mesh). */
    public HubClient.State hubState() {
        HubClient h = hub;
        return h == null ? HubClient.State.IDLE : h.state();
    }

    /** The verified relay list for this mesh (null: none). */
    public io.github.hafijbge.meshdrop.engine.mesh.Relays.ListView relayList() {
        MembershipStore m = mesh;
        return m == null ? null : relayStore.list(m.anchor, m.list().mesh);
    }

    /** "main", "relay" (linked to a relay hub while the main one is away), or null when offline. */
    public String linkedTo() {
        HubClient h = hub;
        MembershipStore m = mesh;
        String id = h == null ? null : h.linkedHub();
        if (id == null || m == null) return null;
        return id.equals(m.list().hubId) ? "main" : "relay";
    }

    /** The hub's device directory (who is online, last-known LAN addresses); empty without a link. */
    public List<HubClient.DirectoryEntry> directory() {
        HubClient h = hub;
        return h == null ? java.util.Collections.<HubClient.DirectoryEntry>emptyList() : h.directory();
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
        so.app = (peer, msg) -> {
            MeshServer.AppHandler h = appHandler;
            return h == null ? new MeshServer.Reply(404, "{\"error\":\"not-found\"}".getBytes(StandardCharsets.UTF_8)) : h.handle(peer, msg);
        };
        so.port = cfg.port;
        so.alias = cfg.alias;
        so.deviceType = cfg.deviceType;
        so.accepting = () -> accepting;
        so.meshVersion = () -> {
            MembershipStore m = mesh;
            return m == null ? 0 : m.list().version;
        };
        so.membership = () -> {
            MembershipStore m = mesh;
            return m == null ? null : m.current();
        };
        so.sync = new io.github.hafijbge.meshdrop.engine.sync.SyncRoutes(syncState, this::openSyncFolder, (peer, f) -> scheduleSync(f, peer, 300));
        MeshServer s = new MeshServer(identity, trustSource, inbox, ev -> {
            touch();
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
        startHub();
        startGuestServer();
        startBt();
        ticker = java.util.concurrent.Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "meshdrop-ticker");
            t.setDaemon(true);
            return t;
        });
        // Manual peers come back by themselves after a blip (no multicast to announce them).
        ticker.scheduleWithFixedDelay(() -> {
            if (idleSkip("reprobe", IDLE_REPROBE_MS)) return;
            execute(this::reprobeManual);
        }, cfg.manualReprobeMs, cfg.manualReprobeMs, java.util.concurrent.TimeUnit.MILLISECONDS);
        long tick = Math.max(50, cfg.activityIdleMs / 4);
        ticker.scheduleWithFixedDelay(this::activityTick, tick, tick, java.util.concurrent.TimeUnit.MILLISECONDS);
        ticker.scheduleWithFixedDelay(() -> execute(this::finishPendingJoin), 0, PENDING_RETRY_MS, java.util.concurrent.TimeUnit.MILLISECONDS);
        ticker.scheduleWithFixedDelay(() -> {
            if (idleSkip("sync", IDLE_SYNC_MS)) return;
            syncPresent();
        }, SYNC_INTERVAL_MS, SYNC_INTERVAL_MS, java.util.concurrent.TimeUnit.MILLISECONDS);
    }

    // ---- the hub link -------------------------------------------------------------------------

    private List<HubClient.LanAddr> defaultLanAddrs() {
        List<HubClient.LanAddr> out = new ArrayList<>();
        for (Map.Entry<NetworkInterface, java.net.Inet4Address> a : Discovery.interfaceAddrs()) out.add(new HubClient.LanAddr(a.getValue().getHostAddress(), port));
        return out;
    }

    private synchronized void startHub() {
        if (mesh == null || hub != null || server == null) return;
        HubClient.Options ho = new HubClient.Options(identity, () -> mesh);
        ho.lanAddrs = cfg.lanAddrs != null ? cfg.lanAddrs : this::defaultLanAddrs;
        ho.hubLan = this::hubLan;
        ho.backoffMs = cfg.hubBackoffMs;
        ho.failbackMs = cfg.hubFailbackMs;
        ho.drainMs = cfg.hubDrainMs;
        ho.relays = () -> {
            io.github.hafijbge.meshdrop.engine.mesh.Relays.ListView l = relayList();
            return l == null ? java.util.Collections.emptyList() : l.relays;
        };
        ho.handler = (peer, method, path, contentType, body) -> {
            MeshServer s = server;
            if (s == null) return null;
            touch();
            return s.handle(peer, method, path, contentType, body);
        };
        ho.listener = new HubClient.Listener() {
            @Override
            public void onState(HubClient.State st) {
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("state", st.toString());
                emit("hub", "state", m);
            }

            @Override
            public void onMembership(Map<String, Object> signed) {
                MembershipStore m = mesh;
                Map<String, Object> d = new LinkedHashMap<>();
                d.put("version", m == null ? 0L : m.list().version);
                emit("mesh", "membership", d);
            }

            @Override
            public void onDirectory(List<HubClient.DirectoryEntry> devices) {
                emit("hub", "directory", new LinkedHashMap<>());
                for (HubClient.DirectoryEntry d : devices) if (d.online) maybeAutoResume(d.deviceId);
            }

            @Override
            public void onRevoked() {
                execute(Engine.this::leaveMesh);
            }

            @Override
            public void onRelays(Object signed) {
                MembershipStore m = mesh;
                if (m == null) return;
                try {
                    if ("updated".equals(relayStore.accept(signed, m.anchor, m.list().mesh))) emit("mesh", "relays", new LinkedHashMap<>());
                } catch (IOException | RuntimeException ignored) {
                    // not signed by this mesh's root
                }
            }

            @Override
            public void onHeld(String type, Map<String, Object> m) {
                Map<String, Object> d = new LinkedHashMap<>();
                for (String k : new String[] {"to", "sessionId", "files", "status", "error"}) if (m.get(k) != null) d.put(k, m.get(k));
                emit("mesh", type, d);
            }
        };
        HubClient h = new HubClient(ho);
        hub = h;
        h.start();
    }

    /**
     * Where the hub is on the LAN: where discovery sees it now (remembered for next time), else the
     * address remembered from the join or an earlier link.
     */
    private HubClient.LanAddr hubLan() {
        MembershipStore m = mesh;
        if (m == null) return null;
        String hubId = m.list().hubId;
        HubClient.LanAddr saved = Join.readHubAddr(cfg.home, hubId);
        Discovery d = discovery;
        Discovery.PeerInfo p = d == null ? null : d.peer(hubId);
        if (p == null) return saved;
        if (saved == null || !saved.host.equals(p.host) || saved.port != p.port) {
            try {
                Join.writeHubAddr(cfg.home, hubId, new io.github.hafijbge.meshdrop.engine.mesh.Invite.Addr(p.host, p.port));
            } catch (IOException ignored) {
                // remembered next time
            }
        }
        return new HubClient.LanAddr(p.host, p.port);
    }

    private synchronized void stopHub() {
        HubClient h = hub;
        hub = null;
        if (h != null) h.shutdown();
    }

    /**
     * Redeems a QR invite ("member", or "provisional": the inviter has the hub sign this device in
     * later, and the engine finishes the join by itself once it has).
     */
    public String join(String uri, String alias) throws IOException {
        if (mesh != null) throw new IOException("join: this device is already in a mesh");
        String status = Join.join(identity, uri, alias, cfg.home, trust);
        if (status.equals("member")) adoptMesh();
        return status;
    }

    /** True while a provisional join waits for the hub to sign this device in. */
    public boolean joinPending() {
        return mesh == null && Join.pending(cfg.home);
    }

    private void adoptMesh() throws IOException {
        MembershipStore m = MembershipStore.load(cfg.home);
        if (m == null) return;
        synchronized (this) {
            mesh = m;
            startHub();
        }
        Map<String, Object> d = new LinkedHashMap<>();
        d.put("version", m.list().version);
        emit("mesh", "joined", d);
    }

    private void finishPendingJoin() {
        if (!joinPending() || server == null) return;
        try {
            Join.complete(identity, cfg.home);
            adoptMesh();
        } catch (IOException | RuntimeException ignored) {
            // the hub has not signed us in yet, or the inviter is away: next time
        }
    }

    /** This device was revoked: drop the mesh state (the identity stays) and tell the app once. */
    private void leaveMesh() {
        synchronized (this) {
            if (mesh == null) return;
            stopHub();
            mesh = null;
            MembershipStore.drop(cfg.home);
        }
        emit("mesh", "revoked", new LinkedHashMap<>());
    }

    private static final long PULL_INTERVAL_MS = 60_000;
    private static final long PENDING_RETRY_MS = 10_000;
    private final Map<String, Long> lastPull = new ConcurrentHashMap<>();

    /**
     * While the hub is unreachable, a LAN peer advertising a newer list version (mv in GET info) shares
     * it; it only counts if it verifies against our anchor (MembershipStore.accept).
     */
    @SuppressWarnings("unchecked")
    private void maybePull(Discovery.PeerInfo p) {
        MembershipStore m = mesh;
        if (server == null || m == null || hubOnline()) return;
        Long last = lastPull.get(p.deviceId);
        if (last != null && System.currentTimeMillis() - last < PULL_INTERVAL_MS) return;
        lastPull.put(p.deviceId, System.currentTimeMillis());
        try {
            Http.Response info = Http.request(Tls.connect(Tls.pinnedClient(identity, p.deviceId), p.host, p.port, REPROBE_TIMEOUT_MS), "GET", "/mesh/v1/info", null, null, 64 * 1024);
            Object j = info.status == 200 ? Json.parse(info.text()) : null;
            Object mv = j instanceof Map ? ((Map<String, Object>) j).get("mv") : null;
            if (!(mv instanceof Long) || (Long) mv <= m.list().version) return;
            Http.Response res = Http.request(Tls.connect(Tls.pinnedClient(identity, p.deviceId), p.host, p.port, REPROBE_TIMEOUT_MS), "GET", "/mesh/v1/membership", null, null, 4 << 20);
            if (res.status != 200) return;
            Object s = Json.parse(res.text());
            if (!(s instanceof Map) || !"updated".equals(m.accept((Map<String, Object>) s))) return;
            Map<String, Object> d = new LinkedHashMap<>();
            d.put("version", m.list().version);
            emit("mesh", "membership", d);
            if (m.isRevoked(identity.deviceId())) leaveMesh();
        } catch (IOException | RuntimeException ignored) {
            // a peer with a bad or foreign list is ignored
        }
    }

    private boolean hubOnline() {
        return hubState() == HubClient.State.ONLINE;
    }

    private HubClient.DirectoryEntry directoryEntry(String deviceId) {
        for (HubClient.DirectoryEntry d : directory()) if (d.deviceId.equals(deviceId)) return d;
        return null;
    }

    /** Runs on the engine's executor unless it is stopping (never throws). */
    private void execute(Runnable r) {
        ExecutorService e = exec;
        if (e == null) return;
        try {
            e.execute(() -> {
                try {
                    r.run();
                } catch (RuntimeException ignored) {
                    // a background task must never take the process down
                }
            });
        } catch (java.util.concurrent.RejectedExecutionException ignored) {
            // stopping
        }
    }

    // ---- activity (wake locks) ---------------------------------------------------------------------

    private void notifyBusy(boolean b) {
        EngineConfig.ActivityListener l = cfg.activity;
        if (l == null) return;
        try {
            l.onBusy(b);
        } catch (RuntimeException ignored) {
            // the platform's problem
        }
    }

    /** A send or receive event happened. */
    private void touch() {
        boolean becameBusy = false;
        synchronized (act) {
            lastActivity = System.currentTimeMillis();
            if (!busy) {
                busy = true;
                becameBusy = true;
            }
        }
        if (becameBusy) notifyBusy(true);
    }

    private void sendStarted() {
        synchronized (act) {
            activeSends++;
        }
        touch();
    }

    private void sendEnded() {
        synchronized (act) {
            activeSends--;
            lastActivity = System.currentTimeMillis();
        }
    }

    private void activityTick() {
        boolean becameIdle = false;
        synchronized (act) {
            if (busy && activeSends == 0 && System.currentTimeMillis() - lastActivity >= cfg.activityIdleMs) {
                busy = false;
                becameIdle = true;
            }
        }
        if (becameIdle) notifyBusy(false);
    }

    private Discovery makeDiscovery() {
        Discovery.Options o = new Discovery.Options(identity.deviceId(), truncate(cfg.alias), cfg.deviceType, port);
        if (cfg.discoveryPort != null) o.port = cfg.discoveryPort;
        o.intervalMs = cfg.discoveryIntervalMs;
        o.isTrusted = trustSource::isTrusted;
        Discovery d = new Discovery(o);
        d.addListener(new Discovery.Listener() {
            @Override
            public void onPeer(Discovery.PeerInfo p) {
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("peer", p.toMap());
                emit("discovery", "peer", m);
                maybeAutoResume(p.deviceId);
                execute(() -> maybePull(p));
                scheduleSync(null, p.deviceId, 1000);
                MembershipStore ms = mesh;
                HubClient h = hub;
                // The hub showed up on the LAN (or moved): link to it there now instead of waiting out the backoff.
                if (ms != null && h != null && p.deviceId.equals(ms.list().hubId) && h.state() != HubClient.State.ONLINE) h.relink();
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
        stopHub();
        io.github.hafijbge.meshdrop.engine.bt.BtLinks bl = btLinks;
        btLinks = null;
        if (bl != null) bl.stop();
        endGuest(false);
        io.github.hafijbge.meshdrop.engine.guest.GuestServer gs = guestServer;
        guestServer = null;
        if (gs != null) gs.stop();
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
        java.util.concurrent.ScheduledExecutorService t = ticker;
        ticker = null;
        if (t != null) t.shutdownNow();
        boolean wasBusy;
        synchronized (act) {
            wasBusy = busy;
            busy = false;
            activeSends = 0;
        }
        if (wasBusy) notifyBusy(false);
    }

    /** After a network change: re-bind discovery on the current interfaces, re-probe manual peers, re-check auto-resume. */
    public void restartNetworking() {
        Discovery d = discovery;
        if (d == null || exec == null) return;
        if (cfg.discovery) d.restart(); // keeps manual peers
        execute(this::reprobeManual);
        HubClient h = hub;
        if (h != null) h.relink(); // the old link may be half-open and announced old addresses
    }

    private Discovery requireRunning() {
        Discovery d = discovery;
        if (d == null || server == null) throw new IllegalStateException("engine not started");
        return d;
    }

    // ---- idle (screen off) ----------------------------------------------------------------------

    /** While idle, background work runs this rarely (receiving, the hub link and discovery are unchanged). */
    static final long IDLE_SYNC_MS = 15 * 60_000;
    static final long IDLE_REPROBE_MS = 5 * 60_000;
    private volatile boolean idle;
    private final Map<String, Long> idleLast = new ConcurrentHashMap<>();

    /**
     * Idle (Android: the screen is off): periodic sync rounds and re-probing of paired devices slow
     * down to save battery. Incoming sends, the hub link and LAN discovery keep working as before; a
     * device that shows up, a partner's poke or "Sync now" still sync at once.
     */
    public void setIdle(boolean on) {
        idle = on;
        if (!on) {
            idleLast.clear();
            execute(this::reprobeManual);
            execute(this::syncPresent);
        }
    }

    public boolean idle() {
        return idle;
    }

    /** True if a periodic `job` should be skipped now: idle, and it ran less than `everyMs` ago. */
    private boolean idleSkip(String job, long everyMs) {
        if (!idle) return false;
        long now = System.currentTimeMillis();
        Long last = idleLast.get(job);
        if (last != null && now - last < everyMs) return true;
        idleLast.put(job, now);
        return false;
    }

    // ---- folder sync (M8a, LAN only) ------------------------------------------------------------

    private static final long SYNC_INTERVAL_MS = 60_000;
    private final io.github.hafijbge.meshdrop.engine.sync.SyncState syncState;
    /** Opened folders by sync name (a picked Android folder whose grant is gone opens as null). */
    private final Map<String, io.github.hafijbge.meshdrop.engine.sync.SyncFolder> syncOpen = new ConcurrentHashMap<>();
    private final Set<String> syncRunning = ConcurrentHashMap.newKeySet();
    private final Map<String, Object> syncLocks = new ConcurrentHashMap<>();
    private final Map<String, Map<String, Object>> syncLast = new ConcurrentHashMap<>();

    /** The folder for a sync name, opened on first use; null if there is none or it cannot be opened. */
    private io.github.hafijbge.meshdrop.engine.sync.SyncFolder openSyncFolder(String name) {
        io.github.hafijbge.meshdrop.engine.sync.SyncFolder f = syncOpen.get(name);
        if (f != null) return f;
        for (io.github.hafijbge.meshdrop.engine.sync.SyncState.FolderConfig c : syncState.folders()) {
            if (!c.name.equals(name)) continue;
            try {
                f = cfg.syncFolders.open(c.folder);
                syncOpen.put(name, f);
                return f;
            } catch (IOException | RuntimeException e) {
                return null; // gone or permission revoked: choose it again
            }
        }
        return null;
    }

    public List<io.github.hafijbge.meshdrop.engine.sync.SyncState.FolderConfig> syncFolders() {
        return syncState.folders();
    }

    /**
     * Adds or changes a synced folder (a path, or on Android a picked folder's URI). `name` matches it
     * with the partners' folders (null/empty: the folder's own name); `previousName` renames that entry.
     */
    public synchronized io.github.hafijbge.meshdrop.engine.sync.SyncState.FolderConfig syncPut(String name, String folder, List<String> partners, String previousName) throws IOException {
        String f = folder == null ? "" : folder.trim();
        if (f.isEmpty()) throw new IllegalArgumentException("Choose a folder.");
        String n = name == null || name.trim().isEmpty() ? io.github.hafijbge.meshdrop.engine.sync.SyncState.defaultName(f) : name.trim();
        if (!io.github.hafijbge.meshdrop.engine.sync.SyncState.validName(n)) throw new IllegalArgumentException("A sync name is 1–64 characters, without \"/\".");
        String key = previousName != null ? previousName : n;
        List<io.github.hafijbge.meshdrop.engine.sync.SyncState.FolderConfig> cur = syncState.folders();
        List<io.github.hafijbge.meshdrop.engine.sync.SyncState.FolderConfig> next = new ArrayList<>();
        int at = -1;
        for (io.github.hafijbge.meshdrop.engine.sync.SyncState.FolderConfig c : cur) {
            if (c.name.equals(key)) {
                at = next.size();
                next.add(c);
                continue;
            }
            if (c.name.equals(n)) throw new IllegalArgumentException("Another synced folder is already called \"" + n + "\".");
            if (c.folder.equals(f)) throw new IllegalArgumentException("That folder is already synced as \"" + c.name + "\".");
            next.add(c);
        }
        if (at < 0 && next.size() >= io.github.hafijbge.meshdrop.engine.sync.SyncState.MAX_FOLDERS) throw new IllegalArgumentException("At most " + io.github.hafijbge.meshdrop.engine.sync.SyncState.MAX_FOLDERS + " synced folders.");
        io.github.hafijbge.meshdrop.engine.sync.SyncFolder opened = cfg.syncFolders.open(f);
        List<String> ids = new ArrayList<>();
        for (String q : partners) {
            String id = resolveDeviceId(q);
            if (!ids.contains(id)) ids.add(id);
        }
        io.github.hafijbge.meshdrop.engine.sync.SyncState.FolderConfig entry = new io.github.hafijbge.meshdrop.engine.sync.SyncState.FolderConfig(n, f, ids);
        if (at >= 0) next.set(at, entry);
        else next.add(entry);
        syncState.setFolders(next);
        if (previousName != null && !previousName.equals(n)) {
            syncState.forget(previousName);
            syncOpen.remove(previousName);
        }
        syncOpen.put(n, opened);
        for (String id : ids) scheduleSync(n, id, 500);
        return entry;
    }

    /** Stops syncing a folder (its files stay). */
    public synchronized void syncRemove(String name) throws IOException {
        List<io.github.hafijbge.meshdrop.engine.sync.SyncState.FolderConfig> next = new ArrayList<>();
        for (io.github.hafijbge.meshdrop.engine.sync.SyncState.FolderConfig c : syncState.folders()) if (!c.name.equals(name)) next.add(c);
        syncState.setFolders(next);
        syncState.forget(name);
        syncOpen.remove(name);
    }

    /** {folders:[{name, folder, partners:[{deviceId, alias?, present, syncing, last?}]}]} as the desktop's. */
    public Map<String, Object> syncStatus() {
        Discovery d = discovery;
        List<Object> fs = new ArrayList<>();
        for (io.github.hafijbge.meshdrop.engine.sync.SyncState.FolderConfig c : syncState.folders()) {
            Map<String, Object> fm = new LinkedHashMap<>();
            fm.put("name", c.name);
            fm.put("folder", c.folder);
            List<Object> ps = new ArrayList<>();
            for (String id : c.partners) {
                String key = c.name + "\0" + id;
                Map<String, Object> p = new LinkedHashMap<>();
                p.put("deviceId", id);
                TrustStore.Device t = trustSource.get(id);
                if (t != null) p.put("alias", t.alias);
                p.put("present", d != null && d.peer(id) != null);
                p.put("syncing", syncRunning.contains(key));
                if (syncLast.containsKey(key)) p.put("last", new LinkedHashMap<>(syncLast.get(key)));
                ps.add(p);
            }
            fm.put("partners", ps);
            fs.add(fm);
        }
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("folders", fs);
        return m;
    }

    /** Runs a round now with every partner on the LAN, for one folder (or null: all), and waits for them. */
    public void syncNow(String name) {
        Discovery d = requireRunning();
        for (io.github.hafijbge.meshdrop.engine.sync.SyncState.FolderConfig c : syncState.folders()) {
            if (name != null && !c.name.equals(name)) continue;
            for (String id : c.partners) if (d.peer(id) != null) runSync(c.name, id);
        }
    }

    private void syncPresent() {
        Discovery d = discovery;
        if (d == null) return;
        for (io.github.hafijbge.meshdrop.engine.sync.SyncState.FolderConfig c : syncState.folders()) for (String id : c.partners) if (d.peer(id) != null) execute(() -> runSync(c.name, id));
    }

    /** Rounds with `partner` for folder `name`, or (null) every folder shared with it. */
    private void scheduleSync(String name, String partner, long delayMs) {
        java.util.concurrent.ScheduledExecutorService t = ticker;
        if (t == null) return;
        try {
            t.schedule(() -> {
                for (io.github.hafijbge.meshdrop.engine.sync.SyncState.FolderConfig c : syncState.folders()) {
                    if ((name == null || c.name.equals(name)) && c.partners.contains(partner)) execute(() -> runSync(c.name, partner));
                }
            }, delayMs, java.util.concurrent.TimeUnit.MILLISECONDS);
        } catch (java.util.concurrent.RejectedExecutionException ignored) {
            // stopping
        }
    }

    /** One round per folder and partner at a time: a caller during a round waits for it, then runs its own. */
    private void runSync(String name, String partner) {
        String key = name + "\0" + partner;
        Object lock = syncLocks.computeIfAbsent(key, k -> new Object());
        synchronized (lock) {
            syncRunning.add(key);
            try {
                syncOnce(name, partner);
            } finally {
                syncRunning.remove(key);
            }
        }
    }

    private void syncOnce(String name, String partner) {
        io.github.hafijbge.meshdrop.engine.sync.SyncState.FolderConfig c = null;
        for (io.github.hafijbge.meshdrop.engine.sync.SyncState.FolderConfig x : syncState.folders()) if (x.name.equals(name)) c = x;
        Discovery d = discovery;
        TrustStore.Device t = trustSource.get(partner);
        if (c == null || d == null || server == null || t == null || !c.partners.contains(partner)) return;
        Discovery.PeerInfo p = d.peer(partner);
        if (p == null) return; // LAN only
        String key = name + "\0" + partner;
        Map<String, Object> last = new LinkedHashMap<>();
        last.put("at", System.currentTimeMillis());
        try {
            io.github.hafijbge.meshdrop.engine.sync.SyncFolder f = openSyncFolder(name);
            if (f == null) throw new IOException("MeshDrop lost access to this folder: choose it again");
            touch();
            io.github.hafijbge.meshdrop.engine.sync.SyncRound.Result r = io.github.hafijbge.meshdrop.engine.sync.SyncRound.run(f, name, syncState,
                    new LanTransport(identity, new Sender.Target(partner, p.host, p.port, t.key), 10_000), identity.deviceId(), partner, t.alias,
                    () -> server == null, System.currentTimeMillis());
            last.put("pulled", (long) r.pulled);
            last.put("deleted", (long) r.deleted);
            last.put("conflicts", (long) r.conflicts);
            last.put("errors", (long) r.errors.size());
            syncLast.put(key, last);
            // Our own edits (no file watcher on Android): tell the partner to pull now.
            if (r.localChanged || r.pulled + r.deleted + r.conflicts > 0) {
                try {
                    new LanTransport(identity, new Sender.Target(partner, p.host, p.port, t.key), 10_000).request("POST",
                            "/mesh/v1/sync/poke?f=" + java.net.URLEncoder.encode(name, "UTF-8"), null, null, 10_000, null, null);
                } catch (IOException ignored) {
                    // it pulls on its own timer
                }
            }
            Map<String, Object> ev = new LinkedHashMap<>(last);
            ev.remove("at");
            ev.put("folder", name);
            ev.put("partner", partner);
            emit("sync", "round", ev);
        } catch (IOException | RuntimeException e) {
            last.put("pulled", 0L);
            last.put("deleted", 0L);
            last.put("conflicts", 0L);
            last.put("errors", 0L);
            last.put("error", e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
            syncLast.put(key, last);
            Map<String, Object> ev = new LinkedHashMap<>();
            ev.put("folder", name);
            ev.put("partner", partner);
            ev.put("error", last.get("error"));
            emit("sync", "error", ev);
        }
    }

    // ---- LAN guests ---------------------------------------------------------------------------

    public static final int MIN_GUEST_MINUTES = 5;
    public static final int MAX_GUEST_MINUTES = 24 * 60;

    /** The guest server answers only while a session is open; a port that is taken leaves guests unavailable. */
    private void startGuestServer() {
        if (cfg.guestPort < 0) return;
        io.github.hafijbge.meshdrop.engine.guest.GuestServer.Options go = new io.github.hafijbge.meshdrop.engine.guest.GuestServer.Options();
        go.book = guestBook;
        go.uploads = () -> guestUploads;
        go.shared = () -> guestShared;
        go.alias = () -> cfg.alias;
        go.html = io.github.hafijbge.meshdrop.engine.guest.GuestPage.HTML;
        go.js = io.github.hafijbge.meshdrop.engine.guest.GuestPage.JS;
        go.css = io.github.hafijbge.meshdrop.engine.guest.GuestPage.CSS;
        go.onClaim = () -> emit("guest", "claimed", new LinkedHashMap<>());
        io.github.hafijbge.meshdrop.engine.guest.GuestServer gs = new io.github.hafijbge.meshdrop.engine.guest.GuestServer(go);
        try {
            guestPort = gs.start(cfg.guestPort);
            guestServer = gs;
        } catch (IOException e) {
            guestServer = null; // e.g. the port is taken: guestState() says unavailable
        }
    }

    /** The address a guest's browser on this network reaches: Wi-Fi first, then any private IPv4. */
    private String guestHost() {
        if (cfg.lanAddrs != null) {
            List<HubClient.LanAddr> a = cfg.lanAddrs.get();
            if (a != null && !a.isEmpty()) return a.get(0).host;
        }
        String best = null;
        for (Map.Entry<NetworkInterface, java.net.Inet4Address> a : Discovery.interfaceAddrs()) {
            String host = a.getValue().getHostAddress();
            String name = a.getKey().getName();
            if (name.startsWith("wlan") || name.startsWith("ap") || name.startsWith("swlan")) return host;
            if (best == null && a.getValue().isSiteLocalAddress()) best = host;
        }
        return best != null ? best : "127.0.0.1";
    }

    /**
     * Opens a guest session (ending any earlier one): a one-time link for a browser on the LAN, shown
     * as a QR code: {url, qrSvg, expiresAt}. The guest can send to this device (after guestAccept) and
     * download what guestShare offers. `ttlMs` > 0 overrides `minutes` (tests).
     */
    public Map<String, Object> guestStart(int minutes, long ttlMs) {
        requireRunning();
        if (guestServer == null) throw new IllegalStateException("Guest links are not available: port " + cfg.guestPort + " is used by another app.");
        endGuest(false);
        int m = Math.min(MAX_GUEST_MINUTES, Math.max(MIN_GUEST_MINUTES, minutes));
        long ttl = ttlMs > 0 ? Math.max(100, ttlMs) : m * 60_000L;
        io.github.hafijbge.meshdrop.engine.guest.GuestBook.Current cur = guestBook.open(ttl);
        guestUploads = new io.github.hafijbge.meshdrop.engine.guest.GuestUploads(new File(cfg.home, "guest-partial"), cfg.sink, this::onGuest);
        java.util.concurrent.ScheduledExecutorService t = ticker;
        // At the end of its time the session ends for real: unfinished uploads are deleted now, not later.
        if (t != null) guestTimer = t.schedule(() -> endGuest(true), ttl, java.util.concurrent.TimeUnit.MILLISECONDS);
        String host = guestHost();
        guestUrl = "http://" + (host.contains(":") ? "[" + host + "]" : host) + ":" + guestPort + "/g/" + cur.token;
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("url", guestUrl);
        out.put("qrSvg", io.github.hafijbge.meshdrop.engine.guest.GuestPage.qrSvg(guestUrl));
        out.put("expiresAt", cur.expiresAt);
        return out;
    }

    /** Ends the guest session: the link stops working, unfinished uploads are deleted, shares are cleared. */
    public void guestEnd() {
        endGuest(true);
    }

    private synchronized void endGuest(boolean announce) {
        java.util.concurrent.ScheduledFuture<?> t = guestTimer;
        guestTimer = null;
        if (t != null) t.cancel(false);
        boolean had = guestBook.current() != null || guestUploads != null;
        guestBook.end();
        io.github.hafijbge.meshdrop.engine.guest.GuestUploads u = guestUploads;
        guestUploads = null;
        guestShared = new ArrayList<>();
        guestUrl = null;
        if (u != null) u.cancelAll();
        if (announce && had) emit("guest", "ended", new LinkedHashMap<>());
    }

    private void onGuest(Map<String, Object> ev) {
        Map<String, Object> d = new LinkedHashMap<>(ev);
        String type = ((String) d.remove("type")).substring("guest-".length());
        if (type.equals("received") || type.equals("file")) touch();
        emit("guest", type, d);
    }

    /** Offers files to the guest; returns the new entries [{id, name, size}]. */
    public List<Map<String, Object>> guestShare(List<io.github.hafijbge.meshdrop.engine.send.Source> sources) throws IOException {
        if (guestBook.current() == null) throw new IllegalStateException("No guest session: show a guest QR code first.");
        List<io.github.hafijbge.meshdrop.engine.guest.GuestServer.SharedFile> added = new ArrayList<>();
        List<Map<String, Object>> out = new ArrayList<>();
        for (io.github.hafijbge.meshdrop.engine.send.Source src : sources) {
            byte[] id = new byte[9];
            RANDOM.nextBytes(id);
            io.github.hafijbge.meshdrop.engine.guest.GuestServer.SharedFile f = new io.github.hafijbge.meshdrop.engine.guest.GuestServer.SharedFile(B64.url(id), src.name(), src.size(), src);
            added.add(f);
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", f.id);
            m.put("name", f.name);
            m.put("size", f.size);
            out.add(m);
        }
        List<io.github.hafijbge.meshdrop.engine.guest.GuestServer.SharedFile> all = new ArrayList<>(guestShared);
        all.addAll(added);
        guestShared = all;
        return out;
    }

    public void guestUnshare(String id) {
        List<io.github.hafijbge.meshdrop.engine.guest.GuestServer.SharedFile> all = new ArrayList<>(guestShared);
        all.removeIf(f -> f.id.equals(id));
        guestShared = all;
    }

    private io.github.hafijbge.meshdrop.engine.guest.GuestUploads uploadsOf(String id) {
        io.github.hafijbge.meshdrop.engine.guest.GuestUploads u = guestUploads;
        if (u == null || !u.has(id)) throw new IllegalArgumentException("That guest send is no longer there.");
        return u;
    }

    public void guestAccept(String id) throws IOException {
        try {
            uploadsOf(id).accept(id);
        } catch (io.github.hafijbge.meshdrop.engine.guest.GuestUploads.GuestError e) {
            throw new IllegalStateException("That guest send was already answered (" + e.code + ").");
        }
    }

    public void guestReject(String id) {
        try {
            uploadsOf(id).reject(id);
        } catch (io.github.hafijbge.meshdrop.engine.guest.GuestUploads.GuestError ignored) {
            // gone already
        }
    }

    /** {active, available, url?, expiresAt?, claimed?, shared:[{id,name,size}], offers:[{id, files, text?}]} */
    public Map<String, Object> guestState() {
        Map<String, Object> m = new LinkedHashMap<>();
        io.github.hafijbge.meshdrop.engine.guest.GuestBook.Current cur = guestBook.current();
        io.github.hafijbge.meshdrop.engine.guest.GuestUploads u = guestUploads;
        boolean active = cur != null && u != null;
        m.put("active", active);
        m.put("available", guestServer != null);
        List<Object> shared = new ArrayList<>();
        if (active) {
            m.put("url", guestUrl == null ? "" : guestUrl);
            m.put("expiresAt", cur.expiresAt);
            m.put("claimed", cur.claimed);
            for (io.github.hafijbge.meshdrop.engine.guest.GuestServer.SharedFile f : guestShared) {
                Map<String, Object> x = new LinkedHashMap<>();
                x.put("id", f.id);
                x.put("name", f.name);
                x.put("size", f.size);
                shared.add(x);
            }
        }
        m.put("shared", shared);
        m.put("offers", active ? new ArrayList<Object>(u.pending()) : new ArrayList<>());
        return m;
    }

    public int guestPort() {
        return guestPort;
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
            Object j = Json.parse(Io.readString(manualFile.toPath()));
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
                } catch (IOException | RuntimeException ignored) {
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
        return pairManual(host, port, alias, null);
    }

    /** Pairing details of the device at host:port, without trusting it. */
    public static final class PairProbe {
        public final String deviceId;
        public final String alias;
        public final String code;

        PairProbe(String deviceId, String alias, String code) {
            this.deviceId = deviceId;
            this.alias = alias;
            this.code = code;
        }
    }

    /**
     * Looks at the device at host:port without trusting it: its id, its name, and the pairing code to
     * compare with what that device shows (both compute it from the two ids).
     */
    public PairProbe pairProbe(String host, int port) throws IOException {
        Discovery d = requireRunning();
        if (port < 1 || port > 65535) throw new IOException("pair: invalid port " + port);
        SSLSocket s = Tls.connect(Tls.probeClient(), host, port, PAIR_TIMEOUT_MS);
        String deviceId;
        try {
            deviceId = Identity.deviceIdOf(Tls.peerCertDer(s));
        } finally {
            s.close();
        }
        if (deviceId.equals(identity.deviceId())) throw new IOException("pair: that is this device; you cannot pair with yourself");
        String alias = host;
        try {
            Discovery.PeerInfo p = d.probe(host, port, PAIR_TIMEOUT_MS);
            if (p.deviceId.equals(deviceId)) alias = p.alias;
        } catch (IOException ignored) {
            // the name is only a label here
        }
        return new PairProbe(deviceId, alias, TrustStore.pairingCode(identity.deviceId(), deviceId));
    }

    /** The pairing code with a device (the same number that device shows for this one). */
    public String pairingCode(String deviceId) {
        return TrustStore.pairingCode(identity.deviceId(), deviceId);
    }

    /**
     * Same, and {@code expectDeviceId} (may be null) is the device whose pairing code the user checked
     * (pairProbe): a different certificate answering now is refused.
     */
    public TrustStore.Device pairManual(String host, int port, String alias, String expectDeviceId) throws IOException {
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
        if (expectDeviceId != null && !deviceId.equals(expectDeviceId)) {
            throw new IOException("pair: another device answered at that address than the one whose code you checked");
        }
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

    /**
     * Unpairs a manually paired device: no longer trusted, its saved address and unfinished sends are
     * dropped; on the LAN it shows as nearby again (Pair re-pairs it). Mesh members are revoked on the hub.
     */
    public void unpair(String query) throws IOException {
        String id = resolveDeviceId(query);
        MembershipStore m = mesh;
        if (m != null && m.isTrusted(id)) throw new IllegalStateException("This device is in your mesh: remove it on the hub PC (More → Mesh → Revoke).");
        trust.remove(id);
        List<Map<String, Object>> manual = readManual();
        manual.removeIf(x -> id.equals(x.get("deviceId")));
        writeManual(manual);
        for (Outbox.Entry e : outbox.list()) if (id.equals(e.targetId)) outbox.remove(e.sessionId);
        List<io.github.hafijbge.meshdrop.engine.sync.SyncState.FolderConfig> fs = new ArrayList<>();
        boolean changed = false;
        for (io.github.hafijbge.meshdrop.engine.sync.SyncState.FolderConfig f : syncState.folders()) {
            List<String> ps = new ArrayList<>(f.partners);
            changed |= ps.remove(id);
            fs.add(new io.github.hafijbge.meshdrop.engine.sync.SyncState.FolderConfig(f.name, f.folder, ps));
        }
        if (changed) syncState.setFolders(fs);
    }

    public void forgetPeer(String deviceId) {
        Discovery d = discovery;
        if (d != null) d.forget(deviceId);
    }

    /** Mesh members, paired devices (on the LAN, through the hub, or offline) and untrusted LAN peers; never this device. */
    public List<EngineDevice> devices() {
        Discovery d = discovery;
        Map<String, Discovery.PeerInfo> peers = new LinkedHashMap<>();
        if (d != null) for (Discovery.PeerInfo p : d.peers()) peers.put(p.deviceId, p);
        Map<String, HubClient.DirectoryEntry> dir = new LinkedHashMap<>();
        for (HubClient.DirectoryEntry e : directory()) dir.put(e.deviceId, e);
        boolean viaHub = hubOnline();
        Set<String> bt = new java.util.HashSet<>(btLinked());
        List<EngineDevice> out = new ArrayList<>();
        Set<String> seen = new LinkedHashSet<>();
        seen.add(identity.deviceId());
        MembershipStore m = mesh;
        if (m != null) {
            for (io.github.hafijbge.meshdrop.engine.mesh.Membership.Member x : m.list().members) {
                if (!seen.add(x.deviceId)) continue;
                Discovery.PeerInfo p = peers.get(x.deviceId);
                HubClient.DirectoryEntry e = dir.get(x.deviceId);
                String reach = reach(x.deviceId, p != null, bt, viaHub && e != null && e.online);
                out.add(new EngineDevice(x.deviceId, x.alias, x.role, true, reach, p != null ? p.deviceType : null, p != null ? p.lastSeen : e != null ? e.lastSeen : 0));
            }
        }
        for (TrustStore.Device t : trust.list()) {
            if (!seen.add(t.deviceId) || !trustSource.isTrusted(t.deviceId)) continue;
            Discovery.PeerInfo p = peers.get(t.deviceId);
            out.add(new EngineDevice(t.deviceId, t.alias, "paired", true, reach(t.deviceId, p != null, bt, false), p != null ? p.deviceType : null, p != null ? p.lastSeen : 0));
        }
        for (Discovery.PeerInfo p : peers.values()) {
            if (!seen.add(p.deviceId)) continue;
            out.add(new EngineDevice(p.deviceId, p.alias, "nearby", false, "lan", p.deviceType, p.lastSeen, p.host, p.port));
        }
        return out;
    }

    private String reach(String deviceId, boolean onLan, Set<String> bt, boolean onHub) {
        String mode = linkMode(deviceId);
        if (!mode.equals(LinkPolicy.BT) && onLan) return "lan";
        if (!mode.equals(LinkPolicy.WIFI) && bt.contains(deviceId)) return "bt";
        return !mode.equals(LinkPolicy.BT) && onHub ? "hub" : "offline";
    }

    /**
     * Probes every address of this device's /24 networks (or `cidrs`, at most 512 addresses) on the
     * given ports and returns how many devices it found that were not known before.
     */
    public int scanSubnet(List<String> cidrs, List<Integer> ports, int timeoutMs, int concurrency) throws InterruptedException {
        Discovery d = requireRunning();
        List<String> hosts = new ArrayList<>();
        for (String c : cidrs != null ? cidrs : ownSubnets()) hosts.addAll(expand(c, 512 - hosts.size()));
        List<Integer> ps = ports != null ? ports : new ArrayList<>(new LinkedHashSet<>(java.util.Arrays.asList(53318, port)));
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
        for (String id : trustedIds()) if (id.startsWith(q)) hits.add(id);
        if (hits.isEmpty()) throw new UnknownDevice(query, "unknown");
        if (hits.size() > 1) throw new UnknownDevice(query, "ambiguous");
        return hits.get(0);
    }

    /** Every device this one may send to: mesh members and manually paired devices, never itself. */
    private List<String> trustedIds() {
        Set<String> ids = new LinkedHashSet<>();
        MembershipStore m = mesh;
        if (m != null) for (io.github.hafijbge.meshdrop.engine.mesh.Membership.Member x : m.list().members) ids.add(x.deviceId);
        for (TrustStore.Device d : trust.list()) ids.add(d.deviceId);
        ids.remove(identity.deviceId());
        List<String> out = new ArrayList<>();
        for (String id : ids) if (trustSource.isTrusted(id)) out.add(id);
        return out;
    }

    /** How a target is reached now (engine.ts Route). */
    static final class Route {
        static final Route RELAY = new Route("relay", null, 0, 0, false);
        static final Route HELD = new Route("held", null, 0, 0, false);
        static final Route UNREACHABLE = new Route("unreachable", null, 0, 0, false);
        final String kind;
        /** "lan": where to connect (a Bluetooth link's local port when `bt`). */
        final String host;
        final int port;
        /** Over Bluetooth: the link's priority port, for live streams. */
        final int priorityPort;
        final boolean bt;

        Route(String kind, String host, int port, int priorityPort, boolean bt) {
            this.kind = kind;
            this.host = host;
            this.port = port;
            this.priorityPort = priorityPort;
            this.bt = bt;
        }

        static Route lan(Discovery.PeerInfo p) {
            return new Route("lan", p.host, p.port, 0, false);
        }

        /** A Bluetooth route is a LAN route to the link's local port, so every caller works unchanged. */
        static Route bt(io.github.hafijbge.meshdrop.engine.bt.BtLink l) {
            return new Route("lan", "127.0.0.1", l.normalPort(), l.priorityPort(), true);
        }
    }

    /**
     * LAN if discovery knows the device (or one of its directory addresses answers), else the hub
     * relay if it is online there, else held on the hub, else unreachable.
     */
    // ---- Bluetooth links (M14) ------------------------------------------------------------------

    private static final String CAMERA_NEEDS_WIFI = "Camera needs Wi-Fi or a hotspot - this device is connected over Bluetooth.";
    private volatile io.github.hafijbge.meshdrop.engine.bt.BtLinks btLinks;
    private volatile LinkPolicy btPolicy;

    private static boolean isCameraPath(String path) {
        return path.equals("camera") || path.startsWith("camera/") || path.startsWith("camera?");
    }

    private void startBt() {
        if (cfg.bt == null || btLinks != null) return;
        if (btPolicy == null) btPolicy = cfg.btPolicy;
        io.github.hafijbge.meshdrop.engine.bt.BtLinks.Options o = new io.github.hafijbge.meshdrop.engine.bt.BtLinks.Options();
        o.platform = cfg.bt;
        o.selfId = identity.deviceId();
        o.meshPort = () -> port;
        o.isTrusted = trustSource::isTrusted;
        o.trustedIds = this::trustedIds;
        o.onLan = id -> {
            Discovery d = discovery;
            return d != null && d.peer(id) != null;
        };
        o.file = new File(cfg.home, "bt-peers.json");
        o.tickMs = cfg.btTickMs;
        o.idleMs = cfg.btIdleMs;
        o.backoffMs = cfg.btBackoffMs;
        o.pingMs = cfg.btPingMs;
        o.listener = new io.github.hafijbge.meshdrop.engine.bt.BtLinks.Listener() {
            @Override
            public void onUp(String deviceId) {
                emit("bt", "up", deviceData(deviceId));
                maybeAutoResume(deviceId);
            }

            @Override
            public void onDown(String deviceId) {
                emit("bt", "down", deviceData(deviceId));
            }
        };
        io.github.hafijbge.meshdrop.engine.bt.BtLinks links = new io.github.hafijbge.meshdrop.engine.bt.BtLinks(o);
        links.setPolicy(btPolicy);
        try {
            links.start();
            btLinks = links;
        } catch (IOException | RuntimeException e) {
            links.stop(); // no adapter, or Bluetooth off: the LAN and hub paths still work
        }
    }

    private static Map<String, Object> deviceData(String deviceId) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("deviceId", deviceId);
        return m;
    }

    /** Bluetooth turned on or off, or the app may now use it: drops the links and starts them again. */
    public synchronized void restartBluetooth() {
        io.github.hafijbge.meshdrop.engine.bt.BtLinks bl = btLinks;
        btLinks = null;
        if (bl != null) bl.stop();
        if (server != null) startBt();
    }

    /** The link policy (No Wi-Fi settings): Bluetooth on/off, everything over Bluetooth, per-device mode. */
    public void setLinkPolicy(LinkPolicy p) {
        btPolicy = p;
        io.github.hafijbge.meshdrop.engine.bt.BtLinks bl = btLinks;
        if (bl != null) bl.setPolicy(p);
    }

    public LinkPolicy linkPolicy() {
        LinkPolicy p = btPolicy;
        return p != null ? p : cfg.btPolicy;
    }

    /** How a device may be reached: "wifi" whenever this engine has no Bluetooth. */
    public String linkMode(String deviceId) {
        io.github.hafijbge.meshdrop.engine.bt.BtLinks bl = btLinks;
        return bl == null ? LinkPolicy.WIFI : bl.mode(deviceId);
    }

    /** Whether the device is reached over Bluetooth right now (live sound picks Opus then). May dial. */
    public boolean viaBluetooth(String deviceId) {
        return route(resolveDeviceId(deviceId)).bt;
    }

    /** Devices with a Bluetooth link up now. */
    public List<String> btLinked() {
        io.github.hafijbge.meshdrop.engine.bt.BtLinks bl = btLinks;
        return bl == null ? java.util.Collections.<String>emptyList() : bl.linked();
    }

    // ---- live streams (M10b): LAN or Bluetooth, pinned TLS ------------------------------------

    /** A live stream to or from a device on the LAN: read `in` (GET) or write `out` (POST); close() ends it. */
    public static final class Stream implements java.io.Closeable {
        public final java.io.InputStream in;
        public final java.io.OutputStream out;
        private final javax.net.ssl.SSLSocket s;

        Stream(javax.net.ssl.SSLSocket s, java.io.InputStream in, java.io.OutputStream out) {
            this.s = s;
            this.in = in;
            this.out = out;
        }

        @Override
        public void close() {
            try {
                s.close();
            } catch (IOException ignored) {
                // closed
            }
        }
    }

    private javax.net.ssl.SSLSocket streamSocket(String deviceId, String path) throws IOException {
        Route r = route(deviceId);
        Sender.Target t = target(deviceId, r);
        if (t == null || t.host == null) throw new IOException("That device is not on this network or a Bluetooth link: live sound and camera need one.");
        if (r.bt && isCameraPath(path)) throw new IOException(CAMERA_NEEDS_WIFI);
        // Over Bluetooth, live streams take the priority port so a file transfer does not starve them.
        javax.net.ssl.SSLSocket s = Tls.connect(Tls.pinnedClient(identity, deviceId), t.host, r.bt && r.priorityPort > 0 ? r.priorityPort : t.port, 5_000);
        s.setSoTimeout(30_000);
        s.setTcpNoDelay(true); // live sound and frames go out as written
        return s;
    }

    /** GET /mesh/v1/stream/<path>: the body as it comes (HTTP/1.0, so it is never chunked). */
    public Stream streamFrom(String deviceId, String path) throws IOException {
        javax.net.ssl.SSLSocket s = streamSocket(deviceId, path);
        try {
            java.io.OutputStream o = s.getOutputStream();
            o.write(("GET /mesh/v1/stream/" + path + " HTTP/1.0\r\nHost: meshdrop\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
            o.flush();
            java.io.InputStream in = new java.io.BufferedInputStream(s.getInputStream());
            String status = headLine(in);
            int code = status.length() >= 12 ? Integer.parseInt(status.substring(9, 12)) : 0;
            while (!headLine(in).isEmpty()) {
                // skip the headers
            }
            if (code != 200) throw new IOException(code == 403 ? "That PC does not allow this device: tick it on the PC (More > Remote)." : "The PC refused (" + code + ").");
            return new Stream(s, in, null);
        } catch (IOException | RuntimeException e) {
            s.close();
            throw e instanceof IOException ? (IOException) e : new IOException(e);
        }
    }

    /** POST /mesh/v1/stream/<path>: what is written to `out` goes as chunks until close(). */
    public Stream streamTo(String deviceId, String path, String contentType) throws IOException {
        javax.net.ssl.SSLSocket s = streamSocket(deviceId, path);
        s.setSoTimeout(0);
        java.io.OutputStream raw = new java.io.BufferedOutputStream(s.getOutputStream(), 64 * 1024);
        raw.write(("POST /mesh/v1/stream/" + path + " HTTP/1.1\r\nHost: meshdrop\r\nContent-Type: " + contentType + "\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
        java.io.OutputStream chunked = new java.io.OutputStream() {
            @Override
            public void write(int b) throws IOException {
                write(new byte[] {(byte) b}, 0, 1);
            }

            @Override
            public void write(byte[] b, int off, int len) throws IOException {
                if (len == 0) return;
                raw.write((Integer.toHexString(len) + "\r\n").getBytes(StandardCharsets.US_ASCII));
                raw.write(b, off, len);
                raw.write(CRLF);
                raw.flush();
            }

            @Override
            public void close() throws IOException {
                try {
                    raw.write("0\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
                    raw.flush();
                } finally {
                    s.close();
                }
            }
        };
        return new Stream(s, s.getInputStream(), chunked);
    }

    private static final byte[] CRLF = {'\r', '\n'};

    private static String headLine(java.io.InputStream in) throws IOException {
        StringBuilder b = new StringBuilder();
        for (int c; (c = in.read()) != -1; ) {
            if (c == '\n') break;
            if (c != '\r') b.append((char) c);
            if (b.length() > 8192) throw new IOException("header too long");
        }
        return b.toString();
    }

    // ---- app messages (M10): remote control, ring, status, notifications ----------------------

    private volatile MeshServer.AppHandler appHandler;

    public void setAppHandler(MeshServer.AppHandler h) {
        appHandler = h;
    }

    /** {status, body} of an app message to a paired device: LAN when it is there, else through the hub. */
    public Map<String, Object> appSend(String deviceId, Map<String, Object> msg, int timeoutMs) throws IOException {
        Route r = route(deviceId);
        Sender.Target t = target(deviceId, r);
        if (t == null || r.kind.equals("held")) throw new IOException("That device is not reachable now.");
        Transport tr = t.host != null ? new LanTransport(identity, t, 5_000) : transportFor(t, false, 0);
        if (tr == null) throw new IOException("That device is not reachable now.");
        Http.Response res = tr.request("POST", "/mesh/v1/app", Json.stringify(msg).getBytes(StandardCharsets.UTF_8), "application/json", timeoutMs, null, null);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("status", (long) res.status);
        Object body = null;
        try {
            body = res.body.length == 0 ? null : Json.parse(res.text());
        } catch (RuntimeException ignored) {
            // not JSON
        }
        out.put("body", body);
        return out;
    }

    private Route route(String deviceId) {
        String mode = linkMode(deviceId);
        Discovery d = discovery;
        HubClient.DirectoryEntry dir = directoryEntry(deviceId);
        Discovery.PeerInfo p = d == null || mode.equals(LinkPolicy.BT) ? null : d.peer(deviceId);
        if (p == null && !mode.equals(LinkPolicy.BT) && dir != null && d != null && cfg.probeDirectoryAddrs) {
            for (HubClient.LanAddr a : dir.lanAddrs) {
                try {
                    d.probe(a.host, a.port, REPROBE_TIMEOUT_MS);
                } catch (IOException | RuntimeException ignored) {
                    // not there
                }
                p = d.peer(deviceId);
                if (p != null) break;
            }
        }
        if (p != null) return Route.lan(p);
        io.github.hafijbge.meshdrop.engine.bt.BtLinks bl = btLinks;
        if (!mode.equals(LinkPolicy.WIFI) && bl != null) {
            io.github.hafijbge.meshdrop.engine.bt.BtLink l = bl.link(deviceId);
            if (l == null) l = bl.ensure(deviceId, cfg.btDialTimeoutMs);
            if (l != null && l.normalPort() > 0) return Route.bt(l);
        }
        MembershipStore m = mesh;
        // Only mesh members are reachable through the hub.
        if (!mode.equals(LinkPolicy.BT) && m != null && m.isTrusted(deviceId) && hubOnline()) return dir != null && dir.online ? Route.RELAY : Route.HELD;
        return Route.UNREACHABLE;
    }

    private Sender.Target target(String deviceId, Route r) {
        TrustStore.Device t = trustSource.get(deviceId);
        if (t == null || r.kind.equals("unreachable")) return null;
        return r.host != null ? new Sender.Target(deviceId, r.host, r.port, t.key) : new Sender.Target(deviceId, null, 0, t.key);
    }

    /** A trusted device with no way to reach it now (its send waits in the outbox). */
    private Sender.Target awayTarget(String deviceId) {
        TrustStore.Device t = trustSource.get(deviceId);
        return t == null ? null : new Sender.Target(deviceId, null, 0, t.key);
    }

    /** The transport for a device that is away: every request fails "offline" (transient, so auto-resume retries). */
    private static final Transport AWAY = new Transport() {
        @Override
        public String kind() {
            return "lan";
        }

        @Override
        public io.github.hafijbge.meshdrop.engine.net.Http.Response request(String method, String path, byte[] body, String contentType, int timeoutMs,
                java.util.Set<java.net.Socket> track, java.util.function.BooleanSupplier aborted) throws IOException {
            throw new Transport.Away();
        }
    };

    /** A LAN target, or (mesh members while the hub link is up) one without an address that goes through the hub. */
    private Sender.Target target(String deviceId) {
        String mode = linkMode(deviceId);
        Discovery d = discovery;
        Discovery.PeerInfo p = d == null || mode.equals(LinkPolicy.BT) ? null : d.peer(deviceId);
        if (p != null) return target(deviceId, Route.lan(p));
        io.github.hafijbge.meshdrop.engine.bt.BtLinks bl = btLinks;
        io.github.hafijbge.meshdrop.engine.bt.BtLink l = bl == null || mode.equals(LinkPolicy.WIFI) ? null : bl.link(deviceId);
        if (l != null) return target(deviceId, Route.bt(l));
        MembershipStore m = mesh;
        if (!mode.equals(LinkPolicy.BT) && m != null && m.isTrusted(deviceId) && hubOnline()) return target(deviceId, Route.RELAY);
        return null;
    }

    private java.security.PublicKey pubOf(String id) {
        TrustStore.Device t = trustSource.get(id);
        MembershipStore m = mesh;
        if (t == null && m != null && id.equals(m.list().hubId)) t = m.get(id);
        return t == null ? null : t.key;
    }

    /** LAN targets go direct; address-less ones go through the hub, held when `held` says so. */
    // ---- internet links made on this device (M9b) ----------------------------------------------

    private Transport hubTransport() throws IOException {
        HubClient h = hub;
        String to = h == null ? null : h.linkedHub();
        if (to == null) throw new IOException("Not connected to a hub: internet links need the hub PC or a relay hub.");
        return new RelayTransport(identity, h, to, this::pubOf, "relay", 0);
    }

    private File memberLinksFile() {
        return new File(cfg.home, "member-links.json");
    }

    @SuppressWarnings("unchecked")
    private synchronized Map<String, Object> memberLinkUrls() {
        try {
            Object j = Json.parse(new String(Files.readAllBytes(memberLinksFile().toPath()), StandardCharsets.UTF_8));
            if (j instanceof Map) return (Map<String, Object>) j;
        } catch (IOException | RuntimeException ignored) {
            // none yet
        }
        return new LinkedHashMap<>();
    }

    private synchronized void saveMemberLinkUrls(Map<String, Object> m) throws IOException {
        io.github.hafijbge.meshdrop.engine.util.Atomic.write(memberLinksFile(), Json.stringify(m).getBytes(StandardCharsets.UTF_8));
    }

    /** Seals the files here and uploads only ciphertext to the hub (or relay hub) this device is linked to. */
    public io.github.hafijbge.meshdrop.engine.links.MemberLinks.Made linkCreate(List<io.github.hafijbge.meshdrop.engine.send.Source> files, String text, long expiresInMs, String password, int maxDownloads) throws IOException {
        if (mesh == null) throw new IOException("Internet links need a mesh with a hub.");
        io.github.hafijbge.meshdrop.engine.links.MemberLinks.Made m = io.github.hafijbge.meshdrop.engine.links.MemberLinks.create(hubTransport(), files, text, expiresInMs, password, maxDownloads);
        Map<String, Object> urls = memberLinkUrls();
        urls.put(m.id, m.url);
        saveMemberLinkUrls(urls);
        return m;
    }

    /** This device's links on its hub, each with its full URL (key included) when it was made here. */
    public List<Map<String, Object>> linkList() throws IOException {
        List<Map<String, Object>> out = io.github.hafijbge.meshdrop.engine.links.MemberLinks.list(hubTransport());
        Map<String, Object> urls = memberLinkUrls();
        for (Map<String, Object> l : out) if (urls.get(l.get("id")) instanceof String) l.put("url", urls.get(l.get("id")));
        return out;
    }

    public void linkRevoke(String id) throws IOException {
        io.github.hafijbge.meshdrop.engine.links.MemberLinks.revoke(hubTransport(), id);
        Map<String, Object> urls = memberLinkUrls();
        urls.remove(id);
        saveMemberLinkUrls(urls);
    }

    private Transport transportFor(Sender.Target t, boolean held, long holdBytes) {
        if (t.host != null) return null;
        HubClient h = hub;
        if (h == null) return null; // no address, no hub: fails 'no-route'
        return new RelayTransport(identity, h, t.deviceId, this::pubOf, held ? "held" : "relay", held ? holdBytes : 0);
    }

    static final long HELD_FRAME_OVERHEAD = 32 * 1024;

    /** What a held upload of `p` will store on the hub (engine.ts estimateHoldBytes). */
    static long holdBytes(Prepared p) {
        long bytes = 0;
        long frames = 4;
        for (io.github.hafijbge.meshdrop.engine.proto.Manifest.FileEntry f : p.files) {
            long n = io.github.hafijbge.meshdrop.engine.proto.Chunks.count(f.size);
            bytes += f.size + 16 * n;
            frames += n + 1;
        }
        if (p.text != null) bytes += p.text.getBytes(StandardCharsets.UTF_8).length;
        return bytes + frames * HELD_FRAME_OVERHEAD + io.github.hafijbge.meshdrop.engine.proto.Chunks.CHUNK_SIZE;
    }

    private Sender.Options sendOptions(String tag, Sender.Control control) {
        Sender.Options o = new Sender.Options();
        o.transport = t -> transportFor(t, false, 0);
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
        return send(ids, items, tag, false);
    }

    /** `backup`: a photo backup (the receiver files it in its backup folder). */
    public CompletableFuture<List<SendResult>> send(List<String> ids, List<SendItem> items, String tag, boolean backup) {
        return send(ids, items, tag, backup, false);
    }

    /** Copied files or an image: the receiver puts them on its clipboard. */
    public CompletableFuture<List<SendResult>> sendClipboardFiles(List<String> ids, List<SendItem> items, String tag) {
        return send(ids, items, tag, false, true);
    }

    /** M11: with burn after reading and/or print on the receiver. */
    public CompletableFuture<List<SendResult>> sendWith(List<String> ids, List<SendItem> items, String tag, boolean burn, boolean print) {
        return send(ids, items, tag, false, false, burn, print);
    }

    private CompletableFuture<List<SendResult>> send(List<String> ids, List<SendItem> items, String tag, boolean backup, boolean clipboardFiles) {
        return send(ids, items, tag, backup, clipboardFiles, false, false);
    }

    private CompletableFuture<List<SendResult>> send(List<String> ids, List<SendItem> items, String tag, boolean backup, boolean clipboardFiles, boolean burn, boolean print) {
        Discovery d = requireRunning();
        List<String> targets = new ArrayList<>();
        if (ids == null) {
            Set<String> present = new java.util.HashSet<>();
            for (Discovery.PeerInfo p : d.peers()) if (!linkMode(p.deviceId).equals(LinkPolicy.BT)) present.add(p.deviceId);
            if (hubOnline()) for (HubClient.DirectoryEntry x : directory()) if (x.online && !linkMode(x.deviceId).equals(LinkPolicy.BT)) present.add(x.deviceId);
            present.addAll(btLinked());
            for (String id : trustedIds()) if (present.contains(id)) targets.add(id);
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
        sendStarted();
        e.execute(() -> {
            try {
                List<SendResult> out = new ArrayList<>();
                if (!targets.isEmpty()) {
                    Prepared p;
                    try {
                        p = Prepared.of(items, control.pausedFlag());
                        p.backup = backup;
                        p.clipboardFiles = clipboardFiles;
                        p.burn = burn;
                        p.print = print;
                    } catch (IOException | RuntimeException x) {
                        for (String id : targets) out.add(new SendResult(id, control.paused() ? "cancelled" : "failed", "", control.paused() ? null : String.valueOf(x.getMessage())));
                        for (SendResult r : out) emitResult(r, tag);
                        f.complete(out);
                        return;
                    }
                    Map<String, Route> routes = new LinkedHashMap<>();
                    for (String id : targets) routes.put(id, route(id));
                    long hb = routes.containsValue(Route.HELD) ? holdBytes(p) : 0;
                    // A device that is away still gets its session: it fails "offline" at once and stays in the
                    // outbox, so auto-resume sends it when the device is seen again (LAN or hub directory).
                    List<Sender.Target> present = new ArrayList<>();
                    for (String id : targets) {
                        Sender.Target t = routes.get(id) == Route.UNREACHABLE ? awayTarget(id) : target(id, routes.get(id));
                        if (t != null) present.add(t);
                    }
                    Sender.Options so = sendOptions(tag, control);
                    so.transport = t -> routes.get(t.deviceId) == Route.UNREACHABLE ? AWAY : transportFor(t, routes.get(t.deviceId) == Route.HELD, hb);
                    List<SendResult> sent = new ArrayList<>(MultiSend.send(identity, present, p, so));
                    // A LAN attempt that failed for a transient reason resumes the same session over the hub once.
                    // A relay that found the target gone (our directory was stale) leaves it on the hub instead.
                    for (int i = 0; i < sent.size(); i++) {
                        SendResult r = sent.get(i);
                        MembershipStore m = mesh;
                        if (!r.status.equals("failed") || !hubOnline() || m == null || !m.isTrusted(r.deviceId) || control.paused()) continue;
                        if (linkMode(r.deviceId).equals(LinkPolicy.BT)) continue; // Bluetooth only: never the hub
                        String was = routes.get(r.deviceId).kind;
                        boolean lanHiccup = was.equals("lan") && Sender.isTransientError(r.error);
                        boolean relayGone = was.equals("relay") && "http-503 offline".equals(r.error);
                        if (!lanHiccup && !relayGone) continue;
                        HubClient.DirectoryEntry x = directoryEntry(r.deviceId);
                        boolean held = !(x != null && x.online && !relayGone);
                        long hb2 = held ? holdBytes(p) : 0;
                        Sender.Target t = target(r.deviceId, held ? Route.HELD : Route.RELAY);
                        if (t == null) continue;
                        Sender.Options so2 = sendOptions(tag, control);
                        so2.transport = tt -> transportFor(tt, held, hb2);
                        sent.set(i, Sender.sendTo(identity, t, p, so2));
                    }
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
                sendEnded();
            }
        });
        return f;
    }

    public CompletableFuture<List<SendResult>> sendClipboard(List<String> ids, String text, String tag) {
        return send(ids, java.util.Arrays.asList(SendItem.clipboard(text)), tag);
    }

    /** Resumes every unfinished send whose device is trusted and present. */
    public CompletableFuture<List<SendResult>> resumePending() {
        requireRunning();
        Sender.Control control = new Sender.Control();
        controls.add(control);
        CompletableFuture<List<SendResult>> f = new CompletableFuture<>();
        sendStarted();
        try {
            exec.execute(() -> {
                try {
                    List<SendResult> rs = outbox.resumeAll(identity, this::target, sendOptions(null, control));
                    for (SendResult r : rs) emitResult(r, null);
                    f.complete(rs);
                } catch (Throwable x) {
                    f.completeExceptionally(x);
                } finally {
                    controls.remove(control);
                    sendEnded();
                }
            });
        } catch (java.util.concurrent.RejectedExecutionException x) {
            sendEnded();
            throw new IllegalStateException("engine not started");
        }
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
        try {
            e.execute(() -> autoResumeLoop(deviceId));
        } catch (java.util.concurrent.RejectedExecutionException x) {
            autoResuming.remove(deviceId); // stopping
        }
    }

    private void autoResumeLoop(String deviceId) {
        {
            try {
                boolean resumed;
                do {
                    autoResuming.put(deviceId, false);
                    resumed = autoResume(deviceId);
                } while (!resumed && Boolean.TRUE.equals(autoResuming.get(deviceId)) && server != null);
            } catch (RuntimeException ignored) {
                // never take the process down from a background resume
            } finally {
                autoResuming.remove(deviceId);
            }
        }
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
        sendStarted();
        try {
            for (Outbox.Entry en : entries) {
                SendResult r = outbox.resumeEntry(identity, en.sessionId, t, sendOptions(null, control));
                emitResult(r, null);
            }
        } finally {
            controls.remove(control);
            sendEnded();
        }
        return true;
    }
}
