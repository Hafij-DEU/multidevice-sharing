package io.github.hafijbge.meshdrop.engine.app;

import io.github.hafijbge.meshdrop.engine.Engine;
import io.github.hafijbge.meshdrop.engine.EngineDevice;
import io.github.hafijbge.meshdrop.engine.EngineEvent;
import io.github.hafijbge.meshdrop.engine.EngineListener;
import io.github.hafijbge.meshdrop.engine.hub.HubClient;
import io.github.hafijbge.meshdrop.engine.mesh.Membership;
import io.github.hafijbge.meshdrop.engine.mesh.MembershipStore;
import io.github.hafijbge.meshdrop.engine.proto.Chunks;
import io.github.hafijbge.meshdrop.engine.proto.Manifest;
import io.github.hafijbge.meshdrop.engine.send.SendItem;
import io.github.hafijbge.meshdrop.engine.send.SendResult;
import io.github.hafijbge.meshdrop.engine.send.Source;
import io.github.hafijbge.meshdrop.engine.util.Json;
import java.io.File;
import java.io.IOException;
import java.net.BindException;
import java.net.ServerSocket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.Collections;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

/**
 * The phone app's brain, the Java port of apps/desktop/src/main/controller.ts: owns the engine, turns
 * its events into the AppState JSON the shared renderer expects, and carries out the DesktopApi
 * calls. Transfer rows are keyed by send tag / session; state pushes are throttled to one per 100 ms.
 */
public final class AppController {
    private static final long STATE_INTERVAL_MS = 100;
    private static final int MAX_TRANSFERS = 100;
    private static final String NO_MESH = "Creating or managing a mesh is not available on Android: do it on the PC. This phone can join a mesh with an invite.";

    public interface EngineFactory {
        Engine create(Settings s) throws IOException;
    }

    public interface StateListener {
        void onState(String json);
    }

    private static final class Row {
        String key;
        String direction;
        String deviceId;
        String alias;
        long files;
        long bytes;
        long sent;
        String status;
        String error;
        long startedAt;
        String tagKey;
        String sessionId;
        /** M11 read receipt: when the receiver opened it (0: not yet). */
        long openedAt;
        long rateAt;
        long rateSent;
        double bytesPerSec = -1;
        final Map<Long, Long> done = new HashMap<>();
        final Map<Long, Long> sizes = new HashMap<>();

        Map<String, Object> toMap() {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("key", key);
            m.put("direction", direction);
            m.put("deviceId", deviceId);
            m.put("alias", alias);
            m.put("files", files);
            m.put("bytes", bytes);
            m.put("sent", sent);
            m.put("status", status);
            if (error != null) m.put("error", error);
            if (bytesPerSec >= 0) m.put("bytesPerSec", (long) bytesPerSec);
            m.put("startedAt", startedAt);
            if (openedAt > 0) m.put("openedAt", openedAt);
            return m;
        }

        void sum() {
            long n = 0;
            for (long v : done.values()) n += v;
            sent = bytes > 0 ? Math.min(n, bytes) : n;
            // Speed: bytes over windows of at least 500 ms, smoothed so the time left does not jump.
            long now = System.currentTimeMillis();
            if (rateAt == 0) {
                rateAt = now;
                rateSent = sent;
            } else if (now - rateAt >= 500) {
                double r = (sent - rateSent) * 1000.0 / (now - rateAt);
                bytesPerSec = bytesPerSec < 0 ? r : 0.7 * bytesPerSec + 0.3 * r;
                rateAt = now;
                rateSent = sent;
            }
        }
    }

