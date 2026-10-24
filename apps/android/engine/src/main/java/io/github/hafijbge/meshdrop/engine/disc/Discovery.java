package io.github.hafijbge.meshdrop.engine.disc;

import io.github.hafijbge.meshdrop.engine.identity.Identity;
import io.github.hafijbge.meshdrop.engine.net.Http;
import io.github.hafijbge.meshdrop.engine.net.Tls;
import io.github.hafijbge.meshdrop.engine.util.Json;
import java.io.IOException;
import java.net.DatagramPacket;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.MulticastSocket;
import java.net.NetworkInterface;
import java.net.SocketException;
import java.net.StandardSocketOptions;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.function.Predicate;
import javax.net.ssl.SSLSocket;

/**
 * LAN discovery (docs/protocol.md "Announce packet"), ported from packages/core/src/discovery.ts:
 * UDP multicast announces every interval from every non-loopback IPv4 interface, a peer table keyed by
 * device id (at most 256; trusted newcomers evict the oldest untrusted entry when full), TTL expiry,
 * and probe() for manual peers (TLS 1.3, no client certificate, device id from the certificate).
 */
public final class Discovery {
    public static final String DEFAULT_GROUP = "224.0.0.168";
    public static final int DEFAULT_PORT = 53318;
    public static final int MAX_PEERS = 256;
    private static final int MAX_INFO_BYTES = 4096;

    public static final class Options {
        public final String deviceId;
        public final String alias;
        public final String deviceType;
        public final int meshPort;
        public String group = DEFAULT_GROUP;
        public int port = DEFAULT_PORT;
        public long intervalMs = 5000;
        public long ttlMs = 15_000;
        public boolean announce = true;
        public Predicate<String> isTrusted = id -> false;

        public Options(String deviceId, String alias, String deviceType, int meshPort) {
            if (!Announce.isDeviceId(deviceId) || !Announce.isAlias(alias) || !Announce.isDeviceType(deviceType) || meshPort < 1 || meshPort > 65535) {
                throw new IllegalArgumentException("invalid self announce");
            }
            this.deviceId = deviceId;
            this.alias = alias;
            this.deviceType = deviceType;
            this.meshPort = meshPort;
        }
    }

    public static final class PeerInfo {
        public final String deviceId;
        public final String alias;
        public final String deviceType;
        public final int port;
        public final String host;
        public final long lastSeen;
        public final boolean manual;

        PeerInfo(String deviceId, String alias, String deviceType, int port, String host, long lastSeen, boolean manual) {
            this.deviceId = deviceId;
            this.alias = alias;
            this.deviceType = deviceType;
            this.port = port;
            this.host = host;
            this.lastSeen = lastSeen;
            this.manual = manual;
        }

        public Map<String, Object> toMap() {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("deviceId", deviceId);
            m.put("alias", alias);
            m.put("deviceType", deviceType);
            m.put("port", (long) port);
            m.put("host", host);
            m.put("lastSeen", lastSeen);
            if (manual) m.put("manual", true);
            return m;
        }
    }

    public interface Listener {
        void onPeer(PeerInfo p);

        void onLost(PeerInfo p);
    }

    private final Options opts;
    private final Map<String, PeerInfo> table = new LinkedHashMap<>();
    private final List<Listener> listeners = new CopyOnWriteArrayList<>();
    private volatile Running running;

    private static final class Running {
        MulticastSocket recv;
        final List<MulticastSocket> senders = new ArrayList<>();
        ScheduledExecutorService timers;
        Thread reader;
    }

    public Discovery(Options opts) {
        this.opts = opts;
    }

    public void addListener(Listener l) {
        listeners.add(l);
    }

    /** Every up, non-loopback, multicast-capable IPv4 interface with its address. */
    public static List<Map.Entry<NetworkInterface, Inet4Address>> interfaceAddrs() {
        List<Map.Entry<NetworkInterface, Inet4Address>> out = new ArrayList<>();
        try {
            Enumeration<NetworkInterface> nis = NetworkInterface.getNetworkInterfaces();
            if (nis == null) return out;
            for (NetworkInterface ni : Collections.list(nis)) {
                try {
                    if (!ni.isUp() || ni.isLoopback() || !ni.supportsMulticast()) continue;
                } catch (SocketException e) {
                    continue;
                }
                for (InetAddress a : Collections.list(ni.getInetAddresses())) {
                    if (a instanceof Inet4Address) out.add(new java.util.AbstractMap.SimpleImmutableEntry<>(ni, (Inet4Address) a));
                }
            }
        } catch (SocketException e) {
            // no interfaces
        }
        return out;
    }

