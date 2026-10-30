package io.github.hafijbge.meshdrop.engine.bt;

import io.github.hafijbge.meshdrop.engine.util.Atomic;
import io.github.hafijbge.meshdrop.engine.util.Json;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.function.IntSupplier;
import java.util.function.Predicate;
import java.util.function.Supplier;
import java.util.regex.Pattern;

/**
 * Keeps Bluetooth links to trusted devices per the link policy (M14, packages/core/src/bt/links.ts):
 * listens, dials what should be up with backoff, learns which paired address is which device from
 * HELLO (bt-peers.json), drops duplicate links and closes idle links once the device is back on the LAN.
 */
public final class BtLinks {
    public interface Listener {
        void onUp(String deviceId);

        void onDown(String deviceId);
    }

    public static final class Options {
        public BtPlatform platform;
        public String selfId;
        public IntSupplier meshPort;
        public Predicate<String> isTrusted;
        /** Trusted devices the manager may keep links to. */
        public Supplier<List<String>> trustedIds;
        /** Whether discovery sees the device on the LAN now. */
        public Predicate<String> onLan;
        /** bt-peers.json (address -> deviceId), or null to keep the map in memory only. */
        public File file;
        /** Dial backoff per device: doubling from [0] to [1]. */
        public long[] backoffMs = {10_000, 120_000};
        /** An idle link to a device back on the LAN closes after this long. */
        public long idleMs = 60_000;
        /** Background policy pass interval; 0: only on tick(). */
        public long tickMs = 10_000;
        public long pingMs = 15_000;
        public Listener listener;
    }

    private static final Pattern DEVICE_ID = Pattern.compile("[0-9a-f]{64}");
    private static final long HELLO_TIMEOUT_MS = 15_000;

    private static final class DialState {
        int failures;
        long lastFail;
        CompletableFuture<BtLink> inflight;
    }

    private final Options o;
    private final Object lock = new Object();
    private volatile LinkPolicy policy = LinkPolicy.DEFAULT;
    private final Map<String, BtLink> links = new HashMap<>(); // guarded by lock
    /** address -> deviceId, learned from HELLO. */
    private final Map<String, String> addrs = new LinkedHashMap<>(); // guarded by lock
    private final Map<String, DialState> dials = new HashMap<>(); // guarded by lock
    /** Paired addresses not mapped yet: when we last tried to learn who they are. */
    private final Map<String, Long> probed = new HashMap<>(); // guarded by lock
    /** When the device was first seen back on the LAN while it had a Bluetooth link. */
    private final Map<String, Long> lanSince = new HashMap<>(); // guarded by lock
    /** Dials in flight per address: a second dial joins the first, so one radio link never carries two btmux links. */
    private final Map<String, CompletableFuture<BtLink>> dialing = new HashMap<>(); // guarded by lock
    private final ExecutorService exec = Executors.newCachedThreadPool(r -> {
        Thread t = new Thread(r, "meshdrop-bt");
        t.setDaemon(true);
        return t;
    });
    private ScheduledExecutorService timer;
    private volatile boolean stopped;

    public BtLinks(Options o) {
        this.o = o;
        if (o.file != null) {
            try {
                Object j = Json.parse(new String(Files.readAllBytes(o.file.toPath()), StandardCharsets.UTF_8));
                if (j instanceof Map) {
                    for (Map.Entry<?, ?> e : ((Map<?, ?>) j).entrySet()) {
                        if (e.getValue() instanceof String && DEVICE_ID.matcher((String) e.getValue()).matches()) addrs.put(String.valueOf(e.getKey()), (String) e.getValue());
                    }
                }
            } catch (IOException | RuntimeException ignored) {
                // none yet
            }
        }
    }