    private final SettingsStore settings;
    private final HistoryStore history;
    private final Platform platform;
    private final EngineFactory factory;
    private final List<StateListener> stateListeners = new CopyOnWriteArrayList<>();
    private final LinkedHashMap<String, Row> rows = new LinkedHashMap<>();
    private final Map<String, String> byTag = new HashMap<>();
    private final Map<String, String> bySession = new HashMap<>();
    private final ScheduledExecutorService timer = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "meshdrop-state");
        t.setDaemon(true);
        return t;
    });
    private final EngineListener engineListener = this::onEvent;
    private volatile Engine engine;
    private volatile String error;
    private volatile boolean paused;
    private volatile List<Map<String, Object>> outbox = new ArrayList<>();
    /** The guest link's QR code (the engine keeps the rest of the session). */
    private volatile String guestQr;
    /** M14: the hotspot this phone hosts or joined ("role", "ssid", host: "psk", "qrSvg"), or null. */
    private volatile Map<String, Object> hotspot;
    /** M14: a hotspot a Bluetooth-linked device shared ("from", "alias", "ssid", "psk", "hosts", "joining", "error"), or null. */
    private volatile Map<String, Object> hotspotOffer;
    /** M10: this device rings (Find my device) until stopped or for at most a minute. */
    private volatile boolean ringing;
    private final Map<String, Object> deviceStatus = new java.util.concurrent.ConcurrentHashMap<>();
    /** This device's internet links on its hub (M9b), refreshed in the background. */
    private volatile List<Object> memberLinks = new ArrayList<>();
    private volatile long memberLinksAt;
    private final java.util.concurrent.atomic.AtomicBoolean linksRefreshing = new java.util.concurrent.atomic.AtomicBoolean();
    private ScheduledFuture<?> pending;
    /** Photo backup: one batch at a time; what this run handed over (for the status line). */
    private final java.util.concurrent.atomic.AtomicBoolean backupBusy = new java.util.concurrent.atomic.AtomicBoolean();
    private volatile long backupCount;
    private volatile long backupLastAt;
    private volatile String backupError;
    private ScheduledFuture<?> backupTimer;
    /** Shared clipboard: the poll, and the last text seen (copied here or received), so nothing echoes back. */
    private ScheduledFuture<?> clipTick;
    private volatile String lastClip;
    /** Android: the screen is off (idle) / MeshDrop's window is in front (foreground). */
    private volatile boolean idle;
    private volatile long lastIdleBackup;
    private static final long IDLE_BACKUP_MS = 15 * 60_000;
    private long lastEmit;
    private String lastJson;
    private volatile boolean stopped;

    public AppController(SettingsStore settings, HistoryStore history, Platform platform, EngineFactory factory) {
        this.settings = settings;
        this.history = history;
        this.platform = platform;
        this.factory = factory;
    }

    public void addStateListener(StateListener l) {
        stateListeners.add(l);
        synchronized (this) {
            lastJson = null; // the newcomer gets the next push even if nothing else changed
        }
    }

    public void removeStateListener(StateListener l) {
        stateListeners.remove(l);
    }

    // ---- lifecycle ------------------------------------------------------------------------------

    public synchronized void start() throws IOException {
        stopped = false;
        boot();
        if (backupTimer == null) backupTimer = timer.scheduleWithFixedDelay(() -> {
            // Screen off: photo backup looks every 15 min instead of every minute.
            if (idle && System.currentTimeMillis() - lastIdleBackup < IDLE_BACKUP_MS) return;
            lastIdleBackup = System.currentTimeMillis();
            backupSoon();
        }, 5, 60, TimeUnit.SECONDS);
        if (m11Timer == null) m11Timer = timer.scheduleWithFixedDelay(() -> {
            try {
                m11Tick();
            } catch (RuntimeException ignored) {
                // next tick
            }
        }, 2, 15, TimeUnit.SECONDS);
    }

    private java.util.concurrent.ScheduledFuture<?> m11Timer;

    public synchronized void stop() {
        stopped = true;
        halt();
        timer.shutdownNow();
    }

    /**
     * Starts the engine. If its port cannot be bound it still starts (on any free port, refusing
     * offers) and says why in state.error, so Settings stays usable.
     */
    private void boot() throws IOException {
        error = null;
        Settings s = settings.get();
        Engine e = factory.create(s);
        try {
            e.start();
        } catch (BindException x) {
            e.stop();
            error = "Port " + s.port + " is in use by another app, so this phone is not receiving. Choose another port in Settings.";
            Settings any = s.copy();
            any.port = 0;
            e = factory.create(any);
            e.start();
        }
        e.setReceiving(!paused && error == null);
        e.setIdle(idle);
        e.addListener(engineListener);
        e.setAppHandler(this::onApp);
        engine = e;
        refreshOutbox();
        changed();
    }

    private void halt() {
        Engine e = engine;
        engine = null;
        if (e != null) {
            e.removeListener(engineListener);
            e.stop();
        }
    }

    private synchronized void restart() throws IOException {
        halt();
        boot();
    }

    private Engine e() {
        Engine x = engine;
        if (x == null) throw new IllegalStateException("MeshDrop is not running");
        return x;
    }

    /** Re-announce and re-probe after a Wi-Fi change. */
    public void networkChanged() {
        Engine x = engine;
        if (x != null) x.restartNetworking();
    }

    /** The current settings (read-only copy). */
    public Settings settingsSnapshot() {
        return settings.get();
    }

    /** Bluetooth turned on or off, or the app was allowed to use it. */
    public void bluetoothChanged() {
        Engine x = engine;
        if (x != null) x.restartBluetooth();
    }

    // ---- state ----------------------------------------------------------------------------------

    public Map<String, Object> state() {
        Engine x = e();
        Settings s = settings.get();
        Map<String, Object> m = new LinkedHashMap<>();
        Map<String, Object> self = new LinkedHashMap<>();
        self.put("deviceId", x.identity().deviceId());
        self.put("alias", s.alias);
        self.put("port", (long) x.port());
        List<Object> addrs = new ArrayList<>();
        for (Map.Entry<java.net.NetworkInterface, java.net.Inet4Address> a : io.github.hafijbge.meshdrop.engine.disc.Discovery.interfaceAddrs()) {
            String ip = a.getValue().getHostAddress();
            if (a.getKey().getName().startsWith("wlan")) addrs.add(0, ip);
            else addrs.add(ip);
        }
        self.put("addrs", addrs);
        m.put("self", self);
        m.put("mode", "serving");
        Map<String, Object> hub = new LinkedHashMap<>();
        List<Object> members = new ArrayList<>();
        MembershipStore mesh = x.mesh();
        if (mesh != null) {
            Membership.ListView l = mesh.list();
            boolean isHub = l.hubId.equals(x.identity().deviceId());
            hub.put("role", isHub ? "hub" : "member");
            hub.put("online", x.hubState() == HubClient.State.ONLINE);
            hub.put("version", l.version);
            hub.put("members", (long) l.members.size());
            hub.put("urls", new ArrayList<Object>(l.urls));
            hub.put("linkedTo", x.linkedTo());
            hub.put("relayHub", false);
            List<Object> relays = new ArrayList<>();
            io.github.hafijbge.meshdrop.engine.mesh.Relays.ListView rl = x.relayList();
            if (rl != null) {
                for (io.github.hafijbge.meshdrop.engine.mesh.Relays.Relay r : rl.relays) {
                    Map<String, Object> ro = new LinkedHashMap<>();
                    Membership.Member rm = l.member(r.deviceId);
                    ro.put("deviceId", r.deviceId);
                    ro.put("alias", rm == null ? r.deviceId.substring(0, 8) : rm.alias);
                    ro.put("urls", new ArrayList<Object>(r.urls));
                    relays.add(ro);
                }
            }
            m.put("relays", relays);
            for (Membership.Member mm : l.members) {
                Map<String, Object> o = new LinkedHashMap<>();
                o.put("deviceId", mm.deviceId);
                o.put("alias", mm.alias);
                o.put("role", mm.role);
                o.put("self", mm.deviceId.equals(x.identity().deviceId()));
                members.add(o);
            }
        } else {
            hub.put("role", x.joinPending() ? "provisional" : "none");
            hub.put("online", false);
            hub.put("version", 0L);
            hub.put("members", 0L);
            hub.put("urls", new ArrayList<Object>());
        }
        hub.put("ingressPort", 0L);
        m.put("hub", hub);
        List<Object> devices = new ArrayList<>();
        for (EngineDevice d : x.devices()) {
            Map<String, Object> dm = new LinkedHashMap<>();
            dm.put("deviceId", d.deviceId);
            dm.put("alias", d.alias);
            dm.put("role", d.role);
            dm.put("trusted", d.trusted);
            dm.put("reach", d.reach);
            if (d.deviceType != null) dm.put("deviceType", d.deviceType);
            if (d.host != null && d.port > 0) {
                dm.put("host", d.host);
                dm.put("port", (long) d.port);
            }
            dm.put("self", false);
            devices.add(dm);
        }
        m.put("devices", devices);
        List<Object> transfers = new ArrayList<>();
        synchronized (rows) {
            List<Row> rs = new ArrayList<>(rows.values());
            for (int i = rs.size() - 1; i >= 0; i--) transfers.add(rs.get(i).toMap());
        }
        m.put("transfers", transfers);
        m.put("outbox", new ArrayList<Object>(outbox));
        m.put("received", new ArrayList<Object>(history.received()));
        m.put("settings", s.toMap());
        m.put("receiving", x.receiving() && error == null);
        if (error != null) m.put("error", error);
        m.put("members", members);
        Map<String, Object> guest = x.guestState();
        if (guestQr != null && Boolean.TRUE.equals(guest.get("active"))) guest.put("qrSvg", guestQr);
        m.put("guest", guest);
        m.put("ringing", ringing);
        m.put("watch", watchView());
        loadScheduled();
        m.put("scheduled", scheduledView());
        Map<String, Object> casting = new LinkedHashMap<>();
        for (Map.Entry<String, String> c : castTo.entrySet()) casting.put(c.getKey().equals("audio") ? "audioFrom" : c.getKey().equals("camera") ? "cameraTo" : c.getKey().equals("sound") ? "soundTo" : "micTo", c.getValue());
        if (castTo.containsKey("camera") && cameraBack) casting.put("cameraBack", true);
        m.put("casting", casting);
        Map<String, Object> noWifi = new LinkedHashMap<>();
        Map<String, Object> hs = hotspot;
        Map<String, Object> offer = hotspotOffer;
        if (hs != null) noWifi.put("hotspot", new LinkedHashMap<>(hs));
        if (offer != null) {
            Map<String, Object> o = new LinkedHashMap<>(offer);
            o.put("hosts", new ArrayList<Object>((List<?>) offer.get("hosts")));
            noWifi.put("offer", o);
        }
        noWifi.put("guarded", new ArrayList<Object>()); // the tether guard is the PC's
        m.put("noWifi", noWifi);
        m.put("notifyAccess", platform.notificationAccess());
        m.put("deviceStatus", new LinkedHashMap<>(deviceStatus));
        if (mesh != null) {
            m.put("links", new ArrayList<Object>(memberLinks));
            if (x.hubState() == HubClient.State.ONLINE && System.currentTimeMillis() - memberLinksAt > 30_000) refreshLinks();
        }
        Map<String, Object> sync = x.syncStatus();
        sync.put("suggested", ""); // Android: the folder is always picked (system folder picker)
        m.put("sync", sync);
        if (platform.supportsBackup()) m.put("backup", backupView());
        platform.decorate(m);
        return m;
    }

    public String stateJson() {
        return Json.stringify(state());
    }

    /** Pushes a fresh state to the UI (after something outside the controller changed it). */
    public void refresh() {
        changed();
    }

    /** Schedules a state push: at most one per STATE_INTERVAL_MS, always carrying the latest state,
     *  and none when nothing changed (each one re-renders the whole page). */
    private synchronized void changed() {
        if (stopped || (pending != null && !pending.isDone())) return;
        long wait = Math.max(0, lastEmit + STATE_INTERVAL_MS - System.currentTimeMillis());
        pending = timer.schedule(() -> {
            String json;
            synchronized (this) {
                lastEmit = System.currentTimeMillis();
                if (engine == null) return;
            }
            try {
                json = stateJson();
            } catch (RuntimeException ex) {
                return;
            }
            synchronized (this) {
                if (json.equals(lastJson)) return;
                lastJson = json;
            }
            for (StateListener l : stateListeners) {
                try {
                    l.onState(json);
                } catch (RuntimeException ignored) {
                    // a failing UI must not break the controller
                }
            }
        }, wait, TimeUnit.MILLISECONDS);
    }

    private void refreshOutbox() {
        Engine x = engine;
        if (x == null) return;
        List<Map<String, Object>> out = new ArrayList<>();
        for (Engine.OutboxItem o : x.listOutbox()) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("sessionId", o.sessionId);
            m.put("deviceId", o.deviceId);
            if (o.alias != null) m.put("alias", o.alias);
            m.put("files", (long) o.files);
            m.put("bytes", o.bytes);
            m.put("waiting", o.waiting);
            if (o.lastError != null && !o.waiting) m.put("error", o.lastError);
            out.add(m);
        }
        outbox = out;
        // A failed send the engine kept for auto-resume because the device was away (not one the device
        // answered, e.g. "http-503 paused") is waiting, not failed. One the owner cancelled stops waiting.
        java.util.Set<String> all = new java.util.HashSet<>();
        java.util.Set<String> waiting = new java.util.HashSet<>();
        for (Map<String, Object> m : out) {
            all.add((String) m.get("sessionId"));
            if (Boolean.TRUE.equals(m.get("waiting"))) waiting.add((String) m.get("sessionId"));
        }
        synchronized (rows) {
            for (Row r : rows.values()) {
                if (!"out".equals(r.direction) || r.sessionId == null) continue;
                if ("failed".equals(r.status) && waiting.contains(r.sessionId) && (r.error == null || !r.error.startsWith("http-"))) {
                    r.status = "waiting";
                    r.error = r.alias + " is not reachable now. It gets this when it is back online (or cancel it under Unfinished sends).";
                } else if ("waiting".equals(r.status) && !all.contains(r.sessionId)) {
                    r.status = "failed";
                    r.error = "Send cancelled.";
                }
            }
        }
        changed();
    }

    private String aliasOf(String id) {
        Engine x = engine;
        if (x != null) for (EngineDevice d : x.devices()) if (d.deviceId.equals(id)) return d.alias;
        return id.substring(0, Math.min(8, id.length()));
    }

    private Row addRow(Row r) {
        synchronized (rows) {
            rows.remove(r.key);
            rows.put(r.key, r);
            while (rows.size() > MAX_TRANSFERS) {
                Row old = rows.remove(rows.keySet().iterator().next());
                if (old.tagKey != null) byTag.remove(old.tagKey);
                if (old.sessionId != null) bySession.remove(old.sessionId);
            }
        }
        return r;
    }

    // ---- engine events --------------------------------------------------------------------------

    private void onEvent(EngineEvent ev) {
        try {
            if (ev.source.equals("sender")) onSender(ev);
            else if (ev.source.equals("receiver")) onReceiver(ev);
            else if (ev.source.equals("mesh")) onMesh(ev);
            else if (ev.source.equals("guest")) onGuest(ev);
            else if (ev.source.equals("sync") && ev.type.equals("round") && ev.data.get("conflicts") instanceof Long && (Long) ev.data.get("conflicts") > 0
                    && settings.get().notifications) {
                platform.notify("Sync conflict", "A file in \"" + ev.data.get("folder") + "\" changed on both " + aliasOf((String) ev.data.get("partner"))
                        + " and this phone. Both versions are kept: look for \"(conflict from …)\".", null);
            }
        } catch (RuntimeException ignored) {
            // never let a bookkeeping error break the engine thread
        }
        changed();
    }

    @SuppressWarnings("unchecked")
    private void onGuest(EngineEvent ev) {
        Settings s = settings.get();
        if (ev.type.equals("ended")) guestQr = null;
        if (ev.type.equals("offer") && s.notifications) {
            List<Object> files = (List<Object>) ev.data.get("files");
            int n = files == null ? 0 : files.size();
            String what = n > 0 ? n + " file" + (n == 1 ? "" : "s") + (ev.data.get("text") != null ? " and a message" : "") : "a message";
            platform.notify("A guest wants to send", what + ": open MeshDrop to accept or decline.", null);
        }
        if (ev.type.equals("failed") && s.notifications) platform.notify("A guest send could not be saved", "The files were uploaded but could not be saved (" + ev.data.get("error") + ").", null);
        if (ev.type.equals("received")) {
            List<String> files = new ArrayList<>();
            for (Object f : (List<Object>) ev.data.get("files")) files.add((String) f);
            try {
                history.addReceived(System.currentTimeMillis(), "guest", "Guest", files, (String) ev.data.get("text"), false);
            } catch (IOException ignored) {
                // the files are in the inbox either way
            }
            if (s.notifications) platform.notify("From a guest", files.size() + " file" + (files.size() == 1 ? "" : "s") + " received", files.isEmpty() ? null : files.get(0));
        }
    }

    private void onMesh(EngineEvent ev) {
        if (ev.type.equals("held-delivered") || ev.type.equals("held-failed")) refreshOutbox();
        if (!settings.get().notifications) return;
        Object to = ev.data.get("to");
        String who = to instanceof String ? aliasOf((String) to) : "a device";
        if (ev.type.equals("held-delivered")) platform.notify("Delivered", "The hub delivered your files to " + who + ".", null);
        else if (ev.type.equals("held-failed")) platform.notify("Delivery failed", "The hub could not deliver your files to " + who + (ev.data.get("error") != null ? " (" + ev.data.get("error") + ")" : "") + ".", null);
        else if (ev.type.equals("revoked")) platform.notify("Removed from the mesh", "The hub removed this device from the mesh.", null);
    }

    /** The outgoing row of an event: by the send()'s tag, else by session (a resume gets a row on its first progress). */
    private Row outRow(Map<String, Object> d, boolean create) {
        String dev = (String) d.get("deviceId");
        String sid = (String) d.get("sessionId");
        String tag = (String) d.get("tag");
        synchronized (rows) {
            String key = tag != null ? byTag.get(dev + "\0" + tag) : null;
            if (key == null && sid != null && !sid.isEmpty()) key = bySession.get(sid);
            Row r = key != null ? rows.get(key) : null;
            if (r == null && create && sid != null && !sid.isEmpty()) {
                r = new Row();
                r.key = dev + ":" + sid;
                r.direction = "out";
                r.deviceId = dev;
                r.alias = aliasOf(dev);
                for (Map<String, Object> o : outbox) {
                    if (sid.equals(o.get("sessionId"))) {
                        r.files = (Long) o.get("files");
                        r.bytes = (Long) o.get("bytes");
                    }
                }
                r.status = "sending";
                r.startedAt = System.currentTimeMillis();
                addRow(r);
            }
            if (r != null && sid != null && !sid.isEmpty() && !sid.equals(r.sessionId)) {
                r.sessionId = sid;
                bySession.put(sid, r.key);
            }
            return r;
        }
    }

    private void onSender(EngineEvent ev) {
        Map<String, Object> d = ev.data;
        if (ev.type.equals("progress")) {
            Row r = outRow(d, true);
            if (r == null) return;
            synchronized (rows) {
                r.status = "sending";
                r.done.put(((Number) d.get("fileId")).longValue(), ((Number) d.get("sent")).longValue());
                r.sum();
            }
            return;
        }
        Row r = outRow(d, false);
        if (r != null) {
            synchronized (rows) {
                r.status = (String) d.get("status");
                if ("done".equals(r.status)) r.sent = r.bytes;
                r.error = d.get("error") != null ? (String) d.get("error") : null;
            }
        }
        refreshOutbox();
    }

    @SuppressWarnings("unchecked")
    private void onReceiver(EngineEvent ev) {
        Map<String, Object> d = ev.data;
        String from = (String) d.get("from");
        String key = from + ":" + d.get("sessionId");
        if (ev.type.equals("offer")) {
            Manifest m = (Manifest) d.get("manifest");
            Row r = new Row();
            r.key = key;
            r.direction = "in";
            r.deviceId = from;
            r.alias = aliasOf(from);
            r.files = m.files.size();
            for (Manifest.FileEntry f : m.files) {
                r.sizes.put(f.fileId, f.size);
                r.bytes += f.size;
            }
            if (m.text != null) r.bytes += m.text.getBytes(StandardCharsets.UTF_8).length;
            r.status = "receiving";
            r.startedAt = System.currentTimeMillis();
            addRow(r);
            return;
        }
        Row r;
        synchronized (rows) {
            r = rows.get(key);
        }
        if (ev.type.equals("received")) {
            if (r != null) {
                synchronized (rows) {
                    r.status = "done";
                    r.sent = r.bytes;
                }
            }
            received(from, (List<Object>) d.get("files"), (String) d.get("text"), Boolean.TRUE.equals(d.get("clipboard")), Boolean.TRUE.equals(d.get("clipboardFiles")),
                    (String) d.get("sessionId"), Boolean.TRUE.equals(d.get("burn")));
            return;
        }
        if (r == null) return;
        synchronized (rows) {
            switch (ev.type) {
                case "progress": {
                    long fileId = ((Number) d.get("fileId")).longValue();
                    long size = r.sizes.getOrDefault(fileId, 0L);
                    long chunks = ((Number) d.get("chunks")).longValue();
                    r.done.put(fileId, Math.min(size, chunks * Chunks.CHUNK_SIZE));
                    r.sum();
                    break;
                }
                case "file":
                    r.done.put(((Number) d.get("fileId")).longValue(), r.sizes.getOrDefault(((Number) d.get("fileId")).longValue(), 0L));
                    r.sum();
                    break;
                case "error":
                    r.status = "failed";
                    r.error = (String) d.get("code");
                    break;
                case "cancelled":
                    r.status = "cancelled";
                    break;
                default:
                    break;
            }
        }
    }

    private void received(String from, List<Object> files, String text, boolean clipboard, boolean clipboardFiles, String sessionId, boolean burn) {
        Settings s = settings.get();
        String alias = aliasOf(from);
        List<String> fs = new ArrayList<>();
        for (Object f : files) fs.add((String) f);
        try {
            history.addReceived(System.currentTimeMillis(), from, alias, fs, text, clipboard || clipboardFiles, sessionId, burn);
        } catch (IOException ignored) {
            // the files arrived; only the history entry is lost
        }
        // Clipboard text is only ever placed on the clipboard: never opened, run or interpreted.
        if (clipboard && text != null && s.clipboardReceive) {
            lastClip = text; // shared clipboard: do not send it straight back
            platform.writeClipboard(text);
        }
        // Copied files / an image: saved in the inbox like any file, and put on the clipboard (never opened).
        if (clipboardFiles && !fs.isEmpty() && s.clipboardReceive) {
            platform.writeClipboardFiles(fs);
            lastClip = "u:" + String.join("\n", platform.clipboardUris());
        }
        if (!s.notifications) return;
        if (clipboard) {
            platform.notify("Clipboard", s.clipboardReceive ? "Copied text from " + alias : "Text from " + alias + " (see Inbox)", null);
            return;
        }
        if (clipboardFiles) {
            String what = fs.size() == 1 ? "a file" : fs.size() + " files";
            platform.notify("Clipboard", s.clipboardReceive ? "Copied " + what + " from " + alias + ": paste it anywhere" : what + " from " + alias + " (see Received)", null);
            return;
        }
        int n = fs.size();
        String body = n > 0 ? n + " file" + (n == 1 ? "" : "s") + " received" + (text != null ? " with a message" : "")
                : "Text: " + (text == null ? "" : text.length() > 120 ? text.substring(0, 120) : text);
        platform.notify("From " + alias, body, n > 0 ? fs.get(0) : null);
    }

    // ---- actions --------------------------------------------------------------------------------

    private List<String> targets(Object targets) {
        Engine x = e();
        List<String> ids = new ArrayList<>();
        if ("all".equals(targets)) {
            for (EngineDevice d : x.devices()) if (d.trusted && !d.reach.equals("offline")) ids.add(d.deviceId);
        } else {
            for (Object q : (List<?>) targets) {
                String id = x.resolveDeviceId((String) q);
                if (!ids.contains(id)) ids.add(id);
            }
        }
        if (ids.isEmpty()) throw new IllegalArgumentException("No trusted device is online. Pick a device: an offline one gets the send when it is back.");
        return ids;
    }

    private List<Row> startRows(List<String> ids, String tag, long files, long bytes) {
        List<Row> out = new ArrayList<>();
        long now = System.currentTimeMillis();
        synchronized (rows) {
            for (String id : ids) {
                Row r = new Row();
                r.key = id + ":" + tag;
                r.direction = "out";
                r.deviceId = id;
                r.alias = aliasOf(id);
                r.files = files;
                r.bytes = bytes;
                r.status = "preparing";
                r.startedAt = now;
                r.tagKey = id + "\0" + tag;
                byTag.put(r.tagKey, r.key);
                out.add(addRow(r));
            }
        }
        changed();
        return out;
    }

    private void failRows(List<Row> rs, Throwable x) {
        Throwable c = x instanceof java.util.concurrent.CompletionException && x.getCause() != null ? x.getCause() : x;
        synchronized (rows) {
            for (Row r : rs) {
                if (!r.status.equals("preparing") && !r.status.equals("sending")) continue;
                r.status = "failed";
                r.error = String.valueOf(c.getMessage());
            }
        }
        changed();
    }

    /** `targets`: "all" or a list of device ids; `items`: [{kind: file|dir|text, path?, text?}]. Returns once started. */
    public void send(Object targets, List<Map<String, Object>> items) throws IOException {
        send(targets, items, new LinkedHashMap<>());
    }

    /** M11 options: burn, print, and at (send later: kept here and sent at its time while the app runs). */
    public void send(Object targets, List<Map<String, Object>> items, Map<String, Object> opts) throws IOException {
        List<String> ids = targets(targets);
        boolean burn = Boolean.TRUE.equals(opts.get("burn"));
        boolean print = Boolean.TRUE.equals(opts.get("print"));
        if (opts.get("at") instanceof Number && ((Number) opts.get("at")).longValue() > System.currentTimeMillis() + 30_000) {
            long at = ((Number) opts.get("at")).longValue();
            if (at > System.currentTimeMillis() + 366 * 86_400_000L) throw new IllegalArgumentException("Pick a time within a year.");
            Map<String, Object> j = new LinkedHashMap<>();
            j.put("id", UUID.randomUUID().toString());
            j.put("at", at);
            j.put("targets", new ArrayList<Object>(ids));
            List<Object> aliases = new ArrayList<>();
            for (String i : ids) aliases.add(aliasOf(i));
            j.put("aliases", aliases);
            List<Object> names = new ArrayList<>();
            List<Object> its = new ArrayList<>();
            for (Map<String, Object> it : items) {
                its.add(new LinkedHashMap<>(it));
                Object path = it.get("path");
                names.add("text".equals(it.get("kind")) ? "Text" : platform.displayName(String.valueOf(path)));
            }
            j.put("names", names);
            j.put("items", its);
            if (burn) j.put("burn", true);
            if (print) j.put("print", true);
            loadScheduled();
            synchronized (scheduled) {
                scheduled.add(j);
                scheduled.sort((x, y) -> Long.compare((Long) x.get("at"), (Long) y.get("at")));
                saveScheduled();
            }
            changed();
            return;
        }
        List<SendItem> sendItems = new ArrayList<>();
        long files = 0, bytes = 0;
        for (Map<String, Object> it : items) {
            String kind = (String) it.get("kind");
            if ("text".equals(kind)) {
                String text = (String) it.get("text");
                if (text == null) throw new IllegalArgumentException("Invalid item to send.");
                sendItems.add(SendItem.text(text));
                bytes += text.getBytes(StandardCharsets.UTF_8).length;
            } else if ("file".equals(kind) || "dir".equals(kind)) {
                String path = (String) it.get("path");
                if (path == null || path.isEmpty()) throw new IllegalArgumentException("Invalid item to send.");
                SendItem si = platform.item(kind, path);
                sendItems.add(si);
                if (si.kind == SendItem.Kind.FILE) {
                    files++;
                    bytes += si.source.size();
                } else {
                    for (Source.Entry en : si.tree.files()) {
                        files++;
                        bytes += en.source.size();
                    }
                }
            } else {
                throw new IllegalArgumentException("Invalid item to send.");
            }
        }
        String tag = UUID.randomUUID().toString();
        List<Row> rs = startRows(ids, tag, files, bytes);
        e().sendWith(ids, sendItems, tag, burn, print).whenComplete((r, x) -> {
            if (x != null) failRows(rs, x);
        });
    }

    /** Redeems a QR invite with this phone's alias: "member" or "provisional". */
    public String join(String uri) throws IOException {
        try {
            String r = e().join(uri.trim(), settings.get().alias);
            changed();
            return r;
        } finally {
            platform.joinHandled();
        }
    }

    /**
     * The UI is in front (true) or not. Android lets an app read the clipboard only while it is in
     * front, so the once-a-second clipboard check runs only then (no wake-ups in the background).
     */
    public synchronized void setForeground(boolean on) {
        if (on && clipTick == null) {
            lastClip = null; // what is on the clipboard now is not "newly copied"
            clipTick = timer.scheduleWithFixedDelay(this::clipTick, 1, 1, TimeUnit.SECONDS);
        } else if (!on && clipTick != null) {
            clipTick.cancel(false);
            clipTick = null;
        }
    }

    /** The screen went off (true) or on: background work slows down while it is off (see Engine.setIdle). */
    public void setIdle(boolean on) {
        idle = on;
        if (!on) lastIdleBackup = 0;
        Engine x = engine;
        if (x != null) x.setIdle(on);
    }

    /**
     * Shared clipboard: newly copied text goes to every online trusted device, without rows. Android
     * lets an app read the clipboard only while it is in front, so on the phone this works while
     * MeshDrop is open (the clipboard tile and notification button work any time).
     */
    private void clipTick() {
        Engine x = engine;
        if (x == null || stopped) return;
        String text;
        try {
            text = platform.readClipboard();
        } catch (RuntimeException e) {
            return;
        }
        List<String> uris = platform.clipboardUris();
        // An empty clipboard is a state too: the first look records it, so the next copy counts as new.
        String sig = !uris.isEmpty() ? "u:" + String.join("\n", uris) : text == null ? "" : text;
        boolean first = lastClip == null;
        if (sig.equals(lastClip)) return;
        lastClip = sig;
        if (first || !settings.get().clipboardSync || sig.isEmpty()) return;
        List<String> ids = new ArrayList<>();
        for (EngineDevice d : x.devices()) if (d.trusted && !d.reach.equals("offline") && !d.role.equals("localsend")) ids.add(d.deviceId);
        if (ids.isEmpty()) return;
        if (!uris.isEmpty()) {
            // A copied image or files (content URIs): sent as files the other side puts on its clipboard.
            try {
                List<SendItem> items = new ArrayList<>();
                for (String u : uris) items.add(platform.item("file", u));
                x.sendClipboardFiles(ids, items, null);
            } catch (IOException | RuntimeException ignored) {
                // a URI that cannot be read (its grant ended): nothing to send
            }
            return;
        }
        if (text.trim().isEmpty() || text.getBytes(StandardCharsets.UTF_8).length > 64 * 1024) return;
        x.sendClipboard(ids, text, null);
    }

    // ---- photo backup (M8b) --------------------------------------------------------------------

    /** Starts a backup pass now (the app also does every minute). */
    public void backupNow() {
        backupSoon();
    }

    /** Starts a backup pass on its own thread (a pass may wait for a whole batch to send). */
    private void backupSoon() {
        if (settings.get().backupTarget.isEmpty() || !backupBusy.compareAndSet(false, true)) return;
        Thread t = new Thread(() -> {
            try {
                while (backupPass()) {
                    // more waiting: next batch right away
                }
            } catch (RuntimeException ignored) {
                // next tick
            } finally {
                backupBusy.set(false);
            }
        }, "meshdrop-backup");
        t.setDaemon(true);
        t.start();
    }

    /**
     * One batch: new camera photos and videos go to the backup PC, only while it is on this Wi-Fi.
     * Once the send has a session (done, or kept in the outbox to finish by itself) they count as
     * handed over, so nothing is sent twice. Returns whether there may be more.
     */
    private boolean backupPass() {
        Settings s = settings.get();
        Engine x = engine;
        if (x == null || stopped || s.backupTarget.isEmpty()) return false;
        if (!platform.mediaPermission()) {
            backupError = "MeshDrop needs permission to read your photos and videos.";
            changed();
            return false;
        }
        EngineDevice pc = null;
        for (EngineDevice d : x.devices()) if (d.deviceId.equals(s.backupTarget)) pc = d;
        if (pc == null || !pc.trusted || !"lan".equals(pc.reach)) return false;
        List<Platform.Media> batch = platform.cameraMediaAfter(s.backupSince, 50);
        if (batch.isEmpty()) return false;
        List<SendItem> items = new ArrayList<>();
        try {
            for (Platform.Media m : batch) items.add(platform.item("file", m.uri));
            List<SendResult> rs = x.send(Collections.singletonList(s.backupTarget), items, "backup:" + UUID.randomUUID(), true).get(6, TimeUnit.HOURS);
            SendResult r = rs.isEmpty() ? null : rs.get(0);
            if (r == null || r.sessionId == null || r.sessionId.isEmpty()) {
                backupError = r == null || r.error == null ? "The backup could not start." : r.error;
                changed();
                return false;
            }
            Map<String, Object> patch = new LinkedHashMap<>();
            patch.put("backupSince", batch.get(batch.size() - 1).id);
            settings.set(patch);
            backupCount += batch.size();
            backupLastAt = System.currentTimeMillis();
            backupError = null;
            changed();
            return "done".equals(r.status) && batch.size() == 50;
        } catch (Exception e) {
            backupError = e.getMessage();
            changed();
            return false;
        }
    }

    /** Turns photo backup on (to `target`; existing photos too, or only new ones) or off (""). */
    public void backupSet(String target, boolean includeExisting) throws IOException {
        Map<String, Object> patch = new LinkedHashMap<>();
        String id = target == null || target.isEmpty() ? "" : e().resolveDeviceId(target);
        patch.put("backupTarget", id);
        if (!id.isEmpty()) patch.put("backupSince", includeExisting ? 0L : platform.cameraMediaMaxId());
        settings.set(patch);
        backupError = null;
        changed();
        if (!id.isEmpty()) backupSoon();
    }

    private Map<String, Object> backupView() {
        Settings s = settings.get();
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("target", s.backupTarget);
        m.put("permission", platform.mediaPermission());
        m.put("running", backupBusy.get());
        m.put("count", backupCount);
        if (backupLastAt > 0) m.put("lastAt", backupLastAt);
        if (backupError != null) m.put("error", backupError);
        return m;
    }

    public void sendClipboard(Object targets) throws IOException {
        List<String> uris = platform.clipboardUris();
        if (!uris.isEmpty()) {
            List<String> ids = targets(targets);
            String tag = UUID.randomUUID().toString();
            List<SendItem> items = new ArrayList<>();
            for (String u : uris) items.add(platform.item("file", u));
            List<Row> rs = startRows(ids, tag, items.size(), 0);
            e().sendClipboardFiles(ids, items, tag).whenComplete((r, x) -> {
                if (x != null) failRows(rs, x);
            });
            return;
        }
        String text = platform.readClipboard();
        if (text == null || text.isEmpty()) throw new IllegalArgumentException("The clipboard is empty.");
        List<String> ids = targets(targets);
        String tag = UUID.randomUUID().toString();
        List<Row> rs = startRows(ids, tag, 0, text.getBytes(StandardCharsets.UTF_8).length);
        e().sendClipboard(ids, text, tag).whenComplete((r, x) -> {
            if (x != null) failRows(rs, x);
        });
    }

    public void resumeOutbox() {
        e().resumePending().whenComplete((r, x) -> refreshOutbox());
    }

    public void removeOutbox(String sessionId) throws IOException {
        e().removeOutbox(sessionId);
        refreshOutbox();
    }

    public void addByAddress(String host, int port, String alias) throws IOException {
        addByAddress(host, port, alias, null);
    }

    public Map<String, Object> pairProbe(String host, int port) throws IOException {
        if (host == null || host.trim().isEmpty()) throw new IllegalArgumentException("Enter an address.");
        Engine.PairProbe p = e().pairProbe(host.trim(), port);
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("deviceId", p.deviceId);
        m.put("alias", p.alias);
        m.put("code", p.code);
        return m;
    }

    /** {@code expectDeviceId}: the device whose pairing code the user checked (null: none). */
    public void addByAddress(String host, int port, String alias, String expectDeviceId) throws IOException {
        if (host == null || host.trim().isEmpty()) throw new IllegalArgumentException("Enter an address.");
        String a = alias == null || alias.trim().isEmpty() ? host.trim() : alias;
        e().pairManual(host.trim(), port, a, expectDeviceId);
        changed();
    }

    public int scanSubnet() throws InterruptedException {
        int n = e().scanSubnet(null, null, 400, 32);
        changed();
        return n;
    }

    public boolean receiving() {
        return !paused && error == null;
    }

    /** Pause receiving: offers are refused (senders keep them to resume); everything else keeps running. */
    public void setReceiving(boolean on) {
        paused = !on;
        Engine x = engine;
        if (x != null) x.setReceiving(on && error == null);
        changed();
    }

    private static boolean portFree(int port) {
        try (ServerSocket s = new ServerSocket(port)) {
            return true;
        } catch (IOException e) {
            return false;
        }
    }

    public synchronized Map<String, Object> setSettings(Map<String, Object> patch) throws IOException {
        Settings prev = settings.get();
        Settings next = settings.preview(patch);
        boolean restart = !next.alias.equals(prev.alias) || next.port != prev.port || next.discovery != prev.discovery || next.bluetooth != prev.bluetooth;
        Engine x = engine;
        if (restart && next.port != prev.port && next.port != 0 && (x == null || next.port != x.port()) && !portFree(next.port)) {
            throw new SettingsStore.SettingsError("Port " + next.port + " is in use by another program.");
        }
        boolean hadError = error != null;
        settings.set(patch);
        Engine live = engine;
        if (live != null) live.setLinkPolicy(linkPolicy(settings.get()));
        if (restart) {
            Exception failure = null;
            try {
                restart();
                if (!hadError && error != null) failure = new SettingsStore.SettingsError("Port " + next.port + " is in use by another program.");
            } catch (IOException | RuntimeException e) {
                failure = e;
            }
            if (failure != null) {
                settings.restore(prev);
                restart();
                if (failure instanceof IOException) throw (IOException) failure;
                throw (RuntimeException) failure;
            }
        }
        changed();
        return settings.get().toMap();
    }

    /** M14: the engine's link policy from the No Wi-Fi settings. */
    public static io.github.hafijbge.meshdrop.engine.bt.LinkPolicy linkPolicy(Settings s) {
        return new io.github.hafijbge.meshdrop.engine.bt.LinkPolicy(s.bluetooth, s.allBluetooth, s.deviceLinks);
    }

    public void openInbox() {
        platform.openInbox();
    }

    public void reveal(String ref) {
        platform.reveal(ref);
    }

    // ---- M11: receipts, burn after reading, send later, voice notes ---------------------------

    static final long BURN_AFTER_OPEN_MS = 5 * 60_000L;
    static final long BURN_UNOPENED_MS = 7 * 86_400_000L;

    /** Opens a received file: the first open sends a read receipt and starts the burn clock. */
    public void openReceived(String ref) {
        try {
            for (Map<String, Object> r : history.opened(ref, System.currentTimeMillis(), BURN_AFTER_OPEN_MS)) {
                Object from = r.get("from");
                Object sid = r.get("sessionId");
                if (settings.get().sendReceipts && from instanceof String && ((String) from).matches("^[0-9a-f]{64}$") && sid instanceof String) {
                    Map<String, Object> m = new LinkedHashMap<>();
                    m.put("kind", "opened");
                    m.put("sessionId", sid);
                    workers.execute(() -> {
                        try {
                            e().appSend((String) from, m, 10_000);
                        } catch (Exception ignored) {
                            // the sender is away: no receipt
                        }
                    });
                }
            }
        } catch (IOException ignored) {
            // the history could not be written: the file still opens
        }
        platform.reveal(ref);
        changed();
    }

    /** Deletes burned files whose time came; sends scheduled sends whose time came. */
    void m11Tick() {
        long now = System.currentTimeMillis();
        try {
            List<String> gone = history.burnDue(now, BURN_UNOPENED_MS);
            for (String f : gone) platform.deleteReceived(f);
            if (!gone.isEmpty()) changed();
        } catch (IOException ignored) {
            // retried next tick
        }
        List<Map<String, Object>> due = new ArrayList<>();
        synchronized (scheduled) {
            for (Map<String, Object> j : new ArrayList<>(scheduled)) {
                if (j.get("at") instanceof Long && (Long) j.get("at") <= now) {
                    scheduled.remove(j);
                    due.add(j);
                }
            }
            if (!due.isEmpty()) saveScheduled();
        }
        for (Map<String, Object> j : due) {
            try {
                Map<String, Object> opts = new LinkedHashMap<>();
                if (Boolean.TRUE.equals(j.get("burn"))) opts.put("burn", true);
                if (Boolean.TRUE.equals(j.get("print"))) opts.put("print", true);
                send(j.get("targets"), asItems(j.get("items")), opts);
            } catch (Exception x) {
                if (settings.get().notifications) platform.notify("Scheduled send failed", String.valueOf(x.getMessage()), null);
            }
            changed();
        }
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> asItems(Object o) {
        List<Map<String, Object>> out = new ArrayList<>();
        if (o instanceof List) for (Object x : (List<Object>) o) if (x instanceof Map) out.add((Map<String, Object>) x);
        return out;
    }

    private final List<Map<String, Object>> scheduled = new ArrayList<>();
    private boolean scheduledLoaded;

    private File scheduledFile() {
        return new File(history.dir(), "scheduled.json");
    }

    @SuppressWarnings("unchecked")
    private void loadScheduled() {
        synchronized (scheduled) {
            if (scheduledLoaded) return;
            scheduledLoaded = true;
            try {
                Object j = Json.parse(new String(java.nio.file.Files.readAllBytes(scheduledFile().toPath()), StandardCharsets.UTF_8));
                if (j instanceof List) for (Object x : (List<Object>) j) if (x instanceof Map) scheduled.add((Map<String, Object>) x);
            } catch (IOException | RuntimeException ignored) {
                // none
            }
        }
    }

    private void saveScheduled() {
        try {
            io.github.hafijbge.meshdrop.engine.util.Atomic.write(scheduledFile(), Json.stringify(scheduled).getBytes(StandardCharsets.UTF_8));
        } catch (IOException ignored) {
            // kept in memory
        }
    }

    private List<Object> scheduledView() {
        List<Object> out = new ArrayList<>();
        synchronized (scheduled) {
            for (Map<String, Object> j : scheduled) {
                Map<String, Object> v = new LinkedHashMap<>(j);
                v.remove("items");
                out.add(v);
            }
        }
        return out;
    }

    /** Voice notes: recorded bytes saved as a file to send (in this app's cache). */
    private String saveBlob(String name, String b64) throws IOException {
        String n = name.replaceAll("[^A-Za-z0-9._ -]", "_");
        if (!n.matches("^[A-Za-z0-9][A-Za-z0-9._ -]{0,99}$")) throw new IllegalArgumentException("invalid name");
        File dir = new File(history.dir(), "voice-notes");
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("cannot save the voice note");
        File f = new File(dir, n);
        java.nio.file.Files.write(f.toPath(), java.util.Base64.getDecoder().decode(b64));
        return f.getPath();
    }

    // ---- the DesktopApi dispatch (used by the Android bridge) ------------------------------------

    @SuppressWarnings("unchecked")
    private static Map<String, Object> obj(Object o) {
        if (!(o instanceof Map)) throw new IllegalArgumentException("invalid argument");
        return (Map<String, Object>) o;
    }

    private static String str(Object o) {
        if (!(o instanceof String)) throw new IllegalArgumentException("invalid argument");
        return (String) o;
    }

    // ---- M10: app messages ------------------------------------------------------------------

    /** What this phone answers to app messages from trusted devices. */
    public io.github.hafijbge.meshdrop.engine.recv.MeshServer.Reply onApp(String peer, Object raw) {
        Map<String, Object> msg = raw instanceof Map ? obj(raw) : new LinkedHashMap<>();
        Object kind = msg.get("kind");
        Map<String, Object> body = new LinkedHashMap<>();
        int status = 200;
        if ("ring".equals(kind)) {
            ring(!Boolean.FALSE.equals(msg.get("on")));
            body.put("ok", true);
        } else if ("status".equals(kind)) {
            body.putAll(platform.status());
        } else if ("reply".equals(kind)) {
            String key = msg.get("key") instanceof String ? (String) msg.get("key") : "";
            String text = msg.get("text") instanceof String ? (String) msg.get("text") : "";
            if (key.isEmpty() || text.isEmpty() || text.length() > 4000) {
                status = 400;
                body.put("error", "bad-reply");
            } else if (platform.replyNotification(key, text)) {
                body.put("ok", true);
            } else {
                status = 404;
                body.put("error", "gone");
            }
        } else if ("open-url".equals(kind) || "handoff".equals(kind)) {
            String url = msg.get("url") instanceof String ? (String) msg.get("url") : "";
            if (!settings.get().openLinks) {
                status = 403;
                body.put("error", "handoff-off");
            } else if (!url.matches("^(?i)https?://\\S{1,4000}$")) {
                status = 400;
                body.put("error", "bad-url");
            } else {
                platform.openUrl(url);
                body.put("ok", true);
            }
        } else if ("opened".equals(kind)) {
            boolean any = false;
            synchronized (rows) {
                for (Row r : rows.values()) {
                    if ("out".equals(r.direction) && peer.equals(r.deviceId) && r.sessionId != null && r.sessionId.equals(msg.get("sessionId")) && r.openedAt == 0) {
                        r.openedAt = System.currentTimeMillis();
                        any = true;
                    }
                }
            }
            if (any) {
                if (settings.get().notifications) platform.notify("Opened", aliasOf(peer) + " opened what you sent.", null);
                changed();
            }
            body.put("ok", true);
        } else if ("hotspot".equals(kind)) {
            // M14: a Bluetooth-linked device shares its hotspot. Android asks before joining any network,
            // so this is offered (Settings → No Wi-Fi), not joined right away.
            Object ssid = msg.get("ssid");
            Object psk = msg.get("psk");
            if (!validHotspot(ssid, psk)) {
                status = 400;
                body.put("error", "bad-hotspot");
            } else {
                List<Object> hosts = new ArrayList<>();
                if (msg.get("hosts") instanceof List) {
                    for (Object h : (List<?>) msg.get("hosts")) {
                        if (hosts.size() < 4 && h instanceof String && ((String) h).matches("^\\d{1,3}(\\.\\d{1,3}){3}:\\d{1,5}$")) hosts.add(h);
                    }
                }
                Map<String, Object> o = new LinkedHashMap<>();
                o.put("from", peer);
                String who = aliasOf(peer);
                if (who != null && !who.isEmpty()) o.put("alias", who);
                o.put("ssid", ssid);
                o.put("psk", psk);
                o.put("hosts", hosts);
                hotspotOffer = o;
                changed();
                if (settings.get().notifications) platform.notify((who == null || who.isEmpty() ? "A device" : who) + " shares a hotspot", "Settings → No Wi-Fi: join " + ssid + ".", null);
                body.put("ok", true);
            }
        } else if ("input".equals(kind) || "action".equals(kind) || "apps".equals(kind)) {
            status = 403;
            body.put("error", "remote-off"); // a phone is the remote, not the controlled device
        } else {
            status = 404;
            body.put("error", "unknown-kind");
        }
        return new io.github.hafijbge.meshdrop.engine.recv.MeshServer.Reply(status, Json.stringify(body).getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }

    // ---- M14: hotspots ----------------------------------------------------------------------

    /** A hotspot's SSID and password: SSID is 1–32 bytes, a WPA2 password 8–63 printable ASCII. */
    static boolean validHotspot(Object ssid, Object psk) {
        if (!(ssid instanceof String) || !(psk instanceof String)) return false;
        String s = (String) ssid;
        int bytes = s.getBytes(java.nio.charset.StandardCharsets.UTF_8).length;
        return bytes > 0 && bytes <= 32 && s.indexOf('\0') < 0 && s.indexOf('\n') < 0 && s.indexOf('\r') < 0
                && ((String) psk).matches("^[\\x20-\\x7e]{8,63}$");
    }

    /** The text of a Wi-Fi QR code (`WIFI:T:WPA;S:…;P:…;;`), which phone cameras offer to join. */
    static String wifiQr(String ssid, String psk) {
        return "WIFI:T:WPA;S:" + ssid.replaceAll("([\\\\;,:\"])", "\\\\$1") + ";P:" + psk.replaceAll("([\\\\;,:\"])", "\\\\$1") + ";;";
    }

    /** Starts a hotspot here and shares it with the devices linked over Bluetooth. */
    private void hotspotStart() throws IOException {
        Engine x = e();
        Map<String, Object> h = platform.hotspotHost();
        String ssid = String.valueOf(h.get("ssid"));
        String psk = String.valueOf(h.get("psk"));
        Map<String, Object> hs = new LinkedHashMap<>();
        hs.put("role", "host");
        hs.put("ssid", ssid);
        hs.put("psk", psk);
        hs.put("qrSvg", io.github.hafijbge.meshdrop.engine.guest.GuestPage.qrSvg(wifiQr(ssid, psk)));
        hotspot = hs;
        hotspotOffer = null;
        changed();
        List<Object> hosts = new ArrayList<>();
        if (h.get("ips") instanceof List) {
            for (Object ip : (List<?>) h.get("ips")) if (hosts.size() < 4) hosts.add(ip + ":" + x.port());
        }
        Map<String, Object> msg = new LinkedHashMap<>();
        msg.put("kind", "hotspot");
        msg.put("ssid", ssid);
        msg.put("psk", psk);
        msg.put("hosts", hosts);
        for (String to : x.btLinked()) {
            workers.execute(() -> {
                try {
                    x.appSend(to, msg, 10_000);
                } catch (IOException | RuntimeException ignored) {
                    // the QR and the password on screen still work
                }
            });
        }
    }

    /** Joins a hotspot (Android shows its own "connect to this network?" first), then looks for devices on it. */
    private void hotspotJoin(String ssid, String psk, List<String> hosts) throws IOException {
        if (!validHotspot(ssid, psk)) throw new IllegalArgumentException("Enter the hotspot name and its password (8 to 63 characters).");
        Map<String, Object> offer = hotspotOffer;
        if (offer != null && !ssid.equals(offer.get("ssid"))) offer = null;
        if (offer != null) {
            offer.put("joining", true);
            offer.remove("error");
            changed();
        }
        try {
            platform.hotspotJoin(ssid, psk);
        } catch (IOException | RuntimeException x) {
            if (offer != null) {
                offer.put("joining", false);
                offer.put("error", x.getMessage() == null ? "Could not join." : x.getMessage());
            }
            changed();
            throw x;
        }
        List<String> tryHosts = new ArrayList<>(hosts);
        if (tryHosts.isEmpty() && offer != null) for (Object h : (List<?>) offer.get("hosts")) tryHosts.add(String.valueOf(h));
        hotspotOffer = null;
        Map<String, Object> hs = new LinkedHashMap<>();
        hs.put("role", "joined");
        hs.put("ssid", ssid);
        hotspot = hs;
        changed();
        // multicast may be isolated on a hotspot: try the addresses it sent as well
        Engine x = e();
        for (String h : tryHosts) {
            int i = h.lastIndexOf(':');
            if (i <= 0) continue;
            workers.execute(() -> {
                try {
                    x.addNearby(h.substring(0, i), Integer.parseInt(h.substring(i + 1)));
                } catch (IOException | RuntimeException ignored) {
                    // found by multicast, or not there
                }
            });
        }
    }

    private void hotspotStop() {
        boolean had = hotspot != null;
        hotspot = null;
        hotspotOffer = null;
        changed();
        if (had) platform.hotspotStop();
    }

    // ---- M10b: live sound / camera / microphone --------------------------------------------

    /** kind ("audio" | "camera" | "mic") -> the device it plays from or sends to. */
    private final Map<String, String> castTo = new java.util.concurrent.ConcurrentHashMap<>();
    private final Map<String, io.github.hafijbge.meshdrop.engine.Engine.Stream> casts = new java.util.concurrent.ConcurrentHashMap<>();

    /** The camera a running webcam uses (true: the back one). */
    private volatile boolean cameraBack;

    private void streamStart(String deviceId, String kind, boolean back) throws IOException {
        if (!kind.equals("audio") && !kind.equals("camera") && !kind.equals("mic") && !kind.equals("sound")) throw new IllegalArgumentException("unknown stream");
        streamStop(kind);
        platform.mediaStarting(kind);
        io.github.hafijbge.meshdrop.engine.Engine.Stream s;
        // M14: over a Bluetooth link sound goes as Opus (raw PCM needs 1.5 Mbit/s); the camera is refused there
        int ch = kind.equals("mic") ? 1 : 2;
        io.github.hafijbge.meshdrop.engine.bt.OpusRtp.Codec codec = null;
        try {
            if (!kind.equals("camera") && e().viaBluetooth(deviceId)) {
                codec = kind.equals("audio") ? platform.opusDecoder(ch) : platform.opusEncoder(ch, io.github.hafijbge.meshdrop.engine.bt.OpusRtp.bitrate(ch));
            }
            String pcm = "audio/L16; rate=48000; channels=" + ch;
            String type = codec != null ? io.github.hafijbge.meshdrop.engine.bt.OpusRtp.contentType(ch) : pcm;
            s = kind.equals("audio") ? e().streamFrom(deviceId, codec != null ? "audio?codec=opus" : "audio")
                    : e().streamTo(deviceId, kind, kind.equals("camera") ? "multipart/x-mixed-replace" : type);
        } catch (IOException | RuntimeException x) {
            java.util.logging.Logger.getLogger("MeshDropBt").info("stream " + kind + " start failed (bt=" + (codec != null) + "): " + x);
            if (codec != null) codec.close();
            platform.mediaStopped(kind);
            throw x;
        }
        final io.github.hafijbge.meshdrop.engine.bt.OpusRtp.Codec opus = codec;
        final java.io.InputStream sin = opus != null && s.in != null && kind.equals("audio") ? io.github.hafijbge.meshdrop.engine.bt.OpusRtp.decoding(s.in, opus) : s.in;
        final java.io.OutputStream sout = opus != null && s.out != null ? io.github.hafijbge.meshdrop.engine.bt.OpusRtp.encoding(s.out, opus, ch) : s.out;
        casts.put(kind, s);
        castTo.put(kind, deviceId);
        if (kind.equals("camera")) cameraBack = back;
        changed();
        Thread t = new Thread(() -> {
            java.util.function.BooleanSupplier stop = () -> casts.get(kind) != s;
            try {
                if (kind.equals("audio")) platform.playAudio(sin, stop, opus != null);
                else if (kind.equals("camera")) CameraRetry.keep(sout, stop, o -> platform.captureCamera(o, stop, back), 30_000, 1_000);
                else if (kind.equals("sound")) platform.captureSound(sout, stop);
                else platform.captureMic(sout, stop);
            } catch (IOException | RuntimeException x) {
                // the PC went away or the stream was stopped
                java.util.logging.Logger.getLogger("MeshDropBt").info("stream " + kind + " ended: " + x);
            } finally {
                try {
                    if (sout != null) sout.close();
                } catch (IOException | RuntimeException ignored) {
                    // closing anyway
                }
                if (opus != null) opus.close();
                s.close();
                if (casts.remove(kind, s)) castTo.remove(kind);
                platform.mediaStopped(kind);
                changed();
            }
        }, "cast-" + kind);
        t.setDaemon(true);
        t.start();
    }

    private void streamStop(String kind) {
        io.github.hafijbge.meshdrop.engine.Engine.Stream s = casts.remove(kind);
        castTo.remove(kind);
        if (s != null) s.close();
        changed();
    }

    private java.util.concurrent.ScheduledFuture<?> ringTimer;

    private synchronized void ring(boolean on) {
        if (ringTimer != null) ringTimer.cancel(false);
        ringTimer = null;
        ringing = on;
        platform.ring(on);
        if (on) ringTimer = RING_TIMER.schedule(() -> ring(false), 60, TimeUnit.SECONDS);
        changed();
    }

    private static final java.util.concurrent.ExecutorService workers = java.util.concurrent.Executors.newCachedThreadPool(r -> {
        Thread t = new Thread(r, "app-messages");
        t.setDaemon(true);
        return t;
    });

    private static final java.util.concurrent.ScheduledExecutorService RING_TIMER = java.util.concurrent.Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "ring-timer");
        t.setDaemon(true);
        return t;
    });

    /** Forwards a notification posted on this phone to the devices picked in Settings (notifyTo). */
    public void forwardNotification(Map<String, Object> note) {
        for (String to : settings.get().notifyTo) {
            Map<String, Object> m = new LinkedHashMap<>(note);
            m.put("kind", "notify");
            workers.execute(() -> {
                try {
                    e().appSend(to, m, 10_000);
                } catch (Exception ignored) {
                    // that PC is away: the notification is not kept for later
                }
            });
        }
    }

    public void forwardNotificationRemoved(String key) {
        for (String to : settings.get().notifyTo) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("kind", "notify-removed");
            m.put("key", key);
            workers.execute(() -> {
                try {
                    e().appSend(to, m, 10_000);
                } catch (Exception ignored) {
                    // away
                }
            });
        }
    }

    /**
     * M11 shake to grab: puts what is copied on a PC (the first reachable one) on this phone's clipboard;
     * returns what happened, for a short message.
     */
    @SuppressWarnings("unchecked")
    public String grabClipboard() {
        String pc = null;
        for (io.github.hafijbge.meshdrop.engine.EngineDevice d : e().devices()) {
            if (d.trusted && !"offline".equals(d.reach) && !"mobile".equals(d.deviceType) && !"localsend".equals(d.role)) {
                pc = d.deviceId;
                break;
            }
        }
        if (pc == null) return "No PC is reachable.";
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("kind", "clipboard-get");
        try {
            Map<String, Object> r = e().appSend(pc, m, 10_000);
            if (!Long.valueOf(200).equals(r.get("status")) || !(r.get("body") instanceof Map)) {
                return Long.valueOf(403).equals(r.get("status")) ? "Turn on the shared clipboard on " + aliasOf(pc) + " (or allow this phone on its Remote page)." : "Could not get the PC's clipboard.";
            }
            Map<String, Object> b = (Map<String, Object>) r.get("body");
            if (b.get("image") instanceof String) {
                File dir = new File(history.dir(), "grabbed");
                if (!dir.isDirectory() && !dir.mkdirs()) return "Could not save the image.";
                File f = new File(dir, "Clipboard " + System.currentTimeMillis() + ".png");
                java.nio.file.Files.write(f.toPath(), java.util.Base64.getDecoder().decode((String) b.get("image")));
                platform.writeClipboardFiles(java.util.Collections.singletonList(f.getPath()));
                lastClip = "u:" + String.join("\n", platform.clipboardUris());
                return "Copied the image from " + aliasOf(pc) + ".";
            }
            String text = b.get("text") instanceof String ? (String) b.get("text") : "";
            if (text.isEmpty()) return aliasOf(pc) + " has nothing copied.";
            lastClip = text; // shared clipboard: not sent straight back
            platform.writeClipboard(text);
            return "Copied from " + aliasOf(pc) + ".";
        } catch (IOException | RuntimeException x) {
            return "Could not reach " + aliasOf(pc) + ".";
        }
    }

    // ---- M13 handoff ------------------------------------------------------------------------

    /** Opens here the page the PC's browser shows, at the same spot; its title, or null when nothing is open. */
    @SuppressWarnings("unchecked")
    private String handoffPull() throws IOException {
        String pc = watchPc();
        if (pc == null) throw new IOException("No PC is reachable now.");
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("kind", "handoff-get");
        Map<String, Object> r = e().appSend(pc, m, 10_000);
        if (!Long.valueOf(200).equals(r.get("status")) || !(r.get("body") instanceof Map)) return null;
        Map<String, Object> b = (Map<String, Object>) r.get("body");
        if (!(b.get("url") instanceof String) || !((String) b.get("url")).matches("^https?://\\S+$")) return null;
        platform.openUrl((String) b.get("url"));
        return b.get("title") instanceof String ? (String) b.get("title") : (String) b.get("url");
    }

    /** Share → Continue on PC: the page (and a video's second) opens on the PC; the PC's name, for a toast. */
    public String handoffPush(String url, long timeSec) throws IOException {
        String pc = watchPc();
        if (pc == null) throw new IOException("No PC is reachable now.");
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("kind", "handoff-open");
        m.put("url", url);
        if (timeSec > 0) m.put("time", timeSec);
        Map<String, Object> r = e().appSend(pc, m, 10_000);
        if (Long.valueOf(403).equals(r.get("status"))) throw new IOException("Opening links is turned off on " + aliasOf(pc) + " (its Settings).");
        if (!Long.valueOf(200).equals(r.get("status"))) throw new IOException(aliasOf(pc) + " could not open it.");
        return aliasOf(pc);
    }

    // ---- M12 watch party: rooms live on a PC (the hub first); the phone opens them in its browser ----

    /** Rooms this phone made (on a PC), with their host keys. */
    private final List<Map<String, Object>> watchRooms = new ArrayList<>();

    /** The PC that hosts rooms for this phone: the mesh hub if it is reachable, else a PC on this network. */
    private String watchPc() {
        MembershipStore mesh = e().mesh();
        String hub = mesh == null ? null : mesh.list().hubId;
        String any = null;
        for (io.github.hafijbge.meshdrop.engine.EngineDevice d : e().devices()) {
            if (!d.trusted || "offline".equals(d.reach) || "mobile".equals(d.deviceType) || "localsend".equals(d.role)) continue;
            if (d.deviceId.equals(hub)) return d.deviceId;
            if (any == null) any = d.deviceId;
        }
        return any;
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> watchCreate(String name) throws IOException {
        String pc = watchPc();
        if (pc == null) throw new IOException("Watch parties run on your MeshDrop PC: none is reachable now.");
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("kind", "watch-create");
        m.put("name", name);
        Map<String, Object> r = e().appSend(pc, m, 15_000);
        if (!Long.valueOf(200).equals(r.get("status")) || !(r.get("body") instanceof Map)) throw new IOException("The PC could not open a room.");
        Map<String, Object> b = new LinkedHashMap<>((Map<String, Object>) r.get("body"));
        Map<String, Object> keep = new LinkedHashMap<>();
        keep.put("code", b.get("code"));
        keep.put("name", name);
        keep.put("links", b.get("links"));
        keep.put("hostToken", b.get("hostToken"));
        keep.put("pc", pc);
        synchronized (watchRooms) {
            watchRooms.add(keep);
        }
        b.put("qrSvg", b.get("links") instanceof List && !((List<Object>) b.get("links")).isEmpty() ? io.github.hafijbge.meshdrop.engine.guest.GuestPage.qrSvg(String.valueOf(((List<Object>) b.get("links")).get(0))) : "");
        changed();
        return b;
    }

    /** The link for a room code: rooms made here, the hub's internet address, then MeshDrop PCs on this network. */
    @SuppressWarnings("unchecked")
    private String watchResolve(String raw) {
        String code = raw.trim().toUpperCase(java.util.Locale.ROOT);
        if (!code.matches("^[A-Z0-9]{6}$")) throw new IllegalArgumentException("A room code has 6 letters or digits.");
        synchronized (watchRooms) {
            for (Map<String, Object> w : watchRooms) {
                if (code.equals(w.get("code")) && w.get("links") instanceof List && !((List<Object>) w.get("links")).isEmpty()) return String.valueOf(((List<Object>) w.get("links")).get(0));
            }
        }
        List<String> bases = new ArrayList<>();
        MembershipStore mesh = e().mesh();
        if (mesh != null) {
            for (String u : mesh.list().urls) {
                try {
                    java.net.URI p = new java.net.URI(u);
                    bases.add(("wss".equals(p.getScheme()) ? "https://" : "http://") + p.getRawAuthority());
                } catch (java.net.URISyntaxException ignored) {
                    // skip
                }
            }
        }
        for (io.github.hafijbge.meshdrop.engine.EngineDevice d : e().devices()) {
            if ("lan".equals(d.reach) && d.host != null && !"mobile".equals(d.deviceType)) bases.add("http://" + (d.host.contains(":") ? "[" + d.host + "]" : d.host) + ":53320");
        }
        for (String b : bases) {
            try {
                java.net.HttpURLConnection c = (java.net.HttpURLConnection) new java.net.URL(b + "/w/api/" + code).openConnection();
                c.setConnectTimeout(4000);
                c.setReadTimeout(4000);
                int s = c.getResponseCode();
                c.disconnect();
                if (s == 200) return b + "/w/" + code;
            } catch (IOException | RuntimeException ignored) {
                // not there
            }
        }
        return null;
    }

    private List<Object> watchView() {
        List<Object> out = new ArrayList<>();
        synchronized (watchRooms) {
            for (Map<String, Object> w : watchRooms) {
                Map<String, Object> v = new LinkedHashMap<>(w);
                v.remove("pc");
                out.add(v);
            }
        }
        return out;
    }

    /** Fetches this device's links from its hub off the caller's thread, then redraws. */
    private void refreshLinks() {
        if (!linksRefreshing.compareAndSet(false, true)) return;
        memberLinksAt = System.currentTimeMillis();
        Thread t = new Thread(() -> {
            try {
                memberLinks = new ArrayList<Object>(e().linkList());
                changed();
            } catch (Exception ignored) {
                // hub away: kept as it was
            } finally {
                linksRefreshing.set(false);
            }
        }, "links-refresh");
        t.setDaemon(true);
        t.start();
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> linkCreate(Map<String, Object> in) throws IOException {
        List<io.github.hafijbge.meshdrop.engine.send.Source> sources = new ArrayList<>();
        if (in.get("files") instanceof List) {
            for (Object ref : (List<Object>) in.get("files")) {
                io.github.hafijbge.meshdrop.engine.send.SendItem it = platform.item("file", str(ref));
                if (it.source == null) throw new IllegalArgumentException("Only files can go in a link.");
                sources.add(it.source);
            }
        }
        double days = in.get("days") instanceof Number ? ((Number) in.get("days")).doubleValue() : 7;
        long ms = Math.round(days * 24 * 3_600_000L);
        String text = in.get("text") instanceof String ? (String) in.get("text") : null;
        if (sources.isEmpty() && (text == null || text.isEmpty())) throw new IllegalArgumentException("Choose files first.");
        String pw = in.get("password") instanceof String ? (String) in.get("password") : null;
        int max = in.get("maxDownloads") instanceof Number ? ((Number) in.get("maxDownloads")).intValue() : 0;
        io.github.hafijbge.meshdrop.engine.links.MemberLinks.Made made = e().linkCreate(sources, text, ms, pw, max);
        Map<String, Object> r = new LinkedHashMap<>();
        r.put("id", made.id);
        r.put("url", made.url);
        r.put("qrSvg", io.github.hafijbge.meshdrop.engine.guest.GuestPage.qrSvg(made.url));
        r.put("expiresAt", made.expiresAt);
        memberLinksAt = 0;
        refreshLinks();
        return r;
    }

    private static int integer(Object o) {
        if (!(o instanceof Long)) throw new IllegalArgumentException("invalid argument");
        return ((Long) o).intValue();
    }

    /**
     * Runs one DesktopApi method with JSON-decoded arguments and returns a JSON-able result.
     * Throws UnsupportedOperationException for methods the platform shell handles itself (pickers…).
     */
    @SuppressWarnings("unchecked")
    public Object call(String method, List<Object> args) throws Exception {
        Object a0 = args.size() > 0 ? args.get(0) : null;
        switch (method) {
            case "getState":
                return state();
            case "send": {
                List<Map<String, Object>> items = new ArrayList<>();
                for (Object it : (List<Object>) args.get(1)) items.add(obj(it));
                send(a0, items, args.size() > 2 && args.get(2) instanceof Map ? obj(args.get(2)) : new LinkedHashMap<>());
                return null;
            }
            case "scheduleCancel": {
                String id = str(a0);
                loadScheduled();
                synchronized (scheduled) {
                    scheduled.removeIf(j -> id.equals(j.get("id")));
                    saveScheduled();
                }
                changed();
                return null;
            }
            case "saveBlob":
                return saveBlob(str(a0), str(args.get(1)));
            case "sendClipboard":
                sendClipboard(a0);
                return null;
            case "resumeOutbox":
                resumeOutbox();
                return null;
            case "removeOutbox":
                removeOutbox(str(a0));
                return null;
            case "pairProbe":
                return pairProbe(str(a0), integer(args.get(1)));
            case "addByAddress":
                addByAddress(str(a0), integer(args.get(1)), str(args.get(2)), args.size() > 3 && args.get(3) != null ? str(args.get(3)) : null);
                return null;
            case "scanSubnet":
                return (long) scanSubnet();
            case "setSettings":
                return setSettings(obj(a0));
            case "openInbox":
                openInbox();
                return null;
            case "reveal":
            case "openFile":
                openReceived(str(a0));
                return null;
            case "unpair":
                e().unpair(str(a0));
                refreshOutbox();
                changed();
                return null;
            case "thumb":
                return platform.thumbnail(str(a0));
            case "join":
                return join(str(a0));
            case "syncPut": {
                List<String> ps = new ArrayList<>();
                for (Object p : (List<Object>) args.get(2)) ps.add(str(p));
                Object prev = args.size() > 3 ? args.get(3) : null;
                e().syncPut(str(a0), str(args.get(1)), ps, prev instanceof String ? (String) prev : null);
                changed();
                return null;
            }
            case "syncRemove":
                e().syncRemove(str(a0));
                changed();
                return null;
            case "backupSet":
                backupSet(str(a0), Boolean.TRUE.equals(args.size() > 1 ? args.get(1) : null));
                return null;
            case "syncNow":
                e().syncNow(a0 instanceof String ? (String) a0 : null);
                changed();
                return null;
            case "guestStart": {
                Map<String, Object> g = e().guestStart(settings.get().guestMinutes, 0);
                guestQr = (String) g.get("qrSvg");
                changed();
                return g;
            }
            case "handoffPull":
                return handoffPull();
            case "watchCreate":
                return watchCreate(str(a0));
            case "watchResolve":
                return watchResolve(str(a0));
            case "watchOpen": {
                String url = str(a0);
                if (!url.matches("^https?://[^\\s]+/w/[A-Za-z0-9]{6}(#h=[A-Za-z0-9_-]+)?$")) throw new IllegalArgumentException("Not a watch-party link.");
                platform.openUrl(url);
                return null;
            }
            case "watchEnd": {
                String code = str(a0);
                Map<String, Object> room = null;
                synchronized (watchRooms) {
                    for (Map<String, Object> w : watchRooms) if (code.equals(w.get("code"))) room = w;
                    watchRooms.remove(room);
                }
                if (room != null) {
                    Map<String, Object> m = new LinkedHashMap<>();
                    m.put("kind", "watch-end");
                    m.put("code", code);
                    try {
                        e().appSend((String) room.get("pc"), m, 10_000);
                    } catch (IOException ignored) {
                        // the PC ends idle rooms by itself
                    }
                }
                changed();
                return null;
            }
            case "linkCreate":
                return linkCreate(obj(a0));
            case "appSend": {
                String to = str(a0);
                Map<String, Object> r = e().appSend(to, obj(args.get(1)), 10_000);
                if ("status".equals(obj(args.get(1)).get("kind")) && Long.valueOf(200).equals(r.get("status")) && r.get("body") instanceof Map) {
                    Map<String, Object> st = new LinkedHashMap<>(obj(r.get("body")));
                    st.put("at", System.currentTimeMillis());
                    deviceStatus.put(to, st);
                    changed();
                }
                return r;
            }
            case "ringStop":
                ring(false);
                return null;
            case "streamStart":
                streamStart(str(a0), str(args.get(1)), args.size() > 2 && "back".equals(args.get(2)));
                return null;
            case "streamStop":
                streamStop(str(a0));
                return null;
            case "hotspotStart":
                hotspotStart(); // a local-only hotspot leaves no network: the "leave" flag is the PC's
                return null;
            case "hotspotJoin": {
                List<String> hosts = new ArrayList<>();
                if (args.size() > 2 && args.get(2) instanceof List) {
                    for (Object h : (List<?>) args.get(2)) if (hosts.size() < 4 && h instanceof String && ((String) h).length() <= 64) hosts.add((String) h);
                }
                hotspotJoin(str(a0), str(args.get(1)), hosts);
                return null;
            }
            case "hotspotStop":
                hotspotStop();
                return null;
            case "noteDismiss":
                return null;
            case "linkRevoke":
                e().linkRevoke(str(a0));
                memberLinksAt = 0;
                refreshLinks();
                return null;
            case "guestEnd":
                e().guestEnd();
                guestQr = null;
                changed();
                return null;
            case "guestShare": {
                List<io.github.hafijbge.meshdrop.engine.send.Source> sources = new ArrayList<>();
                for (Object ref : (List<Object>) a0) {
                    io.github.hafijbge.meshdrop.engine.send.SendItem it = platform.item("file", str(ref));
                    if (it.source == null) throw new IllegalArgumentException("Only files can be offered to a guest.");
                    sources.add(it.source);
                }
                e().guestShare(sources);
                changed();
                return null;
            }
            case "guestUnshare":
                e().guestUnshare(str(a0));
                changed();
                return null;
            case "guestAccept":
                e().guestAccept(str(a0));
                changed();
                return null;
            case "guestReject":
                e().guestReject(str(a0));
                changed();
                return null;
            case "hubInit":
            case "setHubUrls":
            case "createInvite":
            case "revoke":
            case "exportRecovery":
            case "importRecovery":
                throw new IllegalStateException(NO_MESH);
            case "registerClipboardShortcut":
            case "openConfigFolder":
                throw new IllegalStateException("This is not available on Android.");
            default:
                throw new UnsupportedOperationException(method);
        }
    }
}