    public synchronized void start() {
        if (running != null) return;
        Running r = new Running();
        List<Map.Entry<NetworkInterface, Inet4Address>> addrs = interfaceAddrs();
        try {
            MulticastSocket recv = new MulticastSocket(null);
            recv.setReuseAddress(true);
            recv.bind(new InetSocketAddress(opts.port));
            InetSocketAddress group = new InetSocketAddress(InetAddress.getByName(opts.group), 0);
            for (Map.Entry<NetworkInterface, Inet4Address> a : addrs) {
                try {
                    recv.joinGroup(group, a.getKey());
                } catch (IOException e) {
                    // other interfaces still work
                }
            }
            r.recv = recv;
        } catch (IOException e) {
            r.recv = null; // no listening (port taken without reuse, no network): probes still work
        }
        if (opts.announce) {
            for (Map.Entry<NetworkInterface, Inet4Address> a : addrs) {
                try {
                    MulticastSocket s = new MulticastSocket(new InetSocketAddress(a.getValue(), 0));
                    s.setNetworkInterface(a.getKey());
                    s.setTimeToLive(1);
                    s.setOption(StandardSocketOptions.IP_MULTICAST_LOOP, true);
                    r.senders.add(s);
                } catch (IOException e) {
                    // skip this interface
                }
            }
        }
        r.timers = Executors.newSingleThreadScheduledExecutor(t -> {
            Thread th = new Thread(t, "meshdrop-discovery");
            th.setDaemon(true);
            return th;
        });
        running = r;
        if (opts.announce) r.timers.scheduleAtFixedRate(() -> announce(r), 0, opts.intervalMs, TimeUnit.MILLISECONDS);
        long sweep = Math.min(1000, Math.max(25, opts.ttlMs / 4));
        r.timers.scheduleAtFixedRate(this::sweep, sweep, sweep, TimeUnit.MILLISECONDS);
        if (r.recv != null) {
            MulticastSocket recv = r.recv;
            r.reader = new Thread(() -> readLoop(recv), "meshdrop-discovery-rx");
            r.reader.setDaemon(true);
            r.reader.start();
        }
    }

    private void announce(Running r) {
        byte[] b = Announce.encode(opts.deviceId, opts.alias, opts.deviceType, opts.meshPort);
        for (MulticastSocket s : r.senders) {
            try {
                s.send(new DatagramPacket(b, b.length, InetAddress.getByName(opts.group), opts.port));
            } catch (IOException e) {
                // interface went away: the next round retries
            }
        }
    }

    private void readLoop(MulticastSocket s) {
        byte[] buf = new byte[2048];
        while (running != null && !s.isClosed()) {
            DatagramPacket p = new DatagramPacket(buf, buf.length);
            try {
                s.receive(p);
            } catch (IOException e) {
                return;
            }
            Announce.Peer a = Announce.parse(p.getData(), p.getLength(), p.getAddress().getHostAddress());
            if (a != null) observe(a, false);
        }
    }

    /** Stops announcing and listening and forgets all peers (silently). Idempotent. */
    public synchronized void stop() {
        Running r = running;
        running = null;
        if (r != null) {
            r.timers.shutdownNow();
            if (r.recv != null) r.recv.close();
            for (MulticastSocket s : r.senders) s.close();
        }
        synchronized (table) {
            table.clear();
        }
    }

    public List<PeerInfo> peers() {
        synchronized (table) {
            return new ArrayList<>(table.values());
        }
    }

    public PeerInfo peer(String deviceId) {
        synchronized (table) {
            return table.get(deviceId);
        }
    }