    /** Starts listening and the background pass; throws when the adapter is off or missing. */
    public void start() throws IOException {
        o.platform.listen((conn, address) -> {
            try {
                exec.execute(() -> adopt(conn, address, false));
            } catch (java.util.concurrent.RejectedExecutionException e) {
                quiet(conn);
            }
        });
        if (o.tickMs > 0) {
            timer = Executors.newSingleThreadScheduledExecutor(r -> {
                Thread t = new Thread(r, "meshdrop-bt-tick");
                t.setDaemon(true);
                return t;
            });
            timer.scheduleWithFixedDelay(this::tick, 0, o.tickMs, TimeUnit.MILLISECONDS);
        } else {
            exec.execute(this::tick);
        }
    }

    public void stop() {
        stopped = true;
        if (timer != null) timer.shutdownNow();
        o.platform.stop();
        List<BtLink> all;
        synchronized (lock) {
            all = new ArrayList<>(links.values());
            links.clear();
        }
        for (BtLink l : all) l.close();
        exec.shutdown();
    }

    public void setPolicy(LinkPolicy p) {
        policy = p;
        List<BtLink> drop = new ArrayList<>();
        synchronized (lock) {
            for (Map.Entry<String, BtLink> e : links.entrySet()) if (LinkPolicy.WIFI.equals(p.mode(e.getKey()))) drop.add(e.getValue());
        }
        for (BtLink l : drop) l.close();
        if (!stopped) {
            try {
                exec.execute(this::tick);
            } catch (java.util.concurrent.RejectedExecutionException ignored) {
                // stopping
            }
        }
    }

    public LinkPolicy policy() {
        return policy;
    }

    public String mode(String deviceId) {
        return policy.mode(deviceId);
    }

    /** The ready link to a device, or null. */
    public BtLink link(String deviceId) {
        synchronized (lock) {
            BtLink l = links.get(deviceId);
            return l != null && !l.closed() && l.normalPort() > 0 ? l : null;
        }
    }

    /** Devices with a ready link now. */
    public List<String> linked() {
        List<String> out = new ArrayList<>();
        synchronized (lock) {
            for (String id : links.keySet()) if (link(id) != null) out.add(id);
        }
        return out;
    }

    /** Bluetooth address last used for a device, or null. */
    public String addressOf(String deviceId) {
        synchronized (lock) {
            for (Map.Entry<String, String> e : addrs.entrySet()) if (e.getValue().equals(deviceId)) return e.getKey();
        }
        return null;
    }

    /**
     * A ready link to the device, dialling it now if needed (within `timeoutMs`). Null when the device is
     * in Wi-Fi mode, has no known address, or does not answer.
     */
    public BtLink ensure(String deviceId, long timeoutMs) {
        if (stopped || LinkPolicy.WIFI.equals(mode(deviceId)) || !o.isTrusted.test(deviceId)) return null;
        BtLink have = link(deviceId);
        if (have != null) return have;
        synchronized (lock) {
            DialState st = dials.get(deviceId);
            // A user action may dial again sooner than the background backoff, but not in a tight loop.
            if (st != null && st.inflight == null && st.failures > 0 && System.currentTimeMillis() - st.lastFail < backoff(1)) return null;
        }
        try {
            return dial(deviceId).get(timeoutMs, TimeUnit.MILLISECONDS);
        } catch (java.util.concurrent.TimeoutException | java.util.concurrent.ExecutionException e) {
            return null;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return null;
        }
    }

