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
import io.github.hafijbge.meshdrop.engine.send.Source;
import io.github.hafijbge.meshdrop.engine.util.Json;
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
            m.put("startedAt", startedAt);
            return m;
        }

        void sum() {
            long n = 0;
            for (long v : done.values()) n += v;
            sent = bytes > 0 ? Math.min(n, bytes) : n;
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
    private ScheduledFuture<?> pending;
    private long lastEmit;
    private volatile boolean stopped;

    public AppController(SettingsStore settings, HistoryStore history, Platform platform, EngineFactory factory) {
        this.settings = settings;
        this.history = history;
        this.platform = platform;
        this.factory = factory;
    }

    public void addStateListener(StateListener l) {
        stateListeners.add(l);
    }

    public void removeStateListener(StateListener l) {
        stateListeners.remove(l);
    }

    // ---- lifecycle ------------------------------------------------------------------------------

    public synchronized void start() throws IOException {
        stopped = false;
        boot();
    }

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
        e.addListener(engineListener);
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

    // ---- state ----------------------------------------------------------------------------------

    public Map<String, Object> state() {
        Engine x = e();
        Settings s = settings.get();
        Map<String, Object> m = new LinkedHashMap<>();
        Map<String, Object> self = new LinkedHashMap<>();
        self.put("deviceId", x.identity().deviceId());
        self.put("alias", s.alias);
        self.put("port", (long) x.port());
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
            if (d.lastSeen > 0) dm.put("lastSeen", d.lastSeen);
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

    /** Schedules a state push: at most one per STATE_INTERVAL_MS, always carrying the latest state. */
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
            out.add(m);
        }
        outbox = out;
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
        } catch (RuntimeException ignored) {
            // never let a bookkeeping error break the engine thread
        }
        changed();
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
                if (d.get("error") != null) r.error = (String) d.get("error");
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
            received(from, (List<Object>) d.get("files"), (String) d.get("text"), Boolean.TRUE.equals(d.get("clipboard")));
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

    private void received(String from, List<Object> files, String text, boolean clipboard) {
        Settings s = settings.get();
        String alias = aliasOf(from);
        List<String> fs = new ArrayList<>();
        for (Object f : files) fs.add((String) f);
        try {
            history.addReceived(System.currentTimeMillis(), from, alias, fs, text, clipboard);
        } catch (IOException ignored) {
            // the files arrived; only the history entry is lost
        }
        // Clipboard text is only ever placed on the clipboard: never opened, run or interpreted.
        if (clipboard && text != null && s.clipboardReceive) platform.writeClipboard(text);
        if (!s.notifications) return;
        if (clipboard) {
            platform.notify("Clipboard", s.clipboardReceive ? "Copied text from " + alias : "Text from " + alias + " (see Inbox)", null);
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
        if (ids.isEmpty()) throw new IllegalArgumentException("No trusted device is online.");
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
        List<String> ids = targets(targets);
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
        e().send(ids, sendItems, tag).whenComplete((r, x) -> {
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

    public void sendClipboard(Object targets) {
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
        if (host == null || host.trim().isEmpty()) throw new IllegalArgumentException("Enter an address.");
        String a = alias == null || alias.trim().isEmpty() ? host.trim() : alias;
        e().pairManual(host.trim(), port, a);
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
        boolean restart = !next.alias.equals(prev.alias) || next.port != prev.port || next.discovery != prev.discovery;
        Engine x = engine;
        if (restart && next.port != prev.port && next.port != 0 && (x == null || next.port != x.port()) && !portFree(next.port)) {
            throw new SettingsStore.SettingsError("Port " + next.port + " is in use by another program.");
        }
        boolean hadError = error != null;
        settings.set(patch);
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

    public void openInbox() {
        platform.openInbox();
    }

    public void reveal(String ref) {
        platform.reveal(ref);
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
                send(a0, items);
                return null;
            }
            case "sendClipboard":
                sendClipboard(a0);
                return null;
            case "resumeOutbox":
                resumeOutbox();
                return null;
            case "removeOutbox":
                removeOutbox(str(a0));
                return null;
            case "addByAddress":
                addByAddress(str(a0), integer(args.get(1)), str(args.get(2)));
                return null;
            case "scanSubnet":
                return (long) scanSubnet();
            case "setSettings":
                return setSettings(obj(a0));
            case "openInbox":
                openInbox();
                return null;
            case "reveal":
                reveal(str(a0));
                return null;
            case "join":
                return join(str(a0));
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