    private boolean observe(Announce.Peer a, boolean manual) {
        if (a.deviceId.equals(opts.deviceId)) return true;
        long now = System.currentTimeMillis();
        PeerInfo emitPeer = null;
        PeerInfo emitLost = null;
        synchronized (table) {
            PeerInfo cur = table.get(a.deviceId);
            if (cur == null && table.size() >= MAX_PEERS) {
                if (!opts.isTrusted.test(a.deviceId)) return false;
                PeerInfo victim = null;
                for (PeerInfo p : table.values()) {
                    if (p.manual || opts.isTrusted.test(p.deviceId)) continue;
                    if (victim == null || p.lastSeen < victim.lastSeen) victim = p;
                }
                if (victim == null) return false;
                table.remove(victim.deviceId);
                emitLost = victim;
            }
            boolean keepAddr = cur != null && cur.manual && !manual;
            PeerInfo next = new PeerInfo(a.deviceId, a.alias, a.deviceType, keepAddr ? cur.port : a.port, keepAddr ? cur.host : a.host, now,
                    manual || (cur != null && cur.manual));
            table.put(a.deviceId, next);
            boolean changed = cur == null || !cur.host.equals(next.host) || cur.port != next.port || !cur.alias.equals(next.alias)
                    || !cur.deviceType.equals(next.deviceType) || now - cur.lastSeen > opts.ttlMs;
            if (changed) emitPeer = next;
        }
        if (emitLost != null) {
            PeerInfo v = emitLost;
            for (Listener l : listeners) safe(() -> l.onLost(v));
        }
        if (emitPeer != null) {
            PeerInfo p = emitPeer;
            for (Listener l : listeners) safe(() -> l.onPeer(p));
        }
        return true;
    }

    private static void safe(Runnable r) {
        try {
            r.run();
        } catch (RuntimeException ignored) {
            // a throwing listener must not break discovery
        }
    }

    public void forget(String deviceId) {
        PeerInfo p;
        synchronized (table) {
            p = table.remove(deviceId);
        }
        if (p != null) for (Listener l : listeners) safe(() -> l.onLost(p));
    }

    private void sweep() {
        long cutoff = System.currentTimeMillis() - opts.ttlMs;
        List<PeerInfo> lost = new ArrayList<>();
        synchronized (table) {
            table.values().removeIf(p -> {
                if (!p.manual && p.lastSeen < cutoff) {
                    lost.add(p);
                    return true;
                }
                return false;
            });
        }
        for (PeerInfo p : lost) for (Listener l : listeners) safe(() -> l.onLost(p));
    }

    /**
     * Probes host:port with GET info (TLS 1.3, no client certificate, no pin). The device id is the
     * hash of the presented certificate; info must agree. The peer is added as a manual peer.
     */
    @SuppressWarnings("unchecked")
    public PeerInfo probe(String host, int port, int timeoutMs) throws IOException {
        if (port < 1 || port > 65535) throw new IOException("probe: invalid port " + port);
        SSLSocket s = Tls.connect(Tls.probeClient(), host, port, timeoutMs);
        String deviceId = Identity.deviceIdOf(Tls.peerCertDer(s));
        Http.Response r = Http.request(s, "GET", "/mesh/v1/info", java.util.Collections.singletonMap("Accept", "application/json"), null, MAX_INFO_BYTES);
        if (r.status != 200) throw new IOException("probe: HTTP " + r.status + " from " + host + ":" + port);
        Object j;
        try {
            j = Json.parse(r.text());
        } catch (Json.JsonException e) {
            throw new IOException("probe: info is not valid JSON");
        }
        if (!(j instanceof Map)) throw new IOException("probe: info is not an object");
        Map<String, Object> o = (Map<String, Object>) j;
        if (!Long.valueOf(1).equals(o.get("v"))) throw new IOException("probe: unsupported info version");
        if (!deviceId.equals(o.get("deviceId"))) throw new IOException("probe: info deviceId does not match the peer certificate");
        if (!Announce.isAlias(o.get("alias"))) throw new IOException("probe: invalid alias");
        if (!Announce.isDeviceType(o.get("deviceType"))) throw new IOException("probe: invalid deviceType");
        if (!observe(new Announce.Peer(deviceId, (String) o.get("alias"), (String) o.get("deviceType"), port, host), true)) {
            throw new IOException("probe: peer table is full");
        }
        PeerInfo p = peer(deviceId);
        return p != null ? p : new PeerInfo(deviceId, (String) o.get("alias"), (String) o.get("deviceType"), port, host, System.currentTimeMillis(), true);
    }
}