    /** One policy pass: dial what should be up, close idle links to devices back on the LAN. */
    public void tick() {
        if (stopped || !policy.bluetooth) return;
        try {
            long now = System.currentTimeMillis();
            List<BtLink> idle = new ArrayList<>();
            synchronized (lock) {
                for (Map.Entry<String, BtLink> e : links.entrySet()) {
                    String id = e.getKey();
                    BtLink l = e.getValue();
                    if (!LinkPolicy.AUTO.equals(mode(id)) || !o.onLan.test(id)) {
                        lanSince.remove(id);
                        continue;
                    }
                    Long since = lanSince.get(id);
                    if (since == null) lanSince.put(id, since = now);
                    if (l.streams() == 0 && now - since >= o.idleMs && now - l.lastActive() >= o.idleMs) idle.add(l);
                }
            }
            for (BtLink l : idle) l.close();
            List<String> want = new ArrayList<>();
            for (String id : o.trustedIds.get()) {
                String m = mode(id);
                if (link(id) == null && (LinkPolicy.BT.equals(m) || (LinkPolicy.AUTO.equals(m) && !o.onLan.test(id)))) want.add(id);
            }
            if (want.isEmpty()) return;
            List<CompletableFuture<BtLink>> jobs = new ArrayList<>();
            boolean unmapped = false;
            for (String id : want) {
                synchronized (lock) {
                    DialState st = dials.get(id);
                    if (st != null && (st.inflight != null || (st.failures > 0 && now - st.lastFail < backoff(st.failures)))) continue;
                }
                if (addressOf(id) != null) jobs.add(dial(id));
                else unmapped = true;
            }
            // Paired devices we have not linked yet: dial each once in a while to learn which device it is.
            if (unmapped) learn(now);
            for (CompletableFuture<BtLink> j : jobs) {
                try {
                    j.get();
                } catch (java.util.concurrent.ExecutionException ignored) {
                    // counted in its dial state
                }
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } catch (RuntimeException ignored) {
            // the next pass tries again
        }
    }

    private long backoff(int failures) {
        return Math.min(o.backoffMs[1], o.backoffMs[0] * (1L << Math.min(20, Math.max(0, failures - 1))));
    }

    private void learn(long now) {
        List<BtPlatform.Bonded> bonded;
        try {
            bonded = o.platform.bonded();
        } catch (IOException | RuntimeException e) {
            return;
        }
        for (BtPlatform.Bonded b : bonded) {
            synchronized (lock) {
                Long last = probed.get(b.address);
                if (addrs.containsKey(b.address) || (last != null && now - last < o.backoffMs[1])) continue;
                probed.put(b.address, now);
            }
            dialAddress(b.address);
        }
    }

    /**
     * Dials an address and runs btmux on it; joins a dial of the same address already in flight. Two
     * concurrent links from one dialler would each be "the newer one" on one side, so the sides could keep
     * different links and lose streams opened on the other.
     */
    private BtLink dialAddress(String address) {
        CompletableFuture<BtLink> f = new CompletableFuture<>();
        CompletableFuture<BtLink> cur;
        synchronized (lock) {
            cur = dialing.get(address);
            if (cur == null) dialing.put(address, f);
        }
        if (cur != null) {
            try {
                return cur.get();
            } catch (java.util.concurrent.ExecutionException e) {
                return null;
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return null;
            }
        }
        BtLink l = null;
        try {
            l = adopt(o.platform.dial(address), address, true);
        } catch (IOException | RuntimeException ignored) {
            // away, or not a MeshDrop device
        } finally {
            synchronized (lock) {
                dialing.remove(address);
            }
            f.complete(l);
        }
        return l;
    }

    private CompletableFuture<BtLink> dial(String deviceId) {
        DialState st;
        CompletableFuture<BtLink> f = new CompletableFuture<>();
        synchronized (lock) {
            st = dials.get(deviceId);
            if (st == null) dials.put(deviceId, st = new DialState());
            if (st.inflight != null) return st.inflight;
            st.inflight = f;
        }
        DialState s = st;
        Runnable run = () -> {
            BtLink l = null;
            try {
                l = dialNow(deviceId);
            } catch (RuntimeException ignored) {
                // counted below
            }
            synchronized (lock) {
                s.inflight = null;
                if (l != null) s.failures = 0;
                else {
                    s.failures++;
                    s.lastFail = System.currentTimeMillis();
                }
            }
            f.complete(l);
        };
        try {
            exec.execute(run);
        } catch (java.util.concurrent.RejectedExecutionException e) {
            synchronized (lock) {
                s.inflight = null;
            }
            f.complete(null);
        }
        return f;
    }

    private BtLink dialNow(String deviceId) {
        String known = addressOf(deviceId);
        List<String> candidates = new ArrayList<>();
        if (known != null) candidates.add(known);
        else {
            try {
                for (BtPlatform.Bonded b : o.platform.bonded()) {
                    synchronized (lock) {
                        if (!addrs.containsKey(b.address)) candidates.add(b.address);
                    }
                }
            } catch (IOException | RuntimeException ignored) {
                // adapter off
            }
        }
        for (String a : candidates) {
            BtLink l = dialAddress(a);
            if (l != null && deviceId.equals(l.peerId())) return l;
            l = link(deviceId);
            if (l != null) return l;
        }
        return link(deviceId);
    }

    /** Runs a btmux link on a fresh connection; returns it once HELLO named a trusted device (or null). */
    private BtLink adopt(BtPlatform.Conn conn, String address, boolean dialer) {
        if (stopped) {
            quiet(conn);
            return null;
        }
        String[] peerOf = new String[1];
        BtLink l;
        try {
            l = new BtLink(conn.in(), conn.out(), conn, dialer, o.selfId, o.meshPort, o.pingMs, new BtLink.Listener() {
                @Override
                public void onReady(BtLink link, String peerId) {}

                @Override
                public void onClosed(BtLink link, Exception why) {
                    String peer = peerOf[0];
                    if (peer == null) return;
                    synchronized (lock) {
                        if (links.get(peer) != link) return;
                        links.remove(peer);
                        lanSince.remove(peer);
                    }
                    if (o.listener != null) o.listener.onDown(peer);
                }
            });
        } catch (IOException e) {
            quiet(conn);
            return null;
        }
        l.start();
        try {
            if (!l.awaitReady(HELLO_TIMEOUT_MS)) {
                l.close();
                return null;
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            l.close();
            return null;
        }
        String peer = l.peerId();
        // The HELLO id is a claim: the TLS inside the tunnel proves it. It only maps the address.
        if (peer == null || peer.equals(o.selfId) || !o.isTrusted.test(peer) || LinkPolicy.WIFI.equals(mode(peer))) {
            l.close();
            return null;
        }
        BtLink drop = null;
        boolean save = false;
        synchronized (lock) {
            if (stopped) {
                drop = l;
            } else {
                if (!peer.equals(addrs.get(address))) {
                    addrs.values().removeIf(peer::equals);
                    addrs.put(address, peer);
                    save = true;
                }
                BtLink cur = link(peer);
                if (cur != null && cur != l) {
                    // Both sides dialled at once: keep the link dialled by the device with the lower id, so both
                    // sides drop the same one. The same dialler twice: the older link is stale.
                    String dNew = l.dialer ? o.selfId : peer;
                    String dCur = cur.dialer ? o.selfId : peer;
                    boolean keepNew = dNew.equals(dCur) || dNew.compareTo(dCur) < 0;
                    if (!keepNew) drop = l;
                    else {
                        links.remove(peer);
                        drop = cur;
                    }
                }
                if (drop != l) {
                    links.put(peer, l);
                    peerOf[0] = peer;
                }
            }
        }
        if (save) save();
        if (drop != null) drop.close();
        if (drop == l) return stopped ? null : link(peer);
        if (l.closed()) {
            // closed between HELLO and registration: its onClosed saw no peer yet
            synchronized (lock) {
                if (links.get(peer) == l) links.remove(peer);
            }
            return null;
        }
        if (o.listener != null) o.listener.onUp(peer);
        return l;
    }

    private void save() {
        if (o.file == null) return;
        Map<String, Object> m;
        synchronized (lock) {
            m = new LinkedHashMap<>(addrs);
        }
        try {
            Atomic.write(o.file, Json.stringify(m).getBytes(StandardCharsets.UTF_8));
        } catch (IOException | RuntimeException ignored) {
            // the map is relearnt on the next link
        }
    }

    private static void quiet(java.io.Closeable c) {
        try {
            c.close();
        } catch (IOException | RuntimeException ignored) {
            // closed
        }
    }
}
